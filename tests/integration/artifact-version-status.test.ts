import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, evidenceContent } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * What status a NEW VERSION starts at.
 *
 * A version resets `contentRef` and `digest` — it is new content by
 * construction — so any verdict carried over from the predecessor is a verdict
 * about bytes that no longer exist. The write path used to fall back to
 * `current.status` for any requested status it did not recognise, which handed
 * v2 of a CodePatch an APPROVED no reviewer ever granted. That is not a
 * cosmetic mislabel: the code machine leaves APPROVED only for VERIFIED, so no
 * seat could walk it back, and the gate that should have demanded a review had
 * already been passed by a version that no longer existed.
 *
 * `tests/integration/transition-gate.test.ts` proves the gates hold on the
 * transition path. These assert the same property on the PUBLISH path, which
 * reaches status without transitioning at all.
 */

const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.write", "test.execute", "git.commit"], interests: [] },
  { id: "tech-lead", role: "tech-lead", authority: ["implementation.approve"], capabilities: ["code.review", "git.merge"], interests: [] },
];

const COMM = { dev: ["tech-lead"], "tech-lead": ["dev"] };

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

const turnFor = (agentId: string) =>
  ({
    turnId: `t-${agentId}`,
    agentId,
    reason: { kind: "manual" as const },
    sentOps: 0,
    publishedOps: 0,
    waitRequested: false,
    escalated: false,
    results: [],
  }) as never;

async function op(m: Mesh, actorId: string, o: MeshOp) {
  return m.supervisor.executeOp(actorId, o, turnFor(actorId));
}

function must(res: Awaited<ReturnType<Mesh["supervisor"]["createArtifact"]>>) {
  if (!("artifact" in res)) throw new Error(`publish failed: ${res.error}`);
  return res.artifact;
}

async function mesh(): Promise<Mesh> {
  return makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
}

/** Publishes a patch and walks it to APPROVED, the status that used to leak. */
async function approvedPatch(m: Mesh): Promise<string> {
  const id = must(
    await m.supervisor.createArtifact({
      actorId: "dev",
      name: "leaky-patch",
      type: "CodePatch",
      content: evidenceContent("v1 of the patch"),
    }),
  ).id;

  assert.equal((await op(m, "dev", { op: "transition_artifact", artifactId: id, to: "READY_FOR_REVIEW" })).ok, true);
  assert.equal((await op(m, "tech-lead", { op: "transition_artifact", artifactId: id, to: "UNDER_REVIEW" })).ok, true);
  assert.equal((await op(m, "tech-lead", { op: "approve", subject: "implementation", artifactId: id })).ok, true);
  assert.equal((await op(m, "tech-lead", { op: "transition_artifact", artifactId: id, to: "APPROVED" })).ok, true);
  assert.equal(m.kernel.state.artifacts.get(id)?.status, "APPROVED", "precondition: v1 really is approved");
  return id;
}

test("a new version does not inherit the predecessor's APPROVED", async () => {
  const m = await mesh();
  try {
    const v1 = await approvedPatch(m);
    const v2 = must(
      await m.supervisor.createArtifact({
        actorId: "dev",
        name: "leaky-patch",
        type: "CodePatch",
        asVersionOf: v1,
        status: "READY_FOR_REVIEW",
        content: evidenceContent("v2 — different bytes entirely"),
      }),
    );

    assert.equal(v2.version, 2);
    // The author asked for review and must get review, not a free approval.
    assert.equal(
      m.kernel.state.artifacts.get(v2.id)?.status,
      "READY_FOR_REVIEW",
      "v2 carried v1's APPROVED — new bytes wearing an old verdict",
    );
  } finally {
    await m.cleanup();
  }
});

test("a version cannot publish straight into a status the machine gates", async () => {
  const m = await mesh();
  try {
    const v1 = await approvedPatch(m);
    const v2 = must(
      await m.supervisor.createArtifact({
        actorId: "dev",
        name: "leaky-patch",
        type: "CodePatch",
        asVersionOf: v1,
        status: "APPROVED",
        content: evidenceContent("v2 asking for the moon"),
      }),
    );

    // APPROVED is not reachable from DRAFT in one step, so the request is
    // refused down to the machine's initial status rather than honoured.
    assert.equal(
      m.kernel.state.artifacts.get(v2.id)?.status,
      "DRAFT",
      "publish is not a back door around the approval gate",
    );
  } finally {
    await m.cleanup();
  }
});

test("a version with no requested status starts at the machine's initial status", async () => {
  const m = await mesh();
  try {
    const v1 = await approvedPatch(m);
    const v2 = must(
      await m.supervisor.createArtifact({
        actorId: "dev",
        name: "leaky-patch",
        type: "CodePatch",
        asVersionOf: v1,
        content: evidenceContent("v2, no status named"),
      }),
    );

    assert.equal(m.kernel.state.artifacts.get(v2.id)?.status, "DRAFT");
  } finally {
    await m.cleanup();
  }
});
