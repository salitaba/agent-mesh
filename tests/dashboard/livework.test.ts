import test from "node:test";
import assert from "node:assert/strict";

import {
  LIVE_TOOLS_MAX,
  advisoryLine,
  ageText,
  clockHM,
  compactNow,
  currentToolOf,
  deadlineMemo,
  deadlineOf,
  deadlineText,
  hardStopText,
  liveWorkOf,
  mergeLiveTools,
  nowLine,
  shortTarget,
  timeLeftText,
  tokenText,
  toolTarget,
  type LiveToolCall,
} from "../../apps/mesh-dashboard/src/livework";
import { foldToolEvent, type ToolLive } from "../../apps/mesh-dashboard/src/streams";

/**
 * The incident these cover: a seat spent seventeen minutes making ~94 native
 * Write/Edit/Bash calls while every view read "thinking…", an elapsed timer
 * and "— tok", until the timeout killed it. The record carried what it was
 * doing; nothing read it.
 */

const NOW = 1_700_000_000_000;
const call = (id: string, over: Partial<LiveToolCall> = {}): LiveToolCall => ({
  id,
  name: "Edit",
  target: `src/${id}.ts`,
  status: "completed",
  startedAt: NOW - 10_000,
  endedAt: NOW - 9_000,
  ...over,
});

/* ----------------------------- current tool ---------------------------- */

test("the current tool is the newest call still running, not merely the newest", () => {
  const tools = [
    call("a"),
    call("b", { name: "Bash", target: "pnpm test", status: "running", endedAt: undefined }),
    call("c"),
  ];
  const cur = currentToolOf(tools);
  assert.equal(cur?.name, "Bash", "a long test run is what the seat is waiting on, even with a quick Edit after it");
  assert.equal(cur?.target, "pnpm test");
  assert.equal(cur?.status, "running");
});

test("with nothing running, the current tool is the newest call", () => {
  assert.equal(currentToolOf([call("a"), call("b"), call("c", { name: "Write" })])?.name, "Write");
  assert.equal(currentToolOf([]), undefined);
  assert.equal(currentToolOf(undefined), undefined);
});

/* ------------------------------ now line ------------------------------- */

test("the now line names the tool, its target and how long ago", () => {
  const edit = { name: "Edit", target: "packages/core/src/domain/model.ts", status: "completed" as const, startedAt: NOW - 6_000, endedAt: NOW - 4_000 };
  assert.equal(nowLine(edit, NOW), "Edit · packages/core/src/domain/model.ts · 4s ago", "a finished call is aged from its end");
  const bash = { name: "Bash", target: "pnpm test", status: "running" as const, startedAt: NOW - 40_000 };
  assert.equal(nowLine(bash, NOW), "Bash · pnpm test · running 40s", "a running call is aged from its start");
  const failed = { name: "Write", status: "failed" as const, startedAt: NOW - 3_000, endedAt: NOW - 2_000 };
  assert.equal(nowLine(failed, NOW), "Write · failed 2s ago", "no target, no empty slot");
});

test("an MCP tool is named without its server prefix", () => {
  assert.equal(nowLine({ name: "mcp__mesh__mesh_publish", status: "running", startedAt: NOW - 1_000 }, NOW), "mesh_publish · running 1s");
});

test("the list row's compact form keeps a path's file name", () => {
  const edit = { name: "Edit", target: "packages/core/src/domain/model.ts", status: "completed" as const, startedAt: NOW - 6_000, endedAt: NOW - 4_000 };
  assert.equal(compactNow(edit, NOW), "Edit model.ts · 4s");
  assert.equal(compactNow({ name: "Bash", target: "pnpm test --filter core", status: "running", startedAt: NOW - 40_000 }, NOW), "Bash pnpm test --filter core · running 40s");
  assert.equal(compactNow({ name: "Edit", target: "a/b.ts", status: "failed", startedAt: NOW - 2_000, endedAt: NOW - 1_000 }, NOW), "Edit b.ts · 1s · failed");
});

