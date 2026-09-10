import { test } from "node:test";
import assert from "node:assert/strict";
import { Kernel, KernelRejectedError, type KernelSnapshotProvider } from "../../packages/core/src/kernel";
import { MemoryEventStore, type EventQuery, type EventStore } from "../../packages/event-store/src/index";
import { FixedClock, PROTOCOL_VERSION, type Goal, type MeshEvent } from "../../packages/protocol/src/index";

/**
 * Kernel tests drive state the only legitimate way: by emitting events and
 * letting the projections apply them. Nothing here hand-builds a Projections
 * object, so a projection change that breaks the kernel contract shows up here
 * rather than passing against a fixture that agrees with the bug.
 */

function makeGoal(id = "goal-kernel-test"): Goal {
  return {
    id,
    description: "kernel unit mission",
    acceptanceCriteria: [
      { id: "c1", description: "first", mandatory: true, status: "UNSATISFIED", evidence: [] },
      { id: "c2", description: "second", mandatory: false, status: "UNSATISFIED", evidence: [] },
    ],
    status: "ACTIVE",
    budget: { tokens: 1000, wallClockMinutes: 10, maxEvents: 100 },
    rootThreadId: `${id}-root`,
    createdAt: "2026-01-01T00:00:00.000Z",
  } as Goal;
}

function makeKernel(opts: {
  store?: EventStore;
  audit?: (m: string) => void;
  snapshots?: { provider: KernelSnapshotProvider; meshId: string; every?: number };
} = {}) {
  const store = opts.store ?? new MemoryEventStore();
  return { kernel: new Kernel(store, new FixedClock(), opts.audit, undefined, opts.snapshots), store };
}

/** Captures what the kernel writes; `read` is what `replayFromStore` restores from. */
function recordingSnapshotProvider() {
  const writes: Array<{ meshId: string; throughSeq: number; data: Record<string, unknown[]> }> = [];
  let stored: { meshId: string; throughSeq: number; data: Record<string, unknown[]> } | null = null;
  const provider: KernelSnapshotProvider = {
    async write(envelope) {
      writes.push(envelope);
      stored = envelope;
    },
    read() {
      return stored;
    },
  };
  return { provider, writes, setStored: (v: typeof stored) => (stored = v) };
}

// ------------------------------------------------------------------ emit

test("kernel emit: stamps envelope defaults and returns the stored event with a seq", async () => {
  const { kernel, store } = makeKernel();
  const stored = await kernel.emit("goal.created", { goal: makeGoal() }, { actorId: "human" });

  assert.equal(stored.type, "goal.created");
  assert.equal(stored.protocolVersion, PROTOCOL_VERSION);
  assert.equal(stored.actorId, "human");
  assert.equal(stored.timestamp, "2026-01-01T00:00:00.000Z", "timestamp comes from the injected clock");
  assert.ok(stored.id.startsWith("evt-"), `generated id, got ${stored.id}`);
  assert.equal(stored.seq, 1, "seq is assigned by the store, not the caller");
  assert.equal(kernel.state.lastEventSeq, 1, "kernel tracks the durable seq");
  assert.equal((await store.read()).length, 1);
});

test("kernel emit: explicit id, timestamp and goalId override the defaults", async () => {
  const { kernel } = makeKernel();
  const goal = makeGoal();
  await kernel.emit("goal.created", { goal }, { actorId: "human" });

  const stored = await kernel.emit(
    "goal.progress",
    { goalId: goal.id, completed: 1, total: 2 },
    { id: "evt-fixed-id", timestamp: "2030-06-01T12:00:00.000Z", goalId: goal.id, causationId: "evt-cause", correlationId: "turn-7", actorId: "dev" },
  );

  assert.equal(stored.id, "evt-fixed-id");
  assert.equal(stored.timestamp, "2030-06-01T12:00:00.000Z");
  assert.equal(stored.goalId, goal.id);
  assert.equal(stored.causationId, "evt-cause");
  assert.equal(stored.correlationId, "turn-7");
});

test("kernel emit: inherits the active goal id when the caller omits it", async () => {
  const { kernel } = makeKernel();
  const goal = makeGoal();
  await kernel.emit("goal.created", { goal });

  assert.equal(kernel.activeGoal(), goal.id, "goal.created makes the goal active");
  const later = await kernel.emit("agent.created", { agent: { definition: { id: "dev" } } });
  assert.equal(later.goalId, goal.id, "envelope inherits state.activeGoalId");
});

