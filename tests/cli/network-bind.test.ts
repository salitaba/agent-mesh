/**
 * `--bind`, `--version`, and what the CLI does when the server refuses to listen.
 *
 * The refusal itself is `assertSafeListen` (tests/server/web-security.test.ts); what belongs here is
 * what an operator or a service manager sees: one line saying what to do, and an exit code (78,
 * EX_CONFIG) that tells "will never start as configured" from a crash.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { main, packageVersion, unknownFlagWarnings } from "../../apps/mesh-cli/src/index";
import { testConfigYaml } from "../helpers";

const root = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "package.json"), "utf8")) as { version: string };

/** Run `main` with console output captured and the listen-related environment pinned. */
async function run(argv: string[], env: Record<string, string | undefined> = {}): Promise<{ code: number; out: string; err: string }> {
  const saved: Record<string, string | undefined> = {};
  for (const key of ["MESH_API_TOKEN", "MESH_ALLOW_INSECURE_BIND"]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) if (value !== undefined) process.env[key] = value;
  const out: string[] = [];
  const err: string[] = [];
  const realLog = console.log;
  const realErr = console.error;
  const realWarn = console.warn;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  console.warn = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    const code = await main(argv);
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = realLog;
    console.error = realErr;
    console.warn = realWarn;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function meshFile(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-cli-bind-"));
  const file = path.join(dir, "mesh.yaml");
  fs.writeFileSync(file, testConfigYaml({ agents: [{ id: "a", role: "r", interests: [] }], mayContact: { a: [] } }), "utf8");
  return { dir, file };
}

test("--version, -v and `version` print the package version and exit 0", async () => {
  assert.equal(packageVersion(), root.version, "the version the CLI reports is the one in package.json");
  for (const flag of ["--version", "-v", "version"]) {
    const r = await run([flag]);
    assert.equal(r.code, 0, flag);
    assert.equal(r.out, `agent-mesh ${root.version}`, flag);
  }
});

test("--bind is a flag the launch commands read, so it draws no unknown-flag warning", () => {
  for (const command of ["run", "serve", "up", "console", "ui"]) {
    assert.deepEqual(unknownFlagWarnings(command, { bind: "0.0.0.0", port: "7421" }), [], command);
  }
});

test("`mesh serve --bind 0.0.0.0` with no token exits 78 with the fix in one line, and starts nothing", async () => {
  const { dir, file } = meshFile();
  try {
    const r = await run(["serve", file, "--bind", "0.0.0.0", "--port", "0"]);
    assert.equal(r.code, 78);
    assert.match(r.err, /^mesh serve: refusing to listen on 0\.0\.0\.0: MESH_API_TOKEN is not set/m);
    assert.match(r.err, /openssl rand -hex 32/);
    assert.equal(fs.existsSync(path.join(dir, ".mesh")), false, "no state directory was created");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a blank or short token is refused the same way, naming which it was", async () => {
  const { dir, file } = meshFile();
  try {
    const blank = await run(["serve", file, "--bind", "0.0.0.0", "--port", "0"], { MESH_API_TOKEN: "" });
    assert.equal(blank.code, 78);
    assert.match(blank.err, /set but empty/);
    const short = await run(["console", file, "--bind", "10.0.0.5", "--port", "0"], { MESH_API_TOKEN: "hunter2" });
    assert.equal(short.code, 78);
    assert.match(short.err, /7 characters/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("`mesh host --bind 0.0.0.0` with no token exits 78 as well, without touching the registry home", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-cli-hostbind-"));
  const home = path.join(dir, "home");
  try {
    const r = await run(["host", "--bind", "0.0.0.0", "--port", "0", "--home", home]);
    assert.equal(r.code, 78);
    assert.match(r.err, /^mesh host: refusing to listen on 0\.0\.0\.0/m);
    assert.equal(fs.existsSync(home), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
