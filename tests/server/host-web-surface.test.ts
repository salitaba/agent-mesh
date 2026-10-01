/**
 * The multi-project host's browser-facing and network-facing surface.
 *
 * The host is the process a deployment exposes, so it carries the same guard as
 * the single-mesh server (`web-surface.test.ts`) plus two duties of its own: it
 * must not hand the browser's cookie, origin or referrer to a child, and it must
 * not stream an unbounded upload through to one. A child holds a per-launch
 * token and runs agent-authored shell commands; everything it is told should be
 * what the host chose to tell it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { CHILD_READY_PREFIX, type ProjectRef } from "../../packages/projects/src/index";
import { startHostServer, type HostHandle } from "../../apps/mesh-server/src/host";
import { UnsafeListenError } from "../../apps/mesh-server/src/web-security";
import { testConfigYaml } from "../helpers";
import { writeStubScript } from "../support/stub-script";

const OPERATOR = "host-operator-secret-0123456789abcdef";
const AGENTS = { agents: [{ id: "a", role: "r", interests: [] }], mayContact: { a: [] } };

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mesh-host-web-"));
}

function makeProject(base: string, folder: string, id: string): ProjectRef {
  const dir = path.join(base, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "mesh.yaml"), `project:\n  id: ${id}\n${testConfigYaml(AGENTS)}`, "utf8");
  const root = fs.realpathSync(dir);
  return { id, name: id, root, configPath: path.join(root, "mesh.yaml"), addedAt: new Date().toISOString() };
}

/** A stub child that reports which browser-context headers reached it, and how many body bytes. */
function stubChildScript(base: string): string {
  return writeStubScript(
    base,
    "echo-child",
    `
const http = require("http");
const token = process.env.MESH_API_TOKEN || "";
const server = http.createServer((req, res) => {
  const auth = req.headers.authorization || "";
  if (auth !== "Bearer " + token) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "child rejects unauthenticated callers" }));
    return;
  }
  let bytes = 0;
  req.on("data", (c) => { bytes += c.length; });
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      bytes,
      cookie: req.headers.cookie || null,
      origin: req.headers.origin || null,
      referer: req.headers.referer || null,
      secFetch: Object.keys(req.headers).filter((h) => h.startsWith("sec-fetch-")),
      host: req.headers.host,
      auth: auth === "Bearer " + token,
    }));
  });
});
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  process.stdout.write(\`${CHILD_READY_PREFIX} \${JSON.stringify({ port, pid: process.pid, projectId: process.env.MESH_CHILD_PROJECT_ID, url: "http://127.0.0.1:" + port })}\\n\`);
});
process.on("SIGTERM", () => process.exit(0));
`,
  );
}

async function startHost(base: string): Promise<HostHandle> {
  return startHostServer({
    home: path.join(base, "home"),
    port: 0,
    childScript: stubChildScript(base),
    readyTimeoutMs: 10_000,
    stopGraceMs: 2_000,
    dashboardDir: path.join(base, "no-dashboard"),
  });
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  json: any;
}

function raw(
  base: string,
  init: { method?: string; path: string; headers?: Record<string, string>; body?: string | Buffer; chunks?: number; chunkBytes?: number },
): Promise<Reply> {
  const u = new URL(base);
  return new Promise<Reply>((resolve, reject) => {
    const r = http.request(
      { host: u.hostname, port: Number(u.port), method: init.method ?? "GET", path: init.path, headers: init.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: any;
          try {
            json = JSON.parse(text);
          } catch {
            /* not every answer is JSON */
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, json });
        });
      },
    );
    // The host may close the connection after a 413 while a large write is still going.
    r.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ECONNRESET" || err.code === "EPIPE") return;
      reject(err);
    });
    if (init.body !== undefined) r.write(init.body);
    if (init.chunks) {
      const piece = Buffer.alloc(init.chunkBytes ?? 1024, 0x78);
      for (let i = 0; i < init.chunks; i++) r.write(piece);
    }
    r.end();
  });
}

const savedToken = process.env.MESH_API_TOKEN;
const savedMax = process.env.MESH_MAX_BODY_BYTES;
function restoreEnv(): void {
  if (savedToken === undefined) delete process.env.MESH_API_TOKEN;
  else process.env.MESH_API_TOKEN = savedToken;
  if (savedMax === undefined) delete process.env.MESH_MAX_BODY_BYTES;
  else process.env.MESH_MAX_BODY_BYTES = savedMax;
}

