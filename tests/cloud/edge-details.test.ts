import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { escapeHtml } from "../../packages/cloud/src/index";
import { ask } from "./net-support";
import { fixture, waitFor, type HostBehaviour } from "./edge-support";

const html = { accept: "text/html,application/xhtml+xml" };
const json = { accept: "application/json" };

/** A request with a body written by hand, so that what it says about its length, and when it ends, is the test's. */
function upload(port: number, host: string, cookie: string, o: { path: string; contentLength?: number; chunks: number[]; endAfterMs?: number }) {
  const req = http.request({ host: "127.0.0.1", port, method: "POST", path: o.path, headers: { host, cookie, "content-type": "application/octet-stream", ...(o.contentLength !== undefined ? { "content-length": String(o.contentLength) } : {}) }, agent: false });
  const answered = new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string } | undefined>((resolve) => {
    req.on("response", (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString("utf8")));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      res.on("error", () => resolve(undefined));
    });
    req.on("error", () => resolve(undefined));
  });
  for (const n of o.chunks) req.write(Buffer.alloc(n, 1));
  if (o.endAfterMs !== undefined) setTimeout(() => req.end(), o.endAfterMs);
  return { req, answered };
}

test("the five characters that can end an attribute or begin a tag are written as text, and nothing else is changed", () => {
  assert.equal(escapeHtml(`<a href="x" onclick='y'>&</a>`), "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  assert.equal(escapeHtml("plain text 123 é — /?#"), "plain text 123 é — /?#");
  assert.equal(escapeHtml("&amp;"), "&amp;amp;", "what is already escaped is escaped again: it is text now");
  assert.equal(escapeHtml(""), "");
});

test("a person is shown a title for each refusal that can be a page, and a program is given the words, with the code and the status", async () => {
  const f = await fixture({ edge: { maxUploadBytes: 100, upstreamTimeoutMs: 200 } });
  try {
    const cookie = await f.cookie();
    const cases: Array<{ what: string; ask: (accept: Record<string, string>) => ReturnType<typeof ask>; status: number; code: string; message: string; title: string }> = [
      { what: "an address with no workspace", ask: (h) => ask(f.port, { host: "nothing-000000.ws.example.com", path: "/", headers: h }), status: 404, code: "not_found", message: "There is no workspace at this address.", title: "Nothing here" },
      { what: "a request that cannot be read", ask: (h) => f.get("//", { headers: h }), status: 400, code: "bad_request", message: "That request could not be read.", title: "This request cannot be answered" },
      { what: "no cookie", ask: (h) => f.get("/", { headers: h }), status: 401, code: "not_signed_in", message: "Open this workspace from your account, signed in.", title: "Open this workspace from your account" },
      { what: "a code that opens nothing", ask: (h) => f.get("/__enter?code=nope", { headers: h }), status: 403, code: "invalid_code", message: "That link has expired or was already used. Open the workspace again from your account.", title: "That link did not work" },
      { what: "a body that says it is too large", ask: (h) => f.get("/", { headers: { cookie, "content-length": "101", ...h } }), status: 413, code: "request_too_large", message: "That upload is too large.", title: "That upload is too large" },
    ];
    for (const c of cases) {
      const page = await c.ask(html);
      assert.equal(page.status, c.status, c.what);
      assert.match(page.body, new RegExp(`<title>${c.title}</title>`), c.what);
      assert.match(page.body, new RegExp(`<h1>${c.title}</h1>`), c.what);
      assert.ok(page.body.includes(`<p>${escapeHtml(c.message)}</p>`), `${c.what}: the page says it`);
      const script = await c.ask(json);
      assert.deepEqual([script.status, script.json.error.code, script.json.error.message], [c.status, c.code, c.message], c.what);
    }
    // A refusal of a change, or of a method that is not GET, is for a program: it is never a page.
    const origin = await f.get("/api/missions", { method: "POST", json: {}, headers: { cookie, origin: "https://evil.example", ...html } });
    assert.deepEqual([origin.status, origin.json.error.code, origin.json.error.message], [403, "bad_origin", "This request did not come from this workspace's own page."]);
    const method = await f.get("/__enter?code=x", { method: "POST", headers: html });
    assert.deepEqual([method.status, method.json.error.code, method.json.error.message, method.headers.allow], [405, "method_not_allowed", "Use GET.", "GET"]);
    // A host that cannot be reached.
    f.host.behave(() => new Promise<void>(() => undefined));
    const slow = await f.get("/", { headers: { cookie, ...html } });
    assert.equal(slow.status, 502);
    assert.match(slow.body, /<title>This workspace cannot answer<\/title>/);
    assert.ok(slow.body.includes("<p>This workspace did not answer. Try again in a moment.</p>"));
  } finally {
    await f.close();
  }
});

test("a read that names another origin is not refused, and neither is a HEAD", async () => {
  const f = await fixture();
  try {
    const cookie = await f.cookie();
    for (const method of ["GET", "HEAD"]) {
      const r = await f.get("/api/missions", { method, headers: { cookie, origin: "https://evil.example" } });
      assert.equal(r.status, 200, method);
    }
    assert.equal(f.host.requests.length, 2);
  } finally {
    await f.close();
  }
});

test("a code that does not open the workspace is logged, with the workspace and without the code", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.get("/__enter?code=nope-nope-nope")).status, 403);
    const logged = f.logs.filter((l) => l.msg === "a code that does not open this workspace");
    assert.equal(logged.length, 1);
    assert.deepEqual([logged[0]!.level, logged[0]!.workspaceId], ["info", f.workspaceId]);
    assert.ok(!JSON.stringify(f.logs).includes("nope-nope-nope"));
  } finally {
    await f.close();
  }
});

