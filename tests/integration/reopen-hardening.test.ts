import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, waitFor, stub, goalOf } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * Task B regression suite: reopening a finished mission must actually put it
 * back to work. Every test here maps to one of findings 8-11 from the
 * post-completion revive diagnosis — each is a way a reopen returned `ok: true`
 * while guaranteeing that not one turn would ever run.
 */

async function completedMesh(opts: { onTurn?: () => void } = {}) {
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
    stub(m).setScript(id, async () => {
      opts.onTurn?.();
      return { operations: [{ op: "done" } as MeshOp] };
    });
  }
  return m;
}

/**
 * Drive the mission to COMPLETED exactly the way the watchdog does: emit the
 * verdict, then run the real `completeMission()` (which sweeps idle agents to
 * COMPLETED and shuts the scheduler down). It is private because nothing in
 * production may call it but the watchdog — the cast is the test reaching for
 * the real path rather than re-implementing a lookalike that could drift.
 */
async function completeIt(m: Awaited<ReturnType<typeof completedMesh>>) {
  const gid = m.kernel.state.activeGoalId!;
  // A parked mesh never started its agents, and the completion sweep only
  // freezes IDLE/WAITING ones — so without this the mission completes with
  // nobody at COMPLETED and the revive path under test is never exercised.
  for (const rec of [...m.kernel.state.agents.values()]) {
    if (rec.state.agentId === "human" || rec.state.lifecycle !== "STARTING") continue;
    await m.kernel.emit("agent.started", { agentId: rec.state.agentId }, { actorId: "system" }).catch(() => undefined);
  }
  await m.kernel.emit("goal.completed", { goalId: gid, reason: "test completion", evidence: [] }, { actorId: "human" });
  await (m.supervisor as unknown as { completeMission(): Promise<void> }).completeMission();
  await waitFor("mission completed", () => goalOf(m)?.status === "COMPLETED", 8000);
}

// Finding 8: `kind: "recovery"` maps to explicit:false, so a circuit-breaker
// parked agent is refused at the scheduler and the reopen activates nobody.
test("reopen: activates an agent the circuit breaker had parked (finding 8)", async () => {
  const m = await completedMesh();
  try {
    // Park `dev` behind the circuit breaker: three consecutive bad turns.
    for (let i = 0; i < 3; i++) m.scheduler.noteTurnOutcome("dev", "failed");
    assert.equal(m.scheduler.isParkedForBackoff("dev"), true, "precondition: dev parked for backoff");

    await completeIt(m);
    const r = await m.supervisor.reopenGoal({ reason: "rejected", activate: ["dev"] });

    assert.equal(r.ok, true);
    assert.deepEqual(r.activated, ["dev"], "a reopen carries operator authority past backoff parking");
    assert.equal(r.refused, undefined, "nothing refused");
    assert.equal(r.warning, undefined, "a reopen that woke someone carries no warning");
  } finally {
    await m.cleanup();
  }
});

// Finding 9: the `agent.resumed` emit is catch-swallowed, but the agent was
// pushed into `revived[]` regardless — the operator was told an unreachable
// agent was back.
test("reopen: revived[] lists only agents that actually left COMPLETED (finding 9)", async () => {
  const m = await completedMesh();
  try {
    await completeIt(m);
    const completed = [...m.kernel.state.agents.values()].filter((r) => r.state.lifecycle === "COMPLETED").map((r) => r.state.agentId);
    assert.ok(completed.length > 0, "precondition: some agent froze at COMPLETED");

    // Force the failure this fix exists for. A revive can be refused by the
    // reducer (illegal transition) and the emit is deliberately tolerant, so
    // the ONLY way to tell success from silent failure is to read the
    // lifecycle back. Reject the revive for `qa` specifically and assert the
    // report tells the truth about it.
    const kernel = m.kernel as unknown as { emit: (...args: any[]) => Promise<unknown> };
    const realEmit = kernel.emit.bind(kernel);
    kernel.emit = async (type: string, payload: any, ctx: any) => {
      if (type === "agent.resumed" && payload?.agentId === "qa") throw new Error("simulated illegal transition");
      return realEmit(type, payload, ctx);
    };
    let r: Awaited<ReturnType<typeof m.supervisor.reopenGoal>>;
    try {
      r = await m.supervisor.reopenGoal({ reason: "rejected" });
    } finally {
      kernel.emit = realEmit;
    }

    assert.ok(r.notRevived?.includes("qa"), "a refused revive must be reported as notRevived, not as a success");
    assert.ok(!r.revived?.includes("qa"), "a refused revive must never appear in revived[]");
    assert.match(r.warning ?? "", /.*/);

    for (const id of r.revived ?? []) {
      const lc = m.kernel.state.agents.get(id)!.state.lifecycle;
      assert.notEqual(lc, "COMPLETED", `${id} was reported revived, so it must not still be COMPLETED`);
    }
    for (const id of r.notRevived ?? []) {
      assert.equal(m.kernel.state.agents.get(id)!.state.lifecycle, "COMPLETED", `${id} reported not-revived, so it is still COMPLETED`);
    }
    // And the honest report is actionable: every previously-completed agent is
    // accounted for in exactly one of the two lists.
    const seen = [...(r.revived ?? []), ...(r.notRevived ?? [])].sort();
    assert.deepEqual(seen, [...completed].sort(), "every completed agent is reported one way or the other");
  } finally {
    await m.cleanup();
  }
});

