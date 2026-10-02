import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, evidenceContent } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * A merge asked of a patch that is not MERGEABLE says where the patch stands and whose move is next.
 *
 * The twelfth cronlite run's tech-lead was refused "artifact is APPROVED, must be MERGEABLE" three times (16:54, 16:55 and 16:59),
 * each in the turn in which it had approved the patch: an approved patch has two rungs left, VERIFIED and MERGEABLE, and nothing
 * climbs them by itself. The refusal named neither the rungs nor who may climb them, and the sixth and seventh runs met the same
 * words. In the run's second round the tech-lead climbed the rungs itself and merged in five seconds, which it can do because it
 * holds `implementation.approve`; a seat that only holds `git.merge` cannot, and is told whose move it is.
 */

const DEV = { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "test.execute", "git.commit"], interests: [] };
const LEAD = { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review", "git.merge"], authority: ["implementation.approve"], interests: [] };
const MERGER = { id: "merger", role: "release-manager", capabilities: ["repository.read", "git.merge"], interests: [] };

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

const turnFor = (agentId: string) =>
  ({ turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`, agentId, reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] }) as never;
const op = (m: Mesh, actorId: string, o: MeshOp) => m.supervisor.executeOp(actorId, o, turnFor(actorId));

async function mesh(): Promise<Mesh> {
  const agents = [DEV, LEAD, MERGER];
  const ids = agents.map((a) => a.id);
  return makeMesh({ agents, mayContact: Object.fromEntries(ids.map((id) => [id, ids.filter((o) => o !== id)])), mode: "parked" } as never);
}

async function patch(m: Mesh, name: string, upTo: "DRAFT" | "READY_FOR_REVIEW" | "APPROVED" | "VERIFIED" | "REJECTED"): Promise<string> {
  const created = await m.supervisor.createArtifact({ actorId: "dev", name, type: "CodePatch", content: evidenceContent(name) });
  if (!("artifact" in created)) throw new Error(`create failed: ${JSON.stringify(created)}`);
  const id = created.artifact.id;
  if (upTo === "DRAFT") return id;
  const moved = await m.supervisor.transitionArtifact("dev", id, { to: "READY_FOR_REVIEW" });
  assert.equal(moved.ok, true, String(moved.reason));
  if (upTo === "READY_FOR_REVIEW") return id;
  const ask = await op(m, "dev", { op: "request_review", artifactId: id, reviewers: ["lead"] } as MeshOp);
  assert.equal(ask.ok, true, String(ask.reason));
  if (upTo === "REJECTED") {
    const rejected = await op(m, "lead", { op: "reject", subject: "implementation", artifactId: id, reason: "no" } as MeshOp);
    assert.equal(rejected.ok, true, String(rejected.reason));
    assert.equal(m.kernel.state.artifacts.get(id)?.status, "REJECTED", "fixture");
    return id;
  }
  const approved = await op(m, "lead", { op: "approve", subject: "implementation", artifactId: id } as MeshOp);
  assert.equal(approved.ok, true, String(approved.reason));
  assert.equal(m.kernel.state.artifacts.get(id)?.status, "APPROVED", "fixture");
  if (upTo === "APPROVED") return id;
  const verified = await m.supervisor.transitionArtifact("lead", id, { to: "VERIFIED" });
  assert.equal(verified.ok, true, String(verified.reason));
  return id;
}

const merge = (m: Mesh, who: string, id: string) => op(m, who, { op: "merge", artifactId: id } as MeshOp);

test("an approved patch: the seat that may climb the ladder is told it can, with the two rungs named", async () => {
  const m = await mesh();
  try {
    const id = await patch(m, "slice", "APPROVED");
    const res = await merge(m, "lead", id);
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /^artifact is APPROVED, must be MERGEABLE: /, "the refusal it always was, first");
    assert.match(res.reason ?? "", /nothing moves a patch up the ladder by itself/);
    assert.match(res.reason ?? "", /You can move it to VERIFIED and then MERGEABLE with mesh_artifact_transition, and then it can be merged/);

    // And the repair it names works.
    assert.equal((await m.supervisor.transitionArtifact("lead", id, { to: "VERIFIED" })).ok, true);
    assert.equal((await m.supervisor.transitionArtifact("lead", id, { to: "MERGEABLE" })).ok, true);
    assert.equal(m.kernel.state.artifacts.get(id)?.status, "MERGEABLE");
  } finally {
    await m.cleanup();
  }
});

test("an approved patch, asked by a seat that cannot climb the ladder: it is told whose move it is", async () => {
  const m = await mesh();
  try {
    const id = await patch(m, "slice", "APPROVED");
    const res = await merge(m, "merger", id);
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /^artifact is APPROVED, must be MERGEABLE: /);
    assert.match(res.reason ?? "", /dev \(or a seat that may verify\) can move it to VERIFIED and then MERGEABLE with mesh_artifact_transition/);
    assert.doesNotMatch(res.reason ?? "", /You can/, "it cannot, so it is not told it can");
  } finally {
    await m.cleanup();
  }
});

test("a verified patch has one rung left, and the others say what they are waiting for", async () => {
  const m = await mesh();
  try {
    const verified = await patch(m, "verified one", "VERIFIED");
    const v = await merge(m, "lead", verified);
    assert.match(v.reason ?? "", /^artifact is VERIFIED, must be MERGEABLE: /);
    assert.match(v.reason ?? "", /You can move it to MERGEABLE with mesh_artifact_transition, and then it can be merged/);
    assert.doesNotMatch(v.reason ?? "", /VERIFIED and then/, "one rung, not two");

    const draft = await patch(m, "draft one", "DRAFT");
    assert.match((await merge(m, "lead", draft)).reason ?? "", /^artifact is DRAFT, must be MERGEABLE: it is still a DRAFT, so dev submits it for review first/);

    const waiting = await patch(m, "waiting one", "READY_FOR_REVIEW");
    assert.match((await merge(m, "lead", waiting)).reason ?? "", /^artifact is READY_FOR_REVIEW, must be MERGEABLE: it has not been approved yet, so a reviewer rules on it first/);

    const rejected = await patch(m, "rejected one", "REJECTED");
    assert.match((await merge(m, "lead", rejected)).reason ?? "", /^artifact is REJECTED, must be MERGEABLE: it was rejected, so dev reworks it \(a new version with asVersionOf\) and asks for a review/);
  } finally {
    await m.cleanup();
  }
});
