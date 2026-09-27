import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, collectEvents } from "../helpers";
import type { MeshOp, MeshMessage } from "../../packages/protocol/src/index";

/**
 * `mesh.messages.max_sends_per_turn`: one turn, one budget, one digest.
 *
 * The mailbox half of the problem the delivery regime addresses from the wake
 * side. `deliver`-class coalescing already stops a burst costing one turn per
 * line, but every line still LANDS — and it is the landing that buried the hub
 * seat on the 2026-09-27 run (282 messages in a day, 119 of them at tech-lead,
 * ~100 never read, its mailbox peaking at 145 unread). So a turn's FYI-class
 * chatter past the budget is held and delivered as ONE digest when the turn
 * ends.
 *
 * The two invariants every test here is really defending:
 *
 *   1. Nothing is silently dropped. Every held message's content reaches every
 *      recipient it named, in the digest, whole.
 *   2. Nothing that MEANS something is batched. An ask still opens its ledger
 *      entry, a handoff is still a handoff, an answer is still an answer, an
 *      URGENT is still urgent — a digest that swallowed one of those would be a
 *      traffic optimisation that changed the protocol.
 *
 * Sends are made from inside a real stub turn (`executeToolOp`, the same entry
 * point `McpToolset` calls), because the budget is a property of a seat's TURN:
 * a send with no turn in flight is not one, which is what keeps the sweeps,
 * watchdogs and recovery paths outside the ration.
 */

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

const AGENTS = [
  { id: "architect", role: "architect", interests: [] },
  // The recipients are parked for FYIs, and that is load-bearing rather than
  // decorative. Delivery is pinned through the mailbox projection (`unread`),
  // and an INFORM that WAKES a seat is consumed by that seat's own turn before
  // the assertion can read it — so a plain fixture would be asserting a race
  // and passing for the wrong reason. `defer_non_obliging` suppresses the wake
  // and never the delivery: the mail lands, nobody is woken, and the box the
  // budget is protecting stays readable. An ask, a HANDOFF and an URGENT still
  // wake these seats, which the tests below rely on.
  { id: "dev", role: "developer", interests: [], wake: { deferNonObliging: true } },
  { id: "qa", role: "qa-engineer", interests: [], wake: { deferNonObliging: true } },
];

function liveMesh(opts: { maxSendsPerTurn?: number; delivery?: boolean } = {}): Promise<Mesh> {
  return makeMesh({
    agents: AGENTS,
    mayContact: { architect: ["dev", "qa"] },
    mode: "live",
    ...(opts.maxSendsPerTurn !== undefined ? { messages: { maxSendsPerTurn: opts.maxSendsPerTurn } } : {}),
    ...(opts.delivery ? { bus: { delivery: {} } } : {}),
    stallIdleMs: 600_000,
    stallCooldownMs: 600_000,
    stallNoopRetryMs: 600_000,
  });
}

/** One send made from inside the turn, as the seat's own op channel makes it. */
interface SendAttempt {
  to: string[];
  type: string;
  payload: Record<string, unknown>;
  priority?: string;
  artifactRefs?: string[];
}

/**
 * Run ONE architect turn that makes every attempt in order, and settle it.
 *
 * The results are returned rather than asserted on inside the script: an
 * assertion thrown in a runtime script is swallowed by the turn's failure
 * ladder, and a test that cannot fail is worse than no test.
 */