// Finding 10: an ESCALATED mission was stuck between reopen (COMPLETED/FAILED
// only) and resumeGoal (PAUSED only) with no path back to ACTIVE.
test("reopen: an ESCALATED mission has a way back to ACTIVE (finding 10)", async () => {
  const m = await completedMesh();
  try {
    const gid = m.kernel.state.activeGoalId!;
    await m.supervisor.escalate({ reason: "stalemate", raisedBy: "deadlock-detector", detail: {} });
    await m.kernel.emit("goal.escalated", { goalId: gid, reason: "stalemate", detail: {} }, { actorId: "human" });
    await waitFor("mission escalated", () => goalOf(m)?.status === "ESCALATED", 8000);

    const r = await m.supervisor.reopenGoal({ reason: "operator overrules the escalation" });

    assert.equal(r.ok, true, `reopen must accept ESCALATED: ${r.reason ?? ""}`);
    assert.equal(goalOf(m)?.status, "ACTIVE", "mission is back to ACTIVE");
    assert.equal(r.escalationsCleared, true, "the reopen answered the open cards");
    // The cards must be closed, else the next watchdog tick re-derives the
    // stalemate verdict and re-escalates within a second.
    const stillOpen = [...m.kernel.state.escalations.values()].filter((e) => e.status === "OPEN");
    assert.equal(stillOpen.length, 0, `no card may stay OPEN, found: ${stillOpen.map((e) => e.id).join(", ")}`);
  } finally {
    await m.cleanup();
  }
});

// An escalated mission was halted, not judged: it has no rejected verdict, so
// its accepted criteria must survive the reopen.
test("reopen: ESCALATED keeps satisfied criteria; COMPLETED invalidates them", async () => {
  const escalated = await completedMesh();
  try {
    const gid = escalated.kernel.state.activeGoalId!;
    for (const c of goalOf(escalated)!.acceptanceCriteria) c.status = "EVIDENCED";
    await escalated.kernel.emit("goal.escalated", { goalId: gid, reason: "halted", detail: {} }, { actorId: "human" });
    await waitFor("escalated", () => goalOf(escalated)?.status === "ESCALATED", 8000);

    await escalated.supervisor.reopenGoal({ reason: "unblock" });
    assert.equal(
      goalOf(escalated)!.acceptanceCriteria.every((c) => c.status === "EVIDENCED"),
      true,
      "an escalated mission was never judged, so accepted work survives the reopen",
    );
  } finally {
    await escalated.cleanup();
  }

  const done = await completedMesh();
  try {
    for (const c of goalOf(done)!.acceptanceCriteria) c.status = "EVIDENCED";
    await completeIt(done);
    const r = await done.supervisor.reopenGoal({ reason: "result rejected" });
    assert.deepEqual(r.unsatisfied, ["ship"], "a rejected verdict invalidates the mandatory criteria it rested on");
  } finally {
    await done.cleanup();
  }
});

