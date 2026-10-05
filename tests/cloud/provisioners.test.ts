import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  ContainerProvisioner,
  LocalProcessProvisioner,
  killLiveHosts,
  ProcessRunner,
  ProvisionError,
  waitUntilReady,
  type CommandResult,
  type CommandRunner,
  type WorkspaceSpec,
} from "../../packages/cloud/src/index";

const spec = (over: Partial<WorkspaceSpec> = {}): WorkspaceSpec => ({
  workspaceId: "ws_abc123",
  accountId: "acct_1",
  slug: "main-abc123",
  plan: "team",
  licence: "AML1.k1.PAYLOAD.SIGNATURE",
  operatorToken: "operator-token-SECRET",
  gateway: { baseUrl: "http://gateway.internal:8080/v1", key: "curule_vk_000000000000_KEYSECRET" },
  limits: { cpus: 1, memoryMb: 2048, pids: 512 },
  ...over,
});

class FakeRunner implements CommandRunner {
  readonly calls: Array<{ command: string; args: string[]; env: Record<string, string> | undefined }> = [];
  /** Answers by the first word after the engine's name; anything not listed succeeds. */
  answers: Array<(args: string[]) => CommandResult | undefined> = [];
  async run(command: string, args: string[], options?: { env?: Record<string, string> }): Promise<CommandResult> {
    this.calls.push({ command, args, env: options?.env });
    for (const answer of this.answers) {
      const r = answer(args);
      if (r) return r;
    }
    return { code: 0, stdout: "", stderr: "" };
  }
  get verbs(): string[] {
    return this.calls.map((c) => c.args.slice(0, c.args[0] === "volume" ? 2 : 1).join(" "));
  }
}
const fails = (verb: string, stderr: string, code = 1) => (args: string[]): CommandResult | undefined => (args.join(" ").startsWith(verb) ? { code, stdout: "", stderr } : undefined);

const container = (runner: FakeRunner, over: Partial<ConstructorParameters<typeof ContainerProvisioner>[0]> = {}) => new ContainerProvisioner({ runner, image: "curule:2026.10", network: "curule-workspaces", ...over });

// ---- the container provisioner ----

test("a container is asked for with every restriction that makes it a boundary, and nothing else", () => {
  const { args } = container(new FakeRunner()).runArguments(spec());
  assert.deepEqual(args, [
    "run", "--detach",
    "--name", "curule-ws-ws_abc123",
    "--hostname", "curule-ws-ws_abc123",
    "--network", "curule-workspaces",
    "--read-only",
    "--tmpfs", "/tmp:rw,nosuid,size=512m",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--user", "10001:10001",
    "--pids-limit", "512",
    "--memory", "2048m",
    "--memory-swap", "2048m",
    "--cpus", "1",
    "--stop-timeout", "20",
    "--restart", "unless-stopped",
    "--volume", "curule-ws-ws_abc123:/data",
    "--label", "curule.workspace=ws_abc123",
    "--label", "curule.account=acct_1",
    "--env", "MESH_PORT=7420",
    "--env", "MESH_BIND=0.0.0.0",
    "--env", "MESH_TRUST_PROXY=1",
    "--env", "MESH_COOKIE_SECURE=1",
    "--env", "MESH_LICENSE_ENFORCEMENT=enforce",
    "--env", "CURULE_GATEWAY_URL=http://gateway.internal:8080/v1",
    "--env", "MESH_API_TOKEN",
    "--env", "CURULE_GATEWAY_KEY",
    "--env", "MESH_LICENSE",
    "curule:2026.10",
    "host",
  ]);
});

test("a secret is passed to the engine by name, and its value is in the environment of that one command and in no argument", () => {
  const { args, env } = container(new FakeRunner()).runArguments(spec());
  assert.deepEqual(env, { MESH_API_TOKEN: "operator-token-SECRET", CURULE_GATEWAY_KEY: "curule_vk_000000000000_KEYSECRET", MESH_LICENSE: "AML1.k1.PAYLOAD.SIGNATURE" });
  const everything = args.join("\n");
  for (const secret of Object.values(env)) assert.ok(!everything.includes(secret), `a secret is in the arguments, which any process on the machine can read`);
  const noLicence = container(new FakeRunner()).runArguments(spec({ licence: undefined }));
  assert.equal("MESH_LICENSE" in noLicence.env, false);
  assert.ok(!noLicence.args.includes("MESH_LICENSE"));
});

