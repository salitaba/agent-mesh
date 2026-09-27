import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { makeMesh, stub, waitFor } from "../helpers";
import { gitSkip } from "../support/git";
import type { AgentInput, MeshOp } from "../../packages/protocol/src/index";

/**
 * A seat that writes files and never issues `commit`, against a REAL git
 * worktree.
 *
 * `tests/core/uncommitted-work-advisory.test.ts` pins the advisory's gates, but
 * against a `FakeWorkspace` that reports whatever `WorktreeState` the test
 * hands it — so nothing proved the real `git status` parse produces the names
 * the sentence quotes, or that the sentence reaches the seat through a real
 * turn. The run this advisory exists for (2026-09-24) ended with 1,847 lines
 * untracked in one worktree and the patch recorded MERGED; these tests replay
 * that shape end to end: a live turn, real files, real `git`, and then the
 * merge that recorded it.
 */

const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "git.commit"], interests: [] },
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review", "git.merge"], authority: ["implementation.approve"], interests: [] },
];
const COMM = { dev: ["lead"], lead: ["dev"] };
// Two criteria, one never evidenced, so no merge in here completes the mission
// and turns every later op into "mission is COMPLETED".
const CRITERIA = [
  { id: "implementation-merged", description: "landed" },
  { id: "docs-written", description: "never evidenced here" },
];

const FILES = ["src/core/digest.js", "src/core/canonical.js", "test/digest.test.js"];

const turnFor = (agentId: string) =>
  ({ turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`, agentId, reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] }) as never;

function writeAll(worktree: string): void {
  for (const f of FILES) {
    fs.mkdirSync(path.dirname(path.join(worktree, f)), { recursive: true });
    fs.writeFileSync(path.join(worktree, f), `// ${f}\nexport const body = ${JSON.stringify(f)};\n`, "utf8");
  }
}

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

const memoryNotes = async (m: Mesh, agentId: string): Promise<string[]> =>
  (await m.store.read())
    .filter((e) => e.type === "memory.updated" && (e.payload as { agentId?: string }).agentId === agentId)
    .map((e) => String((e.payload as { note?: { value?: string } }).note?.value ?? ""));

test("a live turn that writes files and never commits is told so by the REAL worktree state, naming every file", { skip: gitSkip }, async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "live", criteria: CRITERIA, git: true });
  try {
    const seen: AgentInput[] = [];
    stub(m).setScript("dev", async (input, turn) => {
      seen.push(input);
      if (turn === 0) {
        // The seat's own editing tools: files straight into the worktree it
        // was handed, and a CodePatch published about them. No lease, no commit.
        writeAll(await m.supervisor.agentWorkspace("dev"));
        return {
          text: "wrote the digest module",
          operations: [
            { op: "publish_artifact", name: "digest", type: "CodePatch", content: "digest module: canonical json + sha256, with tests" },
            { op: "done" },
          ] as MeshOp[],
        };
      }
      return { text: "idle", operations: [{ op: "done" }] as MeshOp[] };
    });

    await m.supervisor.activateAgent("dev", { kind: "startup" });
    await waitFor("dev's first turn published its patch", () => [...m.kernel.state.artifacts.values()].some((a) => a.name === "digest"));
    // A seat's turns are serial: once the second has started, the first one's
    // end-of-turn bookkeeping (where the advisory is written) has run. Waiting
    // on the memory note itself would turn a missing advisory into a timeout.
    await m.supervisor.activateAgent("dev", { kind: "manual", note: "continue" });
    await waitFor("dev's second turn started", () => seen.length >= 2);

    const worktree = await m.supervisor.agentWorkspace("dev");
    // (fixture) the files are real and untracked in a real git worktree
    assert.deepEqual(
      execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: worktree, encoding: "utf8" }).trim().split("\n").sort(),
      FILES.map((f) => `?? ${f}`).sort(),
    );

    const notes = await memoryNotes(m, "dev");
    const advisory = notes.find((n) => /NOT committed/.test(n));
    assert.ok(advisory, `the turn's summary carries the uncommitted-work advisory; got:\n${notes.join("\n")}`);
    assert.match(advisory!, /3 file\(s\)/, "the count is per file (-uall), not per directory");
    assert.match(advisory!, /\(3 untracked\)/);
    for (const f of FILES) assert.ok(advisory!.includes(f), `the advisory names ${f}`);
    assert.match(advisory!, /`commit` op/, "and names the op that would land them");

    // The advisory is only worth anything if the seat READS it: the next turn's
    // context must carry it in the seat's own memory.
    const memory = seen[1].context.agentMemory.map((n) => n.value).join("\n");
    assert.match(memory, /NOT committed/, "the next turn's context carries the warning");
    for (const f of FILES) assert.ok(memory.includes(f), `the next turn still names ${f}`);
  } finally {
    await m.cleanup();
  }
});

