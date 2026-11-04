/**
 * A waiting condition is read in the hand, and its sentence gets the card.
 *
 * Measured on the delivered demo with one host-ceiling decision open, the attention row was a 3-column grid: a 28 px mark, the
 * sentence, and a 145 px fix. On a phone the action took more than half the card, so the sentence that says what happened was
 * 94 px wide at 360 (142 px tall) and 66 px at 320 (310 px tall): the card was 400 px for one line of English, and the evidence
 * under it began a screen down. It is a 2-column row below a 420 px card now, the sentence across the width and the fix under it;
 * one condition's head is the hero's own sentence, so it is read but not drawn. A list keeps its head.
 *
 * Read as text: the browser that measured it is not part of the suite.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const css = fs.readFileSync(path.join(SRC, "views", "overview.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const list = fs.readFileSync(path.join(SRC, "views", "AttentionList.tsx"), "utf8");

/** The body of every `@container` block, with balanced braces. */
function containerBlocks(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/@container[^{]+\{/g)) {
    const start = m.index! + m[0].length;
    let depth = 1;
    let i = start;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
    }
    out.push(source.slice(start, i - 1));
  }
  return out;
}

test("the attention card is the container the row answers", () => {
  assert.match(css, /\.ov-attn \{[^}]*container-type:\s*inline-size/, "the card is the container, so the rule follows its width and not the viewport");
  const blocks = containerBlocks(css);
  assert.ok(blocks.some((b) => /grid-template-columns:\s*28px minmax\(0, 1fr\)/.test(b)), "a narrow card gives the row two columns");
  const stacked = blocks.find((b) => /grid-template-columns:\s*28px minmax\(0, 1fr\)/.test(b))!;
  assert.match(stacked, /\.ov-attn li > \.ov-fix \{[^}]*grid-column:\s*2[^}]*justify-self:\s*end/, "the fix follows the sentence, at the row's end");
  assert.match(stacked, /row-gap:\s*var\(--s1-5\)/, "the stacked rows take the tighter gap");
  assert.match(stacked, /\.ov-attn li > \.ov-ad \{[^}]*padding-top:\s*0/, "the sentence starts at the card's padding, not 4 px lower");
});

test("one condition's head is the hero's sentence", () => {
  assert.match(css, /\.ov-attn\.single \.card-head \{[^}]*clip:\s*rect\(0 0 0 0\)/, "a single condition's head is visually hidden, not removed");
  assert.match(css, /\.ov-attn\.single \.card-head \{[^}]*position:\s*absolute/, "the hidden head leaves the flow");
  assert.match(list, /items\.length === 1 \? " single"/, "the card knows when it holds one condition");
});

test("the phone band keeps its fix whole above the dock", () => {
  // 360 and 390 are the widths where the stacked fix would otherwise fall under the 747 px dock: the card's block padding is 12,
  // its top 16 was what put the button 5.7 px over at 390.
  const phone = css.match(/@media \(max-width: 620px\)[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(phone, /\.ov-attn \{ padding-block: var\(--s3\);? \}/, "the attention card is a band on a phone");
});
