/**
 * A workspace's card on the account: what it says of itself in a sentence, what can be done to it, the model key where the plan has one,
 * and the offer to open it as soon as it is ready. The pure parts are tried on tables; the page is the real page file with the real script,
 * as in pages-app.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Visit, helpers, visit } from "./pages-support";
import { ACTIVE, HOSTING_PLANS, HOSTING_SUB, KEPT, NOW, PLANS, SECRET, failure, hosting, paid, workspace, world, type Subscription, type WorkspaceView } from "./pages-world";

const h = helpers();

const LATE: Subscription = { plan: "team", title: "Team", status: "past_due", periodEnd: "2026-11-05T12:00:00.000Z", pastDueSince: "2026-10-05T12:00:00.000Z" };
const ENDED: Subscription = { plan: "team", title: "Team", status: "ended" };
const view = (subscription: Subscription) => ({ subscription, workspaces: [], plans: PLANS.plans, plansKnown: true, topups: PLANS.topups, policy: PLANS.policy });
const ws = (status: string, over: Partial<WorkspaceView> = {}): WorkspaceView => workspace({ status, ...over });
const own = (key: typeof KEPT | null) => ({ source: "own" as const, key });
const ENTER = "https://research-1a2b3c.ws.example.com/__enter?code=abc";

// ---- what a workspace says of itself ----

test("a workspace says in a sentence why it is as it is and what can be done, and one that is ready says no more than its state and its Open", () => {
  const says = (w: WorkspaceView, sub: Subscription = ACTIVE) => h.workspaceSays(w, view(sub));
  assert.equal(says(ws("running")), "", "a workspace that is ready says nothing the badge and the button do not");
  assert.equal(says(ws("running", { models: own(KEPT) })), "");
  assert.equal(says(ws("running", { models: own(null) })), "Its team has no model yet. Give it your model key to put it to work.");
  for (const status of ["requested", "provisioning"]) assert.equal(says(ws(status)), "It starts in the background, and this page updates when it is ready.");

  assert.equal(says(ws("suspended", { statusReason: "paused by its owner" })), "Paused by you. Its files are kept. Resume it to open it.");
  assert.equal(says(ws("suspended", { statusReason: "payment is overdue" })), "Stopped because the last payment did not go through. Resume it to open it.", "once the plan is paid up it can be started");
  assert.equal(says(ws("suspended", { statusReason: "the account was stopped: abuse report 12" })), "The account was stopped: abuse report 12. Resume it to open it.");
  assert.equal(says(ws("suspended")), "It is not running. Resume it to open it.");

  assert.equal(says(ws("suspended", { statusReason: "payment is overdue" }), LATE), "Stopped because the last payment did not go through. A payment starts it again.", "while the payment is missing the service starts none, and starts them all when it comes");
  assert.equal(says(ws("suspended", { statusReason: "paused by its owner" }), LATE), "Paused by you. Its files are kept. A payment starts it again.");
  assert.equal(says(ws("suspended", { statusReason: "the subscription ended" }), ENDED), "Stopped because the subscription ended. Choose a plan again and it starts again.");
  assert.equal(says(ws("suspended", { statusReason: "the subscription ended" }), null), "Stopped because the subscription ended. Choose a plan again and it starts again.");

  assert.equal(says(ws("failed", { statusReason: "the container did not start" })), "The container did not start. Delete it and make a new one. If it fails again, tell the operator.");
  assert.equal(says(ws("failed")), "The workspace could not be started. Delete it and make a new one. If it fails again, tell the operator.");
});

test("a person can start a stopped workspace only while the plan is paid up, which is when the service starts one", () => {
  const can = (w: WorkspaceView, sub: Subscription) => h.resumable(w, view(sub));
  assert.equal(can(ws("suspended"), ACTIVE), true);
  assert.equal(can(ws("suspended"), LATE), false, "the service answers that a payment is needed");
  assert.equal(can(ws("suspended"), ENDED), false);
  assert.equal(can(ws("suspended"), null), false);
  for (const status of ["running", "provisioning", "requested", "failed"]) assert.equal(can(ws(status), ACTIVE), false, `${status} is not stopped`);
});

test("a workspace that is stopped for a payment that is missing offers no Resume, which the service would refuse, and says what starts it", async () => {
  const late = world((x) => { x.subscription = LATE; x.workspaces = [ws("suspended", { statusReason: "payment is overdue" })]; });
  const l = await visit("account", { routes: late.routes });
  assert.deepEqual(l.labels("workspaces"), ["More"]);
  assert.equal(l.text(l.$("workspaces").querySelectorAll("li")[0]!), "Research Stopped Stopped because the last payment did not go through. A payment starts it again. More Address research-1a2b3c.ws.example.com");
  assert.equal(l.text("stage-title"), "Your last payment did not go through");
  assert.deepEqual(l.labels("stage-actions"), ["Update payment details"], "and the one thing to do is said at the top");

  const ended = world((x) => { x.subscription = ENDED; x.workspaces = [ws("suspended", { statusReason: "the subscription ended" })]; });
  const e = await visit("account", { routes: ended.routes });
  assert.deepEqual(e.labels("workspaces"), ["More"]);
  assert.match(e.text("workspaces"), /Stopped because the subscription ended\. Choose a plan again and it starts again\./);
  assert.equal(e.text("stage-title"), "Choose a plan to start again");

  const paid = world((x) => { x.subscription = ACTIVE; x.workspaces = [ws("suspended", { statusReason: "payment is overdue" })]; });
  const p = await visit("account", { routes: paid.routes });
  assert.deepEqual(p.labels("workspaces"), ["Resume", "More"], "once the plan is paid up it can be started, whatever stopped it");
});

// ---- the card itself ----

test("a card is a name and state, a sentence, what can be done, and the address as a quiet detail at the end", async () => {
  const v = await visit("account", { routes: world((x) => { paid(x); x.workspaces = [ws("suspended", { statusReason: "paused by its owner" })]; }).routes });
  const card = v.$("workspaces").querySelectorAll("li")[0]!;
  assert.deepEqual(card.children.map((n) => n.className), ["row-head", "ws-says", "ws-auto", "ws-actions", "ws-key", "ws-confirm", "ws-note sr", "muted small ws-address"]);
  assert.equal(v.text(card.querySelector(".row-head")!), "Research Stopped");
  assert.equal(v.text(card.querySelector(".ws-says")!), "Paused by you. Its files are kept. Resume it to open it.");
  assert.equal(v.text(card.querySelector(".ws-address")!), "Address research-1a2b3c.ws.example.com");
  assert.equal(card.querySelector(".ws-address code")!.textContent, "research-1a2b3c.ws.example.com");
  const state = card.querySelector(".row-head .badge")!;
  assert.ok(state.textContent === "Stopped", "the state is a word as well as a colour");
});

test("the status line of a card stays where it is and says what is under way and what came of it, so that a change in it is read out", async () => {
  const w = world((x) => { paid(x); x.workspaces = [ws("running")]; });
  w.answers.set("POST /api/workspaces/ws_1/suspend", failure(409, "not_running", "That workspace is not running."));
  const v = await visit("account", { routes: w.routes });
  const line = v.$("workspaces").querySelector(".ws-note")!;
  assert.deepEqual([line.getAttribute("role"), line.getAttribute("aria-live"), v.text(line), line.className], ["status", "polite", "", "ws-note sr"], "while it says nothing it is out of sight and not out of the page, so that it is read out when it fills");
  v.click(v.button("workspaces", "Pause"));
  assert.equal(v.text(line), "Pausing it.");
  await v.idle();
  assert.equal(v.text(line), "That workspace is not running.");
  assert.equal(line.className, "note note-bad ws-note", "a refusal looks like one");
  assert.ok(v.$("workspaces").querySelector(".ws-note") === line, "it is the same line: one that is drawn new is not always read out");
});

test("a request that is out holds the buttons of the card and of the card at the top without drawing them again, so the cursor stays where it was", async () => {
  const w = world((x) => { paid(x); x.workspaces = [ws("running")]; });
  w.answers.set("POST /api/workspaces/ws_1/open", { json: { url: ENTER } });
  const v = await visit("account", { routes: w.routes });
  const stageOpen = v.$("stage-open");
  stageOpen.focus();
  v.click(stageOpen);
  assert.ok(v.$("stage-open") === stageOpen && v.doc.activeElement === stageOpen, "the button in the card at the top is the same button, with the cursor");
  assert.equal(stageOpen.held, true);
  assert.ok(v.buttons("workspaces").every((b) => b.held), "and the card's own buttons are held with it");
  await v.idle();
  assert.equal(v.$("stage-open").held, false, "and are free again afterwards");
  assert.deepEqual(v.navigations, [`assign ${ENTER}`]);
});

test("one card is drawn again only when it changes: another workspace's More leaves this one's buttons as they were", async () => {
  const w = world((x) => {
    x.subscription = { ...ACTIVE!, plan: "business", title: "Business" };
    x.workspaces = [ws("running", { workspaceId: "ws_a", name: "Alpha" }), ws("running", { workspaceId: "ws_b", name: "Beta" })];
  });
  const v = await visit("account", { routes: w.routes });
  const [alpha, beta] = v.$("workspaces").querySelectorAll("li");
  const pause = v.$("pause-ws_b");
  v.click(v.$("more-ws_a"));
  assert.equal(v.shows(v.$("delete-ws_a")), true);
  assert.equal(v.doc.activeElement, v.$("more-ws_a"), "the cursor is on the button that was pressed");
  assert.ok(v.$("pause-ws_b") === pause, "Beta's button was not drawn again for something that happened to Alpha");
  assert.ok(v.$("workspaces").querySelectorAll("li")[0] === alpha && v.$("workspaces").querySelectorAll("li")[1] === beta, "and the cards are the same cards");
});

// ---- the model key, in the card ----

test("a workspace with a key kept says which; Replace key opens the form with the cursor in the key and closing it puts away what was typed; Remove key is one request", async () => {
  const w = hosting({ source: "own", key: KEPT });
  w.answers.set("POST /api/workspaces/ws_1/model-key", () => {
    w.workspaces = [workspace({ plan: "hosting", models: { source: "own", key: { ...KEPT, model: "claude-opus-4", setAt: "2026-10-06T08:00:00.000Z" } } })];
    return { json: { workspace: w.workspaces[0] } };
  });
  w.answers.set("POST /api/workspaces/ws_1/model-key/delete", () => {
    w.workspaces = [workspace({ plan: "hosting", models: { source: "own", key: null } })];
    return { json: { workspace: w.workspaces[0] } };
  });
  const v = await visit("account", { routes: w.routes });
  const toggle = v.$("key-toggle-ws_1");
  assert.deepEqual([toggle.getAttribute("aria-expanded"), toggle.getAttribute("aria-controls"), v.shows(v.$("key-replace-ws_1"))], ["false", "key-replace-ws_1", false]);
  assert.match(v.text(v.$("workspaces").querySelector(".ws-key")!), /^Model key Key kept Anthropic, model claude-sonnet-4-5\. Set October 5, 2026\. The key itself is never shown again\. Replace key Remove key$/);

  v.click(toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(v.doc.querySelector('label[for="key-secret-ws_1"]')!.textContent, "New key", "it is a new key that is asked for");
  const line = v.$("key-note-ws_1");
  assert.deepEqual([line.getAttribute("role"), line.getAttribute("aria-live")], ["status", "polite"], "and what becomes of it is said where it is read out");
  assert.equal(v.doc.activeElement, v.$("key-secret-ws_1"), "the model is filled in already, so the cursor goes to the key");
  assert.equal(v.$("key-model-ws_1").value, "claude-sonnet-4-5");
  assert.equal(v.$("key-secret-ws_1").value, "");
  assert.deepEqual(v.labels(v.$("key-form-ws_1")), ["Save new key"]);
  v.type("key-secret-ws_1", SECRET);
  toggle.focus();
  v.click(toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(v.shows(v.$("key-form-ws_1")), false);
  assert.equal(v.$("key-secret-ws_1").value, "", "a key that was typed and not sent is not left in a field that is put away");

  v.click(toggle);
  v.type("key-model-ws_1", "claude-opus-4");
  v.type("key-secret-ws_1", `  ${SECRET} `);
  v.submit(v.$("key-form-ws_1"));
  assert.match(v.text("key-note-ws_1"), /Keeping it, and starting the workspace again with it\./);
  assert.ok(v.buttons(v.$("workspaces").querySelector(".ws-key")!).every((b) => b.held), "while the key is on its way the buttons are held");
  await v.idle();
  assert.deepEqual(v.to("POST", "/api/workspaces/ws_1/model-key").map((c) => c.body), [{ provider: "anthropic", model: "claude-opus-4", key: SECRET }]);
  assert.match(v.text("notice"), /The key for Research is kept, and the workspace was started again with it\./);
  assert.match(v.text(v.$("workspaces").querySelector(".ws-key")!), /Anthropic, model claude-opus-4\. Set October 6, 2026\./);
  assert.equal(v.shows(v.$("key-form-ws_1")), false, "once it is kept the form is put away again");
  assert.ok(!v.doc.root.descendants().some((n) => n.textContent.includes(SECRET) || n.value === SECRET), "and the key is nowhere in the page");

  v.click(v.button("workspaces", "Remove key"));
  assert.match(v.text("key-note-ws_1"), /Removing it, and starting the workspace again without it\./);
  assert.ok(v.buttons(v.$("workspaces").querySelector(".ws-key")!).every((b) => b.held), "while it is out the buttons are held");
  await v.idle();
  assert.equal(v.to("POST", "/api/workspaces/ws_1/model-key/delete").length, 1);
  assert.match(v.text("notice"), /The key for Research is removed\./);
  assert.match(v.text(v.$("workspaces").querySelector(".ws-key")!), /^Model key No key yet /);
  assert.equal(v.shows(v.$("key-form-ws_1")), true, "and with none the form is open again");
  assert.equal(v.$("key-model-ws_1").value, "", "from nothing: what was kept is not offered again for a key that was taken away");
  assert.equal(v.doc.querySelector('label[for="key-secret-ws_1"]')!.textContent, "Key");
});

test("a key being typed in one card is not lost when another workspace changes, and the cursor stays in it", async () => {
  const w = hosting();
  w.workspaces.push(workspace({ workspaceId: "ws_2", name: "Second", plan: "hosting", status: "provisioning", host: "second.ws.example.com", models: own(null) }));
  const v = await visit("account", { routes: w.routes });
  v.type("key-model-ws_1", "claude-sonnet-4-5");
  v.type("key-secret-ws_1", SECRET);
  const form = v.$("key-form-ws_1");
  const card = v.$("workspaces").querySelectorAll("li")[0]!;
  w.workspaces = [w.workspaces[0]!, workspace({ workspaceId: "ws_2", name: "Second", plan: "hosting", host: "second.ws.example.com", models: own(null) })];
  await v.until("the second workspace to show as running", () => /Second Running/.test(v.text("workspaces")));
  assert.ok(v.$("key-form-ws_1") === form && v.$("workspaces").querySelectorAll("li")[0] === card, "the first card, and its form, were left alone");
  assert.equal(v.$("key-secret-ws_1").value, SECRET, "what was typed is still there");
  assert.equal(v.doc.activeElement, v.$("key-secret-ws_1"), "and so is the cursor");
});

test("the key a workspace needs is asked for in the workspace's own card, and a workspace that is starting says it comes later", async () => {
  const v = await visit("account", { routes: hosting({ source: "own", key: null }, { status: "provisioning" }).routes });
  const key = v.$("workspaces").querySelector(".ws-key")!;
  assert.equal(v.text(key), "Model key No key yet Until you give it a key, a team in this workspace has no model to run on. You can set its key once the workspace has started.");
  const failed = await visit("account", { routes: hosting({ source: "own", key: null }, { status: "failed", statusReason: "the container did not start" }).routes });
  assert.equal(failed.text(failed.$("workspaces").querySelector(".ws-key")!), "", "one that could not start has no key to speak of");
  const ready = await visit("account", { routes: hosting({ source: "own", key: null }).routes });
  assert.equal(ready.doc.getElementById("auto-ws_1"), null, "a workspace that is up and has no key does not offer to be opened when it is ready, unless that was asked for while it started");
  assert.equal(ready.text(ready.$("workspaces").querySelectorAll("li")[0]!.querySelector(".ws-says")!), "Its team has no model yet. Give it your model key to put it to work.");
  assert.equal(ready.button("workspaces", "Open").className, "btn", "and Open is not the main button of a card that asks for a key: Save key is");
  assert.equal(ready.button("workspaces", "Save key").className, "btn btn-primary");
});

test("on a plan with several workspaces the one that asks for its key does not have Open as its main button, and has it once the key is kept", async () => {
  const w = hosting();
  w.plans = { json: { ...HOSTING_PLANS, plans: [{ ...HOSTING_PLANS.plans[0]!, workspaces: 3 }] } };
  const beta = (key: typeof KEPT | null) => workspace({ workspaceId: "ws_b", name: "Beta", plan: "hosting", host: "beta.ws.example.com", models: own(key) });
  w.workspaces = [workspace({ workspaceId: "ws_a", name: "Alpha", plan: "hosting", models: own(KEPT) }), beta(null)];
  w.answers.set("POST /api/workspaces/ws_b/model-key", () => {
    w.workspaces = [w.workspaces[0]!, beta(KEPT)];
    return { json: { workspace: w.workspaces[1] } };
  });
  const v = await visit("account", { routes: w.routes });
  const second = () => v.$("workspaces").querySelectorAll("li")[1]!;
  assert.equal(v.text("stage-title"), "Alpha is running", "the card at the top is about the one that is ready");
  assert.equal(v.button(second(), "Open").className, "btn", "Beta is up, and has nothing to think with: Save key is its main button");
  assert.equal(v.button(second(), "Save key").className, "btn btn-primary");
  v.type("key-model-ws_b", "claude-sonnet-4-5");
  v.type("key-secret-ws_b", SECRET);
  await v.send(v.$("key-form-ws_b"));
  assert.equal(v.text("stage-title"), "Your workspaces are running", "now two can be opened, and the card does not choose");
  assert.equal(v.button(second(), "Open").className, "btn btn-primary");
  assert.equal(v.button(v.$("workspaces").querySelectorAll("li")[0]!, "Open").className, "btn btn-primary", "and so is Alpha's: the card at the top no longer offers it");
});

// ---- opening a workspace as soon as it is ready ----

test("a person who asks for it is taken to the workspace as soon as it is ready, and nobody else is", async () => {
  const make = () => {
    const w = world((x) => { paid(x); x.workspaces = [ws("provisioning")]; });
    w.answers.set("POST /api/workspaces/ws_1/open", { json: { url: ENTER } });
    return w;
  };
  const asked = make();
  const v = await visit("account", { routes: asked.routes });
  assert.equal(v.$("auto-ws_1").checked, false, "it is off until they ask");
  assert.equal(v.$("workspaces").querySelector(".ws-auto label")!.textContent, "Open it when it is ready");
  v.check(v.$("auto-ws_1"));
  asked.workspaces = [ws("running")];
  await v.until("the page to take them there", () => v.navigations.length > 0);
  assert.deepEqual(v.navigations, [`assign ${ENTER}`]);
  assert.equal(v.to("POST", "/api/workspaces/ws_1/open").length, 1);

  const not = make();
  const n = await visit("account", { routes: not.routes });
  not.workspaces = [ws("running")];
  await n.until("the workspace to be seen running", () => n.text("stage-title") === "Research is running");
  await n.idle();
  assert.deepEqual(n.navigations, [], "a person who did not ask is left where they are");
  assert.equal(n.to("POST", "/api/workspaces/ws_1/open").length, 0);
  assert.equal(n.doc.getElementById("auto-ws_1"), null, "and the offer is gone with the waiting");

  const changed = make();
  const c = await visit("account", { routes: changed.routes });
  c.check(c.$("auto-ws_1"));
  c.check(c.$("auto-ws_1"), false);
  changed.workspaces = [ws("running")];
  await c.until("the workspace to be seen running", () => c.text("stage-title") === "Research is running");
  await c.idle();
  assert.deepEqual(c.navigations, [], "a person who asked and thought better of it is left where they are");
});

test("on a plan that sells hosting only a workspace is ready when it has its key: the page waits for the key, and keeps the offer in sight", async () => {
  const w = hosting({ source: "own", key: null }, { status: "provisioning" });
  w.answers.set("POST /api/workspaces/ws_1/open", { json: { url: ENTER } });
  w.answers.set("POST /api/workspaces/ws_1/model-key", () => {
    w.workspaces = [workspace({ plan: "hosting", models: own(KEPT) })];
    return { json: { workspace: w.workspaces[0] } };
  });
  const v = await visit("account", { routes: w.routes });
  v.check(v.$("auto-ws_1"));
  w.workspaces = [workspace({ plan: "hosting", models: own(null) })];
  await v.until("the workspace to be seen running with no key", () => v.text("stage-title") === "Add your model key");
  await v.idle();
  assert.deepEqual(v.navigations, [], "a workspace with no key is up, and not ready: it is not opened");
  assert.equal(v.$("auto-ws_1").checked, true, "the offer is still there, and still asked for");
  assert.equal(v.shows(v.$("auto-ws_1")), true);

  v.type("key-model-ws_1", "claude-sonnet-4-5");
  v.type("key-secret-ws_1", SECRET);
  await v.send(v.$("key-form-ws_1"));
  await v.until("the page to take them there", () => v.navigations.length > 0);
  assert.deepEqual(v.navigations, [`assign ${ENTER}`], "once the key is kept and the workspace is up with it");
});

test("a tab that is behind another is not taken anywhere until it is in front", async () => {
  const w = hosting({ source: "own", key: null }, { status: "provisioning" });
  w.answers.set("POST /api/workspaces/ws_1/open", { json: { url: ENTER } });
  w.answers.set("POST /api/workspaces/ws_1/model-key", () => {
    w.workspaces = [workspace({ plan: "hosting", models: own(KEPT) })];
    return { json: { workspace: w.workspaces[0] } };
  });
  const v = await visit("account", { routes: w.routes });
  v.check(v.$("auto-ws_1"));
  w.workspaces = [workspace({ plan: "hosting", models: own(null) })];
  await v.until("the workspace to be seen running with no key", () => v.text("stage-title") === "Add your model key");
  v.type("key-model-ws_1", "claude-sonnet-4-5");
  v.type("key-secret-ws_1", SECRET);
  v.setVisibility("hidden");
  await v.send(v.$("key-form-ws_1"));
  assert.deepEqual(v.navigations, [], "the key was kept and the workspace is ready, with nobody looking: nothing happens yet");
  v.setVisibility("visible");
  await v.idle();
  assert.deepEqual(v.navigations, [`assign ${ENTER}`], "and when the tab comes to the front it is opened");
  assert.equal(v.to("POST", "/api/workspaces/ws_1/open").length, 1);
});

test("a workspace that stopped while it was waited for is not waited for any more, when it starts again later", async () => {
  const w = world((x) => { paid(x); x.workspaces = [ws("provisioning")]; });
  w.answers.set("POST /api/workspaces/ws_1/open", { json: { url: ENTER } });
  w.answers.set("POST /api/workspaces/ws_1/resume", () => {
    w.workspaces = [ws("provisioning")];
    return { json: { workspace: w.workspaces[0] } };
  });
  const v = await visit("account", { routes: w.routes });
  v.check(v.$("auto-ws_1"));
  w.workspaces = [ws("suspended", { statusReason: "paused by its owner" })];
  await v.until("the workspace to be seen stopped", () => v.text("stage-title") === "Research is paused");
  assert.equal(v.doc.getElementById("auto-ws_1"), null, "a workspace that is stopped is not on its way to being ready");
  v.click(v.button("stage-actions", "Resume"));
  await v.idle();
  assert.equal(v.$("auto-ws_1").checked, false, "and what was asked for before it stopped is not asked for again");
  w.workspaces = [ws("running")];
  await v.until("the workspace to be seen running", () => v.text("stage-title") === "Research is running");
  await v.idle();
  assert.deepEqual(v.navigations, [], "it was started by hand this time, and the person is left where they are");
});

test("a request to open that is refused is said once and is not tried again by the page on its own", async () => {
  const w = world((x) => { paid(x); x.workspaces = [ws("provisioning")]; });
  w.answers.set("POST /api/workspaces/ws_1/open", failure(409, "not_ready", "That workspace is not ready yet."));
  const v = await visit("account", { routes: w.routes });
  v.check(v.$("auto-ws_1"));
  w.workspaces = [ws("running")];
  await v.until("the page to try to open it", () => v.to("POST", "/api/workspaces/ws_1/open").length > 0);
  await v.idle();
  assert.match(v.text("workspaces"), /That workspace is not ready yet\./);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(v.to("POST", "/api/workspaces/ws_1/open").length, 1, "the offer was used up by the first try");
  assert.deepEqual(v.navigations, []);
});

// ---- the cursor ----

test("a person at a keyboard keeps their place: Pause is followed by Resume, Resume at the top by what the card says, and a deleted workspace by the card at the top", async () => {
  const w = world((x) => { paid(x); x.workspaces = [ws("running")]; });
  w.answers.set("POST /api/workspaces/ws_1/suspend", () => {
    w.workspaces = [ws("suspended", { statusReason: "paused by its owner" })];
    return { json: { workspace: w.workspaces[0] } };
  });
  w.answers.set("POST /api/workspaces/ws_1/resume", () => {
    w.workspaces = [ws("running")];
    return { json: { workspace: w.workspaces[0] } };
  });
  w.answers.set("POST /api/workspaces/ws_1/delete", () => {
    w.workspaces = [];
    return { json: { ok: true } };
  });
  const v = await visit("account", { routes: w.routes });
  v.click(v.button("workspaces", "Pause"));
  await v.idle();
  assert.equal(v.doc.activeElement, v.$("resume-ws_1"), "Pause was pressed and is gone: the cursor is on what took its place, in the same card");
  v.click(v.button("stage-actions", "Resume"));
  await v.idle();
  assert.equal(v.text("stage-title"), "Research is running");
  assert.equal(v.doc.activeElement, v.$("stage-title"), "Resume in the card at the top was pressed and is gone: the cursor is on what the card says now");
  v.click(v.$("more-ws_1"));
  v.click(v.button("workspaces", "Delete this workspace"));
  v.type("confirm-ws_1", "Research");
  v.click(v.button("workspaces", "Delete workspace"));
  await v.idle();
  assert.equal(v.text("stage-title"), "Make your first workspace");
  assert.equal(v.doc.activeElement, v.$("stage-title"), "the card it was in is gone, and so is what it said: the cursor goes to the card that says what is next");
});

test("a button that is held does nothing when it is pressed again, and the request is made once", async () => {
  const w = world((x) => { paid(x); x.workspaces = [ws("running")]; });
  w.answers.set("POST /api/workspaces/ws_1/open", { json: { url: ENTER } });
  const v = await visit("account", { routes: w.routes });
  const open = v.$("stage-open");
  v.click(open);
  v.click(open);
  v.click(v.$("open-ws_1"));
  await v.idle();
  assert.equal(v.to("POST", "/api/workspaces/ws_1/open").length, 1, "pressing what is held, in the card or the workspace, asks for nothing more");
});

test("a workspace that comes to the account while a key is being typed in another card is added after it, and the cursor stays where it was", async () => {
  const w = hosting();
  w.plans = { json: { ...HOSTING_PLANS, plans: [{ ...HOSTING_PLANS.plans[0]!, workspaces: 3 }] } };
  const more = (id: string, name: string, status: string) => workspace({ workspaceId: id, name, plan: "hosting", host: `${name}.ws.example.com`, status, models: own(null) });
  w.workspaces = [w.workspaces[0]!, more("ws_c", "Third", "provisioning")];
  const v = await visit("account", { routes: w.routes });
  v.type("key-model-ws_1", "claude-sonnet-4-5");
  v.type("key-secret-ws_1", SECRET);
  const first = v.$("workspaces").querySelectorAll("li")[0]!;
  w.workspaces = [w.workspaces[0]!, more("ws_c", "Third", "running"), more("ws_b", "Second", "provisioning")];
  await v.until("the new workspace to be listed", () => v.$("workspaces").querySelectorAll("li").length === 3);
  assert.ok(v.$("workspaces").querySelectorAll("li")[0] === first, "the first card was not moved");
  assert.equal(v.doc.activeElement, v.$("key-secret-ws_1"), "so the cursor is still in the key field");
  assert.equal(v.$("key-secret-ws_1").value, SECRET);
});

test("a payment that arrives while the page is open puts Resume back on the workspaces that were waiting for it, and each says what is true now", async () => {
  const w = world((x) => { x.subscription = { ...LATE, plan: "business", title: "Business" }; x.workspaces = [ws("suspended", { workspaceId: "ws_a", name: "Alpha", statusReason: "payment is overdue" }), ws("suspended", { workspaceId: "ws_b", name: "Beta", statusReason: "payment is overdue" })]; });
  const before = JSON.stringify([["business", "past_due", "2026-11-05T12:00:00.000Z"], [20_000_000, 0]]);
  const v = new Visit("account", { routes: w.routes, search: "?paid=1", storage: { "curule:before-payment": before } });
  const started = v.start();
  await v.until("the page to say it is waiting", () => /confirms a payment/.test(v.text("notice")));
  assert.deepEqual(v.labels("workspaces"), ["More", "More"]);
  w.subscription = { ...ACTIVE!, plan: "business", title: "Business" };
  await started;
  await v.until("the payment to be seen", () => v.text("notice") === "Your payment has arrived.");
  assert.deepEqual(v.labels("workspaces"), ["Resume", "More", "Resume", "More"], "the plan is paid up, and the workspaces can be started");
  for (const card of v.$("workspaces").querySelectorAll("li")) assert.equal(v.text(card.querySelector(".ws-says")!), "Stopped because the last payment did not go through. Resume it to open it.");
});

test("a confirmation that was open when More was closed goes away with Keep it, and takes what More showed with it", async () => {
  const v = await visit("account", { routes: world((x) => { paid(x); x.workspaces = [ws("running")]; }).routes });
  v.click(v.$("more-ws_1"));
  v.click(v.button("workspaces", "Delete this workspace"));
  v.click(v.$("more-ws_1"));
  assert.equal(v.shows(v.$("confirm-ws_1")), true, "closing More does not close a question that is being asked");
  assert.equal(v.$("more-ws_1").getAttribute("aria-expanded"), "true");
  v.click(v.button("workspaces", "Keep it"));
  assert.equal(v.$("more-ws_1").getAttribute("aria-expanded"), "false");
  assert.equal(v.shows(v.$("delete-ws_1")), false);
});
