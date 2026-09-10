import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, goalOf, eventTypes, evidenceContent } from "../helpers";
import { TerminationManager, DeadlockDetector } from "../../packages/core/src/termination";
import type { MeshOp } from "../../packages/protocol/src/index";
import type { MeshInstance } from "../../apps/mesh-server/src/index";

/**
 * Walk an agent to WAITING through the legal lifecycle path. Layer 4 rejects
 * a direct STARTING -> WAITING jump, which is the point: tests must reach the
 * state the same way a real turn does.
 */
async function park(m: MeshInstance, agentId: string): Promise<void> {
  for (const to of ["IDLE", "AWAKENED", "OBSERVING", "THINKING", "WAITING"]) {
    await m.kernel.emit("agent.state_changed", { agentId, to }, { actorId: agentId });
  }
}

test("termination: successful completion needs every mandatory criterion evidenced", async () => {
  const m = await makeMesh({
    agents: [{ id: "pm", role: "pm", authority: ["requirements.accept"], interests: [] }],
    criteria: [
      { id: "c1", description: "one", mandatory: true },
      { id: "c2", description: "two", mandatory: true },
    ],
  });
  const created = await m.supervisor.createArtifact({ actorId: "pm", name: "e1", type: "ADR", content: evidenceContent("e1 decision record") });
  if (!("artifact" in created)) throw new Error("artifact failed");
  await m.supervisor.transitionArtifact("pm", created.artifact.id, { to: "READY_FOR_REVIEW" });
  await m.supervisor.recordDecision("pm", "accept", "criterion:c1", created.artifact.id);
  await new Promise((r) => setTimeout(r, 200));
  assert.notEqual(goalOf(m)?.status, "COMPLETED", "must not complete with only one criterion");
  await m.supervisor.recordDecision("pm", "accept", "criterion:c2", created.artifact.id);
  await waitFor("completed", () => goalOf(m)?.status === "COMPLETED", 5000);
  assert.ok(eventTypes(await m.store.read()).includes("goal.completed"));
  await m.cleanup();
});

