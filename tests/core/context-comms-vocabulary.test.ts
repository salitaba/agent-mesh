import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAgentContext, renderContextInstructions } from "../../packages/core/src/context";
import { BUILTIN_CONTRACTS } from "../../packages/protocol/src/contracts";
import type { AgentContextBundle } from "../../packages/protocol/src/index";
import { makeMesh } from "../helpers";

/**
 * A seat's comms surface is written by two hands and only one of them is
 * generated.
 *
 * `bus.vocabulary: "contracts"` collapses the MCP manifest to eight tools,
 * none of which takes a message type. It cannot collapse `roles/*.md`, which
 * is prose a human wrote in the typed vocabulary — every shipped role file
 * still says "send REQUEST_RESEARCH to the explorer", "Send TEST_RESULT",
 * "request qa and security review". Under the collapsed vocabulary those
 * sentences name moves the seat's tool list does not contain, and its only
 * route to the replacements is to spend a turn on `contracts` first.
 *
 * So the mapping is rendered per turn, and DERIVED from the contract
 * catalogue. These tests exist to keep the derivation honest: a hand-kept
 * table would be the same drift one file over, and the assertions below fail
 * the moment the prompt stops covering what `BUILTIN_CONTRACTS` says.
 */

function bundle(over: Partial<AgentContextBundle> = {}): AgentContextBundle {
  return {
    rolePrompt: "role",
    mission: "ship the thing",
    relevantPolicies: [],
    agentState: {
      agentId: "developer",
      lifecycle: "THINKING",
      mailboxDepth: 0,
      currentArtifactIds: [],
      tokensConsumed: 0,
      activations: 0,
      lastActivityAt: "",
    },
    relevantDecisions: [],
    relevantArtifacts: [],
    unreadMail: [],
    recentOwnActivity: [],
    agentMemory: [],
    openThreads: [],
    budgetSnapshot: { agentTokensUsed: 0, agentTokenBudget: 0, missionTokensUsed: 0, missionTokenBudget: 0 },
    outstanding: { awaitingResponse: [], owedByYou: [] },
    goalCriteria: [],
    delegationEnabled: false,
    criterionAcceptanceEnabled: false,
    hardActions: { mode: "off", capabilities: [] },
    ...over,
  };
}

const HEADING = "## How you ask for things here";

test("a typed mesh is rendered exactly as it was before the key existed", () => {
  const text = renderContextInstructions(bundle());
  assert.equal(text.includes(HEADING), false);
  // Not merely the heading: no contract name leaks into a typed seat's prompt
  // through this path either. `contracts` is still in the ops catalogue as an
  // op it can call — what it must not get is the catalogue itself, which is
  // ~160 tokens a turn restating a manifest it already agrees with.
  for (const c of BUILTIN_CONTRACTS) {
    assert.equal(text.includes(`call ${c.name}`), false, `${c.name} leaked into a typed prompt`);
  }
});

test("under contracts, every builtin is mapped from the name a role brief uses", () => {
  const text = renderContextInstructions(bundle({ commsVocabulary: "contracts" }));
  assert.ok(text.includes(HEADING));
  for (const c of BUILTIN_CONTRACTS) {
    // Both halves matter. The message type is what the brief quotes; the
    // contract name is what the seat can actually call.
    assert.ok(text.includes(`\`${c.messageType}\``), `${c.name}: brief-facing type name missing`);
    assert.ok(text.includes(`\`call ${c.name}\``), `${c.name}: replacement missing`);
  }
});

test("the mapping is derived, not listed — it covers the catalogue exactly", () => {
  const text = renderContextInstructions(bundle({ commsVocabulary: "contracts" }));
  const mapped = text.split("\n").filter((l) => l.startsWith("- `") && l.includes("→ `call "));
  // Equality, not "at least": a line the catalogue does not back is a
  // hand-written entry that has already started drifting.
  assert.equal(mapped.length, BUILTIN_CONTRACTS.length);
});

test("the three ops a brief says in prose are named alongside their type", () => {
  const text = renderContextInstructions(bundle({ commsVocabulary: "contracts" }));
  // `request_review` / `request_research` / `escalate` are what role prose
  // actually says ("request a review", "escalate it"), so they are the names a
  // seat hunts its tool list for. `send` is left off deliberately: naming it
  // on every line would tell a seat the raw channel is the normal move.
  const desugars = new Set(BUILTIN_CONTRACTS.map((c) => c.desugarsTo));
  for (const op of desugars) {
    if (op === "send") continue;
    assert.ok(text.includes(`the \`${op}\` op`), `${op} not offered as a name to search for`);
  }
  assert.equal(text.includes("the `send` op →"), false);
});

