import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as vm from "node:vm";
import { parsePage, type FakeDocument, type FakeNode } from "../cloud/pages-support";
import { ROOT, SITE, loadScript, page, sitePages } from "./site-pages";

/**
 * The way from the site into Curule Cloud: "Sign in" and "Get started" in every page's header, the home page's calls to action,
 * the pricing page's strip, and the sentences that say Curule is software you run and is not offered as a hosted service, which
 * give way to the ones that say it is. All of it is off until the service is open (`CLOUD_URL` in the shared script): until the day
 * there is something to sign in to, no page may mention it, and no page may say it is not there once there is.
 *
 * Which state a page is in is written into its markup, in the state `CLOUD_URL` says (scripts/set-domain.mjs, through
 * scripts/site-cloud-state.mjs), so that it is right before the script runs and without it. The script is run unchanged, in the
 * small DOM the account pages' tests use, on each page's own markup, with the address set to each state in turn: it must leave a
 * page that is right as it is, and put one that is not right, and the two must say the same thing.
 */

const SCRIPT = fs.readFileSync(path.join(SITE, "assets", "site.js"), "utf8");
const pages = sitePages();
const APP = "https://app.curule.dev";

/** Some markup as a browser leaves it once the shared script has run, with Curule Cloud at `cloud` ("" while it is not open). */
function run(html: string, cloud: string, dashboard = ""): FakeDocument {
  const doc = parsePage(html);
  const script = SCRIPT.replace(/^var CLOUD_URL = "[^"]*";/m, `var CLOUD_URL = ${JSON.stringify(cloud)};`).replace(/^var APP_URL = "[^"]*";/m, `var APP_URL = ${JSON.stringify(dashboard)};`);
  vm.runInNewContext(script, { document: doc, navigator: {}, window: { setTimeout, clearTimeout } }, { filename: "site.js" });
  return doc;
}

/** A page of the site, so run. */
const visit = (rel: string, cloud: string, dashboard = ""): FakeDocument => run(page(pages, rel).html, cloud, dashboard);

/** The page as a visitor with no script has it. */
const asFile = (rel: string): FakeDocument => parsePage(page(pages, rel).html);

const shown = (node: FakeNode): boolean => {
  for (let n: FakeNode | null = node; n; n = n.parent) if (n.hidden) return false;
  return true;
};

/** What a visitor reads in part of a page: the text of what is not hidden. */
function visibleTextOf(node: FakeNode): string {
  const out: string[] = [];
  const walk = (n: FakeNode): void => {
    if (n.isText) out.push(n.textContent);
    else if (!n.hidden && n.tag !== "script" && n.tag !== "style") for (const c of n.children) walk(c);
  };
  walk(node);
  return out.join(" ").replace(/\s+/g, " ");
}

/** What a visitor reads on the page. */
const visibleText = (doc: FakeDocument): string => visibleTextOf(doc.body);

const REL = pages.map((p) => p.rel);

interface Config {
  url: string;
  paths: Record<string, string>;
}
interface CloudState {
  cloudConfigOf(script: string): Config;
  cloudState(html: string, config: Config): string;
}
/** The elements whose state depends on whether Curule Cloud is open. */
const SWITCHED = "[data-cloud], [data-cloud-only], [data-selfhost-only]";

test("the pages are closed when the address is empty: no page mentions Curule Cloud, and nothing is linked", () => {
  // The committed script carries whatever address set-domain last wrote. Curule Cloud is open at https://app.curule.dev since
  // 2026-10-06, so the script holds it; "closed" is what the pages do when the address is empty, which is tried here by passing "".
  assert.match(SCRIPT, /^var CLOUD_URL = "(|https:\/\/[^"]+)";/m, "an empty address (closed) or the app's https address (open), nothing else");
  for (const rel of REL) {
    for (const doc of [visit(rel, "")]) {
      for (const node of doc.querySelectorAll("[data-cloud], [data-cloud-only]")) assert.equal(shown(node), false, `${rel}: <${node.tag} ${[...node.attrs.keys()].join(" ")}> is hidden while it is not open`);
      for (const node of doc.querySelectorAll("[data-selfhost-only]")) assert.equal(shown(node), true, `${rel}: what says it is software you run is shown`);
      assert.ok(!/Curule Cloud|Get started/.test(visibleText(doc)), `${rel}: a visitor is told of nothing that is not there`);
    }
  }
  const links = visit("index.html", "").querySelectorAll("[data-cloud]");
  assert.ok(links.length >= 4);
  for (const a of links) assert.equal(a.href, "#", "and no link was given an address");
});

