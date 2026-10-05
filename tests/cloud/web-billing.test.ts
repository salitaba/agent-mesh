import { test } from "node:test";
import assert from "node:assert/strict";
import { BillingProviderError, HostedCheckoutBilling, parseCatalogue, signWebhook } from "../../packages/cloud/src/index";
import { chatBody, spends } from "../ai-gateway/support";
import { CATALOGUE, RecordingBilling, plane, running } from "./support";
import { HOUR, PASSWORD, cookieSet, site, tokenIn } from "./web-support";

const origins = { origin: null } as const;
const WEBHOOK_SECRET = "whsec_test_secret";

// ---- what is on offer ----

test("the plans a visitor reads are the ones on offer, with their prices and what they include, and nothing about how they are paid for", async () => {
  const p = await plane();
  const s = site(p);
  const r = await s.call("GET", "/api/plans");
  assert.equal(r.status, 200);
  assert.equal(r.json.currency, "USD");
  assert.deepEqual(r.json.plans, [
    { id: "team", title: "Team", priceMinor: 14_900, period: "month", includedUsageMicros: 20_000_000, workspaces: 1, tiers: ["fast", "balanced"] },
    { id: "business", title: "Business", priceMinor: 59_900, period: "month", includedUsageMicros: 100_000_000, workspaces: 3 },
    { id: "yearly", title: "Team, yearly", priceMinor: 148_800, period: "year", includedUsageMicros: 20_000_000, workspaces: 1 },
  ]);
  assert.deepEqual(r.json.topups, { optionsMinor: [1_000, 2_500, 10_000], minimumMinor: 500, maximumMinor: 100_000, usageMicrosPerMinor: 10_000 });
  for (const hidden of ["price_team", "providerPriceId", "licencePlan", "licence_plan"]) assert.ok(!r.body.includes(hidden), hidden);
  Object.assign(p.plane.o, { catalogue: parseCatalogue({ ...CATALOGUE, plans: { team: { ...CATALOGUE.plans.team, summary: "For one team that ships." } } }) });
  assert.equal((await s.call("GET", "/api/plans")).json.plans[0].summary, "For one team that ships.", "a plan's own words are passed on when it has them");
});

// ---- what the account has used ----

test("what a customer sees of their usage is what they were charged, by day and by workspace, and not what it cost or what was made", async () => {
  const { p, ada } = await running();
  const bob = await p.account("bob@example.com");
  const s = site(p);
  const minted = await p.gateway.createKey({ accountId: ada.accountId, workspaceId: "ws_main" });
  const out = await p.gatewayRig.call(chatBody({ model: "fast", stream: false }), p.gatewayCore.authenticate(`Bearer ${minted.token}`));
  assert.equal(out.completion?.status, 200);
  const spent = spends(p.gatewayRig.store)[0]!;
  assert.ok(spent.chargeMicros > 0 && spent.costMicros > 0 && spent.chargeMicros !== spent.costMicros);

  const r = await s.call("GET", "/api/usage", { session: ada.sessionToken });
  assert.equal(r.status, 200);
  assert.equal(r.json.currency, "USD");
  assert.equal(r.json.total.chargedMicros, spent.chargeMicros);
  assert.equal(r.json.total.calls, 1);
  assert.equal(r.json.total.failed, 0);
  assert.deepEqual(r.json.byDay.map((d: { group: string }) => d.group), ["2026-10-05"]);
  assert.deepEqual(r.json.byWorkspace.map((d: { group: string; chargedMicros: number }) => [d.group, d.chargedMicros]), [["ws_main", spent.chargeMicros]]);
  assert.deepEqual(Object.keys(r.json.total).sort(), ["cachedTokens", "calls", "chargedMicros", "failed", "inputTokens", "outputTokens"]);
  assert.ok(!/cost|margin/i.test(r.body), "what a call cost the service, and what the service made on it, are not in the answer");

  assert.equal((await s.call("GET", "/api/usage", { session: bob.sessionToken })).json.total.calls, 0, "what another account used is not in it");
  assert.equal((await s.call("GET", "/api/usage")).status, 401);
});

