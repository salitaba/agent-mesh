import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { bootstrapMesh } from "../../apps/mesh-server/src/index";
import { StateLockError } from "../../packages/persistence/src/index";
import { testConfigYaml } from "../helpers";

function bed(): { dir: string; configPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-snapclose-"));
  const configPath = path.join(dir, "mesh.yaml");
  fs.writeFileSync(
    configPath,
    testConfigYaml({ agents: [{ id: "a", role: "r", interests: [] }], mayContact: { a: [] } }),
    "utf8",
  );
  return { dir, configPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function findSnapshot(dir: string): string | null {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.startsWith("snapshot-") && entry.name.endsWith(".json")) return full;
    if (entry.isDirectory()) {
      const hit = findSnapshot(full);
      if (hit) return hit;
    }
  }
  return null;
}

test("close: snapshots so a restart does not replay the whole log", async () => {
  const b = bed();
  try {
    const first = await bootstrapMesh({ configPath: b.configPath, mode: "parked" });
    // Deliberately fewer than the every-200 cadence: the whole point of P2 is
    // that a mesh closed below the threshold still snapshots. With only
    // maybeSnapshot(), nothing here would be written.
    for (let i = 0; i < 12; i++) {
      await first.kernel.emit("human.input", { action: `probe-${i}` }, { actorId: "human" });
    }
    const seqAtClose = first.kernel.state.lastEventSeq;
    const countAtClose = first.kernel.state.eventCount;
    assert.ok(countAtClose > 0, "precondition: the mission produced events");
    await first.close();

    const snapFile = findSnapshot(b.dir);
    assert.ok(snapFile, "close() must leave a snapshot behind");
    const snap = JSON.parse(fs.readFileSync(snapFile!, "utf8")) as { throughSeq: number };
    assert.equal(snap.throughSeq, seqAtClose, "the snapshot must cover every event up to close");

    // Restart: the tail replayed off the snapshot must be empty, and the
    // restored state must equal what we closed with.
    const second = await bootstrapMesh({ configPath: b.configPath, mode: "parked" });
    try {
      assert.equal(second.kernel.state.lastEventSeq, seqAtClose, "restored seq must match");
      assert.equal(second.kernel.state.eventCount, countAtClose, "restored event count must match");
    } finally {
      await second.close();
    }
  } finally {
    b.cleanup();
  }
});

test("close: replayFromStore reads no tail events after a clean close", async () => {
  const b = bed();
  try {
    const first = await bootstrapMesh({ configPath: b.configPath, mode: "parked" });
    for (let i = 0; i < 5; i++) {
      await first.kernel.emit("human.input", { action: `probe-${i}` }, { actorId: "human" });
    }
    await first.close();

    const second = await bootstrapMesh({ configPath: b.configPath, mode: "parked" });
    try {
      // Direct measurement rather than inference: replayFromStore returns the
      // number of post-snapshot events it had to apply. Zero means the
      // snapshot was current at close.
      const replayed = await second.kernel.replayFromStore();
      assert.equal(replayed, 0, "a clean close must leave nothing to replay");
    } finally {
      await second.close();
    }
  } finally {
    b.cleanup();
  }
});

test("close: releases the state lock so the mesh can be reopened", async () => {
  const b = bed();
  try {
    const first = await bootstrapMesh({ configPath: b.configPath, mode: "parked" });
    const stateDir = first.config.stateDir;
    assert.ok(fs.existsSync(path.join(stateDir, ".mesh-lock.json")), "a live mesh must hold the lock");
    await first.close();
    assert.ok(!fs.existsSync(path.join(stateDir, ".mesh-lock.json")), "close must release the lock");

    const second = await bootstrapMesh({ configPath: b.configPath, mode: "parked" });
    await second.close();
  } finally {
    b.cleanup();
  }
});

test("bootstrap: a second mesh over an open state dir is refused", async () => {
  const b = bed();
  const first = await bootstrapMesh({ configPath: b.configPath, mode: "parked" });
  try {
    await assert.rejects(
      () => bootstrapMesh({ configPath: b.configPath, mode: "parked" }),
      (err: unknown) => {
        assert.ok(err instanceof StateLockError, `expected StateLockError, got ${String(err)}`);
        return true;
      },
    );
    // The incumbent must be entirely unaffected by the refused attempt.
    await first.kernel.emit("human.input", { action: "still-alive" }, { actorId: "human" });
  } finally {
    await first.close();
    b.cleanup();
  }
});

test("reset: keeps the state dir locked after it is archived and recreated", async () => {
  const b = bed();
  const m = await bootstrapMesh({ configPath: b.configPath, mode: "parked" });
  try {
    await m.kernel.emit("human.input", { action: "pre-reset" }, { actorId: "human" });
    await m.reset({});
    // archiveStateDir renames the directory away, taking the lock with it.
    // Without the refresh in reset(), the recreated dir would be unclaimed and
    // a second process could open the log this mesh is still writing to.
    assert.ok(
      fs.existsSync(path.join(m.config.stateDir, ".mesh-lock.json")),
      "the lock must be re-staked after reset",
    );
    await assert.rejects(
      () => bootstrapMesh({ configPath: b.configPath, mode: "parked" }),
      StateLockError,
    );
  } finally {
    await m.close();
    b.cleanup();
  }
});

test("in-memory meshes take no lock, so test beds can share a config", async () => {
  const b = bed();
  const first = await bootstrapMesh({ configPath: b.configPath, inMemory: true, mode: "parked" });
  const second = await bootstrapMesh({ configPath: b.configPath, inMemory: true, mode: "parked" });
  try {
    assert.ok(first.kernel !== second.kernel, "two independent in-memory meshes");
  } finally {
    await first.close();
    await second.close();
    b.cleanup();
  }
});
