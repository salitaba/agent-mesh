import test from "node:test";
import assert from "node:assert/strict";

import {
  FILTERS, FOLD_AT, MIN_BAR_PCT, WINDOWS, autoWindow, axisTicks, busyText, filterSteps, foldQuiet, groupSteps, outcomeCounts, pulseLine,
  rowSummary, spendOf, timeline, type StepLike,
} from "../../apps/mesh-dashboard/src/steps";
import { BUCKETS } from "../../apps/mesh-dashboard/src/feed";
import { rovingTarget } from "../../apps/mesh-dashboard/src/roving";

/**
 * The Steps page's decisions: what each legend chip counts and then shows, which turns may be folded away, where a turn sits on
 * the swimlane, and what the strip says is running.
 */

const NOW = Date.parse("2026-10-04T20:00:00.000Z");
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

let seq = 0;
const SHIPPED = { messages: 1, artifacts: 0, tasks: 0, decisions: 0 };
const NOTHING = { messages: 0, artifacts: 0, tasks: 0, decisions: 0 };

/** A finished turn. `agoMs` is how long ago it started and `ms` how long it took. */
function turn(kind: "shipped" | "quiet" | "rejected" | "blocked" | "crashed" | "live", agentId: string, agoMs: number, ms = 1000, extra: Partial<StepLike> = {}): StepLike {
  const base: StepLike = {
    turnId: `turn-${++seq}`, agentId, startedAt: iso(agoMs), endedAt: iso(agoMs - ms), durationMs: ms, tokens: 1000, reasonKind: "message", seqStart: seq,
    status: "ok", ops: NOTHING,
  };
  switch (kind) {
    case "shipped": return { ...base, ops: SHIPPED, ...extra };
    case "quiet": return { ...base, ...extra };
    case "rejected": return { ...base, opTimings: [{ op: "approve", ok: false, reason: "mission is COMPLETED" }], ...extra };
    case "blocked": return { ...base, status: "blocked", ...extra };
    case "crashed": return { ...base, status: "failed", ...extra };
    case "live": return { ...base, status: "running", endedAt: undefined, durationMs: undefined, ...extra };
  }
}

/* ------------------------------------------------------------------ legend */

test("each legend chip's count is exactly what its filter then shows", () => {
  const steps = [
    turn("shipped", "pm", 100_000), turn("shipped", "qa", 90_000), turn("quiet", "qa", 80_000), turn("rejected", "pm", 70_000),
    turn("blocked", "dev", 60_000), turn("crashed", "dev", 50_000), turn("live", "pm", 5_000),
  ];
  const counts = outcomeCounts(steps);
  assert.deepEqual(counts, { shipped: 2, quiet: 1, rejected: 1, blocked: 1, crashed: 1, live: 1 });
  for (const f of FILTERS) {
    if (!f.id) continue;
    assert.equal(filterSteps(steps, f.id, "").length, counts[f.id] ?? 0, f.label);
  }
  assert.equal(filterSteps(steps, "", "").length, steps.length, "no filter shows everything");
});

test("the legend names every outcome the kernel can report, once", () => {
  assert.deepEqual(FILTERS.map((f) => f.id), ["", "live", "shipped", "quiet", "rejected", "blocked", "crashed"]);
});

test("search matches who, why it woke, and its note, and combines with the outcome with AND", () => {
  const steps = [
    turn("shipped", "architect", 9_000, 1000, { reasonKind: "message" }),
    turn("shipped", "developer", 8_000, 1000, { reasonKind: "timer", reasonNote: "retry the merge" }),
    turn("quiet", "developer", 7_000, 1000, { reasonKind: "interest_event" }),
  ];
  assert.deepEqual(filterSteps(steps, "", "architect").map((s) => s.agentId), ["architect"]);
  assert.deepEqual(filterSteps(steps, "", "follow-up nudge").map((s) => s.agentId), ["developer"], "the plain reason, not the raw kind");
  assert.deepEqual(filterSteps(steps, "", "MERGE").length, 1, "the note, any case");
  assert.deepEqual(filterSteps(steps, "quiet", "developer").map((s) => s.reasonKind), ["interest_event"]);
  assert.equal(filterSteps(steps, "quiet", "architect").length, 0);
  assert.equal(filterSteps(steps, "", "  architect  ").length, 1, "surrounding spaces do not matter");
});

