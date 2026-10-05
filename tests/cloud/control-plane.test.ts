import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  BillingProviderError,
  BillingUnsupportedError,
  BillingWebhookError,
  HostedCheckoutBilling,
  ServiceError,
  signWebhook,
} from "../../packages/cloud/src/index";
import { chatBody, spends } from "../ai-gateway/support";
import { RecordingBilling, plane, running, type Plane } from "./support";

const DAY = 86_400_000;
const at = (p: Plane): string => new Date(p.clock.now).toISOString();
const refusal = async (promise: Promise<unknown>): Promise<ServiceError> => {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof ServiceError, String(err));
    return err;
  }
  throw new Error("it was accepted");
};

const key = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 32);

test("what a customer sees of an account is its address, its plan and its workspaces, with nothing secret in it", async () => {
  const { p, ada, workspaceId } = await running();
  const view = p.plane.view(p.log.state.accounts.get(ada.accountId)!);
  assert.deepEqual(view, {
    accountId: ada.accountId,
    email: "ada@example.com",
    createdAt: "2026-10-05T12:00:00.000Z",
    subscription: { plan: "team", title: "Team", status: "active", periodEnd: "2026-11-05T12:00:00.000Z" },
    workspaces: [{ workspaceId, name: "Main", slug: p.log.state.workspaces.get(workspaceId)!.slug, plan: "team", status: "running", host: `${p.log.state.workspaces.get(workspaceId)!.slug}.ws.example.com` }],
  });
  const text = JSON.stringify(view);
  for (const secret of [p.log.state.accounts.get(ada.accountId)!.passwordHash, p.log.state.workspaces.get(workspaceId)!.gatewayKeyId!, p.provisioner.ops("create")[0]!.spec!.operatorToken]) assert.ok(!text.includes(secret));
});

test("an account with no plan has no subscription in its view, one that is late says since when, and a stopped workspace says why", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  assert.deepEqual(p.plane.view(p.log.state.accounts.get(ada.accountId)!).subscription, null);
  assert.deepEqual(p.plane.view(p.log.state.accounts.get(ada.accountId)!).workspaces, []);
  await p.subscribe(ada.accountId);
  await p.plane.billing.apply({ type: "payment.failed", ref: "in_f", accountId: ada.accountId, at: at(p) });
  assert.deepEqual(p.plane.view(p.log.state.accounts.get(ada.accountId)!).subscription, { plan: "team", title: "Team", status: "past_due", periodEnd: "2026-11-05T12:00:00.000Z", pastDueSince: "2026-10-05T12:00:00.000Z" });
  await p.log.append({ type: "subscription.changed", accountId: ada.accountId, plan: "legacy", status: "active", reason: "test" });
  assert.equal(p.plane.view(p.log.state.accounts.get(ada.accountId)!).subscription!.title, "legacy", "a plan that is no longer offered is shown by its id");
  const q = await running();
  await q.p.plane.workspaces.suspend(q.workspaceId, "paused by its owner", q.ada.accountId);
  assert.equal(q.p.plane.view(q.p.log.state.accounts.get(q.ada.accountId)!).workspaces[0]!.statusReason, "paused by its owner");
});

test("a workspace that was deleted is not in the view", async () => {
  const { p, ada, workspaceId } = await running();
  await p.plane.workspaces.destroy(workspaceId, ada.accountId);
  assert.deepEqual(p.plane.view(p.log.state.accounts.get(ada.accountId)!).workspaces, []);
});

test("the balance is what the gateway says, in the gateway's currency, without what is held back", async () => {
  const { p, ada } = await running();
  await p.plane.billing.apply({ type: "payment.succeeded", ref: "pi_1", purpose: "topup", accountId: ada.accountId, amountMinor: 1_000, currency: "USD", at: at(p) });
  p.gatewayCore.hold(ada.accountId, 3_000_000);
  assert.deepEqual(await p.plane.balance(ada.accountId), { currency: "USD", balance: { included: 20_000_000, purchased: 10_000_000, total: 30_000_000, available: 27_000_000 }, charged: 0 });
});

// ---- checkout ----

