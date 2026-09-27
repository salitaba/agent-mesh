import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, collectEvents, evidenceContent } from "../helpers";
import { hasApprovalForArtifact } from "../../packages/core/src/projections";

/**
 * A new version must not inherit the previous version's verdict.
 *
 * `createArtifact` states the rule in its own comment — "a version is new content
 * ... so it must not carry the predecessor's verdict" — and clears `contentRef`
 * and `digest` to enforce it. The reducer did not: it dropped `block` records on a
 * version bump and kept `approve`/`pass`, and `ApprovalRecord` carries no version.
 * So a v1 signature stayed valid for content nobody had read, pre-satisfying the
 * `to === "APPROVED"` precondition and any configured `patch.approve` gate.
 *
 * Measured on the skill-panel runs of 2026-09-23 and 2026-09-24: an artifact
 * reached APPROVED (and in one case FINAL), its own author published a new
 * version, the status silently walked back to DRAFT — and every one of those
 * transitions reported `gateSatisfied: true` while no gate had been consulted.
 * Both halves are asserted here.
 */

const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.write", "test.execute"], interests: [] },
  {
    id: "tech-lead",
    role: "tech-lead",
    authority: ["implementation.approve", "implementation.reject", "quality.approve", "quality.reject"],
    capabilities: ["code.review"],
    interests: [],
  },
];
const COMM = { dev: ["tech-lead"], "tech-lead": ["dev"] };

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

function must(res: Awaited<ReturnType<Mesh["supervisor"]["createArtifact"]>>) {
  if (!("artifact" in res)) throw new Error(`publish failed: ${res.error}`);
  return res.artifact;
}

/** A patch that has been reviewed and carries tech-lead's approval. */
async function approvedPatch(m: Mesh): Promise<string> {
  const a = must(
    await m.supervisor.createArtifact({
      actorId: "dev",
      name: "signed-patch",
      type: "CodePatch",
      content: evidenceContent("the first version, which was actually reviewed"),
    }),
  );
  await m.supervisor.transitionArtifact("dev", a.id, { to: "READY_FOR_REVIEW" });
  await m.supervisor.recordDecision("tech-lead", "approve", "implementation", a.id, "read it, looks right");
  return a.id;
}

test("re-versioning an approved artifact drops the approval it earned", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
  try {
    const id = await approvedPatch(m);
    assert.equal(
      hasApprovalForArtifact(m.kernel.state, id, "approve"),
      true,
      "precondition: v1 really was approved",
    );

    must(
      await m.supervisor.createArtifact({
        actorId: "dev",
        name: "signed-patch",
        type: "CodePatch",
        content: evidenceContent("a second version nobody has read"),
        asVersionOf: id,
      }),
    );

    // The load-bearing assertion. A signature on content that has been replaced
    // is not a signature on the replacement.
    assert.equal(
      hasApprovalForArtifact(m.kernel.state, id, "approve"),
      false,
      "an approval of v1 must not answer for v2 — ApprovalRecord carries no version, so keeping it means keeping a lie",
    );
    assert.equal(m.kernel.state.artifacts.get(id)?.version, 2, "and we really are looking at the new version");
  } finally {
    await m.cleanup();
  }
});

test("a negative verdict on v1 does not carry to v2 either — the prune is symmetric", async () => {
  // Dropping the NEGATIVE verdict on a re-version was already the behaviour
  // (the reducer filtered `kind === "block"`), and widening the prune to every
  // kind must not change that direction. Asserted through `reject`, which is the
  // kind the authority model actually grants — `block` resolves to
  // `implementation.block`, which `validateAuthorityTokens` refuses, so no seat
  // can ever hold it and the old filter could only ever have matched records
  // arriving by some other route.
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
  try {
    const a = must(
      await m.supervisor.createArtifact({
        actorId: "dev",
        name: "rejected-patch",
        type: "CodePatch",
        content: evidenceContent("v1 that gets rejected"),
      }),
    );
    await m.supervisor.transitionArtifact("dev", a.id, { to: "READY_FOR_REVIEW" });
    await m.supervisor.recordDecision("tech-lead", "reject", "implementation", a.id, "not like this");
    assert.equal(hasApprovalForArtifact(m.kernel.state, a.id, "reject"), true, "precondition: v1 is rejected");

    must(
      await m.supervisor.createArtifact({
        actorId: "dev",
        name: "rejected-patch",
        type: "CodePatch",
        content: evidenceContent("v2 answering the rejection"),
        asVersionOf: a.id,
      }),
    );
    assert.equal(
      hasApprovalForArtifact(m.kernel.state, a.id, "reject"),
      false,
      "a rejection of v1 does not condemn v2 — the whole point of publishing a new version is to answer it",
    );
  } finally {
    await m.cleanup();
  }
});

test("a derived transition reports whether a gate would have passed, not an unconditional yes", async () => {
  // `gateSatisfied` was the literal `true` at every auditTransition call site,
  // which is the one value that makes the field useless — and
  // `mesh_stuck_artifacts` reads `gateSatisfied === false` as its "blocked"
  // signal, so the walkback class was statistically invisible.
  const m = await makeMesh({
    agents: AGENTS,
    mayContact: COMM,
    transitions: { "patch.approve": ["tech-lead.approve"] },
    mode: "parked",
  });
  try {
    const id = await approvedPatch(m);
    const before = (await collectEvents(m)).filter((e) => e.type === "artifact.transition").length;

    must(
      await m.supervisor.createArtifact({
        actorId: "dev",
        name: "signed-patch",
        type: "CodePatch",
        content: evidenceContent("v2, unreviewed, walking the status backwards"),
        asVersionOf: id,
      }),
    );

    const transitions = (await collectEvents(m)).filter((e) => e.type === "artifact.transition");
    assert.ok(transitions.length > before, "the version bump leaves a transition behind");
    const last = transitions[transitions.length - 1]!.payload as Record<string, unknown>;
    assert.equal(last.derived, true, "this is the runtime's bookkeeping mirror, not a seat's decision");
    assert.equal(typeof last.gateSatisfied, "boolean", "the field must carry a verdict");

    // The claim is that the value is COMPUTED, not that it is false. An
    // unconditional `true` is what made the walkback class unfindable, so the
    // property worth pinning is that the log agrees with the policy engine asked
    // the same question — whatever the answer happens to be for this step.
    // (Here it is legitimately true: a version bump lands on DRAFT and the
    // owner is allowed to put its own artifact back in DRAFT.)
    const a = m.kernel.state.artifacts.get(id)!;
    const verdict = m.supervisor.deps.policy.evaluateTransition(a, a.status, a.owner, {
      config: m.config,
      projections: m.kernel.state,
    });
    assert.equal(
      last.gateSatisfied,
      verdict.decision === "ALLOW",
      "the recorded flag must be the policy engine's real verdict for this step, not a literal",
    );
  } finally {
    await m.cleanup();
  }
});
