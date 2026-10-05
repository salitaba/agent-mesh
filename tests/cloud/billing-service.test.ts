import { test } from "node:test";
import assert from "node:assert/strict";
import { GatewayAdminError, type BillingEvent } from "../../packages/cloud/src/index";
import { plane, running, type Plane } from "./support";

const DAY = 86_400_000;
const at = (p: Plane): string => new Date(p.clock.now).toISOString();
type Succeeded = Extract<BillingEvent, { type: "payment.succeeded" }>;
const topup = (p: Plane, accountId: string, ref: string, amountMinor = 2_500, extra: Partial<Succeeded> = {}): BillingEvent => ({ type: "payment.succeeded", ref, purpose: "topup", accountId, amountMinor, currency: "USD", at: at(p), ...extra });
const period = (p: Plane, accountId: string, ref: string, plan = "team", extra: Partial<Succeeded> = {}): BillingEvent => ({ type: "payment.succeeded", ref, purpose: "subscription", accountId, plan, amountMinor: 14_900, currency: "USD", at: at(p), ...extra });
const applied = (p: Plane, key: string) => p.log.state.applied.get(key);
const sub = (p: Plane, accountId: string) => p.log.state.accounts.get(accountId)!.subscription!;
const balance = async (p: Plane, accountId: string) => (await p.gateway.account(accountId)).balance;

test("a top-up becomes purchased credit at the catalogue's rate, in the gateway's ledger under an id made from the payment's reference", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  assert.deepEqual(await p.plane.billing.apply(topup(p, ada.accountId, "pi_1")), { applied: true });
  assert.deepEqual(await balance(p, ada.accountId), { included: 0, purchased: 25_000_000, total: 25_000_000, held: 0, available: 25_000_000 });
  const grant = p.gatewayRig.store.entries.find((e) => e.id === "topup:pi_1") as unknown as Record<string, unknown>;
  assert.deepEqual({ type: grant.type, accountId: grant.accountId, bucket: grant.bucket, mode: grant.mode, amountMicros: grant.amountMicros, reason: grant.reason, reference: grant.reference }, { type: "grant", accountId: ada.accountId, bucket: "purchased", mode: "add", amountMicros: 25_000_000, reason: "credit purchased", reference: "pi_1" });
  assert.deepEqual(applied(p, "payment.succeeded:pi_1")!.grants, [{ id: "topup:pi_1", bucket: "purchased", mode: "add", amountMicros: 25_000_000 }]);
  assert.equal(applied(p, "payment.succeeded:pi_1")!.amountMinor, 2_500);
  assert.equal(applied(p, "payment.succeeded:pi_1")!.currency, "USD");
});

test("an event is applied at most once: the second time finds the first's record and does nothing", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  await p.plane.billing.apply(topup(p, ada.accountId, "pi_1"));
  assert.deepEqual(await p.plane.billing.apply(topup(p, ada.accountId, "pi_1")), { applied: false, note: "duplicate" });
  assert.equal((await balance(p, ada.accountId)).purchased, 25_000_000);
  assert.equal(p.store.entries.filter((e) => e.type === "billing.applied").length, 1);
  assert.equal(p.log.state.applied.has("payment.succeeded:pi_1"), true);
  assert.deepEqual(await p.plane.billing.apply(topup(p, ada.accountId, "pi_1", 9_999)), { applied: false, note: "duplicate" }, "the reference is what identifies it, whatever else the message says");
  assert.equal((await balance(p, ada.accountId)).purchased, 25_000_000);
});

test("a crash between granting and recording is repeated harmlessly, because the gateway's grant has an id of its own", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  await p.gateway.grant({ id: "topup:pi_9", accountId: ada.accountId, bucket: "purchased", mode: "add", amountMicros: 25_000_000, reason: "credit purchased", reference: "pi_9" });
  assert.deepEqual(await p.plane.billing.apply(topup(p, ada.accountId, "pi_9")), { applied: true });
  assert.equal((await balance(p, ada.accountId)).purchased, 25_000_000, "credited once, not twice");
});

