import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, type TestMesh } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * A wake that waited for a slot while the mission ended is not run.
 *
 * After the end a seat may only read and remember (`MISSION_OVER_ALLOW_OPS`), so a turn started then buys a context
 * window to be refused its `done` ("mission is COMPLETED"). The scheduler already refuses to REQUEUE a finished turn's
 * deferred mail for an agent after the end (`notifyTurnFinished`); a wake that was in the queue when the mission ended was
 * not asked and went through. The thirteenth cronlite run's developer sent the architect an INFORM at 21:11:38, the wake
 * waited behind `max_active_agents`, and the pm's last turn freed a slot at 21:12:14, eight seconds after the goal
 * completed: the architect took a turn, spent 9,795 tokens and was discarded as `no_ops`.
 *
 * What still runs is what an operator or a reopen starts. The mail is never lost: it stays in the box.
 */

const GATE: { release: () => void } = { release: () => undefined };

async function missionWithOneSlot() {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", interests: [] },
      { id: "qa", role: "qa", interests: [] },
    ],
    mayContact: { dev: ["qa"], qa: ["dev"] },
    startup: [],
    maxActiveAgents: 1,
  });
  const qaTurns: string[] = [];
  const held = new Promise<void>((resolve) => void (GATE.release = resolve));
  stub(m).setScript("dev", async () => {
    await held;
    return { operations: [{ op: "done" } as MeshOp] };
  });
  stub(m).setScript("qa", async (input) => {
    qaTurns.push(input.activation.kind);
    return { operations: [{ op: "done" } as MeshOp] };
  });
  // dev takes the only slot and stays in its turn.
  assert.equal((await m.supervisor.activateAgent("dev", { kind: "manual" })).queued, true);
  await waitFor("dev's turn to be running", () => m.scheduler.running() === 1);
  return { m, qaTurns };
}

/** The mission ends while the wake waits: every mandatory criterion evidenced, then the verdict. */
async function endTheMission(m: TestMesh): Promise<void> {
  const goalId = m.kernel.state.activeGoalId!;
  for (const c of m.kernel.state.goals.get(goalId)!.acceptanceCriteria.filter((x) => x.mandatory)) {
    await m.kernel.emit("requirement.satisfied", { criterionId: c.id, evidence: { verified: true, note: "test" } }, { actorId: "human", goalId });
  }
  // The termination manager may complete the mission on the last criterion before this gets there.
  try {
    if (m.kernel.state.goals.get(goalId)?.status !== "COMPLETED") await m.kernel.emit("goal.completed", { goalId, reason: "test done" }, { actorId: "human" });
  } catch (err) {
    if (!/already COMPLETED/.test(String(err))) throw err;
  }
  assert.equal(m.kernel.state.goals.get(goalId)?.status, "COMPLETED", "fixture: the mission is over");
}

const dropped = (m: TestMesh): number => (m.scheduler as unknown as { suppressedWakes(): Record<string, number> }).suppressedWakes().mission_over ?? 0;
const settled = (m: TestMesh) => waitFor("the queue to drain", () => m.scheduler.pending() === 0 && m.scheduler.running() === 0);

test("a seat's mail that was waiting for a slot when the mission ended wakes nobody, and the drop is counted", async () => {
  const { m, qaTurns } = await missionWithOneSlot();
  try {
    const sent = await m.supervisor.sendMessage({ from: "dev", to: ["qa"], type: "INFORM", newThread: { subject: "FYI" }, payload: { done: "all of it" } });
    assert.equal(sent.accepted, true, sent.reason);
    await waitFor("qa's wake to be queued behind dev", () => m.scheduler.pending() === 1);
    await endTheMission(m);
    GATE.release();
    await settled(m);
    assert.deepEqual(qaTurns, [], "no turn for a finished mission");
    assert.equal(dropped(m), 1, "and the drop is on the operator's counter, not silent");
    assert.equal(m.kernel.state.unread.get("qa")?.length ?? 0, 1, "the mail is still in the box: a reopen's recovery wake reads it");
  } finally {
    GATE.release();
    await m.cleanup();
  }
});

test("the operator's mail that was waiting still runs: it is the one follow-up a finished mission takes", async () => {
  const { m, qaTurns } = await missionWithOneSlot();
  try {
    const sent = await m.supervisor.sendMessage({ from: "human", to: ["qa"], type: "INFORM", newThread: { subject: "one more thing" }, payload: { note: "please look at the README" } });
    assert.equal(sent.accepted, true, sent.reason);
    await waitFor("qa's wake to be queued behind dev", () => m.scheduler.pending() === 1);
    await endTheMission(m);
    GATE.release();
    await waitFor("qa's turn", () => qaTurns.length === 1);
    assert.equal(dropped(m), 0);
  } finally {
    GATE.release();
    await m.cleanup();
  }
});

test("a wake an operator asked for (explicit, operator, manual, recovery) still runs after the end, whatever its kind", async () => {
  for (const req of [
    // The flags decide, not the kind: an explicit or operator wake for mail the operator did not send.
    { explicit: true, reason: { kind: "message" as const, note: "asked for by name" } },
    { operator: true, explicit: true, reason: { kind: "message" as const, note: "asked for by name" } },
    // The kind decides when there is no flag: what a reopen and a console start.
    { reason: { kind: "manual" as const } },
    { reason: { kind: "recovery" as const } },
  ]) {
    const { m, qaTurns } = await missionWithOneSlot();
    try {
      const sched = m.scheduler as unknown as { requestActivation(r: Record<string, unknown>): Promise<boolean> };
      assert.equal(await sched.requestActivation({ agentId: "qa", priority: 5, ...req }), true, "fixture: queued behind dev");
      await endTheMission(m);
      GATE.release();
      await waitFor(`qa's turn for ${JSON.stringify(req)}`, () => qaTurns.length === 1);
      assert.equal(dropped(m), 0);
    } finally {
      GATE.release();
      await m.cleanup();
    }
  }
});

test("an interest or timer wake that waited is dropped too, since nobody asked for it", async () => {
  for (const kind of ["interest_event", "timer"] as const) {
    const { m, qaTurns } = await missionWithOneSlot();
    try {
      const sched = m.scheduler as unknown as { requestActivation(r: Record<string, unknown>): Promise<boolean> };
      assert.equal(await sched.requestActivation({ agentId: "qa", priority: 3, reason: { kind, note: "queued before the end" } }), true, "fixture: queued behind dev");
      await endTheMission(m);
      GATE.release();
      await settled(m);
      assert.deepEqual(qaTurns, [], kind);
      assert.equal(dropped(m), 1, kind);
    } finally {
      GATE.release();
      await m.cleanup();
    }
  }
});

test("while the mission is running the same queued wake runs as before", async () => {
  const { m, qaTurns } = await missionWithOneSlot();
  try {
    const sent = await m.supervisor.sendMessage({ from: "dev", to: ["qa"], type: "INFORM", newThread: { subject: "FYI" }, payload: { note: "not over" } });
    assert.equal(sent.accepted, true, sent.reason);
    await waitFor("qa's wake to be queued behind dev", () => m.scheduler.pending() === 1);
    GATE.release();
    await waitFor("qa's turn", () => qaTurns.length === 1);
    assert.equal(dropped(m), 0, "a drop is for the end of the mission, not for a full queue");
  } finally {
    GATE.release();
    await m.cleanup();
  }
});
