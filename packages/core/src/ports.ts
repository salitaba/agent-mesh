import type {
  AgentDefinition,
  Artifact,
  ArtifactStatus,
  Goal,
  GoalId,
  MeshEvent,
  MeshMessage,
  PolicyDecisionResult,
  Thread,
} from "../../protocol/src/index";
import type { ResolvedMeshConfig } from "../../config/src/index";
import type { Projections } from "./state";

export interface PolicyContext {
  config: ResolvedMeshConfig;
  projections: Projections;
  goal?: Goal;
}

export interface GateChecker {
  isSatisfied(gate: string, ctx: PolicyContext, subject?: string): { ok: boolean; missing: string[] };
}

export interface PolicyEvaluator extends GateChecker {
  evaluateMessage(
    from: string,
    to: string[],
    message: Pick<MeshMessage, "type" | "threadId" | "payload" | "taskId">,
    ctx: PolicyContext,
  ): PolicyDecisionResult;
  evaluateCapability(actorId: string, capability: string, ctx: PolicyContext): PolicyDecisionResult;
  evaluateAuthority(actorId: string, subject: string, kind: string, ctx: PolicyContext): PolicyDecisionResult;
  evaluateTransition(
    artifact: Artifact,
    to: ArtifactStatus,
    actorId: string,
    ctx: PolicyContext,
  ): PolicyDecisionResult;
  evaluateActivation(agentId: string, event: MeshEvent, ctx: PolicyContext): PolicyDecisionResult;
  checkOwnership(actorId: string, artifactId: string, ctx: PolicyContext): PolicyDecisionResult;
}

export interface ArtifactContentStore {
  writeVersion(artifactId: string, version: number, content: string): Promise<string>;
  read(contentRef: string): Promise<string>;
  exists(contentRef: string): Promise<boolean>;
}

export interface WorkspacePort {
  ensureRepo(): Promise<void>;
  ensureWorktree(agentId: string): Promise<string>;
  commitWorktree(agentId: string, message: string, files?: string[]): Promise<{ commit: string; diffDigest: string; diff: string }>;
  mergeWorktree(artifactId: string, agentId: string, message: string): Promise<{ commit: string }>;
  removeWorktree(agentId: string): Promise<void>;
}

export interface SchedulerActivationRequest {
  agentId: string;
  reason: import("../../protocol/src/index").ActivationReason;
  priority: number;
  /** operator-initiated (wake button / manual API): allowed to run even when the scheduler is parked */
  explicit?: boolean;
}

export type TurnOutcome = "ok" | "blocked" | "failed";

export interface SchedulerPort {
  handleEvent(event: MeshEvent): Promise<void>;
  requestActivation(req: SchedulerActivationRequest): Promise<boolean>;
  notifyTurnFinished(agentId: string): void;
  notifyMailDelivered(agentId: string): void;
  /**
   * How the runner's turn ended. The scheduler uses consecutive non-ok
   * outcomes as its circuit breaker (park poison work instead of spinning
   * instant fail-turns). Optional for mocks.
   */
  noteTurnOutcome?(agentId: string, outcome: TurnOutcome): void;
  /**
   * Is this agent currently parked by the circuit breaker? The stall watchdog
   * asks so it never picks a parked agent as the mission driver — that agent
   * is by definition the one that cannot make progress. Optional for mocks.
   */
  isParkedForBackoff?(agentId: string): boolean;
  pending(): number;
  running(): number;
  start(): void;
  stop(): Promise<void>;
  onIdle(callback: () => void): void;
  /** Clear nudge/escalation suppression for a request (human resolved the stall). Optional for mocks. */
  resetStallTracking?(messageId: string, agentId?: string): void;
}

export interface RuntimeResolver {
  resolve(runtimeName: string): import("../../protocol/src/index").AgentRuntime;
}

export interface SessionRegistryPort {
  record(agentId: string, sessionId: string, runtime: string): Promise<void>;
  lookup(agentId: string): Promise<{ sessionId: string; runtime: string } | null>;
  forget(agentId: string): Promise<void>;
}

export type TerminationAction =
  | { kind: "complete"; goalId: GoalId; reason: string }
  | { kind: "escalate"; goalId: GoalId; reason: string; detail: unknown }
  | { kind: "fail"; goalId: GoalId; reason: string }
  | { kind: "continue" };

export interface SupervisorHooks {
  onEvent?: (event: MeshEvent) => void;
  onAgentTurnStart?: (agentId: string, turnId: string) => void;
  onAgentTurnEnd?: (agentId: string, turnId: string, ok: boolean) => void;
  /**
   * Live token delta for a running turn. Out-of-band observability (never a
   * kernel event): the host forwards it to SSE subscribers. May fire at high
   * frequency — receivers must handle batching/caps themselves.
   */
  onTurnToken?: (turnId: string, agentId: string, delta: string) => void;
}

export type { EventBus } from "./event-bus";

/** Minimal snapshot persistence contract (implemented by persistence pkg). */
export interface SnapshotProvider {
  write(envelope: { meshId: string; throughSeq: number; data: Record<string, unknown[]> }): Promise<void>;
  read(): { meshId: string; throughSeq: number; data: Record<string, unknown[]> } | null;
}
