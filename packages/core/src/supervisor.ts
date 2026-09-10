import * as fs from "fs";
import * as path from "path";
import {
  PROTOCOL_VERSION,
  digestOf,
  ARTIFACT_TYPES,
  INITIAL_ARTIFACT_STATUS,
  artifactMachineOf,
  validateMessage,
  type AcceptanceCriterion,
  type AgentDefinition,
  type AgentInput,
  type AgentOutput,
  type AgentRuntime,
  type AgentRuntimeStatus,
  type Artifact,
  type ArtifactRef,
  type ArtifactStatus,
  type CreateGoalInput,
  type DecisionRecord,
  type Escalation,
  type EscalationKind,
  type EventType,
  type Goal,
  type GoalId,
  type LifecycleState,
  type MeshEvent,
  type MeshMessage,
  type MeshOp,
  type MessageType,
  type ReplayState,
  type RuntimeContext,
  type SendResult,
  type SubAgentResult,
  type Task,
  type Thread,
  type ActivationReason,
  type ApprovalKind,
  type BudgetHint,
  type PolicyDecisionResult,
  type TrustSource,
} from "../../protocol/src/index";
import { newArtifactId, newDecisionId, newEscalationId, newGoalId, newLeaseId, newMessageId, newTaskId, newThreadId, shortHash } from "../../protocol/src/index";
import { BackendUnreachableError, isConnectionError, isTimeoutError } from "../../protocol/src/index";
import { sanitizeAgentMessageInput } from "../../protocol/src/index";
import { artifactKey, approvalKey, ensureBudget, INFERRED_DISCHARGE_REASONS, MAX_PENDING_REQUESTS, outstandingDebtors, PER_DEBTOR_DISCHARGE_REASONS, stillOwes, UNANSWERED_DISCHARGE_REASONS } from "./state";
import type { DischargeReason, Projections } from "./state";
import { applyEvent, artifactForRef, capabilityForReview, checkApprovals, domainOfSubject, hasPeerReviewerFor, holdsAuthority, transitionLifecycle } from "./projections";
import type { Kernel } from "./kernel";
import { KernelRejectedError } from "./kernel";
import type { BudgetManager } from "./budgets";
import { agentKey, missionKey, taskKey, threadKey } from "./budgets";
import type {
  ArtifactContentStore,
  PolicyEvaluator,
  RuntimeResolver,
  SchedulerActivationRequest,
  SchedulerPort,
  SessionRegistryPort,
  SupervisorHooks,
  WorkspacePort,
} from "./ports";
import type { ResolvedMeshConfig } from "../../config/src/index";
import { buildAgentContext, renderContextInstructions } from "./context";
import type { ContextLimits } from "./context";
import { DeadlockDetector, TerminationManager, type DeadlockFinding } from "./termination";
import { refToString, artifactUri } from "../../protocol/src/uri";
import { TurnTracker, RECENT_TURNS_MAX, MAX_DELIVERED_PER_TURN, describeError, type TurnRecord, type TurnPhaseName, type TurnTrackerPersist } from "./turn-tracker";
import {
  MISSION_HALTED_ALLOW_OPS,
  MISSION_OVER_ALLOW_OPS,
  haltedGoalStatus,
  haltReasonText,
} from "./mission-guards";

export interface SupervisorDeps {
  config: ResolvedMeshConfig;
  kernel: Kernel;
  store: import("../../event-store/src/index").EventStore;
  budget: BudgetManager;
  policy: PolicyEvaluator;
  scheduler: SchedulerPort;
  runtimes: RuntimeResolver;
  content: ArtifactContentStore;
  workspace?: WorkspacePort;
  sessionRegistry?: SessionRegistryPort;
  hooks?: SupervisorHooks;
  auditFile?: string;
  /** JSONL sidecar for the in-memory turn ring, restored on boot. */
  turnsFile?: string;
}

export interface OpResult {
  ok: boolean;
  op: MeshOp["op"];
  eventId?: string;
  messageId?: string;
  artifactId?: string;
  artifactUri?: string;
  taskId?: string;
  reason?: string;
  artifact?: Artifact;
  escalationId?: string;
}

export const HUMAN_AGENT_ID = "human";

export const DEFAULT_CRITERIA: Array<Partial<AcceptanceCriterion> & { description: string }> = [
  { id: "requirements-documented", description: "Requirements are documented in a RequirementsDoc artifact accepted by PM", mandatory: true },
  { id: "architecture-approved", description: "Architecture approved by architect and tech-lead", mandatory: true },
  { id: "implementation-merged", description: "Implementation patches reviewed and merged", mandatory: true },
  { id: "quality-verified", description: "QA verification passed with test report evidence", mandatory: true },
  { id: "security-verified", description: "Security verification passed with scan evidence", mandatory: true },
];

/**
 * Cold-start size AND ceiling for the per-turn pre-flight hold. It is not an
 * estimate of anything — no agent's turn is known to cost 32k — it is the
 * pessimistic bound used before that agent has spent a single token. Once real
 * turns have been observed, `sizedTurnReserve` shrinks the hold towards what
 * that agent actually spends, so a nearly-empty ledger can still admit a cheap
 * turn instead of refusing every turn as if it were the worst case.
 *
 * `budgets.thread.reserve_tokens` overrides the ceiling for thread ledgers.
 */
const TURN_RESERVE_TOKENS = 32000;

/**
 * Never reserve less than this, however cheap the agent's history looks: a
 * hold smaller than one plausible turn is a hold that cannot bind, and an
 * agent whose first turns were trivial can still emit a large one next.
 */
const MIN_TURN_RESERVE_TOKENS = 4000;

/**
 * Weight of the newest observation in the per-agent rolling estimate. 0.3
 * tracks a genuine shift in behaviour within a few turns while ignoring a
 * single freak turn.
 */
const TURN_COST_EWMA_ALPHA = 0.3;

/**
 * Safety factor on the estimate: turns vary, so hold noticeably more than the
 * running average or the hold under-covers roughly half the time.
 */
const TURN_COST_SAFETY_FACTOR = 1.5;

// Bounds for the in-memory turn trace shown in the Steps drawer. 200 turns *
// 20k chars ≈ 4MB worst case — acceptable for live inspection, and the ring
// evicts oldest first. The drawer truncates display further client-side.
/**
 * Retries granted to a turn that timed out while the backend stayed reachable.
 * Deliberately larger than the 3-restart crash budget: a slow model is not a
 * broken one, and the previous shared budget suspended healthy agents.
 */
const MAX_TIMEOUT_RETRIES = 5;
const MAX_TURN_TEXT_CHARS = 20000;
const MAX_TURN_INSTRUCTIONS_CHARS = 8000;
const MAX_TURN_TOOLCALLS = 30;

/**
 * Floor for artifact content cited as evidence for a MANDATORY criterion.
 *
 * Deliberately low: this is a stub detector, not a quality bar. It exists
 * because agents were publishing placeholders ("TODO: write the design doc",
 * "See discussion above") and immediately accepting a mandatory criterion
 * against them. Anything that genuinely documents requirements, an
 * architecture, or a test result clears 400 chars without trying; nothing that
 * is a promise-to-write does.
 */
const MIN_EVIDENCE_CONTENT_CHARS = 400;

/** Placeholder markers that disqualify content from evidencing a criterion. */
const EVIDENCE_STUB_MARKERS = /^\s*(tbd|todo|n\/a|none|pending|placeholder|coming soon|see above|as discussed)\b/i;

/**
 * Tool invocations that could have CHECKED something, as opposed to merely
 * talking to the mesh.
 *
 * `mesh_*` are the bus tools — send, publish, approve, merge. Issuing them is
 * how a typed turn acts at all, so counting them as verification would make
 * the gate self-satisfying: "I approved it, therefore it is verified." Only
 * tools that touch the world outside the mesh (a shell, a file read, a test
 * runner) can distinguish a claim from a check.
 */
function verificationToolCount(toolCalls: Array<{ name: string }> | undefined): number {
  return (toolCalls ?? []).filter((t) => !String(t.name ?? "").startsWith("mesh_")).length;
}


interface TurnState {
  turnId: string;
  agentId: string;
  reason: ActivationReason;
  sentOps: number;
  publishedOps: number;
  waitRequested: boolean;
  escalated: boolean;
  results: OpResult[];
  /** Artifacts published by THIS turn, in order — lets a later op in the same
   *  turn (e.g. request_review) refer to "the artifact I just published" when
   *  the model's URI guess doesn't resolve. */
  publishedIds?: string[];
}

export class Supervisor {
  private sessions = new Map<string, { session: import("../../protocol/src/index").AgentSession; runtime: AgentRuntime }>();
  private turnInFlight = new Set<string>();
  /** Turn ids the silence detector already interrupted — one interrupt per turn. */
  private interruptedTurnIds = new Set<string>();
  private restartAttempts = new Map<string, number>();
  /**
   * Consecutive turn failures caused by a dead backend, per agent. Unlike
   * `restartAttempts` (which historically never reset), both counters reset
   * on the next successful runtime response — a failure from last week must
   * not force an immediate escalation today.
   */
  private unreachableStreak = new Map<string, number>();
  /**
   * Consecutive turns that hit *our* deadline while the backend stayed
   * reachable. Kept apart from `restartAttempts` so a thinking model never
   * consumes the crash budget, and reset on any successful runtime response.
   */
  private timeoutRetries = new Map<string, number>();
  private workerInfo = new Map<string, { parent: string; taskId: string; depth: number }>();
  private startedAt = Date.now();
  private detector: DeadlockDetector;
  private termination = new TerminationManager();
  private watchdogChain: Promise<void> = Promise.resolve();
  /**
   * In-flight escalation creations keyed by conflictKey. `escalate()` has to
   * await artifact creation between "is there already one?" and "emit it",
   * which is a window wide enough for a concurrent caller (an agent escalating
   * while the watchdog derives its summary) to slip through and create a
   * duplicate. Reserving the key here closes that window.
   */
  private escalationsInFlight = new Map<string, Promise<Escalation>>();
  /**
   * The watchdog scans whole-state collections (tasks, budgets, escalations)
   * on EVERY event; turn bursts (deliveries, budget churn) fire dozens of
   * events per second, so unthrottled it burns steady CPU on the event loop
   * and delays HTTP. Throttled to 1 scan/sec with a guaranteed trailing run
   * so no finding is ever lost — a sub-second delay is immaterial here.
   */
  private watchdogLastRun = 0;
  private watchdogTrailing = false;
  private stopping = false;
  private idleCallbacks: Array<() => void> = [];
  private recentTurns: TurnRecord[] = [];
  private activeTurnByAgent = new Map<string, string>();
  /**
   * Non-`mesh_*` tool invocations made by the turn currently in flight, keyed
   * by agent id. Written as soon as the runtime answers (before the op loop
   * runs, which is where evidence claims are made) and cleared when the turn
   * settles.
   *
   * This is what lets `markCriterionEvidence` tell a CHECK from a CLAIM: an
   * agent asserting "quality verified" from a turn that ran no tool did not
   * verify anything. Absent entry === no turn context (operator / system
   * path), which is treated as verified.
   */
  private turnVerificationTools = new Map<string, number>();
  /**
   * Rolling estimate of what ONE turn by this agent costs, in tokens, used to
   * size the pre-flight hold instead of charging every agent the same 32k.
   *
   * Deliberately in memory only: it is a heuristic that re-learns within a few
   * turns after a restart, and persisting it would mean a stale estimate from
   * an old model/prompt outliving the thing it measured.
   */
  private turnCostEstimate = new Map<string, number>();
  private readonly turns: TurnTracker;
  /**
   * Stall safety net. The event-driven watchdog never fires when the mesh is
   * fully quiet, so an ACTIVE mission with an empty scheduler and no
   * in-flight turns would sit IDLE forever (e.g. every turn parsed zero ops).
   * This unref'd interval re-wakes the mission driver instead. Cooldown +
   * live-mode gate keep parked consoles and tests silent.
   */
  private stallTimer?: NodeJS.Timeout;
  private liveMode = false;
  private lastTurnAt = Date.now();
  private lastStallNudgeAt = 0;
  /**
   * When a turn provably changed NOTHING (zero ops, all rejected, or only
   * wait/done/remember), the stall watchdog may fire again once this instant
   * passes instead of waiting the full idle + cooldown. A no-op turn restarts
   * the stall clock for no reason, so without this a stalled mission crawls at
   * minutes per attempt — the "lost 2 minutes" between turns. Armed in
   * `runTurn`'s tail, consumed by `checkStall`.
   */
  private stallNoopRetryAt = 0;
  /** One-shot timer that fires `checkStall` exactly at the no-op retry bound. */
  private stallNoopTimer?: NodeJS.Timeout;
  /**
   * QUIESCENCE. Consecutive stall nudges that produced no work, mission-wide.
   *
   * The stall watchdog exists to un-stick a mission that still has work. It
   * has no way to tell that apart from a mission that is simply FINISHED but
   * cannot be closed (e.g. stale OPEN tasks block the completion verdict).
   * In that state every nudge costs a full context window to be told "done" —
   * one live run burned 325k tokens, 51% of the mission, on 41 turns that
   * wrote nothing.
   *
   * So the watchdog rests once `wakeValue()` shows nobody has anything to do.
   * Any real event (a message, an artifact, a decision) clears this: the mesh
   * goes quiet, not deaf. This flag exists only to keep the audit log to one
   * line per rest period; `wakeValue()` is the actual gate and is recomputed
   * from state every tick, so a stale flag can never keep the mesh asleep.
   */
  private quiesced = false;

  constructor(public readonly deps: SupervisorDeps) {
    // Restore the persisted turn ring before anything can push a turn; the
    // in-memory tracker is the only home of per-turn rich data (phases,
    // opTimings, text), and without this a restart loses every trace of it.
    this.turns = new TurnTracker(this.deps.turnsFile ? this.turnsPersistAdapter() : undefined);
    this.detector = new DeadlockDetector(deps.config);
    deps.scheduler.onIdle?.(() => this.onIdle());
    deps.kernel.subscribe((event) => {
      // Real work re-arms the watchdog. Without this, quiescence would be a
      // one-way door: a mesh that rested could never be re-woken by a human
      // message or a late artifact, which is a deadlock wearing a cost saving
      // as a disguise.
      if (isProgressEvent(event.type)) this.quiesced = false;
      this.scheduleWatchdog(!isBookkeepingEvent(event.type));
    });
  }

  /** Late-bind the scheduler to break the construction-order cycle (no Proxy). */
  setScheduler(scheduler: SchedulerPort): void {
    (this.deps as { scheduler: SchedulerPort }).scheduler = scheduler;
    scheduler.onIdle?.(() => this.onIdle());
  }

  get state(): Projections {
    return this.deps.kernel.state;
  }

  get config(): ResolvedMeshConfig {
    return this.deps.config;
  }

  /**
   * Mirror the instance's live/parked mode into the supervisor.
   *
   * `goLive()` (the dashboard's ▶ Start Mission) used to flip the INSTANCE's
   * mode and start the scheduler but never told the supervisor — whose
   * `liveMode` is what `checkStall` reads — so a console-booted mesh that was
   * sent live had a permanently dead stall watchdog: agents finished their
   * startup turns, went WAITING, and nothing ever woke them again. This is
   * the "no active agents, all waiting" state.
   */
  setLiveMode(live: boolean): void {
    this.liveMode = live;
    // Restart the quiet window from NOW: going live should give the mission a
    // fresh STALL_IDLE_MS before the first nudge, and un-park must forget any
    // cooldown the previous live period earned.
    this.lastTurnAt = Date.now();
    if (this.stallNoopTimer) {
      clearTimeout(this.stallNoopTimer);
      this.stallNoopTimer = undefined;
    }
    this.stallNoopRetryAt = 0;
    this.lastStallNudgeAt = 0;
    this.quiesced = false;
  }

  /**
   * The semantic lens every replay of THIS mesh must use. Reducer behaviour
   * is config-parameterized now (commitment inference on/off), so a replay
   * that drops the semantic re-derives a different history than the live
   * mesh did — exactly the class of live-vs-replay divergence the commitment
   * ledger was built to eliminate.
   */
  projectionConfig(): { transitionGates: Record<string, string[]>; commitmentSemantic: "compat" | "strict" } {
    return {
      transitionGates: this.config.transitionGates,
      commitmentSemantic: this.config.bus.commitmentSemantic,
    };
  }

  private auditLine(msg: string): void {
    if (!this.deps.auditFile) return;
    try {
      fs.mkdirSync(path.dirname(this.deps.auditFile), { recursive: true });
      fs.appendFileSync(this.deps.auditFile, `${new Date().toISOString()} ${msg}\n`, "utf8");
    } catch {
      /* audit must never break the runtime */
    }
  }

