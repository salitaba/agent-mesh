import { test } from "node:test";
import assert from "node:assert/strict";
import { AdminApi, createAdminServer, listen, type Listening } from "../../packages/ai-gateway/src/index";
import { FakeOut, answer, chatBody, rawUpload, rig, spends, type Rig } from "./support";

const TOKEN = "admin-token-0123456789-abcdefgh";

type AdminRig = Omit<Rig, "call"> & { api: AdminApi; call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> };

async function admin(options?: Parameters<typeof rig>[0]): Promise<AdminRig> {
  const r = await rig(options);
  const api = new AdminApi(r.gateway);
  return {
    ...r,
    api,
    async call(method, path, body) {
      const out = await api.handle(method, new URL(path, "http://admin.invalid"), body);
      return { status: out.status, body: out.body as any };
    },
  };
}

test("a key is made with a token that is in that one response and nowhere else, and the token works at the gateway", async () => {
  const a = await admin();
  const made = await a.call("POST", "/admin/keys", { accountId: "globex", workspaceId: "ws-9", label: "main", limits: { rpm: 30, concurrent: 3, dailyCapMicros: 9_000_000 }, models: ["fast", "best"] });
  assert.equal(made.status, 201);
  assert.match(made.body.token, /^curule_vk_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
  assert.equal(made.body.keyId, made.body.token.split("_")[2]);
  assert.deepEqual(
    { ...made.body, token: undefined, keyId: undefined, createdAt: undefined },
    { accountId: "globex", workspaceId: "ws-9", label: "main", limits: { rpm: 30, concurrent: 3, dailyCapMicros: 9_000_000 }, models: ["fast", "best"], token: undefined, keyId: undefined, createdAt: undefined },
  );
  assert.equal("secretHash" in made.body, false);
  assert.equal(a.gateway.authenticate(`Bearer ${made.body.token}`).accountId, "globex");
  const listed = await a.call("GET", "/admin/keys?accountId=globex");
  assert.ok(!JSON.stringify(listed.body).includes(made.body.token), "the token is not shown again");
  assert.ok(!JSON.stringify(listed.body).includes("secretHash"));
});

test("a key request that is wrong is a 400 that says what to change, and makes no key", async () => {
  const a = await admin();
  const before = a.ledger.state.keys.size;
  const bad = async (body: unknown, match: RegExp) => {
    const out = await a.call("POST", "/admin/keys", body);
    assert.equal(out.status, 400, JSON.stringify(body));
    assert.equal(out.body.error.type, "invalid_request_error");
    assert.match(out.body.error.message, match);
  };
  await bad({}, /accountId is required/);
  await bad({ accountId: "" }, /accountId is required/);
  await bad({ accountId: 5 }, /accountId is required/);
  await bad(null, /must be a JSON object/);
  await bad({ accountId: "a b" }, /accountId must be/);
  await bad({ accountId: "a", workspaceId: 7 }, /workspaceId must be text/);
  await bad({ accountId: "a", label: {} }, /label must be text/);
  await bad({ accountId: "a", models: "fast" }, /models must be a list of tier names/);
  await bad({ accountId: "a", models: [5] }, /models must be a list of tier names/);
  await bad({ accountId: "a", models: ["fast", "gpt-9"] }, /models names 'gpt-9', which is not a tier \(tiers: fast, balanced, best\)/);
  await bad({ accountId: "a", models: ["x", "y"] }, /models names 'x', 'y', which are not a tier/);
  await bad({ accountId: "a", limits: [] }, /limits must be an object/);
  await bad({ accountId: "a", limits: { rpm: 0 } }, /rpm must be a whole number from 1 to 1000000/);
  assert.equal(a.ledger.state.keys.size, before);
});

test("keys are listed without their secrets, filtered by account and workspace, oldest first", async () => {
  const a = await admin();
  a.clock.now += 1_000;
  const k2 = await a.call("POST", "/admin/keys", { accountId: "acme", workspaceId: "w2" });
  a.clock.now += 1_000;
  const k3 = await a.call("POST", "/admin/keys", { accountId: "globex", workspaceId: "w3" });
  const all = await a.call("GET", "/admin/keys");
  assert.deepEqual(all.body.keys.map((k: any) => k.keyId), [a.key.keyId, k2.body.keyId, k3.body.keyId]);
  assert.deepEqual((await a.call("GET", "/admin/keys?accountId=acme")).body.keys.map((k: any) => k.keyId), [a.key.keyId, k2.body.keyId]);
  assert.deepEqual((await a.call("GET", "/admin/keys?workspaceId=w3")).body.keys.map((k: any) => k.keyId), [k3.body.keyId]);
  assert.deepEqual((await a.call("GET", "/admin/keys?accountId=acme&workspaceId=w3")).body.keys, []);
  await a.ledger.revokeKey(k2.body.keyId, "closed");
  const revoked = (await a.call("GET", "/admin/keys?workspaceId=w2")).body.keys[0];
  assert.equal(revoked.revokedReason, "closed");
  assert.match(revoked.revokedAt, /^2026-10-05T/);
  // A clock that was set back: the key made after is older by its date, and is listed by its date.
  a.clock.now -= 10_000;
  const k4 = await a.call("POST", "/admin/keys", { accountId: "acme", workspaceId: "w4" });
  assert.deepEqual((await a.call("GET", "/admin/keys")).body.keys.map((k: any) => k.keyId), [k4.body.keyId, a.key.keyId, k2.body.keyId, k3.body.keyId]);
});

test("a key is revoked once, with a reason, and stops working at once; one that does not exist is a 404", async () => {
  const a = await admin();
  const out = await a.call("POST", `/admin/keys/${a.key.keyId}/revoke`, { reason: "workspace deleted" });
  assert.deepEqual(out, { status: 200, body: { keyId: a.key.keyId, status: "revoked" } });
  assert.throws(() => a.gateway.authenticate(`Bearer ${a.token}`), /not valid/);
  assert.equal((await a.call("POST", `/admin/keys/${a.key.keyId}/revoke`, {})).body.status, "already");
  assert.equal(a.ledger.state.keys.get(a.key.keyId)!.revokedReason, "workspace deleted");
  const unknown = await a.call("POST", "/admin/keys/000000000000/revoke", {});
  assert.equal(unknown.status, 404);
  assert.match(unknown.body.error.message, /no key '000000000000'/);
  const bare = await admin();
  assert.equal((await bare.call("POST", `/admin/keys/${bare.key.keyId}/revoke`, undefined)).status, 200, "no body at all is a revoke with no reason");
});

test("credit is granted by id, so a repeat counts once, and the answer carries the new balance", async () => {
  const a = await admin({ credit: 0 });
  const grant = { id: "pay_1", accountId: "acme", bucket: "purchased", amountMicros: 25_000_000, reason: "top-up", reference: "invoice 1" };
  const first = await a.call("POST", "/admin/grants", grant);
  assert.equal(first.status, 200);
  assert.equal(first.body.status, "recorded");
  assert.deepEqual(first.body.balance, { included: 0, purchased: 25_000_000, total: 25_000_000, held: 0, available: 25_000_000 });
  const again = await a.call("POST", "/admin/grants", grant);
  assert.equal(again.body.status, "duplicate");
  assert.equal(again.body.balance.total, 25_000_000, "the repeat added nothing");
  const period = await a.call("POST", "/admin/grants", { id: "period_1", accountId: "acme", bucket: "included", mode: "set", amountMicros: 5_000_000, reason: "plan period" });
  assert.equal(period.body.balance.included, 5_000_000);
  assert.equal(period.body.balance.total, 30_000_000);
  const refund = await a.call("POST", "/admin/grants", { id: "refund_1", accountId: "acme", bucket: "purchased", amountMicros: -10_000_000, reason: "refund" });
  assert.equal(refund.body.balance.purchased, 15_000_000);
  const entry = a.store.entries.find((e) => e.id === "pay_1") as unknown as Record<string, unknown>;
  assert.equal(entry.reference, "invoice 1", "what the payment was, kept with the grant so it can be matched to the invoice");
  assert.equal("reference" in (a.store.entries.find((e) => e.id === "period_1") as unknown as Record<string, unknown>), false, "a grant that was sent without one has none");
  const changed = await a.call("POST", "/admin/grants", { ...grant, amountMicros: 1 });
  assert.equal(changed.status, 409);
  assert.equal(changed.body.error.type, "conflict");
  assert.match(changed.body.error.message, /'pay_1' was already used for a different grant/);
});

test("a grant that is wrong is a 400 that names the field, and changes nothing", async () => {
  const a = await admin({ credit: 0 });
  const ok = { id: "g1", accountId: "acme", bucket: "purchased", amountMicros: 100, reason: "x" };
  const bad = async (over: Record<string, unknown>, match: RegExp) => {
    const out = await a.call("POST", "/admin/grants", { ...ok, ...over });
    assert.equal(out.status, 400, JSON.stringify(over));
    assert.match(out.body.error.message, match);
  };
  await bad({ id: undefined }, /id is required/);
  await bad({ accountId: undefined }, /accountId is required/);
  await bad({ bucket: undefined }, /bucket is required/);
  await bad({ bucket: "gift" }, /bucket must be included or purchased/);
  await bad({ mode: "double" }, /mode must be add or set/);
  await bad({ amountMicros: undefined }, /amountMicros is required, as a whole number/);
  await bad({ amountMicros: "100" }, /amountMicros is required, as a whole number/);
  await bad({ amountMicros: 1.5 }, /whole number of micro-units/);
  await bad({ reason: undefined }, /reason is required/);
  await bad({ reference: 5 }, /reference must be text/);
  assert.equal((await a.call("POST", "/admin/grants", null)).status, 400);
  assert.equal(a.ledger.balance("acme").purchased, 0);
});

test("an account shows its balance by bucket, what calls in flight are holding, what it has been charged and cost, and how many keys it has", async () => {
  const a = await admin({ alpha: answer("x", { usage: { input: 1_000_000, output: 0 } }) });
  await a.call("POST", "/admin/keys", { accountId: "acme" });
  const dead = await a.call("POST", "/admin/keys", { accountId: "acme" });
  await a.ledger.revokeKey(dead.body.keyId);
  await a.call("POST", "/admin/grants", { id: "inc", accountId: "acme", bucket: "included", amountMicros: 2_000_000, reason: "period" });
  await a.gateway.chat(a.key, chatBody({ model: "fast" }), new FakeOut());
  const out = await a.call("GET", "/admin/accounts/acme");
  assert.equal(out.status, 200);
  // 1,000,000 tokens at 1 unit per million is 1 unit of cost, 1.5 charged: from the included credit first.
  assert.deepEqual(out.body, {
    accountId: "acme",
    currency: "USD",
    balance: { included: 500_000, purchased: 100_000_000, total: 100_500_000, held: 0, available: 100_500_000 },
    charged: 1_500_000,
    cost: 1_000_000,
    keys: 2,
  });
  a.gateway.hold("acme", 700_000);
  assert.deepEqual((await a.call("GET", "/admin/accounts/acme")).body.balance, { included: 500_000, purchased: 100_000_000, total: 100_500_000, held: 700_000, available: 99_800_000 });
  const none = await a.call("GET", "/admin/accounts/nobody");
  assert.equal(none.status, 200);
  assert.equal(none.body.balance.total, 0);
  assert.equal(none.body.keys, 0);
  assert.equal((await a.call("GET", `/admin/accounts/${encodeURIComponent("a:b")}`)).body.accountId, "a:b");
});

test("the ledger is read back filtered, newest entries kept, with no secret hash in it", async () => {
  const a = await admin();
  for (let i = 0; i < 6; i++) {
    a.clock.now += 60_000;
    await a.gateway.chat(a.key, chatBody({ model: "fast" }), new FakeOut());
  }
  const globex = await a.account("globex");
  a.clock.now += 60_000;
  await a.gateway.chat(globex.key, chatBody({ model: "fast" }), new FakeOut());
  const spendsOf = async (query: string) => (await a.call("GET", `/admin/ledger?${query}`)).body;
  const all = await spendsOf("type=spend");
  assert.equal(all.matched, 7);
  assert.equal(all.truncated, false);
  assert.deepEqual(all.entries.map((e: any) => e.type), Array(7).fill("spend"));
  const acme = await spendsOf("type=spend&accountId=acme");
  assert.equal(acme.entries.length, 6);
  assert.ok(acme.entries.every((e: any) => e.accountId === "acme"));
  const last3 = await spendsOf("type=spend&accountId=acme&limit=3");
  assert.equal(last3.matched, 6);
  assert.equal(last3.truncated, true);
  assert.deepEqual(last3.entries.map((e: any) => e.id), acme.entries.slice(-3).map((e: any) => e.id), "the three newest, oldest of them first");
  const window = await spendsOf(`type=spend&since=${encodeURIComponent("2026-10-05T12:02:00Z")}&until=${encodeURIComponent("2026-10-05T12:05:00Z")}`);
  assert.deepEqual(window.entries.map((e: any) => e.at), ["2026-10-05T12:02:00.000Z", "2026-10-05T12:03:00.000Z", "2026-10-05T12:04:00.000Z"], "from is included and until is not");
  const keys = await spendsOf("type=key.created");
  assert.ok(keys.entries.length >= 2);
  assert.ok(keys.entries.every((e: any) => !("secretHash" in e)), "no hash leaves the gateway");
  const everything = await spendsOf("limit=1000");
  assert.equal(everything.entries[0].type, "ledger.opened");
});

test("the ledger query refuses what it cannot read", async () => {
  const a = await admin();
  const expected: Record<string, RegExp> = {
    "limit=0": /limit must be a whole number from 1 to 1000/,
    "limit=1001": /limit must be a whole number from 1 to 1000/,
    "limit=x": /limit must be a whole number from 1 to 1000/,
    "limit=1.5": /limit must be a whole number from 1 to 1000/,
    "since=yesterday": /since must be a date, for example 2026-10-05 or 2026-10-05T12:00:00Z/,
    "until=soon": /until must be a date, for example 2026-10-05 or 2026-10-05T12:00:00Z/,
  };
  for (const [query, message] of Object.entries(expected)) {
    const out = await a.call("GET", `/admin/ledger?${query}`);
    assert.equal(out.status, 400, query);
    assert.match(out.body.error.message, message, query);
  }
  assert.equal((await a.call("GET", "/admin/ledger?limit=1000")).status, 200);
  assert.equal((await a.call("GET", "/admin/ledger?limit=1")).status, 200);
});

test("a report adds up what was spent, by account, workspace, model, tier or day, with the margin and the calls that failed or were abandoned", async () => {
  const a = await admin();
  // Direct spends give exact figures and every outcome.
  const base = { keyId: "k", requestId: "", alias: "fast", provider: "alpha", model: "small", priceVersion: "v", usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 }, costMicros: 100, chargeMicros: 150, outcome: "ok" as const, estimated: false, latencyMs: 5 };
  await a.ledger.recordSpend({ ...base, requestId: "r1", accountId: "acme", workspaceId: "w1" });
  await a.ledger.recordSpend({ ...base, requestId: "r2", accountId: "acme", workspaceId: "w2", model: "large", alias: "best", costMicros: 400, chargeMicros: 800 });
  a.clock.now += 86_400_000;
  await a.ledger.recordSpend({ ...base, requestId: "r3", accountId: "globex", outcome: "failed", chargeMicros: 0, estimated: true });
  await a.ledger.recordSpend({ ...base, requestId: "r4", accountId: "globex", workspaceId: "w3", outcome: "aborted", estimated: true });
  const agg = (calls: number, over: Record<string, number>) => ({ calls, failed: 0, aborted: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costMicros: 0, chargeMicros: 0, marginMicros: 0, ...over });
  const byAccount = (await a.call("GET", "/admin/report")).body;
  assert.equal(byAccount.currency, "USD");
  assert.equal(byAccount.groupBy, "account");
  assert.deepEqual(byAccount.groups, [
    { group: "acme", ...agg(2, { input: 20, output: 10, cacheRead: 4, cacheWrite: 2, costMicros: 500, chargeMicros: 950, marginMicros: 450 }) },
    { group: "globex", ...agg(2, { failed: 1, aborted: 1, input: 20, output: 10, cacheRead: 4, cacheWrite: 2, costMicros: 200, chargeMicros: 150, marginMicros: -50 }) },
  ]);
  assert.deepEqual(byAccount.total, agg(4, { failed: 1, aborted: 1, input: 40, output: 20, cacheRead: 8, cacheWrite: 4, costMicros: 700, chargeMicros: 1_100, marginMicros: 400 }));
  assert.deepEqual((await a.call("GET", "/admin/report?groupBy=workspace")).body.groups.map((g: any) => [g.group, g.calls]), [["", 1], ["w1", 1], ["w2", 1], ["w3", 1]]);
  assert.deepEqual((await a.call("GET", "/admin/report?groupBy=model")).body.groups.map((g: any) => [g.group, g.calls]), [["alpha/large", 1], ["alpha/small", 3]]);
  assert.deepEqual((await a.call("GET", "/admin/report?groupBy=alias")).body.groups.map((g: any) => [g.group, g.calls]), [["best", 1], ["fast", 3]]);
  assert.deepEqual((await a.call("GET", "/admin/report?groupBy=day")).body.groups.map((g: any) => [g.group, g.calls]), [["2026-10-05", 2], ["2026-10-06", 2]]);
  assert.deepEqual((await a.call("GET", "/admin/report?accountId=acme")).body.groups.map((g: any) => g.group), ["acme"]);
  assert.deepEqual((await a.call("GET", "/admin/report?workspaceId=w1")).body.total.calls, 1);
  assert.equal((await a.call("GET", `/admin/report?from=${encodeURIComponent("2026-10-06T00:00:00Z")}`)).body.total.calls, 2);
  assert.equal((await a.call("GET", `/admin/report?to=${encodeURIComponent("2026-10-06T00:00:00Z")}`)).body.total.calls, 2);
  assert.equal((await a.call("GET", `/admin/report?from=${encodeURIComponent("2026-10-06T12:00:00Z")}`)).body.total.calls, 2, "from is included: two spends were made at that very moment");
  assert.equal((await a.call("GET", `/admin/report?to=${encodeURIComponent("2026-10-06T12:00:00Z")}`)).body.total.calls, 2, "to is not: those two were made at that moment");
  assert.equal((await a.call("GET", "/admin/report?from=2026-10-05&to=2026-10-07")).body.total.calls, 4);
  assert.equal((await a.call("GET", "/admin/report?groupBy=colour")).status, 400);
  assert.match((await a.call("GET", "/admin/report?from=soon")).body.error.message, /from must be a date, for example 2026-10-05/);
  assert.match((await a.call("GET", "/admin/report?to=never")).body.error.message, /to must be a date, for example 2026-10-05/);
  assert.match((await a.call("GET", "/admin/report?groupBy=colour")).body.error.message, /groupBy must be one of account, workspace, model, alias, day/);
  const empty = (await a.call("GET", "/admin/report?accountId=nobody")).body;
  assert.deepEqual(empty.groups, []);
  assert.equal(empty.total.calls, 0);
});

