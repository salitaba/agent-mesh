import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitialState, evictOverflowingPendingRequests, MAX_PENDING_REQUESTS, UNANSWERED_DISCHARGE_REASONS, type Projections } from "../../packages/core/src/state";
import { applyEvent } from "../../packages/core/src/projections";
import { DeadlockDetector } from "../../packages/core/src/termination";
import type { Escalation, MeshEvent, MeshMessage } from "../../packages/protocol/src/index";

/**
 * Ledger capacity. `pendingRequests` is bounded, so at some volume the mesh
 * MUST refuse work — that is not the bug. The bug was WHICH work it refused.
 *
 * The ledger used to accept every new ask and evict the oldest to make room.
 * Insertion order is roughly chronological, so the entries it reached first
 * were the ones that had been waiting longest — the most likely to be
 * genuinely stuck, and the ones whose loss hides a real deadlock. Three
 * consumers read that map and every one drew a wrong conclusion: the wait-for
 * graph lost edges (a provable deadlock became undetectable), agent context
 * stopped listing the debt, and the escalation reconciler auto-closed the
 * operator's card claiming the request "was answered or withdrawn".
 *
 * Capacity is now backpressure at OPEN: a full ledger refuses the new ask and
 * says so. Nothing already owed is lost, and the asker gets one immediate,
 * visible failure instead of some other agent's debt disappearing.
 *
 * These tests pin the contract: the cap refuses rather than evicts, the
 * refusal is recorded and classified UNANSWERED, existing asks (escalated or
 * not) survive capacity pressure, a deadlock stays provable under flood, and
 * eviction still exists as a last resort for a map that arrived over cap by
 * some other route.
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

test("ledger capacity: a full ledger refuses the new ask instead of evicting an old one", () => {
  const state = ledgerAtCap();

  applyEvent(state, askEvent("msg-overflow", "architect", ["dev"]));

  assert.equal(state.pendingRequests.size, MAX_PENDING_REQUESTS, "the cap still holds");
  assert.equal(state.pendingRequests.has("msg-overflow"), false, "the NEW ask is the one refused");
  assert.equal(
    state.pendingRequests.has("msg-0"),
    true,
    "the oldest ask survives — it is the one most likely to be genuinely stuck, " +
      "and dropping it to make room for a fresher question is exactly backwards",
  );

  const rec = state.discharged.find((d) => d.messageId === "msg-overflow");
  assert.ok(rec, "a refused ask MUST leave a record — silence here is indistinguishable from acceptance");
  assert.equal(rec.reason, "refused_cap");
  assert.equal(rec.by, "system");
  assert.equal(rec.from, "architect", "the record keeps the creditor, so the refusal is attributable");
});

test("ledger capacity: a refusal is never reported as an answer", () => {
  const state = ledgerAtCap();
  applyEvent(state, askEvent("msg-overflow", "architect", ["dev"]));

  const rec = state.discharged.find((d) => d.messageId === "msg-overflow")!;
  assert.ok(
    UNANSWERED_DISCHARGE_REASONS.has(rec.reason),
    "a refused-at-capacity ask must be classified as UNANSWERED: consumers key 'was it answered?' " +
      "off this set, and mislabelling it lets the escalation reconciler close a card with a false claim",
  );
});

test("ledger capacity: refusal is not delivery — the message still arrives", () => {
  const state = ledgerAtCap();

  applyEvent(state, askEvent("msg-overflow", "architect", ["dev"]));

  assert.equal(state.messages.has("msg-overflow"), true, "the message is still in the log");
  assert.ok(
    (state.unread.get("dev") ?? []).includes("msg-overflow"),
    "and still reached the recipient's mailbox — the cap bounds the OBLIGATION ledger, " +
      "not the mail, so the debtor may still choose to answer",
  );
});

test("ledger capacity: an ask an OPEN escalation points at survives, like every other ask", () => {
  const state = ledgerAtCap();

  // The operator has been asked to resolve msg-0 — the single oldest ask, and
  // under the old eviction rule the first in line to be dropped.
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
    "the escalated ask outlives capacity pressure: evicting it would strand an operator card " +
      "pointing at a question the runtime no longer knows about",
  );
  assert.equal(state.pendingRequests.has("msg-1"), true, "and so does the next-oldest — nothing is evicted at all now");
  assert.equal(state.discharged.some((d) => d.reason === "evicted_cap"), false, "nothing left through eviction");
});

test("ledger capacity: eviction survives as a last resort for a map that arrived over cap", () => {
  // Refusal-to-open means a live mesh never exceeds the cap. A map can still
  // arrive over it by another route — importing a snapshot written before
  // refusal existed, or a lowered MAX_PENDING_REQUESTS — and there the old
  // behaviour is still the least-bad one available.
  const state = ledgerAtCap();
  // Reach past the reducer, exactly as `importState` does.
  for (let i = 0; i < 3; i++) {
    state.pendingRequests.set(`legacy-${i}`, {
      messageId: `legacy-${i}`,
      from: "architect",
      to: ["dev"],
      type: "REQUEST",
      threadId: `thread-legacy-${i}`,
      createdAt: new Date(1_600_000_000_000 + i).toISOString(),
      outstanding: ["dev"],
    });
  }
  assert.equal(state.pendingRequests.size, MAX_PENDING_REQUESTS + 3, "precondition: over cap");

  const evicted = evictOverflowingPendingRequests(state, new Date(1_700_000_999_000).toISOString());

  assert.equal(evicted.length, 3, "exactly the overflow leaves");
  assert.equal(state.pendingRequests.size, MAX_PENDING_REQUESTS, "back to the cap");
  for (const rec of evicted) {
    assert.equal(rec.reason, "evicted_cap", "and still through the recorded discharge path, never a raw delete");
  }
});

test("ledger capacity: a flood cannot hide a circular wait from the deadlock detector", () => {
  // The regression that made this worth fixing. Under the old rule a flood
  // evicted the OLDEST asks first — exactly the ones most likely to be stuck —
  // so the ledger deleted the evidence of the deadlock it is supposed to
  // prove in O(V+E). Refusal-to-open makes the cycle's asks unreachable by
  // capacity pressure entirely.
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

  // Now flood the ledger well past capacity.
  for (let i = 0; i < MAX_PENDING_REQUESTS + 5; i++) {
    applyEvent(state, askEvent(`msg-flood-${i}`, "architect", ["dev"]));
  }

  assert.equal(state.pendingRequests.has("msg-cycle-a"), true, "the cycle's asks are untouched by the flood");
  assert.equal(state.pendingRequests.has("msg-cycle-b"), true);

  const after = detector.scan(state as never).filter((f) => f.kind === "wait_cycle");
  assert.equal(
    after.length,
    1,
    "the deadlock is STILL provable under capacity pressure — under eviction it vanished from the graph " +
      "precisely when the mesh was busiest, which is when it mattered most",
  );

  // And the pressure is still on the record, just attributed to the asks that
  // were refused rather than to the ones that were already owed.
  const refusals = state.discharged.filter((d) => d.reason === "refused_cap");
  assert.ok(refusals.length > 0, "the refusals are recorded, so capacity pressure stays explainable");
  assert.equal(
    state.discharged.some((d) => d.messageId === "msg-cycle-a" || d.messageId === "msg-cycle-b"),
    false,
    "and nothing that was already owed left the ledger at all",
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
