/**
 * The commercial surface of the servers: what a licence changes, and what it never does.
 *
 * Three promises are held here. (1) In `warn`, the default, nothing is refused, whatever the plan: a breach is
 * reported and the work goes on. (2) In `enforce`, what the plan does not allow does not START (a mesh with
 * too many seats, a project over the cap, a feature the plan lacks) and nothing already running is touched.
 * (3) The answers are honest about what they are: usage tokens are exact and its dollars an estimate that says so.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { createHttpServer, closeHttpServer, startServer } from "../../apps/mesh-server/src/index";
import { startHostServer, type HostHandle } from "../../apps/mesh-server/src/host";
import { LicenseLimitError, LicenseProvider } from "../../apps/mesh-server/src/license";
import { CHILD_READY_PREFIX } from "../../packages/projects/src/index";
import { generateLicenseKeyPair, signLicense, type LicenseClaims } from "../../packages/licensing/src/index";
import { makeMesh, testConfigYaml } from "../helpers";
import { writeStubScript } from "../support/stub-script";

const keys = generateLicenseKeyPair();
const PUBLIC = { k1: keys.publicKey };
const NOW = new Date();
const DAY = 24 * 60 * 60 * 1000;
const at = (days: number): string => new Date(NOW.getTime() + days * DAY).toISOString();

function licence(plan: LicenseClaims["plan"], over: Partial<LicenseClaims> = {}): string {
  return signLicense({ v: 1, id: "lic_test", customer: "Acme Robotics", plan, issuedAt: at(-30), expiresAt: at(300), ...over }, "k1", keys.privateKeyPem);
}

function provider(opts: { token?: string; enforcement?: "off" | "warn" | "enforce" }): LicenseProvider {
  const env: NodeJS.ProcessEnv = { MESH_LICENSE_ENFORCEMENT: opts.enforcement ?? "warn", ...(opts.token ? { MESH_LICENSE: opts.token } : {}) };
  return new LicenseProvider({ home: fs.mkdtempSync(path.join(os.tmpdir(), "mesh-lic-home-")), env, publicKeys: PUBLIC, ttlMs: 0 });
}

function call(base: string, method: string, p: string, body?: unknown): Promise<{ status: number; headers: http.IncomingHttpHeaders; text: string; json: any }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: Number(u.port), method, path: p, headers: { "content-type": "application/json" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: any;
        try {
          json = JSON.parse(text);
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

const savedToken = process.env.MESH_API_TOKEN;
const restoreToken = (): void => {
  if (savedToken === undefined) delete process.env.MESH_API_TOKEN;
  else process.env.MESH_API_TOKEN = savedToken;
};

// ------------------------------------------------------------ single mesh

async function withMesh(
  licenses: LicenseProvider,
  fn: (ctx: { base: string; m: Awaited<ReturnType<typeof makeMesh>> }) => Promise<void>,
  opts: { persist?: boolean } = {},
): Promise<void> {
  delete process.env.MESH_API_TOKEN;
  // `persist` gives the mesh an event log on disk, which is what /usage reads; an in-memory mesh has none.
  const m = await makeMesh({ agents: [{ id: "a", role: "developer", interests: [] }, { id: "b", role: "reviewer", interests: [] }], mayContact: { a: ["b"], b: ["a"] }, mode: "parked", persist: opts.persist === true });
  const server = createHttpServer(m, { dashboardDir: undefined, licenses });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await fn({ base, m });
  } finally {
    await closeHttpServer(server);
    await m.cleanup();
    restoreToken();
  }
}

test("GET /license says what the install is entitled to and how much of it is in use", async () => {
  await withMesh(provider({ token: licence("team"), enforcement: "enforce" }), async ({ base }) => {
    const r = await call(base, "GET", "/license");
    assert.equal(r.status, 200);
    assert.equal(r.json.plan, "team");
    assert.equal(r.json.status, "valid");
    assert.equal(r.json.customer, "Acme Robotics");
    assert.equal(r.json.enforcement, "enforce");
    assert.equal(r.json.source, "MESH_LICENSE");
    assert.deepEqual(r.json.usage, { seats: 2 });
    assert.deepEqual(r.json.limits, { maxSeatsPerMesh: 12, maxProjects: 5, maxConcurrentTurns: 8 });
    assert.equal(JSON.stringify(r.json).includes(licence("team").split(".")[3]!), false, "the token itself is never echoed");
  });
  await withMesh(provider({}), async ({ base }) => {
    const r = await call(base, "GET", "/license");
    assert.equal(r.json.plan, "community");
    assert.equal(r.json.status, "community");
    assert.equal(r.json.source, undefined, "no licence, no source");
  });
});

test("usage export: under enforce, Community is told which plan has it; Team gets it; warn never refuses", async () => {
  await withMesh(provider({ enforcement: "enforce" }), async ({ base }) => {
    const r = await call(base, "GET", "/usage");
    assert.equal(r.status, 403);
    assert.equal(r.json.code, "license_feature");
    assert.equal(r.json.feature, "usage-export");
    assert.match(r.json.error, /Usage export is not part of the Community plan/);
    assert.match(r.json.error, /curule license install/, "and what to do about it");
  });
  await withMesh(provider({ token: licence("team"), enforcement: "enforce" }), async ({ base }) => {
    const r = await call(base, "GET", "/usage?by=day,agent");
    assert.equal(r.status, 200);
    assert.equal(r.json.licenseWarning, undefined);
    assert.deepEqual(r.json.groupBy, ["day", "agent"]);
  });
  await withMesh(provider({ enforcement: "warn" }), async ({ base }) => {
    const r = await call(base, "GET", "/usage");
    assert.equal(r.status, 200, "warn reports and never refuses");
    assert.match(r.json.licenseWarning, /not part of the Community plan/);
  });
});

test("usage export: CSV and JSON, a bad query is the caller's 400, and the answer says what its money column is", async () => {
  await withMesh(provider({ token: licence("team") }), async ({ base, m }) => {
    await m.store.append({
      id: "evt-1",
      type: "budget.consumed",
      timestamp: "2026-10-01T10:00:00.000Z",
      actorId: "system",
      payload: { agentId: "a", model: "claude-haiku-4-5-20251001", amount: 1200, key: "agent:g/a", input: 100, output: 200, cacheRead: 5000 },
    } as never);
    // An append is visible in memory at once and reaches the file after it; /usage reads the file, so the test waits for the write.
    await m.store.flush?.();
    const json = await call(base, "GET", "/usage?by=model");
    assert.equal(json.status, 200);
    assert.match(json.json.note, /Tokens are exact/);
    // 100 fresh in, 200 out, 900 written to the cache (1200 billed less the two), 5000 read back, at Haiku's list price.
    assert.deepEqual(
      { turns: json.json.totals.turns, input: json.json.totals.inputTokens, output: json.json.totals.outputTokens, cacheWrite: json.json.totals.cacheWriteTokens, cacheRead: json.json.totals.cacheReadTokens },
      { turns: 1, input: 100, output: 200, cacheWrite: 900, cacheRead: 5000 },
    );
    assert.equal(json.json.totals.costUsd, (100 * 1 + 200 * 5 + 900 * 1.25 + 5000 * 0.1) / 1e6, "four token classes, each at its own list price");
    assert.equal(json.json.prices.listPricesAsOf, "2026-10-01");
    assert.ok(json.json.prices.listed.includes("claude-haiku-4-5"));
    const csv = await call(base, "GET", "/usage?format=csv&by=model");
    assert.equal(csv.status, 200);
    assert.match(String(csv.headers["content-type"]), /^text\/csv/);
    assert.match(String(csv.headers["content-disposition"]), /attachment; filename="curule-usage\.csv"/);
    assert.match(csv.text.split("\n")[0]!, /^model,turns,inputTokens,outputTokens/);
    for (const bad of ["by=planet", "format=xml", "since=yesterday", "until=2026-13-45"]) {
      const r = await call(base, "GET", `/usage?${bad}`);
      assert.equal(r.status, 400, bad);
      assert.ok(typeof r.json.error === "string" && r.json.error.length > 10, bad);
    }
  }, { persist: true });
});

test("a single mesh prices /usage from the same host.yaml `curule usage` reads, so the two never disagree", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-usage-prices-"));
  fs.writeFileSync(path.join(home, "host.yaml"), "host:\n  model_prices:\n    claude-haiku-4-5: { input_per_mtok: 2, output_per_mtok: 10, cache_write_per_mtok: 2, cache_read_per_mtok: 0.2 }\n    acme-house-model: 10\n", "utf8");
  const saved = process.env.MESH_HOME;
  process.env.MESH_HOME = home;
  try {
    await withMesh(provider({ token: licence("team") }), async ({ base, m }) => {
      for (const [id, model] of [["evt-1", "claude-haiku-4-5-20251001"], ["evt-2", "acme-house-model"]] as const) {
        await m.store.append({
          id,
          type: "budget.consumed",
          timestamp: "2026-10-01T10:00:00.000Z",
          actorId: "system",
          payload: { agentId: "a", model, amount: 1200, key: "agent:g/a", input: 100, output: 200, cacheRead: 5000 },
        } as never);
      }
      await m.store.flush?.(); // /usage reads the file, which an append reaches after it is visible in memory
      const r = await call(base, "GET", "/usage?by=model");
      assert.equal(r.status, 200);
      const cost = Object.fromEntries(r.json.rows.map((x: { model: string; costUsd: number | null }) => [x.model, x.costUsd]));
      // 100 in, 200 out, 900 cache writes, 5000 cache reads. Haiku at host.yaml's rates: 200 + 2000 + 1800 + 1000 = $0.005.
      assert.equal(cost["claude-haiku-4-5-20251001"], 0.005, "host.yaml's Haiku rates, not the list's $0.002725");
      // A bare number is one rate: 10 in and out, so 12.5 to write the cache and 1 to read it: 1000 + 2000 + 11250 + 5000 = $0.01925.
      assert.equal(cost["acme-house-model"], 0.01925);
      assert.deepEqual(r.json.unpricedModels, []);
    }, { persist: true });
  } finally {
    if (saved === undefined) delete process.env.MESH_HOME;
    else process.env.MESH_HOME = saved;
  }
});

test("the Prometheus endpoint is a scrape in the text format, gated by plan, and carries the licence", async () => {
  await withMesh(provider({ enforcement: "enforce" }), async ({ base }) => {
    const r = await call(base, "GET", "/metrics/prometheus");
    assert.equal(r.status, 403);
    assert.equal(r.json.feature, "prometheus-metrics");
  });
  await withMesh(provider({ token: licence("team", { expiresAt: at(20) }), enforcement: "enforce" }), async ({ base }) => {
    const r = await call(base, "GET", "/metrics/prometheus");
    assert.equal(r.status, 200);
    assert.match(String(r.headers["content-type"]), /^text\/plain; version=0\.0\.4/);
    for (const line of r.text.split("\n").filter((l) => l.length > 0)) {
      assert.match(line, /^(# (HELP|TYPE) [a-zA-Z_:][a-zA-Z0-9_:]* .+|[a-zA-Z_:][a-zA-Z0-9_:]*(\{[^}]*\})? \S+)$/, `every line is exposition format: ${line}`);
    }
    assert.match(r.text, /^curule_up 1$/m);
    assert.match(r.text, /^curule_info\{version="[^"]+",role="mesh",mode="parked",mesh="[^"]+"\} 1$/m);
    assert.match(r.text, /^curule_agents\{lifecycle="[A-Z_]+"\} 2$/m);
    assert.match(r.text, /^curule_license_info\{plan="team",status="valid",enforcement="enforce"\} 1$/m);
    assert.match(r.text, /^curule_license_expires_timestamp_seconds \d{10}$/m);
    assert.match(r.text, /^curule_license_limit\{limit="seats_per_mesh"\} 12$/m);
    assert.match(r.text, /^curule_license_in_use\{what="seats"\} 2$/m);
  });
  await withMesh(provider({ enforcement: "warn" }), async ({ base }) => {
    assert.equal((await call(base, "GET", "/metrics/prometheus")).status, 200, "warn never refuses");
  });
});

// ---------------------------------------------------------- seats at start

function meshFile(seats: number): { dir: string; configPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-seats-"));
  const agents = Array.from({ length: seats }, (_, i) => ({ id: `s${i}`, role: "developer", interests: [] as string[] }));
  const configPath = path.join(dir, "mesh.yaml");
  fs.writeFileSync(configPath, testConfigYaml({ agents, mayContact: Object.fromEntries(agents.map((a) => [a.id, [] as string[]])) }), "utf8");
  return { dir, configPath };
}

test("a mesh over the plan's seats does not START under enforce, before it opens a port or takes a lock", async () => {
  const { dir, configPath } = meshFile(9); // Community allows 8
  try {
    await assert.rejects(
      startServer({ configPath, gitMode: "off", host: "127.0.0.1", port: 0, mode: "parked", licenses: provider({ enforcement: "enforce" }) }),
      (err: unknown) => err instanceof LicenseLimitError && /9 seats; the Community plan allows 8 per mesh/.test((err as Error).message) && /curule license install/.test((err as Error).message),
    );
    assert.equal(fs.existsSync(path.join(dir, "workspace")), false, "nothing was created: the refusal came before the boot");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the same mesh starts under warn, with the breach said once, and under a plan that allows it", async () => {
  const { dir, configPath } = meshFile(9);
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => void warnings.push(a.join(" "));
  const handles: Awaited<ReturnType<typeof startServer>>[] = [];
  try {
    handles.push(await startServer({ configPath, inMemory: true, gitMode: "off", host: "127.0.0.1", port: 0, mode: "parked", licenses: provider({ enforcement: "warn" }) }));
    assert.equal(warnings.filter((w) => /9 seats; the Community plan allows 8/.test(w)).length, 1, JSON.stringify(warnings));
    warnings.length = 0;
    handles.push(await startServer({ configPath, inMemory: true, gitMode: "off", host: "127.0.0.1", port: 0, mode: "parked", licenses: provider({ token: licence("team"), enforcement: "enforce" }) }));
    assert.deepEqual(warnings.filter((w) => /seats/.test(w)), [], "Team allows 12");
  } finally {
    console.warn = realWarn;
    for (const h of handles) await h.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("an expiring licence is said at start, where an operator will see it", async () => {
  const { dir, configPath } = meshFile(2);
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => void warnings.push(a.join(" "));
  let handle: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    handle = await startServer({ configPath, inMemory: true, gitMode: "off", host: "127.0.0.1", port: 0, mode: "parked", licenses: provider({ token: licence("team", { expiresAt: at(10) }) }) });
    assert.ok(warnings.some((w) => /expires on \d{4}-\d\d-\d\d \(10 day\(s\)\)/.test(w)), JSON.stringify(warnings));
  } finally {
    console.warn = realWarn;
    await handle?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------------- host

function stubChild(base: string): string {
  return writeStubScript(
    base,
    "lic-child",
    `
const http = require("http");
const token = process.env.MESH_API_TOKEN || "";
const server = http.createServer((req, res) => {
  if ((req.headers.authorization || "") !== "Bearer " + token) { res.writeHead(401); res.end("{}"); return; }
  res.writeHead(200, { "content-type": "application/json" });
  res.end("{}");
});
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  process.stdout.write(\`${CHILD_READY_PREFIX} \${JSON.stringify({ port, pid: process.pid, projectId: process.env.MESH_CHILD_PROJECT_ID, url: "http://127.0.0.1:" + port })}\\n\`);
});
process.on("SIGTERM", () => process.exit(0));
`,
  );
}

async function withHost(licenses: LicenseProvider, fn: (ctx: { host: HostHandle; base: string; add: (id: string) => Promise<void> }) => Promise<void>, hostYaml?: string): Promise<void> {
  delete process.env.MESH_API_TOKEN;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-host-lic-"));
  const home = path.join(base, "home");
  if (hostYaml) {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "host.yaml"), hostYaml, "utf8");
  }
  const host = await startHostServer({ home, port: 0, childScript: stubChild(base), readyTimeoutMs: 10_000, stopGraceMs: 2_000, dashboardDir: path.join(base, "none"), licenses });
  const add = async (id: string): Promise<void> => {
    const dir = path.join(base, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "mesh.yaml"), `project:\n  id: ${id}\n${testConfigYaml({ agents: [{ id: "a", role: "r", interests: [] }], mayContact: { a: [] } })}`, "utf8");
    const r = await call(host.url, "POST", "/api/projects", { root: dir });
    assert.equal(r.status, 201, JSON.stringify(r.json));
  };
  try {
    await fn({ host, base: host.url, add });
  } finally {
    await host.close();
    restoreToken();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

test("host: the second open project is refused under enforce on Community, with the plan and the way out named; the first still opens", { timeout: 60_000 }, async () => {
  await withHost(provider({ enforcement: "enforce" }), async ({ base, add }) => {
    await add("one");
    await add("two");
    assert.equal((await call(base, "POST", "/api/projects/one/open")).status, 200);
    const second = await call(base, "POST", "/api/projects/two/open");
    assert.equal(second.status, 403);
    assert.equal(second.json.code, "license_limit");
    assert.equal(second.json.limit, "projects");
    assert.match(second.json.error, /Opening this project would make 2 open; the Community plan allows 1/);
    assert.match(second.json.error, /curule license install/);
    // Nothing that was running was touched, and asking again for the one that is open is not a second one.
    const listing = await call(base, "GET", "/api/projects");
    assert.deepEqual(listing.json.projects.map((p: { id: string; status: string }) => [p.id, p.status]), [["one", "open"], ["two", "closed"]]);
    assert.equal((await call(base, "POST", "/api/projects/one/open")).status, 200, "already open: not counted twice");
    // Closing one makes room.
    assert.equal((await call(base, "POST", "/api/projects/one/close")).status, 200);
    assert.equal((await call(base, "POST", "/api/projects/two/open")).status, 200);
  });
});

test("host: under warn the same second project opens, and a Team plan opens it under enforce", { timeout: 60_000 }, async () => {
  await withHost(provider({ enforcement: "warn" }), async ({ base, add }) => {
    await add("one");
    await add("two");
    assert.equal((await call(base, "POST", "/api/projects/one/open")).status, 200);
    assert.equal((await call(base, "POST", "/api/projects/two/open")).status, 200, "warn reports and never refuses");
  });
  await withHost(provider({ token: licence("team"), enforcement: "enforce" }), async ({ base, add }) => {
    await add("one");
    await add("two");
    assert.equal((await call(base, "POST", "/api/projects/one/open")).status, 200);
    assert.equal((await call(base, "POST", "/api/projects/two/open")).status, 200, "Team allows 5");
  });
});

test("host: GET /api/license and the aggregate spend show the cap in force, the plan's tightened to host.yaml's only under enforce", { timeout: 60_000 }, async () => {
  await withHost(
    provider({ enforcement: "enforce" }),
    async ({ base }) => {
      const lic = await call(base, "GET", "/api/license");
      assert.equal(lic.status, 200);
      assert.equal(lic.json.plan, "community");
      assert.deepEqual(lic.json.usage, { registered: 0, open: 0 });
      const projects = await call(base, "GET", "/api/projects");
      assert.equal(projects.json.spend.maxConcurrentTurns, 4, "host.yaml says 16; the Community plan says 4; enforce takes the tighter");
    },
    "host:\n  max_concurrent_turns: 16\n",
  );
  await withHost(
    provider({ enforcement: "warn" }),
    async ({ base }) => {
      const projects = await call(base, "GET", "/api/projects");
      assert.equal(projects.json.spend.maxConcurrentTurns, 16, "warn leaves the operator's setting alone: a limit that is only reported cannot also be applied");
    },
    "host:\n  max_concurrent_turns: 16\n",
  );
});

test("host: usage export and the Prometheus scrape are gated by plan, honest about prices, and cover every project", { timeout: 60_000 }, async () => {
  await withHost(provider({ enforcement: "enforce" }), async ({ base }) => {
    assert.equal((await call(base, "GET", "/api/usage")).status, 403);
    assert.equal((await call(base, "GET", "/metrics/prometheus")).status, 403);
  });
  await withHost(provider({ token: licence("team"), enforcement: "enforce" }), async ({ base, add }) => {
    await add("one");
    await add("two");
    await call(base, "POST", "/api/projects/one/open");
    const usage = await call(base, "GET", "/api/usage?by=project");
    assert.equal(usage.status, 200);
    assert.equal(usage.json.groupBy[0], "project");
    assert.match(usage.json.note, /Tokens are exact/);
    const csv = await call(base, "GET", "/api/usage?format=csv");
    assert.match(String(csv.headers["content-type"]), /^text\/csv/);
    const scrape = await call(base, "GET", "/metrics/prometheus");
    assert.equal(scrape.status, 200);
    assert.match(scrape.text, /^curule_info\{version="[^"]+",role="host"\} 1$/m);
    assert.match(scrape.text, /^curule_projects\{status="open"\} 1$/m);
    assert.match(scrape.text, /^curule_projects\{status="closed"\} 1$/m);
    assert.match(scrape.text, /^curule_project_up\{project="one"\} 1$/m);
    assert.match(scrape.text, /^curule_project_up\{project="two"\} 0$/m);
    assert.match(scrape.text, /^curule_spend_ceiling_usd 50$/m, "the default $50 ceiling is on the scrape");
    assert.match(scrape.text, /^curule_license_in_use\{what="projects"\} 1$/m);
    assert.match(scrape.text, /^curule_license_in_use\{what="registered"\} 2$/m);
    assert.match(scrape.text, /^curule_license_limit\{limit="projects"\} 5$/m);
  });
});

test("host: the legacy bare /metrics still reaches a project, and /metrics/prometheus is the host's own", { timeout: 60_000 }, async () => {
  await withHost(provider({ token: licence("team") }), async ({ base, add }) => {
    await add("one");
    await call(base, "POST", "/api/projects/one/open");
    const bare = await call(base, "GET", "/metrics");
    assert.equal(bare.status, 200, "the child answered it (the stub answers {} to anything)");
    assert.equal((await call(base, "GET", "/metrics/prometheus")).status, 200);
    assert.match((await call(base, "GET", "/metrics/prometheus")).text, /curule_up 1/);
  });
});
