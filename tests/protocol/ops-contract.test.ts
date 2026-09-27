import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { renderContextInstructions, buildAgentContext } from "../../packages/core/src/context";
import type { AgentContextBundle } from "../../packages/protocol/src/index";
import { makeMesh } from "../helpers";

/**
 * The ops contract in the agent context is the ONLY place an agent learns what
 * moves exist. Anything implemented but missing from it is, from the model's
 * point of view, not part of the system.
 *
 * On a live mission 18 of 30 ops were undocumented — including `approve`, the
 * only op that can satisfy an acceptance criterion. The result: correct work
 * shipped (code merged, tests green) and then the mission stalled forever at
 * 1/5 criteria, because nobody could convert that work into evidence. The PM
 * repeatedly attempted acceptance without the mandatory evidence reference
 * and was rejected 11 times with "criterion acceptance requires evidence" —
 * a shape the prompt never showed it.
 */

function emptyBundle(over: Partial<AgentContextBundle> = {}): AgentContextBundle {
  return {
    rolePrompt: "r",
    mission: "m",
    relevantPolicies: [],
    agentState: { agentId: "a", lifecycle: "IDLE", mailboxDepth: 0, currentArtifactIds: [], tokensConsumed: 0, activations: 0, lastActivityAt: "t" },
    relevantDecisions: [],
    relevantArtifacts: [],
    unreadMail: [],
    recentOwnActivity: [],
    agentMemory: [],
    openThreads: [],
    budgetSnapshot: { agentTokensUsed: 0, agentTokenBudget: 1, missionTokensUsed: 0, missionTokenBudget: 1 },
    outstanding: { awaitingResponse: [], owedByYou: [] },
    goalCriteria: [],
    ...over,
  } as AgentContextBundle;
}

/** Ops the runtime actually implements, read from the protocol source. */
function implementedOps(): Set<string> {
  const src = fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "packages", "protocol", "src", "types.ts"), "utf8");
  return new Set([...src.matchAll(/\bop: "(\w+)"/g)].map((m) => m[1]));
}

/**
 * The MCP tools that issue each op, read from the `toOp` switch in the MCP
 * bridge. Ops are issued ONLY as tool calls, and a tool's name is not `mesh_`
 * plus its op (`claim_task` is `mesh_task_claim`), so "is this op taught" means
 * "is a tool that issues it named".
 */
function mcpSource(): string {
  return fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "apps", "mesh-server", "src", "mcp.ts"), "utf8");
}

