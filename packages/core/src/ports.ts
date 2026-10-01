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
  /**
   * Land one artifact's work on the product branch.
   *
   * `commit` is the sha `opCommit` recorded on the artifact. Pass it and the
   * merge is scoped to THAT commit and its ancestors; omit it and the whole
   * agent branch merges, which also lands commits the approval never covered;
   * that arm reports what it over-merged through `leftBehind`.
   *
   * The parameter is REQUIRED (its value may still be undefined). It used to be
   * optional so pre-fix test doubles kept compiling, and the effect was that no
   * double ever had to model the scoped arm at all. `tests/support/fake-workspace.ts`
   * is the one double; change it with the port.
   *
   * `alreadyUpToDate` distinguishes "nothing to do" from "landed": `git merge`
   * exits 0 on an up-to-date branch, so without it a merge that moved nothing
   * is indistinguishable from one that did.
   */
  mergeWorktree(
    artifactId: string,
    agentId: string,
    message: string,
    commit: string | undefined,
  ): Promise<{ commit: string; alreadyUpToDate?: boolean; leftBehind?: string[] }>;
  removeWorktree(agentId: string): Promise<void>;
  /**
   * Uncommitted changes to tracked files in the PRODUCT checkout, saved under a ref and removed, so the
   * merge that follows lands on a clean checkout; null when there are none. Work reaches the product
   * checkout through `mergeWorktree` alone, so anything uncommitted there was written directly, is on no
   * branch, and would make `git merge` refuse ("your local changes would be overwritten") for every
   * landing after it. Optional because only a git workspace can answer it.
   */
  setAsideProductChanges?(): Promise<{ files: string[]; ref: string } | null>;
  /**
   * Uncommitted state of an agent's worktree, or null when it has none.
   *
   * Required, not optional-for-mocks: while it was optional the untracked-work
   * detector bailed on every double and was a no-op in the whole suite. Its one
   * caller warns a seat that wrote files and never committed them -- work that
   * is in no repository, invisible to reviewers, and archived rather than
   * landed by the next reset.
   */
  worktreeState(agentId: string): Promise<WorktreeState | null>;
  /**
   * Snapshot an agent's uncommitted worktree (tracked changes AND untracked,
   * non-ignored files) as a commit stored under `ref`, WITHOUT touching the
   * branch, the index, or any file in the worktree. Null when there is nothing
   * to snapshot or the snapshot was skipped (too many files, git failure).
   *
   * Taken when a turn is stopped mid-work, so the files it wrote survive a
   * later reset or a retry that overwrites them. Optional because only a git
   * workspace can answer it; test doubles that never write files omit it.
   */
  checkpointWorktree?(agentId: string, ref: string, message: string): Promise<{ commit: string; files: string[] } | null>;
  /**
   * Bring an agent's worktree up to the product branch, if it can be done without
   * touching anything the seat wrote: a fast-forward of a clean worktree that holds no
   * commits of its own. Null when the seat has no worktree. Called at the start of a
   * seat's turn, when nothing of that seat is running in it.
   *
   * A worktree is a separate checkout, not a view of the product branch, and a merge
   * does not move it: QA twice tested its own worktree after `main` had moved and
   * issued `quality.block` verdicts on defects that were already fixed. Optional
   * because only a git workspace can answer it.
   */
  syncWorktree?(agentId: string): Promise<WorktreeSync | null>;
  /**
   * Is `commit` part of what this seat's worktree has checked out: an ancestor of its HEAD, or
   * its HEAD? Null when the seat has no worktree or git cannot say (an unknown commit).
   *
   * Asked when a seat publishes a verification report, to record whether the commit of the patch
   * it read is in the tree it ran the tests in. A worktree that does not hold the commit cannot
   * have tested it, whatever the report says: the fourth cronlite run's QA read a patch as text
   * and re-typed its files into a worktree that held only the scaffold commit. Optional because
   * only a git workspace can answer it.
   */
  containsCommit?(agentId: string, commit: string): Promise<boolean | null>;
}

/** What bringing a seat's worktree up to the product branch did. See `WorkspacePort.syncWorktree`. */
export interface WorktreeSync {
  /** The product branch, and its tip (short sha). */
  base: string;
  baseCommit: string;
  /** Commits of the product branch the worktree lacked when the turn began. */
  behind: number;
  /** Commits on the seat's branch that the product branch lacks. */
  ahead: number;
  /**
   * `current`: nothing to bring in. `advanced`: fast-forwarded to the product branch.
   * `blocked`: behind, and could not be advanced; `why` names what stands in the way.
   */
  outcome: "current" | "advanced" | "blocked";
  why?: string;
}

