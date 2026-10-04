#!/usr/bin/env node
/*
 * The console's visual QA pass (docs/design-spec.md §7): every view, at each width, in each theme, against a running console.
 * For each it takes a screenshot, runs axe-core, and records a horizontal page scroll, a failed request or a console error.
 * It exits 1 when it found anything, so it can sit in a release checklist.
 *
 * Usage:
 *   npm run qa:console -- --base http://127.0.0.1:7420 --token <operator token> [--project demo-stub]
 *                         [--views overview,events] [--widths 1440,390] [--themes light,dark] [--out dir] [--chrome /path]
 *
 * Needs a console that is up with a project that has run (the scripted demo, once it has reached Delivered, shows every page with
 * real data), and, outside the repo's dependencies on purpose (they are large and used only here):
 *   npm install --no-save playwright-core axe-core
 * plus a Chrome or Chromium (CHROME=/path/to/chrome, or --chrome).
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : dflt;
};

const BASE = opt("base", "http://127.0.0.1:7420").replace(/\/$/, "");
const TOKEN = opt("token", process.env.MESH_API_TOKEN ?? "");
const PROJECT = opt("project", "demo-stub");
const VIEWS = opt("views", "overview,escalations,agents,steps,events,artifacts,product,cost,graph,designer,gates,hostsettings,projects").split(",");
const WIDTHS = opt("widths", "1440,390").split(",").map(Number);
const THEMES = opt("themes", "light,dark").split(",");
const OUT = resolve(opt("out", join(tmpdir(), "curule-qa-console")));
const CHROME = opt("chrome", process.env.CHROME ?? "");

const need = (name) => {
  try {
    return createRequire(join(process.cwd(), "noop.js"))(name);
  } catch {
    console.error(`qa-console: ${name} is not installed. Run: npm install --no-save playwright-core axe-core`);
    process.exit(2);
  }
};
const { chromium } = need("playwright-core");
const axeSource = (await import("node:fs")).readFileSync(createRequire(join(process.cwd(), "noop.js")).resolve("axe-core/axe.min.js"), "utf8");

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ ...(CHROME ? { executablePath: CHROME } : {}), args: ["--no-sandbox"] });
const problems = [];
let shots = 0;
let axeRuns = 0;

for (const width of WIDTHS) {
  const height = width < 500 ? 844 : width < 1300 ? 800 : 900;
  for (const theme of THEMES) {
    const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce" });
    const page = await ctx.newPage();
    const seen = new Set();
    page.on("pageerror", (e) => seen.add(`page error: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error") seen.add(`console: ${m.text().slice(0, 160)}`); });
    page.on("requestfailed", (r) => seen.add(`request failed: ${r.url().slice(0, 100)}`));
    await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
    if (await page.locator("#signin-token").count()) {
      if (!TOKEN) { console.error("qa-console: the console asks for a token; pass --token"); process.exit(2); }
      await page.fill("#signin-token", TOKEN);
      await page.click("button[type=submit]");
      await page.waitForTimeout(1500);
    }
    await page.evaluate((t) => { try { localStorage.setItem("mesh-theme", t); } catch { /* private window */ } document.documentElement.setAttribute("data-theme", t); }, theme);
    for (const view of VIEWS) {
      await page.goto(`${BASE}/#/p/${PROJECT}/${view}`, { waitUntil: "networkidle" }).catch(() => undefined);
      await page.waitForTimeout(900);
      await page.screenshot({ path: join(OUT, `${view}-${width}-${theme}.png`) });
      shots++;
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1 || document.body.scrollWidth > window.innerWidth + 1);
      if (overflow) problems.push(`${view} ${width} ${theme}: horizontal page scroll`);
      await page.evaluate(axeSource);
      const violations = await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ["violations"] })).violations.map((v) => `${v.id} x${v.nodes.length} [${v.impact}] ${v.nodes[0].target.join(" ").slice(0, 70)}`));
      axeRuns++;
      for (const v of violations) problems.push(`${view} ${width} ${theme}: axe ${v}`);
    }
    for (const e of seen) problems.push(`${width} ${theme}: ${e}`);
    await ctx.close();
  }
}
await browser.close();

console.log(`${shots} screenshots and ${axeRuns} axe runs in ${OUT}`);
if (problems.length) {
  console.log(`\n${problems.length} problem${problems.length === 1 ? "" : "s"}:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log("no problems found");
