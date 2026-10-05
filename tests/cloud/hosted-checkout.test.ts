import { test } from "node:test";
import assert from "node:assert/strict";
import { BillingProviderError, BillingUnsupportedError, BillingWebhookError, HostedCheckoutBilling, formEncode, signWebhook, type CheckoutInput } from "../../packages/cloud/src/index";

const SECRET = "whsec_test_secret";
const NOW = new Date("2026-10-05T12:00:00.000Z");

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: URLSearchParams;
}

/** A provider that answers as the documented API does, and remembers what it was asked. */
function provider(answer: (seen: Seen) => { status?: number; body: unknown } | Error, options: { baseUrl?: string; planOfPrice?: (p: string) => string | undefined; toleranceSeconds?: number } = {}) {
  const requests: Seen[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const seen: Seen = { url, method: String(init.method), headers: init.headers as Record<string, string>, body: new URLSearchParams(String(init.body ?? "")) };
    requests.push(seen);
    const out = answer(seen);
    if (out instanceof Error) throw out;
    return new Response(typeof out.body === "string" ? out.body : JSON.stringify(out.body), { status: out.status ?? 200 });
  }) as unknown as typeof fetch;
  return { requests, billing: new HostedCheckoutBilling({ apiKey: "sk_test_123", webhookSecret: SECRET, fetch: fetchImpl, ...options }) };
}

const subscription: CheckoutInput = {
  accountId: "acct_1",
  email: "ada@example.com",
  purpose: "subscription",
  plan: { id: "team", title: "Team", priceMinor: 14_900, period: "month", providerPriceId: "price_team" },
  currency: "USD",
  successUrl: "https://app.example.com/account?paid=1",
  cancelUrl: "https://app.example.com/account?cancelled=1",
  idempotencyKey: "key-1",
};

const topup: CheckoutInput = { accountId: "acct_1", email: "ada@example.com", purpose: "topup", amountMinor: 2_500, currency: "USD", successUrl: "https://app/ok", cancelUrl: "https://app/no", idempotencyKey: "key-2" };

test("form encoding writes nested values as the provider reads them, and leaves out what is not there", () => {
  assert.equal(formEncode({ a: 1, b: "x y", c: { d: "e", f: [1, 2] }, g: undefined, h: null }), "a=1&b=x%20y&c%5Bd%5D=e&c%5Bf%5D%5B0%5D=1&c%5Bf%5D%5B1%5D=2");
  assert.equal(formEncode({ items: [{ price: "p", quantity: 1 }] }), "items%5B0%5D%5Bprice%5D=p&items%5B0%5D%5Bquantity%5D=1");
  assert.equal(formEncode({}), "");
});

