import { HARD_OP_CAPABILITY, VERIFICATION_ARTIFACT_TYPES, effectiveHardActions } from "../../protocol/src/index";
import type {
  AcceptanceCriterion,
  AgentDefinition,
  AgentRuntimeState,
  MeshOp,
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
  // A message whose content rides in `note` with an empty payload is the same
  // hazard `payloadDiscriminator` documents below, one field over. Measured
  // 2026-09-28: a ui-designer sent four materially different INFORMs to one
  // seat — a correction, then design-system v26, then v28, then an operational
  // consequence — every one with `payload: {}` and the substance in `note`. The
  // fingerprint ignored `note`, so all four collided, `fingerprint_loop` fired,
  // and the stalemate verdict halted a mission that was progressing. The note
  // joins identity only when the payload discriminates nothing: a payload that
  // does discriminate is still the identity, and prose beside it stays out.
  const payloadPart = payloadDiscriminator(m.payload);
  const notePart = payloadPart === "" && typeof m.note === "string" && m.note.trim() ? `note=${m.note.trim()}` : "";
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
    payloadPart,
    ":",
    notePart,
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
  if (out.length > 0) return out.join("&");
  if (Object.keys(p).length === 0) return "";

  // Nothing above discriminates, so content decides.
  //
  // Falling through to "" here is what made this detector fire on agents that
  // were working. The whitelist cannot enumerate how agents actually write
  // (`ack`, `ask`, `verdict`, `audit_note`, `criterion_note`, `artifact`,
  // `freeze_confirmed`, … are all real and none are listed), and the envelope
  // cannot stand in for content: two messages can share sender, recipient,
  // type, thread AND `replyTo` and still be different work — one live mission
  // sent three PATCH_READY messages for successive revisions (/2, /4, /6) of
  // the same artifact in reply to the same request.
  //
  // Across 441 `message.sent` events in that mission the detector raised 17
  // `fingerprint_loop` escalations and killed a mission that was progressing.
  // Every one of the 18 collision groups held materially different payloads;
  // not one was a genuine resend. Identity therefore includes content, and the
  // detector now catches verbatim repeats rather than paraphrases — a reworded
  // loop is missed, but the alternative was escalating every agent that
  // reported twice.
  return canonicalJson(p);
}

/**
 * Deterministic JSON: object keys sorted at every depth, so key order is not
 * identity and the same content always yields the same string.
 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
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
 * The dependencies of `task` that still hold it back, in declared order.
 *
 * COMPLETED releases a dependent, and so does CANCELLED: abandoned upstream
 * work will never complete, and no op edits a task's dependency list, so
 * treating it as blocking would strand the dependent forever with no move for
 * anyone. An id the board does not hold blocks nothing for the same reason —
 * `create_task` refuses unknown ids, so only a hand-built log can carry one.
 *
 * Pure over `state.tasks`, so the claim reducer, `claimTask` and the context
 * builder all ask the same question.
 */
export function unmetTaskDependencies(state: Projections, task: Pick<Task, "dependsOn">): string[] {
  const out: string[] = [];
  for (const id of task.dependsOn ?? []) {
    const dep = state.tasks.get(id);
    if (dep && dep.status !== "COMPLETED" && dep.status !== "CANCELLED") out.push(id);
  }
  return out;
}

/** "<Type>/<name> v<from> → v<to>" for an artifact that moved on from a recorded version. */
function movedOn(a: Artifact, from: number): string {
  return `${a.type}/${a.name} v${from} → v${a.version}`;
}

/**
 * Artifacts a task was pinned to that have a newer version now.
 *
 * A pin is an `artifactRefs` entry carrying `version` (stamped by `newTask`
 * when the create op cited an artifact). pm cut frontend's W6-S3 from
 * architecture v2 while v3 was being written, and v3 re-split it — nothing on
 * the task could say so (skill-panel 2026-09-25, §16).
 */
export function staleTaskPins(state: Projections, task: Pick<Task, "artifactRefs">): string[] {
  const out: string[] = [];
  for (const ref of task.artifactRefs ?? []) {
    if (typeof ref.version !== "number") continue;
    const a = artifactForRef(state, undefined, ref.uri);
    if (a && a.version > ref.version) out.push(movedOn(a, ref.version));
  }
  return out;
}

