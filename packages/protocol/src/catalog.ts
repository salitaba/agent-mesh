import type {
  ArtifactScope,
  ArtifactStatus,
  ArtifactStateMachineKind,
  ArtifactType,
  EventType,
  GoalStatus,
  HardActionsPolicy,
  MeshOp,
  InteractionMode,
  LifecycleState,
  MessageType,
  Severity,
} from "./types";

export const EVENT_TYPES: EventType[] = [
  "goal.created",
  "goal.budget_changed",
  "goal.status_changed",
  "goal.paused",
  "goal.resumed",
  "goal.progress",
  "goal.completed",
  "goal.reopened",
  "goal.escalated",
  "goal.failed",
  "goal.description_revised",
  "requirements.created",
  "requirement.blocked",
  "requirement.satisfied",
  "requirement.revised",
  "requirement.removed",
  "agent.created",
  "agent.started",
  "agent.awakened",
  "agent.state_changed",
  "agent.suspended",
  "agent.resumed",
  "agent.completed",
  "agent.failed",
  "agent.restarted",
  "agent.replaced",
  "agent.retired",
  "agent.mute_suspected",
  "session.rotation_pending",
  "session.rotated",
  "continuity.recorded",
  "thread.created",
  "message.sent",
  "message.delivered",
  "message.rejected",
  "artifact.created",
  "artifact.versioned",
  "artifact.transition",
  "task.created",
  "task.claimed",
  "task.completed",
  "review.requested",
  "review.approved",
  "review.rejected",
  "patch.created",
  "patch.ready",
  "patch.merged",
  "architecture.approved",
  "design.question",
  "dependency.changed",
  "authentication.changed",
  "authorization.changed",
  "release.candidate",
  "release.transition",
  "release.accepted",
  "research.requested",
  "research.completed",
  "implementation.completed",
  "decision.proposed",
  "decision.ratified",
  "escalation.requested",
  "escalation.responded",
  "escalation.auto_resolved",
  // A deadlock the runtime settled by itself (currently: a circular wait
  // broken by voiding one ask) instead of freezing the mission on a card.
  "deadlock.auto_resolved",
  // An outstanding ask stopped being outstanding (answered, superseded,
  // withdrawn, or voided). The only event-sourced exit from the ledger.
  "commitment.discharged",
  "collab.opened",
  "collab.closed",
  "human.input",
  "lease.acquired",
  "lease.released",
  "memory.updated",
  "context.assembled",
  "plan.updated",
  "plan.gate_rejected",
  "budget.reserved",
  "budget.consumed",
  "budget.exceeded",
  "budget.released",
  "budget.limit_raised",
];

/**
 * How loudly each event type should read in an operator-facing view.
 *
 * Unlike `EVENT_TYPES`, this cannot silently drift: `Record<EventType, Severity>`
 * makes a missing member a compile error, so adding to the union forces a
 * decision here. Kept in `EVENT_TYPES` order so the two lists diff by eye.
 *
 * Three levels, not five. A scale with more rungs than an operator can hold in
 * their head is a scale they stop reading.
 *   - `alert`   — it went wrong, or a human is needed. Never folded away.
 *   - `notice`  — real progress worth seeing.
 *   - `routine` — bookkeeping. Folded by default; the log is mostly this.
 *
 * Type alone is a floor, not the last word: an `agent.state_changed` into FAILED
 * matters far more than one into THINKING, and the same is true of any type
 * whose payload carries an outcome. Consumers refine from the payload on top of
 * this baseline rather than encoding payload knowledge here, which would drag
 * every payload shape into the protocol package.
 */