/* ------------------------------------------------------------------- folds */

const kinds = (rows: ReturnType<typeof foldQuiet>): string[] => rows.map((r) => (r.kind === "fold" ? `fold(${r.items.length})` : r.s.status === "running" ? "live" : r.s.ops?.messages ? "shipped" : "row"));

test("a run of quiet turns folds, a shorter run stays as rows, and anything that did something ends the run", () => {
  assert.equal(FOLD_AT, 3);
  const list = [
    turn("quiet", "a", 1), turn("quiet", "a", 2), turn("quiet", "a", 3), // fold(3)
    turn("shipped", "a", 4),
    turn("quiet", "a", 5), turn("quiet", "a", 6), // stays
  ];
  assert.deepEqual(kinds(foldQuiet(list, true)), ["fold(3)", "shipped", "row", "row"]);
});

test("folding never hides a turn that was refused, blocked, crashed or is still running", () => {
  const list = [
    turn("quiet", "a", 1), turn("rejected", "a", 2), turn("quiet", "a", 3), turn("blocked", "a", 4), turn("quiet", "a", 5),
    turn("crashed", "a", 6), turn("quiet", "a", 7), turn("live", "a", 8), turn("quiet", "a", 9),
  ];
  const rows = foldQuiet(list, true);
  assert.ok(rows.every((r) => r.kind === "step"), "four runs of one are not folds, so every turn is a row");
  assert.equal(rows.length, list.length);
  const folded = foldQuiet([...list, turn("quiet", "a", 10), turn("quiet", "a", 11)], true);
  const inFold = folded.flatMap((r) => (r.kind === "fold" ? r.items : []));
  assert.ok(inFold.every((s) => s.ops === NOTHING && s.status === "ok" && !s.opTimings), "only plain quiet turns are inside a fold");
});

test("with folding off every turn is a row, in order", () => {
  const list = [turn("quiet", "a", 1), turn("quiet", "a", 2), turn("quiet", "a", 3)];
  const rows = foldQuiet(list, false);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => (r.kind === "step" ? r.s.turnId : "")), list.map((s) => s.turnId));
});

test("a fold keeps every turn it folded, in the order given", () => {
  const list = [turn("quiet", "a", 1), turn("quiet", "b", 2), turn("quiet", "c", 3), turn("quiet", "d", 4)];
  const [row] = foldQuiet(list, true);
  assert.equal(row!.kind, "fold");
  assert.deepEqual(row!.kind === "fold" && row!.items.map((s) => s.agentId), ["a", "b", "c", "d"]);
});

/* ---------------------------------------------------------------- grouping */

test("turns are grouped by how long ago they began, newest group first, with what each group cost", () => {
  const list = [
    turn("shipped", "a", 60_000, 1000, { tokens: 500 }), turn("quiet", "a", 120_000, 1000, { tokens: 300 }),
    turn("shipped", "a", 10 * 60_000, 1000, { tokens: 200 }), turn("shipped", "a", 3 * 3_600_000, 1000, { tokens: 100 }),
  ];
  const groups = groupSteps(list, NOW, true, BUCKETS);
  assert.deepEqual(groups.map((g) => g.id), ["now", "recent", "day"], "empty buckets are not drawn");
  assert.deepEqual(groups.map((g) => g.tokens), [800, 200, 100]);
  assert.deepEqual(groups.map((g) => g.list.length), [2, 1, 1]);
});

/* ------------------------------------------------------------------- spend */

test("the headline is the mission's tokens when they are known, the loaded turns' when they are not", () => {
  const list = [turn("shipped", "a", 5, 1, { tokens: 1000 }), turn("quiet", "a", 6, 1, { tokens: 3000 })];
  assert.equal(spendOf(list, 250_000).tokens, 250_000);
  assert.equal(spendOf(list, null).tokens, 4000);
});

