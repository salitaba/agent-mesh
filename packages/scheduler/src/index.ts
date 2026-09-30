import type { ActivationReason, Clock, MeshEvent, MeshMessage, EventType, LifecycleState, PolicyDecisionResult, TimerHandle, Timers } from "../../protocol/src/index";
import { movesWorkMessage, obligesRecipients, systemClock, timersOf } from "../../protocol/src/index";
import type { ResolvedMeshConfig } from "../../config/src/index";
import { interestMatches } from "../../config/src/index";
import type { Projections } from "../../core/src/state";
import { readableMailDepth, resolveUnread, stillOwes } from "../../core/src/state";
import type {
  PolicyEvaluator,
  ProviderBreakerSnapshot,
  ProviderBreakerState,
  ProviderBreakerTransition,
  QueueWait,
  SchedulerActivationRequest,
  SchedulerPort,
  TurnOutcome,
  TurnOutcomeDetail,
} from "../../core/src/ports";

export interface TurnRunner {
  runTurn(agentId: string, reason: ActivationReason): Promise<void>;
  escalateStuckRequest?(agentId: string, messageId: string): Promise<void>;
  /**
   * True while the runner has an unfinished turn for the agent. The scheduler
   * must treat this like `runningMap`: queueing another turn for a mid-flight
   * agent makes runTurn bail out instantly, and that instant finish requeues —
   * a timer-free microtask loop that starves HTTP (full wedge, 100% CPU).
   */
  isTurnInFlight?(agentId: string): boolean;
  /**
   * A policy refusal the operator should be told about. The scheduler has no
   * event channel of its own, so refusals travel back through the runner (the
   * Supervisor) the same way `escalateStuckRequest` does. Optional like the
   * other callbacks: a scheduler wired to a bare runner still schedules, it
   * just cannot narrate.
   */
  reportActivationDenied?(agentId: string, decision: PolicyDecisionResult, reason: ActivationReason): Promise<void>;
  /**
   * The provider breaker changed state. The scheduler only gates admission;
   * the card, the audit line and a probe seat when none is queued are the
   * runner's, for the same reason `escalateStuckRequest` is.
   */
  onProviderBreaker?(transition: ProviderBreakerTransition): Promise<void>;
}

/**
 * The provider breaker's trip: this many provider-outage turn failures, from
 * any seats, inside this window.
 *
 * Three in two minutes because both observed outages were total and fast — a
 * 429 on 855 of 1,023 calls, then a 402 on every seat — with each seat failing
 * four times in ~90s. Three trips within seconds of onset, before any seat
 * would have spent its own ladder, while a healthy mesh sees none at all: a
 * seat's own fault (a 400, a tool crash, a timeout) never counts, so the only
 * way to reach three is the provider refusing turns. Across ANY seats, not N
 * distinct ones: a quiet mesh often has one seat working, and requiring a
 * second to fail too would leave that seat to walk the very ladder this
 * replaces.
 */
export const PROVIDER_TRIP_FAILURES = 3;
export const PROVIDER_TRIP_WINDOW_MS = 120_000;
/**
 * Backoff before the first probe, doubling on each failed probe up to the cap:
 * 5, 10, 20, 40, 60, 60 … minutes. The shortest outages seen (a usage window
 * resetting) cleared in minutes and the longest (an unfunded account) needed a
 * human; five minutes costs one probe turn per window at most, and the hour
 * cap still answers an account topped up without anyone touching the mesh. An
 * operator answering the card skips the wait entirely.
 */
export const PROVIDER_BACKOFF_INITIAL_MS = 300_000;
export const PROVIDER_BACKOFF_MAX_MS = 3_600_000;

/** The backoff for the `opens`-th opening of one episode (1-based). */
export function providerBackoffMs(opens: number): number {
  return Math.min(PROVIDER_BACKOFF_MAX_MS, PROVIDER_BACKOFF_INITIAL_MS * 2 ** Math.max(0, opens - 1));
}

interface ProviderBreaker {
  state: ProviderBreakerState;
  /** Outage failures while closed, inside the trip window. */
  recent: Array<{ at: number; agentId: string }>;
  openedAt: number;
  failedTurns: number;
  seats: string[];
  lastError: string;
  opens: number;
  backoffMs: number;
  nextProbeAt: number;
  /** The dispatch admitted as the probe while half-open; identity, as in `notifyTurnFinished`. */
  probeItem?: QueueItem;
  /** The seat of the last probe, kept for the snapshot after its verdict. */
  probe?: string;
}

function closedProviderBreaker(): ProviderBreaker {
  return { state: "closed", recent: [], openedAt: 0, failedTurns: 0, seats: [], lastError: "", opens: 0, backoffMs: 0, nextProbeAt: 0 };
}

export interface TriageModel {
  classify(agentId: string, event: MeshEvent): Promise<"IGNORE" | "SKIM" | "ACT">;
}

interface QueueItem {
  agentId: string;
  reason: ActivationReason;
  priority: number;
  enqueuedAt: number;
  explicit?: boolean;
  /** An operator wake; the only kind the provider breaker admits (`providerHolds`). */
  operator?: boolean;
}

const MAX_NUDGES = 3;

/**
 * Why an interest wake was deliberately not requested. Each is a cost control
 * the scheduler stands by; what none of them may do is decide silently, because
 * an unrecorded drop is indistinguishable from a seat that was never subscribed.
 *
 * - `triage_ignore`: a triage rule (or model) judged the event IGNORE.
 * - `goal_escalated`: the goal is ESCALATED and waiting on a human, so no seat
 *   is woken for anything but the escalation itself and its response.
 * - `redundant_observation`: a progress-style event for a seat with no mail,
 *   task or owed request — see `isRedundantObservation`.
 * - `mail_echo`: an event raised BY a message to this seat (`research.requested`
 *   for a `REQUEST_RESEARCH`, carrying its `messageId`), arriving while the seat
 *   is mid-turn. The message has its own wake; see the busy check in
 *   `handleEvent`.
 * - `stale_request`: an interest wake for an event about an ask that had closed
 *   (answered, superseded, withdrawn, voided) by the time the wake reached the
 *   head of the queue. Counted at DEQUEUE, unlike the others; see `pump`.
 * - `stale_mail`: a wake for mail the seat had been handed, by another turn, by
 *   the time the wake reached the head of the queue. Also counted at dequeue,
 *   and the only entry here that is not an interest wake; see `isStaleMailWake`.
 */
export type SuppressedWakeReason = "triage_ignore" | "goal_escalated" | "redundant_observation" | "mail_echo" | "stale_request" | "stale_mail";

/**
 * A wake the operator can read on the scheduler's queue view. `afterTurn` marks
 * one held in `wakeAfterTurn` behind the seat's running turn rather than
 * waiting in the dispatch queue: it is not counted by `pending()` (it cannot be
 * dispatched while the turn runs), but it IS owed, and a view that left it out
 * made a stashed wake indistinguishable from a lost one.
 */
export interface QueueSnapshotEntry {
  agentId: string;
  priority: number;
  reason: ActivationReason;
  afterTurn?: true;
}

/**
 * Events that only REPORT progress; they carry no request and assign no work.
 * Waking an otherwise-idle subscriber for one costs a full model turn and can
 * produce nothing but "noted". Deliberately narrow: anything that could carry
 * an assignment, a verdict or a question is absent from this set.
 */
const OBSERVATIONAL_EVENTS: ReadonlySet<string> = new Set([
  "goal.progress",
  "requirement.satisfied",
  "budget.consumed",
  "budget.reserved",
  "budget.released",
  "message.delivered",
  "agent.state_changed",
]);

/**
 * Fallback gathering window for `deliver` mail on a mesh that declares none.
 *
 * Reachable on replay and after a config edit: the class is stamped on the
 * envelope at send time and outlives the config that produced it, exactly as
 * a collab's bounds do. Honouring the class with a default window is the only
 * answer that keeps a replay reproducing the run it is replaying.
 */
const DEFAULT_COALESCE_MS = 60_000;

/**
 * How long mail may sit unread before it buys a turn on its own.
 *
 * Every wake gate in `handleEvent` is a deliberate cost control and every one
 * of them rests on the same claim: the seat "reads it on its next natural
 * activation". A seat whose declared interests never fire has no next natural
 * activation. In a live mission `qa` subscribed to three event types, the run
 * emitted none of them, and it held a message addressed to it for thirty-one
 * minutes while taking ZERO turns — excluded from the mail half of the sweep
 * below because the message was a broadcast, and from the pending half
 * because a broadcast obliges nobody and opens no request.
 *
 * Comfortably longer than a turn, so this never races an agent that is simply
 * busy: it is a floor under the gates, not a competitor to them.
 */
const STALE_MAIL_MS = 240_000;

const PRIORITY_BY_MESSAGE: Record<string, number> = {
  URGENT: 9,
  HIGH: 6,
  NORMAL: 4,
  LOW: 2,
};

/**
 * How long a queued activation waits before it counts as one band more urgent.
 *
 * Priority is a static band table and the queue is strict priority-then-FIFO, so
 * without this nothing ever raises an entry for having waited: a NORMAL (4) sits
 * behind every URGENT (9), HIGH (6), interest-ACT (5) and mail-requeue (5) for as
 * long as those keep arriving. The only priority-raising code requires a NEW,
 * independently higher-priority activation for that same seat. A few chatty seats
 * trading URGENT and HIGH traffic can therefore hold every slot indefinitely, and
 * nothing in the scheduler intervenes — it self-corrects only when they happen to
 * run out of important mail.
 *
 * A minute per band is deliberately slow. Aging exists to break a starvation that
 * has genuinely set in, not to reorder a busy queue: at this rate a NORMAL needs
 * five minutes of waiting to outrank a freshly-arrived URGENT, by which time it
 * has been passed over by every seat in the mesh several times.
 */
export const QUEUE_AGING_STEP_MS = 60_000;
/** Cap on the bump, so aging can break a deadlock without inverting the table for good. */
export const QUEUE_AGING_MAX_BANDS = 6;

/**
 * Priority as the queue should read it now: the declared band plus what waiting
 * has earned. `now` is passed in so one sort sees a single clock.
 *
 * Exported for tests: the alternative is a fixture that waits minutes of real
 * time to observe a single comparison.
 */
export function effectivePriority(item: { priority: number; enqueuedAt: number }, now: number): number {
  const waited = Math.max(0, now - item.enqueuedAt);
  return item.priority + Math.min(QUEUE_AGING_MAX_BANDS, Math.floor(waited / QUEUE_AGING_STEP_MS));
}

/**
 * Has this entry waited out the whole aging ladder?
 *
 * Exported for the same reason `effectivePriority` is.
 */
export function isStarved(item: { enqueuedAt: number }, now: number): boolean {
  return now - item.enqueuedAt >= QUEUE_AGING_MAX_BANDS * QUEUE_AGING_STEP_MS;
}