async function turnOfSends(
  m: Mesh,
  attempts: SendAttempt[],
): Promise<Array<{ ok: boolean; messageId?: string; merged?: boolean; reason?: string }>> {
  const results: Array<{ ok: boolean; messageId?: string; merged?: boolean; reason?: string }> = [];
  stub(m).setScript("architect", async () => {
    for (const [i, a] of attempts.entries()) {
      const res = await m.supervisor.executeToolOp("architect", {
        op: "send",
        to: a.to,
        type: a.type,
        newThread: { subject: `${a.type} ${i + 1}` },
        payload: a.payload,
        ...(a.priority ? { priority: a.priority } : {}),
        ...(a.artifactRefs ? { artifactRefs: a.artifactRefs } : {}),
      } as unknown as MeshOp);
      results.push({ ok: res.ok, messageId: res.messageId, merged: res.merged, reason: res.reason });
    }
    return { operations: [{ op: "done" } as MeshOp], text: "sent", tokensUsed: { input: 10, output: 5, total: 15 } };
  });
  await m.supervisor.activateAgent("architect", { kind: "manual" }, { explicit: true });
  await waitFor(
    "the architect turn to settle",
    async () =>
      (await collectEvents(m)).some(
        (e) => e.type === "agent.state_changed" && (e.payload as { agentId?: string; from?: string }).agentId === "architect" && (e.payload as { from?: string }).from === "THINKING",
      ),
    8000,
  );
  return results;
}

const messagesTo = (m: Mesh, id: string): MeshMessage[] =>
  [...m.kernel.state.messages.values()].filter((x) => x.to.includes(id));
const digestsTo = (m: Mesh, id: string): MeshMessage[] =>
  messagesTo(m, id).filter((x) => (x.payload as { digest?: boolean } | null)?.digest === true);

test("send budget: past N, a turn's chatter arrives as ONE digest, with every body in it", async () => {
  const m = await liveMesh({ maxSendsPerTurn: 2 });
  try {
    const results = await turnOfSends(m, [
      { to: ["dev"], type: "INFORM", payload: { body: "one" } },
      { to: ["dev"], type: "INFORM", payload: { body: "two" } },
      { to: ["dev"], type: "INFORM", payload: { body: "three" }, artifactRefs: ["artifact://Design/schema/1"] },
    ]);

    // The first two are ordinary sends, byte for byte as they always were.
    assert.equal(results[0]!.ok, true);
    assert.equal(results[0]!.merged, undefined, "within the budget nothing changes");
    assert.ok(results[0]!.messageId, "a sent message has an id");
    assert.ok(results[1]!.messageId);

    // The third is HELD: accepted, no id, and the seat is told why on the spot.
    assert.equal(results[2]!.ok, true, "a held send is not a refusal");
    assert.equal(results[2]!.merged, true);
    assert.equal(results[2]!.messageId, undefined, "held mail has no id yet — and the notice says so");
    assert.match(String(results[2]!.reason), /digest/, "the seat is told what happened");
    assert.match(String(results[2]!.reason), /max_sends_per_turn=2/);
    assert.match(String(results[2]!.reason), /Do not send it again/);

    // The content reached the recipient: one envelope standing for the third.
    const digests = digestsTo(m, "dev");
    assert.equal(digests.length, 1, "one digest, not one envelope per held message");
    const payload = digests[0]!.payload as {
      count: number;
      batchedBy: string;
      entries: Array<{ type: string; to: string[]; payload: { body: string } }>;
    };
    assert.equal(payload.count, 1);
    assert.equal(payload.batchedBy, "mesh.messages.max_sends_per_turn");
    assert.equal(payload.entries.length, 1);
    assert.equal(payload.entries[0]!.type, "INFORM");
    assert.deepEqual(payload.entries[0]!.to, ["dev"], "the entry names its own recipients");
    assert.equal(payload.entries[0]!.payload.body, "three", "the BODY, not a summary of it");
    // A ref is content too: the entry names the artifact the way the envelope
    // would have, so a reader can follow it without asking for the message.
    const refs = (payload.entries[0] as unknown as { artifactRefs: Array<{ uri: string }> }).artifactRefs;
    assert.deepEqual(refs.map((r) => r.uri), ["artifact://Design/schema/1"]);

    // One digest envelope, not two: the two in-budget sends are their own mail.
    const informs = messagesTo(m, "dev").filter((x) => x.type === "INFORM" && (x.payload as { body?: string }).body);
    assert.deepEqual(informs.map((x) => (x.payload as { body?: string }).body).sort(), ["one", "two"]);

    // The seat's next turn sees the digest as mail, unread and addressable by id.
    assert.ok(m.kernel.state.unread.get("dev")?.includes(digests[0]!.id), "the digest is delivered, not just logged");

    // And the LOG says so, correlated to the turn that produced it: an operator
    // reading the events sees one message.sent standing for three.
    const sent = (await collectEvents(m)).filter((e) => e.type === "message.sent");
    const digestEvent = sent.find((e) => (e.payload as { message?: MeshMessage }).message?.id === digests[0]!.id);
    assert.ok(digestEvent, "the digest is a message.sent like any other");
    const carried = (digestEvent!.payload as { message: MeshMessage }).message;
    assert.equal((carried.payload as { digest?: boolean }).digest, true);
    assert.match(String(digestEvent!.correlationId), /^turn-|^mcp-/, "correlated to the turn that held it");
  } finally {
    await m.cleanup();
  }
});

