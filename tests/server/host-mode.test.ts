/**
 * The host's per-project mode memory, and the line it raises when a parked
 * project still holds an ACTIVE goal.
 *
 * Every case here is driven through the same surface an operator uses — the
 * proxy, the restart route, the child's own `/mission/start` — because the bug
 * this covers was a *silent* one: the mode was decided by the host's global
 * default at spawn time, so a restart parked a mission the operator had made
 * live and nothing anywhere said so.
 *
 * The stub child records the `MESH_CHILD_MODE` it was spawned with, which is
 * the only honest way to assert "the child came back live": the host's own
 * memory agrees with itself whether or not it ever reached the spawn.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CHILD_BEAT_PREFIX, CHILD_READY_PREFIX, FileProjectRegistry, defaultHostConfig, readProjectsFile, type HostConfig, type ProjectRef } from "../../packages/projects/src/index";
import { startHostServer, type HostHandle } from "../../apps/mesh-server/src/host";
import { testConfigYaml, waitFor } from "../helpers";
import { writeStubScript } from "../support/stub-script";

const AGENTS = { agents: [{ id: "a", role: "r", interests: [] }], mayContact: { a: [] } };

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mesh-host-mode-"));
}

function makeProject(base: string, folder: string, id: string): ProjectRef {
  const dir = path.join(base, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "mesh.yaml"), `project:\n  id: ${id}\n${testConfigYaml(AGENTS)}`, "utf8");
  const root = fs.realpathSync(dir);
  return { id, name: id, root, configPath: path.join(root, "mesh.yaml"), addedAt: new Date().toISOString() };
}

/**
 * A child that answers the two mission routes, reports its own mode on every
 * beat, and appends the mode it was *spawned* with to a log.
 *
 * `MESH_STUB_REPORT_MODE=0` makes it report no mode at all, which is the only
 * way to exercise "the host knows nothing about this project": every other
 * child tells it, and so does every real one built from this source.
 *
 * `MESH_STUB_STATE` names a JSON file re-read on every beat, so a test can
 * change the goal's ACTIVE-ness inside a live child instead of restarting one.
 */
function modeChildScript(base: string): string {
  return writeStubScript(
    base,
    "mode-child",
    `
const http = require("http");
const fs = require("fs");
const token = process.env.MESH_API_TOKEN || "";
const spawnLog = process.env.MESH_STUB_SPAWNLOG;
const stateFile = process.env.MESH_STUB_STATE;
const reportMode = process.env.MESH_STUB_REPORT_MODE !== "0";
// The child's own mode, changed by /mission/start and /mission/park and by
// nothing else — exactly like the real one, where the operator's call is
// proxied through and the host never sees it.
let live = (process.env.MESH_CHILD_MODE || "") === "live";
try { fs.appendFileSync(spawnLog, process.env.MESH_CHILD_PROJECT_ID + " " + (process.env.MESH_CHILD_MODE || "") + "\\n"); } catch (e) { /* bookkeeping is never fatal */ }
function goalActive() {
  try { return JSON.parse(fs.readFileSync(stateFile, "utf8")).goalActive === true; } catch (e) { return false; }
}
const server = http.createServer((req, res) => {
  if ((req.headers.authorization || "") !== "Bearer " + token) {
    res.writeHead(401); res.end("{}"); return;
  }
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/mission/start" && req.method === "POST") {
    live = true;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, started: true, mode: "live", activated: ["a"], refused: [], note: "scheduler live; activated: a" }));
    return;
  }
  if (url.pathname === "/mission/park" && req.method === "POST") {
    live = false;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, mode: "parked", note: "scheduler parked; wake buttons still step single turns" }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
});
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  process.stdout.write(\`${CHILD_READY_PREFIX} \${JSON.stringify({ port, pid: process.pid, projectId: process.env.MESH_CHILD_PROJECT_ID, url: "http://127.0.0.1:" + port })}\\n\`);
  const beat = setInterval(() => {
    const payload = {
      rss: 1234,
      pid: process.pid,
      models: [{ model: "m", input: Number(process.env.MESH_STUB_INPUT || 0), output: Number(process.env.MESH_STUB_OUTPUT || 0) }],
      runningTurns: live ? 1 : 0,
    };
    if (reportMode) {
      payload.mode = live ? "live" : "parked";
      payload.goalActive = goalActive();
    }
    process.stdout.write(\`${CHILD_BEAT_PREFIX} \${JSON.stringify(payload)}\\n\`);
  }, 30);
  beat.unref();
});
process.on("SIGTERM", () => process.exit(0));
`,
  );
}

