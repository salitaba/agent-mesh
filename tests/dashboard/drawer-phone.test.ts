/**
 * The step's drawer on a phone, and what a keyboard can read in it.
 *
 * Measured in the running console at 390 px on the delivered demo: the drawer's turn-walk arrows were 30 × 28 and four of its
 * pressed rows (the Outcome row, a tool, the event rows) were 31–40 px tall, where every one of the ten views has no pressed
 * thing under 44 × 44 — the console's own floor (§6b), and the reason the arrows escaped it is that `.sv-walk > button` sets a
 * height at a specificity above `styles.css`'s `:where()` floor. The same drawer scrolls three `pre` bodies (the prompt, the
 * model's output, the turn record) inside its own scroll; a wheel reaches them and a keyboard could not, because a `pre` with
 * `overflow: auto` and no `tabIndex` is not a stop (§1.2, §6: "a dialog body that scrolls is a tab stop").
 *
 * These read the source as text: the heights were measured in a browser, which the unit run does not launch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), "utf8");

const drawersCss = read("views/drawers.css");
const drawers = read("drawers.tsx");
const scrollStop = read("ui/scroll-stop.tsx");

/** The bodies of every media block whose condition names a phone or a coarse pointer (balanced braces, because a block holds rules). */
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

test("a phone's step drawer presses at 44 px: the walk arrows and every row built as a button", () => {
  const phone = phoneBlocks(drawersCss).join("\n");
  const walk = /\.sv-walk > button:not\(\.linklike\)\s*\{([^}]*)\}/.exec(phone);
  assert.ok(walk, "the phone rule names the walker's arrows");
  assert.match(walk![1]!, /min-width:\s*44px/, "an arrow is a 44 px square, not a 30 px one");
  assert.match(walk![1]!, /min-height:\s*44px/, "and 44 px tall");
  const rows = /\.sv-op,\s*\.sv-tool,\s*\.sv-ev\[role\]\s*\{([^}]*)\}/.exec(phone);
  assert.ok(rows, "the phone rule names the op, tool and event rows");
  assert.match(rows![1]!, /min-height:\s*44px/, "a pressed row is 44 px tall");
  assert.match(rows![1]!, /align-items:\s*center/, "and its content is centred in the taller row, not left at the top");
  // A static event row (no role) is read, not pressed: it keeps its compact height.
  assert.doesNotMatch(phone, /\.sv-ev\s*\{[^}]*min-height:\s*44px/, "a row that is not a button is not lifted");
});

test("the drawer's long bodies take a tab stop only when they scroll", () => {
  assert.match(scrollStop, /export function ScrollPre\(/, "a pre that measures itself exists");
  assert.match(scrollStop, /tabIndex=\{scrolls \? 0 : undefined\} \{\.\.\.rest\}/, "the stop is set exactly when the body holds more than it shows");
  // Every long body of the step's drawer is drawn through it: the live peek, the prompt, the model's output and the turn record.
  const uses = drawers.match(/<ScrollPre[\s>]/g) ?? [];
  assert.ok(uses.length >= 3, `the drawer draws its bodies through ScrollPre (found ${uses.length})`);
  assert.doesNotMatch(drawers, /<pre className="token-stream">/, "the prompt and the output are not bare pre blocks any more");
  assert.doesNotMatch(drawers, /<pre>\{\(JSON\.stringify/, "the turn record is not a bare pre block any more");
});

test("a stop a person cannot see is not one: the body draws the panel's focus ring", () => {
  assert.match(drawersCss, /#drawer pre:focus-visible \{[^}]*outline:\s*2px solid var\(--k-accent\)/, "a focused body is ringed in the accent, as the drawer's rows are");
  assert.match(drawersCss, /#drawer pre:focus-visible \{[^}]*outline-offset:\s*-2px/, "inside the box, so the drawer's scroll does not clip it");
});

test("a phone's step drawer is the whole screen, and its head meets its edges", () => {
  // Measured in the running console on the delivered demo with the first turn open. At 360 the drawer was 345.6 px at x = 14.4:
  // the `:has(.stepv)` desk rule's 96vw outranked the phone's 100vw, so a page that cannot be read peeked beside it. Its sticky
  // head was 357.6 px at x = 8.4 — 6 px past the drawer on both sides — because the head's -22 px bleed was written for the desk's
  // 22 px padding while the phone drawer pads by 16. The drawer scrolled 6 px sideways (scrollWidth 352 in a 346 client) and the
  // head's 1 px rule ran 6 px onto the scrim. 320: 307.2 / 319.2, 390: 374.4 / 386.4; 768 (737.3 / 736.3) and 1440 (1,180 / 1,179)
  // already met their edges. After: the drawer and head are 320 / 360 / 390 at x = 0, no overhang and no sideways scroll, and the
  // body's content is 288 / 328 / 358 (was 275.2 / 313.6 / 342.4).
  const phone = phoneBlocks(drawersCss).join("\n");
  const width = /\.drawer:has\(\.stepv\)\s*\{([^}]*)\}/.exec(phone);
  assert.ok(width, "the phone block sets the step drawer's own width");
  assert.match(width![1]!, /(?<!-)width:\s*100vw/, "the step drawer is the screen, not the desk's 96vw");
  assert.match(width![1]!, /max-width:\s*100vw/, "and cannot be wider");
  const head = /\.sv-head\s*\{([^}]*)\}/.exec(phone);
  assert.ok(head, "the phone block sets the head's bleed");
  assert.match(head![1]!, /margin:[^;]*calc\(-1 \* var\(--s4\)\)/, "the head bleeds by the phone drawer's own 16 px, not the desk's 22");
  assert.match(head![1]!, /padding:\s*var\(--s3\) var\(--s4\) 0/, "and pads by the same");
  assert.match(head![1]!, /top:\s*calc\(-1 \* \(var\(--s5\) \+ env\(safe-area-inset-top\)\)\)/, "the head sticks from the notch, as the shared drawer head does");
  // A desk keeps the 22 px bleed its own padding uses.
  const desk = /^\.sv-head \{([^}]*)\}/m.exec(drawersCss);
  assert.ok(desk, "the base head rule is still there");
  assert.match(desk![1]!, /-22px/, "a desk keeps its 22 px bleed");
});
