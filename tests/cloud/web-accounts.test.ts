import { test } from "node:test";
import assert from "node:assert/strict";
import { hashToken, parseCookies, securityHeaders } from "../../packages/cloud/src/index";
import { plane, running } from "./support";
import { APP, DAY, HOUR, MINUTE, PASSWORD, cookieSet, site, tokenIn } from "./web-support";

const NEW_PASSWORD = "a brand new password 7";
const origins = { origin: null } as const;

// ---- reading a request ----

test("cookies are read as a browser sends them: split on semicolons, values kept whole, the first of a repeated name wins", () => {
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies(""), {});
  assert.deepEqual(parseCookies("a=1; b=2;c=3"), { a: "1", b: "2", c: "3" });
  assert.deepEqual(parseCookies("a=x=y=="), { a: "x=y==" }, "an equals sign inside a value belongs to it");
  assert.deepEqual(parseCookies("a=1; a=2"), { a: "1" }, "a name sent twice is read once, and the first is the one a browser puts first: the most specific path");
  assert.deepEqual(parseCookies(["a=1", "b=2"]), { a: "1", b: "2" }, "a header sent twice is read as one");
  assert.deepEqual(parseCookies("=novalue; junk; ok=1;"), { ok: "1" }, "a pair with no name, or no equals sign, is skipped");
  assert.deepEqual(parseCookies("  a =  1  "), { a: "1" });
  assert.deepEqual(parseCookies("__proto__=x; constructor=y; x=1"), { x: "1" }, "a name that an object already has is never taken as a cookie");
});

test("every answer carries headers that keep a browser from caching it, sniffing it, framing it or running anything from it", () => {
  assert.deepEqual(securityHeaders(false), {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  });
  assert.deepEqual(securityHeaders(true), { ...securityHeaders(false), "strict-transport-security": "max-age=31536000; includeSubDomains" });
});

