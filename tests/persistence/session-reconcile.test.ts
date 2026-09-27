import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { bootstrapMesh, type MeshInstance } from "../../apps/mesh-server/src/index";
import { StubRuntime } from "../../packages/agent-runtime/src/index";
import type { AgentDefinition, AgentSession, MeshEvent, MeshOp, RuntimeContext } from "../../packages/protocol/src/index";
import { testConfigYaml } from "../helpers";

/**
 * `sessions.json` is a second, unreconciled record of something the log
 * already knows.
 *
 * It is written only by `FileSessionRegistry.record()` / `forget()`; `forget`
 * is called only from `resetMission`, and nothing ever rewrites the file from
 * the log or prunes it against the roster. The log, meanwhile, carries the
 * authoritative history: `session.rotated` names the session each seat moved
 * onto, and `agent.retired` says which seats are gone for good.
 *
 * The rotation write in the server's `onRotate` (see session-registry.test.ts)
 * closes the common case, but it is fire-and-forget: a failed write is caught
 * into the audit log and the file silently keeps the old row. So on boot the
 * file can disagree with the log, and the restart trusts the file. These tests
 * pin what the boot should do with such a disagreement.
 *
 * File mode on purpose: `makeMesh` forces `inMemory`, which has no registry.
 */

type Row = { agentId: string; sessionId: string; runtime: string; updatedAt: string };

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

class RestoreSpy extends StubRuntime {
  readonly restored: Array<{ agentId: string; sessionId: string }> = [];
  override async restoreSession(agent: AgentDefinition, sessionId: string, context: RuntimeContext): Promise<AgentSession | null> {
    this.restored.push({ agentId: agent.id, sessionId });
    return super.restoreSession(agent, sessionId, context);
  }
}

const done = async (): Promise<{ text: string; operations: MeshOp[] }> => ({ text: "ok", operations: [{ op: "done" } as MeshOp] });

function spy(ids: string[]): RestoreSpy {
  return new RestoreSpy({ scripts: new Map(ids.map((id) => [id, done])) });
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

function bed(agents: string[]): { dir: string; configPath: string; cleanup(): void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-session-recon-"));
  const configPath = path.join(dir, "mesh.yaml");
  fs.writeFileSync(
    configPath,
    testConfigYaml({ agents: agents.map((id) => ({ id, role: id, interests: [] })), mayContact: Object.fromEntries(agents.map((a) => [a, []])) }),
    "utf8",
  );
  return { dir, configPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const rowsOf = (m: MeshInstance): Row[] => {
  const file = path.join(m.config.stateDir, "sessions.json");
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Row[]) : [];
};

test(
  "a row older than the log's last session.rotated for that seat is not restored on boot",
  async () => {
    const b = bed(["dev"]);
    try {
      const first = await bootstrapMesh({ configPath: b.configPath, mode: "live", runtimeOverrides: { stub: spy(["dev"]) } });
      const stateDir = first.config.stateDir;
      let abandoned: Row;
      let rotated: MeshEvent;
      try {
        await first.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
        await settle(first);
        abandoned = rowsOf(first).find((r) => r.agentId === "dev")!;
        assert.ok(abandoned, "precondition: the seat's first session was recorded");

        const onRotate = (first.designerRuntime as unknown as { options: { onRotate?: (i: RotateInfo) => void } }).options.onRotate!;
        onRotate({
          agentId: "dev",
          meshSessionId: abandoned.sessionId,
          previousSdkSessionId: abandoned.sessionId,
          sdkSessionId: "sdk-live-2",
          contextTokens: 150000,
          turns: 12,
          rotations: 1,
          reason: "context_threshold",
        });
        const deadline = Date.now() + 5000;
        let evs: MeshEvent[] = [];
        while (!(evs = await first.store.read({ types: ["session.rotated"] })).length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
        rotated = evs[0];
        assert.ok(rotated, "precondition: the log records the rotation");
      } finally {
        await first.close();
      }

      // The rotation's registry write was lost (it is fire-and-forget; a
      // failure only reaches the audit log): the file still holds the
      // pre-rotation row, stamped BEFORE the rotation the log recorded.
      assert.ok(abandoned.updatedAt < rotated.timestamp, "precondition: the stale row predates the rotation event");
      fs.writeFileSync(path.join(stateDir, "sessions.json"), JSON.stringify([abandoned], null, 2), "utf8");

      const s = spy(["dev"]);
      const second = await bootstrapMesh({ configPath: b.configPath, mode: "live", runtimeOverrides: { stub: s } });
      try {
        await second.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
        await settle(second);
        const ids = s.restored.filter((r) => r.agentId === "dev").map((r) => r.sessionId);
        assert.ok(
          !ids.includes(abandoned.sessionId),
          `the log says dev left ${abandoned.sessionId} for sdk-live-2; restoring onto the abandoned transcript is the bug (restored: ${JSON.stringify(ids)})`,
        );
      } finally {
        await second.close();
      }
    } finally {
      b.cleanup();
    }
  },
);

test(
  "a retired seat's row is pruned from sessions.json by the next boot",
  async () => {
    const b = bed(["dev", "ghost"]);
    try {
      const first = await bootstrapMesh({ configPath: b.configPath, mode: "live", runtimeOverrides: { stub: spy(["dev", "ghost"]) } });
      try {
        await first.supervisor.activateAgent("ghost", { kind: "manual" }, { explicit: true });
        await settle(first);
        assert.ok(rowsOf(first).some((r) => r.agentId === "ghost"), "precondition: the seat's session was recorded");
        const r = await first.supervisor.retireAgent("ghost", { reason: "role no longer needed" });
        assert.equal(r.ok, true, `precondition: retire succeeded: ${r.reason}`);
        await settle(first);
        assert.equal(first.kernel.state.agents.get("ghost")?.state.lifecycle, "RETIRED");
      } finally {
        await first.close();
      }

      const second = await bootstrapMesh({ configPath: b.configPath, mode: "parked", runtimeOverrides: { stub: spy(["dev", "ghost"]) } });
      try {
        assert.equal(second.kernel.state.agents.get("ghost")?.state.lifecycle, "RETIRED", "precondition: the log still says retired");
        assert.deepEqual(
          rowsOf(second).filter((row) => row.agentId === "ghost"),
          [],
          "a seat the log retired for good must not keep a restorable session on disk",
        );
      } finally {
        await second.close();
      }
    } finally {
      b.cleanup();
    }
  },
);
