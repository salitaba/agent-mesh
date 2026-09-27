import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, collectEvents } from "../helpers";
import { createMcpToolset } from "../../apps/mesh-server/src/mcp";
import { mintSeatToken } from "../../packages/core/src/seat-token";
import type { AgentEventToolCall, AgentEventToolCallUpdate, AgentInput, MeshOp, ToolCallRecord } from "../../packages/protocol/src/index";

/**
 * The verification gate on the channel ops actually arrive on.
 *
 * `markCriterionEvidence` downgrades a criterion accepted by a turn that CHECKED
 * nothing to ASSERTED, and it asks `claimIsVerified` how many verification tools
 * the claimer's turn ran. That count used to be written once, after the runtime
 * returned ("Record BEFORE the op loop") — the right moment when ops came back
 * structurally and ran afterwards. Since ops became MCP-only they run DURING the
 * runtime call, through `executeToolOp`, when the count had not been written
 * yet; and an absent count means "no turn in flight, runtime-derived, verified
 * by construction". Every live acceptance was therefore EVIDENCED, whatever the
 * turn had done.
 *
 * These tests drive the acceptance the way a Claude seat does: a real
 * `mesh_approve` tool call through `McpToolset`, made from inside the turn,
 * after the tool frames the adapter would have streamed (`input.onToolEvent`
 * is the supervisor's own live-frame callback). Two more pin the count itself:
 * Claude names mesh calls `mcp__mesh__mesh_*`, which the old `mesh_` prefix test
 * counted as verification, and a call the permission gate refused checked
 * nothing.
 */

const USAGE = { input: 1_000, output: 500, total: 1_500 };

type Mesh = Awaited<ReturnType<typeof makeMesh>>;
type Frame = AgentEventToolCall | AgentEventToolCallUpdate;

function mesh(): Promise<Mesh> {
  return makeMesh({
    agents: [{ id: "po", role: "product-owner", authority: ["requirements.accept"], interests: [] }],
    // Optional, so a comment alone is enough evidence: the claim under test is
    // whether the turn checked anything, not what it cited.
    criteria: [{ id: "polish", description: "nice to have", mandatory: false }],
    stallIdleMs: 600_000,
    stallCooldownMs: 600_000,
    stallNoopRetryMs: 600_000,
  });
}

