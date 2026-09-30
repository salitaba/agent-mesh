import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor } from "../helpers";
import { settleContinuityCalls } from "../../packages/core/src/turn-tracker";
import type { AgentSession, MeshOp, ToolCallRecord } from "../../packages/protocol/src/index";

/**
 * A handover's continuity call is recorded as it went.
 *
 * `write_continuity` is the whole of a handover turn, and once it lands the supervisor ends the
 * turn under the client to save the model calls that would follow. The client then reports the
 * call, whose result it never delivered, as rejected ("The user doesn't want to proceed with this
 * tool use"), so all 13 handovers of four live runs were audited as a turn whose one tool call
 * failed, beside a `continuity.recorded` event that says it worked. The mesh's own op result is
 * the record of what happened, and it says ok.
 */

/** The client's text for a call it never got a result for: copied from the fourth run's turn audit. */
const ENDED_UNDER_IT =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

const call = (name: string, over: Partial<ToolCallRecord> = {}): ToolCallRecord => ({
  name: `mcp__mesh__${name}`,
  args: { nextIntent: "finish the review" },
  resultDigest: "dgx-8c16b351",
  status: "failed",
  error: ENDED_UNDER_IT,
  ...over,
});

const landed = [{ op: "write_continuity", ok: true }];

// ---------------------------------------------------------------- the rule

test("the continuity call the client reports as ended-under-it is recorded as completed, without its error", () => {
  const [settled] = settleContinuityCalls([call("mesh_write_continuity")], landed)!;
  assert.equal(settled!.status, "completed");
  assert.equal("error" in settled!, false);
  assert.equal(settled!.name, "mcp__mesh__mesh_write_continuity");
  assert.deepEqual(settled!.args, { nextIntent: "finish the review" }, "everything else about the call is kept");
});

test("with nothing landed behind it, the call keeps its error", () => {
  for (const results of [[], [{ op: "write_continuity", ok: false }], [{ op: "done", ok: true }]]) {
    const [kept] = settleContinuityCalls([call("mesh_write_continuity")], results)!;
    assert.equal(kept!.status, "failed");
    assert.equal(kept!.error, ENDED_UNDER_IT);
  }
});

test("a continuity call that failed for another reason keeps that reason", () => {
  const refused = call("mesh_write_continuity", { error: '{"ok":false,"error":"nextIntent is required"}' });
  const [kept] = settleContinuityCalls([refused], landed)!;
  assert.equal(kept!.status, "failed");
  assert.equal(kept!.error, refused.error);
});

test("one landed write settles one call: a refused attempt before it stays refused, and only the interrupted one flips", () => {
  const refused = call("mesh_write_continuity", { error: '{"ok":false,"error":"nextIntent is required"}' });
  const interrupted = call("mesh_write_continuity");
  const out = settleContinuityCalls([refused, interrupted], landed)!;
  assert.deepEqual(out.map((c) => c.status), ["failed", "completed"]);
  // Two interrupted-looking calls and one landed write: the second is not vouched for.
  const both = settleContinuityCalls([interrupted, call("mesh_write_continuity")], landed)!;
  assert.deepEqual(both.map((c) => c.status), ["completed", "failed"]);
});

test("another tool the client ended under itself is not a continuity call, whatever landed", () => {
  const done = call("mesh_done");
  const [kept] = settleContinuityCalls([done], landed)!;
  assert.equal(kept!.status, "failed", "only the call that IS the record is vouched for by the record");
});

test("a turn with no tool calls has nothing to settle", () => {
  assert.equal(settleContinuityCalls(undefined, landed), undefined);
  assert.deepEqual(settleContinuityCalls([], landed), []);
});

// -------------------------------------------------------------- the turn

const writeOp = (): MeshOp => ({ op: "write_continuity", nextIntent: "finish the migration review", beliefs: [], rejected: [] }) as unknown as MeshOp;

async function handoverTurn(kind: "handover" | "ordinary") {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] }],
    mayContact: { dev: [] },
    mode: "live",
    stallIdleMs: 600_000,
    stallCooldownMs: 600_000,
    stallNoopRetryMs: 600_000,
  });
  // The runtime is told to end the turn once the record lands; the stub has no session to end.
  (stub(m) as unknown as { endTurn: (s: AgentSession) => Promise<void> }).endTurn = async () => undefined;
  stub(m).setScript("dev", async (input) => {
    stub(m).clearRotation("dev");
    // The Claude channel: the tool runs DURING the call, through the mesh, and the client's record of it is what it is.
    if (input.suppressRotation === true) {
      const res = await m.supervisor.executeToolOp("dev", writeOp());
      assert.equal(res.ok, true, `fixture: the continuity landed (${res.reason ?? ""})`);
    }
    return {
      operations: [],
      typedOps: true,
      toolCalls: [call("mesh_write_continuity")],
    };
  });
  if (kind === "handover") stub(m).armRotation("dev");
  await m.supervisor.activateAgent("dev", { kind: "manual", note: "go" });
  await waitFor("dev's turn to close", () => m.supervisor.getRecentTurns().some((t) => t.agentId === "dev" && t.status !== "running"));
  await waitFor("the mesh to go quiet", () => m.scheduler.pending() === 0 && m.scheduler.running() === 0);
  return { m, turn: m.supervisor.getRecentTurns().filter((t) => t.agentId === "dev" && t.status !== "running").sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))[0]! };
}

test("a handover turn's record says its continuity call completed, as the continuity.recorded event does", async () => {
  const { m, turn } = await handoverTurn("handover");
  try {
    assert.equal((await m.store.read({ types: ["continuity.recorded"] })).length, 1, "the log says it landed");
    const calls = turn.toolCallsDetail ?? [];
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.name, "mcp__mesh__mesh_write_continuity");
    assert.equal(calls[0]!.status, "completed");
    assert.equal(calls[0]!.error, undefined);
  } finally {
    await m.cleanup();
  }
});

test("outside a handover nothing is settled: the same record stays as the client wrote it", async () => {
  const { m, turn } = await handoverTurn("ordinary");
  try {
    assert.equal((await m.store.read({ types: ["continuity.recorded"] })).length, 0);
    const calls = turn.toolCallsDetail ?? [];
    assert.equal(calls[0]!.status, "failed");
    assert.match(calls[0]!.error ?? "", /The user doesn't want to proceed/);
  } finally {
    await m.cleanup();
  }
});
