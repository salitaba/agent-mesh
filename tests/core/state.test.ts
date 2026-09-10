import { test } from "node:test";
import assert from "node:assert/strict";
import {
  approvalKey,
  artifactKey,
  createInitialState,
  dischargeCommitment,
  ensureBudget,
  evictOverflowingPendingRequests,
  exportState,
  getBudget,
  importState,
  INFERRED_DISCHARGE_REASONS,
  MAX_DISCHARGE_HISTORY,
  MAX_PENDING_REQUESTS,
  outstandingDebtors,
  PER_DEBTOR_DISCHARGE_REASONS,
  pushBounded,
  setBounded,
  stillOwes,
  UNANSWERED_DISCHARGE_REASONS,
  type PendingRequest,
  type Projections,
} from "../../packages/core/src/state";
import type {
  AgentMemoryNote,
  ApprovalRecord,
  Artifact,
  DecisionRecord,
  Escalation,
  Goal,
  MeshMessage,
  Task,
  Thread,
  WorkspaceLease,
} from "../../packages/protocol/src/index";

/**
 * Ledger-semantics tests for `state.ts`.
 *
 * These functions are pure and reachable directly, but were previously only
 * exercised incidentally through the supervisor, so the distinctions they
 * exist to make — one debtor answering vs the ask being settled, eviction vs
 * an answer, a snapshot roundtrip preserving Maps and Sets — had no direct
 * assertion.
 */

const AT = "2026-02-01T00:00:00.000Z";

let prSeq = 0;
function pending(over: Partial<PendingRequest> = {}): PendingRequest {
  prSeq++;
  return {
    messageId: over.messageId ?? `msg-${prSeq}`,
    from: over.from ?? "lead",
    to: over.to ?? ["dev", "qa", "security"],
    type: over.type ?? "REQUEST_REVIEW",
    threadId: over.threadId ?? "thr-1",
    createdAt: over.createdAt ?? AT,
    ...over,
  };
}

function seedPending(state: Projections, over: Partial<PendingRequest> = {}): PendingRequest {
  const pr = pending(over);
  state.pendingRequests.set(pr.messageId, pr);
  return pr;
}

function escalation(over: Partial<Escalation> & { id: string }): Escalation {
  return {
    goalId: "goal-1",
    reason: "stuck_request",
    detail: {},
    raisedBy: "system",
    status: "OPEN",
    createdAt: AT,
    ...over,
  } as Escalation;
}

// --- discharge reason sets -------------------------------------------------

test("per-debtor reasons are exactly the 'an agent responded' paths", () => {
  assert.deepEqual([...PER_DEBTOR_DISCHARGE_REASONS].sort(), ["artifact_review", "in_thread", "reply"]);
  // A reason cannot be both an exact signal and an inference.
  assert.equal(INFERRED_DISCHARGE_REASONS.has("reply"), false);
  assert.equal(INFERRED_DISCHARGE_REASONS.has("in_thread"), true);
  // Eviction and deadlock breaks are losses, not answers.
  assert.deepEqual([...UNANSWERED_DISCHARGE_REASONS].sort(), ["deadlock_break", "evicted_cap"]);
});

// --- dischargeCommitment ---------------------------------------------------

test("dischargeCommitment returns null for an unknown ask", () => {
  const state = createInitialState();
  assert.equal(dischargeCommitment(state, "nope", "reply", "dev", AT), null);
  assert.equal(state.discharged.length, 0);
});

test("one debtor replying settles only its own obligation", () => {
  const state = createInitialState();
  const pr = seedPending(state, { to: ["dev", "qa", "security"] });

  const rec = dischargeCommitment(state, pr.messageId, "reply", "dev", AT, "msg-answer");
  assert.ok(rec);
  assert.equal(rec.partial, true);
  assert.deepEqual(rec.remaining, ["qa", "security"]);
  assert.equal(rec.viaMessageId, "msg-answer");
  // The ask stays on the ledger, owed by the agents who said nothing.
  assert.equal(state.pendingRequests.has(pr.messageId), true);
  assert.deepEqual(outstandingDebtors(pr), ["qa", "security"]);
  assert.equal(stillOwes(pr, "dev"), false);
  assert.equal(stillOwes(pr, "qa"), true);
  // `to` is the address list and never shrinks.
  assert.deepEqual(pr.to, ["dev", "qa", "security"]);
});

