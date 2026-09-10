/**
 * Step 10: the aggregate resource policy.
 *
 * The stub child here is a real HTTP server that also emits real heartbeat
 * lines carrying model token counts, because that beat IS the transport for
 * spend — a test that injected totals directly would prove nothing about the
 * path the numbers actually take.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CHILD_BEAT_PREFIX, CHILD_READY_PREFIX, defaultHostConfig, type HostConfig, type ProjectRef } from "../../packages/projects/src/index";
import { startHostServer, type HostHandle } from "../../apps/mesh-server/src/host";
import { testConfigYaml } from "../helpers";

const AGENTS = { agents: [{ id: "a", role: "r", interests: [] }], mayContact: { a: [] } };

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mesh-resources-"));
}

function makeProject(base: string, folder: string, id: string): ProjectRef {
  const dir = path.join(base, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "mesh.yaml"), `project:\n  id: ${id}\n${testConfigYaml(AGENTS)}`, "utf8");
  const root = fs.realpathSync(dir);
  return { id, name: id, root, configPath: path.join(root, "mesh.yaml"), addedAt: new Date().toISOString() };
}

/**
 * A child that reports the spend it is told to report and records being parked.
 *
 * `MESH_STUB_INPUT`/`MESH_STUB_OUTPUT`/`MESH_STUB_TURNS` drive the beat, and a
 * marker file records `/mission/park` so the assertion sees the host's action
 * from the child's side rather than trusting the host's own bookkeeping.
 */
function spendingChildScript(base: string): string {
  const file = path.join(base, "spending-child.js");
  fs.writeFileSync(
    file,
    `
const http = require("http");
const fs = require("fs");
const token = process.env.MESH_API_TOKEN || "";
const parkFile = process.env.MESH_STUB_PARKFILE;
const server = http.createServer((req, res) => {
  if ((req.headers.authorization || "") !== "Bearer " + token) {
    res.writeHead(401); res.end("{}"); return;
  }
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/mission/park" && req.method === "POST") {
    fs.appendFileSync(parkFile, process.env.MESH_CHILD_PROJECT_ID + "\\n");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
});
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  process.stdout.write(\`${CHILD_READY_PREFIX} \${JSON.stringify({ port, pid: process.pid, projectId: process.env.MESH_CHILD_PROJECT_ID, url: "http://127.0.0.1:" + port })}\\n\`);
  const beat = setInterval(() => {
    process.stdout.write(\`${CHILD_BEAT_PREFIX} \${JSON.stringify({
      rss: 1234,
      pid: process.pid,
      models: [{ model: "m", input: Number(process.env.MESH_STUB_INPUT || 0), output: Number(process.env.MESH_STUB_OUTPUT || 0) }],
      runningTurns: Number(process.env.MESH_STUB_TURNS || 0),
    })}\\n\`);
  }, 30);
  beat.unref();
});
process.on("SIGTERM", () => process.exit(0));
`,
    "utf8",
  );
  return file;
}

