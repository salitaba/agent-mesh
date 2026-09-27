import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { createMcpToolset } from "../../apps/mesh-server/src/mcp";
import { mintSeatToken } from "../../packages/core/src/seat-token";
import { Kernel } from "../../packages/core/src/kernel";
import { projectionConfigFor } from "../../packages/core/src/projections";
import { MemoryEventStore } from "../../packages/event-store/src/index";
import { buildMetrics } from "../../packages/observability/src/index";
import { FixedClock, type MeshEvent, type MeshOp } from "../../packages/protocol/src/index";

/**
 * §9 and §10 of the 2026-09-25 live run: the verdict ledger.
 *
 * §9 — seq 101 approved `art-M3D4Y3VV00d5bb1584`, which never existed, and got
 * ok:true: `resolveArtifactRef` returns an unresolved id as-is, and with no
 * artifact every screen in `recordDecision` was skipped.
 *
 * §10 — architecture-domain approvals were emitted as `architecture.approved`
 * INSTEAD of `review.approved`, so tech-lead queried `review.approved`, missed
 * its own approval, re-approved, and called the first "unbacked". And it fired
 * whether or not anything was approved (one of 4 approved a DRAFT that stayed
 * DRAFT).
 */

const AGENTS = [
  { id: "arch", role: "architect", capabilities: ["repository.read", "repository.write"], authority: ["architecture.approve"], interests: [] },
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "review.design"], authority: ["architecture.approve"], interests: [] },
];
const COMM = { arch: ["lead"], lead: ["arch"] };

