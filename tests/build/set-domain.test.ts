import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * `scripts/set-domain.mjs` applies the domain that was chosen to every place that carries it, so that they cannot disagree and
 * none is forgotten: every page's absolute social-image addresses, canonical link, og:url and footer, the contact page's
 * addresses, the shared script's settings, SECURITY.md's address, and the files a host and a crawler read (CNAME, robots.txt,
 * sitemap.xml, security.txt). It must never touch LICENSE, never half-apply (every edit is computed before anything is
 * written), and be safe to run twice.
 *
 * The cases run against a small site written out below, in the state the repository ships it in before a domain is chosen.
 * Running them against the repository's own files would fail them on the day the owner applies the domain, because the markers
 * they look for would be gone.
 */

const ROOT = path.resolve(__dirname, "..", "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "set-domain.mjs");

/** The shapes the script finds its places in: the head's social images, the footer's contact, and on the contact page the addresses. */
function templatePage(body = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Curule</title>
<meta property="og:type" content="website">
<meta property="og:title" content="Curule: a team of AI agents, run like an organization">
<!-- TODO(owner): og:image and twitter:image must be absolute URLs once the domain is chosen, for example https://<your-domain>/assets/social-card.png -->
<meta property="og:image" content="assets/social-card.png">
<meta property="og:image:width" content="1200">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="assets/social-card.png">
<link rel="icon" href="assets/favicon.svg">
</head>
<body>
<main><a href="#plans">Plans</a>${body}</main>
<footer>
  <div class="wrap">
    <p><b>Curule</b> &middot; <span id="contact">TODO(owner): company name, contact email</span></p>
    <p class="small"><a href="#" data-doc="operations.md">Operations</a></p>
  </div>
</footer>
</body>
</html>
`;
}

const CONTACT_BODY = `
<p><a data-mail="sales" href="#sales">TODO(owner): sales address</a></p>
<p><a data-mail="support" href="#support">TODO(owner): support address</a></p>
<p><a data-mail="security" href="#security">TODO(owner): security address</a></p>
<p>Published by <span data-company>TODO(owner): company name</span>.</p>`;

const NOT_FOUND = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Page not found</title>
<meta name="robots" content="noindex">
</head>
<body>
<main><h1>Not here</h1></main>
<footer><p><span id="contact">TODO(owner): company name, contact email</span></p></footer>
</body>
</html>
`;

const TEMPLATE_SCRIPT = `"use strict";
// TODO(owner): where the documents are published. Until the commercial branch is merged to main these links 404.
var DOCS_BASE = "https://github.com/salitaba/agent-mesh/blob/main/docs/";
var APP_URL = "#"; // TODO(owner): where "Sign in" goes, for example https://mesh.<your-domain>/ (your own dashboard); "" removes the link
var CONTACT_HREF = "#"; // TODO(owner): mailto: or a contact form for "Talk to us" and the paid plans
var IMAGE_RELEASED = false;
`;

const TEMPLATE_POLICY = `# Security policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately, by either of:

- GitHub's private vulnerability reporting: <https://github.com/salitaba/agent-mesh/security/advisories/new>
- Email: \`TODO(owner): security@<your domain>\` (set this address up, and enable private vulnerability reporting
  in the repository's settings, before the first customer)

Include what you found, how to reproduce it (a request, a config, a version), what an attacker gains, and
whether you have told anyone else.

## What to expect

These are the targets this project commits to.

## Supported versions

The latest release.
`;

const TEMPLATE_LICENCE = `Business Source License 1.1

For a licence beyond these terms, please contact the Licensor through https://github.com/salitaba/agent-mesh by
opening an issue.
`;

function write(dir: string, rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text, "utf8");
}

function templateRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "curule-domain-"));
  write(dir, "site/index.html", templatePage());
  write(dir, "site/pricing/index.html", templatePage());
  write(dir, "site/contact/index.html", templatePage(CONTACT_BODY));
  write(dir, "site/404.html", NOT_FOUND);
  write(dir, "site/assets/site.js", TEMPLATE_SCRIPT);
  write(dir, "SECURITY.md", TEMPLATE_POLICY);
  write(dir, "LICENSE", TEMPLATE_LICENCE);
  return dir;
}

function run(root: string, args: string[]): { status: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, [SCRIPT, "--root", root, ...args], { encoding: "utf8", timeout: 30_000 });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

