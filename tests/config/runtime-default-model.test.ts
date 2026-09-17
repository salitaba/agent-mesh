import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigError, resolveConfig } from "../../packages/config/src/index";

function meshWith(runtime: string): string {
  return `version: 1
mesh:
  id: cfgtest
  goal: |
    Test.
  workspace: { path: ./workspace }
  ${runtime}
agents:
  a: { role: worker, capabilities: [], authority: [] }
`;
}

function resolveRaw(text: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-config-test-"));
  fs.writeFileSync(path.join(dir, "mesh.yaml"), text, "utf8");
  try {
    return resolveConfig(path.join(dir, "mesh.yaml"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("mesh.runtime.model resolves to defaultModel and stays in the raw config", () => {
  const cfg = resolveRaw(meshWith("runtime: { default: claude, model: openrouter/anthropic/claude-sonnet-4 }"));
  assert.equal(cfg.defaultModel, "openrouter/anthropic/claude-sonnet-4");
  assert.equal(cfg.raw.mesh.runtime?.model, "openrouter/anthropic/claude-sonnet-4");
});

test("defaultModel is undefined when mesh.runtime.model is absent or blank", () => {
  assert.equal(resolveRaw(meshWith("runtime: { default: stub }")).defaultModel, undefined);
  assert.equal(resolveRaw(meshWith('runtime: { model: "  " }')).defaultModel, undefined);
});

test("a non-string mesh.runtime.model fails schema validation", () => {
  assert.throws(() => resolveRaw(meshWith("runtime: { model: 42 }")), ConfigError);
});

test("mesh.runtime.variant resolves to defaultVariant and stays in the raw config", () => {
  const cfg = resolveRaw(meshWith("runtime: { default: claude, variant: max }"));
  assert.equal(cfg.defaultVariant, "max");
  assert.equal(cfg.raw.mesh.runtime?.variant, "max");
});

test("defaultVariant is undefined when mesh.runtime.variant is absent or blank", () => {
  assert.equal(resolveRaw(meshWith("runtime: { default: stub }")).defaultVariant, undefined);
  assert.equal(resolveRaw(meshWith('runtime: { variant: "  " }')).defaultVariant, undefined);
});

test("a non-string mesh.runtime.variant fails schema validation", () => {
  assert.throws(() => resolveRaw(meshWith("runtime: { variant: 3 }")), ConfigError);
});

test("agents.<id>.variant resolves onto the AgentDefinition without inheriting the mesh default", () => {
  const cfg = resolveRaw(`version: 1
mesh:
  id: cfgtest
  goal: |
    Test.
  runtime: { default: claude, variant: max }
agents:
  a: { role: worker, variant: low }
`);
  assert.equal(cfg.agents.a?.variant, "low");
  assert.equal(cfg.defaultVariant, "max");
});

test("a configured variant is reported inert, since no runtime reads it", () => {
  const cfg = resolveRaw(meshWith("runtime: { default: claude, variant: max }"));
  const inert = cfg.warnings.filter((w) => /inert/.test(w));
  assert.equal(inert.length, 1);
  assert.match(inert[0], /^mesh\.runtime\.variant is set but inert/);
});

test("an agent-level variant is reported inert and names the seat", () => {
  const cfg = resolveRaw(`version: 1
mesh:
  id: cfgtest
  goal: |
    Test.
  workspace: { path: ./workspace }
  runtime: { default: claude }
agents:
  a: { role: worker, variant: low }
`);
  const inert = cfg.warnings.filter((w) => /inert/.test(w));
  assert.equal(inert.length, 1);
  assert.match(inert[0], /^agents\.a\.variant is set but inert/);
});

test("both levels set produces one warning naming both paths", () => {
  const cfg = resolveRaw(`version: 1
mesh:
  id: cfgtest
  goal: |
    Test.
  workspace: { path: ./workspace }
  runtime: { default: claude, variant: max }
agents:
  a: { role: worker, variant: low }
`);
  const inert = cfg.warnings.filter((w) => /inert/.test(w));
  assert.equal(inert.length, 1);
  assert.match(inert[0], /^mesh\.runtime\.variant, agents\.a\.variant are set but inert/);
});

test("no variant configured draws no inert warning", () => {
  const cfg = resolveRaw(meshWith("runtime: { default: stub }"));
  assert.equal(cfg.warnings.filter((w) => /inert/.test(w)).length, 0);
});
