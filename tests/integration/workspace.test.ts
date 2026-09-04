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
