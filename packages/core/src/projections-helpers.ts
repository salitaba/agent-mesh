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
 *
 * The envelope's `replyTo` is part of identity too. Answering a *different*
 * request is different work however the words change, while re-answering the
 * *same* request still collides. Without it every INFORM an agent sends in a
 * thread collapses into one fingerprint, so routine status narration (READY,
 * then DONE after the actual work lands) was counted as a verbatim resend and
 * raised `fingerprint_loop` against an agent that was progressing.
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
    m.replyTo ?? "",
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

/**
 * Does this authority list grant `<subject>.<kind>`?
 *
 * The single definition of "holds authority" for the whole runtime. The
 * deliberate op path asks the policy engine (`evaluateAuthority`), but
 * projections are pure reducers over the event log and cannot reach the
 * engine: policy-engine already imports from core, so the reverse import
 * would be a cycle. Both call this instead, so a sign-off recorded from a
 * message obeys exactly the rule a sign-off recorded from an op obeys.
 *
 * Safe inside a reducer because `definition.authority` is itself projected
 * from `agent.registered` in the log — replay stays deterministic.
 *
 * The human seat needs no special case here: its definition carries
 * `authority: ["*"]`.
 */
export function holdsAuthority(authority: readonly string[] | undefined, subject: string, kind: string): boolean {
  if (!authority) return false;
  return authority.includes(`${subject}.${kind}`) || authority.includes(`${subject}.*`) || authority.includes("*");
}

/** Which capability lets an agent review this kind of artifact? */
export function capabilityForReview(type: Artifact["type"]): string | null {
  switch (type) {
    case "ArchitectureDocument":
    case "ADR":
    case "ApiSpec":
      return "review.design";
    case "CodePatch":
      return "code.review";
    case "SecurityReport":
      return "security.review";
    default:
      return null;
  }
}

/**
 * Which authority domain governs a subject?
 *
 * `subject` may already BE a domain, a `criterion:` subject, or an artifact
 * type — the op path passes all three.
 */
export function domainOfSubject(state: Projections, subject: string, artifactId?: string): string {
  if (subject.startsWith("criterion:")) return "requirements";
  if (["architecture", "implementation", "quality", "security", "requirements", "release"].includes(subject)) return subject;
  const artifact = artifactId ? state.artifacts.get(artifactId) : undefined;
  if (artifact) {
    switch (artifact.type) {
      case "ArchitectureDocument":
      case "ApiSpec":
      case "ADR":
        return "architecture";
      case "CodePatch":
        return "implementation";
      case "ReleasePlan":
        return "release";
      case "TestReport":
        return "quality";
      case "SecurityReport":
        return "security";
      case "RequirementsDoc":
      case "Requirement":
        return "requirements";
      default:
        return subject;
    }
  }
  return subject;
}

/**
 * Could some agent OTHER than `actorId` have reviewed this artifact?
 *
 * The single definition of "a peer exists" for the whole runtime, so the
 * self-approval screen on the message path is the same screen the op path
 * applies (supervisor.ts `hasPeerReviewer` delegates here).
 *
 * In a real organization an author may never approve their own work. But a
 * single-agent control group has no peers; the benchmark (§71) needs to be
 * mechanically comparable, so self-review is allowed only when no OTHER
 * registered agent could have reviewed the artifact. The human seat is never
 * that peer: it is not a reviewer the mesh can schedule.
 *
 * Pure over `state.agents` and `state.artifacts`, both projected from the log,
 * so this is safe inside a reducer — exactly like `holdsAuthority`.
 */
export function hasPeerReviewerFor(
  state: Projections,
  actorId: string,
  artifact: Artifact,
  humanAgentId = "human",
): boolean {
  const reviewCap = capabilityForReview(artifact.type);
  const subject = domainOfSubject(state, artifact.type, artifact.id);
  for (const rec of state.agents.values()) {
    const id = rec.definition.id;
    if (id === actorId || id === humanAgentId) continue;
    if (rec.state.lifecycle === "COMPLETED" || rec.state.lifecycle === "FAILED") continue;
    const auth = rec.definition.authority;
    if (auth.includes(`${subject}.approve`) || auth.includes(`${subject}.*`) || auth.includes("*")) return true;
    if (reviewCap && rec.definition.capabilities.includes(reviewCap)) return true;
  }
  return false;
}

/**
 * Resolve the artifact a message points at.
 *
 * A message carries BOTH `payload.artifactId` and `artifactRefs[0].uri`, and
 * either alone can identify the target — screening only the explicit id would
 * leave the URI path open. Exact-match only: the supervisor's fuzzy
 * `findArtifactByUri` exists for model-invented URIs on the deliberate op
 * path, and its heuristics do not belong in a replay-deterministic reducer.
 */
export function artifactForRef(state: Projections, artifactId?: string, uri?: string): Artifact | undefined {
  if (artifactId) {
    const direct = state.artifacts.get(artifactId);
    if (direct) return direct;
  }
  const candidates = [uri, artifactId].filter((u): u is string => typeof u === "string" && u.length > 0);
  for (const u of candidates) {
    for (const a of state.artifacts.values()) {
      if (a.id === u || a.contentRef === u || `artifact://${a.type}/${a.name}/${a.version}` === u) return a;
    }
    const parsed = /^artifact:\/\/([^/]+)\/([^/]+)/.exec(u);
    if (parsed) {
      for (const a of state.artifacts.values()) {
        if (a.type === parsed[1] && a.name === decodeURIComponent(parsed[2]!)) return a;
      }
    }
  }
  return undefined;
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
      // A `pass` is a verified sign-off, so it is strictly stronger than a bare
      // `approve` and satisfies anything asking for one. The converse does NOT
      // hold: an `approve` never stands in for a required `pass`.
      if ((r.kind === kind || (kind === "approve" && r.kind === "pass")) && r.artifactId === artifactId) return true;
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
      r.kind === kind ||
      (kind === "approve" && (r.kind === "accept" || r.kind === "merge" || r.kind === "pass")) ||
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
