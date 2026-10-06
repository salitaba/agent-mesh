import test from "node:test";
import assert from "node:assert/strict";

import { vitalsOf, phaseLegs, toolWorkLabel, STALL_BAD_MS, type TurnPhases } from "../../apps/mesh-dashboard/src/vitals";

/**
 * The bug these cover: an agent that designs by writing files never streams a
 * token, so the dashboard graded its turn on token silence alone and reported
 * "no response" about an agent the operator could watch creating files. Health
 * has to be derived from activity of any kind, with prose as one kind.
 */

const NOW = 1_700_000_000_000;
const base = (over: Partial<TurnPhases>): TurnPhases => ({ startedAt: NOW - 90_000, llmCallAt: NOW - 88_000, ...over });

test("a turn working through tools reads as working, not as no response", () => {
  const v = vitalsOf({
    // Far past the no-token stall threshold, which is exactly the turn that
    // used to be slandered as dead.
    phases: base({ firstActivityAt: NOW - 80_000, lastActivityAt: NOW - 1_000 }),
    toolFrames: 6,
    toolCallCount: 3,
    running: true,
    now: NOW,
  });

  assert.equal(v.health, "streaming");
  assert.equal(v.label, "working");
  assert.equal(v.toolFrames, 6);
  assert.match(v.detail, /3 tool calls/, "the count is of calls, not of their start+result frames");
  assert.equal(v.silentMs, 1_000, "silence runs from the last sign of life, not the last token");
});

test("tool work that then stops still reports a stall", () => {
  const v = vitalsOf({
    phases: base({ firstActivityAt: NOW - 80_000, lastActivityAt: NOW - (STALL_BAD_MS + 5_000) }),
    toolFrames: 4,
    toolCallCount: 2,
    running: true,
    now: NOW,
  });

  assert.equal(v.health, "stalled", "the fix must not make a wedged turn unkillable");
  assert.equal(v.label, "stalled");
  assert.match(v.detail, /2 tool calls/);
});

test("a turn that went silent after one character says one character", () => {
  const silent = NOW - (STALL_BAD_MS + 5_000);
  const v = vitalsOf({
    phases: base({ firstTokenAt: NOW - 80_000, lastTokenAt: silent, firstActivityAt: NOW - 80_000, lastActivityAt: silent }),
    clientChars: 1,
    running: true,
    now: NOW,
  });

  assert.equal(v.health, "stalled");
  assert.match(v.detail, /after streaming 1 character —/);
});

test("a turn with no sign of life at all still reads as no response", () => {
  const v = vitalsOf({ phases: base({}), running: true, now: NOW });

  assert.equal(v.health, "stalled");
  assert.equal(v.label, "no response");
  assert.equal(v.chars, 0);
});

test("a streaming turn that pauses to run a tool is not called stalled", () => {
  const v = vitalsOf({
    // Spoke 40s ago — past STALL_BAD_MS on prose alone — but a tool frame
    // landed a second ago, so the turn is alive.
    phases: base({ firstTokenAt: NOW - 60_000, lastTokenAt: NOW - 40_000, firstActivityAt: NOW - 60_000, lastActivityAt: NOW - 1_000 }),
    clientChars: 800,
    toolFrames: 3,
    running: true,
    now: NOW,
  });

  assert.equal(v.health, "streaming");
  assert.equal(v.silentMs, 1_000);
  assert.equal(v.chars, 800, "prose already streamed is still reported");
});

test("a tool-only turn gets its own leg instead of an endless wait-on-model bar", () => {
  const legs = phaseLegs(base({ firstActivityAt: NOW - 80_000, lastActivityAt: NOW - 1_000 }), true, NOW);
  const keys = legs.map((l) => l.key);

  assert.ok(keys.includes("work"), `expected a tool leg, got ${keys.join(",")}`);
  assert.equal(keys.includes("stream"), false, "nothing was streamed, so there is no stream leg");
  const wait = legs.find((l) => l.key === "wait");
  assert.ok(wait && wait.ms < 20_000, "the wait leg must end when the first tool frame lands");
});

