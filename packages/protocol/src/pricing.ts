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
