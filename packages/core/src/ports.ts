import type {
  AgentDefinition,
  AgentEventToolCall,
  AgentEventToolCallUpdate,
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
  /**
   * The product checkout. On the port rather than only on `GitWorkspace`
   * because it is the read-only seats' working directory: in git mode the
   * workspace ROOT is not part of any repository, so a seat pointed there
   * writes files nothing can commit and reads a directory that is not the
   * product. See `Supervisor.agentWorkspace`.
   */
  readonly mainPath: string;
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

/**
 * Why an already-queued agent is not running yet.
 *
 * Deliberately NOT a `PolicyDecisionResult`. Nothing in this layer asks the
 * policy engine, so there is no decision, no `ruleId` and no authored sentence
 * to transport; synthesizing one would put text the policy never produced
 * behind `lastActivationRefusal`, which every `message.rejected` consumer reads
 * as policy output. The two states also differ in kind: a policy refusal means
 * the agent was never queued, while a wait means it IS queued and merely has no
 * slot. Calling that second one "refused" cries wolf on a state that normally
 * clears within a turn.
 */
export type QueueWaitKind =
  /** the agent already has a turn in flight; this activation runs after it */
  | "busy"
  /** a `scheduling.concurrency.*` ceiling is full */
  | "capacity"
  /** the scheduler is parked and this activation is not an explicit wake */
  | "stopped";

export interface QueueWait {
  agentId: string;
  kind: QueueWaitKind;
  /** The ceiling that bound and the live count against it (`capacity` only). */
  limit?: number;
  running?: number;
  /** Raw config key an operator would raise to lift it (`capacity` only). */
  configKey?: string;
}

export interface SchedulerPort {
  handleEvent(event: MeshEvent): Promise<void>;
  requestActivation(req: SchedulerActivationRequest): Promise<boolean>;
  notifyTurnFinished(agentId: string): void;
  /**
   * How the runner's turn ended. The scheduler uses consecutive non-ok
   * outcomes as its circuit breaker (park poison work instead of spinning
   * instant fail-turns). Optional for mocks.
   */
  noteTurnOutcome?(agentId: string, outcome: TurnOutcome): void;
  /**
   * The policy refusal still blocking this agent, so a caller can report the
   * reason rather than infer one from a false. Optional for mocks.
   */
  lastActivationRefusal?(agentId: string): PolicyDecisionResult | undefined;
  /**
   * Is this agent currently parked by the circuit breaker? The stall watchdog
   * asks so it never picks a parked agent as the mission driver — that agent
   * is by definition the one that cannot make progress. Optional for mocks.
   */
  isParkedForBackoff?(agentId: string): boolean;
  /**
   * Why each queued agent is still waiting, computed live against the current
   * queue. The console needs a channel that is NOT the event log: capacity
   * waits resolve constantly, so an event per block would bury the log under a
   * state that clears itself. Optional for mocks.
   */
  queueWaits?(): QueueWait[];
  /**
   * How many events a triage rule dropped this mission. Polled like
   * `queueWaits` and for a related reason — the drop emits nothing — but it is
   * not a wait: nothing is queued and nothing will resolve. Optional for mocks.
   */
  triagedAwayCount?(): number;
  pending(): number;
  running(): number;
  start(): void;
  stop(): Promise<void>;
  onIdle(callback: () => void): void;
  /** Clear nudge/escalation suppression for a request (human resolved the stall). Optional for mocks. */
  resetStallTracking?(messageId: string, agentId?: string): void;
  /**
   * Drop every per-mission counter (strikes/backoff parking, nudge and denial
   * counts, stall suppression, queue). Reopening a finished mission must call
   * this or the new round inherits the exhaustion of the round that just
   * ended. Caller stops the scheduler first. Optional for mocks.
   */
  resetMissionState?(): void;
}

export interface RuntimeResolver {
  resolve(runtimeName: string): import("../../protocol/src/index").AgentRuntime;
}

/**
 * Derives acceptance criteria from a mission goal, for missions that boot
 * without hand-written `acceptance_criteria`.
 *
 * Optional on purpose: it is the only port here that reaches a model before
 * the mission exists, so a mesh without one (or with generation disabled)
 * falls back to `DEFAULT_CRITERIA` exactly as it did before. Implementations
 * return `null` rather than throwing when the model is unreachable or answers
 * unusably — a mission must not fail to start because criteria generation did.
 */
export type CriteriaGeneratorPort = (
  goalText: string,
) => Promise<import("./criteria").GeneratedCriterion[] | null>;

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
  /**
   * Live tool activity for a running turn. Same out-of-band contract as
   * `onTurnToken` (never a kernel event; the host forwards it to SSE), and the
   * same inverted arg order as its neighbour for symmetry. Fires only on the
   * streaming path, so a `send`-only runtime reports tool calls just once, in
   * `AgentOutput.toolCalls`, after the turn ends.
   */
  onTurnToolEvent?: (turnId: string, agentId: string, ev: AgentEventToolCall | AgentEventToolCallUpdate) => void;
}

export type { EventBus } from "./event-bus";

/** Minimal snapshot persistence contract (implemented by persistence pkg). */
export interface SnapshotProvider {
  write(envelope: { meshId: string; throughSeq: number; data: Record<string, unknown[]> }): Promise<void>;
  read(): { meshId: string; throughSeq: number; data: Record<string, unknown[]> } | null;
}
