/**
 * The header and the footer of the site's pages are written by scripts/site-chrome.mjs, so that seven copies of the navigation
 * cannot drift apart. The first cases hold the script to what it promises, on a small site written out here: it touches only what
 * is between its markers, keeps the footer's contact line the owner (or set-domain) wrote, writes the links the way each page's
 * depth needs, finds a page nobody listed, and writes nothing when one page is wrong. The last ones hold the committed pages to it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import * as crypto from "crypto";
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
  assert.match(first.out, /rewrote 4 page\(s\)/);
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

test("the header is written in the state Curule Cloud is in, which the shared script says, and a site with no script, or a closed one, is as it was", () => {
  const dir = smallSite();
  assert.equal(run(dir).status, 0);
  const closed = Object.fromEntries(["index.html", "pricing/index.html", "404.html"].map((rel) => [rel, read(dir, rel)]));
  const script = (url: string): string => `var CLOUD_URL = "${url}";\n(function () {\n  var CLOUD_PATH = { home: "/", login: "/login", signup: "/signup", terms: "/terms", privacy: "/privacy" };\n})();\n`;
  fs.mkdirSync(path.join(dir, "site", "assets"), { recursive: true });
  write(dir, "assets/site.js", script("https://app.curule.dev/"));
  const stale = run(dir, "--check");
  assert.equal(stale.status, 1, "a page written for a closed site is out of date once the script says it is open");
  assert.match(stale.err, /out of date: index\.html, docs\/index\.html, pricing\/index\.html, 404\.html/);
  assert.equal(run(dir).status, 0);
  for (const rel of ["index.html", "pricing/index.html", "404.html"]) {
    const html = read(dir, rel);
    assert.equal((html.match(/<a class="signin" href="https:\/\/app\.curule\.dev\/login" data-cloud="login">Sign in<\/a>/g) ?? []).length, 1, `${rel}: Sign in in the bar, with its address`);
    assert.equal((html.match(/<a href="https:\/\/app\.curule\.dev\/login" data-cloud="login">Sign in<\/a>/g) ?? []).length, 1, `${rel}: and in the phone menu`);
    assert.equal((html.match(/<a class="btn btn-primary" href="https:\/\/app\.curule\.dev\/signup" data-cloud="signup">Get started<\/a>/g) ?? []).length, 1, `${rel}: Get started`);
    assert.match(html, /<a class="btn btn-primary" href="[^"]*#try" data-selfhost-only hidden>Try the demo<\/a>/, `${rel}: the demo button gives its place to Get started`);
    assert.match(html, /<a [^>]*data-app hidden>Sign in<\/a>/, `${rel}: the dashboard's own link is the script's business, and stays hidden`);
  }
  assert.equal(run(dir, "--check").status, 0, "and that is what the script now says");
  write(dir, "assets/site.js", script(""));
  assert.equal(run(dir, "--check").status, 1);
  assert.equal(run(dir).status, 0);
  for (const [rel, html] of Object.entries(closed)) assert.equal(read(dir, rel), html, `${rel}: closed again, exactly as it was`);
  write(dir, "assets/site.js", 'var CLOUD_URL = "https://app.curule.dev";\n');
  const refused = run(dir);
  assert.equal(refused.status, 2, "an address with no page to send a link to is refused, as a page lacking its markers is");
  assert.match(refused.err, /assets\/site\.js: .*CLOUD_PATH/);
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

// ---------------------------------------------------------------- the fingerprints of the stylesheet and the scripts

/** What a fingerprint is: ten hex digits of the SHA-256 of the file. Written out here, so that the script is held to it and does not define it. */
const sha10 = (text: string): string => crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 10);

