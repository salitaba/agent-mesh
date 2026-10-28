/**
 * A phone is where the Designer is used with one thumb (docs/design-spec.md §3: "On a phone everything that is pressed is 44 px tall
 * and a field is 16 px, so the page does not zoom"). In the running console at 360px the inspector drawer was the one surface the QA
 * harness never measured — it is display:none until a seat is opened. Measured there on 2026-10-20: the tabs were 36px tall, the tool
 * chips 28px (and "qa" 38px wide), "Edit as text" 30px, and the fields 36px at 13–14px type. Below 16px, iOS Safari zooms the page
 * the moment a field takes focus, which leaves a phone-first person on a page wider than the screen.
 *
 * The browser is not in this run, so the rules that fix it are pinned in the stylesheets. `designer-authority.test.ts` made the same
 * trade for the authority switches.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), "utf8");

interface Block { condition: string; body: string }
interface Rule { selectors: string[]; body: string }

/** Every `@media <condition> { … }` body, with its closing brace found by counting, so a block that holds other blocks is whole. */
function mediaBlocks(css: string): Block[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Block[] = [];
  for (const m of bare.matchAll(/@media([^{]+)\{/g)) {
    const start = (m.index ?? 0) + m[0].length;
    let depth = 1;
    let i = start;
    for (; i < bare.length && depth > 0; i++) {
      if (bare[i] === "{") depth++;
      else if (bare[i] === "}") depth--;
    }
    if (depth === 0) out.push({ condition: m[1]!.trim(), body: bare.slice(start, i - 1) });
  }
  return out;
}

/** The plain declaration blocks inside a body. A nested @media/@supports header has a `{` in its "selector" and is skipped. */
function rules(body: string): Rule[] {
  return Array.from(body.matchAll(/([^{}]+)\{([^{}]*)\}/g)).map((m) => ({
    selectors: m[1]!.split(",").map((s) => s.trim()).filter(Boolean),
    body: m[2]!,
  }));
}

/** A phone block: a real phone is coarse-pointer at any width, and the console's phone layout starts at 760px. */
const isPhone = (condition: string): boolean => /pointer:\s*coarse/.test(condition) || [...condition.matchAll(/max-width:\s*(\d+)px/g)].some((m) => Number(m[1]) <= 760);
const phoneRules = (css: string): Rule[] => mediaBlocks(css).filter((b) => isPhone(b.condition)).flatMap((b) => rules(b.body));
const hasRule = (css: string, selector: string, declaration: RegExp): boolean =>
  phoneRules(css).some((r) => r.selectors.includes(selector) && declaration.test(r.body));

const styles = read("styles.css");
const inspector = read("designer/inspector.css");
const designerCss = read("designer/designer.css");
const topologyCss = read("designer/topology.css");
const designer = read("designer/Designer.tsx");

test("a field on a phone is 16px: Safari zooms a page whose focused field is smaller", () => {
  // The mono rule (13px) has a higher specificity than the shared field rule, so it needs the same phone override.
  for (const selector of ["input.search", "input.txt", "select.sel", "textarea.txt", "input.txt.mono", "textarea.txt.mono"]) {
    assert.ok(hasRule(styles, selector, /font-size:\s*16px/), `${selector} is 16px in a phone block`);
  }
});

test("every thing a thumb presses in the phone inspector is 44px tall", () => {
  for (const selector of [".ms-insp .tab-btn", ".ms-insp .chip-toggle", ".ms-insp .linklike", ".ms-insp input.search", ".ms-insp input.txt", ".ms-insp select.sel", ".ms-insp textarea.txt"]) {
    assert.ok(hasRule(inspector, selector, /min-height:\s*44px/), `${selector} is 44px tall in the phone drawer`);
  }
  assert.ok(hasRule(inspector, ".ms-insp .chip-toggle", /min-width:\s*44px/), "even the shortest chip ('qa') is 44px wide");
});

test("a touch-class tablet at 768 gets the 44 px floor, though it is above the 760 phone layout", () => {
  // Measured at 768 with a coarse pointer: the guide's three closed steps were 32 px tall and each seat's wiring port was 26 × 26,
  // so a finger had to aim at a 26 px circle on a 56 px card. The port keeps its 26 px mark and takes a 44 px target around it.
  assert.ok(hasRule(designerCss, ".ms-step-toggle", /min-height:\s*44px/), "a guide disclosure is 44 px tall");
  assert.ok(hasRule(topologyCss, ".ms-handle", /width:\s*44px/), "the wiring port's target is 44 px wide");
  assert.ok(hasRule(topologyCss, ".ms-handle", /height:\s*44px/), "and 44 px tall");
  assert.ok(hasRule(topologyCss, ".ms-handle::before", /inset:\s*9px/), "the mark drawn inside it stays the 26 px circle the card was drawn around");
});

test("on a phone the first-run guide is a ruled brief, and each step is one 44 px line of it", () => {
  // Measured at 360 with the first-run guide: the guide was a 446.2 px card of the 736.6 px above the pinned save bar, so the roster's
  // first 60 px seat began at 708.8 and only 27.8 of it showed. On the page's own rules, with the three closed steps one line each
  // instead of four padded blocks, the guide is 334.8 px and that seat is whole. The guide holds nothing that is pressed as a whole,
  // which is what DESIGN.md reserves a card for.
  assert.ok(hasRule(designerCss, ".card.ms-guide", /padding:\s*0/), "a phone's guide is not a box");
  assert.ok(hasRule(designerCss, ".ms-steps li", /padding-block:\s*0/), "a closed step is its line and its rule, not a padded block");
  assert.ok(hasRule(designerCss, ".ms-steps li.now", /padding-bottom:\s*var\(--s3\)/), "the step to do now keeps its air before the next rule");
});

test("a phone header gives the history pair to the menu, so the roster starts 52 px higher", () => {
  // Measured at 360 with the first-run guide: the header's actions took two rows (52 px for undo/redo and the verdict, 44 for
  // Inspector and the menu) and the header was 150 px. Hiding the pair lets the remaining three share one row.
  assert.match(designer, /\{listMode \? null : \(\s*<div className="ms-toolgroup" role="group" aria-label="History">/, "the bar's history pair is not drawn on a phone");
  assert.match(designer, /const historyItems: MenuItem\[\] = listMode/, "the menu gets the same two actions there");
  assert.match(designer, /label: `Undo: \$\{labelsNow\.undo\}`/, "Undo names the change it would take back");
  assert.match(designer, /label: `Redo: \$\{labelsNow\.redo\}`/, "and so does Redo");
  assert.match(designer, /separated: historyItems\.length > 0, onClick: openYaml/, "the file actions are set apart from the history ones");
});
