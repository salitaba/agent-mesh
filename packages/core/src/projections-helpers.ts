import type {
  AcceptanceCriterion,
  AgentDefinition,
  Artifact,
  ArtifactRef,
  ArtifactStatus,
  DecisionRecord,
  Escalation,
  Goal,
  MeshEvent,
  MeshMessage,
  Task,
  Thread,
  WorkspaceLease,
  EventType,
} from "../../protocol/src/index";
import {
  LIFECYCLE_TRANSITIONS,
  MACHINE_TRANSITIONS,
  RESPONSE_TYPES,
  artifactMachineOf,
} from "../../protocol/src/index";
import type { Projections } from "./state";
import { approvalKey, artifactKey, dischargeCommitment, ensureBudget, stillOwes } from "./state";

export class ProjectionError extends Error {
  constructor(message: string, public readonly eventType: EventType) {
    super(message);
    this.name = "ProjectionError";
  }
}
/**
 * Identity of a message for loop detection: WHO asked WHOM to do WHAT about
 * WHICH artifact — deliberately not "what words did they use".
 *
 * This is the mesh's only defence against an agent that stops progressing and
 * starts repeating itself, and it used to hash `JSON.stringify(m.payload)`:
 * free-form prose written by a language model. Rewording is the one thing a
 * model does reliably and unprompted, so "is this the same message?" was
 * answered by string equality over text that never repeats verbatim.
 * `fingerprint_loop` therefore fired only on a bit-identical resend and
 * missed every paraphrased loop — the actual failure mode.
 *
 * Fingerprinting the STRUCTURED part of the envelope (participants, act,
 * subject, and the task/thread the act belongs to) makes the check
 * paraphrase-proof: the same request about the same artifact collides no
 * matter how it is worded. Prose still travels in the payload; it simply no
 * longer decides control flow.
 *
 * A stable, semantically meaningful payload discriminator is kept when the
 * payload carries one (`result` is the obvious case: TEST_RESULT PASSED and
 * TEST_RESULT FAILED are genuinely different messages, not a repetition), so
 * distinguishing outcomes does not require distinguishing wording.
 */
export function fingerprintOf(m: MeshMessage): string {
  const parts = [
    m.from,
    "->",
    [...m.to].sort().join(","),
    ":",
    m.type,
    ":",
    (m.artifactRefs || []).map((r) => r.uri).sort().join(","),
    ":",
    m.taskId ?? "",
    ":",
    m.threadId ?? "",
    ":",
    payloadDiscriminator(m.payload),
  ];
  return parts.join("");
}

/**
 * The stable, machine-meaningful slice of a payload.
 *
 * Only fields the runtime itself branches on elsewhere are included; every
 * other key is prose or prose-adjacent and must not affect message identity.
 * Keep this list in sync with the payload reads in `supervisor.deliverEffects`.
 */
const FINGERPRINT_PAYLOAD_KEYS = ["result", "artifactId", "subject", "criterionId", "decision"] as const;

function payloadDiscriminator(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  const p = payload as Record<string, unknown>;
  const out: string[] = [];
  for (const key of FINGERPRINT_PAYLOAD_KEYS) {
    const v = p[key];
    if (v === undefined || v === null) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out.push(`${key}=${String(v)}`);
  }
  return out.join("&");
}

export function bumpConflict(
  state: Projections,
  key: string,
  actor: string,
  ts: string,
  threadId?: string,
  artifactId?: string,
): void {
  const existing = state.conflicts.get(key);
  if (existing) {
    existing.count++;
    existing.lastAt = ts;
    existing.lastActor = actor;
  } else {
    state.conflicts.set(key, { key, count: 1, lastActor: actor, firstAt: ts, lastAt: ts, threadId, artifactId });
  }
}

function artifactUriPrefixOf(artifact: { type: string; name: string }): string {
  return `artifact://${artifact.type}/${artifact.name}/`;
}