test("termination: the completion sweep retires a parked (WAITING) agent, not just idle ones", async () => {
  // A WAITING agent is idle-with-a-debt, not busy. If the sweep cannot retire
  // it, the mesh reports a completed mission while pm/qa/security sit in
  // WAITING forever — the projection refuses `agent.completed` and the
  // rejection is swallowed, so nothing in the mission view says why.
  const m = await makeMesh({
    agents: [
      { id: "pm", role: "pm", authority: ["requirements.accept"], interests: [] },
      { id: "qa", role: "qa", interests: [] },
    ],
    criteria: [{ id: "c1", description: "one", mandatory: true }],
  });
  await park(m, "qa");
  assert.equal(m.kernel.state.agents.get("qa")?.state.lifecycle, "WAITING");

  const created = await m.supervisor.createArtifact({ actorId: "pm", name: "e1", type: "ADR", content: evidenceContent("e1 decision record") });
  if (!("artifact" in created)) throw new Error("artifact failed");
  await m.supervisor.transitionArtifact("pm", created.artifact.id, { to: "READY_FOR_REVIEW" });
  await m.supervisor.recordDecision("pm", "accept", "criterion:c1", created.artifact.id);
  await waitFor("completed", () => goalOf(m)?.status === "COMPLETED", 5000);
  await waitFor("qa retired", () => m.kernel.state.agents.get("qa")?.state.lifecycle === "COMPLETED", 5000);
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

test("termination: an abandoned CLAIMED task is residue, a live one still holds the mission open", () => {
  // Every mandatory criterion evidenced, no open escalations: only work
  // somebody is really doing may block completion.
  const evidencedGoal = {
    id: "g",
    status: "ACTIVE",
    acceptanceCriteria: [{ id: "c1", mandatory: true, status: "EVIDENCED", evidence: [{ kind: "approval", recordedAt: "2026-01-01T00:00:00.000Z" }] }],
  };
  const baseState = (tasks: unknown[], activeTaskId: string | undefined) =>
    ({
      activeGoalId: "g",
      goals: new Map([["g", evidencedGoal]]),
      budgets: new Map(),
      threads: new Map(),
      agents: new Map([["developer", { state: { agentId: "developer", lifecycle: "IDLE", activeTaskId } }]]),
      eventsSinceActivation: new Map(),
      escalations: new Map(),
      tasks: new Map((tasks as Array<{ id: string }>).map((t) => [t.id, t])),
      pendingRequests: new Map(),
      eventCount: 1,
    }) as never;
  const config = { budgets: { mission: { tokens: 100000, wallClockMinutes: 600, maxEvents: 100000 } } } as never;
  const task = { id: "task-1", status: "CLAIMED", claimedBy: "developer" };

  // Owner is on it: still real work.
  assert.equal(new TerminationManager().evaluate({ state: baseState([task], "task-1"), config, wallClockMs: 1000 }).kind, "continue");

  // Owner moved on to another ticket (activeTaskId only tracks the LAST
  // claim, so task-1 is stranded with nobody holding it). One live mission
  // sat at 16/16 criteria for 90 minutes on exactly this, with the stall
  // watchdog nudging agents that had nothing to do.
  assert.equal(new TerminationManager().evaluate({ state: baseState([task], "task-2"), config, wallClockMs: 1000 }).kind, "complete");

  // Owner is gone entirely: also residue.
  assert.equal(
    new TerminationManager().evaluate({ state: baseState([{ ...task, claimedBy: "ghost" }], "task-1"), config, wallClockMs: 1000 }).kind,
    "complete",
  );
});

test("termination: all five mechanisms are represented in the manager", () => {
  const m = new TerminationManager();
  assert.equal(typeof m.evaluate, "function");
});

test("caps: goal.budget_changed raises the cap and termination honors it", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", interests: [], capabilities: ["repository.write"] }],
    mayContact: { dev: [] },
    maxEvents: 10,
  });
  const goalId = m.kernel.state.activeGoalId!;
  const before = goalOf(m)!.budget.maxEvents;
  assert.equal(before, 10);

  // Validation: unknown goal, non-raises, and empty patches are refused.
  assert.equal((await m.supervisor.adjustGoalBudget({ maxEvents: 5 })).ok, false);
  assert.equal((await m.supervisor.adjustGoalBudget({})).ok, false);
  assert.equal((await m.supervisor.adjustGoalBudget({ wallClockMinutes: -1 })).ok, false);

  const r = await m.supervisor.adjustGoalBudget({ maxEvents: 100 });
  assert.equal(r.ok, true);
  assert.equal(goalOf(m)!.budget.maxEvents, 100);
  assert.ok(eventTypes(await m.store.read()).includes("goal.budget_changed"), "raise must be an event");

  // Termination reads the goal budget, not boot config: over the old cap but
  // under the raised one → continue.
  const verdict = new TerminationManager().evaluate({
    state: { ...m.kernel.state, eventCount: 50 } as never,
    config: m.config,
    wallClockMs: 1000,
  });
  assert.equal(verdict.kind, "continue");
  await m.cleanup();
});

test("caps: POST /mission/limits validates and raises", async () => {
  const { createHttpServer } = await import("../../apps/mesh-server/src/index");
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", interests: [] }],
    mayContact: { dev: [] },
  });
  const server = createHttpServer(m, { dashboardDir: undefined });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = async (body: unknown) => {
    const res = await fetch(`${base}/mission/limits`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as { ok: boolean; reason?: string; budget?: { maxEvents: number } } };
  };
  try {
    assert.equal((await call({})).status, 400);
    assert.equal((await call({ maxEvents: 1 })).status, 400);
    const good = await call({ maxEvents: 200000 });
    assert.equal(good.status, 200);
    assert.equal(good.json.ok, true);
    assert.equal(good.json.budget?.maxEvents, 200000);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await m.cleanup();
  }
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

