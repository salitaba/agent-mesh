import { test } from "node:test";
import assert from "node:assert/strict";
import { OwnerWeb, createOwnerServer, type WebLog } from "../../packages/cloud/src/index";
import { chatBody, spends } from "../ai-gateway/support";
import { ask, listen } from "./net-support";
import { plane, running, type Plane } from "./support";
import { HOUR, MINUTE, DAY } from "./web-support";

const TOKEN = "an-owner-token-of-at-least-24-chars";

interface Reply {
  status: number;
  headers: Record<string, string | string[]>;
  body: string;
  json: any;
}

function owner(p: Plane) {
  const logs: WebLog[] = [];
  const web = new OwnerWeb({ plane: p.plane, token: TOKEN, clock: () => new Date(p.clock.now), log: (r) => logs.push(r) });
  async function call(method: string, path: string, init: { json?: unknown; raw?: string; token?: string | null; header?: string; ip?: string } = {}): Promise<Reply> {
    const headers: Record<string, string | string[]> = {};
    const bearer = init.header ?? (init.token === null ? undefined : `Bearer ${init.token ?? TOKEN}`);
    if (bearer !== undefined) headers.authorization = bearer;
    let body = Buffer.alloc(0);
    if (init.json !== undefined) body = Buffer.from(JSON.stringify(init.json));
    if (init.raw !== undefined) body = Buffer.from(init.raw);
    const q = path.indexOf("?");
    const res = await web.handle({ method, path: q < 0 ? path : path.slice(0, q), query: new URLSearchParams(q < 0 ? "" : path.slice(q + 1)), headers, body, ip: init.ip ?? "192.0.2.10" });
    const text = typeof res.body === "string" ? res.body : res.body.toString("utf8");
    return { status: res.status, headers: res.headers, body: text, json: text.startsWith("{") ? JSON.parse(text) : undefined };
  }
  return { web, logs, call };
}

const at = (p: Plane): string => new Date(p.clock.now).toISOString();

// ---- who may ask ----

test("the owner API is for someone who holds the token, which must be long enough to be one", async () => {
  const p = await plane();
  assert.throws(() => new OwnerWeb({ plane: p.plane, token: "short" }), /at least 24 characters/);
  assert.throws(() => new OwnerWeb({ plane: p.plane, token: "x".repeat(23) }), /at least 24 characters/);
  assert.doesNotThrow(() => new OwnerWeb({ plane: p.plane, token: "x".repeat(24) }));
});

test("every way of not having the token is the same refusal, and the right one is let in however the scheme is written", async () => {
  const p = await plane();
  const o = owner(p);
  const refused = await o.call("GET", "/owner/health", { token: "not-the-token" });
  assert.deepEqual([refused.status, refused.json], [401, { error: { code: "invalid_owner_token", message: "The owner token is not valid." } }]);
  for (const init of [{ token: null }, { token: "" }, { token: TOKEN.slice(1) }, { token: `${TOKEN}x` }, { token: TOKEN.toUpperCase() }, { header: `Basic ${TOKEN}` }, { header: "Bearer" }, { header: `Bearer ${TOKEN} extra` }, { header: TOKEN }, { header: "" }] as const) {
    const r = await o.call("GET", "/owner/health", init);
    assert.deepEqual([r.status, r.body], [refused.status, refused.body], JSON.stringify(init));
  }
  for (const header of [`Bearer ${TOKEN}`, `bearer ${TOKEN}`, `BEARER   ${TOKEN}  `]) assert.equal((await o.call("GET", "/owner/health", { header })).status, 200, header);
  assert.equal(refused.headers["set-cookie"], undefined);
});

