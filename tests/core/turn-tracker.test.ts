import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describeError,
  MAX_ERROR_CHARS,
  MAX_ERROR_FRAMES,
  MAX_LIVE_TEXT_CHARS,
  MAX_OP_TIMINGS,
  RECENT_TURNS_MAX,
  TurnTracker,
  type TurnRecord,
  type TurnTrackerPersist,
} from "../../packages/core/src/turn-tracker";

/**
 * The turn ring is the ONLY home of per-turn rich data — phases, opTimings,
 * streamed text, structured errors — so its merge rules are load-bearing:
 * a later push that omits `phases` must not erase the marks recorded so far,
 * and every accumulator must be bounded or a runaway stream grows memory
 * without limit.
 *
 * `describeError` runs on the failure path, where the thrown value may be a
 * string, may have no stack, or may have getters that throw. It must never
 * throw itself, or the original failure is lost.
 */

let seq = 0;
function turn(over: Partial<TurnRecord> = {}): TurnRecord {
  seq++;
  return {
    turnId: over.turnId ?? `turn-${seq}`,
    agentId: over.agentId ?? "agent-a",
    reason: over.reason ?? { kind: "message", note: "asked" },
    startedAt: over.startedAt ?? `2026-03-01T00:00:${String(seq % 60).padStart(2, "0")}.000Z`,
    status: over.status ?? "running",
    ...over,
  } as TurnRecord;
}

function recordingPersist(prior: TurnRecord[] = []): TurnTrackerPersist & { saves: TurnRecord[][] } {
  const saves: TurnRecord[][] = [];
  return {
    saves,
    load: () => prior,
    save: (records) => {
      saves.push(records);
    },
  };
}

// --- describeError: non-Error throws ---

test("a thrown string is described by its typeof, not as an Error", () => {
  const d = describeError("plain failure", "prep");
  assert.equal(d.kind, "string");
  assert.equal(d.message, "plain failure");
  assert.equal(d.phase, "prep");
  assert.equal(d.frames, undefined);
});

test("a thrown undefined still yields a printable description", () => {
  const d = describeError(undefined);
  assert.equal(d.kind, "undefined");
  assert.equal(d.message, "undefined");
  assert.equal(d.phase, undefined);
});

test("a thrown object is stringified and truncated to the message cap", () => {
  const d = describeError({ toString: () => "x".repeat(MAX_ERROR_CHARS + 500) });
  assert.equal(d.kind, "object");
  assert.equal(d.message.length, MAX_ERROR_CHARS);
});

// --- describeError: Error instances ---

test("an Error is described by its constructor name rather than typeof", () => {
  const d = describeError(new TypeError("bad type"), "llmCallAt");
  assert.equal(d.kind, "TypeError");
  assert.equal(d.message, "bad type");
  assert.equal(d.phase, "llmCallAt");
});

test("stack frames are trimmed to the 'at ' lines and capped", () => {
  const err = new Error("deep");
  err.stack = ["Error: deep", ...Array.from({ length: MAX_ERROR_FRAMES + 8 }, (_, i) => `    at frame${i} (f.js:${i}:1)`)].join("\n");

  const d = describeError(err);

  assert.equal(d.frames?.length, MAX_ERROR_FRAMES);
  assert.equal(d.frames?.[0], "at frame0 (f.js:0:1)");
});

test("a stack whose lines are all non-frame text yields no frames field at all", () => {
  const err = new Error("no frames");
  err.stack = "Error: no frames\nsome prose that is not a frame";

  const d = describeError(err);

  assert.equal(d.frames, undefined, "an empty frame list is omitted, not stored");
});

test("an error with no stack at all is described without frames", () => {
  const err = new Error("stackless");
  (err as { stack?: string }).stack = undefined;

  const d = describeError(err);

  assert.equal(d.frames, undefined);
  assert.equal(d.message, "stackless");
});

// --- describeError: cause chains ---

test("an error with no cause omits the causes field", () => {
  const d = describeError(new Error("lonely"));
  assert.equal(d.causes, undefined);
});

