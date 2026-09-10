import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, collectEvents, eventTypes, goalOf } from "../helpers";
import type { ActivationReason, MeshOp } from "../../packages/protocol/src/index";

/**
 * The watchdog, end to end — the two jobs it does that nothing else can.
 *
 * A mesh has no main loop. Between turns it is a pile of projections and an
 * empty scheduler queue, and the only thing that distinguishes "resting" from
 * "wedged" is the watchdog. `tests/core/supervisor-timers.test.ts` proves the
 * timers arm; that is not the same claim as "a quiet mission gets driven
 * again" or "a latched budget stops escalating". Both failures are silent by
 * construction: nothing throws, no event is emitted, the mission simply never
 * moves again. So they can only be caught by asserting on the RUNTIME —
 * a turn that actually ran, carrying the wake reason, and a ledger that a
 * watchdog scan actually raised.
 *
 * The stall clock is driven by poking `lastTurnAt` / `lastStallNudgeAt` back
 * rather than by sleeping: the gates read wall-clock deltas, so a test that
 * waits for them is a slow test that still races. `stallIdleMs` is left large
 * on purpose so the REAL interval (idle/3) can never fire mid-assertion and
 * blur which nudge came from where.
 */

const AGENTS = [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] }];

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

/**
 * The stall path is private on purpose (only timers call it). Tests drive it
 * directly so the assertions are about the DECISION, not about a sleep.
 */
interface StallInternals {
  checkStall(): Promise<void>;
  lastTurnAt: number;
  lastStallNudgeAt: number;
}
const internals = (m: Mesh): StallInternals => m.supervisor as unknown as StallInternals;

/** Clear the idle gate: pretend the last turn finished ten minutes ago. */
function goQuiet(m: Mesh): void {
  internals(m).lastTurnAt = Date.now() - 10 * 60_000;
}

/** Clear the cooldown gate: pretend the last nudge was ten minutes ago. */
function clearCooldown(m: Mesh): void {
  internals(m).lastStallNudgeAt = Date.now() - 10 * 60_000;
}

async function idle(m: Mesh, what: string): Promise<void> {
  await waitFor(what, () => m.scheduler.pending() === 0 && m.scheduler.running() === 0);
}

/**
 * A mesh whose stall timers are inert: `stallIdleMs` yields a 20s interval and
 * the no-op fast retry is pushed past the end of the test, so every nudge in
 * these tests comes from an explicit `checkStall()` call and nothing else.
 */
function stallOpts() {
  return { stallIdleMs: 60_000, stallCooldownMs: 300_000, stallNoopRetryMs: 600_000 } as const;
}

test("stall watchdog: a quiet mission with unmet criteria gets a real turn, carrying the wake note", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: { dev: [] }, mode: "live", ...stallOpts() });
  try {
    const seen: ActivationReason[] = [];
    stub(m).setScript("dev", async (input) => {
      seen.push(input.activation);
      return { operations: [{ op: "wait" } as MeshOp] };
    });

    // Nothing has happened yet, so the idle gate is the only thing standing
    // between this mission and a nudge.
    await internals(m).checkStall();
    assert.equal(seen.length, 0, "a mission that just ran is not stalled");

    goQuiet(m);
    await internals(m).checkStall();
    await waitFor("the stall nudge produced a turn", () => seen.length === 1);
    await idle(m, "the nudged turn to finish");

    // The nudge is worthless if it does not reach the runtime as a distinct
    // kind of wake: an agent that cannot tell a watchdog poke from ordinary
    // mail has no way to answer it differently.
    const reason = seen[0]!;
    assert.equal(reason.kind, "timer", "a watchdog wake is a timer activation, not a message");
    assert.match(String(reason.note), /stall watchdog: mission active but quiet/);
    // The note must describe the world the agent is actually in. The mission
    // criterion is unmet here, so the instruction is to drive it — the
    // opposite branch (everything evidenced) tells the agent to close out or
    // say `done`, and handing THAT prompt to a mission with work left is how
    // a mesh talks itself into finishing early.
    assert.match(String(reason.note), /drive the next step toward an unmet criterion/);

    assert.equal(goalOf(m)?.status, "ACTIVE", "nudging is not a verdict");
  } finally {
    await m.cleanup();
  }
});

test("stall watchdog: idle and cooldown are both gates — either one alone keeps the mesh quiet", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: { dev: [] }, mode: "live", ...stallOpts() });
  try {
    let turns = 0;
    stub(m).setScript("dev", async () => {
      turns++;
      return { operations: [{ op: "wait" } as MeshOp] };
    });

    goQuiet(m);
    await internals(m).checkStall();
    await waitFor("first nudge", () => turns === 1);
    await idle(m, "first nudged turn");

    // COOLDOWN GATE. The mission is quiet again (the nudged turn only waited),
    // but the watchdog just spent a context window on it. Without this gate a
    // wedged mission would be re-nudged on every tick — the interval is
    // idle/3, so that is a turn every few seconds, forever.
    goQuiet(m);
    await internals(m).checkStall();
    await internals(m).checkStall();
    assert.equal(turns, 1, "the cooldown must suppress a second nudge, however quiet the mission is");

    // IDLE GATE, in isolation: cooldown lapsed, but a turn just finished.
    // A turn's async ripple (mail delivery, projections, follow-on
    // activations) is still landing, and nudging into it wakes an agent to
    // look at a half-settled world.
    clearCooldown(m);
    internals(m).lastTurnAt = Date.now();
    await internals(m).checkStall();
    assert.equal(turns, 1, "a mission that just ran is not stalled, cooldown or not");

    // Both gates clear: the mission moves again. A cooldown that never lapses
    // is a deadlock wearing a cost saving as a disguise.
    goQuiet(m);
    clearCooldown(m);
    await internals(m).checkStall();
    await waitFor("second nudge once both gates lapse", () => turns === 2);
    await idle(m, "second nudged turn");
  } finally {
    await m.cleanup();
  }
});