const turnFor = (agentId: string) =>
  ({
    turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`,
    agentId,
    reason: { kind: "manual" as const },
    sentOps: 0,
    publishedOps: 0,
    waitRequested: false,
    escalated: false,
    results: [],
  }) as never;

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

async function mesh(): Promise<Mesh> {
  return makeMesh({
    agents: AGENTS,
    mayContact: COMM,
    mode: "parked",
    criteria: [{ id: "architecture-approved", description: "architecture approved", mandatory: false }],
  } as never);
}

async function design(m: Mesh, name = "core-arch") {
  const created = await m.supervisor.createArtifact({ actorId: "arch", name, type: "ArchitectureDocument", content: "the design, at length, with every section filled in" });
  if (!("artifact" in created)) throw new Error("create failed");
  return created.artifact.id;
}

const ofType = async (m: Mesh, type: string) => (await m.store.read()).filter((e) => e.type === type);
const criterion = (m: Mesh) =>
  m.kernel.state.goals.get(m.kernel.state.activeGoalId!)!.acceptanceCriteria.find((c) => c.id === "architecture-approved")!;

test("comms: a verdict on an artifact that does not exist is refused and records nothing", async () => {
  const m = await mesh();
  try {
    const res = await m.supervisor.executeOp("lead", { op: "approve", subject: "architecture", artifactId: "art-M3D4Y3VV00d5bb1584", comment: "lgtm" } as MeshOp, turnFor("lead"));
    assert.equal(res.ok, false, "seq 101 got ok:true for an artifact that never existed");
    assert.match(String(res.reason), /unknown artifact 'art-M3D4Y3VV00d5bb1584'/);
    assert.deepEqual(await ofType(m, "review.approved"), []);
    assert.deepEqual(await ofType(m, "architecture.approved"), []);
    assert.equal([...m.kernel.state.approvals.values()].flat().length, 0, "no phantom approval on the ledger");
    const denial = (await ofType(m, "message.rejected")).find((e) => (e.payload as { ruleId?: string }).ruleId === "verdict.unknown-artifact");
    assert.ok(denial, "the refusal is on the record");

    // A URI-only verdict that resolves to nothing used to become a subject-level
    // approval with no artifact — one `checkApprovals` counts against every artifact.
    const byUri = await m.supervisor.executeOp("lead", { op: "reject", subject: "architecture", artifactUri: "artifact://ArchitectureDocument/nope/1" } as MeshOp, turnFor("lead"));
    assert.equal(byUri.ok, false);
    assert.match(String(byUri.reason), /unknown artifact/);

    // A subject-level sign-off with no artifact at all is still a legitimate act.
    const subjectOnly = await m.supervisor.executeOp("lead", { op: "approve", subject: "architecture", comment: "direction agreed" } as MeshOp, turnFor("lead"));
    assert.equal(subjectOnly.ok, true, subjectOnly.reason);
  } finally {
    await m.cleanup();
  }
});

test("comms: an architecture approval that lands is a review.approved, with architecture.approved derived after it", async () => {
  const m = await mesh();
  try {
    const id = await design(m);
    await m.supervisor.executeOp("arch", { op: "request_review", artifactId: id, reviewers: ["lead"] } as MeshOp, turnFor("arch"));
    assert.equal(m.kernel.state.artifacts.get(id)?.status, "UNDER_REVIEW");

    const res = await m.supervisor.executeOp("lead", { op: "approve", subject: "architecture", artifactId: id, comment: "sound" } as MeshOp, turnFor("lead"));
    assert.equal(res.ok, true, res.reason);
    assert.equal(m.kernel.state.artifacts.get(id)?.status, "APPROVED");

    const approved = await ofType(m, "review.approved");
    assert.equal(approved.length, 1, "the approval is findable where every other approval is");
    const derived = await ofType(m, "architecture.approved");
    assert.equal(derived.length, 1, "the architecture milestone still fires, for the seats that wake on it");
    assert.equal((derived[0]!.payload as { derived?: boolean }).derived, true);
    assert.equal((derived[0]!.payload as { viaEvent?: string }).viaEvent, approved[0]!.id, "and names the approval it restates");
    assert.ok((derived[0]!.seq ?? 0) > (approved[0]!.seq ?? 0), "derived after the approval, never instead of it");
    assert.notEqual(criterion(m).status, "UNSATISFIED", "the criterion moves with the approval");

    // Counted ONCE, live and on replay.
    const count = (st: typeof m.kernel.state) => [...st.approvals.values()].flat().filter((r) => r.artifactId === id).length;
    assert.equal(count(m.kernel.state), 1, "the derived event records no second approval");
    assert.equal(buildMetrics(m.kernel.state, 1000).approvals, 1, "metrics count one approval, not two");
    const fresh = new Kernel(new MemoryEventStore(), new FixedClock(), undefined, projectionConfigFor(m.config));
    await fresh.rebuild((await m.store.read()) as MeshEvent[]);
    assert.equal(count(fresh.state), 1, "a replayed log counts the approval once too");
    assert.equal(fresh.state.artifacts.get(id)?.status, "APPROVED");
  } finally {
    await m.cleanup();
  }
});

test("comms: an architecture approval that moves nothing emits no architecture.approved and marks no criterion", async () => {
  const m = await mesh();
  try {
    const id = await design(m);
    assert.equal(m.kernel.state.artifacts.get(id)?.status, "DRAFT");

    const res = await m.supervisor.executeOp("lead", { op: "approve", subject: "architecture", artifactId: id } as MeshOp, turnFor("lead"));
    assert.equal(res.ok, true, "the signature is still recorded");
    assert.equal(res.caveat, true);
    assert.match(String(res.reason), /DRAFT/);
    assert.equal((await ofType(m, "review.approved")).length, 1, "recorded where a seat will look for it");
    assert.deepEqual(await ofType(m, "architecture.approved"), [], "seq 513 approved a DRAFT that stayed DRAFT and still announced it");
    assert.equal(criterion(m).status, "UNSATISFIED", "an approval of a DRAFT is not the architecture being approved");
  } finally {
    await m.cleanup();
  }
});

test("comms: repeating the same verdict on the same version says so", async () => {
  const m = await mesh();
  try {
    const id = await design(m);
    await m.supervisor.executeOp("arch", { op: "request_review", artifactId: id, reviewers: ["lead"] } as MeshOp, turnFor("arch"));
    const first = await m.supervisor.executeOp("lead", { op: "approve", subject: "architecture", artifactId: id } as MeshOp, turnFor("lead"));
    assert.equal(first.reason, undefined, "the first one moved it — clean");

    const again = await m.supervisor.executeOp("lead", { op: "approve", subject: "architecture", artifactId: id } as MeshOp, turnFor("lead"));
    assert.equal(again.ok, true);
    assert.equal(again.caveat, true);
    assert.match(String(again.reason), /already recorded approve on ArchitectureDocument "core-arch" v1/, "pm signed one v1 three times");
  } finally {
    await m.cleanup();
  }
});

test("comms: mesh_query_events finds every verdict under one family name", async () => {
  const m = await mesh();
  try {
    const a = await design(m, "a-arch");
    const b = await design(m, "b-arch");
    for (const id of [a, b]) await m.supervisor.executeOp("arch", { op: "request_review", artifactId: id, reviewers: ["lead"] } as MeshOp, turnFor("arch"));
    await m.supervisor.executeOp("lead", { op: "approve", subject: "architecture", artifactId: a } as MeshOp, turnFor("lead"));
    await m.supervisor.executeOp("lead", { op: "reject", subject: "architecture", artifactId: b, comment: "types undefined" } as MeshOp, turnFor("lead"));

    const mcp = createMcpToolset(m.supervisor);
    const tok = mintSeatToken(m.config.meshId, "lead", m.kernel.state.activeGoalId);
    const query = async (args: Record<string, unknown>) => {
      const raw = (await mcp.handle("lead", tok, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "mesh_query_events", arguments: args } })) as {
        result: { content: Array<{ text: string }> };
      };
      return JSON.parse(raw.result.content[0]!.text) as { events: Array<{ type: string }> };
    };

    const verdicts = await query({ type: "verdict" });
    assert.deepEqual(verdicts.events.map((e) => e.type).sort(), ["review.approved", "review.rejected"], "one row per verdict: the derived echo is not a second one");

    const both = await query({ types: ["review.approved", "architecture.approved"] });
    assert.deepEqual(both.events.map((e) => e.type).sort(), ["architecture.approved", "review.approved"], "an explicit type list is taken literally");
  } finally {
    await m.cleanup();
  }
});
