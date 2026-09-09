/* ---------------------------------------------------------------------- *
 * Turn vitals: the derived layer between raw turn records and the views.
 *
 * The dashboard used to show one number for a running turn ("streaming ·
 * 4.2k chars"), which cannot distinguish a healthy stream from a model that
 * stopped talking 40 seconds ago. Everything here answers a question an
 * operator actually asks mid-incident:
 *
 *   - is it alive?            -> health / stall detection
 *   - where did the time go?  -> phase legs
 *   - is this turn normal?    -> baselines against its peers
 *
 * Pure functions over data already on the wire; no extra requests.
 * ---------------------------------------------------------------------- */

import type { TurnStep } from "./store";

export interface TurnPhases {
  startedAt: number;
  contextAt?: number;
  llmCallAt?: number;
  firstTokenAt?: number;
  lastTokenAt?: number;
  llmDoneAt?: number;
  opsStartAt?: number;
  opsDoneAt?: number;
  endedAt?: number;
}

export interface TurnError {
  kind: string;
  message: string;
  frames?: string[];
  causes?: Array<{ kind: string; message: string }>;
  phase?: string;
}

export interface OpTiming {
  op: string;
  ms: number;
  ok: boolean;
  reason?: string;
}

/** Plain-English name for the leg a turn died in. */
export const PHASE_PLAIN: Record<string, string> = {
  prep: "while gathering its context",
  contextAt: "while gathering its context",
  llmCallAt: "while waiting on the model",
  firstTokenAt: "while waiting on the model",
  opsStartAt: "while applying its changes",
  opsDoneAt: "after applying its changes",
};

/* ------------------------------- health ------------------------------- */

export type Health = "warming" | "streaming" | "slow" | "stalled" | "done";

/** Seconds of silence before a live turn stops looking healthy. */
export const STALL_WARN_MS = 8000;
export const STALL_BAD_MS = 30000;
/** A turn that never produced a token this long is suspicious on its own. */
export const TTFT_WARN_MS = 12000;

export interface VitalsInput {
  phases?: TurnPhases;
  /** Client-side stream buffer facts (SSE), used when phases are absent. */
  clientChars?: number;
  clientUpdatedAt?: number;
  running: boolean;
  startedAt?: string;
  now?: number;
}

export interface Vitals {
  health: Health;
  /** Time to first token, ms. Undefined until the first token lands. */
  ttftMs?: number;
  /** Milliseconds since the last token. Undefined if nothing streamed yet. */
  silentMs?: number;
  /** Characters per second over the streaming window. */
  charsPerSec?: number;
  chars: number;
  /** Human sentence describing the current state — used as the live headline. */
  label: string;
  /** Why the health is what it is; shown as a tooltip / subline. */
  detail: string;
}

/**
 * Derive live health from whichever timing source is available. Server phase
 * marks are authoritative; the client's own SSE buffer is the fallback so the
 * strip still works against a server that predates phase instrumentation.
 */
export function vitalsOf(inp: VitalsInput): Vitals {
  const now = inp.now ?? Date.now();
  const p = inp.phases;
  const chars = inp.clientChars ?? 0;
  const llmCallAt = p?.llmCallAt ?? p?.contextAt ?? p?.startedAt;
  const firstTokenAt = p?.firstTokenAt;
  const lastTokenAt = p?.lastTokenAt ?? inp.clientUpdatedAt;

  if (!inp.running) {
    const ttft = firstTokenAt && llmCallAt ? Math.max(0, firstTokenAt - llmCallAt) : undefined;
    return { health: "done", ttftMs: ttft, chars, label: "finished", detail: "turn is over" };
  }

  const ttftMs = firstTokenAt && llmCallAt ? Math.max(0, firstTokenAt - llmCallAt) : undefined;
  const silentMs = lastTokenAt ? Math.max(0, now - lastTokenAt) : undefined;
  const streamWindow = firstTokenAt && lastTokenAt ? Math.max(1, lastTokenAt - firstTokenAt) : undefined;
  const charsPerSec = streamWindow && chars ? (chars / streamWindow) * 1000 : undefined;

  // Nothing streamed yet: the model is still thinking. How long it has been
  // thinking is the only signal available, so grade on that.
  if (firstTokenAt === undefined) {
    const waitedMs = llmCallAt ? Math.max(0, now - llmCallAt) : inp.startedAt ? Math.max(0, now - Date.parse(inp.startedAt)) : 0;
    if (waitedMs > STALL_BAD_MS) {
      return {
        health: "stalled",
        silentMs: waitedMs,
        chars: 0,
        label: "no response",
        detail: `the model has not sent a single token in ${Math.round(waitedMs / 1000)}s — it may be hung or the backend may be unreachable`,
      };
    }
    if (waitedMs > TTFT_WARN_MS) {
      return {
        health: "slow",
        silentMs: waitedMs,
        chars: 0,
        label: "thinking",
        detail: `${Math.round(waitedMs / 1000)}s with no output yet — long for a first token`,
      };
    }
    return { health: "warming", silentMs: waitedMs, chars: 0, label: "thinking", detail: "waiting for the first token" };
  }

  const base = { ttftMs, silentMs, charsPerSec, chars };
  if (silentMs !== undefined && silentMs > STALL_BAD_MS) {
    return { ...base, health: "stalled", label: "stalled", detail: `silent for ${Math.round(silentMs / 1000)}s after streaming ${chars} characters — the turn is probably wedged` };
  }
  if (silentMs !== undefined && silentMs > STALL_WARN_MS) {
    return { ...base, health: "slow", label: "paused", detail: `no new tokens for ${Math.round(silentMs / 1000)}s — may be running a tool or thinking mid-answer` };
  }
  return { ...base, health: "streaming", label: "streaming", detail: charsPerSec ? `${Math.round(charsPerSec)} chars/sec` : "receiving tokens" };
}

