/**
 * The site makes promises (nothing is loaded from a third party, nothing is stored, every page reads without a script) and
 * links to things (screenshots, the documents, its other pages). Each is pinned to what the repository really contains, for
 * every page that is in `site/`, so the site cannot quietly go stale or start loading something from somewhere else.
 *
 * This file is the structure: files, requests, scripts, images, addresses, headings. What the pages say (the plans, the
 * measured mission, what is planned and what is not, the voice) is in site-copy.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { ROOT, SITE, headingAnchors, imageSize, page, shareable, sitePages, walk, type Page } from "./site-pages";

const pages = sitePages();
const files = walk(SITE);
const scriptFiles = files.filter((f) => f.endsWith(".js"));
const cssFiles = files.filter((f) => f.endsWith(".css"));

/** Where a page's own address would resolve links from. */
const base = (p: Page): string => `http://site.test/${p.rel}`;

/** `css` without the block that starts at `opening` (the braces are counted, so a block inside it goes too). */
function withoutBlock(css: string, opening: string): string {
  const start = css.indexOf(opening);
  if (start < 0) return css;
  let depth = 0;
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(0, start) + css.slice(i + 1);
  }
  return css.slice(0, start);
}

/** Every address a page's markup points at: src, href, action and the list in srcset. The canonical link names the page itself. */
function references(p: Page): string[] {
  // Comments and the inside of scripts are not markup a browser follows; a script's own src is.
  const markup = p.html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/g, "$1$2")
    .replace(/<link rel="canonical" href="[^"]*">/g, "");
  const out = [...markup.matchAll(/\b(?:src|href|action|poster)="([^"]*)"/g)].map((m) => m[1]!);
  for (const m of markup.matchAll(/\bsrcset="([^"]*)"/g)) out.push(...m[1]!.split(",").map((c) => c.trim().split(/\s+/)[0]!).filter(Boolean));
  return out;
}

