import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * An approval that cannot advance its artifact must say so.
 *
 * Recording a verdict and MOVING an artifact are different acts, and the first
 * is legitimate in statuses where the second is impossible: a `<role>.approve`
 * transition gate is satisfied by a recorded signature, and seats sign
 * artifacts sitting at gate statuses no approval can advance. So this is a
 * caveat, not a refusal.
 *
 * What is not legitimate is silence. In a live mission a reviewer gave nine
 * architecture documents a reasoned APPROVE with binding errata; all nine were
 * recorded, none of them moved, and every implementer — woken by the approval
 * event and told by its role prompt that it "unlocks implementation" — built on
 * an architecture the projection still called unapproved. Every one of those
 * turns reported `{ ok: true }` and nothing else.
 */

const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write"], interests: [] },
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review"], authority: ["implementation.approve"], interests: [] },
];

const COMM = { dev: ["lead"], lead: ["dev"] };

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

async function meshWithDraftPatch() {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" } as never);
  const created = await m.supervisor.createArtifact({ actorId: "dev", name: "draft-patch", type: "CodePatch", content: "diff" });
  if (!("artifact" in created)) throw new Error("artifact failed");
  return { m, id: created.artifact.id };
}

test("approving an artifact that is not under review reports that it moved nothing", async () => {
  const { m, id } = await meshWithDraftPatch();
  try {
    assert.equal(m.kernel.state.artifacts.get(id)?.status, "DRAFT");

    const res = await m.supervisor.executeOp(
      "lead",
      { op: "approve", subject: "implementation", artifactId: id, comment: "looks right" } as MeshOp,
      turnFor("lead"),
    );

    assert.equal(res.ok, true, "the signature is still recorded — a gate token may depend on it");
    assert.ok(res.reason, "but the turn must not read as a clean approval");
    assert.match(res.reason!, /DRAFT/, "the reason says where the artifact actually is");
    assert.match(res.reason!, /cannot advance/i, "and that the approval did not move it");
  } finally {
    await m.cleanup();
  }
});

test("the verdict is still recorded, so a gate signature on a gate status keeps working", async () => {
  const { m, id } = await meshWithDraftPatch();
  try {
    await m.supervisor.executeOp(
      "lead",
      { op: "approve", subject: "implementation", artifactId: id } as MeshOp,
      turnFor("lead"),
    );
    const recorded = [...m.kernel.state.approvals.values()].flat().filter((r) => r.artifactId === id);
    assert.equal(recorded.length, 1, "the caveat must not cost the signature");
  } finally {
    await m.cleanup();
  }
});

test("an approval that DOES advance the artifact carries no caveat", async () => {
  const { m, id } = await meshWithDraftPatch();
  try {
    await m.supervisor.executeOp("dev", { op: "request_review", artifactId: id, reviewers: ["lead"] } as MeshOp, turnFor("dev"));
    assert.equal(m.kernel.state.artifacts.get(id)?.status, "UNDER_REVIEW", "the review request puts it in review");

    const res = await m.supervisor.executeOp(
      "lead",
      { op: "approve", subject: "implementation", artifactId: id } as MeshOp,
      turnFor("lead"),
    );

    assert.equal(res.ok, true, res.reason);
    assert.equal(m.kernel.state.artifacts.get(id)?.status, "APPROVED", "the approval did what it said");
    assert.equal(res.reason, undefined, "a clean approval must stay clean — a caveat on every success is noise");
  } finally {
    await m.cleanup();
  }
});

test("approving an artifact that cannot be advanced by any approval also says so", async () => {
  // A ReleasePlan has no APPROVED edge from any status: the release machine
  // runs PROPOSED -> IMPLEMENTED -> QA_VERIFIED -> SECURITY_VERIFIED ->
  // ACCEPTED. An approval on one is inert wherever it sits.
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write"], interests: [] },
      { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review"], authority: ["release.approve"], interests: [] },
    ],
    mayContact: { dev: ["lead"], lead: ["dev"] },
    mode: "parked",
  } as never);
  try {
    const created = await m.supervisor.createArtifact({ actorId: "dev", name: "the-release", type: "ReleasePlan", content: "plan" });
    if (!("artifact" in created)) throw new Error("artifact failed");

    const res = await m.supervisor.executeOp(
      "lead",
      { op: "approve", subject: "release", artifactId: created.artifact.id } as MeshOp,
      turnFor("lead"),
    );

    assert.equal(res.ok, true, "still recorded");
    assert.match(res.reason ?? "", /cannot advance/i, "an approval that can never move this type must not read as one that did");
  } finally {
    await m.cleanup();
  }
});

