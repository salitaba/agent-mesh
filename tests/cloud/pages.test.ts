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
import { PAGES_DIR, ROOT, SCRIPT, helpers, parsePage, type FakeNode } from "./pages-support";

const read = (file: string): string => fs.readFileSync(file, "utf8");
const ASSETS = path.join(PAGES_DIR, "assets");

/** The path each page is served at. `index` is the front page. */
const PATHS: Record<string, string> = { index: "/", signup: "/signup", login: "/login", verify: "/verify", forgot: "/forgot", reset: "/reset", account: "/account", terms: "/terms", privacy: "/privacy" };
/** What a page calls itself in the script. */
const PAGE_OF: Record<string, string> = { index: "home" };

function pages() {
  return Object.keys(PATHS).map((name) => {
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
  assert.deepEqual(fs.readdirSync(PAGES_DIR).sort(), ["account.html", "assets", "forgot.html", "index.html", "login.html", "privacy.html", "reset.html", "signup.html", "terms.html", "verify.html"]);
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
      assert.deepEqual([r.status, r.headers["content-type"], r.headers["cache-control"]], [200, type, "public, max-age=300"], file);
      assert.equal(r.body, read(path.join(ASSETS, file)));
    }
    for (const missing of ["/index.html", "/index", "/account.html", "/assets/", "/assets/missing.js", "/assets/../account.html"]) assert.equal((await ask(srv.port, { host: "app.example.com", path: missing })).status, 404, missing);
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
    assert.ok(name === "index" ? title === "Curule Cloud: run a mesh without running a server" : /^[^–]+ – Curule Cloud$/.test(title), where(`title "${title}"`));
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

test("every link goes to a page or an anchor that exists, whether it is written in a page or made by the script", () => {
  const served = new Set(Object.values(PATHS));
  const byPath = Object.fromEntries(pages().map((p) => [PATHS[p.name]!, p]));
  const check = (target: string, from: string): void => {
    const [beforeFragment, fragment] = target.split("#");
    const at = beforeFragment!.split("?")[0]!;
    assert.ok(served.has(at), `${from}: ${target} is not a page`);
    if (fragment) assert.ok(idsOf(byPath[at]!.all).includes(fragment), `${from}: ${target} names an anchor that is not there`);
  };
  for (const p of pages()) {
    for (const n of p.all.filter((x) => x.tag === "a")) {
      const href = attr(n, "href");
      if (href === "#main") assert.ok(idsOf(p.all).includes("main"));
      else if (href === "#") assert.ok(n.attrs.has("data-contact") && n.hidden, `${p.name}: only the hidden contact link goes nowhere`);
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

// ---- what the pages say ----

test("the colours are the site's, and every text colour clears WCAG AA on the backgrounds it is used on", () => {
  const vars = (css: string): Record<string, string> => Object.fromEntries([...css.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => [m[1]!, m[2]!.toLowerCase()]));
  const sets = (css: string) => ({ light: vars(/:root \{([\s\S]*?)\n\}/.exec(css)![1]!), dark: vars(/@media \(prefers-color-scheme: dark\) \{\s*:root \{([\s\S]*?)\}\s*\}/.exec(css)![1]!) });
  const site = sets(read(path.join(ROOT, "site", "assets", "site.css")));
  const app = sets(read(path.join(ASSETS, "app.css")));
  for (const theme of ["light", "dark"] as const) {
    for (const name of ["--bg", "--panel", "--ink", "--muted", "--line", "--accent", "--accent-ink", "--ok", "--warn", "--code"]) {
      assert.ok(site[theme][name], `the site has ${name}`);
      assert.equal(app[theme][name], site[theme][name], `${theme} ${name} is the site's`);
    }
    assert.ok(app[theme]["--bad"], `${theme} --bad`);
  }
  const luminance = (hex: string): number => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const contrast = (a: string, b: string): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };
  for (const theme of ["light", "dark"] as const) {
    const c = app[theme];
    for (const fg of ["--ink", "--muted", "--accent", "--ok", "--warn", "--bad"]) for (const bg of ["--bg", "--panel"]) assert.ok(contrast(c[fg]!, c[bg]!) >= 4.5, `${theme} ${fg} on ${bg} is ${contrast(c[fg]!, c[bg]!).toFixed(2)}:1`);
    assert.ok(contrast(c["--accent-ink"]!, c["--accent"]!) >= 4.5, `${theme} text on the accent`);
  }
});

test("no page states a period or a count the service could change: those are filled in from its settings", () => {
  const number = /\b\d+\s*(?:days?|hours?|minutes?|weeks?|months?)\b|\b(?:one|two|three|four|five|six|seven|ten|twelve|fourteen|twenty|thirty|sixty|ninety)[\s-]+(?:days?|hours?|minutes?|weeks?)\b/i;
  const withoutPolicy = (n: FakeNode): string[] => (n.isText ? [n.textContent] : n.attrs.has("data-policy") || n.className.split(/\s+/).includes("owner-term") || n.tag === "script" || n.tag === "noscript" ? [] : n.children.flatMap(withoutPolicy));
  for (const { name, doc } of pages()) {
    const text = withoutPolicy(doc.root).join(" ");
    assert.doesNotMatch(text, number, `${name}: ${number.exec(text)?.[0]}`);
  }
  const labelled = pages().flatMap((p) => p.all.filter((n) => n.attrs.has("data-policy")).map((n) => `${p.name}:${attr(n, "data-policy")}`));
  assert.deepEqual(labelled.sort(), ["index:graceDays", "index:retentionDays", "privacy:idleDays", "privacy:retentionDays", "privacy:sessionDays", "terms:graceDays", "terms:retentionDays", "verify:verificationHours"]);
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
    assert.ok(name === "privacy" || todos.length >= 1, `${name} has the places the owner has still to fill in or confirm marked`);
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
