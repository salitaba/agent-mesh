import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { makeMesh, collectEvents } from "../helpers";
import { installWorkspace } from "../support/fake-workspace";
import { GitWorkspace } from "../../packages/artifact-store/src/index";
import { commitRefError, isCommitSha } from "../../packages/core/src/commit-ref";
import { newArtifactId, type Artifact, type MeshOp } from "../../packages/protocol/src/index";

/**
 * A CodePatch's `metadata.commit` must be something git can resolve.
 *
 * Seen live: a seat published `metadata.commit` as the prose below. Nothing
 * checked it until the merge ran `git cat-file -e <value>^{commit}`, and the
 * error quoted `commit.slice(0, 12)` — `b83c898 (on ` — which three seats read as
 * a template with an empty branch name and escalated as a runtime defect. The
 * merge was blocked for about four hours.
 */

const PROSE = "b83c898 (on mesh/frontend; 6ea2614 -> f14529c -> d08dc73 -> b83c898)";

const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "git.commit"], interests: [] },
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review", "git.merge"], authority: ["implementation.approve"], interests: [] },
];

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

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

const parked = () => makeMesh({ agents: AGENTS, mayContact: { dev: ["lead"], lead: ["dev"] }, mode: "parked" } as never);

const publish = (m: Mesh, name: string, commit: unknown, type: Artifact["type"] = "CodePatch") =>
  m.supervisor.createArtifact({ actorId: "dev", name, type, content: `the ${name} patch`, metadata: { commit } });

test("the validator: a sha or a ref name passes, prose and git-illegal names do not", () => {
  for (const ok of ["b83c898", "B83C898", "0123456789abcdef0123456789abcdef01234567", "main", "mesh/frontend", "feature/x-1.2", "v1.0"]) {
    assert.equal(commitRefError(ok), null, `${ok} should pass`);
  }
  assert.equal(isCommitSha("b83c898"), true);
  assert.equal(isCommitSha("mesh/frontend"), false);
  assert.equal(isCommitSha("b83c89"), false, "six hex characters is not a sha");
  for (const bad of [PROSE, "", "a b", "HEAD~1", "main^", "x:y", "x..y", "x@{1}", "@", "-x", "/x", "x/", "x.", "a//b", "x.lock", "a/.hidden", "(x)", "a;b", "a,b", "a\tb", "a\\b", "a*b", "a?b", "a[b"]) {
    const why = commitRefError(bad);
    assert.ok(why, `${JSON.stringify(bad)} should be refused`);
    assert.ok(why!.includes(JSON.stringify(bad)), `the refusal names the value: ${why}`);
  }
  assert.match(String(commitRefError(null)), /got null/);
  assert.match(String(commitRefError(1234567)), /got a number/);
  assert.match(String(commitRefError(PROSE)), /^metadata\.commit must be a git commit sha or branch name/);
});

test("a CodePatch publish with a prose metadata.commit is refused, naming the whole value", async () => {
  const m = await parked();
  try {
    const res = await publish(m, "slice-1", PROSE);
    assert.ok("error" in res, "a value git cannot resolve is refused at publish, not hours later at merge");
    assert.ok(res.error.includes(JSON.stringify(PROSE)), `the full value, quoted: ${res.error}`);
    assert.match(res.error, /metadata\.commit must be a git commit sha or branch name/);
    assert.equal((await collectEvents(m)).filter((e) => e.type === "artifact.created").length, 0, "nothing was published");

    // Through the op a seat actually calls, the refusal is its op result.
    const op = await m.supervisor.executeOp(
      "dev",
      { op: "publish_artifact", name: "slice-2", type: "CodePatch", content: "a patch", metadata: { commit: PROSE } } as MeshOp,
      turnFor("dev"),
    );
    assert.equal(op.ok, false);
    assert.ok(String(op.reason).includes(JSON.stringify(PROSE)), String(op.reason));
  } finally {
    await m.cleanup();
  }
});

test("a bare sha, a branch name, or no commit at all is accepted; other types are not checked", async () => {
  const m = await parked();
  try {
    const sha = await publish(m, "by-sha", "b83c898");
    assert.ok("artifact" in sha, "error" in sha ? sha.error : "");
    const branch = await publish(m, "by-branch", "mesh/frontend");
    assert.ok("artifact" in branch, "error" in branch ? branch.error : "");
    const none = await m.supervisor.createArtifact({ actorId: "dev", name: "no-commit", type: "CodePatch", content: "a patch" });
    assert.ok("artifact" in none, "absent is fine: the merge falls back to the seat's branch");
    // The rule is about what the merge hands git; a document's metadata is its own.
    const doc = await publish(m, "notes", PROSE, "ADR");
    assert.ok("artifact" in doc, "error" in doc ? doc.error : "");

    // A new version is checked like a first publish.
    if (!("artifact" in sha)) return;
    const v2 = await m.supervisor.createArtifact({ actorId: "dev", name: "by-sha", type: "CodePatch", content: "v2", asVersionOf: sha.artifact.id, metadata: { commit: PROSE } });
    assert.ok("error" in v2, "versioning with prose is refused too");
    assert.equal(m.kernel.state.artifacts.get(sha.artifact.id)?.version, 1, "and no version was added");
  } finally {
    await m.cleanup();
  }
});

