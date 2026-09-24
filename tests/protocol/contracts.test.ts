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
import { resolveCommitmentTtl } from "../../packages/config/src/index";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * Contracts: named asks that desugar to typed ops.
 *
 * The problem they exist for is vocabulary size. A seat is shown 24 message
 * type strings and 43 tool names (`buildTools`, in `mesh-server/src/mcp.ts`),
 * guesses which of them means "please review this", gets it wrong, and
 * `op-aliases.ts` quietly rewrites the guess — which papers over the miss AND
 * over the evidence that the miss keeps happening. A contract replaces the
 * guess with a name, a request schema checked before anyone is woken, and a
 * named set of refusals.
 *
 * The invariant every test here defends: `call` is SUGAR. It desugars to an
 * op that already existed and goes back through `executeOp`, so it can never
 * reach anything a typed op could not, and every gate applies unchanged.
 *
 * Deliberately NOT asserted anywhere below: the size of that tool surface.
 * The counts above are a snapshot of a list that grows every time a tool is
 * added, and pinning one in an assertion would make each new tool arrive as a
 * failure in this file — which teaches the next author to edit the number
 * rather than to read what it claims. The manifest tests at the bottom defend
 * the structural facts instead: that the tools a contract supersedes leave the
 * advertised set, that `mesh_call` and the raw `mesh_send` channel stay, and
 * that the manifest genuinely shrinks. None of those go stale when the surface
 * changes size.
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

    // The stamp rides on the runtime-owned envelope, NOT in the payload. The
    // ledger reads it to set this ask's deadline and to judge its answer, and
    // `payload` is verbatim agent input -- so a stamp there was a routing
    // decision any seat could make for the kernel by writing one JSON key.
    assert.equal(msg!.control?.contract, "info.question", "the log must say which named ask this was");
    assert.equal(msg!.control?.contractVersion, 1);
    assert.equal(payload.contract, undefined, "the stamp must not travel in agent-visible payload");
    assert.equal(payload.contractVersion, undefined);

    // Sugar, not a second path: the ask lands in the SAME ledger a typed send
    // would have opened. If this ever fails, `call` has grown its own route.
    const pending = m.kernel.state.pendingRequests.get(id!);
    assert.ok(pending, "a contract ask must open commitment debt like any other request");
  } finally {
    await m.cleanup();
  }
});