test("an address that is not one is a 404 in JSON, a method that is not allowed says which are, and no answer is open to another site's script", async () => {
  const p = await plane();
  const s = site(p);
  const nothing = await s.call("GET", "/api/nothing");
  assert.equal(nothing.status, 404);
  assert.deepEqual(nothing.json, { error: { code: "not_found", message: "There is nothing at /api/nothing." } });
  const wrong = await s.call("GET", "/api/signup");
  assert.deepEqual([wrong.status, wrong.headers.allow, wrong.json.error.code], [405, "POST", "method_not_allowed"]);
  assert.match(wrong.json.error.message, /Use POST for \/api\/signup\./);
  assert.equal((await s.call("POST", "/api/plans", { json: {} })).headers.allow, "GET");
  assert.equal((await s.call("OPTIONS", "/api/plans")).status, 405, "a preflight is not answered, so a script on another site is not told it may ask");
  assert.equal((await s.call("GET", "/API/plans")).status, 404, "paths are exact");
  assert.equal((await s.call("GET", "/api/plans/")).status, 200, "a trailing slash is the same address");
  assert.equal((await s.call("GET", "/api/plans///")).status, 200);
  for (const reply of [nothing, wrong, await s.call("GET", "/api/plans"), await s.call("GET", "/healthz"), await s.call("GET", "/api/me")]) {
    assert.equal(reply.headers["access-control-allow-origin"], undefined);
    assert.equal(reply.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(reply.headers["cache-control"], "no-store");
    assert.equal(reply.headers["cross-origin-resource-policy"], "same-origin");
    assert.equal(reply.headers["content-security-policy"], "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    assert.equal(reply.headers["strict-transport-security"], "max-age=31536000; includeSubDomains");
  }
});

test("the health check says whether the control log can be written, and is not counted against an address", async () => {
  const p = await plane();
  const s = site(p, { limits: { apiIp: { max: 1, windowMs: HOUR } } });
  for (let i = 0; i < 5; i++) assert.deepEqual(await s.call("GET", "/healthz").then((r) => [r.status, r.json]), [200, { ok: true }]);
  p.store.failure = new Error("disk full");
  assert.deepEqual(await s.call("GET", "/healthz").then((r) => [r.status, r.json]), [503, { ok: false }]);
});

test("a service on plain HTTP, for trying it on one machine, sets a cookie a browser will keep there and sends no HTTPS-only header", async () => {
  const p = await plane({ accounts: { sessionDays: 7 } });
  const s = site(p, { appUrl: "http://localhost:8080" });
  await s.call("POST", "/api/signup", { json: { email: "ada@example.com", password: PASSWORD }, ...origins });
  const verified = await s.call("POST", "/api/verify", { json: { token: tokenIn(p.mailer.sent[0]!.text) }, ...origins });
  const c = cookieSet(verified);
  assert.equal(c.name, "curule_session");
  assert.deepEqual(c.attrs, ["Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${7 * 86_400}`], "the lifetime is the session's, and there is no Secure on HTTP");
  assert.equal(verified.headers["strict-transport-security"], undefined);
  assert.equal(s.web.secureCookies, false);
  // The origin it checks is its own, whatever the HTTPS default would have been.
  assert.equal((await s.call("GET", "/api/me", { session: c.value })).status, 200);
  assert.equal((await s.call("POST", "/api/portal", { session: c.value, origin: "http://localhost:8080" })).status, 409);
  assert.equal((await s.call("POST", "/api/portal", { session: c.value, origin: APP })).status, 403);
  // Secure can be asked for on its own, when something in front of the service speaks HTTPS for it.
  const behind = site(p, { appUrl: "http://localhost:8080", secureCookies: true });
  assert.equal(behind.web.sessionCookieName, "__Host-curule_session");
  assert.equal(cookieSet(await behind.call("POST", "/api/logout", { session: c.value })).attrs.at(-1), "Secure");
});

// ---- a change must be the page's own ----

test("a change must say it is JSON, and one that carries the session must name this service's own address as its origin", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  const s = site(p);
  const body = JSON.stringify({ current: PASSWORD, next: NEW_PASSWORD });
  // A form on another site cannot send JSON, so the type is what shuts it out.
  for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "text/json", "application/jsonp", "application/json-patch+json", undefined]) {
    const r = await s.call("POST", "/api/password", { session: ada.sessionToken, raw: body, ...(type ? { type } : {}) });
    assert.deepEqual([r.status, r.json.error.code], [415, "unsupported_media_type"], String(type));
  }
  assert.equal((await p.plane.accounts.login("ada@example.com", PASSWORD)).account.accountId, ada.accountId, "none of them changed the password");
  // The type may be written as a library writes it, and a request with no body has none to name.
  for (const type of ["application/json", "application/json; charset=utf-8", "APPLICATION/JSON", "application/json ;charset=UTF-8"]) {
    assert.equal((await s.call("POST", "/api/portal", { session: ada.sessionToken, raw: "{}", type })).status, 409, type);
  }
  assert.equal((await s.call("POST", "/api/portal", { session: ada.sessionToken })).status, 409);

  for (const origin of ["https://evil.example", "http://app.example.com", "https://app.example.com:8443", "https://app.example.com.evil.example", "null"]) {
    const r = await s.call("POST", "/api/portal", { session: ada.sessionToken, origin });
    assert.deepEqual([r.status, r.json.error.code], [403, "bad_origin"], origin);
  }
  assert.ok(s.logs.some((l) => l.level === "warn" && l.msg === "request from another origin" && l.origin === "https://evil.example"));
  const unsaid = await s.call("POST", "/api/portal", { session: ada.sessionToken, origin: null });
  assert.deepEqual([unsaid.status, unsaid.json.error.code], [403, "bad_origin"]);
  assert.match(unsaid.json.error.message, /did not say where it came from/);

  // With no session there is nothing a page could be tricked into doing: a script may leave the origin out, and another site may not put its own.
  const login = { json: { email: "ada@example.com", password: PASSWORD } };
  assert.equal((await s.call("POST", "/api/login", { ...login, ...origins })).status, 200);
  assert.equal((await s.call("POST", "/api/login", { ...login, origin: "https://evil.example" })).status, 403);
  // Reading is not guarded, and what is read cannot be read from another site: there is no CORS header and the resource policy is same-origin.
  const read = await s.call("GET", "/api/me", { session: ada.sessionToken, headers: { origin: "https://evil.example" } });
  assert.equal(read.status, 200);
  assert.equal(read.headers["access-control-allow-origin"], undefined);
});

test("a body that is not a JSON object is refused as it is, after the origin and before anything is done with it", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  const s = site(p);
  for (const raw of ["{", "not json", "[]", "null", "12", '"text"']) {
    const r = await s.call("POST", "/api/checkout", { session: ada.sessionToken, raw, type: "application/json" });
    assert.deepEqual([r.status, r.json.error.code], [400, "invalid_json"], raw);
  }
  const both = await s.call("POST", "/api/checkout", { session: ada.sessionToken, raw: "{", type: "application/json", origin: "https://evil.example" });
  assert.equal(both.json.error.code, "bad_origin");
  // A body with a type and nothing in it is an empty object, and the handler says what it needs.
  assert.deepEqual(await s.call("POST", "/api/checkout", { session: ada.sessionToken, type: "application/json" }).then((r) => [r.status, r.json.error.code]), [400, "invalid_purpose"]);
});

// ---- the cookie ----