test("deadlock: a resolved finding is forgotten, so a recurrence escalates again", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", interests: [], capabilities: ["repository.write"] }],
    mayContact: { dev: [] },
  });
  const state = m.kernel.state;
  const { bumpConflict } = await import("../../packages/core/src/projections");
  const detector = new DeadlockDetector(m.config);
  const ts = new Date().toISOString();

  for (let i = 0; i < 3; i++) bumpConflict(state, "conflict:dev:flap", "dev", ts);
  const first = detector.scan(state).filter((f) => f.conflictKey === "conflict:dev:flap");
  assert.equal(first.length, 1, "the conflict must be reported once");
  for (const f of first) detector.markReported(f);
  assert.equal(detector.scan(state).filter((f) => f.conflictKey === "conflict:dev:flap").length, 0, "an already-reported finding must not repeat");

  // Operator/agents resolve it: the underlying condition disappears.
  state.conflicts.delete("conflict:dev:flap");
  assert.equal(detector.scan(state).filter((f) => f.conflictKey === "conflict:dev:flap").length, 0, "a cleared condition reports nothing");

  // It comes back. Previously `reported` was never pruned (clear() matched no
  // real key), so this recurrence stayed invisible for the process lifetime.
  for (let i = 0; i < 3; i++) bumpConflict(state, "conflict:dev:flap", "dev", ts);
  assert.equal(
    detector.scan(state).filter((f) => f.conflictKey === "conflict:dev:flap").length,
    1,
    "a recurrence after a genuine fix must escalate again",
  );
  await m.cleanup();
});

test("deadlock: clear(goalId) actually forgets that goal's findings", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", interests: [] }],
    mayContact: { dev: [] },
  });
  const state = m.kernel.state;
  const { bumpConflict } = await import("../../packages/core/src/projections");
  const detector = new DeadlockDetector(m.config);
  for (let i = 0; i < 3; i++) bumpConflict(state, "conflict:dev:persist", "dev", new Date().toISOString());
  for (const f of detector.scan(state)) detector.markReported(f);
  assert.equal(detector.scan(state).length, 0, "reported findings are suppressed");
  detector.clear(state.activeGoalId!);
  assert.ok(
    detector.scan(state).some((f) => f.conflictKey === "conflict:dev:persist"),
    "clear() must drop this goal's memory (real keys carry no goalId, so endsWith never matched)",
  );
  await m.cleanup();
});

test("deadlock: circular wait between two agents is detected exactly, without nudge rounds", async () => {
  const m = await makeMesh({
    agents: [
      { id: "architect", role: "architect", interests: [], capabilities: ["repository.read"] },
      { id: "dev", role: "developer", interests: [], capabilities: ["repository.read"] },
    ],
    mayContact: { architect: ["dev"], dev: ["architect"] },
    mode: "parked",
  });
  const state = m.kernel.state;
  const detector = new DeadlockDetector(m.config);

  // architect asks dev, dev asks architect; both then park on the answer.
  const a = await m.supervisor.sendMessage({ from: "architect", to: ["dev"], type: "REQUEST", newThread: { subject: "which db?" }, payload: { question: "which db?" } });
  const b = await m.supervisor.sendMessage({ from: "dev", to: ["architect"], type: "REQUEST", newThread: { subject: "which schema?" }, payload: { question: "which schema?" } });
  assert.ok(a.accepted && b.accepted, "both requests must be accepted");

  // While both are still working, an outstanding request is normal business.
  assert.equal(detector.scan(state).filter((f) => f.kind === "wait_cycle").length, 0, "open requests alone are not a deadlock");

  for (const id of ["architect", "dev"]) await park(m, id);
  const cycles = detector.scan(state).filter((f) => f.kind === "wait_cycle");
  assert.equal(cycles.length, 1, "the cycle must be reported exactly once, not once per participant");
  assert.deepEqual([...cycles[0].participants].sort(), ["architect", "dev"]);
  await m.cleanup();
});

