import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { makeMesh, stub } from "../helpers";
import type { MeshInstance } from "../../apps/mesh-server/src/index";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * The timer-driven surface: `runTurn`'s entry guards, the stall watchdog and
 * the silent-turn interrupter.
 *
 * None of these are exercised by waiting on a real timer here. `runTurn` is
 * public, and `checkStall` / `interruptSilentTurns` are reachable through a
 * structural cast on a parked mesh — so the watchdog can be ticked by hand,
 * with mesh state posed exactly where each branch lives. Only the forced
 * post-interrupt settle is genuinely time-based (a 2s grace inside the
 * supervisor), and exactly one test pays for it.
 */

/** The private members these tests pose and observe. */
interface StallProbe {
  checkStall(): Promise<void>;
  interruptSilentTurns(now: number): void;
  liveMode: boolean;
  quiesced: boolean;
  lastTurnAt: number;
  lastStallNudgeAt: number;
  stallNoopRetryAt: number;
  turnInFlight: Set<string>;
  activeTurnByAgent: Map<string, string>;
  interruptedTurnIds: Set<string>;
  sessions: Map<string, { session: { sessionId: string; agentId: string }; runtime: { interrupt(s: unknown): Promise<void> } }>;
  turns: {
    push(rec: unknown): void;
    get(turnId: string): { status: string; phases?: { firstTokenAt?: number; lastTokenAt?: number } } | undefined;
  };
}

function probe(m: MeshInstance): StallProbe {
  return m.supervisor as unknown as StallProbe;
}

