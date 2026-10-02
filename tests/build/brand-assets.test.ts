/**
 * The Ordane brand files (brand/), and every place that carries a copy of one of them.
 *
 * A logo that exists in six places (the kit, the site, the dashboard sidebar and sign-in, the README, the favicon in
 * the dashboard's HTML) is a logo that will be edited in one of them. The kit is generated from one description
 * (scripts/build-brand.mjs); this keeps the generated files current, the copies equal to them, the PNGs the sizes the
 * pages promise, and the colours the documents quote the colours the site really uses, at a contrast the web accepts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), "utf8");
const bytes = (file: string): Buffer => fs.readFileSync(path.join(ROOT, file));

test("the checked-in brand files are what the generator writes", () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "build-brand.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
});

test("every logo file is self-contained and named, and only the adaptive ones follow the visitor's setting", () => {
  const svgs = fs.readdirSync(path.join(ROOT, "brand")).filter((f) => f.endsWith(".svg"));
  assert.deepEqual(svgs.sort(), [
    "app-icon.svg", "favicon.svg", "ordane-logo-dark.svg", "ordane-logo-light.svg", "ordane-logo-mono.svg", "ordane-logo.svg",
    "ordane-mark-dark.svg", "ordane-mark-light.svg", "ordane-mark-mono.svg", "ordane-mark.svg",
  ]);
  for (const file of svgs) {
    const text = read(`brand/${file}`);
    assert.match(text, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="[\d. -]+" role="img" aria-label="Ordane">/, file);
    assert.match(text, /<title>Ordane<\/title>/, `${file} is named`);
    assert.ok(!/<script|<image|<foreignObject|href=|@import|url\(|https?:\/\/(?!www\.w3\.org\/2000\/svg)/.test(text), `${file} references nothing outside itself`);
    assert.ok(text.endsWith("</svg>\n"), `${file} is one document`);
  }
  for (const adaptive of ["ordane-logo.svg", "ordane-mark.svg", "favicon.svg"]) {
    const text = read(`brand/${adaptive}`);
    assert.match(text, /@media \(prefers-color-scheme:dark\)/, `${adaptive} follows the visitor's setting`);
    assert.match(text, /\.ink\{stroke:#efece6\}\.seat\{fill:#7ba0ff\}/, `${adaptive}: pale letters and a light blue seat in the dark`);
  }
  for (const fixed of ["ordane-logo-light.svg", "ordane-logo-dark.svg", "ordane-mark-light.svg", "ordane-mark-dark.svg", "app-icon.svg"]) {
    assert.ok(!/@media|<style/.test(read(`brand/${fixed}`)), `${fixed} is one fixed look`);
  }
  assert.match(read("brand/ordane-logo-light.svg"), /stroke="#1c1b1a"[^>]*\/>.*fill="#2b5fd9"/s);
  assert.match(read("brand/ordane-logo-dark.svg"), /stroke="#efece6"[^>]*\/>.*fill="#7ba0ff"/s);
  assert.ok(read("brand/ordane-logo-mono.svg").includes('stroke="currentColor"') && !/#[0-9a-f]{6}/i.test(read("brand/ordane-logo-mono.svg")), "the one-colour logo takes its colour from the text around it");
});

/** Width and height from a PNG's IHDR chunk. */
function pngSize(file: string): [number, number] {
  const b = bytes(file);
  assert.equal(b.subarray(1, 4).toString("latin1"), "PNG", `${file} is a PNG`);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

test("the PNGs are the sizes the pages promise", () => {
  assert.deepEqual(pngSize("brand/apple-touch-icon.png"), [180, 180]);
  assert.deepEqual(pngSize("brand/icon-512.png"), [512, 512]);
  assert.deepEqual(pngSize("brand/social-card.png"), [1200, 630]);
  const site = read("site/index.html");
  assert.match(site, /<meta property="og:image:width" content="1200">/, "the site says the card is 1200 wide");
  assert.match(site, /<meta property="og:image:height" content="630">/, "and 630 tall");
  assert.ok(bytes("brand/social-card.png").length < 200_000, "a link preview should be light");
});

test("the copies of the logo are the kit's: the site's files, its inline logo, the dashboard's component and favicon", () => {
  for (const f of ["favicon.svg", "apple-touch-icon.png", "social-card.png"]) {
    assert.ok(bytes(`brand/${f}`).equals(bytes(`site/assets/${f}`)), `site/assets/${f} differs from brand/${f}: copy it again`);
  }
  const logo = read("brand/ordane-logo.svg");
  const d = /<path class="ink" d="([^"]+)"/.exec(logo)![1]!;
  const ring = /<circle class="ink" cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/.exec(logo)!.slice(1);
  const seat = /<circle class="seat" cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/.exec(logo)!.slice(1);
  const box = /viewBox="([\d. ]+)"/.exec(logo)![1]!;

  const site = read("site/index.html");
  assert.ok(site.includes(`d="${d}"`), "the site draws the same letters");
  assert.ok(site.includes(`<svg class="logo" viewBox="${box}"`), "in the same box");
  assert.ok(site.includes(`<circle class="ink" cx="${ring[0]}" cy="${ring[1]}" r="${ring[2]}"`) && site.includes(`<circle class="seat" cx="${seat[0]}" cy="${seat[1]}" r="${seat[2]}"`), "with the same ring and seat");
  assert.match(site, /<link rel="icon" href="assets\/favicon\.svg" type="image\/svg\+xml">/);
  assert.match(site, /<link rel="apple-touch-icon" href="assets\/apple-touch-icon\.png">/);

  const component = read("apps/mesh-dashboard/src/components.tsx");
  assert.ok(component.includes(`d="${d}"`), "the dashboard component draws the same letters");
  assert.ok(component.includes(`viewBox="${box}"`));
  assert.ok(component.includes(`<circle cx="${ring[0]}" cy="${ring[1]}" r="${ring[2]}"`) && component.includes(`<circle cx="${seat[0]}" cy="${seat[1]}" r="${seat[2]}"`));
  assert.match(read("apps/mesh-dashboard/src/shell.tsx"), /<Wordmark height=\{22\} \/>/, "the sidebar carries the logo");
  assert.match(read("apps/mesh-dashboard/src/auth.tsx"), /<Wordmark height=\{30\} \/>/, "and so does the sign-in page");

  // The dashboard's tab icon is the kit's favicon, written into the page as a data address.
  const html = read("apps/mesh-dashboard/index.html");
  const uri = /<link rel="icon" href="data:image\/svg\+xml,([^"]+)"/.exec(html)![1]!;
  const decoded = decodeURIComponent(uri).replace(/'/g, '"');
  for (const circle of read("brand/favicon.svg").match(/<circle [^>]+\/>/g)!) assert.ok(decoded.includes(circle), `the dashboard's favicon has ${circle}`);
  assert.ok(decoded.includes("prefers-color-scheme:dark"), "and follows the setting too");

  const readme = read("README.md");
  assert.match(readme, /srcset="brand\/ordane-logo-dark\.svg"/);
  assert.match(readme, /<img src="brand\/ordane-logo-light\.svg" alt="Ordane"/);
});

