/**
 * What the pages say. A claim on a marketing page is only as good as the thing it points at, so each one that can be checked
 * is checked against it: the free plan is the Community plan's limits, the measured mission is the one in
 * pricing/measured-runs.json, a price is a price in the plan table, what is planned is never sold as included, a document
 * is as long as its label says, and the voice rules of docs/brand.md hold on every page. The structure (files, requests,
 * images, headings) is in site.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { PLANS } from "../../packages/licensing/src/index";
import { ROOT, SITE, decode, page, shareable, sitePages, textOf } from "./site-pages";

const pages = sitePages();
const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const read = (...p: string[]): string => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const flat = (s: string): string => s.replace(/\s+/g, " ");

interface PricingData {
  plans: { id: string; name: string; priceMonthlyUsd: number | null; priceMonthlyAnnualUsd: number | null; priceAnnualTotalUsd: number | null; roadmap: string[]; features: string[] }[];
  measuredRuns: { seats: number; wallClockMinutes: number; costUsd: number; costUsdByModel: Record<string, number>; outcome: string }[];
}
const data = JSON.parse(/<script type="application\/json" id="plans-data">([\s\S]*?)<\/script>/.exec(page(pages, "pricing/index.html").html)![1]!) as PricingData;

/** Everything a visitor can read or hear on a page: the copy, the head's texts, the images' descriptions and the labels. */
function texts(p: { copy: string; html: string }): string {
  const attrs = [...p.html.matchAll(/\b(?:alt|aria-label|title|content)="([^"]*)"/g)].map((m) => decode(m[1]!));
  return [p.copy, ...attrs].join("\n");
}

test("the free plan the pages describe in words is the Community plan's limits, every time it is described", () => {
  const { maxProjects, maxSeatsPerMesh, maxConcurrentTurns } = PLANS.community.limits;
  assert.ok(maxProjects !== null && maxSeatsPerMesh !== null && maxConcurrentTurns !== null);
  const projects = WORDS[maxProjects!]!;
  const seats = WORDS[maxSeatsPerMesh!]!;
  const turns = WORDS[maxConcurrentTurns!]!;
  assert.ok(projects && seats && turns, "limits small enough to be written as words; update this test if they grow");
  const prose = pages.map((p) => p.prose).join("\n");
  // Every place the copy states the free plan's size, not just one of them.
  const count = `(${WORDS.join("|")}|\\d+)`;
  const openProjects = [...prose.matchAll(new RegExp(`\\b${count} open projects?\\b`, "gi"))].map((m) => m[1]!.toLowerCase());
  assert.ok(openProjects.length >= 2, "the free plan is described in at least two places");
  assert.deepEqual([...new Set(openProjects)], [projects], `every mention says "${projects} open project"`);
  const agents = [...prose.matchAll(new RegExp(`(?:project,|up to|no more than) ${count} agents\\b`, "gi"))].map((m) => m[1]!.toLowerCase());
  assert.ok(agents.length >= 3, "and its agent limit in at least three places");
  assert.deepEqual([...new Set(agents)], [seats], `every mention says "${seats} agents"`);
  const legal = page(pages, "legal/index.html").prose;
  assert.match(legal, new RegExp(`${projects} project open at a time`), "the licence summary says the project limit");
  assert.match(legal, new RegExp(`no more than ${turns} agent turns running at once`), "and the concurrent turns");
  // And the source licence's own grant, which the plan table is held equal to by source-licence.test.ts, says the same.
  const grant = flat(read("LICENSE"));
  assert.match(grant, new RegExp(`no more than ${maxProjects} project open at a time, no more than ${maxSeatsPerMesh} agents \\(seats\\)`));
});

test("the measured mission the pages quote is the one in pricing/measured-runs.json, with its caveat", () => {
  const run = data.measuredRuns[0]!;
  const pct = /scored\s+(?:the final product\s+)?([\d.]+)%/.exec(run.outcome)?.[1] ?? /([\d.]+)% of \d+ stratified/.exec(run.outcome)?.[1];
  assert.ok(pct, "the run's outcome states its score");
  const quoting = pages.filter((p) => p.prose.includes("built a small library"));
  assert.deepEqual(quoting.map((p) => p.rel).sort(), ["index.html", "pricing/index.html"], "the home page and the pricing page quote the measured mission");
  for (const p of quoting) {
    assert.ok(p.prose.includes(`${WORDS[run.seats]} agents built a small library in ${run.wallClockMinutes} minutes for $${run.costUsd.toFixed(2)} of model usage`), `${p.rel}: the measured sentence`);
    assert.ok(p.prose.includes(`scored it ${pct}%`), `${p.rel}: the score`);
    assert.ok(p.prose.includes("One run is not a rate"), `${p.rel}: one run is not a rate`);
  }
  // The mission is described the same way in the repository's own words.
  assert.match(read("README.md"), new RegExp(`\\$${run.costUsd.toFixed(2)} of model usage`), "README.md quotes the same cost");
});

