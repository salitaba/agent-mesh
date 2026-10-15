/**
 * The checks, as pure functions of a `PageSnapshot`. No browser, no IO: a fixture snapshot and a page
 * read by the real Chromium travel through exactly the same code, so what CI tests is what the crew runs.
 *
 * Three findings are fatal — a tap target under 44px, a page that scrolls sideways, a text or boundary
 * pair under its WCAG floor — and the run exits non-zero when one is present. Everything else the census
 * and the focus rings say is a note: a measurement a designer argues with, not a rule a build enforces.
 */
import {
  BOUNDARY_MIN_RATIO,
  LARGE_TEXT_BOLD_PX,
  LARGE_TEXT_PX,
  TAP_MIN_PX,
  boxArea,
  edgeLabel,
  nodeLabel,
  radiusLabel,
  textContrastFloor,
  type Box,
  type VisualNode,
  type PageSnapshot,
} from "./snapshot";
import { contrastRatio, formatColor, isTransparent, label, parseColor, roundRatio } from "./color";

export type CheckId = "tap-target" | "overflow" | "text-contrast" | "boundary-contrast" | "focus-ring";

export type Row = {
  check: CheckId;
  /** The measurement cleared its floor. */
  ok: boolean;
  /** A row that is not ok and is fatal fails the run; a row that is not ok and is a note is advice. */
  fatal: boolean;
  /** What was measured: `button "Sign in"`, `p.lead "Choose a plan"`. */
  target: string;
  /** The number and its unit: `38×30 CSS px`, `4.21:1`, `none`. */
  measured: string;
  /** What it had to clear: `44×44 CSS px`, `4.5:1`, `3:1`. */
  floor: string;
  /** The whole finding in one sentence, with the page path it applies to. */
  text: string;
  path?: string;
  /** For contrast rows: the ratio, so a caller can sort or threshold without parsing `measured`. */
  ratio?: number;
  box?: Box;
  /** How many elements share this row's measurement, when the row stands for a group of them. */
  count?: number;
  /** A few of the elements in the group, so a developer knows where to look. */
  examples?: string[];
};

const round2 = (n: number): number => Math.round(n * 100) / 100;
const size = (box: Box): string => `${round2(box.width)}×${round2(box.height)}`;
const at = (box: Box): string => `at (${Math.round(box.x)}, ${Math.round(box.y)})`;

function row(partial: Omit<Row, "text"> & { text?: string }): Row {
  const floor = partial.floor;
  const text = partial.text ?? `${partial.target} ${partial.measured}${floor ? ` (floor ${floor})` : ""}`;
  return { ...partial, text };
}

/* ------------------------------------------------------------------ tap targets */

/**
 * Every control under 44×44 CSS px, named and measured. A text-level link inside a sentence is reported
 * and not failed: WCAG 2.5.5's size floor exempts targets "in a sentence or block of text", and a tool
 * that fails every prose link is a tool the crew learns to ignore.
 */
export function tapTargetRows(snapshot: PageSnapshot, min: number = TAP_MIN_PX): Row[] {
  const rows: Row[] = [];
  for (const node of snapshot.nodes) {
    if (!node.interactive || boxArea(node.box) <= 0) continue;
    const under = node.box.width < min || node.box.height < min;
    if (!under) continue;
    const exempt = Boolean(node.inProse);
    rows.push(
      row({
        check: "tap-target",
        ok: false,
        fatal: !exempt,
        target: nodeLabel(node),
        measured: `${size(node.box)} CSS px ${at(node.box)}`,
        floor: `${min}×${min} CSS px`,
        text: exempt
          ? `${nodeLabel(node)} is ${size(node.box)} CSS px ${at(node.box)}, under the ${min}×${min} floor, but it sits inside a sentence: WCAG 2.5.5 exempts an inline link in a block of text.`
          : `${nodeLabel(node)} is ${size(node.box)} CSS px ${at(node.box)}: the tap-target floor is ${min}×${min} CSS px.`,
        path: node.path,
        box: node.box,
      }),
    );
  }
  return rows;
}

/* -------------------------------------------------------------------- overflow */

export type OverflowReport = {
  documentScrollWidth: number;
  viewportWidth: number;
  /** The viewport minus any classic scrollbar; kept for the JSON, not used for the verdict. */
  clientWidth: number;
  /** `document.scrollWidth > the viewport`: the page scrolls sideways. */
  scrolls: boolean;
  rows: Row[];
};

