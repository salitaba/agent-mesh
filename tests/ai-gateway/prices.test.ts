import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadPriceTable, parsePriceTable, PriceTable } from "../../packages/ai-gateway/src/index";

const valid = () => ({
  currency: "usd",
  version: "2026-10-05",
  default_markup: 1.25,
  models: {
    "alpha/small": { input: 0.15, output: 0.6, cache_read: 0.075, cache_write: 0 },
    "alpha/large": { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75, markup: 1.5 },
    "router/vendor/model": { input: 1, output: 2, cache_read: 0, cache_write: 0 },
  },
});

test("a price table is read: rates in micro-units, the currency in capitals, the default markup and a per-model one", () => {
  const t = parsePriceTable(valid());
  assert.equal(t.currency, "USD");
  assert.equal(t.version, "2026-10-05");
  assert.deepEqual(t.ids().sort(), ["alpha/large", "alpha/small", "router/vendor/model"]);
  assert.deepEqual(t.get("alpha/small"), { id: "alpha/small", rates: { input: 150_000, output: 600_000, cacheRead: 75_000, cacheWrite: 0 }, markupBps: 12_500 });
  assert.equal(t.get("alpha/large")?.markupBps, 15_000, "an entry's own markup wins over the default");
  assert.equal(t.has("alpha/small"), true);
  assert.equal(t.has("alpha/none"), false);
  assert.equal(t.get("alpha/none"), undefined);
});

test("a model id with slashes of its own is kept whole", () => {
  assert.equal(parsePriceTable(valid()).has("router/vendor/model"), true);
});

test("a call is priced at the model it ran on: what it cost and what the customer is charged", () => {
  const t = parsePriceTable(valid());
  const usage = { input: 1_000_000, output: 1_000_000, cacheRead: 2_000_000, cacheWrite: 0 };
  // 0.15 + 0.6 + 2 x 0.075 = 0.9 units; at 1.25 that is 1.125.
  assert.deepEqual(t.price("alpha/small", usage), { costMicros: 900_000, chargeMicros: 1_125_000 });
  // The large model: 3 + 15 + 2 x 0.3 = 18.6 units; at 1.5 that is 27.9.
  assert.deepEqual(t.price("alpha/large", usage), { costMicros: 18_600_000, chargeMicros: 27_900_000 });
  assert.throws(() => t.price("alpha/none", usage), /no price for model 'alpha\/none' \(known: alpha\/small, alpha\/large, router\/vendor\/model\)/);
});

test("the version may be written as a number, and it is kept as text", () => {
  assert.equal(parsePriceTable({ ...valid(), version: 2026 }).version, "2026");
});

test("whitespace around the currency and the version is not part of them", () => {
  const t = parsePriceTable({ ...valid(), currency: " usd ", version: "  v1  " });
  assert.equal(t.currency, "USD");
  assert.equal(t.version, "v1");
});

test("a table with no models says so when asked for a price", () => {
  const empty = new PriceTable("USD", "v", new Map());
  assert.throws(() => empty.price("a/b", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }), /no price for model 'a\/b' \(known: none\)/);
});

test("a rate that is left out is an error that says which one and what to write: nothing is defaulted", () => {
  for (const key of ["input", "output", "cache_read", "cache_write"]) {
    const raw = valid();
    delete (raw.models["alpha/small"] as Record<string, unknown>)[key];
    assert.throws(() => parsePriceTable(raw, "prices.yaml"), new RegExp(`prices\\.yaml: models\\.alpha/small\\.${key} is missing; write 0 where the provider does not charge for it`), key);
  }
});

test("a markup below one is refused unless the table says it is meant, because it sells below cost", () => {
  assert.throws(() => parsePriceTable({ ...valid(), default_markup: 0.9 }), /default_markup 0\.9 is below 1, which sells below cost; set allow_below_cost: true/);
  const raw = valid();
  (raw.models["alpha/small"] as Record<string, unknown>).markup = 0.8;
  assert.throws(() => parsePriceTable(raw), /models\.alpha\/small\.markup 0\.8 is below 1/);
  assert.equal(parsePriceTable({ ...valid(), default_markup: 0.9, allow_below_cost: true }).get("alpha/small")?.markupBps, 9_000);
  assert.equal(parsePriceTable({ ...valid(), default_markup: 1 }).get("alpha/small")?.markupBps, 10_000, "exactly one is at cost, not below it");
  assert.equal(parsePriceTable({ ...raw, allow_below_cost: true }).get("alpha/small")?.markupBps, 8_000, "an entry below cost is allowed when the table says it is meant");
});

