import test from "node:test";
import assert from "node:assert/strict";

import { attentionOf, faviconFor, type Attention, type AttentionInput, type AttentionKind } from "../../apps/mesh-dashboard/src/attention";
import { describeMission, type MissionFacts, type MissionPhase } from "../../apps/mesh-dashboard/src/mission";

/**
 * Which moments of a mission are news to someone who is not looking at the console, and what the tab's icon says of them. The
 * claim is in the exclusions as much as the inclusions: a pause the person pressed, a closed project and a mission that is merely
 * running tell nobody anything, and a mission that cannot be read right now is not "all clear".
 */

const input = (over: Partial<AttentionInput> = {}): AttentionInput => ({
  phase: "running",
  tone: "ok",
  label: "Running",
  headline: "2 agents working.",
  decisionIds: [],
  decisionTitles: [],
  reason: null,
  goalId: "goal-1",
  deliveredAt: null,
  projectId: "payments",
  projectName: "Payments",
  ...over,
});

const kindOf = (over: Partial<AttentionInput>): AttentionKind | null => attentionOf(input(over))?.kind ?? null;

test("a mission that cannot be read right now is not known, which is not the same as nothing to tell", () => {
  assert.equal(attentionOf(input({ phase: "loading", tone: "neutral", label: "Starting" })), null);
  assert.equal(attentionOf(input({ phase: "offline", tone: "bad", label: "Offline" })), null);
  assert.equal(faviconFor(null), "plain", "no badge claims what is not known");
});

test("every phase has a deliberate answer: three are news, and the person's own pause is not one of them", () => {
  const expected: Record<MissionPhase, AttentionKind | null> = {
    loading: null,
    offline: null,
    down: "none", // a closed project; a crashed one is the next test
    ceiling: "stopped",
    "needs-you": "needs-you",
    failed: "stopped",
    done: "delivered",
    paused: "none",
    parked: "none",
    stalled: "none",
    quiet: "none",
    running: "none",
  };
  for (const [phase, kind] of Object.entries(expected) as Array<[MissionPhase, AttentionKind | null]>) {
    assert.equal(kindOf({ phase, tone: "neutral" }), kind, phase);
  }
});

test("a decision that holds the mission or a seat is told by its id, in an order that does not depend on how the list arrived", () => {
  const a = attentionOf(input({ phase: "needs-you", tone: "bad", decisionIds: ["esc-b", "esc-a"] }))!;
  assert.equal(a.kind, "needs-you");
  assert.deepEqual(a.keys, ["esc-a", "esc-b"]);
  assert.deepEqual(attentionOf(input({ phase: "needs-you", tone: "bad", decisionIds: ["esc-a", "esc-b"] }))!.keys, a.keys);
});

test("a goal that is escalated with no card to answer is still a mission waiting on a person, told by its goal", () => {
  const a = attentionOf(input({ phase: "needs-you", tone: "bad", decisionIds: [], goalId: "goal-9" }))!;
  assert.equal(a.kind, "needs-you");
  assert.deepEqual(a.keys, ["halt:goal-9"]);
});

test("a delivery is told by its goal and its completion stamp, so a reopened mission delivered again is news again", () => {
  const first = attentionOf(input({ phase: "done", label: "Delivered", deliveredAt: "2026-10-06T10:00:00Z" }))!;
  const again = attentionOf(input({ phase: "done", label: "Delivered", deliveredAt: "2026-10-06T11:30:00Z" }))!;
  assert.equal(first.kind, "delivered");
  assert.notDeepEqual(first.keys, again.keys);
  assert.deepEqual(first.keys, attentionOf(input({ phase: "done", deliveredAt: "2026-10-06T10:00:00Z" }))!.keys, "the same delivery seen twice is one");
});