test("a checkout for a plan names the plan and the account, and sends the customer back to the account page, with a key that is the same for the same request the same day", async () => {
  const billing = new RecordingBilling();
  const p = await plane({ billing });
  const ada = await p.account("ada@example.com");
  const out = await p.plane.startCheckout(ada.accountId, { purpose: "subscription", plan: "team" });
  const [input] = billing.checkouts;
  const expectedKey = key(`${ada.accountId}:subscription:team:2026-10-05`);
  assert.deepEqual(out, { url: `https://pay.example/c/${expectedKey}` }, "the customer is sent to the page, and the provider's own reference stays here");
  assert.deepEqual(input, {
    accountId: ada.accountId,
    email: "ada@example.com",
    purpose: "subscription",
    plan: { id: "team", title: "Team", priceMinor: 14_900, period: "month", providerPriceId: "price_team" },
    currency: "USD",
    successUrl: "https://app.example.com/account?paid=1",
    cancelUrl: "https://app.example.com/account?cancelled=1",
    idempotencyKey: expectedKey,
  });
  await p.plane.startCheckout(ada.accountId, { purpose: "subscription", plan: "team" });
  assert.equal(billing.checkouts[1]!.idempotencyKey, expectedKey, "asking again is the same checkout");
  p.clock.advance(DAY);
  await p.plane.startCheckout(ada.accountId, { purpose: "subscription", plan: "team" });
  assert.notEqual(billing.checkouts[2]!.idempotencyKey, expectedKey, "and tomorrow it is a new one");
  await p.plane.startCheckout(ada.accountId, { purpose: "subscription", plan: "business" });
  assert.equal(billing.checkouts[3]!.plan!.providerPriceId, undefined, "a plan with no provider price sends none");
  assert.notEqual(billing.checkouts[3]!.idempotencyKey, billing.checkouts[2]!.idempotencyKey);
});

test("a checkout for a top-up names the amount, and its key changes with the hour and the amount", async () => {
  const billing = new RecordingBilling();
  const p = await plane({ billing });
  const ada = await p.account("ada@example.com");
  await p.plane.startCheckout(ada.accountId, { purpose: "topup", amountMinor: 2_500 });
  const [input] = billing.checkouts;
  assert.deepEqual(input, {
    accountId: ada.accountId,
    email: "ada@example.com",
    purpose: "topup",
    amountMinor: 2_500,
    currency: "USD",
    successUrl: "https://app.example.com/account?paid=1",
    cancelUrl: "https://app.example.com/account?cancelled=1",
    idempotencyKey: key(`${ada.accountId}:topup:2500:2026-10-05T12`),
  });
  await p.plane.startCheckout(ada.accountId, { purpose: "topup", amountMinor: 2_500 });
  assert.equal(billing.checkouts[1]!.idempotencyKey, input!.idempotencyKey);
  await p.plane.startCheckout(ada.accountId, { purpose: "topup", amountMinor: 1_000 });
  assert.notEqual(billing.checkouts[2]!.idempotencyKey, input!.idempotencyKey);
  p.clock.advance(3_600_000);
  await p.plane.startCheckout(ada.accountId, { purpose: "topup", amountMinor: 2_500 });
  assert.notEqual(billing.checkouts[3]!.idempotencyKey, input!.idempotencyKey);
});

test("the return addresses are built from the app's address whether or not it ends in a slash", async () => {
  const billing = new RecordingBilling();
  const p = await plane({ billing });
  (p.plane.o as { appUrl: string }).appUrl = "https://app.example.com///";
  const ada = await p.account("ada@example.com");
  await p.plane.startCheckout(ada.accountId, { purpose: "topup", amountMinor: 1_000 });
  assert.equal(billing.checkouts[0]!.successUrl, "https://app.example.com/account?paid=1");
  await p.plane.openPortal(ada.accountId);
  assert.equal(billing.portals[0]!.returnUrl, "https://app.example.com/account");
});

