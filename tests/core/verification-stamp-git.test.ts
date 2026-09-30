import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { makeMesh, evidenceContent } from "../helpers";
import { gitSkip } from "../support/git";
import type { GitWorkspace } from "../../packages/artifact-store/src/index";
import type { Artifact, WorktreeStamp } from "../../packages/protocol/src/index";

/**
 * The stamp against a real repository: the fourth cronlite run's QA, both ways.
 *
 * Re-typing a patch's files into a worktree that never held the commit, and checking the commit
 * out, produce the same files and the same prose in the report. They are not the same test, and
 * the runtime is now the one that can tell: it asks git whether the worktree holds the commit of
 * the patch the turn read.
 */

const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "git.commit"], interests: [] },
  { id: "qa", role: "qa", capabilities: ["repository.read", "test.execute", "test.write"], interests: [] },
];
const COMM = { dev: ["qa"], qa: ["dev"] };
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const BODY = "export const answer = 42;\n";

async function fixture() {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", git: true } as never);
  const ws = m.supervisor.deps.workspace as GitWorkspace;
  const qa = await ws.ensureWorktree("qa");
  const dev = await ws.ensureWorktree("dev");
  fs.writeFileSync(path.join(dev, "lib.js"), BODY, "utf8");
  const committed = await ws.commitWorktree("dev", "dev: lib.js");
  const created = await m.supervisor.createArtifact({
    actorId: "dev",
    name: "the patch",
    type: "CodePatch",
    content: evidenceContent("the patch"),
    metadata: { commit: committed.commit },
  });
  if (!("artifact" in created)) throw new Error(`create failed: ${JSON.stringify(created)}`);
  return { m, qa, commit: committed.commit, patch: created.artifact };
}

async function report(m: Awaited<ReturnType<typeof fixture>>["m"], name: string, patch: Artifact): Promise<WorktreeStamp | undefined> {
  const created = await m.supervisor.createArtifact({
    actorId: "qa",
    name,
    type: "TestReport",
    content: evidenceContent(name),
    inputs: [{ artifactId: patch.id, version: patch.version }],
  });
  if (!("artifact" in created)) throw new Error(`create failed: ${JSON.stringify(created)}`);
  return created.artifact.metadata.worktree as WorktreeStamp | undefined;
}

test("a report written after re-typing the patch's files is stamped as not holding its commit", { skip: gitSkip }, async () => {
  const { m, qa, commit, patch } = await fixture();
  try {
    // What the fourth run's QA did: the same bytes, typed into a tree that never had the commit.
    fs.writeFileSync(path.join(qa, "lib.js"), BODY, "utf8");
    const stamp = await report(m, "qa report (typed in)", patch);
    assert.ok(stamp, "a stamp is recorded");
    assert.equal(stamp.head, git(qa, "rev-parse", "--short=12", "HEAD"));
    assert.equal(stamp.untracked, 1);
    assert.equal(stamp.dirty, 1);
    assert.deepEqual(stamp.tested, [{ artifact: "artifact://CodePatch/the%20patch/1", commit: commit.slice(0, 12), inHead: false }]);
  } finally {
    await m.cleanup();
  }
});

test("a report written after checking the commit out is stamped as holding it, in a clean tree", { skip: gitSkip }, async () => {
  const { m, qa, commit, patch } = await fixture();
  try {
    git(qa, "merge", "--ff-only", commit);
    const stamp = await report(m, "qa report (checked out)", patch);
    assert.ok(stamp);
    assert.equal(stamp.head, commit.slice(0, 12), "the tree is at the commit that is the patch");
    assert.equal(stamp.dirty, 0);
    assert.equal(stamp.untracked, 0);
    assert.equal(stamp.tested?.[0]?.inHead, true);
  } finally {
    await m.cleanup();
  }
});
