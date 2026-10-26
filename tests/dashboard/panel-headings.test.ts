/**
 * A document's headings are sections of the panel that shows it, not headings of the console page.
 *
 * At 1440 the Files reader's own title is an `<h3>` at 18 px. The artifact it was showing was rendered by `markdown.ts` as it
 * was written, so its `# Release` became an `<h1>` at 24 px: the page outline read H2 Files > H3 groups > H3 release-plan >
 * H1 Release > H2 release plan, and the file's internal title was larger than the file name and the same size as the page
 * title. Pinned here as the calls' base plus the stylesheet that follows it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const fileview = fs.readFileSync(path.join(SRC, "fileview.tsx"), "utf8");
const reader = fs.readFileSync(path.join(SRC, "artifactreader.tsx"), "utf8");
const stepview = fs.readFileSync(path.join(SRC, "stepview.tsx"), "utf8");
const filesCss = fs.readFileSync(path.join(SRC, "views", "files.css"), "utf8");
const drawersCss = fs.readFileSync(path.join(SRC, "views", "drawers.css"), "utf8");
const markdown = fs.readFileSync(path.join(SRC, "markdown.ts"), "utf8");

test("both markdown surfaces render under the panel's level", () => {
  assert.match(markdown, /export const PANEL_HEADING_BASE = 4;/, "one named level for every panel");
  assert.match(fileview, /headingBase = PANEL_HEADING_BASE/, "the file view defaults to it");
  assert.match(fileview, /renderMarkdown\(content, \{ headingBase \}\)/, "and renders a document at the level it is given");
  assert.match(stepview, /renderMarkdown\(text, \{ headingBase: PANEL_HEADING_BASE \}\)/, "a turn's narration in the step drawer");
  // The panel's title is the dialog's h2, so its document starts at h3; the page's reader has an h3 title and keeps h4.
  assert.match(reader, /headingBase=\{as === "drawer" \? 3 : undefined\}/, "the details panel drops the document one level, not two");
  assert.doesNotMatch(fileview, /renderMarkdown\(content\)/, "no caller leaves the document at h1");
  assert.doesNotMatch(stepview, /renderMarkdown\(text\)/, "no caller leaves the narration at h1");
});

test("the document's first heading is no larger than the reader's own title", () => {
  const size = (css: string, selector: string): number => {
    const body = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
    return Number(/font(?:-size)?:[^;]*?(\d+)px/.exec(body)?.[1] ?? 0);
  };
  assert.equal(size(filesCss, ".reader-name"), 18, "the file's own title");
  assert.equal(size(filesCss, ".fv-md h1, .fv-md h4"), 18, "a document's `#` is the same size, not 24");
  assert.equal(size(filesCss, ".fv-md h2, .fv-md h5"), 16);
  assert.equal(size(filesCss, ".fv-md h3, .fv-md h6"), 15);
  // The panel's document starts at h3, so its `#` and `##` take the sheet's sizes for h3 and h4; no size rule moves with the tag.
  // The sheet draws both at 14 px (#drawer h3, #drawer h4), so the drawing keeps the `#` it had at h4 and the `##` loses the 16 px
  // it had at h5: the outline is what this pass fixed.
  assert.match(drawersCss, /#drawer h3, #drawer h4 \{[^}]*font: 600 14px/, "the sheet flattens its headings, so the h4 → h3 shift keeps the drawing");
  assert.match(drawersCss, /\.sv-md h1, \.sv-md h2, \.sv-md h4, \.sv-md h5 \{ font-size: 16px; \}/, "the drawer's top levels stay 16 px");
});