test("a checkout that cannot be made says why: an unknown plan, the plan the account is on, an amount that cannot be bought, or something that is neither", async () => {
  const billing = new RecordingBilling();
  const p = await plane({ billing });
  const ada = await p.account("ada@example.com");
  const unknown = await refusal(p.plane.startCheckout(ada.accountId, { purpose: "subscription", plan: "platinum" }));
  assert.deepEqual([unknown.status, unknown.code, unknown.message], [400, "unknown_plan", "That plan is not on offer."]);
  for (const plan of [undefined, 5, null, ""]) assert.equal((await refusal(p.plane.startCheckout(ada.accountId, { purpose: "subscription", plan }))).code, "unknown_plan");
  await p.subscribe(ada.accountId, "team");
  const same = await refusal(p.plane.startCheckout(ada.accountId, { purpose: "subscription", plan: "team" }));
  assert.deepEqual([same.status, same.code, same.message], [409, "already_subscribed", "You are already on that plan."]);
  await p.plane.startCheckout(ada.accountId, { purpose: "subscription", plan: "business" });
  assert.equal(billing.checkouts.length, 1, "another plan is a change, which is allowed");
  await p.plane.billing.apply({ type: "payment.failed", ref: "in_f", accountId: ada.accountId, at: at(p) });
  await p.plane.startCheckout(ada.accountId, { purpose: "subscription", plan: "team" });
  assert.equal(billing.checkouts.length, 2, "a plan that is late can be paid for again");

  for (const amount of [499, 100_001, 0, -500, 1_000.5, "1000", null, undefined, Number.NaN]) {
    const e = await refusal(p.plane.startCheckout(ada.accountId, { purpose: "topup", amountMinor: amount }));
    assert.deepEqual([e.status, e.code, e.message], [400, "invalid_amount", "That amount cannot be bought."], String(amount));
  }
  await p.plane.startCheckout(ada.accountId, { purpose: "topup", amountMinor: 500 });
  await p.plane.startCheckout(ada.accountId, { purpose: "topup", amountMinor: 100_000 });
  assert.equal(billing.checkouts.length, 4, "the smallest and the largest amounts are allowed");
  for (const purpose of [undefined, "gift", 7]) assert.deepEqual(((e) => [e.status, e.code])(await refusal(p.plane.startCheckout(ada.accountId, { purpose }))), [400, "invalid_purpose"], String(purpose));
});

test("only an account that is confirmed and not stopped can buy anything", async () => {
  const billing = new RecordingBilling();
  const p = await plane({ billing });
  assert.equal((await refusal(p.plane.startCheckout("acct_nobody", { purpose: "topup", amountMinor: 1_000 }))).code, "not_allowed");
  await p.plane.accounts.signup("new@example.com", "correct horse battery staple");
  const unconfirmed = [...p.log.state.accounts.values()][0]!;
  assert.equal((await refusal(p.plane.startCheckout(unconfirmed.accountId, { purpose: "topup", amountMinor: 1_000 }))).code, "not_allowed");
  const ada = await p.account("ada@example.com");
  await p.plane.disableAccount(ada.accountId, "abuse");
  const e = await refusal(p.plane.startCheckout(ada.accountId, { purpose: "topup", amountMinor: 1_000 }));
  assert.deepEqual([e.status, e.code, e.message], [403, "not_allowed", "This account cannot buy anything."]);
  assert.equal(billing.checkouts.length, 0);
});

test("a provider that fails is a 502 the customer can retry, and a refusal the control plane itself raised passes through", async () => {
  const billing = new RecordingBilling();
  const p = await plane({ billing });
  const ada = await p.account("ada@example.com");
  billing.failWith = new BillingProviderError("the payment provider refused the request: invalid price", 400);
  const e = await refusal(p.plane.startCheckout(ada.accountId, { purpose: "topup", amountMinor: 1_000 }));
  assert.deepEqual([e.status, e.code, e.message], [502, "billing_unavailable", "The payment page could not be opened. Try again in a moment."]);
  assert.ok(!e.message.includes("invalid price"), "the provider's words are not the customer's");
  billing.failWith = new ServiceError(429, "slow_down", "Wait.");
  assert.equal((await refusal(p.plane.startCheckout(ada.accountId, { purpose: "topup", amountMinor: 1_000 }))).code, "slow_down");
});

