import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, collectEvents } from "../helpers";
import { InterruptedTurnError, isTimeoutError } from "../../packages/protocol/src/index";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * `turn.discarded` — the only event whose subject is a non-event.
 *
 * A turn that ran, spent tokens, and produced nothing the mesh could act on used
 * to leave no trace in the event stream. A parse failure wrote an audit line; a
 * timeout or forced settle wrote nothing at all, because the audit row is written
 * before the op loop and the throw escapes past it. From `events.jsonl` every one
 * of those turns looked exactly like a seat that woke and had nothing to say.
 *
 * One live run spent 1,191,376 tokens — 28% of everything it billed — that way,
 * including a review verdict, two publications and the mission's own requirements
 * baseline. The seats knew (the summary reaches their next context as an
 * auto-memory note) and wrote it into their continuity records, which is the only
 * reason it was ever found.
 *
 * These tests assert the loss is now visible, and — just as important — that the
 * event never claims a token figure it does not have.
 */

const AGENTS = [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] }];

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

async function discards(m: Mesh): Promise<Array<Record<string, unknown>>> {
  return (await collectEvents(m)).filter((e) => e.type === "turn.discarded").map((e) => e.payload as Record<string, unknown>);
}

test("turn.discarded: a turn whose ops did not parse is recorded, with its cost", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: { dev: [] }, mode: "live" });
  try {
    stub(m).setScript("dev", async () => ({
      operations: [],
      text: "I have published the requirements baseline and notified the team.",
      tokensUsed: { input: 20_000, output: 5_000, total: 25_000 },
    }));

    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the discard to be recorded", async () => (await discards(m)).length === 1, 5000);

    const [d] = await discards(m);
    assert.equal(d!.reason, "no_ops");
    assert.equal(d!.agentId, "dev");
    assert.equal(d!.tokens, 25_000, "the tokens are known on this path, so the event states them");
    assert.ok(String(d!.turnId).startsWith("turn-"), "and names the turn that was thrown away");
  } finally {
    await m.cleanup();
  }
});

test("turn.discarded: the event correlates to its own turn", async () => {
  // `activeTurnByAgent` is cleared three lines below the emit, so the
  // correlation is passed explicitly. If that ever regresses to relying on the
  // kernel's default the field comes back undefined and the event becomes
  // unjoinable — which is the whole class of defect this event exists to end.
  const m = await makeMesh({ agents: AGENTS, mayContact: { dev: [] }, mode: "live" });
  try {
    stub(m).setScript("dev", async () => ({ operations: [], text: "done, I think", tokensUsed: { input: 1, output: 1, total: 2 } }));
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the discard", async () => (await discards(m)).length === 1, 5000);

    const ev = (await collectEvents(m)).find((e) => e.type === "turn.discarded");
    assert.ok(ev, "the event exists");
    const payloadTurn = (ev.payload as { turnId?: string }).turnId;
    assert.equal(ev.correlationId, payloadTurn, "correlationId must be the turn, so this joins to the turn's other events");
  } finally {
    await m.cleanup();
  }
});

test("turn.discarded: a turn that produced work records nothing", async () => {
  // The negative control. An event emitted on every turn would be noise, and
  // would make the 28% figure unreadable by burying it in successful turns.
  const m = await makeMesh({ agents: AGENTS, mayContact: { dev: [] }, mode: "live" });
  try {
    stub(m).setScript("dev", async () => ({
      operations: [{ op: "wait" } as MeshOp],
      tokensUsed: { input: 10, output: 10, total: 20 },
    }));
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the turn to finish", () => m.scheduler.pending() === 0 && m.scheduler.running() === 0);
    await new Promise((r) => setTimeout(r, 150));

    assert.equal((await discards(m)).length, 0, "a turn that emitted a legitimate op is not a discard");
  } finally {
    await m.cleanup();
  }
});

test("turn.discarded: a turn that threw reports no token figure rather than zero", async () => {
  // The distinction the payload exists to preserve. A turn killed mid-generation
  // really did spend tokens at the provider; the mesh simply does not know how
  // many, and the reservation it releases is an EWMA estimate. Reporting 0 would
  // be a measurement we do not have — and `noteTurnCost` deliberately ignores
  // zero-token turns as missing data, so a fabricated 0 would also poison the
  // next reservation.
  const m = await makeMesh({ agents: AGENTS, mayContact: { dev: [] }, mode: "live" });
  try {
    stub(m).setScript("dev", async () => {
      throw new Error("turn timeout after 1200000ms");
    });
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the discard", async () => (await discards(m)).length >= 1, 8000);

    const [d] = await discards(m);
    assert.equal(d!.reason, "timeout", "the message is classified, so the cause is queryable");
    assert.ok(!("tokens" in d!), "absent, not zero — an unmeasured turn must not read as a free one");
    assert.match(String(d!.detail), /timeout/, "and the original message survives for a reader");
  } finally {
    await m.cleanup();
  }
});

test("turn.discarded: a mesh-ordered interrupt reports the figure the backend did measure", async () => {
  // The other half of the rule above. "Absent, not zero" is right when the cost is
  // unknown — but on an interrupt it is NOT unknown: the CLI answers a mesh-ordered
  // abort with a `result` frame carrying real `usage`, and the adapter used to throw
  // that frame away on its way to raising the abort. Roughly 85 minutes of
  // generation went unbilled and unseen across one run that way.
  //
  // `InterruptedTurnError` is named "AbortError" so `isTimeoutError` still
  // classifies it as "slow, not crashed"; the assertion below pins that the
  // classification survived the change, not just the number.
  const m = await makeMesh({ agents: AGENTS, mayContact: { dev: [] }, mode: "live" });
  try {
    stub(m).setScript("dev", async () => {
      throw new InterruptedTurnError("turn interrupted by the mesh before the backend answered", {
        input: 300_000,
        output: 12_000,
        total: 312_000,
      });
    });
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the discard", async () => (await discards(m)).length >= 1, 8000);

    const [d] = await discards(m);
    assert.equal(d!.tokens, 312_000, "a measured interrupt must report what it measured");
    assert.ok(isTimeoutError(new InterruptedTurnError("x")), "and must still read as slow rather than crashed");
    // An interrupt's own message mentions neither timeout nor silence, so a
    // message-only classifier called this `failed` — the same word a crashed
    // backend gets, which is the confusion this error type exists to end.
    assert.equal(d!.reason, "silence", "a turn the mesh stopped is not a turn that broke");
  } finally {
    await m.cleanup();
  }
});

test("an interrupt that beat the backend's own frame still reports nothing", async () => {
  // `tokensUsed` is optional for a reason: the supervisor force-settles an
  // unanswered interrupt after a grace period, and that path has no frame and so
  // no figure. It must fall back to absent rather than to 0.
  const m = await makeMesh({ agents: AGENTS, mayContact: { dev: [] }, mode: "live" });
  try {
    stub(m).setScript("dev", async () => {
      throw new InterruptedTurnError("turn interrupted by the mesh before the backend answered");
    });
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the discard", async () => (await discards(m)).length >= 1, 8000);

    const [d] = await discards(m);
    assert.ok(!("tokens" in d!), "no frame means no measurement, which is not the same as free");
  } finally {
    await m.cleanup();
  }
});
