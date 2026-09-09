import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, eventTypes } from "../helpers";
import type { MeshOp, MeshMessage } from "../../packages/protocol/src/index";

/**
 * The "no active agents, all waiting" stall. Root cause chain: `mesh console`
 * boots parked; the dashboard's ▶ Start Mission (goLive) started the scheduler
 * and flipped the instance mode but never told the SUPERVISOR — whose liveMode
 * gates the stall watchdog — so the watchdog stayed dead forever. Agents
 * finished their startup turns, went WAITING, and nothing ever woke them.
 */

const FAST = { stallIdleMs: 300, stallCooldownMs: 400, waitWakeupMs: 50 };

function stallAwakenings(events: Array<{ type: string; payload: unknown }>) {
  return events.filter(
    (e) => e.type === "agent.awakened" && String(((e.payload as { reason?: { note?: string } })?.reason?.note) ?? "").includes("stall watchdog"),
  );
}

test("stall: goLive arms the watchdog — a parked console sent live keeps nudging", async () => {
  const m = await makeMesh({
    agents: [
      { id: "pm", role: "pm", authority: ["requirements.accept"], capabilities: ["repository.read"], interests: [] },
      { id: "architect", role: "architect", capabilities: ["review.design"], interests: [] },
    ],
    startup: ["pm", "architect"],
    mode: "parked",
    ...FAST,
  });
  const s = stub(m);
  for (const a of ["pm", "architect"]) s.setScript(a, async () => ({ operations: [{ op: "done" }] as MeshOp[] }));

  // Parked boot: startup agents were NOT activated at boot.
  assert.equal(m.kernel.state.agents.get("pm")?.state.activations, 0);

  // ▶ Start Mission: this used to leave the supervisor's liveMode false.
  const live = await m.goLive();
  assert.equal(live.alreadyLive, false);
  await waitFor("startup turns ran", () => (m.kernel.state.agents.get("pm")?.state.activations ?? 0) >= 1, 8000);
  await waitFor("agents quiet", () => m.supervisor.isIdle(), 8000);

  // The watchdog must now be alive: stall nudges appear within the idle window.
  const before = stallAwakenings(await m.store.read()).length;
  await new Promise((r) => setTimeout(r, 1500));
  const after = stallAwakenings(await m.store.read());
  assert.ok(after.length > before, `goLive must arm the stall watchdog (before=${before}, after=${after.length})`);
  assert.ok(
    after.some((e) => (e.payload as { agentId: string }).agentId === "pm"),
    "the nudged driver must be an eligible agent",
  );
  await m.cleanup();
});

test("stall: the watchdog rotates across stuck agents instead of hammering one", async () => {
  const m = await makeMesh({
    agents: [
      { id: "pm", role: "pm", authority: ["requirements.accept"], capabilities: ["repository.read"], interests: [] },
      { id: "architect", role: "architect", capabilities: ["review.design"], interests: [] },
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
    ],
    startup: ["pm", "architect", "dev"],
    mode: "parked",
    ...FAST,
  });
  const s = stub(m);
  for (const a of ["pm", "architect", "dev"]) s.setScript(a, async () => ({ operations: [{ op: "done" }] as MeshOp[] }));
  await m.goLive();
  await waitFor("all quiet", () => m.supervisor.isIdle(), 8000);
  await new Promise((r) => setTimeout(r, 2500));
  const nudged = new Set(stallAwakenings(await m.store.read()).map((e) => (e.payload as { agentId: string }).agentId));
  assert.ok(nudged.size >= 2, `stall nudges must rotate across stuck agents, got ${[...nudged]}`);
  await m.cleanup();
});

test("stall: park() disarms the watchdog", async () => {  const m = await makeMesh({
    agents: [{ id: "pm", role: "pm", authority: ["requirements.accept"], capabilities: ["repository.read"], interests: [] }],
    startup: ["pm"],
    mode: "parked",
    ...FAST,
  });
  const s = stub(m);
  s.setScript("pm", async () => ({ operations: [{ op: "done" }] as MeshOp[] }));
  await m.goLive();
  await waitFor("quiet", () => m.supervisor.isIdle(), 8000);
  await new Promise((r) => setTimeout(r, 600));
  assert.ok(stallAwakenings(await m.store.read()).length > 0, "watchdog alive before park");
  await m.park();
  const marked = stallAwakenings(await m.store.read()).length;
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(stallAwakenings(await m.store.read()).length, marked, "no stall nudges after park");
  await m.cleanup();
});