test("a subscription checkout asks the provider for a hosted page for the plan's price, with the account as the reference, and returns where to send the customer", async () => {
  const p = provider(() => ({ body: { id: "cs_test_1", url: "https://pay.example/c/cs_test_1" } }));
  assert.deepEqual(await p.billing.createCheckout(subscription), { url: "https://pay.example/c/cs_test_1", ref: "cs_test_1" });
  const [seen] = p.requests;
  assert.equal(seen!.url, "https://api.stripe.com/v1/checkout/sessions");
  assert.equal(seen!.method, "POST");
  assert.equal(seen!.headers.authorization, "Bearer sk_test_123");
  assert.equal(seen!.headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(seen!.headers["idempotency-key"], "key-1", "asking twice for the same thing gives the same checkout");
  const form = Object.fromEntries(seen!.body);
  assert.deepEqual(form, {
    mode: "subscription",
    "line_items[0][price]": "price_team",
    "line_items[0][quantity]": "1",
    "subscription_data[metadata][accountId]": "acct_1",
    "subscription_data[metadata][purpose]": "subscription",
    "subscription_data[metadata][plan]": "team",
    success_url: "https://app.example.com/account?paid=1",
    cancel_url: "https://app.example.com/account?cancelled=1",
    client_reference_id: "acct_1",
    customer_email: "ada@example.com",
    "metadata[accountId]": "acct_1",
    "metadata[purpose]": "subscription",
    "metadata[plan]": "team",
  });
});

test("a top-up checkout is a one-off payment for the amount, in the account's currency, with nothing but the amount sent as a price", async () => {
  const p = provider(() => ({ body: { id: "cs_test_2", url: "https://pay.example/c/cs_test_2" } }));
  await p.billing.createCheckout(topup);
  const form = Object.fromEntries(p.requests[0]!.body);
  assert.equal(form.mode, "payment");
  assert.equal(form["line_items[0][quantity]"], "1");
  assert.equal(form["line_items[0][price_data][currency]"], "usd");
  assert.equal(form["line_items[0][price_data][unit_amount]"], "2500");
  assert.equal(form["line_items[0][price_data][product_data][name]"], "Model usage credit");
  assert.equal(form["payment_intent_data[metadata][accountId]"], "acct_1");
  assert.equal(form["payment_intent_data[metadata][purpose]"], "topup");
  assert.equal(form["payment_intent_data[metadata][plan]"], undefined);
  assert.equal(form.client_reference_id, "acct_1");
  assert.equal(p.requests[0]!.headers["idempotency-key"], "key-2");
});

test("a checkout that cannot be made is refused before the provider is asked", async () => {
  const p = provider(() => ({ body: {} }));
  await assert.rejects(() => p.billing.createCheckout({ ...subscription, plan: undefined }), /a subscription checkout needs a plan/);
  await assert.rejects(() => p.billing.createCheckout({ ...subscription, plan: { ...subscription.plan!, providerPriceId: undefined } }), /plan 'team' has no provider_price_id/);
  await assert.rejects(() => p.billing.createCheckout({ ...topup, amountMinor: undefined }), /a top-up checkout needs an amount/);
  await assert.rejects(() => p.billing.createCheckout({ ...topup, amountMinor: 0 }), /a top-up checkout needs an amount/);
  await assert.rejects(() => p.billing.createCheckout({ ...topup, amountMinor: 12.5 }), /a top-up checkout needs an amount/);
  assert.equal(p.requests.length, 0);
});

test("a provider that refuses, cannot be reached or answers with no page is an error that says so, with the provider's own words kept short", async () => {
  const refused = provider(() => ({ status: 402, body: { error: { message: "x".repeat(500) } } }));
  await assert.rejects(
    () => refused.billing.createCheckout(topup),
    (err: BillingProviderError) => err instanceof BillingProviderError && err.status === 402 && err.message === `the payment provider refused the request: ${"x".repeat(200)}`,
  );
  const plain = provider(() => ({ status: 500, body: "<html>bad gateway</html>" }));
  await assert.rejects(() => plain.billing.createCheckout(topup), (err: BillingProviderError) => err.status === 500 && /refused the request: status 500/.test(err.message));
  const down = provider(() => new Error("ECONNRESET"));
  await assert.rejects(() => down.billing.createCheckout(topup), (err: BillingProviderError) => /the payment provider could not be reached \(ECONNRESET\)/.test(err.message) && err.status === undefined);
  for (const body of [{}, { id: "cs_1" }, { url: "https://pay.example/c/1" }, { id: "", url: "" }, "not json"]) {
    const empty = provider(() => ({ body }));
    await assert.rejects(() => empty.billing.createCheckout(topup), /answered without a checkout address/, JSON.stringify(body));
  }
});

test("the API address can be set, and a trailing slash on it does no harm", async () => {
  const p = provider(() => ({ body: { id: "cs", url: "https://pay.example/c" } }), { baseUrl: "https://api.pay.example///" });
  await p.billing.createCheckout(topup);
  assert.equal(p.requests[0]!.url, "https://api.pay.example/v1/checkout/sessions");
});

test("the customer portal needs a customer, and goes to the provider's page for them", async () => {
  const p = provider(() => ({ body: { url: "https://pay.example/portal/1" } }));
  assert.deepEqual(await p.billing.openPortal({ accountId: "acct_1", customerRef: "cus_1", returnUrl: "https://app.example.com/account" }), { url: "https://pay.example/portal/1" });
  assert.equal(p.requests[0]!.url, "https://api.stripe.com/v1/billing_portal/sessions");
  assert.deepEqual(Object.fromEntries(p.requests[0]!.body), { customer: "cus_1", return_url: "https://app.example.com/account" });
  assert.equal(p.requests[0]!.headers["idempotency-key"], undefined);
  await assert.rejects(() => p.billing.openPortal({ accountId: "acct_1", returnUrl: "https://app" }), (err: Error) => err instanceof BillingUnsupportedError && err.message === "There is nothing to manage yet: no payment has been made on this account.");
  assert.equal(p.requests.length, 1, "the provider is not asked about a customer that does not exist");
  const none = provider(() => ({ body: {} }));
  await assert.rejects(() => none.billing.openPortal({ accountId: "acct_1", customerRef: "cus_1", returnUrl: "https://app" }), /answered without a portal address/);
});

// ---- messages from the provider ----

const message = (type: string, object: Record<string, unknown>, extra: Record<string, unknown> = {}): Buffer => Buffer.from(JSON.stringify({ id: "evt_1", type, created: Math.floor(NOW.getTime() / 1000), data: { object }, ...extra }));
const signed = (body: Buffer, at = NOW, secret = SECRET): Record<string, string> => ({ "stripe-signature": signWebhook(secret, body, at) });
const AT = NOW.toISOString();

test("a message is read only when its signature is the endpoint's, over exactly its body", () => {
  const p = provider(() => ({ body: {} }));
  const body = message("checkout.session.completed", { client_reference_id: "acct_1", customer: "cus_1", mode: "subscription" });
  assert.equal(p.billing.parseWebhook(signed(body), body, NOW).length, 1);
  assert.throws(() => p.billing.parseWebhook(signed(body, NOW, "whsec_another"), body, NOW), (err: Error) => err instanceof BillingWebhookError && /the signature does not match/.test(err.message));
  const tampered = Buffer.from(body.toString("utf8").replace("acct_1", "acct_2"));
  assert.throws(() => p.billing.parseWebhook(signed(body), tampered, NOW), /the signature does not match/);
  assert.throws(() => p.billing.parseWebhook({}, body, NOW), /the message carries no signature/);
  assert.throws(() => p.billing.parseWebhook({ "stripe-signature": undefined }, body, NOW), /the message carries no signature/);
});

test("a signature that is not in the form the provider sends is refused in its own words", () => {
  const p = provider(() => ({ body: {} }));
  const body = message("ping", {});
  const good = signWebhook(SECRET, body, NOW);
  const v1 = good.split("v1=")[1]!;
  const t = String(Math.floor(NOW.getTime() / 1000));
  for (const bad of ["garbage", `v1=${v1}`, `t=${t}`, `t=abc,v1=${v1}`, `t=,v1=${v1}`, `t=${t},v0=${v1}`]) {
    assert.throws(() => p.billing.parseWebhook({ "stripe-signature": bad }, body, NOW), /the signature is not in the form the provider sends/, bad);
  }
  assert.throws(() => p.billing.parseWebhook({ "stripe-signature": `t=${t},v1=zz` }, body, NOW), /the signature does not match/, "a value that is not hex does not match");
  assert.throws(() => p.billing.parseWebhook({ "stripe-signature": `t=${t},v1=${v1.slice(0, 10)}` }, body, NOW), /the signature does not match/, "a short one does not match");
});

test("a signature in a list of them is accepted when any one of them is the endpoint's, so a secret can be rotated; the first value of a repeated header is the one read", () => {
  const p = provider(() => ({ body: {} }));
  const body = message("ping", {});
  const t = String(Math.floor(NOW.getTime() / 1000));
  const good = signWebhook(SECRET, body, NOW).split("v1=")[1]!;
  const old = signWebhook("whsec_old", body, NOW).split("v1=")[1]!;
  assert.deepEqual(p.billing.parseWebhook({ "stripe-signature": `t=${t},v1=${old},v1=${good}` }, body, NOW), []);
  assert.deepEqual(p.billing.parseWebhook({ "stripe-signature": ` t=${t} , v1=${good} ` }, body, NOW), [], "spaces round the fields do no harm");
  assert.deepEqual(p.billing.parseWebhook({ "stripe-signature": [`t=${t},v1=${good}`, "t=1,v1=bad"] }, body, NOW), []);
  assert.throws(() => p.billing.parseWebhook({ "stripe-signature": [`t=${t},v1=${old}`, `t=${t},v1=${good}`] }, body, NOW), /the signature does not match/);
});

test("a message older or newer than five minutes is not trusted, and the window can be changed", () => {
  const p = provider(() => ({ body: {} }));
  const body = message("ping", {});
  const at = (seconds: number): Date => new Date(NOW.getTime() + seconds * 1000);
  assert.deepEqual(p.billing.parseWebhook(signed(body, at(0)), body, at(300)), [], "five minutes old is still read");
  assert.throws(() => p.billing.parseWebhook(signed(body, at(0)), body, at(301)), /the message is too old or too new to trust/);
  assert.deepEqual(p.billing.parseWebhook(signed(body, at(300)), body, at(0)), [], "five minutes ahead is still read");
  assert.throws(() => p.billing.parseWebhook(signed(body, at(301)), body, at(0)), /too old or too new/);
  const strict = provider(() => ({ body: {} }), { toleranceSeconds: 10 });
  assert.throws(() => strict.billing.parseWebhook(signed(body, at(0)), body, at(11)), /too old or too new/);
  assert.deepEqual(strict.billing.parseWebhook(signed(body, at(0)), body, at(10)), []);
});

test("a body that is signed but is not JSON is refused, and a type that does not matter is acknowledged and ignored", () => {
  const p = provider(() => ({ body: {} }));
  const junk = Buffer.from("not json at all");
  assert.throws(() => p.billing.parseWebhook(signed(junk), junk, NOW), (err: Error) => err instanceof BillingWebhookError && /signed but is not JSON/.test(err.message));
  for (const type of ["customer.created", "charge.succeeded", "payment_intent.created", ""]) {
    const body = message(type, { id: "x" });
    assert.deepEqual(p.billing.parseWebhook(signed(body), body, NOW), [], type);
  }
  const array = Buffer.from("[1,2]");
  assert.deepEqual(p.billing.parseWebhook(signed(array), array, NOW), [], "a JSON value that is not an object has no type");
});

test("a paid top-up checkout is a payment of the amount in the account that made it, and the customer is linked to that account", () => {
  const p = provider(() => ({ body: {} }));
  const body = message("checkout.session.completed", { id: "cs_1", client_reference_id: "acct_1", customer: "cus_1", mode: "payment", payment_status: "paid", payment_intent: "pi_1", amount_total: 2500, currency: "usd" });
  assert.deepEqual(p.billing.parseWebhook(signed(body), body, NOW), [
    { type: "customer.linked", ref: "link_cus_1_acct_1", accountId: "acct_1", customerRef: "cus_1", at: AT },
    { type: "payment.succeeded", ref: "pi_1", purpose: "topup", accountId: "acct_1", customerRef: "cus_1", amountMinor: 2500, currency: "USD", at: AT },
  ]);
});

test("a checkout that has not been paid yet, or is for a subscription, is no payment: a subscription's money arrives as an invoice", () => {
  const p = provider(() => ({ body: {} }));
  const unpaid = message("checkout.session.completed", { id: "cs_1", client_reference_id: "acct_1", customer: "cus_1", mode: "payment", payment_status: "unpaid", amount_total: 2500, currency: "usd" });
  assert.deepEqual(p.billing.parseWebhook(signed(unpaid), unpaid, NOW).map((e) => e.type), ["customer.linked"]);
  const sub = message("checkout.session.completed", { id: "cs_1", client_reference_id: "acct_1", customer: "cus_1", mode: "subscription", payment_status: "paid", amount_total: 14900, currency: "usd" });
  assert.deepEqual(p.billing.parseWebhook(signed(sub), sub, NOW).map((e) => e.type), ["customer.linked"]);
  const noAmount = message("checkout.session.completed", { id: "cs_1", client_reference_id: "acct_1", mode: "payment", payment_status: "paid", currency: "usd" });
  assert.deepEqual(p.billing.parseWebhook(signed(noAmount), noAmount, NOW), []);
  const noCurrency = message("checkout.session.completed", { id: "cs_1", client_reference_id: "acct_1", mode: "payment", payment_status: "paid", amount_total: 100 });
  assert.deepEqual(p.billing.parseWebhook(signed(noCurrency), noCurrency, NOW), []);
});

test("a payment that was delayed and then collected counts as one, and the account is read from the metadata when the reference is missing", () => {
  const p = provider(() => ({ body: {} }));
  const body = message("checkout.session.async_payment_succeeded", { id: "cs_9", metadata: { accountId: "acct_7" }, mode: "payment", payment_status: "paid", amount_total: 1000, currency: "eur" });
  assert.deepEqual(p.billing.parseWebhook(signed(body), body, NOW), [{ type: "payment.succeeded", ref: "cs_9", purpose: "topup", accountId: "acct_7", amountMinor: 1000, currency: "EUR", at: AT }]);
  const noIntent = message("checkout.session.completed", { client_reference_id: "acct_7", mode: "payment", payment_status: "paid", amount_total: 1000, currency: "eur" }, { id: "evt_77" });
  assert.equal((p.billing.parseWebhook(signed(noIntent), noIntent, NOW)[0] as any).ref, "evt_77", "with neither a payment nor a session id the event's own id is the reference");
});

test("a paid invoice is a payment for the period, with the plan from the line, the subscription or the price, and the period from the line", () => {
  const p = provider(() => ({ body: {} }), { planOfPrice: (price) => (price === "price_team" ? "team" : undefined) });
  const start = 1_790_000_000;
  const end = start + 30 * 86_400;
  const full = message("invoice.paid", {
    id: "in_1",
    customer: "cus_1",
    subscription: "sub_1",
    amount_paid: 14900,
    currency: "usd",
    lines: { data: [{ price: { id: "price_other" }, metadata: { plan: "business" }, period: { start, end } }] },
  });
  assert.deepEqual(p.billing.parseWebhook(signed(full), full, NOW), [
    { type: "payment.succeeded", ref: "in_1", purpose: "subscription", customerRef: "cus_1", plan: "business", amountMinor: 14900, currency: "USD", at: AT, periodStart: new Date(start * 1000).toISOString(), periodEnd: new Date(end * 1000).toISOString(), subscriptionRef: "sub_1" },
  ]);
  const fromSubscription = message("invoice.paid", { id: "in_2", customer: "cus_1", amount_paid: 100, currency: "usd", subscription_details: { metadata: { plan: "team" } }, lines: { data: [{}] } });
  assert.equal((p.billing.parseWebhook(signed(fromSubscription), fromSubscription, NOW)[0] as any).plan, "team");
  const fromPrice = message("invoice.paid", { id: "in_3", customer: "cus_1", amount_paid: 100, currency: "usd", lines: { data: [{ price: { id: "price_team" } }] } });
  assert.equal((p.billing.parseWebhook(signed(fromPrice), fromPrice, NOW)[0] as any).plan, "team");
  const unknownPrice = message("invoice.paid", { id: "in_4", customer: "cus_1", amount_paid: 100, currency: "usd", lines: { data: [{ price: { id: "price_unknown" } }] } });
  assert.equal("plan" in (p.billing.parseWebhook(signed(unknownPrice), unknownPrice, NOW)[0] as any), false, "no plan is guessed");
});

test("an invoice in the newer shape is read too: the price and the subscription are under their own keys", () => {
  const p = provider(() => ({ body: {} }), { planOfPrice: (price) => (price === "price_team" ? "team" : undefined) });
  const body = message("invoice.paid", {
    id: "in_5",
    customer: "cus_1",
    amount_paid: 14900,
    currency: "usd",
    parent: { subscription_details: { subscription: "sub_9", metadata: { plan: "business" } } },
    lines: { data: [{ pricing: { price_details: { price: "price_team" } } }] },
    period_start: 1_790_000_000,
    period_end: 1_792_592_000,
  });
  const [e] = p.billing.parseWebhook(signed(body), body, NOW) as any[];
  assert.equal(e.subscriptionRef, "sub_9");
  assert.equal(e.plan, "business");
  assert.equal(e.periodStart, new Date(1_790_000_000 * 1000).toISOString(), "an invoice's own period is used when its line has none");
  assert.equal(e.periodEnd, new Date(1_792_592_000 * 1000).toISOString());
  const byPrice = message("invoice.paid", { id: "in_6", customer: "cus_1", amount_paid: 14900, currency: "usd", lines: { data: [{ pricing: { price_details: { price: "price_team" } } }] } });
  assert.equal((p.billing.parseWebhook(signed(byPrice), byPrice, NOW)[0] as any).plan, "team");
});

test("an invoice with no amount or no currency is not a payment", () => {
  const p = provider(() => ({ body: {} }));
  for (const object of [{ id: "in_1", currency: "usd" }, { id: "in_1", amount_paid: 100 }, { id: "in_1", amount_paid: "100", currency: "usd" }]) {
    const body = message("invoice.paid", object);
    assert.deepEqual(p.billing.parseWebhook(signed(body), body, NOW), [], JSON.stringify(object));
  }
  const free = message("invoice.paid", { id: "in_0", amount_paid: 0, currency: "usd", customer: "cus_1" });
  assert.equal(p.billing.parseWebhook(signed(free), free, NOW).length, 1, "a free period is a payment of nothing, which the control plane applies as a period");
});

test("a failed payment names the customer and the subscription and the reason, or says it was declined", () => {
  const p = provider(() => ({ body: {} }));
  const declined = message("invoice.payment_failed", { id: "in_1", customer: "cus_1", subscription: "sub_1" });
  assert.deepEqual(p.billing.parseWebhook(signed(declined), declined, NOW), [{ type: "payment.failed", ref: "in_1", customerRef: "cus_1", subscriptionRef: "sub_1", reason: "the payment was declined", at: AT }]);
  const reasoned = message("invoice.payment_failed", { id: "in_2", customer: "cus_1", last_finalization_error: { message: "card expired" } });
  assert.deepEqual(p.billing.parseWebhook(signed(reasoned), reasoned, NOW), [{ type: "payment.failed", ref: "in_2", customerRef: "cus_1", reason: "card expired", at: AT }]);
  const bare = message("invoice.payment_failed", {}, { id: "evt_5" });
  assert.equal((p.billing.parseWebhook(signed(bare), bare, NOW)[0] as any).ref, "evt_5");
});

test("a cancelled subscription ends the account's subscription, once per message", () => {
  const p = provider(() => ({ body: {} }));
  const body = message("customer.subscription.deleted", { id: "sub_1", customer: "cus_1" });
  assert.deepEqual(p.billing.parseWebhook(signed(body), body, NOW), [{ type: "subscription.ended", ref: "evt_1", subscriptionRef: "sub_1", customerRef: "cus_1", at: AT }]);
  const noEvent = Buffer.from(JSON.stringify({ type: "customer.subscription.deleted", data: { object: { id: "sub_2" } } }));
  assert.deepEqual(p.billing.parseWebhook(signed(noEvent), noEvent, NOW), [{ type: "subscription.ended", ref: "sub_2", subscriptionRef: "sub_2", at: AT }], "without an event id the subscription's is the reference, and the time is when it was read");
});

test("a refund names the payment it is for, by invoice or by payment intent, and is ignored when it cannot say what or how much", () => {
  const p = provider(() => ({ body: {} }));
  const byInvoice = message("charge.refunded", { id: "ch_1", customer: "cus_1", invoice: "in_1", payment_intent: "pi_1", amount_refunded: 500, currency: "usd" });
  assert.deepEqual(p.billing.parseWebhook(signed(byInvoice), byInvoice, NOW), [{ type: "payment.refunded", ref: "evt_1", paymentRef: "in_1", customerRef: "cus_1", amountMinor: 500, currency: "USD", at: AT }]);
  const byIntent = message("charge.refunded", { id: "ch_1", payment_intent: "pi_1", amount_refunded: 2500, currency: "usd" });
  assert.equal((p.billing.parseWebhook(signed(byIntent), byIntent, NOW)[0] as any).paymentRef, "pi_1");
  for (const object of [{ amount_refunded: 500, currency: "usd" }, { payment_intent: "pi_1", currency: "usd" }, { payment_intent: "pi_1", amount_refunded: 500 }]) {
    const body = message("charge.refunded", object);
    assert.deepEqual(p.billing.parseWebhook(signed(body), body, NOW), [], JSON.stringify(object));
  }
});

test("the time of a message is the time the provider gave it, or the time it was read", () => {
  const p = provider(() => ({ body: {} }));
  const later = new Date(NOW.getTime() + 90_000);
  const body = message("customer.subscription.deleted", { id: "sub_1" }, { created: Math.floor(NOW.getTime() / 1000) - 3600 });
  assert.equal((p.billing.parseWebhook(signed(body, later), body, later)[0] as any).at, new Date(NOW.getTime() - 3_600_000).toISOString());
  const undated = Buffer.from(JSON.stringify({ id: "evt_1", type: "customer.subscription.deleted", data: { object: { id: "sub_1" } } }));
  assert.equal((p.billing.parseWebhook(signed(undated, later), undated, later)[0] as any).at, later.toISOString());
});

test("signing a body is what the provider does, so a signature made here is one the adapter accepts and one made over other bytes is not", () => {
  const body = Buffer.from("{}");
  const header = signWebhook("s", body, NOW);
  assert.match(header, /^t=\d+,v1=[0-9a-f]{64}$/);
  assert.equal(header, signWebhook("s", "{}", NOW), "a string and its bytes sign the same");
  assert.notEqual(header, signWebhook("s", "{ }", NOW));
  assert.notEqual(header, signWebhook("t", body, NOW));
  assert.notEqual(header, signWebhook("s", body, new Date(NOW.getTime() + 1_000)));
});