// ------------------------------------------------------------------------------------------------ colour

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** `--name: #hex` pairs in a block of CSS. */
function vars(css: string): Record<string, string> {
  return Object.fromEntries([...css.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => [m[1]!, m[2]!.toLowerCase()]));
}

test("the colours are the site's colours, and every text pair clears WCAG AA", () => {
  const tokens = read("brand/tokens.css");
  const light = vars(/^:root \{([\s\S]*?)\n\}/m.exec(tokens)![1]!);
  const dark = vars(/^:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/m.exec(tokens)![1]!);
  assert.equal(Object.keys(light).length, 7);
  assert.deepEqual(Object.keys(dark), Object.keys(light));

  // The site's own custom properties are these values under other names.
  const site = read("site/index.html");
  const siteLight = vars(/:root \{([\s\S]*?)\n\}/.exec(site)![1]!);
  const siteDark = vars(/@media \(prefers-color-scheme: dark\) \{\s*:root \{([\s\S]*?)\}\s*\}/.exec(site)![1]!);
  const names = { paper: "--bg", panel: "--panel", ink: "--ink", muted: "--muted", line: "--line", blue: "--accent", "on-blue": "--accent-ink" } as const;
  for (const [token, siteName] of Object.entries(names)) {
    assert.equal(light[`--ordane-${token}`], siteLight[siteName], `light ${token} is the site's ${siteName}`);
    assert.equal(dark[`--ordane-${token}`], siteDark[siteName], `dark ${token} is the site's ${siteName}`);
  }

  const doc = read("docs/brand.md");
  for (const [theme, set] of [["light", light], ["dark", dark]] as const) {
    const pairs: Array<[string, string, string]> = [
      ["ink", set["--ordane-ink"]!, set["--ordane-paper"]!],
      ["muted", set["--ordane-muted"]!, set["--ordane-paper"]!],
      ["blue", set["--ordane-blue"]!, set["--ordane-paper"]!],
      ["on blue", set["--ordane-on-blue"]!, set["--ordane-blue"]!],
    ];
    for (const [what, fg, bg] of pairs) {
      const ratio = contrast(fg, bg);
      assert.ok(ratio >= 4.5, `${theme} ${what} ${fg} on ${bg} is ${ratio.toFixed(2)}:1, below the 4.5:1 text needs`);
      assert.ok(doc.includes(`${ratio.toFixed(1)} : 1`), `docs/brand.md quotes ${ratio.toFixed(1)} : 1 for ${theme} ${what}`);
    }
    for (const [token, hex] of Object.entries(set)) assert.ok(doc.includes(`\`${hex}\``), `docs/brand.md lists ${theme} ${token} ${hex}`);
  }
  // The seat must be seen against both tiles of the app icon too: graphics need 3:1.
  assert.ok(contrast(dark["--ordane-blue"]!, light["--ordane-ink"]!) >= 3, "the seat on the icon's ink tile");
  assert.ok(contrast(dark["--ordane-ink"]!, light["--ordane-ink"]!) >= 3, "the ring on the icon's ink tile");
});

test("the guide and the kit are reachable from the places a person starts", () => {
  assert.match(read("brand/README.md"), /\[docs\/brand\.md\]\(\.\.\/docs\/brand\.md\)/);
  assert.match(read("docs/brand.md"), /\[`brand\/`\]\(\.\.\/brand\/README\.md\)/);
  const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts["brand:build"], "node scripts/build-brand.mjs");
  assert.equal(pkg.scripts["brand:check"], "node scripts/build-brand.mjs --check");
});
