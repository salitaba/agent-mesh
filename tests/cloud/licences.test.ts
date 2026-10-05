import { test } from "node:test";
import assert from "node:assert/strict";
import { generateLicenseKeyPair, resolveEntitlements, verifyLicense } from "../../packages/licensing/src/index";
import { mintWorkspaceLicence } from "../../packages/cloud/src/index";

const keys = generateLicenseKeyPair();
const signer = { kid: "k1", privateKey: keys.privateKeyPem };
const now = new Date("2026-10-05T12:00:00.000Z");

test("a workspace's licence names the account it is for and the plan, is signed with the service's key, and is valid for 400 days", () => {
  const { token, claims } = mintWorkspaceLicence({ signer, plan: "team", accountId: "acct_1", workspaceId: "ws_abc", now });
  assert.ok(token.startsWith("AML1.k1."));
  assert.equal(claims.v, 1);
  assert.equal(claims.customer, "acct_1");
  assert.equal(claims.plan, "team");
  assert.equal(claims.issuedAt, "2026-10-05T12:00:00.000Z");
  assert.equal(claims.expiresAt, new Date(now.getTime() + 400 * 86_400_000).toISOString());
  assert.equal(claims.notes, "hosted workspace ws_abc");
  assert.match(claims.id, /^lic_ws_abc_[0-9a-z]+$/);
  const read = verifyLicense(token, { k1: keys.publicKey });
  assert.ok(read.ok);
  assert.deepEqual(read.claims, claims);
});

test("how long a licence lasts, and what it says about itself, can be set; and a licence minted later has an id of its own", () => {
  const a = mintWorkspaceLicence({ signer, plan: "business", accountId: "acct_1", workspaceId: "ws_abc", now, validDays: 30, notes: "pilot" });
  assert.equal(a.claims.expiresAt, new Date(now.getTime() + 30 * 86_400_000).toISOString());
  assert.equal(a.claims.notes, "pilot");
  const b = mintWorkspaceLicence({ signer, plan: "business", accountId: "acct_1", workspaceId: "ws_abc", now: new Date(now.getTime() + 1_000) });
  assert.notEqual(a.claims.id, b.claims.id);
});

test("a licence verifies with the service's public key and with no other, and a workspace that holds it gets the plan's limits", () => {
  const other = generateLicenseKeyPair();
  const { token } = mintWorkspaceLicence({ signer, plan: "team", accountId: "acct_1", workspaceId: "ws_abc", now });
  const wrong = verifyLicense(token, { k1: other.publicKey });
  assert.equal(wrong.ok, false);
  assert.equal(verifyLicense(token, { k2: keys.publicKey }).ok, false, "the key id has to be one the build knows");
  const ent = resolveEntitlements({ token, publicKeys: { k1: keys.publicKey }, now, enforcement: "enforce" });
  assert.equal(ent.status, "valid");
  assert.equal(ent.plan, "team");
  assert.deepEqual(ent.limits, { maxSeatsPerMesh: 12, maxProjects: 5, maxConcurrentTurns: 8 });
  assert.equal(ent.enforcement, "enforce");
  const business = resolveEntitlements({ token: mintWorkspaceLicence({ signer, plan: "business", accountId: "acct_1", workspaceId: "ws_abc", now }).token, publicKeys: { k1: keys.publicKey }, now });
  assert.equal(business.plan, "business");
  assert.equal(business.limits.maxProjects, 25);
});

test("a licence is signed only for a plan and a time that make a licence that verifies", () => {
  assert.throws(() => mintWorkspaceLicence({ signer, plan: "team", accountId: "acct_1", workspaceId: "ws_abc", now, validDays: 0 }), /refusing to sign/);
  assert.throws(() => mintWorkspaceLicence({ signer: { kid: "bad kid!", privateKey: keys.privateKeyPem }, plan: "team", accountId: "acct_1", workspaceId: "ws_abc", now }), /key id/);
});
