import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { ManualClock, settle } from "../support/manual-clock";
import { Scheduler, type TurnRunner } from "../../packages/scheduler/src/index";
import type { ActivationReason, MeshEvent, PolicyDecisionResult } from "../../packages/protocol/src/index";
import type { PolicyEvaluator } from "../../packages/core/src/ports";

/**
 * Scheduler wake hygiene (NOTES-live-run-20260925 §5, §17).
 *
 * Driven on a bare `Scheduler` with a fake runner and a manual clock, so each
 * test controls exactly which turn holds the one slot and exactly how long every
 * entry has waited. The mesh underneath is parked and supplies only the resolved
 * config and a real projection.
 */

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

class FakeRunner implements TurnRunner {
  started: Array<{ agentId: string; reason: ActivationReason }> = [];
  stuck: string[] = [];
  private open = new Map<string, () => void>();
  private closed = false;
  runTurn(agentId: string, reason: ActivationReason): Promise<void> {
    this.started.push({ agentId, reason });
    if (this.closed) return Promise.resolve();
    return new Promise<void>((resolve) => this.open.set(agentId, resolve));
  }
  finish(agentId: string): void {
    this.open.get(agentId)?.();
    this.open.delete(agentId);
  }
  /** Release every held turn, and every later one, so `stop()` does not sit out its 5s drain. */
  finishAll(): void {
    this.closed = true;
    for (const id of [...this.open.keys()]) this.finish(id);
  }
  async escalateStuckRequest(agentId: string, messageId: string): Promise<void> {
    this.stuck.push(`${agentId}:${messageId}`);
  }
}

const ALLOW_ALL = {
  evaluateActivation: (): PolicyDecisionResult => ({ decision: "ALLOW", reason: "test" }),
} as unknown as PolicyEvaluator;

async function harness(
  agents: Array<{ id: string; role: string; interests?: string[] }>,
  opts: { policy?: (m: Mesh) => PolicyEvaluator; mayContact?: Record<string, string[]> } = {},
): Promise<{ m: Mesh; sched: Scheduler; runner: FakeRunner; clock: ManualClock }> {
  const m = await makeMesh({
    agents: agents.map((a) => ({ ...a, interests: a.interests ?? [] })),
    mayContact: opts.mayContact ?? Object.fromEntries(agents.map((a) => [a.id, agents.map((b) => b.id).filter((id) => id !== a.id)])),
    mode: "parked",
    maxActiveAgents: 1,
  });
  const clock = new ManualClock(Date.now());
  const runner = new FakeRunner();
  const sched = new Scheduler(m.config, m.kernel.state, opts.policy?.(m) ?? ALLOW_ALL, runner, undefined, clock);
  sched.start();
  return { m, sched, runner, clock };
}

test("queue aging: a starved entry is served before a younger one that was promoted past it", async () => {
  // Measured 2026-09-25: qa held pm's NORMAL REQUEST_REVIEW from 21:01:01 to
  // 21:23:32 while nine other seats took the freed slots. At 21:08:33 it lost to
  // frontend's "10 s-old" HIGH — which was in fact a handover requeue from
  // 21:03:03 promoted in place, keeping its age: 6 + 5 bands beat 4 + the 6-band
  // cap. Once every entry has waited past the cap, aging stops ordering anything
  // and a NORMAL loses to every requeue (5), HIGH (6) and recovery (7) forever.
  const { m, sched, runner, clock } = await harness([
    { id: "busy", role: "developer" },
    { id: "qa", role: "qa" },
    { id: "frontend", role: "developer" },
  ]);
  try {
    await sched.requestActivation({ agentId: "busy", reason: { kind: "manual" }, priority: 6 });
    assert.deepEqual(runner.started.map((s) => s.agentId), ["busy"], "fixture: busy holds the only slot");

    await sched.requestActivation({ agentId: "qa", reason: { kind: "message", messageId: "msg-review" }, priority: 4 });
    clock.advance(2 * 60_000);
    await sched.requestActivation({ agentId: "frontend", reason: { kind: "message", messageId: "msg-handover", note: "requeued after a handover" }, priority: 3 });
    clock.advance(5 * 60_000 + 20_000);
    await sched.requestActivation({ agentId: "frontend", reason: { kind: "message", messageId: "msg-high" }, priority: 6 });
    clock.advance(10_000);

    runner.finish("busy");
    await settle();
    assert.equal(runner.started[1]?.agentId, "qa", "7m30s in the queue outranks 5m30s, whatever bands the younger entry was promoted to");
  } finally {
    runner.finishAll();
    await settle();
    await sched.stop();
    await m.cleanup();
  }
});

