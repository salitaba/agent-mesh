/**
 * The control plane: accounts, plans, payments and workspaces, behind one object that the HTTP servers and the tests use.
 *
 * It composes four things that each have a file of their own (accounts, the billing application service, workspaces and the
 * ports they stand on) and adds what only the whole can do: start a checkout for the right thing, read a provider's message
 * and apply it, answer what an account looks like from the customer's side, and give the operator a view of the money.
 */
import { createHash } from "node:crypto";
import { Accounts, type AccountsOptions } from "./accounts";
import { BillingService } from "./billing-service";
import { BillingUnsupportedError, type BillingEvent, type BillingProvider } from "./billing";
import type { Catalogue } from "./catalogue";
import { ServiceError } from "./errors";
import type { GatewayAdmin } from "./gateway-client";
import type { Mailer } from "./mailer";
import type { Account, ControlLog, Workspace } from "./store";
import { Workspaces, type WorkspacesOptions } from "./workspaces";

export interface ControlPlaneOptions {
  log: ControlLog;
  catalogue: Catalogue;
  billing: BillingProvider;
  gateway: GatewayAdmin;
  mailer: Mailer;
  /** The address of the app, for return links and mail. */
  appUrl: string;
  workspaces: Omit<WorkspacesOptions, "log" | "catalogue" | "gateway" | "mailer">;
  accounts?: Partial<Omit<AccountsOptions, "log" | "mailer" | "appUrl">>;
  clock?: () => Date;
}

/** What a customer sees of an account. Nothing in it is secret. */
export interface AccountView {
  accountId: string;
  email: string;
  createdAt: string;
  subscription: null | { plan: string; title: string; status: string; periodEnd?: string; pastDueSince?: string };
  workspaces: Array<{ workspaceId: string; name: string; slug: string; plan: string; status: string; statusReason?: string; host: string }>;
}

export class ControlPlane {
  readonly accounts: Accounts;
  readonly workspaces: Workspaces;
  readonly billing: BillingService;
  private readonly clock: () => Date;

  constructor(readonly o: ControlPlaneOptions) {
    this.clock = o.clock ?? (() => new Date());
    this.accounts = new Accounts({ ...o.accounts, log: o.log, mailer: o.mailer, appUrl: o.appUrl, clock: this.clock });
    this.workspaces = new Workspaces({ ...o.workspaces, log: o.log, catalogue: o.catalogue, gateway: o.gateway, mailer: o.mailer, clock: this.clock });
    this.billing = new BillingService({ log: o.log, catalogue: o.catalogue, gateway: o.gateway, workspaces: this.workspaces, mailer: o.mailer, provider: o.billing.name, clock: this.clock });
  }

  private get state() {
    return this.o.log.state;
  }

  view(account: Account): AccountView {
    const sub = account.subscription;
    const plan = sub ? this.o.catalogue.plan(sub.plan) : undefined;
    return {
      accountId: account.accountId,
      email: account.email,
      createdAt: account.createdAt,
      subscription: sub ? { plan: sub.plan, title: plan?.title ?? sub.plan, status: sub.status, ...(sub.periodEnd ? { periodEnd: sub.periodEnd } : {}), ...(sub.pastDueSince ? { pastDueSince: sub.pastDueSince } : {}) } : null,
      workspaces: this.workspaces.forAccount(account.accountId).map((w: Workspace) => ({
        workspaceId: w.workspaceId,
        name: w.name,
        slug: w.slug,
        plan: w.plan,
        status: w.status,
        ...(w.statusReason ? { statusReason: w.statusReason } : {}),
        host: this.workspaces.hostOf(w.slug),
      })),
    };
  }

  /** The balance and what has been spent, from the gateway, in the gateway's currency. */
  async balance(accountId: string): Promise<{ currency: string; balance: { included: number; purchased: number; total: number; available: number }; charged: number }> {
    const a = await this.o.gateway.account(accountId);
    return { currency: a.currency, balance: { included: a.balance.included, purchased: a.balance.purchased, total: a.balance.total, available: a.balance.available }, charged: a.charged };
  }