/** Inputs `a` was built on (see `Artifact.inputs`) that have a newer version now. */
export function staleArtifactInputs(state: Projections, a: Pick<Artifact, "inputs">): string[] {
  const out: string[] = [];
  for (const input of a.inputs ?? []) {
    const src = state.artifacts.get(input.artifactId);
    if (src && src.version > input.version) out.push(movedOn(src, input.version));
  }
  return out;
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

/**
 * May a seat with this authority close an acceptance criterion?
 *
 * `approve subject:"criterion:<id>"` is refused unless the seat holds `requirements.accept` or
 * `requirements.approve` (`recordDecision`). Two readers need the same answer and used to write it
 * out each: the prompt, which shows the closing-out instruction only to a seat that can follow it
 * (`criterionAcceptanceEnabled`), and the stall watchdog, which has to wake a seat that can.
 */
export function mayAcceptCriteria(authority: readonly string[] | undefined): boolean {
  return holdsAuthority(authority, "requirements", "accept") || holdsAuthority(authority, "requirements", "approve");
}

/**
 * Is a PASS the positive verdict this authority list gives in `domain`: `<domain>.pass` held, and no
 * `<domain>.approve` beside it?
 *
 * `quality.pass` and `security.pass` are the verdicts of the seats that test and scan, and the shipped
 * QA and security seats hold those and not `.approve`. Such a seat asking to `approve` its own domain,
 * the only word `mesh_approve` had, was refused for want of an authority nobody holds ("no agent seat
 * holds it") while the one it does hold went unused: the fifth cronlite run's QA was refused that way
 * after it had tested the merged product, and the `qa.pass` the gates read and the `quality-verified`
 * evidence a pass lands were never recorded. A pass is at least an approve wherever the two are
 * compared (a gate asking for an approve is satisfied by a pass), so `recordDecision` records the
 * verdict the seat is entitled to, and the briefing tells the seat which word it is.
 */
export function givesPassForApprove(authority: readonly string[] | undefined, domain: string): boolean {
  return !holdsAuthority(authority, domain, "approve") && holdsAuthority(authority, domain, "pass");
}

/** The domains in which this authority list's positive verdict is a pass (see {@link givesPassForApprove}). */
export function passOnlyDomains(authority: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const token of authority ?? []) {
    if (!token.endsWith(".pass")) continue;
    const domain = token.slice(0, -".pass".length);
    if (domain && !out.includes(domain) && givesPassForApprove(authority, domain)) out.push(domain);
  }
  return out;
}

/**
 * The CodePatches a reviewer rejected that have not ended up MERGED or ARCHIVED: REJECTED and waiting
 * on its owner, or reworked since (DRAFT, back in review, on the merge ladder) and not yet landed. Only
 * for a goal that asks for the implementation to be merged (`implementation-merged` among its
 * mandatory criteria); [] for the rest.
 *
 * A rejection is a decision someone has to finish: the owner reworks the patch (a new version, then a
 * review request) and it lands, or the owner withdraws it (ARCHIVED, which a REJECTED patch reaches
 * through DRAFT). Until then the mission holds work the reviewers refused and no one has either redone
 * or dropped. The sixth cronlite run's developer put the library and the CLI forward as two patches;
 * the tech-lead rejected the CLI twice (it repeated the approved library's `src/index.js` and
 * `package.json`) and merged the library, and `implementation-merged` closed on that merge. The tech-lead
 * then approved the CLI patch, which moved nothing; the rejection woke no one (the broadcast that said so
 * wakes nobody), the pm accepted `cli-contract-met` on a QA report that read "CLI Commit: cd6615a
 * (pending merge)", and the mission completed with no `bin/cronlite.js` on the product branch. The patch
 * stays listed after its rework is resubmitted: a rework that is resubmitted and never merged would let
 * the mission complete the same way, one step later.
 *
 * A patch that was never rejected is NOT listed, whatever state it is in. Those are in flight with
 * seats moving them, and one that cannot land (the sixth run's second round ended with a MERGEABLE
 * patch whose work had gone in with another, refused as "nothing landed") must not hold a mission that
 * is otherwise done. Whether a patch was rejected is read from its history: after a snapshot restore the
 * history is the current record alone, so a reworked patch reads as one that was never rejected and the
 * guard does not apply to it (it fails open, as a safety net should). A REJECTED patch is listed on its
 * status alone.
 */
export function openRejections(state: Projections, goalId: string): Artifact[] {
  const goal = state.goals.get(goalId);
  if (!goal?.acceptanceCriteria.some((c) => c.mandatory && c.id === "implementation-merged")) return [];
  const out: Artifact[] = [];
  for (const a of state.artifacts.values()) {
    if (a.type !== "CodePatch" || a.goalId !== goalId || a.status === "MERGED" || a.status === "ARCHIVED") continue;
    if (a.status === "REJECTED" || (state.artifactHistory.get(a.id) ?? []).some((h) => h.status === "REJECTED")) out.push(a);
  }
  return out;
}

