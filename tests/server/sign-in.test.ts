/**
 * Dashboard sign-in, over a real socket: the single-mesh server and the host.
 *
 * Before this the dashboard sent no credential at all, so with a token set every API call was a 401
 * and the shell was public: operators ran open, or put one shared bearer in a proxy. Now the page
 * trades the token once for an HttpOnly cookie. A cookie is ambient authority, which is the reason
 * for most of the cases below: it must not authenticate a forged cross-site request, a stale one
 * must not lock its owner out, and the token itself must not travel in a URL.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { createHttpServer, closeHttpServer } from "../../apps/mesh-server/src/index";
import { startHostServer, type HostHandle } from "../../apps/mesh-server/src/host";
import { CHILD_READY_PREFIX } from "../../packages/projects/src/index";
import { makeMesh, testConfigYaml } from "../helpers";
import { writeStubScript } from "../support/stub-script";

const OPERATOR = "sign-in-operator-secret-0123456789abcdef";

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  json: any;
  body: string;
}

function raw(base: string, init: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<Reply> {
  const u = new URL(base);
  return new Promise<Reply>((resolve, reject) => {
    const r = http.request({ host: u.hostname, port: Number(u.port), method: init.method ?? "GET", path: init.path, headers: init.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        let json: any;
        try {
          json = JSON.parse(body);
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, json, body });
      });
    });
    r.on("error", reject);
    if (init.body !== undefined) r.write(init.body);
    r.end();
  });
}

const JSON_HEADERS = { "content-type": "application/json" };

/** The `name=value` half of a Set-Cookie, ready to send back. */
function cookieOf(reply: Reply): string {
  const set = reply.headers["set-cookie"];
  assert.ok(set && set.length > 0, "a Set-Cookie header");
  return set[0]!.split(";")[0]!;
}

const KEYS = ["MESH_API_TOKEN", "MESH_STRICT_AUTH", "MESH_COOKIE_SECURE", "MESH_TRUST_PROXY", "MESH_ALLOWED_ORIGINS", "MESH_ALLOWED_HOSTS"] as const;
const saved: Record<string, string | undefined> = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
function restoreEnv(): void {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
}

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

async function withMesh(
  fn: (ctx: { base: string; m: Mesh }) => Promise<void>,
  opts: { token?: string | null; strict?: boolean; env?: Record<string, string> } = {},
): Promise<void> {
  restoreEnv();
  if (opts.token === null) delete process.env.MESH_API_TOKEN;
  else process.env.MESH_API_TOKEN = opts.token ?? OPERATOR;
  if (opts.strict) process.env.MESH_STRICT_AUTH = "1";
  for (const [k, v] of Object.entries(opts.env ?? {})) process.env[k] = v;
  const m = await makeMesh({
    agents: [{ id: "a", role: "developer", capabilities: ["repository.write"], interests: [] }],
    mayContact: { a: [] },
    mode: "parked",
  });
  const server = createHttpServer(m, { dashboardDir: undefined });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await fn({ base, m });
  } finally {
    await closeHttpServer(server);
    await m.cleanup();
    restoreEnv();
  }
}

const login = (base: string, token: string, headers: Record<string, string> = {}): Promise<Reply> =>
  raw(base, { method: "POST", path: "/auth/login", headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify({ token }) });

// ------------------------------------------------------------------ status

test("sign-in status: no token means nothing to sign in to; a token means the page must ask", async () => {
  await withMesh(
    async ({ base }) => {
      const r = await raw(base, { path: "/auth/status" });
      assert.deepEqual(r.json, { required: false, authenticated: true });
      const l = await login(base, "anything");
      assert.equal(l.status, 200);
      assert.deepEqual(l.json, { ok: true, required: false });
      assert.equal(l.headers["set-cookie"], undefined, "no session is minted for a server that has no credential");
    },
    { token: null },
  );
  await withMesh(async ({ base }) => {
    const r = await raw(base, { path: "/auth/status" });
    assert.deepEqual(r.json, { required: true, authenticated: false });
    const api = await raw(base, { path: "/status" });
    assert.equal(api.status, 401);
    assert.match(api.json.error, /sign in on the dashboard/);
  });
});

