/**
 * The container's entrypoint, run for real.
 *
 * The image puts the compiled code at /app/dist; here it is the build beside the tests, so the script under test
 * is a copy with that one path changed and nothing else. It is what decides whether an instance may start
 * (never network-reachable without a token), what the agents inherit from the environment (an empty variable is
 * not a credential), and what `demo` does for someone with no API key.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const SCRIPT = path.join(ROOT, "deploy", "docker", "entrypoint.sh");

function entrypoint(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-entry-"));
  const copy = path.join(dir, "entrypoint.sh");
  const source = fs.readFileSync(SCRIPT, "utf8");
  assert.ok(source.includes("/app/dist/apps/mesh-cli/src/index.js"), "the script runs the CLI from /app/dist");
  fs.writeFileSync(copy, source.replace("/app/dist", path.join(ROOT, "dist")), { mode: 0o755 });
  return copy;
}

function run(args: string[], env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("sh", [entrypoint(), ...args], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8", timeout: 30_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

test("a server reachable from the network will not start without a token, and says how to fix it", () => {
  for (const mode of ["host", "serve", "demo"]) {
    const r = run([mode], { MESH_BIND: "0.0.0.0", MESH_PORT: "7420" });
    assert.equal(r.status, 78, `${mode}: EX_CONFIG`);
    assert.match(r.stderr, /MESH_API_TOKEN is not set, and the server would listen on 0\.0\.0\.0:7420/, mode);
    assert.match(r.stderr, /openssl rand -hex 32/, "and the way out");
  }
});

test("the explicit insecure door is the only other way past it, and loopback needs no token", () => {
  // `serve` with no MESH_CONFIG fails for the next reason, which proves the token check was passed.
  const loop = run(["serve"], { MESH_BIND: "127.0.0.1" });
  assert.equal(loop.status, 78);
  assert.match(loop.stderr, /MESH_CONFIG must name the mesh\.yaml/);
  const door = run(["serve"], { MESH_BIND: "0.0.0.0", MESH_ALLOW_INSECURE_BIND: "1" });
  assert.match(door.stderr, /MESH_CONFIG must name the mesh\.yaml/, "MESH_ALLOW_INSECURE_BIND=1 is a deliberate choice");
});

test("an empty setting is not set: nothing blank is handed to the agents as a credential", () => {
  const probe = ["sh", "-c", 'echo "key=${ANTHROPIC_API_KEY+set} lic=${MESH_LICENSE+set} hosts=${MESH_ALLOWED_HOSTS+set} keep=${MESH_INSTANCE_ID-unset}"'];
  const blank = run(probe, { ANTHROPIC_API_KEY: "", MESH_LICENSE: "", MESH_ALLOWED_HOSTS: "", MESH_INSTANCE_ID: "" });
  assert.equal(blank.stdout.trim(), "key= lic= hosts= keep=", "blank credentials are gone; a blank variable the script does not own is left alone");
  const filled = run(probe, { ANTHROPIC_API_KEY: "sk-ant-x", MESH_LICENSE: "AML1.x", MESH_ALLOWED_HOSTS: "mesh.example.com" });
  assert.equal(filled.stdout.trim(), "key=set lic=set hosts=set keep=unset");
});

test("anything else is executed as given", () => {
  const r = run(["sh", "-c", "echo hello from $0"], {});
  assert.equal(r.status, 0);
  assert.match(r.stdout, /hello from/);
});

test("demo scaffolds the shipped demo, registers it, and serves it, with no API key", { timeout: 60_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-entry-demo-"));
  const port = await freePort();
  const token = "t".repeat(40);
  const env = { PATH: process.env.PATH, MESH_BIND: "127.0.0.1", MESH_PORT: String(port), MESH_HOME: path.join(home, "home"), MESH_PROJECTS_ROOT: path.join(home, "projects"), MESH_API_TOKEN: token, HOME: home };
  const child = spawn("sh", [entrypoint(), "demo", "--no-git"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (d: Buffer) => (log += d));
  child.stderr.on("data", (d: Buffer) => (log += d));
  try {
    const base = `http://127.0.0.1:${port}`;
    let healthy = false;
    for (let i = 0; i < 100 && !healthy; i++) {
      healthy = await fetch(`${base}/healthz`).then((r) => r.ok, () => false);
      if (!healthy) await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(healthy, `the host did not come up:\n${log}`);
    assert.match(log, /demo project ready at .*demo-stub/);
    assert.ok(fs.existsSync(path.join(home, "projects", "demo-stub", "mesh.yaml")), "scaffolded under the projects root");
    assert.ok(fs.existsSync(path.join(home, "projects", "demo-stub", "roles", "pm.md")), "with its own role prompts");

    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const projects = (await (await fetch(`${base}/api/projects`, { headers: auth })).json()) as { projects: Array<{ id: string }> };
    assert.deepEqual(projects.projects.map((p) => p.id), ["demo-stub"], "registered before the host came up");
    const opened = (await (await fetch(`${base}/api/projects/demo-stub/open`, { method: "POST", headers: auth, body: "{}" })).json()) as { status: string };
    assert.equal(opened.status, "open", "and it opens with no ANTHROPIC_API_KEY in the environment");
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 1500));
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

test("a second demo start finds its project already there and changes nothing", { timeout: 60_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-entry-demo2-"));
  const projects = path.join(home, "projects");
  const meshHome = path.join(home, "home");
  const env = { MESH_BIND: "127.0.0.1", MESH_PORT: "99999", MESH_HOME: meshHome, MESH_PROJECTS_ROOT: projects, MESH_API_TOKEN: "t".repeat(40), HOME: home };
  // Run only the setup half: 99999 is not a port, so the host refuses to listen right after scaffolding and registering.
  // (Not port 1: as root that would bind, and the test would wait out its timeout for a host that never stops.)
  const first = run(["demo"], env);
  assert.match(first.stderr, /demo project ready/, first.stderr);
  const yaml = path.join(projects, "demo-stub", "mesh.yaml");
  assert.ok(fs.existsSync(yaml));
  fs.appendFileSync(yaml, "\n# the operator's edit\n");
  const before = fs.readFileSync(yaml, "utf8");
  const second = run(["demo"], env);
  assert.match(second.stderr, /demo project ready/, "the second start gets as far as the host, it does not stop at 'already exists'");
  assert.notEqual(second.status, 78, "and is not an EX_CONFIG refusal of its own");
  assert.equal(fs.readFileSync(yaml, "utf8"), before, "an existing demo project is never overwritten");
  const registry = JSON.parse(fs.readFileSync(path.join(meshHome, "projects.json"), "utf8")) as { projects: unknown[] };
  assert.equal(registry.projects.length, 1, "and is registered once");
});
