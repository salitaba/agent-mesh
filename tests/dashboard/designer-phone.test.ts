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
