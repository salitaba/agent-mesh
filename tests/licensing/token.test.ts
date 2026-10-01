import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_GRACE_DAYS,
  LICENSE_PREFIX,
  claimsProblem,
  generateLicenseKeyPair,
  signLicense,
  verifyLicense,
  type LicenseClaims,
} from "../../packages/licensing/src/index";

/**
 * A licence is a signed statement checked offline: what was signed is what is read, anything
 * else — a different key, a changed byte, a truncated string, a newer format — is a named
 * failure, and checking never throws.
 */

const keys = generateLicenseKeyPair();
const other = generateLicenseKeyPair();
const PUBLIC = { k1: keys.publicKey };

const claims = (over: Partial<LicenseClaims> = {}): LicenseClaims => ({
  v: 1,
  id: "lic_0001",
  customer: "Acme Robotics",
  plan: "team",
  issuedAt: "2026-10-01T00:00:00.000Z",
  expiresAt: "2027-10-01T00:00:00.000Z",
  ...over,
});

test("a signed licence verifies and reads back exactly what was signed", () => {
  const c = claims({ graceDays: 30, limits: { maxProjects: 9 }, features: ["usage-export"], notes: "pilot" });
  const token = signLicense(c, "k1", keys.privateKeyPem);
  assert.ok(token.startsWith(`${LICENSE_PREFIX}.k1.`));
  const res = verifyLicense(token, PUBLIC);
  assert.ok(res.ok);
  assert.deepEqual(res.claims, c);
  assert.equal(res.kid, "k1");
});

test("whitespace around a pasted token is ignored", () => {
  const token = signLicense(claims(), "k1", keys.privateKeyPem);
  assert.ok(verifyLicense(`\n  ${token}\n`, PUBLIC).ok);
});

test("a changed payload, a changed signature and another key's signature are all refused", () => {
  const token = signLicense(claims(), "k1", keys.privateKeyPem);
  const [prefix, kid, payload, sig] = token.split(".") as [string, string, string, string];

  // Same signature over a payload that now says enterprise.
  const forged = Buffer.from(JSON.stringify(claims({ plan: "enterprise" })), "utf8").toString("base64url");
  const swapped = verifyLicense(`${prefix}.${kid}.${forged}.${sig}`, PUBLIC);
  assert.equal(swapped.ok, false);
  assert.equal(!swapped.ok && swapped.reason, "bad-signature");

  // One character of the signature changed.
  const flipped = sig.slice(0, -2) + (sig.endsWith("A") ? "B" : "A") + sig.slice(-1);
  assert.equal(verifyLicense(`${prefix}.${kid}.${payload}.${flipped}`, PUBLIC).ok, false);

  // Signed by a key the build does not trust, claiming to be k1.
  const foreign = signLicense(claims(), "k1", other.privateKeyPem);
  const res = verifyLicense(foreign, PUBLIC);
  assert.equal(!res.ok && res.reason, "bad-signature");
});

test("a key id the build does not hold is unknown-key, and says so", () => {
  const token = signLicense(claims(), "k2", keys.privateKeyPem);
  const res = verifyLicense(token, PUBLIC);
  assert.equal(res.ok, false);
  assert.equal(!res.ok && res.reason, "unknown-key");
  assert.match(!res.ok ? res.detail : "", /'k2'/);
});

test("a build with no keys accepts nothing: the source tree ships without a vendor key", () => {
  const token = signLicense(claims(), "k1", keys.privateKeyPem);
  const res = verifyLicense(token, {});
  assert.equal(!res.ok && res.reason, "unknown-key");
});

test("a newer format is reported as newer, not as garbage", () => {
  const res = verifyLicense("AML2.k1.e30.AAAA", PUBLIC);
  assert.equal(!res.ok && res.reason, "unsupported-version");
});

test("checking never throws, whatever it is given", () => {
  const junk: unknown[] = ["", " ", "AML1", "AML1.k1", "AML1.k1.x", "AML1.k1.x.y", "a.b.c.d", "AML1..e30.AAAA", "AML1.k1.e30.", "AML1.k 1.e30.AAAA", "\u0000", "AML1.k1.!!!.@@@", "x".repeat(10_000), undefined, null, 42, {}];
  for (const j of junk) {
    const res = verifyLicense(j as string, PUBLIC);
    assert.equal(res.ok, false, `accepted ${JSON.stringify(j)?.slice(0, 40)}`);
  }
});

test("a validly signed payload that is not a licence is bad-claims, not accepted", () => {
  // Sign arbitrary JSON the way the tool would, bypassing signLicense's own check.
  const { createPrivateKey, sign } = require("crypto") as typeof import("crypto");
  const forgeToken = (body: string): string => {
    const input = `${LICENSE_PREFIX}.k1.${Buffer.from(body, "utf8").toString("base64url")}`;
    return `${input}.${sign(null, Buffer.from(input, "ascii"), createPrivateKey(keys.privateKeyPem)).toString("base64url")}`;
  };
  for (const body of ["not json", "[]", "null", JSON.stringify({ v: 2 }), JSON.stringify({ ...claims(), plan: "platinum" }), JSON.stringify({ ...claims(), expiresAt: "2020-01-01T00:00:00Z" })]) {
    const res = verifyLicense(forgeToken(body), PUBLIC);
    assert.equal(res.ok, false, body);
    assert.equal(!res.ok && res.reason, "bad-claims", body);
  }
});

test("claims are checked field by field, with a message that names the field", () => {
  const cases: Array<[Partial<LicenseClaims> | Record<string, unknown>, RegExp]> = [
    [{ id: "" }, /id is missing/],
    [{ customer: "  " }, /customer is missing/],
    [{ plan: "gold" as never }, /plan 'gold'/],
    [{ issuedAt: "yesterday" }, /issuedAt is not a date/],
    [{ expiresAt: "soon" }, /expiresAt is not a date/],
    [{ expiresAt: "2026-09-30T00:00:00Z" }, /not after issuedAt/],
    [{ graceDays: -1 }, /graceDays/],
    [{ graceDays: 91 }, /graceDays/],
    [{ graceDays: 1.5 }, /graceDays/],
    [{ limits: { maxProjects: -3 } }, /limits.maxProjects/],
    [{ limits: { maxProjects: 1.5 } }, /limits.maxProjects/],
    [{ limits: { maxPirates: 3 } as never }, /limits.maxPirates is not a limit/],
    [{ limits: [] as never }, /limits is not an object/],
    [{ features: ["teleport"] as never }, /features/],
    [{ notes: 7 as never }, /notes/],
  ];
  for (const [over, expected] of cases) {
    const problem = claimsProblem({ ...claims(), ...over });
    assert.match(problem ?? "(accepted)", expected, JSON.stringify(over));
  }
  assert.equal(claimsProblem(claims({ limits: { maxSeatsPerMesh: null, maxProjects: 0 } })), null, "null (unlimited) and 0 are both legal limits");
  assert.equal(claimsProblem("claims"), "claims are not an object");
});

test("signing refuses claims that would not verify, so a bad licence is never issued", () => {
  assert.throws(() => signLicense(claims({ plan: "gold" as never }), "k1", keys.privateKeyPem), /refusing to sign: plan 'gold'/);
  assert.throws(() => signLicense(claims(), "bad kid!", keys.privateKeyPem), /key id/);
  assert.throws(() => signLicense(claims(), "k".repeat(33), keys.privateKeyPem), /key id/);
});

test("the default grace period is the one the documentation states", () => {
  assert.equal(DEFAULT_GRACE_DAYS, 14);
});
