import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, goalOf } from "../helpers";
import { FixedClock, type MeshOp } from "../../packages/protocol/src/index";
import { Kernel } from "../../packages/core/src/kernel";
import { MemoryEventStore } from "../../packages/event-store/src/index";
import { applyEvent, ProjectionError } from "../../packages/core/src/projections";
import { createInitialState } from "../../packages/core/src/state";

test("lifecycle: agent progresses through the full state machine", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: ["message.sent"] }],
    mayContact: { dev: [] },
  });
  const s = stub(m);
  s.setScript("dev", async () => ({ operations: [{ op: "done" } as MeshOp] }));
  await m.supervisor.activateAgent("dev", { kind: "manual" });
  await waitFor("dev back to idle", () => m.kernel.state.agents.get("dev")?.state.lifecycle === "IDLE");
  const seq = (await m.store.read()).filter((e) => e.type.startsWith("agent.")).map((e) => e.type);
  assert.ok(seq.includes("agent.created"));
  assert.ok(seq.includes("agent.awakened"));
  m.kernel.state.agents.get("dev")!.state.currentArtifactIds = [];
  await m.cleanup();
});

test("lifecycle: illegal state transition is rejected by the projection layer", () => {
  const state = createInitialState();
  const clock = new FixedClock();
  applyEvent(
    state,
    {
      id: "evt-0",
      type: "agent.created",
      timestamp: clock.iso(),
      payload: {
        agent: {
          id: "ghost",
          role: "r",
          mode: "peer",
          runtime: "stub",
          prompt: {},
          capabilities: [],
          authority: [],
          communicationPolicy: { mayContact: [], mayBeContactedBy: [] },
          interests: [],
          sessionPolicy: { persistent: true },
          delegationPolicy: { allowDelegation: false, maxDepth: 0, maxWorkers: 0 },
          budget: {},
        },
      },
    },
    { transitionGates: {} },
  );
  assert.throws(
    () =>
      applyEvent(
        state,
        {
          id: "evt-1",
          type: "agent.state_changed",
          timestamp: clock.iso(),
          payload: { agentId: "ghost", to: "WORKING" },
        },
        { transitionGates: {} },
      ),
    ProjectionError,
  );
});

test("lifecycle: wait-then-wake-on-message", async () => {
  const m = await makeMesh({
    agents: [
      { id: "a", role: "architect", interests: [] },
      { id: "b", role: "builder", interests: ["message.sent"] },
    ],
    mayContact: { a: ["b"], b: ["a"] },
  });
  const s = stub(m);
  s.setScript("a", async (input) => {
    if (input.context.unreadMail.some((x) => x.from === "b")) {
      return { operations: [{ op: "done" } as MeshOp] };
    }
    return { operations: [{ op: "send", type: "INFORM", to: ["b"], payload: { hi: 1 } } as MeshOp, { op: "wait" } as MeshOp] };
  });
  s.setScript("b", async () => ({ operations: [{ op: "done" } as MeshOp] }));
  await m.supervisor.activateAgent("a", { kind: "manual" });
  await waitFor("a waiting", () => m.kernel.state.agents.get("a")?.state.lifecycle === "WAITING");
  const threads = [...m.kernel.state.threads.values()];
  await m.supervisor.sendMessage({ from: "b", to: ["a"], type: "INFORM", payload: { reply: true }, threadId: threads[threads.length - 1].id });
  await waitFor("a woken by reply and finished", () => m.kernel.state.agents.get("a")?.state.lifecycle === "IDLE", 8000);
  assert.equal(m.kernel.state.agents.get("a")?.state.activations, 2, "a activated exactly twice: startup + reply wake");
  await m.cleanup();
});

test("lifecycle: suspend freezes the agent and resume releases it", async () => {
  const m = await makeMesh({ agents: [{ id: "q", role: "qa", interests: ["message.sent"] }], mayContact: { q: [] } });
  await m.supervisor.suspendAgent("q");
  assert.equal(m.kernel.state.agents.get("q")?.state.lifecycle, "SUSPENDED");
  const ok = await m.scheduler.requestActivation({ agentId: "q", reason: { kind: "manual" }, priority: 5 });
  assert.equal(ok, false);
  await m.supervisor.resumeAgent("q");
  assert.equal(m.kernel.state.agents.get("q")?.state.lifecycle, "IDLE");
  await m.cleanup();
});

test("lifecycle: mission completion marks idle agents completed", async () => {
  const m = await makeMesh({
    agents: [{ id: "pm", role: "pm", authority: ["requirements.accept"], interests: ["goal.progress"] }],
    criteria: [{ id: "done-one", description: "one criterion", mandatory: true }],
  });
  const st = m.kernel.state;
  st.activeGoalId && m.kernel.state.goals.get(st.activeGoalId);
  await m.supervisor.createArtifact({ actorId: "pm", name: "evidence", type: "ADR", content: "x" });
  const art = [...st.artifacts.values()][0];
  await m.supervisor.recordDecision("pm", "accept", "criterion:done-one", art.id, "accepting");
  await waitFor("goal completed", () => goalOf(m)?.status === "COMPLETED", 6000);
  await m.cleanup();
});
