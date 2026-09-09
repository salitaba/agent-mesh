import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { openSqliteIndex } from "../../packages/persistence/src/index";
import { bootstrapMesh } from "../../apps/mesh-server/src/index";
import { testConfigYaml } from "../helpers";
import type { MeshEvent } from "../../packages/protocol/src/index";

function findFile(dir: string, name: string): string | null {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return full;
    if (entry.isDirectory()) {
      const hit = findFile(full, name);
      if (hit) return hit;
    }
  }
  return null;
}

function sqliteAvailable(): boolean {
  try {
    require("node:sqlite");
    return true;
  } catch {
    return false;
  }
}

function evt(i: number): MeshEvent {
  return {
    id: `evt-${i}`,
    seq: i,
    type: "message.sent",
    timestamp: new Date(Date.UTC(2026, 0, 1)).toISOString(),
    payload: {},
  } as MeshEvent;
}

if (!sqliteAvailable()) {
  test("sqlite: skipped (node:sqlite unavailable on this runtime)", () => assert.ok(true));
} else {
  test("sqlite: default file bootstrap creates the index and close flushes it", async () => {
    // NOTE: no `inMemory` flag — exactly how the production CLI boots. This
    // regressed once (`=== false` skipped the index on the default path).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-sqlite-boot-"));
    const configPath = path.join(dir, "mesh.yaml");
    fs.writeFileSync(
      configPath,
      testConfigYaml({ agents: [{ id: "a", role: "r", interests: [] }], mayContact: { a: [] } }),
      "utf8",
    );
    const m = await bootstrapMesh({ configPath, mode: "parked" });
    await m.kernel.emit("human.input", { action: "boot-probe" }, { actorId: "human" });
    await m.close();
    const found = findFile(dir, "events-index.sqlite");
    assert.ok(found, "events-index.sqlite must exist on the default file path");
    assert.ok((fs.statSync(found!).size ?? 0) > 0, "index must hold the boot events after close-flush");
    fs.rmSync(dir, { recursive: true, force: true });
  });
  test("sqlite: single giant ingest cannot throw (no argument spread)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-sqlite-test-"));
    const idx = openSqliteIndex(path.join(dir, "index.sqlite"));
    assert.equal(idx.available, true);
    const N = 100_000;
    const batch: MeshEvent[] = [];
    for (let i = 1; i <= N; i++) batch.push(evt(i));
    idx.ingest(batch); // old code: pending.push(...100k) -> RangeError
    idx.flush();
    assert.equal(idx.query({ limit: N }).length, N);
    idx.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("sqlite: sub-threshold ingest is invisible until flush, durable after close", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-sqlite-test-"));
    const file = path.join(dir, "index.sqlite");
    const idx = openSqliteIndex(file);
    assert.equal(idx.available, true);
    const batch: MeshEvent[] = [];
    for (let i = 1; i <= 10; i++) batch.push(evt(i));
    idx.ingest(batch);
    assert.equal(idx.query({ limit: 100 }).length, 0);
    idx.flush();
    assert.equal(idx.query({ limit: 100 }).length, 10);
    idx.close();
    // close() flushes: reopening sees everything without an explicit flush.
    const idx2 = openSqliteIndex(file);
    idx2.ingest(batch.map((e) => ({ ...e, id: `${e.id}-b`, seq: (e.seq ?? 0) + 10 })));
    idx2.close();
    const idx3 = openSqliteIndex(file);
    assert.equal(idx3.query({ limit: 100 }).length, 20);
    idx3.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
}
