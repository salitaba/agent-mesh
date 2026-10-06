/**
 * Gives the addresses of the stylesheet and the scripts a fingerprint of their content, so that a page can only ever be read with
 * the files it was written for.
 *
 * A page names its files as `assets/site.css?v=3f9a1c2b4e`. The query changes whenever the file's bytes do and at no other time, so a
 * browser (and a cache between it and the host) that kept an older copy of the file asks for the new address, and gets the new file.
 * Without it the pages and the stylesheet are cached on their own clocks (GitHub Pages lets a browser keep a file for ten minutes
 * without asking), and a visitor can be given today's page with last week's stylesheet: the marks the page draws had no rule, and
 * filled their cards in black. The files stay where they are, under the names they have; a host ignores the query.
 *
 * Only the files that change from one release to the next are fingerprinted (the stylesheet and the two scripts). The images are
 * under stable names that are only replaced when a picture is retaken, which does no harm to a page that has the older one.
 *
 * This is a library for the scripts that write pages: scripts/site-chrome.mjs writes the fingerprints with the header and the
 * footer (and its --check, which a test runs, says when they are out of date), and scripts/set-domain.mjs, which changes site.js,
 * writes the new one into the pages it writes. After editing site/assets/site.css, site.js or pricing.js, run
 * `node scripts/site-chrome.mjs`.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** The files, below site/assets/, that a page loads and that change from one release to the next. */
export const VERSIONED = ["site.css", "site.js", "pricing.js"];

/** Ten hex digits of the SHA-256 of the file's text: short enough to read in an address, and a different file has a different one. */
export function fingerprint(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 10);
}

/**
 * The fingerprint of each versioned file that exists under `siteDir`, by name. `texts` stands in for the files that are about to
 * be written (scripts/set-domain.mjs changes site.js and writes pages in the same run), so that the pages agree with what the
 * folder will hold, and not with what it held a moment before.
 */
export function fingerprints(siteDir, texts = {}) {
  const out = {};
  for (const name of VERSIONED) {
    const file = path.join(siteDir, "assets", name);
    if (texts[name] !== undefined) out[name] = fingerprint(texts[name]);
    else if (fs.existsSync(file)) out[name] = fingerprint(fs.readFileSync(file, "utf8"));
  }
  return out;
}

/**
 * Every place a page loads one of the versioned files: the stylesheet's `href` and the scripts' `src`, relative to the page
 * ("assets/", "../assets/") or from the root (404.html, which is shown at any depth).
 */
const REFERENCE = /(\b(?:href|src)=")((?:\.\.\/|\/)?assets\/)(site\.css|site\.js|pricing\.js)(?:\?v=[0-9a-f]*)?(")/g;

/** `html` with each reference carrying the fingerprint that `prints` has for its file (a file that has none is left as it is). */
export function stampAssets(html, prints) {
  return html.replace(REFERENCE, (whole, open, dir, name, close) => (prints[name] === undefined ? whole : `${open}${dir}${name}?v=${prints[name]}${close}`));
}
