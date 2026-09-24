import { test } from "node:test";
import assert from "node:assert/strict";
import type { MeshInstance } from "../../apps/mesh-server/src/index";
import { makeMesh, stub, waitFor } from "../helpers";
import { createInitialState, UNANSWERED_DISCHARGE_REASONS, PER_DEBTOR_DISCHARGE_REASONS } from "../../packages/core/src/state";
import { applyEvent } from "../../packages/core/src/projections";
import { buildRunReport } from "../../packages/core/src/run-report";
import { MISSION_HALTED_ALLOW_OPS } from "../../packages/core/src/mission-guards";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * Withdrawing an ask you raised (Gap 2).
 *
 * `discharge` is the DEBTOR's exit, and until `withdraw` existed there was no
 * move on the other side of the ledger. A seat that raised an ask and then
 * stopped needing the answer could only WAIT or CHASE -- and a chase is an
 * interrupt charged to somebody else's attention, demanding an answer to a
 * question the asker had already stopped caring about. Failing both, the ask
 * aged into the nudge ladder and raised an operator card, so a human was woken
 * to arbitrate a question nobody wanted answered.
 *
 * The credential here is the exact OPPOSITE of `discharge`'s, which is why
 * this is its own op and not a flag on that one: a refusal is authorized by
 * OWING the answer, a retraction by having ASKED the question.
 */

function fakeTurn(agentId: string) {
  return {
    turnId: `t-${agentId}-${Math.random().toString(36).slice(2, 8)}`,
    agentId,
    reason: { kind: "manual" },
    sentOps: 0,
    publishedOps: 0,
    waitRequested: false,
    escalated: false,
    results: [],
  } as never;
}

const acts = (m: MeshInstance, id: string) => m.kernel.state.agents.get(id)?.state.activations ?? 0;

/** Every seat answers `done`, so a wake is visible as an activation and nothing else happens. */
function quietRuntimes(m: MeshInstance, ids: string[]): void {
  const s = stub(m);
  for (const id of ids) s.setScript(id, async () => ({ operations: [{ op: "done" } as MeshOp] }));
}

const DEBTORS = ["dev", "qa", "sec"];

async function panel(opts?: { live?: boolean }) {
  return makeMesh({
    agents: [
      { id: "architect", role: "architect", capabilities: ["review.design"], interests: [] },
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "qa", role: "qa", capabilities: ["test.run"], interests: [] },
      { id: "sec", role: "security", capabilities: ["security.scan"], interests: [] },
    ],
    mayContact: {
      architect: DEBTORS,
      dev: ["architect"],
      qa: ["architect"],
      sec: ["architect"],
    },
    // Parked by default: these are ledger assertions and a live scheduler
    // would add activations that say nothing about the ledger. The two tests
    // that DO measure wakes opt in.
    ...(opts?.live ? {} : { mode: "parked" as const }),
  });
}

async function askThree(m: Awaited<ReturnType<typeof panel>>) {
  const ask = await m.supervisor.sendMessage({
    from: "architect",
    to: DEBTORS,
    type: "REQUEST_REVIEW",
    newThread: { subject: "everyone please review" },
    payload: { q: "review this" },
  });
  assert.equal(ask.accepted, true, ask.reason);
  return ask.messageId!;
}

function replayed(m: Awaited<ReturnType<typeof panel>>, events: Awaited<ReturnType<typeof m.store.read>>) {
  const fresh = createInitialState();
  for (const e of events) {
    applyEvent(fresh, e, {
      transitionGates: m.config.transitionGates,
      commitmentSemantic: m.config.bus.commitmentSemantic,
    });
  }
  return fresh;
}

test("withdraw: the asker may not be a bystander, and a debtor may not be the asker", async () => {
  const m = await panel();
  const id = await askThree(m);

  // The mirror image of `discharge`'s guard. That one refuses the SENDER
  // ("only a debtor may decline"); this one refuses everyone but the sender.
  // Without it any seat could void a colleague's question, which is the same
  // abuse arriving from the other end of the ledger.
  for (const outsider of ["dev", "qa", "sec"]) {
    const res = await m.supervisor.executeOp(outsider, { op: "withdraw", messageId: id, reason: "I decided this doesn't matter" }, fakeTurn(outsider));
    assert.equal(res.ok, false, `${outsider} must not be able to withdraw someone else's ask`);
    // Names the ASKER. The seat that tried this has to learn whose question it
    // was; who owed an answer has nothing to do with why it was refused, and
    // listing them invites the reading that this is a dispute about the answer.
    assert.match(res.reason ?? "", /architect/, `the refusal must name the asker, got: ${res.reason}`);
  }
  assert.ok(m.kernel.state.pendingRequests.has(id), "every refusal left the ask open");
  await m.cleanup();
});

