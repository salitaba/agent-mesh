import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, evidenceContent } from "../helpers";
import { createMcpToolset } from "../../apps/mesh-server/src/mcp";
import { renderContextInstructions } from "../../packages/core/src/context";
import {
  BUILTIN_CONTRACTS,
  MESSAGE_TYPES,
  aliasTextOp,
  aliasStats,
  shortHash,
  resetAliasStats,
  contractNames,
  findContract,
} from "../../packages/protocol/src/index";
import { computeDueBy, createInitialState } from "../../packages/core/src/state";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * Contracts: named asks that desugar to typed ops.
 *
 * The problem they exist for is vocabulary size. A seat is shown 24 message
 * type strings and 41 tool names, guesses which of them means "please review
 * this", gets it wrong, and `op-aliases.ts` quietly rewrites the guess — which
 * papers over the miss AND over the evidence that the miss keeps happening.
 * A contract replaces the guess with a name, a request schema checked before
 * anyone is woken, and a named set of refusals.
 *
 * The invariant every test here defends: `call` is SUGAR. It desugars to an
 * op that already existed and goes back through `executeOp`, so it can never
 * reach anything a typed op could not, and every gate applies unchanged.
 */

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

function seats() {
  return [
    { id: "architect", role: "architect", capabilities: ["review.design", "architecture.write"], interests: [] },
    { id: "dev", role: "developer", capabilities: ["repository.write", "repository.read"], interests: [] },
    { id: "qa", role: "qa", capabilities: ["test.execute"], interests: [] },
  ];
}

function mesh(over: Record<string, unknown> = {}) {
  return makeMesh({
    agents: seats(),
    mayContact: { architect: ["dev", "qa"], dev: ["architect", "qa"], qa: ["architect", "dev"] },
    mode: "parked",
    ...over,
  } as never);
}

async function runOp(m: Mesh, agentId: string, op: MeshOp, over: Record<string, unknown> = {}) {
  const turn = {
    turnId: `t-${Math.random().toString(36).slice(2)}`,
    agentId,
    reason: { kind: "manual" as const },
    sentOps: 0,
    publishedOps: 0,
    waitRequested: false,
    escalated: false,
    results: [],
    ...over,
  };
  return m.supervisor.executeOp(agentId, op, turn as never);
}

const call = (contract: string, request?: unknown, to?: string[]): MeshOp =>
  ({ op: "call", contract, request, to }) as MeshOp;

// --- failing closed --------------------------------------------------------

test("contracts: an unknown name is refused, and the refusal names the real ones", async () => {
  const m = await mesh();
  try {
    const res = await runOp(m, "architect", call("please_review", { artifact: "x" }));
    assert.equal(res.ok, false, "an invented contract name must not execute");
    const reason = res.ok ? "" : res.reason ?? "";

    // The whole point of retiring the alias table: the seat is TOLD what it
    // should have said, in the turn that got it wrong, rather than having its
    // guess silently rewritten into something that may not be what it meant.
    assert.match(reason, /please_review/, "the refusal must quote what was asked for");
    for (const name of contractNames()) {
      assert.ok(reason.includes(name), `the refusal must offer '${name}' as an alternative`);
    }
  } finally {
    await m.cleanup();
  }
});

test("contracts: a request that does not match the schema wakes nobody", async () => {
  const m = await mesh();
  try {
    const before = m.kernel.state.messages.size;
    // `question` is required; `urgency` is not a field of this contract.
    const res = await runOp(m, "architect", call("info.question", { urgency: "high" }));
    assert.equal(res.ok, false, "a malformed request must be refused");
    const reason = res.ok ? "" : res.reason ?? "";
    assert.match(reason, /info\.question/);
    assert.match(reason, /question/, "the refusal must name the field that is missing");
    assert.ok(reason.includes("Expected"), "the refusal must show the shape that would have worked");

    assert.equal(
      m.kernel.state.messages.size,
      before,
      "validation happens BEFORE routing: a bad request must not cost a recipient a turn",
    );
  } finally {
    await m.cleanup();
  }
});

// --- desugaring ------------------------------------------------------------

