import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bootstrapMesh, type MeshInstance } from "../../apps/mesh-server/src/index";
import { StubRuntime } from "../../packages/agent-runtime/src/index";
import { testConfigYaml, waitFor } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * The first live wake is gated on the mesh MCP bridge being reachable.
 *
 * The bridge is a process the seat's SDK spawns at `init`, pointed at the
 * server's `/internal/mcp/:agent`. Nothing in its URL is knowable before that
 * server listens — and for a child of the multi-project host, which asks the OS
 * for port 0, the configured fallback is not even the right PORT. A wake in that
 * window spawns a bridge at a URL nothing answers, spends the adapter's whole
 * respawn ladder (5 spawns, 30s) on it, and loses the turn: measured 2026-09-27,
 * more than 35 seconds of an unreachable bridge after a child restart, one lost
 * turn each time.
 *
 * So `boot` can be handed a readiness probe and holds the first live wake on it.
 * These tests pin both halves of the contract: nothing wakes while the probe is
 * pending, and a probe that never resolves cannot wedge a mission — the mesh
 * starts, activation proceeds, and the audit line says it waited.
 *
 * The wiring that matters in production is in `startServer` (see
 * tests/server/boot-bridge-order.test.ts): it binds the port through
 * `beforeInitialActivation` so boot cannot wake anyone before the bridge route
 * is answering, and hands boot a probe that reports the wait honestly.
 */

const DEV = { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] };
const WAIT_OP = { operations: [{ op: "wait" } as MeshOp] };

/** A config on disk whose one seat is activated by the boot itself. */
function bed(): { dir: string; configPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-bridge-gate-"));
  const configPath = path.join(dir, "mesh.yaml");
  fs.writeFileSync(configPath, testConfigYaml({ agents: [DEV], mayContact: { dev: [] }, startup: ["dev"] }), "utf8");
  return { dir, configPath };
}

/** The supervisor's audit trail, or "" when this mesh never wrote one. */
function auditOf(m: MeshInstance): string {
  const file = path.join(m.config.stateDir, "logs", "turn-audit.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}

test("boot: no seat wakes while the readiness probe is pending", async () => {
  const { dir, configPath } = bed();
  // The probe and the turn both write to one timeline, so the assertion is about
  // ORDER rather than about two independently observed facts.
  const timeline: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const rt = new StubRuntime({
    scripts: new Map([
      [
        "dev",
        (): { operations: MeshOp[] } => {
          timeline.push("turn");
          return WAIT_OP;
        },
      ],
    ]),
  });
  let m: MeshInstance | undefined;
  let booting: Promise<MeshInstance> | undefined;
  try {
    booting = bootstrapMesh({
      configPath,
      inMemory: true,
      mode: "live",
      runtimeOverrides: { stub: rt },
      bridgeReady: async () => {
        timeline.push("probe");
        await gate;
        timeline.push("ready");
      },
    });
    await waitFor("the boot to reach the probe", () => timeline.includes("probe"));
    // A real window, not a tick. The boot is live: the scheduler's pump, the
    // stall watchdog and the startup activation are all downstream of the gate,
    // so anything that starts a turn would land in these 150ms.
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(timeline, ["probe"], "a seat woken now would spawn its bridge at a URL nothing answers");
    release();
    m = await booting;
    await waitFor("the startup turn", () => timeline.includes("turn"));
    assert.deepEqual(timeline, ["probe", "ready", "turn"], "the wake follows the bridge, and only then");
  } finally {
    release();
    await booting?.catch(() => undefined);
    await m?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("boot: a probe that never resolves is bounded, and the boot says it waited", async () => {
  const { dir, configPath } = bed();
  let woke = false;
  const rt = new StubRuntime({
    scripts: new Map([
      [
        "dev",
        (): { operations: MeshOp[] } => {
          woke = true;
          return WAIT_OP;
        },
      ],
    ]),
  });
  let m: MeshInstance | undefined;
  try {
    m = await bootstrapMesh({
      configPath,
      mode: "live",
      gitMode: "off",
      runtimeOverrides: { stub: rt },
      // Never resolves: the mesh must start anyway rather than hang on a bridge
      // that is not coming up.
      bridgeReady: () => new Promise<void>(() => undefined),
      bridgeReadyTimeoutMs: 25,
    });
    await waitFor("the activation to proceed without the bridge", () => woke);
    const audit = auditOf(m);
    assert.match(
      audit,
      /bridge readiness: the mesh MCP bridge did not report ready within 25ms \(waited \d+\.\ds\) — activating anyway/,
      `the audit line names the bound it hit and how long it waited:\n${audit}`,
    );
  } finally {
    await m?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("boot: the audit line names how long a wake waited for the bridge", async () => {
  const { dir, configPath } = bed();
  let woke = false;
  const rt = new StubRuntime({
    scripts: new Map([
      [
        "dev",
        (): { operations: MeshOp[] } => {
          woke = true;
          return WAIT_OP;
        },
      ],
    ]),
  });
  let m: MeshInstance | undefined;
  try {
    m = await bootstrapMesh({
      configPath,
      mode: "live",
      gitMode: "off",
      runtimeOverrides: { stub: rt },
      // Late rather than absent: the point of the line is that a wait can be
      // told apart from a normal boot.
      bridgeReady: () => new Promise<void>((resolve) => setTimeout(resolve, 120)),
      bridgeReadyTimeoutMs: 5000,
    });
    await waitFor("the startup turn", () => woke);
    const line = auditOf(m)
      .split("\n")
      .find((l) => l.includes("scheduler live after waiting"));
    assert.ok(line, `the boot reports the wait it did:\n${auditOf(m)}`);
    const secs = Number(/waiting ([\d.]+)s for the mesh MCP bridge/.exec(line!)?.[1]);
    assert.ok(Number.isFinite(secs), `the line carries the figure: ${line}`);
    assert.ok(secs >= 0.1, `and it is the real wait, not a rounded-away zero: ${line}`);
  } finally {
    await m?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("boot: with no probe supplied the boot is what it always was", async () => {
  // The negative control, and the one the in-memory and stub beds of this suite
  // depend on: no probe means no wait, no bridge line, nothing said about a
  // bridge that was never asked about.
  const { dir, configPath } = bed();
  let woke = false;
  const rt = new StubRuntime({
    scripts: new Map([
      [
        "dev",
        (): { operations: MeshOp[] } => {
          woke = true;
          return WAIT_OP;
        },
      ],
    ]),
  });
  let m: MeshInstance | undefined;
  try {
    const startedAt = Date.now();
    m = await bootstrapMesh({ configPath, mode: "live", gitMode: "off", runtimeOverrides: { stub: rt } });
    await waitFor("the startup turn", () => woke);
    assert.ok(Date.now() - startedAt < 2000, "a mesh with no bridge on it waits for nothing");
    assert.doesNotMatch(auditOf(m), /mesh MCP bridge/, "and says nothing about one");
  } finally {
    await m?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
