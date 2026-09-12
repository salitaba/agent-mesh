import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfig } from "../../packages/config/src/index";

const MINIMAL = `version: 1
mesh:
  id: cfgtest
  goal: |
    Test.
  acceptance_criteria:
    - { id: ship, description: "done", mandatory: true }
  workspace: { path: ./workspace }
  runtime: { default: stub }
agents:
  a: { role: worker, capabilities: [], authority: [] }
`;

function resolveWith(timeouts: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-config-test-"));
  fs.writeFileSync(
    path.join(dir, "mesh.yaml"),
    `${MINIMAL}${timeouts ? `scheduling:\n  timeouts: { ${timeouts} }\n` : ""}`,
    "utf8",
  );
  try {
    return resolveConfig(path.join(dir, "mesh.yaml"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("turn_silence_ms defaults to half the turn timeout, capped at two minutes and never below a minute", () => {
  assert.equal(resolveWith("").scheduling.turnSilenceMs, 120000);
  assert.equal(resolveWith("turn_timeout_ms: 2400000").scheduling.turnSilenceMs, 120000);
  assert.equal(resolveWith("turn_timeout_ms: 100000").scheduling.turnSilenceMs, 60000);
  assert.equal(resolveWith("turn_timeout_ms: 20000").scheduling.turnSilenceMs, 60000);
});

test("turn_silence_ms accepts an explicit value and clears the schema", () => {
  assert.equal(
    resolveWith("turn_timeout_ms: 600000, turn_silence_ms: 45000").scheduling.turnSilenceMs,
    45000,
  );
});