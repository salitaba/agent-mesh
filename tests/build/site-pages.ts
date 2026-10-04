/**
 * The pages of the site as the tests read them. Not a test itself (the runner only runs `*.test.js`): the structure tests
 * (site.test.ts), the claims tests (site-copy.test.ts) and the brand tests (brand-assets.test.ts) all start from the same
 * list, which is whatever `site/` holds, so a page added tomorrow is held to every rule without anyone listing it here.
 */
import * as fs from "fs";
import * as path from "path";

export const ROOT = path.resolve(__dirname, "..", "..", "..");
export const SITE = path.join(ROOT, "site");

export interface Page {
  /** The file below site/: "index.html", "pricing/index.html", "404.html". */
  rel: string;
  /** Its address below the domain ("" for the home page, "pricing/"), or null for the page that is shown when none is found. */
  address: string | null;
  /** The file as it is. */
  html: string;
  /** The markup a browser acts on: without comments and without scripts. */
  markup: string;
  /** What a visitor reads, as plain text. */
  copy: string;
  /** The same without the blocks that scripts/export-pricing.mjs writes from the plan table (they are right by construction). */
  prose: string;
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&rsquo;": "'", "&lsquo;": "'", "&ldquo;": '"', "&rdquo;": '"', "&middot;": "·", "&infin;": "∞", "&nbsp;": " ", "&mdash;": "—", "&ndash;": "–" };
export const decode = (s: string): string => s.replace(/&[a-z]+;/g, (e) => ENTITIES[e] ?? e);

/** The blocks written from the plan table: the cards, the tables and the data. */
const PRICING_BLOCKS = /<!-- generated:([\w-]+):start \(scripts\/export-pricing\.mjs[^>]*-->[\s\S]*?<!-- generated:\1:end -->/g;

export const textOf = (html: string): string =>
  decode(
    html
      .replace(/<script[\s\S]*?<\/script>/g, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<style[\s\S]*?<\/style>/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );

function build(rel: string, address: string | null): Page {
  const html = fs.readFileSync(path.join(SITE, rel), "utf8");
  return {
    rel,
    address,
    html,
    markup: html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<!--[\s\S]*?-->/g, ""),
    copy: textOf(html),
    prose: textOf(html.replace(PRICING_BLOCKS, " ")),
  };
}

/** The home page, each folder's index.html one level down, and 404.html, in that order. */
export function sitePages(): Page[] {
  const pages: Page[] = [];
  if (fs.existsSync(path.join(SITE, "index.html"))) pages.push(build("index.html", ""));
  for (const entry of fs.readdirSync(SITE, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && fs.existsSync(path.join(SITE, entry.name, "index.html"))) pages.push(build(`${entry.name}/index.html`, `${entry.name}/`));
  }
  if (fs.existsSync(path.join(SITE, "404.html"))) pages.push(build("404.html", null));
  return pages;
}

/** The pages with an address of their own: everything but 404.html. */
export const shareable = (pages: Page[]): Page[] => pages.filter((p) => p.address !== null);

export function page(pages: Page[], rel: string): Page {
  const found = pages.find((p) => p.rel === rel);
  if (!found) throw new Error(`site/${rel} is missing`);
  return found;
}

/** Every file below a folder, as paths relative to it. */
export function walk(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel === "" ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(dir, r));
    else out.push(r);
  }
  return out.sort();
}

/** The pixel size of a PNG or a JPEG, read from its header. */
export function imageSize(file: string): { width: number; height: number } {
  const b = fs.readFileSync(file);
  if (b.subarray(1, 4).toString("latin1") === "PNG") return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new Error(`${file} is neither a PNG nor a JPEG`);
  let i = 2;
  while (i + 4 < b.length) {
    if (b[i] !== 0xff) throw new Error(`${file}: a JPEG segment starts at ${i} without its marker`);
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + b.readUInt16BE(i + 2);
  }
  throw new Error(`${file}: no frame header found`);
}

/** GitHub's heading anchors, as tests/build/docs-links.test.ts computes them. */
export function slug(heading: string): string {
  return heading.trim().toLowerCase().replace(/`/g, "").replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s/g, "-");
}

export function headingAnchors(markdownFile: string): Set<string> {
  const out = new Set<string>();
  const seen = new Map<string, number>();
  let fenced = false;
  for (const line of fs.readFileSync(markdownFile, "utf8").split("\n")) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = slug(m[1]!);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}