test("the last debtor replying closes the ask", () => {
  const state = createInitialState();
  const pr = seedPending(state, { to: ["dev", "qa"] });

  dischargeCommitment(state, pr.messageId, "reply", "dev", AT);
  const final = dischargeCommitment(state, pr.messageId, "in_thread", "qa", AT);

  assert.ok(final);
  assert.equal(final.partial, undefined);
  assert.equal(state.pendingRequests.has(pr.messageId), false);
  assert.equal(state.discharged.length, 2);
});

test("a debtor replying twice settles nothing", () => {
  const state = createInitialState();
  const pr = seedPending(state, { to: ["dev", "qa"] });

  dischargeCommitment(state, pr.messageId, "reply", "dev", AT);
  const second = dischargeCommitment(state, pr.messageId, "reply", "dev", AT);

  // Without the guard this would fall through to the whole-ask path and
  // silently close qa's still-outstanding debt.
  assert.equal(second, null);
  assert.equal(state.pendingRequests.has(pr.messageId), true);
  assert.deepEqual(outstandingDebtors(pr), ["qa"]);
  assert.equal(state.discharged.length, 1);
});

test("a discharger who was never a debtor settles the whole ask", () => {
  const state = createInitialState();
  const pr = seedPending(state, { to: ["dev", "qa"] });

  // Deliberate asymmetry with the repeat-replier above: an outsider (operator
  // answering for a dead agent, or the runtime) resolves the ask itself.
  const rec = dischargeCommitment(state, pr.messageId, "reply", "operator-1", AT);

  assert.ok(rec);
  assert.equal(rec.partial, undefined);
  assert.equal(state.pendingRequests.has(pr.messageId), false);
});

test("a runtime-level reason settles the whole ask even from a debtor", () => {
  const state = createInitialState();
  const pr = seedPending(state, { to: ["dev", "qa", "security"] });

  const rec = dischargeCommitment(state, pr.messageId, "deadlock_break", "dev", AT);

  assert.ok(rec);
  assert.equal(rec.partial, undefined);
  assert.deepEqual(rec.to, ["dev", "qa", "security"]);
  assert.equal(state.pendingRequests.has(pr.messageId), false);
});

test("legacy entries without `outstanding` fall back to `to`", () => {
  const state = createInitialState();
  const pr = seedPending(state, { to: ["dev", "qa"] });
  delete pr.outstanding;

  assert.deepEqual(outstandingDebtors(pr), ["dev", "qa"]);
  assert.equal(stillOwes(pr, "qa"), true);
  assert.equal(stillOwes(pr, "ghost"), false);

  const rec = dischargeCommitment(state, pr.messageId, "reply", "dev", AT);
  assert.ok(rec);
  assert.equal(rec.partial, true);
  assert.deepEqual(rec.remaining, ["qa"]);
});

test("a single-debtor ask closes on the first reply", () => {
  const state = createInitialState();
  const pr = seedPending(state, { to: ["dev"] });

  const rec = dischargeCommitment(state, pr.messageId, "artifact_review", "dev", AT);

  assert.ok(rec);
  assert.equal(rec.partial, undefined);
  assert.equal(state.pendingRequests.size, 0);
});

test("discharge history is bounded", () => {
  const state = createInitialState();
  for (let i = 0; i < MAX_DISCHARGE_HISTORY + 25; i++) {
    const pr = seedPending(state, { messageId: `bulk-${i}`, to: ["dev"] });
    dischargeCommitment(state, pr.messageId, "operator", "operator-1", AT);
  }
  assert.equal(state.discharged.length, MAX_DISCHARGE_HISTORY);
  // Oldest-first eviction: the newest record survives.
  assert.equal(state.discharged[state.discharged.length - 1]?.messageId, `bulk-${MAX_DISCHARGE_HISTORY + 24}`);
});

// --- eviction --------------------------------------------------------------

test("no eviction while under cap", () => {
  const state = createInitialState();
  seedPending(state);
  assert.deepEqual(evictOverflowingPendingRequests(state, AT), []);
  assert.equal(state.pendingRequests.size, 1);
});

