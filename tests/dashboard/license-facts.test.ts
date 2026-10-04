import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

import {
  ENFORCEMENTS,
  EXPIRY_WARNING_DAYS,
  LICENSE_REREAD_SECONDS,
  OFFLINE_NOTE,
  RUN_WHERE,
  STATUSES,
  bannerOf,
  daysUntil,
  enforcementSentence,
  expiryOf,
  featureName,
  headline,
  inUseOf,
  isOver,
  limitRows,
  nextSteps,
  planName,
  problemsOf,
  stateOf,
  whereFound,
  type Enforcement,
  type InUse,
  type LicenseView,
} from "../../apps/mesh-dashboard/src/license-facts";
import { EXPIRY_WARNING_DAYS as HOST_WARNING_DAYS, generateLicenseKeyPair, resolveEntitlements, signLicense, type LicenseClaims } from "../../packages/licensing/src/index";

/**
 * What the plan card and the licence banner say. Every state is built the way the host builds it, with a real signed key, a real
 * clock and the host's own `resolveEntitlements`, so the shapes here are the ones `/api/license` sends and a change in the
 * licensing package that moves a field fails here.
 */

const root = path.resolve(__dirname, "..", "..", "..");
const read = (...p: string[]): string => fs.readFileSync(path.join(root, ...p), "utf8");