test("a turn that commits its files is not warned (real git: the worktree is clean afterwards)", { skip: gitSkip }, async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "live", criteria: CRITERIA, git: true });
  try {
    const created = await m.supervisor.createArtifact({ actorId: "dev", name: "digest", type: "CodePatch", content: "digest module, committed properly" });
    if (!("artifact" in created)) throw new Error(created.error);
    const id = created.artifact.id;
    let turns = 0;
    stub(m).setScript("dev", async (_input, turn) => {
      turns++;
      if (turn > 0) return { text: "idle", operations: [{ op: "done" }] as MeshOp[] };
      writeAll(await m.supervisor.agentWorkspace("dev"));
      return {
        text: "wrote and committed",
        operations: [
          { op: "acquire_lease", artifactId: id, files: FILES },
          { op: "commit", artifactId: id, message: "feat: digest", files: FILES },
          { op: "done" },
        ] as MeshOp[],
      };
    });
    await m.supervisor.activateAgent("dev", { kind: "startup" });
    await waitFor("the commit landed on dev's branch", () => typeof m.kernel.state.artifacts.get(id)?.metadata?.commit === "string");
    // A committing turn may leave no summary at all, so "no advisory yet" proves
    // nothing until the turn is over. A seat's turns are serial: once a second
    // turn has started, the first one's end-of-turn bookkeeping has run.
    await m.supervisor.activateAgent("dev", { kind: "manual", note: "continue" });
    await waitFor("dev's second turn started", () => turns >= 2);
    const notes = await memoryNotes(m, "dev");
    assert.ok(!notes.some((n) => /NOT committed/.test(n)), `a seat that committed is not warned; got:\n${notes.join("\n")}`);
    const st = await m.supervisor.deps.workspace!.worktreeState("dev");
    assert.deepEqual(st?.dirty, [], "real git agrees: nothing is left uncommitted");
    assert.equal(st?.unmergedCommits.length, 1, "and the commit is on the branch, not yet in the product");
  } finally {
    await m.cleanup();
  }
});

/** Walk a published, never-committed patch to MERGEABLE and merge it. */
async function mergeUncommitted(m: Mesh): Promise<{ id: string; merge: Awaited<ReturnType<Mesh["supervisor"]["executeOp"]>> }> {
  const worktree = await m.supervisor.agentWorkspace("dev");
  writeAll(worktree);
  const created = await m.supervisor.createArtifact({ actorId: "dev", name: "digest", type: "CodePatch", content: "digest module: canonical json + sha256, with tests" });
  if (!("artifact" in created)) throw new Error(created.error);
  const id = created.artifact.id;
  await m.supervisor.transitionArtifact("dev", id, { to: "READY_FOR_REVIEW" });
  const ap = await m.supervisor.executeOp("lead", { op: "approve", subject: "implementation", artifactId: id } as MeshOp, turnFor("lead"));
  assert.equal(ap.ok, true, `approve: ${ap.reason ?? ""}`);
  await m.supervisor.transitionArtifact("lead", id, { to: "VERIFIED" });
  await m.supervisor.transitionArtifact("lead", id, { to: "MERGEABLE" });
  assert.equal(m.kernel.state.artifacts.get(id)?.status, "MERGEABLE", "(fixture) the patch reached MERGEABLE");
  const merge = await m.supervisor.executeOp("lead", { op: "merge", artifactId: id, comment: "land digest" } as MeshOp, turnFor("lead"));
  return { id, merge };
}

test("merging a never-committed patch does not destroy the seat's files", { skip: gitSkip }, async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", criteria: CRITERIA, git: true });
  try {
    await mergeUncommitted(m);
    const worktree = await m.supervisor.agentWorkspace("dev");
    for (const f of FILES) assert.ok(fs.existsSync(path.join(worktree, f)), `${f} is still in the seat's worktree after the merge`);
    const st = await m.supervisor.deps.workspace!.worktreeState("dev");
    assert.deepEqual([...(st?.dirty ?? [])].sort(), [...FILES].sort(), "and still reported as uncommitted, so the next turn is warned again");
  } finally {
    await m.cleanup();
  }
});

test(
  "merging a never-committed patch either lands its files or is refused — never MERGED over a product without them",
  {
    skip: gitSkip,
  },
  async () => {
    const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", criteria: CRITERIA, git: true });
    try {
      const headBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: m.productPath, encoding: "utf8" }).trim();
      const { id, merge } = await mergeUncommitted(m);
      const landed = FILES.every((f) => fs.existsSync(path.join(m.productPath, f)));
      if (merge.ok) {
        assert.ok(landed, `the merge reported ok (${merge.reason}) so the files must be in the product checkout`);
        assert.notEqual(execFileSync("git", ["rev-parse", "HEAD"], { cwd: m.productPath, encoding: "utf8" }).trim(), headBefore, "and the product branch moved");
      } else {
        assert.equal(m.kernel.state.artifacts.get(id)?.status, "MERGEABLE", "a refused merge leaves the patch MERGEABLE");
        assert.match(merge.reason ?? "", /commit/i, "and tells the seat the work was never committed");
      }
      const crit = m.kernel.state.goals.get(m.kernel.state.activeGoalId ?? "")?.acceptanceCriteria.find((c) => c.id === "implementation-merged");
      assert.ok(landed || crit?.status !== "EVIDENCED", "implementation-merged is never EVIDENCED by a merge that landed nothing");
    } finally {
      await m.cleanup();
    }
  },
);
