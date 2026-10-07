import { Children, cloneElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { FocusEvent, PointerEvent, ReactElement, ReactNode } from "react";
import { createPortal } from "react-dom";
import { Kbd } from "./kbd";
import { tipPosition, type Side } from "./tooltip-pos";

/** Hover waits this long (a pointer that is only passing through should not make a label flash), focus a moment, closing a moment. */
const OPEN_DELAY = 400;
const FOCUS_DELAY = 120;
const CLOSE_DELAY = 120;
/** For this long after one tooltip closed the next opens at once, so a row of icon buttons reads as one gesture. */
const WARM_MS = 400;
let warmUntil = 0;
let dismissOpen: (() => void) | null = null;

interface Trigger {
  onPointerEnter?: (e: PointerEvent<HTMLElement>) => void;
  onPointerLeave?: (e: PointerEvent<HTMLElement>) => void;
  onPointerDown?: (e: PointerEvent<HTMLElement>) => void;
  onFocus?: (e: FocusEvent<HTMLElement>) => void;
  onBlur?: (e: FocusEvent<HTMLElement>) => void;
  "aria-describedby"?: string;
}

/**
 * A name for a control that has only a glyph, or a fuller sentence for one that has a word. It appears on hover (after 400ms) and
 * on keyboard focus, is `role="tooltip"` and described-by the control while it is up, can be pointed at without vanishing (WCAG
 * 1.4.13), goes on Escape, on scroll and when the control is pressed, and is never shown for a touch. It is drawn at the foot of
 * <body>, positioned from the control's box (tooltip-pos.ts), so no `overflow` above the control can cut it off, and it takes no
 * layout of its own: the control is cloned, not wrapped. `keys` adds the shortcut as caps.
 *
 * States: closed (the default), waiting (the delay), open, and closed again with the next one warm. Reduced motion: it appears
 * without the fade.
 */
export function Tooltip({ content, keys, side = "top", children }: { content: ReactNode; keys?: string; side?: Side; children: ReactElement<Trigger> }): React.JSX.Element {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number; side: Side } | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const tip = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const child = Children.only(children);
  const own = child.props;

  const close = useCallback(() => {
    window.clearTimeout(timer.current);
    setOpen((was) => {
      if (was) warmUntil = Date.now() + WARM_MS;
      return false;
    });
    setPos(null);
    if (dismissOpen === close) dismissOpen = null;
  }, []);

  const arm = (el: HTMLElement, delay: number): void => {
    trigger.current = el;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      if (dismissOpen && dismissOpen !== close) dismissOpen();
      dismissOpen = close;
      setOpen(true);
    }, Date.now() < warmUntil ? 0 : delay);
  };
  const leave = (): void => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(close, CLOSE_DELAY);
  };

  useLayoutEffect(() => {
    const t = trigger.current;
    const el = tip.current;
    if (!open || !t || !el) return;
    const r = t.getBoundingClientRect();
    const s = el.getBoundingClientRect();
    setPos(tipPosition({ left: r.left, top: r.top, width: r.width, height: r.height }, { width: s.width, height: s.height }, { width: window.innerWidth, height: window.innerHeight }, side));
  }, [open, content, side]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [open, close]);
  useEffect(() => () => {
    window.clearTimeout(timer.current);
    if (dismissOpen === close) dismissOpen = null;
  }, [close]);

  if (!content) return child;
  return (
    <>
      {cloneElement(child, {
        "aria-describedby": open ? id : own["aria-describedby"],
        onPointerEnter: (e: PointerEvent<HTMLElement>) => {
          own.onPointerEnter?.(e);
          if (e.pointerType !== "touch") arm(e.currentTarget, OPEN_DELAY);
        },
        onPointerLeave: (e: PointerEvent<HTMLElement>) => {
          own.onPointerLeave?.(e);
          leave();
        },
        onPointerDown: (e: PointerEvent<HTMLElement>) => {
          own.onPointerDown?.(e);
          close();
        },
        onFocus: (e: FocusEvent<HTMLElement>) => {
          own.onFocus?.(e);
          // A focus from a tap or a click is not a keyboard's: only :focus-visible gets a label.
          if (e.currentTarget.matches(":focus-visible")) arm(e.currentTarget, FOCUS_DELAY);
        },
        onBlur: (e: FocusEvent<HTMLElement>) => {
          own.onBlur?.(e);
          close();
        },
      })}
      {open
        ? createPortal(
            <div
              ref={tip}
              id={id}
              role="tooltip"
              className="tip"
              data-side={pos?.side}
              style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" }}
              onPointerEnter={() => window.clearTimeout(timer.current)}
              onPointerLeave={leave}
            >
              <span>{content}</span>
              {keys ? <Kbd keys={keys} /> : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
