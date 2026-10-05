/**
 * Tiers: the names a customer uses for a model, and the chain of real models behind each.
 *
 * A customer's workspace asks for `fast`, `balanced` or `best`. Which provider and model answers is the operator's business
 * and can change without the customer touching a setting. A tier is an ordered list: the first is tried first, and the next
 * is tried when the one before it could not answer (before any of the answer has been sent, so a caller never sees half of
 * one model's reply and half of another's).
 */
import type { PriceTable } from "./prices";

export interface Candidate {
  /** `provider/model`: the key of the price table, and the name the ledger records. */
  id: string;
  provider: string;
  model: string;
  /** The most one answer from this model may hold, whatever the caller asks for. */
  maxOutputTokens: number;
}

export interface Tier {
  name: string;
  candidates: Candidate[];
}

const TIER_NAME = /^[A-Za-z0-9._-]{1,64}$/;

export class Router {
  private readonly tiers = new Map<string, Tier>();

  /** Throws one error naming every problem: an unnamed tier, a tier with nothing in it, a model with no price. */
  constructor(tiers: readonly Tier[], prices: PriceTable, providers: ReadonlySet<string> | readonly string[]) {
    const known = providers instanceof Set ? providers : new Set(providers);
    const problems: string[] = [];
    for (const tier of tiers) {
      if (!TIER_NAME.test(tier.name)) problems.push(`tier '${tier.name}': a name is 1 to 64 letters, digits and . _ -`);
      if (this.tiers.has(tier.name)) problems.push(`tier '${tier.name}' is defined twice`);
      if (tier.candidates.length === 0) problems.push(`tier '${tier.name}' lists no models`);
      for (const c of tier.candidates) {
        if (!known.has(c.provider)) problems.push(`tier '${tier.name}': '${c.id}' names provider '${c.provider}', which is not configured (providers: ${[...known].join(", ") || "none"})`);
        if (!prices.has(c.id)) problems.push(`tier '${tier.name}': '${c.id}' has no price; add it to the price table, because a call that is not priced is a call nobody is billed for`);
        if (!Number.isInteger(c.maxOutputTokens) || c.maxOutputTokens < 1) problems.push(`tier '${tier.name}': '${c.id}' needs a max_output_tokens that is a whole number of at least 1`);
      }
      this.tiers.set(tier.name, tier);
    }
    if (this.tiers.size === 0) problems.push("no tiers are defined");
    if (problems.length > 0) throw new Error(problems.join("\n"));
  }

  /** The tier names a key may use: all of them, or the ones its allowlist names. */
  names(allowed?: readonly string[]): string[] {
    return [...this.tiers.keys()].filter((n) => allowed === undefined || allowed.includes(n));
  }

  /** The chain to try, in order, for what a caller asked for; undefined when it names no tier, or one this key may not use. */
  resolve(requested: string, allowed?: readonly string[]): Candidate[] | undefined {
    if (allowed !== undefined && !allowed.includes(requested)) return undefined;
    return this.tiers.get(requested)?.candidates;
  }
}
