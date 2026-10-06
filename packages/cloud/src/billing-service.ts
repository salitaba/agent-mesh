/**
 * What a payment does: credit, a plan, a workspace that runs.
 *
 * Every provider's messages, and every payment an operator records by hand, are read into the same few events
 * (`billing.ts`) and applied here. The rules are the service's own and are the same whoever took the money:
 *
 *   - An event is applied at most once. It is identified by its provider's reference; the second time finds the first's record.
 *     The gateway's grants carry ids derived from the reference as well, so a crash between granting and recording is
 *     repeated harmlessly.
 *   - A payment in a currency the catalogue does not sell in grants nothing and is recorded as unmatched, for the operator to
 *     look at. So is a payment for an account that does not exist.
 *   - A top-up becomes purchased credit at the catalogue's rate. A plan's period payment replaces the included credit with the
 *     plan's amount, and makes the subscription active until the period's end.
 *   - A failed payment makes the subscription past due; a workspace stops only after the grace period, and a payment that
 *     arrives first puts everything back.
 *   - A refunded top-up takes its credit back; a refunded period payment changes nothing automatically, because whether the
 *     customer keeps the plan is the operator's decision.
 */
import type { BillingEvent } from "./billing";
import type { Catalogue } from "./catalogue";
import type { GatewayAdmin } from "./gateway-client";
import type { Mailer } from "./mailer";
import type { ControlLog } from "./store";
import type { Workspaces } from "./workspaces";

export interface BillingServiceOptions {
  log: ControlLog;
  catalogue: Catalogue;
  /** Absent when every plan is hosting only: there is no balance to credit. */
  gateway?: GatewayAdmin;
  workspaces: Workspaces;
  mailer: Mailer;
  /** The payment provider's name, which scopes its customer references. */
  provider: string;
  /** The address of the account pages, so that a mail can say where to act. Without it a mail names the page and links nothing. */
  appUrl?: string;
  clock?: () => Date;
}

export interface Applied {
  applied: boolean;
  /** Why it was not applied, or what was unusual about it. */
  note?: string;
}

const days = (n: number): string => `${n} day${n === 1 ? "" : "s"}`;

type Grant = { id: string; bucket: "included" | "purchased"; mode: "add" | "set"; amountMicros: number };

