/**
 * Where a customer is, and what the account says to them there: the stage an account is at (no plan, a payment that is late, no workspace
 * yet, starting, needing its key, ready, stopped, failed), what the card at the top of the page says for it, which parts of the page are shown,
 * and what a person sees and can do on the page at each stage. The pure parts are tried on tables; the page is the real page file with the
 * real script, as in pages-app.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Visit, helpers, visit, type FakeNode } from "./pages-support";
import { ACTIVE, HOSTING_PLANS, HOSTING_SUB, NOW, PLANS, balance, failure, hosting, paid, workspace, world, type Subscription, type WorkspaceView } from "./pages-world";

const h = helpers();

// ---- the stage, from what the service says ----

const LATE: Subscription = { plan: "team", title: "Team", status: "past_due", periodEnd: "2026-11-05T12:00:00.000Z", pastDueSince: "2026-10-05T12:00:00.000Z" };
const KEY = { provider: "anthropic", model: "claude-sonnet-4-5", setAt: NOW };
const own = (key: typeof KEY | null) => ({ source: "own" as const, key });
const view = (over: Record<string, unknown> = {}) => ({ subscription: ACTIVE, workspaces: [], plans: PLANS.plans, plansKnown: true, topups: PLANS.topups, policy: PLANS.policy, ...over });
const hostingView = (workspaces: WorkspaceView[], over: Record<string, unknown> = {}) => view({ subscription: HOSTING_SUB, plans: HOSTING_PLANS.plans, topups: null, workspaces, ...over });
const ws = (name: string, status: string, over: Partial<WorkspaceView> = {}): WorkspaceView => workspace({ workspaceId: `ws_${name}`, name, status, ...over });
const states = (v: ReturnType<typeof view>) => h.stageOf(v).steps.map((s: { id: string; state: string }) => `${s.id}:${s.state}`).join(" ");

test("the stage of an account is the first thing that is not done: no plan, a late payment, no workspace, starting, a key that is missing, a workspace to open, stopped, failed", () => {
  const table: Array<[string, ReturnType<typeof view>, string, string, string]> = [
    // what, the account, the stage, the step the person is at, the workspace the stage is about
    ["no subscription", view({ subscription: null }), "no-plan", "plan", ""],
    ["a subscription that ended", view({ subscription: { plan: "team", title: "Team", status: "ended" } }), "no-plan", "plan", ""],
    ["a plan and no workspace", view(), "no-workspace", "workspace", ""],
    ["a workspace that is requested", view({ workspaces: [ws("Alpha", "requested")] }), "starting", "workspace", "Alpha"],
    ["a workspace that is being provisioned", view({ workspaces: [ws("Alpha", "provisioning")] }), "starting", "workspace", "Alpha"],
    ["a workspace that is running", view({ workspaces: [ws("Alpha", "running")] }), "ready", "open", "Alpha"],
    ["a workspace that is stopped", view({ workspaces: [ws("Alpha", "suspended")] }), "stopped", "open", "Alpha"],
    ["a workspace that could not start", view({ workspaces: [ws("Alpha", "failed")] }), "failed", "workspace", "Alpha"],
    ["a late payment with no workspace", view({ subscription: LATE }), "late", "workspace", ""],
    ["a late payment with a workspace running", view({ subscription: LATE, workspaces: [ws("Alpha", "running")] }), "late", "open", "Alpha"],
    ["a late payment with its workspaces stopped", view({ subscription: LATE, workspaces: [ws("Alpha", "suspended", { statusReason: "payment is overdue" })] }), "late", "open", "Alpha"],
    ["hosting only, running, with no key", hostingView([ws("Alpha", "running", { models: own(null) })]), "needs-key", "key", "Alpha"],
    ["hosting only, running, with its key", hostingView([ws("Alpha", "running", { models: own(KEY) })]), "ready", "open", "Alpha"],
    ["hosting only, starting", hostingView([ws("Alpha", "provisioning", { models: own(null) })]), "starting", "workspace", "Alpha"],
    ["hosting only, stopped, with no key", hostingView([ws("Alpha", "suspended", { models: own(null) })]), "stopped", "key", "Alpha"],
    ["hosting only, with no workspace", hostingView([]), "no-workspace", "workspace", ""],
  ];
  for (const [what, v, id, step, name] of table) {
    const stage = h.stageOf(v);
    assert.deepEqual([stage.id, stage.step, stage.workspace ? stage.workspace.name : ""], [id, step, name], what);
  }
});

test("with several workspaces the stage is about the one that can be opened, then one that needs a key, then one starting, stopped or failed: what works is not hidden behind what does not", () => {
  const mixed = [ws("Failed", "failed", { models: own(null) }), ws("Stopped", "suspended", { models: own(KEY) }), ws("Starting", "provisioning", { models: own(null) }), ws("Keyless", "running", { models: own(null) }), ws("Ready", "running", { models: own(KEY) })];
  const order: Array<[string, string]> = [["ready", "Ready"], ["needs-key", "Keyless"], ["starting", "Starting"], ["stopped", "Stopped"], ["failed", "Failed"]];
  let rest = mixed;
  for (const [id, name] of order) {
    const stage = h.stageOf(hostingView(rest));
    assert.deepEqual([stage.id, stage.workspace.name], [id, name]);
    rest = rest.filter((w) => w.name !== name);
  }
  assert.equal(h.stageOf(hostingView(rest)).id, "no-workspace", "and with none left there is none");
  const two = [ws("First", "running"), ws("Second", "running")];
  assert.equal(h.stageOf(view({ workspaces: two })).workspace.name, "First", "of two that can be opened the first is the stage's");
  assert.equal(h.stageOf(view({ subscription: LATE, workspaces: [ws("Gone", "failed"), ws("Up", "running")] })).workspace.name, "Up", "and a late payment is about the one that is still running");
});

test("the steps are Plan, Workspace and Open, with Model key before Open on a plan that sells hosting only, and the person is at the first that is not done", () => {
  assert.equal(states(view({ subscription: null })), "plan:now workspace:next open:next");
  assert.equal(states(view()), "plan:done workspace:now open:next");
  assert.equal(states(view({ workspaces: [ws("A", "provisioning")] })), "plan:done workspace:now open:next", "a workspace that is starting is the step still being done");
  assert.equal(states(view({ workspaces: [ws("A", "running")] })), "plan:done workspace:done open:now");
  assert.equal(states(view({ workspaces: [ws("A", "failed")] })), "plan:done workspace:now open:next", "one that could not start is not one that was made");
  assert.equal(states(view({ workspaces: [ws("A", "suspended")] })), "plan:done workspace:done open:now", "a stopped one was made: what is left is to resume and open it");

  assert.equal(states(hostingView([])), "plan:done workspace:now key:next open:next");
  assert.equal(states(hostingView([ws("A", "running", { models: own(null) })])), "plan:done workspace:done key:now open:next", "the key can only be given to a workspace that has started, so it is after the workspace");
  assert.equal(states(hostingView([ws("A", "running", { models: own(KEY) })])), "plan:done workspace:done key:done open:now");
  assert.equal(states(hostingView([ws("A", "provisioning", { models: own(null) })])), "plan:done workspace:now key:next open:next");
  assert.deepEqual(h.stageOf(hostingView([])).steps.map((s: { label: string }) => s.label), ["Plan", "Workspace", "Model key", "Open"]);

  // A visitor with no plan is shown the steps of what is on offer, so they do not change count when a plan is chosen.
  assert.equal(states(hostingView([], { subscription: null })), "plan:now workspace:next key:next open:next");
  assert.equal(states(view({ subscription: null, plans: [...PLANS.plans, ...HOSTING_PLANS.plans] })), "plan:now workspace:next open:next", "plans that are not all hosting only have no key step until one that is is chosen");
  assert.equal(states(view({ subscription: null, plans: [], plansKnown: false })), "plan:now workspace:next open:next");
  assert.equal(h.isByok(hostingView([])), true);
  assert.equal(h.isByok(view()), false);
  assert.equal(h.isByok(view({ plans: [], plansKnown: false, workspaces: [ws("A", "running", { models: own(null) })] })), true, "plans that could not be read: a workspace that carries the state of a key is a hosting-only one");
  assert.equal(h.isByok(view({ plans: [], plansKnown: false, workspaces: [ws("A", "running")] })), false);
});

// ---- what the card says ----

const card = (v: ReturnType<typeof view>) => h.nextStepOf(h.stageOf(v), v);

test("the card says one thing for each stage, in a sentence, with the one action that is next", () => {
  const link = { kind: "link", label: "Choose a plan", href: "#plan-h" };
  assert.deepEqual(card(view({ subscription: null })), { tone: "", title: "Choose a plan", text: "A plan is a flat monthly price for your workspace. Choose one below and pay on the next page.", action: link });
  assert.deepEqual(card(hostingView([], { subscription: null })), { tone: "", title: "Choose a plan", text: "A plan is a flat monthly price for hosting your workspace. Choose one below and pay on the next page. You bring your own model key and pay your model provider yourself.", action: link });
  assert.deepEqual(card(view({ subscription: { plan: "team", title: "Team", status: "ended" } })), {
    tone: "warn",
    title: "Choose a plan to start again",
    text: "Your subscription has ended and your workspaces are stopped. They are deleted 30 days after it ended. Choose a plan again before then and they start again.",
    action: link,
  });
  assert.equal(card(view({ subscription: { plan: "team", title: "Team", status: "ended" }, policy: null })).text, "Your subscription has ended and your workspaces are stopped. They are deleted after it ended. Choose a plan again before then and they start again.", "with no period to say, none is made up");

  assert.deepEqual(card(view()), { tone: "", title: "Make your first workspace", text: "Your Team plan is active. A workspace is your own Curule host, with its own projects, event log and files.", action: { kind: "create", label: "Create workspace" } });
  assert.equal(card(hostingView([])).text, "Your Hosting plan is active. A workspace is your own Curule host, with its own projects, event log and files. You give it your model key once it has started.");
  assert.equal(card(view({ subscription: { plan: "team", status: "active" } })).text.slice(0, 27), "Your plan is active. A work", "a plan with no name is a plan all the same");

  assert.deepEqual(card(view({ workspaces: [ws("Alpha", "provisioning")] })), { tone: "", title: "Alpha is starting", text: "This page checks every few seconds and shows when it is ready.", action: null });
  assert.equal(card(hostingView([ws("Alpha", "provisioning", { models: own(null) })])).text, "This page checks every few seconds and shows when it is ready. Then you give it your model key.");
  assert.equal(card(view({ workspaces: [ws("Alpha", "provisioning")], stale: true })).text, "This page has stopped checking. Reload it to look again.", "a page that has stopped looking says so, and does not go on saying it is checking");

  assert.deepEqual(card(hostingView([ws("Alpha", "running", { models: own(null) })])), {
    tone: "",
    title: "Add your model key",
    text: "Alpha is running, but its team has no model yet. Give it the key of your model provider. Curule does not resell model usage, so your provider bills you directly.",
    action: { kind: "key", label: "Add your model key" },
  });

  assert.deepEqual(card(view({ workspaces: [ws("Alpha", "running")] })), { tone: "", title: "Alpha is running", text: "Open it to describe your team and start a mission.", action: { kind: "open", label: "Open" } });
  assert.deepEqual(card(view({ workspaces: [ws("One", "running"), ws("Two", "running")] })), { tone: "", title: "Your workspaces are running", text: "Open the one you want to work in.", action: null }, "with several there is no one to open, and each says so for itself");
  assert.deepEqual(card(hostingView([ws("Keyless", "running", { models: own(null) }), ws("Ready", "running", { models: own(KEY) })])), { tone: "", title: "Ready is running", text: "Open it to describe your team and start a mission.", action: { kind: "open", label: "Open" } }, "one that has no key yet is not one to open: the one that is ready is the card's");

  assert.deepEqual(card(view({ workspaces: [ws("Alpha", "suspended", { statusReason: "paused by its owner" })] })), { tone: "", title: "Alpha is paused", text: "Its files are kept. Resume it to open it.", action: { kind: "resume", label: "Resume" } });
  assert.deepEqual(card(view({ workspaces: [ws("Alpha", "suspended", { statusReason: "the account was stopped: abuse report 12" })] })), { tone: "", title: "Alpha is stopped", text: "The account was stopped: abuse report 12. Resume it to open it.", action: { kind: "resume", label: "Resume" } });
  assert.equal(card(view({ workspaces: [ws("Alpha", "suspended")] })).text, "It is not running. Resume it to open it.");

  assert.deepEqual(card(view({ workspaces: [ws("Alpha", "failed", { statusReason: "the workspace did not become ready: no answer yet" })] })), {
    tone: "bad",
    title: "Alpha could not start",
    text: "The workspace did not become ready: no answer yet. Delete it and make a new one. If it fails again, tell the operator.",
    action: null,
    contact: true,
  });
  assert.equal(card(view({ workspaces: [ws("Alpha", "failed")] })).text, "The workspace could not be started. Delete it and make a new one. If it fails again, tell the operator.");
});

test("a late payment says when the workspaces stop, or that they are stopped, and the one thing to do is to update the payment details", () => {
  const action = { kind: "billing", label: "Update payment details" };
  assert.deepEqual(card(view({ subscription: LATE, workspaces: [ws("A", "running")] })), { tone: "warn", title: "Your last payment did not go through", text: "Your workspaces keep running until October 8, 2026 and are then stopped. A payment before then puts everything back.", action, also: { kind: "open", label: "Open" } }, "a workspace that is still running can be opened from the card: the payment is first, and the work is not behind it");
  assert.equal(card(view({ subscription: LATE, workspaces: [ws("A", "suspended")] })).also, undefined, "one that is stopped has nothing to open");
  assert.equal(card(view({ subscription: LATE, workspaces: [ws("A", "running")], policy: { ...PLANS.policy, graceDays: 7 } })).text.slice(0, 55), "Your workspaces keep running until October 12, 2026 and", "the day follows the service's own grace period");
  assert.equal(card(view({ subscription: { ...LATE, pastDueSince: undefined } })).text, "Your workspaces are stopped after a short grace period. A payment before then puts everything back.", "no day is made up when the service gives none");
  assert.equal(card(view({ subscription: LATE, policy: null })).text, "Your workspaces are stopped after a short grace period. A payment before then puts everything back.");
  assert.equal(card(view({ subscription: LATE, workspaces: [ws("A", "suspended", { statusReason: "payment is overdue" })] })).text, "Your workspaces were stopped because of it. A payment puts everything back.");
  assert.equal(card(view({ subscription: LATE })).action.kind, "billing", "with no workspace the way out of a late payment is still the same");
});

// ---- which parts of the page are shown ----

test("the account shows workspaces when there are some, plans to choose from until there is one, and credit and usage only for a plan that sells model usage", () => {
  const sections = (v: ReturnType<typeof view>) => h.sectionsOf(v);
  assert.deepEqual(sections(view({ subscription: null })), { workspaces: false, plan: "choose", balance: false, usage: false });
  assert.deepEqual(sections(view({ subscription: { plan: "team", title: "Team", status: "ended" } })), { workspaces: false, plan: "choose", balance: false, usage: false });
  assert.deepEqual(sections(view()), { workspaces: false, plan: "summary", balance: true, usage: false }, "a plan that sells usage has a balance from the start, and nothing to report");
  assert.deepEqual(sections(view({ workspaces: [ws("A", "running")] })), { workspaces: true, plan: "summary", balance: true, usage: true });
  assert.deepEqual(sections(view({ usageCalls: 3 })), { workspaces: false, plan: "summary", balance: true, usage: true }, "and what was used stays shown when the workspace that used it is gone");
  assert.deepEqual(sections(view({ subscription: LATE, workspaces: [ws("A", "running")] })), { workspaces: true, plan: "summary", balance: true, usage: true });
  assert.deepEqual(sections(hostingView([ws("A", "running", { models: own(null) })])), { workspaces: true, plan: "summary", balance: false, usage: false }, "a plan that sells hosting only has none");
  assert.deepEqual(sections(view({ topups: null, workspaces: [ws("A", "running")] })), { workspaces: true, plan: "summary", balance: false, usage: false }, "and neither has a service that sells no credit at all");
  assert.deepEqual(sections(view({ plans: [], plansKnown: false, topups: null, workspaces: [ws("A", "running")] })).balance, true, "plans that could not be read do not take the balance away");
  assert.deepEqual(sections(view({ plans: [], plansKnown: false, workspaces: [ws("A", "running", { models: own(null) })] })).balance, false, "unless a workspace says its models are the customer's own");
});

// ---- the page ----

const mainFocusable = (v: Visit): FakeNode[] =>
  v.doc
    .querySelector("main")!
    .querySelectorAll("a, button, input, select, textarea")
    .filter((n) => v.shows(n) && !n.disabled && n.getAttribute("type") !== "hidden");

test("the card is the first thing on the account after its heading, and its action is the first thing a keyboard reaches", async () => {
  const cases: Array<[string, () => ReturnType<typeof world>]> = [
    ["no plan", () => world()],
    ["a plan and no workspace", () => world(paid)],
    ["a workspace to open", () => world((x) => { paid(x); x.workspaces = [workspace()]; })],
    ["a workspace that is stopped", () => world((x) => { paid(x); x.workspaces = [workspace({ status: "suspended", statusReason: "paused by its owner" })]; })],
    ["a late payment", () => world((x) => { x.subscription = LATE; x.workspaces = [workspace()]; })],
    ["a key that is missing", () => hosting()],
  ];
  for (const [what, make] of cases) {
    const v = await visit("account", { routes: make().routes });
    const blocks = v.doc.querySelector("main .wrap")!.children.filter((n) => !n.isText);
    const at = (id: string): number => blocks.findIndex((n) => n.id === id);
    assert.equal(blocks[0]!.className, "account-head", `${what}: the heading is first`);
    assert.ok(blocks[0]!.contains(v.doc.querySelector("h1")));
    assert.ok(at("stage") > 0 && blocks.slice(0, at("stage")).every((n) => n.className === "account-head" || n.tag === "noscript" || n.id === "notice"), `${what}: nothing but the heading, the notice and what a browser with no script is told comes before the card`);
    for (const panel of blocks.filter((n) => n.tag === "section" && n.className.split(/\s+/).includes("panel"))) assert.ok(blocks.indexOf(panel) > at("stage"), `${what}: ${panel.id} is after the card`);
    const first = mainFocusable(v)[0]!;
    assert.ok(v.$("stage").contains(first), `${what}: the first thing a keyboard reaches is in the card, and is ${first.tag} ${first.id || first.textContent}`);
  }
});

test("each stage is said on the page: its title and sentence, the steps while a person is getting started, a tone for what needs attention, and one action", async () => {
  const stage = async (w: ReturnType<typeof world>) => {
    const v = await visit("account", { routes: w.routes });
    return { v, steps: v.text("stage-steps"), title: v.text("stage-title"), actions: v.labels("stage-actions"), tone: v.$("stage").className };
  };
  let s = await stage(world(paid));
  assert.deepEqual([s.title, s.steps, s.actions.length, s.tone], ["Make your first workspace", "✓ Plan (done) 2 Workspace (you are here) 3 Open (still to do)", 1, "stage"]);
  assert.equal(s.v.text("stage-actions"), "Name a new workspace Create workspace");

  s = await stage(world((x) => { paid(x); x.workspaces = [workspace({ status: "provisioning" })]; }));
  assert.deepEqual([s.title, s.steps, s.actions], ["Research is starting", "✓ Plan (done) 2 Workspace (you are here) 3 Open (still to do)", []]);

  s = await stage(world((x) => { paid(x); x.workspaces = [workspace()]; }));
  assert.deepEqual([s.title, s.actions, s.tone], ["Research is running", ["Open"], "stage"]);
  assert.equal(s.v.shows(s.v.$("stage-steps")), false, "a person whose workspace can be opened is not shown the steps of getting started");
  assert.equal(s.v.button("stage-actions", "Open").getAttribute("aria-label"), "Open Research");

  s = await stage(world((x) => { paid(x); x.workspaces = [workspace({ status: "suspended", statusReason: "paused by its owner" })]; }));
  assert.deepEqual([s.title, s.actions, s.v.text("stage-text")], ["Research is paused", ["Resume"], "Its files are kept. Resume it to open it."]);

  s = await stage(world((x) => { paid(x); x.workspaces = [workspace({ status: "failed", statusReason: "the container did not start" })]; }));
  assert.deepEqual([s.title, s.tone, s.actions], ["Research could not start", "stage stage-bad", []]);
  assert.equal(s.v.text("stage-text"), "The container did not start. Delete it and make a new one. If it fails again, tell the operator. Contact the operator.");
  assert.equal(s.v.link("stage-text", "Contact the operator").getAttribute("href"), "mailto:ali79taba@gmail.com", "and says whom: the operator's own address, which they gave");
  const none = await visit("account", { routes: world((x) => { paid(x); x.workspaces = [workspace({ status: "failed" })]; }).routes, script: (src) => src.replace(/const CONTACT = "[^"]*";/, 'const CONTACT = "";') });
  assert.equal(none.doc.querySelectorAll("a").filter((a) => a.textContent === "Contact the operator").length, 0, "with no address given none is made up");

  s = await stage(hosting());
  assert.deepEqual([s.title, s.actions, s.steps], ["Add your model key", ["Add your model key"], "✓ Plan (done) ✓ Workspace (done) 3 Model key (you are here) 4 Open (still to do)"]);

  s = await stage(world());
  assert.equal(s.steps, "1 Plan (you are here) 2 Workspace (still to do) 3 Open (still to do)");
  assert.equal(s.v.doc.getElementById("stage-steps")!.querySelectorAll("li").filter((li) => li.getAttribute("aria-current") === "step").length, 1, "one step is the current one, for what reads the page aloud");
  assert.ok(s.v.doc.getElementById("stage-steps")!.querySelectorAll("span").filter((n) => n.className === "num").every((n) => n.getAttribute("aria-hidden") === "true"), "and the numbers are for the eye: the words say it all");
  assert.equal(s.v.$("stage-steps").getAttribute("aria-label"), "Where you are");

  assert.equal(s.v.$("stage").getAttribute("aria-labelledby"), "stage-title", "the card is a region named by what it says");
  assert.equal(s.v.$("stage-title").getAttribute("tabindex"), "-1", "its title can be given the cursor, and is not a stop of the tab key");
  const live = s.v.$("stage-live");
  assert.deepEqual([live.getAttribute("role"), live.getAttribute("aria-live"), live.className], ["status", "polite", "sr"], "what it says when it changes is announced politely, to a screen reader and to nobody else");
});

test("what the card offers is done from the card: open the workspace, resume it, add its key, and a request that is out holds the button", async () => {
  const open = world((x) => { paid(x); x.workspaces = [workspace()]; });
  open.answers.set("POST /api/workspaces/ws_1/open", { json: { url: "https://research-1a2b3c.ws.example.com/__enter?code=abc" } });
  const v = await visit("account", { routes: open.routes });
  v.click(v.button("stage-actions", "Open"));
  assert.equal(v.button("stage-actions", "Open").held, true, "while the request is out the button is held");
  await v.idle();
  assert.deepEqual(v.navigations, ["assign https://research-1a2b3c.ws.example.com/__enter?code=abc"]);
  assert.equal(v.to("POST", "/api/workspaces/ws_1/open").length, 1);

  const paused = world((x) => { paid(x); x.workspaces = [workspace({ status: "suspended", statusReason: "paused by its owner" })]; });
  paused.answers.set("POST /api/workspaces/ws_1/resume", () => {
    paused.workspaces = [workspace()];
    return { json: { workspace: paused.workspaces[0] } };
  });
  const p = await visit("account", { routes: paused.routes });
  p.click(p.button("stage-actions", "Resume"));
  await p.idle();
  assert.equal(p.to("POST", "/api/workspaces/ws_1/resume").length, 1);
  assert.equal(p.text("stage-title"), "Research is running", "and the card says what is now true");

  const keyless = await visit("account", { routes: hosting().routes });
  keyless.click(keyless.button("stage-actions", "Add your model key"));
  assert.equal(keyless.doc.activeElement, keyless.$("key-model-ws_1"), "the cursor goes to the field the key needs first: the model");
  keyless.type("key-model-ws_1", "claude-sonnet-4-5");
  keyless.click(keyless.button("stage-actions", "Add your model key"));
  assert.equal(keyless.doc.activeElement, keyless.$("key-secret-ws_1"), "and, once it is named, to the key");

  const late = world((x) => { x.subscription = LATE; x.workspaces = [workspace()]; });
  late.answers.set("POST /api/portal", failure(409, "no_portal", "There is no billing portal for payments made by invoice or transfer. Contact the operator to change or cancel a plan."));
  const l = await visit("account", { routes: late.routes });
  l.click(l.button("stage-actions", "Update payment details"));
  await l.idle();
  assert.equal(l.text("plan-status"), "There is no billing portal for payments made by invoice or transfer. Contact the operator to change or cancel a plan.", "a service that has no portal says so in its own words");
  assert.equal(l.button("stage-actions", "Update payment details").disabled, false);
});

test("a late payment puts the payment first and keeps Open beside it for a workspace that still runs, which is how a person comes back to work", async () => {
  const w = world((x) => { x.subscription = LATE; x.workspaces = [workspace()]; });
  w.answers.set("POST /api/workspaces/ws_1/open", { json: { url: "https://research-1a2b3c.ws.example.com/__enter?code=abc" } });
  const v = await visit("account", { routes: w.routes });
  assert.deepEqual(v.labels("stage-actions"), ["Update payment details", "Open"]);
  assert.deepEqual(v.buttons("stage-actions").map((b) => b.className), ["btn btn-primary", "btn"], "the payment is the main thing, and Open is the lesser of the two");
  assert.equal(v.button("stage-actions", "Open").getAttribute("aria-label"), "Open Research");
  v.click(v.button("stage-actions", "Open"));
  await v.idle();
  assert.deepEqual(v.navigations, ["assign https://research-1a2b3c.ws.example.com/__enter?code=abc"]);

  const stopped = await visit("account", { routes: world((x) => { x.subscription = LATE; x.workspaces = [workspace({ status: "suspended", statusReason: "payment is overdue" })]; }).routes });
  assert.deepEqual(stopped.labels("stage-actions"), ["Update payment details"], "a workspace that was stopped for it has nothing to open");
});

test("the form for a first workspace is in the card, goes back to the workspaces once there is one, and a look at the account does not empty it", async () => {
  const w = world(paid);
  w.answers.set("POST /api/workspaces", (call) => {
    w.workspaces = [workspace({ name: String((call.body as { name: string }).name), status: "provisioning" })];
    return { status: 201, json: { workspace: w.workspaces[0] } };
  });
  // The page is told it is waiting for a payment, so it looks at the account again, as it does for any change that is on its way.
  const v = await visit("account", { routes: w.routes, search: "?paid=1", storage: { "curule:before-payment": JSON.stringify([["team", "active", "2026-11-05T12:00:00.000Z"], [20_000_000, 0]]) } });
  const form = v.$("create");
  const firstStep = v.$("stage-steps").querySelectorAll("li")[0]!;
  assert.ok(v.$("stage-actions").contains(v.$("create-box")), "the form is in the card");
  assert.equal(v.shows(v.$("workspaces-panel")), false, "and the workspaces have nothing to list");
  assert.equal(v.text("create-note"), "");
  v.type("workspace-name", "Rese");
  const looks = v.to("GET", "/api/me").length;
  await v.until("the page to look at the account again", () => v.to("GET", "/api/me").length >= looks + 2);
  assert.ok(v.$("create") === form, "the form was not drawn again");
  assert.ok(v.$("stage-steps").querySelectorAll("li")[0] === firstStep, "nor was the card: a card that is drawn again takes the cursor from a field in it, in a browser");
  assert.equal(v.$("workspace-name").value, "Rese", "and what was typed in it is still there");

  v.type("workspace-name", "Research");
  await v.send(v.$("create"));
  assert.ok(v.$("create-slot").contains(v.$("create-box")), "once there is a workspace the form is in the workspaces again");
  assert.ok(!v.$("stage-actions").contains(v.$("create-box")));
  assert.equal(v.shows(v.$("workspaces-panel")), true);
  assert.equal(v.doc.activeElement, v.$("stage-title"), "and the cursor is on what the card says now, not in a form that went");
  assert.equal(v.text("stage-title"), "Research is starting");
  assert.equal(v.text("stage-live"), "Research is starting. This page checks every few seconds and shows when it is ready.", "which a screen reader is told, once");
});

test("a card that says something else is announced once, and one that says the same is left alone: no announcement and no cursor taken for a look at the account", async () => {
  const w = world();
  const v = new Visit("account", { routes: w.routes, search: "?paid=1", storage: { "curule:before-payment": JSON.stringify([null, [20_000_000, 0]]) } });
  const started = v.start();
  await v.until("the page to say it is waiting", () => /being confirmed|confirms a payment/.test(v.text("notice")));
  assert.equal(v.text("stage-live"), "", "nothing was announced for what was there when the page opened");
  v.type("current", "typing in the password form while the page waits");
  w.subscription = ACTIVE;
  await started;
  await v.until("the payment to be seen", () => v.text("notice") === "Your payment has arrived.");
  assert.equal(v.text("stage-title"), "Make your first workspace");
  assert.equal(v.text("stage-live"), "Make your first workspace. Your Team plan is active. A workspace is your own Curule host, with its own projects, event log and files.");
  assert.equal(v.doc.activeElement, v.$("current"), "and the cursor was not taken from the person who was typing");
  assert.equal(v.$("current").value, "typing in the password form while the page waits");
});

test("a workspace that becomes ready is announced and the card offers to open it; one that is still starting after ten minutes of looking says the page has stopped", async () => {
  const w = world((x) => { paid(x); x.workspaces = [workspace({ status: "provisioning" })]; });
  const v = await visit("account", { routes: w.routes });
  assert.equal(v.text("stage-live"), "");
  w.workspaces = [workspace()];
  await v.until("the workspace to be seen running", () => v.text("stage-title") === "Research is running");
  assert.equal(v.text("stage-live"), "Research is running. Open it to describe your team and start a mission.");
  assert.deepEqual(v.labels("stage-actions"), ["Open"]);

  const never = world((x) => { paid(x); x.workspaces = [workspace({ status: "provisioning" })]; });
  const s = await visit("account", { routes: never.routes });
  await s.until("the page to stop looking", () => /stopped checking/.test(s.text("stage-text")), 15_000);
  assert.equal(s.text("stage-text"), "This page has stopped checking. Reload it to look again.");
  assert.equal(s.to("GET", "/api/me").length, 201, "one look on arrival and two hundred while it waited: ten minutes, as the page says");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(s.to("GET", "/api/me").length, 201, "and it does not look again once it has said it has stopped");
});

test("a page in a tab that is not shown does not look at the account while a workspace starts, and goes on when the tab is shown", async () => {
  const w = world((x) => { paid(x); x.workspaces = [workspace({ status: "provisioning" })]; });
  const v = new Visit("account", { routes: w.routes });
  v.doc.visibilityState = "hidden";
  await v.start();
  const looks = v.to("GET", "/api/me").length;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(v.to("GET", "/api/me").length, looks, "a tab that nobody is looking at asks for nothing");
  v.doc.visibilityState = "visible";
  await v.until("the page to look again", () => v.to("GET", "/api/me").length > looks);
});

test("the workspace's own button is not a second one of the same weight when the card at the top offers the same thing, and is the main one when it does not", async () => {
  const one = await visit("account", { routes: world((x) => { paid(x); x.workspaces = [workspace()]; }).routes });
  assert.equal(one.button("stage-actions", "Open").className, "btn btn-primary");
  assert.equal(one.button("workspaces", "Open").className, "btn", "the workspace's Open is the same thing, said again where the workspace is");

  const paused = await visit("account", { routes: world((x) => { paid(x); x.workspaces = [workspace({ status: "suspended", statusReason: "paused by its owner" })]; }).routes });
  assert.equal(paused.button("stage-actions", "Resume").className, "btn btn-primary");
  assert.equal(paused.button("workspaces", "Resume").className, "btn");

  const two = await visit("account", { routes: world((x) => { x.subscription = { ...ACTIVE!, plan: "business", title: "Business" }; x.workspaces = [workspace({ workspaceId: "ws_a", name: "Alpha" }), workspace({ workspaceId: "ws_b", name: "Beta" })]; }).routes });
  assert.deepEqual(two.labels("stage-actions"), [], "with two to open the card does not choose");
  assert.deepEqual(two.buttons("workspaces").filter((b) => b.textContent === "Open").map((b) => b.className), ["btn btn-primary", "btn btn-primary"], "so each is the main button of its own");

  const mixed = await visit("account", { routes: world((x) => { x.subscription = { ...ACTIVE!, plan: "business", title: "Business" }; x.workspaces = [workspace({ workspaceId: "ws_a", name: "Alpha" }), workspace({ workspaceId: "ws_b", name: "Beta", status: "suspended", statusReason: "paused by its owner" })]; }).routes });
  assert.equal(mixed.button("workspaces", "Open").className, "btn", "the one the card is about");
  assert.equal(mixed.button("workspaces", "Resume").className, "btn btn-primary", "and one that it is not about keeps its own main button");

  const stopped = (workspaceId: string, name: string) => workspace({ workspaceId, name, status: "suspended", statusReason: "paused by its owner" });
  const twoPaused = await visit("account", { routes: world((x) => { x.subscription = { ...ACTIVE!, plan: "business", title: "Business" }; x.workspaces = [stopped("ws_a", "Alpha"), stopped("ws_b", "Beta")]; }).routes });
  const [alpha, beta] = twoPaused.$("workspaces").querySelectorAll("li");
  assert.equal(twoPaused.text("stage-title"), "Alpha is paused");
  assert.equal(twoPaused.button(alpha!, "Resume").className, "btn", "the card is about the first, and offers its Resume");
  assert.equal(twoPaused.button(beta!, "Resume").className, "btn btn-primary", "and the second one's Resume is not made weaker by a button that is for another workspace");
});

test("the account is as long as the person's stage needs: only what they can use is shown, and the password is a setting at the end", async () => {
  const shown = (v: Visit) => ["workspaces-panel", "plan-panel", "balance-panel", "usage-panel"].filter((id) => v.shows(v.$(id)));

  const visitor = await visit("account", { routes: world().routes });
  assert.deepEqual(shown(visitor), ["plan-panel"]);
  assert.equal(visitor.text("plan-h"), "Choose a plan");

  const first = await visit("account", { routes: world(paid).routes });
  assert.deepEqual(shown(first), ["plan-panel", "balance-panel"], "a plan that sells usage has a balance and no usage to show before there is a workspace");
  assert.equal(first.to("GET", "/api/usage").length, 1, "usage is asked for, so that what was used is shown if there is some");

  const using = await visit("account", { routes: world((x) => { paid(x); x.workspaces = [workspace()]; }).routes });
  assert.deepEqual(shown(using), ["workspaces-panel", "plan-panel", "balance-panel", "usage-panel"]);

  const hostingOnly = await visit("account", { routes: hosting().routes });
  assert.deepEqual(shown(hostingOnly), ["workspaces-panel", "plan-panel"], "the key is in the workspace's card");

  const remembered = world(paid);
  remembered.usage = { currency: "USD", byDay: [], byWorkspace: [{ group: "ws_gone", calls: 2, failed: 0, inputTokens: 5, outputTokens: 5, cachedTokens: 0, chargedMicros: 90 }], total: { calls: 2, failed: 0, inputTokens: 5, outputTokens: 5, cachedTokens: 0, chargedMicros: 90 } };
  const r = await visit("account", { routes: remembered.routes });
  assert.deepEqual(shown(r), ["plan-panel", "balance-panel", "usage-panel"], "what was used is not hidden because the workspace that used it was deleted");

  const nothing = hosting();
  nothing.balance = balance({ included: 0, available: 0 });
  const zero = await visit("account", { routes: nothing.routes });
  assert.equal(zero.text("notice"), "", "a plan that sells no usage has no balance to be used up, whatever the service says of one");
  const buying = world((x) => { x.plans = { json: HOSTING_PLANS }; x.balance = null; });
  const back = new Visit("account", { routes: buying.routes, search: "?paid=1", storage: { "curule:before-payment": JSON.stringify([null, null]) } });
  const arriving = back.start();
  await back.until("the page to say it is waiting", () => /confirms a payment/.test(back.text("notice")));
  buying.subscription = HOSTING_SUB;
  await arriving;
  await back.until("the payment to be seen", () => back.text("notice") === "Your payment has arrived.");
  await back.idle();
  assert.equal(back.to("GET", "/api/usage").length, 0, "and a payment that arrives while the page waits for it does not ask for usage that is not sold");

  for (const section of visitor.doc.querySelectorAll("main section")) {
    const named = visitor.doc.getElementById(section.getAttribute("aria-labelledby") ?? "");
    assert.ok(named && named.tag === "h2", `${section.id || section.className} is a region named by its heading`);
  }
  for (const v of [visitor, first, using, hostingOnly]) {
    const panels = v.doc.querySelector("main .wrap")!.children.filter((n) => n.tag === "section" && n.className.split(/\s+/).includes("panel") && v.shows(n));
    const last = panels[panels.length - 1]!;
    assert.equal(last.className, "panel panel-quiet");
    assert.equal(v.text(last.querySelector("h2")!), "Settings", "the password comes last, under a quiet heading of its own");
    assert.equal(v.text(last.querySelector("h3")!), "Change your password");
    assert.equal(v.$("password-form").getAttribute("aria-labelledby"), "password-h");
  }
});

test("a plan that is chosen, a payment that was cancelled and a payment that is late each leave the card saying what to do, and nothing is said twice", async () => {
  const w = world();
  w.answers.set("POST /api/checkout", { json: { url: "https://pay.example/c/abc" } });
  const v = await visit("account", { routes: w.routes });
  v.click(v.button("plan", "Choose Team"));
  await v.idle();
  assert.deepEqual(v.navigations, ["assign https://pay.example/c/abc"]);

  const back = await visit("account", { routes: world().routes, search: "?cancelled=1" });
  assert.equal(back.text("notice"), "Checkout was cancelled. Nothing was charged. Choose a plan below when you are ready.");
  assert.equal(back.text("stage-title"), "Choose a plan", "and the way to try again is where it was");
  const late = await visit("account", { routes: world((x) => { x.subscription = LATE; x.workspaces = [workspace({ status: "suspended", statusReason: "payment is overdue" })]; }).routes, search: "?cancelled=1" });
  assert.equal(late.text("notice"), "Checkout was cancelled. Nothing was charged, and your plan and balance are as they were.", "a payment that was late is still late, and the card says what to do about it");
  assert.equal(late.text("stage-title"), "Your last payment did not go through");
  const spent = await visit("account", { routes: world((x) => { paid(x); x.balance = balance({ included: 0, available: 0 }); }).routes });
  assert.match(spent.text("notice"), /^Your balance is used up\./);
  assert.equal(spent.text("stage-title"), "Make your first workspace", "a balance that is gone is not a stage: the card is for what is next");
});