test("health says whether the ledger can be written, which currency and prices are in use and which tiers exist", async () => {
  const a = await admin();
  assert.deepEqual((await a.call("GET", "/admin/health")).body, { ok: true, writable: true, currency: "USD", priceVersion: "test-1", tiers: ["fast", "balanced", "best"] });
  a.store.failure = new Error("disk full");
  const down = (await a.call("GET", "/admin/health")).body;
  assert.equal(down.ok, false);
  assert.equal(down.writable, false);
});

test("a path that is not an admin route is a 404 and a method that is not allowed is a 405 that says which are", async () => {
  const a = await admin();
  assert.equal((await a.call("GET", "/admin/nothing")).status, 404);
  assert.equal((await a.call("GET", "/v1/models")).status, 404);
  const wrong = await a.call("DELETE", "/admin/keys");
  assert.equal(wrong.status, 405);
  assert.match(wrong.body.error.message, /Use POST or GET for \/admin\/keys/);
  assert.equal((await a.call("GET", "/admin/grants")).status, 405);
  assert.equal((await a.call("POST", "/admin/health")).status, 405);
  assert.equal((await a.call("GET", "/admin/keys/")).status, 200, "a trailing slash is the same route");
});

test("a ledger that cannot be written is a 503 for the call that needed it, and a bug is not hidden", async () => {
  const a = await admin();
  a.store.failure = new Error("disk full");
  const out = await a.call("POST", "/admin/grants", { id: "g", accountId: "acme", bucket: "purchased", amountMicros: 1, reason: "x" });
  assert.equal(out.status, 503);
  assert.equal(out.body.error.type, "ledger_unavailable");
  const original = a.ledger.createKey.bind(a.ledger);
  a.ledger.createKey = async () => {
    throw new TypeError("a bug");
  };
  await assert.rejects(() => a.call("POST", "/admin/keys", { accountId: "acme" }), /a bug/);
  a.ledger.createKey = original;
});

