import { useCallback, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { rovingTarget, tabStop } from "./roving";

/**
 * One tab stop for a long list of buttons, and the arrow keys between them.
 *
 * Put `onKeyDown` on the element that wraps the rows. Each row takes `data-rv`, `tabIndex={key === stop ? 0 : -1}` and calls
 * `setLast(key)` when it receives focus. Tab then enters the list at the row you used last, leaves it in one more press, and Up,
 * Down, Home, End and the Page keys (and j and k, as in the step drawer) move between rows. Rows hidden inside a closed fold
 * are not in the layout and are skipped.
 *
 * Where a key goes is decided in roving.ts, which node:test covers; this moves focus.
 */
export function useRoving(keys: readonly string[]): {
  stop: string | null;
  setLast: (key: string) => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void;
} {
  const [last, setLast] = useState<string | null>(null);
  const stop = tabStop(keys, last);
  const onKeyDown = useCallback((e: ReactKeyboardEvent<HTMLElement>): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement;
    // A field inside the list owns its own keys.
    if (target.closest("input, textarea, select, [contenteditable]")) return;
    const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-rv]")).filter((el) => el.offsetParent !== null);
    if (!rows.length) return;
    const at = rows.indexOf(target.closest<HTMLElement>("[data-rv]") as HTMLElement);
    const to = rovingTarget(e.key, at, rows.length);
    if (to === null) return;
    e.preventDefault();
    rows[to]!.focus();
    rows[to]!.scrollIntoView({ block: "nearest" });
  }, []);
  return { stop, setLast, onKeyDown };
}
