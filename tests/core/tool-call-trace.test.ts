import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor } from "../helpers";
import type { MeshOp, ToolCallRecord } from "../../packages/protocol/src/index";
import {
  MAX_TRACE_MESH_TOOLCALLS,
  MAX_TRACE_TOOLCALLS,
  TOOL_ARG_STRING_MAX,
  boundToolArgs,
  isMeshToolCall,
  traceToolCalls,
} from "../../packages/core/src/turn-tracker";

/**
 * What a turn record keeps of the turn's tool calls.
 *
 * Two defects, one record. `args` were stored verbatim, so a `Write` carried the
 * whole file it wrote — one 43.9k-char call was seen live — into the persisted
 * turn ring and out of `/turns/:id`. And one cap of 30 covered every tool, so a
 * seat that read and grepped first and acted on the mesh last lost its ops: on a
 * 54-call turn the ledger had no arguments for the last 10 of them.
 *
 * Strings inside `args` are now clipped to TOOL_ARG_STRING_MAX with each clip's
 * original length in `argsClipped` (dotted path → length — the contract the
 * dashboard reads), and mesh calls get their own allowance beside the 30. Each
 * kept call carries `index`, its 0-based position among ALL the turn's calls,
 * so a row can be numbered truthfully once calls past #30 are skipped.
 */

test("boundToolArgs: long strings are clipped at any depth, and each clip is recorded by path", () => {
  const big = "x".repeat(43_900);
  const edit = "y".repeat(5_000);
  const { args, argsClipped } = boundToolArgs({
    file_path: "src/a.ts",
    content: big,
    edits: [{ old_string: "short", new_string: edit }, { old_string: "a", new_string: "b" }],
    n: 3,
    ok: true,
    none: null,
  });
  const a = args as { file_path: string; content: string; edits: Array<{ old_string: string; new_string: string }>; n: number; ok: boolean; none: null };
  assert.equal(a.content.length, TOOL_ARG_STRING_MAX);
  assert.equal(a.content, big.slice(0, TOOL_ARG_STRING_MAX), "the head of the string, unaltered");
  assert.equal(a.edits[0]!.new_string.length, TOOL_ARG_STRING_MAX);
  assert.deepEqual(argsClipped, { content: 43_900, "edits.0.new_string": 5_000 });
  // Everything else passes through as it was.
  assert.equal(a.file_path, "src/a.ts");
  assert.deepEqual(a.edits[1], { old_string: "a", new_string: "b" });
  assert.equal(a.n, 3);
  assert.equal(a.ok, true);
  assert.equal(a.none, null);
});

test("boundToolArgs: nothing clipped means no argsClipped, and exactly-at-limit is not clipped", () => {
  const atLimit = "z".repeat(TOOL_ARG_STRING_MAX);
  const out = boundToolArgs({ command: "npm test", body: atLimit });
  assert.deepEqual(out, { args: { command: "npm test", body: atLimit } });
  assert.equal("argsClipped" in out, false, "absent, not {} — a reader tests presence");
  // A bare string argument is keyed by the empty path.
  assert.deepEqual(boundToolArgs("q".repeat(TOOL_ARG_STRING_MAX + 1)).argsClipped, { "": TOOL_ARG_STRING_MAX + 1 });
});

test("isMeshToolCall: the mesh's bus tools however the client spelled them", () => {
  assert.equal(isMeshToolCall("mcp__mesh__mesh_send"), true, "how Claude reports an MCP tool");
  assert.equal(isMeshToolCall("mesh_send"), true, "the bare name the bridge advertises");
  assert.equal(isMeshToolCall("mcp__bus__mesh_artifact_publish"), true, "the server name is the client's config, not the mesh's");
  assert.equal(isMeshToolCall("Read"), false);
  assert.equal(isMeshToolCall("mcp__github__create_issue"), false, "another MCP server's tool is a real tool");
  assert.equal(isMeshToolCall("Bash"), false);
});

const call = (name: string, args: unknown = {}): ToolCallRecord => ({ name, args, resultDigest: "d", status: "completed" });

