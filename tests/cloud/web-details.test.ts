import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCookies } from "../../packages/cloud/src/index";
import { plane, running } from "./support";
import { APP, HOUR, PASSWORD, site, tokenIn } from "./web-support";

// What the control API says, word for word, and the numbers it stops at, that the tests of what it does did not pin.

test("a cookie header is read as a list of names and values: a pair with no name or no equals sign is not one, and the first of a name stands", () => {
  assert.deepEqual(parseCookies("=x; a=b; c; d=; e = f ; a=again; =; ;"), { a: "b", d: "", e: "f" });
  assert.deepEqual(parseCookies(["a=1", "b=2"]), { a: "1", b: "2" }, "a header sent twice is one list");
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies(""), {});
});

test("a limit says to wait a minute when that is all it is, and how many minutes when it is more", async () => {
  const p = await plane();
  for (const [windowMs, message] of [
    [60_000, "Too many attempts. Wait a minute and try again."],
    [89_000, "Too many attempts. Wait a minute and try again."],
    [90_000, "Too many attempts. Try again in 2 minutes."],
    [91_000, "Too many attempts. Try again in 2 minutes."],
    [600_000, "Too many attempts. Try again in 10 minutes."],
  ] as const) {
    const s = site(p, { limits: { apiIp: { max: 1, windowMs } } });
    assert.equal((await s.call("GET", "/api/plans")).status, 200);
    const refused = await s.call("GET", "/api/plans");
    assert.deepEqual([refused.status, refused.json.error.code, refused.json.error.message, refused.headers["retry-after"]], [429, "rate_limited", message, String(windowMs / 1000)], `${windowMs} ms`);
    assert.ok(s.logs.some((l) => l.level === "warn" && l.msg === "rate limit" && l.limit === "apiIp" && l.retryAfterSec === windowMs / 1000));
  }
});

test("a body that is not JSON, or is not an object, is refused in words; a body with no JSON content type is refused, even of one byte; a type sent twice is read by its first", async () => {
  const p = await plane();
  const s = site(p);
  const post = (init: Parameters<typeof s.call>[2]) => s.call("POST", "/api/login", init);
  assert.deepEqual(await post({ raw: "{", type: "application/json" }).then((r) => [r.status, r.json.error.code, r.json.error.message]), [400, "invalid_json", "The request body is not valid JSON."]);
  for (const raw of ["[]", "null", '"text"', "42"]) {
    assert.deepEqual(await post({ raw, type: "application/json" }).then((r) => [r.status, r.json.error.code, r.json.error.message]), [400, "invalid_json", "The request body must be a JSON object."], raw);
  }
  for (const raw of ["x", "{}", '{"email":"a@example.com"}']) {
    assert.deepEqual(await post({ raw }).then((r) => [r.status, r.json.error.code, r.json.error.message]), [415, "unsupported_media_type", "Send JSON, with Content-Type: application/json."], `no type: ${raw}`);
    assert.equal((await post({ raw, type: "text/plain" })).status, 415, `text: ${raw}`);
  }
  assert.equal((await post({ raw: "{}" , headers: { "content-type": ["application/json", "text/plain"] } })).status, 401, "the first of two is the one that counts, and an empty login is refused as one");
  assert.equal((await post({ raw: "{}", headers: { "content-type": ["text/plain", "application/json"] } })).status, 415);
  assert.equal((await post({})).status, 401, "no body needs no type");
});

test("a change from another origin, or from a page that did not say where it came from, is refused in words; the first of two origins is the one that counts", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  const s = site(p);
  const foreign = await s.call("POST", "/api/login", { json: {}, origin: "https://evil.example" });
  assert.deepEqual([foreign.status, foreign.json.error.code, foreign.json.error.message], [403, "bad_origin", "This request did not come from this service's own pages."]);
  const silent = await s.call("POST", "/api/logout", { json: {}, origin: null, session: ada.sessionToken });
  assert.deepEqual([silent.status, silent.json.error.code, silent.json.error.message], [403, "bad_origin", "This request did not say where it came from."]);
  assert.equal((await s.call("POST", "/api/login", { json: {}, origin: null, headers: { origin: [APP, "https://evil.example"] } })).status, 401, "the first origin is this service's");
  assert.equal((await s.call("POST", "/api/login", { json: {}, origin: null, headers: { origin: ["https://evil.example", APP] } })).status, 403);
  const unsigned = await s.call("GET", "/api/me");
  assert.deepEqual([unsigned.status, unsigned.json.error.code, unsigned.json.error.message], [401, "not_signed_in", "Sign in to continue."]);
});

