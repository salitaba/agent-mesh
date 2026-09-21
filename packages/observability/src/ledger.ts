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
 * Three readings are deliberately kept apart:
 *
 * - **fresh input** (`input`) is what the provider billed uncached;
 * - **cache read** (`cacheRead`) is transcript replayed at the cache price;
 * - **written** (`output`) is what the model emitted, billed at 5x fresh — the
 *   largest share of the missions measured so far, and the one no round of
 *   communication work had touched, because nothing here could say what it was
 *   spent ON. `written` splits it two ways: `thinking`, which the backend may
 *   or may not report, and inline artifact bodies, which the audit records in
 *   full because the publish tool call carries them as arguments.
 *
 * A turn whose audit record carries **no** `cacheRead` is *unknown*, not cold —
 * older records predate the field, and counting them as cold is exactly how a
 * handful of catastrophic re-reads stayed invisible (§1e). `CacheLedger.turns`
 * counts what could be read; `unmeasured` counts what could not. The same rule
 * governs `thinking`: a record with no thinking figure is a backend that did
 * not report the split, not a turn that did no thinking, and it is counted in
 * `written.thinkingUnmeasured` rather than folded into the total as a zero.
 */

/**
 * Characters per token, for turning a recorded character count into the token
 * figure the provider billed. The supervisor's own estimate uses the same
 * number, so the two readings of one mission stay comparable; both are
 * estimates and both say so.
 */
const CHARS_PER_TOKEN = 3.5;

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
  /**
   * The thinking part of `output`. `null` when the record carries no such
   * field: unmeasured, not zero — most gateways omit the detail, and reading
   * their silence as "thought nothing" would make the split look free.
   */
  thinking: number | null;
  /**
   * Publish tool calls on this turn, whatever body they used.
   *
   * Optional, and absence again means unmeasured: these come from the audit's
   * recorded tool-call arguments, and a caller feeding rows from a source
   * without them has no publish figure rather than a zero one. `written`
   * counts such rows in `publishUnmeasured`.
   */
  publishCalls?: number;
  /** Characters this turn sent inline as a publish `content` argument. */
  publishChars?: number;
  /** Publish calls that sent `fromPath` or `edits` instead of a body. */
  publishByRef?: number;
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

/**
 * What a mission's output tokens were spent on.
 *
 * Output is billed at five times fresh input, so this is usually the biggest
 * line on the bill and was, until this existed, a single undifferentiated
 * number. The two components it separates want opposite fixes: thinking is
 * bought with `effort`, and inline artifact bodies are avoided outright by
 * publishing from a path or as edits.
 */
export interface WrittenLedger {
  /** Every output token across readable turns, thinking included. */
  output: number;
  /** Reported thinking tokens; `null` when NO readable turn reported the split. */
  thinking: number | null;
  /** Readable turns carrying no thinking figure. Unmeasured, never zero. */
  thinkingUnmeasured: number;
  /**
   * Every turn that reported the split reported exactly 0.
   *
   * The third state, and the one absence-vs-zero alone does not catch: a
   * gateway that emits `thinking: 0` on every call is reporting the FIELD
   * without filling it, and that is indistinguishable from a model that
   * genuinely never thinks — unless the ledger says which shape it saw. On the
   * mission this was built against, all 53 turns reported 0 while billed output
   * ran three times the visible transcript, so the zeros were plainly the
   * gateway's and not the model's.
   *
   * `false` when nothing reported at all: with no reports there is no pattern.
   */
  thinkingZeroThroughout: boolean;
  /** Publish tool calls seen in the audit. */
  publishCalls: number;
  /** Rows that carried no publish figures at all. Unmeasured, never zero. */
  publishUnmeasured: number;
  /** Of those, the ones that sent a reference instead of a body. */
  publishByRef: number;
  /** Characters sent inline as publish bodies. */
  publishChars: number;
  /**
   * `publishChars` as output tokens, at the same `CHARS_PER_TOKEN` the
   * supervisor uses for its own estimates — an estimate, and named one, because
   * the provider bills a tokenizer this reader does not run.
   */
  estPublishTokens: number;
  /** `estPublishTokens / output`, 0..1. `null` when nothing was written. */
  publishOutputShare: number | null;
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
  /** What the `output` figure was spent on. */
  written: WrittenLedger;
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
    // The audit keeps tool calls whole — arguments included — which is the only
    // reason an inline publish body can be counted at all after the fact. Match
    // on the suffix: the same op arrives as `mesh_artifact_publish` from the
    // json-block path and `mcp__mesh__mesh_artifact_publish` over MCP.
    let publishChars = 0;
    let publishCalls = 0;
    let publishByRef = 0;
    for (const call of Array.isArray(rec.toolCalls) ? rec.toolCalls : []) {
      const c = call as { name?: unknown; args?: unknown } | null;
      const name = typeof c?.name === "string" ? c.name : "";
      if (!name.endsWith("mesh_artifact_publish") && !name.endsWith("publish_artifact")) continue;
      publishCalls++;
      const args = (c?.args ?? {}) as Record<string, unknown>;
      if (typeof args.content === "string") publishChars += args.content.length;
      if (args.fromPath !== undefined || args.edits !== undefined) publishByRef++;
    }
    rows.push({
      at: prefix[1]!,
      turnId: String(rec.turnId ?? ""),
      agentId: String(rec.agentId ?? ""),
      model: typeof rec.model === "string" ? rec.model : undefined,
      kind: typeof activation?.kind === "string" ? activation.kind : undefined,
      input: input ?? 0,
      output: num(tokens?.output) ?? 0,
      cacheRead: cacheRead ?? null,
      thinking: num(tokens?.thinking) ?? null,
      publishCalls,
      publishChars,
      publishByRef,
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

  // Thinking is summed over the turns that reported it and the rest are counted,
  // never defaulted: a mission where two of fifty turns report thinking has a
  // thinking figure for two turns, not a mission that barely thought. `null`
  // when not one turn reported it — the honest answer there is "unknown", and a
  // 0 would read as "measured, and none".
  const withThinking = rows.filter((r) => r.thinking !== null);
  const thinking = withThinking.length ? withThinking.reduce((a, r) => a + (r.thinking ?? 0), 0) : null;
  const publishChars = rows.reduce((a, r) => a + (r.publishChars ?? 0), 0);
  const estPublishTokens = Math.round(publishChars / CHARS_PER_TOKEN);
  const written: WrittenLedger = {
    output,
    thinking,
    thinkingUnmeasured: rows.length - withThinking.length,
    thinkingZeroThroughout: withThinking.length > 0 && withThinking.every((r) => r.thinking === 0),
    publishCalls: rows.reduce((a, r) => a + (r.publishCalls ?? 0), 0),
    publishUnmeasured: rows.filter((r) => r.publishCalls === undefined).length,
    publishByRef: rows.reduce((a, r) => a + (r.publishByRef ?? 0), 0),
    publishChars,
    estPublishTokens,
    publishOutputShare: output ? estPublishTokens / output : null,
  };

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
    written,
    top: topRows,
    topFreshShare: freshInput ? topFresh / freshInput : 0,
    coldTurns: cold.length,
    coldFreshShare: freshInput ? coldFresh / freshInput : 0,
    gaps,
  };
}