test("the status read says whether THIS caller is let in, by cookie or by bearer, and counts nothing against anyone", async () => {
  await withMesh(async ({ base }) => {
    const cookie = cookieOf(await login(base, OPERATOR));
    assert.equal((await raw(base, { path: "/auth/status", headers: { cookie } })).json.authenticated, true);
    assert.equal((await raw(base, { path: "/auth/status", headers: { authorization: `Bearer ${OPERATOR}` } })).json.authenticated, true);
    // A wrong bearer asked about its own standing is a question, not an attack.
    for (let i = 0; i < 60; i++) {
      const r = await raw(base, { path: "/auth/status", headers: { authorization: "Bearer nope" } });
      assert.equal(r.json.authenticated, false);
      assert.equal(r.status, 200);
    }
  });
});

// ------------------------------------------------------------------- login

test("login: a wrong token is refused and sets nothing; the right one sets an HttpOnly, SameSite=Strict cookie", async () => {
  await withMesh(async ({ base }) => {
    const wrong = await login(base, "not-the-token");
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers["set-cookie"], undefined);
    for (const body of ["", "{}", JSON.stringify({ token: 12345 }), "not json"]) {
      const r = await raw(base, { method: "POST", path: "/auth/login", headers: JSON_HEADERS, body });
      assert.equal(r.status, 401, `body ${JSON.stringify(body)}`);
    }

    const ok = await login(base, OPERATOR);
    assert.equal(ok.status, 200);
    const set = ok.headers["set-cookie"]![0]!;
    assert.match(set, /^mesh_session=[A-Za-z0-9_-]{43};/);
    assert.match(set, /HttpOnly/);
    assert.match(set, /SameSite=Strict/);
    assert.match(set, /Path=\//);
    assert.match(set, /Max-Age=43200/);
    assert.doesNotMatch(set, /Secure/, "plain http://localhost must be able to sign in");
    assert.equal(ok.body.includes(OPERATOR), false, "the token is never echoed");
  });
});

test("login: Secure is set when the operator says the page is on https", async () => {
  await withMesh(
    async ({ base }) => {
      assert.match((await login(base, OPERATOR)).headers["set-cookie"]![0]!, /; Secure$/);
    },
    { env: { MESH_COOKIE_SECURE: "1" } },
  );
  await withMesh(
    async ({ base }) => {
      assert.match((await login(base, OPERATOR, { "x-forwarded-proto": "https" })).headers["set-cookie"]![0]!, /; Secure$/);
      assert.doesNotMatch((await login(base, OPERATOR)).headers["set-cookie"]![0]!, /Secure/);
    },
    { env: { MESH_TRUST_PROXY: "1" } },
  );
});

test("a signed-in browser works: reads and the dashboard's own writes, but never a forged cross-site write", async () => {
  await withMesh(async ({ base, m }) => {
    const cookie = cookieOf(await login(base, OPERATOR));
    assert.equal((await raw(base, { path: "/status", headers: { cookie } })).status, 200);
    const host = new URL(base).host;
    const before = m.kernel.state.goals.size;

    const own = await raw(base, {
      method: "POST",
      path: "/goals",
      headers: { ...JSON_HEADERS, cookie, origin: `http://${host}`, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ description: "from the dashboard" }),
    });
    assert.equal(own.status, 201);

    // The cookie is ambient: a page on another origin makes the browser attach it by itself.
    for (const attacker of [
      { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      { origin: "http://localhost:3000", "sec-fetch-site": "same-site" },
    ]) {
      const forged = await raw(base, {
        method: "POST",
        path: "/goals",
        headers: { "content-type": "text/plain", cookie, ...attacker },
        body: JSON.stringify({ description: "forged" }),
      });
      assert.equal(forged.status, 403, JSON.stringify(attacker));
    }
    assert.equal(m.kernel.state.goals.size, before + 1, "only the dashboard's own request landed");
  });
});

test("logout ends the session on the server, not just in the browser", async () => {
  await withMesh(async ({ base }) => {
    const cookie = cookieOf(await login(base, OPERATOR));
    assert.equal((await raw(base, { path: "/status", headers: { cookie } })).status, 200);
    const out = await raw(base, { method: "POST", path: "/auth/logout", headers: { ...JSON_HEADERS, cookie }, body: "{}" });
    assert.equal(out.status, 200);
    assert.match(out.headers["set-cookie"]![0]!, /Max-Age=0/);
    assert.equal((await raw(base, { path: "/status", headers: { cookie } })).status, 401, "the old cookie is dead even if a browser kept it");
  });
});

