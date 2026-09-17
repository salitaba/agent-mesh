export type MessageId = string;
export type EventId = string;
export type AgentId = string;
export type GoalId = string;
export type ThreadId = string;
export type ArtifactId = string;
export type TaskId = string;
export type DecisionId = string;
export type EscalationId = string;
export type LeaseId = string;

export const PROTOCOL_VERSION = "1.0";

export type RuntimeTypeName = string;

export type AgentMode = "peer" | "service";

/**
 * How much attention an event deserves in an operator-facing view.
 *
 * Derived from `EventType` through `EVENT_SEVERITY` rather than carried on the
 * wire, for two reasons: `eventSchema` sets `additionalProperties: false`, so a
 * new field on `MeshEvent` makes `JsonlEventStore.append` throw; and deriving it
 * means every event already on disk gets a severity retroactively instead of
 * only those emitted after the change.
 */
export type Severity = "alert" | "notice" | "routine";

export type LifecycleState =
  | "STARTING"
  | "IDLE"
  | "AWAKENED"
  | "OBSERVING"
  | "THINKING"
  | "REQUESTING"
  | "WORKING"
  | "WAITING"
  | "REVIEWING"
  | "BLOCKED"
  | "SUSPENDED"
  | "FAILED"
  | "COMPLETED"
  /**
   * Operator retired the seat. Terminal in a way COMPLETED is not: a completed
   * agent can be woken again for follow-up (`COMPLETED: ["IDLE"]`), a retired
   * one never runs again. Retirement is how capacity leaves a live mesh
   * without editing mesh.yaml and restarting it.
   */
  | "RETIRED";

export type MessageType =
  | "MISSION"
  | "INFORM"
  | "REQUEST"
  | "REQUEST_INFO"
  | "REQUEST_REVIEW"
  | "REQUEST_ARTIFACT"
  | "REQUEST_RESEARCH"
  | "REQUEST_EXECUTION"
  | "PROPOSE"
  | "CHALLENGE"
  | "APPROVE"
  | "REJECT"
  | "VETO"
  | "BLOCK"
  | "DELEGATE"
  | "HANDOFF"
  | "PATCH_READY"
  | "TEST_RESULT"
  | "SECURITY_FINDING"
  | "COMMIT"
  | "ROLLBACK"
  | "ESCALATE"
  | "WAIT"
  | "DONE";

export type MessagePriority = "LOW" | "NORMAL" | "HIGH" | "URGENT";

export type TrustSource =
  | "human"
  | "system"
  | "mesh_decision"
  | "agent"
  | "repository"
  | "external"
  | "tool";

export interface ContentProvenance {
  source: TrustSource;
  trustLevel: number;
}

export type ArtifactType =
  | "ArchitectureDocument"
  | "ADR"
  | "ApiSpec"
  | "DatabaseSchema"
  | "CodePatch"
  | "ReleasePlan"
  | "TestReport"
  | "SecurityReport"
  | "ResearchReport"
  | "Decision"
  | "Requirement"
  | "RequirementsDoc"
  | "TaskSpec"
  | "BenchmarkResult"
  | "DisagreementRecord";

export type ArtifactStatus =
  | "DRAFT"
  | "READY_FOR_REVIEW"
  | "UNDER_REVIEW"
  | "REJECTED"
  | "APPROVED"
  | "VERIFIED"
  | "MERGEABLE"
  | "MERGED"
  | "PROPOSED"
  | "IMPLEMENTED"
  | "QA_VERIFIED"
  | "SECURITY_VERIFIED"
  | "ACCEPTED"
  | "FINAL"
  | "ARCHIVED";

export type ArtifactStateMachineKind = "code" | "release" | "document";

/**
 * Who an artifact is background reading for.
 *
 * `mission` is shared reference material the whole mesh may need to consult —
 * the current architecture, the requirements everyone is building against.
 * `work` is the output of one piece of work: it matters to its owner, its
 * reviewers, and whoever was handed a reference to it, and to nobody else.
 *
 * This distinction used to be a hardcoded list of four artifact TYPES inside
 * the context builder, which made it unstateable: a mesh-wide TestReport could
 * not be shared reference material, and a throwaway ADR draft could not stop
 * being one. It is a property of the artifact because that is what it is.
 */
export type ArtifactScope = "mission" | "work";

export interface ArtifactRef {
  uri: string;
  version?: number;
  digest?: string;
}

export interface Artifact {
  id: ArtifactId;
  name: string;
  type: ArtifactType;
  goalId: GoalId;
  owner: AgentId;
  version: number;
  status: ArtifactStatus;
  contentRef: string;
  digest: string;
  parent?: ArtifactId;
  /**
   * Optional. Absent means "derive it from the type" — see `artifactScope`.
   * Left optional rather than backfilled so that logs written before this
   * existed replay to exactly the same answer they always did.
   */
  scope?: ArtifactScope;
  metadata: Record<string, unknown>;
  provenance: ContentProvenance;
  createdAt: string;
  createdBy: AgentId;
}

export interface Requirement {
  id: string;
  text: string;
}

export interface BudgetHint {
  maxTokens?: number;
  maxTurns?: number;
}

export interface MeshMessage {
  id: MessageId;
  protocolVersion?: string;
  type: MessageType;
  timestamp: string;
  goalId: GoalId;
  from: AgentId;
  to: AgentId[];
  threadId: ThreadId;
  replyTo?: MessageId;
  causationId?: EventId;
  artifactRefs: ArtifactRef[];
  payload: unknown;
  priority: MessagePriority;
  ttl?: string;
  requires?: Requirement[];
  budgetHint?: BudgetHint;
  provenance?: ContentProvenance;
  taskId?: TaskId;
  /**
   * Runtime-owned delivery control. NEVER settable by an agent.
   *
   * `payload` is verbatim agent input, so any routing decision keyed on a
   * payload field is a decision an agent can make for the kernel. This one
   * was: `cacheServed` lived in `payload`, and both the delivery reducer and
   * the scheduler skipped a message carrying it — so a sender could add
   * `payload: { cacheServed: true }` to a REQUEST and get an ask that opens a
   * pending request (parking the recipient's debt and the sender in WAITING)
   * while never landing in any mailbox and never waking anyone. A silent,
   * permanent stall from one key in free-form JSON.
   *
   * `control` is stripped from agent input on every send and re-applied only
   * by the supervisor, which makes forgery structurally impossible rather
   * than merely disallowed.
   */
  control?: MessageControl;
}

