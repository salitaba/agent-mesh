import type { MeshEvent, EventType } from "../../protocol/src/index";
import type { Projections } from "../../core/src/state";
import type { ResolvedMeshConfig } from "../../config/src/index";

export interface GraphEdge {
  from: string;
  to: string;
  kind: "REQUEST" | "APPROVE" | "BLOCK" | "ESCALATE" | "INFORM" | "OTHER";
  count: number;
  lastAt: string;
}

export interface GraphNode {
  id: string;
  role: string;
  lifecycle: string;
  tokens: number;
}

export function buildMeshGraph(state: Projections): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [...state.agents.values()].map((r) => ({
    id: r.definition.id,
    role: r.definition.role,
    lifecycle: r.state.lifecycle,
    tokens: r.state.tokensConsumed,
  }));
  const edgeMap = new Map<string, GraphEdge>();
  const kindOf = (t: string): GraphEdge["kind"] =>
    t.startsWith("REQUEST") || t === "DELEGATE"
      ? "REQUEST"
      : t === "APPROVE"
        ? "APPROVE"
        : t === "BLOCK" || t === "VETO" || t === "REJECT"
          ? "BLOCK"
          : t === "ESCALATE"
            ? "ESCALATE"
            : t === "INFORM" || t === "DONE"
              ? "INFORM"
              : "OTHER";
  for (const m of state.messages.values()) {
    for (const target of m.to) {
      const key = `${m.from}|${target}|${kindOf(m.type)}`;
      const e = edgeMap.get(key) ?? { from: m.from, to: target, kind: kindOf(m.type), count: 0, lastAt: m.timestamp };
      e.count++;
      if (m.timestamp > e.lastAt) e.lastAt = m.timestamp;
      edgeMap.set(key, e);
    }
  }
  return { nodes, edges: [...edgeMap.values()] };
}

export interface CostReport {
  perAgent: Array<{ agentId: string; tokens: number; activations: number }>;
  missionTokens: number;
  missionBudget: number;
  perModel: Record<string, number>;
}

export function buildCostReport(state: Projections, config: ResolvedMeshConfig): CostReport {
  const perAgent = [...state.agents.values()].map((r) => ({
    agentId: r.definition.id,
    tokens: r.state.tokensConsumed,
    activations: r.state.activations,
  }));
  const mission = state.budgets.get(`mission:${state.activeGoalId ?? ""}`);
  const perModel: Record<string, number> = {};
  for (const e of [...state.turnAudit.values()]) {
    void e;
  }
  return {
    perAgent,
    missionTokens: mission?.consumed ?? perAgent.reduce((a, b) => a + b.tokens, 0),
    missionBudget: mission?.limit ?? config.budgets.mission.tokens,
    perModel,
  };
}

export interface GoalView {
  goalId: string;
  description: string;
  status: string;
  progress: Array<{ id: string; description: string; status: string; ratio: number; evidenceCount: number }>;
  ratio: number;
}

export function buildGoalView(state: Projections): GoalView | null {
  const gid = state.activeGoalId;
  if (!gid) return null;
  const goal = state.goals.get(gid);
  if (!goal) return null;
  const progress = goal.acceptanceCriteria.map((c) => ({
    id: c.id,
    description: c.description,
    status: c.status,
    ratio: c.status === "EVIDENCED" || c.status === "WAIVED" ? 1 : 0,
    evidenceCount: c.evidence.length,
  }));
  const mandatory = progress.filter((p) => goal.acceptanceCriteria.find((c) => c.id === p.id)?.mandatory);
  const done = mandatory.filter((p) => p.ratio === 1).length;
  return {
    goalId: goal.id,
    description: goal.description,
    status: goal.status,
    progress,
    ratio: mandatory.length ? done / mandatory.length : 0,
  };
}

export interface ArtifactTimelineEntry {
  artifactId: string;
  name: string;
  type: string;
  version: number;
  status: string;
  at: string;
  by: string;
}

export function buildArtifactTimeline(state: Projections): ArtifactTimelineEntry[] {
  const out: ArtifactTimelineEntry[] = [];
  for (const [, history] of state.artifactHistory) {
    for (const a of history) {
      out.push({ artifactId: a.id, name: a.name, type: a.type, version: a.version, status: a.status, at: a.createdAt, by: a.createdBy });
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

export interface EventTimelineEntry {
  seq: number;
  at: string;
  type: EventType;
  actor?: string;
  summary: string;
}

export function eventTimeline(events: MeshEvent[], limit = 200): EventTimelineEntry[] {
  return events.slice(-limit).map((e) => ({
    seq: e.seq ?? 0,
    at: e.timestamp,
    type: e.type,
    actor: e.actorId,
    summary: summarize(e),
  }));
}

function summarize(e: MeshEvent): string {
  const p = (e.payload ?? {}) as Record<string, any>;
  switch (e.type) {
    case "message.sent":
      return `${p.message?.from} → ${p.message?.to?.join(",")} : ${p.message?.type}`;
    case "message.rejected":
      return `${p.from} blocked: ${String(p.reason ?? "").slice(0, 80)}`;
    case "artifact.created":
      return `${p.artifact?.type} '${p.artifact?.name}' v${p.artifact?.version} by ${p.artifact?.createdBy}`;
    case "artifact.versioned":
      return `${p.artifact?.type} '${p.artifact?.name}' → v${p.artifact?.version}`;
    case "artifact.transition":
      return `${p.artifactId} → ${p.to}`;
    case "agent.awakened":
      return `${p.agentId} (${p.reason?.kind ?? "?"})`;
    case "budget.consumed":
      return `${p.key}: +${p.amount} tokens`;
    case "escalation.requested":
      return `${p.escalation?.raisedBy}: ${p.escalation?.reason}`;
    case "goal.completed":
      return `reason=${p.reason}`;
    default:
      return "";
  }
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
}

export function buildMetrics(state: Projections, wallClockMs: number): MetricsSnapshot {
  let activations = 0;
  let tokensTotal = 0;
  for (const r of state.agents.values()) {
    activations += r.state.activations;
    tokensTotal += r.state.tokensConsumed;
  }
  let approvals = 0;
  let rejections = 0;
  for (const list of state.approvals.values()) {
    for (const a of list) {
      if (a.kind === "approve" || a.kind === "pass" || a.kind === "accept" || a.kind === "merge") approvals++;
      else rejections++;
    }
  }
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
  };
}

export class SseHub {
  private clients = new Set<{ write(chunk: string): void; end(): void }>();

  add(res: { write(chunk: string): void; end(): void }): () => void {
    res.write(": connected\n\n");
    this.clients.add(res);
    return () => this.clients.delete(res);
  }

  broadcast(event: MeshEvent): void {
    const data = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(data);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  close(): void {
    for (const c of this.clients) c.end();
    this.clients.clear();
  }
}
