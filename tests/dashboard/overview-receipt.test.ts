/**
 * The Overview's first screen is a delivery receipt: the verdict, the goal, one action and the four figures, with the first
 * evidence row at the fold.
 *
 * Measured at 360 on the delivered demo (before these passes): the hero was 746 px of the 683 px a phone has above its thumb dock,
 * the actions took three rows and 148 px (Open the product, Reopen with feedback, then Files, Cost and Replay), the delivered
 * note was 86 px restating the headline, and the first evidence row was at 812 px in the page — 129 px below what a thumb can see.
 * The three quiet links opened pages the dock and the figures already name. So: one action in the row and the rest behind "…",
 * the note moved to the checks it explains, and the goal across the hero's width.
 *
 * The shape is pinned here; the browser that measured it is not in this suite.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

import { heroActions, noteBelongs } from "../../apps/mesh-dashboard/src/overview-model";
import { describeMission, factsFromStatus } from "../../apps/mesh-dashboard/src/mission";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), "utf8");

const hero = read("views/MissionHero.tsx");
const overview = read("views/Overview.tsx");
const goals = read("views/GoalChecks.tsx");
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

test("the hero asks the model which actions go where, and the width the sections are drawn in decides", () => {
  assert.match(overview, /const DOCK = "\(max-width: 900px\)";/, "the break is the one the evidence folds at (2026-11-04: the sidebar still takes 232 px at 801–900)");
  assert.match(overview, /const dock = useMedia\(DOCK\);/, "asked, not guessed");
  assert.match(overview, /compact=\{dock\}/, "the hero is told");
  assert.match(hero, /const \{ row: rowNext, menu \} = heroActions\(p\.next, p\.secondary, p\.compact\);/, "one decision, from the model");
  assert.match(hero, /\{rowNext\.map\(\(n\) => <NextButton key=\{n\.action\} step=\{n\} run=\{p\.run\} \/>\)\}/, "the row is the model's row");
  assert.match(hero, /const items: MenuItem\[\] = menu\.map\(/, "and the menu is the model's menu");
});

/**
 * The finished note was a 45 px door ("Why this is done") between the receipt and the evidence, and its body was the gate's own
 * sentence — the claim the headline above it already makes. It moved to the head of Goal checks, where the checks it names are
 * listed: at 360 the hero is 543.14 → 498.14, the first evidence row 672.73 → 627.73, and the second row's 44 px head
 * (697.73–741.73) is whole above the 747 px dock, where it began 4.3 px above it. A desk gains the 57 px note row that sat under
 * its figures (324.77 → 267.77 at 1,440). The browser that measured it is not in this suite; the shape is pinned here.
 */
test("a delivered mission's note is read with its checks, not as a door under its own headline", () => {
  assert.equal(noteBelongs("done"), "checks", "the finished note goes where the checks it names are listed");
  assert.equal(noteBelongs("needs-you"), "hero", "a stopped mission still explains itself under its headline");
  assert.match(overview, /const noteAt = noteBelongs\(state\.phase\);/, "the view asks the model where the note is read");
  assert.match(overview, /note=\{noteAt === "hero" \? note : null\}/, "the hero is not given the finished note");
  assert.match(overview, /why=\{noteAt === "checks" \? note : null\}/, "Goal checks is");
  assert.match(goals, /<p>\{why\.summary\}<\/p>/, "the section shows the gate's exact sentence");
  assert.match(goals, /why\.detail\.map/, "and the line behind it, not only the sentence");
  assert.doesNotMatch(hero, /NOTE_FOLD|noteFold|Why this is done/, "no door names a sentence the page already said");
});