test("two servers do not share a sign-in", async () => {
  let cookie = "";
  await withMesh(async ({ base }) => {
    cookie = cookieOf(await login(base, OPERATOR));
  });
  await withMesh(async ({ base }) => {
    assert.equal((await raw(base, { path: "/status", headers: { cookie } })).status, 401, "a restart signs everyone out");
  });
});

// ------------------------------------------------------ tokens and throttling

test("the token is not accepted from the URL", async () => {
  await withMesh(async ({ base }) => {
    for (const q of [`token=${OPERATOR}`, `access_token=${OPERATOR}`]) {
      assert.equal((await raw(base, { path: `/status?${q}` })).status, 401, q);
    }
    assert.equal((await raw(base, { path: "/status", headers: { authorization: `Bearer ${OPERATOR}` } })).status, 200);
    assert.equal((await raw(base, { path: "/status", headers: { "x-mesh-token": OPERATOR } })).status, 200);
  });
});

test("wrong tokens are throttled per address; the right token and a stale cookie are not punished", async () => {
  await withMesh(
    async ({ base }) => {
      const attacker = { "x-forwarded-for": "6.6.6.6" };
      for (let i = 0; i < 30; i++) {
        const r = await raw(base, { path: "/status", headers: { ...attacker, authorization: `Bearer guess-${i}` } });
        assert.equal(r.status, 401, `guess ${i}`);
      }
      const locked = await raw(base, { path: "/status", headers: { ...attacker, authorization: `Bearer ${OPERATOR}` } });
      assert.equal(locked.status, 429, "past the limit even the right token waits: a guess must not be evaluable at speed");
      assert.ok(Number(locked.headers["retry-after"]) >= 1);
      const loginLocked = await login(base, OPERATOR, attacker);
      assert.equal(loginLocked.status, 429);
      assert.ok(Number(loginLocked.headers["retry-after"]) >= 1);

      // Someone else is untouched.
      const other = { "x-forwarded-for": "7.7.7.7" };
      assert.equal((await raw(base, { path: "/status", headers: { ...other, authorization: `Bearer ${OPERATOR}` } })).status, 200);

      // A stale cookie, or none, is a page polling after its session lapsed, not a guess.
      const idle = { "x-forwarded-for": "8.8.8.8" };
      for (let i = 0; i < 80; i++) {
        assert.equal((await raw(base, { path: "/status", headers: { ...idle, cookie: "mesh_session=stale" } })).status, 401);
        assert.equal((await raw(base, { path: "/status", headers: idle })).status, 401);
      }
      assert.equal((await login(base, OPERATOR, idle)).status, 200, "and its owner can still sign in");
    },
    { env: { MESH_TRUST_PROXY: "1" } },
  );
});

test("a successful sign-in clears the count", async () => {
  await withMesh(
    async ({ base }) => {
      const c = { "x-forwarded-for": "9.9.9.9" };
      for (let i = 0; i < 29; i++) await login(base, `wrong-${i}`, c);
      assert.equal((await login(base, OPERATOR, c)).status, 200);
      for (let i = 0; i < 29; i++) assert.equal((await login(base, `wrong-again-${i}`, c)).status, 401, "a fresh allowance");
    },
    { env: { MESH_TRUST_PROXY: "1" } },
  );
});

// ------------------------------------------------------------------- strict

test("a strict (child) server offers no sign-in and accepts no cookie", async () => {
  await withMesh(
    async ({ base }) => {
      const status = await raw(base, { path: "/auth/status", headers: { authorization: `Bearer ${OPERATOR}` } });
      assert.equal(status.status, 404, "no such route on a child");
      const l = await raw(base, { method: "POST", path: "/auth/login", headers: { ...JSON_HEADERS, authorization: `Bearer ${OPERATOR}` }, body: JSON.stringify({ token: OPERATOR }) });
      assert.equal(l.status, 404);
      assert.equal((await raw(base, { path: "/auth/status" })).status, 401, "and it is not public there");
    },
    { strict: true },
  );
});

test("a session cookie is worth nothing to a server that has gone strict", async () => {
  await withMesh(async ({ base }) => {
    const cookie = cookieOf(await login(base, OPERATOR));
    assert.equal((await raw(base, { path: "/status", headers: { cookie } })).status, 200);
    // `requireAuth` reads the mode per request; a child is only ever reached by its host, with its bearer.
    process.env.MESH_STRICT_AUTH = "1";
    assert.equal((await raw(base, { path: "/status", headers: { cookie } })).status, 401);
    assert.equal((await raw(base, { path: "/status", headers: { authorization: `Bearer ${OPERATOR}` } })).status, 200);
  });
});

