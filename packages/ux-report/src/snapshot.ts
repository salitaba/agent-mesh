/**
 * What the browser hands back after layout, as plain data.
 *
 * The shape is deliberately dumb: the collector in `tools/ux-render.mjs` fills it from
 * `getComputedStyle` and `getBoundingClientRect`, and every check in this package is a pure function of
 * it. A fixture written by hand is therefore as real an input as a page, which is how these checks run
 * in CI on a machine with no browser.
 *
 * Coordinates: `box.x` is measured from the viewport's left edge (so it answers "does this fit at 390px"),
 * `box.y` from the top of the document. Widths and heights are CSS pixels after layout — border-box, as
 * the element actually occupies the page.
 */

export type Box = { x: number; y: number; width: number; height: number };

/** top / right / bottom / left, in CSS pixels. */
export type Edges = { top: number; right: number; bottom: number; left: number };

export type BorderEdge = {
  side: "top" | "right" | "bottom" | "left";
  width: number;
  style: string;
  color: string;
};

/** The four corner radii, so a pill and a 6px card are distinguishable in the census. */
export type Radii = { topLeft: number; topRight: number; bottomRight: number; bottomLeft: number };

/** A ring the element shows once focused, measured by focusing it. `undefined` is "not measured". */
export type FocusRing = { width: number; color: string; from: "outline" | "box-shadow" } | null;

export type VisualNode = {
  /** A short selector for the element: `main > p.lead`, `#signin-token`. */
  path: string;
  tag: string;
  /** The explicit `role`, or the implicit one the tag carries (`a[href]` → link, `button` → button). */
  role?: string;
  /** The closest thing to an accessible name the element has: `aria-label`, text, `alt`, `placeholder`. */
  name?: string;
  box: Box;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  /** Resolved to pixels; `normal` is reported as the 1.2× the CSS initial value implies. */
  lineHeight: number;
  /** The element's own `color`. */
  color: string;
  /** The element's own `background-color`, which may be transparent. */
  background: string;
  /** The colour this element's content actually sits on: its own background composited over its ancestors', over the page. */
  backgroundBehind: string;
  /**
   * The colour on the *other side* of this element's edge: the same stack without the element's own
   * background. A border or a focus ring separates the element from that, so that is what a boundary is
   * measured against — a filled button whose 1px border is the same blue as its fill has a perfectly
   * visible edge, and measuring it against its own fill would report 1:1 and fail a button that is fine.
   */
  backgroundOutside: string;
  radius: Radii;
  padding: Edges;
  margin: Edges;
  borders: BorderEdge[];
  /** The element's own text (direct text children), trimmed, whitespace collapsed, truncated. */
  text?: string;
  /** A control a finger or a keyboard can reach. */
  interactive: boolean;
  /** A text-level link inside a sentence: WCAG 2.5.5 exempts these from the 44px floor, so they are reported, not failed. */
  inProse?: boolean;
  /**
   * The nearest ancestor that decides what happens to content wider than itself. `auto`/`scroll` is a
   * deliberate horizontal scroller — a wide table, which is the pattern; `hidden`/`clip` is content
   * nobody can reach. Absent means the element is bounded by the page.
   */
  scrollAncestor?: "auto" | "scroll" | "hidden" | "clip";
  /** What the element shows when focused, or `null` when it shows nothing. */
  focusRing?: FocusRing;
};

export type PageSnapshot = {
  /** The address the page was read from: an `http(s)://` URL, or a `file://` path. */
  url: string;
  /** `document.title`. */
  title: string;
  /** The part's own name: the `aria-label` of the main region, else its `h1`, else empty. */
  part?: string;
  viewport: { width: number; height: number };
  /** `document.documentElement.scrollWidth` — wider than the viewport means the page scrolls sideways. */
  scrollWidth: number;
  /** `document.documentElement.clientWidth`, i.e. the viewport minus any scrollbar. */
  clientWidth: number;
  /** Everything that was painted, in document order. */
  nodes: VisualNode[];
  /** Console errors, failed requests and uncaught exceptions seen while the page loaded. */
  errors?: string[];
  /** Set when the collector stopped early because the page had more elements than it was told to walk. */
  truncatedAt?: number;
};

/** The WCAG floors this tool enforces, in one place so a review can quote the rule it applied. */
export const TAP_MIN_PX = 44;
/** WCAG 2.1 §1.4.3: 4.5:1 for body text, 3:1 for large text. */
export const TEXT_MIN_RATIO = 4.5;
export const LARGE_TEXT_MIN_RATIO = 3;
/** Large text is ≥24px, or ≥18.66px (14pt) when bold. */
export const LARGE_TEXT_PX = 24;
export const LARGE_TEXT_BOLD_PX = 18.66;
export const BOLD_WEIGHT = 700;
/** WCAG 2.1 §1.4.11: borders, focus rings, separators, control edges. */
export const BOUNDARY_MIN_RATIO = 3;

/** The floor a run of text has to clear, given how it is set. */
export function textContrastFloor(fontSize: number, fontWeight: number): number {
  const large = fontSize >= LARGE_TEXT_PX || (fontSize >= LARGE_TEXT_BOLD_PX && fontWeight >= BOLD_WEIGHT);
  return large ? LARGE_TEXT_MIN_RATIO : TEXT_MIN_RATIO;
}

export function boxArea(box: Box): number {
  return Math.max(0, box.width) * Math.max(0, box.height);
}

/** `6px`, or `6px 0px 6px 0px` when the corners differ. */
export function radiusLabel(r: Radii): string {
  const values = [r.topLeft, r.topRight, r.bottomRight, r.bottomLeft];
  if (values.every((v) => v === values[0])) return `${values[0]}px`;
  return values.map((v) => `${v}px`).join(" ");
}

/** `8/16/8/16`, in the order a CSS shorthand reads. */
export function edgeLabel(e: Edges): string {
  const n = (v: number): string => String(Math.round(v * 100) / 100);
  return `${n(e.top)}/${n(e.right)}/${n(e.bottom)}/${n(e.left)}`;
}

/**
 * `button.primary "Sign in"`, `a#signup "Create one"` — how a row names the thing it measured. The name
 * is the last segment of the path, so a row and the box tree line it came from read as one thing.
 */
export function nodeLabel(node: VisualNode): string {
  const last = node.path.split(">").pop()?.trim() || node.tag;
  const role = node.role && node.role !== node.tag ? `${last}[role=${node.role}]` : last;
  const name = node.name ? ` "${clip(node.name, 40)}"` : node.text ? ` "${clip(node.text, 40)}"` : "";
  return `${role}${name}`;
}

export function clip(text: string, max: number): string {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`;
}
