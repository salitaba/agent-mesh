/**
 * The Steps ledger on a phone: the filter is one button, and a reason is readable.
 *
 * At 360 px a delivered mission's ledger is 3,372 px and the page opened on 166 px of filter — the outcome chips in two
 * rows — before the first turn. The wake line under every turn was 264 px of nowrap, so 5 of 25 reasons were cut with no
 * ellipsis in reach (one held 1,728 px of text), and the quiet-run fold's names had 113 px of the 287 they needed. The
 * step drawer was the only place the full note existed, and a phone has no hover to reveal it.
 *
 * Read as text: the browser that measured the page is not part of the suite.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const read = (file: string): string => fs.readFileSync(path.join(SRC, file), "utf8");
// The phone rules live in the last, full `@media (max-width: 620px)` block; an earlier one-liner hides empty chips.
const sheet = read("views/steps.css");
const phoneAt = sheet.lastIndexOf("@media (max-width: 620px) {");
const phone = sheet.slice(phoneAt);
const desktop = sheet.slice(0, phoneAt);

test("the outcome chips fold behind one button that names the choice and its count", () => {
  const tsx = read("views/Steps.tsx");
  assert.match(tsx, /className=\{`st-facetbox\$\{filtersOpen \? " open" : ""\}`\} id="st-facets"/, "the panel is the fold and the button's target");
  assert.match(tsx, /extra="st-filters-toggle" aria-expanded=\{filtersOpen\} aria-controls="st-facets"/, "the button says whether the fold is open and what it opens");
  assert.match(tsx, /\{onFilter\.label\}/, "the button names the outcome that is on, not a generic word");
  assert.match(tsx, /onFilter\.id === "" \? visible\.length : counts\[onFilter\.id as Outcome\]/, "and its count, so folding does not hide the number");
  assert.match(phone, /\.st-filters-toggle \{ display: inline-flex/, "the button exists on a phone");
  assert.match(phone, /\.st-facetbox \{ display: none;/, "and the chips do not");
  assert.match(phone, /\.st-facetbox\.open \{ display: flex; \}/, "until it is pressed");
  assert.match(tsx, /className=\{`st-count\$\{filtered \? " on" : ""\}`\}/, "a search's 1-of-28 is still a visible fact");
  assert.match(phone, /\.st-count\.on \{ display: inline; \}/, "where the unfiltered count is the button's own");
  assert.match(desktop, /\.st-filters-toggle \{ display: none; \}/, "a desk keeps the chips in plain sight, with no button");
});

test("the quiet-run choice travels with the chips it belongs to", () => {
  const tsx = read("views/Steps.tsx");
  const facetbox = tsx.slice(tsx.indexOf('className={`st-facetbox'), tsx.indexOf('<div className="st-toolbar-right">'));
  assert.match(facetbox, /<Switch label="Collapse quiet runs"/, "the fold switch is inside the filter panel, as it is on Events");
  const toolbarRight = tsx.slice(tsx.indexOf('<div className="st-toolbar-right">'), tsx.indexOf("<HoldBar"));
  assert.doesNotMatch(toolbarRight, /<Switch/, "not beside the count, where a phone had to wrap it onto a second row");
});

test("a wake reason takes two lines on a phone and ends in an ellipsis; the fold names are whole", () => {
  assert.match(phone, /\.st-woke \{[^}]*white-space: normal;[^}]*webkit-line-clamp: 2;/, "two lines, not one 264 px line");
  assert.match(phone, /\.st-fold-head \{ flex-wrap: wrap;/, "the fold's count and cost take one line");
  assert.match(phone, /\.st-fold-who \{[^}]*flex: 1 1 100%;[^}]*white-space: normal;/, "and the names the next, whole");
});
