/**
 * "Check your email" and "That link did not work": asking for the confirmation link again, with the wait of a minute said as text and held by
 * the page, the address that was typed handed back to the sign-up page when it is the wrong one, and nothing said that the service did not say.
 * Time is the test's here (`advance`), so a minute takes no time.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { visit, type Visit } from "./pages-support";
import { failure, world } from "./pages-world";

const SENT = { status: 202, json: { ok: true, message: "Check your email for a link to confirm your address." } };
const ASKED = { status: 202, json: { ok: true, message: "If that address is waiting to be confirmed, a new link is on its way." } };

async function signedUp(address = "ada@example.com", answer: Parameters<ReturnType<typeof world>["answers"]["set"]>[1] = ASKED, storage: Record<string, string> = {}): Promise<{ v: Visit; w: ReturnType<typeof world> }> {
  const w = world((x) => (x.signedIn = false));
  w.answers.set("POST /api/signup", SENT);
  w.answers.set("POST /api/verify/resend", answer);
  const v = await visit("signup", { routes: w.routes, manualTimers: true, storage });
  v.type("email", ` ${address} `);
  v.type("password", "correct horse battery staple");
  v.check("agree");
  await v.send(v.$("form"));
  return { v, w };
}

test("the page that says the link was sent names the address, offers to send it again or to use another, and says what usually goes wrong", async () => {
  const { v } = await signedUp();
  assert.equal(v.text("title"), "Check your email");
  assert.equal(v.text(v.$("card").querySelector("strong")!), "ada@example.com", "the address it went to, as typed and without the spaces round it");
  assert.deepEqual(v.labels("card"), ["Resend the email"]);
  assert.equal(v.link("card", "Use another address").getAttribute("href"), "/signup");
  assert.deepEqual(v.$("card").querySelectorAll("li").map((li) => v.text(li)), ["It can take a few minutes. Look in your spam or junk folder too.", "Check the address above for a typo. If it is wrong, use another address."]);
  assert.equal(v.text(v.$("card").querySelector("h2")!), "If it does not come");
  assert.equal(v.doc.activeElement, v.$("card"), "and the cursor is on what happened");
});

test("the wait of a minute is said as text that counts down, is not read out at every second, and is held by the page", async () => {
  const { v, w } = await signedUp();
  const press = v.$("resend");
  const wait = v.$("resend-wait");
  assert.equal(v.text(wait), "You can ask for another in 60 seconds.");
  assert.deepEqual([wait.getAttribute("role"), wait.getAttribute("aria-live")], [null, null], "the count is not a live region: it would be read out at every second");
  assert.equal(press.held, true, "the email has just gone: the first minute is already a wait");
  const answer = v.$("resend-status");
  assert.deepEqual([answer.getAttribute("role"), answer.getAttribute("aria-live"), v.text(answer)], ["status", "polite", ""], "what is read out is the answer, and that the wait is over");

  v.click(press);
  await v.idle();
  assert.deepEqual(v.to("POST", "/api/verify/resend"), [], "pressed in the wait it asks for nothing");
  assert.equal(v.text(press), "Resend the email", "and does not say it is sending");

  await v.advance(1000);
  assert.equal(v.text(wait), "You can ask for another in 59 seconds.");
  await v.advance(57_000);
  assert.equal(v.text(wait), "You can ask for another in 2 seconds.");
  await v.advance(1000);
  assert.equal(v.text(wait), "You can ask for another in 1 second.", "one second is one second");
  assert.equal(press.held, true);
  await v.advance(1000);
  assert.equal(v.text(wait), "");
  assert.equal(press.held, false);
  assert.equal(v.text(answer), "You can ask for another email now.", "and the end of it is said, once");
  assert.equal(answer.className, "note");
  assert.equal(w.answers.size, 2);
});

test("asking again sends the address the link went to, says what the service said and no more, and starts another wait", async () => {
  const { v } = await signedUp("ada@example.com");
  await v.advance(60_000);
  v.click(v.$("resend"));
  assert.equal(v.text("resend"), "Sending", "while the call is out the button says what it is doing");
  await v.idle();
  assert.deepEqual(v.to("POST", "/api/verify/resend"), [{ method: "POST", path: "/api/verify/resend", body: { email: "ada@example.com" } }]);
  assert.equal(v.text("resend"), "Resend the email");
  assert.equal(v.text("resend-status"), "If that address is waiting to be confirmed, a new link is on its way.", "the service's own words: it does not say whether there is an account, and neither does the page");
  assert.equal(v.$("resend-status").className, "note note-ok");
  assert.equal(v.text("resend-wait"), "You can ask for another in 60 seconds.");
  assert.equal(v.$("resend").held, true);
  assert.equal(v.doc.activeElement, v.$("resend"), "the cursor is on the button that was pressed, which is not drawn again");

  v.click(v.$("resend"));
  await v.idle();
  assert.equal(v.to("POST", "/api/verify/resend").length, 1, "and in the new wait it asks for nothing more");
  await v.advance(60_000);
  v.click(v.$("resend"));
  await v.idle();
  assert.equal(v.to("POST", "/api/verify/resend").length, 2);
});

test("a refusal is said in the service's words and starts no wait, and a service that cannot be reached is said", async () => {
  const limited = await signedUp("ada@example.com", failure(429, "rate_limited", "Too many attempts. Try again in 42 minutes."));
  await limited.v.advance(60_000);
  limited.v.click(limited.v.$("resend"));
  await limited.v.idle();
  assert.equal(limited.v.text("resend-status"), "Too many attempts. Try again in 42 minutes.");
  assert.equal(limited.v.$("resend-status").className, "note note-bad");
  assert.equal(limited.v.$("resend").held, false);
  assert.equal(limited.v.text("resend-wait"), "", "nothing was sent, so there is no wait to say");

  const down = await signedUp("ada@example.com", { fail: true });
  await down.v.advance(60_000);
  down.v.click(down.v.$("resend"));
  await down.v.idle();
  assert.equal(down.v.text("resend-status"), "The service could not be reached. Check your connection and try again.");
  assert.equal(down.v.$("resend").held, false);
});

test("an address that is not an address is a name: nothing typed on the page becomes markup", async () => {
  const { v } = await signedUp("<i>ada</i>@example.com");
  const inside = v.$("card").descendants().map((n) => n.tag);
  assert.ok(!inside.includes("i"), "no <i> element came of it");
  assert.equal(v.text(v.$("card").querySelector("strong")!), "<i>ada</i>@example.com");
});

test("Use another address leaves for the sign-up page and hands it the address that was typed, once, so a typo is put right and not typed again", async () => {
  const { v } = await signedUp("ada@exmaple.com");
  assert.deepEqual([...v.storage.keys()], [], "nothing is kept until the person leaves");
  v.click(v.$("another"));
  assert.deepEqual([...v.storage.entries()], [["curule:signup-address", "ada@exmaple.com"]]);

  const w = world((x) => (x.signedIn = false));
  const back = await visit("signup", { routes: w.routes, storage: Object.fromEntries(v.storage) });
  assert.equal(back.$("email").value, "ada@exmaple.com", "the address is there to be corrected");
  assert.equal(back.$("password").value, "", "and nothing else is");
  assert.deepEqual([...back.storage.keys()], [], "it was read once and forgotten");

  const fresh = await visit("signup", { routes: w.routes });
  assert.equal(fresh.$("email").value, "", "a visitor who did not come that way finds an empty field");
});

test("a link that did not work offers a new one: the person gives the address, and is told what the service said", async () => {
  const w = world((x) => (x.signedIn = false));
  w.answers.set("POST /api/verify", failure(400, "invalid_token", "That link is not valid, or it has expired. Ask for a new one."));
  w.answers.set("POST /api/verify/resend", ASKED);
  const v = await visit("verify", { routes: w.routes, search: "?token=old", manualTimers: true, pointer: "fine" });
  assert.equal(v.$("again").hidden, false);
  assert.match(v.text("again"), /^A link works once and expires after 24 hours\. Enter your address and we send a new one, if it is waiting to be confirmed\. Email Send a new link/);
  assert.equal(v.doc.activeElement, v.$("email"), "the cursor is where the address goes");
  const answer = v.$("resend-status");
  assert.deepEqual([answer.getAttribute("role"), answer.getAttribute("aria-live")], ["status", "polite"], "the answer is read out, politely");

  v.click(v.$("resend"));
  await v.idle();
  assert.equal(v.text("resend-status"), "Enter your email address.");
  assert.equal(v.$("email").getAttribute("aria-invalid"), "true");
  assert.deepEqual(v.to("POST", "/api/verify/resend"), [], "with no address there is nothing to send");
  assert.equal(v.doc.activeElement, v.$("email"));

  v.type("email", "  ada@example.com ");
  v.click(v.$("resend"));
  await v.idle();
  assert.deepEqual(v.to("POST", "/api/verify/resend"), [{ method: "POST", path: "/api/verify/resend", body: { email: "ada@example.com" } }]);
  assert.equal(v.text("resend-status"), "If that address is waiting to be confirmed, a new link is on its way.");
  assert.equal(v.text("resend-wait"), "You can ask for another in 60 seconds.");
  assert.equal(v.$("resend").held, true);
  v.click(v.$("resend"));
  await v.idle();
  assert.equal(v.to("POST", "/api/verify/resend").length, 1, "not again within the minute");
  await v.advance(60_000);
  assert.equal(v.$("resend").held, false);
  assert.equal(v.text("resend-status"), "You can ask for another email now.");
});

test("a link with no token in it, and a link that worked, are as they were: the offer is only for the link that did not", async () => {
  const w = world((x) => (x.signedIn = false));
  w.answers.set("POST /api/verify", { json: { account: w.view() } });
  const good = await visit("verify", { routes: w.routes, search: "?token=ok" });
  assert.equal(good.$("again").hidden, true);
  const none = await visit("verify", { routes: w.routes });
  assert.equal(none.$("again").hidden, false, "a link with no token is a link that did not work, and the person can ask for another");
  assert.equal(none.text("status"), "This link is incomplete. Open the link in the email again.");
});

test("the sign-in page offers the confirmation link again after a refusal of the email and password, to everyone, and after nothing else", async () => {
  const w = world((x) => (x.signedIn = false));
  w.answers.set("POST /api/login", failure(401, "invalid_credentials", "That email and password do not match an account."));
  w.answers.set("POST /api/verify/resend", ASKED);
  const v = await visit("login", { routes: w.routes, manualTimers: true });
  assert.equal(v.$("resend-form").hidden, true, "a person who has just come has not been refused, and is not shown it");
  v.type("email", " ada@example.com ");
  v.type("password", "a wrong password");
  await v.send(v.$("form"));
  v.type("password", "another wrong password");
  await v.send(v.$("form"));
  assert.equal(v.text("status"), "That email and password do not match an account.", "the service says the same for every way it can fail, and so does the page");
  assert.equal(v.doc.activeElement, v.$("password"), "and the cursor is in the field to try again");
  assert.equal(v.shows(v.$("resend-form")), true);
  assert.equal(v.text("resend-form"), "Not confirmed your address yet? We can send the link again. Send the confirmation link again");

  v.click(v.$("resend"));
  await v.idle();
  assert.deepEqual(v.to("POST", "/api/verify/resend"), [{ method: "POST", path: "/api/verify/resend", body: { email: "ada@example.com" } }]);
  assert.equal(v.text("resend-status"), "If that address is waiting to be confirmed, a new link is on its way.");
  assert.equal(v.text("resend-wait"), "You can ask for another in 60 seconds.");
  v.click(v.$("resend"));
  await v.idle();
  assert.equal(v.to("POST", "/api/verify/resend").length, 1, "not again within the minute");
  await v.advance(60_000);
  v.type("email", "bob@example.com");
  v.click(v.$("resend"));
  await v.idle();
  assert.equal(v.to("POST", "/api/verify/resend")[1]!.body && (v.to("POST", "/api/verify/resend")[1]!.body as { email: string }).email, "bob@example.com", "the address in the field now is the one it is sent to");
  assert.equal(v.to("POST", "/api/login").length, 2);

  const limited = world((x) => (x.signedIn = false));
  limited.answers.set("POST /api/login", failure(429, "rate_limited", "Too many attempts. Wait a minute and try again."));
  const l = await visit("login", { routes: limited.routes });
  l.type("email", "ada@example.com");
  l.type("password", "a wrong password");
  await l.send(l.$("form"));
  assert.equal(l.text("status"), "Too many attempts. Wait a minute and try again.");
  assert.equal(l.$("resend-form").hidden, true, "a refusal that is not of the email and password is not the occasion");
});
