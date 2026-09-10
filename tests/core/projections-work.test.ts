import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEvent, ProjectionError } from "../../packages/core/src/projections";
import { applyWorkEvent } from "../../packages/core/src/projections-work";
import {
  gateSatisfiedWithConfig,
  hasApproval,
  isTerminalGoal,
  pendingTargetsArtifact,
} from "../../packages/core/src/projections-helpers";
import {
  approvalKey,
  createInitialState,
  type AgentRecord,
  type PendingRequest,
  type Projections,
} from "../../packages/core/src/state";
import {
  PROTOCOL_VERSION,
  type AgentDefinition,
  type AgentRuntimeState,
  type ApprovalRecord,
  type Artifact,
  type ArtifactRef,
  type DecisionRecord,
  type Escalation,
  type GoalStatus,
  type MeshEvent,
  type MeshMessage,
  type Task,
} from "../../packages/protocol/src/index";

/**
 * Work-projection tests: tasks, decisions and escalations.
 *
 * `applyWorkEvent` is reached through `applyEvent`'s dispatch chain, so the
 * end-to-end suites covered the happy paths incidentally and left the
 * distinctions the reducer exists to make unasserted — claiming an already
 * claimed task vs a sanctioned reassignment, unclaiming vs completing, and
 * (crucially for the audit trail) a human-RESPONDED escalation vs one the
 * runtime AUTO_RESOLVED on its own.
 *
 * The `projections-helpers` cases at the bottom cover the approval lookups
 * the artifact gates depend on, which had the same problem.
 */

const GOAL_ID = "goal-work";

let seq = 0;
function evt(type: string, payload: Record<string, unknown>, over: Partial<MeshEvent> = {}): MeshEvent {
  seq++;
  return {
    id: over.id ?? `evt-work-${seq}`,
    protocolVersion: PROTOCOL_VERSION,
    type: type as MeshEvent["type"],
    timestamp: over.timestamp ?? `2026-03-01T00:00:${String(seq % 60).padStart(2, "0")}.000Z`,
    goalId: over.goalId ?? GOAL_ID,
    actorId: over.actorId,
    seq,
    payload,
  } as MeshEvent;
}

function task(over: Partial<Task> & { id: string }): Task {
  return {
    goalId: GOAL_ID,
    title: "wire the adapter",
    description: "",
    createdBy: "lead",
    status: "OPEN",
    requiredCapabilities: [],
    artifactRefs: [],
    delegationDepth: 0,
    budget: {},
    createdAt: "2026-03-01T00:00:00.000Z",
    ...over,
  } as Task;
}

function decision(over: Partial<DecisionRecord> & { id: string }): DecisionRecord {
  return {
    goalId: GOAL_ID,
    topic: "datastore",
    decision: { choice: "sqlite" },
    status: "PROPOSED",
    proposedBy: "architect",
    approvedBy: [],
    evidence: [],
    createdAt: "2026-03-01T00:00:00.000Z",
    ...over,
  } as DecisionRecord;
}

function escalation(over: Partial<Escalation> & { id: string }): Escalation {
  return {
    goalId: GOAL_ID,
    reason: "budget_exhausted",
    detail: {},
    raisedBy: "system",
    status: "OPEN",
    createdAt: "2026-03-01T00:00:00.000Z",
    ...over,
  } as Escalation;
}

function seedAgent(state: Projections, agentId: string, activeTaskId?: string): AgentRecord {
  const rec: AgentRecord = {
    definition: { id: agentId } as AgentDefinition,
    state: {
      agentId,
      lifecycle: "IDLE",
      mailboxDepth: 0,
      activeTaskId,
      currentArtifactIds: [],
      tokensConsumed: 0,
      activations: 0,
      lastActivityAt: "2026-03-01T00:00:00.000Z",
    } as AgentRuntimeState,
  };
  state.agents.set(agentId, rec);
  return rec;
}