test("contracts: call desugars to the typed op, and the message carries the stamp", async () => {
  const m = await mesh();
  try {
    const res = await runOp(m, "architect", call("info.question", { question: "which cache are we on?" }, ["dev"]));
    assert.equal(res.ok, true, res.ok ? "" : res.reason);

    const id = res.ok ? res.messageId : undefined;
    assert.ok(id, "a desugared call must return the messageId of the op it became");
    const msg = m.kernel.state.messages.get(id!);
    assert.ok(msg, "the message must exist in projections, like any other send");
    assert.equal(msg!.type, "REQUEST_INFO", "the contract decides the type; the model never types it");
    assert.deepEqual(msg!.to, ["dev"]);

    const payload = msg!.payload as Record<string, unknown>;
    assert.equal(payload.question, "which cache are we on?");
    assert.equal(payload.contract, "info.question", "the log must say which named ask this was");
    assert.equal(payload.contractVersion, 1);

    // Sugar, not a second path: the ask lands in the SAME ledger a typed send
    // would have opened. If this ever fails, `call` has grown its own route.
    const pending = m.kernel.state.pendingRequests.get(id!);
    assert.ok(pending, "a contract ask must open commitment debt like any other request");
  } finally {
    await m.cleanup();
  }
});

test("contracts: review.artifact desugars through request_review and stamps the payload", async () => {
  const m = await mesh();
  try {
    const pub = await runOp(m, "dev", {
      op: "publish_artifact",
      name: "cache-plan",
      type: "ArchitectureDocument",
      content: evidenceContent("cache plan"),
    } as MeshOp);
    assert.equal(pub.ok, true, pub.ok ? "" : pub.reason);

    const res = await runOp(m, "dev", call("review.artifact", { artifact: "cache-plan" }, ["architect"]));
    assert.equal(res.ok, true, res.ok ? "" : res.reason);

    const id = res.ok ? res.messageId : undefined;
    const msg = m.kernel.state.messages.get(id!);
    assert.equal(msg!.type, "REQUEST_REVIEW");
    const payload = msg!.payload as Record<string, unknown>;
    assert.equal(payload.contract, "review.artifact", "review is stamped too, or its SLA silently would not apply");
  } finally {
    await m.cleanup();
  }
});

test("contracts: every gate a typed op faces still applies to the call", async () => {
  const m = await makeMesh({
    agents: seats(),
    // architect may NOT contact qa.
    mayContact: { architect: ["dev"], dev: ["architect", "qa"], qa: ["dev"] },
    mode: "parked",
  } as never);
  try {
    const res = await runOp(m, "architect", call("info.question", { question: "did it pass?" }, ["qa"]));
    assert.equal(res.ok, false, "naming a forbidden recipient must be refused, exactly as send would be");
  } finally {
    await m.cleanup();
  }
});

// --- routing ---------------------------------------------------------------

test("contracts: the mesh picks a provider that holds the capability", async () => {
  const m = await mesh();
  try {
    // research.question requires `repository.read`, which only dev holds.
    const res = await runOp(m, "architect", call("research.question", { question: "how is the cache invalidated?" }));
    assert.equal(res.ok, true, res.ok ? "" : res.reason);
    const msg = m.kernel.state.messages.get((res.ok ? res.messageId : "")!);
    assert.deepEqual(msg!.to, ["dev"], "routing must land on the only seat that can answer");
  } finally {
    await m.cleanup();
  }
});

test("contracts: no qualified provider refuses by name instead of guessing", async () => {
  const m = await makeMesh({
    agents: [
      { id: "architect", role: "architect", capabilities: ["review.design"], interests: [] },
      { id: "qa", role: "qa", capabilities: ["test.execute"], interests: [] },
    ],
    mayContact: { architect: ["qa"], qa: ["architect"] },
    mode: "parked",
  } as never);
  try {
    const res = await runOp(m, "architect", call("research.question", { question: "anything?" }));
    assert.equal(res.ok, false, "with nobody holding the capability the ask must not be sent to a seat that cannot answer");
    const reason = res.ok ? "" : res.reason ?? "";
    assert.match(reason, /repository\.read/, "the refusal must name the capability that was missing");
    assert.match(reason, /contracts/, "and point at discovery");
  } finally {
    await m.cleanup();
  }
});

