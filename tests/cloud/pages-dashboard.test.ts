/**
 * The account as a place to look at before it is a place to act: the tiles that say what the account is, the list of its sections that
 * marks the one in view, the shape it has while it is read, how much of the plan's allowance is left, a bar for each day of usage, an
 * address to copy, how far a workspace is in starting, and Settings closed until it is asked for. The pure parts are tried on tables;
 * the page is the real page file with the real script, as in pages-app.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { PAGES_DIR, Visit, helpers, visit } from "./pages-support";
import { ACTIVE, HOSTING_PLANS, HOSTING_SUB, KEPT, NO_USAGE, PLANS, balance, failure, hosting, paid, workspace, world, type Subscription, type WorkspaceView } from "./pages-world";

const h = helpers();

const LATE: Subscription = { plan: "team", title: "Team", status: "past_due", periodEnd: "2026-11-05T12:00:00.000Z", pastDueSince: "2026-10-05T12:00:00.000Z" };
const view = (over: Record<string, unknown> = {}) => ({ subscription: ACTIVE, workspaces: [], plans: PLANS.plans, plansKnown: true, topups: PLANS.topups, policy: PLANS.policy, ...over });
const ws = (name: string, status: string, over: Partial<WorkspaceView> = {}): WorkspaceView => workspace({ workspaceId: `ws_${name}`, name, status, ...over });
const tiles = (v: ReturnType<typeof view>, b: ReturnType<typeof balance> | null = balance()) => h.glanceOf(v, b, "USD") as Array<{ id: string; label: string; value: string; unit: string; note: string; badge?: [string, string] }>;

// ---- what the account is, at a glance ----

test("the tiles say what the account has in a few words: the workspaces that are running and what else there is, the plan and its state, the balance where usage is sold", () => {
  assert.deepEqual(tiles(view({ subscription: null })), [], "a visitor with no plan has nothing to glance at: the card at the top is for them");
  assert.deepEqual(tiles(view({ subscription: { plan: "team", title: "Team", status: "ended" } })), []);

  assert.deepEqual(tiles(view()), [
    { id: "workspaces", label: "Workspaces", value: "0", unit: "running", note: "1 workspace in your plan" },
    { id: "plan", label: "Plan", value: "Team", unit: "", note: "$149.00 per month", badge: ["Active", "ok"] },
    { id: "balance", label: "Balance", value: "$20.00", unit: "", note: "available" },
  ]);
  const several = tiles(view({ subscription: { ...ACTIVE!, plan: "business", title: "Business" }, workspaces: [ws("A", "running"), ws("B", "running"), ws("C", "suspended"), ws("D", "provisioning"), ws("E", "requested"), ws("F", "failed")] }));
  assert.deepEqual([several[0]!.value, several[0]!.note], ["2", "2 starting, 1 stopped, 1 could not start"], "what is not running is said in the same breath, so that a count of running is not read as all there is");
  assert.deepEqual(tiles(view({ subscription: LATE }))[1]!.badge, ["Payment overdue", "warn"]);
  assert.equal(tiles(view({ plans: [], plansKnown: false, workspaces: [ws("A", "running")] }))[0]!.note, "", "with the plans unreadable no allowance is made up");
  assert.equal(tiles(view({ plans: [], plansKnown: false }))[1]!.note, "");

  const hostingOnly = tiles(view({ subscription: HOSTING_SUB, plans: HOSTING_PLANS.plans, topups: null, workspaces: [ws("A", "running", { models: { source: "own", key: null } })] }), null);
  assert.deepEqual(hostingOnly.map((t) => t.id), ["workspaces", "plan"], "a plan that sells hosting only has no balance to glance at");
  assert.equal(tiles(view(), balance({ included: 0, purchased: 0, available: 0 }))[2]!.value, "$0.00", "a balance that is gone is a figure, and is said");
  assert.deepEqual([tiles(view(), null)[2]!.value, tiles(view(), null)[2]!.note], ["", "Not available just now"], "and one that could not be read is not a figure");
  assert.deepEqual(h.planState({ status: "past_due" }), ["Payment overdue", "warn"]);
  assert.deepEqual(h.planState({ status: "trialing" }), ["trialing", ""], "a state the page has no word for is said as the service says it");
});

test("the tiles are on the page for an account that has a plan, in words that are the account's own, and not for one that has none", async () => {
  const none = await visit("account", { routes: world().routes });
  assert.equal(none.shows(none.$("glance")), false);

  const running = await visit("account", { routes: world((x) => { paid(x); x.workspaces = [workspace()]; }).routes });
  assert.equal(running.shows(running.$("glance")), true);
  assert.equal(running.text("glance-list"), "Workspaces 1 running 1 workspace in your plan Plan Team Active $149.00 per month Balance $20.00 available");
  assert.equal(running.$("glance").getAttribute("aria-labelledby"), "glance-h");
  assert.equal(running.text("glance-h"), "At a glance");
  assert.equal(running.$("glance-h").className, "sr", "the heading is for a reader who has not the tiles in front of them");

  const late = await visit("account", { routes: world((x) => { x.subscription = LATE; x.workspaces = [workspace()]; }).routes });
  assert.match(late.text("glance-list"), /Plan Team Payment overdue \$149\.00 per month/);

  const keyless = await visit("account", { routes: hosting().routes });
  assert.equal(keyless.text("glance-list"), "Workspaces 1 running 1 workspace in your plan Plan Hosting Active $49.00 per month");

  const evil = '<img src=x onerror="alert(1)">';
  const named = await visit("account", { routes: world((x) => { x.subscription = { ...ACTIVE!, title: evil }; x.workspaces = [workspace()]; }).routes });
  assert.ok(named.text("glance-list").includes(evil), "a plan's name is text");
  assert.ok(!named.$("glance").descendants().some((n) => n.tag === "img"));
});

// ---- the list of sections ----

test("the list of sections names the ones the account has and not the others, and is not offered for a page that is short", async () => {
  const links = (v: Visit) => v.$("subnav").querySelectorAll("a").filter((a) => !a.hidden).map((a) => v.text(a));

  const first = await visit("account", { routes: world().routes });
  assert.equal(first.shows(first.$("subnav")), false, "a plan to choose and the settings: two sections are a short page");

  const paidOnly = await visit("account", { routes: world(paid).routes });
  assert.deepEqual(links(paidOnly), ["Plan", "Balance", "Settings"]);
  assert.equal(paidOnly.shows(paidOnly.$("subnav")), true);

  const using = await visit("account", { routes: world((x) => { paid(x); x.workspaces = [workspace()]; }).routes });
  assert.deepEqual(links(using), ["Workspaces", "Plan", "Balance", "Usage", "Settings"]);
  assert.equal(using.$("subnav").getAttribute("aria-label"), "On this page");
  for (const a of using.$("subnav").querySelectorAll("a")) assert.ok(using.doc.getElementById(a.getAttribute("href")!.slice(1)), `${a.getAttribute("href")} is a section of the page`);

  const hostingOnly = await visit("account", { routes: hosting().routes });
  assert.deepEqual(links(hostingOnly), ["Workspaces", "Plan", "Settings"], "a plan that sells hosting only has no balance or usage section, so the list does not offer them");
});

test("the list marks the section a reader is in: the last of those in the band they read in, and the last of all at the foot of the page", async () => {
  const order = ["workspaces-panel", "plan-panel", "balance-panel", "usage-panel", "settings-panel"];
  assert.equal(h.pickSection(order, new Set(), false), "", "above the first section none is marked");
  assert.equal(h.pickSection(order, new Set(["plan-panel"]), false), "plan-panel");
  assert.equal(h.pickSection(order, new Set(["workspaces-panel", "plan-panel"]), false), "plan-panel", "when two share the band, the one whose top has come in is the one");
  assert.equal(h.pickSection(order, new Set(["workspaces-panel"]), true), "settings-panel", "at the foot a short last section is the one, though it never reaches the band");
  assert.equal(h.pickSection([], new Set(), true), "");

  const v = await visit("account", { routes: world((x) => { paid(x); x.workspaces = [workspace()]; }).routes, observer: true });
  assert.deepEqual(v.watching.targets.map((n) => n.id), ["workspaces-panel", "plan-panel", "balance-panel", "usage-panel", "settings-panel"], "the page's own sections are what is watched");
  const current = () => v.$("subnav").querySelectorAll("a").filter((a) => a.getAttribute("aria-current") !== null).map((a) => `${v.text(a)}=${a.getAttribute("aria-current")}`);
  assert.deepEqual(current(), [], "at the top nothing is marked");
  v.intersect(["plan-panel"]);
  assert.deepEqual(current(), ["Plan=location"]);
  v.intersect(["plan-panel", "balance-panel"]);
  assert.deepEqual(current(), ["Balance=location"], "one at a time");
  v.view.scrollY = 3000;
  v.intersect(["balance-panel"]);
  assert.deepEqual(current(), ["Settings=location"], "and the last one at the foot");
  v.view.scrollY = 0;
  v.intersect([]);
  assert.deepEqual(current(), []);

  const blind = await visit("account", { routes: world((x) => { paid(x); x.workspaces = [workspace()]; }).routes });
  assert.deepEqual(blind.$("subnav").querySelectorAll("a").filter((a) => a.getAttribute("aria-current") !== null), [], "a browser that cannot tell leaves a list of links that work");
  assert.deepEqual(blind.consoleErrors, []);
});

test("Settings is closed until it is asked for, and the list's link to it asks", async () => {
  const html = fs.readFileSync(`${PAGES_DIR}/account.html`, "utf8");
  assert.match(html, /<details>\s*<summary><h2 id="security-h">Settings<\/h2><\/summary>/, "a disclosure that no script is needed to open, with the heading in its summary");
  assert.doesNotMatch(html, /<details[^>]* open/, "and it is closed");
  const v = await visit("account", { routes: world((x) => { paid(x); x.workspaces = [workspace()]; }).routes });
  const details = v.$("settings-panel").querySelector("details")!;
  assert.equal(details.hasAttribute("open"), false);
  v.click(v.link("subnav", "Settings"));
  assert.equal(details.hasAttribute("open"), true);
  assert.equal(v.$("settings-panel").className, "panel panel-quiet");
});

// ---- the shape of the page while it is read ----

test("the page has a shape while it is read, and loses it when it has something to show, or something to say", async () => {
  assert.match(fs.readFileSync(`${PAGES_DIR}/account.html`, "utf8"), /id="skeleton" aria-hidden="true" hidden>/, "with no script it is not there: a page that says it needs one is not waiting for anything");
  const w = world((x) => { paid(x); x.workspaces = [workspace()]; });
  let during = "";
  const v = new Visit("account", { routes: w.routes });
  w.answers.set("GET /api/me", () => {
    during = String(v.shows(v.$("skeleton")));
    return { json: { account: w.view(), balance: w.balance } };
  });
  await v.start();
  assert.equal(during, "true", "it was there while the account was being read");
  assert.equal(v.shows(v.$("skeleton")), false, "and is gone with what it stood for");
  assert.equal(v.$("skeleton").getAttribute("aria-hidden"), "true", "it is for the eye: nothing in it is read out");

  const down = await visit("account", { routes: (c) => (c.path === "/api/session" ? failure(503, "unavailable", "Changes cannot be saved just now. Try again in a few minutes.") : undefined) });
  assert.equal(down.shows(down.$("skeleton")), false, "a page that says what went wrong is not still waiting");
  const out = await visit("account", { routes: world((x) => (x.signedIn = false)).routes });
  assert.equal(out.shows(out.$("skeleton")), false, "nor is one that sends the person to sign in");
  const half = world(paid);
  half.answers.set("GET /api/me", failure(502, "bad_gateway", "Something went wrong on our side. Try again in a moment."));
  const part = await visit("account", { routes: half.routes });
  assert.equal(part.shows(part.$("skeleton")), false);
});

// ---- the balance and the usage ----

test("how much of what the plan includes is left is said only when the figures say it", () => {
  const team = PLANS.plans[0]!;
  assert.deepEqual(h.allowanceLeft(team, balance({ included: 5_000_000 })), { left: 5_000_000, of: 20_000_000 });
  assert.deepEqual(h.allowanceLeft(team, balance({ included: 20_000_000 })), { left: 20_000_000, of: 20_000_000 }, "all of it is a whole bar");
  assert.deepEqual(h.allowanceLeft(team, balance({ included: 0, purchased: 0 })), { left: 0, of: 20_000_000 }, "none of it is an empty one, and is said");
  assert.equal(h.allowanceLeft(team, balance({ included: 30_000_000 })), null, "more than the plan includes: a plan changed part way through the period, which the page does not guess about");
  assert.equal(h.allowanceLeft(team, null), null, "a balance that could not be read");
  assert.equal(h.allowanceLeft(undefined, balance()), null, "a plan that is not known");
  assert.equal(h.allowanceLeft(HOSTING_PLANS.plans[0], balance()), null, "a plan that sells hosting only includes none");
  assert.equal(h.allowanceLeft({ ...team, includedUsageMicros: 0 }, balance({ included: 0 })), null);
});

test("a bar for each day is the day against the busiest of the days shown, for the eye, and says nothing a person has to read", async () => {
  const row = (group: string, calls: number, charged: number) => ({ group, calls, failed: 0, inputTokens: calls * 100, outputTokens: calls * 20, cachedTokens: 0, chargedMicros: charged });
  const w = world((x) => {
    paid(x);
    x.workspaces = [workspace()];
    x.usage = { currency: "USD", byDay: [row("2026-10-03", 2, 800), row("2026-10-05", 3, 8_400), row("2026-10-04", 1, 0)], byWorkspace: [row("ws_1", 6, 9_200)], total: { calls: 6, failed: 0, inputTokens: 600, outputTokens: 120, cachedTokens: 0, chargedMicros: 9_200 } };
  });
  const v = await visit("account", { routes: w.routes });
  const [days, spaces] = v.$("usage").querySelectorAll("table");
  const bars = days!.querySelectorAll("tbody meter").map((m) => [m.getAttribute("value"), m.getAttribute("max"), m.getAttribute("aria-hidden")]);
  assert.deepEqual(bars, [["8400", "8400", "true"], ["0", "8400", "true"], ["800", "8400", "true"]], "newest first, each against the busiest, and the figure beside it is the one that is read");
  assert.equal(days!.querySelectorAll("tfoot meter").length, 0, "the total is not a day");
  assert.equal(spaces!.querySelectorAll("meter").length, 0, "and a workspace's share is not drawn as one");
  assert.equal(v.text(days!.querySelectorAll("tbody tr")[0]!), "Oct 5, 2026 3 300 60 $0.0084");

  const free = world((x) => { paid(x); x.workspaces = [workspace()]; x.usage = { currency: "USD", byDay: [row("2026-10-03", 2, 0)], byWorkspace: [], total: { calls: 2, failed: 0, inputTokens: 200, outputTokens: 40, cachedTokens: 0, chargedMicros: 0 } }; });
  const f = await visit("account", { routes: free.routes });
  assert.equal(f.$("usage").querySelectorAll("meter").length, 0, "when nothing was charged there is nothing to draw against");
});

test("nothing used yet is an empty state: what is missing, and when it will not be", async () => {
  const v = await visit("account", { routes: world((x) => { paid(x); x.workspaces = [workspace()]; x.usage = NO_USAGE; }).routes });
  const empty = v.$("usage").querySelector(".empty")!;
  assert.equal(v.text(empty), "Nothing has been used yet. Calls appear here when a mesh in one of your workspaces asks a model for something.");
  assert.equal(v.text(empty.querySelector(".empty-t")!), "Nothing has been used yet.");
  assert.equal(empty.querySelector(".tile")!.getAttribute("aria-hidden"), "true");
  assert.equal(v.$("usage").querySelectorAll("table").length, 0);
});

// ---- the card of a workspace ----

test("a workspace that is starting shows how far it is, as steps for the eye, and a pulse on its state; one that is not does not", async () => {
  assert.equal(h.phaseOf("requested"), 1);
  assert.equal(h.phaseOf("provisioning"), 2);
  for (const status of ["running", "suspended", "failed", "anything"]) assert.equal(h.phaseOf(status), 0, status);

  const w = world((x) => { paid(x); x.workspaces = [workspace({ status: "requested" })]; });
  const v = await visit("account", { routes: w.routes });
  const phase = () => v.$("workspaces").querySelector(".phase");
  assert.deepEqual([phase()!.getAttribute("data-step"), phase()!.getAttribute("aria-hidden"), phase()!.children.length], ["1", "true", 3]);
  assert.equal(v.text(v.$("workspaces").querySelector(".ws-says")!), "It starts in the background, and this page updates when it is ready.", "the words are as they were: the steps add none");
  assert.match(v.$("workspaces").querySelector(".row-head .badge")!.className, /\bbadge-live\b/);

  w.workspaces = [workspace({ status: "provisioning" })];
  await v.until("the step to move on", () => phase()?.getAttribute("data-step") === "2");
  w.workspaces = [workspace()];
  await v.until("the workspace to be running", () => v.text("stage-title") === "Research is running");
  assert.equal(phase(), null, "a workspace that is up has no steps to show");
  assert.doesNotMatch(v.$("workspaces").querySelector(".row-head .badge")!.className, /badge-live/);
});

test("the address of a workspace can be copied where the browser will copy, and the control is not there where it will not", async () => {
  const running = (o: Partial<ConstructorParameters<typeof Visit>[1]> = {}) => visit("account", { routes: world((x) => { paid(x); x.workspaces = [workspace()]; }).routes, manualTimers: true, ...o });

  const none = await running();
  assert.equal(none.doc.querySelectorAll("button").filter((b) => b.className === "copy").length, 0, "on an address that is not secure the browser will not copy, and a control that cannot is not offered");

  const v = await running({ clipboard: "works" });
  const copy = v.button("workspaces", "Copy");
  assert.equal(copy.getAttribute("aria-label"), "Copy the address of Research", "named for the workspace, as every button on the card is");
  assert.equal(v.text(v.$("workspaces").querySelector(".ws-address")!), "Address research-1a2b3c.ws.example.com Copy");
  v.click(copy);
  await v.idle();
  assert.deepEqual(v.copied, ["research-1a2b3c.ws.example.com"]);
  assert.equal(copy.textContent, "Copied");
  const line = v.$("workspaces").querySelector(".ws-note")!;
  assert.equal(v.text(line), "Copied the address.", "and said where the card says what became of what was asked, which is read out");
  await v.advance(2000);
  assert.deepEqual([copy.textContent, v.text(line)], ["Copy", ""]);

  const refused = await running({ clipboard: "refuses" });
  refused.click(refused.button("workspaces", "Copy"));
  await refused.idle();
  assert.equal(refused.text(refused.$("workspaces").querySelector(".ws-note")!), "The address could not be copied.");
  assert.equal(refused.button("workspaces", "Copy").textContent, "Copy", "and the control stays what it was");
});
