import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveConfig } from "../../packages/config/src/index";

function agentBlock(id: string, role: string, caps: string[]): string {
  const capsYaml =
    caps.length === 0 ? "    capabilities: []" : `    capabilities:\n${caps.map((c) => `      - ${c}`).join("\n")}`;
  return `  ${id}:\n    role: ${role}\n${capsYaml}\n    authority: []`;
}

/** Each entry is [agentId, role, capabilities]. */
function meshWith(agents: [string, string, string[]][]): string {
  return `version: 1
mesh:
  id: covtest
  goal: |
    Test.
  workspace: { path: ./workspace }
  runtime: { default: stub }
agents:
${agents.map(([id, role, caps]) => agentBlock(id, role, caps)).join("\n")}
`;
}

function resolve(agents: [string, string, string[]][]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-cov-test-"));
  fs.writeFileSync(path.join(dir, "mesh.yaml"), meshWith(agents), "utf8");
  try {
    return resolveConfig(path.join(dir, "mesh.yaml"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const uncovered = (warnings: string[]) => warnings.filter((w) => w.includes("git.commit"));

test("a mesh that can write but holds no git.commit is warned about at load", () => {
  const cfg = resolve([["dev", "developer", ["repository.read", "repository.write"]]]);
  const hits = uncovered(cfg.warnings);
  assert.equal(hits.length, 1, `expected one coverage warning, got ${JSON.stringify(cfg.warnings)}`);
  assert.match(hits[0], /'dev'/, "names the seat that can write");
  assert.match(hits[0], /deadlock/, "says what actually goes wrong");
});

test("the coverage warning does not stop the config from loading", () => {
  // The whole point of warn-not-error: a mesh that commits outside the mesh,
  // or that an operator is mid-way through composing, still boots.
  const cfg = resolve([["dev", "developer", ["repository.write"]]]);
  assert.equal(cfg.agents.dev.capabilities.includes("repository.write"), true);
  assert.equal(uncovered(cfg.warnings).length, 1);
});

test("a deliberately read-only mesh is not warned about", () => {
  const cfg = resolve([
    ["pm", "product-manager", ["repository.read"]],
    ["reviewer", "tech-lead", ["repository.read", "code.review"]],
  ]);
  assert.deepEqual(uncovered(cfg.warnings), [], "no seat can write, so nothing needs landing");
});

test("a mesh with no capabilities at all is not warned about", () => {
  const cfg = resolve([["pm", "product-manager", []]]);
  assert.deepEqual(uncovered(cfg.warnings), []);
});

test("git.commit held by a different seat than the writer covers the mesh", () => {
  // The committer need not be the author — a tech-lead landing a dev's work
  // is a normal shape and must not warn.
  const cfg = resolve([
    ["dev", "developer", ["repository.write"]],
    ["lead", "tech-lead", ["repository.read", "git.commit"]],
  ]);
  assert.deepEqual(uncovered(cfg.warnings), []);
});

test("git.commit held by the writer itself covers the mesh", () => {
  const cfg = resolve([["dev", "developer", ["repository.write", "git.commit"]]]);
  assert.deepEqual(uncovered(cfg.warnings), []);
});

test("every writing seat is named, so the operator knows where the grant belongs", () => {
  const cfg = resolve([
    ["dev", "developer", ["repository.write"]],
    ["ui", "developer", ["repository.write"]],
    ["pm", "product-manager", ["repository.read"]],
  ]);
  const hits = uncovered(cfg.warnings);
  assert.equal(hits.length, 1);
  assert.match(hits[0], /'dev'/);
  assert.match(hits[0], /'ui'/);
  assert.doesNotMatch(hits[0], /'pm'/, "a read-only seat is not a candidate committer");
  assert.match(hits[0], /agents/, "plural wording when more than one seat writes");
});

test("coverage is judged after aliases normalize, so an aliased writer still warns", () => {
  // api.write is repository.write by the time policy sees it; the coverage
  // check must not be fooled by the spelling.
  const cfg = resolve([["dev", "developer", ["api.write"]]]);
  assert.equal(uncovered(cfg.warnings).length, 1, "aliased write counts as a write");
});
