#!/usr/bin/env node
/**
 * Applies the domain you chose to everything in the repository that carries it, in one command, so that the places
 * cannot disagree and none is forgotten.
 *
 *   node scripts/set-domain.mjs <domain> --contact <email> [--security <email>] [--sales <email>] [--support <email>]
 *                               [--company "<name>"] [--app-url <https address>|none] [--docs-base github]
 *   node scripts/set-domain.mjs <domain> ... --dry-run      say what would change, write nothing
 *   node scripts/set-domain.mjs --check                     list what is still marked TODO(owner); exit 1 while any is
 *
 * It writes, from the domain (for example `curule.dev`) and the addresses you pass:
 *
 *   every page of the site     (site/index.html, and each site/<folder>/index.html: pricing, docs, security, contact, legal)
 *                              og:image and twitter:image as absolute addresses (a link preview needs them), a canonical
 *                              link and og:url that name the page's own address, and the footer's company and contact
 *                              (--contact, --company). site/404.html gets the footer's contact too, and nothing else:
 *                              a page that is not found has no address of its own.
 *   site/contact/index.html    the sales, support and security addresses (--contact, which sales and support default to,
 *                              --sales, --support, --security) and the company line (--company)
 *   site/assets/site.js        CONTACT_HREF ("Talk to us", the paid plans), APP_URL (where "Sign in" goes, or none to remove
 *                              the link: --app-url) and the documents' base (--docs-base github: keep them in the repository)
 *   SECURITY.md                the reporting address (--security)
 *   site/CNAME                 the custom domain, for the hosts that read it from the site (an Actions publish to GitHub Pages
 *                              takes it from the repository's Pages settings and ignores this file)
 *   site/robots.txt            allow everything, and the sitemap's address
 *   site/sitemap.xml           every page
 *   site/security.txt          RFC 9116: the address and the repository's private reporting link (--security), expiring
 *   site/.well-known/security.txt   the same, at the path the RFC prefers (a host that drops dotfiles serves the first)
 *
 * It never touches LICENSE: its contact line is the Licensor's to set, with counsel, and a test pins the rest of the
 * file. It does not write the terms on the legal page either: those are written with counsel, and stay marked until they
 * are. It never registers, buys or publishes anything. Run it again with the same arguments and nothing changes (pass
 * --today to fix the date it writes); run it with new ones and it replaces what it wrote.
 *
 * Exit status: 0 done (or --check clean), 1 --check found something marked TODO(owner), 2 refused (bad arguments, or a
 * file that is not the shape this expects).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const USAGE =
  'usage: node scripts/set-domain.mjs <domain> --contact <email> [--security <email>] [--sales <email>] [--support <email>] [--company "<name>"] [--app-url <https address>|none] [--docs-base github] [--dry-run] [--today YYYY-MM-DD] [--root <dir>]\n' +
  "       node scripts/set-domain.mjs --check [--root <dir>]";

const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/;
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const HTTPS_ADDRESS = /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*)?$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The text files of the site that can carry a marker. Its README is about the site, not part of it. */
const TEXT_FILE = /\.(html|js|css|txt|xml|json)$/;
const SCRIPT = "assets/site.js";

