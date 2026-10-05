import { test } from "node:test";
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  JsonlLedgerStore,
  Ledger,
  LedgerConflictError,
  LedgerState,
  LedgerUnavailableError,
  MemoryLedgerStore,
  parseToken,
  secretMatches,
  type LedgerEntry,
} from "../../packages/ai-gateway/src/index";

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function clock(start = "2026-10-05T12:00:00.000Z") {
  let t = Date.parse(start);
  return { now: () => new Date(t), advance: (ms: number) => void (t += ms), set: (iso: string) => void (t = Date.parse(iso)) };
}

const spend = (over: Partial<Parameters<Ledger["recordSpend"]>[0]> = {}): Parameters<Ledger["recordSpend"]>[0] => ({
  requestId: "r1",
  accountId: "acme",
  keyId: "k1",
  alias: "balanced",
  provider: "alpha",
  model: "small",
  priceVersion: "v1",
  usage: { ...zero, input: 100, output: 50 },
  costMicros: 1_000,
  chargeMicros: 1_250,
  outcome: "ok",
  estimated: false,
  latencyMs: 400,
  ...over,
});

async function open(c = clock(), store = new MemoryLedgerStore()) {
  const ledger = await Ledger.open(store, { currency: "USD", now: c.now });
  return { ledger, store, c };
}

test("a new ledger begins with a record of its currency, and a ledger of another currency is refused", async () => {
  const { store } = await open();
  assert.equal(store.entries.length, 1);
  assert.equal(store.entries[0]!.type, "ledger.opened");
  await assert.rejects(() => Ledger.open(store, { currency: "EUR" }), /holds USD and the gateway is configured for EUR/);
  const reopened = await Ledger.open(store, { currency: "USD" });
  assert.equal(reopened.state.currency, "USD");
  assert.equal(store.entries.length, 1, "opening an existing ledger writes nothing");
});

test("a ledger that does not begin with its opening record is not used", async () => {
  const store = new MemoryLedgerStore();
  store.entries.push({ id: "g", at: "2026-10-05T00:00:00.000Z", type: "grant", accountId: "a", bucket: "purchased", mode: "add", amountMicros: 5, reason: "x" });
  await assert.rejects(() => Ledger.open(store, { currency: "USD" }), /does not begin with its opening record/);
});

test("a key is created with a token that is shown once, and the ledger holds only a hash that the token verifies against", async () => {
  const { ledger, store } = await open();
  const { keyId, token } = await ledger.createKey({ accountId: "acme", workspaceId: "ws1", label: "workspace key", limits: { rpm: 30, concurrent: 4, dailyCapMicros: 5_000_000 }, models: ["fast", "balanced"] });
  const record = ledger.state.keys.get(keyId)!;
  assert.deepEqual({ ...record, createdAt: undefined, secretHash: undefined }, {
    keyId,
    accountId: "acme",
    workspaceId: "ws1",
    label: "workspace key",
    secretHash: undefined,
    limits: { rpm: 30, concurrent: 4, dailyCapMicros: 5_000_000 },
    models: ["fast", "balanced"],
    createdAt: undefined,
  });
  assert.ok(secretMatches(parseToken(token)!.secret, record.secretHash));
  const text = JSON.stringify(store.entries);
  assert.ok(!text.includes(token) && !text.includes(parseToken(token)!.secret), "the token is in no entry");
});

