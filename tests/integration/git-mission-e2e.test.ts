import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { bootstrapMesh } from "../../apps/mesh-server/src/index";
import { attachDemoTeam } from "../../apps/mesh-cli/src/bench";
import { makeMesh, stub, waitFor } from "../helpers";
import { gitSkip } from "../support/git";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * A mission whose MERGED statuses are checked against git.
 *
 * `makemesh-git.test.ts` proves the fixture reaches the real objects by calling
 * `executeOp` by hand. This drives the same work through the live lifecycle —
 * scripted seats taking real turns, woken by real mail — and then refuses to
 * believe the projection: every artifact the state calls MERGED must be backed
 * by a merge commit on the product branch that carries the seat's file, and
 * every step must be in the event log on disk.
 *
 * Before `makeMesh({ git })` existed, a mutation that made
 * `GitWorkspace.mergeWorktree` skip `git merge` and report a made-up sha was
 * caught by one test in 1,918: everything else asserted the status.
 *
 * The flow, per patch (two patches, sequentially):
 *   dev   writes `src/feature-N.txt` into its worktree, publishes a DRAFT
 *         CodePatch, and tells lead (INFORM) it exists
 *   lead  answers "commit it" (the stub cannot learn the new artifact's id
 *         inside the turn that creates it, and `acquire_lease`/`commit` take
 *         only ids)
 *   dev   acquire_lease + commit + READY_FOR_REVIEW + PATCH_READY → lead
 *   lead  approve implementation, VERIFIED, MERGEABLE, merge, INFORM dev
 */

const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "git.commit", "test.execute"], interests: [] },
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review", "git.merge"], authority: ["implementation.approve"], interests: [] },
];
const COMM = { dev: ["lead"], lead: ["dev"] };
// `docs-written` is never evidenced, so the first merge (which evidences
// implementation-merged) does not complete the goal and refuse the second.
const CRITERIA = [
  { id: "implementation-merged", description: "the patches landed" },
  { id: "docs-written", description: "never evidenced in this test" },
];
const PATCHES = 2;

const fileOf = (n: number) => `src/feature-${n}.txt`;
const bodyOf = (n: number) => `feature ${n}: written by dev in its worktree\nline two of feature ${n}\n`;

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

type Payload = { action?: string; artifactId?: string; n?: number };

