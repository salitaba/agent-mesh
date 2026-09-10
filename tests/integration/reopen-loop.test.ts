import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, waitFor, stub, goalOf } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";
import { TerminationManager } from "../../packages/core/src/termination";

/**
 * Regression suite for the complete/reopen LOOP.
 *
 * Observed live (`examples/line-follower-sim`, 2939 events): 6 `goal.completed`
 * against 5 `goal.reopened`, every round re-citing the identical artifacts
 * (`TrackBench-Requirements-v2/1` accepted 4x, the same architecture approved
 * 6x, `TrackBench-MVP-CodePatch/1` merged 3x). The operator rejected the result
 * five times and got the same MVP back each time.
 *
 * Cause: `goal.reopened` reset criteria to UNSATISFIED but kept the evidence
 * trail, and nothing distinguished evidence from the REJECTED round from
 * evidence produced in answer to the rejection. Two independent gates close it:
 *
 *  - identity: an artifact URI named in the rejected evidence cannot satisfy
 *    the same criterion again (`markCriterionEvidence`);
 *  - recency: completion requires each mandatory criterion to hold at least one
 *    piece of evidence recorded after `goal.reopenedAt` (`termination.ts`).
 *
 * Both are needed. Ref-less evidence (`kind: "approval"` / `"quality-pass"`
 * carry no `artifactRef`) is invisible to the identity gate, which is exactly
 * how `architecture-approved` was re-approved six times.
 */

async function mesh() {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "qa", role: "qa", capabilities: ["quality.verify"], interests: [] },
    ],
    mayContact: { dev: ["qa"], qa: ["dev"] },
    criteria: [{ id: "ship", description: "the mission artifact exists", mandatory: true }],
    mode: "parked",
  });
  for (const id of ["dev", "qa"]) {
    stub(m).setScript(id, async () => ({ operations: [{ op: "done" } as MeshOp] }));
  }
  return m;
}

async function completeIt(m: Awaited<ReturnType<typeof mesh>>) {
  const gid = m.kernel.state.activeGoalId!;
  for (const rec of [...m.kernel.state.agents.values()]) {
    if (rec.state.agentId === "human" || rec.state.lifecycle !== "STARTING") continue;
    await m.kernel.emit("agent.started", { agentId: rec.state.agentId }, { actorId: "system" }).catch(() => undefined);
  }
  await m.kernel.emit("goal.completed", { goalId: gid, reason: "test completion", evidence: [] }, { actorId: "human" });
  await (m.supervisor as unknown as { completeMission(): Promise<void> }).completeMission();
  await waitFor("mission completed", () => goalOf(m)?.status === "COMPLETED", 8000);
}

function criterion(m: Awaited<ReturnType<typeof mesh>>) {
  const c = goalOf(m)?.acceptanceCriteria.find((x) => x.id === "ship");
  if (!c) throw new Error("criterion missing");
  return c;
}

test("reopen snapshots the rejected artifact and refuses it as evidence again", async () => {
  const m = await mesh();
  try {
    const uri = "artifact://CodePatch/TrackBench-MVP/1";
    await m.supervisor.markCriterionEvidence("ship", {
      kind: "patch-merged",
      artifactRef: { uri },
      recordedAt: m.kernel.clock.iso(),
    });
    assert.equal(criterion(m).status, "EVIDENCED", "precondition: the first round satisfied the criterion");

    await completeIt(m);
    await m.supervisor.reopenGoal({ reason: "this is still an MVP, I want the real thing" });

    const c = criterion(m);
    assert.equal(c.status, "UNSATISFIED", "the verdict is withdrawn");
    assert.deepEqual(c.rejectedEvidence, [uri], "the rejected artifact is remembered by URI");

    // The loop, exactly: hand the identical artifact back.
    await m.supervisor.markCriterionEvidence("ship", {
      kind: "patch-merged",
      artifactRef: { uri },
      recordedAt: m.kernel.clock.iso(),
    });
    assert.equal(criterion(m).status, "UNSATISFIED", "re-citing the rejected artifact cannot satisfy the criterion");

    // Superseding it must still work, or the mission could never finish.
    await m.supervisor.markCriterionEvidence("ship", {
      kind: "patch-merged",
      artifactRef: { uri: "artifact://CodePatch/TrackBench-MVP/2" },
      recordedAt: m.kernel.clock.iso(),
    });
    assert.equal(criterion(m).status, "EVIDENCED", "a NEW version supersedes the rejected one and satisfies it");
  } finally {
    await m.cleanup();
  }
});

test("a reopened mission does not re-complete on evidence from the rejected round", async () => {
  const m = await mesh();
  try {
    await m.supervisor.markCriterionEvidence("ship", { kind: "approval", by: "qa", recordedAt: m.kernel.clock.iso() });
    assert.equal(criterion(m).status, "EVIDENCED");

    await completeIt(m);
    await m.supervisor.reopenGoal({ reason: "not good enough" });

    const goal = goalOf(m)!;
    assert.ok(goal.reopenedAt, "the reopen is stamped so evidence can be dated against it");

    // Ref-less evidence: no artifactRef, so the identity gate cannot see it.
    // This is the `architecture-approved` path that re-approved six times.
    await m.supervisor.markCriterionEvidence("ship", { kind: "approval", by: "qa", recordedAt: goal.reopenedAt! });
    assert.equal(criterion(m).status, "EVIDENCED", "status flips — the recency gate lives in termination, not here");

    const term = new TerminationManager();
    const inputs = { state: m.kernel.state, config: m.config, wallClockMs: 0 } as never;
    assert.notEqual(
      term.evaluate(inputs).kind,
      "complete",
      "evidence not newer than the reopen must not re-complete the mission",
    );

    // Evidence produced AFTER the reopen is what unblocks completion.
    const fresh = new Date(Date.parse(goal.reopenedAt!) + 60_000).toISOString();
    criterion(m).evidence.push({ kind: "approval", by: "qa", recordedAt: fresh });
    // The reopen also minted a mandatory criterion carrying the operator's
    // reason ("not good enough"), and it blocks completion by design — the
    // whole point is that a reopen cannot be answered without addressing what
    // the operator actually said. Satisfy it the same way.
    for (const c of goal.acceptanceCriteria) {
      if (!c.id.startsWith("operator-feedback-")) continue;
      c.status = "EVIDENCED";
      c.evidence.push({ kind: "approval", by: "qa", recordedAt: fresh });
    }
    assert.equal(term.evaluate(inputs).kind, "complete", "a fresh round's evidence completes the mission normally");
  } finally {
    await m.cleanup();
  }
});
