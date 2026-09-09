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
