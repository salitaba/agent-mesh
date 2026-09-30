import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor } from "../helpers";
import type { MeshOp, ToolCallRecord } from "../../packages/protocol/src/index";

/**
 * A call the client refused is the one failure the mesh could not see.
 *
 * Claude Code checks a tool name against the list it was given and refuses one that is not there
 * ("No such tool available") before the call leaves the machine. Nothing reaches the mesh, so no
 * op result records it, and every remark the supervisor writes at the end of a turn is built from
 * op results. The seat read the refusal in its tool result, went on, and its next context said it
 * had done what it meant to. In the fourth cronlite run the pm called `mesh_request_review`, which
 * the collapsed vocabulary hides, then `mesh_wait`: it waited for a review nobody had been asked
 * for. Seats made 8, 14 and 21 such calls in three runs.
 *
 * The end-of-turn note now says it, in the turn record and in the seat's own memory of the turn,
 * with what to use instead.
 */

const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write"], interests: [] },
  { id: "pm", role: "pm", interests: [] },
];

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

const refused = (tool: string): ToolCallRecord => ({
  name: `mcp__mesh__${tool}`,
  args: {},
  resultDigest: "dgx-refused",
  status: "failed",
  error: `<tool_use_error>Error: No such tool available: mcp__mesh__${tool}</tool_use_error>`,
});

/** Run one dev turn that reports `toolCalls` and closes with `ops`. */
async function turnWith(toolCalls: ToolCallRecord[], ops: MeshOp[]) {
  const m = await makeMesh({ agents: AGENTS, mayContact: { dev: ["pm"], pm: ["dev"] } });
  stub(m).setScript("pm", async () => ({ operations: [{ op: "wait" } as MeshOp] }));
  stub(m).setScript("dev", async () => ({ operations: ops, toolCalls }));
  await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
  await waitFor("dev's turn to close", () => m.supervisor.getRecentTurns().some((t) => t.agentId === "dev" && t.status !== "running"));
  await waitFor("the scheduler to drain", () => !m.supervisor.isTurnInFlight("dev") && m.scheduler.running() === 0 && m.scheduler.pending() === 0);
  const turn = m.supervisor.getRecentTurns().find((t) => t.agentId === "dev" && t.status !== "running")!;
  return { m, turn };
}

const memoryOf = (m: Mesh, turnId: string): string => {
  const note = m.kernel.state.memory.get("dev")?.get(`turn:${turnId}`) as { value?: unknown } | undefined;
  return String(note?.value ?? note ?? "");
};

test("a refused call is named in the turn's notices and in the seat's own memory, with what to use instead", async () => {
  const { m, turn } = await turnWith(
    [refused("mesh_send"), refused("mesh_send"), refused("mesh_request_review"), { name: "mcp__mesh__mesh_wait", args: {}, resultDigest: "dgx-ok", status: "completed" }],
    [{ op: "wait" } as MeshOp],
  );
  try {
    const notice = (turn.notices ?? []).find((n) => n.includes("not in your tool list"));
    assert.ok(notice, `expected a notice, got ${JSON.stringify(turn.notices)}`);
    assert.match(notice, /these calls never reached the mesh and did nothing/);
    assert.match(notice, /mesh_send x2 \(use `mesh_call` to ask, `mesh_reply` to answer, `mesh_announce` to tell\)/);
    assert.match(notice, /mesh_request_review \(use `mesh_call review\.artifact`\)/);
    assert.match(notice, /Your tool list is authoritative/);
    assert.ok(turn.summary?.includes(notice), "it rides the summary, which is the seat's next context");
    assert.ok(memoryOf(m, turn.turnId).includes("mesh_request_review"), "and the seat's memory of the turn says so");
  } finally {
    await m.cleanup();
  }
});

test("a call the mesh ran and refused is not a refused tool: the op result already says it", async () => {
  const meshSaidNo: ToolCallRecord = {
    name: "mcp__mesh__mesh_call",
    args: { contract: "review.artifact" },
    resultDigest: "dgx-no",
    status: "failed",
    error: '{"ok":false,"error":"request does not match contract review.artifact: (root) must NOT have additional properties"}',
  };
  const bash: ToolCallRecord = { name: "Bash", args: {}, resultDigest: "dgx-bash", status: "failed", error: "exit 1" };
  const { m, turn } = await turnWith([meshSaidNo, bash], [{ op: "wait" } as MeshOp]);
  try {
    assert.equal((turn.notices ?? []).some((n) => n.includes("not in your tool list")), false);
    assert.equal(turn.summary?.includes("not in your tool list") ?? false, false);
  } finally {
    await m.cleanup();
  }
});

test("a turn with nothing refused reads exactly as it did", async () => {
  const { m, turn } = await turnWith([{ name: "mcp__mesh__mesh_wait", args: {}, resultDigest: "dgx-ok", status: "completed" }], [{ op: "wait" } as MeshOp]);
  try {
    assert.equal((turn.notices ?? []).some((n) => /tool list/.test(n)), false);
  } finally {
    await m.cleanup();
  }
});