test("the operator's own environment is added by name and cannot replace the credentials the workspace was made with", () => {
  const { args, env } = container(new FakeRunner()).runArguments(spec({ env: { EXTRA: "1", MESH_API_TOKEN: "evil", CURULE_GATEWAY_KEY: "evil" } }));
  assert.equal(env.EXTRA, "1");
  assert.equal(env.MESH_API_TOKEN, "operator-token-SECRET");
  assert.equal(env.CURULE_GATEWAY_KEY, "curule_vk_000000000000_KEYSECRET");
  assert.ok(args.includes("EXTRA"));
});

test("a workspace is told the one address it is served on and the proxy it must use, when the operator has a domain and an egress proxy", () => {
  const { args } = container(new FakeRunner(), { apexDomain: "ws.example.com", egressProxy: "http://egress.internal:3128", noProxy: ["gateway.internal"] }).runArguments(spec());
  const envs = args.flatMap((a, i) => (args[i - 1] === "--env" ? [a] : []));
  assert.ok(envs.includes("MESH_ALLOWED_HOSTS=main-abc123.ws.example.com"));
  assert.ok(envs.includes("MESH_ALLOWED_ORIGINS=https://main-abc123.ws.example.com"));
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]) assert.ok(envs.includes(`${name}=http://egress.internal:3128`), name);
  for (const name of ["NO_PROXY", "no_proxy"]) assert.ok(envs.includes(`${name}=gateway.internal,localhost,127.0.0.1`), name);
  assert.ok(envs.includes("NODE_USE_ENV_PROXY=1"));
  const plain = container(new FakeRunner()).runArguments(spec()).args.join(" ");
  assert.ok(!/HTTPS?_PROXY|NO_PROXY|NODE_USE_ENV_PROXY|MESH_ALLOWED/i.test(plain), "with neither configured, neither is set");
  assert.ok(plain.includes("MESH_TRUST_PROXY=1"), "the host is always told it sits behind the service's proxy");
});

test("the engine, the user, the port, the name prefix and the stop timeout can be set", () => {
  const { args } = container(new FakeRunner(), { engine: "podman", uid: 20001, port: 8000, namePrefix: "ws-", stopTimeoutSeconds: 5, network: "internal-net", image: "registry.example/curule@sha256:abc" }).runArguments(spec({ limits: { cpus: 0.5, memoryMb: 512, pids: 64 } }));
  const after = (flag: string): string => args[args.indexOf(flag) + 1]!;
  assert.equal(after("--name"), "ws-ws_abc123");
  assert.equal(after("--user"), "20001:20001");
  assert.equal(after("--stop-timeout"), "5");
  assert.equal(after("--network"), "internal-net");
  assert.equal(after("--cpus"), "0.5");
  assert.equal(after("--memory"), "512m");
  assert.equal(after("--pids-limit"), "64");
  assert.ok(args.includes("MESH_PORT=8000"));
  assert.equal(args.at(-2), "registry.example/curule@sha256:abc");
  const runner = new FakeRunner();
  void container(runner, { engine: "podman" }).create(spec());
  assert.equal(runner.calls[0]!.command, "podman");
});

