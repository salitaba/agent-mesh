/**
 * Asking for the confirmation link again: `POST /api/verify/resend`. What matters about it is what it does not say (whether an address has an
 * account, or has confirmed it) and what it does not do (send mail to anyone who is not waiting for it, or more of it than signing up could).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { plane } from "./support";
import { HOUR, PASSWORD, site, tokenIn } from "./web-support";

const origins = { origin: null } as const;
const ASKED = { ok: true, message: "If that address is waiting to be confirmed, a new link is on its way." };
const roomy = { signupIp: { max: 100, windowMs: HOUR }, signupEmail: { max: 100, windowMs: HOUR } };

test("a new link goes to an address that signed up and has not confirmed it, and it confirms the address and signs the person in", async () => {
  const p = await plane();
  const s = site(p);
  await s.call("POST", "/api/signup", { json: { email: "ada@example.com", password: PASSWORD }, ...origins });
  p.clock.advance(5 * 60_000);
  const again = await s.call("POST", "/api/verify/resend", { json: { email: " Ada@Example.com " }, ...origins });
  assert.deepEqual([again.status, again.json], [202, ASKED]);
  assert.deepEqual(p.mailer.sent.map((m) => [m.to, m.kind, m.subject]), [["ada@example.com", "verify", "Confirm your Curule account"], ["ada@example.com", "verify", "Confirm your Curule account"]]);
  assert.match(p.mailer.sent[1]!.text, /The link works once and expires in 24 hours\./);
  const [first, second] = p.mailer.sent.map((m) => tokenIn(m.text)) as [string, string];
  assert.notEqual(first, second, "it is a new link, and not the old one again");
  const ok = await s.call("POST", "/api/verify", { json: { token: second }, ...origins });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.account.email, "ada@example.com");
  assert.ok(ok.headers["set-cookie"], "it signs the person in, as the first one does");
  assert.equal((await s.call("POST", "/api/verify", { json: { token: first }, ...origins })).status, 200, "and the one that was sent first is not made worse by asking again");
});

test("it is answered the same for an address with no account, one that is waiting, one that is confirmed, one that was stopped and one that is not an address; mail goes only to the one that is waiting", async () => {
  const p = await plane();
  const s = site(p, { limits: roomy });
  await s.call("POST", "/api/signup", { json: { email: "waiting@example.com", password: PASSWORD }, ...origins });
  await p.account("confirmed@example.com");
  await s.call("POST", "/api/signup", { json: { email: "stopped@example.com", password: PASSWORD }, ...origins });
  const stopped = [...p.log.state.accounts.values()].find((a) => a.email === "stopped@example.com")!;
  await p.log.append({ type: "account.disabled", accountId: stopped.accountId, reason: "test" });
  const sentBefore = p.mailer.sent.length;

  const bodies: unknown[] = ["nobody@example.com", "waiting@example.com", "confirmed@example.com", "stopped@example.com", "WAITING@EXAMPLE.COM", "ada@", "", 5, null, undefined, ["waiting@example.com"], { email: "waiting@example.com" }];
  const replies = [];
  for (const email of bodies) replies.push(await s.call("POST", "/api/verify/resend", { json: email === undefined ? {} : { email }, ...origins }));
  for (const [i, r] of replies.entries()) {
    assert.deepEqual([r.status, r.json, r.headers], [replies[0]!.status, ASKED, replies[0]!.headers], `${JSON.stringify(bodies[i])} is answered as every other is`);
    assert.ok(!r.body.includes("@"), "and no address is said back");
  }
  assert.deepEqual(
    p.mailer.sent.slice(sentBefore).map((m) => [m.to, m.kind]),
    [["waiting@example.com", "verify"], ["waiting@example.com", "verify"]],
    "mail went to the address that is waiting, twice because it was asked for twice (as typed and in capitals), and to nobody else",
  );
});

test("asking again is limited as signing up is, by address and by email, on the same counters, and the refusal is the same for every address", async () => {
  const p = await plane();
  const s = site(p, { limits: { signupIp: { max: 100, windowMs: HOUR }, signupEmail: { max: 2, windowMs: HOUR } } });
  const ask = (email: string, ip = "203.0.113.7") => s.call("POST", "/api/verify/resend", { json: { email }, ...origins, ip });
  await s.call("POST", "/api/signup", { json: { email: "ada@example.com", password: PASSWORD }, ...origins });
  assert.equal((await ask("ada@example.com")).status, 202, "the sign-up was the first of two for this email");
  const sent = p.mailer.sent.length;
  const refused = await ask("ada@example.com");
  assert.deepEqual([refused.status, refused.json.error.code, refused.headers["retry-after"]], [429, "rate_limited", "3600"]);
  assert.equal(p.mailer.sent.length, sent, "a refusal sends nothing");

  assert.equal((await ask("nobody@example.com")).status, 202);
  assert.equal((await ask("nobody@example.com")).status, 202);
  const same = await ask("nobody@example.com");
  assert.deepEqual([same.status, same.json, same.headers["retry-after"]], [refused.status, refused.json, refused.headers["retry-after"]], "an address with no account is refused after the same number of tries, in the same words");
  assert.equal(p.mailer.sent.length, sent);

  assert.equal((await ask(" ADA@example.com ")).status, 429, "the email is limited as it will be read");
  p.clock.advance(HOUR);
  assert.equal((await ask("ada@example.com")).status, 202, "and the window is the last hour");
});

test("asking again cannot reach an address with more mail than signing up could: the two share one allowance", async () => {
  const p = await plane();
  const s = site(p, { limits: { signupIp: { max: 100, windowMs: HOUR }, signupEmail: { max: 3, windowMs: HOUR } } });
  for (let i = 0; i < 3; i++) await s.call("POST", "/api/signup", { json: { email: "ada@example.com", password: PASSWORD }, ...origins, ip: `198.51.100.${i + 1}` });
  const spent = await s.call("POST", "/api/verify/resend", { json: { email: "ada@example.com" }, ...origins, ip: "198.51.100.9" });
  assert.equal(spent.status, 429, "the three that signing up allows were used");
  const q = await plane();
  const t = site(q, { limits: { signupIp: { max: 100, windowMs: HOUR }, signupEmail: { max: 3, windowMs: HOUR } } });
  await t.call("POST", "/api/signup", { json: { email: "bob@example.com", password: PASSWORD }, ...origins });
  for (let i = 0; i < 2; i++) assert.equal((await t.call("POST", "/api/verify/resend", { json: { email: "bob@example.com" }, ...origins })).status, 202);
  assert.equal((await t.call("POST", "/api/signup", { json: { email: "bob@example.com", password: PASSWORD }, ...origins })).status, 429, "and what asking again used is gone from what signing up may");
  assert.equal(q.mailer.sent.filter((m) => m.to === "bob@example.com").length, 3, "three mails in all, as before");
});

test("one place may not ask for many addresses: the limit by address is the sign-up's, and another place is not held by it", async () => {
  const p = await plane();
  const s = site(p, { limits: { signupIp: { max: 2, windowMs: HOUR }, signupEmail: { max: 100, windowMs: HOUR } } });
  const ask = (email: string, ip: string) => s.call("POST", "/api/verify/resend", { json: { email }, ...origins, ip });
  assert.equal((await ask("a@example.com", "198.51.100.1")).status, 202);
  assert.equal((await ask("b@example.com", "198.51.100.1")).status, 202);
  const refused = await ask("c@example.com", "198.51.100.1");
  assert.deepEqual([refused.status, refused.json.error.code], [429, "rate_limited"]);
  assert.equal((await ask("c@example.com", "198.51.100.2")).status, 202);
  assert.ok(s.logs.some((l) => l.msg === "rate limit" && l.limit === "signupIp"));
});

test("it is a POST from this service's own pages and nothing else: no other method, no other origin, and a body that is not JSON is refused before anything is looked up", async () => {
  const p = await plane();
  const s = site(p);
  await s.call("POST", "/api/signup", { json: { email: "ada@example.com", password: PASSWORD }, ...origins });
  const sent = p.mailer.sent.length;
  const wrong = await s.call("GET", "/api/verify/resend");
  assert.deepEqual([wrong.status, wrong.headers.allow, wrong.json.error.code], [405, "POST", "method_not_allowed"]);
  const other = await s.call("POST", "/api/verify/resend", { json: { email: "ada@example.com" }, origin: "https://evil.example" });
  assert.deepEqual([other.status, other.json.error.code], [403, "bad_origin"]);
  assert.equal((await s.call("POST", "/api/verify/resend", { raw: "email=ada@example.com", type: "application/x-www-form-urlencoded", ...origins })).status, 415);
  assert.equal((await s.call("POST", "/api/verify/resend", { raw: "[1]", type: "application/json", ...origins })).json.error.code, "invalid_json");
  assert.equal((await s.call("POST", "/api/verify/resend/", { json: { email: "ada@example.com" }, ...origins })).status, 202, "a trailing slash is the same address, as everywhere");
  assert.equal(p.mailer.sent.length, sent + 1, "and the only mail was the one that was asked for properly");
  for (const r of [wrong, other]) {
    assert.equal(r.headers["access-control-allow-origin"], undefined, "no other site's script is told it may ask");
    assert.equal(r.headers["cache-control"], "no-store");
  }
});

test("the confirmation link is asked for again by the account's own method with the same care: nothing for an address that is not one, whatever it is given", async () => {
  const p = await plane();
  await p.plane.accounts.signup("ada@example.com", PASSWORD);
  const sent = p.mailer.sent.length;
  for (const value of [undefined, null, 5, "", "  ", "x", "a@b", {}, [], "ada@", `${"a".repeat(300)}@example.com`]) assert.equal(await p.plane.accounts.resendVerification(value), undefined);
  assert.equal(p.mailer.sent.length, sent, "none of them is an address that is waiting");
  await p.plane.accounts.resendVerification("ada@example.com");
  assert.equal(p.mailer.sent.length, sent + 1);
  assert.equal(p.mailer.sent.at(-1)!.kind, "verify");
});
