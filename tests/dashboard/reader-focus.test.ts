/**
 * The Files reader in the details panel: the pen stays in the panel, and a document's outline starts where its title is.
 *
 * Measured at 320, 360 and 390 px against the delivered demo: opening a file from the list put focus on the close button of
 * the loading head (86 ms), and when the record replaced that head the focused node was removed, so focus fell to <body> —
 * the log was `row → close-x → BODY` at all three widths, and `document.activeElement.closest("#drawer")` was null. A drawer a
 * keyboard user had just opened had no focus in it; Escape still handed it back to the row, so the loss was invisible to a mouse.
 *
 * The same drawer skipped a heading level: its own title is an h2 in the panel, and a document's markdown started at h4
 * (`PANEL_HEADING_BASE`), so axe reported `heading-order` (one node) — in the page's split view the reader's title is an h3 and
 * h4 was right, which is why the answer is a level the reader passes and not a new constant.
 *
 * These read the source as text, the way `drawer-loading.test.ts` and `primitives-a11y.test.ts` do.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), "utf8");
const reader = read("artifactreader.tsx");
const fileview = read("fileview.tsx");

test("the Files reader puts focus back in the panel when the record's arrival removed it", () => {
  const start = reader.indexOf("const restoredFor");
  assert.ok(start >= 0, "the reader remembers it has restored once per file");
  const end = reader.indexOf("}, [as, id, meta.kind]);", start);
  assert.ok(end > start, "the effect ends");
  const effect = reader.slice(start, end);
  assert.match(effect, /as !== "drawer"/, "the page's split view keeps the row's focus and is left alone");
  assert.match(effect, /meta\.kind === "loading"/, "nothing is restored while the skeleton still holds the focus");
  assert.match(effect, /restoredFor\.current === id/, "once per file");
  assert.match(effect, /document\.activeElement/, "it asks where focus is");
  assert.match(effect, /active !== document\.body/, "and acts only when focus was lost — never over a reader who moved on");
  assert.match(effect, /querySelector<HTMLElement>\("\.close-x"\)/, "the close the skeleton held is the landing place");
  assert.match(effect, /\.focus\(\)/, "and it is focused");
});

test("every branch of the reader draws a title row with a close, so the restore has somewhere to land", () => {
  // Loading, missing and error draw `heading(...)`; the ready branch draws the same row as `.reader-head` around the file's own
  // title. Each carries `closer`, which is the close button in the panel — the node the effect above focuses.
  const count = (reader.match(/\{heading\(/g) || []).length;
  assert.ok(count >= 3, `the three not-yet-read branches draw the head (found ${count})`);
  const ready = reader.indexOf('<div className="reader-head">');
  assert.ok(ready > 0, "the record's own title row is the head too");
  assert.ok(reader.slice(ready, ready + 1600).includes("{closer}"), "and it carries the same close");
  assert.match(reader, /const closer = as === "drawer" \?/, "the close exists in the panel");
});

test("a document's headings start under the reader's own title: h3 in the panel, h4 in the page", () => {
  assert.match(fileview, /headingBase\?: number;/, "the file view takes the level");
  assert.match(fileview, /headingBase = PANEL_HEADING_BASE/, "and keeps the page's level when it is not told");
  assert.match(fileview, /renderMarkdown\(content, \{ headingBase \}\)/, "the document is rendered at that level");
  assert.doesNotMatch(fileview, /headingBase: PANEL_HEADING_BASE \}/, "the constant is no longer set behind the caller's back");
  assert.match(reader, /headingBase=\{as === "drawer" \? 3 : undefined\}/, "the panel's title is the h2, so its document starts at h3");
});