  /**
   * Atomic (tmp+rename) JSONL sidecar for the turn ring: a crash can never
   * leave a half-written file, and a corrupt line on load is skipped, not
   * fatal. Persistence is best-effort — observability must never break a turn.
   */
  private turnsPersistAdapter(): TurnTrackerPersist {
    const file = this.deps.turnsFile!;
    return {
      load: (): TurnRecord[] => {
        try {
          if (!fs.existsSync(file)) return [];
          const out: TurnRecord[] = [];
          for (const line of fs.readFileSync(file, "utf8").split("\n")) {
            const t = line.trim();
            if (!t) continue;
            try {
              out.push(JSON.parse(t) as TurnRecord);
            } catch {
              continue;
            }
          }
          return out;
        } catch {
          return [];
        }
      },
      save: (records: TurnRecord[]): void => {
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          const tmp = `${file}.tmp`;
          const body = records.map((r) => JSON.stringify(r)).join("\n");
          fs.writeFileSync(tmp, body ? body + "\n" : "", "utf8");
          fs.renameSync(tmp, file);
        } catch {
          /* persistence must never break the runtime */
        }
      },
    };
  }

  // ------------------------------------------------- turn observability
  // Single owner: TurnTracker (bounded ring). recentTurns mirrors it for
  // any legacy direct reads within this class.
  private pushTurn(rec: TurnRecord): void {
    this.turns.push(rec);
    this.recentTurns = this.turns.list(RECENT_TURNS_MAX);
  }

  private finishTurn(turnId: string, agentId: string, patch: Partial<TurnRecord>): void {
    this.turns.finish(turnId, agentId, patch, this.deps.kernel.clock.iso());
    // Durable at turn end, not just on the debounce: the final payload
    // (text, summary, errorDetail) must survive a hard kill afterwards.
    this.turns.flush();
    this.recentTurns = this.turns.list(RECENT_TURNS_MAX);
  }

  /** Stamp a turn phase mark; observability only, never throws. */
  private markTurn(turnId: string, phase: TurnPhaseName): void {
    try {
      this.turns.mark(turnId, phase);
      this.recentTurns = this.turns.list(RECENT_TURNS_MAX);
    } catch {
      /* a missing timing mark must never break a turn */
    }
  }

  getRecentTurns(limit = 60): TurnRecord[] {
    return this.turns.list(limit);
  }

  /** Scheduler probe: is a turn for this agent currently unfinished? */
  isTurnInFlight(agentId: string): boolean {
    return this.turnInFlight.has(agentId);
  }

  getTurn(turnId: string): TurnRecord | undefined {
    return this.turns.get(turnId);
  }

  /** Correlation id for “every step in this turn” — attached to all emits while a turn runs. */
  private turnCorrelation(agentId: string): string | undefined {
    return this.activeTurnByAgent.get(agentId);
  }

  // ---------------------------------------------------------------- boot (Â§63)

  async boot(opts: { resume?: boolean; uiOnly?: boolean; mode?: "parked" | "live" } = {}): Promise<Goal | null> {
    // 4. create workspace
    if (this.deps.workspace) {
      await this.deps.workspace.ensureRepo();
    }
    // 6. create goal (only if not resuming an unfinished one). Backfill
    // activeGoalId for pre-fix snapshots/logs that restored goals but lost
    // the pointer (otherwise every restart mints a spurious new goal).
    if (!this.state.activeGoalId && this.state.goals.size > 0) {
      const latest = [...this.state.goals.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      if (latest) this.state.activeGoalId = latest.id;
    }
    if (!opts.resume || !this.state.activeGoalId || !this.state.goals.get(this.state.activeGoalId)) {
      // One goal per mesh in v1: if any live (non-terminal) goal exists,
      // resume it instead of minting a duplicate that orphans live work.
      const live = [...this.state.goals.values()].find((g) => !["COMPLETED", "FAILED"].includes(g.status));
      if (opts.resume && live) {
        this.state.activeGoalId = live.id;
      } else {
        await this.createGoal({
          description: this.config.goalText,
          acceptanceCriteria: this.config.goalCriteria ?? DEFAULT_CRITERIA,
          budget: {
            tokens: this.config.budgets.mission.tokens,
            wallClockMinutes: this.config.budgets.mission.wallClockMinutes,
            maxEvents: this.config.budgets.mission.maxEvents,
          },
        });
      }
    }
    // 7. register agents (+ human seat, Â§36)
    await this.registerHuman();
    for (const id of this.config.agentOrder) {
      if (!this.state.agents.has(id)) {
        await this.registerAgent(this.config.agents[id]);
      }
    }
    // 8. allocate budgets
    const goalId = this.state.activeGoalId!;
    this.deps.budget.declare(missionKey(goalId), "tokens", this.config.budgets.mission.tokens);
    this.deps.budget.declare(missionKey(goalId), "events", this.config.budgets.mission.maxEvents);
    this.deps.budget.declare(missionKey(goalId), "wallclock_minutes", this.config.budgets.mission.wallClockMinutes);
    for (const id of this.config.agentOrder) {
      this.deps.budget.declare(agentKey(goalId, id), "tokens", this.config.agents[id].budget.tokens ?? null);
    }
    // 8b. close turns abandoned by a previous process lifetime: anything the
    // log still shows as running can never finish (in-memory traces are gone
    // with the old process), and would otherwise read as "running" forever in
    // every step/agent view. Runs before the scheduler starts so the close
    // events themselves trigger no activations.
    await this.closeAbandonedTurns();
    // 8c. retire asks orphaned by goal succession: this mesh has been
    // restarted onto new goals several times, and the old goals' open asks
    // stay in the ledger forever — they pollute every operator view, keep
    // nudge/stall bookkeeping looking loaded, and (before the lifecycle
    // scoping fix) pinned agents in WAITING. Event-sourced discharge, so
    // replay reproduces the retirement exactly. Idempotent: only pendings
    // whose goal differs from the active goal are touched.
    if (goalId) {
      for (const [pid, pr] of [...this.state.pendingRequests]) {
        if (!pr.goalId || pr.goalId === goalId) continue;
        await this.dischargeCommitment(pid, "superseded", "system", { action: "goal_superseded", from: pr.goalId, to: goalId });
      }
    }
    // 12/13. start scheduler + activate initial agents (skipped in parked mode:
    // the scheduler stays stopped, so no agent is ever activated or spends tokens)
    // `mode` is the explicit successor of the legacy `uiOnly` boolean.
    const parked = opts.mode !== undefined ? opts.mode === "parked" : Boolean(opts.uiOnly);
    this.liveMode = !parked;
    this.lastTurnAt = Date.now();
    this.stallNoopRetryAt = 0;
    this.startStallWatch();
    if (!parked) {
      this.deps.scheduler.start();
      const activate = opts.resume ? this.recoveryCandidates() : this.config.startupActivate;
      // Nobody decomposed the goal. Every agent received the same raw goal text
      // as its mission and independently guessed which slice was its own, so
      // the mesh ran N divergent partial plans that never reconciled — the
      // single biggest quality gap against one agent holding one coherent plan.
      // The first startup agent is now the planner: it must publish the split
      // before doing role work, and the rest are told to align to that plan
      // rather than invent a parallel one.
      for (const [i, id] of activate.entries()) {
        await this.activateAgent(id, {
          kind: opts.resume ? "recovery" : "startup",
          note: opts.resume
            ? "mission resumed from event log"
            : i === 0
              ? this.plannerBrief()
              : "startup activation. A lead agent is decomposing the goal into tasks right now — do NOT invent your own parallel plan. Check the mission acceptance criteria and open tasks, claim what your role owns, and ask the lead if your slice is unclear.",
        });
      }
    }
    return this.state.goals.get(goalId) ?? null;
  }

  /**
   * Kickoff brief for the FIRST startup agent: decompose before working.
   *
   * The mesh has no planner module and every agent gets the identical raw goal
   * text as its mission, so without this the goal was effectively broadcast and
   * each role invented its own interpretation. One explicit decomposition turn
   * costs a single activation and gives every later agent a shared plan to
   * claim from, which is exactly what a single agent gets for free.
   */
  private plannerBrief(): string {
    const goal = this.state.activeGoalId ? this.state.goals.get(this.state.activeGoalId) : undefined;
    const mandatory = (goal?.acceptanceCriteria ?? []).filter((c) => c.mandatory);
    const criteriaLine = mandatory.length > 0 ? ` Cover every mandatory criterion: ${mandatory.map((c) => c.id).join(", ")}.` : "";
    return (
      "You are the mission lead for this kickoff. BEFORE any role work, decompose the goal:" +
      " restate what 'done' concretely means for THIS goal (not a generic checklist), then emit one create_task per" +
      " distinct piece of work with a specific title, a description detailed enough to act on without asking you," +
      ` and assignedTo set to the role that owns it.${criteriaLine}` +
      " Every other agent will claim work from these tasks instead of guessing, so vague tasks become vague deliverables." +
      " Do not delegate the thinking: name the actual scope, constraints and interfaces you expect."
    );
  }

  /**
   * Turns the log still shows as running when a (new) process boots. The old
   * process is gone, so these can never finish — without an explicit close
   * they read as "running" forever in every step/agent view (and leave agent
   * lifecycles stuck in THINKING/WORKING). Idempotent: already-closed turns
   * are skipped, so repeated boots emit nothing new.
   */
  private async closeAbandonedTurns(): Promise<void> {
    let tail: MeshEvent[] = [];
    try {
      tail = await this.deps.store.read({ tail: 2000 });
    } catch {
      return;
    }
    const open = new Map<string, string>(); // turnId -> agentId
    for (const e of tail) {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      if (e.type === "agent.awakened" && typeof p.turnId === "string" && typeof p.agentId === "string") {
        open.set(p.turnId, p.agentId);
      } else if (e.type === "agent.state_changed" && typeof p.turnId === "string") {
        if (["IDLE", "WAITING", "BLOCKED"].includes(String(p.to))) open.delete(p.turnId);
      } else if (e.type === "agent.failed") {
        if (typeof p.turnId === "string") open.delete(p.turnId);
        else if (typeof p.agentId === "string") {
          for (const [tid, aid] of [...open]) if (aid === p.agentId) open.delete(tid);
        }
      }
    }
    for (const [turnId, agentId] of open) {
      if (!this.state.agents.has(agentId)) continue;
      try {
        await this.deps.kernel.emit(
          "agent.state_changed",
          { agentId, to: "IDLE", note: "turn abandoned by server restart", turnId },
          { actorId: "system", correlationId: turnId },
        );
      } catch {
        /* already idle (or otherwise uncloseable): nothing to record */
      }
    }
  }

  private recoveryCandidates(): string[] {    const out: string[] = [];
    for (const rec of this.state.agents.values()) {
      const a = rec.state;
      if (a.agentId === HUMAN_AGENT_ID) continue;
      if ((this.state.unread.get(a.agentId)?.length ?? 0) > 0 || a.activeTaskId || a.lifecycle === "WAITING" || a.lifecycle === "FAILED") {
        out.push(a.agentId);
      }
    }
    return out;
  }

  async shutdown(opts: { complete?: boolean } = {}): Promise<void> {
    this.stopping = true;
    this.turns.flush();
    this.stopStallWatch();
    await this.deps.scheduler.stop();
    for (const [agentId, { session, runtime }] of [...this.sessions]) {
      try {
        await runtime.stop(session);
      } catch (err) {
        this.auditLine(`stop failed for ${agentId}: ${(err as Error).message}`);
      }
    }
    this.sessions.clear();
  }

  /**
   * Tear the mission down to a blank supervisor WITHOUT killing the process.
   *
   * Unlike `shutdown()` this leaves `stopping` false, so the same instance can
   * `boot()` again immediately — the mesh keeps serving HTTP throughout, which
   * is the whole point: every route handler closed over this supervisor.
   *
   * Runtime sessions are stopped and forgotten on purpose. Reusing them would
   * hand the fresh mission agents whose conversation still remembers the goal
   * we just deleted, which is exactly the "reset that didn't reset" bug.
   */
  async resetMission(): Promise<void> {
    this.stopStallWatch();
    this.liveMode = false;
    await this.deps.scheduler.stop();
    for (const [agentId, { session, runtime }] of [...this.sessions]) {
      try {
        await runtime.stop(session);
      } catch (err) {
        this.auditLine(`stop failed for ${agentId} during reset: ${(err as Error).message}`);
      }
      await this.deps.sessionRegistry?.forget(agentId).catch(() => undefined);
    }
    this.sessions.clear();
    this.turnInFlight.clear();
    this.interruptedTurnIds.clear();
    this.restartAttempts.clear();
    this.unreachableStreak.clear();
    this.timeoutRetries.clear();
    this.workerInfo.clear();
    this.escalationsInFlight.clear();
    this.activeTurnByAgent.clear();
    this.recentTurns = [];
    this.turns.clear();
    this.idleCallbacks = [];
    this.watchdogLastRun = 0;
    this.watchdogTrailing = false;
    this.startedAt = Date.now();
    this.lastTurnAt = Date.now();
    this.lastStallNudgeAt = 0;
    this.stallNoopRetryAt = 0;
    if (this.stallNoopTimer) {
      clearTimeout(this.stallNoopTimer);
      this.stallNoopTimer = undefined;
    }
    this.detector = new DeadlockDetector(this.deps.config);
    this.termination = new TerminationManager();
  }

  // ------------------------------------------------------- MeshRuntime API (Â§48)

  async createGoal(input: CreateGoalInput): Promise<Goal> {
    if (this.state.activeGoalId && this.state.goals.get(this.state.activeGoalId)?.status !== "CREATED") {
      // one goal per mesh instance in v1
    }
    const goalId = newGoalId();
    const rootThreadId = newThreadId();
    const goal: Goal = {
      id: goalId,
      description: input.description,
      acceptanceCriteria: (input.acceptanceCriteria ?? DEFAULT_CRITERIA).map((c, i) => ({
        id: c.id ?? `criterion-${i + 1}`,
        description: c.description,
        mandatory: c.mandatory ?? true,
        status: c.status ?? "UNSATISFIED",
        evidence: c.evidence ?? [],
      })),
      status: "ACTIVE",
      budget: {
        tokens: input.budget?.tokens ?? this.config.budgets.mission.tokens,
        wallClockMinutes: input.budget?.wallClockMinutes ?? this.config.budgets.mission.wallClockMinutes,
        maxEvents: input.budget?.maxEvents ?? this.config.budgets.mission.maxEvents,
      },
      rootThreadId,
      createdAt: this.deps.kernel.clock.iso(),
    };
    await this.deps.kernel.emit("goal.created", { goal }, { goalId, actorId: HUMAN_AGENT_ID });
    const rootThread: Thread = {
      id: rootThreadId,
      goalId,
      subject: "mission-root",
      initiator: HUMAN_AGENT_ID,
      artifactRefs: [],
      participants: [HUMAN_AGENT_ID],
      depth: 0,
      messageIds: [],
      status: "OPEN",
      budget: { tokens: this.config.budgets.threadTokens },
      createdAt: goal.createdAt,
    };
    await this.deps.kernel.emit("thread.created", { thread: rootThread }, { goalId, actorId: HUMAN_AGENT_ID });
    return goal;
  }

  async registerAgent(agent: AgentDefinition): Promise<void> {
    await this.deps.kernel.emit("agent.created", { agent }, { actorId: HUMAN_AGENT_ID });
  }

  private async registerHuman(): Promise<void> {
    if (this.state.agents.has(HUMAN_AGENT_ID)) return;
    const human: AgentDefinition = {
      id: HUMAN_AGENT_ID,
      role: "human",
      mode: "peer",
      runtime: "none",
      prompt: { text: "The human operator seat." },
      capabilities: ["override"],
      authority: ["*"],
      communicationPolicy: { mayContact: [], mayBeContactedBy: [] },
      interests: ["goal.escalated", "escalation.requested"],
      sessionPolicy: { persistent: false },
      delegationPolicy: { allowDelegation: false, maxDepth: 0, maxWorkers: 0 },
      budget: {},
    };
    await this.registerAgent(human);
  }

  async sendMessage(input: {
    from: string;
    to: string[];
    type: MessageType;
    goalId?: GoalId;
    threadId?: string;
    newThread?: { subject: string; artifactRefs?: ArtifactRef[]; parentThreadId?: string };
    replyTo?: string;
    artifactRefs?: ArtifactRef[];
    payload?: unknown;
    priority?: MeshMessage["priority"];
    taskId?: string;
    causationId?: string;
    correlationId?: string;
    requires?: { id: string; text: string }[];
    budgetHint?: { maxTokens?: number; maxTurns?: number };
  }): Promise<SendResult> {
    // Every send — agent turn, MCP tool, HTTP API — funnels through here, so
    // this is the one place runtime-owned fields must be stripped off caller
    // input. Structural: after this line no forged `control` (or a forged
    // copy hidden in `payload`) exists to be read further down.
    input = sanitizeAgentMessageInput(input);
    const goalId = this.state.activeGoalId;
    if (!goalId) return { accepted: false, reason: "no active goal" };
    const ctx = { config: this.config, projections: this.state, goal: this.state.goals.get(goalId) };
    if (!this.state.agents.has(input.from)) return { accepted: false, reason: `unknown sender ${input.from}` };
    const targets = [...new Set(input.to)].filter((t) => t !== input.from);
    if (targets.length === 0) return { accepted: false, reason: "no recipients (self-addressed messages are dropped)" };

    for (const t of targets) {
      if (!this.state.agents.has(t) && t !== "all") return { accepted: false, reason: `unknown recipient ${t}` };
    }

    const policy = this.deps.policy.evaluateMessage(input.from, targets, { type: input.type, threadId: input.threadId ?? "", payload: input.payload, taskId: input.taskId }, ctx);
    if (policy.decision === "DENY") {
      const evt = await this.deps.kernel.emit(
        "message.rejected",
        { from: input.from, to: targets, type: input.type, reason: policy.reason, ruleId: policy.ruleId, payload: input.payload },
        { actorId: input.from, goalId },
      );
      return { accepted: false, reason: policy.reason, eventId: evt.id };
    }
    if (policy.decision === "DEFER") {
      return { accepted: false, reason: policy.reason ?? "deferred" };
    }
    if (policy.decision === "ESCALATE") {
      const esc = await this.escalate({
        reason: policy.reason ?? "policy_escalation",
        raisedBy: input.from,
        detail: { attemptedTo: targets, type: input.type },
      });
      return { accepted: false, escalated: esc.id, reason: policy.reason };
    }
    let recipients = targets;
    if (policy.decision === "REDIRECT" && policy.redirects && policy.redirects.length > 0) {
      recipients = policy.redirects;
    }

    // resolve or create thread
    let threadId = input.threadId;
    if (threadId && !this.state.threads.has(threadId)) threadId = undefined;
    if (!threadId) {
      const parent = input.newThread?.parentThreadId ? this.state.threads.get(input.newThread.parentThreadId) : undefined;
      if (this.config.escalation.threadMaxDepth <= 0) {
        return { accepted: false, reason: "threading disabled" };
      }
      const depth = parent ? parent.depth + 1 : 1;
      if (depth > this.config.escalation.threadMaxDepth) {
        const esc = await this.escalate({
          reason: "thread_depth_exceeded",
          raisedBy: input.from,
          conflictKey: `depth:${parent?.id ?? "root"}`,
          detail: { parentThreadId: parent?.id, depth, max: this.config.escalation.threadMaxDepth },
        });
        return { accepted: false, escalated: esc.id, reason: "thread depth exceeded maximum" };
      }
      const t: Thread = {
        id: newThreadId(),
        goalId,
        subject: input.newThread?.subject ?? `${input.type} ${input.from}->${recipients.join(",")}`,
        initiator: input.from,
        artifactRefs: input.newThread?.artifactRefs ?? input.artifactRefs ?? [],
        participants: [input.from, ...recipients],
        depth,
        parentThreadId: parent?.id,
        rootThreadId: parent?.rootThreadId ?? parent?.id ?? this.state.goals.get(goalId)?.rootThreadId,
        messageIds: [],
        status: "OPEN",
        budget: { tokens: this.config.budgets.threadTokens },
        createdAt: this.deps.kernel.clock.iso(),
      };
      await this.deps.kernel.emit("thread.created", { thread: t }, { actorId: input.from, goalId });
      threadId = t.id;
    }

    let cacheHit: ArtifactRef | undefined;
    if (input.type === "REQUEST_RESEARCH") {
      cacheHit = this.researchCache(String((input.payload as any)?.question ?? ""));
    }
    const message: MeshMessage = {
      id: newMessageId(),
      protocolVersion: PROTOCOL_VERSION,
      type: input.type,
      timestamp: this.deps.kernel.clock.iso(),
      goalId,
      from: input.from,
      to: recipients,
      threadId: threadId!,
      replyTo: input.replyTo,
      causationId: input.causationId,
      artifactRefs: input.artifactRefs ?? [],
      payload: input.payload ?? {},
      priority: input.priority ?? (recipients.some((r) => this.config.agents[r]?.mode === "service") ? "HIGH" : "NORMAL"),
      taskId: input.taskId,
      requires: input.requires,
      budgetHint: input.budgetHint,
      provenance:
        input.from === HUMAN_AGENT_ID
          ? { source: "human", trustLevel: 100 }
          : { source: "agent", trustLevel: 50 },
    };
    if (message.replyTo && !this.state.messages.has(message.replyTo)) {
      return { accepted: false, reason: `replyTo ${message.replyTo} not found` };
    }
    const validation = validateMessage(message);
    if (!validation.valid) {
      // Visible, like policy denials: a silently dropped send looks exactly
      // like a delivered one from the dashboard, which stalls missions.
      const reason = `message failed protocol validation: ${validation.errors.map((e) => e.path + " " + e.message).join("; ")}`;
      const rej = await this.deps.kernel.emit(
        "message.rejected",
        { from: input.from, to: recipients, type: input.type, reason, payload: input.payload },
        // Correlate to the sender's turn, exactly like `message.sent` below.
        // Without this the rejection was an orphan event: it belonged to no
        // turn, so no trace, dashboard row, or per-turn summary could show
        // that this turn's message never left the building.
        { actorId: input.from, goalId, correlationId: this.turnCorrelation(input.from) },
      );
      return { accepted: false, reason, eventId: rej.id };
    }
    // Delivery control lives on the envelope, where only this line can write
    // it — and it works regardless of payload shape (the old payload-spread
    // version silently no-op'd on a string or array payload, so a cached
    // research answer was still delivered and still woke the recipient).
    if (cacheHit) {
      message.control = { ...(message.control ?? {}), cacheServed: true };
    }

    const correlationId = input.correlationId ?? this.turnCorrelation(input.from);
    const evt = await this.deps.kernel.emit(
      "message.sent",
      { message },
      { actorId: input.from, goalId, causationId: input.causationId, correlationId },
    );

    if (cacheHit) {
      await this.deps.kernel.emit("research.completed", { cached: true, artifactRef: cacheHit, messageId: message.id }, { actorId: input.from, goalId, causationId: evt.id });
      await this.sendMessage({
        from: recipients[0],
        to: [input.from],
        type: "INFORM",
        threadId: message.threadId,
        replyTo: message.id,
        artifactRefs: [cacheHit],
        payload: { summary: "answer served from explorer cache (no model invoked)", cached: true },
      });
      return { accepted: true, messageId: message.id, eventId: evt.id };
    }

    // derived semantic events
    await this.deriveSemantic(input.from, message, evt.id, correlationId);
    return { accepted: true, messageId: message.id, eventId: evt.id, redirectedTo: policy.decision === "REDIRECT" ? recipients : undefined };
  }

  private async deriveSemantic(from: string, m: MeshMessage, causationId: string, correlationId?: string): Promise<void> {
    const goalId = m.goalId;
    const corr = correlationId ?? this.turnCorrelation(from);
    const primary = m.artifactRefs[0]?.uri;
    if (m.type === "REQUEST_REVIEW") {
      const art = primary ? this.findArtifactByUri(primary) : undefined;
      await this.deps.kernel.emit("review.requested", { artifactId: art?.id, artifactRef: primary, reviewers: m.to, messageId: m.id, subject: m.payload }, { actorId: from, goalId, causationId, correlationId: corr });
      await this.auditTransition(art?.id, m.id, goalId, corr);
      if (art && (art.type === "ArchitectureDocument" || art.type === "ApiSpec")) {
        await this.deps.kernel.emit("design.question", { artifactId: art.id, question: (m.payload as any)?.question ?? null, messageId: m.id }, { actorId: from, goalId, causationId, correlationId: corr });
      }
    }
    if ((m.type === "TEST_RESULT" || m.type === "SECURITY_FINDING") && (m.payload as any)?.result === "PASSED") {
      // The reducer refuses to record an owner's sign-off on their own
      // artifact when a peer could have reviewed it. Tell the sender, for the
      // same reason a refused BLOCK is surfaced: silence here is worse than
      // noise. An unentitled PASSED can be dropped quietly — the sender was
      // never going to move the artifact and loses nothing. A refused
      // SELF-approval is different: the owner is the one agent that will now
      // sit and wait on a gate it believes it satisfied, so the artifact
      // stalls with nobody looking for a reviewer. One rejection turns that
      // deadlock into a next action.
      //
      // Emitted AFTER `message.sent`: the result is still logged and still
      // delivered. It is a report, not a verdict.
      const target = artifactForRef(this.state, (m.payload as any)?.artifactId, primary);
      const selfApproval = !!target && target.owner === from && hasPeerReviewerFor(this.state, from, target, HUMAN_AGENT_ID);
      if (selfApproval) {
        await this.denied(from, target.id, `pass ${target.name}`, {
          decision: "DENY",
          reason: `cannot sign off your own artifact '${target.name}' while another agent could review it — the result was delivered as a report but records no approval`,
          ruleId: "authority.self-approval",
        });
      } else if (m.type === "TEST_RESULT") {
        await this.markCriterionEvidence("quality-verified", {
          kind: "test-pass",
          artifactRef: m.artifactRefs[0],
          by: m.from,
          recordedAt: this.deps.kernel.clock.iso(),
        });
      } else {
        await this.markCriterionEvidence("security-verified", {
          kind: "security-pass",
          artifactRef: m.artifactRefs[0],
          by: m.from,
          recordedAt: this.deps.kernel.clock.iso(),
        });
      }
    }
    if (m.type === "REQUEST_RESEARCH") {
      await this.deps.kernel.emit("research.requested", { question: (m.payload as any)?.question ?? m.payload, messageId: m.id }, { actorId: from, goalId, causationId, correlationId: corr });
    }
    if (m.type === "PATCH_READY") {
      const art = primary ? this.findArtifactByUri(primary) : undefined;
      await this.deps.kernel.emit("patch.ready", { artifactId: art?.id, artifactRef: primary, messageId: m.id }, { actorId: from, goalId, causationId, correlationId: corr });
      await this.auditTransition(art?.id, m.id, goalId, corr);
    }
    if (m.type === "BLOCK") {
      // The reducer refuses to record a block from a seat without
      // `<subject>.block`, and counts the refusal as a conflict so it is
      // visible in metrics and escalates if repeated. But the SENDER also has
      // to learn its objection carried no weight — otherwise it goes quiet
      // believing the artifact is held, and the artifact ships anyway.
      //
      // Deliberate `op: block` never reaches here unentitled: executeOp runs
      // evaluateAuthority before it sends. This catches the raw message path.
      //
      // Emitted AFTER `message.sent`: an unentitled BLOCK is still logged and
      // still delivered, exactly like an unentitled PASSED. It is a concern,
      // not a verdict.
      const subject = (m.payload as any)?.subject ?? "quality";
      if (!holdsAuthority(this.state.agents.get(from)?.definition.authority, subject, "block")) {
        const reason = `no authority to block '${subject}' (requires ${subject}.block) — the objection was delivered as a concern but does not withhold the transition`;
        await this.denied(from, (m.payload as any)?.artifactId ?? primary, `block ${subject}`, {
          decision: "DENY",
          reason,
          ruleId: "authority.block",
        });
      }
    }
    if (m.type === "ESCALATE") {
      // already an explicit escalation op path; keep audit-only
    }
  }

  /**
   * Close an outstanding ask through the event log.
   *
   * The ledger has exactly one exit and it is event-sourced, so replay
   * reproduces it. Callers must never touch `state.pendingRequests` directly:
   * that is what made live and replayed state diverge (an ask the live mesh
   * had closed came back on rebuild, and the nudge/stalemate machinery then
   * chased a question that was already answered).
   */
  async dischargeCommitment(
    messageId: string,
    reason: DischargeReason,
    by: string,
    detail: Record<string, unknown> = {},
  ): Promise<boolean> {
    const pending = this.state.pendingRequests.get(messageId);
    if (!pending) return false;
    // An ask to N agents is N obligations, so predict whether THIS discharge
    // closes the ask or only settles one debtor's share of it. The reducer
    // makes the same decision from the same inputs; computing it here keeps
    // the event payload and the asker's notification honest about which
    // happened.
    const remainingAfter =
      PER_DEBTOR_DISCHARGE_REASONS.has(reason) && stillOwes(pending, by)
        ? outstandingDebtors(pending).filter((d) => d !== by)
        : [];
    const partial = remainingAfter.length > 0;
    try {
      await this.deps.kernel.emit(
        "commitment.discharged",
        {
          messageId, reason, by, from: pending.from, to: pending.to, requestType: pending.type,
          ...(partial ? { partial: true, remaining: remainingAfter } : {}),
          ...detail,
        },
        { actorId: by, goalId: this.state.activeGoalId ?? undefined },
      );
    } catch (err) {
      // The whole point of the event is replay equivalence. If it never
      // reached the log, the ask stays open: the nudge machinery then treats
      // it as an unanswered ask (which it is) instead of chasing silence.
      this.auditLine(`discharge of ${messageId} rejected from the log: ${(err as Error).message}`);
      return false;
    }
    // The ask is closed — but a WAITING asker is still parked on it. A
    // WAITING agent only wakes on mail or timer: nothing was mailed here, and
    // the timer only nudges agents that still OWE something. So wake the
    // asker explicitly with what happened, or every non-reply discharge
    // (supersede, decline, deadlock break, operator drop) strands it in
    // WAITING forever — the "no active agents" stall. A `respond`/`reply`
    // already notifies via its answer message; the extra wake is harmless
    // (deduped by isBusy/queue) but keep it anyway: uniform beats clever.
    if (partial) {
      // One of several debtors answered. The ask is NOT closed, so telling the
      // asker it was would send it off to plan a next step while it is still
      // owed answers by everyone who has said nothing.
      if (pending.from !== HUMAN_AGENT_ID && this.state.agents.has(pending.from)) {
        await this.activateAgent(pending.from, {
          kind: "recovery",
          note: `${by} answered your request ${messageId} (${pending.type}); still awaiting ${remainingAfter.join(", ")}`,
        }).catch(() => undefined);
      }
      return true;
    }
    if (pending.from !== HUMAN_AGENT_ID && this.state.agents.has(pending.from)) {
      const why =
        reason === "reply" ? "it was answered"
        : reason === "superseded" ? "a newer artifact version replaced what was under review"
        : reason === "deadlock_break" ? "it was voided to break a circular wait"
        : reason === "evicted_cap" ? "the ask ledger hit capacity and dropped it UNANSWERED — re-ask if you still need it"
        : reason === "operator" ? "an operator resolved it"
        : reason === "task_completed" ? "its task completed"
        : reason === "artifact_review" ? "a review verdict landed on its artifact"
        : reason === "task" ? "its task was answered"
        : reason === "in_thread" ? "an in-thread answer arrived"
        : "it was closed";
      await this.activateAgent(pending.from, {
        kind: "recovery",
        note: `your request ${messageId} (${pending.type}) closed: ${why} — check the outcome and drive the next step instead of waiting`,
      }).catch(() => undefined);
    }
    return true;
  }

  /**
   * Health of the commitment ledger.
   *
   * `inferredRatio` is the number that matters: it is the share of asks the
   * runtime closed by GUESSING (thread/timing/artifact shape) rather than
   * being told via `replyTo` or `discharge`. Every one of those guesses can
   * be wrong in either direction — closing a live question, or leaving a dead
   * one open — so a high ratio means the mesh is running on inference and the
   * role prompts are not landing. Previously this was entirely invisible.
   *
   * `unanswered` is the harder failure: asks the ledger LOST rather than
   * closed (capacity eviction, deadlock voiding). Any non-zero value means
   * questions went unanswered without anyone deciding they should, and
   * `capacityPressure` says whether the ledger is at the cap that causes it.
   */
  commitmentStats(): {
    open: number;
    discharged: number;
    byReason: Record<string, number>;
    inferred: number;
    inferredRatio: number;
    unanswered: number;
    capacityPressure: number;
    oldestOpenAgeMs: number | null;
  } {
    const byReason: Record<string, number> = {};
    let inferred = 0;
    let unanswered = 0;
    for (const d of this.state.discharged) {
      byReason[d.reason] = (byReason[d.reason] ?? 0) + 1;
      if (INFERRED_DISCHARGE_REASONS.has(d.reason)) inferred++;
      if (UNANSWERED_DISCHARGE_REASONS.has(d.reason)) unanswered++;
    }
    const total = this.state.discharged.length;
    let oldest: number | null = null;
    const now = this.deps.kernel.clock.now().getTime();
    for (const pr of this.state.pendingRequests.values()) {
      const age = now - Date.parse(pr.createdAt);
      if (Number.isFinite(age) && (oldest === null || age > oldest)) oldest = age;
    }
    return {
      open: this.state.pendingRequests.size,
      discharged: total,
      byReason,
      inferred,
      inferredRatio: total > 0 ? inferred / total : 0,
      unanswered,
      capacityPressure: this.state.pendingRequests.size / MAX_PENDING_REQUESTS,
      oldestOpenAgeMs: oldest,
    };
  }

  findArtifactByUri(uri: string): Artifact | undefined {
    for (const a of this.state.artifacts.values()) {
      if (a.contentRef === uri || `artifact://${a.type}/${a.name}/${a.version}` === uri) return a;
      if (a.id === uri) return a;
    }
    for (const a of this.state.artifacts.values()) {
      const parsed = /^artifact:\/\/([^/]+)\/([^/]+)/.exec(uri);
      if (parsed && a.type === parsed[1] && a.name === decodeURIComponent(parsed[2])) return a;
    }
    // Last resort for model-invented URIs (wrong type segment, abbreviated
    // name): every token of the referenced name must appear in the actual
    // name. Exact matches above always win; newest version breaks ties.
    const needleTokens = (() => {
      try {
        const parsed = /^artifact:\/\/([^/]+)\/([^/]+)/.exec(uri);
        return decodeURIComponent(parsed?.[2] ?? uri)
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((t) => t.length >= 2);
      } catch {
        return [];
      }
    })();
    if (needleTokens.length > 0) {
      const cands = [...this.state.artifacts.values()]
        .filter((a) => {
          const nameTokens = new Set(a.name.toLowerCase().split(/[^a-z0-9]+/));
          return needleTokens.every((t) => nameTokens.has(t));
        })
        .sort((x, y) => y.version - x.version || y.createdAt.localeCompare(x.createdAt));
      if (cands.length > 0) return cands[0];
    }
    return undefined;
  }

  /**
   * P6: every state change must be visible in the log. Reducers derive
   * transitions internally; this records an idempotent audit event whose
   * replay is a no-op (same-status guard) but whose presence makes the
   * transition observable to consumers that read the event stream.
   */
  private async auditTransition(artifactId: string | undefined, causationId: string, goalId: string, correlationId?: string): Promise<void> {
    if (!artifactId) return;
    const a = this.state.artifacts.get(artifactId);
    if (!a) return;
    await this.deps.kernel
      .emit("artifact.transition", { artifactId, to: a.status, derived: true, gateSatisfied: true }, { actorId: "system", goalId, causationId, correlationId: correlationId ?? this.turnCorrelation(a.owner) })
      .catch(() => undefined);
  }

  /**
   * `opts.explicit` marks the activation as operator-initiated, which is what
   * lets it through the scheduler's two "quiet refusal" gates: a stopped
   * scheduler and circuit-breaker backoff parking. Default is derived from the
   * reason kind (`manual`), so only callers that ARE the operator acting
   * through another kind — `reopenGoal`, notably — need to pass it.
   */
  async activateAgent(agentId: string, reason: ActivationReason, opts: { explicit?: boolean } = {}): Promise<{ queued: boolean; blocked?: string }> {
    const goal = this.state.goals.get(this.state.activeGoalId ?? "");
    if (!goal) return { queued: false, blocked: "no goal yet — boot/create a goal first" };
    if (goal.status === "PAUSED") return { queued: false, blocked: "mission is paused — resume it first" };
    // Operator follow-up (feedback / wake) may still reach a completed mission.
    const followUp = reason.kind === "message" || reason.kind === "manual" || reason.kind === "recovery";
    if (goal.status === "FAILED" || (goal.status === "COMPLETED" && !followUp)) return { queued: false, blocked: `mission is ${goal.status}` };
    if (goal.status === "ESCALATED") return { queued: false, blocked: "mission is escalated — respond to the open escalation first" };
    const rec = this.state.agents.get(agentId);
    if (!rec) return { queued: false, blocked: `unknown agent '${agentId}'` };
    if (agentId === HUMAN_AGENT_ID) return { queued: false, blocked: "the human seat has no runtime" };
    if (rec.state.lifecycle === "SUSPENDED") return { queued: false, blocked: "agent is suspended — resume it first" };
    if (rec.state.lifecycle === "COMPLETED") return { queued: false, blocked: "agent completed with the mission" };
    const req: SchedulerActivationRequest = {
      agentId,
      reason,
      priority: reason.kind === "startup" ? 5 : reason.kind === "recovery" ? 7 : reason.kind === "manual" ? 6 : 3,
      explicit: opts.explicit ?? reason.kind === "manual",
    };
    const queued = await this.deps.scheduler.requestActivation(req);
    return { queued, blocked: queued ? undefined : "already active, or deferred by budget/policy" };
  }

  async suspendAgent(agentId: string): Promise<void> {
    const rec = this.state.agents.get(agentId);
    if (!rec) return;
    const sess = this.sessions.get(agentId);
    if (sess) await sess.runtime.suspend(sess.session).catch(() => undefined);
    await this.deps.kernel.emit("agent.suspended", { agentId }, { actorId: HUMAN_AGENT_ID });
  }

  async resumeAgent(agentId: string): Promise<void> {
    const sess = this.sessions.get(agentId);
    if (sess) await sess.runtime.resume(sess.session).catch(() => undefined);
    await this.deps.kernel.emit("agent.resumed", { agentId }, { actorId: HUMAN_AGENT_ID });
  }

  async createArtifact(input: {
    actorId: string;
    name: string;
    type: Artifact["type"];
    content: string;
    status?: ArtifactStatus;
    metadata?: Record<string, unknown>;
    parentArtifactId?: string;
    asVersionOf?: string;
    provenanceSource?: TrustSource;
    correlationId?: string;
  }): Promise<{ artifact: Artifact; uri: string } | { error: string }> {
    const goalId = this.state.activeGoalId;
    if (!goalId) return { error: "no active goal" };
    const ctx = { config: this.config, projections: this.state, goal: this.state.goals.get(goalId) };
    // Reject model-invented artifact types at the gate: without this a
    // publish like type "ArchitectureDoc" (not in ARTIFACT_TYPES) lands in
    // the store as a first-class record nobody can review or transition.
    if (!(ARTIFACT_TYPES as readonly string[]).includes(input.type)) {
      return { error: `unknown artifact type '${input.type}' (expected one of: ${ARTIFACT_TYPES.join(", ")})` };
    }
    const machine = artifactMachineOf(input.type);
    const initial = INITIAL_ARTIFACT_STATUS[machine];

    let artifact: Artifact;
    let isVersion = false;
    if (input.asVersionOf) {
      const current = this.state.artifacts.get(input.asVersionOf);
      if (!current) return { error: `unknown artifact ${input.asVersionOf}` };
      const ownerCheck = this.deps.policy.checkOwnership(input.actorId, current.id, ctx);
      if (ownerCheck.decision === "DENY") {
        await this.denied(input.actorId, current.id, "publish version", ownerCheck);
        return { error: `ownership denied: ${ownerCheck.reason}` };
      }
      if (current.owner !== input.actorId && input.actorId !== HUMAN_AGENT_ID) {
        await this.denied(input.actorId, current.id, "publish version", { decision: "DENY", reason: `single-writer: current owner is ${current.owner}` });
        return { error: `single-writer: current owner is ${current.owner}` };
      }
      artifact = {
        ...current,
        version: current.version + 1,
        parent: current.id,
        status: input.status === "DRAFT" || input.status === undefined || input.status === "PROPOSED" ? initial : current.status,
        contentRef: "",
        digest: "",
        metadata: { ...(current.metadata ?? {}), ...(input.metadata ?? {}) },
        createdAt: this.deps.kernel.clock.iso(),
        createdBy: input.actorId,
      };
      isVersion = true;
    } else {
      const existing = this.state.artifactByName.get(artifactKey(input.type, input.name));
      if (existing && existing.version > 0 && this.state.activeGoalId === existing.goalId) {
        return { error: `artifact ${input.type}:${input.name} already exists as ${existing.id} at v${existing.version} (owner: ${existing.owner}); publish a new version by retrying with asVersionOf: '${existing.id}'` };
      }
      artifact = {
        id: newArtifactId(),
        name: input.name,
        type: input.type,
        goalId,
        owner: input.actorId,
        version: 1,
        status: input.status === "FINAL" && machine === "document" ? "FINAL" : initial,
        contentRef: "",
        digest: "",
        metadata: input.metadata ?? {},
        provenance: {
          source: input.provenanceSource ?? (input.actorId === HUMAN_AGENT_ID ? "human" : "agent"),
          trustLevel: input.actorId === HUMAN_AGENT_ID ? 100 : 50,
        },
        createdAt: this.deps.kernel.clock.iso(),
        createdBy: input.actorId,
      };
    }
    const contentRef = await this.deps.content.writeVersion(artifact.id, artifact.version, input.content);
    artifact = { ...artifact, contentRef, digest: digestOf(input.content) };
    const uri = artifactUri(artifact.type, artifact.name, artifact.version);
    const correlationId = input.correlationId ?? this.turnCorrelation(input.actorId);
    const evt = await this.deps.kernel.emit(
      isVersion ? "artifact.versioned" : "artifact.created",
      { artifact },
      { actorId: input.actorId, goalId, correlationId },
    );
    await this.deriveArtifactSemantic(artifact, input.content, evt.id, correlationId);
    if (isVersion) {
      // A new version supersedes review asks for older versions of the same
      // artifact: reviewers answer against the newest version, and the stale
      // pending entries for v1 would otherwise nudge forever and escalate a
      // false stalemate after the merge already resolved the substance.
      const prefix = `artifact://${artifact.type}/${encodeURIComponent(artifact.name)}/`;
      for (const [pid, pr] of [...this.state.pendingRequests]) {
        if (!pr.type.startsWith("REQUEST")) continue;
        const uris = pr.artifactUris ?? [];
        // Emit, don't mutate: a direct delete here never reached the log, so
        // replay rebuilt an ask the live mesh had already superseded.
        if (uris.some((u) => u.startsWith(prefix))) {
          await this.dischargeCommitment(pid, "superseded", input.actorId, { artifactId: artifact.id });
        }
      }
    }
    return { artifact, uri };
  }

  private async deriveArtifactSemantic(a: Artifact, content: string, causationId: string, correlationId?: string): Promise<void> {
    const goalId = a.goalId;
    const corr = correlationId ?? this.turnCorrelation(a.createdBy);
    if (a.type === "CodePatch" && a.version === 1) {
      await this.deps.kernel.emit("patch.created", { artifactId: a.id, name: a.name }, { actorId: a.createdBy, goalId, causationId, correlationId: corr });
    }
    if (a.type === "RequirementsDoc" || a.type === "Requirement") {
      try {
        const doc = JSON.parse(content);
        const criteria = Array.isArray(doc) ? doc : doc.requirements ?? doc.criteria ?? [];
        if (Array.isArray(criteria) && criteria.length > 0) {
          await this.deps.kernel.emit(
            "requirements.created",
            {
              criteria: criteria
                .filter((c: any) => c && (c.id || c.text || c.description))
                .map((c: any) => ({
                  id: String(c.id ?? shortHash(String(c.text ?? c.description))),
                  description: String(c.text ?? c.description),
                  mandatory: c.mandatory ?? true,
                  status: "UNSATISFIED",
                  evidence: [],
                })),
              artifactId: a.id,
            },
            { actorId: a.createdBy, goalId, causationId, correlationId: corr },
          );
        }
      } catch {
        /* requirements doc may be markdown; criteria then come from goal config */
      }
    }
    if (a.type === "ReleasePlan" && a.version === 1) {
      await this.deps.kernel.emit("release.candidate", { artifactId: a.id, name: a.name }, { actorId: a.createdBy, goalId, causationId, correlationId: corr });
    }
    if (a.type === "ResearchReport") {
      const inReplyTo = (a.metadata as any)?.inReplyTo as string | undefined;
      await this.deps.kernel.emit("research.completed", { artifactId: a.id, name: a.name, inReplyTo }, { actorId: a.createdBy, goalId, causationId, correlationId: corr });
      // Delivering the report IS submitting it. Without this the artifact is
      // still DRAFT at the instant the criterion is evidenced, so the mandatory
      // gate in `markCriterionEvidence` would refuse the runtime's own path and
      // `req-analysis` could never be satisfied by anyone.
      await this.transitionArtifact(a.createdBy, a.id, { to: "READY_FOR_REVIEW", comment: "research delivered" });
      await this.markCriterionEvidence("req-analysis", {
        kind: "research-report",
        artifactRef: { uri: artifactUri(a.type, a.name, a.version) },
        by: a.createdBy,
        recordedAt: a.createdAt,
      });
      if (inReplyTo && this.state.messages.has(inReplyTo)) {
        const req = this.state.messages.get(inReplyTo)!;
        await this.sendMessage({
          from: a.createdBy,
          to: [req.from],
          type: "INFORM",
          threadId: req.threadId,
          replyTo: inReplyTo,
          artifactRefs: [{ uri: artifactUri(a.type, a.name, a.version), version: a.version }],
          payload: { summary: `Research complete: ${a.name}`, contentRef: a.contentRef },
        });
      }
    }
  }

  async transitionArtifact(
    actorId: string,
    artifactId: string,
    transition: { to: ArtifactStatus; evidenceEventIds?: string[]; comment?: string },
  ): Promise<{ ok: boolean; reason?: string; eventId?: string }> {
    const goalId = this.state.activeGoalId;
    if (!goalId) return { ok: false, reason: "no active goal" };
    const artifact = this.state.artifacts.get(artifactId);
    if (!artifact) return { ok: false, reason: `unknown artifact ${artifactId}` };
    const ctx = { config: this.config, projections: this.state, goal: this.state.goals.get(goalId) };
    const decision = this.deps.policy.evaluateTransition(artifact, transition.to, actorId, ctx);
    if (decision.decision !== "ALLOW") {
      await this.denied(actorId, artifactId, `transition -> ${transition.to}`, decision);
      return { ok: false, reason: decision.reason };
    }
    try {
      const evt = await this.deps.kernel.emit(
        "artifact.transition",
        {
          artifactId,
          to: transition.to,
          actorId,
          evidenceEventIds: transition.evidenceEventIds,
          comment: transition.comment,
          gateSatisfied: decision.decision === "ALLOW",
        },
        { actorId, goalId },
      );
      await this.mirrorTransition(artifact, transition.to, evt.id);
      return { ok: true, eventId: evt.id };
    } catch (err) {
      if (err instanceof KernelRejectedError) return { ok: false, reason: err.message };
      throw err;
    }
  }

  private async mirrorTransition(a: Artifact, to: ArtifactStatus, causationId: string): Promise<void> {
    if (a.type === "CodePatch" && to === "MERGED") {
      await this.deps.kernel.emit("patch.merged", { artifactId: a.id, name: a.name }, { actorId: a.owner, goalId: a.goalId, causationId });
      await this.deps.kernel.emit("implementation.completed", { artifactId: a.id, subject: "implementation" }, { actorId: a.owner, goalId: a.goalId, causationId });
    }
    if (a.type === "ReleasePlan") {
      await this.deps.kernel.emit("release.transition", { artifactId: a.id, to }, { goalId: a.goalId, causationId });
      if (to === "ACCEPTED") {
        await this.deps.kernel.emit("release.accepted", { artifactId: a.id, subject: `artifact:${a.id}` }, { goalId: a.goalId, causationId });
        await this.markCriterionEvidence("implementation-merged", { kind: "release-accepted", artifactRef: { uri: artifactUri(a.type, a.name, a.version) }, by: a.owner, recordedAt: this.deps.kernel.clock.iso() });
      }
    }
    if (to === "APPROVED" && (a.type === "ArchitectureDocument" || a.type === "ApiSpec")) {
      await this.markCriterionEvidence("architecture-approved", {
        kind: "architecture-approved",
        artifactRef: { uri: artifactUri(a.type, a.name, a.version) },
        by: a.owner,
        recordedAt: this.deps.kernel.clock.iso(),
      });
    }
    if (to === "MERGED") {
      await this.markCriterionEvidence("implementation-merged", {
        kind: "patch-merged",
        artifactRef: { uri: artifactUri(a.type, a.name, a.version) },
        recordedAt: this.deps.kernel.clock.iso(),
      });
    }
  }

  /**
   * Was the claim behind this evidence CHECKED, or merely stated?
   *
   * The claimer is the agent whose turn is in flight. A turn that invoked no
   * non-`mesh_*` tool read nothing, ran nothing and proved nothing, so its
   * evidence is the agent's own word. No turn in flight === an operator or
   * runtime-derived path (merge mirroring, human accept), which is verified by
   * construction and must not be downgraded.
   */
  private claimIsVerified(claimedBy: string | undefined): { verified: boolean; toolCalls?: number } {
    if (!claimedBy || claimedBy === HUMAN_AGENT_ID) return { verified: true };
    const tools = this.turnVerificationTools.get(claimedBy);
    if (tools === undefined) return { verified: true };
    return { verified: tools > 0, toolCalls: tools };
  }

  /**
   * Record evidence against an acceptance criterion.
   *
   * Returns what the criterion became, so the caller can tell the agent when
   * its claim landed as ASSERTED rather than EVIDENCED.
   */
  async markCriterionEvidence(
    criterionId: string,
    evidence: Goal["acceptanceCriteria"][number]["evidence"][number],
  ): Promise<"EVIDENCED" | "ASSERTED" | "SKIPPED"> {
    const goalId = this.state.activeGoalId;
    if (!goalId) return "SKIPPED";
    const goal = this.state.goals.get(goalId);
    if (!goal) return "SKIPPED";
    const c = goal.acceptanceCriteria.find((x) => x.id === criterionId);
    if (!c) return "SKIPPED";
    if (c.status === "EVIDENCED" || c.status === "WAIVED") return "SKIPPED";
    // A reopened criterion cannot be satisfied by the artifact the operator
    // just rejected. Without this the reopen loop is closed: reset status ->
    // agent re-cites the same URI -> EVIDENCED -> watchdog completes again.
    // The agent must supersede it (new version, new artifact) to get past.
    const uri = evidence.artifactRef?.uri;
    if (uri && c.rejectedEvidence?.includes(uri)) {
      this.auditLine(
        `criterion ${criterionId}: refusing rejected evidence ${uri} — the operator reopened the mission on this artifact; supersede it`,
      );
      return "SKIPPED";
    }
    // THE VERIFICATION GATE. An unverified claim may still be recorded — the
    // work described may well be real — but it lands as ASSERTED, which no
    // projection and no termination check counts as done. A live mission put
    // 138 turns through here with zero tool calls and closed as complete.
    const { verified, toolCalls } = this.claimIsVerified(evidence.by);
    // THE WORKFLOW GATE. Content alone is not enough for a MANDATORY criterion:
    // a real mission closed as complete with 7 of its 9 artifacts still
    // non-terminal, because `requirements-documented` went EVIDENCED citing a
    // RequirementsDoc that was never submitted to anyone. DRAFT means the owner
    // never even offered it for review; REJECTED means it was refused. Neither
    // is proof of anything, however well written. From READY_FOR_REVIEW onward
    // the artifact is at least on the record as work put forward, which is what
    // the review and transition gates then judge.
    //
    // Only an EVIDENCED claim needs a submitted artifact. An unverified claim
    // becomes ASSERTED either way, and ASSERTED never counts toward completion —
    // refusing it would just hide a claim the agent still needs to see.
    if (verified && c.mandatory && uri) {
      const cited = artifactForRef(this.state, undefined, uri);
      if (cited && (cited.status === "DRAFT" || cited.status === "REJECTED")) {
        this.auditLine(
          `criterion ${criterionId}: refusing ${cited.status} evidence '${cited.name}' — a mandatory criterion needs an artifact that was at least submitted for review`,
        );
        return "SKIPPED";
      }
    }
    if (!verified && c.status === "ASSERTED") {
      // Already on the record and nothing changed: re-asserting the same
      // unverified claim every turn must not spam the log.
      this.auditLine(`criterion ${criterionId}: repeat unverified claim by ${evidence.by} ignored (still ASSERTED)`);
      return "ASSERTED";
    }
    if (!verified) {
      this.auditLine(
        `criterion ${criterionId}: ASSERTED not EVIDENCED — ${evidence.by} claimed it from a turn that invoked 0 verification tools`,
      );
    }
    await this.deps.kernel.emit(
      "requirement.satisfied",
      { criterionId, evidence: { ...evidence, verified, ...(toolCalls !== undefined ? { toolCalls } : {}) }, verified },
      { actorId: HUMAN_AGENT_ID, goalId },
    );
    const updated = goal.acceptanceCriteria.filter((x) => x.mandatory && (x.status === "EVIDENCED" || x.status === "WAIVED")).length;
    const total = goal.acceptanceCriteria.filter((x) => x.mandatory).length;
    await this.deps.kernel.emit("goal.progress", { completed: updated, total, ratio: total ? updated / total : 0 }, { goalId });
    return verified ? "EVIDENCED" : "ASSERTED";
  }

  async requestApproval(artifactId: string, roleOrAgent: string): Promise<SendResult> {
    const a = this.state.artifacts.get(artifactId);
    if (!a) return { accepted: false, reason: "unknown artifact" };
    const reviewers = [...this.state.agents.values()]
      .filter((r) => r.definition.role === roleOrAgent || r.definition.id === roleOrAgent)
      .map((r) => r.definition.id);
    if (reviewers.length === 0) return { accepted: false, reason: `no agent with role ${roleOrAgent}` };
    return this.sendMessage({
      from: a.owner,
      to: reviewers,
      type: "REQUEST_REVIEW",
      newThread: { subject: `review ${a.name}`, artifactRefs: [{ uri: artifactUri(a.type, a.name, a.version) }] },
      artifactRefs: [{ uri: artifactUri(a.type, a.name, a.version) }],
      payload: { question: `Please review ${a.type} '${a.name}' v${a.version}` },
    });
  }

  /**
   * Stub check for artifact content cited against a mandatory criterion.
   *
   * Reads the stored content rather than trusting the publish call: the digest
   * alone cannot distinguish a real design doc from "TODO". Read failure is
   * treated as NOT substantive — unreadable evidence is not evidence.
   */
  private async evidenceIsSubstantive(artifact: Artifact): Promise<{ ok: boolean; reason?: string }> {
    let content: string;
    try {
      content = await this.deps.content.read(artifact.contentRef);
    } catch {
      return { ok: false, reason: `evidence artifact ${artifact.id} content is unreadable, so it cannot prove a mandatory criterion` };
    }
    const trimmed = content.trim();
    if (trimmed.length < MIN_EVIDENCE_CONTENT_CHARS) {
      return {
        ok: false,
        reason: `evidence artifact '${artifact.name}' holds only ${trimmed.length} chars — too thin to evidence a mandatory criterion (need at least ${MIN_EVIDENCE_CONTENT_CHARS}). Publish the actual deliverable, then accept against it.`,
      };
    }
    if (EVIDENCE_STUB_MARKERS.test(trimmed)) {
      return {
        ok: false,
        reason: `evidence artifact '${artifact.name}' starts as a placeholder, not a deliverable. Publish the real content, then accept against it.`,
      };
    }
    return { ok: true };
  }

  async recordDecision(actorId: string, kind: ApprovalKind, subject: string, artifactId?: string, comment?: string): Promise<{ ok: boolean; reason?: string; eventId?: string }> {
    const goalId = this.state.activeGoalId;
    if (!goalId) return { ok: false, reason: "no active goal" };
    const ctx = { config: this.config, projections: this.state, goal: this.state.goals.get(goalId) };
    const domain = this.domainOfSubject(subject, artifactId);
    const artifact = artifactId ? this.state.artifacts.get(artifactId) : undefined;
    if (subject.startsWith("criterion:") && (kind === "approve" || kind === "accept")) {
      const criterionId = subject.slice("criterion:".length);
      if (!artifactId && !comment) {
        const reason = "criterion acceptance requires evidence (artifactId and/or comment describing the evidence)";
        await this.denied(actorId, subject, "accept criterion", { decision: "DENY", reason, ruleId: "evidence-required" });
        return { ok: false, reason };
      }
      // A MANDATORY criterion is what the mission is judged on, so a sentence
      // is not evidence for it. Accepting `comment` alone here let a run tick
      // all five mandatory criteria with prose and terminate as "complete"
      // while producing nothing: the termination gate only counts EVIDENCED,
      // and nothing downstream ever re-checked that the evidence was real.
      // Optional criteria keep the comment-only path.
      const criterion = this.state.goals.get(goalId)?.acceptanceCriteria.find((c) => c.id === criterionId);
      if (criterion?.mandatory) {
        if (!artifactId) {
          const reason = `criterion '${criterionId}' is mandatory: acceptance requires artifactId pointing at the published deliverable that proves it (a comment alone is not evidence)`;
          await this.denied(actorId, subject, "accept criterion", { decision: "DENY", reason, ruleId: "mandatory-evidence-artifact-required" });
          return { ok: false, reason };
        }
        if (!artifact) {
          const reason = `unknown artifact ${artifactId} cited as evidence for mandatory criterion '${criterionId}'`;
          await this.denied(actorId, subject, "accept criterion", { decision: "DENY", reason, ruleId: "mandatory-evidence-artifact-required" });
          return { ok: false, reason };
        }
        if (artifact.goalId !== goalId) {
          const reason = `artifact ${artifactId} belongs to a previous goal and cannot evidence mandatory criterion '${criterionId}'`;
          await this.denied(actorId, subject, "accept criterion", { decision: "DENY", reason, ruleId: "mandatory-evidence-stale-artifact" });
          return { ok: false, reason };
        }
        const substantive = await this.evidenceIsSubstantive(artifact);
        if (!substantive.ok) {
          await this.denied(actorId, subject, "accept criterion", { decision: "DENY", reason: substantive.reason!, ruleId: "mandatory-evidence-too-thin" });
          return { ok: false, reason: substantive.reason };
        }
        // Substantive but never submitted. `markCriterionEvidence` refuses this
        // too, but silently — the accepting agent must be told what to do next
        // or it reports the mission done on a document nobody has seen. An
        // unverified claim is exempt: it lands ASSERTED, which cannot complete
        // anything, so denying it would only hide the claim.
        const { verified: claimVerified } = this.claimIsVerified(actorId);
        if (claimVerified && (artifact.status === "DRAFT" || artifact.status === "REJECTED")) {
          const reason =
            `artifact '${artifact.name}' is ${artifact.status} and cannot evidence mandatory criterion '${criterionId}' — ` +
            `request review on it (or transition it to READY_FOR_REVIEW) and let it clear its gates, then accept against it`;
          await this.denied(actorId, subject, "accept criterion", { decision: "DENY", reason, ruleId: "mandatory-evidence-not-submitted" });
          return { ok: false, reason };
        }
      }
      const acceptCheck = this.deps.policy.evaluateAuthority(actorId, "requirements", "accept", ctx);
      const overrideCheck = this.deps.policy.evaluateAuthority(actorId, "requirements", "approve", ctx);
      if (acceptCheck.decision !== "ALLOW" && overrideCheck.decision !== "ALLOW") {
        await this.denied(actorId, subject, "accept criterion", acceptCheck);
        return { ok: false, reason: acceptCheck.reason };
      }
      const evt = await this.deps.kernel.emit(
        "review.approved",
        {
          subject: `criterion:${criterionId}`,
          artifactId,
          artifactRef: artifact ? { uri: artifactUri(artifact.type, artifact.name, artifact.version) } : undefined,
          actorId,
          actorRole: this.state.agents.get(actorId)?.definition.role ?? actorId,
          comment,
        },
        { actorId, goalId },
      );
      const landed = await this.markCriterionEvidence(criterionId, {
        kind: "criteria-acceptance",
        artifactRef: artifact ? { uri: artifactUri(artifact.type, artifact.name, artifact.version) } : undefined,
        eventId: evt.id,
        by: actorId,
        recordedAt: this.deps.kernel.clock.iso(),
      });
      // The acceptance was recorded either way, so this is not a failure — but
      // the agent MUST learn that the criterion is not closed, or it will
      // report the mission done and go idle on an unproven claim.
      if (landed === "ASSERTED") {
        return {
          ok: true,
          eventId: evt.id,
          reason:
            `recorded as ASSERTED, not EVIDENCED: this turn invoked no verification tool, so nothing was checked — '${criterionId}' still does not count toward completion. Run the check (read the artifact, execute the tests, inspect the workspace) in the turn that accepts it.`,
        };
      }
      return { ok: true, eventId: evt.id };
    }
    let authorityCheck = this.deps.policy.evaluateAuthority(actorId, domain, kind, ctx);
    if (authorityCheck.decision !== "ALLOW" && artifact && (kind === "approve" || kind === "reject")) {
      const reviewCap = capabilityForReview(artifact.type);
      if (reviewCap) {
        const capCheck = this.deps.policy.evaluateCapability(actorId, reviewCap, ctx);
        if (capCheck.decision === "ALLOW" && (artifact.owner !== actorId || !this.hasPeerReviewer(actorId, artifact))) {
          authorityCheck = capCheck;
        }
      }
    }
    if (authorityCheck.decision !== "ALLOW") {
      await this.denied(actorId, artifactId ?? subject, `${kind} ${subject}`, authorityCheck);
      return { ok: false, reason: authorityCheck.reason };
    }
    if (artifact && artifact.owner === actorId && (kind === "approve" || kind === "pass") && this.hasPeerReviewer(actorId, artifact)) {
      const reason = "artifact owner cannot approve their own artifact";
      await this.denied(actorId, artifactId, "self-approval", { decision: "DENY", reason, ruleId: "self-approval" });
      return { ok: false, reason };
    }
    const payload = {
      subject: artifactId ? `artifact:${artifactId}` : subject,
      fallbackSubject: subject,
      // The declared verdict must survive the emit. `approve` and `pass` share
      // the `review.approved` event type, so without this the projection cannot
      // tell them apart and a gate written as `qa.pass` is unsatisfiable by any
      // deliberate agent op.
      kind,
      artifactId,
      artifactRef: artifact ? { uri: artifactUri(artifact.type, artifact.name, artifact.version) } : undefined,
      actorId,
      actorRole: this.state.agents.get(actorId)?.definition.role ?? actorId,
      comment,
    };
    let type: EventType;
    if (kind === "approve" || kind === "pass") type = "review.approved";
    else if (kind === "reject" || kind === "veto") type = "review.rejected";
    else if (kind === "block") type = "message.sent";
    else type = "review.approved";
    if (domain === "architecture" && kind === "approve") {
      const evt = await this.deps.kernel.emit("architecture.approved", { ...payload, subject: "architecture" }, { actorId, goalId });
      await this.auditTransition(artifactId, evt.id, goalId);
      await this.markCriterionEvidence("architecture-approved", { kind: "approval", by: actorId, recordedAt: this.deps.kernel.clock.iso() });
      await this.settleReviewAsks(actorId, artifact, evt.id);
      return { ok: true, eventId: evt.id };
    }
    if (kind === "block") {
      const requesters = [...this.state.pendingRequests.values()]
        .filter((pr) => stillOwes(pr, actorId) && pr.type.startsWith("REQUEST"))
        .map((pr) => pr.from);
      const targets = artifact ? [artifact.owner] : [HUMAN_AGENT_ID, ...new Set(requesters)];
      const m = await this.sendMessage({
        from: actorId,
        to: targets,
        type: "BLOCK",
        newThread: { subject: `BLOCK ${subject}` },
        artifactRefs: artifact ? [{ uri: artifactUri(artifact.type, artifact.name, artifact.version) }] : [],
        payload: { subject: domain, artifactId, reason: comment ?? "blocked" },
        priority: "HIGH",
      });
      if (!m.accepted) {
        await this.deps.kernel.emit("review.rejected", { subject, artifactId, actorId, actorRole: this.state.agents.get(actorId)?.definition.role ?? actorId, comment, blockedInstead: true }, { actorId, goalId });
      }
      return { ok: m.accepted, reason: m.reason, eventId: m.eventId };
    }
    const evt = await this.deps.kernel.emit(type, payload, { actorId, goalId });
    await this.auditTransition(artifactId, evt.id, goalId);
    await this.settleReviewAsks(actorId, artifact, evt.id);
    if (kind === "pass" && (domain === "quality" || domain === "release")) {
      await this.markCriterionEvidence(domain === "quality" ? "quality-verified" : "security-verified", {
        kind: `${domain}-pass`,
        by: actorId,
        recordedAt: this.deps.kernel.clock.iso(),
      });
    }
    if (kind === "pass" && domain === "security") {
      await this.markCriterionEvidence("security-verified", { kind: "security-pass", by: actorId, recordedAt: this.deps.kernel.clock.iso() });
    }
    return { ok: true, eventId: evt.id };
  }

  private domainOfSubject(subject: string, artifactId?: string): string {
    return domainOfSubject(this.state, subject, artifactId);
  }

  private async settleReviewAsks(actorId: string, artifact: Artifact | undefined, eventId: string): Promise<void> {
    if (!artifact) return;
    // A verdict on an artifact settles the asks that pointed at that artifact
    // — per debtor, so a second reviewer's silent turn still pins itself.
    const uri = artifactUri(artifact.type, artifact.name, artifact.version);
    for (const pr of [...this.state.pendingRequests.values()]) {
      if (!stillOwes(pr, actorId)) continue;
      if (!pr.type.startsWith("REQUEST")) continue;
      if (!pr.artifactUris?.includes(uri)) continue;
      await this.dischargeCommitment(pr.messageId, "artifact_review", actorId, { artifactId: artifact.id, viaEvent: eventId });
    }
  }

  private async denied(actorId: string, subjectId: string | undefined, action: string, decision: PolicyDecisionResult): Promise<void> {
    const goalId = this.state.activeGoalId ?? undefined;
    await this.deps.kernel.emit(
      "message.rejected",
      { from: actorId, action, subject: subjectId, reason: decision.reason, ruleId: decision.ruleId, denied: true },
      { actorId, goalId },
    );
  }

  async claimTask(actorId: string, taskId: string): Promise<{ ok: boolean; reason?: string }> {
    const task = this.state.tasks.get(taskId);
    if (!task) return { ok: false, reason: "unknown task" };
    if (task.status !== "OPEN" && task.assignedTo !== actorId) return { ok: false, reason: `task is ${task.status}` };
    const ctx = { config: this.config, projections: this.state, goal: this.state.goals.get(task.goalId) };
    for (const cap of task.requiredCapabilities) {
      const decision = this.deps.policy.evaluateCapability(actorId, cap, ctx);
      if (decision.decision !== "ALLOW") {
        await this.denied(actorId, taskId, `claim task (missing capability ${cap})`, decision);
        return { ok: false, reason: `missing capability ${cap}: ${decision.reason}` };
      }
    }
    await this.deps.kernel.emit("task.claimed", { taskId, agentId: actorId, reassign: task.assignedTo && task.assignedTo !== actorId }, { actorId });
    return { ok: true };
  }

  async completeTask(actorId: string, taskId: string, summary: string, artifacts?: ArtifactRef[]): Promise<{ ok: boolean; reason?: string }> {
    const task = this.state.tasks.get(taskId);
    if (!task) return { ok: false, reason: "unknown task" };
    if (task.status !== "CLAIMED" && task.status !== "IN_PROGRESS") return { ok: false, reason: `task is ${task.status}` };
    if (task.claimedBy !== actorId && actorId !== HUMAN_AGENT_ID) return { ok: false, reason: `task claimed by ${task.claimedBy}` };
    const gate = this.config.transitionGates["implementation.completed"];
    if (gate && gate.length > 0 && task.requiredCapabilities.includes("implementation.gate")) {
      const res = checkApprovals(this.state, gate, undefined);
      if (!res.ok) return { ok: false, reason: `implementation gate unsatisfied, missing: ${res.missing.join(", ")}` };
    }
    await this.deps.kernel.emit("task.completed", { taskId, agentId: actorId, summary, artifacts }, { actorId });
    return { ok: true };
  }

  async proposeDecision(actorId: string, topic: string, decision: Record<string, unknown>, evidence?: ArtifactRef[]): Promise<DecisionRecord> {
    const goalId = this.state.activeGoalId!;
    const d: DecisionRecord = {
      id: newDecisionId(),
      goalId,
      topic,
      decision,
      status: "PROPOSED",
      proposedBy: actorId,
      approvedBy: [],
      evidence: evidence ?? [],
      createdAt: this.deps.kernel.clock.iso(),
    };
    await this.deps.kernel.emit("decision.proposed", { decision: d }, { actorId, goalId });
    return d;
  }

  async ratifyDecision(actorId: string, decisionId: string): Promise<{ ok: boolean; reason?: string }> {
    const d = this.state.decisions.get(decisionId);
    if (!d) return { ok: false, reason: "unknown decision" };
    const ctx = { config: this.config, projections: this.state, goal: this.state.goals.get(this.state.activeGoalId ?? "") };
    const decisionResult = this.deps.policy.evaluateAuthority(actorId, "architecture", "approve", ctx);
    if (decisionResult.decision !== "ALLOW") {
      await this.denied(actorId, decisionId, "ratify decision", decisionResult);
      return { ok: false, reason: decisionResult.reason };
    }
    await this.deps.kernel.emit("decision.ratified", { decisionId, approvedBy: [actorId], actorRole: d.approvedBy }, { actorId });
    return { ok: true };
  }

  async escalate(input: {
    reason: string;
    raisedBy: string;
    detail?: unknown;
    conflictKey?: string;
    artifactId?: string;
    threadId?: string;
    participants?: string[];
    kind?: EscalationKind;
    supports?: string[];
    advisory?: boolean;
  }): Promise<Escalation> {
    const goalId = this.state.activeGoalId ?? "";
    // Identity must NOT depend on volatile detail. A derived card's detail
    // lists the primaries it summarizes, so hashing detail made its
    // conflictKey mutate every time that set changed — the dedupe below then
    // missed and the watchdog minted a fresh duplicate card on every tick.
    // Derived cards are keyed by (goal, reason) alone: there is exactly one
    // live `stalemate` summary per goal, by construction.
    const kind: EscalationKind = input.kind ?? classifyEscalation(input.reason, input.raisedBy);
    const conflictKey =
      input.conflictKey ??
      (kind === "derived"
        ? `derived:${input.reason}:${goalId}`
        : `esc:${shortHash(input.reason + JSON.stringify(input.detail ?? ""))}`);
    const existing = [...this.state.escalations.values()].find((e) => e.status === "OPEN" && e.conflictKey === conflictKey);
    if (existing) return existing;
    // Dedupe is check-then-act across the `await` below, so two callers could
    // both pass the check and both emit — exactly what happens when an agent
    // escalates while the watchdog is deriving its summary, or when two
    // watchdog ticks overlap. Reserve the key synchronously (no await between
    // the check and the reservation) so the loser waits for and returns the
    // winner's card instead of minting a duplicate.
    const inflight = this.escalationsInFlight.get(conflictKey);
    if (inflight) return await inflight;
    let settle: (e: Escalation) => void = () => undefined;
    let fail: (err: unknown) => void = () => undefined;
    this.escalationsInFlight.set(
      conflictKey,
      new Promise<Escalation>((res, rej) => {
        settle = res;
        fail = rej;
      }),
    );
    try {
      const esc = await this.createEscalation(input, { goalId, conflictKey, kind });
      settle(esc);
      return esc;
    } catch (err) {
      fail(err);
      throw err;
    } finally {
      this.escalationsInFlight.delete(conflictKey);
    }
  }

  private async createEscalation(
    input: { reason: string; raisedBy: string; detail?: unknown; artifactId?: string; threadId?: string; participants?: string[]; supports?: string[]; advisory?: boolean },
    ctx: { goalId: string; conflictKey: string; kind: EscalationKind },
  ): Promise<Escalation> {
    const { goalId, conflictKey, kind } = ctx;
    let disagreementRef: ArtifactRef | undefined;
    const positions = this.buildDisagreementContent(input);
    const created = await this.createArtifact({
      actorId: HUMAN_AGENT_ID,
      name: `decision-conflict-${shortHash(conflictKey)}`,
      type: "DisagreementRecord",
      content: JSON.stringify(positions, null, 2),
      metadata: { conflictKey, participants: input.participants ?? [] },
      provenanceSource: "system",
    });
    if ("artifact" in created) {
      disagreementRef = { uri: created.uri };
    }
    const esc: Escalation = {
      id: newEscalationId(),
      goalId,
      reason: input.reason,
      detail: { ...(typeof input.detail === "object" && input.detail !== null ? input.detail : { detail: input.detail }), disagreementRef },
      raisedBy: input.raisedBy,
      conflictKey,
      disagreementArtifactRef: disagreementRef,
      status: "OPEN",
      kind,
      supports: input.supports ? [...input.supports] : undefined,
      advisory: input.advisory,
      createdAt: this.deps.kernel.clock.iso(),
    };
    await this.deps.kernel.emit("escalation.requested", { escalation: esc }, { actorId: input.raisedBy, goalId });
    return esc;
  }

  /**
   * The scheduler nudged this agent about an unanswered request MAX times and
   * it still hasn't resolved. Turn that into a real protocol escalation (stale
   * mate) instead of silently burning budget forever (§33.4 / §34).
   */
  async escalateStuckRequest(agentId: string, messageId: string): Promise<void> {
    const pending = this.state.pendingRequests.get(messageId);
    if (!pending) return;
    const request = this.state.messages.get(messageId);
    await this.escalate({
      reason: "stalemate:unanswered_request",
      raisedBy: "deadlock-detector",
      conflictKey: `stuck:${messageId}:${agentId}`,
      detail: {
        agentId,
        requestMessageId: messageId,
        requestType: request?.type,
        awaitingSince: pending.createdAt,
        note: "no progress on this request after the nudge limit; needs an operator decision or a rework of the workflow",
      },
    });
  }

  private buildDisagreementContent(input: { reason: string; artifactId?: string; threadId?: string }): Record<string, unknown> {
    const positions: Array<Record<string, unknown>> = [];
    const artifact = input.artifactId ? this.state.artifacts.get(input.artifactId) : undefined;
    const relevant = [...this.state.messages.values()].filter((m) => {
      if (input.threadId && m.threadId !== input.threadId) return false;
      if (artifact && !m.artifactRefs.some((r) => r.uri.includes(artifact.name))) return false;
      return ["REJECT", "BLOCK", "VETO", "CHALLENGE", "APPROVE", "ESCALATE"].includes(m.type);
    });
    for (const m of relevant.slice(-20)) {
      positions.push({
        agent: m.from,
        stance: m.type,
        at: m.timestamp,
        message: JSON.stringify(m.payload).slice(0, 300),
        attempts: m.artifactRefs.map((r) => r.uri),
      });
    }
    const evidence = artifact
      ? this.state.artifactHistory.get(artifact.id)?.map((v) => ({ version: v.version, digest: v.digest, status: v.status })) ?? []
      : [];
    return {
      reason: input.reason,
      positions,
      evidence,
      remainingDisagreement: positions.filter((p) => ["REJECT", "BLOCK", "VETO", "CHALLENGE"].includes(p.stance as string)).map((p) => p.agent),
    };
  }

  async respondEscalation(escalationId: string, response: string, by = HUMAN_AGENT_ID): Promise<{ ok: boolean; reason?: string }> {
    const esc = this.state.escalations.get(escalationId);
    if (!esc) return { ok: false, reason: "unknown escalation" };
    // A card the runtime already retired is not an error for the operator:
    // they answered a real question, the mesh simply resolved it first (the
    // agent replied while the dashboard was open). Failing here would surface
    // a scary red "respond failed" for a mission that is in fact unblocked, so
    // treat it as a satisfied no-op and still make sure nothing stays parked.
    if (esc.status === "AUTO_RESOLVED") {
      await this.reconcileDerivedEscalations();
      if (this.state.activeGoalId) await this.resumeIfNothingPending(this.state.activeGoalId);
      return { ok: true, reason: "already resolved by the mesh — nothing left to decide" };
    }
    if (esc.status !== "OPEN") return { ok: false, reason: `escalation is ${esc.status}` };
    await this.deps.kernel.emit("escalation.responded", { escalationId, response, respondedBy: by }, { actorId: by });
    await this.deps.kernel.emit("human.input", { action: "escalation_response", escalationId, response }, { actorId: HUMAN_AGENT_ID });
    const goal = this.state.goals.get(esc.goalId);
    if (goal && goal.status === "ESCALATED") {
      await this.deps.kernel.emit("goal.status_changed", { goalId: goal.id, status: "ACTIVE", reason: "escalation responded" }, { actorId: HUMAN_AGENT_ID });
    }
    if (esc.raisedBy && esc.raisedBy !== HUMAN_AGENT_ID && this.state.agents.has(esc.raisedBy)) {
      await this.sendMessage({
        from: HUMAN_AGENT_ID,
        to: [esc.raisedBy],
        type: "INFORM",
        newThread: { subject: `escalation response ${escalationId}` },
        payload: { escalationId, response },
        priority: "URGENT",
      });
    }
    // Stuck-request escalations are raised by the watchdog, not by the stuck
    // agent — so the generic raiser-wake above notifies nobody. Wake the stuck
    // agent explicitly and let the scheduler nudge it again; otherwise the
    // mission resumes but the original request stalls forever behind
    // `stuckEscalated` suppression.
    const stuck = stuckRequestOf(esc);
    if (stuck) {
      this.deps.scheduler.resetStallTracking?.(stuck.messageId, stuck.agentId);
      if (this.state.agents.has(stuck.agentId)) {
        await this.activateAgent(stuck.agentId, { kind: "recovery", note: `escalation responded: ${response.slice(0, 120)}` });
      }
    } else if (isDerivedEscalation(esc)) {
      // A derived card carries no decision of its own: answering the summary
      // means answering everything it summarizes. Push the operator's response
      // down to each still-open primary (which clears their stall tracking via
      // this same method) rather than just flipping the goal ACTIVE — else the
      // next watchdog tick re-derives the summary and re-parks within ~1s.
      for (const id of supportsOf(esc)) {
        const u = this.state.escalations.get(id);
        if (!u || u.status !== "OPEN") continue;
        await this.respondEscalation(id, response, by);
      }
    }
    // One central sweep replaces the old hand-rolled sibling loop: any derived
    // summary left without an open support is now retired here, whatever path
    // closed the primary.
    await this.reconcileDerivedEscalations();
    for (const c of this.recoveryCandidates()) {
      if (c !== esc.raisedBy && (!stuck || c !== stuck.agentId)) await this.activateAgent(c, { kind: "recovery", note: "escalation responded" });
    }
    return { ok: true };
  }

  /**
   * Raise a budget limit at runtime (operator action from a budget
   * escalation). Accepts an absolute `limit` or an `add` increment on top of
   * the current limit. The change is event-sourced (`budget.limit_raised`),
   * so replay preserves it. Does not resume the mission — pair with
   * `respondEscalation` (the dashboard's "add & resume" does both).
   */
  async raiseBudget(
    key: string,
    opts: { limit?: number; add?: number; by?: string; reason?: string } = {},
  ): Promise<{ ok: boolean; reason?: string; key?: string; previous?: number | null; limit?: number; unblocked?: boolean }> {
    const ledger = this.state.budgets.get(key);
    if (!ledger) return { ok: false, reason: `unknown budget '${key}'` };
    const by = opts.by ?? HUMAN_AGENT_ID;
    let next: number | undefined = opts.limit;
    if (next === undefined && opts.add !== undefined) {
      if (ledger.limit === null) return { ok: false, reason: `budget '${key}' is unlimited — nothing to raise` };
      next = ledger.limit + opts.add;
    }
    if (next === undefined || !Number.isFinite(next)) return { ok: false, reason: "provide a new absolute `limit` or an `add` increment" };
    if (ledger.limit !== null && next <= ledger.limit) {
      return { ok: false, reason: `new limit (${next}) must be above the current limit (${ledger.limit})` };
    }
    const goalId = this.state.activeGoalId ?? undefined;
    const res = await this.deps.budget.raiseLimit(key, next, { actorId: by, goalId, reason: opts.reason ?? "operator raise from escalation" });
    return { ok: true, key, previous: res.previous, limit: res.limit, unblocked: res.unblocked };
  }

  /**
   * Raise mission-level caps (maxEvents / wallClockMinutes) at runtime.
   * Stored on the goal via `goal.budget_changed`, so replay preserves the
   * override without touching mesh.yaml. Does not resume — pair with
   * `respondEscalation` (the dashboard's one button does both).
   */
  async adjustGoalBudget(
    patch: { maxEvents?: number; wallClockMinutes?: number },
    opts: { by?: string; reason?: string; goalId?: GoalId } = {},
  ): Promise<{ ok: boolean; reason?: string; budget?: Goal["budget"] }> {
    const gid = opts.goalId ?? this.state.activeGoalId;
    if (!gid) return { ok: false, reason: "no active goal" };
    const goal = this.state.goals.get(gid);
    if (!goal) return { ok: false, reason: "unknown goal" };
    const clean: Partial<Goal["budget"]> = {};
    if (patch.maxEvents !== undefined) {
      if (!Number.isFinite(patch.maxEvents) || patch.maxEvents <= goal.budget.maxEvents) {
        return { ok: false, reason: `maxEvents must exceed the current cap (${goal.budget.maxEvents})` };
      }
      clean.maxEvents = Math.floor(patch.maxEvents);
    }
    if (patch.wallClockMinutes !== undefined) {
      if (!Number.isFinite(patch.wallClockMinutes) || patch.wallClockMinutes <= goal.budget.wallClockMinutes) {
        return { ok: false, reason: `wallClockMinutes must exceed the current cap (${goal.budget.wallClockMinutes})` };
      }
      clean.wallClockMinutes = Math.floor(patch.wallClockMinutes);
    }
    if (Object.keys(clean).length === 0) return { ok: false, reason: "provide maxEvents and/or wallClockMinutes to raise" };
    await this.deps.kernel.emit(
      "goal.budget_changed",
      { goalId: gid, budget: clean, reason: opts.reason ?? "operator raise from escalation" },
      { actorId: opts.by ?? HUMAN_AGENT_ID, goalId: gid },
    );
    return { ok: true, budget: this.state.goals.get(gid)?.budget };
  }

  /**
   * Raise an exhausted agent/thread budget WITHOUT asking a human, up to a
   * ceiling expressed as a multiple of the budget's original limit.
   *
   * The escalation channel is the mission's scarcest resource: it stops the
   * mesh and waits for a person. Spending it on "the thread hit 60k, may I
   * have more" made it worthless — one live run raised 9 escalations, all 9
   * about budgets, every one answered with the same sentence. Meanwhile each
   * exhausted thread killed a live conversation mid-flight and forced the
   * agents into a fresh thread with no context, which is the single biggest
   * destroyer of continuity in the log.
   *
   * The ceiling is what keeps this honest: a runaway agent still stops, it
   * just stops at `maxMultiple x original` instead of at 1x — and THAT
   * escalation carries real information ("this mission wants 8x its budget"),
   * which is a judgement a human should actually make.
   *
   * `originalLimit` is the configured limit, not the current one: the ceiling
   * must be anchored to the declared intent, or repeated raises would raise
   * the ceiling with them and the cap would never bind.
   *
   * @returns true when the limit was raised (caller should retry the reserve).
   */
  private async tryAutoRaise(key: string, originalLimit: number | null, actorId?: string): Promise<boolean> {
    const cfg = this.config.budgets.autoRaise;
    if (!cfg.enabled) return false;
    if (originalLimit === null || !Number.isFinite(originalLimit) || originalLimit <= 0) return false;
    const ledger = this.state.budgets.get(key);
    if (!ledger || ledger.limit === null) return false;
    const ceiling = Math.floor(originalLimit * cfg.maxMultiple);
    if (ledger.limit >= ceiling) {
      this.auditLine(`budget ${key} at auto-raise ceiling (${ledger.limit}/${ceiling}, consumed ${ledger.consumed}) — escalating to the operator`);
      return false;
    }
    // Always clear the current turn's demand, otherwise a turn whose reserve
    // exceeds one raise blocks anyway and the raise is pure waste.
    const next = Math.min(ceiling, Math.max(Math.floor(ledger.limit * cfg.factor), ledger.consumed + ledger.reserved + TURN_RESERVE_TOKENS));
    if (next <= ledger.limit) return false;
    await this.deps.budget.raiseLimit(key, next, {
      actorId: actorId ?? HUMAN_AGENT_ID,
      goalId: this.state.activeGoalId ?? undefined,
      reason: `auto-raise: ${ledger.consumed}/${ledger.limit} exhausted; ceiling ${ceiling} (${cfg.maxMultiple}x ${originalLimit})`,
    });
    this.auditLine(`budget ${key} auto-raised ${ledger.limit} -> ${next} (ceiling ${ceiling})`);
    return true;
  }

  /**
   * How many tokens to hold for ONE upcoming turn by `agentId`.
   *
   * The flat 32k it replaces was not a bad estimate, it was no estimate: a
   * doc-writing agent that spends 3k a turn was charged the same hold as an
   * architect that spends 120k, so small ledgers refused cheap turns while
   * large turns were nowhere near covered. Sizing from observed cost makes the
   * hold mean something in both directions.
   *
   * Bounded on both ends on purpose. The floor stops a run of trivial turns
   * from shrinking the hold to nothing (the next turn may not be trivial); the
   * ceiling keeps the 32k worst-case contract that `tryAutoRaise` and the
   * termination tests are written against.
   */
  private sizedTurnReserve(agentId: string, ceiling = TURN_RESERVE_TOKENS): number {
    const cap = Math.max(1, Math.floor(ceiling));
    const observed = this.turnCostEstimate.get(agentId);
    // No history: charge the pessimistic bound, exactly as before.
    if (observed === undefined || !Number.isFinite(observed) || observed <= 0) {
      return cap;
    }
    const want = Math.ceil(observed * TURN_COST_SAFETY_FACTOR);
    return Math.min(cap, Math.max(Math.min(MIN_TURN_RESERVE_TOKENS, cap), want));
  }

  /**
   * Fold one settled turn's real cost into the agent's rolling estimate.
   *
   * Zero-token turns are ignored rather than averaged in: a turn that produced
   * no usage figure (stub runtime, failed call, backend that omits usage) is
   * missing data, and treating it as "this agent costs 0" would drive the next
   * reservation straight to the floor.
   */
  private noteTurnCost(agentId: string, tokens: number): void {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    const prev = this.turnCostEstimate.get(agentId);
    const next = prev === undefined ? tokens : prev + TURN_COST_EWMA_ALPHA * (tokens - prev);
    this.turnCostEstimate.set(agentId, next);
  }

  /**
   * Sweep every exhausted agent/thread ledger through `tryAutoRaise`.
   *
   * The turn path only raises the ledger of the turn that is trying to run,
   * which is not enough: an exhausted ledger latches `exceeded`, and the
   * termination manager reads that latch on a timer. So a thread that overran
   * while its agents happened to go idle would escalate the whole mission
   * before any turn ever asked for a reservation again.
   *
   * Mission-level budgets are deliberately NOT auto-raised: the mission cap is
   * the operator's statement of how much this whole thing is worth, and that
   * is exactly the judgement worth interrupting a human for.
   */
  private async autoRaiseExhaustedLedgers(): Promise<void> {
    if (!this.config.budgets.autoRaise.enabled) return;
    const goalId = this.state.activeGoalId;
    if (!goalId) return;
    for (const ledger of [...this.state.budgets.values()]) {
      if (!ledger.exceeded) continue;
      let original: number | null = null;
      if (ledger.key.startsWith(`agent:${goalId}/`)) {
        const agentId = ledger.key.slice(`agent:${goalId}/`.length);
        original = this.state.agents.get(agentId)?.definition.budget.tokens
          ?? this.config.budgets.perAgent[agentId]
          ?? this.config.budgets.agentDefaults.tokens;
      } else if (ledger.key.startsWith(`thread:${goalId}/`)) {
        original = this.config.budgets.threadTokens;
      } else continue;
      await this.tryAutoRaise(ledger.key, original);
    }
  }

  async pauseGoal(goalId?: GoalId): Promise<void> {
    const gid = goalId ?? this.state.activeGoalId;
    if (!gid) return;
    await this.deps.kernel.emit("goal.paused", { goalId: gid, reason: "user pause" }, { actorId: HUMAN_AGENT_ID });
  }

  async resumeGoal(goalId?: GoalId): Promise<void> {
    const gid = goalId ?? this.state.activeGoalId;
    if (!gid) return;
    await this.deps.kernel.emit("goal.resumed", { goalId: gid, reason: "user resume" }, { actorId: HUMAN_AGENT_ID });
    for (const c of this.recoveryCandidates()) {
      await this.activateAgent(c, { kind: "recovery", note: "goal resumed" });
    }
  }

  /**
   * Put a finished mission back to work because the operator rejected the
   * result. `resumeGoal` cannot do this: it only lifts PAUSED, and completion
   * is a deeper stop than a pause — `completeMission()` marked idle agents
   * COMPLETED and called `shutdown()`, which set `stopping` and killed the
   * scheduler, the stall watch and every runtime session.
   *
   * So reopening has to undo all four layers, in order:
   *   1. the goal verdict (and the evidence that would immediately re-fire it)
   *   2. the agent lifecycles frozen at COMPLETED
   *   3. the supervisor's own `stopping` latch + stall watch
   *   4. the scheduler
   * Skipping any one of them produces the failure this method exists to fix:
   * mail is delivered, the agent wakes, and every op it emits is rejected
   * with "mission is COMPLETED".
   */
  async reopenGoal(opts: {
    reason?: string;
    criteria?: string[];
    addCriteria?: AcceptanceCriterion[];
    by?: string;
    activate?: string[];
  } = {}): Promise<{
    ok: boolean;
    reason?: string;
    revived?: string[];
    /** completed agents whose revival the reducer refused — still unreachable */
    notRevived?: string[];
    activated?: string[];
    /** targets the scheduler would not queue, with why */
    refused?: Array<{ agentId: string; reason: string }>;
    unsatisfied?: string[];
    /** set when the reopen answered the open escalations that were halting the mission */
    escalationsCleared?: boolean;
    /** the reopen succeeded but nothing will run until someone is woken */
    warning?: string;
    /** agent the operator's feedback was handed to as an outstanding ask */
    feedbackTo?: string;
    /** criteria minted from the reopen reason (ids the mission now blocks on) */
    addedCriteria?: string[];
  }> {
    const gid = this.state.activeGoalId;
    if (!gid) return { ok: false, reason: "no active goal" };
    const goal = this.state.goals.get(gid);
    if (!goal) return { ok: false, reason: "unknown goal" };
    if (goal.status !== "COMPLETED" && goal.status !== "FAILED" && goal.status !== "ESCALATED") {
      return { ok: false, reason: `mission is ${goal.status} — reopen only applies to a COMPLETED, FAILED or ESCALATED mission` };
    }
    const by = opts.by ?? HUMAN_AGENT_ID;
    const reason = opts.reason ?? "operator rejected the delivered result";
    const wasEscalated = goal.status === "ESCALATED";

    // The operator's REASON is the whole content of a reopen, and it used to
    // go nowhere: it was free text on the event payload, while the criteria
    // list — the only to-do list agents actually read — was reset to the SAME
    // 16 items they already held evidence for. Agents were told "drive an
    // unmet criterion forward" about criteria they had just satisfied, with
    // the actual instruction ("I want best app not mvp") invisible. One live
    // mission produced 4 turns in 14 minutes after such a reopen.
    //
    // So the reason becomes a real mandatory criterion. Deterministic id, so
    // reopening twice for the same reason reuses the criterion instead of
    // growing the list (the projection skips ids it already has).
    //
    // Only when a VERDICT was rejected. An ESCALATED mission was halted
    // mid-flight by an open card and never judged, so reopening it is
    // "carry on", not "this was not good enough" — minting a mandatory
    // criterion there would invent a requirement the operator never stated
    // and block a mission whose work nobody rejected. Same rule the criteria
    // reset already follows.
    const hadVerdict = goal.status === "COMPLETED" || goal.status === "FAILED";
    const mintedId = `operator-feedback-${shortHash(reason)}`;
    const minted: AcceptanceCriterion[] = [...(opts.addCriteria ?? [])];
    if (hadVerdict && !goal.acceptanceCriteria.some((c) => c.id === mintedId) && !minted.some((c) => c.id === mintedId)) {
      minted.push({
        id: mintedId,
        description: `Operator reopened the mission: "${reason}". This is a mandatory acceptance criterion — the mission cannot complete again until work that specifically addresses it is published and accepted. Re-citing an artifact from the rejected round does not satisfy it.`,
        mandatory: true,
        status: "UNSATISFIED",
        evidence: [],
      });
    }

    // 0. An ESCALATED mission is halted by its OPEN cards, not by a verdict on
    //    the goal. Flipping the status without answering them re-escalates on
    //    the very next watchdog tick (`stalemate` re-derives from the same
    //    open cards), so reopening IS the operator's answer and is recorded as
    //    one — `escalation.responded`, not `auto_resolved`: a human decided.
    //    A card that stands on its own (budget exhausted) will legitimately
    //    re-fire; that is the operator's cue to raise the limit, not a bug.
    if (wasEscalated) {
      for (const esc of [...this.state.escalations.values()]) {
        if (esc.status !== "OPEN" || esc.goalId !== gid) continue;
        await this.deps.kernel
          .emit("escalation.responded", { escalationId: esc.id, response: `mission reopened by operator: ${reason}`, respondedBy: by }, { actorId: by, goalId: gid })
          .catch(() => undefined);
        const stuck = stuckRequestOf(esc);
        if (stuck) this.deps.scheduler.resetStallTracking?.(stuck.messageId, stuck.agentId);
      }
    }

    // 1. Withdraw the verdict. The projection also flips the targeted criteria
    //    back to UNSATISFIED, which is what stops the watchdog from emitting
    //    `goal.completed` again on its next tick.
    await this.deps.kernel.emit(
      "goal.reopened",
      { goalId: gid, reason, criteria: opts.criteria, addCriteria: minted },
      { actorId: by, goalId: gid },
    );

    // 2. Revive the agents that completed WITH the mission. COMPLETED -> IDLE
    //    is the only legal edge out of COMPLETED, and `agent.resumed` is the
    //    event that takes it, so no new lifecycle event type is needed.
    //    An agent is reported as revived only if it ACTUALLY left COMPLETED.
    //    The emit is still tolerant (one illegal transition must not abort the
    //    reopen), but a swallowed failure used to be reported as a success —
    //    the operator saw `revived: qa` and then watched every message to `qa`
    //    bounce off the `agent completed with the mission` gate.
    const revived: string[] = [];
    const notRevived: string[] = [];
    for (const rec of [...this.state.agents.values()]) {
      const a = rec.state;
      if (a.agentId === HUMAN_AGENT_ID || a.lifecycle !== "COMPLETED") continue;
      await this.deps.kernel.emit("agent.resumed", { agentId: a.agentId }, { actorId: by }).catch((err) => {
        this.auditLine(`reopen: reviving ${a.agentId} failed: ${(err as Error).message}`);
      });
      // Read the projection back, do not trust the emit: the reducer is what
      // decides the lifecycle, and it may legally have refused.
      if (this.state.agents.get(a.agentId)?.state.lifecycle === "COMPLETED") notRevived.push(a.agentId);
      else revived.push(a.agentId);
    }

    // 3. Undo the shutdown latch and restart the stall watch, otherwise the
    //    watchdog returns at its first line and nothing ever nudges a mesh
    //    that goes quiet again.
    this.stopping = false;
    this.setLiveMode(true);
    this.startStallWatch();

    // 4. Drop the per-mission counters BEFORE restarting. The round that just
    //    ended leaves strikes, backoff parking, nudge and denial counts and
    //    stall suppression behind; inherited, they make the new round refuse
    //    exactly the agents that struggled in the old one — a reopen that
    //    silently re-parks the agent the operator is trying to talk to.
    //    Must precede `start()`: the pump can pick work up as soon as the
    //    timer runs, and clearing the queue underneath a live pump would drop
    //    activations we are about to make.
    this.deps.scheduler.resetMissionState?.();

    // 5. Restart the scheduler. `start()` is idempotent, so a mission that was
    //    reopened while still live is unharmed.
    this.deps.scheduler.start();

    // 5b. Hand the feedback to whoever owns requirements, as an ASK.
    //     A criterion alone says WHAT is now required but names nobody; the
    //     mission still has no defined next step, which is exactly the stall
    //     this fixes. A REQUEST creates an outstanding commitment on a named
    //     agent, so the scheduler has a reason to run it and the ledger has a
    //     debt that will not quietly disappear.
    //
    //     Requirements owner first (product-manager), else the configured
    //     startup driver, else anyone alive — a reopen must never end with the
    //     operator's instruction addressed to nobody.
    const requirementsOwner =
      [...this.state.agents.values()].find((r) => r.definition.role === "product-manager")?.definition.id ??
      this.config.startupActivate.find((id) => this.state.agents.has(id)) ??
      [...this.state.agents.values()].find((r) => r.definition.id !== HUMAN_AGENT_ID)?.definition.id;
    let feedbackTo: string | undefined;
    if (requirementsOwner) {
      const sent = await this.sendMessage({
        from: HUMAN_AGENT_ID,
        to: [requirementsOwner],
        type: "REQUEST",
        newThread: { subject: `mission reopened: ${reason.slice(0, 80)}` },
        priority: "HIGH",
        payload: {
          question:
            `The operator rejected the delivered result and reopened the mission. Their words: "${reason}".\n\n` +
            `Do NOT re-cite the artifacts from the rejected round — they are recorded as rejected evidence and will be refused.\n` +
            `Turn this feedback into concrete, testable requirements: publish an updated RequirementsDoc whose criteria say what "${reason}" means in terms a developer can build and a reviewer can verify, then delegate the work. ` +
            `A new mandatory acceptance criterion '${mintedId}' now tracks this and blocks completion until it is satisfied by NEW work.`,
          criterionId: mintedId,
          reopenReason: reason,
        },
      });
      if (sent.accepted) feedbackTo = requirementsOwner;
      else this.auditLine(`reopen: could not hand feedback to ${requirementsOwner}: ${sent.reason}`);
    }

    // 6. Activate EXPLICITLY. `kind: "recovery"` alone maps to
    //    `explicit: false`, which the scheduler refuses for a backoff-parked
    //    agent — so a reopen could activate nobody and still return ok:true.
    //    A reopen is an operator action by definition, so it carries operator
    //    authority; `resetMissionState()` above already cleared the parking,
    //    and this keeps the guarantee if any of it is re-established between.
    // Default targets also include the feedback recipient: an ask nobody is
    // scheduled to read is the stall this fix exists to remove. An EXPLICIT
    // `activate` list is left alone — that is the operator naming who should
    // run, and quietly adding to it would override them; if it wakes nobody,
    // the warning below says so.
    const targets = opts.activate?.length
      ? opts.activate
      : [...new Set([...this.recoveryCandidates(), ...(feedbackTo ? [feedbackTo] : [])])];
    const activated: string[] = [];
    const refused: Array<{ agentId: string; reason: string }> = [];
    for (const id of targets) {
      const r = await this.activateAgent(id, { kind: "recovery", note: `mission reopened: ${reason}` }, { explicit: true });
      if (r.queued) activated.push(id);
      else refused.push({ agentId: id, reason: r.blocked ?? "refused" });
    }
    // A reopen that woke nobody is a failed reopen wearing a success mask: the
    // mission is ACTIVE, the operator's feedback is in a mailbox, and not one
    // turn will ever run to read it. Say so instead of returning a bare ok.
    const woke = activated.length > 0;
    const unsatisfied = goal.acceptanceCriteria.filter((c) => c.status === "UNSATISFIED").map((c) => c.id);
    return {
      ok: true,
      revived,
      ...(notRevived.length ? { notRevived } : {}),
      activated,
      ...(refused.length ? { refused } : {}),
      unsatisfied,
      ...(feedbackTo ? { feedbackTo } : {}),
      ...(minted.length ? { addedCriteria: minted.map((c) => c.id) } : {}),
      ...(woke ? {} : { warning: targets.length === 0 ? "reopened, but no agent had pending work to resume — send a message (or pass `activate`) to start the next round" : "reopened, but every activation was refused — no turn will run until an agent is woken by hand" }),
      ...(wasEscalated ? { escalationsCleared: true } : {}),
    };
  }

  async replay(goalId: GoalId, upToSeq?: number): Promise<ReplayState> {
    const events = await this.deps.store.read({ goalId });
    const limited = upToSeq !== undefined ? events.filter((e) => (e.seq ?? 0) <= upToSeq) : events;
    const fresh: Projections = JSON.parse(JSON.stringify(null)) as Projections; // placeholder replaced below
    void fresh;
    const { createInitialState } = await import("./state");
    const state = createInitialState();
    for (const e of limited) applyEvent(state, e, this.projectionConfig());
    const goal = state.goals.get(goalId);
    return {
      goalId,
      asOfSeq: limited.length ? limited[limited.length - 1].seq ?? 0 : 0,
      goal,
      agents: [...state.agents.values()].map((a) => a.state),
      artifacts: [...state.artifacts.values()],
      threads: [...state.threads.values()],
      tasks: [...state.tasks.values()],
      decisions: [...state.decisions.values()],
      approvals: [...state.approvals.values()].flat(),
      escalations: [...state.escalations.values()],
      budgets: [...state.budgets.values()].map((b) => ({
        key: b.key,
        limit: b.limit,
        limitKind: b.limitKind,
        reserved: b.reserved,
        consumed: b.consumed,
        exceeded: b.exceeded,
      })),
      leases: [...state.leases.values()],
      eventCount: limited.length,
    };
  }

  // ------------------------------------------------------------- turn execution

  async runTurn(agentId: string, reason: ActivationReason): Promise<void> {
    if (this.turnInFlight.has(agentId)) {
      if (process.env.MESH_TURN_DEBUG) console.error(`[dbg] runTurn ${agentId} early-return: turnInFlight`);
      return;
    }
    const rec = this.state.agents.get(agentId);
    if (!rec) {
      if (process.env.MESH_TURN_DEBUG) console.error(`[dbg] runTurn ${agentId} early-return: unknown`);
      return;
    }
    if (agentId === HUMAN_AGENT_ID) return;
    if (rec.state.lifecycle === "SUSPENDED" || rec.state.lifecycle === "COMPLETED") {
      if (process.env.MESH_TURN_DEBUG) console.error(`[dbg] runTurn ${agentId} early-return: lifecycle ${rec.state.lifecycle}`);
      return;
    }
    const goalId = this.state.activeGoalId;
    if (!goalId) {
      if (process.env.MESH_TURN_DEBUG) console.error(`[dbg] runTurn ${agentId} early-return: no goal`);
      return;
    }
    const goal = this.state.goals.get(goalId);
    // Post-completion follow-up (human feedback via direct mail, an operator
    // wake, or a recovery answer) may still run one turn on a COMPLETED goal
    // so the recipient can respond. Everything else stays gated.
    const followUpTurn = reason.kind === "message" || reason.kind === "manual" || reason.kind === "recovery";
    if (!goal || goal.status === "PAUSED" || goal.status === "ESCALATED" || goal.status === "FAILED" || (goal.status === "COMPLETED" && !followUpTurn)) {
      if (process.env.MESH_TURN_DEBUG) console.error(`[dbg] runTurn ${agentId} early-return: goal ${goal?.status}`);
      return;
    }

    this.turnInFlight.add(agentId);
    const turnId = `turn-${shortHash(agentId + Date.now() + Math.random())}`;
    const turnStartedAt = this.deps.kernel.clock.iso();
    this.activeTurnByAgent.set(agentId, turnId);
    // `timeoutRetries` is the scheduler's re-activation counter for this agent;
    // surfacing it as `attempt` is what makes "this is the 3rd try" visible in
    // the dashboard instead of looking like three unrelated slow turns.
    const attempt = (this.timeoutRetries.get(agentId) ?? 0) + 1;
    this.pushTurn({
      turnId,
      agentId,
      reason,
      startedAt: turnStartedAt,
      status: "running",
      attempt,
      phases: { startedAt: Date.parse(turnStartedAt) || Date.now() },
    });
    /**
     * Holds still outstanding when the turn ends. `consume` settles a hold on
     * the success path and clears these; anything left here was never settled
     * (the turn threw: model timeout, dead backend, kernel rejection) and is
     * released in `finally`. Without that, every failed turn permanently
     * subtracted TURN_RESERVE_TOKENS of headroom from the agent and thread
     * ledgers — a mesh with a flaky backend slowly starved itself into
     * DEFERRED activations with no error anywhere.
     */
    const openReservations: Array<{ key: string; reservationId: string }> = [];
    // Hoisted so the `finally` can arm the stall fast-retry: a turn that
    // changed nothing must not cost the mission the full idle + cooldown.
    // Deliberately broader than `unproductive` (the breaker flag): wait/done
    // are legitimate successful endings, so they must never feed the circuit
    // breaker — but in a quiet mission with unmet criteria they also produced
    // no work, so the next driver should be tried soon.
    let turnChangedNothing = false;
    try {
      // budget reservation
      const agentReserveAmount = this.sizedTurnReserve(agentId);
      const reserve = await this.deps.budget.reserve(
        agentKey(goalId, agentId),
        "tokens",
        agentReserveAmount,
        this.state.agents.get(agentId)?.definition.budget.tokens ?? null,
        { actorId: agentId },
      );
      if (reserve.blocked && (await this.tryAutoRaise(agentKey(goalId, agentId), this.state.agents.get(agentId)?.definition.budget.tokens ?? null, agentId))) {
        // Retry once against the raised ceiling. One retry only: if the raise
        // did not create headroom, the ceiling is the real answer and the
        // block below escalates as before.
        Object.assign(
          reserve,
          await this.deps.budget.reserve(agentKey(goalId, agentId), "tokens", agentReserveAmount, this.state.budgets.get(agentKey(goalId, agentId))?.limit ?? null, { actorId: agentId }),
        );
      }
      if (reserve.blocked) {
        await this.deps.kernel.emit("agent.state_changed", { agentId, to: "BLOCKED", note: `budget: ${reserve.reason}` }, { actorId: agentId });
        // Stable key: repeats dedupe against the still-open escalation instead
        // of flooding the log (each escalation also mints an artifact).
        await this.escalate({ reason: "budget_exhausted", raisedBy: agentId, conflictKey: `budget:${agentKey(goalId, agentId)}`, detail: { key: agentKey(goalId, agentId), reason: reserve.reason } });
        this.finishTurn(turnId, agentId, { status: "blocked", error: reserve.reason });
        this.deps.scheduler.noteTurnOutcome?.(agentId, "blocked");
        return;
      }
      if (reserve.reservationId) openReservations.push({ key: agentKey(goalId, agentId), reservationId: reserve.reservationId });
      /**
       * Reservation id for the THREAD ledger, carried to the consume below.
       *
       * It used to be discarded: the turn reserved TURN_RESERVE_TOKENS
       * against the thread and then consumed with `reservationId: undefined`,
       * so the reducer never gave the reservation back. Every turn in a
       * thread leaked 32k of `reserved` permanently, and `reserve()` refuses
       * on `consumed + reserved + amount > limit` — so a thread died after a
       * handful of turns no matter how few tokens were actually spent. The
       * symptom was invisible: activations got DEFERRED by policy, the agents
       * simply stopped being scheduled, and the mission looked idle with no
       * error and no card. (`termination.ts` still carries a special case
       * written to cope with exactly this.)
       */
      let threadReservationId: string | undefined;
      /**
       * Context trimming for this turn. `undefined` === full context, which is
       * the only value on the normal path, so an unpressured turn builds a
       * byte-identical bundle to before.
       */
      let contextLimits: ContextLimits | undefined;
      if (reason.threadId) {
        const tk = threadKey(goalId, reason.threadId);
        const threadReserveAmount = this.sizedTurnReserve(agentId, this.config.budgets.threadReserveTokens);
        let tReserve = await this.deps.budget.reserve(tk, "tokens", threadReserveAmount, this.config.budgets.threadTokens, { actorId: agentId });
        if (tReserve.blocked && (await this.tryAutoRaise(tk, this.config.budgets.threadTokens, agentId))) {
          tReserve = await this.deps.budget.reserve(tk, "tokens", threadReserveAmount, this.state.budgets.get(tk)?.limit ?? null, { actorId: agentId });
        }
        if (tReserve.blocked) {
          // Zero headroom. This is the ONLY thread-budget outcome that refuses
          // the turn: there is nothing left to spend, so no amount of trimming
          // makes the turn affordable.
          await this.escalate({ reason: "thread_budget_exhausted", raisedBy: agentId, conflictKey: `budget:${tk}`, detail: { threadId: reason.threadId } });
          this.finishTurn(turnId, agentId, { status: "blocked", error: `thread budget exhausted: ${reason.threadId}` });
          this.deps.scheduler.noteTurnOutcome?.(agentId, "blocked");
          return; // `finally` releases the agent hold taken above.
        }
        threadReservationId = tReserve.reservationId;
        if (threadReservationId) openReservations.push({ key: tk, reservationId: threadReservationId });

        /**
         * Between "plenty of budget" and "none" there used to be nothing, and
         * the gap is where the damage happened: a thread with 5k left admitted
         * a turn that spent 123k, because a partially-granted hold does not
         * constrain what the runtime goes on to do. Rather than block a turn
         * that still has real headroom, make the turn SMALLER — less mail,
         * fewer decisions, fewer artifact refs — so its cost lands nearer the
         * headroom that is actually left.
         */
        const tLedger = this.state.budgets.get(tk);
        const shortfall = tReserve.granted < tReserve.requested;
        const usedRatio =
          tLedger && tLedger.limit !== null && tLedger.limit > 0 ? tLedger.consumed / tLedger.limit : 0;
        const overSoftCap = usedRatio >= this.config.budgets.threadSoftCap;
        if (shortfall || overSoftCap) {
          // Two levels, not a smooth curve: a shortfall means the hold could
          // not even be taken in full and is the harsher signal; merely
          // crossing the soft cap is an early warning and only halves things.
          contextLimits = shortfall
            ? { maxUnread: 3, maxDecisions: 3, maxArtifactRefs: 5, maxActivity: 4, maxOutstanding: 3 }
            : { maxUnread: 6, maxDecisions: 5, maxArtifactRefs: 10, maxActivity: 7, maxOutstanding: 5 };
          this.auditLine(
            `thread ${tk} under budget pressure (consumed ${tLedger?.consumed ?? 0}/${tLedger?.limit ?? "∞"}, held ${tReserve.granted}/${tReserve.requested}) — degrading ${agentId}'s context instead of blocking`,
          );
        }
      }

      if (rec.state.lifecycle === "STARTING") {
        await this.deps.kernel.emit("agent.started", { agentId, sessionId: null, runtime: rec.definition.runtime }, { actorId: agentId });
      }
      const activationEvt = await this.deps.kernel.emit(
        "agent.awakened",
        { agentId, reason, turnId },
        { actorId: agentId, correlationId: turnId },
      );
      await this.deps.kernel.emit(
        "agent.state_changed",
        { agentId, to: "OBSERVING", turnId },
        { actorId: agentId, causationId: activationEvt.id, correlationId: turnId },
      );

      const session = await this.ensureSession(agentId);
      // build context from undelivered mail first, then drain via delivery events
      const taskHint = rec.state.activeTaskId ? this.state.tasks.get(rec.state.activeTaskId) : undefined;
      const bundle = buildAgentContext({ config: this.config, kernel: this.deps.kernel }, agentId, taskHint, contextLimits);
      // Delivery is bookkeeping: the agent only ever reads the first
      // MAX_UNREAD (12) in context. Cap per-turn fan-out so a deep backlog
      // (hundreds/thousands queued) can't turn one turn into thousands of
      // emits — each emit wakes the watchdog, scheduler matching, the sqlite
      // index and SSE broadcast. The remainder stays queued and drains over
      // following turns (notifyTurnFinished re-queues while unread > 0).
      const unread = [...(this.state.unread.get(agentId) ?? [])].slice(0, MAX_DELIVERED_PER_TURN);
      for (const mid of unread) {
        await this.deps.kernel.emit(
          "message.delivered",
          { agentId, messageId: mid, turnId },
          { actorId: agentId, causationId: activationEvt.id, correlationId: turnId },
        );
      }
      const instructions = renderContextInstructions(bundle) + `\n\n## Why you were woken\n${describeReason(reason)}\n\nEmit your reply as mesh operations.`;
      // Make "what it's working on" visible while still THINKING: the runtime
      // call below blocks until the full output arrives, so without this the
      // Steps drawer would show a running turn with no content until it ends.
      this.pushTurn({
        turnId,
        agentId,
        reason,
        startedAt: turnStartedAt,
        status: "running",
        instructions: instructions.slice(0, MAX_TURN_INSTRUCTIONS_CHARS),
      });
      this.markTurn(turnId, "contextAt");

      await this.deps.kernel.emit(
        "agent.state_changed",
        { agentId, to: "THINKING", turnId },
        { actorId: agentId, causationId: activationEvt.id, correlationId: turnId },
      );
      const input: AgentInput = {
        agentId,
        goalId,
        activation: reason,
        context: bundle,
        instructions,
        onToken: (delta: string) => {
          // Live tokens are observability only: buffer them for polling
          // clients and forward out-of-band to SSE. Never throws, never
          // touches the event log (no budget/seq impact at token frequency).
          try {
            this.turns.appendText(turnId, delta);
          } catch {
            /* buffer must never break the turn */
          }
          try {
            this.deps.hooks?.onTurnToken?.(turnId, agentId, delta);
          } catch {
            /* observer must never break the turn */
          }
        },
      };

      const turn: TurnState = { turnId, agentId, reason, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] };
      this.deps.hooks?.onAgentTurnStart?.(agentId, turnId);
      this.markTurn(turnId, "llmCallAt");
      const output = await this.callRuntimeWithTimeout(agentId, session, input, turnId);
      this.markTurn(turnId, "llmDoneAt");
      // The backend answered, so this was not a transport failure: a dead
      // backend from last week must not count toward the next stall.
      this.unreachableStreak.delete(agentId);
      // Same reasoning for slow turns: one completed turn clears the streak, so
      // an agent that is merely occasionally slow never accumulates its way to
      // a terminal failure.
      this.timeoutRetries.delete(agentId);
      this.auditTurn(turnId, agentId, input, output);
      if (output.error) throw new RuntimeFailure(output.error);
      // Record BEFORE the op loop: the ops below are where an agent accepts a
      // criterion, and `markCriterionEvidence` has to know whether this turn
      // actually checked anything or is just asserting it did.
      this.turnVerificationTools.set(agentId, verificationToolCount(output.toolCalls));

      // Typed-only transport: prose-parsed ops never execute. The agent gets
      // one visible refusal (in its turn summary AND its L2 memory) instead
      // of a silent zero-op turn, so it can correct on the next wake rather
      // than burning strikes on something it cannot see. Typed tools execute
      // through the same `executeOp` path, so MCP turns are untouched.
      let typedOnlyRefusal: string | undefined;
      if (this.config.bus.transport === "typed-only" && !output.typedOps && output.operations.length > 0) {
        typedOnlyRefusal =
          `⚠ transport is typed-only: ${output.operations.length} parsed op(s) were refused — issue ops through mesh_* tools, not prose.`;
        this.auditLine(`turn ${turnId} for ${agentId} refused: ${output.operations.length} parsed ops under typed-only transport`);
      }
      for (const op of typedOnlyRefusal ? [] : output.operations) {
        // The mission can flip mid-turn (pause / escalation / completion
        // while the runtime was thinking). Stop before the next op instead of
        // executing the rest into one rejection after another — which burns
        // budget and leaves half-applied turns (e.g. artifact published but
        // its announcement rejected). Model tokens already spent are still
        // accounted below; the reservation is released there as usual.
        const midTurnHalt = haltedGoalStatus(this.state);
        const followUpTurn = reason.kind === "message" || reason.kind === "manual" || reason.kind === "recovery";
        if (midTurnHalt && !(midTurnHalt === "COMPLETED" && followUpTurn)) {
          this.auditLine(`turn ${turnId} for ${agentId} stopped early: ${haltReasonText(midTurnHalt)}`);
          break;
        }
        this.markTurn(turnId, "opsStartAt");
        const opStart = Date.now();
        const result = await this.executeOp(agentId, op, turn);
        try {
          this.turns.noteOp(turnId, { op: String(op.op), ms: Date.now() - opStart, ok: result.ok, reason: result.reason });
        } catch {
          /* timing is observability: never let it affect the op */
        }
        if (process.env.MESH_OP_DEBUG) console.error(`[op] ${agentId} ${op.op} -> ${result.ok}${result.reason ? " " + result.reason : ""}${result.messageId ? " msg:" + result.messageId : ""}${result.artifactId ? " art:" + result.artifactId : ""}`);
        turn.results.push(result);
      }
      this.markTurn(turnId, "opsDoneAt");

      const tokens = output.tokensUsed?.total ?? 0;
      // Feed the real cost back into the sizing heuristic BEFORE the next turn
      // asks for a hold; this is the only place a turn's true cost is known.
      this.noteTurnCost(agentId, tokens);
      await this.deps.budget.consume(agentKey(goalId, agentId), "tokens", tokens, reserve.reservationId, {
        model: output.model,
        modelVersion: output.modelVersion,
        temperature: output.temperature,
        input: output.tokensUsed?.input,
        output: output.tokensUsed?.output,
        // Recorded but NOT billed: the replayed transcript on a persistent
        // session. Kept on the event so cost reports can still show it.
        cacheRead: output.tokensUsed?.cacheRead,
        toolCalls: output.toolCalls?.length ?? 0,
        turnId,
      }, { actorId: agentId, correlationId: turnId });
      await this.deps.budget.consume(missionKey(goalId), "tokens", tokens, undefined, { agentId, turnId }, { actorId: agentId, correlationId: turnId });
      if (reason.threadId) {
        // Pass the reservation id so the reducer releases the hold it created
        // at the top of the turn; without it the reserve leaks forever.
        await this.deps.budget.consume(threadKey(goalId, reason.threadId), "tokens", tokens, threadReservationId, { agentId, turnId }, { actorId: agentId, correlationId: turnId });
      }
      // Both holds are now settled by `consume`; nothing left for `finally`.
      openReservations.length = 0;

      // derive end state: escalate -> BLOCKED, outstanding request or wait -> WAITING, otherwise IDLE
      // Scoped to the ACTIVE goal: asks left over from a previous mission
      // (this mesh was restarted onto new goals several times) must not pin
      // an agent in WAITING forever — the agent that emitted `done` with no
      // active-goal debt is IDLE, full stop. The stale asks stay in the
      // ledger for the record; they just no longer own the lifecycle.
      const activeGoalForPending = goalId;
      const stillPending = [...this.state.pendingRequests.values()].some(
        (pr) => pr.from === agentId && (!pr.goalId || pr.goalId === activeGoalForPending),
      );
      // Final-answer contract: an agent that OWES an answer (inbound ask,
      // e.g. a REQUEST_REVIEW to it) and produced none this turn must end
      // WAITING, not IDLE. `stillOwes` reads the post-turn ledger, so any
      // answering path (decision op, replyTo reply, thread/artifact
      // discharge) flips it false and the agent falls back to IDLE — but a
      // silent-read reviewer stays pinned, and the scheduler nudge/escalation
      // chain keeps pointing at the debtor instead of the ask dying quietly.
      // Live evidence: tech-lead read Architecture v1 and ended IDLE with
      // zero decision ops while the review ask was still open — `architecture-
      // approved` never fired and developer/qa stayed cold.
      const stillOwedInbound =
        agentId !== HUMAN_AGENT_ID &&
        [...this.state.pendingRequests.values()].some(
          (pr) => (!pr.goalId || pr.goalId === activeGoalForPending) && stillOwes(pr, agentId),
        );
      let target: LifecycleState = "IDLE";
      if (turn.escalated) target = "BLOCKED";
      else if (turn.waitRequested || stillPending || stillOwedInbound) target = "WAITING";
      await this.deps.kernel.emit(
        "agent.state_changed",
        { agentId, from: "THINKING", to: target, turnId },
        { actorId: agentId, correlationId: turnId },
      );
      // A turn that changed nothing must say so out loud: previously zero-op
      // and all-rejected turns finished "ok" with no signal, so the mission
      // stalled silently while every agent looked done. The warning rides the
      // summary into the dashboard AND the agent's own memory, so the next
      // turn sees what failed instead of confabulating success.
      const rejected = turn.results.filter((r) => !r.ok);
      const modelSummary = output.summary?.slice(0, 500);
      let endSummary = modelSummary;
      /**
       * Did this turn move the mesh at all? A turn that parsed no ops, or
       * whose every op was rejected, spent real tokens and changed nothing.
       * Repeating it changes nothing again — that is the pure waste loop.
       */
      let unproductive = false;
      if (typedOnlyRefusal) {
        endSummary = typedOnlyRefusal + (modelSummary ? ` (model said: ${modelSummary})` : "");
        unproductive = true;
      } else if (output.operations.length === 0) {
        endSummary = `⚠ no mesh ops parsed from output — nothing was sent, published, or requested${modelSummary ? ` (model said: ${modelSummary})` : ""}`;
        this.auditLine(`turn ${turnId} for ${agentId} parsed 0 ops`);
        unproductive = true;
      } else if (rejected.length === turn.results.length && turn.results.length > 0) {
        unproductive = true;
        const why = rejected
          .map((r) => `${r.op}: ${r.reason ?? "rejected"}`)
          .join("; ")
          .slice(0, 300);
        endSummary = `⚠ all ${rejected.length} ops rejected (${why})${modelSummary ? ` — model said: ${modelSummary}` : ""}`;
        this.auditLine(`turn ${turnId} for ${agentId}: all ${rejected.length} ops rejected: ${why}`);
      } else if (
        // wait/done/remember are not work. A driver woken with nothing to act
        // on answers with one of these, the mesh ends empty, and the stall
        // watchdog then waits the full idle + cooldown for nothing. This arms
        // the fast retry (NOT the breaker) so the NEXT driver gets tried soon.
        turn.results.length > 0 &&
        turn.results.every((r) => r.op === "wait" || r.op === "done" || r.op === "remember") &&
        this.state.goals.get(goalId)?.status === "ACTIVE"
      ) {
        turnChangedNothing = true;
        endSummary = `⚠ turn only ${[...new Set(turn.results.map((r) => r.op))].join("/")} — no work was produced while the mission has unmet criteria; the watchdog will rotate to another driver`;
        this.auditLine(`turn ${turnId} for ${agentId} produced no work (${turn.results.map((r) => r.op).join(",")})`);
      } else if (rejected.length > 0) {
        // PARTIAL failure. Previously only an ALL-rejected turn told the agent
        // anything, so a turn that published an artifact AND had its
        // announcement rejected reported plain success. The agent then re-sent
        // the same invalid message next turn, forever: one live run repeated an
        // invalid message type 18 times because nothing ever contradicted it.
        // The warning has to ride the summary into memory even when part of
        // the turn worked, or the mesh cannot learn from a rejection.
        const why = rejected
          .map((r) => `${r.op}: ${r.reason ?? "rejected"}`)
          .join("; ")
          .slice(0, 300);
        endSummary = `⚠ ${rejected.length} of ${turn.results.length} ops were REJECTED and had no effect — fix these before repeating them (${why})${modelSummary ? ` — model said: ${modelSummary}` : ""}`;
        this.auditLine(`turn ${turnId} for ${agentId}: ${rejected.length}/${turn.results.length} ops rejected: ${why}`);
      }
      // An op can SUCCEED and still not do what the agent thinks it did — the
      // verification gate is the case that matters: `approve criterion:x`
      // returns ok, but the criterion landed ASSERTED and the mission is no
      // closer to done. Without this warning the agent reads a clean turn,
      // concludes the criterion is closed, and never revisits it. Appended
      // rather than branched, so it survives alongside a rejection warning.
      const caveats = turn.results
        .filter((r) => r.ok && r.reason)
        .map((r) => `${r.op}: ${r.reason}`)
        .join("; ")
        .slice(0, 400);
      if (caveats) {
        endSummary = `${endSummary ? `${endSummary} — ` : ""}⚠ ${caveats}`;
        this.auditLine(`turn ${turnId} for ${agentId}: accepted with caveats: ${caveats}`);
      }
      turnChangedNothing = turnChangedNothing || unproductive;
      this.finishTurn(turnId, agentId, {
        status: target === "IDLE" ? "ok" : target === "WAITING" ? "waiting" : "blocked",
        tokens,
        tokensInput: output.tokensUsed?.input,
        tokensOutput: output.tokensUsed?.output,
        model: output.model,
        // Executed ops only (not merely planned): if the mission flipped
        // mid-turn and the loop stopped early, the trace must not claim the
        // skipped ops ran.
        ops: turn.results.map((r) => r.op),
        toolCalls: output.toolCalls?.length ?? 0,
        toolCallsDetail: (output.toolCalls ?? []).slice(0, MAX_TURN_TOOLCALLS),
        summary: endSummary,
        text: (output.text ?? "").slice(0, MAX_TURN_TEXT_CHARS),
      });
      if (endSummary) {
        await this.rememberMemory(agentId, `turn:${turnId}`, endSummary);
      }
      // Fully successful turn: past failures no longer predict the next one.
      this.restartAttempts.delete(agentId);
      // An unproductive turn must reach the circuit breaker. Reporting "ok"
      // for a turn that parsed zero ops (or had all of them rejected) meant
      // STRIKE_LIMIT could never be reached by the single most common failure
      // mode: a model that answers in prose instead of the ops contract, or
      // one that keeps retrying an op the policy will always deny. Each such
      // turn costs full tokens and changes nothing, and the agent was
      // immediately re-activated to do it again. Three in a row now park it
      // for the cooldown instead of burning the mission budget in a loop.
      this.deps.scheduler.noteTurnOutcome?.(agentId, unproductive ? "blocked" : "ok");
      this.deps.hooks?.onAgentTurnEnd?.(agentId, turnId, !unproductive);
    } catch (err) {
      this.deps.hooks?.onAgentTurnEnd?.(agentId, turnId, false);
      // Which leg was open when it died. The phase marks already record how
      // far the turn got, so the crash can be attributed without guessing.
      const ph = this.turns.get(turnId)?.phases;
      const failedIn: "prep" | "llmCallAt" | "opsStartAt" | "opsDoneAt" =
        ph?.opsDoneAt ? "opsDoneAt" : ph?.opsStartAt ? "opsStartAt" : ph?.llmCallAt ? "llmCallAt" : "prep";
      if (err instanceof KernelRejectedError) {
        this.auditLine(`kernel rejection during turn ${turnId} for ${agentId}: ${err.message}`);
        await this.deps.kernel
          .emit("agent.state_changed", { agentId, to: "IDLE", note: `kernel rejected: ${err.message}`, turnId }, { actorId: agentId, correlationId: turnId })
          .catch(() => undefined);
        this.finishTurn(turnId, agentId, { status: "ok", error: (err as Error).message, errorDetail: describeError(err, failedIn) });
        this.deps.scheduler.noteTurnOutcome?.(agentId, "ok");
      } else {
        this.finishTurn(turnId, agentId, {
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
          errorDetail: describeError(err, failedIn),
        });
        await this.handleAgentFailure(agentId, err, reason);
      }
    } finally {
      // Give back any hold the turn never settled (it threw before consume).
      for (const { key, reservationId } of openReservations) {
        await this.deps.budget.release(key, reservationId, { actorId: agentId, goalId }).catch(() => undefined);
      }
      this.turnInFlight.delete(agentId);
      this.activeTurnByAgent.delete(agentId);
      this.turnVerificationTools.delete(agentId);
      this.lastTurnAt = Date.now();
      this.deps.scheduler.notifyTurnFinished(agentId);
      void this.afterActivity();
      // A turn that changed nothing must not restart the stall clock for the
      // full idle + cooldown: the mission is quiet, nothing is queued, and the
      // next driver should be tried in seconds, not minutes. The breaker still
      // parks a chronic no-op agent after 3 strikes, and `checkStall` still
      // skips when anything is pending/running — so this cannot hot-loop.
      if (turnChangedNothing && this.liveMode) {
        this.stallNoopRetryAt = Date.now() + this.config.scheduling.stallNoopRetryMs;
        if (this.stallNoopTimer) clearTimeout(this.stallNoopTimer);
        const t = setTimeout(() => {
          this.stallNoopTimer = undefined;
          void this.checkStall().catch((err) => this.auditLine(`stall watch error: ${(err as Error).message}`));
        }, this.config.scheduling.stallNoopRetryMs);
        (t as unknown as { unref?: () => void }).unref?.();
        this.stallNoopTimer = t;
      }
    }
  }

  private async callRuntimeWithTimeout(agentId: string, session: { session: import("../../protocol/src/index").AgentSession; runtime: AgentRuntime }, input: AgentInput, turnId: string): Promise<AgentOutput> {
    const timeoutMs = this.config.scheduling.turnTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        session.runtime.interrupt(session.session).catch(() => undefined);
        reject(new RuntimeFailure(`turn timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([session.runtime.send(session.session, input), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private auditTurn(turnId: string, agentId: string, input: AgentInput, output: AgentOutput): void {
    this.auditLine(
      JSON.stringify({
        turnId,
        agentId,
        at: new Date().toISOString(),
        activation: input.activation,
        model: output.model,
        modelVersion: output.modelVersion,
        temperature: output.temperature,
        inputDigest: shortHash(JSON.stringify(input.context.unreadMail.map((m) => m.id))),
        outputDigest: shortHash(output.text),
        ops: output.operations.map((o) => o.op),
        toolCalls: output.toolCalls ?? [],
        tokens: output.tokensUsed,
      }),
    );
    // Realtime mirror: keep the in-memory turn trace fresh even before the turn ends.
    this.pushTurn({
      turnId,
      agentId,
      reason: input.activation,
      startedAt: this.getTurn(turnId)?.startedAt ?? new Date().toISOString(),
      status: "running",
      model: output.model,
      ops: output.operations.map((o) => o.op),
      toolCalls: output.toolCalls?.length ?? 0,
      toolCallsDetail: (output.toolCalls ?? []).slice(0, MAX_TURN_TOOLCALLS),
      tokens: output.tokensUsed?.total ?? 0,
      tokensInput: output.tokensUsed?.input,
      tokensOutput: output.tokensUsed?.output,
      summary: output.summary?.slice(0, 500),
      text: (output.text ?? "").slice(0, MAX_TURN_TEXT_CHARS),
      instructions: input.instructions?.slice(0, MAX_TURN_INSTRUCTIONS_CHARS),
    });
  }

  private async handleAgentFailure(agentId: string, error: unknown, reason: ActivationReason): Promise<void> {
    // Classify first: a dead backend needs a respawn + a labeled record, not
    // the generic crash path. Adapters throw BackendUnreachableError; the
    // pattern fallback covers runtimes that surface raw transport errors.
    const backend = error instanceof BackendUnreachableError ? error.backend : undefined;
    // A slow backend is not a dead one. These are two different faults with two
    // different budgets: a crashed process must stop after 3 respawns, but a
    // model that thinks for a long time should be allowed to keep thinking.
    // Conflating them is what suspended healthy agents — a 300s fetch cap fired
    // mid-thought, looked like a transport error, and burned the restart budget
    // three times over.
    const slow = isTimeoutError(error);
    const unreachable = !slow && isConnectionError(error);
    const short = error instanceof Error ? error.message : String(error ?? "unknown failure");
    const labeled = backend ?? (unreachable ? `backend unreachable for ${agentId}: ${short}` : short);
    await this.deps.kernel
      .emit("agent.failed", { agentId, error: labeled, sessionId: null, restartable: this.config.agents[agentId]?.sessionPolicy.persistent ?? false }, { actorId: agentId })
      .catch(() => undefined);
    this.sessions.delete(agentId);
    const persistent = this.config.agents[agentId]?.sessionPolicy.persistent ?? false;
    if (slow) {
      // Keep the crash counter untouched, and reset any unreachable streak: the
      // backend demonstrably accepted our connection.
      this.unreachableStreak.delete(agentId);
      const slowAttempts = (this.timeoutRetries.get(agentId) ?? 0) + 1;
      this.timeoutRetries.set(agentId, slowAttempts);
      if (persistent && slowAttempts <= MAX_TIMEOUT_RETRIES) {
        await this.deps.kernel.emit("agent.restarted", { agentId, attempt: slowAttempts }, { actorId: HUMAN_AGENT_ID });
        if (this.state.agents.get(agentId)) {
          await this.deps.kernel.emit("agent.state_changed", { agentId, to: "IDLE" }, { actorId: HUMAN_AGENT_ID });
        }
        // Back off so a genuinely wedged backend is not hammered, but do not
        // give up: the work is still valid, the model was simply not done.
        const delay = Math.min(30000, 1000 * 2 ** (slowAttempts - 1));
        setTimeout(() => {
          void this.activateAgent(agentId, { kind: "recovery", note: `retry after slow turn: ${short}`, eventId: reason.eventId }).catch(() => undefined);
        }, delay);
        return;
      }
    }
    const attempts = (this.restartAttempts.get(agentId) ?? 0) + 1;
    this.restartAttempts.set(agentId, attempts);
    if (unreachable) {
      this.unreachableStreak.set(agentId, (this.unreachableStreak.get(agentId) ?? 0) + 1);
    }
    const willRestart = attempts <= 3 && persistent;
    if (willRestart) {
      await this.deps.kernel.emit("agent.restarted", { agentId, attempt: attempts }, { actorId: HUMAN_AGENT_ID });
      const rec = this.state.agents.get(agentId);
      if (rec) {
        // FAILED -> STARTING handled by reducer via agent.restarted; then idle
        await this.deps.kernel.emit("agent.state_changed", { agentId, to: "IDLE" }, { actorId: HUMAN_AGENT_ID });
      }
      // A restart is scheduled — this failure is recoverable, so it must NOT
      // escalate: the old code escalated `runtime_failure` on the FIRST
      // failure even with a restart 20ms away, and the resulting open card
      // fed the stalemate verdict, flipped the goal ESCALATED, and froze
      // every agent (including the restart itself). One flaky turn killed
      // the whole mission behind an operator card nobody needed to answer.
      setTimeout(() => {
        void this.activateAgent(agentId, { kind: "recovery", note: `restart after failure: ${labeled}`, eventId: reason.eventId }).catch(() => undefined);
      }, 20);
    } else {
      const activeTask = this.state.agents.get(agentId)?.state.activeTaskId;
      if (activeTask) {
        await this.deps.kernel.emit("task.claimed", { taskId: activeTask, agentId: null }, { actorId: HUMAN_AGENT_ID });
      }
      // Terminal failure: this agent will never answer what it owes. Every
      // ask addressed to it is now a question to a corpse — leave them open
      // and each asker waits, nudges 3x, and escalates a stalemate that
      // freezes the goal. Close them HERE with notice, so askers re-plan
      // immediately (re-ask someone else, discharge their own wait) instead
      // of stalling the whole mission behind a dead debtor.
      for (const [pid, pr] of [...this.state.pendingRequests]) {
        if (!stillOwes(pr, agentId)) continue;
        const askerStillThere = pr.from !== HUMAN_AGENT_ID && this.state.agents.has(pr.from);
        await this.dischargeCommitment(pid, "operator", "recovery-manager", {
          action: "debtor_failed",
          debtor: agentId,
          error: short,
        });
        if (askerStillThere) {
          await this.sendMessage({
            from: HUMAN_AGENT_ID,
            to: [pr.from],
            type: "INFORM",
            threadId: this.state.threads.has(pr.threadId) ? pr.threadId : undefined,
            newThread: this.state.threads.has(pr.threadId) ? undefined : { subject: `request ${pid} cannot be answered` },
            payload: {
              declined: true,
              request: pid,
              reason: `${agentId} failed terminally (${short}) and will not answer — re-plan: ask someone else, do the work yourself, or discharge your own wait`,
            },
            priority: "HIGH",
          }).catch(() => undefined);
        }
      }
      // Park the corpse: FAILED -> SUSPENDED is a legal transition and means
      // "never schedule me again". Without this the agent sits in FAILED with
      // the termination manager's runtime_failure verdict one watchdog tick
      // away — even though every ask it owed was just discharged with notice
      // and the mission can proceed without it. lastError is retained for
      // the audit trail; the escalation card below records the full detail.
      await this.deps.kernel
        .emit("agent.state_changed", { agentId, to: "SUSPENDED", note: `terminal failure: ${short}` }, { actorId: HUMAN_AGENT_ID })
        .catch(() => undefined);
      // Terminal failure (no restart scheduled): count toward the scheduler
      // circuit breaker. Restart-scheduled failures are excluded — that loop
      // is attempt-counted (max 3) and timer-paced, so it cannot wedge.
      this.deps.scheduler.noteTurnOutcome?.(agentId, "failed");
      if (unreachable) {
        const streak = this.unreachableStreak.get(agentId) ?? attempts;
        await this.escalate({
          reason: "backend_unreachable",
          raisedBy: "recovery-manager",
          conflictKey: `backend:${agentId}`,
          // Advisory: the debtor's asks were already discharged with notice
          // above, so the mission can proceed without this agent. The card
          // informs the operator; it must not freeze the goal behind a
          // problem nobody needs to answer urgently.
          advisory: true,
          detail: {
            agentId,
            backend: backend ?? "unknown — check the agent's runtime (opencode server port, http baseUrl)",
            error: short,
            consecutiveFailures: streak,
            attempts,
            hint: "verify the backend process is alive (ps), check for OOM (dmesg), or restart it; then wake the agent for a fresh turn",
          },
        });
      } else {
        await this.escalate({ reason: "runtime_failure", raisedBy: "recovery-manager", conflictKey: `runtime:${agentId}`, advisory: true, detail: { agentId, error: short, attempts } });
      }
    }
  }

  private async ensureSession(agentId: string): Promise<{ session: import("../../protocol/src/index").AgentSession; runtime: AgentRuntime }> {
    const existing = this.sessions.get(agentId);
    const rec = this.state.agents.get(agentId)!;
    const runtime = this.deps.runtimes.resolve(rec.definition.runtime);
    if (existing) {
      const status = await runtime.getStatus(existing.session).catch(() => "UNREACHABLE" as AgentRuntimeStatus);
      if (status !== "UNREACHABLE" && status !== "STOPPED") return existing;
      this.sessions.delete(agentId);
    }
    const context = await this.buildRuntimeContext(agentId);
    let session: import("../../protocol/src/index").AgentSession | null = null;
    if (rec.definition.sessionPolicy.persistent && runtime.restoreSession) {
      const previous = this.state.sessionMap.get(agentId) ?? (await this.deps.sessionRegistry?.lookup(agentId).catch(() => null));
      if (previous) {
        session = await runtime.restoreSession(rec.definition, previous.sessionId, context).catch(() => null);
      }
    }
    if (!session) {
      session = await runtime.start(rec.definition, context);
      if (rec.state.lifecycle === "STARTING") {
        await this.deps.kernel.emit("agent.started", { agentId, sessionId: session.sessionId, runtime: runtime.name }, { actorId: agentId });
      }
    } else {
      await this.deps.kernel.emit("agent.restarted", { agentId, sessionId: session.sessionId, restored: true }, { actorId: agentId });
    }
    const entry = { session, runtime };
    this.sessions.set(agentId, entry);
    if (this.deps.sessionRegistry) {
      await this.deps.sessionRegistry.record(agentId, session.sessionId, runtime.name).catch(() => undefined);
    }
    return entry;
  }

  private async buildRuntimeContext(agentId: string): Promise<RuntimeContext> {
    const rec = this.state.agents.get(agentId)!;
    return {
      goalId: this.state.activeGoalId ?? "",
      meshId: this.config.meshId,
      workspacePath: await this.agentWorkspace(agentId),
      busUrl: process.env.MESH_BUS_URL ?? `http://${this.config.server.host}:${this.config.server.port}`,
      agentToken: `${this.config.meshId}:${agentId}:${shortHash(this.state.activeGoalId ?? "x")}`,
      rolePromptText: rec.definition.prompt.text ?? "",
      capabilityGrants: rec.definition.capabilities,
      env: { MESH_AGENT_ID: agentId, MESH_GOAL_ID: this.state.activeGoalId ?? "" },
    };
  }

  async agentWorkspace(agentId: string): Promise<string> {
    if (this.deps.workspace && (this.config.agents[agentId]?.capabilities.includes("repository.write") ?? false)) {
      return this.deps.workspace.ensureWorktree(agentId);
    }
    return this.config.workspacePath;
  }

  // ----------------------------------------------------------------- ops

  async executeOp(actorId: string, op: MeshOp, turn: TurnState): Promise<OpResult> {
    const goalId = this.state.activeGoalId;
    if (!goalId) return { ok: false, op: op.op, reason: "no active goal" };
    // Freeze mutating agent ops while the mission is halted. Without this,
    // the `goal-state` message gate only half-freezes: sends are rejected
    // while publishes/transitions/task completions still land — plus the MCP
    // bus reaches here directly, bypassing `runTurn`'s entry guard entirely.
    // Turn-enders, reads, and raising the alarm stay allowed; the human seat
    // bypasses everything.
    if (actorId !== HUMAN_AGENT_ID) {
      const halted = haltedGoalStatus(this.state);
      if (halted) {
        // A follow-up turn on a COMPLETED goal replies via `send`; every
        // other op and every halted state stays read-only.
        const followUpTurn = turn.reason.kind === "message" || turn.reason.kind === "manual" || turn.reason.kind === "recovery";
        if (!(halted === "COMPLETED" && followUpTurn && op.op === "send")) {
          const terminal = halted === "COMPLETED" || halted === "FAILED";
          const allowed = terminal ? MISSION_OVER_ALLOW_OPS : MISSION_HALTED_ALLOW_OPS;
          if (!allowed.has(op.op)) return { ok: false, op: op.op, reason: haltReasonText(halted) };
        }
      }
    }
    try {
      switch (op.op) {
        case "send": {
          if (!this.state.agents.get(actorId)) return { ok: false, op: op.op, reason: "unknown sender" };
          const res = await this.sendMessage({
            from: actorId,
            to: op.to,
            type: op.type,
            threadId: op.threadId,
            newThread: op.newThread,
            replyTo: op.replyTo,
            artifactRefs: op.artifactRefs,
            payload: op.payload,
            priority: op.priority,
            taskId: op.taskId,
            requires: op.requires,
            budgetHint: op.budgetHint,
          });
          turn.sentOps++;
          return res.accepted ? { ok: true, op: op.op, messageId: res.messageId, eventId: res.eventId } : { ok: false, op: op.op, reason: res.reason };
        }
        case "broadcast": {
          const targets = [...this.state.agents.keys()].filter((id) => id !== actorId && id !== HUMAN_AGENT_ID);
          const res = await this.sendMessage({ from: actorId, to: targets, type: op.type, newThread: { subject: `broadcast ${op.type}` }, payload: op.payload, artifactRefs: op.artifactRefs });
          turn.sentOps++;
          return res.accepted ? { ok: true, op: op.op, messageId: res.messageId } : { ok: false, op: op.op, reason: res.reason };
        }
        case "request_research": {
          const cache = this.researchCache(op.question);
          if (cache) {
            const res = await this.sendMessage({
              from: op.to,
              to: [actorId],
              type: "INFORM",
              newThread: { subject: `research answer (cached): ${op.question.slice(0, 60)}` },
              artifactRefs: [cache],
              payload: { summary: "Answer found in explorer cache (no model invoked).", contentRef: cache.uri },
            });
            turn.sentOps++;
            return { ok: res.accepted, op: op.op, messageId: res.messageId, reason: res.reason };
          }
          const res = await this.sendMessage({
            from: actorId,
            to: [op.to],
            type: "REQUEST_RESEARCH",
            newThread: { subject: `research: ${op.question.slice(0, 80)}`, artifactRefs: op.artifactRefs },
            artifactRefs: op.artifactRefs,
            payload: { question: op.question },
          });
          turn.sentOps++;
          return res.accepted ? { ok: true, op: op.op, messageId: res.messageId } : { ok: false, op: op.op, reason: res.reason };
        }
        case "respond": {
          const original = this.state.messages.get(op.messageId);
          if (!original) return { ok: false, op: op.op, reason: "unknown messageId for respond" };
          const res = await this.sendMessage({
            from: actorId,
            to: [original.from],
            type: op.type,
            threadId: original.threadId,
            replyTo: op.messageId,
            artifactRefs: op.artifactRefs,
            payload: op.payload,
          });
          turn.sentOps++;
          return res.accepted ? { ok: true, op: op.op, messageId: res.messageId } : { ok: false, op: op.op, reason: res.reason };
        }
        case "discharge": {
          const pending = this.state.pendingRequests.get(op.messageId);
          if (!pending) return { ok: false, op: op.op, reason: `no outstanding request '${op.messageId}' (already answered, or never existed)` };
          if (!stillOwes(pending, actorId) && actorId !== HUMAN_AGENT_ID) {
            // Only a debtor who STILL owes may close its own debt; otherwise
            // any agent could silence a question asked of someone else, and an
            // agent that already answered could close the debts of the
            // reviewers who have not.
            return {
              ok: false,
              op: op.op,
              reason: `only ${outstandingDebtors(pending).join(", ")} may discharge this request`,
            };
          }
          // Tell the asker before closing: a silently-closed ask leaves it
          // waiting on an answer that will now never come.
          const notice = await this.sendMessage({
            from: actorId,
            to: [pending.from],
            type: "INFORM",
            threadId: this.state.threads.has(pending.threadId) ? pending.threadId : undefined,
            newThread: this.state.threads.has(pending.threadId) ? undefined : { subject: `cannot answer ${op.messageId}` },
            replyTo: this.state.messages.has(op.messageId) ? op.messageId : undefined,
            payload: { declined: true, request: op.messageId, reason: op.reason },
            priority: "HIGH",
          });
          await this.dischargeCommitment(op.messageId, "reply", actorId, { declined: true, reason: op.reason });
          turn.sentOps++;
          return { ok: true, op: op.op, messageId: notice.messageId, reason: op.reason };
        }
        case "publish_artifact": {
          const res = await this.createArtifact({
            actorId,
            name: op.name,
            type: op.type,
            content: op.content,
            status: op.status,
            metadata: op.metadata,
            parentArtifactId: op.parentArtifactId,
            asVersionOf: op.asVersionOf,
          });
          if ("error" in res) return { ok: false, op: op.op, reason: res.error };
          turn.publishedOps++;
          (turn.publishedIds ?? (turn.publishedIds = [])).push(res.artifact.id);
          return { ok: true, op: op.op, artifactId: res.artifact.id, artifactUri: res.uri, artifact: res.artifact };
        }
        case "read_artifact": {
          const a = this.findArtifactByUri(op.artifactRef);
          if (!a) return { ok: false, op: op.op, reason: "unknown artifact ref" };
          const content = await this.deps.content.read(a.contentRef);
          return { ok: true, op: op.op, reason: content };
        }
        case "transition_artifact": {
          const targetId = this.resolveArtifactRef(op.artifactId, op.artifactUri);
          if (!targetId) return { ok: false, op: op.op, reason: `unknown artifact ${op.artifactId ?? op.artifactUri}` };
          const res = await this.transitionArtifact(actorId, targetId, { to: op.to, comment: op.evidence });
          return { ok: res.ok, op: op.op, reason: res.reason, eventId: res.eventId };
        }
        case "request_review": {
          let targetId = this.resolveArtifactRef(op.artifactId, op.artifactUri);
          if (!targetId && turn.publishedIds && turn.publishedIds.length > 0) {
            // Same-turn publish → review: the model's URI guess didn't resolve,
            // but it just published something — reviewing that is the intent.
            targetId = turn.publishedIds[turn.publishedIds.length - 1];
          }
          const a = targetId ? this.state.artifacts.get(targetId) : undefined;
          if (!a) return { ok: false, op: op.op, reason: `unknown artifact ${op.artifactId ?? op.artifactUri ?? "(none given)"}` };
          const ctx = { config: this.config, projections: this.state, goal: this.state.goals.get(goalId) };
          const cap = capabilityForReview(a.type);
          if (cap) {
            const decision = this.deps.policy.evaluateCapability(actorId, cap, ctx);
            if (decision.decision !== "ALLOW") await this.denied(actorId, a.id, "request review", decision);
          }
          const tr = await this.transitionArtifact(actorId, a.id, { to: "READY_FOR_REVIEW" });
          if (!tr.ok && tr.reason && !tr.reason.includes("illegal")) return { ok: false, op: op.op, reason: tr.reason };
          const res = await this.sendMessage({
            from: actorId,
            to: op.reviewers,
            type: "REQUEST_REVIEW",
            newThread: { subject: `review ${a.name}`, artifactRefs: [{ uri: artifactUri(a.type, a.name, a.version) }] },
            artifactRefs: [{ uri: artifactUri(a.type, a.name, a.version) }],
            payload: { question: `Review ${a.type} ${a.name} v${a.version}` },
          });
          turn.sentOps++;
          return res.accepted ? { ok: true, op: op.op, messageId: res.messageId } : { ok: false, op: op.op, reason: res.reason };
        }
        case "approve": {
          const res = await this.recordDecision(actorId, op.kind === "pass" ? "pass" : "approve", op.subject, this.resolveArtifactRef(op.artifactId, op.artifactUri), op.comment);
          return { ok: res.ok, op: op.op, reason: res.reason, eventId: res.eventId };
        }
        case "reject": {
          const res = await this.recordDecision(actorId, "reject", op.subject, this.resolveArtifactRef(op.artifactId, op.artifactUri), op.comment);
          return { ok: res.ok, op: op.op, reason: res.reason, eventId: res.eventId };
        }
        case "veto": {
          const res = await this.recordDecision(actorId, "veto", op.subject, this.resolveArtifactRef(op.artifactId, op.artifactUri), op.comment);
          return { ok: res.ok, op: op.op, reason: res.reason, eventId: res.eventId };
        }
        case "block": {
          const res = await this.recordDecision(actorId, "block", op.subject, this.resolveArtifactRef(op.artifactId, op.artifactUri), op.reason);
          return { ok: res.ok, op: op.op, reason: res.reason, eventId: res.eventId };
        }
        case "delegate": {
          return this.opDelegate(actorId, op, turn);
        }
        case "create_task": {
          const task = this.newTask(actorId, op.title, op.description, op.requiredCapabilities, op.artifactRefs, undefined, op.budgetHint);
          await this.emitTaskCreated(task);
          if (op.assignedTo) {
            await this.sendMessage({ from: actorId, to: [op.assignedTo], type: "DELEGATE", newThread: { subject: `task ${task.id}: ${op.title}` }, payload: { taskId: task.id }, taskId: task.id });
            turn.sentOps++;
          }
          return { ok: true, op: op.op, taskId: task.id };
        }
        case "claim_task": {
          const res = await this.claimTask(actorId, op.taskId);
          return { ok: res.ok, op: op.op, reason: res.reason };
        }
        case "complete_task": {
          const isWorker = this.workerInfo.get(actorId)?.taskId === op.taskId;
          const res = await this.completeTask(actorId, op.taskId, op.summary, op.artifacts);
          if (res.ok && isWorker) {
            const info = this.workerInfo.get(actorId)!;
            const result: SubAgentResult = {
              status: "COMPLETED",
              summary: op.summary,
              artifacts: op.artifacts ?? [],
              findings: [],
              risks: [],
              recommendation: "review the produced artifacts",
            };
            await this.deliverWorkerResult(actorId, info, result);
          }
          return { ok: res.ok, op: op.op, reason: res.reason };
        }
        case "propose_decision": {
          const d = await this.proposeDecision(actorId, op.topic, op.decision, op.evidence);
          return { ok: true, op: op.op, reason: d.id };
        }
        case "ratify_decision": {
          const res = await this.ratifyDecision(actorId, op.decisionId);
          return { ok: res.ok, op: op.op, reason: res.reason };
        }
        case "escalate": {
          const esc = await this.escalate({ reason: op.reason, raisedBy: actorId, detail: op.detail, conflictKey: op.conflictKey });
          turn.escalated = true;
          return { ok: true, op: op.op, escalationId: esc.id };
        }
        case "wait": {
          turn.waitRequested = true;
          return { ok: true, op: op.op };
        }
        case "done": {
          const task = this.state.agents.get(actorId)?.state.activeTaskId;
          if (task) {
            const t = this.state.tasks.get(task);
            if (t && (t.status === "CLAIMED" || t.status === "IN_PROGRESS")) {
              await this.completeTask(actorId, task, op.summary ?? "done");
            }
          }
          return { ok: true, op: op.op };
        }
        case "remember": {
          await this.rememberMemory(actorId, op.key, op.value);
          return { ok: true, op: op.op };
        }
        case "acquire_lease": {
          return this.opAcquireLease(actorId, op.artifactId, op.files);
        }
        case "release_lease": {
          return this.opReleaseLease(actorId, op.artifactId);
        }
        case "commit": {
          return this.opCommit(actorId, op.artifactId, op.message, op.files);
        }
        case "request_commit": {
          const a = this.state.artifacts.get(op.artifactId);
          if (!a) return { ok: false, op: op.op, reason: "unknown artifact" };
          const techLeads = [...this.state.agents.values()].filter((r) => r.definition.authority.includes("implementation.approve")).map((r) => r.definition.id);
          const res = await this.sendMessage({
            from: actorId,
            to: techLeads,
            type: "COMMIT",
            newThread: { subject: `commit ${a.name}`, artifactRefs: [{ uri: artifactUri(a.type, a.name, a.version) }] },
            artifactRefs: [{ uri: artifactUri(a.type, a.name, a.version) }],
            payload: { artifactId: a.id, comment: op.comment ?? "ready to commit" },
          });
          turn.sentOps++;
          return res.accepted ? { ok: true, op: op.op, messageId: res.messageId } : { ok: false, op: op.op, reason: res.reason };
        }
        case "merge": {
          return this.opMerge(actorId, op.artifactId, op.comment, op.artifactUri);
        }
        case "submit_result": {
          const info = this.workerInfo.get(actorId);
          if (!info || info.taskId !== op.taskId) return { ok: false, op: op.op, reason: "only spawned workers may submit results" };
          await this.completeTask(actorId, op.taskId, op.result.summary, op.result.artifacts);
          await this.deliverWorkerResult(actorId, info, op.result);
          return { ok: true, op: op.op };
        }
        case "spawn_worker": {
          return this.opSpawnWorker(actorId, op);
        }
        default:
          return { ok: false, op: (op as MeshOp).op, reason: "unknown op" };
      }
    } catch (err) {
      if (err instanceof KernelRejectedError) {
        this.auditLine(`op ${op.op} by ${actorId} rejected at layer 4: ${err.message}`);
        return { ok: false, op: op.op, reason: err.message };
      }
      throw err;
    }
  }

  private newTask(
    createdBy: string,
    title: string,
    description: string,
    requiredCapabilities?: string[],
    artifactRefs?: ArtifactRef[],
    parentTaskId?: string,
    budgetHint?: BudgetHint,
  ): Task {
    const goalId = this.state.activeGoalId!;
    const parent = parentTaskId ? this.state.tasks.get(parentTaskId) : undefined;
    const task: Task = {
      id: newTaskId(),
      goalId,
      title,
      description,
      createdBy,
      status: "OPEN",
      requiredCapabilities: requiredCapabilities ?? [],
      artifactRefs: artifactRefs ?? [],
      parentTaskId,
      delegationDepth: (parent?.delegationDepth ?? 0) + (parentTaskId ? 1 : 0),
      budget: { tokens: budgetHint?.maxTokens ?? this.config.budgets.taskTokens },
      createdAt: this.deps.kernel.clock.iso(),
    };
    return task;
  }

  private async emitTaskCreated(task: Task): Promise<void> {
    await this.deps.kernel.emit("task.created", { task }, { actorId: task.createdBy });
    this.deps.budget.declare(taskKey(task.goalId, task.id), "tokens", task.budget.tokens ?? null);
  }

  private async opDelegate(actorId: string, op: Extract<MeshOp, { op: "delegate" }>, turn: TurnState): Promise<OpResult> {
    const def = this.state.agents.get(actorId)?.definition;
    if (!def) return { ok: false, op: "delegate", reason: "unknown actor" };
    if (def.mode === "service") return { ok: false, op: "delegate", reason: "service agents may not delegate" };
    const target = this.state.agents.get(op.to)?.definition;
    if (!target) return { ok: false, op: "delegate", reason: `unknown target ${op.to}` };
    const missingCaps = (op.requiredCapabilities ?? []).filter((c) => !target.capabilities.includes(c));
    if (missingCaps.length > 0) {
      return { ok: false, op: "delegate", reason: `${op.to} lacks required capabilities ${missingCaps.join(", ")}` };
    }
    const task = this.newTask(actorId, op.title, op.description, op.requiredCapabilities, op.artifactRefs, this.state.agents.get(actorId)?.state.activeTaskId ?? undefined, op.budgetHint);
    await this.emitTaskCreated(task);
    const res = await this.sendMessage({
      from: actorId,
      to: [op.to],
      type: "DELEGATE",
      newThread: { subject: `delegate: ${op.title}` },
      payload: { taskId: task.id, title: op.title, description: op.description },
      taskId: task.id,
      budgetHint: op.budgetHint,
    });
    turn.sentOps++;
    return res.accepted ? { ok: true, op: "delegate", taskId: task.id, messageId: res.messageId } : { ok: false, op: "delegate", reason: res.reason };
  }

  private async opSpawnWorker(actorId: string, op: Extract<MeshOp, { op: "spawn_worker" }>): Promise<OpResult> {
    const def = this.state.agents.get(actorId)?.definition;
    if (!def) return { ok: false, op: "spawn_worker", reason: "unknown actor" };
    const dp = def.delegationPolicy;
    if (!dp.allowDelegation || dp.maxWorkers <= 0 || dp.maxDepth < 1) {
      await this.denied(actorId, undefined, "spawn_worker", { decision: "DENY", reason: "delegation policy forbids worker spawning" });
      return { ok: false, op: "spawn_worker", reason: "delegation policy forbids worker spawning (v1 flat mesh: max_depth=0)" };
    }
    const depth = this.workerDepthOf(actorId);
    if (depth >= dp.maxDepth) return { ok: false, op: "spawn_worker", reason: `max delegation depth ${dp.maxDepth} reached` };
    const activeWorkers = [...this.workerInfo.values()].filter((w) => w.parent === actorId).length;
    if (activeWorkers >= dp.maxWorkers) return { ok: false, op: "spawn_worker", reason: `max concurrent workers (${dp.maxWorkers}) reached` };
    const workerId = `${actorId}#worker-${activeWorkers + 1}`;
    const workerDef: AgentDefinition = {
      ...def,
      id: workerId,
      mode: "service",
      sessionPolicy: { persistent: false },
      delegationPolicy: { allowDelegation: false, maxDepth: 0, maxWorkers: 0 },
      interests: [],
      budget: { tokens: dp.workerBudgetTokens ?? 50000 },
      capabilities: op.capabilities ?? def.capabilities,
      authority: [],
    };
    await this.registerAgent(workerDef);
    const task = this.newTask(actorId, op.title, op.taskSpec, op.capabilities, [], this.state.agents.get(actorId)?.state.activeTaskId ?? undefined, { maxTokens: workerDef.budget.tokens });
    await this.emitTaskCreated(task);
    this.workerInfo.set(workerId, { parent: actorId, taskId: task.id, depth: depth + 1 });
    await this.deps.kernel.emit("task.claimed", { taskId: task.id, agentId: workerId }, { actorId: HUMAN_AGENT_ID });
    await this.sendMessage({
      from: actorId,
      to: [workerId],
      type: "REQUEST_EXECUTION",
      newThread: { subject: `worker task ${task.id}` },
      payload: { taskId: task.id, instruction: "You are a delegated worker. Return your outcome ONLY via submit_result (structured) â€” the parent never sees your transcript.", spec: op.taskSpec },
      taskId: task.id,
    });
    await this.activateAgent(workerId, { kind: "message", note: "assigned worker task" });
    return { ok: true, op: "spawn_worker", taskId: task.id, reason: workerId };
  }

  private workerDepthOf(agentId: string): number {
    const info = this.workerInfo.get(agentId);
    return info ? info.depth : 0;
  }

  private async deliverWorkerResult(workerId: string, info: { parent: string; taskId: string; depth: number }, result: SubAgentResult): Promise<void> {
    const created = await this.createArtifact({
      actorId: workerId,
      name: `worker-result-${shortHash(info.taskId)}`,
      type: "Decision",
      content: JSON.stringify(result, null, 2),
      metadata: { subAgentResult: true, worker: workerId, taskId: info.taskId },
    });
    const ref: ArtifactRef | undefined = "artifact" in created ? { uri: created.uri } : undefined;
    await this.sendMessage({
      from: workerId,
      to: [info.parent],
      type: "HANDOFF",
      newThread: { subject: `worker result ${info.taskId}` },
      artifactRefs: ref ? [ref] : [],
      payload: result,
      taskId: info.taskId,
    });
    await this.deps.kernel.emit("agent.completed", { agentId: workerId }, { actorId: HUMAN_AGENT_ID });
    const sess = this.sessions.get(workerId);
    if (sess) {
      await sess.runtime.stop(sess.session).catch(() => undefined);
      this.sessions.delete(workerId);
    }
    this.workerInfo.delete(workerId);
    void result;
  }

  private async opAcquireLease(actorId: string, artifactId: string, files: string[]): Promise<OpResult> {
    const artifact = this.state.artifacts.get(artifactId);
    if (!artifact) return { ok: false, op: "acquire_lease", reason: "unknown artifact" };
    if (artifact.owner !== actorId && actorId !== HUMAN_AGENT_ID) {
      return { ok: false, op: "acquire_lease", reason: `only the artifact owner may write (${artifact.owner})` };
    }
    const ctx = { config: this.config, projections: this.state, goal: this.state.goals.get(artifact.goalId) };
    const decision = this.deps.policy.evaluateCapability(actorId, "repository.write", ctx);
    if (decision.decision !== "ALLOW") {
      await this.denied(actorId, artifactId, "acquire lease", decision);
      return { ok: false, op: "acquire_lease", reason: decision.reason };
    }
    const existing = this.state.activeLeaseByArtifact.get(artifactId);
    if (existing) {
      const lease = this.state.leases.get(existing)!;
      const expired = lease.expiresAt && Date.parse(lease.expiresAt) < this.deps.kernel.clock.now().getTime();
      if (!expired && lease.agentId !== actorId) {
        return { ok: false, op: "acquire_lease", reason: `artifact is leased to ${lease.agentId} until ${lease.expiresAt ?? "?"}` };
      }
      if (!expired && lease.agentId === actorId) return { ok: true, op: "acquire_lease", reason: existing };
    }
    const worktree = this.deps.workspace ? await this.deps.workspace.ensureWorktree(actorId) : path.join(this.config.workspacePath, "worktrees", actorId);
    const lease = {
      id: newLeaseId(),
      artifactId,
      agentId: actorId,
      worktreePath: worktree,
      files,
      acquiredAt: this.deps.kernel.clock.iso(),
      expiresAt: new Date(this.deps.kernel.clock.now().getTime() + this.config.scheduling.leaseTtlMs).toISOString(),
    };
    try {
      await this.deps.kernel.emit("lease.acquired", { lease }, { actorId });
    } catch (err) {
      if (err instanceof KernelRejectedError) return { ok: false, op: "acquire_lease", reason: err.message };
      throw err;
    }
    return { ok: true, op: "acquire_lease", reason: lease.id };
  }

  private async opReleaseLease(actorId: string, artifactId: string): Promise<OpResult> {
    const leaseId = this.state.activeLeaseByArtifact.get(artifactId);
    if (!leaseId) return { ok: false, op: "release_lease", reason: "no active lease" };
    const lease = this.state.leases.get(leaseId)!;
    if (lease.agentId !== actorId && actorId !== HUMAN_AGENT_ID) {
      return { ok: false, op: "release_lease", reason: `lease held by ${lease.agentId}` };
    }
    await this.deps.kernel.emit("lease.released", { leaseId }, { actorId });
    return { ok: true, op: "release_lease", reason: leaseId };
  }

  private async opCommit(actorId: string, artifactId: string, message: string, files?: string[]): Promise<OpResult> {
    const artifact = this.state.artifacts.get(artifactId);
    if (!artifact) return { ok: false, op: "commit", reason: "unknown artifact" };
    const ctx = { config: this.config, projections: this.state, goal: this.state.goals.get(artifact.goalId) };
    const decision = this.deps.policy.evaluateCapability(actorId, "git.commit", ctx);
    if (decision.decision !== "ALLOW") {
      await this.denied(actorId, artifactId, "commit", decision);
      return { ok: false, op: "commit", reason: decision.reason };
    }
    const gateTokens = this.config.transitionGates["patch.commit"];
    if (gateTokens && gateTokens.length > 0) {
      const res = checkApprovals(this.state, gateTokens, artifactId);
      if (!res.ok) {
        const anyBlock = [...this.state.approvals.get(approvalKey("architecture", "block")) ?? [], ...[]].length > 0;
        await this.denied(actorId, artifactId, "commit (gate)", { decision: "DENY", reason: `commit requires ${res.missing.join(", ")}` });
        return { ok: false, op: "commit", reason: `commit gate unsatisfied, missing: ${res.missing.join(", ")}${anyBlock ? " (active block present)" : ""}` };
      }
    }
    const leaseId = this.state.activeLeaseByArtifact.get(artifactId);
    if (!leaseId || this.state.leases.get(leaseId)?.agentId !== actorId) {
      return { ok: false, op: "commit", reason: "commit requires an active write lease on the artifact" };
    }
    if (!this.deps.workspace) {
      return { ok: false, op: "commit", reason: "no git workspace configured for this mesh" };
    }
    const { commit, diffDigest, diff } = await this.deps.workspace.commitWorktree(actorId, message, files);
    const versioned = await this.createArtifact({
      actorId,
      name: artifact.name,
      type: "CodePatch",
      content: diff,
      asVersionOf: artifactId,
      metadata: { commit, diffDigest },
    });
    const changeEvents = this.changeEventsFromDiff(diff);
    for (const t of changeEvents) {
      await this.deps.kernel.emit(t, { artifactId, commit, diffDigest }, { actorId });
    }
    return { ok: true, op: "commit", artifactId, reason: commit, artifact: "artifact" in versioned ? versioned.artifact : undefined };
  }

  private changeEventsFromDiff(diff: string): EventType[] {
    const out: EventType[] = [];
    const lower = diff.toLowerCase();
    if (/(package\.json|pom\.xml|build\.gradle|requirements\.txt|go\.mod|cargo\.toml)/.test(lower)) out.push("dependency.changed");
    if (/(oauth|jwt|authenticat|session|login|password)/.test(lower)) out.push("authentication.changed");
    if (/(rbac|permission|authoriz|role|acl|policy)/.test(lower)) out.push("authorization.changed");
    return out;
  }

  private async opMerge(actorId: string, artifactId: string | undefined, comment?: string, artifactUriRef?: string): Promise<OpResult> {
    const targetId = this.resolveArtifactRef(artifactId, artifactUriRef);
    if (!targetId) return { ok: false, op: "merge", reason: "unknown artifact" };
    artifactId = targetId;
    const artifact = this.state.artifacts.get(artifactId);
    if (!artifact) return { ok: false, op: "merge", reason: "unknown artifact" };
    const ctx = { config: this.config, projections: this.state, goal: this.state.goals.get(artifact.goalId) };
    const decision = this.deps.policy.evaluateCapability(actorId, "git.merge", ctx);
    if (decision.decision !== "ALLOW") {
      await this.denied(actorId, artifactId, "merge", decision);
      return { ok: false, op: "merge", reason: decision.reason };
    }
    if (artifact.status !== "MERGEABLE") {
      return { ok: false, op: "merge", reason: `artifact is ${artifact.status}, must be MERGEABLE` };
    }
    const res = await this.transitionArtifact(actorId, artifactId, { to: "MERGED", comment });
    if (!res.ok) return { ok: false, op: "merge", reason: res.reason };
    if (this.deps.workspace) {
      const merged = await this.deps.workspace.mergeWorktree(artifactId, artifact.owner, comment ?? `merge ${artifact.name}`);
      await this.transitionArtifact(HUMAN_AGENT_ID, artifactId, { to: "MERGED" }).catch(() => undefined);
      void merged;
    }
    await this.markCriterionEvidence("implementation-merged", {
      kind: "merge",
      artifactRef: { uri: artifactUri(artifact.type, artifact.name, artifact.version) },
      by: actorId,
      recordedAt: this.deps.kernel.clock.iso(),
    });
    return { ok: true, op: "merge", eventId: res.eventId };
  }

  private sendMessageCapability(actorId: string, type: MessageType): string | null {
    const def = this.state.agents.get(actorId)?.definition;
    if (!def) return "unknown sender";
    const capByType: Partial<Record<MessageType, string>> = {
      REQUEST_RESEARCH: "request_review",
      REQUEST_REVIEW: "request_review",
    };
    const need = capByType[type];
    if (!need) return null;
    const has = def.capabilities.includes(need) || def.capabilities.includes("repository.read");
    return has ? null : `missing capability ${need}`;
  }

  /**
   * In a real organization an author may never approve their own work. But a
   * single-agent control group has no peers; the benchmark (§71) needs to be
   * mechanically comparable, so self-review is allowed only when no OTHER
   * registered agent could have reviewed the artifact.
   *
   * Delegates so the op path and the message-path reducer screen self-approval
   * against ONE definition — see `hasPeerReviewerFor` in projections-helpers.
   */
  hasPeerReviewer(actorId: string, artifact: Artifact): boolean {
    return hasPeerReviewerFor(this.state, actorId, artifact, HUMAN_AGENT_ID);
  }

  resolveArtifactRef(explicit?: string, uri?: string): string | undefined {
    if (explicit && this.state.artifacts.has(explicit)) return explicit;
    if (uri) {
      const found = this.findArtifactByUri(uri);
      if (found) return found.id;
    }
    // LLMs address artifacts by display name (or a bare-name slug), not just
    // id / artifact:// URI. Resolve those too so name-based ops don't fail
    // with "unknown artifact <name>" while the artifact clearly exists.
    if (explicit) {
      const found = this.findArtifactByUri(explicit);
      if (found) return found.id;
    }
    return explicit;
  }

  private researchCache(question: string): ArtifactRef | undefined {
    const norm = question.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
    for (const a of this.state.artifacts.values()) {
      if (a.type !== "ResearchReport") continue;
      if ((a.metadata as any)?.questionHash === norm) {
        return { uri: artifactUri(a.type, a.name, a.version), version: a.version, digest: a.digest };
      }
    }
    return undefined;
  }

  async rememberMemory(agentId: string, key: string, value: string): Promise<void> {
    await this.deps.kernel.emit("memory.updated", {
      agentId,
      note: { agentId, key, value, updatedAt: this.deps.kernel.clock.iso(), eventId: "" },
    }, { actorId: agentId });
  }

  // ------------------------------------------------------ post-activity checks

  private async afterActivity(): Promise<void> {
    this.scheduleWatchdog(true);
    await this.watchdogChain;
  }

  /**
   * Run a watchdog scan now and await it. The periodic path is time-throttled
   * (burst collapsing), which makes it useless to assert against; tests and
   * operator tooling need a deterministic "reconcile and settle" trigger.
   */
  async forceWatchdog(): Promise<void> {
    this.watchdogLastRun = 0;
    this.scheduleWatchdog(true);
    await this.watchdogChain;
  }

  /**
   * High-volume bookkeeping that never directly flips a termination verdict —
   * verdicts read budgets/escalations/tasks/criteria, which these events only
   * approach asymptotically. Collapsing them is where the throttle wins;
   * everything semantic (evidence, failures, overruns, task/goal changes)
   * still scans immediately.
   */
  private scheduleWatchdog(immediate: boolean): void {
    // Burst collapsing OUTSIDE the chain: N events/sec become one scan now +
    // one trailing scan ~1s later. (Sleeping inside the chain would serialize
    // the delays and stall shutdown/teardown behind seconds of naps.)
    const elapsed = Date.now() - this.watchdogLastRun;
    if (immediate || elapsed >= 1000) {
      this.watchdogLastRun = Date.now();
      this.watchdogChain = this.watchdogChain
        .then(() => this.watchdog())
        .catch((err) => {
          this.auditLine(`watchdog error: ${err.stack ?? err.message}`);
        });
    } else if (!this.watchdogTrailing) {
      this.watchdogTrailing = true;
      const t = setTimeout(() => {
        this.watchdogTrailing = false;
        this.watchdogLastRun = Date.now();
        this.watchdogChain = this.watchdogChain
          .then(() => this.watchdog())
          .catch((err) => {
            this.auditLine(`watchdog error: ${err.stack ?? err.message}`);
          });
      }, 1000 - elapsed);
      (t as unknown as { unref?: () => void }).unref?.();
    }
  }

  private async watchdog(): Promise<void> {
    if (this.stopping) return;
    const findings = this.detector.scan(this.state);
    for (const f of findings) {
      this.detector.markReported(f);
      // A circular wait is the one deadlock the runtime can resolve by
      // itself, so try that before spending the operator's attention.
      if (f.kind === "wait_cycle" && (await this.breakWaitCycle(f))) continue;
      await this.onDeadlock(f);
    }
    // Retire stale derived cards BEFORE evaluating termination: a summary
    // whose supports have all closed is a description of a world that no
    // longer exists, and leaving it open would (a) re-trigger the stalemate
    // verdict below and (b) strand the mission behind an unanswerable card.
    await this.reconcileDerivedEscalations();
    // Clear whatever the runtime is allowed to clear before asking a human.
    // `agent_budget_exhausted` / `thread_budgets_exhausted` verdicts read the
    // LATCHED `exceeded` flag, so a ledger that overran once escalates the
    // whole mission on the next tick even though the turn path would have
    // auto-raised it. Raising here (under the same ceiling) means the operator
    // only ever sees the budget card that the ceiling itself produced.
    await this.autoRaiseExhaustedLedgers();
    const verdict = this.termination.evaluate({
      state: this.state,
      config: this.config,
      wallClockMs: Date.now() - this.startedAt,
    });
    const goalId = this.state.activeGoalId;
    if (!goalId) return;
    const goal = this.state.goals.get(goalId);
    if (!goal) return;
    if (verdict.kind === "complete" && goal.status !== "COMPLETED") {
      await this.deps.kernel.emit("goal.completed", { goalId, reason: verdict.reason, evidence: verdict.evidenceSummary }, { actorId: HUMAN_AGENT_ID });
      await this.completeMission();
    } else if (verdict.kind === "escalate" && goal.status !== "ESCALATED") {
      await this.escalate({
        reason: verdict.reason,
        raisedBy: "termination-manager",
        detail: verdict.detail,
        supports: verdict.supports,
      });
      await this.deps.kernel.emit("goal.escalated", { goalId, reason: verdict.reason, detail: verdict.detail }, { actorId: HUMAN_AGENT_ID });
    } else if (verdict.kind === "fail" && goal.status !== "FAILED") {
      await this.deps.kernel.emit("goal.failed", { goalId, reason: verdict.reason }, { actorId: HUMAN_AGENT_ID });
    }
  }

  /**
   * Enforce the derived-escalation invariant:
   *
   *   a derived card is OPEN  <=>  at least one supporting primary is OPEN
   *
   * This runs on every watchdog tick, which is the whole point. Previously
   * reconciliation only happened inside `respondEscalation`, so it covered
   * exactly one of the many ways a stuck request can resolve — the operator
   * answering the underlying card. Every other path (a natural reply landing
   * via `replyTo`, a new artifact version retiring the review, the task being
   * completed, the request being dropped) silently cleared the primary and
   * left the summary OPEN forever, parking the mission on a card whose
   * underlying question had already been answered.
   *
   * Retiring emits `escalation.auto_resolved`, not `escalation.responded`:
   * the runtime is stating a fact, not forging an operator decision.
   */
  private async reconcileDerivedEscalations(): Promise<void> {
    let retired = 0;
    // Phase 1 — stale primaries. A `stuck:*` card asks "nobody answered this
    // request". `pendingRequests` is cleared by EIGHT different paths (an
    // explicit replyTo, a same-thread answer, a task completion, a matching
    // artifact ref, a new artifact version, TEST_RESULT, operator answer,
    // operator drop) and NONE of them closed the escalation. So a request that
    // resolved on its own left a card demanding an operator answer to a
    // question the mesh had already answered — the mission's most common way
    // to deadlock itself. The pending entry is the question; if it is gone,
    // the card has no question left to ask.
    for (const esc of [...this.state.escalations.values()]) {
      if (esc.status !== "OPEN" || isDerivedEscalation(esc)) continue;
      const stuck = stuckRequestOf(esc);
      if (!stuck || this.state.pendingRequests.has(stuck.messageId)) continue;
      // "Gone" is not "answered". Ledger-capacity eviction and deadlock-break
      // voiding both remove the pending entry WITHOUT anyone answering it, so
      // retiring the card on absence alone would write a false statement into
      // the audit log — the one thing this runtime sells. Those cards stay
      // OPEN for the operator; only genuine resolutions retire.
      const how = [...this.state.discharged].reverse().find((d) => d.messageId === stuck.messageId);
      if (how && UNANSWERED_DISCHARGE_REASONS.has(how.reason)) continue;
      this.deps.scheduler.resetStallTracking?.(stuck.messageId, stuck.agentId);
      await this.deps.kernel.emit(
        "escalation.auto_resolved",
        {
          escalationId: esc.id,
          reason: how
            ? `auto-resolved: the request was discharged (${how.reason})`
            : "auto-resolved: the request was answered or withdrawn",
          requestMessageId: stuck.messageId,
          dischargeReason: how?.reason,
        },
        { actorId: "termination-manager", goalId: esc.goalId },
      );
      retired++;
    }
    // Phase 2 — derived summaries left without an open support.
    for (const esc of [...this.state.escalations.values()]) {
      if (esc.status !== "OPEN" || !isDerivedEscalation(esc)) continue;
      const supports = supportsOf(esc);
      const live = supports.filter((id) => this.state.escalations.get(id)?.status === "OPEN");
      if (live.length > 0) continue;
      await this.deps.kernel.emit(
        "escalation.auto_resolved",
        {
          escalationId: esc.id,
          reason:
            supports.length === 0
              ? "auto-resolved: summary had no supporting escalations"
              : `auto-resolved: all ${supports.length} underlying escalation(s) resolved`,
          supports,
        },
        { actorId: "termination-manager", goalId: esc.goalId },
      );
      retired++;
    }
    // Only un-park as a CONSEQUENCE of having retired something. A mission can
    // legitimately sit ESCALATED with no escalation record at all (an operator
    // freeze, a `goal.escalated` emitted directly), and auto-resuming that
    // would silently undo a deliberate halt. Resuming only when this sweep
    // actually closed a card keeps the rule narrow: we undo exactly the parks
    // that our own now-answered cards caused.
    if (retired > 0 && this.state.activeGoalId) await this.resumeIfNothingPending(this.state.activeGoalId);
  }

  /**
   * Flip an ESCALATED goal back to ACTIVE once no OPEN escalation remains.
   * Safe to call repeatedly; a no-op when the operator still owes a decision.
   */
  /**
   * Flip an ESCALATED goal back to ACTIVE once no ACTIONABLE escalation
   * remains. Advisory cards don't block: they need no urgent answer.
   * Safe to call repeatedly; a no-op when the operator still owes a decision.
   */
  private async resumeIfNothingPending(goalId: string): Promise<void> {
    const goal = this.state.goals.get(goalId);
    if (!goal || goal.status !== "ESCALATED") return;
    const stillOpen = [...this.state.escalations.values()].some((e) => e.status === "OPEN" && e.goalId === goalId && !e.advisory);
    if (stillOpen) return;
    await this.deps.kernel.emit(
      "goal.status_changed",
      { goalId, status: "ACTIVE", reason: "all escalations resolved" },
      { actorId: "termination-manager" },
    );
    for (const c of this.recoveryCandidates()) {
      await this.activateAgent(c, { kind: "recovery", note: "escalations cleared" }).catch(() => undefined);
    }
  }

  private async onDeadlock(finding: DeadlockFinding): Promise<void> {
    await this.escalate({
      reason: `deadlock:${finding.kind}`,
      raisedBy: "deadlock-detector",
      conflictKey: finding.conflictKey,
      threadId: finding.threadId,
      artifactId: finding.artifactId,
      participants: finding.participants,
      // Participants and the open asks ride on the card: a circular-wait
      // escalation is only actionable if the operator can see WHO is stuck on
      // WHAT without going spelunking in the event log.
      detail: {
        description: finding.description,
        participants: finding.participants,
        ...(finding.kind === "wait_cycle" ? { blockedRequests: this.openRequestsAmong(finding.participants) } : {}),
      },
    });
  }

  /**
   * Resolve a circular wait without the operator.
   *
   * Escalating a deadlock freezes the WHOLE mission (the goal flips
   * ESCALATED, and `evaluateActivation` then denies every agent), so two
   * agents stuck on each other stop five uninvolved ones and wait on a human.
   * But a cycle is exactly the case the runtime can settle on its own: the
   * asks are mutually blocking, so *any* one of them being withdrawn frees
   * the whole ring.
   *
   * Policy: void the NEWEST ask in the cycle. It is the one that closed the
   * ring, its asker has done the least work waiting on it, and dropping it
   * preserves the older (usually more load-bearing) request. The asker is
   * woken with an explicit note so it re-plans instead of silently re-asking
   * the same question — a silent drop would just rebuild the cycle.
   *
   * Everything is recorded (`deadlock.auto_resolved` + a woken agent), so an
   * operator reviewing the log sees exactly what the runtime decided and why.
   * Returns false when nothing could be voided, in which case the caller
   * falls through to the normal escalation path.
   */
  private async breakWaitCycle(finding: DeadlockFinding): Promise<boolean> {
    const members = new Set(finding.participants);
    const inCycle = [...this.state.pendingRequests.values()]
      .filter((pr) => members.has(pr.from) && outstandingDebtors(pr).some((t) => members.has(t)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const victim = inCycle[0];
    if (!victim) return false;
    await this.dischargeCommitment(victim.messageId, "deadlock_break", "deadlock-detector", {
      conflictKey: finding.conflictKey,
      participants: finding.participants,
    });
    await this.deps.kernel
      .emit(
        "deadlock.auto_resolved",
        {
          kind: finding.kind,
          conflictKey: finding.conflictKey,
          participants: finding.participants,
          voidedRequestId: victim.messageId,
          voidedBy: victim.from,
          voidedTo: victim.to,
          reason: finding.description,
          note: "newest request in the cycle was voided so the ring could progress",
        },
        { actorId: "deadlock-detector", goalId: this.state.activeGoalId ?? undefined },
      )
      .catch(() => undefined);
    this.deps.scheduler.resetStallTracking?.(victim.messageId, victim.from);
    if (this.state.agents.has(victim.from)) {
      await this.activateAgent(victim.from, {
        kind: "recovery",
        note: `circular wait detected (${finding.participants.join(" -> ")}); your request ${victim.messageId} was voided so the deadlock could break — proceed on your own best judgement or ask someone outside the cycle`,
      }).catch(() => undefined);
    }
    this.auditLine(`wait cycle ${finding.conflictKey} broken by voiding ${victim.messageId} from ${victim.from}`);
    return true;
  }

  /** The open asks that form a wait cycle, for the escalation card. */
  private openRequestsAmong(participants: string[]): Array<{ messageId: string; from: string; to: string[]; type: string; since: string }> {
    const members = new Set(participants);
    return [...this.state.pendingRequests.values()]
      .filter((pr) => members.has(pr.from) && outstandingDebtors(pr).some((t) => members.has(t)))
      .slice(0, 20)
      .map((pr) => ({ messageId: pr.messageId, from: pr.from, to: outstandingDebtors(pr), type: pr.type, since: pr.createdAt }));
  }

  /**
   * Let turns that are already running finish before the mission is torn down.
   *
   * `shutdown()` stops every runtime session, so a turn caught mid-flight dies
   * against a dead backend and lands in the log as `agent.failed` with a bare
   * URL for an error — noise that looks like a broken mesh in the steps view
   * when it is really just the completion sweep racing its own agents. Bounded
   * so a wedged turn can never block completion forever.
   */
  private async drainInFlightTurns(timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.turnInFlight.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (this.turnInFlight.size > 0) {
      this.auditLine(`completion drain timed out with ${this.turnInFlight.size} turn(s) still in flight: ${[...this.turnInFlight].join(", ")}`);
    }
  }

  private async completeMission(): Promise<void> {
    // Drain BEFORE the sweep, not just before shutdown: an agent that is
    // mid-turn is neither IDLE nor WAITING, so sweeping first would skip it and
    // leave the mission with a mix of COMPLETED and IDLE agents depending on
    // who happened to be running. Draining first makes the sweep deterministic.
    await this.drainInFlightTurns();
    for (const rec of [...this.state.agents.values()]) {
      const a = rec.state;
      if (a.agentId === HUMAN_AGENT_ID) continue;
      if (a.lifecycle === "IDLE" || a.lifecycle === "WAITING") {
        // Tolerant: one refused transition must not abort the sweep. But NOT
        // silent — a swallowed rejection here is how agents used to survive a
        // finished mission stuck in WAITING with nothing in the log to say so.
        await this.deps.kernel
          .emit("agent.completed", { agentId: a.agentId }, { actorId: HUMAN_AGENT_ID })
          .catch((err) => this.auditLine(`completion sweep could not retire ${a.agentId} from ${a.lifecycle}: ${(err as Error).message}`));
      }
    }
    await this.shutdown();
  }

  private onIdle(): void {
    void this.afterActivity();
    for (const cb of this.idleCallbacks) cb();
  }

  private startStallWatch(): void {
    this.stopStallWatch();
    const t = setInterval(() => {
      void this.checkStall().catch((err) => this.auditLine(`stall watch error: ${(err as Error).message}`));
    }, Math.min(30_000, Math.max(100, Math.floor(this.config.scheduling.stallIdleMs / 3))));
    (t as unknown as { unref?: () => void }).unref?.();
    this.stallTimer = t;
  }

  private stopStallWatch(): void {
    if (this.stallTimer) {
      clearInterval(this.stallTimer);
      this.stallTimer = undefined;
    }
    if (this.stallNoopTimer) {
      clearTimeout(this.stallNoopTimer);
      this.stallNoopTimer = undefined;
    }
    this.stallNoopRetryAt = 0;
  }

  /**
   * Nudge a quiet-but-unfinished mission: ACTIVE goal, empty scheduler, no
   * turn running, and nothing finished for STALL_IDLE_MS.
   *
   * Driver choice matters. This used to wake `startupActivate[0]` and nothing
   * else, so a mesh whose single startup agent was parked by the circuit
   * breaker (or whose turns kept parsing zero ops) had NO path back: the one
   * agent it ever nudged was the one that could not run, and the mission sat
   * idle forever. Now it prefers an agent that actually has work — unread
   * mail or an active task — then falls back to startup order, and skips
   * parked agents entirely.
   */
  private async checkStall(): Promise<void> {
    if (this.stopping || !this.liveMode) return;
    const goalId = this.state.activeGoalId;
    const goal = goalId ? this.state.goals.get(goalId) : undefined;
    if (!goal || goal.status !== "ACTIVE") return;
    if (this.deps.scheduler.pending() !== 0 || this.deps.scheduler.running() !== 0) return;
    const now = Date.now();
    if (this.turnInFlight.size !== 0) {
      // A streamed-then-silent turn is the watchdog's blind spot: the old bail
      // here left a post-stream freeze holding the message pending until the
      // turn timeout. Streaming turns get interrupted below; the mission-quiet
      // gates that follow only make sense when nothing is in flight.
      this.interruptSilentTurns(now);
      return;
    }
    // A no-op turn arms a fast retry: the idle and cooldown gates both apply
    // to work-producing turns (their async ripple may still be landing), but
    // a turn that changed nothing deserves the next driver in seconds. Guarded
    // on `> 0` so a consumed/disarmed retry cannot re-fire on the next tick.
    const noopFastRetry = this.stallNoopRetryAt > 0 && now >= this.stallNoopRetryAt;
    if (!noopFastRetry) {
      if (now - this.lastTurnAt < this.config.scheduling.stallIdleMs) return;
      if (now - this.lastStallNudgeAt < this.config.scheduling.stallCooldownMs) return;
    }
    // QUIESCENCE GATE. Waking an agent costs a full context window, so the
    // decision to wake one must be made from mesh state — for free — BEFORE
    // the model is called. A mission whose every criterion is evidenced, whose
    // mailboxes are empty and whose escalations are closed has, by definition,
    // nothing for a driver to do: nudging it buys a `done` op at 5-88k tokens.
    const actionable = this.wakeValue();
    if (!actionable.worth) {
      // Say it once, then stay silent: an audit line per tick is its own spam.
      if (!this.quiesced) {
        this.quiesced = true;
        this.auditLine(`stall watch: mission quiet and nothing actionable (${actionable.why}) — resting the watchdog until real work arrives`);
      }
      return;
    }
    // NOTE: no nudge cap on this path. Here the mission demonstrably still has
    // work (unmet criteria, mail, escalations, claimed tasks), and a watchdog
    // that gave up on a genuinely stuck mission would be a deadlock, not a
    // saving. Chronic no-op agents are already handled where they should be:
    // the circuit breaker parks them and `stallDriver` skips parked agents.
    const driver = this.stallDriver();
    if (!driver) return;
    const res = await this.activateAgent(driver, { kind: "timer", note: this.stallWakeNote() });
    if (!res.queued) {
      // A refused fast retry must not pin the mission to the cooldown either:
      // let the next tick try another driver. The activation itself (breaker,
      // policy) is the real limiter.
      if (noopFastRetry) this.stallNoopRetryAt = Date.now() + this.config.scheduling.stallNoopRetryMs;
      // Activation refused (policy DENY/DEFER, busy, parked): nothing was
      // scheduled, so burning the 5-minute cooldown here would leave the
      // mission idle until it lapses. Retry next tick instead — and say so,
      // so the audit trail shows a mesh that cannot schedule rather than one
      // that is merely quiet.
      this.auditLine(`stall watch: mission quiet but driver ${driver} refused (${res.blocked ?? "unknown"}) — retrying next tick, cooldown not consumed`);
      return;
    }
    this.lastStallNudgeAt = now;
    if (this.stallNoopTimer) {
      clearTimeout(this.stallNoopTimer);
      this.stallNoopTimer = undefined;
    }
    this.stallNoopRetryAt = 0;
    this.auditLine(`stall watch: mission quiet for ${Math.round((now - this.lastTurnAt) / 1000)}s, nudging ${driver}`);
  }

  /**
   * Interrupt a turn that streamed tokens and then went silent. Only turns
   * past the first token qualify: pre-token thinking and long internal tool
   * runs never reach onToken, so they must be left alone. The interrupt makes
   * the pending send() reject (isTimeoutError → slow), and runTurn's own
   * catch already does the finish/retry bookkeeping; the forced settle below
   * is only for runtimes whose interrupt is a no-op (stub), whose send()
   * would otherwise hang forever. Guarded per turn so neither path double-
   * fires.
   */
  private interruptSilentTurns(now: number): void {
    const silenceMs = this.config.scheduling.turnSilenceMs;
    for (const agentId of this.turnInFlight) {
      const turnId = this.activeTurnByAgent.get(agentId);
      const session = this.sessions.get(agentId);
      const phases = turnId ? this.turns.get(turnId)?.phases : undefined;
      const lastTokenAt = phases?.firstTokenAt === undefined ? undefined : (phases.lastTokenAt ?? phases.firstTokenAt);
      if (!turnId || !session || lastTokenAt === undefined) continue;
      if (now - lastTokenAt <= silenceMs) continue;
      if (this.interruptedTurnIds.has(turnId)) continue;
      this.interruptedTurnIds.add(turnId);
      this.auditLine(`stall silence: turn ${turnId} for ${agentId} silent for ${now - lastTokenAt}ms — interrupting`);
      void session.runtime.interrupt(session.session).catch(() => undefined);
      // Real runtimes settle the send() via the abort; a no-op interrupt
      // (stub) leaves it pending forever, so force-settle after a short grace.
      const t = setTimeout(() => {
        if (!this.turnInFlight.has(agentId) || this.activeTurnByAgent.get(agentId) !== turnId) return;
        const abort = new DOMException(`turn silence exceeded ${silenceMs}ms`, "AbortError");
        this.finishTurn(turnId, agentId, { status: "failed", error: abort.message, errorDetail: describeError(abort, "llmCallAt") });
        const reason: ActivationReason = this.turns.get(turnId)?.reason ?? { kind: "timer" };
        void this.handleAgentFailure(agentId, abort, reason);
      }, 2000);
      (t as unknown as { unref?: () => void }).unref?.();
    }
  }

  /**
   * Is waking ANYONE worth a context window right now? Answered from state,
   * never from a model.
   *
   * This is the difference between a mesh that rests and one that idles
   * expensively. The old watchdog only asked "is it quiet?", which is true
   * both of a mission that is stuck (wake someone!) and of one that is done
   * (leave it alone). Distinguishing them is cheap — unmet criteria, unread
   * mail, live tasks and open escalations are all in projections already.
   */
  private wakeValue(): { worth: boolean; why: string } {
    const goal = this.state.activeGoalId ? this.state.goals.get(this.state.activeGoalId) : undefined;
    if (!goal) return { worth: false, why: "no active goal" };
    const mandatory = goal.acceptanceCriteria.filter((c) => c.mandatory);
    const unmet = mandatory.filter((c) => c.status !== "EVIDENCED" && c.status !== "WAIVED");
    if (unmet.length > 0) return { worth: true, why: `${unmet.length} mandatory criteria unmet` };
    // Every criterion is evidenced. Only a concrete loose end justifies a turn.
    const mail = [...this.state.agents.keys()].some((id) => (this.state.unread.get(id)?.length ?? 0) > 0);
    if (mail) return { worth: true, why: "undelivered mail" };
    const openEscalations = [...this.state.escalations.values()].filter((e) => e.status === "OPEN");
    if (openEscalations.length > 0) return { worth: true, why: `${openEscalations.length} open escalations` };
    // A CLAIMED task has an owner who may still be working. An unowned OPEN
    // task with every criterion evidenced is bookkeeping residue, not work:
    // nobody claimed it and no criterion needs it. Treating it as work is
    // exactly what wedged the mission open.
    const liveTasks = [...this.state.tasks.values()].filter(
      (t) => t.status === "CLAIMED" && !t.id.startsWith("watch:"),
    );
    if (liveTasks.length > 0) return { worth: true, why: `${liveTasks.length} claimed tasks in flight` };
    return { worth: false, why: "all mandatory criteria evidenced, no mail, no open escalations, no claimed tasks" };
  }

  /**
   * The wake note must never contradict itself. It used to always end with
   * "drive the next step toward an unmet criterion" — including when the
   * summary it embedded said "all mandatory criteria evidenced". An agent
   * handed that prompt has one honest answer: `done`. It gave that answer 21
   * times, at full context price, because the instruction described a world
   * that did not exist.
   */
  private stallWakeNote(): string {
    const summary = this.unmetCriteriaSummary();
    const base = `stall watchdog: mission active but quiet — ${summary}`;
    if (!this.hasUnmetMandatory()) {
      return `${base}. Do NOT re-approve or re-confirm finished work. Either close out a concrete loose end (unanswered mail, an open escalation, a claimed task), or reply with a single \`done\` op and stop — the mission will close itself.`;
    }
    return `${base}; drive the next step toward an unmet criterion (see Mission acceptance criteria in your context)`;
  }

  /** True when at least one mandatory criterion still lacks evidence. */
  private hasUnmetMandatory(): boolean {
    const goal = this.state.activeGoalId ? this.state.goals.get(this.state.activeGoalId) : undefined;
    if (!goal) return false;
    return goal.acceptanceCriteria.some((c) => c.mandatory && c.status !== "EVIDENCED" && c.status !== "WAIVED");
  }

  /** Who to wake for a stalled mission: someone with real work, else rotate across the stuck. */
  private stallDriver(): string | undefined {
    const eligible = (id: string): boolean => {
      const rec = this.state.agents.get(id);
      if (!rec || id === HUMAN_AGENT_ID) return false;
      if (["SUSPENDED", "COMPLETED", "FAILED"].includes(rec.state.lifecycle)) return false;
      // A parked agent is exactly the one that cannot make progress; nudging
      // it is how the mission stayed stuck.
      return !this.deps.scheduler.isParkedForBackoff?.(id);
    };
    // Oldest-activity-first so repeated stall nudges ROTATE across stuck
    // agents instead of hammering startupActivate[0] forever: that agent
    // wakes, finds nothing, goes IDLE, and gets picked again — while the
    // other WAITING agents stay parked on the bench.
    const byOldest = (a: string, b: string): number =>
      (this.state.agents.get(a)?.state.lastActivityAt ?? "").localeCompare(this.state.agents.get(b)?.state.lastActivityAt ?? "");
    const all = [...this.state.agents.keys()].filter(eligible);
    for (const id of all) {
      const rec = this.state.agents.get(id)!;
      if ((this.state.unread.get(id)?.length ?? 0) > 0 || rec.state.activeTaskId) return id;
    }
    const stuck = all.filter((id) => ["WAITING", "BLOCKED"].includes(this.state.agents.get(id)!.state.lifecycle)).sort(byOldest);
    if (stuck.length > 0) return stuck[0];
    const startup = this.config.startupActivate.filter(eligible).sort(byOldest);
    if (startup.length > 0) return startup[0];
    // Last resort: any live agent at all. Better a possibly-wrong nudge than
    // an ACTIVE mission that never moves again.
    return all.sort(byOldest)[0];
  }

  onIdleOnce(cb: () => void): void {
    this.idleCallbacks.push(cb);
  }

  /** "3 of 5 mandatory criteria unmet" for wake notes — "" when nothing is trackable. */
  private unmetCriteriaSummary(): string {
    const goal = this.state.activeGoalId ? this.state.goals.get(this.state.activeGoalId) : undefined;
    if (!goal) return "no acceptance criteria recorded";
    const mandatory = goal.acceptanceCriteria.filter((c) => c.mandatory);
    if (mandatory.length === 0) return "no mandatory acceptance criteria";
    const unmet = mandatory.filter((c) => c.status !== "EVIDENCED" && c.status !== "WAIVED");
    if (unmet.length === 0) return "all mandatory criteria evidenced";
    const names = unmet.slice(0, 3).map((c) => c.id).join(", ");
    return `${unmet.length} of ${mandatory.length} mandatory criteria unmet (${names}${unmet.length > 3 ? ", …" : ""})`;
  }

  isIdle(): boolean {
    return this.deps.scheduler.pending() === 0 && this.deps.scheduler.running() === 0 && this.turnInFlight.size === 0;
  }

  // ------------------------------------------------------------- human ops

  async humanSend(
    to: string[],
    type: MessageType,
    payload: unknown,
    threadId?: string,
    opts: { replyTo?: string; artifactRefs?: ArtifactRef[]; taskId?: string } = {},
  ): Promise<SendResult> {
    return this.sendMessage({
      from: HUMAN_AGENT_ID,
      to,
      type,
      threadId,
      newThread: threadId ? undefined : { subject: `human ${type}` },
      replyTo: opts.replyTo,
      artifactRefs: opts.artifactRefs,
      taskId: opts.taskId,
      payload,
      priority: "URGENT",
    });
  }

  /**
   * Answer a stuck request on behalf of the operator. Sends a human INFORM
   * with `replyTo` set to the original request so the pending-request
   * projection clears it deterministically (same-thread heuristics alone
   * cannot be relied on: the dashboard compose box has no thread context).
   * Then resets stall tracking and wakes the stuck agent + asker.
   */
  async answerStuckRequest(
    escalationId: string,
    text: string,
    by = HUMAN_AGENT_ID,
  ): Promise<{ ok: boolean; reason?: string; messageId?: string }> {
    const esc = this.state.escalations.get(escalationId);
    if (!esc) return { ok: false, reason: "unknown escalation" };
    const stuck = stuckRequestOf(esc);
    if (!stuck) return { ok: false, reason: "escalation is not a stuck-request (no requestMessageId)" };
    const pending = this.state.pendingRequests.get(stuck.messageId);
    const request = this.state.messages.get(stuck.messageId);
    if (!pending && !request) return { ok: false, reason: "original request no longer exists" };
    const threadId = pending?.threadId ?? request?.threadId;
    const asker = pending?.from ?? request?.from ?? "";
    const targets = [asker, stuck.agentId].filter((t) => t && t !== by && this.state.agents.has(t));
    if (targets.length === 0) return { ok: false, reason: "no live recipients for the answer" };
    // Pre-clear: the replyTo projection clears this same entry on emit, but
    // doing it up-front makes the operator action idempotent even if the
    // send below is policy-redirected or the thread was closed. Event-sourced
    // so a replay reproduces the operator's intervention.
    await this.dischargeCommitment(stuck.messageId, "operator", by, { escalationId, action: "answered" });
    const sent = await this.sendMessage({
      from: by,
      to: [...new Set(targets)],
      type: "INFORM",
      threadId,
      newThread: threadId ? undefined : { subject: `operator answer for ${stuck.messageId}` },
      replyTo: this.state.messages.has(stuck.messageId) ? stuck.messageId : undefined,
      artifactRefs: request?.artifactRefs ?? [],
      taskId: pending?.taskId ?? request?.taskId,
      payload: { answer: text, escalationId, stuckRequestId: stuck.messageId },
      priority: "URGENT",
    });
    if (!sent.accepted) return { ok: false, reason: sent.reason };
    await this.deps.kernel.emit(
      "human.input",
      { action: "stuck_request_answered", escalationId, requestMessageId: stuck.messageId, messageId: sent.messageId },
      { actorId: by },
    );
    this.deps.scheduler.resetStallTracking?.(stuck.messageId, stuck.agentId);
    for (const id of [...new Set([stuck.agentId, asker])]) {
      if (this.state.agents.has(id)) {
        await this.activateAgent(id, { kind: "recovery", note: `operator answered stuck request: ${text.slice(0, 120)}` }).catch(() => undefined);
      }
    }
    // The question is answered, so no card should still be asking it. Callers
    // that also want the operator's rationale recorded call respondEscalation
    // right after; this sweep just guarantees the mesh cannot stay parked when
    // they do not.
    await this.reconcileDerivedEscalations();
    return { ok: true, messageId: sent.messageId };
  }

  /**
   * Drop a stuck request on behalf of the operator. Deletes the pending
   * entry directly (no answer message is fabricated), records the operator
   * rationale in the log, resets stall tracking, and wakes the asker so it
   * stops WAITING on a dead ask.
   */
  async dropStuckRequest(
    escalationId: string,
    reason: string,
    by = HUMAN_AGENT_ID,
  ): Promise<{ ok: boolean; reason?: string }> {
    const esc = this.state.escalations.get(escalationId);
    if (!esc) return { ok: false, reason: "unknown escalation" };
    const stuck = stuckRequestOf(esc);
    if (!stuck) return { ok: false, reason: "escalation is not a stuck-request (no requestMessageId)" };
    const pending = this.state.pendingRequests.get(stuck.messageId);
    const request = this.state.messages.get(stuck.messageId);
    const asker = pending?.from ?? request?.from;
    await this.dischargeCommitment(stuck.messageId, "operator", by, { escalationId, action: "dropped", reason });
    await this.deps.kernel.emit(
      "human.input",
      { action: "stuck_request_dropped", escalationId, requestMessageId: stuck.messageId, reason },
      { actorId: by },
    );
    this.deps.scheduler.resetStallTracking?.(stuck.messageId, stuck.agentId);
    if (asker && this.state.agents.has(asker)) {
      await this.activateAgent(asker, { kind: "recovery", note: `operator dropped stuck request: ${reason.slice(0, 120)}` }).catch(() => undefined);
    }
    await this.reconcileDerivedEscalations();
    return { ok: true };
  }

  async status(): Promise<{
    goal?: Goal;
    agents: Array<{ id: string; role: string; lifecycle: LifecycleState; mailbox: number; tokens: number }>;
    budgets: ReturnType<BudgetManager["snapshot"]>;
    progress: { completed: number; total: number; ratio: number } | null;
    openEscalations: Escalation[];
    eventCount: number;
  }> {
    const goalId = this.state.activeGoalId;
    const goal = goalId ? this.state.goals.get(goalId) : undefined;
    const progress = goalId ? this.state.progress.get(goalId) : undefined;
    return {
      goal,
      agents: [...this.state.agents.values()].map((r) => ({
        id: r.definition.id,
        role: r.definition.role,
        lifecycle: r.state.lifecycle,
        mailbox: this.state.unread.get(r.definition.id)?.length ?? 0,
        tokens: r.state.tokensConsumed,
        taskId: r.state.activeTaskId ?? null,
        activations: r.state.activations,
      })),
      budgets: this.deps.budget.snapshot(),
      progress: progress ? { completed: progress.completed, total: progress.total, ratio: progress.ratio } : null,
      openEscalations: [...this.state.escalations.values()].filter((e) => e.status === "OPEN"),
      eventCount: this.state.eventCount,
    };
  }
}

export class RuntimeFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeFailure";
  }
}