test("the session cookie is HttpOnly, SameSite=Lax and host-only, with __Host- in front and Secure when the service is on HTTPS", async () => {
  const p = await plane();
  const s = site(p);
  await s.call("POST", "/api/signup", { json: { email: "ada@example.com", password: PASSWORD }, ...origins });
  const verified = await s.call("POST", "/api/verify", { json: { token: tokenIn(p.mailer.sent[0]!.text) }, ...origins });
  const c = cookieSet(verified);
  assert.equal(c.name, "__Host-curule_session");
  assert.deepEqual(c.attrs, ["Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${30 * 86_400}`, "Secure"]);
  assert.ok(!c.attrs.some((a) => /^domain=/i.test(a)), "a __Host- cookie has no Domain, so no other host can set or read one");
  assert.match(c.value, /^s_[A-Za-z0-9_-]{40,}$/);
  assert.equal(s.web.sessionCookieName, c.name);
  assert.equal(s.web.secureCookies, true);
});

// ---- signing up ----

test("signing up is answered the same for an address that has an account and one that has not; the difference is in the mail its owner reads", async () => {
  const p = await plane();
  const s = site(p);
  const fresh = await s.call("POST", "/api/signup", { json: { email: "ada@example.com", password: PASSWORD }, ...origins });
  assert.deepEqual([fresh.status, fresh.json], [202, { ok: true, message: "Check your email for a link to confirm your address." }]);
  assert.deepEqual(p.mailer.sent.map((m) => [m.to, m.kind]), [["ada@example.com", "verify"]]);
  assert.equal((await s.call("POST", "/api/verify", { json: { token: tokenIn(p.mailer.sent[0]!.text) }, ...origins })).status, 200);

  const again = await s.call("POST", "/api/signup", { json: { email: " Ada@Example.com ", password: "another long password 1" }, ...origins, ip: "198.51.100.9" });
  assert.deepEqual([again.status, again.body, again.headers], [fresh.status, fresh.body, fresh.headers]);
  assert.deepEqual(p.mailer.sent.map((m) => [m.to, m.kind]), [["ada@example.com", "verify"], ["ada@example.com", "signup-existing"]]);
  // Nobody who does not hold the mailbox gets a password onto the account by asking again.
  assert.equal((await s.call("POST", "/api/login", { json: { email: "ada@example.com", password: "another long password 1" }, ...origins })).status, 401);
  assert.equal((await s.call("POST", "/api/login", { json: { email: "ada@example.com", password: PASSWORD }, ...origins })).status, 200);
  assert.ok(!fresh.body.includes("ada@example.com") && !again.body.includes("ada@example.com"));
});

test("a sign-up that sent no mail is not held against the address: a mistyped address or a weak password can be tried again", async () => {
  const p = await plane();
  const s = site(p, { limits: { signupIp: { max: 2, windowMs: HOUR }, signupEmail: { max: 1, windowMs: HOUR } } });
  const signup = (email: unknown, password: unknown) => s.call("POST", "/api/signup", { json: { email, password }, ...origins });
  for (let i = 0; i < 4; i++) assert.deepEqual(await signup("ada@", PASSWORD).then((r) => [r.status, r.json.error.code]), [400, "invalid_email"]);
  for (let i = 0; i < 4; i++) assert.deepEqual(await signup(5, PASSWORD).then((r) => [r.status, r.json.error.code]), [400, "invalid_email"]);
  for (let i = 0; i < 4; i++) assert.deepEqual(await signup("ada@example.com", "short").then((r) => [r.status, r.json.error.code]), [400, "weak_password"]);
  for (let i = 0; i < 4; i++) assert.deepEqual(await signup("ada@example.com", 12345).then((r) => [r.status, r.json.error.code]), [400, "weak_password"]);
  assert.equal(p.mailer.sent.length, 0);
  assert.equal((await signup("ada@example.com", PASSWORD)).status, 202, "neither the address nor the email has been spent");
  assert.equal((await signup("bob@example.com", PASSWORD)).status, 202);
  assert.equal((await signup("cyd@example.com", PASSWORD)).status, 429, "the two that did send mail were counted");
  assert.equal(p.mailer.sent.length, 2);
});

test("sign-ups are limited by address and by email: not many mailboxes from one place, and not one mailbox from many places", async () => {
  const p = await plane();
  const s = site(p, { limits: { signupIp: { max: 2, windowMs: HOUR }, signupEmail: { max: 1, windowMs: HOUR } } });
  const signup = (email: string, ip: string) => s.call("POST", "/api/signup", { json: { email, password: PASSWORD }, ...origins, ip });
  assert.equal((await signup("ada@example.com", "198.51.100.1")).status, 202);
  const second = await signup(" ADA@example.com", "198.51.100.2");
  assert.equal(second.status, 429, "the email is limited as it will be read, so another case or a space buys nothing");
  assert.deepEqual([second.json.error.code, second.json.error.message, second.headers["retry-after"]], ["rate_limited", "Too many attempts. Try again in 60 minutes.", "3600"]);
  assert.equal(p.mailer.sent.length, 1, "the mailbox was not written to again");
  assert.equal((await signup("bob@example.com", "198.51.100.1")).status, 202);
  assert.equal((await signup("cyd@example.com", "198.51.100.1")).status, 429, "one place is held to its own limit");
  assert.equal((await signup("cyd@example.com", "198.51.100.3")).status, 202, "and another place is not held by it");
  p.clock.advance(HOUR - 1);
  assert.equal((await signup("ada@example.com", "198.51.100.2")).status, 429, "the window is the last hour, not a bucket that empties on the hour");
  p.clock.advance(1);
  assert.equal((await signup("ada@example.com", "198.51.100.2")).status, 202);
});

test("a limit says how long to wait, in seconds for a program and in words for a person", async () => {
  const p = await plane();
  const s = site(p, { limits: { signupIp: { max: 1, windowMs: 30_000 } } });
  const signup = (email: string) => s.call("POST", "/api/signup", { json: { email, password: PASSWORD }, ...origins });
  assert.equal((await signup("ada@example.com")).status, 202);
  p.clock.advance(5_000);
  const refused = await signup("bob@example.com");
  assert.deepEqual([refused.status, refused.headers["retry-after"], refused.json.error.message], [429, "25", "Too many attempts. Wait a minute and try again."]);
  assert.ok(s.logs.some((l) => l.level === "warn" && l.msg === "rate limit" && l.limit === "signupIp" && l.retryAfterSec === 25));
  p.clock.advance(HOUR);
  const t = site(p, { limits: { signupIp: { max: 1, windowMs: 90 * MINUTE } } });
  await t.call("POST", "/api/signup", { json: { email: "cyd@example.com", password: PASSWORD }, ...origins });
  assert.equal(await t.call("POST", "/api/signup", { json: { email: "dee@example.com", password: PASSWORD }, ...origins }).then((r) => r.json.error.message), "Too many attempts. Try again in 90 minutes.");
});

// ---- the link in the mail ----

test("the link in the mail confirms the address and signs the person in, once, and any other link says only that it is not valid", async () => {
  const p = await plane();
  const s = site(p);
  await s.call("POST", "/api/signup", { json: { email: "ada@example.com", password: PASSWORD }, ...origins });
  const token = tokenIn(p.mailer.sent[0]!.text);
  const bad = await s.call("POST", "/api/verify", { json: { token: "not-a-link" }, ...origins });
  assert.deepEqual([bad.status, bad.json], [400, { error: { code: "invalid_token", message: "That link is not valid, or it has expired. Ask for a new one." } }]);
  for (const body of [{}, { token: "" }, { token: 7 }, { token: ["x"] }, { token: `${token}x` }, { token: token.slice(1) }]) {
    const r = await s.call("POST", "/api/verify", { json: body, ...origins });
    assert.deepEqual([r.status, r.body], [bad.status, bad.body], JSON.stringify(body));
    assert.equal(r.headers["set-cookie"], undefined);
  }
  const ok = await s.call("POST", "/api/verify", { json: { token }, ...origins, ip: "198.51.100.4", headers: { "user-agent": "Mozilla/5.0 (test)" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.account.email, "ada@example.com");
  assert.equal(ok.json.account.subscription, null);
  assert.ok(!ok.body.includes(p.log.state.accounts.get(ok.json.account.accountId)!.passwordHash));
  const c = cookieSet(ok);
  assert.equal((await s.call("GET", "/api/me", { session: c.value })).json.account.email, "ada@example.com");
  const made = p.store.entries.filter((e) => e.type === "session.created").at(-1) as { ip?: string; userAgent?: string };
  assert.deepEqual([made.ip, made.userAgent], ["198.51.100.4", "Mozilla/5.0 (test)"], "where a session began is kept, for the person to see and the operator to read");
  assert.equal(await s.call("POST", "/api/verify", { json: { token }, ...origins }).then((r) => r.body), bad.body, "a link works once");
});

test("a link that has expired does not sign anyone in", async () => {
  const p = await plane();
  const s = site(p);
  await s.call("POST", "/api/signup", { json: { email: "ada@example.com", password: PASSWORD }, ...origins });
  const token = tokenIn(p.mailer.sent[0]!.text);
  p.clock.advance(24 * HOUR);
  assert.equal(await s.call("POST", "/api/verify", { json: { token }, ...origins }).then((r) => r.status), 400);
});

test("links are limited by address, and confirmation and reset links share the count: a link is not something to guess", async () => {
  const p = await plane();
  const s = site(p, { limits: { tokenIp: { max: 3, windowMs: HOUR } } });
  await s.call("POST", "/api/signup", { json: { email: "ada@example.com", password: PASSWORD }, ...origins });
  const token = tokenIn(p.mailer.sent[0]!.text);
  assert.equal((await s.call("POST", "/api/verify", { json: { token: "guess-1" }, ...origins })).status, 400);
  assert.equal((await s.call("POST", "/api/reset", { json: { token: "guess-2", password: NEW_PASSWORD }, ...origins })).status, 400);
  assert.equal((await s.call("POST", "/api/verify", { json: { token: "guess-3" }, ...origins })).status, 400);
  const blocked = await s.call("POST", "/api/verify", { json: { token }, ...origins });
  assert.deepEqual([blocked.status, blocked.json.error.code], [429, "rate_limited"], "a right link is refused too: the limit does not say whether a guess was right");
  assert.equal((await s.call("POST", "/api/verify", { json: { token }, ...origins, ip: "198.51.100.8" })).status, 200, "and it is by address");
});

// ---- signing in and out ----

test("signing in says one thing about every way it can fail, and the reply is the same in status, body and headers", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  await p.plane.accounts.signup("new@example.com", PASSWORD);
  const bob = await p.account("bob@example.com");
  await p.plane.disableAccount(bob.accountId, "abuse");
  const s = site(p);
  const attempt = (email: unknown, password: unknown) => s.call("POST", "/api/login", { json: { email, password }, ...origins });
  const wrong = await attempt("ada@example.com", "not the password at all");
  assert.deepEqual([wrong.status, wrong.json], [401, { error: { code: "invalid_credentials", message: "That email and password do not match an account." } }]);
  for (const [email, password] of [["nobody@example.com", PASSWORD], ["new@example.com", PASSWORD], ["bob@example.com", PASSWORD], ["not an email", PASSWORD], [42, PASSWORD], ["ada@example.com", 42], [undefined, undefined]] as const) {
    const r = await attempt(email, password);
    assert.deepEqual([r.status, r.body, r.headers], [wrong.status, wrong.body, wrong.headers], JSON.stringify([email, password]));
  }
  assert.equal(p.mailer.sent.filter((m) => m.to === "new@example.com" && m.kind === "verify").length, 2, "an account that was never confirmed is sent its link again when its own password is given, and told nothing");
  const logged = JSON.stringify(s.logs);
  assert.ok(s.logs.some((l) => l.level === "info" && l.msg === "sign-in refused"));
  for (const secret of [PASSWORD, "ada@example.com", "bob@example.com", "nobody@example.com"]) assert.ok(!logged.includes(secret), "a refused sign-in leaves no address or password in the log");

  const ok = await attempt("Ada@Example.com ", PASSWORD);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.account.accountId, ada.accountId);
  assert.deepEqual(Object.keys(ok.json), ["account"]);
  const c = cookieSet(ok);
  assert.equal(c.name, "__Host-curule_session");
  assert.equal((await s.call("GET", "/api/me", { session: c.value })).json.account.accountId, ada.accountId);
  assert.notEqual(c.value, ada.sessionToken, "each sign-in is a session of its own");
});

test("sign-in attempts are limited by email as it is read, from wherever they come, and a sign-in that works clears the count", async () => {
  const p = await plane();
  await p.account("ada@example.com");
  const s = site(p, { limits: { loginEmail: { max: 3, windowMs: 10 * MINUTE } } });
  const attempt = (password: string, ip: string, email = "ada@example.com") => s.call("POST", "/api/login", { json: { email, password }, ...origins, ip });
  for (const ip of ["198.51.100.1", "198.51.100.2", "198.51.100.3"]) assert.equal((await attempt("a wrong password", ip)).status, 401);
  const locked = await attempt(PASSWORD, "198.51.100.4");
  assert.deepEqual([locked.status, locked.json.error.code, locked.headers["retry-after"]], [429, "rate_limited", "600"], "guessing from many places is one count, and the right password is not tried while it is used up");
  assert.equal((await attempt(PASSWORD, "198.51.100.4", " ADA@example.com")).status, 429, "whatever case it is written in");
  assert.equal((await attempt(PASSWORD, "198.51.100.4", "bob@example.com")).status, 401, "another mailbox is not held back by it");

  p.clock.advance(10 * MINUTE);
  assert.equal((await attempt("a wrong password", "198.51.100.1")).status, 401);
  assert.equal((await attempt("a wrong password", "198.51.100.1")).status, 401);
  assert.equal((await attempt(PASSWORD, "198.51.100.1")).status, 200);
  for (let i = 0; i < 3; i++) assert.equal((await attempt("a wrong password", `198.51.100.${10 + i}`)).status, 401, "after a sign-in the count starts again");
  assert.equal((await attempt("a wrong password", "198.51.100.20")).status, 429);
});

test("sign-in attempts are limited by address, whatever they ask for, and a sign-in that works is still counted against it", async () => {
  const p = await plane();
  await p.account("ada@example.com");
  const s = site(p, { limits: { loginIp: { max: 3, windowMs: 10 * MINUTE } } });
  const attempt = (email: string, ip: string) => s.call("POST", "/api/login", { json: { email, password: PASSWORD }, ...origins, ip });
  assert.equal((await attempt("ada@example.com", "198.51.100.1")).status, 200);
  assert.equal((await attempt("ada@example.com", "198.51.100.1")).status, 200);
  assert.equal((await attempt("bob@example.com", "198.51.100.1")).status, 401);
  assert.equal((await attempt("ada@example.com", "198.51.100.1")).status, 429, "the address has used its three, and a right password does not buy a fourth");
  assert.equal((await attempt("ada@example.com", "198.51.100.2")).status, 200);
});

test("signing out ends the session at once, clears the cookie, and answers the same when nobody was signed in", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  const s = site(p);
  assert.equal((await s.call("GET", "/api/me", { session: ada.sessionToken })).status, 200);
  const out = await s.call("POST", "/api/logout", { session: ada.sessionToken });
  assert.deepEqual([out.status, out.json], [200, { ok: true }]);
  assert.equal(out.headers["set-cookie"], "__Host-curule_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure");
  const gone = await s.call("GET", "/api/me", { session: ada.sessionToken });
  assert.deepEqual([gone.status, gone.json.error.code], [401, "not_signed_in"]);
  for (const call of [s.call("POST", "/api/logout", { session: ada.sessionToken }), s.call("POST", "/api/logout", { session: "s_never_issued" }), s.call("POST", "/api/logout", origins)]) {
    const r = await call;
    assert.deepEqual([r.status, r.json, r.headers["set-cookie"]], [200, { ok: true }, out.headers["set-cookie"]]);
  }
  const other = await p.plane.accounts.login("ada@example.com", PASSWORD);
  assert.equal((await s.call("POST", "/api/logout", { session: other.sessionToken, origin: "https://evil.example" })).status, 403, "another site cannot sign a person out");
  assert.equal((await s.call("GET", "/api/me", { session: other.sessionToken })).status, 200);
});

// ---- forgotten passwords ----

test("asking for a reset is answered the same for every address, and mail goes only to an address with a verified account", async () => {
  const p = await plane();
  await p.account("ada@example.com");
  await p.plane.accounts.signup("new@example.com", PASSWORD);
  const before = p.mailer.sent.length;
  const s = site(p);
  const ask = (email: unknown) => s.call("POST", "/api/forgot", { json: { email }, ...origins });
  const known = await ask("ada@example.com");
  assert.deepEqual([known.status, known.json], [202, { ok: true, message: "If that address has an account, a link to choose a new password is on its way." }]);
  for (const email of ["nobody@example.com", "new@example.com", "not an email", 7, undefined, null]) {
    const r = await ask(email);
    assert.deepEqual([r.status, r.body, r.headers], [known.status, known.body, known.headers], String(email));
  }
  assert.deepEqual(p.mailer.sent.slice(before).map((m) => [m.to, m.kind]), [["ada@example.com", "reset"]]);
});

test("reset requests are limited by address and by email, the same for an address that has an account and one that has not", async () => {
  const p = await plane();
  await p.account("ada@example.com");
  const before = p.mailer.sent.length;
  const s = site(p, { limits: { forgotIp: { max: 2, windowMs: HOUR }, forgotEmail: { max: 1, windowMs: HOUR } } });
  const ask = (email: string, ip: string) => s.call("POST", "/api/forgot", { json: { email }, ...origins, ip });
  assert.equal((await ask("ada@example.com", "198.51.100.1")).status, 202);
  assert.equal((await ask(" ADA@example.com", "198.51.100.2")).status, 429);
  assert.equal(p.mailer.sent.length - before, 1, "a mailbox is not filled from many places");
  assert.equal((await ask("nobody@example.com", "198.51.100.3")).status, 202);
  assert.equal((await ask("nobody@example.com", "198.51.100.4")).status, 429, "an address with no account is limited as one with an account is, so the limit tells nothing");
  assert.equal((await ask("bob@example.com", "198.51.100.1")).status, 202);
  assert.equal((await ask("cyd@example.com", "198.51.100.1")).status, 429);
});

test("a reset link chooses a new password, once; every session ends and the cookie is cleared, and a weak password does not spend the link", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  const s = site(p);
  await s.call("POST", "/api/forgot", { json: { email: "ada@example.com" }, ...origins });
  const token = tokenIn(p.mailer.sent.at(-1)!.text);
  for (const password of ["short", 5, undefined]) {
    const weak = await s.call("POST", "/api/reset", { json: { token, password }, ...origins });
    assert.deepEqual([weak.status, weak.json.error.code], [400, "weak_password"], String(password));
  }
  const done = await s.call("POST", "/api/reset", { json: { token, password: NEW_PASSWORD }, ...origins });
  assert.deepEqual([done.status, done.json], [200, { ok: true }]);
  assert.equal(done.headers["set-cookie"], "__Host-curule_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure", "nobody is signed in by it: the person signs in with what they chose");
  assert.equal((await s.call("GET", "/api/me", { session: ada.sessionToken })).status, 401, "a session that was open ends");
  assert.equal((await s.call("POST", "/api/login", { json: { email: "ada@example.com", password: PASSWORD }, ...origins })).status, 401);
  assert.equal((await s.call("POST", "/api/login", { json: { email: "ada@example.com", password: NEW_PASSWORD }, ...origins })).status, 200);
  const reused = await s.call("POST", "/api/reset", { json: { token, password: "yet another password 9" }, ...origins });
  assert.deepEqual([reused.status, reused.json.error.code], [400, "invalid_token"]);
  await p.plane.accounts.signup("bob@example.com", PASSWORD);
  const confirmation = tokenIn(p.mailer.sent.at(-1)!.text);
  const notAReset = await s.call("POST", "/api/reset", { json: { token: confirmation, password: NEW_PASSWORD }, ...origins });
  assert.equal(notAReset.json.error.code, "invalid_token", "a confirmation link does not choose a password");
});

