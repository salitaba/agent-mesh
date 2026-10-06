/**
 * The Help panel said "curule console <file> opens this console parked: nothing runs on its own until you press Continue." A
 * freshly opened mission offers Start mission (Continue appears only once a mission has run), and the keys column broke "⌘K /
 * Ctrl K" across two lines. The panel is React in shell.tsx, so these read its source, and tie the buttons it names to the ones
 * the mission model actually offers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

import { describeMission, type MissionFacts } from "../../apps/mesh-dashboard/src/mission";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const shell = fs.readFileSync(path.join(SRC, "shell.tsx"), "utf8");
const css = fs.readFileSync(path.join(SRC, "styles.css"), "utf8");
const help = (() => {
  const start = shell.indexOf("function Help()");
  return shell.slice(start, shell.indexOf("\n}\n", start)).replace(/\s+/g, " ");
})();

const parked = (hasHistory: boolean): MissionFacts => ({
  hasStatus: true, serverDown: false, projectDown: null, goalStatus: "ACTIVE", parked: true, blockingDecisions: 0, seatHeldDecisions: [],
  advisoryDecisions: 0, hostCeilingTripped: false, working: 0, waiting: 0, runningSteps: 0, hasHistory, startupSeats: 2,
});

test("the tip names the button a parked console shows: Start mission, and Continue only once the mission has run", () => {
  const fresh = describeMission(parked(false)).primary?.label;
  const resumed = describeMission(parked(true)).primary?.label;
  assert.equal(fresh, "Start mission");
  assert.equal(resumed, "Continue");
  assert.match(help, new RegExp(`until you press ${fresh} \\(${resumed}, on a mission that has run before\\)`));
  assert.match(help, /curule console &lt;mesh\.yaml&gt;/, "the argument the CLI takes");
});

test("the actions it says act as the human seat are the ones the console offers", () => {
  assert.match(help, /Message and Approve or reject act as the <code>human<\/code> seat/);
  assert.match(shell, /label: "Approve or reject…"/, "the ⋯ menu item it refers to");
});

test("a key and its alternative stay on one line", () => {
  assert.match(css, /\.help table td:first-child, \.help kbd \{ white-space: nowrap; \}/);
  assert.match(help, /<kbd>⌘K<\/kbd> \/ <kbd>Ctrl K<\/kbd>/);
});
