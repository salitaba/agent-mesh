import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, goalOf, evidenceContent } from "../helpers";
import { Kernel } from "../../packages/core/src/kernel";
import { projectionConfigFor } from "../../packages/core/src/projections";
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

  // A plan, a tick, and a re-plan — three plan.updated events whose reducer is
  // a replace. If a step id or timestamp were ever minted inside the reducer
  // instead of baked into the payload, replay would produce a different plan
  // here and the serializable-views comparison below would catch it.
  s.setScript("dev", async () => ({
    operations: [{ op: "plan", steps: [{ text: "draft the design" }, { text: "review it" }] }, { op: "done" }] as MeshOp[],
  }));
  s.resetTurns("dev");
  await m.supervisor.activateAgent("dev", { kind: "manual" });
  await waitFor("dev planned", () => (m.kernel.state.agents.get("dev")?.state.plan?.steps.length ?? 0) === 2);
  const firstStep = m.kernel.state.agents.get("dev")!.state.plan!.steps[0]!.id;
  s.setScript("dev", async () => ({
    operations: [
      { op: "plan_step", stepId: firstStep, status: "DONE" },
      { op: "plan", steps: [{ text: "draft the design" }, { text: "review it" }, { text: "publish" }] },
      { op: "done" },
    ] as MeshOp[],
  }));
  s.resetTurns("dev");
  await m.supervisor.activateAgent("dev", { kind: "manual" });
  await waitFor("dev re-planned", () => (m.kernel.state.agents.get("dev")?.state.plan?.steps.length ?? 0) === 3);
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
    // The commitment ledger. Every knob that has ever gone missing at a
    // construction site (`commitmentSemantic`, `commitmentTtl`,
    // `contractsByType`) is written by the reducer into THESE rows and
    // nowhere else, so a parity check that omits them cannot see a dropped
    // knob at all.
    pendingRequests: [...st.pendingRequests.entries()].map(([k, v]) => [k, v] as const).sort((a, b) => a[0].localeCompare(b[0])),
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
  // The mesh's WHOLE projection config, not one field of it. This line used to
  // read `{ transitionGates: m.config.transitionGates }`, which meant the live
  // kernel carried four knobs and the rebuild carried one -- so the test that
  // exists to catch live-vs-replay divergence was structurally blind to three
  // of the four ways it can happen, and passed only because this mesh leaves
  // them at their defaults.
  const fresh = new Kernel(new MemoryEventStore(), new FixedClock(), undefined, projectionConfigFor(m.config));
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
  await m.supervisor.transitionArtifact("pm", created.artifact.id, { to: "READY_FOR_REVIEW" });
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

/**
 * A knob that reaches the live kernel and not the replay is a divergence
 * between the log and the state rebuilt from it — the one failure an
 * event-sourced kernel cannot tolerate, because the log is the only truth.
 *
 * It has happened three times, all at the same hand-copied call site, and the
 * test above could not see any of it: it passed one of four knobs to the
 * comparison kernel and compared views that did not include the ledger those
 * knobs write into. The negative control at the end of this test is the point
 * of it — it asserts the parity check can still FAIL, which is the only
 * evidence that it is checking anything.
 */
test("replay: a mesh with every projection knob set rebuilds its ledger identically", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "lead", role: "lead", authority: ["architecture.approve"], interests: [] },
    ],
    mayContact: { dev: ["lead"], lead: ["dev"] },
    mode: "parked",
    bus: { commitments: { semantic: "strict", ttlMs: 60_000, byType: true } },
  });
  const turn = { turnId: "t-replay", agentId: "dev", reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] };
  await m.supervisor.executeOp(
    "dev",
    { op: "send", type: "REQUEST_INFO", to: ["lead"], newThread: { subject: "which cache?" }, payload: { question: "which cache?" } } as MeshOp,
    turn as never,
  );

  // The fixture has to actually exercise the knobs, or the parity below is a
  // comparison of two empty ledgers. `contract` comes from `contractsByType`
  // and `dueBy` from `commitmentTtl`; both are stamped by the reducer at open
  // time, which is why neither survives a replay that lacks them.
  const ask = [...m.kernel.state.pendingRequests.values()][0];
  assert.ok(ask, "fixture must open a real ask");
  assert.equal(ask!.contract, "info.question", "by_type must have governed this ask");
  assert.ok(ask!.dueBy, "commitmentTtl must have deadlined this ask");

  // Budgets are excluded here, and only here, for a reason that is a property
  // of the system rather than of this test: `BudgetManager.declare` calls
  // `ensureBudget` straight against kernel state and emits nothing, so a
  // declared-but-untouched budget line is not in the log to be replayed. The
  // suite above compares them because its trail runs real turns and every
  // declared line is then consumed, which puts it in the log; this fixture is
  // parked and consumes nothing. The ledger, which is what this test is about,
  // is compared in full.
  const ledgerViews = (k: Kernel) => { const { budgets: _budgets, ...rest } = serializableViews(k); return rest; };

  const events = (await m.store.read()) as MeshEvent[];
  const faithful = new Kernel(new MemoryEventStore(), new FixedClock(), undefined, projectionConfigFor(m.config));
  await faithful.rebuild(events);
  assert.deepEqual(ledgerViews(faithful), ledgerViews(m.kernel), "same log + same projection config must rebuild the same state");

  // Negative control: exactly the config this suite used to hand the
  // comparison kernel. If this ever stops diverging, the parity check above
  // has gone blind again and is passing for the wrong reason.
  const partial = new Kernel(new MemoryEventStore(), new FixedClock(), undefined, { transitionGates: m.config.transitionGates });
  await partial.rebuild(events);
  assert.notDeepEqual(
    ledgerViews(partial),
    ledgerViews(m.kernel),
    "a rebuild missing three of four knobs must NOT match the live mesh — if it does, this test proves nothing",
  );
  await m.cleanup();
});

test("replay: the live kernel and the replay path read the same projection config", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] }],
    mayContact: { dev: [] },
    bus: { commitments: { semantic: "strict", ttlMs: 30_000, byType: true } },
  });
  // Both sides call `projectionConfigFor` today, so this holds by construction
  // — that is the fix, not the test. It stays as a regression guard on the two
  // call sites: it fails the moment either end goes back to hand-copying the
  // knob list and drops one, which is how all three previous defects shipped.
  assert.deepEqual(m.kernel.gates, m.supervisor.projectionConfig(), "live gates and replay config must not drift");
  assert.equal(m.kernel.gates?.contractsByType, true, "and must carry what the mesh actually configured");
  await m.cleanup();
});
