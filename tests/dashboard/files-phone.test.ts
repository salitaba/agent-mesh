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
const css = fs.readFileSync(path.join(SRC, "views", "files.css"), "utf8");

test("a phone keeps search out and folds the other file filters behind one counted button", () => {
  assert.match(tsx, /files-filters-toggle/, "the disclosure button exists");
  assert.match(tsx, /aria-expanded=\{filtersOpen\}/, "the button says whether the panel is open");
  assert.match(tsx, /Filters\{filterCount \? ` \(\$\{filterCount\}\)` : ""\}/, "the button counts the filters that are on");
  assert.match(tsx, /filterCount = Number\(filter\.type !== ""\) \+ Number\(filter\.group !== ""\) \+ Number\(filter\.latestOnly\)/, "the count covers every folded filter");
});

test("the header switch is a wide-screen action; a phone reaches it in the filter panel", () => {
  assert.match(tsx, /actions=\{!phone && loaded && arts\.length > 0 \?/, "the header switch is not shown on a phone");
  assert.match(tsx, /filtersOpen \? <div className="files-filters" id="files-filters">\{filterControls\}<\/div> : null/, "opening the button renders the same controls");
});

test("the phone filter block gives the search its own row", () => {
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*?\.files-bar \.srch \{ flex: 1 0 100%; max-width: none; \}/, "the search owns the first row");
  assert.match(css, /\.files-filters \{[^}]*display: grid/, "the folded controls stack in one column");
});