test("with a git workspace, metadata.commit must also resolve in the product repository", async () => {
  const m = await parked();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-commitref-"));
  try {
    const ws = new GitWorkspace(base);
    installWorkspace(m, ws);
    const tree = await ws.ensureWorktree("dev");
    fs.writeFileSync(path.join(tree, "feature.txt"), "work\n", "utf8");
    const { commit } = await ws.commitWorktree("dev", "feature");

    const real = await publish(m, "real", commit);
    assert.ok("artifact" in real, "error" in real ? real.error : "");
    const short = await publish(m, "short", commit.slice(0, 7));
    assert.ok("artifact" in short, "an abbreviated sha the repository has resolves");
    const branch = await publish(m, "branch", "mesh/dev");
    assert.ok("artifact" in branch, "the seat's own branch resolves from the product repository");

    const missing = await publish(m, "missing", "deadbeefdeadbeef");
    assert.ok("error" in missing, "a well-formed sha the repository does not have is refused");
    assert.match(missing.error, /"deadbeefdeadbeef" does not name a commit in the product repository/);
    const noBranch = await publish(m, "no-branch", "mesh/nobody");
    assert.ok("error" in noBranch, "so is a branch that does not exist");
  } finally {
    await m.cleanup();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a legacy CodePatch holding prose in metadata.commit cannot become MERGEABLE", async () => {
  const m = await parked();
  try {
    const goalId = m.kernel.state.activeGoalId!;
    const legacy = (commit: string, name: string): Artifact =>
      ({
        id: newArtifactId(),
        name,
        type: "CodePatch",
        goalId,
        owner: "dev",
        version: 1,
        status: "VERIFIED",
        contentRef: `mem://${name}/v1`,
        digest: "sha256:legacy",
        metadata: { commit },
        provenance: { source: "agent", trustLevel: 50 },
        createdAt: new Date().toISOString(),
        createdBy: "dev",
      }) as Artifact;
    // Recorded before the publish check existed: straight onto the log.
    const bad = legacy(PROSE, "legacy-bad");
    await m.kernel.emit("artifact.created", { artifact: bad }, { actorId: "dev", goalId });
    const refused = await m.supervisor.transitionArtifact("lead", bad.id, { to: "MERGEABLE" });
    assert.equal(refused.ok, false);
    assert.ok(String(refused.reason).includes(JSON.stringify(PROSE)), String(refused.reason));
    assert.match(String(refused.reason), /cannot become MERGEABLE/);
    assert.equal(m.kernel.state.artifacts.get(bad.id)?.status, "VERIFIED", "nothing moved");

    // Control: the same legacy shape with a real sha passes the same door.
    const good = legacy("b83c898", "legacy-good");
    await m.kernel.emit("artifact.created", { artifact: good }, { actorId: "dev", goalId });
    const moved = await m.supervisor.transitionArtifact("lead", good.id, { to: "MERGEABLE" });
    assert.equal(moved.ok, true, moved.reason);
  } finally {
    await m.cleanup();
  }
});

test("a merge that meets a missing commit quotes the value whole, and blames a reset only for a sha", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-commitref-merge-"));
  try {
    const ws = new GitWorkspace(base);
    await ws.ensureWorktree("dev");
    await assert.rejects(ws.mergeWorktree("art-prose", "dev", "merge it", PROSE), (err: Error) => {
      assert.ok(err.message.includes(JSON.stringify(PROSE)), `the full value, quoted: ${err.message}`);
      assert.doesNotMatch(err.message, /pruned/, "prose was never pruned by a reset");
      assert.match(err.message, /must name a commit here/);
      return true;
    });
    await assert.rejects(ws.mergeWorktree("art-sha", "dev", "merge it", "deadbeefdeadbeef"), (err: Error) => {
      assert.ok(err.message.includes('"deadbeefdeadbeef"'), err.message);
      assert.match(err.message, /pruned with its branch by a mission reset/, "a real sha keeps the reset hint");
      return true;
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