/**
 * High-volume turn bookkeeping: deliveries, budget ledger moves, and routine
 * lifecycle steps. None of these directly flips a termination/deadlock
 * verdict (those read criteria, failures, overruns, tasks, goals), so the
 * watchdog may evaluate them on the throttled path. Everything else —
 * evidence, failures, overruns, task/goal/escalation changes — scans
 * immediately, preserving the old per-event timing guarantees.
 */
/**
 * Did the mesh actually MOVE? These are the events that mean a human or an
 * agent introduced something new — as opposed to the mesh narrating its own
 * idling. Only these reset quiescence, so a rested mesh wakes for real work
 * and stays quiet for its own heartbeat.
 */
function isProgressEvent(type: EventType): boolean {
  switch (type) {
    case "message.sent":
    case "artifact.created":
    case "artifact.versioned":
    case "task.created":
    case "task.claimed":
    case "task.completed":
    case "decision.proposed":
    case "escalation.requested":
    case "goal.created":
    case "goal.resumed":
    case "goal.reopened":
      return true;
    default:
      return false;
  }
}

function isBookkeepingEvent(type: EventType): boolean {
  switch (type) {
    case "message.delivered":
    case "budget.reserved":
    case "budget.released":
    case "budget.consumed":
    case "agent.state_changed":
      return true;
    default:
      return false;
  }
}

