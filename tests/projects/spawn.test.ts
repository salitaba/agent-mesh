import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import {
  ChildProcessSupervisor,
  FileProjectRegistry,
  PIDFILE_NAME,
  killPidWithEscalation,
  mintChildToken,
  type ProjectRef,
} from "../../packages/projects/src/index";
import { isPublicPath, isStrictAuth, requireAuth } from "../../apps/mesh-server/src/auth";
import { testConfigYaml } from "../helpers";

const AGENTS = { agents: [{ id: "a", role: "r", interests: [] }], mayContact: { a: [] } };

/** Spawning a real mesh child boots a whole runtime; allow for a cold start. */
const SPAWN_TIMEOUT_MS = 60_000;

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mesh-spawn-"));
}

function makeProject(base: string, folder: string, id: string, yaml?: string): ProjectRef {
  const dir = path.join(base, folder);
  fs.mkdirSync(dir, { recursive: true });
  const body = yaml ?? `project:\n  id: ${id}\n${testConfigYaml(AGENTS)}`;
  fs.writeFileSync(path.join(dir, "mesh.yaml"), body, "utf8");
  const root = fs.realpathSync(dir);
  return { id, name: id, root, configPath: path.join(root, "mesh.yaml"), addedAt: new Date().toISOString() };
}

function childScript(): string {
  // Tests run from compiled output, so the built child entrypoint exists.
  return path.resolve(process.cwd(), "dist", "apps", "mesh-server", "src", "child.js");
}

function makeSupervisor(overrides: Partial<ConstructorParameters<typeof ChildProcessSupervisor>[0]> = {}): ChildProcessSupervisor {
  return new ChildProcessSupervisor({
    childScript: childScript(),
    readyTimeoutMs: SPAWN_TIMEOUT_MS,
    stopGraceMs: 5_000,
    ...overrides,
  });
}

async function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const res = await fetch(url, { headers });
  return { status: res.status, body: await res.text() };
}

test("strict auth: nothing is public and a missing token fails closed", () => {
  const before = process.env.MESH_STRICT_AUTH;
  const beforeToken = process.env.MESH_API_TOKEN;
  try {
    delete process.env.MESH_STRICT_AUTH;
    process.env.MESH_API_TOKEN = "operator";
    assert.equal(isStrictAuth(), false);
    assert.equal(isPublicPath("GET", ["health"]), true, "standalone serve keeps a credential-free probe");

    process.env.MESH_STRICT_AUTH = "1";
    assert.equal(isStrictAuth(), true);
    for (const parts of [["health"], [], ["dashboard"], ["assets", "index.js"]]) {
      assert.equal(isPublicPath("GET", parts), false, `/${parts.join("/")} must not be public in a child`);
    }

    const url = new URL("http://127.0.0.1/health");
    const req = { method: "GET", headers: {} } as never;
    assert.equal(requireAuth(req, url, ["health"]).ok, false, "an unauthenticated probe must be rejected");

    const authed = { method: "GET", headers: { authorization: "Bearer operator" } } as never;
    assert.equal(requireAuth(authed, url, ["health"]).ok, true);

    const wrong = { method: "GET", headers: { authorization: "Bearer nope" } } as never;
    assert.equal(requireAuth(wrong, url, ["health"]).ok, false);

    // Strict mode with no token configured must refuse, not serve wide open:
    // that is the exact failure strict mode exists to prevent.
    delete process.env.MESH_API_TOKEN;
    const open = requireAuth(authed, url, ["health"]);
    assert.equal(open.ok, false);
    assert.match(open.error ?? "", /misconfigured/);
  } finally {
    if (before === undefined) delete process.env.MESH_STRICT_AUTH;
    else process.env.MESH_STRICT_AUTH = before;
    if (beforeToken === undefined) delete process.env.MESH_API_TOKEN;
    else process.env.MESH_API_TOKEN = beforeToken;
  }
});

