import test from "node:test";
import assert from "node:assert/strict";

import {
  BUCKETS, NOT_HELD, STALE_AFTER_MS, bucketOf, feedState, heldList, holdMark, holdText, isHolding, newCountText, newestKey, pauseControl, sinceText,
} from "../../apps/mesh-dashboard/src/feed";
import { PAGE_ROWS, rovingTarget, tabStop } from "../../apps/mesh-dashboard/src/roving";
import { count, middleClip } from "../../apps/mesh-dashboard/src/text";

/**
 * The live feed on Events and Steps. "Live" used to be printed whatever the connection was doing, and Pause threw events away.
 * These pin what the header says in each connection state, and what a hold hides (and never discards).
 */

const NOW = 1_800_000_000_000;
const open = { sse: "open" as const, serverDown: false, heardAt: NOW - 2_000, now: NOW };

test("an open stream that was heard from a moment ago is live, and says how long ago", () => {
  const s = feedState(open);
  assert.equal(s.label, "Live");
  assert.equal(s.tone, "ok");
  assert.equal(s.detail, "Updated 2s ago");
  assert.equal(s.live, true);
  assert.equal(s.stale, false);
});

test("a server that stopped answering outranks every stream state, and is labelled stale", () => {
  for (const sse of ["open", "reconnecting", "connecting"] as const) {
    const s = feedState({ ...open, sse, serverDown: true, heardAt: NOW - 41_000 });
    assert.equal(s.label, "Server not answering", sse);
    assert.equal(s.tone, "bad");
    assert.equal(s.live, false);
    assert.equal(s.stale, true);
    assert.match(s.detail, /Last update 41s ago/);
    assert.match(s.detail, /out of date/);
  }
});

test("a dropped stream is reconnecting, not live, and keeps saying how old the picture is", () => {
  const s = feedState({ ...open, sse: "reconnecting", heardAt: NOW - 125_000 });
  assert.equal(s.label, "Reconnecting");
  assert.equal(s.tone, "warn");
  assert.equal(s.live, false);
  assert.equal(s.stale, true);
  assert.match(s.detail, /Last update 2m ago/);
});

test("before the stream first connects the feed is neither live nor stale", () => {
  const s = feedState({ ...open, sse: "connecting" });
  assert.equal(s.label, "Connecting");
  assert.equal(s.tone, "neutral");
  assert.equal(s.live, false);
  assert.equal(s.stale, false);
});

test("an open stream with no word for longer than the stale limit stops claiming to be live", () => {
  const edge = feedState({ ...open, heardAt: NOW - STALE_AFTER_MS });
  assert.equal(edge.label, "Live", "exactly at the limit is still live");
  const past = feedState({ ...open, heardAt: NOW - STALE_AFTER_MS - 1 });
  assert.equal(past.label, "Not updating");
  assert.equal(past.tone, "warn");
  assert.equal(past.stale, true);
});

test("a heard-at in the future (clock skew) is treated as just now, never as a negative age", () => {
  assert.equal(feedState({ ...open, heardAt: NOW + 5_000 }).detail, "Updated just now");
});

test("sinceText floors, so a minute is never printed as 60 seconds", () => {
  assert.equal(sinceText(0), "just now");
  assert.equal(sinceText(999), "just now");
  assert.equal(sinceText(1_000), "1s ago");
  assert.equal(sinceText(59_999), "59s ago");
  assert.equal(sinceText(60_000), "1m ago");
  assert.equal(sinceText(3_599_999), "59m ago");
  assert.equal(sinceText(3_600_000), "1h ago");
  assert.equal(sinceText(NaN), "just now");
});

/* ------------------------------------------------------------------ holding */

const key = (n: { k: number }): number => n.k;
const rows = (...ks: number[]): { k: number; v?: string }[] => ks.map((k) => ({ k }));

test("any one reason holds the list, and none releases it", () => {
  assert.equal(isHolding(NOT_HELD), false);
  for (const reason of ["paused", "scrolled", "pointer", "focus"] as const) {
    assert.equal(isHolding({ ...NOT_HELD, [reason]: true }), true, reason);
  }
});

