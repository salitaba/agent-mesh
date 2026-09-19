import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CHILD_READY_PREFIX } from "../../packages/projects/src/index";
import { startHostServer, type HostHandle } from "../../apps/mesh-server/src/host";
import {
  DEFAULT_HOST_PORT,
  gitModeFromFlags,
  hostOptionsFromFlags,
  hostUrlFrom,
  resolveBus,
  runProjectCommand,
} from "../../apps/mesh-cli/src/projects";
import { parseArgs } from "../../apps/mesh-cli/src/index";
import { testConfigYaml } from "../helpers";

const AGENTS = { agents: [{ id: "a", role: "r", interests: [] }], mayContact: { a: [] } };

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mesh-cli-projects-"));
}

function makeProjectDir(base: string, folder: string, id: string): string {
  const dir = path.join(base, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "mesh.yaml"), `project:\n  id: ${id}\n${testConfigYaml(AGENTS)}`, "utf8");
  return fs.realpathSync(dir);
}

/** Minimal loopback child: enough for the host to call it open. */
function stubChildScript(base: string): string {
  const file = path.join(base, "cli-child.js");
  fs.writeFileSync(
    file,
    `
const http = require("http");
const token = process.env.MESH_API_TOKEN || "";
const server = http.createServer((req, res) => {
  if ((req.headers.authorization || "") !== "Bearer " + token) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthenticated" }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ path: new URL(req.url, "http://x").pathname, projectId: process.env.MESH_CHILD_PROJECT_ID }));
});
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  process.stdout.write(\`${CHILD_READY_PREFIX} \${JSON.stringify({ port, pid: process.pid, projectId: process.env.MESH_CHILD_PROJECT_ID, url: "http://127.0.0.1:" + port })}\\n\`);
});
process.on("SIGTERM", () => process.exit(0));
`,
    "utf8",
  );
  return file;
}