test("watchdog auto-raise: an exhausted agent ledger is raised in place instead of halting the mission", async () => {
  // 5k tokens buys roughly one scripted turn; the turn below spends 9k, which
  // latches `exceeded` on the agent ledger. That latch is read on a TIMER by
  // the termination manager, so without the watchdog's sweep the mission
  // escalates on the next tick even though the same raise would have happened
  // automatically had another turn asked for a reservation.
  const m = await makeMesh({
    agents: [{ ...AGENTS[0]!, tokens: 5000 }],
    mayContact: { dev: [] },
    mode: "live",
    ...stallOpts(),
  });
  try {
    stub(m).setScript("dev", async () => ({
      operations: [{ op: "wait" } as MeshOp],
      tokensUsed: { input: 6000, output: 3000, total: 9000 },
    }));

    const goalId = m.kernel.state.activeGoalId!;
    const key = `agent:${goalId}/dev`;
    const ledger = () => m.kernel.state.budgets.get(key);
    assert.equal(ledger()?.limit, 5000, "the agent's declared budget is the ledger limit");

    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the turn to overrun the agent budget", () => (ledger()?.consumed ?? 0) > 5000);
    await idle(m, "the overrunning turn to finish");

    await m.supervisor.forceWatchdog();

    const raised = ledger();
    assert.ok(raised, "the ledger survives the raise");
    assert.ok(raised.limit !== null && raised.limit > 5000, `the limit was raised (${raised.limit})`);
    assert.ok(raised.limit! <= 5000 * 8, "and stayed under the 8x ceiling — a raise is not a blank cheque");
    assert.equal(raised.exceeded, false, "the latch clears once the new limit covers the spend");

    // Event-sourced or it did not happen: a limit that lives only in memory
    // is re-lost on every replay, and the mission halts on restart.
    const events = await collectEvents(m);
    const raise = events.find((e) => e.type === "budget.limit_raised");
    assert.ok(raise, "the raise is in the log");
    assert.equal((raise.payload as { key?: string }).key, key);
    assert.equal((raise.payload as { previous?: number }).previous, 5000, "the event states what it raised from");
    assert.match(String((raise.payload as { reason?: string }).reason), /auto-raise/);

    // The point of all of it: the mission is still running.
    assert.equal(goalOf(m)?.status, "ACTIVE", "an auto-raised ledger must not halt the mission");
    const halts = [...m.kernel.state.escalations.values()].map((e) => e.reason);
    assert.ok(!halts.includes("agent_budget_exhausted"), `no budget card was raised, got ${JSON.stringify(halts)}`);
  } finally {
    await m.cleanup();
  }
});

test("watchdog auto-raise disabled: the same overrun halts the mission with agent_budget_exhausted", async () => {
  // The negative control for the test above. Without it, "the mission kept
  // running" proves nothing: a termination manager that never fires would
  // pass just as happily as one the auto-raise rescued.
  const m = await makeMesh({
    agents: [{ ...AGENTS[0]!, tokens: 5000 }],
    mayContact: { dev: [] },
    mode: "live",
    autoRaise: { enabled: false },
    ...stallOpts(),
  });
  try {
    stub(m).setScript("dev", async () => ({
      operations: [{ op: "wait" } as MeshOp],
      tokensUsed: { input: 6000, output: 3000, total: 9000 },
    }));

    const goalId = m.kernel.state.activeGoalId!;
    const key = `agent:${goalId}/dev`;
    const ledger = () => m.kernel.state.budgets.get(key);

    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the turn to overrun the agent budget", () => (ledger()?.consumed ?? 0) > 5000);
    await idle(m, "the overrunning turn to finish");

    await m.supervisor.forceWatchdog();
    await waitFor("mission halted on the agent budget", () => goalOf(m)?.status === "ESCALATED");

    assert.equal(ledger()?.limit, 5000, "a disabled auto-raise leaves the operator's cap exactly where it was");
    assert.equal(ledger()?.exceeded, true, "and the latch stands");

    const types = eventTypes(await collectEvents(m));
    assert.ok(!types.includes("budget.limit_raised"), "nothing may raise a budget behind a disabled auto-raise");
    assert.ok(types.includes("budget.exceeded"), "the overrun itself is still announced");
    assert.ok(types.includes("goal.escalated"), "the halt is event-sourced");

    const halts = [...m.kernel.state.escalations.values()].map((e) => e.reason);
    assert.ok(
      halts.includes("agent_budget_exhausted"),
      `expected an agent_budget_exhausted card, got ${JSON.stringify(halts)}`,
    );

    // A halted mission stops spending — the cap is decorative otherwise.
    const refused = await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    assert.equal(refused.queued, false, "no turn may be admitted after the mission halts");
  } finally {
    await m.cleanup();
  }
});
