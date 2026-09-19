import { test } from "node:test";
import assert from "node:assert/strict";
import { Kernel } from "../../packages/core/src/kernel";
import { MemoryEventStore } from "../../packages/event-store/src/index";
import { FixedClock, type Goal } from "../../packages/protocol/src/index";

function makeGoal(id = "goal-dispatch-test"): Goal {
  return {
    id,
    description: "dispatch unit mission",
    acceptanceCriteria: [{ id: "c1", description: "first", mandatory: true, status: "UNSATISFIED", evidence: [] }],
    status: "ACTIVE",
    budget: { tokens: 1000, wallClockMinutes: 10, maxEvents: 100 },
    rootThreadId: `${id}-root`,
    createdAt: "2026-01-01T00:00:00.000Z",
  } as Goal;
}

function makeKernel(audit?: (m: string) => void) {
  const store = new MemoryEventStore();
  return { kernel: new Kernel(store, new FixedClock(), audit), store };
}

test("kernel emit: a slow async listener does not hold up the emitter", async () => {
  const { kernel } = makeKernel();
  let released!: () => void;
  const gate = new Promise<void>((r) => (released = r));
  let finished = false;

  kernel.subscribe(async () => {
    await gate;
    finished = true;
  });

  // Before the fix this await never resolved until the listener did, which
  // put every subscriber's I/O on the emitting agent's critical path in
  // series. Fan-out is notification; the transaction already committed.
  const stored = await kernel.emit("goal.created", { goal: makeGoal() });

  assert.equal(stored.seq, 1, "emit resolved with the stored event");
  assert.equal(finished, false, "and it did not wait for the listener's tail");
  released();
  await gate;
});

test("kernel emit: listeners are still STARTED in order, synchronously, before emit resolves", async () => {
  const { kernel } = makeKernel();
  const order: string[] = [];
  kernel.subscribe(() => {
    order.push("first");
  });
  kernel.subscribe(() => {
    order.push("second");
  });

  await kernel.emit("goal.created", { goal: makeGoal() });

  assert.deepEqual(order, ["first", "second"], "registration order is the delivery order");
});

test("kernel emit: a synchronous listener still completes before the emitter continues", async () => {
  const { kernel } = makeKernel();
  const seen: string[] = [];
  kernel.subscribe((e) => {
    seen.push(e.type);
  });

  await kernel.emit("goal.created", { goal: makeGoal() });

  // Every real listener in the mesh today is synchronous (the supervisor
  // watchdog, the SSE hub, the search index). Non-blocking fan-out must not
  // turn those into a race.
  assert.deepEqual(seen, ["goal.created"], "sync listeners are done by the time emit resolves");
});

test("kernel emit: no listener can miss an event or see two out of order", async () => {
  const { kernel } = makeKernel();
  const seen: Array<number | undefined> = [];
  kernel.subscribe((e) => {
    seen.push(e.seq);
  });

  const goal = makeGoal();
  await kernel.emit("goal.created", { goal });
  await kernel.emit("goal.status_changed", { goalId: goal.id, status: "PAUSED" });
  await kernel.emit("goal.status_changed", { goalId: goal.id, status: "ACTIVE" });

  assert.deepEqual(seen, [1, 2, 3]);
});

test("kernel emit: a rejected async listener is audited where it lands, not left unhandled", async () => {
  const audits: string[] = [];
  const { kernel } = makeKernel((m) => audits.push(m));
  kernel.subscribe(async () => {
    await Promise.resolve();
    throw new Error("late failure");
  });

  await kernel.emit("goal.created", { goal: makeGoal() });
  // The rejection happens after emit resolved — that is the whole point — so
  // give the microtask queue a turn before asserting on the audit line.
  await new Promise((r) => setTimeout(r, 0));

  assert.ok(
    audits.some((m) => m.includes("listener error on goal.created") && m.includes("late failure")),
    `expected an audit line for the late rejection, got ${JSON.stringify(audits)}`,
  );
});