async function withHost(fn: (ctx: { host: HostHandle; base: string; root: string }) => Promise<void>): Promise<void> {
  const base = tmpRoot();
  process.env.MESH_API_TOKEN = OPERATOR;
  const host = await startHost(base);
  try {
    await fn({ host, base: host.url, root: base });
  } finally {
    await host.close();
    restoreEnv();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

const auth = { authorization: `Bearer ${OPERATOR}` };

test("host probes: /healthz and /readyz need no credential and no particular Host; draining flips /readyz", { timeout: 30_000 }, async () => {
  await withHost(async ({ host, base }) => {
    const live = await raw(base, { path: "/healthz", headers: { host: "10.244.1.7:7420" } });
    assert.equal(live.status, 200);
    assert.deepEqual(live.json, { status: "ok" });
    const ready = await raw(base, { path: "/readyz" });
    assert.equal(ready.status, 200);
    assert.deepEqual(ready.json, { status: "ready" });
    host.server.beginDrain();
    const draining = await raw(base, { path: "/readyz" });
    assert.equal(draining.status, 503, "a host that is shutting down stops taking new work");
    assert.deepEqual(draining.json, { status: "draining" });
    assert.equal((await raw(base, { path: "/healthz" })).status, 200, "but it is still alive while it drains");
  });
});

test("host: the detailed /health, which names the open projects, needs the token; the probes do not", { timeout: 30_000 }, async () => {
  await withHost(async ({ host, base, root }) => {
    const ref = makeProject(root, "secret-customer", "secret-customer");
    await host.registry.add(ref.root);
    await host.registry.open("secret-customer");
    const anonymous = await raw(base, { path: "/health" });
    assert.equal(anonymous.status, 401, "no credential, no project ids");
    assert.doesNotMatch(JSON.stringify(anonymous.json), /secret-customer/);
    const signedIn = await raw(base, { path: "/health", headers: auth });
    assert.equal(signedIn.status, 200);
    assert.deepEqual(signedIn.json.open, ["secret-customer"]);
    assert.equal((await raw(base, { path: "/healthz" })).status, 200, "the liveness probe is the unauthenticated one");
  });
});

test("host: no answer carries Access-Control-Allow-Origin, and API answers are not framed or cached", { timeout: 30_000 }, async () => {
  await withHost(async ({ base }) => {
    for (const [what, reply] of [
      ["the registry listing", await raw(base, { path: "/api/projects", headers: auth })],
      ["a 401", await raw(base, { path: "/api/projects" })],
      ["a proxy 409 for a project that is not running", await raw(base, { path: "/api/p/nope/status", headers: auth })],
      ["a 404", await raw(base, { path: "/no-such", headers: auth })],
    ] as const) {
      assert.equal(reply.headers["access-control-allow-origin"], undefined, what);
      assert.equal(reply.headers["x-content-type-options"], "nosniff", what);
    }
    const listing = await raw(base, { path: "/api/projects", headers: auth });
    assert.equal(listing.headers["x-frame-options"], "DENY");
    assert.equal(listing.headers["cache-control"], "no-store");
  });
});

test("host: a page cannot drive the registry: a forged cross-origin POST and a rebound Host are both refused", { timeout: 30_000 }, async () => {
  await withHost(async ({ base, root }) => {
    const ref = makeProject(root, "alpha", "alpha");
    const forged = await raw(base, {
      method: "POST",
      path: "/api/projects",
      headers: { ...auth, origin: "https://evil.example", "content-type": "text/plain", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ root: ref.root }),
    });
    assert.equal(forged.status, 403);
    assert.equal(forged.json.code, "cross_origin");
    const rebound = await raw(base, { path: "/api/projects", headers: { ...auth, host: "rebound.evil.example:7420" } });
    assert.equal(rebound.status, 421);
    const listing = await raw(base, { path: "/api/projects", headers: auth });
    assert.deepEqual(listing.json.projects, [], "nothing was registered by either request");
    const own = new URL(base).host;
    const legit = await raw(base, {
      method: "POST",
      path: "/api/projects",
      headers: { ...auth, host: own, origin: `http://${own}`, "content-type": "application/json" },
      body: JSON.stringify({ root: ref.root }),
    });
    assert.equal(legit.status, 201, "the dashboard's own request still works");
  });
});

test("host proxy: the browser's cookie, origin, referrer and fetch metadata never reach a child, and the child sees only its own token", { timeout: 40_000 }, async () => {
  await withHost(async ({ base, root }) => {
    const ref = makeProject(root, "alpha", "alpha");
    const own = new URL(base).host;
    await raw(base, {
      method: "POST",
      path: "/api/projects",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ root: ref.root }),
    });
    const opened = await raw(base, { method: "POST", path: "/api/projects/alpha/open", headers: { ...auth, "content-type": "application/json" }, body: "{}" });
    assert.equal(opened.status, 200);
    const echoed = await raw(base, {
      method: "POST",
      path: "/api/p/alpha/anything",
      headers: {
        ...auth,
        host: own,
        origin: `http://${own}`,
        referer: `http://${own}/#/p/alpha`,
        cookie: "mesh_session=abc123; other=1",
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "content-type": "application/json",
      },
      body: JSON.stringify({ hello: "world" }),
    });
    assert.equal(echoed.status, 200);
    assert.equal(echoed.json.cookie, null, "a session cookie is the host's, not the child's");
    assert.equal(echoed.json.origin, null);
    assert.equal(echoed.json.referer, null);
    assert.deepEqual(echoed.json.secFetch, []);
    assert.equal(echoed.json.auth, true, "the child still got the token the host minted for it");
    assert.match(echoed.json.host, /^127\.0\.0\.1:\d+$/, "and was addressed as itself");
    assert.equal(echoed.json.bytes, JSON.stringify({ hello: "world" }).length, "the body arrived whole");
  });
});