/** Every file under the copy, relative path to content. */
function snapshot(dir: string, rel = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const p = path.join(rel, e.name);
    if (e.isDirectory()) Object.assign(out, snapshot(dir, p));
    else out[p] = fs.readFileSync(path.join(dir, p), "utf8");
  }
  return out;
}

const read = (dir: string, rel: string): string => fs.readFileSync(path.join(dir, rel), "utf8");
const FULL = ["curule.dev", "--contact", "hello@curule.dev", "--security", "security@curule.dev", "--company", "Curule Labs & Co", "--docs-base", "github", "--app-url", "https://mesh.curule.dev/", "--today", "2026-10-03"];

test("a domain with its addresses fills every marker, on every page, and writes the files a host and a crawler read", () => {
  const dir = templateRepo();
  const licence = read(dir, "LICENSE");
  const r = run(dir, FULL);
  assert.equal(r.status, 0, r.err);
  for (const [rel, text] of Object.entries(snapshot(dir))) assert.ok(!text.includes("TODO(owner)"), `${rel}: nothing is left to fill`);

  for (const [rel, address] of [["site/index.html", "https://curule.dev/"], ["site/pricing/index.html", "https://curule.dev/pricing/"], ["site/contact/index.html", "https://curule.dev/contact/"]] as const) {
    const page = read(dir, rel);
    assert.ok(page.includes(`<meta property="og:type" content="website">\n<link rel="canonical" href="${address}">\n<meta property="og:url" content="${address}">\n`), `${rel}: the canonical link and og:url name the page's own address, after og:type, which is kept`);
    assert.match(page, /<meta property="og:image" content="https:\/\/curule\.dev\/assets\/social-card\.png">/, rel);
    assert.match(page, /<meta name="twitter:image" content="https:\/\/curule\.dev\/assets\/social-card\.png">/, rel);
    assert.match(page, /<span id="contact">Curule Labs &amp; Co &middot; <a href="mailto:hello@curule\.dev">hello@curule\.dev<\/a><\/span>/, `${rel}: the footer`);
    // What the markup tests allow: nothing fetched from another host. The canonical link names the page itself.
    const markup = page.replace(/<link rel="canonical" href="[^"]*">/g, "");
    assert.deepEqual([...markup.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]!).filter((x) => /^(https?:)?\/\//.test(x)), [], `${rel}: the script added no reference to another host`);
  }
  const contact = read(dir, "site/contact/index.html");
  assert.match(contact, /<a data-mail="sales" href="mailto:hello@curule\.dev">hello@curule\.dev<\/a>/, "sales and support default to the contact address");
  assert.match(contact, /<a data-mail="support" href="mailto:hello@curule\.dev">hello@curule\.dev<\/a>/);
  assert.match(contact, /<a data-mail="security" href="mailto:security@curule\.dev">security@curule\.dev<\/a>/);
  assert.match(contact, /<span data-company>Curule Labs &amp; Co<\/span>/);
  const notFound = read(dir, "site/404.html");
  assert.match(notFound, /<span id="contact">Curule Labs &amp; Co &middot; <a href="mailto:hello@curule\.dev">/, "the page that is not found has the footer too");
  assert.ok(!/canonical|og:url|og:image/.test(notFound), "and no address of its own");

  const script = read(dir, "site/assets/site.js");
  assert.match(script, /^var CONTACT_HREF = "mailto:hello@curule\.dev"; \/\/ "Talk to us" and the paid plans$/m);
  assert.match(script, /^var APP_URL = "https:\/\/mesh\.curule\.dev\/"; \/\/ Where "Sign in" goes: your own dashboard$/m);
  assert.match(script, /^var DOCS_BASE = "https:\/\/github\.com\/salitaba\/agent-mesh\/blob\/main\/docs\/";$/m, "the documents stay where the site's test pins them");
  assert.match(script, /^\/\/ Where the documents are published: the repository, until a documentation site exists\.$/m);
  assert.match(script, /^var IMAGE_RELEASED = false;$/m, "and what is not the owner's to set about a domain is left alone");

  const policy = read(dir, "SECURITY.md");
  assert.ok(!policy.includes("TODO(owner)"));
  assert.match(policy, /^- Email: security@curule\.dev$/m);
  assert.match(policy, /GitHub's private vulnerability reporting: <https:\/\/github\.com\/salitaba\/agent-mesh\/security\/advisories\/new>/, "the other way to report is kept");
  assert.match(policy, /Include what you found, how to reproduce it/, "and the paragraph after the address");
  assert.match(policy, /## What to expect[\s\S]*## Supported versions/, "and every section after it");

  assert.equal(read(dir, "site/CNAME"), "curule.dev\n");
  assert.equal(read(dir, "site/robots.txt"), "User-agent: *\nAllow: /\n\nSitemap: https://curule.dev/sitemap.xml\n");
  assert.equal(
    read(dir, "site/sitemap.xml"),
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      "  <url><loc>https://curule.dev/</loc><lastmod>2026-10-03</lastmod></url>\n" +
      "  <url><loc>https://curule.dev/contact/</loc><lastmod>2026-10-03</lastmod></url>\n" +
      "  <url><loc>https://curule.dev/pricing/</loc><lastmod>2026-10-03</lastmod></url>\n" +
      "</urlset>\n",
    "the sitemap lists every page, the home page first, and not the page that is not found",
  );
  const txt = read(dir, "site/security.txt");
  assert.equal(
    txt,
    "Contact: mailto:security@curule.dev\nContact: https://github.com/salitaba/agent-mesh/security/advisories/new\nExpires: 2027-10-02T00:00:00.000Z\nPreferred-Languages: en\nCanonical: https://curule.dev/.well-known/security.txt\n",
  );
  assert.equal(read(dir, "site/.well-known/security.txt"), txt, "the same file at the path the RFC prefers");
  assert.equal(read(dir, "LICENSE"), licence, "the licence is the Licensor's, and is not touched");
});

test("a sales or support address of their own, and no sign-in link, are written where they belong", () => {
  const dir = templateRepo();
  const r = run(dir, ["curule.dev", "--contact", "hello@curule.dev", "--sales", "sales@curule.dev", "--support", "help@curule.dev", "--security", "security@curule.dev", "--app-url", "none", "--today", "2026-10-03"]);
  assert.equal(r.status, 0, r.err);
  const contact = read(dir, "site/contact/index.html");
  assert.match(contact, /<a data-mail="sales" href="mailto:sales@curule\.dev">sales@curule\.dev<\/a>/);
  assert.match(contact, /<a data-mail="support" href="mailto:help@curule\.dev">help@curule\.dev<\/a>/);
  assert.match(contact, /<span data-company>TODO\(owner\): company name<\/span>/, "without --company the company line stays marked");
  assert.match(read(dir, "site/assets/site.js"), /^var APP_URL = ""; \/\/ No hosted dashboard: the "Sign in" link is removed$/m);
  assert.match(r.out, /marker\(s\) still say TODO\(owner\)/);
});

test("a second run changes nothing, and a second domain replaces the first without leaving a trace of it", () => {
  const dir = templateRepo();
  assert.equal(run(dir, FULL).status, 0);
  const first = snapshot(dir);
  const again = run(dir, FULL);
  assert.equal(again.status, 0, again.err);
  assert.deepEqual(snapshot(dir), first, "the same arguments, the same files");
  assert.ok(!/\b(changed|created|would write)\b/.test(again.out), `nothing is reported as written: ${again.out}`);
  assert.match(again.out, /0 file\(s\) written/);

  const moved = run(dir, ["getcurule.com", "--contact", "hi@getcurule.com", "--security", "security@getcurule.com", "--company", "Curule Labs & Co", "--docs-base", "github", "--app-url", "https://mesh.getcurule.com/", "--today", "2026-10-03"]);
  assert.equal(moved.status, 0, moved.err);
  for (const [file, text] of Object.entries(snapshot(dir))) {
    if (file === "LICENSE") continue;
    assert.ok(!text.includes("curule.dev"), `${file} still says the first domain`);
  }
  for (const rel of ["site/index.html", "site/pricing/index.html", "site/contact/index.html"]) {
    const page = read(dir, rel);
    assert.equal((page.match(/<link rel="canonical"/g) ?? []).length, 1, `${rel}: one canonical link`);
    assert.equal((page.match(/<meta property="og:url"/g) ?? []).length, 1, `${rel}: one og:url`);
  }
  assert.equal(read(dir, "site/CNAME"), "getcurule.com\n");
});

test("a page added later is found, given its own address and listed in the sitemap, without a change to the script", () => {
  const dir = templateRepo();
  write(dir, "site/legal/index.html", templatePage());
  assert.equal(run(dir, FULL).status, 0);
  assert.match(read(dir, "site/legal/index.html"), /<link rel="canonical" href="https:\/\/curule\.dev\/legal\/">/);
  assert.match(read(dir, "site/sitemap.xml"), /<loc>https:\/\/curule\.dev\/legal\/<\/loc>/);
  assert.ok(!read(dir, "site/legal/index.html").includes("TODO(owner)"));
});

test("moving to a new domain without repeating --security keeps security.txt on the domain it is served from", () => {
  const dir = templateRepo();
  assert.equal(run(dir, FULL).status, 0);
  const r = run(dir, ["getcurule.com", "--contact", "hi@getcurule.com", "--today", "2026-10-03"]);
  assert.equal(r.status, 0, r.err);
  const txt = read(dir, "site/security.txt");
  assert.match(txt, /^Contact: mailto:security@curule\.dev$/m, "the address SECURITY.md already names");
  assert.match(txt, /^Canonical: https:\/\/getcurule\.com\/\.well-known\/security\.txt$/m, "at the new domain's address");
});

test("without --security SECURITY.md and security.txt are left alone; without --contact the footers are too", () => {
  const dir = templateRepo();
  const policy = read(dir, "SECURITY.md");
  const r = run(dir, ["curule.dev", "--today", "2026-10-03"]);
  assert.equal(r.status, 0, r.err);
  assert.equal(read(dir, "SECURITY.md"), policy);
  assert.ok(!fs.existsSync(path.join(dir, "site", "security.txt")), "no address to publish yet");
  for (const rel of ["site/index.html", "site/pricing/index.html", "site/404.html"]) {
    assert.match(read(dir, rel), /<span id="contact">TODO\(owner\): company name, contact email<\/span>/, rel);
  }
  assert.match(read(dir, "site/assets/site.js"), /var CONTACT_HREF = "#"; \/\/ TODO\(owner\)/);
  assert.match(read(dir, "site/assets/site.js"), /var APP_URL = "#"; \/\/ TODO\(owner\)/, "and the sign-in address, which is the owner's too");
  assert.match(r.out, /marker\(s\) still say TODO\(owner\)/, "and it says some are left");
});

test("--dry-run says what would change and writes nothing", () => {
  const dir = templateRepo();
  const before = snapshot(dir);
  const r = run(dir, [...FULL, "--dry-run"]);
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(snapshot(dir), before);
  for (const rel of ["site/index.html", "site/pricing/index.html", "site/contact/index.html", "site/404.html", "site/assets/site.js", "site/CNAME", "site/sitemap.xml", "SECURITY.md"]) {
    assert.match(r.out, new RegExp(`would write\\s+${rel.replace(/[./]/g, "\\$&")}`), rel);
  }
  assert.match(r.out, /dry run: /);
});

test("input that is not a domain or an address is refused with nothing written", () => {
  const dir = templateRepo();
  const before = snapshot(dir);
  const bad: string[][] = [
    ["https://curule.dev"],
    ["curule.dev/path"],
    ["curule"],
    ["Curule Dev.com"],
    ["curule..dev"],
    ["-curule.dev"],
    ["curule.d"],
    ["bücher.de"],
    ["curule.dev:8080"],
    ["a".repeat(64) + ".dev"],
    [Array(4).fill("a".repeat(63)).join(".") + ".com"],
    ["curule.dev", "other.dev"],
    [],
    ["curule.dev", "--contact", "hello@"],
    ["curule.dev", "--contact", 'x"@curule.dev'],
    ["curule.dev", "--contact", "a b@curule.dev"],
    ["curule.dev", "--security", "not-an-address"],
    ["curule.dev", "--sales", "not-an-address"],
    ["curule.dev", "--support", "a@b"],
    ["curule.dev", "--app-url", "http://mesh.curule.dev/"],
    ["curule.dev", "--app-url", "mesh.curule.dev"],
    ["curule.dev", "--app-url", 'https://mesh.curule.dev/"onerror='],
    ["curule.dev", "--app-url", "https://mesh.curule.dev/a b"],
    ["curule.dev", "--contact", "hello@curule.dev", "--company", "Two\nLines"],
    ["curule.dev", "--contact", "hello@curule.dev", "--company", "   "],
    ["curule.dev", "--contact", "hello@curule.dev", "--company", "x".repeat(121)],
    ["curule.dev", "--company", "Curule Labs"],
    ["curule.dev", "--docs-base", "https://docs.curule.dev/"],
    ["curule.dev", "--today", "2026-13-45"],
    ["curule.dev", "--nonsense"],
    ["curule.dev", "--contact"],
  ];
  for (const args of bad) {
    const r = run(dir, args);
    assert.equal(r.status, 2, `${JSON.stringify(args)} is refused (exit ${r.status}): ${r.out}${r.err}`);
    assert.match(r.err, /^set-domain: /, JSON.stringify(args));
    assert.deepEqual(snapshot(dir), before, `${JSON.stringify(args)} wrote something`);
  }
});

test("a name is lower-cased, and a company name with replacement syntax in it is written as it is", () => {
  const dir = templateRepo();
  const r = run(dir, ["Curule.DEV", "--contact", "hello@curule.dev", "--company", "A$&B $1 <b>", "--today", "2026-10-03"]);
  assert.equal(r.status, 0, r.err);
  assert.equal(read(dir, "site/CNAME"), "curule.dev\n");
  for (const rel of ["site/index.html", "site/pricing/index.html", "site/404.html"]) {
    assert.match(read(dir, rel), /<span id="contact">A\$&amp;B \$1 &lt;b&gt; &middot; <a href="mailto:hello@curule\.dev">/, rel);
  }
  assert.match(read(dir, "site/contact/index.html"), /<span data-company>A\$&amp;B \$1 &lt;b&gt;<\/span>/);
});

test("a company name of 120 characters is the longest the footer takes", () => {
  const dir = templateRepo();
  const r = run(dir, ["curule.dev", "--contact", "hello@curule.dev", "--company", "x".repeat(120), "--today", "2026-10-03"]);
  assert.equal(r.status, 0, r.err);
});

test("a directory that is not the repository is refused, and nothing is created in it", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "curule-domain-empty-"));
  const r = run(empty, ["curule.dev"]);
  assert.equal(r.status, 2, r.out + r.err);
  assert.match(r.err, /site\/index\.html is missing under/);
  assert.deepEqual(fs.readdirSync(empty), []);
  const c = run(empty, ["--check"]);
  assert.equal(c.status, 2, c.out + c.err);
  assert.match(c.err, /site\/index\.html is missing under/);

  const dir = templateRepo();
  fs.rmSync(path.join(dir, "SECURITY.md"));
  const before = snapshot(dir);
  const noPolicy = run(dir, FULL);
  assert.equal(noPolicy.status, 2, noPolicy.out + noPolicy.err);
  assert.match(noPolicy.err, /SECURITY\.md is missing under/);
  assert.deepEqual(snapshot(dir), before, "the pages were not changed either");

  const noScript = templateRepo();
  fs.rmSync(path.join(noScript, "site", "assets", "site.js"));
  const withoutScript = run(noScript, FULL);
  assert.equal(withoutScript.status, 2, withoutScript.out + withoutScript.err);
  assert.match(withoutScript.err, /site\/assets\/site\.js is missing under/);
});

