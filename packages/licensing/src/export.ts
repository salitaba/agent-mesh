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

// ---------------------------------------------------------------- markdown

const usd = (n: number): string => `$${n.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
/** A cost, always to the cent: a table of costs reads wrong with `$138` beside `$55.20`. */
const usdc = (n: number): string => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const limit = (n: number | null): string => (n === null ? "Unlimited" : String(n));

/** The marker pair that fences a generated block in a markdown file. */
export function generatedBlock(name: string): { start: string; end: string } {
  return { start: `<!-- generated:${name}:start (scripts/export-pricing.mjs; do not edit between the markers) -->`, end: `<!-- generated:${name}:end -->` };
}

/** `body` with the block called `name` replaced by `content`. Throws when the markers are not both there. */
export function replaceGeneratedBlock(body: string, name: string, content: string): string {
  const { start, end } = generatedBlock(name);
  const a = body.indexOf(start);
  const b = body.indexOf(end);
  if (a < 0 || b < a) throw new Error(`the block '${name}' is not fenced in this file: expected ${start} ... ${end}`);
  return `${body.slice(0, a + start.length)}\n${content}\n${body.slice(b)}`;
}

/** The plans side by side: what each costs, allows and includes. */
export function renderPlansTable(out: PricingExport): string {
  const price = (p: ExportedPlan, billing: "monthly" | "annual"): string => {
    if (p.pricing === "free") return "Free";
    if (p.pricing === "contact") return "Contact us";
    return billing === "monthly" ? usd(p.priceMonthlyUsd!) : `${usd(p.priceMonthlyAnnualUsd!)} (${usd(p.priceAnnualTotalUsd!)} a year)`;
  };
  const row = (label: string, cell: (p: ExportedPlan) => string): string => `| ${label} | ${out.plans.map(cell).join(" | ")} |`;
  return [
    `| | ${out.plans.map((p) => p.name).join(" | ")} |`,
    `|---|${out.plans.map(() => "---").join("|")}|`,
    row("Per month, billed monthly", (p) => price(p, "monthly")),
    row("Per month, billed annually", (p) => price(p, "annual")),
    row("Projects open at once", (p) => limit(p.limits.maxProjects)),
    row("Seats (agents) per mesh", (p) => limit(p.limits.maxSeatsPerMesh)),
    row("Concurrent agent turns", (p) => limit(p.limits.maxConcurrentTurns)),
    row("Usage export and Prometheus metrics", (p) => (p.features.includes("usage-export") && p.features.includes("prometheus-metrics") ? "Yes" : "No")),
    row("Support", (p) => p.support),
  ].join("\n");
}

/** What a measured run cost, re-priced at each current model, and what a month of such runs would cost. */
export function renderEconomics(out: PricingExport): string {
  const models = Object.keys(out.modelPrices.perMtokUsd);
  const lines: string[] = [];
  for (const run of out.measuredRuns) {
    lines.push(`**${run.id}** (${run.date}): ${run.seats} seats, ${run.turns} turns, ${run.wallClockMinutes} minutes, ran on \`${run.model}\` for ${usdc(run.costUsd)}. ${run.outcome}`);
    lines.push("");
    // Where the bill of the run's own model went, by token class: the fact that shapes how a customer should
    // think about cost (a cached prompt read back is most of the tokens and most of the bill).
    const own = out.modelPrices.perMtokUsd[run.model];
    if (own) {
      const parts: Array<[string, number]> = [
        ["cache reads", (run.tokens.cacheRead * own.cacheRead) / 1e6],
        ["cache writes", (run.tokens.cacheWrite * own.cacheWrite) / 1e6],
        ["output", (run.tokens.output * own.output) / 1e6],
        ["fresh input", (run.tokens.input * own.input) / 1e6],
      ];
      const total = parts.reduce((a, [, v]) => a + v, 0);
      const tokens = run.tokens.input + run.tokens.output + run.tokens.cacheWrite + run.tokens.cacheRead;
      lines.push(
        `Where that bill went: ${parts.map(([label, v]) => `${label} ${usdc(v)} (${Math.round((v / total) * 100)}%)`).join(", ")}. ` +
          `Cache reads were ${Math.round((run.tokens.cacheRead / tokens) * 100)}% of the ${(tokens / 1e6).toFixed(1)} million tokens the provider counted.`,
      );
      lines.push("");
    }
    lines.push(`| Model | These tokens at ${out.modelPrices.asOf} list prices | A month of 10 runs | 25 runs | 100 runs |`);
    lines.push("|---|---|---|---|---|");
    for (const model of models) {
      const one = run.costUsdByModel[model]!;
      lines.push(`| \`${model}\`${model === run.model ? " (what it ran on)" : ""} | ${usdc(one)} | ${usdc(cents(one * 10))} | ${usdc(cents(one * 25))} | ${usdc(cents(one * 100))} |`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/**
 * The export as the page's data block: a JSON script element. `<` is escaped so no value in the data can close the
 * element or open a comment, whatever a future plan description contains.
 */
export function renderSiteData(out: PricingExport): string {
  return `<script type="application/json" id="plans-data">${JSON.stringify(out).replace(/</g, "\\u003c")}</script>`;
}
