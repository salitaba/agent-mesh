/**
 * The console's owner uses it on a phone, one-handed. The design spec promises that on a phone
 * "everything that is pressed is 44 px tall" (`docs/design-spec.md` §6b) and that no affordance waits for a pointer.
 * The running console said otherwise: at 360 px the project strip's controls measured 38x36, 121x34, 24x24 and 32x32;
 * an agent's name button 71x21; Cards/List 57x40; the Files type select 190x36; "Latest of each name" and the project
 * tab rows 36; a summary 28; the Graph's fold bar 38. The rule below is the one floor that covers them, and this test
 * reads it as text so a later page cannot put a compact desktop height back on a thumb.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const styles = fs.readFileSync(path.join(SRC, "styles.css"), "utf8");

/** The body of every media block whose condition names a phone or a coarse pointer. Balanced braces, because a block holds rules. */
function phoneBlocks(css: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/@media[^{]+\{/g)) {
    if (!/pointer:\s*coarse|max-width:\s*(?:620|760)px/.test(m[0])) continue;
    const start = m.index! + m[0].length;
    let depth = 1;
    let i = start;
    for (; i < css.length && depth > 0; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
    }
    out.push(css.slice(start, i - 1));
  }
  return out;
}

/** Every selector list in those blocks whose declaration body matches. Several rules may share the floor. */
function selectorsFor(body: RegExp): string {
  const out: string[] = [];
  for (const block of phoneBlocks(styles)) {
    for (const m of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (body.test(m[2]!)) out.push(m[1]!.trim());
    }
  }
  return out.join("\n");
}

/* Every one of these was measured under 44 px in the running console at 360 px, or sits in the same family (a row of a
   ledger, a chip, a menu row) and would be the next one to. The list is the floor, not an inventory. */
const HEIGHT = [
  ".pj-home", ".ptab", ".ptab-main", ".ptab-x", ".ptab-add",
  ".tab", ".side-search", ".seg button", ".agent-open",
  ".evc-row", ".evc-foldbar", ".ptree-row", ".chg-row", ".menu-item",
  ".chip-toggle", "button.chip", "button.linklike", "summary", ".icon-btn",
  // The frame's own close controls and the layers they close: the drawer's X measured 32x32 at 360, the palette had none,
  // and the project switcher's rows and the palette's rows were 40 or less on a phone.
  ".close-x", ".palette-x", ".palette-item", ".pj-opt", ".toast-x",
  "input.search", "input.txt", "select.sel", "textarea.txt",
];

test("the phone floor names every control family that was measured under 44 px", () => {
  const selector = selectorsFor(/min-height:\s*44px/);
  assert.ok(selector, "a phone rule sets a 44 px floor");
  for (const s of HEIGHT) {
    assert.ok(selector.includes(s), `the 44 px floor covers ${s}`);
  }
});

test("glyph-only controls get a 44 px square, not only a tall strip", () => {
  const selector = selectorsFor(/min-width:\s*44px/);
  assert.ok(selector, "a phone rule sets a 44 px minimum width");
  for (const s of [".pj-home", ".ptab-x", ".ptab-add", ".agent-open", ".icon-btn", ".close-x", ".palette-x", ".toast-x"]) {
    assert.ok(selector.includes(s), `the 44 px minimum width covers ${s}`);
  }
});

test("an inline link that becomes a phone target takes a line of its own, or the height is ignored", () => {
  const body = phoneBlocks(styles).join("\n");
  assert.match(body, /button\.linklike[^{]*\{[^}]*display:\s*(?:inline-)?flex/, "a linklike is a flex box so its 44 px height applies");
});
