/**
 * The Replay drawer's agent table on a phone.
 *
 * The drawer is the page's own width at 620 and below, and this table's four columns need 353 px. Measured on the scripted
 * demo at 320 the drawer's content was 288 px and the table 353: the layer scrolled **49 px** sideways and the last column —
 * every agent's tokens — sat off the screen. At 360 it was **9 px**. The fix is the shape the console already uses for a
 * table a phone cannot hold (the Agents ledger, 2026-11-05): one ruled row per agent, the name and its tokens first, the
 * state and its turns under them, the head kept in the accessibility tree through the sr-only pattern, and each figure
 * saying its unit where the head is not drawn.
 *
 * Read as text: the browser that measured it is not part of the suite.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const read = (file: string): string => fs.readFileSync(path.join(SRC, file), "utf8");
const tsx = read("views/ReplayDrawer.tsx");
const sheet = read("views/overview.css");
// The Replay rules are the last block in this file; useState's 620 block is not the one to read.
const phoneAt = sheet.lastIndexOf("@media (max-width: 620px) {");
const phone = sheet.slice(phoneAt);
const desk = sheet.slice(0, phoneAt);

test("each figure says its unit on a phone, and the desk's head does the naming", () => {
  assert.match(tsx, /className="mono rp-turns">\{a\.activations \?\? 0\}<span className="rp-u"> turns<\/span>/, "turns");
  assert.match(tsx, /className="mono rp-tok">\{fmt\(a\.tokensConsumed \?\? 0\)\}<span className="rp-u"> tokens<\/span>/, "tokens");
  assert.match(desk, /\.replay \.rp-u \{ display: none; \}/, "a desk keeps its head and hides the repeat");
  assert.match(phone, /\.replay \.rp-u \{ display: inline; \}/, "the stacked row draws it");
});

test("the head is not drawn but stays in the accessibility tree", () => {
  assert.doesNotMatch(desk, /\.replay \.tbl thead \{ display: none/, "the desk draws it");
  assert.doesNotMatch(phone, /\.replay \.tbl thead \{ display: none/, "and the phone hides it visually only");
  assert.match(phone, /\.replay \.tbl thead \{ position: absolute; width: 1px; height: 1px;[^}]*clip: rect\(0 0 0 0\);/, "the sr-only pattern, as the Agents ledger's stacked head");
});

test("a phone draws one ruled row per agent, not four columns in 288 px", () => {
  assert.match(phone, /\.replay \.tbl, \.replay \.tbl tbody \{ display: block; \}/);
  assert.match(phone, /\.replay \.tbl tr \{ display: grid; grid-template-columns: minmax\(0, 1fr\) auto; grid-template-areas: "agent tok" "state turns";/);
  assert.match(phone, /\.replay \.tbl \.rp-agent \{ grid-area: agent;/);
  assert.match(phone, /\.replay \.tbl \.rp-tok \{ grid-area: tok;/);
  assert.match(phone, /\.replay \.tbl \.rp-state \{ grid-area: state;/);
  assert.match(phone, /\.replay \.tbl \.rp-turns \{ grid-area: turns;/);
});

test("the drawer's own cell rule does not draw a second, split rule inside a stacked row", () => {
  // `#drawer table.tbl td` draws a 1 px top border on every cell (drawers.css). On a stacked row that border appeared across
  // each cell of the grid — two short lines inside the row instead of one under it.
  assert.match(read("views/drawers.css"), /#drawer table\.tbl td \{[^}]*border-top: 1px solid var\(--line\)/, "the drawer rule this overrides");
  assert.match(phone, /#drawer \.replay \.tbl td \{ display: block; padding: 0; border: 0; \}/, "the row is the only rule");
});
