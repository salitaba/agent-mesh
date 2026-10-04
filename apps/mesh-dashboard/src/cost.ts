/**
 * What the Cost page reads out of `GET /budgets`, with no DOM in it: how full the mission's budget is and what colour that is,
 * who spent what and what share of the whole, what each seat has left of its own budget, and the plain name of every budget
 * the host keeps.
 *
 * The honesty rules this module carries are the ones the page is built on:
 * - the tone of a meter is one function, mirroring the top bar (warn from 80%, bad from 95%, bad when the server says
 *   `exceeded`), so the bar and this page cannot disagree about how full the budget is;
 * - a share is a share of what was spent, so the shares add to 100%; a bar is scaled to the biggest row and says so;
 * - a budget is named by what it limits, with its unit, because the three kinds (tokens, minutes, events) look alike in a table.
 *
 * What it does not do is price anything. The payload carries tokens only; the one dollar figure the console has is the host's
 * own estimate, which the page shows as an estimate and never derives. What it does say is which price the host used for each
 * model (yours, the list price, or the default rate), because that is the part of an estimate a reader can check.
 */
import { fmt } from "./format";

export type BudgetTone = "ok" | "warn" | "bad";

/** The top bar's meter turns amber at 80% and red at 95% (shell.tsx). The numbers live in two files; this one says so. */
export const WARN_AT = 0.8;
export const BAD_AT = 0.95;

export function budgetTone(ratio: number | null, exceeded = false): BudgetTone {
  if (exceeded) return "bad";
  if (ratio === null || !Number.isFinite(ratio)) return "ok";
  return ratio >= BAD_AT ? "bad" : ratio >= WARN_AT ? "warn" : "ok";
}

/** "0%", "under 1%", "3%": a non-zero spend is never rounded down to nothing, and a full budget is never rounded up to "100%". */
export function pctLabel(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return "no limit";
  if (ratio <= 0) return "0%";
  if (ratio < 0.01) return "under 1%";
  const p = Math.round(ratio * 100);
  return ratio < 1 && p >= 100 ? "99%" : `${p}%`;
}