export const EVENT_SEVERITY: Record<EventType, Severity> = {
  "goal.created": "notice",
  "goal.budget_changed": "notice",
  "goal.status_changed": "notice",
  "goal.paused": "notice",
  "goal.resumed": "notice",
  // Progress pings are frequent and individually uninformative; the mission
  // moving is the story, not each increment of it.
  "goal.progress": "routine",
  "goal.completed": "notice",
  "goal.reopened": "notice",
  "goal.escalated": "alert",
  "goal.failed": "alert",
  // The mission statement changed under a running mesh. Nothing went wrong,
  // but every acceptance judgement before and after this line was measured
  // against a different target, and an operator reading the log needs to see
  // exactly where that happened.
  "goal.description_revised": "notice",

  "requirements.created": "notice",
  "requirement.blocked": "alert",
  "requirement.satisfied": "notice",
  "requirement.revised": "notice",
  // Louder than a revision on purpose: removal shrinks the denominator that
  // completion is measured over, so it is the one criteria edit that can move
  // a mission toward done without any work being finished.
  "requirement.removed": "alert",

  "agent.created": "notice",
  "agent.started": "notice",
  "agent.awakened": "notice",
  // The single noisiest type in the log: every agent churns through a dozen of
  // these per turn. Refined upward from the payload when the target state is a
  // failure — see the consumer-side override.
  "agent.state_changed": "routine",
  "agent.suspended": "notice",
  "agent.resumed": "notice",
  "agent.completed": "notice",
  "agent.failed": "alert",
  // Not a routine restart: the scheduler re-activates an agent only after it
  // timed out or died, so this is a crash by another name.
  "agent.restarted": "alert",
  "agent.replaced": "alert",
  // Capacity permanently left the mesh. Reversible states (suspended) are a
  // notice; this one is why the seat never speaks again, which is the first
  // thing an operator debugging a stalled mission needs to find.
  "agent.retired": "alert",
  // The seat is up, scheduled, and structurally unable to answer. Louder than
  // a failure, because a failed agent at least stops; a mute one keeps
  // consuming budget and looking busy.
  "agent.mute_suspected": "alert",

  // Not a fault, so not an alert — but the successor session starts without
  // anything the predecessor held in its head, and an operator reading a sudden
  // change in an agent's behaviour needs this line to explain it.
  "session.rotation_pending": "notice",
  "session.rotated": "notice",

  // The one line that explains a discontinuity in an agent's behaviour, so it
  // is not folded away with the routine traffic.
  "continuity.recorded": "notice",

  "thread.created": "notice",

  "message.sent": "notice",
  // Paired one-to-one with message.sent and carries nothing the send did not.
  // Keeping both at notice doubles the visible traffic for no added signal.
  "message.delivered": "routine",
  "message.rejected": "alert",

  "artifact.created": "notice",
  "artifact.versioned": "notice",
  "artifact.transition": "notice",

  "task.created": "notice",
  "task.claimed": "notice",
  "task.completed": "notice",

  "review.requested": "notice",
  "review.approved": "notice",
  "review.rejected": "alert",

  "patch.created": "notice",
  "patch.ready": "notice",
  "patch.merged": "notice",

  "architecture.approved": "notice",
  "design.question": "notice",
  "dependency.changed": "notice",
  "authentication.changed": "notice",
  "authorization.changed": "notice",

  "release.candidate": "notice",
  "release.transition": "notice",
  "release.accepted": "notice",

  "research.requested": "notice",
  "research.completed": "notice",

  "implementation.completed": "notice",

  "decision.proposed": "notice",
  "decision.ratified": "notice",

  "escalation.requested": "alert",
  "escalation.responded": "notice",
  "escalation.auto_resolved": "notice",
  // Auto-resolved, so nothing is frozen — but a deadlock happened, and an
  // operator debugging a run wants to know the runtime had to break a cycle.
  "deadlock.auto_resolved": "alert",
  "commitment.discharged": "notice",
  "collab.opened": "notice",
  // Notice, not alert: the OVERRUN raises an escalation card of its own, and
  // most closes are an agent ending its own session on time.
  "collab.closed": "notice",

  "human.input": "notice",

  "lease.acquired": "routine",
  "lease.released": "routine",

  "memory.updated": "routine",

  // One per turn per awake agent: the highest-volume type in the catalog, and
  // useful in aggregate rather than line by line. Folded by default; read when
  // a specific turn is under investigation.
  "context.assembled": "routine",

  "plan.updated": "notice",
  "plan.gate_rejected": "alert",

  "budget.reserved": "routine",
  "budget.consumed": "routine",
  "budget.exceeded": "alert",
  "budget.released": "routine",
  "budget.limit_raised": "notice",
};

export const MESSAGE_TYPES: MessageType[] = [
  "MISSION",
  "INFORM",
  "REQUEST",
  "REQUEST_INFO",
  "REQUEST_REVIEW",
  "REQUEST_ARTIFACT",
  "REQUEST_RESEARCH",
  "REQUEST_EXECUTION",
  "PROPOSE",
  "CHALLENGE",
  "APPROVE",
  "REJECT",
  "VETO",
  "BLOCK",
  "DELEGATE",
  "HANDOFF",
  "PATCH_READY",
  "TEST_RESULT",
  "SECURITY_FINDING",
  "COMMIT",
  "ROLLBACK",
  "ESCALATE",
  "WAIT",
  "DONE",
];

/**
 * The envelope fields the obligation predicate reads, and only those.
 *
 * Structural rather than `MeshMessage`, for the same reason `VerdictEscalation`
 * further down is: naming the two fields that decide the answer is itself the
 * documentation, and a caller holding a half-assembled envelope can still ask.
 */
export interface ObligationEnvelope {
  type: MessageType;
  control?: { mode?: InteractionMode };
}

/**
 * The TYPE half of {@link obligesRecipients}: is this speech act one that
 * creates a debt at all?
 *
 * Prefix-matched rather than enumerated, deliberately. The enumerated version
 * — `REQUEST_TYPES` as it was written — silently omitted any `REQUEST_*` name
 * added to `MESSAGE_TYPES` after it, and a list that quietly stops being
 * complete is worse than one that is obviously partial.
 *
 * Not the whole answer on its own: mode decides too. A caller holding a
 * message wants `obligesRecipients`, not this.
 */
export function isObligingType(type: string): boolean {
  return type.startsWith("REQUEST") || type === "ESCALATE" || type === "CHALLENGE";
}

/**
 * Every message type that creates a debt when it is sent in `service` mode.
 *
 * Derived from `MESSAGE_TYPES` through `isObligingType` rather than written
 * out, so it cannot fall out of step with the predicate the commitment ledger
 * actually runs.
 */
export const OBLIGING_MESSAGE_TYPES: MessageType[] = MESSAGE_TYPES.filter(isObligingType);

