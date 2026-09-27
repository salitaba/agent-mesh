import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { bootstrapMesh, type MeshInstance } from "../../apps/mesh-server/src/index";
import { JsonlEventStore } from "../../packages/event-store/src/index";
import type { MeshEvent, MeshOp } from "../../packages/protocol/src/index";
import { testConfigYaml } from "../helpers";

/**
 * A snapshot is a cache of the log, never a second source of truth. On an
 * ORDINARY boot, `Kernel.replayFromStore` imports whatever `SnapshotStore.read`
 * returns and replays the log tail after `throughSeq` on top of it:
 *
 *   - `SnapshotStore.read` is a bare `JSON.parse` — no `version` check, no
 *     `meshId` check (packages/persistence/src/index.ts:112-119), and the
 *     server's provider adapter drops `version` before the kernel sees it;
 *   - the kernel never compares `throughSeq` with the log's tail. That guard
 *     exists, but only in `restoreStateDir` (:691), i.e. only when an operator
 *     restores an archive — not on a restart.
 *
 * Each case below damages ONLY the snapshot and compares the boot with a boot
 * of a byte-identical copy of the state dir with the snapshot removed, which
 * is by definition a pure log replay. Correct is "equal to that", or refusing
 * to boot loudly; anything else is state the log does not contain.
 *
 * File mode on purpose: `makeMesh` forces `inMemory`, which disables snapshots
 * entirely, so none of this is reachable there.
 */

const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
  { id: "qa", role: "qa", authority: ["quality.approve"], capabilities: ["test.execute"], interests: [] },
];

interface Bed {
  dir: string;
  configPath: string;
  cleanup(): void;
}

function bed(goal: string): Bed {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-snapcheck-"));
  const configPath = path.join(dir, "mesh.yaml");
  fs.writeFileSync(configPath, testConfigYaml({ agents: AGENTS, mayContact: { dev: ["qa"], qa: ["dev"] }, goal }), "utf8");
  return { dir, configPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function findFile(dir: string, match: (name: string) => boolean): string | null {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && match(entry.name)) return full;
    if (entry.isDirectory() && entry.name !== ".git") {
      const hit = findFile(full, match);
      if (hit) return hit;
    }
  }
  return null;
}

const snapshotOf = (dir: string): string | null => findFile(dir, (n) => n.startsWith("snapshot-") && n.endsWith(".json"));
const logOf = (dir: string): string => findFile(dir, (n) => n === "events.jsonl")!;