test("shortTarget clips a command by its head and a path to its last segment", () => {
  assert.equal(shortTarget("/abs/dir/file.tsx"), "file.tsx");
  assert.equal(shortTarget("C:\\repo\\src\\x.ts"), "x.ts");
  assert.equal(shortTarget("npm run build && npm test"), "npm run build && npm test", "a command with a slash-free space stays whole");
  assert.equal(shortTarget("git -C /repo status"), "git -C /repo status", "a command that mentions a path is still a command");
  assert.equal(shortTarget("https://example.com/a/b"), "https://example.com/a/b", "a URL is not a path");
  assert.equal(shortTarget("x".repeat(60)).length, 40);
  assert.equal(shortTarget("line one\nline two"), "line one");
  assert.equal(shortTarget(undefined), "");
});

test("ages are whole and coarse", () => {
  assert.equal(ageText(999), "0s");
  assert.equal(ageText(4_000), "4s");
  assert.equal(ageText(200_000), "3m 20s");
  assert.equal(ageText(600_000), "10m");
  assert.equal(ageText(25 * 60_000 + 7_000), "25m", "seconds stop mattering past ten minutes");
  assert.equal(ageText(65 * 60_000), "1h 5m");
  assert.equal(ageText(-5_000), "0s", "a clock-skewed future stamp is not a negative age");
});

/* ------------------------------ deadline ------------------------------- */

const stops = (over: Record<string, number | undefined> = {}) => ({
  startedAt: NOW - 20 * 60_000,
  llmCallAt: NOW - 19 * 60_000,
  deadlineAt: NOW + 10 * 60_000,
  ceilingAt: NOW + 40 * 60_000,
  ...over,
});

test("no deadline on the record means no bar, not a bar to nowhere", () => {
  assert.equal(deadlineOf(undefined, NOW), null);
  assert.equal(deadlineOf({ startedAt: NOW - 1_000 }, NOW), null, "the runtime is not called yet — the deadline is set at the call");
});

test("the bar runs from the runtime call to the later stop", () => {
  const d = deadlineOf(stops(), NOW)!;
  assert.equal(d.elapsedMs, 19 * 60_000, "measured from the runtime call, the deadline's own origin");
  assert.equal(d.leftMs, 10 * 60_000);
  assert.equal(d.hardLeftMs, 40 * 60_000);
  // span = 59 min: now at 19, deadline at 29, ceiling at 59.
  assert.ok(Math.abs(d.elapsedPct - (19 / 59) * 100) < 1e-9);
  assert.ok(Math.abs(d.deadlinePct - (29 / 59) * 100) < 1e-9);
  assert.equal(d.ceilingPct, 100);
  assert.equal(d.atCeiling, false);
  assert.equal(d.tone, "ok");
  assert.equal(deadlineText(d), "stops in 10m");
  assert.equal(hardStopText(d), "hard stop in 40 min");
});

test("a deadline that is also the hard stop says so once", () => {
  const d = deadlineOf(stops({ deadlineAt: NOW + 5 * 60_000, ceilingAt: NOW + 5 * 60_000 }), NOW)!;
  assert.equal(d.atCeiling, true);
  assert.equal(deadlineText(d), "hard stop in 5m");
  assert.equal(hardStopText(d), null, "no second line repeating the same stop");
});

test("the tone warns before the soft stop and goes red near the hard one", () => {
  assert.equal(deadlineOf(stops({ deadlineAt: NOW + 45_000 }), NOW)!.tone, "warn", "may stop within a minute unless it keeps producing");
  assert.equal(deadlineOf(stops({ deadlineAt: NOW + 3 * 60_000, ceilingAt: NOW + 3 * 60_000 }), NOW)!.tone, "warn", "the hard stop is minutes away");
  assert.equal(deadlineOf(stops({ deadlineAt: NOW + 30_000, ceilingAt: NOW + 30_000 }), NOW)!.tone, "bad");
  const late = deadlineOf(stops({ deadlineAt: NOW - 12_000 }), NOW)!;
  assert.equal(late.overdue, true);
  assert.equal(late.tone, "bad");
  assert.equal(deadlineText(late), "past its deadline by 12s");
  assert.equal(hardStopText(deadlineOf(stops({ deadlineAt: NOW + 5_000, ceilingAt: NOW + 20_000 }), NOW)!), "hard stop in 20s");
});