test("when it is open, every page has Sign in and Get started in its header, with addresses in the app, and the demo is no longer its one button", () => {
  for (const rel of REL) {
    const doc = visit(rel, APP);
    const bar = doc.querySelector(".bar-actions")!;
    const signIn = doc.querySelector(".site-header")!.querySelectorAll('[data-cloud="login"]');
    assert.equal(signIn.length, 2, `${rel}: Sign in, in the bar and in the phone menu`);
    for (const a of signIn) {
      assert.equal(shown(a), true, rel);
      assert.equal(a.href, `${APP}/login`, rel);
      assert.equal(a.textContent, "Sign in", rel);
    }
    const start = bar.querySelectorAll('[data-cloud="signup"]');
    assert.equal(start.length, 1, `${rel}: Get started, in the bar`);
    assert.equal(shown(start[0]!), true);
    assert.equal(start[0]!.href, `${APP}/signup`);
    assert.equal(start[0]!.textContent, "Get started");
    assert.deepEqual(bar.querySelectorAll("[data-selfhost-only]").map((a) => shown(a)), [false], `${rel}: the demo button gives its place to Get started`);
  }
});

test("the address may end in a slash, and a dashboard's own sign-in link gives way to the account's: a visitor is not asked which is theirs", () => {
  for (const cloud of [`${APP}/`, `${APP}///`]) {
    const doc = visit("index.html", cloud, "https://mesh.curule.dev/");
    const links = doc.querySelectorAll('[data-cloud="login"], [data-cloud="signup"]');
    for (const a of links) assert.equal(a.href, `${APP}/${a.getAttribute("data-cloud")}`, `${cloud}: ${a.textContent}`);
    assert.equal(links.filter((a) => a.getAttribute("data-cloud") === "login").length, 2, "Sign in, in the bar and in the phone menu");
    assert.ok(links.filter((a) => a.getAttribute("data-cloud") === "signup").length >= 4, "and Get started, in the bar, the hero, the way in and the end of the page");
  }
  const both = visit("index.html", APP, "https://mesh.curule.dev/");
  const dashboard = both.querySelectorAll("[data-app]");
  assert.equal(dashboard.length, 2);
  assert.deepEqual(dashboard.map((a) => [a.href, shown(a)]), [["https://mesh.curule.dev/", false], ["https://mesh.curule.dev/", false]]);
  const only = visit("index.html", "", "https://mesh.curule.dev/");
  assert.deepEqual(only.querySelectorAll("[data-app]").map((a) => shown(a)), [true, true], "without Curule Cloud the dashboard's link is shown, as it was");
});

