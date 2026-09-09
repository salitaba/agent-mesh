import type { MeshEvent } from "../../protocol/src/index";

export type TurnStatus = "running" | "ok" | "waiting" | "blocked" | "failed";

export interface TurnStep {
  turnId: string;
  agentId: string;
  reasonKind: string;
  reasonNote?: string;
  triggerEventType?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status: TurnStatus;
  lifecycle: string;
  ops: { messages: number; artifacts: number; tasks: number; decisions: number };
  messageIds: string[];
  artifactIds: string[];
  tokens: number;
  model?: string;
  error?: string;
  seqStart: number;
  seqEnd: number;
  eventCount: number;
  /**
   * Live-only enrichment merged in from the in-memory turn tracker. Absent for
   * turns reconstructed purely from the log (the log carries no sub-turn
   * timing), so every consumer must treat these as optional.
   */
  phases?: {
    startedAt: number;
    contextAt?: number;
    llmCallAt?: number;
    firstTokenAt?: number;
    lastTokenAt?: number;
    llmDoneAt?: number;
    opsStartAt?: number;
    opsDoneAt?: number;
    endedAt?: number;
  };
  attempt?: number;
  streamChars?: number;
  /** Structured crash detail (kind, message, frames, cause chain, phase). */
  errorDetail?: {
    kind: string;
    message: string;
    frames?: string[];
    causes?: Array<{ kind: string; message: string }>;
    phase?: string;
  };
  /** Per-op kernel latency, in execution order. */
  opTimings?: Array<{ op: string; ms: number; ok: boolean; reason?: string }>;
}

function turnIdOf(e: MeshEvent): string | undefined {
  const p = (e.payload ?? {}) as Record<string, any>;
  if (typeof p.turnId === "string" && p.turnId) return p.turnId;
  const c = e.correlationId ?? "";
  if (c.startsWith("turn-")) return c;
  return undefined;
}

/**
 * Reconstruct per-agent turn traces (“any step”) from the append-only log.
 * Works for live + replayed logs: prefers explicit turnId correlation,
 * falls back to per-agent running-step attribution for messages/artifacts.
 */