test("kernel emit: a repeated event id is deduped — not applied twice, not appended twice", async () => {
  const { kernel, store } = makeKernel();
  const goal = makeGoal();
  await kernel.emit("goal.created", { goal });

  const first = await kernel.emit("goal.status_changed", { goalId: goal.id, status: "PAUSED" }, { id: "evt-dup" });
  const countAfterFirst = (await store.read()).length;
  const second = await kernel.emit("goal.status_changed", { goalId: goal.id, status: "FAILED" }, { id: "evt-dup" });

  assert.equal(first.seq, countAfterFirst, "first one really landed");
  assert.equal(second.seq, undefined, "the duplicate short-circuits before the store, so it never gets a seq");
  assert.equal((await store.read()).length, countAfterFirst, "no second append");
  assert.equal(kernel.state.goals.get(goal.id)?.status, "PAUSED", "the duplicate payload was never applied");
});

test("kernel emit: a projection rejection surfaces as KernelRejectedError and appends nothing", async () => {
  const audits: string[] = [];
  const { kernel, store } = makeKernel({ audit: (m) => audits.push(m) });

  await assert.rejects(
    () => kernel.emit("goal.status_changed", { goalId: "goal-that-does-not-exist", status: "COMPLETED" }),
    (err: unknown) => {
      assert.ok(err instanceof KernelRejectedError, `expected KernelRejectedError, got ${String(err)}`);
      assert.match((err as Error).message, /unknown goal/);
      return true;
    },
  );

  assert.equal((await store.read()).length, 0, "a rejected event must never reach the log");
  assert.equal(kernel.state.eventCount, 0);
  assert.ok(
    audits.some((m) => m.includes("projection rejected goal.status_changed")),
    `expected an audit line, got ${JSON.stringify(audits)}`,
  );
});

test("kernel emit: a store append failure rolls the in-memory state back to the durable log", async () => {
  const backing = new MemoryEventStore();
  let failNext = false;
  const flaky: EventStore = {
    async append(event: MeshEvent) {
      if (failNext) throw new Error("disk full");
      return backing.append(event);
    },
    read: (q?: EventQuery) => backing.read(q),
    lastSeq: () => backing.lastSeq(),
  };
  const audits: string[] = [];
  const { kernel } = makeKernel({ store: flaky, audit: (m) => audits.push(m) });

  const goal = makeGoal();
  await kernel.emit("goal.created", { goal });
  assert.equal(kernel.state.goals.get(goal.id)?.status, "ACTIVE");

  failNext = true;
  await assert.rejects(() => kernel.emit("goal.status_changed", { goalId: goal.id, status: "PAUSED" }), /disk full/);

  assert.equal(
    kernel.state.goals.get(goal.id)?.status,
    "ACTIVE",
    "the apply happened before the append, so the failure must roll it back",
  );
  assert.equal(kernel.state.eventCount, 1, "rebuild replays only what the store actually holds");
  assert.ok(
    audits.some((m) => m.includes("store append failed") && m.includes("rolling back")),
    `expected a rollback audit line, got ${JSON.stringify(audits)}`,
  );

  failNext = false;
  await kernel.emit("goal.status_changed", { goalId: goal.id, status: "PAUSED" });
  assert.equal(kernel.state.goals.get(goal.id)?.status, "PAUSED", "the kernel is usable again after a rollback");
});

test("kernel emit: rollback failure is audited, and the original append error still propagates", async () => {
  const backing = new MemoryEventStore();
  const broken: EventStore = {
    async append() {
      throw new Error("append exploded");
    },
    async read() {
      throw new Error("read exploded");
    },
    lastSeq: () => backing.lastSeq(),
  };
  const audits: string[] = [];
  const { kernel } = makeKernel({ store: broken, audit: (m) => audits.push(m) });

  await assert.rejects(() => kernel.emit("goal.created", { goal: makeGoal() }), /append exploded/);
  assert.ok(
    audits.some((m) => m.includes("rollback failed") && m.includes("read exploded")),
    `expected a rollback-failure audit line, got ${JSON.stringify(audits)}`,
  );
});

// ------------------------------------------------------------- subscribe

test("kernel subscribe: listeners see stored events in order and unsubscribe stops delivery", async () => {
  const { kernel } = makeKernel();
  const seen: Array<{ type: string; seq: number | undefined }> = [];
  const unsubscribe = kernel.subscribe((e) => {
    seen.push({ type: e.type, seq: e.seq });
  });

  const goal = makeGoal();
  await kernel.emit("goal.created", { goal });
  await kernel.emit("goal.status_changed", { goalId: goal.id, status: "PAUSED" });

  assert.deepEqual(
    seen.map((s) => s.type),
    ["goal.created", "goal.status_changed"],
  );
  assert.deepEqual(
    seen.map((s) => s.seq),
    [1, 2],
    "listeners receive the STORED event, so seq is already assigned",
  );

  unsubscribe();
  await kernel.emit("goal.status_changed", { goalId: goal.id, status: "ACTIVE" });
  assert.equal(seen.length, 2, "after unsubscribe the listener is silent");
});