test("a hold keeps the mark it began with, however many rows arrive; releasing clears it", () => {
  assert.equal(holdMark(null, true, 40), 40, "the mark is the newest row when the hold begins");
  assert.equal(holdMark(40, true, 55), 40, "rows arriving during the hold do not move it");
  assert.equal(holdMark(40, false, 55), null, "no reason left: released");
  assert.equal(holdMark(null, false, 55), null);
});

test("an empty list is never held, so the first rows to arrive are shown rather than counted as new", () => {
  // A mouse parked where the list will appear is "pointing at it" before there is a row to keep still.
  assert.equal(holdMark(null, true, 0), null, "nothing on screen, nothing to freeze");
  assert.equal(holdMark(null, true, 12), 12, "the hold begins once rows exist");
  assert.equal(holdMark(12, true, 0), null, "a list that empties (another project) lets go");
  const first = heldList(rows(12, 11, 10), key, holdMark(null, true, 0));
  assert.deepEqual(first.shown.map(key), [12, 11, 10]);
  assert.equal(first.fresh, 0);
});

test("not held: every row is drawn, none is counted as new, and the array is the one passed in", () => {
  const items = rows(5, 4, 3);
  const r = heldList(items, key, null);
  assert.equal(r.shown, items, "same array, so a caller's memoisation survives");
  assert.equal(r.fresh, 0);
});

test("held: rows newer than the mark are counted, not drawn, and the mark itself is still drawn", () => {
  const r = heldList(rows(9, 8, 7, 6, 5), key, 7);
  assert.deepEqual(r.shown.map(key), [7, 6, 5]);
  assert.equal(r.fresh, 2);
});

test("held: a row already on screen shows its latest data, because only the set of rows is frozen", () => {
  const before = [{ k: 3, v: "working" }, { k: 2, v: "done" }];
  const after = [{ k: 4, v: "working" }, { k: 3, v: "done" }, { k: 2, v: "done" }];
  const mark = newestKey(before, key);
  const r = heldList(after, key, mark);
  assert.deepEqual(r.shown, [{ k: 3, v: "done" }, { k: 2, v: "done" }], "row 3 finished while held and shows it");
  assert.equal(r.fresh, 1);
});

test("held: older rows loaded later (load older turns) are still drawn", () => {
  const r = heldList(rows(10, 9, 2, 1), key, 10);
  assert.deepEqual(r.shown.map(key), [10, 9, 2, 1]);
  assert.equal(r.fresh, 0);
});

test("an empty list has no newest key and nothing is new", () => {
  assert.equal(newestKey([], key), 0);
  assert.deepEqual(heldList([], key, 5), { shown: [], fresh: 0 });
});

test("the new-rows count reads as a sentence", () => {
  assert.equal(newCountText(1, "event"), "1 new event");
  assert.equal(newCountText(3, "event"), "3 new events");
  assert.equal(newCountText(1204, "turn"), "1,204 new turns");
});

/* --------------------------------------------------------------- time buckets */

test("a moment lands in the first bucket whose bound it is younger than", () => {
  const at = (ageMs: number): string => bucketOf(NOW - ageMs, NOW).id;
  assert.equal(at(0), "now");
  assert.equal(at(5 * 60_000 - 1), "now");
  assert.equal(at(5 * 60_000), "recent", "a bound belongs to the older bucket");
  assert.equal(at(30 * 60_000), "hour");
  assert.equal(at(2 * 3_600_000), "day");
  assert.equal(at(12 * 3_600_000), "older");
  assert.equal(at(40 * 86_400_000), "older");
  assert.equal(BUCKETS[BUCKETS.length - 1]!.ms, Infinity);
});

test("a moment in the future is now, and one with no valid date is earlier", () => {
  assert.equal(bucketOf(NOW + 60_000, NOW).id, "now");
  assert.equal(bucketOf(NaN, NOW).id, "older");
});

/* --------------------------------------------------------------- roving focus */

