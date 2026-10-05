import { test } from "node:test";
import assert from "node:assert/strict";
import { Router, parsePriceTable, type Candidate, type Tier } from "../../packages/ai-gateway/src/index";
import { priceTable } from "./support";

const cand = (id: string, over: Partial<Candidate> = {}): Candidate => ({ id, provider: id.split("/")[0]!, model: id.split("/").slice(1).join("/"), maxOutputTokens: 4096, ...over });
const tier = (name: string, ...ids: string[]): Tier => ({ name, candidates: ids.map((id) => cand(id)) });

const prices = priceTable();

test("a tier is the chain of models behind a name, in the order they are to be tried", () => {
  const router = new Router([tier("fast", "alpha/small"), tier("balanced", "alpha/small", "beta/other"), tier("best", "alpha/large")], prices, ["alpha", "beta"]);
  assert.deepEqual(router.names(), ["fast", "balanced", "best"]);
  assert.deepEqual(router.resolve("balanced")?.map((c) => c.id), ["alpha/small", "beta/other"]);
  assert.deepEqual(router.resolve("best")?.map((c) => c.id), ["alpha/large"]);
  assert.equal(router.resolve("fast")?.[0]?.model, "small");
  assert.equal(router.resolve("unknown"), undefined);
  assert.equal(router.resolve("alpha/small"), undefined, "a provider's own model name is not a tier");
  assert.equal(router.resolve(""), undefined);
});

test("a key's allowlist narrows what it can name and what it is told exists", () => {
  const router = new Router([tier("fast", "alpha/small"), tier("balanced", "beta/other"), tier("best", "alpha/large")], prices, ["alpha", "beta"]);
  assert.deepEqual(router.names(["fast", "best"]), ["fast", "best"]);
  assert.deepEqual(router.names(["balanced", "elsewhere"]), ["balanced"], "a name that is not a tier is not listed");
  assert.deepEqual(router.names([]), []);
  assert.deepEqual(router.resolve("fast", ["fast"])?.map((c) => c.id), ["alpha/small"]);
  assert.equal(router.resolve("best", ["fast"]), undefined);
  assert.equal(router.resolve("fast", []), undefined);
});

test("a provider's model name may have slashes of its own", () => {
  const router = new Router([{ name: "fast", candidates: [cand("router/vendor/model")] }], parsePrices(), ["router"]);
  assert.equal(router.resolve("fast")?.[0]?.model, "vendor/model");
});

function parsePrices() {
  return parsePriceTable({ currency: "USD", version: "v", default_markup: 1.2, models: { "router/vendor/model": { input: 1, output: 1, cache_read: 0, cache_write: 0 } } });
}

test("a router that cannot work is refused with every reason at once, naming the tier and the model", () => {
  const problems = (tiers: Tier[], providers: string[] = ["alpha", "beta"]): string[] => {
    try {
      new Router(tiers, prices, providers);
    } catch (err) {
      return (err as Error).message.split("\n");
    }
    assert.fail("the router was built");
  };
  assert.deepEqual(problems([]), ["no tiers are defined"]);
  assert.deepEqual(problems([tier("has space", "alpha/small")]), ["tier 'has space': a name is 1 to 64 letters, digits and . _ -"]);
  assert.deepEqual(problems([tier("x".repeat(65), "alpha/small")]).length, 1);
  assert.deepEqual(problems([tier("fast", "alpha/small"), tier("fast", "alpha/large")]), ["tier 'fast' is defined twice"]);
  assert.deepEqual(problems([{ name: "fast", candidates: [] }]), ["tier 'fast' lists no models"]);
  assert.deepEqual(problems([tier("fast", "gamma/small")]), [
    "tier 'fast': 'gamma/small' names provider 'gamma', which is not configured (providers: alpha, beta)",
    "tier 'fast': 'gamma/small' has no price; add it to the price table, because a call that is not priced is a call nobody is billed for",
  ]);
  assert.match(problems([tier("fast", "alpha/small")], [])[0]!, /\(providers: none\)/);
  assert.deepEqual(problems([tier("fast", "alpha/unpriced")]), ["tier 'fast': 'alpha/unpriced' has no price; add it to the price table, because a call that is not priced is a call nobody is billed for"]);
  for (const max of [0, -5, 1.5, NaN]) {
    assert.deepEqual(problems([{ name: "fast", candidates: [cand("alpha/small", { maxOutputTokens: max })] }]), ["tier 'fast': 'alpha/small' needs a max_output_tokens that is a whole number of at least 1"], String(max));
  }
  assert.equal(problems([{ name: "bad name", candidates: [] }, tier("fast", "gamma/x")]).length, 4, "one line per problem, across tiers");
});
