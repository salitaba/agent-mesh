import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GitWorkspace } from "../../packages/artifact-store/src/index";
import { gitSkip } from "../support/git";
import { makeMesh } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * `GitWorkspace` against a real repository, on the paths that are not the
 * happy one.
 *
 * Every other suite either runs git-less (`makeMesh` defaults to in-memory) or
 * swaps in `FakeWorkspace`, which models the port's CONTRACT — "a conflict
 * rejects", "nothing to commit resolves with HEAD" — without modelling what git
 * leaves on disk afterwards. These tests look at the disk: the product checkout
 * after a conflict, what a commit with nothing staged returns, and whether
 * `worktreeState` names the files a seat actually touched.
 */

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const gitOk = (cwd: string, ...args: string[]): boolean => {
  try {
    execFileSync("git", args, { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

async function workspace(prefix: string): Promise<{ ws: GitWorkspace; dir: string; done(): void }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `mesh-gwf-${prefix}-`));
  const ws = new GitWorkspace(dir);
  await ws.ensureRepo();
  return { ws, dir, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Two seats commit different bodies for the same new file: the second merge must conflict. */
async function conflictingPair(ws: GitWorkspace): Promise<{ first: string; second: string }> {
  const a = await ws.ensureWorktree("a");
  const b = await ws.ensureWorktree("b");
  fs.writeFileSync(path.join(a, "shared.txt"), "from a\n", "utf8");
  fs.writeFileSync(path.join(b, "shared.txt"), "from b\n", "utf8");
  const first = (await ws.commitWorktree("a", "a: shared", ["shared.txt"])).commit;
  const second = (await ws.commitWorktree("b", "b: shared", ["shared.txt"])).commit;
  await ws.mergeWorktree("art-a", "a", "land a", first);
  return { first, second };
}

// ---------------------------------------------------------------- (a) conflict

test("merge conflict: mergeWorktree rejects, and the product branch does not move", { skip: gitSkip }, async () => {
  const { ws, done } = await workspace("conflict");
  try {
    const { second } = await conflictingPair(ws);
    const headBefore = git(ws.mainPath, "rev-parse", "HEAD");
    await assert.rejects(ws.mergeWorktree("art-b", "b", "land b", second), /conflict|Merge|merge/i, "a conflicted merge is a rejection, not a success");
    assert.equal(git(ws.mainPath, "rev-parse", "HEAD"), headBefore, "no merge commit was made");
    assert.equal(gitOk(ws.mainPath, "merge-base", "--is-ancestor", second, "HEAD"), false, "the conflicting commit is not on the product branch");
  } finally {
    done();
  }
});

test(
  "merge conflict: the product checkout is left clean — no MERGE_HEAD, no conflict markers",
  { skip: gitSkip },
  async () => {
    const { ws, done } = await workspace("conflict-clean");
    try {
      const { second } = await conflictingPair(ws);
      await ws.mergeWorktree("art-b", "b", "land b", second).catch(() => undefined);
      assert.equal(gitOk(ws.mainPath, "rev-parse", "-q", "--verify", "MERGE_HEAD"), false, "no half-finished merge is left in the product repo");
      assert.equal(git(ws.mainPath, "status", "--porcelain"), "", "the product checkout has no unmerged or modified paths");
      const body = fs.readFileSync(path.join(ws.mainPath, "shared.txt"), "utf8");
      assert.doesNotMatch(body, /<<<<<<<|>>>>>>>/, "the product file holds the landed content, not conflict markers");
      assert.equal(body, "from a\n");
    } finally {
      done();
    }
  },
);

test(
  "merge conflict: a later, unrelated merge still lands (the product is not wedged)",
  { skip: gitSkip },
  async () => {
    const { ws, done } = await workspace("conflict-wedge");
    try {
      const { second } = await conflictingPair(ws);
      await ws.mergeWorktree("art-b", "b", "land b", second).catch(() => undefined);
      const c = await ws.ensureWorktree("c");
      fs.writeFileSync(path.join(c, "other.txt"), "from c\n", "utf8");
      const third = (await ws.commitWorktree("c", "c: other", ["other.txt"])).commit;
      const merged = await ws.mergeWorktree("art-c", "c", "land c", third);
      assert.equal(gitOk(ws.mainPath, "merge-base", "--is-ancestor", third, merged.commit), true, "c's commit is on the product branch");
      assert.equal(fs.readFileSync(path.join(ws.mainPath, "other.txt"), "utf8"), "from c\n");
    } finally {
      done();
    }
  },
);

// -------------------------------------------------------- (b) already merged

test("alreadyUpToDate: merging a commit that is already on the product branch reports so, and makes no commit", { skip: gitSkip }, async () => {
  const { ws, done } = await workspace("uptodate");
  try {
    const a = await ws.ensureWorktree("a");
    fs.writeFileSync(path.join(a, "one.txt"), "one\n", "utf8");
    const sha = (await ws.commitWorktree("a", "a: one", ["one.txt"])).commit;
    const first = await ws.mergeWorktree("art-1", "a", "land one", sha);
    assert.notEqual(first.alreadyUpToDate, true, "the first merge landed something");
    assert.equal(git(ws.mainPath, "rev-parse", "HEAD"), first.commit, "and reports the product HEAD it made");
    assert.deepEqual(git(ws.mainPath, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").slice(1), [git(ws.mainPath, "rev-parse", "HEAD^1"), sha], "--no-ff: a real merge commit whose second parent is the seat's commit");

    const again = await ws.mergeWorktree("art-1b", "a", "land one again", sha);
    assert.equal(again.alreadyUpToDate, true, "the second merge is reported as the no-op it is");
    assert.equal(again.commit, first.commit, "and names the existing HEAD rather than a new commit");
    assert.equal(git(ws.mainPath, "rev-parse", "HEAD"), first.commit, "the product branch did not move");
  } finally {
    done();
  }
});

test(
  "alreadyUpToDate: the unscoped (no recorded sha) arm also reports a merge that moved nothing",
  { skip: gitSkip },
  async () => {
    const { ws, done } = await workspace("uptodate-branch");
    try {
      const a = await ws.ensureWorktree("a");
      // The seat wrote a file but never committed: its branch is still main.
      fs.writeFileSync(path.join(a, "never-committed.txt"), "lost?\n", "utf8");
      const headBefore = git(ws.mainPath, "rev-parse", "HEAD");
      const res = await ws.mergeWorktree("art-x", "a", "land nothing", undefined);
      assert.equal(git(ws.mainPath, "rev-parse", "HEAD"), headBefore, "(fixture) nothing moved");
      assert.equal(res.alreadyUpToDate, true, "a merge that moved nothing must say so, or the caller records a landing");
    } finally {
      done();
    }
  },
);

// ------------------------------------------------------------- (c) commit

test("commit with nothing staged: returns the unchanged HEAD and an EMPTY diff (the contract FakeWorkspace 'nothing' models)", { skip: gitSkip }, async () => {
  const { ws, done } = await workspace("nothing");
  try {
    const wt = await ws.ensureWorktree("a");
    const before = git(wt, "rev-parse", "HEAD");
    const res = await ws.commitWorktree("a", "empty", undefined);
    assert.equal(res.commit, before, "no commit was made, and the sha says so by being the old HEAD");
    assert.equal(res.diff, "", "the diff is empty");
    assert.equal(before, git(ws.mainPath, "rev-parse", "HEAD"), "which, on a fresh branch, IS the product HEAD — a caller that stores it records main's own commit as the patch");
  } finally {
    done();
  }
});

test("commit of untracked-only files: `files` lands exactly the named paths; the rest stay untracked", { skip: gitSkip }, async () => {
  const { ws, done } = await workspace("untracked");
  try {
    const wt = await ws.ensureWorktree("a");
    fs.mkdirSync(path.join(wt, "src"), { recursive: true });
    fs.writeFileSync(path.join(wt, "src", "named.txt"), "named\n", "utf8");
    fs.writeFileSync(path.join(wt, "src", "stray.txt"), "stray\n", "utf8");
    const res = await ws.commitWorktree("a", "named only", ["src/named.txt"]);
    assert.deepEqual(git(wt, "show", "--name-only", "--format=", res.commit).split("\n"), ["src/named.txt"], "only the named file is in the commit");
    assert.match(res.diff, /src\/named\.txt/);
    assert.doesNotMatch(res.diff, /stray/);
    assert.equal(git(wt, "status", "--porcelain", "-uall"), "?? src/stray.txt", "the unnamed file is still untracked, not dropped");

    const all = await ws.commitWorktree("a", "everything", undefined);
    assert.deepEqual(git(wt, "show", "--name-only", "--format=", all.commit).split("\n"), ["src/stray.txt"], "no `files` means `add -A`: the stray file lands now");
    assert.match(all.diff, /src\/named\.txt[\s\S]*src\/stray\.txt|src\/stray\.txt[\s\S]*src\/named\.txt/, "and the diff is cumulative against main");
  } finally {
    done();
  }
});

test("commit naming a path that does not exist rejects (git add: pathspec did not match) rather than committing nothing", { skip: gitSkip }, async () => {
  const { ws, done } = await workspace("badpath");
  try {
    const wt = await ws.ensureWorktree("a");
    const before = git(wt, "rev-parse", "HEAD");
    await assert.rejects(ws.commitWorktree("a", "ghost", ["nope/ghost.txt"]), /pathspec|did not match/i);
    assert.equal(git(wt, "rev-parse", "HEAD"), before);
  } finally {
    done();
  }
});

// ------------------------------------------------------- (d) worktreeState

test("worktreeState: untracked files are counted and named one by one, including inside new directories", { skip: gitSkip }, async () => {
  const { ws, done } = await workspace("state-untracked");
  try {
    const wt = await ws.ensureWorktree("a");
    fs.mkdirSync(path.join(wt, "src", "core"), { recursive: true });
    fs.mkdirSync(path.join(wt, "test"), { recursive: true });
    fs.writeFileSync(path.join(wt, "src", "core", "a.js"), "a\n", "utf8");
    fs.writeFileSync(path.join(wt, "src", "core", "b.js"), "b\n", "utf8");
    fs.writeFileSync(path.join(wt, "test", "c.js"), "c\n", "utf8");
    const st = await ws.worktreeState("a");
    assert.ok(st);
    assert.equal(st!.untracked, 3);
    assert.deepEqual([...st!.dirty].sort(), ["src/core/a.js", "src/core/b.js", "test/c.js"]);
    assert.deepEqual(st!.unmergedCommits, []);
  } finally {
    done();
  }
});

test(
  "worktreeState: a MODIFIED tracked file is named correctly",
  { skip: gitSkip },
  async () => {
    const { ws, done } = await workspace("state-modified");
    try {
      const wt = await ws.ensureWorktree("a");
      fs.appendFileSync(path.join(wt, "README.md"), "edited by the seat\n", "utf8");
      const st = await ws.worktreeState("a");
      assert.ok(st);
      assert.equal(st!.untracked, 0, "a modified file is not untracked");
      assert.deepEqual(st!.dirty, ["README.md"], "the seat is told the real file name");
    } finally {
      done();
    }
  },
);

test("worktreeState: modified + untracked together are all reported, and committed-but-unmerged work is listed", { skip: gitSkip }, async () => {
  const { ws, done } = await workspace("state-mixed");
  try {
    const wt = await ws.ensureWorktree("a");
    fs.writeFileSync(path.join(wt, "landed.txt"), "x\n", "utf8");
    const sha = (await ws.commitWorktree("a", "feat: landed-to-branch", ["landed.txt"])).commit;
    // The modification is STAGED (`M  landed.txt`, no leading space): an
    // unstaged ` M` line sorts first and trips the trim bug pinned above, and
    // this test is about the counts, not about that bug twice.
    fs.writeFileSync(path.join(wt, "a.txt"), "new\n", "utf8");
    fs.appendFileSync(path.join(wt, "landed.txt"), "more\n", "utf8");
    git(wt, "add", "landed.txt");
    const st = await ws.worktreeState("a");
    assert.ok(st);
    assert.equal(st!.untracked, 1);
    assert.deepEqual([...st!.dirty].sort(), ["a.txt", "landed.txt"]);
    assert.equal(st!.unmergedCommits.length, 1, "the commit is on the seat's branch but not in the product");
    assert.match(st!.unmergedCommits[0], new RegExp(`^${sha.slice(0, 7)}`));

    await ws.mergeWorktree("art", "a", "land", sha);
    const after = await ws.worktreeState("a");
    assert.deepEqual(after!.unmergedCommits, [], "once merged, the commit is no longer reported as outside the product");
  } finally {
    done();
  }
});

test("worktreeState: a seat with no worktree has no state", { skip: gitSkip }, async () => {
  const { ws, done } = await workspace("state-none");
  try {
    assert.equal(await ws.worktreeState("never-created"), null);
  } finally {
    done();
  }
});

// ------------------------------------------ the supervisor over the same git

/**
 * The same failure modes one layer up, through `executeOp` on a
 * `makeMesh({ git: true })` mesh: what the op RESULT and the artifact's status
 * say when git did not do what was asked.
 */
const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "git.commit"], interests: [] },
  { id: "dev2", role: "developer", capabilities: ["repository.read", "repository.write", "git.commit"], interests: [] },
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review", "git.merge"], authority: ["implementation.approve"], interests: [] },
];
const COMM = { dev: ["lead"], dev2: ["lead"], lead: ["dev", "dev2"] };
// A second criterion nothing here evidences keeps the goal ACTIVE: with
// `implementation-merged` alone the first merge completes the mission, and
// every op after it is refused as "mission is COMPLETED" before git is reached.
const OPEN_CRITERIA = [
  { id: "implementation-merged", description: "landed" },
  { id: "docs-written", description: "never evidenced here" },
];

const turnFor = (agentId: string) =>
  ({ turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`, agentId, reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] }) as never;

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

async function patchFor(m: Mesh, owner: string, name: string, file: string, body: string): Promise<{ id: string; sha: string }> {
  const created = await m.supervisor.createArtifact({ actorId: owner, name, type: "CodePatch", content: `${name}, described at length for review` });
  if (!("artifact" in created)) throw new Error(`create failed: ${created.error}`);
  const id = created.artifact.id;
  const lease = await m.supervisor.executeOp(owner, { op: "acquire_lease", artifactId: id, files: [file] } as MeshOp, turnFor(owner));
  assert.equal(lease.ok, true, `lease: ${lease.reason ?? ""}`);
  const wt = await m.supervisor.agentWorkspace(owner);
  fs.mkdirSync(path.dirname(path.join(wt, file)), { recursive: true });
  fs.writeFileSync(path.join(wt, file), body, "utf8");
  const c = await m.supervisor.executeOp(owner, { op: "commit", artifactId: id, message: `feat: ${name}`, files: [file] } as MeshOp, turnFor(owner));
  assert.equal(c.ok, true, `commit: ${c.reason ?? ""}`);
  await m.supervisor.transitionArtifact(owner, id, { to: "READY_FOR_REVIEW" });
  const ap = await m.supervisor.executeOp("lead", { op: "approve", subject: "implementation", artifactId: id } as MeshOp, turnFor("lead"));
  assert.equal(ap.ok, true, `approve: ${ap.reason ?? ""}`);
  await m.supervisor.transitionArtifact("lead", id, { to: "VERIFIED" });
  await m.supervisor.transitionArtifact("lead", id, { to: "MERGEABLE" });
  assert.equal(m.kernel.state.artifacts.get(id)?.status, "MERGEABLE", "(fixture) the patch reached MERGEABLE");
  return { id, sha: String(c.reason) };
}

test("supervisor: a conflicted merge is an op failure, the patch stays MERGEABLE, and nothing on the log says MERGED", { skip: gitSkip }, async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", criteria: OPEN_CRITERIA, git: true });
  try {
    const a = await patchFor(m, "dev", "shared-a", "shared.txt", "from dev\n");
    const b = await patchFor(m, "dev2", "shared-b", "shared.txt", "from dev2\n");
    const first = await m.supervisor.executeOp("lead", { op: "merge", artifactId: a.id, comment: "land a" } as MeshOp, turnFor("lead"));
    assert.equal(first.ok, true, `first merge: ${first.reason ?? ""}`);

    const second = await m.supervisor.executeOp("lead", { op: "merge", artifactId: b.id, comment: "land b" } as MeshOp, turnFor("lead"));
    assert.equal(second.ok, false, "a conflicting merge is refused as an op result, not thrown and not accepted");
    assert.match(second.reason ?? "", /git merge .* failed/);
    assert.equal(m.kernel.state.artifacts.get(b.id)?.status, "MERGEABLE", "the conflicted patch stays MERGEABLE (retryable), never MERGED");

    const events = await m.store.read();
    const mergedIds = events.filter((e) => e.type === "artifact.transition" && (e.payload as { to?: string }).to === "MERGED").map((e) => (e.payload as { artifactId: string }).artifactId);
    assert.deepEqual(mergedIds, [a.id], "only the patch that landed was ever recorded MERGED");
    assert.ok(
      events.some((e) => e.type === "message.rejected" && (e.payload as { ruleId?: string; subject?: string }).ruleId === "merge.git-failed" && (e.payload as { subject?: string }).subject === b.id),
      "the refusal is on the log, naming the patch",
    );
    assert.equal(gitOk(m.productPath, "merge-base", "--is-ancestor", b.sha, "HEAD"), false, "and git agrees: b's commit is not on the product branch");
  } finally {
    await m.cleanup();
  }
});

test(
  "supervisor: a `commit` op that committed nothing is not reported as a commit",
  { skip: gitSkip },
  async () => {
    const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", git: true });
    try {
      const created = await m.supervisor.createArtifact({ actorId: "dev", name: "empty", type: "CodePatch", content: "a patch whose author forgot to write it" });
      if (!("artifact" in created)) throw new Error(created.error);
      const id = created.artifact.id;
      await m.supervisor.executeOp("dev", { op: "acquire_lease", artifactId: id, files: ["x.txt"] } as MeshOp, turnFor("dev"));
      await m.supervisor.agentWorkspace("dev");
      const mainHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: m.productPath, encoding: "utf8" }).trim();
      const res = await m.supervisor.executeOp("dev", { op: "commit", artifactId: id, message: "feat: nothing" } as MeshOp, turnFor("dev"));
      assert.equal(res.ok, false, `a commit that made no commit must not succeed (got ok with reason ${String(res.reason).slice(0, 12)})`);
      assert.notEqual(m.kernel.state.artifacts.get(id)?.metadata?.commit, mainHead, "and the patch must not record the product's own HEAD as its commit");
    } finally {
      await m.cleanup();
    }
  },
);

test(
  "supervisor: a `commit` op naming a file that does not exist is an op failure, not a thrown turn",
  { skip: gitSkip },
  async () => {
    const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", git: true });
    try {
      const created = await m.supervisor.createArtifact({ actorId: "dev", name: "ghost", type: "CodePatch", content: "a patch naming a file that is not there" });
      if (!("artifact" in created)) throw new Error(created.error);
      const id = created.artifact.id;
      await m.supervisor.executeOp("dev", { op: "acquire_lease", artifactId: id, files: ["ghost.txt"] } as MeshOp, turnFor("dev"));
      let res: Awaited<ReturnType<typeof m.supervisor.executeOp>> | undefined;
      let thrown: unknown;
      try {
        res = await m.supervisor.executeOp("dev", { op: "commit", artifactId: id, message: "feat: ghost", files: ["ghost.txt"] } as MeshOp, turnFor("dev"));
      } catch (err) {
        thrown = err;
      }
      assert.equal(thrown, undefined, `executeOp must answer, not throw: ${String((thrown as Error | undefined)?.message ?? "").split("\n")[0]}`);
      assert.equal(res?.ok, false);
      assert.match(res?.reason ?? "", /ghost\.txt/, "and the reason names the path the seat got wrong");
    } finally {
      await m.cleanup();
    }
  },
);