test("'extended' is claimed only for a move this page saw", () => {
  const first = NOW + 60_000;
  assert.equal(deadlineOf(stops({ deadlineAt: first }), NOW, first)!.extended, false);
  assert.equal(deadlineOf(stops({ deadlineAt: first + 500 }), NOW, first)!.extended, false, "sub-second movement is clock noise");
  assert.equal(deadlineOf(stops({ deadlineAt: first + 120_000 }), NOW, first)!.extended, true);
  assert.equal(deadlineOf(stops({ deadlineAt: first + 120_000 }), NOW)!.extended, false, "no first value seen: say nothing rather than guess at the base timeout");
});

test("the deadline memo keeps the first value per turn, bounded", () => {
  const memo = deadlineMemo(2);
  assert.equal(memo("t1", undefined), undefined, "nothing to remember before the runtime call");
  assert.equal(memo("t1", 100), 100);
  assert.equal(memo("t1", 900), 100, "a later, extended value does not replace the first");
  memo("t2", 5);
  memo("t3", 7);
  assert.equal(memo("t1", 900), 900, "the oldest entry fell out of a full memo");
});

test("a list row says how long is left", () => {
  assert.equal(timeLeftText(NOW + 4 * 60_000, NOW), "4m left");
  assert.equal(timeLeftText(NOW - 1, NOW), "overdue");
  assert.equal(timeLeftText(undefined, NOW), null);
});

/* ---------------------------- tokens, notes ---------------------------- */

test("tokens so far replace the dash while running, and never invent a zero", () => {
  const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  assert.equal(tokenText(undefined, 48_200, fmt), "48.2k tok so far");
  assert.equal(tokenText(52_000, 48_200, fmt), "52.0k tok", "the final figure wins once there is one");
  assert.equal(tokenText(0, undefined, fmt), "0 tok", "a reported zero is a figure");
  assert.equal(tokenText(undefined, undefined, fmt), "— tok", "absent is unknown, not zero");
  assert.equal(tokenText(null, undefined, fmt), "— tok");
});

test("an advisory reads as a local-time warning", () => {
  const at = new Date(2026, 8, 26, 20, 3, 40).getTime();
  assert.equal(clockHM(at), "20:03");
  assert.equal(advisoryLine({ at, text: "about 2 minutes left — commit what you have", delivered: true }), "⏱ warned at 20:03 — about 2 minutes left — commit what you have");
});

/* ------------------------------ record shape ---------------------------- */

test("liveWorkOf reads the record's fields and drops what it cannot trust", () => {
  const w = liveWorkOf({
    toolCallCount: 94,
    liveTools: [call("a"), { id: "b" }, null, call("c", { status: "weird" as never })],
    filesTouched: ["a.ts", 3, ""],
    liveTokens: 48_000,
    advisories: [{ at: NOW, text: "hurry", delivered: false }, { at: NOW, text: "ok" }, { text: "no time" }],
    checkpoint: { ref: "refs/mesh/checkpoints/backend/turn-1", commit: "abc", files: ["a.ts", 7] },
  });
  assert.equal(w.toolCallCount, 94);
  assert.deepEqual(w.liveTools.map((t) => t.id), ["a"]);
  assert.deepEqual(w.filesTouched, ["a.ts"]);
  assert.equal(w.liveTokens, 48_000);
  assert.deepEqual(w.advisories.map((a) => a.delivered), [false, true], "delivered defaults to true only when unstated");
  assert.deepEqual(w.checkpoint, { ref: "refs/mesh/checkpoints/backend/turn-1", commit: "abc", files: ["a.ts"] });
});

test("an older record yields empty live work, not undefined fields to crash on", () => {
  const w = liveWorkOf({ turnId: "turn-1", toolFrames: 188 });
  assert.equal(w.toolCallCount, undefined);
  assert.deepEqual(w.liveTools, []);
  assert.deepEqual(w.filesTouched, []);
  assert.deepEqual(w.advisories, []);
  assert.equal(w.checkpoint, undefined);
  assert.deepEqual(liveWorkOf(null).liveTools, []);
});

/* ------------------------------ SSE merge ------------------------------- */

const sse = (id: string, over: Partial<ToolLive> = {}): ToolLive => ({
  toolCallId: id,
  name: "Edit",
  argsPreview: "{}",
  target: `src/${id}.ts`,
  status: "completed",
  startedAt: NOW - 1_000,
  updatedAt: NOW - 500,
  ...over,
});