test("deadlock: a circular wait resolves itself instead of freezing the whole mission", async () => {
  const m = await makeMesh({
    agents: [
      { id: "architect", role: "architect", interests: [], capabilities: ["repository.read"] },
      { id: "dev", role: "developer", interests: [], capabilities: ["repository.read"] },
      { id: "qa", role: "qa", interests: [], capabilities: ["test.execute"] },
    ],
    mayContact: { architect: ["dev"], dev: ["architect"], qa: [] },
    mode: "parked",
  });
  const state = m.kernel.state;
  const older = await m.supervisor.sendMessage({ from: "architect", to: ["dev"], type: "REQUEST", newThread: { subject: "which db?" }, payload: {} });
  await new Promise((r) => setTimeout(r, 5));
  const newer = await m.supervisor.sendMessage({ from: "dev", to: ["architect"], type: "REQUEST", newThread: { subject: "which schema?" }, payload: {} });
  for (const id of ["architect", "dev"]) await park(m, id);

  await m.supervisor.forceWatchdog();

  // The runtime settles the ring itself: no operator card, mission stays live.
  assert.equal(goalOf(m)?.status, "ACTIVE", "a self-resolvable deadlock must not freeze the mission");
  assert.equal(
    [...state.escalations.values()].filter((e) => e.status === "OPEN" && e.reason.startsWith("deadlock:")).length,
    0,
    "no operator escalation for a cycle the runtime can break",
  );
  // Newest ask is voided; the older, more load-bearing one survives.
  assert.equal(state.pendingRequests.has(newer.messageId!), false, "the newest ask in the cycle is voided");
  assert.equal(state.pendingRequests.has(older.messageId!), true, "the older ask must survive");
  const types = eventTypes(await m.store.read());
  assert.ok(types.includes("deadlock.auto_resolved"), "the runtime's decision must be recorded in the log");
  // qa was never in the cycle and must be untouched by the resolution.
  assert.equal(state.agents.get("qa")?.state.lifecycle, "STARTING", "uninvolved agents are not disturbed");
  await m.cleanup();
});

test("deadlock: a waiting chain that terminates is not a false positive", async () => {
  const m = await makeMesh({
    agents: [
      { id: "pm", role: "pm", interests: [] },
      { id: "architect", role: "architect", interests: [] },
      { id: "dev", role: "developer", interests: [] },
    ],
    mayContact: { pm: ["architect"], architect: ["dev"], dev: [] },
    mode: "parked",
  });
  const state = m.kernel.state;
  const detector = new DeadlockDetector(m.config);
  await m.supervisor.sendMessage({ from: "pm", to: ["architect"], type: "REQUEST", newThread: { subject: "s1" }, payload: {} });
  await m.supervisor.sendMessage({ from: "architect", to: ["dev"], type: "REQUEST", newThread: { subject: "s2" }, payload: {} });
  for (const id of ["pm", "architect"]) await park(m, id);
  // pm -> architect -> dev, and dev owes nobody: dev can still act, so the
  // chain resolves itself. Flagging this would park a healthy mission.
  assert.equal(detector.scan(state).filter((f) => f.kind === "wait_cycle").length, 0, "an acyclic wait chain is not a deadlock");
  await m.cleanup();
});