test("child tokens are unguessable and never repeat", () => {
  const tokens = new Set(Array.from({ length: 64 }, () => mintChildToken()));
  assert.equal(tokens.size, 64, "a reused token would let a stale client drive a fresh child");
  for (const t of tokens) assert.match(t, /^[0-9a-f]{64}$/);
});

test("launch spawns a child on loopback and reports its port", { timeout: SPAWN_TIMEOUT_MS + 20_000 }, async () => {
  const base = tmpRoot();
  const ref = makeProject(base, "spawned", "spawned");
  const supervisor = makeSupervisor();
  try {
    const result = await supervisor.launch(ref);
    assert.equal(result.status, "open", `launch failed: ${JSON.stringify(result.error)}`);
    assert.ok(result.endpoint, "an open child must report an endpoint to proxy to");
    assert.ok(result.endpoint!.port > 0);
    assert.ok(result.pid && result.pid !== process.pid, "the child must be a separate process");

    const child = supervisor.running("spawned");
    assert.ok(child);
    assert.equal(child!.token, result.endpoint!.token);

    // The port is real and the mesh behind it is live.
    const health = await get(`${child!.url}/health`, { authorization: `Bearer ${child!.token}` });
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.body).ok, true);
  } finally {
    await supervisor.stopAll();
  }
});

test("a child rejects unauthenticated callers on every route", { timeout: SPAWN_TIMEOUT_MS + 20_000 }, async () => {
  const base = tmpRoot();
  const ref = makeProject(base, "guarded", "guarded");
  const supervisor = makeSupervisor();
  try {
    const result = await supervisor.launch(ref);
    assert.equal(result.status, "open", `launch failed: ${JSON.stringify(result.error)}`);
    const child = supervisor.running("guarded")!;

    // Any other local process can reach the port; only the host has the token.
    // Without this, agent-authored shell commands could drive the mesh directly.
    for (const route of ["/health", "/status", "/events"]) {
      const anon = await get(`${child.url}${route}`);
      assert.equal(anon.status, 401, `${route} must not be reachable without the child token`);
    }
    const wrong = await get(`${child.url}/health`, { authorization: `Bearer ${mintChildToken()}` });
    assert.equal(wrong.status, 401);

    const ok = await get(`${child.url}/health`, { authorization: `Bearer ${child.token}` });
    assert.equal(ok.status, 200);
  } finally {
    await supervisor.stopAll();
  }
});

test("the child token is passed by environment, never on argv", { timeout: SPAWN_TIMEOUT_MS + 20_000 }, async () => {
  const base = tmpRoot();
  const ref = makeProject(base, "hidden", "hidden");
  const supervisor = makeSupervisor();
  try {
    const result = await supervisor.launch(ref);
    assert.equal(result.status, "open", `launch failed: ${JSON.stringify(result.error)}`);
    const token = result.endpoint!.token;

    // /proc/<pid>/cmdline is what `ps` reads: world-readable on every process.
    const cmdline = fs.readFileSync(`/proc/${result.pid}/cmdline`, "utf8");
    assert.ok(!cmdline.includes(token), "the bearer token must not appear in the child's argv");
  } finally {
    await supervisor.stopAll();
  }
});

test("stop lets the child shut down cleanly, releasing its state lock", { timeout: SPAWN_TIMEOUT_MS + 20_000 }, async () => {
  const base = tmpRoot();
  const ref = makeProject(base, "closeable", "closeable");
  const supervisor = makeSupervisor();
  const exits: Array<{ expected: boolean }> = [];
  const sup = makeSupervisor({ onExit: (info) => exits.push({ expected: info.expected }) });
  void supervisor;
  try {
    const first = await sup.launch(ref);
    assert.equal(first.status, "open", `launch failed: ${JSON.stringify(first.error)}`);
    const pid = first.pid!;

    await sup.stop(ref);
    assert.deepEqual(sup.runningIds(), []);
    assert.equal(exits.length, 1);
    assert.equal(exits[0].expected, true, "an operator close is not a crash");
    assert.throws(() => process.kill(pid, 0), "the child process must be gone");

    // The lock was released on the clean path, so the project reopens. If the
    // child had been SIGKILLed with no cleanup, this would come back `locked`.
    const second = await sup.launch(ref);
    assert.equal(second.status, "open", `reopen failed: ${JSON.stringify(second.error)}`);
    assert.notEqual(second.pid, pid);
  } finally {
    await sup.stopAll();
  }
});