/** Point the stub children at this test's spawn log and goal-state file. */
function arm(base: string, opts: { reportMode?: boolean } = {}): void {
  process.env.MESH_STUB_SPAWNLOG = path.join(base, "spawns.log");
  process.env.MESH_STUB_STATE = path.join(base, "child-state.json");
  process.env.MESH_STUB_REPORT_MODE = opts.reportMode === false ? "0" : "1";
  process.env.MESH_STUB_INPUT = "0";
  process.env.MESH_STUB_OUTPUT = "0";
}

async function startHost(base: string, extra: { childMode?: "parked" | "live"; hostConfig?: HostConfig } = {}): Promise<HostHandle> {
  return startHostServer({
    home: path.join(base, "home"),
    port: 0,
    childScript: modeChildScript(base),
    readyTimeoutMs: 10_000,
    stopGraceMs: 2_000,
    dashboardDir: path.join(base, "no-dashboard"),
    hostConfig: extra.hostConfig ?? defaultHostConfig(),
    ...(extra.childMode ? { childMode: extra.childMode } : {}),
  });
}

/** `[projectId, spawned mode]` per child this host has spawned, oldest first. */
function spawns(base: string): Array<{ id: string; mode: string }> {
  const file = path.join(base, "spawns.log");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [id, mode] = line.split(" ");
      return { id, mode };
    });
}

