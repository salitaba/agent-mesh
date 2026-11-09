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
import { ROOT, SITE, headingAnchors, imageSize, page, shareable, siteFiles, sitePages, type Page } from "./site-pages";
import { parsePage } from "../cloud/pages-support";

const pages = sitePages();
const files = siteFiles();
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

/** The links into Curule Cloud: <a data-cloud="login"> and the like. */
const CLOUD_LINK = /<a\b[^>]*\sdata-cloud="([^"]*)"[^>]*>/g;

/**
 * Every address a page's markup points at: src, href, action and the list in srcset. The canonical link names the page itself,
 * and the links into Curule Cloud are looked at on their own (below): they are the one kind of link that may leave the site.
 */
function references(p: Page): string[] {
  // Comments and the inside of scripts are not markup a browser follows; a script's own src is.
  const markup = p.html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/(<script\b[^>]*>)[\s\S]*?(<\/script>)/g, "$1$2")
    .replace(/<link rel="canonical" href="[^"]*">/g, "")
    .replace(CLOUD_LINK, "");
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

test("the only address of another site in a page's markup is a link into Curule Cloud, to the page of the account service its kind goes to", () => {
  const script = fs.readFileSync(path.join(SITE, "assets", "site.js"), "utf8");
  const cloud = /^var CLOUD_URL = "([^"]*)";/m.exec(script)![1]!.replace(/\/+$/, "");
  const paths = Object.fromEntries([.../var CLOUD_PATH = \{([^}]*)\}/.exec(script)![1]!.matchAll(/(\w+): "([^"]*)"/g)].map((m) => [m[1], m[2]]));
  let links = 0;
  for (const p of pages) {
    for (const m of p.markup.matchAll(CLOUD_LINK)) {
      links++;
      const href = /\shref="([^"]*)"/.exec(m[0])?.[1];
      // Written by scripts/set-domain.mjs from the script's own address, so that a page needs no script to send a visitor there: it
      // is a link the visitor follows, and it is not fetched by the page. While the service is closed it goes nowhere, and is hidden.
      assert.equal(href, cloud === "" ? "#" : `${cloud}${paths[m[1]!]}`, `${p.rel}: ${m[0]}`);
      assert.equal(/\shidden\b/.test(m[0]), cloud === "", `${p.rel}: a link into Curule Cloud is shown exactly while it is open: ${m[0]}`);
    }
  }
  assert.ok(links >= 10, `the pages have links into Curule Cloud (${links})`);
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
  assert.ok(/addEventListener\("click", function \(\) \{\s*(?:if \(note\) note\.hidden = true;\s*)?navigator\.clipboard\.writeText/.test(site), "and only from a click");
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
    // By its address and a fingerprint of the file (scripts/site-assets.mjs): tests/build/site-chrome.test.ts holds the fingerprint to the file.
    assert.ok(new RegExp('<link rel="stylesheet" href="' + (p.rel === "404.html" ? "/" : p.rel.includes("/") ? "\\.\\./" : "") + 'assets/site\\.css\\?v=[0-9a-f]{10}">').test(p.html), `${p.rel} uses the shared stylesheet`);
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

test("no page uses an id twice, so every in-page link, label and aria reference lands on the one thing it names", () => {
  for (const p of pages) {
    const ids = [...p.markup.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!);
    const repeated = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
    assert.deepEqual(repeated, [], `${p.rel}: an id is used once`);
    for (const m of p.markup.matchAll(/\shref="#([^"]+)"/g)) {
      assert.equal(ids.filter((id) => id === m[1]).length, 1, `${p.rel}: #${m[1]} names one element`);
    }
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

test("cards that share their rows span as many rows as they have parts, so that a part added to one does not push the others out of line", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  // A card is a subgrid of the row of cards it is in: the title, the price or the document it opens sit at one height across the
  // row, whatever the words take. A card with more parts than the span would put the extra one in a row of its own.
  for (const [rule, rel] of [[".plan", "pricing/index.html"], [".start", "docs/index.html"]] as const) {
    const body = new RegExp(`\\n${rule.replace(/\./g, "\\.")} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
    assert.match(body, /display: grid;/, `${rule} is a grid`);
    assert.match(body, /grid-template-rows: subgrid;/, `${rule} takes its rows from the row of cards`);
    const rows = Number(/grid-row: span (\d+);/.exec(body)?.[1]);
    const cards = parsePage(page(pages, rel).html).querySelectorAll(rule);
    assert.ok(cards.length >= 3, `${rel}: ${rule} cards are there (${cards.length})`);
    for (const card of cards) assert.equal(card.children.filter((c) => !c.isText).length, rows, `${rel}: a ${rule} card has ${rows} parts`);
  }
  // The gap between the rows of cards is the card's own margin, so that the rows inside a card are not spread by it.
  assert.match(css, /\n\.plans \{ gap: 0 16px; \}/);
  assert.match(css, /\n\.starts \{ gap: 0 16px; \}/);
});

test("the plans' table has equal columns after the one that names the row, and a yearly total stands under its figure in every column", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  // A fixed layout takes its widths from the first row, which is the header row, so the first cell says how wide the names are.
  assert.match(css, /\n\.compare \{[^}]*table-layout: fixed;/);
  assert.match(css, /\n\.compare th:first-child \{ width: \d+%; \}/);
  assert.match(css, /\n\.compare \.unit \{ display: block; font-size: \.8125rem; \}/, "the yearly total is a caption under the figure, at 13px, so it fits its cell at 720 and 768");
  const pricing = page(pages, "pricing/index.html").markup;
  const tables = [...pricing.matchAll(/<table class="compare">[\s\S]*?<\/table>/g)].map((m) => m[0]);
  assert.equal(tables.length, 2, "the plans, and the models the mission is priced at");
  for (const table of tables) assert.match(table, /^<table class="compare">\s*<caption class="sr">[^<]*<\/caption>\s*<thead>/, "the first row of a table is its header row");
  const totals = [...tables[0]!.matchAll(/<td>[^<]*<span class="muted unit">\(([^)]*)\)<\/span><\/td>/g)];
  assert.ok(totals.length >= 2, `the yearly totals are marked (${totals.length})`);
});

test("a card's title has the tile's room above it, a plan's figures share a line whatever their labels take, a lone note is compact, and the closing band's words are one group", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  assert.match(css, /\n\.card h3 \{ margin: 16px 0 8px; \}/, "the 16 above a card's title is the tile's: every card starts with one (site-copy.test.ts holds the markup to it)");
  assert.match(css, /\n\.card > \.mark, \.start > \.mark, \.glance-list \.mark, \.way-head \.mark \{ width: 40px; height: 40px; padding: 10px;/, "a mark in a card, a place to start, a glance or the way in's head is on a 40 px tile");
  assert.match(css, /\n\.start > \.mark \{ margin-bottom: 10px; \}/, "which has the same 16 under it as a card's, with the 6 of the card's rows");
  assert.match(css, /\n\.plan-limits div \{[^}]*flex-direction: column-reverse; justify-content: flex-end;/, "the figure is at the top of its cell, so a label of two lines does not lift it");
  assert.match(css, /\n\.section:has\(> \.wrap:only-child > p:only-child\) \{ padding-block: \d+px; \}/, "a section that holds one paragraph is as tall as the paragraph needs — and only when that paragraph is the section's whole content");
  // The closing band: its heading and its line are one group (the line's own 16 px under the heading, no gap of the grid), and the
  // actions stand 28 px off it on a phone and level with it, beside it, on a desktop.
  assert.match(css, /\n\.cta \.wrap \{ display: grid; gap: 0 64px; \}\n\.cta \.btn-row \{ margin-top: 28px; \}/);
  assert.match(css, /\n\.cta \.lede \{ margin-top: 16px;/);
  assert.match(css, /@media \(min-width: 900px\) \{ \.cta \.wrap \{[^}]*\} \.cta \.btn-row \{[^}]*margin-top: 0;/);
  // The room under the On this page bar is the first visible section's, also where the section before it is closed: the pricing page
  // opens with the licence plans, and the choice between the two ways, which is for Curule Cloud, comes after them.
  assert.match(css, /\n\.page-head \+ \.section, \.toc-bar \+ \.section, \.toc-bar \+ \[hidden\] \+ \.section \{ padding-top: clamp\(32px, 4vw, 48px\); \}/);
  assert.match(page(pages, "pricing/index.html").markup, /<\/nav>\s*<section class="section" id="plans">[\s\S]*?<\/section>\s*<section class="section" id="ways" data-cloud-only>/, "the licence plans open the page, and the choice that is only for Curule Cloud follows them");
  // And one section of the pages is what the lone-note rule was written for.
  const notes = pages.filter((p) => /<section class="section">\s*<div class="wrap">\s*<p class="measure">[^]*?<\/p>\s*<\/div>\s*<\/section>/.test(p.markup));
  assert.deepEqual(notes.map((p) => p.rel), ["contact/index.html"], "the contact page ends with a note in a section of its own");
});

test("a way in's answer is one paragraph where the reader is choosing and two labelled answers where they are comparing, and a lone way takes the width in two columns", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  // The home page's card answers in one paragraph (site-copy.test.ts holds the markup): the labels are the
  // comparison's, and the pricing page's two ways keep them beside the plans.
  assert.match(css, /\n\.way-body \{ margin: 20px 28px 28px; font-size: \.9375rem; \}/, "a way's paragraph takes the answers' margins and the 15px they were set in");
  assert.match(css, /@media \(max-width: 759px\) \{\n  \.way-head \{ padding: 10px 20px; \}\n  \.way dl \{ gap: 14px; margin: 16px 20px 20px; \}\n  \.way-body \{ margin: 16px 20px 20px; \}/, "and the phone's tighter margins");
  assert.match(css, /\.ways:has\(> \.way\[hidden\]\) \.way-body \{ columns: 2; column-gap: 32px; \}/, "with one way hidden, its paragraph runs in two columns of a readable measure, not one 1,120px line");
  const section = (html: string): string => /<section class="section" id="ways"[\s\S]*?\n<\/section>/.exec(html)![0];
  assert.equal((section(page(pages, "index.html").markup).match(/<dl>|<dt>/g) ?? []).length, 0, "the home page's way in has no definition list: its title says who it is for");
  assert.equal((section(page(pages, "pricing/index.html").markup).match(/<dt>/g) ?? []).length, 4, "the pricing page's two ways keep their four labelled answers");
});

test("a card or a row that a link points at is marked once the link is followed, by a second line or a bar and not by colour alone", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  const kinds = ["doc-card", "plan"];
  assert.match(css, /\n\.doc-card:target, \.plan:target \{ border-color: var\(--accent\); box-shadow: inset 0 0 0 1px var\(--accent\); \}/, "inside the border: the card does not move");
  assert.match(/@media \(forced-colors: active\) \{[\s\S]*?\n\}/.exec(css)![0], /\.doc-card:target, \.plan:target \{ outline: 2px solid Highlight;/, "a forced-colour mode drops the shadow; an outline stays");
  // The contact page's addresses are rows, which the plan buttons, the documentation page and the security page point at: a bar at the
  // row's edge says which one was meant, and a forced-colour mode, which drops the shadow, gets an outline.
  assert.match(css, /\n\.address-row:target \{ background: var\(--panel\); box-shadow: inset 4px 0 0 var\(--accent\); \}/);
  assert.match(/@media \(forced-colors: active\) \{[\s\S]*?\n\}/.exec(css)![0], /\.address-row:target \{ outline: 2px solid Highlight;/);
  // What links do point at (the contact page's three, from the plan buttons, the documentation page and the security page) is of those kinds.
  let rows = 0;
  for (const p of pages) {
    for (const m of p.markup.matchAll(/\bhref="([^"#]*)#([\w-]+)"/g)) {
      const target = m[1] === "" ? p : pages.find((q) => q.rel === fileOf(m[1]!, p));
      const element = target && new RegExp(`<(\\w+)\\b[^>]*\\sid="${m[2]}"[^>]*>`).exec(target.markup);
      if (!element) continue;
      const classes = /\sclass="([^"]*)"/.exec(element[0])?.[1]?.split(/\s+/) ?? [];
      if (element[1] === "li" && classes.includes("address-row")) {
        rows++;
        continue;
      }
      if (!/^article$/.test(element[1]!)) continue;
      assert.ok(classes.some((c) => kinds.includes(c)), `${p.rel}: #${m[2]} is a card the stylesheet does not mark: ${element[0]}`);
    }
  }
  // (No link points at a card today: the contact page's were the only ones. The rule stays for the next page that has one.)
  assert.ok(rows >= 3, `links point at the rows of addresses (${rows}): from the plan buttons, the documentation page and the security page`);
});

test("nothing is hidden by the stylesheet to be shown later: what arrives as the reader scrolls is marked by the script, for a visitor who allows motion, and no page is written hidden", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  const outside = withoutBlock(withoutBlock(css, "@media (prefers-reduced-motion: no-preference)"), "@media print");
  assert.ok(!/\.rv\b/.test(outside), "no rule hides anything outside the block for a visitor who allows motion");
  // The only things the stylesheet makes invisible on its own: the radio buttons behind the two segmented controls and the
  // six views' chooser (they are used, not seen), the view cards the chooser is not showing (one is always visible, and the
  // first is chosen in the markup, so a page with no script shows a view), the price and the period row of the billing
  // period not chosen (they keep their box so the page does not move, and neither is read), the four plan cards that
  // share one cell on a phone (the chosen one is visible, the others only size the cell, and the first is chosen in the
  // markup), and the back-to-top button, which only the script makes.
  const invisible = [...outside.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => /\bopacity: 0;|\bvisibility: hidden;/.test(m[2]!))
    .map((m) => m[1]!.trim().replace(/\s+/g, " "));
  assert.deepEqual(invisible, [
    ".tab-input, .billing-input, .choice-input",
    ".view-input",
    ".tiles > .tile",
    ".toc-toggle",
    ".billing-input:nth-of-type(1):checked ~ .plans .price-monthly, .billing-input:nth-of-type(2):checked ~ .plans .price-annual",
    ".plans > .plan",
    "body:has(#billing-monthly:checked) #compare .plan-stack .period-annual, body:has(#billing-annual:checked) #compare .plan-stack .period-monthly",
    ".to-top:not(.is-shown)",
  ], "nothing else is made invisible by the stylesheet alone");
  assert.match(/@media print \{[\s\S]*?\n\}/.exec(css)![0], /\.rv \{ opacity: 1 !important; transform: none !important; \}/, "and a page printed half-way down is printed whole");
  // A browser does not print backgrounds unless it is told to: the primary button's white label and the closing band's light one would
  // be white on white. On paper a button is black text in a black line, and the band is black text on the paper.
  const print = /@media print \{[\s\S]*?\n\}/.exec(css)![0];
  assert.match(print, /\.toc \{ display: flex !important; flex-wrap: wrap; position: static !important; width: min\(100% - 2 \* var\(--gutter\), var\(--max\)\) !important;/, "the printed index is laid out in the page's column, not fixed to the screen");
  assert.match(print, /\.toc \.toc-close \{ display: flex !important; flex: 0 0 100%;/, "and it keeps the name above it");
  assert.match(print, /\.btn \{ background: none !important; border-color: #000 !important; color: #000 !important; \}/);
  assert.match(print, /\.cta, \.cta \.lede \{ background: none; color: #000; \}/);
  assert.match(css, /\n  \.rv \{ opacity: 0; transform: translateY\(8px\);/, "a rise of eight pixels and a fade");
  assert.match(css, /\n  \.rv\.rv-in \{ opacity: 1; transform: none; \}/);
  for (const n of [1, 2, 3, 4, 5]) assert.match(css, new RegExp(`\\n  \\.rv-${n} \\{ transition-delay: ${n * 50}ms; \\}`), `the ${n}th child waits ${n * 50} ms`);
  for (const p of pages) assert.ok(!/\sclass="[^"]*\brv(?:-in|-\d)?\b/.test(p.markup), `${p.rel}: written whole: nothing is hidden before a script says so`);
  // The script asks before it hides anything, and again for a browser that cannot watch.
  const script = fs.readFileSync(path.join(SITE, "assets", "site.js"), "utf8");
  assert.match(script, /if \(!reducedMotion\(\) && typeof window\.IntersectionObserver === "function"/, "for a visitor who has not asked for less, in a browser that can tell what is in view");
});

test("the header is pinned and shows its line and its blur only by the classes the script sets, so a page without it has a header that scrolls away", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  assert.match(css, /\n\.site-header \{ position: relative;[^}]*border-bottom: 1px solid transparent; \}/, "at rest it is part of the page, and its line is there but clear, so that it does not change the height of the header");
  assert.match(css, /\n\.site-header\.is-live \{ position: sticky; top: 0; \}/);
  assert.match(css, /\n\.site-header\.is-scrolled \{ border-bottom-color: var\(--line\); background: var\(--bg\); \}/, "with a plain ground where the blur is not supported");
  assert.match(css, /@supports \(backdrop-filter: blur\(1px\)\) and \(background: color-mix\([^)]*\)\) \{\s*\.site-header\.is-scrolled \{[^}]*backdrop-filter: saturate\(1\.4\) blur\(16px\);/);
  for (const p of pages) assert.match(p.markup, /<header class="site-header">/, `${p.rel}: written at rest`);
});

test("a block of commands has its label from the stylesheet and its button from the script, in a header of one height, so that nothing moves when the button arrives", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  const height = /\n\.code \{[^}]*padding-top: (\d+)px;/.exec(css)![1];
  assert.match(css, new RegExp(`\\n\\.code::before \\{ content: "Terminal";[^}]*height: ${height}px;`), "the label's row is as tall as the room the block keeps for it");
  assert.match(css, new RegExp(`\\n\\.code-bar \\{[^}]*height: ${height}px;`), "and the row the button is made in");
  assert.ok(Number(height) >= 44 + 4, "a button of 44 pixels on a phone fits with room above and below");
});

test("a segmented control has as many inputs as its thumb has steps: the tabs of the hero are three and the billing period is two", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  assert.match(css, /\n\.tabs \{ --n: 3;/);
  assert.match(css, /\n\.billing \{ --n: 2;/);
  const home = page(pages, "index.html").markup;
  const pricing = page(pages, "pricing/index.html").markup;
  assert.equal((home.match(/class="tab-input"/g) ?? []).length, 3);
  assert.equal((/<div class="tabs">[\s\S]*?<\/div>/.exec(home)![0].match(/<label\b/g) ?? []).length, 3, "a label for each");
  assert.equal((pricing.match(/class="billing-input"/g) ?? []).length, 2);
  assert.equal((/<div class="billing">[\s\S]*?<\/div>/.exec(pricing)![0].match(/<label\b/g) ?? []).length, 2);
  // The thumb goes one step for each input after the first: two for the tabs' third, one for the billing's second. The tabs
  // are inside the frame their radios choose, so the step is written against `.frame .tabs`.
  assert.match(css, /\.tab-input:nth-of-type\(2\):checked ~ \.frame \.tabs::before, \.billing-input:nth-of-type\(2\):checked ~ \.billing::before \{ transform: translateX\(100%\); \}/);
  assert.match(css, /\.tab-input:nth-of-type\(3\):checked ~ \.frame \.tabs::before \{ transform: translateX\(200%\); \}/);
});

test("the drawings of an idea are decorative: hidden from a screen reader, with no words of their own and no style attribute, one for each reason and each step", () => {
  let drawings = 0;
  for (const p of pages) {
    for (const m of p.markup.matchAll(/<svg\b([^>]*\bclass="viz"[^>]*)>([\s\S]*?)<\/svg>/g)) {
      drawings++;
      assert.match(m[1]!, /aria-hidden="true"/, `${p.rel}: a drawing is hidden from a screen reader (the words beside it say it)`);
      assert.match(m[1]!, /focusable="false"/, `${p.rel}: and cannot be tabbed to`);
      assert.match(m[1]!, /viewBox="0 0 \d+ \d+"/, `${p.rel}: it keeps its proportions while the picture it is in is sized by the stylesheet`);
      assert.ok(!/<(text|title|desc)\b|\sstyle=/.test(m[0]), `${p.rel}: no words and no style attribute in a drawing`);
    }
  }
  assert.equal(drawings, 7, "the four reasons and the three steps");
  const home = page(pages, "index.html").markup;
  assert.equal((/<div class="grid bento">[\s\S]*?<\/section>/.exec(home)![0].match(/<svg class="viz"/g) ?? []).length, 4);
  assert.equal((/<ol class="steps">[\s\S]*?<\/ol>/.exec(home)![0].match(/<svg class="viz"/g) ?? []).length, 3);
});

test("the home page puts the price, then the proof and the demo, and the argument after them, under a numbered contents strip", () => {
  const home = page(pages, "index.html").html;
  const at = (needle: string): number => home.indexOf(needle);
  const order = ['<section class="hero" id="top">', '<nav class="toc-bar"', '<section class="section" id="pricing">', '<section class="section" id="ways">', '<section class="section band" id="product">', '<section class="section" id="try">', '<section class="section band" id="why">', '<section class="section" id="how">', '<section class="section tint" id="security">', '<section class="section band" id="faq">'].map(at);
  assert.ok(order.every((n) => n >= 0), "every part is there");
  // The order is the argument: what it is and what it costs, who runs it, the console and the demo that prove it, and then the
  // two sections that say why it is built this way and how a mission goes. A phone meets the proof and the demo before the prose.
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "the statement, the contents, the price and the ways in, then the console and the demo, then the argument");
  // The contents strip is the On this page bar the other long pages have, and it names every section below it, in order, numbered
  // like the ledger's entries. It used to be a nav.index of four rows of two chips (194px at 360) that scrolled away above the
  // price; the bar is 61px and stays under the header.
  const nav = /<nav class="toc-bar"[^>]*>([\s\S]*?)<\/nav>/.exec(home)![0];
  assert.match(nav, /aria-label="On this page"/);
  const entries = [...nav.matchAll(/href="#([\w-]+)"><span class="n">(\d\d)<\/span> ([^<]+)<\/a>/g)].map((m) => [m[1]!, m[2]!, m[3]!]);
  assert.deepEqual(entries, [
    ["pricing", "01", "Plans and prices"],
    ["ways", "02", "Who runs it"],
    ["product", "03", "The console"],
    ["try", "04", "Try it"],
    ["why", "05", "Why rules"],
    ["how", "06", "How it works"],
    ["security", "07", "Security"],
    ["faq", "08", "Questions"],
  ], "eight entries, in the order the page reads");
  for (const [id] of entries) assert.match(home, new RegExp(`<section[^>]*\\sid="${id}"`), `#${id} is there`);
  // Every entry is a thumb's height, the bar keeps the page's ground with a rule under it, and its numbers keep the ledger's
  // 12px figure (they do not grow with the reader's root, and they are not a second size of type).
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  assert.match(css, /\n\.toc-bar \{ position: relative; padding-block: 8px; border-bottom: 1px solid var\(--line\); background: var\(--bg\); \}/, "the bar's own ground and rule");
  assert.match(css, /\n\.toc-summary \{[^}]*min-height: 44px;/, "the contents control is a 44px target");
  assert.match(css, /\n\.toc \.n \{[^}]*min-width: 2ch; margin-right: 2px;[^}]*font-size: \.75rem;[^}]*font-variant-numeric: tabular-nums;/, "the entry's number is the ledger's 12px tabular figure");
  assert.match(css, /\n\.page-head \+ \.section, \.toc-bar \+ \.section, \.toc-bar \+ \[hidden\] \+ \.section \{ padding-top: clamp\(32px, 4vw, 48px\); \}/, "the price does not open with a whole section's gap under the strip");
  assert.ok(!/\.index\b/.test(css), "the strip it replaces is gone, not kept beside the bar");
});

/**
 * The On this page bar is one control, not a row that scrolls. At 360 the home page's eight chips were 1,247px in 360
 * (887 hidden) and the security page's seven were 1,333px (973 hidden); at 900 the security row still hid 465px. The
 * control says which section is being read and opens a list of all of them, so every name is one press away and whole.
 */
test("the On this page bar is a contents control that opens every section, at every width", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  const home = page(pages, "index.html").html;
  const security = page(pages, "security/index.html").html;
  assert.match(home, /<nav class="toc-bar" aria-label="On this page">\s*<input class="toc-toggle" type="checkbox" id="toc-open"[^>]*>\s*<label class="toc-summary" for="toc-open"[^>]*>/, "the bar is a checkbox and its label");
  assert.match(home, /<span class="toc-kicker">On this page<\/span> <span class="toc-now">Contents<\/span>/, "the control says what it is and what is being read");
  assert.equal((home.match(/id="toc-open"/g) ?? []).length, 1, "one toggle per page");
  assert.match(home, /<li class="toc-close"><span>On this page<\/span><label for="toc-open">Close<\/label><\/li>/, "the phone's sheet has a way out that needs no script");
  assert.match(css, /@media \(max-width: 719px\) \{\n  body:has\(\.toc-bar\.is-live \.toc-toggle:checked\) \{ overflow: hidden; \}\n  \.toc-bar\.is-live \.toc \{ position: fixed; top: var\(--head-h\); bottom: 0;/, "with the script the sheet is the screen under the header, and the script closes it when a section is chosen");
  assert.ok(!/^\.toc \{ position: fixed; top: var\(--head-h\)/m.test(css), "without the script it is a panel in the page: a no-script follow must not leave the sheet behind");
  assert.ok(!/body:has\(\.toc-toggle:checked\) \{ overflow: hidden; \}/.test(css), "and the page is not locked behind it");
  for (const p of pages.filter((q) => q.markup.includes('class="toc-bar"'))) {
    assert.match(p.markup, /<input class="toc-toggle" type="checkbox" id="toc-open"[^>]*>\s*<label class="toc-summary" for="toc-open"[^>]*>[\s\S]*?<\/label>\s*<ul class="toc">/, `${p.rel}: the control comes before the list it opens`);
  }
  assert.match(css, /\n\.toc \{ display: none; position: absolute; top: 100%;/, "the list is a panel, closed by default");
  assert.match(css, /\n\.toc-toggle:checked ~ \.toc \{ display: grid; gap: 2px; \}/, "the checkbox opens it with no script");
  assert.match(css, /\n\.toc-toggle:focus-visible ~ \.toc-summary \{ outline: 2px solid var\(--accent\); outline-offset: 2px; \}/, "the keyboard sees the control");
  assert.match(css, /\n\.toc-summary \{[^}]*width: min\(40rem, 100% - 2 \* var\(--gutter\)\); min-height: 44px;/, "the control is the page's column and a thumb's height");
  assert.match(css, /@media \(min-width: 720px\) \{ \.toc-toggle:checked ~ \.toc \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); column-gap: 6px; \} \}/, "a desk reads the index in two columns");
  assert.ok(!security.includes("data-toc-long"), "the long-row exception is gone with the row");
  assert.ok(!/\[data-toc-long\]/.test(css), "and its rule with it");
});

test("on a phone the four plans are one rate card read in rows, with how buying starts before the buttons", () => {
  const home = page(pages, "index.html").html;
  const section = /<section class="section" id="pricing">([\s\S]*?)<\/section>/.exec(home)![1]!;
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  // Four cards of 199px put the fourth price and the way to buy below a phone screen; one card of rows
  // reads the four figures in 603px at 360, the name beside the amount and the period and allowance under them.
  assert.match(css, /@media \(max-width: 599px\) \{\n  \.teaser li \{ flex-flow: row wrap; gap: 2px 12px; padding: 14px 18px; \}/, "the row is the rate card's line");
  assert.match(css, /\.teaser \.amount \{ flex: 0 0 auto; align-self: center; \}/, "the amount keeps its size, and drops under the name when the line is too narrow");
  // The note that says how a paid plan starts is read before the two buttons, not after them.
  const button = section.indexOf('<p class="btn-row');
  const notes = [...section.matchAll(/<p class="small muted mt-s(?: measure)?"[^>]*>/g)].map((m) => m.index!);
  assert.equal(notes.length, 2, "one note for each state of Curule Cloud");
  for (const at of notes) assert.ok(at > section.indexOf("plan-teaser:end") && at < button, "after the four plans, and before the two buttons");
});

test("explanatory prose is ruled, and a surface is kept for something a person acts on", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  assert.match(css, /\n\.way, \.plan, \.doc-card, \.start, \.glance, \.result, \.tile, \.teaser, \.addresses, \.nf-list a \{ border: 1px solid var\(--line\);[^}]*background: var\(--panel\);/, "the plans, starts, document cards, addresses and ways out keep their border");
  // Two of those surfaces are one press across the whole card (the docs' Start here cards and the 404's ways), as a view
  // card is: their border is the only edge that says where the target starts, so it is the control line, not the paper's.
  assert.match(css, /\n\.start, \.nf-list a \{ border-color: var\(--k-line-control\); \}/, "a card that is one press takes a control's edge");
  assert.match(css, /\n\.nf-list a:hover \{ border-color: var\(--k-line-control\);/, "and pointing at it does not take the visible edge back");
  assert.match(css, /\n\.card \{ display: flex; flex-direction: column; padding: 20px 0 0; border-top: 1px solid var\(--line2\); \}/, "a reason or a security answer is a ruled entry, not a panel");
  assert.ok(!/\n\.card, \.way/.test(css), "and it is not one of the border surfaces");
  // The phone does not spend a thousand pixels on drawings that repeat what the words say.
  assert.match(css, /@media \(max-width: 639px\) \{ \.bento \.viz, \.steps \.viz \{ display: none; \} \}/);
  // The groups that are ruled are the ones that only explain; each still starts with its mark.
  assert.equal((page(pages, "index.html").markup.match(/<div class="card">/g) ?? []).length, 7, "four reasons and three security answers on the home page");
  assert.equal((page(pages, "pricing/index.html").markup.match(/<div class="card">/g) ?? []).length, 3, "three notes on paying");
  assert.equal((page(pages, "contact/index.html").markup.match(/<article class="card contact">/g) ?? []).length, 3, "three notes on what to write");
});

test("terminal text is 13px and the inline-code rule does not shrink it a second time", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  assert.match(css, /\n\.code pre \{[^}]*font: 13px\/1\.6 var\(--mono\);/, "the block is set at 13px, on the ramp and above the 12px floor");
  assert.match(css, /\n\.code pre code \{ font-size: 1em; \}/, "the generic code rule (0.875em) stops at the block's edge");
});

test("the small standing targets are 44 pixels: the brand, the footer's address and the glance links", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  assert.match(css, /\n\.brand \{[^}]*min-width: 44px; min-height: 44px;/, "the logo's link is wider than the logo");
  assert.match(css, /\n\.foot-contact a \{[^}]*min-height: 44px;/, "the address in the footer is a thumb's height");
  assert.match(css, /\n\.glance-list h3 a \{[^}]*padding: 12px 0;/, "the three answers at the top of the security page are 44px links");
});

/**
 * The header on a phone, measured at 360 in Chrome 156: the bar wanted 401.6px of a 328px wrap, so flex shrank the
 * wordmark's link to its 44px floor and the drawing inside it to 30 × 24 (1.25:1, where it is drawn 221.54 × 60 = 3.69:1),
 * ran the actions 1px past the wrap's right edge, and said "Sign in" twice — in the bar and again in the menu. At 768 the
 * four sections fit in a row (301px of a 706px bar, 58px to spare) and were behind a press anyway.
 */
test("the phone's bar fits: the wordmark at its own proportions, one Sign in, and a 44px menu", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  assert.match(css, /\n\.brand \{[^}]*flex: none;/, "the logo's link is not squeezed by the bar");
  assert.match(css, /\n\.logo \{[^}]*flex: none;/, "and the drawing keeps its 221.54 × 60 on every width");
  assert.match(css, /@media \(max-width: 599px\) \{\n  \.bar-actions \.signin \{ display: none; \}/, "below 600 the bar's Sign in gives way to the menu's own row, which is the same link");
  assert.match(css, /@media \(max-width: 599px\) \{[\s\S]*?\n  \.menu summary \{ width: 44px; padding: 0; justify-content: center; \}/, "the menu is its icon, a thumb's 44px square");
  assert.match(css, /@media \(max-width: 599px\) \{[\s\S]*?\n  \.menu-label \{ position: absolute;/, "with the word kept for the screen reader, so the control is still called Menu");
  assert.match(css, /@media \(min-width: 600px\) \{ \.menu-panel a\[data-cloud="login"\] \{ display: none; \} \}/, "from 600 the bar's Sign in is the only one, so the open panel does not say it again");
  assert.match(css, /@media \(min-width: 768px\) \{ \.nav-main \{ display: flex; \} \.menu \{ display: none; \} \}/, "at 768 the four sections fit as a row of their own");
  // A tablet has a coarse pointer, and this band is what a tablet is: the four links are 36px for a mouse, 44 for a finger.
  assert.match(css, /@media \(max-width: 719px\), \(pointer: coarse\) \{ \.btn, \.signin, \.menu summary, \.nav-main a \{ min-height: 44px; \} \}/, "the four sections are a thumb's height on a coarse pointer");
  assert.match(css, /\n\.menu-icon \{[^}]*border-block: 2px solid currentColor;/, "the icon is three bars, since on a phone the word is not beside it");
  // A closed menu is not laid out. Chrome leaves the closed panel's links in the layout tree; at 360 they measured 93.7px wide
  // from x=323 to 416.7, so the page's menu read as six links past the viewport (opened, the panel is 16–344 and every link is
  // inside it). `display: none` says what the closed state means, and the panel is unchanged when it opens.
  assert.match(css, /\n\.menu:not\(\[open\]\) \.menu-panel \{ display: none; \}/, "a closed menu's panel is not in the layout");
  assert.match(css, /@media \(forced-colors: active\) \{[\s\S]*?\.menu-icon::before \{ background: CanvasText; \}/, "and the middle bar survives a forced-colour mode, where a background is dropped");
  // The current page is a tint in the navigation and a line as well: in a forced-colour mode the tint is Canvas over Canvas and
  // the colour is LinkText on every link, so the line is the mark that is left. Measured at 360 with forcedColors: active.
  assert.match(css, /\n\.nav-main a\[aria-current="page"\], \.menu-panel a\[aria-current="page"\], \.foot-col a\[aria-current="page"\] \{ text-decoration: underline;/, "the page you are on keeps a line in High Contrast");
  // One Sign in on screen at every width: the bar's from 600 up, the menu's below it, never both in the same bar.
  for (const p of pages) {
    const bar = /<div class="bar-actions">([\s\S]*?)<details class="menu">/.exec(p.html)?.[1] ?? "";
    const panel = /<nav aria-label="Menu">([\s\S]*?)<\/nav>/.exec(p.html)?.[1] ?? "";
    assert.equal((bar.match(/>Sign in<\/a>/g) ?? []).length, 2, `${p.rel}: the bar's Sign in is the app's and the dashboard's, one of them hidden`);
    assert.equal((panel.match(/>Sign in<\/a>/g) ?? []).length, 2, `${p.rel}: and the menu carries the same two`);
  }
});

test("every capture has a named way to its full size, and a phone chooses one of six views instead of swiping a row", () => {
  const home = page(pages, "index.html").html;
  const links = [...home.matchAll(/<a class="shot-open" href="([^"]+)"[^>]*aria-label="([^"]+)"[^>]*>Full size<\/a>/g)];
  assert.equal(links.length, 10, "three in the hero, six in the console, and the graph in the steps");
  for (const [, href, label] of links) {
    assert.match(href!, /^assets\/shots\/shot-[a-z-]+\.jpg$/, `${href}: a capture on this site`);
    assert.match(label!, /^Open the .+ capture at full size$/, `${label}: the name says which capture`);
    assert.ok(fs.existsSync(path.join(SITE, href!)), `${href} is there`);
  }
  assert.ok(!/\starget="_blank"/.test(home), "no link opens a window behind the visitor");
  assert.match(home, /<p class="small muted tiles-hint">Six views\. Choose one; every capture opens at full size\.<\/p>/);
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  assert.match(css, /@media \(max-width: 719px\) \{ \.tiles-hint \{ display: block; margin: 0 0 12px; \} \}/);
  assert.match(css, /\n\.shot-open \{[^}]*min-height: 44px;/, "the way to the full size is a thumb's height");
  // A phone chooses one of the six by number and name. The row of six cards was 1,933px in a 360 scroller: five captures
  // stood outside the viewport behind an ancestor that clips, and a text probe could not follow the row to them. Radios and
  // CSS are the same shape the plans use on a phone, so it works with no script.
  const choice = /<fieldset class="view-choice">([\s\S]*?)<\/fieldset>/.exec(home)?.[1] ?? "";
  assert.match(choice, /<legend class="sr">Choose a view<\/legend>/);
  const inputs = [...choice.matchAll(/<input class="view-input" type="radio" name="view-tile" id="show-([a-z]+)"( checked)?>/g)];
  assert.deepEqual(inputs.map((m) => m[1]), ["overview", "events", "steps", "designer", "cost", "approvals"], "one radio for each view, in order");
  assert.equal(inputs.filter((m) => m[2]).length, 1, "and one is chosen, so the page is whole with no script");
  assert.match(inputs[0]![0]!, /checked/, "the first view is the one a reader meets");
  const labels = [...choice.matchAll(/<label for="show-([a-z]+)"><span class="view-n">(\d\d)<\/span> ([^<]+)<\/label>/g)].map((m) => [m[1], m[2], m[3]]);
  assert.deepEqual(labels, [
    ["overview", "01", "Mission control"],
    ["events", "02", "Live events"],
    ["steps", "03", "Per-turn ledger"],
    ["designer", "04", "Team designer"],
    ["cost", "05", "Cost and budgets"],
    ["approvals", "06", "Approvals"],
  ], "each chip names the card it shows");
  for (const [id] of labels) assert.ok(home.includes(`id="view-${id}"`), `the card ${id} is the one its chip shows`);
  assert.ok(!/class="row-index"/.test(home), "the scrolled row and its jump index are gone, not kept beside the chooser");
  assert.match(css, /\n\.view-choice \{ display: none; \}/, "the chooser is a phone's control");
  assert.match(css, /@media \(max-width: 719px\) \{\n  \.view-choice \{ display: block;/, "and is shown where it is used");
  assert.match(css, /\n  \.view-choice label \{[^}]*min-height: 44px;[^}]*border: 1px solid var\(--k-line-control\)/, "a chip is a thumb's height, with a control's edge");
  // The number is one token: "05" broke into "0" and "5" in the 161px chip at 360 (and "01" in its own), because the span was
  // a flex item that could shrink. The label's words may wrap; the two digits may not.
  assert.match(css, /\n  \.view-n \{ flex: none;[^}]*white-space: nowrap; \}/, "the ledger number never breaks across two lines");
  assert.match(css, /\n  \.tiles > \.tile \{ grid-area: 1 \/ 1; visibility: hidden; \}/, "the six share one cell, so the row is as tall as its tallest view");
  for (const id of ["overview", "events", "steps", "designer", "cost", "approvals"]) assert.match(css, new RegExp(`body:has\\(#show-${id}:checked\\) #view-${id}`), `${id}: the chip shows its card`);
  assert.match(css, /\n  \.view-input:checked \+ label \{[^}]*box-shadow: inset 0 0 0 1px var\(--accent\)/, "the chosen view is a rule and a tint, not colour alone");
});

test("a capture is one press across its surface, not a chip beside it", () => {
  const home = page(pages, "index.html").html;
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  // Each view card's Full size link is the card's own action row at its foot, after the view's words.
  const tiles = [...home.matchAll(/<li class="tile" id="view-([a-z]+)">([\s\S]*?)<\/li>/g)];
  assert.equal(tiles.length, 6, "six view cards");
  for (const [, id, body] of tiles) {
    assert.ok(!/<figcaption/.test(body!), `${id}: the picture no longer carries a caption row of its own`);
    assert.match(body!, /<p>[\s\S]*<\/p>\s*<p class="tile-open"><a class="shot-open" href="[^"]+" aria-label="Open the .+ capture at full size">Full size<\/a><\/p>\s*$/, `${id}: the way to the full size is the card's last row, after its words`);
  }
  // The card is a flex column so its action rows stand on one line across a grid row, and the row's
  // link covers the card: the picture, the name and the description are the same press.
  assert.match(css, /\n\.tile \{ position: relative; display: flex; flex-direction: column; padding: 10px 10px 24px; \}/, "the card is the link's containing block");
  assert.match(css, /\n\.tile \.tile-open \{ margin: auto 14px 0; padding-top: 8px; border-top: 1px solid var\(--line\); \}/, "the action row stands at the card's foot, on a hairline");
  assert.match(css, /\n\.tile \.tile-open \.shot-open \{[^}]*width: 100%;/, "the action row is the card's width, not a 75px chip");
  assert.match(css, /\n\.tile \.tile-open \.shot-open::after \{ margin-left: auto; \}/, "the arrow ends the row");
  assert.match(css, /\n\.tile \.shot-open::before \{[^}]*position: absolute; inset: 0;/, "the row's link covers the card");
  // The graph and the hero's plate are captures too, and their links cover their frames. The plate's
  // chrome is laid out in the row, not positioned: if it were, the chip's cover would stop at its 44px.
  assert.match(css, /\n\.frame:has\(\.shot-open\) \{ position: relative; \}/, "the capture's frame is a containing block");
  // The thing a thumb presses has an edge a thumb can see: the frame took the decorative line at 1.52:1 and a view card at
  // 1.32:1; both take the control line at rest (3.92:1 and 4.08:1). A control's edge is a boundary, not a decoration.
  assert.match(css, /\n\.frame:has\(\.shot-open\), \.tile \{ border-color: var\(--k-line-control\); \}/, "a pressable capture's edge is the control line");
  assert.match(css, /\n\.tile \{ border-color: var\(--k-line-control\); \}/, "and the view card's, after the surface rule takes it back");
  assert.match(css, /\n\.frame:has\(\.shot-open\) \.shot-open::before,/, "the graph's and the plate's links share the cover");
  assert.ok(!/\n\.frame-bar \{[^}]*position: relative/.test(css), "the plate's bar is not the containing block");
  // The plate's bar is the view switcher now, so the one link's cover starts under it: a press on the capture opens it, and a
  // press on Overview, Events or Designer switches it. Without the 50px offset the cover would swallow the three tabs.
  assert.match(css, /\n\.hero-visual \.frame:has\(\.shot-open\) \.shot-open::before \{ top: 50px; \}/, "the cover begins under the bar, so the tabs stay pressable");
});

test("a place to start is one press across its card, not a 45.59px line inside it", () => {
  const docs = page(pages, "docs/index.html").html;
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  // A card is for something a person acts on, and each of the four places to start names one document to open first
  // (site-copy.test.ts holds that). At 360 the card was 328 × 356.08 and its link 173.8 × 45.59 — 6.8% of it — and a
  // press on the card's title, on its description or on its path did nothing. The card that names one place is the
  // place, as a view card is the capture its Full size row names; a card that named several could not be.
  const cards = [...docs.matchAll(/<li class="start"([^>]*)>([\s\S]*?)<\/li>/g)].map((m) => m[2]!);
  assert.equal(cards.length, 4, "four places to start");
  for (const card of cards) {
    assert.equal((card.match(/<a\b[^>]*\bdata-doc=/g) ?? []).length, 1, "one document to open first, so the card can be the door");
    const others = [...card.matchAll(/<a\b([^>]*)>/g)].filter((m) => !/data-doc=/.test(m[1]!));
    assert.ok(others.every((m) => /data-cloud="signup"/.test(m[1]!)), "the only other link in a place to start is the Cloud card's own sign-up");
  }
  assert.match(css, /\n\.start \{ position: relative; display: grid; grid-row: span 5; grid-template-rows: subgrid; margin-bottom: 16px; \}/, "the card is the link's containing block");
  assert.match(css, /\n\.start-doc \.arrow-link::before \{ content: ""; position: absolute; inset: 0; \}/, "the document's link covers the card");
  // With the cover as the target, the link's own box is a line of the card (25.59 at 360, its 16px line) and the card
  // is 20px shorter: four cards 80px at 360, 40 at 768 and 20 at 1440.
  assert.match(css, /\n\.start-doc \.arrow-link \{ padding: 0; font-size: 1rem; \}/, "the link is a line of the card, not a 45.59px control in it");
  assert.match(css, /\n\.start p a:not\(\.arrow-link\) \{ position: relative; \}/, "an inline link in the card's words stays above the cover, so no control is lost to it");
});

test("a caption is text: a capture's way to its full size is a line of it, and the figure is the target", () => {
  const home = page(pages, "index.html").html;
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  // The plate's three views and the graph end their captions with the link; the six cards' links are rows of their own.
  const captions = [...home.matchAll(/<figcaption>([\s\S]*?)<\/figcaption>/g)].map((m) => m[1]!);
  const withLink = captions.filter((c) => /class="shot-open"/.test(c));
  assert.equal(withLink.length, 4, "four captures put their way to the full size in the caption");
  assert.match(withLink[0]!, /^<b>Overview\.<\/b>[\s\S]*<a class="shot-open" href="assets\/shots\/shot-overview-light\.jpg" data-shot-dark="assets\/shots\/shot-overview-dark\.jpg" aria-label="Open the Overview capture at full size">Full size<\/a>$/, "each of the plate's captions is its words, then its link, with the dark twin it opens");
  for (const n of ["Events", "Designer"]) assert.ok(withLink.some((c) => c.includes(`<b>${n}.</b>`) && c.endsWith(`>Full size</a>`)), `${n}: the same shape`);
  assert.match(withLink[3]!, /^<b>Graph\.<\/b>[\s\S]*<a class="shot-open" href="assets\/shots\/shot-graph\.jpg" aria-label="Open the Graph capture at full size">Full size<\/a>$/, "the graph's caption is its words, then its link");
  // A 44px link in a 13px caption made its last line 44px tall: at 360 the line above stood 31.75px from it in a
  // 19.5px caption, and the caption was 151px beside a 173px picture. The caption's link keeps the caption's line, and
  // the cover above is what a thumb presses (326 × 300 at 360), so no target is smaller for it.
  assert.match(css, /\n\.frame figcaption \.shot-open \{ min-height: 0; \}/, "a caption's link is a line of the caption");
  assert.match(css, /\n\.shot-open \{[^}]*min-height: 44px;/, "the cards' rows are still a thumb's height");
  assert.match(css, /\n\.frame-bar \{[^}]*height: 50px;/, "the plate's bar is the 50px row its three labels fill");
  assert.match(css, /\n\.tile \.tile-open \.shot-open \{[^}]*width: 100%;/, "the cards' rows are the cards' width");
  assert.match(css, /\n\.frame:has\(\.shot-open\) \.shot-open::before,\n\.tile \.shot-open::before \{ content: ""; position: absolute; inset: 0; \}/, "the figure, not the caption's line, is the press");
});

test("the plate's Full size links name the dark twin the picture shows, and no capture without one pretends to have it", () => {
  const home = page(pages, "index.html").html;
  // The picture swaps by <source media="(prefers-color-scheme: dark)">; the link under it has to open the same file the
  // visitor is looking at, or a dark visitor's Full size press is a white flash. site-script.test.ts runs the script that
  // reads data-shot-dark; this holds the attribute to the file the picture really shows.
  const panes = [...home.matchAll(/<figure class="pane">([\s\S]*?)<\/figure>/g)].map((m) => m[1]!);
  assert.equal(panes.length, 3);
  for (const pane of panes) {
    const dark = /<source media="\(prefers-color-scheme: dark\)" srcset="([^"]+)">/.exec(pane)?.[1];
    const link = /<a class="shot-open" href="([^"]+)" data-shot-dark="([^"]+)"/.exec(pane);
    assert.ok(dark && link, `${pane.slice(0, 60)}: the picture and its link`);
    assert.equal(link![2], dark, "the link opens the file the dark picture is showing");
    assert.equal(link![1]!.replace("-light.jpg", "-dark.jpg"), dark, "and the light file is its twin");
    assert.ok(fs.existsSync(path.join(SITE, dark!)), `${dark} is there`);
  }
  assert.equal((home.match(/data-shot-dark=/g) ?? []).length, 3, "only the three captures with a dark twin carry one: the six cards and the graph have no twin to open");
});

/**
 * The plate is a window on three 1,440 × 900 captures, and a phone's window is 326 × 260 at 360: 260 pixels of the art's
 * 900. One aim served all three panes, at the goal (20% 9%, so the window began at y ≈ 58), which is right for the
 * Overview and wrong for the two views whose content is not at the top of their page: measured on the captures, the
 * Events log's first bucket is at y = 306 and its first row at 345, and the Designer's canvas starts at 304 with its
 * first row of seats at 410. At 360 the Events window ended at 317.6 — on the filter row: 0 of the 8 rows and none of
 * the red lines — and the Designer window was the page head and the Add seat toolbar: 0 of the 7 seats. Each view is
 * aimed at its own thing now, in the capture's own pixels so the window is the same at 320, 360, 390 and 719 (the old
 * percentages drifted 222.8 → 156.1 at the left at 719). The Events window (231, 300) holds the bucket, the red
 * "pm could not be woken" row and two more; the Designer window (219, 340) holds the canvas's left column and its
 * wires, and its right edge falls on the next seat at 360 so no seat is cut. The art's box (326 × 260), its caption
 * (107px) and the page (13,116 at 360, 14,041 at 320) are the same before and after.
 */
test("each of the plate's three views is cropped to the thing it is about on a phone", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  const home = page(pages, "index.html").html;
  assert.equal((home.match(/<figure class="pane">/g) ?? []).length, 3, "three views, in the order of their tabs");
  const block = /@media \(max-width: 719px\) \{\n  \.hero-visual \.pane img \{ height: 260px; object-position: (-?\d+)px (-?\d+)px; \}\n  \.hero-visual \.pane:nth-of-type\(2\) img \{ object-position: (-?\d+)px (-?\d+)px; \}\n  \.hero-visual \.pane:nth-of-type\(3\) img \{ object-position: (-?\d+)px (-?\d+)px; \}\n\}/.exec(css);
  assert.ok(block, "the phone states the three crops, one for each view");
  const aim = block.slice(1).map((v) => -Number(v));
  assert.deepEqual(aim, [223, 58, 231, 300, 219, 340], "the overview at the goal, the events at the log's rows, the designer at the seats, in the capture's own pixels");
  // The Overview is where it was (a 9% top of 58px); the two views whose page head pushed their content down are
  // aimed below it, past the head band, and the events one starts at the content column the whole console shares.
  assert.ok(aim[3] > aim[1] + 200, "the events window starts past the view's page head, not on it");
  assert.ok(aim[5] > aim[3], "the designer window starts lower still, above its first row of seats");
  assert.equal(aim[2], 231, "the log's window begins at the console's content column");
  assert.ok(aim[4] + 326 <= 545, "at 360 the designer window ends on the seat beside explorer, so no seat is cut by it");
  assert.match(css, /\n\.hero-visual \.pane img \{ object-fit: none; \}/, "the window is a crop of the art at its own size");
  assert.match(css, /@media \(min-width: 720px\) and \(max-width: 1039px\) \{ \.hero-visual \.pane img \{ height: 440px; object-position: 30% 14%; \} \}/, "from 720 the window is tall enough to hold every view's content, so one aim serves all three");
  assert.match(css, /@media \(min-width: 1040px\) \{ \.hero-visual \.pane img \{ height: 420px; object-position: 23% 14%; \} \}/, "and it is unchanged on a desk");
});

/**
 * The plate reserves one caption height for its three views, so that pressing a tab does not move the note, the proof
 * or the rest of the page below it. The Events caption is the longest; at 360 it took five lines where the slot held
 * four, so pressing Events grew the page by 19.5px (12,604 → 12,623), and at 1,040 and 1,100 it grew the frame the
 * same amount. The caption says the same in 137 characters now; the test holds it under the slot's 140 and the
 * stylesheet's heights (4 lines at 360, 5 at 320, 2 at 720 and 3 on a desk) and keeps the steps' bodies on one row.
 */
test("the plate's captions fit the height they share, and the three steps' words share a row", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  const home = page(pages, "index.html").html;
  const events = /<figcaption><b>Events\.<\/b>([\s\S]*?)<a class="shot-open"/.exec(home)?.[1] ?? "";
  assert.ok(events.replace(/<[^>]+>/g, "").trim().length <= 140, "the longest caption fits the four-line slot it shares at 360");
  assert.match(events, /what the runtime refused or did not do, and why/, "and it still says what a red line is, and why");
  // One caption height holds the three views at every width, so a tab press moves nothing below the plate.
  assert.match(css, /\n\.hero-visual \.frame figcaption \{ min-height: calc\(2 \* 1\.5em \+ 29px\); \}/);
  assert.match(css, /@media \(max-width: 719px\) \{ \.hero-visual \.frame figcaption \{ min-height: calc\(4 \* 1\.5em \+ 29px\); \} \}/);
  assert.match(css, /@media \(max-width: 359px\) \{ \.hero-visual \.frame figcaption \{ min-height: calc\(5 \* 1\.5em \+ 29px\); \} \}/);
  assert.match(css, /@media \(min-width: 1040px\) \{ \.hero-visual \.frame figcaption \{ min-height: calc\(3 \* 1\.5em \+ 29px\); \} \}/);
  // The three steps are a row of three columns, and a heading that takes two lines must not push its own words down:
  // at 1,440 the middle step's body began 24.69px below the other two. The step takes its rows from the row, as the
  // plan cards and the places to start already do.
  assert.match(css, /@media \(min-width: 860px\) \{\n  \/\* The three steps are one row of three columns[\s\S]*?\n  \.steps \{ grid-template-columns: var\(--c3\); grid-template-rows: auto auto 1fr; gap: 0 32px; \}\n  \.steps li \{ display: grid; grid-row: span 3; grid-template-rows: subgrid; padding: 52px 0 0; row-gap: 0; \}/);
  assert.equal((home.match(/class="small muted mt-s measure"/g) ?? []).length, 2, "the note under the price is held to the prose measure in both Curule Cloud states");
  const pricing = page(pages, "pricing/index.html").html;
  assert.equal((pricing.match(/class="small muted mt-[sm] measure"/g) ?? []).length, 2, "and so are the two notes under the plans and the comparison (the model table's note is inside the generated run-costs block, and is the exporter's to move)");
});

/**
 * Measured at 360 on the site of 2026-10-31: a plan card is 978px tall — a screen and a quarter — and the four stood in one
 * sideways snap row, so a reader swiped at four different heights to compare two figures. The four names and their figures
 * are one 2 × 2 chooser now, with all four prices on one screen, and only the chosen plan's card is shown. The four cards
 * share one cell, as the six console views do: at 360 Team's card is 624.5px and Community's 730.6, so choosing Team pulled
 * everything below the section up by 106.1px; the cell is the tallest plan's (Business, 749.4px) and the chosen card takes
 * its height with the action at its bottom, as a plan's card does when four share a row at 720, so a choice moves nothing.
 * The comparison below still lists every line of all four, and from 720 the four cards are a grid as they were.
 */
test("on a phone the four plans are read one at a time, chosen by name and figure, and nothing widens the page", () => {
  const pricing = page(pages, "pricing/index.html").html;
  assert.match(pricing, /<p class="eyebrow">Plans<\/p>\n      <h2 class="title plans-title">The licence plans\.<\/h2>\n      <p class="small muted plans-hint">Four plans\. Choose one to read; the comparison lists price, limits and support\.<\/p>/, "the section keeps its heading and says what the chooser does");
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  assert.match(css, /@media \(max-width: 719px\) \{\n  \.plans-hint \{ display: block; margin: 0 0 12px; \}\n  \.plan-choice \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/, "the four names and figures are a 2 x 2 chooser");
  assert.match(css, /\.plans \{ grid-template-columns: minmax\(0, 1fr\); gap: 0; \}/, "the cards are a column, not a row to swipe");
  assert.match(css, /\.plans > \.plan \{ grid-area: 1 \/ 1 \/ auto \/ auto; grid-template-rows: none; align-self: stretch; visibility: hidden; margin-bottom: 0; \}/, "the four cards share one cell, a hidden card still sizes it, and the chosen one takes its height");
  for (const id of ["community", "team", "business", "enterprise"]) assert.ok(css.includes(`body:has(#choose-${id}:checked) #plan-${id}`), `${id}: its chip shows its card`);
  assert.ok(!/\.plans > \.plan:first-of-type/.test(css), "no card is shown by its place in the list");
  assert.ok(!/\.plans \{ position: relative;/.test(css), "no sideways row is left to contain");
  // Every chip and every card name comes from the plan table, and the figure follows the billing switch.
  const choice = /<fieldset class="plan-choice">([\s\S]*?)<\/fieldset>/.exec(pricing)?.[1] ?? "";
  assert.equal((choice.match(/class="choice-input"/g) ?? []).length, 4, "four plans to choose from");
  assert.match(css, /\n  body:has\(#billing-monthly:checked\) \.choice-annual \{ display: none; \}/, "the chip's figure is the period the switch names");
  assert.match(css, /\n\.plan-choice \{ display: none; \}/, "the chooser is not shown where four cards fit");
});

test("the two wide comparisons are one plan or model at a time on a phone, from the same generated data", () => {
  const pricing = page(pages, "pricing/index.html").html;
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  assert.match(css, /\n\.stack-table \{ display: none; \}/, "the stacked view is off where the table fits");
  assert.match(css, /@media \(max-width: 719px\) \{\n  \.stack-table \{ display: grid; \}/);
  assert.match(css, /#compare \.table-wrap, #calculator \.table-wrap \{ display: none; \}/, "the table gives way to the stack on a phone");
  const block = (name: string): string => {
    const start = pricing.indexOf(`generated:${name}:start`);
    const end = pricing.indexOf(`generated:${name}:end`);
    assert.ok(start > 0 && end > start, `${name} is fenced in the page`);
    return pricing.slice(start, end);
  };
  for (const [name, count] of [["plan-stack", 4], ["run-stack", 4]] as const) {
    const body = block(name);
    assert.equal((body.match(/<article class="stack-plan"/g) ?? []).length, count, `${name}: one article per item`);
    assert.ok(!/<table\b/.test(body), `${name}: no table to swipe`);
  }
  const plans = block("plan-stack");
  for (const label of ["Per month, billed annually", "Per month, billed monthly", "Projects open at once per host", "Agents (seats) per mesh", "Concurrent agent turns per host", "Usage export and Prometheus metrics", "Support"]) {
    assert.ok(plans.includes(`<dt>${label}</dt>`), `the stacked plans keep the table's line: ${label}`);
  }
  assert.ok(!pricing.includes("Swipe the table sideways"), "no page tells a phone to swipe a table it is not given");
});

/**
 * Measured at 360 on the site of 651c5e5. The contact page's address line wanted 280px in the row's 278 (the address is 206
 * and the Copy button 62, with a 12px gap), so the button dropped under the address and every row was 217.38px where a row
 * is 169.38; the three rows took 653px of the 4,815px page. The page's section heads were 22px while the card titles under
 * them were 24px, so a card outranked its section, and the docs page's section heads were 22px beside pricing's 28/48.
 * A forced-colour mode dropped the 1px gaps that rule the home rate card and a plan's three figures, so four plans and
 * three figures ran together, measured at 360 with forcedColors: active.
 */
test("an address line stays one line on a phone, a card's title sits below its section's, and a forced-colour mode keeps the rate card's rules", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  assert.match(css, /\n\.address-row \.address \{ display: flex; flex-wrap: nowrap;/, "the address and its button are one line");
  assert.match(css, /\n\.address-row \.address a \{[^}]*min-width: 0;[^}]*min-height: 44px;[^}]*overflow-wrap: anywhere; \}/, "the address shrinks and breaks inside itself before the button moves, and stays a thumb's height");
  assert.match(css, /\n\.address-row \.address \.copy \{ flex: none; width: 76px;/, "the button keeps one width, so the address does not re-wrap when its word changes");
  assert.match(css, /@media \(max-width: 420px\) \{ \.address-row \{ padding-inline: 16px; \} \.address-row \.address \{ gap: 4px 4px; \} \}/, "at a phone's width the row gives the button and the email their room");
  // The rank: the contact page's card title is a card's title, and a page section's title is the page's.
  assert.match(css, /\n\.contact h3 \{ margin-bottom: 8px; font-size: 1\.1875rem; line-height: 1\.3; \}/);
  assert.match(css, /\n\.section > \.wrap > h2\.legend-title \{ font-size: clamp\(1\.75rem, 1\.1rem \+ 2\.5vw, 3rem\);/, "the section rank, 28 at 360 and 48 at 1440");
  // The two pages whose section heads this is written for, and the ones it must not catch (a title inside a column or a card).
  const contact = page(pages, "contact/index.html").markup;
  const contactPage = parsePage(contact);
  assert.equal(contactPage.querySelectorAll("h2.legend-title").length, 3, "the contact page has three section heads");
  assert.equal(contactPage.querySelectorAll(".cols h2.legend-title").length, 1, "the band's title is a column's, and keeps its own size");
  assert.equal(contactPage.querySelectorAll("h2.legend-title").length - contactPage.querySelectorAll(".cols h2.legend-title").length, 2, "the page's own two take the page's rank");
  const docs = page(pages, "docs/index.html").markup;
  assert.match(docs, /<div class="wrap">\s*<h2 class="legend-title">Start here<\/h2>/);
  // The map of documents is a section of the page, so it is named as one, at the page's rank; the areas inside it are cards'
  // titles under that name (h3), and the legend of labels is a disclosure under the filter, not the section's name.
  assert.match(docs, /<div class="wrap">\s*<h2 class="legend-title">The documents, by area\.<\/h2>/, "the map is named at the page's rank");
  assert.equal(parsePage(docs).querySelectorAll(".doc-card h2").length, 0, "no area outranks the section it is in");
  assert.ok(parsePage(docs).querySelectorAll(".doc-card h3").length >= 10, "each area is a card's title under it");
  assert.ok(docs.indexOf('id="doc-filter"') < docs.indexOf('<details class="legend-more'), "the filter comes before the legend it filters by");
  assert.match(docs, /<summary>What each label means<\/summary>\s*<p class="muted mt-s">Each label says what a document is,/, "and the legend keeps the sentence that explains it");
  // The page is 8,722px at 360 and the map alone is 4,991 of them: it carries the On this page row the other long pages have,
  // with one chip for each of its three sections, and the closing band is a section the row can name.
  assert.match(docs, /<section class="page-head has-toc">/);
  assert.ok(docs.indexOf('class="toc-bar"') < docs.indexOf('id="start"'), "the row follows the heading, before the first section");
  const bar = /<nav class="toc-bar" aria-label="On this page">([\s\S]*?)<\/nav>/.exec(docs)?.[1] ?? "";
  assert.deepEqual([...bar.matchAll(/<a href="#([\w-]+)">([^<]+)<\/a>/g)].map((m) => [m[1]!, m[2]!]), [["start", "Start here"], ["documents", "The documents"], ["missing", "Something missing"]]);
  assert.match(docs, /<section class="section band" id="missing">/, "the closing band has the id its chip points at");
  assert.ok(!/\.doc-card h2/.test(css), "the areas are h3, and the stylesheet keeps no title rule for an h2 in a card");
  assert.match(page(pages, "security/index.html").markup, /<h2 class="legend-title" id="glance-title">At a glance<\/h2>/, "a title in a box keeps its own size");
  // Forced colours: the line is the ground the cells sit on, and the cells over it keep their forced colours.
  const forced = /@media \(forced-colors: active\) \{[\s\S]*?\n\}/.exec(css)![0];
  assert.match(forced, /\.teaser, \.plan-limits \{ forced-color-adjust: none; background: CanvasText; \}/, "the rate card's and the plan's cells keep their rules");
  assert.match(forced, /\.teaser > li, \.plan-limits > div \{ forced-color-adjust: auto; \}/, "and the cells are still drawn in the system's colours");
});

test("a section head is the page's rank wherever it stands, and an explanation is a ruled line, not a panel", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  // The rank the documentation and contact pages took (28 at 360, 48 at a desktop) is every page's, including a split's:
  // the security and legal pages' sections were 24/34, a step below the same kind of head on the other pages.
  const rank = /\.section > \.wrap > h2\.legend-title \{ font-size: ([^;]+);/.exec(css)?.[1];
  const split = /\.split > header h2 \{ font-size: ([^;]+);/.exec(css)?.[1];
  assert.ok(rank && split, "both rules state the rank's size");
  assert.equal(split, rank, "a split's head takes the page's rank, not one of its own");
  for (const [rel, count] of [["security/index.html", 6], ["legal/index.html", 3]] as const) {
    const heads = [...page(pages, rel).markup.matchAll(/<section class="split" id="[\w-]+">\s*<header>\s*<h2>/g)];
    assert.equal(heads.length, count, `${rel}: ${count} sections, each with its head in a split`);
  }
  // The summary's answers use the box's width: the mark and its title share the first row and the words run under both,
  // because in the 222px beside the mark two of the three answers ran a line longer than their words needed at 360.
  assert.match(css, /\n\.glance-list \.mark \{ grid-row: 1; \}/);
  assert.match(css, /\n\.glance-list p \{ grid-column: 1 \/ -1; margin: 0; \}/);
  // The note over the map explains what a title and a path are; it is prose, so it is a ruled line and not a notice panel.
  assert.match(css, /\n\.doc-note \{[^}]*border-top: 1px solid var\(--line2\);[^}]*font-size: \.875rem;/, "the map's note is a ruled line of small muted words");
  const docs = page(pages, "docs/index.html").markup;
  assert.match(docs, /<p class="doc-note"><b>Each title opens the document on GitHub\.<\/b>/, "and the map's explanation keeps its words");
  assert.ok(!docs.includes('class="notice neutral mt-m"><b>Each title opens'), "the explanation is not a warning's panel");
  // A footer link is a target: its own word is the only thing that sets its width, and "Terms" is 43px in a system font.
  assert.match(css, /\n\.foot-col a \{[^}]*min-width: 44px;/, "a footer link is at least a thumb's square across");
});

/**
 * The footer's index, measured at 320 and 360. Three columns of 82.66/96px cannot hold the site's own labels: at 320
 * "Documentation" is 117px and painted 14.33px into Contact's row and 12.95px into Licence's, "RESOURCES" broke to a
 * lone "S" (its head 25.91px against the other two's 12.95), and "Report a vulnerability" ran 11.33px past the wrap.
 * Three stacked groups whose links wrap in reading order keep every label whole and every row 44px; the index is 94px
 * taller at 360 and 125px at 320. At 421 the three columns are back with the longest label 19px from the next group's
 * content, and from 640 the four-column index is unchanged.
 */
test("the footer's index is three stacked groups of wrapped links on a narrow phone, and the brand a column of its own from 640", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  assert.match(css, /\n@media \(max-width: 420px\) \{\n  \.foot-grid \{ grid-template-columns: minmax\(0, 1fr\); \}\n  \.foot-col ul \{ display: flex; flex-wrap: wrap; column-gap: 20px; \}\n\}/, "the index is three full-width groups whose links wrap, so a label wider than a third of a narrow phone cannot cross into another group");
  assert.match(css, /\n\.foot-brand \{ grid-column: 1 \/ -1; max-width: 22rem; \}/, "the brand is a banner above them while the groups are stacked");
  assert.match(css, /@media \(min-width: 640px\) \{ \.foot-grid \{ grid-template-columns: 1\.4fr repeat\(3, minmax\(0, 1fr\)\); gap: 40px 24px; \} \.foot-brand \{ grid-column: auto; max-width: none; \} \}/, "from 640 the brand is a column of its own, and the three groups stand as the desktop grid");
  assert.match(css, /\n\.foot-col a \{[^}]*line-height: 1\.3;/, "a label that wraps in a row still fits inside the 44 a thumb needs");
  assert.match(css, /\n\.foot-col h2 \{ margin: 0 0 6px; color: var\(--ink\); \}/, "and the group's name sits closer to its links than it did");
});

/**
 * A phone's footer is taller than its window, so the floating Back to top, docked above the footer, was off the screen at
 * the end of every page (at 360 its box was -102..-54 in an 800px window). While the footer's legal block is under it, the
 * script gives it `is-end` and it is fixed in the corner; the legal block keeps a lane of the button's 16px corner and 48px
 * circle so the button covers no sentence, and the links above it are never under the fixed button.
 */
test("a phone's back-to-top stays in the window's corner at the end, and the legal block keeps its lane", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  const script = fs.readFileSync(path.join(SITE, "assets", "site.js"), "utf8");
  assert.match(css, /\n\.to-top \{ position: absolute; right: 16px; bottom: 16px;[^}]*width: 48px; height: 48px;/, "the button is a 48px circle 16px in from the corner");
  assert.match(css, /\n@media \(max-width: 639px\) \{\n  html\.has-top \.site-footer \.foot-legal \{ padding-right: 64px; \}\n  \.to-top\.is-end \{ position: fixed; \}\n\}/, "below 640 the end of the page fixes it, and the footer's legal block keeps 16 + 48 = 64px at its right");
  assert.match(script, /document\.documentElement\.className \+= " has-top";/, "only a page with the script (and so the button) spends the lane");
  assert.match(script, /var legal = document\.querySelector\("\.site-footer \.foot-legal"\);/, "the script reads the block the button would sit on");
  assert.match(script, /up\.className = "to-top" \+ \(shown \? " is-shown" : ""\) \+ \(shown && end \? " is-end" : ""\);/, "and fixes it only there");
});

/**
 * Above a phone the footer is still taller than a short window: at 768x500 the dock above the footer put the button
 * at -92..-44, and at 768x600 it sat at 8..56 under the 69px header. The corner rule therefore covers a window whose
 * height leaves no room for the footer, the button and the header, at every width over 640.
 */
test("a short window's back-to-top is in the corner too, and the legal block keeps its lane", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  assert.match(css, /\n@media \(min-width: 640px\) and \(max-height: 680px\) \{\n  html\.has-top \.site-footer \.foot-legal \{ padding-right: 64px; \}\n  \.to-top\.is-end \{ position: fixed; \}\n\}/, "a window shorter than the footer plus the button and header fixes it at 640 and up, with the same 64px lane");
  assert.match(css, /\n\.to-top-dock \{ position: sticky; bottom: 0;/, "and the dock still rides above the footer when the window has room");
});

/**
 * A notice is prose, not the column it happens to stand in. At 1,440 the pricing page's "Limits are reported" notice
 * ran the whole 1,120px column and 89 characters on a line while every note beside it took 68ch; its sibling in the
 * same section was 1,120px and 83 characters a line. The measure is on the notice itself, so the words keep it
 * wherever a notice stands.
 */
test("a notice's words take the prose measure, not the column's width", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  assert.match(css, /\n\.notice \{[^}]*max-width: calc\(68ch \+ 64px\);/, "the notice caps its line at 68ch plus its own 64px of padding");
});

/**
 * A printed page narrower than a tablet has no room for two cards or the 660px comparison table. At 320 the home page
 * was 15px over the sheet and pricing 34px; pricing also printed a dead plan chooser and one of its four cards. Down to
 * 540 the sheet takes the phone's one-column rows and per-plan stack, with both periods printed because paper has no
 * switch; from 540 to 719 the two columns and the table fit, and all four cards print.
 */
test("a printed page narrower than a tablet takes the phone's rows and stack", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  const plans = /@media print and \(max-width: 719px\) \{[\s\S]*?\n\}/.exec(css)![0];
  assert.match(plans, /\.plans > \.plan \{ visibility: visible !important; grid-area: auto; \}/, "all four plans print, not the chosen one");
  const narrow = /@media print and \(max-width: 539px\) \{[\s\S]*?\n\}/.exec(css)![0];
  assert.match(narrow, /\.tiles, \.plans \{ grid-template-columns: minmax\(0, 1fr\); \}/, "the six views and four plans are one column where two would not fit");
  assert.match(narrow, /\.stack-table \{ display: grid !important; \}/, "the per-plan stack is what a narrow sheet reads");
  assert.match(narrow, /#compare \.table-wrap, #calculator \.table-wrap \{ display: none !important; \}/, "and the wide tables are not squeezed onto it");
  assert.match(narrow, /#compare \.plan-stack \.period-annual,\n  #compare \.plan-stack \.period-monthly \{ visibility: visible !important; grid-area: auto !important; \}/, "both billing periods print, since a sheet has no switch");
  assert.match(css, /\.view-choice, \.plan-choice \{ display: none; \}/, "and no dead chooser prints");
});

/**
 * The plate's bar is its view switcher. The three labels used to stand in a trough above a 44px bar of decorative lights, the
 * demo's address and a Full size chip: 50 + 16 + 44 = 110px of chrome before the picture, so at 360 the first screen held
 * 48px of the capture. The bar is one 50px row now, the labels fill it, the lights and the address are gone (the address was
 * aria-hidden decoration; the note under the picture already says the demo runs locally), and the Full size link is in the
 * caption it describes. The picture begins 60px higher, and the first screen holds the Delivered line.
 */
test("the plate's bar is its view switcher, and the capture is 60px higher on the first screen", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  const home = page(pages, "index.html").markup;
  assert.match(css, /\n\.frame-bar \{[^}]*height: 50px; padding: 0 4px;/, "the bar is one 50px row with the frame's own inset");
  assert.match(css, /\n\.frame-bar \.tabs \{ flex: 1; height: 44px; \}/, "the tabs fill it, 44px tall");
  assert.match(css, /\n\.tabs \{ --n: 3; position: relative; display: grid; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/, "three equal cells, the plate's width");
  assert.match(css, /\n\.tabs label \{ min-height: 44px; padding: 0 8px; font-size: 13px; \}/, "a label keeps a thumb's 44px and the chrome's 13px at every user text size");
  assert.ok(!/\.frame-bar (i|\.frame-address)|\.frame-open|frame-open-\d/.test(css), "the lights, the address and the separate Full size chip are gone");
  assert.equal((home.match(/<div class="frame-bar">/g) ?? []).length, 1, "one bar in the plate");
  assert.ok(/<div class="frame-bar">\s*<div class="tabs">/.test(home), "and the tabs are inside it, so the control and the picture share the frame's edges");
  assert.equal((home.match(/class="frame-address"/g) ?? []).length, 0, "the decorative address is not in the bar");
  // The three radios are before the frame, so the tab rules step through `.frame .tabs`, and the caption's link covers the
  // frame from under the bar.
  assert.match(css, /\.tab-input:nth-of-type\(2\):checked ~ \.frame \.tabs::before/);
  assert.match(css, /\n\.hero-visual \.frame:has\(\.shot-open\) \.shot-open::before \{ top: 50px; \}/);
  // Print keeps the capture, not the control: the bar is hidden, so the sheet's one view has no dead switcher above it.
  assert.match(css, /@media print \{\n  \.site-header, \.skip, \.tabs, \.billing, \.copy, \.copy-note, \.doc-filter, \.foot-grid, \.frame-bar,/, "a printed page has no view switcher");
});


/**
 * A reader's larger text, measured at 320 and 360 with the root at 32px (200% of 16) and at 24px (150%), in both schemes.
 * The page held its width at 16px and broke at 32px: the home page was 379px wide on a 360 screen (19 over) and 359 on a
 * 320 one (39 over), the pricing page 338 (18), the security page 333 (13) and the other four 322 (2); the home page's
 * contents index could not shrink (its label's longest word, 149.8px, in the 111px beside the number, and at 150% its
 * number floated in the middle of a three-line label), the closing band's grid gave the h2's longest word its own 340.8px
 * column in a 288px wrap, the six-view index's tabs needed 328.4px of a 320 phone's 288, the billing switch's "saves about
 * 17%" grew to 24px (337.6px wide), the footer's address was 305.9px in 288, and the At a glance answer's title reached
 * 333.1px in its 232px column. The Enterprise figure was cut by the card that holds it: "Let's talk" at 72px is 351.2px
 * and the card clipped 83px of it at 320, 43 at 360 and 13 at 390. Every one is a child whose automatic minimum is its
 * longest word; each may now shrink and break, wrap, or take a second line, and at 16px none of them moves (all seven
 * pages are the same height, to the pixel, at 320/360/390/768/1440 in both schemes).
 *
 * The plan chooser was still outside this: at a 32px root its name computed 24px, "COMMUNITY" needed 184px in a 134px chip
 * and "ENTERPRISE" 183, so the pricing page was 380px wide on a 360 screen (40px over at 320, 5 at 390) and at 24px the
 * name ran under the chip beside it. The name keeps the 12px a control's label keeps here, and may break as a last resort.
 */
test("at a reader's 200% text a phone's page keeps its width and the Enterprise figure is whole", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  const home = page(pages, "index.html").html;
  const pricing = page(pages, "pricing/index.html").html;
  // The index is the On this page control now (2026-11-08): its number keeps its 12px when the root grows, and the
  // control and its list keep their layout sizes, so the page does not widen.
  assert.match(css, /\n\.toc \.n \{[^}]*font-size: \.75rem;/, "the contents entry's number keeps its 12px when the reader's root grows");
  assert.match(css, /\n\.toc-summary \{[^}]*font-size: 14px;/, "and the control keeps the bar's 14px");
  assert.match(css, /\n\.toc a \{[^}]*font-size: \.9375rem;/, "and each name in the list keeps its 15px");
  // The six views' chooser is a two-column grid whose chips may shrink: its labels keep their 13px and its numbers their 12px,
  // as the bar's chips and the header's controls do, so a 26px label cannot run out of a 161px chip; and the six cards share
  // one cell so no card is wider than the column.
  assert.match(css, /\n  \.view-choice-grid \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); gap: 6px; \}/, "the six-view chooser stands in two columns that may shrink");
  assert.match(css, /\n  \.view-choice label \{[^}]*font-size: 13px;/, "a view's name keeps its layout size");
  assert.match(css, /\n  \.view-n \{[^}]*font-size: 12px;/, "and its number the bar's 12px figure");
  assert.match(css, /\n  \.tiles > \.tile \{ grid-area: 1 \/ 1; visibility: hidden; \}/, "and the six cards share one cell");
  // The four plans' chooser is the same kind of control: its name keeps its layout size, and may break rather than widen the page.
  assert.match(css, /\n  \.choice-name \{[^}]*font-size: 12px;[^}]*overflow-wrap: anywhere;/, "a plan's name keeps its layout size and may break");
  assert.ok(!/\.choice-name \{[^}]*font-size: \.75rem;/.test(css), "so it does not grow with the reader's root");
  // The closing band's grid children may be narrower than their content, as .cols > * already are.
  assert.match(css, /\n\.cta \.wrap > \* \{ min-width: 0; \}/, "the band's h2 may be narrower than its longest word");
  // A control's sub-label keeps its layout size, and the footer's address breaks like the contact page's.
  assert.match(css, /\n  \.billing label small \{ font-size: 12px; \}/, "the billing switch's sub-label keeps its 12px");
  assert.ok(!/\.billing label small \{ font-size: \.75rem; \}/.test(css), "and does not grow with the reader's root");
  assert.match(css, /\n\.foot-contact \{ overflow-wrap: anywhere; \}/, "the footer's address breaks rather than widening the page");
  // The Enterprise figure wraps inside its card rather than being cut by it, and is still the plan's own words.
  assert.match(css, /\n\.teaser \.amount \{ max-width: 100%; font-size: 2\.25rem;/, "the teaser's amount may be no wider than its card");
  assert.match(pricing, /<span class="amount">Let&rsquo;s talk<\/span>/, "and the Enterprise figure is still the plan's own words");
  assert.match(home, /<p class="limits">No limit on projects, agents or concurrent turns<\/p>/, "the teaser still states the Enterprise allowance");
});

/**
 * A sentence in a row list on the pricing page, measured at 1,440: "What you are not paying for" ran 1,120px a line —
 * about 140 characters — while the page's own notes under the plans take the 68ch measure (612px at 14px), so one list on
 * the page read at twice the width of the prose beside it. The list stands in the page's column with no column of its own;
 * the same list inside a split (the security page) or beside a heading (the contact page) is narrower than 68ch already
 * and does not move. The cap is on the sentence, so the row's rule and its bold lead keep the column's width.
 */
test("a row list that stands in the page's column holds its sentences to the prose measure", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  assert.match(css, /\n\.wrap > \.rows > li > span \{ max-width: 68ch; \}/, "the row's sentence takes the page's 68ch measure");
  const pricing = page(pages, "pricing/index.html").markup;
  assert.match(pricing, /<ul class="rows mt-s">\n      <li><b>Model usage\.<\/b><span>/, "the pricing list is the page-column shape the rule names");
  // The lists that are already narrow are not this shape: the security page's stand in a split, the contact page's in a column.
  const security = page(pages, "security/index.html").markup;
  assert.match(security, /<section class="split" id="protects">[\s\S]*?<ul class="rows">/, "the security page's rows are a split's");
  const contact = page(pages, "contact/index.html").markup;
  assert.match(contact, /<div class="wrap cols">[\s\S]*?<ul class="rows">/, "the contact page's rows are a column's");
});

/**
 * A reader's own text size is not only the page's width: at a 24px root the demo's first step heading was 222.9px in a
 * 232px column, and the Copy button beside it (82px, where the heading reserved 48) covered the last 14.9px of the line
 * and its comma; at 32px the button was 99px. A plan's figure label had the same fault: at a 24px root "projects open"
 * was 18px and needed 96px in a 79px cell, so the frame clipped it to "project:". The button keeps one 64px width and
 * the heading reserves its 72px (the button, the bar's 6px inset and a 2px gap); the figure's caption keeps the ramp's
 * 12px, as the plan chooser's name and the six-view chooser's do. The figures themselves still grow with the root.
 */
test("a reader's larger text keeps a step's Copy button off its heading, and a plan's figure label whole", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  assert.match(css, /\n\.try \.copy \{ width: 64px; justify-content: center;/, "the step's Copy button keeps one width, so its word wraps instead of growing over the heading");
  assert.match(css, /\n#try \.try > li:has\(\.code-bar\) h3 \{ padding-right: 72px; \}/, "the heading reserves the button's 64px, its 6px inset and a 2px gap — on the page whose blocks carry no Terminal band, where the button really is on the heading's line");
  // The reserve belongs to the step's own shape: the pricing page's licence steps keep the Terminal band, and their
  // Copy button stands in it 20px under the heading. Unscoped, the reserve wrapped "Install it on the host" to a
  // second line at 320 and 360 (49px where the words need 25) for a button that was not there.
  assert.ok(!/\n\.try > li:has\(\.code-bar\) h3/.test(css), "a step whose Copy button stands in its own block's band does not reserve the heading's width");
  const pricing = page(pages, "pricing/index.html").html;
  assert.match(pricing, /<div class="code"><pre data-scroll><code>curule license install/, "the licence command's block is its own, with the band the script puts the button in");
  assert.match(css, /\n\.plan-limits dt \{[^}]*font-size: 12px;/, "a plan's figure label keeps the ramp's 12px caption size at every root");
  assert.ok(!/\.plan-limits dt \{[^}]*font-size: \.75rem;/.test(css), "so a 24px root cannot make it 18px and clip it in its 79px cell");
});

/**
 * The same component, drawn once. Two broad selectors reached a second place and drew it a step larger: the docs page's
 * legend showed its label chips at 15px (the `.rows span` type rule) where the map below draws the same chip at 12px, and
 * the contact page's three card notes were 15px (the card's own paragraph rule) where `.small` reads 14px on five pages.
 */
test("a label chip in the legend is the chip in the map, and a note in a card is a note", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  assert.match(css, /\.rows > li > span, \.address-row span/, "a row's sentence is its own direct span, so a chip nested in the row's title is not set as a paragraph");
  assert.ok(!/\.rows span[ ,{]/.test(css), "the type rule that caught the legend's chip is gone");
  assert.match(css, /\n\.tag \{[^}]*font-size: \.75rem;/, "a label chip is 12px and a 22px pill");
  const docs = page(pages, "docs/index.html").html;
  assert.match(docs, /<li><b><span class="tag">Reference<\/span> long, to search<\/b><span>/, "the legend shows the label as the map does, inside the row's title");
  assert.match(css, /\n\.card p\.small \{ font-size: \.875rem; \}/, "a note keeps the note's 14px inside a card, whose body is 15px");
  const contact = page(pages, "contact/index.html").html;
  assert.equal((contact.match(/<p class="small">/g) ?? []).length, 3, "the contact page's three card notes are the class the rule restores");
});

/**
 * The surface's one visual idea is the ledger: a numbered entry. The home page numbers its eight contents entries in
 * the markup and its section eyebrows from a counter. The pricing page — the page whose job is the figures — numbered
 * neither: its seven eyebrows were plain kickers and its seven contents entries plain names. Both take the same figure
 * from a counter over what is drawn, so the Cloud switch hiding "Who runs it" leaves the two sequences in step (six and
 * six), and the home page, whose entries carry their own numbers, is not numbered twice.
 */
test("every contents index and every eyebrow is the ledger's numbered entry, from one counter over what is drawn", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  assert.match(css, /\nmain \{ counter-reset: sec; \}/);
  assert.match(css, /\nmain \.section-head \.eyebrow::before \{ counter-increment: sec; content: counter\(sec, decimal-leading-zero\);/, "every section head with an eyebrow is numbered, not only the home page's");
  assert.ok(!/main:has\(\.hero\) \.section-head \.eyebrow/.test(css), "the home-page-only scope is gone");
  assert.match(css, /\n\.toc \{ counter-reset: toc; \}/);
  assert.match(css, /\n\.toc-bar:not\(:has\(\.n\)\) \.toc li:not\(\.toc-close\) \{ counter-increment: toc; \}/, "an index that carries no number of its own counts its drawn entries");
  assert.match(css, /\n\.toc-bar:not\(:has\(\.n\)\) \.toc a::before \{ content: counter\(toc, decimal-leading-zero\);/, "and shows it in the ledger's 12px figure");
  // The home page's numbers are its own markup: the guard keeps its entries from being numbered twice.
  const home = page(pages, "index.html").html;
  assert.equal((home.match(/<span class="n">\d\d<\/span>/g) ?? []).length, 8, "the home page's eight entries keep their own numbers");
  for (const rel of ["pricing/index.html", "docs/index.html", "security/index.html", "contact/index.html", "legal/index.html"]) {
    const html = page(pages, rel).html;
    assert.ok(!/<span class="n">/.test(html), `${rel}: no entry carries a number in the markup, so the counter is the only source`);
  }
  // The pricing page's seven eyebrows and seven entries are the same seven sections in the same order, so the two
  // counters cannot disagree.
  const pricing = page(pages, "pricing/index.html");
  const nav = /<nav class="toc-bar"[^>]*>([\s\S]*?)<\/nav>/.exec(pricing.html)![1]!;
  const chips = [...nav.matchAll(/<a href="#([\w-]+)"/g)].map((m) => m[1]!);
  const heads = [...pricing.html.matchAll(/<section class="section(?: band)?" id="([\w-]+)"[^>]*>\s*<div class="wrap(?: cols)?">\s*<div class="section-head">\s*<p class="eyebrow"/g)].map((m) => m[1]!);
  assert.deepEqual(chips, heads, "one numbered entry for each section head, in the page's order");
  assert.equal(chips.length, 7, "seven sections on the pricing page");
});

/**
 * Opening the contents list is a tap on its label, which focuses the checkbox behind it. The control stands in the bar,
 * which is sticky once the script has run: its layout position is far up the page when the reader is deep in it, and
 * Chrome brings a focused control into view by that position. Measured before this rule, a tap at 1,800 on a 390×800
 * phone scrolled the page to 1,406 (394px up) and the marked section moved under the reader ("Plans and prices" became
 * "Contents"); at 3,000 it went to 2,606. Fixed to the window the 1px control is always in view, so the tap moves nothing.
 * The marked row's dot is the row's, which leaves the link's ::before to the entry's number: as the link's dot it stood
 * where the number stands and pushed the current entry's number 14px out of the column the others keep.
 */
test("opening the contents list does not move the page, and its dot leaves the number's place", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  assert.match(css, /\n\.toc-toggle \{ position: fixed; top: 0; left: 0; width: 1px; height: 1px; opacity: 0; pointer-events: none; \}/, "the control is fixed to the window, so focusing it never scrolls the page");
  assert.match(css, /\n\.toc li:has\(> a\[aria-current="true"\]\)::before \{ content: ""; position: absolute; left: 9px;/, "the dot of the section being read belongs to its row");
  assert.ok(!/\n\.toc a\[aria-current="true"\]::before \{ content: ""/.test(css), "and the link's ::before holds the entry's number");
  assert.match(css, /\n\.toc a \{[^}]*padding: 0 12px 0 22px;/, "every row keeps the dot's lane, so every number starts at one x");
  const print = /@media print \{[\s\S]*?\n\}/.exec(css)![0];
  assert.match(print, /\.toc li:has\(> a\[aria-current="true"\]\)::before \{ display: none; \}/, "the printed row has no lane for the dot");
  assert.match(print, /\.toc a\[aria-current="true"\] \{ background: none; text-decoration: underline;/, "so on paper the entry being read keeps a line instead, as the header's current page does");
});

/**
 * A note and an answer are prose, so they take the page's 68ch measure rather than the column they stand in or the 46rem
 * a section head uses. At 1,440 the map's note ran 1,063px (about 152 characters) on one line, and the FAQ's answers were
 * 734px (about 91); the page's notes take 68ch. Neither is a panel or a footer, which keep their own width.
 */
test("a note and an answer hold the prose measure", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  assert.match(css, /\n\.doc-note \{ max-width: 68ch;/, "the map's note takes the 68ch measure");
  assert.match(css, /\n\.faq \.answer \{ max-width: 68ch;/, "and so does an answer");
  assert.ok(!/\.faq \.answer \{ max-width: 46rem;/.test(css), "an answer is prose, not a section head");
  // The model-prices note is written by the exporter without a class of its own, so the rule names where it
  // stands. It was the one paragraph on the pricing page with no measure: 153 characters on one 1,120px line.
  const pricing = page(pages, "pricing/index.html");
  assert.match(css, /\n#calculator \.wrap > p\.small \{ max-width: 68ch; \}/, "the note under the measured-mission table takes the note measure");
  assert.match(pricing.html, /<p class="small muted mt-s[^"]*">Each model&rsquo;s list price/, "and the page carries that note under the estimate");
});

/**
 * A command box is a scroll region a keyboard can reach only while it has something to scroll (`data-scroll`, and the
 * script adds tabindex="0" when the content overflows). The three demo commands wrap at every width, and the plans' two
 * tables fit at 720 and up (below that neither is drawn): all six carried a stop that moved the keyboard nowhere, and
 * the four on the pricing page sat between the Copy button and the next control. The ring is still drawn inside the
 * pre's edge, because a command that does overflow has to show where the keyboard is: the box clips everything outside
 * its own 1px border, and the ring drawn 2px outside it was invisible at 360 and 1,440.
 */
test("a command is a tab stop only while it can scroll, and its ring is drawn inside the box that would clip it", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  const script = fs.readFileSync(path.join(SITE, "assets", "site.js"), "utf8");
  const home = page(pages, "index.html").markup;
  const pricing = page(pages, "pricing/index.html").markup;
  assert.match(css, /\n\.code pre:focus-visible \{ outline-offset: -2px; \}/, "the ring is drawn inside the pre, where the code box cannot cut it");
  assert.match(css, /\n\.code \{ position: relative;[^}]*overflow: hidden;/, "the box that clips it is still the framed terminal");
  assert.match(home, /<div class="code"><pre data-scroll><code>/, "a command is a scroll region, marked for the script");
  assert.ok(!/\btabindex="0"/.test(home), "and it is not a stop until the script finds it overflows: these commands wrap");
  for (const m of pricing.matchAll(/<div class="table-wrap"[^>]*>/g)) {
    assert.match(m[0], /data-scroll/, "a table that can scroll is marked for the script");
    assert.ok(!/tabindex="0"/.test(m[0]), "and is not a stop while it fits");
  }
  assert.match(script, /var needsTabStop = function \(scrollWidth, clientWidth, scrollHeight, clientHeight\) \{/, "the measure is one rule");
  assert.match(script, /all\("\[data-scroll\]"\)/, "every marked region is measured");
  assert.match(script, /if \(needsTabStop\([^)]*\)\) node\.setAttribute\("tabindex", "0"\);/, "a region that overflows takes a stop");
  assert.match(script, /else node\.removeAttribute\("tabindex"\);/, "and one that stops overflowing gives it back");
});

/**
 * A field's focus ring was a box-shadow, and a forced-colour mode drops shadows. Measured at 360 with forcedColors: active,
 * with the documentation page's filter and the estimate's fields focused by a real Tab: outline none, box-shadow none, and
 * the border the only change — rgb(0, 0, 0) at rest to rgba(5, 0, 73, 0.8) focused, 1.76:1 between them and 1px wide. The
 * keyboard's focus takes the page's outline as well, so the ring is 2px in every mode; a mouse keeps the border and shadow.
 */
test("a field's focus ring is an outline, so a forced-colour mode keeps it", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  assert.match(css, /\.field input\[type=number\]:focus, \.field select:focus, \.doc-filter input:focus \{ outline: none; border-color: var\(--accent\); box-shadow: var\(--k-ring\); \}/, "a pointer keeps the border and the shadow");
  assert.match(css, /\.field input\[type=number\]:focus-visible, \.field select:focus-visible, \.doc-filter input:focus-visible \{ outline: 2px solid var\(--accent\); outline-offset: 2px; \}/, "the keyboard's focus is an outline, which a forced-colour mode paints");
});

/**
 * A reason that spans the bento's row is wide: at 768 it is 706px and at 1,024 it is 960px, and its paragraph ran
 * the whole card — 661px (88 characters) at 768, 826–955px (110–127) at 900–1,039 — while the same paragraph is
 * 418–484px at 1,040 and up. The drawing stood centred under it. At 1,024 the paragraph was 127 characters a line,
 * nearly twice the page's 68ch, and the card was 388px tall where the same card at 1,040 is 246. The two spanning
 * cards (the first and last reasons) put their drawing beside their words from 900, where the first card begins to
 * span, and the wide first reason takes the design's 24px title there; their paragraphs and the hero's note under
 * the actions (836–975px at 900–1,039) take the page's 68ch. `#why` is 1,752 → 1,430 at 1,024 and the page 11,760
 * → 11,439; at 1,040 and up, and below 900, nothing moves.
 */
test("a reason that spans the row puts its drawing beside its words, and its prose keeps the page's measure", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  assert.match(css, /\n@media \(min-width: 900px\) \{\n  \.bento > :first-child \{ display: grid; grid-template-columns: minmax\(0, 5fr\) minmax\(0, 6fr\); grid-template-rows: auto auto 1fr; column-gap: 56px; \}/, "the wide first reason is a spread from 900, where it begins to span");
  assert.match(css, /\n  \.bento > :first-child h3 \{ font-size: 1\.5rem; \}/, "and takes the design's 24px title there");
  assert.match(css, /\n@media \(min-width: 900px\) and \(max-width: 1039\.98px\) \{\n  \.bento > :last-child \{ display: grid; grid-template-columns: minmax\(0, 5fr\) minmax\(0, 6fr\);/, "the last reason spans the same row until the bento is three columns, and is the same shape");
  assert.match(css, /\n  \.bento > :last-child \.viz \{ grid-column: 2; grid-row: 1 \/ span 3; align-self: center; padding: 0; \}/, "with its drawing beside its words");
  assert.match(css, /\n\.bento > \.card > p \{ max-width: 68ch; \}/, "a spanning card's paragraph takes the page's prose measure");
  assert.match(css, /\n\.hero-cta \.small \{ max-width: 68ch; \}/, "and so does the note under the hero's actions");
  assert.ok(css.includes("@media (min-width: 1040px) {\n  .bento { grid-template-columns: var(--c3); }\n  .bento > :last-child { grid-column: auto; }\n}"), "at 1,040 the bento is three columns and the last reason a column of its own; the wide reason's grid is not tied to it");
});

/**
 * A notice's icon was an absolutely positioned 20px circle in a 48px column of the panel, so on a phone the words
 * began 48px in: at 360 the security page's Cloud caveat was 212px of a 278px panel (16 lines), the pricing page's
 * licence caveat 261 of 328 (24 lines at 320) and its roadmap caveat 257 of 328. The icon sits on the first line
 * below 640, and the words run the panel's width: the caveat is 342 → 294 at 360 (16 → 12 lines), the licence
 * caveat 438 → 390 at 320 and 390 → 342 at 360, and the two pages are 48 and 72px shorter there. A desk keeps the
 * 48px column: a panel 836–1,120px wide has the room for an icon beside its words.
 */
test("a notice's words run the panel's width on a phone", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  assert.match(css, /\n\.notice \{[^}]*padding: 14px 16px 14px 48px;/, "a desk keeps the icon's 48px column");
  assert.match(css, /\n@media \(max-width: 639px\) \{\n  \.notice \{ padding-left: 16px; \}\n  \.notice::before \{ position: static; display: inline-block; margin: 0 8px -4px 0; \}\n\}/, "a phone puts the icon on the first line and gives the words the panel");
  const home = page(pages, "index.html").markup;
  const pricing = page(pages, "pricing/index.html").markup;
  const security = page(pages, "security/index.html").markup;
  assert.ok(home.includes('class="notice neutral mt-m" data-cloud-only'), "the home page's Cloud caveat is one of them");
  assert.ok(pricing.includes('class="notice mt-m"><b>Planned, not included:</b>'), "so is the pricing page's roadmap caveat");
  assert.ok(security.includes('class="notice neutral mt-m" data-cloud-only'), "and the security page's");
});

/**
 * The chosen plan's name moved when it was chosen. The dot was added inside the name only in the checked state, so the
 * name started 12px further right: at 360 "Business" went from x=29 to x=41 (and "Team" at 390), while its neighbours
 * stayed at 29; the six view labels' numbers moved 194 -> 206 under the same press, and at 320 the chosen "Live events"
 * gained a second line. The dot sits in the chip's own padding now (2px from its border), empty until chosen: the plan
 * names are 197/29 at 360 in both states, the view numbers 194, the chip stays 62px (plan) and 44px (view), and no label
 * takes a line it did not take before.
 */
test("a chosen plan or view keeps its label where it was: the dot takes the chip's padding", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  assert.match(css, /\n  \.choice-name::before \{ content: ""; position: absolute; left: 2px; top: 50%; width: 6px; height: 6px; margin-top: -3px; border-radius: 50%; background: transparent; \}/, "the plan's dot has a place in the chip's padding, clear of the name");
  assert.match(css, /\n  \.choice-input:checked \+ label \.choice-name::before \{ background: currentColor; \}/, "and the chosen chip only paints it");
  assert.match(css, /\n  \.view-n::before \{ content: ""; position: absolute; left: 2px; top: 50%; width: 6px; height: 6px; margin-top: -3px; border-radius: 50%; background: transparent; \}/, "so does the view's dot, in its chip's padding");
  assert.match(css, /\n  \.view-input:checked \+ label \.view-n::before \{ background: currentColor; \}/, "the chosen view paints it");
  assert.ok(!/\.choice-input:checked \+ label \.choice-name::before \{[^}]*content: ""/.test(css), "the dot is not created only when chosen");
  assert.ok(!/\.view-input:checked \+ label \.view-n::before \{[^}]*content: ""/.test(css), "nor the view's");
  const pricing = page(pages, "pricing/index.html").markup;
  const home = page(pages, "index.html").markup;
  assert.match(pricing, /<fieldset class="plan-choice">/, "the pricing page has the plan chooser");
  assert.match(home, /<fieldset class="view-choice">/, "the home page has the view chooser");
});

/**
 * The footer's two legal lines are the last prose on the site that ran past 68ch: at 1,024 and 1,440 they were 879px
 * and 688px on the 1,120px column (13px text), while every note and answer takes the page's measure. They take it too
 * now: 544px, two lines each, and the footer grows 20px at 768 and 42px at 1,024/1,440; nothing moves at 320–390.
 */
test("the footer's legal lines take the page's prose measure", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  assert.match(css, /\n\.foot-legal p \{ margin: 0; max-width: 68ch; \}/, "the footer's legal paragraphs take 68ch");
  assert.ok(!/\.foot-legal p \{[^}]*max-width: 60rem/.test(css), "not the 60rem the footer used to have");
  const home = page(pages, "index.html").markup;
  assert.match(home, /<div class="foot-legal">/, "the footer has the legal block");
});

/**
 * A closed disclosure printed only its summary: the home page's ten questions printed without answers (print height
 * 11,840 at 794) and the documentation page's "What each label means" without its four rows (4,671), because a closed
 * <details> hides its ::details-content. The printed page opens the main disclosures: the home page is 13,278 and the
 * docs page 5,171, and a <details> hidden in the page (the menu, the other Cloud state) is still display:none.
 */
test("a printed page is the light page in either colour scheme", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  const block = /@media print \{\n  :root \{\n([\s\S]*?)\n  \}\n\}/.exec(css);
  assert.ok(block, "the print sheet restates its own palette");
  const tokens = block[1]!;
  assert.match(tokens, /color-scheme: light;/, "paper has no dark scheme to follow");
  for (const token of [
    "--bg: #fff",
    "--panel: #fff",
    "--ink: #000",
    "--muted: #5d5a55",
    "--line: #e4e0d9",
    "--k-bg: #fff",
    "--k-surface: #fff",
    "--k-ink: #000",
    "--k-line: #e4e0d9",
    "--k-sunken: #f1eee8",
  ])
    assert.ok(tokens.includes(token), `the printed page's ${token}`);
  assert.ok(
    css.indexOf("@media print {\n  :root {") > css.lastIndexOf("@media (prefers-color-scheme: dark)"),
    "after every dark block, so the light values win on paper",
  );
});

test("a closed disclosure prints its answer, not only its question", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  const print = css.slice(css.indexOf("@media print"));
  assert.match(print, /details::details-content \{ content-visibility: visible !important; height: auto !important; \}/, "print shows the content a closed details hides");
  assert.match(print, /\.faq summary::after, \.legend-more summary::after \{ display: none; \}/, "and does not print the on-screen chevron");
  const home = page(pages, "index.html").markup;
  const docs = page(pages, "docs/index.html").markup;
  assert.match(home, /<div class="faq">[\s\S]*?<details>/, "the home page's answers are details");
  assert.match(docs, /<details class="legend-more mt-l">/, "so is the documentation page's label legend");
});