function seedPending(state: Projections, over: Partial<PendingRequest> & { messageId: string }): PendingRequest {
  const pr: PendingRequest = {
    from: "lead",
    to: ["dev"],
    type: "REQUEST_REVIEW",
    threadId: "thr-1",
    createdAt: "2026-03-01T00:00:00.000Z",
    ...over,
  } as PendingRequest;
  state.pendingRequests.set(pr.messageId, pr);
  return pr;
}

// --- tasks ------------------------------------------------------------------

test("task.created stores the task verbatim under its id", () => {
  const state = createInitialState();
  applyEvent(state, evt("task.created", { task: task({ id: "t-1" }) }));
  assert.equal(state.tasks.get("t-1")?.title, "wire the adapter");
  assert.equal(state.tasks.get("t-1")?.status, "OPEN");
});

test("task.claimed for an unknown task is ignored rather than throwing", () => {
  const state = createInitialState();
  applyEvent(state, evt("task.claimed", { taskId: "t-missing", agentId: "dev" }));
  assert.equal(state.tasks.size, 0);
});

test("task.claimed assigns the claimant and points the agent at the task", () => {
  const state = createInitialState();
  state.tasks.set("t-1", task({ id: "t-1" }));
  const rec = seedAgent(state, "dev");
  applyEvent(state, evt("task.claimed", { taskId: "t-1", agentId: "dev" }));
  const t = state.tasks.get("t-1")!;
  assert.equal(t.status, "CLAIMED");
  assert.equal(t.claimedBy, "dev");
  assert.equal(t.assignedTo, "dev");
  assert.equal(rec.state.activeTaskId, "t-1");
});

test("task.claimed by an agent with no record still updates the task", () => {
  const state = createInitialState();
  state.tasks.set("t-1", task({ id: "t-1" }));
  applyEvent(state, evt("task.claimed", { taskId: "t-1", agentId: "ghost" }));
  assert.equal(state.tasks.get("t-1")?.claimedBy, "ghost");
});

test("task.claimed with a null agent releases the task back to OPEN", () => {
  const state = createInitialState();
  state.tasks.set("t-1", task({ id: "t-1", status: "CLAIMED", claimedBy: "dev", assignedTo: "dev" }));
  applyEvent(state, evt("task.claimed", { taskId: "t-1", agentId: null }));
  const t = state.tasks.get("t-1")!;
  assert.equal(t.status, "OPEN");
  assert.equal(t.claimedBy, undefined);
  // assignedTo is intentionally left: the task stays earmarked for that agent.
  assert.equal(t.assignedTo, "dev");
});

test("claiming an already claimed task is rejected as a projection error", () => {
  const state = createInitialState();
  state.tasks.set("t-1", task({ id: "t-1", status: "CLAIMED", claimedBy: "dev" }));
  assert.throws(
    () => applyEvent(state, evt("task.claimed", { taskId: "t-1", agentId: "qa" })),
    (err: unknown) => err instanceof ProjectionError && /already CLAIMED/.test((err as Error).message),
  );
  assert.equal(state.tasks.get("t-1")?.claimedBy, "dev");
});

test("reassign:true overrides the already-claimed guard", () => {
  const state = createInitialState();
  state.tasks.set("t-1", task({ id: "t-1", status: "CLAIMED", claimedBy: "dev" }));
  applyEvent(state, evt("task.claimed", { taskId: "t-1", agentId: "qa", reassign: true }));
  assert.equal(state.tasks.get("t-1")?.claimedBy, "qa");
});

test("task.completed clears the claimant's active task and marks completion time", () => {
  const state = createInitialState();
  state.tasks.set("t-1", task({ id: "t-1", status: "CLAIMED", claimedBy: "dev" }));
  const rec = seedAgent(state, "dev", "t-1");
  const e = evt("task.completed", { taskId: "t-1", agentId: "dev" });
  applyEvent(state, e);
  const t = state.tasks.get("t-1")!;
  assert.equal(t.status, "COMPLETED");
  assert.equal(t.completedAt, e.timestamp);
  assert.equal(rec.state.activeTaskId, undefined);
});

test("task.completed falls back to claimedBy when the payload omits the agent", () => {
  const state = createInitialState();
  state.tasks.set("t-1", task({ id: "t-1", status: "CLAIMED", claimedBy: "dev" }));
  const rec = seedAgent(state, "dev", "t-1");
  applyEvent(state, evt("task.completed", { taskId: "t-1" }));
  assert.equal(rec.state.activeTaskId, undefined);
});