test("usage that cannot be read is a 502 that says to try again, with the cause in the log and not in the answer", async () => {
  const { p, ada } = await running();
  const s = site(p);
  Object.assign(p.plane.o.gateway, { report: async () => { throw new Error("gateway admin refused: token tk_secret at 10.0.0.9"); } });
  const r = await s.call("GET", "/api/usage", { session: ada.sessionToken });
  assert.deepEqual([r.status, r.json.error.code, r.json.error.message], [502, "usage_unavailable", "Usage could not be read just now. Try again in a moment."]);
  assert.ok(!r.body.includes("tk_secret") && !r.body.includes("10.0.0.9"));
  const logged = s.logs.find((l) => l.level === "error" && l.code === "usage_unavailable");
  assert.match(String(logged?.error), /gateway admin refused: token tk_secret at 10\.0\.0\.9/);
});

// ---- paying ----

test("a checkout asks the provider for a page to pay on, for what was chosen, and the same choice on the same day is the same page", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  const s = site(p);
  const checkout = (json: unknown, session: string | null = ada.sessionToken) => s.call("POST", "/api/checkout", { json, ...(session ? { session } : {}) });
  assert.deepEqual(await checkout({ purpose: "subscription", plan: "team" }, null).then((r) => [r.status, r.json.error.code]), [401, "not_signed_in"]);
  const first = await checkout({ purpose: "subscription", plan: "team" });
  assert.equal(first.status, 200);
  assert.match(first.json.url, /^https:\/\/app\.example\.com\/pay\?ref=manual_[0-9a-f]{32}$/);
  assert.deepEqual(Object.keys(first.json), ["url"]);
  assert.equal((await checkout({ purpose: "subscription", plan: "team" })).json.url, first.json.url, "asking twice for the same thing gives one payment to make");
  assert.notEqual((await checkout({ purpose: "subscription", plan: "business" })).json.url, first.json.url);
  const topup = await checkout({ purpose: "topup", amountMinor: 2_500 });
  assert.equal(topup.status, 200);
  assert.notEqual(topup.json.url, first.json.url);
  for (const [body, code] of [
    [{ purpose: "subscription", plan: "nonesuch" }, "unknown_plan"],
    [{ purpose: "subscription" }, "unknown_plan"],
    [{ purpose: "subscription", plan: 5 }, "unknown_plan"],
    [{ purpose: "topup", amountMinor: 100 }, "invalid_amount"],
    [{ purpose: "topup", amountMinor: 100_001 }, "invalid_amount"],
    [{ purpose: "topup", amountMinor: 1000.5 }, "invalid_amount"],
    [{ purpose: "topup", amountMinor: "2500" }, "invalid_amount"],
    [{ purpose: "topup" }, "invalid_amount"],
    [{ purpose: "gift", plan: "team" }, "invalid_purpose"],
    [{}, "invalid_purpose"],
  ] as const) {
    const r = await checkout(body);
    assert.deepEqual([r.status, r.json.error.code], [400, code], JSON.stringify(body));
  }
  await p.subscribe(ada.accountId, "team");
  assert.deepEqual(await checkout({ purpose: "subscription", plan: "team" }).then((r) => [r.status, r.json.error.code]), [409, "already_subscribed"]);
  assert.equal((await checkout({ purpose: "subscription", plan: "business" })).status, 200, "another plan is on offer to someone who has one");
});

test("the provider's words and its address are never the customer's: a checkout it refuses is a 502 with ours, and its reason is in the log", async () => {
  const billing = new RecordingBilling();
  const p = await plane({ billing });
  const ada = await p.account("ada@example.com");
  const s = site(p);
  billing.failWith = new BillingProviderError("the payment provider refused the request: invalid api key sk_live_secret", 401);
  const r = await s.call("POST", "/api/checkout", { json: { purpose: "topup", amountMinor: 2_500 }, session: ada.sessionToken });
  assert.deepEqual([r.status, r.json.error.code, r.json.error.message], [502, "billing_unavailable", "The payment page could not be opened. Try again in a moment."]);
  assert.ok(!r.body.includes("sk_live_secret"));
  const logged = s.logs.find((l) => l.level === "error" && l.code === "billing_unavailable");
  assert.match(String(logged?.error), /BillingProviderError: the payment provider refused the request: invalid api key sk_live_secret/);
});