test("a second child on the same state dir reports locked, not crashed", { timeout: SPAWN_TIMEOUT_MS + 30_000 }, async () => {
  const base = tmpRoot();
  const ref = makeProject(base, "contested", "contested");
  const a = makeSupervisor();
  const b = makeSupervisor();
  try {
    const first = await a.launch(ref);
    assert.equal(first.status, "open", `launch failed: ${JSON.stringify(first.error)}`);

    // A different supervisor, same folder: exactly the "registry entry plus a
    // stray mesh run" case. Two writers on one event log is unrecoverable, so
    // the second must refuse rather than interleave.
    const second = await b.launch(ref);
    assert.equal(second.status, "locked");
    assert.equal(second.error?.reason, "locked");
    assert.deepEqual(b.runningIds(), [], "a child that failed to boot must not be tracked");

    // The winner is untouched.
    const child = a.running("contested")!;
    const health = await get(`${child.url}/health`, { authorization: `Bearer ${child.token}` });
    assert.equal(health.status, 200);
  } finally {
    await a.stopAll();
    await b.stopAll();
  }
});

test("an invalid config is a non-restartable error, not a crash", { timeout: SPAWN_TIMEOUT_MS + 20_000 }, async () => {
  const base = tmpRoot();
  const ref = makeProject(base, "broken", "broken", "version: 1\nmesh: {}\n");
  const supervisor = makeSupervisor({ readyTimeoutMs: 20_000 });
  try {
    const result = await supervisor.launch(ref);
    // 'crashed' would make step 4 restart it forever; a bad config never fixes
    // itself by being retried.
    assert.equal(result.status, "error");
    assert.equal(result.error?.reason, "invalid_config");
    assert.ok(result.error?.detail);
    assert.deepEqual(supervisor.runningIds(), []);
  } finally {
    await supervisor.stopAll();
  }
});

test("a child that never signals ready times out as crashed", async () => {
  const base = tmpRoot();
  const ref = makeProject(base, "silent", "silent");
  // A script that binds nothing and says nothing: the hang case.
  const stub = path.join(base, "silent-child.js");
  fs.writeFileSync(stub, "setTimeout(() => {}, 60000);\n", "utf8");
  const supervisor = makeSupervisor({ childScript: stub, readyTimeoutMs: 300 });
  const result = await supervisor.launch(ref);
  assert.equal(result.status, "crashed");
  assert.equal(result.error?.reason, "timeout");
  assert.deepEqual(supervisor.runningIds(), [], "a hung child must not present as an open tab");
  await supervisor.stopAll();
});

test("a child that exits before ready is reported with its stderr", async () => {
  const base = tmpRoot();
  const ref = makeProject(base, "exiting", "exiting");
  const stub = path.join(base, "exiting-child.js");
  fs.writeFileSync(stub, "console.error('boot failed: disk on fire');\nprocess.exit(3);\n", "utf8");
  const supervisor = makeSupervisor({ childScript: stub, readyTimeoutMs: 10_000 });
  const result = await supervisor.launch(ref);
  assert.equal(result.status, "crashed");
  assert.match(result.error?.detail ?? "", /disk on fire/, "the user needs the reason, not just a code");
  await supervisor.stopAll();
});