const keys = generateLicenseKeyPair();
const PUBLIC = { k1: keys.publicKey };
const NOW = new Date("2027-01-15T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (days: number): string => new Date(NOW.getTime() + days * DAY).toISOString();
const token = (over: Partial<LicenseClaims> = {}): string =>
  signLicense({ v: 1, id: "lic_42", customer: "Acme Robotics", plan: "team", issuedAt: at(-300), expiresAt: at(200), ...over }, "k1", keys.privateKeyPem);

function view(tok: string | undefined, enforcement: Enforcement = "warn", usage: Record<string, number> = { registered: 1, open: 1 }, source?: string): LicenseView {
  const ent = resolveEntitlements({ token: tok, publicKeys: PUBLIC, now: NOW, enforcement });
  return { ...ent, ...(source ? { source } : {}), usage } as unknown as LicenseView;
}
const use = (o: Partial<InUse> = {}): InUse => ({ open: 1, registered: 1, seats: 5, turns: 0, ...o });

const COMMUNITY = view(undefined);
const VALID = view(token());
const SOON = view(token({ expiresAt: at(20) }));
const GRACE = view(token({ expiresAt: at(-3) }));
const EXPIRED = view(token({ expiresAt: at(-20) }));
const INVALID = view("AML1.k1.not-a-licence");

test("the statuses, enforcement modes and plan names are the licensing package's", () => {
  const ent = read("packages", "licensing", "src", "entitlements.ts");
  const union = (name: string): string[] => {
    const m = new RegExp(`export type ${name} = ([^;]+);`).exec(ent);
    assert.ok(m, `${name} is where this test expects it`);
    return m![1]!.split("|").map((s) => s.trim().replace(/"/g, ""));
  };
  assert.deepEqual([...STATUSES].sort(), union("LicenseStatus").sort());
  assert.deepEqual([...ENFORCEMENTS].sort(), union("Enforcement").sort());
  const plans = read("packages", "licensing", "src", "plans.ts");
  const named = [...plans.matchAll(/id: "(\w+)",\s*name: "(\w+)"/g)];
  assert.equal(named.length, 4, "four plans");
  for (const [, id, name] of named) assert.equal(planName(id), name, `${id} is called ${name}`);
  assert.equal(planName("something-new"), "Something-new", "a plan this build has not heard of is shown, not hidden");
  assert.equal(planName(undefined), "");
  const features = /FEATURE_IDS: readonly FeatureId\[\] = \[([^\]]+)\]/.exec(plans);
  assert.ok(features);
  for (const id of features![1]!.split(",").map((s) => s.trim().replace(/"/g, "")).filter(Boolean)) assert.notEqual(featureName(id), id, `${id} has a name a person can read`);
  assert.equal(featureName("future-thing"), "future-thing");
});

test("the numbers and commands the card quotes are the host's", () => {
  assert.equal(EXPIRY_WARNING_DAYS, HOST_WARNING_DAYS);
  assert.match(read("apps", "mesh-server", "src", "license.ts"), new RegExp(`ttlMs \\?\\? ${LICENSE_REREAD_SECONDS}_000`), "the host re-reads its licence this often");
  const doc = read("docs", "commercial", "licensing.md");
  for (const command of ["curule license install", "curule license verify", "curule license remove"]) assert.ok(doc.includes(command), `${command} is documented`);
  assert.match(read("packages", "licensing", "src", "entitlements.ts"), /Install a licence with 'curule license install <key>'/);
  assert.match(RUN_WHERE, /docker compose exec mesh/);
  assert.match(read("docs", "operations.md"), /docker compose exec mesh curule license install <key>/);
  for (const note of [OFFLINE_NOTE]) assert.match(note, new RegExp(`within ${LICENSE_REREAD_SECONDS} seconds`));
});

test("Community with nothing over is a plan, not an error: no banner, nothing to do, and the commands to lift a limit", () => {
  assert.deepEqual(problemsOf(COMMUNITY, use(), NOW), []);
  assert.equal(bannerOf(COMMUNITY, use(), NOW), null);
  assert.deepEqual(stateOf(COMMUNITY, NOW), { label: "No licence", tone: "ok" });
  assert.equal(headline(COMMUNITY), "No licence is needed within these limits.");
  assert.deepEqual(expiryOf(COMMUNITY, NOW), { kind: "none", days: null, text: "No expiry: the Community plan does not lapse." });
  assert.deepEqual(nextSteps(COMMUNITY, use(), NOW), [{ text: "Nothing to do. To lift a limit, install a licence key from your vendor:", command: "curule license install <key>" }]);
  assert.equal(planName(COMMUNITY.plan), "Community");
});

test("a second open project on Community is over the plan, said plainly, and nothing is claimed to be refused under warn", () => {
  const two = use({ open: 2 });
  const l = view(undefined, "warn", { registered: 3, open: 2 });
  const rows = limitRows(l, two);
  const projects = rows.find((r) => r.key === "projects")!;
  assert.deepEqual([projects.allowed, projects.inUse, projects.over, projects.ratio], [1, 2, true, 1]);
  const banner = bannerOf(l, two, NOW)!;
  assert.equal(banner.title, "More projects are open than the plan allows.");
  assert.equal(banner.body, "2 are open; the Community plan allows 1. Nothing is refused.");
  const steps = nextSteps(l, two, NOW);
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.text, "2 projects are open and the Community plan allows 1. Close 1 to be within the plan, or install a licence for a plan with more. Nothing is refused while enforcement is warn.");
  // Under enforce it says what will happen instead.
  const enforced = view(undefined, "enforce", { registered: 3, open: 2 });
  assert.equal(bannerOf(enforced, two, NOW)!.body, "2 are open; the Community plan allows 1.");
  assert.match(nextSteps(enforced, two, NOW)[0]!.text, /A project beyond the limit will not open\.$/);
  // The plan's own state says so, instead of "no licence needed" over a red row.
  assert.equal(isOver(rows), true);
  assert.deepEqual(stateOf(l, NOW, true), { label: "Over a limit", tone: "warn" });
  assert.equal(headline(l, true), "More is in use than the Community plan allows.");
  assert.equal(isOver(limitRows(COMMUNITY, use({ turns: 9 }))), false, "a burst of turns is not over the plan");
  assert.equal(isOver(limitRows(COMMUNITY, use())), false);
  assert.deepEqual(stateOf(VALID, NOW, true), { label: "Over a limit", tone: "warn" });
  assert.deepEqual(stateOf(SOON, NOW, true), { label: "Expiring", tone: "warn" }, "a key about to lapse is said before a limit");
  assert.deepEqual(stateOf(EXPIRED, NOW, true), { label: "Expired", tone: "bad" });
  assert.deepEqual(stateOf(INVALID, NOW, true), { label: "Not accepted", tone: "bad" });
  assert.deepEqual(stateOf(GRACE, NOW, true), { label: "Expired, in grace", tone: "warn" });
  assert.equal(headline(VALID, true), "Licensed to Acme Robotics. More is in use than the plan allows.");
  assert.equal(headline(GRACE, true), "Licensed to Acme Robotics. The licence has expired and is in its grace period. More is in use than the plan allows.");
  assert.equal(headline(EXPIRED, true), "The Team licence has expired, so the Community plan's limits apply. More is in use than the plan allows.");
  assert.equal(headline(INVALID, true), "A licence was found but not accepted, so the Community plan's limits apply. More is in use than the plan allows.");
  // Registered projects are not what the plan limits.
  assert.equal(bannerOf(view(undefined, "warn", { registered: 9, open: 1 }), use({ open: 1, registered: 9 }), NOW), null);
  // Off checks nothing.
  assert.equal(bannerOf(view(undefined, "off", { registered: 3, open: 2 }), two, NOW), null);
});

test("a valid licence far from its end is quiet, and says when it ends", () => {
  assert.deepEqual(stateOf(VALID, NOW), { label: "Valid", tone: "ok" });
  assert.equal(headline(VALID), "Licensed to Acme Robotics.");
  assert.equal(expiryOf(VALID, NOW).kind, "later");
  assert.equal(expiryOf(VALID, NOW).text, "Valid until 3 August 2027.");
  assert.equal(bannerOf(VALID, use(), NOW), null);
  assert.deepEqual(nextSteps(VALID, use(), NOW), [{ text: "Nothing to do before 3 August 2027. To replace the key:", command: "curule license install <key>" }]);
  assert.equal(planName(VALID.plan), "Team");
});

test("twenty days out, the card says so and one banner appears", () => {
  assert.deepEqual(stateOf(SOON, NOW), { label: "Expiring", tone: "warn" });
  assert.deepEqual(expiryOf(SOON, NOW), { kind: "soon", days: 20, text: "Expires on 4 February 2027, in 20 days." });
  const b = bannerOf(SOON, use(), NOW)!;
  assert.equal(b.title, "The licence expires in 20 days.");
  assert.equal(b.body, "Install a renewed key before 4 February 2027 to keep the Team limits.");
  assert.deepEqual(nextSteps(SOON, use(), NOW), [{ text: "Install the renewed key before 4 February 2027 to keep the Team limits.", command: "curule license install <key>" }]);
  const one = view(token({ expiresAt: at(0.5) }));
  assert.equal(bannerOf(one, use(), NOW)!.title, "The licence expires in 1 day.");
  assert.equal(expiryOf(one, NOW).text, "Expires on 16 January 2027, in 1 day.");
});

test("the banner's idea of 'expiring' is the host's: the same days, whatever the hour", () => {
  for (let tenths = 1; tenths <= 400; tenths++) {
    const days = tenths / 10;
    const l = view(token({ expiresAt: at(days) }));
    const host = l.warnings.length > 0;
    assert.equal(expiryOf(l, NOW).kind === "soon", host, `${days} days out`);
    assert.equal(problemsOf(l, use(), NOW).length > 0, host, `${days} days out, banner`);
  }
  assert.equal(daysUntil(at(30), NOW), 30);
  assert.equal(daysUntil(at(30.2), NOW), 31);
  assert.equal(daysUntil(at(-2.5), NOW), -2);
});

test("in the grace period the plan's limits hold, and the card says until when", () => {
  assert.equal(GRACE.status, "grace");
  assert.deepEqual(stateOf(GRACE, NOW), { label: "Expired, in grace", tone: "warn" });
  assert.equal(headline(GRACE), "Licensed to Acme Robotics. The licence has expired and is in its grace period.");
  assert.equal(expiryOf(GRACE, NOW).kind, "grace");
  assert.equal(expiryOf(GRACE, NOW).text, "Expired on 12 January 2027. The Team limits stay in force until 26 January 2027.");
  const b = bannerOf(GRACE, use(), NOW)!;
  assert.deepEqual([b.title, b.body], ["The licence has expired.", "The Team limits stay in force until 26 January 2027."]);
  assert.equal(nextSteps(GRACE, use(), NOW)[0]!.text, "Install a renewed key before 26 January 2027. The Team limits stay in force until then.");
});

test("past the grace period it is Community again, nothing was deleted, and a new key brings the plan back", () => {
  assert.equal(EXPIRED.status, "expired");
  assert.equal(EXPIRED.plan, "community");
  assert.deepEqual(stateOf(EXPIRED, NOW), { label: "Expired", tone: "bad" });
  assert.equal(headline(EXPIRED), "The Team licence has expired, so the Community plan's limits apply.");
  assert.equal(expiryOf(EXPIRED, NOW).text, "Expired on 26 December 2026. Running with the Community plan's limits.");
  const b = bannerOf(EXPIRED, use(), NOW)!;
  assert.deepEqual([b.title, b.body], ["The licence has expired.", "Curule is running with the Community plan's limits. Nothing was deleted."]);
  assert.deepEqual(nextSteps(EXPIRED, use(), NOW), [{ text: "Install a renewed key and the Team plan returns within 30 seconds. Nothing was deleted.", command: "curule license install <key>" }]);
});

test("a key that was found but not accepted says why, and how to check it, replace it or drop it", () => {
  assert.equal(INVALID.status, "invalid");
  assert.deepEqual(stateOf(INVALID, NOW), { label: "Not accepted", tone: "bad" });
  assert.equal(headline(INVALID), "A licence was found but not accepted, so the Community plan's limits apply.");
  assert.equal(expiryOf(INVALID, NOW).text, "No licence is in force.");
  assert.deepEqual([bannerOf(INVALID, use(), NOW)!.title, bannerOf(INVALID, use(), NOW)!.body], ["The licence was not accepted.", "Curule is running with the Community plan's limits."]);
  const steps = nextSteps(INVALID, use(), NOW);
  assert.match(steps[0]!.text, /^Licence not accepted \(/, "the host's own reason comes first");
  assert.deepEqual(steps.slice(1).map((s) => s.command), ["curule license verify <key>", "curule license install <key>", "curule license remove"]);
});

test("with enforcement off nothing is a problem, in any state", () => {
  for (const tok of [undefined, token(), token({ expiresAt: at(20) }), token({ expiresAt: at(-3) }), token({ expiresAt: at(-20) }), "AML1.k1.nope"]) {
    const l = view(tok, "off", { registered: 5, open: 5 });
    assert.deepEqual(problemsOf(l, use({ open: 5 }), NOW), []);
    assert.equal(bannerOf(l, use({ open: 5 }), NOW), null);
  }
  assert.equal(enforcementSentence("off"), "Limits are not checked.");
});

test("several problems fold into one banner whose signature changes when any of them does, so an acknowledged banner stays quiet only for as long as nothing changes", () => {
  const l = view(token({ expiresAt: at(20) }), "warn", { registered: 9, open: 7 });
  const two = bannerOf(l, use({ open: 7 }), NOW)!;
  assert.equal(two.title, "The licence expires in 20 days.");
  assert.equal(two.body, "Install a renewed key before 4 February 2027 to keep the Team limits. 1 more thing needs a look.");
  const again = bannerOf(l, use({ open: 7 }), NOW)!;
  assert.equal(again.signature, two.signature, "stable across polls");
  const tomorrow = new Date(NOW.getTime() + DAY);
  assert.equal(bannerOf(l, use({ open: 7 }), tomorrow)!.signature, two.signature, "a day passing does not make the same expiry a new banner");
  assert.notEqual(bannerOf(l, use({ open: 8 }), NOW)!.signature, two.signature, "another project opening does");
  assert.notEqual(bannerOf(view(token({ expiresAt: at(10) }), "warn", { registered: 1, open: 1 }), use(), NOW)!.signature, bannerOf(SOON, use(), NOW)!.signature, "a different expiry does");
  assert.notEqual(bannerOf(view(token({ expiresAt: at(-5) })), use(), NOW)!.signature, bannerOf(GRACE, use(), NOW)!.signature, "so does a different end to the grace period");
});

test("the limits table reads against what is in use, and says what each number counts", () => {
  const rows = limitRows(VALID, use({ seats: 9, open: 3, turns: 2 }));
  assert.deepEqual(rows.map((r) => [r.key, r.label, r.allowed, r.inUse, r.per, r.over, r.transient]), [
    ["seats", "Seats per mesh", 12, 9, "in this project", false, false],
    ["projects", "Projects open at once", 5, 3, "open now", false, false],
    ["turns", "Concurrent turns", 8, 2, "running now", false, true],
  ]);
  assert.equal(rows[0]!.ratio, 0.75);
  const over = limitRows(COMMUNITY, use({ seats: 12, open: 1, turns: 6 }));
  assert.deepEqual(over.map((r) => r.over), [true, false, true]);
  assert.equal(over[0]!.ratio, 1, "a bar never runs past its track");
  // Seats over is something to do, but not a banner: the host checks it when a mesh starts. Turns come and go.
  assert.deepEqual(problemsOf(COMMUNITY, use({ seats: 12, turns: 6 }), NOW), []);
  assert.match(nextSteps(COMMUNITY, use({ seats: 12 }), NOW)[0]!.text, /^This mesh has 12 seats and the Community plan allows 8 per mesh\. Remove seats from mesh\.yaml, or install a licence for a plan with more\. Nothing is refused while enforcement is warn\.$/);
  assert.deepEqual(nextSteps(COMMUNITY, use({ turns: 6 }), NOW), nextSteps(COMMUNITY, use(), NOW), "a burst of turns is not advice");
  assert.match(nextSteps(view(undefined, "enforce"), use({ seats: 12 }), NOW)[0]!.text, /A mesh beyond the limit will not start\.$/);
  assert.doesNotMatch(nextSteps(view(undefined, "off"), use({ seats: 12 }), NOW)[0]!.text, /Nothing is refused|will not start/, "with enforcement off there is no consequence to state");
  // No limit is no ratio and never over; not measured is not over either.
  const unlimited = limitRows({ ...VALID, limits: { maxSeatsPerMesh: null, maxProjects: null, maxConcurrentTurns: null } }, use({ seats: 500, open: 500, turns: 500 }));
  assert.deepEqual(unlimited.map((r) => [r.allowed, r.over, r.ratio]), [[null, false, null], [null, false, null], [null, false, null]]);
  const unknown = limitRows(COMMUNITY, { open: null, registered: null, seats: null, turns: null });
  assert.deepEqual(unknown.map((r) => [r.inUse, r.over, r.ratio]), [[null, false, null], [null, false, null], [null, false, null]]);
});

test("what is in use is what the host reports and the console sees, with a gap left as a gap", () => {
  assert.deepEqual(inUseOf(COMMUNITY, 6, 2), { open: 1, registered: 1, seats: 6, turns: 2 });
  assert.deepEqual(inUseOf(null, null, null), { open: null, registered: null, seats: null, turns: null });
  assert.deepEqual(inUseOf({ ...COMMUNITY, usage: {} }, 6, null), { open: null, registered: null, seats: 6, turns: null });
  assert.deepEqual(inUseOf({ ...COMMUNITY, usage: { open: 0, registered: 0 } }, null, 0), { open: 0, registered: 0, seats: null, turns: 0 }, "zero is a count, not a gap");
});

test("the seat count is the project's own, from its licence route, and not the status field that counts the seats boot woke", () => {
  const server = read("apps", "mesh-server", "src", "index.ts");
  assert.match(server, /parts\[0\] === "license" && parts\.length === 1 && req\.method === "GET"[\s\S]{0,200}seats: seatsInUse\(\)/, "a mesh reports its seats under /license");
  assert.match(server, /startupActivateCount: config\.startupActivate\.length/, "and this status field counts the seats woken at start, which is not the same number");
  const card = read("apps", "mesh-dashboard", "src", "license.tsx");
  assert.match(card, /\.api\("GET", "\/license"\)/, "the card asks the project");
  assert.ok(!/startupSeats|startupActivateCount/.test(card.replace(/\/\*[\s\S]*?\*\//g, "")), "and does not take the boot count for the seat count");
});

test("where the key is, or where Curule looks", () => {
  assert.deepEqual(whereFound(view(token(), "warn", { registered: 1, open: 1 }, "MESH_LICENSE")), { text: "Read from", code: "MESH_LICENSE" });
  assert.deepEqual(whereFound(view(token(), "warn", { registered: 1, open: 1 }, "/data/home/license.key")), { text: "Read from", code: "/data/home/license.key" });
  assert.match(whereFound(COMMUNITY).text, /^No key is installed\. Curule looks in MESH_LICENSE, then MESH_LICENSE_FILE, then license\.key/);
  assert.equal(whereFound(COMMUNITY).code, undefined);
});

test("enforcement is said as the docs say it", () => {
  assert.equal(enforcementSentence("warn"), "A limit that is exceeded is reported, and nothing is refused. This is the default.");
  assert.equal(enforcementSentence("enforce"), "What the plan does not allow will not start. Nothing that is running is stopped.");
  const doc = read("docs", "commercial", "licensing.md");
  assert.match(doc, /`warn` \(the \*\*default\*\*\)/);
  assert.match(doc, /\*\*Nothing that is running is stopped or touched\.\*\*/);
});

test("nothing here implies an account, a checkout or a sale, and the words are the house voice", () => {
  const texts: string[] = [OFFLINE_NOTE, RUN_WHERE];
  for (const l of [COMMUNITY, VALID, SOON, GRACE, EXPIRED, INVALID, view(undefined, "warn", { registered: 3, open: 2 }), view(undefined, "enforce", { registered: 3, open: 2 })]) {
    const u = use({ open: l.usage.open ?? 1, seats: 12 });
    texts.push(headline(l), expiryOf(l, NOW).text, whereFound(l).text, ...ENFORCEMENTS.map(enforcementSentence));
    for (const n of nextSteps(l, u, NOW)) texts.push(n.text);
    for (const p of problemsOf(l, u, NOW)) texts.push(p.title, p.body);
  }
  const joined = texts.join("\n");
  assert.ok(!/[!]/.test(joined), "no exclamation marks");
  assert.ok(!/\b(revolutionary|seamless|supercharge|unleash|10x|powerful|enterprise-grade|simply|just)\b/i.test(joined), "none of the banned words");
  assert.ok(!/\b(buy|purchase|subscribe|subscription|sign up|sign in to|log in|billing|checkout page|upgrade now)\b/i.test(joined.replace(OFFLINE_NOTE, "")), "no sale");
  assert.match(OFFLINE_NOTE, /no account to sign in to, no checkout in this console, and nothing is sent anywhere/);
  // The old name is spelled out of parts, because the repository's product-name sweep reads this file too.
  const oldName = ["Agent", "Mesh"].join(" ");
  assert.ok(!new RegExp(`${oldName}|open source`, "i").test(joined), "the product is Curule, and it is source-available");
});