/* -------------------------------- legs -------------------------------- */

export interface PhaseLeg {
  key: string;
  label: string;
  ms: number;
  /** True while this leg is still accruing. */
  open: boolean;
  hint: string;
}

/**
 * Split a turn into its consecutive legs. Only legs with both ends known are
 * emitted, so a partially instrumented turn degrades to fewer bars rather
 * than lying about zero-length phases.
 */
export function phaseLegs(p: TurnPhases | undefined, running: boolean, now = Date.now()): PhaseLeg[] {
  if (!p) return [];
  const legs: PhaseLeg[] = [];
  const add = (key: string, label: string, from: number | undefined, to: number | undefined, hint: string): void => {
    if (from === undefined) return;
    const end = to ?? (running ? now : undefined);
    if (end === undefined) return;
    const ms = Math.max(0, end - from);
    legs.push({ key, label, ms, open: to === undefined, hint });
  };
  add("prep", "gathering context", p.startedAt, p.contextAt ?? p.llmCallAt, "reading its inbox and building the prompt");
  add("wait", "waiting on model", p.llmCallAt ?? p.contextAt, p.firstTokenAt ?? p.llmDoneAt, "prompt sent, no tokens back yet");
  add("stream", "writing answer", p.firstTokenAt, p.llmDoneAt ?? p.lastTokenAt, "streaming its reply");
  add("ops", "applying changes", p.opsStartAt ?? p.llmDoneAt, p.opsDoneAt ?? p.endedAt, "sending messages, publishing files, moving tasks");
  return legs.filter((l) => l.ms > 0 || l.open);
}

/** Biggest leg — the honest one-line answer to "why was this slow". */
export function slowestLeg(legs: PhaseLeg[]): PhaseLeg | null {
  if (!legs.length) return null;
  return legs.reduce((a, b) => (b.ms > a.ms ? b : a));
}

/* ----------------------------- baselines ------------------------------ */

export interface Baseline {
  medianDurationMs: number;
  medianTokens: number;
  n: number;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/**
 * Median duration/tokens across finished turns. Optionally scoped to one
 * agent — a researcher's 40s turn is normal, a router's is not, so a global
 * median would mislabel both.
 */
export function baselineOf(steps: TurnStep[], agentId?: string): Baseline {
  const pool = steps.filter(
    (s) => s.status !== "running" && (!agentId || s.agentId === agentId) && typeof s.durationMs === "number",
  );
  return {
    medianDurationMs: median(pool.map((s) => s.durationMs as number)),
    medianTokens: median(pool.filter((s) => s.tokens > 0).map((s) => s.tokens)),
    n: pool.length,
  };
}

export type Deviation = "normal" | "high" | "low";

/** How far a value sits from its baseline. Needs ≥4 samples to claim anything. */
export function deviation(value: number, base: number, n: number): Deviation {
  if (!base || n < 4) return "normal";
  const ratio = value / base;
  if (ratio >= 2) return "high";
  if (ratio <= 0.4) return "low";
  return "normal";
}

/* ---------------------------- streaming ops --------------------------- */

export interface PartialOps {
  /** Ops fully parsed out of the partial stream so far. */
  ops: any[];
  /** True when the model has opened an ops block but not closed it. */
  writing: boolean;
  /** Prose that came before the ops block — the model's own reasoning. */
  prose: string;
}

/**
 * Parse a *partial* stream into the ops the agent has committed to so far.
 *
 * The finished-turn parser needs a complete fenced block; while streaming
 * there is no closing fence, so this scans the buffer for balanced top-level
 * objects and returns however many are complete. That turns the live view
 * from "watch text scroll" into "watch the plan appear", which is the thing
 * an operator is actually waiting for.
 */
export function parsePartialOps(text: string): PartialOps {
  if (!text) return { ops: [], writing: false, prose: "" };
  const fence = /```(?:mesh-json|json|mesh-op)?\s*\n?/.exec(text);
  let body: string;
  let prose: string;
  if (fence) {
    prose = text.slice(0, fence.index).trim();
    body = text.slice(fence.index + fence[0].length);
    const close = body.indexOf("```");
    if (close >= 0) body = body.slice(0, close);
  } else {
    const t = text.trimStart();
    if (!t.startsWith("[") && !t.startsWith("{")) return { ops: [], writing: false, prose: text.trim() };
    prose = "";
    body = t;
  }
  const ops = scanObjects(body);
  return { ops, writing: ops.length > 0 || /[[{]/.test(body), prose };
}

/**
 * Pull every complete top-level `{...}` out of a possibly-truncated buffer.
 * String-aware so a brace inside a message body cannot end an object early.
 */
function scanObjects(body: string): any[] {
  const out: any[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let escaped = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === "{") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (c === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          const parsed = JSON.parse(body.slice(start, i + 1));
          if (parsed && typeof parsed === "object" && "op" in parsed) out.push(parsed);
        } catch {
          /* half-written object — ignore until it completes */
        }
        start = -1;
      }
      if (depth < 0) depth = 0;
    }
  }
  return out;
}