test("a wrong token is counted by address, and a right one is counted against nobody", async () => {
  const p = await plane();
  const o = owner(p);
  for (let i = 0; i < 20; i++) assert.equal((await o.call("GET", "/owner/health", { token: `guess-${i}-xxxxxxxxxxxxxxxxxxxx` })).status, 401);
  const blocked = await o.call("GET", "/owner/health", { token: "guess-21-xxxxxxxxxxxxxxxxxxxx" });
  assert.deepEqual([blocked.status, blocked.json.error.code, blocked.headers["retry-after"]], [429, "rate_limited", "600"]);
  assert.equal((await o.call("GET", "/owner/health")).status, 429, "the right token is refused too while the address is held: a guess is not told whether it was right");
  assert.equal((await o.call("GET", "/owner/health", { ip: "192.0.2.99" })).status, 200, "another address is not held");
  p.clock.advance(10 * MINUTE);
  assert.equal((await o.call("GET", "/owner/health")).status, 200);

  const steady = owner(p);
  for (let i = 0; i < 100; i++) assert.equal((await steady.call("GET", "/owner/unmatched")).status, 200);
  assert.equal((await steady.call("GET", "/owner/unmatched", { token: "a-wrong-token-xxxxxxxxxxxxxxxx" })).status, 401, "the operator's own calls leave nothing on the address's count");
});

// ---- looking ----

test("the health of the service is whether it can write its log, with what there is to look after", async () => {
  const { p } = await running();
  const o = owner(p);
  const health = await o.call("GET", "/owner/health");
  assert.deepEqual(health.json, { ok: true, writable: true, accounts: 1, workspaces: { running: 1 }, unmatchedPayments: 0 });
  p.store.failure = new Error("disk full");
  assert.deepEqual((await o.call("GET", "/owner/health")).json, { ok: false, writable: false, accounts: 1, workspaces: { running: 1 }, unmatchedPayments: 0 });
});

test("accounts are listed oldest first with what the operator needs of each, filtered by what is typed, in pages that say they were cut", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  p.clock.advance(MINUTE);
  const bob = await p.account("bob@example.org");
  p.clock.advance(MINUTE);
  const cyd = await p.account("cyd@example.com");
  await p.subscribe(bob.accountId);
  await p.plane.disableAccount(cyd.accountId, "chargeback");
  const o = owner(p);
  const all = await o.call("GET", "/owner/accounts");
  assert.equal(all.status, 200);
  assert.deepEqual(all.json.accounts.map((a: { email: string }) => a.email), ["ada@example.com", "bob@example.org", "cyd@example.com"]);
  assert.deepEqual([all.json.matched, all.json.truncated], [3, false]);
  const [a, b, c] = all.json.accounts;
  assert.deepEqual(a, { accountId: ada.accountId, email: "ada@example.com", createdAt: "2026-10-05T12:00:00.000Z", verified: true, subscription: null, workspaces: 0 });
  assert.deepEqual(b.subscription, { plan: "team", status: "active", periodEnd: "2026-11-05T12:02:00.000Z" });
  assert.deepEqual([c.disabledReason, typeof c.disabledAt], ["chargeback", "string"]);
  for (const secret of [p.log.state.accounts.get(ada.accountId)!.passwordHash, ada.sessionToken]) assert.ok(!all.body.includes(secret), "nothing that signs in or proves a password");

  assert.deepEqual((await o.call("GET", "/owner/accounts?q=EXAMPLE.ORG")).json.accounts.map((x: { email: string }) => x.email), ["bob@example.org"], "typed in any case, matched against the email");
  assert.deepEqual((await o.call("GET", `/owner/accounts?q=${cyd.accountId}`)).json.accounts.map((x: { email: string }) => x.email), ["cyd@example.com"], "or the account's own id");
  assert.deepEqual((await o.call("GET", "/owner/accounts?q=nobody")).json, { accounts: [], matched: 0, truncated: false });
  const cut = await o.call("GET", "/owner/accounts?limit=2");
  assert.deepEqual([cut.json.accounts.map((x: { email: string }) => x.email), cut.json.matched, cut.json.truncated], [["bob@example.org", "cyd@example.com"], 3, true], "the newest are kept");
  for (const limit of ["0", "201", "x", "1.5", "-1", ""]) assert.deepEqual(await o.call("GET", `/owner/accounts?limit=${limit}`).then((r) => [r.status, r.json.error.code]), [400, "invalid_request"], limit);
  assert.equal((await o.call("GET", "/owner/accounts?limit=200")).status, 200);
});

