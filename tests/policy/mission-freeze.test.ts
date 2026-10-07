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

test("freeze: work-moving agent ops are refused while escalated; talking, alarm and reads pass; human bypasses", async () => {
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

  // Ops that move work are refused — with no rejection event spam.
  const rejectedBefore = (await m.store.read({ types: ["message.rejected"] })).length;
  const frozen = await m.supervisor.executeOp("dev", { op: "publish_artifact", name: "nope", type: "ADR", content: "x" }, fakeTurn("dev"));
  assert.equal(frozen.ok, false);
  assert.match(frozen.reason ?? "", /escalated/i);
  assert.equal((await m.supervisor.executeOp("dev", { op: "approve", subject: "release" }, fakeTurn("dev"))).ok, false);
  assert.equal((await m.supervisor.executeOp("dev", { op: "transition_artifact", artifactId: artId, to: "FINAL" }, fakeTurn("dev"))).ok, false);
  const rejectedAfter = (await m.store.read({ types: ["message.rejected"] })).length;
  assert.equal(rejectedAfter, rejectedBefore, "guard must refuse before the policy layer emits rejections");

  // Talking stays legal. Denying `send` here did not silence the seats, it
  // routed them: with `escalate` the only op that could carry words, a seat
  // answering the operator or correcting a premise had to raise an escalation
  // to do it, and the operator's queue filled with replies wearing the costume
  // of new blockers. Nothing restarts — `activateAgent` still refuses to wake
  // anyone on a halted goal — so the message waits in the inbox for the resume.
  assert.equal((await m.supervisor.executeOp("dev", send, fakeTurn("dev"))).ok, true);
  assert.equal((await m.supervisor.activateAgent("qa", { kind: "message" })).queued, false, "a delivered message must not restart a halted mission");

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
  // Checked with a work-moving op: `send` is legal under either halt.
  const paused = await m.supervisor.executeOp("dev", { op: "publish_artifact", name: "still-nope", type: "ADR", content: "x" }, fakeTurn("dev"));
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

// The turn above is dropped whole, which is right (a half-applied turn is worse than none), and until now it was also lost: the seat's
// mail was marked delivered, nothing told the seat, and resume woke only seats that held mail or a task, so in the scripted demo a
// Pause that landed while two seats were thinking left the mission at 2 of 7 checks for good.
test("freeze: a turn the pause cut leaves its mail owed, is recorded as discarded for the pause, and is given again at resume", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "qa", role: "qa", capabilities: ["test.execute"], interests: [] },
    ],
    mayContact: { dev: ["qa"], qa: ["dev"], human: ["dev"] },
  });
  const s = stub(m);
  const seen: Array<{ kind: string; unread: number }> = [];
  let release!: () => void;
  const thinking = new Promise<void>((resolve) => (release = resolve));
  s.setScript("dev", async (i, turn) => {
    seen.push({ kind: i.activation.kind, unread: i.context.unreadMail.length });
    if (turn === 0) {
      await thinking;
      return { operations: [{ op: "send", type: "INFORM", to: ["qa"], newThread: { subject: "hello" }, payload: {} } as MeshOp, { op: "done" } as MeshOp] };
    }
    return { operations: [{ op: "done" } as MeshOp] };
  });
  await m.supervisor.humanSend(["dev"], "INFORM", { queued: true });
  await waitFor("dev is thinking", () => seen.length === 1, 6000);
  await m.supervisor.pauseGoal();
  release();
  await waitFor("the cut turn closed", () => m.supervisor.getRecentTurns(5).some((t) => t.agentId === "dev" && t.status !== "running"), 8000);
  assert.equal([...m.kernel.state.messages.values()].filter((x) => x.from === "dev").length, 0, "nothing the cut turn proposed ran");
  assert.equal(m.kernel.state.unread.get("dev")?.length, 1, "the mail it was handed was not answered, so it is still owed");
  const discards = await m.store.read({ types: ["turn.discarded"] });
  assert.equal(discards.length, 1);
  const d = discards[0].payload as { reason: string; detail?: string; tokens?: number };
  assert.equal(d.reason, "paused");
  assert.match(d.detail ?? "", /paused/);
  assert.match(d.detail ?? "", /none of its 2 operations ran/);
  assert.equal(typeof d.tokens, "number", "what it cost is still on the ledger and says so");
  const rec = m.supervisor.getRecentTurns(5).find((t) => t.agentId === "dev" && t.status !== "running")!;
  assert.match(String(rec.summary ?? ""), /paused while you were thinking/);
  assert.equal(seen.length, 1, "a paused mission starts nothing");
  await m.supervisor.resumeGoal();
  await waitFor("dev is given the turn again", () => seen.length >= 2, 8000);
  assert.equal(seen[1]!.unread, 1, "and finds the mail it was handed");
  await m.cleanup();
});