test("when it is open, the home page leads with Get started, says Curule is also run for you, and no sentence on any page still says it is not", () => {
  const home = visit("index.html", APP);
  const text = visibleText(home);
  assert.match(text, /A team of AI agents, run like an organization\./, "the tagline does not move");
  const hero = home.querySelector(".hero")!;
  assert.match(hero.querySelectorAll("p").filter((p) => shown(p)).map((p) => p.textContent).join(" "), /Curule Cloud runs it for you, and you bring your own model key/, "the hero says Curule is also run for you, and what that asks of the visitor");
  const closing = home.querySelectorAll("section.cta").filter((s) => shown(s));
  assert.equal(closing.length, 1, "one closing call to action, not both");
  assert.deepEqual(closing[0]!.querySelectorAll(".btn").map((b) => [b.textContent, b.href]), [["Get started", `${APP}/signup`], ["Try the demo", "#try"]]);
  const hosting = home.querySelectorAll("details").filter((d) => shown(d) && d.querySelector("summary")!.textContent === "Can you host it for us?");
  assert.equal(hosting.length, 1, "the question is asked once");
  assert.match(hosting[0]!.textContent, /^Can you host it for us\?Yes: that is Curule Cloud\./);
  assert.equal(hosting[0]!.querySelector("[data-cloud]")!.href, `${APP}/`);

  for (const rel of REL) {
    const said = visibleText(visit(rel, APP));
    for (const phrase of ["not offered as a hosted service", "We do not run it for you", "Not today", "There is no checkout and no account", "no billing system on this site. A paid plan", "There is no checkout, and we agree"]) assert.ok(!said.includes(phrase), `${rel}: still says "${phrase}"`);
    // Curule Cloud sells hosting. The customer brings a model key, so no page may say the models come with it.
    assert.ok(!/models are supplied|supply the models|need no provider account|no model key/i.test(said), `${rel}: says Curule Cloud supplies the models`);
  }
  const anthropic = home.querySelectorAll("details").find((d) => shown(d) && d.querySelector("summary")!.textContent === "Do I need an Anthropic account?")!;
  assert.match(anthropic.textContent, /On Curule Cloud you bring your own model key as well: we run the servers and do not resell model usage, so your provider bills you there too\./, "the answer to who pays for the model agrees with the rest of the page");
  const closed = visibleText(visit("index.html", ""));
  assert.match(closed, /Not today\. It is software you run, one instance per team/, "and while it is closed the same question is answered as it was");
});

test("the hero has one clear action in each state, Get started while Curule Cloud is open and the demo while it is not, and a quiet second", () => {
  const states = [
    ["open", APP, [["Get started", `${APP}/signup`]], [["Try the demo", "#try"]]],
    ["closed", "", [["Try the demo", "#try"]], [["See pricing", "pricing/"]]],
  ] as const;
  for (const [state, url, primary, quiet] of states) {
    const hero = visit("index.html", url).querySelector(".hero")!;
    const links = (selector: string): string[][] => hero.querySelectorAll(selector).filter((a) => shown(a)).map((a) => [a.textContent, a.href]);
    assert.deepEqual(links(".btn-primary"), primary, `${state}: the one action that leads`);
    assert.deepEqual(links(".arrow-link"), quiet, `${state}: and the one that follows it, quietly`);
    assert.equal(hero.querySelectorAll(".btn").filter((a) => shown(a)).length, 1, `${state}: no second button to choose between`);
  }
  // Only the actions and what is said under them are of one state: what the hero is, and the picture, are the same words either way.
  const switched = parsePage(page(pages, "index.html").html).querySelector(".hero-grid")!.querySelectorAll("[data-cloud-only], [data-selfhost-only]");
  assert.deepEqual(switched.map((n) => n.className || n.tag), ["actions", "small muted mt-s", "actions", "small muted mt-s"], "the statement, the subhead, the proof and the picture do not depend on whether Curule Cloud is open");
});

