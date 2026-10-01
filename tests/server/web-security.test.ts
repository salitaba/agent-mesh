/**
 * The pure half of the network/browser guard: what start-up refuses, which
 * requests the guard turns away, and what a body reader will accept.
 *
 * The wiring (that `startServer` calls these, that `route` answers with the
 * verdict) is exercised against real sockets in `web-surface.test.ts`; these
 * cases pin the decisions themselves, including the spellings of "this machine"
 * that are easiest to get wrong.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import type * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "node:crypto";
import {
  DASHBOARD_CSP,
  FailureLimiter,
  MIN_NETWORK_TOKEN_LENGTH,
  PREVIEW_CSP,
  PayloadTooLargeError,
  UnsafeListenError,
  assertSafeListen,
  checkHost,
  checkOrigin,
  clientKey,
  dashboardCsp,
  guardRequest,
  hostnameOf,
  inlineScriptHashes,
  isLoopbackHost,
  maxBodyBytes,
  readBody,
  selfConnectHost,
  webPolicyFromEnv,
} from "../../apps/mesh-server/src/web-security";

const STRONG = "a".repeat(MIN_NETWORK_TOKEN_LENGTH);

test("loopback is recognised in every spelling, and nothing else is", () => {
  for (const h of ["127.0.0.1", "127.8.9.10", "localhost", "LOCALHOST", "api.localhost", "::1", "[::1]", "0:0:0:0:0:0:0:1", "0000:0000:0000:0000:0000:0000:0000:0001", "::ffff:127.0.0.1", "[::ffff:127.0.0.1]"]) {
    assert.equal(isLoopbackHost(h), true, `${h} is this machine`);
  }
  // The wildcard and unset hosts are the NETWORK: node reads both as all interfaces.
  for (const h of ["0.0.0.0", "::", "[::]", "", "  ", undefined, null, "10.0.0.5", "192.168.1.10", "mesh.internal", "127.0.0.1.evil.example", "localhost.evil.example", "::ffff:10.0.0.1", "not an address", "128.0.0.1"]) {
    assert.equal(isLoopbackHost(h as string | undefined), false, `${JSON.stringify(h)} is not loopback`);
  }
});

test("a wildcard bind is reached through loopback, and an IPv6 literal gets its brackets", () => {
  assert.equal(selfConnectHost("0.0.0.0"), "127.0.0.1");
  assert.equal(selfConnectHost(""), "127.0.0.1");
  assert.equal(selfConnectHost(undefined), "127.0.0.1");
  assert.equal(selfConnectHost("::"), "[::1]");
  assert.equal(selfConnectHost("::1"), "[::1]");
  assert.equal(selfConnectHost("10.1.2.3"), "10.1.2.3");
  assert.equal(selfConnectHost("mesh.internal"), "mesh.internal");
});

test("start-up: a loopback bind never needs a token", () => {
  for (const env of [{}, { MESH_API_TOKEN: "" }, { MESH_API_TOKEN: "   " }, { MESH_API_TOKEN: "short" }]) {
    assert.deepEqual(assertSafeListen("127.0.0.1", env), { warnings: [] });
    assert.deepEqual(assertSafeListen("localhost", env), { warnings: [] });
  }
});

test("start-up: a network bind is refused with no token, a blank token or a short one, and each says which", () => {
  const cases: Array<[NodeJS.ProcessEnv, RegExp]> = [
    [{}, /MESH_API_TOKEN is not set/],
    [{ MESH_API_TOKEN: "" }, /set but empty/],
    [{ MESH_API_TOKEN: "   \t" }, /set but empty/],
    [{ MESH_API_TOKEN: "x".repeat(MIN_NETWORK_TOKEN_LENGTH - 1) }, new RegExp(`${MIN_NETWORK_TOKEN_LENGTH - 1} characters`)],
  ];
  for (const host of ["0.0.0.0", "::", "10.0.0.5", "mesh.internal", undefined]) {
    for (const [env, why] of cases) {
      assert.throws(() => assertSafeListen(host, env), (err: unknown) => err instanceof UnsafeListenError && why.test((err as Error).message), `${host} with ${JSON.stringify(env)}`);
    }
  }
});

test("start-up: a network bind with a token of the minimum length passes, and the token is measured after trimming", () => {
  assert.deepEqual(assertSafeListen("0.0.0.0", { MESH_API_TOKEN: STRONG }), { warnings: [] });
  assert.deepEqual(assertSafeListen("0.0.0.0", { MESH_API_TOKEN: `  ${STRONG}\n` }), { warnings: [] });
  assert.throws(() => assertSafeListen("0.0.0.0", { MESH_API_TOKEN: `${" ".repeat(40)}short` }), UnsafeListenError);
});

test("start-up: the refusal tells the operator what to do instead", () => {
  try {
    assertSafeListen("0.0.0.0", {});
    assert.fail("should have refused");
  } catch (err) {
    const message = (err as Error).message;
    assert.match(message, /openssl rand -hex 32/);
    assert.match(message, /127\.0\.0\.1/);
    assert.match(message, /MESH_ALLOW_INSECURE_BIND=1/);
  }
});

test("start-up: MESH_ALLOW_INSECURE_BIND=1 starts anyway, loudly, and only for the exact value 1", () => {
  const r = assertSafeListen("0.0.0.0", { MESH_ALLOW_INSECURE_BIND: "1" });
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!, /MESH_ALLOW_INSECURE_BIND=1/);
  assert.match(r.warnings[0]!, /not set/);
  for (const v of ["true", "yes", "0", "2", ""]) {
    assert.throws(() => assertSafeListen("0.0.0.0", { MESH_ALLOW_INSECURE_BIND: v }), UnsafeListenError, `'${v}' is not the opt-in`);
  }
  // A strong token needs no opt-in and draws no warning.
  assert.deepEqual(assertSafeListen("0.0.0.0", { MESH_ALLOW_INSECURE_BIND: "1", MESH_API_TOKEN: STRONG }), { warnings: [] });
});

// ------------------------------------------------------------ the guard

interface FakeReq {
  method?: string;
  headers?: Record<string, string>;
  /** The local address the connection arrived on. */
  local?: string;
}

