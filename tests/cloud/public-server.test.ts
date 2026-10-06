import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { WorkspaceEdge, clientIp, createPublicServer, hostOf, type PublicServerOptions } from "../../packages/cloud/src/index";
import { rawUpload } from "../ai-gateway/support";
import { ask, listen } from "./net-support";
import { plane, running, type Plane } from "./support";
import { APP, PASSWORD, site, tokenIn } from "./web-support";

const fakeRequest = (headers: http.IncomingHttpHeaders, remoteAddress: string | null = "10.0.0.1"): http.IncomingMessage => ({ headers, socket: { remoteAddress: remoteAddress ?? undefined } }) as unknown as http.IncomingMessage;

async function serve(p: Plane, options: Partial<PublicServerOptions> = {}, web: Parameters<typeof site>[1] = {}) {
  const s = site(p, web);
  const edge = new WorkspaceEdge({ plane: p.plane, access: s.access, appUrl: APP });
  const server = createPublicServer({ web: s.web, edge, appHost: "app.example.com", workspaceDomain: "ws.example.com", ...options });
  return { ...(await listen(server)), server, s, edge };
}

/** A directory of pages, with something next to it that must never be served. */
function pagesDir(): { dir: string; remove: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curule-pages-"));
  const dir = path.join(root, "pages");
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Home</title>");
  fs.writeFileSync(path.join(dir, "login.html"), "<!doctype html><title>Sign in</title>");
  fs.writeFileSync(path.join(dir, "secret.html"), "<!doctype html><title>Not a page</title>");
  fs.writeFileSync(path.join(dir, "assets", "app.js"), "console.log('app');");
  fs.writeFileSync(path.join(dir, "assets", "app.css"), "body{margin:0}");
  fs.writeFileSync(path.join(dir, "assets", "logo.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
  fs.writeFileSync(path.join(dir, "assets", "data.bin"), Buffer.from([1, 2, 3]));
  fs.writeFileSync(path.join(dir, "assets", ".hidden"), "hidden");
  fs.writeFileSync(path.join(root, "secret.txt"), "not for the web");
  return { dir, remove: () => fs.rmSync(root, { recursive: true, force: true }) };
}

// ---- reading a connection ----

test("the host of a request is lower-case, with no port and no trailing dot", () => {
  assert.equal(hostOf(fakeRequest({ host: "App.Example.COM:8443" })), "app.example.com");
  assert.equal(hostOf(fakeRequest({ host: "app.example.com." })), "app.example.com");
  assert.equal(hostOf(fakeRequest({ host: "app.example.com.:443" })), "app.example.com");
  assert.equal(hostOf(fakeRequest({ host: "[::1]:8080" })), "[::1]");
  assert.equal(hostOf(fakeRequest({})), "");
});

test("the caller's address is the connection's, unless proxies that are trusted say otherwise, and then it is what the nearest of them saw", () => {
  assert.equal(clientIp(fakeRequest({}, "::ffff:203.0.113.9"), 0), "203.0.113.9");
  assert.equal(clientIp(fakeRequest({}, null), 0), "");
  assert.equal(clientIp(fakeRequest({ "x-forwarded-for": "6.6.6.6" }), 0), "10.0.0.1", "with no proxy trusted the header is not read");
  assert.equal(clientIp(fakeRequest({ "x-forwarded-for": "6.6.6.6, 203.0.113.5" }), 1), "203.0.113.5", "the proxy in front appended what it saw; what is to the left of that is whatever the caller wrote");
  assert.equal(clientIp(fakeRequest({ "x-forwarded-for": "6.6.6.6, 203.0.113.5, 198.51.100.2" }), 2), "203.0.113.5");
  assert.equal(clientIp(fakeRequest({ "x-forwarded-for": "198.51.100.2" }), 2), "10.0.0.1", "fewer entries than proxies is not what was promised: the connection's address is used");
  assert.equal(clientIp(fakeRequest({}), 1), "10.0.0.1");
  assert.equal(clientIp(fakeRequest({ "x-forwarded-for": ["6.6.6.6", "203.0.113.5"] }), 1), "203.0.113.5", "a header sent twice is one list");
  assert.equal(clientIp(fakeRequest({ "x-forwarded-for": " ::ffff:203.0.113.5 ,, " }), 1), "203.0.113.5");
});

// ---- which site ----

test("the host says which of two things a request is for, and an address the service was not told to serve is not answered as if it were", async () => {
  const { p, ada } = await running();
  const srv = await serve(p);
  try {
    const app = await ask(srv.port, { host: "app.example.com", path: "/healthz" });
    assert.deepEqual([app.status, app.json], [200, { ok: true }]);
    for (const host of ["APP.example.com:8443", "app.example.com."]) assert.equal((await ask(srv.port, { host, path: "/healthz" })).status, 200, host);
    assert.equal((await ask(srv.port, { host: "10.0.0.5:7423", path: "/healthz" })).status, 200, "a load balancer asks for health by address");

    const stranger = await ask(srv.port, { host: "evil.example", path: "/api/plans" });
    assert.deepEqual([stranger.status, stranger.body, stranger.headers["content-type"]], [404, "No such site.", "text/plain; charset=utf-8"]);
    for (const host of ["ws.example.com", "app.example.com.evil.example", "xws.example.com", "example.com", "evil.example:80"]) {
      assert.equal((await ask(srv.port, { host, path: "/api/plans" })).status, 404, host);
      assert.equal((await ask(srv.port, { host, path: "/healthz" })).status, 200, `${host}: only the health check is answered for every host`);
    }

    // The two sites do not answer for each other.
    const workspaceHost = p.plane.view(p.log.state.accounts.get(ada.accountId)!).workspaces[0]!.host;
    const there = await ask(srv.port, { host: workspaceHost, path: "/api/plans" });
    assert.deepEqual([there.status, there.json.error.code], [401, "not_signed_in"], "a workspace's address is the workspace's, not the control API's");
    const nobody = await ask(srv.port, { host: "nobody-000000.ws.example.com", path: "/api/plans" });
    assert.deepEqual([nobody.status, nobody.json.error.code], [404, "not_found"]);
    assert.equal((await ask(srv.port, { host: "app.example.com", path: "/api/plans" })).json.plans.length, 3);
  } finally {
    await srv.close();
  }
});

// ---- the pages ----

test("the pages are a short list, and an asset is a name with no slash in it: nothing a caller writes is joined onto the directory", async () => {
  const pages = pagesDir();
  const p = await plane();
  const srv = await serve(p, { pagesDir: pages.dir });
  const get = (pathname: string, extra: { host?: string; method?: string } = {}) => ask(srv.port, { host: extra.host ?? "app.example.com", path: pathname, ...(extra.method ? { method: extra.method } : {}) });
  try {
    const home = await get("/");
    assert.equal(home.status, 200);
    assert.equal(home.body, "<!doctype html><title>Home</title>");
    assert.equal(home.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(home.headers["content-length"], String(Buffer.byteLength(home.body)));
    assert.equal(home.headers["cache-control"], "no-store");
    assert.equal(home.headers["content-security-policy"], "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    assert.deepEqual([home.headers["x-frame-options"], home.headers["x-content-type-options"], home.headers["referrer-policy"], home.headers["cross-origin-opener-policy"]], ["DENY", "nosniff", "no-referrer", "same-origin"]);
    assert.equal((await get("/login")).body, "<!doctype html><title>Sign in</title>");
    assert.equal((await get("/login/")).status, 200, "a trailing slash is the same page");

    const js = await get("/assets/app.js");
    assert.deepEqual([js.status, js.body, js.headers["content-type"], js.headers["cache-control"], js.headers["x-content-type-options"]], [200, "console.log('app');", "text/javascript; charset=utf-8", "no-cache", "nosniff"]);
    assert.equal(js.headers["content-security-policy"], undefined, "a script is not a page: it carries no page policy");
    assert.equal((await get("/assets/app.css")).headers["content-type"], "text/css; charset=utf-8");
    assert.equal((await get("/assets/logo.svg")).headers["content-type"], "image/svg+xml");
    assert.equal((await get("/assets/data.bin")).headers["content-type"], "application/octet-stream");

    const head = await get("/", { method: "HEAD" });
    assert.deepEqual([head.status, head.body, head.headers["content-length"]], [200, "", String(home.body.length)]);

    for (const refused of [
      "/index.html",
      "/secret.html",
      "/signup", // in the list, and not on disk
      "/assets/",
      "/assets",
      "/assets/.hidden",
      "/assets/sub/app.js",
      "/assets/../secret.txt",
      "/assets/..%2fsecret.txt",
      "/assets/%2e%2e%2fsecret.txt",
      "/assets/%2e%2e/secret.txt",
      "/assets/app.js%00.html",
      "/assets/app.js/",
      "/assets/missing.js",
      "/..%2fsecret.txt",
      "/secret.txt",
    ]) {
      const r = await get(refused);
      assert.equal(r.status, 404, refused);
      assert.equal(r.json?.error?.code, "not_found", `${refused}: it is the API's 404, and not a page`);
      assert.ok(!r.body.includes("not for the web") && !r.body.includes("Not a page"), refused);
    }
    assert.equal((await get("/", { method: "POST" })).status, 404, "a page is for reading: another method goes to the API, which has nothing there");
    assert.equal((await get("/", { host: "evil.example" })).status, 404, "pages are for the app's own address");
    assert.equal((await get("/login", { host: "x-000000.ws.example.com" })).status, 404, "and not for a workspace's");
  } finally {
    await srv.close();
    pages.remove();
  }
});

test("an asset is asked about each time and not kept for minutes: it carries a fingerprint, an unchanged one is answered 304 with no body, a replaced one is sent whole, and a page has none", async () => {
  // A page is never cached, so a new page is always the new one. If its script or its stylesheet could be kept for minutes without
  // asking, then right after the service is upgraded a customer would be given the new page and the old script, whose parts would do nothing.
  const pages = pagesDir();
  const p = await plane();
  const srv = await serve(p, { pagesDir: pages.dir });
  const get = (pathname: string, headers: Record<string, string> = {}, method = "GET") => ask(srv.port, { host: "app.example.com", path: pathname, method, headers });
  try {
    const first = await get("/assets/app.js");
    const tag = String(first.headers.etag);
    assert.match(tag, /^"[A-Za-z0-9_-]{27}"$/);
    assert.equal(first.headers["cache-control"], "no-cache", "the browser may keep it, and must ask before it uses it again");
    for (const header of [tag, `W/${tag}`, `"another", ${tag}`, "*"]) {
      const same = await get("/assets/app.js", { "if-none-match": header });
      assert.deepEqual([same.status, same.body, same.headers.etag, same.headers["cache-control"], same.headers["x-content-type-options"]], [304, "", tag, "no-cache", "nosniff"], `If-None-Match: ${header}`);
    }
    assert.equal((await get("/assets/app.js", { "if-none-match": '"something else"' })).status, 200, "a fingerprint of another file is not this one");
    // The service is upgraded and the file is replaced: the same question is answered with the new file, and a new fingerprint.
    fs.writeFileSync(path.join(pages.dir, "assets", "app.js"), "console.log('the new app');");
    const after = await get("/assets/app.js", { "if-none-match": tag });
    assert.deepEqual([after.status, after.body], [200, "console.log('the new app');"], "the old fingerprint is not the new file's");
    assert.notEqual(after.headers.etag, tag);
    assert.equal((await get("/assets/app.js", { "if-none-match": String(after.headers.etag) })).status, 304);
    // The same file has the same fingerprint, and another file has another.
    assert.equal((await get("/assets/app.js")).headers.etag, after.headers.etag);
    assert.notEqual((await get("/assets/app.css")).headers.etag, after.headers.etag);
    // A page is never kept and has no fingerprint, whatever it is asked.
    const home = await get("/", { "if-none-match": "*" });
    assert.deepEqual([home.status, home.headers.etag, home.headers["cache-control"]], [200, undefined, "no-store"]);
    // A HEAD is answered as the GET would be, with the fingerprint and no body.
    const head = await get("/assets/app.css", {}, "HEAD");
    assert.deepEqual([head.status, head.body, typeof head.headers.etag], [200, "", "string"]);
  } finally {
    await srv.close();
    pages.remove();
  }
});

test("without a directory of pages only the API is served", async () => {
  const p = await plane();
  const srv = await serve(p);
  try {
    assert.equal((await ask(srv.port, { host: "app.example.com", path: "/" })).status, 404);
    assert.equal((await ask(srv.port, { host: "app.example.com", path: "/assets/app.js" })).status, 404);
    assert.equal((await ask(srv.port, { host: "app.example.com", path: "/api/plans" })).status, 200);
  } finally {
    await srv.close();
  }
});

// ---- what is read ----

test("a request that says it is too large is answered at once and its connection is closed, and one that does not say is stopped when it is", async () => {
  const p = await plane();
  const srv = await serve(p, { maxBodyBytes: 1_024, maxWebhookBytes: 4_096 });
  try {
    const head = (pathname: string): string[] => [`POST ${pathname} HTTP/1.1`, "Host: app.example.com", "Content-Type: application/json"];
    assert.deepEqual(await rawUpload(`http://127.0.0.1:${srv.port}`, head("/api/login"), '{"email":"'), { status: 413, closedByServer: true });
    assert.deepEqual(await rawUpload(`http://127.0.0.1:${srv.port}`, head("/webhooks/billing"), "{"), { status: 413, closedByServer: true }, "the provider's messages have a limit of their own, and it is a limit");

    const big = await ask(srv.port, { host: "app.example.com", method: "POST", path: "/api/login", headers: { "content-type": "application/json" }, body: `{"email":"${"x".repeat(2_000)}"}` });
    assert.deepEqual([big.status, big.json.error.code, big.headers.connection], [413, "request_too_large", "close"]);

    const chunked = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: srv.port, method: "POST", path: "/api/login", headers: { host: "app.example.com", "content-type": "application/json" }, agent: false }, (res) => {
        let text = "";
        res.on("data", (c: Buffer) => (text += c.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      });
      req.on("error", reject);
      req.write('{"email":"');
      req.write("x".repeat(2_000));
      req.end('"}');
    });
    assert.equal(chunked.status, 413, "a body with no length is counted as it arrives");

    const within = await ask(srv.port, { host: "app.example.com", method: "POST", path: "/api/login", json: { email: "ada@example.com", password: PASSWORD }, headers: { origin: APP } });
    assert.equal(within.status, 401, "what fits is read");
    const webhook = await ask(srv.port, { host: "app.example.com", method: "POST", path: "/webhooks/billing", body: "x".repeat(3_000) });
    assert.deepEqual([webhook.status, webhook.json.error.code], [400, "bad_message"], "three kilobytes is too many for a login and not for a provider's message");
  } finally {
    await srv.close();
  }
});

// ---- who is calling ----

test("a limit is by the address the connection came from, and a header that says otherwise is read only for proxies that were declared", async () => {
  const p = await plane();
  const login = (port: number, forwarded: string) => ask(port, { host: "app.example.com", method: "POST", path: "/api/login", json: { email: "ada@example.com", password: "a wrong password" }, headers: { "x-forwarded-for": forwarded } });

  const direct = await serve(p, {}, { limits: { loginIp: { max: 1, windowMs: 600_000 } } });
  try {
    assert.equal((await login(direct.port, "198.51.100.1")).status, 401);
    assert.equal((await login(direct.port, "198.51.100.2")).status, 429, "no proxy was declared, so what the caller writes about itself is not believed");
  } finally {
    await direct.close();
  }

  const proxied = await serve(p, { trustProxyHops: 1 }, { limits: { loginIp: { max: 1, windowMs: 600_000 } } });
  try {
    assert.equal((await login(proxied.port, "6.6.6.6, 198.51.100.1")).status, 401);
    assert.equal((await login(proxied.port, "7.7.7.7, 198.51.100.1")).status, 429, "the address the proxy saw is the caller's, whatever the caller put in front of it");
    assert.equal((await login(proxied.port, "198.51.100.2")).status, 401, "and another caller has its own");
  } finally {
    await proxied.close();
  }
});

// ---- when something is wrong ----

test("a request that cannot be read is a 400, and a failure in a handler is a plain 500 that does not stop the server", async () => {
  const p = await plane();
  const srv = await serve(p);
  try {
    const bad = await ask(srv.port, { host: "app.example.com", path: "//" });
    assert.deepEqual([bad.status, bad.body, bad.headers["content-type"]], [400, "That request could not be read.", "text/plain; charset=utf-8"]);
    assert.equal(bad.headers["cache-control"], "no-store");
    assert.equal(bad.headers["x-content-type-options"], "nosniff");

    const original = srv.s.web.handle.bind(srv.s.web);
    Object.assign(srv.s.web, { handle: async () => { throw new Error("EACCES: /etc/curule/secret"); } });
    const failed = await ask(srv.port, { host: "app.example.com", path: "/api/plans" });
    assert.deepEqual([failed.status, failed.body], [500, "Something went wrong on our side."]);
    assert.ok(!failed.body.includes("EACCES"));
    Object.assign(srv.s.web, { handle: original });
    assert.equal((await ask(srv.port, { host: "app.example.com", path: "/api/plans" })).status, 200, "the next request is answered");
  } finally {
    await srv.close();
  }
});

test("the server gives up on a caller that is slow to send its request, and keeps an idle connection for the length a proxy in front expects", async () => {
  const p = await plane();
  const srv = await serve(p);
  try {
    assert.deepEqual([srv.server.headersTimeout, srv.server.requestTimeout, srv.server.keepAliveTimeout], [30_000, 120_000, 65_000]);
  } finally {
    await srv.close();
  }
});

// ---- a person, through a socket ----

test("a person signs up, confirms and makes a workspace over HTTP, with the cookie as the browser keeps it and a body measured in bytes", async () => {
  const p = await plane();
  const srv = await serve(p);
  try {
    const post = (pathname: string, json: unknown, headers: Record<string, string> = {}) => ask(srv.port, { host: "app.example.com", method: "POST", path: pathname, json, headers: { origin: APP, ...headers } });
    assert.equal((await post("/api/signup", { email: "bob@example.com", password: PASSWORD })).status, 202);
    const verified = await post("/api/verify", { token: tokenIn(p.mailer.sent.at(-1)!.text) });
    assert.equal(verified.status, 200);
    const cookies = verified.headers["set-cookie"];
    assert.ok(Array.isArray(cookies) && cookies.length === 1);
    const cookie = cookies![0]!.split(";")[0]!;
    assert.match(cookie, /^__Host-curule_session=s_/);
    const me = await ask(srv.port, { host: "app.example.com", path: "/api/me", headers: { cookie } });
    assert.equal(me.json.account.email, "bob@example.com");

    const bobId = me.json.account.accountId as string;
    await p.subscribe(bobId, "team", "inv_bob");
    const made = await post("/api/workspaces", { name: "Café ☕" }, { cookie });
    assert.equal(made.status, 201);
    assert.equal(made.headers["content-length"], String(Buffer.byteLength(made.body)), "the length is of the bytes, not of the characters");
    assert.equal(made.json.workspace.name, "Café ☕");
    assert.match(made.json.workspace.slug, /^cafe-[0-9a-f]{6}$/);
    await p.plane.workspaces.idle();
    const gone = await ask(srv.port, { host: "app.example.com", method: "POST", path: "/api/logout", headers: { cookie, origin: APP } });
    assert.equal(gone.status, 200);
    assert.equal((await ask(srv.port, { host: "app.example.com", path: "/api/me", headers: { cookie } })).status, 401);
  } finally {
    await srv.close();
  }
});

// ---- the whole list of pages, what each is served as, and the limits as they ship ----

test("every page the product has is served at its own address from its own file, as what it is, with the headers a page and an asset each carry", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curule-all-pages-"));
  const dir = path.join(root, "pages");
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  const routes: Array<[string, string]> = [
    ["/", "index.html"],
    ["/signup", "signup.html"],
    ["/login", "login.html"],
    ["/verify", "verify.html"],
    ["/forgot", "forgot.html"],
    ["/reset", "reset.html"],
    ["/account", "account.html"],
    ["/terms", "terms.html"],
    ["/privacy", "privacy.html"],
  ];
  for (const [, file] of routes) fs.writeFileSync(path.join(dir, file), `<!doctype html><title>${file}</title>`);
  const assets: Array<[string, string]> = [
    ["a.js", "text/javascript; charset=utf-8"],
    ["a.css", "text/css; charset=utf-8"],
    ["a.svg", "image/svg+xml"],
    ["a.png", "image/png"],
    ["a.ico", "image/x-icon"],
    ["a.woff2", "font/woff2"],
    ["a.json", "application/json; charset=utf-8"],
    ["a.txt", "application/octet-stream"],
  ];
  for (const [name] of assets) fs.writeFileSync(path.join(dir, "assets", name), `asset ${name}`);
  const p = await plane();
  const secure = await serve(p, { pagesDir: dir });
  const plain = await serve(p, { pagesDir: dir }, { secureCookies: false });
  const get = (port: number, pathname: string, method = "GET") => ask(port, { host: "app.example.com", path: pathname, method });
  try {
    for (const [route, file] of routes) {
      for (const suffix of ["", "/"].filter((s) => route !== "/" || s === "")) {
        const r = await get(secure.port, route + suffix);
        assert.deepEqual([r.status, r.body, r.headers["content-type"]], [200, `<!doctype html><title>${file}</title>`, "text/html; charset=utf-8"], route + suffix);
      }
    }
    for (const [name, type] of assets) {
      const r = await get(secure.port, `/assets/${name}`);
      assert.deepEqual([r.status, r.body, r.headers["content-type"], r.headers["cache-control"]], [200, `asset ${name}`, type, "no-cache"], name);
      assert.equal(r.headers["content-security-policy"], undefined, `${name} is not a page`);
    }
    // A page and an asset are told apart by what they are, whichever of the two a name looks like.
    fs.writeFileSync(path.join(dir, "assets", "inner.html"), "<!doctype html><title>inner</title>");
    assert.equal((await get(secure.port, "/assets/inner.html")).headers["x-frame-options"], "DENY", "a page that is an asset is still a page");
    assert.equal((await get(secure.port, "/assets/a.js")).headers["x-frame-options"], undefined);

    const hsts = "max-age=31536000; includeSubDomains";
    for (const pathname of ["/", "/assets/a.js"]) {
      assert.equal((await get(secure.port, pathname)).headers["strict-transport-security"], hsts, `${pathname} over TLS`);
      assert.equal((await get(plain.port, pathname)).headers["strict-transport-security"], undefined, `${pathname} on plain HTTP, for trying it on one machine`);
    }
    const head = await get(secure.port, "/assets/a.js", "HEAD");
    assert.deepEqual([head.status, head.body, head.headers["content-length"]], [200, "", String("asset a.js".length)], "a HEAD has the headers of the answer and none of the body");
  } finally {
    await secure.close();
    await plain.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** A JSON body of exactly `bytes` bytes that a login reads, padded with spaces inside it. */
const loginBody = (bytes: number): string => {
  const base = JSON.stringify({ email: "ada@example.com", password: "a wrong password", pad: "" });
  return JSON.stringify({ email: "ada@example.com", password: "a wrong password", pad: " ".repeat(bytes - Buffer.byteLength(base)) });
};

test("the limit on what the API reads is 64 KiB: a body of exactly that is read, a byte more is refused, whether the length is said or not; a provider's message has 1 MiB", async () => {
  const p = await plane();
  const srv = await serve(p);
  try {
    const login = (body: string, said: boolean): Promise<{ status: number; code?: string }> =>
      new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port: srv.port, method: "POST", path: "/api/login", headers: { host: "app.example.com", "content-type": "application/json", origin: APP, ...(said ? { "content-length": String(Buffer.byteLength(body)) } : {}) }, agent: false }, (res) => {
          let text = "";
          res.on("data", (c: Buffer) => (text += c.toString("utf8")));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, ...(text.startsWith("{") ? { code: JSON.parse(text).error?.code } : {}) }));
        });
        req.on("error", reject);
        if (said) req.end(body);
        else {
          req.write(body.slice(0, 1_000));
          req.end(body.slice(1_000));
        }
      });
    const max = 64 * 1024;
    for (const said of [true, false]) {
      assert.deepEqual(await login(loginBody(max), said), { status: 401, code: "invalid_credentials" }, `exactly 64 KiB, ${said ? "with" : "without"} its length`);
      assert.deepEqual(await login(loginBody(max + 1), said), { status: 413, code: "request_too_large" }, `one byte more, ${said ? "with" : "without"} its length`);
    }
    const webhook = (bytes: number) => ask(srv.port, { host: "app.example.com", method: "POST", path: "/webhooks/billing", body: "x".repeat(bytes) });
    const exact = await webhook(1024 * 1024);
    assert.deepEqual([exact.status, exact.json.error.code], [400, "bad_message"], "exactly 1 MiB is read, and is not a message this provider sends");
    const over = await webhook(1024 * 1024 + 1);
    assert.deepEqual([over.status, over.json.error.code], [413, "request_too_large"]);
  } finally {
    await srv.close();
  }
});