test("one account is shown as its owner sees it, with its balance, and an account that is not there is a 404", async () => {
  const { p, ada } = await running();
  const o = owner(p);
  const r = await o.call("GET", `/owner/accounts/${ada.accountId}`);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json).sort(), ["account", "balance", "view"]);
  assert.deepEqual(r.json.view, p.plane.view(p.log.state.accounts.get(ada.accountId)!));
  assert.deepEqual(r.json.balance, await p.plane.balance(ada.accountId));
  assert.equal(r.json.account.workspaces, 1);
  assert.deepEqual(await o.call("GET", "/owner/accounts/acct_nobody").then((x) => [x.status, x.json.error.code]), [404, "not_found"]);
  assert.equal((await o.call("GET", "/owner/accounts/%E0%A4%A")).status, 404, "an id that is not even valid names nothing");
  Object.assign(p.plane.o.gateway, { account: async () => { throw new Error("gateway down"); } });
  const without = await o.call("GET", `/owner/accounts/${ada.accountId}`);
  assert.deepEqual([without.status, without.json.balance], [200, null], "the operator still sees the account when the gateway cannot be asked");
});

test("what came in is reported for a period, next to what the models cost for it", async () => {
  const { p, ada } = await running();
  await p.plane.billing.apply({ type: "payment.succeeded", ref: "pi_1", purpose: "topup", accountId: ada.accountId, amountMinor: 2_500, currency: "USD", at: at(p) });
  const minted = await p.gateway.createKey({ accountId: ada.accountId, workspaceId: "ws_x" });
  await p.gatewayRig.call(chatBody({ model: "fast", stream: false }), p.gatewayCore.authenticate(`Bearer ${minted.token}`));
  const spent = spends(p.gatewayRig.store)[0]!;
  const o = owner(p);
  const r = await o.call("GET", "/owner/margin");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.revenue, { USD: { subscription: 14_900, topup: 2_500, refunded: 0 } });
  assert.equal(r.json.usage.costMicros, spent.costMicros);
  assert.equal(r.json.usage.marginMicros, spent.chargeMicros - spent.costMicros);
  const none = await o.call("GET", "/owner/margin?from=2027-01-01");
  assert.deepEqual(none.json.revenue, {});
  assert.equal((await o.call("GET", "/owner/margin?from=2026-10-05&to=2026-10-06T00:00:00Z")).status, 200);
  for (const query of ["from=yesterday", "to=", "from=2026-13-45", "to=not-a-date"]) {
    const bad = await o.call("GET", `/owner/margin?${query}`);
    if (query === "to=") assert.equal(bad.status, 200, "an empty bound is no bound");
    else assert.deepEqual([bad.status, bad.json.error.code], [400, "invalid_request"], query);
  }
});

// ---- doing ----