test("a workspace id that the engine could not name safely, or limits too small to run in, are refused before anything is run", async () => {
  const runner = new FakeRunner();
  const c = container(runner);
  for (const id of ["", "-flag", "--privileged", "has space", "a/b", "a;b", "x".repeat(64), ".hidden", "ws$(x)"]) {
    assert.throws(() => c.runArguments(spec({ workspaceId: id })), (err: Error) => err instanceof ProvisionError && /is not a workspace id the container engine can name/.test(err.message), JSON.stringify(id));
    await assert.rejects(() => c.create(spec({ workspaceId: id })), ProvisionError);
  }
  assert.doesNotThrow(() => c.runArguments(spec({ workspaceId: "x".repeat(63) })));
  assert.doesNotThrow(() => c.runArguments(spec({ workspaceId: "A.b_c-9" })));
  for (const limits of [{ cpus: 0, memoryMb: 2048, pids: 512 }, { cpus: -1, memoryMb: 2048, pids: 512 }, { cpus: 1, memoryMb: 127, pids: 512 }, { cpus: 1, memoryMb: 2048, pids: 31 }, { cpus: Number.NaN, memoryMb: 2048, pids: 512 }]) {
    assert.throws(() => c.runArguments(spec({ limits })), /a workspace needs at least 0\.1 of a CPU, 128 MB of memory and 32 processes/, JSON.stringify(limits));
  }
  assert.doesNotThrow(() => c.runArguments(spec({ limits: { cpus: 0.1, memoryMb: 128, pids: 32 } })));
  assert.equal(runner.calls.length, 0);
});

test("a workspace is created as a volume first and then a container that uses it, with the secrets in that one command's environment", async () => {
  const runner = new FakeRunner();
  const made = await container(runner).create(spec());
  assert.deepEqual(made, { handle: "curule-ws-ws_abc123", upstream: { host: "curule-ws-ws_abc123", port: 7420 } });
  assert.deepEqual(runner.verbs, ["volume create", "run"]);
  assert.deepEqual(runner.calls[0]!.args, ["volume", "create", "--label", "curule.workspace=ws_abc123", "curule-ws-ws_abc123"]);
  assert.equal(runner.calls[0]!.env, undefined);
  assert.equal(runner.calls[1]!.env!.MESH_API_TOKEN, "operator-token-SECRET");
  assert.ok(runner.calls.every((c) => c.command === "docker"));
});

test("a container that will not start leaves no volume behind, and the engine's own words are in the error, cut short", async () => {
  const runner = new FakeRunner();
  runner.answers.push(fails("run", `docker: Error response from daemon: ${"x".repeat(400)}`, 125));
  await assert.rejects(
    () => container(runner).create(spec()),
    (err: Error) => err instanceof ProvisionError && err.message === `docker run failed (125): docker: Error response from daemon: ${"x".repeat(300 - "docker: Error response from daemon: ".length)}`,
  );
  assert.deepEqual(runner.verbs, ["volume create", "run", "volume rm"]);
  assert.deepEqual(runner.calls[2]!.args, ["volume", "rm", "--force", "curule-ws-ws_abc123"]);
  const none = new FakeRunner();
  none.answers.push(fails("volume create", "", 1));
  await assert.rejects(() => container(none).create(spec()), /docker volume failed \(1\): no message/);
  assert.deepEqual(none.verbs, ["volume create"], "with no volume there is nothing to run or to clean up");
  const cleanup = new FakeRunner();
  cleanup.answers.push(fails("run", "no space", 125), fails("volume rm", "also failed"));
  await assert.rejects(() => container(cleanup).create(spec()), /docker run failed \(125\): no space/, "a clean-up that fails does not hide why it was needed");
});

test("a workspace is stopped, started and removed, and one that is already gone is not an error", async () => {
  const runner = new FakeRunner();
  const c = container(runner);
  await c.suspend("curule-ws-ws_abc123");
  assert.deepEqual(await c.resume("curule-ws-ws_abc123"), { handle: "curule-ws-ws_abc123", upstream: { host: "curule-ws-ws_abc123", port: 7420 } });
  await c.destroy("curule-ws-ws_abc123");
  assert.deepEqual(
    runner.calls.map((x) => x.args),
    [["stop", "curule-ws-ws_abc123"], ["start", "curule-ws-ws_abc123"], ["rm", "--force", "curule-ws-ws_abc123"], ["volume", "rm", "--force", "curule-ws-ws_abc123"]],
  );
  const gone = new FakeRunner();
  gone.answers.push(fails("stop", "Error response from daemon: No such container: x"), fails("rm", "Error: No such container: x"), fails("volume rm", "Error: No such volume: x"));
  await assert.doesNotReject(() => container(gone).suspend("x"));
  await assert.doesNotReject(() => container(gone).destroy("x"));
  const object = new FakeRunner();
  object.answers.push(fails("stop", "Error: no such object: x"));
  await assert.doesNotReject(() => container(object).suspend("x"), "podman says object, and the case does not matter");
});

