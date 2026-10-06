#!/usr/bin/env node
/*
 * A customer's session on the hosted service, walked by a browser: the public pages at three widths and in both colour schemes
 * with an accessibility scan, then sign up, confirm by the link in the mail, pay on the trial's page, make a workspace, open it,
 * make a team in it, ask the designer something, see the usage in the account, pause and resume the workspace, delete it, sign
 * out, sign in, change the password and reset it by mail. It reports each step, every failing request and every error a page
 * logged, and exits 1 if any step failed.
 *
 * Usage:
 *   npm run cloud -- trial --port 7500 --dir /tmp/curule-trial          (in one terminal)
 *   npm run qa:cloud -- --base http://localhost:7500 --outbox /tmp/curule-trial/control/outbox.jsonl [--chrome /path] [--out dir]
 *
 * It needs the trial (its payment page and its mail outbox are what make a session possible without a real provider or a mail
 * service), and, outside the repo's dependencies on purpose: npm install --no-save playwright-core axe-core, and a Chrome or
 * Chromium (CHROME=/path/to/chrome). Add --no-stand-in to run it against a service whose models are real: it then waits for any
 * answer from the designer and not for the stand-in's sentence.
 *
 * Add --hosting-only to walk a hosting-only service (`trial --hosting-only`: the customer brings a model key, and there is no
 * balance, credit or usage): the session gives the workspace a key that points at the trial's stand-in before it opens it, and it
 * checks that the account has no balance or usage to show.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : dflt;
};
const BASE = opt("base", "http://localhost:7500").replace(/\/$/, "");
const OUTBOX = opt("outbox", "");
const OUT = resolve(opt("out", join(tmpdir(), "curule-qa-cloud")));
const CHROME = opt("chrome", process.env.CHROME ?? "");
const STAND_IN = !args.includes("--no-stand-in");
const HOSTING = args.includes("--hosting-only");
/** What a customer gives the key form on a hosting-only trial: the address the trial answers on this machine, and any key. */
const STAND_IN_ADDRESS = "https://stand-in.example/v1";
const require = createRequire(join(process.cwd(), "noop.js"));
let chromium;
let axeSource;
try {
  ({ chromium } = require("playwright-core"));
  axeSource = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
} catch {
  console.error("qa-cloud: playwright-core and axe-core are not installed. Run: npm install --no-save playwright-core axe-core");
  process.exit(2);
}
if (!OUTBOX || !fs.existsSync(dirname(OUTBOX))) {
  console.error("qa-cloud: pass --outbox, the trial's control/outbox.jsonl (it is where the mail with each link is written; the file appears with the first mail)");
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

const PASSWORD = "correct horse battery staple";
const NEXT_PASSWORD = "a brand new password 7";
const email = `qa-${Date.now().toString(36)}@example.com`;
const results = [];
const bad = [];
const errs = new Set();
const browser = await chromium.launch({ ...(CHROME ? { executablePath: CHROME } : {}), args: ["--no-sandbox"] });

const linkFor = async (kind) => {
  for (let i = 0; i < 80; i++) {
    const mails = (fs.existsSync(OUTBOX) ? fs.readFileSync(OUTBOX, "utf8").trim().split("\n").filter(Boolean) : []).map((l) => JSON.parse(l)).filter((m) => m.to === email && m.kind === kind);
    if (mails.length > 0) return /https?:\/\/\S+/.exec(mails.at(-1).text)[0];
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no ${kind} mail for ${email} in ${OUTBOX}`);
};
const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

async function watch(page) {
  page.on("response", (r) => {
    if (r.status() >= 400 && !/favicon/.test(r.url())) bad.push(`${r.status()} ${r.request().method()} ${r.url().replace(BASE, "").slice(0, 80)}`);
  });
  page.on("pageerror", (e) => errs.add(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errs.add(`console: ${m.text().slice(0, 140)}`);
  });
}

const step = async (page, name, fn) => {
  try {
    const note = await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}${note ? `  ${note}` : ""}`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}  ${String(e.message).split("\n")[0].slice(0, 200)}`);
    await page.screenshot({ path: `${OUT}/fail-${results.length}.png` }).catch(() => {});
  }
};

// ---- the public pages, at three widths and in both colour schemes ----
{
  const widths = [[375, "phone"], [768, "tablet"], [1280, "desktop"]];
  for (const dark of [false, true]) {
    for (const [width, label] of widths) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: dark ? "dark" : "light", reducedMotion: "reduce" });
      const page = await ctx.newPage();
      await watch(page);
      for (const path of ["/", "/signup", "/login", "/forgot", "/terms", "/privacy"]) {
        await step(page, `${path === "/" ? "home" : path.slice(1)} at ${label}${dark ? ", dark" : ""}: fits, has no violations`, async () => {
          await page.goto(BASE + path, { waitUntil: "networkidle" });
          await page.screenshot({ path: `${OUT}/${path === "/" ? "home" : path.slice(1)}-${label}${dark ? "-dark" : ""}.png`, fullPage: true });
          expect(!(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)), "the page scrolls sideways");
          await page.evaluate(axeSource);
          const violations = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } })).violations.map((v) => `${v.id}: ${v.nodes[0]?.target.join(" ")}`));
          expect(violations.length === 0, violations.join("; "));
        });
      }
      await ctx.close();
    }
  }
}

// ---- a customer's session ----
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
await watch(page);
const text = async (sel) => ((await page.innerText(sel)) || "").replace(/\s+/g, " ").trim();

await step(page, "sign up says what is missing, then sends a link", async () => {
  await page.goto(`${BASE}/signup`, { waitUntil: "networkidle" });
  await page.click("button[type=submit]");
  expect(/Enter your email/.test(await text("#status")), "an empty email was not said");
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await page.click("button[type=submit]");
  expect(/Agree to the Terms/.test(await text("#status")), "the terms were not asked for");
  await page.check("#agree");
  await page.click("button[type=submit]");
  await page.waitForSelector("#card .note-ok");
  return email;
});
await step(page, "the link in the mail confirms the address and opens the account", async () => {
  await page.goto(await linkFor("verify"));
  await page.waitForURL(/\/account$/);
  await page.waitForSelector("#plan .plan");
  expect(page.url() === `${BASE}/account`, "the token is still in the address");
});
await step(page, "choosing a plan goes to the payment page, and paying comes back to an account that has the plan", async () => {
  await page.getByRole("button", { name: /^Choose / }).first().click();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector("text=Nothing is charged", { timeout: 15000 });
  await page.screenshot({ path: `${OUT}/pay.png` });
  await page.getByRole("button", { name: /^Pay/ }).click();
  await page.waitForURL(/\/account/);
  await page.waitForFunction(() => /payment has arrived/i.test(document.getElementById("notice")?.textContent ?? ""), null, { timeout: 30000 });
  expect(/active/i.test(await text("#plan")), "the plan is not active");
});
await step(page, "a workspace is made and runs", async () => {
  await page.fill("#workspace-name", "Research");
  await page.click("#create button[type=submit]");
  await page.waitForSelector("#workspaces .badge:text('Running'), #workspaces .badge:text('Could not start')", { timeout: 120000 });
  expect(/running/i.test(await text("#workspaces")), `it did not start: ${await text("#workspaces")}`);
  await page.screenshot({ path: `${OUT}/account-running.png`, fullPage: true });
});
if (HOSTING) {
  await step(page, "the workspace has no model until its key is given: the form takes the stand-in's address and any key, and the workspace starts again with it", async () => {
    expect(/add your model key/i.test(await text("#stage-title")), `the card at the top does not ask for the key: ${await text("#stage-title")}`);
    expect(/no key yet/i.test(await text("#workspaces")), `the workspace's card does not say the key is missing: ${await text("#workspaces")}`);
    const form = page.locator("form[id^=key-form-]").first();
    await form.locator("select").selectOption("openai-compatible");
    await form.locator("input[name=model]").fill("stand-in");
    await form.locator("input[name=baseUrl]").fill(STAND_IN_ADDRESS);
    await form.locator("input[name=key]").fill("any-key-12345");
    await form.locator("button[type=submit]").click();
    await page.waitForFunction(() => /is kept/i.test(document.getElementById("notice")?.textContent ?? ""), null, { timeout: 60000 });
    await page.waitForSelector("#workspaces .badge:text('Running')", { timeout: 60000 });
    expect(/key kept/i.test(await text("#workspaces")), `the workspace's card does not say the key is kept: ${await text("#workspaces")}`);
    expect((await page.locator("body").innerText()).includes("any-key-12345") === false, "the key is shown on the page");
    await page.screenshot({ path: `${OUT}/account-key-kept.png`, fullPage: true });
  });
}
let workspaceUrl = "";
await step(page, "opening it shows the host's own dashboard, through the service's address", async () => {
  // The card at the top offers it first, and the workspace's own button is the same thing again.
  expect(/is running/i.test(await text("#stage-title")), `the card at the top does not say the workspace is running: ${await text("#stage-title")}`);
  await page.getByRole("button", { name: /^Open( |$)/ }).first().click();
  await page.waitForURL((u) => u.host !== new URL(BASE).host, { timeout: 30000 });
  await page.waitForSelector("text=/Welcome to (Curule|your workspace)/", { timeout: 30000 });
  workspaceUrl = page.url();
  await page.screenshot({ path: `${OUT}/workspace-first-run.png` });
});
await step(page, HOSTING ? "a team is made on the customer's own key, which the page says it has" : "a team is made on the service's models, with no key asked for", async () => {
  // A customer's part is the goal and one button; what the workspace has for models is said under Details.
  await page.waitForSelector("text=Welcome to your workspace", { timeout: 15000 });
  await page.locator("summary", { hasText: /^Details$/ }).click();
  const said = HOSTING ? /your model key|model key you gave/i : /service supplies/i;
  await page.waitForSelector(HOSTING ? "text=/Your model key|model key you gave/i" : "text=/service supplies/i", { timeout: 15000 }).catch(() => {});
  expect(said.test(await text("body")), HOSTING ? "the first-run page does not say the models are the customer's own key" : "the first-run page does not say the models are supplied");
  expect(!/ANTHROPIC_API_KEY/i.test(await text("body")), "it asks for a key");
  await page.getByRole("textbox", { name: /What should your team do/i }).fill("A small command-line tool that adds up a column of a CSV file, with tests.");
  await page.getByRole("button", { name: /Create the team/ }).click();
  await page.waitForURL(/#\/p\/[^/]+\/designer/, { timeout: 30000 });
  await page.screenshot({ path: `${OUT}/workspace-designer.png` });
});
await step(page, HOSTING ? "the designer answers, on the customer's key" : "the designer answers, through the gateway", async () => {
  // A team made from the welcome opens the assistant on the person's first move; ask for it only when it is not there already.
  const send = page.getByRole("button", { name: "Send", exact: true });
  if (!(await send.isVisible().catch(() => false))) await page.locator("#btn-designer").click();
  // The assistant's own box: the nearest one to its Send button (the goal's box in the guide is another).
  await send.locator("xpath=ancestor::*[.//textarea][1]").locator("textarea").first().fill("A team of two: an architect and a reviewer.");
  await send.click();
  if (STAND_IN) await page.waitForSelector("text=stand-in model", { timeout: 60000 });
  else await page.waitForFunction(() => document.querySelectorAll("[class*=chat], [class*=dock]").length > 0 && !/Thinking/i.test(document.body.innerText), null, { timeout: 120000 });
});
if (HOSTING) {
  await step(page, "the account has no balance, credit or usage to show, because none is sold", async () => {
    await page.goto(`${BASE}/account`, { waitUntil: "networkidle" });
    expect(await page.locator("#balance-panel").isHidden(), "a balance is shown");
    expect(await page.locator("#usage-panel").isHidden(), "usage is shown");
    expect(!/Add \$\d/.test(await text("body")), "credit is offered");
    await page.screenshot({ path: `${OUT}/account-hosting.png`, fullPage: true });
  });
} else {
  await step(page, "the account shows the call as what it was charged", async () => {
    await page.goto(`${BASE}/account`, { waitUntil: "networkidle" });
    await page.waitForSelector("#usage table", { timeout: 20000 });
    const usage = await text("#usage");
    expect(/Research/.test(usage), `the usage does not name the workspace: ${usage.slice(0, 200)}`);
    await page.screenshot({ path: `${OUT}/account-usage.png`, fullPage: true });
  });
}
await step(page, "pausing stops the workspace and says why; resuming starts it", async () => {
  await page.getByRole("button", { name: /^Pause( |$)/ }).click();
  await page.waitForSelector("#workspaces .badge:text('Stopped')");
  expect(/Paused by you\. Its files are kept\./.test(await text("#workspaces")), `the reason is not said: ${await text("#workspaces")}`);
  expect(/is paused/.test(await text("#stage-title")), "the card at the top does not say it is paused");
  await page.getByRole("button", { name: /^Resume( |$)/ }).first().click();
  await page.waitForSelector("#workspaces .badge:text('Running')", { timeout: 60000 });
});
await step(page, "the workspace's own address is closed to someone who is not signed in", async () => {
  expect(workspaceUrl !== "", "no workspace was opened");
  const other = await browser.newContext();
  const p = await other.newPage();
  const res = await p.goto(workspaceUrl, { waitUntil: "domcontentloaded" });
  const body = (await p.innerText("body").catch(() => "")).replace(/\s+/g, " ");
  expect(!/Welcome to Curule|Projects/.test(body) && (res?.status() ?? 0) >= 400, `a stranger got ${res?.status()}: ${body.slice(0, 120)}`);
  await other.close();
});
await step(page, "deleting is away from Open, needs the name typed, and takes the workspace", async () => {
  expect(await page.getByRole("button", { name: /^Delete this workspace/ }).count() === 0 || !(await page.getByRole("button", { name: /^Delete this workspace/ }).first().isVisible()), "the button that deletes is shown beside Open");
  await page.getByRole("button", { name: /^More actions for / }).click();
  await page.getByRole("button", { name: /^Delete this workspace/ }).click();
  expect(await page.getByRole("button", { name: "Delete workspace", exact: true }).isDisabled(), "it can be pressed before the name is typed");
  await page.keyboard.type("Research");
  await page.getByRole("button", { name: "Delete workspace", exact: true }).click();
  await page.waitForFunction(() => /Make your first workspace/.test(document.getElementById("stage-title")?.textContent ?? ""), null, { timeout: 30000 });
});
await step(page, "signing out, then in, then changing the password and resetting it by mail", async () => {
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(`${BASE}/`);
  await page.goto(`${BASE}/login?next=/account`);
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForURL(/\/account$/);
  await page.fill("#current", PASSWORD);
  await page.fill("#next", NEXT_PASSWORD);
  await page.click("#password-form button[type=submit]");
  await page.waitForSelector("#password-status.note-ok");
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.goto(`${BASE}/forgot`);
  await page.fill("#email", email);
  await page.click("button[type=submit]");
  await page.waitForSelector("#status.note-ok");
  await page.goto(await linkFor("reset"));
  await page.fill("#password", PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForSelector("#card .note-ok");
  await page.goto(`${BASE}/login`);
  await page.fill("#email", email);
  await page.fill("#password", PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForURL(/\/account$/);
});

await browser.close();
const failed = results.filter((r) => !r.ok).length;
if (errs.size) console.log(`\nerrors the pages logged:\n  ${[...errs].join("\n  ")}`);
if (bad.length) console.log(`\nrequests that failed:\n  ${[...new Set(bad)].join("\n  ")}`);
console.log(`\n${results.length - failed} of ${results.length} steps passed; screenshots are in ${OUT}`);
process.exit(failed || errs.size ? 1 : 0);