test("when the gateway cannot be reached nothing is recorded, so the same event can be applied when it can", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  const grant = p.gateway.grant;
  p.gateway.grant = async () => {
    throw new GatewayAdminError(0, "unreachable", "the model gateway could not be reached");
  };
  await assert.rejects(() => p.plane.billing.apply(topup(p, ada.accountId, "pi_1")), GatewayAdminError);
  assert.equal(p.log.state.applied.has("payment.succeeded:pi_1"), false);
  p.gateway.grant = grant;
  assert.deepEqual(await p.plane.billing.apply(topup(p, ada.accountId, "pi_1")), { applied: true });
  assert.equal((await balance(p, ada.accountId)).purchased, 25_000_000);
});

test("a payment for an account that does not exist grants nothing and is recorded for the operator to look at", async () => {
  const p = await plane();
  assert.deepEqual(await p.plane.billing.apply(topup(p, "acct_nobody", "pi_1")), { applied: false, note: "unmatched" });
  assert.deepEqual(await p.plane.billing.apply({ type: "payment.succeeded", ref: "pi_2", purpose: "topup", amountMinor: 100, currency: "USD", at: at(p) }), { applied: false, note: "unmatched" });
  assert.deepEqual(await p.plane.billing.apply({ type: "payment.succeeded", ref: "pi_3", purpose: "topup", customerRef: "cus_unknown", amountMinor: 100, currency: "USD", at: at(p) }), { applied: false, note: "unmatched" });
  assert.equal(applied(p, "payment.succeeded:pi_1")!.note, "unmatched: no account is known for this payment");
  assert.equal(applied(p, "payment.succeeded:pi_1")!.accountId, "acct_nobody");
  assert.equal(applied(p, "payment.succeeded:pi_2")!.accountId, "");
  assert.deepEqual(applied(p, "payment.succeeded:pi_2")!.grants, []);
  assert.deepEqual([applied(p, "payment.succeeded:pi_2")!.amountMinor, applied(p, "payment.succeeded:pi_2")!.currency], [100, "USD"], "how much arrived, and in what, is what the operator needs to place it");
  assert.equal(p.plane.unmatched().length, 3);
  assert.deepEqual(await p.plane.billing.apply({ type: "payment.refunded", ref: "re_lost", paymentRef: "pi_gone", amountMinor: 400, currency: "USD", at: at(p) }), { applied: false, note: "unmatched" });
  const refund = applied(p, "payment.refunded:re_lost")!;
  assert.deepEqual([refund.amountMinor, refund.currency, refund.paymentRef, refund.note], [400, "USD", "pi_gone", "unmatched: no account is known for this payment"]);
  assert.equal((await p.plane.margin()).revenue.USD, undefined, "none of it is revenue");
});

test("a payment in a currency the catalogue does not sell in grants nothing, and says so", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  assert.deepEqual(await p.plane.billing.apply(topup(p, ada.accountId, "pi_eur", 2_500, { currency: "EUR" })), { applied: false, note: "currency" });
  assert.equal(applied(p, "payment.succeeded:pi_eur")!.note, "unmatched: the catalogue sells in USD, this payment is in EUR");
  assert.equal(applied(p, "payment.succeeded:pi_eur")!.amountMinor, 2_500);
  assert.equal((await balance(p, ada.accountId)).total, 0);
  assert.deepEqual(await p.plane.billing.apply(topup(p, ada.accountId, "pi_lower", 100, { currency: "usd" })), { applied: true }, "the case of the code does not matter");
});