test("removing a workspace and keeping its data leaves the volume alone", async () => {
  const runner = new FakeRunner();
  await container(runner).destroy("curule-ws-ws_abc123", { keepData: true });
  assert.deepEqual(runner.verbs, ["rm"]);
});

test("a failure of the engine that is not 'it is not there' is an error with the engine's words", async () => {
  const c = (answers: Array<(args: string[]) => CommandResult | undefined>) => {
    const runner = new FakeRunner();
    runner.answers.push(...answers);
    return container(runner);
  };
  await assert.rejects(() => c([fails("stop", "permission denied")]).suspend("x"), /docker stop failed \(1\): permission denied/);
  await assert.rejects(() => c([fails("start", "port is already allocated")]).resume("x"), /docker start failed \(1\): port is already allocated/);
  await assert.rejects(() => c([fails("rm", "device busy")]).destroy("x"), /docker rm failed \(1\): device busy/);
  await assert.rejects(() => c([fails("volume rm", "volume is in use")]).destroy("x"), /docker volume failed \(1\): volume is in use/);
});

test("the state of a workspace is read from the engine: running, stopped, missing, or an error when it cannot tell", async () => {
  const state = (stdout: string, stderr = "", code = 0) => {
    const runner = new FakeRunner();
    runner.answers.push(() => ({ code, stdout, stderr }));
    return { runner, c: container(runner) };
  };
  const running = state("true\n");
  assert.equal(await running.c.status("x"), "running");
  assert.deepEqual(running.runner.calls[0]!.args, ["inspect", "--format", "{{.State.Running}}", "x"]);
  assert.equal(await state("false\n").c.status("x"), "stopped");
  assert.equal(await state("", "Error: No such container: x", 1).c.status("x"), "missing");
  assert.equal(await state("", "Error: no such object: x", 1).c.status("x"), "missing");
  await assert.rejects(() => state("", "Cannot connect to the Docker daemon", 1).c.status("x"), /docker inspect failed: Cannot connect to the Docker daemon/);
});

// ---- running a command ----

test("a command is run with the secrets in its environment and in no argument, and its output and exit code are returned", async () => {
  const runner = new ProcessRunner();
  const ok = await runner.run(process.execPath, ["-e", "process.stdout.write(process.env.WS_SECRET + '|' + process.argv.slice(1).join(','))", "a", "b"], { env: { WS_SECRET: "s3cret" } });
  assert.deepEqual(ok, { code: 0, stdout: "s3cret|a,b", stderr: "" });
  const bad = await runner.run(process.execPath, ["-e", "process.stderr.write('nope'); process.exit(3)"]);
  assert.deepEqual(bad, { code: 3, stdout: "", stderr: "nope" });
  assert.equal(process.env.WS_SECRET, undefined, "the secret was in that command's environment and not in this process's");
});

