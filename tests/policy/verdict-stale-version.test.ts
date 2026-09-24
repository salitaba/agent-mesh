import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * A verdict on a version that no longer exists is not a verdict on this artifact.
 *
 * Nothing in the pipeline checked this. `resolveArtifactRef` throws the version away
 * and returns the single mutable record; `recordDecision` then rebuilds the ref from
 * whatever version is CURRENT. So a reviewer who read v1 and ruled after v2 landed
 * had its verdict recorded against v2, silently, and `approvalPath` advanced v2 on
 * the strength of a review of v1.
 *
 * Measured: 2 of 13 verdicts in one live run landed on a superseded version. The
 * costly one was a rejection where 5 of its 7 findings were already fixed in the
 * version the reviewer had not seen — the author diffed the two by hand, said so in
 * prose, and republished. Nothing in the mesh noticed either the staleness or the
 * wasted review.
 *
 * Refused rather than caveated, because the reviewer demonstrably never read what it
 * was about to settle.
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

/** A CodePatch at v2, under review — the shape a second reviewer arrives into. */
async function patchAtV2() {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" } as never);
  const created = await m.supervisor.createArtifact({ actorId: "dev", name: "login-patch", type: "CodePatch", content: "the first cut, at length" });
  if (!("artifact" in created)) throw new Error("create failed");
  const id = created.artifact.id;
  // `asVersionOf` is what makes it a NEW VERSION rather than a second artifact —
  // a bare repeat of the same name is refused outright.
  const v2 = await m.supervisor.createArtifact({ actorId: "dev", name: "login-patch", type: "CodePatch", content: "the second cut, at length", asVersionOf: id });
  if (!("artifact" in v2)) throw new Error("versioning failed");
  await m.supervisor.transitionArtifact("dev", id, { to: "READY_FOR_REVIEW" });
  await m.supervisor.executeOp("dev", { op: "request_review", artifactId: id, reviewers: ["lead"] } as MeshOp, turnFor("dev"));
  return { m, id, version: m.kernel.state.artifacts.get(id)?.version };
}

test("a verdict citing a superseded version is refused, and records nothing", async () => {
  const { m, id, version } = await patchAtV2();
  try {
    assert.equal(version, 2, "the fixture really did supersede v1");

    const res = await m.supervisor.executeOp(
      "lead",
      { op: "approve", subject: "implementation", artifactUri: "artifact://CodePatch/login-patch/1", comment: "read v1, looks fine" } as MeshOp,
      turnFor("lead"),
    );

    assert.equal(res.ok, false, "a verdict on v1 must not settle v2");
    assert.match(String(res.reason), /cited v1 but login-patch is now v2/);
    assert.equal(m.kernel.state.artifacts.get(id)?.status, "UNDER_REVIEW", "and the artifact did not move");

    const events = await m.store.read();
    assert.ok(
      !events.some((e) => e.type === "review.approved"),
      "no verdict was recorded either — the signature would otherwise satisfy a gate on a review that never happened",
    );
    const denial = events.find((e) => e.type === "message.rejected" && (e.payload as { ruleId?: string }).ruleId === "verdict.stale-version");
    assert.ok(denial, "the refusal is on the record with its remedy");
    assert.match(String((denial.payload as { reason?: string }).reason), /may already be addressed/);
  } finally {
    await m.cleanup();
  }
});

test("a verdict citing the current version is recorded as before", async () => {
  const { m, id } = await patchAtV2();
  try {
    const res = await m.supervisor.executeOp(
      "lead",
      { op: "approve", subject: "implementation", artifactUri: "artifact://CodePatch/login-patch/2" } as MeshOp,
      turnFor("lead"),
    );
    assert.equal(res.ok, true, res.reason ?? "");
    assert.equal(m.kernel.state.artifacts.get(id)?.status, "APPROVED");
  } finally {
    await m.cleanup();
  }
});

test("a verdict citing no version at all is not second-guessed", async () => {
  // The check is about a reviewer contradicting itself, not about forcing every
  // caller to pin a version. `POST /approvals` and the criterion path both pass no
  // URI, and neither should start failing.
  const { m, id } = await patchAtV2();
  try {
    const res = await m.supervisor.executeOp(
      "lead",
      { op: "approve", subject: "implementation", artifactUri: "artifact://CodePatch/login-patch" } as MeshOp,
      turnFor("lead"),
    );
    assert.equal(res.ok, true, res.reason ?? "");
    assert.equal(m.kernel.state.artifacts.get(id)?.status, "APPROVED");
  } finally {
    await m.cleanup();
  }
});

test("a fuzzily-resolved URI is not version-checked, so a near-miss name is not falsely refused", async () => {
  // `resolveArtifactRef` falls through to `findArtifactByUri`, which matches on
  // display name and slug and prefers the newest version. A model-invented URI can
  // therefore resolve to an artifact with a different name — and version-checking
  // THAT would refuse a verdict the seat never miscited. So the check applies only
  // when the cited kind and name are the ones that actually resolved.
  const { m, id } = await patchAtV2();
  try {
    const res = await m.supervisor.executeOp(
      "lead",
      { op: "approve", subject: "implementation", artifactId: id, artifactUri: "artifact://CodePatch/Login Patch/1" } as MeshOp,
      turnFor("lead"),
    );
    assert.equal(res.ok, true, `a name that only fuzzily matches must not trip the version guard: ${res.reason ?? ""}`);
  } finally {
    await m.cleanup();
  }
});
