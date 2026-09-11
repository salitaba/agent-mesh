import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as path from "node:path";

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
