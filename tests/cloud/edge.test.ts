import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import * as http from "node:http";
import { WorkspaceAccess } from "../../packages/cloud/src/index";
import { ask } from "./net-support";
import { fixture, nextChunk, open, waitFor, type HostBehaviour } from "./edge-support";
import { SECRET } from "./support";
import { HOUR, PASSWORD } from "./web-support";

const html = { accept: "text/html,application/xhtml+xml" };

// ---- getting in ----

test("a one-time code is traded for a cookie that belongs to the workspace's address alone, and the person is sent to its front page", async () => {
  const f = await fixture();
  try {
    const code = f.s.access.issueCode(f.grant);
    const r = await f.get(`/__enter?code=${encodeURIComponent(code)}`);
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, "/");
    assert.equal(r.headers["content-length"], "0");
    const set = r.headers["set-cookie"]!;
    assert.equal(set.length, 1);
    assert.match(set[0]!, /^__Host-curule_ws=v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200; Secure$/);
    const value = set[0]!.split(";")[0]!.split("=")[1]!;
    const claims = JSON.parse(Buffer.from(value.split(".")[1]!, "base64url").toString("utf8"));
    assert.deepEqual(Object.keys(claims).sort(), ["a", "e", "s", "w"]);
    assert.deepEqual([claims.a, claims.w, claims.s], [f.grant.accountId, f.grant.workspaceId, f.grant.sessionId]);
    assert.equal(claims.e, Math.floor(f.p.clock.now / 1000) + 12 * 3600);
    for (const secret of [f.ada.sessionToken, f.p.plane.workspaces.operatorToken(f.workspaceId)]) assert.ok(!set[0]!.includes(secret), "nothing in the cookie can be used anywhere else");
    assert.deepEqual([r.headers["cache-control"], r.headers["x-content-type-options"], r.headers["referrer-policy"], r.headers["strict-transport-security"]], ["no-store", "nosniff", "no-referrer", "max-age=31536000; includeSubDomains"]);
    assert.equal(f.host.requests.length, 0, "the host was not asked");
    assert.equal((await f.get("/", { headers: { cookie: set[0]!.split(";")[0]! } })).status, 200);
  } finally {
    await f.close();
  }
});

test("a code that does not open this workspace is refused, whatever is wrong with it, and one that was tried is spent", async () => {
  const f = await fixture();
  try {
    const good = f.s.access.issueCode(f.grant);
    assert.equal((await f.get(`/__enter?code=${good}`)).status, 302);
    const used = await f.get(`/__enter?code=${good}`);
    assert.deepEqual([used.status, used.json.error.code, used.json.error.message], [403, "invalid_code", "That link has expired or was already used. Open the workspace again from your account."]);
    assert.equal(used.headers["set-cookie"], undefined);

    const old = f.s.access.issueCode(f.grant);
    const other = f.s.access.issueCode({ ...f.grant, workspaceId: "ws_other" });
    const foreign = f.s.access.issueCode({ ...f.grant, accountId: "acct_other" });
    f.p.clock.advance(61_000);
    const fresh = f.s.access.issueCode(f.grant);
    const refusals: Array<[string, string]> = [
      ["one that is a minute old", old],
      ["another workspace's", other],
      ["another account's", foreign],
      ["garbage", "not-a-code"],
      ["nothing", ""],
    ];
    for (const [what, code] of refusals) {
      const r = await f.get(`/__enter?code=${encodeURIComponent(code)}`);
      assert.equal(r.body, used.body, what);
      assert.equal(r.status, 403, what);
    }
    assert.equal((await f.get("/__enter")).body, used.body, "no code at all");
    assert.equal((await f.get(`/__enter?code=nonsense&code=${fresh}`)).status, 403, "the first code given is the one tried");
    assert.equal((await f.get(`/__enter?code=${fresh}`)).status, 302, "and a refusal for another reason did not spend this one");

    const ended = f.s.access.issueCode(f.grant);
    await f.p.plane.accounts.logout(f.ada.sessionToken);
    assert.equal((await f.get(`/__enter?code=${ended}`)).status, 403, "a code for a session that has ended opens nothing");
    assert.equal(f.host.requests.length, 0);
  } finally {
    await f.close();
  }
});

