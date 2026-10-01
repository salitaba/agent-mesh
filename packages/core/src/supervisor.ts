import * as fs from "fs";
import * as path from "path";
import {
  PROTOCOL_VERSION,
  digestOf,
  ARTIFACT_TYPES,
  INITIAL_ARTIFACT_STATUS,
  MACHINE_TRANSITIONS,
  artifactMachineOf,
  validateMessage,
  validateArtifact,
  CAPABILITY_TOKENS,
  IMPLEMENTATION_GATE_MARKER,
  normalizeCapability,
  effectiveHardActions,
  PLAN_GATE_PREFIX,
  MAX_PLAN_STEPS,
  MAX_PLAN_STEP_CHARS,
  type AgentPlan,
  type PlanStep,
  type PlanStepInput,
  type PlanStepStatus,
  type AcceptanceCriterion,
  type WorktreeStamp,
  type AgentDefinition,
  type AgentInput,
  type AgentOutput,
  type AgentRuntime,
  type AgentRuntimeStatus,
  type Artifact,
  type ArtifactEdit,
  type ArtifactRef,
  type ArtifactScope,
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
  type MeshOpWithdraw,
  type MessageType,
  type ReplayState,
  type RuntimeContext,
  type SendResult,
  type SubAgentResult,
  type Task,
  type Thread,
  type ActivationReason,
  type AgentContextBundle,
  type ApprovalKind,
  type BudgetHint,
  type PolicyDecisionResult,
  type TrustSource,
  type ContinuityRecord,
  type MeshOpWriteContinuity,
  type RotationPendingInfo,
  type SessionRotationPending,
  AUTO_EVIDENCED_CRITERIA,
  DEFAULT_CRITERIA,
  VERIFICATION_ARTIFACT_TYPES,
  InterruptedTurnError,
  LIFECYCLE_TRANSITIONS,
  type TimerHandle,
  type Timers,
  timersOf,
} from "../../protocol/src/index";
import { newArtifactId, newDecisionId, newEscalationId, newGoalId, newLeaseId, newMessageId, newTaskId, newThreadId, shortHash } from "../../protocol/src/index";
import { BACKEND_CRASH_HINT, BackendUnreachableError, classifyProviderOutage, isConnectionError, isTimeoutError, type ProviderOutage } from "../../protocol/src/index";
import { ARTIFACT_SCOPES, EDIT_CAPABILITIES } from "../../protocol/src/index";
import { isSettledArtifactStatus } from "../../protocol/src/index";
import { episodeOf, refusedToolCalls, toolAlternative } from "../../protocol/src/index";
import { BUILTIN_CONTRACTS, CODE_ARTIFACT_TRANSITIONS, findContract, isObligingType, movesWorkMessage, obligesRecipients, unknownContractReason } from "../../protocol/src/index";
import { validateContractRequest } from "../../protocol/src/validation";
import type { Contract, DefaultAnswer, MeshOpCall, MeshOpContracts } from "../../protocol/src/index";
import { collectAgentOutput } from "../../agent-runtime/src/index";
import { approvalPath, planCoversHardOp, verdictAdvances } from "./projections-helpers";
import { sanitizeAgentMessageInput } from "../../protocol/src/index";
import type { MessageControl, CollabSession, DeliveryClass } from "../../protocol/src/index";
import { MAX_CONTINUITY_BELIEFS, MAX_CONTINUITY_COMMITMENTS, MAX_CONTINUITY_REJECTIONS, MAX_CONTINUITY_TEXT } from "./state";
import { artifactKey, approvalKey, ensureBudget, INFERRED_DISCHARGE_REASONS, MAX_PENDING_REQUESTS, outstandingDebtors, overdueCommitments, PER_DEBTOR_DISCHARGE_REASONS, readableMailDepth, stillOwes, UNANSWERED_DISCHARGE_REASONS } from "./state";
import type { DischargeReason, Projections } from "./state";
import { applyEvent, approverMayAdvance, artifactForRef, capabilityForReview, checkApprovals, domainOfSubject, givesPassForApprove, hasPeerReviewerFor, holdsAuthority, mayAcceptCriteria, mayReviewArtifact, openRejections, projectionConfigFor, settlersOf, standingBlocks, transitionLifecycle, unqualifiedAuthor, type StandingBlock } from "./projections";
import { pageCut } from "./text-page";
import { extractPatchFiles, safeProductPath, type PatchFile } from "./patch-files";
import { mintSeatToken } from "./seat-token";
import { commitRefError } from "./commit-ref";
import { staleTaskPins, unmetTaskDependencies } from "./projections-helpers";
import type { Kernel } from "./kernel";
import { KernelRejectedError } from "./kernel";
import type { BudgetManager, BudgetKey } from "./budgets";
import {
  agentKey,
  attentionKey,
  autoRaiseExhausted,
  configuredBudgetLimit,
  interruptSurcharge,
  missionKey,
  taskKey,
  threadKey,
  TURN_RESERVE_TOKENS,
} from "./budgets";
import { billedTurnTokens, budgetParkedSeats, missionCapWarnings, onFinalBudgetRung } from "./budgets";
import type {
  ArtifactContentStore,
  CriteriaGeneratorPort,
  PolicyContext,
  PolicyEvaluator,
  ProviderBreakerSnapshot,
  ProviderBreakerTransition,
  RuntimeResolver,
  SchedulerActivationRequest,
  SchedulerPort,
  SessionRegistryPort,
  SupervisorHooks,
  WorkspacePort,
} from "./ports";
import type { ResolvedMeshConfig } from "../../config/src/index";
import { interestMatches, loadRolePrompt } from "../../config/src/index";
import { buildAgentContext, buildContextManifest, handoverBundle, renderContextInstructions, renderableMail } from "./context";
import type { ContextLimits } from "./context";
import { criteriaWouldComplete, criterionSatisfied, DeadlockDetector, TerminationManager, type DeadlockFinding } from "./termination";
import { refToString, artifactUri, parseArtifactUri } from "../../protocol/src/uri";
import { isEvidenceRead, isMeshToolCall, settleContinuityCalls, traceToolCalls } from "./turn-tracker";
import { TurnTracker, RECENT_TURNS_MAX, MAX_DELIVERED_PER_TURN, describeError, ABNORMAL_TURN_ENDINGS, abnormalTurnNote, workerBudgetFor, READ_RESULT_OPS, type TurnRecord, type TurnPhaseName, type TurnTrackerPersist } from "./turn-tracker";
import { DATA_RESULT_OPS, newTurnEffectTally, noteTurnEffect, summarizeTurnEffects, type TurnEffectTally, type UnfinishedTurnFacts } from "./turn-tracker";
import { MAX_FILES_TOUCHED, type TurnCheckpoint } from "./turn-tracker";
import { TurnTimeoutError, type TurnUsage } from "../../protocol/src/index";
import {
  MISSION_HALTED_ALLOW_OPS,
  MISSION_OVER_ALLOW_OPS,
  HANDOVER_ALLOW_OPS,
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
  /**
   * Turns `mesh.goal` into acceptance criteria for missions that declare none.
   * Absent, or disabled by `mesh.generate_acceptance_criteria`, leaves the
   * mission on `DEFAULT_CRITERIA`.
   */
  criteriaGenerator?: CriteriaGeneratorPort;
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
  /** Set by the collab ops: the thread the session owns. */
  threadId?: string;
  reason?: string;
  /** On an accepted op: `reason` is a caveat on how it went, not data the op produced. */
  caveat?: boolean;
  artifact?: Artifact;
  escalationId?: string;
  /**
   * Set when the sender asked for a wake it could not pay for, so the message
   * was reclassified to `deliver`. The send SUCCEEDED -- `ok` is true and the
   * mail landed -- but the seat asked for an interrupt and did not get one,
   * and a seat that cannot tell those apart will read silence as a delivery
   * failure and send the same thing again, at the same price it cannot pay.
   * The string is the reason, phrased for the sender.
   */
  deliveryDowngraded?: string;
  /**
   * Set when a `send` was held for the turn-end digest instead of going out as
   * itself. `ok` is true and the content still reaches every recipient this
   * turn ends -- but there is no `messageId` yet, and a seat that reads the
   * missing id as a failed send would write the same thing again. Only
   * FYI-class mail is held; see `SendResult.merged`.
   */
  merged?: boolean;
  /**
   * Set on a `read_artifact` that returned only a slice. An agent that cannot
   * tell a partial document from a whole one will reason confidently over the
   * half it got, so truncation is reported as data rather than left for the
   * model to infer from a sentence stopping mid-word.
   */
  truncated?: boolean;
  nextOffset?: number;
  totalChars?: number;
  /** Set by the `contracts` op: what this seat may ask for, and of whom. */
  contracts?: ContractListing[];
}

/**
 * What `opMerge` puts on the MERGED `artifact.transition`: the proof a merge
 * ran. `git` names the product-branch commit that holds the patch (the new
 * merge commit, or HEAD when its recorded commit was already an ancestor);
 * `materialize` is the no-git mesh, where writing the files IS the merge. The
 * artifact reducer refuses a live MERGED emit without one of these.
 */
export type MergeProof =
  | { via: "git"; commit: string; alreadyUpToDate?: boolean }
  | { via: "materialize"; files: string };

/** `commitWorktree`'s `diffDigest` for an empty diff: sha256 of "". */
const EMPTY_DIFF_DIGEST = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** One row of `mesh.contracts` — a contract plus who can currently answer it. */
export interface ContractListing {
  name: string;
  version: number;
  summary: string;
  request: Record<string, unknown>;
  refusals: string[];
  slaMs?: number;
  requiresCapability?: string;
  providers: string[];
}

/**
 * The contract stamp for a desugared op, as runtime-owned envelope control.
 *
 * Two things changed here and both are load-bearing. It returns `control`
 * rather than payload keys, so the commitment ledger routes on the envelope
 * and never on verbatim agent input; and it resolves the name against the
 * catalogue first, so a stamp that reaches a message is always a real
 * contract. An unresolvable name yields nothing rather than a stamp the
 * reducer will look up and silently drop -- same outcome, stated at the edge.
 */
function askControl(op: { contract?: string; contractVersion?: number; ifUnanswered?: DefaultAnswer }): MessageControl | undefined {
  const stamp = op.contract && findContract(op.contract)
    ? { contract: op.contract, contractVersion: op.contractVersion }
    : undefined;
  // The asker's fallback rides the same envelope band for the same reason the
  // contract does -- the ledger reads it, twice, and a decision about
  // obligations must not be readable out of verbatim agent input. It is
  // carried INDEPENDENTLY of the stamp because a default is not a contract
  // feature: a raw `send` to a named seat is exactly the ask most likely to
  // deserve one, and gating it on a contract would put the low-contact move
  // out of reach of the channel that needs it most.
  const assume = op.ifUnanswered ? { ifUnanswered: op.ifUnanswered } : undefined;
  if (!stamp && !assume) return undefined;
  return { ...stamp, ...assume };
}

/** Accept `to` as a string or a list of them; anything else is not a recipient. */
function asIdList(v: unknown): string[] | undefined {
  if (typeof v === "string" && v.trim()) return [v.trim()];
  if (Array.isArray(v)) {
    const ids = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
    return ids.length > 0 ? ids : undefined;
  }
  return undefined;
}

/** A thread subject when the caller did not write one. */
function firstWords(request: Record<string, unknown>): string {
  for (const key of ["ask", "question", "what", "claim", "reason"]) {
    const v = request[key];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 70);
  }
  return "request";
}

export const HUMAN_AGENT_ID = "human";

/**
 * Actor for the recovery manager's own decisions.
 *
 * `HUMAN_AGENT_ID` is the kernel's convenient default for anything with no agent
 * in scope, and using it here made the log claim an operator had intervened when
 * nobody had: measured 2026-09-24, a seat whose turn timed out was restarted
 * twice and both restarts were recorded as `actorId: "human"`, alongside two
 * worker spawns and their task claims. "What did the operator actually do?" then
 * cannot be answered from the log — and `human` is also the identity that carries
 * full mutating authority over the MCP bridge, so the overload is not cosmetic.
 *
 * The codebase already has the right convention elsewhere — `budget.limit_raised`
 * emits as `system`, `deadlock.auto_resolved` as `deadlock-detector` — and this
 * matches the `raisedBy` label the recovery manager already uses on its own
 * advisory escalations.
 *
 * NOTE: only the recovery and delegation paths are corrected. Boot-time emits
 * (`goal.created`, the initial `agent.created` sweep, `agent.replaced`) still use
 * `HUMAN_AGENT_ID` and arguably should — an operator did start the mission — so
 * the remaining ~15 sites are deliberately left for a separate audit rather than
 * swept blind.
 */
export const RECOVERY_ACTOR_ID = "recovery-manager";

/**
 * Actor for the verdicts the watchdog reaches on its own: `goal.completed`,
 * `goal.escalated`, `goal.failed`, and the sweep that retires the seats when the
 * mission ends.
 *
 * Same overload, same fix as `RECOVERY_ACTOR_ID`. The termination manager is the
 * runtime, and recording its verdict as `actorId: "human"` made the log say an
 * operator had ended the mission: in the cronlite run all 12 events attributed to
 * `human` were ones nobody had performed (11 `requirement.satisfied`, which a seat
 * had claimed, and the `goal.completed` the watchdog reached). A genuine operator
 * verdict, `reopenGoal` and the escalation answer, still says `human`.
 */
export const TERMINATION_ACTOR_ID = "termination-manager";

// Moved to `protocol/src/catalog.ts`, next to `AUTO_EVIDENCED_CRITERIA`, which
// it has to be read against: `packages/config` warns when a mandatory criterion
// is in this list and not in that one, and config cannot import core. Re-exported
// here so every existing importer (and `tests/core/criteria.test.ts`) is unmoved.
// (imported at the top of this file so it is in local scope here too — a bare
// `export … from` re-export does not bind the name for this module's own use.)
export { DEFAULT_CRITERIA };

// `TURN_RESERVE_TOKENS` moved to ./budgets, where `autoRaiseExhausted` has to
// reproduce `tryAutoRaise`'s arithmetic exactly. Two copies of it would be the
// drift that makes the termination verdict and the auto-raise sweep disagree.

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
 * How many of a seat's most recent settled turns boot folds back into its cost
 * estimate (`reseedTurnCostEstimates`). At alpha 0.3 the oldest of 20 carries
 * 0.7^19, about 0.1% of the weight, so replaying further buys only boot time.
 */
const TURN_COST_REPLAY_TURNS = 20;

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
/**
 * How many consecutive stall nudges may buy nothing before the watchdog stops
 * nudging and asks a human instead (see `checkStall`).
 *
 * Module-local, deliberately, exactly like the scheduler's own `MAX_NUDGES`:
 * this is the SHAPE of the failure, not a knob. An operator tuning it would be
 * choosing how much budget to spend re-proving a mission is stuck, which is not
 * a choice worth offering — and a config key would have to be read, defaulted,
 * documented and replayed for a number whose only sane value is "a few".
 */
const MAX_STALL_NUDGES = 3;

/**
 * How many idle windows a HALTED mission may sit in before the watchdog decides
 * nobody is coming.
 *
 * Derived from `stallIdleMs` rather than configured, for the same reason as
 * `MAX_STALL_NUDGES`: this is the shape of the failure, not a knob. Five windows
 * because the answer being waited for is a human's, and a human is allowed to
 * take several minutes — a live mission sat 3h04m, so anything in this range is
 * an improvement and the generous end costs nothing.
 */
const HALT_NEGLECT_IDLE_MULTIPLE = 5;

/**
 * How much longer a turn holding a claimed task may take than a coordination one.
 *
 * Not a knob, for the same reason as the constants above: an operator tuning this
 * would be choosing how much finished work to throw away. Three because the
 * observed spread is roughly that — coordination turns land at one to three
 * minutes, a turn that builds something at fourteen to twenty — so a 10-minute
 * default becomes 30 for the seat the mission is blocked on, and a 20-minute one
 * becomes an hour.
 */
export const WORK_TURN_TIMEOUT_MULTIPLE = 3;
/**
 * How long the first live wake is held for a bridge-readiness probe the server
 * supplied, before the mesh starts anyway.
 *
 * Measured 2026-09-27 on the live mission: a child restart's mesh MCP bridge
 * stayed unreachable for more than 35 seconds, and a seat woken in that window
 * had its turn aborted at `init` ("the mesh MCP bridge is status "failed"").
 * The adapter's own ladder (5 fresh spawns, 30s) was already sized for this and
 * was spent before the bridge attached, so the fix is to not wake anyone until
 * the bridge is up — not a wider timer.
 *
 * The bound exists because a mesh whose bridge genuinely never comes up must
 * still start and say so: past this the wait is abandoned, the audit line says
 * it was, and a seat woken then is told by the runtime what it is told today.
 * A minute is longer than any observed attach and short enough that a wedged
 * start is visible to an operator rather than indistinguishable from a hang.
 */
export const BRIDGE_READY_TIMEOUT_MS = 60_000;
/**
 * How long a timed-out turn waits for its own abort to come back with usage.
 *
 * The CLI answers a mesh-ordered interrupt with a `result` frame carrying real
 * token counts. Rejecting the instant the timer fires always beat that frame, so
 * the most expensive turns in a run — the ones that ran the full timeout — were
 * recorded as costing nothing. Two seconds is long enough for a frame already in
 * flight and short enough that a backend which never answers still ends the turn
 * promptly.
 */
const TURN_TIMEOUT_USAGE_GRACE_MS = 2000;
/**
 * Bounds on the TRACE COPY of a turn — what the Steps drawer and the audit
 * mirror retain. Named `MAX_TRACE_*` rather than `MAX_TURN_*` because the old
 * names read, in every grep, as if they bounded the prompt: they are applied to
 * the copy handed to `pushTurn`, never to the `instructions` that actually go
 * out over `runtime.send`. The real prompt guard is
 * `INSTRUCTIONS_SOFT_CAP_TOKENS` below.
 */
const MAX_TRACE_TEXT_CHARS = 20000;
const MAX_TRACE_INSTRUCTIONS_CHARS = 8000;
// Tool calls are bounded by `traceToolCalls` (turn-tracker.ts): 30 non-mesh
// plus 120 mesh calls, every string argument clipped.
/** Accepted-with-caveat ops listed one per entry in `TurnRecord.notices`; the rest are counted. */
const MAX_CAVEAT_NOTICES = 12;

/**
 * Characters per token, for converting a built prompt into the unit every
 * budget in this system is denominated in.
 *
 * A real tokenizer was considered and rejected, not skipped. Anthropic's
 * tokenizer is not published, so every JS option (`tiktoken`, `gpt-tokenizer`)
 * is a *different* model's BPE — it would add a dependency and a per-turn cost
 * to buy 10-25% precision that is not actually precision, just a confident
 * number from the wrong vocabulary.
 *
 * 3.5 rather than the ~4 that English prose averages, because the error is not
 * symmetric. Under-stating chars/token over-states tokens, which takes a
 * slightly larger hold and trims slightly sooner; over-stating it admits a turn
 * the ledger cannot actually afford. Bias toward the harmless side.
 */
const CHARS_PER_TOKEN = 3.5;

/** Estimated tokens for a rendered prompt. Deliberately an estimate — see `CHARS_PER_TOKEN`. */
export function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN);
}

/**
 * What to do when a turn's deadline expires: extend it, or stop the turn.
 *
 * Decided AT expiry, from facts true at that moment. The deadline used to be
 * fixed before the runtime call, so a seat that claimed its task mid-turn never
 * got the work-turn multiple: measured 2026-09-25, backend claimed its task 80 s
 * into a turn, was killed at 1x while writing files — 242 tool frames, the last
 * one 5 s before the kill — and 21 files (~5.6k lines) were left untracked
 * (`NOTES-live-run-20260925-2040.md` §3).
 *
 * Two reasons to extend, one ceiling:
 *
 *  - the seat now holds a task: extend to the work-turn budget, which is what it
 *    would have had if the claim had landed before the call;
 *  - the turn produced a frame within `windowMs`: extend by `windowMs`, and ask
 *    again then. A turn still writing is working; one gone quiet is not.
 *
 * The ceiling is `baseMs * WORK_TURN_TIMEOUT_MULTIPLE` for EVERY turn — the
 * longest the mesh already budgets for the seat it is blocked on. So a task
 * holder is never extended past the budget it had always been given, and a
 * wedged-but-chatty turn (a tool loop that never converges) still dies there
 * rather than running until the ledger stops it: every frame it emits is
 * billed, and past the work budget "still producing frames" no longer
 * distinguishes working from looping.
 *
 * Pure and exported so each boundary can be asserted without a mesh.
 */
export function turnDeadlineExtension(opts: {
  elapsedMs: number;
  baseMs: number;
  holdsTask: boolean;
  /** ms since the turn's last token or tool frame; undefined if it never produced one. */
  sinceActivityMs: number | undefined;
  windowMs: number;
}): { extendMs: number; why: "task" | "activity" } | null {
  const remaining = opts.baseMs * WORK_TURN_TIMEOUT_MULTIPLE - opts.elapsedMs;
  if (remaining <= 0) return null;
  if (opts.holdsTask) return { extendMs: remaining, why: "task" };
  if (opts.sinceActivityMs !== undefined && opts.sinceActivityMs <= opts.windowMs) {
    return { extendMs: Math.min(opts.windowMs, remaining), why: "activity" };
  }
  return null;
}

/**
 * The longest lead the "hard stop" advisory gets before the ceiling. Capped
 * rather than equal to the extension window: a seat needs a few minutes to
 * commit and close, and a longer warning only means it stops working sooner.
 */
const TURN_FINAL_ADVISORY_MAX_MS = 5 * 60_000;
/**
 * How long a stopped turn's worktree snapshot may take before the failure path
 * gives up on it. A snapshot is `git add` into a scratch index plus a
 * `commit-tree` — seconds on a large worktree — and the turn's failure handling
 * waits on it, so it must be bounded; a slow git costs the snapshot, never the
 * turn's bookkeeping.
 */
const TURN_CHECKPOINT_TIMEOUT_MS = 15_000;
/**
 * How long an operator stop gives the runtime to answer its interrupt before
 * settling the call itself. The budget stop's figure, for the budget stop's
 * reason: the abort's `result` frame carries the turn's usage, and it arrives in
 * milliseconds when it arrives at all.
 */
const OPERATOR_STOP_GRACE_MS = 2000;
/**
 * How long `interruptTurn` waits for the stopped turn to finish closing: the
 * grace above, the dirty-worktree snapshot the failure path may take, and room
 * for the bookkeeping around them. Past it the caller is told the stop is still
 * settling; the turn still ends, and a requested suspension still applies.
 */
const OPERATOR_STOP_WAIT_MS = OPERATOR_STOP_GRACE_MS + TURN_CHECKPOINT_TIMEOUT_MS + 3000;

/**
 * What a seat is allowed to take, at minimum, to answer an ask once it is awake: one
 * turn. Measured on the cronlite run, whose seat turns took 30 to 120 seconds; the
 * PM's answer to the ask that defaulted early arrived 90 s after it was raised.
 */
const ANSWER_TURN_ALLOWANCE_MS = 120_000;

/** An operator's stop of one running turn, while that turn closes. See `Supervisor.interruptTurn`. */
interface OperatorStop {
  /** The operator's words, if any. Rides `turn.discarded.detail` and the seat's note. */
  reason?: string;
  /** Leave the seat SUSPENDED once the turn has ended, rather than IDLE. */
  suspend: boolean;
  /**
   * The runtime never answered the interrupt and the supervisor settled the
   * call itself. The session is dropped then: nothing confirmed the backend
   * stopped, so it may still be busy with the old turn.
   */
  forced: boolean;
  /** How the turn actually ended: its discard reason, or "completed" when the stop came too late to matter. */
  endedAs?: string;
}

/** `turn.discarded.detail` for an operator stop. */
function operatorStopDetail(stop: Pick<OperatorStop, "reason" | "suspend">): string {
  return `stopped by the operator${stop.reason ? `: ${stop.reason}` : ""}${stop.suspend ? " (seat suspended)" : ""}`;
}

/**
 * The discard detail and close note of a turn `shutdown()` stopped; `error` is
 * what the stopped call threw.
 *
 * The crash hint is taken off whatever runtime threw it: a shutdown is the
 * mesh's own doing, and "the server process may have crashed — check that it is
 * still running" on a normal end of mission sent the operator looking for a
 * failure that never happened (cronlite 2026-09-30). `missionOver` says the stop
 * was the mission ending, not an interruption of one.
 */
function shutdownStopDetail(error: string, missionOver: boolean): string {
  const cause = error.split(BACKEND_CRASH_HINT).join("");
  return `stopped by the mesh shutting down${missionOver ? " after the mission ended" : ""} (${cause})`;
}

/** What `Supervisor.interruptTurn` did. */
export type InterruptTurnResult =
  | {
      ok: true;
      turnId: string;
      /** False when the turn was still closing after `OPERATOR_STOP_WAIT_MS`; it ends on its own, and a suspension still applies. */
      settled: boolean;
      /** `interrupted` when the stop ended it; another discard reason or `completed` when the turn finished before the stop reached it. */
      endedAs?: string;
      /** The seat's lifecycle when the call returned. */
      lifecycle?: LifecycleState;
    }
  | { ok: false; code: "unknown_agent" | "no_running_turn"; error: string; lifecycle?: LifecycleState };

/**
 * The part of a git workspace that can say whether a reference names a commit.
 * `GitWorkspace` has it; `WorkspacePort` does not declare it (yet), so it is read
 * structurally and a workspace without it — the test doubles — is asked nothing.
 */
type CommitResolver = { resolveCommit?(ref: string): Promise<string | null> };

/** A span a seat reads: minutes once it is at least one, seconds below that. */
export function formatTurnSpan(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.max(1, Math.round(ms / 1000))} s`;
}

/**
 * The note put in front of a seat when its turn crosses the base budget
 * (`budget`) and shortly before the hard stop (`final`).
 *
 * A timed-out turn used to be a hard abort the model never saw coming: a live
 * backend turn wrote 37 files over 94 tool calls, was still working 17 s before
 * the kill, and committed none of them, because nothing had ever told it the
 * clock existed. Imperative and short, because it lands between two tool calls
 * of a turn that is busy doing something else. Names the tools a seat really
 * has (`mesh_commit`, `mesh_done`), and prescribes a commit only to a seat that
 * may issue one. Pure and exported so the wording can be asserted.
 */
export function turnAdvisoryText(kind: "budget" | "final", opts: { baseMs: number; remainingMs: number; canCommit: boolean }): string {
  if (kind === "budget") {
    return (
      `⏱ Turn budget reached (${formatTurnSpan(opts.baseMs)}). You get more time only while you keep working — hard stop in ${formatTurnSpan(opts.remainingMs)}. ` +
      (opts.canCommit
        ? "Finish the chunk in hand, commit it (`mesh_commit`), publish what is ready, and end the turn with `mesh_done` saying what remains; continue next turn."
        : "Finish the step in hand, publish what is ready, and end the turn with `mesh_done` saying what remains; continue next turn.")
    );
  }
  return (
    `⚠ Hard stop in ${formatTurnSpan(opts.remainingMs)}. ` +
    (opts.canCommit
      ? "Commit what you have now (`mesh_commit`) and close with `mesh_done`; anything uncommitted is left in your worktree for your next turn."
      : "Publish what is ready now and close with `mesh_done` saying what remains.")
  );
}

/**
 * The per-turn paragraph that tells a file-writing seat how long it has and how
 * to spend it: in committed increments, not one turn-long build.
 *
 * Only for seats that can edit files (the `EDIT_CAPABILITIES` test that gives a
 * seat its worktree); a coordination seat's turns are minutes long and have
 * nothing to commit. ~80 tokens, rendered outside the tiered bundle so no tier
 * drops it. Pure and exported so the wording can be asserted.
 */
export function turnBudgetGuidance(opts: { baseMs: number; canCommit: boolean }): string {
  const chunk = opts.canCommit ? "commit it (`mesh_commit`) and publish" : "publish it";
  return (
    `You have ${formatTurnSpan(opts.baseMs)} per turn, extended only while you keep working, to a hard stop at ${formatTurnSpan(opts.baseMs * WORK_TURN_TIMEOUT_MULTIPLE)}. ` +
    `Build in increments: after each coherent chunk (a module and its tests) ${chunk}, then continue — don't scaffold a whole project in one turn. ` +
    `When a ⏱ note arrives, ${opts.canCommit ? "commit" : "publish"} and close with \`mesh_done\`.`
  );
}

/**
 * Soft ceiling on the assembled per-turn prompt, in estimated tokens.
 *
 * This is the only check that measures what is actually about to be sent. Every
 * other bound in the context bundle is an ITEM count, which is a proxy for size
 * and a weak one.
 *
 * Tokens rather than chars so it is comparable with the ledgers it shares a
 * turn with: the same number is used below to top up the pre-flight hold, and a
 * cap denominated in chars could not have been.
 *
 * Overflow REBUILDS the bundle smaller — it never truncates the string. The ops
 * contract and the output-voice rules render LAST, so a hard slice would cut
 * off exactly the part telling the agent how to reply, turning an oversized
 * prompt into a malformed one.
 */
const INSTRUCTIONS_SOFT_CAP_TOKENS = 9000;

/**
 * Ceiling on a single `read_artifact`, in characters.
 *
 * Generous on purpose: an agent asking for a document should usually get the
 * document, and paging a design doc across four turns costs more than sending
 * it once. This exists for the pathological case — a giant generated file, a
 * log, a patch — not to make reading artifacts feel rationed.
 */
const ARTIFACT_READ_MAX_CHARS = 60000;

/**
 * Ceiling on an inline `publish_artifact` body, in characters.
 *
 * Deliberately below {@link ARTIFACT_READ_MAX_CHARS}: anything a seat can
 * publish in one inline call, a reader can get back in one un-paged read. The
 * asymmetry that existed before — 60k in, unbounded out — was the wrong way
 * round, because the unbounded side is the one billed at output rates.
 *
 * Over the limit the publish is refused, never truncated, and the refusal names
 * `fromPath` and `edits`. A big document is not the problem; re-typing one
 * through the model is.
 */
const ARTIFACT_PUBLISH_MAX_CHARS = 48000;

/**
 * Ceiling on a `fromPath` publish, in bytes.
 *
 * Higher than the inline cap because these bytes cost nothing to publish — the
 * runtime reads the file — but not unbounded, because they still have to be
 * readable afterwards, and `read_artifact` pages at 60k a turn.
 */
const ARTIFACT_PUBLISH_MAX_BYTES = 2_000_000;

/**
 * The two degradation tiers, shared by the thread-budget path and the
 * instructions soft cap so both shrink a turn the same way.
 */
/**
 * Floor tier. Reached only when `tight` still renders over the soft cap, which
 * before this existed simply logged and sent the oversized prompt anyway.
 *
 * `maxUnread: 2` rather than 1 on purpose: every other section is recoverable
 * from state next turn, but mail that is never shown is mail the agent does not
 * know it was sent. The context builder clamps each field to at least 1, so no
 * section can be removed outright here — this is the smallest a turn can get.
 */
const CONTEXT_LIMITS_MINIMAL: ContextLimits = {
  maxUnread: 2, maxDecisions: 1, maxArtifactRefs: 1, maxActivity: 1, maxOutstanding: 1, maxMemory: 1, maxRefusals: 1,
};

const CONTEXT_LIMITS_TIGHT: ContextLimits = {
  maxUnread: 3, maxDecisions: 3, maxArtifactRefs: 5, maxActivity: 4, maxOutstanding: 3, maxMemory: 5, maxRefusals: 2,
};
const CONTEXT_LIMITS_REDUCED: ContextLimits = {
  maxUnread: 6, maxDecisions: 5, maxArtifactRefs: 10, maxActivity: 7, maxOutstanding: 5, maxMemory: 10, maxRefusals: 3,
};

/** Ordered widest-to-narrowest. The soft cap walks this and stops at the first tier that fits. */
export const CONTEXT_TIER_LADDER: ContextLimits[] = [CONTEXT_LIMITS_REDUCED, CONTEXT_LIMITS_TIGHT, CONTEXT_LIMITS_MINIMAL];

/**
 * Name the rung, as a closed union rather than a string.
 *
 * The narrow return type is load-bearing now that `context.assembled` carries
 * the tier: a new rung added to the ladder without a name here becomes a
 * compile error at the emit site instead of a silent "full" in the audit log.
 */
export function tierName(t: ContextLimits | undefined): "full" | "reduced" | "tight" | "minimal" {
  if (t === CONTEXT_LIMITS_MINIMAL) return "minimal";
  if (t === CONTEXT_LIMITS_TIGHT) return "tight";
  if (t === CONTEXT_LIMITS_REDUCED) return "reduced";
  return "full";
}

/**
 * Walk the tier ladder until the rendered turn fits under the soft cap.
 *
 * Extracted from the activation path rather than left inline: this is the one
 * piece of context assembly that DROPS things the agent would otherwise have
 * seen, and inline in a several-hundred-line method it could only be exercised
 * by standing up a whole mission. `rebuild` is the seam — the caller supplies
 * bundle construction, this supplies the search.
 *
 * Deliberately reports `landed: false` instead of throwing or truncating: a
 * prompt that will not shrink is still a prompt the agent can answer, and
 * slicing the string would cut the ops contract off the end (see
 * `INSTRUCTIONS_SOFT_CAP_TOKENS`).
 */
export function fitToSoftCap<T>(opts: {
  /** The already-rendered full-tier turn, and the value it came from. */
  value: T;
  render: (value: T) => string;
  /** Tier budget pressure already chose, if any. The walk starts BELOW it. */
  startTier?: ContextLimits;
  rebuild: (tier: ContextLimits) => T;
  cap?: number;
  /**
   * Spend what the landed rung leaves under the cap (see `fillTier`). Opt-in so
   * callers that only want the walk — and its one rebuild per rung — keep it.
   */
  fill?: boolean;
}): {
  value: T;
  rendered: string;
  /** The RUNG the walk landed on — `tierName` reads it by identity, so it is never a filled copy. */
  tier: ContextLimits | undefined;
  /** What `value` was actually built with: `tier`, or `tier` widened by the fill. */
  limits: ContextLimits | undefined;
  landed: boolean;
  before: number;
  after: number;
} {
  const cap = opts.cap ?? INSTRUCTIONS_SOFT_CAP_TOKENS;
  let rendered = opts.render(opts.value);
  const before = estimateTokens(rendered.length);
  if (before <= cap) {
    return { value: opts.value, rendered, tier: opts.startTier, limits: opts.startTier, landed: true, before, after: before };
  }

  // Slicing from the current tier keeps the walk monotonic: it can never
  // rebuild at a WIDER tier than the one budget pressure already picked.
  const startAt = opts.startTier ? CONTEXT_TIER_LADDER.indexOf(opts.startTier) + 1 : 0;
  let value = opts.value;
  let tier = opts.startTier;
  let after = before;
  for (const candidate of CONTEXT_TIER_LADDER.slice(Math.max(0, startAt))) {
    value = opts.rebuild(candidate);
    tier = candidate;
    rendered = opts.render(value);
    after = estimateTokens(rendered.length);
    // Stop at the FIRST tier that fits: a turn that would have been fine at
    // `reduced` should not be stripped to `minimal` for nothing.
    if (after <= cap) {
      if (!opts.fill) return { value, rendered, tier, limits: tier, landed: true, before, after };
      const filled = fillTier({ ...opts, cap, value, rendered, landedTier: candidate });
      return { ...filled, tier, landed: true, before, after: estimateTokens(filled.rendered.length) };
    }
  }
  return { value, rendered, tier, limits: tier, landed: false, before, after };
}

/**
 * The order a landed rung's slack is spent in. Owed requests first: an ask the
 * seat is not shown is one it cannot answer, and the nudge chain then chases a
 * debtor that never saw the debt (tech-lead saw 1 of the 9 it owed, NOTES
 * live-run §17). Mail next, for the reason `maxUnread` is the one field the
 * floor keeps at 2. The rest are recoverable from state on a later turn.
 */
const CONTEXT_FILL_ORDER: Array<keyof ContextLimits> = [
  "maxOutstanding",
  "maxUnread",
  "maxArtifactRefs",
  "maxMemory",
  "maxDecisions",
  "maxActivity",
  "maxRefusals",
];

/**
 * Upper bound a filled field is searched to when no budget-pressure tier caps
 * it. The builder clamps every field to its own section default (the largest is
 * 20), so asking for more renders the default — the ceiling only has to be at
 * least that, and being exactly the largest keeps the search short.
 */
const CONTEXT_FILL_CEILING = 20;

/**
 * Widen a landed rung field by field, in `CONTEXT_FILL_ORDER`, while the
 * rendered turn stays under the cap.
 *
 * A rung is a floor to fall back to, not a size to stop at. Measured
 * 2026-09-25: the `minimal` rung carried 17 of 52 contexts at one artifact and
 * one outstanding request each, with ~1.3k of its 9k token budget unused. The
 * cap is still the bound: every candidate is rendered and measured, and one that
 * does not fit is discarded — never truncated.
 *
 * The ceiling per field is the tier budget pressure chose, when it chose one:
 * that tier is the thread ledger saying how big this turn may be, and the soft
 * cap is a second, independent limit — filling to the cap past it would undo the
 * ledger's decision.
 *
 * Assumes a rendered turn never shrinks as a field grows (more items, more
 * text), so each field is a bisection: the ceiling first — one probe settles a
 * section with fewer items than its ceiling — then one step, then the search.
 */
function fillTier<T>(opts: {
  value: T;
  rendered: string;
  render: (value: T) => string;
  rebuild: (tier: ContextLimits) => T;
  startTier?: ContextLimits;
  landedTier: ContextLimits;
  cap: number;
}): { value: T; rendered: string; limits: ContextLimits } {
  let limits: ContextLimits = { ...opts.landedTier };
  let best = { value: opts.value, rendered: opts.rendered };
  const probe = (field: keyof ContextLimits, n: number): boolean => {
    const next = { ...limits, [field]: n };
    const value = opts.rebuild(next);
    const rendered = opts.render(value);
    if (estimateTokens(rendered.length) > opts.cap) return false;
    limits = next;
    best = { value, rendered };
    return true;
  };
  for (const field of CONTEXT_FILL_ORDER) {
    const ceiling = opts.startTier?.[field] ?? CONTEXT_FILL_CEILING;
    let lo = limits[field] ?? ceiling;
    let hi = ceiling;
    if (lo >= hi) continue;
    if (probe(field, hi)) continue;
    if (!probe(field, lo + 1)) continue;
    lo += 1;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (probe(field, mid)) lo = mid;
      else hi = mid;
    }
  }
  return { value: best.value, rendered: best.rendered, limits };
}

/**
 * Raise the pre-flight hold to cover the prompt that was actually assembled.
 *
 * Extracted for the same reason as `fitToSoftCap`: inline in the activation
 * path this could only be reached by running a whole mission, and its one
 * interesting behaviour — a refused top-up must NOT kill the turn — is exactly
 * the kind that stays plausible-looking while being wrong.
 *
 * Returns shortfalls rather than logging them, so the caller owns the audit
 * voice and a test can assert on the decision instead of on a string.
 */
export async function topUpPromptHold(
  budget: Pick<BudgetManager, "reserve">,
  opts: {
    agentId: string;
    promptTokens: number;
    reserveAmount: number;
    targets: Array<{ key: BudgetKey; limit: number | null }>;
  },
): Promise<{
  topUp: number;
  reservations: Array<{ key: BudgetKey; reservationId: string }>;
  shortfalls: Array<{ key: BudgetKey; requested: number; granted: number; blocked: boolean }>;
}> {
  const topUp = opts.promptTokens - opts.reserveAmount;
  const reservations: Array<{ key: BudgetKey; reservationId: string }> = [];
  const shortfalls: Array<{ key: BudgetKey; requested: number; granted: number; blocked: boolean }> = [];
  if (topUp <= 0) return { topUp: 0, reservations, shortfalls };

  for (const { key, limit } of opts.targets) {
    // Partial allowed: the turn is already admitted, so a short top-up is
    // recorded as a shortfall rather than refused.
    const extra = await budget.reserve(key, "tokens", topUp, limit, { actorId: opts.agentId, allowPartial: true });
    // Collected even when blocked: a partial grant still consumed headroom, and
    // dropping the id would leak the reservation past settlement.
    if (extra.reservationId) reservations.push({ key, reservationId: extra.reservationId });
    if (extra.blocked || extra.granted < extra.requested) {
      shortfalls.push({ key, requested: extra.requested, granted: extra.granted, blocked: extra.blocked });
    }
  }
  return { topUp, reservations, shortfalls };
}

/**
 * Clamps on model-authored task prose, for the same reason `MAX_PLAN_STEP_CHARS`
 * clamps a plan step: a task's title rides every delegation subject line and its
 * description is re-rendered into the assignee's prompt each turn, so an
 * unbounded one is a per-turn token leak. A model that writes its whole design
 * into a task title is confused rather than thorough.
 */
const MAX_TASK_TITLE_CHARS = 160;
const MAX_TASK_DESCRIPTION_CHARS = 4000;
const MAX_TASK_SUMMARY_CHARS = 2000;

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
 * runner) can distinguish a claim from a check -- and the one mesh tool that
 * reads an artifact's content (`isEvidenceRead`), because inspecting the evidence
 * is exactly what checking a claim about it means.
 *
 * "Mesh" is decided by `isMeshToolCall`, which strips the `mcp__<server>__`
 * prefix Claude puts on every MCP tool: tested bare, `mcp__mesh__mesh_approve`
 * counted as verification, so a turn that only talked to the mesh verified
 * itself. A call that FAILED (a permission-gate denial) ran nothing and checked
 * nothing, so it does not count either. A call with no status is counted: the
 * structural runtimes (stub, http) report none, and absent means unknown.
 */
/** One tool name, against the verification gate: anything outside the mesh, or a read of an artifact. */
function countsAsChecking(name: string): boolean {
  return !isMeshToolCall(name) || isEvidenceRead(name);
}

function verificationToolCount(toolCalls: Array<{ name: string; status?: string }> | undefined): number {
  return (toolCalls ?? []).filter((t) => t.status !== "failed" && countsAsChecking(String(t.name ?? ""))).length;
}

/**
 * The turn summary an agent DECLARED, falling back to the one taken from its
 * prose.
 *
 * `output.summary` is whatever the adapter could take from the reply text —
 * usually its first line, or nothing at all. A runtime that lets the agent state its own summary is
 * authoritative and must win. Read defensively: the field is adapter-side and
 * not every runtime declares it (or has it yet), so an absent or non-string
 * value falls straight back to the scraped value rather than blanking the
 * summary.
 */
function declaredTurnSummary(output: AgentOutput): string | undefined {
  const declared = (output as { declaredSummary?: unknown }).declaredSummary;
  if (typeof declared === "string" && declared.trim()) return declared.trim();
  return output.summary;
}


/**
 * What a seat is told on the one turn it gets before its memory is taken.
 *
 * Written as an instruction rather than a notification. "Your session is being
 * rotated" is a fact about infrastructure and reads as noise; what the seat
 * needs is the shape of the record and the reason the shape matters, because
 * it is about to be the only reader-facing account of everything it knows.
 *
 * It says what NOT to include for the same reason: an agent told to hand over
 * its state writes a summary of the conversation, which is the one thing the
 * successor does not need — the projections already carry the facts, and the
 * mesh already carries the ledger. What is lost is judgement.
 *
 * The first line states the reason as a context size, which is what it now is:
 * `transcriptTokens` is the largest prompt a single model call of the rotation
 * turn was handed (`promptSize`), i.e. the transcript the window had to hold —
 * the quantity the threshold is named for. Before the adapter's measure was
 * fixed it was a turn's summed reads, and the sentence had to say so: 5,219,210
 * reported against a largest prompt of 165,129
 * (`NOTES-communication-measured-review.md` §11c).
 */
const HANDOVER_INSTRUCTION = (info: RotationPendingInfo, heldMail = 0): string =>
  [
    `Your backend session is being rotated — it is holding ${info.transcriptTokens} tokens of context, past the ${info.thresholdTokens} rotation threshold — and it will be replaced before your next turn.`,
    "Everything you are holding in your head goes with it. The mesh keeps the log, the artifacts and your open asks; it does not keep what you concluded from them.",
    // The mailbox is withheld from this turn (see `handoverBundle`); said, so
    // an empty page is not read as an empty box.
    ...(heldMail > 0
      ? [`${heldMail} unread message${heldMail === 1 ? " is" : "s are"} held for the session that replaces you: not shown here, still unread, and not yours to answer in this turn.`]
      : []),
    "",
    "Spend this turn on `write_continuity`; the turn ends once it lands (call `done` if it has not). Nothing else will be accepted.",
    "",
    "- `nextIntent`: one sentence on what you were about to do.",
    "- `beliefs`: what you worked out that is NOT already written down somewhere, each with the artifact, message or event it rests on, and marked `asserted` if you checked it or `assumed` if you merely proceeded on it.",
    "- `rejected`: anything you already proposed that was turned down, and by whom — so your successor does not propose it again.",
    "",
    "Do not summarise the conversation, and do not list your open asks: the mesh fills those in from the ledger.",
  ].join("\n");

/**
 * Priority the wake a handover consumed is put back at: above URGENT (9).
 *
 * The seat had already won a slot for that work; the mesh spent it on its own
 * bookkeeping. Re-queued at the reason's default band (3 for mail and interest
 * wakes) the successor waited behind everything that arrived meanwhile — median
 * 429 s, max 1,240 s on 2026-09-25 (NOTES-live-run-20260925-2040.md §1). Aging
 * can still lift a starved entry past it, so it resumes rather than monopolises.
 */
const HANDOVER_REQUEUE_PRIORITY = 10;

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
  /**
   * This turn exists only to write a continuity record; see `handoverTurn`.
   * Ops outside `HANDOVER_ALLOW_OPS` are refused for the reason on that set.
   */
  handover?: boolean;
  /** The summary a `done` op stated, so the turn can report it. */
  declaredSummary?: string;
}

/**
 * One message a turn sent past its per-turn budget and held for the flush.
 *
 * Every field the digest entry needs to be a faithful record of what the seat
 * meant to send, because the entry IS what the recipient reads: the digest
 * carries `type`, recipients, thread, note and payload of each held message
 * rather than a summary of it. Nothing here is a paraphrase.
 */
interface HeldSend {
  type: MessageType;
  to: string[];
  threadId?: string;
  /** The subject the holder asked for, when it was opening a thread of its own. */
  subject?: string;
  artifactRefs?: Array<ArtifactRef | string>;
  note?: string;
  payload: unknown;
  priority: MeshMessage["priority"];
  requires?: { id: string; text: string }[];
}

/**
 * A review ask a new version superseded, as `carryReviewAsksOver` re-issues it:
 * who asked, whom, in which thread, and under what terms.
 */
interface CarriedReviewAsk {
  from: string;
  to: string[];
  threadId: string;
  /** The ask that was closed as `superseded`; the re-issue names it. */
  supersededAsk: string;
  /** The version the superseded ask was about. */
  oldVersion: number;
  contract?: string;
  ifUnanswered?: DefaultAnswer;
}

/** Most reads one turn records as a publish's inputs — the schema's `inputs.maxItems`. */
const MAX_ARTIFACT_INPUTS = 20;
/** Held (not yet re-issued) review asks kept per artifact. */
const MAX_CARRIED_ASKS = 10;
/** Stale-input / stale-pin wakes one new version may cause. Each is a turn. */
const MAX_STALE_NOTICES_PER_VERSION = 8;
const MAX_STALE_NOTICE_KEYS = 2000;
/** A proposed decision's body as quoted in its ratification ask — the size context.ts renders a decision at. */
const MAX_DECISION_PREVIEW_CHARS = 600;
/** Dependencies one task may declare. A plan step waiting on more is really several steps. */
const MAX_TASK_DEPENDENCIES = 20;

export class Supervisor {
  private sessions = new Map<string, { session: import("../../protocol/src/index").AgentSession; runtime: AgentRuntime }>();
  /**
   * Seat -> the session ordinal whose handover has already been requested.
   * Keyed by ordinal rather than by session id because a rotation REUSES the
   * mesh session id: the transcript is new, the handle is not.
   */
  private continuityAsked = new Map<string, number>();
  private turnInFlight = new Set<string>();
  /**
   * Who each sender has already bought a wake for during its current turn.
   *
   * The outbound half of the digest, and it exists because the scheduler
   * already refuses to sell the second wake: `requestActivation` finds the
   * recipient still queued and raises its priority WITHOUT enqueuing another
   * turn. So a seat that interrupts the same recipient five times in one turn
   * moves that recipient exactly once and was billed five times -- paying for
   * attention that was never delivered, on the one ledger whose whole purpose
   * is to make attention cost something real.
   *
   * Keyed by sender and cleared when that sender's turn begins, so it bounds
   * a burst rather than a conversation: interrupting the same seat again on a
   * LATER turn is a genuinely new wake and is charged again. Sends from
   * outside a turn (the operator, sweeps, system paths) have no entry and are
   * priced exactly as before.
   */
  private wakesBoughtThisTurn = new Map<string, Set<string>>();
  /**
   * How many messages each sender has sent during its current turn, and the
   * FYI-class ones that went past the budget and are waiting for the turn-end
   * flush.
   *
   * The mailbox half of the same problem the delivery regime's coalescing
   * addresses from the wake side. `deliver` already stops a burst costing one
   * turn per line, but every line still LANDS, and it is the landing -- 282
   * messages a day, 119 of them at one seat, ~100 never read, a mailbox peaking
   * at 145 unread (2026-09-27) -- that buries the seat the whole mesh queues
   * behind. So a turn's chatter past `mesh.messages.max_sends_per_turn` is held
   * and delivered as ONE digest at turn end.
   *
   * Keyed by sender and cleared when that sender's turn begins, exactly like
   * `wakesBoughtThisTurn` above and for the same reason: this bounds a burst,
   * not a conversation.
   */
  private sendsThisTurn = new Map<string, number>();
  private heldSendsThisTurn = new Map<string, HeldSend[]>();
  /**
   * Senders whose turn-end digest is being emitted right now.
   *
   * The flush sends THROUGH `sendMessage`, so without this the digest would be
   * counted, held, and flushed again at the end of a turn that has already
   * ended. Only a re-entrant flush can be in here.
   */
  private flushingSends = new Set<string>();
  /** Turn ids the silence detector already interrupted — one interrupt per turn. */
  private interruptedTurnIds = new Set<string>();
  /**
   * Why the budget watch stopped a turn, by turnId, until that turn's failure is
   * recorded. The interrupt comes back as the runtime's own abort, which reads
   * as silence (or, forced, as a bare failure), so without this the seat was
   * told its stream had gone quiet when its spend had passed its headroom.
   */
  private budgetStops = new Map<string, string>();
  /**
   * Turns an operator asked to stop (`interruptTurn`), by turnId, until the turn
   * has closed. The budget watch's twin, kept apart because the two END apart: a
   * budget stop still runs the failure ladder, and an operator stop is not a
   * failure at all — no `agent.failed`, no restart, no strike, and the classifier
   * reads this map before it would call the runtime's abort "silence".
   */
  private operatorStops = new Map<string, OperatorStop>();
  /** `interruptTurn` callers waiting for a stopped turn to close, by turnId. Resolved in `runTurn`'s `finally`. */
  private turnEndWaiters = new Map<string, Array<() => void>>();
  /**
   * Per-turn handle that ends a runtime call from outside it.
   *
   * Registered by `callRuntimeWithTimeout` for exactly as long as the call is
   * pending, and fired by `interruptSilentTurns` when a runtime ignores its
   * interrupt. Rejecting the call it races -- rather than failing the turn from
   * the timer -- is what makes the forced settle a turn ending like any other:
   * `runTurn`'s own catch/finally writes the one `turn.discarded`, the one
   * `agent.failed`, releases the holds and clears `turnInFlight`, and the hung
   * call's late answer (success OR abort) lands on a race that already settled,
   * so nothing it says can run an op or rewrite the record.
   */
  private forceSettleTurn = new Map<string, (err: Error) => void>();
  /**
   * Tools an operator has unlocked for a seat gated by `requires_approval`.
   *
   * In-memory by intent: a grant dies with the supervisor, which is the
   * conservative direction — a restarted mesh re-gates rather than carrying an
   * old approval silently forward. Keyed by agent, not by SDK session, so a
   * transcript rotation does not drop a grant out from under a live mission.
   */
  private toolGrants = new Map<string, Set<string>>();
  /**
   * Tools each seat's gate actually refused, as reported by the runtime on its
   * turn-end frame. The read half of `toolGrants`: it turns the operator's gate
   * surface from "type a tool name and hope you spelled it the way the backend
   * does" into a list of what the seat is demonstrably blocked on. Same
   * in-memory lifetime and same keying as the grants, for the same reasons.
   */
  private toolRequests = new Map<string, Set<string>>();
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
  /**
   * Consecutive turns the model PROVIDER refused, per seat. Not a ladder: an
   * outage never moves a seat toward terminal (see `handleProviderOutage`).
   * It only spaces the seat's own retries until the scheduler's provider
   * breaker trips and holds them. Reset by any answered turn, and wholesale
   * when the breaker closes.
   */
  private outageRetries = new Map<string, number>();
  /**
   * Breaker transitions are applied one at a time: each reads the card the
   * previous one raised or restated, and the scheduler reports them from
   * synchronous code that cannot await.
   */
  private providerBreakerChain: Promise<void> = Promise.resolve();
  /**
   * Seats the MESH suspended after a TERMINAL failure — the park at the end of
   * `handleAgentFailure`, where the failure ladder ran out and every ask the
   * seat owed was discharged with notice.
   *
   * Kept apart from the SUSPENDED lifecycle because the two suspensions mean
   * opposite things to an operator's answer, and the lifecycle cannot tell them
   * apart: `activateAgent` refuses every SUSPENDED seat alike. A seat the
   * OPERATOR suspended (the dashboard's pause, a stop with `suspend: true`)
   * must stay down until the operator resumes it, and no escalation response
   * may quietly undo that. A seat parked for terminal failure is the opposite:
   * the mesh parked it on the assumption the mission can proceed without it,
   * and when every seat dies that way (a provider quota, a dead backend) it
   * cannot — the stall watchdog escalates and the operator's "retry" was a
   * no-op, because the activation it raises is refused by lifecycle.
   *
   * A set, not a note string: live, the classification is recorded where it
   * is decided. It does NOT die with the process: boot rebuilds it from the
   * log (`rebuildTerminalSuspended`, step 8e), because the operator's commonest
   * move after an outage — fix the provider, restart the host, answer the
   * cards — lands in a process that never saw the park, and an in-memory-only
   * set made that answer a no-op (2026-09-28: ten seats, ten hand resumes).
   * The park writes `cause: "terminal_failure"` on its SUSPENDED transition
   * for that; `isTerminalFailureSuspension` is the one reader. Any resume
   * clears the id (`resumeAgent`), so does any operator suspension (the
   * operator's pause outranks the mesh's park), and every reader re-checks the
   * live lifecycle, so a stale entry can only ever be ignored.
   */
  private terminalSuspended = new Set<string>();
  private workerInfo = new Map<string, { parent: string; taskId: string; depth: number }>();
  /**
   * `<sender>:<ref it named>` for unresolvable PATCH_READY announcements the
   * sender has already been woken about — one wake per distinct bad reference.
   *
   * Without the guard the wake is a feedback loop: the recovery turn re-runs
   * the agent, an agent that announces the same unidentified patch again is
   * refused again, and the refusal wakes it again, faster than the fingerprint
   * loop detector can park it. Telling it once is the point; telling it on a
   * cycle is the bug. In-memory on purpose — a nudge is scheduling, not state,
   * and must not be replayed out of the log.
   */
  private patchRefusalNotified = new Set<string>();
  private startedAt = 0;
  /**
   * Set when a mission booted on model-generated acceptance criteria and is
   * waiting for the operator to accept them. Held here rather than derived from
   * the goal status because `resumeGoal` must be able to tell "the operator
   * acknowledged the criteria" from "the operator lifted an ordinary pause" —
   * only the former needs to start the agents that boot deliberately skipped.
   */
  private criteriaReviewHold = false;
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
  /**
   * Turns that were running when `shutdown()` stopped their runtime sessions,
   * by turn id. The session stop is what fails them, so `runTurn` asks this
   * set, not `stopping`, whether a throw was the process going away: after a
   * completion `stopping` stays latched, and an operator can still wake a seat
   * explicitly, whose genuine failure must still walk the ladder.
   */
  private shutdownStops = new Set<string>();
  /**
   * The mission's completion while `completeMission` runs: the drain of turns in
   * flight, the sweep, then the stop. `shutdown()` joins it instead of racing it,
   * because a host that stops the supervisor the moment it reads `goal.completed`
   * (the CLI's completion watch polls /status every 2 s) arrives first and cut the
   * turns the drain was waiting for off mid-sentence.
   */
  private completion: Promise<void> | null = null;
  private idleCallbacks: Array<() => void> = [];
  private recentTurns: TurnRecord[] = [];
  private activeTurnByAgent = new Map<string, string>();
  /**
   * The turn record a seat's in-flight turn is writing to. MCP tool calls land
   * here through `executeToolOp`, so `wait`, `escalate`, the handover guard and
   * the turn's results see them exactly as they see ops the runtime returned.
   */
  private liveTurnByAgent = new Map<string, TurnState>();
  /**
   * How many effects each in-flight turn has landed on the mesh, keyed by turn
   * id. Counted from the event stream, so it sees work however it arrived,
   * including effects that never passed through `executeOp`.
   *
   * `unproductive` used to be decided by `output.operations.length` alone,
   * which missed every `mesh_*` tool call. In one live run 12 of 32 turns
   * were logged "nothing was sent, published, or requested" while publishing
   * artifacts, transitioning them and sending mail; the strikes that followed
   * fed a recovery loop that cost one seat 537,479 tokens, 3.6x its configured
   * budget, with every turn recorded as having produced nothing.
   *
   * Cleared when the turn settles, so this never outlives the turn it counts.
   */
  private turnEffects = new Map<string, number>();
  /**
   * Seats already warned about a model substitution, so the warning rides one
   * turn rather than every turn for the life of the mission. Keyed by agent and
   * never cleared: the condition is a property of the environment, not of a turn.
   */
  private modelMismatchNoted = new Set<string>();
  /**
   * Non-mesh tool invocations made by the turn currently in flight, keyed by
   * agent id. Opened at 0 when the turn goes live, raised as each live tool
   * call COMPLETES (`noteVerificationFrame`) -- because MCP ops run during the
   * runtime call, and a claim made then must be judged on what the turn had
   * checked by that moment -- then set from the finished turn's `toolCalls`
   * before its structural ops run, and cleared when the turn settles.
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
   * Not persisted as a number, but not lost on a restart either: boot re-learns
   * it from the settled turns of the active goal already in the log
   * (`reseedTurnCostEstimates`, step 8f). Re-learning "within a few turns" was
   * the old plan, and the first of those turns is the expensive one — an empty
   * estimate means the 32k no-history ask AND a partial grant (`allowPartial`),
   * so both budget overruns of 2026-09-28 were a seat's first turn after a
   * restart: asked 32k, ran ~100k, against 113k and 34k of headroom. Replaying
   * only the recent turns keeps an old model's cost from outliving it, exactly
   * as the live EWMA would.
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
  private stallTimer?: TimerHandle;
  private liveMode = false;
  private lastTurnAt = 0;
  private lastStallNudgeAt = 0;
  /** The seat the last stall nudge went to: the next one looks elsewhere if that nudge bought nothing. */
  private lastStallDriver: string | undefined;
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
  private stallNoopTimer?: TimerHandle;
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
  /**
   * The same idea as `quiesced`, for the opposite case. Quiescence rests the
   * watchdog when there is provably NOTHING to do; this counts the nudges that
   * had something to do — unmet criteria, mail, open escalations, claimed
   * tasks — and produced no work anyway. One is a mission that is finished but
   * unclosable, the other a mission that is wedged; they need different answers
   * (silence vs. a human), so they are counted separately and neither gate
   * reads the other's state.
   *
   * MISSION-WIDE, not per-agent, because `stallDriver` deliberately ROTATES
   * across stuck agents: a per-agent counter would need N x MAX nudges before
   * an N-agent mesh said anything, and each agent's count would look innocent
   * the whole way. The condition being detected is "this MISSION is wedged",
   * not "this agent is" — and `checkStall` has exactly one active goal by
   * construction, so one counter is the honest key.
   *
   * In memory only, like `turnCostEstimate`: it measures a live streak, and a
   * streak restored from disk would describe a run that is no longer happening.
   */
  private stallNudgeStreak = 0;
  /**
   * Consecutive nudges that never reached an agent at all (policy DENY/DEFER,
   * busy, parked). Separate from `stallNudgeStreak` so "the driver ignored 3
   * nudges" is never conflated with "the mesh could not schedule anyone": both
   * are silent, both wedge the mission, but they need different fixes and the
   * escalation has to be able to say which one happened.
   */
  private stallRefusalStreak = 0;
  /**
   * One stall-cap card per mission. `escalate()` dedupes on conflictKey against
   * OPEN cards only, so without this latch an answered card would be minted
   * again on the very next tick; with it, an answered card RELEASES the cap
   * (see `checkStall`) instead of being re-raised.
   */
  private stallCapEscalated = false;
  /**
   * Whether the halt-neglect card this supervisor raised is still standing.
   * Same self-release contract as `stallCapEscalated`: once the card is no
   * longer OPEN the flag clears and the halt is re-evaluated from scratch.
   */
  private haltNeglectEscalated = false;
  /** Say "someone already owes an answer" once, not once per watchdog tick. */
  private haltNeglectNoted = false;
  /**
   * The earliest instant this process may count a halt from: its boot, or the
   * moment its own halt-neglect card was released. The halt itself is dated
   * from the log (see `haltStartedAtMs`); this floor only keeps a restart, or
   * an answered card, from re-raising the card on the very next tick for
   * neglect that predates it — the operator gets a fresh window, as before.
   */
  private haltWatchFloorAt = 0;

  /**
   * The kernel's clock is the supervisor's clock. Every time READ below goes
   * through `nowMs()` and every timer through `timers`, so a test that hands
   * the kernel a manual clock can advance the watchdogs, backoffs and turn
   * timeouts instead of sleeping through them. Production's kernel carries the
   * system clock, whose timers are the real event loop — no behaviour change.
   */
  private readonly timers: Timers;

  private nowMs(): number {
    return this.deps.kernel.clock.now().getTime();
  }

  constructor(public readonly deps: SupervisorDeps) {
    this.timers = timersOf(deps.kernel.clock);
    this.startedAt = this.nowMs();
    this.lastTurnAt = this.nowMs();
    // Restore the persisted turn ring before anything can push a turn; the
    // in-memory tracker is the only home of per-turn rich data (phases,
    // opTimings, text), and without this a restart loses every trace of it.
    this.turns = new TurnTracker(this.deps.turnsFile ? this.turnsPersistAdapter() : undefined);
    this.detector = new DeadlockDetector(deps.config);
    // Every emit made while a seat is mid-turn now carries that turn, without
    // any of the 109 emit sites having to say so. Only a LIVE kernel gets this:
    // a replay must take `correlationId` off the stored envelope, never from a
    // turn map that does not exist during a rebuild.
    deps.kernel.correlate = (actorId) => (actorId ? this.activeTurnByAgent.get(actorId) : undefined);
    deps.scheduler.onIdle?.(() => this.onIdle());
    deps.kernel.subscribe((event) => {
      // Real work re-arms the watchdog. Without this, quiescence would be a
      // one-way door: a mesh that rested could never be re-woken by a human
      // message or a late artifact, which is a deadlock wearing a cost saving
      // as a disguise.
      if (isProgressEvent(event.type)) this.quiesced = false;
      // `kernel.correlate` (set just above) stamps every emit made mid-turn
      // with that turn's id, so counting here catches work from BOTH channels
      // without any emit site having to say so — which is exactly what the
      // ops-block-only measure could not do.
      if (event.correlationId && isTurnEffect(event)) {
        this.turnEffects.set(event.correlationId, (this.turnEffects.get(event.correlationId) ?? 0) + 1);
      }
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
    this.lastTurnAt = this.nowMs();
    if (this.stallNoopTimer) {
      this.timers.clearTimeout(this.stallNoopTimer);
      this.stallNoopTimer = undefined;
    }
    this.stallNoopRetryAt = 0;
    this.lastStallNudgeAt = 0;
    this.quiesced = false;
    // The nudge cap is a statement about one live run. Going live (or being
    // re-parked and sent live again) starts a new one, so a streak earned
    // before the switch must not spend the new run's first three nudges — and
    // the latch has to drop with it or the next cap would escalate nothing.
    this.stallNudgeStreak = 0;
    this.stallRefusalStreak = 0;
    this.stallCapEscalated = false;
    this.haltNeglectEscalated = false;
    this.haltNeglectNoted = false;
  }

  /**
   * The semantic lens every replay of THIS mesh must use. Reducer behaviour
   * is config-parameterized now (commitment inference on/off), so a replay
   * that drops the semantic re-derives a different history than the live
   * mesh did — exactly the class of live-vs-replay divergence the commitment
   * ledger was built to eliminate.
   */
  projectionConfig(): ReturnType<typeof projectionConfigFor> {
    // Deliberately not a hand-copy of the live kernel's gates. The two used to
    // be two lists maintained in parallel, which is how `contractsByType`
    // reached production declared, read by the reducer, and passed by neither.
    return projectionConfigFor(this.config);
  }

  private auditLine(msg: string): void {
    if (!this.deps.auditFile) return;
    try {
      fs.mkdirSync(path.dirname(this.deps.auditFile), { recursive: true });
      fs.appendFileSync(this.deps.auditFile, `${this.deps.kernel.clock.iso()} ${msg}\n`, "utf8");
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
      this.turns.mark(turnId, phase, this.nowMs());
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

  async boot(opts: {
    resume?: boolean;
    uiOnly?: boolean;
    mode?: "parked" | "live";
    /**
     * Resolves when the mesh MCP bridge can carry a seat's ops — supplied by
     * the process that owns the bridge, because only it knows when the route
     * the seats' SDK spawns against is answering.
     *
     * Only the FIRST live wake is gated on it (see `awaitBridgeReady`): after
     * that the bridge is up for the lifetime of the process, and every later
     * activation — mail, interests, `goLive` — runs the way it always did. A
     * mesh with no bridge (the in-memory and stub beds of the tests) supplies
     * none and boots byte for byte as before.
     */
    bridgeReady?: (() => Promise<void>) | Promise<void>;
    /**
     * Overrides `BRIDGE_READY_TIMEOUT_MS`. Injectable for the same reason
     * `BridgeRespawnDelaysMs` is: the tests cannot spend a real minute proving
     * that a probe which never resolves does not wedge the boot.
     */
    bridgeReadyTimeoutMs?: number;
  } = {}): Promise<Goal | null> {
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
        // Declared criteria need no derivation and no review: the operator
        // wrote them. Only a model's list is unverified, and it is the
        // completion gate, so it is the one case that holds for acknowledgement.
        const derived = this.config.goalCriteria
          ? { criteria: this.config.goalCriteria, generated: false }
          : await this.deriveAcceptanceCriteria();
        const goal = await this.createGoal({
          description: this.config.goalText,
          acceptanceCriteria: derived.criteria,
          budget: {
            tokens: this.config.budgets.mission.tokens,
            wallClockMinutes: this.config.budgets.mission.wallClockMinutes,
            maxEvents: this.config.budgets.mission.maxEvents,
          },
        });
        if (derived.generated) {
          // Pause rather than invent a gate: this is the operator's own pause
          // path, so agents are refused with the ordinary "mission is paused"
          // and `resumeGoal` is the acknowledgement. The reason is what tells
          // the operator this is a review, not a fault.
          this.criteriaReviewHold = true;
          await this.deps.kernel.emit(
            "goal.paused",
            {
              goalId: goal.id,
              reason:
                "acceptance criteria were generated from the goal — review them, then resume the mission to start work",
            },
            { actorId: HUMAN_AGENT_ID },
          );
        }
      }
    }
    // 6b. the mission's wall clock runs from its goal's creation, not from
    // this process's construction. `startedAt` used to be stamped only in the
    // constructor, so every restart handed a resumed mission its whole
    // `wallClockMinutes` back and `wall_clock_exceeded` could never fire on a
    // mission that had been restarted once. `createdAt` is stamped by the
    // kernel's clock and replayed from the log, so this is the same instant in
    // every process lifetime; a fresh goal was created just above, so the
    // derivation is a no-op there.
    {
      const active = this.state.activeGoalId ? this.state.goals.get(this.state.activeGoalId) : undefined;
      const createdMs = active ? Date.parse(active.createdAt) : NaN;
      if (Number.isFinite(createdMs)) this.startedAt = createdMs;
    }
    // 7. register agents (+ human seat, Â§36)
    await this.registerHuman();
    for (const id of this.config.agentOrder) {
      const existing = this.state.agents.get(id);
      const def = this.config.agents[id];
      if (!existing) {
        await this.registerAgent(def);
      } else if (JSON.stringify(existing.definition) !== JSON.stringify(def)) {
        await this.deps.kernel.emit(
          "agent.replaced",
          {
            agentId: id,
            agent: def,
            inheritArtifactIds: existing.state.currentArtifactIds,
            inheritTaskId: existing.state.activeTaskId,
          },
          { actorId: HUMAN_AGENT_ID },
        );
      }
    }
    // 7b. sessions.json is a cache of what the log knows; reconcile it before
    // any seat can restore from it.
    await this.reconcileSessionRegistry();
    // 8. allocate budgets
    const goalId = this.state.activeGoalId!;
    this.deps.budget.declare(missionKey(goalId), "tokens", this.config.budgets.mission.tokens);
    this.deps.budget.declare(missionKey(goalId), "events", this.config.budgets.mission.maxEvents);
    this.deps.budget.declare(missionKey(goalId), "wallclock_minutes", this.config.budgets.mission.wallClockMinutes);
    for (const id of this.config.agentOrder) {
      this.deps.budget.declare(agentKey(goalId, id), "tokens", this.config.agents[id].budget.tokens ?? null);
    }
    // The attention line, declared only for a mesh that asked for one, and for
    // exactly the seats an agent line is declared for -- a spawned worker's
    // token line is undeclared today, so mirroring that is consistent rather
    // than a new gap. The pre-flight check reads the LIMIT FROM CONFIG, not
    // from this ledger, so a seat missing a declaration can still have its
    // interrupts refused; what the declaration buys is `budget.exceeded` on
    // the attention key, which is the one event an operator can watch for
    // "this seat has run out of influence".
    const attentionLimit = this.config.bus.deliveryClasses?.attentionTokens;
    if (attentionLimit !== undefined) {
      for (const id of this.config.agentOrder) {
        this.deps.budget.declare(attentionKey(goalId, id), "tokens", attentionLimit);
      }
    }
    // 8b. close turns abandoned by a previous process lifetime: anything the
    // log still shows as running can never finish (in-memory traces are gone
    // with the old process), and would otherwise read as "running" forever in
    // every step/agent view. Runs before the scheduler starts so the close
    // events themselves trigger no activations.
    await this.closeAbandonedTurns();
    // 8b'. give back the budget those turns were holding; see `releaseAbandonedReservations`.
    await this.releaseAbandonedReservations();
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
    // 8d. retire a provider card no breaker stands behind. The breaker is
    // scheduler memory, so a process restarted mid-outage boots it closed and
    // its close — the only thing that retires the card — never runs. Advisory,
    // the card halts nothing, but any OPEN card holds the completion verdict
    // shut. If the provider is still refusing, the first turns trip a fresh
    // breaker and raise a fresh card.
    if (goalId && (this.deps.scheduler.providerBreaker?.().state ?? "closed") === "closed") {
      for (const esc of [...this.state.escalations.values()]) {
        if (esc.status !== "OPEN" || esc.conflictKey !== providerCardKey(esc.goalId)) continue;
        await this.deps.kernel
          .emit(
            "escalation.auto_resolved",
            { escalationId: esc.id, reason: "auto-resolved: the mesh restarted, and no provider breaker is holding it now — a provider still refusing turns will trip a fresh one" },
            { actorId: RECOVERY_ACTOR_ID, goalId: esc.goalId },
          )
          .catch(() => undefined);
      }
    }
    // 8e. which SUSPENDED seats the MESH parked for terminal failure. The set
    // is process memory, so without this an escalation answer after a restart
    // revives nobody. After 8b's closes, and before anything below can start a
    // turn, so it reads the lifecycle the scheduler will actually see.
    await this.rebuildTerminalSuspended();
    // 8f. each seat's turn-cost estimate, from its settled turns in the log.
    // Before the first reservation: an empty estimate is a 32k ask admitted
    // short, which is how a seat's first turn after a restart overran its
    // ledger by a whole turn.
    if (goalId) await this.reseedTurnCostEstimates(goalId);
    // 8g. seats the previous process left FAILED because it exited while it
    // was still handling a turn it had killed itself. Parked boots too: the
    // lifecycle is wrong either way, and a parked mesh shows it.
    const restored = await this.restoreShutdownCasualties();
    // 12/13. start scheduler + activate initial agents (skipped in parked mode:
    // the scheduler stays stopped, so no agent is ever activated or spends tokens)
    // `mode` is the explicit successor of the legacy `uiOnly` boolean.
    const parked = opts.mode !== undefined ? opts.mode === "parked" : Boolean(opts.uiOnly);
    // 12a. Before ANYTHING in a live boot that can start a turn — the three
    // stamps below, the stall watchdog, the scheduler's own pump and the
    // startup activation all sit under this line — hold the first wake until
    // the bridge the seats will call back on is reachable. A parked boot wakes
    // nobody, so it is not gated and its semantics are untouched.
    if (!parked) await this.awaitBridgeReady(opts);
    this.liveMode = !parked;
    this.lastTurnAt = this.nowMs();
    this.haltWatchFloorAt = this.nowMs();
    this.stallNoopRetryAt = 0;
    this.startStallWatch();
    if (!parked) {
      this.deps.scheduler.start();
      // A mission holding on generated criteria starts nobody. Waking agents
      // into a paused mission buys one refused turn each, and a brief that says
      // "start work" when every op will be rejected is worse than no brief.
      if (!this.criteriaReviewHold) await this.activateStartup(Boolean(opts.resume), restored);
    }
    return this.state.goals.get(goalId) ?? null;
  }

  /**
   * Hold the first live wake until the server says its MCP bridge can carry ops.
   *
   * The bridge is a process the seat's SDK spawns at `init`, pointed at the
   * server's `/internal/mcp/:agent`. Nothing in its URL is knowable before that
   * server `listen()`s, and for a child of the multi-project host even the PORT
   * is not: the child asks the OS for port 0, so the configured port it fell
   * back to is not merely unreachable, it is the wrong number. A wake that lands
   * in that window spends a turn's whole respawn ladder (5 spawns, 30s) against
   * a bridge that could not connect, then aborts the turn — measured 2026-09-27:
   * >35s after a child restart, one lost turn per restart.
   *
   * So the wake waits, and only the first one: after it the bridge is up for the
   * life of the process. A caller with no bridge supplies no probe and returns
   * from here immediately, which is what keeps every in-memory and stub mesh on
   * exactly the boot path it had.
   *
   * The wait is bounded and the outcome is always said out loud, in the audit
   * trail, whether it waited or not — a boot that silently waited 12s would be
   * indistinguishable from one that did not, and the next operator has to be able
   * to tell those apart. Past the bound the mesh starts anyway: a mission that
   * cannot start at all is worse than one whose first wake finds the bridge down,
   * and the runtime already tells that seat what it found.
   */
  private async awaitBridgeReady(opts: {
    bridgeReady?: (() => Promise<void>) | Promise<void>;
    bridgeReadyTimeoutMs?: number;
  }): Promise<void> {
    const probe = opts.bridgeReady;
    if (!probe) return;
    const timeoutMs = opts.bridgeReadyTimeoutMs ?? BRIDGE_READY_TIMEOUT_MS;
    // Real wall-clock time and a real timer, deliberately: the wait bounds an
    // external process coming up, so it cannot be measured on, or released by,
    // a mission clock that nobody advances.
    const startedAt = Date.now();
    let expiredByTimeout = false;
    let probeFailed = false;
    let resolveTimeout = (): void => undefined;
    const expired = new Promise<void>((resolve) => {
      resolveTimeout = resolve;
    });
    // Deliberately NOT unref'd. The boot is awaiting a promise that only this
    // timer can resolve when the probe never does, so an unref'd timer lets a
    // process with nothing else holding the event loop exit with the boot still
    // pending ("Promise resolution is still pending but the event loop has
    // already resolved"). A server process masks that (its listener keeps the
    // loop alive); an embedded mesh and the test runner do not. It costs
    // nothing to hold the loop: the timer is cleared the moment the race ends.
    const timer = setTimeout(() => {
      expiredByTimeout = true;
      resolveTimeout();
    }, Math.max(0, timeoutMs));
    await Promise.race([
      Promise.resolve()
        .then(() => (typeof probe === "function" ? probe() : probe))
        .then(
          () => undefined,
          // A probe that REJECTS is a bridge that will not come up. It must not
          // take the boot with it, and it must not read as ready either.
          () => {
            probeFailed = true;
          },
        ),
      expired,
    ]);
    clearTimeout(timer);
    const waited = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (!expiredByTimeout && !probeFailed) {
      this.auditLine(`scheduler live after waiting ${waited}s for the mesh MCP bridge`);
      return;
    }
    // Said in full rather than swallowed: the seats woken from here on get the
    // runtime's own notice about a bridge that never attached, and this is the
    // line that tells the operator why they got it.
    this.auditLine(
      probeFailed
        ? `bridge readiness: the mesh MCP bridge probe failed after ${waited}s — activating anyway; a seat woken now may be told the bridge is down`
        : `bridge readiness: the mesh MCP bridge did not report ready within ${timeoutMs}ms (waited ${waited}s) — activating anyway; a seat woken now may be told the bridge is down`,
    );
  }

  /**
   * Wake the seat that owns the first move and brief the rest.
   *
   * Shared by boot and by the acknowledgement of a criteria review, because
   * those are the same moment: a mission whose planning never happened still
   * needs the lead to decompose the goal before the others invent parallel
   * plans of their own.
   *
   * A resumed boot wakes `resumeCandidates(restored)`; see there.
   */
  private async activateStartup(resume: boolean, restored: readonly string[] = []): Promise<void> {
    const activate = resume ? this.resumeCandidates(restored) : this.config.startupActivate;
    for (const [i, id] of activate.entries()) {
      await this.activateAgent(id, {
        kind: resume ? "recovery" : "startup",
        note: resume
          ? "mission resumed from event log"
          : i === 0
            ? this.plannerBrief()
            : "startup activation. A lead agent is decomposing the goal into tasks right now — do NOT invent your own parallel plan. Check the mission acceptance criteria and open tasks, claim what your role owns, and ask the lead if your slice is unclear.",
      });
    }
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
        continue;
      }
      // What a graceful stop records (`turn.discarded`, next to its released holds)
      // and a killed process cannot. Without it the log holds a turn that began and
      // never ended, and a view of discards or spend has nothing to count.
      // `tokens` is left out on purpose: absent means unmeasured, never zero, and
      // whatever the turn spent before the process died was not recorded anywhere.
      await this.deps.kernel
        .emit(
          "turn.discarded",
          {
            agentId,
            turnId,
            reason: "interrupted",
            detail: "abandoned by server restart: the process ended before the turn did, so its spend was never recorded",
          },
          { actorId: "system", correlationId: turnId },
        )
        .catch(() => undefined);
    }
  }

  /**
   * Boot step 8b': release every budget hold the log still shows open.
   *
   * A turn takes its holds (agent, mission, thread) before it calls the model and
   * gives them back in the `finally` that ends it, consumed or released. A process
   * that dies between the two writes `budget.reserved` and nothing after, and the
   * projection replays the hold as live forever: tech-lead's ledger read
   * `reserved: 17094`, and so did the thread's and the mission's, with no tech-lead
   * turn running, after a SIGKILL mid-turn (cronlite 2026-09-30). Each crash left
   * one more turn's estimate of headroom unspendable until the mission was reset.
   *
   * At boot nothing is running -- the scheduler has not started and in-memory turn
   * state is gone -- so a hold that survives into a new process belongs to a turn
   * the old process never finished, whatever its key. Released, not consumed: what
   * the dead turn actually spent is unknown, and a figure invented here would be
   * billed as fact. Event-sourced, so replay reproduces the release exactly, and
   * idempotent: a later boot finds nothing held.
   */
  private async releaseAbandonedReservations(): Promise<void> {
    const goalId = this.state.activeGoalId ?? undefined;
    const held: Array<{ key: string; reservationId: string }> = [];
    for (const [key, ledger] of this.state.budgets) {
      for (const reservationId of ledger.reservations.keys()) held.push({ key, reservationId });
    }
    if (held.length === 0) return;
    for (const { key, reservationId } of held) {
      await this.deps.budget
        .release(key, reservationId, {
          actorId: RECOVERY_ACTOR_ID,
          goalId,
          reason: "abandoned: the process that held it ended before settling it",
        })
        .catch((err) => this.auditLine(`boot: could not release abandoned hold ${reservationId} on ${key}: ${(err as Error).message}`));
    }
    this.auditLine(`boot: released ${held.length} budget hold(s) left open by a process that ended mid-turn`);
  }

  /**
   * Boot step 8e: refill `terminalSuspended` from the log, so it means the same
   * thing in this process as it did in the one that parked the seats.
   *
   * For each seat that is SUSPENDED now, the LATEST suspension in the log
   * decides — never any earlier one. A seat parked for failure, resumed, and
   * then paused by the operator is the operator's, and stays down. Because the
   * seat is SUSPENDED now, the last event that moved its lifecycle put it
   * there; a later suspension of an already-suspended seat is the operator
   * re-pausing a parked seat, which `suspendAgent` treats as outranking the
   * park too, so the two processes agree on it.
   *
   * Replaces the set rather than adding to it: boot also runs after a reset
   * or a restore, where the ids the old mission marked mean nothing.
   *
   * Reads the whole log's lifecycle events, and only when some seat is
   * SUSPENDED at all: the park can be hours and thousands of events back (the
   * 2026-09-28 seats were parked four hours before the restart), so the tail
   * `closeAbandonedTurns` reads is not enough, and the store filters its
   * in-memory copy.
   */
  private async rebuildTerminalSuspended(): Promise<void> {
    this.terminalSuspended.clear();
    const undecided = new Set<string>();
    for (const rec of this.state.agents.values()) {
      if (rec.state.lifecycle === "SUSPENDED") undecided.add(rec.state.agentId);
    }
    if (undecided.size === 0) return;
    let events: MeshEvent[] = [];
    try {
      events = await this.deps.store.read({ types: ["agent.state_changed", "agent.suspended"] });
    } catch {
      // Unreadable: nobody is marked, which degrades to "resume by hand" —
      // the pre-rebuild behaviour, never a revival of a seat someone paused.
      return;
    }
    for (let i = events.length - 1; i >= 0 && undecided.size > 0; i--) {
      const e = events[i]!;
      const p = (e.payload ?? {}) as { agentId?: unknown; to?: unknown };
      if (typeof p.agentId !== "string" || !undecided.has(p.agentId)) continue;
      if (e.type === "agent.state_changed" && p.to !== "SUSPENDED") continue;
      undecided.delete(p.agentId);
      if (isTerminalFailureSuspension(e)) this.terminalSuspended.add(p.agentId);
    }
    if (this.terminalSuspended.size > 0) {
      this.auditLine(
        `boot: ${[...this.terminalSuspended].join(", ")} still SUSPENDED from a terminal-failure park before this boot — an escalation answer will resume them`,
      );
    }
  }

  /**
   * Boot step 8f: rebuild `turnCostEstimate` by replaying each seat's settled
   * turns of the active goal through `noteTurnCost`, oldest first — the same
   * fold, over the same numbers, that the live process made.
   *
   * The numbers are the `budget.consumed` rows on the seat's agent ledger that
   * the success path writes right after it calls `noteTurnCost` with the same
   * amount. The ledger's other two charges were never folded in live and are
   * skipped here (`isSettledTurnCharge`). Only the last
   * `TURN_COST_REPLAY_TURNS` per seat are replayed, and a zero amount is not
   * one of them (`noteTurnCost` ignores it, so it would only shrink the window).
   *
   * Active goal only: the no-history path is documented as "a seat's first
   * turn of the mission", and a new goal is a new mission. A seat with no
   * settled turn keeps that permissive first turn.
   *
   * Replaces the map rather than adding to it: re-folding turns the live map
   * already holds (a boot in the same process) would count them twice.
   */
  private async reseedTurnCostEstimates(goalId: string): Promise<void> {
    this.turnCostEstimate.clear();
    const seatOfKey = new Map<string, string>();
    for (const id of this.state.agents.keys()) {
      if (id !== HUMAN_AGENT_ID) seatOfKey.set(agentKey(goalId, id), id);
    }
    if (seatOfKey.size === 0) return;
    let events: MeshEvent[] = [];
    try {
      events = await this.deps.store.read({ types: ["budget.consumed"] });
    } catch {
      return; // unreadable: every seat keeps today's no-history first turn
    }
    const newestFirst = new Map<string, number[]>();
    let full = 0;
    for (let i = events.length - 1; i >= 0 && full < seatOfKey.size; i--) {
      const p = (events[i]!.payload ?? {}) as { key?: unknown; amount?: unknown; discarded?: unknown; reason?: unknown };
      const seat = typeof p.key === "string" ? seatOfKey.get(p.key) : undefined;
      if (!seat || !isSettledTurnCharge(p)) continue;
      const amount = Number(p.amount);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const seen = newestFirst.get(seat) ?? [];
      if (seen.length >= TURN_COST_REPLAY_TURNS) continue;
      seen.push(amount);
      newestFirst.set(seat, seen);
      if (seen.length === TURN_COST_REPLAY_TURNS) full += 1;
    }
    for (const [seat, amounts] of newestFirst) {
      for (let i = amounts.length - 1; i >= 0; i--) this.noteTurnCost(seat, amounts[i]!);
    }
  }

  /**
   * Boot step 8g: restore the seats a previous process left FAILED by exiting
   * in the middle of handling a failure it caused itself.
   *
   * `shutdown()` stops every runtime session, which fails the turns still
   * running on them. Until `closeShutdownStoppedTurn` those went through
   * `handleAgentFailure`, whose first emit is `agent.failed` and whose next is
   * the restart — and the process was exiting underneath it. On 2026-09-28
   * 13:42Z the old child wrote `agent.failed` for frontend, backend and
   * ux-designer inside one millisecond, frontend's `agent.restarted` 30 ms
   * later, and nothing more: backend and ux-designer booted FAILED. The new
   * boot did still wake them (a FAILED seat is a recovery candidate), but
   * ux-designer's wake queued behind `max_active_agents` and it read FAILED
   * for 3.5 minutes, and its eventual reset was written as an operator act.
   *
   * The test is on the log, per seat that is FAILED now:
   * - FAILED at boot means the failure handler never finished. Every complete
   *   run of it leaves FAILED in the same call — a restart (STARTING/IDLE) or
   *   a park (SUSPENDED) — so a seat still there was cut off mid-handler, and
   *   the only thing that cuts a handler off is the process ending.
   * - its latest `agent.failed` says `restartable: true`: the handler was on
   *   its way to restarting it, not to parking it. `false` (a seat the mesh
   *   never retries on its own) or absent (a log too old to say) stays down.
   * - no terminal card (`runtime:<id>` / `backend:<id>`) was raised after that
   *   failure. The card is the handler's LAST act on the terminal path, so one
   *   after the failure means the handler finished and FAILED is its verdict —
   *   the shape a build from before the SUSPENDED park left behind.
   *
   * Timing against the previous process's last event was the other candidate
   * and is weaker: the old process keeps writing after the failure (budget
   * settles, other seats' closes, the snapshot), and a genuine failure can be
   * the last event of a mesh that then idled for hours.
   *
   * A restored seat gets the ladder's own two events — `agent.restarted`
   * (FAILED -> STARTING) and IDLE, by the recovery actor — marked with
   * `MESH_SHUTDOWN_CAUSE` and no `attempt`, because no strike is counted: the
   * seat's failure counters are untouched, it is not `terminalSuspended`, and
   * no card is raised. Returned so a resumed boot wakes it as it would have
   * woken the FAILED seat (`resumeCandidates`).
   */
  private async restoreShutdownCasualties(): Promise<string[]> {
    const failed = new Set<string>();
    for (const rec of this.state.agents.values()) {
      if (rec.state.agentId !== HUMAN_AGENT_ID && rec.state.lifecycle === "FAILED") failed.add(rec.state.agentId);
    }
    if (failed.size === 0) return [];
    let events: MeshEvent[] = [];
    try {
      events = await this.deps.store.read({ types: ["agent.failed", "escalation.requested"] });
    } catch {
      // Unreadable: nobody is restored, which is the pre-restore behaviour.
      return [];
    }
    const restorable = new Set<string>();
    const cardAfter = new Set<string>();
    const undecided = new Set(failed);
    for (let i = events.length - 1; i >= 0 && undecided.size > 0; i--) {
      const e = events[i]!;
      if (e.type === "escalation.requested") {
        const key = (e.payload as { escalation?: { conflictKey?: unknown } } | undefined)?.escalation?.conflictKey;
        const seat = typeof key === "string" ? /^(?:runtime|backend):(.+)$/.exec(key)?.[1] : undefined;
        if (seat && undecided.has(seat)) cardAfter.add(seat);
        continue;
      }
      const p = (e.payload ?? {}) as { agentId?: unknown; restartable?: unknown };
      if (typeof p.agentId !== "string" || !undecided.has(p.agentId)) continue;
      undecided.delete(p.agentId);
      if (p.restartable === true && !cardAfter.has(p.agentId)) restorable.add(p.agentId);
    }
    const restored: string[] = [];
    for (const agentId of failed) {
      if (!restorable.has(agentId)) continue;
      try {
        await this.deps.kernel.emit("agent.restarted", { agentId, cause: MESH_SHUTDOWN_CAUSE }, { actorId: RECOVERY_ACTOR_ID });
        if (this.state.agents.get(agentId)?.state.lifecycle === "STARTING") {
          await this.deps.kernel.emit(
            "agent.state_changed",
            {
              agentId,
              to: "IDLE",
              cause: MESH_SHUTDOWN_CAUSE,
              note: "restored at boot: the previous process exited while it was still handling this seat's turn, which it had stopped itself — not a seat failure, no strike counted",
            },
            { actorId: RECOVERY_ACTOR_ID },
          );
        }
      } catch (err) {
        this.auditLine(`boot: could not restore ${agentId} from FAILED: ${(err as Error).message}`);
      }
      if (this.state.agents.get(agentId)?.state.lifecycle === "IDLE") restored.push(agentId);
    }
    if (restored.length > 0) {
      this.auditLine(`boot: restored ${restored.join(", ")} — left FAILED by the previous process exiting mid-way through handling a turn it had stopped; no strike counted`);
    }
    return restored;
  }

  /**
   * Who a resumed boot wakes: every recovery candidate, plus the seats step 8g
   * restored (a FAILED seat was a candidate by lifecycle alone, and restoring it
   * must not cost it that wake), minus any seat still FAILED after 8g.
   *
   * Those are the ones 8g left down on purpose — `restartable: false`, or a
   * handler that finished with a terminal card — and waking one here is the
   * mesh retrying on its own, which `restartable: false` exists to stop: the
   * activation's FAILED reset (`runTurn`) is an override meant for an operator,
   * and at boot it was written as one (`actorId: human`). An answer to the
   * seat's card, an operator wake, or mail it is owed still reaches it.
   *
   * Agent-registry order, the order `recoveryCandidates` returns.
   */
  private resumeCandidates(restored: readonly string[]): string[] {
    const wake = new Set([...this.recoveryCandidates(), ...restored]);
    return [...this.state.agents.values()]
      .filter((rec) => wake.has(rec.state.agentId) && rec.state.lifecycle !== "FAILED")
      .map((rec) => rec.state.agentId);
  }

  private recoveryCandidates(): string[] {    const out: string[] = [];
    for (const rec of this.state.agents.values()) {
      const a = rec.state;
      if (a.agentId === HUMAN_AGENT_ID) continue;
      if (readableMailDepth(this.state, a.agentId) > 0 || a.activeTaskId || a.lifecycle === "WAITING" || a.lifecycle === "FAILED") {
        out.push(a.agentId);
      }
    }
    return out;
  }

  async shutdown(opts: { complete?: boolean } = {}): Promise<void> {
    // Join a completion in progress: it ends in `stopNow` itself, after the turns
    // still running have finished or the drain's bound has passed. A failed
    // completion is no reason to leave the process up, so the stop runs anyway.
    if (this.completion) await this.completion.catch(() => undefined);
    await this.stopNow();
  }

  /** Stop the scheduler and every runtime session. `shutdown()` and `completeMission` both end here; safe to run twice. */
  private async stopNow(): Promise<void> {
    this.stopping = true;
    this.turns.flush();
    this.stopStallWatch();
    await this.deps.scheduler.stop();
    // Every turn still running is about to have its session stopped under it,
    // and fails for that reason alone. Marked before the first stop, so the
    // throw finds its mark however soon it lands: `runTurn` then closes the
    // turn as interrupted instead of filing a seat failure the exiting process
    // may not live to finish handling (see `closeShutdownStoppedTurn`).
    for (const turnId of this.activeTurnByAgent.values()) this.shutdownStops.add(turnId);
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
    this.outageRetries.clear();
    // Keyed by agent id, which a reset does not re-mint: left in place, the new
    // mission's first hold was sized by the old mission's turns instead of the
    // pessimistic bound a seat with no history is owed.
    this.turnCostEstimate.clear();
    this.workerInfo.clear();
    this.escalationsInFlight.clear();
    this.activeTurnByAgent.clear();
    this.liveTurnByAgent.clear();
    // Per-turn rationing, for the same reason as the caches above: a reset
    // starts a new mission, and a count carried over from the last one would
    // hold the first turn's chatter against a budget it never spent.
    this.sendsThisTurn.clear();
    this.heldSendsThisTurn.clear();
    this.flushingSends.clear();
    this.recentTurns = [];
    this.turns.clear();
    this.idleCallbacks = [];
    this.watchdogLastRun = 0;
    this.watchdogTrailing = false;
    this.startedAt = this.nowMs();
    this.lastTurnAt = this.nowMs();
    this.lastStallNudgeAt = 0;
    this.stallNoopRetryAt = 0;
    if (this.stallNoopTimer) {
      this.timers.clearTimeout(this.stallNoopTimer);
      this.stallNoopTimer = undefined;
    }
    this.detector = new DeadlockDetector(this.deps.config);
    this.termination = new TerminationManager();
  }

  // ------------------------------------------------------- MeshRuntime API (Â§48)

  /**
   * Criteria for a mission that declared none.
   *
   * Runs before `goal.created`, so the criteria are part of the goal from the
   * first event rather than something agents watch change underneath them.
   * That ordering is the whole reason this is a boot step: every agent reads
   * the criteria list on every turn and the completion gate is computed from
   * it, so a list that arrives late is a mission already judged against a
   * different target.
   *
   * Every failure falls back to `DEFAULT_CRITERIA`. Generation improves on the
   * defaults; it is never a precondition for a mission starting, so a model
   * that is slow, unreachable, or answers with prose must not be able to stop
   * one. The criteria actually used are on the `goal.created` payload, which
   * is where an operator sees them either way.
   */
  private async deriveAcceptanceCriteria(): Promise<{
    criteria: Array<Partial<AcceptanceCriterion> & { description: string }>;
    /**
     * True when a model wrote these, which is what triggers the review hold.
     * Defaulted and operator-declared criteria are both already known-good:
     * one is a fixed list the operator can read in the source, the other the
     * operator wrote. Only a model's guess is unverified.
     */
    generated: boolean;
  }> {
    const generate = this.deps.criteriaGenerator;
    if (!generate || !this.config.generateAcceptanceCriteria) {
      return { criteria: DEFAULT_CRITERIA, generated: false };
    }
    try {
      const generated = await generate(this.config.goalText);
      if (generated && generated.length > 0) return { criteria: generated, generated: true };
    } catch {
      // Falls through to the defaults below.
    }
    return { criteria: DEFAULT_CRITERIA, generated: false };
  }

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

  /**
   * What this message's delivery is allowed to cost its recipients.
   *
   * Runs inside `sendMessage` so every path — agent op, MCP tool, HTTP API —
   * is classed by the same rule, and after `sanitizeAgentMessageInput` so the
   * class is never something a sender wrote. See `MessageControl.delivery`
   * for what the three classes mean and why they are orthogonal to `mode`.
   *
   * Returns `undefined` whenever the mesh has no delivery regime configured,
   * which is the default. An unclassed message takes the wake path it always
   * took: absence is today's behaviour, never a cheaper default applied to a
   * mesh that never asked for one.
   */
  private classifyDelivery(message: MeshMessage, cacheHit: boolean): DeliveryClass | undefined {
    if (!this.config.bus.deliveryClasses) return undefined;
    // A cached research answer is a log record, not mail: `cacheServed`
    // already suppresses both the delivery and the wake, so pricing it would
    // bill a sender for an interrupt no seat ever receives.
    if (cacheHit) return undefined;
    const control = message.control;
    // A caller that stamped a class has already decided. Nothing does today;
    // the guard is here so a deliberate runtime stamp can never be silently
    // replaced by a derived one.
    if (control?.delivery) return undefined;
    // Broadcasts keep their own gate. The seats a broadcast wakes are the
    // ones an operator wrote an `interests:` entry for, and a class derived
    // from an envelope must not overrule a decision taken in config.
    if (control?.mode === "broadcast") return undefined;
    if (message.priority === "URGENT") return "interrupt";
    // An answer to an ask the recipient is parked on. This is the one wake
    // that is unarguably worth its turn: the creditor cannot proceed until it
    // lands, so holding it in a coalesce window would make the cheap class
    // the expensive one.
    if (message.replyTo) {
      const pending = this.state.pendingRequests.get(message.replyTo);
      if (pending && message.to.includes(pending.from)) return "interrupt";
    }
    // The obligation rule itself, imported rather than restated. A delivery
    // class has to be derived from the SAME predicate the commitment ledger
    // runs on, or a mesh prices a wake as chatter while the ledger is
    // recording a debt for it -- the class would then be cheapest exactly
    // where the obligation is real. This used to be a local copy, which made
    // four; `projections-messaging`, `context` and this site now all call the
    // catalogue's one.
    //
    // Type-only is the right half here: `obligesRecipients` also gates on
    // `control.mode`, and this function has already returned for `broadcast`
    // above and handles `collab` below, so mode is settled by the time we
    // ask. (`REQUEST_TYPES` is not the thing to reach for either -- it is
    // `@deprecated`, and it is this same type-only question wearing a name
    // that promises the whole answer.)
    const obliging = isObligingType(message.type);
    // Chasing a debt that is already open: this recipient owes this sender an
    // answer IN THIS THREAD and is being asked again. Worth a turn, and worth
    // a bill — the pairing is what makes a chase a decision instead of a
    // reflex.
    //
    // Thread-scoped deliberately, and it is not a detail. Without the thread
    // test, "this seat owes me something, anything" made every subsequent ask
    // an interrupt: three unrelated questions to one busy colleague classed
    // one `deliver` and two `interrupt`, so in a mesh where seats habitually
    // owe each other work the expensive class becomes the default and the
    // pricing inverts — which is the failure this whole move exists to close.
    // A different question is a new ask; the same thread asked twice is a
    // chase.
    if (obliging) {
      for (const pending of this.state.pendingRequests.values()) {
        if (pending.from !== message.from) continue;
        if (pending.threadId !== message.threadId) continue;
        if (message.to.some((t) => stillOwes(pending, t))) return "interrupt";
      }
    }
    // A collab is bounded at open and dies on its box. An accrued collab is a
    // discussion nobody is ever woken to continue, so every session would run
    // to its edge and raise an overrun card — D1's failure reached by another
    // route. Coalescing keeps the conversation moving and still prices it: a
    // burst of chatter costs one turn instead of one per line.
    if (control?.mode === "collab") return "deliver";
    if (obliging) return "deliver";
    // Consequence, which is a different axis from obligation and used to be
    // missing entirely. Everything above this line asks "does someone owe an
    // answer?"; a HANDOFF, a DELEGATE or a verdict owes nothing and is the
    // whole reason the recipient's next turn should look different. Without
    // this, all eight fell to `accrue` — no wake, and no nudge either, since
    // the sweep chases only `interrupt` — so work moved to a seat that was
    // never told, and the sender's discharged ask meant nothing ever noticed.
    //
    // `deliver` rather than `interrupt`, deliberately. There is no debt here
    // and so nothing to chase, and the recipient is not parked on a specific
    // answer the way a `replyTo` creditor is; coalescing a burst of handoffs
    // into one turn is exactly right, and it keeps the expensive class for
    // mail someone is actually blocked on.
    //
    // Asked of the MESSAGE, not of `message.type`. For `TEST_RESULT` and
    // `SECURITY_FINDING` the type name is the same word for opposite events,
    // and the one that hands work back is the one the type-only question could
    // not see — see `isAdverseVerdict`. That gap had a documented happy path
    // running through it: `PATCH_READY` obliges nothing, so QA's verdict had no
    // `replyTo` creditor, and a red build accrued in silence.
    if (movesWorkMessage(message)) return "deliver";
    return "accrue";
  }

  /**
   * Why this sender cannot buy the wake it is asking for, or `undefined` when
   * it can.
   *
   * Read before the send is a fact, unlike the charge it guards, because this
   * one has to change the ENVELOPE -- it is the difference between a price and
   * a receipt. See the call site in `sendMessage` for why the refusal lands on
   * the class rather than on the message.
   *
   * Returns a sentence rather than a boolean because the sender reads it: an
   * exhausted line and a mis-set `interrupt_cost_tokens` call for opposite
   * responses from whoever sees it, and a `false` cannot tell them apart.
   *
   * Not a reservation. Nothing is held against the line here, and the charge
   * still lands in `chargeInterrupt` after the send succeeds -- so a message
   * that fails validation or a policy gate still bills nobody, which is the
   * property the post-emit charge exists to protect. The window between the
   * two is one turn of one seat; two interrupts racing inside it can both be
   * refused or both allowed against the same headroom, which costs at most one
   * interrupt and never a message.
   */
  /**
   * Readable mail in a seat's box, NOT counting one message.
   *
   * `readableMailDepth` answers "how much can this seat open", which is the
   * right question everywhere else and the wrong one here by exactly one
   * message. The pre-flight quote runs before the send; the charge runs after
   * the reducer has already pushed this message into the recipient's box. Ask
   * the same question at both moments and the answers differ by one, which is
   * enough to cross a tier boundary -- so the sender would be quoted one price
   * and billed another, for a surcharge its own message caused. Excluding the
   * message being priced makes the two agree and prices only the queue the
   * sender is adding to.
   */
  private pricedMailDepth(agentId: string, selfMessageId?: string): number {
    const box = this.state.unread.get(agentId);
    if (!box?.length) return 0;
    let n = 0;
    for (const id of box) {
      if (id === selfMessageId) continue;
      if (this.state.messages.has(id)) n += 1;
    }
    return n;
  }

  /**
   * What waking these recipients costs this sender, right now.
   *
   * The single place the tariff is computed, called by both the pre-flight
   * refusal and the charge that lands afterwards. One function rather than
   * two agreeing ones: the doc on `interruptUnaffordable` already concedes a
   * one-turn race between quote and charge, and two separately-maintained
   * price lists would widen that from a race into a drift.
   *
   * Two things make the price differ from `price * recipients.length`:
   * congestion (a backed-up seat costs more to wake) and the per-turn digest
   * (a wake already bought this turn costs nothing, because the scheduler
   * will not sell a second one).
   *
   * The digest's premise, stated exactly so the bound is visible: the
   * scheduler collapses a second activation for a seat that is QUEUED (it
   * raises the priority of the entry already there) or BUSY (it records one
   * re-run for after the turn). It does not collapse an activation for a seat
   * that has since gone idle -- so a recipient that starts AND finishes a turn
   * while the sender is still inside its own would sell a second turn that
   * this ledger gives away. That window is the sender's own turn, it needs the
   * recipient to complete inside it, and erring here costs one free wake;
   * erring the other way bills for turns nobody gets, which is the defect this
   * exists to fix. Priced as the common case, deliberately.
   */
  private interruptCost(
    from: string,
    recipients: string[],
    selfMessageId?: string,
  ): { total: number; priced: string[] } {
    const regime = this.config.bus.deliveryClasses;
    const price = regime?.interruptCostTokens ?? 0;
    const bought = this.wakesBoughtThisTurn.get(from);
    let total = 0;
    const priced: string[] = [];
    for (const t of recipients) {
      if (bought?.has(t)) continue;
      const depth = this.pricedMailDepth(t, selfMessageId);
      const mult = interruptSurcharge(depth, regime?.congestionEvery);
      total += price * mult;
      priced.push(mult > 1 ? `${t} (${depth} unread, x${mult})` : t);
    }
    return { total, priced };
  }

  private interruptUnaffordable(from: string, goalId: GoalId, recipients: string[]): string | undefined {
    const regime = this.config.bus.deliveryClasses;
    // No regime, or a regime with no attention line: nothing to refuse
    // against. This is the branch that keeps the change additive -- a mesh
    // that enabled `classes` and never wrote `attention_tokens` behaves as it
    // did, including the tariff landing on the agent line.
    if (!regime || regime.attentionTokens === undefined) return undefined;
    // Free interrupts are not rationed: at a price of zero the line can never
    // run out, and a check that could still refuse would make `0` mean the
    // opposite of what `interrupt_cost_tokens: 0` has always meant.
    if (regime.interruptCostTokens <= 0) return undefined;
    // An operator's interrupt is the operator's prerogative. It has no agent
    // line to land on, so it has no attention line to be refused by.
    if (from === HUMAN_AGENT_ID) return undefined;
    const woken = recipients.filter((t) => t !== from && t !== HUMAN_AGENT_ID);
    if (woken.length === 0) return undefined;
    const { total: cost, priced } = this.interruptCost(from, woken);
    // Every wake here was already bought earlier in this turn, so this send
    // moves nobody who is not already moving and costs nothing to refuse
    // against.
    if (cost <= 0) return undefined;
    const limit = regime.attentionTokens;
    const ledger = this.state.budgets.get(attentionKey(goalId, from));
    const spent = (ledger?.consumed ?? 0) + (ledger?.reserved ?? 0);
    if (limit - spent >= cost) return undefined;
    // Names the recipients and their surcharges rather than just counting
    // seats. Under congestion pricing the cost no longer follows from the
    // seat count, so "N tokens to wake 2 seat(s)" would read as an
    // unexplained price jump for the same two seats -- and the one thing the
    // sender can act on is WHICH seat is backed up.
    return `attention budget exhausted (${spent}/${limit}); ${cost} tokens needed to wake ${priced.join(", ")}`;
  }

  /**
   * Bill the sender for the turns its interrupt just bought.
   *
   * The asymmetry this closes: a send costs the sender nothing and costs each
   * recipient a full model turn, so the cheapest act in the mesh spends the
   * most expensive resource another seat has and no ledger anywhere records
   * it. Priced per recipient woken, because an interrupt addressed to three
   * seats buys three turns.
   *
   * Never on the mission line: that is the record of what the mission really
   * spent, and a tariff added there would make that number a fiction. The
   * recipient's real turn is still charged where it is really spent, when it
   * runs.
   *
   * On the sender's ATTENTION line when the mesh declared one, and on its
   * agent line when it did not. What a seat may spend thinking and what it may
   * spend making someone else think are different budgets: charged to the same
   * line, an interrupt-happy seat exhausts the budget it needs to work, so the
   * degradation lands on the wrong resource and the wrong party.
   *
   * Deliberately NOT priced from `message.budgetHint`, the one envelope field
   * that already gestures at the cost of a send. `budgetHint` arrives in
   * `input`, is agent-written, and is not among the reserved keys — so a
   * sender that set the price of its own interrupt could set it to zero.
   * (It stays declared and, as before this change, read by nothing on the
   * message envelope; the identically-named field on delegate/create_task is
   * a different thing and still read.)
   */
  private async chargeInterrupt(message: MeshMessage, goalId: GoalId, correlationId?: string): Promise<void> {
    if (message.control?.delivery !== "interrupt") return;
    const price = this.config.bus.deliveryClasses?.interruptCostTokens ?? 0;
    if (price <= 0) return;
    // An operator's interrupt is the operator's prerogative and has no agent
    // line to land on.
    if (message.from === HUMAN_AGENT_ID) return;
    const woken = message.to.filter((t) => t !== message.from && t !== HUMAN_AGENT_ID);
    if (woken.length === 0) return;
    // Where the tariff lands. With an attention line configured it goes there
    // and only there: what a seat may spend thinking and what it may spend
    // making someone ELSE think are different budgets, and charging the second
    // to the first is what made an over-interrupting seat unable to work.
    // Without one, the agent line, exactly as before this key existed.
    const line =
      this.config.bus.deliveryClasses?.attentionTokens !== undefined
        ? attentionKey(goalId, message.from)
        : agentKey(goalId, message.from);
    const { total, priced } = this.interruptCost(message.from, woken, message.id);
    // Record the wakes before the early return, not after: a second interrupt
    // to the same seat this turn must be free whether or not this one was
    // billable.
    const bought = this.wakesBoughtThisTurn.get(message.from) ?? new Set<string>();
    for (const t of woken) bought.add(t);
    this.wakesBoughtThisTurn.set(message.from, bought);
    if (total <= 0) return;
    await this.deps.budget.consume(
      line,
      "tokens",
      total,
      undefined,
      { reason: "interrupt", messageId: message.id, messageType: message.type, woke: woken, priced, unitTokens: price },
      { actorId: message.from, goalId, correlationId },
    );
  }

  /**
   * This sender's per-turn send budget, or `undefined` when nothing rations it.
   *
   * `undefined` is today's behaviour and it is reachable three ways, each for
   * its own reason:
   *
   *  - `0` in config. The off switch, spelled the way `digest_threshold` and
   *    `inform_expiry_ms` spell theirs.
   *  - the human operator, whose sends are its prerogative and have no agent
   *    turn behind them to ration in the first place.
   *  - a sender with no turn in flight. `sendMessage` is called from sweeps,
   *    watchdogs, recovery and the CLI, and none of those is "a seat's turn
   *    spent its budget"; a rule keyed on the turn is the whole point, and a
   *    send that has no turn is not one.
   *
   * The flush is exempt rather than merely immune: the digest is emitted from
   * inside the flush, and a digest that counted would be held and flushed
   * again.
   */
  private sendBudgetFor(from: string): number | undefined {
    if (this.flushingSends.has(from)) return undefined;
    if (from === HUMAN_AGENT_ID) return undefined;
    const budget = this.config.messages.maxSendsPerTurn;
    if (budget <= 0) return undefined;
    if (!this.liveTurnByAgent.has(from)) return undefined;
    return budget;
  }

  /**
   * May this send be batched into the turn-end digest, or must it go out as
   * itself however far past the budget the turn is?
   *
   * The question is not "is this message cheap" but "does batching it change
   * what it means", and the answer is yes for five classes of envelope. Each is
   * excluded here rather than in a caller, so every path -- op, MCP tool, HTTP
   * -- is judged by one rule:
   *
   *  - an ASK (`obligesRecipients`) or a WORK-MOVING message
   *    (`movesWorkMessage`): the two things a digest cannot carry. An ask opens
   *    a ledger entry per recipient with its own contract, deadline and thread,
   *    and the runtime derives semantic events from it (`review.requested` per
   *    artifact, task binding, criterion evidence); a HANDOFF or a verdict is
   *    the whole reason the recipient's next turn differs. Both go out as
   *    themselves. This is the one place the catalogue's predicates decide
   *    routing, and it is the same pair `classifyDelivery` prices with.
   *  - an ANSWER (`replyTo`): the reducer looks the id up in
   *    `pendingRequests` to DISCHARGE the ask it answers, so folding one into a
   *    digest would leave a debt open that was settled in prose.
   *  - an URGENT: the sender said, in so many words, that it wants a turn
   *    bought now. A budget that overrides an explicit URGENT is a budget that
   *    silently drops the one class of mail the sender ranked above the rest.
   *  - `control.mode` (collab, broadcast): both carry their own distribution.
   *    A broadcast is narrowed to declared interests by an operator's config,
   *    and a collab mints the thread the bounded session binds to -- neither
   *    survives being re-addressed to a union of recipients.
   *  - anything addressed to the operator. The human seat is outside the mesh's
   *    attention economy, and a notice to it that arrived as an entry in a
   *    digest aimed mostly at seats would be the one message in the batch the
   *    operator was never told about.
   */
  private mergeableSend(
    input: { type: MessageType; replyTo?: string; priority?: MeshMessage["priority"]; payload?: unknown },
    recipients: string[],
    control?: MessageControl,
  ): boolean {
    if (control?.mode) return false;
    if (input.replyTo) return false;
    if (input.priority === "URGENT") return false;
    // `recipients`, not `input.to`: a REDIRECT policy may have sent this to the
    // operator instead of the seat it was addressed to, and the operator's mail
    // is never batched.
    if (recipients.includes(HUMAN_AGENT_ID)) return false;
    if (obligesRecipients({ type: input.type })) return false;
    if (movesWorkMessage({ type: input.type, payload: input.payload })) return false;
    return true;
  }

  /**
   * The sentence the sender reads when its turn's chatter is batched.
   *
   * Sent ONCE per turn, on the send that crosses the line, and phrased as data
   * about what happened rather than as a refusal: the message is not refused, it
   * is delayed and merged, and a seat that reads this as a failed send will send
   * the same thing again -- which is the loop `deliveryDowngraded` exists to
   * prevent one screen over. Repeating it on every held send would spend the
   * budget's savings on the seat's own context, which is the resource the budget
   * is protecting.
   */
  private heldSendNotice(budget: number, to: string[]): string {
    return (
      `held for the turn-end digest: this turn has sent ${budget} message(s) (mesh.messages.max_sends_per_turn=${budget}). ` +
      `Everything FYI-class it sends from here is merged into ONE digest for ${to.join(", ")} and delivered when the turn ends — ` +
      `the content is not lost and not refused. Asks, verdicts, handoffs and URGENT mail are never held. Do not send it again.`
    );
  }

  /**
   * Deliver the chatter a turn held back, as one digest, at the end of the turn.
   *
   * Called from `runTurn`'s `finally`, which is the only block every way a turn
   * can end passes through, and before the turn bookkeeping is torn down so the
   * digest is correlated to the turn that produced it. Nothing may be silently
   * dropped: a turn that timed out mid-flight still ships what it had written.
   *
   * ONE message, addressed to the union of every held message's recipients,
   * carrying each held message whole -- type, recipients, thread, priority,
   * artifact refs, requirements, note and payload -- as an entry. Not a summary
   * of them: the entry is what the recipient reads, and a reader who has to call
   * for the body is a reader who might not.
   *
   * An INFORM deliberately. The digest obliges nobody and moves no work by
   * construction (that is what made each entry mergeable), and INFORM is the
   * type that says so, so the ledger opens nothing for it and
   * `classifyDelivery` classes it `accrue` on a mesh with a delivery regime --
   * a batch of FYIs cannot buy a wake per line through the back door.
   *
   * If the digest is refused -- a communication rule written against the union
   * but not against each addressee is the realistic case -- the entries are
   * replayed one by one instead. The fallback is the honest one: batching is an
   * optimisation, and an optimisation that can lose a message the seat wrote is
   * worse than the traffic it saves.
   */
  private async flushHeldSends(agentId: string): Promise<void> {
    const held = this.heldSendsThisTurn.get(agentId);
    if (!held || held.length === 0) return;
    this.heldSendsThisTurn.delete(agentId);
    // Every one of these was checked by policy on the way in, against its own
    // recipients; the union is what a digest can honestly address.
    const recipients = [...new Set(held.flatMap((h) => h.to))];
    this.flushingSends.add(agentId);
    try {
      const res = await this.sendMessage({
        from: agentId,
        to: recipients,
        type: "INFORM",
        newThread: { subject: `digest: ${held.length} batched message(s) from ${agentId}` },
        payload: {
          digest: true,
          count: held.length,
          batchedBy: "mesh.messages.max_sends_per_turn",
          // Entries in send order, so the digest reads the way the turn ran.
          entries: held.map((h) => ({
            type: h.type,
            to: h.to,
            ...(h.threadId ? { threadId: h.threadId } : {}),
            ...(h.subject ? { subject: h.subject } : {}),
            ...(h.priority ? { priority: h.priority } : {}),
            ...(h.artifactRefs ? { artifactRefs: h.artifactRefs } : {}),
            ...(h.requires ? { requires: h.requires } : {}),
            ...(h.note ? { note: h.note } : {}),
            payload: h.payload ?? {},
          })),
        },
        note: `One digest standing for ${held.length} message(s) this turn sent past its send budget. Each entry names its own recipients, thread and body. Nothing here obliges you or moves work: asks, verdicts, handoffs and URGENT mail are never batched.`,
      });
      if (res.accepted) {
        this.auditLine(`send budget: ${agentId} batched ${held.length} message(s) into digest ${res.messageId ?? "?"} for ${recipients.join(", ")}`);
        return;
      }
      this.auditLine(`send budget: digest for ${agentId} was refused (${res.reason}); replaying ${held.length} message(s) individually`);
      for (const h of held) {
        await this.sendMessage({
          from: agentId,
          to: h.to,
          type: h.type,
          ...(h.threadId ? { threadId: h.threadId } : {}),
          ...(h.subject && !h.threadId ? { newThread: { subject: h.subject } } : {}),
          ...(h.artifactRefs ? { artifactRefs: h.artifactRefs } : {}),
          payload: h.payload,
          ...(h.note ? { note: h.note } : {}),
          ...(h.priority ? { priority: h.priority } : {}),
          ...(h.requires ? { requires: h.requires } : {}),
        }).catch((err) => this.auditLine(`send budget: replay for ${agentId} failed: ${(err as Error).message}`));
      }
    } catch (err) {
      // A flush that throws must not take the turn's own bookkeeping with it --
      // this runs inside a `finally`.
      this.auditLine(`send budget: flush for ${agentId} failed: ${(err as Error).message}`);
    } finally {
      this.flushingSends.delete(agentId);
    }
  }

  async sendMessage(input: {
    from: string;
    to: string[];
    type: MessageType;
    goalId?: GoalId;
    threadId?: string;
    newThread?: { subject: string; artifactRefs?: Array<ArtifactRef | string>; parentThreadId?: string };
    replyTo?: string;
    artifactRefs?: Array<ArtifactRef | string>;
    payload?: unknown;
    /**
     * Prose for the recipient, never parsed. NOT inside `payload`, because
     * every payload key is live -- see `MeshMessage.note`. Unlike `control`
     * this one is genuinely agent-supplied, so it travels in `input` where the
     * sanitiser screens it rather than in the runtime-only second argument.
     */
    note?: string;
    priority?: MeshMessage["priority"];
    taskId?: string;
    causationId?: string;
    correlationId?: string;
    requires?: { id: string; text: string }[];
    budgetHint?: { maxTokens?: number; maxTurns?: number };
  },
  /**
   * Envelope fields only the runtime may set. Deliberately a SEPARATE
   * argument rather than a field on `input`: everything in `input` goes
   * through `sanitizeAgentMessageInput` on the next line, which is what makes
   * forgery structurally impossible, so a runtime-owned value cannot travel
   * in the same object it is being protected from.
   */
  runtime?: { control?: MessageControl },
  ): Promise<SendResult> {
    // Every send — agent turn, MCP tool, HTTP API — funnels through here, so
    // this is the one place runtime-owned fields must be stripped off caller
    // input. Structural: after this line no forged `control` (or a forged
    // copy hidden in `payload`) exists to be read further down.
    input = sanitizeAgentMessageInput(input);
    // MCP tools and prose ops declare refs as `artifact://` strings; the wire
    // schema wants {uri,...} objects. Normalize once here — the choke point
    // every sender (agent turn, MCP bus, HTTP) passes through.
    //
    // Bare ids and content refs are resolved to the artifact's URI on the way:
    // every other tool takes an `art-…` id, so seats pass one here too — all 4
    // uri rejections in the 2026-09-25 run did, and the one bad ref refused the
    // whole message around it.
    const refToUri = (ref: string): string | undefined => {
      const byId = this.state.artifacts.get(ref);
      if (byId) return artifactUri(byId.type, byId.name, byId.version);
      // A content ref names one VERSION, so it is looked up in the history.
      for (const versions of this.state.artifactHistory.values()) {
        const v = versions.find((x) => x.contentRef === ref);
        if (v) return artifactUri(v.type, v.name, v.version);
      }
      return undefined;
    };
    const messageRefs = normalizeArtifactRefs(input.artifactRefs, refToUri);
    const newThreadRefs = normalizeArtifactRefs(input.newThread?.artifactRefs, refToUri);
    const goalId = this.state.activeGoalId;
    if (!goalId) return { accepted: false, reason: "no active goal" };
    const ctx = { config: this.config, projections: this.state, goal: this.state.goals.get(goalId) };
    if (!this.state.agents.has(input.from)) return { accepted: false, reason: `unknown sender ${input.from}` };
    const targets = [...new Set(input.to)].filter((t) => t !== input.from);
    if (targets.length === 0) return { accepted: false, reason: "no recipients (self-addressed messages are dropped)" };

    for (const t of targets) {
      if (!this.state.agents.has(t) && t !== "all") return { accepted: false, reason: `unknown recipient ${t}` };
    }

    // A reply belongs to the thread of the message it answers, and must be
    // judged there. The contact check below only recognises a reply by its
    // `threadId`, so a send carrying `replyTo` and no thread was judged as a
    // NEW contact: ux-designer answering marketing's own review ask was told it
    // may not "initiate contact" with marketing (seq 217). Derived before the
    // policy check, and only from a thread that still exists. An explicit
    // `newThread` still opens one — but the reply is judged as a reply.
    const repliedTo = input.replyTo ? this.state.messages.get(input.replyTo) : undefined;
    const liveThread = (id: string | undefined) => (id && this.state.threads.has(id) ? id : undefined);
    if (repliedTo && !liveThread(input.threadId) && !input.newThread && liveThread(repliedTo.threadId)) {
      input = { ...input, threadId: repliedTo.threadId };
    }
    const policyThreadId = liveThread(input.threadId) ?? liveThread(repliedTo?.threadId) ?? input.threadId ?? "";
    const policy = this.deps.policy.evaluateMessage(input.from, targets, { type: input.type, threadId: policyThreadId, payload: input.payload, taskId: input.taskId }, ctx);
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

    /**
     * The per-turn send budget, applied where it can still change what leaves
     * the building and after the policy gate that could refuse the send
     * outright -- a denied message is not a message the seat spent budget on.
     *
     * Held HERE, before the thread is resolved or created, deliberately: a held
     * message that opened a thread would leave a `thread.created` with no
     * message in it, and a thread nobody can read is exactly the kind of
     * half-fact this ledger exists to avoid.
     *
     * Nothing is dropped. What is held is delivered by `flushHeldSends` at the
     * end of this same turn, in one digest, and the seat is told on the spot so
     * it does not read silence as a failed send (see `heldSendNotice`).
     */
    const budget = this.sendBudgetFor(input.from);
    if (budget !== undefined && !runtime?.control?.delivery) {
      // Runtime bookkeeping is not the seat's speech. A retraction notice, a
      // discharge notice and the wait-cycle release all ship with a class the
      // runtime stamped (`control.delivery`), and none of them is a message the
      // seat decided to write -- counting them would let the runtime's own
      // ledger traffic exhaust a seat's turn.
      const sent = (this.sendsThisTurn.get(input.from) ?? 0) + 1;
      this.sendsThisTurn.set(input.from, sent);
      if (sent > budget && this.mergeableSend(input, recipients, runtime?.control)) {
        const held = this.heldSendsThisTurn.get(input.from) ?? [];
        held.push({
          type: input.type,
          to: recipients,
          ...(input.threadId ? { threadId: input.threadId } : {}),
          ...(input.newThread?.subject ? { subject: input.newThread.subject } : {}),
          // The NORMALIZED refs, not the caller's spelling: `messageRefs` is
          // what the envelope would have carried, so the digest entry and the
          // message it stands for name the same artifact the same way. A bare
          // `art-…` id would otherwise reach a reader in a form only
          // `sendMessage` knows how to resolve.
          ...(messageRefs ? { artifactRefs: messageRefs } : {}),
          ...(input.note ? { note: input.note } : {}),
          payload: input.payload ?? {},
          priority: input.priority ?? "NORMAL",
          ...(input.requires ? { requires: input.requires } : {}),
        });
        this.heldSendsThisTurn.set(input.from, held);
        // Told once per turn, on the send that crosses the line. Repeating it
        // on every held send would spend the budget's savings on the seat's own
        // context, which is the resource the budget is protecting.
        return {
          accepted: true,
          merged: true,
          ...(sent === budget + 1 ? { reason: this.heldSendNotice(budget, recipients) } : {}),
        };
      }
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
        artifactRefs: newThreadRefs ?? messageRefs ?? [],
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
      artifactRefs: messageRefs ?? [],
      payload: input.payload ?? {},
      // Length is already policed by the schema's `maxLength`; a note longer
      // than the cap is REFUSED by name at validation, not quietly truncated.
      note: input.note,
      priority: input.priority ?? (recipients.some((r) => this.config.agents[r]?.mode === "service") ? "HIGH" : "NORMAL"),
      taskId: input.taskId,
      requires: input.requires,
      budgetHint: input.budgetHint,
      provenance:
        input.from === HUMAN_AGENT_ID
          ? { source: "human", trustLevel: 100 }
          : { source: "agent", trustLevel: 50 },
    };
    if (runtime?.control) {
      // Applied here: after `sanitizeAgentMessageInput` stripped whatever the
      // caller supplied, and before `validateMessage`, so the closed `control`
      // property set in the message schema actually covers these fields.
      message.control = { ...(message.control ?? {}), ...runtime.control };
    }
    // Derived here, on the same seam and for the same reason: after the
    // caller's `control` is gone and before `validateMessage`, so the closed
    // property set covers the class too. It reads `mode`, so it must follow
    // the merge above rather than precede it.
    let delivery = this.classifyDelivery(message, !!cacheHit);
    // The price, applied while it can still change the envelope.
    //
    // `chargeInterrupt` below runs after the send is a fact, and deliberately
    // so -- but a charge that can only be levied after the wake was already
    // bought is a receipt, not a price. Every mesh with a tariff therefore had
    // exactly one way to stop a seat interrupting by habit: the seat would
    // exhaust its own agent line and the `budget` rule would stop activating
    // IT. That worked, and punished the wrong thing -- the seat lost the
    // ability to work rather than the ability to interrupt, and nothing could
    // tell those apart on one ledger.
    //
    // So the refusal happens here, before the emit, and it refuses the WAKE
    // rather than the message. Nothing in this mesh is a suppressed delivery:
    // the envelope ships, the mail lands, the commitment opens, the recipient
    // reads it on its next turn for any other reason. Only the class changes.
    let downgraded: string | undefined;
    if (delivery === "interrupt") {
      const afford = this.interruptUnaffordable(input.from, goalId, recipients);
      if (afford) {
        downgraded = afford;
        delivery = "deliver";
      }
    }
    if (delivery) message.control = { ...(message.control ?? {}), delivery };
    // Stamped after `delivery` so the closed schema covers it, and only on the
    // refusal path -- an absent field is the normal case, and a boolean would
    // have made every message carry the answer to a question nobody asked.
    if (downgraded) message.control = { ...(message.control ?? {}), downgraded };
    if (message.replyTo && !this.state.messages.has(message.replyTo)) {
      return { accepted: false, reason: `replyTo ${message.replyTo} not found` };
    }
    if (message.replyTo && this.state.messages.get(message.replyTo)?.control?.mode === "broadcast") {
      // A broadcast is an announcement, not an ask: it opens no commitment,
      // so a reply to one has nothing to discharge and no deadline to meet.
      // Refused rather than quietly re-typed, because N seats each replying
      // to one announcement is precisely the N-way chatter this mode exists
      // to avoid. A seat with something to say opens its own ask.
      return { accepted: false, reason: "cannot reply to a broadcast; open a request instead" };
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
    // After the send is a fact, never before: a charge raised on a message
    // that then failed validation or a policy gate would bill a sender for an
    // interrupt that woke nobody.
    await this.chargeInterrupt(message, goalId, correlationId);

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
      return { accepted: true, messageId: message.id, eventId: evt.id, deliveryDowngraded: downgraded };
    }

    // derived semantic events. A caveat here is the message landing while
    // saying less than the sender thinks (a verdict typed as a message), so it
    // rides back as `reason` on an ACCEPTED send, the way an inert approval's
    // does on an ok op -- the respond op used to return a bare ok:true.
    const caveat = await this.deriveSemantic(input.from, message, evt.id, correlationId);
    return {
      accepted: true,
      messageId: message.id,
      eventId: evt.id,
      redirectedTo: policy.decision === "REDIRECT" ? recipients : undefined,
      deliveryDowngraded: downgraded,
      ...(caveat ? { reason: caveat } : {}),
    };
  }

  /**
   * The verdict a seat has already RECORDED on this artifact, in the direction
   * given, or undefined. Records are dropped when a new version lands
   * (`artifact.versioned`), so a hit is always on the current version.
   */
  private priorVerdict(actorId: string, artifactId: string, direction: "approve" | "reject") {
    const kinds = direction === "approve" ? ["approve", "pass"] : ["reject"];
    return [...this.state.approvals.values()].flat().find((r) => r.actorId === actorId && r.artifactId === artifactId && kinds.includes(r.kind));
  }

  private async deriveSemantic(from: string, m: MeshMessage, causationId: string, correlationId?: string): Promise<string | undefined> {
    const goalId = m.goalId;
    const corr = correlationId ?? this.turnCorrelation(from);
    const primary = m.artifactRefs[0]?.uri;
    if (m.type === "REQUEST_REVIEW") {
      // One REQUEST_REVIEW may carry SEVERAL artifacts, and only the first ref
      // used to resolve. An architect who published seven documents and asked
      // for one review got one `review.requested`: six artifacts never left
      // READY_FOR_REVIEW, and the approval reducer's status guard then ignored
      // every sign-off they were later given. Ask per artifact, so each one
      // reaches the state its own review was requested in.
      const targets: Array<{ uri: string | undefined; art: Artifact | undefined }> = [];
      for (const ref of m.artifactRefs) {
        const art = ref.uri ? this.findArtifactByUri(ref.uri) : undefined;
        if (art) targets.push({ uri: ref.uri, art });
      }
      // A request whose refs resolve to nothing is still an ask worth
      // recording — it is how a review asked for in prose alone reaches the
      // reviewer's mailbox, and dropping it would strand the asker.
      if (targets.length === 0) targets.push({ uri: primary, art: undefined });
      for (const { uri, art } of targets) {
        const before = art ? this.state.artifacts.get(art.id)?.status : undefined;
        await this.deps.kernel.emit("review.requested", { artifactId: art?.id, artifactRef: uri, reviewers: m.to, messageId: m.id, subject: m.payload }, { actorId: from, goalId, causationId, correlationId: corr });
        await this.auditTransition(art?.id, m.id, goalId, corr, undefined, before);
        // No `design.question` here any more. Every review of an
        // ArchitectureDocument or ApiSpec used to emit one ("Review X vN"), which
        // is a restatement of the ask and not a question: nothing answered it,
        // no ledger entry closed with the review, and seats with a
        // `design.question` interest were woken for it. explorer was woken twice
        // by one of them after the version it named had been superseded, and
        // spent 812k tokens (12% of the 2026-09-25 mission) on self-directed
        // work. The event type stays in the catalogue for a genuine design
        // question and for replaying older logs.
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
      // Resolve the way every other artifact-bearing message here does:
      // `payload.artifactId` first, then the structured ref. Resolving
      // `m.artifactRefs[0]` alone made a patch announced in prose a SILENT
      // no-op — `patch.ready` went out with `artifactId: undefined`, nothing
      // transitioned, and the sender, seeing no result, announced the same
      // patch again turn after turn. One mission lost six announcements over
      // twelve hours this way.
      //
      // The repeats are not the sender's only problem: an empty `artifactRefs`
      // is also absent from the message fingerprint (see `fingerprintOf`), so
      // announcements about *different* patch revisions collide, the loop
      // counter over shared asks crests its threshold, and the mission freezes
      // on a `fingerprint_loop` that reports a looping agent where in fact only
      // an unidentified artifact was going nowhere. Fix the resolution and both
      // symptoms go: each revision refs differently and stops colliding.
      //
      // An unresolvable announcement is therefore refused and recorded, for the
      // same reason a refused BLOCK is: the artifact cannot move from here (the
      // transition this would have triggered needs an id this message does not
      // have), and a `patch.ready` naming no patch is indistinguishable in the
      // log from one that deliberately named none. The message itself is still
      // logged and delivered — it is a report, not a verdict.
      //
      // Recorded is not the same as delivered: `message.rejected` has no
      // projection and no mailbox (the case in projections-messaging is a
      // no-op), so the operator reads this on the dashboard and via
      // `mesh_failures`, while the SENDER's context never carries it. Left
      // there, an agent that keeps announcing an unidentified patch walks
      // straight into the loop detector without ever being told why. So the
      // refusal is also WOKEN back to the sender with the fix in the note —
      // the same wake-with-note `dischargeCommitment` uses to report a closed
      // ask. Best-effort: a sender that is suspended, completed, or the human
      // seat simply cannot be woken, and the recorded denial still stands.
      const art = artifactForRef(this.state, (m.payload as any)?.artifactId, primary);
      if (!art) {
        const why =
          'PATCH_READY named no artifact the mesh can resolve, so no reviewer was asked and the patch did not move. Announce it by ref: artifactRefs: [{ uri: "artifact://<Type>/<name>/<version>" }], or payload.artifactId.';
        await this.denied(from, (m.payload as any)?.artifactId ?? primary, "announce patch", {
          decision: "DENY",
          reason: why,
          ruleId: "patch.ready.unresolved-artifact",
        });
        const notifyKey = `${from}:${(m.payload as any)?.artifactId ?? primary ?? ""}`;
        if (!this.patchRefusalNotified.has(notifyKey)) {
          this.patchRefusalNotified.add(notifyKey);
          await this.activateAgent(from, { kind: "recovery", note: `patch announcement refused: ${why}`, messageId: m.id }).catch(() => undefined);
        }
      } else {
        const before = this.state.artifacts.get(art.id)?.status;
        await this.deps.kernel.emit(
          "patch.ready",
          { artifactId: art.id, artifactRef: primary ?? artifactUri(art.type, art.name, art.version), messageId: m.id },
          { actorId: from, goalId, causationId, correlationId: corr },
        );
        await this.auditTransition(art.id, m.id, goalId, corr, undefined, before);
      }
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
    // A verdict asserted in a MESSAGE is not a verdict.
    //
    // `APPROVE`, `REJECT` and `VETO` are valid message types and `deriveSemantic`
    // had no branch for any of them; nothing anywhere reads `payload.verdict`.
    // So a seat could write a full, reasoned approval — a recipient, an artifact
    // ref, a citation, a justification — and the artifact would not move, no
    // verdict would be recorded, and nothing would say so. Measured: 6 of 25
    // verdict assertions in one live run had no backing op. Two seats did it every
    // single time, while a third always used the op; it is a per-seat habit that
    // nothing corrected.
    //
    // Same shape as the two branches above: the message is still delivered (it is a
    // statement, and may carry reasoning a human wants), the refusal is recorded,
    // and the SENDER is woken with the remedy — because the recipient is not the
    // party who needs telling. Deduped per (sender, artifact) so a seat that keeps
    // doing it is woken once, not once per message.
    //
    // Two cases it used to get wrong, 10 of 10 denials in the 2026-09-25 run:
    //
    //  - the verdict WAS recorded. Seats `mesh_approve` and then `mesh_respond
    //    type:APPROVE` to close the ask; 7 of the 10 came after the same seat's op,
    //    were told "no signature was recorded" (false), and were woken to sign
    //    again — pm signed one v1 three times. So a matching verdict by the sender
    //    on the artifact (the message's, or the ask it replies to) ends it here.
    //  - the sender cannot record one at all. The remedy sent frontend into a
    //    48k-token turn whose `mesh_reject` was then refused. Told instead that the
    //    message stands as a comment, and not woken.
    //
    // The caveat is RETURNED as well, so it reaches the sender's tool result on
    // the same call rather than only its next wake.
    if (m.type === "APPROVE" || m.type === "REJECT" || m.type === "VETO") {
      const opName = m.type === "APPROVE" ? "approve" : m.type === "REJECT" ? "reject" : "veto";
      const askRefs = (m.replyTo ? this.state.messages.get(m.replyTo)?.artifactRefs : undefined) ?? [];
      const candidates = [
        artifactForRef(this.state, (m.payload as any)?.artifactId, primary),
        ...[...m.artifactRefs, ...askRefs].map((r) => artifactForRef(this.state, undefined, r.uri)),
      ].filter((a): a is Artifact => !!a);
      if (candidates.some((a) => this.priorVerdict(from, a.id, opName === "approve" ? "approve" : "reject"))) return undefined;
      const art = candidates[0];
      if (art && !this.mayRecordVerdict(from, art, opName)) {
        return (
          `a ${m.type} message records no verdict, and ${from} cannot record a ${opName} on ${art.type} "${art.name}" — ` +
          `it was delivered and stands as a comment. Do not re-issue it as \`mesh_${opName}\`; that would be refused.`
        );
      }
      const target = art ? `artifactId "${art.id}"` : 'the artifact\'s artifactId';
      const why =
        `a ${m.type} message records no verdict — the mesh reads verdicts only from the \`${opName}\` op, so nothing moved and no signature was recorded. ` +
        `Re-issue it as \`mesh_${opName}\` with a subject (the domain) and ${target}.`;
      await this.denied(from, art?.id ?? primary, `${opName} by message`, {
        decision: "DENY",
        reason: why,
        ruleId: "verdict.message-only",
      });
      const notifyKey = `verdict:${from}:${art?.id ?? primary ?? ""}`;
      if (!this.patchRefusalNotified.has(notifyKey)) {
        this.patchRefusalNotified.add(notifyKey);
        await this.activateAgent(from, { kind: "recovery", note: why, messageId: m.id }).catch(() => undefined);
      }
      return why;
    }
    if (m.type === "ESCALATE") {
      // already an explicit escalation op path; keep audit-only
    }
    return undefined;
  }

  /**
   * Could `recordDecision` record this seat's verdict on this artifact at all?
   *
   * The same two doors it opens, restated for a message that has no subject: a
   * `<domain>.<kind>` authority in ANY domain (the capacity signatures the gate
   * system rests on), or — for approve and reject — the power to settle the
   * artifact (`approverMayAdvance`). An owner approving its own work with a peer
   * available is shut out, as there.
   */
  private mayRecordVerdict(actorId: string, art: Artifact, kind: "approve" | "reject" | "veto"): boolean {
    if (actorId === HUMAN_AGENT_ID) return true;
    if (kind === "approve" && art.owner === actorId && this.hasPeerReviewer(actorId, art)) return false;
    const authority = this.state.agents.get(actorId)?.definition.authority ?? [];
    if (authority.some((a) => a === "*" || a.endsWith(`.${kind}`) || a.endsWith(".*"))) return true;
    return kind !== "veto" && approverMayAdvance(this.state, actorId, art, HUMAN_AGENT_ID);
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
          // `detail` is spread FIRST so a caller can never overwrite the
          // ledger's own fields. It used to come last, and a caller passing a
          // free-text `reason` in its detail silently rewrote the canonical
          // `DischargeReason` -- the reducer reads `p.reason` straight out of
          // this payload, so the ledger recorded a sentence where an enum
          // member belonged and every `PER_DEBTOR_/UNANSWERED_` membership
          // test on it quietly answered false.
          ...detail,
          messageId, reason, by, from: pending.from, to: pending.to, requestType: pending.type,
          ...(partial ? { partial: true, remaining: remainingAfter } : {}),
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
    // The one exception to all of the above: the actor closed its OWN ask.
    // Waking the asker to tell it what it just did is pure cost -- and worse
    // than noise, because the note below reads "your request closed: <why>",
    // so a self-close would state the action back to the seat that took it.
    // Computed here rather than guarded at the call site so every self-close
    // gets it, including a future one that does not arrive through `withdraw`.
    const selfClosed = by === pending.from;
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
    if (!selfClosed && pending.from !== HUMAN_AGENT_ID && this.state.agents.has(pending.from)) {
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
        : reason === "refused" ? `${by} declined it — do not re-ask the same agent; route it elsewhere or proceed without it`
        // Naming `by` rather than "the asker", because those are the same
        // seat only in the case that never reaches here: the asker closing its
        // own ask is `selfClosed` above, so the only withdrawal that wakes an
        // asker is one an operator performed on its behalf. Hard-coding "the
        // agent that asked for it" would then tell the asker it withdrew an
        // ask it is in fact waiting on.
        : reason === "withdrawn_by_sender" ? `${by} withdrew it — stop working on it; nobody owes an answer`
        : reason === "expired" ? "its deadline passed with no answer — treat it as UNANSWERED and decide without it or re-ask"
        // The one closing note that hands back an ANSWER. Quoted rather than
        // described, because the asker is being woken precisely to act on the
        // value, and "your default applied" would make it re-derive what it
        // had already told the mesh. Never re-ask on this one: the debtors
        // were offered a say and declined to use it, so a re-ask spends their
        // attention on a question already settled in their favour.
        : reason === "defaulted" ? `nobody objected by the deadline, so it stands as you said it would: ${JSON.stringify(pending.ifUnanswered?.assume) ?? "your stated default"} — proceed on that and do not re-ask`
        : reason === "refused_cap" ? "the ask ledger was full so it was never opened — re-ask once outstanding work drains"
        : "it was closed";
      await this.activateAgent(pending.from, {
        kind: "recovery",
        note: `your request ${messageId} (${pending.type}) closed: ${why} — check the outcome and drive the next step instead of waiting`,
      }).catch(() => undefined);
    }
    return true;
  }

  /**
   * Close an ask the actor itself raised.
   *
   * The credential is the exact opposite of `discharge`'s, which is why this is
   * its own op rather than a flag on that one: a refusal is authorized by OWING
   * the answer, a withdrawal by having ASKED the question. Requiring
   * `pending.from === actorId` is what stops a bystander voiding a colleague's
   * question -- the same abuse the debtor check exists to prevent, arriving
   * from the other end.
   *
   * The ledger work is `dischargeCommitment`'s, like every other exit. What is
   * NOT shared is who gets told: that path wakes the ASKER, and here the actor
   * is the asker, so it would be waking a seat to inform it of its own act.
   * The seat that needs the message is the DEBTOR, for whom "stop working on
   * this" is information it cannot get any other way -- a reviewer mid-review
   * on a withdrawn question is spending turns on cancelled work.
   */
  private async opWithdraw(actorId: string, op: MeshOpWithdraw, turn: TurnState): Promise<OpResult> {
    const pending = this.state.pendingRequests.get(op.messageId);
    if (!pending) {
      return { ok: false, op: op.op, reason: this.notOutstanding(op.messageId) };
    }
    if (pending.from !== actorId && actorId !== HUMAN_AGENT_ID) {
      // Names the creditor, not the debtors. The seat that tried this needs to
      // know WHOSE ask it was trying to close; who owed an answer has nothing
      // to do with why it was refused, and listing them invites the reading
      // that it is a dispute about the answer.
      return { ok: false, op: op.op, reason: `only ${pending.from}, who raised ${op.messageId}, may withdraw it` };
    }
    // Read the debtors BEFORE the discharge: that call deletes the entry this
    // reads from, and `released` is what the notice below is addressed to.
    const released = outstandingDebtors(pending).filter((d) => d !== HUMAN_AGENT_ID);
    // No `detail`, deliberately. Extra keys would ride into the
    // `commitment.discharged` event payload and stop there: the reducer builds
    // a `DischargeRecord` from a FIXED field list (`state.dischargeCommitment`),
    // so `note` and a `released` list would look persisted while nothing could
    // ever read them back. Both facts already have durable homes -- the reason
    // is on the event payload and in the notice below, and the released set is
    // `rec.to`, which for a whole-ask close IS the list of debtors let go.
    const closed = await this.dischargeCommitment(op.messageId, "withdrawn_by_sender", actorId);
    if (!closed) {
      // The discharge event did not reach the log, so the ask is still open.
      // Say so rather than sending a "stop working on this" notice for work
      // that is still owed.
      return { ok: false, op: op.op, reason: `could not close '${op.messageId}' — it is still open` };
    }
    if (released.length === 0) return { ok: true, op: op.op, reason: op.reason };

    // Stamped `accrue`, and this is a deliberate override rather than a
    // derivation. A retraction is a DE-escalation: the asker has decided the
    // answer does not matter, which is the one thing a wake is for, so buying
    // a turn per debtor to say "never mind" would make the cheap exit the most
    // expensive move in the exchange. The class suppresses the WAKEUP and never
    // the delivery -- the notice lands in every released debtor's mailbox and
    // is read on its next turn for any other reason, the same guarantee every
    // other class carries.
    const notice = await this.sendMessage(
      {
        from: actorId,
        to: released,
        type: "INFORM",
        // Both, deliberately, and this is the documented-safe combination:
        // `sendMessage` resolves a live thread first and only falls back to
        // opening one, so the notice lands in the thread that raised the ask
        // and still has a subject if that thread is somehow gone.
        threadId: pending.threadId,
        newThread: { subject: `withdrawn: ${pending.type} ${op.messageId}` },
        // `causationId` and NOT `replyTo`. They read alike and mean opposite
        // things: `replyTo` is what DISCHARGES an ask (the reducer looks the
        // id up in `pendingRequests` and settles the debt), so a retraction
        // carrying it would claim to be the answer to the question it is
        // cancelling. `causationId` says only that this message happens
        // because of that one, which is exactly true.
        causationId: op.messageId,
        payload: { withdrawn: true, request: op.messageId, requestType: pending.type, from: actorId, reason: op.reason },
        priority: "NORMAL",
      },
      // Runtime-owned control, the same door `broadcast` and `collab` use to
      // stamp `mode`: an agent cannot set this, and the scheduler reads it off
      // the envelope rather than out of agent-written JSON.
      actorId === HUMAN_AGENT_ID ? undefined : { control: { delivery: "accrue" } },
    );
    turn.sentOps++;
    return { ok: true, op: op.op, messageId: notice.messageId, reason: op.reason };
  }

  /**
   * Why `messageId` is not an open ask, as specifically as the ledger knows.
   *
   * "already answered, or never existed" named neither: pm discharged an ask 10
   * minutes after it had been closed `superseded` and was told nothing it could
   * act on. The discharge ring says how and by whom; a message that exists with
   * no ring entry was closed earlier than the ring remembers, or never obliged.
   *
   * No timestamp: the event carries it, and a reason that differs run to run
   * breaks the op-channel differential in `raw-output-e2e`.
   */
  private notOutstanding(messageId: string): string {
    const head = `no outstanding request '${messageId}'`;
    const rec = [...this.state.discharged].reverse().find((d) => d.messageId === messageId && !d.partial);
    if (rec) {
      const via = rec.viaMessageId ? ` (via ${rec.viaMessageId})` : "";
      return `${head}: it was closed '${rec.reason}' by ${rec.by}${via} — nobody owes an answer on it`;
    }
    const m = this.state.messages.get(messageId);
    if (!m) return `${head}: no message with that id exists in this mission`;
    // `isObligingType` plus the mode, i.e. `obligesRecipients`, which this file
    // does not import.
    if (!isObligingType(m.type) || (m.control?.mode ?? "service") !== "service") {
      return `${head}: it is a ${m.control?.mode && m.control.mode !== "service" ? `${m.control.mode} ` : ""}${m.type}, which obliges nobody`;
    }
    return `${head}: the ${m.type} from ${m.from} was closed earlier than the discharge record goes back`;
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
  /**
   * Mirror the post-reducer status of an artifact an approval just moved.
   *
   * `actorId` is who DID the thing, and it is not the same as the artifact's
   * owner. Falling back to `this.turnCorrelation(a.owner)` meant a reviewer's
   * approval of someone else's artifact was stamped with the OWNER's turn — which
   * is either undefined (the owner is idle) or, worse, a live and entirely
   * unrelated concurrent turn. The owner remains the last resort, because the
   * two `deriveSemantic` callers genuinely have no acting seat.
   *
   * The emit's own `actorId` stays `"system"`: the transition is the reducer's
   * doing, not the reviewer's. Only the correlation is being corrected.
   */
  private async auditTransition(
    artifactId: string | undefined,
    causationId: string,
    goalId: string,
    correlationId?: string,
    actorId?: string,
    before?: ArtifactStatus,
  ): Promise<void> {
    if (!artifactId) return;
    const a = this.state.artifacts.get(artifactId);
    if (!a) return;
    // `before` is the status the artifact held when the event that might have moved
    // it was emitted. Where the caller knows it and nothing moved, there is no
    // transition to record: 16 of the 28 `artifact.transition` events in the cronlite
    // run were these, "FINAL (derived)" on an artifact already FINAL, and their
    // `gateSatisfied` (asked of a same-status "transition") read false for no reason
    // a reader could use. Where something did move, the event says from where.
    if (before !== undefined && a.status === before) return;
    // `gateSatisfied` used to be the literal `true` on every one of this method's
    // call sites, which made it the one field that cannot answer the only question
    // it exists for. Worse, `mesh_stuck_artifacts` reads `gateSatisfied === false`
    // as its "gate blocked" signal, so a hardcoded true made an entire class of
    // walkback statistically invisible: measured 2026-09-23 and again 2026-09-24,
    // an APPROVED artifact was reset to DRAFT by its own author and then approved
    // twice MORE — every one of those transitions reporting a satisfied gate while
    // the artifact was in fact never reviewed in the state it ended up in.
    //
    // This path is derived bookkeeping, so it cannot refuse anything — the status
    // is already applied by the time it runs. But it can tell the truth about
    // whether the step it is mirroring would have passed a gate, which is what
    // makes the walkback findable afterwards.
    const gateSatisfied = this.deps.policy.evaluateTransition(a, a.status, actorId ?? a.owner, {
      config: this.config,
      projections: this.state,
    }).decision === "ALLOW";
    await this.deps.kernel
      .emit(
        "artifact.transition",
        { artifactId, to: a.status, ...(before !== undefined ? { from: before } : {}), derived: true, gateSatisfied },
        { actorId: "system", goalId, causationId, correlationId: correlationId ?? this.turnCorrelation(actorId ?? a.owner) },
      )
      .catch(() => undefined);
  }

  /**
   * `opts.explicit` marks the activation as operator-initiated, which is what
   * lets it through the scheduler's two "quiet refusal" gates: a stopped
   * scheduler and circuit-breaker backoff parking. Default is derived from the
   * reason kind (`manual`), so only callers that ARE the operator acting
   * through another kind — `reopenGoal`, notably — need to pass it.
   *
   * Every explicit activation through here is the operator's, so it is also
   * marked `operator`: the one standing the provider breaker admits while it
   * is open. A runtime path that needs `explicit` for the gates above without
   * the breaker exemption goes to the scheduler directly, as the handover
   * re-queue does (`requeueAfterHandover`).
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
    // No `resume` counterpart, unlike SUSPENDED: retirement is terminal, so
    // this is the end of the line for every activation path — operator wake,
    // interest match and recovery restart alike.
    if (rec.state.lifecycle === "RETIRED") return { queued: false, blocked: "agent was retired" };
    const explicit = opts.explicit ?? reason.kind === "manual";
    const req: SchedulerActivationRequest = {
      agentId,
      reason,
      priority: reason.kind === "startup" ? 5 : reason.kind === "recovery" ? 7 : reason.kind === "manual" ? 6 : 3,
      explicit,
      ...(explicit ? { operator: true } : {}),
    };
    const queued = await this.deps.scheduler.requestActivation(req);
    if (queued) return { queued: true };
    // "already active, or deferred by budget/policy" was the best this could do
    // while the scheduler collapsed the policy's decision into a boolean. When
    // the refusal came from policy the sentence already exists — use it.
    const refusal = this.deps.scheduler.lastActivationRefusal?.(agentId);
    return { queued: false, blocked: refusal?.reason ?? "already active, or deferred by budget/policy" };
  }

  /**
   * Suspend a seat: it takes no turn — not for mail, recovery or an operator
   * wake — until `resumeAgent`.
   *
   * A seat mid-turn is stopped through `interruptTurn` first, which suspends it
   * once that turn has closed; `stoppedTurnId` names the turn it stopped. This
   * used to tear the session down under the live turn instead, and the turn's
   * own failure handling undid the suspension: the runtime settled the pending
   * call as a dead backend ("session torn down"), `handleAgentFailure` wrote
   * `agent.failed` + `agent.restarted` + IDLE, and its recovery wake ran 20 ms
   * later. The dashboard's pause button paused nothing.
   */
  async suspendAgent(agentId: string): Promise<{ stoppedTurnId?: string; settled?: boolean }> {
    const rec = this.state.agents.get(agentId);
    if (!rec) return {};
    // RETIRED has no outgoing edges, so the reducer would throw on this event
    // — AFTER it was written. A rejected transition is not a caught mistake at
    // that point: the event is in the log, and every replay from now on throws
    // at the same offset. Refusing before the emit is what keeps the log
    // replayable. Same reason in `resumeAgent`.
    if (rec.state.lifecycle === "RETIRED") return {};
    if (this.turnInFlight.has(agentId) && this.activeTurnByAgent.has(agentId)) {
      const stopped = await this.interruptTurn(agentId, { suspend: true });
      // A turn that closed between the check and the stop falls through to the
      // plain suspension below, which is then the right thing for an idle seat.
      if (stopped.ok) return { stoppedTurnId: stopped.turnId, settled: stopped.settled };
    }
    const sess = this.sessions.get(agentId);
    if (sess) await sess.runtime.suspend(sess.session).catch(() => undefined);
    // The operator's pause outranks the mesh's park, including a pause of a
    // seat the mesh had already parked: it is the latest suspension, which is
    // what the boot rebuild reads, so live and rebuilt agree on it.
    this.terminalSuspended.delete(agentId);
    await this.deps.kernel.emit("agent.suspended", { agentId }, { actorId: HUMAN_AGENT_ID });
    return {};
  }

  /**
   * Stop ONE seat's running turn, on the operator's word.
   *
   * The budget watch's mechanics (`interruptOverBudgetTurns`): interrupt the
   * runtime, and settle the call ourselves if it has not answered within
   * `OPERATOR_STOP_GRACE_MS`. What differs is how the turn ends. The cause is
   * recorded in `operatorStops`, which the classifier in `runTurn` reads first:
   * the turn is discarded as `interrupted`, billed whatever the stopped call
   * reported spending, and the seat goes back to IDLE holding its task and its
   * unread mail — with no `agent.failed`, no restart, and no crash or slow-turn
   * strike. The dirty-worktree snapshot runs as for any turn that did not finish,
   * and the seat's next turn is told the operator stopped it.
   *
   * With `suspend`, the seat ends SUSPENDED instead and stays there — mail,
   * recovery and wakes are all refused by lifecycle — until `resumeAgent`.
   *
   * Without it the seat is ordinary IDLE: the scheduler may wake it again for
   * mail still in its box, as it would after any turn. `suspend` is the way to
   * keep it down.
   *
   * Waits (bounded by `OPERATOR_STOP_WAIT_MS`) for the turn to close, so the
   * answer can say how it ended. A turn already past its model call when the
   * stop arrives has nothing left to interrupt and finishes normally
   * (`endedAs: "completed"`, or its own discard reason).
   */
  async interruptTurn(agentId: string, opts: { reason?: string; suspend?: boolean } = {}): Promise<InterruptTurnResult> {
    const rec = this.state.agents.get(agentId);
    if (!rec) return { ok: false, code: "unknown_agent", error: `unknown agent '${agentId}'` };
    const turnId = this.activeTurnByAgent.get(agentId);
    if (!turnId || !this.turnInFlight.has(agentId)) {
      return {
        ok: false,
        code: "no_running_turn",
        error: `${agentId} has no running turn to interrupt (it is ${rec.state.lifecycle}); use suspend to keep an idle seat from starting one`,
        lifecycle: rec.state.lifecycle,
      };
    }
    const reason = typeof opts.reason === "string" && opts.reason.trim() ? opts.reason.trim().slice(0, 300) : undefined;
    let stop = this.operatorStops.get(turnId);
    if (stop) {
      // Asked again while the first stop is still closing the turn: nothing new
      // to interrupt, but a suspension asked for now must still stick.
      if (opts.suspend) stop.suspend = true;
      if (!stop.reason && reason) stop.reason = reason;
    } else {
      const fresh: OperatorStop = { suspend: opts.suspend === true, forced: false, ...(reason ? { reason } : {}) };
      stop = fresh;
      this.operatorStops.set(turnId, fresh);
      // The watchdogs' guard: neither the silence nor the budget watch fires on
      // a turn already being stopped, and no deadline advisory is sent to it.
      this.interruptedTurnIds.add(turnId);
      this.auditLine(`operator: stopping turn ${turnId} for ${agentId}${reason ? ` (${reason})` : ""}${fresh.suspend ? "; the seat will be suspended" : ""}`);
      const session = this.sessions.get(agentId);
      if (session) void session.runtime.interrupt(session.session).catch(() => undefined);
      const t = this.timers.setTimeout(() => {
        if (!this.turnInFlight.has(agentId) || this.activeTurnByAgent.get(agentId) !== turnId) return;
        // No handle: the call has not started (the check before it refuses to
        // start one) or has already returned, so nothing is hung.
        const settle = this.forceSettleTurn.get(turnId);
        if (!settle) return;
        fresh.forced = true;
        settle(new DOMException(operatorStopDetail(fresh), "AbortError"));
      }, OPERATOR_STOP_GRACE_MS);
      (t as unknown as { unref?: () => void }).unref?.();
    }
    const settled = await this.waitForTurnEnd(turnId, OPERATOR_STOP_WAIT_MS);
    return {
      ok: true,
      turnId,
      settled,
      ...(stop.endedAs ? { endedAs: stop.endedAs } : {}),
      lifecycle: this.state.agents.get(agentId)?.state.lifecycle,
    };
  }

  /** Resolves true when `turnId` has closed (its `runTurn` `finally` ran), false after `maxMs`. */
  private waitForTurnEnd(turnId: string, maxMs: number): Promise<boolean> {
    if (![...this.activeTurnByAgent.values()].includes(turnId)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let timer: TimerHandle | undefined;
      let done = false;
      const finish = (ended: boolean): void => {
        if (done) return;
        done = true;
        if (timer) this.timers.clearTimeout(timer);
        resolve(ended);
      };
      const waiting = this.turnEndWaiters.get(turnId) ?? [];
      waiting.push(() => finish(true));
      this.turnEndWaiters.set(turnId, waiting);
      timer = this.timers.setTimeout(() => finish(false), maxMs);
      (timer as unknown as { unref?: () => void }).unref?.();
    });
  }

  /**
   * The half of `handleAgentFailure` an operator-stopped turn needs, and none of
   * the rest: back to IDLE, closing the turn in the log (`turnId` on the change
   * is what step reconstruction and `closeAbandonedTurns` read as its end).
   *
   * The session is KEPT when the runtime answered the interrupt. The Claude
   * adapter leaves an answered abort's query open and marks the seat IDLE —
   * "alive, between turns" — and tears the session down itself when the abort
   * goes unanswered, which `ensureSession`'s status check then sees as
   * UNREACHABLE and replaces. Dropping it here would cost the next turn a
   * process spawn and a transcript restore for nothing. When the supervisor had
   * to force the settle, nothing confirmed the backend stopped, so it is dropped
   * as the failure path would.
   */
  private async closeOperatorStoppedTurn(agentId: string, turnId: string, stop: OperatorStop): Promise<void> {
    if (stop.forced) this.sessions.delete(agentId);
    const lifecycle = this.state.agents.get(agentId)?.state.lifecycle;
    if (!lifecycle || lifecycle === "IDLE" || lifecycle === "SUSPENDED" || lifecycle === "COMPLETED") return;
    if (!(LIFECYCLE_TRANSITIONS[lifecycle] ?? []).includes("IDLE")) return;
    await this.deps.kernel
      .emit("agent.state_changed", { agentId, to: "IDLE", note: operatorStopDetail(stop), turnId }, { actorId: HUMAN_AGENT_ID, correlationId: turnId })
      .catch(() => undefined);
  }

  /**
   * Close a turn `shutdown()` stopped: back to IDLE, the turn closed in the log
   * by the `turnId` on the change — the same record `closeAbandonedTurns` writes
   * at the next boot for a turn whose process died without one, written here
   * while this process still can. `cause` says why, for a reader of the log.
   *
   * No `agent.failed`, no ladder, no strike, no recovery wake: the seat did
   * not fail, and there is no process left to run a retry in. The session is
   * dropped — `shutdown` stopped it. If the emit never lands (the store closed
   * first), the next boot's `closeAbandonedTurns` closes the turn instead, so
   * either way the seat boots IDLE, never FAILED.
   */
  private async closeShutdownStoppedTurn(agentId: string, turnId: string, note: string): Promise<void> {
    this.sessions.delete(agentId);
    const lifecycle = this.state.agents.get(agentId)?.state.lifecycle;
    if (!lifecycle || lifecycle === "IDLE" || lifecycle === "SUSPENDED" || lifecycle === "COMPLETED") return;
    if (!(LIFECYCLE_TRANSITIONS[lifecycle] ?? []).includes("IDLE")) return;
    await this.deps.kernel
      .emit("agent.state_changed", { agentId, to: "IDLE", cause: MESH_SHUTDOWN_CAUSE, note, turnId }, { actorId: "system", correlationId: turnId })
      .catch(() => undefined);
  }

  /**
   * Leave a seat whose turn the operator stopped with `suspend` SUSPENDED.
   *
   * Called from `runTurn`'s `finally` BEFORE `turnInFlight` clears, because the
   * moment it does the scheduler may re-queue the seat for mail still in its
   * box, and only a SUSPENDED lifecycle refuses that. Also runs when the turn
   * finished on its own before the stop reached it: the operator asked for a
   * suspended seat either way.
   */
  private async suspendAfterStop(agentId: string, turnId: string, stop: OperatorStop): Promise<void> {
    const lifecycle = this.state.agents.get(agentId)?.state.lifecycle;
    if (!lifecycle || lifecycle === "SUSPENDED" || !(LIFECYCLE_TRANSITIONS[lifecycle] ?? []).includes("SUSPENDED")) return;
    const sess = this.sessions.get(agentId);
    if (sess) await sess.runtime.suspend(sess.session).catch(() => undefined);
    // Same rule as `suspendAgent`: this suspension is the operator's.
    this.terminalSuspended.delete(agentId);
    await this.deps.kernel
      .emit("agent.suspended", { agentId, note: operatorStopDetail(stop), turnId }, { actorId: HUMAN_AGENT_ID, correlationId: turnId })
      .catch(() => undefined);
  }

  async resumeAgent(agentId: string): Promise<void> {
    const rec = this.state.agents.get(agentId);
    if (rec?.state.lifecycle === "RETIRED") return;
    // Whichever suspension parked it, a resume puts the seat back under the
    // mesh's scheduling, so the terminal-failure marking must not outlive it:
    // left behind, a later escalation answer would count a working seat as
    // parked-for-failure and clear counters the operator did not ask about.
    this.terminalSuspended.delete(agentId);
    const sess = this.sessions.get(agentId);
    if (sess && rec) {
      const context = await this.buildRuntimeContext(agentId);
      const revived = await sess.runtime.resume(sess.session, rec.definition, context).catch(() => null);
      // A resume that could not reach the backend leaves us holding a session
      // struct for a query nobody is running. Dropping it sends the next turn
      // through ensureSession, which restores from the transcript or starts
      // fresh — the same path a crashed backend already takes.
      if (revived) this.sessions.set(agentId, { ...sess, session: revived });
      else this.sessions.delete(agentId);
    }
    await this.deps.kernel.emit("agent.resumed", { agentId }, { actorId: HUMAN_AGENT_ID });
  }

  /**
   * Seats the mesh parked for terminal failure and that are still SUSPENDED,
   * as a plain id list. The stall escalation names them (see `checkStall`) so
   * the operator can see WHY nothing moves — "nudges produced no work" is the
   * symptom, and a mesh whose every seat is parked needs a different answer
   * from a mesh whose driver ignores its nudges.
   */
  private terminalSuspendedSeats(): string[] {
    return [...this.terminalSuspended].filter((id) => this.state.agents.get(id)?.state.lifecycle === "SUSPENDED");
  }

  /**
   * The operator has answered an escalation: put the seats the MESH parked for
   * terminal failure back to work, and drive them.
   *
   * This is the release the "retry" answer never had. `handleAgentFailure`
   * suspends a seat whose turns keep failing terminally, on the assumption the
   * mission can proceed without it. When EVERY seat dies that way — a provider
   * account over quota returned 429 for 855 of 1023 calls on 2026-09-27, and
   * each seat was parked in turn — it cannot, so the watchdog raised
   * `stalemate:stall_nudge_cap` and the operator's answer set the goal ACTIVE
   * and called `activateAgent`, which refuses a SUSPENDED seat by lifecycle.
   * The answer was a no-op, the watchdog escalated again, and the only thing
   * that worked was resuming nine seats by hand.
   *
   * Only `terminalSuspended` seats are touched. A seat the OPERATOR suspended
   * is not in that set and stays down until the operator resumes it: an
   * escalation answer is not that instruction, and undoing a deliberate pause
   * would be a worse bug than the one this fixes.
   *
   * All of them, not just the ones the card happens to name: terminal failure
   * is an ENVIRONMENT condition (the quota, the dead backend) rather than a
   * per-seat mistake, so seats parked by the same outage share its remedy —
   * and the stall card names no seat at all, only a `candidateDriver`. Seats
   * other than the escalation's own subject are therefore revived for the same
   * reason the recovery sweep below already wakes them.
   *
   * Each revival is a FRESH START, not a rescrape of the ladder: the crash,
   * slow-turn and unreachable counters that parked the seat (and the
   * scheduler's breaker strikes, which would otherwise refuse the wake) are
   * cleared first, or the first turn back would walk straight back into the
   * park. The resume is emitted as the ordinary `agent.resumed` — the same
   * event the manual resume and a reopen already use, so nothing new has to be
   * replayed — and the activation follows it, so `activateAgent` finds an IDLE
   * seat. Resume BEFORE activate is the whole fix.
   */
  private async reviveTerminalSuspended(why: string): Promise<string[]> {
    const revived: string[] = [];
    for (const agentId of [...this.terminalSuspended]) {
      const rec = this.state.agents.get(agentId);
      // Gone, retired, or no longer suspended: nothing to revive, and the id
      // must not linger (a stale entry could otherwise clear the counters of a
      // seat that is working normally by the time the next card is answered).
      if (!rec || rec.state.lifecycle !== "SUSPENDED") {
        this.terminalSuspended.delete(agentId);
        continue;
      }
      await this.resumeAgent(agentId);
      // Read the projection back rather than trust the emit: the reducer is
      // what decides the lifecycle and it could have refused. A refused resume
      // leaves the seat suspended, so the marking goes back — the seat is
      // still exactly what it says it is, and dropping it here would lose the
      // classification for the whole episode (`resumeAgent` clears it on the
      // way in, which only an actually-returned seat has earned).
      if (this.state.agents.get(agentId)?.state.lifecycle !== "IDLE") {
        this.terminalSuspended.add(agentId);
        continue;
      }
      // Cleared now, not before: this seat is demonstrably back, and none of
      // these counters survives into the fresh start. Cleared BEFORE the
      // activation — the scheduler's breaker in particular would otherwise
      // refuse it — but not before the resume that made the seat real again.
      this.restartAttempts.delete(agentId);
      this.timeoutRetries.delete(agentId);
      this.unreachableStreak.delete(agentId);
      this.outageRetries.delete(agentId);
      // The breaker counts unproductive turns, not failures, but it parks the
      // seat for the same PARK_MS and would refuse the wake below. The
      // operator's answer is a fresh start for it too. `"ok"` is the outcome
      // that clears the strikes — the only public door onto that map.
      this.deps.scheduler.noteTurnOutcome?.(agentId, "ok");
      revived.push(agentId);
      this.auditLine(`escalation response: revived ${agentId}, parked after a terminal failure (${why})`);
    }
    // Between the resumes and the activations: the notice names every seat
    // that came back, and a revived seat's first turn should read it rather
    // than find it at turn end and be woken again for it.
    await this.announceRevived(revived);
    for (const agentId of revived) {
      // After the resume, never before: a SUSPENDED seat is refused here.
      await this.activateAgent(
        agentId,
        { kind: "recovery", note: `${why}; you were parked after a terminal failure — the mission is running again, pick up your mail and what you owe` },
      ).catch(() => undefined);
    }
    return revived;
  }

  /**
   * Tell the mesh that seats it was told were dead are back.
   *
   * The death is announced: `handleAgentFailure` sends each creditor an INFORM
   * `{ declined: true, request, reason: "<seat> failed terminally … re-plan" }`.
   * Before this, a revival had no counterpart, and on 2026-09-28 (13:06Z)
   * seats kept reasoning from the last thing they were told: right after ten
   * seats came back, backend escalated that the merge gate had "no live
   * holder" and pm escalated it again, both about review seats that were IDLE.
   *
   * ONE message, from the runtime (the human seat, as the death notice), in a
   * thread of its own. To every seat that is not retired, not only the
   * creditors: the death travels past them — pm's card repeated backend's —
   * and the creditor list survives a restart only as prose in the death
   * notice's `reason`, which is not something to route on.
   *
   * Sent as a BROADCAST, so it wakes nobody by itself: the scheduler wakes only
   * seats with a declared interest in mail, and every other seat reads it on
   * its next turn, whatever wakes it. A direct INFORM would buy the whole
   * roster a turn for an announcement that asks nothing — and, sent here, the
   * revived seats a message wake racing the recovery wake below. Nothing is
   * owed on it, and a broadcast refuses replies.
   */
  private async announceRevived(revived: string[]): Promise<void> {
    if (revived.length === 0) return;
    const to = [...this.state.agents.values()]
      .filter((r) => r.state.agentId !== HUMAN_AGENT_ID && r.state.lifecycle !== "RETIRED")
      .map((r) => r.state.agentId);
    const names = revived.join(", ");
    const one = revived.length === 1;
    const them = one ? "it" : "them";
    const res = await this.sendMessage(
      {
        from: HUMAN_AGENT_ID,
        to,
        type: "INFORM",
        newThread: { subject: `${names} ${one ? "is" : "are"} available again` },
        payload: {
          available: true,
          revived,
          reason:
            `${names} ${one ? "is" : "are"} available again: the mesh parked ${them} after ${one ? "its" : "their"} turns failed terminally, and the operator's answer to an escalation has resumed ${them}. ` +
            `Every earlier notice that ${names} "failed terminally" is superseded — ask, review with, hand off to and wait on ${them} as normal, and do not escalate or re-plan around ${them} as dead. ` +
            `Asks that were declined when ${one ? "it" : "they"} failed are still closed: send them again if you still need the answer.`,
        },
        priority: "NORMAL",
      },
      { control: { mode: "broadcast" } },
    ).catch((err: unknown) => ({ accepted: false, reason: (err as Error).message }));
    if (res.accepted) this.auditLine(`escalation response: told ${to.length} seat(s) that ${names} ${one ? "is" : "are"} available again`);
    else this.auditLine(`escalation response: the notice that ${names} ${one ? "is" : "are"} available again was not sent: ${res.reason ?? "refused"}`);
  }

  /**
   * Per seat, the artifact versions its CURRENT turn read, newest last. The raw
   * material for `Artifact.inputs`. In memory by intent: a turn does not survive
   * a restart, and the only durable copy is the one a publish writes into its
   * own event, so replay never reads this.
   */
  private turnArtifactReads = new Map<string, { turnId: string; reads: Map<string, number> }>();
  /** Per artifact, the seats that have read its most recently read version. The amend screen's "has a peer seen this?". */
  private artifactVersionReaders = new Map<string, { version: number; readers: Set<string> }>();
  /** Per seat, the artifact versions its current turn created through `publish_artifact`: the amend window. */
  private turnPublishedVersions = new Map<string, { turnId: string; versions: Map<string, number> }>();
  /** `<dependent>@v<n>:<input>` / `<task>:<artifact>` pairs already told about a newer input, so each is told once. */
  private staleNoticesSent = new Set<string>();
  /**
   * Review asks superseded while the new version was not yet reviewable, per
   * artifact. Re-issued the moment the artifact becomes reviewable through a
   * path this runtime sees (`mirrorTransition`, or a later version published
   * READY_FOR_REVIEW); in memory, so a restart degrades to the owner asking.
   */
  private carriedReviewAsks = new Map<string, { version: number; asks: CarriedReviewAsk[] }>();
  /** Whether `completeTask` has told the operator the completion gate binds no unmarked task. Once per process. */
  private completionGateUnboundWarned = false;

  /** Called by `read_artifact`: remember what this seat's turn read, and who has seen that version. */
  private noteArtifactRead(actorId: string, a: Artifact, turn: TurnState): void {
    if (actorId === HUMAN_AGENT_ID) return;
    let mine = this.turnArtifactReads.get(actorId);
    if (!mine || mine.turnId !== turn.turnId) {
      mine = { turnId: turn.turnId, reads: new Map() };
      this.turnArtifactReads.set(actorId, mine);
    }
    // Re-inserted so the map's order is read order, newest last.
    mine.reads.delete(a.id);
    mine.reads.set(a.id, a.version);
    if (mine.reads.size > MAX_ARTIFACT_INPUTS) mine.reads.delete(mine.reads.keys().next().value!);
    const seen = this.artifactVersionReaders.get(a.id);
    if (!seen || seen.version !== a.version) this.artifactVersionReaders.set(a.id, { version: a.version, readers: new Set([actorId]) });
    else seen.readers.add(actorId);
  }

  /** What this seat's current turn read, as `Artifact.inputs`, minus the artifact being published. */
  private inputsReadThisTurn(actorId: string, turn: TurnState, publishing?: string): NonNullable<Artifact["inputs"]> {
    const mine = this.turnArtifactReads.get(actorId);
    if (!mine || mine.turnId !== turn.turnId) return [];
    return [...mine.reads]
      .filter(([id]) => id !== publishing)
      .map(([artifactId, version]) => ({ artifactId, version }));
  }

  /**
   * The version `publish_artifact` may rewrite in place instead of adding a new
   * one, or undefined when it must version as before.
   *
   * ui-designer's one logical "v3" landed as v3–v6 in 2m18s, 94–112 KB each,
   * and every one wiped approvals and closed the review ask again (skill-panel
   * 2026-09-25, §13). A seat correcting what it just published is not making a
   * new version; it is still writing the first one. The rule is the narrowest
   * that makes that true — every condition is a way someone else could already
   * depend on the content:
   *
   *  - the same seat, in the SAME turn that created the version. A later turn
   *    is a later decision, and between turns the version has been announced.
   *  - still DRAFT, and no explicit status other than DRAFT on the republish:
   *    nobody was asked to review it, and a submit is its own act.
   *  - no verdict recorded on it, and no open ask naming it.
   *  - no other seat has read that version: content a peer has read must not
   *    change under the same version number.
   *
   * The operator seat never amends: its publishes are deliberate and rare.
   */
  private amendableDraft(actorId: string, asVersionOf: string | undefined, status: ArtifactStatus | undefined, turn: TurnState): Artifact | undefined {
    if (!asVersionOf || actorId === HUMAN_AGENT_ID) return undefined;
    if (status !== undefined && status !== "DRAFT") return undefined;
    const cur = this.state.artifacts.get(asVersionOf);
    if (!cur || cur.owner !== actorId || cur.createdBy !== actorId || cur.status !== "DRAFT") return undefined;
    const mine = this.turnPublishedVersions.get(actorId);
    if (!mine || mine.turnId !== turn.turnId || mine.versions.get(cur.id) !== cur.version) return undefined;
    if ([...this.state.approvals.values()].some((list) => list.some((r) => r.artifactId === cur.id))) return undefined;
    const prefix = `artifact://${cur.type}/${encodeURIComponent(cur.name)}/`;
    if ([...this.state.pendingRequests.values()].some((pr) => (pr.artifactUris ?? []).some((u) => u.startsWith(prefix)))) return undefined;
    const seen = this.artifactVersionReaders.get(cur.id);
    if (seen && seen.version === cur.version && [...seen.readers].some((r) => r !== actorId)) return undefined;
    return cur;
  }

  /** Record that this seat's current turn produced `a` through `publish_artifact`. */
  private notePublishedThisTurn(actorId: string, a: Artifact, turn: TurnState): void {
    let mine = this.turnPublishedVersions.get(actorId);
    if (!mine || mine.turnId !== turn.turnId) {
      mine = { turnId: turn.turnId, versions: new Map() };
      this.turnPublishedVersions.set(actorId, mine);
    }
    mine.versions.set(a.id, a.version);
  }

  /**
   * Carry the review asks a new version just superseded over to it.
   *
   * The supersede used to be the whole story: every open ask on an older
   * version closed as `superseded`, only the ASKER was woken — and not even
   * that when it made the new version itself — and the reviewers were never
   * told. architect published v2 of four documents 4.5 min after v1, five asks
   * closed, none was re-issued for up to 30 minutes, and frontend spent two
   * turns (83k tokens) reviewing a superseded ApiSpec v1 (skill-panel
   * 2026-09-25, §13).
   *
   * So each REQUEST_REVIEW is re-addressed to the same reviewers, on behalf of
   * the seat that asked, for the new version — when that version is
   * reviewable. When it is still a DRAFT nobody has submitted, re-asking would
   * put the owner's unfinished work under review for it; the reviewers are
   * instead told to stop and that a new ask will come, and the ask is held
   * here until the artifact is submitted. Every addressee is re-asked, not just
   * the silent ones: the new version dropped every verdict on the old one, so
   * a reviewer that approved v1 has not approved v2.
   *
   * Other obliging asks naming the artifact (a question about v1) are closed
   * as before and their debtors told why; only reviews are carried.
   *
   * Returns a line for the publisher, which is otherwise the one seat never
   * told any of this.
   */
  private async carryReviewAsksOver(artifact: Artifact, actorId: string): Promise<string | undefined> {
    const prefix = `artifact://${artifact.type}/${encodeURIComponent(artifact.name)}/`;
    const newUri = artifactUri(artifact.type, artifact.name, artifact.version);
    const reviewable = artifact.status === "READY_FOR_REVIEW" || artifact.status === "UNDER_REVIEW";
    const reasked = new Set<string>();
    const stopped = new Set<string>();
    // Asks superseded earlier, while the artifact was not reviewable, whose
    // reviewers are still waiting to be asked again — unless somebody already
    // put the version they were held for up for review, which answered them.
    const entry = this.carriedReviewAsks.get(artifact.id);
    const held = entry && !this.reviewAskedFor(artifact, entry.version) ? entry.asks : [];
    const stillHeld: CarriedReviewAsk[] = [];
    if (reviewable) {
      for (const c of held) {
        for (const r of await this.reissueReviewAsk(artifact, c, newUri, [])) reasked.add(r);
      }
    } else {
      stillHeld.push(...held);
    }
    for (const [pid, pr] of [...this.state.pendingRequests]) {
      if (!pr.type.startsWith("REQUEST")) continue;
      const uris = pr.artifactUris ?? [];
      const mine = uris.filter((u) => u.startsWith(prefix));
      if (mine.length === 0) continue;
      const oldVersion = Number(/\/(\d+)$/.exec(mine[0]!)?.[1] ?? artifact.version - 1);
      const reviewers = pr.to.filter((r) => r !== HUMAN_AGENT_ID && r !== pr.from && r !== artifact.owner && this.state.agents.has(r));
      const carried: CarriedReviewAsk = {
        from: pr.from,
        to: reviewers,
        threadId: pr.threadId,
        supersededAsk: pid,
        oldVersion,
        ...(pr.contract ? { contract: pr.contract } : {}),
        ...(pr.ifUnanswered ? { ifUnanswered: pr.ifUnanswered } : {}),
      };
      // An ask naming several artifacts keeps its other artifacts: closing it
      // for the one that moved used to drop the reviewers' debt on all of them.
      const others = uris.filter((u) => !u.startsWith(prefix));
      const isReview = pr.type === "REQUEST_REVIEW";
      // Emit, don't mutate: a direct delete here never reached the log, so
      // replay rebuilt an ask the live mesh had already superseded.
      await this.dischargeCommitment(pid, "superseded", actorId, {
        artifactId: artifact.id,
        ...(isReview && reviewers.length > 0 ? { carriedTo: { version: artifact.version, reviewers, reissued: reviewable || others.length > 0 } } : {}),
      });
      if (!isReview || reviewers.length === 0) {
        if (reviewers.length > 0) await this.tellSuperseded(artifact, carried, "closed");
        continue;
      }
      if (reviewable || others.length > 0) {
        const fresh = others.length > 0 ? reviewers : reviewers.filter((r) => !reasked.has(r));
        const sent = await this.reissueReviewAsk(artifact, { ...carried, to: fresh }, reviewable ? newUri : undefined, others);
        for (const r of sent) reasked.add(r);
      }
      if (!reviewable) {
        // The re-ask for the ask's other artifacts already says "stop", so a
        // separate notice would be the same news twice.
        if (others.length === 0) await this.tellSuperseded(artifact, carried, "held");
        for (const r of reviewers) stopped.add(r);
        stillHeld.push(carried);
      }
    }
    if (stillHeld.length > 0) this.carriedReviewAsks.set(artifact.id, { version: artifact.version, asks: stillHeld.slice(-MAX_CARRIED_ASKS) });
    else this.carriedReviewAsks.delete(artifact.id);
    const lines: string[] = [];
    if (reasked.size > 0) lines.push(`re-asked ${[...reasked].join(", ")} to review v${artifact.version} — their verdicts on the old version no longer count`);
    if (stopped.size > 0) {
      lines.push(
        `v${artifact.version} is ${artifact.status}, so ${[...stopped].join(", ")} were told to stop reviewing the old version; they are re-asked when you submit it (mesh_artifact_transition to READY_FOR_REVIEW), or ask them yourself with mesh_request_review`,
      );
    }
    return lines.length > 0 ? `this version superseded open review asks: ${lines.join("; ")}` : undefined;
  }

  /**
   * Send one carried review ask for `artifact`'s current version (and any other
   * artifacts the original ask named), on behalf of the seat that asked.
   * Returns who was asked. A reviewer already owing an open review of the
   * artifact is not asked twice.
   */
  private async reissueReviewAsk(artifact: Artifact, c: CarriedReviewAsk, uri: string | undefined, others: string[]): Promise<string[]> {
    // Owing a review of THIS version, not of any: an ask on the old version
    // that the same supersede pass is about to close must not hide a reviewer.
    const owes = (r: string): boolean =>
      [...this.state.pendingRequests.values()].some((pr) => pr.type === "REQUEST_REVIEW" && stillOwes(pr, r) && !!uri && (pr.artifactUris ?? []).includes(uri));
    const to = uri ? c.to.filter((r) => !owes(r)) : c.to;
    const refs = [...(uri ? [uri] : []), ...others];
    if (to.length === 0 || refs.length === 0 || !this.state.agents.has(c.from)) return [];
    const res = await this.sendMessage(
      {
        from: c.from,
        to,
        type: "REQUEST_REVIEW",
        threadId: c.threadId,
        newThread: { subject: `review ${artifact.name} v${artifact.version}` },
        causationId: c.supersededAsk,
        artifactRefs: refs.map((u) => ({ uri: u })),
        payload: {
          question: uri
            ? `Review ${artifact.type} ${artifact.name} v${artifact.version}. v${c.oldVersion}, which you were asked to review in ${c.supersededAsk}, was superseded by v${artifact.version} — re-review v${artifact.version}; a verdict on v${c.oldVersion} no longer counts.`
            : `${artifact.type} ${artifact.name} v${c.oldVersion} was superseded by v${artifact.version}, which is still a ${artifact.status}: stop reviewing it — a new ask will come when it is submitted. The rest of ${c.supersededAsk} still stands and is re-asked here.`,
          carriedFrom: c.supersededAsk,
          superseded: { artifactId: artifact.id, from: c.oldVersion, to: artifact.version },
        },
      },
      c.contract || c.ifUnanswered
        ? { control: { ...(c.contract ? { contract: c.contract } : {}), ...(c.ifUnanswered ? { ifUnanswered: c.ifUnanswered } : {}) } }
        : undefined,
    );
    if (!res.accepted) {
      this.auditLine(`carry-over of review ask ${c.supersededAsk} to ${artifact.name} v${artifact.version} refused: ${res.reason ?? "unknown"}`);
      return [];
    }
    return to;
  }

  /**
   * Was a review of `a` at `version` ever asked for, by anyone? A held
   * carry-over is owed only while the answer is no: once the owner (or anyone)
   * asked, the reviewers it holds for were either asked again or deliberately
   * left out. A scan of the message log, which only a version bump or a
   * submit ever pays for.
   */
  private reviewAskedFor(a: Artifact, version: number): boolean {
    const uri = artifactUri(a.type, a.name, version);
    for (const m of this.state.messages.values()) {
      if (m.type === "REQUEST_REVIEW" && m.artifactRefs.some((r) => r.uri === uri)) return true;
    }
    return false;
  }

  /**
   * Tell the debtors of a superseded ask that the version they were asked
   * about is gone. Mail, stamped `accrue` like a withdrawal notice: it is a
   * de-escalation, so it rides the recipient's next turn instead of buying one.
   */
  private async tellSuperseded(artifact: Artifact, c: CarriedReviewAsk, what: "held" | "closed"): Promise<void> {
    if (c.to.length === 0 || !this.state.agents.has(c.from)) return;
    const next =
      what === "held"
        ? `v${artifact.version} is still a ${artifact.status} nobody has submitted: stop reviewing v${c.oldVersion} — you will be asked again when v${artifact.version} is submitted`
        : `v${c.oldVersion} was replaced by v${artifact.version}: the request was closed — read v${artifact.version} before answering anything about it`;
    const res = await this.sendMessage(
      {
        from: c.from,
        to: c.to,
        type: "INFORM",
        threadId: c.threadId,
        newThread: { subject: `superseded: ${artifact.name} v${c.oldVersion}` },
        causationId: c.supersededAsk,
        artifactRefs: [{ uri: artifactUri(artifact.type, artifact.name, artifact.version) }],
        payload: { superseded: true, request: c.supersededAsk, artifactId: artifact.id, from: c.oldVersion, to: artifact.version, summary: next },
      },
      c.from === HUMAN_AGENT_ID ? undefined : { control: { delivery: "accrue" } },
    );
    if (!res.accepted) this.auditLine(`superseded notice for ${c.supersededAsk} refused: ${res.reason ?? "unknown"}`);
  }

  /**
   * A newer version of `artifact` just landed: tell, once each, the owners of
   * artifacts built on an older version (`Artifact.inputs`) and the seats
   * holding tasks pinned to an older version. The context keeps showing both
   * (stale inputs on the artifact line, caveats on the current task) until
   * they are resolved, so a notice lost to a busy queue is not a lost fact.
   */
  private async flagDependentsOf(artifact: Artifact, actorId: string): Promise<void> {
    let sent = 0;
    const notify = async (agentId: string | undefined, key: string, note: string): Promise<void> => {
      if (!agentId || agentId === actorId || agentId === HUMAN_AGENT_ID || this.staleNoticesSent.has(key)) return;
      if (sent >= MAX_STALE_NOTICES_PER_VERSION) return;
      this.staleNoticesSent.add(key);
      sent++;
      await this.activateAgent(agentId, { kind: "recovery", note }).catch(() => undefined);
    };
    const now = `${artifact.type} "${artifact.name}"`;
    for (const d of this.state.artifacts.values()) {
      if (d.id === artifact.id || d.goalId !== artifact.goalId || d.status === "ARCHIVED") continue;
      const input = d.inputs?.find((i) => i.artifactId === artifact.id && i.version < artifact.version);
      if (!input) continue;
      await notify(
        d.owner,
        `${d.id}@${d.version}:${artifact.id}`,
        `your ${d.type} "${d.name}" v${d.version} was built on ${now} v${input.version}; it is now v${artifact.version} — re-read it and publish a new version of "${d.name}" if anything you relied on changed`,
      );
    }
    for (const t of this.state.tasks.values()) {
      if (t.goalId !== artifact.goalId || (t.status !== "CLAIMED" && t.status !== "IN_PROGRESS")) continue;
      const pin = t.artifactRefs.find((r) => typeof r.version === "number" && r.version < artifact.version && artifactForRef(this.state, undefined, r.uri)?.id === artifact.id);
      if (!pin) continue;
      await notify(
        t.claimedBy,
        `${t.id}:${artifact.id}`,
        `your task ${t.id} ("${t.title}") was cut from ${now} v${pin.version}; it is now v${artifact.version} — re-read it before going further: the task itself may be out of date`,
      );
    }
    // Bounded like the other dedupe sets in this class: it only has to
    // outlive the burst of versions it exists to deduplicate.
    if (this.staleNoticesSent.size > MAX_STALE_NOTICE_KEYS) this.staleNoticesSent.clear();
  }

  async createArtifact(input: {
    actorId: string;
    name: string;
    type: Artifact["type"];
    content: string;
    status?: ArtifactStatus;
    /**
     * Overrides the type's default scope. Omitted by almost every caller —
     * `artifactScope` falls back to the default at read time, so the common
     * case needs no field at all and old logs keep replaying identically.
     */
    scope?: ArtifactScope;
    metadata?: Record<string, unknown>;
    parentArtifactId?: string;
    asVersionOf?: string;
    provenanceSource?: TrustSource;
    correlationId?: string;
    /**
     * Rewrite `asVersionOf`'s current version in place rather than adding one.
     * Only `publish_artifact` sets it, and only after `amendableDraft` said
     * yes; re-checked below against the record, and by the reducer.
     */
    amend?: boolean;
    /** What the publishing turn read. See `Artifact.inputs`; only `publish_artifact` knows it. */
    inputs?: Artifact["inputs"];
  }): Promise<{ artifact: Artifact; uri: string; notice?: string } | { error: string }> {
    const goalId = this.state.activeGoalId;
    if (!goalId) return { error: "no active goal" };
    // Every artifact in the system is born here, which makes this the one place
    // an unknown scope can be stopped before it reaches the log. It is dropped
    // rather than rejected: scope is advisory — it widens who sees the document,
    // it does not decide whether the document exists — so losing a whole publish
    // over the one field nobody asked for would be the wrong trade. Dropping it
    // falls back to the type default, which is the behaviour that predates it.
    const scope = ARTIFACT_SCOPES.includes(input.scope as ArtifactScope) ? input.scope : undefined;
    const ctx = { config: this.config, projections: this.state, goal: this.state.goals.get(goalId) };
    // Reject model-invented artifact types at the gate: without this a
    // publish like type "ArchitectureDoc" (not in ARTIFACT_TYPES) lands in
    // the store as a first-class record nobody can review or transition.
    if (!(ARTIFACT_TYPES as readonly string[]).includes(input.type)) {
      return { error: `unknown artifact type '${input.type}' (expected one of: ${ARTIFACT_TYPES.join(", ")})` };
    }
    // An empty body is a record of nothing, and the store cannot tell it from
    // real work: it digests, versions and transitions exactly like a document,
    // satisfies "an artifact exists" gates, and gets cited as evidence. A model
    // that publishes "" (or a stray newline) meant to publish something.
    const content = String(input.content ?? "");
    if (content.trim().length === 0) {
      return { error: `artifact ${input.type}:${input.name} has empty content — publish the body, not an empty string` };
    }
    const machine = artifactMachineOf(input.type);
    const initial = INITIAL_ARTIFACT_STATUS[machine];

    let artifact: Artifact;
    let isVersion = false;
    /** The version being rewritten in place, when this publish is an amend. */
    let amending: number | undefined;
    /** The predecessor's status, so the version bump can record the step it takes. */
    let previousStatus: ArtifactStatus | undefined;
    if (input.asVersionOf) {
      const current = this.state.artifacts.get(input.asVersionOf);
      if (!current) return { error: `unknown artifact ${input.asVersionOf}` };
      previousStatus = current.status;
      const ownerCheck = this.deps.policy.checkOwnership(input.actorId, current.id, ctx);
      if (ownerCheck.decision === "DENY") {
        await this.denied(input.actorId, current.id, "publish version", ownerCheck);
        return { error: `ownership denied: ${ownerCheck.reason}` };
      }
      if (current.owner !== input.actorId && input.actorId !== HUMAN_AGENT_ID) {
        await this.denied(input.actorId, current.id, "publish version", { decision: "DENY", reason: `single-writer: current owner is ${current.owner}` });
        return { error: `single-writer: current owner is ${current.owner}` };
      }
      // The amend branch keeps the version, its status and its creation stamp;
      // only the body (and what the turn read) moves. See `amendableDraft`.
      if (input.amend === true && current.status === "DRAFT" && current.owner === input.actorId) {
        amending = current.version;
        artifact = {
          ...current,
          ...(scope ? { scope } : {}),
          contentRef: "",
          digest: "",
          metadata: { ...(current.metadata ?? {}), ...(input.metadata ?? {}) },
        };
      } else artifact = {
        ...current,
        version: current.version + 1,
        parent: current.id,
        // A new version may re-scope, but silence inherits: `...current` already
        // carried the predecessor's scope, and dropping it on every version
        // would quietly reset a deliberate choice back to the type default.
        ...(scope ? { scope } : {}),
        // A version is new content — `contentRef` and `digest` are cleared just
        // below — so it must not carry the predecessor's verdict. Inheriting
        // `current.status` handed v3 of a CodePatch an APPROVED no reviewer ever
        // granted, and the code machine leaves APPROVED only for VERIFIED, so no
        // seat could undo it. Start at the machine's initial status and honour a
        // requested one only where the machine allows that step from there —
        // the same latitude a first publish gets.
        status:
          input.status && (MACHINE_TRANSITIONS[machine][initial] ?? []).includes(input.status)
            ? input.status
            : initial,
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
        ...(scope ? { scope } : {}),
        metadata: input.metadata ?? {},
        provenance: {
          source: input.provenanceSource ?? (input.actorId === HUMAN_AGENT_ID ? "human" : "agent"),
          trustLevel: input.actorId === HUMAN_AGENT_ID ? 100 : 50,
        },
        createdAt: this.deps.kernel.clock.iso(),
        createdBy: input.actorId,
      };
    }
    // What the publishing turn read, on the version it produced — the half of
    // "built on a stale input" only the publish moment can know. A new version
    // does not inherit its predecessor's: it records what THIS turn read, or
    // nothing. An amend with no reads keeps what the version already had.
    const inputs = (input.inputs ?? []).filter((i) => i.artifactId !== artifact.id).slice(-MAX_ARTIFACT_INPUTS);
    if (inputs.length > 0) artifact = { ...artifact, inputs };
    else if (amending === undefined && artifact.inputs) {
      const { inputs: _inherited, ...rest } = artifact;
      artifact = rest;
    }
    // A CodePatch's `metadata.commit` is handed to git verbatim at merge, and a
    // value git cannot use was found only there — hours later, as a merge error
    // the seats misread (see `commitRefError`). Checked on the value THIS publish
    // supplies: an absent one is fine (the merge falls back to the branch), and
    // one inherited from a predecessor is the MERGEABLE door's to refuse.
    if (artifact.type === "CodePatch" && input.metadata?.commit !== undefined) {
      const refused = await this.recordedCommitError(input.metadata.commit);
      if (refused) return { error: `artifact ${input.type}:${input.name} was not published: ${refused}` };
    }
    // What the tree a verification report was written in held, recorded by the runtime: the
    // report's prose says what was tested, and a seat that re-typed a patch into a worktree that
    // never had it writes the same prose as one that checked the commit out. Whatever the seat put
    // under `metadata.worktree` is dropped either way, so the key is only ever the runtime's.
    if (VERIFICATION_ARTIFACT_TYPES.includes(artifact.type) && input.actorId !== HUMAN_AGENT_ID) {
      const { worktree: _claimed, ...rest } = (artifact.metadata ?? {}) as Record<string, unknown>;
      const stamp = await this.worktreeStamp(input.actorId, inputs);
      artifact = { ...artifact, metadata: stamp ? { ...rest, worktree: stamp } : rest };
    }
    const contentRef = await this.deps.content.writeVersion(artifact.id, artifact.version, content);
    artifact = { ...artifact, contentRef, digest: digestOf(content) };
    // The artifact schema is the protocol's written contract for this record,
    // and until now nothing on the write path enforced it: `validateArtifact`
    // was exported and never called, so a malformed artifact reached the log
    // and only failed later, in whatever consumer happened to read it first.
    // Validate the record we are about to emit, not the caller's input — the
    // version branch inherits fields from the stored predecessor.
    const shape = validateArtifact(artifact);
    if (!shape.valid) {
      const why = shape.errors.map((e) => `${e.path} ${e.message}`).join("; ");
      return { error: `artifact ${input.type}:${input.name} fails the artifact schema: ${why}` };
    }
    const uri = artifactUri(artifact.type, artifact.name, artifact.version);
    const correlationId = input.correlationId ?? this.turnCorrelation(input.actorId);
    const evt = await this.deps.kernel.emit(
      isVersion ? "artifact.versioned" : "artifact.created",
      // `amends` is what tells the reducer to rewrite the version it names
      // rather than add one; every other reader sees an ordinary publish.
      { artifact, ...(amending !== undefined ? { amends: amending } : {}) },
      { actorId: input.actorId, goalId, correlationId },
    );
    // A version bump moves the artifact's status — usually UNDER_REVIEW back to
    // DRAFT — by writing it straight into the record, so until now the step left
    // no `artifact.transition` behind. The transition log then read
    // `UNDER_REVIEW -> UNDER_REVIEW -> UNDER_REVIEW` for an artifact that had been
    // DRAFT five times in between (measured 2026-09-24), and any projection built
    // from transitions alone believed it never left review. That contradicts the
    // contract `auditTransition` exists to keep: every state change visible in the
    // log.
    //
    // Emitted AFTER `artifact.versioned`, so the reducer has already applied the
    // new status and `doTransition`'s same-status guard makes this a no-op on both
    // live apply and replay — which is why it needs no new edge in the machine
    // tables for a step (UNDER_REVIEW -> DRAFT) that is not otherwise legal.
    if (isVersion && previousStatus !== undefined && previousStatus !== artifact.status) {
      await this.auditTransition(artifact.id, evt.id, goalId, correlationId, input.actorId, previousStatus);
    }
    await this.deriveArtifactSemantic(artifact, content, evt.id, correlationId, amending !== undefined);
    let notice: string | undefined;
    if (isVersion && amending === undefined) {
      // A new version supersedes review asks for older versions of the same
      // artifact: reviewers answer against the newest version, and the stale
      // pending entries for v1 would otherwise nudge forever and escalate a
      // false stalemate after the merge already resolved the substance. The
      // reviews themselves are carried to the new version, not dropped.
      notice = await this.carryReviewAsksOver(artifact, input.actorId);
      await this.flagDependentsOf(artifact, input.actorId);
    }
    return { artifact, uri, ...(notice ? { notice } : {}) };
  }

  /**
   * The state of `agentId`'s worktree for a verification report it is publishing, and whether each
   * patch the turn read is in it. Null when the seat has no worktree to describe (no git, a seat
   * that never wrote), and then the report simply carries no stamp.
   */
  private async worktreeStamp(agentId: string, inputs: ReadonlyArray<{ artifactId: string; version: number }>): Promise<WorktreeStamp | null> {
    const workspace = this.deps.workspace;
    if (!workspace?.worktreeState) return null;
    const state = await workspace.worktreeState(agentId).catch(() => null);
    if (!state) return null;
    const tested: NonNullable<WorktreeStamp["tested"]> = [];
    for (const i of inputs) {
      const patch = this.state.artifacts.get(i.artifactId);
      const commit = patch?.type === "CodePatch" ? patch.metadata?.commit : undefined;
      if (!patch || typeof commit !== "string" || commit.length === 0 || !workspace.containsCommit) continue;
      const inHead = await workspace.containsCommit(agentId, commit).catch(() => null);
      if (inHead !== null) tested.push({ artifact: artifactUri(patch.type, patch.name, i.version), commit: commit.slice(0, 12), inHead });
    }
    return {
      ...(state.head ? { head: state.head } : {}),
      dirty: state.dirty.length,
      untracked: state.untracked,
      ahead: state.unmergedCommits.length,
      ...(tested.length > 0 ? { tested } : {}),
    };
  }

  /**
   * Why `value` cannot be a CodePatch's `metadata.commit`, or null when it can.
   *
   * Syntax always (`commitRefError`). When the mesh has a git workspace, also
   * whether the product repository — the one `mergeWorktree` merges in —
   * resolves it to a commit, so a sha from another checkout or a branch that
   * does not exist is refused now rather than at merge. An in-memory mesh has no
   * repository to ask, and a git failure is not an answer: both accept a value
   * whose syntax is right, and the merge still checks it.
   */
  private async recordedCommitError(value: unknown): Promise<string | null> {
    const shape = commitRefError(value);
    if (shape) return shape;
    const workspace = this.deps.workspace as (WorkspacePort & CommitResolver) | undefined;
    if (!workspace?.resolveCommit) return null;
    const ref = value as string;
    try {
      if ((await workspace.resolveCommit(ref)) !== null) return null;
    } catch (err) {
      this.auditLine(`metadata.commit ${JSON.stringify(ref)} could not be checked against the product repository: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    return (
      `metadata.commit ${JSON.stringify(ref)} does not name a commit in the product repository — ` +
      "commit your work with the `commit` op (which records the sha for you), or pass the sha of a commit that exists on your branch"
    );
  }

  private async deriveArtifactSemantic(a: Artifact, content: string, causationId: string, correlationId?: string, amended = false): Promise<void> {
    const goalId = a.goalId;
    const corr = correlationId ?? this.turnCorrelation(a.createdBy);
    // An amend rewrites a version that was already announced: the one-shot
    // "a new X exists" events below fired when it was created. Requirements
    // are re-derived (the body changed); nothing else here applies to a DRAFT.
    if (amended) {
      if (a.type !== "RequirementsDoc" && a.type !== "Requirement") return;
    }
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
    // MERGED is refused on the PUBLIC door too, not only on the seat's
    // `transition_artifact` op. The op-level guard closed one caller; this
    // method is also reached by the HTTP transition route and by any embedder,
    // and `mirrorTransition` below emits `patch.merged` + `implementation.completed`
    // from type + status alone. Only `opMerge` -- after git (or materialization)
    // actually landed the change -- may record MERGED, through `applyTransition`
    // with the proof the reducer now demands.
    if (transition.to === "MERGED") {
      const reason =
        "MERGED is recorded by the merge itself, not by a transition: use the merge op so the change actually lands on the product branch — nothing was recorded";
      if (this.state.artifacts.has(artifactId)) {
        await this.denied(actorId, artifactId, `transition -> ${transition.to}`, { decision: "DENY", reason, ruleId: "merge.requires-merge-op" });
      }
      return { ok: false, reason };
    }
    return this.applyTransition(actorId, artifactId, transition);
  }

  /**
   * The transition itself, minus the MERGED refusal. `merge` is the proof a
   * merge ran, carried on the event so the REDUCER can refuse a MERGED that has
   * none (a raw `kernel.emit`, or a replayed log someone edited). Only
   * `opMerge` passes it.
   */
  private async applyTransition(
    actorId: string,
    artifactId: string,
    transition: { to: ArtifactStatus; evidenceEventIds?: string[]; comment?: string },
    merge?: MergeProof,
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
    // Already there: nothing moves, so nothing is recorded. The reducer used to
    // absorb a same-status transition as a no-op that still reached the log;
    // it now refuses one on a live emit (the machine has no self-edges). The
    // common caller is a seat that approved -- which already advanced the
    // artifact -- and then asks for the status its approval produced, and it
    // is told the truth rather than an error.
    if (artifact.status === transition.to) {
      return { ok: true, reason: `${artifact.type} "${artifact.name}" is already ${artifact.status} — nothing to record` };
    }
    // A CodePatch published before `createArtifact` checked `metadata.commit`
    // can still hold prose there. MERGEABLE is the last stop before the merge
    // hands that value to git, so it is refused here, with the sentence the
    // publish would now give, instead of as a git error at merge.
    if (transition.to === "MERGEABLE" && artifact.type === "CodePatch" && artifact.metadata?.commit !== undefined) {
      const bad = commitRefError(artifact.metadata.commit);
      if (bad) {
        return {
          ok: false,
          reason: `${artifact.type} "${artifact.name}" cannot become MERGEABLE: ${bad}. Publish a new version that records a valid one — nothing was recorded`,
        };
      }
    }
    try {
      const evt = await this.deps.kernel.emit(
        "artifact.transition",
        {
          artifactId,
          from: artifact.status,
          to: transition.to,
          actorId,
          evidenceEventIds: transition.evidenceEventIds,
          comment: transition.comment,
          gateSatisfied: decision.decision === "ALLOW",
          ...(merge ? { merge } : {}),
        },
        { actorId, goalId },
      );
      await this.mirrorTransition(artifact, transition.to, evt, actorId);
      return { ok: true, eventId: evt.id };
    } catch (err) {
      if (err instanceof KernelRejectedError) return { ok: false, reason: err.message };
      throw err;
    }
  }

  /**
   * The domain events a transition implies, emitted right after it.
   *
   * `actorId` is whoever made the transition. For a merge that is the seat that ran
   * `merge`, which is not the patch's owner whenever a reviewer lands someone else's
   * work (the cronlite tech-lead merged the developer's CodePatch every time). The
   * mirrors used to be stamped with the OWNER, so in the second cronlite run every
   * `patch.merged` read "developer merged it" while the developer was idle, and the
   * kernel, which correlates an emit to the actor's live turn, filed them under the
   * developer's turn: the turn-effect count credited a turn that merged nothing, and
   * the turn trace for the merge showed the developer as its actor. They are now the
   * merger's, in the merger's turn, joined to the transition that caused them.
   *
   * What stays with the owner is the record `implementation.completed` reduces to.
   * That event is a `pass` on `implementation`, and a gate that names a seat
   * (`tech-lead.approve`, matched by id or role) is satisfied by a record that seat
   * is the actor of. Re-attributing the record to the merger would let the act of
   * merging stand in for that seat's own sign-off, which is a change to what the
   * gates mean, so the payload says whose work landed and the reducer keeps it.
   */
  private async mirrorTransition(a: Artifact, to: ArtifactStatus, cause: MeshEvent, actorId: string): Promise<void> {
    const causationId = cause.id;
    if (a.type === "CodePatch" && to === "MERGED") {
      const at = { actorId, goalId: a.goalId, causationId, correlationId: cause.correlationId };
      await this.deps.kernel.emit("patch.merged", { artifactId: a.id, name: a.name }, at);
      await this.deps.kernel.emit("implementation.completed", { artifactId: a.id, subject: "implementation", actorId: a.owner }, at);
    }
    if (a.type === "ReleasePlan") {
      await this.deps.kernel.emit("release.transition", { artifactId: a.id, to }, { goalId: a.goalId, causationId });
      if (to === "ACCEPTED") {
        await this.deps.kernel.emit("release.accepted", { artifactId: a.id, subject: `artifact:${a.id}` }, { goalId: a.goalId, causationId });
        await this.markCriterionEvidence("implementation-merged", { kind: "release-accepted", artifactRef: { uri: artifactUri(a.type, a.name, a.version) }, by: a.owner, recordedAt: this.deps.kernel.clock.iso() });
      }
    }
    await this.markTypeKeyedCriteria(a, to, a.owner);
    // The "a new ask will come" that `carryReviewAsksOver` promised the
    // reviewers of a superseded version: the owner has now submitted it.
    // Only for the version they were held for, and only if nobody has asked
    // for its review since — a reviewer the owner deliberately left off its
    // own ask is not re-added behind its back on a later resubmission.
    const held = to === "READY_FOR_REVIEW" ? this.carriedReviewAsks.get(a.id) : undefined;
    if (held) {
      this.carriedReviewAsks.delete(a.id);
      const now = this.state.artifacts.get(a.id);
      if (now && now.version === held.version && !this.reviewAskedFor(now, now.version)) {
        const uri = artifactUri(now.type, now.name, now.version);
        for (const c of held.asks) await this.reissueReviewAsk(now, c, uri, []);
      }
    }
  }

  /**
   * Criteria that follow from an artifact's TYPE reaching a status, not from the
   * word the signer used.
   *
   * Extracted because it only ever ran on the explicit `transition_artifact` path.
   * When an approval moves an artifact through the REDUCER instead — which is what
   * `recordDecision` does — `mirrorTransition` is never called, so the criterion
   * was never marked. Live consequence: tech-lead signed eleven approvals as
   * `subject: "quality"` (which its own role prompt tells it to do), four of them
   * ArchitectureDocuments, and every one moved the artifact while
   * `architecture.approved` stopped firing entirely. The artifacts were APPROVED
   * and the criterion they satisfy stayed unmarked, so the mission's own acceptance
   * record was silently wrong.
   *
   * Keyed off the artifact deliberately: a criterion is a statement about the
   * artifact, not about the capacity the signer was acting in. Every approval is
   * recorded as `review.approved`; an architecture-domain one that moves the
   * artifact to APPROVED/FINAL is followed by a DERIVED `architecture.approved`
   * (`derived: true`, skipped by its reducer so the approval is counted once) —
   * so the signer's word no longer picks which event records the verdict
   * (NOTES-live-run-20260925-2040.md §10).
   *
   * `by` is the acting seat, and it has to be threaded rather than defaulted:
   * `claimIsVerified` treats an absent claimer as runtime-derived and therefore
   * verified by construction, so passing `undefined` here would let a reviewer's
   * no-tool approval land EVIDENCED and defeat the verification gate.
   */
  private async markTypeKeyedCriteria(a: Artifact, to: ArtifactStatus, by: string | undefined): Promise<void> {
    if (to === "APPROVED" && (a.type === "ArchitectureDocument" || a.type === "ApiSpec")) {
      await this.markCriterionEvidence("architecture-approved", {
        kind: "architecture-approved",
        artifactRef: { uri: artifactUri(a.type, a.name, a.version) },
        by,
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
   * Count one live tool frame toward the verification gate.
   *
   * Only a call that COMPLETED counts, and only once it has: a claim made while
   * a test run is still going has not been checked by it, and a call the
   * permission gate refused ran nothing. Mesh calls never count (see
   * `verificationToolCount`). A turn with no open tally has already settled,
   * so a late frame changes nothing.
   */
  private noteVerificationFrame(
    agentId: string,
    names: Map<string, string>,
    ev: Parameters<NonNullable<AgentInput["onToolEvent"]>>[0],
  ): void {
    if (ev.kind === "tool_call") {
      names.set(ev.toolCallId, ev.name);
      return;
    }
    const name = names.get(ev.toolCallId);
    // Once per call: a repeated terminal frame for the same id must not count twice.
    names.delete(ev.toolCallId);
    const tally = this.turnVerificationTools.get(agentId);
    if (tally === undefined || name === undefined) return;
    if (ev.status !== "completed" || !countsAsChecking(name)) return;
    this.turnVerificationTools.set(agentId, tally + 1);
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
    // Already settled: a waiver, or a verdict that still stands. One that is
    // EVIDENCED but no longer satisfies the termination rule (withdrawn by a
    // reopen, yet carrying only the rejected round's evidence) is not settled, and
    // skipping it here would leave a mission no acceptance could ever move.
    if (c.status === "WAIVED" || (c.status === "EVIDENCED" && criterionSatisfied(goal, c))) return "SKIPPED";
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
      // Whoever claimed it: the seat whose turn made the acceptance, or the operator
      // when `by` says so. A runtime-derived record (the merge mirror) has no claimer
      // and is the runtime's. It used to be `human` for all of them, which made an
      // operator of every seat that accepted a criterion.
      { actorId: evidence.by ?? "system", goalId },
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

  /**
   * Refusal reason if `actorId` may not settle work right now, else null.
   *
   * `executeOp` already freezes work-moving agent ops behind this same halt,
   * but verdicts and task completions also arrive over HTTP, where there is
   * no turn and no seat: `POST /approvals` calls `recordDecision` and
   * `completeTask` straight through, and `resolveActor` attributes the call to
   * any id in the roster. An agent-attributed verdict was therefore the one
   * way to land work on a frozen mission.
   *
   * Deliberately NOT written as a lookup in `MISSION_HALTED_ALLOW_OPS`. That
   * set is consulted per-op inside a turn, where adding a verdict to it would
   * be inert — a halted mission activates no seat, so no turn ever runs to
   * spend the permission (`tests/policy/mission-freeze.test.ts`). It would
   * still re-open this path, which needs no seat at all. Keeping the rule here
   * stops a change aimed at seats from quietly reaching the HTTP route.
   *
   * Silent, like the `executeOp` guard: no `denied()` event. The conflict that
   * choice records is still open — see the comment on the halt guard in
   * `executeOp`; this is not the place to settle it.
   */
  private haltedSettlementRefusal(actorId: string): string | null {
    // The operator keeps their total bypass: deciding on a frozen mission is
    // how a human unfreezes one.
    if (actorId === HUMAN_AGENT_ID) return null;
    const halted = haltedGoalStatus(this.state);
    return halted ? haltReasonText(halted) : null;
  }

  /**
   * @param citedUri The `artifact://…/<version>` the caller actually reviewed, when
   *   it supplied one. Checked against the artifact's CURRENT version, because
   *   nothing else in the pipeline does: `resolveArtifactRef` throws the version
   *   away and returns the single mutable record, and the payload below rebuilds the
   *   ref from whatever version is current. So a reviewer who read v1 and approved
   *   after v2 landed had its approval recorded against v2, silently, and
   *   `approvalPath` advanced v2 on the strength of a review of v1.
   *
   *   Measured: 2 of 13 verdicts in one live run landed on a superseded version, and
   *   one of them — a rejection of a design system — was 5 of 7 findings already
   *   fixed in the version the reviewer had not seen. The author found it by hand
   *   and said so in prose; nothing in the mesh noticed.
   */
  async recordDecision(
    actorId: string,
    requestedKind: ApprovalKind,
    subject: string,
    artifactId?: string,
    comment?: string,
    citedUri?: string,
  ): Promise<{ ok: boolean; reason?: string; eventId?: string }> {
    // `let`: the verdict recorded is the one the seat is entitled to give, which is not always the
    // word it used (see `passNote` below).
    let kind: ApprovalKind = requestedKind;
    const goalId = this.state.activeGoalId;
    if (!goalId) return { ok: false, reason: "no active goal" };
    const frozen = this.haltedSettlementRefusal(actorId);
    if (frozen) return { ok: false, reason: frozen };
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
        // A verification report is evidence of a verification only if a seat that can verify wrote
        // it. The fourth cronlite run's pm (repository.read, requirements.accept, nothing else) wrote
        // a "Bug-Fix Verification Report" out of what QA had told it, got past the DRAFT refusal below
        // by submitting it itself, and closed two mandatory criteria against it while the product
        // had still not been tested by anyone who could. Refused with the route: the seat that can
        // verify publishes its own report, and the acceptance cites that. The operator is not held
        // to it (its acceptance is its own judgment), and a mesh with no seat that could verify is
        // let through (`unqualifiedAuthor`), or the only report there can be would wedge it.
        const unqualified = actorId === HUMAN_AGENT_ID ? null : unqualifiedAuthor(this.state, artifact);
        if (unqualified) {
          const domain = domainOfSubject(this.state, artifact.type, artifact.id);
          const cap = capabilityForReview(artifact.type);
          const reason =
            `artifact '${artifact.name}' is a ${artifact.type} written by ${artifact.owner}, which cannot verify one (it holds neither ${domain}.approve nor ${cap ?? "the capability that reviews one"}), ` +
            `so it cannot evidence mandatory criterion '${criterionId}': a ${artifact.type} is evidence of a verification only when a seat that can verify published it, and a summary of what someone else found is not one. ` +
            `Ask ${unqualified.qualified.join(" or ")} to publish its own report, then accept against that.`;
          await this.denied(actorId, subject, "accept criterion", { decision: "DENY", reason, ruleId: "mandatory-evidence-unqualified-author" });
          return { ok: false, reason };
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
        // Both authorities were tried, so surfacing only acceptCheck.reason
        // misnames the remedy: it reports that the seat lacks
        // 'requirements.accept' and stays silent about 'requirements.approve',
        // which would equally have allowed this. Read literally, the refusal
        // became an argument for granting the acceptance gate itself to
        // whoever was refused. Name both, and carry the engine's own reason.
        const reason =
          `cannot accept criterion '${criterionId}' — this needs authority 'requirements.accept' or ` +
          `'requirements.approve', and '${actorId}' holds neither (${acceptCheck.reason})`;
        await this.denied(actorId, subject, "accept criterion", { ...acceptCheck, reason });
        return { ok: false, reason };
      }
      const before = artifactId ? this.state.artifacts.get(artifactId)?.status : undefined;
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
      await this.auditTransition(artifactId, evt.id, goalId, undefined, actorId, before);
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
    // A verdict naming an artifact the mesh does not hold is refused, not
    // recorded. `resolveArtifactRef` hands an unresolvable id straight back, and
    // with no `artifact` every screen below was skipped: seq 101 of the
    // 2026-09-25 run approved `art-M3D4Y3VV00d5bb1584`, which never existed, got
    // ok:true, and the phantom approval is still in the log. A subject-level
    // verdict (no artifactId at all) is unaffected.
    if (artifactId && !artifact) {
      const reason = `unknown artifact '${artifactId}' — nothing was recorded. Name the artifact by the id or artifact:// URI its publish returned (mesh_inbox and mesh_query_events show both).`;
      await this.denied(actorId, artifactId, `${kind} ${subject}`, { decision: "DENY", reason, ruleId: "verdict.unknown-artifact" });
      return { ok: false, reason };
    }
    // A seat holding `<domain>.pass` and not `<domain>.approve` (every shipped QA and security seat)
    // that asks to approve is giving the only positive verdict its authority allows: the word is
    // `approve` because that is the word `mesh_approve` has, and refusing it for an authority nobody
    // holds left the pass unrecorded (the fifth cronlite run's QA, after testing the merged product).
    // Recorded as the pass it is entitled to, and said: a pass satisfies whatever an approve would, and
    // it is what the `qa.pass` gate and `quality-verified` read. A seat that holds both keeps the word
    // it chose, so a bare approve is still not a pass where the seat could have given either.
    const passNote =
      kind === "approve" && givesPassForApprove(this.state.agents.get(actorId)?.definition.authority, domain)
        ? `recorded as your ${domain}.pass: that is the verdict your authority gives in this domain, and a pass satisfies whatever an approve would (say kind "pass" to give it directly)`
        : undefined;
    if (passNote) kind = "pass";
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
    // A verdict on a version that no longer exists is not a verdict on this
    // artifact. Refused rather than caveated: the reviewer demonstrably never read
    // what it is about to settle, and letting it through is how a rejection whose
    // findings were already fixed advanced a supersedeing version.
    //
    // Guarded against the fuzzy resolver on purpose. `resolveArtifactRef` falls
    // through to `findArtifactByUri`, which matches on display name and slug and
    // prefers the newest version — so a model-invented URI can resolve to an
    // artifact with a different name entirely. Checking the version on such a match
    // would refuse a verdict the seat never miscited. So the check applies only when
    // the cited URI parses AND its kind and name are the ones that actually resolved.
    if (artifact && citedUri) {
      const cited = parseArtifactUri(citedUri);
      const sameArtifact = cited !== null && cited.kind === artifact.type && cited.name === artifact.name;
      if (cited?.version !== undefined && sameArtifact && cited.version !== artifact.version) {
        const reason =
          `you cited v${cited.version} but ${artifact.name} is now v${artifact.version} — read the current version before ruling on it. ` +
          `Nothing was recorded; your findings on v${cited.version} may already be addressed.`;
        await this.denied(actorId, artifactId, `${kind} ${subject}`, { decision: "DENY", reason, ruleId: "verdict.stale-version" });
        return { ok: false, reason };
      }
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
    // An approval always RECORDS a verdict — a `<role>.approve` gate token is a
    // signature, and seats legitimately sign artifacts sitting at a gate status
    // that no approval can advance. What it does not always do is MOVE the
    // artifact, and the signer was told `{ ok: true }` either way.
    //
    // That is the silent half. In a live mission a reviewer gave nine
    // architecture documents a reasoned APPROVE with binding errata, every one
    // of them recorded, none of them moved, and the implementers — who wake on
    // the approval event and are told by their role prompts that it unlocks
    // work — built on an architecture the projection still called unapproved.
    // Nothing in any of those turns said so.
    //
    // The refusal shape here is the caveat channel, not a hard failure: the op
    // SUCCEEDED, and refusing it would break the gate signatures that depend on
    // signing artifacts in exactly these statuses.
    //
    // Two holes this used to have, both found by watching a live run:
    //
    //  - it covered `approve`/`pass` only, so a REJECT that moved nothing came
    //    back clean. A reviewer rejected an already-merged CodePatch 35 minutes
    //    after it shipped; `review.rejected` went on the log reading
    //    authoritative, the artifact stayed MERGED, and nothing told either the
    //    reviewer or an auditor that the verdict was inert.
    //  - it asked `approvalPath` — the MACHINE — rather than the reducer. A
    //    document-machine artifact in DRAFT has a non-empty path (["FINAL"]),
    //    so approve-on-DRAFT looked advanceable and said nothing, while the
    //    reducer refused to move it. `verdictAdvances` asks the reducer's own
    //    question instead.
    const verdictKind: "approve" | "pass" | "reject" | "veto" | undefined =
      kind === "approve" || kind === "pass" || kind === "reject" || kind === "veto" ? kind : undefined;
    // Every approval is emitted as `review.approved` now (see below), so the
    // mirror asks the `review.approved` reducer's question, never the narrower
    // `architecture.approved` one.
    const movesIt = artifact && verdictKind ? verdictAdvances(this.state, actorId, artifact, verdictKind) : true;
    const inertApproval =
      artifact && verdictKind && !movesIt
        ? verdictKind === "reject" || verdictKind === "veto"
          ? artifact.status === "MERGED"
            ? `the verdict is recorded, but ${artifact.type} "${artifact.name}" is already MERGED and a rejection cannot unland it — open a revert or publish a new version if the work has to come out`
            : `the verdict is recorded, but ${artifact.type} "${artifact.name}" is ${artifact.status} and a rejection only moves something that is UNDER_REVIEW`
          : artifact.status === "REJECTED"
            ? // The reviewer cannot move it: REJECTED has one edge out, to DRAFT, and it is the owner's. "Move it to
              // review first" was what the sixth run's tech-lead was told, after it approved the CLI patch it had
              // rejected; the developer was never asked, and the mission completed without the CLI.
              `the verdict is recorded, but ${artifact.type} "${artifact.name}" is REJECTED and an approval cannot advance it: a rejected artifact goes back to DRAFT and only its owner (${artifact.owner}) can move it, so ask ${artifact.owner} to rework it (a new version with asVersionOf, then a review request) if you now want the work`
            : `the verdict is recorded, but ${artifact.type} "${artifact.name}" is ${artifact.status} and an approval cannot advance it from there — move it to review first if you meant to approve the work`
        : undefined;
    // The same seat, the same verdict, the same version, and nothing moves. pm
    // signed one v1 three times in the 2026-09-25 run. Still recorded — a repeat
    // may be what answers a second ask on that version — but said, so the seat
    // stops. Records are dropped on a new version, so a hit is this version.
    const sameKind = kind === "approve" || kind === "pass" || kind === "reject" ? kind : undefined;
    const repeat =
      artifact && sameKind && !movesIt
        ? [...this.state.approvals.values()].flat().find((r) => r.actorId === actorId && r.artifactId === artifact.id && r.kind === sameKind)
        : undefined;
    const repeatNote =
      repeat && artifact
        ? `you already recorded ${sameKind} on ${artifact.type} "${artifact.name}" v${artifact.version} (${repeat.evidenceEventId}); a second signature on the same version changes nothing`
        : undefined;
    // The author's own verdict, and it moved the artifact. That is allowed only because
    // no peer could have reviewed it (the screen above refuses it whenever one could), so
    // it is a real settlement, but it is not a second pair of eyes and a reader of the
    // record should be able to tell. TestReport: qa published, submitted and approved its
    // own report to FINAL, and the PM then cited it as independent evidence. The run
    // report derives the same fact from the approvals (an artifact approved only by its
    // owner); this tells the seat.
    const selfSettled = !!artifact && artifact.owner === actorId && (kind === "approve" || kind === "pass") && movesIt;
    const selfNote =
      selfSettled && artifact
        ? `no other seat could review this ${artifact.type}, so your own approval settled it — it stands, recorded as an approval by its author, and the run report lists it as self-approved`
        : undefined;
    const caveat = [inertApproval, repeatNote, selfNote, passNote].filter(Boolean).join("; ") || undefined;
    let type: EventType;
    if (kind === "approve" || kind === "pass") type = "review.approved";
    else if (kind === "reject" || kind === "veto") type = "review.rejected";
    else if (kind === "block") type = "message.sent";
    else type = "review.approved";
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
        const before = artifactId ? this.state.artifacts.get(artifactId)?.status : undefined;
        const evt = await this.deps.kernel.emit("review.rejected", { subject, artifactId, actorId, actorRole: this.state.agents.get(actorId)?.definition.role ?? actorId, comment, blockedInstead: true }, { actorId, goalId });
        await this.auditTransition(artifactId, evt.id, goalId, undefined, actorId, before);
      }
      return { ok: m.accepted, reason: m.reason, eventId: m.eventId };
    }
    const statusBefore = artifact?.status;
    const evt = await this.deps.kernel.emit(type, payload, { actorId, goalId });
    await this.auditTransition(artifactId, evt.id, goalId, undefined, actorId, statusBefore);
    // Type-keyed criteria, read AFTER the reducer has run. `mirrorTransition`
    // covers the explicit `transition_artifact` op; this covers the reducer path,
    // which is how an approval actually moves an artifact. Without it a seat
    // signing in a capacity other than the artifact's own domain moved the
    // artifact and marked nothing — eleven times in one live run.
    //
    // Deliberately NOT inside `auditTransition`: that is also called from two
    // `deriveSemantic` sites with `actorId: "system"` and no acting seat, and
    // `claimIsVerified` reads an absent claimer as verified-by-construction — so a
    // reviewer's no-tool approval would land EVIDENCED and defeat the verification
    // gate. Re-read from projections because the reducer has updated the status.
    const moved = artifactId ? this.state.artifacts.get(artifactId) : undefined;
    if (moved) await this.markTypeKeyedCriteria(moved, moved.status, actorId);
    // `architecture.approved` is DERIVED from the approval, never instead of it.
    //
    // It used to replace `review.approved` for every architecture-domain approve,
    // which split the verdict ledger: tech-lead queried `review.approved`, missed
    // its own approval, re-approved, and called the first one "unbacked" — a
    // claim that then rode into architect's continuity. And it fired whether or
    // not anything was approved: of 4 in the 2026-09-25 run, one approved a
    // DRAFT that stayed DRAFT. So now it marks the moment this approval actually
    // took the artifact to APPROVED/FINAL (or a subject-level architecture
    // sign-off with no artifact, which the single-agent benchmark uses), and
    // carries `derived: true` so its reducer records no second approval.
    if (domain === "architecture" && kind === "approve") {
      const landed = !artifact || (!!moved && moved.status !== statusBefore && (moved.status === "APPROVED" || moved.status === "FINAL"));
      if (landed) {
        await this.deps.kernel.emit(
          "architecture.approved",
          { ...payload, subject: "architecture", derived: true, viaEvent: evt.id },
          { actorId, goalId, causationId: evt.id },
        );
        await this.markCriterionEvidence("architecture-approved", {
          kind: "approval",
          ...(moved ? { artifactRef: { uri: artifactUri(moved.type, moved.name, moved.version) } } : {}),
          by: actorId,
          recordedAt: this.deps.kernel.clock.iso(),
        });
      }
    }
    await this.settleReviewAsks(actorId, artifact, evt.id);
    await this.noticeOwnerOfVerdict(actorId, kind, artifact?.id, statusBefore, type, evt.id);
    // `release` used to ride this branch, and the ternary then sent it to the
    // ELSE arm — so a release sign-off evidenced `security-verified`. A release
    // manager saying "ship it" is not a security review, and there is no
    // release criterion in `AUTO_EVIDENCED_CRITERIA` for it to close instead.
    // Nothing pinned the old mapping: the one test in this area
    // (`supervisor-turn.test.ts:569`) passes `subject: "security"`, which is
    // the separate branch below and is unaffected.
    if (kind === "pass" && domain === "quality") {
      await this.markCriterionEvidence("quality-verified", {
        kind: "quality-pass",
        by: actorId,
        recordedAt: this.deps.kernel.clock.iso(),
      });
    }
    if (kind === "pass" && domain === "security") {
      await this.markCriterionEvidence("security-verified", { kind: "security-pass", by: actorId, recordedAt: this.deps.kernel.clock.iso() });
    }
    return { ok: true, eventId: evt.id, reason: caveat };
  }

  private domainOfSubject(subject: string, artifactId?: string): string {
    return domainOfSubject(this.state, subject, artifactId);
  }

  /**
   * Wake an artifact's owner when somebody else's verdict MOVED it.
   *
   * The owner is the one seat with a next step on its own artifact (only the owner
   * can transition a CodePatch), and what woke it was configuration: the stock
   * developer listens for `review.rejected` and not for `review.approved`, so an
   * approval reached nobody who could act on it. In the cronlite run the patch sat
   * approved for 2.5 minutes while the PM asked the architect, four times, to
   * "transition it" (the architect correctly declined: not its artifact), until the
   * stall watchdog happened to pick the right seat.
   *
   * Only a verdict that moved the artifact says anything new, only when the owner did
   * not give it, and not when the owner's own interests already wake it for this
   * event (a second wake for the same verdict is exactly the repeat the dedup exists
   * to prevent). The wake goes through `activateAgent`, so every gate a wake faces
   * (paused, escalated, finished mission, budget, breaker) applies unchanged.
   */
  private async noticeOwnerOfVerdict(
    actorId: string,
    kind: ApprovalKind,
    artifactId: string | undefined,
    before: ArtifactStatus | undefined,
    eventType: EventType,
    eventId: string,
  ): Promise<void> {
    if (!artifactId || before === undefined) return;
    const now = this.state.artifacts.get(artifactId);
    if (!now || now.status === before) return;
    const owner = now.owner;
    if (owner === actorId || owner === HUMAN_AGENT_ID) return;
    const rec = this.state.agents.get(owner);
    if (!rec || rec.state.lifecycle === "RETIRED" || rec.state.lifecycle === "COMPLETED" || rec.state.lifecycle === "FAILED") return;
    if (rec.definition.interests.some((p) => interestMatches(p, eventType))) return;

    const rejected = kind === "reject" || kind === "veto";
    const rung = now.type === "CodePatch" ? (CODE_ARTIFACT_TRANSITIONS[now.status] ?? [])[0] : undefined;
    const what = `${now.type} "${now.name}" v${now.version}`;
    const note = rejected
      ? `${actorId} rejected your ${what}: read the verdict in your mailbox and publish a new version of the same artifact (asVersionOf) that answers it.`
      : `${actorId} approved your ${what}: it is now ${now.status}.` +
        (rung
          ? ` It needs ${rung} next${rung === "MERGED" ? ", which a seat holding git.merge does with the merge op" : ", and only you can move it there"}; nothing advances it automatically.`
          : " Carry on from there.");
    await this.activateAgent(owner, { kind: "interest_event", eventId, eventType, note }).catch(() => undefined);
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
      // `decision` rides along because DENY and DEFER need different words to
      // the operator: DEFER clears itself when the budget or the goal moves,
      // DENY does not and waiting for it is the trap. Without this the only
      // way to tell them apart was to re-derive policy knowledge in the UI.
      { from: actorId, action, subject: subjectId, reason: decision.reason, ruleId: decision.ruleId, decision: decision.decision, denied: true },
      // Explicitly, not via the kernel's default. This is the single choke point
      // for every policy denial in the file — the op path, the criterion path,
      // `reportActivationDenied`, `claimTask`, `transitionArtifact`, the
      // TEST_RESULT and PATCH_READY refusals — and before this it carried no
      // correlation at all: one live run had a turn link on 1 of 19 rejections.
      // A refusal nobody can trace to a turn is a refusal nobody can act on.
      { actorId, goalId, correlationId: this.turnCorrelation(actorId) },
    );
  }

  /**
   * TurnRunner hook: the scheduler refused an activation on policy grounds.
   * Routes it to the same `message.rejected` the op path emits, so an
   * activation-level block (`max-activations`, `thread-budget`, `goal-paused`,
   * a transition gate) is visible in exactly the place an op-level one already
   * is, instead of the agent going quiet with no record anywhere.
   */
  async reportActivationDenied(agentId: string, decision: PolicyDecisionResult, reason: ActivationReason): Promise<void> {
    await this.denied(agentId, undefined, `activate (${reason.kind})`, decision);
  }

  async claimTask(actorId: string, taskId: string): Promise<{ ok: boolean; reason?: string }> {
    const task = this.state.tasks.get(taskId);
    if (!task) return { ok: false, reason: "unknown task" };
    if (task.status !== "OPEN" && task.assignedTo !== actorId) return { ok: false, reason: `task is ${task.status}` };
    const ctx = { config: this.config, projections: this.state, goal: this.state.goals.get(task.goalId) };
    for (const cap of task.requiredCapabilities) {
      // A marker `completeTask` reads, not a capability any seat can hold:
      // `context.ts` already tells the seat "you can claim it" on this basis, and
      // checking it here refused the claim to every seat, for every gated task.
      if (cap === IMPLEMENTATION_GATE_MARKER) continue;
      const decision = this.deps.policy.evaluateCapability(actorId, cap, ctx);
      if (decision.decision !== "ALLOW") {
        await this.denied(actorId, taskId, `claim task (missing capability ${cap})`, decision);
        return { ok: false, reason: `missing capability ${cap}: ${decision.reason}` };
      }
    }
    // Upstream work first. Refused out loud, naming each blocker and who holds
    // it, so the seat can go and help it along — or pick something claimable —
    // instead of building ahead of it as frontend did with W6-S3 (§16).
    const unmet = unmetTaskDependencies(this.state, task);
    if (unmet.length > 0) {
      const blockers = unmet.map((id) => {
        const dep = this.state.tasks.get(id)!;
        const holder = dep.claimedBy ?? dep.assignedTo;
        return `${id} "${dep.title}" (${dep.status}${holder ? `, ${holder}` : ", unclaimed"})`;
      });
      const reason = `task ${taskId} depends on work not yet completed: ${blockers.join("; ")} — claim it once those complete`;
      await this.denied(actorId, taskId, "claim task (dependencies not completed)", { decision: "DENY", reason, ruleId: "task.dependencies-unmet" });
      return { ok: false, reason };
    }
    await this.deps.kernel.emit("task.claimed", { taskId, agentId: actorId, reassign: task.assignedTo && task.assignedTo !== actorId }, { actorId });
    // A claim on a task cut from an artifact that has moved on succeeds — the
    // work may well still be right — but the claimant is told, because the
    // task text is the one thing it will not think to re-check.
    const stale = staleTaskPins(this.state, task);
    if (stale.length > 0) {
      return { ok: true, reason: `claimed, but this task was cut from ${stale.join(", ")} — re-read the newer version before starting; the task text may be out of date` };
    }
    return { ok: true };
  }

  async completeTask(actorId: string, taskId: string, summary: string, artifacts?: ArtifactRef[]): Promise<{ ok: boolean; reason?: string }> {
    // Checked before the task itself: the mission being frozen is the reason,
    // whatever state the task is in. Reachable the same way `recordDecision`
    // is — `POST /approvals` with a `taskId` completes a task outside any turn.
    const frozen = this.haltedSettlementRefusal(actorId);
    if (frozen) return { ok: false, reason: frozen };
    const task = this.state.tasks.get(taskId);
    if (!task) return { ok: false, reason: "unknown task" };
    if (task.status !== "CLAIMED" && task.status !== "IN_PROGRESS") return { ok: false, reason: `task is ${task.status}` };
    if (task.claimedBy !== actorId && actorId !== HUMAN_AGENT_ID) return { ok: false, reason: `task claimed by ${task.claimedBy}` };
    const gate = this.config.transitionGates["implementation.completed"];
    if (gate && gate.length > 0 && task.requiredCapabilities.includes(IMPLEMENTATION_GATE_MARKER)) {
      const res = checkApprovals(this.state, gate, undefined);
      if (!res.ok) return { ok: false, reason: `implementation gate unsatisfied, missing: ${res.missing.join(", ")}` };
    } else if (gate && gate.length > 0 && !this.completionGateUnboundWarned) {
      // Said, not widened. skill-panel configured `implementation.completed:
      // requires tech-lead.approve` and none of its 10 tasks carried the
      // marker, so a task with an unreviewed patch completed with nothing
      // consulted (2026-09-25, §7). Applying the gate to every task instead is
      // not the smaller correct fix: it is mission-scoped (`checkApprovals`
      // with no artifact, so any tech-lead approval anywhere satisfies it — it
      // would not have held that completion either), and demo-stub and
      // spring-boot configure the same key with `qa.pass`, which QA gives AFTER
      // implementation, so gating every task on it could deadlock them. The
      // rule is surfaced to the operator the first time it lets one through.
      this.completionGateUnboundWarned = true;
      const tasks = [...this.state.tasks.values()].filter((t) => t.goalId === task.goalId);
      const marked = tasks.filter((t) => t.requiredCapabilities.includes(IMPLEMENTATION_GATE_MARKER)).length;
      this.auditLine(
        `WARNING transition gate 'implementation.completed' (requires ${gate.join(", ")}) did not bind task ${taskId}: ` +
          `at task completion it binds only tasks listing "${IMPLEMENTATION_GATE_MARKER}" in requiredCapabilities, and ${marked} of ${tasks.length} task(s) in this goal do. ` +
          `It still gates ReleasePlan -> IMPLEMENTED.`,
      );
    }
    // The `artifacts` field was accepted and never read. `mesh_merge`'s tool
    // schema advertises it as "evidence artifact URIs" and the value went straight
    // into the payload with no existence check — so a completion could cite an
    // artifact that does not exist, or cite nothing at all, and the board recorded
    // the task as done either way. Contrast `claimTask` directly above, which does
    // enforce every declared `requiredCapability` and records a `denied()` when one
    // is missing: the claim is gated on a machine-checkable precondition and the
    // completion was gated on nothing.
    //
    // Deliberately NOT a `requiredArtifacts` contract. No such field exists
    // anywhere in the repo, and adding one buys a check `artifactForRef` already
    // performs at the cost of a new config surface and a new class of deadlock.
    // This only holds the seat to the evidence IT chose to cite.
    for (const ref of artifacts ?? []) {
      const uri = typeof ref === "string" ? ref : ref?.uri;
      if (!uri) continue;
      if (!artifactForRef(this.state, undefined, uri)) {
        await this.denied(actorId, taskId, "complete task (unresolvable evidence)", {
          decision: "DENY",
          reason: `cited evidence '${uri}' resolves to no artifact — publish it, or cite it by ref: artifact://<Type>/<name>/<version>`,
          ruleId: "task.evidence-unresolvable",
        });
        return { ok: false, reason: `cited evidence '${uri}' resolves to no artifact` };
      }
    }
    // Bounded like the task prose it closes: this summary is replayed out of
    // the log into every later prompt that recounts the task, so an unbounded
    // one is charged again on every turn that reads it.
    const bounded = String(summary ?? "").trim().slice(0, MAX_TASK_SUMMARY_CHARS);
    await this.deps.kernel.emit("task.completed", { taskId, agentId: actorId, summary: bounded, artifacts }, { actorId });
    return { ok: true };
  }

  async proposeDecision(
    actorId: string,
    topic: string,
    decision: Record<string, unknown>,
    evidence?: ArtifactRef[],
  ): Promise<DecisionRecord & { routedTo: string[]; routing: string; askId?: string }> {
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
    // A proposal used to go nowhere: no seat was asked to ratify it and no
    // context rendered it, so backend's pnpm proposal — contradicting the
    // ratified ADR-0013 (npm) — sat PROPOSED for the rest of the run
    // (skill-panel 2026-09-25, §16). It is now an obliging ask to every seat
    // that can ratify: `ratifyDecision` checks `architecture.approve`, whatever
    // the topic, so that authority is the routing key. The ratification itself
    // answers the ask (the `decision.ratified` reducer closes it); a ratifier
    // who disagrees discharges it with a reason, which reaches the proposer.
    const ratifiers = [...this.state.agents.values()]
      .filter((rec) => {
        const id = rec.definition.id;
        if (id === actorId || id === HUMAN_AGENT_ID) return false;
        if (rec.state.lifecycle === "COMPLETED" || rec.state.lifecycle === "FAILED" || rec.state.lifecycle === "RETIRED") return false;
        return holdsAuthority(rec.definition.authority, "architecture", "approve");
      })
      .map((rec) => rec.definition.id);
    const selfCan = holdsAuthority(this.state.agents.get(actorId)?.definition.authority, "architecture", "approve");
    if (ratifiers.length === 0) {
      return {
        ...d,
        routedTo: [],
        routing: selfCan
          ? `no other seat holds architecture.approve — ratify it yourself with mesh_decision_ratify once it is settled`
          : `no seat holds architecture.approve, so only the operator can ratify it; it stays PROPOSED until then`,
      };
    }
    const preview = JSON.stringify(decision) ?? "";
    const sent = await this.sendMessage({
      from: actorId,
      to: ratifiers,
      type: "REQUEST",
      newThread: { subject: `ratify ${d.id}: ${topic}`.slice(0, 200) },
      artifactRefs: (evidence ?? []).filter((r) => typeof r?.uri === "string" && r.uri.startsWith("artifact://")),
      payload: {
        ratifyDecision: d.id,
        topic,
        decision: preview.length > MAX_DECISION_PREVIEW_CHARS ? `${preview.slice(0, MAX_DECISION_PREVIEW_CHARS)}…` : decision,
        question: `${actorId} proposed decision ${d.id} ("${topic}"). Ratify it with mesh_decision_ratify { decisionId: "${d.id}" } if it should become a shared fact — that also answers this ask — or mesh_discharge this ask with your reason if it should not.`,
      },
    });
    if (!sent.accepted) {
      this.auditLine(`decision ${d.id}: routing to ${ratifiers.join(", ")} refused: ${sent.reason ?? "unknown"}`);
      return { ...d, routedTo: [], routing: `it could not be routed to ${ratifiers.join(", ")} for ratification: ${sent.reason ?? "refused"}` };
    }
    return { ...d, routedTo: ratifiers, routing: `asked ${ratifiers.join(", ")} to ratify it`, askId: sent.messageId };
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

  private buildDisagreementContent(input: { reason: string; artifactId?: string; threadId?: string; detail?: unknown }): Record<string, unknown> {
    const positions: Array<Record<string, unknown>> = [];
    const artifact = input.artifactId ? this.state.artifacts.get(input.artifactId) : undefined;
    // Verdicts only count when they belong to the thing being escalated.
    //
    // Unfiltered, `relevant` is every verdict in the goal, and the card an
    // operator must decide on gets whatever happened to be nearby: measured
    // 2026-09-25, a seat-raised escalation about a blocked CodePatch came back
    // with ux-designer's REJECT of the UI design system in `positions` and
    // `remainingDisagreement: ["ux-designer"]` — naming a party that had never
    // seen the artifact in question. With no subject at all there are no
    // positions: a card that says nothing is better than one that names the
    // wrong disagreement, and the fields below carry the escalation's own
    // subject where it exists.
    const hasSubject = !!artifact || !!input.threadId;
    const relevant = hasSubject
      ? [...this.state.messages.values()].filter((m) => {
          if (input.threadId && m.threadId !== input.threadId) return false;
          if (artifact && !m.artifactRefs.some((r) => r.uri.includes(artifact.name))) return false;
          return ["REJECT", "BLOCK", "VETO", "CHALLENGE", "APPROVE", "ESCALATE"].includes(m.type);
        })
      : [];
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
    // The escalation's own subject. A wait cycle is made of requests, not
    // verdicts, so a positions-only card for the one escalation type that halts
    // a mission rendered as `{positions: [], evidence: [], remainingDisagreement:
    // []}` while the ids of the two blocked requests sat unread in `detail`. A
    // seat raised the same escalation by hand minutes later and named them
    // itself — that is the standard this record should meet.
    const blockedRequests = Array.isArray((input.detail as { blockedRequests?: unknown } | undefined)?.blockedRequests)
      ? (input.detail as { blockedRequests: unknown[] }).blockedRequests
      : [];
    return {
      reason: input.reason,
      blockedRequests,
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
      // A seat's budget card is retired by the raise itself (see `raiseBudget`),
      // and the dashboard's "add & resume" raises first and responds second — so
      // the response always lands here. The note ("raised; keep research
      // shallow") is guidance for the seat, and dropping it as a no-op would
      // un-park the seat without it.
      const seat = this.seatOfBudgetCard(esc);
      if (seat && response.trim() && this.state.agents.has(seat)) {
        await this.sendMessage({
          from: HUMAN_AGENT_ID,
          to: [seat],
          type: "INFORM",
          newThread: { subject: `escalation response ${escalationId}` },
          payload: { escalationId, response },
          priority: "URGENT",
        });
      }
      await this.reconcileDerivedEscalations();
      if (this.state.activeGoalId) await this.resumeIfNothingPending(this.state.activeGoalId);
      return { ok: true, reason: "already resolved by the mesh — nothing left to decide" };
    }
    if (esc.status !== "OPEN") return { ok: false, reason: `escalation is ${esc.status}` };
    await this.deps.kernel.emit("escalation.responded", { escalationId, response, respondedBy: by }, { actorId: by });
    await this.deps.kernel.emit("human.input", { action: "escalation_response", escalationId, response }, { actorId: HUMAN_AGENT_ID });
    const goal = this.state.goals.get(esc.goalId);
    // A seat's budget card never halted the goal, so answering it must not
    // resume one that some OTHER card halted.
    const parkedSeat = this.seatOfBudgetCard(esc);
    if (goal && goal.status === "ESCALATED" && !parkedSeat) {
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
    // The answer is the operator's word that the mission should move again, so
    // the seats the MESH parked for terminal failure come back here — before
    // every activation below, which is what makes them admittable again: a
    // SUSPENDED seat is refused by `activateAgent` by lifecycle, and that is
    // why answering the stall card used to change nothing. Seats the OPERATOR
    // suspended are not touched (see `reviveTerminalSuspended`).
    await this.reviveTerminalSuspended(`escalation responded: ${response.slice(0, 120)}`);
    // The provider card's answer ("topped up", "retry") is the operator saying
    // the provider may be back: probe NOW instead of sitting out the backoff.
    // Before the recovery wakes below, so the first of them is admitted as the
    // probe rather than held behind an open breaker.
    if (esc.conflictKey === providerCardKey(esc.goalId) && this.deps.scheduler.probeProviderNow?.()) {
      this.auditLine(`escalation response: probing the model provider now instead of waiting out the backoff (${response.slice(0, 120)})`);
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
    // Answered without a raise: the operator's word is recorded and reaches the
    // seat's mailbox, but the seat stays parked — its ledger still cannot pay
    // for a turn, and the watchdog will say so again with a fresh card.
    if (parkedSeat && this.state.budgets.get(agentKey(esc.goalId, parkedSeat))?.exceeded) {
      return { ok: true, reason: `${parkedSeat} is still parked: its token budget is exhausted — raise it (budget key ${agentKey(esc.goalId, parkedSeat)}) to let it take turns again` };
    }
    return { ok: true };
  }

  /**
   * The seat a card parks, when it is a seat's own budget card
   * (`budget:agent:<goal>/<seat>` — the door's card and the watchdog's share
   * the key, so they dedupe into one), else null. These cards are the operator's
   * to answer but they never halt the goal, which is what the callers key on.
   */
  private seatOfBudgetCard(esc: Escalation): string | null {
    const m = /^budget:agent:([^/]+)\/(.+)$/.exec(String(esc.conflictKey ?? ""));
    return m && m[1] === esc.goalId ? m[2] : null;
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
  ): Promise<{ ok: boolean; reason?: string; key?: string; previous?: number | null; limit?: number; unblocked?: boolean; warnings?: string[] }> {
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
    const warnings = missionCapWarnings(this.state, this.config, key, next);
    // Read before the raise clears it: only a seat that WAS parked is woken, so
    // a pre-emptive raise does not buy a turn nobody asked for.
    const wasParked = ledger.exceeded;
    const res = await this.deps.budget.raiseLimit(key, next, {
      actorId: by,
      goalId,
      reason: opts.reason ?? "operator raise from escalation",
      decidedBy: "operator",
      warnings,
    });
    if (warnings.length > 0) this.auditLine(`budget ${key} raised to ${next}: ${warnings.join("; ")}`);
    if (wasParked) await this.unparkSeat(key, `the operator raised your token budget to ${next}`);
    return { ok: true, key, previous: res.previous, limit: res.limit, unblocked: res.unblocked, ...(warnings.length > 0 ? { warnings } : {}) };
  }

  /**
   * Put a seat parked on its own budget back to work, once its ledger can pay
   * for a turn again: retire its card (the raise answered it) and wake it, since
   * every wake it was sent while parked was deferred and none of them is coming
   * back. A no-op for any other key, and for a ledger still latched.
   */
  private async unparkSeat(key: string, why: string): Promise<void> {
    const goalId = this.state.activeGoalId;
    if (!goalId || !key.startsWith(`agent:${goalId}/`)) return;
    if (this.state.budgets.get(key)?.exceeded) return;
    const seat = key.slice(`agent:${goalId}/`.length);
    for (const esc of [...this.state.escalations.values()]) {
      if (esc.status !== "OPEN" || this.seatOfBudgetCard(esc) !== seat) continue;
      await this.deps.kernel.emit(
        "escalation.auto_resolved",
        { escalationId: esc.id, reason: `auto-resolved: ${why}, so ${seat} is no longer parked`, key },
        { actorId: "termination-manager", goalId },
      );
    }
    if (this.state.agents.has(seat)) {
      await this.activateAgent(seat, { kind: "recovery", note: `${why}; you are no longer parked — pick up your mail and what you owe` }).catch(() => undefined);
    }
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
   * Rewrite the mission statement of a running goal.
   *
   * The goal is the only state no agent can write, and it is the reference
   * every acceptance judgement is measured against — so a replacement lands as
   * an event carrying the text it replaced, never a silent field assignment.
   * Without the `previous` in the payload, a log where a mission completed
   * against criteria written for a different target is indistinguishable from
   * one where it did not.
   */
  async reviseGoalDescription(
    description: string,
    opts: { by?: string; reason?: string; goalId?: GoalId } = {},
  ): Promise<{ ok: boolean; reason?: string; previous?: string }> {
    const gid = opts.goalId ?? this.state.activeGoalId;
    if (!gid) return { ok: false, reason: "no active goal" };
    const goal = this.state.goals.get(gid);
    if (!goal) return { ok: false, reason: "unknown goal" };
    const next = description?.trim();
    if (!next) return { ok: false, reason: "description must be a non-empty string" };
    if (next === goal.description) return { ok: false, reason: "description is unchanged" };
    const actorId = opts.by ?? HUMAN_AGENT_ID;
    const ctx = { config: this.config, projections: this.state, goal };
    const check = this.deps.policy.evaluateAuthority(actorId, "requirements", "revise", ctx);
    if (check.decision !== "ALLOW") {
      await this.denied(actorId, gid, "revise goal description", check);
      return { ok: false, reason: check.reason };
    }
    const previous = goal.description;
    await this.deps.kernel.emit(
      "goal.description_revised",
      { goalId: gid, description: next, previous, reason: opts.reason },
      { actorId, goalId: gid },
    );
    return { ok: true, previous };
  }

  /**
   * Edit a criterion's text, or its mandatory flag, in place.
   *
   * Demotion (`mandatory: false`) runs the same completion guard as removal:
   * dropping an unsatisfied criterion out of the mandatory set moves the
   * denominator exactly as deleting it would, so the two paths cannot have
   * different rules without the weaker one becoming the way around the
   * stronger one.
   */
  async reviseCriterion(
    criterionId: string,
    patch: { description?: string; mandatory?: boolean },
    opts: { by?: string; reason?: string; goalId?: GoalId } = {},
  ): Promise<{ ok: boolean; reason?: string }> {
    const gid = opts.goalId ?? this.state.activeGoalId;
    if (!gid) return { ok: false, reason: "no active goal" };
    const goal = this.state.goals.get(gid);
    if (!goal) return { ok: false, reason: "unknown goal" };
    const c = goal.acceptanceCriteria.find((x) => x.id === criterionId);
    if (!c) return { ok: false, reason: `unknown criterion '${criterionId}'` };
    const clean: { description?: string; mandatory?: boolean } = {};
    const nextDescription = patch.description?.trim();
    if (nextDescription) clean.description = nextDescription;
    if (typeof patch.mandatory === "boolean" && patch.mandatory !== c.mandatory) clean.mandatory = patch.mandatory;
    if (Object.keys(clean).length === 0) return { ok: false, reason: "provide a new description and/or a changed mandatory flag" };
    if (clean.mandatory === false) {
      const remaining = goal.acceptanceCriteria.map((x) => (x.id === criterionId ? { ...x, mandatory: false } : x));
      if (criteriaWouldComplete(goal, remaining) && !criteriaWouldComplete(goal, goal.acceptanceCriteria)) {
        return {
          ok: false,
          reason:
            `refusing to demote '${criterionId}': it is the only mandatory criterion still unproven, so dropping it from the ` +
            `mandatory set would complete the mission without the work being done. Satisfy or waive it instead.`,
        };
      }
    }
    const actorId = opts.by ?? HUMAN_AGENT_ID;
    const ctx = { config: this.config, projections: this.state, goal };
    const check = this.deps.policy.evaluateAuthority(actorId, "requirements", "revise", ctx);
    if (check.decision !== "ALLOW") {
      await this.denied(actorId, criterionId, "revise criterion", check);
      return { ok: false, reason: check.reason };
    }
    await this.deps.kernel.emit(
      "requirement.revised",
      {
        goalId: gid,
        criterionId,
        ...clean,
        previous: { description: c.description, mandatory: c.mandatory },
        reason: opts.reason,
      },
      { actorId, goalId: gid },
    );
    return { ok: true };
  }

  /**
   * Drop a criterion from the goal entirely.
   *
   * The dangerous one. Completion is measured as "every mandatory criterion is
   * satisfied", so removing the last UNSATISFIED criterion does not merely
   * shrink the checklist — it makes the remaining set vacuously complete, and
   * the very next watchdog tick emits `goal.completed` on a mission where
   * nothing was finished. Two refusals stop that:
   *
   *   1. never empty the mandatory set — a mission with nothing to prove
   *      cannot be judged at all;
   *   2. never let the removal itself be what completes the goal. The second
   *      `criteriaWouldComplete` call is what makes this precise: if the goal
   *      was ALREADY completable before the edit, this removal is not the
   *      cause and there is nothing to protect against.
   *
   * The guard uses the termination manager's own `criterionSatisfied` rule
   * rather than a local copy, so it cannot drift out of agreement with the
   * verdict it exists to prevent.
   */
  async removeCriterion(
    criterionId: string,
    opts: { by?: string; reason: string; goalId?: GoalId },
  ): Promise<{ ok: boolean; reason?: string }> {
    const gid = opts.goalId ?? this.state.activeGoalId;
    if (!gid) return { ok: false, reason: "no active goal" };
    const goal = this.state.goals.get(gid);
    if (!goal) return { ok: false, reason: "unknown goal" };
    const why = opts.reason?.trim();
    if (!why) return { ok: false, reason: "removing a criterion requires an explicit reason" };
    const removed = goal.acceptanceCriteria.find((x) => x.id === criterionId);
    if (!removed) return { ok: false, reason: `unknown criterion '${criterionId}'` };
    const remaining = goal.acceptanceCriteria.filter((x) => x.id !== criterionId);
    if (removed.mandatory && remaining.every((x) => !x.mandatory)) {
      return {
        ok: false,
        reason:
          `refusing to remove '${criterionId}': it is the last mandatory criterion, and a mission with nothing left to ` +
          `prove can never be judged complete or incomplete.`,
      };
    }
    if (criteriaWouldComplete(goal, remaining) && !criteriaWouldComplete(goal, goal.acceptanceCriteria)) {
      return {
        ok: false,
        reason:
          `refusing to remove '${criterionId}': every other mandatory criterion is already satisfied, so removing this one ` +
          `would complete the mission without the work being done. Satisfy it, waive it, or remove a different criterion.`,
      };
    }
    const actorId = opts.by ?? HUMAN_AGENT_ID;
    const ctx = { config: this.config, projections: this.state, goal };
    const check = this.deps.policy.evaluateAuthority(actorId, "requirements", "remove", ctx);
    if (check.decision !== "ALLOW") {
      await this.denied(actorId, criterionId, "remove criterion", check);
      return { ok: false, reason: check.reason };
    }
    await this.deps.kernel.emit(
      "requirement.removed",
      {
        goalId: gid,
        criterionId,
        reason: why,
        // The whole criterion, not just its id: after the splice this event is
        // the only record that it ever existed, and an operator reviewing the
        // decision needs to see what was dropped, not a bare identifier.
        removed: { description: removed.description, mandatory: removed.mandatory, status: removed.status },
      },
      { actorId, goalId: gid },
    );
    return { ok: true };
  }

  /**
   * Append acceptance criteria to the live goal.
   *
   * Reuses `requirements.created` rather than minting a fifth event type: that
   * reducer already appends and dedupes by id, and a second "criteria were
   * added" event would give replay two ways to say one thing.
   *
   * Adding is the safe direction — widening the mandatory set can only move a
   * goal further from complete — so unlike removal this needs no completion
   * guard. It carries the same authority anyway, because whoever can widen the
   * definition of done can also stall a mission indefinitely.
   *
   * A duplicate id is refused rather than passed through: the reducer skips
   * ids it already holds, so emitting one would report success and change
   * nothing, which is the partial silence this surface exists to avoid.
   */
  async addCriteria(
    criteria: AcceptanceCriterion[],
    opts: { by?: string; reason?: string; goalId?: GoalId } = {},
  ): Promise<{ ok: boolean; reason?: string; added?: string[] }> {
    const gid = opts.goalId ?? this.state.activeGoalId;
    if (!gid) return { ok: false, reason: "no active goal" };
    const goal = this.state.goals.get(gid);
    if (!goal) return { ok: false, reason: "unknown goal" };
    if (!Array.isArray(criteria) || criteria.length === 0) return { ok: false, reason: "provide at least one criterion" };
    const minted: AcceptanceCriterion[] = [];
    for (const c of criteria) {
      const description = typeof c?.description === "string" ? c.description.trim() : "";
      if (!description) return { ok: false, reason: "every criterion needs a description" };
      const id = typeof c?.id === "string" && c.id.trim() ? c.id.trim() : shortHash(description);
      if (goal.acceptanceCriteria.some((x) => x.id === id) || minted.some((x) => x.id === id)) {
        return { ok: false, reason: `criterion '${id}' already exists — revise it instead of adding it twice` };
      }
      minted.push({ id, description, mandatory: c?.mandatory !== false, status: "UNSATISFIED", evidence: [] });
    }
    const actorId = opts.by ?? HUMAN_AGENT_ID;
    const ctx = { config: this.config, projections: this.state, goal };
    const check = this.deps.policy.evaluateAuthority(actorId, "requirements", "revise", ctx);
    if (check.decision !== "ALLOW") {
      await this.denied(actorId, gid, "add criteria", check);
      return { ok: false, reason: check.reason };
    }
    await this.deps.kernel.emit(
      "requirements.created",
      { goalId: gid, criteria: minted, reason: opts.reason },
      { actorId, goalId: gid },
    );
    return { ok: true, added: minted.map((c) => c.id) };
  }

  /**
   * Retire a seat: terminal, with no way back — contrast `suspendAgent`.
   *
   * Tears the live session down BEFORE emitting, for the same reason
   * `suspendAgent` does. The event flips the projection to RETIRED, and a
   * runtime session still streaming a turn into a seat the projection calls
   * dead is exactly how a retired agent goes on writing to the log.
   */
  async retireAgent(agentId: string, opts: { by?: string; reason: string }): Promise<{ ok: boolean; reason?: string }> {
    const rec = this.state.agents.get(agentId);
    if (!rec) return { ok: false, reason: `unknown agent '${agentId}'` };
    if (agentId === HUMAN_AGENT_ID) return { ok: false, reason: "the human seat cannot be retired" };
    if (rec.state.lifecycle === "RETIRED") return { ok: false, reason: `agent '${agentId}' is already retired` };
    const why = opts.reason?.trim();
    if (!why) return { ok: false, reason: "retiring a seat requires an explicit reason" };
    const actorId = opts.by ?? HUMAN_AGENT_ID;
    const goalId = this.state.activeGoalId ?? undefined;
    const ctx = { config: this.config, projections: this.state, goal: goalId ? this.state.goals.get(goalId) : undefined };
    const check = this.deps.policy.evaluateAuthority(actorId, "agents", "retire", ctx);
    if (check.decision !== "ALLOW") {
      await this.denied(actorId, agentId, "retire agent", check);
      return { ok: false, reason: check.reason };
    }
    const sess = this.sessions.get(agentId);
    if (sess) await sess.runtime.suspend(sess.session).catch(() => undefined);
    await this.deps.kernel.emit("agent.retired", { agentId, reason: why }, { actorId, goalId });
    // Retirement is for good: a restorable session left on disk is a
    // transcript nothing should ever resume. Best-effort like every registry
    // write — boot's reconcile prunes it if this one is lost.
    await this.deps.sessionRegistry?.forget(agentId).catch(() => undefined);
    return { ok: true };
  }

  /**
   * Bring `sessions.json` back in line with the log on boot.
   *
   * The file is written by `ensureSession` and by the server's `onRotate`, and
   * the rotation write is fire-and-forget: a failed one is caught into the
   * audit log and the file silently keeps the pre-rotation row, which the next
   * restart then restores — onto a transcript the seat abandoned. The log is
   * the authority on both questions the file answers:
   *
   *   - a seat's last `session.rotated` names the session it moved onto; a row
   *     that is that rotation's (or any earlier rotation's) abandoned session,
   *     or that was written before it, loses to it;
   *   - a seat the log retired, or never knew, keeps no restorable row.
   *
   * A row written AFTER the last rotation for a session the log never
   * abandoned is newer than anything the log says, and is kept.
   */
  private async reconcileSessionRegistry(): Promise<void> {
    const registry = this.deps.sessionRegistry;
    if (!registry?.list) return;
    let rows: Awaited<ReturnType<NonNullable<typeof registry.list>>>;
    try {
      rows = await registry.list();
    } catch (err) {
      this.auditLine(`session registry reconcile skipped: ${(err as Error).message}`);
      return;
    }
    const rotations = new Map<string, { to: string; at: string; abandoned: Set<string> }>();
    for (const e of await this.deps.kernel.store.read({ types: ["session.rotated"] })) {
      const p = e.payload as { agentId?: string; fromSessionId?: string; toSessionId?: string };
      const agentId = p.agentId ?? e.actorId;
      if (!agentId || typeof p.toSessionId !== "string" || !p.toSessionId) continue;
      const r = rotations.get(agentId) ?? { to: p.toSessionId, at: e.timestamp, abandoned: new Set<string>() };
      if (typeof p.fromSessionId === "string") r.abandoned.add(p.fromSessionId);
      r.to = p.toSessionId;
      r.at = e.timestamp;
      rotations.set(agentId, r);
    }
    const byAgent = new Map(rows.map((r) => [r.agentId, r]));
    for (const row of rows) {
      const rec = this.state.agents.get(row.agentId);
      if (!rec || rec.state.lifecycle === "RETIRED") {
        await registry.forget(row.agentId).catch(() => undefined);
        this.auditLine(`session registry: pruned ${row.agentId}'s session ${row.sessionId} — the seat is ${rec ? "retired" : "not in the log"}`);
      }
    }
    for (const [agentId, r] of rotations) {
      const rec = this.state.agents.get(agentId);
      if (!rec || rec.state.lifecycle === "RETIRED") continue;
      const row = byAgent.get(agentId);
      // No row is not staleness: a restore drops `sessions.json` on purpose
      // (its ids point at runtimes on the other side), and re-deriving rows
      // from the log here would undo exactly that.
      if (!row || row.sessionId === r.to) continue;
      // Rows carry the registry's wall-clock stamp and events the kernel
      // clock's, so the timestamp comparison is a fallback; the abandoned-id
      // check needs no clock at all.
      const stale = r.abandoned.has(row.sessionId) || row.updatedAt < r.at;
      if (!stale) continue;
      await registry.record(agentId, r.to, row.runtime).catch(() => undefined);
      this.auditLine(`session registry: ${agentId} restores onto ${r.to} (its last session.rotated), not the stale ${row.sessionId}`);
    }
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
    // Captured before the raise: `ledger` is the live projection entry, so after
    // the emit it already holds `next`, and the audit line below read
    // "auto-raised 1440000 -> 1440000" for every raise in the 2026-09-25 run.
    const previous = ledger.limit;
    await this.deps.budget.raiseLimit(key, next, {
      // `HUMAN_AGENT_ID` stays as the actor of last resort rather than the agent
      // id: `scheduler.candidatesFor` feeds `event.actorId` in as `excludeActor`,
      // so naming the agent here would silently stop waking it on its own raise.
      // `decidedBy` is what makes the machine decision legible instead.
      actorId: actorId ?? HUMAN_AGENT_ID,
      goalId: this.state.activeGoalId ?? undefined,
      reason: `auto-raise: ${ledger.consumed}/${ledger.limit} exhausted; ceiling ${ceiling} (${cfg.maxMultiple}x ${originalLimit})`,
      decidedBy: "auto",
    });
    this.auditLine(`budget ${key} auto-raised ${previous} -> ${next} (ceiling ${ceiling})`);
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
   *
   * Except on the ledger's LAST rung (`finalRungKey`, the agent ledger): there
   * no raise is coming, so the cap stops being a contract and becomes a hole.
   * Measured 2026-09-25: tech-lead was admitted at 99,706/180,000 on a 32,000
   * hold and spent 735,430 in that one turn; architect spent 1,434,297, 4.8x its
   * declared budget, in one. On the last rung the hold is the seat's real
   * estimate, uncapped, so a turn it cannot afford is refused at the door
   * instead of being discovered at settle.
   */
  private sizedTurnReserve(agentId: string, ceiling = TURN_RESERVE_TOKENS, finalRungKey?: string): number {
    const cap = Math.max(1, Math.floor(ceiling));
    const observed = this.turnCostEstimate.get(agentId);
    // No history: charge the pessimistic bound, exactly as before.
    if (observed === undefined || !Number.isFinite(observed) || observed <= 0) {
      return cap;
    }
    const want = Math.ceil(observed * TURN_COST_SAFETY_FACTOR);
    if (finalRungKey && onFinalBudgetRung(this.state, this.config, finalRungKey)) {
      return Math.max(Math.min(MIN_TURN_RESERVE_TOKENS, cap), want);
    }
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
      // One lookup, shared with the termination verdict. `configuredBudgetLimit`
      // returns null for exactly the keys this sweep used to skip with
      // `else continue` — mission and task ledgers, which are deliberately
      // never auto-raised — so the behaviour is unchanged and the verdict can
      // no longer disagree with the sweep about what a ledger's ceiling is.
      const original = configuredBudgetLimit(this.state, this.config, ledger.key);
      if (original === null) continue;
      // `"system"` rather than the default `HUMAN_AGENT_ID`: this sweep runs off
      // a timer with no agent and no operator behind it, and labelling its work
      // `human` is what made nine machine decisions read as nine interventions.
      // `system` is the established actor for runtime-originated events and, like
      // `human`, registers no interests — so no wake behaviour changes.
      const raised = await this.tryAutoRaise(ledger.key, original, "system");
      // While the latch held, the policy's `budget` rule deferred every wake the
      // seat was sent, and a deferred wake is dropped, not queued. Its mail and
      // its debts are still there, so a seat that has either is woken now rather
      // than left for the next nudge sweep.
      if (!raised || !ledger.key.startsWith(`agent:${goalId}/`)) continue;
      const seat = ledger.key.slice(`agent:${goalId}/`.length);
      const owes = [...this.state.pendingRequests.values()].some((pr) => stillOwes(pr, seat));
      if (!this.turnInFlight.has(seat) && (owes || readableMailDepth(this.state, seat) > 0)) {
        await this.unparkSeat(ledger.key, `your token budget was auto-raised to ${ledger.limit}`);
      }
    }
  }

  /**
   * Carry each seat parked on its own budget to the operator, as that seat's
   * card — never as a goal halt.
   *
   * The termination verdict used to do this by escalating the GOAL, so one
   * seat's ceiling stopped every other seat (NOTES-live-run-20260925 §2). The
   * seat is already parked by the policy's `budget` rule; what it still needs is
   * someone who can raise it, and the card says who is parked, how much it
   * owes, and which key to raise. Keyed `budget:<ledger>` like the door's own
   * card, so the two dedupe into one; `escalate` dedupes on that key while the
   * card is open.
   */
  private async parkExhaustedSeats(): Promise<void> {
    const goalId = this.state.activeGoalId;
    if (!goalId) return;
    for (const seat of budgetParkedSeats(this.state, this.config)) {
      const key = agentKey(goalId, seat);
      const conflictKey = `budget:${key}`;
      if ([...this.state.escalations.values()].some((e) => e.status === "OPEN" && e.conflictKey === conflictKey)) continue;
      const ledger = this.state.budgets.get(key);
      if (!ledger) continue;
      const owedAsks = [...this.state.pendingRequests.values()].filter((pr) => stillOwes(pr, seat)).length;
      await this.escalate({
        reason: "agent_budget_exhausted",
        raisedBy: seat,
        conflictKey,
        participants: [seat],
        detail: {
          key,
          agentId: seat,
          consumed: ledger.consumed,
          limit: ledger.limit,
          parked: true,
          owedAsks,
          unreadMail: readableMailDepth(this.state, seat),
          note: `${seat} is parked: its token budget is spent and nothing will raise it automatically. It takes no turns until you raise ${key}; its mail and the ${owedAsks} ask(s) it owes wait for it. The rest of the mesh keeps working.`,
        },
      });
      this.auditLine(`budget: ${seat} parked on ${key} (${ledger.consumed}/${ledger.limit}) — card to the operator, mission continues`);
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
    const acknowledgingCriteria = this.criteriaReviewHold;
    this.criteriaReviewHold = false;
    await this.deps.kernel.emit("goal.resumed", { goalId: gid, reason: "user resume" }, { actorId: HUMAN_AGENT_ID });
    // A mission held on generated criteria never ran its startup activation, so
    // the agents that need waking are the startup set. `recoveryCandidates()`
    // would find nobody: it returns agents that already hold mail, a task, or a
    // stalled lifecycle, and a seat that was never briefed has none of those.
    if (acknowledgingCriteria && this.liveMode) {
      await this.activateStartup(false);
      return;
    }
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
      // Say who accepts it. "Published and accepted" left the seat that holds the gate to
      // conclude it was the operator's to give: the fourth cronlite run's pm wrote "awaiting
      // operator acceptance testing" about this very criterion and sat on it for 21 minutes.
      const acceptors = this.criterionAcceptors();
      const acceptedBy =
        acceptors.length > 0 ? `by ${acceptors.join(" or ")} (\`approve\` on subject "criterion:${mintedId}", citing that work)` : "by the operator";
      minted.push({
        id: mintedId,
        description: `Operator reopened the mission: "${reason}". This is a mandatory acceptance criterion — the mission cannot complete again until work that specifically addresses it is published and accepted ${acceptedBy}. Re-citing an artifact from the rejected round does not satisfy it.`,
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
    //
    //    Read the criteria BEFORE the emit so the flip can be attributed: a
    //    criterion that was already UNSATISFIED is not news, and announcing it
    //    as newly blocked would make the signal useless.
    const criteriaBefore = new Map(
      (this.state.goals.get(gid)?.acceptanceCriteria ?? []).map((c) => [c.id, c.status] as const),
    );
    await this.deps.kernel.emit(
      "goal.reopened",
      { goalId: gid, reason, criteria: opts.criteria, addCriteria: minted },
      { actorId: by, goalId: gid },
    );

    //    Say WHICH criteria the reopen put back in the way, one event each.
    //
    //    `goal.reopened` is a single goal-level fact; the criteria it withdraws
    //    are the part a seat can act on, and until this nothing emitted
    //    `requirement.blocked` anywhere in the runtime. It was a declared,
    //    schema'd, alert-severity event that five shipped configs subscribe to
    //    and `roles/pm.md` instructs a seat to "never ignore" — a subscription
    //    that could not fire, which reads to a config author as a mechanism
    //    that exists. Reopen is the one place the runtime genuinely knows a
    //    criterion has regressed, and the reducer for this event is idempotent
    //    on a criterion already UNSATISFIED, so this announces the change
    //    without re-applying it.
    const goalAfterReopen = this.state.goals.get(gid);
    for (const c of goalAfterReopen?.acceptanceCriteria ?? []) {
      if (c.status !== "UNSATISFIED") continue;
      // Only a criterion that EXISTED and was not already unsatisfied. A
      // criterion minted from the reopen reason is new work, not work put back
      // in the way, and announcing it as newly blocked would fire this on every
      // reopen with a reason.
      if (!criteriaBefore.has(c.id)) continue;
      if (criteriaBefore.get(c.id) === "UNSATISFIED") continue;
      await this.deps.kernel
        .emit(
          "requirement.blocked",
          { criterionId: c.id, reason: `withdrawn by the reopen: ${reason}` },
          { actorId: by, goalId: gid },
        )
        .catch(() => undefined);
    }

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
    // 4b. The supervisor keeps its OWN per-seat penalty counters, and they are
    //     not the scheduler's to clear. A reopen that resets the scheduler's
    //     strikes but leaves `restartAttempts` at its limit produces a seat the
    //     scheduler is willing to run and the supervisor refuses to restart —
    //     which reads as a silently dead agent in a mission the operator just
    //     revived. Every one of these counts failures against a round that is
    //     now over.
    this.restartAttempts.clear();
    this.unreachableStreak.clear();
    this.timeoutRetries.clear();
    // A new episode judges beliefs afresh, so a handover already requested in
    // the previous round should not suppress one in this round.
    this.continuityAsked.clear();

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

  /**
   * The account of a seat's last turn that did not finish, waiting for the next
   * turn that reaches the model.
   *
   * Rendered as its own section of the prompt, outside the tiered bundle. The
   * same note is written to memory, but memory is a capped slot in which an
   * agent-authored note outranks every auto note — measured 2026-09-25, backend's
   * successor got 1 of 6 memory notes and it was a stale handoff, so the only
   * account of the timed-out turn never reached it (NOTES live-run §3). Cleared
   * once a non-handover turn's model call returns: that turn has read it.
   */
  private unfinishedTurnNotes = new Map<string, string>();

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
    if (rec.state.lifecycle === "SUSPENDED" || rec.state.lifecycle === "COMPLETED" || rec.state.lifecycle === "RETIRED") {
      if (process.env.MESH_TURN_DEBUG) console.error(`[dbg] runTurn ${agentId} early-return: lifecycle ${rec.state.lifecycle}`);
      return;
    }
    const goalId = this.state.activeGoalId;
    if (!goalId) {
      if (process.env.MESH_TURN_DEBUG) console.error(`[dbg] runTurn ${agentId} early-return: no goal`);
      return;
    }
    // A new turn is a new burst: whoever this seat woke last time has long
    // since taken that turn, so waking them again buys a real one.
    this.wakesBoughtThisTurn.delete(agentId);
    // Same shape, same reason: a new turn is a new budget. The held list should
    // already be empty -- `flushHeldSends` runs in the `finally` of every turn
    // -- and deleting it here is the belt to that braces, so a hold that ever
    // did survive a turn cannot be charged to the next one's recipients.
    this.sendsThisTurn.delete(agentId);
    this.heldSendsThisTurn.delete(agentId);
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
      phases: { startedAt: Date.parse(turnStartedAt) || this.nowMs() },
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
    // The mirror image, and NOT simply `!turnChangedNothing`: this stays false
    // for a turn that threw, where "did it move the mesh?" was never answered.
    // It clears the watchdog's nudge streak in the `finally` below — a turn
    // that produced work is the proof the mission is not wedged, whoever woke
    // it, so the streak has to break on any real turn rather than only on a
    // watchdog-driven one.
    let turnProducedWork = false;
    // Set when this turn was spent on a handover; holds the reason the seat was
    // ACTUALLY woken for, so the `finally` can give it back.
    let handoverReactivation: ActivationReason | null = null;
    // Set when an INTEREST wake came back `unproductive` (the flag the breaker
    // reads); holds that same reason so the `finally` can put the spent
    // observation back. See the assignment below for why only an interest wake
    // needs this, and why the gate is `unproductive` rather than "produced
    // nothing".
    let noopReactivation: ActivationReason | null = null;
    /**
     * Set on any path where this turn's work does not reach the mesh, so the
     * `finally` can emit one `turn.discarded`.
     *
     * Hoisted rather than emitted in place because the failure paths are three
     * different shapes — a parse that yielded nothing, a reserve that blocked,
     * and a throw — and only the `finally` runs on all of them. `tokens` stays
     * optional: on a throw the figure genuinely is not known, and the released
     * reservation is an EWMA estimate rather than a measurement.
     */
    let turnDiscard:
      | {
          reason:
            | "no_ops"
            | "rotation_handoff"
            | "all_rejected"
            | "timeout"
            | "silence"
            | "budget_blocked"
            | "failed"
            | "interrupted"
            /**
             * A turn the budget watch stopped. Its own reason since 2026-09-27:
             * the stop comes back as the runtime's own abort, so it used to be
             * filed as `silence` (or `failed` when the forced settle fired) and
             * only the free-text `detail` said what had really happened.
             */
            | "budget";
          detail?: string;
          tokens?: number;
          /**
           * The split behind `tokens`, when the stopped call reported one. Not
           * on `turn.discarded` (its payload stays as it was); it rides into the
           * `budget.consumed` the `finally` writes and into the ring's record.
           */
          usage?: TurnUsage & { model?: string };
        }
      | null = null;
    /**
     * The backend's usage figure, once the runtime call returned one. Hoisted
     * because a `KernelRejectedError` can still end the turn AFTER the model
     * answered and before settlement, and that arm has no `output` in scope --
     * it used to release the holds at zero cost for a turn that was measured.
     */
    let measuredTokens: { total: number; input?: number; output?: number; cacheRead?: number; thinking?: number } | undefined;
    /**
     * What this turn has landed on the mesh, by kind, from the events the
     * kernel correlates to it — so work that arrived through either channel
     * counts. Read twice: to lead the end summary with what the turn DID
     * (NOTES live-run §18), and to tell the successor of a turn that did not
     * finish what survived it (§3). Subscribed per turn so the constructor's
     * listener, which only counts, stays as it is.
     */
    const landed: TurnEffectTally = newTurnEffectTally();
    const stopTally = this.deps.kernel.subscribe((event) => {
      if (event.correlationId === turnId) noteTurnEffect(landed, event);
    });
    /** Set when the turn threw: the fact-built note, reused by the `finally`'s memory write. */
    let unfinishedNote: string | undefined;
    try {
      // budget reservation
      // Uncapped on the agent ledger's last rung (see `sizedTurnReserve`); `let`
      // because a raise below can move the ledger onto that rung.
      let agentReserveAmount = this.sizedTurnReserve(agentId, TURN_RESERVE_TOKENS, agentKey(goalId, agentId));
      /**
       * May this turn's holds be granted short?
       *
       * Only when the ask is the pessimistic bound, i.e. the seat has no cost
       * history this mission. A partial grant does not cap a turn -- nothing can
       * truncate a model's spend mid-turn -- so admitting one against a sized
       * ask let a seat at its final limit overspend it by up to a whole turn.
       * With history the ask IS the estimate (1.5x the EWMA, floored at 4k), and
       * headroom below it means the seat cannot afford a typical turn: the
       * reserve refuses, auto-raise gets its chance below, and a ledger that
       * cannot be raised stops the turn at the door.
       *
       * The first turn stays permissive because 32k is a worst case, not an
       * estimate; refusing on it would lock every seat declared below 32k out of
       * its first turn forever. So the bound this buys is: at a limit nothing
       * will raise, `consumed` passes it only by what ONE turn spent beyond a
       * full hold of its own estimate -- or, for a seat's first turn of the
       * mission, beyond the headroom that was left.
       */
      const allowPartial = !((this.turnCostEstimate.get(agentId) ?? 0) > 0);
      const reserve = await this.deps.budget.reserve(
        agentKey(goalId, agentId),
        "tokens",
        agentReserveAmount,
        this.state.agents.get(agentId)?.definition.budget.tokens ?? null,
        { actorId: agentId, allowPartial },
      );
      if (reserve.blocked && (await this.tryAutoRaise(agentKey(goalId, agentId), this.state.agents.get(agentId)?.definition.budget.tokens ?? null, agentId))) {
        // Retry once against the raised ceiling. One retry only: if the raise
        // did not create headroom, the ceiling is the real answer and the
        // block below escalates as before. Re-sized first: a raise that reached
        // the ceiling put the seat on its last rung, where the hold is uncapped.
        agentReserveAmount = this.sizedTurnReserve(agentId, TURN_RESERVE_TOKENS, agentKey(goalId, agentId));
        Object.assign(
          reserve,
          await this.deps.budget.reserve(agentKey(goalId, agentId), "tokens", agentReserveAmount, this.state.budgets.get(agentKey(goalId, agentId))?.limit ?? null, { actorId: agentId, allowPartial }),
        );
      }
      if (reserve.blocked) {
        // BLOCKED is reachable only from a working lifecycle (THINKING, WORKING,
        // WAITING, REVIEWING — `LIFECYCLE_TRANSITIONS`), and a seat refused at
        // the door is usually still IDLE, woken for mail. The kernel rejects
        // IDLE -> BLOCKED, and that throw used to skip everything below: the
        // latch, the card and the recorded outcome. The seat spent nothing but
        // was never parked, walked back to this door on every wake, and the
        // operator was never told. The lifecycle move is cosmetic next to the
        // latch, so it must not be able to cancel it.
        const blockedFrom = this.state.agents.get(agentId)?.state.lifecycle;
        if (blockedFrom && (LIFECYCLE_TRANSITIONS[blockedFrom] ?? []).includes("BLOCKED")) {
          await this.deps.kernel
            .emit("agent.state_changed", { agentId, to: "BLOCKED", note: `budget: ${reserve.reason}` }, { actorId: agentId })
            .catch(() => undefined);
        }
        // Nothing raised it, so this seat cannot pay for its next turn: park it
        // like an overdrawn one. A refusal on SHORT headroom sets no latch by
        // itself, so the seat stayed activatable and every wake it was sent
        // walked back to this door; the latch makes the policy's `budget` rule
        // defer them instead, and a raise clears it.
        const agentLedger = this.state.budgets.get(agentKey(goalId, agentId));
        if (agentLedger && agentLedger.limit !== null) {
          await this.deps.budget.latchShort(
            agentKey(goalId, agentId),
            { requested: reserve.requested, headroom: Math.max(0, agentLedger.limit - agentLedger.consumed - agentLedger.reserved) },
            { actorId: agentId, goalId },
          );
        }
        // Stable key: repeats dedupe against the still-open escalation instead
        // of flooding the log (each escalation also mints an artifact). The
        // SEAT's card, keyed like the watchdog's (`parkExhaustedSeats`) so the
        // two are one: `agent_budget_exhausted`, not the mission's
        // `budget_exhausted`, which the dashboard renders as "mission spent".
        await this.escalate({
          reason: "agent_budget_exhausted",
          raisedBy: agentId,
          conflictKey: `budget:${agentKey(goalId, agentId)}`,
          participants: [agentId],
          detail: { key: agentKey(goalId, agentId), agentId, consumed: agentLedger?.consumed, limit: agentLedger?.limit, requested: reserve.requested, parked: true, reason: reserve.reason },
        });
        this.finishTurn(turnId, agentId, { status: "blocked", error: reserve.reason });
        this.deps.scheduler.noteTurnOutcome?.(agentId, "blocked");
        // No tokens: this turn never reached the model, so unlike the other
        // reasons nothing was spent. Recorded anyway — a seat that keeps being
        // turned away at the door is a wake the mesh is paying to schedule and
        // then wasting, and that is worth seeing next to the costly kinds.
        turnDiscard = { reason: "budget_blocked", detail: reserve.reason?.slice(0, 200) };
        return;
      }
      if (reserve.reservationId) openReservations.push({ key: agentKey(goalId, agentId), reservationId: reserve.reservationId });
      // A short AGENT hold said nothing until now. `granted < requested` was read
      // for the thread ledger only, where it both tightens the context tier and
      // writes an audit line — so a turn admitted on a fraction of the hold it
      // asked for ran at full width with no record that its ledger was nearly
      // empty. Only a first turn can get here now (see `allowPartial`), and the
      // point is that its permissiveness is not silent.
      if (reserve.granted < reserve.requested) {
        this.auditLine(
          `turn ${turnId} for ${agentId}: agent hold short — asked ${reserve.requested}, granted ${reserve.granted} against ${agentKey(goalId, agentId)}; the turn is not capped to it`,
        );
      }
      /**
       * The mission ledger is held against like every other ledger.
       *
       * It used to be billed only after the fact, so admission never consulted
       * it: two seats with roomy ledgers each took a turn the mission could pay
       * for once, both ran, and the cap was discovered by `TerminationManager`
       * reading `consumed > limit` after it had been crossed. Holding here makes
       * a turn in the model a commitment against the mission that the next
       * admission can see, and refuses a turn the mission cannot afford before
       * it spends anything. Same sizing and same partial-grant rule as the
       * agent hold; never auto-raised, because the mission cap is the
       * operator's number.
       */
      const mKey = missionKey(goalId);
      const mReserve = await this.deps.budget.reserve(mKey, "tokens", agentReserveAmount, this.config.budgets.mission.tokens ?? null, {
        actorId: agentId,
        allowPartial,
      });
      if (mReserve.blocked) {
        // Refused while other turns hold the rest: the mission is busy, not
        // spent. Their holds come back when they settle, so this is a deferral
        // (the breaker's `blocked` strike bounds a re-wake loop), not a card.
        const heldByOthers = (this.state.budgets.get(mKey)?.reserved ?? 0) > 0;
        if (!heldByOthers) {
          await this.escalate({ reason: "budget_exhausted", raisedBy: agentId, conflictKey: `budget:${mKey}`, detail: { key: mKey, reason: mReserve.reason } });
        }
        this.finishTurn(turnId, agentId, { status: "blocked", error: mReserve.reason });
        this.deps.scheduler.noteTurnOutcome?.(agentId, "blocked");
        turnDiscard = { reason: "budget_blocked", detail: mReserve.reason?.slice(0, 200) };
        return; // `finally` releases the agent hold taken above.
      }
      if (mReserve.reservationId) openReservations.push({ key: mKey, reservationId: mReserve.reservationId });
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
      /** Hoisted so the post-assembly top-up can charge the thread ledger too. */
      let threadLedgerKey: string | undefined;
      /**
       * Context trimming for this turn. `undefined` === full context, which is
       * the only value on the normal path, so an unpressured turn builds a
       * byte-identical bundle to before.
       */
      let contextLimits: ContextLimits | undefined;
      if (reason.threadId) {
        const tk = threadKey(goalId, reason.threadId);
        threadLedgerKey = tk;
        const threadReserveAmount = this.sizedTurnReserve(agentId, this.config.budgets.threadReserveTokens);
        // Partial grants stay on for threads: a short thread hold is answered
        // by shrinking the turn's context (below), which is the design here.
        let tReserve = await this.deps.budget.reserve(tk, "tokens", threadReserveAmount, this.config.budgets.threadTokens, { actorId: agentId, allowPartial: true });
        if (tReserve.blocked && (await this.tryAutoRaise(tk, this.config.budgets.threadTokens, agentId))) {
          tReserve = await this.deps.budget.reserve(tk, "tokens", threadReserveAmount, this.state.budgets.get(tk)?.limit ?? null, { actorId: agentId, allowPartial: true });
        }
        if (tReserve.blocked) {
          // Zero headroom. This is the ONLY thread-budget outcome that refuses
          // the turn: there is nothing left to spend, so no amount of trimming
          // makes the turn affordable.
          await this.escalate({ reason: "thread_budget_exhausted", raisedBy: agentId, conflictKey: `budget:${tk}`, detail: { threadId: reason.threadId } });
          this.finishTurn(turnId, agentId, { status: "blocked", error: `thread budget exhausted: ${reason.threadId}` });
          this.deps.scheduler.noteTurnOutcome?.(agentId, "blocked");
          turnDiscard = { reason: "budget_blocked", detail: `thread budget exhausted: ${reason.threadId}` };
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
          contextLimits = shortfall ? CONTEXT_LIMITS_TIGHT : CONTEXT_LIMITS_REDUCED;
          this.auditLine(
            `thread ${tk} under budget pressure (consumed ${tLedger?.consumed ?? 0}/${tLedger?.limit ?? "∞"}, held ${tReserve.granted}/${tReserve.requested}) — degrading ${agentId}'s context instead of blocking`,
          );
        }
      }

      // A failed agent can still be woken deliberately. The human at the
      // escalation seat answering "retry" is an override, not the automatic
      // recovery loop — `restartable: false` stops the mesh retrying on its
      // own, it does not overrule an operator. Reset FAILED -> STARTING the
      // same way the recovery manager does (projections-agent handles the
      // transition on `agent.restarted`), which lets the STARTING branch
      // below carry it on to IDLE and makes the awakening legal.
      //
      // Without this the reducer throws `illegal lifecycle transition
      // FAILED -> AWAKENED`, the turn dies in milliseconds having written
      // nothing, and the watchdog re-raises the very escalation being
      // answered — a loop the operator cannot break from the dashboard.
      if (rec.state.lifecycle === "FAILED") {
        await this.deps.kernel.emit(
          "agent.restarted",
          { agentId, attempt: (this.restartAttempts.get(agentId) ?? 0) + 1 },
          { actorId: HUMAN_AGENT_ID },
        );
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
      const handover = await this.openHandover(agentId, session, turnId, activationEvt.id);
      if (handover) handoverReactivation = reason;
      // A worktree is a separate checkout, and a merge does not move it. Brought up to the
      // product branch here, while nothing of this seat is running in it, or told why not.
      const worktreeNote = handover ? undefined : await this.syncSeatWorktree(agentId);
      // build context from undelivered mail; the drain is emitted after the
      // model has actually read it (see the delivery loop below the runtime call)
      const taskHint = rec.state.activeTaskId ? this.state.tasks.get(rec.state.activeTaskId) : undefined;
      // The message that woke this seat, seated ahead of the mail window. The
      // activation reason has carried this id all along and the builder was never
      // given it, so a degraded tier could drop the very message being answered.
      const triggerMessageId = reason.messageId;
      const rawBundle = buildAgentContext(
        { config: this.config, kernel: this.deps.kernel },
        agentId,
        taskHint,
        contextLimits,
        triggerMessageId,
      );
      // Outside the bundle on purpose, so no tier can drop it: see
      // `unfinishedTurnNotes`. A handover turn sees it too — its continuity is
      // the successor's only other account of the stop.
      const unfinished = this.unfinishedTurnNotes.get(agentId);
      // The turn clock and how to work inside it, for a seat that writes files.
      // Also outside the bundle: it is the rule the ⏱ advisories refer back to,
      // so a degraded tier must not be the one that loses it. Not on a handover,
      // which may only write its continuity record.
      const turnBudget =
        !handover && EDIT_CAPABILITIES.some((token) => (this.config.agents[agentId]?.capabilities ?? []).includes(token))
          ? turnBudgetGuidance({ baseMs: this.config.scheduling.turnTimeoutMs, canCommit: this.canCommit(agentId) })
          : undefined;
      const renderTurn = (b: AgentContextBundle): string =>
        // A handover is not shown the mail it may not answer (§6).
        renderContextInstructions(handover ? handoverBundle(b) : b) +
        (unfinished ? `\n\n## Your previous turn did not finish\n${unfinished}` : "") +
        (worktreeNote ? `\n\n## Your worktree\n${worktreeNote}` : "") +
        (turnBudget ? `\n\n## Turn budget\n${turnBudget}` : "") +
        `\n\n## Why you were woken\n${handover ? HANDOVER_INSTRUCTION(handover, b.unreadMail.length) : describeReason(reason)}\n\nEmit your reply as mesh operations.`;
      // Item caps bound how MANY things go in, never how big they are. When the
      // assembled result still lands over budget, shrink the bundle and
      // re-render — never slice the string (see the constant's comment). A rung
      // that fits is then filled back up to the cap, owed requests first.
      const fitted = fitToSoftCap({
        value: rawBundle,
        render: renderTurn,
        startTier: contextLimits,
        rebuild: (tier) =>
          buildAgentContext({ config: this.config, kernel: this.deps.kernel }, agentId, taskHint, tier, triggerMessageId),
        fill: true,
      });
      const bundle = fitted.value;
      const instructions = fitted.rendered;
      if (fitted.tier !== contextLimits || !fitted.landed) {
        contextLimits = fitted.tier;
        this.auditLine(
          fitted.landed
            ? `${agentId} instructions ~${fitted.before} tokens over soft cap ${INSTRUCTIONS_SOFT_CAP_TOKENS} — rebuilt ${tierName(fitted.tier)}${fitted.limits !== fitted.tier ? ` filled to ${JSON.stringify(fitted.limits)}` : ""} (~${fitted.after} tokens)`
            // Nothing left to give. Send it and say so, rather than truncate the
            // string and hand the agent a prompt missing its ops contract.
            : `${agentId} instructions ~${fitted.after} tokens still over soft cap ${INSTRUCTIONS_SOFT_CAP_TOKENS} at tier ${tierName(fitted.tier)} — sending oversized`,
        );
      }

      /**
       * Top up the pre-flight hold to cover the prompt that was actually built.
       *
       * The hold above is taken BEFORE the context exists, sized from this
       * agent's rolling average turn cost — so an agent whose history is cheap
       * can be admitted on a 4k hold and then be handed a 25k prompt. The hold
       * is then not a bound on anything; it is a number that happened to pass.
       * The input side of the turn is the one part whose size is knowable in
       * advance, so once it IS known, make the ledgers reflect it.
       *
       * A blocked top-up does NOT block the turn. The turn already cleared the
       * pre-flight check, the bundle is already at its tightest tier, and
       * killing it here would spend the assembly for nothing. The point of the
       * top-up is that a CONCURRENT turn sees the headroom is gone; settlement
       * still charges the real figure either way.
       */
      const promptTokens = estimateTokens(instructions.length);

      /**
       * Record what this turn was actually given, slot by slot.
       *
       * Emitted here rather than inside the builder because the ladder walk
       * above may have built the bundle several times; only the one that ships
       * is worth a record. `routine` severity — one per turn per awake agent is
       * the noisiest type in the catalog — but it is the only durable answer to
       * "why didn't the agent know X?", which until now could not be asked of a
       * turn reconstructed from the log at all.
       */
      await this.deps.kernel.emit(
        "context.assembled",
        buildContextManifest(bundle, {
          agentId,
          goalId,
          budgetTokens: INSTRUCTIONS_SOFT_CAP_TOKENS,
          usedTokens: promptTokens,
          tier: tierName(fitted.tier),
          overSoftCap: !fitted.landed,
        }),
        { actorId: agentId, causationId: activationEvt.id, correlationId: turnId },
      );

      const topped = await topUpPromptHold(this.deps.budget, {
        agentId,
        promptTokens,
        reserveAmount: agentReserveAmount,
        targets: [
          { key: agentKey(goalId, agentId), limit: this.state.agents.get(agentId)?.definition.budget.tokens ?? null },
          ...(threadLedgerKey ? [{ key: threadLedgerKey, limit: this.config.budgets.threadTokens }] : []),
        ],
      });
      openReservations.push(...topped.reservations);
      for (const s of topped.shortfalls) {
        this.auditLine(
          `${agentId} prompt ~${promptTokens} tokens exceeds its ${agentReserveAmount} hold; ${s.key} could not cover the ${topped.topUp} difference — proceeding, settlement will charge the real cost`,
        );
      }
      // Make "what it's working on" visible while still THINKING: the runtime
      // call below blocks until the full output arrives, so without this the
      // Steps drawer would show a running turn with no content until it ends.
      this.pushTurn({
        turnId,
        agentId,
        reason,
        startedAt: turnStartedAt,
        status: "running",
        instructions: instructions.slice(0, MAX_TRACE_INSTRUCTIONS_CHARS),
      });
      this.markTurn(turnId, "contextAt");

      await this.deps.kernel.emit(
        "agent.state_changed",
        { agentId, to: "THINKING", turnId },
        { actorId: agentId, causationId: activationEvt.id, correlationId: turnId },
      );
      // Name of each tool call this turn has announced, by id: a completion
      // frame carries only the id, and the verification gate needs to know
      // which tool it closed.
      const liveToolNames = new Map<string, string>();
      // The seat's workspace as its session was started in, so the files a turn
      // writes are listed relative to it (the Write tool reports absolute paths).
      const filesRoot = this.seatWorkspaceRoots.get(agentId);
      const input: AgentInput = {
        agentId,
        goalId,
        activation: reason,
        context: bundle,
        instructions,
        // The whole point of a handover turn: it must run on the transcript it
        // is describing. See `AgentInput.suppressRotation`.
        suppressRotation: handover !== null,
        // Re-read per turn, not inherited from the session's RuntimeContext:
        // `toolGrants` is the live truth and an operator can change it between
        // turns of a session that never restarts.
        approvalGranted: [...(this.toolGrants.get(agentId) ?? [])],
        onToken: (delta: string) => {
          // Live tokens are observability only: buffer them for polling
          // clients and forward out-of-band to SSE. Never throws, never
          // touches the event log (no budget/seq impact at token frequency).
          try {
            this.turns.appendText(turnId, delta, this.nowMs());
          } catch {
            /* buffer must never break the turn */
          }
          try {
            this.deps.hooks?.onTurnToken?.(turnId, agentId, delta);
          } catch {
            /* observer must never break the turn */
          }
        },
        onToolEvent: (ev) => {
          // Tool frames are observability only, like tokens: no buffer to
          // append to (the authoritative record is AgentOutput.toolCalls) and
          // no event-log write. But they are the ONLY sign of life an agent
          // that works by writing files ever emits, so they must register as
          // progress — otherwise such a turn is indistinguishable from a dead
          // one to every liveness reader and to the dashboard.
          try {
            // The call id and whether it CLOSED, so the silence watchdog can
            // tell a turn waiting on a long tool from a turn whose stream froze.
            // A `tool_call` opens, a `tool_call_update` closes. The name and
            // arguments (or the outcome) feed the live account of the turn —
            // `liveTools`, `filesTouched` — which a killed turn keeps.
            const id = "toolCallId" in ev ? String(ev.toolCallId) : undefined;
            this.turns.noteToolFrame(
              turnId,
              ev.kind === "tool_call_update"
                ? { id, closed: true, status: ev.status, ...(ev.error !== undefined ? { error: ev.error } : {}) }
                : { id, closed: false, name: ev.name, args: ev.args, ...(filesRoot ? { root: filesRoot } : {}) },
              this.nowMs(),
            );
            this.recentTurns = this.turns.list(RECENT_TURNS_MAX);
          } catch {
            /* a missing activity mark must never break the turn */
          }
          try {
            this.noteVerificationFrame(agentId, liveToolNames, ev);
          } catch {
            /* the gate's tally must never break the turn */
          }
          try {
            this.deps.hooks?.onTurnToolEvent?.(turnId, agentId, ev);
          } catch {
            /* observer must never break the turn */
          }
        },
        onUsage: (tokensUsed) => {
          // The turn's cumulative spend, after each model call. Before this was
          // wired, spend was known only at settle: a live turn spent 249,918
          // tokens against a 240k seat budget while the operator watched "— tok"
          // and `interruptOverBudgetTurns` had nothing to compare. Same contract
          // as tokens: never throws, never an event-log write.
          try {
            this.noteLiveUsage(turnId, tokensUsed);
            this.recentTurns = this.turns.list(RECENT_TURNS_MAX);
            // Judged on arrival rather than on the next stall-watch tick (up to
            // 30 s away): a figure past the headroom is already spent.
            this.interruptOverBudgetTurns();
          } catch {
            /* a missing usage figure must never break the turn */
          }
        },
      };

      const turn: TurnState = { turnId, agentId, reason, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [], handover: handover !== null };
      this.liveTurnByAgent.set(agentId, turn);
      // Open the verification tally BEFORE the runtime runs. MCP ops execute
      // during the call, and with no entry `claimIsVerified` reads "no turn in
      // flight, runtime-derived" and passes every claim: measured 2026-09-26,
      // a live `mesh_approve criterion:*` from a turn that had run nothing but
      // mesh tools landed EVIDENCED (tests/core/verification-gate-live.test.ts).
      this.turnVerificationTools.set(agentId, 0);
      this.deps.hooks?.onAgentTurnStart?.(agentId, turnId);
      this.markTurn(turnId, "llmCallAt");
      // Stopped by the operator while the turn was still being prepared: there
      // was no call to interrupt, so do not start one. Checked with no await
      // between it and the call, which registers its forced settle synchronously.
      if (this.operatorStops.has(turnId)) throw new InterruptedTurnError("stopped by the operator before the model was called");
      let output = await this.callRuntimeWithTimeout(agentId, session, input, turnId);
      // A `done` issued through the tools stated the turn's summary already.
      if (turn.declaredSummary) output = { ...output, declaredSummary: turn.declaredSummary };
      // A handover's continuity call was ended under the client when it landed; say it landed.
      if (turn.handover) output = { ...output, toolCalls: settleContinuityCalls(output.toolCalls, turn.results) };
      measuredTokens = output.tokensUsed;
      this.markTurn(turnId, "llmDoneAt");
      // The model has read the account of the turn that did not finish. Kept
      // through a handover, whose successor is the turn that does the work.
      if (!handover && this.unfinishedTurnNotes.get(agentId) === unfinished) this.unfinishedTurnNotes.delete(agentId);
      // The backend answered, so this was not a transport failure: a dead
      // backend from last week must not count toward the next stall.
      this.unreachableStreak.delete(agentId);
      // Same reasoning for slow turns: one completed turn clears the streak, so
      // an agent that is merely occasionally slow never accumulates its way to
      // a terminal failure.
      this.timeoutRetries.delete(agentId);
      // And the provider answered, so its refusals are behind this seat.
      if (!output.error) this.outageRetries.delete(agentId);
      this.auditTurn(turnId, agentId, input, output, turn.results.map((r) => r.op));
      // Recorded BEFORE the error throw: a turn can be held and then fail, and
      // what the seat reached for is exactly what the operator needs to see in
      // that case -- arguably more than in the successful one.
      if (output.heldTools?.length) {
        const held = this.toolRequests.get(agentId) ?? new Set<string>();
        for (const tool of output.heldTools) held.add(tool);
        this.toolRequests.set(agentId, held);
      }
      // The usage rides on the failure: a backend that measured the turn and
      // then reported an error still spent those tokens, and the catch below
      // is where they are billed and stated on the discard.
      if (output.error) throw new RuntimeFailure(output.error, output.tokensUsed);

      /**
       * Drain the mailbox now that a model has actually been handed it, and
       * only for the mail that model was actually shown.
       *
       * The reducer splices the id straight out of `state.unread` on
       * `message.delivered` and nothing ever puts it back, so this emit is the
       * single point where mail stops being owed. It used to run before
       * `callRuntimeWithTimeout`, over the first MAX_DELIVERED_PER_TURN (100)
       * QUEUED ids, which got both halves of that wrong.
       *
       * Wrong in time: a turn that then timed out, lost its backend or crashed
       * had permanently eaten messages no agent had seen — silently, because an
       * empty mailbox is indistinguishable from a read one, and because
       * `notifyTurnFinished` only re-queues while `unread > 0`, which the drain
       * had just made false. The mail did not go unanswered; it ceased to exist.
       *
       * Wrong in extent: the bundle renders at most `maxUnread` of them (12,
       * and as few as 2 once the tier ladder degrades), so a backlog of 100 or
       * fewer had up to 88 messages marked delivered that were never put in
       * front of anyone — while `omitted.unread` told the agent they were still
       * queued until a later turn showed them. Degradation made it worse: the
       * rebuild below re-read an already-drained box and rendered no mail at
       * all, which is precisely when an agent can least afford to lose its asks.
       *
       * Both halves collapse into one rule: delivered means rendered AND
       * answered; everything else stays owed. That can show the same message
       * twice (the runtime answered, the op loop below then threw), which is the
       * right trade — re-reading a message costs a paragraph of context, losing
       * one costs the exchange it belonged to.
       *
       * It cannot spin. `state.unread` only ever holds ids that `message.sent`
       * also put in `state.messages`, nothing deletes from there, and every tier
       * renders at least two, so a non-empty box always renders something and
       * therefore always shrinks. A deep backlog now drains over more turns
       * instead of being discarded in one. The pre-model failures that leave
       * mail queued are each already attempt-counted by `handleAgentFailure`
       * (3 restarts, 5 slow retries) before the seat is SUSPENDED and refused
       * activation.
       *
       * Placed before the op loop rather than at the end of the turn because
       * once the model has read the mail it may have ACTED on it, and
       * re-delivering after a half-applied turn would invite it to act twice.
       *
       * `renderableMail` rather than `bundle.unreadMail` because the page no
       * longer renders every message the window admitted: a sender that
       * restated itself inside one thread renders once, and the restatements it
       * made stale are withheld and counted in that thread instead. The whole
       * point of draining here rather than before the model call is that
       * "delivered" means a model was handed it, so the drain has to ask what
       * was handed over -- not what was selected. Asking `bundle.unreadMail`
       * directly would mark the withheld restatements delivered without anyone
       * having read them, which is the silent loss this block exists to
       * prevent, reintroduced one layer up.
       *
       * The helper is shared with the renderer rather than reimplemented here,
       * so the two cannot drift apart.
       */
      // A handover rendered no mail (`handoverBundle`), so it delivered none:
      // draining here marked 44 of one run's 82 deliveries inside turns
      // forbidden to answer, and the successor woke for mail it no longer had.
      const delivered = turn.handover ? [] : renderableMail(bundle.unreadMail).shown.slice(0, MAX_DELIVERED_PER_TURN);
      for (const msg of delivered) {
        await this.deps.kernel.emit(
          "message.delivered",
          { agentId, messageId: msg.id, turnId },
          { actorId: agentId, causationId: activationEvt.id, correlationId: turnId },
        );
      }

      // Record BEFORE the op loop: the ops below are where an agent accepts a
      // criterion, and `markCriterionEvidence` has to know whether this turn
      // actually checked anything or is just asserting it did. This is the
      // STRUCTURAL channel's count (stub, http: ops returned, run after the
      // call, so the whole turn's calls precede them). Ops that already ran
      // live over MCP were judged against the running tally instead.
      this.turnVerificationTools.set(agentId, verificationToolCount(output.toolCalls));

      // Ops a runtime returned structurally (stub, http). A Claude seat returns
      // none: its ops already ran through `executeToolOp` during the call and
      // sit in `turn.results`, which this loop appends to.
      for (const op of output.operations) {
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
        const opStart = this.nowMs();
        const result = await this.executeOp(agentId, op, turn);
        try {
          this.turns.noteOp(turnId, { op: String(op.op), ms: this.nowMs() - opStart, ok: result.ok, reason: result.reason });
        } catch {
          /* timing is observability: never let it affect the op */
        }
        if (process.env.MESH_OP_DEBUG) console.error(`[op] ${agentId} ${op.op} -> ${result.ok}${result.reason ? " " + result.reason : ""}${result.messageId ? " msg:" + result.messageId : ""}${result.artifactId ? " art:" + result.artifactId : ""}`);
        turn.results.push(result);
        // A gate rejection means the agent skipped planning. The ops that
        // follow were written on that same assumption, so running them just
        // produces a cascade of rejections against a plan that still does not
        // exist. Stop here and let the agent plan on its next turn.
        if (!result.ok && result.reason?.startsWith(PLAN_GATE_PREFIX)) {
          this.auditLine(`turn ${turnId} for ${agentId} stopped early: ${result.reason}`);
          break;
        }
      }
      this.markTurn(turnId, "opsDoneAt");
      if (turn.declaredSummary && turn.declaredSummary !== output.declaredSummary) output = { ...output, declaredSummary: turn.declaredSummary };

      // `total` plus cache reads at `budgets.cache_read_weight` (0 by default, so
      // byte-for-byte the old figure unless a mesh opts in). See `billedTurnTokens`.
      const bill = billedTurnTokens(output.tokensUsed, this.config.budgets?.cacheReadWeight);
      const tokens = bill.billed;
      // Feed the real cost back into the sizing heuristic BEFORE the next turn
      // asks for a hold; this is the only place a turn's true cost is known.
      this.noteTurnCost(agentId, tokens);
      await this.deps.budget.consume(agentKey(goalId, agentId), "tokens", tokens, reserve.reservationId, {
        model: output.model,
        modelVersion: output.modelVersion,
        temperature: output.temperature,
        input: output.tokensUsed?.input,
        output: output.tokensUsed?.output,
        // The replayed transcript on a persistent session: billed only at
        // `cache_read_weight` (`cacheReadBilled`), recorded always. The ratio is
        // the turn's cache luck — reads over the whole prompt — so an operator
        // can tell an expensive turn from one that missed the cache (measured
        // 2026-09-25: five cache-miss turns were 64% of all fresh input).
        cacheRead: output.tokensUsed?.cacheRead,
        ...(bill.cacheReadRatio !== undefined ? { cacheReadRatio: bill.cacheReadRatio } : {}),
        ...(bill.cacheReadBilled !== undefined ? { cacheReadBilled: bill.cacheReadBilled } : {}),
        // Billed inside `output`, not beside it — this rides along so a replayed
        // mission can say what the output went ON, which is the one question
        // the largest line on the bill could not answer. Undefined when the
        // backend reports no split, and read as unknown, not as none.
        thinking: output.tokensUsed?.thinking,
        toolCalls: output.toolCalls?.length ?? 0,
        turnId,
      }, { actorId: agentId, correlationId: turnId });
      await this.deps.budget.consume(mKey, "tokens", tokens, mReserve.reservationId || undefined, { agentId, turnId }, { actorId: agentId, correlationId: turnId });
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
      const modelSummary = declaredTurnSummary(output)?.slice(0, 500);
      let endSummary = modelSummary;
      /**
       * The same remarks `endSummary` is assembled from, one per entry and
       * without the model's words mixed in, for the turn record. `endSummary`
       * stays the seat's single string — it is its next context — and must not
       * change shape; this is the copy a reader can iterate instead of splitting
       * that string on " — ", which the model's own text may contain.
       */
      const notices: string[] = [];
      /**
       * Did this turn move the mesh at all? A turn that parsed no ops, or
       * whose every op was rejected, spent real tokens and changed nothing.
       * Repeating it changes nothing again — that is the pure waste loop.
       */
      let unproductive = false;
      // Ops from BOTH channels: `turn.results` holds the tool calls that ran
      // during the runtime call as well as the ops the runtime returned.
      const noOps = turn.results.length === 0 && output.operations.length === 0;
      if (noOps && (this.turnEffects.get(turnId) ?? 0) > 0) {
        // No op ran, yet mesh effects landed under this turn's correlation
        // (work that reached the log without passing through `executeOp`).
        // Judging such a turn by its ops alone once called the most productive
        // turns of a live run empty — three artifacts published, five threads
        // opened and four messages sent, logged as "nothing was sent,
        // published, or requested", then a strike.
        //
        // So: say the contract was missed, because closing without `done`
        // leaves no statement of why the turn stopped. Do NOT call it
        // unproductive and do NOT discard it — the effects are already durable
        // on the log, and scoring them as nothing is what fed the strike loop
        // that cost one seat 537,479 tokens.
        const effects = this.turnEffects.get(turnId) ?? 0;
        const notice = `${effects} mesh effect${effects === 1 ? "" : "s"} landed this turn, so the work stands; close with \`mesh_done\` so the turn records why it stopped`;
        notices.push(notice);
        endSummary = `${notice}${modelSummary ? ` (model said: ${modelSummary})` : ""}`;
        this.auditLine(`turn ${turnId} for ${agentId} ran 0 ops but landed ${effects} effect(s)`);
      } else if (noOps) {
        // A zero-op handover is the instructed shape landing slightly wrong, not
        // wasted discretion — the comment on `turnDiscard` below says so, and the
        // `reason` it assigns has said so since it was split out. What had not
        // followed was the two other consequences: the seat was still handed the
        // alarming "nothing was sent, published, or requested", and it was still
        // charged a strike. Measured 2026-09-25: three handovers were told one of
        // three different things depending only on whether the ops block held
        // `write_continuity`, `done`, or nothing — none of which is the seat's
        // fault, and all three of which did the one thing `HANDOVER_INSTRUCTION`
        // asks for.
        const notice = turn.handover
          ? `continuity written for the session handover — this turn is not scored as work`
          : `⚠ no mesh tool calls this turn — nothing was sent, published, or requested`;
        notices.push(notice);
        endSummary = turn.handover ? notice : `${notice}${modelSummary ? ` (model said: ${modelSummary})` : ""}`;
        this.auditLine(
          turn.handover
            ? `turn ${turnId} for ${agentId} was a rotation handover with no ops — not scored as work`
            : `turn ${turnId} for ${agentId} ran 0 ops`,
        );
        unproductive = !turn.handover;
        // The costliest of the discard reasons and the one with no signature at
        // all before this: the seat wrote a verdict or published an artifact, the
        // ops block failed to parse, and the only trace was an audit line plus a
        // note in the seat's own memory. Tokens are known here, so state them.
        // A handover turn that parsed no ops is NOT the same loss as a seat that
        // answered in prose when it had work to do. The runtime asked this seat
        // for exactly `write_continuity` then `done` and refuses anything else
        // (see `HANDOVER_ALLOW_OPS`), so a zero-op handover is the instructed
        // shape landing slightly wrong, not wasted discretion.
        //
        // Given its own reason because `reason` is what every consumer groups by.
        // With both collapsed into `no_ops`, all 11 discards of one measured run
        // were handovers and read as waste, and the only thing distinguishing
        // them was `detail` — which is the MODEL's prose, not a runtime label, so
        // it classifies nothing. Two readings of that run were wrong before this.
        turnDiscard = {
          reason: turn.handover ? "rotation_handoff" : "no_ops",
          detail: modelSummary ? modelSummary.slice(0, 200) : undefined,
          tokens: output.tokensUsed?.total,
        };
      } else if (rejected.length === turn.results.length && turn.results.length > 0) {
        unproductive = true;
        const why = rejected
          .map((r) => `${r.op}: ${r.reason ?? "rejected"}`)
          .join("; ")
          .slice(0, 300);
        const notice = `⚠ all ${rejected.length} ops rejected (${why})`;
        notices.push(notice);
        endSummary = `${notice}${modelSummary ? ` — model said: ${modelSummary}` : ""}`;
        this.auditLine(`turn ${turnId} for ${agentId}: all ${rejected.length} ops rejected: ${why}`);
        // This arm used to be the one unproductive outcome that left NO
        // `turn.discarded` behind. A turn whose every op was refused spent full
        // tokens and moved nothing — the same loss `no_ops` records — but from
        // the event stream it was indistinguishable from a productive turn, so
        // any measure of wasted spend silently undercounted it.
        turnDiscard = { reason: "all_rejected", detail: why.slice(0, 200), tokens: output.tokensUsed?.total };
      } else if (
        // Planning is not doing. A plan is bookkeeping about future work, so a
        // turn that only planned spent full tokens and moved nothing — exactly
        // the shape `unproductive` exists to catch.
        //
        // This must NOT join the wait/done/remember arm below: that arm reports
        // "ok" to the scheduler, which DELETES the agent's strikes. An agent
        // stuck re-planning would reset the breaker on every turn and loop for
        // the whole mission budget. One planning turn is free (the next real
        // turn clears the strike); three in a row parks the agent, which is the
        // right answer for an agent that cannot get past its own checklist.
        turn.results.length > 0 &&
        turn.results.some((r) => r.op === "plan" || r.op === "plan_step") &&
        turn.results.every((r) => r.op === "plan" || r.op === "plan_step" || r.op === "wait" || r.op === "remember")
      ) {
        unproductive = true;
        const notice = `⚠ turn only recorded a plan — the checklist is saved, now CARRY OUT its steps in your next turn; planning again changes nothing`;
        notices.push(notice);
        endSummary = `${notice}${modelSummary ? ` (model said: ${modelSummary})` : ""}`;
        this.auditLine(`turn ${turnId} for ${agentId} only planned (${turn.results.map((r) => r.op).join(",")})`);
      } else if (
        // wait/done/remember are not work. A driver woken with nothing to act
        // on answers with one of these, the mesh ends empty, and the stall
        // watchdog then waits the full idle + cooldown for nothing. This arms
        // the fast retry (NOT the breaker) so the NEXT driver gets tried soon.
        //
        // The effects test is the same one the arm above applies, and it belongs
        // here for the same reason: work that reached the log through the mesh
        // tools is work whether or not the ops block names it. Without it,
        // measured 2026-09-25, every turn that closed with `wait` was reported as
        // producing nothing — architect published 8 artifacts with 8 review
        // requests and 12 messages (186,250 tokens), frontend a CodePatch v1→v2
        // with `patch.ready` (350,431), ux-designer 3 flow specs plus 3 review
        // requests (152,727). 14 of that run's 36 turns carried a false "no work"
        // sentence, and `turnProducedWork = false` told the stall accounting its
        // most productive minutes were empty. The control is decisive: a turn
        // that closed with `send+wait` escaped the verdict only because `send`
        // falls outside this set — the flag turned on how a seat phrased its
        // last op.
        turn.results.length > 0 &&
        turn.results.every((r) => r.op === "wait" || r.op === "done" || r.op === "remember") &&
        this.state.goals.get(goalId)?.status === "ACTIVE" &&
        (this.turnEffects.get(turnId) ?? 0) === 0
      ) {
        turnChangedNothing = true;
        // A handover is the shape the runtime ASKED for (`HANDOVER_INSTRUCTION`:
        // write continuity, then done), and `openHandover` re-arms the activation
        // it consumed, so the seat did what it was told. It still counts as
        // "changed nothing" — the mission did not advance and the re-armed
        // activation deserves the fast retry — but it must not be told it
        // produced nothing. The mechanics stay; only the sentence changes.
        endSummary = turn.handover
          ? `continuity written for the session handover — this turn is not scored as work, and the activation it consumed has been re-armed`
          : `⚠ turn only ${[...new Set(turn.results.map((r) => r.op))].join("/")} — no work was produced while the mission has unmet criteria; the watchdog will rotate to another driver`;
        // The whole sentence is the mesh's: this arm drops the model's words.
        notices.push(endSummary);
        this.auditLine(
          turn.handover
            ? `turn ${turnId} for ${agentId} was a rotation handover (${turn.results.map((r) => r.op).join(",")}) — not scored as work, activation re-armed`
            : `turn ${turnId} for ${agentId} produced no work (${turn.results.map((r) => r.op).join(",")})`,
        );
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
        const notice = `⚠ ${rejected.length} of ${turn.results.length} ops were REJECTED and had no effect — fix these before repeating them (${why})`;
        notices.push(notice);
        endSummary = `${notice}${modelSummary ? ` — model said: ${modelSummary}` : ""}`;
        this.auditLine(`turn ${turnId} for ${agentId}: ${rejected.length}/${turn.results.length} ops rejected: ${why}`);
      }
      // An op can SUCCEED and still not do what the agent thinks it did — the
      // verification gate is the case that matters: `approve criterion:x`
      // returns ok, but the criterion landed ASSERTED and the mission is no
      // closer to done. Without this warning the agent reads a clean turn,
      // concludes the criterion is closed, and never revisits it. Appended
      // rather than branched, so it survives alongside a rejection warning.
      //
      // A refused wake belongs here for the same reason and with the same
      // shape: the send returned ok and the mail landed, so every other signal
      // in this turn says it worked, and the only thing that did not happen is
      // the one thing the seat asked for. Left unsaid, a seat reads the
      // missing wake as a delivery that failed and sends the same message
      // again — paying the same price it could not pay the first time.
      //
      // A READ is not a caveat. `read_artifact` answers with the document in
      // `reason` (up to ARTIFACT_READ_MAX_CHARS), so taking every accepted
      // reason put "⚠ read_artifact: # <the artifact>" into the seat's next
      // context — a warning sign on a read that worked, carrying a copy of what
      // the seat had just read — and the same body into the turn trace.
      //
      // Nor is any other reason that is the op's DATA: a decision or lease id, a
      // sha, "merged as …", a worker id, or the seat's own words echoed back by
      // discharge/withdraw (`DATA_RESULT_OPS`, the same split mcp.ts makes for
      // the tool result). An op that flags its reason `caveat: true` is a caveat
      // whatever its op; an unflagged reason on any other op stays one, because
      // most real caveats are not flagged yet.
      const caveatLines = turn.results.flatMap((r) => {
        if (!r.ok) return [];
        const lines: string[] = [];
        const flagged = (r as { caveat?: boolean }).caveat === true;
        if (r.reason && (flagged || !DATA_RESULT_OPS.has(r.op))) lines.push(`${r.op}: ${r.reason}`);
        if (r.deliveryDowngraded) {
          lines.push(
            `${r.op}: SENT, but it did not wake anyone (${r.deliveryDowngraded}). The message is delivered and sits in the recipient's mailbox — they will see it on their next turn. Do not send it again; escalate to the operator if it truly cannot wait.`,
          );
        }
        return lines;
      });
      const caveats = caveatLines.join("; ").slice(0, 400);
      if (caveats) {
        endSummary = `${endSummary ? `${endSummary} — ` : ""}⚠ ${caveats}`;
        this.auditLine(`turn ${turnId} for ${agentId}: accepted with caveats: ${caveats}`);
        // One notice per caveat, each under the same 400 cap the joined list
        // gets, so a caveat the summary's cap cut off is still listed here. The
        // count is bounded too: this rides every /steps response, and a turn
        // can make as many tool calls as it likes.
        const shown = caveatLines.slice(0, MAX_CAVEAT_NOTICES);
        notices.push(...shown.map((line) => `⚠ ${line}`.slice(0, 400)));
        const unlisted = caveatLines.length - shown.length;
        if (unlisted > 0) notices.push(`⚠ +${unlisted} more caveat${unlisted === 1 ? "" : "s"}`);
      }
      // A call the CLIENT refused never reached the mesh, so no op result records it and none
      // of the remarks above can mention it. The seat read "No such tool available" in its tool
      // result, went on to `mesh_wait`, and its next context says it did what it meant to: the
      // fourth cronlite run's pm tried `mesh_request_review`, then waited for a review nobody
      // had been asked for. Across three runs seats made 8, 14 and 14 such calls, every one
      // a turn's worth of intent that vanished, and this is the only place it can be said.
      //
      // Not `unproductive`: the breaker parks a seat that keeps failing, and a seat that keeps
      // reaching for a tool it was told about is being failed by its briefing first.
      const refused = refusedToolCalls(output.toolCalls);
      if (refused.length > 0) {
        const what = refused.map(({ tool, times }) => `${tool}${times > 1 ? ` x${times}` : ""} (${toolAlternative(tool)})`).join("; ");
        const notice = `⚠ not in your tool list, so these calls never reached the mesh and did nothing: ${what}. Your tool list is authoritative — do what they were for with a tool you have`.slice(0, 500);
        endSummary = `${endSummary ? `${endSummary} — ` : ""}${notice}`;
        notices.push(notice);
        this.auditLine(`turn ${turnId} for ${agentId}: called ${refused.length} tool(s) its manifest does not carry: ${refused.map((r) => `${r.tool} x${r.times}`).join(", ")}`);
      }
      // Files written but never committed are in no repository, invisible to
      // every reviewer, and archived rather than landed by the next reset. The
      // runtime could see this all along -- `fileStates` ran exactly the right
      // git command -- and never called it, so nothing told the seat. One run on
      // 2026-09-24 ended with 1,847 lines across three source modules and six
      // test files sitting untracked while the product branch held its scaffold
      // commit, and the mission recorded the patch as MERGED.
      //
      // Appended to `endSummary`, which rides into `memory.updated` and is the
      // seat's own next context, rather than raising a new event type: this is
      // advice to one seat about one turn, which is exactly what that channel is.
      //
      // Deliberately does NOT set `unproductive`. That feeds the circuit breaker,
      // and uncommitted work is work -- parking the seat that is actually writing
      // code is the opposite of the fix.
      const uncommitted = await this.uncommittedWorkAdvisory(agentId, turn);
      if (uncommitted) {
        endSummary = `${endSummary ? `${endSummary} — ` : ""}${uncommitted}`;
        notices.push(uncommitted);
        this.auditLine(`turn ${turnId} for ${agentId}: ${uncommitted}`);
      }
      // Lead with what the turn DID, counted by the runtime from the events it
      // correlated to this turn. Measured 2026-09-25 (NOTES live-run §18): the
      // one turn that committed 4,082 lines and 80 tests read "Turn complete.
      // What happened: — ⚠ read_artifact: … ⚠ 3 files NOT committed" — every
      // word about it a caveat, none about what landed. Prepended rather than
      // appended so it is first however many remarks follow, and in the seat's
      // memory too: what it landed is the fact it most needs next turn.
      // A handover lands only its continuity, which the arms above already say.
      const effects = turn.handover ? undefined : summarizeTurnEffects(landed);
      if (effects) {
        const effectsLine = `landed this turn: ${effects}`;
        endSummary = endSummary ? `${effectsLine} — ${endSummary}` : effectsLine;
        notices.unshift(effectsLine);
      }
      turnChangedNothing = turnChangedNothing || unproductive;
      turnProducedWork = !turnChangedNothing;
      // F1: an INTEREST wake that produced nothing is spent, and no debt keeps
      // the seat answerable for the observation it was given.
      //
      // The other wake kinds are already covered: a `message` wake opens a
      // commitment, so `stillOwes` pins the seat in WAITING and the nudge and
      // escalation chain chases the answer; a `recovery` wake re-runs by design.
      // An interest wake opens nothing — `wakeByInterest` queues one activation
      // per event occurrence, the subscription is to the EVENT rather than to the
      // state it left behind, and nothing re-fires the same `artifact.created`.
      // Measured 2026-09-25: a seat woken by `artifact.created` spent 54,619
      // tokens, produced zero effects and confabulated a completed review, and the
      // observation was gone — the artifact stayed READY_FOR_REVIEW with no review
      // ask and the seat that was supposed to approve it believed it had.
      //
      // Put back the same way a handover's consumed activation is (see
      // `handoverReactivation`), but deliberately NOT `explicit`: parking must
      // still gate it, so the circuit breaker bounds the retries at its usual
      // three and a seat that cannot use the observation gets parked rather than
      // re-run forever.
      // Gated on `unproductive`, NOT on `!turnProducedWork`, and the difference is
      // load-bearing: the wait/done/remember arm sets `turnChangedNothing` without
      // setting `unproductive`, and it is `unproductive` that feeds
      // `noteTurnOutcome` and therefore the breaker. Gating on "produced nothing"
      // re-armed on turns the breaker was told were "ok" — so the strikes were
      // cleared every time and the re-arm looped without bound (measured: a
      // triage test took 889 wake-ups from one event before it was caught).
      // With `unproductive`, three consecutive fruitless turns park the seat and
      // the non-explicit activation below is refused.
      const noopReactivationReason =
        unproductive && !turn.handover && !turn.escalated && reason.kind === "interest_event" ? reason : null;
      noopReactivation = noopReactivationReason;
      // Did the backend run the model this seat asked for?
      //
      // `output.model` is what the CLI REPORTED, which is the honest number — but
      // nothing ever compared it with the configured one, so an environment that
      // remaps an alias (`ANTHROPIC_DEFAULT_SONNET_MODEL`, or a `settings.json`)
      // silently ran every seat on something else and the only trace was a model
      // id inside `budget.consumed`. Measured 2026-09-25: a mesh declaring
      // `model: sonnet` for all 11 seats ran every turn on `deepseek-v4.1-flash`,
      // and the seats' confabulated turns read as a prompt problem for as long as
      // the cause stayed invisible. An unrecognised id also takes the fallback
      // rotation threshold (`rotateAtFor`), so the substitution costs more than
      // the model itself.
      //
      // Once per seat: this is a property of the environment, not of the turn.
      const configuredModel = this.config.agents[agentId]?.model;
      if (
        configuredModel &&
        typeof output.model === "string" &&
        output.model &&
        !modelMatches(configuredModel, output.model) &&
        !this.modelMismatchNoted.has(agentId)
      ) {
        this.modelMismatchNoted.add(agentId);
        const notice = `⚠ model substitution: this seat is configured for '${configuredModel}' but the backend ran '${output.model}'. Every turn is billed and reasoned at the substituted model, and an unrecognised id also takes the fallback rotation threshold. Check ANTHROPIC_* overrides and ~/.claude/settings.json.`;
        notices.push(notice);
        endSummary = `${endSummary ? `${endSummary} — ` : ""}${notice}`;
        this.auditLine(`model substitution for ${agentId}: configured '${configuredModel}', backend ran '${output.model}'`);
      }
      // The runtime billed some calls' reported input as cache reads
      // (runtime-claude `reattributedPrefix`); the record says so, raw beside billed.
      if (output.usageGuard) {
        const g = output.usageGuard;
        notices.push(
          `usage re-attributed: ${g.adjustedCalls} call(s) reported ${g.reattributedTokens} tokens of a just-sent prefix as uncached input; billed as cache_read (raw input ${g.raw.input}, billed ${g.adjusted.input})`,
        );
      }
      this.finishTurn(turnId, agentId, {
        status: target === "IDLE" ? "ok" : target === "WAITING" ? "waiting" : "blocked",
        tokens,
        tokensInput: output.tokensUsed?.input,
        tokensOutput: output.tokensUsed?.output,
        tokensCacheRead: output.tokensUsed?.cacheRead,
        // Optional all the way down on purpose: a backend that does not report
        // the split leaves this undefined, and every reader must keep reading
        // it as unmeasured rather than as a turn that thought for nothing.
        tokensThinking: output.tokensUsed?.thinking,
        model: output.model,
        // Executed ops only (not merely planned): if the mission flipped
        // mid-turn and the loop stopped early, the trace must not claim the
        // skipped ops ran.
        ops: turn.results.map((r) => r.op),
        toolCalls: output.toolCalls?.length ?? 0,
        toolCallsDetail: traceToolCalls(output.toolCalls),
        summary: endSummary,
        // Always written, empty included: `[]` says "this turn drew no remark",
        // which a record that predates the field cannot say.
        notices,
        ...(modelSummary !== undefined ? { modelSummary } : {}),
        text: (output.text ?? "").slice(0, MAX_TRACE_TEXT_CHARS),
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
      // `providerAnswered`: this turn reached the model and got an answer, which
      // is the evidence a half-open provider breaker is waiting for.
      this.deps.scheduler.noteTurnOutcome?.(agentId, unproductive ? "blocked" : "ok", { providerAnswered: true });
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
        this.deps.scheduler.noteTurnOutcome?.(agentId, "ok", measuredTokens !== undefined ? { providerAnswered: true } : undefined);
        // Refused before settlement (holds still open) on a turn the backend
        // measured: the model's work did not reach the mesh, and the tokens it
        // spent are real. Discarding it with the figure is what routes that
        // figure through the `finally`'s billing -- agent AND mission ledger,
        // once -- instead of releasing the holds as if the turn were free. A
        // rejection after settlement leaves `openReservations` empty and is
        // already billed, so it is not a discard and cannot double-count.
        if (openReservations.length > 0 && measuredTokens !== undefined) {
          turnDiscard = {
            reason: "failed",
            detail: `kernel rejected: ${(err as Error).message}`.slice(0, 200),
            tokens: measuredTokens.total,
            // The split rides along so the `finally` bills cache reads by the same
            // rule settlement would have (`billedTurnTokens`).
            ...(measuredTokens.input !== undefined && measuredTokens.output !== undefined
              ? { usage: { ...measuredTokens, input: measuredTokens.input, output: measuredTokens.output } }
              : {}),
          };
        }
      } else {
        // A turn that threw wrote no audit row — `auditTurn` runs before the op
        // loop, past which the throw escapes — and billed nothing, because
        // `consume` is only reached on the success path. So a 20-minute timeout
        // and a two-minute forced settle both cost real provider tokens and were
        // recorded as free.
        //
        // `tokens` is absent unless the adapter measured it. An `InterruptedTurnError`
        // does: the CLI answers a mesh-ordered abort with a `result` frame carrying
        // real `usage`, which the adapter used to discard. Everything else here still
        // reports nothing, because the figure genuinely is not known and the released
        // reservation is an EWMA estimate — billing an estimate poisons the next one.
        //
        // Surfaced AND billed: the `finally` below settles this figure against the
        // same ledgers the success path uses. The double-count risk that kept it
        // unbilled is structurally absent — the success path empties
        // `openReservations` at the end of settlement, so a non-empty list there is
        // exactly the proof that this turn threw before `consume` ran.
        const msg = err instanceof Error ? err.message : String(err);
        const interrupted = err instanceof InterruptedTurnError;
        // Whatever the stopped call reported spending, from the typed error that
        // carried it. `TurnTimeoutError` and `InterruptedTurnError` may also name
        // the model; `RuntimeFailure` (a backend that answered with an error)
        // never does. The Claude adapter's usage object always held `cacheRead`
        // too — only the type hid it, so a timed-out turn's `budget.consumed`
        // went out with no split (NOTES live-run §3, seq 1153).
        const carrier = err instanceof TurnTimeoutError || err instanceof InterruptedTurnError || err instanceof RuntimeFailure ? err : undefined;
        const carriedModel = err instanceof TurnTimeoutError || err instanceof InterruptedTurnError ? err.model : undefined;
        const usage = carrier?.tokensUsed ? { ...carrier.tokensUsed, ...(carriedModel ? { model: carriedModel } : {}) } : undefined;
        // The operator asked for this ending (`interruptTurn`). Whatever the
        // runtime's abort came back as — its own `InterruptedTurnError`, the
        // forced settle's AbortError, a timeout the stop raced — the cause is
        // known, and it is not a failure.
        const operatorStop = this.operatorStops.get(turnId);
        // This process is shutting down and stopped the turn's session under it
        // (`shutdown`). Not a seat failure either: nothing about the seat broke,
        // and a failure recorded here is one the exiting process rarely lives to
        // finish handling — on 2026-09-28 13:42Z it wrote `agent.failed` for
        // three seats and the restart for one, and two booted FAILED.
        const shutdownStop = !operatorStop && this.shutdownStops.has(turnId);
        // The budget watch's own stop, set the moment it ordered the interrupt
        // (`interruptOverBudgetTurns`). Read here and NOT inferred from the
        // detail prose: the seat's note and the discard's reason both come off
        // this classification now, and a turn this watch stopped is not a turn
        // whose stream went quiet.
        const budgetStop = this.budgetStops.get(turnId);
        turnDiscard = {
          // Type before message. An interrupt's own words say nothing about
          // timeouts or silence, so the regex below classified a turn the mesh
          // stopped on purpose as `failed` — indistinguishable from a crashed
          // backend, which is the exact confusion the adapter raises this type to
          // prevent. The turn-timeout site raises its own `TurnTimeoutError`
          // (carrying the interrupt's usage when the abort answered in time), so
          // a timeout is typed and never has to be read out of its message.
          //
          // A budget stop is asked about FIRST, before the abort's type: the
          // abort arrives as `InterruptedTurnError` (which would read `silence`)
          // or as the forced settle's `AbortError` (which would read `failed`),
          // and neither is what happened. Only the label changes here — the
          // error itself, and so the failure ladder `handleAgentFailure` walks,
          // is exactly what it was.
          reason: operatorStop || shutdownStop
            ? "interrupted"
            : budgetStop
              ? "budget"
              : err instanceof TurnTimeoutError
                ? "timeout"
                : interrupted
                  ? "silence"
                  : /timeout/i.test(msg)
                    ? "timeout"
                    : /silence/i.test(msg)
                      ? "silence"
                      : "failed",
          // A budget stop keeps its classification (the abort's type decides the
          // failure ladder) but says what actually stopped it. An operator stop
          // says so, with the operator's reason.
          detail: (operatorStop ? operatorStopDetail(operatorStop) : shutdownStop ? shutdownStopDetail(msg, this.missionOver()) : (budgetStop ?? msg)).slice(0, 200),
          ...(usage ? { tokens: usage.total, usage } : {}),
        };
        // Failure handling first, so the note below states what is true AFTER
        // it: a terminal failure releases the task, the slow-turn path keeps it.
        // Nothing can read the note in between — the retry this schedules cannot
        // start until the `finally` clears `turnInFlight`. The record is still
        // closed if failure handling itself throws, as it was when it ran last.
        //
        // An operator stop skips all of it: no `agent.failed`, no restart and
        // its recovery wake, no crash or slow-turn counter. The seat keeps its
        // task and its mail and goes back to IDLE. A shutdown stop likewise.
        try {
          if (operatorStop) await this.closeOperatorStoppedTurn(agentId, turnId, operatorStop);
          else if (shutdownStop) await this.closeShutdownStoppedTurn(agentId, turnId, turnDiscard.detail ?? msg);
          else await this.handleAgentFailure(agentId, err, reason);
        } finally {
          // Built from facts: what this turn landed (its correlated events) and
          // what it left in its worktree. See `abnormalTurnNote` for the template
          // this replaces and why it was wrong. Parked in `unfinishedTurnNotes`
          // so the next turn is handed it outside the tiered bundle.
          //
          // The facts include the snapshot of a dirty worktree (see
          // `checkpointStoppedTurn`), taken here — after the stop, before the
          // record closes and before the retry can start.
          unfinishedNote = abnormalTurnNote(
            turnDiscard,
            this.nowMs() - (Date.parse(turnStartedAt) || this.nowMs()),
            await this.unfinishedTurnFacts(agentId, landed, { turnId, reason: turnDiscard.reason }),
          );
          this.unfinishedTurnNotes.set(agentId, unfinishedNote);
          // Recorded with the same figures `turn.discarded` carries instead of
          // only the fact of failure. A turn the ring records as costing nothing
          // is a turn every cost view undercounts — and the run's single most
          // expensive turn (302,667 tokens on 2026-09-24) was recorded exactly
          // that way.
          //
          // `ops` and `toolCalls` stay absent on purpose: the `AgentOutput` never
          // returned, and `turn` is scoped inside the `try`. Each usage field is
          // written only when the stopped call reported it: absent means
          // unmeasured, which is the field's convention — an invented zero would
          // read as "this turn was free".
          //
          // An operator stop is recorded `blocked`, not `failed`: the record's
          // status is what the failure digests and the console's "crashed" badge
          // count, and a turn stopped on purpose is neither. There is no status
          // of its own to give it without every reader learning a new value.
          // A shutdown stop is neither too.
          this.finishTurn(turnId, agentId, {
            status: operatorStop || shutdownStop ? "blocked" : "failed",
            error: operatorStop || shutdownStop ? turnDiscard.detail : msg,
            errorDetail: describeError(err, failedIn),
            ...(usage
              ? {
                  tokens: usage.total,
                  tokensInput: usage.input,
                  tokensOutput: usage.output,
                  ...(usage.cacheRead !== undefined ? { tokensCacheRead: usage.cacheRead } : {}),
                  ...(usage.thinking !== undefined ? { tokensThinking: usage.thinking } : {}),
                  ...(usage.model ? { model: usage.model } : {}),
                }
              : {}),
            summary: unfinishedNote,
            // The whole summary is the mesh's note here; the model never
            // answered, so there is no `modelSummary` to keep beside it.
            notices: [unfinishedNote],
          });
        }
      }
    } finally {
      // Nothing below is the turn's own work, and the tally must not outlive it.
      stopTally();
      // A turn that threw escapes upstream of the settlement block, so until now
      // it released its holds at zero cost and the ledgers never saw a token of
      // it. Measured 2026-09-24: one 20-minute backend timeout spent 295,953
      // tokens — 123% of that seat's entire budget — and left the agent, mission
      // and thread ledgers reading exactly what they read before it started. The
      // 8x ceiling that halts a mission is computed from those ledgers, so it was
      // blind to the single most expensive turn of the run.
      //
      // `openReservations` is the discriminator, not the discard reason. The
      // success path settles and then empties it (`openReservations.length = 0`),
      // so a `rotation_handoff` or `no_ops` discard — which returns normally, bills
      // at the settlement block, and only THEN classifies itself — arrives here
      // with an empty list and is correctly skipped. A non-empty list means the
      // turn threw before `consume`, which is the only case that needs billing and
      // the reason this cannot double-count.
      //
      // Deduped by ledger key: a prompt top-up pushes a SECOND reservation on a key
      // already held (`topUpPromptHold`), and the cost is one turn's tokens, not one
      // per hold. The first reservation per key settles the spend; the rest are
      // released, exactly as they would have been.
      //
      // Billed by `billedTurnTokens`, the rule the success path settles by and the
      // mid-turn budget interrupt measures with (`noteLiveUsage`), so one turn's
      // usage costs the same however it ended. Identical to raw `total` at the
      // default `cache_read_weight` of 0; `turn.discarded.tokens` stays the raw
      // figure the backend reported.
      const discardedTokens =
        turnDiscard?.tokens === undefined
          ? undefined
          : billedTurnTokens(turnDiscard.usage ?? { total: turnDiscard.tokens }, this.config.budgets?.cacheReadWeight).billed;
      if (discardedTokens !== undefined && discardedTokens > 0 && openReservations.length > 0) {
        const settleWith = new Map<string, string>();
        for (const { key, reservationId } of openReservations) {
          if (!settleWith.has(key)) settleWith.set(key, reservationId);
        }
        // The split the success path records on its agent-ledger row, when the
        // stopped call reported one (see `turnDiscard.usage`); absent otherwise.
        const split = turnDiscard!.usage;
        const detail = {
          agentId,
          turnId,
          discarded: turnDiscard!.reason,
          ...(split
            ? {
                input: split.input,
                output: split.output,
                ...(split.cacheRead !== undefined ? { cacheRead: split.cacheRead } : {}),
                ...(split.thinking !== undefined ? { thinking: split.thinking } : {}),
                ...(split.model ? { model: split.model } : {}),
              }
            : {}),
        };
        for (const [key, reservationId] of settleWith) {
          await this.deps.budget
            .consume(key, "tokens", discardedTokens, reservationId, detail, { actorId: agentId, correlationId: turnId })
            .catch(() => undefined);
        }
        // The mission hold is in `openReservations` like the others and settled
        // above. Only a turn that threw before taking it (it is taken second,
        // right after the agent hold) reaches here without one, and still bills.
        if (!settleWith.has(missionKey(goalId))) {
          await this.deps.budget
            .consume(missionKey(goalId), "tokens", discardedTokens, undefined, detail, { actorId: agentId, correlationId: turnId })
            .catch(() => undefined);
        }
        // Anything still held on an already-settled key is a surplus top-up hold.
        const settled = new Set(settleWith.values());
        for (const { key, reservationId } of openReservations) {
          if (settled.has(reservationId)) continue;
          await this.deps.budget.release(key, reservationId, { actorId: agentId, goalId }).catch(() => undefined);
        }
        openReservations.length = 0;
      }
      // Give back any hold the turn never settled (it threw before consume).
      for (const { key, reservationId } of openReservations) {
        await this.deps.budget.release(key, reservationId, { actorId: agentId, goalId }).catch(() => undefined);
      }
      // One event for every way a turn's work fails to reach the mesh. Emitted
      // here because the `finally` is the only block all those paths share.
      //
      // `correlationId: turnId` is passed EXPLICITLY and must stay that way: the
      // `activeTurnByAgent` delete is three lines below, so a correlation resolved
      // from that map would come back undefined depending on statement order.
      if (turnDiscard) {
        await this.deps.kernel
          .emit(
            "turn.discarded",
            {
              agentId,
              turnId,
              reason: turnDiscard.reason,
              ...(turnDiscard.tokens !== undefined ? { tokens: turnDiscard.tokens } : {}),
              ...(turnDiscard.detail ? { detail: turnDiscard.detail } : {}),
            },
            { actorId: agentId, goalId, correlationId: turnId },
          )
          .catch(() => undefined);
      }
      // The SEAT's own record of a turn that did not finish. The per-turn note is
      // written on the success path ~130 lines above, past which a timeout has
      // already thrown — so a turn the operator could see in `turn.discarded` left
      // the one reader who could act on it with nothing at all. The next turn then
      // opened with the same mission, the same task and no memory of the attempt,
      // and re-entered the same long turn: measured 2026-09-24, one seat spent
      // 302,667 tokens on a 20-minute timeout and its successor knew nothing of it.
      //
      // Gated on the reason rather than on a flag, because the three success-path
      // discards (`no_ops`, `rotation_handoff`, `all_rejected`) set `endSummary`
      // and already wrote their note, and `budget_blocked` never reached the model.
      // Written BEFORE the `turnInFlight` delete below, so the retry that delete
      // admits cannot race the note into its own context build.
      if (turnDiscard && ABNORMAL_TURN_ENDINGS.has(turnDiscard.reason)) {
        await this.rememberMemory(
          agentId,
          `turn:${turnId}`,
          // The fact-built note when the throw arm built one; a kernel rejection
          // after the model answered reaches here without it.
          unfinishedNote ?? abnormalTurnNote(turnDiscard, this.nowMs() - (Date.parse(turnStartedAt) || this.nowMs())),
        ).catch(() => undefined);
      }
      // An operator stop records how the turn really ended, and a stop that asked
      // for the seat to stay down suspends it here — before the `turnInFlight`
      // delete below, past which the scheduler may re-queue it for its mail.
      const stopRequest = this.operatorStops.get(turnId);
      if (stopRequest) {
        stopRequest.endedAs = turnDiscard?.reason ?? "completed";
        if (stopRequest.suspend) await this.suspendAfterStop(agentId, turnId, stopRequest).catch(() => undefined);
      }
      // What the turn held back, delivered as one digest. Here, in the `finally`
      // every ending passes through, and before the turn bookkeeping below is
      // torn down: `sendMessage` stamps its correlation from the turn that is
      // still live, which is what puts the digest on the turn's row instead of
      // leaving it an event belonging to no turn. A turn that threw -- timeout,
      // dead backend, a rejection after the model answered -- still ships the
      // chatter it wrote, because the alternative is a seat's words vanishing
      // with the turn.
      await this.flushHeldSends(agentId);
      this.turnInFlight.delete(agentId);
      this.activeTurnByAgent.delete(agentId);
      this.liveTurnByAgent.delete(agentId);
      this.turnVerificationTools.delete(agentId);
      this.budgetStops.delete(turnId);
      this.operatorStops.delete(turnId);
      this.shutdownStops.delete(turnId);
      const stopWaiters = this.turnEndWaiters.get(turnId);
      if (stopWaiters) {
        this.turnEndWaiters.delete(turnId);
        for (const wake of stopWaiters) wake();
      }
      // Keyed by turn, so it must be dropped here or it accumulates one entry
      // per turn for the life of the mission.
      this.turnEffects.delete(turnId);
      this.lastTurnAt = this.nowMs();
      this.deps.scheduler.notifyTurnFinished(agentId);
      // The handover turn CONSUMED the activation that woke this seat, so the
      // work it was woken for has not happened. Put it back — after
      // `notifyTurnFinished`, so the scheduler is no longer holding this agent
      // as running and the request is admitted rather than stashed.
      //
      // This cannot loop: the next turn comes in without `suppressRotation`,
      // the adapter rotates on the way in, and `openHandover` will not ask
      // again until the seat has crossed the threshold on a LATER transcript.
      //
      // Put back at the HEAD of the queue, and only if still wanted — see
      // `requeueAfterHandover`.
      if (handoverReactivation) {
        void this.requeueAfterHandover(agentId, handoverReactivation).catch((err) =>
          this.auditLine(`handover re-queue for ${agentId} failed: ${(err as Error).message}`),
        );
      }
      // An interest wake that produced NOTHING is put back for the same reason,
      // with one deliberate difference: no `explicit`, so `isParkedForBackoff`
      // still applies. That is what bounds this — an interest wake has no other
      // guard, so without the breaker's parking gate a seat that cannot use the
      // observation would be re-woken on it indefinitely.
      if (noopReactivation) {
        this.activateAgent(agentId, noopReactivation).catch(() => undefined);
      }
      void this.afterActivity();
      // A turn that changed nothing must not restart the stall clock for the
      // full idle + cooldown: the mission is quiet, nothing is queued, and the
      // next driver should be tried in seconds, not minutes. The breaker still
      // parks a chronic no-op agent after 3 strikes, and `checkStall` still
      // skips when anything is pending/running — so this cannot hot-loop.
      // A turn that moved the mesh ends the watchdog's "nudges that bought
      // nothing" streak: that is what the cap is counting, and a mission that
      // just produced work is by definition not the wedged one it escalates
      // for. Kept here, next to the fast-retry arm, so the two halves of the
      // no-op story stay in one place.
      if (turnProducedWork) this.stallNudgeStreak = 0;
      if (turnChangedNothing && this.liveMode) {
        this.stallNoopRetryAt = this.nowMs() + this.config.scheduling.stallNoopRetryMs;
        if (this.stallNoopTimer) this.timers.clearTimeout(this.stallNoopTimer);
        const t = this.timers.setTimeout(() => {
          this.stallNoopTimer = undefined;
          void this.checkStall().catch((err) => this.auditLine(`stall watch error: ${(err as Error).message}`));
        }, this.config.scheduling.stallNoopRetryMs);
        (t as unknown as { unref?: () => void }).unref?.();
        this.stallNoopTimer = t;
      }
    }
  }

  private async callRuntimeWithTimeout(agentId: string, session: { session: import("../../protocol/src/index").AgentSession; runtime: AgentRuntime }, input: AgentInput, turnId: string): Promise<AgentOutput> {
    // A seat holding a claimed task gets longer, because it is the seat the
    // mission is blocked on and the one turn that must not be thrown away.
    //
    // `turn_timeout_ms` is a single global number, and it is calibrated for
    // coordination: review, dispositioning and delegation turns take one to three
    // minutes, while a turn that actually builds something takes fourteen to
    // twenty. Both live timeouts in one run killed the seat the mission was
    // waiting on, one of them holding the only claimed implementation task in the
    // mission — twenty minutes of work discarded, and the task still marked
    // CLAIMED afterwards.
    //
    // `activeTaskId` is the distinction, it is already in scope, and it is read
    // one screen away in `handleAgentFailure` to release the claim. Multiplying
    // the existing budget keeps one knob rather than introducing a per-seat
    // timeout config surface and the schema churn that comes with it.
    //
    // Read again when the deadline EXPIRES, not only here: a claim made inside
    // the call used to leave the turn on 1x, and a turn still writing files was
    // killed with its last frame 5 s old (NOTES live-run §3). The decision is
    // `turnDeadlineExtension`'s; this wires it to the live facts.
    const baseMs = this.config.scheduling.turnTimeoutMs;
    const holdsTask = (): boolean => this.state.agents.get(agentId)?.state.activeTaskId !== undefined;
    // How recent a frame must be for an expiring turn to count as working, and
    // how long each such extension lasts. The silence floor is the mesh's own
    // measure of "a stream this quiet has frozen"; clamped to the base timeout
    // so a mesh with short turns is re-checked at its own scale.
    const windowMs = Math.min(this.config.scheduling.turnSilenceMs, baseMs);
    const calledAt = this.nowMs();
    const ceilingMs = baseMs * WORK_TURN_TIMEOUT_MULTIPLE;
    let deadlineMs = holdsTask() ? ceilingMs : baseMs;
    let extendedFor: "task" | "activity" | undefined;
    const stopNote = (): string | undefined =>
      extendedFor ? `extended from ${baseMs}ms: ${extendedFor === "task" ? "the seat claimed a task" : "the turn was still producing frames"}` : undefined;
    let timer: TimerHandle | undefined;
    let timedOut = false;
    // The deadline as a reader sees it, re-published on every extension: a
    // turn's record used to say nothing about when it would be stopped, so a
    // 17-minute turn looked the same at minute 2 as at minute 19.
    const publishDeadline = (): void => {
      try {
        this.turns.setDeadline(turnId, calledAt + deadlineMs, calledAt + ceilingMs);
        this.recentTurns = this.turns.list(RECENT_TURNS_MAX);
      } catch {
        /* observability only */
      }
    };
    publishDeadline();
    // Warnings the seat can act on, independent of the expiry timer above: at
    // the base budget ("you are on extension time"), and shortly before the
    // ceiling ("commit now"). Each is sent once, only to a turn still running
    // that nothing has started stopping, and recorded whether or not the runtime
    // could deliver it. `settled` guards a timer that fires as the call returns.
    let settled = false;
    const advisoryTimers: TimerHandle[] = [];
    const sendAdvisory = (kind: "budget" | "final"): void => {
      try {
        if (settled || timedOut || this.interruptedTurnIds.has(turnId)) return;
        if (this.turns.get(turnId)?.status !== "running") return;
        const text = turnAdvisoryText(kind, { baseMs, remainingMs: Math.max(0, calledAt + ceilingMs - this.nowMs()), canCommit: this.canCommit(agentId) });
        let delivered = false;
        try {
          delivered = session.runtime.advise?.(session.session, text) === true;
        } catch {
          delivered = false;
        }
        this.turns.noteAdvisory(turnId, { at: this.nowMs(), text, delivered });
        this.recentTurns = this.turns.list(RECENT_TURNS_MAX);
        this.auditLine(
          `turn ${turnId} for ${agentId}: ${kind === "budget" ? `turn budget ${baseMs}ms reached` : `hard stop at ${ceilingMs}ms approaching`} — advisory ${delivered ? "queued for the seat" : "NOT delivered (the runtime cannot advise a running turn)"}`,
        );
      } catch {
        /* a warning must never break the turn it warns */
      }
    };
    // The expiry timer is armed first below, so at `baseMs` it has already
    // decided (extend, or stop and set `timedOut`) when this one runs.
    const finalAt = ceilingMs - Math.min(windowMs, TURN_FINAL_ADVISORY_MAX_MS);
    const timeout = new Promise<never>((_, reject) => {
      const expire = (): void => {
        const now = this.nowMs();
        const elapsedMs = now - calledAt;
        const lastActivityAt = this.turns.get(turnId)?.phases?.lastActivityAt;
        const extension = turnDeadlineExtension({
          elapsedMs,
          baseMs,
          holdsTask: holdsTask(),
          sinceActivityMs: lastActivityAt === undefined ? undefined : now - lastActivityAt,
          windowMs,
        });
        if (extension) {
          deadlineMs = elapsedMs + extension.extendMs;
          publishDeadline();
          // One line per reason, not per re-check: an active turn is re-checked
          // every window, and the audit should say why it lived, not narrate it.
          if (extendedFor !== extension.why) {
            this.auditLine(
              `turn ${turnId} for ${agentId}: deadline reached at ${elapsedMs}ms — extended to ${deadlineMs}ms (${extension.why === "task" ? "holds a task" : "still producing frames"})`,
            );
          }
          extendedFor = extension.why;
          timer = this.timers.setTimeout(expire, extension.extendMs);
          return;
        }
        timedOut = true;
        // Interrupt, then give the interrupt a moment to answer before giving up
        // on it. The abort comes back as an `InterruptedTurnError` carrying the
        // backend's real `usage` -- the only token figure a killed turn ever
        // has. This site used to reject immediately, so it always won that race
        // and the usage was discarded: a 20-minute turn measured on 2026-09-24
        // (`turn-2bff2a0e892e43ab`) reported no tokens at all, and 5 of that
        // run's 85 turns billed nothing. The ceiling that halts a mission is
        // computed from those figures, so it was blind to the most expensive
        // turns in the run.
        //
        // The wait is bounded and small: if the backend does not answer the
        // abort, the bare `TurnTimeoutError` below still fires and the turn ends
        // exactly as it did before.
        //
        // The label stays "timeout". `classifyTurnFailure` reads type before
        // message, and an `InterruptedTurnError` classifies as "silence" -- so
        // handing the raw interrupt to the caller would relabel every timeout as
        // silence and erase the distinction that comment was written to keep.
        // Carry the interrupt's tokens on a timeout-typed failure instead.
        //
        // Typed as `TurnTimeoutError`, not a bare `RuntimeFailure`: the failure
        // path keys "slow, not crashed" off `isTimeoutError`, and the bare type
        // sent a stopped turn down the crash ladder (see the error's doc).
        void session.runtime
          .interrupt(session.session)
          .catch(() => undefined)
          .finally(() => {
            this.timers.setTimeout(() => reject(new TurnTimeoutError(deadlineMs, undefined, undefined, stopNote())), TURN_TIMEOUT_USAGE_GRACE_MS).unref?.();
          });
      };
      timer = this.timers.setTimeout(expire, deadlineMs);
    });
    advisoryTimers.push(this.timers.setTimeout(() => sendAdvisory("budget"), baseMs));
    if (finalAt > baseMs) advisoryTimers.push(this.timers.setTimeout(() => sendAdvisory("final"), finalAt));
    // The silence watchdog's forced settle (see `forceSettleTurn`). Deleted in
    // the `finally`, so a settle that fires after the call returned is a no-op.
    const forced = new Promise<never>((_, reject) => {
      this.forceSettleTurn.set(turnId, reject);
    });
    try {
      // Prefer the live stream when the runtime has one. `collectAgentOutput`
      // folds it back into the same struct every read site downstream already
      // expects, and forwards text deltas to `input.onToken` — which is what
      // stamps phases.firstTokenAt/lastTokenAt, so the silence watchdog in
      // `interruptSilentTurns` keeps seeing a streaming turn as alive.
      const turn = session.runtime.stream
        ? collectAgentOutput(session.runtime.stream(session.session, input), input)
        : session.runtime.send(session.session, input);
      try {
        return await Promise.race([turn, timeout, forced]);
      } catch (err) {
        // The abort we ordered above answered before the grace ran out. Keep its
        // token figures, but re-label it: this turn died of a TIMEOUT, and
        // `InterruptedTurnError` classifies as "silence" one screen down. Letting
        // it through as-is would report every timeout as silence and lose the
        // only signal that tells a seat stuck mid-generation apart from one whose
        // backend went quiet.
        if (timedOut && err instanceof InterruptedTurnError) {
          throw new TurnTimeoutError(deadlineMs, err.tokensUsed, err.model, stopNote());
        }
        throw err;
      }
    } finally {
      settled = true;
      if (timer) this.timers.clearTimeout(timer);
      for (const t of advisoryTimers) this.timers.clearTimeout(t);
      this.forceSettleTurn.delete(turnId);
    }
  }

  private auditTurn(turnId: string, agentId: string, input: AgentInput, output: AgentOutput, toolOps: string[] = []): void {
    this.auditLine(
      JSON.stringify({
        turnId,
        agentId,
        at: this.deps.kernel.clock.iso(),
        activation: input.activation,
        model: output.model,
        modelVersion: output.modelVersion,
        temperature: output.temperature,
        inputDigest: shortHash(JSON.stringify(input.context.unreadMail.map((m) => m.id))),
        outputDigest: shortHash(output.text),
        ops: [...toolOps, ...output.operations.map((o) => o.op)],
        toolCalls: output.toolCalls ?? [],
        tokens: output.tokensUsed,
        // The assembled prompt's real size, recorded nowhere else: the trace
        // copy is truncated, so without this there is no way to correlate what
        // a turn COST with how big its context actually was, and no way to tell
        // a cache miss caused by prompt churn from one caused by volume.
        instructionsChars: input.instructions?.length ?? 0,
        // Recorded next to the chars it came from so systematic bias in
        // `CHARS_PER_TOKEN` is visible to a human reading the audit against
        // real spend. Deliberately NOT self-calibrating: the only reality
        // signal available is the turn's `input`, which also contains the
        // system prompt, the tool schemas and the whole accumulated
        // transcript, so a ratio derived from it would be measuring mostly
        // other things and drifting the constant for the wrong reason.
        estInputTokens: estimateTokens(input.instructions?.length ?? 0),
        memoryNotes: input.context.agentMemory.length,
      }),
    );
    // Realtime mirror: keep the in-memory turn trace fresh even before the turn ends.
    this.pushTurn({
      turnId,
      agentId,
      reason: input.activation,
      startedAt: this.getTurn(turnId)?.startedAt ?? this.deps.kernel.clock.iso(),
      status: "running",
      model: output.model,
      ops: [...toolOps, ...output.operations.map((o) => o.op)],
      toolCalls: output.toolCalls?.length ?? 0,
      toolCallsDetail: traceToolCalls(output.toolCalls),
      tokens: output.tokensUsed?.total ?? 0,
      tokensInput: output.tokensUsed?.input,
      tokensOutput: output.tokensUsed?.output,
      tokensCacheRead: output.tokensUsed?.cacheRead,
      tokensThinking: output.tokensUsed?.thinking,
      summary: declaredTurnSummary(output)?.slice(0, 500),
      text: (output.text ?? "").slice(0, MAX_TRACE_TEXT_CHARS),
      instructions: input.instructions?.slice(0, MAX_TRACE_INSTRUCTIONS_CHARS),
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
    // The provider refused the turn (429/402/401/403/5xx, or its endpoint is
    // unreachable): not this seat's fault, and not this seat's ladder. Decided
    // before anything below reads `unreachable`, whose pattern would otherwise
    // file a proxy's "Connection error" as this seat's dead backend.
    const outage = slow ? null : classifyProviderOutage(error);
    const unreachable = !slow && !outage && isConnectionError(error);
    const short = error instanceof Error ? error.message : String(error ?? "unknown failure");
    const labeled = backend ?? (unreachable ? `backend unreachable for ${agentId}: ${short}` : short);
    // The session that failed, read before it is dropped below. This was a
    // hard-coded `null` while the session was in hand, so the record of a failed
    // turn could not say which transcript it died on (NOTES live-run §3). The
    // mesh-side id is stable across rotations; the registry holds the backend's
    // CURRENT transcript id (updated on every rotation), which is the one an
    // operator opens, so it rides beside it when the two differ.
    const failedSessionId = this.sessions.get(agentId)?.session.sessionId ?? null;
    const registered = failedSessionId ? await this.deps.sessionRegistry?.lookup(agentId).catch(() => null) : null;
    await this.deps.kernel
      .emit(
        "agent.failed",
        {
          agentId,
          error: labeled,
          sessionId: failedSessionId,
          ...(registered?.sessionId && registered.sessionId !== failedSessionId ? { sdkSessionId: registered.sessionId } : {}),
          // An outage failure is always retried, persistent seat or not — so it
          // is restartable, which is what keeps the termination manager's
          // `runtime_failure` verdict off it in the window before the retry.
          restartable: outage ? true : (this.config.agents[agentId]?.sessionPolicy.persistent ?? false),
          ...(outage ? { providerOutage: outage.kind, ...(outage.status !== undefined ? { status: outage.status } : {}) } : {}),
        },
        { actorId: agentId },
      )
      .catch(() => undefined);
    this.sessions.delete(agentId);
    if (outage) {
      await this.handleProviderOutage(agentId, outage, reason);
      return;
    }
    const persistent = this.config.agents[agentId]?.sessionPolicy.persistent ?? false;
    if (slow) {
      // Keep the crash counter untouched, and reset any unreachable streak: the
      // backend demonstrably accepted our connection.
      this.unreachableStreak.delete(agentId);
      const slowAttempts = (this.timeoutRetries.get(agentId) ?? 0) + 1;
      this.timeoutRetries.set(agentId, slowAttempts);
      if (persistent && slowAttempts <= MAX_TIMEOUT_RETRIES) {
        await this.deps.kernel.emit("agent.restarted", { agentId, attempt: slowAttempts }, { actorId: RECOVERY_ACTOR_ID });
        if (this.state.agents.get(agentId)) {
          await this.deps.kernel.emit("agent.state_changed", { agentId, to: "IDLE" }, { actorId: RECOVERY_ACTOR_ID });
        }
        // Back off so a genuinely wedged backend is not hammered, but do not
        // give up: the work is still valid, the model was simply not done.
        const delay = Math.min(30000, 1000 * 2 ** (slowAttempts - 1));
        this.timers.setTimeout(() => {
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
      await this.deps.kernel.emit("agent.restarted", { agentId, attempt: attempts }, { actorId: RECOVERY_ACTOR_ID });
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
      this.timers.setTimeout(() => {
        void this.activateAgent(agentId, { kind: "recovery", note: `restart after failure: ${labeled}`, eventId: reason.eventId }).catch(() => undefined);
      }, 20);
    } else {
      const activeTask = this.state.agents.get(agentId)?.state.activeTaskId;
      const held = activeTask ? this.state.tasks.get(activeTask) : undefined;
      // Only a task the seat still HOLDS is released; the reducer refuses to
      // reopen anything else (a COMPLETED task above all), and a refusal here
      // would throw out of the failure handling below.
      if (held && (held.status === "CLAIMED" || held.status === "IN_PROGRESS") && held.claimedBy === agentId) {
        await this.deps.kernel.emit("task.claimed", { taskId: held.id, agentId: null }, { actorId: RECOVERY_ACTOR_ID });
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
      //
      // Recorded as MESH-parked before the emit, so a human escalation answer
      // can tell this suspension from one the operator asked for (a pause, a
      // stop with `suspend`) and revive exactly these — see
      // `reviveTerminalSuspended`. `cause` is the durable copy of that
      // classification, which boot reads back (`rebuildTerminalSuspended`);
      // the `note` stays prose.
      this.terminalSuspended.add(agentId);
      await this.deps.kernel
        .emit("agent.state_changed", { agentId, to: "SUSPENDED", cause: TERMINAL_FAILURE_CAUSE, note: `terminal failure: ${short}` }, { actorId: HUMAN_AGENT_ID })
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
            backend: backend ?? "unknown — check the agent's runtime (http baseUrl)",
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

  /**
   * A turn the model PROVIDER refused. The seat is not the fault, so none of
   * the seat's machinery moves: no crash, slow-turn or unreachable strike, no
   * released task, no discharged ask, no park, no per-seat card, and no strike
   * on the scheduler's per-seat breaker. The turn is still discarded and billed
   * like any other failure (the caller's `finally` does both).
   *
   * What happens instead: the seat goes back to IDLE (through the restart
   * edge, the only way out of FAILED), the scheduler's provider breaker counts
   * the failure toward its mission-wide trip, and the seat's own retry is
   * queued a little later. Once the breaker is open that retry is HELD in the
   * queue, not refused, so the seat keeps its place for the probe and for the
   * breaker's close without a timer per seat.
   *
   * Measured twice before this existed (2026-09-27 on a 429, 2026-09-28 on a
   * 402): every seat walked its own ladder in ~90s, was parked SUSPENDED and
   * raised its own `runtime_failure` card — ten cards for one outage, and a
   * mission that sat dead until an operator resumed each seat by hand.
   */
  private async handleProviderOutage(agentId: string, outage: ProviderOutage, reason: ActivationReason): Promise<void> {
    const attempt = (this.outageRetries.get(agentId) ?? 0) + 1;
    this.outageRetries.set(agentId, attempt);
    if (this.state.agents.get(agentId)?.state.lifecycle === "FAILED") {
      await this.deps.kernel
        .emit("agent.restarted", { agentId, attempt, cause: "provider_unavailable" }, { actorId: RECOVERY_ACTOR_ID })
        .catch(() => undefined);
    }
    if (this.state.agents.get(agentId)?.state.lifecycle === "STARTING") {
      await this.deps.kernel
        .emit("agent.state_changed", { agentId, to: "IDLE", note: `the model provider refused the turn: ${outage.error.slice(0, 200)}` }, { actorId: RECOVERY_ACTOR_ID })
        .catch(() => undefined);
    }
    this.deps.scheduler.noteTurnOutcome?.(agentId, "outage", { error: outage.error });
    // Spaced like the slow-turn retry: a 429 that says "reset after 3s" is
    // worth a retry in seconds, and three of these inside the trip window are
    // what open the breaker, which then holds the retry for the backoff.
    const delay = Math.min(30_000, 2_000 * 2 ** (attempt - 1));
    const t = this.timers.setTimeout(() => {
      void this.activateAgent(agentId, {
        kind: "recovery",
        note: `retry: the model provider refused your last turn (${outage.error.slice(0, 160)}) — nothing you did caused it; carry on with your work`,
        eventId: reason.eventId,
      }).catch(() => undefined);
    }, delay);
    (t as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * The scheduler's provider breaker changed state (see `Scheduler.noteTurnOutcome`).
   * The scheduler gates admission; this keeps the one card, the audit trail
   * and the probe supply.
   */
  async onProviderBreaker(transition: ProviderBreakerTransition): Promise<void> {
    const run = this.providerBreakerChain.then(() => this.applyProviderBreaker(transition));
    this.providerBreakerChain = run.catch((err) => this.auditLine(`provider breaker: ${(err as Error).message}`));
    return run;
  }

  private async applyProviderBreaker(t: ProviderBreakerTransition): Promise<void> {
    const s = t.snapshot;
    const at = (ms: number | undefined): string => (ms ? new Date(ms).toISOString() : "?");
    this.auditLine(
      `provider breaker: ${t.from} -> ${t.to} (${t.why}); ${s.failedTurns} turn(s) refused across ${s.seats.join(", ") || "no seat"}` +
        (t.to === "open" ? `; admitting no turns until ${at(s.nextProbeAt)} (backoff ${Math.round(s.backoffMs / 60_000)}m, opening ${s.opens})` : "") +
        (t.to === "closed" ? `; probe by ${s.probe ?? "?"} answered — admitting turns again` : "") +
        `; last error: ${s.lastError.slice(0, 300)}`,
    );
    const goalId = this.state.activeGoalId;
    if (!goalId) return;
    const card = [...this.state.escalations.values()].find((e) => e.status === "OPEN" && e.conflictKey === providerCardKey(goalId));
    if (t.to === "closed") {
      // Already answered (RESPONDED) cards are left as the operator closed them.
      if (card) {
        await this.deps.kernel.emit(
          "escalation.auto_resolved",
          {
            escalationId: card.id,
            reason: `auto-resolved: the model provider answered ${s.probe ?? "a"} probe turn, so the breaker closed and every seat is admitted again (${s.failedTurns} turn(s) had been refused across ${s.seats.length} seat(s) since ${at(s.openedAt)})`,
            probe: s.probe,
            failedTurns: s.failedTurns,
            seats: s.seats,
          },
          { actorId: RECOVERY_ACTOR_ID, goalId },
        );
      }
      this.outageRetries.clear();
      return;
    }
    const detail = providerCardDetail(s, t.to, this.nowMs());
    if (card) {
      // The same card, restated. `escalation.requested` is the one event the
      // reducer reads a card's body from, and it stores by id, so re-emitting
      // it with the card's own id updates "next attempt" in place instead of
      // minting a second card for the same outage.
      await this.deps.kernel.emit(
        "escalation.requested",
        { escalation: { ...card, detail: { ...detail, disagreementRef: (card.detail as { disagreementRef?: unknown } | undefined)?.disagreementRef } } },
        { actorId: card.raisedBy, goalId },
      );
    } else if (t.to === "open") {
      await this.escalate({
        reason: PROVIDER_UNAVAILABLE_REASON,
        raisedBy: RECOVERY_ACTOR_ID,
        conflictKey: providerCardKey(goalId),
        // Advisory: the card must never halt the goal. An ESCALATED goal
        // refuses every activation, the probe's included, and the breaker
        // heals the mission on its own; the card informs and offers the
        // shortcut (answer it to probe now).
        advisory: true,
        participants: s.seats,
        detail,
      });
    }
    if (t.to === "half_open") await this.supplyProviderProbe(s);
  }

  /**
   * Half-open admits the next queued turn as the probe. When nothing is
   * queued — every seat's retry already ran, or the mission was idle when the
   * provider went away — wake one, or the breaker would sit half-open with
   * nobody to prove the provider is back (and its open card would hold the
   * mission's completion verdict shut). Most recently refused seat first: it
   * is the likeliest to still have the work the outage interrupted.
   */
  private async supplyProviderProbe(s: ProviderBreakerSnapshot): Promise<void> {
    if (this.deps.scheduler.pending() > 0) return;
    const driver = this.stallDriver();
    const order = [...new Set([...[...s.seats].reverse(), ...this.recoveryCandidates(), ...(driver ? [driver] : [])])];
    for (const id of order) {
      const rec = this.state.agents.get(id);
      if (!rec || id === HUMAN_AGENT_ID || this.turnInFlight.has(id)) continue;
      if (["SUSPENDED", "COMPLETED", "RETIRED"].includes(rec.state.lifecycle)) continue;
      const res = await this.activateAgent(id, {
        kind: "recovery",
        note: `the model provider was refusing turns (${s.lastError.slice(0, 160)}); this turn is the probe that tells the mesh it is back — carry on with your work`,
      });
      if (res.queued) {
        this.auditLine(`provider breaker: woke ${id} to probe the provider`);
        return;
      }
    }
    this.auditLine("provider breaker: half-open, but no seat could be woken to probe — the next admitted turn will be the probe");
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
    const workspacePath = await this.agentWorkspace(agentId);
    this.seatWorkspaceRoots.set(agentId, workspacePath);
    return {
      goalId: this.state.activeGoalId ?? "",
      meshId: this.config.meshId,
      workspacePath,
      busUrl: process.env.MESH_BUS_URL ?? `http://${this.config.server.host}:${this.config.server.port}`,
      // Keyed by a per-process secret (seat-token.ts): the old shortHash of
      // public ids was a token any local process could compute.
      agentToken: mintSeatToken(this.config.meshId, agentId, this.state.activeGoalId),
      // Resolved, not read off the definition. `prompt.text` is only ever set
      // for the two hardcoded seats; every YAML-configured agent carries
      // `prompt.file`, so reading `.text` here handed each one an empty system
      // prompt — silently, since a seat with no role prose still answers, just
      // without knowing who it is. `loadRolePrompt` is the same resolver the
      // per-turn context bundle uses, so both runtimes now see one value.
      rolePromptText: loadRolePrompt(this.config, agentId, rec.definition),
      capabilityGrants: rec.definition.capabilities,
      approvalRequired: rec.definition.requiresApproval,
      approvalGranted: [...(this.toolGrants.get(agentId) ?? [])],
      ...(this.deps.workspace ? { productPath: this.deps.workspace.mainPath } : {}),
      env: { MESH_AGENT_ID: agentId, MESH_GOAL_ID: this.state.activeGoalId ?? "" },
    };
  }

  /**
   * The directory a seat's runtime runs in.
   *
   * In git mode this must never be the workspace ROOT. The root holds `main/`
   * and `worktrees/` and is itself part of no repository, so a seat placed
   * there writes files that no commit path can reach — untracked, invisible to
   * every reviewer, and left behind by a reset that only archives `main/`. That
   * is not hypothetical: the scaffolded architect holds `architecture.write`
   * and not `repository.write`, so it wrote its design straight into the root
   * and the mission could never cite a revision for it.
   *
   * So the fork is over which view of the repo a seat gets, never whether it is
   * in one: seats that may write get an isolated worktree, and seats that may
   * not read the product checkout. Without a workspace at all (no-git mode) the
   * root IS the product, and it stays correct.
   *
   * The fork asks `EDIT_CAPABILITIES`, the same list the runtime gate asks to
   * decide whether the seat may use Write/Edit at all, so a seat can never be
   * permitted to write yet placed somewhere its writes cannot land. Keying on
   * `repository.write` alone was that mismatch. It also has to be this list and
   * not a looser one: a seat that can write but has no worktree would write
   * untracked files into `main/`, where a path collision aborts the very
   * `git merge` that lands the mission's work.
   */
  /**
   * Warn a seat whose turn left files in its worktree and never committed them.
   *
   * Returns the sentence to append to the turn summary, or null when there is
   * nothing to say. Three gates, all required, so the `git status` costs one
   * call on the turns that can possibly need it:
   *
   *  - the workspace can answer at all (an in-memory mesh has no worktrees);
   *  - the seat holds an edit capability, i.e. the same test `agentWorkspace`
   *    uses to give it a worktree in the first place — a read-only seat works in
   *    the product checkout and has nothing to commit;
   *  - the turn did not already commit, since a seat that just committed has by
   *    definition been told nothing is pending;
   *  - the seat may commit at all. The remedy is the `commit` op, so a warning
   *    to a seat without `git.commit` is advice it cannot take, riding its next
   *    context every turn: 12 of the 27 warnings of the 2026-09-25 run went to
   *    such seats (NOTES live-run §18).
   *
   * Runtime-owned `.mesh/` files are not the seat's work and are never listed
   * or counted: 6 of those 27 warnings named nothing else.
   */
  private async uncommittedWorkAdvisory(agentId: string, turn: { results: OpResult[] }): Promise<string | null> {
    if (turn.results.some((r) => r.ok && r.op === "commit")) return null;
    if (!this.canCommit(agentId)) return null;
    const state = await this.uncommittedFiles(agentId);
    if (!state || state.dirty.length === 0) return null;
    const shown = state.dirty.slice(0, 5).join(", ");
    const more = state.dirty.length > 5 ? `, +${state.dirty.length - 5} more` : "";
    const unmerged =
      state.unmergedCommits.length > 0
        ? ` ${state.unmergedCommits.length} commit(s) are on your branch but not in the product — they land only through the \`merge\` op.`
        : "";
    return (
      `⚠ ${state.dirty.length} file(s) in your worktree are NOT committed (${state.untracked} untracked): ${shown}${more}. ` +
      `Nothing here is in the product, no reviewer can read it, and publishing a CodePatch does not commit it — ` +
      `take a write lease and use the \`commit\` op, and do it BEFORE you ask for review: a commit made after a review is a new version, ` +
      `and that version is reviewed again.${unmerged}`
    );
  }

  /**
   * The caveat for a review ask on a CodePatch whose owner has not committed it.
   *
   * `merge` refuses a patch that records no commit, and the commit it then asks for
   * is recorded as a NEW version of the patch -- DRAFT again, its approvals left on
   * the version they were given to. A seat that follows the flow its role describes
   * (publish, ask for review, walk the ladder) therefore finds out only at the last
   * rung, and pays for a second full review of identical work (cronlite run 2: the
   * developer did exactly that, then told pm it had merged).
   *
   * A caveat, not a refusal: a seat may legitimately commit through its own shell and
   * let `merge` take the branch, and the review it is asking for is real either way.
   * Three facts must hold for it to say anything, so the `git status` is paid for only
   * on an ask that can need it: the artifact is a CodePatch that records no commit,
   * its owner could commit, and its worktree holds work no commit does.
   */
  private async unrecordedPatchCaveat(a: Artifact): Promise<string | undefined> {
    if (a.type !== "CodePatch") return undefined;
    if (typeof a.metadata?.commit === "string" && a.metadata.commit.length > 0) return undefined;
    if (!this.canCommit(a.owner)) return undefined;
    const state = await this.uncommittedFiles(a.owner);
    if (!state || state.dirty.length === 0) return undefined;
    return (
      `${a.owner} has ${state.dirty.length} uncommitted file(s) in its worktree and '${a.name}' records no commit: reviewers can read only what was published, ` +
      `\`merge\` will refuse a patch with nothing committed, and a commit made after this review becomes a new version that is reviewed again — ` +
      `\`mesh_commit\` first, then ask for review`
    );
  }

  /** Would `opCommit` let this seat commit? Asked the same way it asks. */
  private canCommit(agentId: string): boolean {
    const goal = this.state.activeGoalId ? this.state.goals.get(this.state.activeGoalId) : undefined;
    return this.deps.policy.evaluateCapability(agentId, "git.commit", { config: this.config, projections: this.state, goal }).decision === "ALLOW";
  }

  /**
   * What the seat has in its worktree that no commit holds, runtime-owned
   * `.mesh/` paths removed. Null when the question has no answer: no workspace
   * (in-memory mesh), no edit capability (the seat works in the product
   * checkout, not a worktree), or git could not say.
   *
   * `.mesh/agents/<id>/` is where the runtime writes the seat's ROLE.md and
   * MESH_CONTEXT.md, inside the worktree, and it was reported to seats as their
   * own uncommitted work. The port does not say which paths are untracked, so
   * the untracked count is adjusted on the assumption that the removed runtime
   * files were among them — which is how the runtime leaves them.
   */
  private async uncommittedFiles(agentId: string): Promise<{ dirty: string[]; untracked: number; unmergedCommits: string[] } | null> {
    const workspace = this.deps.workspace;
    if (!workspace?.worktreeState) return null;
    const caps = this.config.agents[agentId]?.capabilities ?? [];
    if (!EDIT_CAPABILITIES.some((token) => caps.includes(token))) return null;
    const state = await workspace.worktreeState(agentId).catch(() => null);
    if (!state) return null;
    const dirty = state.dirty.filter((p) => p !== ".mesh" && !p.startsWith(".mesh/"));
    const removed = state.dirty.length - dirty.length;
    return { dirty, untracked: Math.min(dirty.length, Math.max(0, state.untracked - removed)), unmergedCommits: state.unmergedCommits };
  }

  /**
   * The facts `abnormalTurnNote` is built from, read at the moment a turn stopped.
   *
   * With `stopped`, a dirty worktree is also snapshotted (`checkpointStoppedTurn`)
   * and the turn's `filesTouched` is passed along as the fallback account of
   * what it wrote when the worktree cannot be listed.
   */
  private async unfinishedTurnFacts(
    agentId: string,
    landed: TurnEffectTally,
    stopped?: { turnId: string; reason: string },
  ): Promise<UnfinishedTurnFacts> {
    const heldId = this.state.agents.get(agentId)?.state.activeTaskId;
    const held = heldId ? this.state.tasks.get(heldId) : undefined;
    const files = await this.uncommittedFiles(agentId);
    const checkpoint = stopped && files && files.dirty.length > 0 ? await this.checkpointStoppedTurn(agentId, stopped.turnId, stopped.reason, files.dirty.length) : undefined;
    const touched = stopped ? this.turns.get(stopped.turnId)?.filesTouched : undefined;
    return {
      landed,
      ...(files ? { uncommitted: { files: files.dirty, untracked: files.untracked } } : {}),
      canCommit: this.canCommit(agentId),
      ...(held && held.claimedBy === agentId && (held.status === "CLAIMED" || held.status === "IN_PROGRESS")
        ? { heldTask: { id: held.id, title: held.title } }
        : {}),
      ...(checkpoint ? { checkpoint: { ref: checkpoint.ref, commit: checkpoint.commit } } : {}),
      ...(touched && touched.length > 0 ? { filesTouched: [...touched] } : {}),
    };
  }

  /**
   * Snapshot the worktree of a turn that was stopped with files uncommitted.
   *
   * A live backend turn wrote 37 files, committed none, and was killed at the
   * timeout; the files stayed in its worktree, where the next reset archives
   * them and a retry that "starts over" overwrites them. The snapshot is a
   * commit under `refs/mesh/checkpoints/<seat>/<turn>` that touches neither the
   * branch, the index nor a file (`WorkspacePort.checkpointWorktree`), so the
   * work is recoverable whatever happens to the worktree next.
   *
   * Best-effort by construction: optional on the port, raced against
   * `TURN_CHECKPOINT_TIMEOUT_MS`, and every failure is an audit line, never a
   * throw — this runs on the failure path of a turn that has already failed.
   */
  private async checkpointStoppedTurn(agentId: string, turnId: string, reason: string, dirtyCount: number): Promise<TurnCheckpoint | undefined> {
    const workspace = this.deps.workspace;
    if (!workspace?.checkpointWorktree) return undefined;
    const ref = `refs/mesh/checkpoints/${agentId.replace(/[^A-Za-z0-9._-]/g, "-")}/${turnId}`;
    const message = `mesh checkpoint: ${agentId} ${turnId} stopped (${reason}) with ${dirtyCount} uncommitted file(s)`;
    let timer: TimerHandle | undefined;
    try {
      const snapshot = await Promise.race([
        Promise.resolve()
          .then(() => workspace.checkpointWorktree!(agentId, ref, message))
          .catch((err: unknown) => {
            this.auditLine(`checkpoint of ${agentId}'s worktree after ${turnId} failed: ${err instanceof Error ? err.message : String(err)}`);
            return null;
          }),
        new Promise<"timeout">((resolve) => {
          timer = this.timers.setTimeout(() => resolve("timeout"), TURN_CHECKPOINT_TIMEOUT_MS);
        }),
      ]);
      if (snapshot === "timeout") {
        this.auditLine(`checkpoint of ${agentId}'s worktree after ${turnId} gave up after ${TURN_CHECKPOINT_TIMEOUT_MS}ms — its ${dirtyCount} uncommitted file(s) are still in the worktree, unsnapshotted`);
        return undefined;
      }
      if (!snapshot || typeof snapshot.commit !== "string" || !snapshot.commit) return undefined;
      const files = Array.isArray(snapshot.files) ? snapshot.files : [];
      const cp: TurnCheckpoint = { ref, commit: snapshot.commit, files: files.slice(0, MAX_FILES_TOUCHED) };
      this.turns.setCheckpoint(turnId, cp);
      this.recentTurns = this.turns.list(RECENT_TURNS_MAX);
      this.auditLine(`checkpoint: ${agentId}'s ${files.length} uncommitted file(s) after ${turnId} (${reason}) snapshotted at ${ref} (${snapshot.commit.slice(0, 12)})`);
      return cp;
    } catch (err) {
      this.auditLine(`checkpoint of ${agentId}'s worktree after ${turnId} failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    } finally {
      if (timer) this.timers.clearTimeout(timer);
    }
  }

  /**
   * Bring a seat's own worktree up to the product branch before its turn, and say what
   * could not be done.
   *
   * Only a seat that HAS a worktree (`agentWorkspace`): the rest read the product
   * checkout itself, which is always current. QA's worktree stayed at the commit it was
   * created on while `main` moved twice, QA tested it both times, and the two false
   * `quality.block` verdicts cost about 202k tokens and twelve minutes of a twenty-three
   * minute reopen (cronlite, second run). Neither the role prompt nor the briefing said
   * a worktree needs bringing up to date, and a seat does not think to ask.
   *
   * Fast-forward only, and only where nothing the seat wrote can be touched
   * (`WorkspacePort.syncWorktree`); otherwise the note says how far behind it is and
   * why it was left, which is the fact the seat needs before it tests or reviews.
   * Never throws: a failed sync is an audit line, and the turn runs.
   */
  private async syncSeatWorktree(agentId: string): Promise<string | undefined> {
    const workspace = this.deps.workspace;
    if (!workspace?.syncWorktree) return undefined;
    if (!EDIT_CAPABILITIES.some((token) => (this.config.agents[agentId]?.capabilities ?? []).includes(token))) return undefined;
    let res: Awaited<ReturnType<NonNullable<typeof workspace.syncWorktree>>>;
    try {
      res = await workspace.syncWorktree(agentId);
    } catch (err) {
      this.auditLine(`worktree sync for ${agentId} failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
    if (!res || res.outcome === "current") return undefined;
    const commits = `${res.behind} commit${res.behind === 1 ? "" : "s"}`;
    if (res.outcome === "advanced") {
      this.auditLine(`worktree of ${agentId} advanced ${commits} to ${res.base} ${res.baseCommit}`);
      return (
        `Your worktree was ${commits} behind ${res.base} and has been brought up to date (${res.base} is at ${res.baseCommit}): ` +
        `what you read and run here is what has been merged.`
      );
    }
    this.auditLine(`worktree of ${agentId} is ${commits} behind ${res.base} ${res.baseCommit} and was left as it was: ${res.why}`);
    return (
      `Your worktree is ${commits} behind ${res.base} (${res.base} is at ${res.baseCommit}) and could not be brought up to date: ${res.why}. ` +
      `What you read and run here is OLDER than what has been merged, so a test run or a review of it says nothing about ${res.base}. ` +
      `Commit or set aside what you hold, then \`git merge ${res.base}\` in your worktree before you test, verify or review, and name the commit you checked.`
    );
  }

  async agentWorkspace(agentId: string): Promise<string> {
    if (!this.deps.workspace) return this.config.workspacePath;
    const caps = this.config.agents[agentId]?.capabilities ?? [];
    if (EDIT_CAPABILITIES.some((token) => caps.includes(token))) {
      return this.deps.workspace.ensureWorktree(agentId);
    }
    return this.deps.workspace.mainPath;
  }

  // ------------------------------------------------------ artifact bodies

  /**
   * Turn a publish op into the bytes to store.
   *
   * Three ways in, and the ordering of the checks is the policy: exactly one
   * source, or the op is refused with the name of the field that would have
   * worked. Refusing-and-teaching rather than guessing, because a publish that
   * silently picked one of two given bodies would produce an immutable version
   * whose provenance nobody can reconstruct.
   *
   * The reason these exist at all is a cost the mesh was paying invisibly.
   * `content` is emitted by the model, and output tokens are the most expensive
   * thing a mission buys. On the mission this was measured against, 44 inline
   * publishes carried 1.18M characters — about 17% of everything written — and
   * most of it already existed as a file the runtime could have read for free,
   * or as a previous version the new one re-typed in full.
   */
  private async resolveArtifactBody(
    actorId: string,
    op: { content?: string; fromPath?: string; edits?: ArtifactEdit[]; asVersionOf?: string },
  ): Promise<{ content: string } | { error: string }> {
    const given = [
      op.content !== undefined ? "content" : undefined,
      op.fromPath !== undefined ? "fromPath" : undefined,
      op.edits !== undefined ? "edits" : undefined,
    ].filter((v): v is string => v !== undefined);
    if (given.length > 1) {
      return { error: `give exactly one of content, fromPath or edits — got ${given.join(" and ")}` };
    }
    if (given.length === 0) {
      return { error: "no body: give content (inline), fromPath (a file in your workspace) or edits (changes to asVersionOf)" };
    }

    if (op.fromPath !== undefined) return this.readArtifactBodyFromPath(actorId, op.fromPath);
    if (op.edits !== undefined) return this.applyArtifactEdits(op.edits, op.asVersionOf);

    const content = String(op.content ?? "");
    // The read side has had a ceiling since the day an agent could flood its own
    // window with one `read_artifact`; the write side had none, and one measured
    // publish arrived at 106,021 characters. Refuse rather than truncate: a
    // truncated artifact is a corrupt document that still digests, versions and
    // passes gates, which is worse than no artifact at all. The refusal names
    // the two cheap ways out, because a model that just spent 26k output tokens
    // on a body needs to be told where those tokens should have gone.
    if (content.length > ARTIFACT_PUBLISH_MAX_CHARS) {
      return {
        error:
          `inline content is ${content.length} chars, over the ${ARTIFACT_PUBLISH_MAX_CHARS} limit. ` +
          `Write the document to a file in your workspace and publish with fromPath, ` +
          `or if this revises an existing artifact, send edits with asVersionOf instead of the whole body.`,
      };
    }
    return { content };
  }

  /**
   * Read a publish body off disk.
   *
   * Anchored on {@link agentWorkspace} — the same directory the seat's own
   * Write/Edit tools land in — so "publish what I just wrote" is one relative
   * path and nothing else in the filesystem is reachable. The containment check
   * is done on the resolved real path, not the string, because `../` and a
   * symlink out of the worktree are the same escape wearing two hats.
   */
  private async readArtifactBodyFromPath(actorId: string, fromPath: string): Promise<{ content: string } | { error: string }> {
    const root = await this.agentWorkspace(actorId);
    const rootReal = await fs.promises.realpath(root).catch(() => path.resolve(root));
    const abs = path.resolve(rootReal, fromPath);
    const real = await fs.promises.realpath(abs).catch(() => abs);
    const rel = path.relative(rootReal, real);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return { error: `fromPath '${fromPath}' resolves outside your workspace — publish a file you wrote, using a path relative to your workspace root` };
    }
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(real);
    } catch {
      return { error: `fromPath '${fromPath}' does not exist in your workspace (looked in ${rootReal})` };
    }
    if (!stat.isFile()) {
      return { error: `fromPath '${fromPath}' is not a file` };
    }
    // Same ceiling as inline, for a different reason: the bytes are free to
    // publish but not free to read back — `read_artifact` pages at 60k, and a
    // 10MB file would page for forty turns. The limit is generous enough that
    // any hand-written document clears it; what it stops is a seat publishing
    // a build output or a log by accident.
    if (stat.size > ARTIFACT_PUBLISH_MAX_BYTES) {
      return { error: `fromPath '${fromPath}' is ${stat.size} bytes, over the ${ARTIFACT_PUBLISH_MAX_BYTES} limit for a published artifact` };
    }
    const content = await fs.promises.readFile(real, "utf8");
    return { content };
  }

  /**
   * Apply exact replacements to the previous version of an artifact.
   *
   * The same contract as the Edit tool a seat already knows: each `old` must
   * appear exactly once, and if any one of them does not, nothing is written.
   * All-or-nothing matters more here than in a working file — an artifact
   * version is immutable and gets cited as evidence, so a half-applied revision
   * would be a document that claims to say something it does not.
   */
  private async applyArtifactEdits(edits: ArtifactEdit[], asVersionOf?: string): Promise<{ content: string } | { error: string }> {
    if (!asVersionOf) {
      return { error: "edits need asVersionOf: they are changes to a specific previous version, so say which one" };
    }
    if (edits.length === 0) {
      return { error: "edits is empty — a version that changes nothing is not a version" };
    }
    const current = this.state.artifacts.get(asVersionOf);
    if (!current) return { error: `unknown artifact ${asVersionOf}` };
    let content = await this.deps.content.read(current.contentRef);
    for (const [i, edit] of edits.entries()) {
      const target = String(edit?.old ?? "");
      if (target.length === 0) {
        return { error: `edits[${i}].old is empty — give the exact text to replace` };
      }
      const first = content.indexOf(target);
      if (first === -1) {
        return { error: `edits[${i}].old not found in ${current.type}:${current.name} v${current.version} — read the artifact and quote it exactly` };
      }
      if (content.indexOf(target, first + target.length) !== -1) {
        return { error: `edits[${i}].old appears more than once in ${current.type}:${current.name} v${current.version} — include enough surrounding text to make it unique` };
      }
      content = content.slice(0, first) + String(edit?.new ?? "") + content.slice(first + target.length);
    }
    return { content };
  }

  // ------------------------------------------------------ tool approvals

  /**
   * Unlock a gated tool for a seat.
   *
   * The grant covers the tool for the rest of the session, not one call: a
   * refused tool call cannot be replayed — the model re-decides on its next
   * turn — so this is the only thing an approval can honestly mean, and the
   * operator surface says so rather than implying per-call review.
   *
   * Does not wake the agent. Granting and resuming are separate on purpose:
   * `POST /agents/:id/wake` already exists, and an operator reviewing several
   * requests should not restart the seat once per grant.
   *
   * False for an unknown agent, so the caller answers 404 instead of recording
   * a grant no seat will ever consume.
   */
  grantToolApproval(agentId: string, tool: string): boolean {
    if (!this.config.agents[agentId]) return false;
    const set = this.toolGrants.get(agentId) ?? new Set<string>();
    set.add(tool);
    this.toolGrants.set(agentId, set);
    // The seat is no longer blocked on this, so it stops being an outstanding
    // ask. A later revoke does not put it back: the seat has to reach for the
    // tool and be refused again before that is true of it once more.
    this.toolRequests.get(agentId)?.delete(tool);
    this.auditLine(`tool approval: ${agentId} granted ${tool}`);
    return true;
  }

  /** Withdraw a grant. The seat re-gates that tool from its next turn on. */
  revokeToolApproval(agentId: string, tool: string): boolean {
    const removed = this.toolGrants.get(agentId)?.delete(tool) ?? false;
    if (removed) this.auditLine(`tool approval: ${agentId} revoked ${tool}`);
    return removed;
  }

  /**
   * Gated seats, what has been unlocked on each, and what each has actually
   * been refused, for the operator surface.
   */
  listToolApprovals(): Array<{
    agentId: string;
    requiresApproval: string[];
    granted: string[];
    requested: string[];
  }> {
    return Object.values(this.config.agents)
      .filter((a) => (a.requiresApproval?.length ?? 0) > 0)
      .map((a) => ({
        agentId: a.id,
        requiresApproval: a.requiresApproval ?? [],
        granted: [...(this.toolGrants.get(a.id) ?? [])],
        requested: [...(this.toolRequests.get(a.id) ?? [])],
      }));
  }

  // ----------------------------------------------------------------- ops

  /**
   * The typed bus: one MCP tool call from a seat. While the seat has a turn in
   * flight the op runs against THAT turn, so its results, `wait`/`escalate`,
   * the handover guard and `done`'s summary all count exactly as they would
   * for an op the runtime returned. Between turns it runs against a detached
   * record that no end-of-turn logic reads.
   */
  async executeToolOp(agentId: string, op: MeshOp): Promise<OpResult> {
    const live = this.liveTurnByAgent.get(agentId);
    const turn: TurnState = live ?? {
      turnId: `mcp-${this.nowMs()}`,
      agentId,
      reason: { kind: "manual", note: "mcp call outside a turn" },
      sentOps: 0,
      publishedOps: 0,
      waitRequested: false,
      escalated: false,
      results: [],
    };
    const opStart = this.nowMs();
    // Between turns there is no tally, and an absent tally reads as "operator
    // or runtime-derived, verified by construction" -- but this call came from a
    // seat, e.g. a CLI finishing a call after the mesh settled its turn. Hold a
    // zero tally for the op's duration. Cleared only while still no turn is
    // live: a turn that started meanwhile owns the entry now.
    const detachedTally = !live && agentId !== HUMAN_AGENT_ID && !this.turnVerificationTools.has(agentId);
    if (detachedTally) this.turnVerificationTools.set(agentId, 0);
    let result: OpResult;
    try {
      result = await this.executeOp(agentId, op, turn);
    } finally {
      if (detachedTally && !this.liveTurnByAgent.has(agentId)) this.turnVerificationTools.delete(agentId);
    }
    if (live) {
      live.results.push(result);
      try {
        this.turns.noteOp(live.turnId, { op: String(op.op), ms: this.nowMs() - opStart, ok: result.ok, reason: result.reason });
      } catch {
        /* timing is observability: never let it affect the op */
      }
    }
    return result;
  }

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
          // Deliberately silent: no `denied()` call here. This guard refuses
          // before the policy layer runs, and `tests/policy/mission-freeze.ts`
          // asserts the rejection-event count does not move. The cost is that
          // a halted op is the one block in the system carrying no event — see
          // NOTES-blocking-reasons-survey.md, which wants it surfaced. Those
          // two wants are in conflict; do not resolve it by editing either
          // side without deciding what an MCP client hammering ops should
          // produce (the scheduler's `lastRefusal`/`reportedRefusal` dedupe is
          // the shape that would satisfy both).
          if (!allowed.has(op.op)) return { ok: false, op: op.op, reason: haltReasonText(halted) };
        }
      }
    }
    // A handover turn is spent, in full, on the record. Refused OUT LOUD,
    // unlike the halt guard above: the seat asked for this turn no more than
    // the mission did, so a bare silent no-op would read to the model as the
    // op having worked.
    if (turn.handover && !HANDOVER_ALLOW_OPS.has(op.op)) {
      return {
        ok: false,
        op: op.op,
        reason: "this turn is a handover: your session is about to be replaced. Call write_continuity, then done. Whatever else you were doing, the session that replaces you will pick up from what you write.",
      };
    }
    // Plan gate. Off by default and for the human seat; see HardActionsPolicy.
    // Deliberately placed after the halt guard and before every op handler, so
    // one check covers the typed (MCP) bus and the prose path alike.
    if (actorId !== HUMAN_AGENT_ID) {
      const rec = this.state.agents.get(actorId);
      const hard = rec ? effectiveHardActions(rec.definition.hardActions) : undefined;
      if (rec && hard && hard.mode !== "off") {
        const miss = planCoversHardOp(op, rec.definition, rec.state);
        if (miss) {
          // Emitted in BOTH modes: `warn` exists so an operator can see what
          // `enforce` would have blocked before turning it on, which only
          // works if the near-miss is on the log.
          await this.deps.kernel.emit(
            "plan.gate_rejected",
            { agentId: actorId, op: op.op, taskId: rec.state.activeTaskId, mode: hard.mode, reason: miss },
            { actorId },
          );
          if (hard.mode === "enforce") return { ok: false, op: op.op, reason: `${PLAN_GATE_PREFIX} ${miss}` };
        }
      }
    }
    /**
     * A default with no clock behind it is a lie the asker cannot detect.
     *
     * `computeDueBy` returns nothing at all unless the mesh configured
     * `bus.commitments.ttl_ms` -- a contract's `slaMs` narrows a regime and
     * never creates one -- so on a mesh with no deadline regime an ask
     * carrying `ifUnanswered` and no `afterMs` would be accepted, recorded,
     * and then sit open forever while the asker believed it had an answer
     * coming at a known time. Refused here instead, at the one moment the
     * seat is listening, and the refusal names all three ways out.
     */
    const undated = this.undatedDefault(op);
    if (undated) return { ok: false, op: op.op, reason: undated };
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
            note: op.note,
            priority: op.priority,
            taskId: op.taskId,
            requires: op.requires,
            budgetHint: op.budgetHint,
          }, { control: askControl(op) });
          turn.sentOps++;
          // `reason` on an accepted send is a caveat (see `sendMessage`), carried
          // so it reaches the seat's tool result and its turn summary.
          //
          // A held send is `ok` and carries no `messageId`, which is exactly the
          // pair that makes a seat resend unless the result says otherwise:
          // `reason` says it (the notice), `caveat` puts it in the turn summary,
          // and `merged` makes the fact machine-readable for mcp.ts and for the
          // tests that pin this.
          return res.accepted
            ? {
                ok: true,
                op: op.op,
                messageId: res.messageId,
                eventId: res.eventId,
                deliveryDowngraded: res.deliveryDowngraded,
                ...(res.merged ? { merged: true } : {}),
                ...(res.reason ? { reason: res.reason, caveat: true } : {}),
              }
            : { ok: false, op: op.op, reason: res.reason };
        }
        case "broadcast": {
          const targets = [...this.state.agents.keys()].filter((id) => id !== actorId && id !== HUMAN_AGENT_ID);
          const res = await this.sendMessage(
            { from: actorId, to: targets, type: op.type, newThread: { subject: `broadcast ${op.type}` }, payload: op.payload, note: op.note, artifactRefs: op.artifactRefs },
            // Stamped by the runtime, not the agent, because three separate
            // behaviours key off it and all three must be unforgeable: the
            // reducer opens no commitment for a broadcast, `sendMessage`
            // refuses replies to one, and the scheduler wakes only the seats
            // that declared an interest instead of the whole roster.
            { control: { mode: "broadcast" } },
          );
          turn.sentOps++;
          return res.accepted ? { ok: true, op: op.op, messageId: res.messageId, deliveryDowngraded: res.deliveryDowngraded, ...(res.reason ? { reason: res.reason, caveat: true } : {}) } : { ok: false, op: op.op, reason: res.reason };
        }
        case "collab": {
          const peers = [...new Set(op.with ?? [])].filter((id) => id !== actorId && id !== HUMAN_AGENT_ID);
          if (peers.length === 0) return { ok: false, op: op.op, reason: "collab needs at least one other participant" };
          const topic = (op.topic ?? "").trim();
          if (!topic) return { ok: false, op: op.op, reason: "collab needs a topic (it names the box on the overrun card)" };
          const box = this.config.bus.collab;
          // Clamp, never widen. An agent may shorten its own leash — that is
          // a useful thing to let it do — but a box an agent could lengthen
          // is not a box, and this op is the one place a request for more
          // room would arrive.
          const boxMs = Math.max(1, Math.min(op.boxMs && op.boxMs > 0 ? op.boxMs : box.boxMs, box.boxMs));
          const maxExchanges = Math.max(
            1,
            Math.min(op.maxExchanges && op.maxExchanges > 0 ? op.maxExchanges : box.maxExchanges, box.maxExchanges),
          );
          const res = await this.sendMessage(
            { from: actorId, to: peers, type: "INFORM", newThread: { subject: `collab: ${topic}` }, payload: op.payload ?? { topic }, artifactRefs: op.artifactRefs },
            { control: { mode: "collab" } },
          );
          if (!res.accepted) return { ok: false, op: op.op, reason: res.reason };
          turn.sentOps++;
          const opened = this.state.messages.get(res.messageId!);
          const threadId = opened!.threadId;
          const openedAt = this.deps.kernel.clock.iso();
          const session: CollabSession = {
            threadId,
            goalId: this.state.activeGoalId ?? undefined,
            openedBy: actorId,
            participants: [actorId, ...peers],
            topic,
            openedAt,
            // Computed HERE and carried in the event, not derived at sweep
            // time: a mesh that edits `bus.collab` mid-mission must not
            // retroactively move the edge of a session already running, and a
            // replay has to reproduce the expiry the live run actually used.
            expiresAt: new Date(Date.parse(openedAt) + boxMs).toISOString(),
            maxExchanges,
            // The opening message is the OPEN, not an exchange — the session
            // does not exist when the reducer sees it, so it is not metered,
            // and that is the intended reading.
            exchanges: 0,
            budgetKey: this.state.activeGoalId ? `thread:${this.state.activeGoalId}/${threadId}` : undefined,
            status: "OPEN",
          };
          await this.deps.kernel.emit("collab.opened", { session }, { actorId, goalId: session.goalId });
          return { ok: true, op: op.op, messageId: res.messageId, threadId };
        }
        case "close_collab": {
          const cs = this.state.collabSessions.get(op.threadId as never);
          if (!cs) return { ok: false, op: op.op, reason: `no collab session on thread ${op.threadId}` };
          if (cs.status !== "OPEN") return { ok: false, op: op.op, reason: `collab on ${op.threadId} already ${cs.status.toLowerCase()}` };
          if (!cs.participants.includes(actorId)) return { ok: false, op: op.op, reason: "only a participant may close a collab" };
          await this.deps.kernel.emit(
            "collab.closed",
            { threadId: cs.threadId, reason: "closed", closedBy: actorId, outcome: op.outcome, exchanges: cs.exchanges, maxExchanges: cs.maxExchanges },
            { actorId, goalId: cs.goalId },
          );
          return { ok: true, op: op.op, threadId: cs.threadId };
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
          }, { control: askControl(op) });
          turn.sentOps++;
          return res.accepted ? { ok: true, op: op.op, messageId: res.messageId, deliveryDowngraded: res.deliveryDowngraded } : { ok: false, op: op.op, reason: res.reason };
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
          return res.accepted ? { ok: true, op: op.op, messageId: res.messageId, deliveryDowngraded: res.deliveryDowngraded, ...(res.reason ? { reason: res.reason, caveat: true } : {}) } : { ok: false, op: op.op, reason: res.reason };
        }
        case "withdraw":
          return this.opWithdraw(actorId, op, turn);
        case "discharge": {
          const pending = this.state.pendingRequests.get(op.messageId);
          if (!pending) return { ok: false, op: op.op, reason: this.notOutstanding(op.messageId) };
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
          /**
           * The refusal KIND, checked at the edge against the ask's own contract.
           *
           * `refusals` has been a declared closed set since contracts shipped and
           * was read by nothing: a debtor said no in prose and the asker had to
           * interpret the sentence to tell "wrong seat" from "bad ask" from "I
           * disagree" -- the three cases the set was introduced to separate.
           * Checking it here rather than at discharge-inference time keeps the
           * judgement out of the reducer: an invalid kind is refused before any
           * event exists, exactly as a malformed `request` is, and the refusal
           * names the legitimate ones so the next attempt is informed.
           *
           * Fail-open in every direction that is not a wrong name. No `refusal`
           * at all is the old behaviour and stays legal -- prose still settles an
           * ask. An ask with no contract, or a contract declaring an empty set
           * (`decision.escalate`, which no peer answers), has nothing to check
           * against and is accepted as given.
           */
          const askContract = pending.contract ? findContract(pending.contract) : undefined;
          const refusal = op.refusal?.trim() || undefined;
          if (refusal && askContract?.refusals.length && !askContract.refusals.includes(refusal)) {
            return {
              ok: false,
              op: op.op,
              reason: `'${refusal}' is not a refusal ${askContract.name} admits. Use one of: ${askContract.refusals.join(", ")}. Keep 'reason' for your own words — the asker reads both.`,
            };
          }
          // Close FIRST, then notify. The order matters and it used to be the
          // other way round, which made the decline unrecordable: the notice
          // carries `replyTo`, so the reducer discharged the ask as `reply`
          // the moment the notice was logged, and the explicit discharge below
          // then found nothing pending and silently did nothing. A refusal was
          // therefore indistinguishable from an answer in the ledger, and the
          // `declined: true` detail never reached the log at all.
          //
          // The asker is not left hanging by the reorder: `dischargeCommitment`
          // wakes it with a reason of its own before this returns, and the
          // notice below follows with the agent's own words.
          const closed = await this.dischargeCommitment(op.messageId, "refused", actorId, {
            declined: true,
            note: op.reason,
            ...(refusal ? { refusal } : {}),
          });
          if (!closed) {
            // The discharge event did not reach the log, so the ask is still
            // open. Say so rather than sending a notice that claims otherwise.
            return { ok: false, op: op.op, reason: `could not close '${op.messageId}' — it is still open` };
          }
          const notice = await this.sendMessage({
            from: actorId,
            to: [pending.from],
            type: "INFORM",
            threadId: this.state.threads.has(pending.threadId) ? pending.threadId : undefined,
            newThread: this.state.threads.has(pending.threadId) ? undefined : { subject: `cannot answer ${op.messageId}` },
            replyTo: this.state.messages.has(op.messageId) ? op.messageId : undefined,
            // `refusal` rides the notice as data, which is the whole point: the
            // asker can act on the KIND without parsing the sentence beside it.
            payload: { declined: true, request: op.messageId, reason: op.reason, ...(refusal ? { refusal } : {}) },
            priority: "HIGH",
          });
          turn.sentOps++;
          return { ok: true, op: op.op, messageId: notice.messageId, reason: op.reason };
        }
        case "publish_artifact": {
          const body = await this.resolveArtifactBody(actorId, op);
          if ("error" in body) return { ok: false, op: op.op, reason: body.error };
          // Asked before the publish, while the version this turn created is
          // still the current one. See `amendableDraft` for the rule.
          const amend = this.amendableDraft(actorId, op.asVersionOf, op.status, turn);
          const res = await this.createArtifact({
            actorId,
            name: op.name,
            type: op.type,
            content: body.content,
            status: op.status,
            scope: op.scope,
            metadata: op.metadata,
            parentArtifactId: op.parentArtifactId,
            asVersionOf: op.asVersionOf,
            amend: amend !== undefined,
            inputs: this.inputsReadThisTurn(actorId, turn, op.asVersionOf),
          });
          if ("error" in res) return { ok: false, op: op.op, reason: res.error };
          turn.publishedOps++;
          (turn.publishedIds ?? (turn.publishedIds = [])).push(res.artifact.id);
          this.notePublishedThisTurn(actorId, res.artifact, turn);
          const amended = amend !== undefined && res.artifact.version === amend.version
            ? `amended v${amend.version} in place: it was still an unreviewed DRAFT this turn created, so no new version was made`
            : undefined;
          const reason = [amended, res.notice].filter(Boolean).join("; ") || undefined;
          return { ok: true, op: op.op, artifactId: res.artifact.id, artifactUri: res.uri, artifact: res.artifact, ...(reason ? { reason, caveat: true } : {}) };
        }
        case "read_artifact": {
          const a = this.findArtifactByUri(op.artifactRef);
          if (!a) return { ok: false, op: op.op, reason: "unknown artifact ref" };
          this.noteArtifactRead(actorId, a, turn);
          const content = await this.deps.content.read(a.contentRef);
          // Refs keep artifacts OUT of the assembled prompt, but a read put the
          // whole document back in with no ceiling — the one path by which an
          // agent could flood its own window from inside a turn. Slice it, and
          // say so, so a partial read is a fact the agent holds rather than an
          // absence it cannot detect.
          const offset = Math.max(0, Math.floor(op.offset ?? 0));
          // One character past the ceiling, so `pageCut` can tell "the rest fits" from
          // "there is more": it cuts at a line, not mid-token, only when there is more.
          const window = content.slice(offset, offset + ARTIFACT_READ_MAX_CHARS + 1);
          const slice = window.slice(0, pageCut(window, ARTIFACT_READ_MAX_CHARS));
          const end = offset + slice.length;
          if (end < content.length) {
            return {
              ok: true,
              op: op.op,
              reason: slice,
              truncated: true,
              nextOffset: end,
              totalChars: content.length,
            };
          }
          return { ok: true, op: op.op, reason: slice, totalChars: content.length };
        }
        case "transition_artifact": {
          const targetId = this.resolveArtifactRef(op.artifactId, op.artifactUri);
          if (!targetId) return { ok: false, op: op.op, reason: `unknown artifact ${op.artifactId ?? op.artifactUri}` };
          // MERGED is not a status a seat may simply declare.
          //
          // `opMerge` was hardened to land the change before recording it, so a
          // failed git merge leaves the patch MERGEABLE. This op bypassed all of
          // that: it reaches `transitionArtifact` directly, MERGEABLE -> MERGED is
          // a legal edge, the only gate is holding `git.merge`, and
          // `mirrorTransition` then emits `patch.merged` AND
          // `implementation.completed` keyed on type+status alone -- with no git
          // step anywhere on the path.
          //
          // A live run on 2026-09-24 did exactly this at 08:48:50 and again later:
          // architect emitted the bare transition, both mirror events landed, and
          // `workspace/main` never moved off its init commit while 1,847 lines sat
          // uncommitted in the seat's worktree. The seat's own comment read "Merge
          // handoff from tech-lead... tests green" -- it believed it had merged,
          // and every downstream seat reading the log would have too.
          //
          // Refused here rather than in `transitionArtifact` deliberately: this op
          // is the only path a seat can reach, so guarding it leaves `opMerge`'s
          // own internal transition (and the two READY_FOR_REVIEW callers) working
          // untouched.
          if (op.to === "MERGED") {
            const reason =
              "a patch becomes MERGED by MERGING it, not by declaring it: use \`mesh_merge\` so the change actually lands on the product branch. " +
              "A bare transition would emit patch.merged and implementation.completed with nothing committed, and implementation-merged would stay UNEVIDENCED.";
            await this.denied(actorId, targetId, `transition -> ${op.to}`, {
              decision: "DENY",
              reason,
              ruleId: "merge.requires-merge-op",
            });
            return { ok: false, op: op.op, reason };
          }
          const res = await this.transitionArtifact(actorId, targetId, { to: op.to, comment: op.evidence });
          return { ok: res.ok, op: op.op, reason: res.reason, eventId: res.eventId };
        }
        case "request_review": {
          // Same-turn publish → review: the model's URI guess didn't resolve, but it just
          // published something — reviewing that is the intent (`reviewTarget`).
          const a = this.reviewTarget(op.artifactId, op.artifactUri, turn);
          if (!a) return { ok: false, op: op.op, reason: `unknown artifact ${op.artifactId ?? op.artifactUri ?? "(none given)"}` };
          // Can the seats being asked actually produce a verdict that MOVES this?
          //
          // The predicate is `approverMayAdvance`, not `canReviewArtifactType`.
          // The latter is narrower than what `recordDecision` accepts and would
          // refuse the cross-domain `<role>.approve` signatures the whole gate
          // system rests on — a seat signing `subject: "quality"` on a design
          // artifact is legitimate and its own role prompt may instruct it. What the
          // asker actually needs to know is whether a verdict from this seat can
          // settle the artifact, and that is the same question the reducer asks.
          //
          // Measured: 3 of 5 review requests in one live run named a reviewer who
          // could not deliver a binding verdict. Nothing refused them, so threads
          // opened, the seats were woken, and their verdicts could never count. Each
          // paired a capable reviewer with an incapable one, which is why the waste
          // was survivable and therefore invisible.
          //
          // The artifact's OWNER counts only when no peer could review it, the
          // same carve-out `evaluateTransition`'s `self-approval` rule makes. The
          // owner usually holds the domain's approve authority (the architect on
          // its own ArchitectureDocument), so `approverMayAdvance` alone said yes,
          // the ask was accepted, and the owner could only discharge it: "I cannot
          // review my own work" (cronlite 2026-09-30). The remedy list below
          // already left the owner out; the acceptance now agrees with it.
          const canSettle = op.reviewers.filter((r) => mayReviewArtifact(this.state, r, a, HUMAN_AGENT_ID));
          const cannotSettle = op.reviewers.filter((r) => !canSettle.includes(r));
          if (canSettle.length === 0) {
            const able = [...this.state.agents.values()]
              .map((rec) => rec.definition.id)
              .filter((id) => id !== HUMAN_AGENT_ID && id !== a.owner && approverMayAdvance(this.state, id, a, HUMAN_AGENT_ID));
            const remedy = able.length > 0 ? ` — ${able.join(", ")} can` : ` — no seat in this mesh can`;
            const ownerNote = cannotSettle.includes(a.owner) ? ` (${a.owner} owns it and cannot review their own work)` : "";
            const reason = `none of ${op.reviewers.join(", ")} can deliver a verdict on this ${a.type}${remedy}${ownerNote}`;
            await this.denied(actorId, a.id, "request review", { decision: "DENY", reason, ruleId: "review.reviewer-cannot-settle" });
            return { ok: false, op: op.op, reason };
          }
          // Asking for a review is a SEND, not a review, so the asker's own
          // capabilities do not gate it. `capabilityForReview` used to be
          // applied here to the REQUESTER — the wrong party twice over: it
          // refused authors who merely wanted their work looked at, and it is
          // the same table the approve path uses as a widener for the APPROVER
          // (:2993).
          //
          // NOTE the comment that stood here claimed "policy screens that side in
          // `sendMessage` below". That was false: `evaluateMessage` checks sender
          // registration and the contact matrix and never inspects a recipient's
          // review capability or the artifact type. The screen above is that check.
          //
          // Worse, it refused nothing. With no `return`, the denial was pure
          // telemetry and the transition, the message, `review.requested` and
          // `design.question` all still ran. A refused ask therefore left the
          // artifact sitting in READY_FOR_REVIEW, which is an approvable state.
          //
          // `sendMessageCapability` is the sender-side gate this op was meant
          // to have (`request_review`, which repository.read confers) and it is
          // deliberately still not wired in: it has never run in production,
          // and a seat holding review.design without repository.read is valid
          // config today, so switching it on would refuse asks that work now.
          // That is a separate decision from fixing the wrong-party check.
          //
          // Order matters instead. The send goes first; the artifact moves only
          // once the ask is actually accepted, so a refusal — for any reason,
          // policy or protocol — leaves no state behind for someone else to
          // approve.
          //
          // Addressed to the seats that CAN settle it, and only those. A mixed
          // list used to keep every name on `to`, so a seat whose verdict could
          // never count still owed one: frontend was on 6 design reviews in the
          // 2026-09-25 run, each an open debt and a wake. Dropped rather than made
          // comment-only, because a per-recipient non-obliging ask has no
          // envelope field and no ledger support, and a second FYI message would
          // still spend the seat's attention on an ask it cannot close. The asker
          // is told who was dropped (below) and can share the artifact with them
          // by announcement if it wants their comments.
          const res = await this.sendMessage({
            from: actorId,
            to: canSettle,
            type: "REQUEST_REVIEW",
            newThread: { subject: `review ${a.name}`, artifactRefs: [{ uri: artifactUri(a.type, a.name, a.version) }] },
            artifactRefs: [{ uri: artifactUri(a.type, a.name, a.version) }],
            payload: { question: `Review ${a.type} ${a.name} v${a.version}` },
          }, { control: askControl(op) });
          if (!res.accepted) return { ok: false, op: op.op, reason: res.reason };
          turn.sentOps++;
          // Move it only if the send did not already do so.
          //
          // `sendMessage` runs `deriveSemantic`, which emits `review.requested`,
          // whose reducer walks DRAFT -> READY_FOR_REVIEW -> UNDER_REVIEW. So by
          // the time the send returns, the artifact is normally ALREADY in
          // review — and re-asserting READY_FOR_REVIEW here pulled it back OUT
          // of UNDER_REVIEW. That is a legal transition, so it happened
          // silently: the artifact looked fine, sat one step short of
          // reviewable, and every later approval of it was inert.
          //
          // The explicit transition is still needed for the case the reducer
          // cannot serve: an event whose artifact ref does not resolve, where
          // nothing else moves it off DRAFT.
          const afterSend = this.state.artifacts.get(a.id);
          if (afterSend && afterSend.status === "DRAFT") {
            const tr = await this.transitionArtifact(actorId, a.id, { to: "READY_FOR_REVIEW" });
            if (!tr.ok && tr.reason && !tr.reason.includes("illegal")) return { ok: false, op: op.op, reason: tr.reason };
          }
          // Some, but not all, of the named reviewers can settle it. The ask stands
          // — a capable reviewer is on it — but the asker is told, through the same
          // caveat channel an inert approval uses, which seats it named were left
          // off the ask and why. This reaches the seat's tool result (the MCP
          // bridge's `note`) and its next context via `endSummary` → `rememberMemory`.
          const partialRaw =
            cannotSettle.length > 0
              ? `${cannotSettle.join(", ")} cannot deliver a verdict on this ${a.type} — ${canSettle.join(", ")} can, so the ask stands with them; ` +
                `${cannotSettle.join(", ")} ${cannotSettle.length === 1 ? "was" : "were"} left off it and owe${cannotSettle.length === 1 ? "s" : ""} nothing` +
                (cannotSettle.includes(a.owner) ? ` (${a.owner} owns it and cannot review their own work)` : "")
              : undefined;
          // Both are things the asker needs to hear about an ask that DID go out.
          const partial = [partialRaw, await this.unrecordedPatchCaveat(a)].filter((x): x is string => !!x).join("; ") || undefined;
          return { ok: true, op: op.op, reason: partial, ...(partial ? { caveat: true } : {}), messageId: res.messageId, deliveryDowngraded: res.deliveryDowngraded };
        }
        // `?? op.artifactUri`: a URI-only verdict that resolves to nothing must
        // reach `recordDecision` as the unknown ref it is, where it is refused.
        // Dropped to undefined, it recorded as a subject-level verdict with no
        // artifact, which `checkApprovals` then counts against EVERY artifact.
        //
        // An accepted verdict's `reason` is always a caveat — inert, repeated,
        // or a criterion that landed ASSERTED — never data.
        case "approve": {
          const res = await this.recordDecision(actorId, op.kind === "pass" ? "pass" : "approve", op.subject, this.resolveArtifactRef(op.artifactId, op.artifactUri) ?? op.artifactUri, op.comment, op.artifactUri);
          return { ok: res.ok, op: op.op, reason: res.reason, ...(res.ok && res.reason ? { caveat: true } : {}), eventId: res.eventId };
        }
        case "reject": {
          const res = await this.recordDecision(actorId, "reject", op.subject, this.resolveArtifactRef(op.artifactId, op.artifactUri) ?? op.artifactUri, op.comment, op.artifactUri);
          return { ok: res.ok, op: op.op, reason: res.reason, ...(res.ok && res.reason ? { caveat: true } : {}), eventId: res.eventId };
        }
        case "veto": {
          const res = await this.recordDecision(actorId, "veto", op.subject, this.resolveArtifactRef(op.artifactId, op.artifactUri) ?? op.artifactUri, op.comment, op.artifactUri);
          return { ok: res.ok, op: op.op, reason: res.reason, ...(res.ok && res.reason ? { caveat: true } : {}), eventId: res.eventId };
        }
        case "block": {
          const res = await this.recordDecision(actorId, "block", op.subject, this.resolveArtifactRef(op.artifactId, op.artifactUri) ?? op.artifactUri, op.reason, op.artifactUri);
          return { ok: res.ok, op: op.op, reason: res.reason, eventId: res.eventId };
        }
        case "delegate": {
          return this.opDelegate(actorId, op, turn);
        }
        case "create_task": {
          if (!String(op.title ?? "").trim()) return { ok: false, op: op.op, reason: "create_task requires a non-empty title" };
          const unknownCaps = this.unknownTaskCapabilities(op.requiredCapabilities);
          if (unknownCaps.length > 0) {
            return { ok: false, op: op.op, reason: `task requires capability the runtime can never match: ${unknownCaps.join(", ")} (known: ${CAPABILITY_TOKENS.join(", ")})` };
          }
          const dupe = this.openTaskWithTitle(op.title);
          if (dupe) {
            return { ok: false, op: op.op, reason: `"${op.title}" is already open as ${dupe.id} (${dupe.status}) — claim that one instead of filing a second; if it is genuinely different work, give it a title that says how` };
          }
          const deps = this.taskDependencies(op.dependsOn);
          if ("error" in deps) return { ok: false, op: op.op, reason: deps.error };
          const task = this.newTask(actorId, op.title, op.description, op.requiredCapabilities, op.artifactRefs, undefined, op.budgetHint, deps.ids);
          await this.emitTaskCreated(task);
          if (op.assignedTo) {
            // The payload carries the task's CONTENT, not just its id. A DELEGATE
            // whose whole body is `{taskId}` hands the recipient an opaque handle
            // and no instruction: it must go and look the task up to learn what it
            // was asked to do, and it cannot see the capabilities the task demands
            // until it tries to claim it and is refused. `opDelegate` already sent
            // the richer shape; this path — which is what a seat actually uses when
            // it creates work and names an owner in one op — did not.
            await this.sendMessage({
              from: actorId,
              to: [op.assignedTo],
              type: "DELEGATE",
              newThread: { subject: `task ${task.id}: ${task.title}` },
              payload: {
                taskId: task.id,
                title: task.title,
                description: task.description,
                requiredCapabilities: task.requiredCapabilities,
                // The assignee cannot claim it before these complete, so it is told up front.
                ...(task.dependsOn?.length ? { dependsOn: task.dependsOn } : {}),
              },
              taskId: task.id,
            });
            turn.sentOps++;
          }
          // Cut from a version that is already behind: the task is filed (the
          // author may mean it), and the author is told while it can still fix it.
          const behind = staleTaskPins(this.state, task);
          return behind.length > 0
            ? { ok: true, op: op.op, taskId: task.id, reason: `task filed, but it cites ${behind.join(", ")} — the newer version may change what this task should say`, caveat: true }
            : { ok: true, op: op.op, taskId: task.id };
        }
        case "claim_task": {
          const res = await this.claimTask(actorId, op.taskId);
          // An accepted claim's reason is the stale-pin caveat, never data.
          return { ok: res.ok, op: op.op, reason: res.reason, ...(res.ok && res.reason ? { caveat: true } : {}) };
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
          // `reason` stays the decision id: it is the op's product, returned to
          // the seat as `decisionId`. Where the proposal went is on the log (the
          // ratification ask, whose id is `messageId`) and in the proposer's
          // own open loops from its next turn on.
          if (d.askId) turn.sentOps++;
          else this.auditLine(`decision ${d.id} by ${actorId}: ${d.routing}`);
          return { ok: true, op: op.op, reason: d.id, ...(d.askId ? { messageId: d.askId } : {}) };
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
          // Never on a handover: that turn's `done` closes a continuity record,
          // not the task. seq 1023 of 2026-09-25 completed frontend's task off a
          // turn whose only ops were write_continuity + done, with the patch
          // unreviewed and later rejected (NOTES-live-run-20260925-2040.md §7).
          const task = turn.handover ? undefined : this.state.agents.get(actorId)?.state.activeTaskId;
          if (task) {
            const t = this.state.tasks.get(task);
            if (t && (t.status === "CLAIMED" || t.status === "IN_PROGRESS")) {
              await this.completeTask(actorId, task, op.summary ?? "done");
            }
          }
          if (typeof op.summary === "string" && op.summary.trim()) turn.declaredSummary = op.summary.trim();
          return { ok: true, op: op.op };
        }
        case "remember": {
          await this.rememberMemory(actorId, op.key, op.value);
          return { ok: true, op: op.op };
        }
        case "write_continuity": {
          const res = await this.writeContinuity(actorId, op);
          // The record IS a handover turn's work. Ending the turn here saves the
          // model calls that would follow — `done`, then a reply — each
          // re-sending the outgoing session's whole transcript (§1).
          if (res.ok && turn.handover) {
            turn.declaredSummary ??= "continuity written for the session handover";
            const sess = this.sessions.get(actorId);
            if (sess?.runtime.endTurn) void sess.runtime.endTurn(sess.session).catch(() => undefined);
          }
          return res;
        }
        case "contracts": {
          return this.listContracts(actorId, op);
        }
        case "call": {
          return this.callContract(actorId, op, turn);
        }
        case "plan": {
          return this.updatePlan(actorId, op.steps ?? [], op.taskId);
        }
        case "plan_step": {
          return this.updatePlanStep(actorId, op.stepId, op.status);
        }
        // `acquire_lease` and `commit` resolve an `artifact://` URI or a name the
        // way `transition_artifact` and `merge` already do. Id-only meant a seat
        // could not publish a patch and commit it in the same turn -- it does
        // not learn the new id until its next one -- so the natural
        // publish -> lease -> commit sequence could not be written at all.
        case "acquire_lease": {
          return this.opAcquireLease(actorId, this.resolveArtifactRef(op.artifactId) ?? op.artifactId, op.files);
        }
        case "release_lease": {
          return this.opReleaseLease(actorId, this.resolveArtifactRef(op.artifactId) ?? op.artifactId);
        }
        case "commit": {
          return this.opCommit(actorId, this.resolveArtifactRef(op.artifactId) ?? op.artifactId, op.message, op.files);
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
          return res.accepted ? { ok: true, op: op.op, messageId: res.messageId, deliveryDowngraded: res.deliveryDowngraded } : { ok: false, op: op.op, reason: res.reason };
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

  /**
   * Capability tokens a task is allowed to require.
   *
   * Config load REJECTS an unknown capability on an agent, because an operator
   * wrote it and can fix it before the mesh boots. A task's list is written by
   * a model, mid-mission, and there is no load moment to throw at — so an
   * invented token used to produce a task that nobody could ever claim and a
   * `capabilities` denial on every attempt, naming a token the roster
   * genuinely did not contain. Nothing anywhere said the token was not real.
   *
   * Refuse it to the author instead, while the author is still there to pick
   * another. `implementation.gate` is admitted deliberately: it is not a
   * capability any seat holds but a marker `completeTask` reads, and dropping
   * it here would make that gate unreachable.
   */
  private unknownTaskCapabilities(raw?: string[]): string[] {
    const known = new Set([...CAPABILITY_TOKENS, IMPLEMENTATION_GATE_MARKER]);
    return (raw ?? [])
      .map((c) => normalizeCapability(String(c)))
      .filter((c) => !known.has(c));
  }

  /**
   * An open task in this goal already carrying this title, if there is one.
   *
   * Three seats independently opened a task for the same work within three
   * minutes in a live mission — same title, three task ids, two of them never
   * claimed — because nothing compared a new task against the board. A seat
   * that sees work is undone and files it has no way to learn that a peer
   * filed it too; the four subscribers to `task.created` are told, but only on
   * a turn, which is minutes after the duplicate was written.
   *
   * Scoped to the goal, and blind to COMPLETED and CANCELLED: re-doing work
   * that was finished or abandoned is legitimate, and a second goal is a
   * different mission.
   *
   * Compared case- and whitespace-insensitively, because the titles come from
   * a model and "T3.1 UI flows" and "t3.1  ui flows" are the same work.
   */
  private openTaskWithTitle(title: string): Task | undefined {
    const key = String(title ?? "").trim().toLowerCase().replace(/\s+/g, " ");
    if (!key) return undefined;
    const goalId = this.state.activeGoalId;
    for (const t of this.state.tasks.values()) {
      if (goalId && t.goalId !== goalId) continue;
      if (t.status === "COMPLETED" || t.status === "CANCELLED") continue;
      if (t.title.trim().toLowerCase().replace(/\s+/g, " ") === key) return t;
    }
    return undefined;
  }

  /**
   * A new task's `dependsOn`, checked against the board.
   *
   * Every id must name a task of this goal that exists now. That is also what
   * keeps the graph acyclic without a cycle check: a task can only depend on
   * tasks created before it, and no op edits the list afterwards. An unknown
   * id is refused rather than dropped — a dependency the author believes in
   * and the board does not hold would silently make the task claimable early.
   */
  private taskDependencies(raw?: unknown): { ids: string[] } | { error: string } {
    if (raw === undefined || raw === null) return { ids: [] };
    if (!Array.isArray(raw)) return { error: "dependsOn must be an array of task ids" };
    const ids = [...new Set(raw.map((x) => String(x ?? "").trim()).filter(Boolean))];
    if (ids.length > MAX_TASK_DEPENDENCIES) return { error: `a task may depend on at most ${MAX_TASK_DEPENDENCIES} tasks (got ${ids.length}) — split it, or depend on the task that gathers them` };
    const goalId = this.state.activeGoalId;
    const unknown = ids.filter((id) => {
      const t = this.state.tasks.get(id);
      return !t || (goalId !== undefined && goalId !== null && t.goalId !== goalId);
    });
    if (unknown.length > 0) return { error: `dependsOn names no task on this goal's board: ${unknown.join(", ")} — create those tasks first, then cite their ids` };
    return { ids };
  }

  private newTask(
    createdBy: string,
    title: string,
    description: string,
    requiredCapabilities?: string[],
    artifactRefs?: Array<ArtifactRef | string>,
    parentTaskId?: string,
    budgetHint?: BudgetHint,
    /** Already validated by `taskDependencies`. */
    dependsOn?: string[],
  ): Task {
    const goalId = this.state.activeGoalId!;
    const parent = parentTaskId ? this.state.tasks.get(parentTaskId) : undefined;
    // Every cited artifact PINS the task to a version: the one the ref names,
    // else the one current now — which is what the author was looking at when
    // it cut the task. `staleTaskPins` compares against it later, so a task cut
    // from architecture v2 says so once v3 lands (§16). A ref naming nothing
    // the store holds stays as given.
    const refs = (normalizeArtifactRefs(artifactRefs) ?? []).map((r) => {
      if (typeof r.version === "number") return r;
      const a = artifactForRef(this.state, undefined, r.uri);
      if (!a) return r;
      const named = Number(/\/(\d+)$/.exec(r.uri)?.[1]);
      return { ...r, version: Number.isInteger(named) && named >= 1 && named <= a.version ? named : a.version };
    });
    const task: Task = {
      id: newTaskId(),
      goalId,
      // Bound the prose the same way a plan step is bounded, and bound it HERE
      // rather than at each op: this is the single point every task passes
      // through, so a caller cannot forget. Callers refuse an empty title
      // outright — a task nobody can name is one nobody can pick up.
      title: String(title ?? "").trim().slice(0, MAX_TASK_TITLE_CHARS),
      description: String(description ?? "").trim().slice(0, MAX_TASK_DESCRIPTION_CHARS),
      createdBy,
      status: "OPEN",
      // Normalized HERE, at the one point every task passes through, for the
      // same reason the prose is bounded here. Agent definitions, policy rules
      // and the runtime tool gate all normalize their capability tokens at
      // load; task requirements were the one list that did not, so a task
      // asking for `test.run` was unclaimable by the seat holding the
      // canonical `test.execute` it aliases to — and the denial named a token
      // the roster genuinely did not contain, which reads like a
      // misconfiguration rather than a mismatch.
      requiredCapabilities: Array.from(new Set((requiredCapabilities ?? []).map((c) => normalizeCapability(String(c))))),
      artifactRefs: refs,
      ...(dependsOn && dependsOn.length > 0 ? { dependsOn } : {}),
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
    // `target.capabilities` is normalized at config load and the op's list was
    // not, so this compared two different vocabularies: a delegate naming
    // `code.write` against a seat holding the `repository.write` it aliases to
    // reported the target as lacking a capability it actually had.
    const missingCaps = (op.requiredCapabilities ?? [])
      .map((c) => normalizeCapability(String(c)))
      .filter((c) => !target.capabilities.includes(c));
    if (missingCaps.length > 0) {
      return { ok: false, op: "delegate", reason: `${op.to} lacks required capabilities ${missingCaps.join(", ")}` };
    }
    if (!String(op.title ?? "").trim()) return { ok: false, op: "delegate", reason: "delegate requires a non-empty title" };
    const unknownCaps = this.unknownTaskCapabilities(op.requiredCapabilities);
    if (unknownCaps.length > 0) {
      return { ok: false, op: "delegate", reason: `task requires capability the runtime can never match: ${unknownCaps.join(", ")} (known: ${CAPABILITY_TOKENS.join(", ")})` };
    }
    const dupe = this.openTaskWithTitle(op.title);
    if (dupe) {
      return { ok: false, op: "delegate", reason: `"${op.title}" is already open as ${dupe.id} (${dupe.status}, ${dupe.claimedBy ?? dupe.assignedTo ?? "unclaimed"}) — delegate that one instead of filing a second` };
    }
    // Construct the task first, but EMIT it only once the message is accepted.
    // `newTask` just builds the record — the projection registers it off the
    // `task.created` event — so a refusal here leaves nothing behind. Emitting
    // first put a claimable task on the board for a delegation the runtime then
    // reported as failed: the board kept work the log said had never been
    // handed out, and no one was ever woken to do it.
    const task = this.newTask(actorId, op.title, op.description, op.requiredCapabilities, op.artifactRefs, this.state.agents.get(actorId)?.state.activeTaskId ?? undefined, op.budgetHint);
    const res = await this.sendMessage({
      from: actorId,
      to: [op.to],
      type: "DELEGATE",
      newThread: { subject: `delegate: ${task.title}` },
      payload: { taskId: task.id, title: task.title, description: task.description, requiredCapabilities: task.requiredCapabilities },
      taskId: task.id,
      budgetHint: op.budgetHint,
    });
    if (!res.accepted) return { ok: false, op: "delegate", reason: res.reason };
    await this.emitTaskCreated(task);
    turn.sentOps++;
    return { ok: true, op: "delegate", taskId: task.id, messageId: res.messageId };
  }

  private async opSpawnWorker(actorId: string, op: Extract<MeshOp, { op: "spawn_worker" }>): Promise<OpResult> {
    const def = this.state.agents.get(actorId)?.definition;
    if (!def) return { ok: false, op: "spawn_worker", reason: "unknown actor" };
    const dp = def.delegationPolicy;
    if (!dp.allowDelegation || dp.maxWorkers <= 0 || dp.maxDepth < 1) {
      await this.denied(actorId, undefined, "spawn_worker", { decision: "DENY", reason: "delegation policy forbids worker spawning" });
      return { ok: false, op: "spawn_worker", reason: "delegation policy forbids worker spawning (v1 flat mesh: max_depth=0)" };
    }
    if (!String(op.title ?? "").trim()) return { ok: false, op: "spawn_worker", reason: "spawn_worker requires a non-empty title" };
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
      // Precedence: what the spawning seat asked for, then the seat's configured
      // default, then the fallback. `op.budgetTokens` was declared on the op
      // (`MeshOp`), advertised by the `mesh_spawn_worker` tool description, and
      // then never read — a seat that carefully sized its worker at 5,000 got
      // 50,000 regardless, and `tests/integration/lifecycle-recovery.test.ts`
      // passed 5,000 without asserting on it, so nothing noticed.
      //
      // Clamped to the parent's own ceiling: a worker is delegated work, not a
      // way to mint budget the delegating seat does not have. Without the clamp
      // `budgetTokens` would be a strictly better deal than doing the work
      // yourself, since a worker's ledger is separate from its parent's and
      // climbs its own 8x auto-raise ladder.
      budget: { tokens: workerBudgetFor(op.budgetTokens, dp.workerBudgetTokens, def.budget.tokens) },
      capabilities: op.capabilities ?? def.capabilities,
      authority: [],
    };
    await this.registerAgent(workerDef);
    // Declared, not left to spring into existence on the first reservation. The
    // boot loop covers `config.agentOrder` only, so a worker's ledger was created
    // lazily by `ensureBudget` and was therefore absent from `/budgets` and from
    // any halt forecast until the worker had already spent something. Measured
    // 2026-09-24: two workers spent 196,027 tokens against ledgers that appear in
    // no config surface, neither charged to their parent nor counted in the
    // mission's summed seat ceilings.
    const workerGoalId = this.state.activeGoalId;
    if (workerGoalId) {
      this.deps.budget.declare(agentKey(workerGoalId, workerId), "tokens", workerDef.budget.tokens ?? null);
    }
    const task = this.newTask(actorId, op.title, op.taskSpec, op.capabilities, [], this.state.agents.get(actorId)?.state.activeTaskId ?? undefined, { maxTokens: workerDef.budget.tokens });
    await this.emitTaskCreated(task);
    this.workerInfo.set(workerId, { parent: actorId, taskId: task.id, depth: depth + 1 });
    await this.deps.kernel.emit("task.claimed", { taskId: task.id, agentId: workerId }, { actorId });
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
    // `commitWorktree` rejects on a git failure -- `git add -- <path>` on a
    // path that does not exist is the common one. Uncaught, that rejection
    // escaped this op and `executeOp` rethrows anything that is not a
    // `KernelRejectedError`, so one mistyped path in `files` threw the seat's
    // whole turn away. It is the seat's mistake to fix, so it is the seat's op
    // result; git's own stderr names the path.
    let committed: { commit: string; diffDigest: string; diff: string };
    try {
      committed = await this.deps.workspace.commitWorktree(actorId, message, files);
    } catch (err) {
      const reason = `git commit failed, nothing was committed: ${err instanceof Error ? err.message : String(err)}`;
      this.auditLine(`commit for '${artifact.name}' by ${actorId}: ${reason}`);
      return { ok: false, op: "commit", reason };
    }
    const { commit, diffDigest, diff } = committed;
    // A commit that committed nothing is not a commit. On "nothing to commit"
    // `commitWorktree` answers with the unchanged HEAD -- on a fresh seat
    // branch that IS the product's own HEAD -- and the cumulative
    // `main...HEAD` diff. Recording that versioned the patch with an empty diff
    // and `metadata.commit` = main's sha, and its later merge was "already in
    // the product": a merge of nothing, reported as landed.
    //
    // The port does not say whether HEAD moved, so two facts stand in for it:
    // an empty diff (nothing of this seat's is off main at all), or a sha some
    // artifact already records (HEAD did not move since that commit). A commit
    // the seat made itself outside this op carries a sha nothing records, and
    // is accepted: it is real work on the branch.
    const alreadyRecorded = [...this.state.artifacts.values()].find((a) => a.metadata?.commit === commit);
    if (diff.trim() === "" || alreadyRecorded) {
      const reason =
        diff.trim() === ""
          ? `nothing was committed: the worktree had no changes${files && files.length > 0 ? ` in ${files.join(", ")}` : ""} and the branch holds nothing that is not already on the product branch. Write the files into your worktree, then commit again`
          : `nothing new was committed: HEAD is still ${commit.slice(0, 12)}, which '${alreadyRecorded!.name}' already records. Write or change the files for this artifact in your worktree, then commit again`;
      this.auditLine(`commit for '${artifact.name}' by ${actorId}: ${reason}`);
      return { ok: false, op: "commit", reason };
    }
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
    // Check the merge GATE before touching the product branch.
    //
    // The gate is enforced by `evaluateTransition` inside `transitionArtifact`,
    // which the land-first ordering below does not reach until after git has
    // already run. So an unsatisfied `patch.merge` gate produced the worst of
    // both: the commit on the product branch, and a refusal to record it --
    // leaving the artifact MERGEABLE over a product that already had the change,
    // with nothing on the log saying so.
    //
    // Same check, same helper and same token vocabulary as `opCommit`'s
    // `patch.commit` gate; only the timing is new. `transitionArtifact` still
    // re-checks, so this is a pre-flight, not a replacement.
    const mergeGate = this.config.transitionGates["patch.merge"];
    if (mergeGate && mergeGate.length > 0) {
      const gateRes = checkApprovals(this.state, mergeGate, artifactId);
      if (!gateRes.ok) {
        const reason = `merge gate patch.merge unsatisfied, missing: ${gateRes.missing.join(", ")} — nothing was merged`;
        await this.denied(actorId, artifactId, "merge (gate)", { decision: "DENY", reason, ruleId: "merge.gate-unsatisfied" });
        return { ok: false, op: "merge", reason };
      }
    }
    // The rest of the MERGED policy, also before git: an active BLOCK on the
    // patch (and anything else `evaluateTransition` refuses) used to be found
    // only by the recording step, after the product branch already held the
    // change -- the same land-then-refuse split the gate pre-flight above fixed.
    const mergedPolicy = this.deps.policy.evaluateTransition(artifact, "MERGED", actorId, ctx);
    if (mergedPolicy.decision !== "ALLOW") {
      const reason = `${mergedPolicy.reason} — nothing was merged`;
      await this.denied(actorId, artifactId, "merge (policy)", { ...mergedPolicy, reason });
      return { ok: false, op: "merge", reason };
    }
    // Land the change FIRST, record it second.
    //
    // This order used to be reversed, and the comment that lived here admitted
    // the consequence rather than fixing it: "what cannot be undone is the
    // status -- the transition above is already on the log, the ladder is
    // strict, and MERGED is terminal, so a failed merge does leave a CodePatch
    // reading MERGED." It does worse than that. `transitionArtifact` fires
    // `mirrorTransition`, which emits `patch.merged` AND
    // `implementation.completed` -- so a merge that never touched the product
    // branch still announced finished work, and `implementation.completed`
    // reduces to an `implementation|pass` approval record feeding the gates.
    //
    // A live run on 2026-09-23 did exactly this at 20:23:57: the artifact read
    // MERGED with both mirrors on the log, and `git log` never contained the
    // patch. Nothing could roll it back, because MERGED is terminal and has no
    // edge out. Doing the work before the bookkeeping is the only fix that
    // does not require an un-merge the ladder cannot express.
    //
    // On failure the artifact stays MERGEABLE, which is both true and
    // retryable: the seat can fix the conflict and merge again.
    let landed: string;
    // Set when `landed` carries more than the sha: merge is a data op, so an
    // unflagged reason would reach the seat as a bare product, not a warning.
    let landedCaveat = false;
    let proof: MergeProof;
    if (this.deps.workspace) {
      // `mergeWorktree` runs `git merge` and REJECTS on a conflict (execFile on
      // a non-zero exit). That rejection used to escape `opMerge` entirely --
      // `executeOp`'s catch rethrows anything that is not a `KernelRejectedError`
      // -- so a conflicted merge became a thrown turn rather than an op result,
      // and the commit sha of a successful one was discarded by a bare `void`.
      let merged: { commit: string; alreadyUpToDate?: boolean; leftBehind?: string[] };
      try {
        // Scope the merge to the commit this artifact recorded, not the branch
        // tip. `opCommit` stores it as `metadata.commit`, and `createArtifact`'s
        // version branch carries metadata forward under the same artifact id, so
        // the sha here belongs to the version that was actually approved.
        // Without it the whole agent branch merges and unreviewed commits ride
        // in on this approval — see `mergeWorktree`.
        const recorded = typeof artifact.metadata?.commit === "string" ? artifact.metadata.commit : undefined;
        merged = await this.deps.workspace.mergeWorktree(artifactId, artifact.owner, comment ?? `merge ${artifact.name}`, recorded);
      } catch (err) {
        const reason = `git merge of '${artifact.name}' failed: ${err instanceof Error ? err.message : String(err)} — nothing landed on the product branch, the patch stays MERGEABLE, and implementation-merged stays UNEVIDENCED`;
        this.auditLine(`merge of '${artifact.name}': ${reason}`);
        await this.denied(actorId, artifactId, "merge (git)", { decision: "DENY", reason, ruleId: "merge.git-failed" });
        return { ok: false, op: "merge", reason };
      }
      if (merged.alreadyUpToDate) {
        // A merge that moved nothing. Whether MERGED is still the truth
        // depends on whether THIS patch's work is on the product branch:
        //
        //  - it recorded a commit (via `opCommit`), and the scoped arm only
        //    reports up-to-date when that commit is already an ancestor of
        //    main: an earlier merge landed it. MERGED is true.
        //  - it recorded no commit: the branch arm merged the seat's branch,
        //    and "already up to date" there means the branch holds nothing
        //    main lacks -- a seat that wrote files and never committed them.
        //    Its work is untracked in a worktree, on no branch at all.
        //  - it recorded a commit with an EMPTY diff (logs from before
        //    `opCommit` refused empty commits): the sha is main's own, so
        //    being "on main" says nothing about the patch.
        //
        // The last two are refused, leaving the patch MERGEABLE: the fix is a
        // `commit`, then the same merge.
        const recordedCommit = typeof artifact.metadata?.commit === "string" && artifact.metadata.commit.length > 0;
        const emptyDiff = artifact.metadata?.diffDigest === EMPTY_DIFF_DIGEST;
        if (!recordedCommit || emptyDiff) {
          const reason =
            `git reports '${artifact.name}' already in the product as ${merged.commit.slice(0, 12)} — the merge moved nothing, ` +
            (recordedCommit
              ? "and the commit it records has an empty diff, so none of this patch's work is on the product branch. "
              : `and the patch records no commit, so its work was never committed: files ${artifact.owner} wrote but did not commit are on no branch. `) +
            `${artifact.owner} must \`mesh_commit\` the patch's files. That records the commit as a NEW version of the patch, which starts over at DRAFT and needs review again before it can be merged ` +
            `(commit BEFORE asking for review next time). This version stays MERGEABLE, and implementation-merged stays UNEVIDENCED`;
          this.auditLine(`merge of '${artifact.name}': ${reason}`);
          await this.denied(actorId, artifactId, "merge (nothing landed)", { decision: "DENY", reason, ruleId: "merge.nothing-committed" });
          return { ok: false, op: "merge", reason };
        }
      }
      proof = { via: "git", commit: merged.commit, ...(merged.alreadyUpToDate ? { alreadyUpToDate: true } : {}) };
      landed = merged.alreadyUpToDate
        ? `already in the product as ${merged.commit.slice(0, 12)} (landed by an earlier merge)`
        : `merged as ${merged.commit.slice(0, 12)}`;
      if (merged.leftBehind && merged.leftBehind.length > 0) {
        // Either the scope held (later commits deliberately not landed) or there
        // was no sha to scope by (the whole branch went in). Both are facts the
        // seat and the log should carry rather than infer.
        const note = `${merged.leftBehind.length} commit(s) on ${artifact.owner}'s branch were NOT part of this artifact: ${merged.leftBehind.slice(0, 5).join("; ")}`;
        this.auditLine(`merge of '${artifact.name}': ${note}`);
        landed = `${landed} — ${note}`;
        landedCaveat = true;
      }
    } else {
      // Without git, materialization IS the merge: nothing else puts the
      // patch's files into the product. Reporting `ok: true` here let a run
      // finish "successfully" having written not one byte.
      const materialized = await this.materializeProductFiles(artifact);
      if (!materialized.ok) {
        const reason = `no product files were written: ${materialized.reason} — the patch stays MERGEABLE and implementation-merged stays UNEVIDENCED`;
        this.auditLine(`merge of '${artifact.name}': ${reason}`);
        await this.denied(actorId, artifactId, "merge (materialize)", { decision: "DENY", reason, ruleId: "merge.materialize-failed" });
        return { ok: false, op: "merge", reason };
      }
      this.auditLine(`merge of '${artifact.name}': materialized ${materialized.reason}`);
      landed = `materialized ${materialized.reason}`;
      proof = { via: "materialize", files: materialized.reason };
    }
    // The product branch now holds the change; record it once. A second
    // transition attributed to HUMAN_AGENT_ID used to follow this one, from
    // the runtime's first commit and with no comment explaining it. It was a
    // pure duplicate that survived every guard by accident -- policy
    // short-circuits on `human`, then the reducer absorbs a same-status move
    // before `assertArtifactTransition` can refuse it, so the kernel appended
    // the event and `mirrorTransition` re-fired. Its cost was a second
    // `implementation|pass` approval record attributed to the artifact owner:
    // a gate signature the owner never gave.
    const res = await this.applyTransition(actorId, artifactId, { to: "MERGED", comment }, proof);
    if (!res.ok) return { ok: false, op: "merge", reason: res.reason };
    await this.markMergeEvidence(artifact);
    const open = openRejections(this.state, artifact.goalId);
    if (open.length > 0) {
      // Said to the merger in the op result: it is the seat that believes the work is done.
      landed = `${landed}; the mission cannot complete yet, because ${this.openRejectionSentence(open)}`;
      landedCaveat = true;
    }
    return { ok: true, op: "merge", eventId: res.eventId, reason: landed, ...(landedCaveat ? { caveat: true } : {}) };
  }

  /**
   * Merge evidence is runtime-derived: the worktree merged or the product
   * files were actually written on disk. It carries no claiming agent, so it
   * lands EVIDENCED by construction — call it only after the merge step ran.
   */
  private async markMergeEvidence(artifact: Artifact): Promise<void> {
    await this.markCriterionEvidence("implementation-merged", {
      kind: "merge",
      artifactRef: { uri: artifactUri(artifact.type, artifact.name, artifact.version) },
      recordedAt: this.deps.kernel.clock.iso(),
    });
  }

  /**
   * What a seat is told about a rejected patch that has not ended up merged or archived: its name, its
   * state and whose move it is. The machine lets a REJECTED patch go to DRAFT and nowhere else, and only
   * DRAFT and READY_FOR_REVIEW to ARCHIVED, so "archive it" said to the owner of a REJECTED one is a
   * refused call: the two moves are named.
   */
  private openRejectionSentence(patches: readonly Artifact[]): string {
    const lines = patches.slice(0, 3).map((a) => {
      const move =
        a.status === "REJECTED"
          ? `${a.owner} reworks it (a new version with asVersionOf, then a review request) or, if it is abandoned, moves it to DRAFT and then to ARCHIVED`
          : a.status === "DRAFT"
            ? `${a.owner} finishes the rework and asks for a review, or archives it if it is abandoned`
            : a.status === "READY_FOR_REVIEW" || a.status === "UNDER_REVIEW"
              ? "it was rejected before, and waits on its review again"
              : "it was rejected before, and waits to be merged";
      return `CodePatch "${a.name}" is ${a.status} (owner ${a.owner}): ${move}`;
    });
    return `${lines.join("; ")}${patches.length > 3 ? "; …" : ""}`;
  }

  /**
   * Non-git merge: write the patch's files into the product workspace.
   *
   * Without git a MERGED record is only a record, so the CodePatch carries its
   * files: `metadata.path` + raw content (single file) or `## File: <path>` /
   * `### <path>` sections (bundle, raw bodies). Every path is confined to the
   * workspace and every target is resolved before the first byte is written.
   */
  private async materializeProductFiles(artifact: Artifact): Promise<{ ok: true; reason: string } | { ok: false; reason: string }> {
    const meta = artifact.metadata as { path?: unknown } | undefined;
    const metadataPath = typeof meta?.path === "string" && meta.path.trim() ? meta.path.trim() : undefined;
    let content: string;
    try {
      content = await this.deps.content.read(artifact.contentRef);
    } catch (err) {
      return { ok: false, reason: `cannot read artifact content: ${(err as Error).message}` };
    }
    const files = extractPatchFiles(content, metadataPath);
    if (files.length === 0) {
      return {
        ok: false,
        reason: metadataPath
          ? `no '## File: ${metadataPath}' section found in a multi-file bundle`
          : "no file sections found (use '## File: <path>' sections or metadata.path for a single file)",
      };
    }
    const targets: Array<{ file: PatchFile; target: string }> = [];
    for (const file of files) {
      const target = safeProductPath(this.config.workspacePath, file.path);
      if (!target) return { ok: false, reason: `path '${file.path}' is not inside the workspace` };
      targets.push({ file, target });
    }
    const written: string[] = [];
    for (const { file, target } of targets) {
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, file.content, "utf8");
      } catch (err) {
        return { ok: false, reason: `write '${file.path}' failed: ${(err as Error).message}` };
      }
      written.push(file.path);
    }
    return { ok: true, reason: written.join(", ") };
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

  /**
   * Decide whether THIS turn should be spent on a handover, and open it if so.
   *
   * Asked before the bundle is built, because the answer changes what the turn
   * is. The alternative — letting the adapter rotate silently and telling the
   * successor afterwards — cannot work: by the time anyone knows the rotation
   * happened, the session that had something to say about it is gone.
   *
   * Asked at most once per transcript. A seat that ignores the instruction, or
   * whose handover turn dies, does NOT get asked again on the same session:
   * the next turn rotates normally and the successor starts cold. That is a
   * worse outcome than a handover and a better one than a seat that can never
   * do anything else, and the empty `continuity` slot in the next turn's
   * manifest says which happened.
   */
  private async openHandover(
    agentId: string,
    session: { session: import("../../protocol/src/index").AgentSession; runtime: AgentRuntime },
    turnId: string,
    causationId: string,
  ): Promise<RotationPendingInfo | null> {
    if (!session.runtime.rotationPending) return null;
    let info: RotationPendingInfo | null = null;
    try {
      info = session.runtime.rotationPending(session.session);
    } catch {
      // A runtime that cannot answer is a runtime that does not rotate, as far
      // as this path is concerned. Never fail a turn over a handover.
      return null;
    }
    if (!info) return null;
    const ordinal = this.state.sessionOrdinal.get(agentId) ?? 1;
    if (this.continuityAsked.get(agentId) === ordinal) return null;
    this.continuityAsked.set(agentId, ordinal);
    // A cold cache means the handover call would re-read the whole transcript
    // at full price for one record — two such turns cost 611k tokens on
    // 2026-09-25 (NOTES-live-run-20260925-2040.md §1). Rotate directly instead:
    // this turn runs without `suppressRotation`, the adapter rotates on the way
    // in, and the successor starts from the ledger and the last continuity on
    // record. What is lost is this session's unwritten judgement, which is the
    // price the handover was paying 200k+ tokens a time to save.
    const handover = info.cacheCold !== true;
    await this.deps.kernel.emit(
      "session.rotation_pending",
      {
        agentId,
        // The transcript being discarded, as the backend names it: the mesh id
        // is stable across rotations, so it named the same session every time
        // (all three of frontend's pendings read `5a67e4b4`, §12).
        sessionId: info.sessionId ?? session.session.sessionId,
        meshSessionId: session.session.sessionId,
        handover,
        reason: "rotation",
        transcriptTokens: info.transcriptTokens,
        thresholdTokens: info.thresholdTokens,
      } satisfies SessionRotationPending,
      { actorId: agentId, causationId, correlationId: turnId },
    );
    if (!handover) {
      this.auditLine(`${agentId} is holding ${info.transcriptTokens} tokens of context (rotation threshold ${info.thresholdTokens}) on a cold prompt cache — rotating without a handover turn`);
      return null;
    }
    this.auditLine(`${agentId} is holding ${info.transcriptTokens} tokens of context (rotation threshold ${info.thresholdTokens}) — spending this turn on a handover`);
    return info;
  }

  /**
   * Put back the wake a handover consumed: at the head of the queue, and only
   * while it still stands.
   *
   * Head, because the seat had already won a slot for that work and the mesh
   * spent it on bookkeeping (`HANDOVER_REQUEUE_PRIORITY`). Straight to the
   * scheduler rather than through `activateAgent`, whose priority is fixed by
   * reason kind — the gates it applies first are applied here.
   *
   * Still standing, because the handover can outlive the reason: explorer was
   * re-woken on a review ask superseded while it handed over and spent 587k
   * tokens on it (§1, §17 of NOTES-live-run-20260925-2040.md).
   *
   * If the scheduler already started the successor — it requeues a seat that
   * still holds unread mail, which a handover now always leaves unread — a mail
   * wake is covered by that turn and is dropped; any other wake is stashed
   * behind it, as before.
   *
   * `explicit` but never `operator`, even when the consumed wake was the
   * operator's: the operator's turn was admitted and spent, and this is the
   * mesh's own re-queue. So an open provider breaker HOLDS it — queued, a probe
   * candidate, run once the breaker closes. It used to walk through: on
   * 2026-09-28 a handover turn failed with the outage's 402 and this re-queue
   * started a second refused turn eight seconds after the breaker had opened.
   */
  private async requeueAfterHandover(agentId: string, reason: ActivationReason): Promise<void> {
    const gone = await this.handoverWakeWithdrawn(agentId, reason);
    if (gone) {
      this.auditLine(`${agentId}: the wake its handover consumed is not re-queued — ${gone}`);
      return;
    }
    const halted = haltedGoalStatus(this.state);
    const followUp = reason.kind === "message" || reason.kind === "manual" || reason.kind === "recovery";
    if (halted && !(halted === "COMPLETED" && followUp)) return;
    const lifecycle = this.state.agents.get(agentId)?.state.lifecycle;
    if (!lifecycle || lifecycle === "SUSPENDED" || lifecycle === "COMPLETED" || lifecycle === "RETIRED") return;
    if (this.turnInFlight.has(agentId) && reason.kind === "message") return;
    await this.deps.scheduler.requestActivation({ agentId, reason, priority: HANDOVER_REQUEUE_PRIORITY, explicit: true });
  }

  /**
   * Why the wake a handover consumed no longer stands, or null if it does.
   *
   * Narrow on purpose: only an ASK that has since left the ledger (answered,
   * withdrawn, superseded, expired) retires a wake. A message wake is judged
   * by whether this seat still owes it; an interest wake by the ask its event
   * names (`design.question` carries one per review request). Anything this
   * cannot resolve stands — a dropped wake is lost work, a kept one is a turn.
   */
  private async handoverWakeWithdrawn(agentId: string, reason: ActivationReason): Promise<string | null> {
    const isAsk = (id: string): boolean => {
      const m = this.state.messages.get(id);
      return m !== undefined && (m.control?.mode ?? "service") === "service" && isObligingType(m.type);
    };
    if (reason.kind === "message" && reason.messageId && isAsk(reason.messageId)) {
      const pr = this.state.pendingRequests.get(reason.messageId);
      return pr && stillOwes(pr, agentId) ? null : `ask ${reason.messageId} is no longer owed by ${agentId}`;
    }
    if (reason.kind === "interest_event" && reason.eventId && reason.eventType) {
      const events = await this.deps.kernel.store.read({ types: [reason.eventType] }).catch(() => []);
      const evt = events.find((e) => e.id === reason.eventId);
      const askId = (evt?.payload as { messageId?: unknown } | undefined)?.messageId;
      if (typeof askId === "string" && isAsk(askId) && !this.state.pendingRequests.has(askId)) {
        return `the ask behind ${reason.eventType} ${reason.eventId} (${askId}) is closed`;
      }
    }
    return null;
  }

  /**
   * Put a seat's working state on the log, so it survives the destruction of
   * the transcript that holds it.
   *
   * Three of the four fields are filled HERE rather than by the model, and for
   * the same reason ids are: a record the successor is supposed to trust must
   * not depend on the outgoing session getting its own bookkeeping right while
   * it is running out of context.
   *
   * - `openCommitments` comes from the ledger. An agent listing its own debts
   *   from memory omits exactly the ones it has forgotten, which are the ones
   *   the successor most needs.
   * - `episode` comes from the active goal. A belief is only as good as the
   *   run it was formed in, and after a reopen the successor has to be able to
   *   tell the two apart.
   * - `sessionOrdinal` comes from the rotation projection.
   */
  /**
   * Discovery. This is the half of the contract change that makes the other
   * half safe: a seat that does not know a name can ask, instead of guessing
   * and relying on an alias table to catch it.
   *
   * Providers are resolved LIVE against the roster and the communication
   * policy, so the answer is "who can I actually ask, right now", not a static
   * catalogue reprint. A contract whose provider capability nobody holds is
   * still listed, with an empty provider list and the capability named — that
   * is a fact about the mesh worth seeing, and hiding it would look to a seat
   * like the contract does not exist.
   */
  /** The shape every policy call in this file builds by hand; named once here. */
  private policyContext(): PolicyContext {
    const goalId = this.state.activeGoalId ?? "";
    return { config: this.config, projections: this.state, goal: this.state.goals.get(goalId) };
  }

  private listContracts(actorId: string, op: MeshOpContracts): OpResult {
    const wantRole = typeof op.role === "string" && op.role.trim() ? op.role.trim() : undefined;
    const ctx = this.policyContext();
    const contracts = BUILTIN_CONTRACTS.map((c) => {
      const providers = this.resolveProviders(actorId, c, ctx).filter(
        (id) => !wantRole || this.config.agents[id]?.role === wantRole,
      );
      return {
        name: c.name,
        version: c.version,
        summary: c.summary,
        request: c.request,
        refusals: c.refusals,
        slaMs: c.slaMs,
        requiresCapability: c.provider,
        providers,
      };
    }).filter((c) => !wantRole || c.providers.length > 0);
    return { ok: true, op: op.op, contracts };
  }

  /**
   * Seats that could answer this contract, and that `actorId` is allowed to
   * ask. The capability filter and the communication filter are both applied
   * here rather than left to `sendMessage`, because an unreachable provider
   * suggested by discovery is worse than none: the seat spends a turn being
   * refused by a gate it was pointed at.
   *
   * The communication check goes through the real policy engine rather than a
   * local reimplementation — this repo already carries two diverging copies of
   * the review-capability table, and a third copy of the contact rules would
   * rot the same way.
   */
  private resolveProviders(actorId: string, contract: Contract, ctx: PolicyContext): string[] {
    const out: string[] = [];
    for (const id of this.config.agentOrder) {
      if (id === actorId) continue;
      const def = this.config.agents[id];
      if (!def) continue;
      if (!this.state.agents.has(id)) continue;
      if (contract.provider && !def.capabilities.includes(contract.provider)) continue;
      const decision = this.deps.policy.evaluateMessage(
        actorId,
        [id],
        { type: contract.messageType, threadId: "", payload: {}, taskId: undefined },
        ctx,
      );
      if (decision.decision !== "DENY") out.push(id);
    }
    return out;
  }

  /**
   * One ask, against a published contract.
   *
   * Every exit desugars to a typed op and goes back through `executeOp`, which
   * is deliberate: it means `call` cannot reach anything a typed op could not,
   * and every gate — the halt freeze, the handover restriction, the plan gate,
   * the capability checks, the communication policy — applies to it unchanged
   * and without a second implementation to keep in step. `call` is sugar. If it
   * ever stops being sugar, this is the line that broke.
   */
  /**
   * The soonest an `ifUnanswered` default may come due, in milliseconds.
   *
   * An operator's `bus.commitments.min_default_ms` wins, `0` included. Otherwise it
   * is what this mesh needs before anyone CAN object: the window a `deliver` ask is
   * gathered for, the sweep that notices a deadline, and a turn for the addressee to
   * answer in (`ANSWER_TURN_ALLOWANCE_MS`). The addressee's CURRENT turn is not
   * counted, because it is unbounded, and that is the honest limit of a floor: the
   * figure removes the defaults that could never have been answered, not every one
   * that might not be.
   */
  private defaultFloorMs(): number {
    const configured = this.config.bus.commitmentDefaultFloorMs;
    if (configured !== undefined) return configured;
    return (this.config.bus.deliveryClasses?.coalesceMs ?? 0) + this.config.scheduling.waitWakeupMs + ANSWER_TURN_ALLOWANCE_MS;
  }

  /**
   * The refusal for an `ifUnanswered` this mesh could never honour. See the
   * guard in `executeOp` for why it is refused rather than accepted.
   */
  private undatedDefault(op: MeshOp): string | undefined {
    const assumed = (op as { ifUnanswered?: DefaultAnswer }).ifUnanswered;
    if (!assumed) return undefined;
    if (typeof assumed.assume === "undefined") {
      return "ifUnanswered needs an `assume`: the value you will proceed with. Without it there is nothing for the mesh to hand back when the deadline passes.";
    }
    if (typeof assumed.afterMs === "number" && assumed.afterMs > 0) {
      const floor = this.defaultFloorMs();
      if (assumed.afterMs < floor) {
        return (
          `ifUnanswered.afterMs ${assumed.afterMs} is shorter than this mesh can get an answer back: the ask may wait for its addressee to finish a turn, for ` +
          `the delivery window, and for a sweep to notice the deadline, and the addressee then needs a turn of its own. At ${assumed.afterMs} ms your default ` +
          `would stand before anyone could have objected, and you would proceed on an assumption nobody had the chance to correct. ` +
          `Pass afterMs of at least ${floor} (${Math.ceil(floor / 1000)}s), or drop ifUnanswered and raise a normal ask.`
        );
      }
      return undefined;
    }
    if (this.config.bus.commitmentTtl) return undefined;
    return "ifUnanswered needs a deadline, and this mesh has none: pass afterMs on the ask, or have an operator set bus.commitments.ttl_ms. Without one the default would be recorded and never fire, and you would wait forever for an answer the mesh had promised you.";
  }

  /**
   * The artifact a review request is about: the named one, else what the seat just
   * published this turn (its URI guess did not resolve, but reviewing the thing it
   * just made is the intent). The `request_review` op and the contract router both
   * ask this, so the router cannot pick a reviewer for a different artifact than the
   * op then reviews.
   */
  private reviewTarget(artifactId: string | undefined, artifactUri: string | undefined, turn: TurnState): Artifact | undefined {
    let id = this.resolveArtifactRef(artifactId, artifactUri);
    if (!id && turn.publishedIds && turn.publishedIds.length > 0) id = turn.publishedIds[turn.publishedIds.length - 1];
    return id ? this.state.artifacts.get(id) : undefined;
  }

  /**
   * The recipient of a `review.artifact` call that named nobody: the first seat the
   * caller may contact AND whose verdict would settle the artifact, in config order.
   * `candidates` is what `resolveProviders` found contactable. When the artifact does
   * not resolve the op will say so, so any contactable seat will do here.
   */
  private async pickReviewer(
    actorId: string,
    request: Record<string, unknown>,
    candidates: string[],
    turn: TurnState,
  ): Promise<{ ok: true; reviewer: string } | { ok: false; reason: string }> {
    const ref = request.artifact ?? request.artifactId;
    const uri = typeof ref === "string" && ref.startsWith("artifact://") ? ref : undefined;
    const a = this.reviewTarget(String(ref ?? ""), uri, turn);
    if (!a) return { ok: true, reviewer: candidates[0]! };
    const able = settlersOf(this.state, a, HUMAN_AGENT_ID);
    const reviewer = candidates.find((id) => able.includes(id));
    if (reviewer) return { ok: true, reviewer };
    const why = able.length > 0
      ? `${able.join(", ")} can, but you may not contact ${able.length === 1 ? "them" : "any of them"}`
      : "no seat in this mesh can, so only the operator can";
    const reason = `no seat you may contact can deliver a verdict on this ${a.type} — ${why}. Name a reviewer with \`reviewers\` if one is reachable, or escalate.`;
    await this.denied(actorId, a.id, "request review", { decision: "DENY", reason, ruleId: "review.reviewer-cannot-settle" });
    return { ok: false, reason };
  }

  private async callContract(actorId: string, op: MeshOpCall, turn: TurnState): Promise<OpResult> {
    const contract = findContract(op.contract);
    if (!contract) return { ok: false, op: op.op, reason: unknownContractReason(op.contract) };

    const request = (op.request ?? {}) as Record<string, unknown>;
    const check = validateContractRequest(contract, request);
    if (!check.valid) {
      const detail = check.errors.slice(0, 4).map((e) => `${e.path} ${e.message}`).join("; ");
      return {
        ok: false,
        op: op.op,
        reason: `request does not match contract ${contract.name}: ${detail}. Expected: ${JSON.stringify(contract.request)}`,
      };
    }

    // An operator card has no peer recipient, so it resolves nothing.
    if (contract.desugarsTo === "escalate") {
      // ...and therefore opens no commitment for a default to discharge. Said
      // rather than dropped: a field that is silently ignored teaches the
      // seat it worked, and the seat would then proceed on an assumption the
      // mesh never agreed to hold.
      if (op.ifUnanswered) {
        return { ok: false, op: op.op, reason: `${contract.name} raises a card for a human and opens no commitment, so ifUnanswered has nothing to discharge. Drop it, or ask a peer with a contract that opens one.` };
      }
      return this.executeOp(actorId, {
        op: "escalate",
        reason: String(request.reason ?? ""),
        detail: request.detail,
        conflictKey: typeof request.conflictKey === "string" ? request.conflictKey : undefined,
      }, turn);
    }

    // A review names its reviewers in the request (`reviewers`, the field this
    // contract advertises, and the one `mesh_request_review` takes) or overrides the
    // recipient with `to`. `reviewers` was in the schema and read by nothing: the ask
    // went to whichever seat came first in config order (pm to architect, architect to
    // pm), and all 7 calls that named a reviewer this way were refused as unable to
    // settle it (cronlite, second run).
    const reviewing = contract.desugarsTo === "request_review";
    const named = op.to ?? asIdList(request.to) ?? (reviewing ? asIdList(request.reviewers) : undefined);
    let targets = named;
    if (!targets || targets.length === 0) {
      const resolved = this.resolveProviders(actorId, contract, this.policyContext());
      if (resolved.length === 0) {
        const why = contract.provider
          ? `no seat you may contact holds ${contract.provider}`
          : "no seat you may contact is available";
        return { ok: false, op: op.op, reason: `cannot route ${contract.name}: ${why}. Name a recipient with to, or use the contracts op to see who is available.` };
      }
      if (reviewing) {
        // "Omit to let the mesh pick qualified reviewers" has to mean that: the first
        // seat the caller may contact is not qualified by being first.
        const picked = await this.pickReviewer(actorId, request, resolved, turn);
        if (!picked.ok) return { ok: false, op: op.op, reason: picked.reason };
        targets = [picked.reviewer];
      } else {
        // One provider, not all of them: a contract is an ask, and broadcasting
        // it would open a commitment on every qualified seat for work only one
        // of them needs to do.
        targets = [resolved[0]];
      }
    }

    // The contract name travels on the envelope's runtime-owned `control`, not
    // in the payload: the ledger reads it to draw the ask's deadline and to
    // judge the answer, and both are decisions about obligations that an agent
    // must not be able to make for the kernel by writing a key into free-form
    // JSON. `askControl` re-checks the name against the catalogue, so a
    // stamp on the wire always means "this ask passed its request schema".
    switch (contract.desugarsTo) {
      case "request_review": {
        // `artifactId` is an accepted spelling of `artifact` (see the contract): the
        // tool list teaches the former, the schema was written with the latter.
        const artifactRef = request.artifact ?? request.artifactId;
        return this.executeOp(actorId, {
          op: "request_review",
          artifactId: String(artifactRef ?? ""),
          artifactUri: typeof artifactRef === "string" && artifactRef.startsWith("artifact://") ? artifactRef : undefined,
          reviewers: targets,
          contract: contract.name,
          contractVersion: contract.version,
          ifUnanswered: op.ifUnanswered,
        }, turn);
      }
      case "request_research":
        return this.executeOp(actorId, {
          op: "request_research",
          to: targets[0],
          question: String(request.question ?? ""),
          artifactRefs: (request.artifactRefs as ArtifactRef[] | undefined),
          contract: contract.name,
          contractVersion: contract.version,
          ifUnanswered: op.ifUnanswered,
        }, turn);
      default: {
        const subject = typeof request.subject === "string" && request.subject.trim()
          ? request.subject.trim()
          : `${contract.name}: ${firstWords(request)}`;
        return this.executeOp(actorId, {
          op: "send",
          type: contract.messageType,
          to: targets,
          newThread: { subject },
          contract: contract.name,
          contractVersion: contract.version,
          ifUnanswered: op.ifUnanswered,
          payload: { ...request },
        }, turn);
      }
    }
  }

  private async writeContinuity(actorId: string, op: MeshOpWriteContinuity): Promise<OpResult> {
    const rec = this.state.agents.get(actorId);
    if (!rec) return { ok: false, op: op.op, reason: `unknown agent '${actorId}'` };
    const nextIntent = (op.nextIntent ?? "").trim();
    if (!nextIntent) return { ok: false, op: op.op, reason: "nextIntent is required: one sentence on what you were about to do" };

    const goal = this.state.activeGoalId ? this.state.goals.get(this.state.activeGoalId) : undefined;
    const episode = goal ? episodeOf(goal) : undefined;
    const openCommitments = [...this.state.pendingRequests.values()]
      .filter((pr) => outstandingDebtors(pr).includes(actorId))
      .slice(0, MAX_CONTINUITY_COMMITMENTS)
      .map((pr) => pr.messageId);

    const record: ContinuityRecord = {
      agentId: actorId,
      episode,
      sessionOrdinal: this.state.sessionOrdinal.get(actorId) ?? 1,
      writtenAt: this.deps.kernel.clock.iso(),
      reason: "rotation",
      openCommitments,
      // Bounded on the way in. The successor reads this inside a context slot
      // with a token budget, so an agent that dumps its whole transcript into
      // `beliefs` would evict the very commitments it is trying to hand over.
      workingBeliefs: (op.beliefs ?? []).slice(0, MAX_CONTINUITY_BELIEFS).map((b) => ({
        claim: String(b.claim ?? "").slice(0, MAX_CONTINUITY_TEXT),
        basis: String(b.basis ?? "").slice(0, MAX_CONTINUITY_TEXT),
        confidence: b.confidence === "asserted" ? "asserted" : "assumed",
      })),
      rejected: (op.rejected ?? []).slice(0, MAX_CONTINUITY_REJECTIONS).map((r) => ({
        what: String(r.what ?? "").slice(0, MAX_CONTINUITY_TEXT),
        rejectedBy: String(r.rejectedBy ?? "").slice(0, 200),
        reason: String(r.reason ?? "").slice(0, MAX_CONTINUITY_TEXT),
        episode: r.episode ?? episode,
      })),
      nextIntent: nextIntent.slice(0, MAX_CONTINUITY_TEXT),
    };
    await this.deps.kernel.emit("continuity.recorded", record, { actorId, goalId: this.state.activeGoalId ?? undefined });
    this.auditLine(`continuity recorded for ${actorId} (session ${record.sessionOrdinal}, ${openCommitments.length} open)`);
    return { ok: true, op: op.op };
  }

  /**
   * Replace an agent's private checklist for the task it currently holds.
   *
   * Ids are resolved HERE, not in the model's payload, for the same reason
   * every other id is: a reducer must be a pure function of the log, so a step
   * id may not depend on when the event is replayed. Omitted ids hash the
   * step's own text, which makes a re-emitted identical plan idempotent —
   * agents restate their whole plan constantly, and a fresh id every time
   * would break `plan_step` references from the previous turn.
   *
   * Recorded progress survives a re-plan: a step whose text is unchanged keeps
   * its DONE status unless the new payload explicitly says otherwise. Without
   * this, an agent that adds one step to a 5-step plan silently un-completes
   * the four it had finished.
   */
  async updatePlan(agentId: string, steps: PlanStepInput[], taskId?: string): Promise<OpResult> {
    const rec = this.state.agents.get(agentId);
    if (!rec) return { ok: false, op: "plan", reason: `unknown agent '${agentId}'` };
    const prev = rec.state.plan;
    const prevById = new Map((prev?.steps ?? []).map((s) => [s.id, s] as const));
    const resolved: PlanStep[] = [];
    const used = new Set<string>();
    for (const raw of steps.slice(0, MAX_PLAN_STEPS)) {
      const text = String(raw?.text ?? "").trim().slice(0, MAX_PLAN_STEP_CHARS);
      if (!text) continue;
      let id = String(raw?.id ?? "").trim() || shortHash(text);
      // Two steps with the same text are legal ("run tests" twice). Suffix
      // rather than drop, so plan_step can still address the second one.
      if (used.has(id)) {
        let n = 2;
        while (used.has(`${id}-${n}`)) n += 1;
        id = `${id}-${n}`;
      }
      used.add(id);
      const carried = prevById.get(id);
      const status: PlanStepStatus = raw?.status === "DONE" || raw?.status === "PENDING"
        ? raw.status
        : (carried?.status ?? "PENDING");
      resolved.push({
        id,
        text,
        status,
        capabilities: Array.from(new Set((raw?.capabilities ?? []).map((c) => normalizeCapability(String(c))))),
      });
    }
    const plan: AgentPlan = {
      taskId: taskId ?? rec.state.activeTaskId,
      steps: resolved,
      revision: (prev?.revision ?? 0) + 1,
      updatedAt: this.deps.kernel.clock.iso(),
    };
    await this.deps.kernel.emit("plan.updated", { agentId, plan }, { actorId: agentId });
    return { ok: true, op: "plan", taskId: plan.taskId };
  }

  /**
   * Flip one step. Re-emits the WHOLE plan rather than a delta, so the reducer
   * stays a replace and a replayed prefix is always a coherent checklist.
   */
  async updatePlanStep(agentId: string, stepId: string, status: PlanStepStatus): Promise<OpResult> {
    const rec = this.state.agents.get(agentId);
    const prev = rec?.state.plan;
    if (!rec || !prev) return { ok: false, op: "plan_step", reason: "no plan yet — call `mesh_plan` first" };
    const asked = String(stepId ?? "").trim();
    let idx = prev.steps.findIndex((s) => s.id === asked);
    // A step's id is one the plan gave it, and a seat that wrote the plan without ids was never told
    // them (`mesh_plan` answers ok and nothing else); the name it reaches for is the step's place in
    // the list. All seven calls the fifth cronlite run's developer made for its seven steps were
    // "1" to "7", and each was refused with a list of hashes. A literal id always wins, so a plan
    // that numbers its own steps is addressed exactly as it wrote them.
    if (idx < 0 && /^[1-9]\d*$/.test(asked) && Number(asked) <= prev.steps.length) idx = Number(asked) - 1;
    if (idx < 0) {
      const have = prev.steps.map((s, i) => `${i + 1}) ${s.id} — ${s.text.length > 60 ? `${s.text.slice(0, 57)}...` : s.text}`).join("; ");
      return {
        ok: false,
        op: "plan_step",
        reason: `unknown step '${asked}': name a step by its number or its id (have: ${have || "none"})`,
      };
    }
    if (prev.steps[idx]!.status === status) return { ok: true, op: "plan_step" };
    const plan: AgentPlan = {
      ...prev,
      steps: prev.steps.map((s, i) => (i === idx ? { ...s, status } : s)),
      revision: prev.revision + 1,
      updatedAt: this.deps.kernel.clock.iso(),
    };
    await this.deps.kernel.emit("plan.updated", { agentId, plan }, { actorId: agentId });
    return { ok: true, op: "plan_step" };
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
    const elapsed = this.nowMs() - this.watchdogLastRun;
    if (immediate || elapsed >= 1000) {
      this.watchdogLastRun = this.nowMs();
      this.watchdogChain = this.watchdogChain
        .then(() => this.watchdog())
        .catch((err) => {
          this.auditLine(`watchdog error: ${err.stack ?? err.message}`);
        });
    } else if (!this.watchdogTrailing) {
      this.watchdogTrailing = true;
      const t = this.timers.setTimeout(() => {
        this.watchdogTrailing = false;
        this.watchdogLastRun = this.nowMs();
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
    let broke = false;
    for (const f of findings) {
      // A break changes the graph under the findings that follow it: one void
      // can dissolve several rings that shared the edge. Re-read the graph
      // before acting on a later ring, so a stale finding neither costs a live
      // ask nor reaches the operator as a deadlock that no longer exists.
      // Unreported, it is simply forgotten by the next scan's self-healing.
      if (f.kind === "wait_cycle" && broke) {
        const live = this.detector.liveWaitCycles(this.state).find((c) => c.conflictKey === f.conflictKey);
        if (!live) continue;
        f.edges = live.edges;
      }
      this.detector.markReported(f);
      // A circular wait is the one deadlock the runtime can resolve by
      // itself, so try that before spending the operator's attention — but only
      // while breaking it is still plausibly a repair rather than a loop.
      if (f.kind === "wait_cycle" && !this.waitCycleBreaksSpent(f) && (await this.breakWaitCycle(f))) {
        broke = true;
        continue;
      }
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
    // What the sweep could not raise is parked, and its card goes to the
    // operator here — the verdict below no longer halts the goal over one seat.
    await this.parkExhaustedSeats();
    const verdict = this.termination.evaluate({
      state: this.state,
      config: this.config,
      wallClockMs: this.nowMs() - this.startedAt,
    });
    const goalId = this.state.activeGoalId;
    if (!goalId) return;
    const goal = this.state.goals.get(goalId);
    if (!goal) return;
    if (verdict.kind === "complete" && goal.status !== "COMPLETED") {
      await this.deps.kernel.emit("goal.completed", { goalId, reason: verdict.reason, evidence: verdict.evidenceSummary }, { actorId: TERMINATION_ACTOR_ID });
      await this.completeMission();
    } else if (verdict.kind === "escalate" && goal.status !== "ESCALATED") {
      await this.escalate({
        reason: verdict.reason,
        raisedBy: "termination-manager",
        detail: verdict.detail,
        supports: verdict.supports,
      });
      await this.deps.kernel.emit("goal.escalated", { goalId, reason: verdict.reason, detail: verdict.detail }, { actorId: TERMINATION_ACTOR_ID });
    } else if (verdict.kind === "fail" && goal.status !== "FAILED") {
      await this.deps.kernel.emit("goal.failed", { goalId, reason: verdict.reason }, { actorId: TERMINATION_ACTOR_ID });
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
    // Phase 1b — stale `review_rounds` primaries. The counter this card reports
    // is deleted the moment the artifact reaches a settled status (see
    // `projections-artifact.ts`), and the detector's own self-healing then
    // forgets the finding — but that only lets it fire AGAIN later, it never
    // closed the card already sitting in front of the operator. So an artifact
    // that was rejected or approved left a card demanding a decision about a
    // review that is over, and — because the stalemate summary supports it —
    // parked the whole mission behind an unanswerable question. Answering the
    // card did not help either: the count survives the answer, so the next
    // review request re-tripped it immediately.
    //
    // Keyed on the artifact being SETTLED, not on the counter being absent:
    // same rule as Phase 1, "gone" is not "answered". A conflictKey naming an
    // artifact the log does not hold is a state/log divergence rather than a
    // resolution, so it keeps its card for the operator.
    for (const esc of [...this.state.escalations.values()]) {
      if (esc.status !== "OPEN" || isDerivedEscalation(esc)) continue;
      const artifactId = reviewRoundsArtifactOf(esc);
      if (!artifactId) continue;
      const artifact = this.state.artifacts.get(artifactId);
      if (!artifact || !isSettledArtifactStatus(artifact.status)) continue;
      await this.deps.kernel.emit(
        "escalation.auto_resolved",
        {
          escalationId: esc.id,
          reason: `auto-resolved: ${artifact.name} settled as ${artifact.status}, so the review it counted rounds for is over`,
          artifactId,
        },
        { actorId: "termination-manager", goalId: esc.goalId },
      );
      retired++;
    }
    // Phase 1c — a seat's budget card whose seat is no longer parked. The raise
    // that un-parked it may not have come through `raiseBudget` (an auto-raise
    // sweep, a raise on a ledger the operator reached by another route), and a
    // card that asks to un-park a working seat has no question left. Not counted
    // in `retired`: these cards never halted the goal, so retiring one resumes
    // nothing.
    for (const esc of [...this.state.escalations.values()]) {
      if (esc.status !== "OPEN") continue;
      const seat = this.seatOfBudgetCard(esc);
      if (!seat) continue;
      const ledger = this.state.budgets.get(agentKey(esc.goalId, seat));
      if (!ledger || ledger.exceeded) continue;
      await this.deps.kernel.emit(
        "escalation.auto_resolved",
        { escalationId: esc.id, reason: `auto-resolved: ${seat}'s budget now covers its spend (${ledger.consumed}/${ledger.limit}), so it is no longer parked`, key: ledger.key },
        { actorId: "termination-manager", goalId: esc.goalId },
      );
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
    // A seat's budget card is excluded for the same reason advisory cards are:
    // it never halted the goal, so it cannot be what keeps the goal halted — the
    // seat stays parked on its own ledger whatever the goal does.
    const stillOpen = [...this.state.escalations.values()].some(
      (e) => e.status === "OPEN" && e.goalId === goalId && !e.advisory && !this.seatOfBudgetCard(e),
    );
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
        ...(finding.kind === "wait_cycle" ? { blockedRequests: this.openRequestsAmong(finding.participants, finding.edges) } : {}),
      },
    });
  }

  /**
   * Has the runtime already broken THIS ring as often as the mesh allows?
   *
   * A break is a repair the first time and a loop the fifth. The note the asker
   * is woken with (see `breakWaitCycle` below) is the entire defence against
   * recurrence, and it is a prompt string — when the model re-asks anyway, the
   * ring rebuilds and every gate that could have noticed has been defeated by
   * the break itself: the nudge ladder is keyed to a messageId the break
   * destroys, `stall_nudge_cap` resets on the recovery activation the break
   * performs, and `halt_neglect` needs a goal that is already ESCALATED.
   *
   * So the count is the only thing that can tell occurrence 5 from occurrence 1,
   * and it has to be the projection's count rather than the detector's, because
   * `DeadlockDetector.reported` is a flag that `scan()` erases the moment the
   * break succeeds. Written by the `deadlock.auto_resolved` reducer.
   *
   * Measured 2026-09-24: `wait_cycle:ui-designer>ux-designer` broke 5 times in
   * 33 minutes, cost 383,402 tokens, and produced zero escalations — while
   * `repeated_conflict.threshold: 3` sat in the config governing a counter that
   * wait cycles never wrote to.
   */
  private waitCycleBreaksSpent(finding: DeadlockFinding): boolean {
    const count = this.state.conflicts.get(finding.conflictKey)?.count ?? 0;
    return count >= this.config.escalation.repeatedConflictThreshold;
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
   * Policy: void the NEWEST ask that is an EDGE of the ring (`finding.edges`).
   * It is the one that closed the ring, its asker has done the least work
   * waiting on it, and dropping it preserves the older (usually more
   * load-bearing) request. "Newest ask between any two members" was not the
   * same thing: measured 2026-09-25, it voided an ask that was not part of the
   * ring at all, on a ring an earlier break had already dissolved.
   *
   * Only an ask whose sole outstanding debtor is its in-ring addressee is a
   * candidate. The ledger voids an ask whole (`deadlock_break` is not a
   * per-debtor discharge), so voiding one also addressed to a seat outside the
   * ring cancelled a question that seat still owed — measured, M3D7536J took
   * a question to ux-designer with it. If every edge is such an ask there is
   * nothing the runtime may void, and the ring goes to the operator.
   *
   * Both sides are told, by mail rather than by wake note: a note is coalesced
   * away when the seat already holds an equal-priority wake (measured: the
   * asker woke never told), and the released debtor was never told at all.
   * Mail waits in the box until a turn reads it.
   *
   * Everything is recorded (`deadlock.auto_resolved` + the notice), so an
   * operator reviewing the log sees exactly what the runtime decided and why.
   * Returns false when nothing could be voided, in which case the caller
   * falls through to the normal escalation path.
   */
  private async breakWaitCycle(finding: DeadlockFinding): Promise<boolean> {
    // Ties on `createdAt` are broken by open order (the map's insertion order,
    // which replay and snapshot import both preserve). Timestamps are
    // millisecond-grained, and two asks opened in the same millisecond used to
    // sort stably — so the OLDER ask could be voided, the ring would not
    // re-form on the next re-ask, and the recurrence count stalled at 1.
    const openOrder = new Map([...this.state.pendingRequests.keys()].map((id, i) => [id, i] as const));
    const edgeAsks = (finding.edges ?? []).flatMap((e) => e.messageIds.map((id) => ({ id, to: e.to })));
    const candidates = edgeAsks
      .flatMap(({ id, to }) => {
        const pr = this.state.pendingRequests.get(id);
        const owed = pr ? outstandingDebtors(pr) : [];
        return pr && owed.length === 1 && owed[0] === to ? [pr] : [];
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || (openOrder.get(b.messageId) ?? 0) - (openOrder.get(a.messageId) ?? 0));
    const victim = candidates[0];
    if (!victim) return false;
    // Read before the discharge deletes the entry.
    const released = outstandingDebtors(victim)[0]!;
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
          note: "newest request on an edge of the cycle was voided so the ring could progress",
        },
        { actorId: "deadlock-detector", goalId: this.state.activeGoalId ?? undefined },
      )
      .catch(() => undefined);
    this.deps.scheduler.resetStallTracking?.(victim.messageId, victim.from);
    // Sent as the operator seat, like the other runtime notices that must reach
    // a seat's mailbox (a dead debtor's asks, an escalation response): human
    // mail is never billed and is never deferred by a seat's own wake policy.
    // `causationId`, never `replyTo` — a reply would claim to answer the ask.
    // Stamped `accrue`, as a withdrawal notice is: it buys no turn of its own.
    // The asker is already woken by `dischargeCommitment` and reads it there;
    // the released debtor reads it on its next turn for any other reason, which
    // is when "you no longer owe this" first matters to it.
    const told = [victim.from, released].filter((id, i, all) => id !== HUMAN_AGENT_ID && this.state.agents.has(id) && all.indexOf(id) === i);
    if (told.length > 0) {
      const thread = this.state.threads.has(victim.threadId) ? victim.threadId : undefined;
      await this.sendMessage({
        from: HUMAN_AGENT_ID,
        to: told,
        type: "INFORM",
        threadId: thread,
        newThread: thread ? undefined : { subject: `voided: ${victim.type} ${victim.messageId}` },
        causationId: victim.messageId,
        payload: {
          voidedRequest: victim.messageId,
          requestType: victim.type,
          asker: victim.from,
          released,
          cycle: finding.participants,
          note:
            `circular wait detected (${finding.participants.join(" -> ")}): ${victim.from}'s ${victim.type} ${victim.messageId} to ${released} was voided so the deadlock could break. ` +
            `${victim.from}: proceed on your own best judgement or ask someone outside the cycle — do not re-ask ${released} the same question. ` +
            `${released}: you no longer owe an answer to it.`,
        },
        priority: "HIGH",
      }, { control: { delivery: "accrue" } }).catch((err) => this.auditLine(`wait cycle ${finding.conflictKey}: void notice for ${victim.messageId} not sent: ${(err as Error).message}`));
    }
    this.auditLine(`wait cycle ${finding.conflictKey} broken by voiding ${victim.messageId} from ${victim.from} (owed by ${released})`);
    return true;
  }

  /**
   * The open asks that form a wait cycle, for the escalation card: the ring's
   * own edges when the finding names them, which is what the card should hold
   * — not every ask that happens to run between two of its members.
   */
  private openRequestsAmong(
    participants: string[],
    edges?: DeadlockFinding["edges"],
  ): Array<{ messageId: string; from: string; to: string[]; type: string; since: string }> {
    const members = new Set(participants);
    const edgeIds = edges ? new Set(edges.flatMap((e) => e.messageIds)) : undefined;
    return [...this.state.pendingRequests.values()]
      .filter((pr) => (edgeIds ? edgeIds.has(pr.messageId) : members.has(pr.from) && outstandingDebtors(pr).some((t) => members.has(t))))
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
    // Deliberately the REAL clock and a real sleep: this bounds how long the
    // event loop is given to settle in-flight promises, not mission time. On an
    // injected clock nobody advances, the deadline would never pass.
    const deadline = Date.now() + timeoutMs;
    while (this.turnInFlight.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (this.turnInFlight.size > 0) {
      this.auditLine(`completion drain timed out with ${this.turnInFlight.size} turn(s) still in flight: ${[...this.turnInFlight].join(", ")}`);
    }
  }

  /** The active goal has ended the mission (completed or failed): a stop now is its end, not an interruption of it. */
  private missionOver(): boolean {
    const goal = this.state.activeGoalId ? this.state.goals.get(this.state.activeGoalId) : undefined;
    return goal?.status === "COMPLETED" || goal?.status === "FAILED";
  }

  private async completeMission(): Promise<void> {
    if (this.completion) return this.completion;
    const run = (async () => {
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
            .emit("agent.completed", { agentId: a.agentId }, { actorId: TERMINATION_ACTOR_ID })
            .catch((err) => this.auditLine(`completion sweep could not retire ${a.agentId} from ${a.lifecycle}: ${(err as Error).message}`));
        }
      }
      await this.stopNow();
    })();
    this.completion = run;
    try {
      await run;
    } finally {
      this.completion = null;
    }
  }

  private onIdle(): void {
    void this.afterActivity();
    for (const cb of this.idleCallbacks) cb();
  }

  private startStallWatch(): void {
    this.stopStallWatch();
    const t = this.timers.setInterval(() => {
      void this.checkStall().catch((err) => this.auditLine(`stall watch error: ${(err as Error).message}`));
    }, Math.min(30_000, Math.max(100, Math.floor(this.config.scheduling.stallIdleMs / 3))));
    (t as unknown as { unref?: () => void }).unref?.();
    this.stallTimer = t;
  }

  private stopStallWatch(): void {
    if (this.stallTimer) {
      this.timers.clearInterval(this.stallTimer);
      this.stallTimer = undefined;
    }
    if (this.stallNoopTimer) {
      this.timers.clearTimeout(this.stallNoopTimer);
      this.stallNoopTimer = undefined;
    }
    this.stallNoopRetryAt = 0;
  }

  /**
   * Close asks whose `dueBy` has passed.
   *
   * Hung on the stall watch's interval rather than the event-driven watchdog
   * on purpose: the watchdog only fires when events flow, and a mesh where
   * every agent is waiting on an ask that will never be answered produces no
   * events at all. That is precisely when a deadline has to fire, so it has
   * to come from a wall clock, not from traffic.
   *
   * Goes through `dischargeCommitment` like every other out-of-reducer close,
   * so the expiry is an event and a replay reproduces it. That also means the
   * asker is woken with a reason instead of finding its open loop quietly
   * gone.
   */
  private async sweepExpiredCommitments(nowMs: number): Promise<void> {
    const overdue = overdueCommitments(this.state, nowMs);
    if (overdue.length === 0) return;
    // Bounded work per tick. A mission that configures a short TTL and then
    // goes quiet can have thousands of asks come due in the same instant;
    // emitting all of them in one pass would block the stall watch behind a
    // write storm. The rest come due again on the next tick — they are, by
    // definition, in no hurry.
    for (const pr of overdue.slice(0, Supervisor.MAX_EXPIRIES_PER_SWEEP)) {
      const overdueMs = nowMs - Date.parse(pr.dueBy!);
      // Same clock, two different endings, and the asker chose which one when
      // it raised the ask. Where it declared what silence would mean, nobody
      // failed and the answer is known -- so this is not an expiry, and
      // recording it as one would settle the thread ESCALATED and leave an
      // operator holding a card over a question that resolved as designed.
      const assumed = pr.ifUnanswered;
      const ok = await this.dischargeCommitment(pr.messageId, assumed ? "defaulted" : "expired", "system", {
        dueBy: pr.dueBy,
        overdueMs,
        // The value the asker gets back, on the event rather than only in the
        // wake note: a replay has to be able to say what was assumed without
        // re-reading the asking message.
        ...(assumed ? { assumed: assumed.assume } : {}),
        // Who was late. Without this the log records that an ask expired but
        // not who failed to answer it, which is the only part an operator can
        // act on.
        unanswered: outstandingDebtors(pr),
      }).catch((err) => {
        this.auditLine(`expiry of ${pr.messageId} failed: ${(err as Error).message}`);
        return false;
      });
      if (ok) {
        this.auditLine(
          `ask ${pr.messageId} (${pr.type}) from ${pr.from} expired ${Math.round(overdueMs / 1000)}s past its deadline, unanswered by ${outstandingDebtors(pr).join(", ")}`,
        );
      }
    }
  }

  /**
   * Close collaborations that ran past their box, and raise a card for each.
   *
   * Wall clock for the same reason `sweepExpiredCommitments` is: a collab
   * that has gone quiet emits no events, and a quiet session past its edge is
   * the exact case worth catching — two agents that stopped talking without
   * ever deciding they were done, holding a thread budget open.
   *
   * The card is ADVISORY. An overrun is not a fault that should halt a
   * mission or block its completion; it is a bill. It names what the session
   * spent and which budget line to read it on, and the operator decides
   * whether that was worth it.
   */
  private async sweepCollabOverruns(nowMs: number): Promise<void> {
    for (const cs of this.state.collabSessions.values()) {
      if (cs.status !== "OPEN") continue;
      const expired = Date.parse(cs.expiresAt) <= nowMs;
      const spent = cs.exchanges >= cs.maxExchanges;
      if (!expired && !spent) continue;
      // Clock first when both are true: a session that sat past its deadline
      // is a different diagnosis from one that talked itself out, and the
      // deadline is the bound the operator actually set.
      const reason = expired ? "expired" : "exchanges_exhausted";
      const spentMs = nowMs - Date.parse(cs.openedAt);
      await this.deps.kernel
        .emit(
          "collab.closed",
          { threadId: cs.threadId, reason, exchanges: cs.exchanges, maxExchanges: cs.maxExchanges, openedAt: cs.openedAt, expiresAt: cs.expiresAt, spentMs },
          { actorId: "system", goalId: cs.goalId },
        )
        .catch((err) => {
          this.auditLine(`collab close of ${cs.threadId} failed: ${(err as Error).message}`);
          return null;
        });
      await this.escalate({
        reason: `collab_overrun:${reason}`,
        raisedBy: "collab-watchdog",
        // Stable, so a session cannot raise a fresh card on every tick. The
        // reducer has already marked it OVERRUN, which is what actually stops
        // the loop; this is the second belt.
        conflictKey: `collab:${cs.threadId}`,
        threadId: cs.threadId,
        participants: cs.participants,
        advisory: true,
        detail: {
          topic: cs.topic,
          openedBy: cs.openedBy,
          participants: cs.participants,
          exchanges: cs.exchanges,
          maxExchanges: cs.maxExchanges,
          openedAt: cs.openedAt,
          expiresAt: cs.expiresAt,
          spentMs,
          budgetKey: cs.budgetKey,
        },
      }).catch((err) => {
        this.auditLine(`collab overrun card for ${cs.threadId} failed: ${(err as Error).message}`);
        return null;
      });
      this.auditLine(
        `collab "${cs.topic}" on ${cs.threadId} (${cs.participants.join(", ")}) ${reason} after ${Math.round(spentMs / 1000)}s and ${cs.exchanges}/${cs.maxExchanges} exchanges`,
      );
    }
  }

  /** Expiries emitted per stall-watch tick. See `sweepExpiredCommitments`. */
  private static readonly MAX_EXPIRIES_PER_SWEEP = 50;

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
    const now = this.nowMs();
    // Before every other gate below. A deadline that passed while a turn was
    // in flight, or while the goal was not ACTIVE, still passed — the early
    // returns further down are about whether to NUDGE, which is a different
    // question from whether an ask is overdue.
    await this.sweepExpiredCommitments(now);
    // Same argument, same tick: a box that expires while a turn is in flight
    // has still expired, so this sits with the commitment sweep ahead of the
    // mission-quiet gates rather than below them.
    await this.sweepCollabOverruns(now);
    // The silence check runs FIRST, before every mission-level guard: a stream
    // frozen after its first token is a stall regardless of goal status and
    // regardless of other scheduler work. Ordered after those guards it was
    // unreachable in exactly the case it exists for — a turn in flight keeps a
    // scheduler running slot occupied, and the ESCALATED/PAUSED goal a stall
    // produces fails the ACTIVE gate — so the frozen turn sat until its
    // 10-20 minute timeout. The mission-quiet gates below only make sense when
    // nothing is in flight, so this branch returns after the silence check.
    if (this.turnInFlight.size !== 0) {
      this.interruptSilentTurns(now);
      return;
    }
    const goalId = this.state.activeGoalId;
    const goal = goalId ? this.state.goals.get(goalId) : undefined;
    if (!goal) return;
    // A non-ACTIVE goal used to end this tick outright, which is the one mission
    // state neither watchdog could see. Everything below is about whether to
    // NUDGE, which a halted mission has no answer to — but "halted and nothing
    // will ever resume it" is a different question, and it is the one that let a
    // live mission sit for 3h04m emitting nothing at all.
    if (goal.status !== "ACTIVE") {
      await this.checkHaltNeglect(now, goal);
      return;
    }
    this.haltNeglectEscalated = false;
    if (this.deps.scheduler.pending() !== 0 || this.deps.scheduler.running() !== 0) return;
    // The provider breaker is holding admissions: the mission is quiet for a
    // reason that already has its card and heals itself. A nudge here would
    // queue behind the breaker and count toward a stall cap that is not a stall.
    // Open only: a half-open breaker with nothing queued WANTS a turn, and the
    // nudge this tick buys is admitted as its probe.
    if (this.deps.scheduler.providerBreaker?.().state === "open") return;
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
    // NUDGE CAP. Everything above has established that the mission still has
    // work (unmet criteria, mail, escalations, claimed tasks), so this path
    // would otherwise nudge forever — and the note that stood here argued that
    // was correct, because a watchdog that gave up on a genuinely stuck mission
    // is a deadlock, not a saving. That objection still holds, and it is why
    // the cap is written the way it is: what it forbids is giving up SILENTLY.
    //
    // After MAX_STALL_NUDGES consecutive nudges that bought no work, the mesh
    // has demonstrated it cannot un-stick itself, and every further nudge pays
    // a full context window to re-prove it (one live run spent 325k tokens
    // learning this the expensive way — see `quiesced`). So the watchdog stops
    // nudging and RAISES AN ESCALATION: the mission surfaces to a human, which
    // is the opposite of a deadlock, and is the only reason a cap is allowed
    // here at all. Stopping without the card would be exactly the deadlock the
    // old note warned about.
    //
    // The card is also the release. While it is OPEN the human owns the
    // mission and the watchdog stays quiet; once it is answered or retired the
    // streak is forgotten and this tick drives again — so an operator decision
    // resumes the mission instead of merely acknowledging it.
    //
    // Chronic no-op AGENTS are still the circuit breaker's job (it parks them
    // and `stallDriver` skips parked agents); this counts the MISSION.
    const capKey = `stall-cap:${goal.id}`;
    if (this.stallNudgeStreak >= MAX_STALL_NUDGES || this.stallRefusalStreak >= MAX_STALL_NUDGES) {
      const open = [...this.state.escalations.values()].some((e) => e.status === "OPEN" && e.conflictKey === capKey);
      if (open) return;
      if (this.stallCapEscalated) {
        this.stallCapEscalated = false;
        this.stallNudgeStreak = 0;
        this.stallRefusalStreak = 0;
        this.auditLine("stall watch: the stall-cap escalation is no longer open — forgetting the streak and driving the mission again");
      } else {
        this.stallCapEscalated = true;
        const unreachable = this.stallRefusalStreak >= MAX_STALL_NUDGES;
        // Seats the MESH parked for terminal failure, if any. "Nudges produced
        // no work" is the symptom; a mesh whose seats are all parked behind
        // lifecycle is a different diagnosis (and a different fix) from one
        // whose driver is ignoring its nudges, and the operator can only choose
        // the right answer if the card carries the difference. This changes
        // only what the card says — the cap fires exactly when it always did.
        const parkedSeats = this.terminalSuspendedSeats();
        const holds = this.standingBlockSentences();
        const acceptance = this.acceptanceSentence();
        const rejected = this.openRejectionNote();
        await this.escalate({
          reason: "stalemate:stall_nudge_cap",
          raisedBy: "stall-watchdog",
          conflictKey: capKey,
          detail: {
            cause: unreachable ? "activations_refused" : "nudges_produced_no_work",
            nudges: this.stallNudgeStreak,
            refusals: this.stallRefusalStreak,
            candidateDriver: this.stallDriver(),
            actionable: actionable.why,
            criteria: this.unmetCriteriaSummary(),
            ...(holds ? { standingBlocks: holds } : {}),
            ...(acceptance ? { awaitingAcceptance: acceptance } : {}),
            ...(rejected ? { openRejections: rejected } : {}),
            ...(parkedSeats.length > 0
              ? {
                  suspendedSeats: parkedSeats,
                  suspendedCause: "terminal_failure",
                  suspendedNote:
                    `${parkedSeats.join(", ")} ${parkedSeats.length === 1 ? "is" : "are"} SUSPENDED because their turns` +
                    ` failed terminally and the mesh parked ${parkedSeats.length === 1 ? "the seat" : "them"} — not because you suspended ${parkedSeats.length === 1 ? "it" : "them"}.` +
                    ` Every wake to a suspended seat is refused by lifecycle, so no nudge can reach ${parkedSeats.length === 1 ? "it" : "them"}` +
                    ` and nothing will move while ${parkedSeats.length === 1 ? "it stays" : "they stay"} down.` +
                    ` Answering this card resumes ${parkedSeats.length === 1 ? "it" : "them"} (and any other seat parked the same way)` +
                    ` and drives the mission again; there is nothing to fix per seat.`,
                }
              : {}),
            note: unreachable
              ? `the watchdog could not schedule any driver ${this.stallRefusalStreak} times running while the mission still had work (${actionable.why}) — a policy, budget or breaker block is holding the mesh, not the mission`
              : `${this.stallNudgeStreak} stall nudges in a row produced no work while the mission still had work (${actionable.why}) — the mesh cannot un-stick itself and needs an operator decision or a rework of the plan`,
          },
        });
        this.auditLine(
          `stall watch: ${unreachable ? `${this.stallRefusalStreak} refused nudges` : `${this.stallNudgeStreak} nudges`} in a row bought no work (${actionable.why}) — escalating to a human and resting until it is answered`,
        );
        return;
      }
    }
    const driver = this.stallDriver();
    if (!driver) return;
    const res = await this.activateAgent(driver, { kind: "timer", note: this.stallWakeNote(driver) });
    if (!res.queued) {
      // A refused fast retry must not pin the mission to the cooldown either:
      // let the next tick try another driver. The activation itself (breaker,
      // policy) is the real limiter.
      if (noopFastRetry) this.stallNoopRetryAt = this.nowMs() + this.config.scheduling.stallNoopRetryMs;
      // The refusal counts against the cap, but on its OWN counter: no agent
      // was woken, so this can never read as "the driver ignored a nudge". The
      // cooldown is still deliberately not consumed — a refusal costs no
      // tokens, and pinning the mission to a 5-minute cooldown for a free
      // non-event is what left it idle until the cooldown lapsed.
      this.stallRefusalStreak++;
      // Activation refused (policy DENY/DEFER, busy, parked): nothing was
      // scheduled, so burning the 5-minute cooldown here would leave the
      // mission idle until it lapses. Retry next tick instead — and say so,
      // so the audit trail shows a mesh that cannot schedule rather than one
      // that is merely quiet.
      this.auditLine(
        `stall watch: mission quiet but driver ${driver} refused (${res.blocked ?? "unknown"}) [refusal ${this.stallRefusalStreak}/${MAX_STALL_NUDGES}] — retrying next tick, cooldown not consumed`,
      );
      return;
    }
    this.lastStallNudgeAt = now;
    this.lastStallDriver = driver;
    // Count only nudges an agent actually got. The refusal branch above owns
    // the other failure; cleared here because a scheduled nudge proves the
    // mesh CAN schedule, whatever the turn then does with it.
    this.stallNudgeStreak++;
    this.stallRefusalStreak = 0;
    if (this.stallNoopTimer) {
      this.timers.clearTimeout(this.stallNoopTimer);
      this.stallNoopTimer = undefined;
    }
    this.stallNoopRetryAt = 0;
    this.auditLine(
      `stall watch: mission quiet for ${Math.round((now - this.lastTurnAt) / 1000)}s, nudging ${driver} (nudge ${this.stallNudgeStreak}/${MAX_STALL_NUDGES})`,
    );
  }

  /**
   * When the current halt began, from the log: the first entry of the trailing
   * run of non-ACTIVE statuses in `goalHistory`. A second `goal.escalated` on an
   * already-halted goal appends to that run without restarting it, and the
   * timestamps are the events' own, so a replay dates the halt identically.
   * Falls back to `now` (nothing counted yet) when the history holds no halt.
   */
  private haltStartedAtMs(now: number): number {
    const history = this.state.goalHistory;
    let at: string | undefined;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].status === "ACTIVE") break;
      at = history[i].at;
    }
    const ms = at ? Date.parse(at) : NaN;
    return Number.isFinite(ms) ? ms : now;
  }

  /**
   * A halted mission that nothing will ever resume.
   *
   * `resumeIfNothingPending` already holds the correct rule — a goal held only
   * by ADVISORY cards has nothing to answer, so it should return to ACTIVE —
   * and it would have released the run this check exists for. It never ran:
   * it is only called from `reconcileDerivedEscalations`'s tail under
   * `if (retired > 0)`, and advisory cards retire nothing. Calling it on a timer
   * instead is deliberately forbidden (a mission may legitimately sit ESCALATED
   * with no card at all, and auto-resuming that would silently undo a halt an
   * operator meant).
   *
   * So this does not resume anything. It mints ONE non-advisory card, which is
   * the thing the mesh was missing: something for a human to answer. Answering
   * or retiring it increments `retired`, which calls `resumeIfNothingPending`,
   * which finds no non-advisory card left and flips the goal ACTIVE — so the
   * card is both the alarm and the release, exactly like the stall-nudge cap.
   *
   * Measured case: nine `runtime_failure` cards, every one advisory, a goal
   * ESCALATED behind them, and 3h04m of silence with no actionable card in
   * existence. A detector keyed on "an open actionable card" would not have
   * fired — the absence of one is the whole fault.
   */
  private async checkHaltNeglect(now: number, goal: Goal): Promise<void> {
    const key = `halt-neglect:${goal.id}`;
    const open = [...this.state.escalations.values()].filter((e) => e.status === "OPEN");
    // Our own card is open: the operator owns the mission, so stay quiet.
    if (open.some((e) => e.conflictKey === key)) return;
    if (this.haltNeglectEscalated) {
      // It was answered or retired. Forget it and let the next tick re-decide —
      // by then `resumeIfNothingPending` has normally flipped the goal ACTIVE.
      this.haltNeglectEscalated = false;
      this.haltWatchFloorAt = now;
      this.auditLine("stall watch: the halt-neglect escalation is no longer open — re-evaluating the halt from scratch");
      return;
    }
    // Measured from the HALT, not from the last turn. `lastTurnAt` is
    // re-stamped by every turn's finally, so a turn that was in flight when
    // the mission halted — the ordinary way a mission halts, a verdict or a
    // card raised mid-turn — restarted the count when it ended.
    const haltedForMs = now - Math.max(this.haltStartedAtMs(now), this.haltWatchFloorAt);
    if (haltedForMs < this.config.scheduling.stallIdleMs * HALT_NEGLECT_IDLE_MULTIPLE) return;
    // Someone genuinely owes an answer. A second card would be spam, and the
    // existing one is already the operator's cue — say it once in the audit and
    // leave it alone.
    // A seat's budget card is answerable, but answering it releases the seat,
    // never the goal (`resumeIfNothingPending` skips it too) — so a halt held
    // only by those is exactly as unreleasable as one held only by advisories.
    const actionable = open.filter((e) => !e.advisory && !this.seatOfBudgetCard(e));
    if (actionable.length > 0) {
      if (!this.haltNeglectNoted) {
        this.haltNeglectNoted = true;
        this.auditLine(
          `stall watch: goal ${goal.id} has been ${goal.status} for ${Math.round(haltedForMs / 1000)}s behind ${actionable.length} open card(s) an operator must answer — not raising a second`,
        );
      }
      return;
    }
    this.haltNeglectEscalated = true;
    this.haltNeglectNoted = false;
    await this.escalate({
      reason: "stalemate:halt_neglect",
      raisedBy: "stall-watchdog",
      conflictKey: key,
      detail: {
        status: goal.status,
        haltedForSeconds: Math.round(haltedForMs / 1000),
        advisoryCards: open.map((e) => e.reason).slice(0, 10),
        advisoryCardCount: open.length,
        criteria: this.unmetCriteriaSummary(),
        note: `the goal has been ${goal.status} for ${Math.round(haltedForMs / 1000)}s behind ${open.length} card(s) that need no answer, so nothing will ever resume it — answer or retire this card to release the mission`,
      },
    });
    this.auditLine(
      `stall watch: goal ${goal.id} ${goal.status} for ${Math.round(haltedForMs / 1000)}s with no card anyone can answer — escalating so the mission can be released`,
    );
  }

  /**
   * A running turn's usage so far, in billed tokens, by turnId. In memory only,
   * like `turnCostEstimate`: it describes a turn in flight, and a restart ends
   * every turn it could describe.
   */
  private liveTurnTokens = new Map<string, number>();

  /**
   * The directory each seat's session was started in (`RuntimeContext.workspacePath`),
   * so a turn's `filesTouched` can be listed relative to it. Refreshed on every
   * session start; absent until the seat has had one, and then paths stay as given.
   */
  private seatWorkspaceRoots = new Map<string, string>();

  /**
   * Record a running turn's CUMULATIVE usage so far.
   *
   * The receiving end of the mid-turn usage feed: `AgentInput.onUsage`, which a
   * streaming runtime calls after each model call (`usage_update` frames, folded
   * by `collectAgentOutput`). Spend was otherwise known only at settle, which is
   * how one tech-lead turn admitted at 99,706/180,000 spent 735,430 before
   * anything could look (NOTES-live-run-20260925 §2). `interruptOverBudgetTurns`
   * is the policy it serves; the turn record's `liveTokens` is the operator's
   * view of the same figure.
   *
   * Converted with `billedTurnTokens`, the rule settlement bills by, so the
   * interrupt compares the seat's headroom with what the turn WILL be charged:
   * `total` plus cache reads at `budgets.cache_read_weight` (0 by default, so
   * plain `total`). A discarded turn is billed by the same rule (see the
   * `finally` of `runTurn`); before that it was billed raw `total`, and at a
   * non-zero weight the interrupt would have stopped a turn for a figure larger
   * than the one its own discard then charged.
   */
  noteLiveUsage(turnId: string, usage: { input?: number; output?: number; total?: number; cacheRead?: number }): void {
    const billed = billedTurnTokens(usage, this.config.budgets?.cacheReadWeight).billed;
    if (!Number.isFinite(billed) || billed < 0) return;
    this.liveTurnTokens.set(turnId, billed);
    this.turns.noteUsage(turnId, billed);
  }

  /**
   * Interrupt a running turn whose live usage has passed what its seat has
   * left, when nothing will raise the seat before the turn settles.
   *
   * Only on the agent ledger's last rung (`onFinalBudgetRung`): below it an
   * overrun is what auto-raise exists to absorb, and the ceiling-level card is
   * the one worth stopping a turn for. The headroom is `limit - consumed`,
   * because the seat's only hold on its own ledger is this turn's. The seat is
   * latched at the same moment, so the retry the interrupt provokes is deferred
   * by the policy's `budget` rule rather than walking back into a door that
   * cannot admit it — and the watchdog carries its card to the operator.
   *
   * Uses the silence watch's interrupt and forced settle, guarded by the same
   * per-turn set so neither watch fires twice on one turn.
   */
  private interruptOverBudgetTurns(): void {
    const goalId = this.state.activeGoalId;
    const active = new Set(this.activeTurnByAgent.values());
    for (const turnId of [...this.liveTurnTokens.keys()]) {
      if (!active.has(turnId)) this.liveTurnTokens.delete(turnId);
    }
    if (!goalId) return;
    for (const agentId of this.turnInFlight) {
      const turnId = this.activeTurnByAgent.get(agentId);
      const session = this.sessions.get(agentId);
      const live = turnId ? this.liveTurnTokens.get(turnId) : undefined;
      if (!turnId || !session || live === undefined) continue;
      if (this.interruptedTurnIds.has(turnId)) continue;
      const key = agentKey(goalId, agentId);
      const ledger = this.state.budgets.get(key);
      if (!ledger || ledger.limit === null || !onFinalBudgetRung(this.state, this.config, key)) continue;
      const headroom = ledger.limit - ledger.consumed;
      if (live <= headroom) continue;
      this.interruptedTurnIds.add(turnId);
      const why = `turn budget exceeded: ${live} live against ${Math.max(0, headroom)} left`;
      this.budgetStops.set(turnId, why);
      this.auditLine(
        `budget: turn ${turnId} for ${agentId} has spent ${live} live against ${Math.max(0, headroom)} left on ${key} (${ledger.consumed}/${ledger.limit}, last rung) — interrupting`,
      );
      void this.deps.budget
        .latchShort(key, { requested: live, headroom: Math.max(0, headroom) }, { actorId: agentId, goalId })
        .catch(() => undefined);
      void session.runtime.interrupt(session.session).catch(() => undefined);
      const t = this.timers.setTimeout(() => {
        if (!this.turnInFlight.has(agentId) || this.activeTurnByAgent.get(agentId) !== turnId) return;
        this.forceSettleTurn.get(turnId)?.(new DOMException(why, "AbortError"));
      }, 2000);
      (t as unknown as { unref?: () => void }).unref?.();
    }
  }

  /**
   * Interrupt a turn that showed signs of life — a token or a tool frame — and
   * then went silent. A turn that has shown none is left alone (pre-first-token
   * thinking), and so is one waiting on a tool call it opened. The interrupt makes
   * the pending send() reject (isTimeoutError → slow), and runTurn's own
   * catch already does the finish/retry bookkeeping; the forced settle below
   * is only for runtimes whose interrupt is a no-op (stub), whose send()
   * would otherwise hang forever. Guarded per turn so neither path double-
   * fires.
   *
   * Interrupting while the goal is ESCALATED or PAUSED is deliberate: the
   * interrupt still aborts the dead stream, but the recovery activation
   * `handleAgentFailure` schedules is refused by `activateAgent` for every
   * non-ACTIVE status, so the retry stays parked until the operator responds
   * to the escalation rather than racing it.
   */
  private interruptSilentTurns(now: number): void {
    // Same tick, same in-flight set, a different reason to stop a turn.
    this.interruptOverBudgetTurns();
    const silenceMs = this.config.scheduling.turnSilenceMs;
    for (const agentId of this.turnInFlight) {
      const turnId = this.activeTurnByAgent.get(agentId);
      const session = this.sessions.get(agentId);
      const phases = turnId ? this.turns.get(turnId)?.phases : undefined;
      // Armed by the first sign of life of ANY kind, token or tool frame. A turn
      // that has shown none is still left to think (a slow first token is not a
      // stall). Once it has, silence is measured against activity of any kind —
      // a turn that stops narrating to spend four minutes writing files is
      // working, not wedged.
      //
      // The entry condition used to be `firstTokenAt`, written when a long tool
      // run was only recognisable as "never spoke". The open-tool-call check
      // below now covers that case directly, and the old gate had become a hole:
      // a seat that works purely through tools never streams a token, so it was
      // never armed at all, and a task holder is extended straight to the
      // work-turn ceiling — a tool-only turn frozen after its last call could
      // sit silent for up to three times the turn timeout (an hour at 20 min).
      const lastAliveAt =
        phases?.firstActivityAt === undefined && phases?.firstTokenAt === undefined
          ? undefined
          : (phases.lastActivityAt ?? phases.lastTokenAt ?? phases.firstActivityAt ?? phases.firstTokenAt);
      if (!turnId || !session || lastAliveAt === undefined) continue;
      if (now - lastAliveAt <= silenceMs) continue;
      // A turn waiting on a tool it announced and has not seen finish is
      // WORKING, not frozen, however long it has been quiet. Stamping activity
      // at the start and end of each call is not sufficient on its own: a single
      // tool that runs longer than the floor looks silent for its whole
      // duration, which is precisely how ten turns died in one live run. The
      // turn timeout remains the outer bound for a tool that never returns.
      if (this.turns.hasOpenToolCall(turnId)) continue;
      if (this.interruptedTurnIds.has(turnId)) continue;
      this.interruptedTurnIds.add(turnId);
      this.auditLine(`stall silence: turn ${turnId} for ${agentId} silent for ${now - lastAliveAt}ms — interrupting`);
      void session.runtime.interrupt(session.session).catch(() => undefined);
      // Real runtimes settle the send() via the abort; a no-op interrupt
      // (stub) leaves it pending forever, so force-settle after a short grace.
      //
      // The settle ends the RUNTIME CALL, not the turn. It used to call
      // `finishTurn` + `handleAgentFailure` from here while `runTurn` was still
      // awaiting the stream: no `turn.discarded`, holds pinned, `turnInFlight`
      // never cleared (so the recovery activation it scheduled was stashed
      // forever), and a late answer then ran its ops and rewrote the failed
      // record -- or a late abort failed the turn a second time.
      const t = this.timers.setTimeout(() => {
        if (!this.turnInFlight.has(agentId) || this.activeTurnByAgent.get(agentId) !== turnId) return;
        // No handle: the call already returned and the turn is past the model,
        // so there is nothing hung to settle.
        this.forceSettleTurn.get(turnId)?.(new DOMException(`turn silence exceeded ${silenceMs}ms`, "AbortError"));
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
    // Before the criteria count, because it is the more specific answer. A stalled
    // merge ladder reads as "N mandatory criteria unmet" otherwise, which is true
    // and tells an operator nothing — the stall-cap card carries this string, and
    // naming the real blocker is the difference between a card someone can act on
    // and a card that restates the mission.
    const pending = this.mergeLadderPending();
    if (pending.length > 0) {
      const first = pending[0]!;
      return {
        worth: true,
        why: `${pending.length} patch(es) stalled on the merge ladder (${first.artifact.name} is ${first.artifact.status}, needs ${first.next})`,
      };
    }
    const mandatory = goal.acceptanceCriteria.filter((c) => c.mandatory);
    // The termination manager's own predicate, not a status test of its own: a
    // diagnosis that calls a criterion met while the verdict does not is a nudge
    // telling the seat "the mission will close itself" on a mission that never will.
    const unmet = mandatory.filter((c) => !criterionSatisfied(goal, c));
    if (unmet.length > 0) return { worth: true, why: `${unmet.length} mandatory criteria unmet${this.standingBlockTag()}` };
    // Every criterion is evidenced. Only a concrete loose end justifies a turn.
    //
    // A rejected patch nobody has closed out is one: the termination verdict will not complete the
    // mission over it, so "the mission will close itself" would be false, and the one seat that can act
    // (the patch's owner) has to be woken for it.
    const rejected = openRejections(this.state, goal.id);
    if (rejected.length > 0) return { worth: true, why: `${rejected.length} rejected patch(es) left open (${rejected[0]!.name} is ${rejected[0]!.status})` };
    const mail = [...this.state.agents.keys()].some((id) => readableMailDepth(this.state, id) > 0);
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
    return { worth: false, why: "all mandatory criteria evidenced, no mail, no open escalations, no claimed tasks, no rejected patches left open" };
  }

  /**
   * The wake note must never contradict itself. It used to always end with
   * "drive the next step toward an unmet criterion" — including when the
   * summary it embedded said "all mandatory criteria evidenced". An agent
   * handed that prompt has one honest answer: `done`. It gave that answer 21
   * times, at full context price, because the instruction described a world
   * that did not exist.
   */
  private stallWakeNote(driver?: string): string {
    const summary = this.unmetCriteriaSummary();
    const base = `stall watchdog: mission active but quiet — ${summary}`;
    // The concrete next move, ahead of any criterion prose. A seat woken with
    // "drive the next step toward an unmet criterion" has to guess; a seat told
    // which patch is parked and what rung it needs has one obvious action. This is
    // the note that would have turned 12.76M tokens of approved-but-unmerged work
    // into a commit.
    const pending = this.mergeLadderPending();
    if (pending.length > 0) {
      const p = pending[0]!;
      const uri = artifactUri(p.artifact.type, p.artifact.name, p.artifact.version);
      const rest = p.next === "MERGED" ? "then `merge` it" : `then keep walking it: VERIFIED -> MERGEABLE -> merge`;
      const who = p.who.length > 0 ? ` (${p.who.join(", ")} may)` : " (no seat in this mesh holds the capability for this rung)";
      return (
        `${base}. A patch is parked on the merge ladder: ${uri} is ${p.artifact.status} and nobody has moved it. ` +
        `Transition it to ${p.next}${who}, ${rest} — nothing advances it automatically.`
      );
    }
    if (!this.hasUnmetMandatory()) {
      // The criteria are all evidenced and the mission still will not close: a rejected patch is open.
      const rejected = this.openRejectionNote();
      if (rejected) return `${base}. ${rejected} Do NOT re-approve or re-confirm finished work.`;
      return `${base}. Do NOT re-approve or re-confirm finished work. Either close out a concrete loose end (unanswered mail, an open escalation, a claimed task), or reply with a single \`done\` op and stop — the mission will close itself.`;
    }
    // A BLOCK that still stands is the most specific thing there is to say about why the
    // criteria are unmet, and it is addressed to the seat that can lift it, which the
    // generic line cannot be. Ahead of the generic line, which still follows.
    const holds = this.standingBlockSentences();
    // Criteria only an acceptance closes, and who can give one: the same placement, ahead of the
    // generic line, which still follows.
    const specific = [holds, this.openRejectionNote(), this.acceptanceSentence(driver)].filter(Boolean).join(" ");
    if (specific) return `${base}. ${specific} Then drive the next step toward an unmet criterion (see Mission acceptance criteria in your context)`;
    return `${base}; drive the next step toward an unmet criterion (see Mission acceptance criteria in your context)`;
  }

  /**
   * The rejected patches that keep the mission open, said to a seat the watchdog wakes: "" when none
   * does. `opMerge` says it once, to the merger; the seat that has to act on a REJECTED patch is the one
   * that was never told, because an approval of a rejected patch moves nothing and a broadcast wakes
   * nobody. Independent of the criteria: they can all be evidenced and the mission still not complete.
   */
  private openRejectionNote(): string {
    const goalId = this.state.activeGoalId;
    const open = goalId ? openRejections(this.state, goalId) : [];
    return open.length > 0 ? `The mission cannot complete while a rejected patch is left open: ${this.openRejectionSentence(open)}.` : "";
  }

  /** The owners of the rejected patches only their owner can move: REJECTED, or reworked and not yet resubmitted. Later steps have seats of their own (reviewers, the merger). */
  private rejectionOwners(): string[] {
    const goalId = this.state.activeGoalId;
    return goalId ? [...new Set(openRejections(this.state, goalId).filter((a) => a.status === "REJECTED" || a.status === "DRAFT").map((a) => a.owner))] : [];
  }

  /**
   * The unmet mandatory criteria, when EVERY one of them is a criterion the mesh does not
   * evidence from its own events: each closes by an acceptance (`approve subject:"criterion:<id>"`)
   * or by nothing. [] when nothing is unmet, or when any unmet criterion is one of
   * `AUTO_EVIDENCED_CRITERIA` — that one has a route of its own (a merge, a design approval, a QA
   * pass) and the work on it is still to do, so "who may accept" is not yet the question.
   */
  private unmetManualCriteria(): AcceptanceCriterion[] {
    const goal = this.state.activeGoalId ? this.state.goals.get(this.state.activeGoalId) : undefined;
    if (!goal) return [];
    const unmet = goal.acceptanceCriteria.filter((c) => c.mandatory && !criterionSatisfied(goal, c));
    return unmet.some((c) => AUTO_EVIDENCED_CRITERIA.includes(c.id)) ? [] : unmet;
  }

  /** The seats that may close a criterion, in roster order. */
  private criterionAcceptors(): string[] {
    return [...this.state.agents.values()]
      .map((r) => r.definition)
      .filter((d) => d.id !== HUMAN_AGENT_ID && mayAcceptCriteria(d.authority))
      .map((d) => d.id);
  }

  /**
   * Submitted artifacts of the active mission that an acceptance could cite, three at most:
   * verification reports first, then whatever was published last. What `recordDecision` would
   * refuse is not offered: a draft, an artifact the operator already rejected for this criterion,
   * a verification report written by a seat that cannot verify.
   */
  private citableEvidence(goalId: GoalId, unmet: readonly AcceptanceCriterion[]): Artifact[] {
    const rejected = new Set(unmet.flatMap((c) => c.rejectedEvidence ?? []));
    const isReport = (a: Artifact): number => (VERIFICATION_ARTIFACT_TYPES.includes(a.type) ? 1 : 0);
    return [...this.state.artifacts.values()]
      .filter(
        (a) =>
          a.goalId === goalId &&
          a.status !== "DRAFT" &&
          a.status !== "REJECTED" &&
          a.status !== "ARCHIVED" &&
          !rejected.has(artifactUri(a.type, a.name, a.version)) &&
          // Nor one the acceptance would be refused for: a report written by a seat that cannot verify.
          !unqualifiedAuthor(this.state, a),
      )
      .sort((a, b) => isReport(b) - isReport(a) || b.createdAt.localeCompare(a.createdAt))
      .slice(0, 3);
  }

  /**
   * What to say about criteria only an acceptance can close, addressed to `driver` when known.
   * "" when something the mesh evidences itself is also unmet (see `unmetManualCriteria`).
   *
   * The fourth cronlite run's second round stalled for 21 minutes, 12 turns and 188k tokens on
   * one criterion, the `operator-feedback-…` one a reopen mints. Only the pm can close it, and
   * the watchdog's note said "drive the next step toward an unmet criterion" to whichever seat
   * had mail: the architect, twice, which asked the developer for a status and started a chain of
   * turns that went round the mission without ever reaching the one seat whose act it needed.
   * The pm, when it was finally woken, had already written "awaiting operator acceptance testing":
   * it did not know the act was its own, and a QA report that would have served had been
   * submitted for some time.
   */
  private acceptanceSentence(driver?: string): string {
    const goalId = this.state.activeGoalId;
    const unmet = this.unmetManualCriteria();
    if (!goalId || unmet.length === 0) return "";
    const ids = unmet.slice(0, 3).map((c) => c.id).join(", ") + (unmet.length > 3 ? ", …" : "");
    const acceptors = this.criterionAcceptors();
    if (acceptors.length === 0) {
      return (
        `${ids} ${unmet.length === 1 ? "closes" : "close"} only by an acceptance, and no seat in this mesh holds requirements.accept or requirements.approve: ` +
        `only the operator can close ${unmet.length === 1 ? "it" : "them"}, and no nudge to a seat changes that.`
      );
    }
    const citable = this.citableEvidence(goalId, unmet);
    const cite =
      citable.length > 0
        ? `Submitted and citable: ${citable.map((a) => `${a.type} "${a.name}" v${a.version} (${a.id}, by ${a.owner}, ${a.status})`).join("; ")}.`
        : "Nothing has been submitted that could be cited yet.";
    if (driver !== undefined && acceptors.includes(driver)) {
      return (
        `The mesh does not evidence ${unmet.length === 1 ? "this criterion" : "these"} from its own events (${ids}): ${unmet.length === 1 ? "it closes" : "each closes"} only when a seat that may accept approves it ` +
        `— and you may, so the acceptance is yours to give, not something to wait for another seat to do. ` +
        `Close one with \`mesh_approve\` { subject: "criterion:<id>", artifactId: "<the submitted artifact that proves it>", comment: "why it proves it" }. ${cite} ` +
        `If none of it proves the criterion yet, what is missing is the proof and not an acceptance: ask the seat that can produce it, and accept once it is submitted.`
      );
    }
    // No driver is the stall-cap card, which is read by the operator: same facts, not addressed to a seat.
    const advice = driver === undefined ? "" : `, which you cannot give: put the proof in front of ${acceptors.length === 1 ? acceptors[0] : "one of them"} and ask`;
    return (
      `${ids} ${unmet.length === 1 ? "closes" : "close"} only by an acceptance from ${acceptors.join(" or ")} ` +
      `(\`approve\` on subject "criterion:<id>" citing a submitted artifact that proves it)${advice}. ${cite}`
    );
  }

  /** The seat that can lift `b`: the artifact's owner for a block on an artifact (a new version), else the blocker. */
  private blockLifter(b: StandingBlock): string {
    return b.artifact ? b.artifact.owner : b.record.actorId;
  }

  /**
   * One sentence per standing BLOCK (two at most), saying what holds, since when, and who can
   * lift it and how. "" when none stands or nothing is unmet, because a mission whose criteria
   * are all evidenced closes itself whatever a block record says.
   *
   * The two holds are lifted differently (see `standingBlocks`), and a nudge that says only
   * "drive the next step" sends the seat it wakes to do the next thing it thinks of: the
   * second cronlite run's nudges went to the tech-lead, the pm and the developer while QA's
   * block stood, and none of them could lift it.
   */
  private standingBlockSentences(): string {
    if (!this.hasUnmetMandatory()) return "";
    const blocks = standingBlocks(this.state);
    if (blocks.length === 0) return "";
    const since = (b: StandingBlock): string => b.record.recordedAt.replace(/\.\d+Z$/, "Z");
    const said = blocks.slice(0, 2).map((b) => {
      const by = b.record.actorId;
      if (b.artifact) {
        const a = b.artifact;
        return (
          `${by}'s BLOCK on ${a.type} "${a.name}" v${a.version} (since ${since(b)}) still stands: it cannot advance until ${a.owner} publishes a new version that answers it ` +
          `(a new version starts its review over, and ${by}'s later pass would not release it).`
        );
      }
      return (
        `${by}'s BLOCK on ${b.record.subject} (since ${since(b)}) still stands, and what it gates cannot complete while it does: only ${by} can lift it, ` +
        `by re-verifying the CURRENT product (bring the worktree up to main first) and passing ${b.record.subject} if it holds, or blocking again and saying what is still wrong.`
      );
    });
    if (blocks.length > 2) said.push(`(${blocks.length - 2} more standing BLOCK${blocks.length - 2 === 1 ? "" : "s"}.)`);
    return said.join(" ");
  }

  /** " (held by qa's BLOCK on quality)" for the `why` of a stalled mission, or "". */
  private standingBlockTag(): string {
    const blocks = standingBlocks(this.state);
    if (blocks.length === 0) return "";
    const first = blocks[0]!;
    const what = first.artifact ? `${first.artifact.type} "${first.artifact.name}"` : first.record.subject;
    return ` (held by ${first.record.actorId}'s BLOCK on ${what}${blocks.length > 1 ? `, and ${blocks.length - 1} more` : ""})`;
  }

  /**
   * CodePatches parked partway up the merge ladder, and who could move each one.
   *
   * The merge path is fully implemented and was never invoked. `APPROVED → VERIFIED
   * → MERGEABLE → MERGED` is a strict ladder with no auto-advance anywhere, `opMerge`
   * refuses anything that is not already MERGEABLE, and nothing in the runtime — no
   * nudge, no watchdog, no context line — ever told a seat that a patch was sitting
   * at APPROVED waiting for it. One live mission spent 12.76M tokens, approved a
   * CodePatch with green tests, and finished with `workspace/main` holding a README
   * and the scaffold commit. `patch.merged` events: zero.
   *
   * So this is the missing signal, and it is deliberately read-only state: three
   * existing surfaces consume it rather than a new mechanism being added.
   */
  private mergeLadderPending(): Array<{ artifact: Artifact; next: ArtifactStatus; who: string[] }> {
    const out: Array<{ artifact: Artifact; next: ArtifactStatus; who: string[] }> = [];
    // A patch under a BLOCK is not parked on the ladder, it is held: the policy refuses the
    // next rung until a new version exists, so nudging the seat that could "merge it" buys a
    // refusal. `standingBlockSentences` names the real blocker instead.
    const held = new Set(standingBlocks(this.state).flatMap((b) => (b.artifact ? [b.artifact.id] : [])));
    for (const a of this.state.artifacts.values()) {
      if (a.type !== "CodePatch") continue;
      if (held.has(a.id)) continue;
      if (a.status !== "APPROVED" && a.status !== "VERIFIED" && a.status !== "MERGEABLE") continue;
      const next = (CODE_ARTIFACT_TRANSITIONS[a.status] ?? [])[0];
      if (!next) continue;
      // Who the transition rules would actually accept for the next rung. Derived
      // from capabilities rather than hardcoded so it cannot drift from the gate.
      const who = [...this.state.agents.values()]
        .map((r) => r.definition)
        .filter((d) => {
          if (d.id === HUMAN_AGENT_ID) return false;
          if (next === "MERGED") return d.capabilities.includes("git.merge");
          if (next === "VERIFIED") {
            return (
              d.capabilities.includes("test.execute") ||
              d.capabilities.includes("security.review") ||
              holdsAuthority(d.authority, "implementation", "approve")
            );
          }
          // MERGEABLE has no actor rule of its own: anyone who can transition may.
          return true;
        })
        .map((d) => d.id);
      out.push({ artifact: a, next, who });
    }
    return out;
  }

  /** True when at least one mandatory criterion still lacks evidence. */
  private hasUnmetMandatory(): boolean {
    const goal = this.state.activeGoalId ? this.state.goals.get(this.state.activeGoalId) : undefined;
    if (!goal) return false;
    return goal.acceptanceCriteria.some((c) => c.mandatory && !criterionSatisfied(goal, c));
  }

  /** Who to wake for a stalled mission: someone with real work, else rotate across the stuck. */
  private stallDriver(): string | undefined {
    const eligible = (id: string): boolean => {
      const rec = this.state.agents.get(id);
      if (!rec || id === HUMAN_AGENT_ID) return false;
      if (["SUSPENDED", "COMPLETED", "FAILED", "RETIRED"].includes(rec.state.lifecycle)) return false;
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
    // A seat that can move a parked patch outranks the mail/task heuristic. Waking
    // someone with mail is a good default, but if the mission's only real blocker is
    // a patch nobody has advanced, the seat that CAN advance it is the one turn worth
    // buying — and it is not usually the seat with mail.
    const pending = this.mergeLadderPending();
    if (pending.length > 0) {
      for (const p of pending) {
        const mover = p.who.filter(eligible).sort(byOldest)[0];
        if (mover) return mover;
      }
    }
    // A rejected patch nobody has closed out, which only its owner can move: REJECTED, or reworked and
    // not yet resubmitted. Its owner, ahead of the seat with mail: the sixth cronlite run's CLI patch
    // sat REJECTED after the library merged, and the one seat that could resubmit it was never woken.
    for (const owner of this.rejectionOwners().filter(eligible).sort(byOldest)) {
      if (owner === this.lastStallDriver && this.stallNudgeStreak > 0) continue;
      return owner;
    }
    // A standing BLOCK, while the mission still has something unmet: the seat that can lift
    // it. Ahead of "whoever has mail", which returned the first seat in config order with any,
    // and so woke the pm and the developer while QA's block stood. Not a seat whose previous
    // nudge bought nothing: it was just told, and the next one gets its turn before the cap.
    if (this.hasUnmetMandatory()) {
      for (const b of standingBlocks(this.state)) {
        const lifter = this.blockLifter(b);
        if (!eligible(lifter)) continue;
        if (lifter === this.lastStallDriver && this.stallNudgeStreak > 0) continue;
        return lifter;
      }
    }
    // Everything still unmet is closed by an acceptance and nothing else: the seat that may
    // accept. Ahead of "whoever has mail", which woke the architect twice while the pm, the only
    // seat that could close the last criterion, sat WAITING. Rotated the way the block branch
    // is: an acceptor whose nudge just bought nothing gives the next one to another seat.
    if (this.unmetManualCriteria().length > 0) {
      for (const id of this.criterionAcceptors().filter(eligible).sort(byOldest)) {
        if (id === this.lastStallDriver && this.stallNudgeStreak > 0) continue;
        return id;
      }
    }
    for (const id of all) {
      const rec = this.state.agents.get(id)!;
      if (readableMailDepth(this.state, id) > 0 || rec.state.activeTaskId) return id;
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
    const unmet = mandatory.filter((c) => !criterionSatisfied(goal, c));
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
    await this.dischargeCommitment(stuck.messageId, "operator", by, { escalationId, action: "dropped", note: reason });
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
    agents: Array<{
      id: string; role: string; lifecycle: LifecycleState; mailbox: number; tokens: number;
      taskId: string | null; activations: number;
      /**
       * Scalar projection of the agent's private plan, for the dashboard's card
       * badge. Deliberately NOT the plan itself: this payload is polled for
       * every agent at once, so a growing array does not belong here. The full
       * steps stay on the per-agent detail fetch.
       */
      planDone: number | null; planTotal: number; planTaskId: string | null;
    }>;
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
        mailbox: readableMailDepth(this.state, r.definition.id),
        tokens: r.state.tokensConsumed,
        taskId: r.state.activeTaskId ?? null,
        activations: r.state.activations,
        planDone: r.state.plan ? r.state.plan.steps.filter((s) => s.status === "DONE").length : null,
        planTotal: r.state.plan?.steps.length ?? 0,
        planTaskId: r.state.plan?.taskId ?? null,
      })),
      budgets: this.deps.budget.snapshot(),
      progress: progress ? { completed: progress.completed, total: progress.total, ratio: progress.ratio } : null,
      openEscalations: [...this.state.escalations.values()].filter((e) => e.status === "OPEN"),
      eventCount: this.state.eventCount,
    };
  }
}

export class RuntimeFailure extends Error {
  /**
   * What the backend reported spending before the failure, when it reported at
   * all: a backend that measured the turn and then answered with an error still
   * spent those tokens. (The turn TIMEOUT no longer comes through here — it is a
   * `TurnTimeoutError`, so the failure path can tell it from a crash.)
   *
   * Absent means unmeasured, never zero — the same convention as
   * `InterruptedTurnError.tokensUsed`, which the cost sites depend on. Typed as
   * `TurnUsage` so the cache and thinking split the adapter reports survives.
   */
  readonly tokensUsed?: TurnUsage;

  constructor(message: string, tokensUsed?: TurnUsage) {
    super(message);
    this.name = "RuntimeFailure";
    this.tokensUsed = tokensUsed;
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
 * MCP tools and prose `mesh-json` ops declare artifact refs as plain
 * `artifact://` strings; the message schema requires `{uri,...}` objects and
 * `validateMessage` rejects a bare string. Normalize at the one choke point
 * every send passes through, passing proper object refs through untouched.
 *
 * `resolve` turns a ref that is NOT already an `artifact://` URI — an `art-…`
 * id, a `file://` content ref — into the URI of the artifact it names, on
 * object refs and strings alike. What it cannot resolve is left as given, so
 * validation still refuses it by name rather than the ref vanishing silently.
 */
function normalizeArtifactRefs(refs: unknown, resolve?: (ref: string) => string | undefined): ArtifactRef[] | undefined {
  if (!Array.isArray(refs)) return undefined;
  const uriOf = (u: string): string => (resolve && !u.startsWith("artifact://") ? resolve(u) ?? u : u);
  return refs.map((ref) => {
    if (typeof ref === "string") return { uri: uriOf(ref) };
    const r = ref as ArtifactRef;
    return r && typeof r.uri === "string" && resolve && !r.uri.startsWith("artifact://") ? { ...r, uri: uriOf(r.uri) } : r;
  });
}

/**
 * Did the mesh actually MOVE? These are the events that mean a human or an
 * agent introduced something new — as opposed to the mesh narrating its own
 * idling. Only these reset quiescence, so a rested mesh wakes for real work
 * and stays quiet for its own heartbeat.
 */
/**
 * Did this TURN move the mesh?
 *
 * Wider than `isProgressEvent`, and deliberately so: that predicate answers
 * "should quiescence reset", which verdicts do not need to do. This one
 * answers "did the seat do anything", and a reviewer whose whole turn is
 * approvals did. In a live run tech-lead approved three design artifacts
 * through `mesh_approve`, emitted no ops block, and was logged `turn.discarded
 * — nothing was sent, published, or requested`. Its approvals were durable the
 * whole time.
 *
 * Derived transitions are excluded: `auditTransition` emits them as `system`
 * bookkeeping after a verdict that is already counted here, so counting both
 * would score one act twice.
 */
/**
 * Did the backend run the model this seat asked for?
 *
 * Alias-tolerant on purpose: a config says `sonnet`, the CLI reports
 * `claude-sonnet-5`, and those are the same request. Compared on the last
 * `/`-separated segment, lowercased, with a containment test either way, so
 * `opencode-go/deepseek-v4.1-flash` does not match `sonnet` (the substitution
 * this exists to catch) while a versioned id does match its alias.
 *
 * An unparseable value returns true: this is a warning, and a warning that
 * fires on a naming convention it did not anticipate is worse than none.
 */
function modelMatches(configured: string, actual: string): boolean {
  const tail = (s: string) =>
    (s.trim().toLowerCase().split("/").pop() ?? s.trim().toLowerCase()).trim();
  const c = tail(configured);
  const a = tail(actual);
  if (!c || !a) return true;
  return c === a || a.includes(c) || c.includes(a);
}

function isTurnEffect(event: MeshEvent): boolean {
  if (isProgressEvent(event.type)) return true;
  switch (event.type) {
    case "review.approved":
    case "review.rejected":
    case "architecture.approved":
    case "review.requested":
    case "patch.ready":
    case "patch.merged":
    case "implementation.completed":
    case "research.completed":
    case "requirement.satisfied":
    case "design.question":
      return true;
    case "continuity.recorded":
      // A handover turn has exactly one thing it is allowed to do, and this is
      // it. Left out, the only legitimate work a handover can perform is
      // invisible to the measure — so a seat that wrote its continuity through
      // the MCP tool rather than the `write_continuity` op looked idle, and was
      // told so (2026-09-25: 3 handovers of 9).
      return true;
    case "artifact.transition":
      return (event.payload as { derived?: boolean }).derived !== true;
    default:
      return false;
  }
}

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

function isBookkeepingEvent(type: EventType): boolean {  switch (type) {
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

/**
 * Extract the artifact from a `deadlock:review_rounds` card. The conflictKey is
 * the authoritative identity here — the detector builds it as
 * `review_rounds:<artifactId>` and `escalate()` is called with it verbatim — so
 * there is no detail-shaped fallback to drift from.
 */
function reviewRoundsArtifactOf(esc: Escalation): string | null {
  const m = /^review_rounds:(.+)$/.exec(String(esc.conflictKey ?? ""));
  return m ? m[1] : null;
}

/** The `reason` on the provider breaker's card. */
export const PROVIDER_UNAVAILABLE_REASON = "provider_unavailable";

/** One provider card per goal: the identity the breaker restates and retires. */
export function providerCardKey(goalId: string): string {
  return `provider:${goalId}`;
}

/**
 * `cause` on the SUSPENDED transition `handleAgentFailure` writes when it
 * parks a seat after a terminal failure: the durable half of
 * `Supervisor.terminalSuspended`.
 */
export const TERMINAL_FAILURE_CAUSE = "terminal_failure";

/**
 * `cause` on what the mesh writes when a turn was ended by the process shutting
 * down rather than by anything the seat did: the IDLE close of a turn
 * `shutdown()` stopped (`closeShutdownStoppedTurn`), and the `agent.restarted` +
 * IDLE with which boot restores a seat an earlier process left FAILED mid-way
 * through handling such a turn (`restoreShutdownCasualties`).
 */
export const MESH_SHUTDOWN_CAUSE = "mesh_shutdown";

/** The note every terminal-failure park has carried since the park was added (5059bfe). */
const LEGACY_TERMINAL_FAILURE_NOTE = "terminal failure:";

/**
 * Is this lifecycle event the MESH parking a seat after a terminal failure,
 * as opposed to the operator suspending it?
 *
 * The one place a suspension is classified from the log, and only boot asks
 * it (`rebuildTerminalSuspended`). Live, the classification is recorded where
 * it is decided; this exists because that record is process memory, and after
 * a restart the log is all there is.
 *
 * The two shapes, from every emitter there has been:
 * - the park: `agent.state_changed` `{ to: "SUSPENDED", cause:
 *   "terminal_failure", note: "terminal failure: <error>" }`. Logs written
 *   before `cause` existed carry only the note, so its fixed prefix is read as
 *   the legacy marker. That is sound only because nothing else has ever
 *   written `agent.state_changed` into SUSPENDED, and the park's note has had
 *   this prefix from the start.
 * - the operator: `agent.suspended` — the pause / `POST /agents/:id/suspend` /
 *   staged suspend (`suspendAgent`, `{ agentId }`) and a stop with `suspend:
 *   true` (`suspendAfterStop`, `{ agentId, note: <stop detail>, turnId }`).
 *   Never the park, whatever its note says.
 *
 * Anything else is false: a suspension nobody recognises degrades to "resume
 * it by hand", never to reviving a seat someone meant to keep down.
 */
export function isTerminalFailureSuspension(event: Pick<MeshEvent, "type" | "payload">): boolean {
  if (event.type !== "agent.state_changed") return false;
  const p = (event.payload ?? {}) as { to?: unknown; cause?: unknown; note?: unknown };
  if (p.to !== "SUSPENDED") return false;
  if (p.cause === TERMINAL_FAILURE_CAUSE) return true;
  return typeof p.note === "string" && p.note.startsWith(LEGACY_TERMINAL_FAILURE_NOTE);
}

/**
 * Is this agent-ledger `budget.consumed` row a settled turn's charge — the
 * amount `noteTurnCost` was handed live? The ledger has two other charges and
 * both are marked, which is what makes this a negative test: a discarded
 * turn's billing carries `discarded: <reason>`, and the interrupt tariff
 * `reason: "interrupt"`. The settled row carries neither.
 */
function isSettledTurnCharge(p: { discarded?: unknown; reason?: unknown }): boolean {
  return p.discarded === undefined && p.reason === undefined;
}

/**
 * The provider card's body. Written for the operator deciding whether to act:
 * what the provider said (verbatim), how much it cost, who was hit, and what
 * the mesh will do next and when — including that nothing was parked, which is
 * the one thing the old per-seat cards could not say.
 */
function providerCardDetail(s: ProviderBreakerSnapshot, state: "open" | "half_open", nowMs: number): Record<string, unknown> {
  const iso = (ms: number): string => new Date(ms).toISOString();
  const nextAttemptAt = state === "open" && s.nextProbeAt ? iso(s.nextProbeAt) : iso(nowMs);
  const seats = s.seats.join(", ") || "no seat";
  const when =
    state === "half_open"
      ? `It is probing now: the next turn admitted is the probe${s.probe ? ` (${s.probe})` : ""}, and every other seat waits for its answer.`
      : `It will admit ONE turn as a probe at ${nextAttemptAt} (backoff ${Math.round(s.backoffMs / 60_000)} min${s.opens > 1 ? `, doubled after ${s.opens - 1} failed probe(s)` : ""}) and resume every seat on its own if that turn succeeds.`;
  return {
    breaker: state,
    error: s.lastError,
    failedTurns: s.failedTurns,
    seats: s.seats,
    openedAt: s.openedAt ? iso(s.openedAt) : undefined,
    opens: s.opens,
    backoffMs: s.backoffMs,
    nextAttemptAt,
    ...(s.probe ? { lastProbe: s.probe } : {}),
    note:
      `The model provider refused ${s.failedTurns} turn(s) from ${seats}: "${s.lastError.slice(0, 400)}". ` +
      `The mesh stopped admitting turns rather than failing each seat: no seat was suspended, no ask was discharged, and no work was released. ` +
      `${when} Answer this card to probe immediately (e.g. once the account is topped up or the proxy is back).`,
  };
}

/**
 * The one line the seat reads to learn why it is awake, so it is load-bearing
 * rather than cosmetic: a gathered wake that says only "new mail arrived" gets
 * one message answered and leaves the rest owed a turn each. Exported for the
 * same reason its neighbours below are — it is a pure function of the reason,
 * and its wording is what the model acts on.
 */
export function describeReason(reason: ActivationReason): string {
  switch (reason.kind) {
    case "startup":
      // The note is the kickoff brief (goLive embeds the criteria gap here);
      // dropping it hid the "why" from the very first turn.
      return `Startup activation: begin your mission role.${reason.note ? ` ${reason.note}` : ""}`;
    case "message":
      return `New mail arrived${reason.threadId ? ` in thread ${reason.threadId}` : ""}.${reason.note ? ` ${reason.note}` : ""}`;
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
