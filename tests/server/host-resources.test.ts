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
 *
 * `/escalations/host-ceiling` is recorded the same way and for a stronger
 * version of the same reason: the host-side once-guard is trivially provable
 * from the host's own Set, and trivially wrong if the call never leaves the
 * process. Counting the requests that actually arrived at a child is the only
 * assertion that can fail when the guard is removed.
 *
 * `MESH_STUB_SPENDFILE`, when set, replaces the fixed env numbers with a JSON
 * file re-read on every beat, so a test can make spend genuinely climb inside
 * a live host instead of restarting one with bigger constants.
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
// Derived, not its own env var. Every test sets the park file to a path inside
// its own temp dir; a second variable only some helpers set survives into the
// next test pointing at a directory that has been removed, and an append that
// throws in a request handler takes the whole stub child down with it.
const escFile = parkFile ? parkFile + ".escalations" : "";
const spendFile = process.env.MESH_STUB_SPENDFILE;
// A parked child has stopped its scheduler, so it reports no turns in flight.
// That is not decoration: it is the reason the host cannot re-derive a park
// from the next beat, and so the reason the parked list has to be remembered.
let parked = false;
function spend() {
  if (spendFile) {
    // A half-written file is a torn read, not a spend of zero: fall back to
    // the env numbers rather than emitting a beat that says the mesh stopped.
    try { const j = JSON.parse(fs.readFileSync(spendFile, "utf8")); return { input: Number(j.input || 0), output: Number(j.output || 0) }; } catch (e) { /* fall through */ }
  }
  return { input: Number(process.env.MESH_STUB_INPUT || 0), output: Number(process.env.MESH_STUB_OUTPUT || 0) };
}
const server = http.createServer((req, res) => {
  if ((req.headers.authorization || "") !== "Bearer " + token) {
    res.writeHead(401); res.end("{}"); return;
  }
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/mission/park" && req.method === "POST") {
    parked = true;
    fs.appendFileSync(parkFile, process.env.MESH_CHILD_PROJECT_ID + "\\n");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (url.pathname === "/escalations/host-ceiling" && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      // Bookkeeping must never be able to kill the child: a test that never
      // reads this log still gets the host's call answered.
      try { if (escFile) fs.appendFileSync(escFile, process.env.MESH_CHILD_PROJECT_ID + " " + raw.replace(/\\s+/g, "") + "\\n"); } catch (e) { /* ignore */ }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, id: "esc-stub" }));
    });
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
});
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  process.stdout.write(\`${CHILD_READY_PREFIX} \${JSON.stringify({ port, pid: process.pid, projectId: process.env.MESH_CHILD_PROJECT_ID, url: "http://127.0.0.1:" + port })}\\n\`);
  const beat = setInterval(() => {
    const s = spend();
    process.stdout.write(\`${CHILD_BEAT_PREFIX} \${JSON.stringify({
      rss: 1234,
      pid: process.pid,
      models: [{ model: "m", input: s.input, output: s.output }],
      runningTurns: parked ? 0 : Number(process.env.MESH_STUB_TURNS || 0),
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

/** Where the stub child logs the ceiling escalations it was asked to raise. */
function escLogPath(parkFile: string): string {
  return `${parkFile}.escalations`;
}

/** One line per `/escalations/host-ceiling` request that reached a child. */
function escalationsRaised(parkFile: string): Array<{ projectId: string; usd: number; ceilingUsd: number }> {
  const file = escLogPath(parkFile);
  // Absent, not empty: the stub creates it on the first call, so "no file" and
  // "no calls" are the same answer and neither is a failure to read.
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [projectId, payload] = [line.slice(0, line.indexOf(" ")), line.slice(line.indexOf(" ") + 1)];
      const body = JSON.parse(payload) as { usd: number; ceilingUsd: number };
      return { projectId, usd: body.usd, ceilingUsd: body.ceilingUsd };
    });
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

test("a tripped ceiling escalates into each parked child exactly once, however many beats it stays tripped", { timeout: 30_000 }, async () => {
  const base = tmpRoot();
  const a = makeProject(base, "alpha", "alpha");
  const b = makeProject(base, "beta", "beta");
  const parkFile = path.join(base, "parked.log");
  fs.writeFileSync(parkFile, "", "utf8");
  const config = defaultHostConfig();
  config.spendCeilingUsd = 5;
  config.modelPrices = { m: { inputPerMtok: 3, outputPerMtok: 15 } };
  // $18 per child, so the ceiling is over on the very first beat and stays
  // over: spend is monotonic and nothing here lowers it.
  process.env.MESH_STUB_INPUT = "1000000";
  process.env.MESH_STUB_OUTPUT = "1000000";
  process.env.MESH_STUB_TURNS = "0";
  const host = await startHost(base, config, parkFile);
  try {
    await addAndOpen(host, a.root);
    await addAndOpen(host, b.root);
    // Long enough for well over a dozen beats from each child. Each one calls
    // `applyLimits`, and each call finds the ceiling still over.
    await settle(900);

    const tripped = (await (await fetch(`${host.url}/api/projects`)).json()) as { spend: { ceilingTripped: boolean } };
    assert.equal(tripped.spend.ceilingTripped, true, "the ceiling is still over, beat after beat");

    // THE regression. Parking is idempotent at the child, so the original
    // silent trip cost nothing to repeat — raising a card does not. Without
    // the once-guard this is one HTTP request per child per beat for as long
    // as the operator takes to notice, which is a worse cost bug than the
    // silence it was added to fix. Exactly one per child, forever.
    const raised = escalationsRaised(parkFile);
    assert.equal(raised.length, 2, `one card per parked project, not ${raised.length}: ${JSON.stringify(raised)}`);
    assert.deepEqual(raised.map((r) => r.projectId).sort(), ["alpha", "beta"]);

    // The card is raised in each child, not on the host, because that is the
    // page an operator is on when a mission goes quiet.
    for (const r of raised) {
      assert.equal(r.ceilingUsd, 5, "the card quotes the ceiling that was breached");
      assert.ok(r.usd >= 5, "and the total that breached it");
    }

    // Both facts come from the same tick, so a card must never appear for a
    // project the host did not actually stop.
    const parked = new Set(fs.readFileSync(parkFile, "utf8").split("\n").filter(Boolean));
    assert.deepEqual([...parked].sort(), ["alpha", "beta"]);
  } finally {
    await host.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a ceiling raised and then spent through escalates a second time", { timeout: 30_000 }, async () => {
  const base = tmpRoot();
  const a = makeProject(base, "alpha", "alpha");
  const b = makeProject(base, "beta", "beta");
  const parkFile = path.join(base, "parked.log");
  fs.writeFileSync(parkFile, "", "utf8");
  // Spend the children report, re-read on every beat: the point of this test
  // is a total that genuinely climbs inside one live host.
  const spendFile = path.join(base, "spend.json");
  fs.writeFileSync(spendFile, JSON.stringify({ input: 1_000_000, output: 1_000_000 }), "utf8");
  process.env.MESH_STUB_SPENDFILE = spendFile;
  const config = defaultHostConfig();
  config.spendCeilingUsd = 5;
  config.modelPrices = { m: { inputPerMtok: 3, outputPerMtok: 15 } };
  process.env.MESH_STUB_TURNS = "0";
  const host = await startHost(base, config, parkFile);
  try {
    await addAndOpen(host, a.root);
    await addAndOpen(host, b.root);
    await settle(400);

    // $18 per child, $36 total, over a $5 ceiling.
    assert.equal(escalationsRaised(parkFile).length, 2, "the first trip escalates");
    assert.deepEqual(
      escalationsRaised(parkFile).map((r) => r.ceilingUsd),
      [5, 5],
    );

    // The operator raises the ceiling past the total. Mutating the object the
    // host holds is what the settings route does — `applyLimits` reads it at
    // call time.
    config.spendCeilingUsd = 100;
    await settle(400);
    const cleared = (await (await fetch(`${host.url}/api/projects`)).json()) as { spend: { ceilingTripped: boolean } };
    assert.equal(cleared.spend.ceilingTripped, false, "a raised ceiling un-trips");
    assert.equal(escalationsRaised(parkFile).length, 2, "un-tripping raises nothing on its own");

    // ...and the mesh spends through the new one: $54 per child, $108 total.
    fs.writeFileSync(spendFile, JSON.stringify({ input: 3_000_000, output: 3_000_000 }), "utf8");
    await settle(600);

    // What this pins: the guard is cleared by the un-trip, not filled for the
    // life of the process. A guard that only ever grew would make the first
    // trip the last one anyone was told about, and the second ceiling would be
    // just as silent as the bug this whole route exists to fix.
    const raised = escalationsRaised(parkFile);
    assert.equal(raised.length, 4, `a second trip, a second card per project: ${JSON.stringify(raised)}`);
    const second = raised.slice(2);
    assert.deepEqual(second.map((r) => r.projectId).sort(), ["alpha", "beta"]);
    for (const r of second) {
      // The new ceiling, not the old one. This number is the child's dedupe
      // key, so a stale value here would have the child swallow the card even
      // though the host correctly sent it.
      assert.equal(r.ceilingUsd, 100);
      assert.ok(r.usd > 100, `the total that breached the raised ceiling, got ${r.usd}`);
    }
  } finally {
    delete process.env.MESH_STUB_SPENDFILE;
    await host.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("raising the ceiling un-trips it on the next beat", { timeout: 30_000 }, async () => {
  const base = tmpRoot();
  const a = makeProject(base, "alpha", "alpha");
  const b = makeProject(base, "beta", "beta");
  const parkFile = path.join(base, "parked.log");
  fs.writeFileSync(parkFile, "", "utf8");
  const config = defaultHostConfig();
  config.spendCeilingUsd = 5;
  config.modelPrices = { m: { inputPerMtok: 3, outputPerMtok: 15 } };
  // $18 per child, $36 across the two: over a $5 ceiling, under a $100 one.
  process.env.MESH_STUB_INPUT = "1000000";
  process.env.MESH_STUB_OUTPUT = "1000000";
  process.env.MESH_STUB_TURNS = "0";
  const host = await startHost(base, config, parkFile);
  try {
    await addAndOpen(host, a.root);
    await addAndOpen(host, b.root);
    await settle(400);

    const tripped = (await (await fetch(`${host.url}/api/projects`)).json()) as {
      spend: { ceilingTripped: boolean; parked: string[] };
    };
    assert.equal(tripped.spend.ceilingTripped, true, "the ceiling trips first");
    assert.deepEqual([...tripped.spend.parked].sort(), ["alpha", "beta"]);

    // Mutating the same object the host holds is what an editable ceiling will
    // do: `applyLimits` reads `spendCeilingUsd` at call time, not at
    // construction, so the next beat sees the new number with no restart.
    config.spendCeilingUsd = 100;
    await settle(400);

    const cleared = (await (await fetch(`${host.url}/api/projects`)).json()) as {
      spend: { usd: number; ceilingUsd: number | null; ceilingTripped: boolean };
    };
    assert.equal(cleared.spend.ceilingUsd, 100);
    // The regression this pins: the flag was set once and never cleared, so a
    // host that had correctly resumed still reported a trip, and the Overview
    // strip announced "Parked — the host hit its spend ceiling" over a healthy
    // mesh. Worse than the original bug, where the message was at least true.
    assert.equal(cleared.spend.ceilingTripped, false, "a raised ceiling un-trips the flag");
    // Spend never fell — the ceiling rose past it. Without this the assertion
    // above would also pass if the children had simply stopped reporting.
    assert.ok(cleared.spend.usd > 5, "the total is still over the old ceiling");
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

/** The shape `GET`/`PUT /api/host/config` answers with. */
interface HostConfigView {
  path: string;
  config: { spendCeilingUsd: number | null; maxConcurrentTurns: number | null; defaultUsdPerMtok: number };
  explicit: string[];
  effects: Record<string, string>;
}

async function startBareHost(base: string, home: string): Promise<HostHandle> {
  return startHostServer({
    home,
    port: 0,
    childScript: spendingChildScript(base),
    readyTimeoutMs: 10_000,
    stopGraceMs: 2_000,
    dashboardDir: path.join(base, "no-dashboard"),
  });
}

test("a turn-cap park survives the ceiling check falling through", { timeout: 30_000 }, async () => {
  const base = tmpRoot();
  const a = makeProject(base, "alpha", "alpha");
  const b = makeProject(base, "beta", "beta");
  const parkFile = path.join(base, "parked.log");
  fs.writeFileSync(parkFile, "", "utf8");
  const config = defaultHostConfig();
  // A ceiling nothing here will ever reach, so every tick takes the
  // fall-through — which is exactly where the tempting one-line fix would sit.
  config.spendCeilingUsd = 1000;
  config.maxConcurrentTurns = 3;
  config.modelPrices = { m: { inputPerMtok: 3, outputPerMtok: 15 } };
  process.env.MESH_STUB_INPUT = "1000000";
  process.env.MESH_STUB_OUTPUT = "0";
  process.env.MESH_STUB_TURNS = "2"; // 2 + 2 = 4, over a cap of 3
  const host = await startHost(base, config, parkFile);
  try {
    await addAndOpen(host, a.root);
    await addAndOpen(host, b.root);
    await settle(600);

    const body = (await (await fetch(`${host.url}/api/projects`)).json()) as {
      spend: { ceilingTripped: boolean; parked: string[] };
    };
    assert.equal(body.spend.ceilingTripped, false, "the ceiling was never in play");

    // The regression this pins. Clearing the parked list next to
    // `ceilingTripped` on the fall-through reads as the same fix and is not:
    // beta reports no turns once parked, so the cap loop skips it from the
    // next tick onward and never re-adds it. A blanket clear would drop it
    // here and leave a project the host parked with nothing saying so —
    // the original bug's exact shape, one field over.
    assert.deepEqual(body.spend.parked, ["beta"], "beta stays listed while it is still parked");
  } finally {
    await host.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("closing a parked project is what drops it from the parked list", { timeout: 30_000 }, async () => {
  const base = tmpRoot();
  const a = makeProject(base, "alpha", "alpha");
  const b = makeProject(base, "beta", "beta");
  const parkFile = path.join(base, "parked.log");
  fs.writeFileSync(parkFile, "", "utf8");
  const config = defaultHostConfig();
  config.spendCeilingUsd = 5;
  config.modelPrices = { m: { inputPerMtok: 3, outputPerMtok: 15 } };
  process.env.MESH_STUB_INPUT = "1000000";
  process.env.MESH_STUB_OUTPUT = "1000000";
  process.env.MESH_STUB_TURNS = "0";
  const host = await startHost(base, config, parkFile);
  try {
    await addAndOpen(host, a.root);
    await addAndOpen(host, b.root);
    await settle(400);
    const tripped = (await (await fetch(`${host.url}/api/projects`)).json()) as { spend: { parked: string[] } };
    assert.deepEqual([...tripped.spend.parked].sort(), ["alpha", "beta"]);

    await fetch(`${host.url}/api/projects/alpha/close`, { method: "POST" });
    await settle(200);

    // The list outlived the child before this: an id pushed once was never
    // removed, so a project the operator had closed kept reporting as parked
    // for as long as the host lived.
    const after = (await (await fetch(`${host.url}/api/projects`)).json()) as { spend: { parked: string[] } };
    assert.deepEqual(after.spend.parked, ["beta"], "only the project still parked is still listed");
  } finally {
    await host.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("PUT /api/host/config raises the ceiling and un-trips it with no restart", { timeout: 30_000 }, async () => {
  const base = tmpRoot();
  const home = path.join(base, "home");
  fs.mkdirSync(home, { recursive: true });
  // Written as a file, not passed as an object: the reload path reads the file
  // back, so this also proves the operator's other keys survive the write.
  fs.writeFileSync(
    path.join(home, "host.yaml"),
    "host:\n  spend_ceiling_usd: 5\n  model_prices:\n    m:\n      input_per_mtok: 3\n      output_per_mtok: 15\n",
    "utf8",
  );
  const a = makeProject(base, "alpha", "alpha");
  const parkFile = path.join(base, "parked.log");
  fs.writeFileSync(parkFile, "", "utf8");
  process.env.MESH_STUB_PARKFILE = parkFile;
  process.env.MESH_STUB_INPUT = "1000000";
  process.env.MESH_STUB_OUTPUT = "1000000";
  process.env.MESH_STUB_TURNS = "0";
  const host = await startBareHost(base, home);
  try {
    await addAndOpen(host, a.root);
    await settle(400);
    const tripped = (await (await fetch(`${host.url}/api/projects`)).json()) as { spend: { ceilingTripped: boolean } };
    assert.equal(tripped.spend.ceilingTripped, true, "$18 of spend trips a $5 ceiling");

    const put = await fetch(`${host.url}/api/host/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spendCeilingUsd: 100, confirm: true }),
    });
    assert.equal(put.status, 200);
    const saved = (await put.json()) as HostConfigView;
    assert.equal(saved.config.spendCeilingUsd, 100);
    assert.ok(saved.explicit.includes("spend_ceiling_usd"), "a saved key reads as explicitly set");

    // No restart, and no waiting for the next beat: the route enforces before
    // it answers, so the trip is already gone by the time the operator sees
    // the response. This is the whole point of the `let` binding.
    const now = (await (await fetch(`${host.url}/api/projects`)).json()) as {
      spend: { usd: number; ceilingUsd: number | null; ceilingTripped: boolean };
    };
    assert.equal(now.spend.ceilingUsd, 100);
    assert.equal(now.spend.ceilingTripped, false);
    assert.ok(now.spend.usd > 5, "the total never fell — the ceiling rose past it");

    const text = fs.readFileSync(path.join(home, "host.yaml"), "utf8");
    assert.match(text, /spend_ceiling_usd: 100/);
    assert.match(text, /input_per_mtok: 3/, "the keys the UI did not touch are still there");
  } finally {
    await host.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("raising a spend ceiling needs a confirm; lowering one does not", { timeout: 30_000 }, async () => {
  const base = tmpRoot();
  const home = path.join(base, "home");
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "host.yaml"), "host:\n  spend_ceiling_usd: 5\n", "utf8");
  const host = await startBareHost(base, home);
  try {
    const bare = await fetch(`${host.url}/api/host/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spendCeilingUsd: 100 }),
    });
    // The cap was the only thing that noticed a mesh spending $53.33 against
    // nothing but unsatisfied criteria. The one edit that can un-notice it
    // asks first.
    assert.equal(bare.status, 409);
    const refusal = (await bare.json()) as { needsConfirm: boolean; from: number; to: number };
    assert.equal(refusal.needsConfirm, true);
    assert.equal(refusal.from, 5);
    assert.equal(refusal.to, 100);
    assert.match(fs.readFileSync(path.join(home, "host.yaml"), "utf8"), /spend_ceiling_usd: 5/);

    // Removing the ceiling is the largest raise there is, so it asks too.
    const off = await fetch(`${host.url}/api/host/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spendCeilingUsd: null }),
    });
    assert.equal(off.status, 409);

    // Tightening a limit needs no ceremony — the friction is about spending
    // more, not about touching the setting.
    const lower = await fetch(`${host.url}/api/host/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spendCeilingUsd: 2 }),
    });
    assert.equal(lower.status, 200);
    assert.equal(((await lower.json()) as HostConfigView).config.spendCeilingUsd, 2);
  } finally {
    await host.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("GET /api/host/config separates a value in force from a value chosen", { timeout: 30_000 }, async () => {
  const base = tmpRoot();
  const home = path.join(base, "home");
  fs.mkdirSync(home, { recursive: true });
  // No host.yaml at all: the case that started this work, where a $50 ceiling
  // parks a mesh and the file the operator is told to check does not exist.
  const host = await startBareHost(base, home);
  try {
    const body = (await (await fetch(`${host.url}/api/host/config`)).json()) as HostConfigView;
    assert.equal(body.config.spendCeilingUsd, 50, "the default ceiling is in force");
    assert.deepEqual(body.explicit, [], "and nobody chose it");

    // Per key, because one undifferentiated Save is the original trap rebuilt.
    assert.equal(body.effects.spend_ceiling_usd, "live");
    assert.equal(body.effects.max_concurrent_turns, "live");
    // Not "next project open", which is the intuitive answer: the running
    // supervisor captured this value at host start and spawns from that copy.
    assert.equal(body.effects.project_memory_mb, "host-restart");

    // Validation is the shared package's, not the route's and not the UI's.
    const bad = await fetch(`${host.url}/api/host/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spendCeilingUsd: -5 }),
    });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /spend_ceiling_usd must be a positive number/);

    const unknown = await fetch(`${host.url}/api/host/config`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonsense: 1 }),
    });
    assert.equal(unknown.status, 400);
  } finally {
    await host.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
