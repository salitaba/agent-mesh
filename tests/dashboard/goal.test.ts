import test from "node:test";
import assert from "node:assert/strict";

import { GOAL_EXAMPLES, GOAL_MAX, GOAL_PLACEHOLDER, goalDraft, goalIsPlaceholder, goalIsSet, startNeedsGoal, withExample } from "../../apps/mesh-dashboard/src/goal";
import { GOAL_PLACEHOLDER as FROM_DESIGNER, GOAL_MAX as MAX_FROM_DESIGNER, goalIsPlaceholder as designerPlaceholder } from "../../apps/mesh-dashboard/src/designer/model";

/**
 * A mission started on the scaffold's placeholder spends on a goal that says nothing. These pin what counts as a written goal, for the
 * welcome (a goal typed for a new team), the top bar and the Start dialog (a mission's goal), and the Designer (a draft's).
 */

test("the placeholder and a blank are not a goal; anything else a person wrote is, and text the console does not have is not accused", () => {
  for (const not of [GOAL_PLACEHOLDER, `  ${GOAL_PLACEHOLDER}\n`, "", "   ", "\n\t"]) {
    assert.equal(goalIsSet(not), false, JSON.stringify(not));
    assert.equal(goalIsPlaceholder(not), true, JSON.stringify(not));
  }
  for (const yes of ["Write a short report.", "Describe the mission goal here. And then some.", "describe the mission goal here."]) assert.equal(goalIsSet(yes), true, yes);
  // A status that is still loading has no goal text: that is a fact about the console, not about the goal, so it is never a reason to nag.
  for (const unknown of [undefined, null, 7, {}, []]) assert.equal(goalIsSet(unknown), true, JSON.stringify(unknown));
});

test("the Designer reads the same placeholder and the same length as the welcome and the Start dialog", () => {
  assert.equal(FROM_DESIGNER, GOAL_PLACEHOLDER);
  assert.equal(MAX_FROM_DESIGNER, GOAL_MAX);
  assert.equal(designerPlaceholder(GOAL_PLACEHOLDER), true);
  assert.equal(designerPlaceholder(undefined), true, "the Designer's guide asks for a goal that is not there");
  assert.equal(GOAL_MAX, 2000, "the schema's mesh.goal.maxLength, which the host holds a new team's goal to as well");
});

test("Start is held for the goal only for a mission that has never run: Continue is not Start", () => {
  assert.equal(startNeedsGoal({ goalWritten: false, hasHistory: false }), true);
  assert.equal(startNeedsGoal({ goalWritten: false, hasHistory: true }), false, "it has run: it keeps the goal it has");
  assert.equal(startNeedsGoal({ goalWritten: true, hasHistory: false }), false);
  assert.equal(startNeedsGoal({ hasHistory: false }), false, "no fact, no nag");
});

test("a goal being typed for a new team is ready when it says something, and a sentence when it is longer than a goal can be", () => {
  assert.deepEqual(goalDraft(""), { ready: false, problem: null, count: 0 });
  assert.deepEqual(goalDraft("  \n "), { ready: false, problem: null, count: 0 });
  assert.deepEqual(goalDraft("  Write a report.  "), { ready: true, problem: null, count: "Write a report.".length });
  assert.equal(goalDraft("x".repeat(GOAL_MAX)).ready, true, "the most a goal can be is allowed");
  const over = goalDraft("x".repeat(GOAL_MAX + 1));
  assert.equal(over.ready, false);
  assert.equal(over.problem, "The goal is 2,001 characters, and the most a goal can be is 2,000. Shorten it.", "said as the host says it, so a person is told the same thing either way");
  assert.equal(goalDraft(`${"x".repeat(GOAL_MAX)}   \n`).ready, true, "blanks around it are not counted");
});

test("an example fills an empty field and an earlier example; what a person wrote is kept and the example goes under it", () => {
  const [tool, report] = GOAL_EXAMPLES;
  assert.equal(withExample("", tool!), tool!.text);
  assert.equal(withExample("  \n", tool!), tool!.text);
  assert.equal(withExample(tool!.text, report!), report!.text, "picking another example replaces the first, which the person never wrote");
  assert.equal(withExample(`  ${tool!.text}\n`, report!), report!.text);
  assert.equal(withExample("Compare three note-taking apps for a small team.", report!), `Compare three note-taking apps for a small team.\n${report!.text}`);
  assert.equal(withExample("Compare apps.\n\n", report!), `Compare apps.\n${report!.text}`, "no run of blank lines is left behind");
  assert.equal(withExample(`${tool!.text} And it must work offline.`, report!), `${tool!.text} And it must work offline.\n${report!.text}`, "an example the person went on from is theirs now");
});

test("the examples are complete sentences with their own labels, and none is the placeholder or promises a result", () => {
  assert.equal(GOAL_EXAMPLES.length, 3);
  assert.equal(new Set(GOAL_EXAMPLES.map((e) => e.id)).size, GOAL_EXAMPLES.length);
  assert.equal(new Set(GOAL_EXAMPLES.map((e) => e.label)).size, GOAL_EXAMPLES.length);
  for (const e of GOAL_EXAMPLES) {
    assert.match(e.text, /^[A-Z].*\.$/, `${e.id}: a sentence`);
    assert.equal(goalIsSet(e.text), true, `${e.id}: a goal the Start dialog accepts`);
    assert.ok(goalDraft(e.text).ready, e.id);
    assert.doesNotMatch(e.text, /\b(will|guarantee[sd]?|always|perfect|best|automatically)\b/i, `${e.id}: it asks for something and promises nothing`);
  }
});
