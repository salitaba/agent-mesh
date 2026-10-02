import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { createMcpToolset } from "../../apps/mesh-server/src/mcp";
import { mintSeatToken } from "../../packages/core/src/seat-token";
import { buildAgentContext, renderContextInstructions } from "../../packages/core/src/context";
import { givesPassForApprove, passOnlyDomains } from "../../packages/core/src/projections-helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * The positive verdict of the seats that test and scan is a pass, and `mesh_approve` said approve.
 *
 * `quality.pass` and `security.pass` are what QA and security hold in every shipped mesh, and the
 * tool the contracts vocabulary leaves them for a positive verdict, `mesh_approve`, had no `kind`:
 * an approve is checked against `<domain>.approve`, which they do not hold. The fifth cronlite
 * run's QA tested the merged product, asked to approve `quality`, and was told "lacks authority
 * 'quality.approve' — no agent seat holds it", true of the token and useless to a seat whose own
 * `quality.pass` was the verdict it was after. It published its report and told the requester in
 * prose. The `qa.pass` a transition gate reads and the `quality-verified` evidence a pass lands
 * were never recorded, and the product's quality criterion was closed by the pm, by hand.
 *
 * Now `mesh_approve` takes `kind: "pass"`; an approve from a seat whose verdict in that domain is
 * a pass (it holds `<domain>.pass` and not `<domain>.approve`) is recorded as that pass and says
 * so; a refusal names what the other seats hold in the domain; and the briefing tells the seat
 * which word its verdict is. A seat that holds both keeps the word it chose: a bare approve is
 * still not a pass where the seat could have given either (`tests/integration/transition-gate.test.ts`).
 */

const PASS_ONLY = ["quality.block", "quality.pass"];
const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write"], interests: [] },
  // The shipped QA seat: it blocks and it passes, and it holds no approve.
  { id: "qa", role: "qa", authority: PASS_ONLY, capabilities: ["repository.read", "test.execute", "test.write"], interests: [] },
  { id: "lead", role: "tech-lead", authority: ["implementation.approve", "architecture.approve"], capabilities: ["repository.read", "review.design"], interests: [] },
];
const COMM = { dev: ["qa", "lead"], qa: ["dev", "lead"], lead: ["dev", "qa"] };
const CRITERIA = [{ id: "quality-verified", description: "the tests pass", mandatory: true }];

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