test("reopen: progress is recomputed from criteria, not frozen at the last goal.progress event", async () => {
  const m = await makeMesh({
    agents: [{ id: "pm", role: "product-manager", authority: ["requirements.accept"], interests: [] }],
    criteria: [
      { id: "c1", description: "one", mandatory: true },
      { id: "c2", description: "two", mandatory: true },
    ],
    mode: "parked",
  });
  const goalId = m.kernel.state.activeGoalId!;
  const created = await m.supervisor.createArtifact({ actorId: "pm", name: "e1", type: "ADR", content: evidenceContent("e1 decision record") });
  if (!("artifact" in created)) throw new Error("artifact failed");
  await m.supervisor.transitionArtifact("pm", created.artifact.id, { to: "READY_FOR_REVIEW" });
  await m.supervisor.recordDecision("pm", "accept", "criterion:c1", created.artifact.id);
  await m.supervisor.recordDecision("pm", "accept", "criterion:c2", created.artifact.id);
  await waitFor("completed", () => goalOf(m)?.status === "COMPLETED", 5000);
  assert.deepEqual(
    { c: m.kernel.state.progress.get(goalId)?.completed, r: m.kernel.state.progress.get(goalId)?.ratio },
    { c: 2, r: 1 },
    "a finished mission reports 2/2",
  );

  await m.supervisor.reopenGoal({ reason: "I want the best app, not an MVP" });

  const goal = goalOf(m)!;
  const mandatory = goal.acceptanceCriteria.filter((c) => c.mandatory);
  const evidenced = mandatory.filter((c) => c.status === "EVIDENCED" || c.status === "WAIVED");
  const prog = m.kernel.state.progress.get(goalId)!;
  // The bug: reopen emits no goal.progress, so the projection kept saying
  // 2/2 ratio 1 while every mandatory criterion had just been reset. The
  // dashboard showed a 100% mission that had actually restarted at zero.
  assert.equal(evidenced.length, 0, "reopen resets every mandatory criterion");
  assert.equal(prog.completed, 0, "progress must follow the criteria down, not stay at the old count");
  assert.equal(prog.ratio, 0, "ratio must not report a reopened mission as finished");
  assert.equal(prog.total, mandatory.length, "total counts the minted criterion too");
  await m.cleanup();
});

test("reopen: the operator's reason becomes a mandatory criterion and an ask on the requirements owner", async () => {
  const m = await makeMesh({
    agents: [
      { id: "pm", role: "product-manager", authority: ["requirements.accept"], interests: [] },
      { id: "dev", role: "developer", interests: [] },
    ],
    mayContact: { pm: ["dev"], dev: ["pm"] },
    criteria: [{ id: "c1", description: "one", mandatory: true }],
    mode: "parked",
  });
  const created = await m.supervisor.createArtifact({ actorId: "pm", name: "e1", type: "ADR", content: evidenceContent("e1 decision record") });
  if (!("artifact" in created)) throw new Error("artifact failed");
  await m.supervisor.transitionArtifact("pm", created.artifact.id, { to: "READY_FOR_REVIEW" });
  await m.supervisor.recordDecision("pm", "accept", "criterion:c1", created.artifact.id);
  await waitFor("completed", () => goalOf(m)?.status === "COMPLETED", 5000);

  const reason = "I want the best app, not an MVP";
  const res = await m.supervisor.reopenGoal({ reason });

  // 1. The intent is a criterion, so it blocks completion and shows up in
  //    every agent's context. Free text on an event payload did neither.
  const minted = goalOf(m)!.acceptanceCriteria.filter((c) => c.description.includes(reason));
  assert.equal(minted.length, 1, "the reopen reason must become exactly one criterion");
  assert.equal(minted[0].mandatory, true, "operator feedback is mandatory, not advisory");
  assert.equal(minted[0].status, "UNSATISFIED");
  assert.deepEqual(res.addedCriteria, [minted[0].id]);

  // 2. And it is addressed to someone: a criterion names WHAT, an ask names WHO.
  assert.equal(res.feedbackTo, "pm", "the requirements owner gets the feedback");
  const mail = [...(m.kernel.state.unread.get("pm") ?? [])].map((id) => m.kernel.state.messages.get(id));
  assert.ok(
    mail.some((msg) => msg?.from === "human" && JSON.stringify(msg.payload).includes(reason)),
    "pm must receive the operator's words verbatim",
  );

  // 3. Reopening twice for the same reason must not grow the criteria list.
  await m.supervisor.reopenGoal({ reason });
  assert.equal(
    goalOf(m)!.acceptanceCriteria.filter((c) => c.description.includes(reason)).length,
    1,
    "the same feedback must reuse its criterion, not stack duplicates",
  );
  await m.cleanup();
});