function refuse(message) {
  console.error(`set-domain: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = { positional: [], flags: {} };
  const valued = new Set(["contact", "security", "sales", "support", "company", "app-url", "docs-base", "today", "root"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out.positional.push(a);
      continue;
    }
    const name = a.slice(2);
    if (valued.has(name)) {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) refuse(`--${name} needs a value\n${USAGE}`);
      out.flags[name] = value;
    } else if (name === "dry-run" || name === "check") {
      out.flags[name] = true;
    } else {
      refuse(`unknown option --${name}\n${USAGE}`);
    }
  }
  return out;
}

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** One edit of a text: replace what `pattern` finds, or say that the text is not the shape this expects. */
function edit(text, pattern, replacement, what, { optional = false } = {}) {
  if (!pattern.test(text)) {
    if (optional) return text;
    refuse(`${what}: the expected text was not found, so nothing was changed. Is this the Curule repository?`);
  }
  return text.replace(pattern, typeof replacement === "function" ? replacement : () => replacement);
}

/** Every file under a folder, as paths relative to it, in a fixed order. */
function walk(dir, rel = "") {
  const out = [];
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(dir, r));
    else out.push(r);
  }
  return out.sort();
}

const isPage = (rel) => rel === "index.html" || /^[^/]+\/index\.html$/.test(rel);
/** The address of a page below the domain: "" for the home page, "pricing/" for pricing/index.html. */
const pageAddress = (rel) => rel.replace(/index\.html$/, "");

/** The footer and the contact page are the owner's, and every page that has them gets the same text. */
function applyOwnerText(html, label, o, { required }) {
  let out = html;
  if (o.contact) {
    const who = o.company ? `${escapeHtml(o.company)} &middot; ` : "";
    out = edit(out, /<span id="contact">[\s\S]*?<\/span>/, `<span id="contact">${who}<a href="mailto:${o.contact}">${o.contact}</a></span>`, `${label} footer contact`, { optional: !required });
  }
  const addresses = { sales: o.sales ?? o.contact, support: o.support ?? o.contact, security: o.security };
  for (const [kind, address] of Object.entries(addresses)) {
    if (!address) continue;
    out = out.replace(new RegExp(`<a data-mail="${kind}" href="[^"]*">[\\s\\S]*?</a>`, "g"), () => `<a data-mail="${kind}" href="mailto:${address}">${address}</a>`);
  }
  if (o.company) out = out.replace(/<span data-company>[\s\S]*?<\/span>/g, () => `<span data-company>${escapeHtml(o.company)}</span>`);
  return out;
}