test("a reset ends a lockout: whoever holds the mailbox is not kept out by someone else's failed attempts", async () => {
  const p = await plane();
  await p.account("ada@example.com");
  const s = site(p, { limits: { loginEmail: { max: 2, windowMs: 10 * MINUTE } } });
  const login = (password: string, ip: string) => s.call("POST", "/api/login", { json: { email: "ada@example.com", password }, ...origins, ip });
  assert.equal((await login("someone else's guess", "198.51.100.1")).status, 401);
  assert.equal((await login("someone else's guess", "198.51.100.2")).status, 401);
  assert.equal((await login(PASSWORD, "203.0.113.7")).status, 429, "the person is locked out by guesses that were not theirs");
  await s.call("POST", "/api/forgot", { json: { email: "ada@example.com" }, ...origins });
  const done = await s.call("POST", "/api/reset", { json: { token: tokenIn(p.mailer.sent.at(-1)!.text), password: NEW_PASSWORD }, ...origins });
  assert.equal(done.status, 200);
  assert.equal((await login(NEW_PASSWORD, "203.0.113.7")).status, 200, "the link came to their mailbox, which says more than a password does");
});

// ---- a password the person knows ----

test("changing a password needs the current one, ends every other session and keeps this one", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  const other = (await p.plane.accounts.login("ada@example.com", PASSWORD)).sessionToken;
  const s = site(p);
  const change = (session: string | undefined, current: unknown, next: unknown) => s.call("POST", "/api/password", { json: { current, next }, ...(session ? { session } : {}) });
  assert.deepEqual(await change(undefined, PASSWORD, NEW_PASSWORD).then((r) => [r.status, r.json.error.code]), [401, "not_signed_in"]);
  assert.deepEqual(await change(ada.sessionToken, "not the password at all", NEW_PASSWORD).then((r) => [r.status, r.json.error.code]), [403, "invalid_credentials"]);
  assert.deepEqual(await change(ada.sessionToken, 5, NEW_PASSWORD).then((r) => [r.status, r.json.error.code]), [403, "invalid_credentials"]);
  assert.deepEqual(await change(ada.sessionToken, PASSWORD, "short").then((r) => [r.status, r.json.error.code]), [400, "weak_password"]);
  assert.deepEqual(await change(ada.sessionToken, PASSWORD, undefined).then((r) => [r.status, r.json.error.code]), [400, "weak_password"]);
  assert.deepEqual(await change(ada.sessionToken, PASSWORD, NEW_PASSWORD).then((r) => [r.status, r.json]), [200, { ok: true }]);
  assert.equal((await s.call("GET", "/api/me", { session: ada.sessionToken })).status, 200, "this session goes on");
  assert.equal((await s.call("GET", "/api/me", { session: other })).status, 401, "the others end");
  assert.equal((await s.call("POST", "/api/login", { json: { email: "ada@example.com", password: PASSWORD }, ...origins })).status, 401);
  assert.equal((await s.call("POST", "/api/login", { json: { email: "ada@example.com", password: NEW_PASSWORD }, ...origins })).status, 200);
});

