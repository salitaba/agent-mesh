import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer, type ServerHandle } from "../../apps/mesh-server/src/index";
import { StubRuntime } from "../../packages/agent-runtime/src/index";
import { testConfigYaml, waitFor } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * `startServer` binds its port BEFORE the mesh boots, so the first wake already
 * knows the URL the seats' MCP bridge will be spawned against.
 *
 * The bridge URL is not knowable before `listen()`: a child of the multi-project
 * host asks the OS for port 0, so the configured port in `mesh.yaml` is not the
 * port the child ends up on. Booted the other way round — which is what this
 * server did until 2026-09-27 — the first seat of a live boot (and of every child
 * restart) spawned a bridge against a URL nothing answered, spent the adapter's
 * whole respawn ladder on it, and lost the turn. Measured: the child's bridge
 * stayed unreachable for more than 35 seconds after a restart.
 *
 * `bootstrapMesh`/`createHttpServer` users (most of this suite) keep their own
 * ordering; this pins the one path that has a listener to be ready for.
 */

const DEV = { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] };

test("startServer: the first wake is handed the port the server actually bound", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-bridge-order-"));
  const configPath = path.join(dir, "mesh.yaml");
  fs.writeFileSync(configPath, testConfigYaml({ agents: [DEV], mayContact: { dev: [] }, startup: ["dev"] }), "utf8");
  const rt = new StubRuntime({
    scripts: new Map([["dev", (): { operations: MeshOp[] } => ({ operations: [{ op: "wait" } as MeshOp] })]]),
  });
  let handle: ServerHandle | undefined;
  try {
    handle = await startServer({
      configPath,
      inMemory: true,
      gitMode: "off",
      host: "127.0.0.1",
      // Port 0: the URL exists only after `listen()`, which is precisely the
      // window a child restart lands in.
      port: 0,
      mode: "live",
      runtimeOverrides: { stub: rt },
    });
    assert.notEqual(handle.port, handle.instance.config.server.port, "fixture: the bound port is not the configured one");
    await waitFor("the startup turn to start", () => rt.startContextsFor("dev").length > 0);
    const context = rt.startContextsFor("dev")[0]!;
    assert.equal(
      context.busUrl,
      handle.url,
      "the seat's bridge points at the bound port — not the configured one, and not at nothing",
    );
    assert.equal(process.env.MESH_BUS_URL, handle.url, "and the env every later turn reads agrees");
  } finally {
    await handle?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