test("a checkout carries what the provider needs to say whose payment it is, and where to come back to", async () => {
  const billing = new RecordingBilling();
  const p = await plane({ billing });
  const ada = await p.account("ada@example.com");
  const s = site(p);
  await s.call("POST", "/api/checkout", { json: { purpose: "subscription", plan: "team" }, session: ada.sessionToken });
  const [input] = billing.checkouts;
  assert.equal(input!.accountId, ada.accountId);
  assert.equal(input!.email, "ada@example.com");
  assert.equal(input!.successUrl, "https://app.example.com/account?paid=1");
  assert.equal(input!.cancelUrl, "https://app.example.com/account?cancelled=1");
  assert.deepEqual(input!.plan, { id: "team", title: "Team", priceMinor: 14_900, period: "month", providerPriceId: "price_team" });
  assert.equal((await s.call("POST", "/api/checkout", { json: { purpose: "subscription", plan: "team" } })).status, 401, "a checkout is for someone who is signed in");
});

test("the billing portal is the provider's page for managing what was paid for, and for someone who has paid nothing it says so", async () => {
  const billing = new RecordingBilling();
  const p = await plane({ billing });
  const ada = await p.account("ada@example.com");
  const s = site(p);
  const portal = await s.call("POST", "/api/portal", { session: ada.sessionToken });
  assert.deepEqual([portal.status, portal.json], [200, { url: "https://pay.example/portal" }]);
  assert.deepEqual(billing.portals, [{ accountId: ada.accountId, returnUrl: "https://app.example.com/account" }]);
  assert.equal((await s.call("POST", "/api/portal")).status, 401);

  const manual = await plane();
  const bob = await manual.account("bob@example.com");
  const m = await site(manual).call("POST", "/api/portal", { session: bob.sessionToken });
  assert.deepEqual([m.status, m.json.error.code], [409, "no_portal"]);
  assert.match(m.json.error.message, /no billing portal for payments made by invoice or transfer/);

  let asked = 0;
  const hosted = new HostedCheckoutBilling({ apiKey: "sk_test_1", webhookSecret: WEBHOOK_SECRET, fetch: (async () => { asked++; return new Response("{}"); }) as unknown as typeof fetch });
  const unpaid = await plane({ billing: hosted });
  const cyd = await unpaid.account("cyd@example.com");
  const n = await site(unpaid).call("POST", "/api/portal", { session: cyd.sessionToken });
  assert.deepEqual([n.status, n.json.error.code, n.json.error.message], [409, "no_portal", "There is nothing to manage yet: no payment has been made on this account."]);
  assert.equal(asked, 0, "the provider is not asked about a customer that does not exist");
});

test("what costs something is limited for each session, and another session has its own count", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  const other = (await p.plane.accounts.login("ada@example.com", PASSWORD)).sessionToken;
  const s = site(p, { limits: { actionSession: { max: 3, windowMs: HOUR } } });
  const checkout = (session: string) => s.call("POST", "/api/checkout", { json: { purpose: "topup", amountMinor: 1_000 }, session });
  for (let i = 0; i < 3; i++) assert.equal((await checkout(ada.sessionToken)).status, 200);
  const refused = await checkout(ada.sessionToken);
  assert.deepEqual([refused.status, refused.json.error.code, refused.headers["retry-after"]], [429, "rate_limited", "3600"]);
  assert.equal((await s.call("POST", "/api/portal", { session: ada.sessionToken })).status, 429, "portal, checkout, usage and workspaces share the count");
  assert.equal((await s.call("GET", "/api/usage", { session: ada.sessionToken })).status, 429);
  assert.equal((await checkout(other)).status, 200);
  p.clock.advance(HOUR);
  assert.equal((await checkout(ada.sessionToken)).status, 200);
});

// ---- workspaces ----

