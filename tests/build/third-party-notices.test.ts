/**
 * What ships is inventoried, and a licence that would change what the product may be sold under is a
 * decision somebody makes, not something that arrives with a dependency bump.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "third-party-notices.mjs");

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 30_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function lockWith(packages: Record<string, unknown>): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mesh-notices-")), "package-lock.json");
  fs.writeFileSync(file, JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "x" }, ...packages } }));
  return file;
}

test("THIRD_PARTY_NOTICES.md is what package-lock.json generates", () => {
  const r = run(["--check"]);
  assert.equal(r.status, 0, r.stderr);
});

test("the notices say the Claude Agent SDK is Anthropic's and not covered by this product's licence", () => {
  const text = fs.readFileSync(path.join(ROOT, "THIRD_PARTY_NOTICES.md"), "utf8");
  assert.match(text, /## The Claude Agent SDK is not open source/);
  assert.match(text, /Use is subject to the Legal Agreements/);
  assert.match(text, /@anthropic-ai\/claude-agent-sdk \| /);
  assert.match(text, /not\s+covered by Curule's licence/);
});

test("a copyleft or unknown licence in the production tree stops the generator, and a dev dependency does not", () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mesh-notices-out-")), "N.md");
  const permissive = { "node_modules/a": { version: "1.0.0", license: "MIT" }, "node_modules/b": { version: "2.0.0", license: "Apache-2.0" } };
  assert.equal(run(["--lock", lockWith(permissive), "--out", out]).status, 0);
  assert.match(fs.readFileSync(out, "utf8"), /\| a \| 1\.0\.0 \| MIT \|/);

  for (const license of ["GPL-3.0-only", "AGPL-3.0-or-later", "LGPL-2.1", "MPL-2.0", "SSPL-1.0", "UNKNOWN", "(MIT OR GPL-2.0)"]) {
    const r = run(["--lock", lockWith({ ...permissive, "node_modules/c": { version: "3.0.0", license } }), "--out", out]);
    // an expression that offers a permissive choice is still flagged for a person to look at: the rule is conservative
    assert.equal(r.status, 1, license);
    assert.match(r.stderr, /c@3\.0\.0/, license);
  }
  const dev = run(["--lock", lockWith({ ...permissive, "node_modules/tool": { version: "9.0.0", license: "GPL-3.0-only", dev: true } }), "--out", out]);
  assert.equal(dev.status, 0, "what is only used to build is not shipped");
  assert.doesNotMatch(fs.readFileSync(out, "utf8"), /\| tool \|/, "and it is not listed as shipped");
});

test("--check on a stale file fails and says what to run", () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mesh-notices-stale-")), "N.md");
  fs.writeFileSync(out, "old");
  const r = run(["--lock", lockWith({ "node_modules/a": { version: "1.0.0", license: "MIT" } }), "--out", out, "--check"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /out of date: run `node scripts\/third-party-notices\.mjs`/);
});