test("budgets: an exhausted thread budget auto-raises under the ceiling instead of escalating", async () => {
  const m = await makeMesh({
    agents: [{ id: "a1", role: "a1", capabilities: [], interests: [] }],
    mayContact: { a1: [] },
    mode: "parked",
    // Must exceed TURN_RESERVE_TOKENS (32k) once raised, or the raise is real
    // but still cannot admit the turn — which is honest behaviour, just not
    // what this test is about.
    threadTokens: 50000,
    autoRaise: { enabled: true, factor: 2, maxMultiple: 4 },
  });
  const goalId = m.kernel.state.activeGoalId!;
  const key = `thread:${goalId}/t1`;
  await m.supervisor.deps.budget.consume(key, "tokens", 50000);

  const r = await m.supervisor.activateAgent("a1", { kind: "manual", threadId: "t1" });
  assert.equal(r.queued, true);
  await waitFor("turn settled", () => m.supervisor.getRecentTurns(5).some((t) => t.agentId === "a1" && t.status !== "running"), 5000);

  const ledger = m.kernel.state.budgets.get(key)!;
  // Ceiling is 4 x 1000. The raise must clear the turn's reservation in one
  // step, not hand back a limit the very next reserve blocks on again.
  assert.ok(ledger.limit! > 50000, `thread limit must be raised, still ${ledger.limit}`);
  assert.ok(ledger.limit! <= 200000, `auto-raise must respect the ceiling, got ${ledger.limit}`);
  const types = eventTypes(await m.store.read());
  assert.ok(types.includes("budget.limit_raised"), "the raise must be in the log, so replay reproduces it");
  assert.equal(
    [...m.kernel.state.escalations.values()].some((e) => e.reason === "thread_budget_exhausted"),
    false,
    "a raise under the ceiling must not spend the operator's attention",
  );
  await m.cleanup();
});

/**
 * The verification gate.
 *
 * A live mission ran 138 turns with `toolCalls: 0` on EVERY one, published
 * TestReports claiming determinism evidence, merged patches, ticked all 16
 * mandatory criteria and closed as complete — without a single tool
 * invocation. Nothing had been read, run or checked; the "evidence" was the
 * agents' own word. A claim made from a turn that verified nothing is now
 * recorded as ASSERTED, which nothing counts as done.
 */
async function acceptCriterionFromTurn(
  // Explicit on purpose: `undefined` would take the stub's default of one
  // synthetic work call (see StubTurn.toolCalls), which is the opposite of
  // what these tests exercise.
  toolCalls: Array<{ name: string; args: unknown; resultDigest: string }>,
): Promise<{ mesh: MeshInstance & { cleanup(): Promise<void> }; status: string }> {
  const m = await makeMesh({
    agents: [{ id: "pm", role: "product-manager", authority: ["requirements.accept"], interests: [] }],
    mayContact: { pm: [] },
    criteria: [{ id: "c1", description: "one", mandatory: true }],
    mode: "parked",
  });
  const created = await m.supervisor.createArtifact({ actorId: "pm", name: "e1", type: "ADR", content: evidenceContent("e1 decision record") });
  if (!("artifact" in created)) throw new Error("artifact failed");
  await m.supervisor.transitionArtifact("pm", created.artifact.id, { to: "READY_FOR_REVIEW" });
  stub(m).setScript("pm", [
    {
      toolCalls,
      operations: [{ op: "approve", subject: "criterion:c1", artifactId: created.artifact.id, comment: "done" } as MeshOp],
    },
  ]);
  await m.supervisor.activateAgent("pm", { kind: "manual" });
  await waitFor("turn settled", () => m.supervisor.getRecentTurns(5).some((t) => t.agentId === "pm" && t.status !== "running"), 5000);
  return { mesh: m, status: goalOf(m)!.acceptanceCriteria.find((c) => c.id === "c1")!.status };
}

test("verification: a criterion accepted by a turn that invoked no tool is ASSERTED, not EVIDENCED", async () => {
  const { mesh: m, status } = await acceptCriterionFromTurn([]);
  assert.equal(status, "ASSERTED", "zero tool calls means the agent checked nothing — that is a claim, not evidence");

  // And the mission stays open on it: this is the whole point. The gate that
  // only counted EVIDENCED is what let the shell mission close.
  await new Promise((r) => setTimeout(r, 300));
  assert.notEqual(goalOf(m)!.status, "COMPLETED", "an unverified claim must not complete the mission");
  const goalId = m.kernel.state.activeGoalId!;
  assert.equal(m.kernel.state.progress.get(goalId)!.completed, 0, "ASSERTED does not count toward progress");

  // The agent has to SEE it, or it reports success and goes idle forever.
  const turn = m.supervisor.getRecentTurns(5).find((t) => t.agentId === "pm")!;
  assert.match(String(turn.summary ?? ""), /ASSERTED/, "the downgrade must ride the turn summary into the agent's memory");
  await m.cleanup();
});