/**
 * Does this message put the agents it is addressed to under an obligation?
 *
 * The ONE answer. It used to be three, and they disagreed: this predicate's
 * ancestor in `core/src/context.ts`, a hand-copy of it inside the
 * `message.sent` case of `core/src/projections-messaging.ts` — held in step by
 * a comment saying it was a hand-copy — and `REQUEST_TYPES` below, which was
 * the only *exported* one and the only one that was wrong. Both core sites now
 * call this, so the prompt's obligation band and the commitment ledger cannot
 * drift apart again.
 *
 * It lives in the catalog because the catalog is the one shared table every
 * consumer may take a *value* import from: it imports nothing but types, and
 * this predicate keeps that property (see the import-weight note at the top of
 * `core/src/run-report.ts`, which depends on it).
 *
 * Reading the type names alone is wrong in BOTH directions, which is what made
 * three copies possible in the first place:
 *
 *   - `CHALLENGE` creates a real debt and is not a `REQUEST_*` name. A
 *     CHALLENGE raised through `mesh_request` really does open a
 *     `state.pendingRequests` entry, so a list omitting it under-counts the
 *     ledger — and constraining an ask tool's schema to that list would make a
 *     debt-creating ask unrepresentable.
 *   - The very same REQUEST type obliges NOBODY when its interaction mode is
 *     `broadcast` or `collab`. A REQUEST-typed broadcast addresses every seat
 *     in the mesh, so it used to open one entry owed by everyone at once, and
 *     `outstandingDebtors` then treated the whole roster as debtors: the first
 *     reply left every other seat owing an answer nobody was tracking, while
 *     nudges and stalemate detection pointed at agents who were never
 *     individually asked. An announcement is not an ask. A `collab` is bounded
 *     by its own clock rather than by a per-recipient debt — that is what "no
 *     obligation, but time-boxed" means, and putting it on the ledger would
 *     make it exactly the open-ended chatter it exists to replace.
 *
 * Read off `control`, never `payload`: `payload` is verbatim agent input, and
 * a sender able to set its own obligation band could promote its chatter above
 * everybody else's real asks. An absent mode reads as `service`, which is what
 * every message written before the field existed was, so replaying an old log
 * is unchanged.
 *
 * A statement about the ENVELOPE rather than a lookup in
 * `state.pendingRequests`, on purpose. An agent can only discharge mail it has
 * been shown, so an ask still sitting unread is still owed; keeping it pure is
 * what lets the whole inbox ordering be tested without standing up a kernel,
 * and what lets the reducer use this same call to DECIDE the ledger entry it
 * would otherwise have to consult.
 */
export function obligesRecipients(m: ObligationEnvelope): boolean {
  if ((m.control?.mode ?? "service") !== "service") return false;
  return isObligingType(m.type);
}

/**
 * @deprecated The name reads like the answer to "does this oblige anyone?" and
 * it is not: it knows nothing about `control.mode`, so a `broadcast`-mode
 * REQUEST is in it and obliges nobody. Ask {@link obligesRecipients} with the
 * message; for a list, take {@link OBLIGING_MESSAGE_TYPES}, which this is now
 * a copy of.
 *
 * Kept rather than deleted because it is re-exported from the package index
 * and removing it is a public API break for no in-repo gain — it has zero
 * runtime consumers. Its only readers are the three tests that pin it as a
 * copy (`tests/core/obligation-predicate.test.ts`,
 * `tests/core/context-inbox-order.test.ts`,
 * `tests/protocol/mcp-comms-surface.test.ts`), so a deletion is small but not
 * free: they object. Derived rather than corrected in place so the two lists
 * can never disagree again: as written it enumerated six REQUEST names plus
 * ESCALATE and omitted CHALLENGE, which creates a debt.
 */
export const REQUEST_TYPES: MessageType[] = [...OBLIGING_MESSAGE_TYPES];

export const RESPONSE_TYPES: MessageType[] = [
  "APPROVE",
  "REJECT",
  "VETO",
  "BLOCK",
  "DONE",
  "PATCH_READY",
  "TEST_RESULT",
  "SECURITY_FINDING",
  "COMMIT",
  "ROLLBACK",
  "HANDOFF",
];

export const LIFECYCLE_STATES: LifecycleState[] = [
  "STARTING",
  "IDLE",
  "AWAKENED",
  "OBSERVING",
  "THINKING",
  "REQUESTING",
  "WORKING",
  "WAITING",
  "REVIEWING",
  "BLOCKED",
  "SUSPENDED",
  "FAILED",
  "COMPLETED",
  "RETIRED",
];

/**
 * RETIRED is reachable from every other state and leaves none: an operator
 * retires a seat whatever it happens to be doing, and a retired seat never
 * runs again. Contrast COMPLETED, which keeps an edge back to IDLE so a
 * finished agent can be woken for follow-up.
 */
