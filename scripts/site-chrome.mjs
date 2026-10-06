#!/usr/bin/env node
/**
 * Writes the header and the footer that every page of the site shares, so that the seven copies cannot drift apart.
 *
 *   node scripts/site-chrome.mjs           rewrite them in every page
 *   node scripts/site-chrome.mjs --check   exit 1 if any page differs from what this writes (a test runs the same check)
 *
 * The pages are plain files and stay the source of everything else: this touches only the text between two pairs of
 * markers in each page, the same way scripts/export-pricing.mjs fences the plan data:
 *
 *   <!-- generated:chrome-header:start (scripts/site-chrome.mjs; do not edit between the markers) --> ... <!-- generated:chrome-header:end -->
 *   <!-- generated:chrome-footer:start ... -->                                                         ... <!-- generated:chrome-footer:end -->
 *
 * Every page that is an index.html (the home page, and one folder deep: pricing/, docs/, ...) is found by walking site/;
 * 404.html is the one other page. The links are written relative to the page, so the site works from any folder of any
 * host. 404.html is served at the address that was not found, at any depth, so its links start at the root instead.
 *
 * The footer's company and contact line is the owner's (scripts/set-domain.mjs writes it). It is carried over from the
 * page as it is, so running this after the domain has been applied does not put the placeholder back.
 *
 * The header is written in the state Curule Cloud is in, which the shared script says (CLOUD_URL in site/assets/site.js): Sign in
 * and Get started with their addresses and no demo button once it is open, as scripts/set-domain.mjs writes the rest of each page
 * (scripts/site-cloud-state.mjs), so that a page needs the script to say neither of them.
 *
 * To add a page: create site/<name>/index.html with the two marker pairs, add it to PAGE_LINKS below if it should be in
 * the navigation, and run this.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudConfigOf, cloudState } from "./site-cloud-state.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The logo, exactly as brand/curule-logo.svg draws it (a test compares every page with the kit). */
const LOGO =
  '<svg class="logo" viewBox="0 0 221.54 60" aria-hidden="true" focusable="false"><path class="ink" d="M31.04 27.74A16.5 16.5 0 1 0 31.04 52.26" fill="none" stroke-width="7" stroke-linecap="round"/><circle class="seat" cx="31.04" cy="27.74" r="6"/><path class="ink" d="M45.54 23.5V40A16.5 16.5 0 0 0 78.54 40M78.54 23.5V56.5M92.54 56.5V23.5M92.54 40A16.5 16.5 0 0 1 109.04 23.5M122.04 23.5V40A16.5 16.5 0 0 0 155.04 40M155.04 23.5V56.5M171.04 3.5V56.5M185.04 40H218.04A16.5 16.5 0 1 0 213.8 51.04" fill="none" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const CONTACT_PLACEHOLDER = '<span id="contact">TODO(owner): company name, contact email</span>';
const CONTACT_SPAN = /<span id="contact">[\s\S]*?<\/span>/;

/**
 * Where things are. `id` is the page's folder ("" for the home page); `home` links to a section of the home page.
 * The navigation is the first four; the others are the footer's.
 */
const NAV = [
  { label: "Product", home: "#product" },
  { label: "Pricing", id: "pricing" },
  { label: "Docs", id: "docs" },
  { label: "Security", id: "security" },
];

const FOOTER = [
  {
    title: "Product",
    links: [
      { label: "Overview", id: "" },
      { label: "What it shows", home: "#product" },
      { label: "Try the demo", home: "#try" },
      { label: "Pricing", id: "pricing" },
      { label: "Security", id: "security" },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Documentation", id: "docs" },
      { label: "Quickstart", doc: "../README.md" },
      { label: "Deploying", doc: "commercial/deployment.md" },
      { label: "Operating", doc: "operations.md" },
      { label: "Changelog", doc: "../CHANGELOG.md" },
      { label: "Source code", repo: "" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "Contact", id: "contact" },
      { label: "Licence", id: "legal", hash: "#licence" },
      { label: "Privacy", id: "legal", hash: "#privacy" },
      { label: "Terms", id: "legal", hash: "#terms" },
      { label: "Report a vulnerability", doc: "../SECURITY.md" },
    ],
  },
];

