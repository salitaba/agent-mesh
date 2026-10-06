import test from "node:test";
import assert from "node:assert/strict";

import { describeMission, factsFromStatus, type MissionFacts } from "../../apps/mesh-dashboard/src/mission";
import { GOAL_PLACEHOLDER } from "../../apps/mesh-dashboard/src/goal";

/**
 * A new project's mission is parked on the placeholder goal until someone writes one, and Start was the first thing offered: a mission
 * that spends on "Describe the mission goal here." The top bar, the Overview's hero and the tab title all read describeMission, so the
 * change is made once, here, and pinned here.
 */

const facts = (over: Partial<MissionFacts> = {}): MissionFacts => ({
  hasStatus: true, serverDown: false, projectDown: null, goalStatus: "ACTIVE", parked: true, blockingDecisions: 0, seatHeldDecisions: [],
  advisoryDecisions: 0, hostCeilingTripped: false, working: 0, waiting: 1, runningSteps: 0, hasHistory: false, startupSeats: 1, ...over,
});

test("a mission that has never run, on a goal nobody wrote, is offered the goal and not Start", () => {
  const s = describeMission(facts({ goalWritten: false }));
  assert.equal(s.phase, "parked");
  assert.equal(s.label, "Parked");
  assert.deepEqual([s.primary?.action, s.primary?.label], ["designer", "Write the goal first"]);
  assert.equal(s.headline, "The goal is not written yet. Say what the team should deliver, then start the mission.");
  assert.equal(s.tone, "warn");
  assert.match(s.primary!.hint, /Designer.*every agent reads it on every turn/);
});

test("with a goal written it is Start, as ever; and a mission that has run is Continue, whatever its goal says", () => {
  assert.deepEqual([describeMission(facts({ goalWritten: true })).primary?.label, describeMission(facts({ goalWritten: true })).primary?.action], ["Start mission", "start"]);
  assert.equal(describeMission(facts({})).primary?.label, "Start mission", "a status that said nothing of the goal is not accused");
  const ran = describeMission(facts({ goalWritten: false, hasHistory: true }));
  assert.deepEqual([ran.primary?.action, ran.primary?.label], ["start", "Continue"], "it ran before: it keeps the goal it has, and Continue is not Start");
});

test("only the parked, never-run state is changed: a decision, a finished mission, a pause and a live mission read as they did", () => {
  const unwritten = { goalWritten: false };
  assert.equal(describeMission(facts({ ...unwritten, blockingDecisions: 1 })).primary?.action, "review", "a decision outranks it");
  assert.equal(describeMission(facts({ ...unwritten, goalStatus: "COMPLETED" })).phase, "done");
  assert.equal(describeMission(facts({ ...unwritten, goalStatus: "FAILED" })).phase, "failed");
  assert.equal(describeMission(facts({ ...unwritten, goalStatus: "PAUSED" })).primary?.action, "resume");
  assert.equal(describeMission(facts({ ...unwritten, parked: false, working: 2 })).primary?.action, "pause", "a live mission is not stopped by a placeholder");
  assert.equal(describeMission(facts({ ...unwritten, hostCeilingTripped: true })).phase, "ceiling");
  assert.equal(describeMission(facts({ ...unwritten, serverDown: true })).phase, "offline");
});

test("the placeholder is read from the mission's goal, and a status that has no goal text is not read as an unwritten goal", () => {
  const read = (description: unknown) => factsFromStatus({ goal: { status: "ACTIVE", description }, mode: "parked" }).goalWritten;
  assert.equal(read(GOAL_PLACEHOLDER), false);
  assert.equal(read(`${GOAL_PLACEHOLDER}\n`), false);
  assert.equal(read("Write a short, sourced report on how small teams review code."), true);
  assert.equal(read(undefined), true, "no text: nothing to say");
  assert.equal(factsFromStatus(null).goalWritten, true, "a status that has not arrived");
  assert.equal(describeMission(factsFromStatus(null)).phase, "loading");
  const end = describeMission(factsFromStatus({ goal: { status: "ACTIVE", description: GOAL_PLACEHOLDER }, mode: "parked", eventCount: 4 }));
  assert.equal(end.primary?.label, "Write the goal first", "end to end, from a status as the host sends it");
});
