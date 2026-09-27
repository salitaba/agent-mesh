import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { bootstrapMesh, closeHttpServer, createHttpServer } from "../../apps/mesh-server/src/index";
import { JsonlEventStore } from "../../packages/event-store/src/index";
import { testConfigYaml } from "../helpers";

/**
 * `JsonlEventStore.integrity()` counts what `load()` had to throw away to make
 * a log replayable: `corruptLines` (unparseable lines inside the body, skipped)
 * and `truncatedTailBytes` (a torn final append, cut off the file). Each
 * non-zero value is an event the mission had and no longer has.
 *
 * The counters are tested (tests/event-store/torn-line.test.ts) but nothing in
 * production reads them: the store's own comment says "`corruptLines` is what a
 * health check reads", and `/health` does not. So a boot over a damaged log
 * loses events silently — the one outcome the counting was meant to rule out.
 *
 * The surface asserted here is `/health`: it is the documented reader, it is
 * public (no operator token), and it already reports the log's `eventCount` and
 * `lastSeq`, which are exactly the numbers a silent drop makes wrong. The
 * search below is by key name so a fix may shape the field as it likes.
 */

function findNumber(obj: unknown, keyPattern: RegExp): number | null {
  if (obj === null || typeof obj !== "object") return null;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (keyPattern.test(k) && typeof v === "number") return v;
    const nested = findNumber(v, keyPattern);
    if (nested !== null) return nested;
  }
  return null;
}

async function health(configPath: string): Promise<Record<string, unknown>> {
  const m = await bootstrapMesh({ configPath, mode: "parked" });
  const server = createHttpServer(m, { dashboardDir: undefined });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const r = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/health`);
    assert.equal(r.status, 200);
    return (await r.json()) as Record<string, unknown>;
  } finally {
    await closeHttpServer(server);
    await m.close();
  }
}

test(
  "a boot over a log with a corrupt line and a torn tail reports both on /health",
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-integrity-"));
    try {
      const configPath = path.join(dir, "mesh.yaml");
      fs.writeFileSync(configPath, testConfigYaml({ agents: [{ id: "a", role: "r", interests: [] }], mayContact: { a: [] } }), "utf8");

      // A current-generation log, produced by a real boot.
      const first = await bootstrapMesh({ configPath, mode: "parked" });
      let logFile: string;
      try {
        for (let i = 0; i < 4; i++) await first.kernel.emit("human.input", { action: `probe-${i}` }, { actorId: "human" });
        logFile = (first.store as JsonlEventStore).path();
      } finally {
        await first.close();
      }
      // Clean-log control first: nothing lost, so nothing may be reported.
      // Only meaningful once a field exists; before that it is trivially true.
      const clean = await health(configPath);
      for (const key of [/corrupt/i, /truncat/i]) {
        const v = findNumber(clean, key);
        assert.ok(v === null || v === 0, `a clean log must not report loss (${key}): ${JSON.stringify(clean)}`);
      }

      // Damage it the two ways load() repairs: garbage in the body, and a
      // torn final append (no newline, half an event).
      const lines = fs.readFileSync(logFile, "utf8").split("\n").filter((l) => l.length > 0);
      const mid = Math.floor(lines.length / 2);
      lines.splice(mid, 0, '{"id":"evt-garbage","seq":');
      fs.writeFileSync(logFile, lines.join("\n") + "\n" + '{"id":"evt-torn","seq":99999,"type":"hum', "utf8");

      // Precondition: the store itself measured both.
      const probe = new JsonlEventStore(logFile);
      const measured = probe.integrity();
      await probe.close();
      assert.equal(measured.corruptLines, 1, "precondition: load() counted the corrupt line");
      assert.ok(measured.truncatedTailBytes > 0, "precondition: load() counted the torn tail");
      // The probe already repaired the tail on disk; re-tear it so the boot
      // under test is the one that has to notice.
      fs.appendFileSync(logFile, '{"id":"evt-torn","seq":99999,"type":"hum', "utf8");

      const h = await health(configPath);
      assert.equal(findNumber(h, /corrupt/i), 1, `/health must report the skipped corrupt line: ${JSON.stringify(h)}`);
      const torn = findNumber(h, /truncat/i);
      assert.ok(torn !== null && torn > 0, `/health must report the truncated tail: ${JSON.stringify(h)}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