function req(r: FakeReq = {}): http.IncomingMessage {
  return {
    method: r.method ?? "GET",
    headers: Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
    socket: { localAddress: r.local ?? "127.0.0.1" },
  } as unknown as http.IncomingMessage;
}

const NONE = webPolicyFromEnv({});

test("hostnameOf strips the port and the brackets", () => {
  assert.equal(hostnameOf("localhost:7420"), "localhost");
  assert.equal(hostnameOf("LocalHost"), "localhost");
  assert.equal(hostnameOf("[::1]:7420"), "::1");
  assert.equal(hostnameOf("[::1]"), "::1");
  assert.equal(hostnameOf("mesh.example.com:443"), "mesh.example.com");
  assert.equal(hostnameOf("127.0.0.1"), "127.0.0.1");
});

test("host: on a loopback connection only loopback names are answered, which is what stops DNS rebinding", () => {
  for (const host of ["localhost:7420", "127.0.0.1:7420", "[::1]:7420", "localhost"]) {
    assert.equal(checkHost(req({ headers: { host } }), NONE).ok, true, host);
  }
  // A rebound attacker domain resolves to 127.0.0.1 but still names itself.
  const rebound = checkHost(req({ headers: { host: "evil.example:7420" } }), NONE);
  assert.equal(rebound.ok, false);
  if (!rebound.ok) {
    assert.equal(rebound.status, 421);
    assert.match(rebound.error, /MESH_ALLOWED_HOSTS/);
  }
  assert.equal(checkHost(req({ headers: { host: "127.0.0.1.evil.example" } }), NONE).ok, false);
});

test("host: on a network connection any name is answered unless MESH_ALLOWED_HOSTS narrows it", () => {
  const net = { local: "10.1.2.3" };
  assert.equal(checkHost(req({ ...net, headers: { host: "10.1.2.3:7420" } }), NONE).ok, true, "a kubelet probe addresses the pod by IP");
  assert.equal(checkHost(req({ ...net, headers: { host: "mesh.corp.example" } }), NONE).ok, true);
  const narrowed = webPolicyFromEnv({ MESH_ALLOWED_HOSTS: "mesh.corp.example, Other.Example:8443" });
  assert.equal(checkHost(req({ ...net, headers: { host: "mesh.corp.example" } }), narrowed).ok, true);
  assert.equal(checkHost(req({ ...net, headers: { host: "mesh.corp.example:7420" } }), narrowed).ok, true, "the port is not part of the name");
  assert.equal(checkHost(req({ ...net, headers: { host: "other.example:8443" } }), narrowed).ok, true, "an entry with a port matches the full header");
  assert.equal(checkHost(req({ ...net, headers: { host: "evil.example" } }), narrowed).ok, false);
});

