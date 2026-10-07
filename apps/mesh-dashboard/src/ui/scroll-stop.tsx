import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * A region that scrolls has to be reachable from the keyboard (WCAG 2.1.1), and one that does not scroll must not be a stop of its
 * own. This says whether the element holds more than it shows, measured again when it or anything in it is resized, so its owner can
 * give it `tabIndex={0}` exactly then (a dialog's body on a short screen, a long reader).
 */
export function useScrolls(ref: RefObject<HTMLElement | null>): boolean {
  const [scrolls, setScrolls] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = (): void => setScrolls(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => ro.disconnect();
  }, [ref]);
  return scrolls;
}
