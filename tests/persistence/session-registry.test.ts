import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FileSessionRegistry } from "../../packages/persistence/src/index";
import { bootstrapMesh, type MeshInstance } from "../../apps/mesh-server/src/index";
import { StubRuntime } from "../../packages/agent-runtime/src/index";
import type { AgentDefinition, AgentSession, MeshOp, RuntimeContext } from "../../packages/protocol/src/index";
import { testConfigYaml } from "../helpers";

/**
 * `sessions.json` is what a restart resumes from.
 *
 * It had exactly one writer — the first time a seat's session was created — and
 * rotation never touched it. So the file kept each seat's FIRST session for the
 * life of the mission while the live session moved on: measured on a run of
 * 2026-09-24, six of seven seats were stale, one of them eight rotations behind.
 *
 * That is not cosmetic, because this file is the restart's only source (the
 * in-memory `sessionMap` is never written). When a turn timed out, the restart
 * read this registry, "restored" a transcript the seat had abandoned five
 * rotations earlier, and stamped the stale id with a fresh `updatedAt` — which
 * made it look current.
 *
 * These tests pin the contract the rotation fix depends on: `record` is an
 * upsert, so writing on every rotation keeps one row per seat holding the live
 * id, and `lookup` — the call the restart makes — returns that id and not the
 * first one.
 */

function tmpRegistry(): { dir: string; reg: FileSessionRegistry; rows: () => Array<{ agentId: string; sessionId: string }> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-session-reg-"));
  return {
    dir,
    reg: new FileSessionRegistry(dir),
    rows: () => JSON.parse(fs.readFileSync(path.join(dir, "sessions.json"), "utf8")),
  };
}

