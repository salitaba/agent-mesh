import test from "node:test";
import assert from "node:assert/strict";

import {
  TOOLS_PER_TURN_MAX,
  TOOL_ARGS_MAX,
  foldToolEvent,
  previewArgs,
  type ToolLive,
} from "../../apps/mesh-dashboard/src/streams";

const call = (id: string, name = "bash", args: unknown = { cmd: "ls" }) => ({ kind: "tool_call", toolCallId: id, name, args });

test("a tool_call opens a running row", () => {
  const tools = foldToolEvent(undefined, call("c1"), 1000);
  assert.ok(tools);
  assert.equal(tools.length, 1);
  assert.equal(tools[0].toolCallId, "c1");
  assert.equal(tools[0].name, "bash");
  assert.equal(tools[0].status, "running");
  assert.equal(tools[0].argsPreview, '{"cmd":"ls"}');
  assert.equal(tools[0].startedAt, 1000);
});

test("an update merges into its call by id, keeping the start time", () => {
  const opened = foldToolEvent(undefined, call("c1"), 1000)!;
  const done = foldToolEvent(opened, { kind: "tool_call_update", toolCallId: "c1", status: "completed", resultDigest: "3 files" }, 2000);
  assert.ok(done);
  assert.equal(done.length, 1, "an update must not append a second row");
  assert.equal(done[0].status, "completed");
  assert.equal(done[0].resultDigest, "3 files");
  assert.equal(done[0].startedAt, 1000);
  assert.equal(done[0].updatedAt, 2000);
});

test("an update with no matching call is dropped rather than shown nameless", () => {
  assert.equal(foldToolEvent(undefined, { kind: "tool_call_update", toolCallId: "ghost", status: "failed" }, 1), null);
  const opened = foldToolEvent(undefined, call("c1"), 1)!;
  assert.equal(foldToolEvent(opened, { kind: "tool_call_update", toolCallId: "other", status: "failed" }, 2), null);
});

test("a re-announced call refreshes args without flapping a finished row back to running", () => {
  const opened = foldToolEvent(undefined, call("c1"), 1000)!;
  const done = foldToolEvent(opened, { kind: "tool_call_update", toolCallId: "c1", status: "failed" }, 2000)!;
  const again = foldToolEvent(done, call("c1", "bash", { cmd: "ls -la" }), 3000);
  assert.ok(again);
  assert.equal(again.length, 1);
  assert.equal(again[0].status, "failed");
  assert.equal(again[0].argsPreview, '{"cmd":"ls -la"}');
});

test("unusable frames return null so the caller can skip the render", () => {
  for (const bad of [null, undefined, 42, "tool_call", {}, { kind: "tool_call" }, { kind: "turn_end", toolCallId: "c1" }, { kind: "tool_call", toolCallId: "" }]) {
    assert.equal(foldToolEvent(undefined, bad, 1), null, JSON.stringify(bad) ?? "undefined");
  }
});

test("args are previewed, capped, and survive an unserializable payload", () => {
  assert.equal(previewArgs(undefined), "");
  assert.equal(previewArgs("plain"), "plain");

  const long = previewArgs({ blob: "x".repeat(TOOL_ARGS_MAX * 2) });
  assert.equal(long.length, TOOL_ARGS_MAX + 1, "capped, plus the ellipsis");
  assert.ok(long.endsWith("…"));

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(previewArgs(cyclic), "[unserializable]");
});

test("a turn that never stops calling tools keeps the newest rows only", () => {
  let tools: ToolLive[] | null = null;
  for (let i = 0; i < TOOLS_PER_TURN_MAX + 10; i++) tools = foldToolEvent(tools ?? undefined, call(`c${i}`), i);
  assert.ok(tools);
  assert.equal(tools.length, TOOLS_PER_TURN_MAX);
  assert.equal(tools[0].toolCallId, "c10");
  assert.equal(tools[tools.length - 1].toolCallId, `c${TOOLS_PER_TURN_MAX + 9}`);
});

test("the fold never mutates the list it was given", () => {
  const opened = foldToolEvent(undefined, call("c1"), 1000)!;
  const snapshot = JSON.stringify(opened);
  foldToolEvent(opened, { kind: "tool_call_update", toolCallId: "c1", status: "completed" }, 2000);
  foldToolEvent(opened, call("c2"), 3000);
  assert.equal(JSON.stringify(opened), snapshot);
});
