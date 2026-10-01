import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { gitSkip } from "../support/git";
import { makeMesh } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * The seventh cronlite run's deadlock, end to end on a real repository.
 *
 * After a kill -9 the developer's resumed session edited `src/index.js` in the PRODUCT checkout by
 * absolute path instead of its own worktree's, committed the same fixes in its worktree (15d054e), and
 * got the patch approved. Every `merge` then failed: "Your local changes to the following files would be
 * overwritten by merge". Six refusals, four declined asks, two escalation cards and nearly eight minutes
 * went to seats asking one another to clean a checkout none of them could touch, until the operator did.
 *
 * Now the merge sets the dirty file aside (saved under a ref), lands the reviewed commit on a clean
 * checkout, and tells the merger what it found.
 */

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "git.commit"], interests: [] },
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review", "git.merge"], authority: ["implementation.approve"], interests: [] },
];
const COMM = { dev: ["lead"], lead: ["dev"] };
// A second criterion nothing evidences keeps the goal ACTIVE past the first merge.
const OPEN_CRITERIA = [
  { id: "implementation-merged", description: "landed" },
  { id: "docs-written", description: "never evidenced here" },
];

const turnFor = (agentId: string) =>
  ({ turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`, agentId, reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] }) as never;

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

/** A reviewed, approved, MERGEABLE patch whose commit writes `body` to `file` in the developer's worktree. */
async function mergeablePatch(m: Mesh, name: string, file: string, body: string): Promise<string> {
  const created = await m.supervisor.createArtifact({ actorId: "dev", name, type: "CodePatch", content: `${name}, described at length for review` });
  if (!("artifact" in created)) throw new Error(`create failed: ${created.error}`);
  const id = created.artifact.id;
  assert.equal((await m.supervisor.executeOp("dev", { op: "acquire_lease", artifactId: id, files: [file] } as MeshOp, turnFor("dev"))).ok, true);
  const wt = await m.supervisor.agentWorkspace("dev");
  fs.mkdirSync(path.dirname(path.join(wt, file)), { recursive: true });
  fs.writeFileSync(path.join(wt, file), body, "utf8");
  const c = await m.supervisor.executeOp("dev", { op: "commit", artifactId: id, message: `feat: ${name}`, files: [file] } as MeshOp, turnFor("dev"));
  assert.equal(c.ok, true, `commit: ${c.reason ?? ""}`);
  await m.supervisor.transitionArtifact("dev", id, { to: "READY_FOR_REVIEW" });
  assert.equal((await m.supervisor.executeOp("lead", { op: "approve", subject: "implementation", artifactId: id } as MeshOp, turnFor("lead"))).ok, true);
  await m.supervisor.transitionArtifact("lead", id, { to: "VERIFIED" });
  await m.supervisor.transitionArtifact("lead", id, { to: "MERGEABLE" });
  assert.equal(m.kernel.state.artifacts.get(id)?.status, "MERGEABLE", "(fixture) the patch reached MERGEABLE");
  return id;
}

test("a file edited directly in the product checkout no longer stops the merge that brings the same file", { skip: gitSkip }, async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", criteria: OPEN_CRITERIA, git: true });
  try {
    // src/index.js is on the product branch, then the developer's next patch changes it.
    const first = await mergeablePatch(m, "library", "src/index.js", "export const version = 1;\n");
    assert.equal((await m.supervisor.executeOp("lead", { op: "merge", artifactId: first } as MeshOp, turnFor("lead"))).ok, true);
    const fix = await mergeablePatch(m, "fix", "src/index.js", "export const version = 2; // the reviewed fix\n");

    // The slip of the live run: the same file, edited in the product checkout.
    fs.writeFileSync(path.join(m.productPath, "src", "index.js"), "export const version = 'typed straight into main';\n");
    assert.match(git(m.productPath, "status", "--porcelain"), /^M src\/index\.js/, "(fixture) the product checkout is dirty");

    const res = await m.supervisor.executeOp("lead", { op: "merge", artifactId: fix } as MeshOp, turnFor("lead"));
    assert.equal(res.ok, true, `the merge that failed six times in the live run: ${res.reason ?? ""}`);
    assert.equal(res.caveat, true);
    assert.match(res.reason ?? "", /the product checkout held uncommitted changes to src\/index\.js: written there directly, so on no branch and seen by no reviewer\. They are saved as refs\/mesh\/product-set-aside\//);
    assert.equal(m.kernel.state.artifacts.get(fix)?.status, "MERGED");

    assert.equal(fs.readFileSync(path.join(m.productPath, "src", "index.js"), "utf8"), "export const version = 2; // the reviewed fix\n", "the reviewed commit is what is on the product branch");
    assert.equal(git(m.productPath, "status", "--porcelain", "--untracked-files=no"), "", "and the checkout is clean");
    const ref = git(m.productPath, "for-each-ref", "--format=%(refname)", "refs/mesh/product-set-aside").split("\n")[0]!;
    assert.equal(git(m.productPath, "show", `${ref}:src/index.js`), "export const version = 'typed straight into main';", "what was typed into main is saved, not lost");
  } finally {
    await m.cleanup();
  }
});

test("a clean product checkout merges with no note, as before", { skip: gitSkip }, async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", criteria: OPEN_CRITERIA, git: true });
  try {
    const id = await mergeablePatch(m, "library", "src/index.js", "export const version = 1;\n");
    const res = await m.supervisor.executeOp("lead", { op: "merge", artifactId: id } as MeshOp, turnFor("lead"));
    assert.equal(res.ok, true, res.reason);
    assert.doesNotMatch(res.reason ?? "", /uncommitted changes/);
    assert.equal(res.caveat, undefined);
    assert.equal(git(m.productPath, "for-each-ref", "refs/mesh/product-set-aside"), "");
  } finally {
    await m.cleanup();
  }
});
