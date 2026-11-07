/**
 * Where a phone's notices sit.
 *
 * The notices were a second item in `#view`'s grid cell (`grid-area: main`), painted over the top of the page. That was right
 * while the page was scrolled, and wrong on arrival: measured at 360 with the delivery notice up, its 336 × 85 box at y 72 covered
 * Files' title (14–73.4 × 78–105.6) and its centre hit the toast, and on Events its close button was exactly on Pause updates
 * (both 302–346 × 78–122): a press meant to pause dismissed the notice.
 *
 * With a notice up, the frame now has a row for it between the top bar and the view. The empty container keeps `main`, so a page
 * with no notice has no extra row and no shift. Read as text: the measuring browser is not part of the suite.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const CSS = fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src", "styles.css"), "utf8");
const start = CSS.indexOf("@media (max-width: 800px)");
const phone = CSS.slice(start, CSS.indexOf("/* ============ command palette", start));

test("a phone notice has its own frame row while it is up", () => {
  assert.match(phone, /#app:has\(#toasts \.toast\) \{[^}]*grid-template-rows:\s*auto auto 1fr;[^}]*grid-template-areas:\s*"side top" "side toasts" "side main"/, "the frame grows a track between bar and view");
  assert.match(phone, /#app:has\(#toasts \.toast\):not\(:has\(\.ms-bar\)\):not\(:has\(#drawer:not\(\.hidden\)\)\) #toasts \{[^}]*grid-area:\s*toasts/, "and the notice moves into it, except in the two fixed places");
  assert.match(phone, /#app\.with-tabs:has\(#toasts \.toast\) \{[^}]*grid-template-rows:\s*auto auto auto 1fr;[^}]*grid-template-areas:\s*"tabs tabs" "side top" "side toasts" "side main"/, "a hosted console keeps its project strip row");
});

test("without a notice the page keeps its cell and gains no empty row", () => {
  assert.match(phone, /#toasts \{[^}]*grid-area:\s*main/, "the empty container stays in the page's own cell");
  assert.doesNotMatch(phone, /#app \{ grid-template-rows: auto auto 1fr/, "the frame does not reserve the row unconditionally");
});

test("the two places that keep the foot are still fixed over the page", () => {
  assert.match(phone, /#drawer:not\(\.hidden\) ~ #toasts, body:has\(\.ms-bar\) #toasts \{[^}]*position:\s*fixed/, "an open drawer and the Designer keep their notices at the foot");
  // The grid-area rule above is more specific than this one, so the fixed places explicitly opt out of it: with the notice placed in
  // the new track, `position: fixed` + `bottom` resolved against the empty row and the Designer's notice sat at y = -123, off screen.
  assert.match(phone, /not\(:has\(\.ms-bar\)\):not\(:has\(#drawer:not\(\.hidden\)\)\)/, "the fixed places are excluded from the new track");
});