test("headers that belong to one connection are not passed on in either direction, and a request's own Expect is not", async () => {
  const host: HostBehaviour = (_req, res) => {
    res.writeHead(200, { "content-type": "text/plain", trailer: "x-checksum", "proxy-connection": "keep-alive", upgrade: "h2c", "x-kept": "yes" });
    res.end("ok");
  };
  const f = await fixture({ behaviour: host });
  try {
    const cookie = await f.cookie();
    const r = await f.get("/api/hop", { headers: { cookie, "proxy-connection": "keep-alive", upgrade: "h2c", expect: "100-continue", "x-custom": "kept" } });
    assert.equal(r.status, 200);
    assert.equal(r.headers["x-kept"], "yes");
    for (const name of ["trailer", "proxy-connection", "upgrade"]) assert.equal(r.headers[name], undefined, `${name} from the host`);
    assert.equal(r.headers.connection, "close", "the connection the browser has is the browser's own, not the one the host kept alive");
    const seen = f.host.requests.at(-1)!;
    for (const name of ["proxy-connection", "upgrade", "expect"]) assert.equal(seen.headers[name], undefined, `${name} from the browser`);
    assert.equal(seen.headers["x-custom"], "kept");
  } finally {
    await f.close();
  }
});

test("a host's own security headers are kept as it wrote them, and the ones it did not write are added", async () => {
  const own: HostBehaviour = (_req, res) => {
    res.writeHead(200, { "content-type": "text/plain", "x-content-type-options": "x-own", "referrer-policy": "origin-when-cross-origin", "x-frame-options": "DENY", "strict-transport-security": "max-age=1" });
    res.end("ok");
  };
  const f = await fixture({ behaviour: own });
  try {
    const cookie = await f.cookie();
    const r = await f.get("/api/own", { headers: { cookie } });
    assert.deepEqual(
      [r.headers["x-content-type-options"], r.headers["referrer-policy"], r.headers["x-frame-options"], r.headers["strict-transport-security"]],
      ["x-own", "origin-when-cross-origin", "DENY", "max-age=1"],
    );
    f.host.behave((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    const bare = await f.get("/api/bare", { headers: { cookie } });
    assert.deepEqual(
      [bare.headers["x-content-type-options"], bare.headers["referrer-policy"], bare.headers["x-frame-options"], bare.headers["strict-transport-security"]],
      ["nosniff", "no-referrer", "SAMEORIGIN", "max-age=31536000; includeSubDomains"],
    );
    f.host.behave((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain", "content-security-policy": "frame-ancestors https://app.example.com" });
      res.end("ok");
    });
    const framed = await f.get("/api/framed", { headers: { cookie } });
    assert.equal(framed.headers["x-frame-options"], undefined, "a host that says who may frame it is not given a second answer");
  } finally {
    await f.close();
  }
});

test("a request that says it is larger than 64 MiB is refused, and one that says exactly 64 MiB is passed on", async () => {
  const f = await fixture();
  try {
    const cookie = await f.cookie();
    const max = 64 * 1024 * 1024;
    const over = upload(f.port, f.name, cookie, { path: "/api/over", contentLength: max + 1, chunks: [10] });
    const refused = await over.answered;
    assert.equal(refused?.status, 413);
    assert.equal(JSON.parse(refused!.body).error.message, "That upload is too large.");
    assert.equal(f.host.abandoned.includes("/api/over"), false, "the host was never asked");
    over.req.destroy();

    const exact = upload(f.port, f.name, cookie, { path: "/api/exact", contentLength: max, chunks: [10] });
    let early: unknown;
    void exact.answered.then((r) => (early = r));
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(early, undefined, "nothing was said back: the host is waiting for the rest of the body");
    exact.req.destroy();
    await waitFor("the host to be asked, and then to be let go", () => f.host.abandoned.includes("/api/exact"));
  } finally {
    await f.close();
  }
});

test("a body with no length is counted as it comes: the limit itself is allowed, one byte more is not, and the host's request is given up", async () => {
  const f = await fixture({ edge: { maxUploadBytes: 1_000 } });
  try {
    const cookie = await f.cookie();
    const fits = upload(f.port, f.name, cookie, { path: "/api/fits", chunks: [400, 600], endAfterMs: 30 });
    const ok = await fits.answered;
    assert.equal(ok?.status, 200);
    assert.equal(f.host.requests.at(-1)!.body.length, 1_000);

    const over = upload(f.port, f.name, cookie, { path: "/api/over", chunks: [500, 501], endAfterMs: 30 });
    const refused = await over.answered;
    assert.equal(refused?.status, 413);
    assert.deepEqual(JSON.parse(refused!.body).error, { code: "request_too_large", message: "That upload is too large." });
    assert.equal(refused!.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(refused!.headers.connection, "close");
    await waitFor("the host's request to be given up", () => f.host.abandoned.includes("/api/over"));
    assert.equal(f.host.requests.filter((r) => r.url === "/api/over").length, 0, "the host never had the whole of it");
  } finally {
    await f.close();
  }
});

test("a stream that ended is not looked at again", async () => {
  const f = await fixture({
    edge: { recheckMs: 15 },
    behaviour: (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: one\n\n");
      setTimeout(() => res.end(), 80);
    },
  });
  try {
    const cookie = await f.cookie();
    let reads = 0;
    const read = f.s.access.read.bind(f.s.access);
    f.s.access.read = (value: string | undefined) => {
      reads += 1;
      return read(value);
    };
    const r = await f.get("/events", { headers: { cookie } });
    assert.equal(r.status, 200);
    assert.ok(reads >= 2, "while it lasted it was looked at");
    await new Promise((resolve) => setTimeout(resolve, 60));
    const after = reads;
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(reads, after, "after it ended, nothing is looking");
  } finally {
    await f.close();
  }
});
