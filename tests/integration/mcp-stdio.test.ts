import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { makeMesh } from "../helpers";
import { createHttpServer } from "../../apps/mesh-server/src/index";

test("mcp bridge: the compiled CLI replies to initialize over a real stdio pipe when the bus is unreachable", async () => {
  const bin = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-cli", "bin", "mesh.mjs");
  const child = spawn(
    process.execPath,
    [bin, "mcp", "--agent", "dev", "--bus", "http://127.0.0.1:1", "--token", "mesh:dev:abcd"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const frames: any[] = [];
  let out = "";
  const finished = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out; frames so far: ${JSON.stringify(frames)}`));
    }, 15000);
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
      let idx: number;
      while ((idx = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, idx).trim();
        out = out.slice(idx + 1);
        if (line) frames.push(JSON.parse(line));
      }
      if (frames.length >= 1) child.stdin.end();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  await finished;
  assert.equal(frames.length, 1, `frames: ${JSON.stringify(frames)}`);
  assert.equal(frames[0].id, 1);
  assert.match(String(frames[0].error?.message), /unreachable/);
});

test("mcp bridge: --read-only reaches the bus and exposes only observability tools", async () => {
  const m = await makeMesh({ agents: [{ id: "dev", role: "developer", capabilities: [], interests: [] }], mayContact: { dev: [] } });
  const server = createHttpServer(m, { dashboardDir: undefined });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const bin = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-cli", "bin", "mesh.mjs");
  const child = spawn(
    process.execPath,
    [bin, "mcp", "--agent", "human", "--token", "human-local", "--read-only", "--bus", `http://127.0.0.1:${port}`],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const frames: any[] = [];
  let out = "";
  const finished = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out; frames so far: ${JSON.stringify(frames)}`));
    }, 15000);
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
      let idx: number;
      while ((idx = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, idx).trim();
        out = out.slice(idx + 1);
        if (line) frames.push(JSON.parse(line));
      }
      if (frames.length >= 2) child.stdin.end();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
  await finished;
  try {
    const list = frames.find((f) => f.id === 2);
    assert.ok(list, `no tools/list reply; frames: ${JSON.stringify(frames)}`);
    assert.deepEqual(
      list.result.tools.map((t: { name: string }) => t.name).sort(),
      ["mesh_agent_activity", "mesh_failures", "mesh_query_events", "mesh_run_digest", "mesh_run_status", "mesh_steps"],
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await m.cleanup();
  }
});