test("withdraw: the asker closes it, every debtor is released, and the record says which", async () => {
  const m = await panel();
  const id = await askThree(m);
  assert.deepEqual(m.kernel.state.pendingRequests.get(id)?.outstanding, DEBTORS);

  const res = await m.supervisor.executeOp("architect", { op: "withdraw", messageId: id, reason: "we shipped the old design instead" }, fakeTurn("architect"));
  assert.equal(res.ok, true, res.reason);
  assert.equal(m.kernel.state.pendingRequests.has(id), false, "the ask leaves the ledger through the one exit there is");

  const rec = m.kernel.state.discharged.find((d) => d.messageId === id);
  assert.equal(rec?.reason, "withdrawn_by_sender");
  assert.equal(rec?.by, "architect");
  // Every debtor released at once. A retraction is not aimed at one seat's
  // share, so it must not be a partial discharge wearing a whole-ask name --
  // and because it is whole-ask, the record's own `to` IS the released list.
  // There is no separate field, which is why the assertion is on `to`.
  assert.deepEqual(rec?.to, DEBTORS);
  assert.equal(rec?.partial, undefined, "releasing everyone is not a partial settle");
  assert.equal(rec?.remaining, undefined, "nobody is left owing");

  // The reason is durable on the EVENT, which is the only place it is kept.
  // `DischargeRecord` has a fixed shape the reducer builds field by field, so
  // an extra detail key would ride into the payload and stop there.
  const evt = (await m.store.read()).find((e) => e.type === "commitment.discharged" && (e.payload as Record<string, unknown>).messageId === id);
  assert.ok(evt, "the discharge reached the log");
  await m.cleanup();
});

test("withdraw: the released debtors are told, and the notice does not claim to be the answer", async () => {
  const m = await panel();
  const id = await askThree(m);
  await m.supervisor.executeOp("architect", { op: "withdraw", messageId: id, reason: "no longer needed" }, fakeTurn("architect"));

  const notices = [...m.kernel.state.messages.values()].filter((x) => (x.payload as Record<string, unknown>)?.withdrawn === true);
  assert.equal(notices.length, 1, "one notice, addressed to everyone released");
  const notice = notices[0]!;
  assert.deepEqual([...notice.to].sort(), [...DEBTORS].sort(), "addressed to the debtors, not to the asker");
  assert.equal(notice.from, "architect");
  assert.equal((notice.payload as Record<string, unknown>).request, id);
  assert.match(String((notice.payload as Record<string, unknown>).reason), /no longer needed/);

  // `replyTo` is what DISCHARGES an ask. A retraction carrying it would tell
  // every reader of the log that this was the answer to the question it is
  // cancelling -- which is worse than no linkage at all.
  assert.equal(notice.replyTo, undefined, "a retraction is not a reply");
  assert.equal(notice.causationId, id, "it is still linked causally to the ask it cancels");
  await m.cleanup();
});

test("withdraw: a retraction is not an unanswered ask, so it raises no finding and no card", async () => {
  const m = await panel();
  const id = await askThree(m);

  // The reasoning is deliberately in the SET, not in a filter at each reader:
  // two consumers ask "did this ask go unanswered", and a retraction has to
  // answer no for both. `reconcileEscalations` reads "no longer pending" as
  // "answered or withdrawn" and retires the operator's stalled-ask card, so
  // membership here would keep a human's card OPEN over a question that no
  // longer exists -- the exact manufactured interrupt this op removes.
  assert.equal(UNANSWERED_DISCHARGE_REASONS.has("withdrawn_by_sender"), false);
  // And it is a whole-ask decision: it releases every debtor, so it must not
  // be in the per-debtor set, which settles one share and leaves the rest.
  assert.equal(PER_DEBTOR_DISCHARGE_REASONS.has("withdrawn_by_sender"), false);

  await m.supervisor.executeOp("architect", { op: "withdraw", messageId: id, reason: "obsolete" }, fakeTurn("architect"));
  assert.deepEqual(buildRunReport(m.kernel.state).comms.lostAsks, [], "a withdrawn ask is not a lost one");
  await m.cleanup();
});