/**
 * Extract the stuck request from a `stale­mate:unanswered_request` escalation.
 * Prefers the structured detail, falls back to parsing
 * `conflictKey: stuck:<messageId>:<agentId>`.
 */
/**
 * The single place that decides whether an escalation is a real human
 * question (`primary`) or a watchdog-computed summary over other escalations
 * (`derived`). Keeping this in one function is what stops the two kinds from
 * drifting apart again: everything downstream (dedupe identity, reconcile,
 * dashboard rendering) asks this, rather than re-testing
 * `reason === "stalemate" && raisedBy === "termination-manager"` by hand.
 */
export function classifyEscalation(reason: string, raisedBy: string): EscalationKind {
  return reason === "stalemate" && raisedBy === "termination-manager" ? "derived" : "primary";
}

/** True for an escalation record, tolerating logs written before `kind`. */
export function isDerivedEscalation(esc: Escalation): boolean {
  return (esc.kind ?? classifyEscalation(esc.reason, esc.raisedBy)) === "derived";
}

/**
 * Primary ids a derived card summarizes. Reads the explicit `supports` field
 * and falls back to the legacy `detail.openDeadlockEscalations` shape so
 * cards already on disk keep reconciling after an upgrade.
 */
export function supportsOf(esc: Escalation): string[] {
  if (Array.isArray(esc.supports)) return esc.supports.filter((id): id is string => typeof id === "string");
  const legacy = ((esc.detail ?? {}) as { openDeadlockEscalations?: Array<{ id?: string }> }).openDeadlockEscalations;
  return Array.isArray(legacy) ? legacy.map((o) => o?.id).filter((id): id is string => typeof id === "string") : [];
}