// ---- over HTTP, behind the token ----

async function served(): Promise<{ a: AdminRig; listening: Listening }> {
  const a = await admin();
  const listening = await listen(createAdminServer(a.api, a.gateway, { token: TOKEN, maxBodyBytes: 4_096 }), 0, "127.0.0.1");
  return { a, listening };
}

test("the admin server answers only to its token, before it reads anything, and the same token for every route", async () => {
  const { a, listening } = await served();
  try {
    const url = (p: string) => `${listening.url}${p}`;
    const wrong: Array<Record<string, string>> = [{}, { authorization: "Bearer nope" }, { authorization: `Bearer ${TOKEN}x` }, { authorization: TOKEN }, { authorization: `Basic ${TOKEN}` }, { "x-admin-token": TOKEN }];
    for (const headers of wrong) {
      const res = await fetch(url("/admin/health"), { headers });
      assert.equal(res.status, 401, JSON.stringify(headers));
      assert.equal(res.headers.get("connection"), "close", "the connection is not kept for whatever the caller was about to send");
      assert.equal(((await res.json()) as any).error.type, "invalid_admin_token");
    }
    const ok = await fetch(url("/admin/health"), { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get("x-request-id")!, /^req_/);
    // A workspace's own key is not an admin token.
    assert.equal((await fetch(url("/admin/health"), { headers: { authorization: `Bearer ${a.token}` } })).status, 401);
    assert.equal((await fetch(url("/admin/keys"), { method: "POST", body: "{}", headers: { authorization: "Bearer nope" } })).status, 401);
  } finally {
    await listening.close(0);
  }
});

test("over HTTP a key is made, credited, used and reported, with the JSON the control plane will send", async () => {
  const { a, listening } = await served();
  try {
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
    const made = await fetch(`${listening.url}/admin/keys`, { method: "POST", headers, body: JSON.stringify({ accountId: "newco", workspaceId: "w1" }) });
    assert.equal(made.status, 201);
    const key = (await made.json()) as any;
    const grant = await fetch(`${listening.url}/admin/grants`, { method: "POST", headers, body: JSON.stringify({ id: "pay_1", accountId: "newco", bucket: "purchased", amountMicros: 10_000_000, reason: "first top-up" }) });
    assert.equal(grant.status, 200);
    const out = new FakeOut();
    await a.gateway.chat(a.gateway.authenticate(`Bearer ${key.token}`), chatBody({ model: "fast", stream: false }), out);
    assert.equal(out.completion?.status, 200);
    const report = (await (await fetch(`${listening.url}/admin/report?accountId=newco`, { headers })).json()) as any;
    assert.equal(report.total.calls, 1);
    const account = (await (await fetch(`${listening.url}/admin/accounts/newco`, { headers })).json()) as any;
    assert.equal(account.balance.purchased, 10_000_000 - report.total.chargeMicros);
    assert.equal(spends(a.store).filter((e) => e.accountId === "newco").length, 1);
    const empty = await fetch(`${listening.url}/admin/keys`, { method: "POST", headers, body: "" });
    assert.equal(empty.status, 400, "an empty body is an empty object, which names no account");
    const badJson = await fetch(`${listening.url}/admin/keys`, { method: "POST", headers, body: "{nope" });
    assert.equal(badJson.status, 400);
    assert.equal(((await badJson.json()) as any).error.type, "invalid_json");
    const big = await fetch(`${listening.url}/admin/keys`, { method: "POST", headers, body: JSON.stringify({ accountId: "x".repeat(10_000) }) });
    assert.equal(big.status, 413);
    assert.equal(big.headers.get("connection"), "close", "an upload that was refused is not waited for");
    const revoke = await fetch(`${listening.url}/admin/keys/${key.keyId}/revoke`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(revoke.status, 200, "a POST with no body is an empty object, which is a revoke with no reason");
    assert.deepEqual(await revoke.json(), { keyId: key.keyId, status: "revoked" });
  } finally {
    await listening.close(0);
  }
});

test("an admin token that is too short is refused when the server is made, because it would be guessed", async () => {
  const a = await admin();
  assert.throws(() => createAdminServer(a.api, a.gateway, { token: "short" }), /at least 24 characters/);
  assert.doesNotThrow(() => createAdminServer(a.api, a.gateway, { token: "x".repeat(24) }));
});

test("a failure the admin API did not expect is a plain 500 that tells the caller nothing about itself, with a request id, and the operator's log has the reason", async () => {
  const { a, listening } = await served();
  try {
    a.api.handle = async () => {
      throw new Error("secret detail: db password hunter2");
    };
    const res = await fetch(`${listening.url}/admin/health`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 500);
    assert.match(res.headers.get("x-request-id")!, /^req_/);
    const text = await res.text();
    assert.ok(!text.includes("hunter2"));
    assert.deepEqual(JSON.parse(text).error, { message: "The server failed to handle this request.", type: "internal_error", code: "internal_error", param: null });
    const logged = a.logs.find((l) => l.msg === "the admin server failed to handle a request");
    assert.equal(logged?.level, "error");
    assert.match(String(logged?.error), /^Error: secret detail: db password hunter2$/);
  } finally {
    await listening.close(0);
  }
});

test("an admin request that is refused for its token is answered and its connection closed, though the caller has not finished sending", async () => {
  const { listening } = await served();
  try {
    const answer = await rawUpload(listening.url, ["POST /admin/keys HTTP/1.1", "Host: admin.invalid", "Authorization: Bearer nope", "Content-Type: application/json"], "{");
    assert.deepEqual(answer, { status: 401, closedByServer: true });
    const big = await rawUpload(listening.url, ["POST /admin/keys HTTP/1.1", "Host: admin.invalid", `Authorization: Bearer ${TOKEN}`, "Content-Type: application/json"], `{"accountId":"${"x".repeat(5_000)}`);
    assert.deepEqual(big, { status: 413, closedByServer: true });
  } finally {
    await listening.close(0);
  }
});