test("freeze: a seat whose turn the pause cut, woken by an event, comes back as that event", async () => {
  const m = await makeMesh({
    agents: [
      { id: "qa", role: "qa", interests: ["dependency.changed"] },
      { id: "trigger", role: "developer", interests: [] },
    ],
    mayContact: { qa: [], trigger: [] },
  });
  const s = stub(m);
  const seen: Array<{ kind: string; eventType?: string; note?: string }> = [];
  let release!: () => void;
  const thinking = new Promise<void>((resolve) => (release = resolve));
  s.setScript("qa", async (i, turn) => {
    seen.push({ kind: i.activation.kind, eventType: i.activation.eventType, note: i.activation.note });
    if (turn === 0) {
      await thinking;
      return { operations: [{ op: "remember", key: "k", value: "v" } as MeshOp, { op: "done" } as MeshOp] };
    }
    return { operations: [{ op: "done" } as MeshOp] };
  });
  await m.kernel.emit("dependency.changed", { files: ["pom.xml"], summary: "upgrade" }, { actorId: "trigger" });
  await waitFor("qa is thinking", () => seen.length === 1, 6000);
  await m.supervisor.pauseGoal();
  release();
  await waitFor("the cut turn closed", () => m.supervisor.getRecentTurns(5).some((t) => t.agentId === "qa" && t.status !== "running"), 8000);
  await m.supervisor.resumeGoal();
  await waitFor("qa is given the turn again", () => seen.length >= 2, 8000);
  assert.equal(seen[1]!.kind, "interest_event", "a seat that reads who woke it finds what it was woken for the first time");
  assert.equal(seen[1]!.eventType, "dependency.changed");
  assert.match(seen[1]!.note ?? "", /pause cut your last turn short \(remember, done did not run\)/);
  await waitFor("the mesh drained", () => m.supervisor.isIdle());
  assert.equal(seen.length, 2, "once");
  await m.cleanup();
});

/**
 * A pause asked for while a seat is applying the ops its model returned waits for them (milliseconds), so that no turn is cut between
 * two ops: the seam is reached by wrapping `executeOp`, since a stub's ops run back to back and a test cannot land between them.
 */
async function pauseDuringOps(opts: { graceMs?: number; slowFirstOpMs?: number }) {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: ["dependency.changed"] },
      { id: "qa", role: "qa", capabilities: ["test.execute"], interests: [] },
      { id: "trigger", role: "developer", interests: [] },
    ],
    mayContact: { dev: ["qa"], qa: ["dev"], trigger: [] },
  });
  const s = stub(m);
  let runs = 0;
  s.setScript("dev", async () => {
    runs++;
    if (runs > 1) return { operations: [{ op: "done" } as MeshOp] };
    return {
      operations: [
        { op: "send", type: "INFORM", to: ["qa"], newThread: { subject: "one" }, payload: {} } as MeshOp,
        { op: "send", type: "INFORM", to: ["qa"], newThread: { subject: "two" }, payload: {} } as MeshOp,
        { op: "done" } as MeshOp,
      ],
    };
  });
  const sup = m.supervisor as unknown as { executeOp: (a: string, ...r: unknown[]) => Promise<unknown>; pauseOpGraceMs: number };
  if (opts.graceMs !== undefined) sup.pauseOpGraceMs = opts.graceMs;
  const real = sup.executeOp.bind(sup);
  let ops = 0;
  let pausing: Promise<void> | undefined;
  sup.executeOp = async (actor: string, ...rest: unknown[]) => {
    if (actor !== "dev") return real(actor, ...rest);
    ops++;
    const result = await real(actor, ...rest);
    if (ops === 1) {
      pausing = m.supervisor.pauseGoal();
      // The first op is slow to finish, as a merge waiting on git is: the pause gives up waiting for it, and the loop finds the mission paused.
      if (opts.slowFirstOpMs) await new Promise((r) => setTimeout(r, opts.slowFirstOpMs));
    }
    return result;
  };
  await m.kernel.emit("dependency.changed", { files: ["pom.xml"], summary: "upgrade" }, { actorId: "trigger" });
  await waitFor("dev's turn closed", () => m.supervisor.getRecentTurns(5).some((t) => t.agentId === "dev" && t.status !== "running"), 8000);
  await pausing;
  return { m, runs: () => runs };
}

