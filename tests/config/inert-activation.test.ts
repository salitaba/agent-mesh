import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfig } from "../../packages/config/src/index";

/**
 * The whole `scheduling.activation` block is accepted and inert. Nothing reads
 * either key: `scheduling.triage.mode` alone decides whether the router pass
 * runs, and activations are never delayed.
 *
 * Both keys are kept in the schema on purpose — the block is
 * `additionalProperties: false`, so removing a property would reject every
 * config that sets it, including everything `mesh init` has ever written. These
 * tests pin what makes "accept and warn" safe rather than sloppy: the warnings
 * fire when an author states a key, they stay silent otherwise, each carries
 * its own remedy, and the resolved config exposes neither field for a future
 * reader to start trusting again.
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

const delayWarning = (warnings: string[]): string | undefined =>
  warnings.find((w) => w.includes("scheduling.activation.max_activation_delay_ms"));

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

test("an explicitly set activation delay warns, and is told there is no substitute", () => {
  const resolved = resolveRaw(mesh(`  activation:
    max_activation_delay_ms: 250
`));
  const w = delayWarning(resolved.warnings);
  assert.ok(w, "setting an inert delay must not pass in silence");
  assert.match(w, /inert/);
  assert.match(w, /250/, "must carry the value the author set");
  assert.match(w, /no other key delays them/, "the remedy is removal, not redirection");
  // The distinction worth keeping: strategy's remedy points at another key,
  // this one points at nothing, because the behaviour was never built. Copy
  // that offered a substitute here would send the operator hunting for one.
  assert.doesNotMatch(w, /triage\.mode/);
});

test("a config that omits the delay is silent", () => {
  const resolved = resolveRaw(mesh(`  concurrency:
    max_active_agents: 4
`));
  assert.equal(delayWarning(resolved.warnings), undefined);
});

test("both inert keys warn separately when both are set", () => {
  const resolved = resolveRaw(mesh(`  activation:
    strategy: interest+triage
    max_activation_delay_ms: 100
`));
  // One warning per key, not one merged sentence: the remedies differ, and a
  // combined message would have to drop one of them.
  assert.ok(strategyWarning(resolved.warnings));
  assert.ok(delayWarning(resolved.warnings));
});

test("the resolved config exposes neither inert field", () => {
  const resolved = resolveRaw(mesh(`  activation:
    strategy: interest+triage
    max_activation_delay_ms: 250
`));
  // Deleted along with each key's last reader. If either comes back, a
  // consumer can start branching on it again and the false affordance returns
  // with it.
  const sched = resolved.scheduling as unknown as Record<string, unknown>;
  assert.equal(sched.strategy, undefined);
  assert.equal(sched.maxActivationDelayMs, undefined);
});
