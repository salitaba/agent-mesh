/**
 * An open event owns the screen it is drawn on.
 *
 * Measured on the scripted demo at Delivered, in the production build, at 320, 360, 390, 620, 768, 900 and 1,440. At 360 an
 * open event was a 336 × 532 px pane under the log's search row (96 px of search and Filters at 320): the search and the
 * Filters button narrow the list, and below 900 the list is `display: none` whenever an event is open, so pressing Filters
 * open grew a 262 px panel and left the event 258 px of the 736 px view. The pane's title row, which holds the only close,
 * was at the top of 1,527 px of content in a 530 px window: read the thread to its end and the close sat 742 px above it.
 *
 * Now the log's tools step aside while an event is open (the pane 532 → 586 px at 360, 96 → 0 of tools at 320, 429 → 607 at
 * 768) and the title row sticks to the pane's top (the close at y = 201 at the pane's end as at scroll 0). The desk (1,001
 * and above) keeps its list beside the pane, its tools and its non-sticky title, unchanged to the pixel.
 *
 * Read as text: the browser that measured the page is not part of the suite.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const read = (file: string): string => fs.readFileSync(path.join(SRC, file), "utf8");
const tsx = read("views/Events.tsx");
const detail = read("evdetail.tsx");
const css = read("views/events.css");

/** The one media block that hides the stream when an event is open. */
const SPLIT_AT = css.indexOf("@media (max-width: 900px) {");
const split = SPLIT_AT >= 0 ? css.slice(SPLIT_AT) : "";
const desk = SPLIT_AT >= 0 ? css.slice(0, SPLIT_AT) : css;

test("while an event is open the log's search and filters step aside, and only then", () => {
  assert.ok(SPLIT_AT >= 0, "the split block exists");
  assert.match(split, /\.evc\.split \.evc-stream \{ display: none; \}/, "the stream is hidden below 900, which is why its tools are dead here");
  assert.match(split, /\.ev-page:has\(\.evc\.split\) \.ev-tools,\s*\.ev-page:has\(\.evc\.split\) \.ev-facets \{ display: none; \}/, "both the search row and the filter fold follow the split");
  // Scoped: on the same page with no event open, and on a desk with one open, the tools are drawn.
  assert.doesNotMatch(desk, /(^|\})\s*\.ev-tools\s*\{[^}]*display: none/, "the desk keeps its search row");
  assert.doesNotMatch(desk, /(^|\})\s*\.ev-facets\s*\{[^}]*display: none/, "the desk keeps its filter chips");
  assert.doesNotMatch(css, /(^|\})\s*\.ev-tools\s*\{[^}]*display: none/, "the search row is never hidden on its own");
  // Nothing is deleted from the page: the controls are still in the markup and come back when the event closes.
  assert.match(tsx, /className="ev-tools"/, "the tools row is still the page's");
  assert.match(tsx, /ev-filters-toggle/, "the counted Filters button is still the page's");
  assert.match(tsx, /className=\{`ev-facets/, "the filter fold is still the page's");
});

test("the event's title row stays at the top of the pane, bleeding by the pane's own gutter", () => {
  assert.match(split, /\.evc-detail \.evd-title \{[^}]*position: sticky; top: 0;/, "the row sticks to the pane's top");
  assert.match(split, /\.evc-detail \.evd-title \{[^}]*margin-top: calc\(var\(--evd-y\) \* -1\);/, "it starts where the pane's padding started");
  assert.match(split, /\.evc-detail \.evd-title \{[^}]*margin-inline: calc\(var\(--evd-x\) \* -1\);/, "it reaches the pane's edges");
  assert.match(split, /\.evc-detail \.evd-title \{[^}]*padding: var\(--evd-y\) var\(--evd-x\) var\(--s2\);/, "its own padding puts the words back");
  assert.match(split, /\.evc-detail \.evd-title \{[^}]*margin-bottom: calc\(var\(--s4\) \* -1\);/, "its bottom margin keeps the meta line where it was");
  assert.equal(desk.includes(".evc-detail .evd-title"), false, "a desk's pane is not sticky");
});

test("the pane names its gutter, so the sticky bleed matches the phone's 14 and the tablet's 16 and 20", () => {
  assert.match(css, /\.evd \{ --evd-x: var\(--s5\); --evd-y: var\(--s4\);/, "the pane's gutter is named");
  assert.match(css, /@media \(max-width: 620px\)[\s\S]*?\.evd \{ --evd-x: var\(--s3-5\); --evd-y: var\(--s3-5\);/, "a phone pads the pane by 14");
});

test("the title row is outside the head, which is what lets it stick for the whole scroll", () => {
  const titleAt = detail.indexOf('className="evd-title"');
  const headAt = detail.indexOf('className="evd-head"');
  assert.ok(titleAt > 0, "the title row exists");
  assert.ok(headAt > 0, "the head exists");
  assert.ok(titleAt < headAt, "the title row comes first");
  assert.doesNotMatch(detail.slice(headAt, headAt + 900), /evd-title/, "a sticky box stops at its own containing block, so the title cannot live inside the head");
  assert.match(css, /\.evd-title \{[^}]*margin-bottom: calc\(var\(--s2\) - var\(--s4\)\);/, "the wider rhythm it inherits is cancelled back to the head's 8");
});

test("the way back is still one named control", () => {
  assert.match(detail, /<IconButton icon="x" label="Close event detail"/, "the close keeps its name");
  assert.match(tsx, /onClose=\{closeDetail\}/, "the pane still closes back to the log");
});
