/**
 * Moving through a long list with the arrow keys, as a model.
 *
 * Steps and Events are lists of up to a few hundred buttons. As plain buttons each is a tab stop, so reaching the filters or the
 * detail pane after the list meant pressing Tab a few hundred times. The list now holds one tab stop (the row you last used) and
 * the arrow keys move between rows, which is how a listbox or a file manager behaves. This file decides where a key goes; the
 * component moves focus.
 */

/** Rows a Page key moves. A screenful of dense rows is about this many. */
export const PAGE_ROWS = 10;

/**
 * The index to focus after `key`, or null when the key is not a list key (so the caller leaves it alone). `current` is -1 when
 * focus is not on a row yet. Movement stops at the ends: a list is not a ring, and wrapping from the oldest row to the newest
 * would hide that there are no more.
 *
 * `horizontal` is for a strip laid out along a time axis (the swimlanes): Right and Left then mean next and previous, as Down
 * and Up do in a column.
 */
export function rovingTarget(key: string, current: number, count: number, page = PAGE_ROWS, horizontal = false): number | null {
  if (count <= 0) return null;
  const last = count - 1;
  const at = Math.min(Math.max(current, 0), last);
  switch (key) {
    case "ArrowRight":
      if (!horizontal) return null;
      return current < 0 ? 0 : Math.min(current + 1, last);
    case "ArrowLeft":
      if (!horizontal) return null;
      return current < 0 ? 0 : Math.max(current - 1, 0);
    case "ArrowDown":
    case "j":
      return current < 0 ? 0 : Math.min(current + 1, last);
    case "ArrowUp":
    case "k":
      return current < 0 ? 0 : Math.max(current - 1, 0);
    case "PageDown":
      return Math.min(at + page, last);
    case "PageUp":
      return Math.max(at - page, 0);
    case "Home":
      return 0;
    case "End":
      return last;
    default:
      return null;
  }
}

/**
 * Which row holds the list's one tab stop: the row that last had focus while it is still in the list, otherwise the first.
 * Rows come and go as filters change and a running list grows; the tab stop must never point at a row that is not there.
 */
export function tabStop(keys: readonly string[], last: string | null): string | null {
  if (!keys.length) return null;
  return last !== null && keys.includes(last) ? last : keys[0]!;
}
