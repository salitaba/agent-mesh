import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { makeMesh } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * `makeMesh({ git, persist })` boots the mesh a real run boots.
 *
 * Every other fixture in this suite runs `inMemory`, which leaves
 * `deps.workspace` undefined — so a MERGED there is a projection status that no
 * commit ever backed, and every git arm of the supervisor is unreachable except
 * through a hand-installed double. These tests prove the two switches reach the
 * real objects: a commit a seat made is in the product repo's `git log` after
 * `merge`, and the events that recorded it are in a JSONL file on disk.
 */

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const gitSkip = !hasGit && "git unavailable";

const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "git.commit", "test.execute"], interests: [] },
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review", "git.merge"], authority: ["implementation.approve"], interests: [] },
];
const COMM = { dev: ["lead"], lead: ["dev"] };
const CRITERIA = [{ id: "implementation-merged", description: "the patch landed", mandatory: true }];

const turnFor = (agentId: string) =>
  ({
    turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`,
    agentId,
    reason: { kind: "manual" as const },
    sentOps: 0,
    publishedOps: 0,
    waitRequested: false,
    escalated: false,
    results: [],
  }) as never;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test("makeMesh({ git, persist }): a seat's commit reaches the product repo and the log reaches disk", { skip: gitSkip }, async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", criteria: CRITERIA, git: true, persist: true });
  try {
    assert.equal(m.useGit, true, "fixture: git requested, git resolved");
    assert.equal(m.inMemory, false, "fixture: git implies a file-backed boot");
    assert.ok(m.supervisor.deps.workspace, "a real workspace is on deps, not a double");

    const opOk = async (actor: string, op: MeshOp) => {
      const res = await m.supervisor.executeOp(actor, op, turnFor(actor));
      assert.equal(res.ok, true, `${actor} ${op.op}: ${res.reason ?? ""}`);
      return res;
    };

    const created = await m.supervisor.createArtifact({ actorId: "dev", name: "hello", type: "CodePatch", content: "hello patch, described at length" });
    if (!("artifact" in created)) throw new Error(`create failed: ${created.error}`);
    const id = created.artifact.id;
    await opOk("dev", { op: "acquire_lease", artifactId: id, files: ["src/hello.txt"] } as MeshOp);

    // The seat writes with its own tools into the worktree it was handed —
    // which is a real git worktree here, not a string a double returned.
    const worktree = await m.supervisor.agentWorkspace("dev");
    assert.notEqual(path.resolve(worktree), path.resolve(m.productPath), "a writing seat does not write into the product checkout");
    fs.mkdirSync(path.join(worktree, "src"), { recursive: true });
    fs.writeFileSync(path.join(worktree, "src", "hello.txt"), "hello from dev\n", "utf8");

    const committed = await opOk("dev", { op: "commit", artifactId: id, message: "feat: hello", files: ["src/hello.txt"] } as MeshOp);
    const sha = String(committed.reason);
    assert.match(sha, /^[0-9a-f]{40}$/, "the commit op reports the real sha");
    assert.equal(git(worktree, "rev-parse", "HEAD"), sha, "and it is the worktree's HEAD");

    await m.supervisor.transitionArtifact("dev", id, { to: "READY_FOR_REVIEW" });
    await opOk("dev", { op: "request_review", artifactId: id, reviewers: ["lead"] } as MeshOp);
    await opOk("lead", { op: "approve", subject: "implementation", artifactId: id } as MeshOp);
    await m.supervisor.transitionArtifact("lead", id, { to: "VERIFIED" });
    await m.supervisor.transitionArtifact("lead", id, { to: "MERGEABLE" });
    await opOk("lead", { op: "merge", artifactId: id, comment: "land hello" } as MeshOp);
    assert.equal(m.kernel.state.artifacts.get(id)?.status, "MERGED");

    // The claim a MERGED status makes, checked against git rather than the projection.
    const log = git(m.productPath, "log", "--format=%H %s");
    assert.ok(log.includes(sha), `the seat's commit ${sha.slice(0, 12)} is on the product branch:\n${log}`);
    assert.match(log, /land hello/, "and the merge commit carries the seat's comment");
    assert.equal(fs.readFileSync(path.join(m.productPath, "src", "hello.txt"), "utf8"), "hello from dev\n", "and the file is in the product checkout");

    // `persist`: the log is a file, and it holds what just happened. Appends
    // are queued and fsynced on a cadence, so ask for the durable answer.
    await m.store.flush?.();
    const logFile = path.join(m.config.stateDir, "logs", "events.jsonl");
    assert.ok(fs.existsSync(logFile), `events.jsonl exists at ${logFile}`);
    const onDisk = fs
      .readFileSync(logFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { type: string; payload: Record<string, unknown> });
    assert.ok(onDisk.some((e) => e.type === "patch.merged"), "the merge is on the log on disk");
    assert.ok(
      onDisk.some((e) => e.type === "artifact.transition" && e.payload.to === "MERGED"),
      "and so is the MERGED transition",
    );
    assert.equal(onDisk.length, (await m.store.read()).length, "the file IS the store, not a copy of part of it");
  } finally {
    await m.cleanup();
  }
});

test("makeMesh({ persist }) without git is file-backed and explicitly non-git", async () => {
  // An absent `workspace.git` defaults ON, so this pins that `persist` alone
  // does not quietly become a git fixture.
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", persist: true });
  try {
    assert.equal(m.inMemory, false);
    assert.equal(m.useGit, false);
    assert.equal(m.supervisor.deps.workspace, undefined);
    await m.kernel.emit("human.input", { action: "persist-probe" }, { actorId: "human" });
    await m.store.flush?.();
    const logFile = path.join(m.config.stateDir, "logs", "events.jsonl");
    assert.match(fs.readFileSync(logFile, "utf8"), /persist-probe/, "the emitted event is on disk");
  } finally {
    await m.cleanup();
  }
});

test("makeMesh defaults are unchanged: in-memory, no workspace", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
  try {
    assert.equal(m.inMemory, true);
    assert.equal(m.useGit, false);
    assert.equal(m.supervisor.deps.workspace, undefined, "the ~100 default fixtures keep their (git-less) world");
    assert.equal(fs.existsSync(path.join(m.config.stateDir, "logs", "events.jsonl")), false, "and write no log file");
  } finally {
    await m.cleanup();
  }
});