test("a payment that came some other way is recorded once, by its reference, and says when it could not be placed", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  const o = owner(p);
  const pay = (json: unknown) => o.call("POST", "/owner/payments", { json });
  const wire = { accountId: ada.accountId, purpose: "topup", amountMinor: 2_500, currency: "USD", ref: "wire-1", note: "bank transfer, invoice 12" };
  assert.deepEqual(await pay(wire).then((r) => [r.status, r.json]), [200, { applied: true }]);
  assert.equal((await p.plane.balance(ada.accountId)).balance.purchased, 25_000_000);
  assert.deepEqual(await pay(wire).then((r) => r.json), { applied: false, note: "duplicate" }, "the same reference again is not a second payment");
  assert.equal((await p.plane.balance(ada.accountId)).balance.purchased, 25_000_000);

  assert.deepEqual(await pay({ accountId: ada.accountId, purpose: "subscription", plan: "team", amountMinor: 14_900, currency: "USD", ref: "inv-1" }).then((r) => [r.status, r.json]), [200, { applied: true }]);
  assert.equal(p.log.state.accounts.get(ada.accountId)!.subscription?.plan, "team");

  const lost = await pay({ ...wire, accountId: "acct_nobody", ref: "wire-2" });
  assert.deepEqual([lost.status, lost.json], [200, { applied: false, note: "unmatched" }]);
  const unmatched = await o.call("GET", "/owner/unmatched");
  assert.deepEqual(unmatched.json.unmatched.map((u: { key: string; amountMinor: number }) => [u.key, u.amountMinor]), [["payment.succeeded:manual_wire-2", 2_500]]);

  const actions = p.store.entries.filter((e) => e.type === "owner.action") as Array<{ action: string; detail: string }>;
  assert.deepEqual(actions.map((a) => a.action), ["payment.recorded", "payment.recorded", "payment.recorded", "payment.recorded"]);
  assert.ok(actions[0]!.detail.includes("bank transfer, invoice 12") && actions[0]!.detail.includes("wire-1"), "what was done, and why, is written down");

  for (const [what, json, code] of [
    ["purpose", { ...wire, purpose: "gift" }, "invalid_request"],
    ["no purpose", { ...wire, purpose: undefined }, "invalid_request"],
    ["amount", { ...wire, amountMinor: 25.5 }, "invalid_request"],
    ["amount as text", { ...wire, amountMinor: "2500" }, "invalid_request"],
    ["no account", { ...wire, accountId: "" }, "invalid_request"],
    ["no currency", { ...wire, currency: " " }, "invalid_request"],
    ["no ref", { ...wire, ref: undefined }, "invalid_request"],
  ] as const) {
    assert.deepEqual(await pay(json).then((r) => [r.status, r.json.error.code]), [400, code], what);
  }
  assert.equal((await o.call("POST", "/owner/payments", { json: [] })).json.error.code, "invalid_json");
  assert.equal((await o.call("POST", "/owner/payments", { raw: "{" })).json.error.code, "invalid_json");
});

test("an account is stopped with a reason, and its sessions and running workspaces stop with it; it is started again by name, and both are written down", async () => {
  const { p, ada, workspace } = await running();
  const o = owner(p);
  assert.deepEqual(await o.call("POST", `/owner/accounts/${ada.accountId}/disable`, { json: {} }).then((r) => [r.status, r.json.error.code, r.json.error.message]), [400, "invalid_request", "reason is required."]);
  assert.deepEqual(await o.call("POST", `/owner/accounts/${ada.accountId}/disable`, { json: { reason: "   " } }).then((r) => r.status), 400);
  assert.equal(p.log.state.accounts.get(ada.accountId)!.disabledAt, undefined, "nothing was done without a reason");
  const stopped = await o.call("POST", `/owner/accounts/${ada.accountId}/disable`, { json: { reason: " abuse report 12 " } });
  assert.equal(stopped.status, 200);
  assert.equal(stopped.json.account.disabledReason, "abuse report 12");
  assert.equal(p.plane.accounts.authenticate(ada.sessionToken), undefined);
  assert.equal(workspace().status, "suspended");
  const started = await o.call("POST", `/owner/accounts/${ada.accountId}/enable`);
  assert.deepEqual([started.status, started.json.account.disabledAt], [200, undefined]);
  assert.equal(workspace().status, "suspended", "starting an account does not start what was stopped");
  for (const action of ["disable", "enable"]) assert.equal((await o.call("POST", `/owner/accounts/acct_nobody/${action}`, { json: { reason: "x" } })).status, 404, action);
  assert.deepEqual((p.store.entries.filter((e) => e.type === "owner.action") as Array<{ action: string }>).map((e) => e.action), ["account.disabled", "account.enabled"]);
});

