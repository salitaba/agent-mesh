#!/usr/bin/env node
/**
 * Applies the domain you chose to everything in the repository that carries it, in one command, so that the places
 * cannot disagree and none is forgotten.
 *
 *   node scripts/set-domain.mjs <domain> --contact <email> [--security <email>] [--company "<name>"] [--docs-base github]
 *   node scripts/set-domain.mjs <domain> ... --dry-run      say what would change, write nothing
 *   node scripts/set-domain.mjs --check                     list what is still marked TODO(owner); exit 1 while any is
 *
 * It writes, from the domain (for example `curule.dev`) and the addresses you pass:
 *
 *   site/index.html            og:image and twitter:image as absolute addresses (a link preview needs them), a canonical
 *                              link and og:url, CONTACT_HREF ("Talk to us", the paid plans) and the footer's contact
 *                              (--contact), the documents' base (--docs-base github: keep them in the repository)
 *   SECURITY.md                the reporting address (--security)
 *   site/CNAME                 the custom domain, for the hosts that read it from the site (an Actions publish to GitHub Pages
 *                              takes it from the repository's Pages settings and ignores this file)
 *   site/robots.txt            allow everything, and the sitemap's address
 *   site/sitemap.xml           the one page
 *   site/security.txt          RFC 9116: the address and the repository's private reporting link (--security), expiring
 *   site/.well-known/security.txt   the same, at the path the RFC prefers (a host that drops dotfiles serves the first)
 *
 * It never touches LICENSE: its contact line is the Licensor's to set, with counsel, and a test pins the rest of the
 * file. It never registers, buys or publishes anything. Run it again with the same arguments and nothing changes (pass
 * --today to fix the date it writes); run it with new ones and it replaces what it wrote.
 *
 * Exit status: 0 done (or --check clean), 1 --check found something marked TODO(owner), 2 refused (bad arguments, or a
 * file that is not the shape this expects).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const USAGE =
  'usage: node scripts/set-domain.mjs <domain> --contact <email> [--security <email>] [--company "<name>"] [--docs-base github] [--dry-run] [--today YYYY-MM-DD] [--root <dir>]\n' +
  "       node scripts/set-domain.mjs --check [--root <dir>]";

const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/;
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function refuse(message) {
  console.error(`set-domain: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const out = { positional: [], flags: {} };
  const valued = new Set(["contact", "security", "company", "docs-base", "today", "root"]);
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

function applyToIndex(html, o) {
  let out = html;
  const image = `https://${o.domain}/assets/social-card.png`;
  const home = `https://${o.domain}/`;
  out = edit(out, /(<meta property="og:image" content=")[^"]*(">)/, `<meta property="og:image" content="${image}">`, "site/index.html og:image");
  out = edit(out, /(<meta name="twitter:image" content=")[^"]*(">)/, `<meta name="twitter:image" content="${image}">`, "site/index.html twitter:image");
  out = out.replace(/^<!-- TODO\(owner\): og:image[^\n]*-->\n/m, "");
  const canonical = `<link rel="canonical" href="${home}">`;
  const ogUrl = `<meta property="og:url" content="${home}">`;
  if (/<link rel="canonical" href="[^"]*">/.test(out)) out = out.replace(/<link rel="canonical" href="[^"]*">/, () => canonical);
  if (/<meta property="og:url" content="[^"]*">/.test(out)) out = out.replace(/<meta property="og:url" content="[^"]*">/, () => ogUrl);
  if (!/<link rel="canonical"/.test(out) || !/<meta property="og:url"/.test(out)) {
    // The pair goes after og:type; whichever of the two is already there is kept, so a run never doubles one.
    const missing = [!/<link rel="canonical"/.test(out) ? canonical : null, !/<meta property="og:url"/.test(out) ? ogUrl : null].filter(Boolean);
    out = edit(out, /<meta property="og:type" content="website">\n/, (found) => `${found}${missing.join("\n")}\n`, "site/index.html og:type (where the canonical link goes)");
  }
  if (o.contact) {
    out = edit(out, /var CONTACT_HREF = "[^"]*";[^\n]*/, `var CONTACT_HREF = "mailto:${o.contact}"; // "Talk to us" and the paid plans`, "site/index.html CONTACT_HREF");
    const who = o.company ? `${escapeHtml(o.company)} &middot; ` : "";
    out = edit(out, /<span id="contact">[\s\S]*?<\/span>/, `<span id="contact">${who}<a href="mailto:${o.contact}">${o.contact}</a></span>`, "site/index.html footer contact");
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

function generatedFiles(o, securityMd) {
  const files = {
    "site/CNAME": `${o.domain}\n`,
    "site/robots.txt": `User-agent: *\nAllow: /\n\nSitemap: https://${o.domain}/sitemap.xml\n`,
    "site/sitemap.xml": `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>https://${o.domain}/</loc><lastmod>${o.today}</lastmod></url>\n</urlset>\n`,
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

function check(root) {
  const lines = [];
  for (const rel of ["site/index.html", "SECURITY.md"]) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) refuse(`${rel} is missing under ${root}`);
    fs.readFileSync(file, "utf8")
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
  for (const name of ["contact", "security"]) {
    if (flags[name] !== undefined && !EMAIL.test(flags[name])) refuse(`--${name} "${flags[name]}" is not an email address`);
  }
  if (flags.company !== undefined && (flags.company.trim() === "" || flags.company.length > 120 || /[\r\n]/.test(flags.company))) {
    refuse("--company must be one line of at most 120 characters");
  }
  if (flags["docs-base"] !== undefined && flags["docs-base"] !== "github") {
    refuse('--docs-base takes only "github" (keep the documents in the repository); a documentation site is a change to the page and its test, by hand');
  }
  if (flags.company && !flags.contact) refuse("--company goes with --contact (the footer shows both)");
  const o = { domain, today, contact: flags.contact, security: flags.security, company: flags.company?.trim(), docsBase: flags["docs-base"] };

  const indexPath = path.join(root, "site", "index.html");
  const securityPath = path.join(root, "SECURITY.md");
  for (const [p, rel] of [[indexPath, "site/index.html"], [securityPath, "SECURITY.md"]]) {
    if (!fs.existsSync(p)) refuse(`${rel} is missing under ${root}`);
  }
  const index = fs.readFileSync(indexPath, "utf8");
  const security = fs.readFileSync(securityPath, "utf8");
  // The reporting address a previous run wrote to SECURITY.md stays the one security.txt names, so moving to a new domain
  // without repeating --security rewrites its canonical address and does not leave the old file behind.
  if (!o.security) {
    const written = /^- Email: (\S+)$/m.exec(security)?.[1];
    if (written && EMAIL.test(written)) o.security = written;
  }
  const writes = new Map([
    ["site/index.html", applyToIndex(index, o)],
    ["SECURITY.md", applyToSecurity(security, o)],
    ...Object.entries(generatedFiles(o, security)),
  ]);

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
  const left = ["site/index.html", "SECURITY.md"].reduce((n, rel) => n + (writes.get(rel).match(/TODO\(owner\)/g)?.length ?? 0), 0);
  console.log(
    `${flags["dry-run"] ? "dry run: " : ""}${changed} file(s) ${flags["dry-run"] ? "would change" : "written"} for https://${domain}/` +
      (left ? `; ${left} marker(s) still say TODO(owner): run with --check to list them` : "; no TODO(owner) is left"),
  );
}

main();