/** A month or a year after a date, on the same day of the month, or the last day of it when the month is shorter (31 January + a month is 28 February). */
function addPeriod(start: Date, period: "month" | "year"): Date {
  const end = new Date(start.getTime());
  const day = end.getUTCDate();
  end.setUTCDate(1);
  if (period === "year") end.setUTCFullYear(end.getUTCFullYear() + 1);
  else end.setUTCMonth(end.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
  end.setUTCDate(Math.min(day, lastDay));
  return end;
}

export class BillingService {
  private readonly clock: () => Date;

  constructor(private readonly o: BillingServiceOptions) {
    this.clock = o.clock ?? (() => new Date());
  }

  private get state() {
    return this.o.log.state;
  }

  /** Where the account pages are, for a mail to point at; their name when the service was not told the address. */
  private accountPage(): string {
    return this.o.appUrl ? `${this.o.appUrl.replace(/\/+$/, "")}/account` : "your account page";
  }

  private accountOf(e: BillingEvent): string | undefined {
    if (e.type === "customer.linked") return e.accountId;
    if (e.accountId) return e.accountId;
    return e.customerRef ? this.state.customers.get(`${this.o.provider}:${e.customerRef}`) : undefined;
  }

  private async record(key: string, accountId: string, kind: string, grants: Grant[], extra: { amountMinor?: number; currency?: string; paymentRef?: string; note?: string } = {}): Promise<void> {
    await this.o.log.append({ type: "billing.applied", key, accountId, kind, grants, ...extra });
  }

  /** Apply one event. Safe to call again with the same event. */
  async apply(event: BillingEvent): Promise<Applied> {
    const key = `${event.type}:${event.ref}`;
    if (this.state.applied.has(key)) return { applied: false, note: "duplicate" };
    const accountId = this.accountOf(event);
    if (!accountId || !this.state.accounts.has(accountId)) {
      // Money that arrived and cannot be placed is where the operator most needs to see how much, and in what.
      const money = event.type === "payment.succeeded" ? { amountMinor: event.amountMinor, currency: event.currency } : event.type === "payment.refunded" ? { amountMinor: event.amountMinor, currency: event.currency, paymentRef: event.paymentRef } : {};
      await this.record(key, accountId ?? "", event.type, [], { ...money, note: "unmatched: no account is known for this payment" });
      return { applied: false, note: "unmatched" };
    }
    const account = this.state.accounts.get(accountId)!;
    const catalogue = this.o.catalogue;

    switch (event.type) {
      case "customer.linked":
        await this.o.log.append({ type: "billing.customer_linked", provider: this.o.provider, accountId, customerRef: event.customerRef });
        await this.record(key, accountId, event.type, []);
        return { applied: true };

      case "payment.succeeded": {
        if (event.currency.toUpperCase() !== catalogue.currency) {
          await this.record(key, accountId, event.type, [], { amountMinor: event.amountMinor, currency: event.currency, note: `unmatched: the catalogue sells in ${catalogue.currency}, this payment is in ${event.currency}` });
          return { applied: false, note: "currency" };
        }
        if (event.purpose === "topup") {
          if (!this.o.gateway) {
            // No gateway means the service sells no model usage. Money that arrived for it is the operator's to refund, and is shown to them.
            await this.record(key, accountId, event.type, [], { amountMinor: event.amountMinor, currency: event.currency, note: "unmatched: this service sells no model usage, so there is nothing a top-up buys" });
            return { applied: false, note: "no-usage" };
          }
          if (!Number.isInteger(event.amountMinor) || event.amountMinor < 1) {
            await this.record(key, accountId, event.type, [], { amountMinor: event.amountMinor, currency: event.currency, note: "unmatched: the amount is not a positive whole number of minor units" });
            return { applied: false, note: "amount" };
          }
          const grant: Grant = { id: `topup:${event.ref}`, bucket: "purchased", mode: "add", amountMicros: event.amountMinor * catalogue.topups.usageMicrosPerMinor };
          await this.o.gateway.grant({ ...grant, accountId, reason: "credit purchased", reference: event.ref });
          await this.record(key, accountId, event.type, [grant], { amountMinor: event.amountMinor, currency: event.currency });
          return { applied: true };
        }
        const planId = event.plan ?? account.subscription?.plan;
        const plan = planId ? catalogue.plan(planId) : undefined;
        if (!plan) {
          await this.record(key, accountId, event.type, [], { amountMinor: event.amountMinor, currency: event.currency, note: `unmatched: no plan named '${planId ?? ""}' in the catalogue` });
          return { applied: false, note: "plan" };
        }
        const now = this.clock();
        const periodStart = event.periodStart ?? now.toISOString();
        const periodEnd = event.periodEnd ?? addPeriod(new Date(Date.parse(periodStart)), plan.period).toISOString();
        // A hosting-only plan includes no usage, so there is no balance to set; a plan that does include some needs the gateway to hold it.
        const grant: Grant = { id: `period:${event.ref}`, bucket: "included", mode: "set", amountMicros: plan.byok ? 0 : plan.includedUsageMicros };
        if (!plan.byok) {
          if (!this.o.gateway) throw new Error(`plan '${plan.id}' includes model usage and the service has no gateway to hold it`);
          await this.o.gateway.grant({ ...grant, accountId, reason: `${plan.title} period`, reference: event.ref });
        }
        const before = account.subscription;
        await this.o.log.append({ type: "subscription.changed", accountId, plan: plan.id, status: "active", periodStart, periodEnd, ...(event.subscriptionRef ? { subscriptionRef: event.subscriptionRef } : {}), reason: "a payment for the period was received" });
        await this.record(key, accountId, event.type, plan.byok ? [] : [grant], { amountMinor: event.amountMinor, currency: event.currency });
        // Put right whatever the account's standing was before this payment.
        for (const w of this.o.workspaces.forAccount(accountId)) {
          if (w.plan !== plan.id && (w.status === "running" || w.status === "suspended")) await this.o.workspaces.reprovision(w.workspaceId, plan.id);
          else if (w.status === "suspended" && (before?.status === "past_due" || before?.status === "ended")) await this.o.workspaces.resume(w.workspaceId);
        }
        return { applied: true };
      }

      case "payment.failed": {
        const sub = account.subscription;
        if (sub && sub.status === "active") {
          await this.o.log.append({ type: "subscription.changed", accountId, status: "past_due", reason: event.reason ?? "a payment failed" });
          await this.o.mailer.send({ to: account.email, kind: "payment-failed", subject: "A Curule payment did not go through", text: `The last payment for your plan did not go through.\n\nYour workspaces keep running for ${days(this.o.workspaces.policy.graceDays)}; after that they are stopped, not deleted. To keep them running, update your payment details with Manage billing on your account page:\n\n${this.accountPage()}\n\nA payment that arrives before then puts everything back as it was.` });
        }
        await this.record(key, accountId, event.type, []);
        return { applied: true };
      }

      case "subscription.ended": {
        if (account.subscription && account.subscription.status !== "ended") {
          await this.o.log.append({ type: "subscription.changed", accountId, status: "ended", reason: "the subscription was cancelled" });
          for (const w of this.o.workspaces.forAccount(accountId)) if (w.status === "running") await this.o.workspaces.suspend(w.workspaceId, "the subscription ended");
          await this.o.mailer.send({ to: account.email, kind: "subscription-ended", subject: "Your Curule subscription has ended", text: `Your subscription has ended and your workspaces have been stopped. Your data is kept for ${days(this.o.workspaces.policy.retentionDays)} after that, and then deleted.\n\nTo start your workspaces again, subscribe again from your account page. To remove them now, delete them there:\n\n${this.accountPage()}` });
        }
        await this.record(key, accountId, event.type, []);
        return { applied: true };
      }

      case "payment.refunded": {
        const original = this.state.applied.get(`payment.succeeded:${event.paymentRef}`);
        const detail = { amountMinor: event.amountMinor, currency: event.currency, paymentRef: event.paymentRef };
        // Credit comes back from the account the money came to, and from no other.
        if (original && original.accountId !== accountId) {
          await this.record(key, accountId, event.type, [], { ...detail, note: "unmatched: the payment this refunds was applied to another account" });
          return { applied: false, note: "unmatched" };
        }
        const purchased = original?.grants.find((g) => g.bucket === "purchased");
        if (!original || !purchased || !original.amountMinor) {
          await this.record(key, accountId, event.type, [], { ...detail, note: original ? "a refund of a plan payment: credit and the plan are unchanged, for the operator to decide" : "unmatched: no payment with this reference was applied" });
          return { applied: false, note: original ? "plan-refund" : "unmatched" };
        }
        // The provider says how much of the payment has been refunded in all. What this message adds is the difference from what was
        // taken back already, so a message that arrives late, or twice under two ids, takes back nothing more than the payment was for.
        const rate = this.o.catalogue.topups.usageMicrosPerMinor;
        const refundedInAll = Math.min(Math.max(event.amountMinor, 0), original.amountMinor);
        const more = refundedInAll - (this.state.creditRefundedMicros.get(event.paymentRef) ?? 0) / rate;
        if (!Number.isInteger(more) || more < 1) {
          await this.record(key, accountId, event.type, [], { ...detail, note: "nothing more to take back: this much of the payment has been refunded already" });
          return { applied: false, note: "already-refunded" };
        }
        const grant: Grant = { id: `refund:${event.ref}`, bucket: "purchased", mode: "add", amountMicros: -more * rate };
        if (!this.o.gateway) throw new Error("a refund of credit needs the gateway that holds it");
        await this.o.gateway.grant({ ...grant, accountId, reason: "credit refunded", reference: event.ref });
        await this.record(key, accountId, event.type, [grant], detail);
        return { applied: true };
      }
    }
  }
}
