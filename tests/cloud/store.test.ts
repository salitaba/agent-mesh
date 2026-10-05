import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ControlLog, ControlState, ControlUnavailableError, JsonlControlStore, MemoryControlStore, type ControlEntry, type ControlEntryBody } from "../../packages/cloud/src/index";

const T0 = "2026-10-05T12:00:00.000Z";
let n = 0;
const entry = (body: ControlEntryBody, at = T0): ControlEntry => ({ id: `e${++n}`, at, ...body }) as ControlEntry;
const replay = (...bodies: Array<[ControlEntryBody, string?]>): ControlState => {
  const state = new ControlState();
  for (const [body, at] of bodies) state.apply(entry(body, at));
  return state;
};
const created: ControlEntryBody = { type: "account.created", accountId: "a1", email: "ada@example.com", passwordHash: "h1" };

test("an account is what its entries add up to: created, then verified once, then given a new password", () => {
  const s = replay([created], [{ type: "account.verified", accountId: "a1" }, "2026-10-05T12:01:00.000Z"], [{ type: "account.verified", accountId: "a1" }, "2026-10-05T12:09:00.000Z"], [{ type: "account.password_changed", accountId: "a1", passwordHash: "h2" }]);
  const a = s.accounts.get("a1")!;
  assert.equal(a.email, "ada@example.com");
  assert.equal(a.createdAt, T0);
  assert.equal(a.verifiedAt, "2026-10-05T12:01:00.000Z", "the first verification stands");
  assert.equal(a.passwordHash, "h2");
  assert.equal(s.byEmail.get("ada@example.com"), "a1");
  assert.deepEqual(a.customers, {});
});

test("entries about an account that does not exist change nothing and do not throw", () => {
  const s = replay(
    [{ type: "account.verified", accountId: "ghost" }],
    [{ type: "account.password_changed", accountId: "ghost", passwordHash: "x" }],
    [{ type: "account.disabled", accountId: "ghost", reason: "x" }],
    [{ type: "account.enabled", accountId: "ghost" }],
    [{ type: "billing.customer_linked", provider: "p", accountId: "ghost", customerRef: "c" }],
    [{ type: "subscription.changed", accountId: "ghost", plan: "team", status: "active", reason: "x" }],
    [{ type: "verification.used", tokenHash: "none" }],
    [{ type: "session.seen", sessionId: "none" }],
    [{ type: "session.revoked", sessionId: "none" }],
    [{ type: "workspace.provisioned", workspaceId: "none", handle: "h", upstream: { host: "h", port: 1 }, gatewayKeyId: "k" }],
    [{ type: "workspace.status", workspaceId: "none", status: "running" }],
    [{ type: "workspace.plan_changed", workspaceId: "none", plan: "team" }],
    [{ type: "owner.action", action: "x", detail: "y" }],
  );
  assert.equal(s.accounts.size, 0);
  assert.equal(s.workspaces.size, 0);
  assert.equal(s.sessions.size, 0);
});

test("an account is stopped and started again by entries, and says why while it is stopped", () => {
  const s = replay([created], [{ type: "account.disabled", accountId: "a1", reason: "abuse report" }, "2026-10-05T12:05:00.000Z"]);
  assert.equal(s.accounts.get("a1")!.disabledAt, "2026-10-05T12:05:00.000Z");
  assert.equal(s.accounts.get("a1")!.disabledReason, "abuse report");
  s.apply(entry({ type: "account.enabled", accountId: "a1" }));
  assert.equal("disabledAt" in s.accounts.get("a1")!, false);
  assert.equal("disabledReason" in s.accounts.get("a1")!, false);
});

test("a link in mail is issued with its purpose and expiry, and is used once", () => {
  const s = replay([{ type: "verification.issued", accountId: "a1", tokenHash: "t1", expiresAt: "2026-10-06T12:00:00.000Z", purpose: "verify" }]);
  assert.deepEqual(s.verifications.get("t1"), { accountId: "a1", expiresAt: "2026-10-06T12:00:00.000Z", used: false, purpose: "verify" });
  s.apply(entry({ type: "verification.used", tokenHash: "t1" }));
  assert.equal(s.verifications.get("t1")!.used, true);
});

