import type { MeshEvent } from "../../protocol/src/index";
import type { Projections } from "../../core/src/state";
import type { ResolvedMeshConfig } from "../../config/src/index";
import type { TurnStep } from "./steps";
import { eventTimeline, type EventTimelineEntry } from "./views";

export interface AgentActivity {
  agentId: string;
  role: string;
  lifecycle: string;
  running: boolean;
  currentTurnId?: string;
  lastActivityAt: string;
  activations: number;
  tokens: number;
  mailbox: number;
  activeTaskId?: string;
  lastError?: string;
}

export function buildAgentActivity(state: Projections, steps: TurnStep[] = []): AgentActivity[] {
  const running = new Map<string, string>();
  for (const s of steps) if (s.status === "running") running.set(s.agentId, s.turnId);
  return [...state.agents.values()].map((r) => ({
    agentId: r.definition.id,
    role: r.definition.role,
    lifecycle: r.state.lifecycle,
    running: running.has(r.definition.id) || ["THINKING", "WORKING", "OBSERVING", "REQUESTING", "REVIEWING", "AWAKENED"].includes(r.state.lifecycle),
    currentTurnId: running.get(r.definition.id),
    lastActivityAt: r.state.lastActivityAt,
    activations: r.state.activations,
    tokens: r.state.tokensConsumed,
    mailbox: state.unread.get(r.definition.id)?.length ?? 0,
    activeTaskId: r.state.activeTaskId,
    lastError: r.state.lastError,
  }));
}

// ---------------------------------------------------------------- agent detail

export interface AgentDetailBudget {
  key: string;
  limitKind: string;
  limit: number | null;
  reserved: number;
  consumed: number;
  exceeded: boolean;
  remaining: number | null;
  pct: number | null;
}

export interface AgentDetailThread {
  id: string;
  subject: string;
  status: string;
  participants: string[];
  messageCount: number;
  createdAt: string;
}

export interface AgentDetailLease {
  id: string;
  artifactId: string;
  worktreePath: string;
  active: boolean;
  acquiredAt: string;
  releasedAt?: string;
}

export interface AgentDetail {
  /** Legacy compat: same shape as the old GET /agents/:id. */
  definition: unknown;
  state: unknown;
  unread: string[];
  memory: unknown[];
  session: unknown;
  /** Full inbox content (not just ids). */
  unreadMessages: unknown[];
  recentMessages: unknown[];
  recentSteps: TurnStep[];
  currentTurnId?: string;
  activeTask?: unknown;
  tasksInvolved: unknown[];
  artifacts: unknown[];
  threads: AgentDetailThread[];
  budgets: {
    agent?: AgentDetailBudget;
    agentConfiguredTokens: number | null;
    mission?: AgentDetailBudget;
  };
  approvals: unknown[];
  decisions: unknown[];
  escalations: unknown[];
  leases: AgentDetailLease[];
  pendingRequests: unknown[];
  recentEvents: EventTimelineEntry[];
  communication: { mayContact: string[]; mayBeContactedBy: string[] };
  stats: {
    messagesSent: number;
    messagesReceived: number;
    artifactsCreated: number;
    tasksInvolved: number;
    activations: number;
    tokens: number;
    mailbox: number;
  };
}

function toDetailBudget(b: { key: string; limitKind: string; limit: number | null; reserved: number; consumed: number; exceeded: boolean } | undefined): AgentDetailBudget | undefined {
  if (!b) return undefined;
  const remaining = b.limit === null ? null : Math.max(0, b.limit - b.consumed);
  const pct = b.limit === null || b.limit === 0 ? null : Math.min(1, b.consumed / b.limit);
  return { key: b.key, limitKind: b.limitKind, limit: b.limit, reserved: b.reserved, consumed: b.consumed, exceeded: b.exceeded, remaining, pct };
}

function involvesAgent(e: MeshEvent, agentId: string): boolean {
  if (e.actorId === agentId) return true;
  const p = (e.payload ?? {}) as Record<string, any>;
  if (p.agentId === agentId) return true;
  if (typeof p.raisedBy === "string" && p.raisedBy === agentId) return true;
  const msg = p.message as Record<string, any> | undefined;
  if (msg && (msg.from === agentId || (Array.isArray(msg.to) && msg.to.includes(agentId)))) return true;
  if (typeof p.messageId === "string") return false;
  return false;
}

