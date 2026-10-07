/**
 * The step's and the agent's drawers have their own stylesheet (views/drawers.css). Four things in it are claims that no screenshot
 * keeps true by itself, so they are read from the text: the colours of a verdict are the Steps list's, a heading is a sentence, the
 * blinking cursor of a live stream is a cursor and not every chevron on the page, and the panel's own focus is not drawn as a ring.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), "utf8");

const styles = read("styles.css");
const drawers = read("views/drawers.css");
const live = read("live.css");

/** The value a one-line rule gives a custom property: `.o-ship { --oc: var(--ok); }` -> `ok`. */
function toneOf(css: string, selector: string, prop: string): string | null {
  const rule = new RegExp(`${selector.replace(/[.\\[\]]/g, "\\$&")}\\s*\\{[^}]*${prop}:\\s*var\\(--([\\w-]+)\\)`).exec(css);
  return rule ? rule[1]! : null;
}

test("a step's verdict is drawn in the colour the Steps list gives the same verdict", () => {
  const pairs: Array<[string, string]> = [["ship", "ok"], ["rej", "rej"], ["block", "warn"], ["crash", "bad"], ["quiet", "muted"]];
  for (const [name, colour] of pairs) {
    assert.equal(toneOf(styles, `.o-${name}`, "--oc"), colour, `the list: ${name}`);
    assert.equal(toneOf(drawers, `.sstat-${name}`, "--sc"), colour, `the panel: ${name}`);
  }
  // A live turn is the accent in both: the console's own alias for it, `--k-accent`, in the panel.
  assert.match(toneOf(styles, ".o-live", "--oc") ?? "", /^(accent|k-accent)$/);
  assert.match(toneOf(drawers, ".sstat-live", "--sc") ?? "", /^(accent|k-accent)$/);
});

test("a heading in a panel is a sentence, not a caption in capitals", () => {
  const rule = /#drawer h3, #drawer h4 \{([^}]*)\}/.exec(drawers);
  assert.ok(rule, "the panel's own headings have a rule");
  assert.match(rule![1]!, /text-transform: none/);
  assert.match(rule![1]!, /font: 600 14px/);
});

test("the blinking cursor of a live stream is the span at its end, and no chevron blinks", () => {
  const bare = (styles + drawers).replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = [...bare.matchAll(/(^|\n)([^{}\n]*\.caret[^{}\n]*)\{([^}]*)\}/g)].filter((m) => /animation/.test(m[3]!));
  assert.ok(rules.length >= 1, "the cursor blinks");
  for (const m of rules) assert.match(m[2]!.trim(), /^span\.caret$/, `only the span blinks: "${m[2]!.trim()}"`);
});

test("the panel is focused when it opens and draws no ring round itself", () => {
  assert.match(live, /\.drawer:focus, \.drawer:focus-visible \{ outline: none; \}/);
});

test("what the panel's ledgers are drawn as: one ruled card each, with a rail in the row's colour", () => {
  for (const sel of [".sv-ops", ".sv-tools", ".sv-evs"]) {
    const rule = new RegExp(`${sel.replace(".", "\\.")}[^{]*\\{([^}]*overflow: hidden[^}]*)\\}`).exec(drawers);
    assert.ok(rule, `${sel} is one card that clips its rows`);
    assert.match(rule![1]!, /border: 1px solid var\(--line\)/);
  }
  assert.match(drawers, /\.sv-op \{[^}]*box-shadow: inset 3px 0 0 var\(--rail\)/, "the rail is the row's own shadow, so the card's corners stay round");
});
