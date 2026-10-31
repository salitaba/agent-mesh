/**
 * The Overview's first screen is a delivery receipt: the verdict, the goal, one action and the four figures, with the first
 * evidence row at the fold.
 *
 * Measured at 360 on the delivered demo (before this pass): the hero was 746 px of the 683 px a phone has above its thumb dock,
 * the actions took three rows and 148 px (Open the product, Reopen with feedback, then Files, Cost and Replay), the delivered
 * note was 86 px restating the headline, and the first evidence row was at 812 px in the page — 129 px below what a thumb can see.
 * The three quiet links opened pages the dock and the figures already name. So: one action in the row and the rest behind "…",
 * the note folded into a named door, and the goal across the hero's width.
 *
 * The shape is pinned here; the browser that measured it is not in this suite.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

import { heroActions } from "../../apps/mesh-dashboard/src/overview-model";
import { describeMission, factsFromStatus } from "../../apps/mesh-dashboard/src/mission";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), "utf8");

const hero = read("views/MissionHero.tsx");
const overview = read("views/Overview.tsx");
const css = read("views/overview.css");

/** The delivered demo's own next steps and secondary actions, as `mission.ts` builds them. */
const delivered = describeMission(factsFromStatus({ goal: { status: "COMPLETED" }, agents: [] }));

test("a delivered mission's hero offers one action in its row where the navigation is a drawer", () => {
  assert.deepEqual(delivered.next.map((n) => n.action), ["product", "reopen", "files", "cost", "replay"], "the model still orders them product first");
  const compact = heroActions(delivered.next, delivered.secondary, true);
  assert.deepEqual(compact.row.map((n) => n.action), ["product"], "the one thing to do is the row");
  assert.deepEqual(compact.menu.map((n) => n.action), ["reopen", "files", "cost", "replay"], "and every other action is one press behind the menu");
  assert.deepEqual(compact.menu.map((n) => n.label), ["Reopen with feedback", "Open the files", "What it cost", "Replay"], "with the mission's own words");
});

test("a desk keeps the row it had: two that look like buttons, then the quiet result links", () => {
  const wide = heroActions(delivered.next, delivered.secondary, false);
  assert.deepEqual(wide.row.map((n) => n.action), ["product", "reopen", "files", "cost", "replay"], "every step is on the row");
  assert.deepEqual(wide.menu, [], "and nothing is left to a menu that would hold one item");
});

test("nothing is dropped and nothing is offered twice", () => {
  for (const compact of [true, false]) {
    const { row, menu } = heroActions(delivered.next, delivered.secondary, compact);
    const offered = [...row.map((n) => n.action), ...menu.map((n) => n.action)];
    const wanted = new Set([...delivered.next.map((n) => n.action), ...delivered.secondary.map((c) => c.action)]);
    assert.equal(new Set(offered).size, offered.length, `no action twice (compact: ${compact})`);
    assert.deepEqual([...offered].sort(), [...wanted].sort(), `every action survives (compact: ${compact})`);
  }
});

test("the first step keeps the row whatever its look, so a running mission still shows its Pause", () => {
  const running = describeMission(factsFromStatus({ goal: { status: "ACTIVE" }, agents: [{ id: "pm", lifecycle: "WORKING" }] }));
  assert.equal(running.next[0]!.action, "pause");
  assert.equal(running.next[0]!.look, "soft", "the pause is the quiet one, and still the one thing to do");
  const { row, menu } = heroActions(running.next, running.secondary, true);
  assert.deepEqual(row.map((n) => n.action), ["pause"], "a quiet first step is not hidden");
  assert.deepEqual(menu, [], "and is not said twice by the frame's own overflow");
});

test("a secondary action the hero already offers is not a menu item as well", () => {
  const stalled = describeMission(factsFromStatus({ goal: { status: "ACTIVE" }, agents: [{ id: "pm", lifecycle: "IDLE" }] }));
  assert.deepEqual(stalled.next.map((n) => n.action), ["agents"]);
  assert.deepEqual(stalled.secondary.map((c) => c.action), ["pause"]);
  const { row, menu } = heroActions(stalled.next, stalled.secondary, true);
  assert.deepEqual(row.map((n) => n.action), ["agents"], "the one action is the row");
  assert.deepEqual(menu.map((n) => n.action), ["pause"], "the rest is the menu");
  const running = describeMission(factsFromStatus({ goal: { status: "ACTIVE" }, agents: [{ id: "pm", lifecycle: "WORKING" }] }));
  assert.deepEqual(heroActions(running.next, running.secondary, true).menu, [], "pause is a step there, so it is not listed twice");
});

