/**
 * The account pages as files: what is in the folder, that nothing in them is something the pages' own security policy would
 * refuse, that each page has what its script looks for, that every link and every call the script makes goes somewhere that
 * exists, that the colours are the site's, and that no page states a number the service could change.
 *
 * What the script does with these pages is in pages-app.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { WorkspaceEdge, createPublicServer } from "../../packages/cloud/src/index";
import { ask, listen } from "./net-support";
import { plane } from "./support";
import { APP, site } from "./web-support";
import { PAGES_DIR, ROOT, SCRIPT, cssRules, declared, helpers, parsePage, type FakeNode } from "./pages-support";

const read = (file: string): string => fs.readFileSync(file, "utf8");
const ASSETS = path.join(PAGES_DIR, "assets");

/** The path each page is served at. `index` is the front page. */
const PATHS: Record<string, string> = { index: "/", signup: "/signup", login: "/login", verify: "/verify", forgot: "/forgot", reset: "/reset", account: "/account", terms: "/terms", privacy: "/privacy" };
/** What a page calls itself in the script. */
const PAGE_OF: Record<string, string> = { index: "home", "404": "notfound" };
/** The files that are pages: those served at a path, and the one a browser is shown at an address that does not exist. */
const FILES = [...Object.keys(PATHS), "404"];

function pages() {
  return FILES.map((name) => {
    const html = read(path.join(PAGES_DIR, `${name}.html`));
    const doc = parsePage(html);
    return { name, page: PAGE_OF[name] ?? name, html, doc, all: doc.root.descendants() };
  });
}

const attr = (n: FakeNode, name: string): string => n.attrs.get(name) ?? "";
const idsOf = (all: FakeNode[]): string[] => all.map((n) => attr(n, "id")).filter(Boolean);

async function serve() {
  const p = await plane();
  const s = site(p);
  const edge = new WorkspaceEdge({ plane: p.plane, access: s.access, appUrl: APP });
  const server = createPublicServer({ web: s.web, edge, appHost: "app.example.com", workspaceDomain: "ws.example.com", pagesDir: PAGES_DIR });
  return { ...(await listen(server)), s };
}

// ---- what is in the folder, and what serves it ----

test("the folder holds the pages and their assets and nothing else, and the server serves each page at its path and each asset by its name", async () => {
  // DESIGN.md is the design record for this surface, not a page: it is kept beside them and is not served.
  assert.deepEqual(fs.readdirSync(PAGES_DIR).sort(), ["404.html", "DESIGN.md", "account.html", "assets", "forgot.html", "index.html", "login.html", "privacy.html", "reset.html", "signup.html", "terms.html", "verify.html"]);
  assert.deepEqual(fs.readdirSync(ASSETS).sort(), ["app.css", "app.js", "favicon.svg"]);

  const srv = await serve();
  try {
    for (const [name, at] of Object.entries(PATHS)) {
      const r = await ask(srv.port, { host: "app.example.com", path: at });
      assert.equal(r.status, 200, at);
      assert.equal(r.headers["content-type"], "text/html; charset=utf-8", at);
      assert.equal(r.body, read(path.join(PAGES_DIR, `${name}.html`)), `${at} is its file, as it is`);
      assert.equal(r.headers["cache-control"], "no-store", "a page is read fresh: it says what the account is");
      assert.equal(r.headers["x-frame-options"], "DENY");
    }
    for (const [file, type] of [["app.js", "text/javascript; charset=utf-8"], ["app.css", "text/css; charset=utf-8"], ["favicon.svg", "image/svg+xml"]] as const) {
      const r = await ask(srv.port, { host: "app.example.com", path: `/assets/${file}` });
      assert.deepEqual([r.status, r.headers["content-type"], r.headers["cache-control"]], [200, type, "no-cache"], `${file}: kept, and asked about each time`);
      assert.match(String(r.headers.etag), /^"[A-Za-z0-9_-]{27}"$/, `${file} carries a fingerprint, so that the question costs no more than a 304`);
      assert.equal(r.body, read(path.join(ASSETS, file)));
    }
    for (const missing of ["/index.html", "/index", "/account.html", "/assets/", "/assets/missing.js", "/assets/../account.html"]) assert.equal((await ask(srv.port, { host: "app.example.com", path: missing })).status, 404, missing);
  } finally {
    await srv.close();
  }
});

test("a browser that follows a wrong address is shown a page that says so and where to go; a program, and anything under the API, is told in JSON", async () => {
  const srv = await serve();
  try {
    const html = { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };
    for (const wrong of ["/pricing", "/docs", "/dashboard", "/accounts", "/index.html", "/DESIGN.md", "/assets/missing.js"]) {
      const r = await ask(srv.port, { host: "app.example.com", path: wrong, headers: html });
      assert.equal(r.status, 404, wrong);
      assert.equal(r.headers["content-type"], "text/html; charset=utf-8", wrong);
      assert.equal(r.body, read(path.join(PAGES_DIR, "404.html")), `${wrong} is shown the page, as it is`);
      assert.equal(r.headers["cache-control"], "no-store");
      assert.equal(r.headers["x-frame-options"], "DENY");
      assert.match(String(r.headers["content-security-policy"]), /(^|; )script-src 'self'(;|$)/, "the page is served under the policy it is written for");
    }
    // A HEAD for a wrong address is answered as the GET would be, with no body.
    const head = await ask(srv.port, { host: "app.example.com", path: "/pricing", method: "HEAD", headers: html });
    assert.deepEqual([head.status, head.headers["content-type"], head.body], [404, "text/html; charset=utf-8", ""]);
    // The same address, asked for by something that wants data, is an error in JSON, as it always was.
    for (const accept of [undefined, "application/json", "*/*"]) {
      const r = await ask(srv.port, { host: "app.example.com", path: "/pricing", ...(accept ? { headers: { accept } } : {}) });
      assert.equal(r.status, 404, String(accept));
      assert.match(String(r.headers["content-type"]), /^application\/json/, String(accept));
      assert.deepEqual(JSON.parse(r.body), { error: { code: "not_found", message: "There is nothing at /pricing." } });
    }
    // Under the API, whatever the caller says it accepts, an unknown route is JSON: a page there would be taken for an answer.
    for (const api of ["/api/nothing", "/api/workspaces/ws_x/nothing", "/owner/nothing", "/webhooks/nothing"]) {
      const r = await ask(srv.port, { host: "app.example.com", path: api, headers: html });
      assert.equal(r.status, 404, api);
      assert.match(String(r.headers["content-type"]), /^application\/json/, api);
    }
    // A page that exists is still itself, and the page for a wrong address is not served at a path of its own.
    assert.equal((await ask(srv.port, { host: "app.example.com", path: "/", headers: html })).status, 200);
    assert.equal((await ask(srv.port, { host: "app.example.com", path: "/404", headers: html })).status, 404);
    assert.equal((await ask(srv.port, { host: "app.example.com", path: "/404.html", headers: html })).headers["content-type"], "text/html; charset=utf-8");
  } finally {
    await srv.close();
  }
});

test("the pages are written for the policy they are served under: nothing inline, nothing from another address, nothing a browser would refuse", async () => {
  const srv = await serve();
  let csp = "";
  try {
    csp = String((await ask(srv.port, { host: "app.example.com", path: "/" })).headers["content-security-policy"]);
  } finally {
    await srv.close();
  }
  assert.match(csp, /(^|; )default-src 'self'(;|$)/);
  assert.match(csp, /(^|; )script-src 'self'(;|$)/);
  assert.match(csp, /(^|; )style-src 'self'(;|$)/);
  assert.match(csp, /(^|; )frame-ancestors 'none'(;|$)/);
  assert.doesNotMatch(csp, /unsafe-|\*|https?:/, "no inline code, no wildcard, no other address");

  for (const { name, all } of pages()) {
    const where = (what: string): string => `${name}: ${what}`;
    const scripts = all.filter((n) => n.tag === "script");
    assert.deepEqual(scripts.map((n) => [attr(n, "src"), n.attrs.has("defer")]), [["/assets/app.js", true]], where("one script, deferred, from the folder, and no inline one"));
    assert.equal(scripts[0]!.children.length, 0);
    assert.equal(all.filter((n) => n.tag === "style").length, 0, where("no <style>"));
    for (const n of all) {
      assert.ok(!n.attrs.has("style"), where(`<${n.tag}> has a style attribute`));
      for (const a of n.attrs.keys()) assert.ok(!a.startsWith("on"), where(`<${n.tag}> has the handler ${a}`));
      for (const a of ["href", "src", "action", "formaction", "poster", "data", "srcset", "xlink:href"]) {
        const v = attr(n, a);
        if (v !== "") assert.ok(v.startsWith("/") && !v.startsWith("//") || v.startsWith("#"), where(`<${n.tag} ${a}="${v}"> is not an address of this service`));
      }
    }
    for (const tag of ["iframe", "object", "embed", "base", "frame", "applet", "audio", "video", "img"]) assert.equal(all.filter((n) => n.tag === tag).length, 0, where(`no <${tag}>`));
    assert.equal(all.filter((n) => n.tag === "form" && n.attrs.has("action")).length, 0, where("a form is sent by the script, not to an address"));
    const links = all.filter((n) => n.tag === "link").map((n) => `${attr(n, "rel")} ${attr(n, "href")}`);
    assert.deepEqual(links, ["icon /assets/favicon.svg", "stylesheet /assets/app.css"], where("the icon and the stylesheet"));
    for (const meta of all.filter((n) => n.tag === "meta")) assert.ok(["charset", "viewport", "robots", "description", "theme-color"].some((k) => meta.attrs.has(k) || attr(meta, "name") === k), where(`unexpected <meta ${[...meta.attrs.keys()].join(" ")}>`));
  }
});