const turnFor = (agentId: string) =>
  ({ turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`, agentId, reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] }) as never;

function parked(extra: Array<Record<string, unknown>> = [], criteria = CRITERIA): Promise<Mesh> {
  return makeMesh({ agents: [...AGENTS, ...extra], mayContact: { ...COMM, ...Object.fromEntries(extra.map((a) => [a.id as string, ["dev", "qa", "lead"]])) }, criteria, mode: "parked" } as never);
}

function caller(m: Mesh) {
  const mcp = createMcpToolset(m.supervisor);
  return async (as: string, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown> & { ok: boolean }> => {
    const tok = mintSeatToken(m.config.meshId, as, m.kernel.state.activeGoalId);
    const res = (await mcp.handle(as, tok, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as { result: { content: Array<{ text: string }> } };
    return JSON.parse(res.result.content[0]!.text);
  };
}

const recorded = (m: Mesh, actorId: string) => [...m.kernel.state.approvals.values()].flat().filter((r) => r.actorId === actorId);
const criterion = (m: Mesh) => m.kernel.state.goals.get(m.kernel.state.activeGoalId!)!.acceptanceCriteria.find((c) => c.id === "quality-verified");

// ---------------------------------------------------------------- the predicate

test("a pass is the positive verdict only where the list holds it and no approve beside it", () => {
  assert.equal(givesPassForApprove(PASS_ONLY, "quality"), true);
  assert.equal(givesPassForApprove(["quality.pass"], "quality"), true);
  assert.equal(givesPassForApprove(["quality.pass", "quality.approve"], "quality"), false, "holding both, the seat chooses");
  assert.equal(givesPassForApprove(["quality.*"], "quality"), false, "a wildcard holds the approve");
  assert.equal(givesPassForApprove(["*"], "quality"), false, "and so does the operator's");
  assert.equal(givesPassForApprove(PASS_ONLY, "security"), false, "another domain is another verdict");
  assert.equal(givesPassForApprove(["quality.block"], "quality"), false, "a block is not a pass");
  assert.equal(givesPassForApprove(undefined, "quality"), false);
  assert.deepEqual(passOnlyDomains(["quality.block", "quality.pass", "security.pass", "security.approve", "implementation.approve"]), ["quality"]);
  assert.deepEqual(passOnlyDomains(["security.pass", "quality.pass", "quality.pass"]), ["security", "quality"], "in the order held, once each");
  assert.deepEqual(passOnlyDomains(["quality.*", "quality.pass"]), []);
  assert.deepEqual(passOnlyDomains(undefined), []);
});

// ------------------------------------------------------------------ the verdict

test("an approve from a seat whose verdict in the domain is a pass is recorded as that pass, and says so", async () => {
  const m = await parked();
  try {
    const res = await m.supervisor.executeOp("qa", { op: "approve", subject: "quality", comment: "77/77 on the merged commit" } as MeshOp, turnFor("qa"));
    assert.equal(res.ok, true, res.reason ?? "");
    assert.match(res.reason ?? "", /recorded as your quality\.pass: that is the verdict your authority gives in this domain/);
    assert.equal(res.caveat, true, "it reaches the seat as a note on an accepted call");

    const events = await m.store.read({ types: ["review.approved"] });
    assert.equal(events.length, 1);
    assert.equal((events[0]!.payload as { kind?: string }).kind, "pass", "the event carries the verdict the seat is entitled to, not the word it used");
    assert.deepEqual(recorded(m, "qa").map((r) => r.kind), ["pass"], "and the projection a `qa.pass` gate reads agrees");
    assert.equal(criterion(m)?.status, "EVIDENCED", "a quality pass lands the evidence the criterion is closed by");
  } finally {
    await m.cleanup();
  }
});

test("a seat that holds both keeps the word it chose: a bare approve is still not a pass", async () => {
  const m = await parked([{ id: "qa2", role: "qa", authority: ["quality.approve", "quality.pass"], capabilities: ["repository.read", "test.execute"], interests: [] }]);
  try {
    const res = await m.supervisor.executeOp("qa2", { op: "approve", subject: "quality" } as MeshOp, turnFor("qa2"));
    assert.equal(res.ok, true, res.reason ?? "");
    assert.equal(res.reason, undefined, "nothing was changed, so nothing is said");
    assert.deepEqual(recorded(m, "qa2").map((r) => r.kind), ["approve"]);
    assert.notEqual(criterion(m)?.status, "EVIDENCED", "an approve is not the pass the criterion reads");

    const passed = await m.supervisor.executeOp("qa2", { op: "approve", kind: "pass", subject: "quality" } as MeshOp, turnFor("qa2"));
    assert.equal(passed.ok, true, passed.reason ?? "");
    assert.equal(criterion(m)?.status, "EVIDENCED", "the declared pass does");
  } finally {
    await m.cleanup();
  }
});

test("a seat with no verdict in the domain is still refused, and the refusal names what the others hold there", async () => {
  const m = await parked();
  try {
    const res = await m.supervisor.executeOp("lead", { op: "approve", subject: "quality" } as MeshOp, turnFor("lead"));
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /lacks authority 'quality\.approve' — no agent seat holds it; in this domain qa holds quality\.block, quality\.pass/);
    assert.doesNotMatch(res.reason ?? "", /human/, "the operator is not offered as the remedy");
    assert.deepEqual(recorded(m, "lead"), [], "and nothing was recorded");
    assert.notEqual(criterion(m)?.status, "EVIDENCED");
  } finally {
    await m.cleanup();
  }
});

test("only an approve is ever read as a pass: a reject or a veto from the same seat is refused, never inverted", async () => {
  const m = await parked();
  try {
    for (const op of ["reject", "veto", "block"] as const) {
      const res = await m.supervisor.executeOp("qa", { op, subject: "implementation", ...(op === "block" ? { reason: "no" } : { comment: "no" }) } as MeshOp, turnFor("qa"));
      assert.equal(res.ok, false, `${op} on a domain qa holds nothing in`);
    }
    const rejectedOwn = await m.supervisor.executeOp("qa", { op: "reject", subject: "quality", comment: "it fails" } as MeshOp, turnFor("qa"));
    assert.equal(rejectedOwn.ok, false, "qa holds quality.block and quality.pass, and a reject is neither");
    assert.deepEqual(recorded(m, "qa"), [], "and no pass was recorded for any of them");
    assert.notEqual(criterion(m)?.status, "EVIDENCED");
  } finally {
    await m.cleanup();
  }
});

test("a domain nobody else holds anything in says only that nobody holds it", async () => {
  const m = await parked();
  try {
    const res = await m.supervisor.executeOp("dev", { op: "approve", subject: "security" } as MeshOp, turnFor("dev"));
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /lacks authority 'security\.approve' — no agent seat holds it$/, res.reason);
  } finally {
    await m.cleanup();
  }
});

// -------------------------------------------------------------------- the tool

test("mesh_approve takes kind, and a pass through it is the declared pass with no upgrade to explain", async () => {
  const m = await parked([{ id: "qa2", role: "qa", authority: ["quality.approve", "quality.pass"], capabilities: ["repository.read", "test.execute"], interests: [] }]);
  try {
    const call = caller(m);
    const plain = await call("qa", "mesh_approve", { subject: "quality", comment: "all green" });
    assert.equal(plain.ok, true, JSON.stringify(plain));
    assert.match(String(plain.note), /recorded as your quality\.pass/, "without kind, the pass-only seat is told what its approve became");

    const asked = await call("qa2", "mesh_approve", { subject: "quality", kind: "pass", comment: "all green" });
    assert.equal(asked.ok, true, JSON.stringify(asked));
    // Asked for directly, the verdict word needs no explaining. (These calls are made outside any turn that checked
    // anything, so the criterion lands ASSERTED and the note says that; `tests/core/pass-evidence.test.ts` pins it.)
    assert.doesNotMatch(String(asked.note ?? ""), /recorded as your quality\.pass/, "asked for directly, there is no upgrade to explain");
    assert.deepEqual(recorded(m, "qa2").map((r) => r.kind), ["pass"], "and the seat that could have given either gave the one it named");

    const approved = await call("qa2", "mesh_approve", { subject: "architecture" });
    assert.equal(approved.ok, false, "a verdict in a domain it has no authority in is still refused");
    assert.deepEqual(recorded(m, "qa2").map((r) => r.kind), ["pass"]);
  } finally {
    await m.cleanup();
  }
});

test("the manifest offers kind on mesh_approve and on no other verdict tool", async () => {
  const m = await parked();
  try {
    const mcp = createMcpToolset(m.supervisor);
    const tok = mintSeatToken(m.config.meshId, "qa", m.kernel.state.activeGoalId);
    const res = (await mcp.handle("qa", tok, { jsonrpc: "2.0", id: 1, method: "tools/list" })) as { result: { tools: Array<{ name: string; inputSchema: { properties: Record<string, { enum?: string[] }> } }> } };
    const props = (name: string) => res.result.tools.find((t) => t.name === name)?.inputSchema.properties ?? {};
    assert.deepEqual(props("mesh_approve").kind?.enum, ["approve", "pass"]);
    for (const other of ["mesh_reject", "mesh_block"]) assert.equal(props(other).kind, undefined, `${other} has one word`);
  } finally {
    await m.cleanup();
  }
});

// ----------------------------------------------------------------- the briefing

test("the seat whose verdict is a pass is told so, and the seats whose verdict is not are not", async () => {
  const m = await parked([{ id: "qa2", role: "qa", authority: ["quality.approve", "quality.pass"], capabilities: ["repository.read", "test.execute"], interests: [] }]);
  try {
    const briefing = (id: string) => renderContextInstructions(buildAgentContext({ config: m.config, kernel: m.kernel }, id));
    const qa = briefing("qa");
    assert.match(qa, /Your positive verdict in quality is a pass, not an approve: give it with `mesh_approve` \{ subject: "quality", kind: "pass", artifactId: "<what you verified>"/);
    assert.match(qa, /An approve from you is recorded as that pass/);
    for (const other of ["qa2", "lead", "dev"]) assert.doesNotMatch(briefing(other), /is a pass, not an approve/, `${other} is not told it`);
  } finally {
    await m.cleanup();
  }
});
