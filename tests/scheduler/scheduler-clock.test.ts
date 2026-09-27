import { test } from "node:test";
import assert from "node:assert/strict";
import { stub, waitFor } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";
import { ManualClock, makeClockedMesh, settle } from "../support/manual-clock";

/**
 * Scheduler time, on a manual clock.
 *
 * Both behaviours here are defined by a boundary — a 30-second park, a
 * coalesce window — and were untestable at the boundary while the scheduler
 * read `Date.now()` directly: the park needed a 30-second sleep, and the window
 * could only be checked "well before" and "eventually after", which is exactly
 * the margin an off-by-one lives in. Each test now names the last millisecond
 * that must NOT act and the first one that must.
 */

test("scheduler clock: the circuit-breaker park lifts at exactly 30s, not a millisecond sooner", async () => {
  const clock = new ManualClock();
  const m = await makeClockedMesh(
    {
      agents: [{ id: "dev", role: "developer", interests: [] }],
      mayContact: { dev: [] },
    },
    clock,
  );
  try {
    const ask = () => m.scheduler.requestActivation({ agentId: "dev", reason: { kind: "timer", note: "nudge" }, priority: 3 });
    for (let i = 0; i < 3; i++) m.scheduler.noteTurnOutcome?.("dev", "blocked");
    assert.equal(m.scheduler.isParkedForBackoff("dev"), true, "three strikes park the seat");
    assert.equal(await ask(), false, "a parked seat refuses a timer wake");

    clock.advance(29_999);
    assert.equal(m.scheduler.isParkedForBackoff("dev"), true, "still parked one millisecond before the cooldown ends");
    assert.equal(await ask(), false);

    clock.advance(1);
    assert.equal(m.scheduler.isParkedForBackoff("dev"), false, "the park lapses exactly at PARK_MS");
    assert.equal(await ask(), true, "and the seat can be woken again");
  } finally {
    await m.cleanup();
  }
});

test("scheduler clock: a gathered deliver-class burst releases one wake exactly when the window closes", async () => {
  const clock = new ManualClock();
  const m = await makeClockedMesh(
    {
      agents: [
        { id: "architect", role: "architect", interests: [] },
        { id: "dev", role: "developer", interests: [] },
      ],
      mayContact: { architect: ["dev"] },
      // The window is drained by the wait sweep, so it can only close on a
      // sweep tick; 100 divides 900, so a tick lands on the boundary itself.
      waitWakeupMs: 100,
      bus: { delivery: { classes: true, coalesceMs: 900 } },
    },
    clock,
  );
  try {
    let turns = 0;
    stub(m).setScript("dev", async () => {
      turns++;
      return { operations: [{ op: "done" } as MeshOp] };
    });
    stub(m).setScript("architect", async () => ({ operations: [{ op: "done" } as MeshOp] }));
    for (const q of ["which repo ships first?", "who owns the migration?", "is the flag on in staging?"]) {
      const sent = await m.supervisor.sendMessage({ from: "architect", to: ["dev"], type: "REQUEST_INFO", newThread: { subject: q }, payload: { q } });
      assert.equal(sent.accepted, true, sent.reason);
      assert.equal(m.kernel.state.messages.get(sent.messageId!)?.control?.delivery, "deliver", "fixture: the ask must be deliver-class");
    }

    // Eight sweeps run inside this advance; none may release the burst.
    await clock.advanceAndSettle(899);
    assert.equal(turns, 0, "the window is still open at 899ms");

    await clock.advanceAndSettle(1);
    await waitFor("the gathered burst bought its wake", () => turns > 0, 5000);
    await waitFor("the mesh drained", () => m.supervisor.isIdle());
    await settle();
    assert.equal(turns, 1, "three asks, one gathered wake");
  } finally {
    await m.cleanup();
  }
});