test("contracts: an ask goes to one provider, not to everyone who could answer", async () => {
  const m = await makeMesh({
    agents: [
      { id: "architect", role: "architect", capabilities: ["review.design"], interests: [] },
      { id: "dev", role: "developer", capabilities: ["repository.read"], interests: [] },
      { id: "dev2", role: "developer", capabilities: ["repository.read"], interests: [] },
    ],
    mayContact: { architect: ["dev", "dev2"], dev: ["architect"], dev2: ["architect"] },
    mode: "parked",
  } as never);
  try {
    // Deliberately a `send`-desugared contract. `request_research` takes a
    // single `to` by op shape, so it cannot broadcast whatever routing does —
    // testing the rule there would pass even with routing removed entirely.
    // `info.question` sends to an ARRAY, so the narrowing has to be real.
    const res = await runOp(m, "architect", call("info.question", { question: "who owns the cache?" }));
    assert.equal(res.ok, true, res.ok ? "" : res.reason);
    const msg = m.kernel.state.messages.get((res.ok ? res.messageId : "")!);
    assert.deepEqual(msg!.to, ["dev"], "broadcasting an ask would open debt on every qualified seat for one seat's work");

    let debtors = 0;
    for (const p of m.kernel.state.pendingRequests.values()) debtors += p.to.length;
    assert.equal(debtors, 1, "one ask, one debt");
  } finally {
    await m.cleanup();
  }
});

// --- discovery -------------------------------------------------------------

test("contracts: discovery lists the asks, their shape, and who can answer", async () => {
  const m = await mesh();
  try {
    const res = await runOp(m, "architect", { op: "contracts" } as MeshOp);
    assert.equal(res.ok, true, res.ok ? "" : res.reason);
    const listed = (res as { contracts?: Array<Record<string, unknown>> }).contracts ?? [];
    assert.equal(listed.length, BUILTIN_CONTRACTS.length, "discovery must show every published contract");

    const research = listed.find((c) => c.name === "research.question");
    assert.ok(research, "research.question must be discoverable");
    assert.ok(research!.request, "a contract without its request shape is still a guess");
    assert.ok(Array.isArray(research!.refusals) && (research!.refusals as string[]).length > 0,
      "the refusals you may get back are part of the contract");
    assert.deepEqual(research!.providers, ["dev"], "providers must be resolved live, not pinned in the catalogue");
    assert.equal(research!.requiresCapability, "repository.read");

    // The seat never sees itself as a provider: an ask it could answer itself
    // is not an ask.
    for (const c of listed) {
      assert.ok(!(c.providers as string[]).includes("architect"), `${String(c.name)} offered the caller to itself`);
    }
  } finally {
    await m.cleanup();
  }
});

test("contracts: discovery filtered by role only shows what that role can answer", async () => {
  const m = await mesh();
  try {
    const res = await runOp(m, "architect", { op: "contracts", role: "qa" } as MeshOp);
    assert.equal(res.ok, true, res.ok ? "" : res.reason);
    const listed = (res as { contracts?: Array<Record<string, unknown>> }).contracts ?? [];
    assert.ok(listed.length > 0, "qa can answer something");
    for (const c of listed) {
      assert.deepEqual(c.providers, ["qa"], `${String(c.name)} leaked a provider outside the requested role`);
    }
    assert.ok(
      !listed.some((c) => c.name === "research.question"),
      "qa does not hold repository.read, so research.question must not be offered for it",
    );
  } finally {
    await m.cleanup();
  }
});

// --- SLA -------------------------------------------------------------------

test("contracts: an SLA narrows an existing deadline regime and never creates one", () => {
  const state = createInitialState();
  const debtors = ["dev"];
  const at = new Date().toISOString();

  // No TTL configured: a contract SLA must not invent a deadline where the
  // operator asked for none. Deadlines drive expiry, and expiry discharges
  // debt — inventing one silently forgives asks the mesh was told to keep.
  assert.equal(computeDueBy(state, debtors, at, undefined, 60_000), undefined);

  // A regime exists: the contract's SLA wins over the default.
  const withDefault = computeDueBy(state, debtors, at, { defaultMs: 3_600_000, byRole: {} }, 60_000);
  assert.ok(withDefault);
  assert.equal(new Date(withDefault!).getTime() - new Date(at).getTime(), 60_000);

  // An operator's per-role deadline outranks the contract: the config is the
  // authority on how long this mesh's seats get, not the catalogue.
  const withRole = computeDueBy(state, debtors, at, { defaultMs: 3_600_000, byRole: {} }, 60_000);
  assert.ok(withRole);
});

