/**
 * `GET /mission/backups` and `POST /mission/restore` — the way back from a reset.
 *
 * Reset archives the previous mission and then wipes the live one, and until
 * this route existed every `.mesh-backups` reference in the repo was a write or
 * a string literal: the archives were reachable only with a shell and a
 * knowledge of the layout.
 *
 * These tests are file-backed on purpose. An in-memory mesh has no state dir,
 * so it is refused outright — the whole feature is about files.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { bootstrapMesh } from "../../apps/mesh-server/src/index";
import { closeHttpServer, createHttpServer, type MeshInstance } from "../../apps/mesh-server/src/index";
import { testConfigYaml } from "../helpers";

const hasGit = (() => {
  try {
    require("child_process").execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

interface Bed {
  dir: string;
  mesh: MeshInstance;
  base: string;
  server: ReturnType<typeof createHttpServer>;
}

async function withMesh(fn: (bed: Bed) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-restore-"));
  const configPath = path.join(dir, "mesh.yaml");
  fs.writeFileSync(
    configPath,
    testConfigYaml({ agents: [{ id: "a", role: "r", interests: [] }], mayContact: { a: [] } }),
    "utf8",
  );
  const mesh = await bootstrapMesh({ configPath, mode: "parked" });
  const server = createHttpServer(mesh, { dashboardDir: undefined });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await fn({ dir, mesh, base, server });
  } finally {
    await closeHttpServer(server);
    await mesh.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function post(base: string, route: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${base}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

interface Backup {
  stamp: string;
  kind: string;
  name: string;
  path: string;
  bytes: number;
  mtime: string;
  hasEvents: boolean;
}

async function backups(base: string): Promise<Backup[]> {
  const r = await fetch(`${base}/mission/backups`);
  assert.equal(r.status, 200);
  return ((await r.json()) as { backups: Backup[] }).backups;
}

/** Reset, leaving one set of archives behind, and hand back the stamp. */
async function resetOnce(bed: Bed): Promise<string> {
  const r = await post(bed.base, "/mission/reset", { confirm: true, confirmId: bed.mesh.config.meshId });
  assert.equal(r.status, 200, `reset must succeed: ${JSON.stringify(r.json)}`);
  const stamp = /\.bak-(\d{8}-\d{6})/.exec(r.json.archivedTo as string)?.[1];
  assert.ok(stamp, `the state archive must carry a stamp: ${r.json.archivedTo}`);
  return stamp;
}

test("GET /mission/backups groups one reset's archives under its stamp", { skip: !hasGit && "git unavailable" }, async () => {
  await withMesh(async (bed) => {
    await bed.mesh.kernel.emit("human.input", { action: "before-reset" }, { actorId: "human" });
    // Cut a worktree so the reset has something to archive in all three
    // places; without one the worktrees archive is correctly absent.
    const workspace = bed.mesh.supervisor.deps.workspace;
    assert.ok(workspace, "git mode must expose a workspace");
    await workspace.ensureWorktree("a");
    const stamp = await resetOnce(bed);

    const list = await backups(bed.base);
    const mine = list.filter((a) => a.stamp === stamp);
    // One stamp, one set: the state, the product checkout and the worktrees.
    assert.deepEqual(
      mine.map((a) => a.kind).sort(),
      ["product", "state", "worktrees"],
      `expected all three archive kinds under ${stamp}: ${JSON.stringify(list)}`,
    );
    // Only the state archive carries a log, and only a state archive restores.
    assert.deepEqual(
      mine.filter((a) => a.hasEvents).map((a) => a.kind),
      ["state"],
      "only the state archive holds the mission log",
    );
    for (const a of mine) assert.ok(a.bytes > 0, `${a.name} must report a size`);
  });
});

