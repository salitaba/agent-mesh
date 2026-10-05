/**
 * The header and the footer of the site's pages are written by scripts/site-chrome.mjs, so that seven copies of the navigation
 * cannot drift apart. The first cases hold the script to what it promises, on a small site written out here: it touches only what
 * is between its markers, keeps the footer's contact line the owner (or set-domain) wrote, writes the links the way each page's
 * depth needs, finds a page nobody listed, and writes nothing when one page is wrong. The last ones hold the committed pages to it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ROOT, SITE, sitePages } from "./site-pages";

const SCRIPT = path.join(ROOT, "scripts", "site-chrome.mjs");
const run = (root: string, ...args: string[]) => {
  const r = spawnSync(process.execPath, [SCRIPT, "--root", root, ...args], { encoding: "utf8", timeout: 30_000 });
  return { status: r.status, out: r.stdout, err: r.stderr };
};

const FENCES = (body: string): string =>
  `<!doctype html>\n<html lang="en">\n<head><title>x</title></head>\n<body>\n<!-- generated:chrome-header:start (scripts/site-chrome.mjs; do not edit between the markers) -->\n<!-- generated:chrome-header:end -->\n<main id="main">${body}</main>\n<!-- generated:chrome-footer:start (scripts/site-chrome.mjs; do not edit between the markers) -->\n<!-- generated:chrome-footer:end -->\n</body>\n</html>\n`;

/** A site with a home page, one page in a folder and the page for a missing address, in a folder that looks like the repository. */
function smallSite(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "curule-chrome-"));
  for (const [rel, body] of [["index.html", "<h1>Home</h1>"], ["pricing/index.html", "<h1>Pricing</h1>"], ["docs/index.html", "<h1>Docs</h1>"], ["404.html", "<h1>Not here</h1>"]] as const) {
    fs.mkdirSync(path.dirname(path.join(dir, "site", rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, "site", rel), FENCES(body), "utf8");
  }
  return dir;
}
const read = (dir: string, rel: string): string => fs.readFileSync(path.join(dir, "site", rel), "utf8");
const write = (dir: string, rel: string, text: string): void => fs.writeFileSync(path.join(dir, "site", rel), text, "utf8");
const navOf = (html: string): string => /<nav class="nav-main"[\s\S]*?<\/nav>/.exec(html)![0];
const hrefs = (html: string): string[] => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);

test("it writes the header and the footer between the markers, and a second run changes nothing", () => {
  const dir = smallSite();
  const first = run(dir);
  assert.equal(first.status, 0, first.err);
  assert.match(first.out, /rewrote the header and footer of 4 page\(s\)/);
  const home = read(dir, "index.html");
  assert.match(home, /<a class="skip" href="#main">Skip to the content<\/a>\n<header class="site-header">/);
  assert.match(home, /<footer class="site-footer">[\s\S]*Claude and Anthropic are trademarks of Anthropic PBC; Curule is not affiliated with or endorsed by Anthropic\./);
  assert.ok(home.includes("<main id=\"main\"><h1>Home</h1></main>"), "what is outside the markers is as it was");
  assert.equal((home.match(/<svg class="logo"/g) ?? []).length, 2, "the logo, in the header and in the footer");
  const again = run(dir);
  assert.equal(again.status, 0);
  assert.match(again.out, /nothing to change in 4 pages/);
  assert.equal(read(dir, "index.html"), home);
  assert.equal(run(dir, "--check").status, 0);
});