/**
 * Kernel-owned envelope fields: the runtime writes these, the schema closes
 * them, and `sanitizeAgentMessageInput` strips them from anything an agent
 * supplies.
 */
export interface MessageControl {
  /**
   * The research cache already answered this; the message is a log record,
   * not mail. Suppresses mailbox delivery and interest activation.
   */
  cacheServed?: boolean;
}

/** Payload keys the runtime once trusted, now reserved and stripped on input. */
export const RESERVED_PAYLOAD_KEYS: readonly string[] = ["cacheServed"];

/**
 * Remove runtime-owned fields from agent-supplied message input.
 *
 * Applied to BOTH `control` and `payload`: the first stops an agent setting
 * the real field, the second stops a legacy reader (or a future one that
 * reaches into `payload`) from finding a forged copy there.
 */
export function sanitizeAgentMessageInput<T extends { payload?: unknown; control?: MessageControl }>(input: T): T {
  const cleaned = { ...input } as T & { payload?: unknown; control?: MessageControl };
  delete cleaned.control;
  const payload = cleaned.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const copy = { ...(payload as Record<string, unknown>) };
    let stripped = false;
    for (const key of RESERVED_PAYLOAD_KEYS) {
      if (key in copy) {
        delete copy[key];
        stripped = true;
      }
    }
    if (stripped) cleaned.payload = copy;
  }
  return cleaned;
}

export type EventType =
  | "goal.created"
  | "goal.budget_changed"
  | "goal.status_changed"
  | "goal.paused"
  | "goal.resumed"
  | "goal.progress"
  | "goal.completed"
  | "goal.reopened"
  | "goal.escalated"
  | "goal.failed"
  /**
   * The mission statement itself was rewritten. The goal is the reference every
   * acceptance judgement is measured against, so a replacement lands as an
   * auditable event carrying the previous text rather than a silent field
   * assignment nobody can diff after the fact.
   */
  | "goal.description_revised"
  | "requirements.created"
  | "requirement.blocked"
  | "requirement.satisfied"
  | "requirement.revised"
  | "requirement.removed"
  | "agent.created"
  | "agent.started"
  | "agent.awakened"
  | "agent.state_changed"
  | "agent.suspended"
  | "agent.resumed"
  | "agent.completed"
  | "agent.failed"
  | "agent.restarted"
  | "agent.replaced"
  | "agent.retired"
  | "thread.created"
  | "message.sent"
  | "message.delivered"
  | "message.rejected"
  | "artifact.created"
  | "artifact.versioned"
  | "artifact.transition"
  | "task.created"
  | "task.claimed"
  | "task.completed"
  | "review.requested"
  | "review.approved"
  | "review.rejected"
  | "patch.created"
  | "patch.ready"
  | "patch.merged"
  | "architecture.approved"
  | "design.question"
  | "dependency.changed"
  | "authentication.changed"
  | "authorization.changed"
  | "release.candidate"
  | "release.transition"
  | "release.accepted"
  | "research.requested"
  | "research.completed"
  | "implementation.completed"
  | "decision.proposed"
  | "decision.ratified"
  | "escalation.requested"
  | "escalation.responded"
  | "escalation.auto_resolved"
  | "deadlock.auto_resolved"
  /**
   * An outstanding ask stopped being outstanding. The ONLY event-sourced way
   * a commitment leaves the ledger, so replay reproduces it exactly.
   */
  | "commitment.discharged"
  | "human.input"
  | "lease.acquired"
  | "lease.released"
  | "memory.updated"
  | "plan.updated"
  | "plan.gate_rejected"
  | "budget.reserved"
  | "budget.consumed"
  | "budget.exceeded"
  | "budget.released"
  | "budget.limit_raised";

export interface MeshEvent<T = unknown> {
  id: EventId;
  seq?: number;
  protocolVersion?: string;
  type: EventType;
  timestamp: string;
  goalId?: GoalId;
  actorId?: string;
  causationId?: EventId;
  correlationId?: string;
  payload: T;
}

export type GoalStatus =
  | "CREATED"
  | "ACTIVE"
  | "PAUSED"
  | "BLOCKED"
  | "CONVERGING"
  | "COMPLETED"
  | "FAILED"
  | "ESCALATED";

/**
 * ASSERTED sits between UNSATISFIED and EVIDENCED: an agent CLAIMED the
 * criterion is met, but the turn that made the claim invoked zero tools, so
 * nothing was read, run, or checked — the claim is the agent's own word.
 *
 * This exists because a live mission ran 138 turns with `toolCalls: 0` on
 * every single one and still closed: agents published TestReports asserting
 * determinism evidence and merged patches without ever invoking a tool, and
 * `requirement.satisfied` fired on peer approval with no verification gate.
 * Only EVIDENCED (or WAIVED) counts toward progress and termination, so an
 * asserted mission stays open and visibly unproven instead of shipping a
 * shell that every projection reported as done.
 */
export type CriterionStatus = "UNSATISFIED" | "ASSERTED" | "EVIDENCED" | "WAIVED";

export interface EvidenceRef {
  kind: string;
  eventId?: EventId;
  artifactRef?: ArtifactRef;
  by?: AgentId;
  recordedAt: string;
  /**
   * Did the turn that produced this evidence actually do anything checkable?
   * false === the claiming agent invoked no tools that turn (see
   * CriterionStatus.ASSERTED). Absent on evidence recorded out of band by the
   * operator, which is verified by definition.
   */
  verified?: boolean;
  /** Tool invocations in the claiming turn — the number `verified` is derived from. */
  toolCalls?: number;
}

export interface AcceptanceCriterion {
  id: string;
  description: string;
  mandatory: boolean;
  status: CriterionStatus;
  evidence: EvidenceRef[];
  /**
   * Artifact URIs the operator already rejected, snapshotted from `evidence`
   * every time the mission is reopened. Re-citing one of these cannot satisfy
   * the criterion again — otherwise a reopen is answered by handing back the
   * identical artifact and the mission re-completes within a tick.
   */
  rejectedEvidence?: string[];
}

