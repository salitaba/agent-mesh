import { test } from "node:test";
import assert from "node:assert/strict";
import { createMcpToolset } from "../../apps/mesh-server/src/mcp";
import { buildAgentContext, renderContextInstructions } from "../../packages/core/src/context";
import { mintSeatToken } from "../../packages/core/src/seat-token";
import {
  HIDDEN_BY_CONTRACT_VOCABULARY,
  hiddenToolsFor,
  meshToolName,
  refusedToolCalls,
  toolAdvertised,
  toolAlternative,
  type AgentDefinition,
} from "../../packages/protocol/src/index";
import { makeMesh } from "../helpers";

/**
 * What a briefing names is what the manifest carries.
 *
 * `bus.vocabulary: "contracts"` hides seven tools from the seat's tool list, and three
 * capability-gated ones are hidden from every seat that lacks the grant. The briefing kept naming
 * them: "Common tools: … mesh_send … mesh_request_review … mesh_escalate", "mesh_respond",
 * "mesh_broadcast", "then `mesh_merge`", and a sentence saying `mesh_send` "is not in your tool
 * list but still works". It does not work for any client that checks a name against the list it
 * was given, and Claude Code is one: it refuses the call with "No such tool available" before it
 * leaves the machine. Seats made 8, 14 and 14 such calls in three live runs (the fourth: seven
 * `mesh_send`, three `mesh_respond`, two `mesh_merge` from a developer who cannot merge, one
 * `mesh_broadcast`, one `mesh_request_review`, of 370 tool calls), each a turn's worth of intent
 * that never arrived.
 *
 * The rule now lives in one place (`tool-visibility.ts`) and both the manifest and the prose read it.
 * The last group of tests is the one that would catch a third hand: it renders every seat's whole
 * briefing and checks each tool it names against that seat's real `tools/list`.
 */

const def = (over: Partial<AgentDefinition> = {}): AgentDefinition => ({ id: "x", role: "r", capabilities: [], authority: [], ...over }) as AgentDefinition;

// ------------------------------------------------------------- the rule

test("the collapsed vocabulary hides exactly the tools a contract or the new pair replaces", () => {
  const dev = def();
  for (const tool of ["mesh_send", "mesh_respond", "mesh_broadcast", "mesh_request", "mesh_request_review", "mesh_research_request", "mesh_escalate"]) {
    assert.equal(toolAdvertised(tool, dev, "contracts"), false, `${tool} is hidden under contracts`);
    assert.equal(toolAdvertised(tool, dev, undefined), true, `${tool} is shown on a typed mesh`);
  }
  for (const tool of ["mesh_reply", "mesh_announce"]) {
    assert.equal(toolAdvertised(tool, dev, "contracts"), true, `${tool} is shown under contracts`);
    assert.equal(toolAdvertised(tool, dev, undefined), false, `${tool} is not shown on a typed mesh`);
  }
  for (const tool of ["mesh_call", "mesh_contracts", "mesh_approve", "mesh_done", "mesh_artifact_publish"]) {
    assert.equal(toolAdvertised(tool, dev, "contracts"), true, `${tool} is always shown`);
  }
});

test("a grant-gated tool is shown to the seat that holds the grant, in either vocabulary", () => {
  const merger = def({ capabilities: ["git.merge"] });
  const vetoer = def({ authority: ["quality.veto"] });
  const ratifier = def({ authority: ["architecture.approve"] });
  for (const vocabulary of [undefined, "contracts"] as const) {
    assert.equal(toolAdvertised("mesh_merge", merger, vocabulary), true);
    assert.equal(toolAdvertised("mesh_merge", def(), vocabulary), false);
    assert.equal(toolAdvertised("mesh_veto", vetoer, vocabulary), true);
    assert.equal(toolAdvertised("mesh_veto", def(), vocabulary), false);
    assert.equal(toolAdvertised("mesh_decision_ratify", ratifier, vocabulary), true);
    assert.equal(toolAdvertised("mesh_decision_ratify", def(), vocabulary), false);
    assert.equal(toolAdvertised("mesh_submit_result", def({ mode: "service" } as never), vocabulary), true);
  }
});

