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
}

export type EventType =
  | "goal.created"
  | "goal.status_changed"
  | "goal.paused"
  | "goal.resumed"
  | "goal.progress"
  | "goal.completed"
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
  | "human.input"
  | "lease.acquired"
  | "lease.released"
  | "memory.updated"
  | "budget.reserved"
  | "budget.consumed"
  | "budget.exceeded"
  | "budget.released";

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

export type CriterionStatus = "UNSATISFIED" | "EVIDENCED" | "WAIVED";

export interface EvidenceRef {
  kind: string;
  eventId?: EventId;
  artifactRef?: ArtifactRef;
  by?: AgentId;
  recordedAt: string;
}

export interface AcceptanceCriterion {
  id: string;
  description: string;
  mandatory: boolean;
  status: CriterionStatus;
  evidence: EvidenceRef[];
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

export interface Escalation {
  id: EscalationId;
  goalId: GoalId;
  reason: string;
  detail: unknown;
  raisedBy: string;
  conflictKey?: string;
  disagreementArtifactRef?: ArtifactRef;
  status: EscalationStatus;
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
}

export interface AgentOutput {
  text: string;
  operations: MeshOp[];
  tokensUsed: {
    input: number;
    output: number;
    total: number;
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
