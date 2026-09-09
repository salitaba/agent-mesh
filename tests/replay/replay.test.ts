import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, goalOf, evidenceContent } from "../helpers";
import { Kernel } from "../../packages/core/src/kernel";
import { MemoryEventStore } from "../../packages/event-store/src/index";
import { FixedClock, type MeshOp } from "../../packages/protocol/src/index";
import type { MeshEvent } from "../../packages/protocol/src/index";

async function buildTrail(m: Awaited<ReturnType<typeof makeMesh>>) {
  const s = stub(m);
  s.setScript("dev", async (_i, turn) => ({
    operations: [
      { op: "publish_artifact", name: "design-doc", type: "ADR", content: `v ${turn}` },
      { op: "send", type: "INFORM", to: ["lead"], payload: { note: "heads up" }, newThread: { subject: "info" } },
      { op: "done" },
    ] as MeshOp[],
  }));
  s.setScript("lead", async () => ({ operations: [{ op: "done" } as MeshOp] }));
  await m.supervisor.activateAgent("dev", { kind: "manual" });
  await waitFor("dev finished", () => m.kernel.state.agents.get("dev")?.state.lifecycle === "IDLE");
  await m.supervisor.recordDecision("lead", "approve", "architecture", undefined, "fine");
  await new Promise((r) => setTimeout(r, 50));
}

function serializableViews(kernel: Kernel) {
  const st = kernel.state;
  return {
    goals: [...st.goals.values()],
    agents: [...st.agents.entries()].map(([id, r]) => [id, r.state] as const),
    artifacts: [...st.artifacts.values()].sort((a, b) => a.id.localeCompare(b.id)),
    threads: [...st.threads.values()],
    tasks: [...st.tasks.values()],
    decisions: [...st.decisions.values()],
    approvals: [...st.approvals.entries()].map(([k, v]) => [k, v] as const),
    budgets: [...st.budgets.values()].map((b) => ({ ...b, reservations: undefined })).sort((x, y) => x.key.localeCompare(y.key)),
    eventCount: st.eventCount,
    lastSeq: st.lastEventSeq,
  };
}

test("replay: projections rebuild identically from the event log (no LLMs)", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "lead", role: "lead", authority: ["architecture.approve"], interests: [] },
    ],
    mayContact: { dev: ["lead"], lead: ["dev"] },
  });
  await buildTrail(m);
  const events = await m.store.read();
  const fresh = new Kernel(new MemoryEventStore(), new FixedClock(), undefined, { transitionGates: m.config.transitionGates });
  await fresh.rebuild(events as MeshEvent[]);
  assert.deepEqual(serializableViews(fresh), serializableViews(m.kernel));
  await m.cleanup();
});

test("replay: time travel to any sequence point reconstructs that state", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "lead", role: "lead", authority: ["architecture.approve"], interests: [] },
    ],
    mayContact: { dev: ["lead"], lead: ["dev"] },
  });
  await buildTrail(m);
  const total = (await m.store.read()).length;
  const goalId = m.kernel.state.activeGoalId!;
  const mid = await m.supervisor.replay(goalId, Math.floor(total / 2));
  const full = await m.supervisor.replay(goalId);
  assert.ok(mid.asOfSeq < full.asOfSeq);
  assert.ok(mid.artifacts.length <= full.artifacts.length);
  assert.equal(mid.goal?.id, goalId);
  assert.ok(["IDLE", "THINKING", "OBSERVING", "AWAKENED", "REQUESTING"].includes(mid.agents.find((a) => a.agentId === "dev")?.lifecycle ?? ""));
  await m.cleanup();
});

test("replay: a rejected illegal event never enters the log", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] }],
    mayContact: { dev: [] },
  });
  const created = await m.supervisor.createArtifact({ actorId: "dev", name: "p", type: "CodePatch", content: "diff" });
  if (!("artifact" in created)) throw new Error("artifact creation failed");
  await assert.rejects(
    m.kernel.emit("artifact.transition", { artifactId: created.artifact.id, to: "MERGED", gateSatisfied: true }, { actorId: "dev" }),
    /illegal artifact transition/,
  );
  const events = await m.store.read();
  assert.equal(events.filter((e) => e.type === "artifact.transition").length, 0);
  assert.equal(m.kernel.state.artifacts.get(created.artifact.id)?.status, "DRAFT");
  await m.cleanup();
});

test("replay: completed goal is fully reconstructible from evidence", async () => {
  const m = await makeMesh({
    agents: [{ id: "pm", role: "pm", authority: ["requirements.accept"], interests: [] }],
    criteria: [{ id: "final", description: "evidenced only", mandatory: true }],
  });
  const created = await m.supervisor.createArtifact({ actorId: "pm", name: "evidence", type: "TestReport", content: evidenceContent("test report") });
  if (!("artifact" in created)) throw new Error("artifact failed");
  await m.supervisor.recordDecision("pm", "accept", "criterion:final", created.artifact.id, "report proves it");
  await waitFor("completed", () => goalOf(m)?.status === "COMPLETED", 6000);
  const goalId = m.kernel.state.activeGoalId!;
  const state = await m.supervisor.replay(goalId);
  assert.equal(state.goal?.status, "COMPLETED");
  const criterion = state.goal?.acceptanceCriteria.find((c) => c.id === "final");
  assert.equal(criterion?.status, "EVIDENCED");
  assert.ok(criterion?.evidence.length === 1);
  assert.ok(criterion?.evidence[0].artifactRef?.uri.startsWith("artifact://TestReport/evidence"));
  await m.cleanup();
});

test("replay: deterministic orchestration audit captures model/tool decisions", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] }],
    mayContact: { dev: [] },
  });
  const s = stub(m);
  s.setScript("dev", async () => ({
    text: "decision made",
    operations: [{ op: "done" } as MeshOp],
    model: "test-model",
    modelVersion: "2026-01",
    temperature: 0.2,
    toolCalls: [{ name: "mesh_artifact_read", args: { ref: "x" }, resultDigest: "sha" }],
  }));
  await m.supervisor.activateAgent("dev", { kind: "manual" });
  await waitFor("done", () => m.kernel.state.agents.get("dev")?.state.lifecycle === "IDLE");
  const budgetEvents = (await m.store.read()).filter((e) => e.type === "budget.consumed");
  const turnDetail = budgetEvents.find((e) => (e.payload as { model?: string }).model === "test-model");
  assert.ok(turnDetail, "turn must record model + tokens for deterministic orchestration");
  assert.equal((turnDetail!.payload as { temperature?: number }).temperature, 0.2);
  await m.cleanup();
});