test("a turn that streamed gets no duplicate tool leg", () => {
  const legs = phaseLegs(
    base({ firstTokenAt: NOW - 70_000, lastTokenAt: NOW - 2_000, firstActivityAt: NOW - 70_000, lastActivityAt: NOW - 1_000 }),
    true,
    NOW,
  );

  assert.equal(legs.filter((l) => l.key === "work").length, 0, "tokens stamp activity too — that leg would double-count the stream");
  assert.ok(legs.some((l) => l.key === "stream"));
});

test("a finished turn's legs are described in the past tense", () => {
  // "prompt sent, nothing back yet" was printed under turns that had ended
  // an hour earlier: the hint described a wait that was long over.
  const done = phaseLegs(
    base({ contextAt: NOW - 89_000, firstTokenAt: NOW - 70_000, llmDoneAt: NOW - 10_000, opsDoneAt: NOW - 9_000, endedAt: NOW - 9_000 }),
    false,
    NOW,
  );
  const wait = done.find((l) => l.key === "wait");
  assert.ok(wait, `expected a wait leg, got ${done.map((l) => l.key).join(",")}`);
  assert.doesNotMatch(wait.hint, /nothing back yet/);
  assert.ok(done.every((l) => !l.open), "every leg of a finished turn is closed");
  assert.equal(done.find((l) => l.key === "stream")?.hint, "streamed its reply");
});

test("only the leg still accruing on a live turn reads as happening now", () => {
  const live = phaseLegs(base({ contextAt: NOW - 89_000, firstTokenAt: NOW - 70_000 }), true, NOW);
  const wait = live.find((l) => l.key === "wait");
  const stream = live.find((l) => l.key === "stream");
  assert.ok(wait && stream);
  assert.equal(stream.open, true);
  assert.equal(stream.hint, "streaming its reply");
  assert.equal(wait.open, false);
  assert.doesNotMatch(wait.hint, /nothing back yet/, "the wait is over once the first token landed, live turn or not");
});

test("an older record with frames only is labelled in frames, never as calls", () => {
  // A call's start and its result are both frames, so "N tool calls" off the
  // frame count doubled every figure (94 calls read as 188).
  const v = vitalsOf({
    phases: base({ firstActivityAt: NOW - 80_000, lastActivityAt: NOW - 1_000 }),
    toolFrames: 188,
    running: true,
    now: NOW,
  });
  assert.match(v.detail, /188 tool frames/);
  assert.doesNotMatch(v.detail, /tool calls?\b/);
  assert.equal(toolWorkLabel(94, 188), "94 tool calls");
  assert.equal(toolWorkLabel(1, 2), "1 tool call");
  assert.equal(toolWorkLabel(undefined, 1), "1 tool frame");
  assert.equal(toolWorkLabel(0, 0), "tool calls", "nothing counted: the generic phrase, not a zero");
});

test("the deadline and ceiling stamps never become a phase leg", () => {
  // They are future promises, not marks: read as marks, a live turn grew a leg
  // that ran to its stop time, and a finished turn's span stretched to it.
  const marks = base({ contextAt: NOW - 89_000, firstTokenAt: NOW - 70_000, llmDoneAt: NOW - 10_000, opsDoneAt: NOW - 9_000, endedAt: NOW - 9_000 });
  const withStops = { ...marks, deadlineAt: NOW + 600_000, ceilingAt: NOW + 1_800_000 };
  assert.deepEqual(phaseLegs(withStops, false, NOW), phaseLegs(marks, false, NOW));
  const live = { ...base({ firstActivityAt: NOW - 80_000, lastActivityAt: NOW - 1_000 }), deadlineAt: NOW + 60_000, ceilingAt: NOW + 900_000 };
  const legs = phaseLegs(live, true, NOW);
  assert.ok(legs.every((l) => l.offset + l.ms <= 90_000), "no leg reaches into the future");
});