/**
 * Starved entries first, oldest first among them; everything else by effective
 * priority, then oldest first.
 *
 * The capped bump alone does not break starvation, it only delays it: once
 * every entry has waited past the cap, all of them carry the same +6 and the
 * queue is back to the static band table. Measured 2026-09-25: qa's NORMAL
 * REQUEST_REVIEW sat from 21:01:01 to 21:23:32 while nine other seats took the
 * freed slots, and no refusal was logged because nothing was refused. At
 * 21:08:33 it lost to a HIGH that looked 10 s old but was a handover requeue
 * from 21:03:03 promoted in place with its age kept — 6 + 5 bands against qa's
 * capped 4 + 6 — and after that to a stream of mail requeues (5) and recovery
 * wakes (7) that had also aged to their caps. The cap still stops a starved
 * entry from outranking a fresh one EARLY; what it no longer does is let a
 * higher band keep an entry that has waited the full ladder waiting forever.
 */
function byPriorityThenAge(now: number): (a: QueueItem, b: QueueItem) => number {
  return (a, b) => {
    const sa = isStarved(a, now);
    const sb = isStarved(b, now);
    if (sa !== sb) return sa ? -1 : 1;
    if (sa) return a.enqueuedAt - b.enqueuedAt;
    return effectivePriority(b, now) - effectivePriority(a, now) || a.enqueuedAt - b.enqueuedAt;
  };
}

/**
 * A wake whose note is a runtime NOTICE: a fact the seat cannot learn any other
 * way ("your request closed: …", "voided to break a circular wait", "escalation
 * responded"). Those are `recovery` wakes, and they were the ones coalescing
 * dropped: a seat already holding an equal-or-higher wake kept that one and the
 * notice vanished. Timer and mail notes are regenerated from state on the next
 * sweep, so only notices are carried across a merge.
 */
function carriesNotice(reason: ActivationReason): boolean {
  return reason.kind === "recovery" && typeof reason.note === "string" && reason.note.length > 0;
}

/** Bound on a merged note, so a seat that collects many notices is not handed an essay. */
const MAX_MERGED_NOTE_CHARS = 2000;

/** `reason` with `extra` appended to its note, as a copy; unchanged if already present. */
function withNotice(reason: ActivationReason, extra: string | undefined): ActivationReason {
  if (!extra) return reason;
  const note = reason.note ?? "";
  if (note.includes(extra)) return reason;
  const merged = note ? `${note}\n${extra}` : extra;
  return { ...reason, note: merged.length > MAX_MERGED_NOTE_CHARS ? merged.slice(merged.length - MAX_MERGED_NOTE_CHARS) : merged };
}

/**
 * The two sentences the scheduler writes on a mail wake itself, as against a runtime notice
 * merged onto one (`withNotice`). Written in one place so the sites that say them and the check
 * that recognises them (`isStaleMailWake`) cannot drift apart: a wake whose note is anything else
 * carries news that outlives the mail, and is never dropped for want of it.
 */
const mailWaitingNote = (count: number): string => `${count} messages waiting in your mailbox.`;
const mailTogetherNote = (count: number): string => `${count} messages arrived together, not one — the others are in your mailbox below.`;
const OWN_MAIL_NOTE = /^\d+ messages (?:waiting in your mailbox\.|arrived together, not one — the others are in your mailbox below\.)$/;

/**
 * `survivor` as it stands after absorbing `absorbed` — a coalesce onto a queued
 * wake, or a newer strong wake replacing a stashed one. An operator wake folded
 * into another wake makes that wake the operator's, and operator standing
 * brings `explicit` with it, as it does at every operator entry point.
 *
 * Without this the operator's wake could be folded into a runtime wake the
 * provider breaker is holding — a handover's re-queue, a seat's outage retry —
 * and `activateAgent` would answer `queued` for a turn that does not run until
 * the outage ends: the operator exemption, lost to a coalesce.
 */
function absorbOperator<T extends { explicit?: boolean; operator?: boolean }>(survivor: T, absorbed: { operator?: boolean } | undefined): T {
  return absorbed?.operator && !survivor.operator ? { ...survivor, explicit: true, operator: true } : survivor;
}

/**
 * Payload fields through which an event names the ask it is about. Read when
 * an interest wake is enqueued, so the wake can be checked again at dequeue.
 */
const REQUEST_REF_FIELDS = ["messageId", "requestMessageId"] as const;

/** Bound on remembered interest-wake request refs. Entries are two short strings. */
const MAX_WAKE_REFS = 1000;

export class Scheduler implements SchedulerPort {
  private queue: QueueItem[] = [];
  private runningMap = new Map<string, QueueItem>();
  private wakeAfterTurn = new Map<string, SchedulerActivationRequest>();
  private nudgeCounts = new Map<string, number>();
  private deniedCounts = new Map<string, number>();
  /**
   * Events a triage rule dropped before anything was queued, counted per
   * mission. Nothing else records them: the IGNORE branch in `handleEvent` is a
   * bare `continue`, so there is no card, no queue entry and no event — the
   * agent simply never reacts and nothing anywhere says why. A count is the
   * minimum that makes the loss visible.
   *
   * Zeroed by `resetMissionState` with every other per-mission counter: a tally
   * carried across a reset answers a question nobody asked. Reads 0 in a
   * default config, because `triageMode` defaults to "off" — see `triage()`.
   */
  private triagedAway = 0;
  /**
   * The other two deliberate interest-wake drops, counted for the same reason
   * `triagedAway` is and zeroed with it. Kept apart from it rather than folded
   * in: the console explains `triagedAway` as "a triage rule matched", and an
   * escalation hold or a redundant progress tick is neither.
   */
  private escalationHeld = 0;
  private redundantObservations = 0;
  private mailEchoes = 0;
  private staleRequestWakes = 0;
  private staleMailWakes = 0;
  /**
   * Interest-wake event id -> the open ask its event was about, recorded at
   * enqueue so `pump` can drop the wake if that ask closed while it waited.
   * Keyed by event id rather than by reason object: the supervisor re-activates
   * a seat with the reason it was woken for (the handover requeue, the no-op
   * requeue), and a reason copied on the way — a merged notice, a promotion —
   * still names the same event. Measured 2026-09-25: explorer's wake for a
   * superseded review ask ran twice, the second time as exactly that requeue.
   */
  private wakeRequestRefs = new Map<string, string>();
  private stuckEscalated = new Set<string>();
  /**
   * Circuit breaker: consecutive non-ok turn outcomes per agent. At the limit
   * the agent parks (non-explicit activations refused) until the cooldown
   * lapses or a turn succeeds. Explicit operator wakes always bypass — the
   * operator is pacing those by hand.
   */
  private strikes = new Map<string, { count: number; parkedUntil: number }>();
  /**
   * The policy refusal currently blocking each agent, kept so the reason
   * outlives the boolean this method returns. Written on every refusal (so
   * `lastActivationRefusal` is never stale) but reported once per distinct
   * refusal: a permanent block like `max_activations 3 reached` is re-evaluated
   * on every timer nudge, and emitting that each time would bury the event log
   * under the same sentence. A refusal that CHANGES is news and reports again.
   */
  private lastRefusal = new Map<string, PolicyDecisionResult>();
  private reportedRefusal = new Map<string, string>();
  private static readonly STRIKE_LIMIT = 3;
  private static readonly PARK_MS = 30000;
  /**
   * The breaker's mission-wide half: the model PROVIDER. `strikes` parks one
   * seat for its own poison work; this holds every seat's admission when the
   * provider itself refuses turns, because a seat parked for a provider outage
   * was a seat the mesh gave up on for nothing. Fed by the same
   * `noteTurnOutcome` (outcome `outage`) and gated in the same pump.
   *
   * Held, not refused: while it is open, activations still queue (so no mail
   * wake or retry is lost) and the pump dispatches none of them. Half-open
   * admits exactly one as the probe; its verdict closes or re-opens it.
   */
  private provider: ProviderBreaker = closedProviderBreaker();
  private providerTimer?: TimerHandle;
  private listeners: Array<() => void> = [];
  private stopped = true;
  private idleFired = true;
  /**
   * When the current quiet stretch began, or null when no quiet period is in
   * progress. Paired with `idleTimer`, the two are the dwell `checkIdle` used to
   * skip entirely — the resolved `idleQuietPeriodMs` is what they count down.
   */
  private idleArmedAt: number | null = null;
  private idleTimer?: TimerHandle;
  private lastNudge = new Map<string, number>();
  /** When each seat was last woken purely because its mail had gone stale. */
  private lastStaleMailWake = new Map<string, number>();
  /**
   * `deliver`-class mail that has landed and not yet bought a turn, per seat.
   *
   * The whole of the `deliver` class lives here: the message is already in the
   * mailbox (the reducer put it there before this scheduler saw the event), so
   * this holds only the WAKE — one per burst, released by `drainGathered`
   * once the window has run or dropped outright if the seat takes a turn for
   * any other reason first. Losing an entry therefore loses a wake and never a
   * message, which is why it is in-memory and not projected.
   */
  private gathering = new Map<string, { armedAt: number; count: number; reason: ActivationReason; priority: number }>();
  private timer?: TimerHandle;
  private interests = new Map<string, string[]>();
  private pumping = false;

  constructor(
    private config: ResolvedMeshConfig,
    private state: Projections,
    private policy: PolicyEvaluator,
    private runner: TurnRunner,
    private triageModel?: TriageModel,
    /**
     * Every time this class READS (backoff parking, gather windows, queue
     * aging, nudge spacing) and every timer it arms (the wait sweep, the idle
     * dwell) goes through this clock, so a test can move time instead of
     * sleeping through it. Production passes nothing and gets the wall clock
     * and the real event loop — the same `Date.now()`/`setTimeout` as before.
     */
    private clock: Clock = systemClock,
  ) {
    this.timers = timersOf(clock);
  }

  private readonly timers: Timers;

  private now(): number {
    return this.clock.now().getTime();
  }

  /** Late-bind the turn runner to break the Supervisor<->Scheduler construction cycle. */
  setRunner(runner: TurnRunner): void {
    this.runner = runner;
  }

  // interest registry (§23)
  //
  // Rebuilt from `start()`, from the server's boot/reset/restore sites, and —
  // since a seat can be added, replaced or retired while the mission runs —
  // from `handleEvent` on every event that changes the roster. Without that
  // last one a seat spawned mid-mission declared its interests, had them
  // validated and projected, and was never woken by any of them: the map it
  // had to be in was built before it existed.
  //
  // A RETIRED seat is left out: retirement is terminal, so its subscriptions
  // can only ever produce wakes that are refused further down.
  rebuildInterestRegistry(): void {
    this.interests = new Map();
    for (const rec of this.state.agents.values()) {
      if (rec.state.lifecycle === "RETIRED") continue;
      this.interests.set(rec.definition.id, [...rec.definition.interests]);
    }
  }

  candidatesFor(eventType: EventType, excludeActor?: string): string[] {
    const out: string[] = [];
    for (const [agentId, patterns] of this.interests) {
      if (agentId === excludeActor) continue;
      if (patterns.some((p) => interestMatches(p, eventType))) out.push(agentId);
    }
    return out;
  }

