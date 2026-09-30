import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { checkApprovals } from "../../packages/core/src/projections-helpers";
import type { WorkspacePort } from "../../packages/core/src/ports";
import type { MeshEvent, MeshOp } from "../../packages/protocol/src/index";

/**
 * Whose merge it was.
 *
 * `mirrorTransition` stamped `patch.merged` and `implementation.completed` with the
 * patch's OWNER. In the second cronlite run the tech-lead merged the developer's
 * CodePatch every time, so every merge read "developer merged it" while the developer
 * was idle. The kernel correlates an emit to its actor's live turn, so the pair was also
 * filed under the developer's turn: a turn that merged nothing was credited with two
 * effects (the turn-effect count is what tells a productive turn from a no-op one), and
 * the step trace for the merge named the wrong seat.
 *
 * The merge is now the merger's, in the merger's turn, joined to the transition that
 * caused it. The one thing that stays with the owner is the `implementation|pass` record
 * the second event reduces to: it is a gate signature, a gate that names a seat is met by
 * a record that seat is the actor of, and re-attributing it would make the act of merging
 * stand in for the merger's own sign-off.
 */

const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "test.execute"], interests: [] },
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review", "git.merge"], authority: ["implementation.approve"], interests: [] },
];
const COMM = { dev: ["lead"], lead: ["dev"] };
const CRITERIA = [{ id: "implementation-merged", description: "the patch landed", mandatory: true }];

/** A workspace that reports a landed merge; the git arm is what `opMerge` needs to reach MERGED. */
const landed = (): WorkspacePort => {
  const unused = (name: string) => async (): Promise<never> => {
    throw new Error(`workspace double: ${name} is not part of this fixture`);
  };
  return {
    mainPath: "/nonexistent/product",
    ensureRepo: unused("ensureRepo"),
    ensureWorktree: unused("ensureWorktree"),
    commitWorktree: unused("commitWorktree"),
    mergeWorktree: async () => ({ commit: "0123456789abcdef0123456789abcdef01234567" }),
    removeWorktree: unused("removeWorktree"),
    async worktreeState() {
      return null;
    },
  };
};

const turnFor = (agentId: string) =>
  ({
    turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`,
    agentId,
    reason: { kind: "manual" as const },
    sentOps: 0,
    publishedOps: 0,
    waitRequested: false,
    escalated: false,
    results: [],
  }) as never;

/** The private members a live turn leaves behind: which turn an actor is in, and what each turn has produced. */
interface TurnProbe {
  activeTurnByAgent: Map<string, string>;
  turnEffects: Map<string, number>;
}

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

/** dev's CodePatch, walked to MERGEABLE by supervisor calls: the state the tech-lead merges from. */
async function mergeable() {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", criteria: CRITERIA } as never);
  (m.supervisor as unknown as { deps: { workspace?: WorkspacePort } }).deps.workspace = landed();
  const created = await m.supervisor.createArtifact({ actorId: "dev", name: "slice-1", type: "CodePatch", content: "the whole patch, at length" });
  if (!("artifact" in created)) throw new Error("create failed");
  const id = created.artifact.id;
  await m.supervisor.transitionArtifact("dev", id, { to: "READY_FOR_REVIEW" });
  await m.supervisor.executeOp("dev", { op: "request_review", artifactId: id, reviewers: ["lead"] } as MeshOp, turnFor("dev"));
  await m.supervisor.executeOp("lead", { op: "approve", subject: "implementation", artifactId: id } as MeshOp, turnFor("lead"));
  await m.supervisor.transitionArtifact("lead", id, { to: "VERIFIED" });
  await m.supervisor.transitionArtifact("lead", id, { to: "MERGEABLE" });
  assert.equal(m.kernel.state.artifacts.get(id)?.status, "MERGEABLE", "fixture: the patch is staged at the gate");
  assert.equal(m.kernel.state.artifacts.get(id)?.owner, "dev", "fixture: the merger is not the owner");
  return { m, id };
}

/** Put `agentId` mid-turn, as the scheduler would have it, and return the turn's id. */
function pose(m: Mesh, agentId: string): string {
  const turnId = `turn-posed-${agentId}`;
  (m.supervisor as unknown as TurnProbe).activeTurnByAgent.set(agentId, turnId);
  return turnId;
}

async function mergeEvents(m: Mesh, artifactId: string) {
  const events: MeshEvent[] = await m.store.read();
  const about = (type: string) => events.filter((e) => e.type === type && (e.payload as { artifactId?: string }).artifactId === artifactId);
  const toMerged = about("artifact.transition").filter((e) => (e.payload as { to?: string }).to === "MERGED");
  assert.equal(toMerged.length, 1, "one MERGED transition");
  assert.equal(about("patch.merged").length, 1, "one patch.merged");
  assert.equal(about("implementation.completed").length, 1, "one implementation.completed");
  return { transition: toMerged[0]!, merged: about("patch.merged")[0]!, completed: about("implementation.completed")[0]! };
}

test("patch.merged and implementation.completed name the seat that ran the merge, in its turn", async () => {
  const { m, id } = await mergeable();
  try {
    // Both seats mid-turn, as in the live run: the developer idle in its own turn, the tech-lead merging in its.
    const devTurn = pose(m, "dev");
    const leadTurn = pose(m, "lead");
    const res = await m.supervisor.executeOp("lead", { op: "merge", artifactId: id } as MeshOp, turnFor("lead"));
    assert.equal(res.ok, true, res.reason);

    const { transition, merged, completed } = await mergeEvents(m, id);
    assert.equal(transition.actorId, "lead", "control: the transition was the tech-lead's");
    assert.equal(transition.correlationId, leadTurn, "control: and in its turn");
    for (const [name, e] of [["patch.merged", merged], ["implementation.completed", completed]] as const) {
      assert.equal(e.actorId, "lead", `${name} is attributed to the seat that merged it`);
      assert.equal(e.correlationId, leadTurn, `${name} is filed under the merger's turn`);
      assert.notEqual(e.correlationId, devTurn, `${name} is not filed under the owner's turn`);
      assert.equal(e.causationId, transition.id, `${name} is caused by the MERGED transition`);
    }
  } finally {
    await m.cleanup();
  }
});

