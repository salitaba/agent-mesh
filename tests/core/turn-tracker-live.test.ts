import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TurnTracker,
  MAX_LIVE_TOOLS,
  MAX_FILES_TOUCHED,
  LIVE_TOOL_TARGET_MAX,
  abnormalTurnNote,
  liveToolTarget,
  newTurnEffectTally,
} from "../../packages/core/src/turn-tracker";

/**
 * The live account of a turn that writes files instead of prose.
 *
 * A live backend turn made ~94 native Write/Edit/Bash calls over 17 minutes,
 * wrote 37 files and was killed at the timeout. Its record said `toolFrames:
 * 188` — frames, not calls, so every reader doubled it — and nothing else: no
 * call names, no files, no spend. When it died the finished-turn trace was never
 * built (it comes from an `AgentOutput` a killed turn never returns), so the
 * files it wrote were on no record at all, and its successor was told to "read
 * the log" for effects the log does not hold.
 */

function running(turnId = "turn-live"): TurnTracker {
  const tracker = new TurnTracker();
  tracker.push({ turnId, agentId: "backend", reason: { kind: "manual" }, startedAt: new Date(1000).toISOString(), status: "running" } as never);
  return tracker;
}

function call(tracker: TurnTracker, id: string, name: string, args: unknown, at: number, root?: string): void {
  tracker.noteToolFrame("turn-live", { id, closed: false, name, args, ...(root ? { root } : {}) }, at);
}

function done(tracker: TurnTracker, id: string, at: number, status: "completed" | "failed" = "completed", error?: string): void {
  tracker.noteToolFrame("turn-live", { id, closed: true, status, ...(error ? { error } : {}) }, at);
}

test("toolCallCount counts calls; toolFrames keeps counting frames", () => {
  const tracker = running();
  call(tracker, "a", "Write", { file_path: "src/a.ts", content: "x" }, 2000);
  done(tracker, "a", 2100);
  call(tracker, "b", "Bash", { command: "npm test" }, 2200);
  done(tracker, "b", 2300);
  // An old-style frame with no call attached is activity, not a call.
  tracker.noteToolFrame("turn-live", undefined, 2400);
  const rec = tracker.get("turn-live")!;
  assert.equal(rec.toolFrames, 5, "every frame is a frame");
  assert.equal(rec.toolCallCount, 2, "but a call is counted once, on its tool_call");
  assert.equal(rec.phases?.lastActivityAt, 2400, "and liveness is stamped exactly as before");
});

test("liveTools: newest MAX_LIVE_TOOLS in order, each closed by id with its status and error", () => {
  const tracker = running();
  for (let i = 0; i < MAX_LIVE_TOOLS + 5; i++) call(tracker, `c${i}`, "Read", { file_path: `/w/f${i}.ts` }, 2000 + i);
  // Close out of order: correlation is by id, never by arrival.
  done(tracker, `c${MAX_LIVE_TOOLS + 4}`, 3000, "failed", "permission denied: Bash is not granted to this seat");
  done(tracker, `c${MAX_LIVE_TOOLS + 3}`, 3001);
  const rec = tracker.get("turn-live")!;
  const ring = rec.liveTools!;
  assert.equal(ring.length, MAX_LIVE_TOOLS, "the ring is capped");
  assert.equal(ring[0]!.id, "c5", "the oldest calls fall off the front");
  assert.equal(ring.at(-1)!.id, `c${MAX_LIVE_TOOLS + 4}`, "the newest stays last");
  assert.equal(rec.toolCallCount, MAX_LIVE_TOOLS + 5, "the count is not capped with the ring");
  const failed = ring.at(-1)!;
  assert.equal(failed.status, "failed");
  assert.equal(failed.endedAt, 3000);
  assert.match(failed.error ?? "", /permission denied/);
  assert.equal(ring.at(-2)!.status, "completed");
  assert.equal(ring.at(-3)!.status, "running", "a call whose update never came is still running");
  assert.equal(ring.at(-3)!.endedAt, undefined);
});

test("liveTools: a call announced twice is one call", () => {
  const tracker = running();
  call(tracker, "x", "Edit", { file_path: "a.ts" }, 2000);
  call(tracker, "x", "Edit", { file_path: "b.ts" }, 2001);
  const rec = tracker.get("turn-live")!;
  assert.equal(rec.toolCallCount, 1);
  assert.equal(rec.liveTools!.length, 1);
  assert.equal(rec.liveTools![0]!.target, "b.ts", "the refinement replaced the target");
});

