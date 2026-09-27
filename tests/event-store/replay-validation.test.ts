import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { bootstrapMesh } from "../../apps/mesh-server/src/index";
import { JsonlEventStore } from "../../packages/event-store/src/index";
import type { MeshEvent } from "../../packages/protocol/src/index";
import { testConfigYaml } from "../helpers";

/**
 * Replay must refuse what append refuses.
 *
 * `JsonlEventStore.append` runs every event through the canonical schema
 * (`validateEvent`) and throws on a miss. `load()` — the path every boot takes —
 * only `JSON.parse`s each line, so an event the runtime would never have
 * written is handed straight to the reducers on the next restart. A log is a
 * file on disk: a hand edit, a restore from somewhere else, or another writer
 * can put anything in it, and the whole point of validating at append is lost
 * if replay is the back door.
 *
 * Built on a CURRENT-generation log produced in-test: replay equality only
 * holds per code generation (older archives already throw for unrelated
 * reasons), so the forged line is a copy of an event this build just wrote,
 * differing only in the one field the schema rejects.
 */

interface Bed {
  dir: string;
  configPath: string;
  logFile: string;
  cleanup(): void;
}

/** Boot a real file-backed mesh, write one memory note, close. */
async function producedLog(): Promise<Bed & { real: MeshEvent }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-replay-valid-"));
  const configPath = path.join(dir, "mesh.yaml");
  fs.writeFileSync(configPath, testConfigYaml({ agents: [{ id: "dev", role: "developer", interests: [] }], mayContact: { dev: [] } }), "utf8");
  const m = await bootstrapMesh({ configPath, mode: "parked" });
  let logFile: string;
  try {
    await m.supervisor.rememberMemory("dev", "genuine", "written by the runtime");
    logFile = (m.store as JsonlEventStore).path();
  } finally {
    await m.close();
  }
  const lines = fs.readFileSync(logFile, "utf8").split("\n").filter((l) => l.trim().length > 0);
  const real = lines.map((l) => JSON.parse(l) as MeshEvent).filter((e) => e.type === "memory.updated").pop();
  assert.ok(real, "precondition: the runtime wrote a memory.updated event");
  return { dir, configPath, logFile, real: real!, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * A copy of a real event with a new note key. `id` decides whether the canonical
 * schema accepts it: it requires `^evt-`, so `forged-…` is refused and
 * `evt-…` is not.
 */
function variant(real: MeshEvent, id: string, key: string, seq: number): MeshEvent {
  const p = real.payload as { agentId: string; note: Record<string, unknown> };
  return { ...real, id, seq, payload: { ...p, note: { ...p.note, key, value: `note ${key}` } } } as MeshEvent;
}

async function lastSeqOf(logFile: string): Promise<number> {
  const s = new JsonlEventStore(logFile);
  try {
    return await s.lastSeq();
  } finally {
    await s.close();
  }
}

test("precondition: append refuses the forged event, so the log can only hold it by a side door", async () => {
  const b = await producedLog();
  try {
    const store = new JsonlEventStore(b.logFile);
    try {
      await assert.rejects(
        store.append(variant(b.real, "forged-1", "forged", 0)),
        /rejected by canonical schema/,
        "the append path must refuse an id outside the evt- namespace",
      );
      // And the positive twin is accepted: the refusal is about the id and
      // nothing else in the copied event.
      await store.append(variant(b.real, "evt-twin-ok", "twin", 0));
    } finally {
      await store.close();
    }
  } finally {
    b.cleanup();
  }
});

test(
  "store replay: a line the schema refuses is refused or quarantined on load, never served",
  async () => {
    const b = await producedLog();
    try {
      const seq = (await lastSeqOf(b.logFile)) + 1;
      fs.appendFileSync(b.logFile, JSON.stringify(variant(b.real, "forged-1", "forged", seq)) + "\n", "utf8");

      const store = new JsonlEventStore(b.logFile);
      try {
        let events: MeshEvent[] | null = null;
        try {
          events = await store.read();
        } catch {
          // Refusing the whole log loudly is an acceptable answer.
          return;
        }
        assert.ok(
          !events.some((e) => e.id === "forged-1"),
          "an event append would refuse must not come back out of replay",
        );
        // Quarantining is only acceptable when it is visible, exactly like the
        // torn-line repair next to it.
        const integrity = store.integrity() as unknown as Record<string, number>;
        assert.ok(
          Object.values(integrity).some((v) => typeof v === "number" && v > 0),
          `a quarantined line must be reported by integrity(): ${JSON.stringify(integrity)}`,
        );
      } finally {
        await store.close();
      }
    } finally {
      b.cleanup();
    }
  },
);

test("control: a hand-appended event the schema ACCEPTS is replayed into state on boot", async () => {
  // Proves the forged-line tests fail for the schema reason and not
  // because hand-appended lines are ignored, or the tail after the close
  // snapshot is not replayed.
  const b = await producedLog();
  try {
    const seq = (await lastSeqOf(b.logFile)) + 1;
    fs.appendFileSync(b.logFile, JSON.stringify(variant(b.real, "evt-handwritten-ok", "handwritten", seq)) + "\n", "utf8");

    const m = await bootstrapMesh({ configPath: b.configPath, mode: "parked" });
    try {
      assert.equal(m.kernel.state.memory.get("dev")?.get("handwritten")?.value, "note handwritten");
      assert.equal(m.kernel.state.memory.get("dev")?.get("genuine")?.value, "written by the runtime");
    } finally {
      await m.close();
    }
  } finally {
    b.cleanup();
  }
});

test(
  "boot replay: an event append would refuse does not reach the reducers on an ordinary restart",
  async () => {
    const b = await producedLog();
    try {
      const seq = (await lastSeqOf(b.logFile)) + 1;
      fs.appendFileSync(b.logFile, JSON.stringify(variant(b.real, "forged-1", "forged", seq)) + "\n", "utf8");

      let m: Awaited<ReturnType<typeof bootstrapMesh>>;
      try {
        m = await bootstrapMesh({ configPath: b.configPath, mode: "parked" });
      } catch {
        // Refusing to boot over a log that contains an invalid event is correct.
        return;
      }
      try {
        assert.equal(
          m.kernel.state.memory.get("dev")?.get("forged"),
          undefined,
          "the forged note must not be projected: append would never have let it into the log",
        );
        assert.equal(m.kernel.state.memory.get("dev")?.get("genuine")?.value, "written by the runtime", "the valid history still replays");
      } finally {
        await m.close();
      }
    } finally {
      b.cleanup();
    }
  },
);
