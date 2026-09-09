import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { TerminationManager, STALEMATE_RAISERS } from "../../packages/core/src/termination";
import { classifyEscalation, isDerivedEscalation, supportsOf } from "../../packages/core/src/supervisor";

/**
 * These tests pin the derived-escalation invariant:
 *
 *   a derived card is OPEN  <=>  at least one supporting primary is OPEN
 *
 * The bug they guard against parked a live mission behind a `stalemate`
 * summary whose underlying request had already been answered, leaving the
 * operator a card with no working action.
 */

const TWO = {
  agents: [
    { id: "asker", role: "developer", capabilities: ["repository.write"], interests: [] },
    { id: "ghost", role: "architect", capabilities: ["review.design"], authority: ["architecture.approve"], interests: [] },
  ],
  mayContact: { asker: ["ghost"], ghost: ["asker"] },
};

async function stuckMesh() {
  const m = await makeMesh(TWO);
  const sent = await m.supervisor.sendMessage({
    from: "asker",
    to: ["ghost"],
    type: "REQUEST",
    newThread: { subject: "need the doc" },
    payload: { question: "where is it?" },
  });
  assert.equal(sent.accepted, true);
  await m.supervisor.escalateStuckRequest("ghost", sent.messageId!);
  const stuck = [...m.kernel.state.escalations.values()].find((e) => e.reason === "stalemate:unanswered_request")!;
  assert.ok(stuck, "stuck escalation must exist");
  return { m, sent, stuck };
}

test("reconcile: classification separates human questions from watchdog summaries", () => {
  assert.equal(classifyEscalation("stalemate", "termination-manager"), "derived");
  assert.equal(classifyEscalation("stalemate:unanswered_request", "deadlock-detector"), "primary");
  assert.equal(classifyEscalation("budget_exhausted", "termination-manager"), "primary");
  // A `stalemate` reason raised by anyone else is still a real question.
  assert.equal(classifyEscalation("stalemate", "pm"), "primary");
});

test("reconcile: a derived card gets a stable conflictKey so the watchdog cannot mint duplicates", async () => {
  const { m, stuck } = await stuckMesh();
  const first = await m.supervisor.escalate({
    reason: "stalemate",
    raisedBy: "termination-manager",
    supports: [stuck.id],
    detail: { openDeadlockEscalations: [{ id: stuck.id, conflictKey: stuck.conflictKey, reason: stuck.reason }] },
  });
  // Same summary, different supporting set (a second stall appeared). The old
  // identity hashed `detail`, so this produced a SECOND open stalemate card.
  const second = await m.supervisor.escalate({
    reason: "stalemate",
    raisedBy: "termination-manager",
    supports: [stuck.id, "esc-imaginary"],
    detail: { openDeadlockEscalations: [{ id: stuck.id }, { id: "esc-imaginary" }] },
  });
  assert.equal(second.id, first.id, "a derived summary must dedupe by (goal, reason), not by its volatile detail");
  const openDerived = [...m.kernel.state.escalations.values()].filter((e) => e.status === "OPEN" && isDerivedEscalation(e));
  assert.equal(openDerived.length, 1, "at most one open stalemate summary per goal");
  await m.cleanup();
});

test("reconcile: derived card auto-resolves when its request is answered naturally (no operator action)", async () => {
  const { m, sent, stuck } = await stuckMesh();
  const derived = await m.supervisor.escalate({
    reason: "stalemate",
    raisedBy: "termination-manager",
    supports: [stuck.id],
    detail: { openDeadlockEscalations: [{ id: stuck.id, conflictKey: stuck.conflictKey, reason: stuck.reason }] },
  });
  assert.equal(m.kernel.state.escalations.get(derived.id)?.status, "OPEN");

  // The asked agent finally replies on its own — the exact path that used to
  // clear `pendingRequests` while leaving both cards OPEN forever.
  const orig = m.kernel.state.messages.get(sent.messageId!)!;
  const reply = await m.supervisor.sendMessage({
    from: "ghost",
    to: ["asker"],
    type: "INFORM",
    threadId: orig.threadId,
    replyTo: orig.id,
    payload: { answer: "here it is" },
  });
  assert.equal(reply.accepted, true);
  assert.equal(m.kernel.state.pendingRequests.size, 0, "reply clears the pending request");

  await m.supervisor.forceWatchdog();

  assert.equal(
    m.kernel.state.escalations.get(stuck.id)?.status,
    "AUTO_RESOLVED",
    "a stuck card whose request was answered must not keep asking the operator",
  );
  assert.equal(
    m.kernel.state.escalations.get(derived.id)?.status,
    "AUTO_RESOLVED",
    "a summary with no open supports must retire itself",
  );
  await m.cleanup();
});