async function settle(m: MeshInstance, what: string, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastCount = -1;
  let quiet = 0;
  while (Date.now() < deadline) {
    const idle = m.scheduler.pending() === 0 && m.scheduler.running() === 0;
    const count = m.kernel.state.eventCount;
    quiet = idle && count === lastCount ? quiet + 1 : 0;
    lastCount = count;
    if (quiet >= 3) return;
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error(`timeout waiting for the mesh to settle: ${what}`);
}

/** Real turns: dev publishes an artifact and messages qa; qa approves. Then close (which snapshots). */
async function runMission(b: Bed): Promise<void> {
  const m = await bootstrapMesh({ configPath: b.configPath, mode: "live" });
  try {
    const s = m.stubRuntimes.get("stub")!;
    s.setScript("dev", async () => ({
      text: "publish and hand off",
      operations: [
        { op: "publish_artifact", name: "core-patch", type: "CodePatch", content: "diff --git a/A b/A\n+ work\n" } as MeshOp,
        { op: "send", type: "PATCH_READY", to: ["qa"], newThread: { subject: "patch v1" }, payload: { summary: "please test" } } as MeshOp,
        { op: "done" } as MeshOp,
      ],
    }));
    s.setScript("qa", async () => ({
      text: "approve",
      operations: [{ op: "approve", subject: "quality", comment: "tests green" } as MeshOp, { op: "done" } as MeshOp],
    }));
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await settle(m, "dev turn");
    await m.supervisor.activateAgent("qa", { kind: "manual" }, { explicit: true });
    await settle(m, "qa turn");
    for (let i = 0; i < 3; i++) await m.supervisor.rememberMemory("dev", `note-${i}`, `value ${i}`);
    assert.ok(m.kernel.state.artifacts.size > 0, "precondition: the mission produced an artifact");
  } finally {
    await m.close();
  }
}

/** Only the state that must follow from the log; ids and timestamps excluded. */
function fingerprint(m: MeshInstance): unknown {
  const st = m.kernel.state;
  return {
    activeGoal: st.activeGoalId ? st.goals.get(st.activeGoalId)?.description ?? null : null,
    goals: [...st.goals.values()].map((g) => `${g.description}|${g.status}`).sort(),
    artifacts: [...st.artifacts.values()].map((a) => `${a.type}/${a.name}@${a.version}:${a.status}`).sort(),
    messages: [...st.messages.values()].map((x) => `${x.from}>${[...x.to].sort().join(",")}:${x.type}`).sort(),
    threads: [...st.threads.values()].map((t) => t.subject).sort(),
    approvals: [...st.approvals.entries()].map(([k, v]) => `${k}:${v.map((r) => r.kind).sort().join(",")}`).sort(),
    memory: [...(st.memory.get("dev")?.keys() ?? [])].sort(),
    agents: [...st.agents.values()].map((r) => `${r.definition.id}:${r.state.activations}`).sort(),
  };
}

/**
 * Boot `b` as-is, and a copy of it with the snapshot deleted, and return both
 * fingerprints. Both parked: nothing runs, so the only difference between the
 * two boots is the snapshot.
 */
async function bootBoth(b: Bed): Promise<{ actual: unknown; reference: unknown; refused: boolean }> {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-snapcheck-ref-"));
  try {
    fs.cpSync(b.dir, copy, { recursive: true });
    const refSnap = snapshotOf(copy);
    if (refSnap) fs.rmSync(refSnap);
    const ref = await bootstrapMesh({ configPath: path.join(copy, "mesh.yaml"), mode: "parked" });
    let reference: unknown;
    try {
      reference = fingerprint(ref);
    } finally {
      await ref.close();
    }
    let m: MeshInstance;
    try {
      m = await bootstrapMesh({ configPath: b.configPath, mode: "parked" });
    } catch {
      return { actual: null, reference, refused: true };
    }
    try {
      return { actual: fingerprint(m), reference, refused: false };
    } finally {
      await m.close();
    }
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
}

function readLog(file: string): MeshEvent[] {
  return fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0).map((l) => JSON.parse(l) as MeshEvent);
}

test("control: an untouched snapshot boots to the same state as a pure log replay", async () => {
  // Makes the comparison below load-bearing: if this machinery could not tell
  // a snapshot boot from a log replay, the todo cases would pass for nothing.
  const b = bed("Mission A.");
  try {
    await runMission(b);
    assert.ok(snapshotOf(b.dir), "precondition: close() left a snapshot");
    const { actual, reference, refused } = await bootBoth(b);
    assert.equal(refused, false);
    assert.deepEqual(actual, reference);
  } finally {
    b.cleanup();
  }
});

test(
  "a snapshot whose throughSeq is past the log tail is not trusted on an ordinary boot",
  async () => {
    const b = bed("Mission A.");
    try {
      await runMission(b);
      const snapFile = snapshotOf(b.dir)!;
      const snap = JSON.parse(fs.readFileSync(snapFile, "utf8")) as { throughSeq: number };
      // The log loses its tail — everything from the artifact onwards — while
      // the snapshot still describes it. A snapshot "resurrects" what the log
      // no longer says happened.
      const logFile = logOf(b.dir);
      const events = readLog(logFile);
      const cut = events.findIndex((e) => e.type === "artifact.created" || e.type === "artifact.versioned");
      assert.ok(cut > 0, "precondition: the log records the artifact");
      fs.writeFileSync(logFile, events.slice(0, cut).map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
      assert.ok(snap.throughSeq > events[cut - 1].seq!, "precondition: the snapshot is now ahead of the log");

      const { actual, reference, refused } = await bootBoth(b);
      if (refused) return;
      assert.deepEqual(
        (reference as { artifacts: string[] }).artifacts,
        [],
        "precondition: a pure replay of the truncated log has no artifact",
      );
      assert.deepEqual(actual, reference, "a snapshot ahead of the log must not put state the log never mentions into the mission");
    } finally {
      b.cleanup();
    }
  },
);

test(
  "a snapshot written by another mesh is not trusted on an ordinary boot",
  async () => {
    const a = bed("Mission A.");
    const b = bed("Mission B.");
    try {
      await runMission(a);
      // Mission B: booted and closed with no work, so its log has no artifact.
      const mb = await bootstrapMesh({ configPath: b.configPath, mode: "parked" });
      await mb.close();
      const bSnap = snapshotOf(b.dir)!;
      const bEnvelope = JSON.parse(fs.readFileSync(bSnap, "utf8")) as { meshId: string; throughSeq: number };
      const aEnvelope = JSON.parse(fs.readFileSync(snapshotOf(a.dir)!, "utf8")) as { meshId: string; throughSeq: number };
      assert.notEqual(aEnvelope.meshId, bEnvelope.meshId, "precondition: two distinct meshes");
      // A's snapshot lands in B's slot (a copied state dir, a renamed mesh).
      // throughSeq is set to B's own tail so ONLY the meshId is wrong: the
      // throughSeq guard alone could not catch this.
      fs.writeFileSync(bSnap, JSON.stringify({ ...aEnvelope, throughSeq: bEnvelope.throughSeq }), "utf8");

      const { actual, reference, refused } = await bootBoth(b);
      if (refused) return;
      assert.equal((reference as { activeGoal: string }).activeGoal?.trim(), "Mission B.", "precondition: B's log says B's goal");
      assert.deepEqual(actual, reference, "another mesh's goals and artifacts must not be imported into this one");
    } finally {
      a.cleanup();
      b.cleanup();
    }
  },
);

test(
  "a snapshot from a different envelope version is not trusted on an ordinary boot",
  async () => {
    const b = bed("Mission A.");
    try {
      await runMission(b);
      const snapFile = snapshotOf(b.dir)!;
      const env = JSON.parse(fs.readFileSync(snapFile, "utf8")) as { version: number; data: unknown };
      assert.equal(env.version, 1, "precondition: the current writer stamps version 1");
      // A future (or past) layout this build cannot read: same mission, same
      // throughSeq, data nested one level down. A version-blind reader imports
      // it as an empty state and replays nothing on top.
      fs.writeFileSync(snapFile, JSON.stringify({ ...env, version: 2, data: { layout: "v2", state: env.data } }), "utf8");

      const { actual, reference, refused } = await bootBoth(b);
      if (refused) return;
      assert.deepEqual(actual, reference, "an envelope version this build does not write must fall back to a full log replay");
    } finally {
      b.cleanup();
    }
  },
);