test("kernel subscribe: a throwing listener is audited and never breaks emit or the other listeners", async () => {
  const audits: string[] = [];
  const { kernel } = makeKernel({ audit: (m) => audits.push(m) });
  const survivors: string[] = [];

  kernel.subscribe(() => {
    throw new Error("listener blew up");
  });
  kernel.subscribe(async () => {
    survivors.push("async listener ran");
  });

  const stored = await kernel.emit("goal.created", { goal: makeGoal() });

  assert.equal(stored.seq, 1, "emit still resolves normally");
  assert.deepEqual(survivors, ["async listener ran"], "the second listener still runs");
  assert.ok(
    audits.some((m) => m.includes("listener error on goal.created") && m.includes("listener blew up")),
    `expected a listener-error audit line, got ${JSON.stringify(audits)}`,
  );
});

test("kernel emit: concurrent emits serialize, so seqs and eventCount never interleave", async () => {
  const { kernel, store } = makeKernel();
  const goal = makeGoal();
  await kernel.emit("goal.created", { goal });

  const statuses = ["PAUSED", "ACTIVE", "PAUSED", "ACTIVE", "PAUSED"] as const;
  const results = await Promise.all(statuses.map((status) => kernel.emit("goal.status_changed", { goalId: goal.id, status })));

  assert.deepEqual(
    results.map((r) => r.seq),
    [2, 3, 4, 5, 6],
    "the serializer preserves call order across concurrent emits",
  );
  const log = await store.read();
  assert.deepEqual(
    log.map((e) => e.seq),
    [1, 2, 3, 4, 5, 6],
    "the log has no gaps and no duplicates",
  );
  assert.equal(kernel.state.eventCount, 6);
});

// --------------------------------------------------------------- rebuild

test("kernel rebuild: replaces state in place and resets the dedup set", async () => {
  const { kernel, store } = makeKernel();
  const goal = makeGoal();
  await kernel.emit("goal.created", { goal }, { id: "evt-a" });
  await kernel.emit("goal.status_changed", { goalId: goal.id, status: "PAUSED" }, { id: "evt-b" });

  const stateRef = kernel.state;
  const events = await store.read();
  await kernel.rebuild(events);

  assert.equal(kernel.state, stateRef, "rebuild mutates in place: every holder keeps its reference");
  assert.equal(kernel.state.goals.get(goal.id)?.status, "PAUSED");
  assert.equal(kernel.state.eventCount, 2);

  // appliedIds was rebuilt from the log, so re-emitting a logged id still dedups.
  await kernel.emit("goal.status_changed", { goalId: goal.id, status: "FAILED" }, { id: "evt-b" });
  assert.equal(kernel.state.goals.get(goal.id)?.status, "PAUSED", "the replayed id is still deduped after rebuild");
});

test("kernel rebuild: replaying an empty log returns a blank mesh", async () => {
  const { kernel } = makeKernel();
  await kernel.emit("goal.created", { goal: makeGoal() });
  assert.ok(kernel.activeGoal());

  await kernel.rebuild([]);

  assert.equal(kernel.activeGoal(), null);
  assert.equal(kernel.state.goals.size, 0);
  assert.equal(kernel.state.eventCount, 0);
});

// ---------------------------------------------------------- resetToEmpty

test("kernel resetToEmpty: wipes projections and the durable log, keeping object identity", async () => {
  const { kernel, store } = makeKernel();
  const goal = makeGoal();
  await kernel.emit("goal.created", { goal });
  await kernel.emit("goal.status_changed", { goalId: goal.id, status: "PAUSED" });
  const stateRef = kernel.state;

  await kernel.resetToEmpty();

  assert.equal(kernel.state, stateRef, "state object identity survives the reset");
  assert.equal(kernel.activeGoal(), null);
  assert.equal(kernel.state.goals.size, 0);
  assert.equal((await store.read()).length, 0, "the log is emptied, not just the projections");

  // The store restarted its sequence, so the mesh is genuinely blank.
  const after = await kernel.emit("goal.created", { goal: makeGoal("goal-second-mission") });
  assert.equal(after.seq, 1);
  assert.equal(kernel.activeGoal(), "goal-second-mission");
});