const TRADEMARK =
  "Curule runs Claude Code. Claude and Anthropic are trademarks of Anthropic PBC; Curule is not affiliated with or endorsed by Anthropic.";

/** The markers that fence a block, in the one form scripts/export-pricing.mjs uses too. */
export function fence(name) {
  return { start: `<!-- generated:${name}:start (scripts/site-chrome.mjs; do not edit between the markers) -->`, end: `<!-- generated:${name}:end -->` };
}

/** `page` is { id, file, root }: root is "" (home), "../" (a folder), or "/" (404.html, served at any depth). */
function href(page, target) {
  const base = page.root;
  if (target.home !== undefined) return page.id === "" && page.file !== "404.html" ? target.home : `${base}${target.home}`;
  if (target.doc !== undefined || target.repo !== undefined) return `${base}docs/`;
  const where = target.id === "" ? (base === "" ? "./" : base) : `${base}${target.id}/`;
  return `${where}${target.hash ?? ""}`;
}

function link(page, target, extra = "") {
  const attrs = [`href="${href(page, target)}"`];
  if (target.doc !== undefined) attrs.push(`data-doc="${target.doc}"`);
  if (target.repo !== undefined) attrs.push('data-repo=""');
  if (target.id !== undefined && target.id === page.id && target.hash === undefined && page.file !== "404.html") attrs.push('aria-current="page"');
  return `<a ${attrs.join(" ")}${extra}>${target.label}</a>`;
}

export function header(page) {
  const nav = NAV.map((t) => `      ${link(page, t)}`).join("\n");
  const menu = NAV.map((t) => `            ${link(page, t)}`).join("\n");
  const demo = page.id === "" && page.file !== "404.html" ? "#try" : `${page.root}#try`;
  return `<a class="skip" href="#main">Skip to the content</a>
<header class="site-header">
  <div class="wrap bar">
    <a class="brand" href="${page.root === "" ? "./" : page.root}" aria-label="Curule, home">${LOGO}</a>
    <nav class="nav-main" aria-label="Main">
${nav}
    </nav>
    <div class="bar-actions">
      <a class="signin" href="#" data-app hidden>Sign in</a>
      <a class="signin" href="#" data-cloud="login" hidden>Sign in</a>
      <a class="btn btn-primary" href="#" data-cloud="signup" hidden>Get started</a>
      <a class="btn btn-primary" href="${demo}" data-selfhost-only>Try the demo</a>
      <details class="menu">
        <summary><span class="menu-icon" aria-hidden="true"></span><span class="menu-label">Menu</span></summary>
        <div class="menu-panel">
          <nav aria-label="Menu">
${menu}
            <a href="#" data-app hidden>Sign in</a>
            <a href="#" data-cloud="login" hidden>Sign in</a>
          </nav>
        </div>
      </details>
    </div>
  </div>
</header>`;
}

export function footer(page, contact = CONTACT_PLACEHOLDER) {
  const cols = FOOTER.map(
    (col) => `      <nav class="foot-col" aria-label="${col.title}">
        <h2>${col.title}</h2>
        <ul>
${col.links.map((t) => `          <li>${link(page, t)}</li>`).join("\n")}
        </ul>
      </nav>`,
  ).join("\n");
  return `<footer class="site-footer">
  <div class="wrap">
    <div class="foot-grid">
      <div class="foot-brand">
        <a class="brand" href="${page.root === "" ? "./" : page.root}" aria-label="Curule, home">${LOGO}</a>
        <p>A team of AI agents, run like an organization.</p>
        <p class="foot-contact">${contact}</p>
      </div>
${cols}
    </div>
    <div class="foot-legal">
      <p>${TRADEMARK}</p>
      <p>Prices are in US dollars and exclude taxes. The source is available under the Business Source License 1.1.</p>
    </div>
  </div>
</footer>`;
}