test("a top-up whose amount is not a positive whole number of minor units grants nothing", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  for (const [i, amount] of [0, -5, 12.5, Number.NaN].entries()) {
    assert.deepEqual(await p.plane.billing.apply(topup(p, ada.accountId, `bad_${i}`, amount)), { applied: false, note: "amount" }, String(amount));
    assert.equal(applied(p, `payment.succeeded:bad_${i}`)!.note, "unmatched: the amount is not a positive whole number of minor units");
  }
  assert.equal((await balance(p, ada.accountId)).total, 0);
});

test("a provider's customer is linked to an account, and a later message that names only the customer is read as that account's", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  assert.deepEqual(await p.plane.billing.apply({ type: "customer.linked", ref: "link_1", accountId: ada.accountId, customerRef: "cus_1", at: at(p) }), { applied: true });
  assert.deepEqual(p.log.state.accounts.get(ada.accountId)!.customers, { manual: "cus_1" }, "scoped to the provider that said so");
  assert.equal(p.log.state.customers.get("manual:cus_1"), ada.accountId);
  assert.deepEqual(await p.plane.billing.apply({ type: "payment.succeeded", ref: "pi_1", purpose: "topup", customerRef: "cus_1", amountMinor: 1_000, currency: "USD", at: at(p) }), { applied: true });
  assert.equal((await balance(p, ada.accountId)).purchased, 10_000_000);
  assert.deepEqual(await p.plane.billing.apply({ type: "customer.linked", ref: "link_2", accountId: "acct_nobody", customerRef: "cus_2", at: at(p) }), { applied: false, note: "unmatched" });
  assert.equal(p.log.state.customers.has("manual:cus_2"), false);
});

test("a period's payment replaces the included credit with the plan's amount, makes the subscription active until the period ends, and carries the provider's subscription", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  assert.deepEqual(await p.plane.billing.apply(period(p, ada.accountId, "in_1", "team", { subscriptionRef: "sub_1" })), { applied: true });
  assert.deepEqual(sub(p, ada.accountId), { plan: "team", status: "active", periodStart: "2026-10-05T12:00:00.000Z", periodEnd: "2026-11-05T12:00:00.000Z", subscriptionRef: "sub_1", changedAt: at(p) });
  assert.deepEqual(await balance(p, ada.accountId), { included: 20_000_000, purchased: 0, total: 20_000_000, held: 0, available: 20_000_000 });
  const grant = p.gatewayRig.store.entries.find((e) => e.id === "period:in_1") as unknown as Record<string, unknown>;
  assert.deepEqual({ bucket: grant.bucket, mode: grant.mode, reason: grant.reason, reference: grant.reference }, { bucket: "included", mode: "set", reason: "Team period", reference: "in_1" });
  assert.deepEqual(applied(p, "payment.succeeded:in_1")!.grants, [{ id: "period:in_1", bucket: "included", mode: "set", amountMicros: 20_000_000 }]);
});

test("the next period replaces the included credit again and does not add to it, and credit that was bought is left as it was", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  await p.plane.billing.apply(topup(p, ada.accountId, "pi_1"));
  await p.plane.billing.apply(period(p, ada.accountId, "in_1"));
  p.clock.advance(31 * DAY);
  await p.plane.billing.apply(period(p, ada.accountId, "in_2"));
  assert.deepEqual(await balance(p, ada.accountId), { included: 20_000_000, purchased: 25_000_000, total: 45_000_000, held: 0, available: 45_000_000 });
  assert.equal(sub(p, ada.accountId).periodStart, "2026-11-05T12:00:00.000Z");
  assert.equal(sub(p, ada.accountId).periodEnd, "2026-12-05T12:00:00.000Z");
});

test("a yearly plan's period is a year, and a period the provider names is the one used", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  await p.plane.billing.apply(period(p, ada.accountId, "in_1", "yearly"));
  assert.equal(sub(p, ada.accountId).periodEnd, "2027-10-05T12:00:00.000Z");
  const q = await plane();
  const bob = await q.account("bob@example.com");
  await q.plane.billing.apply(period(q, bob.accountId, "in_1", "team", { periodStart: "2026-10-01T00:00:00.000Z", periodEnd: "2026-10-31T00:00:00.000Z" }));
  assert.equal(sub(q, bob.accountId).periodStart, "2026-10-01T00:00:00.000Z");
  assert.equal(sub(q, bob.accountId).periodEnd, "2026-10-31T00:00:00.000Z");
});