test("a key's limits are checked: whole numbers in range, or the key is not made", async () => {
  const { ledger, store } = await open();
  for (const limits of [{ rpm: 0 }, { rpm: 1.5 }, { rpm: -1 }, { rpm: 1_000_001 }, { concurrent: 0 }, { concurrent: 100_001 }, { dailyCapMicros: 0 }, { dailyCapMicros: 1e13 }, { rpm: "30" as never }]) {
    await assert.rejects(() => ledger.createKey({ accountId: "acme", limits }), RangeError, JSON.stringify(limits));
  }
  await assert.rejects(() => ledger.createKey({ accountId: "bad id" }), /accountId must be/);
  await assert.rejects(() => ledger.createKey({ accountId: "acme", workspaceId: "a/b" }), /workspaceId must be/);
  await assert.rejects(() => ledger.createKey({ accountId: "acme", models: [""] }), /models must be/);
  assert.equal(store.entries.filter((e) => e.type === "key.created").length, 0, "nothing was recorded for a refused key");
  // The largest value of each limit is allowed.
  const edge = await ledger.createKey({ accountId: "acme", limits: { rpm: 1_000_000, concurrent: 100_000, dailyCapMicros: 1_000_000_000_000 } });
  assert.deepEqual(ledger.state.keys.get(edge.keyId)!.limits, { rpm: 1_000_000, concurrent: 100_000, dailyCapMicros: 1_000_000_000_000 });
  const smallest = await ledger.createKey({ accountId: "acme", limits: { rpm: 1, concurrent: 1, dailyCapMicros: 1 } });
  assert.deepEqual(ledger.state.keys.get(smallest.keyId)!.limits, { rpm: 1, concurrent: 1, dailyCapMicros: 1 });
  // Free text is kept to a length a ledger line can carry.
  const long = await ledger.createKey({ accountId: "acme", label: "x".repeat(500) });
  assert.equal(ledger.state.keys.get(long.keyId)!.label!.length, 120);
});

test("a key can be revoked once, and the record says when and why", async () => {
  const { ledger, c } = await open();
  const { keyId } = await ledger.createKey({ accountId: "acme" });
  c.advance(60_000);
  assert.equal(await ledger.revokeKey(keyId, "workspace deleted"), "revoked");
  const k = ledger.state.keys.get(keyId)!;
  assert.equal(k.revokedAt, "2026-10-05T12:01:00.000Z");
  assert.equal(k.revokedReason, "workspace deleted");
  c.advance(60_000);
  assert.equal(await ledger.revokeKey(keyId, "again"), "already");
  assert.equal(ledger.state.keys.get(keyId)!.revokedAt, "2026-10-05T12:01:00.000Z", "the first revocation stands");
  assert.equal(ledger.state.keys.get(keyId)!.revokedReason, "workspace deleted");
  assert.equal(await ledger.revokeKey("nope"), "unknown");
});

test("credit is granted into two buckets, added to or replaced, and a grant sent twice counts once", async () => {
  const { ledger, store } = await open();
  assert.equal(await ledger.grant({ id: "g1", accountId: "acme", bucket: "included", amountMicros: 5_000_000, reason: "plan period" }), "recorded");
  assert.equal(await ledger.grant({ id: "g2", accountId: "acme", bucket: "purchased", amountMicros: 20_000_000, reason: "top-up", reference: "pay_1" }), "recorded");
  assert.deepEqual(ledger.balance("acme"), { included: 5_000_000, purchased: 20_000_000, charged: 0, cost: 0 });
  assert.equal(await ledger.grant({ id: "g1", accountId: "acme", bucket: "included", amountMicros: 5_000_000, reason: "plan period" }), "duplicate");
  assert.equal(ledger.balance("acme").included, 5_000_000);
  assert.equal(store.entries.filter((e) => e.type === "grant").length, 2, "the repeat wrote nothing");
  // A new period replaces the included bucket: what was left is gone.
  await ledger.grant({ id: "g3", accountId: "acme", bucket: "included", mode: "set", amountMicros: 7_000_000, reason: "next period" });
  assert.equal(ledger.balance("acme").included, 7_000_000);
  // Credit that was refunded is taken back with a negative add.
  await ledger.grant({ id: "g4", accountId: "acme", bucket: "purchased", amountMicros: -4_000_000, reason: "refund" });
  assert.equal(ledger.balance("acme").purchased, 16_000_000);
  assert.equal(ledger.balance("other").purchased, 0, "accounts are separate");
});

