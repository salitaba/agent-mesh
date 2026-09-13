import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfig } from "../../packages/config/src/index";
import { DEFAULT_HARD_CAPABILITIES } from "../../packages/protocol/src/index";

function meshWith(defaults: string, agent: string): string {
  const yaml = `version: 1
mesh:
  id: hatest
  goal: |
    Test hard actions.
${defaults}agents:
  dev:
    role: developer
    runtime: stub
    capabilities: [repository.write, git.commit, git.merge]
${agent}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-ha-"));
  const file = path.join(dir, "mesh.yaml");
  fs.writeFileSync(file, yaml);
  return file;
}

const load = (defaults: string, agent = "") => resolveConfig(meshWith(defaults, agent)).agents.dev!;

test("hard actions: absent everywhere resolves to off — an untouched mesh is unchanged", () => {
  const dev = load("");
  assert.equal(dev.hardActions!.mode, "off");
});

test("hard actions: mesh.defaults reaches every agent", () => {
  const dev = load(`  defaults:\n    hard_actions: { mode: enforce }\n`);
  assert.equal(dev.hardActions!.mode, "enforce");
  assert.deepEqual(dev.hardActions!.capabilities, DEFAULT_HARD_CAPABILITIES);
});

test("hard actions: an agent override beats mesh.defaults in both directions", () => {
  const on = load(`  defaults:\n    hard_actions: { mode: off }\n`, `    hard_actions: { mode: enforce }\n`);
  assert.equal(on.hardActions!.mode, "enforce", "an agent must be able to opt IN against a permissive default");
  const off = load(`  defaults:\n    hard_actions: { mode: enforce }\n`, `    hard_actions: { mode: off }\n`);
  assert.equal(off.hardActions!.mode, "off", "and opt OUT against a strict one");
});

test("hard actions: an explicitly empty capability list is not replaced by the default", () => {
  // The resolution chain uses ?? rather than ||, so an operator who writes
  // `capabilities: []` gets exactly that — not the five-token default back.
  const dev = load("", `    hard_actions: { mode: warn, capabilities: [] }\n`);
  assert.deepEqual(dev.hardActions!.capabilities, []);
});

test("hard actions: an unknown capability token is a load error, not a silent no-op", () => {
  assert.throws(
    () => load("", `    hard_actions: { mode: enforce, capabilities: [repository.wrte] }\n`),
    /unknown hard_actions capability/,
    "a typo here boots fine and the gate then never fires for what the operator meant to protect",
  );
});

test("hard actions: capabilities no mesh op can see are warned about, not rejected", () => {
  const warnings = resolveConfig(meshWith("", `    hard_actions: { mode: enforce, capabilities: [shell.execute] }\n`)).warnings;
  assert.ok(
    warnings.some((w) => /plan gate will never fire/.test(w)),
    `shell.execute is a legal token spent outside the op layer; expected a warning, got: ${warnings.join(" | ")}`,
  );
});

test("hard actions: mode off warns about nothing", () => {
  const warnings = resolveConfig(meshWith("", `    hard_actions: { mode: off, capabilities: [shell.execute] }\n`)).warnings;
  assert.deepEqual(warnings.filter((w) => /plan gate/.test(w)), []);
});
