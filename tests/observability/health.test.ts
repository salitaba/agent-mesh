import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHealth } from "../../packages/observability/src/index";
import type { Projections } from "../../packages/core/src/state";

/**
 * "Why is this mission not moving?" as one answer, from projections.
 *
 * The state this was written for: every mandatory criterion evidenced, and the
 * completion gate held by a review queue of 99 — of which 5 were cited by a
 * criterion. Nothing in the console could say that; the health report is what the
 * hero, the remedies and `curule reviews archive-stale` read.
 */

const art = (id: string, status: string, name = id, type = "TestReport") =>
  ({ id, name, type, goalId: "g", owner: "qa", version: 1, status, createdAt: "2026-11-04T10:00:00.000Z" }) as never;

function stateWith(criteria: unknown[], artifacts: unknown[]): Projections {
  return {
    activeGoalId: "g",
    goals: new Map([["g", { id: "g", status: "ACTIVE", acceptanceCriteria: criteria }]]),
    artifacts: new Map((artifacts as Array<{ id: string }>).map((a) => [a.id, a])),
    artifactHistory: new Map(),
    escalations: new Map(),
    agents: new Map([["qa", { definition: { id: "qa" }, state: { lifecycle: "IDLE" } }]]),
  } as unknown as Projections;
}

const evidenced = (name: string) => ({
  id: "c1",
  mandatory: true,
  status: "EVIDENCED",
  evidence: [{ kind: "criteria-acceptance", artifactRef: { uri: `artifact://TestReport/${encodeURIComponent(name)}/1` }, recordedAt: "" }],
});

test("every criterion evidenced and a review queue open is 'blocked', and the sentence says it", () => {
  const h = buildHealth(
    stateWith(
      [evidenced("accepted-row")],
      [art("a1", "READY_FOR_REVIEW", "accepted-row"), art("a2", "READY_FOR_REVIEW"), art("a3", "READY_FOR_REVIEW")],
    ),
  );
  assert.equal(h.status, "blocked");
  assert.equal(h.reviewDebt.open, 3);
  assert.equal(h.reviewDebt.cited, 1);
  assert.equal(h.reviewDebt.uncited, 2);
  assert.match(String(h.completionHold), /3 files still await a verdict/);
  assert.match(String(h.completionHold), /2 uncited and closable/);
  assert.equal(h.criteria.unsatisfied, 0);
});

test("a criterion nobody has evidenced is 'attention', and the reason names it", () => {
  const h = buildHealth(stateWith([{ id: "c1", mandatory: true, status: "UNSATISFIED", evidence: [] }], []));
  assert.equal(h.status, "attention");
  assert.equal(h.criteria.unsatisfied, 1);
  assert.ok(h.reasons.some((r) => r.code === "criteria_unsatisfied" && r.detail.includes("c1")));
  assert.equal(h.completionHold, undefined, "nothing is holding a close: the work is not done");
});

test("a finished mission with nothing outstanding is 'ok'", () => {
  const h = buildHealth(stateWith([evidenced("accepted-row")], [art("a1", "FINAL", "accepted-row")]));
  assert.equal(h.status, "ok");
  assert.deepEqual(h.reasons, []);
});
