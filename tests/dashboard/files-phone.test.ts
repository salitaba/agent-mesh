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

test("the phone filter block gives the search its own row", () => {
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*?\.files-bar \.srch \{ flex: 1 0 100%; max-width: none; \}/, "the search owns the first row");
  assert.match(css, /\.files-filters \{[^}]*display: grid/, "the folded controls stack in one column");
});
