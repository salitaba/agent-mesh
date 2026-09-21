import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTurnSteps } from "../../packages/observability/src/index";
import type { MeshEvent } from "../../packages/protocol/src/index";

function event(seq: number, type: string, payload: Record<string, unknown>): MeshEvent {
  return {
    id: `e${seq}`,
    seq,
    type,
    at: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    actor: "backend",
    payload,
  } as unknown as MeshEvent;
}

function awakened(seq = 1): MeshEvent {
  return event(seq, "agent.awakened", { agentId: "backend", turnId: "turn-1", reason: { kind: "message" } });
}

/** `budget.consumed` as the kernel emits it: the split is in the consume detail. */
function consume(seq: number, p: Record<string, unknown>): MeshEvent {
  return event(seq, "budget.consumed", { turnId: "turn-1", key: "agent:g/backend", amount: 1100, ...p });
}

test("a replayed turn carries the split the consume event recorded", () => {
  // The figures are in the log the whole time; before this they were read for
  // `amount` alone and thrown away.
  const steps = buildTurnSteps([
    awakened(),
    consume(2, { input: 1000, output: 100, cacheRead: 7000, model: "claude-opus-5" }),
  ]);
  assert.equal(steps.length, 1);
  const s = steps[0]!;
  assert.equal(s.tokens, 1100);
  assert.equal(s.tokensInput, 1000);
  assert.equal(s.tokensOutput, 100);
  assert.equal(s.tokensCacheRead, 7000);
  assert.equal(s.model, "claude-opus-5");
});

test("the thinking share of a turn's output survives the log, and its absence survives too", () => {
  // Thinking is billed inside `output`, so a step that shows 100 written tokens
  // cannot say whether the seat wrote or deliberated. When the backend reports
  // the split it rides the same consume payload as the rest.
  const told = buildTurnSteps([awakened(), consume(2, { input: 1000, output: 100, cacheRead: 7000, thinking: 60 })]);
  assert.equal(told[0]!.tokensThinking, 60);

  // And when it does not, the field stays absent. A 0 here would assert a turn
  // deliberated for free, which is a claim no measurement supports.
  const silent = buildTurnSteps([awakened(), consume(2, { input: 1000, output: 100, cacheRead: 7000 })]);
  assert.equal(silent[0]!.tokensThinking, undefined);
});

test("a consume that reports no split leaves the fields absent, not zero", () => {
  // A backend that says nothing must not read as "this turn read nothing
  // uncached" — the same absence discipline the ledger parser needs.
  const steps = buildTurnSteps([awakened(), consume(2, {})]);
  const s = steps[0]!;
  assert.equal(s.tokens, 1100);
  assert.equal(s.tokensInput, undefined);
  assert.equal(s.tokensOutput, undefined);
  assert.equal(s.tokensCacheRead, undefined);
});

test("mission-keyed consumes mirror the agent one and are not counted twice", () => {
  const steps = buildTurnSteps([
    awakened(),
    consume(2, { input: 1000, output: 100, cacheRead: 7000 }),
    event(3, "budget.consumed", {
      turnId: "turn-1",
      key: "mission:g",
      amount: 1100,
      input: 1000,
      output: 100,
      cacheRead: 7000,
    }),
  ]);
  const s = steps[0]!;
  assert.equal(s.tokens, 1100);
  assert.equal(s.tokensInput, 1000);
  assert.equal(s.tokensOutput, 100);
  assert.equal(s.tokensCacheRead, 7000);
});

test("a second agent consume accumulates its split, as the total does", () => {
  const steps = buildTurnSteps([
    awakened(),
    consume(2, { input: 1000, output: 100, cacheRead: 7000 }),
    consume(3, { amount: 550, input: 500, output: 50, cacheRead: 3000 }),
  ]);
  const s = steps[0]!;
  assert.equal(s.tokens, 1650);
  assert.equal(s.tokensInput, 1500);
  assert.equal(s.tokensOutput, 150);
  assert.equal(s.tokensCacheRead, 10000);
});