test("host: an explicit list does not lock out localhost, so port-forward keeps working", () => {
  const narrowed = webPolicyFromEnv({ MESH_ALLOWED_HOSTS: "mesh.corp.example" });
  assert.equal(checkHost(req({ headers: { host: "localhost:7420" } }), narrowed).ok, true);
  assert.equal(checkHost(req({ headers: { host: "evil.example" } }), narrowed).ok, false);
});

test("host: a request with no Host header is not a browser's and passes", () => {
  assert.equal(checkHost(req({}), NONE).ok, true);
});

test("origin: reads never need one, and a request with neither Origin nor Sec-Fetch-Site is not a browser page", () => {
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    assert.equal(checkOrigin(req({ method, headers: { host: "localhost:7420", origin: "https://evil.example" } }), NONE).ok, true, method);
  }
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    assert.equal(checkOrigin(req({ method, headers: { host: "localhost:7420" } }), NONE).ok, true, `${method} from curl or the CLI`);
  }
});

test("origin: a state-changing request from another origin is refused, text/plain or not", () => {
  const forged = checkOrigin(req({ method: "POST", headers: { host: "localhost:7420", origin: "https://evil.example", "content-type": "text/plain" } }), NONE);
  assert.equal(forged.ok, false);
  if (!forged.ok) {
    assert.equal(forged.status, 403);
    assert.equal(forged.code, "cross_origin");
  }
  // Another PORT on the same machine is another origin: any local page can send this.
  assert.equal(checkOrigin(req({ method: "POST", headers: { host: "localhost:7420", origin: "http://localhost:3000" } }), NONE).ok, false);
  assert.equal(checkOrigin(req({ method: "POST", headers: { host: "localhost:7420", origin: "null" } }), NONE).ok, false, "a sandboxed or redirected page sends the literal null");
  assert.equal(checkOrigin(req({ method: "POST", headers: { host: "localhost:7420", origin: "not a url" } }), NONE).ok, false);
});

test("origin: the page's own origin passes, whatever the scheme a TLS-terminating proxy hid", () => {
  assert.equal(checkOrigin(req({ method: "POST", headers: { host: "localhost:7420", origin: "http://localhost:7420" } }), NONE).ok, true);
  assert.equal(checkOrigin(req({ method: "POST", headers: { host: "mesh.corp.example", origin: "https://mesh.corp.example" } }), NONE).ok, true);
  assert.equal(checkOrigin(req({ method: "DELETE", headers: { host: "Mesh.Corp.Example", origin: "https://MESH.corp.example" } }), NONE).ok, true);
});

test("origin: Sec-Fetch-Site backs up a browser that sent no Origin", () => {
  const post = (site: string) => checkOrigin(req({ method: "POST", headers: { host: "localhost:7420", "sec-fetch-site": site } }), NONE).ok;
  assert.equal(post("same-origin"), true);
  assert.equal(post("none"), true);
  assert.equal(post("cross-site"), false);
  assert.equal(post("same-site"), false);
});

test("origin: MESH_ALLOWED_ORIGINS admits a named origin, and only that one", () => {
  const policy = webPolicyFromEnv({ MESH_ALLOWED_ORIGINS: "https://console.corp.example/, http://localhost:5173" });
  const post = (origin: string, site?: string) =>
    checkOrigin(req({ method: "POST", headers: { host: "mesh.internal:7420", origin, ...(site ? { "sec-fetch-site": site } : {}) } }), policy).ok;
  assert.equal(post("https://console.corp.example"), true, "trailing slash in the list is forgiven");
  assert.equal(post("http://localhost:5173", "same-site"), true);
  assert.equal(post("https://evil.example"), false);
  assert.equal(post("https://console.corp.example.evil.example"), false);
});

