#!/usr/bin/env node
/**
 * Writes everything that is generated from the plan table:
 *
 *   pricing/plans.json            the table, the model list prices and the measured runs, as JSON
 *   site/plans.json              the same file, served beside the pricing page
 *   docs/commercial/pricing.md   its two fenced blocks (the plan table and the unit economics)
 *
 *   node scripts/export-pricing.mjs           write them
 *   node scripts/export-pricing.mjs --check   exit 1 if any of them is out of date (what CI runs)
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
const { buildPricingExport, renderPlansTable, renderEconomics, replaceGeneratedBlock } = require(built);
const measured = JSON.parse(fs.readFileSync(path.join(root, "pricing", "measured-runs.json"), "utf8"));
const exported = buildPricingExport(measured.runs);
const json = `${JSON.stringify(exported, null, 2)}\n`;

const pricingDoc = path.join(root, "docs", "commercial", "pricing.md");
if (!fs.existsSync(pricingDoc)) {
  console.error("export-pricing: docs/commercial/pricing.md is missing");
  process.exit(2);
}
let doc = fs.readFileSync(pricingDoc, "utf8");
doc = replaceGeneratedBlock(doc, "plans", renderPlansTable(exported));
doc = replaceGeneratedBlock(doc, "economics", renderEconomics(exported));

const targets = [
  [path.join(root, "pricing", "plans.json"), json],
  [path.join(root, "site", "plans.json"), json],
  [pricingDoc, doc],
];

if (process.argv.includes("--check")) {
  const stale = targets.filter(([file, text]) => !fs.existsSync(file) || fs.readFileSync(file, "utf8") !== text).map(([file]) => path.relative(root, file));
  if (stale.length > 0) {
    console.error(`out of date: ${stale.join(", ")}\nrun \`node scripts/export-pricing.mjs\` and commit the result`);
    process.exit(1);
  }
  console.log("pricing files are up to date");
} else {
  for (const [file, text] of targets) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, "utf8");
    console.log(`wrote ${path.relative(root, file)}`);
  }
}