test("a period that is a month from the 29th, 30th or 31st ends on the last day of a shorter month, and a year from a leap day ends on the 28th", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  const endOf = async (ref: string, plan: string, start: string): Promise<string> => {
    await p.plane.billing.apply(period(p, ada.accountId, ref, plan, { periodStart: start }));
    return sub(p, ada.accountId).periodEnd!;
  };
  assert.equal(await endOf("a", "team", "2026-01-31T00:00:00.000Z"), "2026-02-28T00:00:00.000Z");
  assert.equal(await endOf("b", "team", "2028-01-31T10:30:00.000Z"), "2028-02-29T10:30:00.000Z", "a leap year has a 29th");
  assert.equal(await endOf("c", "team", "2026-10-31T00:00:00.000Z"), "2026-11-30T00:00:00.000Z");
  assert.equal(await endOf("d", "team", "2026-12-31T00:00:00.000Z"), "2027-01-31T00:00:00.000Z", "and a month from December is in the next year");
  assert.equal(await endOf("e", "team", "2026-03-15T00:00:00.000Z"), "2026-04-15T00:00:00.000Z");
  assert.equal(await endOf("f", "yearly", "2028-02-29T00:00:00.000Z"), "2029-02-28T00:00:00.000Z");
  assert.equal(await endOf("g", "yearly", "2026-06-30T23:59:59.999Z"), "2027-06-30T23:59:59.999Z");
});

test("a payment with no plan named is for the plan the account is on, and one for a plan that is not in the catalogue grants nothing", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  const noPlan = period(p, ada.accountId, "in_0", undefined as unknown as string);
  delete (noPlan as { plan?: string }).plan;
  assert.deepEqual(await p.plane.billing.apply(noPlan), { applied: false, note: "plan" });
  assert.equal(applied(p, "payment.succeeded:in_0")!.note, "unmatched: no plan named '' in the catalogue");
  await p.plane.billing.apply(period(p, ada.accountId, "in_1", "business"));
  const again = period(p, ada.accountId, "in_2");
  delete (again as { plan?: string }).plan;
  assert.deepEqual(await p.plane.billing.apply(again), { applied: true });
  assert.equal(sub(p, ada.accountId).plan, "business", "no plan named means the plan it is on");
  assert.deepEqual(await p.plane.billing.apply(period(p, ada.accountId, "in_3", "ghost")), { applied: false, note: "plan" });
  assert.equal(applied(p, "payment.succeeded:in_3")!.note, "unmatched: no plan named 'ghost' in the catalogue");
  assert.equal(sub(p, ada.accountId).plan, "business");
  assert.equal((await balance(p, ada.accountId)).included, 100_000_000, "the credit is the business plan's, untouched by the refused one");
});

test("a payment for another plan moves the account's running and stopped workspaces to it, and one for the same plan leaves them alone", async () => {
  const { p, ada, workspace, workspaceId } = await running();
  await p.plane.billing.apply(period(p, ada.accountId, "in_same", "team"));
  assert.equal(p.provisioner.ops("create").length, 1, "the same plan changes nothing");
  await p.plane.billing.apply(period(p, ada.accountId, "in_up", "business"));
  assert.equal(workspace().plan, "business");
  assert.equal(workspace().status, "running");
  assert.equal(p.provisioner.ops("create").length, 2);
  assert.equal(p.provisioner.ops("create")[1]!.spec!.plan, "business");
  await p.plane.workspaces.suspend(workspaceId, "paused", ada.accountId);
  await p.plane.billing.apply(period(p, ada.accountId, "in_down", "team"));
  assert.equal(workspace().plan, "team");
  assert.equal(workspace().status, "suspended", "a stopped workspace is moved and stays stopped");
});

