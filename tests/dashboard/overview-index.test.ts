/**
 * The Overview's index and the result at a desk. The page is the longest in the console (1,913 px at 1440 on the delivered demo) and
 * the two things a person reads it for are the index and what shipped, so both are pinned here by the source that draws them:
 *
 * - The index carried four bare names and sat at 422–458 once; 600 px into the page there was no index at all, and a reader at the
 *   event log had nothing to press to get back to the result. It now carries the figure each section is read for and is pinned at the
 *   board's 1280, where it is one line (985 px of doors in 992). At 901–1279 it wraps to two lines, so it scrolls as before.
 * - The result's waiting files were a single column: six 44 px rows in a 1,152 px card, with a name, a type and a state and 600 px of
 *   empty row between them. The card stood 621 px and Latest work began at 1,103 — past the 900 px of a desk's first screen. Two-up
 *   they are 132 px of rows, the card is 497 and Latest work begins at 979.
 *
 * Both numbers came from the scripted demo at Delivered (507 events, 9 files, 3 delivered, 6 awaiting review), Chromium 1248, light.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), "utf8");

const overview = read("views/Overview.tsx");
const shipped = read("views/Shipped.tsx");
const css = read("views/overview.css");

/** The body of every `@media (<condition>) { … }` block in a sheet, concatenated. */
const at = (condition: RegExp): string => {
  const found = [...css.matchAll(/@media[^{]+\{/g)].filter((m) => condition.test(m[0]));
  return found.map((m) => {
    const start = m.index! + m[0].length;
    let depth = 1;
    let i = start;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
    }
    return css.slice(start, i - 1);
  }).join("\n");
};

test("the wide index says what each section holds, from the section's own figure", () => {
  // Four names say where a press goes and nothing about what is there. The counts are the ones the sections already read: the
  // shipped fraction (Shipped.tsx, one function for the row and the bar), the steps the page holds, the goal's checks, the log's size.
  assert.match(overview, /function JumpRow\(\{ figures, onOpen \}: \{/, "the row takes the figures, not a delivered flag");
  for (const [label, figure] of [["What shipped", "shipped"], ["Latest work", "work"], ["Goal checks", "checks"], ["Just happened", "events"]] as const) {
    assert.match(overview, new RegExp(`>${label} \\{figure\\(figures\\.${figure}\\)\\}<`), `${label} carries its figure`);
  }
  assert.match(overview, /shipped: delivered \? \(artsState === "ready" \? shippedFigure\(goalArts\)/, "the shipped door reads the same fraction the result is summarised by");
  assert.match(overview, /work: steps\.length \? String\(steps\.length\)/, "the work door counts the steps the page holds");
  assert.match(overview, /checks: checks\.total \? `\$\{checks\.done\}\/\$\{checks\.total\}`/, "the checks door is the goal's own fraction");
  assert.match(overview, /events: String\(status\.eventCount \?\? timeline\.length\)/, "the events door is the log's size, not the mini-feed's");
  assert.match(overview, /artsState === "error" \? "unread" : "reading"/, "a read that failed or is in flight says so rather than showing a zero");
});

test("the index is pinned at the desk's 1280 and nowhere it would wrap", () => {
  // 985 px of doors in 992 at 1280. At 1101–1279 the same row is 897 px in 813–912 and wraps to two lines: a pinned two-line bar
  // would eat 89 px of the window, so the rule is the board's break and not a width of its own.
  const desk = at(/min-width:\s*1280px/);
  assert.match(desk, /\.ov-jump \{[^}]*position: sticky;[^}]*top: 0;[^}]*z-index: var\(--z-toolbar\);[^}]*background: var\(--bg\);[^}]*border-bottom: 1px solid var\(--line\)/, "the bar is sticky, on the toolbar rung, on the page's own ground, with a hairline to read as a bar");
  assert.doesNotMatch(at(/min-width:\s*1101px/), /\.ov-jump \{[^}]*position: sticky/, "and not from 1101, where it is two lines");
  // Measured: with `top: 0` the bar sits at 84 while the view's own top is 64 — the scroller's 20 px of padding is not part of the sticky
  // area — so a strip above the bar showed the page passing under it (a pixel at y=72 over the shipped card). The shadow is that strip.
  assert.match(desk, /box-shadow: 0 calc\(var\(--s5\) \* -1\) 0 var\(--bg\);/, "the strip above the bar is painted in the ground, not left showing the page");
  assert.match(desk, /\.ov \.card \{ scroll-margin-top: calc\(var\(--s5\) \+ var\(--ov-bar-h\) \+ var\(--s2\)\); \}/, "a jump lands 8 px under the bar, not behind it (measured before: 124 in a bar of 84–137)");
});

test("the figures are drawn only where the bar is pinned, so no width pays for them", () => {
  // Measured at 1100: the figure on each door tipped the row onto a second line, 36 → 72 px and 36 px of page. The plain row is what
  // 901–1279 has always drawn, so it keeps it.
  assert.match(css, /@media \(max-width: 1279px\) \{ \.ov-jump-n \{ display: none; \} \}/, "the figures belong to the pinned bar");
  assert.match(css, /\.ov-jump-n \{[^}]*font-variant-numeric: tabular-nums;/, "a figure is a figure: tabular");
});

test("the result's waiting files are two columns at the desk's grid", () => {
  const desk = at(/min-width:\s*1101px/);
  assert.match(desk, /\.ship-list \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); column-gap: var\(--s4\); \}/, "six rows become three of two");
  assert.match(desk, /\.ship-list > li:nth-child\(2\) \{ border-top: 0; \}/, "the second column's first row drops its rule, so the two read as one ledger");
  // The delivered cards keep their own grid, and a row keeps its own shape: this is a column count, not a second row design.
  assert.doesNotMatch(desk, /\.ship-row \{/, "a row is unchanged");
});

test("the row's summary and the page's index are one fraction", () => {
  assert.match(shipped, /export function shippedFigure\(arts: readonly \{ status\?: string \}\[\]\): string \{[\s\S]*?return `\$\{arts\.filter\(\(a\) => groupOf\(a\.status\) === "delivered"\)\.length\} of \$\{arts\.length\}`;/, "the fraction is one function");
  assert.match(shipped, /export function shippedLine\(arts: readonly \{ status\?: string \}\[\]\): string \{\s*return arts\.length \? `\$\{shippedFigure\(arts\)\} delivered` : "no files";/, "the sentence is the fraction plus its word, so the closed row and the index cannot disagree");
});

test("Latest work draws every step its figure counts", () => {
  // The page asks for six steps and the work door says "6", but the section drew steps.slice(0, 5): at 1440 the sticky index read
  // "Latest work 6" over five rows, and a phone's closed row said "6 steps" before opening five. The sixth was fetched for nothing.
  assert.match(overview, /client\.api\("GET", "\/steps\?limit=6"\)/, "the page asks for six steps");
  assert.match(overview, /work: steps\.length \? String\(steps\.length\)/, "the door counts them");
  assert.match(overview, /<WorkTimeline steps=\{steps\} roleOf=\{roleOf\}/, "and the section draws all of them");
  assert.doesNotMatch(overview, /steps\.slice\(0, 5\)/, "no fetched step is dropped after it was counted");
});
