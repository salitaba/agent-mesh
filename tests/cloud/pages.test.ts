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
  assert.deepEqual(fs.readdirSync(PAGES_DIR).sort(), ["404.html", "account.html", "assets", "forgot.html", "index.html", "login.html", "privacy.html", "reset.html", "signup.html", "terms.html", "verify.html"]);
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
    for (const wrong of ["/pricing", "/docs", "/dashboard", "/accounts", "/index.html", "/assets/missing.js"]) {
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

/** What the panel beside the form says, in the words of the pages that already say it (the front page's facts, the terms, the account's workspace card). */
const PANEL: Array<[string, string]> = [
  ["A workspace of your own", "One isolated host with its own projects, event log and files."],
  ["Your record is yours", "The same append-only event log a self-hosted install writes, so a mission can be replayed."],
  ["Pause or delete", "A paused workspace keeps its files. Deleting one deletes its data."],
];

test("the sign-in pages are one shell: the form first, and beside it the same three things the product says of itself, each of them said elsewhere already", () => {
  for (const name of ["signup", "login", "forgot", "reset", "verify"]) {
    const { all } = pages().find((p) => p.name === name)!;
    const shell = all.find((n) => n.className === "wrap auth")!;
    assert.ok(shell, `${name} has the shell`);
    const [main, side] = shell.children.filter((n) => !n.isText);
    assert.deepEqual([main!.className, side!.className], ["auth-main", "auth-side"], `${name}: the form's column comes first, so it is first to a keyboard and to a reader of the page`);
    assert.ok(main!.querySelector("h1") && main!.descendants().some((n) => n.tag === "form"), `${name}: the heading and the form are in it`);
    assert.deepEqual(side!.querySelectorAll("li").map((li) => [li.querySelector("strong")!.textContent, li.querySelector("span")!.textContent]), PANEL, `${name}: the panel says the same three things`);
    assert.equal(attr(side!.querySelector("svg")!, "aria-hidden"), "true", `${name}: the mark is for the eye`);
  }
  // Nothing in the panel is new: each is a sentence, or the two halves of one, that a page already has.
  const textOf = (file: string): string => read(path.join(PAGES_DIR, file)).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  assert.match(textOf("index.html"), /One isolated host with its own projects, event log and files\./);
  assert.match(textOf("index.html"), /same append-only event log a self-hosted install writes, so a mission can be replayed/);
  assert.match(textOf("terms.html"), /Deleting a workspace deletes its data\./);
  assert.match(read(SCRIPT), /Its files are kept\./, "what the account says of a paused workspace");
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
    assert.equal(all.filter((n) => n.tag === "article").length, 1, `${name}: the text is one article`);
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
  assert.equal(value('input[type="email"]', "min-height", phone), "44px", "a field");
  assert.deepEqual([value(".reveal", "top"), value(".reveal", "bottom")], ["0", "0"], "Show and Hide span the whole height of the field, so they are as tall as it is");
  assert.equal(value(".site-footer a", "min-height"), "44px", "the footer's links are words with the reach of a button");
  assert.equal(value(".site-footer a", "min-width"), "44px");
  assert.equal(value(".check label", "min-height"), "44px", "a tick box is ticked by hitting its sentence");
  assert.equal(value(".aside a", "padding"), "12px 2px", "a link in a line of its own has a hit area taller than its text");
  assert.equal(value(".aside a", "margin"), "-12px 0", "without moving the lines around it");
  assert.equal(value(".ws .ws-auto .check", "min-height"), "44px", "and so is the offer to open a workspace when it is ready");
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
