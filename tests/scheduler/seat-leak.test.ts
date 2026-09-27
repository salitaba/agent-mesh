import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor } from "../helpers";

/**
 * The concurrency ceiling must hold when a turn is re-activated as it ends.
 *
 * `notifyTurnFinished` has two owners: the supervisor calls it from `runTurn`'s
 * own `finally` — deliberately, so a handover re-activation is admitted rather
 * than stashed — and `pump`'s `.finally()` calls it again when the promise
 * settles. Neither `requestActivation` nor `pump` contains an `await`, so the
 * supervisor's call can run a whole re-activation SYNCHRONOUSLY and put a new turn
 * in `runningMap` before the second call arrives. That second call then deleted
 * the new turn's entry, and the seat was gone from the map while its turn ran on.
 *
 * Nothing looked wrong: `isBusy` still sees the live turn through the runner
 * probe, so no duplicate turn is minted for that agent — but `capacityWait` counts
 * only the map, so every occurrence permanently widened the ceiling by one.
 * Measured 2026-09-24: five in-flight turns against `max_active_agents: 3`.
 *
 * `tests/scheduler/scheduler.test.ts` cannot catch this. It asserts the cap via
 * `m.scheduler.running()` — which IS `runningMap.size`, the counter that leaks —
 * and fires one wave of activations with no mid-turn mail, so `wakeAfterTurn` is
 * never populated and the re-entry never happens. This drives the real sequence
 * and counts turns, not the map.
 */

const AGENTS = [
  { id: "a", role: "developer", capabilities: ["repository.read"], interests: [] },
  { id: "b", role: "developer", capabilities: ["repository.read"], interests: [] },
];

test("a turn re-activated as it ends does not widen the concurrency ceiling", async () => {
  let live = 0;
  let peak = 0;
  const m = await makeMesh({
    agents: AGENTS,
    mayContact: { a: ["b"], b: ["a"] },
    startup: [],
    maxActiveAgents: 1,
  });
  try {
    const script = async () => {
      live += 1;
      peak = Math.max(peak, live);
      // Long enough that a second turn admitted against a leaked seat overlaps
      // this one observably, rather than racing to finish first.
      await new Promise((r) => setTimeout(r, 250));
      live -= 1;
      return { operations: [{ op: "done" as const }] };
    };
    stub(m).setScript("a", script);
    stub(m).setScript("b", script);

    // `a` takes the only seat; `b` queues behind the ceiling.
    await m.supervisor.activateAgent("a", { kind: "manual" });
    await m.supervisor.activateAgent("b", { kind: "manual" });

    // Mail for `a` WHILE its turn is in flight: `isBusy` is true, so the request
    // is stashed in `wakeAfterTurn` and replayed the instant the turn ends. That
    // replay is the re-entry that used to leak the seat.
    await new Promise((r) => setTimeout(r, 60));
    await m.supervisor.humanSend(["a"], "INFORM", { note: "mid-turn mail" });

    await waitFor("every turn to settle", () => m.supervisor.isIdle() && live === 0, 20_000);

    assert.equal(
      peak,
      1,
      `max_active_agents is 1, so at most one turn may ever be in flight — saw ${peak} overlapping`,
    );
  } finally {
    await m.cleanup();
  }
});

test("the seat is released once, and the scheduler is empty when the mesh is idle", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: { a: ["b"], b: ["a"] }, startup: [], maxActiveAgents: 1 });
  try {
    stub(m).setScript("a", async () => ({ operations: [{ op: "done" as const }] }));
    stub(m).setScript("b", async () => ({ operations: [{ op: "done" as const }] }));
    await m.supervisor.activateAgent("a", { kind: "manual" });
    await m.supervisor.activateAgent("b", { kind: "manual" });
    await waitFor("both turns to settle", () => m.supervisor.isIdle(), 15_000);
    // The mirror of the leak: skipping a delete that IS ours would strand the
    // seat and wedge the ceiling shut. Idle must mean nothing is held.
    assert.equal(m.scheduler.running(), 0, "no seat may outlive the turn that held it");
  } finally {
    await m.cleanup();
  }
});

/**
 * `runningMap` can also disagree with reality in the other direction, and both
 * routes go through `reconcileRunning`.
 *
 * `resetMissionState` used to replace the map wholesale while turns were in
 * flight — dropping live seats, so the ceiling under-counted and admitted extra
 * peers on top of them. And `stop()`'s drain is bounded at 5s, so it can return
 * with seats held; one whose turn ended without calling back would hold its slot
 * for the life of the process, wedging the ceiling shut instead of open.
 */
test("a mission reset keeps the seat of a turn that is still running", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: { a: ["b"], b: ["a"] }, startup: [], maxActiveAgents: 1 });
  try {
    stub(m).setScript("a", async () => {
      await new Promise((r) => setTimeout(r, 400));
      return { operations: [{ op: "done" as const }] };
    });
    await m.supervisor.activateAgent("a", { kind: "manual" });
    await waitFor("the turn to be in flight", () => m.scheduler.running() === 1, 5000);

    m.scheduler.resetMissionState();

    assert.equal(
      m.scheduler.running(),
      1,
      "the turn is still running, so its seat is live state and must survive the wipe",
    );
    await waitFor("the turn to settle", () => m.supervisor.isIdle(), 10_000);
    assert.equal(m.scheduler.running(), 0, "and it still releases normally afterwards");
  } finally {
    await m.cleanup();
  }
});

test("a seat with no turn behind it is dropped rather than held forever", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: { a: ["b"], b: ["a"] }, startup: [], maxActiveAgents: 1 });
  try {
    // A seat no turn will ever call back for — what a timed-out drain or a
    // mid-turn wipe can leave behind. Injected directly because reproducing the
    // race would be timing-dependent, and the reconciliation is the unit here.
    const internals = m.scheduler as unknown as { runningMap: Map<string, unknown> };
    internals.runningMap.set("ghost", { agentId: "ghost", reason: { kind: "manual" }, priority: 4, enqueuedAt: Date.now() });
    assert.equal(m.scheduler.running(), 1, "precondition: the stale seat is counted against the ceiling");

    m.scheduler.resetMissionState();

    assert.equal(m.scheduler.running(), 0, "the runner says nothing is in flight, so the seat is not real");
  } finally {
    await m.cleanup();
  }
});
