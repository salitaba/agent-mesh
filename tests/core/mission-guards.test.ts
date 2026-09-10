import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MISSION_HALTED_ALLOW_OPS,
  MISSION_OVER_ALLOW_OPS,
  haltReasonText,
  haltedGoalStatus,
  isBookkeepingEvent,
} from "../../packages/core/src/mission-guards";
import { createInitialState, type Projections } from "../../packages/core/src/state";
import type { Goal, GoalStatus } from "../../packages/protocol/src/index";

/**
 * `mission-guards.ts` decides two things the rest of the runtime trusts
 * blindly: whether an agent is allowed to act at all right now, and whether an
 * event counts as real progress or is just bookkeeping (which the stall
 * detector must not mistake for activity). Both were only exercised
 * incidentally through the supervisor, so the distinctions themselves —
 * CONVERGING is not halted but BLOCKED is, `turn.*` is noise but `goal.*` is
 * not — had no direct assertion.
 */

function stateWithGoal(status: GoalStatus | undefined): Projections {
  const state = createInitialState();
  if (status === undefined) return state;
  state.activeGoalId = "goal-1";
  state.goals.set("goal-1", { id: "goal-1", description: "ship it", status } as Goal);
  return state;
}

test("haltedGoalStatus: no active goal reads as not halted", () => {
  assert.equal(haltedGoalStatus(createInitialState()), null);
});

test("haltedGoalStatus: activeGoalId pointing at a missing goal reads as not halted", () => {
  const state = createInitialState();
  state.activeGoalId = "goal-missing";
  assert.equal(haltedGoalStatus(state), null);
});

test("haltedGoalStatus: live statuses are not halted", () => {
  for (const status of ["CREATED", "ACTIVE", "CONVERGING"] as const) {
    assert.equal(haltedGoalStatus(stateWithGoal(status)), null, status);
  }
});

test("haltedGoalStatus: every non-live status is returned verbatim", () => {
  for (const status of ["PAUSED", "BLOCKED", "COMPLETED", "FAILED", "ESCALATED"] as const) {
    assert.equal(haltedGoalStatus(stateWithGoal(status)), status);
  }
});

test("haltReasonText: paused and escalated get actionable, distinct wording", () => {
  const paused = haltReasonText("PAUSED");
  const escalated = haltReasonText("ESCALATED");
  assert.match(paused, /paused/);
  assert.match(paused, /resume/);
  assert.match(escalated, /escalated/);
  assert.match(escalated, /escalation/);
  assert.notEqual(paused, escalated);
});

test("haltReasonText: BLOCKED shares the escalation wording", () => {
  assert.equal(haltReasonText("BLOCKED"), haltReasonText("ESCALATED"));
});

test("haltReasonText: null means there is no mission, not an unnamed status", () => {
  assert.equal(haltReasonText(null), "mission is not active");
});

test("haltReasonText: any other status falls through to a generic sentence", () => {
  assert.equal(haltReasonText("COMPLETED"), "mission is COMPLETED");
  assert.equal(haltReasonText("FAILED"), "mission is FAILED");
});

test("MISSION_HALTED_ALLOW_OPS: escape hatches only, no mutation of shared state", () => {
  for (const op of ["escalate", "wait", "done", "remember", "read_artifact"] as const) {
    assert.equal(MISSION_HALTED_ALLOW_OPS.has(op), true, op);
  }
  assert.equal(MISSION_HALTED_ALLOW_OPS.size, 5);
  for (const op of ["message", "commit", "propose_decision", "write_artifact"] as const) {
    assert.equal(MISSION_HALTED_ALLOW_OPS.has(op as never), false, op);
  }
});

test("MISSION_OVER_ALLOW_OPS: strictly narrower than the halted set", () => {
  assert.equal(MISSION_OVER_ALLOW_OPS.size, 2);
  for (const op of MISSION_OVER_ALLOW_OPS) {
    assert.equal(MISSION_HALTED_ALLOW_OPS.has(op), true, op);
  }
  // Once the mission is over there is nothing left to escalate to or wait for.
  assert.equal(MISSION_OVER_ALLOW_OPS.has("escalate"), false);
  assert.equal(MISSION_OVER_ALLOW_OPS.has("wait"), false);
  assert.equal(MISSION_OVER_ALLOW_OPS.has("done"), false);
});

test("isBookkeepingEvent: every enumerated bookkeeping type is noise", () => {
  for (const type of [
    "message.delivered",
    "budget.reserved",
    "budget.released",
    "budget.consumed",
    "agent.state_changed",
  ]) {
    assert.equal(isBookkeepingEvent(type), true, type);
  }
});

test("isBookkeepingEvent: the whole turn.* family is noise by prefix", () => {
  for (const type of ["turn.started", "turn.finished", "turn.anything.new"]) {
    assert.equal(isBookkeepingEvent(type), true, type);
  }
});

test("isBookkeepingEvent: real progress is not noise", () => {
  for (const type of [
    "message.sent",
    "message.rejected",
    "goal.created",
    "goal.status_changed",
    "goal.progress",
    "agent.created",
    "agent.awakened",
    "thread.created",
    "lease.released",
  ]) {
    assert.equal(isBookkeepingEvent(type), false, type);
  }
});

test("isBookkeepingEvent: prefix match is anchored, not a substring search", () => {
  assert.equal(isBookkeepingEvent("agent.turn.started"), false);
  assert.equal(isBookkeepingEvent("budget.reserved.extra"), false);
  assert.equal(isBookkeepingEvent(""), false);
});