test("liveToolTarget: the salient argument, clipped", () => {
  assert.equal(liveToolTarget("Write", { file_path: "/ws/worktrees/backend/src/app.ts", content: "…" }, "/ws/worktrees/backend"), "src/app.ts");
  assert.equal(liveToolTarget("NotebookEdit", { notebook_path: "nb.ipynb" }), "nb.ipynb");
  assert.equal(liveToolTarget("Bash", { command: "npm   test\n  -- --watch" }), "npm test -- --watch", "whitespace collapsed to one line");
  assert.equal(liveToolTarget("Grep", { pattern: "TODO", path: "src" }), "TODO", "a search is named by what it looks for");
  assert.equal(liveToolTarget("WebFetch", { url: "https://example.com/x" }), "https://example.com/x");
  assert.equal(liveToolTarget("WebSearch", { query: "node test runner" }), "node test runner");
  const long = liveToolTarget("Bash", { command: "x".repeat(1000) })!;
  assert.equal(long.length, LIVE_TOOL_TARGET_MAX, "a command line is clipped, never shipped whole");
  assert.ok(long.endsWith("…"));
  assert.equal(liveToolTarget("mcp__mesh__mesh_task_claim", { taskId: "task-9" }), "task-9", "a mesh op is named by what it acts on");
  assert.equal(liveToolTarget("mcp__mesh__mesh_send", { type: "REQUEST", to: ["tech-lead"], payload: {} }), "REQUEST → tech-lead");
  assert.equal(liveToolTarget("mcp__mesh__mesh_artifact_publish", { name: "Store", type: "CodePatch", fromPath: "src/store.ts" }), "Store");
  assert.equal(liveToolTarget("mcp__mesh__mesh_done", { summary: "wrote the store" }), "wrote the store");
  assert.equal(liveToolTarget("Read", null), undefined, "nothing to show is not an error");
});

test("filesTouched: Write/Edit/MultiEdit/NotebookEdit paths, deduped, relative to the seat's root, capped", () => {
  const tracker = running();
  const root = "/ws/worktrees/backend";
  call(tracker, "1", "Write", { file_path: `${root}/src/a.ts` }, 2000, root);
  call(tracker, "2", "Edit", { file_path: `${root}/src/a.ts` }, 2001, root);
  call(tracker, "3", "MultiEdit", { file_path: `${root}/src/b.ts` }, 2002, root);
  call(tracker, "4", "NotebookEdit", { notebook_path: `${root}/nb.ipynb` }, 2003, root);
  call(tracker, "5", "Read", { file_path: `${root}/src/c.ts` }, 2004, root);
  call(tracker, "6", "Bash", { command: "echo x > d.ts" }, 2005, root);
  call(tracker, "7", "Write", { file_path: "/elsewhere/e.ts" }, 2006, root);
  assert.deepEqual(tracker.get("turn-live")!.filesTouched, ["src/a.ts", "src/b.ts", "nb.ipynb", "/elsewhere/e.ts"]);

  for (let i = 0; i < MAX_FILES_TOUCHED + 10; i++) call(tracker, `w${i}`, "Write", { file_path: `gen/${i}.ts` }, 3000 + i);
  assert.equal(tracker.get("turn-live")!.filesTouched!.length, MAX_FILES_TOUCHED, "bounded: the record is persisted every 1.2 s");
});

test("liveTokens: the latest cumulative figure; nonsense is ignored", () => {
  const tracker = running();
  tracker.noteUsage("turn-live", 1200);
  tracker.noteUsage("turn-live", 45_000);
  tracker.noteUsage("turn-live", Number.NaN);
  tracker.noteUsage("turn-live", -5);
  assert.equal(tracker.get("turn-live")!.liveTokens, 45_000);
});

test("deadline: set and moved, never past the ceiling; advisories recorded in order", () => {
  const tracker = running();
  tracker.setDeadline("turn-live", 5000, 9000);
  assert.deepEqual([tracker.get("turn-live")!.phases?.deadlineAt, tracker.get("turn-live")!.phases?.ceilingAt], [5000, 9000]);
  tracker.setDeadline("turn-live", 12_000, 9000);
  assert.equal(tracker.get("turn-live")!.phases?.deadlineAt, 9000, "an extension cannot promise more than the ceiling");
  tracker.noteAdvisory("turn-live", { at: 4000, text: "⏱ budget", delivered: true });
  tracker.noteAdvisory("turn-live", { at: 8000, text: "⚠ final", delivered: false });
  assert.deepEqual(tracker.get("turn-live")!.advisories!.map((a) => [a.text, a.delivered]), [["⏱ budget", true], ["⚠ final", false]]);
});

