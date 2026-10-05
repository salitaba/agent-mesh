import { test } from "node:test";
import assert from "node:assert/strict";
import { AdminApi, createAdminServer, listen } from "../../packages/ai-gateway/src/index";
import { GatewayAdminError, HttpGatewayAdmin, InProcessGatewayAdmin, type GatewayAdmin } from "../../packages/cloud/src/index";
import { rig } from "../ai-gateway/support";

const TOKEN = "admin-token-0123456789-abcdefgh";

async function exercise(client: GatewayAdmin) {
  const key = await client.createKey({ accountId: "acme", workspaceId: "ws-1", label: "main", models: ["fast"], limits: { rpm: 30 } });
  const bare = await client.createKey({ accountId: "acme" });
  const grant = { id: "g1", accountId: "acme", bucket: "purchased" as const, amountMicros: 5_000_000, reason: "top-up", reference: "pi_1" };
  const first = await client.grant(grant);
  const again = await client.grant(grant);
  const set = await client.grant({ id: "g2", accountId: "acme", bucket: "included", mode: "set", amountMicros: 2_000_000, reason: "period" });
  const account = await client.account("acme");
  const report = await client.report({ groupBy: "workspace" });
  const revoked = await client.revokeKey(key.keyId, "done");
  const unknown = await client.revokeKey("000000000000");
  return { shape: { key: Object.keys(key).sort(), bare: Object.keys(bare).sort(), keyToken: /^curule_vk_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/.test(key.token) }, first, again, set, account, report, revoked, unknown };
}

test("the in-process client and the one that speaks HTTP to a real admin server do the same things and read the same answers", async () => {
  const a = await rig({ credit: 0 });
  const inProcess = await exercise(new InProcessGatewayAdmin(new AdminApi(a.gateway)));
  const b = await rig({ credit: 0 });
  const listening = await listen(createAdminServer(new AdminApi(b.gateway), b.gateway, { token: TOKEN }), 0, "127.0.0.1");
  try {
    const overHttp = await exercise(new HttpGatewayAdmin({ baseUrl: listening.url, token: TOKEN }));
    assert.deepEqual(overHttp, inProcess);
    assert.deepEqual(inProcess.shape, { key: ["accountId", "keyId", "token", "workspaceId"], bare: ["accountId", "keyId", "token"], keyToken: true });
    assert.deepEqual([inProcess.first, inProcess.again, inProcess.set], ["recorded", "duplicate", "recorded"]);
    assert.deepEqual(inProcess.account, { balance: { included: 2_000_000, purchased: 5_000_000, total: 7_000_000, held: 0, available: 7_000_000 }, charged: 0, cost: 0, currency: "USD" });
    assert.equal(inProcess.report.currency, "USD");
    assert.deepEqual(inProcess.report.groups, []);
    assert.equal(inProcess.revoked, undefined);
    assert.equal(inProcess.unknown, undefined, "revoking a key that is not there is what was wanted");
    assert.equal(b.ledger.state.keys.size, a.ledger.state.keys.size);
  } finally {
    await listening.close(0);
  }
});

test("a call with the wrong token is refused by the gateway, and says so as an error with its status, its type and its words", async () => {
  const r = await rig();
  const listening = await listen(createAdminServer(new AdminApi(r.gateway), r.gateway, { token: TOKEN }), 0, "127.0.0.1");
  try {
    const client = new HttpGatewayAdmin({ baseUrl: listening.url, token: "a-different-token-0123456789" });
    for (const act of [() => client.account("acme"), () => client.createKey({ accountId: "x" }), () => client.report({}), () => client.grant({ id: "g", accountId: "x", bucket: "purchased", amountMicros: 1, reason: "r" }), () => client.revokeKey("000000000000")]) {
      await assert.rejects(act, (err: GatewayAdminError) => err instanceof GatewayAdminError && err.status === 401 && err.type === "invalid_admin_token" && err.message === "The admin token is not valid." && err.name === "GatewayAdminError");
    }
  } finally {
    await listening.close(0);
  }
});

