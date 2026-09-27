import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TurnTracker, type TurnRecord, type TurnTrackerPersist } from "../../packages/core/src/turn-tracker";
import { mergeTurnSteps } from "../../apps/mesh-server/src/steps-view";

/**
 * A turn row is written `running` before the runtime is called and rewritten
 * with a terminal status when the turn ends. A process killed mid-turn writes
 * neither, so the row sits on disk as `running` until it falls off the ring —
 * and every turn reader prefers that row over the log's own account, so a seat
 * the mesh restarted under kept reading as WORKING (measured live 2026-09-27:
 * qa's `turn-c6c9e58e` was still `running` 40 minutes after the child restarted
 * under it, with a completed successor turn beside it).
 *
 * The boot finalization below closes those rows, and these tests hold the three
 * properties it needs: it closes exactly the stale ones, it is idempotent, and
 * it never touches a turn that is running in the live process.
 */

/** The supervisor's own sidecar shape: JSONL, one record per line, whole-ring rewrite. */
function filePersist(file: string): TurnTrackerPersist & { saves: TurnRecord[][] } {
  const saves: TurnRecord[][] = [];
  return {
    saves,
    load: (): TurnRecord[] => {
      if (!fs.existsSync(file)) return [];
      const out: TurnRecord[] = [];
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          out.push(JSON.parse(t) as TurnRecord);
        } catch {
          /* skip corrupt line */
        }
      }
      return out;
    },
    save: (records: TurnRecord[]): void => {
      saves.push(records);
      fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    },
  };
}