test("guardRequest checks the host before the origin", () => {
  const both = guardRequest(req({ method: "POST", headers: { host: "evil.example", origin: "https://evil.example" } }), NONE);
  assert.equal(both.ok, false);
  if (!both.ok) assert.equal(both.code, "host_not_allowed", "a rebound page is told about its host, not its origin");
  assert.equal(guardRequest(req({ method: "POST", headers: { host: "localhost:7420", origin: "http://localhost:7420" } }), NONE).ok, true);
});

// -------------------------------------------------------------- policies

test("the dashboard policy allows nothing from elsewhere and the preview policy sandboxes without same-origin", () => {
  assert.match(DASHBOARD_CSP, /default-src 'self'/);
  assert.match(DASHBOARD_CSP, /frame-ancestors 'none'/);
  assert.match(DASHBOARD_CSP, /object-src 'none'/);
  assert.doesNotMatch(DASHBOARD_CSP, /script-src[^;]*unsafe-inline/, "scripts are same-origin files");
  assert.doesNotMatch(DASHBOARD_CSP, /\*/, "no wildcard source");
  assert.match(PREVIEW_CSP, /^sandbox /);
  assert.doesNotMatch(PREVIEW_CSP, /allow-same-origin/, "that token would hand the page this origin back");
  assert.match(PREVIEW_CSP, /allow-scripts/);
});

// ------------------------------------------------------------- the body

function bodyOf(chunks: string[], headers: Record<string, string> = {}): http.IncomingMessage {
  const stream = new PassThrough() as unknown as http.IncomingMessage;
  (stream as unknown as { headers: Record<string, string> }).headers = headers;
  (stream as unknown as { complete: boolean }).complete = false;
  setImmediate(() => {
    for (const c of chunks) (stream as unknown as PassThrough).write(c);
    (stream as unknown as { complete: boolean }).complete = true;
    (stream as unknown as PassThrough).end();
  });
  return stream;
}

test("a body under the limit is returned whole, and an empty one is empty", async () => {
  assert.equal((await readBody(bodyOf(['{"a":', "1}"]), 100)).toString(), '{"a":1}');
  assert.equal((await readBody(bodyOf([]), 100)).length, 0);
});

test("a body over the limit is refused as it streams, whatever the client declared", async () => {
  await assert.rejects(readBody(bodyOf(["x".repeat(60), "x".repeat(60)]), 100), PayloadTooLargeError);
  // Declared small, sent large: the running total catches the lie.
  await assert.rejects(readBody(bodyOf(["x".repeat(500)], { "content-length": "10" }), 100), PayloadTooLargeError);
  // Exactly the limit is allowed.
  assert.equal((await readBody(bodyOf(["x".repeat(100)]), 100)).length, 100);
});

test("a declared length over the limit is refused before a byte is read", async () => {
  const r = bodyOf(["x"], { "content-length": "1000000" });
  let sawData = false;
  r.on("data", () => {
    sawData = true;
  });
  await assert.rejects(readBody(r, 100), (err: unknown) => err instanceof PayloadTooLargeError && err.status === 413 && err.limit === 100);
  assert.equal(sawData, false);
});

test("a client that hangs up mid-body rejects instead of hanging", async () => {
  const stream = new PassThrough() as unknown as http.IncomingMessage;
  (stream as unknown as { headers: Record<string, string> }).headers = {};
  (stream as unknown as { complete: boolean }).complete = false;
  const pending = readBody(stream, 100);
  setImmediate(() => (stream as unknown as PassThrough).destroy());
  await assert.rejects(pending, /closed before its body was complete|premature|aborted/i);
});

test("MESH_MAX_BODY_BYTES overrides the default and a bad value is ignored", () => {
  assert.equal(maxBodyBytes({ MESH_MAX_BODY_BYTES: "2048" }), 2048);
  for (const v of ["0", "-5", "lots", "1.5", ""]) assert.equal(maxBodyBytes({ MESH_MAX_BODY_BYTES: v }), 1024 * 1024, `'${v}'`);
  assert.equal(maxBodyBytes({}), 1024 * 1024);
});

// -------------------------------------------------- failed-credential limiter

