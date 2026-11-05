/**
 * The file reader's state words on a delivered mission.
 *
 * The Files list and the Overview's result were taught on 2026-11-05 that a file put forward and never decided is "closed
 * without a verdict" once the goal is COMPLETED — but the reader those rows open still printed the raw lifecycle word. On
 * the demo's `release-test-report` the list said "closed without verdict", and pressing it showed the same file as **ready
 * for review**: one state, two views, and the one the person pressed said the work was still waiting after the mission had
 * closed. The reader reads the mission's own fact now (the same `facts.goalStatus === "COMPLETED"` the Files page reads), and
 * the words come from `files.ts` so there is one set of them.
 *
 * Read as text: the browser that measured it is not part of the suite.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

import { CLOSED_REVIEW, trailWords, versionStateWords } from "../../apps/mesh-dashboard/src/files";

const SRC = path.resolve(__dirname, "..", "..", "..", "apps", "mesh-dashboard", "src");
const reader = fs.readFileSync(path.join(SRC, "artifactreader.tsx"), "utf8");

test("the latest version of an undecided file is closed without a verdict on a delivered mission", () => {
  assert.equal(versionStateWords("READY_FOR_REVIEW", { latest: true, delivered: true }), CLOSED_REVIEW.row);
  assert.equal(versionStateWords("UNDER_REVIEW", { latest: true, delivered: true }), CLOSED_REVIEW.row);
});

test("a mission that is still running keeps the lifecycle's own word", () => {
  assert.equal(versionStateWords("READY_FOR_REVIEW", { latest: true, delivered: false }), "ready for review");
  assert.equal(versionStateWords("UNDER_REVIEW", { latest: true, delivered: false }), "in review");
});

test("an older version is a step in the history, not the state now", () => {
  assert.equal(versionStateWords("READY_FOR_REVIEW", { latest: false, delivered: true }), "ready for review");
});

test("a decided file is never rewritten, delivered or not", () => {
  for (const s of ["MERGED", "APPROVED", "ACCEPTED", "REJECTED", "DRAFT"]) {
    assert.equal(versionStateWords(s, { latest: true, delivered: true }), versionStateWords(s, { latest: true, delivered: false }), s);
  }
});

test("the trail's last step is the state the file is in; the steps before it are history", () => {
  assert.deepEqual(trailWords(["DRAFT", "READY_FOR_REVIEW"], true), ["draft", CLOSED_REVIEW.row]);
  assert.deepEqual(trailWords(["DRAFT", "READY_FOR_REVIEW", "MERGED"], true), ["draft", "ready for review", "merged"], "a decided file's trail is untouched");
  assert.deepEqual(trailWords(["DRAFT", "READY_FOR_REVIEW"]), ["draft", "ready for review"], "the default keeps the old reading");
});

test("the reader reads the mission, and every place it names the current state goes through the one function", () => {
  assert.match(reader, /const \{ facts \} = useMission\(\);/, "the reader reads the mission's own fact");
  assert.match(reader, /facts\.goalStatus === "COMPLETED"/, "the same predicate the Files page uses");
  assert.match(reader, /versionStateWords\(s, \{ latest: latestVersion, delivered \}\)/, "the words are files.ts's");
  assert.match(reader, /\{stateWords\(status, shown === latest\)\}/, "the head's pill is the version on screen");
  assert.match(reader, /hint: `v\$\{v\.version\} · \$\{stateWords\(v\.status, v\.version === latest\)\}/, "the version picker's hint says the same");
  assert.match(reader, /trailWords\(viewed\.trail, closed\)/, "and the trail ends in it");
  assert.match(reader, /How version \$\{viewed\.version\} got to \$\{stateWords\(viewed\.status, closed\)\}/, "its name for a screen reader too");
});