test("task.completed leaves an agent busy on a different task alone", () => {
  const state = createInitialState();
  state.tasks.set("t-1", task({ id: "t-1", status: "CLAIMED", claimedBy: "dev" }));
  const rec = seedAgent(state, "dev", "t-2");
  applyEvent(state, evt("task.completed", { taskId: "t-1", agentId: "dev" }));
  assert.equal(rec.state.activeTaskId, "t-2");
});

test("task.completed discharges the asks that were waiting on that task", () => {
  const state = createInitialState();
  state.tasks.set("t-1", task({ id: "t-1", status: "CLAIMED", claimedBy: "dev" }));
  seedPending(state, { messageId: "m-1", taskId: "t-1" });
  seedPending(state, { messageId: "m-2", taskId: "t-other" });
  applyEvent(state, evt("task.completed", { taskId: "t-1", agentId: "dev" }));
  assert.equal(state.pendingRequests.has("m-1"), false);
  assert.equal(state.pendingRequests.has("m-2"), true);
  assert.equal(state.discharged.at(-1)?.reason, "task_completed");
});

test("task.completed for an unknown task still discharges asks pointing at it", () => {
  const state = createInitialState();
  seedPending(state, { messageId: "m-1", taskId: "t-gone" });
  applyEvent(state, evt("task.completed", { taskId: "t-gone" }));
  assert.equal(state.pendingRequests.has("m-1"), false);
});

// --- decisions --------------------------------------------------------------

test("decision.proposed stores the record under its own id", () => {
  const state = createInitialState();
  applyEvent(state, evt("decision.proposed", { decision: decision({ id: "d-1" }) }));
  assert.equal(state.decisions.get("d-1")?.status, "PROPOSED");
  assert.equal(state.decisions.get("d-1")?.topic, "datastore");
});

test("decision.ratified stamps RATIFIED and the ratification time", () => {
  const state = createInitialState();
  state.decisions.set("d-1", decision({ id: "d-1" }));
  const e = evt("decision.ratified", { decisionId: "d-1" });
  applyEvent(state, e);
  const d = state.decisions.get("d-1")!;
  assert.equal(d.status, "RATIFIED");
  assert.equal(d.ratifiedAt, e.timestamp);
});

test("decision.ratified unions approvers instead of replacing them", () => {
  const state = createInitialState();
  state.decisions.set("d-1", decision({ id: "d-1", approvedBy: ["architect"] }));
  applyEvent(state, evt("decision.ratified", { decisionId: "d-1", approvedBy: ["qa", "architect"] }));
  assert.deepEqual(state.decisions.get("d-1")?.approvedBy, ["architect", "qa"]);
});

test("decision.ratified appends the ratifying evidence to what was already there", () => {
  const state = createInitialState();
  state.decisions.set("d-1", decision({ id: "d-1", evidence: [{ uri: "artifact://spec@1" }] }));
  applyEvent(state, evt("decision.ratified", { decisionId: "d-1", evidence: [{ uri: "artifact://bench@2" }] }));
  const evidence = state.decisions.get("d-1")!.evidence;
  assert.deepEqual(evidence.map((r) => r.uri).sort(), ["artifact://bench@2", "artifact://spec@1"]);
});

/**
 * The reducer unions evidence through a `Set`, which dedupes by object
 * identity — and `applyEvent` structuredClones the payload, so a ref that is
 * merely *equal* to a stored one arrives as a fresh object and is appended
 * again. Pinning this because the `Set` reads as value-dedupe at a glance:
 * evidence lists can carry duplicate URIs, and consumers must not assume
 * otherwise.
 */
