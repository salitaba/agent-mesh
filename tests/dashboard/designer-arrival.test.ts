import test from "node:test";
import assert from "node:assert/strict";

import { ARRIVAL_TTL_MS, requestArrival, takeArrival } from "../../apps/mesh-dashboard/src/designer/arrival";

/**
 * Two senders send a person to the Designer with a purpose: the welcome after it made a team, and "Write the goal first". The Designer takes
 * what was asked once, for its own project, while the request is fresh. Module state is shared, so each test starts by taking what is left.
 */

const T0 = 1_000_000;
const clear = (project: string): void => void takeArrival(project, T0);

test("a request is taken once, by the project it was for", () => {
  clear("a");
  assert.equal(takeArrival("a", T0), null, "nothing asked, nothing taken");
  requestArrival("a", "next-step", T0);
  assert.equal(takeArrival("a", T0 + 100), "next-step");
  assert.equal(takeArrival("a", T0 + 200), null, "taken: gone");
});

test("another project's request is not taken by this one, and waits for its own", () => {
  requestArrival("a", "goal", T0);
  assert.equal(takeArrival("b", T0 + 10), null, "the Designer of another project opening is not a reason to move its cursor");
  assert.equal(takeArrival("a", T0 + 20), "goal", "and the request is still there for the project it was for");
});

test("a request nobody took goes stale: the person it was for has long gone elsewhere", () => {
  requestArrival("a", "next-step", T0);
  assert.equal(takeArrival("a", T0 + ARRIVAL_TTL_MS + 1), null);
  requestArrival("a", "next-step", T0);
  assert.equal(takeArrival("a", T0 + ARRIVAL_TTL_MS), "next-step", "at the limit it is still fresh");
  requestArrival("a", "goal", T0);
  assert.equal(takeArrival("b", T0 + ARRIVAL_TTL_MS + 1), null, "asking for another project does not keep a stale one alive");
  assert.equal(takeArrival("a", T0 + ARRIVAL_TTL_MS + 2), null, "and it was dropped");
});

test("a later request replaces an earlier one: the person was sent twice, and the second is the one meant", () => {
  requestArrival("a", "next-step", T0);
  requestArrival("a", "goal", T0 + 5);
  assert.equal(takeArrival("a", T0 + 10), "goal");
  requestArrival("a", "goal", T0);
  requestArrival("b", "next-step", T0 + 5);
  assert.equal(takeArrival("a", T0 + 10), null, "one request at a time: the project sent to last");
  assert.equal(takeArrival("b", T0 + 10), "next-step");
});
