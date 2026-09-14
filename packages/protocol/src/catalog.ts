import type {
  ArtifactStatus,
  ArtifactStateMachineKind,
  ArtifactType,
  EventType,
  GoalStatus,
  HardActionsPolicy,
  MeshOp,
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
  "requirements.created",
  "requirement.blocked",
  "requirement.satisfied",
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
  "human.input",
  "lease.acquired",
  "lease.released",
  "memory.updated",
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

  "requirements.created": "notice",
  "requirement.blocked": "alert",
  "requirement.satisfied": "notice",

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

  "human.input": "notice",

  "lease.acquired": "routine",
  "lease.released": "routine",

  "memory.updated": "routine",

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

export const REQUEST_TYPES: MessageType[] = [
  "REQUEST",
  "REQUEST_INFO",
  "REQUEST_REVIEW",
  "REQUEST_ARTIFACT",
  "REQUEST_RESEARCH",
  "REQUEST_EXECUTION",
  "ESCALATE",
];

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
];

export const LIFECYCLE_TRANSITIONS: Record<LifecycleState, LifecycleState[]> = {
  STARTING: ["IDLE", "SUSPENDED", "FAILED"],
  IDLE: ["AWAKENED", "SUSPENDED", "COMPLETED", "FAILED"],
  AWAKENED: ["OBSERVING", "IDLE", "SUSPENDED", "FAILED"],
  OBSERVING: ["THINKING", "IDLE", "SUSPENDED", "FAILED"],
  THINKING: ["REQUESTING", "WORKING", "WAITING", "REVIEWING", "IDLE", "BLOCKED", "SUSPENDED", "FAILED"],
  REQUESTING: ["WAITING", "REVIEWING", "IDLE", "THINKING", "SUSPENDED", "FAILED"],
  WORKING: ["REVIEWING", "WAITING", "IDLE", "THINKING", "BLOCKED", "SUSPENDED", "FAILED"],
  // COMPLETED is reachable from WAITING because a parked agent is idle-with-a-debt,
  // not busy: when the mission ends the completion sweep must be able to retire it.
  // Without this edge the sweep's `agent.completed` is rejected by the projection and
  // the agent is left in WAITING for the life of a finished mesh.
  WAITING: ["AWAKENED", "IDLE", "BLOCKED", "SUSPENDED", "COMPLETED", "FAILED"],
  REVIEWING: ["IDLE", "BLOCKED", "THINKING", "SUSPENDED", "FAILED"],
  BLOCKED: ["THINKING", "IDLE", "AWAKENED", "SUSPENDED", "FAILED"],
  SUSPENDED: ["IDLE", "FAILED"],
  FAILED: ["STARTING", "SUSPENDED"],
  COMPLETED: ["IDLE"],
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
 * write op and the generated opencode config denies the edit tool.
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

export function artifactStatusMachineOf(status: ArtifactStatus): ArtifactStateMachineKind[] {
  const out: ArtifactStateMachineKind[] = [];
  for (const kind of ["code", "release", "document"] as ArtifactStateMachineKind[]) {
    if (status in MACHINE_TRANSITIONS[kind]) out.push(kind);
  }
  return out;
}