/** Does this pending review request target the given artifact? */
export function pendingTargetsArtifact(
  state: Projections,
  pr: { messageId: string; artifactUris?: string[] },
  artifactId: string,
): boolean {
  const artifact = state.artifacts.get(artifactId);
  // Fast path: stored URIs from request creation.
  const uris = pr.artifactUris ?? state.messages.get(pr.messageId)?.artifactRefs.map((r) => r.uri) ?? [];
  if (artifact) {
    const prefix = artifactUriPrefixOf(artifact);
    if (uris.some((u) => u === artifact.contentRef || u.startsWith(prefix))) return true;
    // Fallback: match by artifact id embedded in URI or exact id.
    if (uris.some((u) => u.includes(artifactId) || u.includes(encodeURIComponent(artifact.name)))) return true;
  } else {
    // Artifact unknown (deleted or cross-goal): match raw id substring to avoid
    // leaking pendings forever, but only for review-type requests.
    if (uris.some((u) => u.includes(artifactId))) return true;
  }
  return false;
}

/**
 * A review decision for an artifact resolves outstanding review requests for
 * it from the decider. Without this, an approve via `mesh_approve` (no
 * `replyTo`) leaves the original REQUEST_REVIEW pending forever and the
 * scheduler eventually raises a false stalemate.
 */
export function clearPendingForArtifactReview(
  state: Projections,
  artifactId: string,
  decider: string,
  at: string = new Date().toISOString(),
): void {
  for (const [pid, pr] of [...state.pendingRequests]) {
    if (!pr.type.startsWith("REQUEST")) continue;
    if (!stillOwes(pr, decider)) continue;
    if (pendingTargetsArtifact(state, pr, artifactId)) {
      dischargeCommitment(state, pid, "artifact_review", decider, at);
    }
  }
}

export function clearPendingForTask(state: Projections, taskId: string, at: string = new Date().toISOString()): void {
  for (const [pid, pr] of [...state.pendingRequests]) {
    if (pr.taskId === taskId) dischargeCommitment(state, pid, "task_completed", "system", at);
  }
}

export function recordApproval(
  state: Projections,
  p: Record<string, any>,
  event: MeshEvent,
  kind: string,
): void {
  const subject = p.subject ?? `artifact:${p.artifactId ?? "general"}`;
  const key = approvalKey(subject, kind);
  const list = state.approvals.get(key) ?? [];
  list.push({
    id: `apr-${event.id}`,
    goalId: event.goalId ?? state.activeGoalId ?? "",
    kind: kind as any,
    subject,
    artifactId: p.artifactId,
    artifactRef: p.artifactRef,
    actorId: p.actorId ?? event.actorId ?? "unknown",
    actorRole: p.actorRole ?? "",
    evidenceEventId: event.id,
    recordedAt: event.timestamp,
  });
  state.approvals.set(key, list);
}

export function transitionLifecycle(
  state: Projections,
  st: import("../../protocol/src/index").AgentRuntimeState,
  to: import("../../protocol/src/index").LifecycleState,
  event: MeshEvent,
): void {
  if (st.lifecycle === to) return;
  const allowed = LIFECYCLE_TRANSITIONS[st.lifecycle] ?? [];
  if (!allowed.includes(to)) {
    throw new ProjectionError(
      `illegal lifecycle transition ${st.lifecycle} -> ${to} for ${st.agentId}`,
      event.type,
    );
  }
  st.lifecycle = to;
  st.lastActivityAt = event.timestamp;
}

export function assertArtifactTransition(
  type: import("../../protocol/src/index").ArtifactType,
  from: ArtifactStatus,
  to: ArtifactStatus,
  gateSatisfied: boolean,
): void {
  const machine = artifactMachineOf(type);
  const table = MACHINE_TRANSITIONS[machine];
  const allowed = table[from] ?? [];
  if (!allowed.includes(to)) {
    throw new ProjectionError(
      `illegal artifact transition ${machine}:${from} -> ${to}`,
      "artifact.transition",
    );
  }
  if (!gateSatisfied) {
    throw new ProjectionError(
      `artifact transition ${from} -> ${to} blocked by unsatisfied gate`,
      "artifact.transition",
    );
  }
}

