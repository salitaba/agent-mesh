import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stub, testConfigYaml, waitFor, type TestMeshOptions } from "../helpers";
import { bootstrapMesh, type MeshInstance } from "../../apps/mesh-server/src/index";
import { InterruptedTurnError, type MeshOp } from "../../packages/protocol/src/index";
import { ManualClock, makeClockedMesh, settle } from "../support/manual-clock";

/**
 * Supervisor time, on a manual clock.
 *
 * Every test here was impossible before the supervisor read its time from the
 * kernel's clock: the wall-clock verdict needed an hour of real time, the
 * halt-neglect card five stall periods, and the force-settle race a silence
 * floor plus a 2-second grace, with the outcome depending on which real timer
 * the host happened to run first. On a manual clock each boundary is a line.
 */

const T0 = "2026-03-01T09:00:00.000Z";
const MINUTE = 60_000;

const escalationsWith = (m: MeshInstance, pred: (e: { reason: string; conflictKey?: string }) => boolean) =>
  [...m.kernel.state.escalations.values()].filter((e) => pred(e as { reason: string; conflictKey?: string }));

/**
 * Nudge the watchdog. `goal.progress` is not bookkeeping, so it triggers an
 * immediate termination scan; the scan runs on the watchdog chain, which the
 * settle lets finish.
 */
async function poke(m: MeshInstance): Promise<void> {
  await m.kernel.emit("goal.progress", { completed: 0, total: 1, ratio: 0 }, { actorId: "human" });
  await settle(30);
}

/**
 * Timers kept out of the way for the wall-clock tests: an hour of manual time
 * would otherwise fire the wait sweep 18,000 times and let the stall watchdog
 * start nudging seats, which is a different mission from the one under test.
 */
const quietHour: Partial<TestMeshOptions> = { waitWakeupMs: 24 * 60 * MINUTE, stallIdleMs: 24 * 60 * MINUTE, wallClockMinutes: 60 };

test("supervisor clock: the mission wall-clock verdict fires after the budgeted hour, not at it", async () => {
  const clock = new ManualClock(T0);
  const m = await makeClockedMesh({ ...quietHour, agents: [{ id: "dev", role: "developer", interests: [] }], mayContact: { dev: [] } }, clock);
  try {
    const wallClock = () => escalationsWith(m, (e) => e.reason === "wall_clock_exceeded");
    clock.advance(60 * MINUTE);
    await poke(m);
    assert.equal(wallClock().length, 0, "exactly the budget is not over it (the verdict is `>`)");
    clock.advance(1);
    await poke(m);
    assert.equal(wallClock().length, 1, "one millisecond past the hour, the mission is over its wall clock");
  } finally {
    await m.cleanup();
  }
});

/**
 * A file-mode mesh over one state dir, so a second boot is a genuine restart:
 * a new process's kernel replays the log, and `bootstrapMesh` boots it with
 * `resume: true`.
 */
async function fileMesh(dir: string, clock: ManualClock): Promise<MeshInstance> {
  return bootstrapMesh({ configPath: path.join(dir, "mesh.yaml"), inMemory: false, gitMode: "off", mode: "live", clock });
}