test("every price in the prose is a price in the plan table or a cost of the measured mission, and every percentage is its score", () => {
  const allowed = new Set<string>();
  const usd = (n: number): string => `$${n.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`;
  for (const plan of data.plans) for (const n of [plan.priceMonthlyUsd, plan.priceMonthlyAnnualUsd, plan.priceAnnualTotalUsd]) if (n !== null) allowed.add(usd(n));
  for (const run of data.measuredRuns) {
    allowed.add(usd(run.costUsd));
    for (const n of Object.values(run.costUsdByModel)) allowed.add(usd(n));
  }
  const pct = /([\d.]+)% of \d+ stratified/.exec(data.measuredRuns[0]!.outcome)?.[1];
  for (const p of pages) {
    for (const m of p.prose.matchAll(/\$\d[\d,]*(?:\.\d+)?/g)) assert.ok(allowed.has(m[0]), `${p.rel}: ${m[0]} is not a price or a cost in pricing/plans.json`);
    for (const m of p.prose.matchAll(/\d+(?:\.\d+)?%/g)) assert.equal(m[0], `${pct}%`, `${p.rel}: ${m[0]}`);
  }
  // The plans themselves: the generated cards and the table carry every price and every limit of the plan table.
  const pricing = page(pages, "pricing/index.html");
  for (const plan of Object.values(PLANS)) {
    assert.ok(pricing.copy.includes(plan.name), `the pricing page names ${plan.name}`);
    if (plan.priceMonthlyUsd) assert.ok(pricing.copy.includes(`$${plan.priceMonthlyUsd}`), `${plan.name} monthly price`);
    if (plan.priceMonthlyAnnualUsd) assert.ok(pricing.copy.includes(`$${plan.priceMonthlyAnnualUsd}`), `${plan.name} annual price`);
    assert.ok(pricing.copy.includes(plan.support), `${plan.name}: its support line`);
  }
  const home = page(pages, "index.html");
  for (const plan of Object.values(PLANS)) assert.ok(home.copy.includes(plan.name), `the home page's plan line names ${plan.name}`);
});

test("what is planned is stated as planned, wherever a page mentions it, and is never sold as included", () => {
  const pricing = page(pages, "pricing/index.html");
  assert.match(pricing.copy, /Planned, not included: single sign-on/);
  // Anything the plan table lists as roadmap must be introduced as planned wherever the page renders it.
  for (const plan of Object.values(PLANS)) {
    if (plan.roadmap.length > 0) assert.ok(pricing.copy.includes(`Planned, not included: ${plan.roadmap.join("; ")}`), `${plan.name}: its roadmap, as planned`);
    for (const item of plan.roadmap) for (const p of pages) assert.ok(!p.copy.toLowerCase().includes(`includes ${item.toLowerCase()}`), `${p.rel}: ${item}`);
  }
  // And a mention of single sign-on anywhere sits next to a word that says it is not there yet.
  const planned = /planned|roadmap|not included|\bno\b|not yet|does not|never|without|until|not /i;
  let mentions = 0;
  for (const p of pages) {
    for (const m of p.copy.matchAll(/single sign-on|\bSSO\b|\bOIDC\b|per-operator identity|audit-log export/gi)) {
      mentions++;
      const around = p.copy.slice(Math.max(0, m.index! - 160), m.index! + 220);
      assert.match(around, planned, `${p.rel}: "${m[0]}" is mentioned without saying it is planned or absent: ...${around}...`);
    }
  }
  assert.ok(mentions >= 6, "the pages do say it");
  for (const p of pages) assert.ok(!/\bunlock/i.test(p.copy), `${p.rel}: a plan is a licence and support, not a lock to open`);
});

