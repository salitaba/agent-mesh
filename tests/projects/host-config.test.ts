import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  DEFAULT_SPEND_CEILING_USD,
  DEFAULT_USD_PER_MTOK,
  HOST_CONFIG_FILENAME,
  defaultHostConfig,
  hostConfigPath,
  loadHostConfig,
  parseHostConfig,
  priceUsage,
} from "../../packages/projects/src/index";

function tmpHome(contents?: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-hostcfg-"));
  if (contents !== undefined) fs.writeFileSync(path.join(home, HOST_CONFIG_FILENAME), contents, "utf8");
  return home;
}

test("a missing host.yaml is not an error and the ceiling is on by default", () => {
  const home = tmpHome();
  const config = loadHostConfig(home);
  assert.equal(config.spendCeilingUsd, DEFAULT_SPEND_CEILING_USD);
  assert.equal(config.projectMemoryMb, null);
  assert.equal(config.maxConcurrentTurns, null);
  assert.deepEqual(config.warnings, []);
  assert.equal(hostConfigPath(home), path.join(home, HOST_CONFIG_FILENAME));
});

test("the spec's host: block parses", () => {
  const config = parseHostConfig(`
host:
  project_memory_mb: 512
  max_concurrent_turns: null
  spend_ceiling_usd: 50
`);
  assert.equal(config.projectMemoryMb, 512);
  assert.equal(config.maxConcurrentTurns, null);
  assert.equal(config.spendCeilingUsd, 50);
  assert.deepEqual(config.warnings, []);
});

test("top-level keys work too, without the redundant host: nesting", () => {
  const config = parseHostConfig("project_memory_mb: 256\nspend_ceiling_usd: 10\n");
  assert.equal(config.projectMemoryMb, 256);
  assert.equal(config.spendCeilingUsd, 10);
});

test("explicit null disables the ceiling; absent takes the default", () => {
  assert.equal(parseHostConfig("host:\n  spend_ceiling_usd: null\n").spendCeilingUsd, null);
  assert.equal(parseHostConfig("host:\n  project_memory_mb: 512\n").spendCeilingUsd, DEFAULT_SPEND_CEILING_USD);
});

test("a broken file warns and falls back rather than refusing to boot", () => {
  const bad = parseHostConfig("host:\n  spend_ceiling_usd: [1, 2\n");
  assert.equal(bad.spendCeilingUsd, DEFAULT_SPEND_CEILING_USD);
  assert.equal(bad.warnings.length, 1);

  const negative = parseHostConfig("host:\n  project_memory_mb: -5\n");
  assert.equal(negative.projectMemoryMb, null);
  assert.match(negative.warnings[0]!, /project_memory_mb/);

  const notAMapping = parseHostConfig("- a\n- b\n");
  assert.equal(notAMapping.spendCeilingUsd, DEFAULT_SPEND_CEILING_USD);
  assert.equal(notAMapping.warnings.length, 1);
});

test("an empty file is the same as no file", () => {
  const home = tmpHome("");
  assert.deepEqual(loadHostConfig(home), defaultHostConfig());
});

test("model_prices accepts a bare rate or a split input/output pair", () => {
  const config = parseHostConfig(`
host:
  model_prices:
    cheap: 1
    split:
      input_per_mtok: 3
      output_per_mtok: 15
    broken: "free"
`);
  assert.deepEqual(config.modelPrices.cheap, { inputPerMtok: 1, outputPerMtok: 1 });
  assert.deepEqual(config.modelPrices.split, { inputPerMtok: 3, outputPerMtok: 15 });
  assert.equal(config.modelPrices.broken, undefined);
  assert.match(config.warnings[0]!, /model_prices\.broken/);
});

test("input and output are priced separately", () => {
  const config = parseHostConfig("host:\n  model_prices:\n    m:\n      input_per_mtok: 3\n      output_per_mtok: 15\n");
  // 1M input at $3 + 1M output at $15.
  assert.equal(priceUsage(config, "m", { input: 1_000_000, output: 1_000_000 }), 18);
  assert.equal(priceUsage(config, "m", { input: 500_000, output: 0 }), 1.5);
});

test("an unpriced model bills at the fallback, never at zero", () => {
  // Billing an unknown model at zero would make it an invisible way to spend
  // past the ceiling, which is the one thing a backstop cannot allow.
  const config = defaultHostConfig();
  assert.equal(priceUsage(config, "never-heard-of-it", { input: 1_000_000, output: 0 }), DEFAULT_USD_PER_MTOK);
  assert.ok(priceUsage(config, "never-heard-of-it", { input: 1_000, output: 1_000 }) > 0);
});

test("default_usd_per_mtok overrides the fallback rate", () => {
  const config = parseHostConfig("host:\n  default_usd_per_mtok: 10\n");
  assert.equal(config.defaultUsdPerMtok, 10);
  assert.equal(priceUsage(config, "unknown", { input: 1_000_000, output: 0 }), 10);
});

