import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { DESIGNER_MCP_TOOLS, handleDesignerMcpRequest } from "../../apps/mesh-cli/src/designer-mcp";

async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = (await handleDesignerMcpRequest({
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name, arguments: args },
  })) as any;
  assert.equal(res.error, undefined, JSON.stringify(res.error));
  assert.equal(res.result.isError, false, res.result.content?.[0]?.text);
  return JSON.parse(res.result.content[0].text);
}

const VALID = {
  version: 1,
  mesh: { id: "designer-test", goal: "design a crew" },
  agents: { dev: { role: "developer", capabilities: [] } },
};

test("designer mcp: initialize handshake and tools/list expose exactly the designer tools", async () => {
  const init = (await handleDesignerMcpRequest({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })) as any;
  assert.equal(init.result.serverInfo.name, "mesh-designer");
  const listed = (await handleDesignerMcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" })) as any;
  assert.deepEqual(
    listed.result.tools.map((t: any) => t.name).sort(),
    DESIGNER_MCP_TOOLS.map((t) => t.name).sort(),
  );
  const unknown = (await handleDesignerMcpRequest({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "mesh_done", arguments: {} },
  })) as any;
  assert.equal(unknown.error.code, -32601, "mission ops must not be reachable from the designer server");
});

test("designer mcp: schema tool returns the mesh schema", async () => {
  const schema = await call("mesh_designer_schema");
  assert.ok(schema.properties?.agents, "mesh schema contains the agents section");
  assert.ok(schema.properties?.mesh, "mesh schema contains the mesh section");
});

test("designer mcp: vocabulary tool lists roles, authority tokens, review capabilities and gates", async () => {
  const vocab = await call("mesh_designer_vocabulary");
  assert.ok(vocab.roles.includes("developer"), `roles: ${vocab.roles.join(",")}`);
  assert.ok(vocab.roles.includes("tech-lead"));
  assert.ok(vocab.authorityTokens.includes("architecture.approve"));
  assert.ok(vocab.authorityTokens.includes("*"));
  assert.ok(vocab.gateKinds.includes("patch.merge"));
  assert.ok(vocab.reviewCapabilities.some((r: any) => r.capability === "code.review"));
});

test("designer mcp: validate accepts valid documents and reports schema and gate problems", async () => {
  const ok = await call("mesh_designer_validate", { config: VALID });
  assert.equal(ok.valid, true, JSON.stringify(ok.errors));
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.summary.meshId, "designer-test");

  const fromYaml = await call("mesh_designer_validate", {
    yaml: "version: 1\nmesh:\n  id: designer-test\n  goal: from yaml\nagents:\n  dev:\n    role: developer\n",
  });
  assert.equal(fromYaml.valid, true, JSON.stringify(fromYaml.errors));

  const gated = JSON.parse(JSON.stringify(VALID));
  gated.policies = { transitions: { "patch.merge": { requires: ["ghost.approve"] } } };
  const deadlock = await call("mesh_designer_validate", { config: gated });
  assert.equal(deadlock.valid, false);
  assert.ok(deadlock.errors.some((e: string) => e.includes("ghost")), `errors: ${deadlock.errors.join(" | ")}`);

  const broken = await call("mesh_designer_validate", { config: { version: 1 } });
  assert.equal(broken.valid, false);
  assert.ok(broken.errors.length > 0);
});

test("designer mcp: the compiled CLI serves tools over a real stdio pipe", async () => {
  const bin = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-cli", "bin", "mesh.mjs");
  const child = spawn(process.execPath, [bin, "designer-mcp"], { stdio: ["pipe", "pipe", "pipe"] });
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
  assert.equal(frames.length, 2, `frames: ${JSON.stringify(frames)}`);
  assert.equal(frames[0].result.serverInfo.name, "mesh-designer");
  assert.equal(frames[1].result.tools.length, DESIGNER_MCP_TOOLS.length);
});
