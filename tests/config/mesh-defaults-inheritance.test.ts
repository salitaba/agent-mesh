import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfig } from "../../packages/config/src/index";

/* mesh-wide defaults with every inheritable key set to something other than the
   hardcoded fallback, so a test that passes by accident cannot look like a pass. */
const MESH_DEFAULTS = `  defaults:
    session:    { persistent: false, max_context_tokens: 120000 }
    delegation: { allow: true, max_depth: 2, max_workers: 3, worker_budget_tokens: 60000 }
`;

function meshWith(defaults: string, agent: string): string {
  return `version: 1
mesh:
  id: cfgtest
  goal: |
    Test.
  workspace: { path: ./workspace }
  runtime: { default: stub }
${defaults}agents:
  a: { role: worker${agent} }
`;
}

function resolveRaw(text: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-defaults-test-"));
  fs.writeFileSync(path.join(dir, "mesh.yaml"), text, "utf8");
  try {
    return resolveConfig(path.join(dir, "mesh.yaml"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function agentA(defaults: string, agent = "") {
  return resolveRaw(meshWith(defaults, agent)).agents.a;
}

test("mesh.defaults.session applies to an agent that omits the session block", () => {
  const a = agentA(MESH_DEFAULTS);
  assert.equal(a.sessionPolicy.persistent, false);
  assert.equal(a.sessionPolicy.maxContextTokens, 120000);
});

test("mesh.defaults.delegation applies to an agent that omits the delegation block", () => {
  const a = agentA(MESH_DEFAULTS);
  assert.equal(a.delegationPolicy.allowDelegation, true);
  assert.equal(a.delegationPolicy.maxDepth, 2);
  assert.equal(a.delegationPolicy.maxWorkers, 3);
  assert.equal(a.delegationPolicy.workerBudgetTokens, 60000);
});

test("per-agent session/delegation values win over mesh.defaults", () => {
  const a = agentA(
    MESH_DEFAULTS,
    ", session: { persistent: true, max_context_tokens: 8000 }" +
      ", delegation: { allow: false, max_depth: 5, max_workers: 7, worker_budget_tokens: 1234 }",
  );
  assert.equal(a.sessionPolicy.persistent, true);
  assert.equal(a.sessionPolicy.maxContextTokens, 8000);
  assert.equal(a.delegationPolicy.allowDelegation, false);
  assert.equal(a.delegationPolicy.maxDepth, 5);
  assert.equal(a.delegationPolicy.maxWorkers, 7);
  assert.equal(a.delegationPolicy.workerBudgetTokens, 1234);
});

/* Regression guard for `||` vs `??`: false/0 are meaningful opt-outs, not "unset". */
test("an agent's explicit false/0 beats a truthy mesh default (nullish coalescing, never ||)", () => {
  const a = agentA(
    MESH_DEFAULTS.replace("persistent: false", "persistent: true"),
    ", session: { persistent: false, max_context_tokens: 0 }" +
      ", delegation: { allow: false, max_depth: 0, max_workers: 0, worker_budget_tokens: 0 }",
  );
  assert.equal(a.sessionPolicy.persistent, false, "persistent: false must not fall through to the mesh default");
  assert.equal(a.sessionPolicy.maxContextTokens, 0, "max_context_tokens: 0 must not fall through to 120000");
  assert.equal(a.delegationPolicy.allowDelegation, false, "allow: false must not fall through to the mesh default");
  assert.equal(a.delegationPolicy.maxDepth, 0, "max_depth: 0 must not fall through to 2");
  assert.equal(a.delegationPolicy.maxWorkers, 0, "max_workers: 0 must not fall through to 3");
  assert.equal(a.delegationPolicy.workerBudgetTokens, 0, "worker_budget_tokens: 0 must not fall through to 60000");
});

test("mesh.defaults only supplies the keys it sets; the rest keep the hardcoded fallbacks", () => {
  const a = agentA(`  defaults:
    delegation: { max_depth: 2 }
`);
  assert.equal(a.delegationPolicy.maxDepth, 2);
  assert.equal(a.delegationPolicy.allowDelegation, false);
  assert.equal(a.delegationPolicy.maxWorkers, 0);
  assert.equal(a.delegationPolicy.workerBudgetTokens, undefined);
  assert.equal(a.sessionPolicy.persistent, true);
  assert.equal(a.sessionPolicy.maxContextTokens, undefined);
});

test("with neither mesh.defaults nor per-agent keys the historical fallbacks are unchanged", () => {
  const a = agentA("");
  assert.equal(a.sessionPolicy.persistent, true);
  assert.equal(a.sessionPolicy.maxContextTokens, undefined);
  assert.equal(a.delegationPolicy.allowDelegation, false);
  assert.equal(a.delegationPolicy.maxDepth, 0);
  assert.equal(a.delegationPolicy.maxWorkers, 0);
  assert.equal(a.delegationPolicy.workerBudgetTokens, undefined);
});