test("the table's own fields are required and checked", () => {
  assert.throws(() => parsePriceTable({ ...valid(), currency: undefined }), /currency must be a code such as USD/);
  assert.throws(() => parsePriceTable({ ...valid(), currency: "US" }), /currency must be a code such as USD/);
  assert.throws(() => parsePriceTable({ ...valid(), currency: "$" }), /currency must be a code such as USD/);
  assert.throws(() => parsePriceTable({ ...valid(), version: "" }), /version must say which figures these are/);
  assert.throws(() => parsePriceTable({ ...valid(), version: undefined }), /version must say which figures these are/);
  assert.throws(() => parsePriceTable({ ...valid(), default_markup: undefined }), /default_markup must be a factor/);
  assert.throws(() => parsePriceTable({ ...valid(), models: {} }), /models must list at least one provider\/model/);
  assert.throws(() => parsePriceTable({ ...valid(), models: undefined }), /models must list at least one provider\/model/);
  assert.throws(() => parsePriceTable(null), /expected a mapping/);
  assert.throws(() => parsePriceTable([]), /expected a mapping/);
  assert.throws(() => parsePriceTable("x"), /expected a mapping/);
});

test("a model that is not written provider/model, or whose entry is not a mapping, is refused", () => {
  assert.throws(() => parsePriceTable({ ...valid(), models: { gpt: valid().models["alpha/small"] } }), /models\.gpt must be written provider\/model/);
  assert.throws(() => parsePriceTable({ ...valid(), models: { "alpha/": valid().models["alpha/small"] } }), /models\.alpha\/ must be written provider\/model/);
  assert.throws(() => parsePriceTable({ ...valid(), models: { "alpha/x": 3 } }), /models\.alpha\/x must be a mapping of rates/);
  assert.throws(() => parsePriceTable({ ...valid(), models: { "alpha/x": null } }), /models\.alpha\/x must be a mapping of rates/);
});

test("every problem is reported at once, each with the source's name, so one edit fixes the file", () => {
  const raw = valid();
  (raw.models["alpha/small"] as Record<string, unknown>).input = "free";
  delete (raw.models["alpha/large"] as Record<string, unknown>).output;
  let message = "";
  try {
    parsePriceTable({ ...raw, version: "" }, "prices.yaml");
  } catch (err) {
    message = (err as Error).message;
  }
  const lines = message.split("\n");
  assert.equal(lines.length, 3, message);
  assert.ok(lines.every((l) => l.startsWith("prices.yaml: ")), message);
  assert.match(message, /version must say/);
  assert.match(message, /models\.alpha\/small\.input must be a number/);
  assert.match(message, /models\.alpha\/large\.output is missing/);
});

test("a price table is read from a YAML file, and a file that cannot be read says so by name", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prices-"));
  try {
    const file = path.join(dir, "prices.yaml");
    fs.writeFileSync(file, ["currency: USD", "version: 2026-10-05", "default_markup: 1.3", "models:", "  alpha/small: { input: 0.15, output: 0.6, cache_read: 0.075, cache_write: 0 }", ""].join("\n"));
    const t = loadPriceTable(file);
    assert.equal(t.currency, "USD");
    assert.equal(t.get("alpha/small")?.markupBps, 13_000);
    assert.throws(() => loadPriceTable(path.join(dir, "missing.yaml")), /cannot read the price table .*missing\.yaml/);
    fs.writeFileSync(file, "models: [unclosed");
    assert.throws(() => loadPriceTable(file), /the price table .*prices\.yaml is not valid YAML/);
    fs.writeFileSync(file, "currency: USD\n");
    assert.throws(() => loadPriceTable(file), new RegExp(`${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: version must say`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