test("evidence union dedupes by identity, so an equal-but-cloned ref is appended twice", () => {
  const state = createInitialState();
  const ref: ArtifactRef = { uri: "artifact://spec@1" };
  state.decisions.set("d-1", decision({ id: "d-1", evidence: [ref] }));
  applyEvent(state, evt("decision.ratified", { decisionId: "d-1", evidence: [ref] }));
  const evidence = state.decisions.get("d-1")!.evidence;
  assert.equal(evidence.length, 2);
  assert.deepEqual(evidence.map((r) => r.uri), ["artifact://spec@1", "artifact://spec@1"]);
});

test("decision.ratified without approvedBy or evidence leaves both untouched", () => {
  const state = createInitialState();
  state.decisions.set("d-1", decision({ id: "d-1", approvedBy: ["architect"], evidence: [{ uri: "artifact://spec@1" }] }));
  applyEvent(state, evt("decision.ratified", { decisionId: "d-1" }));
  const d = state.decisions.get("d-1")!;
  assert.deepEqual(d.approvedBy, ["architect"]);
  assert.equal(d.evidence.length, 1);
});

test("decision.ratified for an unknown decision is ignored", () => {
  const state = createInitialState();
  applyEvent(state, evt("decision.ratified", { decisionId: "d-missing" }));
  assert.equal(state.decisions.size, 0);
});

// --- escalations ------------------------------------------------------------

test("escalation.requested stores the card under its own id", () => {
  const state = createInitialState();
  applyEvent(state, evt("escalation.requested", { escalation: escalation({ id: "esc-1" }) }));
  assert.equal(state.escalations.get("esc-1")?.status, "OPEN");
  assert.equal(state.escalations.get("esc-1")?.reason, "budget_exhausted");
});

test("escalation.responded records the operator answer and when it landed", () => {
  const state = createInitialState();
  state.escalations.set("esc-1", escalation({ id: "esc-1" }));
  const e = evt("escalation.responded", { escalationId: "esc-1", response: "raise the cap" });
  applyEvent(state, e);
  const esc = state.escalations.get("esc-1")!;
  assert.equal(esc.status, "RESPONDED");
  assert.equal(esc.response, "raise the cap");
  assert.equal(esc.respondedAt, e.timestamp);
});

test("escalation.responded for an unknown card is ignored", () => {
  const state = createInitialState();
  applyEvent(state, evt("escalation.responded", { escalationId: "esc-missing", response: "x" }));
  assert.equal(state.escalations.size, 0);
});

test("auto-resolution is recorded as AUTO_RESOLVED, never as an operator answer", () => {
  const state = createInitialState();
  state.escalations.set("esc-1", escalation({ id: "esc-1", kind: "derived", supports: ["esc-0"] }));
  const e = evt("escalation.auto_resolved", { escalationId: "esc-1", reason: "all supports closed" });
  applyEvent(state, e);
  const esc = state.escalations.get("esc-1")!;
  assert.equal(esc.status, "AUTO_RESOLVED");
  assert.equal(esc.response, "all supports closed");
  assert.equal(esc.respondedAt, e.timestamp);
});

test("auto-resolution cannot overwrite a card a human already answered", () => {
  const state = createInitialState();
  state.escalations.set(
    "esc-1",
    escalation({ id: "esc-1", status: "RESPONDED", response: "operator said continue", respondedAt: "2026-03-01T09:00:00.000Z" }),
  );
  applyEvent(state, evt("escalation.auto_resolved", { escalationId: "esc-1", reason: "supports closed" }));
  const esc = state.escalations.get("esc-1")!;
  assert.equal(esc.status, "RESPONDED");
  assert.equal(esc.response, "operator said continue");
});

test("escalation.auto_resolved for an unknown card is ignored", () => {
  const state = createInitialState();
  applyEvent(state, evt("escalation.auto_resolved", { escalationId: "esc-missing", reason: "x" }));
  assert.equal(state.escalations.size, 0);
});

// --- dispatch contract ------------------------------------------------------

test("human.input is claimed by the work reducer but changes nothing", () => {
  const state = createInitialState();
  const before = state.eventCount;
  assert.equal(applyWorkEvent(state, evt("human.input", { text: "go on" }), { text: "go on" }), true);
  assert.equal(state.eventCount, before);
});

test("applyWorkEvent declines event types it does not own", () => {
  const state = createInitialState();
  assert.equal(applyWorkEvent(state, evt("goal.created", {}), {}), false);
});

