import type {
  ArtifactStatus,
  ArtifactStateMachineKind,
  ArtifactType,
  EventType,
  GoalStatus,
  LifecycleState,
  MessageType,
} from "./types";

export const EVENT_TYPES: EventType[] = [
  "goal.created",
  "goal.budget_changed",
  "goal.status_changed",
  "goal.paused",
  "goal.resumed",
  "goal.progress",
  "goal.completed",
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
  "budget.reserved",
  "budget.consumed",
  "budget.exceeded",
  "budget.released",
  "budget.limit_raised",
];

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
  WAITING: ["AWAKENED", "IDLE", "BLOCKED", "SUSPENDED", "FAILED"],
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