function rawFile(file: string, rows: unknown[]): void {
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

const withDir = (fn: (dir: string, file: string) => void): void => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-turns-restart-"));
  try {
    fn(dir, path.join(dir, "turns.jsonl"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

/** The row the live mission left behind, field for field (child killed 49s in). */
function killedRow(): Record<string, unknown> {
  const started = Date.parse("2026-09-27T08:51:23.558Z");
  return {
    turnId: "turn-c6c9e58e5e7c4d34",
    agentId: "qa",
    reason: { kind: "message", note: "asked" },
    startedAt: "2026-09-27T08:51:23.558Z",
    endedAt: null,
    status: "running",
    liveTokens: 22875,
    toolCallCount: 4,
    toolFrames: 9,
    instructions: "review the payment-api change",
    phases: {
      startedAt: started,
      contextAt: started + 1200,
      llmCallAt: started + 1400,
      firstActivityAt: started + 3100,
      lastActivityAt: started + 49_000,
      deadlineAt: started + 900_000,
      ceilingAt: started + 1_800_000,
    },
    liveTools: [
      { id: "c1", name: "Read", target: "src/index.ts", status: "completed", startedAt: started + 3100, endedAt: started + 3300 },
      { id: "c2", name: "Bash", target: "npm run typecheck", status: "running", startedAt: started + 48_000 },
    ],
    filesTouched: ["src/index.ts"],
  };
}

function finishedRow(): Record<string, unknown> {
  return {
    turnId: "turn-e88801c1634d73c1",
    agentId: "qa",
    reason: { kind: "message", note: "asked" },
    startedAt: "2026-09-27T08:52:30.000Z",
    endedAt: "2026-09-27T09:13:36.000Z",
    durationMs: 1_266_000,
    status: "ok",
    tokens: 41_000,
    tokensInput: 9_000,
    tokensOutput: 1_200,
    summary: "reviewed",
  };
}

test("a turn the mesh restarted under is closed at boot, at its own last mark", () => {
  withDir((_dir, file) => {
    rawFile(file, [killedRow(), finishedRow()]);
    const persist = filePersist(file);

    const tracker = new TurnTracker(persist);
    const closed = tracker.get("turn-c6c9e58e5e7c4d34")!;
    const started = Date.parse("2026-09-27T08:51:23.558Z");

    assert.equal(closed.status, "blocked", "an ended turn, not a crash badge: `failed` is what `mesh failures` and the console's \"crashed\" count");
    assert.equal(closed.endedAt, "2026-09-27T08:52:12.558Z", "ended at the row's own last sign of life, not at boot");
    assert.equal(closed.durationMs, 49_000, "the time it actually worked, not the 40 minutes the process was down");
    assert.match(String(closed.error), /server restart/);
    assert.match(String(closed.error), /last activity 49s in/);
    assert.equal(closed.errorDetail?.kind, "ServerRestart");
    assert.equal(closed.phases?.endedAt, started + 49_000, "the flight recorder's last leg is closed with the row");
    assert.equal(closed.phases?.lastActivityAt, started + 49_000, "and its marks are kept, not rewritten");
    assert.equal(closed.liveTokens, 22875, "what the turn spent before it died is not erased");
    assert.equal(closed.toolCallCount, 4);
  });
});

test("boot finalization writes the file once, and only for the rows it closed", () => {
  withDir((_dir, file) => {
    rawFile(file, [killedRow(), finishedRow()]);
    const persist = filePersist(file);
    const before = JSON.parse(JSON.stringify(persist.load()));

    new TurnTracker(persist);

    assert.equal(persist.saves.length, 1, "one rewrite for the whole boot, not one per row");
    const written = persist.saves[0]!;
    // The other row is byte-identical: brought back exactly as it was stored.
    assert.deepEqual(
      written.find((r) => r.turnId === "turn-e88801c1634d73c1"),
      before.find((r: TurnRecord) => r.turnId === "turn-e88801c1634d73c1"),
      "a turn that already ended is not touched at all",
    );
    assert.equal(written.find((r) => r.turnId === "turn-c6c9e58e5e7c4d34")?.status, "blocked");
  });
});

test("loading twice does not re-finalize: the second boot finds nothing stale and writes nothing", () => {
  withDir((_dir, file) => {
    rawFile(file, [killedRow(), finishedRow()]);

    const first = new TurnTracker(filePersist(file));
    const once = JSON.parse(JSON.stringify(first.get("turn-c6c9e58e5e7c4d34")));
    const onDisk = fs.readFileSync(file, "utf8");

    const secondPersist = filePersist(file);
    const second = new TurnTracker(secondPersist);

    assert.deepEqual(second.get("turn-c6c9e58e5e7c4d34"), once, "the closed row is unchanged by a later boot");
    assert.equal(secondPersist.saves.length, 0, "nothing was stale, so the file was not rewritten");
    assert.equal(fs.readFileSync(file, "utf8"), onDisk, "and it is byte-identical on disk");
  });
});

test("a turn running in THIS process is not finalized by a later load", () => {
  withDir((_dir, file) => {
    const live = new TurnTracker(filePersist(file));
    live.push({
      turnId: "turn-live-in-process",
      agentId: "qa",
      reason: { kind: "message" },
      startedAt: new Date().toISOString(),
      status: "running",
      toolCallCount: 2,
    });
    live.flush();

    const reloaded = new TurnTracker(filePersist(file));

    assert.equal(reloaded.get("turn-live-in-process")?.status, "running", "the row belongs to a live turn, not a corpse");
    assert.equal(reloaded.get("turn-live-in-process")?.endedAt, undefined, "and keeps no invented end");
    assert.equal(reloaded.get("turn-live-in-process")?.toolCallCount, 2);
  });
});

test("a turn with no recorded mark ends where it started rather than at boot", () => {
  withDir((_dir, file) => {
    rawFile(file, [
      {
        turnId: "turn-no-marks",
        agentId: "dev",
        reason: { kind: "manual" },
        startedAt: "2026-09-26T11:14:38.000Z",
        status: "running",
        liveTokens: 300,
      },
    ]);

    const tracker = new TurnTracker(filePersist(file));
    const rec = tracker.get("turn-no-marks")!;

    assert.equal(rec.endedAt, "2026-09-26T11:14:38.000Z", "an unknown end is a lower bound, not the boot instant");
    assert.equal(rec.durationMs, 0);
    assert.match(String(rec.error), /server restart/);
    assert.doesNotMatch(String(rec.error), /last activity/, "no mark to report, so none is claimed");
    assert.equal(rec.phases?.startedAt, Date.parse("2026-09-26T11:14:38.000Z"));
  });
});

test("no reader presents a closed row as running: neither recent turns nor the merged step view", () => {
  withDir((_dir, file) => {
    rawFile(file, [killedRow(), finishedRow()]);
    const tracker = new TurnTracker(filePersist(file));

    // What `GET /status.recentTurns`, `GET /turns` and `getRecentTurns` return.
    assert.equal(
      tracker.list().filter((t) => t.status === "running").length,
      0,
      "a finished seat must not read as working to an operator or a monitor",
    );

    // What `GET /steps` and `mesh_steps` return: the live tracker row wins over
    // the log-derived step, so this is the payload the dashboard's live view
    // reads its status from.
    const merged = mergeTurnSteps([], tracker.list()).find((s) => s.turnId === "turn-c6c9e58e5e7c4d34")!;
    assert.equal(merged.status, "blocked");
    assert.equal(merged.lifecycle, "IDLE", "nothing is THINKING once the row is closed");
    assert.equal(merged.endedAt, "2026-09-27T08:52:12.558Z");
  });
});