test("a log that cannot be written is a 503 that says to try again in a few minutes and in how many seconds", async () => {
  const { p, ada } = await running();
  const s = site(p);
  p.store.failure = new Error("disk full");
  const r = await s.call("POST", "/api/logout", { json: {}, session: ada.sessionToken });
  assert.deepEqual([r.status, r.json.error.code, r.json.error.message, r.headers["retry-after"]], [503, "unavailable", "Changes cannot be saved just now. Try again in a few minutes.", "60"]);
  assert.ok(s.logs.some((l) => l.level === "error" && l.msg === "the control log cannot be written"));
});

test("the browser that signed in is written down with the session, as it called itself, from the first of its headers", async () => {
  const p = await plane();
  const s = site(p);
  const email = "ada@example.com";
  await p.plane.accounts.signup(email, PASSWORD);
  const link = tokenIn(p.mailer.sent[0]!.text);
  const verified = await s.call("POST", "/api/verify", { json: { token: link }, headers: { "user-agent": ["Browser/1.0 (verify)", "ignored"] } });
  assert.equal(verified.status, 200);
  const login = await s.call("POST", "/api/login", { json: { email, password: PASSWORD }, headers: { "user-agent": "Browser/2.0 (login)" } });
  assert.equal(login.status, 200);
  const sessions = p.store.entries.filter((e) => e.type === "session.created") as Array<{ userAgent?: string; ip?: string }>;
  assert.deepEqual(sessions.map((e) => [e.userAgent, e.ip]), [["Browser/1.0 (verify)", "203.0.113.7"], ["Browser/2.0 (login)", "203.0.113.7"]]);
});

test("every thing that costs something is counted against the session: a password change, a workspace made, opened, stopped, started or deleted", async () => {
  const { p, ada, workspaceId } = await running();
  const s = site(p, { limits: { actionSession: { max: 5, windowMs: HOUR }, apiIp: { max: 1_000, windowMs: HOUR } } });
  const call = (path: string, json: unknown = {}) => s.call("POST", path, { json, session: ada.sessionToken });
  // None of these needs to work: each is counted before it is looked at.
  await call("/api/password", { current: "x", next: "y" });
  await call("/api/workspaces", { name: "" });
  await call(`/api/workspaces/${workspaceId}/open`);
  await call(`/api/workspaces/${workspaceId}/suspend`);
  await call(`/api/workspaces/${workspaceId}/delete`, {});
  const sixth = await call(`/api/workspaces/${workspaceId}/resume`);
  assert.deepEqual([sixth.status, sixth.json.error.code], [429, "rate_limited"], "five were counted, so the sixth is the one over");
  const other = site(p, { limits: { actionSession: { max: 1, windowMs: HOUR }, apiIp: { max: 1_000, windowMs: HOUR } } });
  await other.call("POST", `/api/workspaces/${workspaceId}/resume`, { json: {}, session: ada.sessionToken });
  assert.equal((await other.call("POST", `/api/workspaces/${workspaceId}/resume`, { json: {}, session: ada.sessionToken })).status, 429, "resuming counts too, as it should");
});

test("a workspace that is stopped is started again by its owner, and one is deleted only by naming it, in words", async () => {
  const { p, ada, workspaceId, workspace } = await running();
  const s = site(p);
  const stopped = await s.call("POST", `/api/workspaces/${workspaceId}/suspend`, { json: {}, session: ada.sessionToken });
  assert.equal(stopped.json.workspace.status, "suspended");
  const started = await s.call("POST", `/api/workspaces/${workspaceId}/resume`, { json: {}, session: ada.sessionToken });
  assert.deepEqual([started.status, started.json.workspace.status], [200, "running"]);
  assert.equal(workspace().status, "running");
  const unnamed = await s.call("POST", `/api/workspaces/${workspaceId}/delete`, { json: {}, session: ada.sessionToken });
  assert.deepEqual([unnamed.status, unnamed.json.error.code, unnamed.json.error.message], [400, "confirmation_needed", "Type the workspace's name to delete it and everything in it."]);
  assert.equal(workspace().status, "running");
});
