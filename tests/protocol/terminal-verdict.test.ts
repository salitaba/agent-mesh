import { test } from "node:test";
import assert from "node:assert/strict";
import { terminalMissionVerdict } from "../../packages/protocol/src/catalog";

/**
 * `terminalMissionVerdict` is the event-channel twin of `liveMissionVerdict`,
 * feeding the Overview's COMPLETED / FAILED / PAUSED banners.
 *
 * Its selection rules are where the interesting behaviour is — which event
 * wins, and which reasons it refuses to phrase — and the banner it feeds has
 * no machine test, so they are pinned here as ordinary logic rather than
 * verified by looking at a running dashboard.
 */

const ev = (type: string, payload?: unknown) => ({ type, payload });

test("terminal verdict: phrases the completion reason from the catalog", () => {
  const v = terminalMissionVerdict(
    [ev("goal.completed", { goalId: "g1", reason: "all_mandatory_criteria_evidenced", evidence: ["c1:test:e9"] })],
    "COMPLETED",
  );
  assert.equal(v?.reason, "all_mandatory_criteria_evidenced");
  assert.equal(v?.title, "Goal met");
  assert.match(v!.summary, /^Every mandatory acceptance criterion was evidenced/);
});

test("terminal verdict: an empty log means null, not a fallback headline", () => {
  assert.equal(terminalMissionVerdict([], "COMPLETED"), null);
});

/**
 * The reason the status argument exists. A completed mission can be reopened
 * ("Not good enough — reopen"), and its `goal.completed` stays in the buffer
 * forever — so the event alone would keep a green "Goal met" banner on a
 * mission that is running again.
 */
test("terminal verdict: a stale terminal event does not outlive its status", () => {
  const events = [ev("goal.completed", { reason: "all_mandatory_criteria_evidenced" })];
  assert.equal(terminalMissionVerdict(events, "ACTIVE"), null);
  assert.equal(terminalMissionVerdict(events, "PAUSED"), null);
});

test("terminal verdict: the newest terminal event wins", () => {
  const v = terminalMissionVerdict(
    [
      ev("goal.completed", { reason: "all_mandatory_criteria_evidenced" }),
      ev("goal.reopened", { reason: "not good enough" }),
      ev("goal.failed", { reason: "runtime_failure" }),
    ],
    "FAILED",
  );
  assert.equal(v?.reason, "runtime_failure");
  assert.equal(v?.title, "An agent crashed");
});

/**
 * Nothing older is consulted once the newest terminal event is found. Skipping
 * a disagreeing event to reach an agreeing older one would render text from a
 * verdict the mission has already moved past.
 */
test("terminal verdict: a disagreeing newest event is not searched past", () => {
  const v = terminalMissionVerdict(
    [
      ev("goal.completed", { reason: "all_mandatory_criteria_evidenced" }),
      ev("goal.failed", { reason: "runtime_failure" }),
    ],
    "COMPLETED",
  );
  assert.equal(v, null);
});

/**
 * A halt is read from the open card, not the event, so that answering the card
 * clears the banner. `goal.escalated` carries the same reason and must stay
 * invisible here or the halt banner would have a second, permanent source.
 */
test("terminal verdict: goal.escalated is not a terminal event", () => {
  assert.equal(terminalMissionVerdict([ev("goal.escalated", { reason: "wall_clock_exceeded" })], "ESCALATED"), null);
  assert.equal(terminalMissionVerdict([ev("message.rejected", { reason: "budget_exhausted" })], "COMPLETED"), null);
});

/** The pause path's own reason is free prose, and the fallback copy is correct. */
test("terminal verdict: an unphrased reason is refused rather than de-snaked", () => {
  assert.equal(terminalMissionVerdict([ev("goal.paused", { reason: "user pause" })], "PAUSED"), null);
});

/**
 * `hasOwnProperty`, not `in` — same trap as the card selector. A payload reason
 * of "constructor" would otherwise hand `verdictText` a function.
 */
test("terminal verdict: prototype keys are not phrasings", () => {
  assert.equal(terminalMissionVerdict([ev("goal.completed", { reason: "constructor" })], "COMPLETED"), null);
  assert.equal(terminalMissionVerdict([ev("goal.completed", { reason: "toString" })], "COMPLETED"), null);
});

test("terminal verdict: a malformed payload degrades to null", () => {
  assert.equal(terminalMissionVerdict([ev("goal.completed", "not an object")], "COMPLETED"), null);
  assert.equal(terminalMissionVerdict([ev("goal.completed", undefined)], "COMPLETED"), null);
  assert.equal(terminalMissionVerdict([ev("goal.completed", { reason: 42 })], "COMPLETED"), null);
  assert.equal(terminalMissionVerdict([{ payload: { reason: "all_mandatory_criteria_evidenced" } }], "COMPLETED"), null);
});

/** A paused mission whose pause ever does carry a real reason phrases it. */
test("terminal verdict: the pause arm works the day a pause carries a reason", () => {
  const v = terminalMissionVerdict([ev("goal.paused", { reason: "budget_exhausted" })], "PAUSED");
  assert.equal(v?.title, "Mission ran out of tokens");
});
