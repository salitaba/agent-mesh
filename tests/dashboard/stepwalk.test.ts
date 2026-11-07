import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

import { placeLabel, placeStep } from "../../apps/mesh-dashboard/src/stepwalk";

/**
 * The step view's ‹/› walker. The store loads the newest 60 steps, and the
 * walker found the open turn by id alone: a deep link to an older turn read
 * "—" with both arrows dead. A turn outside the list is now placed by when it
 * started.
 */

const LIST = [
  { turnId: "t5", startedAt: "2026-09-25T21:50:00.000Z" },
  { turnId: "t4", startedAt: "2026-09-25T21:40:00.000Z" },
  { turnId: "t3", startedAt: "2026-09-25T21:30:00.000Z" },
  { turnId: "t2", startedAt: "2026-09-25T21:20:00.000Z" },
];

test("a listed turn walks by list position, newest first", () => {
  assert.deepEqual(placeStep(LIST, "t4"), { idx: 1, newer: "t5", older: "t3", where: "listed" });
  assert.deepEqual(placeStep(LIST, "t5"), { idx: 0, newer: undefined, older: "t4", where: "listed" });
  assert.deepEqual(placeStep(LIST, "t2"), { idx: 3, newer: "t3", older: undefined, where: "listed" });
  assert.equal(placeLabel(placeStep(LIST, "t4"), LIST.length).text, "2 of 4");
});

test("a turn older than every loaded step: ‹ goes to the oldest loaded, › has nowhere to go", () => {
  const p = placeStep(LIST, "t0", "2026-09-25T20:41:50.994Z");
  assert.deepEqual(p, { idx: -1, newer: "t2", older: undefined, where: "older-than-list" });
  assert.equal(placeLabel(p, 60).text, "older than loaded");
});

test("a turn newer than every loaded step: › goes to the newest loaded", () => {
  const p = placeStep(LIST, "t9", "2026-09-25T22:00:00.000Z");
  assert.deepEqual(p, { idx: -1, newer: undefined, older: "t5", where: "newer-than-list" });
  assert.equal(placeLabel(p, 4).text, "newer than loaded");
});

test("a turn between two loaded steps goes to its nearest neighbours, whatever the list order", () => {
  const shuffled = [LIST[2]!, LIST[0]!, LIST[3]!, LIST[1]!];
  const p = placeStep(shuffled, "tx", "2026-09-25T21:35:00.000Z");
  assert.deepEqual(p, { idx: -1, newer: "t4", older: "t3", where: "between" });
  assert.equal(placeLabel(p, 4).text, "not in list");
});

test("a step that started at the same instant is neither newer nor older", () => {
  assert.deepEqual(placeStep(LIST, "tx", "2026-09-25T21:30:00.000Z"), { idx: -1, newer: "t4", older: "t2", where: "between" });
});

test("a recent window says so in the counter, not only in the title", () => {
  // The Overview holds its latest six steps and Steps holds the store's newest 28. The same turn read "1 of 6" from the
  // Overview and "1 of 28" from Steps: two numbers for one question, and the six looked like the whole run. "recent"
  // names the window; the Steps page is unchanged.
  const p = placeStep(LIST, "t4");
  assert.equal(placeLabel(p, 4).text, "2 of 4", "a full list keeps the plain position");
  assert.equal(placeLabel(p, 4, "recent").text, "2 of 4 recent", "a window says it is one");
  assert.equal(placeLabel(p, 4, "recent").title, "step 2 of the 4 recent loaded, newest first", "and the title names the same window");
});

test("the Overview's latest work asks for the recent scope; Steps and the deep link do not", () => {
  const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
  const overview = fs.readFileSync(path.join(SRC, "views", "Overview.tsx"), "utf8");
  const drawers = fs.readFileSync(path.join(SRC, "drawers.tsx"), "utf8");
  const shell = fs.readFileSync(path.join(SRC, "shell.tsx"), "utf8");
  assert.match(overview, /<StepDrawer turnId=\{t\} steps=\{steps\} scope="recent" \/>/, "the six it holds are named as recent");
  assert.doesNotMatch(overview, /<StepDrawer turnId=\{t\} steps=\{steps\} \/>/, "and not as the whole history");
  assert.doesNotMatch(drawers, /openDrawer\(<StepDrawer turnId=\{turnId\} steps=\{[^}]*\} scope="recent"/, "an agent's turn still walks the store's list");
  assert.match(shell, /<StepDrawer turnId=\{detail\.id\} steps=\{steps \|\| \[\]\} routed \/>/, "a deep link still walks the store's list");
});

test("nothing to place by: no start time yet, an empty list, or entries without times", () => {
  assert.deepEqual(placeStep(LIST, "tx"), { idx: -1, where: "unplaced" });
  assert.deepEqual(placeStep(LIST, "tx", "not a date"), { idx: -1, where: "unplaced" });
  assert.deepEqual(placeStep([], "tx", "2026-09-25T21:35:00.000Z"), { idx: -1, newer: undefined, older: undefined, where: "unplaced" });
  assert.deepEqual(placeStep([{ turnId: "t1" }], "tx", "2026-09-25T21:35:00.000Z").where, "unplaced");
  assert.equal(placeLabel({ idx: -1, where: "unplaced" }, 0).title, "no steps are loaded to walk through");
});