export interface GoalBudget {
  tokens: number;
  wallClockMinutes: number;
  maxEvents: number;
}

export interface Goal {
  id: GoalId;
  description: string;
  acceptanceCriteria: AcceptanceCriterion[];
  status: GoalStatus;
  budget: GoalBudget;
  rootThreadId: ThreadId;
  createdAt: string;
  completedAt?: string;
  /**
   * When the operator last reopened this mission. Evidence recorded before it
   * belongs to the round that was rejected and no longer counts toward
   * completion.
   */
  reopenedAt?: string;
}

export type Authority = string;

export interface PromptReference {
  file?: string;
  text?: string;
}

export interface SessionPolicy {
  persistent: boolean;
  maxContextTokens?: number;
}

export interface DelegationPolicy {
  allowDelegation: boolean;
  maxDepth: number;
  maxWorkers: number;
  workerBudgetTokens?: number;
}

export interface CommunicationPolicy {
  mayContact: AgentId[];
  mayBeContactedBy: AgentId[];
}

export interface BudgetPolicy {
  tokens?: number;
  wallClockMinutes?: number;
  maxEvents?: number;
  maxActivations?: number;
}

export interface AgentDefinition {
  id: AgentId;
  role: string;
  mode: AgentMode;
  runtime: RuntimeTypeName;
  model?: string;
  /**
   * Provider-specific reasoning variant (opencode: `low` | `high` | `max`).
   * Inert since that backend was removed — no registered runtime reads it.
   */
  variant?: string;
  /**
   * Capability tokens this seat holds but may not use unaided: the tools they
   * authorize need an operator grant first. Resolved from `requires_approval`,
   * which inherits from `mesh.runtime.requires_approval` when the seat omits it.
   *
   * Listing a token the seat does not hold does nothing — this narrows an
   * existing grant, it never widens one.
   */
  requiresApproval?: string[];
  prompt: PromptReference;
  capabilities: string[];
  authority: Authority[];
  communicationPolicy: CommunicationPolicy;
  interests: string[];
  sessionPolicy: SessionPolicy;
  delegationPolicy: DelegationPolicy;
  budget: BudgetPolicy;
  /**
   * Absent means "off". Optional so that a hand-built AgentDefinition (tests,
   * adapter fixtures, the synthetic worker seat) keeps compiling and keeps
   * behaving exactly as it did before this feature existed.
   */
  hardActions?: HardActionsPolicy;
}

export type PlanStepStatus = "PENDING" | "DONE";

/** One step as the model supplies it: ids and status are optional. */
export interface PlanStepInput {
  id?: string;
  text: string;
  status?: PlanStepStatus;
  /** Hard-action capabilities this step intends to use (see HardActionsPolicy). */
  capabilities?: string[];
}

/** One step after the supervisor has resolved its id and defaults. */
export interface PlanStep {
  id: string;
  text: string;
  status: PlanStepStatus;
  capabilities: string[];
}

/**
 * An agent's PRIVATE working breakdown of the one task it has claimed.
 *
 * Deliberately not a mesh Task: nobody else can claim, delegate or review a
 * plan step. It exists so the agent can track its own sub-steps across turns,
 * and so a hard action can be checked against a step that declared it.
 *
 * Scoped by `taskId`. Staleness is decided at READ time by comparing against
 * AgentRuntimeState.activeTaskId — no reducer ever clears a plan, which keeps
 * the projection a pure function of the log.
 */
export interface AgentPlan {
  taskId?: TaskId;
  steps: PlanStep[];
  revision: number;
  updatedAt: string;
}

/**
 * Whether this agent must plan before acting.
 *
 * `off` (the default everywhere) is a complete no-op: no gate, no prompt
 * section, no events — an existing mesh.yaml behaves bit-identically.
 * `warn` records a `plan.gate_rejected` event but still runs the op.
 * `enforce` rejects the op until some plan step declares the capability.
 *
 * `capabilities` lists which capability tokens are "hard". Only tokens that
 * map to an op via HARD_OP_CAPABILITY can actually be enforced.
 */
export interface HardActionsPolicy {
  mode: "off" | "warn" | "enforce";
  capabilities: string[];
}

export interface AgentRuntimeState {
  agentId: AgentId;
  lifecycle: LifecycleState;
  sessionId?: string;
  mailboxDepth: number;
  activeTaskId?: TaskId;
  currentArtifactIds: ArtifactId[];
  tokensConsumed: number;
  activations: number;
  lastActivityAt: string;
  lastError?: string;
  /**
   * Whether a FAILED agent is expected to restart (persistent session with
   * attempts remaining). The termination manager must not treat a
   * restartable FAILED agent as a mission-ending runtime failure: the
   * supervisor owns the retry, and a watchdog tick landing between
   * `agent.failed` and the restart would otherwise freeze the whole goal
   * over a recoverable blip.
   */
  restartable?: boolean;
  /** Private working breakdown of `activeTaskId`. See AgentPlan. */
  plan?: AgentPlan;
}

export type TaskStatus =
  | "OPEN"
  | "CLAIMED"
  | "IN_PROGRESS"
  | "COMPLETED"
  | "BLOCKED"
  | "CANCELLED";

export interface Task {
  id: TaskId;
  goalId: GoalId;
  title: string;
  description: string;
  createdBy: AgentId;
  assignedTo?: AgentId;
  claimedBy?: AgentId;
  status: TaskStatus;
  requiredCapabilities: string[];
  artifactRefs: ArtifactRef[];
  parentTaskId?: TaskId;
  delegationDepth: number;
  budget: BudgetPolicy;
  createdAt: string;
  completedAt?: string;
}

export type ApprovalKind =
  | "approve"
  | "reject"
  | "pass"
  | "block"
  | "veto"
  | "accept"
  | "merge";

export interface ApprovalRecord {
  id: string;
  goalId: GoalId;
  kind: ApprovalKind;
  subject: string;
  artifactId?: ArtifactId;
  artifactRef?: ArtifactRef;
  actorId: AgentId;
  actorRole: string;
  evidenceEventId: EventId;
  recordedAt: string;
}

