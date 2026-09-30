import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { makeMesh } from "../helpers";
import { gitSkip } from "../support/git";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * Commit BEFORE review, against a real git worktree.
 *
 * `merge` lands the commit a patch records and refuses a patch that records none;
 * `mesh_commit` records it as a NEW version, and a new version starts over at DRAFT.
 * So the flow a developer's role described -- publish, ask for review, walk the
 * ladder -- reached `merge` with a fully approved MERGEABLE patch, was told to
 * commit, and on committing lost the approval: a second complete review of
 * identical work, and "then merge again" (the refusal's own promise) was false.
 * cronlite, run 2, 2026-09-30: the developer did exactly this, reported "MERGED" to
 * the PM, and nothing had landed.
 *
 * The version bump is right -- reviewers approved the published content, not whatever
 * the worktree held later -- so the fix is to say so at the moment it matters: when
 * the review is asked for (a caveat naming the uncommitted files), in the refusal
 * that used to promise "then merge again", and in the role prompt's flow.
 */

const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "git.commit", "test.execute"], interests: [] },
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review", "git.merge"], authority: ["implementation.approve"], interests: [] },
];
const COMM = { dev: ["lead"], lead: ["dev"] };
const CRITERIA = [
  { id: "implementation-merged", description: "landed" },
  { id: "docs-written", description: "never evidenced here, so no merge completes the mission" },
];

const turnFor = (agentId: string) =>
  ({ turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`, agentId, reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] }) as never;

type Mesh = Awaited<ReturnType<typeof makeMesh>>;
const op = (m: Mesh, actor: string, o: MeshOp) => m.supervisor.executeOp(actor, o, turnFor(actor));
const artifact = (m: Mesh, id: string) => m.kernel.state.artifacts.get(id)!;

async function publishedPatch(m: Mesh, name: string, relPath: string): Promise<string> {
  const wt = await m.supervisor.agentWorkspace("dev");
  fs.mkdirSync(path.dirname(path.join(wt, relPath)), { recursive: true });
  fs.writeFileSync(path.join(wt, relPath), `// ${relPath}\nexport const x = 1;\n`, "utf8");
  const created = await m.supervisor.createArtifact({ actorId: "dev", name, type: "CodePatch", content: `## File: ${relPath}\nexport const x = 1;\n` });
  if (!("artifact" in created)) throw new Error("create failed");
  return created.artifact.id;
}

test("asking for review of a patch whose files are not committed says so, and says what a late commit costs", { skip: gitSkip }, async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", criteria: CRITERIA, git: true });
  try {
    const id = await publishedPatch(m, "patch", "src/x.js");
    const res = await op(m, "dev", { op: "request_review", artifactId: id, reviewers: ["lead"] } as MeshOp);

    assert.equal(res.ok, true, "the review ask is real and goes out");
    assert.equal(res.caveat, true, "but it carries a caveat");
    assert.match(String(res.reason), /dev has 1 uncommitted file\(s\) in its worktree and 'patch' records no commit/);
    assert.match(String(res.reason), /`merge` will refuse/);
    assert.match(String(res.reason), /new version that is reviewed again/);
    assert.match(String(res.reason), /`mesh_commit` first, then ask for review/);
  } finally {
    await m.cleanup();
  }
});

test("commit first and the caveat is gone; a patch with nothing uncommitted behind it never gets one", { skip: gitSkip }, async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", criteria: CRITERIA, git: true });
  try {
    const id = await publishedPatch(m, "patch", "src/x.js");
    assert.equal((await op(m, "dev", { op: "acquire_lease", artifactId: id, files: ["src/x.js"] } as MeshOp)).ok, true);
    const committed = await op(m, "dev", { op: "commit", artifactId: id, message: "feat: x", files: ["src/x.js"] } as MeshOp);
    assert.equal(committed.ok, true, committed.reason);
    assert.equal(typeof artifact(m, id).metadata?.commit, "string", "the version records its commit");

    const review = await op(m, "dev", { op: "request_review", artifactId: id, reviewers: ["lead"] } as MeshOp);
    assert.equal(review.ok, true, review.reason);
    assert.equal(review.caveat, undefined, "the commit is recorded, so there is nothing to warn about");
    assert.equal(review.reason, undefined);

    // A second patch with no commit, but nothing uncommitted in the worktree either:
    // the owner has no work the ask could strand, so it is not warned.
    const bare = await m.supervisor.createArtifact({ actorId: "dev", name: "notes", type: "CodePatch", content: "## File: NOTES.md\nnotes\n" });
    if (!("artifact" in bare)) throw new Error("create failed");
    const bareReview = await op(m, "dev", { op: "request_review", artifactId: bare.artifact.id, reviewers: ["lead"] } as MeshOp);
    assert.equal(bareReview.ok, true, bareReview.reason);
    assert.equal(bareReview.caveat, undefined);
  } finally {
    await m.cleanup();
  }
});

test("the refusal to merge an uncommitted patch no longer promises that merging again will work", { skip: gitSkip }, async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", criteria: CRITERIA, git: true });
  try {
    const id = await publishedPatch(m, "patch", "src/x.js");
    await m.supervisor.transitionArtifact("dev", id, { to: "READY_FOR_REVIEW" });
    await op(m, "dev", { op: "request_review", artifactId: id, reviewers: ["lead"] } as MeshOp);
    await op(m, "lead", { op: "approve", subject: "implementation", artifactId: id } as MeshOp);
    await m.supervisor.transitionArtifact("dev", id, { to: "VERIFIED" });
    await m.supervisor.transitionArtifact("dev", id, { to: "MERGEABLE" });
    assert.equal(artifact(m, id).status, "MERGEABLE", "fixture: the whole ladder was walked without a commit");

    const refused = await op(m, "lead", { op: "merge", artifactId: id } as MeshOp);
    assert.equal(refused.ok, false);
    assert.match(String(refused.reason), /records no commit/);
    assert.match(String(refused.reason), /NEW version of the patch, which starts over at DRAFT and needs review again/);
    assert.match(String(refused.reason), /commit BEFORE asking for review next time/);
    assert.doesNotMatch(String(refused.reason), /then merge again/, "it used to promise exactly what cannot happen");

    // And the consequence the refusal now states is the real one.
    await op(m, "dev", { op: "acquire_lease", artifactId: id, files: ["src/x.js"] } as MeshOp);
    const committed = await op(m, "dev", { op: "commit", artifactId: id, message: "feat: x", files: ["src/x.js"] } as MeshOp);
    assert.equal(committed.ok, true, committed.reason);
    assert.equal(artifact(m, id).status, "DRAFT");
    assert.equal((await op(m, "lead", { op: "merge", artifactId: id } as MeshOp)).ok, false, "merge is refused until the new version is reviewed");
  } finally {
    await m.cleanup();
  }
});

test("the developer role puts the commit ahead of the review in its flow, and says why", () => {
  const role = fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "roles", "developer.md"), "utf8");
  const flow = role.split("\n").find((l) => l.startsWith("- Flow per task:")) ?? "";
  assert.ok(flow.indexOf("mesh_commit") > 0, "the flow names mesh_commit");
  assert.ok(flow.indexOf("mesh_commit") < flow.indexOf("PATCH_READY"), "and puts it before the ask for review");
  assert.match(role, /a commit made after approval voids the approval/);
});