/**
 * Which capability lets an agent review each kind of artifact?
 *
 * The single table. It used to have a twin in the policy engine, also called
 * `REVIEW_CAPABILITIES`, and the two disagreed on four types — DatabaseSchema,
 * ReleasePlan, TestReport and RequirementsDoc — where this side answered null
 * and that side named a token.
 *
 * Every consequence of the disagreement ran the same way. `hasPeerReviewerFor`
 * below short-circuits on `reviewCap &&`, so a null here means "no capability
 * could have made anyone else a reviewer", which is exactly the condition that
 * PERMITS self-approval. A PM approving its own RequirementsDoc was not a
 * policy decision anyone made; it was a missing row. Meanwhile the transition
 * path, reading the other copy, refused the same act.
 *
 * Lives in core for the same layering reason `holdsAuthority` does — the
 * import edge runs policy-engine -> core and never back — and is re-exported
 * from there, the way `planCoversHardOp` already is.
 */
export const REVIEW_CAPABILITIES: Record<Artifact["type"], string> = {
  ArchitectureDocument: "review.design",
  ADR: "review.design",
  ApiSpec: "review.design",
  DatabaseSchema: "review.design",
  CodePatch: "code.review",
  ReleasePlan: "code.review",
  TestReport: "test.write",
  SecurityReport: "security.review",
  RequirementsDoc: "review.design",
  // The six that were missing, and the reason they had to be filled.
  //
  // `Partial<Record<…>>` let the table cover 9 of the 15 artifact types, and a
  // missing row does not fail closed — it fails in a way nobody would guess.
  // `capabilityForReview` returns null, `hasPeerReviewerFor` short-circuits on
  // that null and so reports that NO peer could have reviewed the artifact, and
  // `approverMayAdvance` reads "no peer reviewer exists" as the single-agent
  // control-group carve-out and returns true. The effect is that the
  // self-approval screen switches itself OFF — in a fully staffed mesh — for
  // exactly the types nobody remembered to list.
  //
  // Now `Record`, not `Partial<Record>`: the type is the guard. A new artifact
  // type is a compile error here instead of a silent hole in the review model.
  ResearchReport: "review.design",
  Decision: "review.design",
  DisagreementRecord: "review.design",
  Requirement: "review.design",
  TaskSpec: "review.design",
  BenchmarkResult: "test.write",
  // The capability every design reviewer in the measured mesh already held
  // (architect, ux-designer, tech-lead in skill-panel). The mesh has no `ux` or
  // `ui` authority domain to key on, so this row is what lets a designer who
  // is not an architect settle a design document.
  DesignSpec: "review.design",
};

/**
 * Which authority DOMAIN an artifact belongs to, from its type alone.
 *
 * One source, read by three callers that used to each have their own copy:
 * `domainOfSubject` (core), `reviewSubject` (policy-engine) and through it
 * `canReviewArtifactType`. They disagreed on `DatabaseSchema`, on `ReleasePlan`,
 * and on every type neither mapped — which is the "refused here, waved through
 * there" class the `REVIEW_CAPABILITIES` consolidation was written to end.
 *
 * Aligned rather than merged: one definition with two named readers, which is the
 * pattern the policy-engine comment already established for the capability table.
 */
export function subjectForArtifactType(type: Artifact["type"]): string {
  switch (type) {
    case "ArchitectureDocument":
    case "ADR":
    case "ApiSpec":
    case "DatabaseSchema":
      return "architecture";
    case "CodePatch":
      return "implementation";
    case "ReleasePlan":
      return "release";
    case "TestReport":
    case "BenchmarkResult":
      return "quality";
    case "SecurityReport":
      return "security";
    case "RequirementsDoc":
    case "Requirement":
    case "TaskSpec":
      return "requirements";
    // Types that govern no domain of their own. `architecture` matches what
    // `reviewSubject` already returned from its `default:` arm, so nothing moves
    // for them; it is stated explicitly here so the next type added has to choose.
    case "ResearchReport":
    case "Decision":
    case "DisagreementRecord":
      return "architecture";
    // Design documents are settled by the same seats that settled them when
    // they had to be filed as ArchitectureDocument — `architecture.approve`
    // holders and `review.design` capability holders — because AUTHORITY_DOMAINS
    // has no design domain and inventing one would refuse every existing
    // config's tokens. What changes is the TYPE: `markTypeKeyedCriteria` and
    // `design.question` key on ArchitectureDocument/ApiSpec, so approving a
    // design system no longer evidences `architecture-approved`.
    case "DesignSpec":
      return "architecture";
  }
}

