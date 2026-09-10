import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CHILD_READY_PREFIX, type ProjectRef } from "../../packages/projects/src/index";
import { startHostServer, CHILD_ROUTE_PREFIXES, UNKNOWN_PROJECT_STATUS, type HostHandle } from "../../apps/mesh-server/src/host";
import { testConfigYaml } from "../helpers";

const AGENTS = { agents: [{ id: "a", role: "r", interests: [] }], mayContact: { a: [] } };

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mesh-host-"));
}

function makeProject(base: string, folder: string, id: string): ProjectRef {
  const dir = path.join(base, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "mesh.yaml"), `project:\n  id: ${id}\n${testConfigYaml(AGENTS)}`, "utf8");
  const root = fs.realpathSync(dir);
  return { id, name: id, root, configPath: path.join(root, "mesh.yaml"), addedAt: new Date().toISOString() };
}

/**
 * A stub child that is a real HTTP server on loopback.
 *
 * Booting real meshes would cost ~500ms each and put a whole kernel between the
 * assertion and the thing under test. What the host owes a child is a wire
 * contract — method, path, query, headers, body, status, and a body that
 * arrives incrementally — so the stub echoes exactly that back and the proxy is
 * tested against it for real, including streaming.
 */
function stubChildScript(base: string, name = "http-child"): string {
  const file = path.join(base, `${name}.js`);
  fs.writeFileSync(
    file,
    `
const http = require("http");
const token = process.env.MESH_API_TOKEN || "";
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const auth = req.headers.authorization || "";
  if (auth !== "Bearer " + token) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "child rejects unauthenticated callers" }));
    return;
  }
  if (url.pathname === "/stream") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write("first\\n");
    setTimeout(() => { res.write("second\\n"); res.end(); }, 400);
    return;
  }
  if (url.pathname === "/teapot") {
    res.writeHead(418, { "content-type": "application/json", "x-child-header": "kept" });
    res.end(JSON.stringify({ brewing: false }));
    return;
  }
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      method: req.method,
      path: url.pathname,
      query: url.search,
      body: Buffer.concat(chunks).toString("utf8"),
      auth,
      projectId: process.env.MESH_CHILD_PROJECT_ID,
      sawMeshTokenHeader: Boolean(req.headers["x-mesh-token"]),
    }));
  });
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

async function startHost(base: string, extra: Parameters<typeof startHostServer>[0] = {}): Promise<HostHandle> {
  return startHostServer({
    home: path.join(base, "home"),
    port: 0,
    childScript: stubChildScript(base),
    readyTimeoutMs: 10_000,
    stopGraceMs: 2_000,
    // Never let a test pick up the repo's built dashboard: the catch-all would
    // then answer routes these tests expect to 404.
    dashboardDir: path.join(base, "no-dashboard"),
    ...extra,
  });
}

async function req(
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; body: string; json: any; headers: Headers }> {
  const res = await fetch(url, init);
  const body = await res.text();
  let parsed: any = undefined;
  try {
    parsed = JSON.parse(body);
  } catch {
    /* not every response is JSON */
  }
  return { status: res.status, body, json: parsed, headers: res.headers };
}

test("registry routes list, add, open, close, restart and remove a project", { timeout: 30_000 }, async () => {
  const base = tmpRoot();
  const ref = makeProject(base, "alpha", "alpha");
  const host = await startHost(base);
  try {
    const empty = await req(`${host.url}/api/projects`);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json.projects, []);

    const added = await req(`${host.url}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: ref.root }),
    });
    assert.equal(added.status, 201);
    assert.equal(added.json.id, "alpha");
    // `add` registers a pointer, it does not boot. A folder picker that
    // silently spawned a runtime would be a surprising click.
    assert.equal(added.json.status, "closed");

    const opened = await req(`${host.url}/api/projects/alpha/open`, { method: "POST" });
    assert.equal(opened.status, 200);
    assert.equal(opened.json.status, "open", JSON.stringify(opened.json));
    assert.ok(opened.json.pid > 0);

    const listed = await req(`${host.url}/api/projects`);
    assert.equal(listed.json.projects.length, 1);
    assert.equal(listed.json.projects[0].status, "open");

    const restarted = await req(`${host.url}/api/projects/alpha/restart`, { method: "POST" });
    assert.equal(restarted.status, 200);
    assert.equal(restarted.json.status, "open");
    assert.notEqual(restarted.json.pid, opened.json.pid, "a restart must be a new process");

    const closed = await req(`${host.url}/api/projects/alpha/close`, { method: "POST" });
    assert.equal(closed.status, 200);
    assert.equal(closed.json.status, "closed");
    assert.deepEqual(host.supervisor.runningIds(), []);

    const removed = await req(`${host.url}/api/projects/alpha`, { method: "DELETE" });
    assert.equal(removed.status, 200);
    const after = await req(`${host.url}/api/projects`);
    assert.deepEqual(after.json.projects, [], "remove drops the pointer");
    // Only the pointer: the user's folder and its mesh.yaml are untouched.
    assert.ok(fs.existsSync(ref.configPath));
  } finally {
    await host.close();
  }
});

