import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor } from "../helpers";
import { agentKey } from "../../packages/core/src/budgets";
import type { MeshOp } from "../../packages/protocol/src/index";

function fakeTurn(agentId: string) {
  return {
    turnId: `test-${agentId}-${Date.now()}`,
    agentId,
    reason: { kind: "manual" as const },
    sentOps: 0,
    publishedOps: 0,
    waitRequested: false,
    escalated: false,
    results: [],
  } as never;
}

test("freeze: agent ops are refused while escalated, except alarm/reads; human bypasses", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "qa", role: "qa", capabilities: ["test.execute"], interests: [] },
    ],
    mayContact: { dev: ["qa"], qa: ["dev"] },
  });
  const goalId = m.kernel.state.activeGoalId!;
  const send = { op: "send", type: "INFORM", to: ["qa"], payload: { hi: 1 } } as MeshOp;

  // Baseline while ACTIVE.
  const pub = await m.supervisor.executeOp("dev", { op: "publish_artifact", name: "base", type: "ADR", content: "x" }, fakeTurn("dev"));
  assert.equal(pub.ok, true);
  const artId = pub.artifactId!;

  // Freeze the mission.
  await m.kernel.emit("goal.escalated", { goalId, reason: "test freeze" }, { actorId: "human" });
  assert.equal(m.kernel.state.goals.get(goalId)?.status, "ESCALATED");

  // Mutating agent ops are refused — with no rejection event spam.
  const rejectedBefore = (await m.store.read({ types: ["message.rejected"] })).length;
  assert.match((await m.supervisor.executeOp("dev", send, fakeTurn("dev"))).reason ?? "", /escalated/i);
  assert.equal((await m.supervisor.executeOp("dev", send, fakeTurn("dev"))).ok, false);
  assert.equal((await m.supervisor.executeOp("dev", { op: "publish_artifact", name: "nope", type: "ADR", content: "x" }, fakeTurn("dev"))).ok, false);
  assert.equal((await m.supervisor.executeOp("dev", { op: "approve", subject: "release" }, fakeTurn("dev"))).ok, false);
  assert.equal((await m.supervisor.executeOp("dev", { op: "transition_artifact", artifactId: artId, to: "FINAL" }, fakeTurn("dev"))).ok, false);
  const rejectedAfter = (await m.store.read({ types: ["message.rejected"] })).length;
  assert.equal(rejectedAfter, rejectedBefore, "guard must refuse before the policy layer emits rejections");

  // Alarm, turn-enders, reads and memory stay legal.
  assert.equal((await m.supervisor.executeOp("dev", { op: "escalate", reason: "still stuck", detail: {} }, fakeTurn("dev"))).ok, true);
  assert.equal((await m.supervisor.executeOp("dev", { op: "done", summary: "stopping" }, fakeTurn("dev"))).ok, true);
  assert.equal((await m.supervisor.executeOp("dev", { op: "read_artifact", artifactRef: artId }, fakeTurn("dev"))).ok, true);

  // The human seat bypasses the freeze.
  const human = await m.supervisor.humanSend(["qa"], "INFORM", { note: "operator note" });
  assert.equal(human.accepted, true);

  // Respond → ACTIVE, then pause → PAUSED wording.
  const esc = [...m.kernel.state.escalations.values()].find((e) => e.reason === "still stuck")!;
  assert.equal((await m.supervisor.respondEscalation(esc.id, " Deal with it")).ok, true);
  await m.supervisor.pauseGoal();
  const paused = await m.supervisor.executeOp("dev", send, fakeTurn("dev"));
  assert.equal(paused.ok, false);
  assert.match(paused.reason ?? "", /paused/i);
  await m.cleanup();
});

