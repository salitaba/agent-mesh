/**
 * A hosted-checkout adapter for a payment provider with a Stripe-compatible API.
 *
 * Written from the provider's public documentation and tested against servers that answer in its documented shapes, not
 * against the live service. Run it in the provider's test mode before it takes a real payment, and read `ADAPTER NOTES` in
 * docs/cloud-control-plane.md for what to check. Whether a given company can open an account with this provider is for the
 * operator to find out first; another provider is another adapter behind the same port.
 *
 * How it works: a checkout is created with the account's id as the reference, and the customer pays on the provider's own
 * page, so no card data touches this service. The provider then sends a signed message. The signature is checked against the
 * endpoint's secret and the message's timestamp is held to five minutes, before the body is read as anything. Only a few
 * messages matter: a paid checkout, a paid invoice, a failed one, a cancelled subscription and a refund. Everything else is
 * acknowledged and ignored.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { BillingProviderError, BillingWebhookError, header, type BillingEvent, type BillingProvider, type CheckoutInput } from "./billing";

export interface HostedCheckoutOptions {
  /** The secret API key. Read from the environment by the caller. */
  apiKey: string;
  /** The secret that signs this endpoint's messages. */
  webhookSecret: string;
  /** Defaults to the provider's API address. */
  baseUrl?: string;
  /** Maps the provider's price id on an invoice to a plan id, when the invoice does not carry the plan itself. */
  planOfPrice?: (priceId: string) => string | undefined;
  fetch?: typeof fetch;
  /** How old a message may be, in seconds. Default 300. */
  toleranceSeconds?: number;
}