  start(): void {
    if (!this.stopped && this.timer) return;
    this.stopped = false;
    this.rebuildInterestRegistry();
    if (this.timer) this.timers.clearInterval(this.timer);
    this.timer = this.timers.setInterval(() => this.tickWaiting(), this.config.scheduling.waitWakeupMs);
    this.timer.unref?.();
    // Kick the pump: work admitted while stopped (an owed recovery respawn)
    // must not sit queued until the next activation or a 60s timer tick.
    void this.pump();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) this.timers.clearInterval(this.timer);
    this.timer = undefined;
    // A dwell in flight would otherwise outlive the stop and declare an idle
    // mesh after the mission it belonged to is over.
    this.clearIdleTimer();
    this.idleArmedAt = null;
    // An owed respawn survives the stop: a completion shutdown only ever comes
    // back through a reopen, and the restart it owes must still be owed then.
    // Everything else in the queue is stale by construction — the mission that
    // scheduled it is over.
    this.queue = this.queue.filter((q) => q.reason.kind === "recovery");
    // Deliberately the REAL clock and a real sleep: this bounds how long `stop`
    // waits for in-flight promises to settle, which is event-loop time, not
    // mission time. On an injected clock nobody advances, it would never expire.
    const deadline = Date.now() + 5000;
    while (this.runningMap.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    // The drain is bounded, so it can return with seats still held — and a seat
    // whose turn ended without ever calling back holds its slot for the life of
    // the process, because nothing else removes an entry. That wedges the ceiling
    // shut in the one direction the leak fix does not cover: too FEW admissions
    // rather than too many. Reconcile against the runner, which knows what is
    // actually in flight; a genuinely live turn keeps its seat and releases it
    // normally.
    this.reconcileRunning();
  }

  /**
   * Drop seats for turns the runner says are no longer in flight.
   *
   * `runningMap` is written at dispatch and removed by `notifyTurnFinished`. Any
   * path that ends a turn without that callback — a bounded stop that timed out,
   * a mission wiped mid-turn — leaves an entry behind that `capacityWait` counts
   * forever. The runner's own `isTurnInFlight` is the authority on what is live,
   * so this asks it rather than guessing.
   *
   * A runner without the probe is left strictly alone: dropping every seat
   * because a capability is missing would be the leak, not a fix for it.
   */
  private reconcileRunning(): void {
    if (typeof this.runner.isTurnInFlight !== "function") return;
    for (const agentId of [...this.runningMap.keys()]) {
      let live = true;
      try {
        live = this.runner.isTurnInFlight(agentId) === true;
      } catch {
        // A broken probe must never evict a seat, for the same reason `isBusy`
        // treats a throw as "still busy".
        live = true;
      }
      if (!live) this.runningMap.delete(agentId);
    }
  }

  /**
   * Drop every per-mission counter so a reset mesh does not inherit strikes,
   * nudge history, or escalation memory from the mission that was wiped.
   * Caller is expected to have stopped the scheduler first.
   */
  resetMissionState(): void {
    // An owed respawn survives the wipe like it survives a stop: a reopen
    // wipes the old round's counters, but the earlier failure's restart is
    // still owed — that is the point of the reopen that follows.
    this.queue = this.queue.filter((q) => q.reason.kind === "recovery");
    // A turn still in flight is not mission state — it is live work that will
    // call back, and its seat is the only record that it holds one. Replacing the
    // map wholesale dropped those seats while the turns ran on, so the ceiling
    // under-counted and admitted extra peers on top of them: the same shape as
    // the double-`notifyTurnFinished` leak, reached by a different route.
    // `reconcileRunning` keeps exactly the seats the runner still calls live.
    this.reconcileRunning();
    this.wakeAfterTurn = new Map();
    this.nudgeCounts = new Map();
    this.deniedCounts = new Map();
    this.triagedAway = 0;
    this.escalationHeld = 0;
    this.redundantObservations = 0;
    this.mailEchoes = 0;
    this.staleRequestWakes = 0;
    this.staleMailWakes = 0;
    this.wakeRequestRefs = new Map();
    this.stuckEscalated = new Set();
    this.strikes = new Map();
    this.lastRefusal = new Map();
    this.reportedRefusal = new Map();
    this.lastNudge = new Map();
    this.gathering = new Map();
    this.interests = new Map();
    this.clearIdleTimer();
    this.idleArmedAt = null;
    this.idleFired = true;
    // A wiped mission starts with a closed breaker: its card belonged to the
    // goal that was just deleted, and the next outage trips a fresh one.
    if (this.providerTimer) this.timers.clearTimeout(this.providerTimer);
    this.providerTimer = undefined;
    this.provider = closedProviderBreaker();
  }

  /**
   * Does this message, for this seat, buy no wake: its delivery class, or the
   * seat's own wake policy, defers it?
   *
   * One function because THREE sites ask it: the send-time gate in `handleEvent`,
   * the wait-timer sweep, and the retry `notifyTurnFinished` makes for mail that
   * arrived while a turn was running. Each would otherwise undo the first site's
   * decision by counting the same unread mail as pressure. That failure has a
   * name in this repo -- the accrue test in `tests/core/delivery-classes.test.ts`
   * pins it as "correctly not woken, then woken anyway, at the same cost" -- and
   * the retry was the site that still did it: `accrue` documents "wakes: never",
   * and six of a live run's 37 wakes (9.6% of its spend) were headed by
   * `INFORM/accrue` with the note "N messages waiting in your mailbox".
   *
   * Obligation beats the setting by construction rather than by exception:
   * `obligesRecipients` is the predicate the debt is opened with, so a message
   * deferred here is one that opened no `pendingRequests` entry and owes nobody
   * an answer. An ask always wakes the seat that owes it.
   */
  private defersMail(agentId: string, m: MeshMessage): boolean {
    if (obligesRecipients(m)) return false;
    // Operator mail is exempt from every other rationing mechanism in the mesh
    // (it is never billed, and it survives the mission-over gate below), and it
    // is exempt here for a reason that is not just consistency: `hasHumanMail`
    // decides whether post-mission feedback still gets answered, and a policy
    // that filtered human mail out of that list would silently stop a finished
    // mission from hearing its operator.
    if (m.from === "human") return false;
    // The policy is named for obligation, and obligation is not the whole of
    // what a seat cannot afford to sleep through. `deferNonObliging` reads as
    // "hold my chatter"; a HANDOFF is not chatter, it is this seat's next
    // piece of work, and deferring it means the work sits with nobody awake
    // to do it. So the recipient's own rationing stops at the same line the
    // delivery classes stop at — a seat can batch what is merely told to it,
    // and is still woken for what is handed to it.
    // The MESSAGE, not its type: a FAILED verdict is this seat's next piece of
    // work just as surely as a handoff is, and the type name alone cannot tell
    // it from the PASSED that means the opposite.
    if (movesWorkMessage(m)) return false;
    // The class the send path honours before it ever asks this function. It sits
    // below the escapes above because the class derivation never gives `accrue` to
    // an ask, a work-moving message or the operator's mail -- so for every message
    // that reaches here with one, deferring is what the send path already decided.
    if (m.control?.delivery === "accrue") return true;
    const wake = this.state.agents.get(agentId)?.definition.wake;
    // Checked AFTER the three escapes above and never before them, which is
    // what keeps this a batching preference rather than an authority
    // boundary: a seat that names `HANDOFF` or `REQUEST_REVIEW` here has
    // named nothing, because both left this function several lines ago.
    //
    // Directed mail is the half `interests` never reached. A seat's
    // `interests` list gates BROADCASTS (`candidatesFor`), so until this
    // existed the only thing a seat could say about mail addressed to it by
    // name was `deferNonObliging` — all of its FYIs or none of them. That is
    // a choice most seats decline to make, and declining it means paying for
    // every one.
    if (wake?.notFor?.includes(m.type)) return true;
    return wake?.deferNonObliging === true;
  }

  /**
   * Unread mail this seat is willing to be woken for, by its own declaration.
   *
   * The question every "does this seat have mail worth a turn" check should be
   * asking, now that a seat can answer it for itself. `readableMailDepth` is
   * still the right guard for "is there anything in the box at all"; this is
   * the right one for "does it justify a turn".
   *
   * Not applied everywhere on purpose. The FAILED-agent recovery check keeps
   * `readableMailDepth`: there, mail is one of two reasons a failed seat is
   * restarted at all, and letting a wake policy make a seat unrecoverable
   * would trade a spurious restart for a lost one.
   */
  /**
   * Epoch millis of the oldest message sitting unread for this seat, or
   * undefined if its box is empty.
   *
   * Deliberately counts EVERY unread message, including the broadcasts and
   * classed mail the nudge sweep excludes. Those exclusions are about not
   * paying twice for a wake the gates already decided against; this is about
   * mail that would otherwise never be read at all.
   */
  private oldestUnreadAt(agentId: string): number | undefined {
    const box = this.state.unread.get(agentId);
    if (!box?.length) return undefined;
    let oldest: number | undefined;
    for (const id of box) {
      const m = this.state.messages.get(id);
      if (!m) continue;
      const t = Date.parse(m.timestamp);
      if (Number.isNaN(t)) continue;
      if (oldest === undefined || t < oldest) oldest = t;
    }
    return oldest;
  }

  private wakeableMail(agentId: string): MeshMessage[] {
    return resolveUnread(this.state, agentId).filter((m) => !this.defersMail(agentId, m));
  }

  /**
   * Hold a `deliver` message's wake open instead of spending a turn on it.
   *
   * `armedAt` is kept from the FIRST message of a burst, deliberately. A
   * window that restarted on every arrival would never close under a steady
   * stream — precisely the traffic this class exists to price — and the seat
   * would be starved of the turn it is owed rather than charged less for it.
   */
  private gather(agentId: string, reason: ActivationReason, priority: number): void {
    const open = this.gathering.get(agentId);
    this.gathering.set(agentId, {
      armedAt: open?.armedAt ?? this.now(),
      count: (open?.count ?? 0) + 1,
      // The newest message is the one worth naming in the activation reason,
      // and the burst is worth the highest priority in it.
      reason,
      priority: Math.max(open?.priority ?? 0, priority),
    });
  }

