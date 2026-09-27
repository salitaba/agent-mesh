import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, eventTypes, goalOf } from "../helpers";
import { DeadlockDetector } from "../../packages/core/src/termination";
import type { MeshInstance } from "../../apps/mesh-server/src/index";

/**
 * The wait-cycle detector and the break that follows it (NOTES-live-run-20260925
 * §5).
 *
 * Measured 2026-09-25: 4 of 4 live detections were false positives. Each fired
 * within 50 ms of a turn ending, on asks 18–46 s old that their debtor had never
 * been shown: WAITING is the ordinary post-turn state, and an edge only asked
 * "is the asker parked on an open ask". The voiding was wrong on top of that —
 * one scan's findings were broken in sequence with no re-check, the victim was
 * the newest ask between ANY two members (not necessarily an edge of the ring),
 * a multi-addressee ask was voided whole (cancelling a question to a seat
 * outside the cycle), and nobody but the asker was ever told.
 */

async function park(m: MeshInstance, agentId: string): Promise<void> {
  for (const to of ["IDLE", "AWAKENED", "OBSERVING", "THINKING", "WAITING"]) {
    await m.kernel.emit("agent.state_changed", { agentId, to }, { actorId: agentId });
  }
}

/** The debtor took a turn that was shown the ask — what `message.delivered` records. */
async function handed(m: MeshInstance, debtor: string, messageId: string): Promise<void> {
  await m.kernel.emit("message.delivered", { agentId: debtor, messageId, turnId: `turn-test-${debtor}` }, { actorId: debtor });
}

async function ask(m: MeshInstance, from: string, to: string[], subject: string): Promise<string> {
  const sent = await m.supervisor.sendMessage({ from, to, type: "REQUEST", newThread: { subject }, payload: { q: subject } });
  assert.ok(sent.accepted && sent.messageId, `fixture: ${from}'s ask must be accepted (${sent.reason})`);
  // Distinct createdAt, so "newest" is a real ordering and not insertion luck.
  await new Promise((r) => setTimeout(r, 5));
  return sent.messageId!;
}

const cyclesOf = (m: MeshInstance) => new DeadlockDetector(m.config).scan(m.kernel.state).filter((f) => f.kind === "wait_cycle");

const breaks = async (m: MeshInstance) =>
  (await m.store.read()).filter((e) => e.type === "deadlock.auto_resolved").map((e) => (e.payload as { voidedRequestId: string }).voidedRequestId);

test("wait cycle: an ask its debtor has not been handed yet is not a wait-for edge", async () => {
  const m = await makeMesh({
    agents: [
      { id: "architect", role: "architect", interests: [] },
      { id: "dev", role: "developer", interests: [] },
    ],
    mayContact: { architect: ["dev"], dev: ["architect"] },
    mode: "parked",
  });
  try {
    const a = await ask(m, "architect", ["dev"], "which db?");
    const b = await ask(m, "dev", ["architect"], "which schema?");
    for (const id of ["architect", "dev"]) await park(m, id);

    // Both seats WAITING, both asks open — and neither debtor has had a turn
    // that saw the other's question. This is the shape of every live false
    // positive: each debtor still has the wake for its ask coming.
    assert.equal(cyclesOf(m).length, 0, "an ask still sitting unread in its debtor's mailbox cannot be what the debtor is refusing to answer");
    await m.supervisor.forceWatchdog();
    assert.deepEqual(await breaks(m), [], "no break on a ring that is not one");
    assert.ok(m.kernel.state.pendingRequests.has(a) && m.kernel.state.pendingRequests.has(b), "both asks survive");

    await handed(m, "dev", a);
    assert.equal(cyclesOf(m).length, 0, "one side having been shown its ask is still not a cycle");

    await handed(m, "architect", b);
    const found = cyclesOf(m);
    assert.equal(found.length, 1, "once both debtors took a turn over the ask and still owe it, the ring is real");
    assert.deepEqual([...found[0]!.participants].sort(), ["architect", "dev"]);
  } finally {
    await m.cleanup();
  }
});

test("wait cycle: one tick breaks a ring once, and does not break a second ring the first break already dissolved", async () => {
  // The live shape (seq 553/557): pm<->tech-lead and qa->tech-lead->pm->qa share
  // the edge tech-lead->pm. The 2-ring was broken by voiding that edge, which
  // dissolved the 3-ring too — and then the 3-ring was "broken" anyway by voiding
  // pm's ask to tech-lead, which was not even one of its edges.
  const m = await makeMesh({
    agents: [
      { id: "pm", role: "pm", interests: [] },
      { id: "qa", role: "qa", interests: [] },
      { id: "tl", role: "tech-lead", interests: [] },
    ],
    mayContact: { pm: ["qa", "tl"], qa: ["pm", "tl"], tl: ["pm", "qa"] },
    mode: "parked",
  });
  try {
    const m1 = await ask(m, "qa", ["tl"], "info on the facade");
    const m2 = await ask(m, "pm", ["tl", "qa"], "review requirements v2");
    const m3 = await ask(m, "pm", ["tl"], "confirm the scope ruling");
    const m4 = await ask(m, "tl", ["pm"], "which criteria are frozen?");
    await handed(m, "tl", m1);
    await handed(m, "tl", m2);
    await handed(m, "qa", m2);
    await handed(m, "tl", m3);
    await handed(m, "pm", m4);
    for (const id of ["pm", "qa", "tl"]) await park(m, id);

    await m.supervisor.forceWatchdog();

    assert.deepEqual(await breaks(m), [m4], "one break, on the edge both rings shared");
    for (const id of [m1, m2, m3]) {
      assert.ok(m.kernel.state.pendingRequests.has(id), `${id} was never part of a live ring after the first break and must survive`);
    }
    assert.equal(goalOf(m)?.status, "ACTIVE");
  } finally {
    await m.cleanup();
  }
});