test("a site that is not the shape the script expects is refused whole: no file is written, the message says which text is missing", () => {
  for (const [what, file, from, to] of [
    ["CONTACT_HREF", "site/assets/site.js", /var CONTACT_HREF = "[^"]*";[^\n]*\n/, ""],
    ["APP_URL", "site/assets/site.js", /var APP_URL = "[^"]*";[^\n]*\n/, ""],
    ["og:image", "site/pricing/index.html", /<meta property="og:image" content="[^"]*">\n/, ""],
    ["twitter:image", "site/contact/index.html", /<meta name="twitter:image" content="[^"]*">\n/, ""],
    ["og:type", "site/index.html", /<meta property="og:type" content="website">\n/, ""],
    ["footer contact", "site/pricing/index.html", /<span id="contact">[\s\S]*?<\/span>/, ""],
    ["footer contact", "site/404.html", /<span id="contact">[\s\S]*?<\/span>/, ""],
  ] as const) {
    const dir = templateRepo();
    const abs = path.join(dir, file);
    fs.writeFileSync(abs, fs.readFileSync(abs, "utf8").replace(from, to), "utf8");
    const before = snapshot(dir);
    const r = run(dir, FULL);
    assert.equal(r.status, 2, `${what} in ${file}: ${r.out}${r.err}`);
    assert.match(r.err, new RegExp(`${file.replace(/[./]/g, "\\$&")} .*${what.split(" ")[0]}`), `${what} in ${file}`);
    assert.deepEqual(snapshot(dir), before, `${what} in ${file}: half-applied`);
  }
  const dir = templateRepo();
  const policy = path.join(dir, "SECURITY.md");
  fs.writeFileSync(policy, fs.readFileSync(policy, "utf8").replace(/^- Email: .*\n(?:  .*\n)*/m, ""), "utf8");
  const before = snapshot(dir);
  const r = run(dir, FULL);
  assert.equal(r.status, 2, r.err);
  assert.match(r.err, /SECURITY\.md reporting address/);
  assert.deepEqual(snapshot(dir), before, "the pages were not changed either: SECURITY.md's edit failed before any write");
});

