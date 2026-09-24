import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, waitFor, stub, goalOf, collectEvents } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * `requirement.blocked` had no emitter anywhere in the runtime.
 *
 * It was declared in the event catalog, in the JSON schema, in `EVENT_TYPES`,
 * carried `alert` severity, was handled by a reducer, and five shipped configs
 * subscribed to it — including `roles/pm.md`, which instructs the seat to
 * "never ignore it". Nothing ever emitted it. A subscription that cannot fire
 * reads to whoever wrote the config as a mechanism that exists, which is the
 * same trap as a role prompt naming a seat that does not exist.
 *
 * Reopen is the one place the runtime genuinely knows a criterion has
 * regressed: the reducer flips criteria back to UNSATISFIED and, before this,
 * the mesh heard only the goal-level `goal.reopened` — not WHICH criteria were
 * put back in the way.
 */

async function meshWithEvidencedCriterion() {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "qa", role: "qa", capabilities: ["quality.verify"], interests: [] },
    ],
    mayContact: { dev: ["qa"], qa: ["dev"] },
    criteria: [{ id: "ship", description: "the mission artifact exists", mandatory: true }],
    mode: "parked",
  } as never);
  for (const id of ["dev", "qa"]) {
    stub(m).setScript(id, async () => ({ operations: [{ op: "done" } as MeshOp] }));
  }
  const gid = m.kernel.state.activeGoalId!;

  // Prove the criterion before reopening, so the reopen has something to
  // withdraw — a criterion already UNSATISFIED is not news and must not be
  // announced as newly blocked.
  await m.kernel.emit(
    "requirement.satisfied",
    { criterionId: "ship", evidence: { verified: true, note: "done in the test" } },
    { actorId: "dev", goalId: gid },
  );
  return { m, gid };
}

function criterion(m: Awaited<ReturnType<typeof makeMesh>>, id: string) {
  const c = goalOf(m)?.acceptanceCriteria.find((x) => x.id === id);
  if (!c) throw new Error(`criterion ${id} missing`);
  return c;
}

test("a reopen announces the criteria it put back in the way", async () => {
  const { m, gid } = await meshWithEvidencedCriterion();
  try {
    assert.equal(criterion(m, "ship").status, "EVIDENCED", "precondition: the criterion is proven");

    for (const rec of [...m.kernel.state.agents.values()]) {
      if (rec.state.agentId === "human" || rec.state.lifecycle !== "STARTING") continue;
      await m.kernel.emit("agent.started", { agentId: rec.state.agentId }, { actorId: "system" }).catch(() => undefined);
    }
    await m.kernel.emit("goal.completed", { goalId: gid, reason: "test completion", evidence: [] }, { actorId: "human" });
    await (m.supervisor as unknown as { completeMission(): Promise<void> }).completeMission();
    await waitFor("mission completed", () => goalOf(m)?.status === "COMPLETED", 8000);
    assert.equal(criterion(m, "ship").status, "EVIDENCED", "completing the mission does not itself withdraw evidence");

    const reopened = await m.supervisor.reopenGoal({ reason: "the operator rejected the result", by: "human" });
    assert.equal(reopened.ok, true, reopened.reason);

    const events = await collectEvents(m);
    const blocked = events.filter((e) => e.type === "requirement.blocked");
    assert.equal(blocked.length, 1, "the criterion the reopen withdrew must be announced exactly once");
    assert.equal((blocked[0]!.payload as Record<string, unknown>).criterionId, "ship");
    assert.match(String((blocked[0]!.payload as Record<string, unknown>).reason), /reopen/, "and say why it is blocked again");
  } finally {
    await m.cleanup();
  }
});

test("a criterion that was already unsatisfied is not announced as newly blocked", async () => {
  // The signal is only worth having if it means "this CHANGED". Reopen on a
  // mission whose criterion never held must stay quiet about it.
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] }],
    mayContact: { dev: [] },
    criteria: [{ id: "ship", description: "the mission artifact exists", mandatory: true }],
    mode: "parked",
  } as never);
  try {
    const gid = m.kernel.state.activeGoalId!;
    stub(m).setScript("dev", async () => ({ operations: [{ op: "done" } as MeshOp] }));
    for (const rec of [...m.kernel.state.agents.values()]) {
      if (rec.state.agentId === "human" || rec.state.lifecycle !== "STARTING") continue;
      await m.kernel.emit("agent.started", { agentId: rec.state.agentId }, { actorId: "system" }).catch(() => undefined);
    }
    await m.kernel.emit("goal.completed", { goalId: gid, reason: "test completion", evidence: [] }, { actorId: "human" });
    await (m.supervisor as unknown as { completeMission(): Promise<void> }).completeMission();
    await waitFor("mission completed", () => goalOf(m)?.status === "COMPLETED", 8000);

    await m.supervisor.reopenGoal({ reason: "reopened anyway", by: "human" });

    const blocked = (await collectEvents(m)).filter((e) => e.type === "requirement.blocked");
    assert.equal(blocked.length, 0, "nothing changed for this criterion, so there is nothing to announce");
  } finally {
    await m.cleanup();
  }
});