test("coalescing: a runtime notice folded into an already-queued wake keeps its note", async () => {
  const { m, sched, runner } = await harness([
    { id: "busy", role: "developer" },
    { id: "pm", role: "pm" },
  ]);
  try {
    await sched.requestActivation({ agentId: "busy", reason: { kind: "manual" }, priority: 6 });
    await sched.requestActivation({ agentId: "pm", reason: { kind: "recovery", note: "your request msg-1 closed: it was answered" }, priority: 7 });
    await sched.requestActivation({ agentId: "pm", reason: { kind: "recovery", note: "your request msg-2 was voided to break a circular wait" }, priority: 7 });

    const queued = sched.queueSnapshot().find((q) => q.agentId === "pm");
    assert.match(String(queued?.reason.note), /msg-1/);
    assert.match(String(queued?.reason.note), /msg-2/, "an equal-priority notice must not vanish because a wake was already queued");

    // Same for a seat that is mid-turn: the stash holds one wake, but not one note.
    runner.finish("busy");
    await settle();
    assert.equal(runner.started[1]?.agentId, "pm");
    await sched.requestActivation({ agentId: "pm", reason: { kind: "recovery", note: "notice A" }, priority: 7 });
    await sched.requestActivation({ agentId: "pm", reason: { kind: "recovery", note: "notice B" }, priority: 7 });
    const stashed = sched.queueSnapshot().find((q) => q.agentId === "pm" && q.afterTurn);
    assert.match(String(stashed?.reason.note), /notice A/);
    assert.match(String(stashed?.reason.note), /notice B/);
  } finally {
    runner.finishAll();
    await settle();
    await sched.stop();
    await m.cleanup();
  }
});

test("stale wakes: an interest wake whose request has closed is dropped when it reaches the head of the queue", async () => {
  // Measured 2026-09-25: explorer was woken by `design.question` (seq 116) for a
  // review ask superseded at seq 193 — twice, the second a requeue after a
  // handover — and spent 812k tokens, 12% of the mission, on self-directed work.
  const { m, sched, runner } = await harness([
    { id: "busy", role: "developer" },
    { id: "pm", role: "pm" },
    { id: "qa", role: "qa" },
    { id: "explorer", role: "explorer", interests: ["design.question"] },
  ]);
  try {
    const asked = async (subject: string) => {
      const sent = await m.supervisor.sendMessage({ from: "pm", to: ["qa"], type: "REQUEST_REVIEW", newThread: { subject }, payload: { subject } });
      assert.ok(sent.accepted && sent.messageId, sent.reason);
      return sent.messageId!;
    };
    const question = (id: string, messageId: string): MeshEvent =>
      ({ id, type: "design.question", actorId: "pm", timestamp: new Date().toISOString(), goalId: m.kernel.state.activeGoalId, payload: { messageId, question: "Review X v1" } }) as MeshEvent;

    await sched.requestActivation({ agentId: "busy", reason: { kind: "manual" }, priority: 6 });
    const superseded = await asked("review v1");
    await sched.handleEvent(question("evt-dq-1", superseded));
    assert.ok(sched.queueSnapshot().some((q) => q.agentId === "explorer"), "fixture: the interest wake is queued behind busy");

    await m.supervisor.dischargeCommitment(superseded, "superseded", "architect");
    runner.finish("busy");
    await settle();
    assert.ok(!runner.started.some((s) => s.agentId === "explorer"), "the question it was woken for no longer exists");
    assert.equal(sched.suppressedWakes().stale_request, 1, "and the drop is counted, not silent");

    // Negative control: an interest wake whose ask is still open runs.
    const open = await asked("review v2");
    await sched.handleEvent(question("evt-dq-2", open));
    await settle();
    assert.ok(runner.started.some((s) => s.agentId === "explorer"), "a live question still wakes its subscriber");
  } finally {
    runner.finishAll();
    await settle();
    await sched.stop();
    await m.cleanup();
  }
});

test("budget parking: a seat parked on its budget is not nudged into a stuck-request stalemate", async () => {
  // A parked seat's activations are all DEFERred by the budget rule. The nudge
  // sweep counted each deferral as a denied nudge and, after three, raised
  // `stalemate:unanswered_request` from the deadlock detector — a stalemate card
  // halts the whole goal, undoing the parking one sweep later.
  const { m, sched, runner, clock } = await harness(
    [
      { id: "pm", role: "pm" },
      { id: "qa", role: "qa" },
    ],
    { policy: (mesh) => mesh.supervisor.deps.policy as PolicyEvaluator },
  );
  try {
    const sent = await m.supervisor.sendMessage({ from: "pm", to: ["qa"], type: "REQUEST_REVIEW", newThread: { subject: "review" }, payload: {} });
    assert.ok(sent.accepted, sent.reason);
    // The parked mesh underneath only supplies config and a projection. Its own
    // watchdog would otherwise auto-raise qa's ledger (or, before the parking
    // fix, halt the goal) on the overrun below and decide this test by itself.
    (m.supervisor as unknown as { stopping: boolean }).stopping = true;
    const key = `agent:${m.kernel.state.activeGoalId}/qa`;
    await m.supervisor.deps.budget.consume(key, "tokens", 250_000);
    assert.equal(m.kernel.state.budgets.get(key)?.exceeded, true, "fixture: qa is parked on its budget");

    for (let i = 0; i < 10; i++) await clock.advanceAndSettle(m.config.scheduling.waitWakeupMs);
    assert.deepEqual(runner.stuck, [], "the operator already holds qa's budget card; a stalemate on top of it would halt everyone");
    assert.ok(!runner.started.some((s) => s.agentId === "qa"));
  } finally {
    runner.finishAll();
    await settle();
    await sched.stop();
    await m.cleanup();
  }
});