test("freeze: a pause asked for while a seat is applying its ops waits for them, so no turn is cut between two ops", async () => {
  const { m, runs } = await pauseDuringOps({});
  assert.equal([...m.kernel.state.messages.values()].filter((x) => x.from === "dev").length, 2, "both sends ran: the turn was not cut");
  const rec = m.supervisor.getRecentTurns(5).find((t) => t.agentId === "dev" && t.status !== "running")!;
  assert.deepEqual(rec.ops, ["send", "send", "done"]);
  assert.equal(m.kernel.state.goals.get(m.kernel.state.activeGoalId!)?.status, "PAUSED", "and the pause took effect when they were done");
  const log = await m.store.read({});
  const pausedAt = log.findIndex((e) => e.type === "goal.paused");
  const lastDevEffect = log.map((e, i) => (e.type === "message.sent" && (e.payload as { message?: { from?: string } }).message?.from === "dev" ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
  assert.ok(pausedAt > lastDevEffect, "nothing the turn did is recorded after the pause");
  assert.equal(runs(), 1);
  await m.cleanup();
});

test("freeze: a stuck op does not hold the pause past its grace; the turn is cut, says how many ops ran, and the seat is woken at resume", async () => {
  const { m, runs } = await pauseDuringOps({ graceMs: 30, slowFirstOpMs: 400 });
  assert.equal([...m.kernel.state.messages.values()].filter((x) => x.from === "dev").length, 1, "the op that ran stays, the rest did not");
  const rec = m.supervisor.getRecentTurns(5).find((t) => t.agentId === "dev" && t.status !== "running")!;
  assert.match(String(rec.summary ?? ""), /1 of your 3 operations ran and the rest did not \(send, done\)/, "and which ones did not");
  const devDiscards = (await m.store.read({ types: ["turn.discarded"] })).filter((e) => (e.payload as { agentId?: string }).agentId === "dev");
  assert.equal(devDiscards.length, 0, "a turn that landed work is not a discarded one");
  await m.supervisor.resumeGoal();
  await waitFor("dev is woken at resume", () => runs() >= 2, 8000);
  await m.cleanup();
});

test("freeze: a turn whose model answers while a pause waits for another seat's ops is cut whole", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: ["dependency.changed"] },
      { id: "qa", role: "qa", capabilities: ["test.execute"], interests: ["dependency.changed"] },
      { id: "trigger", role: "developer", interests: [] },
    ],
    mayContact: { dev: [], qa: [], trigger: [] },
  });
  const s = stub(m);
  let release!: () => void;
  const qaThinking = new Promise<void>((resolve) => (release = resolve));
  let qaRuns = 0;
  s.setScript("dev", async () => ({ operations: [{ op: "remember", key: "a", value: "1" } as MeshOp, { op: "done" } as MeshOp] }));
  s.setScript("qa", async () => {
    qaRuns++;
    if (qaRuns === 1) await qaThinking;
    return { operations: [{ op: "remember", key: "b", value: "2" } as MeshOp, { op: "done" } as MeshOp] };
  });
  // dev's op loop is the one the pause waits for; qa's model answers while it waits.
  const sup = m.supervisor as unknown as { executeOp: (a: string, ...r: unknown[]) => Promise<unknown> };
  const real = sup.executeOp.bind(sup);
  let pausing: Promise<void> | undefined;
  sup.executeOp = async (actor: string, ...rest: unknown[]) => {
    if (actor !== "dev") return real(actor, ...rest);
    pausing ??= m.supervisor.pauseGoal();
    await new Promise((r) => setTimeout(r, 200));
    release();
    await new Promise((r) => setTimeout(r, 100));
    return real(actor, ...rest);
  };
  await m.kernel.emit("dependency.changed", { files: ["pom.xml"], summary: "upgrade" }, { actorId: "trigger" });
  await waitFor("both turns closed", () => m.supervisor.getRecentTurns(10).filter((t) => t.status !== "running").length >= 2, 8000);
  await pausing;
  const discards = (await m.store.read({ types: ["turn.discarded"] })).map((e) => e.payload as { agentId?: string; reason?: string });
  assert.deepEqual(discards.map((d) => [d.agentId, d.reason]), [["qa", "paused"]], "qa answered after the pause was asked for, so its ops did not run");
  assert.equal(m.kernel.state.memory.get("qa")?.has("b") ?? false, false, "and nothing it proposed landed");
  assert.equal(m.kernel.state.memory.get("dev")?.has("a"), true, "while dev's ops, begun before it, did");
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
  // A completion verdict needs its mandatory criteria proven; the reducer
  // refuses one that does not have them. The watchdog may then get there first.
  for (const c of m.kernel.state.goals.get(goalId)!.acceptanceCriteria.filter((x) => x.mandatory)) {
    await m.kernel.emit("requirement.satisfied", { criterionId: c.id, evidence: { verified: true, note: "test" } }, { actorId: "human", goalId });
  }
  if (m.kernel.state.goals.get(goalId)?.status !== "COMPLETED") {
    await m.kernel.emit("goal.completed", { goalId, reason: "test done" }, { actorId: "human" });
  }
  assert.equal((await m.supervisor.executeOp("dev", { op: "publish_artifact", name: "late", type: "ADR", content: "x" }, fakeTurn("dev"))).ok, false);
  assert.equal((await m.supervisor.executeOp("dev", { op: "escalate", reason: "too late", detail: {} }, fakeTurn("dev"))).ok, false);
  assert.equal((await m.supervisor.executeOp("dev", { op: "read_artifact", artifactRef: pub.artifactId! }, fakeTurn("dev"))).ok, true);
  await m.cleanup();
});

