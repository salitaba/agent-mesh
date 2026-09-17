import { test } from "node:test";
import assert from "node:assert/strict";
import { liveMissionVerdict, TERMINATION_RAISER } from "../../packages/protocol/src/catalog";

/**
 * `liveMissionVerdict` is the only thing standing between the Overview's most
 * prominent banner and whatever prose an agent happened to put in a `reason`.
 *
 * The banner it feeds has no machine test — validation in this repo lives in
 * `packages/`, never the UI — so the selection rules are tested here, where
 * they are ordinary logic, rather than left to be verified by looking at a
 * running dashboard.
 */

const term = (reason: string, detail?: unknown) => ({
  reason,
  raisedBy: TERMINATION_RAISER,
  status: "OPEN",
  detail,
});

test("live verdict: phrases a termination-manager card from the catalog", () => {
  const v = liveMissionVerdict([term("wall_clock_exceeded", { wallClockMs: 1, limitMs: 0 })]);
  assert.equal(v?.reason, "wall_clock_exceeded");
  assert.equal(v?.title, "Mission ran out of time");
  assert.equal(v?.summary, "The run exceeded its configured wall-clock limit.");
});

test("live verdict: nothing standing means null, not a fallback headline", () => {
  assert.equal(liveMissionVerdict([]), null);
});

/**
 * The reason this function exists rather than `verdictText(escOpen[0].reason)`.
 * `verdictText` degrades gracefully on an unknown key — correct for a card,
 * wrong for a banner, where it would render an agent's sentence fragment as the
 * headline answer to "why is nothing happening".
 */
test("live verdict: ignores agent-raised cards carrying free prose", () => {
  const v = liveMissionVerdict([
    { reason: "needs a decision on the auth approach", raisedBy: "architect", status: "OPEN" },
  ]);
  assert.equal(v, null);
});

test("live verdict: ignores advisory cards", () => {
  assert.equal(liveMissionVerdict([{ ...term("budget_exhausted"), advisory: true }]), null);
});

test("live verdict: ignores cards that are no longer open", () => {
  assert.equal(liveMissionVerdict([{ ...term("budget_exhausted"), status: "RESPONDED" }]), null);
});

/**
 * `reason` arrives from the log as an arbitrary string, and `"constructor"` is
 * a perfectly legal one. A prototype-chain membership check would treat it as a
 * phrased verdict and hand `verdictText` a key whose value is a function.
 */
test("live verdict: a prototype-chain key is not a phrased verdict", () => {
  assert.equal(liveMissionVerdict([term("constructor")]), null);
  assert.equal(liveMissionVerdict([term("toString")]), null);
});

test("live verdict: carries the live numbers into the headline", () => {
  const stale = liveMissionVerdict([
    term("stalemate", { openDeadlockEscalations: [{ id: "e1" }, { id: "e2" }, { id: "e3" }] }),
  ]);
  assert.equal(stale?.title, "Stalemate (3 waiting)");

  const crashed = liveMissionVerdict([term("runtime_failure", { failedAgents: ["builder", "qa"] })]);
  assert.equal(crashed?.title, "Agent crashed: builder, qa");

  const threads = liveMissionVerdict([term("thread_budgets_exhausted", { exhaustedThreads: 2 })]);
  assert.match(threads?.summary ?? "", /^2 conversation threads spent their token budgets/);
});

test("live verdict: a malformed detail degrades to the generic phrasing, not a throw", () => {
  const v = liveMissionVerdict([term("runtime_failure", "not an object")]);
  assert.equal(v?.title, "An agent crashed");
});

/**
 * A mission can escalate, be answered, and escalate again for a different
 * reason. The log preserves insertion order, so the newest open card is the one
 * describing why the mission is stopped *now*.
 */
test("live verdict: the newest open termination card wins", () => {
  const v = liveMissionVerdict([term("budget_exhausted"), term("max_events_exceeded")]);
  assert.equal(v?.reason, "max_events_exceeded");
  assert.equal(v?.title, "Mission hit its event cap");
});

test("live verdict: skips newer non-qualifying cards to find the standing one", () => {
  const v = liveMissionVerdict([
    term("budget_exhausted"),
    { reason: "please review the API shape", raisedBy: "architect", status: "OPEN" },
  ]);
  assert.equal(v?.reason, "budget_exhausted");
});