test("a page that was served is not also asked of the API: it does not use up the caller's allowance for it", async () => {
  const pages = pagesDir();
  const p = await plane();
  const srv = await serve(p, { pagesDir: pages.dir }, { limits: { apiIp: { max: 2, windowMs: 3_600_000 } } });
  try {
    for (let i = 0; i < 5; i++) assert.equal((await ask(srv.port, { host: "app.example.com", path: i % 2 === 0 ? "/" : "/assets/app.js" })).status, 200);
    assert.equal((await ask(srv.port, { host: "app.example.com", path: "/api/plans" })).status, 200, "five pages and then the API's first call");
    assert.equal((await ask(srv.port, { host: "app.example.com", path: "/api/plans" })).status, 200);
    assert.equal((await ask(srv.port, { host: "app.example.com", path: "/api/plans" })).status, 429, "and its third is over the limit of two");
  } finally {
    await srv.close();
    pages.remove();
  }
});

test("when something fails after an answer has begun, the connection is ended and the caller is not left waiting for the rest", async () => {
  const p = await plane();
  const s = site(p);
  const broken = { handle: async (_req: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("the first part of an answer");
    throw new Error("the host went away");
  } } as unknown as WorkspaceEdge;
  const l = await listen(createPublicServer({ web: s.web, edge: broken, appHost: "app.example.com", workspaceDomain: "ws.example.com" }));
  try {
    const outcome = await new Promise<{ complete: boolean; body: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the caller was left waiting")), 3_000);
      const req = http.request({ host: "127.0.0.1", port: l.port, path: "/", headers: { host: "x-000000.ws.example.com" }, agent: false }, (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString("utf8")));
        res.on("close", () => (clearTimeout(timer), resolve({ complete: res.complete, body })));
        res.on("error", () => undefined);
      });
      req.on("error", () => undefined);
      req.end();
    });
    assert.deepEqual(outcome, { complete: false, body: "the first part of an answer" });
  } finally {
    await l.close();
  }
});