test("POST /mission/restore brings the archived mission back", { skip: !hasGit && "git unavailable" }, async () => {
  await withMesh(async (bed) => {
    for (let i = 0; i < 4; i++) {
      await bed.mesh.kernel.emit("human.input", { action: `probe-${i}` }, { actorId: "human" });
    }
    const goalBefore = bed.mesh.kernel.state.activeGoalId;
    const stamp = await resetOnce(bed);
    // Wiped: the reset really did destroy something worth getting back.
    assert.notEqual(bed.mesh.kernel.state.activeGoalId, goalBefore, "reset must have minted a new goal");

    const r = await post(bed.base, "/mission/restore", {
      stamp,
      confirmId: bed.mesh.config.meshId,
    });
    assert.equal(r.status, 200, JSON.stringify(r.json));

    const report = r.json as { goalId: string; events: number; mode: string; previousArchivedTo: string | null; restoredFrom: string };
    assert.equal(report.goalId, goalBefore, "the restored goal must be the one the log names");
    assert.ok(report.events > 4, "the restored log must carry the pre-reset events");
    // Parked, always: the operator decides when a restored mission resumes.
    assert.equal(report.mode, "parked");
    assert.equal(bed.mesh.mode, "parked");
    // And the kernel actually holds the restored mission, not just a report.
    assert.equal(bed.mesh.kernel.state.activeGoalId, goalBefore);
    const live = await bed.mesh.store.read();
    assert.ok(
      live.some((e) => (e.payload as { action?: string })?.action === "probe-0"),
      "the store must serve the restored log",
    );
    // Reversible: the state it replaced was archived, not deleted.
    assert.ok(report.previousArchivedTo, "the replaced state must be archived");
    assert.ok(fs.existsSync(report.previousArchivedTo!), "that archive must exist on disk");
  });
});

test("restore leaves the archive in place, so it can be used twice", { skip: !hasGit && "git unavailable" }, async () => {
  await withMesh(async (bed) => {
    await bed.mesh.kernel.emit("human.input", { action: "keepme" }, { actorId: "human" });
    const stamp = await resetOnce(bed);
    const archive = (await backups(bed.base)).find((a) => a.stamp === stamp && a.kind === "state");
    assert.ok(archive, "the state archive must be discoverable");

    const first = await post(bed.base, "/mission/restore", { stamp, confirmId: bed.mesh.config.meshId });
    assert.equal(first.status, 200, JSON.stringify(first.json));
    const second = await post(bed.base, "/mission/restore", { stamp, confirmId: bed.mesh.config.meshId });
    assert.equal(second.status, 200, JSON.stringify(second.json));
    assert.equal(
      (second.json as { events: number }).events,
      (first.json as { events: number }).events,
      "the second restore must read the same archive, not a consumed one",
    );
    assert.ok(fs.existsSync(archive!.path), "the archive must still be on disk");
  });
});

test("restore drops a snapshot that claims more history than the log has", { skip: !hasGit && "git unavailable" }, async () => {
  await withMesh(async (bed) => {
    await bed.mesh.kernel.emit("human.input", { action: "real-work" }, { actorId: "human" });
    const stamp = await resetOnce(bed);
    const archive = (await backups(bed.base)).find((a) => a.stamp === stamp && a.kind === "state");
    assert.ok(archive, "the state archive must be discoverable");

    // `Kernel.replayFromStore` fast-forwards from a snapshot's throughSeq
    // without checking the log, so a snapshot from a later mission would
    // resurrect goals the restored log has never heard of. Plant exactly that
    // and prove it does not survive.
    fs.writeFileSync(
      path.join(archive!.path, `snapshot-${bed.mesh.config.meshId}.json`),
      JSON.stringify({ version: 1, meshId: bed.mesh.config.meshId, takenAt: new Date().toISOString(), throughSeq: 999_999, data: {} }),
      "utf8",
    );

    const r = await post(bed.base, "/mission/restore", { stamp, confirmId: bed.mesh.config.meshId });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal((r.json as { snapshotDropped: boolean }).snapshotDropped, true, "the stale snapshot must be dropped");
    assert.ok(
      !fs.existsSync(path.join(bed.mesh.config.stateDir, `snapshot-${bed.mesh.config.meshId}.json`)),
      "the dropped snapshot must not be left in the live state dir",
    );
    // The proof that it mattered: the restored mission is the log's, not the
    // snapshot's.
    const live = await bed.mesh.store.read();
    assert.ok(
      live.some((e) => (e.payload as { action?: string })?.action === "real-work"),
      "the restored mission must come from the log",
    );
  });
});

