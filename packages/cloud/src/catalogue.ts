/**
 * The hosted plans: what a customer can buy, as the operator wrote it.
 *
 * Like the gateway's price table this is the operator's file and the code ships no figures. A plan names the licence plan its
 * workspaces run with (which sets projects, seats and concurrent turns, exactly as for a self-hosted install), what it costs
 * per period, how much model usage each period includes, and how many workspaces an account may run at once. Prices are whole
 * minor units of the billing currency (cents) so that nothing is rounded; included usage is in the gateway's currency.
 */
import * as fs from "node:fs";
import { parse as parseYaml } from "yaml";
import { PLAN_IDS, type PlanId } from "../../licensing/src/index";

export interface HostedPlan {
  id: string;
  title: string;
  /** The self-hosted plan whose limits a workspace of this plan runs with. */
  licencePlan: PlanId;
  /** What one period costs, in minor units of the billing currency. */
  priceMinor: number;
  period: "month" | "year";
  /** Model usage included each period, in micro-units of the gateway's currency. */
  includedUsageMicros: number;
  /** Workspaces an account may run at once under this plan. */
  workspaces: number;
  /** The payment provider's own id for this plan, where it needs one. */
  providerPriceId?: string;
  /** The gateway tiers a workspace of this plan may use. Absent means all of them. */
  tiers?: string[];
  summary?: string;
}

export interface TopUps {
  /** The amounts offered, in minor units. */
  optionsMinor: number[];
  minimumMinor: number;
  maximumMinor: number;
  /** Model usage bought per minor unit of the billing currency, in gateway micro-units. */
  usageMicrosPerMinor: number;
}

export class Catalogue {
  constructor(
    readonly currency: string,
    private readonly byId: ReadonlyMap<string, HostedPlan>,
    readonly topups: TopUps,
  ) {}

  plan(id: string): HostedPlan | undefined {
    return this.byId.get(id);
  }

  plans(): HostedPlan[] {
    return [...this.byId.values()];
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** A decimal in currency units with at most six places (`20`, `0.5`), as whole millionths. */
function micros(value: unknown, what: string, problems: string[]): number {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text);
  if (!m) {
    problems.push(`${what} must be an amount of currency units with at most six decimals (got ${JSON.stringify(value)})`);
    return 0;
  }
  return Number(m[1]) * 1_000_000 + Number((m[2] ?? "").padEnd(6, "0"));
}

function whole(value: unknown, what: string, min: number, max: number, problems: string[]): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    problems.push(`${what} must be a whole number from ${min} to ${max} (got ${JSON.stringify(value)})`);
    return min;
  }
  return value;
}

/** Validate a parsed catalogue. Every problem is reported at once. */
export function parseCatalogue(raw: unknown, source = "the plan catalogue"): Catalogue {
  const problems: string[] = [];
  if (!isObject(raw)) throw new Error(`${source}: expected a mapping with currency, plans and topups`);
  const currency = typeof raw.currency === "string" ? raw.currency.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(currency)) problems.push(`currency must be a three-letter code such as USD (got ${JSON.stringify(raw.currency)})`);

  const plans = new Map<string, HostedPlan>();
  if (!isObject(raw.plans) || Object.keys(raw.plans).length === 0) problems.push("plans must list at least one plan");
  else {
    for (const [id, p] of Object.entries(raw.plans)) {
      if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) problems.push(`plan '${id}': an id is 1 to 32 lower-case letters, digits and hyphens`);
      if (!isObject(p)) {
        problems.push(`plan '${id}' must be a mapping`);
        continue;
      }
      const where = `plans.${id}`;
      if (typeof p.title !== "string" || p.title.trim() === "") problems.push(`${where}.title is required`);
      if (!PLAN_IDS.includes(p.licence_plan as PlanId)) problems.push(`${where}.licence_plan must be one of ${PLAN_IDS.join(", ")} (got ${JSON.stringify(p.licence_plan)})`);
      if (p.period !== "month" && p.period !== "year") problems.push(`${where}.period must be month or year`);
      if (p.provider_price_id !== undefined && (typeof p.provider_price_id !== "string" || p.provider_price_id === "")) problems.push(`${where}.provider_price_id must be text`);
      if (p.tiers !== undefined && (!Array.isArray(p.tiers) || p.tiers.length === 0 || p.tiers.some((t) => typeof t !== "string" || t === ""))) problems.push(`${where}.tiers must be a non-empty list of tier names`);
      plans.set(id, {
        id,
        title: typeof p.title === "string" ? p.title.trim() : "",
        licencePlan: p.licence_plan as PlanId,
        priceMinor: whole(p.price_minor, `${where}.price_minor`, 0, 100_000_000, problems),
        period: p.period === "year" ? "year" : "month",
        includedUsageMicros: p.included_usage === undefined ? 0 : micros(p.included_usage, `${where}.included_usage`, problems),
        workspaces: whole(p.workspaces, `${where}.workspaces`, 1, 1_000, problems),
        ...(typeof p.provider_price_id === "string" ? { providerPriceId: p.provider_price_id } : {}),
        ...(Array.isArray(p.tiers) ? { tiers: p.tiers as string[] } : {}),
        ...(typeof p.summary === "string" ? { summary: p.summary } : {}),
      });
    }
  }

  const t = isObject(raw.topups) ? raw.topups : {};
  if (!isObject(raw.topups)) problems.push("topups must be a mapping with options, minimum_minor, maximum_minor and usage_per_unit");
  const options = Array.isArray(t.options_minor) ? t.options_minor : [];
  if (!Array.isArray(t.options_minor) || options.length === 0 || options.some((o) => typeof o !== "number" || !Number.isInteger(o) || o < 1)) problems.push("topups.options_minor must be a list of amounts in minor units");
  const minimumMinor = whole(t.minimum_minor, "topups.minimum_minor", 1, 100_000_000, problems);
  const maximumMinor = whole(t.maximum_minor, "topups.maximum_minor", 1, 1_000_000_000, problems);
  if (maximumMinor < minimumMinor) problems.push("topups.maximum_minor must not be below topups.minimum_minor");
  let usageMicrosPerMinor = 0;
  if (typeof t.usage_micros_per_minor !== "number" || !Number.isInteger(t.usage_micros_per_minor) || t.usage_micros_per_minor < 1) problems.push("topups.usage_micros_per_minor must be a whole number: the model usage, in micro-units of the gateway's currency, that one minor unit of the billing currency buys");
  else usageMicrosPerMinor = t.usage_micros_per_minor;

  if (problems.length > 0) throw new Error(problems.map((p) => `${source}: ${p}`).join("\n"));
  return new Catalogue(currency, plans, { optionsMinor: options as number[], minimumMinor, maximumMinor, usageMicrosPerMinor });
}

export function loadCatalogue(file: string): Catalogue {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`cannot read the plan catalogue ${file}: ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new Error(`the plan catalogue ${file} is not valid YAML: ${(err as Error).message}`);
  }
  return parseCatalogue(raw, file);
}
