/**
 * The console's icon set (apps/mesh-dashboard/src/icons.tsx) stays the size of the interface and stays on the grid.
 *
 * - every icon is used: an icon nothing draws is dead weight shipped to every browser, and the set is meant to be exactly
 *   what the interface needs;
 * - nothing outside the registry names an icon that is not in it (TypeScript already refuses `<Icon name="typo">`, so this
 *   guards the places that hold a name as a string and are only checked when someone looks: a nav table, a menu entry);
 * - an icon takes its colour from the text it sits in: no colour literal, only `currentColor`, so it flips with the theme;
 * - an icon is drawn on the 20-unit grid.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(e.name) ? [full] : [];
  });
}

const iconsSource = fs.readFileSync(path.join(SRC, "icons.tsx"), "utf8");
const registry = iconsSource.slice(iconsSource.indexOf("const ICONS = {"), iconsSource.indexOf("} satisfies Record<string, ReactNode>;"));
const names = [...registry.matchAll(/^ {2}"?([a-z][a-z-]*)"?: \(?/gm)].map((m) => m[1]!);
const others = walk(SRC).filter((f) => path.basename(f) !== "icons.tsx").map((f) => [f, fs.readFileSync(f, "utf8")] as const);

test("the registry parses into a real set of unique, kebab-case names", () => {
  assert.ok(names.length >= 30, `found ${names.length} icons`);
  assert.equal(new Set(names).size, names.length, "no name is drawn twice");
});

test("every icon is used somewhere in the console", () => {
  const unused = names.filter((n) => !others.some(([, text]) => new RegExp(`["'\`]${n}["'\`]`).test(text)));
  assert.deepEqual(unused, [], "icons nothing uses: delete them, or use them");
});

test("every icon named by a string table or an `icon` prop exists", () => {
  const known = new Set(names);
  const missing: string[] = [];
  for (const [file, text] of others) {
    for (const m of text.matchAll(/\bicon: "([a-z-]+)"|\bicon="([a-z-]+)"|<Icon name="([a-z-]+)"/g)) {
      const name = m[1] ?? m[2] ?? m[3]!;
      if (!known.has(name)) missing.push(`${path.relative(SRC, file)}: ${name}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("icons take their colour from the text: no literal, only currentColor, drawn on the 20 grid", () => {
  assert.doesNotMatch(registry, /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/, "no colour literal in a drawing");
  assert.doesNotMatch(registry, /stroke="(?!none")/, "a stroke is inherited from <Icon>, which sets currentColor");
  assert.match(iconsSource, /viewBox="0 0 20 20"/);
  assert.match(iconsSource, /stroke="currentColor"/);
});