test("launching an already-running project returns the same child", { timeout: SPAWN_TIMEOUT_MS + 20_000 }, async () => {
  const base = tmpRoot();
  const ref = makeProject(base, "idempotent", "idempotent");
  const supervisor = makeSupervisor();
  try {
    const first = await supervisor.launch(ref);
    assert.equal(first.status, "open", `launch failed: ${JSON.stringify(first.error)}`);
    const again = await supervisor.launch(ref);
    assert.equal(again.pid, first.pid, "a double open must not spawn a second child");
    assert.equal(again.endpoint?.port, first.endpoint?.port);
    assert.equal(supervisor.runningIds().length, 1);
  } finally {
    await supervisor.stopAll();
  }
});

test("stop is idempotent and safe for a project that never launched", async () => {
  const base = tmpRoot();
  const ref = makeProject(base, "never", "never");
  const supervisor = makeSupervisor();
  await supervisor.stop(ref);
  await supervisor.stopAll();
  assert.deepEqual(supervisor.runningIds(), []);
});

test("a running child writes a pidfile and removes it on clean stop", { timeout: SPAWN_TIMEOUT_MS + 20_000 }, async () => {
  const base = tmpRoot();
  const ref = makeProject(base, "tracked", "tracked");
  const supervisor = makeSupervisor();
  const pidFile = path.join(ref.root, ".mesh", PIDFILE_NAME);
  try {
    const result = await supervisor.launch(ref);
    assert.equal(result.status, "open", `launch failed: ${JSON.stringify(result.error)}`);
    const record = JSON.parse(fs.readFileSync(pidFile, "utf8"));
    assert.equal(record.pid, result.pid);
    assert.equal(record.projectId, "tracked");
    assert.equal(record.hostPid, process.pid);

    await supervisor.stop(ref);
    assert.equal(fs.existsSync(pidFile), false, "a stale pidfile would look like an orphan on the next host start");
  } finally {
    await supervisor.stopAll();
  }
});

test("orphan sweep reaps a child stranded by a SIGKILLed host", async () => {
  const base = tmpRoot();
  const ref = makeProject(base, "orphaned", "orphaned");
  // Stand in for a mesh child whose host died: a live process recorded in a
  // pidfile that no supervisor is tracking.
  const stray = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000);"], { stdio: "ignore" });
  const pidFile = path.join(ref.root, ".mesh", PIDFILE_NAME);
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, JSON.stringify({ pid: stray.pid, projectId: ref.id, hostPid: 999999 }), "utf8");

  const supervisor = makeSupervisor({ stopGraceMs: 1_000 });
  const reaped = await supervisor.sweepOrphans([ref]);
  assert.deepEqual(reaped, ["orphaned"], "a stranded child still holds the state lock");
  assert.throws(() => process.kill(stray.pid!, 0));
  assert.equal(fs.existsSync(pidFile), false);

  // Sweeping again is a no-op rather than an error.
  assert.deepEqual(await supervisor.sweepOrphans([ref]), []);
});

test("orphan sweep discards dead and unparseable pidfiles without killing anything", async () => {
  const base = tmpRoot();
  const dead = makeProject(base, "dead", "dead");
  const junk = makeProject(base, "junk", "junk");
  const none = makeProject(base, "none", "none");

  const deadFile = path.join(dead.root, ".mesh", PIDFILE_NAME);
  fs.mkdirSync(path.dirname(deadFile), { recursive: true });
  fs.writeFileSync(deadFile, JSON.stringify({ pid: 999999, projectId: "dead" }), "utf8");

  const junkFile = path.join(junk.root, ".mesh", PIDFILE_NAME);
  fs.mkdirSync(path.dirname(junkFile), { recursive: true });
  fs.writeFileSync(junkFile, "not json at all", "utf8");

  const supervisor = makeSupervisor();
  assert.deepEqual(await supervisor.sweepOrphans([dead, junk, none]), []);
  assert.equal(fs.existsSync(deadFile), false, "debris is cleared so it is not re-examined every boot");
  assert.equal(fs.existsSync(junkFile), false);
});

