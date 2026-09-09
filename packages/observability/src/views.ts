import type { MeshEvent, EventType } from "../../protocol/src/index";
import type { Projections } from "../../core/src/state";

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
  /** Full-fidelity fields for realtime clients (added without breaking old consumers). */
  id?: string;
  goalId?: string;
  causationId?: string;
  correlationId?: string;
  payload?: unknown;
}

export function eventTimeline(events: MeshEvent[], limit = 200): EventTimelineEntry[] {
  return events.slice(-limit).map((e) => ({
    seq: e.seq ?? 0,
    at: e.timestamp,
    type: e.type,
    actor: e.actorId,
    summary: summarize(e),
    id: (e as MeshEvent).id,
    goalId: e.goalId,
    causationId: e.causationId,
    correlationId: e.correlationId,
    payload: e.payload,
  }));
}

/** Full-coverage human summary for every canonical event type. */
export function summarize(e: MeshEvent): string {
  const p = (e.payload ?? {}) as Record<string, any>;
  switch (e.type) {
    case "goal.created":
      return `goal: ${(p.goal?.description ?? "").slice(0, 90)}`;
    case "goal.status_changed":
      return `${p.goalId?.slice(0, 12) ?? ""} → ${p.status}${p.reason ? ` (${String(p.reason).slice(0, 60)})` : ""}`;
    case "goal.paused":
      return `paused: ${String(p.reason ?? "").slice(0, 80)}`;
    case "goal.resumed":
      return `resumed: ${String(p.reason ?? "").slice(0, 80)}`;
    case "goal.reopened":
      return `reopened: ${String(p.reason ?? "").slice(0, 80)}`;
    case "goal.progress":
      return `${p.completed}/${p.total} criteria (${Math.round((p.ratio ?? 0) * 100)}%)`;
    case "goal.budget_changed": {
      const bits: string[] = [];
      if (typeof (p.budget as any)?.maxEvents === "number") bits.push(`maxEvents → ${(p.budget as any).maxEvents}`);
      if (typeof (p.budget as any)?.wallClockMinutes === "number") bits.push(`wallClock → ${(p.budget as any).wallClockMinutes}m`);
      if (typeof (p.budget as any)?.tokens === "number") bits.push(`tokens → ${(p.budget as any).tokens}`);
      return bits.join(" · ") || "caps changed";
    }
    case "goal.completed":
      return `reason=${p.reason}`;
    case "goal.escalated":
      return String(p.reason ?? "escalated").slice(0, 120);
    case "goal.failed":
      return String(p.reason ?? "failed").slice(0, 120);
    case "requirements.created":
      return `${Array.isArray(p.criteria) ? p.criteria.length : 0} criteria from ${shortId(p.artifactId)}`;
    case "requirement.blocked":
      return `${p.criterionId} blocked`;
    case "requirement.satisfied":
      return `${p.criterionId} evidenced (${(p.evidence as any)?.kind ?? "evidence"})`;
    case "agent.created":
      return `${p.agent?.id} (${p.agent?.role})`;
    case "agent.started":
      return `${p.agentId} session ${shortId(p.sessionId)}`;
    case "agent.awakened": {
      const r = p.reason ?? {};
      const why = r.kind ?? "?";
      const note = String(r.note ?? r.eventType ?? "").slice(0, 70);
      return `${p.agentId} (${why}${note ? ` · ${note}` : ""})${p.turnId ? ` · ${shortId(p.turnId)}` : ""}`;
    }
    case "agent.state_changed":
      return `${p.agentId} ${shortState(p.from)}→ ${p.to}${p.turnId ? ` · ${shortId(p.turnId)}` : ""}${p.note ? ` · ${String(p.note).slice(0, 60)}` : ""}`;
    case "agent.suspended":
      return `${p.agentId} suspended`;
    case "agent.resumed":
      return `${p.agentId} resumed`;
    case "agent.completed":
      return `${p.agentId} completed`;
    case "agent.failed":
      return `${p.agentId}: ${String(p.error ?? "").slice(0, 100)}`;
    case "agent.restarted":
      return `${p.agentId} restart #${p.attempt ?? "?"}`;
    case "agent.replaced":
      return `${p.agentId} replaced`;
    case "thread.created":
      return `${shortId(p.thread?.id)} “${String(p.thread?.subject ?? "").slice(0, 70)}”`;
    case "message.sent":
      return `${p.message?.from} → ${p.message?.to?.join(",")} : ${p.message?.type}`;
    case "message.delivered":
      return `${p.agentId} ⇐ ${shortId(p.messageId)}`;
    case "message.rejected":
      return `${p.from} blocked: ${String(p.reason ?? "").slice(0, 80)}`;
    case "artifact.created":
      return `${p.artifact?.type} '${p.artifact?.name}' v${p.artifact?.version} by ${p.artifact?.createdBy}`;
    case "artifact.versioned":
      return `${p.artifact?.type} '${p.artifact?.name}' → v${p.artifact?.version}`;
    case "artifact.transition":
      return `${shortId(p.artifactId)} → ${p.to}${p.derived ? " (derived)" : ""}`;
    case "task.created":
      return `${shortId(p.task?.id)} “${String(p.task?.title ?? "").slice(0, 70)}”`;
    case "task.claimed":
      return `${shortId(p.taskId)} by ${p.agentId ?? "—"}`;
    case "task.completed":
      return `${shortId(p.taskId)} · ${String(p.summary ?? "").slice(0, 70)}`;
    case "review.requested":
      return `${shortId(p.artifactId)} → ${Array.isArray(p.reviewers) ? p.reviewers.join(",") : ""}`;
    case "review.approved":
      return `${p.subject ?? ""}${p.artifactId ? ` ${shortId(p.artifactId)}` : ""} by ${e.actorId ?? ""}`;
    case "review.rejected":
      return `${p.subject ?? ""} rejected by ${e.actorId ?? ""}`;
    case "patch.created":
      return `${p.name ?? shortId(p.artifactId)} created`;
    case "patch.ready":
      return `${shortId(p.artifactId)} ready`;
    case "patch.merged":
      return `${p.name ?? shortId(p.artifactId)} merged`;
    case "architecture.approved":
      return `${p.subject ?? "architecture"} by ${e.actorId ?? ""}`;
    case "design.question":
      return String(p.question ?? p.artifactId ?? "").slice(0, 100);
    case "dependency.changed":
      return `${shortId(p.artifactId)} deps ${String(p.commit ?? "").slice(0, 12)}`;
    case "authentication.changed":
    case "authorization.changed":
      return `${shortId(p.artifactId)} ${e.type.split(".")[0]} change`;
    case "release.candidate":
      return `${p.name ?? shortId(p.artifactId)} candidate`;
    case "release.transition":
      return `${shortId(p.artifactId)} → ${p.to}`;
    case "release.accepted":
      return `${shortId(p.artifactId)} accepted`;
    case "research.requested":
      return String(p.question ?? "").slice(0, 100) || shortId(p.messageId);
    case "research.completed":
      return `${p.name ?? shortId(p.artifactId) ?? "cached"}${p.cached ? " (cached)" : ""}`;
    case "implementation.completed":
      return `${p.subject ?? "implementation"} ${shortId(p.artifactId)}`;
    case "decision.proposed":
      return `“${String(p.decision?.topic ?? "").slice(0, 80)}”`;
    case "decision.ratified":
      return `${shortId(p.decisionId)} ratified`;
    case "escalation.requested":
      return `${p.escalation?.raisedBy}: ${p.escalation?.reason}`;
    case "escalation.responded":
      return `responded: ${String(p.response ?? "").slice(0, 80)}`;
    case "human.input":
      return `${p.action ?? "input"} ${shortId(p.escalationId)}`;
    case "lease.acquired":
      return `${shortId(p.lease?.artifactId)} → ${p.lease?.agentId}`;
    case "lease.released":
      return `${shortId(p.leaseId)} released`;
    case "memory.updated":
      return `${p.agentId} remembers ${String((p.note as any)?.key ?? "").slice(0, 60)}`;
    case "budget.reserved":
      return `${shortKey(p.key)} reserve +${p.amount}`;
    case "budget.released":
      return `${shortKey(p.key)} release`;
    case "budget.consumed":
      return `${shortKey(p.key)}: +${p.amount} tokens${p.model ? ` · ${p.model}` : ""}${p.turnId ? ` · ${shortId(p.turnId)}` : ""}`;
    case "budget.exceeded":
      return `${shortKey(p.key)} ${p.consumed}/${p.limit} EXCEEDED`;
    case "budget.limit_raised":
      return `${shortKey(p.key)} limit → ${p.limit}${p.previous != null ? ` (was ${p.previous})` : ""}`;
    default:
      return (p as any).summary ? String((p as any).summary).slice(0, 120) : "";
  }
}

function shortId(v: unknown): string {
  const s = String(v ?? "");
  if (!s) return "—";
  if (s.length <= 14) return s;
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
}
function shortState(v: unknown): string {
  const s = String(v ?? "");
  return s ? `${s} ` : "";
}
function shortKey(k: unknown): string {
  return String(k ?? "").replace(/^(\w+):[^/]+\//, "$1:").replace(/goal-[A-Za-z0-9]+/i, (g) => g.slice(0, 9));
}