test("a seat that is mid-turn but did not merge is not credited with the merge", async () => {
  const { m, id } = await mergeable();
  try {
    // Only the owner has a live turn. The merge runs with no turn of the merger's behind it (the
    // operator's door, or a turn that has just ended), so nothing may fall back on the owner's.
    const devTurn = pose(m, "dev");
    const probe = m.supervisor as unknown as TurnProbe;
    assert.equal(probe.turnEffects.get(devTurn) ?? 0, 0, "fixture: the developer's turn has produced nothing");

    const res = await m.supervisor.executeOp("lead", { op: "merge", artifactId: id } as MeshOp, turnFor("lead"));
    assert.equal(res.ok, true, res.reason);

    const { merged, completed } = await mergeEvents(m, id);
    assert.notEqual(merged.correlationId, devTurn, "patch.merged does not belong to the developer's turn");
    assert.notEqual(completed.correlationId, devTurn, "neither does implementation.completed");
    assert.equal(probe.turnEffects.get(devTurn) ?? 0, 0, "the developer's turn is still a turn that produced nothing");
  } finally {
    await m.cleanup();
  }
});

test("the gates read exactly as before: the implementation|pass record is the owner's, and a merge is no sign-off for the merger", async () => {
  const { m, id } = await mergeable();
  try {
    const passes = () => [...m.kernel.state.approvals.values()].flat().filter((r) => r.kind === "pass" && r.subject === "implementation");
    assert.equal(checkApprovals(m.kernel.state, ["lead.pass"]).ok, false, "control: the tech-lead approved, which is not a pass");
    assert.equal(passes().length, 0);

    const res = await m.supervisor.executeOp("lead", { op: "merge", artifactId: id } as MeshOp, turnFor("lead"));
    assert.equal(res.ok, true, res.reason);

    assert.deepEqual(passes().map((r) => r.actorId), ["dev"], "one record, and it is the work's owner");
    assert.equal(checkApprovals(m.kernel.state, ["dev.pass"]).ok, true, "a gate naming the owner is met as it always was");
    assert.equal(
      checkApprovals(m.kernel.state, ["lead.pass"]).ok,
      false,
      "a gate naming the merger is NOT met by the merge: the merger has not signed anything",
    );
  } finally {
    await m.cleanup();
  }
});