test("overflow evicts oldest-first and records it as unanswered", () => {
  const state = createInitialState();
  for (let i = 0; i < MAX_PENDING_REQUESTS + 3; i++) {
    seedPending(state, { messageId: `over-${i}`, to: ["dev"] });
  }

  const evicted = evictOverflowingPendingRequests(state, AT);

  assert.equal(evicted.length, 3);
  assert.deepEqual(evicted.map((e) => e.messageId), ["over-0", "over-1", "over-2"]);
  assert.equal(state.pendingRequests.size, MAX_PENDING_REQUESTS);
  for (const rec of evicted) {
    assert.equal(rec.reason, "evicted_cap");
    assert.equal(rec.by, "system");
    // Consumers must be able to tell this apart from an answer.
    assert.equal(UNANSWERED_DISCHARGE_REASONS.has(rec.reason), true);
  }
});

test("asks an OPEN escalation points at are never evicted", () => {
  const state = createInitialState();
  for (let i = 0; i < MAX_PENDING_REQUESTS + 2; i++) {
    seedPending(state, { messageId: `prot-${i}`, to: ["dev"] });
  }
  // Both ways an escalation can name an ask.
  state.escalations.set("esc-detail", escalation({ id: "esc-detail", detail: { requestMessageId: "prot-0" } }));
  state.escalations.set("esc-key", escalation({ id: "esc-key", conflictKey: "stuck:prot-1:dev" }));

  const evicted = evictOverflowingPendingRequests(state, AT);

  assert.deepEqual(evicted.map((e) => e.messageId), ["prot-2", "prot-3"]);
  assert.equal(state.pendingRequests.has("prot-0"), true);
  assert.equal(state.pendingRequests.has("prot-1"), true);
});

test("a closed escalation no longer protects its ask", () => {
  const state = createInitialState();
  for (let i = 0; i < MAX_PENDING_REQUESTS + 1; i++) {
    seedPending(state, { messageId: `closed-${i}`, to: ["dev"] });
  }
  state.escalations.set(
    "esc-done",
    escalation({ id: "esc-done", status: "RESPONDED", detail: { requestMessageId: "closed-0" } }),
  );

  const evicted = evictOverflowingPendingRequests(state, AT);

  assert.deepEqual(evicted.map((e) => e.messageId), ["closed-0"]);
});

test("the ledger stays over cap rather than dropping an escalated ask", () => {
  const state = createInitialState();
  for (let i = 0; i < MAX_PENDING_REQUESTS + 2; i++) {
    seedPending(state, { messageId: `all-${i}`, to: ["dev"] });
    state.escalations.set(`esc-${i}`, escalation({ id: `esc-${i}`, detail: { requestMessageId: `all-${i}` } }));
  }

  const evicted = evictOverflowingPendingRequests(state, AT);

  assert.deepEqual(evicted, []);
  assert.equal(state.pendingRequests.size, MAX_PENDING_REQUESTS + 2);
});

// --- bounded helpers -------------------------------------------------------

test("pushBounded keeps the newest `max` items", () => {
  const arr: number[] = [];
  for (let i = 0; i < 5; i++) pushBounded(arr, i, 3);
  assert.deepEqual(arr, [2, 3, 4]);
  // Returns the same array it mutated.
  assert.equal(pushBounded(arr, 9, 3), arr);
  assert.deepEqual(arr, [3, 4, 9]);
});

test("setBounded evicts the oldest key only when inserting a new one", () => {
  const map = new Map<string, number>();
  setBounded(map, "a", 1, 2);
  setBounded(map, "b", 2, 2);
  // Overwriting an existing key must not evict.
  setBounded(map, "a", 10, 2);
  assert.deepEqual([...map], [["a", 10], ["b", 2]]);

  setBounded(map, "c", 3, 2);
  assert.deepEqual([...map], [["b", 2], ["c", 3]]);
});

// --- budgets / keys --------------------------------------------------------

test("ensureBudget creates once, then only fills in a missing limit", () => {
  const state = createInitialState();
  assert.equal(getBudget(state, "agent:dev"), undefined);

  const created = ensureBudget(state, "agent:dev", "tokens", null);
  assert.equal(created.limit, null);
  assert.equal(created.reserved, 0);

  // A later event that knows the limit fills it in, in place.
  const filled = ensureBudget(state, "agent:dev", "tokens", 500);
  assert.equal(filled, created);
  assert.equal(filled.limit, 500);

  // An existing non-null limit is never overwritten.
  assert.equal(ensureBudget(state, "agent:dev", "tokens", 9).limit, 500);
  assert.equal(getBudget(state, "agent:dev"), created);
});

