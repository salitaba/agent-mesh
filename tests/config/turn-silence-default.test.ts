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

test("turn_silence_ms is a flat five minutes, independent of the turn timeout", () => {
  // It used to be `min(120s, max(60s, turn_timeout/2))`, and the coupling ran the
  // wrong way: a mesh that raised its turn timeout BECAUSE its turns do long work
  // got a tighter silence floor, not a looser one. With `turn_timeout_ms:
  // 1200000` it pinned at the 120s cap and one live run lost ten turns — 45
  // minutes of generation — every one a seat that narrated early then worked
  // quietly.
  //
  // The old comment's real argument was that half of a long timeout pushes
  // detection out to ten minutes, by which point the stall is already a human
  // escalation. A flat five minutes keeps that, and is longer than any quiet
  // stretch a healthy turn showed.
  assert.equal(resolveWith("").scheduling.turnSilenceMs, 300000);
  for (const t of [20000, 100000, 600000, 1200000, 2400000]) {
    assert.equal(
      resolveWith(`turn_timeout_ms: ${t}`).scheduling.turnSilenceMs,
      300000,
      `turn_timeout_ms ${t} must not move the silence floor`,
    );
  }
});

test("turn_silence_ms accepts an explicit value and clears the schema", () => {
  assert.equal(
    resolveWith("turn_timeout_ms: 600000, turn_silence_ms: 45000").scheduling.turnSilenceMs,
    45000,
  );
});