/** Which capability lets an agent review this kind of artifact? */
export function capabilityForReview(type: Artifact["type"]): string | null {
  return REVIEW_CAPABILITIES[type] ?? null;
}

/**
 * Where an approval takes this artifact, given where it is now.
 *
 * Empty means an approval here records a verdict and moves NOTHING. That is
 * sometimes right — a `<role>.approve` gate token is a signature, and seats
 * legitimately sign artifacts sitting at a gate status that no approval can
 * advance. It is wrong when the signer believes it approved the work, which is
 * what a clean `{ ok: true }` told it, so the op path asks this and says so.
 *
 * Lives here rather than beside the reducer that also uses it, because the
 * supervisor's op path must reach it and core's reducers may not import the
 * policy engine — the same layering reason `holdsAuthority` lives here.
 */
export function approvalPath(type: Artifact["type"], status: ArtifactStatus): ArtifactStatus[] {
  const allowed = MACHINE_TRANSITIONS[artifactMachineOf(type)][status] ?? [];
  if (allowed.includes("APPROVED")) return ["APPROVED"];
  if (allowed.includes("FINAL")) return ["FINAL"];
  return [];
}

/**
 * Would a verdict of this kind MOVE the artifact, or only record a signature?
 *
 * `approvalPath` alone does not answer this, and the gap is the bug it was
 * missing. For a DOCUMENT-machine artifact in DRAFT, `approvalPath` returns
 * ["FINAL"] — non-empty — so an approve-on-DRAFT reads as advanceable and the
 * signer is told nothing, while the reducer refuses to move anything that is
 * not under review. A live run approved a RequirementsDoc exactly that way and
 * left the mission's only requirements evidence stranded in DRAFT, where the
 * criterion path cannot cite it. For a CodePatch the path is empty and the
 * caveat did fire, which is why the behaviour looked type-dependent.
 *
 * Mirrors the three reducer guards in `projections-artifact.ts`:
 * `review.approved` (UNDER_REVIEW | READY_FOR_REVIEW), `architecture.approved`
 * (UNDER_REVIEW only — deliberately narrower, because widening it changes how
 * existing logs project) and `review.rejected` (UNDER_REVIEW, with no
 * `approverMayAdvance` screen).
 *
 * A mirror rather than the reducers' own predicate, on purpose: those run on
 * every replay and replay equality is the property the event store rests on,
 * so they are not worth disturbing for a caveat string. `tests/core/inert-verdict.test.ts`
 * pins the two in agreement so the mirror cannot drift silently.
 */
export function verdictAdvances(
  state: Projections,
  actorId: string | undefined,
  artifact: Artifact,
  kind: "approve" | "pass" | "reject" | "veto",
): boolean {
  if (kind === "reject" || kind === "veto") return artifact.status === "UNDER_REVIEW";
  if (!approverMayAdvance(state, actorId, artifact)) return false;
  // Every approval is recorded as `review.approved` now (an architecture one
  // too, with `architecture.approved` only derived after it), so one guard
  // covers them all.
  const reviewable = artifact.status === "UNDER_REVIEW" || artifact.status === "READY_FOR_REVIEW";
  return reviewable && approvalPath(artifact.type, artifact.status).length > 0;
}

/**
 * Which authority domain governs a subject?
 *
 * `subject` may already BE a domain, a `criterion:` subject, or an artifact
 * type — the op path passes all three.
 */
