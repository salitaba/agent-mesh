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

/** The bodies of every media block whose condition matches (a file may open the same break twice), by balanced braces. */
function mediaBlock(source: string, condition: RegExp): string {
  const found = [...source.matchAll(/@media[^{]+\{/g)].filter((m) => condition.test(m[0]));
  assert.ok(found.length, `a media block matching ${condition} exists`);
  return found.map((m) => {
    const start = m.index! + m[0].length;
    let depth = 1;
    let i = start;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
    }
    return source.slice(start, i - 1);
  }).join("\n");
}

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

/**
 * At 320 the receipt was 673 px and the first evidence row began 55.6 px below the dock, because three things were a few pixels
 * short of a line: the one action's 212.38 px label had 210 px beside the 44 px menu (the menu took a second row), the Tokens
 * figure had 115 px for "51.0k of 2.0M" that needs 129.4 (its unit wrapped and the second row grew 28.6), and the hanging
 * "Goal" column left 213 px of a sentence that needs 225 for two lines. The narrowest phone takes the page's 12 px gutter, one
 * rung off the figure ramp, and the label as a prefix. The browser that measured it is not in this suite; the shape is pinned here.
 */
test("the narrowest phone gives the hero the page's gutter, and the goal's label is a prefix on its sentence", () => {
  const narrow = mediaBlock(css, /max-width:\s*340px/);
  assert.match(narrow, /\.ov-hero-top, \.ov-now, \.ov-note \{ padding-left: var\(--s3\); padding-right: var\(--s3\); \}/, "the hero's blocks take the page's 12 px gutter, which is what the action row and the Tokens figure needed");
  assert.match(narrow, /\.ov-hero \.stat-cell:first-child, \.ov-hero \.stat-cell:nth-child\(odd\), \.ov-hero \.stat-cell:last-child \{ padding-left: var\(--s3\); padding-right: var\(--s3\); \}/, "the figures' cells are named as heavily as the 620 rule they answer");
  assert.match(narrow, /\.ov-hero \.stat-v \{ font-size: 20px; line-height: 1\.15; \}/, "the four figures step one rung down, so each number keeps its unit beside it on one line");
  assert.match(narrow, /\.ov-goal \{ display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; line-clamp: 3; overflow: hidden; \}/, "the label runs into the sentence, and the sentence's own box keeps the three-line clamp");
  assert.match(narrow, /\.ov-goal > \.caps \{ display: inline; margin-right: var\(--s1\); \}/, "the label is a prefix, not a column");
  assert.match(hero, /<span className="caps">Goal<\/span>\{" "\}<span className="ov-goal-line">/, "and the label carries a real space, because inline it lost the grid gap that read as one");
  assert.match(narrow, /\.ov-goal-line \{ display: inline; -webkit-line-clamp: unset; line-clamp: unset; overflow: visible; \}/, "and the line span stops clamping itself, because its parent now does");
  const phone = mediaBlock(css, /max-width:\s*620px/);
  assert.match(phone, /\.ov-goal-line \{ -webkit-line-clamp: 3; line-clamp: 3; \}/, "every wider phone keeps its own clamp on the sentence's column");
  assert.match(phone, /\.ov-hero-lead > \.ov-goal \{ grid-column: 1 \/ -1; \}/, "and keeps the goal's two-column grid, which the prefix replaces at 320");
  assert.match(css, /\.ov-goal \{ margin: 0; max-width: 80ch; display: grid; grid-template-columns: auto minmax\(0, 1fr\)/, "the hanging label is still the base shape");
});

/**
 * The first evidence row is now the last thing a 320 screen reaches, and its head needed 6 px it did not have: the name wrapped to
 * "What / shipped" and the figure read "3 of 9 delive…". Two 4 px trades give it back: the head's column gap is the page head's own
 * 8, and the Show control's 4 px of side padding leaves it 48.4 × 44, still over the floor. Measured at 320: all four rows read one
 * line with their whole figures; the rows stay 53 px.
 */
test("the narrowest phone's closed row keeps its name and its figure on one line", () => {
  const narrow = mediaBlock(css, /max-width:\s*340px/);
  assert.match(narrow, /\.ov \.card\.closed \.card-head \{ column-gap: var\(--s2\); \}/, "the row's head takes the phone head's 8 px gap");
  assert.match(narrow, /\.ov \.card\.closed \.card-acts > button \{ padding-inline: var\(--s1\); \}/, "and its one control is as wide as its word and the floor need");
  assert.match(css, /\.ov \.card\.closed \.card-head \{ flex-wrap: nowrap; margin: 0; padding: 0; border: 0; \}/, "the row is still one line, not two");
  assert.match(css, /\.ov \.card\.closed \.card-acts > button::after \{ content: ""; position: absolute; inset: 0; \}/, "and the row is still the door, not a label with a handle");
});
