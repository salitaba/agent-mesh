import type { ActivationReason } from "../../protocol/src/index";

/**
 * Wall-clock marks for the distinct phases of one turn, in epoch ms.
 *
 * A turn's `durationMs` alone cannot answer "where did the time go" — a 40s
 * turn is a very different problem when it is 38s of model latency versus 38s
 * of op execution. These marks make the flight recorder in the dashboard
 * possible without any extra round trips: every field is set at exactly one
 * site in `runTurn`, and any field may be absent (the turn died before it).
 */
export interface TurnPhases {
  /** Turn minted, before context assembly. */
  startedAt: number;
  /** Context bundle rendered, instructions ready — end of prep. */
  contextAt?: number;
  /** Runtime invoked; the clock that matters for TTFT starts here. */
  llmCallAt?: number;
  /** First streamed token observed — time to first token. */
  firstTokenAt?: number;
  /** Most recent streamed token — the stall detector reads this. */
  lastTokenAt?: number;
  /** Runtime returned a complete output. */
  llmDoneAt?: number;
  /** First op dispatched to the kernel. */
  opsStartAt?: number;
  /** Op loop finished (or was halted mid-flight). */
  opsDoneAt?: number;
  /** Turn record closed. */
  endedAt?: number;
}

export type TurnPhaseName = Exclude<keyof TurnPhases, "startedAt">;

/** Max stack frames kept per turn — enough to locate, small enough to ship. */
export const MAX_ERROR_FRAMES = 12;
export const MAX_ERROR_CHARS = 2000;
/** Cap on recorded op timings: a runaway turn must not grow memory. */
export const MAX_OP_TIMINGS = 60;

export interface OpTiming {
  /** Op name as written by the agent. */
  op: string;
  /** Wall time this single op spent inside the kernel, ms. */
  ms: number;
  /** Whether the kernel accepted it. */
  ok: boolean;
  /** Rejection reason, when it was refused. */
  reason?: string;
}

export interface TurnError {
  /** Constructor name: RuntimeFailure, BackendUnreachableError, TypeError… */
  kind: string;
  message: string;
  /** Trimmed stack frames, innermost first. Absent when the throw had none. */
  frames?: string[];
  /** `cause` chain, flattened outward — where a wrapped error really began. */
  causes?: Array<{ kind: string; message: string }>;
  /** Which phase the turn died in, when known. */
  phase?: TurnPhaseName | "prep";
}

/**
 * Normalize anything throwable into a bounded, serializable shape.
 *
 * Deliberately defensive: this runs on the failure path, where the thrown
 * value may be a string, a frozen object, or an error whose getters throw.
 * It must never throw itself or the original failure is lost.
 */
export function describeError(err: unknown, phase?: TurnError["phase"]): TurnError {
  try {
    if (!(err instanceof Error)) {
      return { kind: typeof err, message: String(err).slice(0, MAX_ERROR_CHARS), phase };
    }
    const frames = typeof err.stack === "string"
      ? err.stack
          .split("\n")
          .slice(1)
          .map((l) => l.trim())
          .filter((l) => l.startsWith("at "))
          .slice(0, MAX_ERROR_FRAMES)
      : undefined;
    const causes: Array<{ kind: string; message: string }> = [];
    let cur: unknown = (err as { cause?: unknown }).cause;
    // Bounded walk: a self-referential cause chain must not hang the process.
    for (let i = 0; i < 4 && cur; i++) {
      const c = cur as Error;
      causes.push({
        kind: c?.constructor?.name ?? typeof cur,
        message: String((c as Error)?.message ?? cur).slice(0, 300),
      });
      cur = (cur as { cause?: unknown })?.cause;
    }
    return {
      kind: err.constructor?.name ?? "Error",
      message: String(err.message ?? "").slice(0, MAX_ERROR_CHARS),
      ...(frames && frames.length ? { frames } : {}),
      ...(causes.length ? { causes } : {}),
      phase,
    };
  } catch {
    return { kind: "Error", message: "unprintable error", phase };
  }
}

