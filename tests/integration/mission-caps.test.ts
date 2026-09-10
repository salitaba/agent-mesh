import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, collectEvents, eventTypes, goalOf } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * Mission caps against a REAL event log and a REAL clock.
 *
 * `tests/core/termination-context.test.ts` calls `TerminationManager.evaluate`
 * with a hand-built `wallClockMs` / `eventCount`, which proves the arithmetic
 * and nothing else. The runtime path has three more links the unit test cannot
 * reach: the supervisor must actually *run* the watchdog, the verdict must
 * become a `goal.escalated` event, and the scheduler must then stop admitting
 * turns. A mission that overruns its cap and keeps burning tokens because the
 * watchdog never fired is exactly the failure these caps exist to prevent, and
 * it is invisible to a unit test.
 */

const ONE_AGENT = [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] }];

const escalationReasons = (m: Awaited<ReturnType<typeof makeMesh>>): string[] =>
  [...m.kernel.state.escalations.values()].map((e) => e.reason);

test("event cap e2e: a mission that outgrows max_events halts with a max_events_exceeded card", async () => {
  const m = await makeMesh({
    agents: ONE_AGENT,
    mayContact: { dev: [] },
    // Boot alone emits a couple of dozen events, so a low cap is already
    // breached by a handful of turns rather than needing a synthetic flood.
    maxEvents: 40,
    mode: "live",
  });
  try {
    const s = stub(m);
    let turns = 0;
    // Each turn emits several events (state changes, memory, budget moves):
    // the cap is reached by ordinary work, not by a special-cased burst.
    s.setScript("dev", async (_i, turn) => {
      turns++;
      return {
        text: `working ${turn}`,
        operations: [
          { op: "remember", key: `note-${turn}`, value: `progress ${turn}` } as MeshOp,
          { op: "done" } as MeshOp,
        ],
      };
    });

    // Drive turns until the cap trips. `activateAgent` is refused once the
    // mission halts, which is itself part of the contract asserted below.
    for (let i = 0; i < 30 && goalOf(m)?.status !== "ESCALATED"; i++) {
      await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
      await m.supervisor.forceWatchdog();
    }

    await waitFor("mission halted on the event cap", () => goalOf(m)?.status === "ESCALATED", 10000);

    assert.ok(turns > 0, "the mission did real work before hitting the cap");
    assert.ok(
      m.kernel.state.eventCount > 40,
      `the cap trips on overrun, not on approach (count ${m.kernel.state.eventCount})`,
    );
    assert.ok(
      escalationReasons(m).includes("max_events_exceeded"),
      `expected a max_events_exceeded card, got ${JSON.stringify(escalationReasons(m))}`,
    );
    const types = eventTypes(await collectEvents(m));
    assert.ok(types.includes("goal.escalated"), "the halt must be event-sourced");

    // A halted mission stops spending. Without this the cap is decorative:
    // the card appears and the agents keep running behind it.
    const refused = await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    assert.equal(refused.queued, false, "no turn may be admitted after the mission halts");
  } finally {
    await m.cleanup();
  }
});

test("event cap e2e: raising the cap is honoured from the log, not from mesh.yaml", async () => {
  const m = await makeMesh({ agents: ONE_AGENT, mayContact: { dev: [] }, maxEvents: 40, mode: "live" });
  try {
    const s = stub(m);
    s.setScript("dev", async (_i, turn) => ({
      operations: [{ op: "remember", key: `n-${turn}`, value: "x" } as MeshOp, { op: "done" } as MeshOp],
    }));

    for (let i = 0; i < 30 && goalOf(m)?.status !== "ESCALATED"; i++) {
      await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
      await m.supervisor.forceWatchdog();
    }
    await waitFor("halted", () => goalOf(m)?.status === "ESCALATED", 10000);
    const cappedAt = m.kernel.state.eventCount;

    // The operator raise: stored on the goal, so it survives replay without
    // anyone editing config.
    const raised = await m.supervisor.adjustGoalBudget(
      { maxEvents: cappedAt + 500 },
      { reason: "operator raise (test)" },
    );
    assert.equal(raised.ok, true, raised.reason);
    assert.equal(goalOf(m)?.budget.maxEvents, cappedAt + 500, "the raise is visible on the goal projection");
    assert.notEqual(
      m.config.budgets.mission.maxEvents,
      cappedAt + 500,
      "the raise lives on the goal, NOT on the resolved config",
    );

    const types = eventTypes(await collectEvents(m));
    assert.ok(types.includes("goal.budget_changed"), "the raise is appended, never mutated in place");

    // Under the raised cap the same verdict no longer fires: the termination
    // manager must read the goal budget, not the config it booted with.
    const before = escalationReasons(m).filter((r) => r === "max_events_exceeded").length;
    await m.supervisor.forceWatchdog();
    assert.equal(
      escalationReasons(m).filter((r) => r === "max_events_exceeded").length,
      before,
      "no second cap card once the goal budget covers the current count",
    );
  } finally {
    await m.cleanup();
  }
});

test("wall-clock e2e: a real elapsed deadline halts the mission with wall_clock_exceeded", async () => {
  // The smallest cap the config accepts is expressed in minutes, so a genuine
  // wall-clock overrun cannot be waited out in a test. What CAN be tested
  // against the real clock is the supervisor's own `startedAt` reference: move
  // it back past the deadline and the very next real watchdog tick must halt
  // the mission. Nothing about the verdict, the event or the halt is faked.
  const m = await makeMesh({
    agents: ONE_AGENT,
    mayContact: { dev: [] },
    wallClockMinutes: 1,
    mode: "live",
  });
  try {
    const s = stub(m);
    s.setScript("dev", async () => ({ operations: [{ op: "done" } as MeshOp] }));
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await m.supervisor.forceWatchdog();
    assert.notEqual(goalOf(m)?.status, "ESCALATED", "a fresh mission is inside its wall-clock budget");

    // 90s of elapsed mission time against a 1-minute cap.
    (m.supervisor as unknown as { startedAt: number }).startedAt = Date.now() - 90_000;
    await m.supervisor.forceWatchdog();

    await waitFor("mission halted on wall clock", () => goalOf(m)?.status === "ESCALATED", 10000);
    assert.ok(
      escalationReasons(m).includes("wall_clock_exceeded"),
      `expected wall_clock_exceeded, got ${JSON.stringify(escalationReasons(m))}`,
    );

    const halt = (await collectEvents(m)).find((e) => e.type === "goal.escalated");
    assert.ok(halt, "the halt is in the log");
    assert.equal((halt.payload as { reason?: string }).reason, "wall_clock_exceeded");
    const detail = (halt.payload as { detail?: { wallClockMs?: number; limitMs?: number } }).detail ?? {};
    assert.equal(detail.limitMs, 60_000, "the card states the limit it enforced");
    assert.ok((detail.wallClockMs ?? 0) > 60_000, "and the elapsed time that breached it");

    const refused = await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    assert.equal(refused.queued, false, "an out-of-time mission admits no further turns");
  } finally {
    await m.cleanup();
  }
});
