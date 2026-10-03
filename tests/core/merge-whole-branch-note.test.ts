import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { FakeWorkspace, installWorkspace } from "../support/fake-workspace";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * What a merge says it did with the commits on the owner's branch.
 *
 * `mergeWorktree` reports a list of commits in one field for two opposite outcomes. A patch that recorded a commit
 * merges that commit and its ancestors, and the list is what stayed behind on the branch. A patch that recorded none
 * merges the whole branch, and the list is what the merge took. The reply said the first in both cases: "N commit(s) on
 * developer's branch were NOT part of this artifact: ...".
 *
 * In the fourteenth cronlite run the developer committed with its own git (setup, library, CLI, README) and published
 * two patches that recorded no commit. The tech lead merged the library and was told "merged as e1cdc36 — 4 commit(s) on
 * developer's branch were NOT part of this artifact: e1cdc36 Add comprehensive README; 30028bc Implement cronlite CLI;
 * c589751 ...; 099a46e ...". The commit it called not part of the artifact was the one it had just landed, and the CLI
 * was in the list, so it went on to try to merge the CLI three times: the work was already in the product.
 */

const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "test.execute"], interests: [] },
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review", "git.merge"], authority: ["implementation.approve"], interests: [] },
];
const COMM = { dev: ["lead"], lead: ["dev"] };
const CRITERIA = [{ id: "implementation-merged", description: "the patch landed", mandatory: true }];
const COMMITS = [
  "e1cdc36 Add comprehensive README with API documentation",
  "30028bc Implement cronlite CLI with next and validate commands",
  "c589751 Implement cronlite library with core parsing and scheduling functions",
  "099a46e Set up cronlite project structure and configuration",
];
const RECORDED = "c589751c589751c589751c589751c589751c589751";

const turnFor = (agentId: string) =>
  ({ turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`, agentId, reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] }) as never;

/** A patch walked to MERGEABLE over a double whose merge reports `leftBehind`, recording `commit` when given. */
async function mergeable(commit: string | undefined, leftBehind: string[]) {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", criteria: CRITERIA } as never);
  installWorkspace(m, new FakeWorkspace({ behaviour: { leftBehind } }));
  const created = await m.supervisor.createArtifact({
    actorId: "dev",
    name: "library",
    type: "CodePatch",
    content: "the library, at length",
    ...(commit ? { metadata: { commit } } : {}),
  });
  if (!("artifact" in created)) throw new Error(`create failed: ${JSON.stringify(created)}`);
  const id = created.artifact.id;
  await m.supervisor.transitionArtifact("dev", id, { to: "READY_FOR_REVIEW" });
  await m.supervisor.executeOp("dev", { op: "request_review", artifactId: id, reviewers: ["lead"] } as MeshOp, turnFor("dev"));
  await m.supervisor.executeOp("lead", { op: "approve", subject: "implementation", artifactId: id } as MeshOp, turnFor("lead"));
  await m.supervisor.transitionArtifact("lead", id, { to: "VERIFIED" });
  await m.supervisor.transitionArtifact("lead", id, { to: "MERGEABLE" });
  assert.equal(m.kernel.state.artifacts.get(id)?.status, "MERGEABLE", "fixture: the patch is staged at the gate");
  return { m, id };
}

test("a patch that records no commit: the merge says the whole branch went in, and lists what came with it", async () => {
  const { m, id } = await mergeable(undefined, COMMITS);
  try {
    const res = await m.supervisor.executeOp("lead", { op: "merge", artifactId: id } as MeshOp, turnFor("lead"));
    assert.equal(res.ok, true, res.reason);
    const reason = String(res.reason);
    assert.doesNotMatch(reason, /NOT part of this artifact/, "the commits it lists are the ones that landed");
    assert.match(reason, /dev's branch went in whole/);
    assert.match(reason, /records no commit/, "and why");
    assert.match(reason, /4 commit\(s\) came in with it/);
    assert.match(reason, /30028bc Implement cronlite CLI/, "names them, so the CLI is not mistaken for unmerged work");
    assert.equal(res.caveat, true, "a caveat, so the turn's record carries it");
  } finally {
    await m.cleanup();
  }
});

test("a patch that recorded a commit: the list is what stayed on the branch, and the reply still says so", async () => {
  const { m, id } = await mergeable(RECORDED, COMMITS.slice(0, 2));
  try {
    const res = await m.supervisor.executeOp("lead", { op: "merge", artifactId: id } as MeshOp, turnFor("lead"));
    assert.equal(res.ok, true, res.reason);
    const reason = String(res.reason);
    assert.match(reason, /2 commit\(s\) on dev's branch were NOT part of this artifact and stay there: e1cdc36/);
    assert.doesNotMatch(reason, /went in whole/);
  } finally {
    await m.cleanup();
  }
});

test("a long list is cut at five and says how many more", async () => {
  const many = Array.from({ length: 8 }, (_, i) => `a${i}b${i}c${i}d Commit number ${i}`);
  const { m, id } = await mergeable(undefined, many);
  try {
    const res = await m.supervisor.executeOp("lead", { op: "merge", artifactId: id } as MeshOp, turnFor("lead"));
    assert.equal(res.ok, true, res.reason);
    assert.match(String(res.reason), /8 commit\(s\) came in with it: .*Commit number 4; and 3 more/);
    assert.doesNotMatch(String(res.reason), /Commit number 5/);
  } finally {
    await m.cleanup();
  }
});

test("no extra commits, nothing to say: a plain merge keeps its short reply", async () => {
  const { m, id } = await mergeable(undefined, []);
  try {
    const res = await m.supervisor.executeOp("lead", { op: "merge", artifactId: id } as MeshOp, turnFor("lead"));
    assert.equal(res.ok, true, res.reason);
    assert.match(String(res.reason), /^merged as [0-9a-f]{12}$/);
  } finally {
    await m.cleanup();
  }
});