test("the billing page goes to the provider's portal for the customer the account was linked to, and says when there is none to open", async () => {
  const billing = new RecordingBilling();
  const p = await plane({ billing });
  const ada = await p.account("ada@example.com");
  assert.deepEqual(await p.plane.openPortal(ada.accountId), { url: "https://pay.example/portal" });
  assert.deepEqual(billing.portals[0], { accountId: ada.accountId, returnUrl: "https://app.example.com/account" }, "no customer yet, so none is named");
  await p.plane.billing.apply({ type: "customer.linked", ref: "link_1", accountId: ada.accountId, customerRef: "cus_1", at: at(p) });
  await p.plane.openPortal(ada.accountId);
  assert.deepEqual(billing.portals[1], { accountId: ada.accountId, customerRef: "cus_1", returnUrl: "https://app.example.com/account" });
  assert.equal((await refusal(p.plane.openPortal("acct_nobody"))).status, 404);
  billing.failWith = new BillingUnsupportedError("There is no portal.");
  const none = await refusal(p.plane.openPortal(ada.accountId));
  assert.deepEqual([none.status, none.code, none.message], [409, "no_portal", "There is no portal."]);
  billing.failWith = new BillingProviderError("down");
  const down = await refusal(p.plane.openPortal(ada.accountId));
  assert.deepEqual([down.status, down.code, down.message], [502, "billing_unavailable", "The billing page could not be opened. Try again in a moment."]);
  billing.failWith = new ServiceError(418, "teapot", "Short and stout.");
  assert.equal((await refusal(p.plane.openPortal(ada.accountId))).code, "teapot");
});

test("the manual provider's checkout sends the customer to the operator's page with a reference, and its portal is not there", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  const out = await p.plane.startCheckout(ada.accountId, { purpose: "topup", amountMinor: 1_000 });
  assert.match(out.url, /^https:\/\/app\.example\.com\/pay\?ref=manual_[0-9a-f]{32}$/);
  const portal = await refusal(p.plane.openPortal(ada.accountId));
  assert.deepEqual([portal.status, portal.code], [409, "no_portal"]);
});

// ---- the provider's messages ----

const SECRET = "whsec_test";
function hosted() {
  return new HostedCheckoutBilling({ apiKey: "sk_test", webhookSecret: SECRET, fetch: (async () => new Response("{}")) as unknown as typeof fetch, planOfPrice: (price) => (price === "price_team" ? "team" : undefined) });
}
const message = (type: string, object: Record<string, unknown>, id = `evt_${Math.random().toString(36).slice(2)}`, created = Math.floor(Date.parse("2026-10-05T12:00:00.000Z") / 1000)): Buffer => Buffer.from(JSON.stringify({ id, type, created, data: { object } }));
const signedFor = (p: Plane, body: Buffer, when = new Date(p.clock.now)): Record<string, string> => ({ "stripe-signature": signWebhook(SECRET, body, when) });

test("a provider's message is checked, read and applied, and the same message again is read and applied to nothing", async () => {
  const p = await plane({ billing: hosted() });
  const ada = await p.account("ada@example.com");
  const body = message("checkout.session.completed", { id: "cs_1", client_reference_id: ada.accountId, customer: "cus_1", mode: "payment", payment_status: "paid", payment_intent: "pi_1", amount_total: 2_500, currency: "usd" }, "evt_1");
  assert.deepEqual(await p.plane.handleWebhook(signedFor(p, body), body), { events: 2, applied: 2 });
  assert.equal((await p.gateway.account(ada.accountId)).balance.purchased, 25_000_000);
  assert.equal(p.log.state.accounts.get(ada.accountId)!.customers["hosted-checkout"], "cus_1");
  assert.deepEqual(await p.plane.handleWebhook(signedFor(p, body), body), { events: 2, applied: 0 }, "a provider that sends a message twice is harmless");
  assert.equal((await p.gateway.account(ada.accountId)).balance.purchased, 25_000_000);
  const ignored = message("customer.created", {});
  assert.deepEqual(await p.plane.handleWebhook(signedFor(p, ignored), ignored), { events: 0, applied: 0 });
});