test("the proxy preserves method, path, query and body", { timeout: 30_000 }, async () => {
  const base = tmpRoot();
  const ref = makeProject(base, "echo", "echo");
  const host = await startHost(base);
  try {
    await req(`${host.url}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: ref.root }),
    });
    await req(`${host.url}/api/projects/echo/open`, { method: "POST" });

    const posted = await req(`${host.url}/api/p/echo/messages/deep/path?a=1&b=two`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    assert.equal(posted.status, 200);
    assert.equal(posted.json.method, "POST");
    // The `/api/p/:id` prefix is stripped and nothing else is: a child route
    // table that differed from the standalone one would defeat the whole
    // child-process design.
    assert.equal(posted.json.path, "/messages/deep/path");
    assert.equal(posted.json.query, "?a=1&b=two");
    assert.deepEqual(JSON.parse(posted.json.body), { hello: "world" });

    // Status codes and child headers come back untranslated.
    const teapot = await req(`${host.url}/api/p/echo/teapot`);
    assert.equal(teapot.status, 418);
    assert.equal(teapot.headers.get("x-child-header"), "kept");
  } finally {
    await host.close();
  }
});

test("the host injects the child token and never leaks it to the caller", { timeout: 30_000 }, async () => {
  const base = tmpRoot();
  const ref = makeProject(base, "guarded", "guarded");
  const host = await startHost(base);
  try {
    await req(`${host.url}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: ref.root }),
    });
    await req(`${host.url}/api/projects/guarded/open`, { method: "POST" });
    const token = host.supervisor.running("guarded")!.token;

    const echoed = await req(`${host.url}/api/p/guarded/status`, { headers: { authorization: "Bearer operator-secret" } });
    assert.equal(echoed.status, 200);
    // The caller's credential stops at the host; the child sees only its own.
    assert.equal(echoed.json.auth, `Bearer ${token}`);
    assert.equal(echoed.json.sawMeshTokenHeader, false);

    // Nothing the browser can read carries a child token — a token on the page
    // would let any script drive a child that runs agent-authored commands.
    const listed = await req(`${host.url}/api/projects`);
    assert.ok(!listed.body.includes(token), "a child token must never appear in a host response");
  } finally {
    await host.close();
  }
});

test("a proxied body streams instead of buffering", { timeout: 30_000 }, async () => {
  const base = tmpRoot();
  const ref = makeProject(base, "streamer", "streamer");
  const host = await startHost(base);
  try {
    await req(`${host.url}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: ref.root }),
    });
    await req(`${host.url}/api/projects/streamer/open`, { method: "POST" });

    const started = Date.now();
    const res = await fetch(`${host.url}/api/p/streamer/stream`);
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const first = await reader.read();
    const firstAt = Date.now() - started;
    assert.equal(new TextDecoder().decode(first.value), "first\n");
    // The child holds the second chunk for 400ms. Buffering the response would
    // make the first chunk arrive with the last one — which is the difference
    // between a live run log and a transcript delivered after the run ended.
    assert.ok(firstAt < 300, `first chunk took ${firstAt}ms — the proxy buffered the response`);

    const second = await reader.read();
    assert.equal(new TextDecoder().decode(second.value), "second\n");
    assert.equal((await reader.read()).done, true);
  } finally {
    await host.close();
  }
});

test("an unknown or closed project answers 409 with a status, never 404", { timeout: 30_000 }, async () => {
  const base = tmpRoot();
  const ref = makeProject(base, "parked", "parked");
  const host = await startHost(base);
  try {
    // Unknown: 409 too. The dashboard distinguishes "not running" from "no such
    // route" by the code, and a deep link into an unregistered project must
    // still land on an offer to open it rather than a generic not-found.
    const unknown = await req(`${host.url}/api/p/ghost/status`);
    assert.equal(unknown.status, 409);
    assert.equal(unknown.json.status, UNKNOWN_PROJECT_STATUS);
    assert.equal(unknown.json.projectId, "ghost");

    await req(`${host.url}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: ref.root }),
    });
    const closed = await req(`${host.url}/api/p/parked/status`);
    assert.equal(closed.status, 409);
    assert.equal(closed.json.status, "closed");

    await req(`${host.url}/api/projects/parked/open`, { method: "POST" });
    assert.equal((await req(`${host.url}/api/p/parked/status`)).status, 200);

    await req(`${host.url}/api/projects/parked/close`, { method: "POST" });
    const again = await req(`${host.url}/api/p/parked/status`);
    assert.equal(again.status, 409, "a closed project stops proxying again");
    assert.equal(again.json.status, "closed");
  } finally {
    await host.close();
  }
});