test("arrows move one row and stop at the ends; the list is not a ring", () => {
  assert.equal(rovingTarget("ArrowDown", 0, 5), 1);
  assert.equal(rovingTarget("ArrowDown", 4, 5), 4);
  assert.equal(rovingTarget("ArrowUp", 4, 5), 3);
  assert.equal(rovingTarget("ArrowUp", 0, 5), 0);
});

test("j and k are the same keys the step drawer uses, so the muscle memory carries", () => {
  assert.equal(rovingTarget("j", 1, 5), 2);
  assert.equal(rovingTarget("k", 1, 5), 0);
});

test("Home, End and the Page keys jump; Page clamps to the ends", () => {
  assert.equal(rovingTarget("Home", 3, 50), 0);
  assert.equal(rovingTarget("End", 3, 50), 49);
  assert.equal(rovingTarget("PageDown", 3, 50), 3 + PAGE_ROWS);
  assert.equal(rovingTarget("PageDown", 45, 50), 49);
  assert.equal(rovingTarget("PageUp", 3, 50), 0);
  assert.equal(rovingTarget("PageUp", 30, 50, 5), 25);
});

test("focus that is not on a row yet enters the list at the first row; other keys are left alone", () => {
  assert.equal(rovingTarget("ArrowDown", -1, 5), 0);
  assert.equal(rovingTarget("ArrowUp", -1, 5), 0);
  assert.equal(rovingTarget("Enter", 1, 5), null);
  assert.equal(rovingTarget("a", 1, 5), null);
  assert.equal(rovingTarget("ArrowDown", 0, 0), null, "an empty list has nowhere to go");
});

test("the list's one tab stop is the last row used, while it is still there, otherwise the first", () => {
  assert.equal(tabStop(["a", "b", "c"], "b"), "b");
  assert.equal(tabStop(["a", "b", "c"], "x"), "a", "the row was filtered away");
  assert.equal(tabStop(["a", "b", "c"], null), "a");
  assert.equal(tabStop([], "b"), null);
});

/* ------------------------------------------------------------------ text */

test("middleClip keeps both ends of a long id and leaves a short one whole", () => {
  assert.equal(middleClip("evt-muu7bezm-uizlvct6"), "evt-muu7bezm-uizlvct6");
  const long = "turn-0123456789abcdef0123456789abcdef";
  const c = middleClip(long, 24);
  assert.equal(c.length, 24);
  assert.ok(c.startsWith("turn-"));
  assert.ok(c.endsWith(long.slice(-9)));
  assert.ok(c.includes("…"));
});

test("middleClip does not invent an ellipsis for a limit too small to hold one", () => {
  assert.equal(middleClip("abcdefghij", 4), "abcdefghij");
});

test("count pluralises, with grouping for large numbers", () => {
  assert.equal(count(1, "turn"), "1 turn");
  assert.equal(count(0, "turn"), "0 turns");
  assert.equal(count(1500, "event"), "1,500 events");
  assert.equal(count(2, "reply", "replies"), "2 replies");
});

test("the feed's hold control names what it pauses, so it cannot be read as the mission's Pause beside it", () => {
  const off = pauseControl(false, "events");
  assert.equal(off.label, "Pause updates");
  assert.match(off.title, /does not pause the mission/);
  assert.match(off.title, /new events keep arriving and are counted, not lost/);
  assert.equal(pauseControl(true, "turns").label, "Resume updates");
  assert.equal(pauseControl(true, "turns").title, "Show turns as they arrive again");
  for (const paused of [false, true]) assert.doesNotMatch(pauseControl(paused, "events").label, /^(Pause|Resume)$/, "never the bare word");
});

test("a paused list says updates are paused and what waits, and resumes by name; a list held by pointing owes only the count", () => {
  assert.deepEqual(holdText(true, 3, "event"), { lead: "Updates paused.", text: "3 new events waiting.", button: "Resume updates" });
  assert.deepEqual(holdText(true, 0, "turn"), { lead: "Updates paused.", text: "Nothing new yet.", button: "Resume updates" });
  assert.deepEqual(holdText(false, 1, "turn"), { lead: null, text: "1 new turn.", button: "Show" });
  assert.equal(holdText(false, 0, "event"), null, "nothing held, nothing waiting: nothing to say");
});
