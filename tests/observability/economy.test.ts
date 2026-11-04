import { test } from "node:test";
import assert from "node:assert/strict";
import { buildEconomyReport, type TurnLedgerRow } from "../../packages/observability/src/index";

/**
 * Tokens per outcome.
 *
 * The ledger can say what each turn cost; this is the division that says whether
 * the bill bought anything. `null`, never 0, when nothing was produced: "no
 * merged patch" is not "each merged patch was free".
 */

const row = (agentId: string, input: number, output: number, cacheRead: number | null, turnId: string): TurnLedgerRow => ({
  at: "2026-11-03T10:00:00.000Z",
  turnId,
  agentId,
  input,
  output,
  cacheRead,
  thinking: null,
  ops: 1,
  toolCalls: 2,
  total: input + output,
});

const EVENTS = [
  { type: "requirement.satisfied" },
  { type: "requirement.satisfied" },
  { type: "review.approved" },
  { type: "patch.merged" },
  { type: "task.completed" },
  { type: "artifact.versioned" },
  { type: "artifact.versioned" },
  { type: "message.sent" },
];

test("billable tokens divide by what the mission produced, and weighted units track the invoice", () => {
  const rows = [
    row("dev", 1000, 100, 9000, "t1"),
    row("dev", 2000, 200, 18000, "t2"),
    row("dev", 3000, 300, 27000, "t3"),
    row("qa", 4000, 400, 36000, "t4"),
    row("qa", 5000, 500, 45000, "t5"),
  ];
  const rep = buildEconomyReport(rows, EVENTS);

  assert.equal(rep.turns, 5);
  assert.equal(rep.billable, 16_500, "sum of fresh input + output");
  assert.equal(rep.input, 15_000);
  assert.equal(rep.output, 1_500);
  assert.equal(rep.cacheRead, 135_000);
  assert.equal(rep.cacheHitRatio, 135_000 / 150_000);
  assert.equal(rep.weighted, 36_000, "input 1x + cache 0.1x + output 5x");
  assert.deepEqual(rep.units, { fresh: 15_000, cached: 13_500, output: 7_500 });

  assert.deepEqual(rep.outcomes, { criterionAccepted: 2, reviews: 1, patchesMerged: 1, tasksCompleted: 1, artifactsPublished: 2 });
  assert.equal(rep.tokensPer.criterion, 8_250);
  assert.equal(rep.tokensPer.review, 16_500);
  assert.equal(rep.tokensPer.mergedPatch, 16_500);
  assert.equal(rep.tokensPer.completedTask, 16_500);
  assert.equal(rep.tokensPer.artifact, 8_250);
  assert.equal(rep.costPer.criterion, 18_000, "weighted cost per outcome, not billable");
  assert.equal(rep.costPer.mergedPatch, 36_000);

  // Newest-first by cost; the top 5% of five turns is one turn.
  assert.equal(rep.topTurns[0]!.turnId, "t5");
  assert.equal(rep.topTurns[0]!.weighted, 12_000);
  assert.ok(Math.abs(rep.topShare - 12_000 / 36_000) < 1e-9);

  assert.deepEqual(
    rep.byAgent.map((a) => [a.agentId, a.weighted, a.turns]),
    [
      ["qa", 21_600, 2],
      ["dev", 14_400, 3],
    ],
    "seats ordered by weighted cost",
  );
  assert.ok(Math.abs(rep.byAgent.reduce((a, r) => a + r.weightedShare, 0) - 1) < 1e-9, "weighted shares cover the whole bill");
});

test("an outcome nobody produced has no ratio rather than a zero", () => {
  const rep = buildEconomyReport([row("dev", 100, 10, null, "t1")], [{ type: "message.sent" }]);
  assert.deepEqual(rep.outcomes, { criterionAccepted: 0, reviews: 0, patchesMerged: 0, tasksCompleted: 0, artifactsPublished: 0 });
  assert.equal(rep.tokensPer.criterion, null);
  assert.equal(rep.tokensPer.mergedPatch, null);
  assert.equal(rep.costPer.criterion, null);
  assert.equal(rep.cacheHitRatio, null, "no turn reported cache reads: unmeasured, not cold");
});
