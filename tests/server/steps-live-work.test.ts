import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeTurnSteps } from "../../apps/mesh-server/src/steps-view";
import { currentToolOf, type TurnStep } from "../../packages/observability/src/index";
import type { LiveToolCall, TurnRecord } from "../../packages/core/src/index";

/**
 * A seat spent seventeen minutes making ~94 native tool calls and the Steps
 * list read "thinking…" and "no cost" the whole time: the tracker record knew
 * what it was doing, and `/steps` shipped none of it. These pin the summary a
 * row now carries — and that it stays a summary, because `/steps` is polled at
 * limit 60 every few seconds.
 */

const T0 = 1_700_000_000_000;

function record(over: Record<string, unknown> = {}): TurnRecord {
  return {
    turnId: "turn-1",
    agentId: "backend",
    reason: { kind: "message" },
    startedAt: new Date(T0).toISOString(),
    status: "running",
    ...over,
  } as unknown as TurnRecord;
}

const tool = (id: string, over: Partial<LiveToolCall> = {}): LiveToolCall => ({
  id,
  name: "Edit",
  target: `packages/core/src/${id}.ts`,
  status: "completed",
  startedAt: T0 + 1_000,
  endedAt: T0 + 1_200,
  ...over,
});

test("a live row carries what the turn is doing: count, current tool, deadline, tokens so far", () => {
  const [row] = mergeTurnSteps([], [record({
    toolFrames: 188,
    toolCallCount: 94,
    liveTools: [
      tool("a"),
      tool("b", { name: "Bash", target: "pnpm test", status: "running", endedAt: undefined, startedAt: T0 + 5_000 }),
      tool("c", { startedAt: T0 + 6_000, endedAt: T0 + 6_100 }),
    ],
    filesTouched: ["a.ts", "b.ts", "c.ts"],
    liveTokens: 48_200,
    advisories: [{ at: T0 + 60_000, text: "2 minutes left", delivered: true }],
    phases: { startedAt: T0, llmCallAt: T0 + 500, deadlineAt: T0 + 600_000, ceilingAt: T0 + 1_800_000 },
  })]);
  const s = row!;
  assert.equal(s.toolCallCount, 94, "calls, next to the frame count it must not be confused with");
  assert.equal(s.toolFrames, 188);
  assert.deepEqual(s.currentTool, { name: "Bash", target: "pnpm test", status: "running", startedAt: T0 + 5_000 },
    "the newest RUNNING call, not the quick Edit that finished after it started");
  assert.equal(s.deadlineAt, T0 + 600_000);
  assert.equal(s.ceilingAt, T0 + 1_800_000);
  assert.equal(s.liveTokens, 48_200);
  assert.equal(s.filesTouchedCount, 3);
  assert.equal(s.advisoryCount, 1);
});

test("/steps ships summaries only — never the call list, file list or advisory texts", () => {
  const liveTools = Array.from({ length: 60 }, (_, i) => tool(`t${i}`, { target: `${"x".repeat(150)}/${i}.ts` }));
  const [row] = mergeTurnSteps([], [record({
    toolCallCount: 94,
    liveTools,
    filesTouched: liveTools.map((t) => t.target!),
    advisories: [{ at: T0, text: "a".repeat(500), delivered: false }],
    checkpoint: { ref: "refs/mesh/checkpoints/backend/turn-1", commit: "abc", files: ["a.ts"] },
  })]);
  const wire = JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
  for (const k of ["liveTools", "filesTouched", "advisories", "checkpoint"]) {
    assert.equal(k in wire, false, `${k} belongs on /turns/:id, not on every row of every poll`);
  }
  assert.ok(JSON.stringify(wire).length < 2_000, `one row stays small: ${JSON.stringify(wire).length} chars`);
});

test("a record from before the live-work fields leaves them absent, not zero", () => {
  const [row] = mergeTurnSteps([], [record({ toolFrames: 12, phases: { startedAt: T0 } })]);
  const wire = JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
  for (const k of ["toolCallCount", "currentTool", "deadlineAt", "ceilingAt", "liveTokens", "filesTouchedCount", "advisoryCount"]) {
    assert.equal(k in wire, false, `${k}: absent is unknown — a 0 would claim the turn did nothing`);
  }
});

test("a failed turn keeps its last tool on the row", () => {
  // The seat was killed mid-Bash: the row can still say where it died.
  const [row] = mergeTurnSteps([], [record({
    status: "failed",
    error: "turn timed out",
    liveTools: [tool("a"), tool("b", { name: "Bash", target: "pnpm build", status: "running", endedAt: undefined })],
  })]);
  assert.equal(row!.status, "failed");
  assert.equal(row!.currentTool?.name, "Bash");
});

test("the log-only step is untouched by the merge's live fields", () => {
  const logStep: TurnStep = {
    turnId: "turn-old", agentId: "qa", reasonKind: "message", startedAt: new Date(T0).toISOString(), status: "ok",
    lifecycle: "IDLE", ops: { messages: 1, artifacts: 0, tasks: 0, decisions: 0 }, messageIds: [], artifactIds: [],
    tokens: 10, seqStart: 1, seqEnd: 2, eventCount: 2,
  };
  const [row] = mergeTurnSteps([logStep], []);
  assert.equal(row, logStep, "a turn only the log knows passes through as it was");
});

test("currentToolOf: newest running, else newest, else nothing", () => {
  assert.equal(currentToolOf(undefined), undefined);
  assert.equal(currentToolOf([]), undefined);
  assert.equal(currentToolOf([tool("a"), tool("b", { name: "Write" })])?.name, "Write");
  const two = currentToolOf([
    tool("a", { status: "running", endedAt: undefined, name: "Bash" }),
    tool("b", { status: "running", endedAt: undefined, name: "Grep" }),
    tool("c"),
  ]);
  assert.equal(two?.name, "Grep", "of two calls in flight, the one announced last");
  assert.equal("endedAt" in (two ?? {}), false, "a running call has no end to report");
  assert.equal("id" in (two ?? {}), false, "the row carries no ids or errors — just what a reader looks at");
});