test("the raw-send fallback is offered on the prose channel and withheld on typed-only", () => {
  const mixed = renderContextInstructions(bundle({ commsVocabulary: "contracts" }));
  assert.match(mixed, /The raw `send` op still works/);
  // Under typed-only a `mesh-json` block is parsed and then refused, so this
  // line would be pointing a seat at a turn that lands nothing.
  const typedOnly = renderContextInstructions(bundle({ commsVocabulary: "contracts", typedOpsOnly: true }));
  assert.equal(typedOnly.includes("The raw `send` op still works"), false);
  assert.ok(typedOnly.includes(HEADING), "the mapping itself is not what typed-only withholds");
});

test("buildAgentContext carries the key from the resolved bus, and omits it otherwise", async () => {
  const collapsed = await makeMesh({
    agents: [{ id: "dev", role: "developer", capabilities: ["code.write"], interests: [] }],
    mayContact: { dev: [] },
    mode: "parked",
    bus: { vocabulary: "contracts" },
  });
  try {
    assert.equal(buildAgentContext({ config: collapsed.config, kernel: collapsed.kernel }, "dev").commsVocabulary, "contracts");
  } finally {
    await collapsed.cleanup();
  }

  // `"typed"` is written literally into the fixture's yaml; the resolver folds
  // it back to absent, and that fold is what keeps an existing mesh rendering
  // byte-for-byte what it rendered before this key shipped.
  const typed = await makeMesh({
    agents: [{ id: "dev", role: "developer", capabilities: ["code.write"], interests: [] }],
    mayContact: { dev: [] },
    mode: "parked",
    bus: { vocabulary: "typed" },
  });
  try {
    assert.equal(buildAgentContext({ config: typed.config, kernel: typed.kernel }, "dev").commsVocabulary, undefined);
  } finally {
    await typed.cleanup();
  }
});

/**
 * The style's own paragraph.
 *
 * `bus.style: "low-contact"` changes five config keys and every one of them
 * is invisible from inside a turn: a seat cannot see a coalescing window, an
 * attention tariff or a nudge ladder that has stopped reaching it. What it
 * CAN see is the rest of the prompt, which is written for a mesh that chases
 * — "never just stay silent", "you keep being nudged" — and which stays true
 * only for asks carrying no default. A seat told to be brief but not told the
 * chasing stopped behaves exactly as before, and the style buys nothing.
 */
test("a low-contact mesh tells its seats that nothing is coming to chase them", () => {
  const rendered = renderContextInstructions(bundle({ lowContact: true }));
  assert.match(rendered, /## This mesh is LOW-CONTACT/);
  // Four SPENDING rules, not a description of the configuration: a seat can
  // act on "say it once", not on "coalesce_ms is 300000".
  assert.match(rendered, /`ifUnanswered`/, "the one move that makes silence cheap has to be named");
  assert.match(rendered, /Asks here have DEADLINES/);
  assert.match(rendered, /Waking someone is BILLED/);
  assert.match(rendered, /Prefer `announce` to asking/);
  // The thing it must NOT say. Silence is free only on an ask whose asker
  // priced it; a seat that read this as "you may ignore mail" would be
  // dropping its own debts, which `defersMail` will not let it do anyway.
  assert.doesNotMatch(rendered, /silence is free/i);
});

test("every other mesh renders nothing about it", () => {
  const rendered = renderContextInstructions(bundle());
  assert.doesNotMatch(rendered, /LOW-CONTACT/);
  assert.doesNotMatch(rendered, /Waking someone is BILLED/);
});

test("the style reaches the bundle, and only from low-contact", async () => {
  for (const [style, expected] of [
    ["low-contact", true],
    ["balanced", undefined],
    ["high-contact", undefined],
  ] as const) {
    const m = await makeMesh({
      agents: [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] }],
      mayContact: { dev: [] },
      mode: "parked",
      bus: { style },
    });
    try {
      assert.equal(
        buildAgentContext({ config: m.config, kernel: m.kernel }, "dev").lowContact,
        expected,
        `${style} must ${expected ? "carry" : "omit"} the key`,
      );
    } finally {
      await m.cleanup();
    }
  }
});
