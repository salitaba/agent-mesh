/**
 * `mesh --help` is the first thing a person types, and the image's smoke test runs it in the built container.
 *
 * It used to be "unknown command: --help": the usage printed, the message said it was an error and the exit code was 1.
 * CI's container job (`scripts/smoke.sh image`) reads that exit code, so it reported "the mesh command is not on the path"
 * on every push to main from the day CI was added, with the image building and fifteen of its sixteen checks passing.
 * The command was on the path. Asking for help is not an error; a command that does not exist still is.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";

const cli = path.join(__dirname, "..", "..", "apps", "mesh-cli", "src", "index.js");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-help-cli-"));
const env = { PATH: process.env.PATH ?? "", MESH_HOME: home };
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8" });

test("every way of asking for help prints the usage and exits 0", () => {
  for (const args of [["--help"], ["-h"], ["help"], []]) {
    const r = run(...args);
    assert.equal(r.status, 0, `mesh ${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stdout, /usage:/, `mesh ${args.join(" ")} prints the usage`);
    assert.match(r.stdout, /mesh --help \| -h \| help/, "and the usage says how to ask for it");
    assert.equal(r.stderr, "", `mesh ${args.join(" ")} says nothing on stderr`);
  }
});

test("a command that does not exist is still an error, and says so", () => {
  const r = run("frobnicate");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown command: frobnicate/);
  assert.match(r.stdout, /usage:/, "with the usage beside it");
});

test("--version still prints the version and exits 0", () => {
  const r = run("--version");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^agent-mesh \d+\.\d+\.\d+/);
});

test("the image's smoke check tells a missing command from one that fails", () => {
  const script = fs.readFileSync(path.join(__dirname, "..", "..", "..", "scripts", "smoke.sh"), "utf8");
  assert.match(script, /command -v mesh/, "it looks for the command on the path");
  assert.match(script, /on the path but .*mesh --help.* exits non-zero/, "and names a command that runs badly as that, not as missing");
});