test("the current password cannot be guessed through a session that was stolen: the attempts count with sign-ins, and a right one clears them", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  const s = site(p, { limits: { loginEmail: { max: 2, windowMs: 10 * MINUTE } } });
  const change = (current: string, next = NEW_PASSWORD) => s.call("POST", "/api/password", { json: { current, next }, session: ada.sessionToken });
  assert.equal((await change("a guess")).status, 403);
  assert.equal((await change("another guess")).status, 403);
  const locked = await change(PASSWORD);
  assert.deepEqual([locked.status, locked.json.error.code], [429, "rate_limited"]);
  assert.equal((await s.call("POST", "/api/login", { json: { email: "ada@example.com", password: PASSWORD }, ...origins })).status, 429, "it is the same count as for signing in");
  p.clock.advance(10 * MINUTE);
  assert.equal((await change("a guess")).status, 403);
  assert.equal((await change(PASSWORD)).status, 200, "the second try of two works, and clears the count");
  assert.equal((await change("a guess", "x")).status, 403);
  assert.equal((await change("a guess", "x")).status, 403);
  assert.equal((await change("a guess", "x")).status, 429, "after a change that worked the count started again");
});

// ---- the account as its owner sees it ----

test("what the account page reads is the account as its owner sees it, with the balance, and nothing that is secret", async () => {
  const { p, ada, workspaceId } = await running();
  const s = site(p);
  const noSession = await s.call("GET", "/api/me");
  assert.deepEqual([noSession.status, noSession.json.error.code], [401, "not_signed_in"]);
  for (const cookie of ["", "x=1", `${s.web.sessionCookieName}=`, `${s.web.sessionCookieName}=s_unknown`, `curule_session=${ada.sessionToken}`]) {
    assert.equal((await s.call("GET", "/api/me", { headers: cookie ? { cookie } : {} })).status, 401, cookie);
  }
  const me = await s.call("GET", "/api/me", { session: ada.sessionToken });
  assert.equal(me.status, 200);
  assert.deepEqual(Object.keys(me.json).sort(), ["account", "balance"]);
  assert.deepEqual(me.json.account, p.plane.view(p.log.state.accounts.get(ada.accountId)!));
  assert.deepEqual(me.json.balance, await p.plane.balance(ada.accountId));
  assert.ok(me.json.balance.balance.total > 0, "the plan's usage is in it");
  const record = p.log.state.workspaces.get(workspaceId)!;
  for (const secret of [p.log.state.accounts.get(ada.accountId)!.passwordHash, ada.sessionToken, hashToken(ada.sessionToken), record.gatewayKeyId!, p.provisioner.ops("create")[0]!.spec!.operatorToken, p.provisioner.ops("create")[0]!.spec!.gateway.key]) {
    assert.ok(!me.body.includes(secret));
  }
});

