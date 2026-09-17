import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfig } from "../../packages/config/src/index";

/**
 * `requires_approval` is the only capability knob that can be set and still do
 * nothing, because it narrows a grant rather than making one. These cover the
 * two ways that goes wrong: inheritance dropping it, and an author gating a
 * capability the seat was never given.
 */
function resolveRaw(text: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-approval-test-"));
  fs.writeFileSync(path.join(dir, "mesh.yaml"), text, "utf8");
  try {
    return resolveConfig(path.join(dir, "mesh.yaml"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const mesh = (runtimeExtra: string, devExtra: string): string => `version: 1
mesh:
  id: approvaltest
  goal: |
    Test.
  workspace: { path: ./workspace }
  runtime: { default: stub${runtimeExtra} }
agents:
  dev:
    role: developer
    capabilities:
      - repository.write
      - shell.execute
    authority: []
${devExtra}
`;

test("a seat inherits the mesh-wide requires_approval default", () => {
  const cfg = resolveRaw(mesh(", requires_approval: [repository.write]", ""));
  assert.deepEqual(cfg.agents.dev.requiresApproval, ["repository.write"]);
});

test("a seat's own requires_approval replaces the mesh default", () => {
  const cfg = resolveRaw(
    mesh(", requires_approval: [repository.write]", "    requires_approval:\n      - shell.execute"),
  );
  assert.deepEqual(cfg.agents.dev.requiresApproval, ["shell.execute"]);
});

test("requires_approval normalizes aliases the way capabilities do", () => {
  // Otherwise `api.write` would gate nothing while looking like it gates edits:
  // the gate compares against capabilities, which are already canonical.
  const cfg = resolveRaw(mesh("", "    requires_approval:\n      - api.write\n      - test.run"));
  assert.deepEqual([...(cfg.agents.dev.requiresApproval ?? [])].sort(), ["repository.write", "test.execute"]);
});

test("a mesh with no requires_approval leaves the field unset", () => {
  // Absent must stay absent rather than becoming [], so the runtime can tell
  // "no gate configured" from "gate configured but empty".
  const cfg = resolveRaw(mesh("", ""));
  assert.equal(cfg.agents.dev.requiresApproval, undefined);
});

test("gating a capability the seat does not hold warns instead of passing silently", () => {
  const cfg = resolveRaw(mesh("", "    requires_approval:\n      - network.request"));
  const hit = cfg.warnings.find((w) => w.includes("requires_approval"));
  assert.ok(hit, `expected an ungranted-gate warning, got ${JSON.stringify(cfg.warnings)}`);
  assert.match(hit, /network\.request/);
  assert.match(hit, /does not hold/);
});

test("gating a capability the seat holds is silent", () => {
  const cfg = resolveRaw(mesh("", "    requires_approval:\n      - repository.write"));
  assert.deepEqual(
    cfg.warnings.filter((w) => w.includes("requires_approval")),
    [],
  );
});
