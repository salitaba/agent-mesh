/**
 * The product was called Agent Mesh before it was called Curule. The rename is only as good as its last stray
 * occurrence: a page, a help text or a log line that still says the old name is what a customer reads first.
 *
 * Every text file in the repository is scanned for the old name in any spelling (`Agent Mesh`, `agent-mesh`,
 * `agent_mesh`, `AGENT_MESH`, `AgentMesh`). The places that are meant to carry it are listed below, each with what it is
 * there for; anything else fails with its file and line. The words *mesh* and *agent* alone are not the old name: a mesh
 * is still what the product calls one running organization.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..", "..", "..");

/** Files that describe the product's history or the migration, and so name the old product on purpose. */
const HISTORICAL = [
  /^NOTES-.*\.md$/, // written under the old name, kept as they were (each says so at the top)
  /^docs\/NOTES-.*\.md$/,
  /^spec\//,
  /^agent-mesh-runtime\.md$/, // the original design document, renamed by nobody
  /^package-lock\.json$/, // npm's record
  /^CHANGELOG\.md$/, // says what changed from what
  /^LICENSE$/, // "Curule (previously named Agent Mesh)": the licensed work must stay identifiable
  /^docs\/brand\.md$/, // says the old name is retired
  /^docs\/operations\.md$/, // the upgrade from a version named Agent Mesh
];

/** Code that reads or keeps something the old product wrote, and tests of exactly that. */
const COMPATIBILITY = [
  /^packages\/projects\/src\/store\.ts$/, // ~/.agent-mesh is still used while ~/.curule does not exist
  /^tests\/projects\/registry\.test\.ts$/,
  /^apps\/mesh-cli\/src\/doctor\.ts$/, // says when an install is still on that directory, and links the runbook's section on it
  /^tests\/cli\/doctor\.test\.ts$/,
  /^packages\/runtime-claude\/src\/orphans\.ts$/, // AGENT_MESH_HOST_PID: seats a previous version left running
  /^tests\/agent-runtime\/orphan-seats\.test\.ts$/,
  /^docs\/runtime\.md$/, // documents that stamp
  /^docker-compose\.yml$/, // COMPOSE_PROJECT_NAME=agent-mesh keeps an existing deployment's volume
  /^\.github\/workflows\/release\.yml$/, // says the image is not named after the repository
  /^tests\/deploy\/rename-upgrade\.test\.ts$/, // pins the two upgrade steps above
  /^tests\/build\/product-name\.test\.ts$/, // this file
];

/** What may appear on any line of any file: the repository's own address and the design document's file name. */
const ALLOWED_ON_A_LINE = [
  /github\.com\/salitaba\/agent-mesh/g, // renaming the GitHub repository is the owner's step; the links follow it then
  /github\\\.com\\\/salitaba\\\/agent-mesh/g, // the same address written inside a regular expression
  /agent-mesh-runtime\.md/g,
];

/**
 * The old name, in the spellings it had: `Agent Mesh` (also run together or hyphenated), `agent-mesh`, `agent_mesh` and
 * `AGENT_MESH`. Lower-case "agent mesh" with a space is not it: "a single-agent mesh" is a mesh with one agent, and
 * `twoAgentMesh` is a test helper's name.
 */
const OLD_NAME = /(?<![A-Za-z])Agent(?:[ _-]|&nbsp;)?Mesh(?![A-Za-z])|(?<![A-Za-z0-9])agent-mesh(?![A-Za-z0-9])|(?<![A-Za-z0-9])agent_mesh|AGENT_MESH/;
// `.claude` holds an editor agent's local worktrees: whole copies of this repository, never part of it (git excludes them).
const SKIP_DIRS = new Set(["node_modules", "dist", "dist-dev", ".git", ".claude", "business", ".mesh-state", ".mesh-backups", "workspace"]);
const TEXT = /\.(md|ts|tsx|mjs|cjs|js|json|yml|yaml|sh|html|css|txt|tpl|svg|toml|env|example)$|^(LICENSE|Dockerfile|\.dockerignore|\.gitignore)$/;

function* files(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".mesh")) yield* files(rel);
    } else if (TEXT.test(entry.name)) {
      yield rel;
    }
  }
}

function strays(): string[] {
  const found: string[] = [];
  for (const rel of files("")) {
    if ([...HISTORICAL, ...COMPATIBILITY].some((re) => re.test(rel))) continue;
    const lines = fs.readFileSync(path.join(ROOT, rel), "utf8").split("\n");
    lines.forEach((line, i) => {
      const rest = ALLOWED_ON_A_LINE.reduce((l, re) => l.replace(re, ""), line);
      if (OLD_NAME.test(rest)) found.push(`${rel}:${i + 1}: ${line.trim().slice(0, 110)}`);
    });
  }
  return found;
}

test("nothing but the history and the migration still names the product Agent Mesh", () => {
  const found = strays();
  assert.deepEqual(found, [], `the old product name is back:\n  ${found.join("\n  ")}`);
});

test("the files that are allowed to say it do say it, so the list cannot go stale", () => {
  for (const re of [...HISTORICAL, ...COMPATIBILITY]) {
    const matches = [...files("")].filter((rel) => re.test(rel));
    assert.ok(matches.length > 0, `${re} names no file: remove it from the list`);
    for (const rel of matches) {
      const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
      const rest = ALLOWED_ON_A_LINE.reduce((t, a) => t.replace(a, ""), text);
      // Every entry must still need its exemption; a file that no longer says the old name belongs in the scan.
      assert.ok(OLD_NAME.test(rest) || /^(spec\/|NOTES-|docs\/NOTES-|package-lock)/.test(rel), `${rel} no longer names the old product: remove it from the allowed list`);
    }
  }
});

/**
 * A name the product was briefly going to have and never shipped under. It is not the old name and it is not the new
 * one, so it has no business anywhere but in the notes that tell the story. Built from pieces so that this file does
 * not contain it.
 */
const ABANDONED = new RegExp("ord" + "ane", "i");

test("the name the product almost had appears only in the notes that record the rename", () => {
  const found: string[] = [];
  for (const rel of files("")) {
    if (/^NOTES-.*\.md$/.test(rel) || /^docs\/NOTES-/.test(rel) || /^spec\//.test(rel) || rel === "package-lock.json") continue;
    fs.readFileSync(path.join(ROOT, rel), "utf8").split("\n").forEach((line, i) => {
      if (ABANDONED.test(line)) found.push(`${rel}:${i + 1}: ${line.trim().slice(0, 110)}`);
    });
  }
  assert.deepEqual(found, [], `a name the product never shipped under is in the tree:\n  ${found.join("\n  ")}`);
  assert.ok(!ABANDONED.test(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8")), "nor in the lockfile");
});

test("what the scan skips is not where the product's own text lives", () => {
  for (const rel of ["README.md", "PRODUCT.md", "docs/architecture.md", "docs/commercial/pricing.md", "site/index.html", "apps/mesh-cli/src/index.ts", "apps/mesh-dashboard/src/shell.tsx", "deploy/helm/curule/Chart.yaml", "Dockerfile"]) {
    assert.ok([...files("")].includes(rel), `${rel} is scanned`);
  }
  assert.ok(![...files("")].some((rel) => rel.startsWith("node_modules/") || rel.startsWith("dist/")));
});