// Finding 11: strikes / nudge / denial counters carried over from the round
// that just ended, so the new round re-parked the very agents the operator was
// trying to reach.
test("reopen: clears the previous round's scheduler counters (finding 11)", async () => {
  const m = await completedMesh();
  try {
    for (let i = 0; i < 3; i++) m.scheduler.noteTurnOutcome("dev", "failed");
    for (let i = 0; i < 3; i++) m.scheduler.noteTurnOutcome("qa", "failed");
    assert.equal(m.scheduler.isParkedForBackoff("dev"), true, "precondition: dev parked");
    assert.equal(m.scheduler.isParkedForBackoff("qa"), true, "precondition: qa parked");

    await completeIt(m);
    await m.supervisor.reopenGoal({ reason: "rejected" });

    assert.equal(m.scheduler.isParkedForBackoff("dev"), false, "backoff parking does not survive a reopen");
    assert.equal(m.scheduler.isParkedForBackoff("qa"), false, "backoff parking does not survive a reopen");
    assert.equal(m.scheduler.isRunning(), true, "the scheduler is running again");
  } finally {
    await m.cleanup();
  }
});

// The composite guarantee the operator actually cares about: after a reopen,
// feedback sent to a previously-completed agent runs a turn.
test("reopen: feedback to a revived agent actually runs a turn", async () => {
  let turns = 0;
  const m = await completedMesh({ onTurn: () => turns++ });
  try {
    await completeIt(m);
    turns = 0;
    const r = await m.supervisor.reopenGoal({ reason: "rejected", activate: ["qa"] });
    assert.equal(r.ok, true);

    await m.supervisor.sendMessage({
      from: "human",
      to: ["qa"],
      type: "INFORM",
      newThread: { subject: "round two" },
      payload: { note: "this is not shippable yet" },
      priority: "URGENT",
    });
    await waitFor("a turn ran after the reopen", () => turns > 0, 8000);
  } finally {
    await m.cleanup();
  }
});

// Finding 12: a recovery restart owed against a stopped scheduler was refused
// at the stopped gate — `agent.restarted` fired, the lifecycle fell to IDLE,
// and the respawn never happened: the subprocess stayed dead behind a
// "restarted, attempt 1" that restarted nothing. The owed restart must
// survive the stop and be served by the reopen that follows.
test("reopen: a recovery owed against a stopped scheduler survives and runs (finding 12)", async () => {
  let turns = 0;
  const m = await completedMesh({ onTurn: () => turns++ });
  try {
    await completeIt(m);
    turns = 0;
    // Reproduce the wedge: a failure landing after the completion sweep leaves
    // the agent at IDLE (agent.restarted) while the scheduler is already
    // stopped and the sweep visit that would have frozen it COMPLETED has
    // passed. agent.resumed is the legal edge back out of COMPLETED.
    await m.kernel.emit("agent.resumed", { agentId: "qa" }, { actorId: "human" });
    assert.equal(m.kernel.state.agents.get("qa")!.state.lifecycle, "IDLE", "precondition: the dead agent rests at IDLE");

    const r = await m.supervisor.activateAgent("qa", { kind: "recovery", note: "respawn owed at completion" });
    assert.equal(r.queued, true, "a recovery activation must not be refused by a stopped scheduler");
    assert.equal(m.scheduler.pending(), 1, "the owed restart is queued");

    await new Promise((res) => setTimeout(res, 250));
    assert.equal(turns, 0, "parked stays parked: the queued recovery must not run while stopped");

    await m.supervisor.reopenGoal({ reason: "rejected" });
    await waitFor("the owed restart ran once the scheduler started", () => turns > 0, 8000);
  } finally {
    await m.cleanup();
  }
});

// A reopen that woke nobody must say so instead of returning a bare ok:true.
test("reopen: warns when no agent could be activated", async () => {
  const m = await completedMesh();
  try {
    await completeIt(m);
    const r = await m.supervisor.reopenGoal({ reason: "rejected", activate: ["ghost"] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.activated, [], "an unknown agent activates nothing");
    assert.equal(r.refused?.[0]?.agentId, "ghost");
    assert.match(r.warning ?? "", /refused|woken by hand/, "silence would look like success");
  } finally {
    await m.cleanup();
  }
});