test("a grant id reused for a different grant is refused, and so are grants that are not well formed", async () => {
  const { ledger } = await open();
  await ledger.grant({ id: "g1", accountId: "acme", bucket: "purchased", amountMicros: 100, reason: "x" });
  for (const other of [
    { accountId: "other", bucket: "purchased" as const, amountMicros: 100 },
    { accountId: "acme", bucket: "included" as const, amountMicros: 100 },
    { accountId: "acme", bucket: "purchased" as const, amountMicros: 101 },
    { accountId: "acme", bucket: "purchased" as const, amountMicros: 100, mode: "set" as const },
  ]) {
    await assert.rejects(() => ledger.grant({ id: "g1", reason: "x", ...other }), LedgerConflictError, JSON.stringify(other));
  }
  const ok = { id: "g9", accountId: "acme", bucket: "purchased" as const, amountMicros: 1, reason: "r" };
  await assert.rejects(() => ledger.grant({ ...ok, id: "bad id" }), /id must be/);
  await assert.rejects(() => ledger.grant({ ...ok, accountId: "" }), /accountId must be/);
  await assert.rejects(() => ledger.grant({ ...ok, bucket: "other" as never }), /bucket must be/);
  await assert.rejects(() => ledger.grant({ ...ok, mode: "multiply" as never }), /mode must be/);
  await assert.rejects(() => ledger.grant({ ...ok, amountMicros: 1.5 }), /whole number of micro-units/);
  await assert.rejects(() => ledger.grant({ ...ok, amountMicros: 2_000_000_000_000 }), /whole number of micro-units/);
  await assert.rejects(() => ledger.grant({ ...ok, amountMicros: -1, mode: "set" }), /cannot be set below zero/);
  await assert.rejects(() => ledger.grant({ ...ok, reason: " " }), /needs a reason/);
  assert.equal(ledger.state.grants.has("g9"), false, "none of them was recorded");
  await ledger.grant({ ...ok, reason: "r".repeat(500), reference: "p".repeat(500) });
  const entry = (ledger as unknown as { store: MemoryLedgerStore }).store.entries.at(-1) as Extract<LedgerEntry, { type: "grant" }>;
  assert.equal(entry.reason.length, 200);
  assert.equal(entry.reference!.length, 200);
  await ledger.grant({ ...ok, id: "g10", amountMicros: 1_000_000_000_000 });
  await ledger.grant({ ...ok, id: "g11", amountMicros: -1_000_000_000_000 });
});

test("a spend draws on included credit first and then on what was bought, and may overdraw by the call that crossed zero", async () => {
  const { ledger } = await open();
  await ledger.grant({ id: "g1", accountId: "acme", bucket: "included", amountMicros: 1_000, reason: "period" });
  await ledger.grant({ id: "g2", accountId: "acme", bucket: "purchased", amountMicros: 2_000, reason: "top-up" });
  await ledger.recordSpend(spend({ requestId: "a", chargeMicros: 600, costMicros: 400 }));
  assert.deepEqual(ledger.balance("acme"), { included: 400, purchased: 2_000, charged: 600, cost: 400 });
  await ledger.recordSpend(spend({ requestId: "b", chargeMicros: 1_000, costMicros: 800 }));
  assert.deepEqual(ledger.balance("acme"), { included: 0, purchased: 1_400, charged: 1_600, cost: 1_200 });
  await ledger.recordSpend(spend({ requestId: "c", chargeMicros: 2_000, costMicros: 1_500 }));
  assert.deepEqual(ledger.balance("acme"), { included: 0, purchased: -600, charged: 3_600, cost: 2_700 }, "the account is overdrawn, and the included bucket never goes below zero");
});

test("a spend on an account with nothing draws nothing from a negative included bucket", async () => {
  const { ledger } = await open();
  await ledger.recordSpend(spend({ chargeMicros: 500 }));
  assert.deepEqual(ledger.balance("acme"), { included: 0, purchased: -500, charged: 500, cost: 1_000 });
});

test("credit taken back from the included bucket leaves it negative, and a spend does not draw on a negative bucket", async () => {
  const { ledger } = await open();
  await ledger.grant({ id: "g1", accountId: "acme", bucket: "purchased", amountMicros: 1_000, reason: "top-up" });
  await ledger.grant({ id: "g2", accountId: "acme", bucket: "included", amountMicros: -500, reason: "correction" });
  await ledger.recordSpend(spend({ chargeMicros: 300, costMicros: 200 }));
  assert.deepEqual(ledger.balance("acme"), { included: -500, purchased: 700, charged: 300, cost: 200 });
});

