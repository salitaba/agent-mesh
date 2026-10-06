import test from "node:test";
import assert from "node:assert/strict";

import { guideProgress, seatsText } from "../../apps/mesh-dashboard/src/designer/guidemodel";
import { GOAL_PLACEHOLDER } from "../../apps/mesh-dashboard/src/goal";

/**
 * The guide is the first thing a new project shows. It answers one question, "what do I do now?", so what it calls done, now and next is
 * the claim: the goal first, then the team, then who may message whom, then saving, which is the person's own act and never done here.
 */

const states = (input: Parameters<typeof guideProgress>[0]): string => guideProgress(input).steps.map((s) => `${s.key}:${s.state}`).join(" ");

test("a new project: the goal is the thing to do now, and the rest are next", () => {
  assert.equal(states({ goal: GOAL_PLACEHOLDER, seats: 1, wires: 0 }), "goal:now seats:next wires:next save:next");
  assert.equal(guideProgress({ goal: GOAL_PLACEHOLDER, seats: 1, wires: 0 }).now, "goal");
  assert.equal(states({ goal: "", seats: 0, wires: 0 }), "goal:now seats:next wires:next save:next", "no goal at all reads as none written");
  assert.equal(states({ goal: undefined, seats: 1, wires: 0 }), "goal:now seats:next wires:next save:next");
});

test("a goal that came with the team and one seat: describing the team is now", () => {
  assert.equal(states({ goal: "Write a short report.", seats: 1, wires: 0 }), "goal:done seats:now wires:next save:next");
  assert.equal(guideProgress({ goal: "Write a short report.", seats: 1, wires: 0 }).now, "seats");
});

test("two seats nobody may message through: the wires are now; wired, saving is now and is never done", () => {
  assert.equal(states({ goal: "g", seats: 2, wires: 0 }), "goal:done seats:done wires:now save:next");
  assert.equal(states({ goal: "g", seats: 3, wires: 2 }), "goal:done seats:done wires:done save:now");
  assert.equal(guideProgress({ goal: "g", seats: 3, wires: 2 }).now, "save");
});

test("steps are judged on their own: a team proposed before the goal was written leaves the goal as the one thing to do", () => {
  assert.equal(states({ goal: GOAL_PLACEHOLDER, seats: 3, wires: 2 }), "goal:now seats:done wires:done save:next");
  assert.equal(guideProgress({ goal: GOAL_PLACEHOLDER, seats: 3, wires: 2 }).now, "goal");
  assert.equal(states({ goal: "g", seats: 1, wires: 3 }), "goal:done seats:now wires:next save:next", "a wire needs two seats to mean anything");
});

test("exactly one step is now, always, so the guide never has two answers to what to do", () => {
  for (const goal of [GOAL_PLACEHOLDER, "g"]) for (const seats of [0, 1, 2, 5]) for (const wires of [0, 1, 4]) {
    const p = guideProgress({ goal, seats, wires });
    assert.equal(p.steps.filter((s) => s.state === "now").length, 1, JSON.stringify({ goal, seats, wires }));
    assert.equal(p.steps.find((s) => s.state === "now")!.key, p.now);
    assert.deepEqual(p.steps.map((s) => s.key), ["goal", "seats", "wires", "save"]);
  }
});

test("the line for the seats leads a lone seat to the designer or to adding one, and says one seat is a valid team", () => {
  assert.equal(
    seatsText(1),
    "There is one seat. Describe the team to the designer and review what it proposes, or add a seat yourself. One seat is a valid mesh, so stop here if that is the team you want.",
  );
  assert.match(seatsText(0), /^There are no seats yet\. Describe the team to the designer/);
  assert.equal(seatsText(3), "There are 3 seats. Give each a role, the tools it may use and what it may decide alone.");
  assert.doesNotMatch(seatsText(1), /\b(will|automatically)\b/i, "the designer proposes, the person reviews: nothing is promised or done for them");
});