/** Route audit lines to a real file so the audit branches are observable. */
function withAuditFile(m: MeshInstance): { read(): string; dispose(): void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-audit-"));
  const file = path.join(dir, "nested", "audit.log");
  (m.supervisor.deps as { auditFile?: string }).auditFile = file;
  return {
    read: () => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""),
    dispose: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Pose a streaming turn: in flight, registered against a session whose
 * `interrupt` is observable, with a token mark `agoMs` in the past.
 */
function poseStreamingTurn(m: MeshInstance, agentId: string, agoMs: number | undefined): { turnId: string; interrupts: string[] } {
  const p = probe(m);
  const turnId = `turn-posed-${agentId}-${Math.random().toString(36).slice(2, 8)}`;
  const interrupts: string[] = [];
  p.turns.push({
    turnId,
    agentId,
    reason: { kind: "timer" },
    startedAt: new Date().toISOString(),
    status: "running",
    phases: { startedAt: Date.now() - 60000, ...(agoMs === undefined ? {} : { firstTokenAt: Date.now() - agoMs }) },
  });
  p.turnInFlight.add(agentId);
  p.activeTurnByAgent.set(agentId, turnId);
  p.sessions.set(agentId, {
    session: { sessionId: `sess-${agentId}`, agentId },
    runtime: {
      async interrupt(s: unknown) {
        interrupts.push((s as { sessionId: string }).sessionId);
      },
    },
  });
  return { turnId, interrupts };
}

/** Count activation requests without letting the scheduler pump a turn. */
function blockActivations(m: MeshInstance, queued: boolean): string[] {
  const seen: string[] = [];
  const sched = m.supervisor.deps.scheduler as unknown as { requestActivation: (req: { agentId: string }) => Promise<boolean> };
  sched.requestActivation = async (req) => {
    seen.push(req.agentId);
    return queued;
  };
  return seen;
}

const AGENTS = [
  { id: "pm", role: "pm", authority: ["requirements.accept"], capabilities: ["repository.read"], interests: [] },
  { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
];

// --- runTurn entry guards ---

test("runTurn: a second activation while a turn is in flight is dropped, not queued behind it", async () => {
  const m = await makeMesh({ agents: AGENTS, mode: "parked" });
  try {
    const before = m.supervisor.getRecentTurns().length;
    probe(m).turnInFlight.add("pm");
    await m.supervisor.runTurn("pm", { kind: "manual" });
    assert.equal(m.supervisor.getRecentTurns().length, before, "the reentry guard must mint no second turn record");
  } finally {
    await m.cleanup();
  }
});

test("runTurn: an agent that is not in the mesh never mints a turn", async () => {
  const m = await makeMesh({ agents: AGENTS, mode: "parked" });
  try {
    const before = m.supervisor.getRecentTurns().length;
    await m.supervisor.runTurn("ghost", { kind: "manual" });
    assert.equal(m.supervisor.getRecentTurns().length, before);
  } finally {
    await m.cleanup();
  }
});

test("runTurn: a suspended or completed agent is skipped even on an explicit wake", async () => {
  const m = await makeMesh({ agents: AGENTS, mode: "parked" });
  try {
    const rec = m.kernel.state.agents.get("pm")!;
    for (const lifecycle of ["SUSPENDED", "COMPLETED"] as const) {
      rec.state.lifecycle = lifecycle;
      const before = m.supervisor.getRecentTurns().length;
      await m.supervisor.runTurn("pm", { kind: "manual" });
      assert.equal(m.supervisor.getRecentTurns().length, before, `${lifecycle} must not run a turn`);
    }
  } finally {
    await m.cleanup();
  }
});

test("runTurn: with no active goal there is nothing to run a turn against", async () => {
  const m = await makeMesh({ agents: AGENTS, mode: "parked" });
  try {
    const goalId = m.kernel.state.activeGoalId;
    m.kernel.state.activeGoalId = null;
    const before = m.supervisor.getRecentTurns().length;
    await m.supervisor.runTurn("pm", { kind: "manual" });
    assert.equal(m.supervisor.getRecentTurns().length, before);
    // A goal id pointing at nothing is the same refusal by a different route.
    m.kernel.state.activeGoalId = "goal-missing-000";
    await m.supervisor.runTurn("pm", { kind: "manual" });
    assert.equal(m.supervisor.getRecentTurns().length, before);
    m.kernel.state.activeGoalId = goalId;
  } finally {
    await m.cleanup();
  }
});

test("runTurn: paused, escalated and failed missions run no turns at all", async () => {
  const m = await makeMesh({ agents: AGENTS, mode: "parked" });
  try {
    const goal = m.kernel.state.goals.get(m.kernel.state.activeGoalId!)!;
    for (const status of ["PAUSED", "ESCALATED", "FAILED"] as const) {
      goal.status = status;
      const before = m.supervisor.getRecentTurns().length;
      await m.supervisor.runTurn("pm", { kind: "manual" });
      assert.equal(m.supervisor.getRecentTurns().length, before, `a ${status} mission must not run a turn`);
    }
  } finally {
    await m.cleanup();
  }
});

test("runTurn: a completed mission still answers direct mail but ignores timer wakes", async () => {
  const m = await makeMesh({ agents: AGENTS, mode: "parked" });
  try {
    stub(m).setScript("pm", async () => ({ operations: [{ op: "done" }] as MeshOp[] }));
    const goal = m.kernel.state.goals.get(m.kernel.state.activeGoalId!)!;
    goal.status = "COMPLETED";

    const before = m.supervisor.getRecentTurns().length;
    await m.supervisor.runTurn("pm", { kind: "timer" });
    assert.equal(m.supervisor.getRecentTurns().length, before, "a timer wake on a closed mission is refused");

    await m.supervisor.runTurn("pm", { kind: "message" });
    assert.equal(m.supervisor.getRecentTurns().length, before + 1, "a follow-up message must still get one turn");
  } finally {
    await m.cleanup();
  }
});

test("runTurn: a turn the budget cannot cover raises the ceiling once, then escalates", async () => {
  // Turn 1 runs with auto-raise off, so it overspends its 1000-token ledger
  // outright (the reserve took the partial headroom, the real usage blew past
  // it). Turn 2 then has nothing to reserve: the raise lifts the ledger to its
  // 1.8x ceiling, the single retry is blocked against that ceiling too, and
  // the ceiling — not the raise — becomes the answer the operator sees.
  const m = await makeMesh({
    agents: [{ ...AGENTS[0], tokens: 1000 }, AGENTS[1]],
    autoRaise: { enabled: false, maxMultiple: 1.8 },
    mode: "parked",
  });
  try {
    stub(m).setScript("pm", async () => ({ operations: [{ op: "done" }] as MeshOp[] }));
    await m.supervisor.runTurn("pm", { kind: "manual" });
    assert.equal(m.supervisor.getRecentTurns().find((t) => t.agentId === "pm")?.status, "ok", "turn 1 fits the partial headroom");

    m.supervisor.config.budgets.autoRaise.enabled = true;
    // Turn 1's own overspend escalated the mission and parked the agent; the
    // budget wall, not that bookkeeping, is what this test is about.
    m.kernel.state.goals.get(m.kernel.state.activeGoalId!)!.status = "ACTIVE";
    m.kernel.state.agents.get("pm")!.state.lifecycle = "WAITING";
    await m.supervisor.runTurn("pm", { kind: "manual" });

    const turn = m.supervisor.getRecentTurns().find((t) => t.agentId === "pm");
    assert.equal(turn?.status, "blocked", "a turn with no headroom is blocked, not run");
    assert.match(String(turn?.error), /exhausted/);
    const esc = [...m.kernel.state.escalations.values()].filter((e) => e.reason === "budget_exhausted");
    assert.equal(esc.length, 1, "the exhausted budget must reach the operator exactly once");
    assert.equal(m.kernel.state.agents.get("pm")?.state.lifecycle, "BLOCKED");
    // The raise happened even though it did not save the turn.
    const ledger = [...m.kernel.state.budgets.entries()].find(([k]) => k.includes("pm"));
    assert.ok((ledger?.[1].limit ?? 0) > 1000, `auto-raise must lift the ledger before giving up (limit=${ledger?.[1].limit})`);
  } finally {
    await m.cleanup();
  }
});

// --- checkStall ---

test("stall tick: a parked supervisor never nudges, a live one does", async () => {
  const m = await makeMesh({ agents: AGENTS, startup: ["pm"], mode: "parked" });
  try {
    const p = probe(m);
    const wakes = blockActivations(m, true);
    p.lastTurnAt = 0;

    await p.checkStall();
    assert.deepEqual(wakes, [], "liveMode gates the watchdog");

    p.liveMode = true;
    await p.checkStall();
    assert.deepEqual(wakes, ["pm"], "a live, quiet mission with unmet criteria gets a driver");
    assert.equal(p.stallNoopRetryAt, 0, "a successful nudge disarms the fast retry");
  } finally {
    await m.cleanup();
  }
});

test("stall tick: work in flight diverts the tick to the silence check instead of nudging", async () => {
  const m = await makeMesh({ agents: AGENTS, startup: ["pm"], mode: "parked" });
  try {
    const p = probe(m);
    (m.supervisor.config.scheduling as { turnSilenceMs: number }).turnSilenceMs = 50;
    p.liveMode = true;
    p.lastTurnAt = 0;
    const wakes = blockActivations(m, true);
    const posed = poseStreamingTurn(m, "dev", 5000);

    await p.checkStall();

    assert.deepEqual(wakes, [], "a mission with a turn running must not also be nudged");
    assert.deepEqual(posed.interrupts, ["sess-dev"], "the in-flight tick must still catch a silent stream");
  } finally {
    await m.cleanup();
  }
});

test("stall tick: a mission with nothing actionable says so once and then stays silent", async () => {
  const m = await makeMesh({ agents: AGENTS, startup: ["pm"], mode: "parked" });
  const audit = withAuditFile(m);
  try {
    const p = probe(m);
    const wakes = blockActivations(m, true);
    p.liveMode = true;
    p.lastTurnAt = 0;
    // Every mandatory criterion evidenced, no mail, no escalations, no tasks.
    const goal = m.kernel.state.goals.get(m.kernel.state.activeGoalId!)!;
    for (const c of goal.acceptanceCriteria) c.status = "EVIDENCED";

    await p.checkStall();
    assert.equal(p.quiesced, true, "the watchdog must rest rather than buy a `done` op");
    assert.deepEqual(wakes, []);
    const first = audit.read();
    assert.match(first, /nothing actionable/);

    await p.checkStall();
    assert.equal(audit.read(), first, "one audit line per quiesce, not one per tick");
  } finally {
    audit.dispose();
    await m.cleanup();
  }
});

test("stall tick: a quiet mission inside the idle window is left alone", async () => {
  const m = await makeMesh({ agents: AGENTS, startup: ["pm"], mode: "parked", stallIdleMs: 300000 });
  try {
    const p = probe(m);
    const wakes = blockActivations(m, true);
    p.liveMode = true;
    p.lastTurnAt = Date.now();
    await p.checkStall();
    assert.deepEqual(wakes, [], "a turn that just finished still owns the mission");

    // Idle satisfied, but a nudge landed moments ago: the cooldown governs.
    p.lastTurnAt = 0;
    (m.supervisor.config.scheduling as { stallIdleMs: number }).stallIdleMs = 1;
    p.lastStallNudgeAt = Date.now();
    await p.checkStall();
    assert.deepEqual(wakes, [], "the cooldown must not be re-entered every tick");
  } finally {
    await m.cleanup();
  }
});

test("stall tick: a refused driver keeps the cooldown unspent and re-arms the fast retry", async () => {
  const m = await makeMesh({ agents: AGENTS, startup: ["pm"], mode: "parked", stallNoopRetryMs: 400 });
  const audit = withAuditFile(m);
  try {
    const p = probe(m);
    const wakes = blockActivations(m, false);
    p.liveMode = true;
    // Inside the idle window: only the armed no-op fast retry opens this tick.
    p.lastTurnAt = Date.now();
    p.stallNoopRetryAt = Date.now() - 1;

    await p.checkStall();

    assert.deepEqual(wakes, ["pm"], "the fast retry must reach a driver despite the idle window");
    assert.equal(p.lastStallNudgeAt, 0, "a refusal must not spend the cooldown");
    assert.ok(p.stallNoopRetryAt > Date.now(), "the refused fast retry re-arms for the next tick");
    assert.match(audit.read(), /driver pm refused .* cooldown not consumed/);
  } finally {
    audit.dispose();
    await m.cleanup();
  }
});

test("stall tick: a silent stream is interrupted even when the goal is ESCALATED", async () => {
  // The stall escalates to a human, which flips the goal to ESCALATED — and
  // the old ACTIVE gate then disabled the watchdog, leaving the frozen turn
  // running until its 10-20 minute timeout. That self-made deadlock is what
  // this pins shut.
  const m = await makeMesh({ agents: AGENTS, startup: ["pm"], mode: "parked" });
  try {
    const p = probe(m);
    (m.supervisor.config.scheduling as { turnSilenceMs: number }).turnSilenceMs = 100;
    p.liveMode = true;
    m.kernel.state.goals.get(m.kernel.state.activeGoalId!)!.status = "ESCALATED";
    const wakes = blockActivations(m, true);
    const posed = poseStreamingTurn(m, "dev", 5000);

    await p.checkStall();

    assert.deepEqual(posed.interrupts, ["sess-dev"], "an escalated goal must not shield a frozen stream");
    assert.deepEqual(wakes, [], "a non-active goal must still not be nudged");
  } finally {
    await m.cleanup();
  }
});

test("stall tick: a silent stream is interrupted while the scheduler counts the turn as running", async () => {
  // In production the interrupted turn holds a scheduler running slot
  // (runningMap is cleared only when runTurn settles), and the old guard order
  // returned before the silence check because of it, making the watchdog
  // unreachable for every turn it was meant to watch. The in-flight check must
  // precede the scheduler-occupancy gate.
  const m = await makeMesh({ agents: AGENTS, startup: ["pm"], mode: "parked" });
  try {
    const p = probe(m);
    (m.supervisor.config.scheduling as { turnSilenceMs: number }).turnSilenceMs = 100;
    p.liveMode = true;
    const sched = m.supervisor.deps.scheduler as unknown as { running(): number; pending(): number };
    sched.running = () => 1;
    sched.pending = () => 0;
    const wakes = blockActivations(m, true);
    const posed = poseStreamingTurn(m, "dev", 5000);

    await p.checkStall();

    assert.deepEqual(posed.interrupts, ["sess-dev"], "scheduler occupancy must not hide a silent turn");
    assert.deepEqual(wakes, [], "a busy scheduler must not be nudged");
  } finally {
    await m.cleanup();
  }
});

// --- interruptSilentTurns ---

test("silence watch: a stream that stopped mid-turn is interrupted exactly once", async () => {
  const m = await makeMesh({ agents: AGENTS, mode: "parked" });
  const audit = withAuditFile(m);
  try {
    const p = probe(m);
    (m.supervisor.config.scheduling as { turnSilenceMs: number }).turnSilenceMs = 100;
    const posed = poseStreamingTurn(m, "dev", 5000);

    p.interruptSilentTurns(Date.now());
    assert.deepEqual(posed.interrupts, ["sess-dev"]);
    assert.ok(p.interruptedTurnIds.has(posed.turnId));
    assert.match(audit.read(), /stall silence: turn .* for dev silent for/);

    // A later tick on the same turn must not fire a second interrupt.
    p.interruptSilentTurns(Date.now());
    assert.equal(posed.interrupts.length, 1, "the per-turn guard must hold across ticks");
  } finally {
    audit.dispose();
    await m.cleanup();
  }
});

test("silence watch: a turn that never streamed a token is left to think", async () => {
  const m = await makeMesh({ agents: AGENTS, mode: "parked" });
  try {
    const p = probe(m);
    (m.supervisor.config.scheduling as { turnSilenceMs: number }).turnSilenceMs = 10;
    // No firstTokenAt: pre-token thinking and long internal tool runs look
    // identical to a freeze from here, so they must never be interrupted.
    const posed = poseStreamingTurn(m, "dev", undefined);
    p.interruptSilentTurns(Date.now());
    assert.deepEqual(posed.interrupts, [], "pre-token silence is not a stall");
  } finally {
    await m.cleanup();
  }
});

test("silence watch: a turn still streaming is not interrupted", async () => {
  const m = await makeMesh({ agents: AGENTS, mode: "parked" });
  try {
    const p = probe(m);
    (m.supervisor.config.scheduling as { turnSilenceMs: number }).turnSilenceMs = 60000;
    const posed = poseStreamingTurn(m, "dev", 100);
    p.interruptSilentTurns(Date.now());
    assert.deepEqual(posed.interrupts, [], "a token 100ms ago is a healthy stream");
    assert.equal(p.interruptedTurnIds.has(posed.turnId), false);
  } finally {
    await m.cleanup();
  }
});

test("silence watch: an agent in flight with no session or turn id is skipped", async () => {
  const m = await makeMesh({ agents: AGENTS, mode: "parked" });
  try {
    const p = probe(m);
    (m.supervisor.config.scheduling as { turnSilenceMs: number }).turnSilenceMs = 10;
    // In flight but never reached the session/turn bookkeeping: the loop must
    // step over it rather than throw on a missing session.
    p.turnInFlight.add("pm");
    p.interruptSilentTurns(Date.now());
    assert.equal(p.interruptedTurnIds.size, 0);
  } finally {
    await m.cleanup();
  }
});

test("silence watch: a no-op interrupt is force-settled so the turn cannot hang forever", async () => {
  // The stub's interrupt does nothing, which is exactly the runtime whose
  // send() would otherwise never reject. The supervisor's 2s grace must close
  // the turn itself and route it through the normal failure handling.
  const m = await makeMesh({ agents: AGENTS, mode: "parked" });
  try {
    const p = probe(m);
    (m.supervisor.config.scheduling as { turnSilenceMs: number }).turnSilenceMs = 100;
    const posed = poseStreamingTurn(m, "dev", 5000);

    p.interruptSilentTurns(Date.now());
    await new Promise((r) => setTimeout(r, 2300));

    const turn = p.turns.get(posed.turnId);
    assert.equal(turn?.status, "failed", "the forced settle must close the turn");
    const failed = (await m.store.read()).filter((e) => e.type === "agent.failed" && (e.payload as { agentId: string }).agentId === "dev");
    assert.equal(failed.length, 1, "the settled turn must go through handleAgentFailure");
    assert.match(String((failed[0].payload as { error: string }).error), /turn silence exceeded 100ms/);
  } finally {
    await m.cleanup();
  }
});

test("silence watch: a turn already replaced by a newer one is not force-settled", async () => {
  const m = await makeMesh({ agents: AGENTS, mode: "parked" });
  try {
    const p = probe(m);
    (m.supervisor.config.scheduling as { turnSilenceMs: number }).turnSilenceMs = 100;
    const posed = poseStreamingTurn(m, "dev", 5000);

    p.interruptSilentTurns(Date.now());
    // The interrupt landed and the agent moved on before the grace elapsed.
    p.turnInFlight.delete("dev");
    p.activeTurnByAgent.delete("dev");
    await new Promise((r) => setTimeout(r, 2300));

    assert.equal(p.turns.get(posed.turnId)?.status, "running", "the grace must not clobber a turn that already moved on");
    const failed = (await m.store.read()).filter((e) => e.type === "agent.failed");
    assert.equal(failed.length, 0);
  } finally {
    await m.cleanup();
  }
});
