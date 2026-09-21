import type { ActivationReason, MeshEvent, MeshMessage, EventType, LifecycleState, PolicyDecisionResult } from "../../protocol/src/index";
import { obligesRecipients } from "../../protocol/src/index";
import type { ResolvedMeshConfig } from "../../config/src/index";
import { interestMatches } from "../../config/src/index";
import type { Projections } from "../../core/src/state";
import { readableMailDepth, resolveUnread, stillOwes } from "../../core/src/state";
import type { PolicyEvaluator, QueueWait, SchedulerActivationRequest, SchedulerPort, TurnOutcome } from "../../core/src/ports";

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
}

const MAX_NUDGES = 3;

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

const PRIORITY_BY_MESSAGE: Record<string, number> = {
  URGENT: 9,
  HIGH: 6,
  NORMAL: 4,
  LOW: 2,
};

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
  private listeners: Array<() => void> = [];
  private stopped = true;
  private idleFired = true;
  private lastNudge = new Map<string, number>();
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
  private timer?: NodeJS.Timeout;
  private interests = new Map<string, string[]>();
  private pumping = false;

  constructor(
    private config: ResolvedMeshConfig,
    private state: Projections,
    private policy: PolicyEvaluator,
    private runner: TurnRunner,
    private triageModel?: TriageModel,
  ) {}

  /** Late-bind the turn runner to break the Supervisor<->Scheduler construction cycle. */
  setRunner(runner: TurnRunner): void {
    this.runner = runner;
  }

  // interest registry (Â§23)
  rebuildInterestRegistry(): void {
    this.interests = new Map();
    for (const rec of this.state.agents.values()) {
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
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.tickWaiting(), this.config.scheduling.waitWakeupMs);
    this.timer.unref?.();
    // Kick the pump: work admitted while stopped (an owed recovery respawn)
    // must not sit queued until the next activation or a 60s timer tick.
    void this.pump();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    // An owed respawn survives the stop: a completion shutdown only ever comes
    // back through a reopen, and the restart it owes must still be owed then.
    // Everything else in the queue is stale by construction — the mission that
    // scheduled it is over.
    this.queue = this.queue.filter((q) => q.reason.kind === "recovery");
    const deadline = Date.now() + 5000;
    while (this.runningMap.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
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
    this.runningMap = new Map();
    this.wakeAfterTurn = new Map();
    this.nudgeCounts = new Map();
    this.deniedCounts = new Map();
    this.triagedAway = 0;
    this.stuckEscalated = new Set();
    this.strikes = new Map();
    this.lastRefusal = new Map();
    this.reportedRefusal = new Map();
    this.lastNudge = new Map();
    this.gathering = new Map();
    this.interests = new Map();
    this.idleFired = true;
  }

  /**
   * Does this seat's own wake policy defer this message?
   *
   * One function because TWO sites ask it: the send-time gate in `handleEvent`
   * and the wait-timer sweep, which would otherwise undo the first site's
   * decision one tick later by counting the same unread mail as pressure. That
   * second failure has a name in this repo — the accrue test in
   * `tests/core/delivery-classes.test.ts` pins it as "correctly not woken, then
   * woken anyway, at the same cost" — and a policy only the send path honoured
   * would be exactly it.
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
    return this.state.agents.get(agentId)?.definition.wake?.deferNonObliging === true;
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
      armedAt: open?.armedAt ?? Date.now(),
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
        this.gathering.delete(agentId);
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
      const reason =
        open.count > 1
          ? { ...open.reason, note: `${open.count} messages arrived together, not one — the others are in your mailbox below.` }
          : open.reason;
      void this.requestActivation({ agentId, reason, priority: open.priority });
    }
  }

  async handleEvent(event: MeshEvent): Promise<void> {
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
      if (goal.status === "ESCALATED" && event.type !== "goal.escalated" && event.type !== "escalation.responded") continue;
      // Cheapest gate first: a pure state check that costs nothing, versus
      // triage rules that may serialize a large payload (and a triage MODEL
      // that costs a call). Deliberately ahead of `triageMode`, because the
      // default mode is "off" — which returns ACT for everything, and is
      // exactly the configuration where progress-tick wakeups burn the most
      // tokens in a live mesh.
      if (this.isRedundantObservation(agentId, event)) continue;
      const triage = await this.triage(agentId, event);
      if (triage === "IGNORE") {
        this.triagedAway++;
        continue;
      }
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
    if (Date.now() >= s.parkedUntil) {
      this.strikes.delete(agentId);
      return false;
    }
    return true;
  }

  noteTurnOutcome(agentId: string, outcome: TurnOutcome): void {
    if (outcome === "ok") {
      if (this.strikes.delete(agentId)) this.lastNudge.delete(agentId);
      return;
    }
    const s = this.strikes.get(agentId) ?? { count: 0, parkedUntil: 0 };
    s.count++;
    if (s.count >= Scheduler.STRIKE_LIMIT) s.parkedUntil = Date.now() + Scheduler.PARK_MS;
    this.strikes.set(agentId, s);
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
      // already running: mail stays queued (re-run handled on finish); interest
      // wakeups are transient and dropped mid-turn.
      if (req.reason.kind === "message" || req.reason.kind === "recovery" || req.explicit) {
        this.wakeAfterTurn.set(req.agentId, { agentId: req.agentId, reason: req.reason, priority: req.priority, explicit: req.explicit });
      }
      return true;
    }
    const existingIdx = this.queue.findIndex((q) => q.agentId === req.agentId);
    if (existingIdx >= 0) {
      const existing = this.queue[existingIdx];
      if (req.priority > existing.priority) {
        this.queue[existingIdx] = { ...req, enqueuedAt: existing.enqueuedAt };
      }
      return true;
    }
    const decision = this.policy.evaluateActivation(req.agentId, {
      id: req.reason.eventId ?? "activation",
      type: req.reason.eventType ?? "message.sent",
      timestamp: new Date().toISOString(),
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
    this.queue.push({ agentId: req.agentId, reason: req.reason, priority: req.priority, enqueuedAt: Date.now(), explicit: req.explicit });
    this.queue.sort((a, b) => b.priority - a.priority || a.enqueuedAt - b.enqueuedAt);
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

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const idx = this.queue.findIndex((q) => !this.queueWait(q));
        // Every queued agent is held by something — its own turn, a concurrency
        // ceiling, or a parked scheduler. There is nothing to dispatch; which
        // of the three it was is recoverable from `queueWaits()`, live, when
        // the console asks. It is deliberately not an event: these resolve
        // constantly and one event per block would drown the log.
        if (idx < 0) break;
        const item = this.queue.splice(idx, 1)[0];
        this.runningMap.set(item.agentId, item);
        void this.runner
          .runTurn(item.agentId, item.reason)
          .catch(() => undefined)
          .finally(() => this.notifyTurnFinished(item.agentId));
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

  notifyTurnFinished(agentId: string): void {
    this.runningMap.delete(agentId);
    this.lastNudge.set(agentId, Date.now());
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
            note: `${unread.length} messages waiting in your mailbox.`,
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

  queueSnapshot(): Array<{ agentId: string; priority: number; reason: ActivationReason }> {
    return this.queue.map((q) => ({ agentId: q.agentId, priority: q.priority, reason: q.reason }));
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

  private checkIdle(): void {
    if (this.queue.length === 0 && this.runningMap.size === 0 && !this.idleFired) {
      this.idleFired = true;
      for (const cb of this.listeners) cb();
    }
  }

  private tickWaiting(): void {
    if (this.stopped) return;
    const now = Date.now();
    const goal = this.state.activeGoalId ? this.state.goals.get(this.state.activeGoalId) : undefined;
    if (!goal || goal.status !== "ACTIVE") return;
    this.pruneStallTracking();
    this.drainGathered(now);
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
      // Oldest-first by creation time (insertion order is not a reliable clock
      // once entries are deleted out of order). Scoped to the active goal so
      // a stale request from a previous mission cannot stall the new one.
      const activeGoal = this.state.activeGoalId;
      const oldestPending = [...this.state.pendingRequests.values()]
        .filter((pr) => stillOwes(pr, id) && pr.from !== id && (!pr.goalId || !activeGoal || pr.goalId === activeGoal))
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
        reason: { kind: "timer", note: `follow up on unanswered request ${oldestPending.messageId} (nudge ${count}/${MAX_NUDGES})` },
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
