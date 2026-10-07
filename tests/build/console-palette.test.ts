/**
 * The console's colour tokens (apps/mesh-dashboard/src/styles.css), checked against the rules in docs/design-spec.md section 2
 * and against the brand palette they share their neutrals with (brand/tokens.css).
 *
 * The console is rendered from tokens alone (no raw hex outside the two token blocks), so a palette is correct or wrong in
 * these two blocks and nowhere else. This recomputes every pair the spec cares about, in both themes, so a value nudged by
 * eye that stops clearing WCAG fails here and not on a user's screen:
 *
 * - body, dim and muted text on every surface a card, drawer or well can sit on (4.5:1; primary text 7:1);
 * - the link/accent text colour on every surface (4.5:1) and the edge of a control on every surface (3:1);
 * - each semantic colour as text on a chip tinted with its own hue at 14% (the `.pill` recipe), over the darkest surface
 *   in the theme and over the others (4.5:1), and as plain text on a panel (4.5:1);
 * - text on a filled accent and on a filled "bad" button (4.5:1).
 *
 * It also pins the neutrals the console shares with the brand (paper, panel, ink, line), so the site and the product stay one
 * family, and that no colour literal appears in the stylesheets outside those blocks.
 *
 * The console's surfaces, lines and text are the kit's roles under the console's names (--panel is var(--k-surface), --text-dim is
 * the kit's second ink), so a pair is resolved through the generated kit block too: if the kit's value moves, the pairs here are
 * recomputed against it. The accent, the status colours and the page ground of the light theme are the console's own literals.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), "utf8");

type Rgb = [number, number, number];
const toRgb = (hex: string): Rgb => {
  const h = hex.replace("#", "");
  assert.match(h, /^[0-9a-f]{6}$/i, `a six-digit hex colour: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
};
const lin = (c: number): number => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = (c: Rgb): number => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const contrast = (a: Rgb, b: Rgb): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** `color-mix(in srgb, fg N%, transparent)` painted over an opaque surface. */
const tint = (fg: Rgb, surface: Rgb, share: number): Rgb => surface.map((s, i) => Math.round(s + (fg[i]! - s) * share)) as Rgb;

/** The declarations inside the first block that opens with `selector {`. */
function block(css: string, selector: string): string {
  const open = css.indexOf(`${selector} {`);
  assert.ok(open >= 0, `${selector} block exists`);
  let depth = 0;
  for (let i = css.indexOf("{", open); i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(css.indexOf("{", open) + 1, i);
  }
  throw new Error(`${selector} block never closes`);
}
function declarations(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) out[m[1]!] = m[2]!.trim();
  return out;
}

const css = read("apps/mesh-dashboard/src/styles.css");
const KIT_BLOCK = /\/\* @kit:tokens begin[\s\S]*?@kit:tokens end \*\//;
// The console names its surfaces, lines and text after the kit's roles (--panel is var(--k-surface)), so a name is resolved through the
// generated kit block as well as through the console's own two blocks: the kit's dark values, then the console's own dark ones, and in
// light the kit's light values and then the console's own light ones over them.
const kitText = KIT_BLOCK.exec(css)![0];
const own = css.replace(KIT_BLOCK, "");
const dark = { ...declarations(block(kitText, ":root")), ...declarations(block(own, ":root")) };
const light = { ...dark, ...declarations(block(kitText, '[data-theme="light"]')), ...declarations(block(own, '[data-theme="light"]')) };
const brand = (() => {
  const text = read("brand/tokens.css");
  const lightBrand = declarations(block(text, ":root"));
  const darkBrand = declarations(block(text, ':root[data-theme="dark"]'));
  return { light: lightBrand, dark: darkBrand };
})();

const SURFACES = ["--bg", "--bg-2", "--panel", "--panel-2", "--drawer", "--raised", "--sunken"] as const;
const SEMANTIC = ["--accent", "--accent-2", "--ok", "--warn", "--bad", "--rej", "--info", "--role-pm", "--role-explorer"] as const;

/** Resolve `var(--x)` aliases (the role colours point at core tokens). */
function colour(theme: Record<string, string>, name: string): Rgb {
  let value = theme[name];
  for (let hops = 0; value !== undefined && value.startsWith("var("); hops++) {
    assert.ok(hops < 4, `${name} alias chain`);
    value = theme[value.slice(4, -1).trim()];
  }
  assert.ok(value !== undefined, `${name} is defined`);
  return toRgb(value);
}
/** The six-digit hex a name resolves to, lower case. */
const hex = (theme: Record<string, string>, name: string): string => `#${colour(theme, name).map((n) => n.toString(16).padStart(2, "0")).join("")}`;

