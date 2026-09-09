import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialState, MAX_PENDING_REQUESTS, UNANSWERED_DISCHARGE_REASONS, type Projections } from "../../packages/core/src/state";
import { applyEvent } from "../../packages/core/src/projections";
import { DeadlockDetector } from "../../packages/core/src/termination";
import type { Escalation, MeshEvent, MeshMessage } from "../../packages/protocol/src/index";

/**
 * Ledger capacity. `pendingRequests` is bounded, so at some volume asks MUST
 * leave without being answered — that is not the bug. The bug was that they
 * left through a raw `pendingRequests.delete(...)`, bypassing the single
 * discharge path the ledger's whole audit story rests on.
 *
 * Three consumers read that map and every one of them drew a wrong conclusion
 * from a silent delete: the wait-for graph lost edges (so a provable deadlock
 * became undetectable), agent context stopped listing the debt, and the
 * escalation reconciler auto-closed the operator's card claiming the request
 * "was answered or withdrawn" — a false statement written into the log that
 * is supposed to be the source of truth.
 *
 * These tests pin the contract: eviction is a recorded discharge, it never
 * takes an ask an operator is already looking at, and "gone" never reports
 * itself as "answered".
 */

let seq = 0;
function evt(type: string, payload: Record<string, unknown>): MeshEvent {
  seq++;
  return {
    id: `evt-${seq}`,
    seq,
    type: type as MeshEvent["type"],
    timestamp: new Date(1_700_000_000_000 + seq * 1000).toISOString(),
    goalId: "goal-1",
    actorId: "system",
    payload,
  } as MeshEvent;
}

function askEvent(id: string, from: string, to: string[]): MeshEvent {
  const message: MeshMessage = {
    id,
    type: "REQUEST",
    timestamp: new Date(1_700_000_000_000 + ++seq * 1000).toISOString(),
    goalId: "goal-1",
    from,
    to,
    threadId: `thread-${id}`,
    artifactRefs: [],
    payload: {},
    priority: "NORMAL",
  } as MeshMessage;
  return evt("message.sent", { message });
}

/** Fill the ledger to exactly the cap: no eviction should have happened yet. */
function ledgerAtCap(): Projections {
  const state = createInitialState();
  for (let i = 0; i < MAX_PENDING_REQUESTS; i++) {
    applyEvent(state, askEvent(`msg-${i}`, "architect", ["dev"]));
  }
  assert.equal(state.pendingRequests.size, MAX_PENDING_REQUESTS, "precondition: ledger is exactly at cap");
  assert.equal(state.discharged.length, 0, "precondition: nothing evicted yet");
  return state;
}

test("ledger capacity: overflow leaves through the discharge path, not a silent delete", () => {
  const state = ledgerAtCap();

  applyEvent(state, askEvent("msg-overflow", "architect", ["dev"]));

  assert.equal(state.pendingRequests.size, MAX_PENDING_REQUESTS, "the cap still holds");
  assert.equal(state.pendingRequests.has("msg-0"), false, "the oldest ask was the one evicted");
  assert.equal(state.pendingRequests.has("msg-overflow"), true, "the new ask is in the ledger");

  const rec = state.discharged.find((d) => d.messageId === "msg-0");
  assert.ok(rec, "an evicted ask MUST leave a discharge record — a raw delete left none");
  assert.equal(rec.reason, "evicted_cap");
  assert.equal(rec.by, "system");
  assert.equal(rec.from, "architect", "the record keeps the creditor, so the loss is attributable");
});

test("ledger capacity: eviction is never reported as an answer", () => {
  const state = ledgerAtCap();
  applyEvent(state, askEvent("msg-overflow", "architect", ["dev"]));

  const rec = state.discharged.find((d) => d.messageId === "msg-0")!;
  assert.ok(
    UNANSWERED_DISCHARGE_REASONS.has(rec.reason),
    "capacity eviction must be classified as UNANSWERED: consumers key 'was it answered?' off this set, " +
      "and mislabelling it lets the escalation reconciler close a card with a false claim",
  );
});

test("ledger capacity: an ask an OPEN escalation points at is never evicted", () => {
  const state = ledgerAtCap();

  // The operator has been asked to resolve msg-0 — the single oldest ask, and
  // therefore first in line for eviction.
  const escalation: Escalation = {
    id: "esc-1",
    goalId: "goal-1",
    reason: "stalemate:unanswered_request",
    detail: { requestMessageId: "msg-0", agentId: "architect" },
    raisedBy: "termination-manager",
    conflictKey: "stuck:msg-0:architect",
    status: "OPEN",
  } as Escalation;
  state.escalations.set(escalation.id, escalation);

  applyEvent(state, askEvent("msg-overflow", "architect", ["dev"]));

  assert.equal(
    state.pendingRequests.has("msg-0"),
    true,
    "the escalated ask must outlive capacity pressure: evicting it would strand an operator card " +
      "pointing at a question the runtime no longer knows about",
  );
  assert.equal(state.pendingRequests.has("msg-1"), false, "the next-oldest unprotected ask went instead");
  assert.equal(state.discharged.find((d) => d.messageId === "msg-1")?.reason, "evicted_cap");
});