test("hiddenToolsFor lists what the prose must leave out, per seat", () => {
  assert.deepEqual(hiddenToolsFor(def({ capabilities: ["git.merge"], authority: ["quality.veto", "architecture.approve"], mode: "service" } as never), undefined), []);
  const typed = hiddenToolsFor(def(), undefined);
  assert.deepEqual([...typed].sort(), ["mesh_decision_ratify", "mesh_merge", "mesh_submit_result", "mesh_veto"]);
  const collapsed = hiddenToolsFor(def({ capabilities: ["git.merge"] }), "contracts");
  for (const tool of Object.keys(HIDDEN_BY_CONTRACT_VOCABULARY)) assert.ok(collapsed.includes(tool), `${tool} is left out under contracts`);
  assert.ok(!collapsed.includes("mesh_merge"), "a seat that can merge keeps it");
  assert.ok(!collapsed.includes("mesh_reply") && !collapsed.includes("mesh_announce"), "the pair that replaces them is never on the list");
});

test("a refused tool is told what to use instead, or why it does not have it", () => {
  assert.match(toolAlternative("mesh_send"), /`mesh_call` to ask, `mesh_reply` to answer, `mesh_announce` to tell/);
  assert.match(toolAlternative("mesh_respond"), /`mesh_reply`/);
  assert.match(toolAlternative("mesh_request_review"), /`mesh_call review\.artifact`/);
  assert.match(toolAlternative("mesh_merge"), /`git\.merge`/);
  assert.match(toolAlternative("mesh_invented"), /not one of the tools this mesh gives you/);
});

// ------------------------------------------------ the calls the client refused

test("refusedToolCalls finds the mesh tools the client would not run, once each with a count", () => {
  const refusal = (name: string) => ({ name, status: "failed", error: `<tool_use_error>Error: No such tool available: ${name}</tool_use_error>` });
  const found = refusedToolCalls([
    refusal("mcp__mesh__mesh_send"),
    refusal("mcp__mesh__mesh_send"),
    refusal("mcp__mesh__mesh_respond"),
    // Not refused: the mesh ran it and said no, which an op result already records.
    { name: "mcp__mesh__mesh_call", status: "failed", error: '{"ok":false,"error":"request does not match contract review.artifact"}' },
    // Not the mesh's tools: a failing shell command is the seat's business.
    { name: "Bash", status: "failed", error: "No such tool available: Bash" },
    { name: "mcp__mesh__mesh_done", status: "completed" },
    // The server's own wording, for a client that does reach it.
    { name: "mesh_frobnicate", status: "failed", error: "unknown tool mesh_frobnicate" },
  ]);
  assert.deepEqual(found, [
    { tool: "mesh_send", times: 2 },
    { tool: "mesh_respond", times: 1 },
    { tool: "mesh_frobnicate", times: 1 },
  ]);
  assert.deepEqual(refusedToolCalls(undefined), []);
  assert.equal(meshToolName("mcp__mesh__mesh_send"), "mesh_send");
  assert.equal(meshToolName("Bash"), undefined);
});

// ---------------------------------------------- the manifest and the prose agree

const SEATS = [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "git.commit"], interests: [] },
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review", "git.merge"], authority: ["implementation.approve", "architecture.approve"], interests: [] },
  { id: "qa", role: "qa", capabilities: ["repository.read", "test.execute"], authority: ["quality.veto", "quality.block"], interests: [] },
];
const COMM = { dev: ["lead", "qa"], lead: ["dev", "qa"], qa: ["dev", "lead"] };

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

async function advertised(m: Mesh, agentId: string): Promise<Set<string>> {
  const mcp = createMcpToolset(m.supervisor);
  const token = mintSeatToken(m.config.meshId, agentId, m.kernel.state.activeGoalId);
  const res = (await mcp.handle(agentId, token, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })) as { result: { tools: Array<{ name: string }> } };
  return new Set(res.result.tools.map((t) => t.name));
}

/**
 * The prose a seat reads about its tools, minus the two places that name a tool on purpose: the
 * mapping lines (a brief's word on the left of an arrow, which the section says is not a tool) and
 * the sentence that lists what the seat does not have.
 */
function namedAsCallable(instructions: string): Set<string> {
  const prose = instructions
    .split("\n")
    .filter((l) => !(l.startsWith("- `") && l.includes("→ `mesh_call ")))
    .filter((l) => !l.startsWith("Not in your tool list, so not callable:"))
    .join("\n");
  return new Set(prose.match(/\bmesh_[a-z_]+\b/g) ?? []);
}

