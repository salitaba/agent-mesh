/**
 * A phone's list controls are one row, and the Steps pulse is read before the turns begin.
 *
 * Measured at 360 on the production build, delivered: the Steps header was 162 px — the search on one row and "Pause updates"
 * on the next — and the pulse card 317 . The figures were two counts, then the no-output ring on a row of its own (126), and
 * the closed timeline's caption sat in 85 px of padding and margin. The first turn began 593 px into the view, and the screen
 * held one. The Events header paid the same 44 px for the two words under the search.
 *
 * After: the hold is a 44 px glyph with the whole label as its name (header 110 at 360), the three figures share a 40 px row
 * with the share written out where the ring is not drawn, and the closed caption is a 45 px row. The first turn is at 511.
 *
 * The 110 was true of Steps, whose hold sits beside its search. Events keeps the hold in the page head, and there the desk's
 * 12 px gap between the title, the live chip and the action put the row 1.1 px over 332: the glyph took a 44 px row of its own
 * above the lede and the head measured 147.1. A phone's page head now uses the row's own 8 px gap (the Designer's phone head
 * already did), so Events reads 110 as well and its first event is 37.1 px higher; at 320 the row is 325.1 in 292 and the
 * action honestly keeps a row.
 *
 * Read as text: the browser that measured the page is not part of the suite.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const read = (file: string): string => fs.readFileSync(path.join(SRC, file), "utf8");
const steps = read("views/Steps.tsx");
const events = read("views/Events.tsx");
const feed = read("feedstatus.tsx");
const css = read("views/steps.css");
const styles = read("styles.css");
// The phone rules live in the last, full `@media (max-width: 620px)` block.
const phone = css.slice(css.lastIndexOf("@media (max-width: 620px) {"));
const desk = css.slice(0, css.lastIndexOf("@media (max-width: 620px) {"));

/** Every media block of the shared sheet whose condition names a phone or a coarse pointer, joined. */
function phoneBlocks(sheet: string): string {
  const out: string[] = [];
  for (const m of sheet.matchAll(/@media[^{]+\{/g)) {
    if (!/pointer:\s*coarse|max-width:\s*(?:620|760)px/.test(m[0])) continue;
    const start = m.index! + m[0].length;
    let depth = 1;
    let i = start;
    for (; i < sheet.length && depth > 0; i++) {
      if (sheet[i] === "{") depth++;
      else if (sheet[i] === "}") depth--;
    }
    out.push(sheet.slice(start, i - 1));
  }
  assert.ok(out.length, "the shared sheet has phone blocks");
  return out.join("\n");
}

test("the hold is a glyph on a phone, and its name is still the whole label", () => {
  assert.match(feed, /compact\?: boolean/, "PauseButton takes the choice");
  assert.match(feed, /if \(compact\) return <IconButton icon=\{paused \? "play" : "pause"\} label=\{c\.label\} onClick=\{onToggle\} \/>/,
    "the compact form is an IconButton named by the words the desk shows");
  assert.match(steps, /<PauseButton paused=\{hold\.paused\} onToggle=\{\(\) => hold\.setPaused\(!hold\.paused\)\} noun="turns" compact=\{phone\} \/>/,
    "Steps asks for it at the phone break");
  assert.match(events, /compact=\{phone\} \/>/, "and so does Events, so the two live lists agree");
});

test("the pause's glyph is not a word the desk loses", () => {
  // The compact branch must not draw a label of its own: the IconButton's `label` is the accessible name in both states.
  const compact = feed.slice(feed.indexOf("if (compact)"), feed.indexOf("return (\n    <Button"));
  assert.doesNotMatch(compact, /Pause updates|Resume updates/, "the words still come from pauseControl, never a second copy");
  assert.match(feed, /const c = pauseControl\(paused, noun\);/, "one answer for both forms");
});

test("a phone's Steps figures are three across, and the share is a figure where the ring is not drawn", () => {
  assert.match(phone, /\.st-kpis \{[^}]*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/, "three columns, none of which can outgrow the card");
  assert.match(phone, /\.st-kpis \.st-noout \.ring \{ display: none; \}/, "the 58 px ring gives its column to the figure");
  assert.match(desk, /\.st-noout-v \{ display: none; \}/, "and a desk, which has the ring, does not draw the figure twice");
  assert.match(steps, /<span className="st-noout-v">\{loaded \? `\$\{spend\.wastedPct\}%` : "–"\}/, "the same number the ring says aloud, written");
  assert.match(steps, /<span className="stat-u"> \{spend\.partial \? `of \$\{plural\(steps\.length, "turn"\)\}` : "of tokens"\}<\/span>/, "with what it is a share of");
  assert.match(steps, /\{loaded \? <span className="stat-u">/, "and nothing at all before the list has arrived: a share of no turns is not a figure");
  assert.match(steps, /\{!loaded \? "not loaded" : spend\.partial/, "the desk's caption says the same where the list has not arrived");
});

test("a phone's closed timeline is its caption row, not padding around one", () => {
  assert.match(phone, /\.st-tl \{ padding: 0 var\(--s4\); \}/, "no padding above or below a closed caption");
  assert.match(phone, /\.st-tl-head \{ margin-bottom: 0; min-height: 44px; \}/, "and the caption is the 44 px row");
  assert.match(phone, /\.st-tl\.open \{ padding-bottom: var\(--s4\); \}/, "an open timeline gets its foot back");
  assert.match(phone, /\.st-tl\.open \.st-tl-head \{ margin-bottom: var\(--s3\); \}/, "and its gap");
  assert.match(steps, /className=\{`st-tl\$\{open \? " open" : ""\}`\}/, "the sheet is told which of the two it is");
});

test("a phone's page head uses one 8 px gap, so a short title row keeps its action", () => {
  // The desk has the room for --s3; on a phone the title, the live chip and one action need the row's own --s2 or the action
  // wraps. Measured at 360: the Events head needed 333.1 px in 332 at 12, and 325.1 fits at 8.
  assert.match(styles, /\.view-title \{[^}]*gap: var\(--s2\) var\(--s3\)/, "the desk keeps its two gaps");
  assert.match(phoneBlocks(styles), /\.view-title \{ column-gap: var\(--s2\); \}/,
    "the phone block takes the row's 8 px for the columns as well");
});