test("composite keys are stable and unambiguous", () => {
  assert.equal(artifactKey("code", "api.ts"), "code:api.ts");
  assert.equal(approvalKey("art-1", "accept"), "art-1::accept");
});

// --- snapshot roundtrip ----------------------------------------------------

function populate(state: Projections): void {
  state.goals.set("goal-1", { id: "goal-1", description: "ship it", status: "ACTIVE" } as Goal);
  state.activeGoalId = "goal-1";
  state.agents.set("dev", {
    definition: { id: "dev", role: "developer" } as never,
    state: { status: "IDLE" } as never,
  });
  const art = { id: "art-1", name: "api.ts", type: "code", version: 2 } as unknown as Artifact;
  state.artifacts.set("art-1", art);
  state.artifactByName.set(artifactKey("code", "api.ts"), art);
  state.artifactHistory.set("art-1", [art]);
  state.threads.set("thr-1", { id: "thr-1", goalId: "goal-1" } as Thread);
  state.messages.set("m-1", { id: "m-1", from: "dev", to: ["qa"] } as MeshMessage);
  state.tasks.set("task-1", { id: "task-1", goalId: "goal-1", title: "t" } as Task);
  state.decisions.set("dec-1", { id: "dec-1", topic: "db" } as DecisionRecord);
  state.approvals.set(approvalKey("art-1", "accept"), [
    { id: "ap-1", subject: "art-1", kind: "accept" } as ApprovalRecord,
  ]);
  state.escalations.set("esc-1", escalation({ id: "esc-1" }));
  const ledger = ensureBudget(state, "agent:dev", "tokens", 1000);
  ledger.consumed = 120;
  ledger.reservations.set("turn-1", 40);
  state.leases.set("lease-1", { id: "lease-1", artifactId: "art-1", agentId: "dev" } as WorkspaceLease);
  state.memory.set("dev", new Map([["style", { agentId: "dev", key: "style", value: "terse" } as AgentMemoryNote]]));
  state.pendingRequests.set("msg-1", pending({ messageId: "msg-1", to: ["dev", "qa"], outstanding: ["qa"] }));
  state.discharged.push({ messageId: "msg-0", from: "lead", to: ["dev"], type: "REQUEST_REVIEW", reason: "reply", by: "dev", at: AT });
  state.reviewRounds.set("art-1", 3);
  state.conflicts.set("c-1", { key: "c-1", count: 2, lastActor: "dev", firstAt: AT, lastAt: AT });
  state.modelSpend.set("m-big", {
    model: "m-big",
    tokens: 900,
    input: 600,
    output: 300,
    cacheRead: 50,
    turns: 4,
    agents: new Set(["dev", "qa"]),
  });
  state.eventCount = 42;
  state.lastEventSeq = 77;
}

