import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GitWorkspace } from "../../packages/artifact-store/src/index";

/**
 * Who a worktree commit is attributed to (NOTES-live-run-20260925-2040.md §11).
 *
 * `ensureWorktree` ran `git config user.name "Mesh Agent <id>"` in each worktree.
 * Without `extensions.worktreeConfig` that writes the SHARED `.git/config`, so
 * the last worktree created named every seat: frontend's `b03f2b1` was authored
 * "Mesh Agent ui-designer". Seats commit through Bash in their own worktree as
 * well as through the mesh's commit path, so only a per-worktree identity covers
 * both. Real git, real repository.
 */

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function workspace(): Promise<{ ws: GitWorkspace; dir: string; done(): void }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-git-identity-"));
  const ws = new GitWorkspace(dir);
  await ws.ensureRepo();
  return { ws, dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** What a seat does from its own shell: a plain `git commit`, no mesh in the path. */
function seatCommits(cwd: string, file: string): string {
  fs.writeFileSync(path.join(cwd, file), `${file}\n`, "utf8");
  git(cwd, "add", file);
  git(cwd, "commit", "-m", `add ${file}`);
  return git(cwd, "log", "-1", "--format=%an <%ae>");
}

test("each worktree commits as its own seat, whichever worktree was created last", async () => {
  const { ws, dir, done } = await workspace();
  try {
    const frontend = await ws.ensureWorktree("frontend");
    const designer = await ws.ensureWorktree("ui-designer");
    assert.match(seatCommits(frontend, "driver-ui.ts"), /^Mesh Agent frontend </, "b03f2b1: frontend's commit authored as ui-designer");
    assert.match(seatCommits(designer, "tokens.css"), /^Mesh Agent ui-designer </);
    // The shared config keeps the product checkout's own identity.
    assert.equal(git(path.join(dir, "main"), "config", "user.name"), "Mesh Supervisor");
  } finally {
    done();
  }
});

test("a mesh-made commit is attributed to its seat too", async () => {
  const { ws, done } = await workspace();
  try {
    const frontend = await ws.ensureWorktree("frontend");
    await ws.ensureWorktree("ui-designer");
    fs.writeFileSync(path.join(frontend, "a.ts"), "a\n", "utf8");
    const { commit } = await ws.commitWorktree("frontend", "frontend: a");
    assert.match(git(frontend, "show", "-s", "--format=%an", commit), /^Mesh Agent frontend$/);
  } finally {
    done();
  }
});

test("a worktree created before the fix, and a shared config it polluted, are repaired on next use", async () => {
  const { ws, dir, done } = await workspace();
  try {
    const main = path.join(dir, "main");
    // The pre-fix layout: two worktrees, identity written to the shared config.
    for (const id of ["frontend", "ui-designer"]) {
      const target = path.join(dir, "worktrees", id);
      git(main, "worktree", "add", "-b", `mesh/${id}`, target, "main");
      git(target, "config", "user.name", `Mesh Agent ${id}`);
    }
    assert.equal(git(main, "config", "user.name"), "Mesh Agent ui-designer", "fixture: the measured shared config");

    const fresh = new GitWorkspace(dir); // a restarted server
    await fresh.ensureRepo();
    const frontend = await fresh.ensureWorktree("frontend");
    assert.match(seatCommits(frontend, "late.ts"), /^Mesh Agent frontend </);
    assert.equal(git(main, "config", "user.name"), "Mesh Supervisor", "the product checkout no longer merges as a seat");
  } finally {
    done();
  }
});

test("an operator's own identity in an adopted repo is left alone", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-git-identity-own-"));
  try {
    const main = path.join(dir, "main");
    fs.mkdirSync(main, { recursive: true });
    git(main, "init", "-b", "main");
    git(main, "config", "user.name", "Ali Operator");
    git(main, "config", "user.email", "ali@example.com");
    fs.writeFileSync(path.join(main, "README.md"), "x\n", "utf8");
    git(main, "add", "-A");
    git(main, "commit", "-m", "init");
    const ws = new GitWorkspace(dir);
    await ws.ensureRepo();
    const frontend = await ws.ensureWorktree("frontend");
    assert.match(seatCommits(frontend, "b.ts"), /^Mesh Agent frontend </);
    assert.equal(git(main, "config", "user.name"), "Ali Operator", "a seat's worktree must not rename the operator");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