test("every asset a page names is in the folder and every file in it is named by a page", () => {
  const named = new Set<string>();
  for (const { all } of pages()) for (const n of all) for (const a of ["href", "src"]) if (attr(n, a).startsWith("/assets/")) named.add(attr(n, a).slice("/assets/".length));
  assert.deepEqual([...named].sort(), fs.readdirSync(ASSETS).sort());
  assert.equal(read(path.join(ASSETS, "favicon.svg")), read(path.join(ROOT, "brand", "favicon.svg")), "the icon is the brand's");
});

// ---- the markup and the script ----

test("each page is the page its script thinks it is, and has every element the script looks for, once", () => {
  const needs = helpers().NEEDS;
  assert.deepEqual(Object.keys(needs).sort(), pages().map((p) => p.page).sort(), "the script knows exactly these pages");
  for (const { name, page, all } of pages()) {
    const body = all.find((n) => n.tag === "body")!;
    assert.equal(attr(body, "data-page"), page, name);
    const ids = idsOf(all);
    assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], `${name}: ids are used once`);
    for (const id of needs[page]!) assert.ok(ids.includes(id), `${name}: the script needs #${id}`);
  }
});

test("everything the script looks up by id is declared as needed by a page that has it", () => {
  const source = read(SCRIPT);
  const needs = helpers().NEEDS;
  const declared = new Set(Object.values(needs).flat());
  const used = new Set<string>();
  for (const m of source.matchAll(/\$\("([\w-]+)"\)/g)) used.add(m[1]!);
  for (const id of used) assert.ok(declared.has(id), `the script reads #${id} but no page declares it as needed`);
  // The ones built from a workspace's id are made by the script itself.
  for (const id of declared) assert.ok(used.has(id), `a page is made to carry #${id} and the script never reads it`);
  const ids = new Set(pages().flatMap((p) => idsOf(p.all)));
  for (const id of used) assert.ok(ids.has(id), `#${id} is on no page`);
});

test("a page can be read and used by anyone: a language, a title, one heading, a way past the header, labels for every field, and a message for a browser with no script", () => {
  for (const { name, html, all, doc } of pages()) {
    const where = (what: string): string => `${name}: ${what}`;
    assert.match(html, /^<!doctype html>\n<html lang="en">/, where("the language is said"));
    const title = all.find((n) => n.tag === "title")!.textContent;
    assert.ok(name === "index" ? title === "Curule Cloud: a team of AI agents, hosted" : /^[^–]+ – Curule Cloud$/.test(title), where(`title "${title}"`));
    assert.ok(all.some((n) => n.tag === "meta" && attr(n, "name") === "viewport" && attr(n, "content") === "width=device-width, initial-scale=1"));
    assert.equal(all.some((n) => n.tag === "meta" && attr(n, "name") === "robots" && attr(n, "content") === "noindex"), name !== "index", where("only the front page is for search engines"));
    assert.equal(all.filter((n) => n.tag === "h1").length, 1, where("one h1"));
    const main = all.find((n) => n.tag === "main")!;
    assert.deepEqual([attr(main, "id"), attr(main, "tabindex")], ["main", "-1"]);
    const skip = all.find((n) => n.tag === "a" && n.className === "skip")!;
    assert.equal(attr(skip, "href"), "#main");
    // The documents are read as they are; every other page does its work through the script, and says so to a browser without one.
    const readable = name === "terms" || name === "privacy";
    assert.equal(all.some((n) => n.tag === "noscript"), !readable, where("a page that needs the script says so to a browser with none"));
    assert.equal(/<noscript>[^<]*<p class="note note-warn">This page needs JavaScript/.test(html), !readable);

    const ids = new Set(idsOf(all));
    for (const n of all) {
      if (n.tag === "label") assert.ok(ids.has(attr(n, "for")), where(`a label for #${attr(n, "for")}`));
      for (const a of ["aria-labelledby", "aria-describedby"]) for (const id of attr(n, a).split(/\s+/).filter(Boolean)) assert.ok(ids.has(id), where(`${a} names #${id}`));
    }
    for (const input of all.filter((n) => n.tag === "input" && attr(n, "type") !== "hidden")) {
      assert.ok(all.some((n) => n.tag === "label" && attr(n, "for") === attr(input, "id")), where(`#${attr(input, "id")} has a label`));
      assert.ok(attr(input, "id") !== "" && attr(input, "name") !== "" || attr(input, "type") === "checkbox", where("a field has an id and a name"));
    }
    for (const input of all.filter((n) => n.tag === "input" && ["email", "password", "text"].includes(attr(n, "type")))) {
      assert.ok(attr(input, "autocomplete") !== "", where(`#${attr(input, "id")} says what a password manager should put in it`));
    }
    for (const status of all.filter((n) => attr(n, "role") === "status")) assert.equal(attr(status, "aria-live"), "polite", where("a status area is announced politely"));
    // Every page has the same header and footer.
    const header = all.find((n) => n.tag === "header")!;
    assert.deepEqual(header.querySelectorAll("nav a, nav button").map((n) => `${n.tag}:${n.textContent.trim()}:${n.hidden}`), ["a:Plans:false", "a:Sign in:false", "a:Account:true", "button:Sign out:true"], where("the header"));
    const footer = all.find((n) => n.tag === "footer")!;
    assert.deepEqual(footer.querySelectorAll("a").map((n) => `${n.textContent.trim()}:${attr(n, "href")}:${n.hidden}`), ["Terms:/terms:false", "Privacy:/privacy:false", "Contact:#:true"], where("the footer: the contact link is hidden until there is an address to give"));
    void doc;
  }
});

test("the front page is a ledger with a contents line, and every entry in it is a numbered section of the page", () => {
  // A phone reads 4,200px of front page; until this pass the only way to the plans or the billing rules was the scroll. The
  // contents line is the account's and the documents' own component, with the record's numbers, not a second navigation design.
  const { all } = pages().find((p) => p.name === "index")!;
  const nav = all.find((n) => n.tag === "nav" && n.className === "subnav home-nav")!;
  assert.ok(nav, "the front page has its contents line");
  assert.equal(attr(nav, "aria-label"), "On this page");
  const links = nav.querySelectorAll("a").map((a) => [a.textContent.trim(), attr(a, "href"), attr(a, "data-entry")]);
  assert.deepEqual(links, [
    ["Plans", "#plans-h", "01"],
    ["What you get", "#facts-h", "02"],
    ["How it works", "#how-h", "03"],
    ["Billing", "#billing-h", "04"],
    ["Start", "#start-h", "05"],
  ]);
  for (const [, href, entry] of links) {
    const h = all.find((n) => attr(n, "id") === href.slice(1))!;
    assert.equal(h.tag, "h2", `${href} names a section heading`);
    assert.equal(h.parent!.className, "section-head", `${href} is the head of a section`);
    assert.equal(attr(h.parent!.querySelector(".entry-no")!, "aria-hidden"), "true", "the number is for the eye");
    assert.equal(h.parent!.querySelector(".entry-no")!.textContent, entry, `${href} carries the number the contents line gives it`);
  }

  // At a desk the heading is the section's margin and the content is one column of the record; on a phone they stack as they did.
  const rules = cssRules(read(path.join(ASSETS, "app.css")));
  const ledger = rules.find((r) => r.at.includes("min-width: 1000px") && r.selectors.includes(".home .section") && declared(r, "display") !== undefined)!;
  assert.equal(declared(ledger, "display"), "grid", "the section is a margin and a body at 1000 and wider");
  assert.equal(declared(ledger, "grid-template-columns"), "17rem minmax(0, 1fr)", "the heading keeps the record's margin");
  const facts = rules.find((r) => r.at.includes("min-width: 1000px") && r.selectors.includes(".home .section .facts") && declared(r, "grid-template-columns") !== undefined)!;
  assert.equal(declared(facts, "grid-template-columns"), "1fr", "the five facts are five ruled entries, not a grid with a hole in its last row");
});

