/**
 * The Events page's two readings, both pinned because the page looked right and said the wrong thing:
 *
 * 1. The kind column printed the same fact as the sentence — `release-test-report: ready for review, by qa` beside
 *    `moved to ready for review` — in 9 of the 119 rows of a delivered demo. The column is the kind (`moved`), and the
 *    destination stays in the sentence, where a reader scans for it.
 * 2. The page trusted its newest seq. Arriving from the Overview it inherited that page's newest-200 tail, whose last seq is
 *    the log's, so it drew "200 events" and no note while the log held 481. A count short of one read now asks for the log,
 *    and the foot note names the log's figure rather than the page's buffer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const tsx = fs.readFileSync(path.join(SRC, "views", "Events.tsx"), "utf8");

test("the kind column says the kind, not the state the sentence already said", () => {
  assert.match(tsx, /className="evc-type"[^>]*>\{plainEvent\(e\.type\)\}<\/span>/, "a bare type: 'moved', not 'moved to ready for review'");
  assert.doesNotMatch(tsx, /className="evc-type"[^>]*>\{plainEvent\(e\.type, e\.payload\)\}/, "the payload label repeats the destination");
  assert.match(tsx, /<EventSummary e=\{e\} nameOf=\{nameOf\} \/>/, "the sentence keeps the destination");
});

test("a newest-first tail is read as incomplete, and one read's worth is what the page asks for", () => {
  assert.match(tsx, /const EVENT_LIMIT = 400;/, "the page names the size of one read");
  assert.match(tsx, /const behind = logIncomplete\(newest, events\.length, logLength, EVENT_LIMIT\);/, "the count decides, not the newest seq");
  assert.doesNotMatch(tsx, /logLength > newest/, "the newest-seq-only test is gone");
  assert.equal((tsx.match(/\/events\?limit=\$\{EVENT_LIMIT\}/g) ?? []).length, 2, "both reads ask for the same window");
});

test("the window is the newest events, not the first 300 of the buffer's ingestion order", () => {
  assert.match(tsx, /const ordered = useMemo\(\(\) => newestFirst\(events\), \[events\]\)/, "the list is sorted by seq");
  assert.match(tsx, /filterBase\(ordered, hay,/, "the filter reads the sorted list");
  assert.match(tsx, /topActors\(ordered\)/, "the agent facet reads the sorted list");
  assert.doesNotMatch(tsx, /filterBase\(events, hay,/, "the unsorted buffer is not the list");
});

test("the foot note is the log's window, not the page's buffer", () => {
  assert.match(tsx, /const windowText = logWindowText\(\{ drawn: shown\.length, matched: held\.shown\.length, held: events\.length, logged: typeof logLength === "number" \? logLength : 0 \}\)/, "it reads the log's count");
  assert.match(tsx, /windowText \? <p className="list-more" role="status">\{windowText\}<\/p> : null/, "it is drawn as one note");
  assert.doesNotMatch(tsx, /Narrow the search to reach older ones/, "the promise the page could not keep is gone");
});

test("the fold switch follows the list: with Routine filtered it reads off and says why", () => {
  // Filtered to Routine, folding would collapse all 284 rows into one fold, so the page turns it off. The switch still read on:
  // measured at 1440, 26 fold bars and 110 rows before the filter, 0 and 284 after, and pressing the switch changed neither. The
  // control now shows the state it is in, and is disabled with its reason under it until the filter is cleared.
  assert.match(tsx, /const routineOn = sevOn\.has\("routine"\);/, "one answer names the filter that overrides the setting");
  assert.match(tsx, /const folding = foldPref && !routineOn;/, "the list folds only when the filter allows it");
  assert.doesNotMatch(tsx, /checked=\{foldPref\}/, "the switch no longer reports the preference over the list");
  assert.match(tsx, /checked=\{folding\}/, "it reads what the list is doing");
  assert.match(tsx, /disabled=\{routineOn\}/, "and cannot be pressed when pressing it would do nothing");
  assert.match(tsx, /hint=\{routineOn \? "Off while the Routine filter is on\." : undefined\}/, "the reason is on screen, not only in a tooltip");
});