test("a payment that arrives after the account had fallen behind puts it right: the subscription is active and the stopped workspaces run", async () => {
  const { p, ada, workspace } = await running();
  await p.plane.billing.apply({ type: "payment.failed", ref: "in_f", accountId: ada.accountId, at: at(p) });
  p.clock.advance(3 * DAY + 1);
  await p.plane.workspaces.reconcile();
  assert.equal(workspace().status, "suspended");
  assert.equal(sub(p, ada.accountId).status, "past_due");
  await p.plane.billing.apply(period(p, ada.accountId, "in_late"));
  assert.equal(sub(p, ada.accountId).status, "active");
  assert.equal("pastDueSince" in sub(p, ada.accountId), false);
  assert.equal(workspace().status, "running");
  assert.equal(p.provisioner.ops("resume").length, 1);
});

test("a stopped workspace that the owner stopped is not started by a payment when the account was in good standing", async () => {
  const { p, ada, workspace, workspaceId } = await running();
  await p.plane.workspaces.suspend(workspaceId, "paused by its owner", ada.accountId);
  await p.plane.billing.apply(period(p, ada.accountId, "in_2"));
  assert.equal(workspace().status, "suspended", "paying for the next period is not asking for it to start");
  assert.equal(p.provisioner.ops("resume").length, 0);
});

test("a subscription that had ended and is bought again starts its workspaces", async () => {
  const { p, ada, workspace } = await running();
  await p.plane.billing.apply({ type: "subscription.ended", ref: "end_1", subscriptionRef: "sub_1", accountId: ada.accountId, at: at(p) });
  assert.equal(workspace().status, "suspended");
  assert.equal(sub(p, ada.accountId).status, "ended");
  await p.plane.billing.apply(period(p, ada.accountId, "in_again"));
  assert.equal(sub(p, ada.accountId).status, "active");
  assert.equal(workspace().status, "running");
});

test("a failed payment makes an active subscription past due and tells the customer once, and the workspaces keep running", async () => {
  const { p, ada, workspace } = await running();
  const mailBefore = p.mailer.sent.length;
  assert.deepEqual(await p.plane.billing.apply({ type: "payment.failed", ref: "in_f1", accountId: ada.accountId, reason: "card declined", at: at(p) }), { applied: true });
  assert.equal(sub(p, ada.accountId).status, "past_due");
  assert.equal(sub(p, ada.accountId).pastDueSince, at(p));
  assert.equal(p.store.entries.filter((e) => e.type === "subscription.changed" && e.status === "past_due").map((e) => (e as { reason: string }).reason)[0], "card declined");
  const mails = p.mailer.sent.slice(mailBefore);
  assert.equal(mails.length, 1);
  assert.deepEqual([mails[0]!.to, mails[0]!.kind, mails[0]!.subject], ["ada@example.com", "payment-failed", "A payment did not go through"]);
  assert.match(mails[0]!.text, /Your workspaces keep running for a few days; update your payment details to keep them running\./);
  assert.equal(workspace().status, "running");
  p.clock.advance(DAY);
  await p.plane.billing.apply({ type: "payment.failed", ref: "in_f2", accountId: ada.accountId, at: at(p) });
  assert.equal(p.mailer.sent.length, mailBefore + 1, "a second failure is not a second mail");
  assert.equal(sub(p, ada.accountId).pastDueSince, "2026-10-05T12:00:00.000Z", "past due since the first");
  assert.equal(p.log.state.applied.has("payment.failed:in_f2"), true);
});