test("host proxy: an upload past the limit is refused with 413 before or while it streams, and a normal one still passes", { timeout: 60_000 }, async () => {
  await withHost(async ({ base, root }) => {
    const ref = makeProject(root, "alpha", "alpha");
    await raw(base, { method: "POST", path: "/api/projects", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ root: ref.root }) });
    await raw(base, { method: "POST", path: "/api/projects/alpha/open", headers: { ...auth, "content-type": "application/json" }, body: "{}" });
    const MiB = 1024 * 1024;
    // Declared: refused before a byte is read.
    const declared = await raw(base, {
      method: "POST",
      path: "/api/p/alpha/upload",
      headers: { ...auth, "content-type": "application/octet-stream", "content-length": String(64 * MiB) },
    });
    assert.equal(declared.status, 413);
    assert.equal(declared.json.code, "payload_too_large");
    // Chunked: no declared length, stopped by the running total (limit is 8 MiB).
    const streamed = await raw(base, {
      method: "POST",
      path: "/api/p/alpha/upload",
      headers: { ...auth, "content-type": "application/octet-stream", "transfer-encoding": "chunked" },
      chunks: 10,
      chunkBytes: MiB,
    });
    assert.equal(streamed.status, 413);
    const fine = await raw(base, {
      method: "POST",
      path: "/api/p/alpha/upload",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ pad: "x".repeat(100_000) }),
    });
    assert.equal(fine.status, 200, "a request under the limit goes through after the refusals");
    assert.ok(fine.json.bytes > 100_000);
  });
});

test("host: a registry body over the limit is refused with 413", { timeout: 30_000 }, async () => {
  await withHost(async ({ base }) => {
    process.env.MESH_MAX_BODY_BYTES = "2048";
    const big = await raw(base, {
      method: "POST",
      path: "/api/projects",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ root: "/x".repeat(5000) }),
    });
    assert.equal(big.status, 413);
  });
});

test("startHostServer refuses a network bind without a strong token before it creates or reads anything", { timeout: 30_000 }, async () => {
  const base = tmpRoot();
  const home = path.join(base, "home");
  const savedInsecure = process.env.MESH_ALLOW_INSECURE_BIND;
  delete process.env.MESH_ALLOW_INSECURE_BIND;
  try {
    for (const token of [undefined, "", "tiny"]) {
      if (token === undefined) delete process.env.MESH_API_TOKEN;
      else process.env.MESH_API_TOKEN = token;
      await assert.rejects(
        startHostServer({ home, port: 0, host: "0.0.0.0", dashboardDir: path.join(base, "none") }),
        (err: unknown) => err instanceof UnsafeListenError,
        `token ${JSON.stringify(token)}`,
      );
    }
    assert.equal(fs.existsSync(home), false, "the refusal came before the registry home was touched");
  } finally {
    restoreEnv();
    if (savedInsecure === undefined) delete process.env.MESH_ALLOW_INSECURE_BIND;
    else process.env.MESH_ALLOW_INSECURE_BIND = savedInsecure;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("startHostServer on a network address starts with a strong token and reports a loopback URL", { timeout: 30_000 }, async () => {
  const base = tmpRoot();
  process.env.MESH_API_TOKEN = OPERATOR;
  let host: HostHandle | undefined;
  try {
    host = await startHostServer({ home: path.join(base, "home"), port: 0, host: "0.0.0.0", dashboardDir: path.join(base, "none") });
    assert.equal(host.url, `http://127.0.0.1:${host.port}`);
    assert.equal((await raw(host.url, { path: "/api/projects" })).status, 401);
    assert.equal((await raw(host.url, { path: "/api/projects", headers: auth })).status, 200);
  } finally {
    await host?.close();
    restoreEnv();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
