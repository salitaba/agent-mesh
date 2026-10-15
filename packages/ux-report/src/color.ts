/**
 * Colour maths for the rendered-page report. Nothing here touches a DOM, a browser or the filesystem:
 * every value arrives as the string a browser's `getComputedStyle` would print, and every answer is a
 * number a person can check by hand. That is what makes the contrast rows unit-testable in CI, where
 * no Chromium exists.
 *
 * WCAG 2.x is the only authority used here: relative luminance (WCAG 2.x §relative luminance) and the
 * contrast ratio `(L1 + 0.05) / (L2 + 0.05)`.
 */

export type Rgba = { r: number; g: number; b: number; a: number };

/** The CSS colour keywords a computed style can still hand back. Everything else arrives as `rgb()`/`rgba()`. */
const NAMED: Record<string, string> = {
  transparent: "#00000000",
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  green: "#008000",
  blue: "#0000ff",
  gray: "#808080",
  grey: "#808080",
};

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/**
 * A colour as a browser prints it: `rgb(28, 28, 28)`, `rgba(28, 28, 28, 0.5)`, the space-separated form
 * `rgb(28 28 28 / 50%)`, a hex literal in any of its four lengths, or `transparent`. Anything else is
 * `undefined` — an unparsed colour must never be silently treated as opaque black, because that turns a
 * measurement into a guess.
 */
export function parseColor(value: string): Rgba | undefined {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return undefined;
  if (NAMED[text]) return parseColor(NAMED[text]);

  if (text.startsWith("#")) {
    const h = text.slice(1);
    const hex = (s: string): number => parseInt(s, 16);
    if (h.length === 3 || h.length === 4) {
      return { r: hex(h[0] + h[0]), g: hex(h[1] + h[1]), b: hex(h[2] + h[2]), a: h.length === 4 ? hex(h[3] + h[3]) / 255 : 1 };
    }
    if (h.length === 6 || h.length === 8) {
      return { r: hex(h.slice(0, 2)), g: hex(h.slice(2, 4)), b: hex(h.slice(4, 6)), a: h.length === 8 ? hex(h.slice(6, 8)) / 255 : 1 };
    }
    return undefined;
  }

  const fn = /^rgba?\(([^)]*)\)$/.exec(text);
  if (!fn) return undefined;
  const parts = fn[1].split(/[,\s/]+/).filter((p) => p.length > 0);
  if (parts.length < 3) return undefined;
  const channel = (token: string): number => (token.endsWith("%") ? clamp(Math.round((parseFloat(token) / 100) * 255), 0, 255) : clamp(Math.round(parseFloat(token)), 0, 255));
  const alpha = parts[3] === undefined ? 1 : parts[3].endsWith("%") ? clamp(parseFloat(parts[3]) / 100, 0, 1) : clamp(parseFloat(parts[3]), 0, 1);
  const [r, g, b] = [channel(parts[0]), channel(parts[1]), channel(parts[2])];
  if ([r, g, b, alpha].some((n) => Number.isNaN(n))) return undefined;
  return { r, g, b, a: alpha };
}

/** `#1c1c1c` when opaque, `rgba(28, 28, 28, 0.5)` when not: what the report prints. */
export function formatColor(c: Rgba): string {
  const hex = (n: number): string => clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0");
  if (c.a >= 1) return `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`;
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${Math.round(c.a * 100) / 100})`;
}

/** Parsed or not: a colour the report can print. Unparseable values are printed as they came. */
export function label(value: string): string {
  const c = parseColor(value);
  return c ? formatColor(c) : String(value ?? "").trim() || "none";
}

/** Fully transparent is the only "no background" there is; a 1%-alpha tint is still paint. */
export function isTransparent(c: Rgba | undefined): boolean {
  return !c || c.a <= 0;
}

/** `fg` composited over an opaque `bg`, in the plain source-over the browser would do. */
export function blend(fg: Rgba, bg: Rgba): Rgba {
  const a = clamp(fg.a, 0, 1);
  if (a >= 1) return { ...fg, a: 1 };
  const mix = (f: number, b: number): number => f * a + b * (1 - a);
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b), a: 1 };
}

/** WCAG relative luminance. */
export function relativeLuminance(c: Rgba): number {
  const chan = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan(c.r) + 0.7152 * chan(c.g) + 0.0722 * chan(c.b);
}

/**
 * The WCAG contrast ratio between two colours, 1..21. A translucent foreground is composited over the
 * background first, because that is what the eye is given; a translucent background is not something a
 * ratio can be computed against, and the caller (the snapshot) has already flattened it.
 */
export function contrastRatio(fg: Rgba, bg: Rgba): number {
  const f = fg.a >= 1 ? fg : blend(fg, bg);
  const [hi, lo] = [relativeLuminance(f), relativeLuminance({ ...bg, a: 1 })].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** One decimal is what a review quotes; the JSON keeps the unrounded value. */
export function roundRatio(ratio: number): number {
  return Math.round(ratio * 100) / 100;
}