test("traceToolCalls: 30 non-mesh calls plus every mesh op, in execution order", () => {
  // The live shape: a seat reads and greps first and acts on the mesh last.
  const calls = [
    ...Array.from({ length: 40 }, (_, i) => call("Read", { file_path: `f${i}.ts` })),
    ...Array.from({ length: 14 }, (_, i) => call("mcp__mesh__mesh_send", { to: ["pm"], payload: { n: i } })),
  ];
  const kept = traceToolCalls(calls);
  assert.equal(kept.length, MAX_TRACE_TOOLCALLS + 14);
  assert.deepEqual(
    kept.filter((c) => c.name === "Read").map((c) => (c.args as { file_path: string }).file_path),
    Array.from({ length: MAX_TRACE_TOOLCALLS }, (_, i) => `f${i}.ts`),
    "the FIRST 30 non-mesh calls",
  );
  assert.deepEqual(
    kept.filter((c) => c.name !== "Read").map((c) => (c.args as { payload: { n: number } }).payload.n),
    Array.from({ length: 14 }, (_, i) => i),
    "and every op, including the last ten the shared cap used to drop",
  );
  assert.deepEqual(
    kept.map((c) => c.index),
    [...Array.from({ length: MAX_TRACE_TOOLCALLS }, (_, i) => i), ...Array.from({ length: 14 }, (_, i) => 40 + i)],
    "each row keeps its place in the TURN: the ops are calls 40-53, not rows 30-43",
  );
  // Interleaved calls keep their interleaving.
  const mixed = traceToolCalls([call("Read"), call("mesh_send"), call("Grep"), call("mcp__mesh__mesh_done")]);
  assert.deepEqual(mixed.map((c) => c.name), ["Read", "mesh_send", "Grep", "mcp__mesh__mesh_done"]);
  assert.deepEqual(mixed.map((c) => c.index), [0, 1, 2, 3]);
});

test("traceToolCalls: mesh calls have a cap of their own", () => {
  const kept = traceToolCalls(Array.from({ length: MAX_TRACE_MESH_TOOLCALLS + 30 }, (_, i) => call("mcp__mesh__mesh_send", { n: i })));
  assert.equal(kept.length, MAX_TRACE_MESH_TOOLCALLS);
  assert.equal((kept.at(-1)!.args as { n: number }).n, MAX_TRACE_MESH_TOOLCALLS - 1, "the first ones, in order");
  assert.deepEqual(traceToolCalls(undefined), []);
});

test("a turn record keeps bounded args and every op of a 54-call turn", async () => {
  // Streaming, so `toolCalls` is rebuilt from frames by `collectAgentOutput` —
  // the path the Claude runtime takes.
  const m = await makeMesh({ agents: [{ id: "dev", role: "developer", interests: [] }], mayContact: { dev: [] } });
  try {
    stub(m).setStreaming(true);
    const body = "w".repeat(43_900);
    const toolCalls: ToolCallRecord[] = [
      { name: "Write", args: { file_path: "src/big.ts", content: body }, resultDigest: "d0" },
      ...Array.from({ length: 39 }, (_, i) => ({ name: "Read", args: { file_path: `f${i}.ts` }, resultDigest: `r${i}` })),
      ...Array.from({ length: 14 }, (_, i) => ({ name: "mcp__mesh__mesh_remember", args: { key: `k${i}`, value: "v" }, resultDigest: `m${i}` })),
    ];
    stub(m).setScript("dev", [{ operations: [{ op: "done", summary: "wrote and noted" } as MeshOp], toolCalls }, { operations: [{ op: "wait" } as MeshOp] }]);
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the turn", () => m.supervisor.getRecentTurns().some((t) => t.agentId === "dev" && t.status !== "running"));
    const turn = m.supervisor.getRecentTurns().find((t) => t.agentId === "dev" && t.status !== "running")!;

    assert.equal(turn.toolCalls, 54, "the count stays uncapped");
    const detail = turn.toolCallsDetail ?? [];
    assert.equal(detail.length, MAX_TRACE_TOOLCALLS + 14);
    const write = detail[0]!;
    assert.equal(write.name, "Write");
    assert.equal((write.args as { content: string }).content.length, TOOL_ARG_STRING_MAX);
    assert.deepEqual(write.argsClipped, { content: 43_900 }, "the dashboard's contract: dotted path → original length");
    assert.equal(write.status, "completed", "the runtime's outcome survives the bounding");
    assert.deepEqual(
      detail.filter((c) => c.name.startsWith("mcp__mesh__")).map((c) => (c.args as { key: string }).key),
      Array.from({ length: 14 }, (_, i) => `k${i}`),
    );
    assert.equal(write.index, 0);
    assert.deepEqual(
      detail.filter((c) => c.name.startsWith("mcp__mesh__")).map((c) => c.index),
      Array.from({ length: 14 }, (_, i) => 40 + i),
      "the ops are the turn's calls 40-53, and the record says so",
    );
    assert.ok(JSON.stringify(turn).length < 43_900, "no copy of the file body anywhere in the record");
  } finally {
    await m.cleanup();
  }
});
