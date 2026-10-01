import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  COMMUNITY,
  PLANS,
  checkFeature,
  checkProjects,
  checkSeats,
  effectiveConcurrentTurns,
  findLicense,
  generateLicenseKeyPair,
  loadEntitlements,
  parseEnforcement,
  resolveEntitlements,
  signLicense,
  type LicenseClaims,
} from "../../packages/licensing/src/index";

/**
 * What an install may do, as a function of its licence, the clock and the enforcement mode.
 * Every state a real install can be in is a test: none, valid, expiring, in grace, expired,
 * forged — and `warn` (the shipped default) never refuses anything.
 */

const keys = generateLicenseKeyPair();
const PUBLIC = { k1: keys.publicKey };
const NOW = new Date("2027-01-15T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (offsetDays: number): string => new Date(NOW.getTime() + offsetDays * DAY).toISOString();

function token(over: Partial<LicenseClaims> = {}): string {
  return signLicense(
    { v: 1, id: "lic_42", customer: "Acme Robotics", plan: "team", issuedAt: at(-300), expiresAt: at(200), ...over },
    "k1",
    keys.privateKeyPem,
  );
}

const resolve = (t: string | undefined, enforcement: "off" | "warn" | "enforce" = "enforce", now: Date = NOW) =>
  resolveEntitlements({ token: t, publicKeys: PUBLIC, now, enforcement });

test("no licence is the Community plan, with no warnings", () => {
  const ent = resolve(undefined);
  assert.equal(ent.status, "community");
  assert.equal(ent.plan, "community");
  assert.deepEqual(ent.limits, COMMUNITY.limits);
  assert.deepEqual(ent.warnings, []);
  assert.match(ent.summary, /^Community plan: 8 seats per mesh, 1 project\(s\), 4 concurrent turns\.$/);
});

test("a valid licence gives its plan's limits and features, and names its holder", () => {
  const ent = resolve(token());
  assert.equal(ent.status, "valid");
  assert.equal(ent.plan, "team");
  assert.deepEqual(ent.limits, PLANS.team.limits);
  assert.deepEqual([...ent.features].sort(), [...PLANS.team.features].sort());
  assert.equal(ent.customer, "Acme Robotics");
  assert.equal(ent.licenseId, "lic_42");
  assert.deepEqual(ent.warnings, []);
  assert.match(ent.summary, /Team licence for Acme Robotics \(lic_42\), valid until 2027-08-03: 12 seats per mesh, 5 project\(s\), 8 concurrent turns\./);
});

test("negotiated limits and features replace the plan's, field by field", () => {
  const ent = resolve(token({ limits: { maxProjects: 40, maxSeatsPerMesh: null }, features: ["prometheus-metrics"] }));
  assert.deepEqual(ent.limits, { maxSeatsPerMesh: null, maxProjects: 40, maxConcurrentTurns: PLANS.team.limits.maxConcurrentTurns });
  const community = resolve(token({ plan: "community", features: ["usage-export"] }));
  assert.deepEqual(community.features, ["usage-export"], "a feature added to a plan that has none");
});

test("a licence inside its last 30 days is valid and says when it ends", () => {
  const ent = resolve(token({ expiresAt: at(12) }));
  assert.equal(ent.status, "valid");
  assert.equal(ent.plan, "team");
  assert.equal(ent.warnings.length, 1);
  assert.match(ent.warnings[0]!, /expires on 2027-01-27 \(12 day\(s\)\)\. Renew it/);
  assert.equal(resolve(token({ expiresAt: at(31) })).warnings.length, 0, "31 days out is not yet worth a warning");
});

test("an expired licence keeps its plan through the grace period, then falls back to Community", () => {
  const justExpired = resolve(token({ expiresAt: at(-3) }));
  assert.equal(justExpired.status, "grace");
  assert.equal(justExpired.plan, "team", "a lapsed card is not an outage");
  assert.match(justExpired.warnings[0]!, /expired on 2027-01-12\. Team limits stay in force until 2027-01-26/);
  assert.equal(justExpired.graceEndsAt, at(-3 + 14));

  const lapsed = resolve(token({ expiresAt: at(-15) }));
  assert.equal(lapsed.status, "expired");
  assert.equal(lapsed.plan, "community");
  assert.equal(lapsed.licensedPlan, "team", "what it was licensed for is still reported");
  assert.deepEqual(lapsed.limits, COMMUNITY.limits);
  assert.deepEqual(lapsed.features, []);
  assert.match(lapsed.warnings[0]!, /expired on 2026-12-31\. Running with the Community plan's limits/);
});

test("graceDays changes the length of the grace period", () => {
  assert.equal(resolve(token({ expiresAt: at(-20), graceDays: 30 })).status, "grace");
  assert.equal(resolve(token({ expiresAt: at(-1), graceDays: 0 })).status, "expired");
});

test("a licence that does not verify is Community, with the reason, and never throws", () => {
  const forged = token().replace(/\.[^.]+$/, ".AAAA");
  const ent = resolve(forged);
  assert.equal(ent.status, "invalid");
  assert.equal(ent.plan, "community");
  assert.match(ent.warnings[0]!, /Licence not accepted \(bad-signature\)/);
  assert.equal(resolve("garbage").status, "invalid");
  assert.equal(resolve(token(), "enforce", NOW).status, "valid");
  assert.equal(resolveEntitlements({ token: token(), publicKeys: {}, now: NOW }).status, "invalid", "a build with no keys accepts no licence");
});

test("seat, project and feature checks: the boundary, and what each message says", () => {
  const community = resolve(undefined);
  assert.deepEqual(checkSeats(community, 8), { ok: true, blocked: false });
  const over = checkSeats(community, 9);
  assert.equal(over.ok, false);
  assert.equal(over.blocked, true);
  assert.match(over.message!, /^This mesh has 9 seats; the Community plan allows 8 per mesh\. Install a licence with 'mesh license install <key>'/);

  assert.deepEqual(checkProjects(community, 1), { ok: true, blocked: false });
  assert.match(checkProjects(community, 2).message!, /Opening this project would make 2 open; the Community plan allows 1\./);

  assert.equal(checkFeature(community, "host", "The multi-project host").ok, false);
  assert.match(checkFeature(community, "host", "The multi-project host").message!, /^The multi-project host is not part of the Community plan\./);
  assert.equal(checkFeature(resolve(token()), "host").ok, true);

  const enterprise = resolve(token({ plan: "enterprise" }));
  assert.equal(checkSeats(enterprise, 10_000).ok, true, "unlimited is unlimited");
  assert.equal(checkProjects(enterprise, 10_000).ok, true);
});

test("warn reports a breach and refuses nothing; off reports nothing", () => {
  const warn = resolve(undefined, "warn");
  const w = checkSeats(warn, 50);
  assert.equal(w.ok, false);
  assert.equal(w.blocked, false, "the shipped default must never stop a mesh");
  assert.ok(w.message);
  const off = resolve(undefined, "off");
  assert.deepEqual(checkSeats(off, 50), { ok: true, blocked: false });
  assert.deepEqual(checkFeature(off, "host"), { ok: true, blocked: false });
  assert.deepEqual(checkProjects(off, 50), { ok: true, blocked: false });
});

test("the plan's turn cap tightens a host only under enforce, and never loosens one", () => {
  const team = resolve(token(), "enforce");
  assert.equal(effectiveConcurrentTurns(team, null), 8);
  assert.equal(effectiveConcurrentTurns(team, 20), 8);
  assert.equal(effectiveConcurrentTurns(team, 3), 3, "the operator's tighter setting stands");
  assert.equal(effectiveConcurrentTurns(resolve(token(), "warn"), 20), 20, "a limit that is only reported is not applied");
  assert.equal(effectiveConcurrentTurns(resolve(token(), "off"), null), null);
  assert.equal(effectiveConcurrentTurns(resolve(token({ plan: "enterprise" }), "enforce"), 5), 5);
  assert.equal(effectiveConcurrentTurns(resolve(token({ plan: "enterprise" }), "enforce"), null), null);
});

test("enforcement is read from the environment, and an unrecognized value falls back to warn", () => {
  assert.equal(parseEnforcement("enforce"), "enforce");
  assert.equal(parseEnforcement(" OFF "), "off");
  assert.equal(parseEnforcement(undefined), "warn");
  assert.equal(parseEnforcement("strict"), "warn", "a typo must not silently turn enforcement on or off");
});

test("a licence is found in MESH_LICENSE, then MESH_LICENSE_FILE, then the home directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-lic-"));
  try {
    assert.equal(findLicense({}, dir), undefined);
    fs.writeFileSync(path.join(dir, "license.key"), "FROM-HOME\n");
    assert.deepEqual(findLicense({}, dir), { token: "FROM-HOME", source: path.join(dir, "license.key") });
    const other = path.join(dir, "elsewhere.key");
    fs.writeFileSync(other, "FROM-FILE");
    assert.equal(findLicense({ MESH_LICENSE_FILE: other }, dir)?.token, "FROM-FILE");
    assert.deepEqual(findLicense({ MESH_LICENSE_FILE: other, MESH_LICENSE: " FROM-ENV " }, dir), { token: "FROM-ENV", source: "MESH_LICENSE" });
    assert.equal(findLicense({ MESH_LICENSE_FILE: path.join(dir, "missing.key") }, dir)?.token, "FROM-HOME", "an unreadable file is skipped");
    fs.writeFileSync(path.join(dir, "license.key"), "  \n");
    assert.equal(findLicense({}, dir), undefined, "an empty file is no licence");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadEntitlements ties it together: file, keys, clock and mode", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-lic-"));
  try {
    fs.writeFileSync(path.join(dir, "license.key"), token({ plan: "business" }));
    const ent = loadEntitlements({ MESH_LICENSE_ENFORCEMENT: "enforce" }, dir, NOW, PUBLIC);
    assert.equal(ent.plan, "business");
    assert.equal(ent.enforcement, "enforce");
    assert.equal(loadEntitlements({}, dir, NOW, PUBLIC).enforcement, "warn");
    assert.equal(loadEntitlements({}, path.join(dir, "nowhere"), NOW, PUBLIC).status, "community");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the plan table is internally consistent: limits only grow, and no plan claims a feature it cannot have", () => {
  const order = ["community", "team", "business", "enterprise"] as const;
  const bounded = (n: number | null): number => (n === null ? Number.POSITIVE_INFINITY : n);
  for (let i = 1; i < order.length; i += 1) {
    const lower = PLANS[order[i - 1]!].limits;
    const higher = PLANS[order[i]!].limits;
    for (const k of ["maxSeatsPerMesh", "maxProjects", "maxConcurrentTurns"] as const) {
      assert.ok(bounded(higher[k]) >= bounded(lower[k]), `${order[i]}.${k} is below ${order[i - 1]}`);
    }
    for (const f of PLANS[order[i - 1]!].features) assert.ok(PLANS[order[i]!].features.includes(f), `${order[i]} dropped ${f}`);
  }
  assert.equal(PLANS.community.priceMonthlyUsd, 0);
  assert.equal(PLANS.enterprise.pricing, "contact");
  for (const id of order) {
    const p = PLANS[id];
    if (p.pricing === "listed") {
      assert.ok(p.priceMonthlyUsd! > 0 && p.priceMonthlyAnnualUsd! > 0 && p.priceMonthlyAnnualUsd! < p.priceMonthlyUsd!, `${id}: annual billing must be cheaper per month`);
    }
  }
});
