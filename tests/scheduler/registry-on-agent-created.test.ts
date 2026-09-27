import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, type TestMesh } from "../helpers";
import { ManualClock, settle } from "../support/manual-clock";
import { applyStagedProposal } from "../../apps/mesh-server/src/staging";
import type { AgentDefinition, MeshOp, StagedMutation } from "../../packages/protocol/src/index";

/**
 * A seat created mid-mission must be an interest candidate (NOTES-test-gaps.md §5.2).
 *
 * `candidatesFor` reads the scheduler's private `interests` map, and that map
 * is filled by `rebuildInterestRegistry` — called from `start()` and from the
 * server's boot, reset and restore sites, and from nowhere else. Nothing
 * rebuilds it on `agent.created`. A seat the operator adds to a running
 * mission therefore declares its interests, has them validated and stored in
 * the projection, and is never woken by any of them: the registry it would
 * have to be in was built before it existed.
 *
 * The seat is added the way an operator adds one — a staged `seat.spawn`
 * applied through `applyStagedProposal`, which routes to
 * `Supervisor.registerAgent` — not by poking the kernel.
 *
 * Scope note: delegated workers (`spawn_worker`) are NOT a live instance of
 * this. `opSpawnWorker` hard-codes `interests: []` on every worker, so a
 * worker has nothing to register. The reachable case is the operator's.
 */

const DONE = { operations: [{ op: "done" } as MeshOp] };

async function meshWithLateSeat(): Promise<{ m: TestMesh; late: AgentDefinition }> {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", interests: ["dependency.changed"] },
      { id: "src", role: "developer", interests: [] },
    ],
    mayContact: { dev: [], src: [] },
    startup: [],
    maxActiveAgents: 4,
    clock: new ManualClock(Date.now()),
  });
  for (const id of ["dev", "src", "auditor"]) stub(m).setScript(id, async () => DONE);
  // A real, fully-resolved definition: the boot seat's, renamed, with its own
  // interests. Anything thinner would fail for reasons that are not the registry.
  const late: AgentDefinition = {
    ...m.kernel.state.agents.get("dev")!.definition,
    id: "auditor",
    role: "security",
    interests: ["dependency.changed"],
  };
  const applied = await applyStagedProposal([{ kind: "seat.spawn", agent: late } as StagedMutation], m);
  assert.equal(applied.ok, true, JSON.stringify(applied.results));
  assert.ok(m.kernel.state.agents.has("auditor"), "precondition: the seat is in the projection");
  return { m, late };
}

test("registry: a seat declared in mesh.yaml is an interest candidate (control)", async () => {
  const { m } = await meshWithLateSeat();
  try {
    assert.ok(m.scheduler.candidatesFor("dependency.changed").includes("dev"));
  } finally {
    await m.cleanup();
  }
});

test(
  "registry: a seat added mid-mission is a candidate for, and woken by, an event it declared",
  async () => {
    const { m } = await meshWithLateSeat();
    try {
      assert.ok(
        m.scheduler.candidatesFor("dependency.changed").includes("auditor"),
        `auditor declared dependency.changed; candidates are ${JSON.stringify(m.scheduler.candidatesFor("dependency.changed"))}`,
      );
      // The behavioural half: the same gap seen as a lost wake, next to a boot
      // seat declaring the same interest that IS woken by the same event.
      const evt = await m.kernel.emit("dependency.changed", { files: ["package.json"], summary: "lodash 4 → 5" }, { actorId: "src" });
      await settle(20);
      const woke = (id: string) => m.supervisor.getRecentTurns(1000).some((t) => t.agentId === id && t.reason.eventId === evt.id);
      await waitFor("the boot seat to wake for the event", () => woke("dev"), 5000);
      assert.equal(woke("auditor"), true, "the late seat declared the same interest and must wake for the same event");
    } finally {
      await m.cleanup();
    }
  },
);