/**
 * Whether the document is wider than the viewport, and which elements are wider than it. An element
 * inside a deliberate horizontal scroller (`overflow-x: auto|scroll`) is the pattern, not the defect, so
 * it is a note; one clipped by `overflow: hidden` is content a person cannot reach, so it fails.
 *
 * The comparison is against the viewport width rather than `clientWidth`, because a classic scrollbar
 * makes `clientWidth` narrower than the space a page is actually laid out in — `scrollWidth` equal to
 * the viewport is a page that fits, and calling that a sideways scroll would be a false alarm.
 */
export function overflowReport(snapshot: PageSnapshot): OverflowReport {
  const width = snapshot.viewport.width;
  const rows: Row[] = [];
  const scrolls = snapshot.scrollWidth > width + 0.5;
  const scrollTarget = `${snapshot.scrollWidth}px wide, viewport ${width}px`;
  rows.push(
    row({
      check: "overflow",
      ok: !scrolls,
      fatal: true,
      target: "document",
      measured: scrollTarget,
      floor: `${width}px`,
      text: scrolls
        ? `the document is ${snapshot.scrollWidth}px wide at a ${width}px viewport: the page scrolls sideways.`
        : `the document is ${snapshot.scrollWidth}px wide at a ${width}px viewport: it does not scroll sideways.`,
    }),
  );

  for (const node of snapshot.nodes) {
    if (boxArea(node.box) <= 0) continue;
    const right = node.box.x + node.box.width;
    const past = right > width + 0.5;
    const before = node.box.x < -0.5;
    if (!past && !before) continue;
    const deliberate = node.scrollAncestor === "auto" || node.scrollAncestor === "scroll";
    const clipped = node.scrollAncestor === "hidden" || node.scrollAncestor === "clip";
    const where = past ? `reaches ${round2(right)}px` : `starts at ${round2(node.box.x)}px`;
    rows.push(
      row({
        check: "overflow",
        ok: false,
        fatal: !deliberate,
        target: nodeLabel(node),
        measured: `${size(node.box)} at x=${round2(node.box.x)}`,
        floor: `≤ ${width}px`,
        text: deliberate
          ? `${nodeLabel(node)} is wider than the ${width}px viewport (${where}) inside a horizontal scroller: that is the pattern, but the scroller has to be reachable.`
          : clipped
            ? `${nodeLabel(node)} ${where}, past the ${width}px viewport, and an ancestor clips it: that content cannot be reached.`
            : `${nodeLabel(node)} ${where}, past the ${width}px viewport.`,
        path: node.path,
        box: node.box,
      }),
    );
  }
  return { documentScrollWidth: snapshot.scrollWidth, viewportWidth: width, clientWidth: snapshot.clientWidth, scrolls, rows };
}

/* -------------------------------------------------------------------- contrast */

export type ContrastReport = { text: Row[]; boundary: Row[] };

/** `#111 on #fff at 4.5:1` — the key a group of identical pairs collapses into. */
const pairKey = (fg: string, bg: string, floor: number): string => `${fg}|${bg}|${floor}`;

/**
 * Add a measurement to a group, or merge it into the row already there. A group is as good as its worst
 * member: when a later element fails a pair the group had been passing, the failing numbers replace the
 * passing ones and the count is kept, so the row that is printed is the row that is true.
 */
function merge(map: Map<string, Row>, key: string, make: () => Row): void {
  const existing = map.get(key);
  if (!existing) {
    map.set(key, make());
    return;
  }
  const fresh = make();
  existing.count = (existing.count ?? 1) + 1;
  const examples = existing.examples ?? [];
  if (fresh.path && examples.length < 3 && !examples.includes(fresh.path)) examples.push(fresh.path);
  if (existing.ok && !fresh.ok) map.set(key, { ...fresh, count: existing.count, examples });
}

/** A pair that repeats is one row with a count: a report a person reads has to fit on a screen. */
function finalize(rows: Row[]): Row[] {
  return rows.map((r) =>
    (r.count ?? 1) > 1
      ? {
          ...r,
          target: `${r.target} ×${r.count}`,
          text: `${r.text} ${r.count} elements share this pair: ${(r.examples ?? []).slice(0, 3).join(", ")}.`,
        }
      : r,
  );
}

/**
 * Every text/background pair with its WCAG ratio, and every boundary (border, focus ring, separator)
 * against the 3:1 floor. Pairs that repeat are one row with a count, because a report a person reads has
 * to fit on a screen; the JSON keeps the first three paths as examples.
 */
