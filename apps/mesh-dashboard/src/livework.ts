/* ---------------------------------------------------------------------- *
 * Live work: what a running turn is doing while it does it.
 *
 * A seat that spends seventeen minutes writing files through native tools
 * streams no prose, so every view used to read "thinking…", an elapsed timer
 * and "— tok" until the timeout killed it. The turn record now carries its
 * tool calls, the files it touched, its tokens so far and its deadline; this
 * module turns those into the lines a reader looks at.
 *
 * DOM-free, and free of React and the store (see vitals.ts for why), so every
 * rule here is covered by tests/dashboard/livework.test.ts.
 * ---------------------------------------------------------------------- */

import type { ToolLive } from "./streams";

/**
 * One tool call as the turn is making it. Mirrors `LiveToolCall` in
 * packages/core/src/turn-tracker.ts, which is the authority.
 */
export interface LiveToolCall {
  /** The runtime's `toolCallId` — the same id the SSE `turn.tool` frame carries. */
  id: string;
  name: string;
  /** The one argument a reader looks at: a path, a command line, a pattern. Clipped. */
  target?: string;
  status: "running" | "completed" | "failed";
  startedAt: number;
  endedAt?: number;
  error?: string;
}

/** A note put in front of the seat mid-turn (a deadline warning). */
export interface TurnAdvisory {
  at: number;
  text: string;
  /** False when the runtime could not queue it: the seat never saw it. */
  delivered: boolean;
}

/** The snapshot of a stopped seat's uncommitted worktree. */
export interface TurnCheckpoint {
  ref: string;
  commit: string;
  files: string[];
}

/** The call a `/steps` row carries: the newest running one, else the newest. */
export interface CurrentTool {
  name: string;
  target?: string;
  status: "running" | "completed" | "failed";
  startedAt: number;
  endedAt?: number;
}

/** What the tracker keeps; a merged list is cut to the same size. */
export const LIVE_TOOLS_MAX = 60;
/** Longest target this side derives itself (from an SSE frame's arguments). */
export const TARGET_MAX = 200;

const MCP_NAME = /^mcp__(.+?)__(.+)$/;

/** `mcp__mesh__mesh_publish` → `mesh_publish`. Same rule as stepdetail's. */
export function bareToolName(name: string): string {
  return MCP_NAME.exec(name)?.[2] ?? name;
}

const STATUSES = new Set(["running", "completed", "failed"]);

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * The live-work fields of a raw `/turns/:id` record, checked. The record is
 * `any` off the wire and a server that predates these fields sends none of
 * them; a malformed entry is dropped rather than rendered as "undefined".
 */
export interface LiveWork {
  toolCallCount?: number;
  liveTools: LiveToolCall[];
  filesTouched: string[];
  liveTokens?: number;
  advisories: TurnAdvisory[];
  checkpoint?: TurnCheckpoint;
}

export function liveWorkOf(t: unknown): LiveWork {
  const r = (t && typeof t === "object" ? t : {}) as Record<string, unknown>;
  const liveTools = Array.isArray(r.liveTools)
    ? r.liveTools.filter((x): x is LiveToolCall => {
        const c = x as Partial<LiveToolCall> | null;
        return Boolean(c) && typeof c!.id === "string" && typeof c!.name === "string"
          && STATUSES.has(String(c!.status)) && num(c!.startedAt) !== undefined;
      })
    : [];
  const filesTouched = Array.isArray(r.filesTouched) ? r.filesTouched.filter((f): f is string => typeof f === "string" && f.length > 0) : [];
  const advisories = Array.isArray(r.advisories)
    ? r.advisories.filter((x): x is TurnAdvisory => {
        const a = x as Partial<TurnAdvisory> | null;
        return Boolean(a) && num(a!.at) !== undefined && typeof a!.text === "string";
      }).map((a) => ({ at: a.at, text: a.text, delivered: a.delivered !== false }))
    : [];
  const cp = r.checkpoint as Partial<TurnCheckpoint> | undefined;
  const checkpoint = cp && typeof cp === "object" && typeof cp.ref === "string" && cp.ref
    ? { ref: cp.ref, commit: typeof cp.commit === "string" ? cp.commit : "", files: Array.isArray(cp.files) ? cp.files.filter((f): f is string => typeof f === "string") : [] }
    : undefined;
  return {
    toolCallCount: num(r.toolCallCount),
    liveTools,
    filesTouched,
    liveTokens: num(r.liveTokens),
    advisories,
    checkpoint,
  };
}