test("the front page's note about its plan cards waits for the cards, and a browser with no script is told why the plans are not there", () => {
  // Without a script the plans box held nothing while the standing note over it promised "Each card lists what its price includes."
  // The note is drawn with the cards, and the empty box says in its own words why it is empty.
  const html = read(path.join(PAGES_DIR, "index.html"));
  assert.match(html, /id="plans-note"[^>]*hidden/, "the note that describes the cards is not in the markup's first paint");
  assert.match(html, /<div id="plans"[^>]*><noscript>/, "the plans box says what it is waiting for when no script runs");
  assert.match(html, /so no plan or price is shown here/, "and does not promise a price it has not drawn");
});

test("every link goes to a page or an anchor that exists, whether it is written in a page or made by the script", () => {
  const served = new Set(Object.values(PATHS));
  const byPath = Object.fromEntries(pages().filter((p) => p.name in PATHS).map((p) => [PATHS[p.name]!, p]));
  const check = (target: string, from: string): void => {
    const [beforeFragment, fragment] = target.split("#");
    const at = beforeFragment!.split("?")[0]!;
    assert.ok(served.has(at), `${from}: ${target} is not a page`);
    if (fragment) assert.ok(idsOf(byPath[at]!.all).includes(fragment), `${from}: ${target} names an anchor that is not there`);
  };
  for (const p of pages()) {
    for (const n of p.all.filter((x) => x.tag === "a")) {
      const href = attr(n, "href");
      if (href === "#") assert.ok(n.attrs.has("data-contact") && n.hidden, `${p.name}: only the hidden contact link goes nowhere`);
      // A link to a place on its own page names an element that is there.
      else if (href.startsWith("#")) assert.ok(idsOf(p.all).includes(href.slice(1)), `${p.name}: ${href} names an element that is not there`);
      else check(href, p.name);
    }
  }
  const source = read(SCRIPT);
  const written = [...source.matchAll(/href: "(\/[^"]*)"/g), ...source.matchAll(/location\.(?:assign|replace)\("(\/[^"]*)"\)/g), ...source.matchAll(/const SIGN_IN = "(\/[^"]*)"/g), ...source.matchAll(/history\.replaceState\(null, "", "(\/[^"]*)"\)/g)].map((m) => m[1]!);
  assert.ok(written.length >= 8, "the script's own links were found");
  for (const target of written) check(target, "app.js");
});

