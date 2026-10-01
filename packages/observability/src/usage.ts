/**
 * Usage: what a mesh consumed, by day, seat and model, read from its event log.
 *
 * Every turn a seat takes appends a `budget.consumed` event carrying the model and the
 * tokens it used, so usage is a projection of the log like everything else: it can be
 * recomputed for any period, from a mesh that is stopped, and it cannot disagree with
 * what the mesh itself enforced its budgets against.
 *
 * Tokens are exact. Money is an ESTIMATE, and says so: it is computed only for models
 * that have a configured price, and a model with none is reported as unpriced rather
 * than costed at some default, because the agents run on the customer's own provider
 * credentials and the provider's invoice is the only authoritative bill. The report is
 * for chargeback, capacity planning and spotting a runaway; not for reconciling an
 * invoice to the cent.
 */
import * as fs from "fs";
import * as readline from "readline";
import { priceTokenUsage, type TokenPrice } from "../../protocol/src/pricing";

export type UsageDimension = "day" | "project" | "agent" | "model";

export const USAGE_DIMENSIONS: readonly UsageDimension[] = ["day", "project", "agent", "model"];

/** USD per million tokens. The cache prices default to the standard multipliers on the input price; set them for a model that differs (Opus 5.5 reads at 0.05x, Fable 5.1 at 0.025x). */
export type UsagePrice = TokenPrice;

export type UsagePrices = Readonly<Record<string, UsagePrice>>;

export interface UsageRow {
  day?: string;
  project?: string;
  agent?: string;
  model?: string;
  /** Turns that reported usage. */
  turns: number;
  inputTokens: number;
  outputTokens: number;
  /** Tokens written to the prompt cache: the billed amount minus input and output. */
  cacheWriteTokens: number;
  /** Replayed prompt tokens. Recorded for visibility; the mesh does not count them against budgets. */
  cacheReadTokens: number;
  /** What the mesh counted against its budgets: input + output + cache writes. */
  billedTokens: number;
  thinkingTokens: number;
  toolCalls: number;
  /** Estimated USD at the configured prices; `null` when any model in the row has no price. */
  costUsd: number | null;
}

export interface UsageSummary {
  turns: number;
  /** Distinct (day, seat) pairs that took a turn: the unit a per-seat plan would bill. */
  activeSeatDays: number;
  missionsCreated: number;
  missionsCompleted: number;
}

export interface UsageReport {
  since?: string;
  until?: string;
  groupBy: UsageDimension[];
  rows: UsageRow[];
  totals: UsageRow;
  summary: UsageSummary;
  /** Models seen with no configured price, so their cost is not in `costUsd`. */
  unpricedModels: string[];
  /** Said on every report: what the money column is and is not. */
  note: string;
}

export const USAGE_NOTE =
  "Tokens are exact, from the mesh's own ledger. costUsd is an estimate at the prices you configured, null where a model has no price; the model provider's invoice is the authoritative bill.";

/** Only the fields usage reads, so a test (or another log format) need not build a whole event. */
export interface UsageEventLike {
  type: string;
  timestamp: string;
  goalId?: string;
  actorId?: string;
  payload?: unknown;
}