test("a code is for GET and is not spent by a request that is refused for its method", async () => {
  const f = await fixture();
  try {
    const code = f.s.access.issueCode(f.grant);
    const post = await f.get(`/__enter?code=${code}`, { method: "POST" });
    assert.deepEqual([post.status, post.json.error.code, post.headers.allow], [405, "method_not_allowed", "GET"]);
    assert.equal((await f.get(`/__enter?code=${code}`)).status, 302);
  } finally {
    await f.close();
  }
});

test("a person is told in a page what went wrong, a program in JSON, and nothing the caller wrote is in either", async () => {
  const f = await fixture();
  try {
    const bad = await f.get(`/__enter?code=${encodeURIComponent("<script>alert(1)</script>")}`, { headers: html });
    assert.equal(bad.status, 403);
    assert.equal(bad.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(bad.headers["content-security-policy"], "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    assert.match(bad.body, /<title>That link did not work<\/title>/);
    assert.match(bad.body, /<a href="https:\/\/app\.example\.com\/account">Go to your account<\/a>/);
    assert.ok(!bad.body.includes("<script>") && !bad.body.includes("alert(1)"));
    const script = await f.get("/__enter?code=x", { headers: { accept: "application/json" } });
    assert.equal(script.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(script.headers["content-security-policy"], "default-src 'none'");
    assert.equal(script.headers["content-length"], String(Buffer.byteLength(script.body)));
    const api = await f.get("/api/missions", { headers: html });
    assert.deepEqual([api.status, api.headers["content-type"], api.json.error.code], [401, "application/json; charset=utf-8", "not_signed_in"], "an address a script calls is answered to a script even when the caller accepts pages");
    const page = await f.get("/", { headers: html });
    assert.deepEqual([page.status, page.headers["content-type"]], [401, "text/html; charset=utf-8"]);
    assert.match(page.body, /<title>Open this workspace from your account<\/title>/);
    const head = await f.get("/", { method: "HEAD", headers: html });
    assert.equal(head.status, 401);
    assert.equal(head.body, "");
    const unknown = await ask(f.port, { host: "nothing-000000.ws.example.com", path: "/", headers: html });
    assert.match(unknown.body, /<title>Nothing here<\/title>/);
    assert.equal(unknown.status, 404);
  } finally {
    await f.close();
  }
});

// ---- who may go on ----

test("every request needs the cookie its owner was given, signed by this service, for this workspace", async () => {
  const f = await fixture();
  try {
    const cookie = await f.cookie();
    assert.equal((await f.get("/api/status", { headers: { cookie } })).status, 200);
    assert.equal(f.host.requests.length, 1);
    const [name, value] = [cookie.split("=")[0]!, cookie.split("=")[1]!];
    const [v, payload, signature] = value.split(".");
    const forged = new WorkspaceAccess({ secret: "another-secret-of-at-least-thirty-two-characters", clock: () => new Date(f.p.clock.now) }).cookieValue(f.grant);
    const changed = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")), w: "ws_other" })).toString("base64url");
    const cookies: Array<[string, Record<string, string>]> = [
      ["none", {}],
      ["another cookie", { cookie: "x=1" }],
      ["an empty one", { cookie: `${name}=` }],
      ["one with no parts", { cookie: `${name}=v1.e30.AAAA` }],
      ["the plain name, which a script on a sibling address could have set", { cookie: `${name.replace("__Host-", "")}=${value}` }],
      ["another key's signature", { cookie: `${name}=${forged}` }],
      ["claims that were changed under a signature", { cookie: `${name}=${v}.${changed}.${signature}` }],
      ["a signature of another length", { cookie: `${name}=${v}.${payload}.${signature!.slice(0, 10)}` }],
      ["another workspace's", { cookie: `${name}=${f.s.access.cookieValue({ ...f.grant, workspaceId: "ws_other" })}` }],
    ];
    for (const [what, headers] of cookies) {
      const r = await f.get("/api/status", { headers });
      assert.deepEqual([r.status, r.json.error.code, r.json.error.message], [401, "not_signed_in", "Open this workspace from your account, signed in."], what);
    }
    assert.equal(f.host.requests.length, 1, "only the request with a cookie reached the host");
  } finally {
    await f.close();
  }
});

test("a cookie runs out after twelve hours, and signing out, a new password or a stopped account ends it at once", async () => {
  const f = await fixture();
  try {
    const status = (cookie: string) => f.get("/api/status", { headers: { cookie } }).then((r) => r.status);
    const first = await f.cookie();
    assert.equal(await status(first), 200);
    f.p.clock.advance(12 * HOUR - 1_000);
    assert.equal(await status(first), 200, "just inside the twelve hours");
    f.p.clock.advance(1_000);
    assert.equal(await status(first), 401, "and not at the twelfth");

    const login = async () => {
      const session = await f.p.plane.accounts.login("ada@example.com", PASSWORD);
      const sessionId = f.p.plane.accounts.identify(session.sessionToken)!.sessionId;
      const code = f.s.access.issueCode({ ...f.grant, sessionId });
      const set = (await f.get(`/__enter?code=${code}`)).headers["set-cookie"]![0]!.split(";")[0]!;
      return { session, cookie: set };
    };
    const a = await login();
    assert.equal(await status(a.cookie), 200);
    await f.p.plane.accounts.logout(a.session.sessionToken);
    assert.equal(await status(a.cookie), 401, "signing out ends it");

    const b = await login();
    assert.equal(await status(b.cookie), 200);
    await f.p.plane.accounts.changePassword(f.ada.accountId, PASSWORD, "a brand new password 7", b.session.sessionToken);
    assert.equal(await status(b.cookie), 401, "a new password ends every session, and what rests on them: the workspace is opened again from the account");

    const c = await f.p.plane.accounts.login("ada@example.com", "a brand new password 7");
    const code = f.s.access.issueCode({ ...f.grant, sessionId: f.p.plane.accounts.identify(c.sessionToken)!.sessionId });
    const cookie = (await f.get(`/__enter?code=${code}`)).headers["set-cookie"]![0]!.split(";")[0]!;
    assert.equal(await status(cookie), 200);
    await f.p.plane.disableAccount(f.ada.accountId, "abuse report 12");
    assert.equal(await status(cookie), 401, "a stopped account is let into nothing");
  } finally {
    await f.close();
  }
});

test("a workspace that was deleted, or whose address is not one, is a 404 whatever cookie is shown", async () => {
  const f = await fixture();
  try {
    const cookie = await f.cookie();
    assert.equal((await ask(f.port, { host: "nobody-000000.ws.example.com", path: "/", headers: { cookie } })).status, 404);
    const unreadable = await f.get("//", { headers: { cookie } });
    assert.deepEqual([unreadable.status, unreadable.json.error.code], [400, "bad_request"], "an address that cannot be read is refused as such");
    await f.p.plane.workspaces.destroy(f.workspaceId, f.ada.accountId);
    const gone = await f.get("/api/status", { headers: { cookie } });
    assert.deepEqual([gone.status, gone.json.error.code], [404, "not_found"]);
  } finally {
    await f.close();
  }
});

// ---- the swap of credentials ----

test("what the browser sent in the way of credentials never reaches the host, and what the host sent in the way of cookies never reaches the browser", async () => {
  const host: HostBehaviour = (_req, res) => {
    res.writeHead(201, { "content-type": "application/json", "set-cookie": ["mesh_session=abc; Path=/", "other=1"], "x-mesh": "yes", "keep-alive": "timeout=5", "proxy-authenticate": "Basic", "x-powered-by": "mesh" });
    res.end(JSON.stringify({ made: true }));
  };
  const f = await fixture({ behaviour: host });
  try {
    const cookie = await f.cookie();
    const r = await f.get("/api/missions?limit=5&q=%20x", {
      method: "POST",
      json: { goal: "ship it" },
      headers: {
        cookie: `${cookie}; mesh_session=stolen`,
        authorization: "Bearer attacker-token",
        "x-mesh-token": "attacker",
        "x-forwarded-for": "6.6.6.6",
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "http",
        "x-forwarded-port": "1",
        "x-real-ip": "6.6.6.6",
        forwarded: "for=6.6.6.6",
        "proxy-authorization": "Basic eDp5",
        te: "trailers",
        origin: `https://${f.name}`,
        accept: "application/json",
        "x-custom": "kept",
      },
    });
    assert.equal(r.status, 201);
    assert.deepEqual(r.json, { made: true });
    assert.equal(r.headers["set-cookie"], undefined, "the host cannot give the browser a cookie");
    assert.deepEqual([r.headers["x-mesh"], r.headers["x-powered-by"]], ["yes", "mesh"]);
    assert.deepEqual([r.headers["keep-alive"], r.headers["proxy-authenticate"]], [undefined, undefined], "headers that belong to one hop are not passed on");
    assert.deepEqual([r.headers["x-content-type-options"], r.headers["referrer-policy"], r.headers["strict-transport-security"], r.headers["x-frame-options"]], ["nosniff", "no-referrer", "max-age=31536000; includeSubDomains", "SAMEORIGIN"]);

    const [seen] = f.host.requests.slice(-1);
    assert.deepEqual([seen!.method, seen!.url], ["POST", "/api/missions?limit=5&q=%20x"]);
    assert.equal(seen!.body.toString("utf8"), '{"goal":"ship it"}');
    assert.equal(seen!.headers.authorization, `Bearer ${f.p.plane.workspaces.operatorToken(f.workspaceId)}`, "the host is shown the operator token and nothing else");
    for (const dropped of ["cookie", "x-mesh-token", "forwarded", "x-real-ip", "x-forwarded-port", "proxy-authorization", "te"]) assert.equal(seen!.headers[dropped], undefined, dropped);
    assert.deepEqual([seen!.headers["x-forwarded-for"], seen!.headers["x-forwarded-proto"], seen!.headers["x-forwarded-host"]], ["127.0.0.1", "https", f.name], "what the host is told about the caller is what the service saw, and not what the caller wrote");
    assert.deepEqual([seen!.headers.host, seen!.headers["x-custom"], seen!.headers.accept, seen!.headers["content-type"]], [f.name, "kept", "application/json", "application/json"]);
    assert.equal(seen!.headers.origin, `https://${f.name}`);
  } finally {
    await f.close();
  }
});

test("the host is told the caller's address by the proxies that were declared, and the host's own security headers are the ones that stand", async () => {
  const host: HostBehaviour = (_req, res) => {
    res.writeHead(200, { "content-type": "text/html", "referrer-policy": "origin", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'self'; frame-ancestors 'none'" });
    res.end("<p>hi</p>");
  };
  const f = await fixture({ behaviour: host, trustProxyHops: 1 });
  try {
    const cookie = await f.cookie();
    const r = await f.get("/", { headers: { cookie, "x-forwarded-for": "6.6.6.6, 198.51.100.7" } });
    assert.equal(f.host.requests.at(-1)!.headers["x-forwarded-for"], "198.51.100.7");
    assert.deepEqual([r.headers["referrer-policy"], r.headers["x-frame-options"]], ["origin", undefined], "a host that says how it may be framed is not told otherwise");
  } finally {
    await f.close();
  }
});

test("a request is passed on as it is: its method, its path as the URL reads it, its query and a body of any size, unchanged", async () => {
  const f = await fixture({
    behaviour: (req, res, seen) => {
      res.writeHead(req.url === "/missing" ? 404 : req.url === "/boom" ? 500 : 200, { "content-type": "application/octet-stream", "x-body-sha": createHash("sha256").update(seen.body).digest("hex"), "x-method": seen.method });
      res.end(req.method === "HEAD" ? undefined : seen.body);
    },
  });
  try {
    const cookie = await f.cookie();
    const sent = randomBytes(1_000_000);
    const r = await f.get("/api/upload", { method: "PUT", body: sent, headers: { cookie, "content-type": "application/octet-stream" } });
    assert.equal(r.status, 200);
    assert.equal(r.headers["x-body-sha"], createHash("sha256").update(sent).digest("hex"), "a megabyte went through unchanged");
    for (const method of ["GET", "DELETE", "PATCH", "HEAD"]) {
      const m = await f.get("/api/x", { method, headers: { cookie } });
      assert.equal(m.headers["x-method"], method);
    }
    assert.equal((await f.get("/missing", { headers: { cookie } })).status, 404, "what the host says is what the browser is told");
    assert.equal((await f.get("/boom", { headers: { cookie } })).status, 500);
    await f.get("/a/./b/../c?d=1&e=%2F", { headers: { cookie } });
    assert.equal(f.host.requests.at(-1)!.url, "/a/c?d=1&e=%2F", "the path forwarded is the one that was authorised");
    await f.get("//other.example/x", { headers: { cookie } });
    assert.equal(f.host.requests.at(-1)!.url, "/x");
  } finally {
    await f.close();
  }
});

// ---- a change must be the workspace's own ----

test("a change must name the workspace's own address as its origin when it names one, and reading is not guarded", async () => {
  const f = await fixture();
  try {
    const cookie = await f.cookie();
    const post = (origin: string | undefined, method = "POST") => f.get("/api/missions", { method, json: {}, headers: { cookie, ...(origin === undefined ? {} : { origin }) } });
    for (const origin of ["https://evil.example", "https://other-000000.ws.example.com", `http://${f.name}`, `https://${f.name}:8443`, "null", `https://${f.name}.evil.example`]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const r = await post(origin, method);
        assert.deepEqual([r.status, r.json.error.code], [403, "bad_origin"], `${method} from ${origin}`);
      }
    }
    assert.equal(f.host.requests.length, 0, "none of them was passed on");
    assert.ok(f.logs.some((l) => l.level === "warn" && l.msg === "request from another origin" && l.origin === "https://evil.example"));
    assert.equal((await post(`https://${f.name}`)).status, 200);
    assert.equal((await post(`https://${f.name.toUpperCase()}`)).status, 403, "a browser writes an origin in lower case; anything else is not one");
    assert.equal((await post(undefined)).status, 200, "a program with the cookie, which names no origin, is not a page that could be tricked");
    assert.equal((await f.get("/api/missions", { headers: { cookie, origin: "https://evil.example" } })).status, 200, "reads are for whoever holds the cookie");
  } finally {
    await f.close();
  }
});

// ---- a workspace that cannot answer ----

test("a workspace that is not running answers with a page that says so and when to come back, and the host is not asked", async () => {
  const f = await fixture();
  try {
    const cookie = await f.cookie();
    const set = (status: "suspended" | "failed" | "provisioning" | "requested" | "running", reason?: string) => f.p.log.append({ type: "workspace.status", workspaceId: f.workspaceId, status, ...(reason ? { reason } : {}) });
    const as = async (what: string, message: string) => {
      const r = await f.get("/api/status", { headers: { cookie } });
      assert.deepEqual([r.status, r.json.error.code, r.json.error.message, r.headers["retry-after"]], [503, "workspace_not_running", message, "30"], what);
    };
    await set("suspended", "paused by its owner");
    await as("stopped", "This workspace is stopped: paused by its owner.");
    await set("suspended");
    await as("stopped with no reason", "This workspace is stopped.");
    await set("failed", "the workspace could not be started");
    await as("failed", "This workspace could not start: the workspace could not be started.");
    await set("provisioning");
    await as("starting", "This workspace is still starting.");
    await set("requested");
    await as("asked for", "This workspace is still starting.");
    assert.equal(f.host.requests.length, 0);

    await set("failed", "<script>alert(1)</script> & \"quotes\"");
    const page = await f.get("/", { headers: { cookie, ...html } });
    assert.equal(page.status, 503);
    assert.match(page.body, /<title>This workspace cannot answer<\/title>/);
    assert.ok(!page.body.includes("<script>alert(1)</script>"));
    assert.ok(page.body.includes("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;"), "what the host's reason says is shown as text");
    assert.match(page.body, /href="https:\/\/app\.example\.com\/account"/);
    assert.equal(page.headers["retry-after"], "30");

    await set("running");
    Object.assign(f.workspace(), { upstream: undefined });
    const noAddress = await f.get("/api/status", { headers: { cookie } });
    assert.deepEqual([noAddress.status, noAddress.json.error.message], [503, "This workspace has no address to reach yet."], "a workspace with no address to reach is not a connection error");
    const outsider = await f.get("/api/status");
    assert.equal(outsider.status, 401, "someone with no cookie is not told what state a workspace is in");
  } finally {
    await f.close();
  }
});

test("a host that cannot be reached, or does not answer in time, is a 502 that says to try again, and the request that waited is given up", async () => {
  const f = await fixture({ edge: { upstreamTimeoutMs: 150 }, behaviour: () => new Promise<void>(() => undefined) });
  try {
    const cookie = await f.cookie();
    const slow = await f.get("/api/slow", { headers: { cookie } });
    assert.deepEqual([slow.status, slow.json.error.code, slow.json.error.message, slow.headers["retry-after"]], [502, "workspace_unreachable", "This workspace did not answer. Try again in a moment.", "5"]);
    await waitFor("the host's connection to be closed", () => f.host.abandoned.includes("/api/slow"));
    const warned = f.logs.find((l) => l.level === "warn" && l.msg === "the workspace's host did not answer");
    assert.equal(warned?.workspaceId, f.workspaceId);
    assert.match(String(warned?.error), /did not answer in time/);
    assert.ok(!slow.body.includes("in time"), "the reason is the operator's");

    await f.host.close();
    const down = await f.get("/api/down", { headers: { cookie } });
    assert.deepEqual([down.status, down.json.error.code], [502, "workspace_unreachable"]);
    assert.match(String(f.logs.filter((l) => l.msg === "the workspace's host did not answer").at(-1)?.error), /ECONNREFUSED/);
    const page = await f.get("/", { headers: { cookie, ...html } });
    assert.match(page.body, /<title>This workspace cannot answer<\/title>/);
  } finally {
    await f.close().catch(() => undefined);
  }
});

test("a host that stops in the middle of an answer ends the browser's answer as well, and does not complete it", async () => {
  const f = await fixture({
    behaviour: (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain", "content-length": "1000" });
      res.write("part of the answer");
      setTimeout(() => res.destroy(), 30);
    },
  });
  try {
    const cookie = await f.cookie();
    const { res } = await open(f.port, { host: f.name, path: "/api/cut", headers: { cookie } });
    await new Promise<void>((resolve) => {
      res.on("data", () => undefined);
      res.on("close", () => resolve());
      res.on("error", () => undefined);
    });
    assert.equal(res.complete, false, "a browser is not told that half an answer was all of it");
  } finally {
    await f.close();
  }
});

// ---- streams ----

test("an event stream reaches the browser as it is produced, and goes on for as long as it likes after the host began it", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const f = await fixture({
    edge: { upstreamTimeoutMs: 80 },
    behaviour: async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.flushHeaders();
      await gate;
      res.write("data: one\n\n");
      await new Promise((resolve) => setTimeout(resolve, 250));
      res.write("data: two\n\n");
    },
  });
  try {
    const cookie = await f.cookie();
    const { res, req } = await open(f.port, { host: f.name, path: "/events", headers: { cookie, accept: "text/event-stream" } });
    assert.equal(res.statusCode, 200, "the headers arrive before the first event does");
    assert.equal(res.headers["content-type"], "text/event-stream");
    assert.equal(res.headers["cache-control"], "no-cache, no-transform");
    assert.equal(res.headers["x-accel-buffering"], "no");
    const first = nextChunk(res);
    release();
    assert.equal(await first, "data: one\n\n", "an event is delivered when it is written, not when the stream ends");
    assert.equal(await nextChunk(res), "data: two\n\n", "and a stream that is quiet for longer than the time allowed to begin is not cut");
    req.destroy();
    await waitFor("the host to see the browser go", () => f.host.abandoned.includes("/events"));
  } finally {
    await f.close();
  }
});

test("a browser that goes away takes the request to the host with it, whether the host has answered or not", async () => {
  const f = await fixture({ behaviour: () => new Promise<void>(() => undefined) });
  try {
    const cookie = await f.cookie();
    const req = http.request({ host: "127.0.0.1", port: f.port, path: "/api/long", headers: { host: f.name, cookie }, agent: false });
    req.on("error", () => undefined);
    req.end();
    await waitFor("the host to be asked", () => f.host.requests.length === 1);
    req.destroy();
    await waitFor("the host to see the browser go", () => f.host.abandoned.includes("/api/long"));
  } finally {
    await f.close();
  }
});

test("a stream that began is looked at again: signing out, a stopped workspace or a cookie that ran out ends it, and an access that holds does not", async () => {
  const stream: HostBehaviour = (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    const timer = setInterval(() => res.write("data: tick\n\n"), 20);
    res.on("close", () => clearInterval(timer));
  };
  const f = await fixture({ edge: { recheckMs: 25 }, behaviour: stream });
  try {
    const cookie = await f.cookie();
    const closes = (res: http.IncomingMessage): Promise<void> => new Promise((resolve) => { res.on("data", () => undefined); res.on("close", () => resolve()); res.on("error", () => undefined); });

    const steady = await open(f.port, { host: f.name, path: "/events", headers: { cookie } });
    let ended = false;
    void closes(steady.res).then(() => (ended = true));
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(ended, false, "while its access holds a stream goes on, through many looks");
    steady.req.destroy();

    const session = await f.p.plane.accounts.login("ada@example.com", PASSWORD);
    const sid = f.p.plane.accounts.identify(session.sessionToken)!.sessionId;
    const code = f.s.access.issueCode({ ...f.grant, sessionId: sid });
    const own = (await f.get(`/__enter?code=${code}`)).headers["set-cookie"]![0]!.split(";")[0]!;
    const out = await open(f.port, { host: f.name, path: "/events", headers: { cookie: own } });
    const outClosed = closes(out.res);
    await f.p.plane.accounts.logout(session.sessionToken);
    await outClosed;
    assert.ok(f.logs.some((l) => l.level === "info" && l.msg === "a response was ended because the access behind it ended" && l.workspaceId === f.workspaceId));
    await waitFor("the host to see the stream end", () => f.host.abandoned.filter((u) => u === "/events").length >= 2);

    const stopped = await open(f.port, { host: f.name, path: "/events", headers: { cookie } });
    const stoppedClosed = closes(stopped.res);
    await f.p.plane.workspaces.suspend(f.workspaceId, "stopped by its owner", f.ada.accountId);
    await stoppedClosed;
    await f.p.plane.workspaces.resume(f.workspaceId, f.ada.accountId);

    const old = await open(f.port, { host: f.name, path: "/events", headers: { cookie } });
    const oldClosed = closes(old.res);
    f.p.clock.advance(12 * HOUR);
    await oldClosed;
  } finally {
    await f.close();
  }
});

// ---- uploads ----

test("an upload larger than the limit is refused before the host sees it, whether the caller said how large it is or not", async () => {
  const f = await fixture({ edge: { maxUploadBytes: 1_024 } });
  try {
    const cookie = await f.cookie();
    const said = await f.get("/api/upload", { method: "POST", body: Buffer.alloc(2_000, 1), headers: { cookie, "content-type": "application/octet-stream" } });
    assert.deepEqual([said.status, said.json.error.code, said.json.error.message], [413, "request_too_large", "That upload is too large."]);
    assert.equal(f.host.requests.length, 0);

    const unsaid = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: f.port, method: "POST", path: "/api/stream-up", headers: { host: f.name, cookie, "content-type": "application/octet-stream" }, agent: false }, (res) => {
        let text = "";
        res.on("data", (c: Buffer) => (text += c.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      });
      req.on("error", reject);
      req.write(Buffer.alloc(900, 1));
      setTimeout(() => req.end(Buffer.alloc(900, 1)), 20);
    });
    assert.equal(unsaid.status, 413, "a body with no length is counted as it comes");
    await waitFor("the host's request to be given up", () => f.host.abandoned.includes("/api/stream-up") || f.host.requests.length === 0);

    const fits = await f.get("/api/upload", { method: "POST", body: Buffer.alloc(1_000, 1), headers: { cookie, "content-type": "application/octet-stream" } });
    assert.equal(fits.status, 200);
    assert.equal(f.host.requests.at(-1)!.body.length, 1_000);
  } finally {
    await f.close();
  }
});

// ---- on one machine ----

test("on plain HTTP, for trying it on one machine, the cookie has no Secure and no HTTPS-only header is sent, and the host is told it is HTTP", async () => {
  const f = await fixture({ edge: { workspaceScheme: "http" } });
  try {
    const code = f.s.access.issueCode(f.grant);
    const entered = await f.get(`/__enter?code=${code}`);
    assert.match(entered.headers["set-cookie"]![0]!, /^curule_ws=v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=43200$/);
    assert.equal(entered.headers["strict-transport-security"], undefined);
    const cookie = entered.headers["set-cookie"]![0]!.split(";")[0]!;
    const r = await f.get("/api/x", { method: "POST", json: {}, headers: { cookie, origin: `http://${f.name}` } });
    assert.equal(r.status, 200);
    assert.equal(f.host.requests.at(-1)!.headers["x-forwarded-proto"], "http");
    assert.equal(r.headers["strict-transport-security"], undefined);
    assert.equal((await f.get("/api/x", { method: "POST", json: {}, headers: { cookie, origin: `https://${f.name}` } })).status, 403);
  } finally {
    await f.close();
  }
});
