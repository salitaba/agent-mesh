import { test } from "node:test";
import assert from "node:assert/strict";
import { planProgress, planLabel, planStale, planSummary, planSummaryStale } from "../../apps/mesh-dashboard/src/plan";

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

test("dashboard plan: the list projection is null when there is nothing to badge", () => {
  assert.equal(planSummary(null), null);
  assert.equal(planSummary(undefined), null);
  // A row from a mesh with no plan at all, and a plan that was retracted.
  assert.equal(planSummary({ planDone: null, planTotal: 0, planTaskId: null }), null);
  assert.equal(planSummary({ planDone: 0, planTotal: 0, planTaskId: "t1" }), null);
});

test("dashboard plan: the list projection mirrors progress and task scope", () => {
  assert.deepEqual(planSummary({ planDone: 2, planTotal: 3, planTaskId: "t1" }), { done: 2, total: 3, taskId: "t1" });
  // A plan whose task is unknown still badges its progress; only staleness
  // needs both sides, exactly as in the drawer.
  assert.deepEqual(planSummary({ planDone: 0, planTotal: 4, planTaskId: null }), { done: 0, total: 4, taskId: null });
});

test("dashboard plan: the list projection uses the gate's staleness rule, not its own", () => {
  assert.equal(planSummaryStale({ done: 1, total: 2, taskId: "t1" }, "t2"), true);
  assert.equal(planSummaryStale({ done: 1, total: 2, taskId: "t1" }, "t1"), false);
  assert.equal(planSummaryStale({ done: 1, total: 2, taskId: null }, "t1"), false);
  assert.equal(planSummaryStale(null, "t1"), false);
});
