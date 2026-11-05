/**
 * The Files page on a phone. Measured at 360 px before this change: search, a type select and two rows of status chips took
 * 202 px before the first file, and the "Latest of each name" filter sat in the page header away from the other three.
 * Events already folds its chips behind one button that counts them; Files now does the same for its non-search filters.
 * This test reads the page and stylesheet as text so the disclosure cannot be undone quietly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const tsx = fs.readFileSync(path.join(SRC, "views", "Artifacts.tsx"), "utf8");
const model = fs.readFileSync(path.join(SRC, "files.ts"), "utf8");
const css = fs.readFileSync(path.join(SRC, "views", "files.css"), "utf8");

test("a phone keeps search out and folds the other file filters behind one counted button", () => {
  assert.match(tsx, /files-filters-toggle/, "the disclosure button exists");
  assert.match(tsx, /aria-expanded=\{filtersOpen\}/, "the button says whether the panel is open");
  assert.match(tsx, /Filters\{filtersOn \? ` \(\$\{filtersOn\}\)` : ""\}/, "the button counts the filters that are on");
  assert.match(tsx, /const filtersOn = activeFilterCount\(filter\)/, "the count comes from the model, not a second arithmetic here");
  // The default "Latest of each name" is on, so counting it said (1) on arrival and offered a Clear that did nothing.
  assert.match(model, /f\.type !== ""\) \+ Number\(f\.group !== ""\) \+ Number\(f\.latestOnly !== NO_FILTER\.latestOnly\)/, "the count covers every folded filter that differs from its default");
});

test("one \"Latest of each name\" switch, with the other filters, at every width", () => {
  // It used to be drawn twice on a desk: a copy in the page header and the real one among the filters (two `.files-latest`
  // measured at 768 and 1440). Two controls for one filter is a puzzle, not an option, so the header copy is gone: the filter
  // panel already holds it in plain sight at a desk width and behind the counted button on a phone.
  const header = tsx.match(/<PageHeader[\s\S]*?\/>/)?.[0] ?? "";
  assert.ok(header, "the page has a header");
  assert.ok(!header.includes("actions"), "the header draws no second copy of the filter");
  assert.equal(tsx.split('className="files-latest"').length - 1, 1, "the switch appears once in the page");
  assert.match(tsx, /filtersOpen \? <div className="files-filters" id="files-filters">\{filterControls\}<\/div> : null/, "opening the button renders the same controls");
});

test("the phone filter block shares the search's row at 320 and 360", () => {
  // At 360 the 200 px basis plus the counted button (105 px) and the 12 px gap is 317 in 336, so the line has 19 px of
  // slack; the search then grows to 219. The old 220 px basis had 337 in 336 — under a pixel over, and a wrapped flex container
  // breaks before it shrinks, so the bar took two rows (96 px) and the first group began 52 px lower. At 320 the 200 px basis
  // left 317 in 296, so the button took a second 44 px row; the shared 170 px basis (live.css) leaves 287 in 296 and the search
  // grows to 179. The fold itself is unchanged: the panel is still one full-width column under both.
  assert.match(css, /\.files-bar \.srch \{ flex: 1 1 200px; min-width: 200px; \}/, "the search takes a 200px basis on a desk and at 360, which leaves the row room for a real button label");
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*?\.files-bar \.srch \{ max-width: none; min-width: 0; flex-basis: 170px; \}/, "on a phone the search may grow into the row it shares, and its 200 px floor gives way");
  assert.match(css, /\.files-bar \.files-filters-toggle \{ flex: none; \}/, "the button keeps its own width so the search gives way");
  assert.match(css, /\.files-filters \{[^}]*display: grid/, "the folded controls stack in one column");
  const live = fs.readFileSync(path.join(SRC, "live.css"), "utf8");
  assert.match(live, /@media \(pointer: coarse\), \(max-width: 620px\) \{[\s\S]*?\.srch \{ flex-basis: 170px; \}/, "the shared 170 px basis is what lets the button share the 320 row");
});

test("a thumb's tablet folds the same filters, and a fine pointer keeps them in plain sight", () => {
  assert.match(tsx, /const FOLD = "\(max-width: 620px\), \(max-width: 900px\) and \(pointer: coarse\)"/, "the fold predicate covers a thumb's 768 tablet");
  assert.match(tsx, /const folded = useMedia\(FOLD\)/, "the page asks that predicate");
  assert.match(css, /@media \(max-width: 900px\) and \(pointer: coarse\) \{[\s\S]*?\.files-bar \.files-filters-toggle \{ flex: none; \}/, "the button is drawn above the phone break on a thumb");
  assert.match(css, /@media \(max-width: 900px\) and \(pointer: coarse\) \{[\s\S]*?\.files-filters \{[^}]*display: grid/, "and the opened panel keeps its one-column phone shape");
});
