import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GitWorkspace } from "../../packages/artifact-store/src/index";
import { gitSkip } from "../support/git";

/**
 * `checkpointWorktree` against a real repository and a real linked worktree.
 *
 * The checkpoint is taken when a turn is stopped mid-work, possibly while the
 * seat's own shell is still running git in that worktree, so the property under
 * test is as much what it leaves ALONE as what it captures: the branch, HEAD,
 * the real index (byte for byte) and every file on disk must be exactly as they
 * were, and only the named ref may move.
 */

// Optional locks off on the test's own reads too: a plain `git status` refreshes
// the index's stat cache, and the byte comparison below would then be measuring
// the test instead of the code.
const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();

async function workspace(): Promise<{ ws: GitWorkspace; wt: string; done(): void }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-checkpoint-"));
  const ws = new GitWorkspace(dir);
  await ws.ensureRepo();
  const wt = await ws.ensureWorktree("backend");
  fs.writeFileSync(path.join(wt, ".gitignore"), "dist/\n*.log\n", "utf8");
  fs.writeFileSync(path.join(wt, "app.ts"), "export const v = 1;\n", "utf8");
  git(wt, "add", "-A");
  git(wt, "commit", "-m", "base");
  return { ws, wt, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const sha = (file: string): string => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** Everything the checkpoint promises not to touch, in one comparable value. */
function snapshot(wt: string, files: string[]) {
  const indexFile = path.resolve(wt, git(wt, "rev-parse", "--git-path", "index"));
  return {
    head: git(wt, "rev-parse", "HEAD"),
    branch: git(wt, "rev-parse", "--abbrev-ref", "HEAD"),
    branchTip: git(wt, "rev-parse", "refs/heads/mesh/backend"),
    index: sha(indexFile),
    status: git(wt, "status", "--porcelain=v1", "-uall"),
    staged: git(wt, "diff", "--cached", "--name-only"),
    files: Object.fromEntries(files.map((f) => [f, fs.existsSync(path.join(wt, f)) ? sha(path.join(wt, f)) : "(absent)"])),
  };
}

test("a checkpoint captures modified and untracked work, skips ignored files, and moves nothing else", { skip: gitSkip }, async () => {
  const { ws, wt, done } = await workspace();
  try {
    // The shapes a stopped turn leaves behind: an edit, a staged new file, a
    // file in a new directory, a deletion, and build output that is ignored.
    fs.writeFileSync(path.join(wt, "app.ts"), "export const v = 2;\n", "utf8");
    fs.writeFileSync(path.join(wt, "staged.ts"), "staged\n", "utf8");
    git(wt, "add", "staged.ts");
    fs.mkdirSync(path.join(wt, "src", "core"), { recursive: true });
    fs.writeFileSync(path.join(wt, "src", "core", "new.ts"), "new\n", "utf8");
    fs.rmSync(path.join(wt, ".gitignore"));
    fs.writeFileSync(path.join(wt, ".gitignore"), "dist/\n*.log\n", "utf8"); // same content, rewritten: no change
    fs.mkdirSync(path.join(wt, "dist"), { recursive: true });
    fs.writeFileSync(path.join(wt, "dist", "bundle.js"), "built\n", "utf8");
    fs.writeFileSync(path.join(wt, "debug.log"), "noise\n", "utf8");
    const watched = ["app.ts", "staged.ts", "src/core/new.ts", "dist/bundle.js", "debug.log", ".gitignore"];

    const before = snapshot(wt, watched);
    const cp = await ws.checkpointWorktree("backend", "refs/mesh/checkpoints/backend/turn-1", "checkpoint: turn-1 stopped");
    const after = snapshot(wt, watched);

    assert.ok(cp, "dirty worktree: a checkpoint was taken");
    assert.deepEqual(after, before, "branch, HEAD, the real index and every file on disk are untouched");
    assert.equal(git(wt, "rev-parse", "refs/mesh/checkpoints/backend/turn-1"), cp.commit, "the ref resolves to the returned commit");
    assert.equal(git(wt, "rev-parse", `${cp.commit}^`), before.head, "parented on HEAD, so `git diff HEAD <ref>` is the stopped turn's work");
    assert.equal(git(wt, "log", "-1", "--format=%s", cp.commit), "checkpoint: turn-1 stopped");

    const tree = git(wt, "ls-tree", "-r", "--name-only", cp.commit).split("\n").sort();
    // README.md is `ensureRepo`'s initial commit, carried unchanged from HEAD.
    assert.deepEqual(tree, [".gitignore", "README.md", "app.ts", "src/core/new.ts", "staged.ts"], "tracked + untracked non-ignored, never dist/ or *.log");
    assert.equal(git(wt, "show", `${cp.commit}:app.ts`), "export const v = 2;", "the modified content, not HEAD's");
    assert.deepEqual([...cp.files].sort(), ["app.ts", "src/core/new.ts", "staged.ts"], "worktree-relative paths, untracked listed per file");
  } finally {
    done();
  }
});

test("a deletion is captured as a deletion", { skip: gitSkip }, async () => {
  const { ws, wt, done } = await workspace();
  try {
    fs.rmSync(path.join(wt, "app.ts"));
    const cp = await ws.checkpointWorktree("backend", "refs/mesh/checkpoints/backend/del", "checkpoint");
    assert.ok(cp);
    assert.deepEqual(cp.files, ["app.ts"]);
    assert.deepEqual(git(wt, "ls-tree", "-r", "--name-only", cp.commit).split("\n"), [".gitignore", "README.md"]);
    assert.equal(fs.existsSync(path.join(wt, "app.ts")), false, "and the file stays deleted on disk");
  } finally {
    done();
  }
});

test("a clean worktree has nothing to checkpoint, and no ref is written", { skip: gitSkip }, async () => {
  const { ws, wt, done } = await workspace();
  try {
    assert.equal(await ws.checkpointWorktree("backend", "refs/mesh/checkpoints/backend/clean", "checkpoint"), null);
    // Only ignored output: dirty to the eye, nothing git would keep.
    fs.mkdirSync(path.join(wt, "dist"), { recursive: true });
    fs.writeFileSync(path.join(wt, "dist", "bundle.js"), "built\n", "utf8");
    assert.equal(await ws.checkpointWorktree("backend", "refs/mesh/checkpoints/backend/clean", "checkpoint"), null);
    // An edit reverted by hand: status is clean again, content equals HEAD.
    fs.writeFileSync(path.join(wt, "app.ts"), "export const v = 9;\n", "utf8");
    fs.writeFileSync(path.join(wt, "app.ts"), "export const v = 1;\n", "utf8");
    assert.equal(await ws.checkpointWorktree("backend", "refs/mesh/checkpoints/backend/clean", "checkpoint"), null);
    assert.throws(() => git(wt, "rev-parse", "--verify", "-q", "refs/mesh/checkpoints/backend/clean"), "no ref for a checkpoint not taken");
  } finally {
    done();
  }
});

test("a ref that would move a branch or HEAD is refused, and a missing worktree is null", { skip: gitSkip }, async () => {
  const { ws, wt, done } = await workspace();
  try {
    fs.writeFileSync(path.join(wt, "app.ts"), "export const v = 3;\n", "utf8");
    const head = git(wt, "rev-parse", "HEAD");
    assert.equal(await ws.checkpointWorktree("backend", "refs/heads/mesh/backend", "checkpoint"), null);
    assert.equal(await ws.checkpointWorktree("backend", "HEAD", "checkpoint"), null);
    assert.equal(git(wt, "rev-parse", "HEAD"), head, "the branch did not move");
    assert.equal(await ws.checkpointWorktree("nobody", "refs/mesh/checkpoints/nobody/x", "checkpoint"), null);
  } finally {
    done();
  }
});

test("a worktree past the path cap is skipped rather than hashed", { skip: gitSkip }, async () => {
  const { ws, wt, done } = await workspace();
  try {
    // An unignored dependency directory: the case the cap exists for.
    const dir = path.join(wt, "node_modules", "pkg");
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 5001; i++) fs.writeFileSync(path.join(dir, `f${i}.js`), "", "utf8");
    assert.equal(await ws.checkpointWorktree("backend", "refs/mesh/checkpoints/backend/big", "checkpoint"), null);
  } finally {
    done();
  }
});

test("each checkpoint of a moving worktree is its own commit, and the latest wins the ref", { skip: gitSkip }, async () => {
  const { ws, wt, done } = await workspace();
  try {
    fs.writeFileSync(path.join(wt, "app.ts"), "export const v = 4;\n", "utf8");
    const first = await ws.checkpointWorktree("backend", "refs/mesh/checkpoints/backend/latest", "one");
    fs.writeFileSync(path.join(wt, "more.ts"), "more\n", "utf8");
    const second = await ws.checkpointWorktree("backend", "refs/mesh/checkpoints/backend/latest", "two");
    assert.ok(first && second);
    assert.notEqual(first.commit, second.commit);
    assert.equal(git(wt, "rev-parse", "refs/mesh/checkpoints/backend/latest"), second.commit);
    assert.equal(git(wt, "cat-file", "-t", first.commit), "commit", "the earlier snapshot is still an object in the repo");
  } finally {
    done();
  }
});
