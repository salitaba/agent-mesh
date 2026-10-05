import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPermissionGate } from "../../packages/agent-runtime/src/index";

/**
 * The gate every runtime shares names the mesh's own tools two ways: as the Claude CLI does (`mcp__mesh__mesh_send`) and
 * bare, as a runtime that speaks the bus itself does (`mesh_send`). Both are the bus, and a seat that could not reach the bus
 * would not be a seat, so neither is ever gated. Nothing that merely looks like one is.
 */

const NO_CAPS = buildPermissionGate([]);

test("the bus tools are allowed to a seat that holds no capability, under either spelling", async () => {
  for (const name of ["mcp__mesh__mesh_send", "mesh_send", "mesh_artifact_read", "mesh_done"]) {
    assert.equal((await NO_CAPS(name, {})).behavior, "allow", name);
  }
});

test("a tool that only resembles a bus tool is not one", async () => {
  for (const name of ["meshy_tool", "Mesh_send", "my_mesh_send", "mcp__other__mesh_send", "mesh"]) {
    const decision = await NO_CAPS(name, {});
    assert.equal(decision.behavior, "deny", name);
    assert.match((decision as { message: string }).message, /is not available to curule agents/, name);
  }
});

test("a tool nobody mapped fails closed, whatever the seat holds", async () => {
  const all = buildPermissionGate(["repository.write", "shell.execute", "network.request"]);
  assert.equal((await all("Task", {})).behavior, "deny");
  assert.equal((await all("Agent", {})).behavior, "deny");
  assert.equal((await all("mcp__github__create_issue", {})).behavior, "deny");
});

test("the files a seat reads are open to it, and what it writes, runs or fetches is not, until a capability says so", async () => {
  for (const name of ["Read", "Glob", "Grep"]) assert.equal((await NO_CAPS(name, {})).behavior, "allow", name);
  for (const name of ["Write", "Edit", "Bash", "WebFetch"]) assert.equal((await NO_CAPS(name, {})).behavior, "deny", name);
  const dev = buildPermissionGate(["repository.write", "test.execute", "network.request"]);
  for (const name of ["Write", "Edit", "Bash", "WebFetch"]) assert.equal((await dev(name, {})).behavior, "allow", name);
});
