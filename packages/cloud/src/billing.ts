/**
 * The billing port: the one interface between the control plane and whoever takes the money.
 *
 * The control plane never talks to a payment provider directly. It asks a provider for a place to send a customer to pay, and
 * it is told, by a signed message or by an operator recording a payment, that money arrived. Everything else about money (the
 * credit it becomes, the plan it activates, the workspace it starts or stops) is the control plane's own and is the same for
 * every provider.
 *
 * Which provider a company can use depends on where it is established and where its customers are, so providers are
 * adapters. Two ship: a hosted-checkout adapter (`hosted-checkout.ts`) and a manual one below, where the operator records a
 * payment that arrived some other way (an invoice, a transfer). An event is identified by `ref`, the provider's own id for it,
 * and the control plane applies a `ref` at most once: a provider that sends a message twice, as they all do, is harmless.
 */

export interface CheckoutInput {
  accountId: string;
  email: string;
  purpose: "subscription" | "topup";
  /** The plan, for a subscription. */
  plan?: { id: string; title: string; priceMinor: number; period: "month" | "year"; providerPriceId?: string };
  /** The amount, in minor units, for a top-up. */
  amountMinor?: number;
  currency: string;
  successUrl: string;
  cancelUrl: string;
  /** Sent to the provider so that asking twice for the same thing gives the same checkout. */
  idempotencyKey: string;
}

interface Who {
  /** The account, when the provider carried it through (as the reference or metadata of the checkout). */
  accountId?: string;
  /** The provider's customer, when it did not: the control plane remembers which account a customer is. */
  customerRef?: string;
}

export type BillingEvent =
  | (Who & {
      type: "payment.succeeded";
      ref: string;
      purpose: "subscription" | "topup";
      plan?: string;
      amountMinor: number;
      currency: string;
      at: string;
      periodStart?: string;
      periodEnd?: string;
      subscriptionRef?: string;
    })
  | (Who & { type: "payment.failed"; ref: string; subscriptionRef?: string; reason?: string; at: string })
  | (Who & { type: "subscription.ended"; ref: string; subscriptionRef: string; at: string })
  /** `amountMinor` is the total refunded for that payment so far, as providers report it, and not what this message adds. */
  | (Who & { type: "payment.refunded"; ref: string; paymentRef: string; amountMinor: number; currency: string; at: string })
  | { type: "customer.linked"; ref: string; accountId: string; customerRef: string; at: string };

export interface BillingProvider {
  readonly name: string;
  /** Where to send a customer to pay. */
  createCheckout(input: CheckoutInput): Promise<{ url: string; ref: string }>;
  /** Where a customer manages a subscription and a card. Throws {@link BillingUnsupportedError} where there is no such place. */
  openPortal(input: { accountId: string; customerRef?: string; returnUrl: string }): Promise<{ url: string }>;
  /** Check that a message is from the provider and read it. Throws {@link BillingWebhookError} for anything that is not. */
  parseWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer, now?: Date): BillingEvent[];
}

/** A message that is not from the provider, or that the provider's signature does not vouch for. */
export class BillingWebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingWebhookError";
  }
}

export class BillingUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingUnsupportedError";
  }
}

/** The provider could not be reached or refused the request. */
export class BillingProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "BillingProviderError";
  }
}

/**
 * Payments that arrive some other way: an invoice, a bank transfer, a payment the operator took by hand. The customer is
 * sent to a page of the operator's own (`payUrl`) that says how to pay and what reference to quote, and the operator records
 * the payment when it arrives, through the owner API. There is no message to verify and no portal.
 */
export class ManualBilling implements BillingProvider {
  readonly name = "manual";

  constructor(private readonly options: { payUrl: (ref: string) => string }) {}

  async createCheckout(input: CheckoutInput): Promise<{ url: string; ref: string }> {
    const ref = `manual_${input.idempotencyKey}`;
    return { url: this.options.payUrl(ref), ref };
  }

  async openPortal(): Promise<{ url: string }> {
    throw new BillingUnsupportedError("There is no billing portal for payments made by invoice or transfer. Contact the operator to change or cancel a plan.");
  }

  parseWebhook(): BillingEvent[] {
    throw new BillingWebhookError("Manual billing receives no messages: payments are recorded by the operator.");
  }
}

/** The header's first value, when a header was sent more than once. */
export function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}
