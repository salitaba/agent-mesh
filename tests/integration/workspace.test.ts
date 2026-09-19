import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GitWorkspace } from "../../packages/artifact-store/src/index";

const hasGit = (() => {
  try {
    require("child_process").execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("git workspace: worktrees isolate writers and merges land on main", { skip: !hasGit && "git unavailable" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-git-"));
  const ws = new GitWorkspace(dir);
  await ws.ensureRepo();
  assert.ok(fs.existsSync(path.join(ws.mainPath, ".git")), "repo initialized");

  const wt1 = await ws.ensureWorktree("developer");
  const wt2 = await ws.ensureWorktree("qa");
  assert.notEqual(wt1, wt2, "each writing agent gets its own worktree");
  assert.ok(wt1.includes("developer") && fs.existsSync(wt1));

  fs.writeFileSync(path.join(wt1, "Payment.java"), "class Payment { idempotency() {} }\n", "utf8");
  const commit = await ws.commitWorktree("developer", "feat: idempotent payment", ["Payment.java"]);
  assert.match(commit.commit, /^[0-9a-f]{40}$/, "commit sha");
  assert.ok(commit.diff.includes("Payment.java"), "patch captures the change");
  assert.ok(commit.diffDigest.startsWith("sha256:"));

  const merged = await ws.mergeWorktree("art-x", "developer", "merge payment pipeline");
  assert.match(merged.commit, /^[0-9a-f]{40}$/);
  assert.ok(fs.existsSync(path.join(ws.mainPath, "Payment.java")), "merged file visible on main");

  await ws.removeWorktree("qa");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("git workspace: second worktree edit does not leak into the first", { skip: !hasGit && "git unavailable" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-git2-"));
  const ws = new GitWorkspace(dir);
  await ws.ensureRepo();
  const a = await ws.ensureWorktree("a");
  const b = await ws.ensureWorktree("b");
  fs.writeFileSync(path.join(a, "A.txt"), "only-a", "utf8");
  await ws.commitWorktree("a", "a work", ["A.txt"]);
  assert.ok(!fs.existsSync(path.join(b, "A.txt")), "worktrees are isolated until merge");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("git workspace: removeAllWorktrees drops worktrees and mesh branches", { skip: !hasGit && "git unavailable" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-git-reset-"));
  const ws = new GitWorkspace(dir);
  await ws.ensureRepo();
  await ws.ensureWorktree("a");
  await ws.ensureWorktree("b");

  const removed = await ws.removeAllWorktrees();

  assert.deepEqual([...removed].sort(), ["a", "b"]);
  assert.ok(!fs.existsSync(ws.worktreePath("a")), "worktree a must be gone");
  assert.ok(!fs.existsSync(ws.worktreePath("b")), "worktree b must be gone");
  const branches = require("child_process")
    .execFileSync("git", ["branch", "--list", "mesh/*"], { cwd: ws.mainPath })
    .toString()
    .trim();
  assert.equal(branches, "", "old mission branches must be gone");
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * The reset path copies the worktrees aside and then DELETES them, branches
 * included. `mesh/*` refs that were not packed first survive only as dangling
 * objects, which `git gc` is free to collect — so the bundle is the whole
 * difference between "archived" and "gone", and the two ways it can be wrong
 * (an empty bundle, a bundle that needs the repo it was cut from) are what
 * these assert.
 */
test("git workspace: the branch bundle restores what removeAllWorktrees deletes", { skip: !hasGit && "git unavailable" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-git-bundle-"));
  const sh = (args: string[], cwd: string): string =>
    require("child_process").execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  const has = (sha: string, cwd: string): boolean => {
    try {
      sh(["cat-file", "-e", `${sha}^{commit}`], cwd);
      return true;
    } catch {
      return false;
    }
  };
  try {
    const ws = new GitWorkspace(dir);
    await ws.ensureRepo();
    await ws.ensureWorktree("a");
    fs.writeFileSync(path.join(ws.worktreePath("a"), "W.txt"), "work in progress", "utf8");
    const commit = await ws.commitWorktree("a", "a work", ["W.txt"]);

    assert.deepEqual(await ws.listWorktreeBranches(), ["mesh/a"], "one branch per worktree");
    const bundle = await ws.bundleWorktreeBranches(path.join(dir, "out", "mesh-branches.bundle"));
    assert.ok(bundle, "a bundle must be written when there are branches to pack");
    assert.deepEqual(bundle.refs, ["mesh/a"]);

    await ws.removeAllWorktrees();
    assert.deepEqual(await ws.listWorktreeBranches(), [], "the branches the bundle names are gone");
    // Deleting the branch does not delete the objects on its own — they linger
    // as garbage until a gc collects them, which is precisely the hazard: the
    // window is invisible and the loss arrives later. Reproduce the collection
    // so the test asserts the loss rather than the state that precedes it.
    sh(["gc", "--prune=now", "--quiet"], ws.mainPath);
    assert.equal(has(commit.commit, ws.mainPath), false, "the branch was all that held these commits");

    // Restored into a repository that has never seen either repo — that is the
    // point of packing self-contained rather than subtracting main.
    const fresh = path.join(dir, "fresh");
    fs.mkdirSync(fresh, { recursive: true });
    sh(["init", "-q", "-b", "main"], fresh);
    sh(["fetch", bundle.path, "refs/heads/*:refs/heads/restored/*"], fresh);
    assert.equal(has(commit.commit, fresh), true, "the bundled sha must come back, in full");
    assert.equal(sh(["show", "-s", "--format=%s", "restored/mesh/a"], fresh), "a work");
    assert.deepEqual(sh(["branch", "--list", "restored/*", "--format=%(refname:short)"], fresh).split("\n"), ["restored/mesh/a"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* `git bundle create` refuses an empty bundle, so the guard has to be a return
 * value and not the command's error: reset() has to tell "nothing to archive"
 * apart from "the archive failed" before it deletes anything. */
test("git workspace: no mesh branches means no bundle, not a failed one", { skip: !hasGit && "git unavailable" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-git-nobundle-"));
  try {
    const ws = new GitWorkspace(dir);
    await ws.ensureRepo();
    assert.deepEqual(await ws.listWorktreeBranches(), []);
    const dest = path.join(dir, "mesh-branches.bundle");
    assert.equal(await ws.bundleWorktreeBranches(dest), null);
    assert.ok(!fs.existsSync(dest), "a failed bundle must not leave a file behind for restore to find");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * `Supervisor.agentWorkspace` hands every seat without `repository.write` the
 * `mainPath` of this port rather than the workspace root. The branch itself is
 * pinned against a stub in `tests/core/supervisor-leftovers.test.ts`; what a
 * stub cannot show is the difference between the two paths, which is the whole
 * reason the branch exists. Against the real workspace: `main` is a working
 * tree that git answers for, and the root is in no repository at all — so a
 * seat pointed at the root writes files no commit can ever cite.
 */
test("git workspace: main is a working tree and the root is not", { skip: !hasGit && "git unavailable" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-git-readonly-seat-"));
  try {
    const ws = new GitWorkspace(dir);
    await ws.ensureRepo();
    assert.notEqual(ws.mainPath, dir, "the read-only seats' cwd must not be the workspace root");

    const sh = (args: string[], cwd: string): string =>
      require("child_process").execFileSync("git", args, { cwd }).toString().trim();
    assert.equal(fs.realpathSync(sh(["rev-parse", "--show-toplevel"], ws.mainPath)), fs.realpathSync(ws.mainPath));

    // What a seat reads and writes there is the product, tracked: `git status`
    // sees the file, so a committing seat can pick it up.
    fs.writeFileSync(path.join(ws.mainPath, "NOTES.md"), "read by qa, tech-lead, architect\n", "utf8");
    assert.match(sh(["status", "--porcelain"], ws.mainPath), /NOTES\.md/, "main's contents are inside the repo");

    // The root is the old destination. Nothing claims it, so nothing here is
    // reviewable, mergeable or citable — it is lost work that looks like work.
    // Asked as "is the root its own toplevel" rather than "does rev-parse
    // fail": if the temp dir itself sits inside some repository the command
    // succeeds and names that ancestor, which is not ownership.
    let rootToplevel: string | null = null;
    try {
      // stderr swallowed: the expected outcome here is git's "not a git
      // repository" fatal, and a passing run must not print one.
      rootToplevel = fs.realpathSync(
        require("child_process")
          .execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, stdio: ["ignore", "pipe", "ignore"] })
          .toString()
          .trim(),
      );
    } catch {
      rootToplevel = null;
    }
    assert.notEqual(rootToplevel, fs.realpathSync(dir), "the workspace root must not be a repository of its own");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("git workspace: ensureRepo refuses an ancestor repo instead of adopting it", { skip: !hasGit && "git unavailable" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-git-nested-"));
  const sh = (args: string[], cwd = dir): string =>
    require("child_process").execFileSync("git", args, { cwd }).toString().trim();
  // Brownfield layout: the product repo sits at the workspace root, so
  // `main/` is nested inside it. Adoption here made main an empty phantom
  // while merges landed at the root — the reset bug.
  sh(["init", "-b", "main"]);
  sh(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "seed"]);

  const ws = new GitWorkspace(dir);
  await ws.ensureRepo();

  const toplevel = sh(["rev-parse", "--show-toplevel"], ws.mainPath);
  assert.equal(fs.realpathSync(toplevel), fs.realpathSync(ws.mainPath), "main must be its own repo");
  assert.ok(fs.existsSync(path.join(ws.mainPath, "README.md")), "main got a fresh initial commit");
  fs.rmSync(dir, { recursive: true, force: true });
});


test("git workspace: removeMain wipes the checkout and ensureRepo re-initializes", { skip: !hasGit && "git unavailable" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-git-main-reset-"));
  const ws = new GitWorkspace(dir);
  await ws.ensureRepo();
  fs.writeFileSync(path.join(ws.mainPath, "PRODUCT.txt"), "shipped by the old mission", "utf8");

  ws.removeMain();
  assert.ok(!fs.existsSync(ws.mainPath), "main checkout must be gone immediately");

  await ws.ensureRepo();
  assert.ok(fs.existsSync(path.join(ws.mainPath, "README.md")), "fresh repo has the initial commit");
  assert.ok(!fs.existsSync(path.join(ws.mainPath, "PRODUCT.txt")), "old product files must not survive");
  const status = require("child_process")
    .execFileSync("git", ["status", "--porcelain"], { cwd: ws.mainPath })
    .toString()
    .trim();
  assert.equal(status, "", "fresh checkout is clean");
  fs.rmSync(dir, { recursive: true, force: true });
});