test("a message that is not from the provider is refused before it is read, and changes nothing", async () => {
  const p = await plane({ billing: hosted() });
  const ada = await p.account("ada@example.com");
  const body = message("checkout.session.completed", { client_reference_id: ada.accountId, mode: "payment", payment_status: "paid", payment_intent: "pi_1", amount_total: 2_500, currency: "usd" });
  await assert.rejects(() => p.plane.handleWebhook({}, body), BillingWebhookError);
  await assert.rejects(() => p.plane.handleWebhook({ "stripe-signature": signWebhook("another secret", body, new Date(p.clock.now)) }, body), /the signature does not match/);
  await assert.rejects(() => p.plane.handleWebhook(signedFor(p, body, new Date(p.clock.now - 10 * 60_000)), body), /too old or too new/, "the service's clock decides how old a message is");
  assert.equal((await p.gateway.account(ada.accountId)).balance.total, 0);
  assert.equal(p.log.state.applied.size, 0);
});

test("a subscription's life through the provider's messages: the invoice credits and activates, a failure makes it late, a message that names only the customer finds the account, and a cancellation stops it", async () => {
  const p = await plane({ billing: hosted() });
  const ada = await p.account("ada@example.com");
  const link = message("checkout.session.completed", { id: "cs_1", client_reference_id: ada.accountId, customer: "cus_1", mode: "subscription" });
  await p.plane.handleWebhook(signedFor(p, link), link);
  const start = Math.floor(p.clock.now / 1000);
  const paid = message("invoice.paid", { id: "in_1", customer: "cus_1", subscription: "sub_1", amount_paid: 14_900, currency: "usd", lines: { data: [{ price: { id: "price_team" }, period: { start, end: start + 30 * 86_400 } }] } });
  assert.deepEqual(await p.plane.handleWebhook(signedFor(p, paid), paid), { events: 1, applied: 1 });
  const subscription = p.log.state.accounts.get(ada.accountId)!.subscription!;
  assert.deepEqual([subscription.plan, subscription.status, subscription.subscriptionRef, subscription.periodEnd], ["team", "active", "sub_1", new Date((start + 30 * 86_400) * 1000).toISOString()]);
  assert.equal((await p.gateway.account(ada.accountId)).balance.included, 20_000_000);
  const failed = message("invoice.payment_failed", { id: "in_2", customer: "cus_1", subscription: "sub_1" });
  await p.plane.handleWebhook(signedFor(p, failed), failed);
  assert.equal(p.log.state.accounts.get(ada.accountId)!.subscription!.status, "past_due");
  const ended = message("customer.subscription.deleted", { id: "sub_1", customer: "cus_1" });
  await p.plane.handleWebhook(signedFor(p, ended), ended);
  assert.equal(p.log.state.accounts.get(ada.accountId)!.subscription!.status, "ended");
});

test("a refund message takes back the credit it bought, and a second one that reports the same total takes back nothing more", async () => {
  const p = await plane({ billing: hosted() });
  const ada = await p.account("ada@example.com");
  const paid = message("checkout.session.completed", { client_reference_id: ada.accountId, mode: "payment", payment_status: "paid", payment_intent: "pi_1", amount_total: 2_500, currency: "usd" });
  await p.plane.handleWebhook(signedFor(p, paid), paid);
  const refund = (id: string, total: number): Buffer => message("charge.refunded", { id: "ch_1", payment_intent: "pi_1", amount_refunded: total, currency: "usd", customer: "cus_x" }, id);
  await p.plane.billing.apply({ type: "customer.linked", ref: "link_x", accountId: ada.accountId, customerRef: "cus_x", at: at(p) });
  const first = refund("evt_r1", 1_000);
  assert.deepEqual(await p.plane.handleWebhook(signedFor(p, first), first), { events: 1, applied: 1 });
  const again = refund("evt_r2", 1_000);
  assert.deepEqual(await p.plane.handleWebhook(signedFor(p, again), again), { events: 1, applied: 0 });
  assert.equal((await p.gateway.account(ada.accountId)).balance.purchased, 15_000_000);
});