test("a workspace is made for the plan's name and limit, answers at once as starting, and is running when it is ready", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  const s = site(p);
  const create = (name: unknown, session: string | null = ada.sessionToken) => s.call("POST", "/api/workspaces", { json: { name }, ...(session ? { session } : {}) });
  assert.deepEqual(await create("Main", null).then((r) => [r.status, r.json.error.code]), [401, "not_signed_in"]);
  assert.deepEqual(await create("Main").then((r) => [r.status, r.json.error.code]), [402, "no_subscription"]);
  await p.subscribe(ada.accountId);
  for (const name of ["", "   ", "x".repeat(61), "bad\u0007name", 7, null, undefined]) {
    assert.deepEqual(await create(name).then((r) => [r.status, r.json.error.code]), [400, "invalid_name"], String(name));
  }
  let release!: () => void;
  p.provisioner.hold = new Promise<void>((resolve) => (release = resolve));
  const made = await create("  Research team ");
  assert.equal(made.status, 201);
  const w = made.json.workspace;
  assert.match(w.slug, /^research-team-[0-9a-f]{6}$/);
  assert.deepEqual(w, { workspaceId: w.workspaceId, name: "Research team", slug: w.slug, plan: "team", status: "provisioning", host: `${w.slug}.ws.example.com` });
  assert.deepEqual(Object.keys(made.json), ["workspace"], "nothing of the host, its token or its key");
  assert.deepEqual(await create("Second").then((r) => [r.status, r.json.error.code]), [403, "workspace_limit"], "a workspace still starting is one of the plan's");
  release();
  await p.plane.workspaces.idle();
  const me = await s.call("GET", "/api/me", { session: ada.sessionToken });
  assert.deepEqual(me.json.account.workspaces.map((x: { name: string; status: string }) => [x.name, x.status]), [["Research team", "running"]]);
  assert.ok(!made.body.includes(p.provisioner.ops("create")[0]!.spec!.operatorToken));
});

test("opening a workspace gives a link that works once, for this session, at the workspace's own address", async () => {
  const { p, ada, workspaceId } = await running();
  const s = site(p);
  const open = await s.call("POST", `/api/workspaces/${workspaceId}/open`, { session: ada.sessionToken });
  assert.equal(open.status, 200);
  assert.deepEqual(Object.keys(open.json), ["url"]);
  const url = new URL(open.json.url);
  const host = p.plane.view(p.log.state.accounts.get(ada.accountId)!).workspaces[0]!.host;
  assert.deepEqual([url.protocol, url.hostname, url.pathname], ["https:", host, "/__enter"]);
  const code = url.searchParams.get("code")!;
  assert.match(code, /^[A-Za-z0-9_-]{30,}$/);
  const sessionId = p.plane.accounts.identify(ada.sessionToken)!.sessionId;
  assert.deepEqual(s.access.redeemCode(code), { accountId: ada.accountId, workspaceId, sessionId });
  assert.equal(s.access.redeemCode(code), undefined, "a link works once");
  const again = await s.call("POST", `/api/workspaces/${workspaceId}/open`, { session: ada.sessionToken });
  assert.notEqual(new URL(again.json.url).searchParams.get("code"), code);
  assert.deepEqual(s.access.redeemCode(new URL(again.json.url).searchParams.get("code")), { accountId: ada.accountId, workspaceId, sessionId });
  const http = await site(p, { workspaceScheme: "http" }).call("POST", `/api/workspaces/${workspaceId}/open`, { session: ada.sessionToken });
  assert.equal(new URL(http.json.url).protocol, "http:", "on one machine, without a certificate, it is HTTP");
});

test("a workspace that is not running says what it is and what to do, and opens again when it is", async () => {
  const { p, ada, workspaceId, workspace } = await running();
  const s = site(p);
  const open = () => s.call("POST", `/api/workspaces/${workspaceId}/open`, { session: ada.sessionToken });
  const as = async (status: string, message: string): Promise<void> => {
    await p.log.append({ type: "workspace.status", workspaceId, status: status as "failed" });
    const r = await open();
    assert.deepEqual([r.status, r.json.error.code, r.json.error.message], [409, "not_running", message], status);
  };
  await as("provisioning", "This workspace is still starting.");
  await as("suspended", "This workspace is stopped. Start it first.");
  await as("failed", "This workspace could not start.");
  await as("requested", "This workspace is still starting.");
  await p.log.append({ type: "workspace.status", workspaceId, status: "running" });
  assert.equal(workspace().status, "running");
  assert.equal((await open()).status, 200);
});