/** Dollars, as an estimate reads: cents under $100, whole dollars above, and "under $0.01" instead of a rounded zero. */
export function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0.00";
  if (n < 0.01) return "under $0.01";
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n).toLocaleString("en-GB")}`;
}

/**
 * The model families Anthropic's list prices name, and when those prices were read. Both are copies of
 * packages/protocol/src/pricing.ts, which the dashboard may not import; tests/dashboard/cost.test.ts reads that file and fails
 * when either copy has drifted, so the page cannot go on quoting a price list the host no longer uses.
 */
export const LIST_PRICED_FAMILIES: readonly string[] = ["claude-haiku-4-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"];
export const LIST_PRICES_AS_OF = "2026-10-01";

export type PriceBasis = "yours" | "list" | "default" | "unknown";

/**
 * Which price the host's estimate uses for a model, in the host's own order (host-config.ts `priceUsage`): a price the operator
 * wrote for exactly that model id, then Anthropic's list price for its family (a dated id or a provider prefix still matches,
 * `claude-haiku-4-50` does not), then the default rate for everything else. `yours` is null when the host's settings could not
 * be read, and then nothing is claimed: a model may have a price of the operator's that this page cannot see.
 */
export function priceBasis(model: string, yours: readonly string[] | null): PriceBasis {
  if (yours === null) return "unknown";
  if (yours.includes(model)) return "yours";
  const bare = model.toLowerCase().replace(/^[a-z0-9-]+\//, "");
  return LIST_PRICED_FAMILIES.some((family) => bare === family || bare.startsWith(`${family}-`)) ? "list" : "default";
}

/** "2026-10-01" as "1 October 2026"; anything else comes back as it was. */
export function longDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

export interface BudgetEntry {
  key: string;
  limit: number | null;
  limitKind: string;
  reserved?: number;
  consumed: number;
  exceeded: boolean;
}

interface RawAgent { agentId: string; tokens: number; activations: number; perTurn: number }
interface RawModel { model: string; tokens: number; input: number; output: number; cacheRead: number; turns: number; agents: string[]; share: number; avgPerTurn: number }

/** The shape `/budgets` answers with; every field is read defensively, because an older host leaves some out. */
export interface BudgetsPayload {
  entries?: BudgetEntry[];
  cost?: { perAgent?: RawAgent[]; missionTokens?: number; missionBudget?: number; models?: RawModel[] };
}

const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);

/**
 * A budget the server has latched as `exceeded` is of two kinds the host tells apart (policy-engine, `evaluateActivation`): one
 * that is spent, and one still below its limit that cannot cover the next turn's hold. "Exhausted (99706/180000)" reads as a
 * bookkeeping error, so the page says which: `short` is exceeded with room left.
 */
export interface OwnBudget { used: number; limit: number; ratio: number; tone: BudgetTone; exceeded: boolean; short: boolean }

export interface AgentRow {
  agentId: string;
  tokens: number;
  /** Of everything spent, 0..1. The shares of all rows add to 1. */
  share: number;
  /** Against the biggest row, 0..1: the length of the bar. */
  bar: number;
  activations: number;
  perTurn: number;
  /** What the seat has used of the budget that is its own, when it has one. */
  own: OwnBudget | null;
}

export interface ModelRow {
  model: string;
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  turns: number;
  agents: string[];
  share: number;
  bar: number;
  avgPerTurn: number;
  /** Which price the host's dollar estimate uses for this model. */
  basis: PriceBasis;
}

export interface MissionBudget {
  used: number;
  limit: number;
  /** 0..n, or null when the mission has no token limit. */
  ratio: number | null;
  remaining: number | null;
  tone: BudgetTone;
  /** The server has latched it: nothing more runs on it until it is raised. */
  exceeded: boolean;
  /** Exceeded with room left, because the next turn's hold does not fit. */
  short: boolean;
}

export interface DetailRow {
  group: "mission" | "agent" | "attention" | "thread" | "task" | "other";
  label: string;
  /** What the budget belongs to, with nothing added: the seat, thread or task id, or the key of an unrecognised budget. */
  who: string;
  /** What the limit is counted in, said in words: "tokens", "minutes", "events", "turns". */
  unit: string;
  used: string;
  limit: string;
  ratio: number | null;
  /** "over": the server has latched it (or the count is past the limit); "near": 80% or more, not latched; otherwise "ok". */
  state: "over" | "near" | "ok";
  /** Over with room left: the next turn's hold does not fit. See OwnBudget. */
  short: boolean;
  key: string;
}

export interface CostSummary {
  mission: MissionBudget;
  agents: AgentRow[];
  models: ModelRow[];
  /** What was spent, by the seats: the denominator of every share. */
  spent: number;
  turns: number;
  /** Replayed transcript tokens: outside the token budget, billed by the provider at a reduced rate. */
  cacheTotal: number;
  /** Budgets that are spent and have stopped work that needs you: see HALTING. */
  over: DetailRow[];
  /** The models this project used that the host can only price at its default rate. */
  defaulted: string[];
  details: DetailRow[];
}

const GROUPS: Array<DetailRow["group"]> = ["mission", "agent", "attention", "thread", "task", "other"];

/**
 * Which spent budgets stop work and reach the operator. The mission's does, and is never raised on its own. A seat's does once the
 * host has raised it as far as it will (agent and thread budgets are doubled automatically, up to a multiple of what was set,
 * before anyone is asked), and then Needs you holds the card. A thread or a task running out is routine: the agents open a fresh
 * thread, and the host asks only when nothing else can run. Those still show as "over" in the table of every budget.
 */
const HALTING: ReadonlyArray<DetailRow["group"]> = ["mission", "agent"];
export const GROUP_LABEL: Record<DetailRow["group"], string> = {
  mission: "Mission",
  agent: "Each agent's own budget",
  attention: "What an agent may spend waking others",
  thread: "Conversation threads",
  task: "Tasks",
  other: "Other",
};

const UNIT: Record<string, string> = { tokens: "tokens", wallclock_minutes: "minutes", events: "events", activations: "turns" };
const amount = (n: number, kind: string): string =>
  kind === "wallclock_minutes" ? `${Math.round(n)} min` : kind === "events" || kind === "activations" ? n.toLocaleString("en-GB") : fmt(n);

/** The part of a budget key after `<kind>:<goal>/`, which is the seat, thread or task it belongs to. */
const subject = (key: string): string => key.slice(key.indexOf(":") + 1).split("/").slice(1).join("/");

export function describeBudget(e: BudgetEntry): DetailRow {
  const kind = String(e.limitKind || "tokens");
  const prefix = e.key.split(":")[0] ?? "";
  const group: DetailRow["group"] = (GROUPS as string[]).includes(prefix) ? (prefix as DetailRow["group"]) : "other";
  const who = group === "other" ? e.key : subject(e.key) || e.key;
  const base = group === "mission" ? "The whole mission" : who;
  // Three kinds of limit look alike in a column of numbers; a token budget is the plain case and says nothing, the others say what they count.
  const label = kind === "tokens" ? base : `${base} (${UNIT[kind] ?? kind})`;
  const limit = e.limit === null || e.limit === undefined ? null : num(e.limit);
  const used = num(e.consumed);
  const ratio = limit === null || limit <= 0 ? null : used / limit;
  const tone = budgetTone(ratio, e.exceeded === true);
  // "Over" is the server's latch, or a count past the limit; 95% used is nearly used, not over.
  const over = e.exceeded === true || (ratio !== null && ratio > 1);
  return {
    group,
    label,
    who,
    unit: UNIT[kind] ?? kind,
    used: amount(used, kind),
    limit: limit === null ? "no limit" : amount(limit, kind),
    ratio,
    state: over ? "over" : tone === "ok" ? "ok" : "near",
    short: over && limit !== null && used < limit,
    key: `${e.key}:${kind}`,
  };
}

/** `yours` is the ids of the models the operator set a price for in host.yaml (null when unread); it only decides each model's `basis`. */
export function summarizeCost(p: BudgetsPayload | null | undefined, yours: readonly string[] | null = null): CostSummary {
  const entries = Array.isArray(p?.entries) ? p!.entries! : [];
  const cost = p?.cost ?? {};
  const rawAgents = (Array.isArray(cost.perAgent) ? cost.perAgent : []).filter((a) => a.agentId !== "human");

  const limit = num(cost.missionBudget);
  const used = num(cost.missionTokens);
  const missionEntry = entries.find((e) => e.key.startsWith("mission:") && (e.limitKind ?? "tokens") === "tokens");
  const ratio = limit > 0 ? used / limit : null;
  const missionExceeded = missionEntry?.exceeded === true || (ratio !== null && ratio > 1);
  const mission: MissionBudget = {
    used,
    limit,
    ratio,
    remaining: limit > 0 ? Math.max(0, limit - used) : null,
    tone: budgetTone(ratio, missionEntry?.exceeded === true),
    exceeded: missionExceeded,
    short: missionExceeded && limit > 0 && used < limit,
  };

  const own = new Map<string, OwnBudget>();
  for (const e of entries) {
    if (!e.key.startsWith("agent:") || (e.limitKind ?? "tokens") !== "tokens" || e.limit === null || num(e.limit) <= 0) continue;
    const r = num(e.consumed) / num(e.limit);
    const exceeded = e.exceeded === true || r > 1;
    own.set(subject(e.key), { used: num(e.consumed), limit: num(e.limit), ratio: r, tone: budgetTone(r, e.exceeded === true), exceeded, short: exceeded && r < 1 });
  }

  const spent = rawAgents.reduce((n, a) => n + num(a.tokens), 0);
  const top = Math.max(1, ...rawAgents.map((a) => num(a.tokens)));
  const agents: AgentRow[] = rawAgents
    .map((a) => ({
      agentId: a.agentId,
      tokens: num(a.tokens),
      share: spent > 0 ? num(a.tokens) / spent : 0,
      bar: num(a.tokens) / top,
      activations: num(a.activations),
      perTurn: num(a.perTurn),
      own: own.get(a.agentId) ?? null,
    }))
    .sort((a, b) => b.tokens - a.tokens || a.agentId.localeCompare(b.agentId));

  const rawModels = Array.isArray(cost.models) ? cost.models : [];
  const modelTop = Math.max(1, ...rawModels.map((m) => num(m.tokens)));
  const models: ModelRow[] = rawModels
    .map((m) => ({
      model: m.model,
      tokens: num(m.tokens),
      input: num(m.input),
      output: num(m.output),
      cacheRead: num(m.cacheRead),
      turns: num(m.turns),
      agents: Array.isArray(m.agents) ? m.agents : [],
      share: num(m.share),
      bar: num(m.tokens) / modelTop,
      avgPerTurn: num(m.avgPerTurn),
      basis: priceBasis(m.model, yours),
    }))
    .sort((a, b) => b.tokens - a.tokens);

  const details = entries
    .map(describeBudget)
    .sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group) || (b.ratio ?? -1) - (a.ratio ?? -1) || a.label.localeCompare(b.label));

  return {
    mission,
    agents,
    models,
    spent,
    turns: agents.reduce((n, a) => n + a.activations, 0),
    cacheTotal: models.reduce((n, m) => n + m.cacheRead, 0),
    over: details.filter((d) => d.state === "over" && HALTING.includes(d.group)),
    defaulted: models.filter((m) => m.basis === "default").map((m) => m.model),
    details,
  };
}

/** "a", "a and b", "a, b and c". */
const joinAnd = (xs: readonly string[]): string => (xs.length <= 2 ? xs.join(" and ") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/**
 * Which budgets have stopped work, as sentences and never as raw keys: "The mission budget is spent." or "Agent qa's own budget
 * has too little left for its next turn." (the host's own two cases: spent, and latched below the limit because the next turn's
 * hold does not fit). Each opens with a fixed word, so a seat's id is never the first word of a sentence, where capitalising it
 * would misspell it ("Qa").
 */
export function overSentence(over: readonly DetailRow[], shown = 3): string {
  const name = (d: DetailRow): string =>
    d.group === "mission" ? (d.unit === "minutes" ? "The mission's time limit" : d.unit === "events" ? "The mission's event limit" : "The mission budget")
    : d.group === "agent" ? `Agent ${d.who}'s own budget`
    : d.group === "attention" ? `Agent ${d.who}'s budget for waking others`
    : d.group === "thread" || d.group === "task" ? `The budget of ${d.who}`
    : `The budget ${d.who}`;
  const out = over.slice(0, shown).map((d) => `${name(d)} ${d.short ? "has too little left for its next turn" : "is spent"}.`);
  const rest = over.length - shown;
  if (rest > 0) out.push(`${rest} more ${rest === 1 ? "budget is" : "budgets are"} stopped too.`);
  return out.join(" ");
}

