import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as vm from "node:vm";
import { parsePage, type FakeDocument, type FakeNode } from "../cloud/pages-support";
import { ROOT, SITE, page, sitePages } from "./site-pages";

/**
 * The way from the site into Curule Cloud: "Sign in" and "Get started" in every page's header, the home page's calls to action,
 * the pricing page's strip, and the sentences that say Curule is software you run and is not offered as a hosted service, which
 * give way to the ones that say it is. All of it is off until the service is open (`CLOUD_URL` in the shared script), and the pages
 * ship with it off: until the day there is something to sign in to, no page may mention it, and no page may say it is not there once
 * there is.
 *
 * The script is run unchanged, in the small DOM the account pages' tests use, on each page's own markup, with the address set the way
 * `scripts/set-domain.mjs --cloud-url` sets it.
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

/** What a visitor reads on the page: the text of what is not hidden. */
function visibleText(doc: FakeDocument): string {
  const out: string[] = [];
  const walk = (n: FakeNode): void => {
    if (n.isText) out.push(n.textContent);
    else if (!n.hidden && n.tag !== "script" && n.tag !== "style") for (const c of n.children) walk(c);
  };
  walk(doc.body);
  return out.join(" ").replace(/\s+/g, " ");
}

const REL = pages.map((p) => p.rel);

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
    const signIn = doc.querySelectorAll('[data-cloud="login"]');
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
    assert.deepEqual(doc.querySelectorAll('[data-cloud="login"], [data-cloud="signup"]').map((a) => a.href).sort(), [`${APP}/login`, `${APP}/login`, `${APP}/signup`, `${APP}/signup`, `${APP}/signup`, `${APP}/signup`].sort(), cloud);
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
  assert.match(text, /open a workspace on Curule Cloud, where we run it and supply the models/);
  assert.match(text, /Yours to run, or ours/);
  const hero = home.querySelector(".hero")!;
  const buttons = hero.querySelectorAll(".btn").filter((b) => shown(b));
  assert.deepEqual(buttons.map((b) => b.textContent), ["Get started", "See pricing"]);
  assert.equal(buttons[0]!.href, `${APP}/signup`);
  assert.match(hero.querySelectorAll("p").filter((p) => shown(p)).map((p) => p.textContent).join(" "), /try the demo/i, "and the demo is still one click away, in words");
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
  }
  const closed = visibleText(visit("index.html", ""));
  assert.match(closed, /Not today\. It is software you run, one instance per team/, "and while it is closed the same question is answered as it was");
});

test("when it is open, the pricing page says the plans below are licences and sends a visitor to the app for Curule Cloud's, which are kept there and not copied", () => {
  const doc = visit("pricing/index.html", APP);
  const strip = doc.getElementById("cloud")!;
  assert.equal(shown(strip), true);
  assert.match(strip.textContent, /Rather not run it yourself\?/);
  assert.match(strip.textContent, /The plans and their prices are on the sign-up page, because they are kept in one place\./);
  assert.match(strip.textContent, /The plans below are licences for the software you run yourself\./);
  assert.deepEqual(strip.querySelectorAll("a").map((a) => [a.textContent, a.href]), [["See the Curule Cloud plans", `${APP}/`], ["Get started", `${APP}/signup`]]);
  assert.ok(!/\$\s?\d/.test(strip.textContent), "no price of Curule Cloud is written on this page: the account pages' plans are the one place they are");
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
    for (const n of cloud) assert.ok(n.hidden, `${p.rel}: a Curule Cloud element starts hidden`);
  }
});
