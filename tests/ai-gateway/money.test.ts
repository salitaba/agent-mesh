import { test } from "node:test";
import assert from "node:assert/strict";
import { chargeMicros, costMicros, formatMoney, parseMarkup, parseRate, type Rates } from "../../packages/ai-gateway/src/index";

const usage = (u: Partial<{ input: number; output: number; cacheRead: number; cacheWrite: number }>) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...u });

test("a rate is a decimal number of currency units per million tokens, kept as whole micro-units", () => {
  assert.equal(parseRate("0.15", "r"), 150_000);
  assert.equal(parseRate(0.15, "r"), 150_000);
  assert.equal(parseRate(15, "r"), 15_000_000);
  assert.equal(parseRate("1.234567", "r"), 1_234_567);
  assert.equal(parseRate("0.000001", "r"), 1);
  assert.equal(parseRate(0, "r"), 0);
});

test("a rate that is not a price is refused by name: negative, not a number, an exponent, finer than six decimals", () => {
  for (const bad of [-1, "-1", "abc", "", undefined, null, {}, "1.2345678", 1e-7, "1e3", NaN, Infinity, "1,5"]) {
    assert.throws(() => parseRate(bad, "models.x/y.input"), /models\.x\/y\.input must be a number of currency units per million tokens/, String(bad));
  }
});

test("a markup is a factor kept as basis points, to four decimals", () => {
  assert.equal(parseMarkup(1.25, "m"), 12_500);
  assert.equal(parseMarkup("1", "m"), 10_000);
  assert.equal(parseMarkup(0.5, "m"), 5_000);
  assert.equal(parseMarkup("1.0001", "m"), 10_001);
  for (const bad of [-1, "x", "1.00005", undefined, "1e1"]) assert.throws(() => parseMarkup(bad, "default_markup"), /default_markup must be a factor/, String(bad));
});

test("the four kinds of token are priced at their own rates", () => {
  // One million of each, at 1, 2, 3 and 4 units per million: 10 units, which is 10,000,000 micro-units.
  const rates: Rates = { input: 1_000_000, output: 2_000_000, cacheRead: 3_000_000, cacheWrite: 4_000_000 };
  const all = usage({ input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 });
  assert.equal(costMicros(all, rates), 10_000_000);
  assert.equal(costMicros(usage({ input: 1_000_000 }), rates), 1_000_000);
  assert.equal(costMicros(usage({ output: 1_000_000 }), rates), 2_000_000);
  assert.equal(costMicros(usage({ cacheRead: 1_000_000 }), rates), 3_000_000);
  assert.equal(costMicros(usage({ cacheWrite: 1_000_000 }), rates), 4_000_000);
});

test("a call is rounded up once, to the next micro-unit, and not once per kind of token", () => {
  const rates: Rates = { input: 150_000, output: 600_000, cacheRead: 0, cacheWrite: 0 };
  // 0.15 + 0.6 = 0.75 of a micro-unit: one, not the two that rounding each term would make.
  assert.equal(costMicros(usage({ input: 1, output: 1 }), rates), 1);
  // A call that costs nothing costs nothing.
  assert.equal(costMicros(usage({}), rates), 0);
});

test("the charge is the exact cost times the markup, rounded up once, and not the rounded cost times the markup", () => {
  const rates: Rates = { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 };
  const u = usage({ input: 800_000 }); // 0.8 of a micro-unit
  assert.equal(costMicros(u, rates), 1);
  assert.equal(chargeMicros(u, rates, 12_500), 1); // 0.8 x 1.25 = 1.0 exactly
  assert.equal(chargeMicros(usage({ input: 800_001 }), rates, 12_500), 2); // one token more tips it over
  assert.equal(chargeMicros(u, rates, 10_000), costMicros(u, rates), "a markup of one charges what it cost");
});

test("the markup scales a whole-unit price exactly", () => {
  const rates: Rates = { input: 3_000_000, output: 15_000_000, cacheRead: 300_000, cacheWrite: 3_750_000 };
  const u = usage({ input: 1_000, output: 2_000, cacheRead: 500_000, cacheWrite: 10_000 });
  // 0.003 + 0.030 + 0.150 + 0.0375 = 0.2205 units
  assert.equal(costMicros(u, rates), 220_500);
  assert.equal(chargeMicros(u, rates, 15_000), 330_750);
});

test("token counts that are not counts are treated as zero, and fractions are floored", () => {
  const rates: Rates = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 };
  assert.equal(costMicros(usage({ input: -5, output: NaN, cacheRead: Infinity }), rates), 0);
  assert.equal(costMicros(usage({ input: 2.9 }), rates), 2);
});

test("a figure too large to hold exactly is an error, not a rounded number", () => {
  const rates: Rates = { input: 1_000_000_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };
  assert.throws(() => costMicros(usage({ input: 10_000_000_000_000 }), rates), RangeError);
  // Large but exact is fine: five billion tokens at a million units per million tokens is five billion units.
  assert.equal(costMicros(usage({ input: 5_000_000_000 }), rates), 5_000_000_000_000_000);
});

test("the largest figure that can be held exactly is accepted, and the next one is refused", () => {
  // At one unit per million tokens the cost in micro-units is the token count itself.
  const rates: Rates = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };
  assert.equal(costMicros(usage({ input: Number.MAX_SAFE_INTEGER }), rates), Number.MAX_SAFE_INTEGER);
  assert.throws(() => costMicros(usage({ input: Number.MAX_SAFE_INTEGER + 1 }), rates), /cost does not fit in a safe integer/);
  assert.throws(() => chargeMicros(usage({ input: Number.MAX_SAFE_INTEGER }), rates, 10_001), /charge does not fit in a safe integer/);
});

test("an amount for people has two decimals, and enough that a sub-cent figure does not read as zero", () => {
  assert.equal(formatMoney(0, "USD"), "USD 0.00");
  assert.equal(formatMoney(120_000, "USD"), "USD 0.12");
  assert.equal(formatMoney(2_500_000, "USD"), "USD 2.50");
  assert.equal(formatMoney(1_234_567, "USD"), "USD 1.23");
  assert.equal(formatMoney(10_000, "USD"), "USD 0.01");
  assert.equal(formatMoney(9_999, "USD"), "USD 0.0099");
  assert.equal(formatMoney(4_200, "USD"), "USD 0.0042");
  assert.equal(formatMoney(1, "USD"), "USD 0.000001");
  assert.equal(formatMoney(-200_000, "USD"), "USD -0.20");
  assert.equal(formatMoney(-4_200, "USD"), "USD -0.0042");
  assert.equal(formatMoney(120_000, "EUR"), "EUR 0.12");
});
