import type {
  AgentDefinition,
  AgentRuntimeState,
  Artifact,
  ArtifactId,
  BudgetProjectionEntry,
  DecisionRecord,
  Escalation,
  Goal,
  GoalId,
  LeaseId,
  MeshEvent,
  MeshMessage,
  MessageId,
  Task,
  Thread,
  ThreadId,
  WorkspaceLease,
  AgentMemoryNote,
} from "../../protocol/src/index";

export interface PendingRequest {
  messageId: MessageId;
  from: string;
  to: string[];
  type: string;
  threadId: ThreadId;
  taskId?: string;
  createdAt: string;
}

export interface ConflictRecord {
  key: string;
  count: number;
  lastActor: string;
  artifactId?: ArtifactId;
  threadId?: ThreadId;
  firstAt: string;
  lastAt: string;
}

export interface BudgetLedger {
  key: string;
  limitKind: BudgetProjectionEntry["limitKind"];
  limit: number | null;
  reserved: number;
  consumed: number;
  exceeded: boolean;
  reservations: Map<string, number>;
}

export interface AgentRecord {
  definition: AgentDefinition;
  state: AgentRuntimeState;
}

export interface Projections {
  goals: Map<GoalId, Goal>;
  activeGoalId: GoalId | null;
  agents: Map<string, AgentRecord>;
  artifacts: Map<ArtifactId, Artifact>;
  artifactByName: Map<string, Artifact>;
  artifactHistory: Map<ArtifactId, Artifact[]>;
  threads: Map<ThreadId, Thread>;
  messages: Map<MessageId, MeshMessage>;
  unread: Map<string, MessageId[]>;
  tasks: Map<string, Task>;
  decisions: Map<string, DecisionRecord>;
  approvals: Map<string, import("../../protocol/src/index").ApprovalRecord[]>;
  escalations: Map<string, Escalation>;
  budgets: Map<string, BudgetLedger>;
  leases: Map<LeaseId, WorkspaceLease>;
  activeLeaseByArtifact: Map<ArtifactId, LeaseId>;
  memory: Map<string, Map<string, AgentMemoryNote>>;
  pendingRequests: Map<MessageId, PendingRequest>;
  conflicts: Map<string, ConflictRecord>;
  reviewRounds: Map<ArtifactId, number>;
  messageFingerprints: Map<ThreadId, Set<string>>;
  lastEventSeq: number;
  lastEventAt: string | null;
  eventCount: number;
  eventsSinceActivation: Map<string, number>;
  sessionMap: Map<string, { sessionId: string; runtime: string }>;
  goalHistory: Array<{ status: string; at: string; reason?: string }>;
  progress: Map<GoalId, { completed: number; total: number; ratio: number; updatedAt: string }>;
  turnAudit: Map<string, { turnId: string; events: MeshEvent["id"][] }>;
}

export function createInitialState(): Projections {
  return {
    goals: new Map(),
    activeGoalId: null,
    agents: new Map(),
    artifacts: new Map(),
    artifactByName: new Map(),
    artifactHistory: new Map(),
    threads: new Map(),
    messages: new Map(),
    unread: new Map(),
    tasks: new Map(),
    decisions: new Map(),
    approvals: new Map(),
    escalations: new Map(),
    budgets: new Map(),
    leases: new Map(),
    activeLeaseByArtifact: new Map(),
    memory: new Map(),
    pendingRequests: new Map(),
    conflicts: new Map(),
    reviewRounds: new Map(),
    messageFingerprints: new Map(),
    lastEventSeq: 0,
    lastEventAt: null,
    eventCount: 0,
    eventsSinceActivation: new Map(),
    sessionMap: new Map(),
    goalHistory: [],
    progress: new Map(),
    turnAudit: new Map(),
  };
}

export function getBudget(state: Projections, key: string): BudgetLedger | undefined {
  return state.budgets.get(key);
}

export function ensureBudget(
  state: Projections,
  key: string,
  limitKind: BudgetProjectionEntry["limitKind"],
  limit: number | null,
): BudgetLedger {
  let b = state.budgets.get(key);
  if (!b) {
    b = { key, limitKind, limit, reserved: 0, consumed: 0, exceeded: false, reservations: new Map() };
    state.budgets.set(key, b);
  } else if (b.limit === null && limit !== null) {
    b.limit = limit;
  }
  return b;
}

export function artifactKey(type: string, name: string): string {
  return `${type}:${name}`;
}

export function approvalKey(subject: string, kind: string): string {
  return `${subject}::${kind}`;
}
