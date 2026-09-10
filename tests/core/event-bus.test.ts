import { test } from "node:test";
import assert from "node:assert/strict";
import { LocalEventBus } from "../../packages/core/src/event-bus";
import { PROTOCOL_VERSION, type MeshEvent } from "../../packages/protocol/src/index";

/**
 * The bus is the seam that keeps Supervisor and Scheduler from depending on
 * each other, so its two contracts matter more than its size: a subscriber
 * must be able to leave (without disturbing the ones that stayed), and one
 * listener that throws must not stop the events reaching the others.
 */

let seq = 0;
function evt(type: string): MeshEvent {
  seq++;
  return {
    id: `evt-bus-${seq}`,
    protocolVersion: PROTOCOL_VERSION,
    type: type as MeshEvent["type"],
    timestamp: `2026-03-01T00:00:${String(seq % 60).padStart(2, "0")}.000Z`,
    goalId: "goal-bus",
    seq,
    payload: {},
  } as MeshEvent;
}

// --- delivery ---

test("every subscriber receives the published event, in subscription order", async () => {
  const bus = new LocalEventBus();
  const seen: string[] = [];
  bus.subscribe(() => {
    seen.push("first");
  });
  bus.subscribe(() => {
    seen.push("second");
  });

  await bus.publish(evt("goal.created"));

  assert.deepEqual(seen, ["first", "second"]);
});

test("publish awaits an async listener before resolving", async () => {
  const bus = new LocalEventBus();
  let settled = false;
  bus.subscribe(async () => {
    await new Promise((r) => setTimeout(r, 5));
    settled = true;
  });

  await bus.publish(evt("goal.created"));

  assert.equal(settled, true);
});

test("publishing with no subscribers is a no-op rather than an error", async () => {
  const bus = new LocalEventBus();
  await bus.publish(evt("goal.created"));
});

// --- unsubscribe ---

test("the returned disposer removes only its own listener", async () => {
  const bus = new LocalEventBus();
  const kept: string[] = [];
  const dropped: string[] = [];
  const off = bus.subscribe((e) => {
    dropped.push(e.id);
  });
  bus.subscribe((e) => {
    kept.push(e.id);
  });

  off();
  await bus.publish(evt("goal.created"));

  assert.deepEqual(dropped, []);
  assert.equal(kept.length, 1);
});

test("disposing twice is harmless and does not remove a later listener", async () => {
  const bus = new LocalEventBus();
  const off = bus.subscribe(() => {});
  off();
  off();

  const seen: string[] = [];
  bus.subscribe((e) => {
    seen.push(e.id);
  });
  await bus.publish(evt("goal.created"));

  assert.equal(seen.length, 1);
});

test("subscribing the same function twice delivers to it twice, and one disposer removes both", async () => {
  const bus = new LocalEventBus();
  let calls = 0;
  const listener = () => {
    calls++;
  };
  const off = bus.subscribe(listener);
  bus.subscribe(listener);

  await bus.publish(evt("goal.created"));
  assert.equal(calls, 2, "identical listeners are not deduped on subscribe");

  // The disposer filters by identity, so it cannot remove just one of them.
  off();
  await bus.publish(evt("goal.created"));
  assert.equal(calls, 2, "filtering by identity removes every copy at once");
});

test("a listener that unsubscribes during publish still sees the in-flight event", async () => {
  const bus = new LocalEventBus();
  const seen: string[] = [];
  const off = bus.subscribe((e) => {
    seen.push(e.id);
    off();
  });

  await bus.publish(evt("goal.created"));
  await bus.publish(evt("goal.created"));

  assert.equal(seen.length, 1);
});

test("a listener subscribed during publish is not called for the in-flight event", async () => {
  const bus = new LocalEventBus();
  const late: string[] = [];
  bus.subscribe(() => {
    bus.subscribe((e) => {
      late.push(e.id);
    });
  });

  await bus.publish(evt("goal.created"));
  assert.deepEqual(late, [], "publish iterates a snapshot of the listener list");

  await bus.publish(evt("goal.created"));
  assert.equal(late.length, 1);
});

// --- listener failure isolation ---

test("a throwing listener does not stop delivery to the listeners after it", async () => {
  const bus = new LocalEventBus();
  let reached = false;
  bus.subscribe(() => {
    throw new Error("boom");
  });
  bus.subscribe(() => {
    reached = true;
  });

  await bus.publish(evt("goal.created"));

  assert.equal(reached, true);
});

test("a listener failure is reported to the audit sink with the event type and message", async () => {
  const lines: string[] = [];
  const bus = new LocalEventBus((msg) => lines.push(msg));
  bus.subscribe(() => {
    throw new Error("listener exploded");
  });

  await bus.publish(evt("goal.created"));

  assert.equal(lines.length, 1);
  assert.match(lines[0], /event-bus listener error on goal\.created/);
  assert.match(lines[0], /listener exploded/);
});

test("a rejected async listener is audited the same as a synchronous throw", async () => {
  const lines: string[] = [];
  const bus = new LocalEventBus((msg) => lines.push(msg));
  bus.subscribe(async () => {
    throw new Error("async exploded");
  });

  await bus.publish(evt("message.sent"));

  assert.equal(lines.length, 1);
  assert.match(lines[0], /event-bus listener error on message\.sent: async exploded/);
});

test("a listener failure with no audit sink is swallowed rather than rethrown", async () => {
  const bus = new LocalEventBus();
  bus.subscribe(() => {
    throw new Error("unobserved");
  });

  await bus.publish(evt("goal.created"));
});