/**
 * The host's auto-raise defaults (packages/config/src/index.ts): an agent or conversation budget that runs out is raised by
 * `factor` until it reaches `maxMultiple` times what was set. The page says "by default" and quotes these; the test reads the
 * config source, so the sentence cannot outlive the numbers.
 */
export const AUTO_RAISE_DEFAULT = { factor: 2, maxMultiple: 8 } as const;

/** What happens when each kind of budget runs out, as the host behaves (termination.ts, supervisor.ts `tryAutoRaise`). */
export function budgetRules(): Array<{ what: string; rule: string }> {
  // "Doubling" is the factor of 2 in AUTO_RAISE_DEFAULT; the test fails if the host's default factor moves, and these words with it.
  const raised = `By default the host raises it for you, doubling it each time, up to ${AUTO_RAISE_DEFAULT.maxMultiple} times what was set. The mesh file's budgets.auto_raise changes that.`;
  return [
    { what: "The mission budget", rule: "It is never raised on its own. When more is spent than it allows, the mission stops and Needs you asks whether to raise it." },
    { what: "An agent's own budget", rule: `${raised} Past that, the agent takes no more turns and Needs you asks whether to raise it.` },
    { what: "A conversation's budget", rule: `${raised} Past that, the conversation takes no more turns. The agents open a new one, and Needs you is asked only if nothing else can run.` },
  ];
}