// ---- the operator ----

test("a payment the operator records by hand is applied as a provider's message is, under a reference of its own, and the action is written down", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  assert.deepEqual(await p.plane.recordPayment({ accountId: ada.accountId, purpose: "topup", amountMinor: 5_000, currency: "USD", ref: "wire-77", note: "bank transfer" }), { applied: true });
  assert.equal((await p.gateway.account(ada.accountId)).balance.purchased, 50_000_000);
  assert.equal(p.log.state.applied.has("payment.succeeded:manual_wire-77"), true);
  const action = p.store.entries.find((e) => e.type === "owner.action")!;
  assert.deepEqual({ action: (action as { action: string }).action, detail: (action as { detail: string }).detail }, { action: "payment.recorded", detail: `topup 5000 USD for ${ada.accountId}, ref wire-77, bank transfer` });
  assert.deepEqual(await p.plane.recordPayment({ accountId: ada.accountId, purpose: "topup", amountMinor: 5_000, currency: "USD", ref: "wire-77" }), { applied: false, note: "duplicate" });
  assert.equal((await p.gateway.account(ada.accountId)).balance.purchased, 50_000_000, "recorded twice, credited once");
  assert.equal(p.store.entries.filter((e) => e.type === "owner.action").length, 2);
  assert.equal((p.store.entries.filter((e) => e.type === "owner.action")[1] as { detail: string }).detail, `topup 5000 USD for ${ada.accountId}, ref wire-77`);
});

test("a plan paid for by invoice is recorded as a period, and a payment for an account that is not there is left for the operator to read", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  assert.deepEqual(await p.plane.recordPayment({ accountId: ada.accountId, purpose: "subscription", plan: "business", amountMinor: 59_900, currency: "USD", ref: "inv-2026-10" }), { applied: true });
  assert.equal(p.log.state.accounts.get(ada.accountId)!.subscription!.plan, "business");
  assert.equal((await p.gateway.account(ada.accountId)).balance.included, 100_000_000);
  assert.deepEqual(await p.plane.recordPayment({ accountId: "acct_nobody", purpose: "topup", amountMinor: 100, currency: "USD", ref: "x" }), { applied: false, note: "unmatched" });
  assert.deepEqual(
    p.plane.unmatched().map((u) => u.key),
    ["payment.succeeded:manual_x"],
  );
});

test("stopping an account ends its sessions and its running workspaces, says why, and is written down; starting it again does not start them", async () => {
  const { p, ada, workspace } = await running();
  assert.equal((await refusal(p.plane.disableAccount("acct_nobody", "x"))).status, 404);
  assert.equal((await refusal(p.plane.enableAccount("acct_nobody"))).status, 404);
  await p.plane.disableAccount(ada.accountId, "abuse report 12");
  assert.equal(p.log.state.accounts.get(ada.accountId)!.disabledReason, "abuse report 12");
  assert.equal(p.plane.accounts.authenticate(ada.sessionToken), undefined);
  assert.equal(workspace().status, "suspended");
  assert.equal(workspace().statusReason, "the account was stopped: abuse report 12");
  const actions = p.store.entries.filter((e) => e.type === "owner.action") as Array<{ action: string; detail: string }>;
  assert.deepEqual(actions.map((a) => [a.action, a.detail]), [["account.disabled", `${ada.accountId}: abuse report 12`]]);
  await p.plane.enableAccount(ada.accountId);
  assert.equal(p.log.state.accounts.get(ada.accountId)!.disabledAt, undefined);
  assert.equal(workspace().status, "suspended", "the owner starts it again when they have looked at it");
  assert.deepEqual(
    (p.store.entries.filter((e) => e.type === "owner.action") as Array<{ action: string }>).map((a) => a.action),
    ["account.disabled", "account.enabled"],
  );
  await p.plane.workspaces.resume(workspace().workspaceId, ada.accountId);
  assert.equal(workspace().status, "running");
});

// ---- the money ----

