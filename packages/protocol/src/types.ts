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
  | "COMPLETED";

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
  | "requirements.created"
  | "requirement.blocked"
  | "requirement.satisfied"
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
  /** Provider-specific reasoning variant (opencode: `low` | `high` | `max`). */
  variant?: string;
  prompt: PromptReference;
  capabilities: string[];
  authority: Authority[];
  communicationPolicy: CommunicationPolicy;
  interests: string[];
  sessionPolicy: SessionPolicy;
  delegationPolicy: DelegationPolicy;
  budget: BudgetPolicy;
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
  metadata?: Record<string, unknown>;
  parentArtifactId?: ArtifactId;
  asVersionOf?: ArtifactId;
}

export interface MeshOpReadArtifact {
  op: "read_artifact";
  artifactRef: string;
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
  env: Record<string, string>;
}

export interface AgentRuntime {
  readonly name: string;
  start(agent: AgentDefinition, context: RuntimeContext): Promise<AgentSession>;
  send(session: AgentSession, input: AgentInput): Promise<AgentOutput>;
  interrupt(session: AgentSession): Promise<void>;
  suspend(session: AgentSession): Promise<void>;
  resume(session: AgentSession): Promise<void>;
  stop(session: AgentSession): Promise<void>;
  getStatus(session: AgentSession): Promise<AgentRuntimeStatus>;
  restoreSession?(agent: AgentDefinition, sessionId: string, context: RuntimeContext): Promise<AgentSession | null>;
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