test("quiet and refused turns are the waste, and the share divides by the turns it counts", () => {
  const list = [
    turn("shipped", "a", 5, 1, { tokens: 1000 }), turn("quiet", "a", 6, 1, { tokens: 1000 }),
    turn("rejected", "a", 7, 1, { tokens: 1000 }), turn("crashed", "a", 8, 1, { tokens: 1000 }),
  ];
  const s = spendOf(list, null);
  assert.equal(s.loaded, 4000);
  assert.equal(s.wasted, 2000, "a crash is not waste; a quiet or refused turn is");
  assert.equal(s.wastedPct, 50);
  assert.equal(s.partial, false);
});

test("a mission total larger than the loaded turns marks the share as partial, and never makes it a share of the bigger total", () => {
  const list = [turn("quiet", "a", 5, 1, { tokens: 1000 }), turn("shipped", "a", 6, 1, { tokens: 1000 })];
  const s = spendOf(list, 9000);
  assert.equal(s.partial, true);
  assert.equal(s.wastedPct, 50, "still 1000 of the 2000 loaded");
  assert.equal(spendOf(list, 1500).partial, false, "a total no bigger than the loaded turns is not partial");
});

test("no turns, no waste, and no division by zero", () => {
  assert.deepEqual(spendOf([], null), { tokens: 0, loaded: 0, wasted: 0, wastedPct: 0, partial: false });
});

/* ------------------------------------------------------------------- pulse */

test("working agents are named by count, and a mission that is not running says why instead", () => {
  assert.equal(pulseLine(1, "running").title, "1 agent working");
  assert.equal(pulseLine(3, "running").title, "3 agents working");
  assert.equal(pulseLine(2, "paused").title, "2 agents working", "a live turn outranks the phase");
  assert.equal(pulseLine(0, "parked").detail, "The project is parked. Start the mission to run turns.");
  assert.equal(pulseLine(0, "paused").detail, "The mission is paused.");
  assert.equal(pulseLine(0, "needs-you").detail, "Decisions are waiting on you.");
});

test("a delivered or failed mission never claims its agents are parked on a mailbox", () => {
  for (const phase of ["done", "failed", "parked", "paused", "ceiling", "needs-you", "no-goal"]) {
    const p = pulseLine(0, phase);
    assert.equal(p.title, "Nothing is running", phase);
    assert.doesNotMatch(p.detail, /mailbox/i, phase);
  }
  assert.equal(pulseLine(0, "done").detail, "The mission is delivered.");
});

test("an unreachable server is not described as idle", () => {
  assert.equal(pulseLine(0, "offline").title, "Not reachable");
  assert.equal(pulseLine(0, "loading").title, "Connecting");
});

test("a turn marked live is not called working while the server is not answering", () => {
  const p = pulseLine(2, "offline");
  assert.equal(p.title, "Not reachable");
  assert.match(p.detail, /2 agents were mid-turn at its last report/);
  assert.match(pulseLine(1, "offline").detail, /1 agent was mid-turn/);
  assert.equal(pulseLine(2, "running").title, "2 agents working", "reachable, the same count is a live claim");
});

test("before the step history has arrived the strip claims nothing about what is running", () => {
  assert.equal(pulseLine(0, "running", false).title, "Loading turns");
  assert.equal(pulseLine(0, "parked", false).title, "Loading turns", "not 'nothing is running' about a list nobody has fetched");
  assert.equal(pulseLine(0, "offline", false).title, "Not reachable");
  assert.equal(pulseLine(0, "offline", false).detail, "The server is not answering.", "no 'last state it reported' when none was");
  assert.equal(pulseLine(0, "running", true).title, "No turn in flight", "loaded, it reads the phase as before");
});

/* ---------------------------------------------------------------- swimlanes */

