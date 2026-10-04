/**
 * What the Steps page decides, as a model: which turns the filters leave, how quiet runs fold, where a turn sits on the
 * swimlane, what the axis is labelled, and what the strip says is running.
 *
 * It lived inside `views/Steps.tsx`, where nothing could test it. The parts that carry a claim are here: the legend counts are
 * the filter's counts, a fold never hides a turn that did something, a lane's busy share divides by the window it is drawn in,
 * and "nothing is running" is not allowed to say "parked on its mailbox" about a mission that was delivered.
 */
import { opsSummary, outcomeOf, plainReason, producedCount, refusedOps, spanLabel, type Outcome, type OutcomeInput } from "./format";
import { bucketOf, type Bucket } from "./feed";

/** What this model reads of a turn. Structural, so the store's `TurnStep` fits without this file importing a .tsx. */
export interface StepLike extends OutcomeInput {
  turnId: string;
  agentId: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  tokens: number;
  reasonKind: string;
  reasonNote?: string;
  /** Position in the event log when the turn began: only ever grows, which is what a hold marks. */
  seqStart: number;
}

/* ------------------------------ the legend ------------------------------ */

/** The order the legend reads in: what is happening, what landed, what did not. */
export const OUTCOME_ORDER: readonly Outcome[] = ["live", "shipped", "quiet", "rejected", "blocked", "crashed"];

export interface FilterDef { id: "" | Outcome; label: string }

export const FILTERS: readonly FilterDef[] = [
  { id: "", label: "Everything" },
  { id: "live", label: "Working now" },
  { id: "shipped", label: "Produced" },
  { id: "quiet", label: "No output" },
  { id: "rejected", label: "Refused" },
  { id: "blocked", label: "Blocked" },
  { id: "crashed", label: "Crashed" },
];

/** Turns per outcome. These are the legend's numbers, and they are exactly what each chip's filter then shows. */
export function outcomeCounts(steps: readonly StepLike[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const s of steps) c[outcomeOf(s)] = (c[outcomeOf(s)] ?? 0) + 1;
  return c;
}

/** The search box matches who, why it woke and its note: what a person remembers about a turn. */
export function searchText(s: Pick<StepLike, "agentId" | "reasonKind" | "reasonNote">): string {
  return `${s.agentId} ${plainReason(s.reasonKind)} ${s.reasonNote || ""}`.toLowerCase();
}

export function filterSteps<T extends StepLike>(steps: readonly T[], outcome: string, query: string): T[] {
  const q = query.trim().toLowerCase();
  return steps.filter((s) => (!outcome || outcomeOf(s) === outcome) && (!q || searchText(s).includes(q)));
}

/* ------------------------------ quiet runs ------------------------------ */

export type LedgerRow<T> = { kind: "step"; s: T } | { kind: "fold"; items: T[] };

/** A run of this many quiet turns in a row folds into one line. */
export const FOLD_AT = 3;

/**
 * A run of `FOLD_AT` or more consecutive turns that wrote nothing folds into one row. Only a quiet turn is ever folded: anything
 * that produced something, was refused, blocked, crashed or is still running stays a row of its own, so folding can shorten the
 * list but never hide a turn that mattered.
 */
export function foldQuiet<T extends StepLike>(list: readonly T[], enabled: boolean): LedgerRow<T>[] {
  if (!enabled) return list.map((s) => ({ kind: "step", s }) as LedgerRow<T>);
  const out: LedgerRow<T>[] = [];
  let run: T[] = [];
  const flush = (): void => {
    if (run.length >= FOLD_AT) out.push({ kind: "fold", items: run });
    else for (const r of run) out.push({ kind: "step", s: r });
    run = [];
  };
  for (const s of list) {
    if (outcomeOf(s) === "quiet") {
      run.push(s);
      continue;
    }
    flush();
    out.push({ kind: "step", s });
  }
  flush();
  return out;
}

export interface StepGroup<T> extends Bucket {
  list: T[];
  rows: LedgerRow<T>[];
  tokens: number;
}

/** The ledger: newest-first turns under coarse recency headings, each with its folded rows and what it cost. */
export function groupSteps<T extends StepLike>(steps: readonly T[], now: number, fold: boolean, buckets: readonly Bucket[]): StepGroup<T>[] {
  const by = new Map<string, T[]>();
  for (const s of steps) {
    const b = bucketOf(Date.parse(s.startedAt), now).id;
    const list = by.get(b);
    if (list) list.push(s);
    else by.set(b, [s]);
  }
  return buckets.filter((b) => by.has(b.id)).map((b) => {
    const list = by.get(b.id)!;
    return { ...b, list, rows: foldQuiet(list, fold), tokens: list.reduce((a, s) => a + (s.tokens || 0), 0) };
  });
}

/* ------------------------------- the strip ------------------------------- */