test("a failed payment for an account with no subscription is recorded and does nothing else", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  const mailBefore = p.mailer.sent.length;
  assert.deepEqual(await p.plane.billing.apply({ type: "payment.failed", ref: "in_f", accountId: ada.accountId, at: at(p) }), { applied: true });
  assert.equal(p.log.state.accounts.get(ada.accountId)!.subscription, undefined);
  assert.equal(p.mailer.sent.length, mailBefore);
  assert.equal(p.log.state.applied.has("payment.failed:in_f"), true);
});

test("a message that names only the customer is for the account that customer was linked to", async () => {
  const { p, ada } = await running();
  await p.plane.billing.apply({ type: "customer.linked", ref: "link", accountId: ada.accountId, customerRef: "cus_1", at: at(p) });
  await p.plane.billing.apply({ type: "payment.failed", ref: "in_f", customerRef: "cus_1", at: at(p) });
  assert.equal(sub(p, ada.accountId).status, "past_due");
});

test("a cancelled subscription ends, stops the account's running workspaces, and tells the customer once", async () => {
  const { p, ada, workspace } = await running();
  const mailBefore = p.mailer.sent.length;
  assert.deepEqual(await p.plane.billing.apply({ type: "subscription.ended", ref: "end_1", subscriptionRef: "sub_1", accountId: ada.accountId, at: at(p) }), { applied: true });
  assert.equal(sub(p, ada.accountId).status, "ended");
  assert.equal(sub(p, ada.accountId).endedAt, at(p));
  assert.equal(workspace().status, "suspended");
  assert.equal(workspace().statusReason, "the subscription ended");
  const mails = p.mailer.sent.slice(mailBefore);
  assert.deepEqual([mails.length, mails[0]!.kind, mails[0]!.subject, mails[0]!.to], [1, "subscription-ended", "Your subscription has ended", "ada@example.com"]);
  assert.match(mails[0]!.text, /Your subscription has ended and your workspaces have been stopped\. Your data is kept for a while/);
  await p.plane.billing.apply({ type: "subscription.ended", ref: "end_2", subscriptionRef: "sub_1", accountId: ada.accountId, at: at(p) });
  assert.equal(p.mailer.sent.length, mailBefore + 1, "ending what has ended says nothing more");
  assert.equal(p.provisioner.ops("suspend").length, 1);
});

test("a cancellation for an account that never had a subscription is recorded and does nothing else", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  const mailBefore = p.mailer.sent.length;
  assert.deepEqual(await p.plane.billing.apply({ type: "subscription.ended", ref: "end_1", subscriptionRef: "sub_1", accountId: ada.accountId, at: at(p) }), { applied: true });
  assert.equal(p.mailer.sent.length, mailBefore);
});

test("a refund takes back the credit that payment bought, as the provider reports the total refunded, and never more than was bought", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  const refund = (ref: string, amountMinor: number): BillingEvent => ({ type: "payment.refunded", ref, paymentRef: "pi_1", accountId: ada.accountId, amountMinor, currency: "USD", at: at(p) });
  await p.plane.billing.apply(topup(p, ada.accountId, "pi_1", 2_500));
  assert.deepEqual(await p.plane.billing.apply(refund("re_1", 1_000)), { applied: true });
  assert.equal((await balance(p, ada.accountId)).purchased, 15_000_000);
  const grant = p.gatewayRig.store.entries.find((e) => e.id === "refund:re_1") as unknown as Record<string, unknown>;
  assert.deepEqual({ bucket: grant.bucket, mode: grant.mode, amountMicros: grant.amountMicros, reason: grant.reason, reference: grant.reference }, { bucket: "purchased", mode: "add", amountMicros: -10_000_000, reason: "credit refunded", reference: "re_1" });
  assert.deepEqual(await p.plane.billing.apply(refund("re_2", 1_500)), { applied: true });
  assert.equal((await balance(p, ada.accountId)).purchased, 10_000_000, "1,500 in all, of which 1,000 was taken back already: 500 more");
  assert.deepEqual(applied(p, "payment.refunded:re_2")!.grants.map((g) => g.amountMicros), [-5_000_000]);
  for (const [ref, total] of [["re_3", 1_200], ["re_4", 1_500]] as const) {
    assert.deepEqual(await p.plane.billing.apply(refund(ref, total)), { applied: false, note: "already-refunded" }, ref);
    assert.equal(applied(p, `payment.refunded:${ref}`)!.note, "nothing more to take back: this much of the payment has been refunded already");
  }
  assert.equal((await balance(p, ada.accountId)).purchased, 10_000_000, "a message that arrives late, or again under another id, takes back nothing more");
  assert.deepEqual(await p.plane.billing.apply(refund("re_5", 9_000)), { applied: true });
  assert.equal((await balance(p, ada.accountId)).purchased, 0, "a refund of more than was paid takes back what was paid, no more");
  assert.deepEqual(await p.plane.billing.apply(refund("re_6", 9_000)), { applied: false, note: "already-refunded" });
});

