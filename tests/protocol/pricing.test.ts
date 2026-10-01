import { test } from "node:test";
import assert from "node:assert/strict";
import { CACHE_READ_MULTIPLIER, CACHE_WRITE_MULTIPLIER, cacheReadPrice, cacheWritePrice, priceTokenUsage } from "../../packages/protocol/src/pricing";

/**
 * Four token classes, four prices. The figures below are Anthropic's published list prices as of
 * 2026-10-01 (platform.claude.com/docs/en/about-claude/pricing) and the token counts are the seventh
 * cronlite run's, so the expected dollars can be checked against the provider's own arithmetic.
 */

const HAIKU_4_5 = { inputPerMtok: 1, outputPerMtok: 5 }; // cache write $1.25, cache read $0.10
const OPUS_5_5 = { inputPerMtok: 4, outputPerMtok: 20, cacheWritePerMtok: 5, cacheReadPerMtok: 0.2 }; // reads at 0.05x
const RUN7 = { input: 3_892, output: 218_904, cacheWrite: 949_926, cacheRead: 32_299_235 };

test("cache prices default to the published multipliers on the input price", () => {
  assert.equal(CACHE_WRITE_MULTIPLIER, 1.25);
  assert.equal(CACHE_READ_MULTIPLIER, 0.1);
  assert.equal(cacheWritePrice(HAIKU_4_5), 1.25);
  assert.equal(cacheReadPrice(HAIKU_4_5), 0.1);
  assert.equal(cacheWritePrice({ ...HAIKU_4_5, cacheWritePerMtok: 2 }), 2, "an explicit price wins, including the 1-hour cache's 2x");
  assert.equal(cacheReadPrice({ ...HAIKU_4_5, cacheReadPerMtok: 0 }), 0, "and so does an explicit zero");
});

test("the seventh run's whole bill on Haiku 4.5, to the cent, and how little of it fresh tokens were", () => {
  const all = priceTokenUsage(HAIKU_4_5, RUN7);
  assert.equal(all.toFixed(2), "5.52");
  const freshOnly = priceTokenUsage(HAIKU_4_5, { input: RUN7.input, output: RUN7.output });
  assert.equal(freshOnly.toFixed(2), "1.10", "what a ceiling that prices input and output alone would have counted");
  assert.ok(all / freshOnly > 4.9, "five times short");
  assert.equal(priceTokenUsage(HAIKU_4_5, { ...RUN7, cacheRead: 0 }).toFixed(2), "2.29", "cache writes alone are a fifth of the bill");
});

test("a model that reads its cache more cheaply is priced at its own rate", () => {
  // 3,892*4 + 218,904*20 + 949,926*5 + 32,299,235*0.2, per million
  assert.equal(priceTokenUsage(OPUS_5_5, RUN7).toFixed(2), "15.60");
  const withDefaultRead = priceTokenUsage({ inputPerMtok: 4, outputPerMtok: 20, cacheWritePerMtok: 5 }, RUN7);
  assert.equal(withDefaultRead.toFixed(2), "22.06", "left at the 0.1x default it would overstate this run by $6.46: 32.3M cache reads at $0.40 instead of $0.20");
});

test("counts that are absent, negative, fractional-NaN or infinite are zero, never a negative bill", () => {
  assert.equal(priceTokenUsage(HAIKU_4_5, { input: 1_000_000, output: 0 }), 1, "a source with no cache fields prices as before");
  assert.equal(priceTokenUsage(HAIKU_4_5, { input: -5, output: Number.NaN, cacheWrite: Number.POSITIVE_INFINITY, cacheRead: -1 }), 0);
  assert.equal(priceTokenUsage(HAIKU_4_5, { input: 0, output: 0 }), 0);
});

// ------------------------------------------------------------- list prices

import { ANTHROPIC_LIST_PRICES, LIST_PRICES_AS_OF, listPriceFor } from "../../packages/protocol/src/pricing";

test("the list prices are the published ones, dated, and cache reads follow the model's own multiplier", () => {
  assert.match(LIST_PRICES_AS_OF, /^\d{4}-\d\d-\d\d$/);
  assert.deepEqual(Object.keys(ANTHROPIC_LIST_PRICES).sort(), ["claude-fable-5-1", "claude-haiku-4-5", "claude-opus-5-5", "claude-sonnet-5-5"]);
  const per = (model: string, usage: Parameters<typeof priceTokenUsage>[1]) => priceTokenUsage(listPriceFor(model)!, usage);
  // 1M of each class on each model: input + output + 1.25x input (write) + the model's own read price.
  assert.equal(per("claude-haiku-4-5", { input: 1e6, output: 1e6, cacheWrite: 1e6, cacheRead: 1e6 }), 1 + 5 + 1.25 + 0.1);
  assert.equal(per("claude-sonnet-5-5", { input: 1e6, output: 1e6, cacheWrite: 1e6, cacheRead: 1e6 }), 2 + 10 + 2.5 + 0.2);
  assert.equal(per("claude-opus-5-5", { input: 1e6, output: 1e6, cacheWrite: 1e6, cacheRead: 1e6 }), 4 + 20 + 5 + 0.2);
  assert.equal(per("claude-fable-5-1", { input: 1e6, output: 1e6, cacheWrite: 1e6, cacheRead: 1e6 }), 10 + 50 + 12.5 + 0.25);
});

test("a model id is matched as a runtime reports it: dated, provider-prefixed, any case; and only at a hyphen", () => {
  const haiku = ANTHROPIC_LIST_PRICES["claude-haiku-4-5"];
  for (const id of ["claude-haiku-4-5", "claude-haiku-4-5-20251001", "anthropic/claude-haiku-4-5", "anthropic/claude-haiku-4-5-20251001", "CLAUDE-HAIKU-4-5"]) {
    assert.equal(listPriceFor(id), haiku, id);
  }
  for (const id of ["claude-haiku-4-50", "claude-haiku-4", "claude-haiku", "haiku", "gpt-4o", "stub", "", "__proto__", "constructor"]) {
    assert.equal(listPriceFor(id), undefined, `'${id}' is not guessed at`);
  }
});
