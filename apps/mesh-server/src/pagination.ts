/** Shared limit/offset pagination with hard caps. */
export interface Pagination {
  limit: number;
  offset: number;
}

export function parsePagination(url: URL, fallbackLimit: number, maxLimit = 200): Pagination {
  const rawLimit = url.searchParams.get("limit");
  const rawOffset = url.searchParams.get("offset") ?? url.searchParams.get("cursor");
  let limit = rawLimit === null ? fallbackLimit : Math.floor(Number(rawLimit));
  if (!Number.isFinite(limit)) limit = fallbackLimit;
  limit = Math.min(Math.max(limit, 1), maxLimit);
  let offset = rawOffset === null ? 0 : Math.floor(Number(rawOffset));
  if (!Number.isFinite(offset) || offset < 0) offset = 0;
  return { limit, offset };
}

export function paginate<T>(items: readonly T[], { limit, offset }: Pagination): { items: T[]; total: number; limit: number; offset: number; nextOffset: number | null } {
  const total = items.length;
  const sliced = items.slice(offset, offset + limit);
  const nextOffset = offset + limit < total ? offset + limit : null;
  return { items: sliced, total, limit, offset, nextOffset };
}

/** Paginate but preserve the legacy bare-array shape when no pagination params are given. */
export function paginateCompat<T>(items: readonly T[], url: URL, fallbackLimit: number, maxLimit = 200): T[] | { items: T[]; total: number; limit: number; offset: number; nextOffset: number | null } {
  const hasParams = url.searchParams.has("limit") || url.searchParams.has("offset") || url.searchParams.has("cursor");
  if (!hasParams) {
    // Legacy behavior: return the (already tail-capped) array as-is.
    return items as T[];
  }
  return paginate(items, parsePagination(url, fallbackLimit, maxLimit));
}

/**
 * Characters of serialized JSON one read-tool result may occupy.
 *
 * A row count is not a size bound, which is why this exists. `mesh_inbox`'s
 * `limit: 25` and `mesh_query_events`'s `limit: 30` are row counts, and the
 * rows are not a fixed size: measured over the live seats, those two returned
 * 47,462 and 44,611 characters, and `mesh_artifact_read` 43,701 — each one
 * riding every later call of the turn and every later turn of the session,
 * because nothing in the client clips a tool result. A tool page now carries
 * an explicit character budget instead, and says so when it has to stop.
 *
 * 8,000 characters is ~2,000 tokens. It clears every write-side answer whole
 * (send/approve/publish/wait all answer in under 700 characters) and every
 * short read, and it is small enough that a seat which pages through a whole
 * mailbox still pays less than it did for the first oversized page alone.
 */
export const TOOL_PAGE_CHARS = 8000;

/** How much of the budget the wrapper's own fields (counts, cursors, note) may eat. */
export const PAGE_ENVELOPE_CHARS = 400;

/** One page of rows plus the cursor that resumes it. */
export interface RowsPage<T> {
  rows: T[];
  /** Index to pass as the next call's `offset`; null when the list is exhausted. */
  nextOffset: number | null;
  /** Rows the whole list holds, so a reader can tell "end" from "paused". */
  total: number;
  /** True when `nextOffset` is non-null: more rows exist past this page. */
  truncated: boolean;
}

/**
 * Take as many rows from `items[offset..]` as fit in `budgetChars` of JSON.
 *
 * Always returns at least one row, so a single row larger than the whole
 * budget cannot make a list unreadable — the caller is expected to have
 * bounded its own row sizes (every read tool here slices its prose fields),
 * and a page of one oversized row is still a page that names its cursor.
 *
 * `sizeOf` is injected rather than measured with `JSON.stringify` here so a
 * caller can count a row once and reuse it, and so a test can drive the
 * boundary without building a real 8k string.
 */
export function fitRows<T>(items: readonly T[], opts: { offset: number; budgetChars: number; sizeOf: (row: T) => number }): RowsPage<T> {
  const offset = Math.max(0, Math.min(Math.floor(opts.offset) || 0, items.length));
  const budget = Math.max(1, opts.budgetChars);
  const rows: T[] = [];
  let used = 0;
  let i = offset;
  for (; i < items.length; i++) {
    const size = opts.sizeOf(items[i]!) + 1;
    if (rows.length > 0 && used + size > budget) break;
    rows.push(items[i]!);
    used += size;
  }
  const next = i;
  const truncated = next < items.length;
  return { rows, nextOffset: truncated ? next : null, total: items.length, truncated };
}

/** `JSON.stringify(row).length`, the unit `fitRows` pages in. */
export function jsonSize(row: unknown): number {
  return JSON.stringify(row)?.length ?? 0;
}

/**
 * The one line every paged read tool carries when its page is not the whole
 * answer — what was shown, what is left, and the exact argument that gets it.
 *
 * In the tool result itself, deliberately: a seat reads the result, not this
 * file, and a bound that is only visible in a schema description is a bound a
 * model will not notice until it has already drawn a conclusion from a page.
 *
 * `total` is nullable because a store that cut the tail before handing the
 * rows over genuinely does not know the match's size — `mesh_query_events`
 * reads a bounded window. "at least N" is the honest form; a number invented
 * to fill the sentence would be read as a fact.
 */
export function pageNote(tool: string, shown: number, total: number | null, resumeArg: string): string {
  const size = total === null ? `showing ${shown} rows; more remain` : `showing ${shown} of ${total}`;
  return `${tool}: ${size}. More is available — call it again with ${resumeArg}. Nothing is lost; only this page is bounded.`;
}

/** True when a read tool's payload is over budget by its own serialized size. */
export function fitsInPage(payload: unknown, budgetChars = TOOL_PAGE_CHARS): boolean {
  return jsonSize(payload) <= budgetChars + PAGE_ENVELOPE_CHARS;
}
