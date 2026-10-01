/**
 * The plan table and the model prices as one JSON document, for the things that cannot import TypeScript:
 * the pricing page, its calculator and the sales documents. `scripts/export-pricing.mjs` writes it to
 * `pricing/plans.json`; a test regenerates it and fails when the committed file differs, so the page a buyer
 * reads cannot say something the product does not.
 *
 * Model usage is in here only as information. No plan includes it: the agents run on the customer's own
 * provider credentials, and the provider bills the customer.
 */
import { ANTHROPIC_LIST_PRICES, LIST_PRICES_AS_OF, cacheReadPrice, cacheWritePrice, priceTokenUsage, type TokenUsage } from "../../protocol/src/pricing";
import { PLANS, PLAN_IDS, type PlanDefinition } from "./plans";

/** A real run, from `pricing/measured-runs.json`. */
export interface MeasuredRun {
  id: string;
  date: string;
  source: string;
  mission: string;
  model: string;
  seats: number;
  turns: number;
  wallClockMinutes: number;
  outcome: string;
  tokens: Required<TokenUsage>;
}

export interface ExportedPlan extends PlanDefinition {
  /** Twelve months at the annual rate; `null` for a free or quoted plan. */
  priceAnnualTotalUsd: number | null;
  /** How much the annual rate takes off the monthly one, as a whole percent. */
  annualSavingsPercent: number | null;
}

export interface ExportedRun extends MeasuredRun {
  /** What these exact tokens cost at each model's list price. Another model would not use the same tokens. */
  costUsdByModel: Record<string, number>;
  /** The run's own bill, at the model it ran on. */
  costUsd: number;
  tokensBilled: number;
}

export interface PricingExport {
  version: 1;
  generatedBy: string;
  currency: "USD";
  /** Said wherever a price is shown. */
  modelUsageNote: string;
  plans: ExportedPlan[];
  modelPrices: {
    asOf: string;
    perMtokUsd: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }>;
  };
  measuredRuns: ExportedRun[];
}

export const MODEL_USAGE_NOTE =
  "Plan prices are for the runtime. Model usage is separate: the agents run on your own Anthropic, Bedrock, Vertex or Foundry credentials, and your provider bills you for it.";

const cents = (n: number): number => Math.round(n * 100) / 100;

export function buildPricingExport(measuredRuns: readonly MeasuredRun[]): PricingExport {
  const plans: ExportedPlan[] = PLAN_IDS.map((id) => {
    const plan = PLANS[id];
    const annual = plan.priceMonthlyAnnualUsd;
    const monthly = plan.priceMonthlyUsd;
    return {
      ...plan,
      priceAnnualTotalUsd: annual === null ? null : annual * 12,
      annualSavingsPercent: annual === null || monthly === null || monthly === 0 ? null : Math.round((1 - annual / monthly) * 100),
    };
  });
  const perMtokUsd: PricingExport["modelPrices"]["perMtokUsd"] = {};
  for (const [model, price] of Object.entries(ANTHROPIC_LIST_PRICES)) {
    perMtokUsd[model] = { input: price.inputPerMtok, output: price.outputPerMtok, cacheWrite: cacheWritePrice(price), cacheRead: cacheReadPrice(price) };
  }
  const runs: ExportedRun[] = measuredRuns.map((run) => {
    const costUsdByModel: Record<string, number> = {};
    for (const [model, price] of Object.entries(ANTHROPIC_LIST_PRICES)) costUsdByModel[model] = cents(priceTokenUsage(price, run.tokens));
    const own = ANTHROPIC_LIST_PRICES[run.model];
    return {
      ...run,
      costUsdByModel,
      costUsd: own ? cents(priceTokenUsage(own, run.tokens)) : NaN,
      tokensBilled: run.tokens.input + run.tokens.output + run.tokens.cacheWrite,
    };
  });
  return {
    version: 1,
    generatedBy: "scripts/export-pricing.mjs, from packages/licensing/src/plans.ts, packages/protocol/src/pricing.ts and pricing/measured-runs.json. Do not edit by hand.",
    currency: "USD",
    modelUsageNote: MODEL_USAGE_NOTE,
    plans,
    modelPrices: { asOf: LIST_PRICES_AS_OF, perMtokUsd },
    measuredRuns: runs,
  };
}
