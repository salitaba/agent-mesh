import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { createMcpToolset } from "../../apps/mesh-server/src/mcp";
import { mintSeatToken } from "../../packages/core/src/seat-token";
import { makeMesh } from "../helpers";

/**
 * A seat is told what completing a task means where it decides to complete one.
 *
 * In every one of the eight cronlite runs from the eighth to the fifteenth, QA's first turn claimed its verification task and the
 * task was COMPLETED by the end of that turn, with a summary that says it is waiting: "awaiting developer implementation to proceed
 * with testing" (8th), "Identified blocker: cronlite implementation not yet merged" (10th), "Waiting for developer to implement"
 * (13th), "Implementation not yet available - standing by to test once code appears in repository" (15th, 19 seconds after the
 * claim, five minutes before the first line was merged). No seat called `mesh_task_complete`: QA's turn was claim, reply, plan,
 * wait, `mesh_done`, and `mesh_done` completes the task its seat holds. The tool was described as "Finish your current activation
 * turn", so no seat could know; 23 of the 46 task completions of those runs were made that way, 19 of them in a turn that also
 * waited. The board then says "QA verification: done" for the rest of the run, and QA's real completion, when it finally has
 * results, is refused ("task is COMPLETED").
 *
 * The side effect is now said where the seat decides to call the tool, `mesh_task_complete` says what completing means, and the QA
 * role prompt says when to claim and how to wait.
 */

const AGENTS = [
  { id: "pm", role: "product-manager", capabilities: ["repository.read", "task.assign"], interests: [] },
  { id: "qa", role: "qa", capabilities: ["repository.read", "test.execute", "test.write"], interests: [] },
];
const COMM = { pm: ["qa"], qa: ["pm"] };

async function tools() {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" } as never);
  try {
    const mcp = createMcpToolset(m.supervisor);
    const token = mintSeatToken(m.config.meshId, "qa", m.kernel.state.activeGoalId);
    const res = (await mcp.handle("qa", token, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })) as {
      result: { tools: Array<{ name: string; description: string; inputSchema: { properties: Record<string, { description?: string }> } }> };
    };
    return res.result.tools;
  } finally {
    await m.cleanup();
  }
}

test("mesh_task_complete says completing is DONE, not an acknowledgement, and what to do when the work cannot start", async () => {
  const complete = (await tools()).find((t) => t.name === "mesh_task_complete");
  assert.ok(complete, "a seat has the tool");
  assert.match(complete.description, /says the work the task asks for is DONE and exists \(an artifact, a commit, a verdict\)/);
  assert.match(complete.description, /not an acknowledgement, it cannot be undone, and every seat reads the task as finished/);
  assert.match(complete.description, /If the work cannot start yet \(nothing to test, nothing to review\), leave the task claimed, tell whoever delegated it when you will start, and mesh_wait\. mesh_done completes a claimed task too\./);
  assert.match(complete.inputSchema.properties.summary?.description ?? "", /^what was done \(not what you will do or are waiting for\)$/);
});

test("mesh_done says that it completes the claimed task, and what to do when the work is not done", async () => {
  const done = (await tools()).find((t) => t.name === "mesh_done");
  assert.ok(done, "a seat has the tool");
  assert.match(done.description, /If you hold a claimed task, finishing COMPLETES it with this summary, exactly as mesh_task_complete does/);
  assert.match(done.description, /end a turn with mesh_done only when the task's work is done/);
  assert.match(done.description, /Waiting for something, or not started yet\? Say so \(mesh_wait\) and end the turn without mesh_done: the task stays yours\./);
  assert.match(done.inputSchema.properties.summary?.description ?? "", /the task's completion summary when you hold a claimed task/);
});

test("mesh_task_claim says to claim a task you can start now", async () => {
  const claim = (await tools()).find((t) => t.name === "mesh_task_claim");
  assert.ok(claim);
  assert.match(claim.description, /when you can start it now: a claimed task is yours until you complete it\./);
});

test("the QA role prompt says when to claim and complete the verification task, and what to do until then", () => {
  const role = fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "roles", "qa.md"), "utf8");
  const at = role.indexOf("## Your verification task");
  assert.ok(at >= 0, "the section exists");
  const section = role.slice(at, role.indexOf("\n## ", at + 5));
  assert.match(section, /Claim it only when there is something to verify/);
  assert.match(section, /\*\*`mesh_done` completes the task you hold\*\*, with your summary, and so does `mesh_task_complete`/);
  assert.match(section, /it is not an acknowledgement, it cannot be undone, and every seat reads it as finished/);
  assert.match(section, /Do not claim\. Answer the delegate with when you will start \(`replyTo` its message id\), `mesh_wait`, and end the turn without `mesh_done`/);
  assert.match(section, /`patch\.ready` and `implementation\.completed` wake you/);
  assert.ok(at < role.indexOf("## Verdict contract"), "and it comes before the verdict contract, which a QA that has something to verify reads next");
});