// ------------------------------------------------------- playground capability

function seedPlayground(m: Mesh): void {
  const pg = path.join(m.config.workspacePath, "apps", "playground");
  fs.mkdirSync(path.join(pg, "assets"), { recursive: true });
  fs.writeFileSync(path.join(pg, "index.html"), "<!doctype html><script src=assets/app.js></script>", "utf8");
  fs.writeFileSync(path.join(pg, "assets", "app.js"), "console.log('hi')", "utf8");
  fs.writeFileSync(path.join(pg, "data.json"), '{"n":1}', "utf8");
}

test("playground: the signed-in dashboard gets a link; the sandboxed page reads its files by that link alone", async () => {
  await withMesh(async ({ base, m }) => {
    seedPlayground(m);
    assert.equal((await raw(base, { method: "POST", path: "/playground/session", headers: JSON_HEADERS, body: "{}" })).status, 401, "minting needs the operator");
    const cookie = cookieOf(await login(base, OPERATOR));
    const minted = await raw(base, { method: "POST", path: "/playground/session", headers: { ...JSON_HEADERS, cookie }, body: "{}" });
    assert.equal(minted.status, 200);
    assert.match(minted.json.path, /^\/_pg\/\d+\.[A-Za-z0-9_-]+\/$/);
    assert.ok(Date.parse(minted.json.expiresAt) > Date.now());

    // No cookie, no bearer: exactly what the opaque-origin iframe sends.
    const page = await raw(base, { path: `${minted.json.path}index.html` });
    assert.equal(page.status, 200);
    assert.match(String(page.headers["content-security-policy"]), /^sandbox .*allow-scripts/);
    assert.doesNotMatch(String(page.headers["content-security-policy"]), /allow-same-origin/);
    assert.equal(page.headers["access-control-allow-origin"], "*", "the page's own fetch must be able to read its own files");
    const root = await raw(base, { path: minted.json.path });
    assert.equal(root.status, 200);
    assert.match(root.body, /assets\/app\.js/);
    assert.equal((await raw(base, { path: `${minted.json.path}assets/app.js` })).status, 200);
    assert.deepEqual((await raw(base, { path: `${minted.json.path}data.json` })).json, { n: 1 });
    assert.equal((await raw(base, { path: `${minted.json.path}missing.js` })).status, 404);
  });
});

test("playground: the link opens the playground directory and nothing else, and a bad one opens nothing", async () => {
  await withMesh(async ({ base, m }) => {
    seedPlayground(m);
    fs.writeFileSync(path.join(m.config.workspacePath, "secret.txt"), "not for the page", "utf8");
    const cookie = cookieOf(await login(base, OPERATOR));
    const { path: link } = (await raw(base, { method: "POST", path: "/playground/session", headers: { ...JSON_HEADERS, cookie }, body: "{}" })).json;

    // Three ways to climb out. A percent-encoded dot segment is resolved by the URL parser before any
    // routing, so it lands outside the capability prefix and meets operator auth; an encoded slash
    // survives parsing and is caught by the containment check when the segment is decoded.
    const escapes: Record<string, number> = { "%2e%2e/%2e%2e/secret.txt": 401, "..%2f..%2fsecret.txt": 400, "%2e%2e%2f%2e%2e%2fsecret.txt": 400 };
    for (const [escape, expected] of Object.entries(escapes)) {
      const r = await raw(base, { path: `${link}${escape}` });
      assert.equal(r.status, expected, escape);
      assert.doesNotMatch(r.body, /not for the page/);
    }
    // Literal dot segments are resolved by the URL parser before routing: it lands outside the prefix, where auth applies.
    assert.equal((await raw(base, { path: `${link}../../status` })).status, 401);

    const [expiry, sig] = link.split("/")[2]!.split(".") as [string, string];
    for (const bad of [`${Number(expiry) + 1000}.${sig}`, `${expiry}.${"A".repeat(sig.length)}`, "0.x", "garbage"]) {
      const r = await raw(base, { path: `/_pg/${bad}/index.html` });
      assert.equal(r.status, 403, bad);
      assert.match(r.json.error, /not valid, or has expired/);
    }
    assert.equal((await raw(base, { path: "/_pg" })).status, 401, "the bare prefix is just a route");
  });
});