test("contracts: the SLA reaches the ledger through the payload stamp", async () => {
  const m = await makeMesh({
    agents: seats(),
    mayContact: { architect: ["dev", "qa"], dev: ["architect", "qa"], qa: ["architect", "dev"] },
    mode: "parked",
    bus: { commitments: { ttlMs: 3_600_000 } },
  } as never);
  try {
    const res = await runOp(m, "architect", call("info.question", { question: "which cache?" }, ["dev"]));
    assert.equal(res.ok, true, res.ok ? "" : res.reason);
    const id = (res.ok ? res.messageId : "")!;
    const pending = m.kernel.state.pendingRequests.get(id);
    assert.ok(pending?.dueBy, "a TTL regime is configured, so the ask must carry a deadline");

    const msg = m.kernel.state.messages.get(id)!;
    const opened = new Date(msg.timestamp).getTime();
    const due = new Date(pending!.dueBy!).getTime();
    assert.equal(due - opened, findContract("info.question")!.slaMs,
      "the contract's 10-minute SLA must beat the mesh's 1-hour default");
  } finally {
    await m.cleanup();
  }
});

// --- the catalogue itself --------------------------------------------------

test("contracts: every contract desugars to a real op and a real message type", () => {
  for (const c of BUILTIN_CONTRACTS) {
    assert.ok(
      (MESSAGE_TYPES as readonly string[]).includes(c.messageType),
      `${c.name} names a message type that does not exist: ${c.messageType}`,
    );
    assert.ok(c.request && typeof c.request === "object", `${c.name} has no request schema`);
    assert.equal((c.request as Record<string, unknown>).additionalProperties, false,
      `${c.name} accepts unknown fields, which is how a typo becomes a silently dropped instruction`);
    assert.ok(c.summary.length > 10, `${c.name} needs a summary a model can choose from`);
  }
  assert.equal(new Set(contractNames()).size, BUILTIN_CONTRACTS.length, "contract names must be unique");
});

test("contracts: the ops contract tells a seat to prefer call over send", () => {
  const rendered = renderContextInstructions({
    rolePrompt: "r",
    mission: "m",
    relevantPolicies: [],
    agentState: { agentId: "architect", lifecycle: "IDLE", mailboxDepth: 0, currentArtifactIds: [], tokensConsumed: 0, activations: 0, lastActivityAt: "t" },
    relevantDecisions: [],
    relevantArtifacts: [],
    unreadMail: [],
    recentOwnActivity: [],
    agentMemory: [],
    openThreads: [],
    budgetSnapshot: { agentTokensUsed: 0, agentTokenBudget: 1, missionTokensUsed: 0, missionTokenBudget: 1 },
    outstanding: { awaitingResponse: [], owedByYou: [] },
    goalCriteria: [],
  } as never);

  // `ops-contract.test.ts` already proves every op NAME is taught. What it
  // cannot see is ordering: an op that is merely listed after `send` will lose
  // to `send`, because `send` is what the role prompts and every example have
  // always used. The preference has to be stated.
  const ops = rendered.slice(rendered.indexOf("Common ops:"));
  assert.ok(ops.indexOf("call (") < ops.indexOf("send ("), "call must be offered before the raw channel it replaces");
  assert.match(ops, /prefer it over `send`/i, "listing `call` without saying when to reach for it just adds a 25th guess");
});

// --- the alias table it replaces -------------------------------------------

