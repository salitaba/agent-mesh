/**
 * The payload viewer's model: which rows a JSON value shows, and where each key goes.
 *
 * A payload viewer, not a JSON pretty-printer. What it replaced was `JSON.stringify(payload, null, 2).slice(0, 3000)` inside a
 * `<details>`. Depth was invisible, so a nested plan looked like a flat one; the cut landed mid-token with no sign that anything
 * had been dropped; and copying gave the truncated text. So: containers collapse, long strings expand in place, a huge array
 * pages instead of drawing ten thousand rows, and copy always takes the whole value.
 *
 * The rows are a flat list in reading order, each carrying its depth, position and expanded state, which is exactly what the
 * WAI-ARIA tree pattern asks of a `treeitem` (`aria-level`, `aria-posinset`, `aria-setsize`, `aria-expanded`). That makes the
 * keyboard rules (`navigate`) plain functions of the rows, and a tree with ten thousand leaves one tab stop instead of one per
 * container.
 */

export type JsonKind = "object" | "array" | "string" | "number" | "boolean" | "null";

export interface TreeRow {
  /** The path from the root, JSON-pointer style: `plan/steps/0`. Unique, and the key `open` and `limits` are kept under. */
  id: string;
  /** 1-based, as `aria-level` wants it. */
  depth: number;
  /** The object key or array index. */
  label: string;
  kind: JsonKind | "more";
  /** What a scalar reads as (strings carry their quotes), or the collapsed summary of a container. */
  text: string;
  /** Containers: how many children. Long strings: how many characters. */
  size: number;
  /** Opens or closes: a container with children, or a string too long for a line. */
  expandable: boolean;
  expanded: boolean;
  parent: string | null;
  posInSet: number;
  setSize: number;
  /** A `more` row stands for this many children that are not drawn yet. */
  hidden?: number;
  /** An expanded long string: the whole text, to be set in a block under its row. */
  full?: string;
}

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const isContainer = (v: unknown): boolean => Array.isArray(v) || isObj(v);

/** A container this size or smaller opens on its own; a bigger one waits to be asked. */
export const AUTO_ROWS = 12;
/** Containers shallower than this open on their own; deeper ones start shut however small. Depth counts from 0 at the root's children. */
export const AUTO_DEPTH = 2;
/** A string longer than this, or with a line break, collapses to one line with a character count. */
export const LONG_STRING = 140;
/** Children drawn per container before a "show more" row. */
export const PAGE = 100;

export function entriesOf(v: unknown): [string, unknown][] {
  if (Array.isArray(v)) return v.map((x, i) => [String(i), x] as [string, unknown]);
  if (isObj(v)) return Object.entries(v);
  return [];
}

const escapeKey = (k: string): string => k.replace(/~/g, "~0").replace(/\//g, "~1");
const childId = (parent: string | null, key: string): string => (parent === null ? escapeKey(key) : `${parent}/${escapeKey(key)}`);

export function kindOf(v: unknown): JsonKind {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "array";
  switch (typeof v) {
    case "string": return "string";
    case "number": return "number";
    case "boolean": return "boolean";
    default: return isObj(v) ? "object" : "string";
  }
}

/** One line of a long string, with its length: enough to decide whether to open it. */
const oneLine = (s: string): string => s.slice(0, LONG_STRING).replace(/\s+/g, " ");

export const isLongString = (s: string): boolean => s.length > LONG_STRING || s.includes("\n");

/** What a collapsed container says about itself. */
export function summary(v: unknown, kids: readonly [string, unknown][]): string {
  if (Array.isArray(v)) return kids.length === 1 ? "1 item" : `${kids.length} items`;
  const names = kids.slice(0, 3).map(([k]) => k).join(", ");
  return `${names}${kids.length > 3 ? `, +${kids.length - 3}` : ""}`;
}

/** How a scalar reads. A string carries its quotes, so the string "12" and the number 12 are never the same row. */
export function scalarText(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "string") return isLongString(v) ? `"${oneLine(v)}"` : `"${v}"`;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "not a number";
  return String(v);
}

/** The ids that start open: small containers near the top. Everything else waits to be asked for. */
export function defaultOpen(value: unknown): Set<string> {
  const open = new Set<string>();
  const walk = (v: unknown, id: string | null, depth: number): void => {
    for (const [k, child] of entriesOf(v)) {
      const cid = childId(id, k);
      const kids = entriesOf(child);
      if (isContainer(child) && kids.length && depth < AUTO_DEPTH && kids.length <= AUTO_ROWS) {
        open.add(cid);
        walk(child, cid, depth + 1);
      }
    }
  };
  walk(value, null, 0);
  return open;
}