// --- projections-helpers: approval lookups ----------------------------------

let aprSeq = 0;
function approval(over: Partial<ApprovalRecord> & { kind: ApprovalRecord["kind"] }): ApprovalRecord {
  aprSeq++;
  return {
    id: over.id ?? `apr-${aprSeq}`,
    goalId: GOAL_ID,
    subject: over.subject ?? "artifact:art-1",
    actorId: over.actorId ?? "qa",
    actorRole: over.actorRole ?? "",
    evidenceEventId: `evt-${aprSeq}`,
    recordedAt: over.recordedAt ?? `2026-03-01T01:0${aprSeq % 10}:00.000Z`,
    ...over,
  } as ApprovalRecord;
}

function seedApproval(state: Projections, subject: string, kind: string, rec: ApprovalRecord): void {
  const key = approvalKey(subject, kind);
  const list = state.approvals.get(key) ?? [];
  list.push(rec);
  state.approvals.set(key, list);
}

test("hasApproval is false when nothing was ever recorded for the subject", () => {
  const state = createInitialState();
  assert.equal(hasApproval(state, "artifact:art-1", "approve"), false);
});

test("hasApproval is false when the key exists but the list is empty", () => {
  const state = createInitialState();
  state.approvals.set(approvalKey("artifact:art-1", "approve"), []);
  assert.equal(hasApproval(state, "artifact:art-1", "approve"), false);
});

test("hasApproval without an actor asks only whether anyone approved", () => {
  const state = createInitialState();
  seedApproval(state, "artifact:art-1", "approve", approval({ kind: "approve", actorId: "qa" }));
  assert.equal(hasApproval(state, "artifact:art-1", "approve"), true);
});

test("hasApproval matches the named actor by id or by role", () => {
  const state = createInitialState();
  seedApproval(state, "artifact:art-1", "approve", approval({ kind: "approve", actorId: "qa-1", actorRole: "qa" }));
  assert.equal(hasApproval(state, "artifact:art-1", "approve", "qa-1"), true);
  assert.equal(hasApproval(state, "artifact:art-1", "approve", "qa"), true);
  assert.equal(hasApproval(state, "artifact:art-1", "approve", "security"), false);
});

test("hasApproval keys on the kind, so an approve does not answer a merge", () => {
  const state = createInitialState();
  seedApproval(state, "artifact:art-1", "approve", approval({ kind: "approve" }));
  assert.equal(hasApproval(state, "artifact:art-1", "merge"), false);
});

// --- projections-helpers: merge gate vs a block ------------------------------

function artifact(over: Partial<Artifact> = {}): Artifact {
  return {
    id: "art-1",
    name: "adapter patch",
    type: "CodePatch",
    goalId: GOAL_ID,
    owner: "dev",
    version: 1,
    status: "APPROVED",
    ...over,
  } as unknown as Artifact;
}

test("a merge is refused while the newest verdict on the artifact is a block", () => {
  const state = createInitialState();
  seedApproval(state, "artifact:art-1", "approve", approval({ kind: "approve", artifactId: "art-1", recordedAt: "2026-03-01T01:00:00.000Z" }));
  seedApproval(state, "artifact:art-1", "block", approval({ kind: "block", artifactId: "art-1", recordedAt: "2026-03-01T02:00:00.000Z" }));
  assert.equal(gateSatisfiedWithConfig(state, artifact(), "MERGED", true), false);
});

test("a later approve supersedes the block and reopens the merge", () => {
  const state = createInitialState();
  seedApproval(state, "artifact:art-1", "block", approval({ kind: "block", artifactId: "art-1", recordedAt: "2026-03-01T01:00:00.000Z" }));
  seedApproval(state, "artifact:art-1", "approve", approval({ kind: "approve", artifactId: "art-1", recordedAt: "2026-03-01T02:00:00.000Z" }));
  assert.equal(gateSatisfiedWithConfig(state, artifact(), "MERGED", true), true);
});