export const LIFECYCLE_TRANSITIONS: Record<LifecycleState, LifecycleState[]> = {
  STARTING: ["IDLE", "SUSPENDED", "FAILED", "RETIRED"],
  IDLE: ["AWAKENED", "SUSPENDED", "COMPLETED", "FAILED", "RETIRED"],
  AWAKENED: ["OBSERVING", "IDLE", "SUSPENDED", "FAILED", "RETIRED"],
  OBSERVING: ["THINKING", "IDLE", "SUSPENDED", "FAILED", "RETIRED"],
  THINKING: ["REQUESTING", "WORKING", "WAITING", "REVIEWING", "IDLE", "BLOCKED", "SUSPENDED", "FAILED", "RETIRED"],
  REQUESTING: ["WAITING", "REVIEWING", "IDLE", "THINKING", "SUSPENDED", "FAILED", "RETIRED"],
  WORKING: ["REVIEWING", "WAITING", "IDLE", "THINKING", "BLOCKED", "SUSPENDED", "FAILED", "RETIRED"],
  // COMPLETED is reachable from WAITING because a parked agent is idle-with-a-debt,
  // not busy: when the mission ends the completion sweep must be able to retire it.
  // Without this edge the sweep's `agent.completed` is rejected by the projection and
  // the agent is left in WAITING for the life of a finished mesh.
  WAITING: ["AWAKENED", "IDLE", "BLOCKED", "SUSPENDED", "COMPLETED", "FAILED", "RETIRED"],
  REVIEWING: ["IDLE", "BLOCKED", "THINKING", "SUSPENDED", "FAILED", "RETIRED"],
  BLOCKED: ["THINKING", "IDLE", "AWAKENED", "SUSPENDED", "FAILED", "RETIRED"],
  SUSPENDED: ["IDLE", "FAILED", "RETIRED"],
  FAILED: ["STARTING", "SUSPENDED", "RETIRED"],
  COMPLETED: ["IDLE", "RETIRED"],
  RETIRED: [],
};

export const GOAL_STATUSES: GoalStatus[] = [
  "CREATED",
  "ACTIVE",
  "PAUSED",
  "BLOCKED",
  "CONVERGING",
  "COMPLETED",
  "FAILED",
  "ESCALATED",
];

export const ARTIFACT_TYPES: ArtifactType[] = [
  "ArchitectureDocument",
  "ADR",
  "ApiSpec",
  "DatabaseSchema",
  "CodePatch",
  "ReleasePlan",
  "TestReport",
  "SecurityReport",
  "ResearchReport",
  "Decision",
  "Requirement",
  "RequirementsDoc",
  "TaskSpec",
  "BenchmarkResult",
  "DisagreementRecord",
];

export const ARTIFACT_STATUSES: ArtifactStatus[] = [
  "DRAFT",
  "READY_FOR_REVIEW",
  "UNDER_REVIEW",
  "REJECTED",
  "APPROVED",
  "VERIFIED",
  "MERGEABLE",
  "MERGED",
  "PROPOSED",
  "IMPLEMENTED",
  "QA_VERIFIED",
  "SECURITY_VERIFIED",
  "ACCEPTED",
  "FINAL",
  "ARCHIVED",
];

export const SETTLED_ARTIFACT_STATUSES: ArtifactStatus[] = [
  "APPROVED",
  "VERIFIED",
  "MERGEABLE",
  "MERGED",
  "ACCEPTED",
  "FINAL",
  "ARCHIVED",
];

export function isSettledArtifactStatus(status: ArtifactStatus): boolean {
  return SETTLED_ARTIFACT_STATUSES.includes(status);
}

export const CODE_ARTIFACT_TRANSITIONS: Partial<Record<ArtifactStatus, ArtifactStatus[]>> = {
  DRAFT: ["READY_FOR_REVIEW", "ARCHIVED"],
  READY_FOR_REVIEW: ["UNDER_REVIEW", "APPROVED", "DRAFT", "ARCHIVED"],
  UNDER_REVIEW: ["APPROVED", "REJECTED", "READY_FOR_REVIEW"],
  REJECTED: ["DRAFT"],
  APPROVED: ["VERIFIED"],
  VERIFIED: ["MERGEABLE"],
  MERGEABLE: ["MERGED", "UNDER_REVIEW"],
  MERGED: [],
  ARCHIVED: [],
};

export const RELEASE_ARTIFACT_TRANSITIONS: Partial<Record<ArtifactStatus, ArtifactStatus[]>> = {
  PROPOSED: ["IMPLEMENTED", "ARCHIVED"],
  IMPLEMENTED: ["QA_VERIFIED", "PROPOSED"],
  QA_VERIFIED: ["SECURITY_VERIFIED", "IMPLEMENTED"],
  SECURITY_VERIFIED: ["ACCEPTED", "IMPLEMENTED"],
  ACCEPTED: [],
  ARCHIVED: [],
};

export const DOCUMENT_ARTIFACT_TRANSITIONS: Partial<Record<ArtifactStatus, ArtifactStatus[]>> = {
  DRAFT: ["READY_FOR_REVIEW", "FINAL", "ARCHIVED"],
  READY_FOR_REVIEW: ["UNDER_REVIEW", "DRAFT", "FINAL"],
  UNDER_REVIEW: ["APPROVED", "REJECTED", "READY_FOR_REVIEW"],
  REJECTED: ["DRAFT"],
  APPROVED: ["FINAL"],
  FINAL: ["ARCHIVED", "DRAFT"],
  ARCHIVED: [],
};

export const MACHINE_TRANSITIONS: Record<ArtifactStateMachineKind, Partial<Record<ArtifactStatus, ArtifactStatus[]>>> = {
  code: CODE_ARTIFACT_TRANSITIONS,
  release: RELEASE_ARTIFACT_TRANSITIONS,
  document: DOCUMENT_ARTIFACT_TRANSITIONS,
};

export const ARTIFACT_MACHINE: Record<ArtifactType, ArtifactStateMachineKind> = {
  CodePatch: "code",
  ReleasePlan: "release",
  ArchitectureDocument: "document",
  ADR: "document",
  ApiSpec: "document",
  DatabaseSchema: "document",
  TestReport: "document",
  SecurityReport: "document",
  ResearchReport: "document",
  Decision: "document",
  Requirement: "document",
  RequirementsDoc: "document",
  TaskSpec: "document",
  BenchmarkResult: "document",
  DisagreementRecord: "document",
};

