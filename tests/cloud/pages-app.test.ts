/**
 * The script of the account pages (apps/cloud-server/pages/assets/app.js), run unchanged on the real page files.
 *
 * Each test is a person doing something on a page: what the script asks the service, what it writes into the page for each
 * answer, and where it sends them. The service is a function that answers as the test says. A real browser is how what this
 * cannot see (layout, focus, the address bar) is looked at: `npm run qa:cloud`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { PAGES_DIR, SCRIPT, Visit, helpers, visit, type FakeNode } from "./pages-support";
import { ACTIVE, HOSTING_PLANS, HOSTING_SUB, KEPT, NOW, NO_USAGE, PLANS, SECRET, World, balance, failure, hosting, paid, workspace, world, type Subscription, type WorkspaceView } from "./pages-world";

// ---- the service, as the pages see it ----

// ---- the pure parts ----

test("money is said in the currency's own places, a call's cost keeps four, and a balance is rounded down so a page never promises a fraction of a cent", () => {
  const h = helpers();
  assert.equal(h.money(14_900, "USD"), "$149.00");
  assert.equal(h.money(5, "USD"), "$0.05");
  assert.equal(h.money(123_456_789, "USD"), "$1,234,567.89");
  assert.equal(h.money(1_900, "JPY"), "¥1,900", "a currency with no minor unit is not divided");
  assert.equal(h.money(1_900, "not a currency"), "19.00 not a currency", "a code the browser does not know is shown as it is, not as an error");
  assert.equal(h.digitsOf("USD"), 2);
  assert.equal(h.digitsOf("JPY"), 0);
  assert.equal(h.digitsOf("KWD"), 3);
  assert.equal(h.digitsOf("nonsense!"), 2);

  assert.equal(h.usageMoney(4_200, "USD"), "$0.0042");
  assert.equal(h.usageMoney(20_000_000, "USD"), "$20.00");
  assert.equal(h.usageMoney(0, "USD"), "$0.00");
  assert.equal(h.usageMoney(1_234_500, "USD"), "$1.2345");
  assert.equal(h.usageMoney(1_500_000, "JPY"), "¥1.5");

  assert.equal(h.balanceMoney(29_999_200, "USD"), "$29.99");
  assert.equal(h.balanceMoney(10_000_000, "USD"), "$10.00");
  assert.equal(h.balanceMoney(9_999, "USD"), "$0.00");
  assert.equal(h.balanceMoney(10_000, "USD"), "$0.01");
  assert.equal(h.balanceMoney(1_999_999, "JPY"), "¥1");
});

test("what a person types for an amount is an amount in the currency's places or it is not one", () => {
  const h = helpers();
  const good: Array<[string, number, number]> = [
    ["10", 2, 1_000],
    ["10.5", 2, 1_050],
    ["10,50", 2, 1_050],
    [" 7 ", 2, 700],
    ["0.01", 2, 1],
    ["0", 2, 0],
    ["7", 0, 7],
    ["1.234", 3, 1_234],
    ["999999999.99", 2, 99_999_999_999],
  ];
  for (const [typed, digits, minor] of good) assert.equal(h.parseAmount(typed, digits), minor, `${typed} in ${digits} places`);
  for (const [typed, digits] of [["", 2], ["abc", 2], ["1e3", 2], ["-5", 2], ["+5", 2], ["10.505", 2], ["7.5", 0], ["1,000.00", 2], ["1 000", 2], ["10.", 2], [".5", 2], ["1234567890", 2], ["10.5.1", 2]] as Array<[string, number]>) {
    assert.equal(h.parseAmount(typed, digits), null, `${JSON.stringify(typed)} in ${digits} places`);
  }
});

test("a page only ever sends a person to one of our own pages or to an http(s) address, and never to what a response says is a script", () => {
  const h = helpers();
  assert.equal(h.nextPath(""), "/account");
  assert.equal(h.nextPath("?next=/account"), "/account");
  assert.equal(h.nextPath("?next=/account?paid=1"), "/account?paid=1");
  for (const next of ["//evil.example", "https://evil.example/account", "/account/../x", "/accountx", "/\\evil.example", "javascript:alert(1)", "/login", "/account?x=<b>", "/account#frag", ""]) {
    assert.equal(h.nextPath(`?next=${encodeURIComponent(next)}`), "/account", next);
  }

  assert.equal(h.outsideUrl("https://pay.example/c/1?x=1"), "https://pay.example/c/1?x=1");
  assert.equal(h.outsideUrl("http://localhost:7500/__enter?code=abc"), "http://localhost:7500/__enter?code=abc");
  for (const bad of ["javascript:alert(1)", "data:text/html,<b>x</b>", "//evil.example", "/relative", "ftp://example.com/x", "vbscript:x", "", null, undefined, 7, {}]) assert.equal(h.outsideUrl(bad), null, String(bad));
});

test("words and dates: plurals, the reasons a workspace is stopped for, the day a row of usage is for, and what changes when a payment lands", () => {
  const h = helpers();
  assert.equal(h.plural(1, "day"), "1 day");
  assert.equal(h.plural(0, "day"), "0 days");
  assert.equal(h.plural(30, "hour"), "30 hours");

  assert.equal(h.reasonText(undefined), "");
  assert.equal(h.reasonText("paused by its owner"), "You paused it.");
  assert.equal(h.reasonText("payment is overdue"), "Stopped because the last payment did not go through.");
  assert.equal(h.reasonText("the subscription ended"), "Stopped because the subscription ended.");
  assert.equal(h.reasonText("the account was stopped: abuse report 12"), "The account was stopped: abuse report 12.");
  assert.equal(h.reasonText("Could not start!"), "Could not start!");

  assert.equal(h.dayLabel("2026-10-05"), "Oct 5, 2026");
  assert.equal(h.dayLabel("2026-01-31"), "Jan 31, 2026", "a UTC day is shown as that day, in any zone");
  assert.equal(h.dayLabel("not a day"), "not a day");
  assert.equal(h.when("2026-10-05T12:00:00.000Z"), "October 5, 2026");
  assert.equal(h.when("garbage"), "");
  assert.equal(h.count(1_234_567), "1,234,567");

  assert.deepEqual(h.planFacts(PLANS.plans[0], "USD"), ["$20.00 of model usage each month", "1 workspace", "Model tiers: fast, balanced"]);
  assert.deepEqual(h.planFacts(PLANS.plans[1], "USD"), ["$100.00 of model usage each month", "3 workspaces"]);

  const before = { account: { subscription: null }, balance: { balance: { included: 0, purchased: 0 } } };
  const after = { account: { subscription: { plan: "team", status: "active", periodEnd: "2026-11-05T12:00:00.000Z" } }, balance: { balance: { included: 20_000_000, purchased: 0 } } };
  const credit = { account: { subscription: null }, balance: { balance: { included: 0, purchased: 1_000_000 } } };
  assert.notEqual(h.fingerprint(before), h.fingerprint(after));
  assert.notEqual(h.fingerprint(before), h.fingerprint(credit));
  assert.equal(h.fingerprint(before), h.fingerprint(JSON.parse(JSON.stringify(before))));
  assert.equal(typeof h.fingerprint({ account: { subscription: null }, balance: null }), "string", "a balance that could not be read does not break it");
  assert.deepEqual(Object.keys(h.NEEDS), ["home", "signup", "login", "verify", "forgot", "reset", "account", "terms", "privacy", "notfound"]);
});

// ---- every page ----

test("the header and the front page: a visitor is offered the way in, a customer their account, and the plans are the service's own", async () => {
  const w = world((x) => (x.signedIn = false));
  const v = await visit("home", { routes: w.routes });
  assert.deepEqual(v.calls.map((c) => `${c.method} ${c.path}`).sort(), ["GET /api/plans", "GET /api/session"], "a page asks who is there and what is on offer, and does not read a balance for a header");
  const nav = v.doc.querySelector("header nav")!;
  assert.equal(v.text(nav), "Plans Sign in");
  assert.equal(v.doc.querySelector('[data-nav="home"]')!.getAttribute("aria-current"), "page");
  assert.equal(v.text(v.doc.querySelector("main .btn-row")!), "Create an account Sign in");
  const contact = v.doc.querySelector("[data-contact]")!;
  assert.deepEqual([contact.hidden, contact.getAttribute("href")], [false, "mailto:ali79taba@gmail.com"], "the footer's Contact link is the operator's own address");
  const none = await visit("home", { routes: w.routes, script: (src) => src.replace(/const CONTACT = "[^"]*";/, 'const CONTACT = "";') });
  assert.equal(none.doc.querySelector("[data-contact]")!.hidden, true, "and with no address the link stays hidden: none is made up");

  const cards = v.$("plans").querySelectorAll("article");
  assert.equal(cards.length, 2);
  assert.equal(v.text(cards[0]!), "Team $149.00 per month $20.00 of model usage each month 1 workspace Model tiers: fast, balanced Start with Team");
  assert.equal(v.text(cards[1]!), "Business $599.00 per month For a team that runs several projects. $100.00 of model usage each month 3 workspaces Start with Business");
  assert.equal(v.link(cards[0]!, "Start with Team").getAttribute("href"), "/signup");
  assert.equal(v.text("topups"), "Add credit at any time, from $5.00 to $1,000.00 at once. Each $1.00 adds $1.00 of usage, and credit does not expire.");
  const policy = v.doc.querySelectorAll("[data-policy]").map((n) => `${n.dataset.policy}=${n.textContent}`);
  assert.deepEqual(policy, ["graceDays=3 days", "retentionDays=30 days"], "the periods on the page are the service's settings");
});

test("a front page for someone who is signed in marks their plan and points the others at their account", async () => {
  const w = world(paid);
  const v = await visit("home", { routes: w.routes });
  const nav = v.doc.querySelector("header nav")!;
  assert.equal(v.text(nav), "Plans Account Sign out");
  assert.equal(v.text(v.doc.querySelector("main .btn-row")!), "Go to your account");
  const cards = v.$("plans").querySelectorAll("article");
  assert.equal(cards[0]!.className, "plan current");
  assert.match(v.text(cards[0]!), /^Team Your plan /);
  assert.equal(v.buttons(cards[0]!).length + cards[0]!.querySelectorAll("a").length, 0, "the plan a person is on is not offered to them again");
  assert.equal(v.link(cards[1]!, "Choose Business").getAttribute("href"), "/account#plan-h");
  assert.equal(v.link(cards[1]!, "Choose Business").className, "btn", "a customer who has a plan is shown the others as a way to change, which is not the main thing");

  const none = await visit("home", { routes: world().routes });
  const open = none.$("plans").querySelectorAll("article");
  assert.deepEqual(open.map((c) => none.link(c, `Choose ${c.querySelector("h3")!.textContent}`).className), ["btn btn-primary", "btn btn-primary"], "and one who has none is taken to choose, which is");
});

test("the policy numbers a page states are changed with the service's settings, with the unit in the singular when it is one", async () => {
  const w = world((x) => {
    x.signedIn = false;
    x.plans = { json: { ...PLANS, policy: { ...PLANS.policy, graceDays: 1, retentionDays: 90, verificationHours: 1, sessionDays: 7, idleDays: 2 } } };
  });
  const verify = await visit("verify", { routes: w.routes });
  assert.deepEqual(verify.doc.querySelectorAll("[data-policy]").map((n) => n.textContent), ["1 hour"]);
  const privacy = await visit("privacy", { routes: w.routes });
  assert.deepEqual(privacy.doc.querySelectorAll("[data-policy]").map((n) => n.textContent), ["7 days", "2 days", "90 days"]);
  const terms = await visit("terms", { routes: w.routes });
  assert.deepEqual(terms.doc.querySelectorAll("[data-policy]").map((n) => n.textContent), ["1 day", "90 days"]);

  const down = world((x) => {
    x.signedIn = false;
    x.plans = failure(503, "unavailable", "Down.");
  });
  const kept = await visit("terms", { routes: down.routes });
  assert.deepEqual(kept.doc.querySelectorAll("[data-policy]").map((n) => n.textContent), ["3 days", "30 days"], "the page's own wording stands when the service cannot be asked");
});

test("a front page that cannot get the plans says so and does not break", async () => {
  const w = world((x) => {
    x.signedIn = false;
    x.plans = failure(503, "unavailable", "Down.");
  });
  const v = await visit("home", { routes: w.routes });
  assert.equal(v.text("plans"), "The plans could not be loaded just now. Reload the page to try again.");
  assert.deepEqual(v.consoleErrors, []);
  const none = world((x) => {
    x.signedIn = false;
    x.plans = { json: { ...PLANS, plans: [] } };
  });
  assert.equal((await visit("home", { routes: none.routes })).text("plans"), "No plan is on offer just now.");
  const offline = await visit("home", { routes: (c) => (c.path === "/api/plans" ? { fail: true } : { json: { account: null } }) });
  assert.equal(offline.text("plans"), "The plans could not be loaded just now. Reload the page to try again.");
  const cut = await visit("home", { routes: (c) => (c.path === "/api/plans" ? { status: 200, raw: "<html>a proxy's page</html>" } : { json: { account: null } }) });
  assert.equal(cut.text("plans"), "The plans could not be loaded just now. Reload the page to try again.", "an answer that is not what the service sends is not a list of plans");
  assert.deepEqual(cut.consoleErrors, []);
});

test("signing out asks the service, and leaves the page only when the person is really out", async () => {
  const w = world(paid);
  w.answers.set("POST /api/logout", { json: { ok: true } });
  const v = await visit("home", { routes: w.routes });
  v.click(v.button(v.doc.querySelector("header nav")!, "Sign out"));
  await v.idle();
  assert.deepEqual(v.to("POST", "/api/logout").length, 1);
  assert.deepEqual(v.navigations, ["assign /"]);

  const stuck = world(paid);
  stuck.answers.set("POST /api/logout", { fail: true });
  const s = await visit("home", { routes: stuck.routes });
  const button = s.button(s.doc.querySelector("header nav")!, "Sign out");
  s.click(button);
  await s.idle();
  assert.deepEqual(s.navigations, [], "a sign-out that did not reach the service has not signed anyone out");
  assert.equal(button.textContent, "Try signing out again");
  assert.equal(button.disabled, false);

  const gone = world(paid);
  gone.answers.set("POST /api/logout", failure(401, "not_signed_in", "Sign in to continue."));
  const g = await visit("home", { routes: gone.routes });
  g.click(g.button(g.doc.querySelector("header nav")!, "Sign out"));
  await g.idle();
  assert.deepEqual(g.navigations, ["assign /"], "a person whose session had already ended is out all the same");
});

test("every call a page makes goes to this service's own API, with the session, and says it is JSON when it sends something", async () => {
  const w = world(paid);
  w.workspaces = [workspace()];
  w.answers.set("POST /api/forgot", { status: 202, json: { ok: true, message: "ok" } });
  w.answers.set("POST /api/reset", { json: { ok: true } });
  w.answers.set("POST /api/verify", { json: { account: w.view() } });
  w.answers.set("POST /api/workspaces/ws_1/suspend", { json: {} });
  w.answers.set("POST /api/checkout", { json: { url: "https://pay.example/c/1" } });
  const visits: Visit[] = [];
  for (const [page, search] of [["home", ""], ["signup", ""], ["login", ""], ["verify", "?token=t"], ["forgot", ""], ["reset", "?token=t"], ["terms", ""], ["privacy", ""], ["account", ""]] as Array<[string, string]>) visits.push(await visit(page, { routes: w.routes, search }));
  const account = visits[visits.length - 1]!;
  account.click(account.button("workspaces", "Pause"));
  account.click(account.button("topup-options", "Add $10.00"));
  account.type("current", "x");
  account.type("next", "a long enough new password");
  await account.send(account.$("password-form"));
  const forgot = await visit("forgot", { routes: new World().routes });
  forgot.type("email", "ada@example.com");
  await forgot.send(forgot.$("form"));
  for (const v of [...visits, forgot]) {
    assert.deepEqual(v.violations, [], v.page);
    assert.ok(v.calls.every((c) => c.path.startsWith("/api/")), `${v.page}: ${v.calls.map((c) => c.path).join(", ")}`);
  }
  assert.ok(account.calls.length > 5);
});

// ---- signing up ----

test("sign-up says what is missing before it asks anything, and puts the cursor where the mistake is", async () => {
  const w = world((x) => (x.signedIn = false));
  const v = await visit("signup", { routes: w.routes });
  const submit = (): Promise<void> => v.send(v.$("form"));
  await submit();
  assert.equal(v.text("status"), "Enter your email address.");
  assert.equal(v.$("email").getAttribute("aria-invalid"), "true");
  assert.equal(v.doc.activeElement, v.$("email"));
  v.type("email", "ada@example.com");
  assert.equal(v.$("email").getAttribute("aria-invalid"), null, "typing clears the mark");
  await submit();
  assert.equal(v.text("status"), "Enter your password.");
  v.type("password", "short");
  await submit();
  assert.equal(v.text("status"), "Choose a password of at least 10 characters.");
  assert.equal(v.doc.activeElement, v.$("password"));
  v.type("password", "correct horse battery staple");
  await submit();
  assert.equal(v.text("status"), "Agree to the Terms and the Privacy notice to continue.");
  assert.equal(v.doc.activeElement, v.$("agree"));
  assert.deepEqual(v.to("POST", "/api/signup"), [], "nothing was asked of the service for any of that");
});

test("sign-up sends the address as typed (trimmed) and the password as typed, once, and then says where the link went", async () => {
  const w = world((x) => (x.signedIn = false));
  w.answers.set("POST /api/signup", { status: 202, json: { ok: true, message: "Check your email for a link to confirm your address." } });
  const v = await visit("signup", { routes: w.routes, manualTimers: true });
  v.type("email", "  Ada@Example.com ");
  v.type("password", " a password with edges ");
  v.check("agree");
  v.submit(v.$("form"));
  v.submit(v.$("form"));
  await v.idle();
  assert.deepEqual(v.to("POST", "/api/signup"), [{ method: "POST", path: "/api/signup", body: { email: "Ada@Example.com", password: " a password with edges " } }], "a second submit while the first is out is not a second request");
  assert.equal(v.text("card"), "Check your email for a link to confirm your address. We sent the link to Ada@Example.com. It works once, and the email says when it expires. Resend the email Use another address You can ask for another in 60 seconds. If it does not come It can take a few minutes. Look in your spam or junk folder too. Check the address above for a typo. If it is wrong, use another address.");
  assert.equal(v.link("card", "Use another address").getAttribute("href"), "/signup");
  assert.equal(v.doc.activeElement, v.$("card"), "focus moves to what happened");
  assert.deepEqual(v.navigations, []);
});

test("sign-up shows what the service says when it refuses, and lets the person try again", async () => {
  const w = world((x) => (x.signedIn = false));
  w.answers.set("POST /api/signup", failure(400, "weak_password", "That password is too easy to guess."));
  const v = await visit("signup", { routes: w.routes });
  v.type("email", "ada@example.com");
  v.type("password", "password123456");
  v.check("agree");
  await v.send(v.$("form"));
  assert.equal(v.text("status"), "That password is too easy to guess.");
  assert.equal(v.$("status").className, "note note-bad");
  assert.ok(v.buttons("form").every((b) => !b.disabled), "the button is back");
  w.answers.set("POST /api/signup", failure(429, "rate_limited", "Too many attempts. Wait a minute and try again."));
  await v.send(v.$("form"));
  assert.equal(v.text("status"), "Too many attempts. Wait a minute and try again.");
  w.answers.set("POST /api/signup", { fail: true });
  await v.send(v.$("form"));
  assert.equal(v.text("status"), "The service could not be reached. Check your connection and try again.");
  w.answers.set("POST /api/signup", { status: 200, raw: "<html>a proxy's page</html>" });
  await v.send(v.$("form"));
  assert.equal(v.text("status"), "The service's answer could not be read. Try again in a moment.", "an answer that is not what the service sends is not taken for one");
  w.answers.set("POST /api/signup", { status: 502, raw: "<html>bad gateway</html>" });
  await v.send(v.$("form"));
  assert.equal(v.text("status"), "Something went wrong on our side. Try again in a moment.");
});

test("a person who is already signed in is taken to their account from the sign-up and sign-in pages", async () => {
  const w = world(paid);
  assert.deepEqual((await visit("signup", { routes: w.routes })).navigations, ["replace /account"]);
  assert.deepEqual((await visit("login", { routes: w.routes })).navigations, ["replace /account"]);
  assert.deepEqual((await visit("login", { routes: w.routes, search: "next=/account?paid=1" })).navigations, ["replace /account?paid=1"]);
  assert.deepEqual((await visit("login", { routes: w.routes, search: "next=//evil.example" })).navigations, ["replace /account"]);
});

// ---- signing in ----

test("sign-in asks for what is missing, sends what was typed, and goes where it was going", async () => {
  const w = world((x) => (x.signedIn = false));
  w.answers.set("POST /api/login", { json: { account: w.view() } });
  const v = await visit("login", { routes: w.routes, search: "?next=/account" });
  await v.send(v.$("form"));
  assert.equal(v.text("status"), "Enter your email address.");
  v.type("email", " ada@example.com ");
  await v.send(v.$("form"));
  assert.equal(v.text("status"), "Enter your password.");
  v.type("password", "x");
  await v.send(v.$("form"));
  assert.deepEqual(v.to("POST", "/api/login"), [{ method: "POST", path: "/api/login", body: { email: "ada@example.com", password: "x" } }], "a sign-in does not require a long password: a short one is a wrong one");
  assert.deepEqual(v.navigations, ["assign /account"]);
});

test("a wrong password is said once in the service's words, the field is cleared, and the cursor is in it", async () => {
  const w = world((x) => (x.signedIn = false));
  w.answers.set("POST /api/login", failure(401, "invalid_credentials", "That email and password do not match an account."));
  const v = await visit("login", { routes: w.routes });
  v.type("email", "ada@example.com");
  v.type("password", "wrong");
  await v.send(v.$("form"));
  assert.equal(v.text("status"), "That email and password do not match an account.");
  assert.equal(v.$("password").value, "");
  assert.equal(v.$("email").value, "ada@example.com");
  assert.equal(v.doc.activeElement, v.$("password"));
  assert.deepEqual(v.navigations, [], "a 401 for a wrong password is not 'signed out': it does not send anyone anywhere");
  w.answers.set("POST /api/login", failure(429, "rate_limited", "Too many attempts. Try again in 10 minutes."));
  v.type("password", "again");
  await v.send(v.$("form"));
  assert.equal(v.text("status"), "Too many attempts. Try again in 10 minutes.");
});

// ---- the link in the mail ----

test("a confirmation link is spent once: the token is sent, then removed from the address, and the person is taken to their account", async () => {
  const w = world((x) => (x.signedIn = false));
  w.answers.set("POST /api/verify", { json: { account: w.view() } });
  const v = await visit("verify", { routes: w.routes, search: "?token=abc123" });
  assert.deepEqual(v.to("POST", "/api/verify"), [{ method: "POST", path: "/api/verify", body: { token: "abc123" } }]);
  assert.deepEqual(v.history, ["/verify"], "the token is not left in the address bar or the history");
  assert.equal(v.text("status"), "Your address is confirmed. Taking you to your account.");
  assert.deepEqual(v.navigations, ["replace /account"]);
  assert.equal(v.$("again").hidden, true);
});

test("a link that is no good says so, offers a way on, and also leaves the address bar", async () => {
  const w = world((x) => (x.signedIn = false));
  w.answers.set("POST /api/verify", failure(400, "invalid_token", "That link is not valid, or it has expired. Ask for a new one."));
  const v = await visit("verify", { routes: w.routes, search: "?token=old" });
  assert.equal(v.text("status"), "That link is not valid, or it has expired. Ask for a new one.");
  assert.equal(v.$("status").className, "note note-bad");
  assert.equal(v.$("again").hidden, false);
  assert.deepEqual(v.history, ["/verify"]);
  assert.deepEqual(v.navigations, []);

  const none = await visit("verify", { routes: w.routes });
  assert.equal(none.text("status"), "This link is incomplete. Open the link in the email again.");
  assert.equal(none.$("again").hidden, false);
  assert.deepEqual(none.to("POST", "/api/verify"), [], "with no token there is nothing to send");
});

test("asking for a password reset says the same for every address, and says nothing is sent until an address is given", async () => {
  const w = world((x) => (x.signedIn = false));
  w.answers.set("POST /api/forgot", { status: 202, json: { ok: true, message: "If that address has an account, a link to choose a new password is on its way." } });
  const v = await visit("forgot", { routes: w.routes });
  await v.send(v.$("form"));
  assert.equal(v.text("status"), "Enter your email address.");
  v.type("email", " ada@example.com ");
  await v.send(v.$("form"));
  assert.deepEqual(v.to("POST", "/api/forgot"), [{ method: "POST", path: "/api/forgot", body: { email: "ada@example.com" } }]);
  assert.equal(v.text("status"), "If that address has an account, a link to choose a new password is on its way.");
  assert.equal(v.$("status").className, "note note-ok");
  w.answers.set("POST /api/forgot", failure(429, "rate_limited", "Too many attempts. Try again in 12 minutes."));
  await v.send(v.$("form"));
  assert.equal(v.text("status"), "Too many attempts. Try again in 12 minutes.");
});

test("choosing a new password: the form is not there without a link, and with one it sends the token and then leaves the address", async () => {
  const w = world((x) => (x.signedIn = false));
  const none = await visit("reset", { routes: w.routes });
  assert.equal(none.shows(none.$("form")), false, "a form with no link to go with it is not shown");
  assert.equal(none.text("status"), "This link is incomplete. Open the link in the email again, or ask for a new one.");
  assert.equal(none.link("card", "Ask for a new link").getAttribute("href"), "/forgot");

  w.answers.set("POST /api/reset", { json: { ok: true } });
  const v = await visit("reset", { routes: w.routes, search: "?token=t0k3n" });
  assert.equal(v.shows(v.$("form")), true);
  assert.equal(v.text("status"), "");
  v.type("password", "short");
  await v.send(v.$("form"));
  assert.equal(v.text("status"), "Choose a password of at least 10 characters.");
  v.type("password", "a brand new password");
  await v.send(v.$("form"));
  assert.deepEqual(v.to("POST", "/api/reset"), [{ method: "POST", path: "/api/reset", body: { token: "t0k3n", password: "a brand new password" } }]);
  assert.deepEqual(v.history, ["/reset"]);
  assert.equal(v.text("card"), "Your password is changed. Every device is signed out. Sign in");
  assert.equal(v.link("card", "Sign in").getAttribute("href"), "/login");
});

test("a reset link that has been used offers a new one; a password that is too weak does not, because the link is fine", async () => {
  const w = world((x) => (x.signedIn = false));
  w.answers.set("POST /api/reset", failure(400, "invalid_token", "That link is not valid, or it has expired. Ask for a new one."));
  const v = await visit("reset", { routes: w.routes, search: "?token=used" });
  v.type("password", "a perfectly good password");
  await v.send(v.$("form"));
  assert.equal(v.text("status"), "That link is not valid, or it has expired. Ask for a new one.");
  assert.equal(v.link("card", "Ask for a new link").getAttribute("href"), "/forgot");
  assert.deepEqual(v.history, [], "the page keeps the link in the address until it has been used");

  const weak = world((x) => (x.signedIn = false));
  weak.answers.set("POST /api/reset", failure(400, "weak_password", "That password is too easy to guess."));
  const u = await visit("reset", { routes: weak.routes, search: "?token=fresh" });
  u.type("password", "password123456");
  await u.send(u.$("form"));
  assert.equal(u.text("status"), "That password is too easy to guess.");
  assert.equal(u.doc.querySelectorAll("a").filter((a) => a.textContent === "Ask for a new link").length, 0);
});

test("the page for a wrong address offers a visitor the plans and the way in, and a customer their account", async () => {
  const out = world((x) => (x.signedIn = false));
  const v = await visit("404", { routes: out.routes });
  assert.equal(v.text("main"), "That page is not here The address may have changed, or it may never have existed. These pages do exist. See the plans Sign in Create an account");
  assert.deepEqual(v.doc.querySelectorAll("a").filter((a) => v.shows(a) && !a.className.includes("brand") && a.getAttribute("href") !== "#main" && !v.doc.querySelector("footer")!.contains(a)).map((a) => a.getAttribute("href")), ["/", "/login", "/", "/login", "/signup"], "the header's two, then the page's three");
  const signedIn = world(paid);
  const u = await visit("404", { routes: signedIn.routes });
  assert.equal(u.text("main"), "That page is not here The address may have changed, or it may never have existed. These pages do exist. See the plans Go to your account");
  assert.equal(u.link("main", "Go to your account").getAttribute("href"), "/account");
  assert.deepEqual(u.consoleErrors, []);
});

// ---- what a page does for the person at it ----

test("a page's heading and the tab's title say what the page is now: a link that was sent is no longer \"Create your account\"", async () => {
  const w = world((x) => (x.signedIn = false));
  w.answers.set("POST /api/signup", { status: 202, json: { ok: true, message: "Check your email for a link to confirm your address." } });
  const v = await visit("signup", { routes: w.routes });
  assert.equal(v.text("title"), "Create your account");
  assert.equal(v.shows(v.$("lede")), true);
  v.type("email", "ada@example.com");
  v.type("password", "correct horse battery staple");
  v.check("agree");
  await v.send(v.$("form"));
  assert.equal(v.text("title"), "Check your email");
  assert.equal(v.shows(v.$("lede")), false, "the line that asked for the address goes with the form");
  assert.equal(v.doc.title, "Check your email – Curule Cloud");

  w.answers.set("POST /api/verify", failure(400, "invalid_token", "That link is not valid, or it has expired. Ask for a new one."));
  const bad = await visit("verify", { routes: w.routes, search: "?token=old" });
  assert.equal(bad.text("title"), "That link did not work", "a failed check is not still \"Confirming\"");
  assert.equal(bad.doc.title, "That link did not work – Curule Cloud");
  assert.equal((await visit("verify", { routes: w.routes })).text("title"), "That link did not work", "nor is a link with no token in it");

  w.answers.set("POST /api/verify", { json: { account: w.view() } });
  const good = await visit("verify", { routes: w.routes, search: "?token=ok" });
  assert.equal(good.text("title"), "Address confirmed");

  w.answers.set("POST /api/reset", { json: { ok: true } });
  const reset = await visit("reset", { routes: w.routes, search: "?token=t0k3n" });
  assert.equal(reset.text("title"), "Choose a new password");
  reset.type("password", "a brand new password");
  await reset.send(reset.$("form"));
  assert.equal(reset.text("title"), "Password changed");
  assert.equal(reset.shows(reset.$("lede")), false);
  assert.equal(reset.doc.title, "Password changed – Curule Cloud");
});

test("the sign-in page says that the right password sends the link again, and the page that says the link was sent does not promise what that denies", async () => {
  const login = fs.readFileSync(`${PAGES_DIR}/login.html`, "utf8");
  assert.match(login, /signing in with your password sends the link again/);
  const w = world((x) => (x.signedIn = false));
  w.answers.set("POST /api/signup", { status: 202, json: { ok: true, message: "Check your email for a link to confirm your address." } });
  const v = await visit("signup", { routes: w.routes, manualTimers: true });
  v.type("email", "ada@example.com");
  v.type("password", "correct horse battery staple");
  v.check("agree");
  await v.send(v.$("form"));
  assert.doesNotMatch(v.text("card"), /Sign in with your email and password/, "what to do is a button, and the usual causes: the sign-in page's way is its own");
});

test("a password field has Show and Hide that only a script can give, and a password that was shown is hidden again once it is sent", async () => {
  for (const [page, field, form] of [["signup", "password", "form"], ["login", "password", "form"], ["reset", "password", "form"], ["account", "next", "password-form"], ["account", "current", "password-form"]] as const) {
    const w = world((x) => {
      x.signedIn = page === "account";
      if (page === "account") paid(x);
    });
    w.answers.set("POST /api/login", failure(401, "invalid_credentials", "That email and password do not match an account."));
    const v = await visit(page, { routes: w.routes, ...(page === "reset" ? { search: "?token=t0k3n" } : {}) });
    const input = v.$(field);
    const toggle = v.doc.querySelectorAll("button").find((b) => b.getAttribute("data-reveal") === field)!;
    assert.ok(toggle, `${page}: ${field} has a toggle`);
    assert.equal(toggle.hidden, false, `${page}: the script shows it`);
    assert.equal(toggle.getAttribute("aria-controls"), field);
    assert.equal(toggle.getAttribute("type"), "button", "it never submits the form");
    assert.equal(input.getAttribute("type"), "password");
    assert.equal(toggle.textContent, "Show");
    assert.equal(toggle.getAttribute("aria-label"), "Show password");
    v.click(toggle);
    assert.equal(input.getAttribute("type"), "text", `${page}: shown`);
    assert.equal(toggle.textContent, "Hide");
    assert.equal(toggle.getAttribute("aria-label"), "Hide password");
    v.click(toggle);
    assert.equal(input.getAttribute("type"), "password", `${page}: hidden again`);
    v.click(toggle);
    v.type(field, "a long enough secret");
    if (page === "login") v.type("email", "ada@example.com");
    await v.send(v.$(form));
    assert.equal(input.getAttribute("type"), "password", `${page}: sending it hides it again`);
    assert.equal(toggle.textContent, "Show");
  }
  for (const page of ["signup", "login", "reset", "account"]) {
    const html = fs.readFileSync(`${PAGES_DIR}/${page}.html`, "utf8");
    for (const m of html.matchAll(/<button[^>]*data-reveal="([^"]+)"[^>]*>/g)) assert.match(m[0], /\bhidden\b/, `${page}: with no script the control is not shown, so nothing on the page does nothing`);
  }
});

test("a button that was pressed has the cursor again when its call is done, unless the page put it somewhere on purpose", async () => {
  const w = world((x) => (x.signedIn = false));
  w.answers.set("POST /api/forgot", { status: 202, json: { ok: true, message: "If that address has an account, a link to choose a new password is on its way." } });
  const v = await visit("forgot", { routes: w.routes });
  v.type("email", "ada@example.com");
  const send = v.button("form", "Send the link");
  v.click(send);
  assert.equal(v.doc.activeElement, null, "while the call is out the button is disabled, and a browser takes the cursor from it");
  await v.idle();
  assert.equal(v.doc.activeElement, send, "and when it is done the cursor is on it again");

  const refusing = world((x) => (x.signedIn = false));
  refusing.answers.set("POST /api/login", failure(401, "invalid_credentials", "That email and password do not match an account."));
  const login = await visit("login", { routes: refusing.routes });
  login.type("email", "ada@example.com");
  login.type("password", "wrong password");
  login.click(login.button("form", "Sign in"));
  await login.idle();
  assert.equal(login.doc.activeElement, login.$("password"), "a page that puts it in the field that needs it is not undone");
});

test("a main button says what it is doing while the call is out, and is itself again afterwards", async () => {
  const w = world((x) => (x.signedIn = false));
  let during = "";
  let v: Visit | undefined;
  w.answers.set("POST /api/login", () => {
    during = v!.text(v!.doc.querySelector('button[type="submit"]')!);
    return failure(401, "invalid_credentials", "That email and password do not match an account.");
  });
  v = await visit("login", { routes: w.routes });
  const main = v.doc.querySelector('button[type="submit"]')!;
  assert.equal(main.textContent, "Sign in");
  v.type("email", "ada@example.com");
  v.type("password", "a long enough secret");
  await v.send(v.$("form"));
  assert.equal(during, "Signing in", "the button said what was going on while the service had the call");
  assert.equal(main.textContent, "Sign in", "and says what it is again");
  assert.equal(main.disabled, false);

  for (const [page, label, busy] of [["signup", "Create account", "Creating account"], ["forgot", "Send the link", "Sending"], ["reset", "Save password", "Saving"], ["account", "Change password", "Changing"], ["account", "Pay", "One moment"], ["account", "Create workspace", "Creating"]] as const) {
    const html = fs.readFileSync(`${PAGES_DIR}/${page}.html`, "utf8");
    assert.match(html, new RegExp(`data-busy="${busy}"[^>]*>${label}<`), `${page}: ${label} says "${busy}" while it works`);
  }
});

test("a person at a keyboard starts at the first field; a phone is left alone, because a keyboard that opens by itself covers the page", async () => {
  const w = world((x) => (x.signedIn = false));
  for (const [page, field, extra] of [["signup", "email", {}], ["login", "email", {}], ["forgot", "email", {}], ["reset", "password", { search: "?token=t0k3n" }]] as const) {
    const fine = await visit(page, { routes: w.routes, pointer: "fine", ...extra });
    assert.equal(fine.doc.activeElement, fine.$(field), `${page}: the cursor is in ${field}`);
    const coarse = await visit(page, { routes: w.routes, pointer: "coarse", ...extra });
    assert.equal(coarse.doc.activeElement, null, `${page}: a finger's page does not pull the keyboard up`);
    const unknown = await visit(page, { routes: w.routes, ...extra });
    assert.equal(unknown.doc.activeElement, null, `${page}: a browser that cannot say is left alone`);
  }
  const link = await visit("reset", { routes: w.routes, pointer: "fine" });
  assert.equal(link.doc.activeElement, null, "a reset page with no link has no field to start in");
});

// ---- the account ----

test("the account page sends a visitor to sign in and remembers where they were going", async () => {
  const w = world((x) => (x.signedIn = false));
  const v = await visit("account", { routes: w.routes });
  assert.deepEqual(v.navigations, ["replace /login?next=/account"]);
  assert.deepEqual(v.calls.map((c) => c.path), ["/api/session"], "nothing else is asked of the service");

  // A session that ends while the page is open does the same on the next thing the person does.
  const s = world((x) => {
    paid(x);
    x.workspaces = [workspace()];
  });
  const open = await visit("account", { routes: s.routes });
  s.answers.set("POST /api/workspaces/ws_1/suspend", failure(401, "not_signed_in", "Sign in to continue."));
  open.click(open.button("workspaces", "Pause"));
  await open.idle();
  assert.deepEqual(open.navigations, ["replace /login?next=/account"]);
});

test("the account page says the service cannot be reached, instead of sending a person to sign in again for nothing", async () => {
  const down = await visit("account", { routes: (c) => (c.path === "/api/session" ? failure(503, "unavailable", "Changes cannot be saved just now. Try again in a few minutes.") : undefined) });
  assert.equal(down.text("notice"), "Changes cannot be saved just now. Try again in a few minutes. Reload the page to try again.");
  assert.deepEqual(down.navigations, []);
  const offline = await visit("account", { routes: (c) => (c.path === "/api/session" ? { fail: true } : undefined) });
  assert.equal(offline.text("notice"), "The service could not be reached. Check your connection and try again. Reload the page to try again.");
  assert.deepEqual(offline.navigations, []);

  const w = world(paid);
  w.answers.set("GET /api/me", failure(502, "bad_gateway", "Something went wrong on our side. Try again in a moment."));
  const half = await visit("account", { routes: w.routes });
  assert.equal(half.text("notice"), "Something went wrong on our side. Try again in a moment. Reload the page to try again.");
  assert.deepEqual(half.navigations, []);
});

test("a new account sees what to do first: choose a plan, and nothing to create, open, pay for or use yet", async () => {
  const w = world();
  const v = await visit("account", { routes: w.routes });
  assert.equal(v.text("who"), "Signed in as ada@example.com");
  assert.equal(v.shows(v.$("stage")), true);
  assert.equal(v.text("stage-title"), "Choose a plan");
  assert.equal(v.text("stage-text"), "A plan is a flat monthly price for your workspace. Choose one below and pay on the next page.");
  assert.equal(v.link("stage-actions", "Choose a plan").getAttribute("href"), "#plan-h");
  assert.equal(v.text("stage-steps"), "1 Plan (you are here) 2 Workspace (still to do) 3 Open (still to do)");
  assert.equal(v.shows(v.$("workspaces-panel")), false, "there is no workspace to list");
  assert.equal(v.shows(v.$("create")), false);
  assert.equal(v.text("plan-h"), "Choose a plan");
  assert.equal(v.$("plan").querySelectorAll("article").length, 2);
  assert.deepEqual(v.labels("plan"), ["Choose Team", "Choose Business"]);
  assert.equal(v.shows(v.$("balance-panel")), false, "a balance means nothing before a plan, whatever the gateway holds");
  assert.equal(v.shows(v.$("usage-panel")), false);
  assert.equal(v.to("GET", "/api/usage").length, 0, "and usage is not asked for until there is a plan that sells it");
  assert.equal(v.text("notice"), "");
  assert.deepEqual(v.consoleErrors, []);
});

test("choosing a plan asks for that plan's checkout and goes to the payment page the service returns, remembering what the account looked like before", async () => {
  const w = world();
  w.answers.set("POST /api/checkout", { json: { url: "https://pay.example/c/abc" } });
  const v = await visit("account", { routes: w.routes });
  v.click(v.button("plan", "Choose Business"));
  await v.idle();
  assert.deepEqual(v.to("POST", "/api/checkout"), [{ method: "POST", path: "/api/checkout", body: { purpose: "subscription", plan: "business" } }]);
  assert.deepEqual(v.navigations, ["assign https://pay.example/c/abc"]);
  assert.equal(v.storage.get("curule:before-payment"), JSON.stringify([null, [20_000_000, 0]]));
});

test("a payment page that cannot be opened is said, with the button back, and an address that is not http(s) is never followed", async () => {
  const w = world();
  const v = await visit("account", { routes: w.routes });
  const choose = v.button("plan", "Choose Team");
  w.answers.set("POST /api/checkout", failure(502, "billing_unavailable", "The payment page could not be opened. Try again in a moment."));
  v.click(choose);
  await v.idle();
  assert.equal(v.text("plan-status"), "The payment page could not be opened. Try again in a moment.");
  assert.deepEqual(v.navigations, []);
  const again = v.button("plan", "Choose Team");
  assert.equal(again.disabled, false);

  w.answers.set("POST /api/checkout", { json: { url: "javascript:alert(document.cookie)" } });
  v.click(again);
  await v.idle();
  assert.deepEqual(v.navigations, [], "an address a response gives is followed only if it is http or https");

  w.answers.set("POST /api/checkout", failure(401, "not_signed_in", "Sign in to continue."));
  v.click(v.button("plan", "Choose Team"));
  await v.idle();
  assert.deepEqual(v.navigations, ["replace /login?next=/account"]);
});

test("an account on a plan shows it once, with what it costs and includes and when it is paid until, and the other plans behind a button", async () => {
  const w = world((x) => {
    paid(x);
    x.workspaces = [workspace()];
  });
  const v = await visit("account", { routes: w.routes });
  assert.equal(v.text("plan-h"), "Plan");
  assert.equal(v.text(v.$("plan").querySelector(".row")!), "Team Active $149.00 per month. Paid until November 5, 2026. $20.00 of model usage each month 1 workspace Model tiers: fast, balanced Manage billing Change plan");
  assert.deepEqual(v.labels("plan"), ["Manage billing", "Change plan"], "the other plans are not offered until they are asked for");
  const toggle = v.$("plan-change-toggle");
  assert.deepEqual([toggle.getAttribute("aria-expanded"), toggle.getAttribute("aria-controls")], ["false", "plan-change"]);
  assert.equal(v.shows(v.$("plan-change")), false);

  v.click(toggle);
  assert.equal(v.$("plan-change-toggle").getAttribute("aria-expanded"), "true");
  assert.deepEqual(v.labels("plan"), ["Manage billing", "Change plan", "Switch to Business"]);
  const others = v.$("plan-change").querySelectorAll("article");
  assert.deepEqual(others.map((a) => v.text(a)), ["Business $599.00 per month For a team that runs several projects. $100.00 of model usage each month 3 workspaces Switch to Business"], "the plan the account is on is not in the list of plans to change to: it is shown above, once");
  assert.equal(v.doc.activeElement, v.$("plan-change-toggle"), "the cursor stays on the button that was pressed");
  v.click(v.$("plan-change-toggle"));
  assert.deepEqual(v.labels("plan"), ["Manage billing", "Change plan"]);

  assert.equal(v.text("notice"), "");
  assert.equal(v.text("create-note"), "Your plan includes 1 workspace. To make another, delete this one or change your plan.");
  assert.equal(v.shows(v.$("create")), false, "a plan's last place is not offered to fill");
});

test("billing on an account is managed on the provider's page, and a provider that has none says so in its own words", async () => {
  const w = world(paid);
  w.answers.set("POST /api/portal", { json: { url: "https://pay.example/portal" } });
  const v = await visit("account", { routes: w.routes });
  v.click(v.button("plan", "Manage billing"));
  await v.idle();
  assert.deepEqual(v.navigations, ["assign https://pay.example/portal"]);
  assert.equal(v.storage.size, 0, "nothing is expected back from the provider's page, so nothing is remembered");

  const manual = world(paid);
  manual.answers.set("POST /api/portal", failure(409, "no_portal", "There is no billing portal for payments made by invoice or transfer. Contact the operator to change or cancel a plan."));
  const m = await visit("account", { routes: manual.routes });
  m.click(m.button("plan", "Manage billing"));
  await m.idle();
  assert.equal(m.text("plan-status"), "There is no billing portal for payments made by invoice or transfer. Contact the operator to change or cancel a plan.");
  assert.equal(m.button("plan", "Manage billing").disabled, false, "and the button is back");
  assert.deepEqual(m.navigations, []);
});

test("a payment that has failed is said at the top with the day the workspaces stop, a subscription that has ended says when its workspaces are deleted, and a balance that is gone says what that means", async () => {
  const late = world((x) => {
    x.subscription = { plan: "team", title: "Team", status: "past_due", periodEnd: "2026-11-05T12:00:00.000Z", pastDueSince: "2026-10-05T12:00:00.000Z" };
    x.workspaces = [workspace()];
  });
  late.answers.set("POST /api/portal", { json: { url: "https://pay.example/portal" } });
  const v = await visit("account", { routes: late.routes });
  assert.equal(v.text("stage-title"), "Your last payment did not go through");
  assert.equal(v.text("stage-text"), "Your workspaces keep running until October 8, 2026 and are then stopped. A payment before then puts everything back.");
  assert.equal(v.$("stage").className, "stage stage-warn");
  assert.deepEqual(v.labels("stage-actions"), ["Update payment details", "Open"], "the one thing to do is where the card says it, with Open beside it for the workspace that still runs");
  assert.equal(v.text("notice"), "", "and it is said once: not again in the notice above it");
  assert.match(v.text(v.$("plan").querySelector(".row")!), /^Team Payment overdue /i);
  assert.equal(v.text("create-note"), "Update your payment details to create a workspace.", "the card at the top has said why");
  assert.equal(v.shows(v.$("create")), false);
  v.click(v.button("stage-actions", "Update payment details"));
  await v.idle();
  assert.deepEqual(v.navigations, ["assign https://pay.example/portal"]);

  const stopped = world((x) => {
    x.subscription = { plan: "team", title: "Team", status: "past_due", pastDueSince: "2026-10-01T12:00:00.000Z" };
    x.workspaces = [workspace({ status: "suspended", statusReason: "payment is overdue" })];
  });
  const t = await visit("account", { routes: stopped.routes });
  assert.equal(t.text("stage-text"), "Your workspaces were stopped because of it. A payment puts everything back.", "once the workspaces are stopped, the day they would stop is not said as if it were ahead");

  const ended = world((x) => {
    x.subscription = { plan: "team", title: "Team", status: "ended" };
  });
  const e = await visit("account", { routes: ended.routes });
  assert.equal(e.text("stage-title"), "Choose a plan to start again");
  assert.equal(e.text("stage-text"), "Your subscription has ended and your workspaces are stopped. They are deleted 30 days after it ended. Choose a plan again before then and they start again.");
  assert.equal(e.$("stage").className, "stage stage-warn");
  assert.equal(e.text("plan-h"), "Choose a plan");
  assert.equal(e.text(e.$("plan").querySelector(".row")!), "Team Ended");
  assert.deepEqual(e.labels("plan"), ["Choose Team", "Choose Business"], "a plan that ended is a plan that can be chosen again");

  const spent = world((x) => {
    paid(x);
    x.balance = balance({ included: 0, available: 0 });
  });
  const s = await visit("account", { routes: spent.routes });
  assert.equal(s.text("notice"), "Your balance is used up. Calls to models are refused until you add credit or your plan renews, and a mesh that needs them pauses with a notice that says why.");
});

test("the balance is what the gateway says, rounded down; when it cannot be read the page says so, and everything else still works", async () => {
  const w = world(paid);
  w.balance = balance({ included: 19_999_200, purchased: 10_000_000 });
  const v = await visit("account", { routes: w.routes });
  assert.equal(v.text("figures"), "Available $29.99 From your plan $19.99 From credit you added $10.00");

  const blind = world(paid);
  blind.balance = null;
  const b = await visit("account", { routes: blind.routes });
  assert.equal(b.text("figures"), "Available Not available just now");
  assert.equal(b.text("notice"), "", "an unknown balance is not a used-up one");
  assert.match(b.text(b.$("plan").querySelector(".row")!), /^Team Active \$149\.00 per month\. Paid until November 5, 2026\. /);
});

test("the plans being unavailable leaves the rest of the account usable and says what is missing", async () => {
  const w = world(paid);
  w.plans = failure(503, "unavailable", "Down.");
  w.workspaces = [workspace({ status: "suspended", statusReason: "paused by its owner" })];
  const v = await visit("account", { routes: w.routes });
  assert.equal(v.text(v.$("plan").querySelectorAll("p").at(-1)!), "The plans could not be loaded just now. Reload the page to try again.");
  assert.equal(v.text("topup-hint"), "");
  assert.deepEqual(v.labels("topup-options"), []);
  assert.deepEqual(v.labels("workspaces"), ["Resume", "More"]);
  assert.match(v.text("workspaces"), /Paused by you\. Its files are kept\. Resume it to open it\./);
});

// ---- workspaces ----

test("each workspace shows its state in words, with only what can be done to it in that state, and deleting is behind More except for a workspace that could not start", async () => {
  const w = world((x) => {
    x.subscription = { ...ACTIVE!, plan: "business", title: "Business" };
    x.workspaces = [
      workspace({ workspaceId: "ws_a", name: "Alpha", host: "alpha.ws.example.com" }),
      workspace({ workspaceId: "ws_b", name: "Beta", host: "beta.ws.example.com", status: "suspended", statusReason: "payment is overdue" }),
      workspace({ workspaceId: "ws_c", name: "Gamma", host: "gamma.ws.example.com", status: "provisioning" }),
      workspace({ workspaceId: "ws_d", name: "Delta", host: "delta.ws.example.com", status: "failed", statusReason: "the container did not start" }),
    ];
  });
  const v = await visit("account", { routes: w.routes });
  const rows = v.$("workspaces").querySelectorAll("li");
  assert.equal(rows.length, 4);
  assert.equal(v.text(rows[0]!), "Alpha Running Open Pause More Address alpha.ws.example.com", "a workspace that is ready says its state and offers what can be done");
  assert.equal(v.text(rows[1]!), "Beta Stopped Stopped because the last payment did not go through. Resume it to open it. Resume More Address beta.ws.example.com", "the plan is paid up, so it can be started");
  assert.equal(v.text(rows[2]!), "Gamma Starting It starts in the background, and this page updates when it is ready. Open it when it is ready Address gamma.ws.example.com");
  assert.equal(v.text(rows[3]!), "Delta Could not start The container did not start. Delete it and make a new one. If it fails again, tell the operator. Delete this workspace Address delta.ws.example.com");
  const boxes = (row: FakeNode) => row.querySelectorAll("input").filter((i) => i.getAttribute("type") === "checkbox");
  assert.deepEqual(rows.map((r) => boxes(r).length), [0, 0, 1, 0], "only a workspace that is starting offers to be opened when it is ready");
  assert.equal(boxes(rows[2]!)[0]!.checked, false, "and it is off until the person asks");
  assert.equal(v.text("create-note"), "", "while a workspace is starting nothing is said about the plan being full: the person has done what was asked of them");
  assert.equal(v.shows(v.$("create")), false, "three places, and three are in use: a workspace that failed to start does not hold one");

  const full = world((x) => {
    x.subscription = { ...ACTIVE!, plan: "business", title: "Business" };
    x.workspaces = [workspace({ workspaceId: "ws_a", name: "Alpha" }), workspace({ workspaceId: "ws_b", name: "Beta", status: "suspended", statusReason: "paused by its owner" }), workspace({ workspaceId: "ws_c", name: "Gamma" }), workspace({ workspaceId: "ws_d", name: "Delta", status: "failed" })];
  });
  const f = await visit("account", { routes: full.routes });
  assert.equal(f.text("create-note"), "Your plan includes 3 workspaces. To make another, delete one or change your plan.");
  assert.equal(f.shows(f.$("create")), false);
});

test("naming a workspace creates it, and a workspace that is starting is watched until it is running", async () => {
  const w = world(paid);
  w.answers.set("POST /api/workspaces", (call) => {
    w.workspaces = [workspace({ name: String((call.body as { name: string }).name), status: "provisioning" })];
    return { status: 201, json: { workspace: w.workspaces[0] } };
  });
  const v = await visit("account", { routes: w.routes });
  assert.equal(v.shows(v.$("create")), true);
  await v.send(v.$("create"));
  assert.equal(v.text("create-note"), "Give the workspace a name.");
  assert.equal(v.$("workspace-name").getAttribute("aria-invalid"), "true");
  assert.deepEqual(v.to("POST", "/api/workspaces"), []);

  v.type("workspace-name", "  Research  ");
  await v.send(v.$("create"));
  assert.deepEqual(v.to("POST", "/api/workspaces"), [{ method: "POST", path: "/api/workspaces", body: { name: "Research" } }]);
  assert.equal(v.$("workspace-name").value, "");
  assert.match(v.text("workspaces"), /^Research Starting /);
  assert.equal(v.text("stage-title"), "Research is starting", "the card at the top says what became of it");
  assert.equal(v.doc.activeElement, v.$("stage-title"), "and the cursor goes there: the form it was in is gone");

  // The page looks again by itself; the workspace is running when it does.
  const before = v.to("GET", "/api/me").length;
  w.workspaces = [workspace({ name: "Research", status: "running" })];
  await v.until("the workspace to show as running", () => /^Research Running /.test(v.text("workspaces")));
  assert.ok(v.to("GET", "/api/me").length > before);
  assert.deepEqual(v.labels("workspaces"), ["Open", "Pause", "More"]);
});

test("a workspace the service refuses to make is said in the service's words and the name stays", async () => {
  const w = world(paid);
  w.answers.set("POST /api/workspaces", failure(403, "workspace_limit", "Your plan allows 1 workspace."));
  const v = await visit("account", { routes: w.routes });
  v.type("workspace-name", "Second");
  await v.send(v.$("create"));
  assert.equal(v.text("create-note"), "Your plan allows 1 workspace.");
  assert.equal(v.$("create-note").className, "note note-bad");
  assert.equal(v.$("workspace-name").value, "Second");
});

test("opening a workspace asks for a one-time address and goes there; an answer that is not an address the page will follow is refused", async () => {
  const w = world((x) => {
    paid(x);
    x.workspaces = [workspace()];
  });
  w.answers.set("POST /api/workspaces/ws_1/open", { json: { url: "https://research-1a2b3c.ws.example.com/__enter?code=abc" } });
  const v = await visit("account", { routes: w.routes });
  v.click(v.button("workspaces", "Open"));
  await v.idle();
  assert.deepEqual(v.navigations, ["assign https://research-1a2b3c.ws.example.com/__enter?code=abc"]);
  assert.equal(v.to("POST", "/api/workspaces/ws_1/open").length, 1);

  const odd = world((x) => {
    paid(x);
    x.workspaces = [workspace()];
  });
  odd.answers.set("POST /api/workspaces/ws_1/open", { json: { url: "javascript:alert(1)" } });
  const o = await visit("account", { routes: odd.routes });
  o.click(o.button("workspaces", "Open"));
  await o.idle();
  assert.deepEqual(o.navigations, []);
  assert.equal(o.text("workspaces"), "Research Running Open Pause More The address of this workspace is not one this page will open. Tell the operator. Address research-1a2b3c.ws.example.com");

  const still = world((x) => {
    paid(x);
    x.workspaces = [workspace({ status: "provisioning" })];
  });
  const s = await visit("account", { routes: still.routes });
  assert.deepEqual(s.labels("workspaces"), [], "a workspace that is starting cannot be opened");
});

test("pausing and resuming are one request each, with the row saying what is under way and what came of it", async () => {
  const w = world((x) => {
    paid(x);
    x.workspaces = [workspace()];
  });
  w.answers.set("POST /api/workspaces/ws_1/suspend", () => {
    w.workspaces = [workspace({ status: "suspended", statusReason: "paused by its owner" })];
    return { json: { workspace: w.workspaces[0] } };
  });
  w.answers.set("POST /api/workspaces/ws_1/resume", () => {
    w.workspaces = [workspace()];
    return { json: { workspace: w.workspaces[0] } };
  });
  const v = await visit("account", { routes: w.routes });
  const pause = v.button("workspaces", "Pause");
  pause.focus();
  v.click(pause);
  assert.match(v.text("workspaces"), /Pausing it\./, "while the request is out the row says so");
  assert.ok(v.buttons("workspaces").every((b) => b.held), "and its buttons are held");
  assert.ok(v.$("pause-ws_1") === pause && v.doc.activeElement === pause, "the button that was pressed is the one with the cursor, and was not drawn again");
  await v.idle();
  assert.equal(v.text("workspaces"), "Research Stopped Paused by you. Its files are kept. Resume it to open it. Resume More Address research-1a2b3c.ws.example.com");
  v.click(v.button("workspaces", "Resume"));
  await v.idle();
  assert.match(v.text("workspaces"), /^Research Running Open Pause More Address /);
  assert.equal(v.to("POST", "/api/workspaces/ws_1/suspend").length, 1);
  assert.equal(v.to("POST", "/api/workspaces/ws_1/resume").length, 1);

  w.answers.set("POST /api/workspaces/ws_1/suspend", failure(409, "not_running", "That workspace is not running."));
  v.click(v.button("workspaces", "Pause"));
  await v.idle();
  assert.match(v.text("workspaces"), /That workspace is not running\. Address /, "a refusal is said on the row it is about");

  const pay = world((x) => {
    paid(x);
    x.workspaces = [workspace({ status: "suspended", statusReason: "payment is overdue" })];
  });
  pay.answers.set("POST /api/workspaces/ws_1/resume", failure(402, "payment_overdue", "Payment is needed before this workspace can run."));
  const p = await visit("account", { routes: pay.routes });
  p.click(p.button("workspaces", "Resume"));
  await p.idle();
  assert.match(p.text("workspaces"), /Payment is needed before this workspace can run\. Address /);
});

test("deleting a workspace needs its name typed; until it is, the button does nothing, and cancelling leaves the workspace and the field", async () => {
  const w = world((x) => {
    paid(x);
    x.workspaces = [workspace()];
  });
  w.answers.set("POST /api/workspaces/ws_1/delete", () => {
    w.workspaces = [];
    return { json: { ok: true } };
  });
  const v = await visit("account", { routes: w.routes });
  assert.equal(v.shows(v.$("delete-ws_1")), false, "the button that deletes is not beside the one that opens");
  const more = v.button("workspaces", "More");
  assert.deepEqual([more.getAttribute("aria-expanded"), more.getAttribute("aria-controls"), more.getAttribute("aria-label")], ["false", "more-panel-ws_1", "More actions for Research"]);
  v.click(more);
  assert.equal(v.$("more-ws_1").getAttribute("aria-expanded"), "true");
  assert.equal(v.doc.activeElement, v.$("more-ws_1"), "the cursor stays on the button that was pressed");
  assert.equal(v.shows(v.$("delete-ws_1")), true);
  v.click(v.$("more-ws_1"));
  assert.equal(v.$("more-ws_1").getAttribute("aria-expanded"), "false", "the same button puts it away again");
  assert.equal(v.shows(v.$("delete-ws_1")), false);
  v.click(v.$("more-ws_1"));
  v.click(v.button("workspaces", "Delete this workspace"));
  const input = v.$("confirm-ws_1");
  assert.equal(v.doc.activeElement, input, "the cursor is in the field that has to be filled");
  assert.match(v.text("workspaces"), /Deleting Research removes it and everything in it\. It cannot be undone\./);
  assert.equal(v.button("workspaces", "Delete workspace").disabled, true);
  v.type(input, "Resear");
  assert.equal(v.button("workspaces", "Delete workspace").disabled, true);
  v.type(input, "research");
  assert.equal(v.button("workspaces", "Delete workspace").disabled, true, "the name is matched exactly");
  await v.send(v.doc.querySelector("form.confirm")!);
  assert.deepEqual(v.to("POST", "/api/workspaces/ws_1/delete"), [], "Enter in the field does not delete either");

  v.click(v.button("workspaces", "Keep it"));
  assert.equal(v.doc.getElementById("confirm-ws_1"), null);
  assert.equal(v.text("workspaces").startsWith("Research Running"), true);
  v.click(v.button("workspaces", "Delete this workspace"));
  assert.equal(v.$("confirm-ws_1").value, "", "a second time starts from nothing");
  v.type("confirm-ws_1", "Research");
  assert.equal(v.button("workspaces", "Delete workspace").disabled, false);
  v.click(v.button("workspaces", "Delete workspace"));
  await v.idle();
  assert.deepEqual(v.to("POST", "/api/workspaces/ws_1/delete"), [{ method: "POST", path: "/api/workspaces/ws_1/delete", body: { confirm: "Research" } }]);
  assert.equal(v.shows(v.$("workspaces-panel")), false, "there is nothing to list");
  assert.equal(v.text("stage-title"), "Make your first workspace");
  assert.equal(v.shows(v.$("create")), true, "the place is free again");
});

test("a confirmation that is open stays open, with what was typed, when the page looks again; and Enter in the field deletes when the name is right", async () => {
  const w = world((x) => {
    paid(x);
    x.workspaces = [workspace(), workspace({ workspaceId: "ws_2", name: "Other", status: "provisioning" })];
    x.subscription = { ...ACTIVE!, plan: "business", title: "Business" };
  });
  w.answers.set("POST /api/workspaces/ws_1/delete", { json: { ok: true } });
  const v = await visit("account", { routes: w.routes });
  const first = (): FakeNode => v.$("workspaces").querySelectorAll("li")[0]!;
  v.click(v.button(first(), "More"));
  v.click(v.button(first(), "Delete this workspace"));
  v.type("confirm-ws_1", "Resea");
  w.workspaces = [workspace(), workspace({ workspaceId: "ws_2", name: "Other", status: "running" })];
  await v.until("the other workspace to show as running", () => /Other Running/.test(v.text("workspaces")));
  assert.equal(v.$("confirm-ws_1").value, "Resea", "what was typed survives the page being redrawn");
  assert.equal(v.doc.activeElement, v.$("confirm-ws_1"), "and so does the cursor");
  v.type("confirm-ws_1", "Research");
  await v.send(v.doc.querySelector("form.confirm")!);
  assert.equal(v.to("POST", "/api/workspaces/ws_1/delete").length, 1);
});

// ---- credit ----

test("the field for another amount says its currency and shows an amount in that currency's places before anything is typed", async () => {
  const w = world(paid);
  const v = await visit("account", { routes: w.routes });
  assert.equal(v.text("topup-unit"), "(USD)");
  assert.equal(v.$("topup-amount").getAttribute("placeholder"), "25.00", "one of the amounts that can be bought, as it is typed");
  assert.match(v.text(v.doc.querySelector("label[for=\"topup-amount\"]") ?? v.$("topup-unit")), /Another amount/);
  const yen = world(paid);
  yen.plans = { json: { ...PLANS, currency: "JPY", topups: { optionsMinor: [1_000, 5_000], minimumMinor: 500, maximumMinor: 100_000, usageMicrosPerMinor: 1_000_000 } } };
  const y = await visit("account", { routes: yen.routes });
  assert.equal(y.text("topup-unit"), "(JPY)");
  assert.equal(y.$("topup-amount").getAttribute("placeholder"), "5000", "a currency with no places is shown with none");
  const none = world(paid);
  none.plans = { json: { ...PLANS, topups: null } };
  assert.equal((await visit("account", { routes: none.routes })).$("topup-amount").getAttribute("placeholder"), null, "a service that sells no credit has nothing to show");
  assert.equal(helpers().bareAmount(2_500, "USD"), "25.00");
  assert.equal(helpers().bareAmount(500, "JPY"), "500");
});

test("a quick amount goes straight to its payment page, and what the account looked like is remembered for the return", async () => {
  const w = world(paid);
  w.answers.set("POST /api/checkout", { json: { url: "https://pay.example/c/topup" } });
  const v = await visit("account", { routes: w.routes });
  v.click(v.button("topup-options", "Add $25.00"));
  await v.idle();
  assert.deepEqual(v.to("POST", "/api/checkout"), [{ method: "POST", path: "/api/checkout", body: { purpose: "topup", amountMinor: 2_500 } }]);
  assert.deepEqual(v.navigations, ["assign https://pay.example/c/topup"]);
  assert.equal(v.storage.get("curule:before-payment"), JSON.stringify([["team", "active", "2026-11-05T12:00:00.000Z"], [20_000_000, 0]]));

  w.answers.set("POST /api/checkout", failure(400, "invalid_amount", "That amount cannot be bought."));
  const again = await visit("account", { routes: w.routes });
  again.click(again.button("topup-options", "Add $10.00"));
  await again.idle();
  assert.equal(again.text("topup-status"), "That amount cannot be bought.");
});

test("an amount typed by hand is checked against what can be bought before anything is asked, and is sent in minor units", async () => {
  const w = world(paid);
  w.answers.set("POST /api/checkout", { json: { url: "https://pay.example/c/other" } });
  const v = await visit("account", { routes: w.routes });
  const tries: Array<[string, string]> = [
    ["", "Enter an amount such as $10.00."],
    ["1e3", "Enter an amount such as $10.00."],
    ["10.505", "Enter an amount such as $10.00."],
    ["4", "The smallest amount is $5.00."],
    ["4.99", "The smallest amount is $5.00."],
    ["1000.01", "The largest amount is $1,000.00."],
    ["5000", "The largest amount is $1,000.00."],
  ];
  for (const [typed, said] of tries) {
    v.type("topup-amount", typed);
    await v.send(v.$("topup"));
    assert.equal(v.text("topup-status"), said, JSON.stringify(typed));
    assert.equal(v.$("topup-amount").getAttribute("aria-invalid"), "true");
  }
  assert.deepEqual(v.to("POST", "/api/checkout"), []);
  v.type("topup-amount", "12.50");
  assert.equal(v.$("topup-amount").getAttribute("aria-invalid"), null);
  await v.send(v.$("topup"));
  assert.deepEqual(v.to("POST", "/api/checkout"), [{ method: "POST", path: "/api/checkout", body: { purpose: "topup", amountMinor: 1_250 } }]);
  assert.deepEqual(v.navigations, ["assign https://pay.example/c/other"]);

  w.answers.set("POST /api/checkout", { json: { url: "javascript:alert(1)" } });
  const u = await visit("account", { routes: w.routes });
  u.type("topup-amount", "10");
  await u.send(u.$("topup"));
  assert.deepEqual(u.navigations, []);
  assert.equal(u.text("topup-status"), "The payment page could not be opened. Try again in a moment.");
});

test("what is typed for credit is read in the currency's own places: a currency with none takes whole numbers only", async () => {
  const w = world(paid);
  w.plans = { json: { ...PLANS, currency: "JPY", topups: { optionsMinor: [1_000, 5_000], minimumMinor: 500, maximumMinor: 100_000, usageMicrosPerMinor: 1_000_000 } } };
  w.answers.set("POST /api/checkout", { json: { url: "https://pay.example/c/yen" } });
  const v = await visit("account", { routes: w.routes });
  assert.deepEqual(v.labels("topup-options"), ["Add ¥1,000", "Add ¥5,000"]);
  assert.equal(v.text("topup-hint"), "From ¥500 to ¥100,000. Each ¥1 adds ¥1 of usage, and credit does not expire.");
  v.type("topup-amount", "1500.5");
  await v.send(v.$("topup"));
  assert.equal(v.text("topup-status"), "Enter an amount such as ¥1,000.");
  v.type("topup-amount", "1500");
  await v.send(v.$("topup"));
  assert.deepEqual(v.to("POST", "/api/checkout")[0]!.body, { purpose: "topup", amountMinor: 1_500 });
});

// ---- coming back from the payment page ----

const BEFORE = "curule:before-payment";
const NOTHING_YET = JSON.stringify([null, [20_000_000, 0]]);
const THANKS_KNOWN = "Thank you. The payment provider confirms a payment a few moments after checkout, and this page updates when yours is confirmed.";
const THANKS_UNKNOWN = "Thank you. The payment provider confirms a payment a few moments after checkout, and your plan and balance below update when it does.";

test("coming back from a payment that was applied while the person was away: what was remembered is compared with now, and it is said at once", async () => {
  const w = world(paid);
  w.balance = balance({ purchased: 10_000_000 });
  const v = await visit("account", { routes: w.routes, search: "?paid=1", storage: { [BEFORE]: JSON.stringify([["team", "active", "2026-11-05T12:00:00.000Z"], [20_000_000, 0]]) } });
  assert.equal(v.text("notice"), "Your payment has arrived.");
  assert.equal(v.$("notice").className, "note note-ok");
  assert.equal(v.storage.has(BEFORE), false, "what was remembered is used once");
  assert.deepEqual(v.history, ["/account"], "and the query leaves the address");
  assert.equal(v.to("GET", "/api/me").length, 1, "there is nothing to wait for");
});

test("coming back from a payment that has not been applied yet: the page says it is being confirmed, asks again until it shows, and then says so", async () => {
  const w = world();
  const v = new Visit("account", { routes: w.routes, search: "?paid=1", storage: { [BEFORE]: NOTHING_YET } });
  const started = v.start();
  await v.until("the notice that the payment is being confirmed", () => v.text("notice") === THANKS_KNOWN);
  // The provider's message arrives while the page is waiting.
  w.subscription = ACTIVE;
  w.balance = balance({ included: 20_000_000 });
  await started;
  await v.until("the arrival to be seen", () => v.text("notice") === "Your payment has arrived.");
  assert.match(v.text("plan"), /Team Active \$149\.00 per month\. Paid until November 5, 2026\./);
  assert.equal(v.shows(v.$("create")), true, "with a plan the person can create a workspace");
});

test("a payment that does not show up in a minute is said to be on its way, and nothing more is asked of the person", async () => {
  const w = world();
  const v = await visit("account", { routes: w.routes, search: "?paid=1", storage: { [BEFORE]: NOTHING_YET } });
  await v.until("the page to give up waiting", () => /has not shown up yet/.test(v.text("notice")), 5_000);
  assert.equal(v.text("notice"), "Your payment has not shown up yet. It can take a few minutes, and nothing more is needed from you. Reload this page later to see it.");
  assert.equal(v.$("notice").className, "note note-warn");
  assert.equal(v.to("GET", "/api/me").length, 21, "one look on arrival and twenty more while it waited");
});

test("coming back with nothing remembered (another tab, a browser that keeps nothing): the page cannot say whether the payment has landed, and does not pretend to", async () => {
  const landed = world(paid);
  landed.balance = balance({ purchased: 10_000_000 });
  const v = await visit("account", { routes: landed.routes, search: "?paid=1" });
  assert.equal(v.text("notice"), THANKS_UNKNOWN);
  await v.until("the page to stop waiting", () => /^If your payment is not in the figures below yet/.test(v.text("notice")), 5_000);
  assert.equal(v.text("notice"), "If your payment is not in the figures below yet, it can take a few minutes. Nothing more is needed from you. Reload this page later to see it.");
  assert.equal(v.$("notice").className, "note", "it is not a warning: the figures may already show it");
  assert.match(v.text("figures"), /^Available \$30\.00 /);

  const later = world();
  const w = await visit("account", { routes: later.routes, search: "?paid=1" });
  assert.equal(w.text("notice"), THANKS_UNKNOWN);
  later.subscription = ACTIVE;
  await w.until("the arrival to be seen", () => w.text("notice") === "Your payment has arrived.");
});

test("a checkout that was cancelled says nothing was charged and that what there was is as it was, and leaves the address", async () => {
  const w = world(paid);
  const v = await visit("account", { routes: w.routes, search: "?cancelled=1" });
  assert.equal(v.text("notice"), "Checkout was cancelled. Nothing was charged, and your plan and balance are as they were.");
  assert.deepEqual(v.history, ["/account"]);
  assert.equal(v.to("GET", "/api/me").length, 1);
  const h = await visit("account", { routes: hosting().routes, search: "?cancelled=1" });
  assert.equal(h.text("notice"), "Checkout was cancelled. Nothing was charged, and your plan is as it was.", "a plan that sells hosting only has no balance to speak of");
});

test("the back button returns to a page that is drawn again from the service, not one frozen with a payment page's button pressed", async () => {
  const w = world(paid);
  const v = await visit("account", { routes: w.routes });
  v.pageshow(false);
  assert.deepEqual(v.navigations, []);
  v.pageshow(true);
  assert.deepEqual(v.navigations, ["reload"]);
});

// ---- usage ----

test("usage is a table by day and one by workspace, with a total, the charge in four places, and a deleted workspace named plainly", async () => {
  const row = (group: string, calls: number, charged: number, failed = 0) => ({ group, calls, failed, inputTokens: calls * 100, outputTokens: calls * 20, cachedTokens: 0, chargedMicros: charged });
  const w = world((x) => {
    paid(x);
    x.workspaces = [workspace()];
    x.usage = {
      currency: "USD",
      byDay: [row("2026-10-03", 2, 800), row("2026-10-05", 3, 8_400), row("2026-10-04", 1, 400)],
      byWorkspace: [row("ws_1", 4, 9_000), row("ws_gone", 2, 600), row("", 0, 0)],
      total: { calls: 6, failed: 0, inputTokens: 600, outputTokens: 120, cachedTokens: 0, chargedMicros: 9_600 },
    };
  });
  const v = await visit("account", { routes: w.routes });
  const tables = v.$("usage").querySelectorAll("table");
  assert.equal(tables.length, 2);
  const rows = (t: (typeof tables)[number]) => t.querySelectorAll("tr").map((r) => v.text(r));
  assert.deepEqual(rows(tables[0]!), [
    "Day Calls Input tokens Output tokens Charged",
    "Oct 5, 2026 3 300 60 $0.0084",
    "Oct 4, 2026 1 100 20 $0.0004",
    "Oct 3, 2026 2 200 40 $0.0008",
    "Total 6 600 120 $0.0096",
  ]);
  assert.deepEqual(rows(tables[1]!), ["Workspace Calls Input tokens Output tokens Charged", "Research 4 400 80 $0.009", "A deleted workspace 2 200 40 $0.0006", "No workspace 0 0 0 $0.00"]);
  const wrap = v.$("usage").querySelector(".table-wrap")!;
  assert.equal(wrap.getAttribute("tabindex"), "0", "a table that scrolls sideways can be reached by keyboard");
  assert.equal(wrap.getAttribute("role"), "region");
  assert.equal(wrap.getAttribute("aria-label"), "By day, the last 14 days with calls");
});

test("usage shows only the last fourteen days, newest first, and a Failed column only when something failed", async () => {
  const days = Array.from({ length: 20 }, (_v, i) => ({ group: `2026-09-${String(i + 1).padStart(2, "0")}`, calls: 1, failed: i === 0 ? 1 : 0, inputTokens: 10, outputTokens: 5, cachedTokens: 0, chargedMicros: 100 }));
  const w = world((x) => {
    paid(x);
    x.usage = { currency: "USD", byDay: days, byWorkspace: [], total: { calls: 20, failed: 1, inputTokens: 200, outputTokens: 100, cachedTokens: 0, chargedMicros: 2_000 } };
  });
  const v = await visit("account", { routes: w.routes });
  const first = v.$("usage").querySelectorAll("table")[0]!;
  const rows = first.querySelectorAll("tbody tr");
  assert.equal(rows.length, 14);
  assert.match(v.text(rows[0]!), /^Sep 20, 2026 /);
  assert.match(v.text(rows[13]!), /^Sep 7, 2026 /);
  assert.equal(v.text(first.querySelector("thead tr")!), "Day Calls Failed Input tokens Output tokens Charged");
  assert.equal(v.text(first.querySelector("tfoot tr")!), "Total 20 1 200 100 $0.002");
});

test("usage that cannot be read says so and can be asked for again", async () => {
  const w = world((x) => {
    paid(x);
    x.workspaces = [workspace()];
  });
  w.answers.set("GET /api/usage", failure(502, "usage_unavailable", "Usage could not be read just now. Try again in a moment."));
  const v = await visit("account", { routes: w.routes });
  assert.equal(v.text("usage"), "Usage could not be read just now. Try again in a moment. Try again");
  w.answers.set("GET /api/usage", { json: NO_USAGE });
  v.click(v.button("usage", "Try again"));
  await v.idle();
  assert.match(v.text("usage"), /^Nothing has been used yet\./);
});

// ---- the password ----

test("changing the password sends both, says it is done, and empties the fields; a wrong current password is said and does not sign the person out", async () => {
  const w = world(paid);
  w.answers.set("POST /api/password", failure(403, "invalid_credentials", "The current password is not right."));
  const v = await visit("account", { routes: w.routes });
  await v.send(v.$("password-form"));
  assert.equal(v.text("password-status"), "Enter your current password.");
  v.type("current", "old");
  await v.send(v.$("password-form"));
  assert.equal(v.text("password-status"), "Choose a new password of at least 10 characters.");
  assert.equal(v.doc.activeElement, v.$("next"));
  v.type("next", "a much better password");
  await v.send(v.$("password-form"));
  assert.equal(v.text("password-status"), "The current password is not right.");
  assert.deepEqual(v.navigations, [], "a 403 for the wrong password is not a signed-out session");
  assert.equal(v.$("current").value, "old", "the fields are kept for another try");

  w.answers.set("POST /api/password", { json: { ok: true } });
  v.type("current", "the right one");
  await v.send(v.$("password-form"));
  assert.deepEqual(v.to("POST", "/api/password").at(-1)!.body, { current: "the right one", next: "a much better password" });
  assert.equal(v.text("password-status"), "Your password is changed. Every other device is signed out.");
  assert.equal(v.$("password-status").className, "note note-ok");
  assert.equal(v.$("current").value, "");
  assert.equal(v.$("next").value, "");
});

// ---- nothing a person or the service writes becomes markup ----

test("names and addresses are shown as text: a workspace named like markup is a name, and creates no element", async () => {
  const evil = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const w = world((x) => {
    paid(x);
    x.email = "<b>ada</b>@example.com";
    x.workspaces = [workspace({ name: evil }), workspace({ workspaceId: "ws_2", name: "Gone", status: "failed", statusReason: "<i>why</i>" })];
    x.usage = { currency: "USD", byDay: [], byWorkspace: [{ group: "ws_1", calls: 1, failed: 0, inputTokens: 1, outputTokens: 1, cachedTokens: 0, chargedMicros: 1 }], total: { calls: 1, failed: 0, inputTokens: 1, outputTokens: 1, cachedTokens: 0, chargedMicros: 1 } };
  });
  const v = await visit("account", { routes: w.routes });
  assert.equal(v.text("who"), "Signed in as <b>ada</b>@example.com");
  assert.equal(v.$("who").children.length, 1, "the address is one text node");
  assert.ok(v.text("workspaces").startsWith(`${evil} Running `), v.text("workspaces"));
  assert.ok(v.text("workspaces").includes("<i>why</i>. Delete it and make a new one."), "a reason is text too");
  assert.ok(v.text("usage").includes(evil), "and so is a name in the usage tables");
  assert.equal(v.text("stage-title"), `${evil} is running`, "and in the card at the top");
  const inside = (id: string): string[] => v.$(id).descendants().map((n) => n.tag);
  for (const id of ["workspaces", "usage", "who", "stage"]) for (const tag of ["img", "script", "b", "i"]) assert.ok(!inside(id).includes(tag), `no <${tag}> inside #${id}`);
  v.click(v.button("workspaces", "More"));
  v.click(v.button(v.$("workspaces").querySelectorAll("li")[0]!, "Delete this workspace"));
  assert.ok(v.text("workspaces").includes(`Deleting ${evil} removes it`));
  assert.ok(!inside("workspaces").includes("img"));
});

test("the script builds no markup from strings, runs no string as code, and writes no inline style", async () => {
  const source = fs.readFileSync(SCRIPT, "utf8");
  for (const forbidden of [/\binnerHTML\b/, /\bouterHTML\b/, /\binsertAdjacentHTML\b/, /\bdocument\.write\b/, /\beval\s*\(/, /\bnew Function\b/, /\bsetTimeout\s*\(\s*["'`]/, /\bsetInterval\s*\(\s*["'`]/, /\.style\b/, /["']style["']/, /\blocalStorage\b/, /\bdocument\.cookie\b/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\bimportScripts\b/, /\bimport\s*\(/]) {
    assert.doesNotMatch(source, forbidden, `app.js must not use ${forbidden}`);
  }
});

// A page that is the sum of what was tested above must not leave a console error behind.
test("no page logs an error to the console in the ordinary cases", async () => {
  const w = world((x) => {
    paid(x);
    x.workspaces = [workspace()];
  });
  for (const page of ["home", "account"]) {
    const v: Visit = await visit(page, { routes: w.routes });
    assert.deepEqual(v.consoleErrors, [], page);
  }
  const out = world((x) => (x.signedIn = false));
  for (const page of ["home", "signup", "login", "forgot", "terms", "privacy"]) assert.deepEqual((await visit(page, { routes: out.routes })).consoleErrors, [], page);
});

// ---- the customer's own model key ----

test("the account page of a hosting-only service says the key stays with the workspace and nothing is resold, and has no balance, credit or usage to show", async () => {
  const w = hosting();
  const v = await visit("account", { routes: w.routes });
  assert.equal(v.doc.getElementById("models-panel"), null, "the key is in the card of the workspace it is for, not in a panel of its own");
  assert.match(v.text("workspaces"), /Your key stays with your workspace\. Curule does not resell model usage, so you pay your provider directly\./);
  assert.equal(v.shows(v.$("balance-panel")), false, "no balance is kept");
  assert.equal(v.shows(v.$("usage-panel")), false);
  assert.equal(v.to("GET", "/api/usage").length, 0, "and the page does not ask for usage the service does not have");
  assert.equal(v.text("topup-options"), "");
  assert.match(v.text("plan"), /^Hosting Active \$49\.00 per month\. Paid until November 5, 2026\. Your own model key; you pay your provider directly 1 workspace Manage billing$/, "the plan the account is on is shown, and there is no other to change to");
});

test("a service that sells usage shows no model key in a workspace's card, and still shows the balance and the usage", async () => {
  const w = world((x) => {
    paid(x);
    x.workspaces = [workspace()];
  });
  const v = await visit("account", { routes: w.routes });
  assert.equal(v.doc.root.descendants().filter((n) => n.id.startsWith("key-")).length, 0);
  assert.equal(v.shows(v.$("balance-panel")), true);
  assert.equal(v.shows(v.$("usage-panel")), true);
  assert.equal(v.to("GET", "/api/usage").length, 1);
});

test("the front page of a hosting-only service says the customer brings a key and pays their provider, lists the plan as hosting, and offers no credit", async () => {
  const w = world((x) => {
    x.signedIn = false;
    x.plans = { json: HOSTING_PLANS };
  });
  const v = await visit("home", { routes: w.routes });
  const cards = v.$("plans").querySelectorAll("article");
  assert.equal(cards.length, 1);
  assert.equal(v.text(cards[0]!), "Hosting $49.00 per month One workspace. Bring your own model key. Your own model key; you pay your provider directly 1 workspace Start with Hosting");
  assert.equal(v.text("topups"), "Curule does not resell model usage. You bring your own model key and pay your provider directly.");
  assert.doesNotMatch(v.text("topups"), /Add credit/);
});

test("what the front page says about model usage is shown for a service that sells none, and left out for one that sells credit, whose plans say what they include", async () => {
  const hostingOnly = world((x) => {
    x.signedIn = false;
    x.plans = { json: HOSTING_PLANS };
  });
  const hosting = await visit("home", { routes: hostingOnly.routes });
  for (const claim of [/You bring your own model key, and you pay your model provider directly\./, /Your own model key/, /Hosting, not tokens/, /It is not part of the payment/]) assert.match(hosting.text("main"), claim, String(claim));

  const credit = world((x) => (x.signedIn = false));
  const sells = await visit("home", { routes: credit.routes });
  for (const claim of [/bring your own model key/i, /Your own model key/, /Hosting, not tokens/, /does not resell/, /not part of the payment/, /pay your (model )?provider/i]) assert.doesNotMatch(sells.text("main"), claim, `a service that sells usage does not say ${claim}`);
  assert.match(sells.text("main"), /\$20\.00 of model usage each month/, "it says what its plans include");
  assert.match(sells.text("topups"), /Add credit at any time/);
  assert.match(sells.text("main"), /You install nothing and rent nothing\./, "and the rest of the sentence it was part of is still there");

  const unknown = world((x) => {
    x.signedIn = false;
    x.plans = failure(503, "unavailable", "The plans are not available just now.");
  });
  const down = await visit("home", { routes: unknown.routes });
  assert.match(down.text("main"), /Hosting, not tokens/, "when the plans cannot be read the page says what it was written to say");
  for (const html of ["index.html"]) {
    const page = fs.readFileSync(`${PAGES_DIR}/${html}`, "utf8");
    assert.equal((page.match(/data-hosting-only/g) ?? []).length, 5, "the five places that speak of model usage are marked: the line under the heading, two of the facts, the third step of how it works, and one of the billing facts");
    assert.equal((page.match(/data-usage-sold/g) ?? []).length, 1, "and the one place that says what a service that sells credit does in its place");
  }
});

test("the front page says how it works in four steps, in order, from what the service does, and the third is as the service sells", async () => {
  const hostingOnly = world((x) => {
    x.signedIn = false;
    x.plans = { json: HOSTING_PLANS };
  });
  const steps = (v: Visit) => v.$("main").querySelector("ol.how")!.querySelectorAll("li");
  const h = await visit("home", { routes: hostingOnly.routes });
  assert.equal(h.text(h.$("how-h")), "How it works");
  assert.equal(h.$("main").querySelector("ol.how")!.getAttribute("role"), "list", "a list that is drawn with no bullets is still a list, to every screen reader");
  assert.equal(h.$("main").querySelector("ol.how")!.parent!.getAttribute("aria-labelledby"), "how-h", "and it is a region named by its heading");
  assert.deepEqual(steps(h).map((li) => h.text(li)), [
    "Sign up An email and a password. We send a link to confirm your address.",
    "Pick a plan A flat price for hosting your workspace, paid on the payment provider's page.",
    "Make a workspace One click starts your own Curule host. You give it your model key once it has started.",
    "Describe your team and start Open the workspace in your browser, describe the team you want, and start a mission.",
  ]);

  const sells = await visit("home", { routes: world((x) => (x.signedIn = false)).routes });
  assert.equal(sells.text(steps(sells)[2]!), "Make a workspace One click starts your own Curule host, with the service's models ready to use. Each plan lists the usage it includes.");
  assert.deepEqual(steps(sells).map((li) => sells.text(li.querySelector("strong")!)), ["Sign up", "Pick a plan", "Make a workspace", "Describe your team and start"]);

  const unknown = await visit("home", { routes: world((x) => { x.signedIn = false; x.plans = failure(503, "unavailable", "The plans are not available just now."); }).routes });
  assert.match(unknown.text(steps(unknown)[2]!), /You give it your model key once it has started\./, "when the plans cannot be read the page says what it was written to say, which is what a page with no script says too");
  assert.doesNotMatch(unknown.text(steps(unknown)[2]!), /service's models/);
});

test("each plan card has one action and it names the plan, and what a plan has is a list a person reads at a glance", async () => {
  const v = await visit("home", { routes: world((x) => (x.signedIn = false)).routes });
  const cards = v.$("plans").querySelectorAll("article");
  const actions = cards.map((c) => [...c.querySelectorAll("a"), ...c.querySelectorAll("button")].map((a) => v.text(a)));
  assert.deepEqual(actions, [["Start with Team"], ["Start with Business"]], "one each, and not two buttons that both say Get started");
  assert.deepEqual(cards.map((c) => c.querySelector("a")!.className), ["btn btn-primary", "btn btn-primary"], "and it is the card's main action");
  assert.deepEqual(cards.map((c) => c.querySelectorAll("li").length), [3, 2], "what a plan has, a line each: usage, workspaces and, where there are some, tiers");
  assert.deepEqual(cards.map((c) => c.querySelectorAll("ul").length), [1, 1]);
});

test("a workspace with no key says so and asks for a provider, a model and a key; an Anthropic key needs no address", async () => {
  const w = hosting();
  const v = await visit("account", { routes: w.routes });
  const key = v.$("workspaces").querySelector(".ws-key")!;
  assert.match(v.text(key), /^Model key No key yet Until you give it a key, a team in this workspace has no model to run on\. Your key stays with your workspace\./);
  assert.equal(v.shows(v.$("key-form-ws_1")), true, "with no key the form is open");
  assert.equal(v.shows(v.$("key-base-ws_1")), false, "Anthropic is called at its own address");
  assert.equal(v.$("key-secret-ws_1").getAttribute("type"), "password", "the key is typed into a field that shows nothing");
  assert.equal(v.$("key-secret-ws_1").getAttribute("autocomplete"), "off");
  assert.equal(v.labels(key).join("|"), "Save key");
  assert.match(v.text(key), /Paste it here once\. It is never shown again/);
});

test("saving a key sends the provider, model and key once, empties the field whatever the answer, and says what happened without the key in it", async () => {
  const w = hosting();
  w.answers.set("POST /api/workspaces/ws_1/model-key", () => {
    w.workspaces = [workspace({ plan: "hosting", models: { source: "own", key: KEPT } })];
    return { json: { workspace: w.workspaces[0] } };
  });
  const v = await visit("account", { routes: w.routes });
  v.type("key-model-ws_1", "claude-sonnet-4-5");
  v.type("key-secret-ws_1", `  ${SECRET} `);
  await v.send(v.$("key-form-ws_1"));
  const sent = v.to("POST", "/api/workspaces/ws_1/model-key");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!.body, { provider: "anthropic", model: "claude-sonnet-4-5", key: SECRET });
  assert.match(v.text("notice"), /The key for Research is kept, and the workspace was started again with it\./);
  const key = v.$("workspaces").querySelector(".ws-key")!;
  assert.match(v.text(key), /^Model key Key kept Anthropic, model claude-sonnet-4-5\. Set .*The key itself is never shown again\. Replace key Remove key$/);
  assert.equal(v.shows(v.$("key-form-ws_1")), false, "with a key kept the form is put away behind Replace key");
  assert.ok(!v.doc.root.descendants().some((n) => n.textContent.includes(SECRET) || n.value === SECRET || [...n.attrs.values()].some((a) => a.includes(SECRET))), "the key is nowhere in the page once it is sent");
  assert.equal(v.$("key-secret-ws_1").value, "");
});

test("an openai-compatible provider asks for its address, which must be https, and sends it with the key", async () => {
  const w = hosting();
  w.answers.set("POST /api/workspaces/ws_1/model-key", () => ({ json: { workspace: w.workspaces[0] } }));
  const v = await visit("account", { routes: w.routes });
  v.type("key-provider-ws_1", "openai-compatible");
  assert.equal(v.shows(v.$("key-base-ws_1")), true);
  v.type("key-model-ws_1", "openai/gpt-4o");
  v.type("key-secret-ws_1", SECRET);
  v.type("key-base-ws_1", "http://openrouter.ai/api/v1");
  await v.send(v.$("key-form-ws_1"));
  assert.equal(v.to("POST", "/api/workspaces/ws_1/model-key").length, 0, "nothing is sent over http");
  assert.equal(v.text("key-note-ws_1"), "Give your provider's address, starting with https://.");
  assert.equal(v.$("key-base-ws_1").getAttribute("aria-invalid"), "true");
  v.type("key-base-ws_1", "https://openrouter.ai/api/v1");
  await v.send(v.$("key-form-ws_1"));
  assert.deepEqual(v.to("POST", "/api/workspaces/ws_1/model-key")[0]!.body, { provider: "openai-compatible", model: "openai/gpt-4o", key: SECRET, baseUrl: "https://openrouter.ai/api/v1" });
});

test("a key that is missing, short or has spaces in it is said before anything is sent, and the cursor goes to the field", async () => {
  const v = await visit("account", { routes: hosting().routes });
  await v.send(v.$("key-form-ws_1"));
  assert.equal(v.text("key-note-ws_1"), "Name the model your teams should run on, as your provider names it.");
  assert.equal(v.$("key-model-ws_1").getAttribute("aria-invalid"), "true");
  v.type("key-model-ws_1", "claude-sonnet-4-5");
  for (const bad of ["", "short", "has a space in it"]) {
    v.type("key-secret-ws_1", bad);
    await v.send(v.$("key-form-ws_1"));
    assert.equal(v.text("key-note-ws_1"), "Paste the whole key, with no spaces.", JSON.stringify(bad));
  }
  assert.equal(v.to("POST", "/api/workspaces/ws_1/model-key").length, 0);
});

test("a key the service refuses is said in the service's words, without the key, and the field is empty again", async () => {
  const w = hosting();
  w.answers.set("POST /api/workspaces/ws_1/model-key", failure(400, "invalid_base_url", "That address is on this machine or a private network. Give your provider's public https address."));
  const v = await visit("account", { routes: w.routes });
  v.type("key-model-ws_1", "m");
  v.type("key-secret-ws_1", SECRET);
  await v.send(v.$("key-form-ws_1"));
  assert.equal(v.text("key-note-ws_1"), "That address is on this machine or a private network. Give your provider's public https address.");
  assert.equal(v.$("key-secret-ws_1").value, "", "a refused key is not kept in the page either");
  assert.equal(v.labels(v.$("workspaces").querySelector(".ws-key")!).join("|"), "Save key", "and the buttons are back");
});

test("removing a key is one request, says what it means, and leaves the workspace with no key", async () => {
  const w = hosting({ source: "own", key: KEPT });
  w.answers.set("POST /api/workspaces/ws_1/model-key/delete", () => {
    w.workspaces = [workspace({ plan: "hosting", models: { source: "own", key: null } })];
    return { json: { workspace: w.workspaces[0] } };
  });
  const v = await visit("account", { routes: w.routes });
  assert.match(v.text(v.$("workspaces").querySelector(".ws-key")!), /Key kept Anthropic, model claude-sonnet-4-5/);
  v.click(v.button("workspaces", "Remove key"));
  await v.idle();
  assert.equal(v.to("POST", "/api/workspaces/ws_1/model-key/delete").length, 1);
  assert.match(v.text("notice"), /The key for Research is removed\. A team in it has no model to run on until you give it another\./);
  assert.match(v.text(v.$("workspaces").querySelector(".ws-key")!), /No key yet/);
});

test("a workspace that has not started takes no key yet, and a page that looks again does not empty a field somebody is typing in", async () => {
  const starting = await visit("account", { routes: hosting({ source: "own", key: null }, { status: "provisioning" }).routes });
  assert.match(starting.text("workspaces"), /You can set its key once the workspace has started\./);
  assert.equal(starting.doc.root.descendants().filter((n) => n.tag === "form" && n.id.startsWith("key-form")).length, 0);

  // A second workspace is still starting, so the page asks again every few seconds; the first one's row is as it was.
  const w = hosting();
  w.workspaces.push(workspace({ workspaceId: "ws_2", name: "Second", plan: "hosting", status: "provisioning", host: "second.ws.example.com", models: { source: "own", key: null } }));
  const v = await visit("account", { routes: w.routes });
  v.type("key-model-ws_1", "claude-sonnet-4-5");
  v.type("key-secret-ws_1", SECRET);
  const form = v.$("key-form-ws_1");
  const looks = v.to("GET", "/api/me").length;
  await v.until("the page to look at the account again", () => v.to("GET", "/api/me").length >= looks + 2);
  await v.idle();
  assert.ok(v.$("key-form-ws_1") === form, "the form was not drawn again");
  assert.equal(v.$("key-secret-ws_1").value, SECRET, "and what was typed is still there");
});

test("the script knows no way to read a key back: every call to a key route is a POST, and no key is put in the browser's storage", () => {
  const source = fs.readFileSync(SCRIPT, "utf8");
  const calls = [...source.matchAll(/call\("(\w+)", path\(w, "(model-key[^"]*)"/g)].map((m) => `${m[1]} ${m[2]}`).sort();
  assert.deepEqual(calls, ["POST model-key", "POST model-key/delete"]);
  assert.doesNotMatch(source, /store\.set\([^)]*(?:key|typed|secret)/i, "the page's storage holds the account's look before a payment, and a key is not given to it");
});
