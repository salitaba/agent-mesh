import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRunReport } from "../../packages/core/src/run-report";
import { createInitialState } from "../../packages/core/src/state";
import { verdictText, type Goal } from "../../packages/protocol/src/index";

/**
 * A run report read off a mesh that was stopped mid-mission.
 *
 * Ctrl-C on a live mission leaves its goal ACTIVE and no termination reason in the
 * log, so the verdict is synthesized from the goal's status (`goal_<status>`). Only
 * `goal_failed` and `goal_escalated` had text, so the crash-test run's report told
 * the operator the mission "stopped for a reason this build has no phrasing for
 * (`goal_active`)" -- the one state an interrupted run is most likely to be in.
 */

const AT = "2026-02-01T00:00:00.000Z";

function reportFor(status: Goal["status"]) {
  const state = createInitialState();
  const goal = {
    id: "goal-1",
    description: "ship it",
    status,
    createdAt: AT,
    acceptanceCriteria: [{ id: "c1", description: "it works", mandatory: true, status: "UNSATISFIED", evidence: [] }],
  } as unknown as Goal;
  state.goals.set(goal.id, goal);
  state.activeGoalId = goal.id;
  return buildRunReport(state);
}

test("a mission stopped while still active says it was stopped, not that the build has no words for it", () => {
  const { verdict } = reportFor("ACTIVE");
  assert.equal(verdict.reason, "goal_active");
  assert.equal(verdict.succeeded, false);
  assert.equal(verdict.title, "Stopped before the goal was met");
  assert.doesNotMatch(verdict.summary, /no phrasing/);
  assert.match(verdict.summary, /stopped .* before every mandatory criterion was evidenced/);
});

test("paused and never-started missions are phrased too", () => {
  assert.equal(reportFor("PAUSED").verdict.title, "Mission paused");
  assert.equal(reportFor("CREATED").verdict.title, "Mission never started");
});

test("every status a stopped run can end in has a phrase of its own", () => {
  // The statuses `deriveVerdict` turns into `goal_<status>`, COMPLETED excluded (it is the success path).
  for (const status of ["CREATED", "ACTIVE", "PAUSED", "FAILED", "ESCALATED"] as const) {
    const text = verdictText(`goal_${status.toLowerCase()}`);
    assert.doesNotMatch(text.summary, /no phrasing/, `goal_${status.toLowerCase()} falls back to the unphrased text`);
  }
});