export function domainOfSubject(state: Projections, subject: string, artifactId?: string): string {
  if (subject.startsWith("criterion:")) return "requirements";
  // A typed domain word wins over the artifact, and that is deliberate: the
  // subject names the CAPACITY the signer is acting in, not the domain the
  // artifact belongs to. QA recording `subject: "quality"` against a CodePatch
  // is the cross-domain sign-off the whole `<role>.approve` gate system rests
  // on, and resolving that to `implementation` makes every such gate
  // unsatisfiable by the seat it names.
  //
  // What must NOT follow from a capacity claim is the power to move someone
  // else's artifact. That check belongs where the movement happens — see
  // `approverMayAdvance` in projections-artifact.ts — not here.
  if (["architecture", "implementation", "quality", "security", "requirements", "release"].includes(subject)) return subject;
  const artifact = artifactId ? state.artifacts.get(artifactId) : undefined;
  // One table, shared with `reviewSubject`. The switch that used to live here
  // mapped six types and fell through for the rest, returning the caller's own
  // word as an authority domain — which is how a live run ended up checking a
  // seat against `'frontend v5 verification report (R17 surfaces) — accepted as
  // the v5 verification record.approve'`, and against `design.approve`, a token
  // config load would refuse to boot.
  if (artifact) return subjectForArtifactType(artifact.type);
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
/**
 * May this agent ADVANCE this artifact by approving it?
 *
 * Recording a verdict and moving an artifact are different powers, and the
 * runtime used to conflate them. The subject an agent types names the capacity
 * it signs in — `quality` on a CodePatch is a legitimate QA signature, and the
 * `<role>.approve` gates are built on exactly that — but a capacity claim must
 * not also confer authority to settle an artifact the claimant could never
 * review. Without this screen, any seat holding one of the six domain
 * authorities could move any artifact of any type by naming its own domain
 * word: in a live mission an ApiSpec reached APPROVED under a `requirements`
 * subject, signed by a seat whose only capability was repository.read.
 *
 * This is the test the transition path already applies as `review-authority`
 * (policy-engine `canReviewArtifactType`). It is restated here because
 * reducers are pure over projections and may not call the policy engine — the
 * same reason `holdsAuthority` and `hasPeerReviewerFor` live in this file.
 *
 * Unknown actors pass. A reducer must never refuse to replay an event because
 * the seat that caused it is not in this projection: hand-built logs and
 * pre-registration events would stop replaying identically, and replay
 * equality is the one property the whole event store rests on. Every seat in a
 * real mesh is registered before it can act, which is where the screen bites.
 */
export function approverMayAdvance(
  state: Projections,
  actorId: string | undefined,
  artifact: Artifact,
  humanAgentId = "human",
): boolean {
  if (!actorId || actorId === humanAgentId) return true;
  const def = state.agents.get(actorId)?.definition;
  if (!def) return true;
  // The single-agent control group. If no other seat in this mesh could have
  // reviewed the artifact, the only seat there is may settle it — the same
  // carve-out the self-approval screen makes just below, for the same
  // benchmark-comparability reason, and what keeps a one-seat mesh converging
  // instead of deadlocking on a reviewer that does not exist.
  if (!hasPeerReviewerFor(state, actorId, artifact, humanAgentId)) return true;
  return qualifiedForDomain(def, domainOfSubject(state, artifact.type, artifact.id), capabilityForReview(artifact.type));
}

/**
 * Is this seat qualified in an artifact's domain: does it hold the domain's approve authority, or
 * the capability that reviews that type of artifact?
 *
 * The one definition of it. `approverMayAdvance` (may this verdict settle), `hasPeerReviewerFor`
 * (could anyone else review it) and `unqualifiedAuthor` (could the seat that wrote it have
 * verified what it says) each asked this question in their own words before.
 */
export function qualifiedForDomain(def: Pick<AgentDefinition, "authority" | "capabilities">, domain: string, reviewCap: string | null): boolean {
  const auth = def.authority ?? [];
  if (auth.includes(`${domain}.approve`) || auth.includes(`${domain}.*`) || auth.includes("*")) return true;
  return reviewCap !== null && (def.capabilities ?? []).includes(reviewCap);
}

/**
 * The seats that could have verified what `artifact` says, when its own author is not one of them
 * and some other seat is; null otherwise.
 *
 * Only for the types whose whole claim is "someone checked" (`VERIFICATION_ARTIFACT_TYPES`). A
 * TestReport is evidence that the tests ran only if a seat that can run them wrote it: in the
 * fourth cronlite run the pm, which holds `repository.read` and the power to accept criteria and
 * nothing else, wrote a "Bug-Fix Verification Report" from what QA had told it, submitted it
 * itself and accepted two mandatory criteria against it, before anyone who can verify had looked
 * at the product.
 *
 * Null when nobody else is qualified, the carve-out `approverMayAdvance` makes for the same
 * reason: a mesh with no seat that can verify must still be able to converge, and refusing the
 * only report there can be would only wedge it. Null for the operator and for an author the
 * projection does not know (replay must never refuse an event because of who caused it).
 */
export function unqualifiedAuthor(state: Projections, artifact: Artifact, humanAgentId = "human"): { qualified: string[] } | null {
  if (!VERIFICATION_ARTIFACT_TYPES.includes(artifact.type)) return null;
  if (artifact.owner === humanAgentId) return null;
  const author = state.agents.get(artifact.owner)?.definition;
  if (!author) return null;
  const domain = domainOfSubject(state, artifact.type, artifact.id);
  const cap = capabilityForReview(artifact.type);
  if (qualifiedForDomain(author, domain, cap)) return null;
  const qualified: string[] = [];
  for (const rec of state.agents.values()) {
    const id = rec.definition.id;
    if (id === humanAgentId || id === artifact.owner) continue;
    if (rec.state.lifecycle === "COMPLETED" || rec.state.lifecycle === "FAILED" || rec.state.lifecycle === "RETIRED") continue;
    if (qualifiedForDomain(rec.definition, domain, cap)) qualified.push(id);
  }
  return qualified.length > 0 ? { qualified } : null;
}

/**
 * Can this seat deliver a verdict on this artifact that SETTLES it: the one
 * definition behind both the refusal a `request_review` gets and the list the seat
 * briefing prints, so what a seat is told and what the mesh then accepts cannot
 * differ.
 *
 * `approverMayAdvance` says the seat holds the authority or the review capability.
 * The artifact's own owner is held to one more rule, the same one
 * `evaluateTransition`'s `self-approval` applies: it may settle its own work only
 * when no peer could. Without that line the owner (who usually holds the domain's
 * approve authority) read as a reviewer it could never be.
 */
export function mayReviewArtifact(state: Projections, reviewerId: string, artifact: Artifact, humanAgentId = "human"): boolean {
  if (!approverMayAdvance(state, reviewerId, artifact, humanAgentId)) return false;
  return !(reviewerId === artifact.owner && hasPeerReviewerFor(state, reviewerId, artifact, humanAgentId));
}

/**
 * The seats whose verdict would settle `artifact`, in the mesh's own seat order.
 *
 * One list for the three readers that need it: the briefing prints it on the
 * artifact's line, `request_review` filters the reviewers a seat names against it,
 * and the `review.artifact` contract draws its default recipient from it. The
 * contract used to take "the first seat the caller may contact" as its default,
 * which is unrelated to who can settle anything (pm asked the architect to review
 * the architect's own document, and architect asked pm, 13 refusals in 24 requests
 * in the second cronlite run), so the default and the refusal it then met were
 * computed from different questions.
 *
 * The operator and seats that have stopped (completed, failed or retired) are not
 * reviewers anyone can ask.
 */
export function settlersOf(state: Projections, artifact: Artifact, humanAgentId = "human"): string[] {
  const out: string[] = [];
  for (const rec of state.agents.values()) {
    const id = rec.definition.id;
    if (id === humanAgentId) continue;
    const lifecycle = rec.state.lifecycle;
    if (lifecycle === "COMPLETED" || lifecycle === "FAILED" || lifecycle === "RETIRED") continue;
    if (mayReviewArtifact(state, id, artifact, humanAgentId)) out.push(id);
  }
  return out;
}

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
    if (rec.state.lifecycle === "COMPLETED" || rec.state.lifecycle === "FAILED" || rec.state.lifecycle === "RETIRED") continue;
    if (qualifiedForDomain(rec.definition, subject, reviewCap)) return true;
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

/**
 * One entry in a gate's `requires` list, as a list of ALTERNATIVES of which any
 * one satisfies the entry: `"tech-lead.approve|architect.approve"` is one
 * requirement that either seat can meet. A plain token parses to a one-element
 * list, so its behaviour is exactly what it always was.
 */
export type ApprovalRequirement = ApprovalToken[];

function parseGateToken(token: string): ApprovalToken | null {
  const idx = token.lastIndexOf(".");
  if (idx <= 0) return null;
  return { actor: token.slice(0, idx), kind: token.slice(idx + 1) };
}

/**
 * Split one requirement entry on `|` into its alternatives.
 *
 * An alternative that is not `<actor>.<kind>` is dropped (it could never match
 * an approval), and an entry that yields no alternatives at all is dropped by
 * the caller — the same skip the plain path has always applied to a token with
 * no dot. Config load refuses both forms outright, so this is the defensive
 * reading for a config that never passed validation.
 */
export function parseGateAlternatives(token: string): ApprovalRequirement {
  const out: ApprovalRequirement = [];
  for (const part of token.split("|")) {
    const parsed = parseGateToken(part);
    if (parsed) out.push(parsed);
  }
  return out;
}

/** Every requirement of a gate, each as its list of alternatives. Entries stay
 *  separate: requirements are ANDed, alternatives within one are ORed. */
export function parseGateRequirements(requires: string[]): ApprovalRequirement[] {
  const out: ApprovalRequirement[] = [];
  for (const token of requires) {
    const alternatives = parseGateAlternatives(token);
    if (alternatives.length > 0) out.push(alternatives);
  }
  return out;
}

/**
 * Flattened view of `parseGateRequirements`: every alternative of every
 * requirement, with the AND/OR grouping discarded. Retained for callers that
 * only ever wanted the token list; `checkApprovals` uses the grouped parser so
 * that a `|` alternative is an OR and not a second AND.
 */
export function parseGateTokens(requires: string[]): ApprovalToken[] {
  return parseGateRequirements(requires).flat();
}

type ApprovalRecordOf = import("../../protocol/src/index").ApprovalRecord;

/**
 * Whether one ALTERNATIVE of a gate requirement is met.
 *
 * This is the whole of the pre-existing single-token rule, unchanged: an
 * approval by the named actor (by id or by role) of a compatible kind, and a
 * `block` by that same actor recorded after the latest such approval sinks it.
 * The block is scoped to the alternative's actor alone, which is what makes
 * alternatives independent: a `tech-lead.block` cannot sink `architect.approve`
 * in the same requirement.
 *
 * `label` is exactly the string the old code pushed to `missing` — so for a
 * plain token the refusal text is byte-for-byte what it was.
 */
function alternativeStatus(
  all: ApprovalRecordOf[],
  actor: string,
  kind: string,
  artifactId?: string,
): { ok: boolean; label: string } {
  const label = `${actor}.${kind}`;
  const relevant = all.filter(
    (r) =>
      (r.actorId === actor || r.actorRole === actor) &&
      (artifactId === undefined || r.artifactId === undefined || r.artifactId === artifactId),
  );
  const satisfiedKind = (r: ApprovalRecordOf) =>
    r.kind === kind ||
    (kind === "approve" && (r.kind === "accept" || r.kind === "merge" || r.kind === "pass")) ||
    (kind === "pass" && (r.kind === "accept" || r.kind === "merge"));
  const approving = relevant.filter(satisfiedKind);
  if (approving.length === 0) return { ok: false, label };
  const latest = approving.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0];
  const laterBlock = relevant.find((r) => r.kind === "block" && r.recordedAt > latest.recordedAt);
  return laterBlock ? { ok: false, label: `${label} (superseded by ${actor}.block)` } : { ok: true, label };
}

