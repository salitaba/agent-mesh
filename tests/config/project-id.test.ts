import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parse as parseYaml } from "yaml";
import { analyzeMeshConfig, parseMeshSource, writeDefaultMeshYaml, ConfigError } from "../../packages/config/src/index";
import { isProjectId, toProjectId, validateMeshConfig } from "../../packages/protocol/src/index";
import { testConfigYaml } from "../helpers";

const AGENTS = { agents: [{ id: "a", role: "r", interests: [] }], mayContact: { a: [] } };

function withProject(block: string): string {
  // The `project` block is top-level, so it can simply precede the rest.
  return `${block}\n${testConfigYaml(AGENTS)}`;
}

function tmpDir(name: string): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-projid-"));
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test("project id slug: accepts valid ids and rejects malformed ones", () => {
  for (const ok of ["payment-api", "a1", "x-9", "a".repeat(63)]) {
    assert.ok(isProjectId(ok), `${ok} must be a valid project id`);
  }
  for (const bad of ["", "a", "-lead", "Upper", "has space", "under_score", "a".repeat(64), "dot.ted"]) {
    assert.ok(!isProjectId(bad), `${bad} must be rejected`);
  }
});

test("toProjectId: derives a schema-valid id from any folder name", () => {
  assert.equal(toProjectId("payment-api"), "payment-api");
  assert.equal(toProjectId("Payment API"), "payment-api");
  assert.equal(toProjectId("my_project.v2"), "my-project-v2");
  assert.equal(toProjectId("--trim--"), "trim");
  // Total function: even names that slug to nothing yield a usable id, because
  // legacy mesh.yaml files must still boot.
  for (const weird of ["", ".", "_", "!!!", "é", "a".repeat(200), "x"]) {
    const id = toProjectId(weird);
    assert.ok(isProjectId(id), `toProjectId(${JSON.stringify(weird)}) = ${id} must be valid`);
  }
  // Unnameable folders must not all collide on one id.
  assert.notEqual(toProjectId("!!!"), toProjectId("???"));
});

test("schema: project.id is optional but validated when present", () => {
  // Raw YAML, not parseMeshSource: that helper validates as it parses, so it
  // cannot be used to assert on an INVALID document.
  const doc = (text: string): unknown => parseYaml(text);

  assert.ok(validateMeshConfig(doc(testConfigYaml(AGENTS))).valid, "a config without project must stay valid");
  assert.ok(validateMeshConfig(doc(withProject("project:\n  id: payment-api\n  name: Payment API"))).valid);

  const bad = validateMeshConfig(doc(withProject("project:\n  id: Not_A_Slug")));
  assert.ok(!bad.valid, "a malformed id must fail schema validation");
  assert.ok(bad.errors.some((e) => e.path.includes("project")), "the error must point at project");

  assert.ok(
    !validateMeshConfig(doc(withProject("project:\n  name: No Id"))).valid,
    "project without id must fail",
  );
  assert.ok(
    !validateMeshConfig(doc(withProject("project:\n  id: ok-id\n  extra: nope"))).valid,
    "unknown keys under project must fail rather than be silently ignored",
  );
  // And the strict parser agrees with the raw validator.
  assert.throws(() => parseMeshSource(withProject("project:\n  id: Not_A_Slug")), ConfigError);
});

test("resolve: a declared project.id is used verbatim and not flagged as derived", () => {
  const dir = tmpDir("some-other-folder");
  const raw = parseMeshSource(withProject("project:\n  id: payment-api\n  name: Payment API"));
  const { resolved } = analyzeMeshConfig(raw, dir);
  assert.equal(resolved.projectId, "payment-api");
  assert.equal(resolved.projectName, "Payment API");
  assert.equal(resolved.projectIdDerived, false);
  assert.ok(
    !resolved.warnings.some((w) => w.includes("project.id")),
    "a declared id must not warn",
  );
});

test("resolve: a config without project.id falls back to the folder slug and warns", () => {
  const dir = tmpDir("Payment API");
  const raw = parseMeshSource(testConfigYaml(AGENTS));
  const { resolved } = analyzeMeshConfig(raw, dir);
  // Migration, not a break: the mesh still resolves.
  assert.equal(resolved.projectId, "payment-api");
  assert.equal(resolved.projectIdDerived, true);
  assert.ok(isProjectId(resolved.projectId));
  const warning = resolved.warnings.find((w) => w.includes("project.id"));
  assert.ok(warning, "the derived id must be surfaced as a warning");
  assert.match(warning!, /payment-api/, "the warning must name the id it chose");
});

test("resolve: project.name falls back to mesh.name, then to the id", () => {
  const dir = tmpDir("workspace");

  // mesh.name declared: the project inherits it rather than showing a slug.
  const named = parseMeshSource(`project:\n  id: payment-api\n${testConfigYaml(AGENTS).replace(/^mesh:$/m, "mesh:\n  name: Payment Mesh")}`);
  const withMeshName = analyzeMeshConfig(named, dir).resolved;
  assert.equal(withMeshName.projectName, "Payment Mesh");

  // testConfigYaml declares no mesh.name, so meshName degrades to meshId and
  // the project name lands on the project id — never empty.
  const bare = analyzeMeshConfig(parseMeshSource(withProject("project:\n  id: payment-api")), dir).resolved;
  assert.equal(bare.projectName, "payment-api");
});

test("resolve: project.id is independent of mesh.id", () => {
  const dir = tmpDir("workspace");
  const raw = parseMeshSource(withProject("project:\n  id: payment-api"));
  const { resolved } = analyzeMeshConfig(raw, dir);
  // They answer different questions: which workspace vs which mission.
  assert.equal(resolved.projectId, "payment-api");
  assert.notEqual(resolved.meshId, resolved.projectId);
});

test("mesh init: scaffolds a project block with a slugged id", () => {
  const dir = tmpDir("My New Mesh");
  const file = writeDefaultMeshYaml(dir, path.basename(dir), "stub");
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /^project:$/m);
  assert.match(text, /^ {2}id: my-new-mesh$/m);
  assert.match(text, /^ {2}name: My New Mesh$/m);

  // The scaffold must survive its own validator and resolver.
  const raw = parseMeshSource(text);
  assert.ok(validateMeshConfig(raw).valid, "the generated file must satisfy the schema");
  const { resolved } = analyzeMeshConfig(raw, dir);
  assert.equal(resolved.projectId, "my-new-mesh");
  assert.equal(resolved.projectIdDerived, false, "an init-generated file must not warn");
});

test("mesh init: an explicit projectId overrides the folder-derived one", () => {
  const dir = tmpDir("whatever");
  const file = writeDefaultMeshYaml(dir, "whatever", "stub", { projectId: "payment-api" });
  assert.match(fs.readFileSync(file, "utf8"), /^ {2}id: payment-api$/m);
});

test("mesh init: an invalid explicit projectId is rejected up front", () => {
  const dir = tmpDir("whatever");
  assert.throws(() => writeDefaultMeshYaml(dir, "whatever", "stub", { projectId: "Not Valid" }), ConfigError);
});