export function contrastReport(snapshot: PageSnapshot): ContrastReport {
  const keyedText = new Map<string, Row>();
  const keyedBoundary = new Map<string, Row>();

  for (const node of snapshot.nodes) {
    const on = parseColor(node.backgroundBehind) ?? parseColor("#ffffff")!;
    const onLabel = formatColor(on);
    const outside = parseColor(node.backgroundOutside) ?? on;
    const outsideLabel = formatColor(outside);

    if (node.text) {
      const fg = parseColor(node.color);
      const floor = textContrastFloor(node.fontSize, node.fontWeight);
      if (fg && !isTransparent(fg)) {
        const ratio = roundRatio(contrastRatio(fg, on));
        const fgLabel = formatColor(fg);
        merge(keyedText, pairKey(fgLabel, onLabel, floor), () => {
          const ok = ratio >= floor;
          return row({
            check: "text-contrast",
            ok,
            fatal: true,
            target: `${nodeLabel(node)} — ${fgLabel} on ${onLabel}`,
            measured: `${ratio}:1`,
            floor: `${floor}:1`,
            text: `${fgLabel} on ${onLabel} is ${ratio}:1 at ${node.fontSize}px/${node.fontWeight} (${nodeLabel(node)}): the floor is ${floor}:1.`,
            path: node.path,
            ratio,
            count: 1,
            examples: [node.path],
          });
        });
      }
    }

    // One boundary per colour per element, not one per edge: a hairline box on four sides is one edge a
    // person looks at, and counting it four times would make the row a liar about how many there are.
    const edges: { what: string; color: string; width: number }[] = [];
    const byColor = new Map<string, { sides: string[]; width: number }>();
    for (const border of node.borders) {
      if (border.width <= 0 || isTransparent(parseColor(border.color))) continue;
      const seen = byColor.get(border.color) ?? { sides: [], width: border.width };
      seen.sides.push(border.side);
      byColor.set(border.color, seen);
    }
    for (const [color, { sides, width }] of byColor) {
      edges.push({ what: sides.length === 4 ? "border" : `${sides.join("/")} border`, color, width });
    }
    // A ring is a control's: a non-interactive element cannot be focused, so a ring on it is not a boundary.
    if (node.focusRing && node.interactive) edges.push({ what: "focus ring", color: node.focusRing.color, width: node.focusRing.width });

    for (const edge of edges) {
      const c = parseColor(edge.color);
      if (!c) continue;
      const ratio = roundRatio(contrastRatio(c, outside));
      const colorLabel = formatColor(c);
      merge(keyedBoundary, pairKey(colorLabel, outsideLabel, BOUNDARY_MIN_RATIO), () =>
        row({
          check: "boundary-contrast",
          ok: ratio >= BOUNDARY_MIN_RATIO,
          fatal: true,
          target: `${edge.what} ${colorLabel} on ${outsideLabel} — ${nodeLabel(node)}`,
          measured: `${ratio}:1`,
          floor: `${BOUNDARY_MIN_RATIO}:1`,
          text: `the ${edge.what} (${edge.width}px, ${colorLabel}) on ${outsideLabel} is ${ratio}:1 (${nodeLabel(node)}): the floor for a boundary is ${BOUNDARY_MIN_RATIO}:1.`,
          path: node.path,
          ratio,
          count: 1,
          examples: [node.path],
        }),
      );
    }
  }

  const byWorstFirst = (a: Row, b: Row): number => (a.ratio ?? 0) - (b.ratio ?? 0);
  return { text: finalize([...keyedText.values()]).sort(byWorstFirst), boundary: finalize([...keyedBoundary.values()]).sort(byWorstFirst) };
}

/* ------------------------------------------------------------------ focus rings */

/**
 * A control with no ring after being focused. A note, never a failure: a programmatic `focus()` does not
 * always match `:focus-visible`, so "none" here is a question for the designer, not a verdict.
 */
export function focusRingRows(snapshot: PageSnapshot): Row[] {
  const rows: Row[] = [];
  for (const node of snapshot.nodes) {
    if (!node.interactive || boxArea(node.box) <= 0) continue;
    if (node.focusRing) continue;
    rows.push(
      row({
        check: "focus-ring",
        ok: false,
        fatal: false,
        target: nodeLabel(node),
        measured: "none",
        floor: "a visible ring",
        text: `${nodeLabel(node)} shows no outline or box-shadow when focused: a keyboard user cannot see where they are.`,
        path: node.path,
        box: node.box,
      }),
    );
  }
  return rows;
}

/* ---------------------------------------------------------------------- census */

export type CensusEntry = { value: string; count: number };

export type Census = {
  fontFamilies: CensusEntry[];
  fontSizes: CensusEntry[];
  fontWeights: CensusEntry[];
  lineHeights: CensusEntry[];
  spacings: CensusEntry[];
  colors: CensusEntry[];
  radii: CensusEntry[];
  distinct: { fontFamilies: number; fontSizes: number; fontWeights: number; lineHeights: number; spacings: number; colors: number; radii: number };
};