test("what a key was charged is kept by UTC day: it adds up within a day and starts again on the next", async () => {
  const { ledger, c } = await open(clock("2026-10-05T10:30:00.000Z"));
  await ledger.recordSpend(spend({ requestId: "a", chargeMicros: 100 }));
  await ledger.recordSpend(spend({ requestId: "other-key", keyId: "k2", chargeMicros: 7 }));
  c.advance(6 * 3_600_000);
  await ledger.recordSpend(spend({ requestId: "b", chargeMicros: 200 }));
  assert.deepEqual(ledger.state.daily.get("k1"), { day: "2026-10-05", charged: 300 }, "a later hour of the same day adds to it");
  assert.deepEqual(ledger.state.daily.get("k2"), { day: "2026-10-05", charged: 7 });
  c.advance(8 * 3_600_000);
  await ledger.recordSpend(spend({ requestId: "c", chargeMicros: 50 }));
  assert.deepEqual(ledger.state.daily.get("k1"), { day: "2026-10-06", charged: 50 });
  assert.deepEqual(ledger.state.daily.get("k2"), { day: "2026-10-05", charged: 7 }, "a key that did not spend is not reset by another's");
});

test("a replayed duplicate of a revocation or an opening record changes nothing: the first stands", () => {
  const state = new LedgerState();
  state.apply({ id: "o1", at: "2026-10-05T00:00:00.000Z", type: "ledger.opened", currency: "USD" });
  state.apply({ id: "o2", at: "2026-10-05T00:00:01.000Z", type: "ledger.opened", currency: "EUR" });
  assert.equal(state.currency, "USD");
  state.apply({ id: "c1", at: "2026-10-05T00:00:02.000Z", type: "key.created", keyId: "k1", accountId: "a", secretHash: "h", limits: {} });
  state.apply({ id: "r1", at: "2026-10-05T00:00:03.000Z", type: "key.revoked", keyId: "k1", reason: "first" });
  state.apply({ id: "r2", at: "2026-10-05T00:00:04.000Z", type: "key.revoked", keyId: "k1", reason: "second" });
  assert.equal(state.keys.get("k1")!.revokedAt, "2026-10-05T00:00:03.000Z");
  assert.equal(state.keys.get("k1")!.revokedReason, "first");
  state.apply({ id: "r3", at: "2026-10-05T00:00:05.000Z", type: "key.revoked", keyId: "unknown" });
  assert.equal(state.keys.size, 1, "revoking a key that was never made makes nothing");
});

test("a write is visible in memory at once, before the disk has said it is durable", async () => {
  const store = new MemoryLedgerStore();
  const ledger = await Ledger.open(store, { currency: "USD" });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const append = store.append.bind(store);
  store.append = async (e) => {
    await gate;
    return append(e);
  };
  const pending = ledger.grant({ id: "g1", accountId: "acme", bucket: "purchased", amountMicros: 42, reason: "x" });
  assert.equal(ledger.balance("acme").purchased, 42, "the next check sees the grant while the write is still in flight");
  assert.equal(store.entries.length, 1, "and the store has not been given it yet");
  release();
  await pending;
  assert.equal(store.entries.length, 2);
});

test("a spend is recorded under its request id, and every field a report needs is in it", async () => {
  const { ledger, store } = await open();
  await ledger.recordSpend(spend({ requestId: "req_9", workspaceId: "ws1", modelReported: "small-2026-09", estimated: true, outcome: "aborted", usage: { ...zero, input: 10, output: 5, reasoning: 2 } }));
  const e = store.entries.at(-1) as Extract<LedgerEntry, { type: "spend" }>;
  assert.equal(e.id, "spend_req_9");
  assert.equal(e.type, "spend");
  assert.deepEqual(
    { ...e, at: undefined },
    {
      id: "spend_req_9",
      at: undefined,
      type: "spend",
      requestId: "req_9",
      accountId: "acme",
      keyId: "k1",
      workspaceId: "ws1",
      alias: "balanced",
      provider: "alpha",
      model: "small",
      modelReported: "small-2026-09",
      priceVersion: "v1",
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 2 },
      costMicros: 1_000,
      chargeMicros: 1_250,
      outcome: "aborted",
      estimated: true,
      latencyMs: 400,
    },
  );
});