test(
  "supervisor clock: a resumed mission's wall clock runs from the goal's creation, not from the restart (NOTES 6.1)",
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-clock-resume-"));
    fs.writeFileSync(
      path.join(dir, "mesh.yaml"),
      testConfigYaml({ ...quietHour, agents: [{ id: "dev", role: "developer", interests: [] }], mayContact: { dev: [] } }),
      "utf8",
    );
    try {
      const first = await fileMesh(dir, new ManualClock(T0));
      const goalId = first.kernel.state.activeGoalId!;
      assert.equal(first.kernel.state.goals.get(goalId)?.createdAt, T0, "fixture: the goal is stamped by the injected clock");
      await first.close();

      // The process comes back 61 minutes into a 60-minute mission.
      const later = new ManualClock(Date.parse(T0) + 61 * MINUTE);
      const second = await fileMesh(dir, later);
      try {
        assert.equal(second.kernel.state.activeGoalId, goalId, "fixture: the restart resumed the same goal");
        assert.equal(second.kernel.state.goals.get(goalId)?.status, "ACTIVE", "fixture: nothing halted the goal before the scan");
        await poke(second);
        assert.equal(
          escalationsWith(second, (e) => e.reason === "wall_clock_exceeded").length,
          1,
          "61 minutes have passed since the goal was created; a restart does not give the mission its hour back",
        );
      } finally {
        await second.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);

/**
 * Halt-neglect fixture: stall_idle_ms 1000, so the card is owed at 5 x 1000 =
 * 5000ms of halt and the stall watch ticks every 333ms (0, 333, ... 4995, 5328).
 */
const haltFixture: TestMeshOptions = {
  stallIdleMs: 1000,
  agents: [{ id: "dev", role: "developer", interests: [] }],
  mayContact: { dev: [] },
};

const haltCard = (m: MeshInstance, goalId: string) => escalationsWith(m, (e) => e.conflictKey === `halt-neglect:${goalId}`);

test("supervisor clock: a neglected halt raises its card once five stall periods have passed, and not before", async () => {
  const clock = new ManualClock(T0);
  const m = await makeClockedMesh(haltFixture, clock);
  try {
    stub(m).setScript("dev", async () => ({ operations: [{ op: "done" } as MeshOp] }));
    const goalId = m.kernel.state.activeGoalId!;
    await m.kernel.emit("goal.escalated", { goalId, reason: "operator halt", detail: {} }, { actorId: "human" });
    await settle();
    assert.equal(m.kernel.state.goals.get(goalId)?.status, "ESCALATED", "fixture: the mission is halted");

    // The last tick inside the window is t=4995.
    await clock.advanceAndSettle(4999);
    assert.equal(haltCard(m, goalId).length, 0, "4999ms of halt is not yet neglect");

    // The next tick is t=5328.
    await clock.advanceAndSettle(400);
    assert.equal(haltCard(m, goalId).length, 1, "the first tick past 5000ms of halt raises exactly one card");
  } finally {
    await m.cleanup();
  }
});

test(
  "supervisor clock: halt-neglect counts from the halt, so a turn that ends during it does not restart the count (NOTES 6.2)",
  async () => {
    const clock = new ManualClock(T0);
    const m = await makeClockedMesh(haltFixture, clock);
    try {
      let release!: () => void;
      const held = new Promise<void>((r) => {
        release = r;
      });
      let started = false;
      stub(m).setScript("dev", async () => {
        started = true;
        await held;
        return { operations: [{ op: "done" } as MeshOp] };
      });
      const goalId = m.kernel.state.activeGoalId!;
      await m.supervisor.activateAgent("dev", { kind: "manual" });
      await waitFor("dev's turn is in flight", () => started);

      // The halt lands while the turn is still running — the ordinary way a
      // mission halts: a verdict or a card raised mid-turn.
      await m.kernel.emit("goal.escalated", { goalId, reason: "operator halt", detail: {} }, { actorId: "human" });
      await settle();
      assert.equal(m.kernel.state.goals.get(goalId)?.status, "ESCALATED", "fixture: the mission is halted");

      // Four seconds into the halt, the in-flight turn ends. No new turn can
      // start: `activateAgent` refuses every kind while ESCALATED.
      await clock.advanceAndSettle(4000);
      release();
      await waitFor("the turn finished", () => m.supervisor.isIdle());
      await settle();

      // t=5328 is the first tick past 5000ms since the halt.
      await clock.advanceAndSettle(1400);
      assert.equal(
        haltCard(m, goalId).length,
        1,
        "the mission has been halted for 5.3s behind no card; the turn that ended at 4s changed nothing about that",
      );
    } finally {
      await m.cleanup();
    }
  },
);

test(
  "supervisor clock: a silence abort that lands after the force-settle fails the turn once, not twice (NOTES 4.3)",
  async () => {
    // Started at the wall clock on purpose: `TurnTracker.appendText` stamps
    // `firstTokenAt` with `Date.now()` (it takes no clock), and the silence
    // watchdog compares that stamp against this clock's `now`.
    const clock = new ManualClock(Date.now());
    const m = await makeClockedMesh(
      { stallIdleMs: 3000, turnTimeoutMs: 600_000, agents: [{ id: "dev", role: "developer", interests: [] }], mayContact: { dev: [] } },
      clock,
      // Not exposed by the fixture builder. 1000ms silence floor; the stall
      // watch ticks every 1000ms (stall_idle_ms / 3).
      { yamlPatch: (y) => y.replace("stall_idle_ms:", "turn_silence_ms: 1000, stall_idle_ms:") },
    );
    try {
      assert.equal(m.config.scheduling.turnSilenceMs, 1000, "fixture: the silence floor was applied");
      let abortLate!: (err: Error) => void;
      const firstTurn = new Promise<never>((_, reject) => {
        abortLate = reject;
      });
      let calls = 0;
      stub(m).setScript("dev", async (input) => {
        calls++;
        if (calls > 1) return { operations: [{ op: "done" } as MeshOp] };
        // Speak once, then go silent — and ignore `interrupt()`, which for a
        // scripted stub turn is a no-op. The abort arrives only when the test
        // delivers it, AFTER the force-settle has already run.
        input.onToken?.("thinking about it");
        return firstTurn;
      });
      await m.supervisor.activateAgent("dev", { kind: "manual" });
      await waitFor("dev spoke and went silent", () => calls === 1);

      // t=2000 is the first tick past the 1000ms floor: interrupt, and arm the
      // force-settle for t=4000. t=4500 is past it, and past its 20ms restart.
      await clock.advanceAndSettle(4500);
      const failedFor = async () => (await m.store.read()).filter((e) => e.type === "agent.failed" && (e.payload as { agentId: string }).agentId === "dev");
      const restartsFor = async () => (await m.store.read()).filter((e) => e.type === "agent.restarted" && (e.payload as { agentId: string }).agentId === "dev");
      assert.equal((await failedFor()).length, 1, "fixture: the force-settle failed the silent turn");

      // The runtime's own abort, answering the interrupt late.
      abortLate(new InterruptedTurnError("stub turn for dev aborted late"));
      await settle(30);
      await clock.advanceAndSettle(100);

      assert.equal((await failedFor()).length, 1, "one silent turn is one agent.failed, however many paths notice it");
      const restarts = await restartsFor();
      assert.equal(restarts.length, 1, "one failure spends one restart attempt");
      assert.deepEqual(restarts.map((e) => (e.payload as { attempt: number }).attempt), [1]);
    } finally {
      await m.cleanup();
    }
  },
);