/** Where a page stops being a system and starts being a series of decisions. Quoted in the census notes. */
export const CENSUS_LIMITS = { fontFamilies: 2, fontSizes: 6, fontWeights: 3, lineHeights: 5, spacings: 8, colors: 12, radii: 4 };

function tally(values: string[]): CensusEntry[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value, undefined, { numeric: true }));
}

/**
 * What the page is made of, counted: the distinct font sizes and weights in use, the line heights, the
 * distinct spacing steps, the colours and the radii. A page with fourteen font sizes and twenty-two
 * colours is not being decorated, it is admitting it has no scale — and this is the row that says so.
 */
export function census(snapshot: PageSnapshot): Census {
  const textNodes = snapshot.nodes.filter((n) => n.text && n.text.length > 0);
  const sizes = textNodes.map((n) => `${round2(n.fontSize)}px`);
  const weights = textNodes.map((n) => String(n.fontWeight));
  const families = textNodes.map((n) => n.fontFamily);
  const lineHeights = textNodes.map((n) => `${round2(n.lineHeight)}px`);

  const spacings: string[] = [];
  for (const n of snapshot.nodes) {
    for (const v of [n.padding.top, n.padding.right, n.padding.bottom, n.padding.left, n.margin.top, n.margin.right, n.margin.bottom, n.margin.left]) {
      if (v > 0) spacings.push(`${round2(v)}px`);
    }
  }

  const colors: string[] = [];
  for (const n of snapshot.nodes) {
    if (n.text) colors.push(label(n.color));
    if (!isTransparent(parseColor(n.background))) colors.push(label(n.background));
    for (const b of n.borders) if (b.width > 0 && !isTransparent(parseColor(b.color))) colors.push(label(b.color));
    if (n.focusRing && !isTransparent(parseColor(n.focusRing.color))) colors.push(label(n.focusRing.color));
  }

  const radii: string[] = [];
  for (const n of snapshot.nodes) {
    const values = [n.radius.topLeft, n.radius.topRight, n.radius.bottomRight, n.radius.bottomLeft];
    if (values.some((v) => v > 0)) radii.push(radiusLabel(n.radius));
  }

  const out: Census = {
    fontFamilies: tally(families),
    fontSizes: tally(sizes),
    fontWeights: tally(weights),
    lineHeights: tally(lineHeights),
    spacings: tally(spacings),
    colors: tally(colors),
    radii: tally(radii),
    distinct: { fontFamilies: 0, fontSizes: 0, fontWeights: 0, lineHeights: 0, spacings: 0, colors: 0, radii: 0 },
  };
  out.distinct = {
    fontFamilies: out.fontFamilies.length,
    fontSizes: out.fontSizes.length,
    fontWeights: out.fontWeights.length,
    lineHeights: out.lineHeights.length,
    spacings: out.spacings.length,
    colors: out.colors.length,
    radii: out.radii.length,
  };
  return out;
}

const CENSUS_ADVICE: Record<keyof typeof CENSUS_LIMITS, string> = {
  fontFamilies: "one family, at most two",
  fontSizes: "a scale of four to six steps, and nothing between them",
  fontWeights: "two weights carry hierarchy; a third has to earn its place",
  lineHeights: "one per size step",
  spacings: "one rhythm — multiples of one base step",
  colors: "one accent hue, one ink ramp, and the semantic four",
  radii: "one small radius, or none",
};

/** The census findings: a row per count that is over its limit, each naming the actual numbers. */
export function censusNotes(c: Census): Row[] {
  const rows: Row[] = [];
  const lists: Record<keyof typeof CENSUS_LIMITS, CensusEntry[]> = {
    fontFamilies: c.fontFamilies,
    fontSizes: c.fontSizes,
    fontWeights: c.fontWeights,
    lineHeights: c.lineHeights,
    spacings: c.spacings,
    colors: c.colors,
    radii: c.radii,
  };
  const nouns: Record<keyof typeof CENSUS_LIMITS, string> = {
    fontFamilies: "font families",
    fontSizes: "font sizes",
    fontWeights: "font weights",
    lineHeights: "line heights",
    spacings: "spacing steps",
    colors: "colours",
    radii: "radii",
  };
  for (const key of Object.keys(CENSUS_LIMITS) as (keyof typeof CENSUS_LIMITS)[]) {
    const limit = CENSUS_LIMITS[key];
    const entries = lists[key];
    if (entries.length <= limit) continue;
    const top = entries.slice(0, 10).map((e) => `${e.value}×${e.count}`).join(", ");
    const more = entries.length > 10 ? `, +${entries.length - 10} more` : "";
    rows.push(
      row({
        check: "text-contrast",
        ok: false,
        fatal: false,
        target: `${entries.length} ${nouns[key]}`,
        measured: `${entries.length} distinct`,
        floor: `≤ ${limit}`,
        text: `${entries.length} distinct ${nouns[key]} on this page (${top}${more}); a page wants ${CENSUS_ADVICE[key]}.`,
      }),
    );
  }
  return rows;
}

