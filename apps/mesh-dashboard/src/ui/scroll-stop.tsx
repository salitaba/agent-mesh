import { useLayoutEffect, useRef, useState, type ComponentProps, type RefObject } from "react";

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

/**
 * A `<pre>` that scrolls takes a tab stop exactly when it holds more than it shows.
 *
 * The step drawer gives every `pre` a max-height (styles.css: `#drawer pre`), so the prompt the runtime assembled, the model's
 * output and the turn record are read by scrolling a box INSIDE the drawer's own scroll. A wheel reaches them; a keyboard did
 * not, because a `pre` with `overflow: auto` and no `tabIndex` is not a stop (WCAG 2.1.1). The dialog's body and the file reader
 * already take their stop from `useScrolls`; this is the same answer for the drawer's long bodies.
 */
export function ScrollPre({ className, children, ...rest }: ComponentProps<"pre">): React.JSX.Element {
  const ref = useRef<HTMLPreElement | null>(null);
  const scrolls = useScrolls(ref);
  return <pre ref={ref} className={className} tabIndex={scrolls ? 0 : undefined} {...rest}>{children}</pre>;
}