test("replaying the entries gives back the same state to the micro-unit", async () => {
  const { ledger, store, c } = await open();
  const a = await ledger.createKey({ accountId: "acme", workspaceId: "ws1", limits: { rpm: 10 } });
  const b = await ledger.createKey({ accountId: "globex" });
  await ledger.grant({ id: "g1", accountId: "acme", bucket: "included", amountMicros: 3_000, reason: "p" });
  await ledger.grant({ id: "g2", accountId: "acme", bucket: "purchased", amountMicros: 9_000, reason: "t" });
  await ledger.grant({ id: "g3", accountId: "globex", bucket: "purchased", amountMicros: 500, reason: "t" });
  for (let i = 0; i < 20; i++) {
    c.advance(30 * 60_000);
    await ledger.recordSpend(spend({ requestId: `r${i}`, accountId: i % 3 === 0 ? "globex" : "acme", keyId: i % 3 === 0 ? b.keyId : a.keyId, chargeMicros: 37 * (i + 1), costMicros: 29 * (i + 1) }));
  }
  await ledger.grant({ id: "g4", accountId: "acme", bucket: "included", mode: "set", amountMicros: 1_000, reason: "next period" });
  await ledger.revokeKey(b.keyId, "closed");
  const again = await Ledger.open(store, { currency: "USD", now: c.now });
  assert.deepEqual([...again.state.accounts], [...ledger.state.accounts]);
  assert.deepEqual([...again.state.keys], [...ledger.state.keys]);
  assert.deepEqual([...again.state.daily], [...ledger.state.daily]);
  assert.deepEqual([...again.state.grants], [...ledger.state.grants]);
});

test("a write that fails stops the ledger: nothing more is accepted, and the gateway can see that", async () => {
  const { ledger, store } = await open();
  await ledger.grant({ id: "g1", accountId: "acme", bucket: "purchased", amountMicros: 100, reason: "x" });
  assert.equal(ledger.writable, true);
  store.failure = new Error("disk full");
  assert.equal(ledger.writable, false);
  await assert.rejects(() => ledger.recordSpend(spend()), LedgerUnavailableError);
  await assert.rejects(() => ledger.recordSpend(spend()), /cannot be written \(disk full\)/);
  await assert.rejects(() => ledger.createKey({ accountId: "acme" }), LedgerUnavailableError);
  await assert.rejects(() => ledger.grant({ id: "g2", accountId: "acme", bucket: "purchased", amountMicros: 1, reason: "x" }), LedgerUnavailableError);
  assert.equal(ledger.balance("acme").purchased, 100, "a refused write changes nothing in memory");
  assert.equal(ledger.balance("acme").charged, 0);
});

test("a store that fails during an append is reported as an unavailable ledger", async () => {
  const store = new MemoryLedgerStore();
  const ledger = await Ledger.open(store, { currency: "USD" });
  const original = store.append.bind(store);
  store.append = async (e) => {
    if (e.type === "spend") throw new Error("EIO");
    return original(e);
  };
  await assert.rejects(() => ledger.recordSpend(spend()), (err: Error) => err instanceof LedgerUnavailableError && /EIO/.test(err.message));
});

// ---- the file ----