export function hasApproval(state: Projections, subject: string, kind: string, actor?: string): boolean {
  const list = state.approvals.get(approvalKey(subject, kind)) ?? [];
  if (list.length === 0) return false;
  if (!actor) return true;
  return list.some((a) => a.actorId === actor || a.actorRole === actor);
}

export function hasApprovalForArtifact(state: Projections, artifactId: string, kind: string): boolean {
  for (const list of state.approvals.values()) {
    for (const r of list) {
      if (r.kind === kind && r.artifactId === artifactId) return true;
    }
  }
  return false;
}

export function gateForTransition(artifactType: string, to: ArtifactStatus): string {
  if (artifactType === "CodePatch" && to === "MERGED") return "patch.merge";
  if (artifactType === "CodePatch" && to === "APPROVED") return "patch.approve";
  if (artifactType === "ReleasePlan" && to === "ACCEPTED") return "release.accepted";
  if (artifactType === "ReleasePlan" && to === "IMPLEMENTED") return "implementation.completed";
  return `${artifactType}.${to}`;
}

export interface ApprovalToken {
  actor: string;
  kind: string;
}

export function parseGateTokens(requires: string[]): ApprovalToken[] {
  const out: ApprovalToken[] = [];
  for (const token of requires) {
    const idx = token.lastIndexOf(".");
    if (idx <= 0) continue;
    out.push({ actor: token.slice(0, idx), kind: token.slice(idx + 1) });
  }
  return out;
}

export function checkApprovals(
  state: Projections,
  requires: string[],
  artifactId?: string,
): { ok: boolean; missing: string[] } {
  const all: import("../../protocol/src/index").ApprovalRecord[] = [];
  for (const list of state.approvals.values()) all.push(...list);
  const missing: string[] = [];
  for (const { actor, kind } of parseGateTokens(requires)) {
    const relevant = all.filter(
      (r) =>
        (r.actorId === actor || r.actorRole === actor) &&
        (artifactId === undefined || r.artifactId === undefined || r.artifactId === artifactId),
    );
    const satisfiedKind = (r: import("../../protocol/src/index").ApprovalRecord) =>
      r.kind === kind || (kind === "approve" && (r.kind === "accept" || r.kind === "merge")) ||
      (kind === "pass" && (r.kind === "accept" || r.kind === "merge"));
    const approving = relevant.filter(satisfiedKind);
    if (approving.length === 0) {
      missing.push(`${actor}.${kind}`);
      continue;
    }
    const latest = approving.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0];
    const laterBlock = relevant.find(
      (r) => r.kind === "block" && r.recordedAt > latest.recordedAt,
    );
    if (laterBlock) missing.push(`${actor}.${kind} (superseded by ${actor}.block)`);
  }
  return { ok: missing.length === 0, missing };
}

export function gateSatisfiedWithConfig(
  state: Projections,
  artifact: Artifact,
  to: ArtifactStatus,
  callerSatisfied: boolean,
  config?: { transitionGates?: Record<string, string[]> },
): boolean {
  if (!callerSatisfied) return false;
  const gateName = gateForTransition(artifact.type, to);
  const requires = config?.transitionGates?.[gateName];
  if (requires && requires.length > 0) {
    const missionLevel = gateName === "implementation.completed" || gateName === "release.accepted";
    const res = checkApprovals(state, requires, missionLevel ? undefined : artifact.id);
    if (!res.ok) return false;
  }
  if (to === "APPROVED" && !hasApprovalForArtifact(state, artifact.id, "approve")) {
    return false;
  }
  if (to === "MERGED" && hasApprovalForArtifact(state, artifact.id, "block")) {
    const blocks = [...state.approvals.values()].flat().filter((r) => r.kind === "block" && r.artifactId === artifact.id);
    const approves = [...state.approvals.values()].flat().filter(
      (r) => (r.kind === "approve" || r.kind === "pass") && r.artifactId === artifact.id,
    );
    const latestBlock = blocks.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0];
    const latestApprove = approves.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0];
    if (latestBlock && (!latestApprove || latestBlock.recordedAt > latestApprove.recordedAt)) return false;
  }
  return true;
}

export function isTerminalGoal(status: Goal["status"]): boolean {
  return status === "COMPLETED" || status === "FAILED";
}