test("reconcile: auto-resolution is recorded as such, never as a human response", async () => {
  const { m, sent, stuck } = await stuckMesh();
  const orig = m.kernel.state.messages.get(sent.messageId!)!;
  await m.supervisor.sendMessage({
    from: "ghost",
    to: ["asker"],
    type: "INFORM",
    threadId: orig.threadId,
    replyTo: orig.id,
    payload: { answer: "done" },
  });
  await m.supervisor.forceWatchdog();

  const closed = m.kernel.state.escalations.get(stuck.id)!;
  assert.equal(closed.status, "AUTO_RESOLVED");
  assert.notEqual(closed.status, "RESPONDED", "the runtime must not forge an operator decision in the audit trail");
  const events = m.kernel.state.eventCount;
  assert.ok(events > 0);
  await m.cleanup();
});

test("reconcile: a parked mission un-parks once its last escalation loses its question", async () => {
  const { m, stuck } = await stuckMesh();
  const derived = await m.supervisor.escalate({
    reason: "stalemate",
    raisedBy: "termination-manager",
    supports: [stuck.id],
    detail: { openDeadlockEscalations: [{ id: stuck.id }] },
  });
  const goalId = m.kernel.state.activeGoalId!;
  await m.kernel.emit("goal.escalated", { goalId, reason: "stalemate" }, { actorId: "termination-manager" });
  assert.equal(m.kernel.state.goals.get(goalId)?.status, "ESCALATED");

  // Operator drops the underlying request. `dropStuckRequest` clears the
  // pending entry but records no escalation response, so before this fix both
  // cards stayed OPEN and the mission stayed parked forever on a question
  // that no longer existed.
  const d = await m.supervisor.dropStuckRequest(stuck.id, "not needed");
  assert.equal(d.ok, true);
  await m.supervisor.forceWatchdog();

  assert.equal(m.kernel.state.escalations.get(stuck.id)?.status, "AUTO_RESOLVED");
  assert.equal(m.kernel.state.escalations.get(derived.id)?.status, "AUTO_RESOLVED");
  assert.equal(
    m.kernel.state.goals.get(goalId)?.status,
    "ACTIVE",
    "with every escalation closed the mission must resume instead of waiting on a human forever",
  );
  await m.cleanup();
});

test("reconcile: answering a derived card answers every request it summarizes", async () => {
  const { m, stuck } = await stuckMesh();
  const derived = await m.supervisor.escalate({
    reason: "stalemate",
    raisedBy: "termination-manager",
    supports: [stuck.id],
    detail: { openDeadlockEscalations: [{ id: stuck.id }] },
  });
  const r = await m.supervisor.respondEscalation(derived.id, "approved it myself; continue");
  assert.equal(r.ok, true);
  assert.equal(m.kernel.state.escalations.get(stuck.id)?.status, "RESPONDED");
  assert.notEqual(m.kernel.state.escalations.get(derived.id)?.status, "OPEN");
  await m.cleanup();
});

test("reconcile: legacy cards without `supports` still reconcile via detail", async () => {
  const { m, stuck } = await stuckMesh();
  // Simulates a card written by the previous build: detail only, no supports.
  const legacy = await m.supervisor.escalate({
    reason: "stalemate",
    raisedBy: "termination-manager",
    detail: { openDeadlockEscalations: [{ id: stuck.id, conflictKey: stuck.conflictKey, reason: stuck.reason }] },
  });
  assert.deepEqual(supportsOf(m.kernel.state.escalations.get(legacy.id)!), [stuck.id]);
  await m.supervisor.respondEscalation(stuck.id, "answered");
  assert.notEqual(
    m.kernel.state.escalations.get(legacy.id)?.status,
    "OPEN",
    "cards already on disk must keep reconciling after the upgrade",
  );
  await m.cleanup();
});

test("reconcile: the stalemate trigger and its supporting set use one query", () => {
  // Regression: the trigger accepted recovery-manager escalations but the
  // supporting list collected only deadlock-detector ones, so a
  // recovery-manager stall produced a card listing nothing — unanswerable.
  const now = new Date().toISOString();
  const state: any = {
    activeGoalId: "goal-1",
    goals: new Map([["goal-1", { id: "goal-1", status: "ACTIVE", acceptanceCriteria: [], budget: {} }]]),
    escalations: new Map([
      ["e1", { id: "e1", goalId: "goal-1", status: "OPEN", raisedBy: "recovery-manager", reason: "backend_unreachable", conflictKey: "backend:dev", createdAt: now }],
    ]),
    budgets: new Map(),
    tasks: new Map(),
    agents: new Map(),
    pendingRequests: new Map(),
    eventCount: 1,
  };
  const verdict = new TerminationManager().evaluate({
    state,
    config: { budgets: { mission: { maxEvents: 1000, wallClockMinutes: 1000 } } } as any,
    wallClockMs: 1,
  });
  assert.equal(verdict.kind, "escalate");
  assert.equal((verdict as any).reason, "stalemate");
  assert.deepEqual((verdict as any).supports, ["e1"], "a stalemate must be able to name what it is waiting on");
  assert.ok(STALEMATE_RAISERS.includes("recovery-manager"));
});
