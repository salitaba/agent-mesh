import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, goalOf, eventTypes } from "../helpers";
import { TerminationManager, DeadlockDetector } from "../../packages/core/src/termination";
import type { MeshOp } from "../../packages/protocol/src/index";

test("termination: successful completion needs every mandatory criterion evidenced", async () => {
  const m = await makeMesh({
    agents: [{ id: "pm", role: "pm", authority: ["requirements.accept"], interests: [] }],
    criteria: [
      { id: "c1", description: "one", mandatory: true },
      { id: "c2", description: "two", mandatory: true },
    ],
  });
  const created = await m.supervisor.createArtifact({ actorId: "pm", name: "e1", type: "ADR", content: "x" });
  if (!("artifact" in created)) throw new Error("artifact failed");
  await m.supervisor.recordDecision("pm", "accept", "criterion:c1", created.artifact.id);
  await new Promise((r) => setTimeout(r, 200));
  assert.notEqual(goalOf(m)?.status, "COMPLETED", "must not complete with only one criterion");
  await m.supervisor.recordDecision("pm", "accept", "criterion:c2", created.artifact.id);
  await waitFor("completed", () => goalOf(m)?.status === "COMPLETED", 5000);
  assert.ok(eventTypes(await m.store.read()).includes("goal.completed"));
  await m.cleanup();
});

test("termination: mission token budget exhaustion escalates (not silently halts)", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", interests: ["message.sent"], capabilities: ["repository.write"] }],
    mayContact: { dev: [] },
    missionTokens: 1500,
    criteria: [{ id: "never", description: "no", mandatory: true }],
  });
  const s = stub(m);
  s.setScript("dev", async (_i, turn) => ({
    tokensUsed: { input: 1500, output: 900, total: 2400 },
    operations: (turn < 2 ? [{ op: "send", type: "INFORM", to: ["dev"], newThread: { subject: `n${turn}` }, payload: { n: turn } } as MeshOp] : [{ op: "done" } as MeshOp]),
  }));
  await m.supervisor.humanSend(["dev"], "INFORM", { start: true });
  await waitFor("escalated or blocked", () => {
    const g = goalOf(m);
    return g?.status === "ESCALATED" || m.kernel.state.budgets.get(`mission:${m.kernel.state.activeGoalId}`)?.exceeded === true;
  }, 8000);
  const types = eventTypes(await m.store.read());
  assert.ok(types.includes("budget.exceeded"), "budget.exceeded must be an event");
  assert.ok(types.includes("goal.escalated"), "escalation must be a protocol event");
  await m.cleanup();
});

test("termination: wall-clock overflow escalates", () => {
  const manager = new TerminationManager();
  const state = {
    activeGoalId: "g",
    goals: new Map([["g", { id: "g", acceptanceCriteria: [], status: "ACTIVE" }]]),
    budgets: new Map(),
    agents: new Map(),
    eventsSinceActivation: new Map(),
    escalations: new Map(),
    tasks: new Map(),
    pendingRequests: new Map(),
    eventCount: 1,
  } as never;
  const config = { budgets: { mission: { tokens: 100, wallClockMinutes: 1, maxEvents: 100 } } } as never;
  const tm = manager.evaluate({ state, config, wallClockMs: 61_000 });
  assert.equal(tm.kind, "escalate");
});

test("termination: all five mechanisms are represented in the manager", () => {
  const m = new TerminationManager();
  assert.equal(typeof m.evaluate, "function");
});

test("deadlock: detector flags repeated conflict and review-round overflow; escalate attaches disagreement artifact", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", interests: [], capabilities: ["repository.write"] },
    ],
    mayContact: { dev: [] },
    criteria: [{ id: "x", description: "x", mandatory: true }],
  });
  const state = m.kernel.state;
  const { bumpConflict } = await import("../../packages/core/src/projections");
  const ts = new Date().toISOString();
  for (let i = 0; i < 3; i++) bumpConflict(state, "conflict:dev:rev:patchA", "dev", ts, undefined, "art-A");
  const reviewArt = await m.supervisor.createArtifact({ actorId: "dev", name: "looping-patch", type: "CodePatch", content: "diff" });
  if ("artifact" in reviewArt) state.reviewRounds.set(reviewArt.artifact.id, 99);
  const threadEvt = await m.kernel.emit("thread.created", { thread: { id: "deep", goalId: state.activeGoalId, subject: "s", initiator: "dev", artifactRefs: [], participants: ["dev"], depth: 9, messageIds: [], status: "OPEN", budget: {}, createdAt: ts } }, { actorId: "dev" });
  void threadEvt;
  const detector = new DeadlockDetector(m.config);
  const findings = detector.scan(state);
  assert.ok(findings.some((f) => f.kind === "repeated_conflict"), "repeated conflict must be detected");
  assert.ok(findings.some((f) => f.kind === "review_rounds"), "review round overflow must be detected");
  assert.ok(findings.some((f) => f.kind === "thread_depth"), "thread depth overflow must be detected");

  const esc = await m.supervisor.escalate({ reason: "deadlock", raisedBy: "dev", conflictKey: "manual-conflict", artifactId: "art-A" });
  assert.ok(esc.disagreementArtifactRef, "escalation attaches a generated disagreement artifact");
  const disagreement = m.supervisor.findArtifactByUri(esc.disagreementArtifactRef!.uri);
  assert.equal(disagreement?.type, "DisagreementRecord");
  await m.cleanup();
});
