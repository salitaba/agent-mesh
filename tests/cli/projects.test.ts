import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CHILD_READY_PREFIX } from "../../packages/projects/src/index";
import { startHostServer, type HostHandle } from "../../apps/mesh-server/src/host";
import {
  DEFAULT_HOST_PORT,
  hostOptionsFromFlags,
  hostUrlFrom,
  resolveBus,
  runProjectCommand,
} from "../../apps/mesh-cli/src/projects";
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
  assert.equal(base.useGit, false);
  // Without this the host process exits on Ctrl-C leaving children stranded.
  assert.equal(base.handleSignals, true);
  assert.equal("home" in base, false);

  const full = hostOptionsFromFlags({ port: "9000", live: true, git: true, memory: "256", home: "rel-home", bind: "0.0.0.0" });
  assert.equal(full.port, 9000);
  assert.equal(full.childMode, "live");
  assert.equal(full.useGit, true);
  assert.equal(full.projectMemoryMb, 256);
  assert.equal(full.home, path.resolve("rel-home"));
  assert.equal(full.host, "0.0.0.0");
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