export function buildTurnSteps(events: MeshEvent[], limit = 60): TurnStep[] {
  const byTurn = new Map<string, TurnStep>();
  const runningByAgent = new Map<string, string>(); // agentId -> turnId
  const awakenedIdToTurn = new Map<string, string>(); // activation event id -> turnId

  const ensure = (turnId: string, agentId: string, at: string, seq: number): TurnStep => {
    let s = byTurn.get(turnId);
    if (!s) {
      s = {
        turnId,
        agentId,
        reasonKind: "unknown",
        startedAt: at,
        status: "running",
        lifecycle: "AWAKENED",
        ops: { messages: 0, artifacts: 0, tasks: 0, decisions: 0 },
        messageIds: [],
        artifactIds: [],
        tokens: 0,
        seqStart: seq,
        seqEnd: seq,
        eventCount: 0,
      };
      byTurn.set(turnId, s);
    }
    return s;
  };

  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, any>;
    const seq = e.seq ?? 0;

    if (e.type === "agent.awakened") {
      const agentId = String(p.agentId ?? e.actorId ?? "");
      if (!agentId) continue;
      const turnId = (p.turnId as string) || `awakened:${e.id}`;
      const s = ensure(turnId, agentId, e.timestamp, seq);
      s.reasonKind = p.reason?.kind ?? "unknown";
      s.reasonNote = p.reason?.note ?? p.reason?.eventType;
      s.triggerEventType = p.reason?.eventType;
      s.startedAt = s.startedAt ?? e.timestamp;
      s.seqStart = Math.min(s.seqStart, seq);
      s.seqEnd = Math.max(s.seqEnd, seq);
      s.eventCount++;
      s.lifecycle = "AWAKENED";
      runningByAgent.set(agentId, turnId);
      awakenedIdToTurn.set(e.id, turnId);
      continue;
    }

    const tid = turnIdOf(e);

    if (e.type === "agent.state_changed") {
      const agentId = String(p.agentId ?? e.actorId ?? "");
      let s: TurnStep | undefined;
      if (tid) s = byTurn.get(tid) ?? (agentId ? ensure(tid, agentId, e.timestamp, seq) : undefined);
      else if (agentId && runningByAgent.has(agentId)) s = byTurn.get(runningByAgent.get(agentId)!);
      else if (e.causationId && awakenedIdToTurn.has(e.causationId)) {
        s = byTurn.get(awakenedIdToTurn.get(e.causationId)!);
      }
      if (!s) continue;
      // Adopt the explicit turnId once we see it (provisional awakened:xxx -> real turn-xxx).
      if (tid && s.turnId !== tid) {
        byTurn.delete(s.turnId);
        s.turnId = tid;
        byTurn.set(tid, s);
        if (s.agentId) runningByAgent.set(s.agentId, tid);
      }
      s.lifecycle = String(p.to ?? s.lifecycle);
      s.seqEnd = Math.max(s.seqEnd, seq);
      s.eventCount++;
      const to = String(p.to ?? "");
      if (["IDLE", "WAITING", "BLOCKED"].includes(to) && (p.turnId || tid)) {
        s.endedAt = e.timestamp;
        s.durationMs = Math.max(0, Date.parse(e.timestamp) - Date.parse(s.startedAt));
        s.status = to === "IDLE" ? "ok" : to === "WAITING" ? "waiting" : "blocked";
        if (runningByAgent.get(s.agentId) === s.turnId) runningByAgent.delete(s.agentId);
      }
      continue;
    }

    if (e.type === "agent.failed") {
      const agentId = String(p.agentId ?? e.actorId ?? "");
      const key = (tid && byTurn.get(tid)) ? tid : runningByAgent.get(agentId);
      const s = key ? byTurn.get(key) : undefined;
      if (!s) continue;
      s.status = "failed";
      s.error = String(p.error ?? "runtime failure").slice(0, 300);
      s.endedAt = e.timestamp;
      s.durationMs = Math.max(0, Date.parse(e.timestamp) - Date.parse(s.startedAt));
      s.seqEnd = Math.max(s.seqEnd, seq);
      s.eventCount++;
      if (runningByAgent.get(s.agentId) === s.turnId) runningByAgent.delete(s.agentId);
      continue;
    }

    if (e.type === "budget.consumed" && tid) {
      const s = byTurn.get(tid);
      if (s) {
        const amt = Number(p.amount ?? 0);
        // Mission/thread consumes mirror the agent consume; only count agent-scoped keys once.
        if (typeof p.key === "string" && p.key.startsWith("agent:")) {
          s.tokens += amt;
          if (p.model) s.model = String(p.model);
        }
        s.seqEnd = Math.max(s.seqEnd, seq);
        s.eventCount++;
      }
      continue;
    }

    // Attribute side-effect events to the agent's running turn.
    if (
      e.type === "message.sent" ||
      e.type === "artifact.created" ||
      e.type === "artifact.versioned" ||
      e.type === "task.created" ||
      e.type === "task.claimed" ||
      e.type === "task.completed" ||
      e.type === "decision.proposed" ||
      // A recorded decision IS output. Counting only `decision.proposed` meant
      // an approval — the single most consequential act in a review-gated mesh
      // — rendered as "wrote nothing", because `approve` emits review.approved
      // / requirement.satisfied / architecture.approved instead. Two real
      // approvals worth 59k tokens were filed as waste in one live run, which
      // both slandered the agents and hid the actual idling.
      e.type === "review.approved" ||
      e.type === "review.rejected" ||
      e.type === "requirement.satisfied" ||
      e.type === "architecture.approved" ||
      e.type === "artifact.transition"
    ) {
      let s: TurnStep | undefined;
      if (tid) s = byTurn.get(tid);
      if (!s && e.actorId && runningByAgent.has(e.actorId)) s = byTurn.get(runningByAgent.get(e.actorId!)!);
      if (!s) continue;
      s.seqEnd = Math.max(s.seqEnd, seq);
      s.eventCount++;
      if (e.type === "message.sent") {
        s.ops.messages++;
        const mid = (p.message as any)?.id;
        if (mid) s.messageIds.push(String(mid));
      } else if (e.type === "artifact.created" || e.type === "artifact.versioned") {
        s.ops.artifacts++;
        const aid = (p.artifact as any)?.id;
        if (aid) s.artifactIds.push(String(aid));
      } else if (e.type.startsWith("task.")) {
        s.ops.tasks++;
      } else {
        // decision.* plus the review/approval family above.
        s.ops.decisions++;
      }
      continue;
    }
  }

  return [...byTurn.values()]
    .sort((a, b) => b.seqStart - a.seqStart)
    .slice(0, limit);
}