test("playground: the plain /playground route still needs the operator, and is sandboxed too", async () => {
  await withMesh(async ({ base, m }) => {
    seedPlayground(m);
    assert.equal((await raw(base, { path: "/playground/" })).status, 401);
    const cookie = cookieOf(await login(base, OPERATOR));
    const r = await raw(base, { path: "/playground/", headers: { cookie } });
    assert.equal(r.status, 200);
    assert.match(String(r.headers["content-security-policy"]), /^sandbox /);
    assert.equal(r.headers["access-control-allow-origin"], undefined, "no CORS on the authenticated route");
  });
});

// -------------------------------------------------------------------- host

function echoChild(base: string): string {
  return writeStubScript(
    base,
    "pg-child",
    `
const http = require("http");
const token = process.env.MESH_API_TOKEN || "";
const server = http.createServer((req, res) => {
  if ((req.headers.authorization || "") !== "Bearer " + token) { res.writeHead(401); res.end("{}"); return; }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ path: req.url, cookie: req.headers.cookie || null }));
});
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  process.stdout.write(\`${CHILD_READY_PREFIX} \${JSON.stringify({ port, pid: process.pid, projectId: process.env.MESH_CHILD_PROJECT_ID, url: "http://127.0.0.1:" + port })}\\n\`);
});
process.on("SIGTERM", () => process.exit(0));
`,
  );
}

test("host: sign-in works the same way, and a project's playground link is let through without an operator credential", { timeout: 40_000 }, async () => {
  restoreEnv();
  process.env.MESH_API_TOKEN = OPERATOR;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-host-signin-"));
  const dir = path.join(base, "alpha");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "mesh.yaml"), `project:\n  id: alpha\n${testConfigYaml({ agents: [{ id: "a", role: "r", interests: [] }], mayContact: { a: [] } })}`, "utf8");
  let host: HostHandle | undefined;
  try {
    host = await startHostServer({ home: path.join(base, "home"), port: 0, childScript: echoChild(base), readyTimeoutMs: 10_000, stopGraceMs: 2_000, dashboardDir: path.join(base, "none") });
    const url = host.url;
    assert.deepEqual((await raw(url, { path: "/auth/status" })).json, { required: true, authenticated: false });
    assert.equal((await raw(url, { path: "/api/projects" })).status, 401);
    assert.equal((await login(url, "wrong")).status, 401);
    const cookie = cookieOf(await login(url, OPERATOR));
    assert.equal((await raw(url, { path: "/api/projects", headers: { cookie } })).status, 200);

    const add = await raw(url, { method: "POST", path: "/api/projects", headers: { ...JSON_HEADERS, cookie }, body: JSON.stringify({ root: dir }) });
    assert.equal(add.status, 201);
    assert.equal((await raw(url, { method: "POST", path: "/api/projects/alpha/open", headers: { ...JSON_HEADERS, cookie }, body: "{}" })).status, 200);

    // The playground link: no credential at all reaches the child's _pg route; nothing else does.
    const viaLink = await raw(url, { path: "/api/p/alpha/_pg/123.abc/index.html" });
    assert.equal(viaLink.status, 200, "the host lets the link through; the child decides whether it is valid");
    assert.equal(viaLink.json.path, "/_pg/123.abc/index.html");
    assert.equal(viaLink.json.cookie, null);
    assert.equal((await raw(url, { path: "/api/p/alpha/status" })).status, 401, "everything else still needs the operator");
    assert.equal((await raw(url, { path: "/api/p/alpha/_pg" })).status, 401, "the bare prefix is not the link route");
    assert.equal((await raw(url, { method: "POST", path: "/api/p/alpha/_pg/1.a/x", headers: JSON_HEADERS, body: "{}" })).status, 401, "and only GET");
    assert.equal((await raw(url, { path: "/api/p/alpha/_pg/1.a/../../status" })).status, 401, "a dot segment that climbs out of the prefix is resolved before routing, so it meets auth");
    const sideways = await raw(url, { path: "/api/p/alpha/_pg/1.a/../status" });
    assert.equal(sideways.json.path, "/_pg/status", "one that stays inside the prefix reaches the child as a bad capability, which the child refuses");

    assert.equal((await raw(url, { method: "POST", path: "/auth/logout", headers: { ...JSON_HEADERS, cookie }, body: "{}" })).status, 200);
    assert.equal((await raw(url, { path: "/api/projects", headers: { cookie } })).status, 401);
  } finally {
    await host?.close();
    restoreEnv();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