test("a wrapped error flattens its cause chain outward-in", () => {
  const root = new TypeError("root cause");
  const mid = new Error("middle", { cause: root });
  const top = new RangeError("top", { cause: mid });

  const d = describeError(top);

  assert.equal(d.kind, "RangeError");
  assert.deepEqual(d.causes?.map((c) => c.kind), ["Error", "TypeError"]);
  assert.deepEqual(d.causes?.map((c) => c.message), ["middle", "root cause"]);
});

test("a self-referential cause chain terminates instead of hanging", () => {
  const err = new Error("loop") as Error & { cause?: unknown };
  err.cause = err;

  const d = describeError(err);

  assert.equal(d.causes?.length, 4, "the cause walk is bounded at four hops");
});

test("a non-Error cause is described by its typeof and stringified value", () => {
  const err = new Error("wrapper", { cause: "string cause" });

  const d = describeError(err);

  assert.equal(d.causes?.[0]?.kind, "String");
  assert.equal(d.causes?.[0]?.message, "string cause");
});

test("a cause whose message is enormous is truncated to 300 chars", () => {
  const err = new Error("wrapper", { cause: new Error("y".repeat(900)) });

  const d = describeError(err);

  assert.equal(d.causes?.[0]?.message.length, 300);
});

test("an error whose getters throw degrades to 'unprintable error' instead of rethrowing", () => {
  const hostile = new Error("hostile");
  Object.defineProperty(hostile, "stack", {
    get() {
      throw new Error("getter exploded");
    },
  });

  const d = describeError(hostile, "opsStartAt");

  assert.equal(d.kind, "Error");
  assert.equal(d.message, "unprintable error");
  assert.equal(d.phase, "opsStartAt", "the phase survives the degraded path");
});

// --- ring: push and merge ---

test("pushing a new turn puts it at the head of the ring", () => {
  const tracker = new TurnTracker();
  tracker.push(turn({ turnId: "t1" }));
  tracker.push(turn({ turnId: "t2" }));

  assert.deepEqual(tracker.list().map((t) => t.turnId), ["t2", "t1"]);
});

test("pushing an existing turnId merges in place rather than adding a second entry", () => {
  const tracker = new TurnTracker();
  tracker.push(turn({ turnId: "t1", status: "running" }));
  tracker.push(turn({ turnId: "t1", status: "ok", tokens: 42 }));

  assert.equal(tracker.list().length, 1);
  assert.equal(tracker.get("t1")?.status, "ok");
  assert.equal(tracker.get("t1")?.tokens, 42);
});

test("a merge that omits phases keeps the marks already recorded", () => {
  const tracker = new TurnTracker();
  tracker.push(turn({ turnId: "t1", phases: { startedAt: 1000, llmCallAt: 1100 } }));
  tracker.push(turn({ turnId: "t1", status: "ok" }));

  assert.deepEqual(tracker.get("t1")?.phases, { startedAt: 1000, llmCallAt: 1100 });
});

test("a merge that carries phases unions them with the existing marks", () => {
  const tracker = new TurnTracker();
  tracker.push(turn({ turnId: "t1", phases: { startedAt: 1000, llmCallAt: 1100 } }));
  tracker.push(turn({ turnId: "t1", phases: { startedAt: 1000, llmDoneAt: 1500 } }));

  assert.deepEqual(tracker.get("t1")?.phases, { startedAt: 1000, llmCallAt: 1100, llmDoneAt: 1500 });
});

test("the ring drops the oldest turn once it exceeds its cap", () => {
  const tracker = new TurnTracker();
  for (let i = 0; i < RECENT_TURNS_MAX + 5; i++) tracker.push(turn({ turnId: `t${i}` }));

  const all = tracker.list(RECENT_TURNS_MAX + 50);
  assert.equal(all.length, RECENT_TURNS_MAX);
  assert.equal(all[0]?.turnId, `t${RECENT_TURNS_MAX + 4}`, "newest survives");
  assert.equal(tracker.get("t0"), undefined, "oldest was evicted");
});