for (const vocabulary of ["contracts", "typed"] as const) {
  test(`${vocabulary}: every tool the briefing names as callable is in that seat's tools/list`, async () => {
    const m = await makeMesh({ agents: SEATS, mayContact: COMM, mode: "parked", bus: { vocabulary } } as never);
    try {
      for (const seat of SEATS) {
        const instructions = renderContextInstructions(buildAgentContext({ config: m.config, kernel: m.kernel }, seat.id));
        const manifest = await advertised(m, seat.id);
        const absent = [...namedAsCallable(instructions)].filter((t) => !manifest.has(t)).sort();
        assert.deepEqual(absent, [], `${seat.id} (${vocabulary}) is told to call tools it does not have`);
      }
    } finally {
      await m.cleanup();
    }
  });
}

test("contracts: the seat is told what it does not have, and that calling one does nothing", async () => {
  const m = await makeMesh({ agents: SEATS, mayContact: COMM, mode: "parked", bus: { vocabulary: "contracts" } } as never);
  try {
    const dev = renderContextInstructions(buildAgentContext({ config: m.config, kernel: m.kernel }, "dev"));
    const gone = dev.split("\n").find((l) => l.startsWith("Not in your tool list, so not callable:"));
    assert.ok(gone, "the sentence is there");
    for (const tool of Object.keys(HIDDEN_BY_CONTRACT_VOCABULARY)) assert.ok(gone.includes(`\`${tool}\``), `${tool} is named as not callable`);
    assert.match(gone, /"No such tool available"/);
    assert.match(gone, /never reaches the mesh/);
    assert.doesNotMatch(dev, /still works/, "the old promise about mesh_send is gone");
    // The tools that took their place are in the list a seat reads first.
    const common = dev.split("\n").find((l) => l.startsWith("Common tools:"))!;
    assert.match(common, /mesh_reply \(/);
    assert.match(common, /mesh_announce \(/);
    assert.doesNotMatch(common, /mesh_send|mesh_request_review|mesh_escalate|mesh_respond|mesh_broadcast/);
  } finally {
    await m.cleanup();
  }
});

test("a seat that cannot merge is not told a patch lands by `mesh_merge`; the one that can, is", async () => {
  const m = await makeMesh({ agents: SEATS, mayContact: COMM, mode: "parked" } as never);
  try {
    const dev = renderContextInstructions(buildAgentContext({ config: m.config, kernel: m.kernel }, "dev"));
    assert.doesNotMatch(dev, /mesh_merge/);
    assert.match(dev, /merged by a seat that holds `git\.merge`, which you do not: you have no merge tool, so ask that seat once the patch is MERGEABLE/);
    const lead = renderContextInstructions(buildAgentContext({ config: m.config, kernel: m.kernel }, "lead"));
    assert.match(lead, /mesh_commit \/ mesh_request_commit \/ mesh_merge — version-control moves/);
    assert.match(lead, /and then `mesh_merge`; approval alone lands nothing/);
    // The veto tool goes the same way: named to the seat that has it, left out for the rest.
    assert.match(renderContextInstructions(buildAgentContext({ config: m.config, kernel: m.kernel }, "qa")), /`mesh_reject`, `mesh_veto`, `mesh_block`/);
    assert.match(dev, /`mesh_reject`, `mesh_block`, same shape/);
  } finally {
    await m.cleanup();
  }
});

test("under contracts, the tools a seat keeps are not described in terms of one it lost", async () => {
  const collapsed = await makeMesh({ agents: SEATS, mayContact: COMM, mode: "parked", bus: { vocabulary: "contracts" } } as never);
  const typed = await makeMesh({ agents: SEATS, mayContact: COMM, mode: "parked" } as never);
  try {
    const describe = async (m: Mesh, name: string): Promise<string> => {
      const mcp = createMcpToolset(m.supervisor);
      const token = mintSeatToken(m.config.meshId, "dev", m.kernel.state.activeGoalId);
      const res = (await mcp.handle("dev", token, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })) as { result: { tools: Array<{ name: string; description: string }> } };
      return res.result.tools.find((t) => t.name === name)?.description ?? "";
    };
    for (const name of ["mesh_call", "mesh_collab", "mesh_approve", "mesh_reject"]) {
      const text = await describe(collapsed, name);
      assert.ok(text.length > 0, `${name} is in the collapsed manifest`);
      assert.doesNotMatch(text, /mesh_send|mesh_respond|mesh_request\b/, `${name} points at a tool the manifest does not have`);
    }
    // A typed mesh reads what it always read.
    assert.match(await describe(typed, "mesh_call"), /Preferred over mesh_send/);
    assert.match(await describe(typed, "mesh_collab"), /Prefer mesh_request when/);
  } finally {
    await collapsed.cleanup();
    await typed.cleanup();
  }
});