test("a block with no approve at all keeps the merge shut", () => {
  const state = createInitialState();
  seedApproval(state, "artifact:art-1", "block", approval({ kind: "block", artifactId: "art-1" }));
  assert.equal(gateSatisfiedWithConfig(state, artifact(), "MERGED", true), false);
});

test("a block recorded against a different artifact does not shut this merge", () => {
  const state = createInitialState();
  seedApproval(state, "artifact:art-2", "block", approval({ kind: "block", artifactId: "art-2" }));
  assert.equal(gateSatisfiedWithConfig(state, artifact(), "MERGED", true), true);
});

// --- projections-helpers: does a pending review target this artifact? --------

test("a pending review matches an artifact by its exact contentRef", () => {
  const state = createInitialState();
  state.artifacts.set("art-1", artifact({ contentRef: "content://sha-abc" }));
  const pr = { messageId: "m-1", artifactUris: ["content://sha-abc"] };
  assert.equal(pendingTargetsArtifact(state, pr, "art-1"), true);
});

test("a pending review matches any version under the artifact's uri prefix", () => {
  const state = createInitialState();
  state.artifacts.set("art-1", artifact({ contentRef: "content://sha-abc" }));
  const pr = { messageId: "m-1", artifactUris: ["artifact://CodePatch/adapter patch/3"] };
  assert.equal(pendingTargetsArtifact(state, pr, "art-1"), true);
});

test("a pending review falls back to the artifact id embedded in the uri", () => {
  const state = createInitialState();
  state.artifacts.set("art-1", artifact({ contentRef: "content://sha-abc" }));
  const pr = { messageId: "m-1", artifactUris: ["urn:some:other:scheme:art-1"] };
  assert.equal(pendingTargetsArtifact(state, pr, "art-1"), true);
});

test("a pending review falls back to the url-encoded artifact name", () => {
  const state = createInitialState();
  state.artifacts.set("art-1", artifact({ contentRef: "content://sha-abc" }));
  const pr = { messageId: "m-1", artifactUris: ["urn:x:adapter%20patch"] };
  assert.equal(pendingTargetsArtifact(state, pr, "art-1"), true);
});

test("a pending review pointing somewhere else does not match", () => {
  const state = createInitialState();
  state.artifacts.set("art-1", artifact({ contentRef: "content://sha-abc" }));
  const pr = { messageId: "m-1", artifactUris: ["artifact://Spec/unrelated/1"] };
  assert.equal(pendingTargetsArtifact(state, pr, "art-1"), false);
});

test("an unknown artifact still matches on a raw id substring, so pendings cannot leak forever", () => {
  const state = createInitialState();
  const pr = { messageId: "m-1", artifactUris: ["artifact://CodePatch/gone/1#art-gone"] };
  assert.equal(pendingTargetsArtifact(state, pr, "art-gone"), true);
  assert.equal(pendingTargetsArtifact(state, pr, "art-other"), false);
});

test("a pending with no stored uris falls back to the original message's refs", () => {
  const state = createInitialState();
  state.artifacts.set("art-1", artifact({ contentRef: "content://sha-abc" }));
  state.messages.set("m-1", { id: "m-1", artifactRefs: [{ uri: "content://sha-abc" }] } as unknown as MeshMessage);
  assert.equal(pendingTargetsArtifact(state, { messageId: "m-1" }, "art-1"), true);
});

test("a pending with neither stored uris nor a known message matches nothing", () => {
  const state = createInitialState();
  state.artifacts.set("art-1", artifact({ contentRef: "content://sha-abc" }));
  assert.equal(pendingTargetsArtifact(state, { messageId: "m-gone" }, "art-1"), false);
});

// --- projections-helpers: terminal goal --------------------------------------

test("only COMPLETED and FAILED count as terminal goal statuses", () => {
  const terminal: GoalStatus[] = ["COMPLETED", "FAILED"];
  const live: GoalStatus[] = ["CREATED", "ACTIVE", "PAUSED", "BLOCKED", "CONVERGING", "ESCALATED"];
  for (const status of terminal) assert.equal(isTerminalGoal(status), true, status);
  for (const status of live) assert.equal(isTerminalGoal(status), false, status);
});
