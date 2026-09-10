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