test("--check lists what is still marked, on every page, and what is not written, exits 1, and exits 0 once a domain is applied", () => {
  const dir = templateRepo();
  const before = run(dir, ["--check"]);
  assert.equal(before.status, 1);
  for (const page of ["index.html", "pricing/index.html", "contact/index.html"]) {
    assert.match(before.out, new RegExp(`site/${page.replace(/[./]/g, "\\$&")}:\\d+: .*og:image`), `${page}: its social image`);
    assert.match(before.out, new RegExp(`site/${page.replace(/[./]/g, "\\$&")}:\\d+: .*company name, contact email`), `${page}: its footer`);
  }
  assert.match(before.out, /site\/404\.html:\d+: .*company name, contact email/, "and the page that is not found");
  assert.match(before.out, /site\/contact\/index\.html:\d+: .*sales address/);
  assert.match(before.out, /site\/contact\/index\.html:\d+: .*support address/);
  assert.match(before.out, /site\/contact\/index\.html:\d+: .*security address/);
  assert.match(before.out, /site\/contact\/index\.html:\d+: .*company name/);
  assert.match(before.out, /site\/assets\/site\.js:\d+: .*CONTACT_HREF/);
  assert.match(before.out, /site\/assets\/site\.js:\d+: .*APP_URL/);
  assert.match(before.out, /site\/assets\/site\.js:\d+: .*where the documents are published/);
  assert.match(before.out, /SECURITY\.md:\d+: .*security@<your domain>/);
  for (const file of ["site/CNAME", "site/robots.txt", "site/sitemap.xml"]) assert.match(before.out, new RegExp(`${file.replace(".", "\\.")}: not written yet`), file);
  assert.match(before.out, /LICENSE's contact line still points at the repository\. It is the Licensor's to change/);
  assert.equal(run(dir, FULL).status, 0);
  const after = run(dir, ["--check"]);
  assert.equal(after.status, 0, after.out);
  assert.match(after.out, /nothing is marked TODO\(owner\), and the domain files are written/);
  assert.equal(run(dir, ["--check", "curule.dev"]).status, 2, "--check takes no domain");

  // Each file the host and the crawlers read is checked on its own: losing one is a launch with a missing piece.
  for (const file of ["site/CNAME", "site/robots.txt", "site/sitemap.xml"]) {
    assert.equal(run(dir, FULL).status, 0);
    fs.rmSync(path.join(dir, file));
    const missing = run(dir, ["--check"]);
    assert.equal(missing.status, 1, `${file}: ${missing.out}`);
    assert.match(missing.out, new RegExp(`${file.replace(".", "\\.")}: not written yet`), file);
  }
  // And a marker put back is found wherever it is: in the policy, on a page added later, in the script.
  assert.equal(run(dir, FULL).status, 0);
  const policy = path.join(dir, "SECURITY.md");
  fs.writeFileSync(policy, `${read(dir, "SECURITY.md")}\nTODO(owner): a line left behind\n`, "utf8");
  const marked = run(dir, ["--check"]);
  assert.equal(marked.status, 1, marked.out);
  assert.match(marked.out, /SECURITY\.md:\d+: TODO\(owner\): a line left behind/);
  fs.writeFileSync(policy, read(dir, "SECURITY.md").replace(/\nTODO\(owner\): a line left behind\n/, "\n"), "utf8");
  write(dir, "site/legal/index.html", `${templatePage()}<!-- TODO(owner): the terms -->\n`);
  assert.match(run(dir, ["--check"]).out, /site\/legal\/index\.html:\d+: .*the terms/);
  // The site's own README talks about the marker and is not a place that carries one.
  write(dir, "site/README.md", "Everything marked TODO(owner) is the owner's.\n");
  fs.rmSync(path.join(dir, "site", "legal"), { recursive: true });
  assert.equal(run(dir, ["--check"]).status, 0, "a README that mentions the marker is not a marker");
});
