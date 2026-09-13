import { test } from "node:test";
import assert from "node:assert/strict";
import { planProgress, planLabel, planStale } from "../../apps/mesh-dashboard/src/plan";

const steps = (...st: string[]) => st.map((s, i) => ({ id: `s${i}`, text: `step ${i}`, status: s }));

test("dashboard plan: progress counts DONE steps", () => {
  assert.deepEqual(planProgress({ steps: steps("DONE", "PENDING", "DONE") }), { done: 2, total: 3, pct: 67 });
});

test("dashboard plan: an empty or missing plan is 0%, never NaN", () => {
  assert.deepEqual(planProgress({ steps: [] }), { done: 0, total: 0, pct: 0 });
  assert.deepEqual(planProgress(null), { done: 0, total: 0, pct: 0 });
  assert.deepEqual(planProgress(undefined), { done: 0, total: 0, pct: 0 });
});

test("dashboard plan: label reads as progress, not as a count of nothing", () => {
  assert.equal(planLabel(null), "No plan");
  assert.equal(planLabel({ steps: [] }), "No plan");
  assert.equal(planLabel({ steps: steps("DONE", "PENDING") }), "1/2 steps");
});

test("dashboard plan: staleness matches the gate's read-time rule", () => {
  assert.equal(planStale({ taskId: "t1", steps: [] }, "t2"), true);
  assert.equal(planStale({ taskId: "t1", steps: [] }, "t1"), false);
  // Unknown on either side is not stale — a plan is never greyed out on
  // missing data, which would read as 'this agent is confused' when it is not.
  assert.equal(planStale({ steps: [] }, "t1"), false);
  assert.equal(planStale({ taskId: "t1", steps: [] }, null), false);
  assert.equal(planStale(null, "t1"), false);
});
