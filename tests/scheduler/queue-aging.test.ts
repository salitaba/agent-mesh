import { test } from "node:test";
import assert from "node:assert/strict";
import {
  effectivePriority,
  QUEUE_AGING_STEP_MS,
  QUEUE_AGING_MAX_BANDS,
} from "../../packages/scheduler/src/index";

/**
 * Waiting has to be worth something, or a busy mesh can starve a seat forever.
 *
 * Priority is a static band table (URGENT 9, HIGH 6, NORMAL 4, LOW 2) and the
 * queue is strict priority-then-FIFO. Nothing raised an entry for having waited:
 * the only priority-raising code required a NEW, independently higher-priority
 * activation for that same seat. So a handful of seats trading URGENT and HIGH
 * traffic could hold every slot indefinitely while a NORMAL sat behind them, and
 * the scheduler had no mechanism to intervene — it self-corrected only when the
 * chatty seats happened to run out of important mail. There is no aging, no
 * round-robin, no quota and no preemption anywhere else in the file, and the
 * stall watchdog cannot help: `checkStall` bails while any turn is in flight,
 * which is precisely when this happens.
 *
 * The rate is deliberately slow — a band a minute. Aging is for breaking a
 * starvation that has set in, not for reordering a queue that is merely busy.
 */

const item = (priority: number, ageMs: number) => ({ priority, enqueuedAt: 1_000_000 - ageMs });
const NOW = 1_000_000;

test("a fresh entry earns nothing", () => {
  assert.equal(effectivePriority(item(4, 0), NOW), 4);
  assert.equal(effectivePriority(item(9, QUEUE_AGING_STEP_MS - 1), NOW), 9, "just under a step is still nothing");
});

test("one band per step", () => {
  assert.equal(effectivePriority(item(4, QUEUE_AGING_STEP_MS), NOW), 5);
  assert.equal(effectivePriority(item(4, QUEUE_AGING_STEP_MS * 3), NOW), 7);
});

test("a starved NORMAL eventually outranks a freshly-arrived URGENT", () => {
  const starved = item(4, QUEUE_AGING_STEP_MS * 6);
  const freshUrgent = item(9, 0);
  assert.ok(
    effectivePriority(starved, NOW) > effectivePriority(freshUrgent, NOW),
    "this is the whole point: without it the NORMAL never runs while URGENTs keep arriving",
  );
});

test("but not immediately — URGENT still wins for the first few minutes", () => {
  const waited = item(4, QUEUE_AGING_STEP_MS * 2);
  assert.ok(
    effectivePriority(waited, NOW) < effectivePriority(item(9, 0), NOW),
    "aging must not reorder a merely-busy queue",
  );
});

test("the bump is capped, so the band table is not inverted for good", () => {
  const ancient = item(2, QUEUE_AGING_STEP_MS * 500);
  assert.equal(effectivePriority(ancient, NOW), 2 + QUEUE_AGING_MAX_BANDS);
});

test("a clock that runs backwards cannot award negative age", () => {
  // `enqueuedAt` is wall-clock, and a queue outliving a clock adjustment must not
  // start handing out negative priorities.
  assert.equal(effectivePriority(item(4, -QUEUE_AGING_STEP_MS * 10), NOW), 4);
});

test("ties break by age, so equal-priority entries stay FIFO", () => {
  const older = item(4, QUEUE_AGING_STEP_MS * 1.5);
  const newer = item(4, QUEUE_AGING_STEP_MS * 1.2);
  // Same earned band (both +1); the comparator's second term is enqueuedAt.
  assert.equal(effectivePriority(older, NOW), effectivePriority(newer, NOW));
  assert.ok(older.enqueuedAt < newer.enqueuedAt, "the older entry sorts first");
});