export const INITIAL_ARTIFACT_STATUS: Record<ArtifactStateMachineKind, ArtifactStatus> = {
  code: "DRAFT",
  release: "PROPOSED",
  document: "DRAFT",
};

/**
 * Domains an authority token can name. These are exactly the subjects
 * `Supervisor.domainOfSubject` resolves and `PolicyEngine.evaluateAuthority`
 * checks against.
 */
export const AUTHORITY_DOMAINS = [
  "architecture",
  "implementation",
  "quality",
  "security",
  "requirements",
  "release",
] as const;

/** Verbs an authority token can carry. */
export const AUTHORITY_VERBS = ["approve", "reject", "accept", "block", "veto", "pass", "*"] as const;

/**
 * Every authority token the runtime can satisfy, plus the `*` superuser held
 * by the human seat.
 *
 * Without this list an authority typo (`architecture.aprove`) parsed fine,
 * validated fine, and then silently DENIED forever at runtime — the agent
 * simply never had the power its config claimed to grant, and the only
 * symptom was a mission that would not converge.
 */
export const AUTHORITY_TOKENS: string[] = [
  "*",
  ...AUTHORITY_DOMAINS.flatMap((d) => AUTHORITY_VERBS.map((v) => `${d}.${v}`)),
];

/**
 * Every capability token the policy engine and runtime can satisfy.
 *
 * Same failure mode as authority tokens: a capability the engine never checks
 * (or a typo like `repository.writ`) loads and boots, but every grant silently
 * does nothing — the seat gets no edit/bash tools and the mission cannot write
 * a product. Config load rejects anything outside this list; the aliases below
 * are normalized first so hand-written meshes keep working.
 */
export const CAPABILITY_TOKENS: string[] = [
  "repository.read",
  "repository.write",
  "architecture.read",
  "architecture.write",
  "review.design",
  "code.review",
  "task.assign",
  "test.write",
  "test.execute",
  "security.scan",
  "security.review",
  "git.commit",
  "git.merge",
  "shell.execute",
  "network.request",
  // Message-standing grant checked by `sendMessageCapability` for
  // REQUEST_REVIEW / REQUEST_RESEARCH; repository.read also confers it.
  "request_review",
];

/**
 * The tokens that let a seat write files, as the runtime permission gate
 * defines it (`buildPermissionGate`'s `canEdit`).
 *
 * Shared with `Supervisor.agentWorkspace`, which must hand exactly these seats
 * a worktree of their own. The two answers have to come from one list: when
 * only `repository.write` earned a worktree, a seat holding `architecture.write`
 * was permitted to write but had nowhere committable to write TO, and its output
 * landed outside every repository. Any token added here widens both at once —
 * which is the point, since granting the ability to write without the place to
 * write is what produced that bug.
 */
export const EDIT_CAPABILITIES: string[] = ["repository.write", "architecture.write", "test.write"];

/**
 * Capability tokens treated as "hard actions" when an agent opts in and does
 * not name its own list.
 *
 * `shell.execute` and `network.request` are included because they are what an
 * operator means by "dangerous", but note they have no entry in
 * HARD_OP_CAPABILITY below: they are exercised by the underlying coding
 * agent's own tools, not by a MeshOp, so the op-layer gate cannot see them.
 * Config load emits a warning saying so rather than silently doing nothing.
 */
export const DEFAULT_HARD_CAPABILITIES: string[] = [
  "repository.write",
  "git.commit",
  "git.merge",
  "shell.execute",
  "network.request",
];

/**
 * The ops the plan gate can actually enforce, and the capability each implies.
 *
 * Deliberately a small static table rather than a predicate: every entry must
 * be a mesh op whose effect is externally visible and hard to undo. Ops that
 * are already gated elsewhere are excluded on purpose — `transition_artifact`
 * by the artifact state machine, `spawn_worker` by the delegation policy — so
 * the plan gate never becomes a second, competing authority check.
 */
export const HARD_OP_CAPABILITY: Partial<Record<MeshOp["op"], string>> = {
  publish_artifact: "repository.write",
  commit: "git.commit",
  merge: "git.merge",
};

/**
 * Marks a rejection as coming from the plan gate. The supervisor's op loop
 * matches on this to stop the rest of the turn (a turn that keeps going after
 * a refused write announces artifacts that were never created).
 */
export const PLAN_GATE_PREFIX = "plan-gate:";

/**
 * Clamps on a plan. A checklist is re-rendered into every prompt this agent
 * takes, so an unbounded one is a per-turn token leak, and a model that emits
 * 200 steps is confused rather than thorough.
 */
export const MAX_PLAN_STEPS = 10;
export const MAX_PLAN_STEP_CHARS = 160;

/** The no-op policy an agent gets when it declares none. */
export const HARD_ACTIONS_OFF: HardActionsPolicy = { mode: "off", capabilities: [] };

/** Never returns undefined, so callers cannot forget the default. */
export function effectiveHardActions(policy: HardActionsPolicy | undefined): HardActionsPolicy {
  return policy ?? HARD_ACTIONS_OFF;
}

