/**
 * The Overview's two lists say each fact once.
 *
 * On the delivered demo (examples/demo-stub, 390 px) four of the five "Latest work" rows read "1m ago · wrote nothing" beside a pill
 * reading "no output" — one fact, twice, in one row — and four of the eight "Just happened" rows printed the same second line,
 * "Folded. Open Events for each one.", under a panel whose own button already says All events. The rows are React, which these
 * tests cannot run, so they pin the two lines the fix rests on; the rendered height is in the pass record (docs/design-spec.md §9).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const timeline = fs.readFileSync(path.join(SRC, "views", "Timeline.tsx"), "utf8");

test("a turn's row does not say nothing twice: the second line asks what the turn left", () => {
  assert.match(timeline, /const left = whatItLeft\(s\);/, "the row reads what it left from the model that knows when the pill said it");
  assert.match(timeline, /\{left \? <> · \{left\}<\/> : null\}/, "and draws it only when there is something to say");
  assert.doesNotMatch(timeline, /\{opsSummary\(s\)\}/, "the effect line is not printed beside the pill that already words the same outcome");
});

test("the panel explains its fold on the first fold it draws, not on every one", () => {
  assert.match(timeline, /const explained = rows\.find\(\(r\) => r\.kind === "fold"\)\?\.key;/, "the sentence belongs to one row");
  assert.match(timeline, /\{r\.key === explained \? <span className="tl-sub">Folded\. Open Events for each one\.<\/span> : null\}/, "and only that row draws it");
});
