import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRunReport, renderRunReport } from "../../packages/core/src/run-report";
import { createInitialState, type Projections } from "../../packages/core/src/state";
import type { AcceptanceCriterion, EvidenceRef, Goal } from "../../packages/protocol/src/index";

/**
 * The run report's acceptance section says how well each criterion is backed.
 *
 * "Claimed without tool use" is the report's one caveat on a satisfied
 * criterion, and it is only true when NOTHING recorded against it was read or
 * run. The verification gate makes a criterion collect a blind acceptance first
 * and a tool-backed one second; a caveat that fires on the first entry alone
 * told the operator five criteria were unbacked when every one had been
 * verified (cronlite, 2026-09-30).
 */

const AT = "2026-02-01T00:00:00.000Z";

function seed(state: Projections, evidence: EvidenceRef[], status: AcceptanceCriterion["status"]): void {
  const goal = {
    id: "goal-1",
    description: "ship it",
    status: "COMPLETED",
    createdAt: AT,
    acceptanceCriteria: [{ id: "c1", description: "it works", mandatory: true, status, evidence }],
  } as unknown as Goal;
  state.goals.set(goal.id, goal);
  state.activeGoalId = goal.id;
}

const blind: EvidenceRef = { kind: "agent.assertion", by: "pm", recordedAt: AT, verified: false, toolCalls: 0 };
const checked: EvidenceRef = { kind: "agent.assertion", by: "pm", recordedAt: AT, verified: true, toolCalls: 2 };
const operator: EvidenceRef = { kind: "operator.note", recordedAt: AT };

test("criteria: a blind acceptance followed by a tool-backed one is not 'asserted only'", () => {
  const state = createInitialState();
  seed(state, [blind, checked], "EVIDENCED");
  const report = buildRunReport(state);
  assert.equal(report.criteria.items[0]!.assertedOnly, false);
  assert.equal(report.criteria.assertedOnly, 0);
  assert.doesNotMatch(renderRunReport(report), /claimed without tool use/);
});

test("criteria: evidence that is all blind is still flagged", () => {
  const state = createInitialState();
  seed(state, [blind, { ...blind, recordedAt: "2026-02-01T00:05:00.000Z" }], "EVIDENCED");
  const report = buildRunReport(state);
  assert.equal(report.criteria.items[0]!.assertedOnly, true);
  assert.equal(report.criteria.assertedOnly, 1);
  assert.match(renderRunReport(report), /claimed without tool use/);
});

test("criteria: operator-recorded evidence carries no doubt, alone or beside a blind entry", () => {
  const alone = createInitialState();
  seed(alone, [operator], "EVIDENCED");
  assert.equal(buildRunReport(alone).criteria.items[0]!.assertedOnly, false);

  const mixed = createInitialState();
  seed(mixed, [blind, operator], "EVIDENCED");
  assert.equal(buildRunReport(mixed).criteria.items[0]!.assertedOnly, false);
});

test("criteria: a criterion with no evidence is not 'asserted only' (every() of nothing is not a caveat)", () => {
  const state = createInitialState();
  seed(state, [], "UNSATISFIED");
  const report = buildRunReport(state);
  assert.equal(report.criteria.items[0]!.assertedOnly, false);
  assert.equal(report.criteria.assertedOnly, 0);
});
