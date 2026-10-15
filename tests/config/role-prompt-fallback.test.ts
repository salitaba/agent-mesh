/**
 * A seat that names no prompt file still gets its role's prompt.
 *
 * This was the silent one. `materializeRolePrompts` wrote a file only for seats that named a `prompt:`
 * ref, and an example cannot name one (its refs resolve beside the example, so they fail validation),
 * so an example's seats — and any scaffold whose seats named nothing — ran on `loadRolePrompt`'s
 * one-line synthesis: "You are the pm agent in mesh 'x'." Nothing in the output distinguishes a seat
 * running that from a working one. A live mesh's product manager was `role: product-manager`, a file
 * that has never existed, and authored the mission's acceptance criteria from that sentence — which is
 * why the criteria never once mentioned the interface its owner kept calling ugly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadRolePrompt, parseMeshSource, resolveConfig, writeDefaultMeshYaml } from "../../packages/config/src/index";

const tmp = (name: string): string => fs.mkdtempSync(path.join(os.tmpdir(), `mesh-roles-${name}-`));

test("the scaffold writes a role prompt for every distinct role it declares", () => {
  const dir = tmp("scaffold");
  const written = path.join(dir, "m");
  fs.mkdirSync(written, { recursive: true });
  writeDefaultMeshYaml(written, "m");
  const mesh = parseMeshSource(fs.readFileSync(path.join(written, "mesh.yaml"), "utf8"));
  const roles = new Set(Object.values(mesh.agents).map((a) => a.role));
  for (const role of roles) {
    assert.ok(fs.existsSync(path.join(written, "roles", `${role}.md`)), `roles/${role}.md is written`);
  }
  // and the two designers, whose absence is what this whole line of work exists to fix
  assert.ok(fs.existsSync(path.join(written, "roles", "ui-designer.md")), "the ui-designer has a prompt");
  assert.ok(fs.existsSync(path.join(written, "roles", "ux-designer.md")), "so does the ux-designer");
});

test("a seat that named no prompt gets its role's prompt, not the synthesized line", () => {
  const dir = tmp("fallback");
  const written = path.join(dir, "m");
  fs.mkdirSync(written, { recursive: true });
  writeDefaultMeshYaml(written, "m");
  fs.rmSync(path.join(written, "roles"), { recursive: true, force: true });   // no project copy: the install's must be found
  const prompt = loadRolePrompt(resolveConfig(path.join(written, "mesh.yaml")), "pm");
  assert.doesNotMatch(prompt, /^You are the pm agent in mesh/, "the one-line synthesis is the last resort, not the default");
  assert.match(prompt, /criteria|requirements/i, "and what it loaded is the pm role's own prompt");
});

test("a project-local roles file wins over the install's, so a mesh can edit its own", () => {
  const dir = tmp("local");
  const written = path.join(dir, "m");
  fs.mkdirSync(written, { recursive: true });
  writeDefaultMeshYaml(written, "m");
  fs.writeFileSync(path.join(written, "roles", "pm.md"), "# House rules\\n\\nThis mesh edits its own prompt.\\n");
  assert.match(loadRolePrompt(resolveConfig(path.join(written, "mesh.yaml")), "pm"), /House rules/, "the project's copy is the one it runs");
});
