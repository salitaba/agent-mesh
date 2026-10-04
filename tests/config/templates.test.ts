/**
 * Starting points: what a new project can be made from, and what a scaffold may and may not do.
 *
 * `describeTemplates` is what the dashboard's welcome says about each starting point before anything is written, so its
 * answers are read from the files themselves: a seat count or "needs an API key" that was typed into a list would be wrong
 * the day an example changed. `scaffoldExample` takes an example by name from a caller that may be a request body, so it
 * is held to a closed set, and it never replaces a file the person already has.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  ConfigError,
  DEFAULT_SCAFFOLD_MISSION_TOKENS,
  DEFAULT_TEMPLATE_ID,
  describeTemplates,
  findShippedRoot,
  listExamples,
  parseMeshSource,
  resolveConfig,
  scaffoldExample,
  writeDefaultMeshYaml,
  yamlScalar,
} from "../../packages/config/src/index";

const ROOT = findShippedRoot(__dirname)!;
const tmp = (label: string): string => fs.mkdtempSync(path.join(os.tmpdir(), `mesh-templates-${label}-`));

test("the default team is offered first, then every shipped example, by name", () => {
  const offered = describeTemplates(ROOT);
  assert.equal(offered[0]!.id, DEFAULT_TEMPLATE_ID);
  assert.equal(offered[0]!.kind, "default");
  assert.deepEqual(offered.slice(1).map((t) => t.id), listExamples(ROOT));
  assert.ok(offered.slice(1).every((t) => t.kind === "example"));
  // No install root, no examples: the default team needs none.
  assert.deepEqual(describeTemplates(undefined).map((t) => t.id), [DEFAULT_TEMPLATE_ID]);
});

test("whether a starting point needs a model credential is read from the runtimes its seats use", () => {
  const byId = new Map(describeTemplates(ROOT).map((t) => [t.id, t]));
  const demo = byId.get("demo-stub")!;
  assert.equal(demo.needsApiKey, false, "the demo is scripted: no model, no key");
  assert.equal(demo.runtime, "stub");
  assert.equal(demo.seats, 7);
  assert.equal(demo.rolePrompts, 7, "one prompt per seat, written beside the mesh.yaml");
  assert.match(demo.goal ?? "", /payment/);
  assert.equal(byId.get(DEFAULT_TEMPLATE_ID)!.needsApiKey, true);
  assert.equal(byId.get(DEFAULT_TEMPLATE_ID)!.runtime, "claude");
  for (const t of byId.values()) if (t.id !== "demo-stub" && t.id !== DEFAULT_TEMPLATE_ID) assert.equal(t.needsApiKey, true, `${t.id} runs on the Claude runtime`);
});

test("the default team's facts are read from the text the scaffold writes, so they cannot drift from it", () => {
  const dir = path.join(tmp("default"), "p");
  const written = parseMeshSource(fs.readFileSync(writeDefaultMeshYaml(dir, "p"), "utf8"));
  const facts = describeTemplates(undefined)[0]!;
  assert.equal(facts.seats, Object.keys(written.agents).length);
  assert.equal(facts.missionTokens, written.budgets?.mission?.tokens);
  assert.equal(facts.missionTokens, DEFAULT_SCAFFOLD_MISSION_TOKENS);
  assert.equal(facts.rolePrompts, fs.readdirSync(path.join(dir, "roles")).length, "the prompts it lists are the prompts it writes");
});

test("an example that does not parse is not offered; one that does is, with the seats it has", () => {
  const root = tmp("fake-root");
  fs.mkdirSync(path.join(root, "roles"), { recursive: true });
  fs.mkdirSync(path.join(root, "examples", "broken"), { recursive: true });
  fs.writeFileSync(path.join(root, "examples", "broken", "mesh.yaml"), "this: [is not a mesh\n");
  fs.mkdirSync(path.join(root, "examples", "tiny"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "examples", "tiny", "mesh.yaml"),
    "version: 1\nmesh:\n  id: tiny\n  name: Tiny\n  goal: |\n\n    Say hello.\n    And then stop.\nagents:\n  a: { role: r, runtime: stub }\n  b: { role: r, runtime: claude }\n",
  );
  const offered = describeTemplates(root).map((t) => t.id);
  assert.deepEqual(offered, [DEFAULT_TEMPLATE_ID, "tiny"]);
  const tiny = describeTemplates(root)[1]!;
  assert.equal(tiny.seats, 2);
  assert.equal(tiny.runtime, "mixed");
  assert.equal(tiny.needsApiKey, true, "one seat on the Claude runtime is enough");
  assert.equal(tiny.goal, "Say hello. And then stop.", "the first paragraph, on one line, not a first line that stops mid-sentence");
  const long = describeTemplates(ROOT).filter((t) => t.goal);
  assert.ok(long.every((t) => t.goal!.length <= 160), "a long goal is cut");
  assert.ok(long.every((t) => !/[:\s]$/.test(t.goal!) || /\.\.\.$/.test(t.goal!)), "and not at a colon or a space");
});

test("scaffolding takes an example from a closed set: a name that is not one is refused and writes nothing", () => {
  const base = tmp("closed");
  const outsideFile = path.join(base, "outside.txt");
  for (const name of ["../examples/demo-stub", "demo-stub/..", "demo-stub/../greenfield", "/etc", "..", ".", "", "__proto__", "constructor", "DEMO-STUB", "demo-stub "]) {
    const target = path.join(base, `t-${Math.random().toString(36).slice(2)}`);
    assert.throws(() => scaffoldExample(ROOT, name, target), (e: unknown) => e instanceof ConfigError && /no example/.test(e.message), JSON.stringify(name));
    assert.equal(fs.existsSync(target), false, `nothing written for ${JSON.stringify(name)}`);
  }
  assert.equal(fs.existsSync(outsideFile), false);
});

test("scaffolding never writes over a mesh.yaml, and keeps a role prompt the folder already has", () => {
  const dir = tmp("keep");
  fs.mkdirSync(path.join(dir, "roles"));
  fs.writeFileSync(path.join(dir, "roles", "pm.md"), "my own pm prompt\n");
  const made = scaffoldExample(ROOT, "demo-stub", dir);
  assert.deepEqual(made.kept, ["pm.md"]);
  assert.equal(made.roles.length, 7);
  assert.equal(fs.readFileSync(path.join(dir, "roles", "pm.md"), "utf8"), "my own pm prompt\n", "the person's prompt is untouched");
  assert.equal(fs.readdirSync(path.join(dir, "roles")).length, 7, "the other six were written");
  assert.doesNotThrow(() => resolveConfig(path.join(dir, "mesh.yaml")), "and the result still loads");

  const before = fs.readFileSync(path.join(dir, "mesh.yaml"), "utf8");
  assert.throws(() => scaffoldExample(ROOT, "demo-stub", dir), (e: unknown) => e instanceof ConfigError && /already exists/.test(e.message));
  assert.throws(() => writeDefaultMeshYaml(dir, "again"), (e: unknown) => e instanceof ConfigError && /already exists/.test(e.message));
  assert.equal(fs.readFileSync(path.join(dir, "mesh.yaml"), "utf8"), before, "the mesh.yaml is byte for byte what it was");
});

test("a folder name that YAML would misread still scaffolds a mesh that loads under that name", () => {
  const base = tmp("names");
  for (const name of ["2024", "no", "null", "acme: payments", "a #1", "x'y", "payment-api", "My Mesh", "équipe"]) {
    const dir = path.join(base, name.replace(/[/\\]/g, "_"));
    const file = writeDefaultMeshYaml(dir, name);
    const raw = parseMeshSource(fs.readFileSync(file, "utf8"));
    assert.equal(raw.mesh.id, name, `the mesh keeps the name ${JSON.stringify(name)}`);
    assert.equal(typeof raw.project?.id, "string", `${name}: a string id, not a number or a boolean`);
    assert.doesNotThrow(() => resolveConfig(file), name);
  }
});

test("yamlScalar leaves an ordinary name plain and quotes what would not read back as the same string", () => {
  for (const plain of ["payment-api", "demo-stub", "My Mesh", "a.b_c", "team 2"]) assert.equal(yamlScalar(plain), plain);
  for (const quoted of ["2024", "true", "No", "null", "a: b", "a #b", "-x", " pad", "trail ", "line\nbreak", ""]) {
    assert.notEqual(yamlScalar(quoted), quoted, JSON.stringify(quoted));
    assert.equal(JSON.parse(yamlScalar(quoted)), quoted, "a JSON string is a valid YAML string, and reads back exactly");
  }
});
