/**
 * What the command palette lists for a query, in what order, and when the pointer may pick a row. DOM-free, so it can be tested.
 *
 * The list was a substring test over label, keywords and id, in registration order. "age" listed "Go to Projects" (its keywords
 * say "manage") above "Go to Agents", and the Projects page, which the shell and the tab strip both register as `go.projects`,
 * was listed twice under one DOM id: React then left a row standing that matched nothing, which is why "cost" seemed to list
 * Projects above Cost. A person reads the top row as the answer and presses Enter, so the top row has to be the best one.
 */
import type { Command } from "./commands";

/** Where the query was found, best first. */
const LABEL_START = 0;
const WORD_START = 1;
const IN_LABEL = 2;
const ELSEWHERE = 3;

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

/** A word starts after anything that is not a letter or a digit, so "tech-lead" is two words and "agent: pm" ends in one. */
function startsAWord(label: string, q: string): boolean {
  for (let i = 1; i < label.length; i++) {
    if (!/[a-z0-9]/.test(label[i - 1]) && label.startsWith(q, i)) return true;
  }
  return false;
}

function rank(c: Command, q: string): number | null {
  const label = norm(c.label);
  if (label.startsWith(q)) return LABEL_START;
  if (startsAWord(label, q)) return WORD_START;
  if (label.includes(q)) return IN_LABEL;
  if (norm(`${c.keywords ?? ""} ${c.id}`).includes(q)) return ELSEWHERE;
  return null;
}

/**
 * The rows for `query`. Each id is listed once, the first registration winning. An empty query lists everything in registration
 * order. Otherwise a label that starts with the query comes first, then a label with a word that starts with it, then a label that
 * holds it anywhere, then a match in the keywords or the id; within each, registration order is kept, so rows do not reshuffle.
 */
export function paletteMatches(all: readonly Command[], query: string): Command[] {
  const seen = new Set<string>();
  const once = all.filter((c) => {
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });
  const q = norm(query);
  if (!q) return once;
  return once
    .map((c, i) => ({ c, i, r: rank(c, q) }))
    .filter((x): x is { c: Command; i: number; r: number } => x.r !== null)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.c);
}

/**
 * Whether a pointer event over the list is the pointer moving. The browser reports a row that slides under a resting pointer (the
 * list changes with every keystroke, and scrolls) as the pointer entering it, and that row used to take the selection from the
 * keyboard: with the mouse left over the list, Enter ran whatever was under it. Only a pointer that has moved since the last event
 * picks a row; the first event only says where the pointer is.
 */
export function pointerMoved(last: { x: number; y: number } | null, now: { x: number; y: number }): boolean {
  return last !== null && (last.x !== now.x || last.y !== now.y);
}