test("exportState -> importState roundtrips Maps and Sets through JSON", () => {
  const source = createInitialState();
  populate(source);

  // The snapshot store writes JSON, so the roundtrip must survive it.
  const snapshot = JSON.parse(JSON.stringify(exportState(source))) as Parameters<typeof importState>[1];
  const restored = createInitialState();
  importState(restored, snapshot);

  assert.equal(restored.activeGoalId, "goal-1");
  assert.equal(restored.goals.get("goal-1")?.description, "ship it");
  assert.equal(restored.agents.get("dev")?.definition.id, "dev");
  assert.equal(restored.threads.get("thr-1")?.id, "thr-1");
  assert.equal(restored.messages.get("m-1")?.from, "dev");
  assert.equal(restored.tasks.get("task-1")?.title, "t");
  assert.equal(restored.decisions.get("dec-1")?.topic, "db");
  assert.equal(restored.escalations.get("esc-1")?.status, "OPEN");
  assert.equal(restored.leases.get("lease-1")?.agentId, "dev");
  assert.equal(restored.reviewRounds.get("art-1"), 3);
  assert.equal(restored.conflicts.get("c-1")?.count, 2);
  assert.equal(restored.discharged.length, 1);
  assert.equal(restored.eventCount, 42);
  assert.equal(restored.lastEventSeq, 77);

  // Artifacts rebuild all three indexes from the single exported list.
  assert.equal(restored.artifacts.get("art-1")?.name, "api.ts");
  assert.equal(restored.artifactByName.get(artifactKey("code", "api.ts"))?.id, "art-1");
  assert.deepEqual(restored.artifactHistory.get("art-1")?.map((a) => a.id), ["art-1"]);

  // Approvals are keyed off the first record of each exported list.
  assert.equal(restored.approvals.get(approvalKey("art-1", "accept"))?.length, 1);

  // Nested collections: budget reservations is a Map, memory a Map of Maps.
  const budget = restored.budgets.get("agent:dev");
  assert.ok(budget);
  assert.equal(budget.reservations instanceof Map, true);
  assert.equal(budget.reservations.get("turn-1"), 40);
  assert.equal(budget.consumed, 120);
  assert.equal(restored.memory.get("dev")?.get("style")?.value, "terse");

  // Per-debtor tracking must survive, or a restored mesh renudges an agent
  // that already answered.
  const pr = restored.pendingRequests.get("msg-1");
  assert.ok(pr);
  assert.deepEqual(outstandingDebtors(pr), ["qa"]);
  assert.equal(stillOwes(pr, "dev"), false);

  // Sets do not survive JSON; modelSpend.agents is rehydrated explicitly.
  const spend = restored.modelSpend.get("m-big");
  assert.ok(spend);
  assert.equal(spend.agents instanceof Set, true);
  assert.deepEqual([...spend.agents].sort(), ["dev", "qa"]);
  assert.equal(spend.cacheRead, 50);
});

test("importState clears prior state before loading", () => {
  const state = createInitialState();
  populate(state);

  importState(state, {});

  assert.equal(state.goals.size, 0);
  assert.equal(state.agents.size, 0);
  assert.equal(state.artifacts.size, 0);
  assert.equal(state.budgets.size, 0);
  assert.equal(state.pendingRequests.size, 0);
  assert.equal(state.modelSpend.size, 0);
  assert.equal(state.discharged.length, 0);
  // Absent counters keep their fresh values rather than becoming NaN.
  assert.equal(state.eventCount, 0);
  assert.equal(state.lastEventSeq, 0);
  // An absent activeGoalId must not resurrect the old one.
  assert.equal(state.activeGoalId, null);
});

test("importState ignores unusable scalars and nameless model spend", () => {
  const state = createInitialState();
  importState(state, {
    activeGoalId: "",
    eventCount: Number.NaN,
    modelSpend: [{ model: "", tokens: 10 }, { tokens: 5 }, { model: "ok" }],
  });

  assert.equal(state.activeGoalId, null);
  assert.equal(state.eventCount, 0);
  // Spend that cannot be attributed to a model is dropped, not bucketed
  // under "".
  assert.deepEqual([...state.modelSpend.keys()], ["ok"]);
  const ok = state.modelSpend.get("ok");
  assert.ok(ok);
  assert.equal(ok.tokens, 0);
  assert.equal(ok.turns, 0);
  assert.equal(ok.agents.size, 0);
});

test("exportState caps the message tail it snapshots", () => {
  const state = createInitialState();
  for (let i = 0; i < 2100; i++) state.messages.set(`m-${i}`, { id: `m-${i}` } as MeshMessage);

  const snapshot = exportState(state);

  assert.equal(snapshot.messages.length, 2000);
  // Newest kept, oldest dropped.
  assert.equal((snapshot.messages[0] as MeshMessage).id, "m-100");
  assert.equal((snapshot.messages[1999] as MeshMessage).id, "m-2099");
});

test("an empty snapshot exports empty collections, not undefined", () => {
  const snapshot = exportState(createInitialState());
  assert.deepEqual(snapshot.goals, []);
  assert.equal(snapshot.activeGoalId, null);
  assert.deepEqual(snapshot.budgets, []);
  assert.deepEqual(snapshot.memory, []);
  assert.equal(snapshot.eventCount, 0);
  assert.equal(snapshot.throughSeq, 0);
});