test("a command that cannot be run is a provisioning error, and one that runs too long is killed", async () => {
  await assert.rejects(() => new ProcessRunner().run("/nonexistent/engine", []), (err: Error) => err instanceof ProvisionError && /could not run \/nonexistent\/engine: /.test(err.message));
  const slow = await new ProcessRunner(150).run(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"]);
  assert.notEqual(slow.code, 0, "killed, so it did not exit cleanly");
});

// ---- waiting for a host ----

test("a host is waited for until its health check answers, and the wait names why it gave up", async () => {
  const seen: string[] = [];
  let n = 0;
  const flaky = (async (url: string) => {
    seen.push(url);
    n++;
    if (n === 1) throw new Error("connect ECONNREFUSED");
    if (n === 2) return new Response("", { status: 503 });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  await waitUntilReady({ host: "curule-ws-x", port: 7420 }, { fetch: flaky, intervalMs: 1, timeoutMs: 5_000 });
  assert.deepEqual(seen, Array(3).fill("http://curule-ws-x:7420/healthz"));

  const refused = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
  await assert.rejects(() => waitUntilReady({ host: "h", port: 1 }, { fetch: refused, intervalMs: 1, timeoutMs: 30 }), (err: Error) => err instanceof ProvisionError && err.message === "the workspace did not become ready: status 503");
  const down = (async () => {
    throw new Error("getaddrinfo ENOTFOUND h");
  }) as unknown as typeof fetch;
  await assert.rejects(() => waitUntilReady({ host: "h", port: 1 }, { fetch: down, intervalMs: 1, timeoutMs: 30 }), /the workspace did not become ready: getaddrinfo ENOTFOUND h/);
  const none = (async () => new Response("", { status: 200 })) as unknown as typeof fetch;
  await assert.doesNotReject(() => waitUntilReady({ host: "h", port: 1 }, { fetch: none, timeoutMs: 0 }).catch((err: Error) => (/no answer yet/.test(err.message) ? undefined : Promise.reject(err))), "a wait of no time says it never asked");
});

// ---- the local process provisioner ----

class FakeChild extends EventEmitter {
  readonly signals: string[] = [];
  unrefs = 0;
  unref(): this {
    this.unrefs++;
    return this;
  }
  refs = 0;
  ref(): this {
    this.refs++;
    return this;
  }
  /** Whether SIGTERM ends it. */
  obeys = true;
  kill(signal: string): boolean {
    this.signals.push(signal);
    if (signal === "SIGKILL" || this.obeys) setImmediate(() => this.emit("exit", null, signal));
    return true;
  }
}

function local(options: Partial<ConstructorParameters<typeof LocalProcessProvisioner>[0]> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-provisioner-"));
  const started: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; child: FakeChild }> = [];
  let port = 41_000;
  const p = new LocalProcessProvisioner({
    baseDir: dir,
    hostCommand: ["node", "/opt/curule/cli.js"],
    production: false,
    spawn: (command, args, opts) => {
      const child = new FakeChild();
      started.push({ command, args, env: opts.env, cwd: opts.cwd, child });
      return child as unknown as ChildProcess;
    },
    freePort: async () => ++port,
    ...options,
  });
  return { dir, p, started, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("a workspace is started as a process of its own, in a directory of its own, with its credentials in its environment and a file only its owner can read", async () => {
  const l = local();
  try {
    const made = await l.p.create(spec());
    assert.deepEqual(made, { handle: "ws_abc123", upstream: { host: "127.0.0.1", port: 41_001 } });
    const [run] = l.started;
    assert.equal(run!.command, "node");
    assert.deepEqual(run!.args, ["/opt/curule/cli.js", "host", "--port", "41001", "--bind", "127.0.0.1"]);
    assert.equal(run!.cwd, path.join(l.dir, "ws_abc123"));
    const home = path.join(l.dir, "ws_abc123", "home");
    assert.equal(run!.env.MESH_HOME, home);
    assert.equal(run!.env.HOME, home);
    assert.equal(run!.env.MESH_PROJECTS_ROOT, path.join(l.dir, "ws_abc123", "projects"));
    assert.equal(run!.env.MESH_API_TOKEN, "operator-token-SECRET");
    assert.equal(run!.env.MESH_LICENSE, "AML1.k1.PAYLOAD.SIGNATURE");
    assert.equal(run!.env.MESH_LICENSE_ENFORCEMENT, "enforce");
    assert.equal(run!.env.CURULE_GATEWAY_KEY, "curule_vk_000000000000_KEYSECRET");
    assert.equal(run!.env.CURULE_GATEWAY_URL, "http://gateway.internal:8080/v1");
    assert.equal(run!.env.MESH_PORT, "41001");
    assert.equal(run!.env.MESH_BIND, "127.0.0.1");
    assert.ok(fs.existsSync(path.join(l.dir, "ws_abc123", "projects")));
    const file = path.join(l.dir, "ws_abc123", ".provision", "env.json");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).port, 41_001);
    assert.ok(!fs.readdirSync(path.join(l.dir, "ws_abc123", "projects")).length, "the credentials are not in the workspace's own projects");
  } finally {
    l.done();
  }
});

test("a local workspace's credentials cannot be replaced by the operator's own environment, and it has no licence when none is given", async () => {
  const l = local();
  try {
    await l.p.create(spec({ licence: undefined, env: { EXTRA: "1", MESH_API_TOKEN: "evil", MESH_HOME: "/elsewhere" } }));
    const env = l.started[0]!.env;
    assert.equal(env.EXTRA, "1");
    assert.equal(env.MESH_API_TOKEN, "operator-token-SECRET");
    assert.equal(env.MESH_HOME, path.join(l.dir, "ws_abc123", "home"));
    assert.equal(env.MESH_LICENSE, undefined);
  } finally {
    l.done();
  }
});

test("the local provisioner will not run when the service is a production one: a process is not isolation between customers", async () => {
  const l = local({ production: true });
  try {
    await assert.rejects(() => l.p.create(spec()), (err: Error) => err instanceof ProvisionError && /will not run in production: use the container provisioner/.test(err.message));
    await assert.rejects(() => l.p.resume("ws_abc123"), /will not run in production/);
    assert.equal(l.started.length, 0);
    assert.deepEqual(fs.readdirSync(l.dir), [], "and nothing was written");
  } finally {
    l.done();
  }
});

test("a workspace id that is not a safe directory name is refused, and so is a start with no command to run", async () => {
  const l = local();
  try {
    for (const id of ["", "../escape", "a/b", ".hidden", "-x", "x".repeat(64)]) await assert.rejects(() => l.p.create(spec({ workspaceId: id })), /is not a workspace id/, JSON.stringify(id));
    await assert.rejects(() => l.p.status("../x"), ProvisionError);
    const none = local({ hostCommand: [] });
    try {
      await assert.rejects(() => none.p.create(spec()), /no host command is configured/);
    } finally {
      none.done();
    }
  } finally {
    l.done();
  }
});

test("a workspace is stopped by asking its process to end, and started again on the same port from what was saved", async () => {
  const l = local();
  try {
    await l.p.create(spec());
    assert.equal(await l.p.status("ws_abc123"), "running");
    await l.p.suspend("ws_abc123");
    assert.deepEqual(l.started[0]!.child.signals, ["SIGTERM"]);
    assert.equal(await l.p.status("ws_abc123"), "stopped");
    await l.p.suspend("ws_abc123");
    assert.deepEqual(l.started[0]!.child.signals, ["SIGTERM"], "nothing is running to stop");
    const again = await l.p.resume("ws_abc123");
    assert.deepEqual(again, { handle: "ws_abc123", upstream: { host: "127.0.0.1", port: 41_001 } });
    assert.equal(l.started.length, 2);
    assert.equal(l.started[1]!.env.MESH_API_TOKEN, "operator-token-SECRET", "the saved credentials started it again");
    assert.deepEqual(await l.p.resume("ws_abc123"), again, "starting what runs starts nothing");
    assert.equal(l.started.length, 2);
    await assert.rejects(() => l.p.resume("ws_unknown"), /there is no workspace 'ws_unknown' to resume/);
  } finally {
    l.done();
  }
});

test("every host this process started can be stopped at once, and one that is already stopped is not asked again", async () => {
  const l = local();
  try {
    await l.p.create(spec({ workspaceId: "ws_one" }));
    await l.p.create(spec({ workspaceId: "ws_two" }));
    await l.p.create(spec({ workspaceId: "ws_three" }));
    await l.p.suspend("ws_three");
    await l.p.stopAll();
    assert.deepEqual(l.started.map((s) => s.child.signals), [["SIGTERM"], ["SIGTERM"], ["SIGTERM"]]);
    for (const id of ["ws_one", "ws_two", "ws_three"]) assert.equal(await l.p.status(id), "stopped");
    await l.p.stopAll();
    assert.deepEqual(l.started.map((s) => s.child.signals), [["SIGTERM"], ["SIGTERM"], ["SIGTERM"]], "nothing is running to stop");
    await assert.doesNotReject(() => local().p.stopAll(), "none started is none stopped");
  } finally {
    l.done();
  }
});

test("a host does not outlive the process that started it: it is told to end whenever that process does, and it does not hold that process open", async () => {
  const l = local();
  try {
    await l.p.create(spec({ workspaceId: "ws_one" }));
    await l.p.create(spec({ workspaceId: "ws_two" }));
    await l.p.suspend("ws_two");
    killLiveHosts();
    assert.deepEqual(l.started[0]!.child.signals, ["SIGTERM"], "what is running is told to end");
    assert.deepEqual(l.started[1]!.child.signals, ["SIGTERM"], "(once: what had ended is no longer one of them)");
    assert.deepEqual(l.started.map((s) => s.child.refs), [0, 1], "a host that is being waited for to end is a reason to stay up until it has");
    killLiveHosts();
    assert.equal(l.started[1]!.child.signals.length, 1);
    assert.ok(l.started.every((s) => s.child.unrefs === 1), "no host is a reason for the control plane to stay up");
  } finally {
    l.done();
  }
});

test("what a host prints is kept beside its workspace, where only its owner can read it, because a host that does not come up has nothing else to say why", async () => {
  const l = local({ spawn: undefined, hostCommand: [process.execPath, "-e", "console.log('the host is up'); console.error('and one thing it complains of'); setTimeout(() => {}, 20000)"] });
  try {
    await l.p.create(spec());
    const file = path.join(l.dir, "ws_abc123", "host.log");
    const deadline = Date.now() + 10_000;
    while (!/complains of/.test(fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    assert.equal(fs.readFileSync(file, "utf8"), "the host is up\nand one thing it complains of\n");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(!fs.readdirSync(path.join(l.dir, "ws_abc123", "projects")).length, "and it is not among the workspace's own files");
    await l.p.suspend("ws_abc123");
    await l.p.resume("ws_abc123");
    await new Promise((r) => setTimeout(r, 400));
    assert.match(fs.readFileSync(file, "utf8"), /^(the host is up\nand one thing it complains of\n){2}$/, "a host that is started again adds to it");
    await l.p.stopAll();
  } finally {
    l.done();
  }
});

test("a process that ends by itself is a workspace that is stopped", async () => {
  const l = local();
  try {
    await l.p.create(spec());
    l.started[0]!.child.emit("exit", 1, null);
    assert.equal(await l.p.status("ws_abc123"), "stopped");
    assert.equal(await l.p.status("ws_never"), "missing");
  } finally {
    l.done();
  }
});

test("a workspace is removed with its directory, or with its credentials only when its data is to be kept", async () => {
  const l = local();
  try {
    await l.p.create(spec());
    const root = path.join(l.dir, "ws_abc123");
    fs.writeFileSync(path.join(root, "projects", "keep.txt"), "mine");
    await l.p.destroy("ws_abc123", { keepData: true });
    assert.equal(l.started[0]!.child.signals[0], "SIGTERM", "it is stopped first");
    assert.equal(fs.existsSync(path.join(root, ".provision")), false, "the credentials go");
    assert.equal(fs.readFileSync(path.join(root, "projects", "keep.txt"), "utf8"), "mine");
    assert.equal(await l.p.status("ws_abc123"), "missing");
    await l.p.create(spec());
    await l.p.destroy("ws_abc123");
    assert.equal(fs.existsSync(root), false);
    await assert.doesNotReject(() => l.p.destroy("ws_abc123"), "removing what is gone is not an error");
  } finally {
    l.done();
  }
});
