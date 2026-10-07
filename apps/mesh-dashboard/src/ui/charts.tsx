import type { CSSProperties, ReactNode } from "react";
import { ringArcs, sparkGeometry } from "./chart-model";

export type ChartTone = "ok" | "warn" | "bad" | "info" | "muted";

/**
 * A series drawn small: a 1.5px line, a 14% wash under it and a dot where it is now. It is for activity over a short window
 * beside a figure, never the only place the figure is. The geometry is chart-model.ts's. `label` is required, it is the name
 * and the <title>: "Tokens per minute, last 30 minutes". `domain` fixes the scale (read a spend against its ceiling) and
 * `end` drops the dot. Colour is the one `tone` (the accent when it has none), set on the chart as `currentColor`.
 */
export function Sparkline({ values, label, width = 96, height = 28, tone, domain, end = true }: {
  values: readonly number[]; label: string; width?: number; height?: number; tone?: ChartTone; domain?: readonly [number, number]; end?: boolean;
}): React.JSX.Element {
  const g = sparkGeometry(values, width, height, 2, domain);
  return (
    <svg className={`spark${tone ? ` tone-${tone}` : ""}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      <title>{label}</title>
      {g.area ? <path className="area" d={g.area} /> : null}
      {g.line ? <path className="line" d={g.line} /> : <line className="base" x1={2} y1={height / 2} x2={width - 2} y2={height / 2} />}
      {end && g.last && values.length > 1 ? <circle className="end" cx={g.last.x} cy={g.last.y} r={2.5} /> : null}
    </svg>
  );
}

export interface RingSegment { value: number; tone?: ChartTone; name?: string }

/**
 * A ring: how much of a whole is done (`value` of `max`), or what a whole is made of (`segments`, a donut). It starts at twelve
 * o'clock, its arcs animate in 300ms, and what goes in the middle is the children (a figure and a small word): the centre is
 * HTML, so it is tabular and follows the page's type. `label` names the drawing for a screen reader and is its <title>; write the
 * figures in it ("7 of 7 checks evidenced"), because a ring is never the only place they are.
 */
export function Ring({ value = 0, max = 1, segments, size = 64, stroke = 6, tone, label, round = false, children }: {
  value?: number; max?: number; segments?: readonly RingSegment[]; size?: number; stroke?: number; tone?: ChartTone; label: string; round?: boolean; children?: ReactNode;
}): React.JSX.Element {
  const r = (size - stroke) / 2;
  const parts: readonly RingSegment[] = segments ?? [{ value, tone }];
  const arcs = ringArcs(parts.map((p) => p.value), r, segments ? Math.min(stroke * 0.4, 3) : 0, segments ? undefined : max);
  const style = { "--ring-w": `${stroke}px`, width: size, height: size } as CSSProperties;
  return (
    <span className={`ring${round ? " round" : ""}`} role="img" aria-label={label} style={style}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle className="track-c" cx={size / 2} cy={size / 2} r={r} />
        {parts.map((p, i) => (
          <circle key={i} className={`seg-c${p.tone ? ` tone-${p.tone}` : ""}`} cx={size / 2} cy={size / 2} r={r} strokeDasharray={arcs[i]!.dash} strokeDashoffset={arcs[i]!.offset} />
        ))}
      </svg>
      {children ? <span className="ring-label">{children}</span> : null}
    </span>
  );
}
