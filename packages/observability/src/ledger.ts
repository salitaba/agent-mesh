/**
 * The cache ledger: what each settled turn actually cost, read back from the
 * audit file.
 *
 * `logs/turn-audit.jsonl` records `output.tokensUsed` whole, so it is the one
 * place a finished mission can be read for the split `TurnRecord.tokensCacheRead`
 * exists to expose — fresh input against replayed transcript. §1 of
 * `NOTES-communication-measured-review.md` was reconstructed by hand from this
 * file, and §11 re-measured it; this is that reconstruction as code, so the next
 * mission costs a command instead of a session.
 *
 * Two readings are deliberately kept apart:
 *
 * - **fresh input** (`input`) is what the provider billed uncached;
 * - **cache read** (`cacheRead`) is transcript replayed at the cache price.
 *
 * A turn whose audit record carries **no** `cacheRead` is *unknown*, not cold —
 * older records predate the field, and counting them as cold is exactly how a
 * handful of catastrophic re-reads stayed invisible (§1e). `CacheLedger.turns`
 * counts what could be read; `unmeasured` counts what could not.
 */

/** Published Anthropic ratios, as units of one fresh input token. */
export const TOKEN_COST_RATIO = { fresh: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 } as const;

export interface TurnLedgerRow {
  /** The line's ISO timestamp prefix — the audit record carries no time of its own. */
  at: string;
  turnId: string;
  agentId: string;
  model?: string;
  /** `activation.kind` — why the seat was woken. */
  kind?: string;
  input: number;
  output: number;
  /** `null` when the record has no such field: not cold, unmeasured. */
  cacheRead: number | null;
  total?: number;
  instructionsChars?: number;
  estInputTokens?: number;
  ops: number;
  toolCalls: number;
}

export interface GapBucket {
  label: string;
  turns: number;
  medianFresh: number;
  maxFresh: number;
}

export interface CacheLedger {
  /** Turns whose audit record could be read as a cache ledger. */
  turns: number;
  /** Readable turns carrying no `cacheRead` field at all. */
  unmeasured: number;
  freshInput: number;
  cacheRead: number;
  output: number;
  units: { freshInput: number; cachedRead: number; output: number };
  /** Most expensive turns by fresh input, first. */
  top: TurnLedgerRow[];
  /** Share of all fresh input held by `top`, 0..1. */
  topFreshShare: number;
  coldTurns: number;
  coldFreshShare: number;
  /** Fresh input by gap since that seat's own previous turn. */
  gaps: GapBucket[];
}

/** `<ISO ts> {json}` — the audit file's line shape. */
const AUDIT_LINE = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)[ ](\{.*\})$/;

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Parse an audit file's text. Unreadable lines are counted, never thrown on:
 * this is a diagnostic over a log a live mission is still appending to.
 *
 * The file carries **two** shapes under the same timestamp prefix: turn records
 * (`<ts> {json}`) and prose audit lines (`<ts> <sentence>`, written by
 * `supervisor.auditLine` — and a prose line can itself span physical lines when
 * it quotes a rendered artifact). So three counts, and only one of them is bad
 * news:
 *
 * - `other` — stamped lines that are not turn records: prose, and records from
 *   an older shape with no token figures. A normal part of the file.
 * - `unstamped` — lines with no timestamp prefix at all: continuations of a
 *   multi-line prose line, or content foreign to this file. Expected here; the
 *   reader does not claim to know which.
 * - `damaged` — a line that opens a JSON record under a timestamp and cannot be
 *   parsed. The one count worth reporting to an operator.
 */
