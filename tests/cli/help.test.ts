/**
 * `ordane --help` is the first thing a person types, and the image's smoke test runs it in the built container.
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
    assert.equal(r.status, 0, `ordane ${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stdout, /usage:/, `ordane ${args.join(" ")} prints the usage`);
    assert.match(r.stdout, /ordane --help \| -h \| help/, "and the usage says how to ask for it");
    assert.match(r.stdout, /`mesh` is the same command under the name this product had before/, "and where the old command went");
    assert.equal(r.stderr, "", `ordane ${args.join(" ")} says nothing on stderr`);
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
  assert.match(r.stdout, /^ordane \d+\.\d+\.\d+/);
});

test("the image's smoke check tells a missing command from one that fails, for the command and for the name it had before", () => {
  const script = fs.readFileSync(path.join(__dirname, "..", "..", "..", "scripts", "smoke.sh"), "utf8");
  assert.match(script, /for cmd in ordane mesh; do/, "it checks `ordane` and the old `mesh`");
  assert.match(script, /command -v \$cmd/, "it looks for each on the path");
  assert.match(script, /on the path but .*\$cmd --help.* exits non-zero/, "and names a command that runs badly as that, not as missing");
});

const root = path.join(__dirname, "..", "..", "..");
const launcher = (name: string) => path.join(root, "apps", "mesh-cli", "bin", name);

test("`ordane` is the command and `mesh` stays installed as the same launcher, in the package, the lockfile and the image", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
  const bin = { ordane: "apps/mesh-cli/bin/ordane.mjs", mesh: "apps/mesh-cli/bin/mesh.mjs" };
  assert.equal(pkg.name, "ordane");
  assert.deepEqual(pkg.bin, bin);
  assert.equal(lock.name, "ordane", "the lockfile follows package.json");
  assert.equal(lock.packages[""].name, "ordane");
  assert.deepEqual(lock.packages[""].bin, bin);

  // Both launchers reach the same entry point and report the product by its current name.
  for (const name of ["ordane.mjs", "mesh.mjs"]) {
    const r = spawnSync(process.execPath, [launcher(name), "--version"], { env, encoding: "utf8" });
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.match(r.stdout, /^ordane \d+\.\d+\.\d+/, `${name} reports the product by its current name`);
  }
  // Two launchers that could drift would be two commands: everything but the comments is the same.
  const code = (name: string) => fs.readFileSync(launcher(name), "utf8").split("\n").filter((l) => !l.startsWith("//") || l.startsWith("#!")).join("\n");
  assert.equal(code("ordane.mjs"), code("mesh.mjs"));

  const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
  assert.match(dockerfile, /ln -s \/app\/apps\/mesh-cli\/bin\/ordane\.mjs \/usr\/local\/bin\/ordane/, "the image puts `ordane` on the path");
  assert.match(dockerfile, /ln -s \/app\/apps\/mesh-cli\/bin\/mesh\.mjs \/usr\/local\/bin\/mesh/, "and keeps `mesh`");
});