test("the home page's way in is two cards while Curule Cloud is open and one while it is not, each saying who it is for, what is paid and the one thing to press", () => {
  const states = [
    ["open", APP, ["Two ways in", "Who runs it?"], ["We run it for you", "You run it"], [[["Get started", `${APP}/signup`]], [["Try the demo", "#try"]]]],
    ["closed", "", ["Start here", "You run it, and it is free to start."], ["You run it"], [[["Try the demo", "#try"]]]],
  ] as const;
  for (const [state, url, heading, titles, actions] of states) {
    const doc = visit("index.html", url);
    const ways = doc.getElementById("ways")!;
    assert.deepEqual([...ways.querySelectorAll(".eyebrow"), ...ways.querySelectorAll("h2")].filter((n) => shown(n)).map((n) => n.textContent), heading, `${state}: its heading`);
    const cards = ways.querySelectorAll(".way").filter((c) => shown(c));
    assert.deepEqual(cards.map((c) => c.querySelector("h3")!.textContent), titles, `${state}: the cards`);
    cards.forEach((card, i) => {
      assert.deepEqual(card.querySelectorAll("dt").map((t) => t.textContent), ["Who it is for", "What you pay"], `${state}: ${titles[i]} says who it is for and what is paid`);
      assert.deepEqual(card.querySelectorAll(".way-action a").map((a) => [a.textContent, a.href]), actions[i], `${state}: ${titles[i]}: the one thing to press`);
    });
    if (state === "closed") assert.ok(!/Curule Cloud/.test(visibleTextOf(ways)), "closed, the way in says nothing of what is not there");
  }
  const open = visit("index.html", APP).getElementById("ways")!.querySelectorAll(".way").filter((c) => shown(c));
  assert.match(open[0]!.textContent, /the same dashboard and agents as the product you run yourself, on servers we operate/, "the account service's own words for what it is");
  assert.match(open[0]!.textContent, /A flat monthly plan for the hosting\. You bring your own model key and pay your model provider directly: we do not resell model usage\./);
  assert.match(open[1]!.textContent, /Nothing phones home: no telemetry, no update check, no licence server\./);
  assert.match(open[1]!.textContent, /Nothing for the Community plan: one open project, up to eight agents, no licence key\. A paid licence lifts the limits\./);
});

