/**
 * The pricing a buyer reads must be the pricing the product enforces.
 *
 * `pricing/plans.json` is generated from the plan table; the page, the calculator and the sales documents read
 * it. These tests fail when the committed file is stale, when a plan's prose disagrees with its numbers, when a
 * higher plan gives less than a lower one, and when a feature a plan lists is checked by no code at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import {
  FEATURE_IDS,
  PLANS,
  PLAN_IDS,
  buildPricingExport,
  generatedBlock,
  renderEconomics,
  renderPlansTable,
  renderSiteData,
  replaceGeneratedBlock,
  type MeasuredRun,
  type PlanId,
} from "../../packages/licensing/src/index";
import { ANTHROPIC_LIST_PRICES, LIST_PRICES_AS_OF } from "../../packages/protocol/src/index";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const read = (...p: string[]): string => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const measured = (): MeasuredRun[] => JSON.parse(read("pricing", "measured-runs.json")).runs as MeasuredRun[];

test("pricing/plans.json is what the plan table, the list prices and the measured runs generate", () => {
  const generated = `${JSON.stringify(buildPricingExport(measured()), null, 2)}\n`;
  assert.equal(read("pricing", "plans.json"), generated, "out of date: run `node scripts/export-pricing.mjs` and commit the result");
});

test("the pricing page carries the same data, inlined, and the pages are what the generator makes of it", () => {
  const exported = buildPricingExport(measured());
  const page = read("site", "pricing", "index.html");
  assert.equal(page, replaceGeneratedBlock(page, "plans-json", renderSiteData(exported)), "out of date: run `node scripts/export-pricing.mjs` and commit the result");
  const m = /<script type="application\/json" id="plans-data">([\s\S]*?)<\/script>/.exec(page);
  assert.ok(m, "the data element is in the page");
  assert.deepEqual(JSON.parse(m![1]!), exported, "and parses back to the export");
  assert.ok(!m![1]!.includes("<"), "no raw < inside the data element");
  assert.ok(!read("site", "index.html").includes('id="plans-data"'), "the data is in one place: the pricing page");
  // The HTML the pages show of it (the plan cards, the comparison table, the measured mission at each model's price, the home
  // page's line of plans) is written by the same script from the same export: it says so when any of it is out of date.
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "export-pricing.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});

test("the plan cards, the table and the home page's plans show every price and every limit of the plan table, and nothing else", () => {
  const exported = buildPricingExport(measured());
  const pricing = read("site", "pricing", "index.html");
  const cards = /<!-- generated:plan-cards:start[^>]*-->([\s\S]*?)<!-- generated:plan-cards:end -->/.exec(pricing)![1]!;
  const table = /<!-- generated:plan-table:start[^>]*-->([\s\S]*?)<!-- generated:plan-table:end -->/.exec(pricing)![1]!;
  const teaser = /<!-- generated:plan-teaser:start[^>]*-->([\s\S]*?)<!-- generated:plan-teaser:end -->/.exec(read("site", "index.html"))![1]!;
  const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/&rsquo;/g, "'").replace(/&infin;/g, "unlimited").replace(/\s+/g, " ");
  assert.equal((cards.match(/<article class="plan"/g) ?? []).length, PLAN_IDS.length, "one card for each plan");
  for (const id of PLAN_IDS) {
    const plan = PLANS[id];
    const card = new RegExp(`<article class="plan" id="plan-${id}"[\\s\\S]*?</article>`).exec(cards)?.[0];
    assert.ok(card, `${plan.name}: a card`);
    const t = text(card!);
    assert.ok(t.includes(plan.name) && t.includes(plan.tagline), `${plan.name}: name and tagline`);
    assert.ok(t.includes(plan.support), `${plan.name}: support`);
    for (const line of plan.includes) assert.ok(t.includes(line), `${plan.name}: "${line}"`);
    if (plan.roadmap.length > 0) assert.ok(t.includes(`Planned, not included: ${plan.roadmap.join("; ")}`), `${plan.name}: its roadmap is introduced as planned`);
    else assert.ok(!t.includes("Planned, not included"), `${plan.name}: nothing planned is shown that the table does not list`);
    if (plan.pricing === "listed") {
      const [annual, monthly] = [`$${plan.priceMonthlyAnnualUsd} per month, billed annually ($${plan.priceMonthlyAnnualUsd! * 12} a year)`, `$${plan.priceMonthlyUsd} per month, billed monthly`].map((s) => s.replace(/\$(\d{4,})/g, (_, n: string) => `$${Number(n).toLocaleString("en-US")}`));
      assert.ok(t.includes(annual!) && t.includes(monthly!), `${plan.name}: both prices, so the page reads without the toggle`);
    }
    assert.equal(card!.includes('class="btn btn-primary"'), plan.pricing !== "free", `${plan.name}: a paid plan is bought by writing to us, the free one is started`);
    const limits = [plan.limits.maxProjects, plan.limits.maxSeatsPerMesh, plan.limits.maxConcurrentTurns].map((n) => (n === null ? "unlimited" : String(n)));
    const shown = [...card!.matchAll(/<dd>([\s\S]*?)<\/dd>/g)].map((m) => text(m[1]!.replace(/<span aria-hidden="true">[^<]*<\/span>/g, "")).trim().toLowerCase());
    assert.deepEqual(shown, limits, `${plan.name}: the limits`);
  }
  const t = text(table);
  for (const id of PLAN_IDS) assert.ok(t.includes(PLANS[id].name) && t.includes(PLANS[id].support), `${id} in the table`);
  const rows = [...table.matchAll(/<th scope="row">([\s\S]*?)<\/th>/g)].map((m) => text(m[1]!).trim());
  assert.deepEqual(rows, ["Per month, billed annually", "Per month, billed monthly", "Projects open at once", "Agents (seats) per mesh", "Concurrent agent turns", "Usage export and Prometheus metrics", "Support"]);
  const yesNo = [...table.matchAll(/<td class="(yes|no)">/g)].map((m) => m[1]);
  assert.deepEqual(yesNo, PLAN_IDS.map((id) => (PLANS[id].features.includes("usage-export") && PLANS[id].features.includes("prometheus-metrics") ? "yes" : "no")), "which plans have the reports");
  for (const id of PLAN_IDS) {
    const plan = PLANS[id];
    const item = new RegExp(`<li><h3>${plan.name}</h3>[\\s\\S]*?</li>`).exec(teaser)?.[0];
    assert.ok(item, `${plan.name} in the home page's line of plans`);
    if (plan.priceMonthlyUsd) assert.ok(item!.includes(`$${plan.priceMonthlyUsd}`) && item!.includes(`$${plan.priceMonthlyAnnualUsd}`), `${plan.name}: both prices`);
  }
  assert.ok(exported.plans.length === PLAN_IDS.length);
  // The measured mission, priced at every model's list price.
  const runs = /<!-- generated:run-costs:start[^>]*-->([\s\S]*?)<!-- generated:run-costs:end -->/.exec(pricing)![1]!;
  for (const [model, cost] of Object.entries(exported.measuredRuns[0]!.costUsdByModel)) {
    const row = new RegExp(`<tr><th scope="row">[^<]*(?:Claude [A-Za-z]+ [\\d.]+|${model})[\\s\\S]*?</tr>`, "g");
    assert.ok([...runs.matchAll(row)].some((m) => text(m[0]).includes(`$${cost.toFixed(2)}`)), `${model}: ${cost}`);
  }
  assert.ok(runs.includes(exported.modelPrices.asOf), "dated");
});

test("the export writes each block into the pages that fence it, is the same the second time, and refuses a pricing page that lacks one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "curule-pricing-"));
  for (const file of ["pricing/measured-runs.json", "docs/commercial/pricing.md"]) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), path.join(dir, file));
  }
  const fence = (name: string): string => `<!-- generated:${name}:start (scripts/export-pricing.mjs; do not edit between the markers) -->\n<!-- generated:${name}:end -->\n`;
  const pricingPage = ["plans-json", "plan-cards", "plan-table", "run-costs"].map(fence).join("");
  fs.mkdirSync(path.join(dir, "site", "pricing"), { recursive: true });
  fs.writeFileSync(path.join(dir, "site", "pricing", "index.html"), pricingPage, "utf8");
  fs.writeFileSync(path.join(dir, "site", "index.html"), `<p>home</p>\n${fence("plan-teaser")}`, "utf8");
  const run = (...args: string[]) => spawnSync(process.execPath, [path.join(ROOT, "scripts", "export-pricing.mjs"), "--root", dir, ...args], { encoding: "utf8" });
  assert.equal(run("--check").status, 1, "a page that has not been written is out of date");
  const wrote = run();
  assert.equal(wrote.status, 0, wrote.stderr);
  const first = fs.readFileSync(path.join(dir, "site", "pricing", "index.html"), "utf8");
  assert.match(first, /<script type="application\/json" id="plans-data">/);
  assert.match(first, /<article class="plan" id="plan-community"/);
  assert.match(first, /<table class="compare">/);
  assert.match(fs.readFileSync(path.join(dir, "site", "index.html"), "utf8"), /<ul class="teaser"/);
  assert.equal(run("--check").status, 0, "and the second time nothing is out of date");
  assert.equal(run().status, 0);
  assert.equal(fs.readFileSync(path.join(dir, "site", "pricing", "index.html"), "utf8"), first, "a second write changes nothing");
  fs.writeFileSync(path.join(dir, "site", "pricing", "index.html"), pricingPage.replace(/<!-- generated:run-costs:[^\n]*\n/g, ""), "utf8");
  const refused = run();
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /does not fence the block 'run-costs'/);
});

test("docs/commercial/pricing.md carries the generated plan table and unit economics", () => {
  const exported = buildPricingExport(measured());
  const doc = read("docs", "commercial", "pricing.md");
  const expected = replaceGeneratedBlock(replaceGeneratedBlock(doc, "plans", renderPlansTable(exported)), "economics", renderEconomics(exported));
  assert.equal(doc, expected, "out of date: run `node scripts/export-pricing.mjs` and commit the result");
  // The block really is there, with the numbers a buyer reads.
  const { start, end } = generatedBlock("plans");
  const block = doc.slice(doc.indexOf(start) + start.length, doc.indexOf(end));
  for (const plan of Object.values(PLANS)) {
    assert.ok(block.includes(plan.name), plan.name);
    if (plan.priceMonthlyUsd) assert.ok(block.includes(`$${plan.priceMonthlyUsd}`), `${plan.name} monthly price`);
    if (plan.priceMonthlyAnnualUsd) assert.ok(block.includes(`$${plan.priceMonthlyAnnualUsd}`), `${plan.name} annual price`);
  }
});

test("a generated block that is not fenced is an error, not a silent no-op", () => {
  assert.throws(() => replaceGeneratedBlock("# no blocks here", "plans", "x"), /not fenced/);
  const { start, end } = generatedBlock("plans");
  assert.throws(() => replaceGeneratedBlock(`${end}\n${start}`, "plans", "x"), /not fenced/, "the end before the start");
  assert.equal(replaceGeneratedBlock(`a\n${start}\nold\n${end}\nb`, "plans", "new"), `a\n${start}\nnew\n${end}\nb`);
});

test("the export carries every plan and every model price, dated, and says model usage is not included", () => {
  const out = buildPricingExport(measured());
  assert.deepEqual(out.plans.map((p) => p.id), [...PLAN_IDS]);
  assert.equal(out.modelPrices.asOf, LIST_PRICES_AS_OF);
  assert.deepEqual(Object.keys(out.modelPrices.perMtokUsd).sort(), Object.keys(ANTHROPIC_LIST_PRICES).sort());
  assert.match(out.modelUsageNote, /your own Anthropic, Bedrock, Vertex or Foundry credentials/);
  const team = out.plans.find((p) => p.id === "team")!;
  assert.equal(team.priceAnnualTotalUsd, team.priceMonthlyAnnualUsd! * 12);
  assert.equal(out.plans.find((p) => p.id === "community")!.annualSavingsPercent, null, "a free plan has no saving to quote");
  assert.equal(out.plans.find((p) => p.id === "enterprise")!.priceAnnualTotalUsd, null, "a quoted plan has no list price");
});

test("a measured run is re-priced at every model's list price, and its own bill is the one it ran on", () => {
  const [run] = buildPricingExport(measured()).measuredRuns;
  assert.ok(run);
  assert.equal(run.costUsd, run.costUsdByModel[run.model]);
  assert.equal(run.costUsd, 5.52, "the seventh cronlite run on Haiku 4.5: 3,892 in, 218,904 out, 949,926 cache writes, 32,299,235 cache reads");
  assert.equal(run.tokensBilled, 1_172_722, "input + output + cache writes, which the mesh's own budgets count");
  assert.deepEqual(
    Object.keys(run.costUsdByModel).sort(),
    Object.keys(ANTHROPIC_LIST_PRICES).sort(),
    "the same tokens at each current model, so a reader can see the spread (and that a different model would not use the same tokens)",
  );
});

test("a higher plan never allows less than a lower one, nor charges less", () => {
  const order: PlanId[] = ["community", "team", "business", "enterprise"];
  assert.deepEqual([...PLAN_IDS], order);
  const rank = (n: number | null): number => (n === null ? Number.POSITIVE_INFINITY : n);
  for (let i = 1; i < order.length; i++) {
    const lo = PLANS[order[i - 1]!];
    const hi = PLANS[order[i]!];
    for (const key of ["maxSeatsPerMesh", "maxProjects", "maxConcurrentTurns"] as const) {
      assert.ok(rank(hi.limits[key]) >= rank(lo.limits[key]), `${hi.id} allows fewer ${key} than ${lo.id}`);
    }
    for (const f of lo.features) assert.ok(hi.features.includes(f), `${hi.id} dropped ${f}`);
    if (hi.priceMonthlyUsd !== null) assert.ok(hi.priceMonthlyUsd > (lo.priceMonthlyUsd ?? 0), `${hi.id} is not dearer than ${lo.id}`);
  }
});

test("each plan's prices are coherent with how it is sold", () => {
  for (const id of PLAN_IDS) {
    const p = PLANS[id];
    if (p.pricing === "free") assert.deepEqual([p.priceMonthlyUsd, p.priceMonthlyAnnualUsd], [0, 0], id);
    if (p.pricing === "contact") assert.deepEqual([p.priceMonthlyUsd, p.priceMonthlyAnnualUsd], [null, null], `${id} is quoted, so it has no list price`);
    if (p.pricing === "listed") {
      assert.ok(p.priceMonthlyUsd !== null && p.priceMonthlyUsd > 0, id);
      assert.ok(p.priceMonthlyAnnualUsd !== null && p.priceMonthlyAnnualUsd < p.priceMonthlyUsd!, `${id}: the annual rate is a discount`);
    }
  }
});

test("a plan's prose carries the numbers its limits say, and 'Everything in' names the plan below it", () => {
  const order: PlanId[] = ["community", "team", "business", "enterprise"];
  for (const [i, id] of order.entries()) {
    const p = PLANS[id];
    const text = p.includes.join("\n");
    for (const [key, noun] of [["maxSeatsPerMesh", "seats"], ["maxProjects", "project"], ["maxConcurrentTurns", "concurrent turns"]] as const) {
      const n = p.limits[key];
      if (n === null || n === 1) continue;
      assert.match(text, new RegExp(`\\b${n}\\b[^\\n]*${noun}|${noun}[^\\n]*\\b${n}\\b`), `${id}: the prose does not say ${n} ${noun}`);
    }
    if (i > 0) assert.equal(p.includes[0], `Everything in ${PLANS[order[i - 1]!].name}`, id);
    for (const item of p.roadmap) assert.ok(!p.includes.includes(item), `${id} lists ${item} as both included and roadmap`);
  }
  assert.match(PLANS.enterprise.includes.join("\n"), /No seat, project or concurrency limits/);
  assert.deepEqual(PLANS.enterprise.limits, { maxSeatsPerMesh: null, maxProjects: null, maxConcurrentTurns: null }, "the prose says unlimited");
});

test("every feature a plan can carry is checked by code that exists, and every check names a known feature", () => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "dist") walk(rel);
      } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) files.push(rel);
    }
  };
  walk("apps");
  walk("packages");
  const checked = new Set<string>();
  for (const file of files) {
    if (file.endsWith(path.join("licensing", "src", "entitlements.ts"))) continue; // the definition, not a gate
    for (const m of fs.readFileSync(path.join(ROOT, file), "utf8").matchAll(/checkFeature\([^"]*?"([a-z-]+)"/g)) checked.add(m[1]!);
  }
  assert.deepEqual([...checked].sort(), [...FEATURE_IDS].sort(), "a feature nothing checks is a claim, not a feature; a check on an unlisted feature never passes");
});

test("what the Business plan promises to support exists in the repository", () => {
  const text = PLANS.business.includes.join("\n");
  if (/container image and Helm chart/.test(text)) {
    for (const f of ["Dockerfile", path.join("deploy", "helm", "curule", "Chart.yaml")]) assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} is promised and missing`);
  }
  if (/upgrade and backup runbooks/.test(text)) {
    const ops = path.join(ROOT, "docs", "operations.md");
    assert.ok(fs.existsSync(ops), "docs/operations.md is promised and missing");
    const body = fs.readFileSync(ops, "utf8");
    assert.match(body, /^#+ .*\bUpgrad/im, "an upgrade runbook");
    assert.match(body, /^#+ .*\bBack ?up/im, "a backup runbook");
  }
});
