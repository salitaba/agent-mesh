import type { MeshEvent } from "../../protocol/src/index";
import type { Projections } from "../../core/src/state";

export interface SchedulerView {
  pending: number;
  running: number;
  queue: Array<{ agentId: string; priority: number; reasonKind: string; note?: string }>;
  runningAgents: string[];
  /** Configured ceilings, so operators can see what caps the queue. */
  limits?: { total: number; peer: number; service: number };
}

export function buildSchedulerView(
  pending: number,
  running: number,
  queue: Array<{ agentId: string; priority: number; reason: { kind: string; note?: string } }>,
  runningAgents: string[] = [],
  limits?: { total: number; peer: number; service: number },
): SchedulerView {
  return {
    pending,
    running,
    queue: queue.map((q) => ({ agentId: q.agentId, priority: q.priority, reasonKind: q.reason.kind, note: q.reason.note })),
    runningAgents,
    ...(limits ? { limits } : {}),
  };
}

export interface MetricsSnapshot {
  events: number;
  messages: number;
  activations: number;
  artifacts: number;
  openTasks: number;
  completedTasks: number;
  approvals: number;
  rejections: number;
  escalationsOpen: number;
  tokensTotal: number;
  wallClockMs: number;
  conflicts: Array<{ key: string; count: number }>;
  /** Enriched (optional so old consumers keep working). */
  byLifecycle?: Record<string, number>;
  byEventType?: Record<string, number>;
  tokensPerMin?: number;
  eventsPerMin?: number;
}

export function buildMetrics(state: Projections, wallClockMs: number, recentEvents?: MeshEvent[]): MetricsSnapshot {
  let activations = 0;
  let tokensTotal = 0;
  const byLifecycle: Record<string, number> = {};
  for (const r of state.agents.values()) {
    activations += r.state.activations;
    tokensTotal += r.state.tokensConsumed;
    byLifecycle[r.state.lifecycle] = (byLifecycle[r.state.lifecycle] ?? 0) + 1;
  }
  let approvals = 0;
  let rejections = 0;
  for (const list of state.approvals.values()) {
    for (const a of list) {
      if (a.kind === "approve" || a.kind === "pass" || a.kind === "accept" || a.kind === "merge") approvals++;
      else rejections++;
    }
  }
  const byEventType: Record<string, number> | undefined = recentEvents
    ? recentEvents.reduce<Record<string, number>>((acc, e) => {
        acc[e.type] = (acc[e.type] ?? 0) + 1;
        return acc;
      }, {})
    : undefined;
  const mins = Math.max(wallClockMs / 60000, 1 / 60);
  return {
    events: state.eventCount,
    messages: state.messages.size,
    activations,
    artifacts: state.artifacts.size,
    openTasks: [...state.tasks.values()].filter((t) => t.status === "OPEN" || t.status === "CLAIMED" || t.status === "IN_PROGRESS").length,
    completedTasks: [...state.tasks.values()].filter((t) => t.status === "COMPLETED").length,
    approvals,
    rejections,
    escalationsOpen: [...state.escalations.values()].filter((e) => e.status === "OPEN").length,
    tokensTotal,
    wallClockMs,
    conflicts: [...state.conflicts.values()].map((c) => ({ key: c.key, count: c.count })),
    byLifecycle,
    byEventType,
    tokensPerMin: Math.round(tokensTotal / mins),
    eventsPerMin: Math.round((state.eventCount / mins) * 10) / 10,
  };
}

// ---------------------------------------------------------------- SSE hub

export interface SseClient {
  write(chunk: string): void;
  end(): void;
}

export function formatSse(event: MeshEvent): string {
  const id = event.seq ?? event.id;
  return `id: ${id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