test("a failed turn keeps its live account: tools, files, spend, advisories, checkpoint", () => {
  const tracker = running();
  call(tracker, "w", "Write", { file_path: "src/store.ts" }, 2000);
  tracker.noteUsage("turn-live", 249_918);
  tracker.noteAdvisory("turn-live", { at: 3000, text: "⏱", delivered: true });
  tracker.setCheckpoint("turn-live", { ref: "refs/mesh/checkpoints/backend/turn-live", commit: "c0ffee", files: ["src/store.ts"] });
  // The shape the supervisor's failure path writes: no ops, no toolCalls.
  tracker.finish("turn-live", "backend", { status: "failed", error: "turn timeout after 1200000ms" }, new Date(5000).toISOString());
  const rec = tracker.get("turn-live")!;
  assert.equal(rec.status, "failed");
  assert.equal(rec.liveTools?.[0]?.target, "src/store.ts");
  assert.deepEqual(rec.filesTouched, ["src/store.ts"]);
  assert.equal(rec.liveTokens, 249_918, "the only spend figure a killed turn may have");
  assert.equal(rec.advisories?.length, 1);
  assert.equal(rec.checkpoint?.ref, "refs/mesh/checkpoints/backend/turn-live");
  // And nothing more lands once it is closed.
  call(tracker, "late", "Write", { file_path: "late.ts" }, 6000);
  tracker.noteUsage("turn-live", 1);
  assert.deepEqual(tracker.get("turn-live")!.filesTouched, ["src/store.ts"]);
  assert.equal(tracker.get("turn-live")!.liveTokens, 249_918);
});

test("the unfinished-turn note names the snapshot, and falls back to filesTouched without a worktree listing", () => {
  const discard = { reason: "timeout", detail: "turn timeout after 1200000ms", tokens: 249_918 };
  const withWorktree = abnormalTurnNote(discard, 1_200_000, {
    landed: newTurnEffectTally(),
    uncommitted: { files: ["src/a.ts", "src/b.ts"], untracked: 2 },
    canCommit: true,
    checkpoint: { ref: "refs/mesh/checkpoints/backend/turn-1", commit: "0123456789abcdef" },
    filesTouched: ["src/a.ts", "src/b.ts", "src/c.ts"],
  });
  assert.match(withWorktree, /still in your worktree/);
  assert.match(withWorktree, /refs\/mesh\/checkpoints\/backend\/turn-1/, "the snapshot is named so the seat can recover from it");
  assert.match(withWorktree, /0123456789ab/);
  assert.doesNotMatch(withWorktree, /src\/c\.ts/, "the worktree listing is the truth when there is one");

  const noListing = abnormalTurnNote(discard, 1_200_000, { landed: newTurnEffectTally(), canCommit: false, filesTouched: ["src/a.ts", "src/b.ts"] });
  assert.match(noListing, /wrote or edited 2 file\(s\): src\/a\.ts, src\/b\.ts/);
  assert.match(noListing, /continue from them rather than writing them again/);
  assert.doesNotMatch(noListing, /Nothing it did reached/, "a turn that wrote files did not leave nothing behind");
});

test("a budget stop is named as one, whatever the abort classified as", () => {
  const note = abnormalTurnNote({ reason: "silence", detail: "turn budget exceeded: 12000 live against 10000 left", tokens: 12_000 }, 60_000);
  assert.match(note, /live spend passed what your budget had left/);
  assert.doesNotMatch(note, /went silent/);
});

test("a turn classified as a budget stop is named as one without reading its detail", () => {
  // The supervisor's own classification carries it now (`budget`), so the seat's
  // note no longer depends on the detail prose being the sentence the old
  // classifier looked for. This detail is deliberately NOT that sentence: a note
  // that only reads right when the prose matches is how a budget stop came to be
  // described to the seat as a stream that went quiet.
  const note = abnormalTurnNote({ reason: "budget", detail: "aborted by the mesh", tokens: 12_000 }, 60_000);
  assert.match(note, /live spend passed what your budget had left/);
  assert.doesNotMatch(note, /went silent/);
  assert.doesNotMatch(note, /lost to a backend failure/);
});

test("a turn stopped by the mesh shutting down is not blamed on the operator", () => {
  // `interrupted` is shared by the operator's stop and the mesh's own shutdown
  // (`closeShutdownStoppedTurn`); only the detail tells them apart. Telling a seat
  // the operator stopped it after a restart sends it looking for an instruction
  // that was never given.
  const shutdown = abnormalTurnNote({ reason: "interrupted", detail: "stopped by the mesh shutting down (claude:abc — session torn down)" }, 30_000);
  assert.match(shutdown, /stopped when the mesh restarted/);
  assert.doesNotMatch(shutdown, /stopped by the operator/);
  const operator = abnormalTurnNote({ reason: "interrupted", detail: "stopped by the operator: wrong branch" }, 30_000);
  assert.match(operator, /stopped by the operator/);
  assert.doesNotMatch(operator, /mesh restarted/);
});