test("workspaces are listed with their status, and the operator can stop, start and delete one by its id", async () => {
  const { p, ada, workspaceId, workspace } = await running();
  const o = owner(p);
  const list = await o.call("GET", "/owner/workspaces");
  assert.deepEqual(list.json.workspaces.map((w: { workspaceId: string; accountId: string; status: string; plan: string; name: string }) => [w.workspaceId, w.accountId, w.status, w.plan, w.name]), [[workspaceId, ada.accountId, "running", "team", "Main"]]);
  assert.equal(list.json.matched, 1);
  assert.deepEqual((await o.call("GET", "/owner/workspaces?status=suspended")).json, { workspaces: [], matched: 0 });
  assert.ok(!list.body.includes(p.provisioner.ops("create")[0]!.spec!.operatorToken) && !list.body.includes(workspace().gatewayKeyId!), "no token and no key");

  assert.deepEqual(await o.call("POST", `/owner/workspaces/${workspaceId}/suspend`, { json: {} }).then((r) => [r.status, r.json.error.message]), [400, "reason is required."]);
  const stopped = await o.call("POST", `/owner/workspaces/${workspaceId}/suspend`, { json: { reason: "investigating" } });
  assert.deepEqual(stopped.json, { workspace: { workspaceId, status: "suspended", statusReason: "investigating" } });
  assert.equal((await o.call("GET", "/owner/workspaces?status=suspended")).json.matched, 1);
  const started = await o.call("POST", `/owner/workspaces/${workspaceId}/resume`);
  assert.deepEqual(started.json, { workspace: { workspaceId, status: "running" } });
  assert.equal((await o.call("POST", "/owner/workspaces/ws_nobody/resume")).status, 404);
  assert.equal((await o.call("POST", `/owner/workspaces/${workspaceId}/explode`)).status, 404, "only the three things that can be done");
  const gone = await o.call("POST", `/owner/workspaces/${workspaceId}/destroy`);
  assert.deepEqual([gone.status, gone.json.workspace.status], [200, "destroyed"]);
  assert.equal(p.provisioner.ops("destroy").length, 1);
  assert.deepEqual(
    (p.store.entries.filter((e) => e.type === "owner.action") as Array<{ action: string; detail: string }>).map((e) => [e.action, e.detail]),
    [["workspace.suspend", workspaceId], ["workspace.resume", workspaceId], ["workspace.destroy", workspaceId]],
  );
});

test("the checks that keep a workspace honest can be run when the operator asks, and say what they did", async () => {
  const { p, ada, workspaceId, workspace } = await running();
  await p.plane.billing.apply({ type: "payment.failed", ref: "in_late", accountId: ada.accountId, at: at(p) });
  const o = owner(p);
  assert.deepEqual(await o.call("POST", "/owner/reconcile").then((r) => r.json), { actions: [] }, "inside its grace nothing is done");
  p.clock.advance(3 * DAY + HOUR);
  const r = await o.call("POST", "/owner/reconcile");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.actions, [`${workspaceId}: stopped, payment is overdue`]);
  assert.equal(workspace().status, "suspended");
});

// ---- the shape of the API ----

