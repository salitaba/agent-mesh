/**
 * The arithmetic behind the small charts (a sparkline, a ring) and the bars. DOM-free, so the numbers a person reads off a drawing
 * are tested, not eyeballed. How a budget is read (amber from 80%, red from 95%) is cost.ts's `budgetTone`, the one reading.
 */

/** `value / max` held to 0..1; a maximum of nothing is an empty bar, not NaN. */
export function ratioOf(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(1, Math.max(0, value / max));
}

export interface SparkGeometry {
  /** The polyline as an SVG path, "" when there is nothing to draw. */
  line: string;
  /** The same line closed down to the baseline, for the wash under it. */
  area: string;
  /** Where the last point is, for the dot that says "now". */
  last: { x: number; y: number } | null;
}

/**
 * A series as a path in a `width` x `height` box. The vertical scale is the series' own range unless `domain` is given (a
 * budget that should read against its ceiling). One point is a flat line; a flat series is a line through the middle with no wash under it, not a
 * division by zero. Values that are not finite are dropped.
 */
export function sparkGeometry(values: readonly number[], width: number, height: number, pad = 2, domain?: readonly [number, number]): SparkGeometry {
  const v = values.filter((n) => Number.isFinite(n));
  if (!v.length) return { line: "", area: "", last: null };
  const lo = domain ? domain[0] : Math.min(...v);
  const hi = domain ? domain[1] : Math.max(...v);
  const span = hi - lo;
  const innerW = Math.max(0, width - pad * 2);
  const innerH = Math.max(0, height - pad * 2);
  const x = (i: number): number => (v.length === 1 ? width / 2 : pad + (innerW * i) / (v.length - 1));
  const y = (n: number): number => (span === 0 ? height / 2 : pad + innerH - (innerH * (Math.min(hi, Math.max(lo, n)) - lo)) / span);
  const pts = v.map((n, i) => [round(x(i)), round(y(n))] as const);
  const line = pts.length === 1 ? `M${pad} ${pts[0]![1]}H${width - pad}` : pts.map(([px, py], i) => `${i === 0 ? "M" : "L"}${px} ${py}`).join("");
  const first = pts[0]![0];
  const lastPt = pts[pts.length - 1]!;
  const base = round(height - pad);
  const area = pts.length === 1 || span === 0 ? "" : `${line}L${lastPt[0]} ${base}L${first} ${base}Z`;
  return { line, area, last: { x: lastPt[0], y: lastPt[1] } };
}

export interface RingArc {
  /** stroke-dasharray: the arc's length, then the rest of the circle. */
  dash: string;
  /** stroke-dashoffset: where along the circle the arc starts. */
  offset: number;
  fraction: number;
}

/**
 * The arcs of a ring chart: each segment is its share of the circle, in order from twelve o'clock, with `gap` units cut
 * from its end so neighbours do not touch. One segment is the whole ring with no gap. `total` defaults to the sum of the
 * values; give it to draw a part of a whole (7 of 7 checks, 49k of 2M tokens).
 */
export function ringArcs(values: readonly number[], radius: number, gap = 0, total?: number): RingArc[] {
  const circumference = 2 * Math.PI * radius;
  const sum = total ?? values.reduce((a, b) => a + Math.max(0, b), 0);
  if (!(sum > 0)) return values.map(() => ({ dash: `0 ${round(circumference)}`, offset: 0, fraction: 0 }));
  const cut = values.filter((n) => n > 0).length > 1 ? gap : 0;
  let used = 0;
  return values.map((raw) => {
    const n = Math.max(0, raw);
    const fraction = Math.min(1, n / sum);
    const len = Math.max(0, fraction * circumference - (fraction > 0 ? cut : 0));
    const arc = { dash: `${round(len)} ${round(circumference - len)}`, offset: used === 0 ? 0 : round(-used), fraction };
    used += fraction * circumference;
    return arc;
  });
}

const round = (n: number): number => Math.round(n * 100) / 100;
