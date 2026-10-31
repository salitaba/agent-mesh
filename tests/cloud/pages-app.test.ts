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

test("the front page's 'from' price is the cheapest plan, compared by the month and said with the period it is charged in", () => {
  const h = helpers();
  assert.equal(h.fromLine(PLANS.plans, "USD"), "From $149.00 a month");
  assert.equal(h.fromLine(HOSTING_PLANS.plans, "USD"), "From $49.00 a month");
  assert.equal(h.fromLine([{ priceMinor: 120_000, period: "year" }, { priceMinor: 12_000, period: "month" }], "USD"), "From $1,200.00 a year", "a year at $100 a month beats a month at $120, and is shown as the year that is charged");
  assert.equal(h.fromLine([{ priceMinor: 5_000, period: "month" }], "JPY"), "From ¥5,000 a month");
  assert.equal(h.fromLine([{ priceMinor: 0, period: "month" }], "USD"), "From $0.00 a month");
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
  assert.equal(v.link(cards[0]!, "Start with Team").getAttribute("href"), "/signup?plan=team", "the plan the visitor picked is carried into signing up, so it is not asked for again as if it had not been");
  assert.equal(v.text("topups"), "Add credit at any time, from $5.00 to $1,000.00 at once. Each $1.00 adds $1.00 of usage, and credit does not expire.");
  const policy = v.doc.querySelectorAll("[data-policy]").map((n) => `${n.dataset.policy}=${n.textContent}`);
  assert.deepEqual(policy, ["graceDays=3 days", "retentionDays=30 days"], "the periods on the page are the service's settings");

  // The page ends where the decision is: a person who read to the foot of a 3,700 px phone page is not left without an action.
  const start = v.$("start");
  assert.equal(v.text(start.querySelector(".section-note")!), "An email and a password, then a plan. Nothing is charged until you have chosen the plan and paid for it.");
  assert.equal(v.link(start, "Create an account").getAttribute("href"), "/signup");
  assert.equal(v.link(start, "Sign in").getAttribute("href"), "/login");
  assert.deepEqual(v.doc.querySelectorAll("[data-from-price]").map((n) => n.textContent), ["From $149.00 a month", "From $149.00 a month"], "the price is said at the top and again at the foot");
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
  assert.equal(v.link(cards[1]!, "Choose Business").getAttribute("href"), "/account?plan=business#plan-h", "and a customer's choice is carried to the plan itself, not to the top of the account");
  assert.equal(v.link(cards[1]!, "Choose Business").className, "btn", "a customer who has a plan is shown the others as a way to change, which is not the main thing");

  const none = await visit("home", { routes: world().routes });
  const open = none.$("plans").querySelectorAll("article");
  assert.deepEqual(open.map((c) => none.link(c, `Choose ${c.querySelector("h3")!.textContent}`).className), ["btn btn-primary", "btn btn-primary"], "and one who has none is taken to choose, which is");
  assert.equal(v.text(v.$("start").querySelector(".btn-row")!), "Go to your account", "and the page's last entry is their account too");
});

