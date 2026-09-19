import { test } from "node:test";
import assert from "node:assert/strict";
import { Kernel } from "../../packages/core/src/kernel";
import { MemoryEventStore, type EventQuery, type EventStore } from "../../packages/event-store/src/index";
import { FixedClock, type MeshEvent } from "../../packages/protocol/src/index";

/**
 * `lastEventSeq` is the watermark a snapshot publishes as `throughSeq`, and a
 * restore replays the tail with `read({ sinceSeq: throughSeq })`. That makes it
 * a cut on a total order: everything at or below it is presumed already inside
 * the snapshot. If the mark could regress, the events between the high value
 * and the lower one that replaced it would live in neither the snapshot nor the
 * tail -- dropped from every future replay, with no error anywhere.
 *
 * Two independent writers touch it (the kernel after append, and the reducer in
 * projections.ts), so both are pinned here.
 */

/** Hands back whatever seq the script dictates, so the kernel sees a regression. */
class ScriptedSeqStore implements EventStore {
  readonly appended: MeshEvent[] = [];
  constructor(private seqs: number[]) {}
  async append(event: MeshEvent): Promise<MeshEvent> {
    const seq = this.seqs.shift();
    const stored = { ...event, seq };
    this.appended.push(stored);
    return stored;
  }
  async read(_q?: EventQuery): Promise<MeshEvent[]> {
    return [...this.appended];
  }
  async lastSeq(): Promise<number> {
    return this.appended.length ? (this.appended[this.appended.length - 1].seq ?? 0) : 0;
  }
}

test("kernel's watermark does not regress when a store hands back a lower seq", async () => {
  const store = new ScriptedSeqStore([10, 4]);
  const kernel = new Kernel(store, new FixedClock());

  await kernel.emit("context.assembled", { n: 1 });
  assert.equal(kernel.state.lastEventSeq, 10);

  // A seq that moves backwards must not drag the watermark down with it.
  await kernel.emit("context.assembled", { n: 2 });
  assert.equal(kernel.state.lastEventSeq, 10, "watermark regressed: a snapshot would strand events 5..10");
});

test("reducer's watermark does not regress across an out-of-order rebuild", async () => {
  const kernel = new Kernel(new MemoryEventStore(), new FixedClock());
  const ev = (id: string, seq: number): MeshEvent => ({
    id: `evt-${id}`,
    seq,
    type: "context.assembled",
    timestamp: "2026-01-01T00:00:00.000Z",
    actorId: "tester",
    payload: {},
  });

  await kernel.rebuild([ev("a", 1), ev("b", 9), ev("c", 3)]);
  assert.equal(kernel.state.lastEventSeq, 9, "rebuild let a later, lower seq lower the watermark");
});

test("watermark still tracks normal forward progress", async () => {
  const kernel = new Kernel(new MemoryEventStore(), new FixedClock());
  for (let i = 0; i < 5; i++) await kernel.emit("context.assembled", { i });
  assert.equal(kernel.state.lastEventSeq, 5, "monotonic guard froze the watermark instead of advancing it");
});