test("the links are written the way each page's depth needs, and the page you are on is marked in the navigation", () => {
  const dir = smallSite();
  assert.equal(run(dir).status, 0);
  const home = read(dir, "index.html");
  const pricing = read(dir, "pricing/index.html");
  const notFound = read(dir, "404.html");
  assert.deepEqual(hrefs(navOf(home)), ["#product", "pricing/", "docs/", "security/"], "from the home page: its own section, and its neighbours");
  assert.deepEqual(hrefs(navOf(pricing)), ["../#product", "../pricing/", "../docs/", "../security/"], "from a folder: one level up");
  assert.deepEqual(hrefs(navOf(notFound)), ["/#product", "/pricing/", "/docs/", "/security/"], "from the page shown at any depth: from the root");
  assert.ok(!navOf(home).includes("aria-current"), "no page of the navigation is the home page");
  assert.match(navOf(pricing), /<a href="\.\.\/pricing\/" aria-current="page">Pricing<\/a>/);
  assert.equal((navOf(pricing).match(/aria-current/g) ?? []).length, 1, "and only that one");
  assert.ok(!navOf(notFound).includes("aria-current"), "a page that is not found is none of them");
  assert.match(home, /<a class="brand" href="\.\/" aria-label="Curule, home">/);
  assert.match(pricing, /<a class="brand" href="\.\.\/" aria-label="Curule, home">/);
  assert.match(notFound, /<a class="brand" href="\/" aria-label="Curule, home">/);
  assert.match(home, /<a class="btn btn-primary" href="#try" data-selfhost-only>Try the demo<\/a>/, "the demo is on the home page itself");
  assert.match(pricing, /<a class="btn btn-primary" href="\.\.\/#try" data-selfhost-only>Try the demo<\/a>/, "and a click from another page goes there");
  assert.match(pricing, /<a href="\.\.\/docs\/" data-doc="\.\.\/README\.md">Quickstart<\/a>/, "a link the shared script sets has a page to go to without it");
  assert.match(pricing, /<a href="\.\.\/docs\/" data-repo="">Source code<\/a>/);
  // Sign in is a link the shared script gives an address, and it is not there for a visitor who has no script.
  for (const html of [home, pricing, notFound]) assert.equal((html.match(/<a [^>]*data-app hidden>Sign in<\/a>/g) ?? []).length, 2, "the sign-in link, in the bar and in the phone menu, hidden until the script gives it an address");
  // Curule Cloud's links are the same: two ways to sign in, one to get started, none of them there until it is open and the script says where.
  for (const html of [home, pricing, notFound]) {
    assert.equal((html.match(/<a [^>]*data-cloud="login" hidden>Sign in<\/a>/g) ?? []).length, 2, "Sign in into the account, in the bar and in the phone menu");
    assert.equal((html.match(/<a class="btn btn-primary" href="#" data-cloud="signup" hidden>Get started<\/a>/g) ?? []).length, 1, "and Get started, in the bar");
  }
});

test("a page whose header was edited by hand is reported, and the script puts it right and touches nothing else", () => {
  const dir = smallSite();
  assert.equal(run(dir).status, 0);
  const original = read(dir, "pricing/index.html");
  write(dir, "pricing/index.html", original.replace('<a href="../docs/">Docs</a>', '<a href="../docs/">Documents</a>'));
  const stale = run(dir, "--check");
  assert.equal(stale.status, 1);
  assert.match(stale.err, /out of date: pricing\/index\.html\n/);
  assert.equal(run(dir).status, 0);
  assert.equal(read(dir, "pricing/index.html"), original, "the generated blocks are back, and the rest of the page is as it was");
  assert.equal(run(dir, "--check").status, 0);
  // A hand edit to the page's own content is not the script's business.
  write(dir, "pricing/index.html", original.replace("<h1>Pricing</h1>", "<h1>Pricing, edited</h1>"));
  assert.equal(run(dir, "--check").status, 0);
});

