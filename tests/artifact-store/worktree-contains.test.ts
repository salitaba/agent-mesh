import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GitWorkspace } from "../../packages/artifact-store/src/index";
import { gitSkip } from "../support/git";

/**
 * Is the commit that is the patch in the tree the tests ran in?
 *
 * The fourth cronlite run's QA was sent to verify a CodePatch and was handed its text. It read the
 * text in four pages, re-typed four files into its own worktree (which held only the scaffold
 * commit), ran the tests there and reported 43/43. The files happened to match the merged commit;
 * nothing recorded that they did, or that the tree was not the commit. `containsCommit` is the
 * one fact that separates "tested the commit" from "tested a copy of it", and `worktreeState.head`
 * says where the tree was.
 */

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function scratch(): { dir: string; done(): void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-wcontains-"));
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** dev commits a file on its own branch (not merged), qa has a worktree at the scaffold commit. */
async function patchOnDev(dir: string) {
  const ws = new GitWorkspace(dir);
  await ws.ensureRepo();
  const qa = await ws.ensureWorktree("qa");
  const dev = await ws.ensureWorktree("dev");
  fs.writeFileSync(path.join(dev, "src.js"), "module.exports = 1;\n", "utf8");
  const c = await ws.commitWorktree("dev", "dev: src.js");
  return { ws, qa, dev, commit: c.commit };
}

test("a worktree that never had the patch does not contain its commit, however faithfully the files were re-typed", { skip: gitSkip }, async () => {
  const { dir, done } = scratch();
  try {
    const { ws, qa, commit } = await patchOnDev(dir);
    assert.equal(await ws.containsCommit("qa", commit), false, "fixture: qa holds only the scaffold commit");
    // The fourth run's move: the same bytes, typed in.
    fs.writeFileSync(path.join(qa, "src.js"), "module.exports = 1;\n", "utf8");
    assert.equal(await ws.containsCommit("qa", commit), false, "identical files are not the commit");
    assert.equal(git(qa, "rev-parse", "--short=12", commit), commit.slice(0, 12), "the commit is in the repository all along");
  } finally {
    done();
  }
});

test("a worktree that has the commit checked out contains it, by either way of putting it there", { skip: gitSkip }, async () => {
  const { dir, done } = scratch();
  try {
    const { ws, qa, commit } = await patchOnDev(dir);
    git(qa, "merge", "--ff-only", commit);
    assert.equal(await ws.containsCommit("qa", commit), true, "merged in");
    assert.equal(await ws.containsCommit("qa", commit.slice(0, 12)), true, "a short sha names it too");

    git(qa, "checkout", "--detach", "HEAD~1");
    assert.equal(await ws.containsCommit("qa", commit), false, "moved off it, it is not there");
    git(qa, "checkout", "--detach", commit);
    assert.equal(await ws.containsCommit("qa", commit), true, "detached at it");
  } finally {
    done();
  }
});

test("a commit git cannot find, something git would read as an option, and a seat with no worktree all answer null", { skip: gitSkip }, async () => {
  const { dir, done } = scratch();
  try {
    const { ws } = await patchOnDev(dir);
    assert.equal(await ws.containsCommit("qa", "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"), null, "no such object is no answer, not a no");
    assert.equal(await ws.containsCommit("qa", "--help"), null);
    assert.equal(await ws.containsCommit("qa", "main; rm -rf"), null);
    assert.equal(await ws.containsCommit("nobody", "abcdef1"), null);
  } finally {
    done();
  }
});

test("worktreeState reports where the tree is", { skip: gitSkip }, async () => {
  const { dir, done } = scratch();
  try {
    const { ws, qa, commit } = await patchOnDev(dir);
    const before = await ws.worktreeState("qa");
    assert.equal(before?.head, git(qa, "rev-parse", "--short=12", "HEAD"));
    git(qa, "merge", "--ff-only", commit);
    const after = await ws.worktreeState("qa");
    assert.equal(after?.head, commit.slice(0, 12));
    assert.equal(after?.unmergedCommits.length, 1, "and what main lacks, as before");
  } finally {
    done();
  }
});