test("when it is open, the pricing page's estimate says it is for a licence, so a visitor to Curule Cloud does not read it as the price of a workspace", () => {
  const estimate = (url: string): string => visibleTextOf(visit("pricing/index.html", url).getElementById("calculator")!.querySelector(".section-head")!);
  assert.match(estimate(APP), /An estimate, not a quote\. The model figure comes from one measured mission, and yours will differ\. It is for a licence for the software you run yourself: Curule Cloud(?:&rsquo;|')s plans are on its sign-up page\./);
  assert.ok(!/Curule Cloud/.test(estimate("")), "and while it is closed the sentence is not there");
});

test("the page for an address that is not found offers the account while Curule Cloud is open, and not while it is not", () => {
  const open = visit("404.html", APP).querySelectorAll(".nf-list li").filter((li) => shown(li));
  assert.deepEqual(open.map((li) => li.querySelector("b")!.textContent), ["Try the demo", "Pricing", "Documentation", "Security", "Contact", "Your account"]);
  assert.equal(open[5]!.querySelector("a")!.href, `${APP}/login`, "an address typed for the account (/login, /account) ends here, one press from it");
  const closed = visit("404.html", "").querySelectorAll(".nf-list li").filter((li) => shown(li));
  assert.deepEqual(closed.map((li) => li.querySelector("b")!.textContent), ["Try the demo", "Pricing", "Documentation", "Security", "Contact"]);
});

test("when it is open, the security answers on the home page and on the security page say they are about the software you run yourself, and where Curule Cloud differs", () => {
  const home = visit("index.html", APP).getElementById("security")!;
  const notice = home.querySelectorAll(".notice").filter((n) => shown(n));
  assert.equal(notice.length, 1);
  assert.match(notice[0]!.textContent, /^These answers are about the software you run yourself\. On Curule Cloud we run it for you, which changes what leaves your environment: the security page says how\.$/);
  assert.equal(notice[0]!.querySelector("a")!.href, "security/#glance", "and goes to the page that says how");
  const page = visit("security/index.html", APP).getElementById("glance")!;
  assert.match(page.querySelectorAll(".notice").filter((n) => shown(n)).map((n) => n.textContent).join(""), /On Curule Cloud we run it for you, so what leaves your environment is different there/);
  assert.equal(page.querySelector(".notice a")!.href, `${APP}/privacy`, "where what Curule Cloud keeps, and who else receives it, is written");
  for (const doc of [visit("index.html", ""), visit("security/index.html", "")]) assert.ok(!/Curule Cloud/.test(visibleTextOf(doc.getElementById("main")!)), "while it is closed neither says a word of it");
});

test("the documentation page's card for Curule Cloud, and its entry in the map, are there while it is open and gone while it is not", () => {
  for (const [state, url, goals, groups] of [
    ["open", APP, ["Run the demo", "Deploy it", "Describe a team and its rules", "Use Curule Cloud"], true],
    ["closed", "", ["Run the demo", "Deploy it", "Describe a team and its rules"], false],
  ] as const) {
    const doc = visit("docs/index.html", url);
    assert.deepEqual(doc.querySelectorAll(".start").filter((c) => shown(c)).map((c) => c.querySelector("h3")!.textContent), goals, state);
    assert.equal(doc.querySelectorAll(".doc-card").filter((c) => shown(c) && c.id === "cloud-docs").length, groups ? 1 : 0, `${state}: the map lists the document the card names, or nothing of Curule Cloud`);
    if (!groups) assert.ok(!/Curule Cloud/.test(visibleTextOf(doc.getElementById("start")!)), "closed, the start cards say nothing of what is not there");
  }
  const open = visit("docs/index.html", APP).querySelectorAll(".start").filter((c) => shown(c))[3]!;
  assert.deepEqual(open.querySelectorAll("a").map((a) => [a.textContent, a.href]), [["Curule Cloud: the hosted service", "https://github.com/salitaba/agent-mesh/blob/main/docs/cloud.md"], ["Sign up", `${APP}/signup`]]);
});

test("when it is open, the pricing page puts the two ways in side by side, says the plans below are licences and sends a visitor to the app for Curule Cloud's, which are kept there and not copied", () => {
  const doc = visit("pricing/index.html", APP);
  const ways = doc.getElementById("ways")!;
  assert.equal(shown(ways), true);
  assert.match(ways.querySelector("h2")!.textContent, /^Do you run it, or do we\?$/);
  const [cloud, licence] = ways.querySelectorAll(".way") as [FakeNode, FakeNode];
  assert.deepEqual([cloud, licence].map((c) => c.querySelector("h3")!.textContent), ["We run it for you", "You run it"]);
  for (const card of [cloud, licence]) assert.deepEqual(card.querySelectorAll("dt").map((t) => t.textContent), ["Who it is for", "What you pay"], "each says who it is for and what is paid");
  assert.match(cloud.textContent, /A flat monthly plan for the hosting\. Its plans and prices are on the sign-up page, because they are kept in one place\. You bring your own model key and pay your provider directly: we do not resell model usage\./);
  assert.match(licence.textContent, /The plans below are licences for the software you run yourself\./);
  assert.deepEqual(cloud.querySelectorAll("a").map((a) => [a.textContent, a.href]), [["See the Curule Cloud plans", `${APP}/`]], "one action in each");
  assert.deepEqual(licence.querySelectorAll("a").map((a) => [a.textContent, a.href]), [["See the licence plans", "#plans"]]);
  assert.ok(!/\$\s?\d/.test(ways.textContent), "no price is written in it: Curule Cloud's plans are the account pages' to state, and the licences' are in the cards below");
  assert.equal(page(pages, "pricing/index.html").html.includes('id="cloud"'), false, "and the strip it replaces is gone: the way in is said once");
  assert.equal(shown(visit("pricing/index.html", "").getElementById("ways")!), false, "while it is closed there is one way, and the page starts at the plans");
  const rows = doc.querySelectorAll("li").filter((li) => shown(li) && li.textContent.startsWith("A hosted service."));
  assert.equal(rows.length, 1);
  assert.match(rows[0]!.textContent, /Curule Cloud, where we run it for you, is priced separately\./);
  assert.match(visibleText(visit("pricing/index.html", "")), /A hosted service\. Curule is software you run, on your own infrastructure\./, "and while it is closed, as it was");
  const contact = visit("contact/index.html", APP);
  const rows2 = contact.querySelectorAll("li").filter((li) => shown(li) && /^(We do not run it for you|Curule Cloud has its own sign-up)/.test(li.textContent));
  assert.equal(rows2.length, 1);
  assert.match(rows2[0]!.textContent, /^Curule Cloud has its own sign-up/);
  assert.equal(rows2[0]!.querySelector("[data-cloud]")!.href, `${APP}/signup`);
  const legal = visit("legal/index.html", APP);
  assert.deepEqual(legal.querySelector("main")!.querySelectorAll("[data-cloud]").filter((a) => shown(a)).map((a) => [a.textContent, a.href]), [["terms", `${APP}/terms`], ["privacy notice", `${APP}/privacy`]], "the legal page points to the app's own terms and notice");
});

test("every link into Curule Cloud that a page has, and every one the script can set, is a page the app has", () => {
  const files: Record<string, string> = { home: "index.html", login: "login.html", signup: "signup.html", terms: "terms.html", privacy: "privacy.html" };
  const used = new Set<string>();
  for (const p of pages) for (const m of p.html.matchAll(/data-cloud="([^"]*)"/g)) used.add(m[1]!);
  assert.deepEqual([...used].sort(), Object.keys(files).sort(), "the pages use the kinds the script knows, and the script knows no other");
  const mapped = /var CLOUD_PATH = \{([^}]*)\}/.exec(SCRIPT)![1]!;
  assert.deepEqual(
    [...mapped.matchAll(/(\w+): "([^"]*)"/g)].map((m) => [m[1], m[2]]).sort(),
    [["home", "/"], ["login", "/login"], ["privacy", "/privacy"], ["signup", "/signup"], ["terms", "/terms"]],
  );
  for (const file of Object.values(files)) assert.ok(fs.existsSync(path.join(ROOT, "apps", "cloud-server", "pages", file)), `the app has ${file}`);
  // The two places the app sends a visitor who is signed in already, so that "Sign in" from the site is not a dead end.
  const app = fs.readFileSync(path.join(ROOT, "apps", "cloud-server", "pages", "assets", "app.js"), "utf8");
  assert.ok(app.includes('location.replace("/account")'), "the app's sign-in and sign-up pages send a signed-in visitor on to the account");
});

test("a link of a kind the script does not know is left as it is: hidden and without an address, not a link to a page that is not there", () => {
  const html = page(pages, "index.html").html.replace("</main>", '<a id="typo" href="#" data-cloud="sigin" hidden>Sign in</a></main>');
  assert.ok(html.includes('id="typo"'));
  const typo = run(html, APP).getElementById("typo")!;
  assert.equal(typo.href, "#");
  assert.equal(shown(typo), false);
});

test("every element that gives way when Curule Cloud opens has its other half on the same page", () => {
  for (const p of pages) {
    const doc = asFile(p.rel);
    const only = doc.querySelectorAll("[data-selfhost-only]");
    const cloud = doc.querySelectorAll("[data-cloud-only]");
    // The header's demo button has no counterpart in the markup: the header's Get started takes its place.
    const counterparts = only.filter((n) => !(n.tag === "a" && n.textContent === "Try the demo" && n.parent?.className === "bar-actions"));
    assert.ok(counterparts.length <= cloud.length, `${p.rel}: ${counterparts.length} sentences about software you run, ${cloud.length} about Curule Cloud`);
  }
});

test("the committed pages are written in the state their script says, so each is right before any script runs", async () => {
  const { cloudConfigOf, cloudState } = await loadScript<CloudState>("site-cloud-state.mjs");
  const config = cloudConfigOf(SCRIPT);
  for (const p of pages) {
    assert.equal(cloudState(p.html, config), p.html, `${p.rel} says something other than CLOUD_URL in site/assets/site.js: write it again with \`npm run site:domain -- <the domain and the other arguments you used> --cloud-url ${config.url || "none"}\``);
  }
  const open = asFile("index.html");
  const bar = open.querySelector(".bar-actions")!;
  assert.deepEqual(
    bar.querySelectorAll("[data-cloud], [data-selfhost-only]").map((a) => [a.textContent, shown(a)]),
    [["Sign in", config.url !== ""], ["Get started", config.url !== ""], ["Try the demo", config.url === ""], ["Sign in", config.url !== ""]],
    "the header's links, as the markup has them: in the bar, and in the phone menu",
  );
});

test("the script and the build say the same thing: in each state, a page as the build writes it is the page as the script leaves it", async () => {
  const { cloudConfigOf, cloudState } = await loadScript<CloudState>("site-cloud-state.mjs");
  const paths = cloudConfigOf(SCRIPT).paths;
  for (const [state, url] of [["closed", ""], ["open", APP]] as const) {
    for (const p of pages) {
      const built = parsePage(cloudState(p.html, { url, paths })).querySelectorAll(SWITCHED);
      const ran = visit(p.rel, url).querySelectorAll(SWITCHED);
      assert.ok(built.length >= 4 && built.length === ran.length, `${p.rel}: the same elements are switched (${built.length}, ${ran.length})`);
      built.forEach((n, i) => {
        const same = ran[i]!;
        assert.equal(n.hidden, same.hidden, `${p.rel} (${state}): <${n.tag} ${[...n.attrs.keys()].join(" ")}> is hidden in one and not the other`);
        if (n.hasAttribute("data-cloud")) assert.equal(n.href, same.href, `${p.rel} (${state}): where ${n.textContent} goes`);
      });
    }
  }
});

test("a visitor with no script reads the page in the state the site is in: Curule Cloud's links with their addresses, and nothing that says it is not there", async () => {
  const { cloudConfigOf, cloudState } = await loadScript<CloudState>("site-cloud-state.mjs");
  const paths = cloudConfigOf(SCRIPT).paths;
  const said = ["not offered as a hosted service", "We do not run it for you", "Not today", "There is no checkout and no account", "no billing system on this site. A paid plan", "There is no checkout, and we agree"];
  for (const p of pages) {
    const open = parsePage(cloudState(p.html, { url: APP, paths }));
    const text = visibleText(open);
    for (const phrase of said) assert.ok(!text.includes(phrase), `${p.rel}: with no script, the open site still says "${phrase}"`);
    const bar = open.querySelector(".bar-actions")!;
    assert.deepEqual(
      bar.querySelectorAll("[data-cloud]").filter(shown).map((a) => [a.textContent, a.href]),
      [["Sign in", `${APP}/login`], ["Get started", `${APP}/signup`], ["Sign in", `${APP}/login`]],
      `${p.rel}: Sign in and Get started, with their addresses, in the header of a page that has no script (and Sign in again in the phone menu)`,
    );
    assert.equal(shown(open.querySelectorAll("[data-selfhost-only]").find((a) => a.textContent === "Try the demo")!), false, `${p.rel}: the demo gives its place to Get started`);
    for (const a of open.querySelectorAll("[data-cloud]").filter(shown)) assert.ok(a.href.startsWith(`${APP}/`), `${p.rel}: ${a.textContent} goes to the account pages`);

    const closed = parsePage(cloudState(p.html, { url: "", paths }));
    assert.ok(!/Curule Cloud|Get started/.test(visibleText(closed)), `${p.rel}: with no script, the closed site says nothing of what is not there`);
    assert.deepEqual(closed.querySelectorAll("[data-cloud]").filter(shown), [], `${p.rel}: and shows no link into it`);
  }
  assert.match(visibleText(parsePage(cloudState(page(pages, "index.html").html, { url: "", paths }))), /Not today\. It is software you run, one instance per team/);
  const hosting = parsePage(cloudState(page(pages, "index.html").html, { url: APP, paths })).querySelectorAll("details").filter((d) => shown(d) && d.querySelector("summary")!.textContent === "Can you host it for us?");
  assert.equal(hosting.length, 1);
  assert.match(hosting[0]!.textContent, /^Can you host it for us\?Yes: that is Curule Cloud\./, "a search engine and a link preview read the answer for the site that is open");
});
