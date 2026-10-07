/**
 * The console sets type on one ramp: 11 12 13 14 15 16 18 20 24 30 px (docs/design-spec.md §3). A figure set at 32 px, a heading at 22, a label at
 * 10 look the same as their neighbours in a screenshot and are not: they are a tenth size, and each one is the start of the next. Nothing
 * checked it, and three of them got in while the working pages were redrawn. This reads every size the working pages' stylesheets set, the
 * `font` shorthand and `font-size` alike, and fails on one that is not a step of the ramp.
 *
 * It covers the sheets of the working pages (the lists below). The front pages' sheets are not in it because another change owns them; once
 * they are on the ramp too, this is the place to widen it to every stylesheet.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const RAMP = [11, 12, 13, 14, 15, 16, 18, 20, 24, 30];

const SHEETS = [
  "live.css",
  "views/steps.css", "views/events.css", "views/files.css", "views/product.css", "views/cost.css", "views/graph.css", "views/gates.css", "views/drawers.css",
  "designer/designer.css", "designer/topology.css", "designer/inspector.css", "designer/assistant.css",
];

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
});

test("every size the working pages set is a step of the type ramp", () => {
  const off: string[] = [];
  let seen = 0;
  for (const f of SHEETS) {
    const file = path.join(SRC, f);
    assert.ok(fs.existsSync(file), `${f} exists`);
    for (const s of sizesIn(fs.readFileSync(file, "utf8"))) {
      seen++;
      if (!RAMP.includes(s.px)) off.push(`${f}: ${s.decl}`);
    }
  }
  assert.ok(seen > 200, `read ${seen} sizes`);
  assert.deepEqual(off, [], `a size that is not on the ramp (${RAMP.join(" ")}): use the nearest step`);
});