/**
 * Domain-flavored names seen in hand-written mesh.yaml files (api.write,
 * ui.write, ...) mapped onto the canonical tokens the runtime checks. Without
 * this a mesh that "grants" api.write grants nothing: policy denies every
 * write op and the runtime's capability gate denies the edit tool.
 */
export const CAPABILITY_ALIASES: Record<string, string> = {
  "api.read": "repository.read",
  "ui.read": "repository.read",
  "data.read": "repository.read",
  "api.write": "repository.write",
  "ui.write": "repository.write",
  "data.write": "repository.write",
  "code.write": "repository.write",
  "docs.write": "repository.write",
  "test.run": "test.execute",
  "quality.verify": "test.execute",
  "repository.commit": "git.commit",
  "repository.merge": "git.merge",
};

export function normalizeCapability(capability: string): string {
  return CAPABILITY_ALIASES[capability] ?? capability;
}

export const TRUST_SOURCES = [
  "human",
  "system",
  "mesh_decision",
  "agent",
  "repository",
  "external",
  "tool",
] as const;

export const TRUST_LEVELS: Record<(typeof TRUST_SOURCES)[number], number> = {
  human: 100,
  system: 90,
  mesh_decision: 80,
  tool: 60,
  agent: 50,
  repository: 30,
  external: 10,
};

export function artifactMachineOf(type: ArtifactType): ArtifactStateMachineKind {
  return ARTIFACT_MACHINE[type] ?? "document";
}

/**
 * Types that are mission-wide reference material unless an author says
 * otherwise. These four were previously an unconditional `return true` in the
 * context builder, with the same intent and none of the escape hatch: a mesh
 * where nobody can read the architecture is a mesh reinventing it every turn.
 */
export const ARTIFACT_SCOPES: ArtifactScope[] = ["mission", "work"];

const MISSION_SCOPE_TYPES = new Set<ArtifactType>([
  "ArchitectureDocument",
  "RequirementsDoc",
  "ADR",
  "ApiSpec",
]);

export function defaultArtifactScope(type: ArtifactType): ArtifactScope {
  return MISSION_SCOPE_TYPES.has(type) ? "mission" : "work";
}

/**
 * The artifact's scope, explicit if it has one and derived from its type if not.
 *
 * Deliberately a read-time accessor rather than a field the reducer backfills:
 * projections must stay a pure function of the log, and an event written before
 * `scope` existed has to keep producing the state it always produced.
 */
export function artifactScope(a: { type: ArtifactType; scope?: ArtifactScope }): ArtifactScope {
  return a.scope ?? defaultArtifactScope(a.type);
}

export function artifactStatusMachineOf(status: ArtifactStatus): ArtifactStateMachineKind[] {
  const out: ArtifactStateMachineKind[] = [];
  for (const kind of ["code", "release", "document"] as ArtifactStateMachineKind[]) {
    if (status in MACHINE_TRANSITIONS[kind]) out.push(kind);
  }
  return out;
}

/** Human-readable phrasing for one termination reason. */
export interface VerdictText {
  /** Headline, safe to show alone in a list or a card title. */
  title: string;
  /** One sentence explaining what happened, in an operator's vocabulary. */
  summary: string;
}

/**
 * Facts a caller already computed that sharpen the phrasing. All optional:
 * `verdictText(reason)` alone always returns usable text, because the CLI and
 * the report often have the reason and nothing else.
 */
export interface VerdictContext {
  /** Unanswered requests behind a stalemate. */
  waiting?: number;
  /** Agents named by a runtime failure. */
  agents?: string[];
  /** Exhausted thread budgets. */
  threads?: number;
}

/**
 * The one source of human-readable verdict text.
 *
 * Termination reasons are code literals (`packages/core/src/termination.ts`)
 * and were rendered into English in exactly one place — a switch inside the
 * dashboard's escalation card — which meant the CLI had no phrasing at all and
 * any new reason silently rendered as a raw snake_case token. Keys here are the
 * `reason` strings those verdicts and escalations actually carry.
 *
 * This lives in the catalog because all three consumers — core, the CLI and the
 * dashboard — need it, and the catalog is the one shared table they can all
 * import without dragging a runtime graph along: it imports nothing but types.
 *
 * The dashboard still owns its own `what` / `next` / placeholder copy: that
 * text talks about clicking and answering *below*, which is true of a card and
 * false of a terminal. Only the shared half — what happened — lives here.
 */