test("the finished note is a quiet paragraph at the head of the checks, not a row in the receipt", () => {
  assert.match(css, /\.ov-why \{ display: grid; gap: var\(--s1-5\); margin: var\(--s3\) 0 var\(--s1\); max-width: 90ch; \}/, "the note is a paragraph block");
  assert.match(css, /\.ov-why p \{ margin: 0; font-size: 14px; color: var\(--text-dim\); \}/, "quieter than the headline it explains");
  // Every phase that is not finished still keeps its note in the hero, and that door is still a thumb's height.
  assert.match(css, /\.ov \.ov-note > summary, \.ov \.ov-ad > summary \{ align-items: center; min-height: 44px;/, "the hero's own note keeps the thumb's floor");
});

test("the goal takes the hero's width on a phone, and the mark and headline keep the first row", () => {
  const phone = css.slice(css.indexOf("@media (max-width: 620px)"));
  assert.match(phone, /\.ov-hero-top \{ display: grid; grid-template-columns: auto minmax\(0, 1fr\); align-items: start; row-gap: var\(--s2\); \}/, "the hero's own grid, not the desk's flex row");
  assert.match(phone, /\.ov-hero-lead \{ display: contents; \}/, "the lead's children join it");
  assert.match(phone, /\.ov-hero-lead > \.ov-headline \{ grid-column: 1 \/ -1; grid-row: 1; \}/, "the verdict's block is the receipt's width, and shares the mark's row");
  assert.match(phone, /\.ov-hero-lead > \.ov-goal \{ grid-column: 1 \/ -1; \}/, "the goal spans the hero");
  assert.match(phone, /\.ov-acts \{ grid-column: 1 \/ -1; \}/, "and so do the actions");
  // The receipt's order is the page's grammar, and this pass moved nothing: the verdict, then the goal, then the action row.
  assert.ok(hero.indexOf("ov-headline") < hero.indexOf("ov-goal") && hero.indexOf("ov-goal") < hero.indexOf("ov-acts"), "verdict, goal, actions, in that order");
});

/**
 * The verdict's second sentence is the receipt's line, not the lead's column. It needs 269.33 px at 16 px, and the lead beside the
 * mark has 242 at 360 (302 of content − the mark and its 12 px gap), so it took two lines from 320 to 387 and the receipt carried
 * 22.39 px more than the same receipt at 388, where the sentence finally fitted. The headline's block spans the receipt instead —
 * its word keeps the mark's column by a 52 px inset, and the sentence stretches across the block (302 at 360, 270 at 320, where the
 * demo's 269.33 is one line) — and the mark steps 48 → 40, the kit's base tile, because a 48 px tile stands 11 px into that first
 * line, which now starts at the receipt's edge. Measured at 360: the hero 565.53 → 543.14, the first evidence row 695.13 →
 * 672.73, its 44 px head 677.73–721.73 in the 747 px dock (25.3 px clear, the row's end 21.3 above it); 388, 390, 398, 620, 768 and
 * 1,440 do not move. The browser that measured it is not in this suite; the shape is pinned here.
 */
test("the verdict's second sentence takes the receipt's width, so it is one line from 320 up", () => {
  const phone = mediaBlock(css, /max-width:\s*620px/);
  assert.match(phone, /\.ov \.ov-hero-top > \.tile \{ grid-column: 1; grid-row: 1; width: 40px; height: 40px; border-radius: var\(--k-r-md\); \}/, "the mark is the kit's base tile, and it keeps the first row's first column");
  assert.match(phone, /\.ov \.ov-hero-top > \.tile > \.icon \{ width: 20px; height: 20px; \}/, "with the base tile's 20 px glyph, so its weight matches its box");
  assert.match(phone, /\.ov-hero-lead > \.ov-headline > b \{ margin-left: calc\(40px \+ var\(--s3\)\); \}/, "the headline's word keeps the mark's column by its own inset");
  assert.match(phone, /\.ov-hero-lead > \.ov-headline > b\.long \{ min-height: 40px; \}/, "a long lead is as tall as the mark, so its sentence still starts under the tile");
  assert.match(hero, /\{rest \? <> <span>\{rest\}<\/span><\/> : null\}/, "the sentence is still the headline's own second sentence, in the same place");
  assert.match(hero, /<span className="caps">Goal<\/span>/, "and the goal still follows it, unchanged");
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
 * figure had 115 px of content, and the hanging "Goal" column left 213 px of a sentence that needs 225 for two lines. The
 * narrowest phone takes the page's 12 px gutter and the label as a prefix. The browser that measured it is not in this suite; the
 * shape is pinned here.
 */
test("the narrowest phone gives the hero the page's gutter, and the goal's label is a prefix on its sentence", () => {
  const narrow = mediaBlock(css, /max-width:\s*340px/);
  assert.match(narrow, /\.ov-hero-top, \.ov-now, \.ov-note \{ padding-left: var\(--s3\); padding-right: var\(--s3\); \}/, "the hero's blocks take the page's 12 px gutter, which is what the action row needed");
  assert.match(narrow, /\.ov-hero \.stat-cell:first-child, \.ov-hero \.stat-cell:nth-child\(odd\), \.ov-hero \.stat-cell:last-child \{ padding-left: var\(--s3\); padding-right: var\(--s3\); \}/, "the figures' cells are named as heavily as the 620 rule they answer");
  assert.doesNotMatch(narrow, /\.ov-hero \.stat-v \{ font-size/, "no viewport break decides the figure's step any more: the strip's own width does (the next test)");
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
 * The figures take the 20 px step the 320 receipt had, and the fact that decides it is the strip's width, not the viewport's: at
 * 24 px the demo's figure is 113.31 px wide and every phone cell holds it, so the step was never a wrap it prevented — it is
 * 9.19 px of the receipt's height, which is what the first screen needs while the verdict's second sentence takes two lines (up to
 * 387). At 361 px of strip (a 180.5 px cell, 148.5 of content: 387) the step is taken; at 362 (388) the verdict is one line, the
 * receipt 552.33, and 24 is kept. One number for three layouts: the 2-up strip of a phone, the 2-up of a 620 tablet and the 4-up
 * row of a desk, where the strip is never that narrow. Measured at 360: 574.72 → 565.53, the head 709.31–753.31 → 700.13–744.13.
 */
test("the figures answer the strip they are given, and the step is one rule rather than the viewport's", () => {
  assert.match(css, /\.ov-hero \.stat-strip \{[^}]*container-type: inline-size; container-name: figures;/, "the strip is the container the figures answer");
  assert.match(css, /@container figures \(max-width: 361px\) \{\s*\.ov-hero \.stat-v \{ font-size: 20px; line-height: 1\.15; \}\s*\}/, "under 361 px of strip the four figures take the 320 receipt's step");
  assert.equal((css.match(/\.ov-hero \.stat-v \{ font-size: 20px/g) ?? []).length, 1, "one rule decides the step, so no width can be given half of it");
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

/**
 * A finished receipt says when its result is from. The figure is "Ran for 2m 36s"; its sub-line used to explain the measurement
 * ("From creation to delivery"), which the label already says, while the phone's first screen said nothing about how fresh the
 * result was. "Delivered 14m ago" is one line where the old sub took two at 360 (36 → 18 px of the receipt), and it is the fact a
 * person opening a finished mission asks first.
 */
test("a delivered receipt dates the result, and keeps the duration's label to say what it measured", () => {
  assert.match(hero, /const finishedAt = clock\.ended \? ago\(\(goal as \{ completedAt\?: string \} \| null \| undefined\)\?\.completedAt\) : "";/, "the end time is the goal's own completion, not the last poll");
  assert.match(hero, /const sub = clock\.ended\s*\? `Delivered \$\{finishedAt \|\| "at an unrecorded time"\}`/, "the sub-line says when, not how it was measured");
  assert.doesNotMatch(hero, /"From creation to delivery"/, "the measurement sentence is gone");
});