export interface TurnRecord {
  turnId: string;
  agentId: string;
  reason: ActivationReason;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status: "running" | "ok" | "waiting" | "blocked" | "failed";
  tokens?: number;
  tokensInput?: number;
  tokensOutput?: number;
  model?: string;
  ops?: string[];
  toolCalls?: number;
  toolCallsDetail?: Array<{ name: string; args: unknown; resultDigest: string }>;
  summary?: string;
  /** Full LLM output text (the token stream). Truncated server-side. */
  text?: string;
  /** What the agent was asked to do — visible while still THINKING. Truncated. */
  instructions?: string;
  error?: string;
  /**
   * Structured failure detail. A bare `error` string tells you a turn broke
   * but not where, so every crash meant re-running the mission with debug
   * env vars set. Truncated and frame-limited: this is a trace to orient
   * from, not a full core dump.
   */
  errorDetail?: TurnError;
  /** Phase wall-clock marks — see TurnPhases. */
  phases?: TurnPhases;
  /**
   * Per-op execution timing, in execution order. The ops leg is a single bar
   * on the phase rail; when that bar is the slow one this says which op made
   * it slow, which "ops: 4.2s" cannot.
   */
  opTimings?: OpTiming[];
  /** 1 for a first try; >1 when the scheduler re-activated after a timeout. */
  attempt?: number;
  /** Characters streamed so far — throughput without re-measuring `text`. */
  streamChars?: number;
  /** Number of `onToken` deltas seen — distinguishes chunky from smooth. */
  streamFrames?: number;
}

export const RECENT_TURNS_MAX = 200;
/** Debounce between durable ring snapshots: mutations arrive on the token path. */
export const TURN_PERSIST_DEBOUNCE_MS = 1200;
export const MAX_DELIVERED_PER_TURN = 100;
/** Live token buffer cap per turn: polling fallback stays cheap. */
export const MAX_LIVE_TEXT_CHARS = 20000;

/**
 * Durable sidecar for the in-memory ring (a JSONL file in practice).
 *
 * The ring is the ONLY home of per-turn rich data (`phases`, `opTimings`,
 * `text`, `errorDetail`, …) — the event log reconstructs turn shape but never
 * these fields, so a restart wiped every trace of what a turn actually did.
 * Persistence restores the ring at construction; the tracker re-snapshots
 * debounced after every mutation and on explicit `flush()`.
 */
export interface TurnTrackerPersist {
  /** Prior records to restore at construction. Must not throw. */
  load(): TurnRecord[];
  /** Full-ring snapshot, called debounced after mutations and on flush(). */
  save(records: TurnRecord[]): void;
}

/**
 * TurnTracker owns the bounded in-memory ring of recent turns.
 * Extracted from Supervisor so turn observability has a single owner
 * with an enforced cap (no unbounded growth).
 */
export class TurnTracker {
  private recent: TurnRecord[] = [];
  private persistTimer?: NodeJS.Timeout;

  constructor(private readonly persist?: TurnTrackerPersist) {
    if (!persist) return;
    // Restore newest-first: `push` caps the ring, so the most recent
    // `RECENT_TURNS_MAX` records survive and stale ones fall off.
    for (const rec of this.loadPrior()) this.push(rec);
  }

  private loadPrior(): TurnRecord[] {
    try {
      return (this.persist?.load() ?? [])
        .filter((r) => r && typeof r.turnId === "string" && typeof r.agentId === "string")
        .sort((a, b) => (Date.parse(b.startedAt) || 0) - (Date.parse(a.startedAt) || 0));
    } catch {
      return [];
    }
  }

  push(rec: TurnRecord): void {
    const i = this.recent.findIndex((t) => t.turnId === rec.turnId);
    if (i >= 0) {
      // Phase marks accumulate: a later push that omits `phases` (the common
      // case — most pushes only carry status/text) must never erase the marks
      // recorded so far, or the flight recorder loses its earlier legs.
      const phases = rec.phases ? { ...this.recent[i].phases, ...rec.phases } : this.recent[i].phases;
      this.recent[i] = { ...this.recent[i], ...rec, ...(phases ? { phases } : {}) };
    } else {
      this.recent.unshift(rec);
      if (this.recent.length > RECENT_TURNS_MAX) this.recent.length = RECENT_TURNS_MAX;
    }
    this.schedulePersist();
  }