/** The file below site/ that an address names, or null when it is not a file or folder of the site. */
function fileOf(address: string, from: Page): string | null {
  const url = new URL(address, base(from));
  if (url.host !== "site.test") return null;
  let rel = decodeURIComponent(url.pathname).replace(/^\//, "");
  if (rel === "" || rel.endsWith("/")) rel += "index.html";
  const abs = path.join(SITE, rel);
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return fs.existsSync(path.join(abs, "index.html")) ? `${rel}/index.html` : null;
  return fs.existsSync(abs) ? rel : null;
}

test("the pages are the ones the navigation, the footer and the sitemap promise, and every other page is reachable from the home page", () => {
  const rels = pages.map((p) => p.rel);
  for (const must of ["index.html", "pricing/index.html", "docs/index.html", "security/index.html", "contact/index.html", "legal/index.html", "404.html"]) {
    assert.ok(rels.includes(must), `site/${must} is missing`);
  }
  const home = page(pages, "index.html");
  for (const p of shareable(pages).filter((q) => q.rel !== "index.html")) {
    const linked = references(home).some((ref) => fileOf(ref, home) === p.rel);
    assert.ok(linked, `${p.rel} is not linked from the home page`);
  }
});

test("every file a page references exists, and nothing is loaded from another host", () => {
  const missing: string[] = [];
  const external: string[] = [];
  let checked = 0;
  for (const p of pages) {
    for (const ref of references(p)) {
      if (ref.startsWith("#") || ref.startsWith("data:") || ref.startsWith("mailto:")) continue;
      checked++;
      if (/^(https?:)?\/\//i.test(ref) || /^[a-z][a-z0-9+.-]*:/i.test(ref)) {
        external.push(`${p.rel}: ${ref}`);
        continue;
      }
      // The page shown for an address that does not exist is served at that address, at any depth, so only it names its
      // files from the root of the site. Every other page uses relative addresses, which work under any folder of any host.
      if (ref.startsWith("/")) {
        if (p.rel !== "404.html") missing.push(`${p.rel}: ${ref} (only 404.html may start at the root)`);
      } else if (p.rel === "404.html") {
        missing.push(`${p.rel}: ${ref} (404.html is shown at any depth, so its addresses start at the root)`);
      }
      if (!fileOf(ref, p)) missing.push(`${p.rel}: ${ref}`);
    }
    // Hosts that serve a folder's index.html do so for the folder's own address; a link to the file would work only by accident.
    assert.ok(!/\bhref="[^"#]*index\.html/.test(p.markup), `${p.rel} links to an index.html file instead of its folder`);
  }
  assert.ok(checked > 100, `the pages have addresses to check (${checked})`);
  assert.deepEqual(missing, []);
  // The only absolute addresses in the markup would be a fetch from a third party (fonts, analytics, scripts, images), which
  // is what lets the site say that it has no cookie banner. The documents and the source are linked by the shared script.
  assert.deepEqual(external, []);
  for (const p of pages) {
    assert.ok(!/<script\b[^>]*\ssrc\s*=\s*["']?(https?:)?\/\//i.test(p.html), `${p.rel}: no external scripts`);
    assert.ok(!/<link\b[^>]*rel="?(stylesheet|preload|prefetch|preconnect|dns-prefetch|modulepreload)[^>]*href="(https?:)?\/\//i.test(p.html), `${p.rel}: no external links of any kind`);
    assert.ok(!/<(iframe|embed|object|frame|form)\b/i.test(p.markup.replace(/<form id="calc"[^>]*>[\s\S]*?<\/form>/, "")), `${p.rel}: nothing embedded, no form that sends anything`);
  }
  for (const f of cssFiles) {
    const css = fs.readFileSync(path.join(SITE, f), "utf8");
    assert.ok(!/@import|url\(\s*["']?(https?:)?\/\//i.test(css), `${f}: no remote CSS`);
    assert.ok(!/@font-face/.test(css), `${f}: no font is downloaded`);
  }
});

test("every address with a #fragment names an element that is there", () => {
  const problems: string[] = [];
  for (const p of pages) {
    for (const m of p.markup.matchAll(/\bhref="([^"]*)#([^"]+)"/g)) {
      const [, address, fragment] = m as unknown as [string, string, string];
      if (address.startsWith("mailto:")) continue;
      const target = address === "" ? p : pages.find((q) => q.rel === fileOf(address, p));
      if (!target) continue; // a file that is missing is reported by the test above
      if (!new RegExp(`\\sid="${fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(target.html)) problems.push(`${p.rel}: ${address}#${fragment} (no id="${fragment}" in ${target.rel})`);
    }
  }
  assert.deepEqual(problems, []);
});

test("the scripts make no network call, store nothing, and no page runs a script of its own", () => {
  assert.ok(scriptFiles.length >= 2, "the shared script and the pricing script are there");
  const banned = ["fetch(", "XMLHttpRequest", "sendBeacon", "WebSocket", "EventSource", "import(", "importScripts", "document.cookie", "localStorage", "sessionStorage", "indexedDB", "eval(", "new Function", "document.write", "navigator.geolocation"];
  const code = new Map<string, string>(scriptFiles.map((f) => [f, fs.readFileSync(path.join(SITE, f), "utf8")]));
  for (const p of pages) {
    for (const m of p.html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      const attrs = m[1]!;
      if (/\bsrc="[^"]+"/.test(attrs)) {
        assert.match(attrs, /\bdefer\b/, `${p.rel}: a script loads after the page is read`);
        continue;
      }
      assert.match(attrs, /type="application\/json"/, `${p.rel}: an inline script would need 'unsafe-inline' in the content security policy`);
    }
  }
  for (const [file, text] of code) {
    for (const call of banned) assert.ok(!text.includes(call), `${file} does not use ${call}`);
    assert.ok(text.startsWith('"use strict";'), `${file} is strict`);
  }
  assert.ok(code.get("assets/site.js")!.includes("navigator.clipboard.writeText"), "the copy buttons write to the clipboard");
  // The clipboard is touched only inside a click handler, the one place a browser lets a page do it.
  const site = code.get("assets/site.js")!;
  const writes = [...site.matchAll(/navigator\.clipboard\.writeText\(/g)].length;
  assert.equal(writes, 1);
  assert.ok(/addEventListener\("click", function \(\) \{\s*navigator\.clipboard\.writeText/.test(site), "and only from a click");
});

test("every page tells the browser to load nothing from anywhere else, and carries no inline style or handler", () => {
  const policy = "default-src 'none'; img-src 'self'; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'none'";
  for (const p of pages) {
    const found = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(p.html)?.[1];
    assert.equal(found, policy, `${p.rel}: content security policy`);
    assert.ok(!/unsafe-inline|unsafe-eval|\*|https?:/.test(found!), `${p.rel}: the policy allows only the site's own files`);
    assert.ok(!/<style\b/i.test(p.markup), `${p.rel}: no <style> element (the policy would block it)`);
    assert.ok(!/\sstyle="/i.test(p.markup), `${p.rel}: no style attribute (the policy would block it)`);
    assert.ok(!/\son[a-z]+="/i.test(p.markup), `${p.rel}: no inline event handler`);
    assert.ok(!/\bjavascript:/i.test(p.markup), `${p.rel}: no javascript: address`);
  }
});

test("the colour scheme follows the visitor's setting and nothing is remembered: no theme switch, no stored choice", () => {
  for (const f of [...files.filter((x) => /\.(html|css|js)$/.test(x))]) {
    const text = fs.readFileSync(path.join(SITE, f), "utf8");
    assert.ok(!/data-theme|prefers-color-scheme:\s*no-preference/.test(text), `${f}: no theme attribute`);
  }
  for (const f of cssFiles) {
    const css = fs.readFileSync(path.join(SITE, f), "utf8");
    assert.match(css, /@media \(prefers-color-scheme: dark\)/, `${f} follows the visitor's setting`);
    assert.match(css, /@media \(prefers-reduced-motion: no-preference\)/, `${f}: motion only for a visitor who has not asked for less`);
    const outside = withoutBlock(css, "@media (prefers-reduced-motion: no-preference)");
    assert.ok(!/\btransition\s*:|\banimation\s*:|@keyframes|scroll-behavior\s*:\s*smooth/.test(outside), `${f}: nothing moves outside the block for a visitor who has not asked for less`);
    // Type: the system's own fonts, in the brand's two stacks, and nothing else.
    assert.ok(css.includes('--font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;'), `${f}: the brand's text stack`);
    assert.ok(css.includes("--mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;"), `${f}: the brand's code stack`);
  }
  for (const p of pages) {
    assert.ok(p.html.includes('<link rel="stylesheet" href="' + (p.rel === "404.html" ? "/" : p.rel.includes("/") ? "../" : "") + 'assets/site.css">'), `${p.rel} uses the shared stylesheet`);
    assert.equal((p.markup.match(/<link rel="stylesheet"/g) ?? []).length, 1, `${p.rel}: one stylesheet`);
  }
});

test("images carry alternative text and their real size, and every shot is used and light enough", () => {
  const used = new Set<string>();
  let images = 0;
  for (const p of pages) {
    for (const tag of p.markup.matchAll(/<img\b[^>]*>/g)) {
      images++;
      const t = tag[0];
      assert.match(t, /\salt="[^"]{20,}"/, `${p.rel}: alt text of at least 20 characters: ${t.slice(0, 90)}`);
      const w = /\swidth="(\d+)"/.exec(t)?.[1];
      const h = /\sheight="(\d+)"/.exec(t)?.[1];
      assert.ok(w && h, `${p.rel}: width and height: ${t.slice(0, 90)}`);
      const src = /\ssrc="([^"]+)"/.exec(t)![1]!;
      const file = fileOf(src, p);
      assert.ok(file, `${p.rel}: ${src} exists`);
      const real = imageSize(path.join(SITE, file!));
      assert.deepEqual({ width: Number(w), height: Number(h) }, real, `${p.rel}: ${src} is ${real.width} x ${real.height}, and the page says so (a wrong size shifts the layout or squeezes the picture)`);
      used.add(file!);
    }
    for (const m of p.markup.matchAll(/<source\b[^>]*srcset="([^"]+)"/g)) {
      const file = fileOf(m[1]!, p);
      assert.ok(file, `${p.rel}: ${m[1]} exists`);
      used.add(file!);
    }
  }
  assert.ok(images >= 10, `the pages show the product (${images} images)`);
  const shots = files.filter((f) => f.startsWith("assets/shots/"));
  assert.ok(shots.length >= 10);
  for (const f of shots) {
    assert.match(path.basename(f), /^shot-[a-z-]+\.(jpg|png)$/, `${f}: a stable name, so the picture can be swapped without touching a page`);
    assert.ok(fs.statSync(path.join(SITE, f)).size < 250_000, `${f} stays under 250 KB`);
    assert.ok(used.has(f), `${f} is used by no page`);
  }
  // Each pair of a light and a dark capture is the same size, or the page would jump when the visitor's scheme changes.
  for (const f of shots.filter((x) => x.endsWith("-light.jpg"))) {
    assert.deepEqual(imageSize(path.join(SITE, f)), imageSize(path.join(SITE, f.replace("-light.jpg", "-dark.jpg"))), `${f} and its dark twin are the same size`);
  }
  // The pictures that stand for the social card are the brand's, and a link preview is light.
  assert.ok(fs.statSync(path.join(SITE, "assets", "social-card.png")).size < 200_000);
});

test("every page declares its language, viewport, title and description, and the pages with an address carry the social metas", () => {
  for (const p of pages) {
    assert.match(p.html, /<html lang="en">/, p.rel);
    assert.match(p.html, /<meta name="viewport" content="width=device-width, initial-scale=1">/, p.rel);
    assert.match(p.html, /<title>[^<]{10,}<\/title>/, p.rel);
    assert.match(p.html, /<meta name="description" content="[^"]{40,}"/, p.rel);
    assert.match(p.html, /<meta name="theme-color" content="#fbfaf8" media="\(prefers-color-scheme: light\)">/, `${p.rel}: the paper colour`);
    assert.match(p.html, /<meta name="theme-color" content="#131211" media="\(prefers-color-scheme: dark\)">/, `${p.rel}: the dark colour`);
  }
  const titles = pages.map((p) => /<title>([^<]+)<\/title>/.exec(p.html)![1]);
  assert.equal(new Set(titles).size, titles.length, "no two pages share a title");
  const descriptions = pages.map((p) => /<meta name="description" content="([^"]+)"/.exec(p.html)![1]);
  assert.equal(new Set(descriptions).size, descriptions.length, "or a description");
  for (const p of shareable(pages)) {
    assert.match(p.html, /<meta property="og:title" content="[^"]{10,}">/, p.rel);
    assert.match(p.html, /<meta property="og:description" content="[^"]{40,}">/, p.rel);
    assert.match(p.html, /<meta property="og:type" content="website">/, p.rel);
    assert.match(p.html, /<meta property="og:image:width" content="1200">/, `${p.rel}: the card is 1200 wide`);
    assert.match(p.html, /<meta property="og:image:height" content="630">/, `${p.rel}: and 630 tall`);
    assert.match(p.html, /<meta name="twitter:card" content="summary_large_image">/, p.rel);
  }
  const notFound = page(pages, "404.html");
  assert.match(notFound.html, /<meta name="robots" content="noindex">/, "a page that is not found is not for a search engine");
  assert.ok(!/rel="canonical"|og:url|og:image/.test(notFound.html), "and it has no address of its own to name");
});

test("once the site names its own address, every canonical link, og:url, social image, the sitemap and the CNAME agree", () => {
  const cname = path.join(SITE, "CNAME");
  const withCanonical = shareable(pages).filter((p) => /<link rel="canonical" href="[^"]+">/.test(p.html));
  if (withCanonical.length === 0) {
    // The template: the domain is not chosen, so the markers are still there for `scripts/set-domain.mjs` to fill.
    for (const p of shareable(pages)) assert.match(p.html, /TODO\(owner\)/, `${p.rel}: an unset page says what is left to do`);
    assert.ok(!fs.existsSync(cname), "a CNAME without a canonical link is a half-applied domain");
    assert.ok(!fs.existsSync(path.join(SITE, "sitemap.xml")) && !fs.existsSync(path.join(SITE, "robots.txt")), "and so are a sitemap and a robots.txt");
    return;
  }
  assert.equal(withCanonical.length, shareable(pages).length, "a domain is applied to every page or to none");
  const origins = new Set<string>();
  for (const p of shareable(pages)) {
    const canonical = /<link rel="canonical" href="([^"]+)">/.exec(p.html)![1]!;
    assert.match(canonical, /^https:\/\/[a-z0-9.-]+\/(?:[a-z0-9-]+\/)?$/, `${p.rel}: the canonical address is the page's own, over https`);
    const origin = new URL(canonical).origin + "/";
    origins.add(origin);
    assert.equal(canonical, `${origin}${p.address}`, `${p.rel}: the canonical address is this page's`);
    assert.equal(/<meta property="og:url" content="([^"]+)">/.exec(p.html)?.[1], canonical, `${p.rel}: og:url`);
    for (const re of [/<meta property="og:image" content="([^"]+)">/, /<meta name="twitter:image" content="([^"]+)">/]) {
      assert.equal(re.exec(p.html)?.[1], `${origin}assets/social-card.png`, `${p.rel}: a link preview needs an absolute address on the same origin`);
    }
  }
  assert.equal(origins.size, 1, "one origin for the whole site");
  const origin = [...origins][0]!;
  assert.equal(fs.readFileSync(cname, "utf8").trim(), new URL(origin).host, "the CNAME is the canonical host");
  const sitemap = fs.readFileSync(path.join(SITE, "sitemap.xml"), "utf8");
  assert.deepEqual([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]), shareable(pages).map((p) => `${origin}${p.address}`), "the sitemap lists every page, and not the one that is not found");
  assert.match(fs.readFileSync(path.join(SITE, "robots.txt"), "utf8"), new RegExp(`Sitemap: ${origin.replace(/[./]/g, "\\$&")}sitemap\\.xml`));
  // What is still marked TODO(owner) is the publish workflow's concern (`npm run site:check`), not a reason for CI to fail.
});

test("each page has one h1 and headings that never skip a level, one main landmark, a skip link, and its header and footer", () => {
  for (const p of pages) {
    const headings = [...p.markup.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
    assert.equal(headings.filter((n) => n === 1).length, 1, `${p.rel}: one h1`);
    assert.equal(headings[0], 1, `${p.rel}: the h1 comes first`);
    headings.forEach((level, i) => {
      if (i > 0) assert.ok(level <= headings[i - 1]! + 1, `${p.rel}: an h${level} follows an h${headings[i - 1]}`);
    });
    assert.equal((p.markup.match(/<main\b/g) ?? []).length, 1, `${p.rel}: one main landmark`);
    assert.match(p.markup, /<body>\s*<a class="skip" href="#main">Skip to the content<\/a>/, `${p.rel}: the skip link is the first thing a keyboard reaches`);
    assert.match(p.markup, /<main id="main" tabindex="-1">/, `${p.rel}: the skip link has somewhere to land`);
    assert.equal((p.markup.match(/<header class="site-header">/g) ?? []).length, 1, `${p.rel}: one header`);
    assert.equal((p.markup.match(/<footer class="site-footer">/g) ?? []).length, 1, `${p.rel}: one footer`);
    assert.ok(!/tabindex="[1-9]/.test(p.markup), `${p.rel}: no tab order of its own`);
  }
});

test("every link and every control has a name a screen reader can say, and every field has a label", () => {
  for (const p of pages) {
    for (const m of p.markup.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
      const name = m[2]!.replace(/<[^>]+>/g, "").trim() || /aria-label="([^"]+)"/.exec(m[1]!)?.[1];
      assert.ok(name, `${p.rel}: a link with no text: ${m[0].slice(0, 100)}`);
    }
    for (const m of p.markup.matchAll(/<(input|select)\b([^>]*)>/g)) {
      const id = /\sid="([^"]+)"/.exec(m[2]!)?.[1];
      assert.ok(id && new RegExp(`<label[^>]*for="${id}"`).test(p.markup), `${p.rel}: <${m[1]} id="${id}"> has a label`);
    }
    assert.ok(!/target="_blank"/.test(p.markup), `${p.rel}: no link opens a new window behind the visitor's back`);
    // A script-assigned link that has no script has to go somewhere that exists: the page that lists the same thing.
    for (const m of p.markup.matchAll(/<a\b[^>]*\bdata-(?:doc|repo)="[^"]*"[^>]*>/g)) {
      assert.ok(!/\shref="#"/.test(m[0]), `${p.rel}: a link the script sets needs a place to go without it: ${m[0].slice(0, 100)}`);
    }
  }
});

test("the documents the pages link to exist, at the base the shared script sets", () => {
  const script = fs.readFileSync(path.join(SITE, "assets", "site.js"), "utf8");
  assert.match(script, /var DOCS_BASE = "https:\/\/github\.com\/salitaba\/agent-mesh\/blob\/main\/docs\/";/, "the base the links resolve against");
  assert.match(script, /var REPO_URL = "https:\/\/github\.com\/salitaba\/agent-mesh";/, "and the repository");
  const targets = new Set<string>();
  for (const p of pages) for (const m of p.markup.matchAll(/data-doc="([^"]+)"/g)) targets.add(m[1]!);
  assert.ok(targets.size >= 15, `the pages link to the documents (${targets.size})`);
  for (const t of targets) {
    const [file, fragment] = t.split("#") as [string, string | undefined];
    const abs = path.join(ROOT, "docs", file);
    assert.ok(fs.existsSync(abs), `docs/${file}`);
    if (fragment) assert.ok(headingAnchors(abs).has(fragment), `docs/${file} has a heading '#${fragment}'`);
  }
  const repoPaths = new Set<string>();
  for (const p of pages) for (const m of p.markup.matchAll(/data-repo="([^"]*)"/g)) repoPaths.add(m[1]!);
  assert.ok([...repoPaths].every((x) => x === "" || x === "issues"), "the only repository pages linked are its front page and its issues");
});

test("the script's constants are the shape set-domain and the publish gate expect", () => {
  const script = fs.readFileSync(path.join(SITE, "assets", "site.js"), "utf8");
  for (const name of ["DOCS_BASE", "REPO_URL", "APP_URL", "CLOUD_URL", "CONTACT_HREF", "IMAGE_RELEASED", "IMAGE_NAME"]) {
    assert.equal((script.match(new RegExp(`^var ${name} = `, "gm")) ?? []).length, 1, `${name} is defined once, at the start of a line`);
  }
  assert.match(script, /^var APP_URL = "[^"]*";/m);
  assert.match(script, /^var CLOUD_URL = "(https:\/\/[^"\s]+)?";/m, "Curule Cloud's address is empty, or an https address");
  assert.match(script, /^var CONTACT_HREF = "[^"]*";/m);
  assert.match(script, /^var IMAGE_RELEASED = (true|false);/m);
  // The image path is for after the first release: while it is off, no page can tell a visitor to pull what is not there.
  const released = /^var IMAGE_RELEASED = (true|false);/m.exec(script)![1] === "true";
  const name = /^var IMAGE_NAME = "([^"]+)";/m.exec(script)![1]!;
  if (!released) for (const p of pages) assert.ok(!p.html.includes(name) && !p.html.includes("ghcr.io"), `${p.rel} names an image that is not published`);
  const release = fs.readFileSync(path.join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  assert.ok(release.includes("tags: [\"v*\"]"), "the image is published by a version tag");
  assert.equal(name, "ghcr.io/salitaba/curule", "the name the release publishes (docs/commercial/deployment.md says the same)");
});

test("a table or a command that goes on past its box shows a shadow at the edge while there is more, and a table keeps its corner", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  // The cover is attached to the content and the shadow to the box, so the shadow shows only while there is more to scroll to,
  // and goes at the end, with no script; on a page where everything fits the cover sits on it from the start.
  for (const [rule, cover] of [[".table-wrap", "var(--panel)"], [".code pre", "var(--code)"]] as const) {
    const body = new RegExp(`\\n${rule.replace(/\./g, "\\.")} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
    assert.match(body, /overflow-x: auto;/, `${rule} scrolls sideways`);
    assert.ok(body.includes(`linear-gradient(to left, ${cover} 30%, transparent) right / 48px 100% no-repeat local`), `${rule}: the cover goes with the content`);
    assert.ok(body.includes("linear-gradient(to left, var(--edge), transparent) right / 12px 100% no-repeat scroll"), `${rule}: the shadow stays with the box`);
  }
  // Every table and every block of commands is in one of those boxes.
  for (const p of pages) {
    assert.equal((p.markup.match(/<table\b/g) ?? []).length, (p.markup.match(/<div class="table-wrap"[^>]*>\s*<table\b/g) ?? []).length, `${p.rel}: a table is in a .table-wrap`);
    assert.equal((p.markup.match(/<pre\b/g) ?? []).length, (p.markup.match(/<div class="code"><pre\b/g) ?? []).length, `${p.rel}: commands are in a .code box`);
  }
  // On a phone the table scrolls under its first column: the corner goes with the column, so the plans' names do not show through.
  assert.match(css, /\n\.compare thead th:first-child \{ position: sticky; left: 0; z-index: 2; \}/);
  assert.match(css, /\n\.compare tbody th \{[^}]*position: sticky; left: 0;/);
  const pricing = page(pages, "pricing/index.html").markup;
  for (const m of pricing.matchAll(/<table class="compare">[\s\S]*?<\/table>/g)) {
    assert.match(m[0], /<thead><tr><th scope="col">/, "the corner is a header cell, which the stylesheet keeps with the first column");
    for (const row of m[0].matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)) for (const tr of row[1]!.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) assert.match(tr[1]!, /^<th scope="row">/, "every row starts with its own header, the column that stays");
  }
});

test("a card that a link points at is marked once the link is followed, by a second line and not by colour alone", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  const kinds = ["card", "doc-card", "plan"];
  assert.match(css, /\n\.card:target, \.doc-card:target, \.plan:target \{ border-color: var\(--accent\); box-shadow: inset 0 0 0 1px var\(--accent\); \}/, "inside the border: the card does not move");
  assert.match(/@media \(forced-colors: active\) \{[\s\S]*?\n\}/.exec(css)![0], /\.card:target, \.doc-card:target, \.plan:target \{ outline: 2px solid Highlight;/, "a forced-colour mode drops the shadow; an outline stays");
  // The cards links do point at (the contact page's three, from the security, pricing and documentation pages) are of those kinds.
  let cards = 0;
  for (const p of pages) {
    for (const m of p.markup.matchAll(/\bhref="([^"#]*)#([\w-]+)"/g)) {
      const target = m[1] === "" ? p : pages.find((q) => q.rel === fileOf(m[1]!, p));
      const element = target && new RegExp(`<(\\w+)\\b[^>]*\\sid="${m[2]}"[^>]*>`).exec(target.markup);
      if (!element || !/^article$/.test(element[1]!)) continue;
      cards++;
      const classes = /\sclass="([^"]*)"/.exec(element[0])?.[1]?.split(/\s+/) ?? [];
      assert.ok(classes.some((c) => kinds.includes(c)), `${p.rel}: #${m[2]} is a card the stylesheet does not mark: ${element[0]}`);
    }
  }
  assert.ok(cards >= 3, `links point at cards (${cards})`);
});