test("git mission e2e: every MERGED patch is a real merge commit carrying the seat's file, and the log on disk says so", { skip: gitSkip }, async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "live", criteria: CRITERIA, git: true });
  try {
    const s = stub(m);
    let published = 0;
    const idByN = new Map<number, string>();

    s.setScript("dev", async (input) => {
      const mail = input.context.unreadMail;
      const go = mail.find((x) => x.type === "INFORM" && (x.payload as Payload)?.action === "commit");
      if (go) {
        const { artifactId, n } = go.payload as Payload;
        return {
          text: `commit feature ${n}`,
          operations: [
            { op: "acquire_lease", artifactId, files: [fileOf(n!)] },
            { op: "commit", artifactId, message: `feat: feature ${n}`, files: [fileOf(n!)] },
            { op: "transition_artifact", artifactId, to: "READY_FOR_REVIEW" },
            { op: "send", type: "PATCH_READY", to: ["lead"], newThread: { subject: `feature ${n} ready` }, payload: { artifactId, summary: `feature ${n} committed` } },
            { op: "wait" },
          ] as MeshOp[],
        };
      }
      const merged = mail.some((x) => x.type === "INFORM" && (x.payload as Payload)?.action === "merged");
      if (published < PATCHES && (published === 0 || merged)) {
        const n = ++published;
        // The seat's own editing tools: a file in the worktree it was handed.
        const wt = await m.supervisor.agentWorkspace("dev");
        fs.mkdirSync(path.join(wt, "src"), { recursive: true });
        fs.writeFileSync(path.join(wt, fileOf(n)), bodyOf(n), "utf8");
        return {
          text: `draft feature ${n}`,
          operations: [
            { op: "publish_artifact", name: `feature-${n}`, type: "CodePatch", content: `feature ${n}: adds ${fileOf(n)}, described at length for review` },
            { op: "send", type: "INFORM", to: ["lead"], newThread: { subject: `feature ${n} drafted` }, payload: { action: "draft", n } },
            { op: "wait" },
          ] as MeshOp[],
        };
      }
      return { text: "idle", operations: [{ op: "done" }] as MeshOp[] };
    });

    s.setScript("lead", async (input) => {
      const ops: MeshOp[] = [];
      for (const x of input.context.unreadMail) {
        const p = (x.payload ?? {}) as Payload;
        if (x.type === "INFORM" && p.action === "draft") {
          const art = [...m.kernel.state.artifacts.values()].find((a) => a.type === "CodePatch" && a.name === `feature-${p.n}`);
          if (!art) continue;
          idByN.set(p.n!, art.id);
          ops.push({ op: "send", type: "INFORM", to: ["dev"], newThread: { subject: `commit feature ${p.n}` }, payload: { action: "commit", artifactId: art.id, n: p.n } } as MeshOp);
        }
        if (x.type === "PATCH_READY" && p.artifactId) {
          const n = [...idByN.entries()].find(([, id]) => id === p.artifactId)?.[0];
          ops.push(
            { op: "approve", subject: "implementation", artifactId: p.artifactId, comment: "reviewed" },
            { op: "transition_artifact", artifactId: p.artifactId, to: "VERIFIED" },
            { op: "transition_artifact", artifactId: p.artifactId, to: "MERGEABLE" },
            { op: "merge", artifactId: p.artifactId, comment: `land feature ${n}` },
            { op: "send", type: "INFORM", to: ["dev"], newThread: { subject: `feature ${n} merged` }, payload: { action: "merged", n } },
          );
        }
      }
      ops.push({ op: "done" });
      return { text: "lead pass", operations: ops };
    });

    await m.supervisor.activateAgent("dev", { kind: "startup" });
    const mergedPatches = () => [...m.kernel.state.artifacts.values()].filter((a) => a.type === "CodePatch" && a.status === "MERGED");
    await waitFor(`${PATCHES} patches MERGED`, () => mergedPatches().length >= PATCHES, 20000);

    // ---- the projection's claim, checked against git --------------------------------
    const merged = mergedPatches();
    assert.equal(merged.length, PATCHES, "exactly the patches the seats drove are MERGED");
    // First-parent merge commits on the product branch: `mergeWorktree` merges
    // `--no-ff`, so each landing is one merge commit whose SECOND parent is the
    // seat's commit. That is the ledger to hold the projection against.
    const merges = git(m.productPath, "log", "--merges", "--first-parent", "--format=%H %P", "main")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [sha, first, second] = l.split(" ");
        return { sha, first, second };
      });
    assert.equal(merges.length, merged.length, `one merge commit per MERGED patch on main:\n${git(m.productPath, "log", "--oneline", "--graph", "main")}`);
    for (const a of merged) {
      const commit = a.metadata?.commit;
      assert.equal(typeof commit, "string", `${a.name}: a MERGED patch in a git mesh records the commit it was built from`);
      assert.match(String(commit), /^[0-9a-f]{40}$/);
      const landing = merges.filter((mc) => mc.second === commit);
      assert.equal(landing.length, 1, `${a.name}: exactly one merge commit on main lands ${String(commit).slice(0, 12)}`);
      const n = Number(a.name.replace("feature-", ""));
      assert.equal(git(m.productPath, "show", `${landing[0].sha}:${fileOf(n)}`) + "\n", bodyOf(n), `${a.name}: the merge commit carries the file the seat wrote, byte for byte`);
      assert.equal(git(m.productPath, "show", `${String(commit)}:${fileOf(n)}`) + "\n", bodyOf(n), `${a.name}: and so does the seat's own commit`);
      // The seat's commit introduced the file; the product before the landing did not have it.
      assert.throws(() => execFileSync("git", ["cat-file", "-e", `${landing[0].first}:${fileOf(n)}`], { cwd: m.productPath, stdio: "ignore" }), `${a.name}: the file was not on main before its merge`);
    }
    for (let n = 1; n <= PATCHES; n++) {
      assert.equal(fs.readFileSync(path.join(m.productPath, fileOf(n)), "utf8"), bodyOf(n), `the product checkout holds ${fileOf(n)}`);
    }
    assert.equal(git(m.productPath, "status", "--porcelain"), "", "and the product checkout is clean");

    // ---- the log on disk ---------------------------------------------------------------
    // The seats are still taking their last turns when the second patch lands: the lead's INFORM wakes dev, which idles, and its
    // turn is a burst of six events. A file read now compared with a store read a moment later failed whenever that burst fell
    // between the two (178 events on disk, 184 in the store; now and then, and on the build before the ninth live run too). So the
    // store is read first, then flushed, then the file read: everything the store held at that moment is on disk when the flush
    // returns, whatever is appended after.
    const inStore = await m.store.read();
    await m.store.flush?.();
    const logFile = path.join(m.config.stateDir, "logs", "events.jsonl");
    const onDisk = fs
      .readFileSync(logFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { id: string; type: string; actorId?: string; payload: Record<string, unknown> });
    for (const a of merged) {
      const about = (type: string, pred: (p: Record<string, unknown>) => boolean = () => true) =>
        onDisk.filter((e) => e.type === type && pred(e.payload));
      const versioned = about("artifact.versioned", (p) => (p.artifact as { id?: string })?.id === a.id);
      assert.ok(
        versioned.some((e) => (e.payload.artifact as { metadata?: { commit?: string } }).metadata?.commit === a.metadata?.commit),
        `${a.name}: the commit op's version (carrying the sha) is on disk`,
      );
      assert.equal(about("patch.ready", (p) => p.artifactId === a.id).length >= 1, true, `${a.name}: PATCH_READY became patch.ready on disk`);
      const toMerged = about("artifact.transition", (p) => p.artifactId === a.id && p.to === "MERGED" && p.derived !== true);
      assert.equal(toMerged.length, 1, `${a.name}: exactly one MERGED transition on disk`);
      assert.equal(toMerged[0].actorId, "lead", `${a.name}: attributed to the seat that merged`);
      assert.equal(about("patch.merged", (p) => p.artifactId === a.id).length, 1, `${a.name}: exactly one patch.merged on disk`);
    }
    // Nothing on disk claims a MERGED the state does not hold.
    const mergedOnDisk = new Set(onDisk.filter((e) => e.type === "artifact.transition" && e.payload.to === "MERGED").map((e) => String(e.payload.artifactId)));
    assert.deepEqual([...mergedOnDisk].sort(), merged.map((a) => a.id).sort(), "the MERGED set on disk is the MERGED set in state");
    // The file is the store, event for event: it holds everything the store held when it was flushed, in order, and nothing the
    // store lacks (the store's cache is updated before the file is written, so a read taken after the file is never behind it).
    const after = await m.store.read();
    assert.ok(onDisk.length >= inStore.length, `the file is the whole store: it holds all ${inStore.length} events the store held when it was flushed`);
    assert.ok(onDisk.length <= after.length, "and nothing the store does not hold");
    assert.deepEqual(
      onDisk.map((e) => e.id),
      after.slice(0, onDisk.length).map((e) => e.id),
      "the same events in the same order",
    );
  } finally {
    await m.cleanup();
  }
});