  /** Record one executed op's latency on a running turn. Bounded. */
  noteOp(turnId: string, t: OpTiming): void {
    const cur = this.recent.find((x) => x.turnId === turnId);
    if (!cur) return;
    if (!cur.opTimings) cur.opTimings = [];
    if (cur.opTimings.length >= MAX_OP_TIMINGS) return;
    cur.opTimings.push(t);
    this.schedulePersist();
  }

  /**
   * Stamp one phase mark on a running turn. Idempotent for the "first"
   * marks (firstTokenAt is never overwritten) so a re-entrant token callback
   * cannot move the TTFT baseline. No-op for unknown turns.
   */
  mark(turnId: string, phase: TurnPhaseName, at = Date.now()): void {
    const cur = this.recent.find((t) => t.turnId === turnId);
    if (!cur) return;
    if (!cur.phases) cur.phases = { startedAt: Date.parse(cur.startedAt) || at };
    if (phase === "firstTokenAt" && cur.phases.firstTokenAt !== undefined) return;
    if (phase === "opsStartAt" && cur.phases.opsStartAt !== undefined) return;
    cur.phases[phase] = at;
    this.schedulePersist();
  }

  finish(turnId: string, agentId: string, patch: Partial<TurnRecord>, nowIso: string): void {
    const cur = this.recent.find((t) => t.turnId === turnId);
    const endedAt = patch.endedAt ?? nowIso;
    const startedAt = cur?.startedAt ?? endedAt;
    let durationMs = patch.durationMs;
    if (durationMs === undefined) {
      try {
        durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
      } catch {
        durationMs = 0;
      }
    }
    const base: TurnRecord = cur ?? {
      turnId,
      agentId,
      reason: { kind: "recovery", note: "reconstructed after eviction" },
      startedAt,
      status: "running",
    };
    this.push({ ...base, ...patch, endedAt, durationMs });
    this.mark(turnId, "endedAt", Date.parse(endedAt) || Date.now());
  }

  /**
   * Append a live token delta to a running turn's text buffer (streaming
   * fallback for polling clients). Capped — drops the oldest overflow so a
   * runaway stream can't grow memory. No-op for unknown/finished turns.
   */
  appendText(turnId: string, delta: string): void {
    if (!delta) return;
    const cur = this.recent.find((t) => t.turnId === turnId);
    if (!cur || cur.status !== "running") return;
    const next = (cur.text ?? "") + delta;
    cur.text = next.length > MAX_LIVE_TEXT_CHARS ? next.slice(next.length - MAX_LIVE_TEXT_CHARS) : next;
    // Counters are uncapped on purpose: `text` is a trailing window, so its
    // length under-reports a long stream. Throughput and stall detection need
    // the true totals.
    cur.streamChars = (cur.streamChars ?? 0) + delta.length;
    cur.streamFrames = (cur.streamFrames ?? 0) + 1;
    const at = Date.now();
    if (!cur.phases) cur.phases = { startedAt: Date.parse(cur.startedAt) || at };
    if (cur.phases.firstTokenAt === undefined) cur.phases.firstTokenAt = at;
    cur.phases.lastTokenAt = at;
    this.schedulePersist();
  }

  list(limit = 60): TurnRecord[] {
    return this.recent.slice(0, limit);
  }
  get(turnId: string): TurnRecord | undefined {
    return this.recent.find((t) => t.turnId === turnId);
  }

  /** Debounced persistence: mutations arrive on the token path (per delta). */
  private schedulePersist(): void {
    if (!this.persist || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.flush();
    }, TURN_PERSIST_DEBOUNCE_MS);
  }

  /** Force an immediate durable snapshot (turn end / shutdown). Best-effort. */
  flush(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    if (!this.persist) return;
    try {
      this.persist.save(this.recent.slice());
    } catch {
      /* persistence must never break a turn */
    }
  }

  /** Wipe the ring (fresh mission); the next debounced snapshot lands empty. */
  clear(): void {
    this.recent.length = 0;
    this.schedulePersist();
  }
}