/** The agents a model row names: the first three, then how many more. */
export function agentList(agents: readonly string[], shown = 3): string {
  if (agents.length <= shown) return agents.join(", ");
  return `${agents.slice(0, shown).join(", ")} and ${agents.length - shown} more`;
}

/**
 * What the page says about the models the host can only price at its default rate, or null when every model has a price. It opens
 * with a fixed word so a model id is never the first word of a sentence, and it ends on the ids so each stays whole.
 */
export function defaultPriceNote(models: readonly string[], rate: number | null, shown = 4): string | null {
  if (!models.length) return null;
  const at = rate === null ? "the default rate" : `the default rate of $${rate} per million tokens`;
  const names = models.slice(0, shown);
  if (models.length > shown) names.push(`${models.length - shown} more`);
  return `Priced at ${at}, because ${models.length === 1 ? "it has" : "they have"} no list price and none of yours: ${joinAnd(names)}.`;
}

/** What the Cost page says when nothing has been spent, by the state of the mission. */
export function idleCopy(phase: string, hasHistory: boolean): { body: string; start: boolean } {
  switch (phase) {
    case "parked":
      return { body: hasHistory ? "Nothing was spent before the mission was parked. Continue it, and tokens are counted as agents take turns." : "Nothing has been spent. Start the mission, and tokens are counted as agents take turns.", start: true };
    case "paused":
      return { body: "The mission is paused and nothing was spent before it stopped. Resume it, and tokens are counted as agents take turns.", start: true };
    case "running":
    case "quiet":
    case "stalled":
      return { body: "No agent has finished a turn yet, so nothing has been counted. Tokens are counted as agents take turns.", start: false };
    default:
      return { body: "Nothing has been spent. Tokens are counted as agents take turns.", start: false };
  }
}

/** How long ago a reading was taken, as the page words it: "just now", "12s ago", "3m ago". */
export function readingAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 4000) return "just now";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  return `${Math.round(ms / 60_000)}m ago`;
}