/** The pages of a site folder: its index.html, one folder deep, and 404.html. */
export function pagesOf(siteDir) {
  const pages = [];
  if (fs.existsSync(path.join(siteDir, "index.html"))) pages.push({ id: "", file: "index.html", root: "" });
  for (const entry of fs.readdirSync(siteDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && fs.existsSync(path.join(siteDir, entry.name, "index.html"))) {
      pages.push({ id: entry.name, file: `${entry.name}/index.html`, root: "../" });
    }
  }
  if (fs.existsSync(path.join(siteDir, "404.html"))) pages.push({ id: "404", file: "404.html", root: "/" });
  return pages;
}

/** Curule Cloud as it is while it is not open: what a site that has no script says. */
const CLOSED = { url: "", paths: {} };

/** `text` with both blocks as they should be (in the state of Curule Cloud that `cloud` says), or an error naming what the page lacks. */
export function applyChrome(text, page, cloud = CLOSED) {
  let out = text;
  const blocks = { "chrome-header": cloudState(header(page), cloud), "chrome-footer": null };
  for (const name of Object.keys(blocks)) {
    const { start, end } = fence(name);
    const a = out.indexOf(start);
    const b = out.indexOf(end);
    if (a < 0 || b < a) throw new Error(`${page.file}: the block '${name}' is not fenced: expected ${start} ... ${end}`);
    let body = blocks[name];
    if (name === "chrome-footer") {
      const inside = out.slice(a + start.length, b);
      body = cloudState(footer(page, CONTACT_SPAN.exec(inside)?.[0] ?? CONTACT_PLACEHOLDER), cloud);
    }
    out = `${out.slice(0, a + start.length)}\n${body}\n${out.slice(b)}`;
  }
  return out;
}

function main() {
  const check = process.argv.includes("--check");
  // `--root <dir>` names the repository's root, as it does for scripts/set-domain.mjs and scripts/export-pricing.mjs.
  const rootFlag = process.argv.indexOf("--root");
  const siteDir = path.join(rootFlag >= 0 ? path.resolve(process.argv[rootFlag + 1] ?? "") : path.join(here, ".."), "site");
  const stale = [];
  const pages = fs.existsSync(siteDir) ? pagesOf(siteDir) : [];
  if (pages.length === 0) {
    console.error(`site-chrome: no pages under ${siteDir}`);
    process.exit(2);
  }
  let cloud = CLOSED;
  const script = path.join(siteDir, "assets", "site.js");
  if (fs.existsSync(script)) {
    try {
      cloud = cloudConfigOf(fs.readFileSync(script, "utf8"));
    } catch (e) {
      console.error(`site-chrome: assets/site.js: ${e.message}`);
      process.exit(2);
    }
  }
  // Every page is computed before any is written, so a page that lacks its markers stops the run with nothing changed.
  const writes = [];
  for (const page of pages) {
    const file = path.join(siteDir, page.file);
    const before = fs.readFileSync(file, "utf8");
    let after;
    try {
      after = applyChrome(before, page, cloud);
    } catch (e) {
      console.error(`site-chrome: ${e.message}`);
      process.exit(2);
    }
    if (after === before) continue;
    stale.push(page.file);
    writes.push([file, after]);
  }
  if (!check) for (const [file, text] of writes) fs.writeFileSync(file, text, "utf8");
  if (check) {
    if (stale.length > 0) {
      console.error(`out of date: ${stale.join(", ")}\nrun \`node scripts/site-chrome.mjs\` and commit the result`);
      process.exit(1);
    }
    console.log(`the header and footer of ${pages.length} pages are up to date`);
  } else {
    console.log(stale.length === 0 ? `nothing to change in ${pages.length} pages` : `rewrote the header and footer of ${stale.length} page(s): ${stale.join(", ")}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