test("the hero asks the model which actions go where, and the dock's own break decides", () => {
  assert.match(overview, /const DOCK = "\(max-width: 800px\)";/, "the break is the one the navigation drawer and the dock use");
  assert.match(overview, /const dock = useMedia\(DOCK\);/, "asked, not guessed");
  assert.match(overview, /compact=\{dock\}/, "the hero is told");
  assert.match(hero, /const \{ row: rowNext, menu \} = heroActions\(p\.next, p\.secondary, p\.compact\);/, "one decision, from the model");
  assert.match(hero, /\{rowNext\.map\(\(n\) => <NextButton key=\{n\.action\} step=\{n\} run=\{p\.run\} \/>\)\}/, "the row is the model's row");
  assert.match(hero, /const items: MenuItem\[\] = menu\.map\(/, "and the menu is the model's menu");
});

test("a phone folds the delivered note into a named door, and the exact words are still there", () => {
  assert.match(hero, /const NOTE_FOLD: Partial<Record<MissionState\["phase"\], string>> = \{ done: "Why this is done" \};/, "the door says what it holds");
  assert.match(hero, /<summary>\{foldLabel \?\? note\.summary\}<\/summary>/, "the summary is the name when folded");
  assert.match(hero, /\{foldLabel \? <p>\{note\.summary\}<\/p> : null\}/, "and the verdict's own sentence is the body's first line, not dropped");
  assert.match(hero, /<Note note=\{p\.note\} foldLabel=\{p\.noteFold \? NOTE_FOLD\[state\.phase\] : undefined\} \/>/, "only a phone folds it, and only where the note has a body");
  assert.match(overview, /noteFold=\{phone\}/, "the phone is the fold's own break");
  // The map has one entry, so every other phase keeps its own sentence: only `done` says what the headline already said.
  assert.doesNotMatch(hero, /NOTE_FOLD\[state\.phase\] \?\?/, "no fallback name");
});

test("the folded note is one 44 px row, not a block with its own padding", () => {
  assert.match(css, /\.ov \.ov-note\.disc \{ padding-block: 0; \}/, "the row owns the height");
  assert.match(css, /\.ov \.ov-note\.disc > \.ov-note-body \{ padding-block: var\(--s2\) var\(--s3-5\); \}/, "and the body pads itself when it opens");
  assert.match(css, /\.ov \.ov-note > summary, \.ov \.ov-ad > summary \{ align-items: center; min-height: 44px;/, "the door keeps the thumb's floor");
});

test("the goal takes the hero's width on a phone, and the mark and headline keep the first row", () => {
  const phone = css.slice(css.indexOf("@media (max-width: 620px)"));
  assert.match(phone, /\.ov-hero-top \{ display: grid; grid-template-columns: auto minmax\(0, 1fr\); align-items: start; row-gap: var\(--s2\); \}/, "the hero's own grid, not the desk's flex row");
  assert.match(phone, /\.ov-hero-lead \{ display: contents; \}/, "the lead's two children join it");
  assert.match(phone, /\.ov-hero-lead > \.ov-headline \{ grid-column: 2; grid-row: 1; \}/, "the headline stays beside the mark");
  assert.match(phone, /\.ov-hero-lead > \.ov-goal \{ grid-column: 1 \/ -1; \}/, "the goal spans the hero");
  assert.match(phone, /\.ov-acts \{ grid-column: 1 \/ -1; \}/, "and so do the actions");
});

test("a number is data where a pointer can drag, and part of the door under a thumb", () => {
  assert.match(css, /\.ov-hero \.stat-cell \.stat-v \{ position: relative; z-index: 2; cursor: text; user-select: text;/, "the value sits above the door, selectable");
  const coarse = css.slice(css.indexOf("@media (pointer: coarse)"));
  assert.match(coarse, /\.ov-hero \.stat-cell \.stat-v \{ position: static; z-index: auto; cursor: inherit; user-select: auto;/, "a finger gets the whole cell back, with no hole in it");
  assert.match(css, /\.ov-hero \.stat-door \{ position: absolute; inset: 0; z-index: 1;/, "the door still covers the cell");
  assert.match(css, /\.ov-hero \.stat-cell:is\(:hover, :focus-within\) \.stat-door \{ background: var\(--wash\); \}/, "the whole figure lights, including the raised value");
  assert.match(css, /\.ov-hero \.stat-cell:is\(:hover, :focus-within\) \.stat-door \.icon \{ color: var\(--accent-2\); transform: translateX\(2px\); \}/, "and the chevron says where it goes");
  const forced = css.slice(css.indexOf("@media (forced-colors: active)"));
  assert.match(forced, /\.ov-hero \.stat-cell:is\(:hover, :focus-within\) \.stat-door \{ background: none; outline: 2px solid Highlight; outline-offset: -2px; \}/, "the system's colours drop a background; the outline stays");
});
