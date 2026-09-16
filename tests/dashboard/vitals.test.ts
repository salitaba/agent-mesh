import test from "node:test";
import assert from "node:assert/strict";

import { vitalsOf, phaseLegs, STALL_BAD_MS, type TurnPhases } from "../../apps/mesh-dashboard/src/vitals";

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
    running: true,
    now: NOW,
  });

  assert.equal(v.health, "streaming");
  assert.equal(v.label, "working");
  assert.equal(v.toolFrames, 6);
  assert.match(v.detail, /6 tool calls/);
  assert.equal(v.silentMs, 1_000, "silence runs from the last sign of life, not the last token");
});

test("tool work that then stops still reports a stall", () => {
  const v = vitalsOf({
    phases: base({ firstActivityAt: NOW - 80_000, lastActivityAt: NOW - (STALL_BAD_MS + 5_000) }),
    toolFrames: 2,
    running: true,
    now: NOW,
  });

  assert.equal(v.health, "stalled", "the fix must not make a wedged turn unkillable");
  assert.equal(v.label, "stalled");
  assert.match(v.detail, /2 tool calls/);
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
