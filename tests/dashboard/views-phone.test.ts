/**
 * Three layouts that were measured wrong in the running console, and the rules that answer them.
 *
 * At 360 px the Steps strip's three figures measured 378 px of scrollWidth inside a 302 px card, and the view itself
 * scrolled sideways (407 against 360); an agent row with controls gave its name 77 px, so "developer" read "dev…"; and
 * an Events fold row spent its width on "16:50:47 to 16:51:03" while the only word saying what pressing it does was
 * absent. At a desk width the Agents control cell gave 213 px of controls a 166 px content box.
 *
 * These read the stylesheets and the page as text, because the browser that measured them is not part of the suite.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const view = (file: string): string => fs.readFileSync(path.join(SRC, "views", file), "utf8");

/** The bodies of every media block whose condition matches (a file may open the same break twice), by balanced braces. */
function mediaBlock(css: string, condition: RegExp): string {
  const found = [...css.matchAll(/@media[^{]+\{/g)].filter((m) => condition.test(m[0]));
  assert.ok(found.length, `a media block matching ${condition} exists`);
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
}

test("a phone gives the Steps strip's three figures two columns instead of a sideways scroll", () => {
  const phone = mediaBlock(view("steps.css"), /max-width:\s*620px/);
  assert.match(phone, /\.st-kpis \{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/, "the figures sit in a two-column grid, which cannot outgrow the card");
  assert.match(phone, /\.st-kpis \.st-noout \{[^}]*grid-column:\s*1 \/ -1/, "the share that went nowhere takes the second line whole");
  assert.doesNotMatch(phone, /\.st-kpis[^{]*\{[^}]*margin-left:\s*var\(--s6\)/, "the old negative margin that pushed the third figure past the card is gone");
});

test("a phone agent row is four lines, and its name has the first one to itself", () => {
  const css = view("agents.css");
  const tablet = mediaBlock(css, /max-width:\s*900px/);
  assert.match(tablet, /grid-template-areas:\s*"who who"\s*"state tok"\s*"now now"\s*"act act"/, "who, then state and tokens, then what it is doing, then its controls");
  assert.match(tablet, /\.ag-t-who \{ grid-area: who; \}/, "the name spans the row");
  assert.match(tablet, /\.ag-t-now \{ display: block; grid-area: now; \}/, "the column hidden between 900 and 1100 comes back, because it now has a line of its own");
  assert.match(tablet, /\.ag-table \.agent-controls \{[^}]*justify-content:\s*flex-start/, "controls start at the left edge of their own line");
});

test("at a desk the Agents control column holds its two buttons' 213 px", () => {
  const css = view("agents.css");
  // Outside a media block: this is the desk width, where the five-column table is shown.
  const desk = css.replace(/@media[\s\S]*$/, "");
  assert.match(desk, /\.ag-t-act \{ width: 240px; \}/, "a 240 px column leaves 216 px of content after the cell's padding for controls that measure 213");
});

test("an Events fold says Show or Hide in words, and on a phone drops the time range", () => {
  const tsx = view("Events.tsx");
  const phone = mediaBlock(view("events.css"), /max-width:\s*620px/);
  assert.match(tsx, /evc-fold-do">\{isOpen \? "Hide" : "Show"\}/, "the fold bar names what pressing it does");
  assert.match(phone, /\.evc-fold-range \{ display: none; \}/, "the bucket heading above already says when the run happened");
  assert.match(phone, /\.evc-fold-do \{ margin-left: auto; \}/, "with the range gone, the verb keeps the right edge");
});

test("the Events agent chooser folds with the chips on a phone and is counted by the button", () => {
  const tsx = view("Events.tsx");
  const css = view("events.css");
  const phone = mediaBlock(css, /max-width:\s*620px/);
  assert.match(tsx, /<div className=\{`ev-facets\$\{filtersOpen \? " open" : ""\}`\} id="ev-facets">[\s\S]*?<Select id="ev-actor"/, "the agent is a filter, and sits inside the filter panel");
  assert.match(tsx, /filterCount = sevOn\.size \+ grpOn\.size \+ Number\(actorOn !== null\)/, "one chosen agent counts, so a filtered list never looks unfiltered");
  assert.match(css, /\.ev-facets \.sel \{ flex: none; max-width: 100%; \}/, "a desk width leaves it at its own size beside the chips");
  assert.match(phone, /\.ev-facets \.sel \{ flex: 1 1 100%; \}/, "the folded panel gives it the whole width");
});

test("a phone's figure cells are 16 px on both sides, and the hero's two-up rule does not keep its 28", () => {
  const css = view("overview.css");
  const twoUp = mediaBlock(css, /max-width:\s*1100px/);
  assert.match(twoUp, /\.ov-hero \.stat-cell:nth-child\(odd\) \{ padding-left: var\(--s6\); border-left: 0; \}/, "from 1100 down the first cell of each row lines up with the hero's own 28 px edge");
  // At (0, 2, 0) the phone rule lost to that (0, 3, 0) selector and the odd cells kept 28 px of left padding on a phone: every figure
  // in the first column lost 12 px, and at 360 the Tokens figure wrapped to "51.0k of" / "2.0M" and the strip measured 325 px for
  // four figures that need 301.
  const phone = mediaBlock(css, /max-width:\s*620px/);
  assert.match(
    phone,
    /\.ov-hero \.stat-cell:first-child, \.ov-hero \.stat-cell:nth-child\(odd\), \.ov-hero \.stat-cell:last-child \{ padding: var\(--s3-5\) var\(--s4\); \}/,
    "the phone's cells are named as heavily as the two-up rule they answer",
  );
});