export function parseTurnAudit(text: string): {
  rows: TurnLedgerRow[];
  other: number;
  unstamped: number;
  damaged: number;
} {
  const rows: TurnLedgerRow[] = [];
  let other = 0;
  let unstamped = 0;
  let damaged = 0;
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    const prefix = AUDIT_LINE.exec(raw);
    if (!prefix) {
      const stamped = /^\d{4}-\d\d-\d\dT[\d:.]+Z (.*)$/.exec(raw);
      if (!stamped) unstamped++;
      else if (stamped[1]!.startsWith("{")) damaged++;
      else other++;
      continue;
    }
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(prefix[2]!) as Record<string, unknown>;
    } catch {
      damaged++;
      continue;
    }
    const tokens = rec.tokens as Record<string, unknown> | undefined;
    const input = num(tokens?.input);
    const cacheRead = num(tokens?.cacheRead);
    // Absence, not falsiness: a turn that reported `input: 0` has a token figure
    // — it is the smallest kind of row, not a line without one. Testing `!input`
    // here dropped two of mission A's 307 traced turns (§11a) from the ledger.
    if (input === undefined && cacheRead === undefined) {
      // A JSON line with no token figures is not a ledger row: an old shape, or
      // a record whose runtime reported nothing.
      other++;
      continue;
    }
    const activation = rec.activation as Record<string, unknown> | undefined;
    rows.push({
      at: prefix[1]!,
      turnId: String(rec.turnId ?? ""),
      agentId: String(rec.agentId ?? ""),
      model: typeof rec.model === "string" ? rec.model : undefined,
      kind: typeof activation?.kind === "string" ? activation.kind : undefined,
      input: input ?? 0,
      output: num(tokens?.output) ?? 0,
      cacheRead: cacheRead ?? null,
      total: num(tokens?.total),
      instructionsChars: num(rec.instructionsChars),
      estInputTokens: num(rec.estInputTokens),
      ops: Array.isArray(rec.ops) ? rec.ops.length : 0,
      toolCalls: Array.isArray(rec.toolCalls) ? rec.toolCalls.length : 0,
    });
  }
  return { rows, other, unstamped, damaged };
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

const GAP_BUCKETS: Array<[number, number, string]> = [
  [0, 2, "<2 min"],
  [2, 5, "2-5 min"],
  [5, 10, "5-10 min"],
  [10, 30, "10-30 min"],
  [30, Number.POSITIVE_INFINITY, ">30 min"],
];

/**
 * Summarise parsed rows. `top` defaults to 10 — the size §1 used, kept so the
 * number this prints is comparable to the one the review quotes.
 */
export function buildCacheLedger(rows: TurnLedgerRow[], top = 10): CacheLedger {
  const freshInput = rows.reduce((a, r) => a + r.input, 0);
  const cacheRead = rows.reduce((a, r) => a + (r.cacheRead ?? 0), 0);
  const output = rows.reduce((a, r) => a + r.output, 0);

  const byFresh = [...rows].sort((a, b) => b.input - a.input);
  const topRows = byFresh.slice(0, top);
  const topFresh = topRows.reduce((a, r) => a + r.input, 0);

  const measured = rows.filter((r) => r.cacheRead !== null);
  const cold = measured.filter((r) => r.cacheRead === 0);
  const coldFresh = cold.reduce((a, r) => a + r.input, 0);

  // Gap since the same seat's previous turn end, on the whole readable set —
  // buckets with no turns are omitted rather than printed as zeros.
  const gaps: GapBucket[] = [];
  const ordered = [...rows].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  for (const [lo, hi, label] of GAP_BUCKETS) {
    const inBucket: number[] = [];
    const lastEnd = new Map<string, number>();
    for (const r of ordered) {
      const prev = lastEnd.get(r.agentId);
      if (prev !== undefined) {
        const mins = (Date.parse(r.at) - prev) / 60_000;
        if (mins >= lo && mins < hi) inBucket.push(r.input);
      }
      lastEnd.set(r.agentId, Date.parse(r.at));
    }
    if (inBucket.length === 0) continue;
    gaps.push({ label, turns: inBucket.length, medianFresh: median(inBucket), maxFresh: Math.max(...inBucket) });
  }

  return {
    turns: rows.length,
    unmeasured: rows.length - measured.length,
    freshInput,
    cacheRead,
    output,
    units: {
      freshInput: freshInput * TOKEN_COST_RATIO.fresh,
      cachedRead: cacheRead * TOKEN_COST_RATIO.cacheRead,
      output: output * TOKEN_COST_RATIO.output,
    },
    top: topRows,
    topFreshShare: freshInput ? topFresh / freshInput : 0,
    coldTurns: cold.length,
    coldFreshShare: freshInput ? coldFresh / freshInput : 0,
    gaps,
  };
}