test("freeze: verdicts arriving outside a turn are refused while halted; the human seat still decides", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "lead", role: "tech-lead", capabilities: ["code.review", "git.merge"], authority: ["implementation.approve"], interests: [] },
    ],
    mayContact: { dev: ["lead"], lead: ["dev"] },
  });
  const goalId = m.kernel.state.activeGoalId!;

  // Two artifacts under review: one the frozen mission must not settle, one for
  // the operator's bypass, so neither assertion disturbs the other's state.
  const underReview = async (name: string) => {
    const created = await m.supervisor.createArtifact({ actorId: "dev", name, type: "CodePatch", content: "diff" });
    if (!("artifact" in created)) throw new Error(`publish failed for ${name}`);
    const id = created.artifact.id;
    await m.supervisor.transitionArtifact("dev", id, { to: "READY_FOR_REVIEW" });
    await m.supervisor.transitionArtifact("dev", id, { to: "UNDER_REVIEW" });
    return id;
  };
  const agentArt = await underReview("frozen-patch");
  const humanArt = await underReview("operator-patch");

  await m.kernel.emit("goal.escalated", { goalId, reason: "test freeze" }, { actorId: "human" });
  assert.equal(m.kernel.state.goals.get(goalId)?.status, "ESCALATED");

  // `POST /approvals` reaches `recordDecision` directly, with no turn and no
  // active seat, so the `executeOp` guard never sees these calls. All four
  // verdict kinds are covered here: only `approve` has coverage at the op
  // layer, and the halt is not a per-kind decision.
  const rejectedBefore = (await m.store.read({ types: ["message.rejected"] })).length;
  for (const kind of ["approve", "reject", "veto", "block"] as const) {
    const res = await m.supervisor.recordDecision("lead", kind, "implementation", agentArt, `${kind} while frozen`);
    assert.equal(res.ok, false, `${kind} must not land on a halted mission`);
    assert.match(res.reason ?? "", /escalated/i, `${kind} must be refused for the halt`);
  }
  assert.equal(m.kernel.state.artifacts.get(agentArt)?.status, "UNDER_REVIEW", "no verdict may move an artifact while halted");

  // Checked ahead of the task lookup, so even an unknown id reports the halt.
  const done = await m.supervisor.completeTask("dev", "task-does-not-exist", "done via API");
  assert.equal(done.ok, false);
  assert.match(done.reason ?? "", /escalated/i, "the halt outranks 'unknown task'");

  assert.equal(
    (await m.store.read({ types: ["message.rejected"] })).length,
    rejectedBefore,
    "the halt must refuse silently, like the guard in executeOp",
  );

  // The operator keeps their total bypass — deciding on a frozen mission is how
  // a human unfreezes one.
  const human = await m.supervisor.recordDecision("human", "approve", "implementation", humanArt, "operator decides anyway");
  assert.equal(human.ok, true, human.reason);

  // Unfrozen, the identical refused call lands: the halt was the reason, not authority.
  // `reopenGoal`, not `resumeGoal`: the latter only lifts PAUSED, and an
  // ESCALATED mission is the case `goal.reopened` exists for (see its
  // projection). Nothing is revived or activated here — this test only needs
  // the status back to ACTIVE.
  await m.supervisor.reopenGoal({ reason: "operator unfreezes the mission", activate: [] });
  assert.equal(m.kernel.state.goals.get(goalId)?.status, "ACTIVE");
  const after = await m.supervisor.recordDecision("lead", "approve", "implementation", agentArt, "looks good");
  assert.equal(after.ok, true, after.reason);
  await m.cleanup();
});