test("send budget: an ask past the budget is NEVER swallowed into a digest — its obligation survives", async () => {
  const m = await liveMesh({ maxSendsPerTurn: 1 });
  try {
    const results = await turnOfSends(m, [
      { to: ["dev"], type: "INFORM", payload: { body: "fyi" } },
      { to: ["dev"], type: "INFORM", payload: { body: "and another" } },
      { to: ["dev"], type: "REQUEST", payload: { question: "can you review the schema?" } },
      { to: ["dev"], type: "REQUEST", payload: { question: "and the migration?" } },
    ]);

    const asks = [...m.kernel.state.messages.values()].filter((x) => x.type === "REQUEST");
    assert.equal(asks.length, 2, "both asks went out as themselves, however far past the budget the turn was");
    for (const r of results.slice(2)) {
      assert.equal(r.merged, undefined, "an ask is never held");
      assert.ok(r.messageId, "and it has an id the seat can reply to or withdraw");
    }
    // The point of not batching them: each is a live debt with its own entry.
    const pending = [...m.kernel.state.pendingRequests.values()].filter((pr) => pr.type === "REQUEST");
    assert.equal(pending.length, 2, "an ask still appears as an ask, not as news inside a digest");
    assert.ok(pending.every((pr) => (pr.outstanding ?? pr.to).includes("dev")));

    // The digest carries the FYI and nothing else.
    const digests = digestsTo(m, "dev");
    assert.equal(digests.length, 1);
    const payload = digests[0]!.payload as { count: number; entries: Array<{ type: string }> };
    assert.equal(payload.count, 1, "only the chatter was batched");
    assert.deepEqual(payload.entries.map((e) => e.type), ["INFORM"]);
  } finally {
    await m.cleanup();
  }
});

test("send budget: a handoff and an URGENT are never batched either, even past the budget", async () => {
  const m = await liveMesh({ maxSendsPerTurn: 1 });
  try {
    const results = await turnOfSends(m, [
      { to: ["dev"], type: "INFORM", payload: { body: "fyi" }, priority: "LOW" },
      { to: ["dev"], type: "HANDOFF", payload: { body: "take the parser" } },
      { to: ["dev"], type: "INFORM", payload: { body: "production is down" }, priority: "URGENT" },
    ]);

    const handoff = [...m.kernel.state.messages.values()].find((x) => x.type === "HANDOFF");
    assert.ok(handoff, "work that moved reached the seat that must do it, as itself");
    const urgent = [...m.kernel.state.messages.values()].find((x) => x.priority === "URGENT");
    assert.ok(urgent, "an explicit URGENT outranks the budget");
    assert.equal(urgent!.type, "INFORM");
    assert.equal((urgent!.payload as { body?: string }).body, "production is down");
    // A message that moves work is never swallowed: batching it would deliver
    // the news of the handoff without the handoff.
    assert.equal(digestsTo(m, "dev").length, 0, "nothing FYI-class was past the budget here");
    assert.equal(results[1]!.merged, undefined);
    assert.equal(results[2]!.merged, undefined);
  } finally {
    await m.cleanup();
  }
});