export interface Thread {
  id: ThreadId;
  goalId: GoalId;
  subject: string;
  initiator: AgentId;
  artifactRefs: ArtifactRef[];
  participants: AgentId[];
  depth: number;
  parentThreadId?: ThreadId;
  rootThreadId?: ThreadId;
  messageIds: MessageId[];
  status: "OPEN" | "RESOLVED" | "ESCALATED";
  budget: BudgetPolicy;
  createdAt: string;
}

export type DecisionStatus = "PROPOSED" | "RATIFIED" | "REJECTED" | "SUPERSEDED";

export interface DecisionRecord {
  id: DecisionId;
  goalId: GoalId;
  topic: string;
  decision: Record<string, unknown>;
  status: DecisionStatus;
  proposedBy: AgentId;
  approvedBy: AgentId[];
  evidence: ArtifactRef[];
  artifactRef?: ArtifactRef;
  createdAt: string;
  ratifiedAt?: string;
}

export type EscalationStatus = "OPEN" | "RESPONDED" | "AUTO_RESOLVED";

/**
 * Escalations come in two kinds, and the distinction is load-bearing:
 *
 * - `primary`   — a real question only a human can answer (budget exhausted,
 *                 runtime failure, an unanswered request, a deadlock finding).
 *                 It owns its own lifecycle: it stays OPEN until somebody
 *                 decides it.
 * - `derived`   — a *summary* the watchdog computes over the currently-open
 *                 primaries (today: `stalemate`). It carries no decision of
 *                 its own; it is true exactly as long as its supports are
 *                 open. The runtime maintains the invariant
 *                 "a derived card is OPEN iff >=1 supporting primary is OPEN"
 *                 by auto-resolving it, so a derived card can never outlive
 *                 the facts it describes and strand the mission.
 *
 * `supports` lists the primary escalation ids a derived card summarizes. It is
 * empty/absent on primaries.
 */
export type EscalationKind = "primary" | "derived";

export interface Escalation {
  id: EscalationId;
  goalId: GoalId;
  reason: string;
  detail: unknown;
  raisedBy: string;
  conflictKey?: string;
  disagreementArtifactRef?: ArtifactRef;
  status: EscalationStatus;
  /** Defaults to "primary" when absent (older logs predate the field). */
  kind?: EscalationKind;
  /** Primary escalation ids this derived card summarizes. */
  supports?: EscalationId[];
  /**
   * Advisory cards inform the operator but must NOT freeze the goal: the mesh
   * already routed around the problem (e.g. a dead debtor's asks were
   * discharged with notice). Without this every personnel loss becomes a
   * mission-wide freeze behind a card nobody needs to answer urgently.
   * Absent (older logs) means freezing, preserving old behavior on replay.
   */
  advisory?: boolean;
  response?: string;
  createdAt: string;
  respondedAt?: string;
}

export interface WorkspaceLease {
  id: LeaseId;
  artifactId: ArtifactId;
  agentId: AgentId;
  worktreePath: string;
  files: string[];
  acquiredAt: string;
  expiresAt?: string;
  releasedAt?: string;
}

export interface AgentMemoryNote {
  agentId: AgentId;
  key: string;
  value: string;
  updatedAt: string;
  eventId: EventId;
}

export type ActivationReasonKind =
  | "interest_event"
  | "message"
  | "startup"
  | "manual"
  | "recovery"
  | "timer";

export interface ActivationReason {
  kind: ActivationReasonKind;
  eventId?: EventId;
  eventType?: EventType;
  messageId?: MessageId;
  threadId?: ThreadId;
  note?: string;
}

export interface MeshOpSend {
  op: "send";
  type: MessageType;
  to: AgentId[];
  threadId?: ThreadId;
  newThread?: { subject: string; artifactRefs?: ArtifactRef[] };
  replyTo?: MessageId;
  artifactRefs?: ArtifactRef[];
  payload?: unknown;
  priority?: MessagePriority;
  taskId?: TaskId;
  requires?: Requirement[];
  budgetHint?: BudgetHint;
}

export interface MeshOpBroadcast {
  op: "broadcast";
  type: MessageType;
  payload?: unknown;
  artifactRefs?: ArtifactRef[];
}

export interface MeshOpRequestResearch {
  op: "request_research";
  to: AgentId;
  question: string;
  artifactRefs?: ArtifactRef[];
}

export interface MeshOpRespond {
  op: "respond";
  messageId: MessageId;
  type: MessageType;
  payload?: unknown;
  artifactRefs?: ArtifactRef[];
}

/**
 * Close an ask addressed to you WITHOUT answering it.
 *
 * The gap this fills: an agent that cannot or will not answer had no way to
 * say so. It could only stay silent, and silence is indistinguishable from
 * "still working" — so the ask sat until the nudge limit and then escalated
 * to a human as a false stalemate. Now "I am not going to answer this, and
 * here is why" is a first-class, cheap, logged move.
 */
export interface MeshOpDischarge {
  op: "discharge";
  /** The request message being closed. */
  messageId: MessageId;
  /** Why it will not be answered — recorded and shown to the asker. */
  reason: string;
}

export interface MeshOpPublishArtifact {
  op: "publish_artifact";
  name: string;
  type: ArtifactType;
  status?: ArtifactStatus;
  content: string;
  /**
   * Overrides the type-derived default. An agent publishing something the whole
   * mesh should keep in view says so here rather than hoping its type is on a
   * list it cannot see.
   */
  scope?: ArtifactScope;
  metadata?: Record<string, unknown>;
  parentArtifactId?: ArtifactId;
  asVersionOf?: ArtifactId;
}

export interface MeshOpReadArtifact {
  op: "read_artifact";
  artifactRef: string;
  /**
   * Character offset to resume from. Artifact content is the one thing an agent
   * can pull into its own window without limit, so reads are sliced and paged
   * rather than returned whole.
   */
  offset?: number;
}

export interface MeshOpTransitionArtifact {
  op: "transition_artifact";
  artifactId: ArtifactId;
  artifactUri?: string;
  to: ArtifactStatus;
  evidence?: string;
}