const iso = (seconds: unknown): string | undefined => (typeof seconds === "number" && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : undefined);
const obj = (v: unknown): Record<string, any> => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** Form encoding with the bracketed nesting the provider reads: `a[b][0]=c`. */
export function formEncode(value: Record<string, unknown>): string {
  const pairs: string[] = [];
  const walk = (prefix: string, v: unknown): void => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(`${prefix}[${i}]`, x));
    else if (typeof v === "object") for (const [k, x] of Object.entries(v)) walk(`${prefix}[${k}]`, x);
    else pairs.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(v))}`);
  };
  for (const [k, v] of Object.entries(value)) walk(k, v);
  return pairs.join("&");
}

export class HostedCheckoutBilling implements BillingProvider {
  readonly name = "hosted-checkout";
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HostedCheckoutOptions) {
    this.baseUrl = (options.baseUrl ?? "https://api.stripe.com").replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  private async post(path: string, body: Record<string, unknown>, idempotencyKey?: string): Promise<Record<string, any>> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/x-www-form-urlencoded",
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        },
        body: formEncode(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new BillingProviderError(`the payment provider could not be reached (${(err as Error).message})`);
    }
    const text = await res.text();
    let json: Record<string, any> = {};
    try {
      json = obj(JSON.parse(text));
    } catch {
      // Fall through: a body that is not JSON is reported below.
    }
    if (!res.ok) {
      const message = str(obj(json.error).message) ?? `status ${res.status}`;
      throw new BillingProviderError(`the payment provider refused the request: ${message.slice(0, 200)}`, res.status);
    }
    return json;
  }

  async createCheckout(input: CheckoutInput): Promise<{ url: string; ref: string }> {
    const metadata = { accountId: input.accountId, purpose: input.purpose, ...(input.plan ? { plan: input.plan.id } : {}) };
    let body: Record<string, unknown>;
    if (input.purpose === "subscription") {
      if (!input.plan) throw new BillingProviderError("a subscription checkout needs a plan");
      if (!input.plan.providerPriceId) throw new BillingProviderError(`plan '${input.plan.id}' has no provider_price_id, which a subscription checkout needs`);
      body = {
        mode: "subscription",
        line_items: [{ price: input.plan.providerPriceId, quantity: 1 }],
        subscription_data: { metadata },
      };
    } else {
      if (!Number.isInteger(input.amountMinor) || (input.amountMinor ?? 0) < 1) throw new BillingProviderError("a top-up checkout needs an amount");
      body = {
        mode: "payment",
        line_items: [{ quantity: 1, price_data: { currency: input.currency.toLowerCase(), unit_amount: input.amountMinor, product_data: { name: "Model usage credit" } } }],
        payment_intent_data: { metadata },
      };
    }
    const session = await this.post(
      "/v1/checkout/sessions",
      { ...body, success_url: input.successUrl, cancel_url: input.cancelUrl, client_reference_id: input.accountId, customer_email: input.email, metadata },
      input.idempotencyKey,
    );
    const url = str(session.url);
    const ref = str(session.id);
    if (!url || !ref) throw new BillingProviderError("the payment provider answered without a checkout address");
    return { url, ref };
  }

  async openPortal(input: { accountId: string; customerRef?: string; returnUrl: string }): Promise<{ url: string }> {
    if (!input.customerRef) throw new BillingProviderError("there is no customer to open a portal for yet: the account has not paid");
    const session = await this.post("/v1/billing_portal/sessions", { customer: input.customerRef, return_url: input.returnUrl });
    const url = str(session.url);
    if (!url) throw new BillingProviderError("the payment provider answered without a portal address");
    return { url };
  }

  parseWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer, now: Date = new Date()): BillingEvent[] {
    this.verify(header(headers, "stripe-signature"), rawBody, now);
    let event: Record<string, any>;
    try {
      event = obj(JSON.parse(rawBody.toString("utf8")));
    } catch {
      throw new BillingWebhookError("the message is signed but is not JSON");
    }
    const at = iso(event.created) ?? now.toISOString();
    const o = obj(obj(event.data).object);
    const eventId = str(event.id) ?? "";
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
        return this.fromCheckout(o, at, eventId);
      case "invoice.paid":
        return this.fromInvoice(o, at, eventId);
      case "invoice.payment_failed": {
        const customerRef = str(o.customer);
        return [{ type: "payment.failed", ref: str(o.id) ?? eventId, ...(customerRef ? { customerRef } : {}), ...(str(o.subscription) ? { subscriptionRef: str(o.subscription)! } : {}), reason: str(obj(o.last_finalization_error).message) ?? "the payment was declined", at }];
      }
      case "customer.subscription.deleted": {
        const customerRef = str(o.customer);
        return [{ type: "subscription.ended", ref: eventId || str(o.id) || "", subscriptionRef: str(o.id) ?? "", ...(customerRef ? { customerRef } : {}), at }];
      }
      case "charge.refunded": {
        const customerRef = str(o.customer);
        const paymentRef = str(o.invoice) ?? str(o.payment_intent);
        const amountMinor = num(o.amount_refunded);
        const currency = str(o.currency);
        if (!paymentRef || amountMinor === undefined || !currency) return [];
        return [{ type: "payment.refunded", ref: eventId || str(o.id) || "", paymentRef, ...(customerRef ? { customerRef } : {}), amountMinor, currency: currency.toUpperCase(), at }];
      }
      default:
        return [];
    }
  }

  private fromCheckout(session: Record<string, any>, at: string, eventId: string): BillingEvent[] {
    const accountId = str(session.client_reference_id) ?? str(obj(session.metadata).accountId);
    const customerRef = str(session.customer);
    const events: BillingEvent[] = [];
    if (accountId && customerRef) events.push({ type: "customer.linked", ref: `link_${customerRef}_${accountId}`, accountId, customerRef, at });
    // A subscription's money arrives as an invoice. Only a payment that was actually collected is a payment here.
    if (session.mode === "payment" && session.payment_status === "paid") {
      const amountMinor = num(session.amount_total);
      const currency = str(session.currency);
      if (amountMinor !== undefined && currency) {
        events.push({
          type: "payment.succeeded",
          ref: str(session.payment_intent) ?? str(session.id) ?? eventId,
          purpose: "topup",
          ...(accountId ? { accountId } : {}),
          ...(customerRef ? { customerRef } : {}),
          amountMinor,
          currency: currency.toUpperCase(),
          at,
        });
      }
    }
    return events;
  }

  private fromInvoice(invoice: Record<string, any>, at: string, eventId: string): BillingEvent[] {
    const amountMinor = num(invoice.amount_paid);
    const currency = str(invoice.currency);
    if (amountMinor === undefined || !currency) return [];
    const line = obj(obj(invoice.lines).data?.[0]);
    const priceId = str(obj(line.price).id) ?? str(obj(obj(line.pricing).price_details).price);
    const plan = str(obj(line.metadata).plan) ?? str(obj(invoice.subscription_details?.metadata ?? obj(obj(invoice.parent).subscription_details).metadata).plan) ?? (priceId ? this.options.planOfPrice?.(priceId) : undefined);
    const customerRef = str(invoice.customer);
    const subscriptionRef = str(invoice.subscription) ?? str(obj(obj(invoice.parent).subscription_details).subscription);
    const periodStart = iso(obj(line.period).start) ?? iso(invoice.period_start);
    const periodEnd = iso(obj(line.period).end) ?? iso(invoice.period_end);
    return [
      {
        type: "payment.succeeded",
        ref: str(invoice.id) ?? eventId,
        purpose: "subscription",
        ...(customerRef ? { customerRef } : {}),
        ...(plan ? { plan } : {}),
        amountMinor,
        currency: currency.toUpperCase(),
        at,
        ...(periodStart ? { periodStart } : {}),
        ...(periodEnd ? { periodEnd } : {}),
        ...(subscriptionRef ? { subscriptionRef } : {}),
      },
    ];
  }

  /** `Stripe-Signature: t=<seconds>,v1=<hex>[,v1=<hex>]` over `<t>.<body>`, with the endpoint's secret. */
  private verify(signature: string | undefined, rawBody: Buffer, now: Date): void {
    if (!signature) throw new BillingWebhookError("the message carries no signature");
    const fields = signature.split(",").map((p) => p.trim().split("="));
    const t = fields.find(([k]) => k === "t")?.[1];
    const given = fields.filter(([k]) => k === "v1").map(([, v]) => v ?? "");
    const stamp = Number(t);
    if (!t || !Number.isFinite(stamp) || given.length === 0) throw new BillingWebhookError("the signature is not in the form the provider sends");
    const age = Math.abs(now.getTime() / 1000 - stamp);
    if (age > (this.options.toleranceSeconds ?? 300)) throw new BillingWebhookError("the message is too old or too new to trust");
    const expected = createHmac("sha256", this.options.webhookSecret).update(`${t}.`).update(rawBody).digest();
    const ok = given.some((g) => {
      const candidate = Buffer.from(g, "hex");
      return candidate.length === expected.length && timingSafeEqual(candidate, expected);
    });
    if (!ok) throw new BillingWebhookError("the signature does not match: this message is not from the provider");
  }
}

/** The signature header for a body, as the provider would send it. For tests and for the operator's own checks. */
export function signWebhook(secret: string, rawBody: Buffer | string, at: Date): string {
  const t = Math.floor(at.getTime() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.`).update(rawBody).digest("hex");
  return `t=${t},v1=${v1}`;
}
