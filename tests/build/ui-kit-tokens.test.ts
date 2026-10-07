import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

/**
 * The UI kit's tokens (scripts/kit-tokens.mjs) are the one set of numbers the site, the account pages and the console share:
 * the colour roles, the elevation ladder, the radii, the tracking and the motion. They are generated into each stylesheet between
 * two fence comments, so these cases hold three things: that no stylesheet differs from the script (a hand edit of a block fails
 * here and in `npm run brand:check`), that the kit starts from the brand's own colours and the console's own status colours
 * (which other tests pin), and that every text pair the kit offers clears the contrast it needs in both themes. A value nudged
 * by eye fails here and not on a person's screen.
 */

const ROOT = path.resolve(__dirname, "..", "..", "..");
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf8");

const BEGIN = "/* @kit:tokens begin";
const END = "/* @kit:tokens end */";

/** `--k-name: value` pairs of a block of CSS, name without the prefix. */
function decls(css: string): Record<string, string> {
  return Object.fromEntries([...css.matchAll(/--k-([\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}
/** The text of a stylesheet's kit block, and nothing else. */
function block(rel: string): string {
  const css = read(rel);
  assert.equal(css.split(BEGIN).length - 1, 1, `${rel} has exactly one kit block`);
  const a = css.indexOf(BEGIN);
  const b = css.indexOf(END);
  assert.ok(b > a, `${rel}: the block ends after it begins`);
  return css.slice(a, b + END.length);
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}
/** `fg` laid over `bg` at `pct` percent, as `color-mix(in srgb, fg pct%, bg)` does. */
function mix(fg: string, bg: string, pct: number): string {
  const ch = (i: number) => Math.round(parseInt(fg.slice(i, i + 2), 16) * (pct / 100) + parseInt(bg.slice(i, i + 2), 16) * (1 - pct / 100));
  return `#${[1, 3, 5].map((i) => ch(i).toString(16).padStart(2, "0")).join("")}`;
}

/** The two themes as the site and the account pages write them: light first, the dark setting in a media query. */
function themes(rel: string): { light: Record<string, string>; dark: Record<string, string> } {
  const text = block(rel);
  const light = /:root \{([\s\S]*?)\n\}/.exec(text)![1]!;
  const dark = /@media \(prefers-color-scheme: dark\) \{\s*:root \{([\s\S]*?)\n  \}/.exec(text)![1]!;
  return { light: decls(light), dark: decls(dark) };
}

test("no stylesheet differs from the script that writes its kit block", () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "build-brand.mjs"), "--check"], { encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

test("the three stylesheets carry the same kit, and brand/kit.css is it on its own", () => {
  const kit = themes("brand/kit.css");
  for (const rel of ["site/assets/site.css", "apps/cloud-server/pages/assets/app.css"]) {
    const t = themes(rel);
    assert.deepEqual(t.light, kit.light, `${rel}: light`);
    assert.deepEqual(t.dark, kit.dark, `${rel}: dark`);
  }
  // The console writes dark first and the light theme as an attribute; the values are the same ones.
  const consoleText = block("apps/mesh-dashboard/src/styles.css");
  const dark = decls(/:root \{([\s\S]*?)\n\}/.exec(consoleText)![1]!);
  const light = decls(/\[data-theme="light"\] \{([\s\S]*?)\n\}/.exec(consoleText)![1]!);
  // `kit.light` also holds the shared tokens (they sit in the same :root); the console's dark :root holds them too.
  assert.deepEqual(light, Object.fromEntries(Object.entries(kit.light).filter(([k]) => k in kit.dark)), "console light");
  assert.deepEqual(dark, { ...Object.fromEntries(Object.entries(kit.light).filter(([k]) => !(k in kit.dark))), ...kit.dark }, "console dark");
});

test("the kit starts from the brand's colours", () => {
  const tokens = read("brand/tokens.css");
  const brandLight = Object.fromEntries([...(/^:root \{([\s\S]*?)\n\}/m.exec(tokens)![1]!).matchAll(/--curule-([\w-]+):\s*(#[0-9a-f]{6})/g)].map((m) => [m[1]!, m[2]!]));
  const brandDark = Object.fromEntries([...(/^:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/m.exec(tokens)![1]!).matchAll(/--curule-([\w-]+):\s*(#[0-9a-f]{6})/g)].map((m) => [m[1]!, m[2]!]));
  const kit = themes("brand/kit.css");
  const map = { bg: "paper", surface: "panel", ink: "ink", muted: "muted", line: "line", accent: "blue", "on-accent": "on-blue" } as const;
  for (const [role, brand] of Object.entries(map)) {
    assert.equal(kit.light[role], brandLight[brand], `light ${role} is the brand's ${brand}`);
    assert.equal(kit.dark[role], brandDark[brand], `dark ${role} is the brand's ${brand}`);
  }
});

test("the kit's status colours are the console's, which console-palette.test.ts holds to a contrast target", () => {
  const css = read("apps/mesh-dashboard/src/styles.css");
  const root = /:root \{([\s\S]*?)\n\}/.exec(css.replace(/\/\* @kit:tokens begin[\s\S]*?@kit:tokens end \*\//, ""))![1]!;
  const lightRoot = /\[data-theme="light"\] \{([\s\S]*?)\n\}/.exec(css.replace(/\/\* @kit:tokens begin[\s\S]*?@kit:tokens end \*\//, ""))![1]!;
  const pick = (text: string, name: string) => new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(text)![1]!.toLowerCase();
  const kit = themes("brand/kit.css");
  for (const name of ["ok", "warn", "bad", "info"]) {
    assert.equal(kit.dark[name], pick(root, name), `dark ${name}`);
    assert.equal(kit.light[name], pick(lightRoot, name), `light ${name}`);
  }
});

test("every text pair the kit offers clears its contrast in both themes", () => {
  const kit = themes("brand/kit.css");
  for (const [theme, t] of [["light", kit.light], ["dark", kit.dark]] as const) {
    const pairs: Array<[string, string, string]> = [
      ["ink on bg", t.ink!, t.bg!],
      ["ink on surface", t.ink!, t.surface!],
      ["ink-2 on bg", t["ink-2"]!, t.bg!],
      ["ink-2 on surface", t["ink-2"]!, t.surface!],
      ["muted on bg", t.muted!, t.bg!],
      ["muted on surface", t.muted!, t.surface!],
      ["muted on surface-2", t.muted!, t["surface-2"]!],
      ["muted on sunken", t.muted!, t.sunken!],
      ["accent-ink on surface", t["accent-ink"]!, t.surface!],
      ["accent-ink on accent-soft", t["accent-ink"]!, t["accent-soft"]!],
      ["on-accent on accent", t["on-accent"]!, t.accent!],
      ["on-accent on accent-hover", t["on-accent"]!, t["accent-hover"]!],
      ["on-accent on accent-press", t["on-accent"]!, t["accent-press"]!],
    ];
    for (const status of ["ok", "warn", "bad", "info"]) {
      pairs.push([`${status} on surface`, t[status]!, t.surface!]);
      // A chip tinted with its own hue lands on the darkest ground it can: 14% of itself over the sunken surface.
      pairs.push([`${status} at a 14% self-tint over sunken`, t[status]!, mix(t[status]!, t.sunken!, 14)]);
    }
    for (const [what, fg, bg] of pairs) {
      const ratio = contrast(fg, bg);
      assert.ok(ratio >= 4.5, `${theme}: ${what} (${fg} on ${bg}) is ${ratio.toFixed(2)}:1, below the 4.5:1 text needs`);
    }
    for (const ground of ["surface", "sunken"]) {
      const ratio = contrast(t["line-control"]!, t[ground]!);
      assert.ok(ratio >= 3, `${theme}: the edge of a field on ${ground} is ${ratio.toFixed(2)}:1, below the 3:1 a control boundary needs`);
    }
  }
});

test("the elevation ladder has five rungs and the motion tokens are durations and curves", () => {
  const kit = themes("brand/kit.css");
  for (const t of [kit.light, kit.dark]) {
    for (const n of [1, 2, 3, 4, 5]) assert.ok(t[`shadow-${n}`], `shadow-${n}`);
  }
  for (const d of ["dur-1", "dur-2", "dur-3"]) assert.match(kit.light[d]!, /^\d+ms$/, d);
  assert.ok(Number.parseInt(kit.light["dur-1"]!) < Number.parseInt(kit.light["dur-2"]!) && Number.parseInt(kit.light["dur-2"]!) < Number.parseInt(kit.light["dur-3"]!), "durations rise");
  for (const e of ["ease", "ease-io"]) assert.match(kit.light[e]!, /^cubic-bezier\(/, e);
  for (const r of ["r-xs", "r-sm", "r-md", "r-lg", "r-xl", "r-pill"]) assert.match(kit.light[r]!, /^\d+px$/, r);
});