export interface MeshOpRequestReview {
  op: "request_review";
  artifactId: ArtifactId;
  artifactUri?: string;
  reviewers: AgentId[];
}

export interface MeshOpApprove {
  op: "approve";
  subject: string;
  artifactId?: ArtifactId;
  artifactUri?: string;
  comment?: string;
  kind?: "approve" | "pass";
}

export interface MeshOpReject {
  op: "reject";
  subject: string;
  artifactId?: ArtifactId;
  artifactUri?: string;
  comment?: string;
}

export interface MeshOpVeto {
  op: "veto";
  subject: string;
  artifactId?: ArtifactId;
  artifactUri?: string;
  comment?: string;
}

export interface MeshOpBlock {
  op: "block";
  subject: string;
  artifactId?: ArtifactId;
  artifactUri?: string;
  reason: string;
}

export interface MeshOpDelegate {
  op: "delegate";
  to: AgentId;
  title: string;
  description: string;
  requiredCapabilities?: string[];
  artifactRefs?: ArtifactRef[];
  budgetHint?: BudgetHint;
}

export interface MeshOpClaimTask {
  op: "claim_task";
  taskId: TaskId;
}

export interface MeshOpCompleteTask {
  op: "complete_task";
  taskId: TaskId;
  summary: string;
  artifacts?: ArtifactRef[];
}

export interface MeshOpCreateTask {
  op: "create_task";
  title: string;
  description: string;
  assignedTo?: AgentId;
  requiredCapabilities?: string[];
  artifactRefs?: ArtifactRef[];
  budgetHint?: BudgetHint;
}

export interface MeshOpProposeDecision {
  op: "propose_decision";
  topic: string;
  decision: Record<string, unknown>;
  evidence?: ArtifactRef[];
}

export interface MeshOpRatifyDecision {
  op: "ratify_decision";
  decisionId: DecisionId;
}

export interface MeshOpEscalate {
  op: "escalate";
  reason: string;
  detail?: unknown;
  conflictKey?: string;
}

export interface MeshOpWait {
  op: "wait";
  reason?: string;
}

export interface MeshOpDone {
  op: "done";
  summary?: string;
}

export interface MeshOpRemember {
  op: "remember";
  key: string;
  value: string;
}

export interface MeshOpPlan {
  op: "plan";
  /** Defaults to the agent's activeTaskId when omitted. */
  taskId?: TaskId;
  steps: PlanStepInput[];
}

export interface MeshOpPlanStep {
  op: "plan_step";
  stepId: string;
  status: PlanStepStatus;
}

export interface MeshOpAcquireLease {
  op: "acquire_lease";
  artifactId: ArtifactId;
  files: string[];
}

export interface MeshOpReleaseLease {
  op: "release_lease";
  artifactId: ArtifactId;
}

export interface MeshOpCommit {
  op: "commit";
  message: string;
  artifactId: ArtifactId;
  files?: string[];
}

export interface MeshOpRequestCommit {
  op: "request_commit";
  artifactId: ArtifactId;
  comment?: string;
}

export interface MeshOpMerge {
  op: "merge";
  artifactId: ArtifactId;
  artifactUri?: string;
  comment?: string;
}

export interface MeshOpSubmitResult {
  op: "submit_result";
  taskId: TaskId;
  result: SubAgentResult;
}

export interface MeshOpSpawnWorker {
  op: "spawn_worker";
  taskSpec: string;
  title: string;
  capabilities?: string[];
  budgetTokens?: number;
}

export type MeshOp =
  | MeshOpSend
  | MeshOpBroadcast
  | MeshOpRequestResearch
  | MeshOpRespond
  | MeshOpDischarge
  | MeshOpPublishArtifact
  | MeshOpReadArtifact
  | MeshOpTransitionArtifact
  | MeshOpRequestReview
  | MeshOpApprove
  | MeshOpReject
  | MeshOpVeto
  | MeshOpBlock
  | MeshOpDelegate
  | MeshOpClaimTask
  | MeshOpCompleteTask
  | MeshOpCreateTask
  | MeshOpProposeDecision
  | MeshOpRatifyDecision
  | MeshOpEscalate
  | MeshOpWait
  | MeshOpDone
  | MeshOpRemember
  | MeshOpPlan
  | MeshOpPlanStep
  | MeshOpAcquireLease
  | MeshOpReleaseLease
  | MeshOpCommit
  | MeshOpRequestCommit
  | MeshOpMerge
  | MeshOpSubmitResult
  | MeshOpSpawnWorker;

export interface SubAgentResult {
  status: "COMPLETED" | "FAILED" | "PARTIAL";
  summary: string;
  artifacts: ArtifactRef[];
  findings: string[];
  risks: string[];
  recommendation: string;
}

export interface AgentInput {
  agentId: AgentId;
  goalId: GoalId;
  activation: ActivationReason;
  context: AgentContextBundle;
  instructions: string;
  /**
   * Best-effort live token callback. Runtimes backed by a streaming backend
   * (opencode SSE) invoke it with text deltas as the model responds; others
   * ignore it. Never fails the turn — streaming is observability only, the
   * authoritative output is still AgentOutput.text. Deltas are forwarded
   * out-of-band (never kernel events) so the event log stays compact.
   */
  onToken?: (delta: string) => void;
  /**
   * Best-effort live tool-activity callback: the tool-side twin of `onToken`.
   * Fires when a call is announced, and again if the backend refines it, so an
   * operator watching a slow turn sees what the agent is doing while it does
   * it -- `AgentOutput.toolCalls` structurally cannot, since it only lands
   * once the turn is over. Same contract as `onToken`: never fails the turn,
   * never a kernel event. Only the streaming path can serve it; a `send`-only
   * runtime has no frames to observe and simply never invokes it.
   */
  onToolEvent?: (ev: AgentEventToolCall | AgentEventToolCallUpdate) => void;
}