test("list defaults to a smaller window than the ring holds", () => {
  const tracker = new TurnTracker();
  for (let i = 0; i < 80; i++) tracker.push(turn({ turnId: `t${i}` }));

  assert.equal(tracker.list().length, 60);
  assert.equal(tracker.list(5).length, 5);
});

// --- ring: op timings ---

test("noteOp on an unknown turn is ignored rather than creating one", () => {
  const tracker = new TurnTracker();
  tracker.noteOp("ghost", { op: "send_message", ms: 3, ok: true });

  assert.equal(tracker.list().length, 0);
});

test("op timings accumulate in execution order on the running turn", () => {
  const tracker = new TurnTracker();
  tracker.push(turn({ turnId: "t1" }));
  tracker.noteOp("t1", { op: "send_message", ms: 3, ok: true });
  tracker.noteOp("t1", { op: "commit", ms: 90, ok: false, reason: "no lease" });

  assert.deepEqual(tracker.get("t1")?.opTimings?.map((o) => o.op), ["send_message", "commit"]);
  assert.equal(tracker.get("t1")?.opTimings?.[1]?.reason, "no lease");
});

test("op timings stop being recorded once a runaway turn hits the cap", () => {
  const tracker = new TurnTracker();
  tracker.push(turn({ turnId: "t1" }));
  for (let i = 0; i < MAX_OP_TIMINGS + 10; i++) tracker.noteOp("t1", { op: `op${i}`, ms: 1, ok: true });

  assert.equal(tracker.get("t1")?.opTimings?.length, MAX_OP_TIMINGS);
});

// --- ring: phase marks ---

test("mark on an unknown turn is a no-op", () => {
  const tracker = new TurnTracker();
  tracker.mark("ghost", "llmCallAt", 5);

  assert.equal(tracker.list().length, 0);
});

test("the first mark seeds startedAt from the record's ISO timestamp", () => {
  const tracker = new TurnTracker();
  tracker.push(turn({ turnId: "t1", startedAt: "2026-03-01T00:00:10.000Z" }));
  tracker.mark("t1", "llmCallAt", 9999);

  assert.equal(tracker.get("t1")?.phases?.startedAt, Date.parse("2026-03-01T00:00:10.000Z"));
  assert.equal(tracker.get("t1")?.phases?.llmCallAt, 9999);
});

test("an unparseable startedAt falls back to the mark's own time", () => {
  const tracker = new TurnTracker();
  tracker.push(turn({ turnId: "t1", startedAt: "not-a-date" }));
  tracker.mark("t1", "llmCallAt", 4242);

  assert.equal(tracker.get("t1")?.phases?.startedAt, 4242);
});

test("firstTokenAt is never moved by a later mark, so the TTFT baseline is stable", () => {
  const tracker = new TurnTracker();
  tracker.push(turn({ turnId: "t1" }));
  tracker.mark("t1", "firstTokenAt", 100);
  tracker.mark("t1", "firstTokenAt", 900);

  assert.equal(tracker.get("t1")?.phases?.firstTokenAt, 100);
});

test("opsStartAt is likewise stamped once, but lastTokenAt keeps advancing", () => {
  const tracker = new TurnTracker();
  tracker.push(turn({ turnId: "t1" }));
  tracker.mark("t1", "opsStartAt", 200);
  tracker.mark("t1", "opsStartAt", 800);
  tracker.mark("t1", "lastTokenAt", 300);
  tracker.mark("t1", "lastTokenAt", 700);

  assert.equal(tracker.get("t1")?.phases?.opsStartAt, 200);
  assert.equal(tracker.get("t1")?.phases?.lastTokenAt, 700);
});

// --- ring: finish ---

test("finishing a tracked turn derives durationMs from its start and end", () => {
  const tracker = new TurnTracker();
  tracker.push(turn({ turnId: "t1", startedAt: "2026-03-01T00:00:00.000Z" }));

  tracker.finish("t1", "agent-a", { status: "ok" }, "2026-03-01T00:00:05.000Z");

  const rec = tracker.get("t1");
  assert.equal(rec?.status, "ok");
  assert.equal(rec?.durationMs, 5000);
  assert.equal(rec?.endedAt, "2026-03-01T00:00:05.000Z");
  assert.equal(rec?.phases?.endedAt, Date.parse("2026-03-01T00:00:05.000Z"));
});

