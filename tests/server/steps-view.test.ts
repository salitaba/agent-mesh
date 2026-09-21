import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeTurnSteps } from "../../apps/mesh-server/src/steps-view";
import type { TurnStep } from "../../packages/observability/src/index";
import type { TurnRecord } from "../../packages/core/src/index";

function step(over: Partial<TurnStep> = {}): TurnStep {
  return {
    turnId: "turn-1",
    agentId: "backend",
    reasonKind: "message",
    startedAt: "2026-01-01T00:00:00.000Z",
    status: "running",
    lifecycle: "IDLE",
    ops: { messages: 0, artifacts: 0, tasks: 0, decisions: 0 },
    messageIds: [],
    artifactIds: [],
    tokens: 0,
    seqStart: 0,
    seqEnd: 0,
    eventCount: 0,
    ...over,
  };
}

function record(over: Record<string, unknown> = {}): TurnRecord {
  return {
    turnId: "turn-1",
    agentId: "backend",
    reason: { kind: "message" },
    startedAt: "2026-01-01T00:00:01.000Z",
    status: "running",
    ...over,
  } as unknown as TurnRecord;
}

test("the split survives the merge when the live record carries none", () => {
  // The turn is in the ring, so live wins the total — but the log-derived step
  // is the only one with the split, and dropping it is what made the drawer's
  // in/out bar depend on which of the two payloads answered first.
  const merged = mergeTurnSteps(
    [step({ tokens: 500, tokensInput: 400, tokensOutput: 100, tokensCacheRead: 900 })],
    [record({ tokens: 600 })],
  );
  assert.equal(merged.length, 1);
  const m = merged[0]!;
  assert.equal(m.tokens, 600, "live total wins");
  assert.equal(m.tokensInput, 400, "and the log's split is carried, not dropped");
  assert.equal(m.tokensOutput, 100);
  assert.equal(m.tokensCacheRead, 900);
});

test("a live record's own split wins, and a reported zero is carried", () => {
  const merged = mergeTurnSteps(
    [step({ tokensInput: 400, tokensOutput: 100, tokensCacheRead: 900 })],
    [record({ tokensInput: 25, tokensOutput: 5, tokensCacheRead: 0 })],
  );
  const m = merged[0]!;
  assert.equal(m.tokensInput, 25);
  assert.equal(m.tokensOutput, 5);
  assert.equal(m.tokensCacheRead, 0, "a reported zero is a figure, not an absence");
});
