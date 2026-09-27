import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, collectEvents, evidenceContent } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * A version bump is a status change, so it must leave a transition behind.
 *
 * Publishing `asVersionOf` resets the record to the machine's initial status —
 * usually UNDER_REVIEW back to DRAFT — by writing it straight into the artifact
 * and emitting only `artifact.versioned`. The reducer applies that status without
 * going through `doTransition`, so nothing recorded the step. In a measured run on
 * 2026-09-24 an artifact was versioned five times while under review and its
 * `artifact.transition` stream read `UNDER_REVIEW -> UNDER_REVIEW -> UNDER_REVIEW`:
 * any projection built from transitions alone believed it never left review, and
 * the reviewers holding the v2 ask had no signal that v3..v7 had happened.
 *
 * The audit event is emitted AFTER `artifact.versioned`, so the reducer has
 * already applied the status and `doTransition`'s same-status guard makes it a
 * no-op on live apply and on replay — which is why recording a step the machine
 * tables call illegal (UNDER_REVIEW -> DRAFT) does not need a new edge.
 */

const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.write", "test.execute"], interests: [] },
  { id: "tech-lead", role: "tech-lead", authority: ["implementation.approve"], capabilities: ["code.review"], interests: [] },
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

const op = (m: Mesh, actorId: string, o: MeshOp) => m.supervisor.executeOp(actorId, o, turnFor(actorId));

function must(res: Awaited<ReturnType<Mesh["supervisor"]["createArtifact"]>>) {
  if (!("artifact" in res)) throw new Error(`publish failed: ${res.error}`);
  return res.artifact;
}

/** A patch sitting in UNDER_REVIEW, which is where versioning does its damage. */
async function underReviewPatch(m: Mesh): Promise<string> {
  const id = must(
    await m.supervisor.createArtifact({
      actorId: "dev",
      name: "churning-patch",
      type: "CodePatch",
      content: evidenceContent("v1 of the patch"),
    }),
  ).id;
  assert.equal((await op(m, "dev", { op: "transition_artifact", artifactId: id, to: "READY_FOR_REVIEW" })).ok, true);
  assert.equal((await op(m, "tech-lead", { op: "transition_artifact", artifactId: id, to: "UNDER_REVIEW" })).ok, true);
  assert.equal(m.kernel.state.artifacts.get(id)?.status, "UNDER_REVIEW", "precondition");
  return id;
}

test("versioning an UNDER_REVIEW artifact records the step back to DRAFT", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
  try {
    const id = await underReviewPatch(m);
    const before = (await collectEvents(m)).filter((e) => e.type === "artifact.transition").length;

    must(
      await m.supervisor.createArtifact({
        actorId: "dev",
        name: "churning-patch",
        type: "CodePatch",
        content: evidenceContent("v2 of the patch"),
        asVersionOf: id,
      }),
    );

    assert.equal(m.kernel.state.artifacts.get(id)?.status, "DRAFT", "the version bump really did leave review");
    const transitions = (await collectEvents(m)).filter((e) => e.type === "artifact.transition");
    assert.equal(transitions.length, before + 1, "the step must appear in the log exactly once");
    const last = transitions[transitions.length - 1]!.payload as Record<string, unknown>;
    assert.equal(last.artifactId, id);
    assert.equal(last.to, "DRAFT");
    assert.equal(last.derived, true, "the runtime made this move, not a seat");
  } finally {
    await m.cleanup();
  }
});

test("a version that does not change status records nothing", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
  try {
    const id = must(
      await m.supervisor.createArtifact({
        actorId: "dev",
        name: "quiet-patch",
        type: "CodePatch",
        content: evidenceContent("v1"),
      }),
    ).id;
    assert.equal(m.kernel.state.artifacts.get(id)?.status, "DRAFT", "precondition: already at the initial status");
    const before = (await collectEvents(m)).filter((e) => e.type === "artifact.transition").length;

    must(
      await m.supervisor.createArtifact({
        actorId: "dev",
        name: "quiet-patch",
        type: "CodePatch",
        content: evidenceContent("v2"),
        asVersionOf: id,
      }),
    );

    const after = (await collectEvents(m)).filter((e) => e.type === "artifact.transition").length;
    assert.equal(after, before, "DRAFT -> DRAFT is not a state change and must not be logged as one");
  } finally {
    await m.cleanup();
  }
});

test("a new version restarts the review round count", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
  try {
    const id = await underReviewPatch(m);
    assert.equal(m.kernel.state.reviewRounds.get(id), 1, "precondition: one round spent on v1");

    must(
      await m.supervisor.createArtifact({
        actorId: "dev",
        name: "churning-patch",
        type: "CodePatch",
        content: evidenceContent("v2 of the patch"),
        asVersionOf: id,
      }),
    );

    // `doTransition` only clears rounds on a SETTLED status, and a version lands
    // on DRAFT, which is not settled — so rounds used to accumulate across
    // versions and walk the artifact toward escalation.artifact_review_rounds.max
    // for reviews of content that no longer existed.
    assert.equal(m.kernel.state.reviewRounds.get(id), undefined, "rounds spent on v1 are not rounds spent on v2");
  } finally {
    await m.cleanup();
  }
});