test("the stream adds the calls announced since the last poll", () => {
  const merged = mergeLiveTools([call("a"), call("b")], [sse("a"), sse("b"), sse("c", { status: "running" })]);
  assert.deepEqual(merged.map((t) => t.id), ["a", "b", "c"]);
  const c = merged[2]!;
  assert.equal(c.status, "running");
  assert.equal(c.endedAt, undefined);
  assert.equal(c.target, "src/c.ts");
});

test("a call the poll caught running takes the finish the stream saw", () => {
  const merged = mergeLiveTools(
    [call("a", { status: "running", endedAt: undefined })],
    [sse("a", { status: "failed", error: "permission denied", updatedAt: NOW - 200 })],
  );
  assert.equal(merged[0]!.status, "failed");
  assert.equal(merged[0]!.error, "permission denied");
  assert.equal(merged[0]!.endedAt, NOW - 200);
});

test("the polled record stays the authority on a call both know", () => {
  // The poll already has it finished; a stale "running" from the stream must
  // not downgrade it, and the record's own target wins.
  const merged = mergeLiveTools([call("a", { target: "server/target.ts" })], [sse("a", { status: "running", target: "client-guess" })]);
  assert.equal(merged[0]!.status, "completed");
  assert.equal(merged[0]!.target, "server/target.ts");
});

test("a stream call the poll dropped off its window is not put back out of order", () => {
  // "old" fell off the poll's capped window; re-adding it would land it after
  // "b" as if it were the newest thing the seat did.
  const merged = mergeLiveTools([call("a"), call("b")], [sse("old"), sse("a"), sse("b")]);
  assert.deepEqual(merged.map((t) => t.id), ["a", "b"]);
});

test("with no call in common, every stream call is newer than the snapshot", () => {
  assert.deepEqual(mergeLiveTools([call("a")], [sse("x"), sse("y")]).map((t) => t.id), ["a", "x", "y"]);
  assert.deepEqual(mergeLiveTools(undefined, [sse("x")]).map((t) => t.id), ["x"], "before the first poll lands, the stream is all there is");
  assert.deepEqual(mergeLiveTools([call("a")], undefined).map((t) => t.id), ["a"]);
});

test("a merged list is capped like the record", () => {
  const polled = Array.from({ length: LIVE_TOOLS_MAX }, (_, i) => call(`p${i}`));
  const merged = mergeLiveTools(polled, [sse(`p${LIVE_TOOLS_MAX - 1}`), sse("new1"), sse("new2")]);
  assert.equal(merged.length, LIVE_TOOLS_MAX);
  assert.equal(merged[merged.length - 1]!.id, "new2");
  assert.equal(merged[0]!.id, "p2", "the oldest go, as on the server");
});

test("the stream fold keeps each call's target and a failure's error", () => {
  const opened = foldToolEvent(undefined, { kind: "tool_call", toolCallId: "c1", name: "Write", args: { file_path: "src/big.ts", content: "x".repeat(50_000) } }, NOW)!;
  assert.equal(opened[0]!.target, "src/big.ts", "taken from the raw args, before the preview clips them mid-JSON");
  const failed = foldToolEvent(opened, { kind: "tool_call_update", toolCallId: "c1", status: "failed", error: "denied by gate" }, NOW + 1)!;
  assert.equal(failed[0]!.error, "denied by gate");
  const redone = foldToolEvent(failed, { kind: "tool_call_update", toolCallId: "c1", status: "completed" }, NOW + 2)!;
  assert.equal(redone[0]!.error, undefined, "an error belongs to a failure only");
});

test("toolTarget picks the argument a reader looks at", () => {
  assert.equal(toolTarget({ file_path: "a/b.ts", content: "…" }), "a/b.ts");
  assert.equal(toolTarget({ command: "pnpm test\n# second line", description: "run tests" }), "pnpm test");
  assert.equal(toolTarget({ pattern: "TODO" }), "TODO");
  assert.equal(toolTarget('{"path":"x/y"}'), "x/y", "a JSON string is parsed");
  assert.equal(toolTarget("not json at all"), "not json at all");
  assert.equal(toolTarget({ unrelated: 1 }), undefined);
  assert.equal(toolTarget(undefined), undefined);
  assert.equal(toolTarget({ command: "y".repeat(500) })!.length, 200);
});