test("killPidWithEscalation escalates to SIGKILL for a child ignoring SIGTERM", async () => {
  const stubborn = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60000);"],
    { stdio: "ignore" },
  );
  // Give the handler time to install, or the default SIGTERM disposition wins
  // and the test proves nothing.
  await new Promise((r) => setTimeout(r, 300));
  const started = Date.now();
  await killPidWithEscalation(stubborn.pid!, 400);
  assert.ok(Date.now() - started >= 400, "SIGKILL must come only after the grace period");
  assert.throws(() => process.kill(stubborn.pid!, 0), "a child that ignores SIGTERM is still killed");
});

test("killPidWithEscalation resolves for an already-dead pid", async () => {
  const gone = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((r) => gone.once("exit", r));
  await killPidWithEscalation(gone.pid!, 100);
  await killPidWithEscalation(999999, 100);
});

test("registry + supervisor: open and close a real project end to end", { timeout: SPAWN_TIMEOUT_MS + 30_000 }, async () => {
  const base = tmpRoot();
  const home = path.join(base, "home");
  makeProject(base, "wired", "wired");
  const supervisor = makeSupervisor();
  const registry = new FileProjectRegistry({ home, supervisor });
  try {
    const ref = await registry.add(path.join(base, "wired"));
    assert.equal(ref.id, "wired");
    assert.deepEqual(registry.openIds(), [], "add still does not boot");

    const handle = await registry.open("wired");
    assert.equal(handle.status, "open", `open failed: ${JSON.stringify(handle.error)}`);
    assert.ok(handle.endpoint?.port);
    assert.ok(handle.pid);
    assert.deepEqual(registry.openIds(), ["wired"]);

    const health = await get(`http://127.0.0.1:${handle.endpoint!.port}/health`, {
      authorization: `Bearer ${handle.endpoint!.token}`,
    });
    assert.equal(health.status, 200);

    await registry.close("wired");
    assert.deepEqual(registry.openIds(), []);
    assert.equal(registry.get("wired")?.status, "closed");
    // The entry survives the close: closing a tab is not removing a project.
    assert.equal(registry.list().length, 1);
  } finally {
    await supervisor.stopAll();
  }
});

test("two projects run side by side and killing one leaves the other intact", { timeout: SPAWN_TIMEOUT_MS + 40_000 }, async () => {
  const base = tmpRoot();
  const home = path.join(base, "home");
  makeProject(base, "alpha", "alpha");
  makeProject(base, "beta", "beta");
  const supervisor = makeSupervisor();
  const registry = new FileProjectRegistry({ home, supervisor });
  try {
    await registry.add(path.join(base, "alpha"));
    await registry.add(path.join(base, "beta"));
    const a = await registry.open("alpha");
    const b = await registry.open("beta");
    assert.equal(a.status, "open", `alpha failed: ${JSON.stringify(a.error)}`);
    assert.equal(b.status, "open", `beta failed: ${JSON.stringify(b.error)}`);
    assert.notEqual(a.endpoint!.port, b.endpoint!.port, "each child owns its own ephemeral port");
    assert.notEqual(a.endpoint!.token, b.endpoint!.token, "one token must not unlock another project");
    assert.notEqual(a.pid, b.pid);

    // Alpha's token must not work against beta: isolation is per child.
    const crossed = await get(`http://127.0.0.1:${b.endpoint!.port}/health`, {
      authorization: `Bearer ${a.endpoint!.token}`,
    });
    assert.equal(crossed.status, 401);

    // Hard-kill alpha, the way an OOM would.
    process.kill(a.pid!, "SIGKILL");
    await new Promise((r) => setTimeout(r, 500));

    // Fault containment is the entire reason for child processes.
    const survivor = await get(`http://127.0.0.1:${b.endpoint!.port}/health`, {
      authorization: `Bearer ${b.endpoint!.token}`,
    });
    assert.equal(survivor.status, 200, "one project dying must not take the others with it");
    assert.equal(JSON.parse(survivor.body).ok, true);
  } finally {
    await supervisor.stopAll();
  }
});