  /**
   * Release the wakes whose gathering window has run.
   *
   * The second half of `deliver`, and the cheaper one: a seat already queued
   * has not built its prompt yet, so the turn it is about to take will render
   * this mail and the window closes having bought nothing. That is the "next
   * turn taken for any reason" in the class's definition, and it is where the
   * saving actually comes from — the wake is not merely delayed, it is often
   * never needed.
   */
  private drainGathered(now: number): void {
    if (this.gathering.size === 0) return;
    const window = this.config.bus.deliveryClasses?.coalesceMs ?? DEFAULT_COALESCE_MS;
    for (const [agentId, open] of [...this.gathering]) {
      if (!this.state.agents.has(agentId)) {
        this.gathering.delete(agentId);
        continue;
      }
      if (this.queue.some((q) => q.agentId === agentId)) {
        // This used to delete the gathered wake outright, on the assumption
        // that the already-queued turn would render the mail. Often it does
        // not: that turn's context bundle is snapshotted when it STARTS, so
        // anything arriving after that is invisible to it; or the activation
        // is refused by policy; or the turn fails before it drains. The wake
        // was then gone for good — the mechanism by which a MISSION reached
        // its architect four minutes after the architecture it was written to
        // direct had already been published and approved.
        //
        // Hold the window and look again next tick instead. It is released the
        // moment the seat really has nothing unread, so this cannot spin.
        if (this.wakeableMail(agentId).length === 0) this.gathering.delete(agentId);
        continue;
      }
      if (now - open.armedAt < window) continue;
      this.gathering.delete(agentId);
      // A gathered wake that says "new mail arrived" when eleven arrived is a
      // wake that gets one message answered and leaves ten owed a turn each.
      // The count is the one thing this buffer knows and the reason line did
      // not say, and naming it is what lets a single delivered turn do the
      // work of the burst -- which is the whole point of the class. Copied,
      // never mutated in place: `open.reason` is the newest message's own
      // reason object.
      const reason = open.count > 1 ? { ...open.reason, note: mailTogetherNote(open.count) } : open.reason;
      void this.requestActivation({ agentId, reason, priority: open.priority });
    }
  }

  async handleEvent(event: MeshEvent): Promise<void> {
    // Ahead of every gate, including `stopped`: the roster changes whatever the
    // scheduler is doing, and `start()` only rebuilds when it is restarted.
    // The projection has already applied the event by the time the bus
    // delivers it, so the rebuild reads the new roster.
    if (event.type === "agent.created" || event.type === "agent.replaced" || event.type === "agent.retired") {
      this.rebuildInterestRegistry();
    }
    // A stopped scheduler ignores the event stream, including human mail. That
    // is deliberate and tested (parked-interaction): parked means the operator
    // steps agents by hand, so mail queues and `POST /messages {wake:true}` is
    // the one-action send-and-step. `stopped` cannot tell operator-parked from
    // completion-stopped, so waking here would break the parked contract; the
    // post-completion case is handled by making `mode` derive from
    // `isRunning()` (so the UI knows it is parked and defaults wake on).
    if (this.stopped) return;
    const goal = this.state.activeGoalId ? this.state.goals.get(this.state.activeGoalId) : undefined;
    // Direct mail is never silenced by goal state: a human can send feedback
    // after a goal completes and its recipient must wake to answer it.
    // Interest-based wakeups stay gated on a healthy goal.
    const goalHalted = !goal || goal.status === "PAUSED" || goal.status === "COMPLETED" || goal.status === "FAILED";
    if (goalHalted && event.type !== "message.sent") return;
    if (!goal) return;

    if (event.type === "message.sent") {
      const m = (event.payload as { message: import("../../protocol/src/index").MeshMessage }).message;
      // A broadcast wakes only the seats that declared an interest in mail;
      // direct mail still wakes every recipient. The difference is what the
      // message obliges: an ask is owed an answer by a named seat, so that
      // seat must run, while an announcement is owed nothing by anyone — and
      // waking the whole roster for one costs a full turn per seat, which is
      // the single largest avoidable spend in a wide mesh.
      //
      // This suppresses the WAKEUP, never the delivery: the reducer has
      // already put the broadcast in every recipient's mailbox, so an
      // uninterested seat reads it on its next natural activation. Nothing is
      // lost, it is just not paid for twice.
      const interested =
        m.control?.mode === "broadcast" ? new Set(this.candidatesFor("message.sent", m.from)) : undefined;
      for (const target of m.to) {
        if (target === m.from) continue;
        if (interested && !interested.has(target)) continue;
        // Envelope, not payload: see MeshMessage.control. Reading activation
        // control out of agent-written JSON let a sender silence the wakeup
        // for its own message.
        if (m.control?.cacheServed === true) continue;
        const reason: ActivationReason = { kind: "message", messageId: m.id, threadId: m.threadId, eventId: event.id, eventType: "message.sent" };
        const priority = PRIORITY_BY_MESSAGE[m.priority] ?? 4;
        // The delivery class, where the mesh has one. Same principle as the
        // broadcast gate directly above and the same guarantee: it suppresses
        // the WAKEUP, never the delivery. The reducer has already put this in
        // the recipient's mailbox, so an unwoken seat reads it on its next
        // activation — the message is not lost, it is just not paid for at
        // the moment it arrived.
        //
        // An ABSENT class is not a class. It falls through to the wake below,
        // which is exactly what every message did before delivery classes
        // existed, so a mesh with no `bus.delivery` block and a replay of one
        // that predates it behave identically.
        const cls = m.control?.delivery;
        if (cls === "accrue") continue;
        // The recipient's own rationing (`AgentDefinition.wake`), which is the
        // one wake decision in this loop that the SENDER does not own. Every
        // other knob here — the class, the broadcast gate, the attention tariff
        // — is either the envelope's or the sender's; a seat that wants to batch
        // its FYIs had no way to say so, and `accrue` only did it mesh-wide.
        //
        // Same guarantee as the two gates above, and the reason this is safe to
        // put here rather than at send time: it suppresses the WAKEUP, never the
        // delivery. The reducer has already put the message in this recipient's
        // mailbox, so a deferring seat reads it on its next natural activation.
        if (this.defersMail(target, m)) continue;
        if (cls === "deliver") {
          this.gather(target, reason, priority);
          continue;
        }
        await this.requestActivation({ agentId: target, reason, priority });
      }
      return;
    }

    const candidates = this.candidatesFor(event.type, event.actorId);
    for (const agentId of candidates) {
      // Escalated means the mesh is waiting on a human: nothing but the
      // escalation and its answer wakes a seat. The event is not replayed after
      // the response — the hold is a decision, not a deferral — so it is
      // counted, or the seats that subscribed to it lose it without a trace.
      if (goal.status === "ESCALATED" && event.type !== "goal.escalated" && event.type !== "escalation.responded") {
        this.escalationHeld++;
        continue;
      }
      // Cheapest gate first: a pure state check that costs nothing, versus
      // triage rules that may serialize a large payload (and a triage MODEL
      // that costs a call). Deliberately ahead of `triageMode`, because the
      // default mode is "off" — which returns ACT for everything, and is
      // exactly the configuration where progress-tick wakeups burn the most
      // tokens in a live mesh.
      if (this.isRedundantObservation(agentId, event)) {
        this.redundantObservations++;
        continue;
      }
      // A busy seat is stashed a follow-up turn for an interest event (see
      // `requestActivation`) — except for the event a message to this very seat
      // raised. That message has its own wake: it started the turn in flight,
      // or it is stashed behind it, or `notifyTurnFinished` requeues it as
      // unread mail. A second turn for its echo answers the same ask twice,
      // which is exactly the repeat the explorer cache exists to prevent.
      if (this.isBusy(agentId) && this.echoesOwnMail(agentId, event)) {
        this.mailEchoes++;
        continue;
      }
      const triage = await this.triage(agentId, event);
      if (triage === "IGNORE") {
        this.triagedAway++;
        continue;
      }
      this.rememberWakeRequest(event);
      await this.requestActivation({
        agentId,
        reason: { kind: "interest_event", eventId: event.id, eventType: event.type },
        priority: triage === "ACT" ? 5 : 3,
      });
    }
  }

  /**
   * Would this wakeup cost a full model turn and learn nothing?
   *
   * An interest match is a subscription, not a reason to act. Progress-style
   * events (`goal.progress` fires on every criterion, and every agent that
   * subscribes to it) woke a full LLM turn per event just to observe "still
   * going" — the single largest source of pointless token spend in a live
   * mesh. This is a pure state check: no model call, no config, no payload
   * serialization.
   *
   * Suppression is safe because it is not a drop: the agent still holds its
   * mailbox, its pending requests and the timer nudge. It simply is not woken
   * to re-read a scoreboard that has not changed for it. Direct mail never
   * reaches here at all (`message.sent` returns earlier).
   */
  /**
   * Note which open ask this event is about, if any, so its interest wakes can
   * be re-checked when they reach the head of the queue (`isStaleWake`).
   *
   * Only an ask that is OPEN now: an event about a closed or unknown message
   * refers to nothing that can go stale later, and remembering it would make
   * the dequeue check drop a wake the event was never about.
   */
  private rememberWakeRequest(event: MeshEvent): void {
    const p = (event.payload ?? {}) as Record<string, unknown>;
    for (const field of REQUEST_REF_FIELDS) {
      const ref = p[field];
      if (typeof ref !== "string" || !this.state.pendingRequests.has(ref)) continue;
      if (this.wakeRequestRefs.size >= MAX_WAKE_REFS) {
        const oldest = this.wakeRequestRefs.keys().next().value;
        if (oldest !== undefined) this.wakeRequestRefs.delete(oldest);
      }
      this.wakeRequestRefs.set(event.id, ref);
      return;
    }
  }

  /**
   * Is this queued interest wake about an ask that has since closed?
   *
   * Asked at dequeue, because that is the last moment it is still free: a wake
   * that sat behind busier seats — or was put back by a handover or a no-op
   * turn — can outlive the question it was raised for by minutes, and running
   * it buys a full context window to be told "nothing is owed". A wake that
   * picked up a runtime notice on the way (see `withNotice`) is kept: the
   * notice is news whatever became of the ask.
   */
  private isStaleWake(item: QueueItem): boolean {
    if (item.explicit || item.reason.kind !== "interest_event" || item.reason.note) return false;
    const ref = item.reason.eventId ? this.wakeRequestRefs.get(item.reason.eventId) : undefined;
    return ref !== undefined && !this.state.pendingRequests.has(ref);
  }

  /**
   * Is this queued mail wake for mail the seat has since been handed?
   *
   * Mail that lands while a seat is mid-turn reaches its follow-up turn by two routes, the wake the
   * send path stashes and the retry `notifyTurnFinished` makes for what is left unread, and the
   * second of `notifyTurnFinished`'s two owners runs after the first has started that follow-up
   * turn. The turn drains the box only when its model call returns, so the second owner still found
   * the mail unread and stashed the wake a second time, to be replayed after the turn had read the
   * mail: a third turn for an empty mailbox. Between the recorded cronlite runs that was 16 of 64
   * mail wakes, 9 of 42 and 17 of 42.
   *
   * Asked at dequeue, which is where `isStaleWake` asks about an ask that has closed, and for the
   * same reason: the turn has not started, so dropping it is free, and the stash replay and the
   * queue both end here. The test is whether the seat has any mail left that a wake could be for,
   * not whether the message the wake names is among it: a retry names the head of a box, and the
   * box may have lost that message and gained another since.
   *
   * Only a wake that cites a message the mesh holds is for mail (a `message` wake with no
   * `messageId` is the supervisor starting a worker on an assigned task, and an id that resolves to
   * nothing is not one the seat was handed), and only one whose note is the scheduler's own: a
   * runtime notice merged onto it is news the mailbox does not hold. An explicit or operator wake is
   * someone asking for the turn, so it runs.
   */
  private isStaleMailWake(item: QueueItem): boolean {
    if (item.explicit || item.operator) return false;
    const r = item.reason;
    if (r.kind !== "message" || !r.messageId || !this.state.messages.has(r.messageId)) return false;
    if (r.note !== undefined && !OWN_MAIL_NOTE.test(r.note)) return false;
    return this.wakeableMail(item.agentId).length === 0;
  }

