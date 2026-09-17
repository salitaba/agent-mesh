import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfig } from "../../packages/config/src/index";

/**
 * `scheduling.activation.strategy` is accepted and inert: nothing reads it, and
 * `scheduling.triage.mode` alone decides whether the router pass runs.
 *
 * The key is kept in the schema on purpose — the activation block is
 * `additionalProperties: false`, so removing it would reject every config
 * `mesh init` has ever written. These tests pin the three things that make
 * "accept and warn" safe rather than sloppy: the warning fires when an author
 * states the key, it stays silent otherwise, and the resolved config carries no
 * `strategy` field for a future reader to start trusting again.
 */
function resolveRaw(text: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-strategy-test-"));
  fs.writeFileSync(path.join(dir, "mesh.yaml"), text, "utf8");
  try {
    return resolveConfig(path.join(dir, "mesh.yaml"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const mesh = (schedulingExtra: string): string => `version: 1
mesh:
  id: strategytest
  goal: |
    Test.
  workspace: { path: ./workspace }
  runtime: { default: stub }
agents:
  dev:
    role: developer
    capabilities:
      - repository.write
    authority: []
startup:
  activate: [dev]
scheduling:
  mode: event-driven
${schedulingExtra}`;

const strategyWarning = (warnings: string[]): string | undefined =>
  warnings.find((w) => w.includes("scheduling.activation.strategy"));

test("an explicitly set strategy warns, and the warning names the key that actually decides", () => {
  const resolved = resolveRaw(mesh(`  activation:
    strategy: interest+triage
`));
  const w = strategyWarning(resolved.warnings);
  assert.ok(w, "setting an inert switch must not pass in silence");
  // The four copy moves: the condition in the operator's words, the live
  // values, what will not help, and where the real remedy lives.
  assert.match(w, /inert/);
  assert.match(w, /interest\+triage/, "must carry the value the author set");
  assert.match(w, /scheduling\.triage\.mode/, "must name the key that does the work");
  assert.match(w, /'off'/, "must carry the live triage mode, not a generic hint");
  assert.match(w, /triage\.mode: heuristic/, "must name the remedy");
});

test("the warning reports the live triage mode, so the remedy sentence stays true", () => {
  const resolved = resolveRaw(mesh(`  activation:
    strategy: interest
  triage:
    mode: heuristic
    rules: []
`));
  const w = strategyWarning(resolved.warnings);
  assert.ok(w);
  assert.match(w, /'heuristic'/, "an operator who already enabled triage must not be told it is off");
});

test("a config that omits the key is silent — mesh init output must never warn", () => {
  const resolved = resolveRaw(mesh(`  concurrency:
    max_active_agents: 4
`));
  assert.equal(
    strategyWarning(resolved.warnings),
    undefined,
    "the default carries no claim, so there is nothing to correct",
  );
});

test("the resolved config exposes no strategy field", () => {
  const resolved = resolveRaw(mesh(`  activation:
    strategy: interest+triage
`));
  // Deleted along with the raw key's last reader. If this comes back, a
  // consumer can start branching on it again and the two-switch problem
  // returns with it.
  assert.equal(
    (resolved.scheduling as unknown as Record<string, unknown>).strategy,
    undefined,
  );
});