test("an address that is not one is a 404, a method that is not allowed says which are, and the answers carry no cookie and open nothing to another site", async () => {
  const p = await plane();
  const o = owner(p);
  const nothing = await o.call("GET", "/owner/nothing");
  assert.deepEqual([nothing.status, nothing.json.error.code], [404, "not_found"]);
  assert.deepEqual(await o.call("GET", "/api/plans").then((r) => r.status), 404, "the public API is not here");
  const wrong = await o.call("GET", "/owner/payments");
  assert.deepEqual([wrong.status, wrong.headers.allow, wrong.json.error.code], [405, "POST", "method_not_allowed"]);
  assert.equal((await o.call("DELETE", "/owner/accounts/acct_x")).headers.allow, "GET");
  assert.equal((await o.call("GET", "/owner/health/")).status, 200, "a trailing slash is the same address");
  for (const r of [nothing, wrong, await o.call("GET", "/owner/health")]) {
    assert.equal(r.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(r.headers["cache-control"], "no-store");
    assert.equal(r.headers["content-security-policy"], "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    assert.equal(r.headers["set-cookie"], undefined);
    assert.equal(r.headers["access-control-allow-origin"], undefined);
  }
});

test("a failure inside is logged with its detail and answered without it, and a log that cannot be written is a 503", async () => {
  const { p, ada } = await running();
  const o = owner(p);
  Object.assign(p.plane, { disableAccount: async () => { throw new Error("EACCES: /var/lib/curule/control.jsonl is secret"); } });
  const failed = await o.call("POST", `/owner/accounts/${ada.accountId}/disable`, { json: { reason: "x" } });
  assert.deepEqual([failed.status, failed.json], [500, { error: { code: "internal_error", message: "The request failed." } }]);
  assert.ok(!failed.body.includes("EACCES"));
  assert.ok(o.logs.some((l) => l.level === "error" && String(l.error).includes("EACCES")));

  const q = await running();
  const o2 = owner(q.p);
  q.p.store.failure = new Error("ENOSPC");
  const full = await o2.call("POST", `/owner/accounts/${q.ada.accountId}/enable`);
  assert.deepEqual([full.status, full.json.error.code, full.headers["retry-after"]], [503, "unavailable", "60"]);
  assert.ok(o2.logs.some((l) => l.level === "error" && l.msg === "the control log cannot be written"));
  assert.equal((await o2.call("GET", "/owner/accounts")).status, 200, "the operator can still look");
});

test("something the service could not do on its own side is logged for the operator with its cause", async () => {
  const { p } = await running();
  const o = owner(p);
  Object.assign(p.plane, { margin: async () => { throw Object.assign(new Error("report failed"), { name: "GatewayError" }); } });
  assert.equal((await o.call("GET", "/owner/margin")).status, 500);
  assert.ok(o.logs.some((l) => l.level === "error" && l.msg === "the owner API failed to handle a request" && l.error === "GatewayError: report failed"));
});

// ---- the listener ----

test("the owner's listener answers over a socket as the handler does, reads no header about who is calling, and refuses what is too large", async () => {
  const { p, ada } = await running();
  const o = owner(p);
  const server = createOwnerServer({ owner: o.web, maxBodyBytes: 512 });
  const l = await listen(server);
  try {
    const get = (path: string, token: string | null = TOKEN, headers: Record<string, string> = {}) => ask(l.port, { path, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
    const health = await get("/owner/health");
    assert.deepEqual([health.status, health.json.ok, health.headers["content-type"]], [200, true, "application/json; charset=utf-8"]);
    assert.equal(health.headers["content-length"], String(Buffer.byteLength(health.body)));
    assert.equal((await get("/owner/health", null)).status, 401);
    assert.equal((await get("//")).status, 400);
    for (let i = 0; i < 20; i++) await get("/owner/health", `guess-${i}-xxxxxxxxxxxxxxxxxxxxxx`, { "x-forwarded-for": `198.51.100.${i}` });
    assert.equal((await get("/owner/health", TOKEN, { "x-forwarded-for": "198.51.100.200" })).status, 429, "an address written in a header does not give the guesser a count of its own");

    const q = owner(p);
    const small = createOwnerServer({ owner: q.web, maxBodyBytes: 512 });
    const sl = await listen(small);
    try {
      const big = await ask(sl.port, { method: "POST", path: `/owner/accounts/${ada.accountId}/disable`, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ reason: "x".repeat(600) }) });
      assert.deepEqual([big.status, big.json.error.code, big.headers.connection], [413, "request_too_large", "close"]);
      const fine = await ask(sl.port, { method: "POST", path: `/owner/accounts/${ada.accountId}/disable`, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, json: { reason: "abuse" } });
      assert.deepEqual([fine.status, fine.json.account.disabledReason], [200, "abuse"]);
    } finally {
      await sl.close();
    }
  } finally {
    await l.close();
  }
});