test("an account page still opens when the balance cannot be read, and says so by having none", async () => {
  const { p, ada } = await running();
  const s = site(p);
  Object.assign(p.plane.o.gateway, { account: async () => { throw new Error("gateway down at 10.0.0.9:8080"); } });
  const me = await s.call("GET", "/api/me", { session: ada.sessionToken });
  assert.equal(me.status, 200);
  assert.equal(me.json.balance, null);
  assert.equal(me.json.account.email, "ada@example.com");
  assert.ok(!me.body.includes("10.0.0.9"));
  assert.ok(s.logs.some((l) => l.level === "warn" && l.msg === "the balance could not be read" && String(l.error).includes("10.0.0.9")));
});

test("the header of every page asks who is signed in: the account for a session, and no account, not an error, for anyone else; and it reads no balance", async () => {
  const { p, ada, workspaceId } = await running();
  const s = site(p);
  let reads = 0;
  const original = p.plane.o.gateway.account.bind(p.plane.o.gateway);
  Object.assign(p.plane.o.gateway, { account: async (id: string) => (reads++, original(id)) });

  const out = await s.call("GET", "/api/session");
  assert.deepEqual([out.status, out.json], [200, { account: null }], "a visitor is the ordinary case: it is not a 401 for every page they open");
  assert.equal(out.headers["cache-control"], "no-store");
  for (const cookie of ["x=1", `${s.web.sessionCookieName}=`, `${s.web.sessionCookieName}=s_unknown`, `curule_session=${ada.sessionToken}`]) {
    const r = await s.call("GET", "/api/session", { headers: { cookie } });
    assert.deepEqual([r.status, r.json], [200, { account: null }], cookie);
  }

  const me = await s.call("GET", "/api/session", { session: ada.sessionToken });
  assert.equal(me.status, 200);
  assert.deepEqual(me.json, { account: p.plane.view(p.log.state.accounts.get(ada.accountId)!) }, "the account as its owner sees it, with its plan and workspaces, and no balance");
  assert.equal(reads, 0, "the gateway is not asked for what a header does not show");
  const record = p.log.state.workspaces.get(workspaceId)!;
  for (const secret of [p.log.state.accounts.get(ada.accountId)!.passwordHash, ada.sessionToken, hashToken(ada.sessionToken), record.gatewayKeyId!, p.provisioner.ops("create")[0]!.spec!.operatorToken]) assert.ok(!me.body.includes(secret));
  assert.equal((await s.call("POST", "/api/session", { json: {}, origin: null })).status, 405, "it only reads");

  // Opening a page is use of the session, so a person who reads pages is not signed out for being idle.
  const seen = () => p.store.entries.filter((e) => e.type === "session.seen").length;
  p.clock.advance(11 * MINUTE);
  await s.call("GET", "/api/session", { session: ada.sessionToken });
  assert.equal(seen(), 1);

  await p.plane.disableAccount(ada.accountId, "abuse report 12");
  assert.deepEqual((await s.call("GET", "/api/session", { session: ada.sessionToken })).json, { account: null }, "a stopped account is not signed in");
});