export function checkApprovals(
  state: Projections,
  requires: string[],
  artifactId?: string,
): { ok: boolean; missing: string[] } {
  const all: ApprovalRecordOf[] = [];
  for (const list of state.approvals.values()) all.push(...list);
  const missing: string[] = [];
  for (const alternatives of parseGateRequirements(requires)) {
    const statuses = alternatives.map(({ actor, kind }) => alternativeStatus(all, actor, kind, artifactId));
    if (statuses.some((s) => s.ok)) continue;
    // Every alternative failed, so name them all — joined by the `|` they were
    // written with, so the refusal reads as "any of these" and not "all of
    // these". A one-element list joins to itself: unchanged for plain tokens.
    missing.push(statuses.map((s) => s.label).join("|"));
  }
  return { ok: missing.length === 0, missing };
}

/**
 * A BLOCK that nothing has lifted, and the artifact it holds when it is on one.
 *
 * The two kinds of hold are lifted differently, and which one a block is decides who can act on it:
 *
 *  - A block ON AN ARTIFACT holds that artifact: the policy refuses every transition but a
 *    rejection, a return to DRAFT or an archive until a NEW VERSION exists (`active-block`), and a
 *    new version drops the record. Only the artifact's owner can publish one; the blocker's own
 *    later `pass` releases nothing.
 *  - A block on a SUBJECT with no artifact (QA's `quality`) sinks that seat's earlier sign-off in
 *    every gate that names it, until the same seat signs off again (`alternativeStatus` reads it
 *    that way). Only the blocker can lift it, by re-verifying and passing.
 *
 * Read by the stall watchdog, which used to wake whichever seat had mail and say nothing of the
 * block: in the second cronlite run QA's block stood for ten minutes of nudges to the tech-lead,
 * the pm and the developer, none of whom could lift it.
 */
