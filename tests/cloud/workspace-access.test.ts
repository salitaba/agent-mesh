import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { WorkspaceAccess } from "../../packages/cloud/src/index";

const SECRET = "a-service-secret-of-at-least-thirty-two-characters";
const grant = { accountId: "acct_1", workspaceId: "ws_1", sessionId: "sess_1" };

function access(options: Partial<ConstructorParameters<typeof WorkspaceAccess>[0]> = {}) {
  const clock = { now: Date.parse("2026-10-05T12:00:00.000Z") };
  return { clock, a: new WorkspaceAccess({ secret: SECRET, clock: () => new Date(clock.now), ...options }) };
}

test("a code opens one workspace once, for the session it was issued to, and says what it was for", () => {
  const { a } = access();
  const code = a.issueCode(grant);
  assert.match(code, /^[A-Za-z0-9_-]{32}$/);
  assert.deepEqual(a.redeemCode(code), grant);
  assert.equal(a.redeemCode(code), undefined, "once");
  assert.notEqual(a.issueCode(grant), a.issueCode(grant));
});

test("a code is good for a minute and not a moment more, and one that is tried too late is spent all the same", () => {
  const { a, clock } = access();
  const code = a.issueCode(grant);
  assert.equal(a.waiting, 1);
  clock.now += 60_000;
  assert.equal(a.redeemCode(code), undefined, "a minute to the millisecond is the end");
  assert.equal(a.waiting, 0, "and it was removed by being tried");
  const inTime = a.issueCode(grant);
  clock.now += 59_999;
  assert.deepEqual(a.redeemCode(inTime), grant);
  const custom = access({ codeTtlMs: 5_000 });
  const c = custom.a.issueCode(grant);
  custom.clock.now += 5_000;
  assert.equal(custom.a.redeemCode(c), undefined);
});

test("what is not a code is not redeemed, and the waiting codes are bounded and swept", () => {
  const { a, clock } = access({ maxCodes: 2 });
  for (const bad of [undefined, null, 5, "", "nope", {}]) assert.equal(a.redeemCode(bad), undefined, String(bad));
  const one = a.issueCode(grant);
  const two = a.issueCode(grant);
  const three = a.issueCode(grant);
  assert.equal(a.waiting, 2, "the oldest was dropped to make room");
  assert.equal(a.redeemCode(one), undefined);
  assert.deepEqual(a.redeemCode(two), grant);
  assert.deepEqual(a.redeemCode(three), grant);
  a.issueCode(grant);
  clock.now += 120_000;
  a.issueCode(grant);
  assert.equal(a.waiting, 1, "a code that had expired was swept when the next was issued");
});

test("a cookie says which account, workspace and session it is for, and until when", () => {
  const { a, clock } = access();
  const value = a.cookieValue(grant);
  assert.match(value, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(a.read(value), { ...grant, expiresAt: clock.now + 12 * 3_600_000 });
  assert.equal(a.cookieMaxAgeSec, 43_200);
  assert.equal(access({ cookieTtlMs: 90_000 }).a.cookieMaxAgeSec, 90);
});

test("a cookie runs out at its time, to the millisecond", () => {
  const { a, clock } = access({ cookieTtlMs: 10_000 });
  const value = a.cookieValue(grant);
  clock.now += 9_999;
  assert.ok(a.read(value));
  clock.now += 1;
  assert.equal(a.read(value), undefined);
});

test("a cookie that was changed, signed by another service, or is not one is not read", () => {
  const { a } = access();
  const value = a.cookieValue(grant);
  const [v, payload, signature] = value.split(".") as [string, string, string];
  const forged = Buffer.from(JSON.stringify({ a: "acct_2", w: "ws_1", s: "sess_1", e: Math.floor(Date.now() / 1000) + 99_999 })).toString("base64url");
  for (const bad of [undefined, "", "nope", `${v}.${payload}`, `${v}.${payload}.${signature}.extra`, `v2.${payload}.${signature}`, `${v}.${forged}.${signature}`, `${v}.${payload}.${signature.slice(0, -2)}AA`, `${v}.${payload}.`]) {
    assert.equal(a.read(bad), undefined, String(bad));
  }
  assert.equal(access({ secret: "another-secret-of-at-least-thirty-two-chars" }).a.read(value), undefined);
});

test("a statement that is properly signed but says the wrong things is not read either", () => {
  const { a, clock } = access();
  const key = createHmac("sha256", SECRET).update("workspace-access-cookie").digest();
  const sign = (claims: unknown): string => {
    const payload = Buffer.from(typeof claims === "string" ? claims : JSON.stringify(claims)).toString("base64url");
    return `v1.${payload}.${createHmac("sha256", key).update(`v1.${payload}`).digest().toString("base64url")}`;
  };
  const e = Math.floor(clock.now / 1000) + 1_000;
  assert.deepEqual(a.read(sign({ a: "acct_1", w: "ws_1", s: "sess_1", e })), { ...grant, expiresAt: e * 1000 }, "the signing here is the service's own, so a good statement reads");
  for (const bad of ["not json", [], { a: 1, w: "ws_1", s: "s", e }, { a: "a", w: 1, s: "s", e }, { a: "a", w: "w", s: 1, e }, { a: "a", w: "w", s: "s", e: "9999999999" }, { a: "a", w: "w", s: "s" }, { a: "a", w: "w", s: "s", e: Math.floor(clock.now / 1000) }]) {
    assert.equal(a.read(sign(bad)), undefined, JSON.stringify(bad));
  }
});

test("a secret that is too short is refused", () => {
  assert.throws(() => new WorkspaceAccess({ secret: "short" }), /the service secret must be at least 32 characters/);
});
