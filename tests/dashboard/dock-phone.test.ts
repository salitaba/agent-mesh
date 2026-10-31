/**
 * The dock: where the navigation is a drawer (800 px and below), the five places the work lives sit at the bottom of the screen.
 *
 * Measured at 360 before this pass, from the Events page: reaching the product was the menu (one press) then a scroll through twelve
 * rows (the sheet is 914 px tall in an 800 px screen) then the Product row (one press) — two presses and a scroll, with the menu in
 * the far corner of a one-handed screen. The five places are the owner's own path — the brief, the product, what it made, what it
 * says, what it wants — and they are the same five at 320 and at 768, so a rotation relearns nothing.
 *
 * The browser that measured it is not part of the suite, so the promises are read from the source and the stylesheet the way
 * frame-phone.test.ts reads the frame's own.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const SRC = path.join(ROOT, "apps", "mesh-dashboard", "src");
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), "utf8");

const shell = read("shell.tsx");
const styles = read("styles.css");

/** The bodies of every media block whose condition matches, joined — the reader other phone tests use. */
function blocks(css: string, test: RegExp): string {
  const out: string[] = [];
  for (const m of css.matchAll(/@media[^{]+\{/g)) {
    if (!test.test(m[0])) continue;
    const open = m.index! + m[0].length;
    let depth = 1;
    let i = open;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
    }
    out.push(css.slice(open, i - 1));
  }
  assert.ok(out.length, `a block whose condition is ${test} exists`);
  return out.join("\n");
}
const narrow2 = (): string => blocks(styles, /max-width:\s*800px/);
const forced2 = (): string => blocks(styles, /forced-colors:\s*active/);

test("the five places are one list, named once, in the order the owner's day reads", () => {
  assert.match(shell, /const DOCK_VIEWS: readonly View\[\] = \["overview", "product", "artifacts", "events", "escalations"\];/, "the brief, the product, what it made, what it says, what it wants");
  assert.match(shell, /\{DOCK_VIEWS\.map\(\(v\) => \{/, "the row is drawn from that list, not a second copy of it");
  assert.match(shell, /const n = NAV_ITEMS\.find\(\(item\) => item\.view === v\)!;/, "each tab takes its name and icon from the sidebar's own item, so the two cannot drift");
});

test("the row exists only where the navigation is a drawer, and not where another bar owns the bottom", () => {
  assert.match(shell, /const showDock = narrow && !hostLevel && !isHostView\(view\) && registry === "known" && view !== "designer";/, "off-canvas navigation, a project page, a known server, and never the Designer");
  assert.match(shell, /\{showDock \? \(\s*<nav id="dock" aria-label="Where the work lives" inert=\{navModal \|\| undefined\}>/, "it is a labelled navigation, and it stands down while the menu is a layer over the page");
});

test("a tab says where you are, and its count is in its name as well as on its shoulder", () => {
  assert.match(shell, /aria-current=\{here \? "page" : undefined\}/, "the chosen place is marked, as the sidebar marks it");
  assert.match(shell, /const name = waiting > 0 \? `\$\{n\.label\}: \$\{waiting\} waiting on you` : n\.label;/, "the count is said, not only drawn");
  assert.match(shell, /\{waiting > 0 \? <em className="dock-badge" aria-hidden="true">\{waiting > 99 \? "99\+" : waiting\}<\/em> : null\}/, "the badge is decoration; the name carries the number");
  assert.match(shell, /const waiting = v === "escalations" \? inbox : 0;/, "Needs you counts what the top bar counts, decisions and tool requests");
});

test("the row is fixed at the thumb, above the page and below every layer", () => {
  const narrow = narrow2();
  assert.match(narrow, /#dock \{ position: fixed; left: 0; right: 0; bottom: 0; z-index: var\(--z-dock\);/, "a layer at the bottom edge");
  assert.match(narrow, /display: flex; align-items: stretch; padding: 0 0 env\(safe-area-inset-bottom\);/, "it stretches its five tabs and keeps the home indicator clear");
  assert.match(narrow, /\.dock-tab \{ position: relative; flex: 1 1 0; min-width: 0; min-height: 52px;/, "each tab is a fifth of the width and 52 px tall");
  assert.match(narrow, /\.dock-tab\.active::before \{ content: ""; position: absolute; left: 18%; right: 18%; top: -1px; height: 2px;/, "the chosen place wears a rule on the frame's own edge");
  assert.match(narrow, /#view \{ padding-bottom: calc\(52px \+ var\(--s3\) \+ env\(safe-area-inset-bottom\)\); \}/, "the page keeps its last row clear of the layer: a control under a bottom bar is a bug");
});

test("the Designer keeps its own bottom, and forced colours keep the chosen tab", () => {
  const narrow = narrow2();
  assert.match(narrow, /#app:has\(#view > \.ms\) #dock \{ display: none; \}/, "the save bar is that screen's last row; a dock under it would be two bars over one piece of work");
  assert.match(narrow, /#app:has\(#view > \.ms\) #view \{ padding-bottom: 0; \}/, "and its page does not reserve room for a row it does not draw");
  const forced = forced2();
  assert.match(forced, /\.dock-tab\.active \{ outline: 2px solid Highlight; outline-offset: -2px; \}/, "a background is not a signal the system's colours keep");
});
