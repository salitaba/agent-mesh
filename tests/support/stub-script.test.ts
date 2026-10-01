import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { writeStubScript } from "./stub-script";

/**
 * A stub script a test spawns is CommonJS wherever it is written.
 *
 * A seat of the seventh cronlite run wrote its product's package.json (`"type": "module"`) to /tmp/package.json
 * from its shell. Node decides what a `.js` file is from the nearest package.json above it, so every
 * `require`-using stub the host and CLI tests wrote under os.tmpdir() became an ES module and crashed:
 * thirty tests failed, and one file's process stayed up for twenty minutes.
 */

const SOURCE = `const os = require("os"); process.stdout.write("stub ran on " + os.platform());\n`;

function tmpWithModulePackage(): { dir: string; done(): void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-stub-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "stray", type: "module" }), "utf8");
  const dir = path.join(root, "nested");
  fs.mkdirSync(dir);
  return { dir, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const run = (file: string) => spawnSync(process.execPath, [file], { encoding: "utf8" });

test("a stub written under a package.json that says \"type\": \"module\" still runs as CommonJS", () => {
  const { dir, done } = tmpWithModulePackage();
  try {
    const file = writeStubScript(dir, "child", SOURCE);
    assert.equal(path.extname(file), ".cjs");
    const res = run(file);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, `stub ran on ${os.platform()}`);
  } finally {
    done();
  }
});

test("the same source as a .js file does not: that is what the stray package.json did", () => {
  const { dir, done } = tmpWithModulePackage();
  try {
    const file = path.join(dir, "child.js");
    fs.writeFileSync(file, SOURCE, "utf8");
    const res = run(file);
    assert.notEqual(res.status, 0);
    assert.match(res.stderr, /require is not defined in ES module scope/);
  } finally {
    done();
  }
});
