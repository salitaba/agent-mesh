import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, waitFor } from "../helpers";
import { TERMINATION_ACTOR_ID } from "../../packages/core/src/supervisor";
import type { MeshEvent } from "../../packages/protocol/src/index";

/**
 * "human" is the operator, and only the operator.
 *
 * `HUMAN_AGENT_ID` was the convenient default for any event with no agent in scope,
 * and it is also the identity the mesh treats as the operator. In the cronlite run 12
 * events were attributed to `human` that no human had performed: the 11
 * `requirement.satisfied` (each one claimed by a seat, named in `evidence.by`) and the
 * `goal.completed` the watchdog reached. "What did the operator actually do?" could
 * not be answered from the log. (The recovery and delegation paths were corrected
 * earlier, see RECOVERY_ACTOR_ID; this is the next two of the ~15 sites that audit
 * left.)
 */

const AGENTS = [
  { id: "pm", role: "product-manager", authority: ["requirements.accept"], interests: [] },
  { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
];
const COMM = { pm: ["dev"], dev: ["pm"] };

type Mesh = Awaited<ReturnType<typeof makeMesh>>;
const events = async (m: Mesh, type: string): Promise<MeshEvent[]> => (await m.store.read()).filter((e) => e.type === type);

async function mesh(criteria: Array<{ id: string; description: string; mandatory: boolean }>): Promise<Mesh> {
  return makeMesh({ agents: AGENTS, mayContact: COMM, criteria, mode: "parked" });
}

test("a criterion a seat accepts is recorded as that seat's act, not the operator's", async () => {
  const m = await mesh([{ id: "polish", description: "nice to have", mandatory: false }]);
  try {
    const res = await m.supervisor.recordDecision("pm", "approve", "criterion:polish", undefined, "read it, it is fine");
    assert.equal(res.ok, true, res.reason);
    const satisfied = (await events(m, "requirement.satisfied")).at(-1)!;
    assert.equal(satisfied.actorId, "pm", "the claimer, exactly as evidence.by names it");
    assert.equal((satisfied.payload as { evidence: { by?: string } }).evidence.by, "pm");
  } finally {
    await m.cleanup();
  }
});

test("an acceptance the operator gives is still the operator's", async () => {
  const m = await mesh([{ id: "polish", description: "nice to have", mandatory: false }]);
  try {
    const res = await m.supervisor.recordDecision("human", "accept", "criterion:polish", undefined, "operator checked");
    assert.equal(res.ok, true, res.reason);
    assert.equal((await events(m, "requirement.satisfied")).at(-1)!.actorId, "human");
  } finally {
    await m.cleanup();
  }
});

test("evidence the runtime derived itself (no claimer) is the runtime's", async () => {
  const m = await mesh([{ id: "polish", description: "nice to have", mandatory: false }]);
  try {
    // What `markMergeEvidence` records: the worktree merged or the files were written, and no seat said so.
    const landed = await m.supervisor.markCriterionEvidence("polish", { kind: "merge", recordedAt: m.kernel.clock.iso() });
    assert.equal(landed, "EVIDENCED");
    assert.equal((await events(m, "requirement.satisfied")).at(-1)!.actorId, "system");
  } finally {
    await m.cleanup();
  }
});

test("the verdict the watchdog reaches, and the sweep that follows it, are the termination manager's", async () => {
  const m = await mesh([{ id: "ship", description: "done", mandatory: true }]);
  try {
    // Seats that have started are what the completion sweep retires (a parked mesh leaves them STARTING).
    for (const rec of [...m.kernel.state.agents.values()]) {
      if (rec.state.agentId !== "human" && rec.state.lifecycle === "STARTING") {
        await m.kernel.emit("agent.started", { agentId: rec.state.agentId }, { actorId: "system" });
      }
    }
    // The runtime's own acceptance satisfies the only criterion; the watchdog then judges it complete.
    await m.supervisor.markCriterionEvidence("ship", { kind: "merge", recordedAt: m.kernel.clock.iso() });
    await waitFor("the watchdog completes the mission", () => m.kernel.state.goals.get(m.kernel.state.activeGoalId!)?.status === "COMPLETED", 8000);

    const completed = (await events(m, "goal.completed")).at(-1)!;
    assert.equal(completed.actorId, TERMINATION_ACTOR_ID, "nobody at a keyboard ended this mission");
    const swept = await events(m, "agent.completed");
    assert.ok(swept.length > 0, "fixture: the completion sweep retired the seats");
    for (const e of swept) assert.equal(e.actorId, TERMINATION_ACTOR_ID);

    // The log now has no event attributed to `human` that a human did not perform.
    const human = (await m.store.read()).filter((e) => e.actorId === "human" && e.type !== "goal.created" && e.type !== "thread.created" && e.type !== "agent.created");
    assert.deepEqual(human.map((e) => e.type), [], "what remains under `human` is the operator's own boot-time acts");
  } finally {
    await m.cleanup();
  }
});
