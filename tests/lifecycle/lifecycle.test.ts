import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, goalOf, evidenceContent } from "../helpers";
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
  await m.supervisor.createArtifact({ actorId: "pm", name: "evidence", type: "ADR", content: evidenceContent("completion evidence") });
  const art = [...st.artifacts.values()][0];
  await m.supervisor.transitionArtifact("pm", art.id, { to: "READY_FOR_REVIEW" });
  await m.supervisor.recordDecision("pm", "accept", "criterion:done-one", art.id, "accepting");
  await waitFor("goal completed", () => goalOf(m)?.status === "COMPLETED", 6000);
  await m.cleanup();
});

test("lifecycle: restartable failure neither escalates nor freezes the goal", async () => {
  const m = await makeMesh({
    agents: [
      { id: "asker", role: "architect", capabilities: ["review.design"], interests: [] },
      // Generous token budget: stub turns still reserve/consume, and the point
      // here is failure handling, not budget exhaustion.
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [], tokens: 10000000 },
    ],
    mayContact: { asker: ["dev"], dev: ["asker"] },
    startup: ["asker"],
    waitWakeupMs: 50,
  });
  const s = stub(m);
  let askerTurns = 0;
  s.setScript("asker", async () => {
    askerTurns++;
    // Send exactly once: a script that re-sends on every wake would ping-pong
    // with the answer (send -> reply -> wake -> send ...) and correctly trip
    // the budget guard. That loop is the script's bug, not the mesh's.
    if (askerTurns > 1) return { operations: [{ op: "done" }] as MeshOp[] };
    return { operations: [{ op: "send", type: "REQUEST", to: ["dev"], newThread: { subject: "q" }, payload: {} }, { op: "wait" }] as MeshOp[] };
  });
  let devTurns = 0;
  // One flaky turn, then healthy: the single failure is restartable and must
  // leave no trace behind (no card, goal ACTIVE, restart runs). Turn 2
  // answers the ask — otherwise the (correct) stalemate path fires for a
  // genuinely unanswered ask and the test would prove nothing.
  s.setScript("dev", async () => {
    devTurns++;
    if (devTurns === 1) throw new Error("backend died");
    const open = [...m.kernel.state.pendingRequests.values()].find((pr) => pr.to.includes("dev"));
    if (!open) return { operations: [{ op: "done" }] as MeshOp[] };
    const threadId = m.kernel.state.messages.get(open.messageId)!.threadId;
    return { operations: [{ op: "send", type: "INFORM", to: ["asker"], threadId, replyTo: open.messageId, payload: { ok: true } }] as MeshOp[] };
  });
  // Wait for the ask to have HAPPENED, not to still be open: `dev`'s second
  // turn answers it, so `pendingRequests.size === 1` is a transient state that
  // a 25ms poll under load can step straight over. Polling for a value that
  // the system is actively racing to clear is a flaky test, not a flaky mesh.
  await waitFor("ask sent", () => askerTurns >= 1 && m.kernel.state.messages.size >= 1, 8000);
  await waitFor("dev restarted", () => devTurns >= 2, 8000);
  await new Promise((r) => setTimeout(r, 500));
  // A failure with a restart 20ms away is recoverable: no operator card, and
  // the goal stays ACTIVE so the restart itself is allowed to run.
  const open = [...m.kernel.state.escalations.values()].filter((e) => e.status === "OPEN");
  assert.equal(open.length, 0, `restartable failure must not escalate, got ${open.map((c) => c.reason)}`);
  assert.equal(goalOf(m)?.status, "ACTIVE", "goal must stay ACTIVE through a restartable failure");
  await m.cleanup();
});

test("lifecycle: terminal debtor failure notifies the asker, parks the corpse, keeps the mission alive", async () => {
  const m = await makeMesh({
    agents: [
      { id: "asker", role: "architect", capabilities: ["review.design"], interests: [] },
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
    ],
    mayContact: { asker: ["dev"], dev: ["asker"] },
    startup: ["asker"],
    waitWakeupMs: 50,
  });
  const s = stub(m);
  let askerTurns = 0;
  s.setScript("asker", async () => {
    askerTurns++;
    if (askerTurns === 1) {
      return { operations: [{ op: "send", type: "REQUEST", to: ["dev"], newThread: { subject: "q" }, payload: {} }, { op: "wait" }] as MeshOp[] };
    }
    return { operations: [{ op: "done" }] as MeshOp[] };
  });
  s.setScript("dev", async () => { throw new Error("backend died"); });
  // NOTE: pending==0 is vacuously true before the ask exists — wait for the
  // ask to land first, then for its discharge.
  await waitFor("ask pending", () => m.kernel.state.pendingRequests.size === 1, 8000);
  await waitFor("ask discharged", () => m.kernel.state.pendingRequests.size === 0, 12000);
  // The corpse is parked, not left FAILED where the termination verdict would trip on it.
  assert.equal(m.kernel.state.agents.get("dev")?.state.lifecycle, "SUSPENDED");
  // The asker was told and re-woken — not left WAITING on a dead debtor.
  const notice = [...m.kernel.state.messages.values()].find(
    (x) => x.from === "human" && x.to.includes("asker") && JSON.stringify(x.payload).includes("failed terminally"),
  );
  assert.ok(notice, "asker must receive the debtor-failed notice");
  await waitFor("asker re-woken", () => askerTurns >= 2, 8000);
  // Advisory card only: informs, does not freeze.
  const cards = [...m.kernel.state.escalations.values()].filter((e) => e.status === "OPEN");
  assert.ok(cards.every((c) => c.advisory === true), `only advisory cards may remain, got ${cards.map((c) => `${c.reason}/${c.advisory}`)}`);
  assert.equal(goalOf(m)?.status, "ACTIVE", "mission continues without the dead agent");
  await m.cleanup();
});

test("lifecycle: superseded asker is re-woken instead of stranded in WAITING", async () => {
  const m = await makeMesh({
    agents: [
      { id: "asker", role: "architect", capabilities: ["review.design"], interests: [] },
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
    ],
    mayContact: { asker: ["dev"], dev: ["asker"] },
    startup: ["asker"],
    waitWakeupMs: 50,
  });
  const s = stub(m);
  let askerTurns = 0;
  s.setScript("asker", async () => {
    askerTurns++;
    if (askerTurns === 1) {
      return { operations: [{ op: "send", type: "REQUEST_REVIEW", to: ["dev"], newThread: { subject: "review v1" }, artifactRefs: [{ uri: "artifact://CodePatch/patch/1" }], payload: {} }, { op: "wait" }] as MeshOp[] };
    }
    return { operations: [{ op: "done" }] as MeshOp[] };
  });
  s.setScript("dev", async () => {
    return { operations: [{ op: "publish_artifact", name: "patch", type: "CodePatch", content: "v1" }, { op: "wait" }] as MeshOp[] };
  });
  await waitFor("ask pending", () => m.kernel.state.pendingRequests.size === 1, 8000);
  const v1 = [...m.kernel.state.artifacts.values()].find((a) => a.name === "patch")!;
  await m.supervisor.createArtifact({ actorId: "dev", name: "patch", type: "CodePatch", content: "v2", asVersionOf: v1.id });
  await waitFor("asker re-woken after supersede", () => askerTurns >= 2, 8000);
  assert.equal(m.kernel.state.agents.get("asker")?.state.lifecycle, "IDLE");
  await m.cleanup();
});