const VERDICT_TEXT: Record<string, VerdictText> = {
  all_mandatory_criteria_evidenced: {
    title: "Goal met",
    summary: "Every mandatory acceptance criterion was evidenced, with no open escalations and no work still claimed.",
  },
  runtime_failure: {
    title: "An agent crashed",
    summary: "An agent hit a runtime failure while work was still outstanding, so the mission stopped rather than continuing around it.",
  },
  backend_unreachable: {
    title: "A model backend went down",
    summary: "An agent failed several turns in a row because its model backend stopped answering.",
  },
  budget_exhausted: {
    title: "Mission ran out of tokens",
    summary: "The mission token budget was spent before the goal was met.",
  },
  agent_budget_exhausted: {
    title: "An agent ran out of tokens",
    summary: "One agent spent its individual token budget and can take no further turns.",
  },
  thread_budget_exhausted: {
    title: "A conversation ran out of tokens",
    summary: "A thread spent its token budget, so no further turns can happen in it.",
  },
  thread_budgets_exhausted: {
    title: "Every open conversation is out of tokens",
    summary: "All open threads spent their token budgets and no agent is still running, so work stopped silently.",
  },
  budget_exhausted_tokens: {
    title: "Out of tokens",
    summary: "A token budget was spent before the goal was met.",
  },
  // Deliberately not phrased as another budget. The four entries above are
  // token ledgers inside one mesh — mission, agent, thread — and the knob that
  // answers them lives in this project's config. This one is the host's dollar
  // total across every project it has open, enforced by a different process
  // that parked this mission on its way past the limit. An operator who reads
  // it as a mesh budget goes looking for a setting that is not there, so the
  // summary names the money, the blast radius and where the knob actually is.
  host_spend_ceiling: {
    title: "The host hit its spend ceiling",
    summary: "Every project open on this host added up to more than the host's dollar ceiling allows, so all of them were parked. Raise the ceiling in host settings to continue.",
  },
  max_events_exceeded: {
    title: "Mission hit its event cap",
    summary: "The run produced more events than the configured mission cap allows.",
  },
  wall_clock_exceeded: {
    title: "Mission ran out of time",
    summary: "The run exceeded its configured wall-clock limit.",
  },
  stalemate: {
    title: "Stalemate",
    summary: "The mesh deadlocked: agents are waiting on answers that only a human can give.",
  },
  "stalemate:unanswered_request": {
    title: "An agent is waiting for an answer",
    summary: "A request went unanswered long enough to stall the agent that sent it.",
  },
  // One entry covers both flavours; `detail.cause` distinguishes nudges that
  // were delivered and bought nothing from nudges that never reached an agent.
  "stalemate:stall_nudge_cap": {
    title: "A stuck mission needs a decision",
    summary: "The stall watchdog woke the mesh repeatedly and nothing moved, so it stopped spending context on the mission and handed it over.",
  },
  // Synthesized by `deriveVerdict` when a run stopped without the termination
  // manager recording a reason — a hard kill, a crash, or a log that ends
  // mid-mission. Phrased rather than left to the snake_case fallback because
  // these are the states an interrupted run actually lands in.
  no_goal: {
    title: "No mission",
    summary: "No goal was ever activated in this log, so there is nothing to report on.",
  },
  goal_failed: {
    title: "Mission failed",
    summary: "The goal was marked failed without a recorded termination reason — check the escalations and the last events.",
  },
  goal_escalated: {
    title: "Mission escalated",
    summary: "The goal is parked awaiting a human decision; see the open escalations below.",
  },
};

/**
 * Human-readable text for a termination or escalation `reason`.
 *
 * Unknown reasons degrade to the de-snaked literal rather than throwing or
 * rendering an empty card: a reason nobody has phrased yet is still better
 * shown than swallowed.
 */
export function verdictText(reason: string, ctx: VerdictContext = {}): VerdictText {
  const base = VERDICT_TEXT[reason];
  if (!base) {
    const plain = reason.replace(/[:_]+/g, " ").trim();
    return {
      title: plain ? plain.charAt(0).toUpperCase() + plain.slice(1) : "Mission stopped",
      summary: `The mission stopped for a reason this build has no phrasing for (\`${reason}\`). Check the escalations and the event log.`,
    };
  }
  if (reason === "runtime_failure" && ctx.agents?.length) {
    return { ...base, title: `Agent crashed: ${ctx.agents.join(", ")}` };
  }
  if (reason === "stalemate" && typeof ctx.waiting === "number") {
    return { ...base, title: ctx.waiting > 0 ? `Stalemate (${ctx.waiting} waiting)` : "Stalemate (clearing)" };
  }
  if (reason === "thread_budgets_exhausted" && typeof ctx.threads === "number" && ctx.threads > 0) {
    return { ...base, summary: `${ctx.threads} conversation thread${ctx.threads === 1 ? "" : "s"} spent their token budgets and no agent is still running, so work stopped silently.` };
  }
  return base;
}

/** `raisedBy` on the cards `TerminationManager` raises (`supervisor.ts`). */
export const TERMINATION_RAISER = "termination-manager";

/**
 * `raisedBy` on the host spend-ceiling card.
 *
 * A component name, like `termination-manager` and `deadlock-detector`,
 * because a component is what raised it: the host process noticed its own
 * aggregate limit and parked this mesh from the outside. Naming the human
 * here would be a lie the UI repeats — the card would read as an operator
 * decision when it is a machine backstop, and nobody could tell the two apart
 * on the timeline.
 */
export const HOST_LIMITER_RAISER = "host-limiter";

/** The `reason` literal the host spend-ceiling card carries. */
export const HOST_SPEND_CEILING_REASON = "host_spend_ceiling";

/** A verdict that is standing right now, carrying the reason it keys on. */
export interface LiveVerdict extends VerdictText {
  /** A real `VERDICT_TEXT` key — never the de-snaked fallback. */
  reason: string;
}

/**
 * An open escalation as `/status` serves it. Structural on purpose: the catalog
 * imports nothing but types, and widening this to core's real `Escalation`
 * would drag a runtime graph into every consumer that only wants the phrasing.
 */
export interface VerdictEscalation {
  reason?: string;
  raisedBy?: string;
  advisory?: boolean;
  status?: string;
  detail?: unknown;
}