/* ----------------------------------------------------------------------- report */

export type BoxRow = {
  path: string;
  tag: string;
  role?: string;
  name?: string;
  box: Box;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
  color: string;
  background: string;
  radius: string;
  padding: string;
  margin: string;
  borders: string;
  interactive: boolean;
  text?: string;
};

export type UxReport = {
  page: {
    url: string;
    source: string;
    title: string;
    part: string;
    scheme?: string;
    screenshot?: string;
    viewport: { width: number; height: number };
    nodes: number;
    truncatedAt?: number;
  };
  scroll: OverflowReport;
  boxes: BoxRow[];
  tapTargets: Row[];
  overflow: Row[];
  contrast: ContrastReport;
  focusRing: Row[];
  census: Census;
  /** Everything measured that did not clear its floor and fails the run. */
  failures: Row[];
  /** Everything measured that is worth saying and is not a failure. */
  notes: Row[];
  errors: string[];
};

export type AnalyzeOptions = {
  /** `--file path` or `--url http://…`: printed so the report names where it read from. */
  source?: string;
  scheme?: string;
  screenshot?: string;
};

function borderLabel(node: VisualNode): string {
  if (node.borders.length === 0) return "none";
  return node.borders.map((b) => `${b.side} ${b.width}px ${label(b.color)}`).join(", ");
}

function boxRow(node: VisualNode): BoxRow {
  return {
    path: node.path,
    tag: node.tag,
    role: node.role,
    name: node.name,
    box: node.box,
    fontFamily: node.fontFamily,
    fontSize: node.fontSize,
    fontWeight: node.fontWeight,
    lineHeight: node.lineHeight,
    color: label(node.color),
    background: isTransparent(parseColor(node.background)) ? "transparent" : label(node.background),
    radius: radiusLabel(node.radius),
    padding: edgeLabel(node.padding),
    margin: edgeLabel(node.margin),
    borders: borderLabel(node),
    interactive: node.interactive,
    text: node.text,
  };
}

/** Every row the report holds, in the order a reader walks them. */
export function allRows(report: UxReport): Row[] {
  return [...report.overflow, ...report.tapTargets, ...report.contrast.text, ...report.contrast.boundary, ...report.focusRing, ...censusNotes(report.census)];
}

/** Measure a page. The only input is what the browser already computed. */
export function analyze(snapshot: PageSnapshot, options: AnalyzeOptions = {}): UxReport {
  const overflow = overflowReport(snapshot);
  const contrast = contrastReport(snapshot);
  const tapTargets = tapTargetRows(snapshot);
  const focusRing = focusRingRows(snapshot);
  const measured = census(snapshot);
  const report: UxReport = {
    page: {
      url: snapshot.url,
      source: options.source ?? snapshot.url,
      title: snapshot.title,
      part: snapshot.part ?? "",
      scheme: options.scheme,
      screenshot: options.screenshot,
      viewport: snapshot.viewport,
      nodes: snapshot.nodes.length,
      truncatedAt: snapshot.truncatedAt,
    },
    scroll: overflow,
    boxes: snapshot.nodes.map(boxRow),
    tapTargets,
    overflow: overflow.rows,
    contrast,
    focusRing,
    census: measured,
    failures: [],
    notes: [],
    errors: snapshot.errors ?? [],
  };
  const rows = allRows(report);
  report.failures = rows.filter((r) => r.fatal && !r.ok);
  report.notes = rows.filter((r) => !r.fatal && !r.ok);
  return report;
}

/** The one-line answer: what failed, or that nothing did. */
export function verdict(report: UxReport): string {
  const f = report.failures.length;
  if (f === 0) return `no failures: ${report.page.nodes} elements measured at ${report.page.viewport.width}px`;
  const byCheck = new Map<string, number>();
  for (const r of report.failures) byCheck.set(r.check, (byCheck.get(r.check) ?? 0) + 1);
  const parts = [...byCheck.entries()].map(([check, n]) => `${n} ${check}`).join(", ");
  return `${f} failure${f === 1 ? "" : "s"}: ${parts}`;
}
