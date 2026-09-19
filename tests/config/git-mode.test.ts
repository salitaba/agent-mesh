import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parseMeshSource, resolveConfig, resolveUseGit, writeDefaultMeshYaml, ConfigError } from "../../packages/config/src/index";
import { testConfigYaml } from "../helpers";

const AGENTS = { agents: [{ id: "a", role: "r", interests: [] }], mayContact: { a: [] } };

function tmpDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mesh-${name}-`));
}

/**
 * `testConfigYaml` already emits a `workspace:` block, so the setting is
 * spliced into it rather than appended as a second `mesh:` key (which YAML
 * would reject as a duplicate). `null` leaves the key out entirely.
 */
function withGitSetting(value: "true" | "false" | null): string {
  const base = testConfigYaml(AGENTS);
  if (value === null) return base;
  const block = "  workspace:\n    path: ./workspace\n";
  assert.ok(base.includes(block), "helper must still emit a workspace block");
  return base.replace(block, `  workspace:\n    path: ./workspace\n    git: ${value}\n`);
}

function writeConfig(dir: string, yaml: string): string {
  const file = path.join(dir, "mesh.yaml");
  fs.writeFileSync(file, yaml, "utf8");
  return file;
}

test("resolveUseGit: flag beats config, and the default is ON", () => {
  // The flag is absolute in both directions.
  assert.equal(resolveUseGit("on", false), true, "--git overrides an explicit git: false");
  assert.equal(resolveUseGit("off", true), false, "--no-git overrides an explicit git: true");
  // "auto" — or no override at all — defers to the project.
  assert.equal(resolveUseGit("auto", true), true);
  assert.equal(resolveUseGit("auto", false), false);
  assert.equal(resolveUseGit(undefined, true), true);
  assert.equal(resolveUseGit(undefined, false), false);
  // The case that motivates the whole change: nobody said anything.
  assert.equal(resolveUseGit("auto", undefined), true);
  assert.equal(resolveUseGit(undefined, undefined), true);
});

test("mesh.workspace.git is accepted by the schema and reaches the resolved config", () => {
  const absent = tmpDir("gitmode-absent");
  const off = tmpDir("gitmode-off");
  const on = tmpDir("gitmode-on");
  try {
    const a = resolveConfig(writeConfig(absent, withGitSetting(null)));
    // Undefined, NOT false. Collapsing the two here is what would make an
    // unrelated command line silently disable git for every project.
    assert.equal(a.workspaceGit, undefined, "an absent key must stay unspecified");

    const b = resolveConfig(writeConfig(off, withGitSetting("false")));
    assert.equal(b.workspaceGit, false);

    const c = resolveConfig(writeConfig(on, withGitSetting("true")));
    assert.equal(c.workspaceGit, true);
  } finally {
    for (const d of [absent, off, on]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test("the mesh schema rejects a non-boolean workspace.git", () => {
  // `additionalProperties: false` makes a typo'd key a hard load failure rather
  // than a silently ignored one — which is only helpful if the type is checked
  // too, otherwise `git: "yes"` would read as truthy everywhere downstream.
  const yaml = withGitSetting(null).replace("    path: ./workspace\n", '    path: ./workspace\n    git: "yes"\n');
  assert.throws(() => parseMeshSource(yaml), ConfigError);
});

test("the scaffold writes git: true explicitly, and survives its own validator", () => {
  const dir = tmpDir("gitmode-scaffold");
  try {
    // writeDefaultMeshYaml validates its own template, so a key missing from
    // the schema fails right here rather than at the operator's first boot.
    const file = writeDefaultMeshYaml(dir, "scaffolded");
    const resolved = resolveConfig(file);
    assert.equal(resolved.workspaceGit, true, "a new project states its git mode rather than relying on the default");
    assert.match(fs.readFileSync(file, "utf8"), /git: true/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