test("send budget: the runtime's own notices are not the seat's speech and are never counted", async () => {
  // A withdraw notice ships with a delivery class the RUNTIME stamped (it is a
  // retraction: a wake per debtor would make the cheap exit the expensive one),
  // and it is not a message the seat decided to write. Counting it would let the
  // runtime's own ledger traffic exhaust a seat's budget — and holding it would
  // put the retraction into a digest, where the debtor who was just released
  // would read it as a batched FYI.
  const m = await liveMesh({ maxSendsPerTurn: 1 });
  try {
    const results: Array<{ ok: boolean; merged?: boolean; messageId?: string }> = [];
    let askId: string | undefined;
    stub(m).setScript("architect", async () => {
      const ask = await m.supervisor.executeToolOp("architect", {
        op: "send",
        to: ["dev"],
        type: "REQUEST",
        newThread: { subject: "REVIEW 1" },
        payload: { question: "review the schema?" },
      } as unknown as MeshOp);
      askId = ask.messageId;
      results.push({ ok: ask.ok, merged: ask.merged, messageId: ask.messageId });
      // Over budget and merged: an FYI.
      const fyi = await m.supervisor.executeToolOp("architect", {
        op: "send",
        to: ["dev"],
        type: "INFORM",
        newThread: { subject: "FYI 2" },
        payload: { body: "fyi" },
      } as unknown as MeshOp);
      results.push({ ok: fyi.ok, merged: fyi.merged, messageId: fyi.messageId });
      // The runtime's own retraction, sent from this seat while its turn is live.
      const cut = await m.supervisor.executeToolOp("architect", {
        op: "withdraw",
        messageId: askId,
        reason: "never mind",
      } as unknown as MeshOp);
      results.push({ ok: cut.ok, merged: cut.merged, messageId: cut.messageId });
      return { operations: [{ op: "done" } as MeshOp], text: "done", tokensUsed: { input: 10, output: 5, total: 15 } };
    });
    await m.supervisor.activateAgent("architect", { kind: "manual" }, { explicit: true });
    await waitFor("the architect turn to settle", async () =>
      (await collectEvents(m)).some(
        (e) => e.type === "agent.state_changed" && (e.payload as { agentId?: string }).agentId === "architect" && (e.payload as { from?: string }).from === "THINKING",
      ), 8000);
    assert.equal(results.length, 3, "the turn ran all three ops");

    const notices = [...m.kernel.state.messages.values()].filter((x) => (x.payload as { withdrawn?: boolean }).withdrawn === true);
    assert.equal(notices.length, 1, "the retraction shipped as itself, not folded into the digest");
    assert.equal(notices[0]!.control?.delivery, "accrue", "and it keeps the class the runtime stamped for it");
    // Only the FYI was batched, and the seat's budget counted only its two sends.
    const digest = digestsTo(m, "dev")[0];
    assert.ok(digest, "the FYI is the one thing the turn held");
    const entries = (digest!.payload as { entries: Array<{ payload: { body?: string } }> }).entries;
    assert.deepEqual(entries.map((e) => e.payload.body), ["fyi"]);
  } finally {
    await m.cleanup();
  }
});

test("send budget: below N is today's behaviour, byte for byte — no digest, no notice, one id per send", async () => {
  const m = await liveMesh({ maxSendsPerTurn: 5 });
  try {
    const results = await turnOfSends(m, [
      { to: ["dev"], type: "INFORM", payload: { body: "a" } },
      { to: ["qa"], type: "INFORM", payload: { body: "b" } },
      { to: ["dev"], type: "INFORM", payload: { body: "c" } },
      { to: ["qa"], type: "INFORM", payload: { body: "d" } },
    ]);
    for (const r of results) {
      assert.equal(r.ok, true);
      assert.equal(r.merged, undefined, "under the budget every send is its own envelope");
      assert.ok(r.messageId);
      assert.equal(r.reason, undefined, "and nothing is batched, so there is nothing to report");
    }
    assert.equal(digestsTo(m, "dev").length, 0);
    assert.equal(digestsTo(m, "qa").length, 0);
    assert.equal([...m.kernel.state.messages.values()].filter((x) => x.type === "INFORM").length, 4);
  } finally {
    await m.cleanup();
  }
});