test("the footer's contact line is the owner's: it survives the script, and is not put back to the placeholder", () => {
  const dir = smallSite();
  assert.equal(run(dir).status, 0);
  assert.match(read(dir, "docs/index.html"), /<span id="contact">TODO\(owner\): company name, contact email<\/span>/, "before anyone has filled it, the placeholder");
  const filled = '<span id="contact">Curule Labs &amp; Co &middot; <a href="mailto:hello@curule.dev">hello@curule.dev</a></span>';
  for (const rel of ["index.html", "pricing/index.html", "docs/index.html", "404.html"]) write(dir, rel, read(dir, rel).replace(/<span id="contact">[\s\S]*?<\/span>/, filled));
  assert.equal(run(dir, "--check").status, 0, "a filled contact line is not a difference");
  write(dir, "docs/index.html", read(dir, "docs/index.html").replace('<a href="../security/">Security</a>', '<a href="../security/">Safety</a>'));
  assert.equal(run(dir, "--check").status, 1);
  assert.equal(run(dir).status, 0);
  assert.ok(read(dir, "docs/index.html").includes(filled), "the contact line is still there");
  assert.ok(!read(dir, "docs/index.html").includes("TODO(owner)"));
  assert.ok(!read(dir, "docs/index.html").includes("Safety"), "and the header is the script's again");
});

test("a page without the markers is refused whole, and a page nobody listed is found", () => {
  const dir = smallSite();
  assert.equal(run(dir).status, 0);
  const docsPage = path.join(dir, "site", "docs", "index.html");
  const original = fs.readFileSync(docsPage, "utf8");
  fs.writeFileSync(docsPage, original.replace(/<!-- generated:chrome-footer:end -->/, ""), "utf8");
  const stale = read(dir, "pricing/index.html").replaceAll('<a href="../docs/">Docs</a>', '<a href="../docs/">Documents</a>');
  write(dir, "pricing/index.html", stale);
  const refused = run(dir);
  assert.equal(refused.status, 2);
  assert.match(refused.err, /docs\/index\.html: the block 'chrome-footer' is not fenced/);
  assert.equal(read(dir, "pricing/index.html"), stale, "nothing was written, not even to the pages that were fine");
  fs.writeFileSync(docsPage, original, "utf8");

  fs.mkdirSync(path.join(dir, "site", "status"), { recursive: true });
  write(dir, "status/index.html", FENCES("<h1>Status</h1>"));
  assert.equal(run(dir, "--check").status, 1, "a new page is held to the script like the others");
  assert.equal(run(dir).status, 0);
  const added = read(dir, "status/index.html");
  assert.match(added, /<a class="brand" href="\.\.\/" aria-label="Curule, home">/, "and gets links for its depth");
  assert.match(added, /<a href="\.\.\/pricing\/">Pricing<\/a>/);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "curule-chrome-empty-"));
  assert.equal(run(empty).status, 2, "a folder that is not the repository has no pages to write");
});

// ---------------------------------------------------------------- the committed pages

test("the committed pages carry the header and the footer the script writes", () => {
  const r = run(ROOT, "--check");
  assert.equal(r.status, 0, `${r.out}${r.err}`);
  assert.match(r.out, /the header and footer of \d+ pages are up to date/);
  assert.ok(sitePages().length >= 7);
});

test("on the committed pages the navigation goes where the page's depth needs, and each page marks itself", () => {
  const pages = sitePages();
  for (const p of pages) {
    const nav = navOf(p.html);
    const own = p.address === null || p.address === "" ? null : p.address.replace("/", "");
    const prefix = p.rel === "404.html" ? "/" : p.rel.includes("/") ? "../" : "";
    const expected = ["#product", "pricing/", "docs/", "security/"].map((h) => (h === "#product" && prefix === "" ? h : `${prefix}${h}`));
    assert.deepEqual(hrefs(nav), expected, `${p.rel}: its navigation`);
    const current = [...nav.matchAll(/aria-current="page">([^<]+)</g)].map((m) => m[1]!.toLowerCase());
    assert.deepEqual(current, own && ["pricing", "docs", "security"].includes(own) ? [own] : [], `${p.rel}: the page it is on`);
  }
  assert.ok(fs.existsSync(path.join(SITE, "404.html")));
});