  private echoesOwnMail(agentId: string, event: MeshEvent): boolean {
    const messageId = (event.payload as { messageId?: unknown } | null)?.messageId;
    if (typeof messageId !== "string") return false;
    return this.state.messages.get(messageId)?.to.includes(agentId) === true;
  }

  private isRedundantObservation(agentId: string, event: MeshEvent): boolean {
    if (!OBSERVATIONAL_EVENTS.has(event.type)) return false;
    // Anything actually addressed to or about this agent is never redundant.
    const p = (event.payload ?? {}) as Record<string, unknown>;
    for (const key of ["agentId", "assignedTo", "owner", "actorId"]) {
      if (p[key] === agentId) return false;
    }
    // Real work outstanding: it needs the turn regardless of the event. Mail the
    // seat's own wake policy defers is not outstanding work — counting it here
    // would wake the seat for an observational event *because* it batched an
    // FYI, which is the leak the policy exists to close.
    if (this.wakeableMail(agentId).length > 0) return false;
    const rec = this.state.agents.get(agentId);
    if (rec?.state.activeTaskId) return false;
    for (const pr of this.state.pendingRequests.values()) {
      if (stillOwes(pr, agentId)) return false;
    }
    return true;
  }

  private async triage(agentId: string, event: MeshEvent): Promise<"IGNORE" | "SKIM" | "ACT"> {
    if (this.config.scheduling.triageMode === "off") return "ACT";
    if (this.triageModel) {
      try {
        return await this.triageModel.classify(agentId, event);
      } catch {
        /* fall through to heuristic; triage must never exceed its cost budget */
      }
    }
    const rules = this.config.scheduling.triageRules.filter((r) => r.agent === agentId && (!r.event || r.event === event.type));
    // Fast path (the common case): no rules mention this agent/event, so there
    // is nothing to match — skip serializing a potentially huge payload.
    if (rules.length === 0) return "SKIM";
    const text = JSON.stringify(event.payload).toLowerCase();
    for (const rule of rules) {
      if (rule.actIfTextMatches.some((needle) => text.includes(needle.toLowerCase()))) return "ACT";
      if (rule.ignoreIfTextMatches.some((needle) => text.includes(needle.toLowerCase()))) return "IGNORE";
    }
    return "SKIM";
  }

  /** Circuit-breaker probe (also used to keep timer nudges honest). */
  isParkedForBackoff(agentId: string): boolean {
    const s = this.strikes.get(agentId);
    if (!s || s.parkedUntil <= 0) return false;
    if (this.now() >= s.parkedUntil) {
      this.strikes.delete(agentId);
      return false;
    }
    return true;
  }

  /**
   * Is this seat's own token ledger latched exhausted? Read from the same flag
   * the policy's `budget` rule defers on, so the two cannot disagree about
   * which seats are parked.
   */
  private isParkedOnBudget(agentId: string): boolean {
    const goalId = this.state.activeGoalId;
    return goalId ? this.state.budgets.get(`agent:${goalId}/${agentId}`)?.exceeded === true : false;
  }

  noteTurnOutcome(agentId: string, outcome: TurnOutcome, detail: TurnOutcomeDetail = {}): void {
    // A provider outage is not the seat's strike: it goes to the mission-wide
    // half of the breaker and nowhere else.
    if (outcome === "outage") {
      this.noteProviderOutage(agentId, detail.error ?? "");
      return;
    }
    // The probe answered: the provider is back. Only the probe's own answer
    // counts — a turn that was already in flight when the breaker opened says
    // nothing about the provider NOW.
    if (detail.providerAnswered && this.provider.state === "half_open" && this.provider.probeItem?.agentId === agentId) {
      this.closeProvider(agentId);
    }
    if (outcome === "ok") {
      if (this.strikes.delete(agentId)) this.lastNudge.delete(agentId);
      return;
    }
    const s = this.strikes.get(agentId) ?? { count: 0, parkedUntil: 0 };
    s.count++;
    if (s.count >= Scheduler.STRIKE_LIMIT) s.parkedUntil = this.now() + Scheduler.PARK_MS;
    this.strikes.set(agentId, s);
  }

  /** The provider breaker as it stands. */
  providerBreaker(): ProviderBreakerSnapshot {
    const p = this.provider;
    return {
      state: p.state,
      openedAt: p.openedAt,
      failedTurns: p.failedTurns,
      seats: [...p.seats],
      lastError: p.lastError,
      opens: p.opens,
      backoffMs: p.backoffMs,
      ...(p.state === "open" ? { nextProbeAt: p.nextProbeAt } : {}),
      ...(p.probe ? { probe: p.probe } : {}),
    };
  }

  /**
   * Admit the probe now instead of at the end of the backoff: the operator
   * answered the card. A no-op unless the breaker is open — half-open already
   * has (or is about to admit) its one probe, and a closed one has nothing to
   * probe.
   */
  probeProviderNow(): boolean {
    if (this.provider.state !== "open") return false;
    this.halfOpenProvider("operator");
    return true;
  }

  /**
   * Is the breaker holding this queued wake back? Operator wakes are never
   * held: the operator asked for that turn, with the outage card in view.
   *
   * `operator`, not `explicit`. The two used to be one flag, and the
   * supervisor's handover re-queue sets `explicit` for its own reason — to get
   * past the seat's parking and a stopped pump after a bookkeeping turn — so it
   * walked through an open breaker: 2026-09-28 15:45Z, architect's handover
   * turn failed with the 402, and the wake it had consumed was re-admitted 90ms
   * later, eight seconds after the breaker opened, for a second refused turn.
   */
  private providerHolds(item: QueueItem): boolean {
    if (item.operator) return false;
    if (this.provider.state === "open") return true;
    return this.provider.state === "half_open" && this.provider.probeItem !== undefined;
  }

  private noteProviderOutage(agentId: string, error: string): void {
    const p = this.provider;
    const now = this.now();
    if (p.state === "closed") {
      p.recent = p.recent.filter((r) => now - r.at < PROVIDER_TRIP_WINDOW_MS);
      p.recent.push({ at: now, agentId });
      p.lastError = error;
      if (p.recent.length < PROVIDER_TRIP_FAILURES) return;
      p.openedAt = now;
      p.failedTurns = p.recent.length;
      p.seats = [...new Set(p.recent.map((r) => r.agentId))];
      p.opens = 1;
      p.recent = [];
      this.openProvider("closed", "tripped");
      return;
    }
    // Open or half-open: a turn of this episode. Counted for the card; only
    // the probe's own failure moves the breaker.
    p.failedTurns++;
    if (!p.seats.includes(agentId)) p.seats.push(agentId);
    p.lastError = error;
    if (p.state === "half_open" && p.probeItem?.agentId === agentId) {
      p.opens++;
      this.openProvider("half_open", "probe_failed");
    }
  }

  private openProvider(from: ProviderBreakerState, why: ProviderBreakerTransition["why"]): void {
    const p = this.provider;
    if (this.providerTimer) this.timers.clearTimeout(this.providerTimer);
    p.state = "open";
    p.probeItem = undefined;
    p.backoffMs = providerBackoffMs(p.opens);
    p.nextProbeAt = this.now() + p.backoffMs;
    // Armed even on a stopped scheduler: the provider can recover while the
    // mission is parked, and the half-open this leads to admits nothing a
    // stopped pump would not (see `queueWait`) — it never starts anything.
    this.providerTimer = this.timers.setTimeout(() => {
      this.providerTimer = undefined;
      if (this.provider.state === "open") this.halfOpenProvider("backoff_elapsed");
    }, p.backoffMs);
    this.providerTimer.unref?.();
    this.reportProvider(from, why);
  }

  private halfOpenProvider(why: ProviderBreakerTransition["why"]): void {
    if (this.providerTimer) this.timers.clearTimeout(this.providerTimer);
    this.providerTimer = undefined;
    this.provider.state = "half_open";
    this.provider.probeItem = undefined;
    this.provider.probe = undefined;
    this.reportProvider("open", why);
    void this.pump();
  }

  private closeProvider(agentId: string): void {
    if (this.providerTimer) this.timers.clearTimeout(this.providerTimer);
    this.providerTimer = undefined;
    const p = this.provider;
    p.probe = agentId;
    p.probeItem = undefined;
    p.state = "closed";
    // The report carries the episode it closes; the reset below is the next one's.
    this.reportProvider("half_open", "probe_succeeded");
    this.provider = closedProviderBreaker();
    void this.pump();
  }

  private reportProvider(from: ProviderBreakerState, why: ProviderBreakerTransition["why"]): void {
    const transition: ProviderBreakerTransition = { from, to: this.provider.state, why, snapshot: this.providerBreaker() };
    void this.runner.onProviderBreaker?.(transition)?.catch(() => undefined);
  }

  private isBusy(agentId: string): boolean {
    if (this.runningMap.has(agentId)) return true;
    try {
      if (this.runner.isTurnInFlight?.(agentId)) return true;
    } catch {
      /* a broken probe must never block scheduling */
    }
    return false;
  }