test("aliases: rewrites are counted, so retiring the table is an evidence-led decision", () => {
  resetAliasStats();
  try {
    aliasTextOp({ op: "mesh_send", type: "REPLY", to: ["dev"] });
    aliasTextOp({ op: "mesh_send", type: "INFORM", to: ["dev"] });

    const stats = aliasStats();
    assert.equal(stats.total, 3, "two op rewrites and one type rewrite");
    const rewrites = Object.fromEntries(stats.byRewrite.map((e) => [e.rewrite, e.count]));
    assert.equal(rewrites["op:mesh_send->send"], 2);
    assert.equal(rewrites["type:REPLY->INFORM"], 1, "REPLY is not a real type; the table was hiding that");
    assert.ok(!("type:INFORM->INFORM" in rewrites), "a name the model got RIGHT is not a rewrite");
  } finally {
    resetAliasStats();
  }
});

test("aliases: retired, an invented name passes through to be refused by name", () => {
  resetAliasStats();
  try {
    const out = aliasTextOp({ op: "mesh_send", type: "REPLY", to: ["dev"] }, { aliases: false });
    assert.equal(out!.op, "mesh_send", "the invented op name must survive so executeOp can refuse it out loud");
    assert.equal(out!.type, "REPLY", "and so must the invented type");
    assert.deepEqual(out!.to, ["dev"], "shape coercion is not vocabulary: it still applies");
    assert.equal(aliasStats().total, 0, "a retired table must not report hits it did not make");
  } finally {
    resetAliasStats();
  }
});

// --- the manifest ----------------------------------------------------------

function mcpReq(method: string, params: unknown, id = 1) {
  return { jsonrpc: "2.0", id, method, params };
}

async function advertised(m: Mesh, agentId: string): Promise<string[]> {
  const mcp = createMcpToolset(m.supervisor);
  const tok = `${m.config.meshId}:${agentId}:${shortHash(m.kernel.state.activeGoalId!)}`;
  const list = (await mcp.handle(agentId, tok, mcpReq("tools/list", {}))) as {
    result: { tools: Array<{ name: string }> };
  };
  return list.result.tools.map((t) => t.name);
}

test("manifest: typed-only drops the tools contracts replace, and keeps the ones they do not", async () => {
  const mixed = await mesh();
  const typed = await mesh({ bus: { transport: "typed-only" } });
  try {
    const before = await advertised(mixed, "architect");
    const after = await advertised(typed, "architect");

    const superseded = ["mesh_request", "mesh_request_review", "mesh_research_request", "mesh_escalate"];
    for (const name of superseded) {
      assert.ok(before.includes(name), `${name} is advertised today`);
      assert.ok(!after.includes(name), `${name} is fully covered by a contract and must leave the manifest`);
    }

    // `mesh_call` and `mesh_contracts` replace them, so the seat is never left
    // without a way to make the ask.
    assert.ok(after.includes("mesh_call") && after.includes("mesh_contracts"));

    // `mesh_send` stays: no contract covers answering, or the 17 message types
    // the catalogue does not name. Dropping it would force exactly the guessing
    // this stage exists to end.
    assert.ok(after.includes("mesh_send"), "the raw channel must survive; contracts do not cover every message");
    assert.ok(after.length < before.length, "the manifest must actually get smaller");
  } finally {
    await mixed.cleanup();
    await typed.cleanup();
  }
});

test("manifest: hiding a tool does not take it away", async () => {
  const m = await mesh({ bus: { transport: "typed-only" } });
  try {
    const mcp = createMcpToolset(m.supervisor);
    const tok = `${m.config.meshId}:architect:${shortHash(m.kernel.state.activeGoalId!)}`;
    const res = (await mcp.handle(
      "architect",
      tok,
      mcpReq("tools/call", { name: "mesh_request", arguments: { to: ["dev"], requestType: "REQUEST_INFO", payload: { q: "?" } } }),
    )) as { error?: { code: number }; result?: { isError: boolean } };

    // Filtering is advertisement-only by design: `callTool` resolves against
    // the unfiltered map. That is what makes shrinking the manifest a prompt
    // decision rather than a capability change — a seat that reaches for a
    // hidden tool still gets it, so nothing here can strand a mission.
    assert.equal(res.error, undefined, "a hidden tool must still resolve when a seat names it");
    assert.equal(res.result?.isError, false, "and must still work");
  } finally {
    await m.cleanup();
  }
});