test("a request the gateway refuses as wrong is an error that carries what the gateway said", async () => {
  const r = await rig();
  const client = new InProcessGatewayAdmin(new AdminApi(r.gateway));
  await assert.rejects(() => client.createKey({ accountId: "x", models: ["gpt-9"] }), (err: GatewayAdminError) => err.status === 400 && err.type === "invalid_request_error" && /models names 'gpt-9', which is not a tier/.test(err.message));
  await assert.rejects(() => client.grant({ id: "g", accountId: "x", bucket: "purchased", amountMicros: 1.5, reason: "r" }), (err: GatewayAdminError) => err.status === 400 && /whole number of micro-units/.test(err.message));
  await client.grant({ id: "g", accountId: "x", bucket: "purchased", amountMicros: 10, reason: "r" });
  await assert.rejects(() => client.grant({ id: "g", accountId: "x", bucket: "purchased", amountMicros: 11, reason: "r" }), (err: GatewayAdminError) => err.status === 409 && err.type === "conflict");
  r.store.failure = new Error("disk full");
  await assert.rejects(() => client.grant({ id: "h", accountId: "x", bucket: "purchased", amountMicros: 1, reason: "r" }), (err: GatewayAdminError) => err.status === 503 && err.type === "ledger_unavailable");
});

// ---- what goes over the wire ----

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function http(answer: (call: Call) => { status?: number; body?: unknown; text?: string } | Error, baseUrl = "http://gateway.internal:8081") {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const call: Call = { url, method: String(init.method), headers: init.headers as Record<string, string>, body: init.body === undefined ? undefined : JSON.parse(String(init.body)) };
    calls.push(call);
    const out = answer(call);
    if (out instanceof Error) throw out;
    return new Response(out.text ?? (out.body === undefined ? "" : JSON.stringify(out.body)), { status: out.status ?? 200 });
  }) as unknown as typeof fetch;
  return { calls, client: new HttpGatewayAdmin({ baseUrl, token: TOKEN, fetch: fetchImpl }) };
}

