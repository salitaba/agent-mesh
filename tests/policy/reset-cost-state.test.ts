import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, collectEvents } from "../helpers";
import { TURN_RESERVE_TOKENS } from "../../packages/core/src/budgets";
import type { StubTurn } from "../../packages/agent-runtime/src/index";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * A reset mints a new mission; nothing the old one learned about cost may
 * leak into it.
 *
 * `resetMission` exists so one process can run a fresh mission without being
 * restarted, and its own doc comment is explicit about the contract: "no agent
 * may carry a turn or a budget across the boundary, because the events that
 * established them are no longer in the log". Two pieces of cost state live
 * OUTSIDE the log and so are not wiped with it:
 *
 *   - `Supervisor.turnCostEstimate`, the per-seat EWMA that sizes the next
 *     turn's hold. Keyed by agent id alone, which is the same across missions.
 *   - `BudgetManager.exceededEmitted`, the once-per-key latch on
 *     `budget.exceeded`. The BudgetManager outlives every reset (it is built
 *     once in bootstrap). Its keys carry the goal id, which a reset re-mints —
 *     so this one should be safe, and the second test pins that it is.
 */

const WAIT: MeshOp = { op: "wait" } as MeshOp;

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

async function turn(m: Mesh, t: StubTurn): Promise<void> {
  const before = m.supervisor.getRecentTurns(200).filter((r) => r.agentId === "dev" && r.status !== "running").length;
  stub(m).setScript("dev", async () => t);
  await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
  await waitFor("the turn to settle", () => {
    const done = m.supervisor.getRecentTurns(200).filter((r) => r.agentId === "dev" && r.status !== "running").length;
    return done > before && m.scheduler.running() === 0;
  }, 8000);
  await new Promise((r) => setTimeout(r, 100));
}

async function resetAndGoLive(m: Mesh): Promise<string> {
  const report = await m.reset({});
  assert.equal(report.ok, true, "precondition: the reset succeeded");
  await m.goLive("second mission");
  const goalId = m.kernel.state.activeGoalId;
  assert.ok(goalId, "precondition: the reset minted a goal");
  return goalId!;
}

test(
  "reset: the first turn of a new mission is sized from nothing, not from the old mission's turn costs",
  async () => {
    const m = await makeMesh({
      agents: [{ id: "dev", role: "developer", capabilities: ["repository.read"], interests: [], tokens: 500_000 }],
      startup: [],
      mayContact: { dev: [] },
      persist: true,
    });
    try {
      // Two cheap turns teach the estimator this seat costs ~300 tokens, which
      // shrinks its hold to the 4k floor.
      await turn(m, { operations: [WAIT], tokensUsed: { input: 200, output: 100, total: 300 } });
      await turn(m, { operations: [WAIT], tokensUsed: { input: 200, output: 100, total: 300 } });
      const firstGoal = m.kernel.state.activeGoalId!;
      const learned = (await collectEvents(m))
        .filter((e) => e.type === "budget.reserved")
        .map((e) => e.payload as { key: string; requested: number })
        .filter((p) => p.key === `agent:${firstGoal}/dev`)
        .map((p) => p.requested);
      assert.equal(learned[0], TURN_RESERVE_TOKENS, "precondition: a seat with no history is held at the pessimistic bound");
      assert.ok(learned[1]! < TURN_RESERVE_TOKENS, "precondition: history shrank the hold in the first mission");

      const goalId = await resetAndGoLive(m);
      await turn(m, { operations: [WAIT], tokensUsed: { input: 200, output: 100, total: 300 } });
      const holds = (await collectEvents(m))
        .filter((e) => e.type === "budget.reserved")
        .map((e) => e.payload as { key: string; requested: number })
        .filter((p) => p.key === `agent:${goalId}/dev`);
      assert.ok(holds.length > 0, "precondition: the new mission ran a turn");
      assert.equal(
        holds[0]!.requested,
        TURN_RESERVE_TOKENS,
        "the new mission has no turn history, so its first hold must be the pessimistic bound — not a figure learned from a mission that no longer exists",
      );
    } finally {
      await m.cleanup();
    }
  },
);

test("reset: a new mission that overruns its ledger is told so, whatever the old mission's latch says", async () => {
  // The latch in `BudgetManager.exceeded` fires once per key and is cleared only
  // by `raiseLimit`. If a reset left the key the same, the second mission's
  // overrun would be silent: no `budget.exceeded`, so no card and no halt.
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", capabilities: ["repository.read"], interests: [], tokens: 1000 }],
    startup: [],
    mayContact: { dev: [] },
    autoRaise: { enabled: false },
    persist: true,
  });
  try {
    const overspend: StubTurn = { operations: [WAIT], tokensUsed: { input: 1800, output: 200, total: 2000 } };
    await turn(m, overspend);
    const firstGoal = m.kernel.state.activeGoalId!;
    const before = (await collectEvents(m)).filter((e) => e.type === "budget.exceeded").map((e) => (e.payload as { key: string }).key);
    assert.ok(before.includes(`agent:${firstGoal}/dev`), "precondition: the first mission latched the seat's ledger");

    const goalId = await resetAndGoLive(m);
    assert.notEqual(goalId, firstGoal, "precondition: the reset minted a new goal");
    await turn(m, overspend);
    const after = (await collectEvents(m)).filter((e) => e.type === "budget.exceeded").map((e) => (e.payload as { key: string }).key);
    assert.ok(
      after.includes(`agent:${goalId}/dev`),
      `the second mission's overrun must emit its own budget.exceeded (saw: ${JSON.stringify(after)})`,
    );
    assert.equal(m.kernel.state.budgets.get(`agent:${goalId}/dev`)?.exceeded, true, "and the new ledger reads exceeded");
  } finally {
    await m.cleanup();
  }
});