test("send budget: 0 disables it, and an absent key takes the default of 5", async () => {
  const off = await liveMesh({ maxSendsPerTurn: 0 });
  try {
    const results = await turnOfSends(
      off,
      Array.from({ length: 6 }, (_, i) => ({ to: ["dev"], type: "INFORM", payload: { body: `n${i}` } })),
    );
    assert.ok(results.every((r) => r.merged === undefined && r.messageId), "0 is the off switch");
    assert.equal(digestsTo(off, "dev").length, 0);
  } finally {
    await off.cleanup();
  }

  // Absent is not "no regime": the key is ON by default, like the digest and the
  // expiry beside it, because the run it was built for buried a seat with 42% of
  // the day's traffic and a knob nobody had heard of would have bought it nothing.
  const dflt = await liveMesh();
  try {
    assert.equal(dflt.config.messages.maxSendsPerTurn, 5, "the resolved default");
    const results = await turnOfSends(
      dflt,
      Array.from({ length: 6 }, (_, i) => ({ to: ["dev"], type: "INFORM", payload: { body: `n${i}` } })),
    );
    assert.equal(results.slice(0, 5).every((r) => r.merged === undefined && r.messageId), true, "the first five as themselves");
    assert.equal(results[5]!.merged, true, "the sixth is batched by the default");
    assert.equal(digestsTo(dflt, "dev").length, 1);
  } finally {
    await dflt.cleanup();
  }
});

test("send budget: a digest reaches EVERY recipient it names, and each held body keeps its own address", async () => {
  const m = await liveMesh({ maxSendsPerTurn: 1 });
  try {
    await turnOfSends(m, [
      { to: ["dev"], type: "INFORM", payload: { body: "for dev" } },
      { to: ["qa"], type: "INFORM", payload: { body: "for qa" } },
      { to: ["dev"], type: "INFORM", payload: { body: "for dev again" } },
    ]);
    const digest = digestsTo(m, "dev")[0];
    assert.ok(digest, "one digest for the union of recipients");
    assert.deepEqual([...digest!.to].sort(), ["dev", "qa"], "addressed to every seat it carries mail for");
    assert.ok(m.kernel.state.unread.get("dev")?.includes(digest!.id), "the first recipient receives it");
    assert.ok(m.kernel.state.unread.get("qa")?.includes(digest!.id), "and so does the other");
    const entries = (digest!.payload as { entries: Array<{ to: string[]; payload: { body: string } }> }).entries;
    assert.deepEqual(entries.map((e) => [e.to.join(","), e.payload.body]).sort(), [
      ["dev", "for dev again"],
      ["qa", "for qa"],
    ]);
    assert.equal(digestsTo(m, "qa").length, 1, "the same one, not a second copy");
  } finally {
    await m.cleanup();
  }
});

test("send budget: with a delivery regime on, a digest is `accrue` — a batch of FYIs cannot buy a wake per line", async () => {
  const m = await liveMesh({ maxSendsPerTurn: 1, delivery: true });
  try {
    await turnOfSends(m, [
      { to: ["dev"], type: "INFORM", payload: { body: "one" } },
      { to: ["dev"], type: "INFORM", payload: { body: "two" } },
    ]);
    const digest = digestsTo(m, "dev")[0];
    assert.ok(digest, "the digest still ships");
    assert.equal(digest!.control?.delivery, "accrue", "an INFORM digest is priced like the news it carries");
    assert.ok(m.kernel.state.unread.get("dev")?.includes(digest!.id), "and it is still delivered — a class suppresses the wakeup, never the mail");
  } finally {
    await m.cleanup();
  }
});