/**
 * The newest call still running, else the newest. Position decides "newest"
 * (the list is oldest first), so two calls stamped in the same millisecond
 * resolve to the one announced last. Mirrors the server's `currentToolOf`.
 */
export function currentToolOf(tools: readonly LiveToolCall[] | undefined): CurrentTool | undefined {
  if (!tools?.length) return undefined;
  let pick: LiveToolCall | undefined;
  for (let i = tools.length - 1; i >= 0; i--) {
    if (tools[i].status === "running") {
      pick = tools[i];
      break;
    }
  }
  pick ??= tools[tools.length - 1];
  return {
    name: pick.name,
    ...(pick.target ? { target: pick.target } : {}),
    status: pick.status,
    startedAt: pick.startedAt,
    ...(pick.endedAt !== undefined ? { endedAt: pick.endedAt } : {}),
  };
}

/* ------------------------------- time --------------------------------- */

/**
 * A coarse age for a live line: "4s", "3m 20s", "25m", "1h 5m". Whole seconds
 * only — "4.0s ago" re-rendered every second is noise, and a deadline minutes
 * away does not need its seconds once it is ten minutes out.
 */
export function ageText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return m < 10 && s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/** Local wall-clock "HH:MM" — what an operator compares with the clock on their screen. */
export function clockHM(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/* ------------------------------ now line ------------------------------ */

export interface NowParts {
  name: string;
  target?: string;
  /** "running 40s", "4s ago", "failed 4s ago". */
  when: string;
  running: boolean;
  failed: boolean;
}

/** A running call is aged from its start; a finished one from its end. */
function sinceOf(tool: CurrentTool): number {
  return tool.status === "running" ? tool.startedAt : tool.endedAt ?? tool.startedAt;
}

export function nowParts(tool: CurrentTool, now: number): NowParts {
  const running = tool.status === "running";
  const failed = tool.status === "failed";
  const age = ageText(now - sinceOf(tool));
  return {
    name: bareToolName(tool.name),
    ...(tool.target ? { target: tool.target } : {}),
    when: running ? `running ${age}` : failed ? `failed ${age} ago` : `${age} ago`,
    running,
    failed,
  };
}

/** "Edit · packages/core/src/domain/model.ts · 4s ago", "Bash · pnpm test · running 40s". */
export function nowLine(tool: CurrentTool, now: number): string {
  const p = nowParts(tool, now);
  return [p.name, p.target, p.when].filter(Boolean).join(" · ");
}

function firstLine(s: string): string {
  const i = s.indexOf("\n");
  return (i < 0 ? s : s.slice(0, i)).trim();
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s;
}

/**
 * A target cut to fit a list row. A path keeps its last segment — the file
 * name is what a reader recognises, and the directory is in the drawer — and
 * anything else (a command line, a pattern) keeps its head.
 */
export function shortTarget(target: string | undefined, max = 40): string {
  if (!target) return "";
  const t = firstLine(target);
  if (/^\S+$/.test(t) && /[\\/]/.test(t) && !/^[a-z]+:\/\//i.test(t)) {
    const base = t.split(/[\\/]/).filter(Boolean).pop() ?? t;
    return clip(base, max);
  }
  return clip(t, max);
}

/** The Steps list's verb for a live row: "Edit model.ts · 4s", "Bash pnpm test · running 40s". */
export function compactNow(tool: CurrentTool, now: number): string {
  const name = bareToolName(tool.name);
  const target = shortTarget(tool.target);
  const age = ageText(now - sinceOf(tool));
  const head = target ? `${name} ${target}` : name;
  if (tool.status === "running") return `${head} · running ${age}`;
  return tool.status === "failed" ? `${head} · ${age} · failed` : `${head} · ${age}`;
}

/* ------------------------------ deadline ------------------------------ */

export interface DeadlineInput {
  startedAt?: number;
  llmCallAt?: number;
  deadlineAt?: number;
  ceilingAt?: number;
}

export interface DeadlineView {
  /** Since the runtime was called (the deadline's own origin). */
  elapsedMs: number;
  /** Until `deadlineAt`; negative once past it. */
  leftMs: number;
  /** Until `ceilingAt`, when the record has one. */
  hardLeftMs?: number;
  /** Positions on a track running from the runtime call to the later stop, 0–100. */
  elapsedPct: number;
  deadlinePct: number;
  ceilingPct?: number;
  /** The deadline IS the hard stop (a task holder's turn, or one extended to it). */
  atCeiling: boolean;
  /** The deadline has moved later than the first value seen for this turn. */
  extended: boolean;
  overdue: boolean;
  tone: "ok" | "warn" | "bad";
}

/** Movement smaller than this is clock noise, not an extension. */
export const EXTEND_SLACK_MS = 1000;

/**
 * Where a running turn stands against its deadline, or null when the record
 * has none (a server that predates it, or a turn whose runtime is not called
 * yet — the deadline is set at the call).
 *
 * `initialDeadlineAt` is the first `deadlineAt` this page saw for the turn.
 * The record carries only the current value, so "extended" is only claimed for
 * a move this page watched happen; a page opened after the extension cannot
 * tell and says nothing, rather than guess at the base timeout.
 */
export function deadlineOf(p: DeadlineInput | undefined, now: number, initialDeadlineAt?: number): DeadlineView | null {
  const deadlineAt = num(p?.deadlineAt);
  if (deadlineAt === undefined) return null;
  const origin = num(p?.llmCallAt) ?? num(p?.startedAt);
  if (origin === undefined) return null;
  const ceilingAt = num(p?.ceilingAt);
  const end = Math.max(deadlineAt, ceilingAt ?? deadlineAt);
  const span = Math.max(1, end - origin);
  const pct = (at: number): number => Math.min(100, Math.max(0, ((at - origin) / span) * 100));
  const leftMs = deadlineAt - now;
  const hardLeftMs = ceilingAt !== undefined ? ceilingAt - now : undefined;
  const atCeiling = ceilingAt !== undefined && Math.abs(ceilingAt - deadlineAt) < EXTEND_SLACK_MS;
  const overdue = leftMs < 0;
  // The soft deadline renews while the seat keeps producing, so its own
  // countdown is a "may stop"; only the hard stop is a "will stop". Red is for
  // the second, or for a deadline already passed.
  const hard = hardLeftMs ?? leftMs;
  const tone = overdue || hard < 60_000 ? "bad" : leftMs < 60_000 || hard < 5 * 60_000 ? "warn" : "ok";
  return {
    elapsedMs: Math.max(0, now - origin),
    leftMs,
    ...(hardLeftMs !== undefined ? { hardLeftMs } : {}),
    elapsedPct: pct(now),
    deadlinePct: pct(deadlineAt),
    ...(ceilingAt !== undefined ? { ceilingPct: pct(ceilingAt) } : {}),
    atCeiling,
    extended: initialDeadlineAt !== undefined && deadlineAt - initialDeadlineAt > EXTEND_SLACK_MS,
    overdue,
    tone,
  };
}

/** "stops in 3m 20s", "hard stop in 45m", "past its deadline by 12s". */
export function deadlineText(d: DeadlineView): string {
  if (d.overdue) return `past its deadline by ${ageText(-d.leftMs)}`;
  return d.atCeiling ? `hard stop in ${ageText(d.leftMs)}` : `stops in ${ageText(d.leftMs)}`;
}

/** "hard stop in 12 min" beside a soft deadline; null when there is no separate one. */
export function hardStopText(d: DeadlineView): string | null {
  if (d.hardLeftMs === undefined || d.atCeiling) return null;
  if (d.hardLeftMs <= 0) return "past the hard stop";
  if (d.hardLeftMs < 60_000) return `hard stop in ${Math.ceil(d.hardLeftMs / 1000)}s`;
  return `hard stop in ${Math.ceil(d.hardLeftMs / 60_000)} min`;
}

/** Short form for a list row: "4m left", "overdue". */
export function timeLeftText(deadlineAt: number | undefined, now: number): string | null {
  if (typeof deadlineAt !== "number" || !Number.isFinite(deadlineAt)) return null;
  const left = deadlineAt - now;
  return left < 0 ? "overdue" : `${ageText(left)} left`;
}

/**
 * Remembers the first `deadlineAt` seen per turn, which is what "extended" is
 * measured against. Bounded, oldest out. A factory so tests get a fresh one;
 * the views share `firstDeadline`.
 */
export function deadlineMemo(max = 200): (turnId: string, deadlineAt: number | undefined) => number | undefined {
  const seen = new Map<string, number>();
  return (turnId, deadlineAt) => {
    const had = seen.get(turnId);
    if (had !== undefined) return had;
    if (typeof deadlineAt !== "number" || !Number.isFinite(deadlineAt)) return undefined;
    seen.set(turnId, deadlineAt);
    if (seen.size > max) {
      const oldest = seen.keys().next().value;
      if (oldest !== undefined) seen.delete(oldest);
    }
    return deadlineAt;
  };
}

export const firstDeadline = deadlineMemo();

/* ----------------------------- advisories ----------------------------- */

/**
 * "Warned at 20:03: <text>". The time is local and the zone is said once above the list, not on each line. Delivery is marked by
 * the view, not the line. (A stopwatch pictogram used to open it; the words say it.)
 */
export function advisoryLine(a: TurnAdvisory): string {
  return `Warned at ${clockHM(a.at)}: ${a.text}`;
}

/* ------------------------------- tokens ------------------------------- */

/**
 * The header's token figure. A finished turn's `tokens` wins; a running one
 * shows what the runtime has reported so far, and "— tok" only when neither
 * exists — `liveTokens` absent is unknown, not zero.
 */
export function tokenText(tokens: number | undefined | null, liveTokens: number | undefined, fmt: (n: number) => string): string {
  if (typeof tokens === "number") return `${fmt(tokens)} tok`;
  if (typeof liveTokens === "number") return `${fmt(liveTokens)} tok so far`;
  return "— tok";
}

/* --------------------------- SSE freshness ---------------------------- */

const TARGET_KEYS = [
  "file_path", "notebook_path", "filePath", "path",
  "command", "cmd",
  "pattern", "url", "query",
  "name", "title", "description",
];

/**
 * The target of a call seen on the SSE stream, from its arguments — the same
 * pick the server makes for `LiveToolCall.target`, approximately: an SSE-only
 * row is replaced by the polled one within a poll.
 */
export function toolTarget(args: unknown, max = TARGET_MAX): string | undefined {
  let a = args;
  if (typeof a === "string") {
    try {
      a = JSON.parse(a);
    } catch {
      const line = firstLine(a as string);
      return line ? clip(line, max) : undefined;
    }
  }
  if (!a || typeof a !== "object") return undefined;
  const rec = a as Record<string, unknown>;
  for (const k of TARGET_KEYS) {
    const v = rec[k];
    if (typeof v === "string" && v.trim()) return clip(firstLine(v), max);
  }
  return undefined;
}

/**
 * The polled `liveTools` with what the SSE stream saw since, correlated by the
 * runtime's tool-call id. The polled record stays the authority — it survives
 * a reload and an SSE gap — and the stream only adds what a 1.5s poll cannot
 * have yet:
 *
 * - a call the poll caught running that the stream has since seen finish, and
 * - calls announced after the newest one the poll knows about.
 *
 * A stream call the poll lacks that sits BEFORE the newest shared one is left
 * out: the poll dropped it off its capped window, and putting it back would
 * re-order the list. With no shared call at all, every stream call is newer
 * than the snapshot (the store listened the whole time the poll was taken).
 */
export function mergeLiveTools(polled: readonly LiveToolCall[] | undefined, sse: readonly ToolLive[] | undefined): LiveToolCall[] {
  const base = polled ? [...polled] : [];
  if (!sse?.length) return base;
  const live = new Map(sse.map((s) => [s.toolCallId, s]));
  const merged = base.map((p) => {
    const s = live.get(p.id);
    if (!s || p.status !== "running" || s.status === "running") return p;
    return {
      ...p,
      status: s.status,
      endedAt: s.updatedAt,
      ...(s.status === "failed" && s.error ? { error: s.error } : {}),
    };
  });
  const known = new Set(base.map((p) => p.id));
  let lastShared = -1;
  sse.forEach((s, i) => {
    if (known.has(s.toolCallId)) lastShared = i;
  });
  const fresh = sse.slice(lastShared + 1).filter((s) => !known.has(s.toolCallId)).map((s): LiveToolCall => ({
    id: s.toolCallId,
    name: s.name,
    ...(s.target ? { target: s.target } : {}),
    status: s.status,
    startedAt: s.startedAt,
    ...(s.status !== "running" ? { endedAt: s.updatedAt } : {}),
    ...(s.status === "failed" && s.error ? { error: s.error } : {}),
  }));
  const out = [...merged, ...fresh];
  return out.length > LIVE_TOOLS_MAX ? out.slice(out.length - LIVE_TOOLS_MAX) : out;
}
