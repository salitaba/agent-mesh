import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { renderContextInstructions, buildAgentContext } from "../../packages/core/src/context";
import type { AgentContextBundle } from "../../packages/protocol/src/index";
import { makeMesh } from "../helpers";

/**
 * The ops block in the agent context is the ONLY place an agent learns what
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

/** Only usable when delegation is enabled, so documented conditionally. */
const DELEGATION_OPS = new Set(["spawn_worker", "submit_result"]);

test("ops contract: every implemented op is named in the agent's instructions", () => {
  const text = renderContextInstructions(emptyBundle());
  const missing = [...implementedOps()].filter((op) => !DELEGATION_OPS.has(op) && !text.includes(op)).sort();
  assert.deepEqual(
    missing,
    [],
    `undocumented ops are unusable by agents; missing: ${missing.join(", ")}`,
  );
});

test("ops contract: delegation ops appear exactly when they are usable", () => {
  const off = renderContextInstructions(emptyBundle());
  for (const op of DELEGATION_OPS) {
    assert.ok(
      !off.includes(op),
      `${op} is denied outright with delegation off (v1 default max_depth 0) — advertising it only buys failed turns`,
    );
  }
  const on = renderContextInstructions(emptyBundle({ delegationEnabled: true }));
  for (const op of DELEGATION_OPS) {
    assert.ok(on.includes(op), `${op} must be documented once delegation is actually permitted`);
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
  assert.match(text, /transition_artifact/, "a DRAFT nobody transitions is never reviewed and never becomes evidence");
  assert.match(text, /READY_FOR_REVIEW/, "agents need the target status by name");
  assert.match(text, /owner/i, "only the owner may transition — otherwise agents burn turns on rejections");
});

test("ops contract: the ops block still shows an exact, parseable example", () => {
  const text = renderContextInstructions(emptyBundle());
  const fence = text.indexOf("```mesh-json");
  assert.ok(fence > 0, "the fenced example is the contract agents copy from");
  const block = text.slice(fence + "```mesh-json".length, text.indexOf("```", fence + 12));
  const parsed = JSON.parse(block.trim()) as Array<{ op: string }>;
  assert.ok(Array.isArray(parsed) && parsed.length > 0, "the documented example must itself be valid JSON");
  for (const op of parsed) assert.ok(implementedOps().has(op.op), `example uses a non-existent op: ${op.op}`);
});

// --------------------------------------------------------- typed-only ------

/**
 * Under `bus.transport: "typed-only"` the supervisor parses a `mesh-json`
 * block and then REFUSES every op in it (`supervisor.ts`, the
 * `typedOnlyRefusal` branch). Until this gate existed the contract above told
 * every such seat to emit one anyway -- so the prompt taught, in its most
 * emphatic section, the one thing the runtime is guaranteed to throw away, and
 * the seat spent a full turn to be told so.
 *
 * The tests come in pairs on purpose. A render that branches on a flag nobody
 * sets is dead code that reads like a feature, so the wiring is asserted from
 * a booted mesh, and the prose is asserted from a hand-made bundle.
 */

const FENCE = "```mesh-json";
/** The tail of the 24-name enum line, chosen because no other line carries it. */
const ENUM_LINE = "`send` type MUST be exactly one of:";

test("typed-only: the config reaches the bundle, not just the renderer", async () => {
  const agents = [
    { id: "architect", role: "architect", interests: [] },
    { id: "dev", role: "developer", interests: [] },
  ];
  const typed = await makeMesh({ agents, mode: "parked" as const, bus: { transport: "typed-only" as const } });
  const mixed = await makeMesh({ agents, mode: "parked" as const });
  try {
    assert.equal(mixed.config.bus.transport, "mixed", "precondition: the default mesh must not be typed-only");
    assert.equal(
      buildAgentContext({ config: typed.config, kernel: typed.kernel }, "dev").typedOpsOnly,
      true,
      "bus.transport never reached the bundle, so the gate below can never fire",
    );
    assert.equal(buildAgentContext({ config: mixed.config, kernel: mixed.kernel }, "dev").typedOpsOnly, false);
  } finally {
    await typed.cleanup();
    await mixed.cleanup();
  }
});

/**
 * The same pairing, one channel over: the tariff prose above is only worth
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

test("typed-only: the prose block contract and the type enum are withheld", () => {
  const prose = renderContextInstructions(emptyBundle());
  // Precondition. Without it this test passes just as well against a renderer
  // that stopped emitting the block for everyone.
  assert.ok(prose.includes(FENCE), "precondition: a mixed mesh must still be shown the mesh-json block");
  assert.ok(prose.includes(ENUM_LINE), "precondition: a mixed mesh must still be shown the closed type enum");

  const typed = renderContextInstructions(emptyBundle({ typedOpsOnly: true }));
  assert.ok(!typed.includes(FENCE), "a typed-only seat was told to emit a block whose ops are refused");
  assert.ok(
    !typed.includes(ENUM_LINE),
    "the enum is ~40 tokens a turn that every type-taking tool already carries as `enum: [...MESSAGE_TYPES]`",
  );
  assert.match(typed, /parsed and then REFUSED/, "and it must be told why, or it will keep writing blocks");
});

test("typed-only: withholding the block does not withhold the ops", () => {
  // The failure this guards is the obvious over-correction: gating the whole
  // section rather than the half of it that is about prose syntax. The ops
  // catalogue is the ONLY place a seat learns a move exists, and that is true
  // on either channel -- see the 18-undocumented-ops mission at the top.
  const typed = renderContextInstructions(emptyBundle({ typedOpsOnly: true }));
  const missing = [...implementedOps()].filter((op) => !DELEGATION_OPS.has(op) && !typed.includes(op)).sort();
  assert.deepEqual(missing, [], `typed-only seats lost ops from their contract: ${missing.join(", ")}`);
  assert.ok(typed.includes("## Ops block contract"), "the section anchor is load-bearing for other suites");
});
