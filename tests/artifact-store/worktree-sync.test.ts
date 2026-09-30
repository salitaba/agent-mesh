import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GitWorkspace } from "../../packages/artifact-store/src/index";
import { gitSkip } from "../support/git";

/**
 * A worktree is a separate checkout, and a merge does not move it.
 *
 * QA's worktree stayed at the commit it was created on while `main` moved twice (the
 * second cronlite run). Each time QA ran its probe in that worktree, found defects the
 * merged code no longer had, and issued a `quality.block` on them: about 202k tokens and
 * twelve minutes of a twenty-three minute reopen. `syncWorktree` brings a seat's worktree
 * up to the product branch when that can be done without touching anything the seat wrote,
 * and says plainly when it cannot.
 */

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function scratch(): { dir: string; done(): void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-wsync-"));
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** `dev` commits a file and lands it on the product branch; returns the ws with both worktrees made. */
async function landed(dir: string, file = "src.js", body = "module.exports = 1;\n") {
  const ws = new GitWorkspace(dir);
  await ws.ensureRepo();
  const qa = await ws.ensureWorktree("qa");
  const dev = await ws.ensureWorktree("dev");
  fs.writeFileSync(path.join(dev, file), body, "utf8");
  const c = await ws.commitWorktree("dev", `dev: ${file}`);
  await ws.mergeWorktree("art-1", "dev", `merge ${file}`, c.commit);
  return { ws, qa, dev };
}

test("a clean worktree that is behind is fast-forwarded, and is then current", { skip: gitSkip }, async () => {
  const { dir, done } = scratch();
  try {
    const { ws, qa } = await landed(dir);
    assert.equal(fs.existsSync(path.join(qa, "src.js")), false, "fixture: qa's worktree has not seen the merge");
    // However many commits the landing made (the work, and a merge commit when one was needed).
    const behindBy = Number(git(qa, "rev-list", "--count", "HEAD..main"));
    assert.ok(behindBy >= 1);

    const first = await ws.syncWorktree("qa");
    assert.equal(first?.outcome, "advanced");
    assert.equal(first?.behind, behindBy);
    assert.equal(first?.base, "main");
    assert.equal(first?.baseCommit, git(qa, "rev-parse", "--short=12", "main"));
    assert.equal(fs.readFileSync(path.join(qa, "src.js"), "utf8"), "module.exports = 1;\n", "what QA runs is what was merged");
    assert.equal(git(qa, "rev-parse", "HEAD"), git(ws.mainPath, "rev-parse", "HEAD"));

    const again = await ws.syncWorktree("qa");
    assert.equal(again?.outcome, "current");
    assert.equal(again?.behind, 0);
  } finally {
    done();
  }
});

test("files the seat wrote and never added do not stand in the way", { skip: gitSkip }, async () => {
  const { dir, done } = scratch();
  try {
    const { ws, qa } = await landed(dir);
    // QA's own report and probe script, untracked: the ordinary state of a verifier's worktree.
    fs.writeFileSync(path.join(qa, "qa-report.md"), "# report\n", "utf8");
    fs.writeFileSync(path.join(qa, "probe.mjs"), "console.log(1)\n", "utf8");
    const res = await ws.syncWorktree("qa");
    assert.equal(res?.outcome, "advanced");
    assert.equal(fs.readFileSync(path.join(qa, "qa-report.md"), "utf8"), "# report\n", "and they are still there");
  } finally {
    done();
  }
});

test("uncommitted changes to a tracked file: left exactly as they were, and said so", { skip: gitSkip }, async () => {
  const { dir, done } = scratch();
  try {
    const { ws, qa } = await landed(dir);
    // A file that exists on both sides, edited locally and not committed.
    fs.writeFileSync(path.join(qa, "README.md"), "# qa's notes in the tracked file\n", "utf8");
    const before = git(qa, "rev-parse", "HEAD");
    const behindBy = Number(git(qa, "rev-list", "--count", "HEAD..main"));
    const res = await ws.syncWorktree("qa");
    assert.equal(res?.outcome, "blocked");
    assert.match(res?.why ?? "", /uncommitted changes to tracked files/);
    assert.equal(res?.behind, behindBy, "how far behind it is still reported");
    assert.equal(git(qa, "rev-parse", "HEAD"), before, "nothing moved");
    assert.equal(fs.readFileSync(path.join(qa, "README.md"), "utf8"), "# qa's notes in the tracked file\n");
  } finally {
    done();
  }
});

test("a branch holding commits the product branch lacks is not advanced", { skip: gitSkip }, async () => {
  const { dir, done } = scratch();
  try {
    const { ws, qa } = await landed(dir);
    fs.writeFileSync(path.join(qa, "mine.js"), "// mine\n", "utf8");
    await ws.commitWorktree("qa", "qa: its own commit");
    const before = git(qa, "rev-parse", "HEAD");
    const res = await ws.syncWorktree("qa");
    assert.equal(res?.outcome, "blocked");
    assert.equal(res?.ahead, 1);
    assert.match(res?.why ?? "", /holds 1 commit that main lacks/);
    assert.equal(git(qa, "rev-parse", "HEAD"), before);
  } finally {
    done();
  }
});

test("an untracked file the incoming commit would overwrite is protected, and reported", { skip: gitSkip }, async () => {
  const { dir, done } = scratch();
  try {
    const ws = new GitWorkspace(dir);
    await ws.ensureRepo();
    const qa = await ws.ensureWorktree("qa");
    const dev = await ws.ensureWorktree("dev");
    fs.writeFileSync(path.join(dev, "report.md"), "from dev\n", "utf8");
    const c = await ws.commitWorktree("dev", "dev: report.md");
    await ws.mergeWorktree("art-2", "dev", "merge report", c.commit);
    fs.writeFileSync(path.join(qa, "report.md"), "qa wrote this first\n", "utf8");

    const res = await ws.syncWorktree("qa");
    assert.equal(res?.outcome, "blocked");
    assert.match(res?.why ?? "", /git refused the fast-forward/);
    assert.equal(fs.readFileSync(path.join(qa, "report.md"), "utf8"), "qa wrote this first\n", "the seat's file survives");
  } finally {
    done();
  }
});

test("a worktree on a branch other than its own is not touched", { skip: gitSkip }, async () => {
  const { dir, done } = scratch();
  try {
    const { ws, qa } = await landed(dir);
    git(qa, "checkout", "-q", "-b", "scratch-idea");
    const res = await ws.syncWorktree("qa");
    assert.equal(res?.outcome, "blocked");
    assert.match(res?.why ?? "", /it is on branch scratch-idea, not mesh\/qa/);
    assert.equal(git(qa, "rev-parse", "--abbrev-ref", "HEAD"), "scratch-idea");
  } finally {
    done();
  }
});

test("a seat with no worktree has nothing to sync", { skip: gitSkip }, async () => {
  const { dir, done } = scratch();
  try {
    const ws = new GitWorkspace(dir);
    await ws.ensureRepo();
    assert.equal(await ws.syncWorktree("nobody"), null);
  } finally {
    done();
  }
});