export interface Spend {
  /** The mission's tokens when the budget ledger knows them, else what the loaded turns add up to. */
  tokens: number;
  /** The loaded turns' own total: the denominator of the waste share, since it has to divide by the turns it counts. */
  loaded: number;
  /** Tokens spent by turns that landed nothing: quiet and refused alike. */
  wasted: number;
  wastedPct: number;
  /** The headline figure covers more than the loaded turns, so the waste share is for the loaded ones only. */
  partial: boolean;
}

/**
 * `/steps` reconstructs turns from a log tail, so a sum over them is not the mission's total. The budget projection behind
 * `/status` is, so the headline comes from there when it is known. The waste share still divides by the loaded turns, and says
 * so (`partial`) when they are not all of them: a share of a different total would be a number nobody can check.
 */
export function spendOf(steps: readonly StepLike[], missionTokens: number | null): Spend {
  const loaded = steps.reduce((a, s) => a + (s.tokens || 0), 0);
  const wasted = steps
    .filter((s) => { const o = outcomeOf(s); return o === "quiet" || o === "rejected"; })
    .reduce((a, s) => a + (s.tokens || 0), 0);
  return {
    tokens: missionTokens ?? loaded,
    loaded,
    wasted,
    wastedPct: loaded ? Math.round((wasted / loaded) * 100) : 0,
    partial: missionTokens != null && missionTokens > loaded,
  };
}

/**
 * What the strip says is happening. A mission that is running says who is working. One that is not says why nothing is, from
 * the one reading of the mission the whole console shares (`mission.ts`), so this line cannot disagree with the top bar: it used
 * to say "every agent is parked on its mailbox" over a project that was parked, paused or delivered.
 */
export function pulseLine(working: number, phase: string, loaded = true): { title: string; detail: string } {
  // Before the step history has arrived, "nothing is running" would be a claim about a list that has not been fetched.
  if (!loaded) {
    return phase === "offline"
      ? { title: "Not reachable", detail: "The server is not answering." }
      : { title: "Loading turns", detail: "Fetching the step history." };
  }
  // A server that is not answering outranks a turn marked live: that mark is the last thing it said, and the turn may be long over.
  if (phase === "offline" && working > 0) {
    return { title: "Not reachable", detail: `The server is not answering. ${working === 1 ? "1 agent was" : `${working} agents were`} mid-turn at its last report.` };
  }
  if (working > 0) return { title: working === 1 ? "1 agent working" : `${working} agents working`, detail: "Mid-turn right now." };
  switch (phase) {
    case "parked": return { title: "Nothing is running", detail: "The project is parked. Start the mission to run turns." };
    case "paused": return { title: "Nothing is running", detail: "The mission is paused." };
    case "done": return { title: "Nothing is running", detail: "The mission is delivered." };
    case "failed": return { title: "Nothing is running", detail: "The mission failed." };
    case "needs-you": return { title: "Nothing is running", detail: "Decisions are waiting on you." };
    case "ceiling": return { title: "Nothing is running", detail: "The host reached its spend ceiling." };
    case "offline": return { title: "Not reachable", detail: "The server is not answering, so this is the last state it reported." };
    case "loading": return { title: "Connecting", detail: "Waiting for the first answer." };
    case "no-goal": return { title: "Nothing is running", detail: "This mesh has no goal yet." };
    case "stalled": return { title: "No turn in flight", detail: "The mission is live but no agent is working." };
    default: return { title: "No turn in flight", detail: "Agents are waiting for mail." };
  }
}

/* ------------------------------- swimlanes ------------------------------- */

export interface WindowDef { id: string; label: string; ms: number }

export const WINDOWS: readonly WindowDef[] = [
  { id: "5m", label: "5m", ms: 5 * 60_000 },
  { id: "30m", label: "30m", ms: 30 * 60_000 },
  { id: "2h", label: "2h", ms: 2 * 3_600_000 },
  { id: "12h", label: "12h", ms: 12 * 3_600_000 },
  { id: "all", label: "all", ms: 0 },
];

const TICK_STEPS = [
  10_000, 30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000, 30 * 60_000,
  3_600_000, 2 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000, 24 * 3_600_000,
];

const endOf = (s: Pick<StepLike, "endedAt" | "startedAt">): number => Date.parse(s.endedAt || s.startedAt);

/**
 * A linear time axis is honest but useless when every turn lands in the last few minutes of a long run: the bars collapse into a
 * stripe at the right edge and 90% of the widget is empty. So the default window is the smallest preset that still holds about
 * 90% of the turns; full history is one click away.
 */
export function autoWindow(steps: readonly StepLike[], now: number): string {
  if (!steps.length) return "all";
  const need = steps.length * 0.9;
  for (const w of WINDOWS) {
    if (!w.ms) break;
    const held = steps.filter((s) => endOf(s) >= now - w.ms).length;
    if (held >= need) return w.id;
  }
  return "all";
}

