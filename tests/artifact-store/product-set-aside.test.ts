import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GitWorkspace } from "../../packages/artifact-store/src/index";
import { gitSkip } from "../support/git";

/**
 * What is uncommitted in the product checkout is set aside, saved, before a merge.
 *
 * Work reaches the product checkout through `mergeWorktree` alone, so anything uncommitted there was
 * written directly (the seventh cronlite run's developer edited `src/index.js` by the checkout's absolute
 * path) and is on no branch. `git merge` then refuses to run ("Your local changes to the following files
 * would be overwritten"), for that merge and every one after it, and no seat can clear it: the merger
 * has no write tool and the owner sees a clean worktree of its own. The operator reset the checkout by
 * hand after nearly eight minutes and two escalation cards.
 *
 * Real git, and the incident replayed: the dirty file is the one the merge brings.
 */

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function workspace(): Promise<{ ws: GitWorkspace; done(): void }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-aside-"));
  const ws = new GitWorkspace(dir);
  await ws.ensureRepo();
  return { ws, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** A seat commits `src/index.js` in its worktree: the patch that is waiting to land. */
async function patch(ws: GitWorkspace, body = "export const fixed = true;\n"): Promise<string> {
  const wt = await ws.ensureWorktree("developer");
  fs.mkdirSync(path.join(wt, "src"), { recursive: true });
  fs.writeFileSync(path.join(wt, "src", "index.js"), body);
  return (await ws.commitWorktree("developer", "developer: fix", ["src/index.js"])).commit;
}

/** The product checkout with `src/index.js` already committed, so a later edit is a tracked modification. */
async function seeded(ws: GitWorkspace): Promise<void> {
  fs.mkdirSync(path.join(ws.mainPath, "src"), { recursive: true });
  fs.writeFileSync(path.join(ws.mainPath, "src", "index.js"), "export const fixed = false;\n");
  git(ws.mainPath, "add", "-A");
  git(ws.mainPath, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "seed");
}

test("the incident: a tracked file edited in the product checkout made the merge fail; set aside first, it lands", { skip: gitSkip }, async () => {
  const { ws, done } = await workspace();
  try {
    await seeded(ws);
    const wt = await ws.ensureWorktree("developer");
    // The developer's worktree branches from the seeded main, edits and commits there...
    fs.mkdirSync(path.join(wt, "src"), { recursive: true });
    fs.writeFileSync(path.join(wt, "src", "index.js"), "export const fixed = true;\n");
    const commit = (await ws.commitWorktree("developer", "developer: fix", ["src/index.js"])).commit;
    // ...and, separately, the same file is edited IN the product checkout, by absolute path.
    fs.writeFileSync(path.join(ws.mainPath, "src", "index.js"), "export const fixed = 'edited in main';\n");

    await assert.rejects(ws.mergeWorktree("art", "developer", "land", commit), /would be overwritten by merge/, "without the fix this is what every merge did");

    const aside = await ws.setAsideProductChanges();
    assert.ok(aside, "something was set aside");
    assert.deepEqual(aside.files, ["src/index.js"]);
    assert.match(aside.ref, /^refs\/mesh\/product-set-aside\/\d{4}-\d{2}-\d{2}T/);
    assert.equal(git(ws.mainPath, "status", "--porcelain", "--untracked-files=no"), "", "the product checkout is clean");

    const landed = await ws.mergeWorktree("art", "developer", "land", commit);
    assert.equal(landed.alreadyUpToDate, undefined);
    assert.equal(fs.readFileSync(path.join(ws.mainPath, "src", "index.js"), "utf8"), "export const fixed = true;\n", "the reviewed commit is what landed");
  } finally {
    done();
  }
});

test("what is set aside is saved: the ref holds the content that was discarded", { skip: gitSkip }, async () => {
  const { ws, done } = await workspace();
  try {
    await seeded(ws);
    fs.writeFileSync(path.join(ws.mainPath, "src", "index.js"), "export const typedDirectlyIntoMain = 1;\n");
    const aside = await ws.setAsideProductChanges();
    assert.ok(aside);
    assert.equal(git(ws.mainPath, "show", `${aside.ref}:src/index.js`), "export const typedDirectlyIntoMain = 1;");
    assert.equal(fs.readFileSync(path.join(ws.mainPath, "src", "index.js"), "utf8"), "export const fixed = false;\n", "and the working tree is the committed one again");
    assert.equal(git(ws.mainPath, "rev-parse", "--verify", `${aside.ref}^{commit}`).length, 40, "the ref resolves to a commit that survives garbage collection");
  } finally {
    done();
  }
});

test("staged changes and several files are all listed and saved", { skip: gitSkip }, async () => {
  const { ws, done } = await workspace();
  try {
    await seeded(ws);
    fs.writeFileSync(path.join(ws.mainPath, "other.js"), "1\n");
    git(ws.mainPath, "add", "other.js");
    git(ws.mainPath, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "second file");
    fs.writeFileSync(path.join(ws.mainPath, "src", "index.js"), "changed\n");
    fs.writeFileSync(path.join(ws.mainPath, "other.js"), "changed too\n");
    git(ws.mainPath, "add", "other.js"); // staged
    const aside = await ws.setAsideProductChanges();
    assert.ok(aside);
    assert.deepEqual([...aside.files].sort(), ["other.js", "src/index.js"]);
    assert.equal(git(ws.mainPath, "show", `${aside.ref}:other.js`), "changed too");
    assert.equal(git(ws.mainPath, "show", `${aside.ref}:src/index.js`), "changed");
    assert.equal(git(ws.mainPath, "status", "--porcelain", "--untracked-files=no"), "");
  } finally {
    done();
  }
});

test("a staged rename is listed under its new name and undone with the rest", { skip: gitSkip }, async () => {
  const { ws, done } = await workspace();
  try {
    await seeded(ws);
    git(ws.mainPath, "mv", "src/index.js", "src/main.js"); // porcelain: `R  src/index.js -> src/main.js`
    const aside = await ws.setAsideProductChanges();
    assert.deepEqual(aside?.files, ["src/main.js"], "the new name, not the `old -> new` line");
    assert.ok(fs.existsSync(path.join(ws.mainPath, "src", "index.js")), "the committed name is back");
    assert.ok(!fs.existsSync(path.join(ws.mainPath, "src", "main.js")), "and the renamed copy is gone");
    assert.equal(git(ws.mainPath, "status", "--porcelain", "--untracked-files=no"), "");
  } finally {
    done();
  }
});

test("a clean product checkout sets nothing aside and makes no ref", { skip: gitSkip }, async () => {
  const { ws, done } = await workspace();
  try {
    await seeded(ws);
    assert.equal(await ws.setAsideProductChanges(), null);
    assert.equal(git(ws.mainPath, "for-each-ref", "refs/mesh/product-set-aside"), "");
  } finally {
    done();
  }
});

test("untracked files are left alone: they have no copy anywhere, and merge only trips on them when a landing brings the same path", { skip: gitSkip }, async () => {
  const { ws, done } = await workspace();
  try {
    await seeded(ws);
    fs.writeFileSync(path.join(ws.mainPath, "scratch.txt"), "somebody's notes\n");
    fs.mkdirSync(path.join(ws.mainPath, ".mesh", "agents"), { recursive: true });
    fs.writeFileSync(path.join(ws.mainPath, ".mesh", "agents", "ROLE.md"), "the runtime's own file\n");
    assert.equal(await ws.setAsideProductChanges(), null, "nothing tracked is modified");
    assert.equal(fs.readFileSync(path.join(ws.mainPath, "scratch.txt"), "utf8"), "somebody's notes\n");
    assert.ok(fs.existsSync(path.join(ws.mainPath, ".mesh", "agents", "ROLE.md")), "the runtime's own directory is untouched");
  } finally {
    done();
  }
});

test("untracked files survive a set-aside of tracked changes beside them", { skip: gitSkip }, async () => {
  const { ws, done } = await workspace();
  try {
    await seeded(ws);
    fs.writeFileSync(path.join(ws.mainPath, "scratch.txt"), "keep me\n");
    fs.writeFileSync(path.join(ws.mainPath, "src", "index.js"), "dirty\n");
    const aside = await ws.setAsideProductChanges();
    assert.deepEqual(aside?.files, ["src/index.js"]);
    assert.equal(fs.readFileSync(path.join(ws.mainPath, "scratch.txt"), "utf8"), "keep me\n");
  } finally {
    done();
  }
});

test("two set-asides in the same second keep both: the ref names the moment, and a second dirty edit is saved too", { skip: gitSkip }, async () => {
  const { ws, done } = await workspace();
  try {
    await seeded(ws);
    fs.writeFileSync(path.join(ws.mainPath, "src", "index.js"), "first\n");
    const a = await ws.setAsideProductChanges();
    await new Promise((r) => setTimeout(r, 15));
    fs.writeFileSync(path.join(ws.mainPath, "src", "index.js"), "second\n");
    const b = await ws.setAsideProductChanges();
    assert.ok(a && b);
    assert.notEqual(a.ref, b.ref);
    assert.equal(git(ws.mainPath, "show", `${a.ref}:src/index.js`), "first");
    assert.equal(git(ws.mainPath, "show", `${b.ref}:src/index.js`), "second");
  } finally {
    done();
  }
});

test("the in-merge patch path is unaffected: a patch that lands on a clean checkout reports no set-aside", { skip: gitSkip }, async () => {
  const { ws, done } = await workspace();
  try {
    const commit = await patch(ws);
    assert.equal(await ws.setAsideProductChanges(), null);
    const landed = await ws.mergeWorktree("art", "developer", "land", commit);
    assert.ok(landed.commit);
    assert.equal(fs.readFileSync(path.join(ws.mainPath, "src", "index.js"), "utf8"), "export const fixed = true;\n");
  } finally {
    done();
  }
});
