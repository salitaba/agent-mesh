import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GitWorkspace } from "../../packages/artifact-store/src/index";
import { gitSkip } from "../support/git";

/**
 * The runtime's `.mesh/` directory is not product content.
 *
 * The Claude adapter writes each seat's ROLE.md and MESH_CONTEXT.md to
 * `<workspace>/.mesh/agents/<id>/`, and a seat's `git add -A` swept them into
 * its patch: the delivered cronlite tree shipped the developer's prompt while
 * the PM's and tech lead's sat untracked beside it (2026-09-30). The workspace
 * keeps them out with the repository's `info/exclude`, which covers the main
 * checkout and every linked worktree and is not itself product content.
 */

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function scratch(prefix: string): { dir: string; done(): void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mesh-rde-${prefix}-`));
  return { dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function writeSeatFiles(root: string, seat: string): void {
  const dir = path.join(root, ".mesh", "agents", seat);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "ROLE.md"), `# ${seat}\n`, "utf8");
  fs.writeFileSync(path.join(dir, "MESH_CONTEXT.md"), `Goal: g\nMesh: m\n`, "utf8");
}

test("runtime files in the main checkout and in a worktree never reach a commit", { skip: gitSkip }, async () => {
  const { dir, done } = scratch("commit");
  try {
    const ws = new GitWorkspace(dir);
    await ws.ensureRepo();
    const wt = await ws.ensureWorktree("dev");
    writeSeatFiles(wt, "dev");
    writeSeatFiles(ws.mainPath, "pm");
    fs.writeFileSync(path.join(wt, "lib.js"), "module.exports = 1;\n", "utf8");

    // A commit that names no files is `add -A`: the path that used to carry the prompt along.
    const res = await ws.commitWorktree("dev", "dev: lib");
    assert.deepEqual(git(wt, "show", "--name-only", "--format=", res.commit).split("\n"), ["lib.js"]);
    assert.doesNotMatch(res.diff, /\.mesh/);

    // Neither checkout reports the runtime's files as work in progress.
    assert.equal(git(wt, "status", "--porcelain", "-uall"), "");
    assert.equal(git(ws.mainPath, "status", "--porcelain", "-uall"), "");

    // Bash's own `git add -A` in a seat's worktree is covered too.
    writeSeatFiles(wt, "dev2");
    git(wt, "add", "-A");
    assert.equal(git(wt, "diff", "--cached", "--name-only"), "");
  } finally {
    done();
  }
});

test("the exclusion is written once, appended to an operator's own excludes, and survives re-adoption", { skip: gitSkip }, async () => {
  const { dir, done } = scratch("once");
  try {
    const main = path.join(dir, "main");
    fs.mkdirSync(main, { recursive: true });
    git(main, "init", "-b", "main");
    git(main, "config", "user.email", "op@example.test");
    git(main, "config", "user.name", "Operator");
    fs.writeFileSync(path.join(main, "README.md"), "# product\n", "utf8");
    git(main, "add", "-A");
    git(main, "commit", "-m", "product");
    // An operator's own pattern, with no trailing newline: ours must not glue onto it.
    const excludeFile = path.join(main, ".git", "info", "exclude");
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
    fs.writeFileSync(excludeFile, "*.log", "utf8");

    await new GitWorkspace(dir).ensureRepo();
    await new GitWorkspace(dir).ensureRepo();

    const lines = fs.readFileSync(excludeFile, "utf8").split("\n");
    assert.ok(lines.includes("*.log"), "the operator's pattern is kept on its own line");
    assert.equal(lines.filter((l) => l === ".mesh/").length, 1, "and ours is added exactly once");
    assert.equal(git(main, "log", "--oneline").split("\n").length, 1, "adopting the repo wrote no commit");
  } finally {
    done();
  }
});

test("a seat prompt a repository already tracks is not staged again by a mesh commit", { skip: gitSkip }, async () => {
  const { dir, done } = scratch("tracked");
  try {
    const main = path.join(dir, "main");
    fs.mkdirSync(main, { recursive: true });
    git(main, "init", "-b", "main");
    git(main, "config", "user.email", "op@example.test");
    git(main, "config", "user.name", "Operator");
    writeSeatFiles(main, "dev");
    fs.writeFileSync(path.join(main, "README.md"), "# product\n", "utf8");
    git(main, "add", "-A");
    git(main, "commit", "-m", "product, with a prompt committed by an older run");

    const ws = new GitWorkspace(dir);
    await ws.ensureRepo();
    const wt = await ws.ensureWorktree("dev");
    // The runtime rewrites the tracked prompt at the next seat start; the patch is something else.
    fs.writeFileSync(path.join(wt, ".mesh", "agents", "dev", "ROLE.md"), "# dev, rewritten\n", "utf8");
    fs.writeFileSync(path.join(wt, "lib.js"), "module.exports = 1;\n", "utf8");

    const res = await ws.commitWorktree("dev", "dev: lib");
    assert.deepEqual(git(wt, "show", "--name-only", "--format=", res.commit).split("\n"), ["lib.js"]);
  } finally {
    done();
  }
});