export interface AgentOutput {
  text: string;
  operations: MeshOp[];
  /**
   * True when `operations` came from typed tool calls (MCP `mesh_*`, or the
   * equivalent structured adapter payload) rather than from parsing the
   * model's prose.
   *
   * Under `bus.transport: typed-only` the supervisor ignores parsed ops when
   * this is false, so a model that answers in prose gets one visible retry
   * with the error in context instead of a silent zero-op turn that the
   * circuit breaker must Park later.
   */
  typedOps?: boolean;
  tokensUsed: {
    input: number;
    output: number;
    /**
     * Billable work for THIS turn (input + output + reasoning + cache writes).
     * Deliberately excludes `cacheRead`: with persistent sessions the backend
     * replays the whole transcript every turn and reports it as a cache read,
     * so including it charges the entire history again on each turn and grows
     * without bound.
     */
    total: number;
    /** Replayed/cached prompt prefix. Observability only — never billed. */
    cacheRead?: number;
  };
  model?: string;
  modelVersion?: string;
  temperature?: number;
  toolCalls?: Array<{ name: string; args: unknown; resultDigest: string }>;
  summary?: string;
  /**
   * Turn summary the agent declared explicitly via the `done` op, as opposed to
   * `summary`, which is scraped heuristically from the model's prose. Prefer this
   * when present; scraping drifts per model.
   */
  declaredSummary?: string;
  turnId?: string;
  error?: string;
}

export type AgentRuntimeStatus =
  | "RUNNING"
  | "IDLE"
  | "SUSPENDED"
  | "STOPPED"
  | "UNREACHABLE";

export interface AgentSession {
  sessionId: string;
  agentId: AgentId;
  runtime: RuntimeTypeName;
  createdAt: string;
  handle: unknown;
}

export interface RuntimeContext {
  goalId: GoalId;
  meshId: string;
  workspacePath: string;
  busUrl: string;
  agentToken: string;
  rolePromptText: string;
  capabilityGrants: string[];
  /**
   * Capability tokens among `capabilityGrants` whose tools need an operator
   * grant before use. Absent means nothing is gated.
   */
  approvalRequired?: string[];
  /**
   * Tool names the operator has already unlocked for this session.
   *
   * The grant is per tool, not per call: a denied tool call cannot be replayed
   * — the model re-decides on the next turn — so what the operator unlocks is
   * the tool for the rest of the session, and the surface must say so.
   */
  approvalGranted?: string[];
  env: Record<string, string>;
}

/**
 * One frame of a turn while it is still happening.
 *
 * `AgentOutput` is what a turn WAS; `AgentEvent` is what a turn IS DOING. Both
 * exist on purpose: every turn still ends in an `AgentOutput` (folded by
 * `collectAgentOutput` in packages/agent-runtime), so this union can grow
 * toward live tool visibility without moving the ~20 sites that read the
 * struct. A runtime that cannot stream simply omits `AgentRuntime.stream`.
 *
 * Member names mirror ACP's `session/update` variants
 * (agentclientprotocol.com) WITHOUT depending on ACP, so a runtime that later
 * speaks ACP natively maps onto this union rather than translating between two
 * vocabularies that mean the same thing.
 *
 * Deliberately absent: a `plan` member. ACP carries plans as session updates,
 * but here a plan is an op (`MeshOpPlan`, `op: "plan"`) that already flows
 * through `AgentOutput.operations` and is already projected. A second path for
 * the same fact would give the plan gate two sources of truth.
 *
 * Discriminated on `kind`, never on `op`: tests/protocol/ops-contract.test.ts
 * scrapes this file for `op: "..."` and asserts every hit is a mesh op named in
 * the agent instructions, so an `op`-keyed event would break that contract for
 * a reason that has nothing to do with the bus.
 */
export type AgentEvent =
  | AgentEventMessageChunk
  | AgentEventThoughtChunk
  | AgentEventToolCall
  | AgentEventToolCallUpdate
  | AgentEventTurnEnd;

/**
 * Assistant text as it arrives. Observability only: the authoritative text is
 * `AgentEventTurnEnd.text`, because a backend may revise or re-emit content,
 * so the concatenated deltas are not guaranteed to equal the final message.
 */
export interface AgentEventMessageChunk {
  kind: "agent_message_chunk";
  delta: string;
}

/**
 * Reasoning text as it arrives, mirroring the `"thinking"` case this codebase
 * already distinguishes in `DesignerStreamDelta`. Kept separate from
 * `agent_message_chunk` because thinking must never be appended to the visible
 * transcript nor parsed for ops: a `send` op the model quotes while reasoning
 * aloud is not a request to send anything.
 *
 * No agent runtime emits this yet — the Claude pump taps `text_delta` only.
 */
export interface AgentEventThoughtChunk {
  kind: "agent_thought_chunk";
  delta: string;
}

/**
 * A tool invocation, reported when it STARTS rather than after the turn ends.
 * This is what `AgentOutput.toolCalls` structurally cannot give: an operator
 * watching a slow turn needs to see what the agent is doing while it does it.
 */
export interface AgentEventToolCall {
  kind: "tool_call";
  /** Correlates with a later `tool_call_update`. Unique within the turn. */
  toolCallId: string;
  name: string;
  args: unknown;
  /**
   * Digest available at call time. Named for the field it lands in
   * (`AgentOutput.toolCalls[].resultDigest`) and kept here because the Claude
   * adapter has only the arguments when the call is announced; a backend that
   * reports real results refines it via `tool_call_update`.
   */
  resultDigest?: string;
}

/**
 * Terminal state of a call announced earlier by `tool_call`. Correlated by
 * `toolCallId`, never by arrival order: backends interleave concurrent calls,
 * so position in the stream says nothing about which one finished.
 */
export interface AgentEventToolCallUpdate {
  kind: "tool_call_update";
  toolCallId: string;
  status: "completed" | "failed";
  resultDigest?: string;
}

/**
 * The turn's authoritative result. Exactly one of these ends a stream, and a
 * stream that closes without it is a transport failure, not an empty turn.
 *
 * It carries the parsed payload rather than leaving the fold to derive it,
 * because prose parsing is still a per-backend concern today (`parseMeshOps`
 * lives in agent-runtime). Once ops move to typed MCP tools that
 * parsing disappears and these fields thin out to the stream proper.
 */