test("a workspace is the account's own: another account's, and one that does not exist, are the same 404 for every action, and nothing is done", async () => {
  const { p, ada, workspaceId } = await running();
  const bob = await p.account("bob@example.com");
  await p.subscribe(bob.accountId);
  const s = site(p);
  const missing = "ws_000000000000";
  const call = (action: string, id: string, json?: unknown) => s.call("POST", `/api/workspaces/${id}/${action}`, { session: bob.sessionToken, ...(json === undefined ? {} : { json }) });
  for (const [action, json] of [["open", undefined], ["suspend", undefined], ["resume", undefined], ["delete", { confirm: "Main" }]] as const) {
    const foreign = await call(action, workspaceId, json);
    const nothing = await call(action, missing, json);
    assert.equal(foreign.status, 404, action);
    assert.deepEqual(foreign.json, { error: { code: "not_found", message: "There is no such workspace." } }, action);
    assert.equal(foreign.body, nothing.body, `${action}: another account's workspace and none at all are not told apart`);
  }
  assert.equal((await call("open", "%E0%A4%A")).status, 404, "an address that is not even valid is a workspace that does not exist");
  assert.deepEqual([p.provisioner.ops("suspend").length, p.provisioner.ops("destroy").length], [0, 0]);
  assert.equal(p.log.state.workspaces.get(workspaceId)!.status, "running");
  assert.equal((await s.call("POST", `/api/workspaces/${workspaceId}/open`, { session: ada.sessionToken })).status, 200);
});

test("a workspace can be stopped and started by its owner, and starting needs the plan to be paid", async () => {
  const { p, ada, workspaceId } = await running();
  const s = site(p);
  const act = (action: string) => s.call("POST", `/api/workspaces/${workspaceId}/${action}`, { session: ada.sessionToken });
  const stopped = await act("suspend");
  assert.equal(stopped.status, 200);
  assert.deepEqual([stopped.json.workspace.status, stopped.json.workspace.statusReason], ["suspended", "paused by its owner"]);
  assert.equal((await act("suspend")).status, 200, "stopping what is stopped is not an error");
  assert.equal(p.provisioner.ops("suspend").length, 1);
  await p.plane.billing.apply({ type: "payment.failed", ref: "in_late", accountId: ada.accountId, at: new Date(p.clock.now).toISOString() });
  assert.deepEqual(await act("resume").then((r) => [r.status, r.json.error.code]), [402, "payment_overdue"], "a workspace that costs us models is not started for a plan that is not paid");
  await p.subscribe(ada.accountId, "team", "in_paid");
  const started = await act("resume");
  assert.equal(started.status, 200);
  assert.equal(started.json.workspace.status, "running");
  assert.equal(started.json.workspace.statusReason, undefined);
  assert.equal((await act("resume")).status, 200, "starting what runs is not an error");
});

test("a stop that the host could not carry out is a failure to try again, and leaves the workspace as it was", async () => {
  const { p, ada, workspaceId, workspace } = await running();
  const s = site(p);
  p.provisioner.failNext = ["suspend"];
  const failed = await s.call("POST", `/api/workspaces/${workspaceId}/suspend`, { session: ada.sessionToken });
  assert.deepEqual([failed.status, failed.json.error.code], [500, "internal_error"]);
  assert.ok(!failed.body.includes("the suspend failed"));
  assert.equal(workspace().status, "running");
  assert.equal((await s.call("POST", `/api/workspaces/${workspaceId}/suspend`, { session: ada.sessionToken })).status, 200);
  assert.equal(workspace().status, "suspended");
});