test("stall: a done-emitting agent ends IDLE even with asks owed on a dead goal", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "qa", role: "qa", capabilities: ["test.execute"], interests: [] },
    ],
    mayContact: { dev: ["qa"], qa: ["dev"] },
    ...FAST,
  });
  const s = stub(m);
  for (const a of ["dev", "qa"]) s.setScript(a, async () => ({ operations: [{ op: "done" }] as MeshOp[] }));

  // Seed an ask from a PREVIOUS mission (dead goalId), as the log would carry
  // one across a goal succession.
  const stale: MeshMessage = {
    id: "msg-stale-1",
    protocolVersion: "1.0",
    type: "REQUEST",
    timestamp: new Date().toISOString(),
    goalId: "goal-dead-000",
    from: "dev",
    to: ["qa"],
    threadId: "thread-stale-1",
    artifactRefs: [],
    payload: {},
    priority: "NORMAL",
    provenance: { source: "agent", trustLevel: 50 },
  };
  await m.kernel.emit("message.sent", { message: stale }, { actorId: "dev", goalId: "goal-dead-000" });
  assert.ok([...m.kernel.state.pendingRequests.values()].some((p) => p.messageId === "msg-stale-1"));

  await m.supervisor.activateAgent("dev", { kind: "manual" });
  await waitFor("dev turn settled", () => m.supervisor.isIdle(), 8000);
  // stillPending is goal-scoped: the stale ask must not pin dev in WAITING.
  assert.equal(m.kernel.state.agents.get("dev")?.state.lifecycle, "IDLE", "done with no active-goal debt = IDLE");
  await m.cleanup();
});

test("stall: boot retires asks orphaned by goal succession", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] }],
    mayContact: { dev: [] },
  });
  // Seed a stale-goal ask AFTER boot, then boot again (resume) — the sweep
  // must discharge it.
  const stale: MeshMessage = {
    id: "msg-stale-2",
    protocolVersion: "1.0",
    type: "REQUEST",
    timestamp: new Date().toISOString(),
    goalId: "goal-dead-111",
    from: "dev",
    to: ["dev"],
    threadId: "thread-stale-2",
    artifactRefs: [],
    payload: {},
    priority: "NORMAL",
    provenance: { source: "agent", trustLevel: 50 },
  };
  await m.kernel.emit("message.sent", { message: stale }, { actorId: "dev", goalId: "goal-dead-111" });
  assert.ok([...m.kernel.state.pendingRequests.values()].some((p) => p.messageId === "msg-stale-2"));

  await m.supervisor.boot({ resume: true, mode: "parked" });
  assert.equal(
    [...m.kernel.state.pendingRequests.values()].some((p) => p.messageId === "msg-stale-2"),
    false,
    "the stale-goal ask must be discharged at boot",
  );
  assert.ok(eventTypes(await m.store.read()).includes("commitment.discharged"));
  await m.cleanup();
});