/**
 * The mission's own verdict, phrased, from live state — or null.
 *
 * `TerminationManager.evaluate` already decides this, but it is unreachable
 * from a banner: the tick that sees the condition escalates and flips the goal
 * to ESCALATED, and from the next tick on `evaluate` returns `continue`. The
 * verdict is computable for exactly one tick. What outlives it is the card that
 * tick raised, which carries the verdict `reason` literal verbatim — so the
 * standing verdict stays readable from `openEscalations` long after the verdict
 * itself stopped being computable. That is the whole trick here.
 *
 * Only termination-manager cards qualify, and only for reasons this table has
 * phrased. An agent-raised escalation carries free prose in `reason`, which
 * `verdictText` would cheerfully de-snake into a headline — a graceful degrade
 * in a card, a garbled sentence in the most prominent copy on the page. A
 * banner is the wrong surface to guess on.
 */
export function liveMissionVerdict(escalations: readonly VerdictEscalation[]): LiveVerdict | null {
  // Last match, not first: a mission can escalate, be answered, and escalate
  // again, and the log preserves insertion order — the newest card is live.
  for (let i = escalations.length - 1; i >= 0; i--) {
    const e = escalations[i];
    if (!e || e.advisory === true) continue;
    // Absent status means the caller already filtered to open cards, which is
    // what `/status` serves; a present one still has to say OPEN.
    if (e.status !== undefined && e.status !== "OPEN") continue;
    if (e.raisedBy !== TERMINATION_RAISER) continue;
    const reason = e.reason;
    // `hasOwnProperty`, not `in`: "constructor" and "toString" are reachable as
    // reason strings and would both pass a prototype-chain check.
    if (!reason || !Object.prototype.hasOwnProperty.call(VERDICT_TEXT, reason)) continue;
    const detail = (e.detail && typeof e.detail === "object" ? e.detail : {}) as Record<string, unknown>;
    // The three detail keys are the ones `evaluate` actually writes, read back
    // here so the headline carries live numbers rather than the generic line.
    return {
      reason,
      ...verdictText(reason, {
        agents: Array.isArray(detail.failedAgents) ? (detail.failedAgents as string[]) : undefined,
        threads: typeof detail.exhaustedThreads === "number" ? detail.exhaustedThreads : undefined,
        waiting: Array.isArray(detail.openDeadlockEscalations) ? detail.openDeadlockEscalations.length : undefined,
      }),
    };
  }
  return null;
}

/**
 * One timeline event, as the dashboard's buffer and `/events` serve it.
 * Structural for the same reason `VerdictEscalation` is.
 */
export interface VerdictEvent {
  type?: string;
  payload?: unknown;
}

/**
 * Goal-terminal events, and the goal status each one leaves behind.
 *
 * `goal.escalated` is deliberately absent even though it carries the same
 * `reason`. A halt is read from the open *card* (`liveMissionVerdict`), because
 * a card can be answered and retired and the banner then disappears with it;
 * an event stays in the buffer forever and that banner would never clear. The
 * three below are states that never need to clear, which is exactly why the
 * event channel is the right one for them.
 */
const TERMINAL_VERDICT_EVENTS: Record<string, string> = {
  "goal.completed": "COMPLETED",
  "goal.failed": "FAILED",
  "goal.paused": "PAUSED",
};

/**
 * The verdict a finished mission stopped on, phrased, from the event log — or
 * null.
 *
 * The completion path raises no escalation (`supervisor.ts`: it emits
 * `goal.completed` and calls `completeMission()`), so `liveMissionVerdict` has
 * no card to find and the Overview's COMPLETED banner had to hardcode its own
 * wording. The reason is not lost, though — it rides the event payload
 * verbatim, which is what this reads.
 *
 * Two rules differ from `liveMissionVerdict`, both on purpose:
 *
 * - **The newest terminal event decides, and nothing older is consulted.**
 *   Open cards coexist, so scanning past one that does not qualify is right
 *   there; terminal events are a timeline, and a mission that completed, was
 *   reopened and then failed has both in the buffer — the older one is a lie by
 *   the time the newer lands. So a mismatch returns null rather than searching
 *   on for an event that agrees.
 * - **No raiser guard.** These three types are emitted from one branch of the
 *   supervisor and nowhere else, so the type *is* the provenance. The
 *   `VERDICT_TEXT` guard still stands: `goal.paused` carries `"user pause"`,
 *   free prose that `verdictText` would de-snake into a headline.
 *
 * No `VerdictContext` is passed because none of these payloads carries a key it
 * reads: `goal.failed` has only `{goalId, reason}`, and `goal.completed`'s
 * `evidence` is a criterion-id summary, not an agent or thread count.
 */
export function terminalMissionVerdict(events: readonly VerdictEvent[], goalStatus: string): LiveVerdict | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const type = events[i]?.type;
    if (!type || !Object.prototype.hasOwnProperty.call(TERMINAL_VERDICT_EVENTS, type)) continue;
    // Disagreement means the event is stale — a reopened mission still has its
    // old `goal.completed` in the buffer, and the banner it would feed is gone.
    if (TERMINAL_VERDICT_EVENTS[type] !== goalStatus) return null;
    const payload = (events[i]!.payload && typeof events[i]!.payload === "object" ? events[i]!.payload : {}) as Record<string, unknown>;
    const reason = typeof payload.reason === "string" ? payload.reason : undefined;
    if (!reason || !Object.prototype.hasOwnProperty.call(VERDICT_TEXT, reason)) return null;
    return { reason, ...verdictText(reason) };
  }
  return null;
}