test("a workspace is deleted only when its owner types its name, and then its data goes with it and its place on the plan is free", async () => {
  const { p, ada, workspaceId } = await running();
  const s = site(p);
  const remove = (json: unknown) => s.call("POST", `/api/workspaces/${workspaceId}/delete`, { json, session: ada.sessionToken });
  for (const confirm of [undefined, "", "main", "Main ", "Other", true, 1]) {
    const r = await remove({ confirm });
    assert.deepEqual([r.status, r.json.error.code], [400, "confirmation_needed"], String(confirm));
  }
  assert.equal(p.provisioner.ops("destroy").length, 0);
  assert.deepEqual(await s.call("POST", `/api/workspaces/${workspaceId}/delete`, { session: ada.sessionToken }).then((r) => r.json.error.code), "confirmation_needed", "no body is no confirmation");
  const done = await remove({ confirm: "Main" });
  assert.deepEqual([done.status, done.json], [200, { ok: true }]);
  assert.equal(p.provisioner.ops("destroy").length, 1);
  assert.deepEqual((await s.call("GET", "/api/me", { session: ada.sessionToken })).json.account.workspaces, []);
  assert.deepEqual(await remove({ confirm: "Main" }).then((r) => [r.status, r.json.error.code]), [404, "not_found"]);
  const next = await s.call("POST", "/api/workspaces", { json: { name: "Main again" }, session: ada.sessionToken });
  assert.equal(next.status, 201, "the plan's one workspace is free again");
});

// ---- the provider's messages ----

function hosted() {
  const billing = new HostedCheckoutBilling({
    apiKey: "sk_test_1",
    webhookSecret: WEBHOOK_SECRET,
    fetch: (async () => { throw new Error("no network in this test"); }) as unknown as typeof fetch,
    planOfPrice: (id) => (id === "price_team" ? "team" : undefined),
  });
  return billing;
}

const bytes = (type: string, object: Record<string, unknown>, at: Date, id = "evt_1"): Buffer => Buffer.from(JSON.stringify({ id, type, created: Math.floor(at.getTime() / 1000), data: { object } }));

async function paying() {
  const p = await plane({ billing: hosted() });
  const ada = await p.account("ada@example.com");
  const s = site(p);
  const at = (): Date => new Date(p.clock.now);
  const deliver = (body: Buffer, extra: { headers?: Record<string, string>; ip?: string; secret?: string; signedAt?: Date } = {}) =>
    s.call("POST", "/webhooks/billing", { raw: body.toString("utf8"), type: "application/json", ...origins, ip: extra.ip ?? "198.51.100.200", headers: { "stripe-signature": signWebhook(extra.secret ?? WEBHOOK_SECRET, body, extra.signedAt ?? at()), ...extra.headers } });
  const topup = (id = "evt_1", intent = "pi_1") => bytes("checkout.session.completed", { id: "cs_1", client_reference_id: ada.accountId, customer: "cus_1", mode: "payment", payment_status: "paid", payment_intent: intent, amount_total: 2_500, currency: "usd" }, at(), id);
  return { p, ada, s, at, deliver, topup };
}

test("a message from the provider is applied once and acknowledged, and one that is sent again is acknowledged and changes nothing", async () => {
  const { p, ada, deliver, topup } = await paying();
  const first = await deliver(topup());
  assert.deepEqual([first.status, first.json], [200, { received: true, events: 2, applied: 2 }]);
  assert.equal((await p.plane.balance(ada.accountId)).balance.purchased, 25_000_000, "twenty-five dollars of a top-up is twenty-five units of models");
  const again = await deliver(topup("evt_retry"));
  assert.deepEqual([again.status, again.json], [200, { received: true, events: 2, applied: 0 }], "the provider retries, and so a payment is applied by its own reference and not by the message");
  assert.equal((await p.plane.balance(ada.accountId)).balance.purchased, 25_000_000);
  assert.equal(p.log.state.accounts.get(ada.accountId)!.customers["hosted-checkout"], "cus_1", "the customer is linked, so the portal and later invoices find the account");
});