export function buildAgentDetail(
  state: Projections,
  config: ResolvedMeshConfig,
  agentId: string,
  opts: { steps?: TurnStep[]; events?: MeshEvent[]; currentTurnId?: string } = {},
): AgentDetail | null {
  const rec = state.agents.get(agentId);
  if (!rec) return null;
  const goalId = state.activeGoalId ?? "";

  const unreadIds = state.unread.get(agentId) ?? [];
  const unreadMessages = unreadIds
    .slice(0, 12)
    .map((id) => state.messages.get(id))
    .filter(Boolean)
    .slice(0, 12);

  const allRelated: MeshEvent[] = [];
  void allRelated;

  let messagesSent = 0;
  let messagesReceived = 0;
  // Single pass with a bounded recency window: sorting every related message
  // is O(n log n) on the whole log per inspect request (the dashboard calls
  // this per open drawer). Insertion order ≈ chronological, so the last
  // WINDOW matches hold the most recent ones; only those get sorted.
  const window: Array<{ m: (typeof state.messages extends Map<string, infer V> ? V : never); ts: string; i: number }> = [];
  const WINDOW = 200;
  let order = 0;
  for (const m of state.messages.values()) {
    const sent = m.from === agentId;
    const received = m.to.includes(agentId);
    if (sent) messagesSent++;
    if (received) messagesReceived++;
    if (sent || received) {
      window.push({ m, ts: m.timestamp, i: order++ });
      if (window.length > WINDOW) window.splice(0, window.length - WINDOW);
    }
  }
  // Newest first; insertion order breaks timestamp ties (identical ms stamps
  // in burst traffic) so "recent" stays recent instead of sort-stable oldest.
  window.sort((a, b) => b.ts.localeCompare(a.ts) || b.i - a.i);
  const recentMessages = window.slice(0, 20).map((r) => r.m);

  const artifacts = [...state.artifacts.values()]
    .filter((a) => a.owner === agentId || a.createdBy === agentId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 20);

  const tasksInvolved = [...state.tasks.values()]
    .filter((t) => t.claimedBy === agentId || t.assignedTo === agentId || t.createdBy === agentId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 15);
  const activeTask = rec.state.activeTaskId ? state.tasks.get(rec.state.activeTaskId) ?? undefined : undefined;

  const threads: AgentDetailThread[] = [...state.threads.values()]
    .filter((t) => t.participants.includes(agentId))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 10)
    .map((t) => ({
      id: t.id,
      subject: t.subject,
      status: t.status,
      participants: t.participants,
      messageCount: t.messageIds.length,
      createdAt: t.createdAt,
    }));

  const agentBudget = goalId ? state.budgets.get(`agent:${goalId}/${agentId}`) : undefined;
  const missionBudget = goalId ? state.budgets.get(`mission:${goalId}`) : undefined;

  const approvals = [...state.approvals.values()]
    .flat()
    .filter((a) => a.actorId === agentId)
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
    .slice(0, 10);

  const decisions = [...state.decisions.values()]
    .filter((d) => d.proposedBy === agentId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 10);

  const escalations = [...state.escalations.values()]
    .filter((e) => {
      if (e.raisedBy === agentId) return true;
      const d = (e.detail ?? {}) as Record<string, unknown>;
      return d.agentId === agentId;
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 10);

  const leases: AgentDetailLease[] = [...state.leases.values()]
    .filter((l) => l.agentId === agentId)
    .sort((a, b) => b.acquiredAt.localeCompare(a.acquiredAt))
    .slice(0, 10)
    .map((l) => ({
      id: l.id,
      artifactId: l.artifactId,
      worktreePath: l.worktreePath,
      active: !l.releasedAt,
      acquiredAt: l.acquiredAt,
      releasedAt: l.releasedAt,
    }));

  const pendingRequests = [...state.pendingRequests.values()]
    .filter((r) => r.from === agentId || r.to.includes(agentId))
    .slice(0, 10);

  const tail = opts.events ?? [];
  const agentEvents = tail.filter((e) => involvesAgent(e, agentId)).slice(-20);
  const recentEvents = eventTimeline(agentEvents, agentEvents.length).reverse();

  const recentSteps = (opts.steps ?? []).filter((s) => s.agentId === agentId).slice(0, 10);

  return {
    definition: rec.definition,
    state: rec.state,
    unread: [...unreadIds],
    memory: [...(state.memory.get(agentId)?.values() ?? [])],
    session: state.sessionMap.get(agentId) ?? null,
    unreadMessages,
    recentMessages,
    recentSteps,
    currentTurnId: opts.currentTurnId,
    activeTask,
    tasksInvolved,
    artifacts,
    threads,
    budgets: {
      agent: toDetailBudget(agentBudget),
      agentConfiguredTokens: (config.agents[agentId] as { budget?: { tokens?: number } } | undefined)?.budget?.tokens ?? config.budgets.perAgent[agentId] ?? null,
      mission: toDetailBudget(missionBudget),
    },
    approvals,
    decisions,
    escalations,
    leases,
    pendingRequests,
    recentEvents,
    communication: {
      mayContact: rec.definition.communicationPolicy?.mayContact ?? [],
      mayBeContactedBy: rec.definition.communicationPolicy?.mayBeContactedBy ?? [],
    },
    stats: {
      messagesSent,
      messagesReceived,
      artifactsCreated: artifacts.length,
      tasksInvolved: tasksInvolved.length,
      activations: rec.state.activations,
      tokens: rec.state.tokensConsumed,
      mailbox: unreadIds.length,
    },
  };
}