test("a session is created, seen, and revoked once; and revoking for an account ends every session of that account and no other", () => {
  const s = replay(
    [{ type: "session.created", sessionId: "s1", accountId: "a1", tokenHash: "th1", expiresAt: "2026-11-04T12:00:00.000Z" }],
    [{ type: "session.created", sessionId: "s2", accountId: "a1", tokenHash: "th2", expiresAt: "2026-11-04T12:00:00.000Z" }],
    [{ type: "session.created", sessionId: "s3", accountId: "a2", tokenHash: "th3", expiresAt: "2026-11-04T12:00:00.000Z" }],
  );
  assert.equal(s.sessionsByToken.get("th1"), "s1");
  assert.equal(s.sessions.get("s1")!.lastSeenAt, T0);
  s.apply(entry({ type: "session.seen", sessionId: "s1" }, "2026-10-05T13:00:00.000Z"));
  assert.equal(s.sessions.get("s1")!.lastSeenAt, "2026-10-05T13:00:00.000Z");
  s.apply(entry({ type: "session.revoked", sessionId: "s1" }, "2026-10-05T14:00:00.000Z"));
  s.apply(entry({ type: "session.revoked", sessionId: "s1" }, "2026-10-05T15:00:00.000Z"));
  assert.equal(s.sessions.get("s1")!.revokedAt, "2026-10-05T14:00:00.000Z", "the first revocation stands");
  s.apply(entry({ type: "sessions.revoked_for", accountId: "a1" }, "2026-10-05T16:00:00.000Z"));
  assert.equal(s.sessions.get("s1")!.revokedAt, "2026-10-05T14:00:00.000Z");
  assert.equal(s.sessions.get("s2")!.revokedAt, "2026-10-05T16:00:00.000Z");
  assert.equal(s.sessions.get("s3")!.revokedAt, undefined, "another account's session is not touched");
});

test("a payment provider's customer is linked to an account, by provider, and found again from the customer", () => {
  const s = replay([created], [{ type: "billing.customer_linked", provider: "hosted-checkout", accountId: "a1", customerRef: "cus_1" }]);
  assert.deepEqual(s.accounts.get("a1")!.customers, { "hosted-checkout": "cus_1" });
  assert.equal(s.customers.get("hosted-checkout:cus_1"), "a1");
  assert.equal(s.customers.get("another:cus_1"), undefined);
});

test("a billing event that was applied is found again by its key, with what it granted", () => {
  const grants = [{ id: "topup:pi_1", bucket: "purchased" as const, mode: "add" as const, amountMicros: 25_000_000 }];
  const s = replay([{ type: "billing.applied", key: "payment.succeeded:pi_1", accountId: "a1", kind: "payment.succeeded", amountMinor: 2_500, currency: "USD", grants }]);
  assert.deepEqual(s.applied.get("payment.succeeded:pi_1")!.grants, grants);
  assert.equal(s.applied.has("payment.succeeded:pi_2"), false);
});

test("a subscription is what its changes add up to: the plan and the period carry over a change that does not name them", () => {
  const s = replay(
    [created],
    [{ type: "subscription.changed", accountId: "a1", plan: "team", status: "active", periodStart: "2026-10-01T00:00:00.000Z", periodEnd: "2026-11-01T00:00:00.000Z", subscriptionRef: "sub_1", reason: "paid" }, "2026-10-01T00:00:00.000Z"],
    [{ type: "subscription.changed", accountId: "a1", status: "past_due", reason: "a payment failed" }, "2026-11-02T00:00:00.000Z"],
  );
  const sub = s.accounts.get("a1")!.subscription!;
  assert.deepEqual(sub, { plan: "team", status: "past_due", periodStart: "2026-10-01T00:00:00.000Z", periodEnd: "2026-11-01T00:00:00.000Z", subscriptionRef: "sub_1", changedAt: "2026-11-02T00:00:00.000Z", pastDueSince: "2026-11-02T00:00:00.000Z" });
});

test("a subscription is past due from the first failure and stays past due from then, and an ended one says when it ended, from the first time", () => {
  const s = replay(
    [created],
    [{ type: "subscription.changed", accountId: "a1", plan: "team", status: "active", reason: "paid" }, "2026-10-01T00:00:00.000Z"],
    [{ type: "subscription.changed", accountId: "a1", status: "past_due", reason: "failed" }, "2026-10-10T00:00:00.000Z"],
    [{ type: "subscription.changed", accountId: "a1", status: "past_due", reason: "failed again" }, "2026-10-12T00:00:00.000Z"],
  );
  assert.equal(s.accounts.get("a1")!.subscription!.pastDueSince, "2026-10-10T00:00:00.000Z");
  s.apply(entry({ type: "subscription.changed", accountId: "a1", status: "active", reason: "paid" }, "2026-10-13T00:00:00.000Z"));
  assert.equal("pastDueSince" in s.accounts.get("a1")!.subscription!, false, "paying puts it right");
  s.apply(entry({ type: "subscription.changed", accountId: "a1", status: "ended", reason: "cancelled" }, "2026-10-20T00:00:00.000Z"));
  s.apply(entry({ type: "subscription.changed", accountId: "a1", status: "ended", reason: "cancelled again" }, "2026-10-25T00:00:00.000Z"));
  assert.equal(s.accounts.get("a1")!.subscription!.endedAt, "2026-10-20T00:00:00.000Z");
});

test("a change to a subscription that never had a plan, and names none, is not a subscription", () => {
  const s = replay([created], [{ type: "subscription.changed", accountId: "a1", status: "past_due", reason: "x" }]);
  assert.equal(s.accounts.get("a1")!.subscription, undefined);
});

