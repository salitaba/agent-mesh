import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { gitFacts, ownsGitRepo } from "../../apps/mesh-server/src/index";

/**
 * The workspace git reads must not run on the event loop.
 *
 * They used to: five `spawnSync` calls, each with its own timeout, so a repo
 * whose index lock is held by a seat's own commit could park the loop for the
 * sum of them. The child's heartbeat rides that same loop, so the host's health
 * watchdog killed it mid-turn (measured 2026-09-27: 105s of silence, three
 * turns discarded).
 *
 * The proof here is ordering: a timer armed before the call must fire before
 * the call resolves, which cannot happen if the call blocks. The fake `git`
 * sleeps past the helper's own timeout, so this also pins the timeout path —
 * the one the incident actually took — as "resolves null", not "hangs".
 */

/**
 * A shell script that stands in for `git` on PATH, sleeping past the helper's
 * timeout before failing. Real git would answer in milliseconds, which is the
 * point: only the fake can distinguish "off the loop" from "fast".
 */
const HANGING_GIT = "#!/bin/sh\nsleep 5\nexit 1\n";

const fakeGitSkip = process.platform === "win32" ? "the fake git is a POSIX shell script" : false;

/**
 * Run `fn` with a `git` that hangs on PATH. PATH is process-global, so it is
 * restored in a `finally` whatever `fn` does.
 */
async function withFakeGit<T>(script: string, fn: () => Promise<T>): Promise<T> {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-fake-git-"));
  const exe = path.join(bin, "git");
  fs.writeFileSync(exe, script, "utf8");
  fs.chmodSync(exe, 0o755);
  const prev = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${prev ?? ""}`;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.PATH;
    else process.env.PATH = prev;
    fs.rmSync(bin, { recursive: true, force: true });
  }
}

test("workspace git reads: a hanging git does not block the event loop", { skip: fakeGitSkip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-git-loop-"));
  try {
    await withFakeGit(HANGING_GIT, async () => {
      // Armed BEFORE the call. If the git read blocks the loop, the child's
      // whole 5s sleep elapses before this timer gets a chance to run.
      const order: string[] = [];
      setTimeout(() => order.push("timer"), 100);
      const started = Date.now();
      const facts = await gitFacts(dir);
      const elapsed = Date.now() - started;
      order.push("git");

      assert.deepEqual(order, ["timer", "git"], "the loop must tick while git runs; a blocked loop cannot fire the timer first");
      // Guards the test itself: a `git` that returned fast would also put
      // "timer" first, so the fake has to have been the one that ran.
      assert.ok(elapsed >= 3000, `the fake git must have been the binary used (took ${elapsed}ms)`);
      // And the timeout path is the failure path it always was: no repo,
      // unknown cleanliness — never a phantom clean tree.
      assert.equal(facts.gitRepo, "false", "a git that never answers leaves the workspace unowned");
      assert.equal(facts.gitClean, "unknown", "an unreadable tree is unknown, not clean");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ownsGitRepo: a hanging git resolves false instead of stalling", { skip: fakeGitSkip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-owns-loop-"));
  try {
    await withFakeGit(HANGING_GIT, async () => {
      const order: string[] = [];
      setTimeout(() => order.push("timer"), 100);
      const owned = await ownsGitRepo(dir);
      order.push("git");
      assert.equal(owned, false, "fail closed: an unanswerable rev-parse is not ownership");
      assert.deepEqual(order, ["timer", "git"], "the loop must tick while rev-parse runs");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace git reads: the helpers hand back promises, not values", { skip: fakeGitSkip }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-git-promise-"));
  try {
    // The weaker property, asserted directly so a revert to a synchronous body
    // fails fast even where a fake git is unavailable.
    const pending = gitFacts(dir);
    assert.ok(pending instanceof Promise, "gitFacts must be awaitable");
    const owned = ownsGitRepo(dir);
    assert.ok(owned instanceof Promise, "ownsGitRepo must be awaitable");
    await pending;
    await owned;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
