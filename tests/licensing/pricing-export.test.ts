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
import * as path from "path";
import { FEATURE_IDS, PLANS, PLAN_IDS, buildPricingExport, type MeasuredRun, type PlanId } from "../../packages/licensing/src/index";
import { ANTHROPIC_LIST_PRICES, LIST_PRICES_AS_OF } from "../../packages/protocol/src/index";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const read = (...p: string[]): string => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const measured = (): MeasuredRun[] => JSON.parse(read("pricing", "measured-runs.json")).runs as MeasuredRun[];

test("pricing/plans.json is what the plan table, the list prices and the measured runs generate", () => {
  const generated = `${JSON.stringify(buildPricingExport(measured()), null, 2)}\n`;
  assert.equal(read("pricing", "plans.json"), generated, "out of date: run `node scripts/export-pricing.mjs` and commit the result");
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
    for (const f of ["Dockerfile", path.join("deploy", "helm", "agent-mesh", "Chart.yaml")]) assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} is promised and missing`);
  }
  if (/upgrade and backup runbooks/.test(text)) {
    const ops = path.join(ROOT, "docs", "operations.md");
    assert.ok(fs.existsSync(ops), "docs/operations.md is promised and missing");
    const body = fs.readFileSync(ops, "utf8");
    assert.match(body, /^#+ .*\bUpgrad/im, "an upgrade runbook");
    assert.match(body, /^#+ .*\bBack ?up/im, "a backup runbook");
  }
});