test("each call is sent to its own path with the token and a JSON body, and the base address may end in slashes", async () => {
  const h = http(() => ({ body: { keyId: "k1", accountId: "a", token: "curule_vk_x", status: "recorded", balance: {}, charged: 0, cost: 0, currency: "USD", groups: [], total: {} } }), "http://gateway.internal:8081///");
  await h.client.createKey({ accountId: "a", workspaceId: "w", label: "l", models: ["fast"], limits: { rpm: 5 } });
  await h.client.revokeKey("k 1", "why");
  await h.client.revokeKey("k2");
  await h.client.grant({ id: "g1", accountId: "a", bucket: "included", mode: "set", amountMicros: 5, reason: "r", reference: "x" });
  await h.client.account("acct:with/odd chars");
  await h.client.report({ groupBy: "model", accountId: "a b", workspaceId: "w", from: "2026-10-05T12:00:00Z", to: "2026-10-06" });
  await h.client.report({});
  assert.deepEqual(
    h.calls.map((c) => [c.method, c.url]),
    [
      ["POST", "http://gateway.internal:8081/admin/keys"],
      ["POST", "http://gateway.internal:8081/admin/keys/k%201/revoke"],
      ["POST", "http://gateway.internal:8081/admin/keys/k2/revoke"],
      ["POST", "http://gateway.internal:8081/admin/grants"],
      ["GET", "http://gateway.internal:8081/admin/accounts/acct%3Awith%2Fodd%20chars"],
      ["GET", "http://gateway.internal:8081/admin/report?groupBy=model&accountId=a+b&workspaceId=w&from=2026-10-05T12%3A00%3A00Z&to=2026-10-06"],
      ["GET", "http://gateway.internal:8081/admin/report"],
    ],
  );
  for (const c of h.calls) {
    assert.equal(c.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(c.headers["content-type"], "application/json");
  }
  assert.deepEqual(h.calls[0]!.body, { accountId: "a", workspaceId: "w", label: "l", models: ["fast"], limits: { rpm: 5 } });
  assert.deepEqual(h.calls[1]!.body, { reason: "why" });
  assert.deepEqual(h.calls[2]!.body, {}, "no reason is an empty object, so the gateway reads a body");
  assert.deepEqual(h.calls[3]!.body, { id: "g1", accountId: "a", bucket: "included", mode: "set", amountMicros: 5, reason: "r", reference: "x" });
  assert.equal(h.calls[4]!.body, undefined);
  assert.equal(h.calls[5]!.body, undefined);
});

test("a key is returned with its id, its account and its token, and its workspace only when it has one", async () => {
  const h = http((c) => ({ body: (c.body as { workspaceId?: string }).workspaceId ? { keyId: "k1", accountId: "a", workspaceId: "w", token: "t", extra: "ignored", secretHash: "never" } : { keyId: "k2", accountId: "a", token: "t2" } }));
  assert.deepEqual(await h.client.createKey({ accountId: "a", workspaceId: "w" }), { keyId: "k1", accountId: "a", workspaceId: "w", token: "t" });
  assert.deepEqual(await h.client.createKey({ accountId: "a" }), { keyId: "k2", accountId: "a", token: "t2" });
});

test("an account is its balance, what it was charged and what that cost, and a report is read as the gateway sent it", async () => {
  const body = { balance: { included: 1, purchased: 2, total: 3, held: 0, available: 3 }, charged: 7, cost: 5, currency: "USD", accountId: "a", keys: 2 };
  const h = http(() => ({ body }));
  assert.deepEqual(await h.client.account("a"), { balance: body.balance, charged: 7, cost: 5, currency: "USD" });
  const report = { currency: "USD", groupBy: "account", groups: [{ group: "a", calls: 1 }], total: { calls: 1 } };
  const r = http(() => ({ body: report }));
  assert.deepEqual(await r.client.report({}), report);
});

test("a refusal carries the gateway's status, type and message, or says what it can when the gateway said nothing", async () => {
  const withBody = http(() => ({ status: 400, body: { error: { type: "invalid_request_error", message: "accountId is required" } } }));
  await assert.rejects(() => withBody.client.createKey({} as never), (err: GatewayAdminError) => err.status === 400 && err.type === "invalid_request_error" && err.message === "accountId is required");
  const bare = http(() => ({ status: 502, body: {} }));
  await assert.rejects(() => bare.client.account("a"), (err: GatewayAdminError) => err.status === 502 && err.type === "error" && err.message === "the gateway answered 502");
  const odd = http(() => ({ status: 500, body: { error: { type: 7, message: 8 } } }));
  await assert.rejects(() => odd.client.account("a"), (err: GatewayAdminError) => err.type === "7" && err.message === "8");
});

test("revoking a key that is not there is done, and revoking one the gateway cannot is not", async () => {
  const gone = http(() => ({ status: 404, body: { error: { type: "not_found", message: "There is no key 'x'." } } }));
  assert.equal(await gone.client.revokeKey("x"), undefined);
  for (const [status, type] of [[409, "conflict"], [500, "internal_error"], [401, "invalid_admin_token"], [503, "ledger_unavailable"]] as const) {
    const h = http(() => ({ status, body: { error: { type, message: `refused ${status}` } } }));
    await assert.rejects(() => h.client.revokeKey("x"), (err: GatewayAdminError) => err.status === status && err.type === type && err.message === `refused ${status}`, String(status));
  }
  const silent = http(() => ({ status: 500, body: {} }));
  await assert.rejects(() => silent.client.revokeKey("x"), (err: GatewayAdminError) => err.status === 500 && err.type === "error" && err.message === "");
});

test("a gateway that cannot be reached, or answers with something that is not JSON, is an error that says so", async () => {
  const down = http(() => new Error("connect ECONNREFUSED 10.0.0.5:8081"));
  await assert.rejects(() => down.client.account("a"), (err: GatewayAdminError) => err.status === 0 && err.type === "unreachable" && err.message === "the model gateway could not be reached (connect ECONNREFUSED 10.0.0.5:8081)");
  const html = http(() => ({ status: 502, text: "<html>bad gateway</html>" }));
  await assert.rejects(() => html.client.account("a"), (err: GatewayAdminError) => err.status === 502 && err.type === "invalid_response" && err.message === "the model gateway answered with something that is not JSON");
  const empty = http(() => ({ status: 200, text: "" }));
  assert.deepEqual(await empty.client.grant({ id: "g", accountId: "a", bucket: "purchased", amountMicros: 1, reason: "r" }), undefined, "an empty answer is an empty object");
});