test("the window is the smallest preset that holds about nine in ten turns", () => {
  const recent = Array.from({ length: 10 }, (_, i) => turn("shipped", "a", (i + 1) * 20_000));
  assert.equal(autoWindow(recent, NOW), "5m");
  const spread = [...Array.from({ length: 9 }, (_, i) => turn("shipped", "a", (i + 1) * 20_000)), turn("shipped", "a", 25 * 60_000)];
  assert.equal(autoWindow(spread, NOW), "5m", "nine of ten is enough");
  const wide = [...Array.from({ length: 8 }, (_, i) => turn("shipped", "a", (i + 1) * 20_000)), turn("shipped", "a", 25 * 60_000), turn("shipped", "a", 28 * 60_000)];
  assert.equal(autoWindow(wide, NOW), "30m");
  assert.equal(autoWindow([turn("shipped", "a", 20 * 3_600_000)], NOW), "all");
  assert.equal(autoWindow([], NOW), "all");
});

test("axis ticks count back from the right edge in whole steps and the last one says now", () => {
  const ticks = axisTicks(NOW - 30 * 60_000, NOW);
  assert.equal(ticks[ticks.length - 1]!.label, "now");
  assert.equal(ticks[ticks.length - 1]!.at, 100);
  assert.deepEqual(ticks.map((t) => t.label), ["-30m", "-25m", "-20m", "-15m", "-10m", "-5m", "now"]);
  for (let i = 1; i < ticks.length; i++) assert.ok(ticks[i]!.at > ticks[i - 1]!.at, "left to right");
  assert.ok(axisTicks(NOW - 12 * 3_600_000, NOW).length <= 8, "never a wall of labels");
});

test("every other tick is major, counting back from now, so a narrow axis can keep half and still end on now", () => {
  const ticks = axisTicks(NOW - 30 * 60_000, NOW);
  assert.deepEqual(ticks.map((t) => t.major), [true, false, true, false, true, false, true], "now, -10m, -20m, -30m");
  assert.equal(ticks[ticks.length - 1]!.major, true, "now is always kept");
  const five = axisTicks(NOW - 5 * 60_000, NOW);
  assert.deepEqual(five.map((t) => `${t.label}:${t.major}`), ["-5m:false", "-4m:true", "-3m:false", "-2m:true", "-1m:false", "now:true"]);
});

test("each agent has a lane, the busiest first, and a lane's share divides by the window it is drawn in", () => {
  const steps = [
    turn("shipped", "pm", 4 * 60_000, 60_000), turn("shipped", "qa", 3 * 60_000, 30_000), turn("shipped", "qa", 2 * 60_000, 30_000),
  ];
  const tl = timeline(steps, "5m", NOW)!;
  assert.deepEqual(tl.lanes.map((l) => l.agentId), ["pm", "qa"], "both were busy for 60s, so the tie is broken by name");
  assert.equal(tl.span, 5 * 60_000);
  const qa = tl.lanes.find((l) => l.agentId === "qa")!;
  const pm = tl.lanes.find((l) => l.agentId === "pm")!;
  assert.equal(pm.busyPct, 20, "60s of a 300s window");
  assert.equal(qa.busyPct, 20, "two turns of 30s");
  assert.equal(qa.bars.length, 2);
  assert.equal(qa.tokens, 2000);
});

test("a lane that ran for a few seconds is not called 0% busy", () => {
  const tl = timeline([turn("shipped", "pm", 60_000, 3_000)], "30m", NOW)!;
  const lane = tl.lanes[0]!;
  assert.equal(lane.busyPct, 0, "rounds to nothing");
  assert.equal(busyText(lane), "<1%");
  assert.equal(busyText({ busy: 0, busyPct: 0 }), "0%");
  assert.equal(busyText({ busy: 90_000, busyPct: 5 }), "5%");
  assert.equal(busyText({ busy: 1, busyPct: 1 }), "1%", "one percent is said as one percent");
});

test("lanes are ordered by busy time, ties by name", () => {
  const steps = [turn("shipped", "zed", 3 * 60_000, 60_000), turn("shipped", "amy", 4 * 60_000, 60_000), turn("shipped", "bob", 2 * 60_000, 90_000)];
  assert.deepEqual(timeline(steps, "5m", NOW)!.lanes.map((l) => l.agentId), ["bob", "amy", "zed"]);
});