test("the policy numbers a page states are changed with the service's settings, with the unit in the singular when it is one", async () => {
  const w = world((x) => {
    x.signedIn = false;
    x.plans = { json: { ...PLANS, policy: { ...PLANS.policy, graceDays: 1, retentionDays: 90, verificationHours: 1, sessionDays: 7, idleDays: 2 } } };
  });
  const verify = await visit("verify", { routes: w.routes });
  assert.deepEqual(verify.doc.querySelectorAll("[data-policy]").map((n) => n.textContent), ["1 hour"]);
  const reset = await visit("reset", { routes: w.routes, search: "?token=t0k3n" });
  const forgot = await visit("forgot", { routes: w.routes });
  assert.deepEqual(reset.doc.querySelectorAll("[data-policy]").map((n) => n.textContent), ["2 hours"], "the page that holds a reset link says how long it lasts");
  assert.deepEqual(forgot.doc.querySelectorAll("[data-policy]").map((n) => n.textContent), ["2 hours"], "and so does the page that asks for one");
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

test("a front page that cannot get the plans says so, claims nothing about model usage, and offers a retry", async () => {
  const w = world((x) => {
    x.signedIn = false;
    x.plans = failure(503, "unavailable", "Down.");
  });
  const v = await visit("home", { routes: w.routes });
  assert.equal(v.text(v.$("plans").querySelector("p")!), "The plans could not be loaded just now, so no price is shown.");
  assert.equal(v.text(v.doc.querySelector("main .price-line")!), "", "no price is claimed when none was read");
  // Before this, the hero said "Plans and prices below" in the same view as "no price is shown": the page contradicted itself.
  assert.doesNotMatch(v.text("main"), /Plans and prices below/, "and it does not promise prices below while saying below that there are none");
  assert.deepEqual(v.doc.querySelectorAll("[data-from-price]").map((n) => n.textContent), ["", ""], "the foot of the page claims no price either");
  for (const claim of [/bring your own model key/i, /Your own model key/, /Hosting, not tokens/, /does not resell/i, /not part of the payment/i, /model usage each month/i, /included usage/i]) assert.doesNotMatch(v.text("main"), claim, `a page that could not read the plans must not say ${claim}`);
  assert.match(v.text("main"), /Model usage, stated/, "it says only what is true of either arrangement: the plan states which it is");
  const retry = v.$("plans").querySelector("button")!;
  assert.equal(v.text(retry), "Try again", "the page offers the action, not just the instruction to reload");

  // The retry asks again, and the page takes the answer.
  w.answers.set("GET /api/plans", { json: PLANS });
  v.click(retry);
  await v.idle();
  assert.equal(v.$("plans").querySelectorAll("article").length, 2);
  assert.deepEqual(v.doc.querySelectorAll("[data-from-price]").map((n) => n.textContent), ["From $149.00 a month", "From $149.00 a month"], "and both lines take the price once it is read");
  assert.match(v.text("main"), /\$20\.00 of model usage each month/);

  assert.deepEqual(v.consoleErrors, []);
  const none = world((x) => {
    x.signedIn = false;
    x.plans = { json: { ...PLANS, plans: [] } };
  });
  const empty = await visit("home", { routes: none.routes });
  assert.equal(empty.text(empty.$("plans").querySelector("p")!), "No plan is on offer just now, so no price is shown.");
  for (const routes of [
    (c: any) => (c.path === "/api/plans" ? { fail: true } : { json: { account: null } }),
    (c: any) => (c.path === "/api/plans" ? { status: 200, raw: "<html>a proxy's page</html>" } : { json: { account: null } }),
  ]) {
    const down = await visit("home", { routes });
    assert.equal(down.text(down.$("plans").querySelector("p")!), "The plans could not be loaded just now, so no price is shown.");
    assert.deepEqual(down.consoleErrors, []);
  }
});

test("the header marks the page a person is on, and only that one", async () => {
  const out = world((x) => (x.signedIn = false));
  const marked = async (page: string, w = out): Promise<string[]> => {
    const v = await visit(page, { routes: w.routes });
    return v.doc.querySelectorAll("header nav a").filter((a) => a.getAttribute("aria-current") === "page").map((a) => v.text(a));
  };
  assert.deepEqual(await marked("home"), ["Plans"]);
  assert.deepEqual(await marked("login"), ["Sign in"]);
  for (const page of ["signup", "forgot", "terms", "404"]) assert.deepEqual(await marked(page), [], `${page} is not in the header`);
  assert.deepEqual(await marked("account", world(paid)), ["Account"]);
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
  // A second press while the first is out is not a second sign-out, and the button is held rather than disabled: the bar is above
  // whatever the person was reading, and a disabled control takes the cursor away, which would send the next Tab to the top of the page.
  s.click(button);
  assert.equal(button.getAttribute("aria-disabled"), "true");
  assert.equal(button.disabled, false);
  await s.idle();
  assert.deepEqual(s.to("POST", "/api/logout").length, 1, "one press, one request");
  assert.deepEqual(s.navigations, [], "a sign-out that did not reach the service has not signed anyone out");
  assert.equal(button.textContent, "Try signing out again");
  assert.equal(button.disabled, false);
  assert.equal(button.getAttribute("aria-disabled"), null, "and it can be pressed again");
  assert.equal(s.doc.activeElement, button, "the cursor never left the button, so the next Tab is where the person was");
  assert.equal(
    s.text("bar-say"),
    "You are still signed in. The service could not be reached. Check your connection and try again.",
    "and the failure is said in the bar's own line: a name that changes under a cursor that never left it is not read out",
  );

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
  account.click(account.button("topup-options", "$10.00"));
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
  assert.equal(v.text("email-error"), "Enter your email address.");
  assert.equal(v.text("status"), "", "a refusal about a field is not said at the top of the form");
  assert.ok(v.$("email-error").parent?.className.split(/\s+/).includes("field"), "the sentence is inside the field it is about");
  assert.equal(v.$("email").getAttribute("aria-invalid"), "true");
  assert.equal(v.doc.activeElement, v.$("email"));
  v.type("email", "ada@example.com");
  assert.equal(v.$("email").getAttribute("aria-invalid"), null, "typing clears the mark");
  assert.equal(v.text("email-error"), "", "and the sentence with it");
  await submit();
  assert.equal(v.text("password-error"), "Enter your password.");
  assert.ok(v.$("password-error").parent?.className.split(/\s+/).includes("field"), "the sentence is inside the field it is about");
  v.type("password", "short");
  await submit();
  assert.equal(v.text("password-error"), "Use at least 10 characters.");
  assert.equal(v.doc.activeElement, v.$("password"));
  v.type("password", "correct horse battery staple");
  await submit();
  assert.equal(v.text("status"), "", "a refusal about the tick is not said at the top of the form");
  assert.equal(v.text("password-error"), "", "and the field's own sentence stops when the field is changed");
  assert.equal(v.text("agree-error"), "Tick the box to continue.", "one line, so the action below it stays on the screen the refusal is read on");
  assert.equal(v.$("agree").getAttribute("aria-invalid"), "true");
  assert.equal(v.$("agree").getAttribute("aria-describedby"), "agree-error", "the sentence describes the tick it is about");
  assert.equal(v.doc.activeElement, v.$("agree"));
  v.check("agree");
  assert.equal(v.text("agree-error"), "", "ticking answers it, so the sentence stops being said");
  assert.equal(v.$("agree").getAttribute("aria-invalid"), null);
  assert.equal(v.$("agree").getAttribute("aria-describedby"), null);
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
  assert.equal(v.text("card"), "We sent the link to Ada@Example.com. Open it: it confirms your address and signs you in to your account. It works once and expires in 24 hours. Resend the email Use another address You can ask for another in 60 seconds. If it does not come It can take a few minutes. Look in your spam or junk folder too. Check the address above for a typo. If it is wrong, use another address.");
  const sentAside = v.doc.querySelector(".auth-main .aside")!;
  assert.equal(v.text(sentAside), "Already confirmed? Sign in.", "the door beside the form is for a confirmed account, not for this one before it has opened the link");
  assert.equal(sentAside.querySelector("a")!.getAttribute("href"), "/login");
  assert.equal(v.link("card", "Use another address").getAttribute("href"), "/signup");
  assert.equal(v.doc.activeElement, v.$("card"), "focus moves to what happened");
  assert.deepEqual(v.navigations, []);
});

test("the card that says the link was sent says how long it lasts, in the service's own hours, and does not say the heading again", async () => {
  const w = world((x) => {
    x.signedIn = false;
    x.plans = { json: { ...PLANS, policy: { ...PLANS.policy, verificationHours: 1 } } };
  });
  w.answers.set("POST /api/signup", { status: 202, json: { ok: true, message: "Check your email for a link to confirm your address." } });
  const v = await visit("signup", { routes: w.routes, manualTimers: true });
  v.type("email", "ada@example.com");
  v.type("password", "correct horse battery staple");
  v.check("agree");
  await v.send(v.$("form"));
  await v.idle();
  assert.equal(v.text("title"), "Check your email");
  assert.ok(v.text("card").startsWith("We sent the link to ada@example.com."), "the card opens with what happened, not with the heading it sits under");
  assert.match(v.text("card"), /It works once and expires in 1 hour\./, "and the period is the service's, not a sentence about an email that has not been read");
});

test("sign-up shows what the service says when it refuses, and lets the person try again", async () => {
  const w = world((x) => (x.signedIn = false));
  w.answers.set("POST /api/signup", failure(400, "weak_password", "That password is too easy to guess."));
  const v = await visit("signup", { routes: w.routes });
  v.type("email", "ada@example.com");
  v.type("password", "password123456");
  v.check("agree");
  await v.send(v.$("form"));
  assert.equal(v.text("password-error"), "That password is too easy to guess.");
  assert.equal(v.$("password-error").className, "note note-bad");
  assert.equal(v.text("status"), "", "the field's refusal is not repeated at the top of the form");
  assert.ok(v.buttons("form").every((b) => !b.disabled), "the button is back");
  assert.equal(v.doc.activeElement, v.$("password"), "a refusal that is about the password puts the cursor in it");
  assert.equal(v.$("password").getAttribute("aria-invalid"), "true");
  w.answers.set("POST /api/signup", failure(400, "invalid_email", "Enter an email address."));
  await v.send(v.$("form"));
  assert.equal(v.text("email-error"), "Enter an email address.");
  assert.equal(v.text("password-error"), "", "one sentence at a time: the password's goes when the address is the one refused");
  assert.equal(v.$("password").getAttribute("aria-invalid"), null);
  assert.equal(v.doc.activeElement, v.$("email"), "and one that is about the address puts it there");
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
  assert.equal(v.text("email-error"), "Enter your email address.");
  assert.equal(v.text("status"), "", "a refusal about a field is not said at the top of the form");
  v.type("email", " ada@example.com ");
  await v.send(v.$("form"));
  assert.equal(v.text("password-error"), "Enter your password.");
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
  assert.deepEqual(v.navigations, ["replace /account?confirmed=1"], "and the account page is the one that says so, in a sentence that is not replaced by the navigation");
  assert.equal(v.$("again").hidden, true);
});

test("a link that is no good says so, offers a way on, and also leaves the address bar", async () => {
  const w = world((x) => (x.signedIn = false));
  w.answers.set("POST /api/verify", failure(400, "invalid_token", "That link is not valid, or it has expired. Ask for a new one."));
  const v = await visit("verify", { routes: w.routes, search: "?token=old" });
  assert.equal(v.text("status"), "That link is not valid, or it has expired. Ask for a new one.");
  assert.equal(v.$("status").className, "note note-bad");
  assert.equal(v.$("again").hidden, false);
  assert.equal(v.doc.activeElement, v.$("resend"), "the way out is what there is to do, so it has the cursor: a rubber-stamped failure is not a place to leave a keyboard");
  assert.deepEqual(v.history, ["/verify"]);
  assert.deepEqual(v.navigations, []);

  const none = await visit("verify", { routes: w.routes });
  assert.equal(none.text("status"), "This link is incomplete. Open the link in the email again.");
  assert.equal(none.$("again").hidden, false);
  assert.equal(none.doc.activeElement, none.$("resend"), "and a link with no token in it is the same page as one that was spent");
  assert.deepEqual(none.to("POST", "/api/verify"), [], "with no token there is nothing to send");
});

test("asking for a password reset says the same for every address, and says nothing is sent until an address is given", async () => {
  const w = world((x) => (x.signedIn = false));
  w.answers.set("POST /api/forgot", { status: 202, json: { ok: true, message: "If that address has an account, a link to choose a new password is on its way." } });
  const v = await visit("forgot", { routes: w.routes });
  await v.send(v.$("form"));
  assert.equal(v.text("email-error"), "Enter your email address.");
  assert.equal(v.text("status"), "", "the field's refusal is not said at the top of the card");
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
  assert.equal(none.link("card", "Send a new link").getAttribute("href"), "/forgot");
  assert.equal(none.text("title"), "That link did not work", "the heading says what the page is: a link that cannot be used is not \"Choose a new password\"");
  assert.equal(none.doc.title, "That link did not work – Curule Cloud");
  assert.equal(none.shows(none.$("lede")), false, "and the line about a link that works once goes with the form");

  w.answers.set("GET /api/reset/check?token=t0k3n", { json: { ok: true } });
  w.answers.set("POST /api/reset", { json: { ok: true } });
  const v = await visit("reset", { routes: w.routes, search: "?token=t0k3n" });
  assert.deepEqual(v.to("GET", "/api/reset/check?token=t0k3n"), [{ method: "GET", path: "/api/reset/check?token=t0k3n", body: undefined }], "the link is checked, without being used, before the form is drawn");
  assert.equal(v.text("title"), "Choose a new password");
  assert.equal(v.shows(v.$("form")), true);
  assert.equal(v.text("status"), "");
  assert.equal(v.link("card", "Send a new link").getAttribute("href"), "/forgot", "the way to another link is on the page before this one is tried, so a link that has already expired need not be discovered by typing a password");
  assert.match(v.text(v.$("lede")), /expires after 2 hours/, "and the line says how long the link the person holds lasts");
  v.type("password", "short");
  await v.send(v.$("form"));
  assert.equal(v.text("password-error"), "Use at least 10 characters.");
  assert.ok(v.$("password-error").parent?.className.split(/\s+/).includes("field"), "the sentence is inside the field it is about");
  assert.equal(v.text("status"), "", "and not said above the form");
  v.type("password", "a brand new password");
  await v.send(v.$("form"));
  assert.deepEqual(v.to("POST", "/api/reset"), [{ method: "POST", path: "/api/reset", body: { token: "t0k3n", password: "a brand new password" } }]);
  assert.deepEqual(v.history, ["/reset"]);
  assert.equal(v.text("card"), "Your password is changed. Every device is signed out. Sign in");
  assert.equal(v.link("card", "Sign in").getAttribute("href"), "/login");
  assert.equal(v.doc.activeElement, v.$("card"), "the form that had the cursor is gone: the cursor goes to what happened");
  assert.equal(v.$("card").getAttribute("tabindex"), "-1");
});

test("a reset link that cannot work is refused before a password is typed, and a check that could not answer refuses nothing", async () => {
  const w = world((x) => (x.signedIn = false));
  w.answers.set("GET /api/reset/check?token=old", { json: { ok: false, message: "That link is not valid, or it has expired. Ask for a new one." } });
  const v = await visit("reset", { routes: w.routes, search: "?token=old" });
  assert.equal(v.to("GET", "/api/reset/check?token=old").length, 1, "the page asks before it draws the form");
  assert.equal(v.text("title"), "That link did not work");
  assert.equal(v.text("status"), "That link is not valid, or it has expired. Ask for a new one.", "the same sentence the confirmation page uses");
  assert.equal(v.shows(v.$("form")), false, "there is nothing to type into for a link that cannot work");
  assert.deepEqual(v.to("POST", "/api/reset"), [], "and nothing is sent");
  assert.equal(v.link("card", "Send a new link").getAttribute("href"), "/forgot");
  assert.equal(v.doc.activeElement, v.link("card", "Send a new link"), "the cursor is on the way to a working link");
  assert.equal(v.$("status").getAttribute("aria-busy"), null);

  const busy = world((x) => (x.signedIn = false));
  busy.answers.set("GET /api/reset/check?token=fresh", failure(429, "rate_limited", "Too many attempts. Try again in 3 minutes."));
  const f = await visit("reset", { routes: busy.routes, search: "?token=fresh" });
  assert.equal(f.shows(f.$("form")), true, "a check that could not be answered is not a refusal of the link");
  assert.equal(f.text("status"), "");
});

test("a reset link that has been used sends the person to a new one; a password that is too weak keeps the link, which is fine", async () => {
  const w = world((x) => (x.signedIn = false));
  // The link was good when the page opened, and the service refuses it when the password is sent: the same refusal, from the submit.
  w.answers.set("GET /api/reset/check?token=used", { json: { ok: true } });
  w.answers.set("POST /api/reset", failure(400, "invalid_token", "That link is not valid, or it has expired. Ask for a new one."));
  const v = await visit("reset", { routes: w.routes, search: "?token=used" });
  v.type("password", "a perfectly good password");
  await v.send(v.$("form"));
  assert.equal(v.text("status"), "That link is not valid, or it has expired. Ask for a new one.");
  assert.equal(v.link("card", "Send a new link").getAttribute("href"), "/forgot");
  assert.deepEqual(v.history, [], "the page keeps the link in the address until it has been used");
  assert.equal(v.text("title"), "That link did not work", "the heading says so now");
  assert.equal(v.shows(v.$("form")), false, "a form that can do nothing with that link is put away");
  assert.equal(v.doc.activeElement, v.link("card", "Send a new link"), "and the cursor is on what there is to do");
  assert.equal(v.doc.querySelectorAll("a").filter((a) => a.textContent === "Send a new link").length, 1, "the way out was already on the page: the refusal does not add a second one");

  const weak = world((x) => (x.signedIn = false));
  weak.answers.set("GET /api/reset/check?token=fresh", { json: { ok: true } });
  weak.answers.set("POST /api/reset", failure(400, "weak_password", "That password is too easy to guess."));
  const u = await visit("reset", { routes: weak.routes, search: "?token=fresh" });
  u.type("password", "password123456");
  u.click(u.button("form", "Save password"));
  await u.idle();
  assert.equal(u.text("password-error"), "That password is too easy to guess.");
  assert.equal(u.text("status"), "", "the field's sentence is with the field, not above the form");
  assert.equal(u.doc.activeElement, u.$("password"), "the cursor is in the field to choose another, though it was on the button that was pressed");
  assert.equal(u.$("password").getAttribute("aria-invalid"), "true");
  assert.equal(u.link("card", "Send a new link").getAttribute("href"), "/forgot", "and the quiet way out is unchanged, because it is a link to ask again, not a second refusal");
  assert.equal(u.text("title"), "Choose a new password", "the link is fine, so the page is as it was");
  assert.equal(u.shows(u.$("form")), true);
});

test("the page for a wrong address offers a visitor the plans and the way in, and a customer their account", async () => {
  const out = world((x) => (x.signedIn = false));
  const v = await visit("404", { routes: out.routes });
  assert.equal(v.text("main"), "Curule Cloud · not found That page is not here The address may have changed, or it may never have existed. These pages do exist. See the plans and prices Sign in Create an account");
  assert.deepEqual(v.doc.querySelectorAll("a").filter((a) => v.shows(a) && !a.className.includes("brand") && a.getAttribute("href") !== "#main" && !v.doc.querySelector("footer")!.contains(a)).map((a) => a.getAttribute("href")), ["/", "/login", "/", "/login", "/signup"], "the header's two, then the page's three");
  const filled = (x: typeof v): string[] => x.doc.querySelectorAll(".btn-primary").filter((a) => x.shows(a)).map((a) => a.textContent!);
  assert.deepEqual(filled(v), ["See the plans and prices"], "a signed-out visitor is offered one filled answer");
  const signedIn = world(paid);
  const u = await visit("404", { routes: signedIn.routes });
  assert.equal(u.text("main"), "Curule Cloud · not found That page is not here The address may have changed, or it may never have existed. These pages do exist. See the plans and prices Go to your account");
  assert.equal(u.link("main", "Go to your account").getAttribute("href"), "/account");
  // Measured before this: signed in, the page had two filled buttons, so the one answer a lost person needs was the one thing it did not give.
  assert.deepEqual(filled(u), ["Go to your account"], "and a customer is offered their account, not two answers at once");
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

test("the page that says the link was sent does not send a person to sign in to have it sent again: it has a button for that", async () => {
  const w = world((x) => (x.signedIn = false));
  w.answers.set("POST /api/signup", { status: 202, json: { ok: true, message: "Check your email for a link to confirm your address." } });
  const v = await visit("signup", { routes: w.routes, manualTimers: true });
  v.type("email", "ada@example.com");
  v.type("password", "correct horse battery staple");
  v.check("agree");
  await v.send(v.$("form"));
  assert.doesNotMatch(v.text("card"), /Sign in with your email and password/);
  const login = fs.readFileSync(`${PAGES_DIR}/login.html`, "utf8");
  assert.doesNotMatch(login, /signing in with your password sends the link again/, "nor does the sign-in page: it offers the way after a refusal, which does not depend on a password being right");
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

test("a new password shows how far it is towards the length asked for, in steps, and says nothing of how good it is", async () => {
  const h = helpers();
  assert.deepEqual(h.lengthProgress(0, 10), { value: 0, done: false });
  assert.deepEqual(h.lengthProgress(9, 10), { value: 9, done: false });
  assert.deepEqual(h.lengthProgress(10, 10), { value: 10, done: true });
  assert.deepEqual(h.lengthProgress(40, 10), { value: 10, done: true }, "a longer one has no more of it to show");
  for (const [page, search] of [["signup", ""], ["reset", "?token=t0k3n"]] as const) {
    const v = await visit(page, { routes: world((x) => (x.signedIn = false)).routes, search });
    const meter = v.doc.querySelector("meter")!;
    assert.deepEqual([meter.getAttribute("max"), meter.getAttribute("value"), meter.getAttribute("aria-hidden")], ["10", "0", "true"], `${page}: it is for the eye: the hint says the same in words`);
    assert.equal(meter.getAttribute("data-len"), "password");
    v.type("password", "abcd");
    assert.deepEqual([meter.getAttribute("value"), meter.hasAttribute("data-done")], ["4", false], page);
    v.type("password", "correct horse");
    assert.deepEqual([meter.getAttribute("value"), meter.hasAttribute("data-done")], ["10", true], `${page}: full, and marked so`);
    v.type("password", "short one");
    assert.deepEqual([meter.getAttribute("value"), meter.hasAttribute("data-done")], ["9", false], `${page}: and not once it is shortened`);
  }
});

test("the page that says the link was sent has an icon for what it is, which is for the eye and says nothing", async () => {
  const { v } = await (async () => {
    const w = world((x) => (x.signedIn = false));
    w.answers.set("POST /api/signup", { status: 202, json: { ok: true, message: "Check your email for a link to confirm your address." } });
    const page = await visit("signup", { routes: w.routes, manualTimers: true });
    page.type("email", "ada@example.com");
    page.type("password", "correct horse battery staple");
    page.check("agree");
    await page.send(page.$("form"));
    return { v: page };
  })();
  const tile = v.$("card").querySelector(".tile")!;
  assert.deepEqual([tile.getAttribute("aria-hidden"), tile.textContent], ["true", ""]);
  assert.equal(v.$("card").children[0], tile, "and it comes first");
  assert.equal(v.link("card", "Use another address").className, "btn btn-ghost", "the way back is quieter than the button that sends the link again");
});

test("the page that checks a link says so while it is checking, and says nothing there without a script", async () => {
  // With no script the status is empty: the noscript sentence explains the page, and "Checking the link." beside it would contradict it.
  assert.match(fs.readFileSync(`${PAGES_DIR}/verify.html`, "utf8"), /id="status"[^>]*aria-busy="true"[^>]*><\/div>/, "the waiting line is not in the markup");
  let during = "";
  const w = world((x) => (x.signedIn = false));
  w.answers.set("POST /api/verify", () => {
    during = v.text("status");
    return failure(400, "invalid_token", "That link is not valid, or it has expired. Ask for a new one.");
  });
  // Built first, then started, so the answer can read the page while the request is out.
  const v = new Visit("verify", { routes: w.routes, search: "?token=old" });
  await v.start();
  assert.equal(during, "Checking the link.", "the script writes it, while it is waiting for the answer");
  assert.equal(v.$("status").getAttribute("aria-busy"), null, "and a status that has said something stops waiting");
});

test("a button that was pressed has the cursor again when its call is done, unless the page put it somewhere on purpose", async () => {
  const w = world((x) => (x.signedIn = false));
  w.answers.set("POST /api/forgot", { status: 202, json: { ok: true, message: "If that address has an account, a link to choose a new password is on its way." } });
  const v = await visit("forgot", { routes: w.routes });
  v.type("email", "ada@example.com");
  const send = v.button("form", "Send the link");
  v.click(send);
  // Held, not disabled: the cursor stays on the button while its request is out, so the next Tab goes on from where the person is.
  assert.equal(v.doc.activeElement, send, "while the call is out the cursor stays on the button that was pressed");
  assert.equal(send.getAttribute("aria-disabled"), "true", "and the button says it is held");
  await v.idle();
  assert.equal(v.doc.activeElement, send, "and when it is done the cursor is still on it");
  assert.equal(send.getAttribute("aria-disabled"), null, "and it can be pressed again");

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
  let duringBusy: string | null = null;
  let v: Visit | undefined;
  w.answers.set("POST /api/login", () => {
    during = v!.text(v!.doc.querySelector('button[type="submit"]')!);
    duringBusy = v!.doc.querySelector('button[type="submit"]')!.getAttribute("aria-busy");
    return failure(401, "invalid_credentials", "That email and password do not match an account.");
  });
  v = await visit("login", { routes: w.routes });
  const main = v.doc.querySelector('button[type="submit"]')!;
  assert.equal(main.textContent, "Sign in");
  v.type("email", "ada@example.com");
  v.type("password", "a long enough secret");
  await v.send(v.$("form"));
  assert.equal(during, "Signing in", "the button said what was going on while the service had the call");
  assert.equal(duringBusy, "true", "and said it is busy to the stylesheet, which draws its spinner, and to what reads the page");
  assert.equal(main.textContent, "Sign in", "and says what it is again");
  assert.equal(main.disabled, false);
  assert.equal(main.getAttribute("aria-busy"), null, "and is not busy any more");

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
  assert.deepEqual(v.navigations, ["replace /login?next=/account&signedout=1"]);
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
  assert.deepEqual(open.navigations, ["replace /login?next=/account&signedout=1"]);
});

test("the account page says the service cannot be reached, offers the same read again, and does not send a person to sign in again for nothing", async () => {
  const down = await visit("account", { routes: (c) => (c.path === "/api/session" ? failure(503, "unavailable", "Changes cannot be saved just now. Try again in a few minutes.") : undefined) });
  assert.equal(down.text("notice"), "Changes cannot be saved just now. Try again in a few minutes. Nothing was changed.");
  assert.deepEqual(down.navigations, []);
  const again = down.button("retry-row", "Try again");
  assert.equal(down.shows(down.$("retry-row")), true, "the action the sentence used to only name is a control");
  down.click(again);
  assert.deepEqual(down.navigations, ["reload"], "pressing it asks for the page, and its one read, again");
  const offline = await visit("account", { routes: (c) => (c.path === "/api/session" ? { fail: true } : undefined) });
  assert.equal(offline.text("notice"), "The service could not be reached. Check your connection and try again. Nothing was changed.");
  assert.deepEqual(offline.navigations, []);

  const w = world(paid);
  w.answers.set("GET /api/me", failure(502, "bad_gateway", "Something went wrong on our side. Try again in a moment."));
  const half = await visit("account", { routes: w.routes });
  assert.equal(half.text("notice"), "Something went wrong on our side. Try again in a moment. Nothing was changed.");
  assert.equal(half.text(half.button("retry-row", "Try again")), "Try again", "a read that fails after the session is known offers the same way back");
  assert.deepEqual(half.navigations, []);

  const ended = await visit("account", { routes: (c) => (c.path === "/api/session" ? failure(401, "not_signed_in", "Sign in to continue.") : undefined) });
  assert.deepEqual(ended.navigations, ["replace /login?next=/account&signedout=1"], "a session that has ended goes where a signed-out page goes, not to a retry");

  // The sign-in page the account sends them to says why they are there, so the form does not meet them as if they had just arrived.
  const anonymous = world((x) => (x.signedIn = false));
  const out = await visit("login", { routes: anonymous.routes, search: "?next=/account&signedout=1" });
  assert.equal(out.text("status"), "You are signed out. Sign in to see your account.");
  // Someone who is signed in is sent on, and is not told they are signed out.
  const already = await visit("login", { routes: w.routes, search: "?next=/account&signedout=1" });
  assert.deepEqual(already.navigations, ["replace /account"]);
});

test("a confirmation link that has just been opened is confirmed where the person can read it", async () => {
  const w = world(paid);
  const v = await visit("account", { routes: w.routes, search: "?confirmed=1" });
  assert.equal(v.text("notice"), "Your address is confirmed.");
  assert.deepEqual(v.history, ["/account"], "and the query leaves the address");
});

test("a new account sees what to do first: choose a plan, and nothing to create, open, pay for or use yet", async () => {
  const w = world();
  const v = await visit("account", { routes: w.routes });
  assert.equal(v.text("who"), "Signed in as ada@example.com");
  assert.equal(v.shows(v.$("stage")), true);
  assert.equal(v.text("stage-title"), "Choose a plan");
  assert.equal(v.text("stage-text"), "A plan is a flat monthly price for your account, and it says how many workspaces you may run at once. Choose one below and pay on the next page.");
  assert.equal(v.link("stage-actions", "Choose a plan").getAttribute("href"), "#plan-h");
  assert.equal(v.text("stage-steps"), "02 Choose a plan (you are here) 03 Make a workspace (still to do) 04 Describe your team (still to do)");
  assert.equal(v.shows(v.$("workspaces-panel")), false, "there is no workspace to list");
  assert.equal(v.shows(v.$("create")), false);
  assert.equal(v.text("plan-h"), "Plans");
  assert.equal(v.$("plan").querySelectorAll("article").length, 2);
  assert.deepEqual(v.labels("plan"), ["Choose Team", "Choose Business"]);
  assert.equal(v.shows(v.$("balance-panel")), false, "a balance means nothing before a plan, whatever the gateway holds");
  assert.equal(v.shows(v.$("usage-panel")), false);
  assert.equal(v.to("GET", "/api/usage").length, 0, "and usage is not asked for until there is a plan that sells it");
  assert.equal(v.text("notice"), "");
  assert.deepEqual(v.consoleErrors, []);
});

test("a plan picked on the front page is kept through sign-up, opened on the account, marked in words, and gone to", async () => {
  // Measured before this, "Choose Business" on the front page led to /account#plan-h and nothing else: the customer arrived at the top,
  // the plan was behind a closed "Change plan" button, and the page had not moved.
  const w = world((x) => (x.signedIn = false));
  const signup = await visit("signup", { routes: w.routes, search: "?plan=business" });
  assert.equal(signup.storage.get("curule:picked-plan"), "business", "the choice is kept for the account the address makes");

  // A new account: both plans are out, and the one picked is marked and has the cursor.
  const a = world();
  const v = await visit("account", { routes: a.routes, search: "?plan=team" });
  const cards = v.$("plan").querySelectorAll(".plan");
  assert.match(v.text(cards[0]!), /^Team Your choice /, "the card says which one was picked, in words");
  assert.doesNotMatch(v.text(cards[1]!), /Your choice/);
  assert.equal(v.doc.activeElement, cards[0], "the person is put at the plan they picked");
  assert.deepEqual(v.history, ["/account#plan-h"], "and the address no longer carries the pick");

  // A customer: the others are behind "Change plan", so the list is opened before the page goes there.
  const p = world(paid);
  const u = await visit("account", { routes: p.routes, search: "?plan=business" });
  assert.equal(u.shows(u.$("plan-change")), true, "the list is open, so the plan is really on the page");
  const others = u.$("plan-change").querySelectorAll(".plan");
  assert.equal(others.length, 1);
  assert.match(u.text(others[0]!), /^Business Your choice /);
  assert.equal(u.doc.activeElement, others[0]);

  // The same choice kept in the tab, as the confirmation link's account finds it: read once, and forgotten.
  const again = await visit("account", { routes: p.routes, storage: { "curule:picked-plan": "business" } });
  assert.equal(again.storage.has("curule:picked-plan"), false, "the account takes the pick and forgets it");
  assert.equal(again.shows(again.$("plan-change")), true, "and opens the list it is in");
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
  const card = v.$("plan").querySelectorAll(".plan")[0]!;
  assert.ok(card.contains(v.$("plan-status")), "the refusal is in the card whose button asked, under it, not above the list where nobody is looking");
  assert.equal(card.children.filter((n) => !n.isText).at(-1), v.$("plan-status"), "at the foot of that card");
  assert.equal(v.doc.activeElement, v.button("plan", "Choose Team"), "and the cursor is back on the button that was pressed");
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
  assert.deepEqual(v.navigations, ["replace /login?next=/account&signedout=1"]);
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
  const manage = m.button("plan", "Manage billing");
  m.click(manage);
  await m.idle();
  assert.equal(m.text("plan-status"), "There is no billing portal for payments made by invoice or transfer. Contact the operator to change or cancel a plan.");
  assert.ok(m.$("plan").querySelector(".row")!.contains(m.$("plan-status")), "the answer is in the plan's own row, under the buttons that asked");
  assert.equal(m.button("plan", "Manage billing").disabled, false, "and the button is back");
  assert.equal(m.doc.activeElement, manage, "with the cursor on it, so the next Tab starts there");
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
  assert.equal(e.text("plan-h"), "Plans");
  assert.equal(e.text(e.$("plan").querySelector(".row")!), "Team Ended");
  assert.deepEqual(e.labels("plan"), ["Choose Team", "Choose Business"], "a plan that ended is a plan that can be chosen again");

  const spent = world((x) => {
    paid(x);
    x.balance = balance({ included: 0, available: 0 });
  });
  const s = await visit("account", { routes: spent.routes });
  assert.equal(s.text("notice"), "Your balance is used up. Calls to models are refused until you add credit or your plan renews, and a workspace that needs them pauses with a notice that says why.");
});

test("the balance is what the gateway says, rounded down; when it cannot be read the page says so, and everything else still works", async () => {
  const w = world(paid);
  w.balance = balance({ included: 19_999_200, purchased: 10_000_000 });
  const v = await visit("account", { routes: w.routes });
  assert.equal(v.text("figures"), "Available $29.99 From your plan $19.99 left of $20.00 a month From credit you added $10.00", "what is left of what the plan includes each period is said in words, with the period it is for, as it is to a reader of the page");
  const bar = v.$("figures").querySelector("meter")!;
  assert.deepEqual([bar.getAttribute("min"), bar.getAttribute("max"), bar.getAttribute("value")], ["0", "20000000", "19999200"], "and the bar is that part against that whole, in the units the service gives");
  assert.equal(bar.getAttribute("aria-label"), "From your plan: $19.99 left of $20.00 a\u00A0month", "which is said to a reader of the page in words");

  const blind = world(paid);
  blind.balance = null;
  const b = await visit("account", { routes: blind.routes });
  assert.equal(b.text("figures"), "Available Not available just now");
  assert.equal(b.text("notice"), "", "an unknown balance is not a used-up one");
  assert.match(b.text(b.$("plan").querySelector(".row")!), /^Team Active \$149\.00 per month\. Paid until November 5, 2026\. /);
});

test("the balance is the record, and adding credit is one named row that holds the amounts and the form", async () => {
  const w = world(paid);
  const v = await visit("account", { routes: w.routes });
  const details = v.$("topup-details");
  assert.equal(details.tag, "details", "the disclosure is the browser's own, so it opens without the script doing anything");
  assert.equal(details.hidden, false, "a service that sells credit offers it");
  assert.equal(details.querySelector("summary")!.textContent.trim(), "Add credit", "the row is named with the action");
  assert.equal(v.$("topup-add").parent, details, "the amounts, their answer and the form are inside it");
  assert.deepEqual(details.children.filter((n) => !n.isText && n.tag !== "summary").map((n) => n.getAttribute("id")), ["topup-add", "topup-options", "topup-status", "topup", "topup-hint"]);

  const down = world(paid);
  down.plans = failure(503, "unavailable", "Down.");
  const d = await visit("account", { routes: down.routes });
  assert.equal(d.$("topup-details").hidden, true, "a read that failed hides the row with the form it cannot fill, and keeps its own note");
  assert.equal(d.$("topup-fail").hidden, false);
  // The balance's own Try again opens the row before giving the cursor to what arrived: a closed disclosure would swallow it.
  down.plans = { json: PLANS };
  d.click(d.button("topup-fail", "Try again"));
  await d.idle();
  assert.equal(d.$("topup-details").hidden, false);
  assert.equal((d.$("topup-details") as unknown as { open: boolean }).open, true, "the row is open on the amounts it now holds");
  assert.equal(d.doc.activeElement, d.$("topup-options").querySelector("button"), "and the cursor is on the first amount");
});

test("the plans being unavailable leaves the rest of the account usable, says what is missing, and asks again when told to", async () => {
  const w = world(paid);
  w.plans = failure(503, "unavailable", "Down.");
  w.workspaces = [workspace({ status: "suspended", statusReason: "paused by its owner" })];
  const v = await visit("account", { routes: w.routes });
  const last = v.$("plan").querySelectorAll("p").at(-1)!;
  assert.equal(v.text(last), "The plans could not be loaded just now, so no price is shown.");
  assert.equal(v.text(v.$("topup-hint")), "");
  assert.deepEqual(v.labels("topup-options"), []);
  assert.equal(v.$("topup-add").hidden, true, "the amounts' caption goes with the amounts");
  assert.deepEqual(v.labels("workspaces"), ["Resume", "More"]);
  assert.match(v.text("workspaces"), /Paused by you\. Its files are kept\. Resume it to open it\./);
  // The sentence is an action now: the same read, again, and the page takes the answer.
  const retry = v.button("plan", "Try again");
  w.plans = { json: PLANS };
  v.click(retry);
  await v.idle();
  assert.doesNotMatch(v.text(v.$("plan")), /could not be loaded/, "the plan the account is on arrives");
  assert.match(v.text(v.$("plan")), /Team Active \$149\.00 per month/, "and the summary is drawn from it");
  // The same read carries what credit may be bought; before, the amounts stayed empty until the page was reloaded.
  assert.equal(v.$("topup-add").hidden, false);
  assert.equal(v.$("topup-details").hidden, false, "the row that holds the amounts is shown with them");
  assert.deepEqual(v.labels("topup-options"), ["$10.00", "$25.00", "$100.00"], "and the amounts to add, which the same read carries");
  assert.match(v.text("topup-hint"), /^From \$5\.00 to \$1,000\.00\./);
  assert.equal(v.button("plan", "Manage billing").tag, "button");
  assert.deepEqual(v.consoleErrors, []);

  // A new account: the card at the top does not promise a plan it cannot show, and its own Try again is the way to the list.
  const fresh = world((x) => {
    x.plans = failure(503, "unavailable", "Down.");
  });
  const n = await visit("account", { routes: fresh.routes });
  assert.equal(n.text(n.$("plan").querySelectorAll("p").at(-1)!), "The plans could not be loaded just now, so no price is shown.");
  assert.equal(n.text("stage-title"), "The plans could not be loaded", "the card says what failed, not what the person may choose");
  assert.equal(n.text("stage-text"), "No plan or price is shown just now, and nothing was changed.");
  assert.equal(n.$("stage").className, "stage stage-warn");
  assert.deepEqual(n.labels("stage-actions"), ["Try again"], "and the action is the read again, not a jump to a promise");
  fresh.plans = { json: PLANS };
  n.click(n.button("stage-actions", "Try again"));
  await n.idle();
  assert.deepEqual(n.labels("plan"), ["Choose Team", "Choose Business"], "the list the card at the top offers is drawn without a reload");
  assert.equal(n.text("stage-title"), "Choose a plan", "and the card says what is now true");
  assert.equal(n.link("stage-actions", "Choose a plan").getAttribute("href"), "#plan-h");
  assert.equal(n.doc.activeElement, n.$("stage-title"), "the cursor is on what the card says now, not on a button that went");
  assert.deepEqual(n.consoleErrors, []);
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
  assert.equal(v.text(rows[0]!), "Alpha Running Open it to describe your team and start a mission. Open Pause More Plan Team Change plan Address alpha.ws.example.com", "a workspace that is ready says what the card used to say, and offers what can be done");
  assert.equal(v.text(rows[1]!), "Beta Stopped Stopped because the last payment did not go through. Resume it to open it. Resume More Plan Team Change plan Address beta.ws.example.com", "the plan is paid up, so it can be started");
  assert.equal(v.text(rows[2]!), "Gamma Starting It starts in the background, and this page updates when it is ready. Open it when it is ready Plan Team Address gamma.ws.example.com", "a workspace that is starting cannot be moved to another plan yet: there is no host to make again");
  assert.equal(v.text(rows[3]!), "Delta Could not start The container did not start. Delete it and make a new one. If it fails again, tell the operator. Delete this workspace Plan Team Address delta.ws.example.com");
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
  assert.equal(v.$("workspace-name").getAttribute("aria-describedby"), "create-note", "the reason is attached to the field it is about");
  assert.equal(v.doc.activeElement, v.$("workspace-name"));
  assert.deepEqual(v.to("POST", "/api/workspaces"), []);
  v.type("workspace-name", "R");
  assert.equal(v.text("create-note"), "", "and the sentence goes when the field it names is changed");

  v.type("workspace-name", "  Research  ");
  await v.send(v.$("create"));
  assert.deepEqual(v.to("POST", "/api/workspaces"), [{ method: "POST", path: "/api/workspaces", body: { name: "Research", plan: "team" } }], "the plan the form offers: the account's own, unless the person picks another");
  assert.equal(v.$("workspace-name").value, "");
  assert.match(v.text("workspaces"), /^Research Starting /);
  assert.equal(v.text("stage-title"), "Research is starting", "the card at the top says what became of it");
  assert.equal(v.doc.activeElement, v.$("stage-title"), "and the cursor goes there: the form it was in is gone");

  // The page looks again by itself; the workspace is running when it does.
  const before = v.to("GET", "/api/me").length;
  w.workspaces = [workspace({ name: "Research", status: "running" })];
  await v.until("the workspace to show as running", () => /^Research Running /.test(v.text("workspaces")));
  assert.ok(v.to("GET", "/api/me").length > before);
  assert.deepEqual(v.labels("workspaces"), ["Open", "Pause", "More", "Change plan"]);
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
  // The form's own note is a status area: the answer to its submit is read out, not only drawn under the button.
  assert.equal(v.$("create-note").getAttribute("role"), "status");
  assert.equal(v.$("create-note").getAttribute("aria-live"), "polite");
});

test("a change that went through and a read back that did not says so in the card that asked, and asks again there", async () => {
  const w = world((x) => {
    paid(x);
    x.workspaces = [workspace()];
  });
  let reads = 0;
  const paused = { account: w.view(), balance: w.balance };
  w.answers.set("GET /api/me", () => {
    reads += 1;
    // The page's own first read answers; the look it makes after a change does not.
    if (reads === 1) return { json: paused };
    return failure(503, "unavailable", "Something went wrong on our side. Try again in a moment.");
  });
  w.answers.set("POST /api/workspaces/ws_1/suspend", () => {
    w.workspaces = [workspace({ status: "suspended", statusReason: "paused by its owner" })];
    return { json: {} };
  });
  const v = await visit("account", { routes: w.routes });
  v.click(v.button("workspaces", "Pause"));
  await v.idle();
  // The pause was made. The page could not read the account again, so it still says Running, and it has to say why.
  assert.equal(reads, 2);
  assert.match(v.text("workspaces"), /^Research Running Open it to describe your team and start a mission\. Open Pause /, "the record shows what it showed before the change, because it cannot know more");
  const note = v.$("workspaces").querySelector(".ws-note")!;
  assert.equal(v.text(note), "That worked, but your account could not be read again just now, so this page is out of date. Try again", "the sentence and its way to ask again are in the card's own note");
  assert.equal(note.className, "note note-bad ws-note", "drawn as the card's notes are, not as a hint under it");
  assert.equal(note.getAttribute("role"), "status", "so a reader hears it where the change was asked");
  assert.equal(v.doc.activeElement, v.$("pause-ws_1"), "and the cursor stays on the button that asked");

  // The way to ask again re-runs the read the page already makes, and draws the answer in place.
  w.answers.delete("GET /api/me");
  v.click(v.button(note, "Try again"));
  await v.idle();
  assert.match(v.text("workspaces"), /^Research Stopped /, "what the change did is drawn from the answer");
  assert.equal(v.text(note), "", "and the sentence and its button go with it");
  assert.equal(note.className, "ws-note sr", "the note is out of the page again, as an empty one is");
  assert.equal(v.doc.activeElement, v.button("workspaces", "Resume"), "the cursor goes to what the card says now: the next thing to do");
  assert.deepEqual(v.consoleErrors, []);
});

test("a new workspace whose read back failed is not a form that emptied itself for nothing", async () => {
  const w = world(paid);
  let reads = 0;
  const before = { account: w.view(), balance: w.balance };
  w.answers.set("GET /api/me", () => {
    reads += 1;
    if (reads === 1) return { json: before };
    return failure(503, "unavailable", "Something went wrong on our side. Try again in a moment.");
  });
  w.answers.set("POST /api/workspaces", (call) => {
    w.workspaces = [workspace({ name: String((call.body as { name: string }).name), status: "suspended", statusReason: "paused by its owner" })];
    return { status: 201, json: { workspace: w.workspaces[0] } };
  });
  const v = await visit("account", { routes: w.routes });
  v.type("workspace-name", "Second");
  await v.send(v.$("create"));
  // The name was taken and the field emptied: the page owes the person the sentence it cannot draw the workspace for yet.
  assert.equal(v.$("workspace-name").value, "");
  assert.equal(v.text("create-note"), "That worked, but your account could not be read again just now, so this page is out of date. Try again");
  w.answers.delete("GET /api/me");
  v.click(v.button("create-note", "Try again"));
  await v.idle();
  assert.match(v.text("workspaces"), /^Second Stopped /, "the workspace the answer carries is drawn");
  assert.doesNotMatch(v.text("create-note"), /could not be read again/, "and the sentence about the read that failed is gone");
  assert.equal(v.text("create-note"), "Your plan includes 1 workspace. To make another, delete this one or change your plan.", "the form says what is true of the plan it filled");
  assert.deepEqual(v.consoleErrors, []);
});

test("a change asked from the card at the top, whose read back failed, answers in that card", async () => {
  // A late payment's card keeps Open beside the payment: it is the one workspace action still asked from the card.
  const w = world((x) => {
    x.subscription = { plan: "team", title: "Team", status: "past_due", periodEnd: "2026-11-05T12:00:00.000Z", pastDueSince: "2026-10-05T12:00:00.000Z" };
    x.workspaces = [workspace()];
  });
  let reads = 0;
  const before = { account: w.view(), balance: w.balance };
  w.answers.set("GET /api/me", () => {
    reads += 1;
    if (reads === 1) return { json: before };
    return failure(503, "unavailable", "Something went wrong on our side. Try again in a moment.");
  });
  w.answers.set("POST /api/workspaces/ws_1/open", { json: { url: "https://research-1a2b3c.ws.example.com/__enter?code=abc" } });
  const v = await visit("account", { routes: w.routes });
  assert.deepEqual(v.labels("stage-actions"), ["Update payment details", "Open"]);
  v.click(v.button("stage-actions", "Open"));
  await v.idle();
  assert.equal(
    v.text("stage-status"),
    "That worked, but your account could not be read again just now, so this page is out of date. Try again",
    "the card at the top answers under its own sentence, where the button was",
  );
  assert.equal(v.text("stage-title"), "Your last payment did not go through", "and still says what it said, because the page could not read more");
  assert.equal(v.doc.activeElement, v.button("stage-actions", "Open"), "the cursor stays on the Open it was pressed on");
  assert.equal(v.button("stage-actions", "Open").getAttribute("aria-disabled"), null, "and it can be pressed again");
  w.answers.delete("GET /api/me");
  v.click(v.button("stage-status", "Try again"));
  await v.idle();
  assert.equal(v.text("stage-status"), "", "and the card's own status is empty again");
  assert.ok(v.$("stage-actions").contains(v.doc.activeElement!), "the cursor goes back to the card's own actions");
  assert.deepEqual(v.consoleErrors, []);
});

test("a line that says the same is not written again, so a status area is not read out for every look the page takes", async () => {
  const w = world((x) => {
    x.subscription = { ...ACTIVE!, status: "past_due", pastDueSince: "2026-10-01T00:00:00.000Z" };
    x.workspaces = [workspace()];
    x.plans = failure(503, "unavailable", "Down.");
  });
  const v = await visit("account", { routes: w.routes });
  assert.equal(v.text("create-note"), "Update your payment details to create a workspace.");
  const line = v.$("create-note").children[0];
  v.click(v.button("plan", "Try again"));
  await v.idle();
  assert.equal(v.text("create-note"), "Update your payment details to create a workspace.", "the retry draws the page again");
  assert.equal(v.$("create-note").children[0], line, "and the sentence that has not changed is not written a second time, so it is not read out again");
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
  assert.equal(o.text("workspaces"), "Research Running Open it to describe your team and start a mission. Open Pause More Plan Team Change plan The address of this workspace is not one this page will open. Tell the operator. Address research-1a2b3c.ws.example.com");

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
  assert.equal(v.text("workspaces"), "Research Stopped Paused by you. Its files are kept. Resume it to open it. Resume More Plan Team Change plan Address research-1a2b3c.ws.example.com");
  v.click(v.button("workspaces", "Resume"));
  await v.idle();
  assert.match(v.text("workspaces"), /^Research Running Open it to describe your team and start a mission\. Open Pause More Plan Team Change plan Address /);
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
  const form = v.doc.querySelector("form.confirm")!;
  assert.equal(v.button(first(), "Delete workspace").getAttribute("data-busy"), "Deleting it", "the button says what it is doing while it does it");
  v.submit(form);
  v.submit(form);
  await v.idle();
  assert.equal(v.to("POST", "/api/workspaces/ws_1/delete").length, 1, "a form sent twice deletes once");
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
  // The trough is captioned "Add credit" and each segment is the amount it adds: three amounts in one row on a phone, and the
  // verb the caption carries is what a reader of the page hears with each button.
  assert.equal(v.text("topup-add"), "Add credit");
  assert.deepEqual([v.$("topup-options").getAttribute("role"), v.$("topup-options").getAttribute("aria-labelledby")], ["group", "topup-add"]);
  assert.deepEqual(v.labels("topup-options"), ["$10.00", "$25.00", "$100.00"]);
  assert.deepEqual(v.buttons("topup-options").map((b) => b.getAttribute("aria-label")), ["Add $10.00", "Add $25.00", "Add $100.00"]);
  v.click(v.button("topup-options", "$25.00"));
  await v.idle();
  assert.deepEqual(v.to("POST", "/api/checkout"), [{ method: "POST", path: "/api/checkout", body: { purpose: "topup", amountMinor: 2_500 } }]);
  assert.deepEqual(v.navigations, ["assign https://pay.example/c/topup"]);
  assert.equal(v.storage.get("curule:before-payment"), JSON.stringify([["team", "active", "2026-11-05T12:00:00.000Z"], [20_000_000, 0]]));

  w.answers.set("POST /api/checkout", failure(400, "invalid_amount", "That amount cannot be bought."));
  const again = await visit("account", { routes: w.routes });
  again.click(again.button("topup-options", "$10.00"));
  await again.idle();
  assert.equal(again.text("topup-status"), "That amount cannot be bought.");
  // The answer sits between the amounts and the amount field: the sentence that a press of an amount brings does not push that
  // amount down the card, and the field's own refusal is above the field it is about, not at the top of the card.
  const ids = again.$("topup").parent!.children.filter((n) => !n.isText).map((n) => n.getAttribute("id"));
  assert.deepEqual(ids.slice(-4), ["topup-options", "topup-status", "topup", "topup-hint"], "the amounts, their answer, the field's form, and the line under it");
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
  assert.deepEqual(v.labels("topup-options"), ["¥1,000", "¥5,000"]);
  assert.deepEqual(v.buttons("topup-options").map((b) => b.getAttribute("aria-label")), ["Add ¥1,000", "Add ¥5,000"], "and the amount a reader hears carries the currency too");
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
const PENDING_UNKNOWN = "If your payment is not in the figures below yet, it can take a few minutes. Nothing more is needed from you. Reload this page later to see it.";

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
  // Started, not visited: `visit()` drives the page to the end of its own waited-for timeline, so which phase a read
  // lands on is the runner's business — this test passed on a fast machine and failed on a slow one for exactly that
  // reason (green at 54d47d4, red at 1f21fcd, a commit that touched only the workflow and the changelog). Waiting for
  // each phase is what the test above it already does, and it is the difference between observing the page and racing
  // it.
  const v = new Visit("account", { routes: landed.routes, search: "?paid=1" });
  const started = v.start();
  await v.until("the notice that says a payment was made, without claiming it landed", () => v.text("notice") === THANKS_UNKNOWN);
  await v.until("the page to stop waiting", () => v.text("notice") === PENDING_UNKNOWN, 5_000);
  assert.equal(v.$("notice").className, "note", "it is not a warning: the figures may already show it");
  assert.match(v.text("figures"), /^Available \$30\.00 /);
  await started;

  const later = world();
  const w = new Visit("account", { routes: later.routes, search: "?paid=1" });
  const startedLater = w.start();
  await w.until("the same notice with nothing remembered in this tab either", () => w.text("notice") === THANKS_UNKNOWN);
  later.subscription = ACTIVE;
  await w.until("the arrival to be seen", () => w.text("notice") === "Your payment has arrived.");
  await startedLater;
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
    "Day Charged Calls Input tokens Output tokens",
    "Oct 5, 2026 $0.0084 3 300 60",
    "Oct 4, 2026 $0.0004 1 100 20",
    "Oct 3, 2026 $0.0008 2 200 40",
    "Total $0.0096 6 600 120",
  ]);
  assert.deepEqual(rows(tables[1]!), ["Workspace Charged Calls Input tokens Output tokens", "Research $0.009 4 400 80", "A deleted workspace $0.0006 2 200 40", "No workspace $0.00 0 0 0"]);
  // A phone draws no header row, so every figure carries the column's first word as the label beside it: check each one, and the total's.
  for (const table of tables) {
    const words = (table.querySelector("thead tr") as FakeNode).children.filter((n) => !n.isText).map((c) => v.text(c).split(" ")[0]);
    for (const tr of [...table.querySelectorAll("tbody tr"), ...table.querySelectorAll("tfoot tr")]) {
      const cells = tr.children.filter((n) => !n.isText);
      assert.equal(cells[0]!.getAttribute("data-h"), null, "a row's own name is not a figure, and takes no label");
      cells.slice(1).forEach((cell, i) => assert.equal(cell.getAttribute("data-h"), words[i + 1], `${v.text(cell)} is named ${words[i + 1]}, the word a phone draws beside it`));
    }
  }
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
  assert.equal(v.text(first.querySelector("thead tr")!), "Day Charged Calls Failed Input tokens Output tokens");
  assert.equal(v.text(first.querySelector("tfoot tr")!), "Total $0.002 20 1 200 100");
});

test("a usage read that fails while the page draws is said to a reader, not only drawn", async () => {
  const w = world((x) => {
    paid(x);
    x.workspaces = [workspace()];
  });
  w.answers.set("GET /api/usage", failure(502, "usage_unavailable", "Usage could not be read just now. Try again in a moment."));
  const v = await visit("account", { routes: w.routes });
  // The first read is not a button anyone pressed, so the panel's own line says what failed: the sentence beside it is for a person
  // looking at the panel, and a reader who is not looking at it would otherwise hear nothing at all.
  assert.equal(v.$("usage-say").getAttribute("role"), "status");
  assert.equal(v.text("usage-say"), "Usage. Usage could not be read just now. Try again in a moment.");
  w.answers.set("GET /api/usage", { json: NO_USAGE });
  v.click(v.button("usage", "Try again"));
  await v.idle();
  assert.match(v.text("usage"), /^Nothing has been used yet\./);
  assert.equal(v.text("usage-say"), "", "the line goes when a read answers");
  assert.equal(v.doc.activeElement, v.$("usage-h"), "and the cursor goes to the section's heading, as a retry that answers does");
});

test("usage that cannot be read says so and can be asked for again", async () => {
  const w = world((x) => {
    paid(x);
    x.workspaces = [workspace()];
  });
  w.answers.set("GET /api/usage", failure(502, "usage_unavailable", "Usage could not be read just now. Try again in a moment."));
  const v = await visit("account", { routes: w.routes });
  assert.equal(v.text("usage"), "Usage could not be read just now. Try again in a moment. Try again");
  const again = v.button("usage", "Try again");
  assert.equal(again.getAttribute("aria-describedby"), "usage-fail", "the button that asks again carries the reason beside it");
  w.answers.set("GET /api/usage", failure(502, "usage_unavailable", "Usage could not be read just now. Try again in a moment."));
  v.click(again);
  await v.idle();
  assert.equal(v.doc.activeElement, v.button("usage", "Try again"), "a retry that fails again leaves the cursor on the way to retry");
  assert.equal(v.text("usage-fail"), "Usage could not be read just now. Try again in a moment.");
  w.answers.set("GET /api/usage", { json: NO_USAGE });
  v.click(v.button("usage", "Try again"));
  await v.idle();
  assert.match(v.text("usage"), /^Nothing has been used yet\./);
  assert.equal(v.doc.activeElement, v.$("usage-h"), "an answer that arrives takes the cursor to the section it answers for");
  assert.equal(v.$("usage-h").getAttribute("tabindex"), "-1", "so that a heading can hold the cursor, as the plan section does");
});

// ---- the password ----

test("changing the password sends both, says it is done, and empties the fields; a refusal about a field is said in that field, and does not sign the person out", async () => {
  const w = world(paid);
  w.answers.set("POST /api/password", failure(403, "invalid_credentials", "The current password is not right."));
  const v = await visit("account", { routes: w.routes });
  await v.send(v.$("password-form"));
  assert.equal(v.text("current-error"), "Enter your current password.");
  assert.equal(v.text("password-status"), "", "a refusal about a field is not said at the top of the form");
  assert.equal(v.doc.activeElement, v.$("current"));
  v.type("current", "old");
  assert.equal(v.text("current-error"), "", "typing in the field clears its sentence");
  await v.send(v.$("password-form"));
  assert.equal(v.text("next-error"), "Use at least 10 characters.");
  assert.equal(v.text("password-status"), "", "and the form's own line stays empty");
  assert.equal(v.doc.activeElement, v.$("next"));
  assert.deepEqual(v.$("next").getAttribute("aria-describedby")!.split(" "), ["next-hint", "next-error"], "the field describes its hint and its refusal");
  v.type("next", "a much better password");
  assert.equal(v.text("next-error"), "", "typing in it clears that too");
  w.answers.set("POST /api/password", failure(502, "unavailable", "Something went wrong on our side. Try again in a moment."));
  await v.send(v.$("password-form"));
  assert.equal(v.text("password-status"), "Something went wrong on our side. Try again in a moment.", "a failure that is not about a field is said by the form");
  assert.equal(v.text("current-error"), "", "and no field is blamed for it");
  assert.equal(v.$("current").getAttribute("aria-invalid"), null);
  w.answers.set("POST /api/password", failure(403, "invalid_credentials", "The current password is not right."));
  await v.send(v.$("password-form"));
  assert.equal(v.text("current-error"), "The current password is not right.");
  assert.equal(v.text("password-status"), "", "the form's own line is not used for it");
  assert.equal(v.$("current").getAttribute("aria-invalid"), "true");
  assert.equal(v.doc.activeElement, v.$("current"), "the cursor is in the field that is wrong");
  assert.deepEqual(v.navigations, [], "a 403 for the wrong password is not a signed-out session");
  assert.equal(v.$("current").value, "old", "the fields are kept for another try");
  w.answers.set("POST /api/password", failure(400, "weak_password", "That password is too easy to guess."));
  await v.send(v.$("password-form"));
  assert.equal(v.text("next-error"), "That password is too easy to guess.");
  assert.equal(v.text("current-error"), "", "one refusal answers the last");
  assert.equal(v.doc.activeElement, v.$("next"), "and for a new password that is too weak, in that one");
  w.answers.set("POST /api/password", { json: { ok: true } });
  v.type("next", "a much better password");
  v.type("current", "the right one");
  await v.send(v.$("password-form"));
  assert.deepEqual(v.to("POST", "/api/password").at(-1)!.body, { current: "the right one", next: "a much better password" });
  assert.equal(v.text("password-status"), "Your password is changed. Every other device is signed out.");
  assert.equal(v.$("password-status").className, "note note-ok");
  assert.equal(v.$("next").getAttribute("aria-invalid"), null, "and nothing is left refused");
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
  const at = v.$("who").children[2]!;
  assert.deepEqual([v.$("who").children.length, at.className, at.children.length, at.children[0]!.isText], [3, "who-a", 1, true], "a caption, a space, and the address as one text node");
  assert.ok(v.text("workspaces").startsWith(`${evil} Running `), v.text("workspaces"));
  assert.ok(v.text("workspaces").includes("<i>why</i>. Delete it and make a new one."), "a reason is text too");
  assert.ok(v.text("usage").includes(evil), "and so is a name in the usage tables");
  assert.equal(v.text("stage-title"), "", "the card is not drawn for a workspace that can be opened");
  assert.ok(v.text("workspaces").includes(`${evil} Running`), "the record says the name it was given, as text");
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
  for (const claim of [/You bring your own model key and pay your provider directly\./, /Your own model key/, /Hosting, not tokens/, /It is not part of the payment/]) assert.match(hosting.text("main"), claim, String(claim));
  for (const claim of [/Models included/, /included usage/i, /model usage each month/i, /add credit/i]) assert.doesNotMatch(hosting.text("main"), claim, `a service that sells none does not say ${claim}`);

  const credit = world((x) => (x.signedIn = false));
  const sells = await visit("home", { routes: credit.routes });
  for (const claim of [/bring your own model key/i, /Your own model key/, /Hosting, not tokens/, /does not resell/, /not part of the payment/, /pay your (model )?provider/i]) assert.doesNotMatch(sells.text("main"), claim, `a service that sells usage does not say ${claim}`);
  assert.match(sells.text("main"), /\$20\.00 of model usage each month/, "it says what its plans include");
  assert.match(sells.text("main"), /Models included/, "and says it in a fact of its own");
  assert.match(sells.text("topups"), /Add credit at any time/);
  assert.match(sells.text("main"), /We run the server; you open the workspace in a browser\./, "the hero's promise is true of either arrangement");

  const unknown = world((x) => {
    x.signedIn = false;
    x.plans = failure(503, "unavailable", "The plans are not available just now.");
  });
  const down = await visit("home", { routes: unknown.routes });
  assert.doesNotMatch(down.text("main"), /Hosting, not tokens|Models included|does not resell|included usage/i, "when the plans cannot be read the page says only what is true of both arrangements, and never asserts one");
  assert.match(down.text("main"), /Model usage, stated/, "it says the plan is what states which arrangement applies");
  const page = fs.readFileSync(`${PAGES_DIR}/index.html`, "utf8");
  assert.equal((page.match(/data-hosting-only/g) ?? []).length, 4, "the four places that speak of a hosting-only service are marked: two of the facts, the third step of how it works, and one of the billing facts");
  assert.equal((page.match(/data-usage-sold/g) ?? []).length, 4, "and the four places that say what a service that sells credit does in their place");
  assert.equal((page.match(/data-model-note/g) ?? []).length, 3, "and the three neutral places, which a page with no plans keeps: a fact, the third step, and one billing fact");
});

test("the plans have a shape while they are read, from the moment the page starts, and a reader who cannot see it is told they are loading", async () => {
  const w = world((x) => (x.signedIn = false));
  let during: string[][] = [];
  let asking: string[] = [];
  const v = new Visit("home", { routes: w.routes });
  w.answers.set("GET /api/session", () => {
    asking = v.$("plans").children.map((n) => n.className);
    return { json: { account: null } };
  });
  w.answers.set("GET /api/plans", () => {
    const kids = v.$("plans").children;
    during = [kids.map((n) => n.className), [v.text("plans")], kids.map((n) => n.getAttribute("aria-hidden") ?? "")];
    return { json: PLANS };
  });
  await v.start();
  assert.deepEqual(asking, ["sk sk-plan", "sk sk-plan", "sr"], "the shape is there while the session is still being read, which is the first thing a slow connection waits for");
  assert.deepEqual(during[0], ["sk sk-plan", "sk sk-plan", "sr"], "the shape of two cards, and a line for a reader of the page");
  assert.deepEqual(during[1], ["Loading the plans."], "the line is the only text, and it is read out: the region is polite");
  assert.deepEqual(during[2], ["true", "true", ""], "the shapes are for the eye, the line is not");
  assert.deepEqual(v.$("plans").querySelectorAll(".sk"), [], "and they are gone when the cards are there");
  assert.equal(v.$("plans").querySelectorAll("article").length, 2);
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
    "Create your account An email and a password. We send a link to confirm your address. Nothing is charged yet.",
    "Choose a plan One flat price for each period, paid on the payment provider's page. The card says what it includes and how many workspaces your account may run at once.",
    "Make a workspace One click starts your own Curule host on our servers. You give it your model key once it has started.",
    "Describe your team Open the workspace in your browser, describe the team you want, and start a mission. Every action is recorded.",
  ]);

  const sells = await visit("home", { routes: world((x) => (x.signedIn = false)).routes });
  assert.equal(sells.text(steps(sells)[2]!), "Make a workspace One click starts your own Curule host on our servers. Its plan's model usage is ready to use.");
  assert.deepEqual(steps(sells).map((li) => sells.text(li.querySelector("strong")!)), ["Create your account", "Choose a plan", "Make a workspace", "Describe your team"]);

  const unknown = await visit("home", { routes: world((x) => { x.signedIn = false; x.plans = failure(503, "unavailable", "The plans are not available just now."); }).routes });
  assert.equal(unknown.text(steps(unknown)[2]!), "Make a workspace One click starts your own Curule host on our servers. The plan says what it includes.", "when the plans cannot be read the step is true of either arrangement");
  assert.doesNotMatch(unknown.text(steps(unknown)[2]!), /model key|service's models/);
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