export interface AgentEventTurnEnd {
  kind: "turn_end";
  /** Why the turn stopped. `error` means the backend reported failure. */
  stopReason: "end_turn" | "error";
  text: string;
  operations: MeshOp[];
  typedOps?: boolean;
  tokensUsed: AgentOutput["tokensUsed"];
  model?: string;
  modelVersion?: string;
  temperature?: number;
  summary?: string;
  declaredSummary?: string;
  /** Present iff `stopReason` is "error". Surfaced as `AgentOutput.error`. */
  error?: string;
}

export interface AgentRuntime {
  readonly name: string;
  start(agent: AgentDefinition, context: RuntimeContext): Promise<AgentSession>;
  send(session: AgentSession, input: AgentInput): Promise<AgentOutput>;
  /**
   * Live event stream for one turn, when the backend can provide one.
   *
   * Optional by design: `send` stays the contract every runtime implements, and
   * a runtime that streams implements `send` as a fold over this (see
   * `collectAgentOutput`) so the two can never drift. The supervisor prefers
   * `stream` when present and falls back to `send` otherwise.
   */
  stream?(session: AgentSession, input: AgentInput): AsyncIterable<AgentEvent>;
  interrupt(session: AgentSession): Promise<void>;
  suspend(session: AgentSession): Promise<void>;
  /**
   * Bring a suspended session back.
   *
   * Carries the definition and context because a runtime that tore its backend
   * down on `suspend` needs both to rebuild: the session struct names the
   * transcript but not how to reopen it. Without them an adapter can only flip
   * a status field and hope the next turn repairs things.
   *
   * Returns the live session — whose handle may differ from the one passed in,
   * since rebuilding can mint a new one — or null when the backend could not be
   * reached, which tells the caller to drop its cached session rather than keep
   * a struct pointing at a query nobody is running.
   */
  resume(session: AgentSession, agent: AgentDefinition, context: RuntimeContext): Promise<AgentSession | null>;
  stop(session: AgentSession): Promise<void>;
  getStatus(session: AgentSession): Promise<AgentRuntimeStatus>;
  restoreSession?(agent: AgentDefinition, sessionId: string, context: RuntimeContext): Promise<AgentSession | null>;
}

/** One turn of designer conversation: persona and model, no mesh session. */
export interface DesignerPromptOptions {
  /** System prompt for this turn (persona/instructions). */
  system?: string;
  /** Per-call model override. Falls back to the runtime's default. */
  model?: string;
  /**
   * Remote MCP endpoint the designer may call for this turn, carrying the
   * staging tools plus read-only observability.
   *
   * The turn is correlated by `headers`, not by anything the model says: a
   * staged mutation has to land in the buffer for THIS turn, and a model that
   * echoes an id can echo the wrong one. The runtime's only job is to pass
   * both through to its MCP client config verbatim.
   */
  mcp?: { url: string; headers?: Record<string, string> };
}

export interface DesignerStreamDelta {
  kind: "text" | "thinking";
  delta: string;
}

export interface DesignerStreamResult {
  reply: string;
  thinking: string;
}

export interface ModelCatalogue {
  models: string[];
  default?: string;
  error?: string;
  variants?: Record<string, string[]>;
}

/**
 * The designer's backend, kept deliberately separate from `AgentRuntime`.
 *
 * These are one-shot prompts with no mesh session, no capability grants and no
 * bus identity — the designer is a human's chat partner while they build a
 * mesh, not a seat inside one. Folding them into `AgentRuntime` would oblige
 * every agent backend to answer questions it has no business answering, so
 * they live here and a runtime opts in by implementing this as well.
 *
 * It exists as a port because `apps/mesh-server` previously held the concrete
 * opencode adapter for exactly these five calls, which made the designer
 * unreachable on any other backend.
 */
export interface DesignerRuntime {
  prompt(text: string, opts?: DesignerPromptOptions): Promise<string>;
  promptStream(
    text: string,
    opts?: DesignerPromptOptions,
    onDelta?: (delta: DesignerStreamDelta) => void,
  ): Promise<DesignerStreamResult>;
  listModels(): Promise<ModelCatalogue>;
  /**
   * Late-bind the bus locator. The HTTP server only learns its port at listen
   * time, which is after the designer backend is constructed.
   */
  setDesignerObserve(provider: () => { busUrl: string; token: string } | undefined): void;
  stopAll(): Promise<void>;
}

/**
 * One change the dashboard assistant wants made, described but NOT performed.
 *
 * The assistant never executes: it stages, the operator commits. That split is
 * the whole design, and it is why this is a data shape rather than a method
 * call — a staged mutation can be shown, diffed, refused, or applied hours
 * later by someone who was not in the conversation that produced it.
 *
 * Two apply targets, and they are not interchangeable:
 *   - `config.replace` rewrites the operator's CLIENT-SIDE draft and still
 *     needs a separate Save. Nothing in the running mesh moves.
 *   - every other kind applies SERVER-SIDE to the live run, immediately.
 * The UI must keep these visibly distinct; see `DESTRUCTIVE_KINDS` for the
 * subset that additionally warrants a typed confirmation.
 */
export type StagedMutation =
  | { kind: "config.replace"; yaml: string; reason?: string }
  | { kind: "goal.description"; description: string; reason?: string }
  | { kind: "criteria.add"; criteria: AcceptanceCriterion[]; reason?: string }
  | { kind: "criteria.edit"; criterionId: string; description?: string; mandatory?: boolean; reason?: string }
  /**
   * `reason` is required here alone. Removing a criterion shrinks the
   * denominator completion is measured over, which can flip a live run to
   * COMPLETED — so the operator gets told why, in words, before they press it.
   */
  | { kind: "criteria.delete"; criterionId: string; reason: string }
  | { kind: "seat.spawn"; agent: AgentDefinition; reason?: string }
  | { kind: "seat.retire"; agentId: AgentId; reason: string }
  | { kind: "seat.suspend"; agentId: AgentId; reason?: string }
  | { kind: "seat.resume"; agentId: AgentId; reason?: string }
  | { kind: "seat.wake"; agentId: AgentId; reason?: string }
  | { kind: "run.pause"; reason?: string }
  | { kind: "run.resume"; reason?: string }
  /**
   * Inline rather than `GoalBudget`: that interface requires `tokens`, and the
   * executor (`Supervisor.adjustGoalBudget`) accepts only these two caps.
   */
  | { kind: "run.budget"; budget: { maxEvents?: number; wallClockMinutes?: number }; reason?: string }
  | { kind: "run.reopen"; criteria?: string[]; reason?: string }
  | { kind: "mission.reset"; reason?: string };