test("legacy bare routes follow the single open project and refuse to guess", { timeout: 40_000 }, async () => {
  const base = tmpRoot();
  const one = makeProject(base, "one", "one");
  const two = makeProject(base, "two", "two");
  const host = await startHost(base);
  try {
    for (const ref of [one, two]) {
      await req(`${host.url}/api/projects`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ root: ref.root }),
      });
    }

    // Nothing open: a script gets told what to do, not a 404.
    const none = await req(`${host.url}/status`);
    assert.equal(none.status, 409);
    assert.equal(none.json.status, "closed");

    await req(`${host.url}/api/projects/one/open`, { method: "POST" });
    const single = await req(`${host.url}/status`);
    assert.equal(single.status, 200, "one open project makes a bare route unambiguous");
    assert.equal(single.json.path, "/status");
    assert.equal(single.json.projectId, "one");

    await req(`${host.url}/api/projects/two/open`, { method: "POST" });
    const ambiguous = await req(`${host.url}/status`);
    // Guessing which mission a script meant to drive is worse than refusing.
    assert.equal(ambiguous.status, 409);
    assert.equal(ambiguous.json.status, "ambiguous");
    assert.deepEqual(ambiguous.json.open.sort(), ["one", "two"]);

    // The host answers its own /health even with children open: a liveness
    // probe against the host must report the host.
    const health = await req(`${host.url}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.json.role, "host");
    assert.deepEqual(health.json.open.sort(), ["one", "two"]);
    assert.ok(!CHILD_ROUTE_PREFIXES.has("health"), "/health must not fall through to a child");
    assert.ok(!CHILD_ROUTE_PREFIXES.has("dashboard"), "the SPA is served by the host, never by a child");
  } finally {
    await host.close();
  }
});

test("the host enforces its own operator token before proxying anywhere", { timeout: 30_000 }, async () => {
  const base = tmpRoot();
  const ref = makeProject(base, "sealed", "sealed");
  const before = process.env.MESH_API_TOKEN;
  const host = await startHost(base);
  try {
    await req(`${host.url}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ root: ref.root }),
    });
    await req(`${host.url}/api/projects/sealed/open`, { method: "POST" });

    process.env.MESH_API_TOKEN = "operator-token";
    const anon = await req(`${host.url}/api/projects`);
    assert.equal(anon.status, 401);
    // The proxy is behind the same gate: an unauthenticated caller must not be
    // able to reach a child through the host either.
    const proxied = await req(`${host.url}/api/p/sealed/status`);
    assert.equal(proxied.status, 401);

    const ok = await req(`${host.url}/api/p/sealed/status`, { headers: { authorization: "Bearer operator-token" } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.auth, `Bearer ${host.supervisor.running("sealed")!.token}`);
  } finally {
    if (before === undefined) delete process.env.MESH_API_TOKEN;
    else process.env.MESH_API_TOKEN = before;
    await host.close();
  }
});

test("host shutdown leaves no child processes behind", { timeout: 30_000 }, async () => {
  const base = tmpRoot();
  const ref = makeProject(base, "orphanless", "orphanless");
  const host = await startHost(base);
  await req(`${host.url}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ root: ref.root }),
  });
  await req(`${host.url}/api/projects/orphanless/open`, { method: "POST" });
  const pid = host.supervisor.running("orphanless")!.pid;

  await host.close();
  // Idempotent: a SIGTERM arriving during teardown must not start a second one.
  await host.close();

  assert.deepEqual(host.supervisor.runningIds(), []);
  assert.throws(() => process.kill(pid, 0), "the child must not outlive the host that spawned it");
});