/**
 * A criterion is a statement about the ARTIFACT, not about the capacity the
 * signer was acting in.
 *
 * `markCriterionEvidence("architecture-approved", …)` lived only inside
 * `mirrorTransition`, which runs on the explicit `transition_artifact` op. When an
 * approval moves an artifact through the REDUCER — which is what `recordDecision`
 * does — the mark never happened.
 *
 * That is not a corner case. skill-panel's `roles/reviewer.md` tells its tech-lead
 * seat "you hold `quality.approve` and `quality.reject`", so the seat signs
 * `subject: "quality"` on everything, including ArchitectureDocuments. In a live run
 * it did exactly that eleven times — four of them architecture artifacts — and every
 * one moved the artifact while `architecture.approved` stopped firing. The artifacts
 * were APPROVED and the mission's acceptance record said the criterion was unmet.
 *
 * The signer's word still decides which EVENT is emitted, which must not change:
 * `architecture.approved`'s reducer guard is strictly narrower than
 * `review.approved`'s and widening it breaks replay equality.
 */
const DESIGN_AGENTS = [
  { id: "arch", role: "architect", capabilities: ["repository.read", "repository.write"], authority: ["architecture.approve"], interests: [] },
  // The live shape: a quality capacity, and the capability that lets it review a
  // design artifact. It holds NO architecture.approve.
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "review.design"], authority: ["quality.approve"], interests: [] },
];

const criterionState = (m: Awaited<ReturnType<typeof makeMesh>>, id: string) =>
  m.kernel.state.goals.get(m.kernel.state.activeGoalId!)?.acceptanceCriteria?.find((c) => c.id === id);

test("an ArchitectureDocument approved under `subject: \"quality\"` moves AND marks the criterion", async () => {
  const m = await makeMesh({
    agents: DESIGN_AGENTS,
    mayContact: { arch: ["lead"], lead: ["arch"] },
    mode: "parked",
    criteria: [{ id: "architecture-approved", description: "architecture approved", mandatory: true }],
  } as never);
  try {
    const created = await m.supervisor.createArtifact({ actorId: "arch", name: "core-arch", type: "ArchitectureDocument", content: "the design, at length" });
    if (!("artifact" in created)) throw new Error("artifact failed");
    const id = created.artifact.id;
    await m.supervisor.transitionArtifact("arch", id, { to: "READY_FOR_REVIEW" });
    await m.supervisor.executeOp("arch", { op: "request_review", artifactId: id, reviewers: ["lead"] } as MeshOp, turnFor("arch"));
    assert.equal(m.kernel.state.artifacts.get(id)?.status, "UNDER_REVIEW");

    assert.notEqual(criterionState(m, "architecture-approved")?.status, "EVIDENCED", "not yet");

    // Signed in its own capacity, exactly as its role prompt instructs.
    const res = await m.supervisor.executeOp("lead", { op: "approve", subject: "quality", artifactId: id } as MeshOp, turnFor("lead"));
    assert.equal(res.ok, true, res.reason ?? "");

    assert.equal(m.kernel.state.artifacts.get(id)?.status, "APPROVED", "review.design settles it — this half already worked");
    const crit = criterionState(m, "architecture-approved");
    assert.ok(crit, "the criterion exists");
    assert.notEqual(crit.status, "UNSATISFIED", `the criterion must move with the artifact, got ${crit.status}`);
  } finally {
    await m.cleanup();
  }
});

test("the criterion evidence names the acting seat, not the artifact's owner", async () => {
  // `by` has to be threaded rather than defaulted: `claimIsVerified` reads an
  // ABSENT claimer as runtime-derived and therefore verified by construction, so
  // passing undefined would let a reviewer's no-tool approval land EVIDENCED and
  // defeat the verification gate entirely.
  const m = await makeMesh({
    agents: DESIGN_AGENTS,
    mayContact: { arch: ["lead"], lead: ["arch"] },
    mode: "parked",
    criteria: [{ id: "architecture-approved", description: "architecture approved", mandatory: true }],
  } as never);
  try {
    const created = await m.supervisor.createArtifact({ actorId: "arch", name: "api", type: "ApiSpec", content: "the spec, at length" });
    if (!("artifact" in created)) throw new Error("artifact failed");
    const id = created.artifact.id;
    await m.supervisor.transitionArtifact("arch", id, { to: "READY_FOR_REVIEW" });
    await m.supervisor.executeOp("arch", { op: "request_review", artifactId: id, reviewers: ["lead"] } as MeshOp, turnFor("arch"));
    await m.supervisor.executeOp("lead", { op: "approve", subject: "quality", artifactId: id } as MeshOp, turnFor("lead"));

    const crit = criterionState(m, "architecture-approved");
    const evidence = (crit?.evidence ?? []) as Array<{ by?: string }>;
    assert.ok(evidence.length > 0, "evidence was recorded");
    assert.equal(evidence[evidence.length - 1]!.by, "lead", "the reviewer signed it, not the architect who owns the artifact");
  } finally {
    await m.cleanup();
  }
});
