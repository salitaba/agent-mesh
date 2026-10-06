import test from "node:test";
import assert from "node:assert/strict";

import { dur, hhmmss, localDateTime, localTime, plainBlocker, plainEvent, plural, snippetDiff, spanLabel, zoneLabel } from "../../apps/mesh-dashboard/src/format";
// Deep import for the same reason events.tsx uses one: catalog.ts carries only
// the const tables, not the AJV-backed barrel.
import { EVENT_TYPES } from "../../packages/protocol/src/catalog";

/**
 * A step's timeline mixed two vocabularies: types with a plain label ("woke
 * up") beside raw dotted names ("thread.created"), and a transition labelled
 * "moved forward" whichever way it went.
 */

test("every catalog event type has a plain lowercase label", () => {
  const raw = EVENT_TYPES.filter((t) => plainEvent(t) === t);
  assert.deepEqual(raw, [], "a type the label table does not name falls through to its dotted name");
  const odd = EVENT_TYPES.filter((t) => !/^[a-z][a-z' -]*$/.test(plainEvent(t)));
  assert.deepEqual(odd, [], "labels are short lowercase phrases, one style");
});

test("an artifact transition names the state it moved to", () => {
  // The kernel's walk-back (UNDER_REVIEW -> DRAFT on a new version) is the
  // case "moved forward" got backwards.
  assert.equal(plainEvent("artifact.transition", { artifactId: "art-1", to: "DRAFT", derived: true }), "moved to draft");
  assert.equal(plainEvent("artifact.transition", { to: "UNDER_REVIEW" }), "moved to under review");
  assert.equal(plainEvent("artifact.transition"), "moved", "without a payload it says only that it moved");
  assert.equal(plainEvent("artifact.transition", { to: 3 }), "moved");
});

test("artifact creation reads as published, matching the op ledger", () => {
  assert.equal(plainEvent("artifact.created"), "published");
});

test("an activation denial still reads as couldn't wake, and only with its payload", () => {
  const denial = { action: "activate (budget)", reason: "over budget" };
  assert.equal(plainEvent("message.rejected", denial), "couldn't wake");
  assert.equal(plainEvent("message.rejected"), "blocked message");
  assert.equal(plainEvent("message.rejected", { to: ["pm"], action: "activate (x)" }), "blocked message");
});

test("a count agrees with its noun when the count is one", () => {
  // The agent drawer said "1 approvals" and "0 active file locks", the step drawer "arguments captured for 0 of 1 actions".
  assert.equal(plural(1, "verdict"), "1 verdict");
  assert.equal(plural(2, "verdict"), "2 verdicts");
  assert.equal(plural(0, "file lock"), "0 file locks");
  assert.equal(plural(1, "match", "matches"), "1 match");
  assert.equal(plural(3, "match", "matches"), "3 matches");
});

test("unknown types still fall back to the raw name", () => {
  assert.equal(plainEvent("brand.new_type"), "brand.new_type");
});

test("an edit that appends shows trimmed context, then only the added lines", () => {
  const before = ["a", "b", "c", "d", "e"].join("\n");
  const after = ["a", "b", "c", "d", "e", "f", "g"].join("\n");
  const d = snippetDiff(before, after);
  assert.deepEqual(d, [
    { op: "gap", text: "⋯ 2 unchanged lines" },
    { op: "eq", text: "c" },
    { op: "eq", text: "d" },
    { op: "eq", text: "e" },
    { op: "add", text: "f" },
    { op: "add", text: "g" },
  ]);
});

test("a replacement in the middle keeps both sides' context", () => {
  const d = snippetDiff("x\nold\ny", "x\nnew one\nnew two\ny");
  assert.deepEqual(d.map((l) => `${l.op}:${l.text}`), ["eq:x", "del:old", "add:new one", "add:new two", "eq:y"]);
});

test("head and tail never overlap when one side is contained in the other", () => {
  // "a\na" -> "a": a naive head/tail scan counts the shared line twice.
  const d = snippetDiff("a\na", "a");
  assert.equal(d.filter((l) => l.op === "del").length, 1);
  assert.equal(d.filter((l) => l.op === "add").length, 0);
  assert.equal(d.filter((l) => l.op === "eq").length, 1);
});

test("durations past an hour read in hours and minutes, and never as 60s", () => {
  assert.equal(dur(42_281_000), "11h 45m", "a twelve-hour axis tick is not -704m 41s");
  assert.equal(dur(3_600_000), "1h 0m");
  assert.equal(dur(179_600), "3m 0s", "rounding up to the next minute carries, not 2m 60s");
  assert.equal(dur(125_000), "2m 5s");
  assert.equal(dur(4_200), "4.2s");
  assert.equal(dur(undefined), "");
});

test("axis spans drop their zero parts", () => {
  assert.equal(spanLabel(2 * 3_600_000), "2h");
  assert.equal(spanLabel(90 * 60_000), "1h 30m");
  assert.equal(spanLabel(5 * 60_000), "5m");
  assert.equal(spanLabel(30_000), "30s");
});

test("the budget gate's refusal names the budget and rounds its amounts", () => {
  assert.equal(
    plainBlocker("budget mission:goal-M3ECC9GF004408d6e76 exhausted (13065531/12640000)"),
    "mission budget used up — 13.1M of 12.6M",
    "the overrun survives the rounding",
  );
  assert.equal(plainBlocker("budget agent:goal-1/pm exhausted (61200/50000)"), "pm's budget used up — 61.2k of 50.0k");
  assert.equal(plainBlocker("thread budget exhausted: thr-1"), "thread budget exhausted: thr-1", "anything else is left alone");
});

/**
 * `hhmmss` was the UTC slice of the ISO string, unlabelled, on the Events console, the event pane, the step inspector and
 * the drawers, while the Overview's mini-feed printed local time. One event, two times, on two screens. Everything is local
 * now, and the zone is said once.
 */
test("a time of day is shown in the reader's zone, not sliced out of the UTC string", () => {
  const iso = "2026-10-04T18:42:07.000Z";
  assert.equal(localTime(iso, "UTC"), "18:42:07");
  assert.equal(localTime(iso, "Asia/Tehran"), "22:12:07", "UTC+3:30");
  assert.equal(localTime(iso, "America/New_York"), "14:42:07", "UTC-4 in October");
  assert.equal(hhmmss(iso), localTime(iso), "the old name now means local time");
});

test("a timestamp that is not a date renders as nothing, not as 'Invalid Date'", () => {
  for (const bad of ["", undefined, null, "not a date", "2026-13-45"]) {
    assert.equal(localTime(bad), "");
    assert.equal(localDateTime(bad), "");
  }
});

test("a date and time, and the zone those times are in", () => {
  assert.equal(localDateTime("2026-10-04T23:30:00.000Z", "Asia/Tehran"), "5 Oct, 03:00:00", "rolls over the day in the reader's zone");
  assert.equal(zoneLabel("UTC"), "UTC");
  assert.equal(zoneLabel("Asia/Tehran", new Date("2026-10-04T12:00:00Z")), "GMT+3:30");
});
