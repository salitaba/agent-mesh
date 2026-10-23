/**
 * The full deploy script. It is the one place that knows a running cloud is three things — the
 * release the control plane serves, the workspace image, and the containers already running from
 * the old image — and forgetting any one of them is how a change is "deployed" and still not live.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "deploy-cloud.sh");
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("the deploy script parses, and the command in package.json is the script", () => {
  assert.ok(fs.existsSync(SCRIPT), "scripts/deploy-cloud.sh is shipped");
  const syntax = spawnSync("bash", ["-n", SCRIPT], { encoding: "utf8" });
  assert.equal(syntax.status, 0, syntax.stderr);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  assert.equal(pkg.scripts?.["deploy:cloud"], "bash scripts/deploy-cloud.sh");
});

test("--help says what a deploy moves and how to check it without changing anything", () => {
  const help = spawnSync("bash", [SCRIPT, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  for (const phrase of ["the release", "workspace image", "curule.workspace", "--verify", "--dry-run", "--ref"]) {
    assert.match(help.stdout, new RegExp(escape(phrase)), phrase);
  }
});

test("the header names the three moving parts, so the next reader does not stop at the release", () => {
  const header = fs.readFileSync(SCRIPT, "utf8").split("\n").slice(0, 20).join("\n");
  assert.match(header, /the release/);
  assert.match(header, /the workspace image/);
  assert.match(header, /the workspace container/);
  assert.match(header, /A release alone is not a deploy/);
});