/**
 * Kinds that destroy state a run cannot get back by itself, and so earn an
 * extra confirmation step in the dashboard before they are applied.
 *
 * `run.reopen` is here because it invalidates accepted evidence; `config.replace`
 * because it overwrites the operator's whole working draft.
 */
export const DESTRUCTIVE_KINDS: readonly StagedMutation["kind"][] = [
  "config.replace",
  "criteria.delete",
  "seat.retire",
  "run.reopen",
  "mission.reset",
];

/** A turn's worth of staged mutations, applied in array order. */
export interface StagedProposal {
  id: string;
  createdAt: string;
  mutations: StagedMutation[];
  /**
   * Things the assistant could not stage cleanly (an agent id it could not
   * find, a criterion it was asked to edit that no longer exists). Surfaced to
   * the operator alongside what DID stage, so a partial proposal never reads
   * as a complete one.
   */
  problems: string[];
}

export interface AgentContextBundle {
  rolePrompt: string;
  mission: string;
  relevantPolicies: string[];
  agentState: AgentRuntimeState;
  currentTask?: Task;
  relevantDecisions: DecisionRecord[];
  relevantArtifacts: Array<{ ref: string; type: ArtifactType; status: ArtifactStatus; name: string; version: number }>;
  unreadMail: MeshMessage[];
  recentOwnActivity: string[];
  agentMemory: AgentMemoryNote[];
  /** Count of memory notes dropped by eviction; 0 when nothing was lost. */
  elidedMemory?: number;
  /**
   * Per-section count of what this turn had available but did not include,
   * because a cap cut the list short.
   *
   * Absent keys mean nothing was withheld from that section. Rendered into the
   * prompt so an agent can tell a complete list from the top of a long one —
   * without it, every capped section reads as exhaustive, and an agent shown
   * 3 of 9 open obligations will close 3 and report itself finished.
   */
  omitted?: {
    unread?: number;
    decisions?: number;
    artifacts?: number;
    activity?: number;
    outstanding?: number;
    memory?: number;
  };
  openThreads: Thread[];
  budgetSnapshot: { agentTokensUsed: number; agentTokenBudget: number; missionTokensUsed: number; missionTokenBudget: number };
  /**
   * What this agent is still owed, and what it still owes.
   *
   * Without it a timer-woken agent cannot tell whether anything moved since
   * its last turn, so it re-derives the same conclusion and re-sends the same
   * message — which the fingerprint check then counts as a conflict and
   * escalates. The agent was punished for a repetition the context made
   * unavoidable.
   */
  outstanding: {
    /** Asks this agent made that nobody has answered yet. */
    awaitingResponse: Array<{ messageId: string; to: string[]; type: string; since: string }>;
    /** Asks addressed to this agent that it has not discharged. */
    owedByYou: Array<{ messageId: string; from: string; type: string; since: string }>;
  };
  /**
   * THIS goal's acceptance criteria, verbatim from the goal record.
   *
   * Without it an agent whose L2 memory says "mission complete" (a memory
   * written under a PREVIOUS goal) concludes there is nothing to do and waits
   * — while the active goal's criteria sit unmet. The criteria are the
   * authoritative to-do list; memories are gossip.
   */
  goalCriteria: Array<{ id: string; description: string; status: string; mandatory: boolean }>;
  /**
   * Whether this agent may spawn sub-workers (`spawn_worker` / `submit_result`).
   *
   * Delegation is off by default (v1 flat mesh: `max_depth: 0`), and every
   * attempt is denied. Documenting the ops unconditionally would invite turns
   * that can only fail, so the contract shows them exactly when they are
   * usable.
   */
  delegationEnabled?: boolean;
  /**
   * Whether this agent may satisfy an acceptance criterion — `approve` on
   * `subject: "criterion:<id>"`, as opposed to approving a reviewed artifact.
   *
   * That branch requires `requirements.accept` or `requirements.approve`, and
   * the kernel refuses every other seat. Same "never advertise a rule that
   * cannot fire" discipline as `delegationEnabled` above: a seat without the
   * authority was being told to close criteria it could only be denied for,
   * and each denial then read as an argument for widening its grant.
   */
  criterionAcceptanceEnabled?: boolean;
  /**
   * Effective hard-action policy for this agent: `capabilities` is already
   * intersected with what the agent actually holds AND with the tokens the op
   * layer can enforce, so the prompt never threatens a rule that cannot fire.
   */
  hardActions?: HardActionsPolicy;
}

export interface CreateGoalInput {
  description: string;
  acceptanceCriteria?: Array<Partial<AcceptanceCriterion> & { id?: string; description: string }>;
  budget?: Partial<GoalBudget>;
}

export interface SendResult {
  accepted: boolean;
  messageId?: MessageId;
  eventId?: EventId;
  reason?: string;
  redirectedTo?: AgentId[];
  escalated?: EscalationId;
}

export interface ReplayState {
  goalId: GoalId;
  asOfSeq: number;
  goal?: Goal;
  agents: AgentRuntimeState[];
  artifacts: Artifact[];
  threads: Thread[];
  tasks: Task[];
  decisions: DecisionRecord[];
  approvals: ApprovalRecord[];
  escalations: Escalation[];
  budgets: BudgetProjectionEntry[];
  leases: WorkspaceLease[];
  eventCount: number;
}

export interface BudgetProjectionEntry {
  key: string;
  limit: number | null;
  limitKind: "tokens" | "events" | "wallclock_minutes" | "activations";
  reserved: number;
  consumed: number;
  exceeded: boolean;
}

export interface ArtifactTransition {
  to: ArtifactStatus;
  evidenceEventIds?: EventId[];
  comment?: string;
}

export interface PolicyDecisionResult {
  decision: "ALLOW" | "DENY" | "REDIRECT" | "DEFER" | "ESCALATE";
  reason: string;
  ruleId?: string;
  redirects?: AgentId[];
  escalation?: string;
}