/** A small site whose pages load the stylesheet and the scripts, each by the address its depth needs, and whose files exist. */
function assetSite(): string {
  const dir = smallSite();
  const loads = (prefix: string, extra = ""): string => `<link rel="stylesheet" href="${prefix}assets/site.css"><link rel="icon" href="${prefix}assets/favicon.svg"><script src="${prefix}assets/site.js" defer></script>${extra}`;
  const withLoads = (rel: string, prefix: string, extra = ""): void => write(dir, rel, read(dir, rel).replace("</head>", `${loads(prefix, extra)}</head>`));
  withLoads("index.html", "");
  withLoads("pricing/index.html", "../", '<script src="../assets/pricing.js" defer></script>');
  withLoads("docs/index.html", "../");
  withLoads("404.html", "/");
  fs.mkdirSync(path.join(dir, "site", "assets"), { recursive: true });
  write(dir, "assets/site.css", "body { color: #111; }\n");
  write(dir, "assets/site.js", "var CLOUD_URL = \"\";\n");
  write(dir, "assets/pricing.js", "var pricing = 1;\n");
  write(dir, "assets/favicon.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"/>\n");
  return dir;
}
const loadsOf = (html: string): string[] => [...html.matchAll(/\b(?:href|src)="([^"]*assets\/[^"]*)"/g)].map((m) => m[1]!);

test("the stylesheet and the scripts are named by a fingerprint of their content, at the address each page's depth needs, and nothing else is", () => {
  const dir = assetSite();
  assert.equal(run(dir, "--check").status, 1, "pages that name the files bare are out of date: a visitor's cache could hold older ones");
  const r = run(dir);
  assert.equal(r.status, 0, r.err);
  const css = sha10(read(dir, "assets/site.css"));
  const js = sha10(read(dir, "assets/site.js"));
  const pricing = sha10(read(dir, "assets/pricing.js"));
  assert.deepEqual(loadsOf(read(dir, "index.html")), [`assets/site.css?v=${css}`, "assets/favicon.svg", `assets/site.js?v=${js}`]);
  assert.deepEqual(loadsOf(read(dir, "pricing/index.html")), [`../assets/site.css?v=${css}`, "../assets/favicon.svg", `../assets/site.js?v=${js}`, `../assets/pricing.js?v=${pricing}`]);
  assert.deepEqual(loadsOf(read(dir, "404.html")), [`/assets/site.css?v=${css}`, "/assets/favicon.svg", `/assets/site.js?v=${js}`], "the page shown at any depth names them from the root");
  assert.match(read(dir, "index.html"), /<link rel="stylesheet" href="assets\/site\.css\?v=[0-9a-f]{10}">/, "a stylesheet link is still one, with the address changed and nothing else");
  assert.match(read(dir, "index.html"), /<script src="assets\/site\.js\?v=[0-9a-f]{10}" defer><\/script>/);
  assert.equal(run(dir, "--check").status, 0);
  assert.match(run(dir).out, /nothing to change in 4 pages/, "and a second run writes nothing: the same bytes, the same fingerprint");
});

test("a changed file is a new address in every page that loads it and in no other, and a page that is stale is reported until the script has run", () => {
  const dir = assetSite();
  assert.equal(run(dir).status, 0);
  const before = Object.fromEntries(["index.html", "pricing/index.html", "docs/index.html", "404.html"].map((rel) => [rel, read(dir, rel)]));
  // The stylesheet is edited by hand, as it is on the day a rule is fixed.
  write(dir, "assets/site.css", "body { color: #222; }\n");
  const stale = run(dir, "--check");
  assert.equal(stale.status, 1, "an edited stylesheet is out of date in every page until the new address is written");
  assert.match(stale.err, /out of date: index\.html, docs\/index\.html, pricing\/index\.html, 404\.html/);
  assert.match(stale.err, /fingerprints of the stylesheet and the scripts/, "and says what to run, and what it writes");
  assert.equal(run(dir).status, 0);
  const css = sha10("body { color: #222; }\n");
  for (const [rel, html] of Object.entries(before)) {
    const now = read(dir, rel);
    assert.equal(now, html.replace(/site\.css\?v=[0-9a-f]{10}/, `site.css?v=${css}`), `${rel}: only the stylesheet's address changed`);
    assert.ok(!/\?v=[0-9a-f]{10}\?v=/.test(now), `${rel}: an address is replaced, not added to`);
  }
  // The script is a different file with a different fingerprint: the stylesheet's address is not touched by it.
  write(dir, "assets/site.js", 'var CLOUD_URL = "";\n// edited\n');
  assert.equal(run(dir, "--check").status, 1);
  assert.equal(run(dir).status, 0);
  assert.match(read(dir, "docs/index.html"), new RegExp(`assets/site\\.css\\?v=${css}`), "the stylesheet's address stayed");
  assert.match(read(dir, "docs/index.html"), new RegExp(`assets/site\\.js\\?v=${sha10('var CLOUD_URL = "";\n// edited\n')}`));
  // The same bytes again (a file touched, or an edit undone) are the same address: a visitor's copy stays good.
  write(dir, "assets/site.css", "body { color: #111; }\n");
  assert.equal(run(dir).status, 0);
  assert.equal(read(dir, "index.html").match(/site\.css\?v=([0-9a-f]{10})/)![1], sha10("body { color: #111; }\n"));
});

test("a file a page names that is not there, and a file that is not one of the three, are left as they are", () => {
  const dir = assetSite();
  fs.rmSync(path.join(dir, "site", "assets", "pricing.js"));
  assert.equal(run(dir).status, 0);
  assert.ok(read(dir, "pricing/index.html").includes('<script src="../assets/pricing.js" defer></script>'), "no file, no fingerprint: the page is not made to name one that does not exist");
  assert.ok(read(dir, "index.html").includes('<link rel="icon" href="assets/favicon.svg">'), "the images are under stable names and are not fingerprinted");
  assert.equal(run(dir, "--check").status, 0);
});

// ---------------------------------------------------------------- the committed pages

test("the committed pages carry the header and the footer the script writes", () => {
  const r = run(ROOT, "--check");
  assert.equal(r.status, 0, `${r.out}${r.err}`);
  assert.match(r.out, /the header, the footer and the fingerprints of the stylesheet and scripts of \d+ pages are up to date/);
  assert.ok(sitePages().length >= 7);
});

test("every committed page names the stylesheet and the scripts by the fingerprint of the file as it is, so that no visitor reads a page with an older stylesheet than it was written for", () => {
  const files = Object.fromEntries(["site.css", "site.js", "pricing.js"].map((name) => [name, sha10(fs.readFileSync(path.join(SITE, "assets", name), "utf8"))]));
  const seen = new Set<string>();
  for (const p of sitePages()) {
    const loads = [...p.html.matchAll(/\b(?:href|src)="((?:\.\.\/|\/)?assets\/(site\.css|site\.js|pricing\.js)(\?v=[0-9a-f]+)?)"/g)];
    const names = loads.map((m) => m[2]!);
    assert.ok(names.includes("site.css") && names.includes("site.js"), `${p.rel}: loads the stylesheet and the script`);
    assert.equal(names.includes("pricing.js"), p.rel === "pricing/index.html", `${p.rel}: the calculator's script is the pricing page's`);
    for (const [, address, name, query] of loads) {
      assert.equal(query, `?v=${files[name!]}`, `${p.rel}: ${address} carries the fingerprint of ${name}`);
      seen.add(name!);
    }
  }
  assert.deepEqual([...seen].sort(), ["pricing.js", "site.css", "site.js"]);
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