  async requestActivation(req: SchedulerActivationRequest): Promise<boolean> {
    // A recovery activation is an owed subcontractor respawn (the supervisor's
    // restart budget), not an event wakeup, so it survives a stopped scheduler:
    // a subprocess that died as the mission completed still owes its restart
    // and must be served by the next `start()` (a reopen). It is deliberately
    // NOT explicit, so it still refuses to pump while stopped — parked stays
    // hand-stepped, and circuit-breaker parking keeps shielding poison work.
    if (this.stopped && !req.explicit && req.reason.kind !== "recovery") return false;
    const rec = this.state.agents.get(req.agentId);
    if (!rec) return false;
    if (rec.state.agentId === "human") return false;
    const lifecycle: LifecycleState = rec.state.lifecycle;
    if (lifecycle === "SUSPENDED" || lifecycle === "COMPLETED") return false;
    // Parked by the circuit breaker: refuse quietly (except explicit operator
    // wakes). Retrying poison work on every event is the wedge.
    if (!req.explicit && this.isParkedForBackoff(req.agentId)) return false;
    if (this.isBusy(req.agentId)) {
      // Already running. Mail and recovery are stashed and re-run on finish.
      //
      // Interest wakes used to fall through here and be DROPPED, while the
      // function still returned `true` — which `activateAgent` reads as
      // `{ queued: true }`, so every caller was told a wake had landed that no
      // longer existed. With `max_active_agents: 3` against eight seats a
      // recipient is busy most of the time, and it showed: over a live run 74
      // interest-eligible events produced 4 interest wakes.
      //
      // They are stashed now, but never over a message or recovery wake:
      // `wakeAfterTurn` holds one entry per seat, and mail is the stronger
      // claim on the next turn.
      const strong = (r: { reason: ActivationReason; explicit?: boolean }): boolean =>
        r.reason.kind === "message" || r.reason.kind === "recovery" || r.explicit === true;
      const stashed = this.wakeAfterTurn.get(req.agentId);
      if (strong(req)) {
        // The stash holds one wake, not one notice: a newer strong wake replaces
        // the stashed one, and a notice the stashed one carried rides along.
        const reason = stashed && carriesNotice(stashed.reason) ? withNotice(req.reason, stashed.reason.note) : req.reason;
        this.wakeAfterTurn.set(req.agentId, absorbOperator({ agentId: req.agentId, reason, priority: req.priority, explicit: req.explicit, operator: req.operator }, stashed));
        return true;
      }
      // Everything else — an interest wake, and the rarer timer nudge or
      // non-explicit startup that reaches a busy seat — is the weaker claim.
      // Behind a stronger stash it is coalesced into it: that stash already
      // buys the next turn, and that turn renders the event log. Over another
      // weak stash the more urgent of the two is kept, the older on a tie —
      // one follow-up turn either way. Stashed or coalesced, a follow-up turn
      // IS owed, so `true` is now the truth rather than a courtesy.
      if (!stashed || (!strong(stashed) && req.priority > stashed.priority)) {
        this.wakeAfterTurn.set(req.agentId, { agentId: req.agentId, reason: req.reason, priority: req.priority });
      }
      return true;
    }
    const existingIdx = this.queue.findIndex((q) => q.agentId === req.agentId);
    if (existingIdx >= 0) {
      const existing = this.queue[existingIdx];
      // Coalesced either way — but a runtime notice on the wake that does NOT
      // survive the coalesce is carried onto the one that does. Measured
      // 2026-09-25: deadlock-break notices were dropped exactly here whenever
      // the asker already held an equal-priority wake, so it woke never told its
      // ask had been voided.
      if (req.priority <= existing.priority) {
        if (carriesNotice(req.reason)) this.queue[existingIdx] = { ...existing, reason: withNotice(existing.reason, req.reason.note) };
        // An operator wake folded in here may be what lets a held wake run.
        const absorbed = absorbOperator(this.queue[existingIdx], req);
        if (absorbed !== this.queue[existingIdx]) {
          this.queue[existingIdx] = absorbed;
          void this.pump();
        }
        return true;
      }
      const reason = carriesNotice(existing.reason) ? withNotice(req.reason, existing.reason.note) : req.reason;
      this.queue[existingIdx] = absorbOperator({ ...req, reason, enqueuedAt: existing.enqueuedAt }, existing);
      // Re-sort, or the promotion is recorded and not acted on. The queue is
      // ordered by priority and `pump` dispatches by array order, but the only
      // other `sort` is on the push path below — so an entry promoted in place
      // kept its old position until some unrelated push happened to reorder it,
      // and an URGENT that arrived for an already-queued seat waited behind the
      // NORMALs it had just outranked.
      this.queue.sort(byPriorityThenAge(this.now()));
      void this.pump();
      return true;
    }
    const decision = this.policy.evaluateActivation(req.agentId, {
      id: req.reason.eventId ?? "activation",
      type: req.reason.eventType ?? "message.sent",
      timestamp: this.clock.iso(),
      // Thread context rides along so the policy can DEFER activations into
      // blown thread budgets (otherwise the turn fails instantly and the
      // unread-requeue spins a timer-free loop that starves HTTP).
      payload: { note: req.reason.note ?? req.reason.kind, threadId: req.reason.threadId },
    }, { config: this.config, projections: this.state, goal: this.state.activeGoalId ? this.state.goals.get(this.state.activeGoalId) : undefined });
    // The policy already wrote the sentence — `max_activations 3 reached`,
    // `thread budget exhausted (12/12)`, `transition 'x' requires a,b; missing:
    // b`. Collapsing all of that to `false` was not merely unrendered, it was
    // destroyed: nothing on this site reached `denied()`, so no event carried
    // it either and the agent simply went quiet. Keep the decision, then
    // refuse. (The op guard in `executeOp` reaches `denied()` too now; neither
    // path is the exception the other once was.)
    if (decision.decision === "DENY" || decision.decision === "DEFER") {
      this.noteRefusal(req.agentId, decision, req.reason);
      return false;
    }
    this.lastRefusal.delete(req.agentId);
    this.reportedRefusal.delete(req.agentId);
    this.queue.push({ agentId: req.agentId, reason: req.reason, priority: req.priority, enqueuedAt: this.now(), explicit: req.explicit, operator: req.operator });
    this.queue.sort(byPriorityThenAge(this.now()));
    this.idleFired = false;
    void this.pump();
    return true;
  }

  /**
   * The policy refusal still blocking this agent, or undefined if its last
   * activation was admitted. Callers use it to say why instead of guessing;
   * see `activateAgent`, which used to answer every refusal with "already
   * active, or deferred by budget/policy" because this was the only thing the
   * boolean left it.
   */
  lastActivationRefusal(agentId: string): PolicyDecisionResult | undefined {
    return this.lastRefusal.get(agentId);
  }

  private noteRefusal(agentId: string, decision: PolicyDecisionResult, reason: ActivationReason): void {
    this.lastRefusal.set(agentId, decision);
    const key = JSON.stringify([decision.decision, decision.ruleId ?? "", decision.reason ?? ""]);
    if (this.reportedRefusal.get(agentId) === key) return;
    this.reportedRefusal.set(agentId, key);
    void this.runner.reportActivationDenied?.(agentId, decision, reason)?.catch(() => undefined);
  }

  /**
   * The concurrency ceiling currently holding this agent, or undefined when a
   * slot is free. Returns which ceiling bound rather than a bare boolean: the
   * three have different numbers and different remedies, and from the outside
   * all of them look identical to "nothing is happening".
   */
  private capacityWait(agentId: string): QueueWait | undefined {
    // Whole-team ceiling first: peers + services combined never exceed it.
    const total = this.runningMap.size;
    if (total >= this.config.scheduling.maxTotalAgents) {
      return { agentId, kind: "capacity", limit: this.config.scheduling.maxTotalAgents, running: total, configKey: "scheduling.concurrency.max_total_agents" };
    }
    const def = this.state.agents.get(agentId)?.definition;
    const mode = def?.mode ?? "peer";
    let peer = 0;
    let service = 0;
    for (const id of this.runningMap.keys()) {
      if (this.state.agents.get(id)?.definition.mode === "service") service++;
      else peer++;
    }
    if (mode === "service") {
      return service < this.config.scheduling.maxParallelServiceAgents
        ? undefined
        : { agentId, kind: "capacity", limit: this.config.scheduling.maxParallelServiceAgents, running: service, configKey: "scheduling.concurrency.max_parallel_service_agents" };
    }
    return peer < this.config.scheduling.maxActiveAgents
      ? undefined
      : { agentId, kind: "capacity", limit: this.config.scheduling.maxActiveAgents, running: peer, configKey: "scheduling.concurrency.max_active_agents" };
  }

  /**
   * The one thing stopping this queue entry from starting, in the pump's own
   * precedence order. undefined means it is runnable right now. Extracted from
   * the pump's scan so that the three conditions it ANDs together stay a single
   * predicate — they used to collapse into one `idx < 0` break that said
   * nothing about which of them fired.
   */
  private queueWait(item: QueueItem): QueueWait | undefined {
    // Never start a duplicate turn for a mid-flight agent (see isBusy): the
    // duplicate bails out instantly and its finish requeues — the wedge.
    if (this.isBusy(item.agentId)) return { agentId: item.agentId, kind: "busy" };
    const capacity = this.capacityWait(item.agentId);
    if (capacity) return capacity;
    if (this.stopped && !item.explicit) return { agentId: item.agentId, kind: "stopped" };
    if (this.providerHolds(item)) return { agentId: item.agentId, kind: "provider" };
    return undefined;
  }

  /**
   * Why every queued agent is still waiting. Recomputed on read and never
   * cached off the pump: these clear within a turn, and a stale snapshot would
   * have the console reporting a full mesh seconds after the slot freed.
   *
   * This is a live read, not an event stream, and that is the point. A capacity
   * wait is not a refusal — the agent is queued and will start on its own — so
   * it gets no `message.rejected` and cannot be recovered from the event log.
   */
  queueWaits(): QueueWait[] {
    const waits: QueueWait[] = [];
    for (const item of this.queue) {
      const wait = this.queueWait(item);
      if (wait) waits.push(wait);
    }
    return waits;
  }

  /**
   * How many events triage dropped this mission. Polled for the same reason
   * `queueWaits` is — a drop emits no event and cannot be recovered from the
   * log — but it is the opposite kind of state. A capacity wait is a block that
   * clears itself; a triage drop blocks nothing (nothing is refused, queued or
   * waiting) and never clears, because the event is gone and will not be
   * retried. So it belongs in neither the event log nor the "why you are
   * stopped" banners: one event apiece would bury the log, and a healthy mesh
   * that filtered 40 events is not stopped.
   */
  triagedAwayCount(): number {
    return this.triagedAway;
  }