function applyToPage(html, rel, o) {
  const label = `site/${rel}`;
  let out = html;
  const image = `https://${o.domain}/assets/social-card.png`;
  const address = `https://${o.domain}/${pageAddress(rel)}`;
  out = edit(out, /(<meta property="og:image" content=")[^"]*(">)/, `<meta property="og:image" content="${image}">`, `${label} og:image`);
  out = edit(out, /(<meta name="twitter:image" content=")[^"]*(">)/, `<meta name="twitter:image" content="${image}">`, `${label} twitter:image`);
  out = out.replace(/^<!-- TODO\(owner\): og:image[^\n]*-->\n/m, "");
  const canonical = `<link rel="canonical" href="${address}">`;
  const ogUrl = `<meta property="og:url" content="${address}">`;
  if (/<link rel="canonical" href="[^"]*">/.test(out)) out = out.replace(/<link rel="canonical" href="[^"]*">/, () => canonical);
  if (/<meta property="og:url" content="[^"]*">/.test(out)) out = out.replace(/<meta property="og:url" content="[^"]*">/, () => ogUrl);
  if (!/<link rel="canonical"/.test(out) || !/<meta property="og:url"/.test(out)) {
    // The pair goes after og:type; whichever of the two is already there is kept, so a run never doubles one.
    const missing = [!/<link rel="canonical"/.test(out) ? canonical : null, !/<meta property="og:url"/.test(out) ? ogUrl : null].filter(Boolean);
    out = edit(out, /<meta property="og:type" content="website">\n/, (found) => `${found}${missing.join("\n")}\n`, `${label} og:type (where the canonical link goes)`);
  }
  return applyOwnerText(out, label, o, { required: true });
}

function applyToScript(js, o) {
  const label = `site/${SCRIPT}`;
  let out = js;
  if (o.contact) {
    out = edit(out, /var CONTACT_HREF = "[^"]*";[^\n]*/, `var CONTACT_HREF = "mailto:${o.contact}"; // "Talk to us" and the paid plans`, `${label} CONTACT_HREF`);
  }
  if (o.appUrl !== undefined) {
    const note = o.appUrl === "" ? '// No hosted dashboard: the "Sign in" link is removed' : '// Where "Sign in" goes: your own dashboard';
    out = edit(out, /var APP_URL = "[^"]*";[^\n]*/, `var APP_URL = "${o.appUrl}"; ${note}`, `${label} APP_URL`);
  }
  if (o.docsBase === "github") {
    out = out.replace(/\/\/ TODO\(owner\): where the documents are published\.[^\n]*/, "// Where the documents are published: the repository, until a documentation site exists.");
  }
  return out;
}

function applyToSecurity(md, o) {
  if (!o.security) return md;
  return edit(md, /^- Email: .*\n(?:  .*\n)*/m, `- Email: ${o.security}\n`, "SECURITY.md reporting address");
}

function plusDays(day, days) {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

function generatedFiles(o, securityMd, pages) {
  const entries = pages.map((rel) => `  <url><loc>https://${o.domain}/${pageAddress(rel)}</loc><lastmod>${o.today}</lastmod></url>`).join("\n");
  const files = {
    "site/CNAME": `${o.domain}\n`,
    "site/robots.txt": `User-agent: *\nAllow: /\n\nSitemap: https://${o.domain}/sitemap.xml\n`,
    "site/sitemap.xml": `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`,
  };
  if (o.security) {
    const advisory = /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/security\/advisories\/new/.exec(securityMd)?.[0];
    const txt =
      `Contact: mailto:${o.security}\n` +
      (advisory ? `Contact: ${advisory}\n` : "") +
      `Expires: ${plusDays(o.today, 364)}\n` +
      `Preferred-Languages: en\n` +
      `Canonical: https://${o.domain}/.well-known/security.txt\n`;
    files["site/security.txt"] = txt;
    files["site/.well-known/security.txt"] = txt;
  }
  return files;
}

/** The files this reads: the site's text files (not its README), and the security policy. */
function markedFiles(root) {
  const siteDir = path.join(root, "site");
  const rels = walk(siteDir).filter((f) => TEXT_FILE.test(f)).map((f) => `site/${f}`);
  return [...rels, "SECURITY.md"];
}

function check(root) {
  const lines = [];
  for (const rel of ["site/index.html", "SECURITY.md"]) {
    if (!fs.existsSync(path.join(root, rel))) refuse(`${rel} is missing under ${root}`);
  }
  for (const rel of markedFiles(root)) {
    fs.readFileSync(path.join(root, rel), "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (line.includes("TODO(owner)")) lines.push(`${rel}:${i + 1}: ${line.trim().slice(0, 150)}`);
      });
  }
  for (const rel of ["site/CNAME", "site/robots.txt", "site/sitemap.xml"]) {
    if (!fs.existsSync(path.join(root, rel))) lines.push(`${rel}: not written yet (node scripts/set-domain.mjs <domain> ...)`);
  }
  const licence = path.join(root, "LICENSE");
  const pointsAtRepo = fs.existsSync(licence) && /contact the Licensor through https:\/\/github\.com\//.test(fs.readFileSync(licence, "utf8").replace(/\s+/g, " "));
  if (lines.length === 0) console.log("set-domain: nothing is marked TODO(owner), and the domain files are written.");
  else {
    console.log("set-domain: still to do:");
    for (const l of lines) console.log(`  ${l}`);
  }
  if (pointsAtRepo) {
    console.log("note: LICENSE's contact line still points at the repository. It is the Licensor's to change, with counsel; this script does not touch it.");
  }
  process.exit(lines.length === 0 ? 0 : 1);
}

function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(flags.root ?? path.join(here, ".."));
  if (flags.check) {
    if (positional.length > 0) refuse(`--check takes no domain\n${USAGE}`);
    check(root);
    return;
  }
  if (positional.length !== 1) refuse(`give the domain, for example curule.dev\n${USAGE}`);
  const domain = positional[0].trim().toLowerCase();
  if (!DOMAIN.test(domain)) refuse(`"${positional[0]}" is not a domain name: give it bare, ASCII, with its TLD (curule.dev, not https://curule.dev/ or a path)`);
  const today = flags.today ?? new Date().toISOString().slice(0, 10);
  if (!DAY.test(today) || Number.isNaN(Date.parse(`${today}T00:00:00.000Z`))) refuse("--today must be a date, YYYY-MM-DD");
  for (const name of ["contact", "security", "sales", "support"]) {
    if (flags[name] !== undefined && !EMAIL.test(flags[name])) refuse(`--${name} "${flags[name]}" is not an email address`);
  }
  if (flags.company !== undefined && (flags.company.trim() === "" || flags.company.length > 120 || /[\r\n]/.test(flags.company))) {
    refuse("--company must be one line of at most 120 characters");
  }
  if (flags["docs-base"] !== undefined && flags["docs-base"] !== "github") {
    refuse('--docs-base takes only "github" (keep the documents in the repository); a documentation site is a change to the site\'s script and its test, by hand');
  }
  if (flags["app-url"] !== undefined && flags["app-url"] !== "none" && !HTTPS_ADDRESS.test(flags["app-url"])) {
    refuse(`--app-url "${flags["app-url"]}" is not an https address (https://mesh.example.com/), or none to remove the "Sign in" link`);
  }
  if (flags.company && !flags.contact) refuse("--company goes with --contact (the footer shows both)");
  const o = {
    domain,
    today,
    contact: flags.contact,
    security: flags.security,
    sales: flags.sales,
    support: flags.support,
    company: flags.company?.trim(),
    appUrl: flags["app-url"] === undefined ? undefined : flags["app-url"] === "none" ? "" : flags["app-url"],
    docsBase: flags["docs-base"],
  };

  const siteDir = path.join(root, "site");
  const securityPath = path.join(root, "SECURITY.md");
  for (const [p, rel] of [[path.join(siteDir, "index.html"), "site/index.html"], [securityPath, "SECURITY.md"]]) {
    if (!fs.existsSync(p)) refuse(`${rel} is missing under ${root}`);
  }
  if (!fs.existsSync(path.join(siteDir, SCRIPT))) refuse(`site/${SCRIPT} is missing under ${root}`);
  const security = fs.readFileSync(securityPath, "utf8");
  // The reporting address a previous run wrote to SECURITY.md stays the one security.txt names, so moving to a new domain
  // without repeating --security rewrites its canonical address and does not leave the old file behind.
  if (!o.security) {
    const written = /^- Email: (\S+)$/m.exec(security)?.[1];
    if (written && EMAIL.test(written)) o.security = written;
  }

  const files = walk(siteDir);
  // The home page first, then the others in the order of their folders.
  const pages = [...files.filter((f) => f === "index.html"), ...files.filter((f) => f !== "index.html" && isPage(f))];
  // Every edit is computed before anything is written, so a page that is not the shape this expects stops the whole run.
  const writes = new Map();
  for (const rel of files) {
    if (!/\.(html|js)$/.test(rel)) continue;
    const text = fs.readFileSync(path.join(siteDir, rel), "utf8");
    if (isPage(rel)) writes.set(`site/${rel}`, applyToPage(text, rel, o));
    else if (rel === "404.html") writes.set(`site/${rel}`, applyOwnerText(text, `site/${rel}`, o, { required: true }));
    else if (rel === SCRIPT) writes.set(`site/${rel}`, applyToScript(text, o));
  }
  writes.set("SECURITY.md", applyToSecurity(security, o));
  for (const [rel, text] of Object.entries(generatedFiles(o, security, pages))) writes.set(rel, text);

  let changed = 0;
  for (const [rel, text] of writes) {
    const file = path.join(root, rel);
    const before = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
    if (before === text) {
      console.log(`  unchanged  ${rel}`);
      continue;
    }
    changed++;
    console.log(`  ${flags["dry-run"] ? "would write" : before === undefined ? "created  " : "changed  "}  ${rel}`);
    if (!flags["dry-run"]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text, "utf8");
    }
  }
  // What is still marked, counted in the text as it will be (the files a run does not rewrite, as they are).
  let left = 0;
  for (const rel of markedFiles(root)) {
    const text = writes.get(rel) ?? fs.readFileSync(path.join(root, rel), "utf8");
    left += text.match(/TODO\(owner\)/g)?.length ?? 0;
  }
  console.log(
    `${flags["dry-run"] ? "dry run: " : ""}${changed} file(s) ${flags["dry-run"] ? "would change" : "written"} for https://${domain}/` +
      (left ? `; ${left} marker(s) still say TODO(owner): run with --check to list them` : "; no TODO(owner) is left"),
  );
}

main();
