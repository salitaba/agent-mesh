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
  // The row names itself from its own words (name, role, state, its ties). An aria-label shorter than that visible line renamed the
  // control for a screen reader and failed WCAG 2.5.3 (axe: label-content-name-mismatch, 7 rows at 390); the action is added as
  // hidden text instead, so what is read and what is written agree.
  assert.match(tsx, /className="gr-seat-ties">\{words\}<span className="sr-only"> Open details\.<\/span>/, "the row's own sentence names it");
  assert.doesNotMatch(tsx, /className="gr-seat-row"[^>]*aria-label=/, "no shorter label renames the row");
});

test("the sideways-scrolling phone drawing is gone", () => {
  assert.doesNotMatch(tsx, /gr-swipe|Scroll sideways/, "no instruction to drag the drawing");
  assert.doesNotMatch(css, /gr-swipe/, "no style for the sideways instruction");
});

/* A row said "5 messages with qa, security and 1 more." and then its figure column said "5 messages" again: the same number twice
 * in 90 px, and the sentence spent a line on it. The count is now the row's column (on the name's line, so seven seats' counts
 * can be read down one edge) and the sentence names only who the messages were with. */
test("a phone's seat row says its count once, in a column beside the name", () => {
  const words = tsx.match(/const words = [^\n]+/)?.[0] ?? "";
  assert.match(words, /"No messages yet\." : `with \$\{first\}\$\{more\}\.`/, "the sentence names the seats it exchanged messages with");
  assert.doesNotMatch(words, /toLocaleString/, "and does not print the number its column carries");
  assert.match(tsx, /className="gr-seat-n">\{ties\.count/, "the number is the row's own figure");
  assert.doesNotMatch(tsx, /className="gr-seat-n"[^>]*aria-hidden/, "the count is read out, now that no sentence says it");
  assert.match(css, /\.gr-seat-main \{[^}]*grid-template-areas:\s*"name count"/, "the count shares the name's line");
  assert.match(css, /\.gr-seat-n \{[^}]*grid-area: count/, "…as its own column");
});

test("a phone's role line is left out when the role is the seat's own name", () => {
  assert.match(tsx, /const role = roleLabel\(nd\.id, nd\.role\);/, "the row asks agents.ts whether the role is news");
  assert.match(tsx, /\{\[role, state\]\.filter\(Boolean\)\.join\(" · "\)\}/, "and prints it beside the state only when it is");
});

/* On a phone the key was a footer under the seat rows — 900 px above the links its buttons hide — and it decoded a dashed line
 * and a state ring that a phone never draws. It now sits in the card whose rows it filters and lists only the kinds those rows
 * carry; the drawing keeps its own, fuller key. */
test("on a phone the key sits with the list it filters and says only what that list draws", () => {
  assert.equal((tsx.match(/\{legend\}/g) ?? []).length, 1, "the drawing's key is drawn once, with the drawing");
  assert.ok(tsx.indexOf("gr-keyrow") > tsx.indexOf('title="Most active links"'), "the phone's key is in the card it filters");
  assert.match(tsx, /kindsKey\("Kinds of link\. Each one is a button that shows or hides its links in the list below\."\)/, "the phone's key is the kinds alone: no dashed line, no ring");
  assert.match(css, /\.gr-keyrow \{[^}]*border-bottom: 1px solid var\(--line\)/, "a hairline sets the key off from the rows under it");
});

test("the ring is still drawn where there is room and the seat rows are a phone height", () => {
  assert.match(tsx, /Card variant="graph-wrap"/, "the desktop drawing remains");
  assert.match(tsx, /phone \? \(/, "the two presentations are chosen by width");
  assert.match(css, /\.gr-seat-row \{[^}]*min-height:\s*(?:[4-9]\d|\d{3,})px/, "a seat row is a thumb target");
});