test("a session ends when the account is stopped, and a stopped account cannot sign in", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  const s = site(p);
  await p.plane.disableAccount(ada.accountId, "abuse report 12");
  assert.equal((await s.call("GET", "/api/me", { session: ada.sessionToken })).status, 401);
  const refused = await s.call("POST", "/api/login", { json: { email: "ada@example.com", password: PASSWORD }, ...origins });
  assert.equal(refused.json.error.code, "invalid_credentials", "it is not told it was stopped, or why");
  assert.ok(!refused.body.includes("abuse"));
  await p.plane.enableAccount(ada.accountId);
  assert.equal((await s.call("POST", "/api/login", { json: { email: "ada@example.com", password: PASSWORD }, ...origins })).status, 200);
});

test("use of a session is recorded at most every ten minutes", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  const s = site(p);
  const seen = () => p.store.entries.filter((e) => e.type === "session.seen").length;
  const sid = p.plane.accounts.identify(ada.sessionToken)!.sessionId;
  p.clock.advance(5 * MINUTE);
  assert.equal((await s.call("GET", "/api/me", { session: ada.sessionToken })).status, 200);
  assert.equal(seen(), 0, "a busy page does not write on every request");
  p.clock.advance(6 * MINUTE);
  assert.equal((await s.call("GET", "/api/me", { session: ada.sessionToken })).status, 200);
  assert.equal(seen(), 1);
  assert.equal(p.log.state.sessions.get(sid)!.lastSeenAt, new Date(p.clock.now).toISOString());
  p.clock.advance(5 * MINUTE);
  await s.call("GET", "/api/me", { session: ada.sessionToken });
  assert.equal(seen(), 1);
});

