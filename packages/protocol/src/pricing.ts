/**
 * Token prices and the one function that turns token counts into dollars.
 *
 * Two readers price tokens: the host's spend ceiling (what a backstop trips on) and the usage
 * report (what a customer is shown). They must agree, so they share this. A model's tokens
 * are four different things to a provider, and billing any one of them as another is a
 * wrong number:
 *
 *   input        fresh prompt tokens
 *   output       generated tokens, reasoning included
 *   cacheWrite   prompt tokens written to the prompt cache: 1.25x the input price (5-minute cache)
 *   cacheRead    prompt tokens read back from the cache: 0.1x the input price, and a few models differ
 *
 * Cache reads are NOT free to the provider. The mesh's own TOKEN BUDGETS deliberately weight
 * them at zero by default (a budget that bills cache luck punishes a warm prompt less than a
 * cold one, which is a statement about fairness between turns, not about the invoice), and the
 * spend ceiling used to inherit that: it priced input and output only, and left out the part of
 * the bill that was most of it. On the seventh cronlite run (Haiku 4.5, list prices) fresh
 * input and output came to $1.10 of a $5.52 bill, so a "$50" ceiling would have tripped at
 * about $250.
 */

/** Anthropic's published multipliers on the input price, for the standard 5-minute cache. */
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

/** USD per million tokens. The cache prices default to the multipliers above when omitted. */
export interface TokenPrice {
  inputPerMtok: number;
  outputPerMtok: number;
  /** Set explicitly for a model whose cache write price is not 1.25x its input price. */
  cacheWritePerMtok?: number;
  /** Set explicitly for a model whose cache read price is not 0.1x its input price (some are 0.05x or 0.025x). */
  cacheReadPerMtok?: number;
}

/** Token counts for one model. The cache fields may be absent from a source that predates them. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheWrite?: number;
  cacheRead?: number;
}

const count = (n: number | undefined): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);

export function cacheWritePrice(price: TokenPrice): number {
  return price.cacheWritePerMtok ?? price.inputPerMtok * CACHE_WRITE_MULTIPLIER;
}

export function cacheReadPrice(price: TokenPrice): number {
  return price.cacheReadPerMtok ?? price.inputPerMtok * CACHE_READ_MULTIPLIER;
}

/** USD for `usage` at `price`. */
export function priceTokenUsage(price: TokenPrice, usage: TokenUsage): number {
  return (
    (count(usage.input) * price.inputPerMtok +
      count(usage.output) * price.outputPerMtok +
      count(usage.cacheWrite) * cacheWritePrice(price) +
      count(usage.cacheRead) * cacheReadPrice(price)) /
    1_000_000
  );
}

/**
 * When `ANTHROPIC_LIST_PRICES` was read off Anthropic's published pricing. A price list is a fact with a
 * date, and this one goes stale: say so wherever it is shown, and let `host.yaml` override it.
 */
export const LIST_PRICES_AS_OF = "2026-10-01";

/**
 * Anthropic's published API list prices for the current models, USD per million tokens, standard (not
 * batch, not priority) rates, 5-minute cache. A model not named here is not guessed at: it is priced from
 * `host.yaml` or, failing that, at the host's default rate.
 *
 * Cache writes are 1.25x input on all four. Cache reads are 0.1x on Haiku and Sonnet (the default) and
 * lower on the two larger models, which is why those carry an explicit read price.
 *
 * Whoever pays the model provider pays these or their own negotiated rates: the agents run on the
 * customer's own credentials. These are for estimating what a mesh cost, and for the spend ceiling to trip
 * on something close to the invoice; the invoice is the authoritative bill.
 */
export const ANTHROPIC_LIST_PRICES: Readonly<Record<string, TokenPrice>> = {
  "claude-haiku-4-5": { inputPerMtok: 1, outputPerMtok: 5 },
  "claude-sonnet-5-5": { inputPerMtok: 2, outputPerMtok: 10 },
  "claude-opus-5-5": { inputPerMtok: 4, outputPerMtok: 20, cacheReadPerMtok: 0.2 },
  "claude-fable-5-1": { inputPerMtok: 10, outputPerMtok: 50, cacheReadPerMtok: 0.25 },
};

/**
 * The list price for a model id as a runtime reports it: `claude-haiku-4-5`, a dated
 * `claude-haiku-4-5-20251001`, or either behind a provider prefix (`anthropic/…`). A family matches only at a
 * hyphen, so `claude-haiku-4-50` is not `claude-haiku-4-5`.
 */
export function listPriceFor(model: string): TokenPrice | undefined {
  const bare = model.toLowerCase().replace(/^[a-z0-9-]+\//, "");
  let best: [string, TokenPrice] | undefined;
  for (const [family, price] of Object.entries(ANTHROPIC_LIST_PRICES)) {
    if ((bare === family || bare.startsWith(`${family}-`)) && (!best || family.length > best[0].length)) best = [family, price];
  }
  return best?.[1];
}
