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
  priceTokens,
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
  assert.equal(priceTokens(config, "m", 1_000_000, 1_000_000), 18);
  assert.equal(priceTokens(config, "m", 500_000, 0), 1.5);
});

test("an unpriced model bills at the fallback, never at zero", () => {
  // Billing an unknown model at zero would make it an invisible way to spend
  // past the ceiling, which is the one thing a backstop cannot allow.
  const config = defaultHostConfig();
  assert.equal(priceTokens(config, "never-heard-of-it", 1_000_000, 0), DEFAULT_USD_PER_MTOK);
  assert.ok(priceTokens(config, "never-heard-of-it", 1_000, 1_000) > 0);
});

test("default_usd_per_mtok overrides the fallback rate", () => {
  const config = parseHostConfig("host:\n  default_usd_per_mtok: 10\n");
  assert.equal(config.defaultUsdPerMtok, 10);
  assert.equal(priceTokens(config, "unknown", 1_000_000, 0), 10);
});