test("contracts: review.artifact desugars through request_review and stamps the envelope", async () => {
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
    assert.equal(msg!.control?.contract, "review.artifact", "review is stamped too, or its SLA silently would not apply");
    assert.equal(
      (msg!.payload as Record<string, unknown>).contract,
      undefined,
      "the stamp belongs to the runtime, not to agent-visible payload",
    );
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

// --- the answer ------------------------------------------------------------

/**
 * A contract's `response` schema, checked at discharge.
 *
 * The gap these close: discharge is STRUCTURAL. A reply that names the ask
 * settles it, and nothing ever looked at what the reply said. So "sure" and a
 * real answer closed a commitment with equal force, the asker's loop moved on,
 * and the hole surfaced a turn later as a re-ask -- a full turn, with the
 * nudge ladder and eventually a human underneath it.
 *
 * The rule being pinned is FAIL-OPEN: a thin answer still discharges. Holding
 * the ask open on a schema miss would turn a disagreement about shape into a
 * stall, and stalls in this runtime end at an operator card.
 */
test("contracts: a contentless reply still settles the ask, and is marked for it", async () => {
  const m = await mesh();
  try {
    const ask = await runOp(m, "architect", call("info.question", { question: "which cache?" }, ["dev"]));
    assert.equal(ask.ok, true, ask.ok ? "" : ask.reason);
    const askId = (ask.ok ? ask.messageId : "")!;

    // A well-formed reply that answers nothing: it names the ask, so the
    // ledger's most confident discharge path fires on it.
    const reply = await runOp(m, "dev", {
      op: "send", type: "INFORM", to: ["architect"],
      threadId: m.kernel.state.messages.get(askId)!.threadId,
      replyTo: askId,
      payload: { answer: "   " },
    } as MeshOp);
    assert.equal(reply.ok, true, reply.ok ? "" : reply.reason);

    assert.equal(m.kernel.state.pendingRequests.has(askId), false, "fail-open: the debt is settled even so");
    const rec = m.kernel.state.discharged.find((d) => d.messageId === askId);
    assert.ok(rec, "the settlement must be on the ledger");
    assert.equal(rec!.reason, "reply");
    assert.equal(rec!.responseValid, false, "a whitespace answer is not an answer");
    assert.ok((rec!.responseIssues ?? []).length > 0, "the mark must say what was wrong with it");
  } finally {
    await m.cleanup();
  }
});

test("contracts: a real answer discharges clean", async () => {
  const m = await mesh();
  try {
    const ask = await runOp(m, "architect", call("info.question", { question: "which cache?" }, ["dev"]));
    const askId = (ask.ok ? ask.messageId : "")!;
    const reply = await runOp(m, "dev", {
      op: "send", type: "INFORM", to: ["architect"],
      threadId: m.kernel.state.messages.get(askId)!.threadId,
      replyTo: askId,
      payload: { answer: "Redis, single node, 512MB." },
    } as MeshOp);
    assert.equal(reply.ok, true, reply.ok ? "" : reply.reason);

    const rec = m.kernel.state.discharged.find((d) => d.messageId === askId);
    assert.equal(rec!.responseValid, true, "a substantive answer must not be flagged");
    assert.equal(rec!.responseIssues, undefined);
  } finally {
    await m.cleanup();
  }
});

test("contracts: an ask opened without a contract is not judged at all", async () => {
  // Absence must read as "not checked", never as "failed" -- otherwise every
  // ask predating this stage, and every plain typed send, would be marked thin
  // the moment it shipped, and the mark would be worth nothing.
  const m = await mesh();
  try {
    const ask = await runOp(m, "architect", {
      op: "send", type: "REQUEST_INFO", to: ["dev"],
      newThread: { subject: "plain ask" }, payload: { question: "which cache?" },
    } as MeshOp);
    const askId = (ask.ok ? ask.messageId : "")!;
    await runOp(m, "dev", {
      op: "send", type: "INFORM", to: ["architect"],
      threadId: m.kernel.state.messages.get(askId)!.threadId,
      replyTo: askId, payload: { answer: "" },
    } as MeshOp);

    const rec = m.kernel.state.discharged.find((d) => d.messageId === askId);
    assert.ok(rec, "it still discharges");
    assert.equal(rec!.responseValid, undefined, "no contract means no verdict, not a failing one");
  } finally {
    await m.cleanup();
  }
});

test("contracts: a hand-written contract stamp in payload buys nothing", async () => {
  // The invariant: the ledger routes on `control`, which only the supervisor
  // writes and only after the request schema passed. While the stamp lived in
  // `payload` -- verbatim agent input -- a seat could name a contract in a raw
  // send and set its own creditor's clock without meeting that contract's
  // schema. `info.question` carries slaMs: 10m, so a forged stamp would be
  // visible here as a deadline.
  const m = await mesh({ bus: { commitments: { ttlMs: 3_600_000 } } });
  try {
    const res = await runOp(m, "architect", {
      op: "send", type: "REQUEST_INFO", to: ["dev"],
      newThread: { subject: "forged" },
      payload: { question: "which cache?", contract: "info.question", contractVersion: 1 },
    } as MeshOp);
    assert.equal(res.ok, true, res.ok ? "" : res.reason);
    const id = (res.ok ? res.messageId : "")!;

    const msg = m.kernel.state.messages.get(id)!;
    assert.equal((msg.payload as Record<string, unknown>).contract, undefined, "the forged key is stripped on send");
    assert.equal(msg.control?.contract, undefined, "and it never reaches the runtime-owned envelope");

    const pending = m.kernel.state.pendingRequests.get(id)!;
    assert.equal(pending.contract, undefined, "so the ledger records no contract");
    // A regime IS configured here, so the ask still gets the mesh-wide
    // deadline -- it just does not get the contract's narrower one.
    const openedAt = new Date(msg.timestamp).getTime();
    assert.equal(
      new Date(pending.dueBy!).getTime() - openedAt,
      3_600_000,
      "the forged stamp must not narrow the clock to the contract's 10 minutes",
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

  // The shapes the RESOLVER actually produces. Asserting on a literal
  // `undefined` above is necessary but NOT sufficient, and that gap is what
  // let this break: `resolveCommitmentTtl` used to be an unconditional object
  // literal, so `computeDueBy` was never once called with the falsy value its
  // first line tests for. The guard was dead code and the rule it encodes went
  // unenforced. These assertions pin the resolver's side of the contract.
  assert.equal(resolveCommitmentTtl(undefined), undefined, "an unconfigured mesh has no deadline regime");
  assert.equal(resolveCommitmentTtl({}), undefined, "an empty commitments block is not a regime");
  assert.equal(resolveCommitmentTtl({ ttl_ms: 0 }), undefined, "zero is how an operator writes 'no deadline'");
  assert.equal(
    computeDueBy(state, debtors, at, resolveCommitmentTtl({}), 60_000),
    undefined,
    "an SLA must not create a deadline on a mesh configured with none",
  );

  // A regime exists: the contract's SLA wins over the default.
  const withDefault = computeDueBy(state, debtors, at, resolveCommitmentTtl({ ttl_ms: 3_600_000 }), 60_000);
  assert.ok(withDefault);
  assert.equal(new Date(withDefault!).getTime() - new Date(at).getTime(), 60_000);

  // A per-role entry is itself a regime, even with no mesh-wide default. The
  // contract's SLA then applies to the seats the operator did not name --
  // narrowing something that already exists, which is the legal direction.
  const byRoleOnly = resolveCommitmentTtl({ ttl_ms_by_role: { qa: 5_000 } });
  assert.ok(byRoleOnly, "naming one role's clock establishes a regime");
  const narrowed = computeDueBy(state, debtors, at, byRoleOnly, 60_000);
  assert.ok(narrowed);
  assert.equal(new Date(narrowed!).getTime() - new Date(at).getTime(), 60_000);
});

test("contracts: a default mesh gives a contract-stamped ask no deadline", async () => {
  // The cell no test covered, and the one that was actually broken in the
  // shipped runtime: a DEFAULT mesh.yaml (no bus block at all) plus an ask
  // carrying a contract stamp. The existing no-TTL tests passed only because
  // their asks carried no contract, and the unit test above passed only
  // because it hand-built a config shape the resolver could not emit. Between
  // the two, every default mesh was handing out 10-to-45-minute deadlines the
  // operator never asked for -- and expiry discharges debt, so those asks were
  // being silently forgiven.
  const m = await mesh();
  try {
    const res = await runOp(m, "architect", call("info.question", { question: "which cache?" }, ["dev"]));
    assert.equal(res.ok, true, res.ok ? "" : res.reason);
    const id = (res.ok ? res.messageId : "")!;
    const pending = m.kernel.state.pendingRequests.get(id);
    assert.ok(pending, "the ask must still open a commitment");
    assert.equal(
      findContract("info.question")?.slaMs,
      10 * 60_000,
      "guard: this test is only meaningful while the contract carries an SLA",
    );
    assert.equal(pending!.dueBy, undefined, "no TTL configured, so the contract's SLA must not create one");
  } finally {
    await m.cleanup();
  }
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

    // `mesh_send` stays: no contract covers answering, or the 16 message types
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