test("freeze: a turn that outlives the mission stops before its next op (no half-applied turns)", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "qa", role: "qa", capabilities: ["test.execute"], interests: [] },
    ],
    mayContact: { dev: ["qa"], qa: ["dev"] },
    waitWakeupMs: 60,
  });
  const s = stub(m);
  // Pause lands while the runtime is "thinking": the op list must then be
  // skipped wholesale — no artifact without announcement, no rejection spam.
  s.setScript("dev", async (_i, turn) => {
    if (turn === 0) {
      await m.supervisor.pauseGoal();
      return {
        operations: [
          { op: "publish_artifact", name: "half-applied", type: "ADR", content: "x" },
          { op: "send", type: "PATCH_READY", to: ["qa"], newThread: { subject: "ready" }, payload: {} },
        ] as MeshOp[],
      };
    }
    return { operations: [{ op: "done" } as MeshOp] };
  });

  await m.supervisor.activateAgent("dev", { kind: "manual" });
  await waitFor(
    "dev turn finished after mid-turn pause",
    () => m.supervisor.getRecentTurns(5).some((t) => t.agentId === "dev" && t.status !== "running"),
    8000,
  );
  assert.equal(m.kernel.state.goals.get(m.kernel.state.activeGoalId!)?.status, "PAUSED");
  assert.equal(m.kernel.state.artifacts.size, 0, "publish must not land after the mission halted");
  assert.equal([...m.kernel.state.messages.values()].filter((x) => x.from === "dev").length, 0, "send must not execute after the halt");
  assert.equal((await m.store.read({ types: ["message.rejected"] })).length, 0, "no rejection spam for skipped ops");
  const rec = m.supervisor.getRecentTurns(5).find((t) => t.agentId === "dev" && t.status !== "running")!;
  assert.deepEqual(rec.ops ?? [], [], "trace must not claim skipped ops ran");
  const ledger = m.kernel.state.budgets.get(agentKey(m.kernel.state.activeGoalId!, "dev"))!;
  assert.equal(ledger.reserved, 0, "budget reservation must be released");
  await m.cleanup();
});

test("publish: invented artifact types are rejected; re-publish names the version target", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] }],
    mayContact: { dev: [] },
  });
  // A model-invented type (e.g. "ArchitectureDoc") must not land in the store
  // as a first-class record nobody can review or transition.
  const bad = await m.supervisor.createArtifact({ actorId: "dev", name: "x", type: "ArchitectureDoc" as never, content: "x" });
  assert.ok("error" in bad && /unknown artifact type/.test(bad.error), `invented type must be rejected, got ${JSON.stringify(bad)}`);
  const first = await m.supervisor.createArtifact({ actorId: "dev", name: "design", type: "ADR", content: "v1" });
  assert.ok("artifact" in first);
  const dup = await m.supervisor.createArtifact({ actorId: "dev", name: "design", type: "ADR", content: "v2" });
  assert.ok("error" in dup && dup.error.includes(first.artifact.id), `re-publish error must name the version target, got ${JSON.stringify(dup)}`);
  await m.cleanup();
});

test("freeze: mission-over blocks agent writes but keeps reads", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] }],
    mayContact: { dev: [] },
  });
  const goalId = m.kernel.state.activeGoalId!;
  const pub = await m.supervisor.executeOp("dev", { op: "publish_artifact", name: "postmortem", type: "ADR", content: "x" }, fakeTurn("dev"));
  assert.equal(pub.ok, true);
  await m.kernel.emit("goal.completed", { goalId, reason: "test done" }, { actorId: "human" });
  assert.equal((await m.supervisor.executeOp("dev", { op: "publish_artifact", name: "late", type: "ADR", content: "x" }, fakeTurn("dev"))).ok, false);
  assert.equal((await m.supervisor.executeOp("dev", { op: "escalate", reason: "too late", detail: {} }, fakeTurn("dev"))).ok, false);
  assert.equal((await m.supervisor.executeOp("dev", { op: "read_artifact", artifactRef: pub.artifactId! }, fakeTurn("dev"))).ok, true);
  await m.cleanup();
});