function mcpCall(m: Mesh) {
  const mcp = createMcpToolset(m.supervisor);
  return async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const tok = mintSeatToken(m.config.meshId, "po", m.kernel.state.activeGoalId);
    const res = (await mcp.handle("po", tok, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    return JSON.parse(res.result.content[0]!.text) as Record<string, unknown>;
  };
}

async function satisfied(m: Mesh): Promise<{ status?: string; verified?: boolean; toolCalls?: number }> {
  const evt = (await collectEvents(m)).filter((e) => e.type === "requirement.satisfied").at(-1);
  const payload = evt?.payload as { verified?: boolean; evidence?: { toolCalls?: number } } | undefined;
  const status = m.kernel.state.goals.get(m.kernel.state.activeGoalId!)?.acceptanceCriteria.find((c) => c.id === "polish")?.status;
  return { status, verified: payload?.verified, toolCalls: payload?.evidence?.toolCalls };
}

/**
 * One `po` turn that streams `before` as live tool frames, then accepts the
 * criterion through the MCP bridge (announcing that call the way the adapter
 * does), and ends. Returns what the gate decided and what the seat was told.
 */
async function acceptMidTurn(before: Frame[]): Promise<{ status?: string; verified?: boolean; toolCalls?: number; answer: Record<string, unknown> }> {
  const m = await mesh();
  try {
    const call = mcpCall(m);
    let answer: Record<string, unknown> = {};
    let ran = false;
    stub(m).setScript("po", async (input: AgentInput) => {
      if (ran) return { operations: [{ op: "wait" } as MeshOp], tokensUsed: USAGE };
      ran = true;
      for (const f of before) input.onToolEvent?.(f);
      const args = { subject: "criterion:polish", comment: "checked" };
      input.onToolEvent?.({ kind: "tool_call", toolCallId: "accept", name: "mcp__mesh__mesh_approve", args });
      answer = await call("mesh_approve", args);
      input.onToolEvent?.({ kind: "tool_call_update", toolCallId: "accept", status: "completed" });
      // What `collectAgentOutput` would have folded the frames into.
      const toolCalls: ToolCallRecord[] = [];
      for (const f of [...before, { kind: "tool_call", toolCallId: "accept", name: "mcp__mesh__mesh_approve", args } as Frame]) {
        if (f.kind === "tool_call") toolCalls.push({ name: f.name, args: f.args, resultDigest: "" });
      }
      return { operations: [], text: "accepted the criterion", typedOps: true, toolCalls, tokensUsed: USAGE };
    });
    await m.supervisor.activateAgent("po", { kind: "manual" }, { explicit: true });
    await waitFor("po's turn to close", () => m.supervisor.getRecentTurns().some((t) => t.agentId === "po" && t.status !== "running"));
    return { ...(await satisfied(m)), answer };
  } finally {
    await m.cleanup();
  }
}

const opened = (id: string, name: string): Frame => ({ kind: "tool_call", toolCallId: id, name, args: {} });
const closed = (id: string, status: "completed" | "failed" = "completed"): Frame => ({ kind: "tool_call_update", toolCallId: id, status, ...(status === "failed" ? { error: "denied" } : {}) });

test("live gate: a turn that read a file and then accepted over MCP lands EVIDENCED", async () => {
  const r = await acceptMidTurn([opened("r1", "Read"), closed("r1")]);
  assert.equal(r.answer.ok, true, JSON.stringify(r.answer));
  assert.equal(r.status, "EVIDENCED");
  assert.equal(r.verified, true);
  assert.equal(r.toolCalls, 1, "the completed Read, and not the mesh call that made the claim");
});

test("live gate: a turn that only called mesh tools and then accepted over MCP lands ASSERTED", async () => {
  // Every call is a mesh call as Claude names it: the inbox read completed, and
  // the approve itself was announced before it ran. Neither checked anything.
  const r = await acceptMidTurn([opened("i1", "mcp__mesh__mesh_inbox"), closed("i1")]);
  assert.equal(r.answer.ok, true, "the acceptance is still recorded — the work may be real");
  assert.equal(r.status, "ASSERTED", "a mid-turn claim from a turn that verified nothing must not close the criterion");
  assert.equal(r.verified, false);
  assert.equal(r.toolCalls, 0);
  assert.match(String(r.answer.note), /ASSERTED, not EVIDENCED/, "and the seat is told so on the call itself");
});

test("live gate: a turn whose only non-mesh call was denied lands ASSERTED", async () => {
  const r = await acceptMidTurn([opened("b1", "Bash"), closed("b1", "failed")]);
  assert.equal(r.status, "ASSERTED", "a refused Bash ran nothing, so it proved nothing");
  assert.equal(r.verified, false);
});

test("live gate: a call still running when the claim is made has not verified anything yet", async () => {
  // Announced, never closed: the claim raced the check it would have rested on.
  const r = await acceptMidTurn([opened("t1", "Bash")]);
  assert.equal(r.status, "ASSERTED");
});

test("between turns: an MCP acceptance with no turn in flight is a seat's claim, not the runtime's", async () => {
  const m = await mesh();
  try {
    // Nothing activates `po`, so no turn is ever in flight. The bridge still
    // answers — a CLI can finish a call after the mesh settled its turn — and
    // that must not read as the operator/runtime path, which is verified by
    // construction.
    stub(m).setScript("po", async () => ({ operations: [{ op: "wait" } as MeshOp], tokensUsed: USAGE }));
    const answer = await mcpCall(m)("mesh_approve", { subject: "criterion:polish", comment: "checked" });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    const r = await satisfied(m);
    assert.equal(r.status, "ASSERTED");
    assert.equal(r.verified, false);
    assert.equal(m.supervisor.isTurnInFlight("po"), false);
    // And the operator path it must not be confused with stays verified.
    const human = await m.supervisor.recordDecision("human", "accept", "criterion:polish", undefined, "operator checked");
    assert.equal(human.ok, true, human.reason);
    assert.equal((await satisfied(m)).status, "EVIDENCED");
  } finally {
    await m.cleanup();
  }
});

// ---- the structural channel (stub, http): ops returned, run after the call ----

async function acceptStructurally(toolCalls: ToolCallRecord[]): Promise<{ status?: string; verified?: boolean; toolCalls?: number }> {
  const m = await mesh();
  try {
    stub(m).setScript("po", [
      { operations: [{ op: "approve", subject: "criterion:polish", comment: "checked" } as MeshOp], toolCalls, tokensUsed: USAGE },
      { operations: [{ op: "wait" } as MeshOp], tokensUsed: USAGE },
    ]);
    await m.supervisor.activateAgent("po", { kind: "manual" }, { explicit: true });
    await waitFor("the criterion to be recorded", async () => (await satisfied(m)).verified !== undefined);
    return satisfied(m);
  } finally {
    await m.cleanup();
  }
}

test("structural gate: a reported file read verifies; status-less calls still count", async () => {
  const r = await acceptStructurally([{ name: "Read", args: {}, resultDigest: "d" }]);
  assert.equal(r.status, "EVIDENCED", "a runtime that reports no status must keep working as before");
  assert.equal(r.toolCalls, 1);
});

test("structural gate: `mcp__mesh__mesh_*` calls are mesh calls, not verification", async () => {
  const r = await acceptStructurally([
    { name: "mcp__mesh__mesh_inbox", args: {}, resultDigest: "d", status: "completed" },
    { name: "mesh_run_status", args: {}, resultDigest: "d" },
  ]);
  assert.equal(r.status, "ASSERTED");
  assert.equal(r.toolCalls, 0);
});

test("structural gate: a failed call is not verification", async () => {
  const r = await acceptStructurally([{ name: "Bash", args: { command: "npm test" }, resultDigest: "d", status: "failed", error: "denied" }]);
  assert.equal(r.status, "ASSERTED");
  assert.equal(r.toolCalls, 0);
});