/**
 * The rows that are visible, in reading order. `open` holds the expanded ids; `limits` how many children of a container are
 * drawn (default `PAGE`), so a ten-thousand-item array costs a hundred rows until someone asks for more.
 */
export function treeRows(value: unknown, open: ReadonlySet<string>, limits: ReadonlyMap<string, number> = new Map()): TreeRow[] {
  const out: TreeRow[] = [];
  const walk = (v: unknown, parent: string | null, depth: number, limit: number): void => {
    const kids = entriesOf(v);
    const shown = kids.slice(0, limit);
    shown.forEach(([key, child], i) => {
      const id = childId(parent, key);
      const base = { id, depth, label: key, parent, posInSet: i + 1, setSize: kids.length };
      const kind = kindOf(child);
      if (isContainer(child)) {
        const sub = entriesOf(child);
        const expandable = sub.length > 0;
        const expanded = expandable && open.has(id);
        out.push({ ...base, kind, text: expandable ? (expanded ? "" : summary(child, sub)) : kind === "array" ? "empty list" : "empty", size: sub.length, expandable, expanded });
        if (expanded) walk(child, id, depth + 1, limits.get(id) ?? PAGE);
        return;
      }
      if (typeof child === "string" && isLongString(child)) {
        const expanded = open.has(id);
        out.push({ ...base, kind, text: scalarText(child), size: child.length, expandable: true, expanded, ...(expanded ? { full: child } : {}) });
        return;
      }
      out.push({ ...base, kind, text: scalarText(child), size: 0, expandable: false, expanded: false });
    });
    if (kids.length > shown.length) {
      const hidden = kids.length - shown.length;
      out.push({
        id: `${parent ?? ""}#more`, depth, label: "", kind: "more", text: `Show ${Math.min(PAGE, hidden).toLocaleString("en-US")} more of ${hidden.toLocaleString("en-US")} hidden`,
        size: hidden, expandable: false, expanded: false, parent, posInSet: shown.length + 1, setSize: kids.length, hidden,
      });
    }
  };
  walk(value, null, 1, limits.get("") ?? PAGE);
  return out;
}

/** What a key does on a row. At most one field is set. */
export interface NavResult {
  /** Move focus to this row. */
  focus?: string;
  /** Open this row. */
  expand?: string;
  /** Close this row. */
  collapse?: string;
  /** Toggle this row, or draw the next page of a `more` row. */
  activate?: string;
}

/**
 * The tree keyboard pattern (WAI-ARIA APG): Down and Up walk the visible rows; Right opens a closed row, and on an open one
 * steps into its first child; Left closes an open row, and on a closed one steps out to its parent; Home and End jump; Enter and
 * Space activate. Returns null for a key the tree does not own, so the page keeps it.
 */
export function navigate(rows: readonly TreeRow[], currentId: string | null, key: string): NavResult | null {
  if (!rows.length) return null;
  const i = currentId === null ? -1 : rows.findIndex((r) => r.id === currentId);
  const cur = i >= 0 ? rows[i]! : null;
  switch (key) {
    case "ArrowDown":
      return { focus: rows[Math.min(i + 1, rows.length - 1)]!.id };
    case "ArrowUp":
      return { focus: rows[Math.max(i - 1, 0)]!.id };
    case "Home":
      return { focus: rows[0]!.id };
    case "End":
      return { focus: rows[rows.length - 1]!.id };
    case "ArrowRight":
      if (!cur) return null;
      if (cur.expandable && !cur.expanded) return { expand: cur.id };
      if (cur.expanded && rows[i + 1]?.parent === cur.id) return { focus: rows[i + 1]!.id };
      return null;
    case "ArrowLeft":
      if (!cur) return null;
      if (cur.expandable && cur.expanded) return { collapse: cur.id };
      if (cur.parent !== null) return { focus: cur.parent };
      return null;
    case "Enter":
    case " ":
      return cur && (cur.expandable || cur.kind === "more") ? { activate: cur.id } : null;
    default:
      return null;
  }
}

/** Opens `id` if it is shut and shuts it if it is open. Returns a new set. */
export function toggled(open: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(open);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** The container a `more` row belongs to (its `parent`, with the root as ""), and the limit after drawing another page. */
export function morePage(rows: readonly TreeRow[], id: string, limits: ReadonlyMap<string, number>): Map<string, number> | null {
  const row = rows.find((r) => r.id === id);
  if (!row || row.kind !== "more") return null;
  const key = row.parent ?? "";
  const next = new Map(limits);
  next.set(key, (limits.get(key) ?? PAGE) + PAGE);
  return next;
}

/** The whole value as text, for the raw view and for copy. A value that cannot be serialised (a cycle) says so. */
export function jsonString(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return "(this payload cannot be written out as text)";
  }
}
