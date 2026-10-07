/**
 * The console sets type on one ramp: 11 12 13 14 15 16 18 20 24 30 px (docs/design-spec.md §3). This is the working pages' test
 * (type-ramp.test.ts, on the branch that redrew them) for the front pages' stylesheets: the Overview, Needs you, Agents, Host settings,
 * the Projects page and the folder picker, and the first-run and sign-in sheets. It reads every size they set, the `font` shorthand and
 * `font-size` alike, and fails on one that is not a step of the ramp: a 10 px chip beside 11 px labels looks the same in a screenshot and
 * is a tenth size. When both tests are on one branch, the two lists are one list and this file can go.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const RAMP = [11, 12, 13, 14, 15, 16, 18, 20, 24, 30];

const SHEETS = ["views/overview.css", "views/inbox.css", "views/agents.css", "views/settings.css", "projects.css", "firstrun.css"];

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

test("the scanner reads the size of a shorthand and of font-size, and not a line height or a comment", () => {
  assert.deepEqual(sizesIn(".a { font: 600 15px/1.3 var(--sans); } .b { font-size: 13px; } .c { font: var(--tx-value); }").map((s) => s.px), [15, 13]);
  assert.deepEqual(sizesIn(".a { font: 500 12px/20px var(--sans); }").map((s) => s.px), [12]);
  assert.deepEqual(sizesIn("/* font: 99px */ .a { color: red; }"), []);
  assert.deepEqual(sizesIn(".a { font: 600 10px/1 var(--sans); }").map((s) => s.px), [10], "a 10 px chip is read, and is off the ramp");
});

test("every size the front pages set is a step of the type ramp", () => {
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
  assert.ok(seen > 100, `read ${seen} sizes`);
  assert.deepEqual(off, [], `a size that is not on the ramp (${RAMP.join(" ")}): use the nearest step`);
});