test("an explicit durationMs in the patch wins over the derived one", () => {
  const tracker = new TurnTracker();
  tracker.push(turn({ turnId: "t1", startedAt: "2026-03-01T00:00:00.000Z" }));

  tracker.finish("t1", "agent-a", { status: "ok", durationMs: 7 }, "2026-03-01T00:00:05.000Z");

  assert.equal(tracker.get("t1")?.durationMs, 7);
});

test("an endedAt in the patch overrides the caller's clock", () => {
  const tracker = new TurnTracker();
  tracker.push(turn({ turnId: "t1", startedAt: "2026-03-01T00:00:00.000Z" }));

  tracker.finish("t1", "agent-a", { status: "ok", endedAt: "2026-03-01T00:00:02.000Z" }, "2026-03-01T00:00:05.000Z");

  assert.equal(tracker.get("t1")?.endedAt, "2026-03-01T00:00:02.000Z");
  assert.equal(tracker.get("t1")?.durationMs, 2000);
});

test("finishing a turn evicted from the ring reconstructs it with a recovery reason", () => {
  const tracker = new TurnTracker();

  tracker.finish("gone", "agent-b", { status: "failed", error: "lost" }, "2026-03-01T00:00:05.000Z");

  const rec = tracker.get("gone");
  assert.equal(rec?.agentId, "agent-b");
  assert.equal(rec?.reason.kind, "recovery");
  assert.equal(rec?.startedAt, "2026-03-01T00:00:05.000Z");
  assert.equal(rec?.durationMs, 0, "a reconstructed turn has no measurable duration");
  assert.equal(rec?.status, "failed");
});

test("an unparseable endedAt yields a clamped duration instead of NaN", () => {
  const tracker = new TurnTracker();
  tracker.push(turn({ turnId: "t1", startedAt: "2026-03-01T00:00:00.000Z" }));

  tracker.finish("t1", "agent-a", { status: "failed" }, "not-a-date");

  assert.equal(Number.isNaN(tracker.get("t1")?.durationMs), true, "Date.parse NaN propagates through Math.max");
});

// --- ring: live text ---

test("appending a token delta grows the buffer and both stream counters", () => {
  const tracker = new TurnTracker();
  tracker.push(turn({ turnId: "t1" }));
  tracker.appendText("t1", "hel");
  tracker.appendText("t1", "lo");

  const rec = tracker.get("t1");
  assert.equal(rec?.text, "hello");
  assert.equal(rec?.streamChars, 5);
  assert.equal(rec?.streamFrames, 2);
});

test("an empty delta is dropped before it can inflate the frame counter", () => {
  const tracker = new TurnTracker();
  tracker.push(turn({ turnId: "t1" }));
  tracker.appendText("t1", "");

  assert.equal(tracker.get("t1")?.streamFrames, undefined);
});

test("appending to an unknown turn is a no-op", () => {
  const tracker = new TurnTracker();
  tracker.appendText("ghost", "hi");

  assert.equal(tracker.list().length, 0);
});

test("appending to a finished turn is refused", () => {
  const tracker = new TurnTracker();
  tracker.push(turn({ turnId: "t1", status: "ok" }));
  tracker.appendText("t1", "late token");

  assert.equal(tracker.get("t1")?.text, undefined);
});

test("the text buffer is a trailing window, but the counters keep the true totals", () => {
  const tracker = new TurnTracker();
  tracker.push(turn({ turnId: "t1" }));
  tracker.appendText("t1", "A".repeat(MAX_LIVE_TEXT_CHARS));
  tracker.appendText("t1", "TAIL");

  const rec = tracker.get("t1");
  assert.equal(rec?.text?.length, MAX_LIVE_TEXT_CHARS);
  assert.equal(rec?.text?.endsWith("TAIL"), true, "the oldest overflow is dropped, not the newest");
  assert.equal(rec?.streamChars, MAX_LIVE_TEXT_CHARS + 4, "counters are uncapped on purpose");
});

