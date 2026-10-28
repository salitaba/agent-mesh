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

test("a phone gives the Steps strip's three figures three columns, and the share as a figure", () => {
  const phone = mediaBlock(view("steps.css"), /max-width:\s*620px/);
  assert.match(phone, /\.st-kpis \{[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/, "the figures sit in a three-column grid, which cannot outgrow the card");
  assert.match(phone, /\.st-kpis \.st-noout \{[^}]*grid-column:\s*auto/, "the share that went nowhere takes the third column, not a line of its own");
  assert.match(phone, /\.st-kpis \.st-noout \.ring \{ display: none; \}/, "the ring is not drawn where the three figures must fit");
  assert.match(phone, /\.st-kpis \.st-noout-v \{ display: block;/, "the share is written out instead, so the figure is not lost with the drawing");
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

test("a phone scans what shipped as rows, and the narrowest one puts the state under the name", () => {
  // What shipped was six cards of 126-156 px at 390: 1,150 px of the delivered demo for a summary of nine files. A phone draws them
  // as rows now (measured 390: 1,150 → 775 px for the panel, its six files 873 → 557), and the desk keeps its cards.
  const css = view("overview.css");
  const phone = mediaBlock(css, /max-width:\s*620px/);
  assert.match(phone, /\.ov-files \.fc-top \{ display: contents; \}/, "the card's top line is unpacked so its tile and its state become row cells");
  assert.match(phone, /grid-template-areas: "tile name name" "tile meta state" "path path path";/, "name, then what it is with its state at the right, then the path");
  assert.match(phone, /\.ov-files \.fc-top > \.tile \{ grid-area: tile; width: 28px; height: 28px/, "a 40 px tile belongs to a card; the row's mark is the size the seat stack uses");
  assert.match(phone, /\.ov-files \.fc-top > \.pill \{ grid-area: state; \}/, "where a file stands is a cell of its own");
  // At 360 the type is one word beside the pill: "ArchitectureDocument" measured 138 px in a 119 px meta cell and painted 19 px
  // under the state pill's background, "RequirementsDoc" 106 px in 73 px. The name breaks a word only where it cannot fit; the
  // meta does the same, so one of the six rows grows (78 → 96 px, the panel 829 → 847) and nothing overlaps.
  assert.match(
    phone,
    /\.ov-files \.fc-meta \{ grid-area: meta; align-self: start; overflow-wrap: anywhere; \}/,
    "a type wider than its cell breaks instead of running under the state",
  );
  // The loading card is not a row: three bars stacked, so the placeholders do not jump into three cells and one of them collapse.
  assert.match(phone, /\.ov-files \.fc-skel \{ grid-template-columns: minmax\(0, 1fr\); grid-template-areas: none; \}/, "the skeleton keeps the card's shape while it loads");
  assert.match(view("Shipped.tsx"), /className="card fc fc-skel"/, "and names itself, so only the placeholder takes that rule");
  // At 320 the state pill left the type 32 px — one word a line, a 140 px row for a short file. Below 340 the state takes the line.
  const narrow = mediaBlock(css, /max-width:\s*340px/);
  assert.match(narrow, /grid-template-areas: "tile name" "tile meta" "state state" "path path";/, "the narrowest phone stacks the state under the type");
  assert.match(narrow, /\.ov-files \.fc-top > \.pill \{ grid-area: state; justify-self: start;/, "and it reads down the row's left edge");
});
