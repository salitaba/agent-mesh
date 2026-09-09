import type { ActivationReason, MeshEvent, EventType, LifecycleState } from "../../protocol/src/index";
import type { ResolvedMeshConfig } from "../../config/src/index";
import { interestMatches } from "../../config/src/index";
import type { Projections } from "../../core/src/state";
import { stillOwes } from "../../core/src/state";
import type { PolicyEvaluator, SchedulerActivationRequest, SchedulerPort, TurnOutcome } from "../../core/src/ports";

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
  private stuckEscalated = new Set<string>();
  /**
   * Circuit breaker: consecutive non-ok turn outcomes per agent. At the limit
   * the agent parks (non-explicit activations refused) until the cooldown
   * lapses or a turn succeeds. Explicit operator wakes always bypass — the
   * operator is pacing those by hand.
   */
  private strikes = new Map<string, { count: number; parkedUntil: number }>();
  private static readonly STRIKE_LIMIT = 3;
  private static readonly PARK_MS = 30000;
  private listeners: Array<() => void> = [];
  private stopped = true;
  private idleFired = true;
  private lastNudge = new Map<string, number>();
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
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.queue = [];
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
    this.queue = [];
    this.runningMap = new Map();
    this.wakeAfterTurn = new Map();
    this.nudgeCounts = new Map();
    this.deniedCounts = new Map();
    this.stuckEscalated = new Set();
    this.strikes = new Map();
    this.lastNudge = new Map();
    this.interests = new Map();
    this.idleFired = true;
  }

  async handleEvent(event: MeshEvent): Promise<void> {
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
      for (const target of m.to) {
        if (target === m.from) continue;
        // Envelope, not payload: see MeshMessage.control. Reading activation
        // control out of agent-written JSON let a sender silence the wakeup
        // for its own message.
        if (m.control?.cacheServed === true) continue;
        await this.requestActivation({
          agentId: target,
          reason: { kind: "message", messageId: m.id, threadId: m.threadId, eventId: event.id, eventType: "message.sent" },
          priority: PRIORITY_BY_MESSAGE[m.priority] ?? 4,
        });
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
      if (triage === "IGNORE") continue;
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
    // Real work outstanding: it needs the turn regardless of the event.
    if ((this.state.unread.get(agentId)?.length ?? 0) > 0) return false;
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
    if (this.stopped && !req.explicit) return false;
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
    }    const decision = this.policy.evaluateActivation(req.agentId, {
      id: req.reason.eventId ?? "activation",
      type: req.reason.eventType ?? "message.sent",
      timestamp: new Date().toISOString(),
      // Thread context rides along so the policy can DEFER activations into
      // blown thread budgets (otherwise the turn fails instantly and the
      // unread-requeue spins a timer-free loop that starves HTTP).
      payload: { note: req.reason.note ?? req.reason.kind, threadId: req.reason.threadId },
    }, { config: this.config, projections: this.state, goal: this.state.activeGoalId ? this.state.goals.get(this.state.activeGoalId) : undefined });
    if (decision.decision === "DENY" || decision.decision === "DEFER") return false;
    this.queue.push({ agentId: req.agentId, reason: req.reason, priority: req.priority, enqueuedAt: Date.now(), explicit: req.explicit });
    this.queue.sort((a, b) => b.priority - a.priority || a.enqueuedAt - b.enqueuedAt);
    this.idleFired = false;
    void this.pump();
    return true;
  }

  private capacityAvailable(agentId: string): boolean {
    // Whole-team ceiling first: peers + services combined never exceed it.
    if (this.runningMap.size >= this.config.scheduling.maxTotalAgents) return false;
    const def = this.state.agents.get(agentId)?.definition;
    const mode = def?.mode ?? "peer";
    let peer = 0;
    let service = 0;
    for (const id of this.runningMap.keys()) {
      if (this.state.agents.get(id)?.definition.mode === "service") service++;
      else peer++;
    }
    return mode === "service"
      ? service < this.config.scheduling.maxParallelServiceAgents
      : peer < this.config.scheduling.maxActiveAgents;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        // Never start a duplicate turn for a mid-flight agent (see isBusy):
        // the duplicate bails out instantly and its finish requeues — the wedge.
        const idx = this.queue.findIndex((q) => !this.isBusy(q.agentId) && this.capacityAvailable(q.agentId) && (!this.stopped || q.explicit));
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

  notifyTurnFinished(agentId: string): void {
    this.runningMap.delete(agentId);
    this.lastNudge.set(agentId, Date.now());
    const deferred = this.wakeAfterTurn.get(agentId);
    if (deferred) {
      this.wakeAfterTurn.delete(agentId);
      // Re-run through the normal gate (dedup + lifecycle + policy/budget).
      // Direct queue pushes here bypassed the budget DEFER, so an exhausted
      // agent instantly failed again and again — a timer-free microtask loop
      // that starved HTTP (full "server not responding" wedge).
      void this.requestActivation({
        agentId,
        reason: deferred.reason,
        priority: deferred.priority,
        explicit: deferred.explicit,
      });
    } else if (!this.stopped && (this.state.unread.get(agentId)?.length ?? 0) > 0) {
      const oldest = this.state.unread.get(agentId)![0];
      const msg = this.state.messages.get(oldest);
      void this.requestActivation({
        agentId,
        reason: { kind: "message", messageId: oldest, threadId: msg?.threadId, note: "mail queued while running" },
        priority: 5,
      });
    }
    void this.pump();
  }

  notifyMailDelivered(agentId: string): void {
    void this.requestActivation({
      agentId,
      reason: { kind: "message", note: "mail delivered" },
      priority: 4,
    });
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
        const mail = (this.state.unread.get(id)?.length ?? 0) > 0;
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
      // Parked by the circuit breaker: leave it alone (and do NOT count a
      // denial — a parked agent is resting, not stonewalling a request).
      if (this.isParkedForBackoff(id)) {
        this.lastNudge.set(id, now);
        continue;
      }
      const unread = this.state.unread.get(id)?.length ?? 0;
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