test("ledger capacity: a resolved escalation stops protecting its ask", () => {
  const state = ledgerAtCap();
  state.escalations.set("esc-1", {
    id: "esc-1",
    goalId: "goal-1",
    reason: "stalemate:unanswered_request",
    detail: { requestMessageId: "msg-0", agentId: "architect" },
    raisedBy: "termination-manager",
    status: "RESOLVED",
  } as unknown as Escalation);

  applyEvent(state, askEvent("msg-overflow", "architect", ["dev"]));

  assert.equal(state.pendingRequests.has("msg-0"), false, "only OPEN cards protect; a closed one must not pin the ledger");
});

test("ledger capacity: eviction cannot hide a circular wait from the deadlock detector", () => {
  // The regression that made this worth fixing. Insertion order evicts the
  // OLDEST asks first, which are exactly the ones most likely to be genuinely
  // stuck — so under pressure the ledger deleted the evidence of the deadlock
  // it is supposed to prove in O(V+E).
  const state = createInitialState();

  for (const [id, def] of [
    ["a", { id: "a", role: "architect" }],
    ["b", { id: "b", role: "developer" }],
  ] as const) {
    state.agents.set(id, {
      definition: {
        ...def,
        mode: "peer",
        runtime: "stub",
        prompt: {},
        capabilities: [],
        authority: [],
        communicationPolicy: { mayContact: [], mayBeContactedBy: [] },
        interests: [],
        sessionPolicy: { persistent: true },
        delegationPolicy: { allowDelegation: false, maxDepth: 0, maxWorkers: 0 },
        budget: {},
      },
      state: { lifecycle: "WAITING" },
    } as never);
  }

  // `scan` only runs against a live goal.
  state.activeGoalId = "goal-1";
  state.goals.set("goal-1", { id: "goal-1", status: "ACTIVE" } as never);

  // a waits on b, b waits on a — provably unresolvable, and both asks are old.
  applyEvent(state, askEvent("msg-cycle-a", "a", ["b"]));
  applyEvent(state, askEvent("msg-cycle-b", "b", ["a"]));

  const detector = new DeadlockDetector({
    escalation: { threadDepthMax: 999, repeatedConflictMax: 999, artifactReviewRoundsMax: 999 },
  } as never);

  const before = detector.scan(state as never).filter((f) => f.kind === "wait_cycle");
  assert.equal(before.length, 1, "precondition: the circular wait is detectable while both asks are in the ledger");

  // Now flood the ledger past capacity.
  for (let i = 0; i < MAX_PENDING_REQUESTS + 5; i++) {
    applyEvent(state, askEvent(`msg-flood-${i}`, "architect", ["dev"]));
  }

  const evictedCycleAsk =
    !state.pendingRequests.has("msg-cycle-a") || !state.pendingRequests.has("msg-cycle-b");
  assert.ok(evictedCycleAsk, "precondition: the flood was large enough to evict the cycle's asks");

  const lost = detector.scan(state as never).filter((f) => f.kind === "wait_cycle");
  assert.equal(lost.length, 0, "the cycle really does vanish from the graph once evicted");

  // ...which is precisely why the loss must be on the record. A silent delete
  // left an undetectable deadlock AND no trace that anything was dropped.
  const records = state.discharged.filter((d) => d.reason === "evicted_cap");
  assert.ok(records.length > 0, "every eviction is recorded, so an undetectable deadlock is at least explainable");
  assert.ok(
    records.some((d) => d.messageId === "msg-cycle-a" || d.messageId === "msg-cycle-b"),
    "the evicted cycle asks are named in the discharge history",
  );
});

test("ledger capacity: mailbox depth stays truthful when the unread cap trims", () => {
  const state = createInitialState();
  state.agents.set("dev", {
    definition: {
      id: "dev",
      role: "developer",
      mode: "peer",
      runtime: "stub",
      prompt: {},
      capabilities: [],
      authority: [],
      communicationPolicy: { mayContact: [], mayBeContactedBy: [] },
      interests: [],
      sessionPolicy: { persistent: true },
      delegationPolicy: { allowDelegation: false, maxDepth: 0, maxWorkers: 0 },
      budget: {},
    },
    state: { lifecycle: "IDLE", mailboxDepth: 0 },
  } as never);

  for (let i = 0; i < 260; i++) {
    applyEvent(state, askEvent(`mail-${i}`, "architect", ["dev"]));
  }

  const box = state.unread.get("dev") ?? [];
  assert.equal(
    state.agents.get("dev")!.state.mailboxDepth,
    box.length,
    "mailboxDepth is written on every delivery but the cap used to trim the box without resyncing it, " +
      "leaving the agent's own state claiming a deeper mailbox than exists",
  );
});
