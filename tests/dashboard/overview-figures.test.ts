/**
 * The Overview's four figures are its index.
 *
 * Measured at 360 on a delivered mission: the hero's four cells were 148 px tall, inert, and the only way to the pages that explain
 * their numbers was the menu (Cost and Steps are not in the sidebar's first nine either) or a scroll to the page's foot. The figure
 * a person is looking at is the question they already have, so each one is now a door: the checks open the goal's own section here,
 * ran-for opens Steps, tokens open Cost, and agents open Agents. The control covers the cell — the same shape the folded evidence
 * rows took — so the press is the whole figure, and its label carries the number and the destination, because the contents of a
 * button are flattened into its name.
 *
 * Read as text; the browser that measured it is not in the suite.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), "utf8");

const hero = read("views/MissionHero.tsx");
const overview = read("views/Overview.tsx");
const css = read("views/overview.css");

test("each figure is a door, and the door is the whole cell", () => {
  assert.match(hero, /export type HeroIndex = "goal" \| "steps" \| "cost" \| "agents";/, "the four destinations are one type");
  assert.match(hero, /<button type="button" className="stat-door" aria-label=\{label\} onClick=\{\(\) => go\(to\)\}>/, "one control, named by its own label");
  for (const to of ["goal", "steps", "cost", "agents"]) {
    assert.ok(hero.includes(`to="${to}"`), `${to} is a destination`);
  }
  assert.match(css, /\.ov-hero \.stat-cell \{ position: relative; \}/, "the cell is the box the control covers");
  assert.match(css, /\.ov-hero \.stat-door \{ position: absolute; inset: 0; z-index: 1;/, "the control is the cell, not a handle at its edge");
  assert.match(css, /\.ov-hero \.stat-cell:is\(:hover, :focus-within\) \.stat-door \{ background: var\(--wash\); \}/, "the whole figure says it is a door before the press, including the number it draws over");
});

test("a figure's label carries its own number and where the press leads", () => {
  assert.match(hero, /const label = checks\.total === 0 \? "No mandatory checks declared\. Open goal checks\." : `\$\{checks\.done\} of \$\{checks\.total\} mandatory checks evidenced\. Open goal checks\.`;/, "checks say how many, then the section");
  assert.match(hero, /`\$\{clock\.ended \? "Ran for" : "Elapsed"\} \$\{dur\(clock\.ms\)\}\. See every step\.`/, "the clock says its figure, then Steps");
  assert.match(hero, /`Tokens: \$\{fmt\(tokens!\.consumed\)\} of \$\{fmt\(tokens!\.limit\)\}\. Open Cost\.`/, "tokens say how much of what, then Cost");
  assert.match(hero, /`Agents: \$\{tally\.value\} \$\{tally\.unit\}\. Open Agents\.`/, "agents say how many, then Agents");
});

test("the checks open the section here, and the other three leave for the page that owns the number", () => {
  assert.match(overview, /const openFigure = \(to: "goal" \| "steps" \| "cost" \| "agents"\): void => \{/, "one handler for the four");
  assert.match(overview, /if \(to === "goal"\) \{\s*if \(phone && !openSections\.has\("ov-goal"\)\) toggleSection\("ov-goal"\);\s*jumpTo\("ov-goal"\);\s*return;\s*\}\s*setView\(to\);/, "a phone opens the closed section before it lands on it; the other three are pages");
  assert.match(overview, /go=\{openFigure\}/, "the hero is handed the handler");
});

test("forced colours keep the door as an outline, because the wash goes", () => {
  const forced = css.slice(css.indexOf("@media (forced-colors: active)"));
  assert.match(forced, /\.ov-hero \.stat-cell:is\(:hover, :focus-within\) \.stat-door \{ background: none; outline: 2px solid Highlight; outline-offset: -2px; \}/, "the system's colours drop a background; the outline stays");
});