test("the operator's view of the money is what came in, by currency and kind, with refunds, and what the models cost for the same time", async () => {
  const { p, ada } = await running();
  const clock = p.clock;
  await p.plane.billing.apply({ type: "payment.succeeded", ref: "pi_1", purpose: "topup", accountId: ada.accountId, amountMinor: 2_500, currency: "USD", at: at(p) });
  clock.advance(DAY);
  await p.plane.billing.apply({ type: "payment.refunded", ref: "re_1", paymentRef: "pi_1", accountId: ada.accountId, amountMinor: 1_000, currency: "USD", at: at(p) });
  await p.plane.billing.apply({ type: "payment.refunded", ref: "re_2", paymentRef: "pi_1", accountId: ada.accountId, amountMinor: 1_500, currency: "USD", at: at(p) });
  await p.plane.billing.apply({ type: "payment.succeeded", ref: "pi_eur", purpose: "topup", accountId: ada.accountId, amountMinor: 9_999, currency: "EUR", at: at(p) });
  await p.plane.billing.apply({ type: "payment.succeeded", ref: "pi_lost", purpose: "topup", accountId: "acct_nobody", amountMinor: 8_888, currency: "USD", at: at(p) });
  const minted = await p.gateway.createKey({ accountId: ada.accountId, workspaceId: "ws_x" });
  const keyRecord = p.gatewayCore.authenticate(`Bearer ${minted.token}`);
  const out = await p.gatewayRig.call(chatBody({ model: "fast", stream: false }), keyRecord);
  assert.equal(out.completion?.status, 200);
  const spent = spends(p.gatewayRig.store)[0]!;

  const report = await p.plane.margin();
  assert.deepEqual(report.revenue, { USD: { subscription: 14_900, topup: 2_500, refunded: 1_500 } }, "refunds are what the provider reports in all, counted once; unmatched and foreign-currency payments are not revenue");
  assert.deepEqual(report.usage, { currency: "USD", chargedMicros: spent.chargeMicros, costMicros: spent.costMicros, marginMicros: spent.chargeMicros - spent.costMicros, calls: 1, failed: 0 });
  assert.ok(spent.chargeMicros > 0);
});

test("the money is reported for a period: from is included and to is not, for payments and for refunds counted as what each adds", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  const day1 = at(p);
  await p.plane.billing.apply({ type: "payment.succeeded", ref: "pi_1", purpose: "topup", accountId: ada.accountId, amountMinor: 2_000, currency: "USD", at: day1 });
  p.clock.advance(DAY);
  const day2 = at(p);
  await p.plane.billing.apply({ type: "payment.succeeded", ref: "pi_2", purpose: "topup", accountId: ada.accountId, amountMinor: 3_000, currency: "USD", at: day2 });
  await p.plane.billing.apply({ type: "payment.refunded", ref: "re_1", paymentRef: "pi_1", accountId: ada.accountId, amountMinor: 500, currency: "USD", at: day2 });
  p.clock.advance(DAY);
  const day3 = at(p);
  await p.plane.billing.apply({ type: "payment.refunded", ref: "re_2", paymentRef: "pi_1", accountId: ada.accountId, amountMinor: 800, currency: "USD", at: day3 });
  const revenue = async (from?: string, to?: string) => (await p.plane.margin(from, to)).revenue.USD ?? { subscription: 0, topup: 0, refunded: 0 };
  assert.deepEqual(await revenue(), { subscription: 0, topup: 5_000, refunded: 800 });
  assert.deepEqual(await revenue(day2), { subscription: 0, topup: 3_000, refunded: 800 }, "from is included");
  assert.deepEqual(await revenue(undefined, day2), { subscription: 0, topup: 2_000, refunded: 0 }, "to is not");
  assert.deepEqual(await revenue(day2, day3), { subscription: 0, topup: 3_000, refunded: 500 });
  assert.deepEqual(await revenue(day3), { subscription: 0, topup: 0, refunded: 300 }, "the second refund reported 800 in all, of which 500 was counted already");
  assert.deepEqual((await p.plane.margin("2027-01-01")).revenue, {}, "a period with nothing in it has no rows");
});