/** What a seat has in its worktree that has not reached the product. */
export interface WorktreeState {
  agentId: string;
  /** Paths reported by `git status --porcelain`, tracked-but-modified included. */
  dirty: string[];
  /** How many of `dirty` are untracked (`??`) -- files no commit would pick up by name. */
  untracked: number;
  /** Commits on the agent branch that are not on the product branch. */
  unmergedCommits: string[];
  /** The worktree's HEAD (short sha), when git could say. */
  head?: string;
}

export interface SchedulerActivationRequest {
  agentId: string;
  reason: import("../../protocol/src/index").ActivationReason;
  priority: number;
  /**
   * Jumps the seat's own quiet gates: runs on a parked (stopped) scheduler,
   * past circuit-breaker parking, and is never dropped as a stale interest
   * wake. Set by every operator wake, and by the supervisor's handover re-queue
   * (a wake the mesh's own bookkeeping turn consumed).
   */
  explicit?: boolean;
  /**
   * The operator asked for this turn (wake button, a message sent with `wake`,
   * a staged wake, a reopen) — the one wake the provider breaker admits while
   * it is open. Always set together with `explicit`; never set by a runtime
   * path, however urgent, since every such turn is one more refusal (and on a
   * 429, one more paid prefix) against a provider that is known to be down.
   */
  operator?: boolean;
}

/**
 * `outage` is a turn the model PROVIDER refused (see `classifyProviderOutage`).
 * It feeds the scheduler's mission-wide provider breaker and never strikes the
 * seat: the seat did nothing wrong, and parking it is how a provider outage
 * used to take every seat down one by one.
 */
export type TurnOutcome = "ok" | "blocked" | "failed" | "outage";

export interface TurnOutcomeDetail {
  /**
   * The runtime call returned a model answer, so the provider was reachable
   * and serving for this turn. The only evidence that closes a half-open
   * provider breaker: a budget refusal at the door (`blocked`) never reached
   * the provider and proves nothing about it.
   */
  providerAnswered?: boolean;
  /** `outage` only: the error exactly as the runtime surfaced it. */
  error?: string;
}

export type ProviderBreakerState = "closed" | "open" | "half_open";

/**
 * The provider breaker as the supervisor (and the console) reads it. Episode
 * figures count from the trip that opened it until the probe that closes it.
 */
export interface ProviderBreakerSnapshot {
  state: ProviderBreakerState;
  /** When this episode's first trip happened (epoch ms); 0 while closed. */
  openedAt: number;
  /** Turns that failed with a provider outage this episode, the trip's own included. */
  failedTurns: number;
  /** Seats those turns belonged to, in first-failure order. */
  seats: string[];
  /** The most recent outage error, verbatim. */
  lastError: string;
  /** How many times this episode has opened: 1 on the trip, +1 per failed probe. */
  opens: number;
  /** The backoff the breaker is (or was last) sitting out, in ms. */
  backoffMs: number;
  /** `open` only: when the next probe will be admitted (epoch ms). */
  nextProbeAt?: number;
  /** The seat whose turn is (or was) the probe, once one was admitted. */
  probe?: string;
}

export interface ProviderBreakerTransition {
  from: ProviderBreakerState;
  to: ProviderBreakerState;
  why: "tripped" | "backoff_elapsed" | "operator" | "probe_failed" | "probe_succeeded";
  snapshot: ProviderBreakerSnapshot;
}

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
  | "stopped"
  /** the provider breaker is open (or half-open with its probe running) */
  | "provider";

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
  noteTurnOutcome?(agentId: string, outcome: TurnOutcome, detail?: TurnOutcomeDetail): void;
  /**
   * The mission-wide half of the breaker: the model provider, not a seat.
   * Optional for mocks; absent reads as closed.
   */
  providerBreaker?(): ProviderBreakerSnapshot;
  /**
   * Stop sitting out the backoff and admit the probe now (the operator answered
   * the `provider_unavailable` card). True when an open breaker went half-open.
   */
  probeProviderNow?(): boolean;
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
  /**
   * Every deliberate interest-wake drop this mission, by reason (triage IGNORE,
   * escalation hold, redundant observation). Polled like `triagedAwayCount`,
   * which is one of its entries. Optional for mocks.
   */
  suppressedWakes?(): Record<string, number>;
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
  /** Every row, so boot can reconcile the registry against the log and the roster. */
  list?(): Promise<Array<{ agentId: string; sessionId: string; runtime: string; updatedAt: string }>>;
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