async function startHost(base: string, hostConfig: HostConfig, parkFile: string): Promise<HostHandle> {
  process.env.MESH_STUB_PARKFILE = parkFile;
  return startHostServer({
    home: path.join(base, "home"),
    port: 0,
    childScript: spendingChildScript(base),
    readyTimeoutMs: 10_000,
    stopGraceMs: 2_000,
    dashboardDir: path.join(base, "no-dashboard"),
    hostConfig,
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

/** Beats land on a 30ms timer; give the host a few before asserting on them. */
async function settle(ms = 200): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

test("/api/projects reports per-project and aggregate live cost", { timeout: 30_000 }, async () => {
  const base = tmpRoot();
  const a = makeProject(base, "alpha", "alpha");
  const b = makeProject(base, "beta", "beta");
  const config = defaultHostConfig();
  config.modelPrices = { m: { inputPerMtok: 3, outputPerMtok: 15 } };
  // 1M in + 1M out per child = $18 each, $36 across two: under the $50 default.
  process.env.MESH_STUB_INPUT = "1000000";
  process.env.MESH_STUB_OUTPUT = "1000000";
  process.env.MESH_STUB_TURNS = "0";
  const host = await startHost(base, config, path.join(base, "parked.log"));
  try {
    await addAndOpen(host, a.root);
    await addAndOpen(host, b.root);
    await settle();

    const res = await fetch(`${host.url}/api/projects`);
    const body = (await res.json()) as {
      projects: Array<{ id: string; spend?: { usd: number; tokens: number } }>;
      spend: { usd: number; tokens: number; ceilingUsd: number | null; ceilingTripped: boolean };
    };

    const alpha = body.projects.find((p) => p.id === "alpha");
    assert.ok(alpha?.spend, "each open project carries its own spend");
    assert.equal(alpha.spend.tokens, 2_000_000);
    assert.equal(Math.round(alpha.spend.usd), 18);

    // The point of the aggregate: two projects each inside their own budget
    // still add up, and only this number shows it.
    assert.equal(body.spend.tokens, 4_000_000);
    assert.equal(Math.round(body.spend.usd), 36);
    assert.equal(body.spend.ceilingUsd, 50);
    assert.equal(body.spend.ceilingTripped, false);
  } finally {
    await host.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("the spend ceiling parks every open project once the aggregate crosses it", { timeout: 30_000 }, async () => {
  const base = tmpRoot();
  const a = makeProject(base, "alpha", "alpha");
  const b = makeProject(base, "beta", "beta");
  const parkFile = path.join(base, "parked.log");
  fs.writeFileSync(parkFile, "", "utf8");
  const config = defaultHostConfig();
  config.spendCeilingUsd = 5;
  config.modelPrices = { m: { inputPerMtok: 3, outputPerMtok: 15 } };
  // $18 per child on the first beat: one project alone clears the $5 ceiling.
  process.env.MESH_STUB_INPUT = "1000000";
  process.env.MESH_STUB_OUTPUT = "1000000";
  process.env.MESH_STUB_TURNS = "0";
  const host = await startHost(base, config, parkFile);
  try {
    await addAndOpen(host, a.root);
    await addAndOpen(host, b.root);
    await settle(400);

    const res = await fetch(`${host.url}/api/projects`);
    const body = (await res.json()) as { spend: { ceilingTripped: boolean; parked: string[] } };
    assert.equal(body.spend.ceilingTripped, true);

    // Every open project, not just the newest: the ceiling is a total, so a
    // project left running keeps pushing an already-breached total upward.
    const parked = new Set(fs.readFileSync(parkFile, "utf8").split("\n").filter(Boolean));
    assert.deepEqual([...parked].sort(), ["alpha", "beta"]);
    assert.deepEqual([...body.spend.parked].sort(), ["alpha", "beta"]);

    // Parked, not killed: the child keeps its process, log and lock so the
    // operator can raise the ceiling and resume instead of replaying.
    assert.ok(host.supervisor.running("alpha"), "a parked project is still open");
  } finally {
    await host.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a null ceiling disables the backstop entirely", { timeout: 30_000 }, async () => {
  const base = tmpRoot();
  const a = makeProject(base, "alpha", "alpha");
  const parkFile = path.join(base, "parked.log");
  fs.writeFileSync(parkFile, "", "utf8");
  const config = defaultHostConfig();
  config.spendCeilingUsd = null;
  config.modelPrices = { m: { inputPerMtok: 1000, outputPerMtok: 1000 } };
  process.env.MESH_STUB_INPUT = "10000000";
  process.env.MESH_STUB_OUTPUT = "10000000";
  process.env.MESH_STUB_TURNS = "0";
  const host = await startHost(base, config, parkFile);
  try {
    await addAndOpen(host, a.root);
    await settle(400);
    const res = await fetch(`${host.url}/api/projects`);
    const body = (await res.json()) as { spend: { usd: number; ceilingUsd: number | null; ceilingTripped: boolean } };
    assert.equal(body.spend.ceilingUsd, null);
    assert.equal(body.spend.ceilingTripped, false);
    assert.ok(body.spend.usd > 1000, "spend is still reported, just not enforced");
    assert.equal(fs.readFileSync(parkFile, "utf8").trim(), "");
  } finally {
    await host.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("max_concurrent_turns parks the newest projects until the total fits", { timeout: 30_000 }, async () => {
  const base = tmpRoot();
  const a = makeProject(base, "alpha", "alpha");
  const b = makeProject(base, "beta", "beta");
  const parkFile = path.join(base, "parked.log");
  fs.writeFileSync(parkFile, "", "utf8");
  const config = defaultHostConfig();
  config.spendCeilingUsd = null; // isolate the turn cap from the ceiling
  config.maxConcurrentTurns = 3;
  process.env.MESH_STUB_INPUT = "0";
  process.env.MESH_STUB_OUTPUT = "0";
  process.env.MESH_STUB_TURNS = "2"; // 2 + 2 = 4, over a cap of 3
  const host = await startHost(base, config, parkFile);
  try {
    await addAndOpen(host, a.root);
    await addAndOpen(host, b.root);
    await settle(400);

    const res = await fetch(`${host.url}/api/projects`);
    const body = (await res.json()) as { spend: { runningTurns: number; maxConcurrentTurns: number | null; ceilingTripped: boolean } };
    assert.equal(body.spend.maxConcurrentTurns, 3);
    assert.equal(body.spend.ceilingTripped, false, "the turn cap is not the spend ceiling");

    // Newest first, and only as many as it takes: parking beta drops the total
    // to 2, which fits, so alpha keeps running.
    const parked = fs.readFileSync(parkFile, "utf8").split("\n").filter(Boolean);
    assert.deepEqual([...new Set(parked)], ["beta"]);
  } finally {
    await host.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("host.yaml supplies project_memory_mb and a flag overrides it", { timeout: 30_000 }, async () => {
  const base = tmpRoot();
  const home = path.join(base, "home");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "host.yaml"), "host:\n  project_memory_mb: 321\n", "utf8");
  process.env.MESH_STUB_INPUT = "0";
  process.env.MESH_STUB_OUTPUT = "0";
  process.env.MESH_STUB_TURNS = "0";

  const fromFile = await startHostServer({
    home,
    port: 0,
    childScript: spendingChildScript(base),
    dashboardDir: path.join(base, "no-dashboard"),
  });
  try {
    assert.equal((fromFile.supervisor as unknown as { opts: { memoryMb?: number } }).opts.memoryMb, 321);
  } finally {
    await fromFile.close();
  }

  // A flag is a deliberate one-run override of a persisted default.
  const fromFlag = await startHostServer({
    home,
    port: 0,
    projectMemoryMb: 512,
    childScript: spendingChildScript(base),
    dashboardDir: path.join(base, "no-dashboard"),
  });
  try {
    assert.equal((fromFlag.supervisor as unknown as { opts: { memoryMb?: number } }).opts.memoryMb, 512);
  } finally {
    await fromFlag.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