test("a failed mission and one parked by the host's ceiling are stops, told apart from each other", () => {
  const failed = attentionOf(input({ phase: "failed", tone: "bad", label: "Failed", reason: "The mission ran out of time." }))!;
  const ceiling = attentionOf(input({ phase: "ceiling", tone: "bad", label: "Spend ceiling" }))!;
  assert.equal(failed.kind, "stopped");
  assert.equal(ceiling.kind, "stopped");
  assert.notDeepEqual(failed.keys, ceiling.keys);
  assert.equal(failed.reason, "The mission ran out of time.");
});

test("a project that crashed or cannot open is a stop; one the person closed is not", () => {
  assert.equal(kindOf({ phase: "down", tone: "bad", label: "Crashed" }), "stopped");
  assert.equal(kindOf({ phase: "down", tone: "neutral", label: "Closed" }), "none");
  assert.notDeepEqual(attentionOf(input({ phase: "down", tone: "bad", label: "Crashed" }))!.keys, attentionOf(input({ phase: "down", tone: "bad", label: "Locked" }))!.keys);
});

test("the person's own pause, a parked project, a quiet or an idle mission and one that is running are nothing to tell", () => {
  for (const phase of ["paused", "parked", "quiet", "stalled", "running"] as const) {
    const a = attentionOf(input({ phase, tone: "warn" }))!;
    assert.equal(a.kind, "none", phase);
    assert.deepEqual(a.keys, [], phase);
  }
});

test("the icon follows the kind: a badge for each of the three, the plain one for everything else", () => {
  const icon = (over: Partial<AttentionInput>): string => faviconFor(attentionOf(input(over)));
  assert.equal(icon({ phase: "needs-you", tone: "bad", decisionIds: ["esc-1"] }), "needs-you");
  assert.equal(icon({ phase: "done" }), "delivered");
  assert.equal(icon({ phase: "failed", tone: "bad" }), "stopped");
  assert.equal(icon({ phase: "ceiling", tone: "bad" }), "stopped");
  assert.equal(icon({ phase: "down", tone: "bad" }), "stopped");
  for (const phase of ["running", "quiet", "stalled", "paused", "parked"] as const) assert.equal(icon({ phase }), "plain", phase);
});

/* The same reading, fed from the mission's own state: what mission.ts calls these phases is what the icon is drawn from. */

const facts = (over: Partial<MissionFacts> = {}): MissionFacts => ({
  hasStatus: true, serverDown: false, projectDown: null, goalStatus: "ACTIVE", parked: false, blockingDecisions: 0, seatHeldDecisions: [],
  advisoryDecisions: 0, hostCeilingTripped: false, working: 2, waiting: 1, runningSteps: 0, hasHistory: true, startupSeats: 2, ...over,
});
const fromMission = (f: MissionFacts, over: Partial<AttentionInput> = {}): Attention | null => {
  const s = describeMission(f);
  return attentionOf(input({ phase: s.phase, tone: s.tone, label: s.label, headline: s.headline, ...over }));
};

test("read through describeMission: a decision on the mission, a delivery and a crash are news; a pause is not", () => {
  assert.equal(fromMission(facts({ blockingDecisions: 1 }), { decisionIds: ["esc-1"] })?.kind, "needs-you");
  assert.equal(fromMission(facts({ goalStatus: "COMPLETED", parked: true, working: 0 }))?.kind, "delivered");
  assert.equal(fromMission(facts({ goalStatus: "FAILED" }))?.kind, "stopped");
  assert.equal(fromMission(facts({ projectDown: { label: "crashed", hint: "The process exited.", severe: true } }))?.kind, "stopped");
  assert.equal(fromMission(facts({ projectDown: { label: "closed", hint: "Closed.", severe: false } }))?.kind, "none");
  assert.equal(fromMission(facts({ goalStatus: "PAUSED", working: 0 }))?.kind, "none");
  assert.equal(fromMission(facts({ serverDown: true })), null);
  assert.equal(fromMission(facts({ hasStatus: false })), null);
  // A seat's own budget card needs the person but does not stop the mission: still a decision waiting on them.
  assert.equal(fromMission(facts({ blockingDecisions: 1, seatHeldDecisions: ["qa"] }), { decisionIds: ["esc-2"] })?.kind, "needs-you");
});