test("a workspace is requested, provisioned, changed and destroyed by entries, and its status carries a reason only while it has one", () => {
  const s = replay(
    [{ type: "workspace.requested", workspaceId: "w1", accountId: "a1", name: "Main", slug: "main-abc", plan: "team" }],
    [{ type: "workspace.status", workspaceId: "w1", status: "provisioning" }, "2026-10-05T12:00:01.000Z"],
    [{ type: "workspace.provisioned", workspaceId: "w1", handle: "h1", upstream: { host: "h1", port: 7420 }, gatewayKeyId: "key_1" }],
    [{ type: "workspace.status", workspaceId: "w1", status: "failed", reason: "no capacity" }, "2026-10-05T12:00:02.000Z"],
  );
  const w = s.workspaces.get("w1")!;
  assert.deepEqual({ ...w }, { workspaceId: "w1", accountId: "a1", name: "Main", slug: "main-abc", plan: "team", status: "failed", createdAt: T0, statusAt: "2026-10-05T12:00:02.000Z", statusReason: "no capacity", handle: "h1", upstream: { host: "h1", port: 7420 }, gatewayKeyId: "key_1" });
  assert.equal(s.bySlug.get("main-abc"), "w1");
  s.apply(entry({ type: "workspace.status", workspaceId: "w1", status: "running" }));
  assert.equal("statusReason" in s.workspaces.get("w1")!, false, "the reason goes when the status changes without one");
  s.apply(entry({ type: "workspace.plan_changed", workspaceId: "w1", plan: "business" }));
  assert.equal(s.workspaces.get("w1")!.plan, "business");
});

test("the log appends an entry that is in memory at once, with an id and a time of its own, and a replay of what it wrote gives the same state", async () => {
  const store = new MemoryControlStore();
  let now = Date.parse(T0);
  const log = await ControlLog.open(store, () => new Date(now));
  const first = await log.append(created);
  now += 5_000;
  const second = await log.append({ type: "account.verified", accountId: "a1" });
  assert.match(first.id, /^account_created_[0-9a-f]{16}$/);
  assert.match(second.id, /^account_verified_[0-9a-f]{16}$/);
  assert.notEqual(first.id, second.id);
  assert.equal(first.at, T0);
  assert.equal(second.at, "2026-10-05T12:00:05.000Z");
  assert.equal(log.state.accounts.get("a1")!.verifiedAt, second.at);
  assert.deepEqual(store.entries, [first, second]);
  const again = await ControlLog.open(store);
  assert.deepEqual(again.state.accounts.get("a1"), log.state.accounts.get("a1"));
  assert.deepEqual(await (async () => { const out: ControlEntry[] = []; for await (const e of log.scan()) out.push(e); return out; })(), [first, second]);
});

test("when the log cannot be written the caller is told, and every later change is refused until a restart", async () => {
  const store = new MemoryControlStore();
  const log = await ControlLog.open(store);
  assert.equal(log.writable, true);
  store.failure = new Error("disk full");
  await assert.rejects(() => log.append(created), (err: Error) => err instanceof ControlUnavailableError && err.message === "the control log cannot be written (disk full); the service takes no more changes until it is restarted");
  assert.equal(log.writable, false);
  assert.equal(store.entries.length, 0);
  await assert.rejects(() => log.append({ type: "account.verified", accountId: "a1" }), ControlUnavailableError);
});

test("a store that fails during the write is reported the same way, whatever it threw", async () => {
  const store = new MemoryControlStore();
  const log = await ControlLog.open(store);
  store.append = async () => {
    throw "a string and not an error";
  };
  await assert.rejects(() => log.append(created), /the control log cannot be written \(a string and not an error\)/);
});

test("the log on disk is one JSON object per line that survives a restart, is written by one process at a time, and names itself in what it says", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "control-log-"));
  try {
    const file = path.join(dir, "control.jsonl");
    const store = new JsonlControlStore(file);
    const log = await ControlLog.open(store);
    await log.append(created);
    await log.append({ type: "account.verified", accountId: "a1" });
    await assert.rejects(() => ControlLog.open(new JsonlControlStore(file)), /^Error: the control log .*control\.jsonl is in use by process \d+; one process writes it at a time/);
    await log.close();
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => l.type), ["account.created", "account.verified"]);
    const reopened = await ControlLog.open(new JsonlControlStore(file));
    assert.ok(reopened.state.accounts.get("a1")!.verifiedAt);
    await reopened.close();

    fs.writeFileSync(file, `${JSON.stringify(lines[0])}\nnot json\n${JSON.stringify(lines[1])}\n`);
    await assert.rejects(() => ControlLog.open(new JsonlControlStore(file)), /the control log .* has an unreadable line \(line 2\); refusing to start rather than skip a record of who was given what/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