test("a refund of a plan's payment changes nothing automatically, and a refund of a payment that was never applied is recorded for the operator", async () => {
  const { p, ada } = await running();
  const before = await balance(p, ada.accountId);
  assert.deepEqual(await p.plane.billing.apply({ type: "payment.refunded", ref: "re_1", paymentRef: "inv_nothing", accountId: ada.accountId, amountMinor: 14_900, currency: "USD", at: at(p) }), { applied: false, note: "unmatched" });
  assert.equal(applied(p, "payment.refunded:re_1")!.note, "unmatched: no payment with this reference was applied");
  const subRef = [...p.log.state.applied.keys()].find((k) => k.startsWith("payment.succeeded:"))!.slice("payment.succeeded:".length);
  assert.deepEqual(await p.plane.billing.apply({ type: "payment.refunded", ref: "re_2", paymentRef: subRef, accountId: ada.accountId, amountMinor: 14_900, currency: "USD", at: at(p) }), { applied: false, note: "plan-refund" });
  assert.equal(applied(p, "payment.refunded:re_2")!.note, "a refund of a plan payment: credit and the plan are unchanged, for the operator to decide");
  assert.deepEqual(await balance(p, ada.accountId), before);
  assert.equal(sub(p, ada.accountId).status, "active");
});

test("a refund of another account's payment takes nothing from either", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  const bob = await p.account("bob@example.com");
  await p.plane.billing.apply(topup(p, ada.accountId, "pi_ada"));
  await p.plane.billing.apply(topup(p, bob.accountId, "pi_bob"));
  assert.deepEqual(await p.plane.billing.apply({ type: "payment.refunded", ref: "re_x", paymentRef: "pi_ada", accountId: bob.accountId, amountMinor: 2_500, currency: "USD", at: at(p) }), { applied: false, note: "unmatched" });
  assert.equal(applied(p, "payment.refunded:re_x")!.note, "unmatched: the payment this refunds was applied to another account");
  assert.equal((await balance(p, ada.accountId)).purchased, 25_000_000);
  assert.equal((await balance(p, bob.accountId)).purchased, 25_000_000);
});

test("what an unmatched event records is what the operator's list shows, and an applied one is not on it", async () => {
  const p = await plane();
  const ada = await p.account("ada@example.com");
  await p.plane.billing.apply(topup(p, ada.accountId, "pi_ok"));
  await p.plane.billing.apply(topup(p, "acct_nobody", "pi_lost", 700));
  await p.plane.billing.apply(topup(p, ada.accountId, "pi_eur", 800, { currency: "EUR" }));
  assert.deepEqual(p.plane.unmatched(), [
    { key: "payment.succeeded:pi_lost", kind: "payment.succeeded", amountMinor: 700, currency: "USD", note: "unmatched: no account is known for this payment" },
    { key: "payment.succeeded:pi_eur", kind: "payment.succeeded", amountMinor: 800, currency: "EUR", note: "unmatched: the catalogue sells in USD, this payment is in EUR" },
  ]);
});