test("the first delta stamps firstTokenAt once while lastTokenAt tracks the newest", async () => {
  const tracker = new TurnTracker();
  tracker.push(turn({ turnId: "t1" }));
  tracker.appendText("t1", "a");
  const first = tracker.get("t1")?.phases?.firstTokenAt;
  await new Promise((r) => setTimeout(r, 3));
  tracker.appendText("t1", "b");

  const phases = tracker.get("t1")?.phases;
  assert.equal(phases?.firstTokenAt, first);
  assert.equal((phases?.lastTokenAt ?? 0) >= (first ?? 0), true);
});

test("appendText seeds startedAt from the record when no marks exist yet", () => {
  const tracker = new TurnTracker();
  tracker.push(turn({ turnId: "t1", startedAt: "2026-03-01T00:00:10.000Z" }));
  tracker.appendText("t1", "a");

  assert.equal(tracker.get("t1")?.phases?.startedAt, Date.parse("2026-03-01T00:00:10.000Z"));
});

// --- clear ---

test("clear empties the ring", () => {
  const tracker = new TurnTracker();
  tracker.push(turn({ turnId: "t1" }));
  tracker.clear();

  assert.equal(tracker.list().length, 0);
  assert.equal(tracker.get("t1"), undefined);
});

// --- persistence ---

test("a tracker without persistence never schedules a snapshot", () => {
  const tracker = new TurnTracker();
  tracker.push(turn({ turnId: "t1" }));
  tracker.flush();

  assert.equal(tracker.list().length, 1);
});

test("prior records are restored newest-first at construction", () => {
  const persist = recordingPersist([
    turn({ turnId: "old", startedAt: "2026-03-01T00:00:01.000Z" }),
    turn({ turnId: "new", startedAt: "2026-03-01T00:00:09.000Z" }),
  ]);

  const tracker = new TurnTracker(persist);

  assert.deepEqual(tracker.list().map((t) => t.turnId), ["old", "new"], "sorted newest-first then unshifted, so the newest ends at the head-adjacent slot");
  assert.equal(tracker.list().length, 2);
});

test("malformed prior records are dropped instead of poisoning the ring", () => {
  const persist = recordingPersist([
    { turnId: 7, agentId: "a", startedAt: "2026-03-01T00:00:01.000Z" } as unknown as TurnRecord,
    null as unknown as TurnRecord,
    turn({ turnId: "good" }),
  ]);

  const tracker = new TurnTracker(persist);

  assert.deepEqual(tracker.list().map((t) => t.turnId), ["good"]);
});

test("a persistence layer whose load throws leaves the tracker empty rather than failing construction", () => {
  const tracker = new TurnTracker({
    load: () => {
      throw new Error("corrupt sidecar");
    },
    save: () => {},
  });

  assert.equal(tracker.list().length, 0);
});

test("flush writes a snapshot copy, not the live ring", () => {
  const persist = recordingPersist();
  const tracker = new TurnTracker(persist);
  tracker.push(turn({ turnId: "t1" }));

  tracker.flush();
  const snapshot = persist.saves.at(-1);
  tracker.push(turn({ turnId: "t2" }));

  assert.equal(snapshot?.length, 1, "the earlier snapshot is unaffected by later pushes");
  tracker.flush();
  assert.equal(persist.saves.at(-1)?.length, 2);
});

test("a save that throws does not break the turn that triggered it", () => {
  const tracker = new TurnTracker({
    load: () => [],
    save: () => {
      throw new Error("disk full");
    },
  });
  tracker.push(turn({ turnId: "t1" }));

  tracker.flush();

  assert.equal(tracker.get("t1")?.turnId, "t1");
});

test("mutations are debounced into a single snapshot rather than one per delta", async () => {
  const persist = recordingPersist();
  const tracker = new TurnTracker(persist);
  tracker.push(turn({ turnId: "t1" }));
  tracker.appendText("t1", "a");
  tracker.appendText("t1", "b");
  assert.equal(persist.saves.length, 0, "nothing is written synchronously");

  tracker.flush();

  assert.equal(persist.saves.length, 1);
});