async function addAndOpen(host: HostHandle, root: string): Promise<string> {
  const added = await fetch(`${host.url}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ root }),
  });
  const ref = (await added.json()) as { id: string };
  await fetch(`${host.url}/api/projects/${ref.id}/open`, { method: "POST" });
  return ref.id;
}

/** The operator's own route, through the host proxy — never a host-side call. */
async function childPost(host: HostHandle, id: string, route: string): Promise<any> {
  const res = await fetch(`${host.url}/api/p/${id}${route}`, { method: "POST" });
  return res.json();
}

async function restart(host: HostHandle, id: string): Promise<any> {
  const res = await fetch(`${host.url}/api/projects/${id}/restart`, { method: "POST" });
  return res.json();
}

/** Beats land on a 30ms timer; give the host a few before asserting on them. */
async function settle(ms = 250): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** Capture the host's own stderr, for the audit line it raises. */
function captureStderr(): { take: () => string; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = (chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  return {
    // Draining, not reading: the line count per window is the assertion.
    take: () => chunks.splice(0, chunks.length).join(""),
    restore: () => {
      (process.stderr as { write: unknown }).write = original;
    },
  };
}

test("a mission the operator made live comes back live on restart, and their park comes back parked", { timeout: 60_000 }, async () => {
  const base = tmpRoot();
  const project = makeProject(base, "alpha", "alpha");
  arm(base);
  fs.writeFileSync(process.env.MESH_STUB_STATE!, JSON.stringify({ goalActive: true }), "utf8");
  // The measured bug: `npm run dev` starts the host with no --live, so every
  // child it spawns is parked and only the first open is ever live.
  const host = await startHost(base);
  try {
    const id = await addAndOpen(host, project.root);
    await settle();
    assert.deepEqual(spawns(base), [{ id, mode: "parked" }], "a project's first launch uses the host default");

    // The operator goes live through the console. The host only proxies this.
    const started = await childPost(host, id, "/mission/start");
    assert.equal(started.mode, "live");
    await settle();
    assert.equal(host.supervisor.modeFor(id), "live", "the host learned the child's mode from its beat");

    await restart(host, id);
    await settle();
    assert.deepEqual(
      spawns(base).map((s) => s.mode),
      ["parked", "live"],
      "a restart must re-spawn the project in the mode it was actually in",
    );

    // …and the same memory works the other way: an operator park is intent too.
    await childPost(host, id, "/mission/park");
    await settle();
    assert.equal(host.supervisor.modeFor(id), "parked");
    await restart(host, id);
    await settle();
    assert.deepEqual(spawns(base).map((s) => s.mode), ["parked", "live", "parked"]);
  } finally {
    await host.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("with nothing known, a project launches in the host's own default — parked, or live under --live", { timeout: 60_000 }, async () => {
  const base = tmpRoot();
  const project = makeProject(base, "beta", "beta");
  // Children that report no mode: an older build, or simply nothing learned yet.
  arm(base, { reportMode: false });
  const parked = await startHost(base);
  try {
    const id = await addAndOpen(parked, project.root);
    await settle();
    await restart(parked, id);
    await settle();
    assert.deepEqual(spawns(base).map((s) => s.mode), ["parked", "parked"], "an unknown project must not acquire a live mode");
  } finally {
    await parked.close();
  }

  fs.rmSync(path.join(base, "spawns.log"), { force: true });
  const live = await startHost(base, { childMode: "live" });
  try {
    const id = await addAndOpen(live, project.root);
    await settle();
    await restart(live, id);
    await settle();
    assert.deepEqual(spawns(base).map((s) => s.mode), ["live", "live"], "--live still means live when nothing says otherwise");
  } finally {
    await live.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a project parked by the ceiling comes back parked, not live", { timeout: 60_000 }, async () => {
  const base = tmpRoot();
  const project = makeProject(base, "gamma", "gamma");
  arm(base);
  fs.writeFileSync(process.env.MESH_STUB_STATE!, JSON.stringify({ goalActive: true }), "utf8");
  // $18 per child against a $5 ceiling: the aggregate is over on the first beat.
  process.env.MESH_STUB_INPUT = "1000000";
  process.env.MESH_STUB_OUTPUT = "1000000";
  const config = defaultHostConfig();
  config.spendCeilingUsd = 5;
  config.modelPrices = { m: { inputPerMtok: 3, outputPerMtok: 15 } };
  const host = await startHost(base, { childMode: "live", hostConfig: config });
  try {
    const id = await addAndOpen(host, project.root);
    await settle(500);
    // Parked through its own /mission/park, so the child reports parked: that
    // park is not a failure the operator can clear by restarting, it is the
    // host doing what it was configured to do.
    assert.equal(host.supervisor.modeFor(id), "parked", "the ceiling park reached the child");

    // The restart path deletes the `parkedByPolicy` record — that record
    // describes the child that is gone. What must NOT come back is the mode: a
    // restart that resurrected a live child here would walk straight back over
    // the ceiling that parked it.
    await restart(host, id);
    await settle();
    assert.deepEqual(spawns(base).map((s) => s.mode), ["live", "parked"], "a policy park outlives the restart");
  } finally {
    await host.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("the host says out loud when a parked project still holds an ACTIVE goal", { timeout: 60_000 }, async () => {
  const base = tmpRoot();
  const project = makeProject(base, "delta", "delta");
  arm(base);
  const state = process.env.MESH_STUB_STATE!;
  fs.writeFileSync(state, JSON.stringify({ goalActive: true }), "utf8");
  const host = await startHost(base);
  const stderr = captureStderr();
  try {
    const id = await addAndOpen(host, project.root);
    await settle(400);
    const first = stderr.take();
    assert.match(first, new RegExp(`project '${id}' is parked while its goal is ACTIVE`), `expected the parked line, got: ${first}`);
    assert.match(first, /POST \/mission\/start/, "the line has to name the way out");
    // Once per park episode, not once per beat: a line every 2s forever is a
    // worse bug than the silence it replaced.
    assert.equal(first.split("[mesh-host]").length - 1, 1, `expected exactly one line, got: ${first}`);

    // The guard clears when the fact stops being true, so a later park is
    // announced again rather than swallowed by the first one.
    fs.writeFileSync(state, JSON.stringify({ goalActive: false }), "utf8");
    await settle(400);
    assert.equal(stderr.take(), "", "a parked project with no ACTIVE goal is a legitimate console state");
    fs.writeFileSync(state, JSON.stringify({ goalActive: true }), "utf8");
    await settle(400);
    assert.equal(stderr.take().split("[mesh-host]").length - 1, 1, "the second park is announced too");
  } finally {
    stderr.restore();
    await host.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("removing a project forgets its mode", { timeout: 60_000 }, async () => {
  const base = tmpRoot();
  const project = makeProject(base, "epsilon", "epsilon");
  arm(base);
  fs.writeFileSync(process.env.MESH_STUB_STATE!, JSON.stringify({ goalActive: true }), "utf8");
  const host = await startHost(base);
  try {
    const id = await addAndOpen(host, project.root);
    await childPost(host, id, "/mission/start");
    await settle();
    assert.equal(host.supervisor.modeFor(id), "live");

    await fetch(`${host.url}/api/projects/${id}`, { method: "DELETE" });
    assert.equal(host.supervisor.modeFor(id), "parked", "a removed project keeps nothing for a later re-add");

    // Re-adding the same folder must not inherit what it used to be doing.
    const readded = await addAndOpen(host, project.root);
    await settle();
    assert.deepEqual(spawns(base).map((s) => s.mode), ["parked", "parked"]);
    assert.equal(readded, id);
  } finally {
    await host.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Across a host *process*, which is the case the memory above cannot cover.
//
// Everything past this line restarts the host: a fresh supervisor, an empty
// memory, and nothing but `projects.json` to say what each project was doing.
// ---------------------------------------------------------------------------

/** Seed the registry the way a previous host left it, without booting one. */
async function seed(base: string, root: string, id: string, mode: "parked" | "live"): Promise<void> {
  const registry = new FileProjectRegistry({ home: path.join(base, "home") });
  await registry.add(root);
  await registry.setMode(id, mode);
}

function storedMode(base: string): string | undefined {
  return readProjectsFile(path.join(base, "home", "projects.json"))[0]?.lastMode;
}

test("a fresh host opens a project in the mode it was left in", { timeout: 60_000 }, async () => {
  const base = tmpRoot();
  const project = makeProject(base, "zeta", "zeta");
  arm(base);
  fs.writeFileSync(process.env.MESH_STUB_STATE!, JSON.stringify({ goalActive: true }), "utf8");

  // Host one: the operator takes the mission live through the proxy. The child
  // reports it on its next beat and the host persists it — nothing else in the
  // system knows.
  const first = await startHost(base);
  let id = "";
  try {
    id = await addAndOpen(first, project.root);
    await childPost(first, id, "/mission/start");
    await waitFor("the mode the child reported to reach disk", () => storedMode(base) === "live");
  } finally {
    await first.close();
  }

  // Host two: a new process with an empty memory, and the mission still ACTIVE.
  // Before this, it spawned `parked` and the mission sat there until the
  // operator pressed Start.
  fs.rmSync(path.join(base, "spawns.log"), { force: true });
  const second = await startHost(base);
  try {
    const reopened = await addAndOpen(second, project.root);
    assert.equal(reopened, id, "the same project comes back");
    await settle();
    assert.deepEqual(spawns(base).map((s) => s.mode), ["live"], "a host restart restores what the project was doing");
  } finally {
    await second.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a persisted park outranks --live", { timeout: 60_000 }, async () => {
  const base = tmpRoot();
  const project = makeProject(base, "eta", "eta");
  arm(base);
  await seed(base, project.root, "eta", "parked");

  // `--live` is the host's answer to "this project's mode is unknown". It is
  // not "start whatever was stopped": the same persisted value is what a
  // ceiling park leaves behind, and a host that overrode it would spend past
  // the ceiling that parked it. /mission/start is the way back, and it is what
  // the parked notice names.
  const host = await startHost(base, { childMode: "live" });
  try {
    const id = await addAndOpen(host, project.root);
    await settle();
    assert.deepEqual(spawns(base).map((s) => s.mode), ["parked"], "what the project was left in beats --live");
    assert.equal(host.supervisor.modeFor(id), "parked");
  } finally {
    await host.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("with nothing persisted, a fresh host still uses its own default", { timeout: 60_000 }, async () => {
  const base = tmpRoot();
  const project = makeProject(base, "iota", "iota");
  arm(base);
  // Registered, never opened: an entry with no mode to restore.
  await new FileProjectRegistry({ home: path.join(base, "home") }).add(project.root);
  assert.equal(storedMode(base), undefined, "nothing is recorded for this project");

  const host = await startHost(base, { childMode: "live" });
  try {
    const id = await addAndOpen(host, project.root);
    await settle();
    assert.deepEqual(spawns(base).map((s) => s.mode), ["live"], "--live still means live when nothing says otherwise");
    // …and the child's own report becomes the record for the next boot.
    await waitFor("the learned mode to be persisted", () => storedMode(base) === "live");
    assert.equal(host.supervisor.modeFor(id), "live");
  } finally {
    await host.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a persisted live cannot outrun the ceiling: the policy park wins, and is what is persisted", { timeout: 60_000 }, async () => {
  const base = tmpRoot();
  const project = makeProject(base, "theta", "theta");
  arm(base);
  fs.writeFileSync(process.env.MESH_STUB_STATE!, JSON.stringify({ goalActive: true }), "utf8");
  // $18 per child against a $5 ceiling.
  process.env.MESH_STUB_INPUT = "1000000";
  process.env.MESH_STUB_OUTPUT = "1000000";

  // A stale `live`: the host that wrote it was killed in the window between
  // parking this child and the child's next beat. The file is all the next host
  // knows, and here it is wrong.
  await seed(base, project.root, "theta", "live");

  const config = defaultHostConfig();
  config.spendCeilingUsd = 5;
  config.modelPrices = { m: { inputPerMtok: 3, outputPerMtok: 15 } };
  const host = await startHost(base, { childMode: "live", hostConfig: config });
  try {
    const id = await addAndOpen(host, project.root);
    // The host cannot know the total before a child reports one, so the stale
    // live is honoured at spawn — and then the ceiling parks it, as it would
    // have parked it in the host that wrote the live in the first place.
    await waitFor("the ceiling to park the child", () => host.supervisor.modeFor(id) === "parked");
    await waitFor("the park to be persisted", () => storedMode(base) === "parked");
    assert.deepEqual(spawns(base).map((s) => s.mode), ["live"], "the spawn honoured the file; the limit check then overrode it");
  } finally {
    await host.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

