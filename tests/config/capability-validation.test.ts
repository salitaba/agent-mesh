import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigError, resolveConfig } from "../../packages/config/src/index";

function meshWithCaps(caps: string[]): string {
  return `version: 1
mesh:
  id: captest
  goal: |
    Test.
  workspace: { path: ./workspace }
  runtime: { default: stub }
agents:
  dev:
    role: developer
    capabilities:
${caps.map((c) => `      - ${c}`).join("\n")}
    authority: []
`;
}

function resolveRaw(text: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-cap-test-"));
  fs.writeFileSync(path.join(dir, "mesh.yaml"), text, "utf8");
  try {
    return resolveConfig(path.join(dir, "mesh.yaml"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("legacy capability aliases normalize to canonical tokens at load", () => {
  const cfg = resolveRaw(meshWithCaps(["api.write", "ui.write", "test.run"]));
  assert.deepEqual(
    [...cfg.agents.dev.capabilities].sort(),
    ["repository.write", "test.execute"],
    "api.write/ui.write become repository.write, test.run becomes test.execute",
  );
});

test("canonical capability names pass through unchanged", () => {
  const cfg = resolveRaw(meshWithCaps(["repository.read", "repository.write", "git.commit"]));
  assert.deepEqual([...cfg.agents.dev.capabilities].sort(), ["git.commit", "repository.read", "repository.write"]);
});

test("unknown capability names fail config load instead of silently granting nothing", () => {
  assert.throws(
    () => resolveRaw(meshWithCaps(["repository.writ"])),
    (err: unknown) => {
      assert.ok(err instanceof ConfigError, `expected ConfigError, got ${String(err)}`);
      assert.match(String((err as Error).message), /unknown capability 'repository\.writ'/);
      return true;
    },
  );
});
