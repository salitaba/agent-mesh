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
  assert.match(css, /\n\.compare \.unit \{ display: block; \}/);
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
  assert.match(css, /\n\.section:has\(> \.wrap > p:only-child\) \{ padding-block: \d+px; \}/, "a section that holds one paragraph is as tall as the paragraph needs");
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
  // The only things the stylesheet makes invisible on its own: the radio buttons behind the two segmented controls (they are used,
  // not seen) and the back-to-top button, which only the script makes.
  const invisible = [...outside.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter((m) => /\bopacity: 0;|\bvisibility: hidden;/.test(m[2]!))
    .map((m) => m[1]!.trim().replace(/\s+/g, " "));
  assert.deepEqual(invisible, [".tab-input, .billing-input", ".to-top:not(.is-shown)"], "nothing else is made invisible by the stylesheet alone");
  assert.match(/@media print \{[\s\S]*?\n\}/.exec(css)![0], /\.rv \{ opacity: 1 !important; transform: none !important; \}/, "and a page printed half-way down is printed whole");
  // A browser does not print backgrounds unless it is told to: the primary button's white label and the closing band's light one would
  // be white on white. On paper a button is black text in a black line, and the band is black text on the paper.
  const print = /@media print \{[\s\S]*?\n\}/.exec(css)![0];
  assert.match(print, /\.toc \{ flex-wrap: wrap; \}/, "the On this page row lays its chips out on paper, where the security page's seven are 1,365px in 794 and would not print whole on one line");
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
  assert.match(css, /@supports \(backdrop-filter: blur\(1px\)\) and \(background: color-mix\([^)]*\)\) \{\s*\.site-header\.is-scrolled, \.toc-bar \{[^}]*backdrop-filter: saturate\(1\.4\) blur\(16px\);/);
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
  assert.match(css, /\n\.tabs, \.billing \{ --n: 3;/);
  assert.match(css, /\n\.billing \{ --n: 2;/);
  const home = page(pages, "index.html").markup;
  const pricing = page(pages, "pricing/index.html").markup;
  assert.equal((home.match(/class="tab-input"/g) ?? []).length, 3);
  assert.equal((/<div class="tabs">[\s\S]*?<\/div>/.exec(home)![0].match(/<label\b/g) ?? []).length, 3, "a label for each");
  assert.equal((pricing.match(/class="billing-input"/g) ?? []).length, 2);
  assert.equal((/<div class="billing">[\s\S]*?<\/div>/.exec(pricing)![0].match(/<label\b/g) ?? []).length, 2);
  // The thumb goes one step for each input after the first: two for the tabs' third, one for the billing's second.
  assert.match(css, /\.tab-input:nth-of-type\(2\):checked ~ \.tabs::before, \.billing-input:nth-of-type\(2\):checked ~ \.billing::before \{ transform: translateX\(100%\); \}/);
  assert.match(css, /\.tab-input:nth-of-type\(3\):checked ~ \.tabs::before \{ transform: translateX\(200%\); \}/);
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
  const order = ['<section class="hero" id="top">', '<nav class="index"', '<section class="section" id="pricing">', '<section class="section" id="ways">', '<section class="section band" id="product">', '<section class="section" id="try">', '<section class="section band" id="why">', '<section class="section" id="how">', '<section class="section tint" id="security">', '<section class="section band" id="faq">'].map(at);
  assert.ok(order.every((n) => n >= 0), "every part is there");
  // The order is the argument: what it is and what it costs, who runs it, the console and the demo that prove it, and then the
  // two sections that say why it is built this way and how a mission goes. A phone meets the proof and the demo before the prose.
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "the statement, the contents, the price and the ways in, then the console and the demo, then the argument");
  // The contents strip names every section below it, in order, numbered like the ledger's entries.
  const nav = /<nav class="index"[^>]*>([\s\S]*?)<\/nav>/.exec(home)![0];
  assert.match(nav, /aria-label="Contents"/);
  const entries = [...nav.matchAll(/href="#([\w-]+)"><span>(\d\d)<\/span>([^<]+)<\/a>/g)].map((m) => [m[1]!, m[2]!, m[3]!]);
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
  // Every entry is a thumb's height, and the strip sits on the page's ruled ground.
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  assert.match(css, /\n\.index \{ border-block: 1px solid var\(--line\); background: var\(--panel\); \}/);
  assert.match(css, /\n\.index a \{[^}]*min-height: 48px;/);
  assert.match(css, /\n\.index \+ \.section \{ padding-top: clamp\(32px, 4vw, 48px\); \}/, "the price does not open with a whole section's gap under the strip");
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
  const notes = [...section.matchAll(/<p class="small muted mt-s"[^>]*>/g)].map((m) => m.index!);
  assert.equal(notes.length, 2, "one note for each state of Curule Cloud");
  for (const at of notes) assert.ok(at > section.indexOf("plan-teaser:end") && at < button, "after the four plans, and before the two buttons");
});

