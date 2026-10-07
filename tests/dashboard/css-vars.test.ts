/**
 * A stylesheet that reads `var(--name)` where nothing sets `--name` does not fail. The declaration is dropped and the property falls back to
 * its initial value: a radius of 0, a colour of nothing. A row of cards lost its rounded corners that way (`var(--r-md)`: the radii are
 * --r-sm, --r, --r-lg and --r-xl) and no test noticed, because the page still rendered. This reads every stylesheet of the console and
 * every place a script sets a custom property, and fails on one that is read without a fallback and set nowhere.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");

function walk(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out);
    else if (ext.test(e.name)) out.push(p);
  }
  return out;
}

test("every custom property a stylesheet reads without a fallback is set somewhere", () => {
  const sheets = walk(SRC, /\.css$/);
  const scripts = walk(SRC, /\.tsx?$/);
  assert.ok(sheets.length >= 10, `found ${sheets.length} stylesheets`);

  const set = new Set<string>();
  for (const f of [...sheets, ...scripts]) {
    // `--name:` in a rule, `"--name":` or `--name:` in a style object a component passes.
    for (const m of fs.readFileSync(f, "utf8").matchAll(/(--[\w-]+)\s*["']?\s*:/g)) set.add(m[1]!);
  }
  assert.ok(set.has("--panel") && set.has("--r") && set.has("--tint"), "the roles, the radius and the seat tint are among those set");

  const unset: string[] = [];
  for (const f of sheets) {
    const css = fs.readFileSync(f, "utf8");
    for (const m of css.matchAll(/var\((--[\w-]+)\s*(,[^)]*)?\)/g)) {
      if (m[2] === undefined && !set.has(m[1]!)) unset.push(`${path.relative(SRC, f)}: ${m[1]}`);
    }
  }
  assert.deepEqual([...new Set(unset)].sort(), [], "a variable read and never set: use one of the tokens (the radii are --r-sm, --r, --r-lg, --r-xl)");
});