export interface StandingBlock {
  record: ApprovalRecordOf;
  /** Set when the block is on an artifact. */
  artifact?: Artifact;
}

export function standingBlocks(state: Projections): StandingBlock[] {
  // One hold per seat, subject and artifact: a seat that blocks the same thing again has
  // restated its block, not added a second one, and the latest record is the one that stands.
  const latest = new Map<string, ApprovalRecordOf>();
  for (const list of state.approvals.values()) {
    for (const r of list) {
      if (r.kind !== "block") continue;
      const key = `${r.actorId}|${r.subject}|${r.artifactId ?? ""}`;
      const seen = latest.get(key);
      if (!seen || r.recordedAt > seen.recordedAt) latest.set(key, r);
    }
  }
  const out: StandingBlock[] = [];
  for (const r of latest.values()) {
    if (r.artifactId) {
      const artifact = state.artifacts.get(r.artifactId);
      // An artifact that cannot move again (or is gone) is held by nothing.
      if (!artifact || artifact.status === "MERGED" || artifact.status === "FINAL" || artifact.status === "ARCHIVED") continue;
      out.push({ record: r, artifact });
      continue;
    }
    const signedOffSince = ["approve", "pass", "accept", "merge"].some((kind) =>
      (state.approvals.get(approvalKey(r.subject, kind)) ?? []).some((s) => s.actorId === r.actorId && s.recordedAt > r.recordedAt),
    );
    if (!signedOffSince) out.push({ record: r });
  }
  return out.sort((a, b) => a.record.recordedAt.localeCompare(b.record.recordedAt));
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

/**
 * Why an agent may not perform a hard op yet, or `null` when it may.
 *
 * Pure: no projections mutation, no events, no clock. The supervisor decides
 * what to DO with a failure (warn vs refuse); this only decides whether the
 * agent's current plan covers what it is about to do.
 *
 * The order of the early-outs is the whole design. Three of them return "fine"
 * for reasons that look like bugs but are not:
 *
 *  - No `HARD_OP_CAPABILITY` entry: most ops are not hard actions. `send`,
 *    `claim_task` and friends must never need a plan.
 *  - The agent does not HOLD the capability: gating here would produce an
 *    unsatisfiable demand — "write a plan step for repository.write" addressed
 *    to an agent that can never do a repository.write — and the agent would
 *    loop re-planning until its strike budget ran out.
 *
 *    This early-out used to justify itself with "some other layer will refuse
 *    this op anyway". That is true of `commit` (`git.commit`) and `merge`
 *    (`git.merge`) and NOT of `publish_artifact`: nothing anywhere enforces
 *    `repository.write` on a publish, and that is deliberate — a read-only PM
 *    seat publishing a `RequirementsDoc` is the shipped configuration in
 *    `examples/payment-api` and `examples/line-follower-sim`. So the
 *    `publish_artifact` entry in `HARD_OP_CAPABILITY` describes an opt-in
 *    PLANNING requirement, not a permission, and no refusal is coming.
 *
 *    Worth knowing because the role prompts read as though it were a
 *    permission: in a live run a read-only pm seat concluded it could not
 *    publish at all, wrote its requirements document into prose instead, and
 *    lost the turn. `content` inline was available to it the whole time.
 *  - The operator did not list the capability as hard: opting `git.commit` in
 *    must not drag `repository.write` along with it.
 *
 * A DONE step still counts. The gate asks "did you think about this before you
 * started", not "is this step still open" — an agent that marks a step done
 * and then retries the op after a transient failure is doing the right thing,
 * and refusing it there would be a deadlock with no legal way out.
 */
export function planCoversHardOp(
  op: MeshOp,
  def: AgentDefinition,
  st: AgentRuntimeState,
): string | null {
  const cap = HARD_OP_CAPABILITY[op.op];
  if (!cap) return null;
  if (!def.capabilities.includes(cap)) return null;
  const hard = effectiveHardActions(def.hardActions);
  if (!hard.capabilities.includes(cap)) return null;

  const plan = st.plan;
  if (!plan || plan.steps.length === 0) {
    return `no plan — ${op.op} needs '${cap}', so call \`mesh_plan\` with a step whose capabilities include "${cap}" first`;
  }
  // A plan written for the PREVIOUS task is not a plan for this one. Compared
  // at read time rather than cleared by a reducer, so replay and snapshot
  // restore always agree (see the plan.updated reducer).
  if (plan.taskId && st.activeTaskId && plan.taskId !== st.activeTaskId) {
    return `your plan is for task ${plan.taskId} but you are working ${st.activeTaskId} — call \`mesh_plan\` again for the current task`;
  }
  if (!plan.steps.some((s) => s.capabilities.includes(cap))) {
    return `no plan step declares '${cap}' — call \`mesh_plan\` again with a step whose capabilities include "${cap}"`;
  }
  return null;
}
