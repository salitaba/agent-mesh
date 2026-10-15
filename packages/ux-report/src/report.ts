/**
 * The report as text, because the seats that read it are language models: they cannot look at the PNG,
 * so the PNG is written for a human and everything the crew needs to argue about is printed as measured
 * rows. The layout is fixed-width on purpose — a column that moves is a column nobody can diff.
 */
import { clip } from "./snapshot";
import { CENSUS_LIMITS, type BoxRow, type CensusEntry, type Row, type UxReport } from "./checks";

const pad = (text: string, width: number): string => {
  const t = clip(text, width);
  return t.length >= width ? t : t + " ".repeat(width - t.length);
};
const right = (text: string, width: number): string => {
  const t = clip(text, width);
  return t.length >= width ? t : " ".repeat(width - t.length) + t;
};
const num = (n: number): string => String(Math.round(n * 100) / 100);

function rowLine(r: Row, indent = "  "): string {
  const mark = r.ok ? "PASS" : r.fatal ? "FAIL" : "note";
  return `${indent}${mark} ${r.text}`;
}

function censusLine(entries: CensusEntry[], limit: number, unit: string): string {
  if (entries.length === 0) return `  none`;
  const list = entries.map((e) => `${e.value}×${e.count}`).join(", ");
  const over = entries.length > limit ? `  ← over ${limit}` : "";
  return `  ${entries.length} distinct ${unit}: ${list}${over}`;
}

/**
 * Every element the browser laid out, one line each: the box, the computed type, the colours, the shape
 * and the four paddings and margins. This is the page as geometry — the part of a review that a
 * stylesheet cannot tell you, because it is the answer after cascade, inheritance and layout.
 */
export function renderBoxTable(boxes: BoxRow[]): string {
  const head = `  ${pad("element", 34)} ${pad("box x,y,w,h", 20)} ${pad("role", 9)} ${right("size", 6)} ${right("wt", 4)} ${right("lh", 5)}  ${pad("colour", 9)} ${pad("background", 11)} ${pad("radius", 10)} ${pad("padding t/r/b/l", 16)} ${pad("margin t/r/b/l", 16)} font`;
  const lines = [head];
  for (const b of boxes) {
    const interactive = b.interactive ? "*" : " ";
    lines.push(
      `${interactive} ${pad(b.path, 34)} ${pad(`${num(b.box.x)},${num(b.box.y)},${num(b.box.width)},${num(b.box.height)}`, 20)} ${pad(b.role ?? b.tag, 9)} ${right(num(b.fontSize), 6)} ${right(String(b.fontWeight), 4)} ${right(num(b.lineHeight), 5)}  ${pad(b.color, 9)} ${pad(b.background, 11)} ${pad(b.radius, 10)} ${pad(b.padding, 16)} ${pad(b.margin, 16)} ${clip(b.fontFamily, 30)}`,
    );
    if (b.text) lines.push(`  ${" ".repeat(34)} └ ${clip(b.text, 100)}`);
    if (b.borders !== "none") lines.push(`  ${" ".repeat(34)} └ border ${b.borders}`);
  }
  return lines.join("\n");
}

/**
 * The whole report. Order is the order of an argument: what was read, then every failure with its
 * numbers, then the geometry it was decided from, then the census that says what the page is made of.
 */