test("a turn that began before the window is clipped at its edge, in the bar and in the sum", () => {
  const long = turn("shipped", "pm", 8 * 60_000, 6 * 60_000); // ends 2 minutes ago, started 8 ago: 3 of its minutes are inside a 5m window
  const tl = timeline([long], "5m", NOW)!;
  const bar = tl.lanes[0]!.bars[0]!;
  assert.equal(bar.clipped, true);
  assert.equal(bar.left, 0);
  assert.ok(Math.abs(bar.width - 60) < 0.01, `3 of 5 minutes is 60%: ${bar.width}`);
  assert.equal(tl.lanes[0]!.busyPct, 60);
});

test("turns older than the window are counted as hidden, not silently dropped", () => {
  const steps = [turn("shipped", "pm", 60_000, 1000), turn("shipped", "pm", 40 * 60_000, 1000), turn("shipped", "pm", 50 * 60_000, 1000)];
  const tl = timeline(steps, "5m", NOW)!;
  assert.equal(tl.hidden, 2);
  assert.equal(tl.lanes[0]!.bars.length, 1);
  assert.equal(timeline(steps, "all", NOW)!.hidden, 0);
});

test("a turn still running is drawn up to now, and a very short turn is still a bar you can see", () => {
  const live = turn("live", "pm", 90_000);
  const quick = turn("shipped", "qa", 30_000, 5);
  const tl = timeline([live, quick], "5m", NOW)!;
  const liveBar = tl.lanes.find((l) => l.agentId === "pm")!.bars[0]!;
  assert.ok(Math.abs(liveBar.left + liveBar.width - 100) < 0.01, "ends at the right edge");
  const quickBar = tl.lanes.find((l) => l.agentId === "qa")!.bars[0]!;
  assert.equal(quickBar.width, MIN_BAR_PCT);
});

test("no turns, no timeline; the preset windows end with the whole run", () => {
  assert.equal(timeline([], "5m", NOW), null);
  assert.equal(WINDOWS[WINDOWS.length - 1]!.id, "all");
  assert.equal(WINDOWS[WINDOWS.length - 1]!.ms, 0);
});

/* -------------------------------------------------------------------- rows */

test("a row says what the turn left behind only when that adds to its outcome label", () => {
  assert.equal(rowSummary(turn("quiet", "a", 5)), "", "No output already says it");
  assert.equal(rowSummary(turn("live", "a", 5)), "", "nothing to report yet");
  assert.equal(rowSummary(turn("shipped", "a", 5)), "1 message");
  assert.equal(rowSummary(turn("shipped", "a", 5, 1, { ops: { messages: 2, artifacts: 1, tasks: 0, decisions: 2 } })), "2 messages · 1 file · 2 decisions");
  assert.equal(rowSummary(turn("rejected", "a", 5)), "1 refused");
  assert.equal(rowSummary(turn("live", "a", 5, 1, { ops: { messages: 2, artifacts: 0, tasks: 0, decisions: 0 } })), "", "a running turn's results are not final, and the row shows what it is doing instead");
  assert.equal(rowSummary(turn("blocked", "a", 5)), "", "a blocked turn that landed nothing has nothing to add");
  assert.equal(
    rowSummary(turn("shipped", "a", 5, 1, { ops: { messages: 0, artifacts: 0, tasks: 0, decisions: 12 }, opTimings: [{ op: "x", ok: false }, { op: "y", ok: false }] })),
    "12 decisions · 2 refused",
    "a turn that landed some and was refused some says both",
  );
});

test("the swimlane's keys: Right and Left walk a lane only when asked to, Down and Up always do", () => {
  assert.equal(rovingTarget("ArrowRight", 1, 5, undefined, true), 2);
  assert.equal(rovingTarget("ArrowLeft", 1, 5, undefined, true), 0);
  assert.equal(rovingTarget("ArrowRight", 4, 5, undefined, true), 4, "stops at the end");
  assert.equal(rovingTarget("ArrowLeft", 0, 5, undefined, true), 0);
  assert.equal(rovingTarget("ArrowRight", 1, 5), null, "a column leaves Right to the page");
  assert.equal(rovingTarget("ArrowLeft", 1, 5), null);
  assert.equal(rovingTarget("ArrowDown", 1, 5, undefined, true), 2);
});
