import type { MeshEvent } from "../../protocol/src/index";

export type TurnStatus = "running" | "ok" | "waiting" | "blocked" | "failed";

/** What a turn did, counted off its own events in the log. */
export interface TurnOps {
  messages: number;
  artifacts: number;
  tasks: number;
  decisions: number;
}

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
  /**
   * Absent means no log-derived step was found for this turn, so nothing was
   * counted. That is not the same claim as four zeros. The server used to fill
   * the gap with `{0,0,0,0}` for any tracker turn older than the log window it
   * had scanned, and the dashboard read that as "the kernel refused the
   * attempted actions" for a turn that had published artifacts. One live turn
   * read 8/8/0/8 at `?limit=200` and 0/0/0/0 at `?limit=60`: the answer
   * depended on how far back the query happened to look.
   */
  ops?: TurnOps;
  messageIds: string[];
  artifactIds: string[];
  tokens: number;
  /**
   * The split behind `tokens`, when the log carries it: `budget.consumed` puts
   * the runtime's own `input`/`output`/`cacheRead` in its payload, so a replayed
   * turn can be read the way `ordane ledger` reads the audit file. Absent means the
   * backend reported no split — never a zero that was never claimed.
   */
  tokensInput?: number;
  tokensOutput?: number;
  tokensCacheRead?: number;
  /**
   * The thinking part of `tokensOutput`, when the backend reported it. Absent
   * is unmeasured: most gateways omit the detail, and a 0 here would claim a
   * turn deliberated for free.
   */
  tokensThinking?: number;
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
    /** First sign of life of any kind — a token or a tool frame. */
    firstActivityAt?: number;
    /** Most recent sign of life of any kind. Superset of `lastTokenAt`. */
    lastActivityAt?: number;
    llmDoneAt?: number;
    opsStartAt?: number;
    opsDoneAt?: number;
    endedAt?: number;
    /**
     * Future stamps, not phase marks: when the turn will be stopped as things
     * stand, and the hard stop no extension passes. Anything that walks these
     * marks as a sequence of legs must skip both. Mirrored at top level below.
     */
    deadlineAt?: number;
    ceilingAt?: number;
  };
  attempt?: number;
  streamChars?: number;
  /**
   * Tool frames seen — the only throughput a file-writing turn produces.
   * FRAMES, not calls: a call's start and its result are both frames.
   */
  toolFrames?: number;
  /**
   * The live work of a turn still in the tracker's ring. All of it is
   * live-only — the log carries none — so every field is optional, and absent
   * means unknown rather than zero.
   *
   * Tool calls announced so far: calls, not frames (`toolFrames` is ~2x this).
   */
  toolCallCount?: number;
  /**
   * The one call a reader wants on a list row: the newest still running, else
   * the newest. The full list stays on `/turns/:id` — a /steps response is
   * polled every few seconds at limit 60 and must not carry 60 calls per row.
   */
  currentTool?: CurrentTool;
  /** When the turn will be stopped as things stand (epoch ms). Moves later when extended. */
  deadlineAt?: number;
  /** The hard stop no extension passes (epoch ms). */
  ceilingAt?: number;
  /** Billable tokens so far (cache reads excluded). Superseded by `tokens` once the turn ends. */
  liveTokens?: number;
  /** Distinct files the turn asked to write or edit. */
  filesTouchedCount?: number;
  /** Deadline warnings sent to the seat mid-turn. */
  advisoryCount?: number;
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

/** A tool call as a list row shows it — `LiveToolCall` minus its id and error. */
export interface CurrentTool {
  name: string;
  target?: string;
  status: "running" | "completed" | "failed";
  startedAt: number;
  endedAt?: number;
}

/**
 * The call to show for a turn: the newest one still running, else the newest.
 *
 * Structural rather than core's `LiveToolCall`, so this package does not grow
 * a dependency on core for one shape. The list is oldest first, as the tracker
 * keeps it; position decides "newest", not `startedAt`, so two calls stamped in
 * the same millisecond still resolve to the one announced last.
 */
export function currentToolOf(tools: ReadonlyArray<CurrentTool> | undefined): CurrentTool | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  let pick: CurrentTool | undefined;
  for (let i = tools.length - 1; i >= 0; i--) {
    if (tools[i]?.status === "running") {
      pick = tools[i];
      break;
    }
  }
  pick ??= tools[tools.length - 1];
  if (!pick) return undefined;
  return {
    name: pick.name,
    ...(pick.target ? { target: pick.target } : {}),
    status: pick.status,
    startedAt: pick.startedAt,
    ...(pick.endedAt !== undefined ? { endedAt: pick.endedAt } : {}),
  };
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
  // A step built here always has its counts: it was built from events, so
  // zero is a measurement. Only a step with no log behind it lacks `ops`.
  type CountedStep = TurnStep & { ops: TurnOps };
  const byTurn = new Map<string, CountedStep>();
  const runningByAgent = new Map<string, string>(); // agentId -> turnId
  const awakenedIdToTurn = new Map<string, string>(); // activation event id -> turnId

  const ensure = (turnId: string, agentId: string, at: string, seq: number): CountedStep => {
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
      let s: CountedStep | undefined;
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
          // The split rides on the same event: the kernel puts the runtime's own
          // input/output/cacheRead in the consume detail, which `budgets.consume`
          // spreads onto the payload. Add only what the payload actually states,
          // so a backend that reports nothing leaves these absent rather than 0.
          if (typeof p.input === "number") s.tokensInput = (s.tokensInput ?? 0) + p.input;
          if (typeof p.output === "number") s.tokensOutput = (s.tokensOutput ?? 0) + p.output;
          if (typeof p.cacheRead === "number") s.tokensCacheRead = (s.tokensCacheRead ?? 0) + p.cacheRead;
          if (typeof p.thinking === "number") s.tokensThinking = (s.tokensThinking ?? 0) + p.thinking;
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
      let s: CountedStep | undefined;
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
      } else if (!((e.type === "artifact.transition" || e.type === "architecture.approved") && p.derived === true)) {
        // decision.* plus the review/approval family above. A `derived`
        // transition is the supervisor mirroring a move the reducer already
        // made (a review request moving its artifact to UNDER_REVIEW); counting
        // it gave an architect who requested four reviews "8 decisions" and no
        // decision event to show for them. A derived `architecture.approved` is
        // the same kind of echo: it restates the `review.approved` it names.
        s.ops.decisions++;
      }
      continue;
    }
  }

  return [...byTurn.values()]
    .sort((a, b) => b.seqStart - a.seqStart)
    .slice(0, limit);
}