test("the voice of docs/brand.md holds on every page: plain, no hype, no exclamation marks, no open source, and the name written as it is", () => {
  const hype = [/revolutionary/i, /seamless/i, /supercharge/i, /unleash/i, /\b10x\b/i, /autonomous workforce/i, /enterprise-grade/i, /\bunlock/i, /lock-in/i];
  for (const p of pages) {
    const text = texts(p);
    for (const re of hype) assert.ok(!re.test(text), `${p.rel}: ${re} is a word the brand does not use`);
    assert.ok(!text.includes("!"), `${p.rel}: no exclamation marks (${/.{20}!.{20}/.exec(text)?.[0]})`);
    assert.ok(!/\bCURULE\b|\bCuRule\b/.test(text), `${p.rel}: the name is Curule`);
    for (const m of text.matchAll(/open[- ]source/gi)) {
      assert.match(text.slice(Math.max(0, m.index! - 24), m.index!), /(not|never|isn['’]t|is it)\s+(an?\s+)?$/i, `${p.rel}: the product is source-available, never open source: ...${text.slice(Math.max(0, m.index! - 40), m.index! + 30)}...`);
    }
    // What does not exist is not claimed: a certification, a test by someone else, a customer, an award.
    for (const m of text.matchAll(/SOC ?2|ISO ?27001|penetration test|pen[- ]test|certif|accredit/gi)) {
      assert.match(text.slice(Math.max(0, m.index! - 120), m.index!), /\b(no|not|nor|never|none|without)\b/i, `${p.rel}: "${m[0]}" is mentioned without saying there is none`);
    }
    assert.ok(!/trusted by|award-winning|customers love|used by (teams|companies)|case stud/i.test(text), `${p.rel}: no testimonial, customer or award is claimed`);
  }
});

test("every page carries the trademark line, and Claude and Anthropic appear only as what Curule runs on", () => {
  const line = "Claude and Anthropic are trademarks of Anthropic PBC; Curule is not affiliated with or endorsed by Anthropic.";
  for (const p of pages) {
    assert.ok(p.copy.includes(`Curule runs Claude Code. ${line}`), `${p.rel}: the trademark line`);
    assert.match(p.copy, /Prices are in US dollars and exclude taxes\./, `${p.rel}: and what the prices are`);
  }
  for (const p of pages) {
    for (const m of p.prose.matchAll(/\b(Anthropic|Claude)\b/g)) {
      const around = p.prose.slice(Math.max(0, m.index! - 80), m.index! + 80);
      assert.ok(!/partner|official|certified|endorse(?!d)/i.test(around), `${p.rel}: nothing implies Anthropic stands behind Curule: ${around}`);
    }
  }
});

test("the home page says what it is, and the 'Try it' commands are the ones that work today", () => {
  const home = page(pages, "index.html");
  assert.match(home.html, /<h1>A team of AI agents, run like an organization\.<\/h1>/, "the tagline, exactly");
  for (const id of ["why", "how", "product", "try", "security", "pricing", "faq"]) assert.match(home.html, new RegExp(`<section[^>]*\\sid="${id}"`), `section #${id}`);
  assert.equal((home.html.match(/<details(?: data-selfhost-only)?>/g) ?? []).length, 10, "the questions are native <details>, and the home page answers the ten it lists");
  assert.equal((home.html.match(/<details data-cloud-only hidden>/g) ?? []).length, 2, "and the two that say Curule is not hosted and has no checkout have the answers that say otherwise, for the day Curule Cloud is open");
  assert.equal((home.html.match(/<li class="tile">/g) ?? []).length, 6, "six views of the console");
  assert.equal((home.html.match(/class="tab-input"/g) ?? []).length, 3, "three views in the product frame");
  for (const heading of ["Mission control", "Live events", "Per-turn ledger", "Team designer", "Cost and budgets", "Approvals"]) assert.ok(home.copy.includes(heading), heading);
  for (const heading of ["Enforced, not asked", "Recorded and replayable", "Bounded", "Yours"]) assert.ok(home.copy.includes(heading), heading);

  const blocks = [...home.html.matchAll(/<div class="code"><pre[^>]*><code>([\s\S]*?)<\/code><\/pre><\/div>/g)].map((m) => decode(m[1]!));
  assert.equal(blocks.length, 3, "three blocks of commands");
  const [token, build, run] = blocks as [string, string, string];
  assert.match(token, /^export MESH_API_TOKEN="\$\(openssl rand -hex (\d+)\)"\necho "\$MESH_API_TOKEN"$/, "the token is made, and shown, first");
  assert.ok(Number(/-hex (\d+)/.exec(token)![1]) * 2 >= 32, "and is at least the 32 characters the server insists on");
  const script = read("site", "assets", "site.js");
  const repo = /var REPO_URL = "([^"]+)";/.exec(script)![1]!;
  assert.equal(build, `git clone ${repo}.git curule\ncd curule\ndocker build -t curule .`, "the image is built from a checkout, the way README.md says");
  assert.equal(run, 'docker run --rm -p 127.0.0.1:7420:7420 -v mesh-demo:/data \\\n  -e MESH_API_TOKEN="$MESH_API_TOKEN" \\\n  curule demo', "and the demo runs from the image that was built");
  assert.ok(read("README.md").includes("docker build -t curule .") && read("README.md").includes("-e MESH_API_TOKEN=\"$(openssl rand -hex 32)\" curule demo"), "README.md gives the same commands");
  assert.ok(read("deploy", "docker", "entrypoint.sh").includes("demo)"), "the image's entrypoint has the demo command");
  assert.ok(home.copy.includes("Open the demo-stub project and press Start mission"), "and the steps in the dashboard");
});

test("a document is as long as its label on the documentation page says", () => {
  const docs = page(pages, "docs/index.html");
  const items = [...docs.html.matchAll(/<li data-kind="(\w+)">[\s\S]*?data-doc="([^"#]+)(?:#[^"]*)?"/g)].map((m) => ({ kind: m[1]!, file: m[2]! }));
  assert.ok(items.length >= 14, `the hub lists the documents (${items.length})`);
  const lines = (f: string): number => read("docs", f).split("\n").length;
  for (const { kind, file } of items) {
    assert.ok(fs.existsSync(path.join(ROOT, "docs", file)), `docs/${file}`);
    const n = lines(file);
    if (kind === "reference") assert.ok(n >= 600, `docs/${file} is labelled reference and is ${n} lines`);
    if (kind === "short") assert.ok(n <= 150, `docs/${file} is labelled short and is ${n} lines`);
    if (kind === "guide") assert.ok(n > 150 && n <= 400, `docs/${file} is labelled a guide and is ${n} lines`);
    assert.ok(["reference", "short", "guide", "log"].includes(kind), `${file}: ${kind} is a label the page explains`);
  }
  const listed = new Set(items.map((i) => path.normalize(i.file)));
  for (const must of ["../README.md", "architecture.md", "configuration.md", "commercial/deployment.md", "operations.md", "commercial/security.md", "commercial/security-questionnaire.md", "../SECURITY.md", "commercial/licensing.md", "commercial/pricing.md", "protocol.md", "runtime.md", "../CHANGELOG.md", "brand.md"]) {
    assert.ok(listed.has(path.normalize(must)), `the documentation page lists ${must}`);
  }
});

test("the documentation page tells a visitor where its links go, and that there is no documentation site yet, not how it is built", () => {
  const docs = page(pages, "docs/index.html");
  // What a visitor with a script reads: everything but what is only for a visitor without one.
  const read = textOf(docs.html.replace(/<noscript>[\s\S]*?<\/noscript>/g, " "));
  assert.ok(read.includes("Each title opens the document on GitHub."), "where a title goes");
  assert.ok(read.includes("The path under it is where the file is in the repository"), "and what the path under it is");
  assert.ok(read.includes("there is no separate documentation site yet"), "the honest part stays");
  assert.ok(!/\bscript\b/i.test(read), "how the links are set is the page's business, not the visitor's");
  // A visitor without a script is told what does not work for them, and what to use instead.
  assert.match(docs.html, /<noscript><p class="notice[^"]*">With JavaScript off the titles do not open anything: the path under each one is where the file is\.<\/p><\/noscript>/);
});

test("the numbers the pages quote about licences, support and reporting are the documents' own", () => {
  const licensing = flat(read("docs", "commercial", "licensing.md"));
  const policy = flat(read("SECURITY.md"));
  const pricing = page(pages, "pricing/index.html");
  assert.ok(licensing.includes("14 days by default") && pricing.copy.includes("14 days by default"), "the grace period");
  assert.ok(licensing.includes("30 days before expiry") && pricing.copy.includes("told 30 days ahead"), "the warning before expiry");
  assert.ok(licensing.includes("every 30 seconds") && pricing.copy.includes("within 30 seconds"), "the licence is read again without a restart");
  assert.ok(licensing.includes("MESH_LICENSE_ENFORCEMENT") && licensing.includes("`warn` (the **default**)") && pricing.copy.includes("MESH_LICENSE_ENFORCEMENT is warn"), "limits are reported, not refused, by default");
  assert.ok(licensing.includes("curule license install <key|file>") && pricing.copy.includes("curule license install <key>"), "the command that installs a key");
  const security = page(pages, "security/index.html");
  const contact = page(pages, "contact/index.html");
  for (const phrase of ["within 3 business days", "within 10 business days", "within 30 days"]) {
    assert.ok(policy.includes(phrase), `SECURITY.md says ${phrase}`);
    assert.ok(security.copy.includes(phrase), `the security page says ${phrase}`);
  }
  assert.ok(contact.copy.includes("within 3 business days"), "the contact page says how fast a report is acknowledged");
  assert.ok(flat(read("docs", "commercial", "security.md")).includes("exit 78") || flat(read("docs", "commercial", "security.md")).includes("32 characters"), "the listen policy the security page describes");
});

test("the pages say what they must: the plans, how licences work, the security stance, who to write to, and what is still the owner's to write", () => {
  const pricing = page(pages, "pricing/index.html");
  for (const id of ["plans", "compare", "paying", "calculator", "licences", "faq"]) assert.match(pricing.html, new RegExp(`<section[^>]*\\sid="${id}"`), `pricing: section #${id}`);
  assert.equal((pricing.html.match(/<article class="plan"/g) ?? []).length, 4, "four plans");
  assert.equal((pricing.html.match(/name="billing"/g) ?? []).length, 2, "an Annual and a Monthly choice");
  assert.ok(pricing.copy.includes("There is no checkout, no account and no billing system"), "no checkout, no account, no billing system");
  assert.ok(pricing.copy.includes("licence key is issued by hand"), "a key is issued by hand");
  assert.ok(pricing.copy.includes("Model usage is separate"), "model usage is separate");
  assert.ok(pricing.copy.includes("Limits are reported, not enforced, by default"), "and limits are reported, not enforced, by default");
  for (const id of ["c-projects", "c-seats", "c-missions", "c-model", "c-reports"]) assert.match(pricing.html, new RegExp(`id="${id}"`), `calculator field ${id}`);
  assert.match(pricing.html, /<form id="calc"[^>]*\bhidden\b/, "the calculator is shown only to a visitor who can run it");
  assert.match(pricing.html, /<noscript>[\s\S]*calculator needs JavaScript/, "and a visitor who cannot is told where the numbers are");

  const security = page(pages, "security/index.html");
  for (const id of ["protects", "leaves", "not", "checklist", "assurance", "report"]) assert.match(security.html, new RegExp(`<section[^>]*\\sid="${id}"`), `security: section #${id}`);
  for (const must of ["single sign-on", "per-operator identity", "penetration test", "SOC 2", "container is the boundary", "narrow its egress", "open internet", "Please do not open a public issue", "no certificate, award or customer logo"]) {
    assert.ok(security.copy.includes(must), `the security page says "${must}"`);
  }
  assert.ok(security.copy.includes("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1"), "including that the Claude Code binary is told to be quiet");

  const contact = page(pages, "contact/index.html");
  for (const kind of ["sales", "support", "security"]) assert.match(contact.html, new RegExp(`<a data-mail="${kind}" href="[^"]*">`), `the ${kind} address`);
  assert.match(contact.html, /<span data-company>/, "and the company line");
  const legal = page(pages, "legal/index.html");
  for (const id of ["licence", "privacy", "terms"]) assert.match(legal.html, new RegExp(`<section[^>]*\\sid="${id}"`), `legal: section #${id}`);
  assert.match(legal.html, /TODO\(owner\)[^<]*<\/b>[^<]*terms/, "the terms are marked for the owner and counsel; none are invented here");
  assert.ok(legal.copy.includes("written with counsel"), "and the page says why");
  for (const must of ["makes no request to any other site", "sets no cookies", "no analytics", "sends nothing to us", "Business Source License 1.1", "four years after it is published", "Apache License 2.0", "not open source"]) {
    assert.ok(legal.copy.includes(must), `the legal page says "${must}"`);
  }
  assert.ok(shareable(pages).length === 6);
  assert.ok(fs.existsSync(path.join(SITE, "404.html")));
});