test("a message whose signature is not the provider's is refused in words that say nothing, with the reason in the log", async () => {
  const { p, ada, s, at, deliver, topup } = await paying();
  const good = topup();
  const stale = new Date(p.clock.now - 10 * 60_000);
  const attempts: Array<[string, Awaited<ReturnType<typeof deliver>>]> = [
    ["no signature", await s.call("POST", "/webhooks/billing", { raw: good.toString("utf8"), type: "application/json", ...origins, ip: "198.51.100.200" })],
    ["another secret", await deliver(good, { secret: "whsec_other" })],
    ["a body that was changed", await deliver(Buffer.from(good.toString("utf8").replace("pi_1", "pi_2")), { headers: { "stripe-signature": signWebhook(WEBHOOK_SECRET, good, at()) } })],
    ["a message that is ten minutes old", await deliver(good, { signedAt: stale })],
    ["a signature that is not one", await deliver(good, { headers: { "stripe-signature": "garbage" } })],
  ];
  for (const [what, r] of attempts) {
    assert.deepEqual([r.status, r.json], [400, { error: { code: "bad_message", message: "That message was not accepted." } }], what);
  }
  assert.equal((await p.plane.balance(ada.accountId)).balance.purchased, 0, "none of them was applied");
  const reasons = s.logs.filter((l) => l.level === "warn" && l.msg === "a message from the payment provider was refused").map((l) => String(l.reason));
  assert.equal(reasons.length, 5);
  assert.match(reasons[0]!, /carries no signature/);
  assert.match(reasons[1]!, /signature does not match/);
  assert.match(reasons[3]!, /too old or too new/);
  assert.match(reasons[4]!, /not in the form the provider sends/);
  assert.ok(s.logs.every((l) => l.msg !== "a message from the payment provider was refused" || l.ip === "198.51.100.200"));
  assert.ok(!JSON.stringify(attempts.map(([, r]) => r.body)).includes("signature"), "the answer does not teach what was wrong with it");
});

test("the signature is the provider's whole credential: no cookie, origin or content type is asked of it, and none is set on its answer", async () => {
  const { p, ada, deliver, topup } = await paying();
  const session = await p.plane.accounts.login("ada@example.com", PASSWORD);
  const r = await deliver(topup(), { headers: { "content-type": "text/plain", origin: "https://evil.example", cookie: `__Host-curule_session=${session.sessionToken}` } });
  assert.equal(r.status, 200);
  assert.equal(r.headers["set-cookie"], undefined);
  assert.equal((await p.plane.balance(ada.accountId)).balance.purchased, 25_000_000);
});

test("the provider's messages are not counted against an address, and a message that means nothing to us is acknowledged and ignored", async () => {
  const { p, ada, at } = await paying();
  const s = site(p, { limits: { apiIp: { max: 1, windowMs: HOUR } } });
  for (const type of ["customer.created", "charge.succeeded", "payment_intent.created", "ping"]) {
    const body = bytes(type, { id: "x" }, at(), `evt_${type}`);
    const r = await s.call("POST", "/webhooks/billing", { raw: body.toString("utf8"), type: "application/json", ...origins, headers: { "stripe-signature": signWebhook(WEBHOOK_SECRET, body, at()) } });
    assert.deepEqual([r.status, r.json], [200, { received: true, events: 0, applied: 0 }], type);
  }
  assert.equal(p.log.state.accounts.get(ada.accountId)!.subscription, undefined);
  assert.equal((await s.call("GET", "/api/plans")).status, 200);
  assert.equal((await s.call("GET", "/api/plans")).status, 429, "everything else from the address is limited as it was");
});

test("a message that could not be applied is a 500, so the provider sends it again; the cause is in the log and not in the answer", async () => {
  const { p, ada, s, deliver, topup } = await paying();
  Object.assign(p.plane.billing, { apply: async () => { throw new Error("gateway admin down at 10.0.0.5"); } });
  const r = await deliver(topup());
  assert.deepEqual([r.status, r.json], [500, { error: { code: "internal_error", message: "The message could not be applied." } }]);
  assert.ok(!r.body.includes("10.0.0.5"));
  assert.ok(s.logs.some((l) => l.level === "error" && l.msg === "a payment message could not be applied" && String(l.error).includes("10.0.0.5")));
  assert.equal((await p.plane.balance(ada.accountId)).balance.purchased, 0);
});

