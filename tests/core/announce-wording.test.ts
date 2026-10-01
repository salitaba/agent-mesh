import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpToolset } from "../../apps/mesh-server/src/mcp";
import { buildAgentContext, renderContextInstructions } from "../../packages/core/src/context";
import { mintSeatToken } from "../../packages/core/src/seat-token";
import { makeMesh } from "../helpers";

/**
 * An announcement is for what can wait, and a seat is told so.
 *
 * `mesh_announce` was described as "say something that obliges nobody to answer; omit `to` and every
 * seat hears it", and "costs no one a turn". Both read as "reaches everyone, now". It reaches
 * everyone's MAILBOX: a broadcast wakes only the seats that list `message.sent` among their
 * `interests` (none of the shipped ones does) and a directed INFORM wakes nobody
 * (`tests/scheduler/broadcast-reach.test.ts`, `broadcast-retry.test.ts`). The sixth cronlite run's
 * tech-lead announced to the whole mesh that the CLI patch was REJECTED and had to be reworked; the
 * only seat that could rework it was never woken, and the mission completed without that patch.
 *
 * The behaviour is deliberate (it is what makes an announcement cheap), so the words change: what a
 * seat must ACT on is a `mesh_call`, and the tool, the briefing and the typed `mesh_broadcast` say so.
 */

const SEATS = [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "git.commit"], interests: [] },
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review", "git.merge"], authority: ["implementation.approve"], interests: [] },
];
const COMM = { dev: ["lead"], lead: ["dev"] };

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

async function descriptions(m: Mesh, agentId: string): Promise<Map<string, string>> {
  const mcp = createMcpToolset(m.supervisor);
  const token = mintSeatToken(m.config.meshId, agentId, m.kernel.state.activeGoalId);
  const res = (await mcp.handle(agentId, token, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })) as { result: { tools: Array<{ name: string; description: string }> } };
  return new Map(res.result.tools.map((t) => [t.name, t.description]));
}

const briefing = (m: Mesh, id: string): string => renderContextInstructions(buildAgentContext({ config: m.config, kernel: m.kernel }, id));

test("contracts: the tool and the briefing say an announcement wakes no one, and point at mesh_call for what must be acted on", async () => {
  const m = await makeMesh({ agents: SEATS, mayContact: COMM, mode: "parked", bus: { vocabulary: "contracts" } } as never);
  try {
    const tool = (await descriptions(m, "lead")).get("mesh_announce") ?? "";
    assert.match(tool, /obliges nobody to answer, and wakes nobody: a seat reads it the next time it takes a turn/);
    assert.match(tool, /If a seat has to ACT on what you say \(a patch to rework, a blocker, something to merge\)[^.]*use mesh_call/);
    assert.doesNotMatch(tool, /every seat in the mesh hears it/, "'hears' read as 'is woken'");

    const text = briefing(m, "lead");
    const common = text.split("\n").find((l) => l.startsWith("Common tools:")) ?? "";
    assert.match(common, /mesh_announce \(payload\/to\/note — say something that obliges nobody to answer\. It wakes no one: a seat reads it the next time it takes a turn, so what a seat must ACT on is a `mesh_call`, not an announcement; omit `to` and it goes to every seat\)/);
    assert.match(text, /`mesh_announce` — it obliges no one and wakes no one: a seat reads it the next time it takes a turn, so it is for what can wait\. What a seat must act on \(a patch to rework, a blocker, something to merge\) is a `mesh_call` to that seat, which does wake it\./);
    assert.doesNotMatch(text, /costs no one a turn/, "the old line promised cheapness and read as promising delivery");
  } finally {
    await m.cleanup();
  }
});

test("typed: mesh_broadcast says the same, in its tool description and in the briefing", async () => {
  const m = await makeMesh({ agents: SEATS, mayContact: COMM, mode: "parked" } as never);
  try {
    const tool = (await descriptions(m, "lead")).get("mesh_broadcast") ?? "";
    assert.match(tool, /It wakes no one: a seat reads it the next time it takes a turn, so a seat that must act on it needs a request addressed to it\./);
    const line = briefing(m, "lead").split("\n").find((l) => l.startsWith("- mesh_broadcast")) ?? "";
    assert.match(line, /inform everyone you may contact; it wakes no one, so a seat that must act on it needs a targeted mesh_send ask instead\./);
  } finally {
    await m.cleanup();
  }
});