  /**
   * Every deliberate wake drop this mission, by reason. The same kind of state
   * as `triagedAwayCount` (which is `triage_ignore` here) and polled for the
   * same reason: a drop emits no event and cannot be recovered from the log,
   * and one event apiece would bury it.
   */
  suppressedWakes(): Record<SuppressedWakeReason, number> {
    return {
      triage_ignore: this.triagedAway,
      goal_escalated: this.escalationHeld,
      redundant_observation: this.redundantObservations,
      mail_echo: this.mailEchoes,
      stale_request: this.staleRequestWakes,
      stale_mail: this.staleMailWakes,
    };
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        // Re-order before every pass, because aging is a function of NOW: an
        // entry's earned priority changes while it sits here, and the sorts on
        // the push and promotion paths only see the queue as it was when
        // something arrived. `pump` runs on every turn completion, which is
        // exactly the condition under which a seat starves — slots full, other
        // turns cycling — so this is where the re-evaluation has to happen.
        // (`tickWaiting` cannot do it: it skips agents already queued.) The queue
        // holds at most one entry per seat, so this is a sort of ≤10 items.
        this.queue.sort(byPriorityThenAge(this.now()));
        const idx = this.queue.findIndex((q) => !this.queueWait(q));
        // Every queued agent is held by something — its own turn, a concurrency
        // ceiling, or a parked scheduler. There is nothing to dispatch; which
        // of the three it was is recoverable from `queueWaits()`, live, when
        // the console asks. It is deliberately not an event: these resolve
        // constantly and one event per block would drown the log.
        if (idx < 0) break;
        const item = this.queue.splice(idx, 1)[0];
        if (this.isStaleWake(item)) {
          // The ask this interest wake was raised for closed while it waited.
          // Dropped rather than run: the seat's mail and its own debts still
          // wake it on their own paths, so nothing owed to it is lost.
          this.staleRequestWakes++;
          continue;
        }
        if (this.isStaleMailWake(item)) {
          // The mail this wake was raised for was read by a turn that ran while it waited. Dropped
          // rather than run: a turn for an empty mailbox buys a full context window to find nothing,
          // and anything that has arrived since has a wake of its own.
          this.staleMailWakes++;
          continue;
        }
        // Half-open with no probe yet: this dispatch IS the probe, and every
        // other wake waits behind it (`providerHolds`) until its verdict.
        if (this.provider.state === "half_open" && !this.provider.probeItem) {
          this.provider.probeItem = item;
          this.provider.probe = item.agentId;
        }
        this.runningMap.set(item.agentId, item);
        void this.runner
          .runTurn(item.agentId, item.reason)
          // Identified by the dispatch that started it. `notifyTurnFinished` has
          // two owners — the supervisor calls it from `runTurn`'s own `finally`,
          // deliberately early, and this is the second — so without an identity
          // the later call released whichever turn happened to hold the seat.
          .finally(() => this.notifyTurnFinished(item.agentId, item))
          .catch(() => undefined);
      }
      this.checkIdle();
    } finally {
      this.pumping = false;
    }
  }

  /** COMPLETED/FAILED: the mission is over and no self-scheduled turn may start. */
  private missionOver(): boolean {
    const goal = this.state.activeGoalId ? this.state.goals.get(this.state.activeGoalId) : undefined;
    return goal?.status === "COMPLETED" || goal?.status === "FAILED";
  }

  /**
   * Only operator mail may still drag a recipient back once the mission is
   * over. The requeues below synthesize a `message.sent` activation event, so
   * the policy's human-mail exception for COMPLETED cannot tell them apart
   * from a real operator message — the sender is only known here.
   */
  private hasHumanMail(messageIds: readonly string[]): boolean {
    return messageIds.some((id) => this.state.messages.get(id)?.from === "human");
  }

  /**
   * Release the seat a finished turn held, and decide what this agent does next.
   *
   * `dispatch` identifies WHICH turn finished, and exists because this method has
   * two owners that both fire for the same turn. The supervisor calls it from
   * `runTurn`'s `finally` (deliberately, so a handover re-activation is admitted
   * rather than stashed); `pump`'s `.finally()` calls it again when the promise
   * settles. Neither `requestActivation` nor `pump` contains an `await` — they are
   * `async` in signature only — so the supervisor's call can run the whole
   * re-activation synchronously and put a NEW turn in `runningMap` before the
   * second call arrives. That second call then deleted the new turn's entry.
   *
   * The seat stayed leaked, permanently and silently: `isBusy` still sees the live
   * turn through the runner probe, so no duplicate turn is minted and nothing looks
   * wrong — but `capacityWait` counts only the map. Measured 2026-09-24: five
   * in-flight turns against `max_active_agents: 3`, i.e. three counted and two
   * leaked. The signature is `GET /scheduler` disagreeing with the real turn count.
   *
   * Omitting `dispatch` keeps the old unconditional behaviour, which is what the
   * supervisor's early call wants.
   */
  notifyTurnFinished(agentId: string, dispatch?: QueueItem): void {
    const holding = this.runningMap.get(agentId);
    // Superseded: a LATER turn for this seat is already running and owns the
    // seat, so releasing it here would release someone else's. Only the delete is
    // skipped — everything below (deferred wake, stale-mail requeue, pump) must
    // still run, because those decide what this agent does next and skipping them
    // strands a seat holding unread mail. An earlier version returned here and
    // stalled `examples/demo-stub` short of convergence for exactly that reason.
    const superseded = dispatch !== undefined && holding !== undefined && holding !== dispatch;
    // The provider probe ended with no verdict (a budget refusal at the door,
    // a timeout, a seat's own crash, a turn that bailed before running): it
    // told us nothing about the provider, so the slot goes to the next queued
    // wake. A verdict clears `probeItem` before this runs, so this is only the
    // inconclusive case — and it is matched by dispatch identity, because the
    // late second call for an old turn must not free a NEWER probe's slot.
    const finished = dispatch ?? holding;
    if (finished !== undefined && this.provider.state === "half_open" && this.provider.probeItem === finished) {
      this.provider.probeItem = undefined;
      this.provider.probe = undefined;
    }
    if (!superseded) this.runningMap.delete(agentId);
    this.lastNudge.set(agentId, this.now());
    const over = this.missionOver();
    const deferred = this.wakeAfterTurn.get(agentId);
    if (deferred) {
      this.wakeAfterTurn.delete(agentId);
      // Re-run through the normal gate (dedup + lifecycle + policy/budget).
      // Direct queue pushes here bypassed the budget DEFER, so an exhausted
      // agent instantly failed again and again — a timer-free microtask loop
      // that starved HTTP (full "server not responding" wedge).
      // Post-completion, a requeued agent message would start a turn whose
      // every op is rejected with "mission is COMPLETED"; operator mail is
      // the one follow-up that must still run.
      const staleMail =
        deferred.reason.kind === "message" &&
        !this.hasHumanMail(deferred.reason.messageId ? [deferred.reason.messageId] : []);
      if (!(over && staleMail)) {
        void this.requestActivation({
          agentId,
          reason: deferred.reason,
          priority: deferred.priority,
          explicit: deferred.explicit,
          operator: deferred.operator,
        });
      }
    } else if (!this.stopped && this.wakeableMail(agentId).length > 0) {
      // Filtered through the same recipient policy as the send path, and before
      // the mission-over check rather than after: a box holding only FYIs this
      // seat declared it batches is not "mail queued while running", and letting
      // it through here would hand the seat the turn the send path just refused
      // it — the third site of the same failure.
      const unread = this.wakeableMail(agentId);
      // The "mail queued while running" retry is a scheduler self-nudge, not
      // operator intent: on a finished mission it only starts dead turns for
      // stale agent mail. Human mail passes so feedback still gets answered.
      if (unread.length > 0 && !(over && !this.hasHumanMail(unread.map((m) => m.id)))) {
        // The head of the box, resolved. It used to be `unread[0]` straight
        // off the id array, so a box whose head was a dangler activated a turn
        // citing a messageId that resolved to nothing -- the seat was woken to
        // read a message that does not exist.
        const msg = unread[0];
        void this.requestActivation({
          agentId,
          // The depth, not just the fact. A seat told only that mail is waiting
          // answers the head and stops; the rest are then owed a turn each.
          // `unread` is resolved above anyway, so naming the size is free.
          reason: {
            kind: "message",
            messageId: msg.id,
            threadId: msg.threadId,
            note: mailWaitingNote(unread.length),
          },
          priority: 5,
        });
      }
    }
    void this.pump();
  }

  /**
   * Is the scheduler actually able to dequeue work? The server's `mode` is a
   * separate field that can drift out of sync with this one — `completeMission`
   * stops the scheduler without touching `mode`, which used to leave a mesh
   * reporting "live" while nothing could run, and made `goLive()` a no-op on
   * exactly the mesh that needed restarting. Anything deciding "can this mesh
   * do work" must ask here, not the mode flag.
   */
  isRunning(): boolean {
    return !this.stopped;
  }

  pending(): number {
    return this.queue.length;
  }

  running(): number {
    return this.runningMap.size;
  }

  /**
   * The dispatch queue, then every wake held behind a running turn. The stashed
   * ones are marked `afterTurn` and are deliberately NOT in `pending()`, which
   * the idle checks read as "dispatchable work": a stash cannot start until its
   * seat's turn ends, and that turn already keeps `running()` above zero.
   */
  queueSnapshot(): QueueSnapshotEntry[] {
    const out: QueueSnapshotEntry[] = this.queue.map((q) => ({ agentId: q.agentId, priority: q.priority, reason: q.reason }));
    for (const w of this.wakeAfterTurn.values()) {
      out.push({ agentId: w.agentId, priority: w.priority, reason: w.reason, afterTurn: true });
    }
    return out;
  }

  /**
   * Called when a human resolves a `stuck:*` escalation (or a request is
   * otherwise answered out-of-band) so the same request can be nudged again
   * instead of being suppressed forever by `stuckEscalated`.
   */
  resetStallTracking(messageId: string, agentId?: string): void {
    if (agentId) {
      this.nudgeCounts.delete(`${agentId}:${messageId}`);
      this.deniedCounts.delete(`${agentId}:${messageId}`);
      this.stuckEscalated.delete(`${agentId}:${messageId}`);
      // A human resolved the stall: clear the circuit breaker too, so the
      // recovery activation below actually runs instead of parking.
      this.strikes.delete(agentId);
    } else {
      for (const k of [...this.nudgeCounts.keys()]) {
        if (k.endsWith(`:${messageId}`)) this.nudgeCounts.delete(k);
      }
      for (const k of [...this.deniedCounts.keys()]) {
        if (k.endsWith(`:${messageId}`)) this.deniedCounts.delete(k);
      }
      for (const k of [...this.stuckEscalated]) {
        if (k.endsWith(`:${messageId}`)) this.stuckEscalated.delete(k);
      }
    }
  }

  /** Drop counters for requests that no longer exist (answered / cleared). */
  private pruneStallTracking(): void {
    const live = new Set([...this.state.pendingRequests.keys()]);
    const stale = (key: string): boolean => {
      const mid = key.slice(key.indexOf(":") + 1);
      return !live.has(mid);
    };
    for (const k of [...this.nudgeCounts.keys()]) if (stale(k)) this.nudgeCounts.delete(k);
    for (const k of [...this.deniedCounts.keys()]) if (stale(k)) this.deniedCounts.delete(k);
    for (const k of [...this.stuckEscalated]) if (stale(k)) this.stuckEscalated.delete(k);
    for (const id of [...this.strikes.keys()]) {
      if (!this.state.agents.has(id)) this.strikes.delete(id);
      else this.isParkedForBackoff(id); // opportunistically expiry-sweep
    }
  }

  onIdle(callback: () => void): void {
    this.listeners.push(callback);
  }

  /**
   * Declare the mesh idle once it has been quiet for `idleQuietPeriodMs`.
   *
   * This used to fire on the instant the queue and the running map were both
   * empty, which is what made the resolved `idleQuietPeriodMs` inert: a mesh
   * going quiet between two bursts announced an idle moment it was about to
   * end, and the watchdog scan that announcement triggers ran against a mesh
   * that was still working. The setting is a *quiet period*, so the clock starts
   * when the mesh stops, not the moment its last turn cleared.
   *
   * A dedicated timer rather than a check inside `tickWaiting`'s sweep, which is
   * how the `deliver`-class gather window does it: that sweep runs every
   * `waitWakeupMs` — 60s by default — against a 30s default window, so a dwell
   * living there would be quantized to a minute in production. `stop()` already
   * schedules a bare timeout, so a timer is not foreign to this class.
   */
  private checkIdle(): void {
    if (this.queue.length > 0 || this.runningMap.size > 0) {
      // Work is queued or running, so no quiet period is in progress. A dwell
      // already counting down is abandoned rather than left to fire, since it
      // would announce an idle mesh that is demonstrably busy.
      this.clearIdleTimer();
      this.idleArmedAt = null;
      return;
    }
    if (this.idleFired) return;
    const quietMs = this.config.scheduling.idleQuietPeriodMs;
    // Zero or below keeps the old edge-triggered behaviour, which is the escape
    // hatch for a mesh that wants the idle moment on the instant it is quiet.
    if (quietMs <= 0) {
      this.declareIdle();
      return;
    }
    if (this.idleArmedAt !== null) return;
    this.idleArmedAt = this.now();
    this.idleTimer = this.timers.setTimeout(() => {
      this.idleTimer = undefined;
      this.idleArmedAt = null;
      // Re-checked rather than assumed. `checkIdle` is only reached from the
      // pump, and an admission's own pump clears this timer — but a timer that
      // has already been queued still runs its callback, so the quiet condition
      // is tested again here instead of being trusted to have held.
      if (this.queue.length === 0 && this.runningMap.size === 0 && !this.idleFired) this.declareIdle();
    }, quietMs);
    this.idleTimer.unref?.();
  }

  private declareIdle(): void {
    this.idleFired = true;
    for (const cb of this.listeners) cb();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) this.timers.clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private tickWaiting(): void {
    if (this.stopped) return;
    const now = this.now();
    const goal = this.state.activeGoalId ? this.state.goals.get(this.state.activeGoalId) : undefined;
    if (!goal || goal.status !== "ACTIVE") return;
    this.pruneStallTracking();
    this.drainGathered(now);
    // The provider is refusing turns: every nudge below would queue behind the
    // breaker, count as delivered, and three of them would escalate a
    // "stalemate" that is really the outage the breaker's own card names. The
    // sweep resumes on the first tick after it closes.
    if (this.provider.state !== "closed") return;
    for (const rec of this.state.agents.values()) {
      const id = rec.state.agentId;
      if (id === "human") continue;
      if (rec.state.lifecycle === "SUSPENDED" || rec.state.lifecycle === "COMPLETED") continue;
      // FAILED agents are NOT skipped when work is owed to them: a FAILED
      // agent with a persistent session restarts on activation (3 attempts),
      // so an ask addressed to it is recoverable — skipping it here meant the
      // nudge path never fired, the ask sat, and the asker waited forever. A
      // FAILED agent nobody owes anything stays skipped below (no pending,
      // no mail → nothing to do).
      if (rec.state.lifecycle === "FAILED") {
        const owed = [...this.state.pendingRequests.values()].some((pr) => stillOwes(pr, id));
        const mail = readableMailDepth(this.state, id) > 0;
        if (!owed && !mail) continue;
      }
      // Must match the predicate `requestActivation` uses, not just
      // `runningMap`. A turn can be in flight in the runner without a
      // runningMap entry (isTurnInFlight), and for such an agent
      // `requestActivation` returns TRUE after merely parking the request in
      // `wakeAfterTurn` — so the nudge below was counted as delivered while
      // no turn ever ran. Three of those escalated a false stalemate against
      // an agent that was working the whole time.
      if (this.isBusy(id) || this.queue.some((q) => q.agentId === id)) continue;
      // A seat with an open gathering window is not stalled — it is holding a
      // coalesced burst that this same timer will release. Without this the
      // `deliver` class bought nothing whenever the nudge cadence was shorter
      // than the window (it is 60s against 60s in the shipped defaults, and
      // 200ms against anything in the tests): the seat was correctly not woken
      // by the message, then woken a tick later by the sweep below to chase
      // the very ask it was holding. Filtering the unread list is not enough,
      // because an obliging message also opens a pendingRequest and the
      // pending half of this sweep is deliberately left alone.
      //
      // Bounded, not suppressed: `armedAt` is the FIRST message of the burst,
      // so the window closes on schedule whatever else arrives, and every
      // close ends in a real activation. Nudges and the stalemate escalation
      // resume the moment it does.
      if (this.gathering.has(id)) continue;
      // Parked by the circuit breaker: leave it alone (and do NOT count a
      // denial — a parked agent is resting, not stonewalling a request).
      if (this.isParkedForBackoff(id)) {
        this.lastNudge.set(id, now);
        continue;
      }
      // Parked on its own budget: the same, for the same reason. Every
      // activation of such a seat is DEFERred by the policy's `budget` rule, so
      // a nudge here only counted another denial — and three of those raised
      // `stalemate:unanswered_request` from the deadlock detector, whose
      // stalemate verdict halts the WHOLE goal. That re-created, one sweep
      // later, the mission-wide halt that parking the seat exists to avoid.
      // The operator already holds this seat's budget card; its mail and its
      // debts wait for the raise, and nudging resumes once the latch clears.
      if (this.isParkedOnBudget(id)) {
        this.lastNudge.set(id, now);
        continue;
      }
      // Announcements are not mail PRESSURE. This nudge exists to restart a
      // stalled loop — its own note says "follow up or close the loop" — and
      // a broadcast opens no loop: it obliges nobody and cannot even be
      // replied to. Counting it here silently undid the interest gate on
      // `message.sent`: the uninterested seat was correctly not woken by the
      // broadcast, then woken by this timer one tick later for that same
      // message, at the same cost, with a note telling it to close a loop
      // that never existed. It still has the mail and still reads it on its
      // next real activation.
      //
      // Classed mail is excluded for exactly the same reason, and it is the
      // same bug if it is not: `accrue` says never wake and `deliver` says
      // wake once when the gathering window runs, so counting either here
      // would have this timer undo the class one tick later — the seat
      // correctly not woken by the message, then woken by the sweep for that
      // same message, at the same cost, with a note about closing a loop the
      // class had already decided was not worth a turn. `interrupt` mail
      // still counts: it was woken for, and if it is STILL unread the stalled
      // loop this nudge exists for is real.
      //
      // Nothing here touches the pending-request half of the sweep below, so
      // an unanswered ask is nudged and escalated exactly as before whatever
      // class carried it.
      const unread = (this.state.unread.get(id) ?? []).filter((mid) => {
        const m = this.state.messages.get(mid);
        // `m?.` below let a dangler fall through both exclusions and be counted
        // as mail worth nudging for -- a message that cannot be read, cannot be
        // delivered, and cannot be discharged. Tested first, deliberately.
        if (!m) return false;
        if (m.control?.mode === "broadcast") return false;
        if (m.control?.delivery && m.control.delivery !== "interrupt") return false;
        // The same recipient policy the send path honours, for the same reason
        // the class is honoured here: a seat that declared it batches FYIs must
        // not be nudged for one on the next sweep, or the declaration bought
        // nothing but a tick's delay.
        if (this.defersMail(id, m)) return false;
        return true;
      }).length;
      // The floor under the wake gates. Everything excluded from `unread`
      // above was excluded so the mesh would not pay twice for one wake — a
      // sound trade, and one that assumed the seat turns up eventually for its
      // own reasons. When it does not, the mail is simply never read, and no
      // other path here notices: a broadcast opens no pending request, so the
      // scan below skips the seat too.
      //
      // One turn per stale window, not one per message, so a seat that woke
      // and still did not drain its box is retried rather than abandoned, and
      // a busy or parked seat never reaches here at all (both `continue`
      // above).
      const oldestMailAt = this.oldestUnreadAt(id);
      if (oldestMailAt !== undefined && now - oldestMailAt >= STALE_MAIL_MS) {
        if (now - (this.lastStaleMailWake.get(id) ?? 0) >= STALE_MAIL_MS) {
          this.lastStaleMailWake.set(id, now);
          void this.requestActivation({
            agentId: id,
            reason: { kind: "timer", note: "mail has been waiting unread and nothing you subscribe to woke you for it" },
            priority: 3,
          });
          continue;
        }
      }
      // Oldest-first by creation time (insertion order is not a reliable clock
      // once entries are deleted out of order). Scoped to the active goal so
      // a stale request from a previous mission cannot stall the new one.
      const activeGoal = this.state.activeGoalId;
      const oldestPending = [...this.state.pendingRequests.values()]
        .filter((pr) => stillOwes(pr, id) && pr.from !== id && (!pr.goalId || !activeGoal || pr.goalId === activeGoal))
        // An ask that carries its own answer is not a stall, and chasing one
        // is the exact cost `ifUnanswered` exists to remove. The ladder below
        // spends a debtor's turn three times and then a human's once, all to
        // extract an answer the asker has already said it can do without --
        // so for these the debtor is left alone. It still holds the ask in
        // its inbox and can answer on any turn it takes for its own reasons;
        // what it no longer gets is a turn bought to remind it.
        .filter((pr) => pr.ifUnanswered === undefined)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      const age = now - (this.lastNudge.get(id) ?? 0);
      if (age < this.config.scheduling.waitWakeupMs) continue;
      if (unread > 0) {
        this.lastNudge.set(id, now);
        void this.requestActivation({
          agentId: id,
          reason: { kind: "timer", note: "queued mail while waiting; follow up or close the loop" },
          priority: 3,
        });
        // Fall through: a chatty inbox must not starve a pending review.
        // (requestActivation dedups per agent, so this cannot double-queue.)
      }
      if (!oldestPending) continue;
      // A BLOCKED agent already told the mesh it cannot proceed; nudging it
      // to run again is pointless — escalate instead of hanging silently.
      if (rec.state.lifecycle === "BLOCKED") {
        const key = `${id}:${oldestPending.messageId}`;
        if (!this.stuckEscalated.has(key)) {
          this.stuckEscalated.add(key);
          this.lastNudge.set(id, now);
          void this.runner.escalateStuckRequest?.(id, oldestPending.messageId);
        }
        continue;
      }
      const key = `${id}:${oldestPending.messageId}`;
      const prev = this.nudgeCounts.get(key) ?? 0;
      const count = prev + 1;
      if (count > MAX_NUDGES) {
        // the request is not being answered: stop burning tokens and escalate
        // to the human (§33.4 stalemate -> deadlock-detector path)
        if (!this.stuckEscalated.has(key)) {
          this.stuckEscalated.add(key);
          this.lastNudge.set(id, now);
          void this.runner.escalateStuckRequest?.(id, oldestPending.messageId);
        }
        continue;
      }
      this.lastNudge.set(id, now);
      // Count only turns the agent actually got. A policy DENY must not
      // masquerade as "the agent ignored 3 nudges"; track denies separately
      // and escalate on those too so a permanent block cannot hang silently.
      void this.requestActivation({
        agentId: id,
        reason: {
          kind: "timer",
          // The nudge names the deadline as well as the counter: this wake is
          // about one specific ask, and the seat that has to answer it should
          // not have to ask how long it has left — §11k of
          // `NOTES-communication-measured-review.md`.
          note: `follow up on unanswered request ${oldestPending.messageId} (nudge ${count}/${MAX_NUDGES})${
            oldestPending.dueBy ? ` — due by ${oldestPending.dueBy}` : ""
          }`,
        },
        priority: 3,
      }).then((ok) => {
        if (ok) {
          this.nudgeCounts.set(key, count);
          this.deniedCounts.delete(key);
        } else {
          const denied = (this.deniedCounts.get(key) ?? 0) + 1;
          this.deniedCounts.set(key, denied);
          if (denied > MAX_NUDGES && !this.stuckEscalated.has(key)) {
            this.stuckEscalated.add(key);
            void this.runner.escalateStuckRequest?.(id, oldestPending.messageId);
          }
        }
      });
    }
  }
}

export { interestMatches };
