#!/usr/bin/env node
/**
 * Writes pricing/plans.json from the plan table, the model list prices and pricing/measured-runs.json.
 *
 *   node scripts/export-pricing.mjs           write it
 *   node scripts/export-pricing.mjs --check   exit 1 if the committed file is out of date (what CI runs)
 *
 * Needs a build first (`npx tsc -p tsconfig.json`): the tables live in TypeScript and this reads the compiled
 * output, so there is one copy of every number.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const built = path.join(root, "dist", "packages", "licensing", "src", "export.js");
if (!fs.existsSync(built)) {
  console.error("export-pricing: dist/ is not built; run `npx tsc -p tsconfig.json` first");
  process.exit(2);
}
const { buildPricingExport } = require(built);
const measured = JSON.parse(fs.readFileSync(path.join(root, "pricing", "measured-runs.json"), "utf8"));
const text = `${JSON.stringify(buildPricingExport(measured.runs), null, 2)}\n`;
const target = path.join(root, "pricing", "plans.json");

if (process.argv.includes("--check")) {
  const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  if (current !== text) {
    console.error("pricing/plans.json is out of date: run `node scripts/export-pricing.mjs` and commit the result");
    process.exit(1);
  }
  console.log("pricing/plans.json is up to date");
} else {
  fs.writeFileSync(target, text, "utf8");
  console.log(`wrote ${path.relative(root, target)}`);
}