export interface Tick {
  at: number;
  label: string;
  /** Every other tick, counting back from now. A narrow axis keeps these labels and drops the rest, so labels never touch. */
  major: boolean;
}

/**
 * Ticks count back from the right edge in whole steps. Aligning them to the epoch instead put every tick a ragged distance from
 * "now", so the labels read "-704m 41s", "-584m 17s": exact, and useless at a glance.
 */
export function axisTicks(t0: number, t1: number): Tick[] {
  const span = Math.max(1, t1 - t0);
  const step = TICK_STEPS.find((s) => span / s <= 6) ?? TICK_STEPS[TICK_STEPS.length - 1]!;
  const out: Tick[] = [];
  for (let back = 0, i = 0; back <= span; back += step, i++) {
    out.unshift({ at: ((span - back) / span) * 100, label: back ? `-${spanLabel(back)}` : "now", major: i % 2 === 0 });
  }
  return out;
}

export interface Bar<T> {
  step: T;
  /** Percent from the left edge, clamped to the window. */
  left: number;
  /** Percent of the window, never below a sliver that can be seen and pointed at. */
  width: number;
  /** The turn began before the window did, so its left edge is cut. */
  clipped: boolean;
}

export interface Lane<T> {
  agentId: string;
  bars: Bar<T>[];
  /** Milliseconds this agent spent in a turn within the window. */
  busy: number;
  /** Share of the window it was busy, 0 to 100. */
  busyPct: number;
  tokens: number;
}

export interface Timeline<T> {
  t0: number;
  t1: number;
  span: number;
  lanes: Lane<T>[];
  ticks: Tick[];
  /** Turns older than the window, which the axis note admits to. */
  hidden: number;
}

/**
 * "0%" next to a lane that has bars on it reads as a contradiction: it rounds a few seconds in a half-hour window down to nothing.
 * Busy at all is said as "<1%", so zero is only ever said of a lane that did not run.
 */
export function busyText(lane: Pick<Lane<unknown>, "busy" | "busyPct">): string {
  return lane.busy > 0 && lane.busyPct < 1 ? "<1%" : `${lane.busyPct}%`;
}

/** The narrowest a bar is drawn, in percent of the window. */
export const MIN_BAR_PCT = 0.8;

/**
 * The swimlanes for a window. A lane's busy share divides by the window it is drawn in, and a turn that began before the window is
 * clipped at its edge in both the bar and the sum, so "busy 40%" always means 40% of what is on screen.
 */
export function timeline<T extends StepLike>(steps: readonly T[], windowId: string, now: number): Timeline<T> | null {
  if (!steps.length) return null;
  const t1 = Math.max(now, ...steps.map(endOf));
  const chosen = WINDOWS.find((w) => w.id === windowId);
  const earliest = Math.min(...steps.map((s) => Date.parse(s.startedAt)));
  const t0 = chosen && chosen.ms ? t1 - chosen.ms : earliest;
  const span = Math.max(1, t1 - t0);
  const shown = steps.filter((s) => endOf(s) >= t0);
  const byAgent = new Map<string, T[]>();
  for (const s of shown) {
    const list = byAgent.get(s.agentId);
    if (list) list.push(s);
    else byAgent.set(s.agentId, [s]);
  }
  const lanes: Lane<T>[] = [...byAgent.entries()]
    .map(([agentId, list]) => {
      let busy = 0;
      const bars = list.map((s) => {
        const start = Date.parse(s.startedAt);
        const end = s.endedAt ? Date.parse(s.endedAt) : now;
        const rawLeft = ((start - t0) / span) * 100;
        const left = Math.max(0, rawLeft);
        const width = Math.max(MIN_BAR_PCT, ((end - start) / span) * 100 - (left - rawLeft));
        busy += Math.max(0, end - Math.max(start, t0));
        return { step: s, left, width: Math.min(width, 100 - left), clipped: rawLeft < 0 };
      });
      return {
        agentId, bars, busy,
        busyPct: Math.min(100, Math.round((busy / span) * 100)),
        tokens: list.reduce((a, s) => a + (s.tokens || 0), 0),
      };
    })
    .sort((a, b) => b.busy - a.busy || a.agentId.localeCompare(b.agentId));
  return { t0, t1, span, lanes, ticks: axisTicks(t0, t1), hidden: steps.length - shown.length };
}

/* ---------------------------------- rows --------------------------------- */

/**
 * What a row says the turn left behind, after its outcome label has already said whether it left anything. A quiet turn's label
 * is "No output", so a second "wrote nothing" beside it was the same fact twice; a live turn has no result yet. What remains is
 * the part the label cannot carry: how much landed, and how much the kernel refused.
 */
export function rowSummary(s: StepLike): string {
  if (outcomeOf(s) === "live") return "";
  return producedCount(s) > 0 || refusedOps(s).length > 0 ? opsSummary(s) : "";
}