test("the limiter lets a caller fail up to the limit, then asks it to wait, then forgives it when the window passes", () => {
  let t = 1_000_000;
  const limiter = new FailureLimiter({ max: 3, windowMs: 60_000, now: () => t });
  assert.equal(limiter.blockedFor("a"), 0);
  limiter.fail("a");
  limiter.fail("a");
  assert.equal(limiter.blockedFor("a"), 0, "two failures of three allowed");
  t += 10_000;
  limiter.fail("a");
  assert.equal(limiter.blockedFor("a"), 50, "the wait is until the OLDEST failure leaves the window");
  t += 49_000;
  assert.equal(limiter.blockedFor("a"), 1);
  t += 1_001;
  assert.equal(limiter.blockedFor("a"), 0, "the first failure aged out, so two are left");
});

test("the limiter counts each address on its own, and a success clears the count", () => {
  const limiter = new FailureLimiter({ max: 2, now: () => 5_000 });
  limiter.fail("a");
  limiter.fail("a");
  assert.ok(limiter.blockedFor("a") > 0);
  assert.equal(limiter.blockedFor("b"), 0, "another address is unaffected");
  limiter.reset("a");
  assert.equal(limiter.blockedFor("a"), 0);
});

test("the limiter does not grow without bound: past maxKeys the oldest address is forgotten", () => {
  const limiter = new FailureLimiter({ max: 1, maxKeys: 3, now: () => 1 });
  for (const k of ["a", "b", "c", "d"]) limiter.fail(k);
  assert.equal(limiter.blockedFor("a"), 0, "a was evicted to make room for d");
  assert.ok(limiter.blockedFor("d") > 0);
});

test("the address a failure is counted against: the peer, or the hop our own proxy appended when told to trust it", () => {
  const r = (xff: string | undefined, peer = "10.0.0.9"): http.IncomingMessage =>
    ({ headers: xff === undefined ? {} : { "x-forwarded-for": xff }, socket: { remoteAddress: peer } }) as unknown as http.IncomingMessage;
  assert.equal(clientKey(r(undefined), {}), "10.0.0.9");
  assert.equal(clientKey(r("1.2.3.4"), {}), "10.0.0.9", "a header nobody vouches for is not an address");
  assert.equal(clientKey(r("1.2.3.4"), { MESH_TRUST_PROXY: "1" }), "1.2.3.4");
  assert.equal(clientKey(r("6.6.6.6, 1.2.3.4"), { MESH_TRUST_PROXY: "1" }), "1.2.3.4", "earlier hops are whatever the client claimed; the last is the proxy's");
  assert.equal(clientKey(r("", "10.0.0.9"), { MESH_TRUST_PROXY: "1" }), "10.0.0.9", "an empty header falls back to the peer");
});

// ----------------------------------------------------- inline script hashes

const sha = (text: string): string => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

test("an inline script is admitted by the hash of its exact bytes; external, empty and non-script tags are not", () => {
  const body = "\n  (function(){ document.documentElement.dataset.theme = 'dark'; })();\n";
  const html = `<!doctype html><head><script>${body}</script><script src="/a.js"></script><script type="module" src='/b.js'></script><script>   </script><style>x{}</style></head>`;
  assert.deepEqual(inlineScriptHashes(html), [sha(body)]);
  assert.deepEqual(inlineScriptHashes("<p>no scripts</p>"), []);
  assert.deepEqual(inlineScriptHashes(`<SCRIPT type="text/javascript">alert(1)</SCRIPT>`), [sha("alert(1)")], "tag case does not hide one");
});

test("the dashboard policy gains the hashes in script-src and nowhere else, and never unsafe-inline for scripts", () => {
  const hash = sha("x=1");
  const csp = dashboardCsp([hash]);
  assert.match(csp, new RegExp(`script-src 'self' ${hash.replace(/[+/=]/g, "\\$&")}(;|$)`));
  assert.equal(csp.split("; ").filter((d) => d.startsWith("script-src")).length, 1);
  assert.equal(csp.replace(` ${hash}`, ""), DASHBOARD_CSP, "everything else is the base policy");
  assert.equal(dashboardCsp([]), DASHBOARD_CSP);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
});

test("the real dashboard page: its one inline script (the theme bootstrap) is covered, so first paint is not a flash", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "index.html"), "utf8");
  const hashes = inlineScriptHashes(html);
  assert.equal(hashes.length, 1, "the page ships exactly one inline script: the theme bootstrap");
  assert.match(html, /mesh-theme/, "and it is the theme bootstrap");
});