test("rotation overwrites the seat's row rather than appending one", async () => {
  const { dir, reg, rows } = tmpRegistry();
  try {
    await reg.record("tech-lead", "session-1", "claude");
    // Six rotations, which is what one measured seat did inside 80 minutes.
    for (const n of [2, 3, 4, 5, 6, 7]) await reg.record("tech-lead", `session-${n}`, "claude");

    assert.equal(rows().length, 1, "one row per seat: a rotation replaces, it does not accumulate");
    assert.equal(rows()[0].sessionId, "session-7", "and the row holds the session the seat is actually on");
    assert.deepEqual(await reg.lookup("tech-lead"), { sessionId: "session-7", runtime: "claude" }, "which is what a restart reads");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a restart on a fresh process reads the rotated id from disk, not the first one", async () => {
  // The failure was observed across a restart, so the round trip through the file
  // is the part that matters: a second registry object over the same state dir
  // must see the last write.
  const { dir, reg, rows } = tmpRegistry();
  try {
    await reg.record("architect", "6e8942fd", "claude");
    await reg.record("architect", "14918c00", "claude");
    void rows;

    const afterRestart = new FileSessionRegistry(dir);
    assert.deepEqual(
      await afterRestart.lookup("architect"),
      { sessionId: "14918c00", runtime: "claude" },
      "restoring the pre-rotation transcript is the bug this prevents",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("seats do not overwrite each other", async () => {
  const { dir, reg, rows } = tmpRegistry();
  try {
    await reg.record("pm", "pm-1", "claude");
    await reg.record("architect", "arch-1", "claude");
    await reg.record("pm", "pm-2", "claude");

    assert.equal(rows().length, 2);
    assert.equal((await reg.lookup("pm"))?.sessionId, "pm-2");
    assert.equal((await reg.lookup("architect"))?.sessionId, "arch-1", "one seat's rotation must not disturb another's");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reload drops the cache so a replaced state dir is not read through", async () => {
  // Restore swaps the state dir underneath a live registry, and the default is to
  // DROP `sessions.json` — the ids in it point at runtimes on the far side of the
  // reset. A rotation write goes through the same in-memory map, so it must not
  // defeat that.
  const { dir, reg } = tmpRegistry();
  try {
    await reg.record("dev", "before", "claude");
    fs.rmSync(path.join(dir, "sessions.json"), { force: true });

    assert.equal((await reg.lookup("dev"))?.sessionId, "before", "the cache still answers until told otherwise");
    reg.reload();
    assert.equal(await reg.lookup("dev"), null, "after a reload the dropped file means no restorable session");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The tests above pin `FileSessionRegistry.record` as an upsert. They would all
// have passed on the server that had the bug: the defect was never in the
// registry, it was that the server's `onRotate` hook did not call it. The test
// below goes through that hook — the one `bootstrapMesh` hands the Claude
// adapter — so it fails if the call is dropped again, and it follows the id to
// the only consumer that matters: the restore on the next boot.
// ---------------------------------------------------------------------------

type RotateInfo = {
  agentId: string;
  meshSessionId: string;
  previousSdkSessionId: string;
  sdkSessionId: string;
  contextTokens: number;
  turns: number;
  rotations: number;
  reason: string;
};

/** A stub that records which session id each seat is restored onto. */
class RestoreSpy extends StubRuntime {
  readonly restored: Array<{ agentId: string; sessionId: string }> = [];
  override async restoreSession(agent: AgentDefinition, sessionId: string, context: RuntimeContext): Promise<AgentSession | null> {
    this.restored.push({ agentId: agent.id, sessionId });
    return super.restoreSession(agent, sessionId, context);
  }
}

async function settle(m: MeshInstance, timeoutMs = 10000): Promise<void> {
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
  throw new Error("timeout waiting for the mesh to settle");
}

test("server rotation path: onRotate persists the new sdk id, and the next boot restores onto it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-session-rot-"));
  try {
    const configPath = path.join(dir, "mesh.yaml");
    fs.writeFileSync(configPath, testConfigYaml({ agents: [{ id: "dev", role: "developer", interests: [] }], mayContact: { dev: [] } }), "utf8");
    const done = async (): Promise<{ text: string; operations: MeshOp[] }> => ({ text: "ok", operations: [{ op: "done" } as MeshOp] });

    const first = await bootstrapMesh({ configPath, mode: "live", runtimeOverrides: { stub: new RestoreSpy({ scripts: new Map([["dev", done]]) }) } });
    let firstSession: string;
    try {
      // A real first session, recorded by `ensureSession` the ordinary way.
      await first.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
      await settle(first);
      const file = path.join(first.config.stateDir, "sessions.json");
      firstSession = (JSON.parse(fs.readFileSync(file, "utf8")) as Array<{ agentId: string; sessionId: string }>).find((r) => r.agentId === "dev")!.sessionId;
      assert.ok(firstSession, "precondition: the seat's first session is on disk");

      // The Claude adapter's rotation callback, exactly as bootstrapMesh wired it.
      const onRotate = (first.designerRuntime as unknown as { options: { onRotate?: (i: RotateInfo) => void } }).options.onRotate;
      assert.ok(onRotate, "precondition: bootstrapMesh wires onRotate into the Claude adapter");
      onRotate!({
        agentId: "dev",
        meshSessionId: firstSession,
        previousSdkSessionId: firstSession,
        sdkSessionId: "sdk-rotated-2",
        contextTokens: 150000,
        turns: 12,
        rotations: 1,
        reason: "context_threshold",
      });
      // The event is fire-and-forget; wait for it so the log and the file are
      // compared at the same moment.
      const deadline = Date.now() + 5000;
      while (!(await first.store.read({ types: ["session.rotated"] })).length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      assert.equal((await first.store.read({ types: ["session.rotated"] })).length, 1, "the rotation is announced on the log");

      const rows = JSON.parse(fs.readFileSync(file, "utf8")) as Array<{ agentId: string; sessionId: string }>;
      assert.deepEqual(
        rows.filter((r) => r.agentId === "dev").map((r) => r.sessionId),
        ["sdk-rotated-2"],
        "sessions.json must hold the session the seat rotated ONTO, as its only row",
      );
    } finally {
      await first.close();
    }

    // The consumer: a restart restores the seat onto whatever the file says.
    const spy = new RestoreSpy({ scripts: new Map([["dev", done]]) });
    const second = await bootstrapMesh({ configPath, mode: "live", runtimeOverrides: { stub: spy } });
    try {
      await second.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
      await settle(second);
      const ids = spy.restored.filter((r) => r.agentId === "dev").map((r) => r.sessionId);
      assert.ok(ids.length > 0, "precondition: the persistent seat was restored, not started fresh");
      assert.equal(ids[0], "sdk-rotated-2", `the restart must resume the live transcript, not the abandoned ${firstSession}`);
    } finally {
      await second.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