test("verification: a criterion accepted by a turn that ran a real tool is EVIDENCED and completes", async () => {
  const { mesh: m, status } = await acceptCriterionFromTurn([{ name: "bash", args: { cmd: "npm test" }, resultDigest: "d1" }]);
  assert.equal(status, "EVIDENCED", "a turn that actually ran something produces evidence");
  await waitFor("completed", () => goalOf(m)?.status === "COMPLETED", 5000);
  await m.cleanup();
});

test("verification: mesh_* bus calls are not verification — they are how a turn talks, not how it checks", async () => {
  // Otherwise the gate is self-satisfying: "I called mesh_approve, therefore
  // I verified it". Only tools that touch the world outside the mesh can
  // tell a check from a claim.
  const { mesh: m, status } = await acceptCriterionFromTurn([
    { name: "mesh_approve", args: {}, resultDigest: "d1" },
    { name: "mesh_artifact_read", args: {}, resultDigest: "d2" },
  ]);
  assert.equal(status, "ASSERTED", "issuing bus ops is not verifying anything");
  await m.cleanup();
});

test("verification: an ASSERTED mandatory criterion does not satisfy termination", () => {
  const goal = (status: string) => ({
    id: "g",
    status: "ACTIVE",
    acceptanceCriteria: [{ id: "c1", mandatory: true, status, evidence: [{ kind: "criteria-acceptance", recordedAt: "2026-01-01T00:00:00.000Z" }] }],
  });
  const state = (status: string) =>
    ({
      activeGoalId: "g",
      goals: new Map([["g", goal(status)]]),
      budgets: new Map(),
      threads: new Map(),
      agents: new Map(),
      eventsSinceActivation: new Map(),
      escalations: new Map(),
      tasks: new Map(),
      pendingRequests: new Map(),
      eventCount: 1,
    }) as never;
  const config = { budgets: { mission: { tokens: 100000, wallClockMinutes: 600, maxEvents: 100000 } } } as never;
  assert.equal(new TerminationManager().evaluate({ state: state("ASSERTED"), config, wallClockMs: 1000 }).kind, "continue");
  assert.equal(new TerminationManager().evaluate({ state: state("EVIDENCED"), config, wallClockMs: 1000 }).kind, "complete");
});

test("budgets: auto-raise stops at the ceiling and escalates there", async () => {
  const m = await makeMesh({
    agents: [{ id: "a1", role: "a1", capabilities: [], interests: [] }],
    mayContact: { a1: [] },
    mode: "parked",
    threadTokens: 1000,
    // Ceiling == original limit: there is no headroom to grant, so the very
    // first exhaustion is already at the wall.
    autoRaise: { enabled: true, factor: 2, maxMultiple: 1 },
  });
  const goalId = m.kernel.state.activeGoalId!;
  const key = `thread:${goalId}/t1`;
  await m.supervisor.deps.budget.consume(key, "tokens", 1000);

  const r = await m.supervisor.activateAgent("a1", { kind: "manual", threadId: "t1" });
  assert.equal(r.queued, true);
  await waitFor("blocked turn", () => m.supervisor.getRecentTurns(5).some((t) => t.agentId === "a1" && t.status === "blocked"), 5000);

  assert.equal(m.kernel.state.budgets.get(key)!.limit, 1000, "at the ceiling the limit must not move");
  assert.ok(
    [...m.kernel.state.escalations.values()].some((e) => e.reason === "thread_budget_exhausted"),
    "at the ceiling the human IS the right answer",
  );
  await m.cleanup();
});