/** Captures stdout/stderr so command output can be asserted, not just eyeballed. */
async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void err.push(a.map(String).join(" "));
  try {
    const code = await fn();
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

test("resolveBus: --project routes through the host proxy, plain --bus is untouched", () => {
  assert.equal(resolveBus({}, "http://127.0.0.1:7420"), "http://127.0.0.1:7420");
  assert.equal(resolveBus({ bus: "http://x:1/" }, "fallback"), "http://x:1/");
  assert.equal(resolveBus({ project: "pay" }, "http://127.0.0.1:7420"), `${hostUrlFrom({})}/api/p/pay`);
  // A non-default host plus a project: the bus is the base, the proxy prefix is appended.
  assert.equal(resolveBus({ bus: "http://h:9/", project: "pay" }, "x"), "http://h:9/api/p/pay");
  // Ids are escaped, never interpolated raw into a path.
  assert.equal(resolveBus({ project: "a/b" }, "x"), `${hostUrlFrom({})}/api/p/a%2Fb`);
});

test("hostUrlFrom: --host beats MESH_HOST_URL, and trailing slashes are dropped", () => {
  const prev = process.env.MESH_HOST_URL;
  try {
    delete process.env.MESH_HOST_URL;
    assert.equal(hostUrlFrom({}), `http://127.0.0.1:${DEFAULT_HOST_PORT}`);
    process.env.MESH_HOST_URL = "http://env:1/";
    assert.equal(hostUrlFrom({}), "http://env:1");
    assert.equal(hostUrlFrom({ host: "http://flag:2///" }), "http://flag:2");
  } finally {
    if (prev === undefined) delete process.env.MESH_HOST_URL;
    else process.env.MESH_HOST_URL = prev;
  }
});

test("hostOptionsFromFlags: defaults parked, installs signal handlers, resolves paths", () => {
  const base = hostOptionsFromFlags({});
  assert.equal(base.port, DEFAULT_HOST_PORT);
  assert.equal(base.childMode, "parked");
  // "auto", not "off": the host expresses no opinion and each child resolves
  // against its own mesh.workspace.git, which defaults to ON.
  assert.equal(base.gitMode, "auto");
  // Without this the host process exits on Ctrl-C leaving children stranded.
  assert.equal(base.handleSignals, true);
  assert.equal("home" in base, false);

  const full = hostOptionsFromFlags({ port: "9000", live: true, git: true, memory: "256", home: "rel-home", bind: "0.0.0.0" });
  assert.equal(full.port, 9000);
  assert.equal(full.childMode, "live");
  assert.equal(full.gitMode, "on");
  assert.equal(full.projectMemoryMb, 256);
  assert.equal(full.home, path.resolve("rel-home"));
  assert.equal(full.host, "0.0.0.0");
});

test("gitModeFromFlags: absent means auto, never off", () => {
  // The whole point of the tri-state. Reading absence as "off" would let an
  // unrelated command line silently override a project's `git: true`.
  assert.equal(gitModeFromFlags({}).mode, "auto");
  assert.equal(gitModeFromFlags({ port: "7420" }).mode, "auto");
});

test("gitModeFromFlags: --git=false means OFF", () => {
  // The bug this replaces: `--git=false` parses to the STRING "false", and
  // Boolean("false") is true, so the flag that read as "disable git" enabled it.
  assert.equal(gitModeFromFlags({ git: "false" }).mode, "off");
  assert.equal(gitModeFromFlags({ git: "0" }).mode, "off");
  assert.equal(gitModeFromFlags({ git: "off" }).mode, "off");
  assert.equal(gitModeFromFlags({ git: "true" }).mode, "on");
  assert.equal(gitModeFromFlags({ git: true }).mode, "on");
  assert.equal(gitModeFromFlags({ git: "ON" }).mode, "on");
});

test("gitModeFromFlags: --no-git wins over --git, and says so", () => {
  const both = gitModeFromFlags({ git: true, "no-git": true });
  assert.equal(both.mode, "off");
  assert.match(both.warnings.join(" "), /--no-git wins/);
  assert.equal(gitModeFromFlags({ "no-git": true }).mode, "off");
  assert.deepEqual(gitModeFromFlags({ "no-git": true }).warnings, []);
});

test("gitModeFromFlags: an unparseable value throws rather than guessing", () => {
  assert.throws(() => gitModeFromFlags({ git: "banana" }), /--git expects a boolean/);
});

test("parseArgs: a boolean flag does not swallow the positional after it", () => {
  // `mesh run --git mesh.yaml` used to bind "mesh.yaml" as the VALUE of --git,
  // leaving positional empty and reporting a usage error for correct input.
  const a = parseArgs(["run", "--git", "mesh.yaml"]);
  assert.deepEqual(a.positional, ["mesh.yaml"]);
  assert.equal(a.flags.git, true);
  // An explicit boolean literal is still consumed, so this is not a stray path.
  const b = parseArgs(["run", "--git", "false", "mesh.yaml"]);
  assert.deepEqual(b.positional, ["mesh.yaml"]);
  assert.equal(b.flags.git, "false");
  // Value-taking flags are unaffected.
  const c = parseArgs(["run", "mesh.yaml", "--port", "7420"]);
  assert.equal(c.flags.port, "7420");
  assert.deepEqual(c.positional, ["mesh.yaml"]);
});

test("project list/add/remove work with no host, against the registry file", async () => {
  const base = tmpRoot();
  try {
    const home = path.join(base, "home");
    const root = makeProjectDir(base, "alpha", "alpha");
    // Port 1 is never a mesh host, so this exercises the unreachable path.
    const flags = { host: "http://127.0.0.1:1", home };

    const empty = await capture(() => runProjectCommand(["list"], flags));
    assert.equal(empty.code, 0);
    assert.match(empty.out, /no projects registered/);

    const added = await capture(() => runProjectCommand(["add", root], flags));
    assert.equal(added.code, 0);
    assert.match(added.out, /added alpha/);
    assert.match(added.out, /offline/);
    assert.ok(fs.existsSync(path.join(home, "projects.json")));

    const listed = await capture(() => runProjectCommand(["list"], flags));
    assert.match(listed.out, /alpha/);
    // Status is not invented when there is no host to ask.
    assert.match(listed.out, /statuses unknown/);

    const json = await capture(() => runProjectCommand(["list"], { ...flags, json: true }));
    assert.deepEqual(JSON.parse(json.out).map((r: { id: string }) => r.id), ["alpha"]);

    const removed = await capture(() => runProjectCommand(["remove", "alpha"], flags));
    assert.equal(removed.code, 0);
    assert.match(removed.out, /removed alpha/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "projects.json"), "utf8")).projects, []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("open/close/restart require a host and say so instead of spawning an orphan", async () => {
  const base = tmpRoot();
  try {
    const flags = { host: "http://127.0.0.1:1", home: path.join(base, "home") };
    for (const sub of ["open", "close", "restart"]) {
      await assert.rejects(() => runProjectCommand([sub, "alpha"], flags), /no mesh host at http:\/\/127\.0\.0\.1:1/);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("project add/open/list/close/restart/remove against a live host", async () => {
  const base = tmpRoot();
  let host: HostHandle | undefined;
  try {
    const root = makeProjectDir(base, "beta", "beta");
    host = await startHostServer({
      home: path.join(base, "home"),
      port: 0,
      childScript: stubChildScript(base),
      readyTimeoutMs: 10_000,
      stopGraceMs: 2_000,
      dashboardDir: path.join(base, "no-dashboard"),
    });
    const flags = { host: host.url };

    const added = await capture(() => runProjectCommand(["add", root], flags));
    assert.equal(added.code, 0);
    assert.match(added.out, /added beta/);
    assert.doesNotMatch(added.out, /offline/);

    const opened = await capture(() => runProjectCommand(["open", "beta"], flags));
    assert.equal(opened.code, 0);
    assert.match(opened.out, /beta\s+open/);
    assert.deepEqual(host.supervisor.runningIds(), ["beta"]);

    const listed = await capture(() => runProjectCommand(["list"], flags));
    assert.match(listed.out, /beta\s+open/);
    assert.match(listed.out, new RegExp(`host: ${host.url.replace(/[.]/g, "\\.")}`));

    // --project goes through the proxy the CLI computed, end to end.
    const proxied = await fetch(`${resolveBus({ ...flags, project: "beta" }, "unused")}/whatever`);
    assert.equal(proxied.status, 200);
    assert.equal(((await proxied.json()) as { projectId: string }).projectId, "beta");

    const restarted = await capture(() => runProjectCommand(["restart", "beta"], flags));
    assert.equal(restarted.code, 0);
    assert.match(restarted.out, /beta\s+open/);

    const closed = await capture(() => runProjectCommand(["close", "beta"], flags));
    assert.equal(closed.code, 0);
    assert.deepEqual(host.supervisor.runningIds(), []);

    const removedHost = await capture(() => runProjectCommand(["remove", "beta"], flags));
    assert.equal(removedHost.code, 0);
    assert.deepEqual(host.registry.list(), []);
  } finally {
    await host?.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("unknown project and unknown subcommand fail loudly", async () => {
  const base = tmpRoot();
  let host: HostHandle | undefined;
  try {
    host = await startHostServer({
      home: path.join(base, "home"),
      port: 0,
      childScript: stubChildScript(base),
      readyTimeoutMs: 10_000,
      stopGraceMs: 2_000,
      dashboardDir: path.join(base, "no-dashboard"),
    });
    const flags = { host: host.url };
    await assert.rejects(() => runProjectCommand(["open", "nope"], flags), /host returned 404/);

    const bad = await capture(() => runProjectCommand(["frobnicate"], flags));
    assert.equal(bad.code, 1);
    assert.match(bad.err, /unknown subcommand/);
    assert.match(bad.out, /mesh project list/);

    const help = await capture(() => runProjectCommand(["help"], flags));
    assert.equal(help.code, 0);
    assert.match(help.out, /mesh project restart/);
  } finally {
    await host?.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