function tmp(): { dir: string; file: string; done: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ledger-"));
  return { dir, file: path.join(dir, "data", "ledger.jsonl"), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("entries are on disk when the call that made them returns, one JSON object per line, and survive a restart", async () => {
  const t = tmp();
  try {
    const c = clock();
    const store = new JsonlLedgerStore(t.file);
    const ledger = await Ledger.open(store, { currency: "USD", now: c.now });
    const key = await ledger.createKey({ accountId: "acme" });
    await ledger.grant({ id: "g1", accountId: "acme", bucket: "purchased", amountMicros: 5_000, reason: "x" });
    await ledger.recordSpend(spend({ chargeMicros: 1_200 }));
    const lines = fs.readFileSync(t.file, "utf8").split("\n");
    assert.equal(lines.at(-1), "", "the file ends with a newline");
    assert.deepEqual(lines.slice(0, -1).map((l) => (JSON.parse(l) as LedgerEntry).type), ["ledger.opened", "key.created", "grant", "spend"]);
    await ledger.close();
    const store2 = new JsonlLedgerStore(t.file);
    const again = await Ledger.open(store2, { currency: "USD", now: c.now });
    assert.deepEqual(again.balance("acme"), { included: 0, purchased: 3_800, charged: 1_200, cost: 1_000 });
    assert.ok(again.state.keys.has(key.keyId));
    await again.close();
  } finally {
    t.done();
  }
});

test("many appends at once are all written, in order, each one acknowledged", async () => {
  const t = tmp();
  try {
    const ledger = await Ledger.open(new JsonlLedgerStore(t.file), { currency: "USD" });
    await Promise.all(Array.from({ length: 60 }, (_, i) => ledger.recordSpend(spend({ requestId: `r${i}` }))));
    const ids = fs
      .readFileSync(t.file, "utf8")
      .trim()
      .split("\n")
      .slice(1)
      .map((l) => (JSON.parse(l) as LedgerEntry).id);
    assert.deepEqual(ids, Array.from({ length: 60 }, (_, i) => `spend_r${i}`));
    await ledger.close();
  } finally {
    t.done();
  }
});

test("an append cut short by a crash is dropped when the file is opened, so the next append starts on a clean line", async () => {
  const t = tmp();
  try {
    const first = await Ledger.open(new JsonlLedgerStore(t.file), { currency: "USD" });
    // Multi-byte text before and inside the cut: the bytes to drop are counted in bytes, not characters.
    await first.grant({ id: "g1", accountId: "acme", bucket: "purchased", amountMicros: 100, reason: "reçu: café ☕" });
    await first.close();
    fs.appendFileSync(t.file, '{"id":"spend_r1","at":"2026-10-05T12:00:00.000Z","type":"spend","requestId":"r1","accountId":"ac","alias":"é☕');
    const store = new JsonlLedgerStore(t.file);
    const ledger = await Ledger.open(store, { currency: "USD" });
    assert.equal(store.truncatedTailBytes, Buffer.byteLength('{"id":"spend_r1","at":"2026-10-05T12:00:00.000Z","type":"spend","requestId":"r1","accountId":"ac","alias":"é☕'));
    assert.equal(ledger.balance("acme").purchased, 100);
    await ledger.grant({ id: "g2", accountId: "acme", bucket: "purchased", amountMicros: 50, reason: "x" });
    await ledger.close();
    const lines = fs.readFileSync(t.file, "utf8").trim().split("\n");
    assert.equal(lines.length, 3);
    assert.doesNotThrow(() => lines.forEach((l) => JSON.parse(l)));
    const final = await Ledger.open(new JsonlLedgerStore(t.file), { currency: "USD" });
    assert.equal(final.balance("acme").purchased, 150);
    await final.close();
  } finally {
    t.done();
  }
});

test("closing the ledger waits for the writes still in flight", async () => {
  const t = tmp();
  try {
    const ledger = await Ledger.open(new JsonlLedgerStore(t.file), { currency: "USD" });
    void ledger.recordSpend(spend({ requestId: "late" }));
    await ledger.close();
    assert.match(fs.readFileSync(t.file, "utf8"), /spend_late/);
  } finally {
    t.done();
  }
});

test("a last entry that is whole but is missing only its newline is kept, and the line is finished", async () => {
  const t = tmp();
  try {
    const first = await Ledger.open(new JsonlLedgerStore(t.file), { currency: "USD" });
    await first.close();
    const whole: LedgerEntry = { id: "g1", at: "2026-10-05T12:00:00.000Z", type: "grant", accountId: "acme", bucket: "purchased", mode: "add", amountMicros: 77, reason: "x" };
    fs.appendFileSync(t.file, JSON.stringify(whole));
    const store = new JsonlLedgerStore(t.file);
    const ledger = await Ledger.open(store, { currency: "USD" });
    assert.equal(store.truncatedTailBytes, 0);
    assert.equal(ledger.balance("acme").purchased, 77);
    await ledger.grant({ id: "g2", accountId: "acme", bucket: "purchased", amountMicros: 1, reason: "x" });
    await ledger.close();
    assert.equal(fs.readFileSync(t.file, "utf8").trim().split("\n").length, 3);
  } finally {
    t.done();
  }
});

test("a line in the middle that cannot be read is not skipped: the gateway refuses to start, and says which line", async () => {
  const t = tmp();
  try {
    const first = await Ledger.open(new JsonlLedgerStore(t.file), { currency: "USD" });
    await first.grant({ id: "g1", accountId: "acme", bucket: "purchased", amountMicros: 100, reason: "x" });
    await first.close();
    const lines = fs.readFileSync(t.file, "utf8").trim().split("\n");
    lines.splice(1, 0, "{not json");
    fs.writeFileSync(t.file, lines.join("\n") + "\n");
    await assert.rejects(() => Ledger.open(new JsonlLedgerStore(t.file), { currency: "USD" }), /unreadable line \(line 2\); refusing to start rather than skip a record of money/);
    assert.equal(fs.existsSync(`${t.file}.lock`), false, "a ledger that failed to open does not stay locked");
  } finally {
    t.done();
  }
});

test("one process writes a ledger at a time: a second open is refused while the first holds it, and allowed after it closes", async () => {
  const t = tmp();
  try {
    const store = new JsonlLedgerStore(t.file);
    const ledger = await Ledger.open(store, { currency: "USD" });
    await assert.rejects(() => Ledger.open(new JsonlLedgerStore(t.file), { currency: "USD" }), new RegExp(`in use by process ${process.pid}`));
    await ledger.close();
    assert.equal(fs.existsSync(`${t.file}.lock`), false);
    const again = await Ledger.open(new JsonlLedgerStore(t.file), { currency: "USD" });
    await again.close();
  } finally {
    t.done();
  }
});

test("closing a store that was refused the lock does not release the lock of the one that holds it", async () => {
  const t = tmp();
  try {
    const holder = new JsonlLedgerStore(t.file);
    await holder.load();
    const refused = new JsonlLedgerStore(t.file);
    await assert.rejects(() => refused.load(), new RegExp(`in use by process ${process.pid}`));
    await refused.close();
    assert.equal(fs.existsSync(`${t.file}.lock`), true, "a start that failed and cleaned up after itself left the running one's lock alone");
    await assert.rejects(() => new JsonlLedgerStore(t.file).load(), /in use by process/);
    await holder.close();
    assert.equal(fs.existsSync(`${t.file}.lock`), false);
    await holder.close();
    assert.equal(fs.existsSync(`${t.file}.lock`), false, "closing twice is harmless");
  } finally {
    t.done();
  }
});

test("a lock left by a process that is gone is taken over, and a lock held by one that is alive is respected", async () => {
  const t = tmp();
  try {
    fs.mkdirSync(path.dirname(t.file), { recursive: true });
    const dead = childProcess.spawnSync(process.execPath, ["-e", "0"]).pid!;
    fs.writeFileSync(`${t.file}.lock`, String(dead));
    const ledger = await Ledger.open(new JsonlLedgerStore(t.file), { currency: "USD" });
    assert.equal(fs.readFileSync(`${t.file}.lock`, "utf8"), String(process.pid), "the lock is ours now");
    await ledger.close();
    fs.writeFileSync(`${t.file}.lock`, String(process.ppid));
    await assert.rejects(() => Ledger.open(new JsonlLedgerStore(t.file), { currency: "USD" }), new RegExp(`in use by process ${process.ppid}.*delete .*ledger\\.jsonl\\.lock`));
    assert.equal(fs.readFileSync(`${t.file}.lock`, "utf8"), String(process.ppid), "a live owner's lock is left alone");
  } finally {
    t.done();
  }
});

test("a lock file with no pid in it is not a live owner", async () => {
  const t = tmp();
  try {
    fs.mkdirSync(path.dirname(t.file), { recursive: true });
    fs.writeFileSync(`${t.file}.lock`, "not a pid");
    const ledger = await Ledger.open(new JsonlLedgerStore(t.file), { currency: "USD" });
    await ledger.close();
  } finally {
    t.done();
  }
});

test("a lock that names this pid but was not taken in this process is left by an earlier life of the pid, and is taken over", async () => {
  const t = tmp();
  try {
    fs.mkdirSync(path.dirname(t.file), { recursive: true });
    fs.writeFileSync(`${t.file}.lock`, String(process.pid));
    const ledger = await Ledger.open(new JsonlLedgerStore(t.file), { currency: "USD" });
    await ledger.close();
  } finally {
    t.done();
  }
});

test("a write that fails on disk stops the ledger for good: what was queued behind it is not written, and a disk that recovers is not trusted", async () => {
  const t = tmp();
  try {
    const store = new JsonlLedgerStore(t.file);
    const ledger = await Ledger.open(store, { currency: "USD" });
    const handle = (store as unknown as { handle: { appendFile: (...args: unknown[]) => Promise<void> } }).handle;
    const real = handle.appendFile.bind(handle);
    let calls = 0;
    handle.appendFile = async (...args) => {
      calls++;
      if (calls === 1) throw new Error("ENOSPC");
      return real(...args);
    };
    const results = await Promise.allSettled([ledger.recordSpend(spend({ requestId: "a" })), ledger.recordSpend(spend({ requestId: "b" }))]);
    assert.ok(results.every((r) => r.status === "rejected" && r.reason instanceof LedgerUnavailableError && /ENOSPC/.test(r.reason.message)), "both were refused, the one queued behind the failure as well");
    assert.equal(calls, 1, "nothing was written after the failed write");
    assert.equal(ledger.writable, false);
    assert.equal(store.failure?.message, "ENOSPC");
    // The disk works again, and the ledger still refuses: memory and the file may no longer agree, so only a restart is safe.
    await assert.rejects(() => ledger.recordSpend(spend({ requestId: "c" })), /ENOSPC/);
    await assert.rejects(() => store.append({ id: "x", at: "2026-10-05T12:00:00.000Z", type: "key.revoked", keyId: "k" }), /ENOSPC/);
    assert.equal(calls, 1);
    assert.doesNotMatch(fs.readFileSync(t.file, "utf8"), /spend_/);
  } finally {
    t.done();
  }
});

test("each batch of appends is synced to the disk before its callers are told, and appends that arrive together share one sync", async () => {
  const t = tmp();
  try {
    const store = new JsonlLedgerStore(t.file);
    const ledger = await Ledger.open(store, { currency: "USD" });
    const handle = (store as unknown as { handle: { sync: () => Promise<void>; appendFile: (...a: unknown[]) => Promise<void> } }).handle;
    const order: string[] = [];
    const sync = handle.sync.bind(handle);
    const append = handle.appendFile.bind(handle);
    handle.sync = async () => {
      order.push("sync");
      return sync();
    };
    handle.appendFile = async (...args) => {
      order.push("write");
      return append(...args);
    };
    await ledger.recordSpend(spend({ requestId: "one" }));
    assert.deepEqual(order, ["write", "sync"], "written, then synced, before the call returned");
    order.length = 0;
    await Promise.all(Array.from({ length: 60 }, (_, i) => ledger.recordSpend(spend({ requestId: `r${i}` }))));
    assert.deepEqual(order, ["write", "sync", "write", "sync"], "the first goes alone and the other fifty-nine go out together");
    await ledger.close();
  } finally {
    t.done();
  }
});

test("a report can read the whole file, including what was appended a moment ago", async () => {
  const t = tmp();
  try {
    const ledger = await Ledger.open(new JsonlLedgerStore(t.file), { currency: "USD" });
    const pending = [ledger.recordSpend(spend({ requestId: "a" })), ledger.recordSpend(spend({ requestId: "b" }))];
    const seen: string[] = [];
    for await (const e of ledger.scan()) seen.push(e.id);
    await Promise.all(pending);
    assert.deepEqual(seen, ["ledger_opened_" + seen[0]!.slice("ledger_opened_".length), "spend_a", "spend_b"]);
    await ledger.close();
  } finally {
    t.done();
  }
});

test("a report that starts while a batch is still going to disk waits for it, so it never misses what a caller has been told is recorded", async () => {
  const t = tmp();
  try {
    const store = new JsonlLedgerStore(t.file);
    const ledger = await Ledger.open(store, { currency: "USD" });
    const handle = (store as unknown as { handle: { appendFile: (...a: unknown[]) => Promise<void> } }).handle;
    const append = handle.appendFile.bind(handle);
    handle.appendFile = async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      return append(...args);
    };
    const pending = ledger.recordSpend(spend({ requestId: "slow" }));
    const seen: string[] = [];
    for await (const e of ledger.scan()) seen.push(e.id);
    assert.ok(seen.includes("spend_slow"), "the entry that was on its way to disk is in the report");
    await pending;
    await ledger.close();
  } finally {
    t.done();
  }
});
