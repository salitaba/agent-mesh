/**
 * The console's frame owns the window: #view is its one scroller, and the document itself must never scroll.
 *
 * It did. A long view's overflow still reached the root: measured at 360 px, the Graph page held 1,881 px of content in a
 * 780 px #view and the document was 1,774 px tall (Cost: 1,447), so one wheel over the 64 px top bar — the strip above
 * #view — moved the whole console 600 px up onto blank ground, with nothing left on screen to pull back. At 320 the Graph's
 * document was 1,899 px against an 844 px window (1,055 px of blank), and even Product, 31 px over, could be nudged.
 *
 * The fix is on the frame and not on #view: the Designer draws its inspector, its templates sheet and its assistant dock as
 * `position: fixed` layers *inside* #view, and `contain` on a box makes it the containing block for fixed descendants, so
 * clipping there would move those layers under the top bar. #app is already the viewport's own box, so clipping at it changes
 * where nothing is drawn.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const styles = fs.readFileSync(path.join(SRC, "styles.css"), "utf8");

/** The declarations of the first rule whose selector is exactly this one. */
function rule(selector: string): string {
  const m = new RegExp(`${selector.replace(/[#.]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(styles);
  assert.ok(m, `${selector} has a rule`);
  return m[1]!;
}

test("the frame clips its own overflow, so a long view cannot scroll the document", () => {
  assert.match(rule("#app"), /contain:\s*paint/, "#app contains the paint of what it holds");
  assert.match(rule("#app"), /height:\s*100dvh/, "the frame is the window's height; a page taller than it is not the document's scroll");
});

test("the frame is still one scroller: #view scrolls, and the frame is not given over to another", () => {
  assert.match(rule("#view"), /overflow:\s*auto/, "#view is where a view's content scrolls");
  assert.match(rule("#app"), /grid-template-areas:\s*"side top" "side main"/, "the shell's areas are unchanged");
});

test("the containment is on the frame and not on #view, where the Designer's fixed layers would resolve against it", () => {
  const view = rule("#view");
  assert.doesNotMatch(view, /contain:/, "a containing block on #view would move .ms-side, .ms-slide and the assistant dock");
  const designer = fs.readFileSync(path.join(SRC, "designer", "designer.css"), "utf8");
  assert.match(designer, /\.ms-side \{[^}]*position:\s*fixed/, "the Designer really does draw a fixed layer inside the view");
});
