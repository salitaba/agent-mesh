/**
 * The landing and pricing page makes promises (nothing phones home, here is what the free plan is, here is what a
 * measured mission cost) and links to things (screenshots, the documents). Each is pinned to what the repository
 * really contains, so the page cannot quietly go stale or start loading something from a third party.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { PLANS } from "../../packages/licensing/src/index";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const page = fs.readFileSync(path.join(ROOT, "site", "index.html"), "utf8");
/** The visible copy: the page without its scripts, styles and the generated data. */
const markup = page.replace(/<script[\s\S]*?<\/script>/g, "");
const copy = markup.replace(/<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
/** The numbers the page's script reads (the test above pins them to the generator). */
const data = JSON.parse(/<script type="application\/json" id="plans-data">([\s\S]*?)<\/script>/.exec(page)![1]!) as {
  measuredRuns: { seats: number; wallClockMinutes: number; costUsd: number; outcome: string }[];
};

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

test("every file the page references exists, and nothing is loaded from another host", () => {
  // `<link rel="canonical">` names the page's own address (`scripts/set-domain.mjs` adds it): nothing is fetched from it.
  const refs = [...markup.replace(/<link rel="canonical" href="[^"]*">/g, "").matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(refs.length > 10, "the page has references to check");
  const missing: string[] = [];
  const external: string[] = [];
  for (const ref of refs) {
    if (ref.startsWith("#") || ref.startsWith("data:")) continue;
    if (/^(https?:)?\/\//.test(ref) || ref.startsWith("mailto:")) {
      if (/^(https?:)?\/\//.test(ref)) external.push(ref);
      continue;
    }
    if (!fs.existsSync(path.join(ROOT, "site", ref))) missing.push(ref);
  }
  assert.deepEqual(missing, []);
  // The only absolute address in the markup is the documents' base, which the script sets; nothing is fetched from
  // a third party (no fonts, analytics, scripts or images), which is what lets the page say it has no cookie banner.
  assert.deepEqual(external, []);
  assert.ok(!/<script\b[^>]*\ssrc\s*=/i.test(page), "no external scripts");
  assert.ok(!/<link\b[^>]*rel="?stylesheet/i.test(page), "no external style sheets");
  assert.ok(!/<(iframe|embed|object)\b/i.test(page), "nothing embedded");
  assert.ok(!/@import|url\(\s*["']?https?:/i.test(page), "no remote CSS");
});

test("the page's own script makes no network call", () => {
  const code = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!).join("\n");
  assert.ok(code.includes("renderPlans"), "found the page script");
  for (const call of ["fetch(", "XMLHttpRequest", "sendBeacon", "WebSocket", "EventSource", "import(", "importScripts", "document.cookie", "localStorage"]) {
    assert.ok(!code.includes(call), `the page script does not use ${call}`);
  }
});

test("the footer's document links point at documents that exist", () => {
  const targets = [...markup.matchAll(/data-doc="([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(targets.length >= 5);
  for (const t of targets) assert.ok(fs.existsSync(path.join(ROOT, "docs", t)), `docs/${t}`);
  assert.match(page, /var DOCS_BASE = "https:\/\/github\.com\/salitaba\/agent-mesh\/blob\/main\/docs\/";/, "the base the links resolve against");
});

test("images carry alternative text and their size, and the page declares its language and description", () => {
  const imgs = [...markup.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
  assert.ok(imgs.length >= 2);
  for (const tag of imgs) {
    assert.match(tag, /\salt="[^"]{20,}"/, `alt text: ${tag.slice(0, 80)}`);
    assert.match(tag, /\swidth="\d+"/);
    assert.match(tag, /\sheight="\d+"/);
  }
  assert.match(page, /<html lang="en">/);
  assert.match(page, /<meta name="viewport"/);
  assert.match(page, /<meta name="description" content="[^"]{40,}"/);
  assert.match(page, /<title>[^<]{10,}<\/title>/);
  for (const f of ["overview.jpg", "graph.jpg"]) assert.ok(fs.statSync(path.join(ROOT, "site", "assets", f)).size < 400_000, `${f} stays light enough for a landing page`);
});

test("the free plan the page describes in words is the Community plan's limits", () => {
  const { maxProjects, maxSeatsPerMesh } = PLANS.community.limits;
  assert.ok(maxProjects !== null && maxSeatsPerMesh !== null);
  const projects = WORDS[maxProjects!]!;
  const seats = WORDS[maxSeatsPerMesh!]!;
  assert.ok(projects && seats, "limits small enough to be written as words; update this test if they grow");
  // Every place the copy states the free plan's size, not just one of them.
  const openProjects = [...copy.matchAll(/\b(\w+) open projects?\b/g)].map((m) => m[1]);
  assert.ok(openProjects.length >= 2, "the free plan is described in at least two places");
  assert.deepEqual([...new Set(openProjects)], [projects], `every mention says "${projects} open project"`);
  const agents = [...copy.matchAll(/(?:project,|up to) (\w+) agents\b/g)].map((m) => m[1]);
  assert.ok(agents.length >= 2, "and its agent limit in at least two places");
  assert.deepEqual([...new Set(agents)], [seats], `every mention says "${seats} agents"`);
});

test("the measured mission the page quotes is the one in pricing/measured-runs.json", () => {
  const run = data.measuredRuns[0]!;
  const pct = /scored\s+(?:the final product\s+)?([\d.]+)%/.exec(run.outcome)?.[1] ?? /([\d.]+)% of \d+ stratified/.exec(run.outcome)?.[1];
  assert.ok(pct, "the run's outcome states its score");
  assert.ok(copy.includes(`${WORDS[run.seats]} agents built a small library in ${run.wallClockMinutes} minutes for $${run.costUsd.toFixed(2)} of model usage`), "the FAQ's measured sentence");
  assert.ok(copy.includes(`scored it ${pct}%`), "the FAQ's score");
  assert.ok(copy.includes("One run is not a rate"), "and it says one run is not a rate");
});

test("the page states what is planned and not included, and does not sell it", () => {
  assert.match(copy, /Planned, not included: single sign-on/);
  // Anything the plan table lists as roadmap must be introduced as planned wherever the page renders it.
  assert.match(page, /Planned, not included: ' \+ p\.roadmap/);
  for (const plan of Object.values(PLANS)) {
    for (const item of plan.roadmap ?? []) assert.ok(!copy.toLowerCase().includes(`includes ${item.toLowerCase()}`), item);
  }
});

test("once the page names its own address, the canonical link, og:url, the social images and the CNAME agree", () => {
  const canonical = /<link rel="canonical" href="([^"]+)">/.exec(page)?.[1];
  if (canonical === undefined) {
    // The template: the domain is not chosen, so the markers are still there for `scripts/set-domain.mjs` to fill.
    assert.match(page, /TODO\(owner\)/, "an unset page says what is left to do");
    assert.ok(!fs.existsSync(path.join(ROOT, "site", "CNAME")), "and a CNAME without a canonical link is a half-applied domain");
    return;
  }
  assert.match(canonical, /^https:\/\/[a-z0-9.-]+\/$/, "the canonical address is the site's origin, over https");
  assert.equal(/<meta property="og:url" content="([^"]+)">/.exec(page)?.[1], canonical);
  for (const re of [/<meta property="og:image" content="([^"]+)">/, /<meta name="twitter:image" content="([^"]+)">/]) {
    assert.equal(re.exec(page)?.[1], `${canonical}assets/social-card.png`, "a link preview needs an absolute address on the same origin");
  }
  assert.equal(fs.readFileSync(path.join(ROOT, "site", "CNAME"), "utf8").trim(), new URL(canonical).host, "the CNAME is the canonical host");
  // What is still marked TODO(owner) is the publish workflow's concern (`npm run site:check`), not a reason for CI to fail.
});