function toolsByOp(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [, tool, body] of mcpSource().matchAll(/case "(mesh_\w+)":([\s\S]*?)(?=case "mesh_|default:)/g)) {
    for (const [, op] of body.matchAll(/\bop: "(\w+)"/g)) out.set(op, [...(out.get(op) ?? []), tool]);
  }
  return out;
}

/** Only usable when delegation is enabled, so documented conditionally. */
const DELEGATION_TOOLS = new Set(["mesh_spawn_worker", "mesh_submit_result"]);

test("ops contract: every implemented op has a tool the agent's instructions name", () => {
  const text = renderContextInstructions(emptyBundle());
  const tools = toolsByOp();
  const noTool = [...implementedOps()].filter((op) => !tools.has(op)).sort();
  assert.deepEqual(noTool, [], `ops with no MCP tool cannot be issued at all: ${noTool.join(", ")}`);
  const missing = [...implementedOps()]
    .filter((op) => !tools.get(op)!.some((t) => DELEGATION_TOOLS.has(t) || text.includes(t)))
    .sort();
  assert.deepEqual(
    missing,
    [],
    `undocumented ops are unusable by agents; missing: ${missing.join(", ")}`,
  );
});

test("ops contract: delegation tools appear exactly when they are usable", () => {
  const off = renderContextInstructions(emptyBundle());
  for (const tool of DELEGATION_TOOLS) {
    assert.ok(
      !off.includes(tool),
      `${tool} is denied outright with delegation off (v1 default max_depth 0) — advertising it only buys failed turns`,
    );
  }
  const on = renderContextInstructions(emptyBundle({ delegationEnabled: true }));
  for (const tool of DELEGATION_TOOLS) {
    assert.ok(on.includes(tool), `${tool} must be documented once delegation is actually permitted`);
  }
});

test("ops contract: the interrupt tariff is quoted exactly when it can be charged", () => {
  const off = renderContextInstructions(emptyBundle());
  assert.ok(
    !off.includes("What interrupting someone costs you"),
    "a mesh with no tariff must not be told a price nothing ever debits",
  );
  const on = renderContextInstructions(emptyBundle({ interruptCostTokens: 2000 }));
  assert.match(on, /2000 tokens for every recipient woken/, "the seat that pays must be quoted the unit price");
  assert.ok(on.includes("costs you 6000"), "the cost of waking three seats has to be arithmetic the seat can check");
  assert.match(
    on,
    /only the wake is refused/,
    "running out is silent, so the contract is the only place a seat can learn what that looks like",
  );
});

/**
 * The guidance used to describe inference the default semantic disabled: "it
 * guesses from thread and timing, and a wrong guess either strands the asker
 * forever". Under `strict` there is no guess -- the answer lands, is read, and
 * discharges nothing. Right advice, false reason, which is the worst shape for
 * a prompt: an agent reasoning about the stated mechanism reasons from fiction.
 */
test("ops contract: answering guidance describes strict semantics, not inference", () => {
  const text = renderContextInstructions(emptyBundle());
  assert.match(text, /Always set `replyTo`/);
  assert.ok(
    !/guess(es)? from thread and timing/.test(text),
    "the runtime does not infer a discharge under the default `strict` semantic",
  );
  assert.match(text, /the request stays open/, "the seat must be told what actually happens without `replyTo`");
});

test("ops contract: criterion acceptance is documented with its evidence requirement", () => {
  const text = renderContextInstructions(emptyBundle({ criterionAcceptanceEnabled: true }));
  assert.match(text, /criterion:/, "agents must see the subject shape that satisfies a criterion");
  assert.match(text, /artifactId/, "acceptance without an evidence reference is rejected by the runtime");
  // The failure mode is silent: without this, agents burn turns being rejected
  // and the mission never completes despite the work being done.
  const section = text.slice(text.indexOf("criterion:"));
  assert.match(
    section.slice(0, 600),
    /MANDATORY|required|rejected/i,
    "the prompt must state that evidence is mandatory, not merely available",
  );
});

test("ops contract: criterion acceptance appears exactly when the seat can perform it", () => {
  const off = renderContextInstructions(emptyBundle());
  assert.ok(
    !off.includes("criterion:"),
    "the criterion branch of approve is refused without requirements.accept/approve — advertising it buys denied turns, and the denial then reads as an argument for granting the acceptance gate itself",
  );
  // Artifact review is a DIFFERENT authority check and must survive the gate:
  // the architect, security and every other review-capability seat still needs
  // it, so gating on requirements authority must not take it with them.
  assert.match(
    off,
    /Approve or reject a reviewed artifact/,
    "artifact approve/reject is not gated on requirements authority",
  );
  const on = renderContextInstructions(emptyBundle({ criterionAcceptanceEnabled: true }));
  assert.match(on, /criterion:/, "a seat holding requirements.accept must be shown how to close a criterion");
});

test("ops contract: artifact review lifecycle is documented", () => {
  const text = renderContextInstructions(emptyBundle());
  assert.match(text, /mesh_artifact_transition/, "a DRAFT nobody transitions is never reviewed and never becomes evidence");
  assert.match(text, /READY_FOR_REVIEW/, "agents need the target status by name");
  assert.match(text, /owner/i, "only the owner may transition — otherwise agents burn turns on rejections");
});

/**
 * Ops are MCP tool calls and nothing else. The contract used to teach a fenced
 * `mesh-json` block as the way to act; that channel is gone, so a prompt that
 * still showed one would teach, in its most emphatic section, a move that
 * lands nothing — and the seat would spend a whole turn to find out.
 */
test("ops contract: the seat is told to act through mesh tools only", () => {
  const text = renderContextInstructions(emptyBundle());
  assert.ok(text.includes("## Ops contract"), "the section anchor is load-bearing for other suites");
  assert.ok(!text.includes("mesh-json"), "the prose ops block no longer exists and must not be taught");
  assert.ok(!/"op"\s*:/.test(text), "no inline JSON op example — every move is named by its tool");
  assert.match(text, /ONLY by calling the `mesh_\*` MCP tools/);
  assert.match(text, /ignored/, "a seat that remembers the block must be told it lands nothing");
  assert.match(text, /`mesh_done`/, "the turn-ending tool must be named");
  assert.match(text, /`mesh_wait`/);
});

test("ops contract: every tool it names is one the bridge actually serves", () => {
  // The inverse of the coverage test: a name the prompt invents is a call the
  // bridge answers with "unknown tool", which is the invented-op failure the
  // prose channel had, moved rather than removed.
  const served = new Set([...mcpSource().matchAll(/case "(mesh_\w+)":/g)].map((m) => m[1]));
  const text = renderContextInstructions(
    emptyBundle({ delegationEnabled: true, criterionAcceptanceEnabled: true, commsVocabulary: "contracts" }),
  );
  const named = new Set([...text.matchAll(/\bmesh_[a-z_]*[a-z]\b/g)].map((m) => m[0]));
  const unknown = [...named].filter((t) => !served.has(t)).sort();
  assert.deepEqual(unknown, [], `the prompt names tools the bridge does not serve: ${unknown.join(", ")}`);
});

/**
 * The tariff prose above is only worth
 * anything if a real `bus.delivery` block reaches the bundle, and only safe if
 * a mesh that charges nothing renders no price.
 */
test("the interrupt tariff reaches the bundle, and only when it can be charged", async () => {
  const agents = [
    { id: "architect", role: "architect", interests: [] },
    { id: "dev", role: "developer", interests: [] },
  ];
  const priced = await makeMesh({
    agents,
    mode: "parked" as const,
    bus: { delivery: { classes: true, interruptCostTokens: 2000 } },
  });
  const free = await makeMesh({
    agents,
    mode: "parked" as const,
    bus: { delivery: { classes: true, interruptCostTokens: 0 } },
  });
  const none = await makeMesh({ agents, mode: "parked" as const });
  try {
    assert.equal(
      buildAgentContext({ config: priced.config, kernel: priced.kernel }, "dev").interruptCostTokens,
      2000,
      "bus.delivery.interrupt_cost_tokens never reached the bundle, so the price can never be quoted",
    );
    // `chargeInterrupt` no-ops on a non-positive cost, so quoting one here
    // would name a debit that never happens.
    assert.equal(
      buildAgentContext({ config: free.config, kernel: free.kernel }, "dev").interruptCostTokens,
      undefined,
      "a zero tariff must not be advertised as a price",
    );
    assert.equal(
      buildAgentContext({ config: none.config, kernel: none.kernel }, "dev").interruptCostTokens,
      undefined,
      "a mesh with no delivery regime charges nothing and must be told nothing",
    );
  } finally {
    await priced.cleanup();
    await free.cleanup();
    await none.cleanup();
  }
});