export function renderReport(report: UxReport): string {
  const p = report.page;
  const out: string[] = [];
  out.push(`ux-render — ${p.part || p.title || "(untitled page)"}`);
  out.push(`  read      ${p.source}`);
  out.push(`  title     ${p.title || "(none)"}`);
  if (p.part && p.part !== p.title) out.push(`  part      ${p.part}`);
  out.push(`  viewport  ${p.viewport.width}×${p.viewport.height} CSS px${p.scheme ? `, ${p.scheme}` : ""}`);
  out.push(`  elements  ${p.nodes} laid out${p.truncatedAt ? ` (stopped at ${p.truncatedAt})` : ""}`);
  out.push(`  scroll    document.scrollWidth ${report.scroll.documentScrollWidth}px vs viewport ${report.scroll.viewportWidth}px${report.scroll.scrolls ? " — SCROLLS SIDEWAYS" : " — fits"}`);
  out.push(`  shot      ${p.screenshot ?? "(not written)"}`);
  if (report.errors.length) {
    out.push("");
    out.push(`PAGE ERRORS (${report.errors.length})`);
    for (const e of report.errors) out.push(`  note ${e}`);
  }

  out.push("");
  out.push(`FAILURES (${report.failures.length})`);
  if (report.failures.length === 0) out.push("  none: every measured row cleared its floor");
  for (const r of report.failures) out.push(rowLine(r));

  out.push("");
  out.push(`TAP TARGETS under 44×44 (${report.tapTargets.filter((r) => !r.ok).length})`);
  if (report.tapTargets.filter((r) => !r.ok).length === 0) out.push("  none");
  for (const r of report.tapTargets.filter((r) => !r.ok)) out.push(rowLine(r));

  out.push("");
  out.push(`HORIZONTAL OVERFLOW (${report.overflow.filter((r) => !r.ok).length})`);
  for (const r of report.overflow) out.push(rowLine(r));

  out.push("");
  out.push(`CONTRAST — text (${report.contrast.text.length} pairs)`);
  if (report.contrast.text.length === 0) out.push("  no text was measured");
  for (const r of report.contrast.text) out.push(rowLine(r));

  out.push("");
  out.push(`CONTRAST — boundaries (${report.contrast.boundary.length} pairs, floor 3:1)`);
  if (report.contrast.boundary.length === 0) out.push("  no border, separator or focus ring was measured");
  for (const r of report.contrast.boundary) out.push(rowLine(r));

  out.push("");
  out.push(`FOCUS (${report.focusRing.length} controls with no ring)`);
  if (report.focusRing.length === 0) out.push("  every control showed one");
  for (const r of report.focusRing) out.push(rowLine(r));

  out.push("");
  out.push("TYPE AND SPACE CENSUS");
  out.push(censusLine(report.census.fontFamilies, CENSUS_LIMITS.fontFamilies, "font families"));
  out.push(censusLine(report.census.fontSizes, CENSUS_LIMITS.fontSizes, "font sizes"));
  out.push(censusLine(report.census.fontWeights, CENSUS_LIMITS.fontWeights, "font weights"));
  out.push(censusLine(report.census.lineHeights, CENSUS_LIMITS.lineHeights, "line heights"));
  out.push(censusLine(report.census.spacings, CENSUS_LIMITS.spacings, "spacing steps"));
  out.push(censusLine(report.census.colors, CENSUS_LIMITS.colors, "colours"));
  out.push(censusLine(report.census.radii, CENSUS_LIMITS.radii, "radii"));

  out.push("");
  out.push(`BOX TREE (${report.boxes.length} elements; * = interactive)`);
  out.push(renderBoxTable(report.boxes));

  out.push("");
  out.push(`NOTES (${report.notes.length})`);
  for (const r of report.notes) out.push(rowLine(r));

  out.push("");
  const f = report.failures.length;
  out.push(`${f} failure${f === 1 ? "" : "s"}, ${report.notes.length} note${report.notes.length === 1 ? "" : "s"} at ${p.viewport.width}×${p.viewport.height}`);
  return out.join("\n");
}

/** One line for a caller that only wants the verdict (used by the smoke test at image build time). */
export function renderSummary(report: UxReport): string {
  const p = report.page;
  return `${p.part || p.title || "(untitled)"} @ ${p.viewport.width}px: ${report.failures.length} failure(s), ${report.notes.length} note(s), ${p.nodes} elements${p.screenshot ? `, shot ${p.screenshot}` : ""}`;
}