test("a deployment that takes payments by hand refuses every message from a provider", async () => {
  const p = await plane();
  const s = site(p);
  const r = await s.call("POST", "/webhooks/billing", { json: { type: "invoice.paid" }, ...origins });
  assert.deepEqual([r.status, r.json.error.code], [400, "bad_message"]);
  assert.ok(s.logs.some((l) => l.level === "warn" && /Manual billing receives no messages/.test(String(l.reason))));
});

// ---- a whole customer ----

test("a person signs up, pays through the provider and opens a workspace, in the order the page leads them", async () => {
  const sent: Array<{ url: string; body: URLSearchParams }> = [];
  const billing = new HostedCheckoutBilling({
    apiKey: "sk_test_1",
    webhookSecret: WEBHOOK_SECRET,
    planOfPrice: (id) => (id === "price_team" ? "team" : undefined),
    fetch: (async (url: string, init: RequestInit) => {
      sent.push({ url, body: new URLSearchParams(String(init.body)) });
      return new Response(JSON.stringify({ id: "cs_1", url: "https://pay.example/c/cs_1" }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  const p = await plane({ billing });
  const s = site(p);
  const now = new Date(p.clock.now);
  const deliver = (body: Buffer) => s.call("POST", "/webhooks/billing", { raw: body.toString("utf8"), type: "application/json", ...origins, headers: { "stripe-signature": signWebhook(WEBHOOK_SECRET, body, now) } });

  await s.call("POST", "/api/signup", { json: { email: "ada@example.com", password: PASSWORD }, ...origins });
  const verified = await s.call("POST", "/api/verify", { json: { token: tokenIn(p.mailer.sent[0]!.text) }, ...origins });
  const session = cookieSet(verified).value;
  const accountId = verified.json.account.accountId as string;
  assert.deepEqual(verified.json.account.workspaces, []);
  assert.equal(verified.json.account.subscription, null);

  assert.deepEqual(await s.call("POST", "/api/workspaces", { json: { name: "Main" }, session }).then((r) => r.json.error.code), "no_subscription");
  const checkout = await s.call("POST", "/api/checkout", { json: { purpose: "subscription", plan: "team" }, session });
  assert.deepEqual([checkout.status, checkout.json], [200, { url: "https://pay.example/c/cs_1" }]);
  assert.equal(sent[0]!.url, "https://api.stripe.com/v1/checkout/sessions");
  assert.equal(sent[0]!.body.get("client_reference_id"), accountId);
  assert.equal(sent[0]!.body.get("line_items[0][price]"), "price_team");

  const start = Math.floor(now.getTime() / 1000);
  assert.deepEqual((await deliver(bytes("checkout.session.completed", { id: "cs_1", client_reference_id: accountId, customer: "cus_1", mode: "subscription", payment_status: "paid" }, now, "evt_1"))).json, { received: true, events: 1, applied: 1 });
  assert.deepEqual(
    (await deliver(bytes("invoice.paid", { id: "in_1", customer: "cus_1", subscription: "sub_1", amount_paid: 14_900, currency: "usd", lines: { data: [{ price: { id: "price_team" }, period: { start, end: start + 30 * 86_400 } }] } }, now, "evt_2"))).json,
    { received: true, events: 1, applied: 1 },
  );

  const me = await s.call("GET", "/api/me", { session });
  assert.deepEqual([me.json.account.subscription.plan, me.json.account.subscription.status], ["team", "active"]);
  assert.equal(me.json.balance.balance.included, 20_000_000, "the plan's usage is there as soon as the payment is");

  const made = await s.call("POST", "/api/workspaces", { json: { name: "Main" }, session });
  assert.equal(made.status, 201);
  await p.plane.workspaces.idle();
  const open = await s.call("POST", `/api/workspaces/${made.json.workspace.workspaceId}/open`, { session });
  assert.match(open.json.url, /^https:\/\/main-[0-9a-f]{6}\.ws\.example\.com\/__enter\?code=[A-Za-z0-9_-]+$/);
  assert.equal(p.provisioner.ops("create")[0]!.spec!.accountId, accountId);
});