  /** Where to send the customer to pay for a plan or a top-up. */
  async startCheckout(accountId: string, input: { purpose: unknown; plan?: unknown; amountMinor?: unknown }): Promise<{ url: string }> {
    const account = this.state.accounts.get(accountId);
    if (!account || account.verifiedAt === undefined || account.disabledAt !== undefined) throw new ServiceError(403, "not_allowed", "This account cannot buy anything.");
    const catalogue = this.o.catalogue;
    const base = this.o.appUrl.replace(/\/+$/, "");
    const day = this.clock().toISOString().slice(0, 10);
    if (input.purpose === "subscription") {
      const plan = typeof input.plan === "string" ? catalogue.plan(input.plan) : undefined;
      if (!plan) throw new ServiceError(400, "unknown_plan", "That plan is not on offer.");
      if (account.subscription?.status === "active" && account.subscription.plan === plan.id) throw new ServiceError(409, "already_subscribed", "You are already on that plan.");
      const key = createHash("sha256").update(`${accountId}:subscription:${plan.id}:${day}`).digest("hex").slice(0, 32);
      return this.checkout({ accountId, email: account.email, purpose: "subscription", plan: { id: plan.id, title: plan.title, priceMinor: plan.priceMinor, period: plan.period, ...(plan.providerPriceId ? { providerPriceId: plan.providerPriceId } : {}) }, currency: catalogue.currency, successUrl: `${base}/account?paid=1`, cancelUrl: `${base}/account?cancelled=1`, idempotencyKey: key });
    }
    if (input.purpose === "topup") {
      const t = catalogue.topups;
      const amount = input.amountMinor;
      if (typeof amount !== "number" || !Number.isInteger(amount) || amount < t.minimumMinor || amount > t.maximumMinor) throw new ServiceError(400, "invalid_amount", "That amount cannot be bought.");
      const key = createHash("sha256").update(`${accountId}:topup:${amount}:${this.clock().toISOString().slice(0, 13)}`).digest("hex").slice(0, 32);
      return this.checkout({ accountId, email: account.email, purpose: "topup", amountMinor: amount, currency: catalogue.currency, successUrl: `${base}/account?paid=1`, cancelUrl: `${base}/account?cancelled=1`, idempotencyKey: key });
    }
    throw new ServiceError(400, "invalid_purpose", "Say whether this is a subscription or a top-up.");
  }

  private async checkout(input: Parameters<BillingProvider["createCheckout"]>[0]): Promise<{ url: string }> {
    try {
      return { url: (await this.o.billing.createCheckout(input)).url };
    } catch (err) {
      if (err instanceof ServiceError) throw err;
      throw new ServiceError(502, "billing_unavailable", "The payment page could not be opened. Try again in a moment.");
    }
  }

  async openPortal(accountId: string): Promise<{ url: string }> {
    const account = this.state.accounts.get(accountId);
    if (!account) throw new ServiceError(404, "not_found", "There is no such account.");
    try {
      const customerRef = account.customers[this.o.billing.name];
      return await this.o.billing.openPortal({ accountId, ...(customerRef ? { customerRef } : {}), returnUrl: `${this.o.appUrl.replace(/\/+$/, "")}/account` });
    } catch (err) {
      if (err instanceof BillingUnsupportedError) throw new ServiceError(409, "no_portal", err.message);
      if (err instanceof ServiceError) throw err;
      throw new ServiceError(502, "billing_unavailable", "The billing page could not be opened. Try again in a moment.");
    }
  }

