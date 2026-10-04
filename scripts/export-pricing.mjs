#!/usr/bin/env node
/**
 * Writes everything that is generated from the plan table:
 *
 *   pricing/plans.json            the table, the model list prices and the measured runs, as JSON
 *   site/pricing/index.html       the same data inlined in the page's fenced `plans-json` block (so the calculator needs no
 *                                 fetch and the page opens from a file as well as from a server), and the HTML the page shows
 *                                 of it: the plan cards (`plan-cards`), the comparison table (`plan-table`) and the measured
 *                                 mission priced at each model (`run-costs`), so that nothing on the page is typed by hand
 *                                 and it reads without a script
 *   site/index.html               the four plans in a line (`plan-teaser`)
 *   docs/commercial/pricing.md    its two fenced blocks (the plan table and the unit economics)
 *
 *   node scripts/export-pricing.mjs           write them
 *   node scripts/export-pricing.mjs --check   exit 1 if any of them is out of date (what CI runs)
 *
 * Needs a build first (`npx tsc -p tsconfig.json`): the tables live in TypeScript and this reads the compiled
 * output, so there is one copy of every number. `--root <dir>` reads and writes the files under another folder (a test
 * uses it); the compiled output is always this repository's.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { renderPlanCards, renderPlanTable, renderRunCosts, renderPlanTeaser } from "./pricing-html.mjs";

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rootFlag = process.argv.indexOf("--root");
const root = rootFlag >= 0 ? path.resolve(process.argv[rootFlag + 1] ?? "") : here;
const require = createRequire(import.meta.url);
const built = path.join(here, "dist", "packages", "licensing", "src", "export.js");
if (!fs.existsSync(built)) {
  console.error("export-pricing: dist/ is not built; run `npx tsc -p tsconfig.json` first");
  process.exit(2);
}
const { buildPricingExport, renderPlansTable, renderEconomics, renderSiteData, replaceGeneratedBlock } = require(built);
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

/** What each fenced block of a page holds. A block that is fenced in a page is rewritten; the ones a page must have, if it is there, are listed. */
const BLOCKS = {
  "plans-json": renderSiteData(exported),
  "plan-cards": renderPlanCards(exported),
  "plan-table": renderPlanTable(exported),
  "run-costs": renderRunCosts(exported),
  "plan-teaser": renderPlanTeaser(exported),
};
const PAGES = [
  { file: "site/pricing/index.html", required: ["plans-json", "plan-cards", "plan-table", "run-costs"] },
  { file: "site/index.html", required: [] },
];

const targets = [
  [path.join(root, "pricing", "plans.json"), json],
  [pricingDoc, doc],
];
let fencedAnywhere = 0;
for (const { file, required } of PAGES) {
  const abs = path.join(root, file);
  // A page that is not there is the site tests' business (they list the pages); one that is there must fence what it needs.
  if (!fs.existsSync(abs)) continue;
  let page = fs.readFileSync(abs, "utf8");
  for (const [name, content] of Object.entries(BLOCKS)) {
    const fenced = page.includes(`<!-- generated:${name}:start`);
    if (!fenced) {
      if (required.includes(name)) {
        console.error(`export-pricing: ${file} does not fence the block '${name}' (<!-- generated:${name}:start ... --> and <!-- generated:${name}:end -->)`);
        process.exit(2);
      }
      continue;
    }
    page = replaceGeneratedBlock(page, name, content);
    fencedAnywhere++;
  }
  targets.push([abs, page]);
}
if (fencedAnywhere === 0) {
  console.error("export-pricing: no page fences a generated block");
  process.exit(2);
}

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