export interface UsageOptions {
  /** Inclusive lower bound, ISO date or timestamp. */
  since?: string;
  /** Exclusive upper bound, ISO date or timestamp. */
  until?: string;
  groupBy?: readonly UsageDimension[];
  prices?: UsagePrices;
  /** Project label for events that come from a single log. */
  project?: string;
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** The price entry for a model id: exact, then without a provider prefix, then the longest key it starts with. */
export function priceFor(model: string, prices: UsagePrices | undefined): UsagePrice | undefined {
  if (!prices) return undefined;
  const id = model.toLowerCase();
  const bare = id.replace(/^[a-z0-9-]+\//, "");
  let best: [string, UsagePrice] | undefined;
  for (const [key, price] of Object.entries(prices)) {
    const k = key.toLowerCase();
    const kBare = k.replace(/^[a-z0-9-]+\//, "");
    if (k === id || kBare === bare) return price;
    if (bare.startsWith(kBare) && (!best || kBare.length > best[0].length)) best = [kBare, price];
  }
  return best?.[1];
}

function costOf(row: { inputTokens: number; outputTokens: number; cacheWriteTokens: number; cacheReadTokens: number }, price: UsagePrice): number {
  return priceTokenUsage(price, { input: row.inputTokens, output: row.outputTokens, cacheWrite: row.cacheWriteTokens, cacheRead: row.cacheReadTokens });
}

const bound = (text: string | undefined, name: string): number | undefined => {
  if (text === undefined || text === "") return undefined;
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) throw new Error(`${name} '${text}' is not a date (use 2026-10-01 or 2026-10-01T00:00:00Z)`);
  return ms;
};

/** Collects events and answers with a report; the log reader and the in-memory path share it. */
export class UsageAccumulator {
  private readonly groupBy: UsageDimension[];
  private readonly since: number | undefined;
  private readonly until: number | undefined;
  private readonly prices: UsagePrices | undefined;
  private readonly rows = new Map<string, { dims: Partial<Record<UsageDimension, string>>; acc: UsageRow; unpriced: boolean }>();
  private readonly seen = { models: new Set<string>(), unpriced: new Set<string>(), seatDays: new Set<string>() };
  private readonly summary: UsageSummary = { turns: 0, activeSeatDays: 0, missionsCreated: 0, missionsCompleted: 0 };
  private totalsRow: UsageRow = emptyRow();
  private totalsUnpriced = false;

  constructor(private readonly options: UsageOptions = {}) {
    this.groupBy = [...new Set(options.groupBy ?? ["day"])].filter((d): d is UsageDimension => (USAGE_DIMENSIONS as readonly string[]).includes(d));
    this.since = bound(options.since, "since");
    this.until = bound(options.until, "until");
    this.prices = options.prices;
  }

  add(event: UsageEventLike, project: string | undefined = this.options.project): void {
    const at = Date.parse(event.timestamp);
    if (Number.isNaN(at)) return;
    if (this.since !== undefined && at < this.since) return;
    if (this.until !== undefined && at >= this.until) return;
    if (event.type === "goal.created") {
      this.summary.missionsCreated += 1;
      return;
    }
    if (event.type === "goal.completed") {
      this.summary.missionsCompleted += 1;
      return;
    }
    if (event.type !== "budget.consumed") return;
    const p = (event.payload ?? {}) as Record<string, unknown>;
    // The per-seat entry carries the model; the mission and thread entries repeat the same
    // tokens without one, and counting them would triple every turn.
    if (typeof p.key !== "string" || !p.key.startsWith("agent:") || typeof p.model !== "string") return;
    const agent = typeof p.agentId === "string" ? p.agentId : (event.actorId ?? "unknown");
    const day = event.timestamp.slice(0, 10);
    const input = num(p.input);
    const output = num(p.output);
    const billed = num(p.amount);
    const delta: UsageRow = {
      turns: 1,
      inputTokens: input,
      outputTokens: output,
      cacheWriteTokens: Math.max(0, billed - input - output),
      cacheReadTokens: num(p.cacheRead),
      billedTokens: billed,
      thinkingTokens: num(p.thinking),
      toolCalls: num(p.toolCalls),
      costUsd: 0,
    };
    const price = priceFor(p.model, this.prices);
    if (price) delta.costUsd = costOf(delta, price);
    else {
      delta.costUsd = null;
      this.seen.unpriced.add(p.model);
    }
    this.seen.models.add(p.model);
    this.summary.turns += 1;
    this.seen.seatDays.add(`${project ?? ""}\u0000${day}\u0000${agent}`);

    const dims: Partial<Record<UsageDimension, string>> = {};
    for (const d of this.groupBy) dims[d] = d === "day" ? day : d === "agent" ? agent : d === "model" ? p.model : (project ?? "");
    const key = this.groupBy.map((d) => dims[d]).join("\u0000");
    let row = this.rows.get(key);
    if (!row) {
      row = { dims, acc: emptyRow(), unpriced: false };
      this.rows.set(key, row);
    }
    merge(row.acc, delta);
    if (delta.costUsd === null) row.unpriced = true;
    merge(this.totalsRow, delta);
    if (delta.costUsd === null) this.totalsUnpriced = true;
  }

  report(): UsageReport {
    const finish = (acc: UsageRow, unpriced: boolean): UsageRow => ({ ...acc, costUsd: unpriced ? null : roundUsd(acc.costUsd ?? 0) });
    const rows = [...this.rows.values()]
      .map((r) => ({ ...r.dims, ...finish(r.acc, r.unpriced) }) as UsageRow)
      .sort((a, b) => this.groupBy.map((d) => String(a[d] ?? "").localeCompare(String(b[d] ?? ""))).find((c) => c !== 0) ?? 0);
    const report: UsageReport = {
      groupBy: this.groupBy,
      rows,
      totals: finish(this.totalsRow, this.totalsUnpriced),
      summary: { ...this.summary, activeSeatDays: this.seen.seatDays.size },
      unpricedModels: [...this.seen.unpriced].sort(),
      note: USAGE_NOTE,
    };
    if (this.options.since) report.since = this.options.since;
    if (this.options.until) report.until = this.options.until;
    return report;
  }
}

function emptyRow(): UsageRow {
  return { turns: 0, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, billedTokens: 0, thinkingTokens: 0, toolCalls: 0, costUsd: 0 };
}

function merge(into: UsageRow, delta: UsageRow): void {
  into.turns += delta.turns;
  into.inputTokens += delta.inputTokens;
  into.outputTokens += delta.outputTokens;
  into.cacheWriteTokens += delta.cacheWriteTokens;
  into.cacheReadTokens += delta.cacheReadTokens;
  into.billedTokens += delta.billedTokens;
  into.thinkingTokens += delta.thinkingTokens;
  into.toolCalls += delta.toolCalls;
  if (delta.costUsd !== null && into.costUsd !== null) into.costUsd += delta.costUsd;
}

const roundUsd = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;

export function aggregateUsage(events: Iterable<UsageEventLike>, options: UsageOptions = {}): UsageReport {
  const acc = new UsageAccumulator(options);
  for (const e of events) acc.add(e);
  return acc.report();
}

/** A log source for the file reader: one project's `events.jsonl`. */
export interface UsageLog {
  project: string;
  file: string;
}

/**
 * Aggregate one or more event logs without opening them as event stores: a read-only line
 * scan that skips what it cannot parse and parses only the lines that can matter, so it is
 * safe to run beside a live mesh and cheap on a log of hundreds of megabytes.
 */
export async function aggregateUsageFromLogs(logs: readonly UsageLog[], options: UsageOptions = {}): Promise<UsageReport> {
  const acc = new UsageAccumulator(options);
  for (const log of logs) {
    if (!fs.existsSync(log.file)) continue;
    const lines = readline.createInterface({ input: fs.createReadStream(log.file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.includes('"budget.consumed"') && !line.includes('"goal.created"') && !line.includes('"goal.completed"')) continue;
      let event: UsageEventLike;
      try {
        event = JSON.parse(line) as UsageEventLike;
      } catch {
        continue;
      }
      if (event && typeof event.type === "string" && typeof event.timestamp === "string") acc.add(event, log.project);
    }
  }
  return acc.report();
}

const CSV_COLUMNS = ["day", "project", "agent", "model", "turns", "inputTokens", "outputTokens", "cacheWriteTokens", "cacheReadTokens", "billedTokens", "thinkingTokens", "toolCalls", "costUsd"] as const;

const csvCell = (v: unknown): string => {
  if (v === undefined || v === null) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV with a header row; the grouped dimensions first, then the measures. A total row is not added: sum the column. */
export function usageToCsv(report: UsageReport): string {
  const columns = CSV_COLUMNS.filter((c) => (USAGE_DIMENSIONS as readonly string[]).includes(c) ? report.groupBy.includes(c as UsageDimension) : true);
  const lines = [columns.join(",")];
  for (const row of report.rows) lines.push(columns.map((c) => csvCell(row[c as keyof UsageRow])).join(","));
  return `${lines.join("\n")}\n`;
}