for (const [name, theme] of [["dark", dark], ["light", light]] as const) {
  test(`${name}: text, links and control edges clear WCAG on every surface`, () => {
    for (const s of SURFACES) {
      const surface = colour(theme, s);
      assert.ok(contrast(colour(theme, "--text"), surface) >= 7, `--text on ${s}`);
      assert.ok(contrast(colour(theme, "--text-dim"), surface) >= 4.5, `--text-dim on ${s}`);
      assert.ok(contrast(colour(theme, "--muted"), surface) >= 4.5, `--muted on ${s}`);
      assert.ok(contrast(colour(theme, "--accent-2"), surface) >= 4.5, `--accent-2 (link text) on ${s}`);
      assert.ok(contrast(colour(theme, "--line-control"), surface) >= 3, `--line-control (a control's edge) on ${s}`);
    }
    assert.ok(contrast(colour(theme, "--text-on-accent"), colour(theme, "--accent")) >= 4.5, "text on a filled accent");
    assert.ok(contrast(colour(theme, "--text-on-hot"), colour(theme, "--bad")) >= 4.5, "text on a filled bad button");
  });

  test(`${name}: a semantic colour is readable as text on its own 14% tint over every surface, and on a panel`, () => {
    // The darkest surface of the theme is the hard case: the tint moves the ground towards the text.
    const surfaces = name === "light" ? ["--sunken", "--panel-2", "--bg", "--panel"] : ["--sunken", "--panel", "--panel-2", "--raised"];
    for (const k of SEMANTIC) {
      const fg = colour(theme, k);
      for (const s of surfaces) {
        const r = contrast(fg, tint(fg, colour(theme, s), 0.14));
        assert.ok(r >= 4.5, `${k} on its 14% tint over ${s}: ${r.toFixed(2)}`);
      }
    }
    for (const k of ["--ok", "--warn", "--bad", "--rej", "--info"] as const) {
      assert.ok(contrast(colour(theme, k), colour(theme, "--panel")) >= 4.5, `${k} as plain text on a panel`);
    }
  });
}

test("the console shares its neutrals with the brand: paper, panel, ink and line", () => {
  assert.equal(hex(light, "--bg-2"), brand.light["--curule-paper"], "the light sidebar is the brand paper");
  assert.equal(hex(light, "--panel"), brand.light["--curule-panel"]);
  assert.equal(hex(light, "--text"), brand.light["--curule-ink"]);
  assert.equal(hex(light, "--muted"), brand.light["--curule-muted"]);
  assert.equal(hex(light, "--line"), brand.light["--curule-line"]);
  assert.equal(hex(dark, "--bg"), brand.dark["--curule-paper"], "the dark ground is the brand's dark surface");
  assert.equal(hex(dark, "--panel"), brand.dark["--curule-panel"]);
  assert.equal(hex(dark, "--text"), brand.dark["--curule-ink"]);
  assert.equal(hex(dark, "--line"), brand.dark["--curule-line"]);
  assert.equal(hex(dark, "--accent"), brand.dark["--curule-blue"], "the dark accent is the brand blue");
  // The light accent is the brand blue taken down a notch, because as text on its own tint the brand blue itself is 3.9:1.
  assert.ok(contrast(colour(light, "--accent"), toRgb(brand.light["--curule-blue"]!)) < 1.3, "close to the brand blue");
});

/** Every stylesheet under the console's source, so a new one is covered the day it is added. */
function stylesheets(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    return e.isDirectory() ? stylesheets(rel) : e.name.endsWith(".css") ? [rel] : [];
  });
}

test("no colour literal appears in the console's stylesheets outside the token blocks", () => {
  const files = stylesheets("apps/mesh-dashboard/src");
  assert.ok(files.includes("apps/mesh-dashboard/src/styles.css") && files.length >= 2, "the sweep finds the stylesheets");
  for (const file of files) {
    // The UI kit's block is generated (scripts/kit-tokens.mjs) and held by tests/build/ui-kit-tokens.test.ts: it is a third token block.
    let text = read(file).replace(KIT_BLOCK, "").replace(/\/\*[\s\S]*?\*\//g, "");
    if (file.endsWith("/src/styles.css")) {
      for (const selector of [":root", '[data-theme="light"]']) text = text.replace(block(text, selector), "");
    }
    const literals = text.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    assert.deepEqual(literals, [], `${file} uses tokens, not literals`);
  }
});