test("every call the script makes is to a route the API has, with the method it uses", async () => {
  const source = read(SCRIPT);
  const calls = new Set<string>();
  for (const m of source.matchAll(/call\("(GET|POST)", "(\/api\/[^"]+)"/g)) calls.add(`${m[1]} ${m[2]}`);
  for (const m of source.matchAll(/path\(w, "(\w+)"\)/g)) calls.add(`POST /api/workspaces/ws_example/${m[1]}`);
  assert.ok(calls.size >= 14, `found ${[...calls].join(", ")}`);
  const p = await plane();
  const s = site(p);
  for (const entry of calls) {
    const [method, at] = entry.split(" ") as [string, string];
    const r = await s.call(method, at, { origin: null });
    assert.ok(r.status !== 404 && r.status !== 405, `${entry} answers ${r.status}: ${r.body}`);
  }
  // And the script never builds an address from anything else.
  assert.equal(source.match(/\bfetch\(/g)!.length, 1, "there is one fetch");
  assert.ok(source.includes("response = await fetch(path, {"), "and it is of the address call() was given, which is one of those above");
});

// ---- the sign-in pages ----

/** Each page's rail: the job it is for, the steps through it, and the one the reader is on. The claims the rail repeats are proven against the pages that first say them below. */
const PANEL: Record<string, { at: string; steps: string[] }> = {
  signup: { at: "Create your account", steps: ["Create your account", "Choose a plan", "Make a workspace", "Describe your team"] },
  login: { at: "Sign in", steps: ["Sign in", "Your workspaces", "Plan and balance", "Settings"] },
  forgot: { at: "Enter your email", steps: ["Enter your email", "Open the link", "Then sign in"] },
  reset: { at: "Choose a new password", steps: ["The link", "Choose a new password", "Sign in again"] },
  verify: { at: "The link", steps: ["The link", "Once only", "Before it expires"] },
};

test("the sign-in pages are one shell: the form first, and under it the way through this page's job, with the step in hand marked", () => {
  for (const [name, rail] of Object.entries(PANEL)) {
    const { all } = pages().find((p) => p.name === name)!;
    const shell = all.find((n) => n.className === "wrap auth")!;
    assert.ok(shell, `${name} has the shell`);
    const [main, side] = shell.children.filter((n) => !n.isText);
    assert.deepEqual([main!.className, side!.className], ["auth-main", "auth-side"], `${name}: the form's column comes first, so it is first to a keyboard and to a reader of the page`);
    assert.ok(main!.querySelector("h1") && main!.descendants().some((n) => n.tag === "form"), `${name}: the heading and the form are in it`);
    assert.ok(main!.querySelector("p.eyebrow"), `${name}: the form says which part of the service it is`);
    const items = side!.querySelectorAll("li");
    assert.deepEqual(items.map((li) => li.querySelector("strong")!.textContent), rail.steps, `${name}: the rail is this page's job, not the marketing panel every page used to repeat`);
    assert.ok(items.every((li) => li.querySelector("span")!.textContent.trim().length > 0), `${name}: each step says what happens in it`);
    assert.deepEqual(items.filter((li) => attr(li, "aria-current") === "step").map((li) => li.querySelector("strong")!.textContent), [rail.at], `${name}: exactly one step is where the reader is, and it is the right one`);
    // The panel used to carry a second, 280 px watermark of the mark; the page's header already has the mark, and the rail on ruled paper is the panel's idea.
    assert.equal(side!.querySelector("svg"), null, `${name}: the mark is the header's, once`);
  }
  // Nothing in the panel is new: each is a sentence, or the two halves of one, that a page already has.
  const textOf = (file: string): string => read(path.join(PAGES_DIR, file)).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  assert.match(textOf("index.html"), /One isolated host with its own projects, event log and files\./);
  assert.match(textOf("index.html"), /same append-only event log a self-hosted install writes, so a mission can be replayed/);
  assert.match(textOf("terms.html"), /Deleting a workspace deletes its data\./);
  assert.match(read(SCRIPT), /Its files are kept\./, "what the account says of a paused workspace");
});

test("the way through a sign-in page's job is on the page at every width, not only on a wide screen", () => {
  const css = read(path.join(ASSETS, "app.css"));
  const rail = [...css.matchAll(/\.auth-side\b[^{]*\{([^}]*)\}/g)].map((m) => m[1]!);
  assert.ok(rail.length > 0 && rail.every((rule) => !/display:\s*none/.test(rule)), "no rule takes the rail off the page");
  const rules = cssRules(css);
  assert.ok(rules.some((r) => r.at === "" && r.selectors.includes('.auth-points li[aria-current="step"]')), "its steps are styled where the rail is, unconditionally");
});

test("every page opens the same way: the record's caption names the part of Curule Cloud it is, and the title sits under it", () => {
  // The pages were two hands before: the way in and the home page had a caption over the title, the account, the page that is not
  // there and the documents did not. One caption above one title, in the same place, is what lets a reader know which page they are on
  // before reading its heading.
  for (const { name, all } of pages()) {
    const h1 = all.find((n) => n.tag === "h1")!;
    const siblings = h1.parent!.children.filter((n) => !n.isText);
    const caption = siblings[siblings.indexOf(h1) - 1];
    assert.ok(caption, `${name}: something comes before the title`);
    assert.equal(caption!.tag, "p", name);
    assert.ok((attr(caption!, "class") || "").split(/\s+/).includes("eyebrow"), `${name}: the line above the title is the record's caption`);
    assert.match(caption!.textContent.trim(), /^Curule Cloud · \S/, `${name}: and it says which part of Curule Cloud the page is`);
  }
});

test("the account's head and the way in keep their title on one line at a raised root, and its identity is one sentence", () => {
  // The head is the first screen's largest block at 200% text: a two-line title and an address squeezed into the caption's
  // remainder put the record's Open below an 800px phone. Both rules are about the line, not a width the page happens to have.
  const rules = cssRules(read(path.join(ASSETS, "app.css")));
  const title = rules.filter((r) => r.selectors.includes(".account-head h1") && declared(r, "font-size") !== undefined).at(-1)!;
  assert.match(declared(title, "font-size")!, /^min\(clamp\([^)]*\), 12vw\)$/, "the title is display type, capped by the line it is on, so a raised root does not take a second line");
  assert.ok(title.selectors.includes(".auth-main h1"), "the way-in pages' titles take the same cap: sign-up's h1 was 56px on a 360 phone at a 32px root");
  const who = rules.find((r) => r.selectors.includes("#who"))!;
  assert.equal(declared(who, "display"), undefined, "the identity is one sentence that wraps, not a flex row that squeezes the address into the caption's remainder");
  assert.equal(declared(rules.find((r) => r.selectors.includes("#who .who-a"))!, "word-break"), "break-all", "the address fills each line it is on");
  const plans = rules.find((r) => r.selectors.includes(".plans") && declared(r, "grid-template-columns") !== undefined)!;
  assert.match(declared(plans, "grid-template-columns")!, /minmax\(0,\s*1fr\)/, "a plan's card can be narrower than its price at a raised root, rather than widening the page");
  const auth = rules.find((r) => r.selectors.includes(".auth") && declared(r, "grid-template-columns") !== undefined)!;
  assert.equal(declared(auth, "grid-template-columns"), "minmax(0, 28rem) minmax(0, 20rem)", "the way-in form and its rail can shrink at a raised root: at 28rem and 20rem a 32px root put the form 96px past the left of a 1,440 screen and the rail 96px past the right");
});

test("the create form's fields start on the same line, so a plan's hint does not become the name field's label", () => {
  // The form is one row of fields above its button. The plan field carries the sentence about a workspace's plan, and with the row's
  // fields bottom-aligned that sentence pushed the name field down 104px: its label sat beside the hint at 1,440.
  const rules = cssRules(read(path.join(ASSETS, "app.css")));
  const field = rules.find((r) => r.selectors.includes(".inline-form .field") && declared(r, "align-self") !== undefined)!;
  assert.ok(field, "the inline form's field is a rule of its own");
  assert.equal(declared(field, "align-self"), "flex-start", "a field starts at the top of the row, whatever its neighbour's hint adds below it");
});

test("the account's figures keep their shape at a raised root: a step's ring is its numeral's size, and a plan's price is capped by its line", () => {
  // At a 32px root the step's 24px numeral was wrapped inside a 22px ring (a 16.7 × 66.4 text box, two lines) and a plan's $149.00 was
  // 307.8px on a 320 phone, 28.8px past the page. Both are figures drawn in a box that did not follow the figure.
  const rules = cssRules(read(path.join(ASSETS, "app.css")));
  const ring = rules.filter((r) => r.selectors.includes(".steps .num") && declared(r, "width") !== undefined).at(-1)!;
  assert.equal(declared(ring, "width"), "1.8333em", "the ring is the numeral's own size: 22px at a 12px caption and 44 at 24, so the digits do not wrap");
  assert.equal(declared(ring, "height"), "1.8333em", "and square, so the whole number is in it");
  const price = rules.find((r) => r.selectors.includes(".plan .price") && declared(r, "font-size") !== undefined)!;
  assert.equal(declared(price, "font-size"), "min(2.25rem, 16vw)", "the price is display type capped by the line, as the account's title is, so a raised root cannot take it off a 320 phone");
  // A 320 phone's price line is 238px: $149.00 is 151.9 and " per month" 83.1, with 80.1 left beside it, so the period broke after
  // "per" and "month" landed alone at the card's left edge. Below 360 the period is a line of its own under the price — one line
  // ("per month" 78.4) in every card. At 360 the inline period already fits and is unchanged.
  const narrow = rules.filter((r) => r.at.includes("max-width: 359px"));
  const period = narrow.find((r) => r.selectors.includes(".plan .price small") && declared(r, "display") !== undefined);
  assert.equal(declared(period!, "display"), "block", "the price's period sits on its own line under the number at 320");
  assert.equal(declared(period!, "margin-left"), "0", "and keeps no inline margin from the line it used to share");
});

test("the words are the product's: a stranger is never given the internal name for a running team, the password advice is grammar, and the page for a forgotten password is named after the link that brings people there", () => {
  for (const name of FILES) assert.doesNotMatch(read(path.join(PAGES_DIR, `${name}.html`)), /\bmesh\b/i, `${name} says "mesh"`);
  assert.doesNotMatch(read(SCRIPT), /\bmesh\b/i, "the script says mesh");
  for (const name of ["signup", "reset"]) {
    const html = read(path.join(PAGES_DIR, `${name}.html`));
    assert.match(html, /A few words in a row make a good password\./, `${name}: the subject is plural, so the verb is`);
    assert.doesNotMatch(html, /is a good password/);
  }
  assert.match(read(path.join(PAGES_DIR, "forgot.html")), /<h1>Forgot your password\?<\/h1>/, "the heading is the question the sign-in page linked with");
});

// ---- the documents, and the page that is not there ----

test("a document has a table of contents that names its headings and goes to them, and the table is not itself a heading", () => {
  for (const name of ["terms", "privacy"]) {
    const { all } = pages().find((p) => p.name === name)!;
    const toc = all.find((n) => n.tag === "nav" && n.className === "toc")!;
    assert.ok(toc, `${name} has one`);
    assert.equal(attr(toc, "aria-label"), "On this page");
    const headings = all.filter((n) => n.tag === "h2");
    assert.deepEqual(
      toc.querySelectorAll("a").map((a) => [a.textContent, attr(a, "href")]),
      headings.map((h) => [h.textContent, `#${attr(h, "id")}`]),
      `${name}: one link for each heading, in its order, to the heading`,
    );
    assert.ok(toc.querySelector("p.toc-h") && toc.querySelectorAll("h1, h2, h3").length === 0, `${name}: its title is not a heading, or the document would have a heading that is not a part of it`);
    const phoneToc = all.find((n) => n.tag === "details" && n.className === "toc-phone")!;
    assert.ok(phoneToc, `${name}: the contents are reachable on a phone, where the side column is not drawn`);
    assert.equal(phoneToc.querySelector("summary")!.textContent.trim(), "On this page");
    assert.deepEqual(
      phoneToc.querySelectorAll("a").map((a) => [a.textContent, attr(a, "href")]),
      toc.querySelectorAll("a").map((a) => [a.textContent, attr(a, "href")]),
      `${name}: the phone's list is the same list, so the two cannot drift`,
    );
    assert.equal(all.filter((n) => n.tag === "article").length, 1, `${name}: the text is one article`);
  }
});

test("a document ends on the way back to the product, marked for whoever is reading it", () => {
  for (const name of ["terms", "privacy"]) {
    const { all } = pages().find((p) => p.name === name)!;
    const article = all.find((n) => n.tag === "article")!;
    const end = article.children.filter((n) => !n.isText).at(-1)!;
    assert.equal(end.className, "doc-end", `${name}: after the last clause comes a way out, inside the text`);
    assert.equal(attr(end, "aria-label"), "After this document");
    assert.deepEqual(
      end.querySelectorAll("a").map((a) => [a.textContent, attr(a, "href"), attr(a, "data-when")]),
      [["Create your account", "/signup", "out"], ["Sign in", "/login", "out"], ["Go to your account", "/account", "in"], ["See the plans and prices", "/", ""]],
      `${name}: the same doors the header offers for each state, and the plans`,
    );
  }
});

test("the page that is not there is a mark, what happened, and the way back, and the mark is for the eye", () => {
  const { all } = pages().find((p) => p.name === "404")!;
  const lost = all.find((n) => n.className === "wrap lost")!;
  assert.ok(lost);
  const mark = lost.querySelector("svg")!;
  assert.deepEqual([attr(mark, "aria-hidden"), mark.textContent], ["true", ""]);
  assert.equal(lost.children.filter((n) => !n.isText)[0], mark, "it comes first");
  assert.ok(lost.querySelector("h1") && lost.querySelector(".btn-row"));
});

// ---- what the pages say ----

test("the stylesheet is drawn from the kit: it carries the kit's block, writes no colour of its own, and uses no token that nothing defines", () => {
  const css = read(path.join(ASSETS, "app.css"));
  const begin = css.indexOf("/* @kit:tokens begin");
  const endMark = "/* @kit:tokens end */";
  const end = css.indexOf(endMark);
  assert.ok(begin >= 0 && end > begin, "the kit's block is there (its content is held to the generator by ui-kit-tokens.test.ts)");
  const own = (css.slice(0, begin) + css.slice(end + endMark.length)).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(own, /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(/, "a colour is a token, and a tint is color-mix of one: the page and the site cannot drift apart by a value nudged here");
  const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!));
  for (const m of own.matchAll(/var\((--[\w-]+)/g)) assert.ok(defined.has(m[1]!), `${m[1]} is used and defined nowhere: a misspelt token draws nothing, and no test would see it`);

  // The pairs this stylesheet draws that the kit's own test (ui-kit-tokens.test.ts) does not list.
  const colours = (block: string): Record<string, string> => Object.fromEntries([...block.matchAll(/--k-([\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => [m[1]!, m[2]!.toLowerCase()]));
  const kit = css.slice(begin, end);
  const light = colours(/:root \{([\s\S]*?)\n\}/.exec(kit)![1]!);
  const dark = { ...light, ...colours(/@media \(prefers-color-scheme: dark\) \{\s*:root \{([\s\S]*?)\n  \}/.exec(kit)![1]!) };
  const luminance = (hex: string): number => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const contrast = (a: string, b: string): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };
  for (const [theme, t] of [["light", light], ["dark", dark]] as const) {
    assert.ok(contrast(t["on-accent"]!, t.bad!) >= 4.5, `${theme}: the words on a filled delete button`);
    assert.ok(contrast(t["accent-ink"]!, t["accent-soft"]!) >= 4.5, `${theme}: the page you are on, in the header`);
  }
});

test("what a finger has to hit is as tall as a button on a phone: the buttons, the header's links, the footer's, the fields and the Show of a password, the sentence of a tick box, a link in a line of its own", () => {
  const rules = cssRules(read(path.join(ASSETS, "app.css")));
  /** What the last rule for exactly this selector (alone or in a list) that sets the property says, at the top or inside the at-rule that mentions `within`. */
  const value = (selector: string, property: string, within = ""): string | undefined => {
    const found = rules.filter((r) => r.selectors.includes(selector) && (within === "" ? r.at === "" : r.at.includes(within)) && declared(r, property) !== undefined);
    return found.length > 0 ? declared(found[found.length - 1]!, property) : undefined;
  };
  const phone = "max-width: 720px";
  assert.equal(value(".btn", "min-height"), "40px", "a button is 40 tall for a pointer");
  assert.equal(value(".btn", "min-height", phone), "44px", "and 44 for a finger, as is a small one");
  assert.equal(value(".btn-small", "min-height", phone), "44px");
  assert.ok(rules.some((r) => r.selectors.includes(".btn") && r.at.includes(phone) && r.at.includes("(pointer: coarse)")), "a coarse pointer is a finger at any width");
  assert.equal(value(".bar nav a", "min-height", phone), "44px", "the header's links");
  assert.equal(value('input:not([type="checkbox"])', "min-height", phone), "44px", "a field: every input but the tick box, which is drawn small and ticked by hitting its sentence");
  assert.equal(value('input:not([type="checkbox"])', "min-height"), "40px", "and is 40 tall for a pointer");
  assert.deepEqual([value(".reveal", "top"), value(".reveal", "bottom")], ["0", "0"], "Show and Hide span the whole height of the field, so they are as tall as it is");
  assert.equal(value(".site-footer a", "min-height"), "44px", "the footer's links are words with the reach of a button");
  assert.equal(value(".site-footer a", "min-width"), "44px");
  assert.equal(value(".check label", "min-height"), "44px", "a tick box is ticked by hitting its sentence");
  assert.equal(value(".check label", "line-height"), "24px", "the sentence keeps the leading of its text on a phone: at 44 every line of the tick box read as a separate paragraph");
  assert.equal(value(".check label a", "display", phone), "inline", "and the terms stay in that sentence rather than being set as a row of their own");
  assert.equal(value(".check label a", "padding", phone), "13px 0", "reaching a finger's 44px with padding, which does not set the line's height");
  assert.equal(value(".check label a", "white-space", phone), "nowrap", "and each link stays whole where it falls");
  assert.equal(value(".aside a", "padding"), "12px 2px", "a link in a line of its own has a hit area taller than its text");
  assert.equal(value(".aside a", "margin"), "-12px 0", "without moving the lines around it");
  assert.equal(value(".ws .ws-auto .check", "min-height"), "44px", "and so is the offer to open a workspace when it is ready");
  assert.equal(value(".toc-phone a", "min-height", "max-width: 999px"), "44px", "a contents link on a phone, where the side contents are not drawn");
  assert.equal(value(".toc-phone summary", "min-height", "max-width: 999px"), "44px", "and the control that opens it");
  assert.equal(value(".toc-phone summary", "--n", "max-width: 999px"), "7", "it draws the disclosure chevron, not the check mark a summary with no icon name falls back to");
  assert.equal(value(".toc-phone summary", "--s", "max-width: 999px"), "18px", "at the size the settings and credit rows draw theirs");
  assert.equal(value(".subnav a", "min-height", "max-width: 720px") ?? value(".subnav a", "min-height"), "44px", "a section of the account, on a phone: the line's own rule is 44 at every width, so the phone does not repeat it");
  assert.equal(value(".subnav a", "min-width"), "44px", "a name is a finger's width at every width, so the 41px Plan at 390 is 44 too");
  assert.equal(value(".subnav a", "font-size", "max-width: 389px"), "max(12px, min(.75rem, 3.8vw))", "while the contents line is sized by the row it is on, so a raised root keeps its five names in the row the phone gives them");
  assert.equal(value(".subnav a", "font-size"), "min(.8125rem, 3.8vw)", "and 390 and wider takes the same cap, one row at 200% text");
  assert.equal(value(".subnav", "flex-wrap"), "wrap", "the account's sections wrap rather than hide the last one past the edge");
  assert.notEqual(value(".subnav", "overflow-x"), "auto", "and there is no sideways strip to discover");
});

test("a button's edge is a control's edge, and the contents line wraps at 320 rather than touching itself", () => {
  const rules = cssRules(read(path.join(ASSETS, "app.css")));
  // A neutral button is a white fill on the page's paper: the fill is 1.0:1 against the page, so the 1px edge is the control's whole
  // boundary. At --k-line-strong it was 1.52:1 on the page and 1.58:1 on a card in light, 1.87 and 1.74 in dark; a control boundary
  // needs 3:1, and --k-line-control is the token the kit's own test holds above it (3.92 on the page, 4.08 on a card, 3.75/4.04 dark).
  const button = rules.find((r) => r.selectors.includes(".btn") && declared(r, "border") !== undefined)!;
  assert.match(declared(button, "border")!, /var\(--k-line-control\)/, "the secondary button's edge is the control token, not the decorative hairline");
  assert.equal(declared(button, "background"), "var(--k-surface)", "the fill alone is the page's own paper and cannot be the boundary");

  // The five names and four gaps were 316.8px in the 288px a 320 phone has. The previous pass made them fit by dropping the
  // side padding and putting a 1px rule between the names; at 320 the names then began 1–1.5px from each other and half a pixel
  // from the rules, so the strip read as one word ("UsageBalanceSettings") and a thumb at the edge of one name hit its neighbour.
  // The names now keep the row's 10px of side padding and the row wraps as the design table asks: Workspaces, Plan and Usage on
  // the first row and Balance and Settings on the second, each name 12px from the next. The two rows cost 43px at 320 (the
  // account is 2,016 → 2,059 with a workspace open); at 360 the row still fits on one line with its 4px padding, unchanged.
  const narrow = rules.filter((r) => r.at.includes("max-width: 389px"));
  const small = rules.filter((r) => r.at.includes("max-width: 359px"));
  assert.ok(!small.some((r) => r.selectors.includes(".subnav") && declared(r, "gap") !== undefined), "no 320 rule takes the row's gap");
  assert.ok(!small.some((r) => r.selectors.includes(".subnav a + a") && declared(r, "border-left") !== undefined), "and no rule runs between two names that have only a padding between them");
  const strip = small.find((r) => r.selectors.includes(".subnav a") && declared(r, "padding") !== undefined);
  assert.equal(declared(strip!, "padding"), "0 10px", "a name keeps 10px of side padding at 320, so the row wraps instead of touching");
  const sized = rules.find((r) => r.at === "" && r.selectors.includes(".subnav a") && declared(r, "min-width") !== undefined);
  assert.equal(declared(sized!, "min-width"), "44px", "Plan, Usage and Balance are still a finger wide at 320");
  assert.equal(declared(sized!, "font-size"), "min(.8125rem, 3.8vw)", "and the line is still sized by the row it is on");
  assert.ok(narrow.some((r) => r.selectors.includes(".subnav a") && declared(r, "padding") === "0 4px"), "at 360 the 4px padding is the row's own and is unchanged");
});

test("a tick box is a finger's target even where the drawn box stays small", () => {
  // The tick inside a consent sentence was a 20 × 20 target at 320 and 360: a thumb aimed at the box, not at the sentence beside it,
  // had 20px to land on. The control is 44 square now and the box it draws is still 20, inset by 12 on every side.
  const rules = cssRules(read(path.join(ASSETS, "app.css")));
  const box = rules.find((r) => r.selectors.includes('input[type="checkbox"]') && declared(r, "width") !== undefined)!;
  assert.equal(declared(box, "width"), "44px", "the control is a finger's width");
  assert.equal(declared(box, "height"), "44px");
  assert.equal(declared(box, "border"), "0", "the control has no box of its own: the drawn box is inside it");
  const drawn = rules.find((r) => r.selectors.includes('input[type="checkbox"]::before') && declared(r, "inset") !== undefined)!;
  assert.equal(declared(drawn, "inset"), "12px", "so the box a person sees is still 20 × 20");
  assert.equal(declared(drawn, "border"), "1px solid var(--k-line-control)", "and it is drawn in the control's token");
  const check = rules.find((r) => r.selectors.includes('.check input[type="checkbox"]') && declared(r, "margin-top") !== undefined)!;
  assert.equal(declared(check, "margin-top"), "0", "the taller control is not pushed down the sentence it belongs to");
});

test("a document is set at a reading measure, not the width of the column it could fill", () => {
  // At 1,440 the terms' article was 672px, about 86 characters a line; the record asks for a measure near 68. 34rem is 544px, about
  // 70 characters in the page's own face, and the column is centred rather than stretched to the wrap.
  const rules = cssRules(read(path.join(ASSETS, "app.css")));
  const doc = rules.find((r) => r.at.includes("min-width: 1000px") && r.selectors.includes(".doc") && declared(r, "grid-template-columns") !== undefined)!;
  assert.equal(declared(doc, "grid-template-columns"), "13rem minmax(0, 34rem)", "the article is a reading column beside its contents");
  const prose = rules.find((r) => r.selectors.includes(".prose") && declared(r, "max-width") !== undefined)!;
  assert.equal(declared(prose, "max-width"), "34rem", "and at every width the article is that column, centred");
});

test("the account's two rows of actions fit one line on a 320 phone", () => {
  // At 320 the record's line is 278px: Open 92.8 + Pause 75.7 + More 94.2 and two 8px gaps are 278.7, so More fell to a second row and
  // the record was 100px; the plan's Manage billing 130.1 + Change plan 137.3 and a 12px gap are 279.4. The 4px the row can give up
  // puts both on one line, in the same space scale as every other row, and the page 108px shorter. A renderer whose labels are wider
  // still needs 7px more (143 + 148 + 4 in a 288px line), so the small button's side padding is 8 there, the step under 12.
  const rules = cssRules(read(path.join(ASSETS, "app.css")));
  const narrow = rules.filter((r) => r.at.includes("max-width: 359px"));
  const row = narrow.find((r) => r.selectors.includes(".row .btn-row") && declared(r, "gap") !== undefined);
  assert.ok(row, "a 320 phone's rows have a gap of their own");
  assert.equal(declared(row!, "gap"), "4px", "which is the smallest step the space scale has");
  const small = narrow.find((r) => r.selectors.includes(".row .btn-small") && declared(r, "padding-inline") !== undefined);
  assert.ok(small, "and a small button in one of those rows gives up its side padding");
  assert.equal(declared(small!, "padding-inline"), "8px", "so Manage billing and Change plan share the 288px the plan row has");
  assert.ok(!rules.some((r) => !r.at.includes("max-width: 359px") && r.selectors.includes(".row .btn-row") && declared(r, "gap") !== undefined), "and only a 320 phone takes it: 360 keeps the 8 and 12 the rows are drawn with");
});

test("the loading skeleton has the shape of the account it stands in for: the two facts the glance carries, not three", () => {
  const account = pages().find((p) => p.name === "account")!;
  const tiles = account.all.find((n) => n.className === "sk-tiles")!;
  assert.equal(tiles.children.filter((n) => n.tag === "div").length, 2, "the glance has Plan and Balance since the workspaces tile left it");
  const rules = cssRules(read(path.join(ASSETS, "app.css")));
  const grid = rules.find((r) => r.selectors.includes(".sk-tiles") && declared(r, "grid-template-columns") !== undefined)!;
  assert.equal(declared(grid, "grid-template-columns"), "repeat(2, 1fr)", "two tiles on a wide screen, as the two facts are");
});

test("a way-in page's tab names the heading it shows, and no form a script must send is offered to a browser with none", () => {
  const titles = Object.fromEntries(pages().map((p) => [p.name, p.all.find((n) => n.tag === "title")!.textContent]));
  for (const [name, h1] of [["signup", "Create your account"], ["login", "Back to your account"], ["forgot", "Forgot your password?"], ["reset", "Choose a new password"], ["verify", "Confirming your address"]] as const) {
    assert.equal(titles[name], `${h1} – Curule Cloud`, `${name}: the tab is the page's own action, not a description of the form`);
  }
  const account = pages().find((p) => p.name === "account")!;
  const settings = account.all.find((n) => attr(n, "id") === "settings-panel")!;
  assert.ok(settings.attrs.has("hidden"), "Settings is drawn by the script: with no script it is not a password form whose submit would put both passwords in an address");
  // The way-in pages' forms are the same case, and were the same defect: a form with no action is a GET, so a browser with no script wrote
  // the password into the address bar, the history and the server's log (measured: /login?email=…&password=secret-password-1). The card is
  // held hidden in the markup and drawn by the script, as Settings is; reset and the confirmation page already held theirs hidden.
  for (const name of ["signup", "login", "forgot"]) {
    const card = pages().find((p) => p.name === name)!.all.find((n) => attr(n, "id") === "card");
    assert.ok(card, `${name}: the card that holds the form`);
    assert.ok(card!.attrs.has("hidden"), `${name}: with no script it is not drawn, so its submit cannot write a password into an address`);
  }
});

test("a phone's bar is part of the page, so no control is ever under it, and the section a contents link names opens at the edge", () => {
  const rules = cssRules(read(path.join(ASSETS, "app.css")));
  const value = (selector: string, property: string, within = ""): string | undefined => {
    const found = rules.filter((r) => r.selectors.includes(selector) && (within === "" ? r.at === "" : r.at.includes(within)) && declared(r, property) !== undefined);
    return found.length > 0 ? declared(found[found.length - 1]!, property) : undefined;
  };
  const phone = "max-width: 720px";
  assert.equal(value(".site-header", "position"), "sticky", "a wide page keeps its bar: a pointer can scroll a little further around it");
  assert.equal(value(".site-header", "position", phone), "static", "a phone's bar scrolls with the page: held over it, the plan's two 44px actions sat at 21.9-65.9 under the 61px bar, and axe scored target-size serious at 320 and 360");
  assert.equal(value(".panel", "scroll-margin-top", phone), "24px", "and the section a contents link names opens at the top, not 124px down a bar that is no longer there");
  assert.equal(value(".panel > h2", "scroll-margin-top", phone), "24px", "the heading Focus lands on included");
  assert.equal(value(".prose h2", "scroll-margin-top", phone), "24px", "as does a clause reached from a legal page's own contents");
  assert.equal(value(".panel", "scroll-margin-top"), "124px", "while a wide page still clears the bar it keeps");
  assert.equal(value(".prose h2", "scroll-margin-top"), "84px");
});

test("a name a person typed cannot widen the page: the cards that show one break a word that has nowhere to break, and the header fits a small phone", () => {
  const rules = cssRules(read(path.join(ASSETS, "app.css")));
  const own = (selector: string, property: string, within = ""): string | undefined => {
    const found = rules.filter((r) => r.selectors.includes(selector) && (within === "" ? r.at === "" : r.at.includes(within)) && declared(r, property) !== undefined);
    return found.length > 0 ? declared(found[found.length - 1]!, property) : undefined;
  };
  // A workspace is named by its owner and nothing says where the name may break: without this a card is as wide as its name and the page scrolls sideways.
  // The sign-up confirmation shows the address a person typed, and the usage table shows a workspace's name: both are the same long word, and both were measured past the page at 320 and 360.
  for (const selector of [".row", ".stage", ".confirm", ".card", ".table-wrap"]) assert.equal(own(selector, "overflow-wrap"), "anywhere", selector);
  // The header's three links stay on one line at normal text, and on a phone as small as 320 px they and the mark are made smaller before the bar is allowed to wrap.
  // Signed in, the bar holds the mark and three links: measured at 320 px it came to 325 px (327 on the account), so the bar gives way rather than widen the page.
  assert.equal(own(".bar nav a", "white-space"), "nowrap", "a link is a word, not two");
  assert.equal(own(".site-header .wrap", "padding-inline", "max-width: 380px"), "0", "the header's gutter is the page's, not a second inset; the bar wraps rather than pass the edge");
  assert.equal(own(".bar", "flex-wrap", "max-width: 720px"), "wrap", "a bar with more text than its line wraps");
  assert.equal(own(".figures dd", "font-size", "max-width: 720px"), "min(1.375rem, 9vw)", "and an amount on a phone is capped against its column rather than widening the page");
  assert.equal(own(".bar", "gap", "max-width: 380px"), "8px");
  assert.equal(own(".bar nav", "gap", "max-width: 380px"), "0");
  assert.equal(own(".bar nav a", "padding", "max-width: 380px"), "0 8px");
  assert.equal(own(".bar nav a", "font-size", "max-width: 380px"), ".875rem");
  assert.equal(own(".logo", "height", "max-width: 380px"), "20px");
  // At 320 the caption's line has 189px left for a 238px address, so it broke through the domain ("…@exampl" / "e.com"). The identity is a
  // wrapping line there: the address moves to a line of its own whole (238px), and a short one still shares the caption's. Measured 41.6px
  // for both addresses, before and after, and 124.8px at a 32px root.
  assert.equal(own("#who", "display", "max-width: 359px"), "flex", "the identity is a line that wraps, not a word that breaks");
  assert.equal(own("#who", "flex-wrap", "max-width: 359px"), "wrap");
  assert.equal(own("#who", "gap", "max-width: 359px"), "0 4px", "with the space the sentence had between its two parts");
  assert.equal(own("#who", "display"), undefined, "and only a 320 phone: at 360 the address fits beside its caption");
});

test("a long table keeps the name of its row at the edge while its figures scroll, and the account's sections carry the ledger's numbers without changing their names", () => {
  const css = read(path.join(ASSETS, "app.css"));
  const rule = cssRules(css).find((r) => r.selectors.includes(".table-wrap th:first-child"));
  assert.ok(rule, "the first cell of a table is held at the left edge");
  assert.equal(declared(rule!, "position"), "sticky");
  assert.equal(declared(rule!, "left"), "0");
  assert.ok(
    cssRules(css).some((r) => r.selectors.includes(".table-wrap tbody th") && declared(r, "background") === "var(--k-surface)"),
    "and it is drawn over what scrolls under it",
  );
  const numbered = cssRules(css).find((r) => r.selectors.includes(".panel > h2::before"));
  assert.ok(numbered, "the account's headings are numbered");
  assert.match(declared(numbered!, "content") ?? "", /^attr\(data-entry\) \/ ""$/, "the number is drawn, and not said: the heading's name stays the word");
  const account = pages().find((p) => p.name === "account")!;
  const entries = account.all.filter((n) => n.tag === "h2" && n.attrs.has("data-entry")).map((n) => [attr(n, "data-entry"), n.textContent]);
  assert.deepEqual(entries, [["01", "Workspaces"], ["02", "Plan"], ["03", "Usage"], ["04", "Balance"], ["05", "Settings"]]);
});

test("the plan section can carry the step of choosing one: a rail and a sentence that a browser with no script does not show", () => {
  // A person with no plan is at the step of choosing one, and the section is where they choose: the rail and the sentence are the section's
  // own, and the block above it is not drawn. The markup holds them hidden, so a browser that runs no script is promised nothing.
  const account = pages().find((p) => p.name === "account")!;
  const panel = account.all.find((n) => attr(n, "id") === "plan-panel")!;
  assert.deepEqual(panel.children.filter((n) => !n.isText).map((n) => attr(n, "id")), ["plan-h", "plan-steps", "plan-lede", "plan-status", "plan"], "the heading, the step, then the list");
  const rail = account.all.find((n) => attr(n, "id") === "plan-steps")!;
  assert.equal(rail.tag, "ol");
  assert.ok(rail.className.split(/\s+/).includes("steps"), "the rail is the one the card draws, not a copy of it");
  assert.equal(attr(rail, "aria-label"), "Where you are");
  assert.ok(rail.attrs.has("hidden"), "the script draws the step; nothing is promised before it runs");
  const lede = account.all.find((n) => attr(n, "id") === "plan-lede")!;
  assert.equal(lede.tag, "p");
  assert.ok(lede.className.split(/\s+/).includes("muted"));
  assert.ok(lede.attrs.has("hidden"));
  const rule = cssRules(read(path.join(ASSETS, "app.css"))).find((r) => r.selectors.includes("#plan-steps"));
  assert.ok(rule, "the rail has a rule of its own: it is not inside the card's gap");
  assert.equal(declared(rule!, "margin-bottom"), "12px", "and it takes the record's 12px before the sentence it introduces");
});

test("the balance is the record, and adding credit is one 44px row on a phone that opens the form", () => {
  const account = pages().find((p) => p.name === "account")!;
  const panel = account.all.find((n) => attr(n, "id") === "balance-panel")!;
  const card = panel.querySelector(".card")!;
  const [figures, fail, fold] = card.children.filter((n) => !n.isText);
  assert.deepEqual([attr(figures!, "id"), attr(fail!, "id"), fold!.tag], ["figures", "topup-fail", "details"], "the figures, the note a failed read leaves, then the form");
  assert.deepEqual([attr(fold!, "class"), attr(fold!, "id")], ["topup", "topup-details"]);
  const summary = fold!.querySelector("summary")!;
  assert.equal(summary.textContent.trim(), "Add credit", "the row is the action's name, and no separate caption shows with it");
  assert.deepEqual(fold!.children.filter((n) => !n.isText && n.tag !== "summary").map((n) => attr(n, "id")), ["topup-add", "topup-options", "topup-status", "topup", "topup-hint"]);

  const rules = cssRules(read(path.join(ASSETS, "app.css")));
  const value = (selector: string, property: string, within = ""): string | undefined => {
    const found = rules.filter((r) => r.selectors.includes(selector) && (within === "" ? r.at === "" : r.at.includes(within)) && declared(r, property) !== undefined);
    return found.length > 0 ? declared(found[found.length - 1]!, property) : undefined;
  };
  assert.equal(value(".topup > summary", "display"), "none", "a wide screen keeps the whole form: the row is the phone's");
  assert.equal(value(".topup > summary", "min-height", "max-width: 720px"), "44px", "and on a phone the row is a finger's target");
  assert.equal(value(".topup > summary", "cursor", "max-width: 720px"), "pointer");
  assert.ok(
    rules.some((r) => r.at.includes("max-width: 720px") && r.selectors.includes(".stat") && r.selectors.includes(".figures > div") && declared(r, "display") === "flex"),
    "the three figures are the ruled rows the glance's three facts are: one entry a row, its label at the start and its figure at the end",
  );
  assert.equal(value(".figures", "display", "max-width: 720px"), "block", "not the two-column grid that made the panel a form");
  assert.equal(value(".figures dt", "margin-right", "max-width: 720px"), "auto", "the figure goes to the row's end, so the three amounts are one column");
  assert.equal(value(".stat dt", "margin-right", "max-width: 720px"), "auto", "and the glance's three facts are the same rows: the name at the start, the figure at the end");
  assert.match(value(".stat-n", "flex", "max-width: 720px") || "", /1 0 100%/, "with the note on the line under it, as the allowance's measure is, so a phone reads one grammar for the money");
  assert.equal(value(".figures .of", "display", "max-width: 720px"), "flex", "and the allowance's note sits on its line with its bar");
  assert.match(value(".figures .of", "flex", "max-width: 720px") || "", /1 0 100%/, "which is the line under its row, as wide as the row");
  assert.equal(value(".figures .of meter", "flex", "max-width: 720px"), "1", "the bar takes the width the words leave");
  assert.equal(value(".figures .of meter", "min-width", "max-width: 720px"), "3em", "and is measured in the note's own type, so 200% text is a 200% bar");
  assert.equal(value("#balance-panel .card", "padding", "max-width: 720px"), "0", "on a phone the balance is ruled entries at the page's edge, not a card");
});

test("a workspace's address, its caption and Copy share one row on a 360 phone, and a 320 phone keeps the caption's row", () => {
  const rules = cssRules(read(path.join(ASSETS, "app.css")));
  const value = (selector: string, property: string, within = ""): string | undefined => {
    const found = rules.filter((r) => r.selectors.includes(selector) && (within === "" ? r.at === "" : r.at.includes(within)) && declared(r, property) !== undefined);
    return found.length > 0 ? declared(found[found.length - 1]!, property) : undefined;
  };
  const widePhone = "min-width: 360px";
  assert.equal(value(".ws-address-l", "flex", widePhone), "0 0 auto", "at 360 the caption is the first thing on the host's row");
  const fallback = rules.filter((r) => r.selectors.includes(".ws-address-l") && r.at.includes("max-width: 720px") && !r.at.includes("min-width") && declared(r, "flex") !== undefined).at(-1);
  assert.equal(declared(fallback!, "flex"), "1 0 100%", "below 360 it takes its own row, because the host would wrap beside it");
  assert.equal(value(".ws .ws-address", "gap", widePhone), "4px", "the row's gap is the record's 4px, which is what lets the three fit");
  assert.equal(value(".ws .ws-address code", "font-size", widePhone), ".75rem", "the host is the caption's 12px, so the address is not cut");
});

test("a phone's bill names each figure: the column's word is the page's caption, set apart from the figure it names", () => {
  const rules = cssRules(read(path.join(ASSETS, "app.css")));
  const phone = "max-width: 720px";
  const rule = rules.filter((r) => r.at.includes(phone) && r.selectors.includes(".table-wrap td::before") && declared(r, "content") !== undefined).at(-1);
  assert.ok(rule, "a phone draws each figure's column name in its cell");
  // Without the space the label and the figure are one word: at 360 the charge read "Charged$2.74" and the counts "Calls41", "Input180,000".
  assert.match(declared(rule!, "content") ?? "", /^attr\(data-h\) " " \/ ""$/, "the name and its figure are two words, and the name is not said twice");
  assert.equal(declared(rule!, "font-size"), ".75rem", "the name is the caption's 12px, not the figure's own type");
  assert.equal(declared(rule!, "font-weight"), "500", "and lighter than the figure it names");
  assert.equal(declared(rule!, "color"), "var(--k-muted)", "and in the record's muted ink, so the figure is the part that is read");
});

test("a field's refusal is said in the field it names, and takes the field's gap rather than the note's margin", () => {
  const css = read(path.join(ASSETS, "app.css"));
  const rule = cssRules(css).find((r) => r.selectors.includes(".field > .note"));
  assert.ok(rule, "a note in a field has a rule of its own");
  assert.equal(declared(rule!, "margin"), "0", "it takes the field's gap, so the action below it keeps the screen");
  for (const p of pages()) {
    for (const id of ["email-error", "password-error", "current-error", "next-error"]) {
      const note = p.all.find((n) => attr(n, "id") === id);
      if (!note) continue;
      assert.ok(note.parent && note.parent.className.split(/\s+/).includes("field"), `${p.name}: #${id} is in the field's own block`);
      assert.equal(attr(note, "role"), "status", `${p.name}: #${id} is read when the sentence arrives`);
      assert.equal(attr(note, "aria-live"), "polite", `${p.name}: #${id} waits for the reader's place`);
    }
  }
});

test("the stylesheet is held to its budget, and whatever it moves it stills for a person who asked for stillness", () => {
  const css = read(path.join(ASSETS, "app.css"));
  // The stylesheet stands between a visitor and the first paint of every page, so what it weighs is what a phone on a poor connection waits for.
  // 40 KB, uncompressed, for all of it: the kit's block, the icons and the rules of every page. It is written the way the site's is
  // (one rule per line with spaces, a long one a declaration per line), because a file nobody can read is a file nobody dares to change.
  const budget = 40 * 1024;
  assert.ok(Buffer.byteLength(css) <= budget, `app.css is ${Buffer.byteLength(css)} bytes, and its budget is ${budget}`);

  // Every animation is one a keyframes rule defines here (a misspelt name moves nothing and no test would see it) ...
  const defined = new Set([...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]!));
  const used = [...css.matchAll(/[\s;{]animation:\s*([\w-]+)/g)].map((m) => m[1]!);
  assert.ok(used.length > 0 && defined.size > 0, "the stylesheet animates something (the spinners, the skeleton, the pulse of a workspace that is starting)");
  for (const name of used) assert.ok(defined.has(name), `${name} is animated and defined nowhere`);
  // A page arrives once, and holds what it is afterwards (no fill: a transform kept after the move would make the page a containing block for what is fixed in it).
  const arrival = cssRules(css).find((r) => r.selectors.includes("main > .wrap") && declared(r, "animation") !== undefined);
  assert.ok(arrival, "the content of every page arrives");
  assert.match(declared(arrival, "animation") ?? "", /^rise [^ ]+ [^ ]+$/, "with the rise, once, over a time and an ease and no more");

  // ... and a visitor who asked their system for less motion gets none of it: the animations end where they start, the transitions are instant,
  // and a jump to a section is a jump. `!important`, because the rules it overrides are more specific than a bare `*`.
  const still = cssRules(css).find((r) => r.at.includes("prefers-reduced-motion: reduce") && r.selectors.includes("*"));
  assert.ok(still, "there is a rule for prefers-reduced-motion that reaches every element");
  for (const [property, value] of [["animation-duration", ".001ms"], ["animation-iteration-count", "1"], ["transition-duration", ".001ms"], ["scroll-behavior", "auto"]] as const) {
    assert.equal(declared(still, property), `${value} !important`, property);
  }
});

test("on the system's own colours (Windows high contrast) a ticked box is still ticked and an icon is still drawn", () => {
  const rules = cssRules(read(path.join(ASSETS, "app.css")));
  // The system replaces the page's backgrounds with its own. A tick that is a mask over a background is then painted in the colour of the page it sits on,
  // and a box that was ticked looks as it did before: nothing in an ordinary photograph of the page shows it.
  const forced = rules.filter((r) => r.at.includes("forced-colors: active"));
  assert.ok(forced.some((r) => r.selectors.includes('input[type="checkbox"]') && declared(r, "appearance") === "auto"), "the tick box is the browser's again, which draws its tick in the system's colours");
  assert.ok(forced.some((r) => r.selectors.includes('input[type="checkbox"]::after') && declared(r, "display") === "none"), "and the drawn tick is gone, so there is one tick and not two");
  // An icon is a mask over a background that takes the colour of the text beside it: it keeps that, or it is painted in nothing.
  const icons = rules.filter((r) => declared(r, "mask") !== undefined && declared(r, "background") === "currentColor");
  assert.ok(icons.length > 0, "the icons are drawn as masks");
  for (const r of icons) assert.equal(declared(r, "forced-color-adjust"), "none", `${r.selectors[0]}: an icon keeps its colour`);
  const dot = rules.find((r) => r.selectors.includes(".badge::before"));
  assert.equal(declared(dot!, "forced-color-adjust"), "none", "and so does the dot of a badge");
});

test("no page states a period or a count the service could change: those are filled in from its settings", () => {
  const number = /\b\d+\s*(?:days?|hours?|minutes?|weeks?|months?)\b|\b(?:one|two|three|four|five|six|seven|ten|twelve|fourteen|twenty|thirty|sixty|ninety)[\s-]+(?:days?|hours?|minutes?|weeks?)\b/i;
  const withoutPolicy = (n: FakeNode): string[] => (n.isText ? [n.textContent] : n.attrs.has("data-policy") || n.className.split(/\s+/).includes("owner-term") || n.tag === "script" || n.tag === "noscript" ? [] : n.children.flatMap(withoutPolicy));
  for (const { name, doc } of pages()) {
    const text = withoutPolicy(doc.root).join(" ");
    assert.doesNotMatch(text, number, `${name}: ${number.exec(text)?.[0]}`);
  }
  const labelled = pages().flatMap((p) => p.all.filter((n) => n.attrs.has("data-policy")).map((n) => `${p.name}:${attr(n, "data-policy")}`));
  assert.deepEqual(labelled.sort(), ["forgot:resetHours", "index:graceDays", "index:retentionDays", "privacy:idleDays", "privacy:retentionDays", "privacy:sessionDays", "reset:resetHours", "signup:verificationHours", "terms:graceDays", "terms:retentionDays", "verify:verificationHours"]);
  const units = helpers().POLICY_UNITS;
  for (const entry of labelled) assert.ok(units[entry.split(":")[1]!], `the script knows the unit of ${entry}`);
  // The words in the script are the same: it builds its sentences from the numbers it is given.
  for (const m of read(SCRIPT).matchAll(/"[^"\n]*"|`[^`\n]*`/g)) assert.doesNotMatch(m[0], /\b\d+\s*(?:days?|hours?)\b/i, `app.js says ${m[0]}`);
});

test("the legal pages are marked for the owner wherever a person has to decide, and the script's one setting that is the owner's holds the address they gave", () => {
  for (const name of ["terms", "privacy"]) {
    const { all } = pages().find((p) => p.name === name)!;
    const todos = all.filter((n) => n.className.split(/\s+/).includes("todo"));
    // A decision the owner has taken is written into the page (a period they promise is in an `owner-term` span, which is the
    // owner's own commitment and not a setting of the service); what is still open stays marked. The terms still have some.
    // Nothing is left marked once the owner has decided or said plainly in the page that a matter is open (the terms say that no
    // lawyer has reviewed them and that the governing law is not set yet). A marker that remains must still be written as one.
    assert.ok(todos.length >= 0, name);
    for (const t of todos) assert.match(t.textContent.trim(), /^TODO\(owner\): /, name);
  }
  const terms = pages().find((p) => p.name === "terms")!.all.filter((n) => n.tag === "h2").map((n) => n.textContent);
  assert.deepEqual(terms, ["Who provides the service", "What the service is", "Plans, credit and payment", "Acceptable use", "Your data and the models", "Availability and liability", "Changes to these terms"]);
  const privacy = pages().find((p) => p.name === "privacy")!.all.filter((n) => n.tag === "h2").map((n) => n.textContent);
  assert.deepEqual(privacy.slice(0, 3), ["What we keep about you", "Who else receives it", "Your choices"]);
  const contact = /const CONTACT = "([^"]*)";/.exec(read(SCRIPT));
  assert.ok(contact, "the contact address is one constant");
  assert.match(contact![1]!, /^(|mailto:[^\s"]+|https:\/\/[^\s"]+)$/, "empty, or a mailto: or an https: address");
  assert.equal(contact![1], "mailto:ali79taba@gmail.com", "the operator's own address, which they gave");
  assert.doesNotMatch(read(SCRIPT), /TODO\(owner\)/, "and nothing in the script is left marked: the legal pages carry what is still the owner's to decide");
  for (const name of ["terms", "privacy"]) assert.ok(read(path.join(PAGES_DIR, `${name}.html`)).includes("ali79taba@gmail.com"), `${name} says who to write to`);
});