test("withdraw: closing an ask survives replay", async () => {
  const m = await panel();
  const id = await askThree(m);
  await m.supervisor.executeOp("architect", { op: "withdraw", messageId: id, reason: "changed my mind" }, fakeTurn("architect"));

  const rebuilt = replayed(m, await m.store.read());
  assert.equal(rebuilt.pendingRequests.has(id), false, "the retraction must survive replay");
  assert.equal(rebuilt.discharged.find((d) => d.messageId === id)?.reason, "withdrawn_by_sender");
  await m.cleanup();
});

test("withdraw: withdrawing an unknown or already-withdrawn ask fails cleanly", async () => {
  const m = await panel();
  const missing = await m.supervisor.executeOp("architect", { op: "withdraw", messageId: "msg-does-not-exist", reason: "x" }, fakeTurn("architect"));
  assert.equal(missing.ok, false);
  assert.match(missing.reason ?? "", /no outstanding request/);

  const id = await askThree(m);
  assert.equal((await m.supervisor.executeOp("architect", { op: "withdraw", messageId: id, reason: "once" }, fakeTurn("architect"))).ok, true);
  // The second attempt is the interesting one: the ask is gone, and a seat
  // that retries must be told so rather than sending the debtors a second
  // "stop working on this" for work that stopped a while ago.
  const again = await m.supervisor.executeOp("architect", { op: "withdraw", messageId: id, reason: "twice" }, fakeTurn("architect"));
  assert.equal(again.ok, false);
  assert.equal(
    [...m.kernel.state.messages.values()].filter((x) => (x.payload as Record<string, unknown>)?.withdrawn === true).length,
    1,
    "no second notice",
  );
  await m.cleanup();
});

test("withdraw: it costs no turn on either side, and still delivers", async () => {
  const m = await panel({ live: true });
  try {
    quietRuntimes(m, ["architect", ...DEBTORS]);
    const id = await askThree(m);
    await waitFor("the ask's own wakes land", () => acts(m, "dev") >= 1);

    const before = Object.fromEntries(DEBTORS.map((d) => [d, acts(m, d)]));
    const askerBefore = acts(m, "architect");

    await m.supervisor.executeOp("architect", { op: "withdraw", messageId: id, reason: "not needed" }, fakeTurn("architect"));
    const notice = [...m.kernel.state.messages.values()].find((x) => (x.payload as Record<string, unknown>)?.withdrawn === true);
    assert.ok(notice, "the notice exists");
    await waitFor(
      "the accrue notice still reaches every debtor's mailbox",
      () => DEBTORS.every((d) => (m.kernel.state.unread.get(d) ?? []).includes(notice!.id)),
    );

    // Waiting for a wake that never comes is the only way to test this, so give
    // the scheduler real time to prove it does not happen.
    await new Promise((r) => setTimeout(r, 250));
    for (const d of DEBTORS) {
      assert.equal(acts(m, d), before[d], `${d} must not be woken to be told to stop`);
    }
    // And the ASKER is not woken either. `dischargeCommitment` wakes the asker
    // to drive the next step, which here would tell the seat what it just did
    // to itself -- a self-close the asker already knows about.
    assert.equal(acts(m, "architect"), askerBefore, "the asker is not woken to be told about its own withdrawal");
  } finally {
    await m.cleanup();
  }
});

test("withdraw: the halt that a stuck ask causes does not block the op that ends it", async () => {
  const m = await panel();
  const id = await askThree(m);
  const goalId = m.kernel.state.activeGoalId!;
  await m.kernel.emit("goal.escalated", { goalId, reason: "an ask went unanswered" }, { actorId: "human" });
  assert.equal(m.kernel.state.goals.get(goalId)?.status, "ESCALATED");

  // The card the operator is looking at was raised BECAUSE this ask is stuck,
  // and the asker is the only seat that can say whether the answer is still
  // wanted. A freeze that blocked the op would let a stale question hold the
  // mission down for exactly as long as the operator is away -- and the one
  // person who could resolve it is the one who by definition cannot ask.
  assert.equal(MISSION_HALTED_ALLOW_OPS.has("withdraw"), true);
  const res = await m.supervisor.executeOp("architect", { op: "withdraw", messageId: id, reason: "we moved on" }, fakeTurn("architect"));
  assert.equal(res.ok, true, res.reason);
  assert.equal(m.kernel.state.pendingRequests.has(id), false);
  await m.cleanup();
});
