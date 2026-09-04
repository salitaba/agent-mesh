import type { ActivationReason, MeshEvent, EventType, LifecycleState } from "../../protocol/src/index";
import type { ResolvedMeshConfig } from "../../config/src/index";
import { interestMatches } from "../../config/src/index";
import type { Projections } from "../../core/src/state";
import type { PolicyEvaluator, SchedulerActivationRequest, SchedulerPort } from "../../core/src/ports";

export interface TurnRunner {
  runTurn(agentId: string, reason: ActivationReason): Promise<void>;
  escalateStuckRequest?(agentId: string, messageId: string): Promise<void>;
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
  private stuckEscalated = new Set<string>();
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
    this.stopped = false;
    this.rebuildInterestRegistry();
    this.timer = setInterval(() => this.tickWaiting(), this.config.scheduling.waitWakeupMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.queue = [];
    const deadline = Date.now() + 5000;
    while (this.runningMap.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  async handleEvent(event: MeshEvent): Promise<void> {
    if (this.stopped) return;
    const goal = this.state.activeGoalId ? this.state.goals.get(this.state.activeGoalId) : undefined;
    if (!goal || goal.status === "PAUSED" || goal.status === "COMPLETED" || goal.status === "FAILED") return;

    if (event.type === "message.sent") {
      const m = (event.payload as { message: import("../../protocol/src/index").MeshMessage }).message;
      for (const target of m.to) {
        if (target === m.from) continue;
        if ((m.payload as Record<string, unknown> | undefined)?.cacheServed === true) continue;
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
      const triage = await this.triage(agentId, event);
      if (triage === "IGNORE") continue;
      await this.requestActivation({
        agentId,
        reason: { kind: "interest_event", eventId: event.id, eventType: event.type },
        priority: triage === "ACT" ? 5 : 3,
      });
    }
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
    const text = JSON.stringify(event.payload).toLowerCase();
    const rules = this.config.scheduling.triageRules.filter((r) => r.agent === agentId && (!r.event || r.event === event.type));
    for (const rule of rules) {
      if (rule.actIfTextMatches.some((needle) => text.includes(needle.toLowerCase()))) return "ACT";
      if (rule.ignoreIfTextMatches.some((needle) => text.includes(needle.toLowerCase()))) return "IGNORE";
    }
    return "SKIM";
  }

  async requestActivation(req: SchedulerActivationRequest): Promise<boolean> {
    if (this.stopped && !req.explicit) return false;
    const rec = this.state.agents.get(req.agentId);
    if (!rec) return false;
    if (rec.state.agentId === "human") return false;
    const lifecycle: LifecycleState = rec.state.lifecycle;
    if (lifecycle === "SUSPENDED" || lifecycle === "COMPLETED") return false;
    if (this.runningMap.has(req.agentId)) {
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
      payload: { note: req.reason.note ?? req.reason.kind },
    }, { config: this.config, projections: this.state, goal: this.state.activeGoalId ? this.state.goals.get(this.state.activeGoalId) : undefined });
    if (decision.decision === "DENY" || decision.decision === "DEFER") return false;
    this.queue.push({ agentId: req.agentId, reason: req.reason, priority: req.priority, enqueuedAt: Date.now(), explicit: req.explicit });
    this.queue.sort((a, b) => b.priority - a.priority || a.enqueuedAt - b.enqueuedAt);
    this.idleFired = false;
    void this.pump();
    return true;
  }

  private capacityAvailable(agentId: string): boolean {
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
        const idx = this.queue.findIndex((q) => this.capacityAvailable(q.agentId) && (!this.stopped || q.explicit));
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
      if (this.stopped && !deferred.explicit) return;
      const rec = this.state.agents.get(agentId);
      if (!rec || rec.state.lifecycle === "SUSPENDED" || rec.state.lifecycle === "COMPLETED") return;
      const decision = this.policy.evaluateActivation(agentId, {
        id: deferred.reason.eventId ?? "activation",
        type: deferred.reason.eventType ?? "message.sent",
        timestamp: new Date().toISOString(),
        payload: { note: deferred.reason.note ?? deferred.reason.kind },
      }, { config: this.config, projections: this.state, goal: this.state.activeGoalId ? this.state.goals.get(this.state.activeGoalId) : undefined });
      if (decision.decision !== "DENY" && decision.decision !== "DEFER") {
        this.queue.push({ agentId, reason: deferred.reason, priority: deferred.priority, enqueuedAt: Date.now(), explicit: deferred.explicit });
        this.idleFired = false;
      }
    } else if (!this.stopped && (this.state.unread.get(agentId)?.length ?? 0) > 0 && !this.queue.some((q) => q.agentId === agentId)) {
      const oldest = this.state.unread.get(agentId)![0];
      const msg = this.state.messages.get(oldest);
      this.queue.push({
        agentId,
        reason: { kind: "message", messageId: oldest, threadId: msg?.threadId, note: "mail queued while running" },
        priority: 5,
        enqueuedAt: Date.now(),
      });
      this.idleFired = false;
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
    for (const rec of this.state.agents.values()) {
      const id = rec.state.agentId;
      if (id === "human") continue;
      if (rec.state.lifecycle === "SUSPENDED" || rec.state.lifecycle === "COMPLETED" || rec.state.lifecycle === "FAILED" || rec.state.lifecycle === "BLOCKED") continue;
      if (this.runningMap.has(id) || this.queue.some((q) => q.agentId === id)) continue;
      const unread = this.state.unread.get(id)?.length ?? 0;
      const oldestPending = [...this.state.pendingRequests.values()].find((pr) => pr.to.includes(id) && pr.from !== id);
      const age = now - (this.lastNudge.get(id) ?? 0);
      if (age < this.config.scheduling.waitWakeupMs) continue;
      if (unread > 0) {
        this.lastNudge.set(id, now);
        void this.requestActivation({
          agentId: id,
          reason: { kind: "timer", note: "queued mail while waiting; follow up or close the loop" },
          priority: 3,
        });
        continue;
      }
      if (oldestPending) {
        const key = `${id}:${oldestPending.messageId}`;
        const count = (this.nudgeCounts.get(key) ?? 0) + 1;
        this.nudgeCounts.set(key, count);
        this.lastNudge.set(id, now);
        if (count > MAX_NUDGES) {
          // the request is not being answered: stop burning tokens and escalate
          // to the human (§33.4 stalemate -> deadlock-detector path)
          if (!this.stuckEscalated.has(key)) {
            this.stuckEscalated.add(key);
            void this.runner.escalateStuckRequest?.(id, oldestPending.messageId);
          }
          continue;
        }
        void this.requestActivation({
          agentId: id,
          reason: { kind: "timer", note: `follow up on unanswered request ${oldestPending.messageId} (nudge ${count}/${MAX_NUDGES})` },
          priority: 3,
        });
      }
    }
  }
}

export { interestMatches };