test("kernel resetToEmpty: overwrites a stale snapshot so the next replay cannot restore the deleted mission", async () => {
  const snap = recordingSnapshotProvider();
  const { kernel } = makeKernel({ snapshots: { provider: snap.provider, meshId: "mesh-1", every: 1 } });
  const goal = makeGoal();
  await kernel.emit("goal.created", { goal });
  assert.ok(snap.writes.length > 0, "every:1 snapshots on each emit");

  await kernel.resetToEmpty();

  const last = snap.writes.at(-1)!;
  assert.equal(last.throughSeq, 0, "the reset snapshot points at a blank log");
  assert.deepEqual(last.data.goals, [], "and carries no goals");

  const restored = await kernel.replayFromStore();
  assert.equal(restored, 0);
  assert.equal(kernel.activeGoal(), null, "replaying after a reset must not resurrect the mission");
});

test("kernel resetToEmpty: a failing snapshot provider is audited, not thrown", async () => {
  const audits: string[] = [];
  const provider: KernelSnapshotProvider = {
    async write() {
      throw new Error("snapshot disk gone");
    },
    read: () => null,
  };
  const { kernel } = makeKernel({ audit: (m) => audits.push(m), snapshots: { provider, meshId: "mesh-1", every: 1 } });

  await kernel.resetToEmpty();

  assert.equal(kernel.activeGoal(), null, "the reset itself still completed");
  assert.ok(
    audits.some((m) => m.includes("snapshot reset failed") && m.includes("snapshot disk gone")),
    `expected a snapshot-reset audit line, got ${JSON.stringify(audits)}`,
  );
});

// ------------------------------------------------------------- snapshots

test("kernel snapshots: written every N emits, carrying the durable seq", async () => {
  const snap = recordingSnapshotProvider();
  const { kernel } = makeKernel({ snapshots: { provider: snap.provider, meshId: "mesh-snap", every: 3 } });
  const goal = makeGoal();

  await kernel.emit("goal.created", { goal });
  await kernel.emit("goal.status_changed", { goalId: goal.id, status: "PAUSED" });
  assert.equal(snap.writes.length, 0, "nothing written before the interval is reached");

  await kernel.emit("goal.status_changed", { goalId: goal.id, status: "ACTIVE" });
  assert.equal(snap.writes.length, 1, "the 3rd emit trips every:3");
  assert.equal(snap.writes[0]!.meshId, "mesh-snap");
  assert.equal(snap.writes[0]!.throughSeq, 3, "the snapshot names the seq it is complete through");

  await kernel.emit("goal.status_changed", { goalId: goal.id, status: "PAUSED" });
  await kernel.emit("goal.status_changed", { goalId: goal.id, status: "ACTIVE" });
  assert.equal(snap.writes.length, 1, "emits 4 and 5 are below the next boundary");
  await kernel.emit("goal.status_changed", { goalId: goal.id, status: "PAUSED" });
  assert.equal(snap.writes.length, 2, "the 6th emit trips it again");
});

test("kernel snapshots: a failing write is audited and the emit still succeeds", async () => {
  const audits: string[] = [];
  const provider: KernelSnapshotProvider = {
    async write() {
      throw new Error("snapshot write refused");
    },
    read: () => null,
  };
  const { kernel, store } = makeKernel({ audit: (m) => audits.push(m), snapshots: { provider, meshId: "mesh-1", every: 1 } });

  const stored = await kernel.emit("goal.created", { goal: makeGoal() });

  assert.equal(stored.seq, 1, "a snapshot failure must never fail the event");
  assert.equal((await store.read()).length, 1);
  assert.ok(
    audits.some((m) => m.includes("snapshot failed") && m.includes("snapshot write refused")),
    `expected a snapshot-failure audit line, got ${JSON.stringify(audits)}`,
  );
});

test("kernel snapshots: no provider configured means no snapshot work at all", async () => {
  const { kernel } = makeKernel();
  const goal = makeGoal();
  await kernel.emit("goal.created", { goal });
  // Well past any default interval boundary: without a provider this must stay
  // a plain no-op rather than reaching for exportState.
  for (let i = 0; i < 5; i++) {
    await kernel.emit("goal.status_changed", { goalId: goal.id, status: i % 2 === 0 ? "PAUSED" : "ACTIVE" });
  }
  assert.equal(kernel.state.eventCount, 6);
  assert.equal(kernel.snapshot().seq, 6, "the unconfigured path still tracks seq normally");
});

// -------------------------------------------------------- replayFromStore

