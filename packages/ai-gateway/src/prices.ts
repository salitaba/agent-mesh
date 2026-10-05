/**
 * The price table: what each model costs the service, and what a call on it is charged to the customer.
 *
 * The operator owns this file. The code ships no prices: a model with no entry cannot be routed to (the gateway refuses to
 * start), because a call that is not priced is a call the service pays for and nobody is billed. Every rate is required,
 * the cache rates included, because "the provider does not charge for cache writes" is a fact to write down as `0`, not a
 * default to assume. Each entry names the date of the figures (`version`), which is recorded on every spend so a past
 * charge can be explained from the table that produced it.
 */
import * as fs from "node:fs";
import { parse as parseYaml } from "yaml";
import type { ModelUsage } from "../../llm/src/index";
import { chargeMicros, costMicros, parseMarkup, parseRate, type Micros, type Rates } from "./money";

export interface ModelPrice {
  /** `provider/model`, as a route names it. */
  id: string;
  rates: Rates;
  markupBps: number;
}

export interface PricedCall {
  costMicros: Micros;
  chargeMicros: Micros;
}

export class PriceTable {
  constructor(
    readonly currency: string,
    /** The operator's label for this set of figures, usually a date. */
    readonly version: string,
    private readonly prices: ReadonlyMap<string, ModelPrice>,
  ) {}

  has(id: string): boolean {
    return this.prices.has(id);
  }

  get(id: string): ModelPrice | undefined {
    return this.prices.get(id);
  }

  ids(): string[] {
    return [...this.prices.keys()];
  }

  /** The cost to the service and the charge to the customer for `usage` on `id`. */
  price(id: string, usage: ModelUsage): PricedCall {
    const p = this.prices.get(id);
    if (!p) throw new Error(`no price for model '${id}' (known: ${this.ids().join(", ") || "none"})`);
    return { costMicros: costMicros(usage, p.rates), chargeMicros: chargeMicros(usage, p.rates, p.markupBps) };
  }
}

const RATE_KEYS = [
  ["input", "input"],
  ["output", "output"],
  ["cache_read", "cacheRead"],
  ["cache_write", "cacheWrite"],
] as const;

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** Validate a parsed price table. Every problem is reported at once, in words that name the line to fix. */
export function parsePriceTable(raw: unknown, source = "the price table"): PriceTable {
  const problems: string[] = [];
  const fail = (message: string): void => void problems.push(`${source}: ${message}`);
  if (!isObject(raw)) throw new Error(`${source}: expected a mapping with currency, version, default_markup and models`);

  const currency = typeof raw.currency === "string" ? raw.currency.trim() : "";
  if (!/^[A-Za-z]{3,8}$/.test(currency)) fail(`currency must be a code such as USD (got ${JSON.stringify(raw.currency)})`);
  const version = typeof raw.version === "string" || typeof raw.version === "number" ? String(raw.version).trim() : "";
  if (version === "") fail("version must say which figures these are, for example the date they were read from the providers' price pages");

  const allowBelowCost = raw.allow_below_cost === true;
  let defaultBps = 0;
  try {
    defaultBps = parseMarkup(raw.default_markup, "default_markup");
    if (defaultBps < 10_000 && !allowBelowCost) fail(`default_markup ${raw.default_markup} is below 1, which sells below cost; set allow_below_cost: true if that is intended`);
  } catch (err) {
    fail((err as Error).message);
  }

  const prices = new Map<string, ModelPrice>();
  if (!isObject(raw.models) || Object.keys(raw.models).length === 0) fail("models must list at least one provider/model with its rates");
  else {
    for (const [id, entry] of Object.entries(raw.models)) {
      if (!isObject(entry)) {
        fail(`models.${id} must be a mapping of rates`);
        continue;
      }
      if (!/^[^/\s]+\/\S+$/.test(id)) fail(`models.${id} must be written provider/model`);
      const rates: Partial<Rates> = {};
      for (const [key, field] of RATE_KEYS) {
        if (entry[key] === undefined) {
          fail(`models.${id}.${key} is missing; write 0 where the provider does not charge for it`);
          continue;
        }
        try {
          rates[field] = parseRate(entry[key], `models.${id}.${key}`);
        } catch (err) {
          fail((err as Error).message);
        }
      }
      let bps = defaultBps;
      if (entry.markup !== undefined) {
        try {
          bps = parseMarkup(entry.markup, `models.${id}.markup`);
          if (bps < 10_000 && !allowBelowCost) fail(`models.${id}.markup ${entry.markup} is below 1, which sells below cost; set allow_below_cost: true if that is intended`);
        } catch (err) {
          fail((err as Error).message);
        }
      }
      if (RATE_KEYS.every(([, field]) => rates[field] !== undefined)) prices.set(id, { id, rates: rates as Rates, markupBps: bps });
    }
  }
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return new PriceTable(currency.toUpperCase(), version, prices);
}

/** Read a price table from a YAML or JSON file. */
export function loadPriceTable(file: string): PriceTable {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`cannot read the price table ${file}: ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new Error(`the price table ${file} is not valid YAML: ${(err as Error).message}`);
  }
  return parsePriceTable(raw, file);
}
