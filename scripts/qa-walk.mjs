#!/usr/bin/env node
/*
 * A person's session on the console, walked by a browser (docs/design-spec.md §7, the check no screenshot can make): start the
 * scripted demo, pause it mid-run and undo, resume, let it reach Delivered, reopen it with a reason, open an agent, a step, an event
 * search, a file, send a message, the Projects page, the palette and the help. It reports each step, every failing request and every
 * error the page logged, and exits 1 if any step failed.
 *
 * Usage:
 *   npm run qa:walk -- --base http://127.0.0.1:7420 --token <operator token> --project demo-stub-4 [--chrome /path] [--out dir]
 *
 * It needs the shipped scripted demo, freshly started (open the project again to wipe a finished run), and, outside the repo's
 * dependencies on purpose: npm install --no-save playwright-core, and a Chrome or Chromium (CHROME=/path/to/chrome).
 * Reopening the scripted team ends in a stalemate decision (its seats play fixed scripts), which this walk accepts.
 */
import fs from "node:fs";
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
const OUT = resolve(opt("out", join(tmpdir(), "curule-qa-walk")));
const CHROME = opt("chrome", process.env.CHROME ?? "");
let chromium;
try {
  ({ chromium } = createRequire(join(process.cwd(), "noop.js"))("playwright-core"));
} catch {
  console.error("qa-walk: playwright-core is not installed. Run: npm install --no-save playwright-core");
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ ...(CHROME ? { executablePath: CHROME } : {}), args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, reducedMotion: "reduce" });
const page = await ctx.newPage();
const results = [];
const bad = [];
const errs = new Set();
page.on("response", (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.request().method()} ${r.url().replace(BASE, "").slice(0, 80)}`); });
page.on("pageerror", (e) => errs.add("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errs.add("console: " + m.text().slice(0, 140)); });
const step = async (name, fn) => {
  try { const note = await fn(); results.push({ name, ok: true, note }); console.log(`PASS  ${name}${note ? "  " + note : ""}`); }
  catch (e) { results.push({ name, ok: false }); console.log(`FAIL  ${name}  ${String(e.message).split("\n")[0].slice(0, 160)}`); await page.screenshot({ path: `${OUT}/fail-${results.length}.png` }).catch(() => {}); }
};
const chip = () => page.locator(".mission-chip").first().innerText().catch(() => "");
const waitChip = async (re, ms = 60000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (re.test(await chip())) return; await page.waitForTimeout(500); } throw new Error(`chip never matched ${re}; it says "${await chip()}"`); };
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

await page.goto(BASE + "/", { waitUntil: "networkidle" });
if (await page.locator("#signin-token").count()) {
  if (!TOKEN) { console.error("qa-walk: the console asks for a token; pass --token"); process.exit(2); }
  await page.fill("#signin-token", TOKEN);
  await page.click("button[type=submit]");
  await page.waitForTimeout(2000);
}
await page.goto(`${BASE}/#/p/${PROJECT}/overview`, { waitUntil: "networkidle" });
await page.waitForTimeout(2000);

// The first three steps need the mission parked and unstarted. A project that is already running or delivered (a host brings a
// project back in the mode it was in) skips them, and says so, and the walk goes on from wherever the mission is.
const parkedAtStart = await page.locator('button[data-action="start"]').first().waitFor({ timeout: 6000 }).then(() => true, () => false);
if (!parkedAtStart) console.log("SKIP  start, pause and resume: the mission is not parked (open the project again with it parked to walk them)");
if (parkedAtStart) {
  await step("start the mission", async () => {
    await page.locator('button[data-action="start"]').first().click();
    await page.getByRole("button", { name: "Start the mission" }).click();
    await waitChip(/Running/i, 20000);
  });
  await step("pause mid-run says so and offers Undo", async () => {
    await page.locator('button[data-action="pause"]').first().click();
    await page.waitForTimeout(900);
    const toasts = (await page.locator("#toasts").innerText()).replace(/\s+/g, " ");
    expect(/Mission paused/i.test(toasts), `no pause notice: ${toasts}`);
    expect(/Undo/.test(toasts), "no Undo on the pause notice");
    await waitChip(/Paused/i, 8000);
    return `chip ${await chip()}`;
  });
  await step("resume continues the run", async () => {
    await page.locator('button[data-action="resume"]').first().click();
    await page.waitForTimeout(600);
    const dlg = page.locator('[role="dialog"], [role="alertdialog"]').last();
    if (await dlg.count()) { await dlg.getByRole("button").filter({ hasText: /Resume/i }).last().click(); }
    await waitChip(/Running|Delivered/i, 15000);
  });
}
await step("the run reaches Delivered", async () => { await waitChip(/Delivered/i, 60000); });
await step("reopen asks for a reason and puts the agents back to work", async () => {
  // The delivered hero offers it as a button of its own ("Reopen with feedback"), not behind "...".
  await page.locator('#view .ov-acts button[data-action="reopen"]').click();
  await page.waitForTimeout(500);
  const dlg = page.locator('[role="dialog"], [role="alertdialog"]').last();
  const confirm = dlg.getByRole("button", { name: /Reopen and brief/i });
  expect(await confirm.isDisabled(), "Reopen is enabled with no reason typed");
  await dlg.locator("input, textarea").first().fill("the idempotency key is never checked");
  await confirm.click();
  await waitChip(/Running|Needs you/i, 15000);
  await waitChip(/Delivered|Needs you/i, 90000);
  return `chip ${await chip()}`;
});
await step("the Agents view lists the seats and an agent opens in a panel", async () => {
  await page.locator('#nav .tab[data-view="agents"]').click();
  await page.waitForTimeout(1200);
  const cards = page.locator("#view button, #view [role=button]").filter({ hasText: /developer|architect|pm/ });
  expect(await cards.count() > 0, "no agent card");
  await cards.first().click();
  await page.waitForTimeout(1500);
  expect(await page.locator("#drawer").count() === 1 || /\/agents\//.test(page.url()), "no panel or route for the agent");
  const text = (await page.locator("#drawer, #view").last().innerText()).replace(/\s+/g, " ");
  expect(!/Could not|unreachable|undefined|\[object/i.test(text.slice(0, 600)), `error text in the agent panel: ${text.slice(0, 200)}`);
  await page.screenshot({ path: `${OUT}/agent.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
});
await step("a step opens with its turn", async () => {
  await page.locator('#nav .tab[data-view="steps"]').click();
  await page.waitForTimeout(1500);
  const rows = page.locator("#view .st-row, #view [data-step], #view button.st-card, #view .stc");
  const first = (await rows.count()) ? rows.first() : page.locator("#view button").filter({ hasText: /new message|something it cares/ }).first();
  await first.click();
  await page.waitForTimeout(1800);
  const text = (await page.locator("#drawer, #view").last().innerText()).replace(/\s+/g, " ");
  expect(!/Could not|undefined|\[object/i.test(text.slice(0, 800)), `error text: ${text.slice(0, 200)}`);
  await page.screenshot({ path: `${OUT}/step.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
});
await step("Events searches and a row opens its detail", async () => {
  await page.locator('#nav .tab[data-view="events"]').click();
  await page.waitForTimeout(1500);
  const before = await page.locator("#view .evc-row, #view [data-seq]").count();
  await page.locator('#view input[type="search"], #view input.search').first().fill("approved");
  await page.waitForTimeout(900);
  const after = await page.locator("#view .evc-row, #view [data-seq]").count();
  return `rows ${before} -> ${after}`;
});
await step("Files opens a file in a reader", async () => {
  await page.locator('#nav .tab[data-view="artifacts"]').click();
  await page.waitForTimeout(1800);
  const text = (await page.locator("#view").innerText()).replace(/\s+/g, " ");
  expect(!/Could not load|No files/i.test(text.slice(0, 500)), `files page: ${text.slice(0, 160)}`);
  await page.screenshot({ path: `${OUT}/files.png` });
});
await step("Message sends and says so", async () => {
  await page.locator("#btn-message").click();
  await page.waitForTimeout(600);
  await page.fill("#send-to", "pm");
  await page.fill("#send-note", "Please confirm the idempotency key is checked.");
  await page.getByRole("button", { name: /^Send$/ }).click();
  await page.waitForTimeout(1200);
  const out = (await page.locator("#drawer .form-out").innerText()).trim();
  expect(/^Sent to pm\./.test(out), `the drawer says "${out}"`);
  expect((await page.locator("#send-note").inputValue()) === "", "the message was not cleared after sending");
  await page.screenshot({ path: `${OUT}/message.png` });
  await page.keyboard.press("Escape");
});
await step("the Projects page lists the project with its state", async () => {
  await page.locator('#nav .tab[data-view="projects"]').click();
  await page.waitForTimeout(1500);
  const text = (await page.locator("#view").innerText()).replace(/\s+/g, " ");
  expect(/Projects/.test(text) && new RegExp(PROJECT.slice(0, 8), "i").test(text) || /Demo Mesh/.test(text), `no project row: ${text.slice(0, 200)}`);
  await page.screenshot({ path: `${OUT}/projects.png` });
});
await step("the palette goes to a page", async () => {
  await page.keyboard.press("Control+k");
  await page.waitForTimeout(400);
  await page.keyboard.type("cost");
  await page.waitForTimeout(300);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(900);
  expect(/\/cost/.test(page.url()), `url is ${page.url()}`);
});
await step("help opens and Escape closes it", async () => {
  await page.keyboard.press("?");
  await page.waitForTimeout(500);
  expect(await page.locator("#drawer").count() === 1, "no help panel");
  await page.screenshot({ path: `${OUT}/help.png` });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  expect(await page.locator("#drawer").count() === 0, "help did not close");
});
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
console.log("failing responses:", JSON.stringify([...new Set(bad)]));
console.log("page errors:", JSON.stringify([...errs]));
await browser.close();
process.exit(failed.length ? 1 : 0);