test("kernel replayFromStore: full replay when no snapshot exists, returning the event count", async () => {
  const store = new MemoryEventStore();
  const { kernel } = makeKernel({ store });
  const goal = makeGoal();
  await kernel.emit("goal.created", { goal });
  await kernel.emit("goal.status_changed", { goalId: goal.id, status: "PAUSED" });

  const fresh = new Kernel(store, new FixedClock());
  const count = await fresh.replayFromStore();

  assert.equal(count, 2, "full replay reports every event it applied");
  assert.equal(fresh.activeGoal(), goal.id);
  assert.equal(fresh.state.goals.get(goal.id)?.status, "PAUSED");
});

test("kernel replayFromStore: snapshot fast path restores the snapshot and applies only the tail", async () => {
  const store = new MemoryEventStore();
  const snap = recordingSnapshotProvider();
  const { kernel } = makeKernel({ store, snapshots: { provider: snap.provider, meshId: "mesh-fast", every: 2 } });
  const goal = makeGoal();

  await kernel.emit("goal.created", { goal });
  await kernel.emit("goal.status_changed", { goalId: goal.id, status: "PAUSED" });
  assert.equal(snap.writes.at(-1)?.throughSeq, 2, "snapshot taken at seq 2");
  // Tail: written after the snapshot, so only these should be re-applied.
  await kernel.emit("goal.status_changed", { goalId: goal.id, status: "ACTIVE" });

  const fresh = new Kernel(store, new FixedClock(), undefined, undefined, { provider: snap.provider, meshId: "mesh-fast" });
  const tailCount = await fresh.replayFromStore();

  assert.equal(tailCount, 1, "only the post-snapshot tail is replayed");
  assert.equal(fresh.activeGoal(), goal.id, "the snapshot supplied the pre-tail state");
  assert.equal(fresh.state.goals.get(goal.id)?.status, "ACTIVE", "and the tail brought it up to date");
});

test("kernel replayFromStore: a corrupt snapshot falls back to full replay instead of failing", async () => {
  const store = new MemoryEventStore();
  const { kernel } = makeKernel({ store });
  const goal = makeGoal();
  await kernel.emit("goal.created", { goal });
  await kernel.emit("goal.status_changed", { goalId: goal.id, status: "PAUSED" });

  const audits: string[] = [];
  const brokenProvider: KernelSnapshotProvider = {
    async write() {
      /* unused */
    },
    read() {
      throw new Error("snapshot file corrupt");
    },
  };
  const fresh = new Kernel(store, new FixedClock(), (m) => audits.push(m), undefined, { provider: brokenProvider, meshId: "mesh-1" });
  const count = await fresh.replayFromStore();

  assert.equal(count, 2, "the fallback replays the whole log");
  assert.equal(fresh.state.goals.get(goal.id)?.status, "PAUSED", "and lands on the same state");
  assert.ok(
    audits.some((m) => m.includes("snapshot restore failed") && m.includes("falling back to full replay")),
    `expected a fallback audit line, got ${JSON.stringify(audits)}`,
  );
});

test("kernel replayFromStore: a snapshot provider holding nothing takes the full-replay path", async () => {
  const store = new MemoryEventStore();
  const { kernel } = makeKernel({ store });
  await kernel.emit("goal.created", { goal: makeGoal() });

  const empty: KernelSnapshotProvider = { async write() {}, read: () => null };
  const fresh = new Kernel(store, new FixedClock(), undefined, undefined, { provider: empty, meshId: "mesh-1" });

  assert.equal(await fresh.replayFromStore(), 1);
  assert.equal(fresh.activeGoal(), "goal-kernel-test");
});

// -------------------------------------------------------------- accessors

test("kernel snapshot(): reports the durable seq, event count and last event time", async () => {
  const { kernel } = makeKernel();
  assert.deepEqual(kernel.snapshot(), { seq: 0, eventCount: 0, at: null }, "a blank kernel reports zeroes");

  const goal = makeGoal();
  await kernel.emit("goal.created", { goal });
  await kernel.emit("goal.status_changed", { goalId: goal.id, status: "PAUSED" }, { timestamp: "2026-02-02T00:00:00.000Z" });

  assert.deepEqual(kernel.snapshot(), { seq: 2, eventCount: 2, at: "2026-02-02T00:00:00.000Z" });
});

test("kernel gates: transitionGates passed at construction reach the projections", async () => {
  const store = new MemoryEventStore();
  const kernel = new Kernel(store, new FixedClock(), undefined, { transitionGates: { "artifact.merge": ["architecture.approve"] } });
  assert.deepEqual(kernel.gates?.transitionGates, { "artifact.merge": ["architecture.approve"] });
  await kernel.emit("goal.created", { goal: makeGoal() });
  assert.equal(kernel.activeGoal(), "goal-kernel-test");
});