test("model_prices can carry cache prices, and a bad one is dropped with a warning while the model stays priced", () => {
  const config = parseHostConfig(`
model_prices:
  full: { input_per_mtok: 4, output_per_mtok: 20, cache_write_per_mtok: 5, cache_read_per_mtok: 0.2 }
  partial: { input_per_mtok: 1, output_per_mtok: 5, cache_read_per_mtok: 0.05 }
  broken: { input_per_mtok: 2, output_per_mtok: 8, cache_read_per_mtok: lots, cache_write_per_mtok: -1 }
  plain: { input_per_mtok: 1, output_per_mtok: 5 }
`);
  assert.deepEqual(config.modelPrices.full, { inputPerMtok: 4, outputPerMtok: 20, cacheWritePerMtok: 5, cacheReadPerMtok: 0.2 });
  assert.deepEqual(config.modelPrices.partial, { inputPerMtok: 1, outputPerMtok: 5, cacheReadPerMtok: 0.05 });
  assert.deepEqual(config.modelPrices.broken, { inputPerMtok: 2, outputPerMtok: 8 }, "bad cache prices fall back to the default multipliers; the row is not lost");
  assert.deepEqual(config.modelPrices.plain, { inputPerMtok: 1, outputPerMtok: 5 });
  assert.equal(config.warnings.filter((w) => /model_prices\.broken\.cache_(read|write)_per_mtok must be a number >= 0/.test(w)).length, 2);
});

test("priceUsage counts all four token classes, and a usage with no cache fields is just input and output", () => {
  const config = defaultHostConfig();
  config.modelPrices = { m: { inputPerMtok: 1, outputPerMtok: 5 }, cheap: { inputPerMtok: 4, outputPerMtok: 20, cacheWritePerMtok: 5, cacheReadPerMtok: 0.2 } };
  // 100k in + 100k out + 1M written + 40M read, at 1 / 5 / 1.25 / 0.10
  assert.equal(priceUsage(config, "m", { input: 100_000, output: 100_000, cacheWrite: 1_000_000, cacheRead: 40_000_000 }).toFixed(2), "5.85");
  assert.equal(priceUsage(config, "cheap", { input: 0, output: 0, cacheRead: 1_000_000 }), 0.2, "an explicit cache price is used as given");
  assert.equal(priceUsage(config, "m", { input: 1_000_000, output: 1_000_000 }), 6, "1M in at $1 + 1M out at $5");
  assert.equal(priceUsage(config, "m", { input: 0, output: 0 }), 0);
});

test("an unpriced model is billed at the default rate for every class, cache traffic included", () => {
  const config = defaultHostConfig();
  config.defaultUsdPerMtok = 10;
  // 1M of each class: 10 (input) + 10 (output) + 12.5 (write at 1.25x) + 1 (read at 0.1x)
  assert.equal(priceUsage(config, "never-heard-of-it", { input: 1_000_000, output: 1_000_000, cacheWrite: 1_000_000, cacheRead: 1_000_000 }), 33.5);
});

test("a model named like something every object inherits is an unpriced model, not an inherited object", () => {
  const config = defaultHostConfig();
  config.defaultUsdPerMtok = 10;
  config.modelPrices = { real: { inputPerMtok: 1, outputPerMtok: 1 } };
  for (const model of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "prototype"]) {
    const cost = priceUsage(config, model, { input: 1_000_000, output: 0 });
    assert.equal(cost, 10, `${model}: the default rate, a number the ceiling can compare (not NaN from an inherited object)`);
  }
  assert.equal(priceUsage(config, "real", { input: 1_000_000, output: 0 }), 1, "a real entry still wins");
});

test("host.yaml cannot name a reserved model id, and it does not disturb the other rows", () => {
  const config = parseHostConfig("host:\n  model_prices:\n    constructor: 5\n    ok: { input_per_mtok: 1, output_per_mtok: 2 }\n    \"__proto__\": 7\n");
  assert.deepEqual(Object.keys(config.modelPrices), ["ok"]);
  assert.equal(Object.getPrototypeOf(config.modelPrices), Object.prototype, "the table's own prototype was not replaced");
  assert.equal(config.warnings.filter((w) => /reserved name/.test(w)).length, 2);
});

test("a current Anthropic model is priced at its published list price unless host.yaml says otherwise, and anything else at the default", () => {
  const config = defaultHostConfig();
  config.defaultUsdPerMtok = 3;
  config.modelPrices = { "claude-sonnet-5-5": { inputPerMtok: 1, outputPerMtok: 1 } };
  const one = (model: string) => priceUsage(config, model, { input: 1_000_000, output: 1_000_000 });
  assert.equal(one("claude-haiku-4-5-20251001"), 1 + 5, "Haiku at its list price, not at $3 an input token");
  assert.equal(one("anthropic/claude-opus-5-5"), 4 + 20, "Opus's output at $20, not $3");
  assert.equal(one("claude-sonnet-5-5"), 2, "what the operator wrote beats the list price");
  assert.equal(one("some-other-model"), 3 + 3, "an unknown model is priced at the default for both");
  // The default rate's own cache multipliers still apply to the unknown one.
  assert.ok(Math.abs(priceUsage(config, "some-other-model", { input: 0, output: 0, cacheRead: 1_000_000 }) - 0.3) < 1e-12);
});