test("a session that is not used for fourteen days ends, and one that was used in the meantime goes on", async () => {
  const p = await plane();
  await p.account("ada@example.com");
  const s = site(p);
  const a = (await p.plane.accounts.login("ada@example.com", PASSWORD)).sessionToken;
  const b = (await p.plane.accounts.login("ada@example.com", PASSWORD)).sessionToken;
  const began = p.clock.now;
  p.clock.now = began + 14 * DAY;
  assert.equal((await s.call("GET", "/api/me", { session: a })).status, 200, "fourteen days exactly is still within it");
  p.clock.now = began + 14 * DAY + 1;
  assert.equal((await s.call("GET", "/api/me", { session: b })).status, 401, "a day and a moment is not");
  assert.equal((await s.call("GET", "/api/me", { session: a })).status, 200, "and the one that was used in between has fourteen days from then");
  p.clock.now = began + 31 * DAY;
  assert.equal((await s.call("GET", "/api/me", { session: a })).status, 401, "whatever its use, a session ends thirty days after it began");
});

test("a failure to record that a session was used does not fail the request that used it", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  const s = site(p);
  Object.assign(p.plane.accounts, { touch: async () => { throw new Error("disk full"); } });
  assert.equal((await s.call("GET", "/api/me", { session: ada.sessionToken })).status, 200);
});

// ---- when the service itself fails ----

test("a failure inside the service is logged with its detail and answered without it", async () => {
  const p = await plane();
  const s = site(p);
  Object.assign(p.plane.accounts, { signup: async () => { throw new Error("EACCES: /var/lib/curule/control.jsonl is secret"); } });
  const r = await s.call("POST", "/api/signup", { json: { email: "ada@example.com", password: PASSWORD }, ...origins });
  assert.deepEqual([r.status, r.json], [500, { error: { code: "internal_error", message: "Something went wrong on our side. Try again in a moment." } }]);
  assert.ok(!r.body.includes("EACCES"));
  const logged = s.logs.find((l) => l.level === "error");
  assert.match(String(logged?.error), /EACCES: \/var\/lib\/curule\/control\.jsonl is secret/);
  assert.equal(logged?.path, "/api/signup");
});

test("a control log that can no longer be written is a 503 that says when to try again, and reading still works", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  const s = site(p);
  p.store.failure = new Error("ENOSPC: no space left on device");
  const r = await s.call("POST", "/api/login", { json: { email: "ada@example.com", password: PASSWORD }, ...origins });
  assert.deepEqual([r.status, r.json.error.code, r.headers["retry-after"]], [503, "unavailable", "60"]);
  assert.ok(!r.body.includes("ENOSPC"));
  assert.ok(s.logs.some((l) => l.level === "error" && l.msg === "the control log cannot be written" && String(l.error).includes("ENOSPC")));
  assert.equal((await s.call("GET", "/api/plans")).status, 200);
  assert.equal((await s.call("GET", "/api/me", { session: ada.sessionToken })).status, 200);
});

test("everything else from one address is limited, and what is not a request for anything is not counted", async () => {
  const p = await plane();
  const s = site(p, { limits: { apiIp: { max: 3, windowMs: MINUTE } } });
  for (let i = 0; i < 3; i++) assert.equal((await s.call("GET", "/api/plans")).status, 200);
  const refused = await s.call("GET", "/api/plans");
  assert.deepEqual([refused.status, refused.headers["retry-after"], refused.json.error.message], [429, "60", "Too many attempts. Wait a minute and try again."]);
  assert.equal((await s.call("GET", "/api/plans", { ip: "198.51.100.5" })).status, 200, "it is by address");
  assert.equal((await s.call("GET", "/healthz")).status, 200, "a load balancer's check is not counted");
  assert.equal((await s.call("GET", "/api/nothing")).status, 404, "an address that is nothing is answered as it is");
  p.clock.advance(MINUTE);
  assert.equal((await s.call("GET", "/api/plans")).status, 200);
});
