/**
 * The console sets type on one ramp: 11 12 13 14 15 16 18 20 24 30 px (docs/design-spec.md §3). A figure set at 32 px, a heading at 22, a label at
 * 10 look the same as their neighbours in a screenshot and are not: they are a tenth size, and each one is the start of the next. Nothing
 * checked it, and four of them got in while the pages were redrawn. This reads every size every stylesheet of the console sets, the `font`
 * shorthand and `font-size` alike, and fails on one that is not a step of the ramp.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const RAMP = [11, 12, 13, 14, 15, 16, 18, 20, 24, 30];

/** Every stylesheet under src, so a sheet added later is read without anyone remembering to list it. */
function sheets(dir = SRC): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sheets(path.join(dir, e.name)) : e.name.endsWith(".css") ? [path.join(dir, e.name)] : []));
}

/** The pixel size each declaration sets, with the text it came from. `font: 600 15px/1.3 var(--sans)` sets 15; the line height after the slash is not a size. */
function sizesIn(css: string): Array<{ px: number; decl: string }> {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Array<{ px: number; decl: string }> = [];
  for (const m of bare.matchAll(/(?:^|[;{\s])(font|font-size)\s*:\s*([^;}{]+)/g)) {
    const first = /(?:^|\s)(\d+(?:\.\d+)?)px(?=$|[\s/])/.exec(m[2]!);
    if (first) out.push({ px: Number(first[1]), decl: `${m[1]}: ${m[2]!.trim()}` });
  }
  return out;
}

test("the scanner reads the size of a shorthand and of font-size, and not a line height", () => {
  assert.deepEqual(sizesIn(".a { font: 600 15px/1.3 var(--sans); } .b { font-size: 13px; } .c { font: var(--tx-value); }").map((s) => s.px), [15, 13]);
  assert.deepEqual(sizesIn(".a { font: 500 12px/20px var(--sans); }").map((s) => s.px), [12]);
  assert.deepEqual(sizesIn("/* font: 99px */ .a { color: red; }"), []);
  assert.deepEqual(sizesIn(".a { font: 600 10px/1 var(--sans); }").map((s) => s.px), [10], "a 10 px chip is read, and is off the ramp");
});

test("every size the console's stylesheets set is a step of the type ramp", () => {
  const off: string[] = [];
  let seen = 0;
  const files = sheets();
  assert.ok(files.length >= 20, `read ${files.length} stylesheets`);
  for (const file of files) {
    for (const s of sizesIn(fs.readFileSync(file, "utf8"))) {
      seen++;
      if (!RAMP.includes(s.px)) off.push(`${path.relative(SRC, file)}: ${s.decl}`);
    }
  }
  assert.ok(seen > 400, `read ${seen} sizes`);
  assert.deepEqual(off, [], `a size that is not on the ramp (${RAMP.join(" ")}): use the nearest step`);
});