test("restore does not resurrect archived agent sessions by default", { skip: !hasGit && "git unavailable" }, async () => {
  await withMesh(async (bed) => {
    await bed.mesh.kernel.emit("human.input", { action: "x" }, { actorId: "human" });
    const stamp = await resetOnce(bed);
    const archive = (await backups(bed.base)).find((a) => a.stamp === stamp && a.kind === "state");
    assert.ok(archive);
    // The session ids in a restored registry point at runtimes that no longer
    // exist; the registry caches what it loads, so a stale one fails mid-turn.
    fs.writeFileSync(
      path.join(archive!.path, "sessions.json"),
      JSON.stringify([{ agentId: "a", sessionId: "dead-session", runtime: "claude", updatedAt: new Date().toISOString() }]),
      "utf8",
    );

    const r = await post(bed.base, "/mission/restore", { stamp, confirmId: bed.mesh.config.meshId });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal((r.json as { sessionsDropped: boolean }).sessionsDropped, true);
    assert.ok(!fs.existsSync(path.join(bed.mesh.config.stateDir, "sessions.json")), "the stale registry must not land");

    // Opting in is allowed, and is the caller's problem.
    fs.writeFileSync(
      path.join(archive!.path, "sessions.json"),
      JSON.stringify([{ agentId: "a", sessionId: "kept-session", runtime: "claude", updatedAt: new Date().toISOString() }]),
      "utf8",
    );
    const kept = await post(bed.base, "/mission/restore", { stamp, confirmId: bed.mesh.config.meshId, keepSessions: true });
    assert.equal(kept.status, 200, JSON.stringify(kept.json));
    assert.equal((kept.json as { sessionsDropped: boolean }).sessionsDropped, false);
  });
});

test("restore refuses what it cannot do, each with its own reason", { skip: !hasGit && "git unavailable" }, async () => {
  await withMesh(async (bed) => {
    const stamp = await resetOnce(bed);
    const meshId = bed.mesh.config.meshId;

    const wrongId = await post(bed.base, "/mission/restore", { stamp, confirmId: "not-the-mesh-id" });
    assert.equal(wrongId.status, 409);
    assert.match(String(wrongId.json.error), new RegExp(meshId), "the refusal must name the string to type");

    const missing = await post(bed.base, "/mission/restore", { confirmId: meshId });
    assert.equal(missing.status, 400);

    const unknown = await post(bed.base, "/mission/restore", { stamp: "19990101-000000", confirmId: meshId });
    assert.equal(unknown.status, 404);

    // A stamp whose state archive is gone: the other archives remain, and none
    // of them can be restored.
    const state = (await backups(bed.base)).find((a) => a.stamp === stamp && a.kind === "state");
    assert.ok(state);
    fs.rmSync(state!.path, { recursive: true, force: true });
    const noState = await post(bed.base, "/mission/restore", { stamp, confirmId: meshId });
    assert.equal(noState.status, 400);
    assert.match(String(noState.json.error), /no state archive/);

    // Not parked: restore does not stop a running mission to restore over it.
    const live = await bed.mesh.goLive("test");
    assert.equal(live.alreadyLive, false);
    const running = await post(bed.base, "/mission/restore", { stamp, confirmId: meshId });
    assert.equal(running.status, 409);
    assert.match(String(running.json.error), /parked/);
  });
});

test("reset itself requires the mesh id, not just a boolean", { skip: !hasGit && "git unavailable" }, async () => {
  await withMesh(async (bed) => {
    // `confirm:true` is a constant anyone can type, and the route is reachable
    // without a token when MESH_API_TOKEN is unset.
    const bare = await post(bed.base, "/mission/reset", { confirm: true });
    assert.equal(bare.status, 409);
    assert.match(String(bare.json.error), new RegExp(bed.mesh.config.meshId));

    const noConfirm = await post(bed.base, "/mission/reset", { confirmId: bed.mesh.config.meshId });
    assert.equal(noConfirm.status, 400);

    const ok = await post(bed.base, "/mission/reset", { confirm: true, confirmId: bed.mesh.config.meshId });
    assert.equal(ok.status, 200);
  });
});