function stuckRequestOf(esc: Escalation): { messageId: string; agentId: string } | null {
  const d = (esc.detail ?? {}) as Record<string, unknown>;
  if (typeof d.requestMessageId === "string" && typeof d.agentId === "string") {
    return { messageId: d.requestMessageId, agentId: d.agentId };
  }
  const m = /^stuck:(.+):([^:]+)$/.exec(String(esc.conflictKey ?? ""));
  if (m) return { messageId: m[1], agentId: m[2] };
  return null;
}

function describeReason(reason: ActivationReason): string {
  switch (reason.kind) {
    case "startup":
      // The note is the kickoff brief (goLive embeds the criteria gap here);
      // dropping it hid the "why" from the very first turn.
      return `Startup activation: begin your mission role.${reason.note ? ` ${reason.note}` : ""}`;
    case "message":
      return `New mail arrived${reason.threadId ? ` in thread ${reason.threadId}` : ""}.`;
    case "interest_event":
      return `Event matched your declared interests: ${reason.eventType ?? "unknown"} (event ${reason.eventId}).`;
    case "manual":
      return `Manual activation: ${reason.note ?? "no note"}`;
    case "recovery":
      return `Recovery activation: ${reason.note ?? "state restored from event log"}`;
    case "timer":
      return `Timeout wakeup: ${reason.note ?? "you have been waiting; decide whether to follow up or close the loop"}`;
    default:
      return "Activation.";
  }
}