  /** A message from the payment provider: checked, read, applied. Throws what {@link BillingProvider.parseWebhook} throws. */
  async handleWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): Promise<{ events: number; applied: number }> {
    const events = this.o.billing.parseWebhook(headers, rawBody, this.clock());
    let applied = 0;
    for (const e of events) if ((await this.billing.apply(e)).applied) applied++;
    return { events: events.length, applied };
  }

  /** A payment the operator took some other way. It is applied as the provider's own messages are. */
  async recordPayment(input: { accountId: string; purpose: "subscription" | "topup"; plan?: string; amountMinor: number; currency: string; ref: string; note?: string }): Promise<{ applied: boolean; note?: string }> {
    const event: BillingEvent = { type: "payment.succeeded", ref: `manual_${input.ref}`, purpose: input.purpose, accountId: input.accountId, ...(input.plan ? { plan: input.plan } : {}), amountMinor: input.amountMinor, currency: input.currency, at: this.clock().toISOString() };
    const result = await this.billing.apply(event);
    await this.o.log.append({ type: "owner.action", action: "payment.recorded", detail: `${input.purpose} ${input.amountMinor} ${input.currency} for ${input.accountId}, ref ${input.ref}${input.note ? `, ${input.note}` : ""}` });
    return result;
  }

  /** Stop an account: it cannot sign in, and its workspaces are stopped. */
  async disableAccount(accountId: string, reason: string): Promise<void> {
    const account = this.state.accounts.get(accountId);
    if (!account) throw new ServiceError(404, "not_found", "There is no such account.");
    await this.o.log.append({ type: "account.disabled", accountId, reason });
    await this.o.log.append({ type: "sessions.revoked_for", accountId });
    for (const w of this.workspaces.forAccount(accountId)) if (w.status === "running") await this.workspaces.suspend(w.workspaceId, `the account was stopped: ${reason}`);
    await this.o.log.append({ type: "owner.action", action: "account.disabled", detail: `${accountId}: ${reason}` });
  }

  async enableAccount(accountId: string): Promise<void> {
    if (!this.state.accounts.has(accountId)) throw new ServiceError(404, "not_found", "There is no such account.");
    await this.o.log.append({ type: "account.enabled", accountId });
    await this.o.log.append({ type: "owner.action", action: "account.enabled", detail: accountId });
  }

  /** Payments that were received and could not be matched, for the operator to look at. */
  unmatched(): Array<{ key: string; kind: string; amountMinor?: number; currency?: string; note?: string }> {
    return [...this.state.applied.values()].filter((a) => a.note?.startsWith("unmatched")).map((a) => ({ key: a.key, kind: a.kind, ...(a.amountMinor !== undefined ? { amountMinor: a.amountMinor } : {}), ...(a.currency ? { currency: a.currency } : {}), ...(a.note ? { note: a.note } : {}) }));
  }

  /**
   * What came in and what the models cost, for a period. The two are in different currencies when the catalogue and the
   * gateway are, and they are not converted: the operator has their own rate. Revenue is what was applied, by currency, in
   * minor units.
   */
  async margin(from?: string, to?: string): Promise<{
    revenue: Record<string, { subscription: number; topup: number; refunded: number }>;
    usage: { currency: string; chargedMicros: number; costMicros: number; marginMicros: number; calls: number; failed: number };
  }> {
    const revenue: Record<string, { subscription: number; topup: number; refunded: number }> = {};
    const lo = from ? Date.parse(from) : -Infinity;
    const hi = to ? Date.parse(to) : Infinity;
    // A provider reports a refund as the total refunded for the payment so far, so a message counts for what it adds to the last one.
    const refundedBefore = new Map<string, number>();
    for await (const e of this.o.log.scan()) {
      if (e.type !== "billing.applied" || e.amountMinor === undefined || !e.currency) continue;
      if (e.note?.startsWith("unmatched")) continue;
      let amount = e.amountMinor;
      if (e.kind === "payment.refunded") {
        const earlier = refundedBefore.get(e.paymentRef ?? e.key) ?? 0;
        amount = Math.max(0, e.amountMinor - earlier);
        refundedBefore.set(e.paymentRef ?? e.key, Math.max(earlier, e.amountMinor));
      }
      const at = Date.parse(e.at);
      if (at < lo || at >= hi) continue;
      const row = (revenue[e.currency] ??= { subscription: 0, topup: 0, refunded: 0 });
      if (e.kind === "payment.refunded") row.refunded += amount;
      else if (e.grants.some((g) => g.bucket === "purchased")) row.topup += amount;
      else row.subscription += amount;
    }
    const report = await this.o.gateway.report({ groupBy: "account", ...(from ? { from } : {}), ...(to ? { to } : {}) });
    return { revenue, usage: { currency: report.currency, chargedMicros: report.total.chargeMicros, costMicros: report.total.costMicros, marginMicros: report.total.marginMicros, calls: report.total.calls, failed: report.total.failed } };
  }
}