/**
 * `examples/demo-stub` — the mesh `mesh run` ships — booted the way a user
 * boots it (file-backed, git ON, which is the default for a non-in-memory
 * run), driven by the same scripted team `journey.test.ts` uses.
 *
 * `journey.test.ts` runs it in memory, where "merge" means materializing
 * `metadata.path` into the workspace, so it proves nothing about git. Here the
 * same invariant as above is applied to whatever the demo MERGED, looping over
 * state rather than naming the patch.
 *
 * The config is copied into a tmp dir so its `./workspace` lands there; its
 * `../../roles/*.md` prompt refs are rewritten to the absolute roles dir so
 * `resolveConfig` still finds them (it refuses a missing prompt file).
 */
test(
  "demo-stub under real git: every MERGED patch is a merge commit on main carrying the file it names",
  { skip: gitSkip },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-demo-git-"));
    const yaml = fs
      .readFileSync(path.resolve(process.cwd(), "examples", "demo-stub", "mesh.yaml"), "utf8")
      .replace(/\.\.\/\.\.\/roles\//g, `${path.resolve(process.cwd(), "roles")}/`);
    fs.writeFileSync(path.join(dir, "mesh.yaml"), yaml, "utf8");
    const instance = await bootstrapMesh({ configPath: path.join(dir, "mesh.yaml"), inMemory: false, useGit: true });
    const team = attachDemoTeam(instance);
    try {
      assert.ok(instance.supervisor.deps.workspace, "(fixture) a real git workspace is on deps");
      const goalId = instance.kernel.state.activeGoalId!;
      await waitFor("the demo mission settles", () => instance.kernel.state.goals.get(goalId)?.status !== "ACTIVE", 25000);
      const merged = [...instance.kernel.state.artifacts.values()].filter((a) => a.type === "CodePatch" && a.status === "MERGED");
      assert.ok(merged.length > 0, "(fixture) the demo merged at least one patch");
      const secondParents = new Set(
        git(instance.productPath, "log", "--merges", "--first-parent", "--format=%P", "main")
          .split("\n")
          .filter(Boolean)
          .map((l) => l.split(" ")[1]),
      );
      for (const a of merged) {
        const commit = a.metadata?.commit;
        assert.equal(typeof commit, "string", `${a.name} is MERGED, so it must name the commit that landed`);
        assert.ok(secondParents.has(String(commit)), `${a.name}: a merge commit on main lands ${String(commit).slice(0, 12)}`);
        const named = a.metadata?.path;
        if (typeof named === "string") assert.ok(fs.existsSync(path.join(instance.productPath, named)), `${a.name}: the product checkout has ${named}`);
      }
    } finally {
      team.cleanup();
      await instance.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
