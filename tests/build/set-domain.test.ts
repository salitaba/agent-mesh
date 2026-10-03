import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * `scripts/set-domain.mjs` applies the domain that was chosen to every place that carries it, so that they cannot disagree and
 * none is forgotten: the page's absolute social-image addresses, canonical link, contact and footer, SECURITY.md's address, and
 * the files a host and a crawler read (CNAME, robots.txt, sitemap.xml, security.txt). It must never touch LICENSE, never
 * half-apply (every edit is computed before anything is written), and be safe to run twice.
 *
 * Most cases run against a page and a policy written out below, in the state the repository ships them in before a domain is
 * chosen. Running them against the repository's own files would fail them on the day the owner applies the domain, because the
 * markers they look for would be gone. The repository's own files get one case of their own, which holds in whatever state
 * they are in: a change to the page that the script cannot follow fails there, and not the owner on the day of the launch.
 */

const ROOT = path.resolve(__dirname, "..", "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "set-domain.mjs");

/** The shapes the script finds its places in: the head's social images, the footer's contact, the page script's two variables. */
const TEMPLATE_PAGE = `<!doctype html>
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
<main><a href="#plans">Plans</a></main>
<footer>
  <div class="wrap">
    <p><b>Curule</b> &middot; <span id="contact">TODO(owner): company name, contact email</span></p>
    <p class="small"><a href="#" data-doc="operations.md">Operations</a></p>
  </div>
</footer>
<script>
"use strict";
// TODO(owner): where the documents are published. Until the commercial branch is merged to main these links 404.
var DOCS_BASE = "https://github.com/salitaba/agent-mesh/blob/main/docs/";
var CONTACT_HREF = "#"; // TODO(owner): mailto: or a contact form for "Talk to us" and the paid plans
</script>
</body>
</html>
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

function templateRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "curule-domain-"));
  fs.mkdirSync(path.join(dir, "site"), { recursive: true });
  fs.writeFileSync(path.join(dir, "site", "index.html"), TEMPLATE_PAGE, "utf8");
  fs.writeFileSync(path.join(dir, "SECURITY.md"), TEMPLATE_POLICY, "utf8");
  fs.writeFileSync(path.join(dir, "LICENSE"), TEMPLATE_LICENCE, "utf8");
  return dir;
}

/** The repository's own page, policy and licence, in whatever state they are in today. */
function realRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "curule-domain-real-"));
  fs.mkdirSync(path.join(dir, "site"), { recursive: true });
  for (const file of ["site/index.html", "SECURITY.md", "LICENSE"]) fs.copyFileSync(path.join(ROOT, file), path.join(dir, file));
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

const FULL = ["curule.dev", "--contact", "hello@curule.dev", "--security", "security@curule.dev", "--company", "Curule Labs & Co", "--docs-base", "github", "--today", "2026-10-03"];

test("a domain with its addresses fills every marker and writes the files a host and a crawler read", () => {
  const dir = templateRepo();
  const licence = fs.readFileSync(path.join(dir, "LICENSE"), "utf8");
  const r = run(dir, FULL);
  assert.equal(r.status, 0, r.err);
  const page = fs.readFileSync(path.join(dir, "site", "index.html"), "utf8");
  assert.ok(!page.includes("TODO(owner)"), "nothing on the page is left to fill");
  assert.match(page, /<link rel="canonical" href="https:\/\/curule\.dev\/">\n<meta property="og:url" content="https:\/\/curule\.dev\/">/);
  assert.match(page, /<meta property="og:type" content="website">\n<link rel="canonical"/, "after og:type, which is kept");
  assert.match(page, /<meta property="og:image" content="https:\/\/curule\.dev\/assets\/social-card\.png">/);
  assert.match(page, /<meta name="twitter:image" content="https:\/\/curule\.dev\/assets\/social-card\.png">/);
  assert.match(page, /var CONTACT_HREF = "mailto:hello@curule\.dev";/);
  assert.match(page, /<span id="contact">Curule Labs &amp; Co &middot; <a href="mailto:hello@curule\.dev">hello@curule\.dev<\/a><\/span>/);
  assert.match(page, /var DOCS_BASE = "https:\/\/github\.com\/salitaba\/agent-mesh\/blob\/main\/docs\/";/, "the documents stay where the page's test pins them");
  const policy = fs.readFileSync(path.join(dir, "SECURITY.md"), "utf8");
  assert.ok(!policy.includes("TODO(owner)"));
  assert.match(policy, /^- Email: security@curule\.dev$/m);
  assert.match(policy, /GitHub's private vulnerability reporting: <https:\/\/github\.com\/salitaba\/agent-mesh\/security\/advisories\/new>/, "the other way to report is kept");
  assert.match(policy, /Include what you found, how to reproduce it/, "and the paragraph after the address");
  assert.match(policy, /## What to expect[\s\S]*## Supported versions/, "and every section after it");
  // What the page's own test allows: nothing fetched from another host. The canonical link names the page itself.
  const markup = page.replace(/<script[\s\S]*?<\/script>/g, "");
  const refs = [...markup.replace(/<link rel="canonical" href="[^"]*">/g, "").matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]!);
  assert.deepEqual(refs.filter((r) => /^(https?:)?\/\//.test(r)), [], "the script added no reference to another host");
  assert.equal(fs.readFileSync(path.join(dir, "site", "CNAME"), "utf8"), "curule.dev\n");
  assert.equal(fs.readFileSync(path.join(dir, "site", "robots.txt"), "utf8"), "User-agent: *\nAllow: /\n\nSitemap: https://curule.dev/sitemap.xml\n");
  assert.equal(
    fs.readFileSync(path.join(dir, "site", "sitemap.xml"), "utf8"),
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>https://curule.dev/</loc><lastmod>2026-10-03</lastmod></url>\n</urlset>\n',
  );
  const txt = fs.readFileSync(path.join(dir, "site", "security.txt"), "utf8");
  assert.equal(
    txt,
    "Contact: mailto:security@curule.dev\nContact: https://github.com/salitaba/agent-mesh/security/advisories/new\nExpires: 2027-10-02T00:00:00.000Z\nPreferred-Languages: en\nCanonical: https://curule.dev/.well-known/security.txt\n",
  );
  assert.equal(fs.readFileSync(path.join(dir, "site", ".well-known", "security.txt"), "utf8"), txt, "the same file at the path the RFC prefers");
  assert.equal(fs.readFileSync(path.join(dir, "LICENSE"), "utf8"), licence, "the licence is the Licensor's, and is not touched");
});

test("the repository's own page and policy take a domain cleanly, in whatever state they are in", () => {
  // The cases around this one use a page written out above, so that they keep holding after the domain is applied. This is the
  // one that follows the real files: a change to the page or the policy that the script cannot follow fails here.
  const dir = realRepo();
  const r = run(dir, FULL);
  assert.equal(r.status, 0, r.err);
  const page = fs.readFileSync(path.join(dir, "site", "index.html"), "utf8");
  const policy = fs.readFileSync(path.join(dir, "SECURITY.md"), "utf8");
  assert.ok(!page.includes("TODO(owner)"), "nothing on the page is left to fill");
  assert.ok(!policy.includes("TODO(owner)"), "nor in the policy");
  assert.equal((page.match(/<link rel="canonical"/g) ?? []).length, 1, "one canonical link");
  assert.equal((page.match(/<meta property="og:url"/g) ?? []).length, 1, "one og:url");
  assert.match(page, /<meta property="og:image" content="https:\/\/curule\.dev\/assets\/social-card\.png">/);
  assert.match(policy, /^- Email: security@curule\.dev$/m);
  const first = snapshot(dir);
  assert.equal(run(dir, FULL).status, 0);
  assert.deepEqual(snapshot(dir), first, "and a second run changes nothing");
  const checked = run(dir, ["--check"]);
  assert.equal(checked.status, 0, checked.out);
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

  const moved = run(dir, ["getcurule.com", "--contact", "hi@getcurule.com", "--security", "security@getcurule.com", "--company", "Curule Labs & Co", "--docs-base", "github", "--today", "2026-10-03"]);
  assert.equal(moved.status, 0, moved.err);
  for (const [file, text] of Object.entries(snapshot(dir))) {
    if (file === "LICENSE") continue;
    assert.ok(!text.includes("curule.dev"), `${file} still says the first domain`);
  }
  const page = fs.readFileSync(path.join(dir, "site", "index.html"), "utf8");
  assert.equal((page.match(/<link rel="canonical"/g) ?? []).length, 1, "one canonical link");
  assert.equal((page.match(/<meta property="og:url"/g) ?? []).length, 1, "one og:url");
  assert.equal(fs.readFileSync(path.join(dir, "site", "CNAME"), "utf8"), "getcurule.com\n");
});

test("moving to a new domain without repeating --security keeps security.txt on the domain it is served from", () => {
  const dir = templateRepo();
  assert.equal(run(dir, FULL).status, 0);
  const r = run(dir, ["getcurule.com", "--contact", "hi@getcurule.com", "--today", "2026-10-03"]);
  assert.equal(r.status, 0, r.err);
  const txt = fs.readFileSync(path.join(dir, "site", "security.txt"), "utf8");
  assert.match(txt, /^Contact: mailto:security@curule\.dev$/m, "the address SECURITY.md already names");
  assert.match(txt, /^Canonical: https:\/\/getcurule\.com\/\.well-known\/security\.txt$/m, "at the new domain's address");
});

test("without --security SECURITY.md and security.txt are left alone; without --contact the footer is too", () => {
  const dir = templateRepo();
  const policy = fs.readFileSync(path.join(dir, "SECURITY.md"), "utf8");
  const r = run(dir, ["curule.dev", "--today", "2026-10-03"]);
  assert.equal(r.status, 0, r.err);
  assert.equal(fs.readFileSync(path.join(dir, "SECURITY.md"), "utf8"), policy);
  assert.ok(!fs.existsSync(path.join(dir, "site", "security.txt")), "no address to publish yet");
  const page = fs.readFileSync(path.join(dir, "site", "index.html"), "utf8");
  assert.match(page, /<span id="contact">TODO\(owner\): company name, contact email<\/span>/);
  assert.match(page, /var CONTACT_HREF = "#"; \/\/ TODO\(owner\)/);
  assert.match(r.out, /marker\(s\) still say TODO\(owner\)/, "and it says some are left");
});

test("--dry-run says what would change and writes nothing", () => {
  const dir = templateRepo();
  const before = snapshot(dir);
  const r = run(dir, [...FULL, "--dry-run"]);
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(snapshot(dir), before);
  assert.match(r.out, /would write\s+site\/index\.html/);
  assert.match(r.out, /would write\s+site\/CNAME/);
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
  assert.equal(fs.readFileSync(path.join(dir, "site", "CNAME"), "utf8"), "curule.dev\n");
  assert.match(fs.readFileSync(path.join(dir, "site", "index.html"), "utf8"), /<span id="contact">A\$&amp;B \$1 &lt;b&gt; &middot; <a href="mailto:hello@curule\.dev">/);
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
  assert.deepEqual(snapshot(dir), before, "the page was not changed either");
});

test("a page that is not the shape the script expects is refused whole: no file is written, the message says which text is missing", () => {
  for (const [what, from, to] of [
    ["CONTACT_HREF", /var CONTACT_HREF = "[^"]*";[^\n]*\n/, ""],
    ["og:image", /<meta property="og:image" content="[^"]*">\n/, ""],
    ["footer contact", /<span id="contact">[\s\S]*?<\/span>/, ""],
  ] as const) {
    const dir = templateRepo();
    const file = path.join(dir, "site", "index.html");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(from, to), "utf8");
    const before = snapshot(dir);
    const r = run(dir, FULL);
    assert.equal(r.status, 2, `${what}: ${r.out}${r.err}`);
    assert.match(r.err, new RegExp(`site/index\\.html .*${what.split(" ")[0]}`), what);
    assert.deepEqual(snapshot(dir), before, `${what}: half-applied`);
  }
  const dir = templateRepo();
  const policy = path.join(dir, "SECURITY.md");
  fs.writeFileSync(policy, fs.readFileSync(policy, "utf8").replace(/^- Email: .*\n(?:  .*\n)*/m, ""), "utf8");
  const before = snapshot(dir);
  const r = run(dir, FULL);
  assert.equal(r.status, 2, r.err);
  assert.match(r.err, /SECURITY\.md reporting address/);
  assert.deepEqual(snapshot(dir), before, "the page was not changed either: SECURITY.md's edit failed before any write");
});

test("--check lists what is still marked and what is not written, exits 1, and exits 0 once a domain is applied", () => {
  const dir = templateRepo();
  const before = run(dir, ["--check"]);
  assert.equal(before.status, 1);
  assert.match(before.out, /site\/index\.html:\d+: .*og:image/);
  assert.match(before.out, /site\/index\.html:\d+: .*company name, contact email/);
  assert.match(before.out, /site\/index\.html:\d+: .*CONTACT_HREF/);
  assert.match(before.out, /site\/index\.html:\d+: .*where the documents are published/);
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
  // And a marker put back into the policy is found there, not only on the page.
  assert.equal(run(dir, FULL).status, 0);
  const policy = path.join(dir, "SECURITY.md");
  fs.writeFileSync(policy, `${fs.readFileSync(policy, "utf8")}\nTODO(owner): a line left behind\n`, "utf8");
  const marked = run(dir, ["--check"]);
  assert.equal(marked.status, 1, marked.out);
  assert.match(marked.out, /SECURITY\.md:\d+: TODO\(owner\): a line left behind/);
});