test("explanatory prose is ruled, and a surface is kept for something a person acts on", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  assert.match(css, /\n\.way, \.plan, \.doc-card, \.start, \.glance, \.result, \.tile, \.teaser, \.addresses, \.nf-list a \{ border: 1px solid var\(--line\);[^}]*background: var\(--panel\);/, "the plans, starts, document cards, addresses and ways out keep their border");
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

test("every capture has a named way to its full size, in the same window, and the phone's six views are one snap row", () => {
  const home = page(pages, "index.html").html;
  const links = [...home.matchAll(/<a class="shot-open" href="([^"]+)"[^>]*aria-label="([^"]+)"[^>]*>Full size<\/a>/g)];
  assert.equal(links.length, 10, "three in the hero, six in the console, and the graph in the steps");
  for (const [, href, label] of links) {
    assert.match(href!, /^assets\/shots\/shot-[a-z-]+\.jpg$/, `${href}: a capture on this site`);
    assert.match(label!, /^Open the .+ capture at full size$/, `${label}: the name says which capture`);
    assert.ok(fs.existsSync(path.join(SITE, href!)), `${href} is there`);
  }
  assert.ok(!/\starget="_blank"/.test(home), "no link opens a window behind the visitor");
  assert.match(home, /<p class="small muted tiles-hint">Six views\. Swipe or scroll sideways; every capture opens at full size\.<\/p>/);
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  assert.match(css, /@media \(max-width: 719px\) \{\n  \.tiles-hint \{ display: block; margin: 0 0 12px; \}\n  \.tiles \{[^}]*grid-auto-flow: column;[^}]*overflow-x: auto;/);
  assert.match(css, /\n\.shot-open \{[^}]*min-height: 44px;/, "the way to the full size is a thumb's height");
  // The row's page index: six 44px tabs, one per card, only where the row scrolls.
  const index = /<nav class="row-index" aria-label="Jump to a view">([\s\S]*?)<\/nav>/.exec(home)?.[1] ?? "";
  assert.equal((index.match(/<a href="#view-[a-z]+"/g) ?? []).length, 6, "one tab for each view");
  for (const id of ["overview", "events", "steps", "designer", "cost", "approvals"]) assert.ok(home.includes(`id="view-${id}"`), `the card ${id} is the tab's destination`);
  assert.match(css, /\n\.row-index \{ display: none; \}/);
  assert.match(css, /@media \(max-width: 719px\) \{\n  \.row-index \{ display: block;/, "the index is shown where the row scrolls");
});

test("the four plans are one snap row on a phone, and nothing off the row widens the page", () => {
  const pricing = page(pages, "pricing/index.html").html;
  assert.match(pricing, /<p class="eyebrow">Plans<\/p>\n      <h2 class="title plans-title">The licence plans\.<\/h2>\n      <p class="small muted plans-hint">Four plans\. Swipe or scroll sideways; the comparison below lists every line\.<\/p>/, "the section keeps its heading and the hint that the row swipes");
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  assert.match(css, /@media \(max-width: 719px\) \{\n  \.plans-hint \{ display: block; margin: 0 0 12px; \}\n  \.plans \{ position: relative; grid-template-columns: none; grid-auto-flow: column;[^}]*overflow-x: auto;/);
  // Without a positioned box, the screen-reader spans inside the cards that sit off the row
  // resolve against the page and make it wider than the phone: measured 872px at 360 before.
  assert.match(css, /\.plans \{ position: relative;/);
  assert.match(css, /\.plan \{ scroll-snap-align: start; \}/);
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
 * The plate's chrome holds the address the demo runs on and the way to the full-size capture in one 44px row. The address
 * was pinned to the bar's own centre and the chip to its right end, so at 320 the chip's cell began at 201.03 while the
 * 129.16px address ended at 224.58: its 1px rule crossed the address's last two characters, and "Full size" began 1.45px
 * after them (at 360 the pill was still 3.55px under the rule). They are siblings in the bar's flex row now: the address is
 * centred in the room the lights and the chip leave, and at 359 and below the three decorative lights give way, because the
 * lights, the address and the chip need 281px of the 254px a 320 phone's bar has. The chip keeps its 44px cell and the 6px
 * inset it had as an absolutely placed span, and the address is whole at every width.
 */
test("the plate's address and its full-size chip share the bar without crossing, and the lights give way at 320", () => {
  const css = fs.readFileSync(path.join(SITE, "assets", "site.css"), "utf8");
  const home = page(pages, "index.html").markup;
  assert.match(css, /\n\.frame-bar \.frame-address \{[^}]*flex: 0 1 auto;[^}]*margin-inline: auto;/, "the address takes the room the lights and the chip leave, and is centred in it");
  assert.ok(!/\.frame-bar \.frame-address \{[^}]*position: absolute/.test(css), "it is laid out in the row, not centred over the chip");
  assert.match(css, /\n\.frame-open \{ position: static; align-self: flex-start; flex: none;/, "the chip is a flex item of the same row");
  assert.match(css, /\n\.frame-open \{[^}]*margin-right: -10px;/, "and the bar's 16px padding with this -10px keeps its edge 6px inside the frame, where it was");
  assert.match(css, /@media \(max-width: 359px\) \{ \.frame-bar i \{ display: none; \} \}/, "at 320 the decorative lights give way so the address stays whole");
  assert.match(css, /\n\.frame-bar i \{ flex: none;/, "a light is its 10px circle at every width");
  assert.equal((home.match(/class="frame-open frame-open-\d"/g) ?? []).length, 3, "one chip for each of the three views");
  assert.equal((home.match(/class="frame-bar"/g) ?? []).length, 1, "in the plate's one chrome");
});


