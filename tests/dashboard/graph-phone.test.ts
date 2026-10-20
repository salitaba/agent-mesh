/**
 * The Graph on a phone. `docs/design-spec.md` §6b names the old behaviour as debt: "The Graph on a phone is a canvas that
 * scrolls sideways; a list of seats with their links would serve a phone better." At 360 px the running console said
 * "Scroll sideways to see every seat." and half the ring sat outside the screen. The page now draws one row per seat there.
 * This test reads the page and its stylesheet as text so the drawing cannot come back at phone width by accident.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const tsx = fs.readFileSync(path.join(SRC, "views", "Graph.tsx"), "utf8");
const css = fs.readFileSync(path.join(SRC, "views", "graph.css"), "utf8");

test("a phone gets a row per seat, each row a target that opens the seat", () => {
  assert.match(tsx, /className="gr-seat-list"/, "the phone branch renders the seat list");
  assert.match(tsx, /className="gr-seat-row"[^>]*onClick=\{\(\) => open\(nd\.id\)\}/, "the whole row opens the seat");
  assert.match(tsx, /AgentAvatar/, "the row carries the seat's avatar");
  assert.match(tsx, /aria-label=\{`\$\{nd\.id\}, \$\{state\}\. \$\{words\} Open details\.`\}/, "the row's label is its sentence, not its colour");
});

test("the sideways-scrolling phone drawing is gone", () => {
  assert.doesNotMatch(tsx, /gr-swipe|Scroll sideways/, "no instruction to drag the drawing");
  assert.doesNotMatch(css, /gr-swipe/, "no style for the sideways instruction");
});

test("the ring is still drawn where there is room and the seat rows are a phone height", () => {
  assert.match(tsx, /Card variant="graph-wrap"/, "the desktop drawing remains");
  assert.match(tsx, /phone \? \(/, "the two presentations are chosen by width");
  assert.match(css, /\.gr-seat-row \{[^}]*min-height:\s*(?:[4-9]\d|\d{3,})px/, "a seat row is a thumb target");
});