test("wait cycle: the voided ask is an edge of the ring, not merely the newest ask between two members", async () => {
  const m = await makeMesh({
    agents: [
      { id: "a", role: "architect", interests: [] },
      { id: "b", role: "developer", interests: [] },
      { id: "c", role: "qa", interests: [] },
    ],
    mayContact: { a: ["b", "c"], b: ["c"], c: ["a"] },
    mode: "parked",
  });
  try {
    const ab = await ask(m, "a", ["b"], "a->b");
    const bc = await ask(m, "b", ["c"], "b->c");
    const ca = await ask(m, "c", ["a"], "c->a");
    // Newest of all, between two members, and NOT an edge: c has not been
    // shown it, so nothing says c is sitting on it.
    const ac = await ask(m, "a", ["c"], "a->c (unseen)");
    await handed(m, "b", ab);
    await handed(m, "c", bc);
    await handed(m, "a", ca);
    for (const id of ["a", "b", "c"]) await park(m, id);

    await m.supervisor.forceWatchdog();

    const voided = await breaks(m);
    assert.equal(voided.length, 1);
    assert.equal(voided[0], ca, "the newest EDGE of a->b->c->a is c's ask to a");
    assert.ok(m.kernel.state.pendingRequests.has(ac), "an ask outside the ring is not the ring's to void");
    assert.ok(m.kernel.state.pendingRequests.has(ab) && m.kernel.state.pendingRequests.has(bc));
  } finally {
    await m.cleanup();
  }
});

test("wait cycle: an ask that also owes a seat outside the ring is not voided whole", async () => {
  const m = await makeMesh({
    agents: [
      { id: "a", role: "architect", interests: [] },
      { id: "b", role: "developer", interests: [] },
      { id: "x", role: "ux-designer", interests: [] },
    ],
    mayContact: { a: ["b"], b: ["a", "x"], x: [] },
    mode: "parked",
  });
  try {
    const ab = await ask(m, "a", ["b"], "a->b");
    // Newest edge of the ring, and ALSO a question to x, who is not in it.
    const bax = await ask(m, "b", ["a", "x"], "b->a,x");
    await handed(m, "b", ab);
    await handed(m, "a", bax);
    for (const id of ["a", "b"]) await park(m, id);

    await m.supervisor.forceWatchdog();

    const pending = m.kernel.state.pendingRequests.get(bax);
    assert.ok(pending, "voiding b's ask whole would cancel a question x still owes an answer to");
    assert.ok((pending!.outstanding ?? pending!.to).includes("x"), "x's obligation is untouched");
    assert.deepEqual(await breaks(m), [ab], "the ring is broken on its single-debtor edge instead");
  } finally {
    await m.cleanup();
  }
});

test("wait cycle: both the asker and the released debtor are told, by durable mail", async () => {
  const m = await makeMesh({
    agents: [
      { id: "architect", role: "architect", interests: [] },
      { id: "dev", role: "developer", interests: [] },
    ],
    mayContact: { architect: ["dev"], dev: ["architect"] },
    mode: "parked",
  });
  try {
    const a = await ask(m, "architect", ["dev"], "which db?");
    const b = await ask(m, "dev", ["architect"], "which schema?");
    await handed(m, "dev", a);
    await handed(m, "architect", b);
    for (const id of ["architect", "dev"]) await park(m, id);

    await m.supervisor.forceWatchdog();
    assert.deepEqual(await breaks(m), [b], "fixture: the newer ask is the one voided");

    // A wake note is in-memory and is coalesced away when the seat already has
    // an equal-priority wake queued; mail waits in the box until a turn reads it.
    const notice = (seat: string) =>
      (m.kernel.state.unread.get(seat) ?? [])
        .map((id) => m.kernel.state.messages.get(id))
        .find((msg) => (msg?.payload as { voidedRequest?: string } | undefined)?.voidedRequest === b);
    assert.ok(notice("dev"), "the asker is told its ask was voided");
    assert.ok(notice("architect"), "the debtor is told it no longer owes the answer");
    assert.ok(eventTypes(await m.store.read()).includes("deadlock.auto_resolved"));
  } finally {
    await m.cleanup();
  }
});
