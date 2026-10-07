/**
 * Windows High Contrast swaps every background for the system's and drops shadows. A bar, a segment, a dot or a hairline that is only a background
 * is then gone: the Steps timeline was an empty well, the Cost strip and bars were empty tracks, and nothing failed, because the page still
 * rendered and every other check runs without it. The foundation draws its own marks under `@media (forced-colors: active)` and pins that; this
 * pins it for the marks of the working pages. Each sheet below must name, inside such a block, every mark it draws as a background, with the
 * system's colours and no colour of its own, and Steps must tell an outcome by how a mark is filled, since colour is what is lost.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");

/** What each sheet draws as a background and must therefore draw again under forced colours. */
const MARKS: Record<string, string[]> = {
  "views/steps.css": [".st-bar", ".st-mix-seg", ".st-f-dot", ".st-cost-bar", ".st-grid", ".st-track"],
  "views/cost.css": [".cost-bar", ".cost-mini", ".cost-strip"],
  "views/drawers.css": [".prail-fill", ".prail-track", ".lw-dl-fill", ".lw-dl-track", ".sv-split"],
};

/** The text between the braces of the sheet's `@media (forced-colors: active)` block, or "" when it has none. */
function forcedBlock(css: string): string {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const at = bare.indexOf("@media (forced-colors: active)");
  if (at < 0) return "";
  const open = bare.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < bare.length; i++) {
    if (bare[i] === "{") depth++;
    else if (bare[i] === "}" && --depth === 0) return bare.slice(open + 1, i);
  }
  return "";
}

const read = (f: string): string => fs.readFileSync(path.join(SRC, f), "utf8");

/** Whether `selector` is named in the block as a whole class: `.cost-strip` is not found in `.cost-stripe`. */
const names = (block: string, selector: string): boolean => new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![\\w-])").test(block);

test("the block reader finds the block, nested braces and all, and finds nothing where there is none", () => {
  assert.equal(forcedBlock(".a { color: red; }"), "");
  assert.equal(forcedBlock("/* @media (forced-colors: active) { .no {} } */ .a {}"), "");
  const css = ".a { x: y; } @media (forced-colors: active) { .b { c: d; } .e:is(.f) { g: h; } } .z { k: l; }";
  assert.equal(forcedBlock(css).trim(), ".b { c: d; } .e:is(.f) { g: h; }");
  assert.ok(names(".cost-strip > i { }", ".cost-strip") && !names(".cost-stripe > i { }", ".cost-strip"), "a class is named whole");
});

test("each mark a working page draws as a background is drawn again under forced colours", () => {
  const missing: string[] = [];
  for (const [file, marks] of Object.entries(MARKS)) {
    const block = forcedBlock(read(file));
    assert.ok(block.length > 0, `${file} has an @media (forced-colors: active) block`);
    for (const m of marks) if (!names(block, m)) missing.push(`${file}: ${m}`);
  }
  assert.deepEqual(missing, [], "a mark that is a background and has no rule under forced colours is gone in Windows High Contrast");
});

test("under forced colours the marks use the system's colours, and the fills opt out of the swap", () => {
  for (const file of Object.keys(MARKS)) {
    const block = forcedBlock(read(file));
    assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\bvar\(/, `${file}: a colour of its own is replaced, or worse, kept, in High Contrast`);
    assert.match(block, /forced-color-adjust: none/, `${file}: a fill that is not exempt from the swap is drawn in the system's background and vanishes`);
    assert.match(block, /\b(Highlight|CanvasText|GrayText|Canvas)\b/, `${file}: system colours`);
  }
});

test("Steps tells an outcome by how a mark is filled, since colour is what High Contrast takes away", () => {
  const block = forcedBlock(read("views/steps.css"));
  for (const cls of [".o-quiet", ".o-rej", ".o-block", ".o-crash", ".o-live"]) assert.ok(names(block, cls), `${cls} has its own fill`);
  assert.match(block, /repeating-linear-gradient/, "refused, blocked and crashed are hatched");
  assert.match(block, /\.o-quiet[^{]*\{[^}]*background: Canvas;/, "a turn that wrote nothing is hollow");
});