test("stall: context shows THIS goal's unmet criteria over stale completion memories", async () => {
  const { buildAgentContext, renderContextInstructions } = await import("../../packages/core/src/context");
  const m = await makeMesh({
    agents: [{ id: "pm", role: "pm", authority: ["requirements.accept"], capabilities: ["repository.read"], interests: [] }],
    criteria: [
      { id: "requirements-documented", description: "reqs exist", mandatory: true },
      { id: "architecture-approved", description: "design approved", mandatory: true },
    ],
    mode: "parked",
  });
  const deps = { config: m.config, kernel: m.kernel };
  const ctx = renderContextInstructions(buildAgentContext(deps, "pm"));
  assert.match(ctx, /## Mission acceptance criteria \(THIS goal — authoritative over any memory\)/);
  assert.match(ctx, /\[ \] requirements-documented \(mandatory\): reqs exist — UNSATISFIED/);
  assert.match(ctx, /2 of 2 mandatory criteria are UNMET/);
  assert.match(ctx, /do not treat them as permission to stop/);

  // Evidenced criteria render as done, not as work.
  const goal = m.kernel.state.goals.get(m.kernel.state.activeGoalId!)!;
  goal.acceptanceCriteria[0].status = "EVIDENCED";
  const ctx2 = renderContextInstructions(buildAgentContext(deps, "pm"));
  assert.match(ctx2, /\[x\] requirements-documented/);
  assert.match(ctx2, /1 of 2 mandatory criteria are UNMET/);
  await m.cleanup();
});

test("stall: wake note names the unmet criteria so a nudged agent drives them", async () => {
  const m = await makeMesh({
    agents: [{ id: "pm", role: "pm", authority: ["requirements.accept"], capabilities: ["repository.read"], interests: [] }],
    startup: ["pm"],
    criteria: [
      { id: "requirements-documented", description: "reqs", mandatory: true },
      { id: "architecture-approved", description: "design", mandatory: true },
    ],
    mode: "parked",
    ...FAST,
  });
  const s = stub(m);
  s.setScript("pm", async () => ({ operations: [{ op: "done" }] as MeshOp[] }));
  await m.goLive();
  await waitFor("quiet", () => m.supervisor.isIdle(), 8000);
  await new Promise((r) => setTimeout(r, 700));
  const events = await m.store.read();
  const stall = events.find(
    (e) => e.type === "agent.awakened" && String(((e.payload as { reason?: { note?: string } })?.reason?.note) ?? "").includes("stall watchdog"),
  );
  assert.ok(stall, "watchdog must fire");
  const note = String(((stall!.payload as { reason?: { note?: string } })?.reason?.note) ?? "");
  assert.match(note, /2 of 2 mandatory criteria unmet \(requirements-documented, architecture-approved\)/);
  await m.cleanup();
});

test("stall: goLive kickoff note carries the criteria gap", async () => {
  const m = await makeMesh({
    agents: [{ id: "pm", role: "pm", authority: ["requirements.accept"], capabilities: ["repository.read"], interests: [] }],
    startup: ["pm"],
    criteria: [{ id: "requirements-documented", description: "reqs", mandatory: true }],
    mode: "parked",
    ...FAST,
  });
  const s = stub(m);
  let noteSeen = "";
  s.setScript("pm", async (input) => {
    noteSeen = input.instructions;
    return { operations: [{ op: "done" }] as MeshOp[] };
  });
  await m.goLive();
  await waitFor("startup turn ran", () => m.supervisor.isIdle(), 8000);
  assert.match(noteSeen, /1 of 1 mandatory criteria unmet \(requirements-documented\)/);
  await m.cleanup();
});

test("stall: a no-op turn retries the next driver in seconds, not after the cooldown", async () => {
  // The bug this guards: every turn finished, a no-op turn RESTARTS the stall
  // idle clock, and the watchdog cooldown (5 min by default) then blocks the
  // next attempt. A stalled mission thus crawled at minutes per attempt — the
  // observed "agent done, 2 minutes later the next agent starts". A turn that
  // parsed zero ops proves nothing is landing, so the next driver must be
  // tried at the no-op retry bound instead.
  const m = await makeMesh({
    agents: [
      { id: "pm", role: "pm", authority: ["requirements.accept"], capabilities: ["repository.read"], interests: [] },
      { id: "architect", role: "architect", capabilities: ["review.design"], interests: [] },
    ],
    startup: ["pm", "architect"],
    criteria: [{ id: "x", description: "x", mandatory: true }],
    mode: "parked",
    // Long cooldown isolates the no-op path: with the old code only ONE stall
    // nudge could ever land in this window (idle 200ms, then cooldown 60s).
    ...{ stallIdleMs: 200, stallCooldownMs: 60000, stallNoopRetryMs: 350, waitWakeupMs: 50 },
  });
  const s = stub(m);
  // Both drivers answer with NO ops at all — the waste-loop signature.
  for (const a of ["pm", "architect"]) s.setScript(a, async () => ({ operations: [] as MeshOp[] }));
  await m.goLive();
  let count = 0;
  await waitFor("first stall nudge", async () => {
    count = stallAwakenings(await m.store.read()).length;
    return count >= 1;
  }, 8000);
  const first = count;
  await new Promise((r) => setTimeout(r, 2500));
  const later = stallAwakenings(await m.store.read()).length;
  assert.ok(
    later >= first + 2,
    `no-op turns must allow the watchdog to retry rapidly (started at ${first}, now ${later}); a 60s cooldown here means the mission stalls`,
  );
  await m.cleanup();
});

test("stall: a productive turn still honours the cooldown (no fast retry)", async () => {
  // Counterpart: work DID land (a publish changes the mesh), so the ripple may
  // still be in flight. The fast no-op path must not trigger — only the normal
  // idle+cooldown cadence applies.
  const m = await makeMesh({
    agents: [{ id: "pm", role: "pm", authority: ["requirements.accept"], capabilities: ["repository.read"], interests: [] }],
    startup: ["pm"],
    criteria: [{ id: "x", description: "x", mandatory: true }],
    mode: "parked",
    ...{ stallIdleMs: 200, stallCooldownMs: 60000, stallNoopRetryMs: 350, waitWakeupMs: 50 },
  });
  const s = stub(m);
  // Unique artifact name per turn: a REPEATED publish of the same name is
  // rejected as a duplicate, which would (correctly) classify the turn
  // unproductive and arm the fast retry — defeating this test's purpose.
  let n = 0;
  s.setScript("pm", async () => ({
    operations: [
      { op: "publish_artifact", name: `reqs-${n++}`, type: "RequirementsDoc", content: "c" } as MeshOp,
      { op: "done" } as MeshOp,
    ],
  }));
  await m.goLive();
  await waitFor("first stall nudge", async () => (await m.store.read()).some((e) => String(e.type).includes("agent.awakened")), 8000);
  const before = stallAwakenings(await m.store.read()).length;
  await new Promise((r) => setTimeout(r, 2000));
  const after = stallAwakenings(await m.store.read()).length;
  assert.ok(
    after - before <= 1,
    `a productive turn must not arm the fast retry — the cooldown still governs (before=${before}, after=${after})`,
  );
  await m.cleanup();
});

/**
 * The paid-idle loop, from a real run: 5/5 mandatory criteria EVIDENCED, seven
 * unclaimed OPEN tasks left lying around as intent. Those tasks blocked the
 * `complete` verdict, so the goal stayed ACTIVE; the watchdog then nudged
 * agents forever with "all mandatory criteria evidenced; drive the next step
 * toward an unmet criterion" — a prompt describing a world that did not exist.
 * Agents answered `done`, which is the only honest answer, and the mesh spent
 * 325k tokens (51% of the mission budget) on 41 turns that wrote nothing.
 */
test("stall: a mission with nothing actionable rests instead of paying to be told 'done'", async () => {
  const m = await makeMesh({
    agents: [{ id: "pm", role: "pm", authority: ["requirements.accept"], capabilities: ["repository.read"], interests: [] }],
    startup: ["pm"],
    criteria: [{ id: "ship", description: "the requirements doc exists", mandatory: true }],
    mode: "parked",
    ...{ stallIdleMs: 200, stallCooldownMs: 300, stallNoopRetryMs: 250, waitWakeupMs: 50 },
  });
  const s = stub(m);
  // Turn 1 satisfies the only criterion AND leaves an unclaimed OPEN task
  // behind — the residue that used to wedge the mission open forever.
  let done = false;
  s.setScript("pm", async () => {
    if (done) return { operations: [{ op: "done" }] as MeshOp[] };
    done = true;
    return {
      operations: [
        { op: "publish_artifact", name: "reqs", type: "RequirementsDoc", content: "c" } as MeshOp,
        { op: "create_task", title: "follow-up nobody will claim", description: "residue" } as MeshOp,
        { op: "approve", subject: "criterion:ship", comment: "reqs published" } as MeshOp,
      ] as MeshOp[],
    };
  });
  await m.goLive();
  await waitFor("criterion evidenced", () => {
    const g = m.kernel.state.goals.get(m.kernel.state.activeGoalId ?? "");
    return !!g && g.acceptanceCriteria.every((c) => !c.mandatory || c.status === "EVIDENCED" || c.status === "WAIVED");
  }, 8000);
  const settled = stallAwakenings(await m.store.read()).length;
  // Several idle+cooldown windows: the OLD code nudged on every one of them.
  await new Promise((r) => setTimeout(r, 2500));
  const after = stallAwakenings(await m.store.read()).length;
  assert.ok(
    after - settled <= 1,
    `a finished mission must stop buying turns (nudges ${settled} -> ${after}); an unclaimed OPEN task is residue, not work`,
  );
  // ...and it must actually CLOSE. Resting while stuck ACTIVE would only be a
  // cheaper deadlock: the unclaimed task must not veto the completion verdict.
  const g = m.kernel.state.goals.get(m.kernel.state.activeGoalId ?? "");
  assert.equal(g?.status, "COMPLETED", `an evidenced mission must complete despite unclaimed residue tasks (status=${g?.status})`);
  await m.cleanup();
});
