import type { CSSProperties } from "react";
import { ratioOf } from "./chart-model";

/**
 * A block in the shape of what is coming, with a light that sweeps across it every 1.4s (still under reduced motion). Size it
 * with `w` and `h` (a number is px) to the width and height of the thing it stands for, `round` for an avatar. It is hidden from
 * assistive technology: the container says "Loading" once (role="status"), so a screen reader is not read twenty empty boxes.
 */
export function Skeleton({ w, h, round, className }: { w?: number | string; h?: number | string; round?: boolean; className?: string }): React.JSX.Element {
  return <span className={`sk${round ? " sk-round" : ""}${className ? ` ${className}` : ""}`} style={{ width: w, height: h }} aria-hidden="true" />;
}

/** Lines of text as skeleton, the last one shorter, which is how a paragraph ends. */
export function SkeletonText({ lines = 3, last = "60%" }: { lines?: number; last?: string }): React.JSX.Element {
  return (
    <span className="sk-text" aria-hidden="true">
      {Array.from({ length: lines }, (_, i) => <span key={i} className="sk sk-line" style={{ width: i === lines - 1 && lines > 1 ? last : "100%" }} />)}
    </span>
  );
}

/**
 * How much of something is used: a 6px track (8 for the one that matters on a page) and a fill that animates its width in 300ms.
 * `tone` says whether the figure is fine (default), worth a look, a fault or complete (cost.ts's budgetTone reads a
 * budget). `label` names it; put the figure beside it in words, because a bar is never the only signal.
 */
export function Progress({ value, max = 100, label, tone, size, valueText }: {
  value: number; max?: number; label: string; tone?: "ok" | "warn" | "bad"; size?: "lg"; valueText?: string;
}): React.JSX.Element {
  const ratio = ratioOf(value, max);
  return (
    <div
      className={`prog${size === "lg" ? " lg" : ""}${tone ? ` ${tone}` : ""}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={Math.min(Math.max(value, 0), max)}
      aria-valuetext={valueText}
      style={{ "--p": ratio } as CSSProperties}
    >
      <i />
    </div>
  );
}
