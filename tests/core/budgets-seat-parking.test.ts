import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, goalOf } from "../helpers";
import { TerminationManager } from "../../packages/core/src/termination";
import type { MeshOp } from "../../packages/protocol/src/index";
import type { Projections } from "../../packages/core/src/state";
import type { ResolvedMeshConfig } from "../../packages/config/src/index";

/**
 * One seat's budget ceiling parks that seat, not the mission
 * (NOTES-live-run-20260925 §2).
 *
 * Measured 2026-09-25 (post-pin seq 1223–1238): tech-lead's ledger passed its 8x
 * ceiling at settle, the termination verdict `agent_budget_exhausted` flipped the
 * GOAL to ESCALATED, and six other seats' activations were denied as "mission is
 * escalated" while ui-designer's publish was refused mid-turn. Explorer did it
 * again 14 minutes later. A seat that cannot pay for its own turns is that
 * seat's problem: it stops taking turns and its card goes to the operator, and
 * everyone else keeps working. Only the mission ledger — or a mesh in which
 * EVERY seat is parked, where nobody can move anyway — halts the goal.
 */

const WAIT = { operations: [{ op: "wait" } as MeshOp] };
const QUIET = { stallIdleMs: 60_000, stallCooldownMs: 300_000, stallNoopRetryMs: 600_000 } as const;

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

async function overrunDev(m: Mesh): Promise<string> {
  const key = `agent:${m.kernel.state.activeGoalId}/dev`;
  await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
  await waitFor("dev's turn to overrun its budget", () => (m.kernel.state.budgets.get(key)?.consumed ?? 0) > 5000);
  await waitFor("the mesh to go quiet", () => m.scheduler.pending() === 0 && m.scheduler.running() === 0 && m.supervisor.isIdle());
  return key;
}

const seatCards = (m: Mesh, key: string) =>
  [...m.kernel.state.escalations.values()].filter((e) => e.status === "OPEN" && e.conflictKey === `budget:${key}`);

test("seat parking: an exhausted seat is parked and the goal keeps running", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", interests: [], tokens: 5000 },
      { id: "qa", role: "qa", interests: [] },
    ],
    mayContact: { dev: [], qa: [] },
    autoRaise: { enabled: false },
    ...QUIET,
  });
  try {
    let qaTurns = 0;
    stub(m).setScript("dev", async () => ({ ...WAIT, tokensUsed: { input: 6000, output: 3000, total: 9000 } }));
    stub(m).setScript("qa", async () => {
      qaTurns++;
      return WAIT;
    });
    const key = await overrunDev(m);
    await m.supervisor.forceWatchdog();

    assert.equal(goalOf(m)?.status, "ACTIVE", "one seat's ceiling must not halt the mission");
    const cards = seatCards(m, key);
    assert.equal(cards.length, 1, "the parked seat's card goes to the operator");
    assert.equal(cards[0]!.reason, "agent_budget_exhausted");

    const parked = await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    assert.equal(parked.queued, false, "the parked seat takes no turns");
    assert.match(String(parked.blocked), /budget/);

    const woke = await m.supervisor.activateAgent("qa", { kind: "manual" }, { explicit: true });
    assert.equal(woke.queued, true, "every other seat keeps working");
    await waitFor("qa's turn", () => qaTurns === 1);
  } finally {
    await m.cleanup();
  }
});

test("seat parking: an operator raise un-parks the seat and retires its card", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", interests: [], tokens: 5000 },
      { id: "qa", role: "qa", interests: [] },
    ],
    mayContact: { dev: [], qa: [] },
    autoRaise: { enabled: false },
    ...QUIET,
  });
  try {
    let devTurns = 0;
    stub(m).setScript("dev", async () => {
      devTurns++;
      return { ...WAIT, tokensUsed: { input: 6000, output: 3000, total: 9000 } };
    });
    stub(m).setScript("qa", async () => WAIT);
    const key = await overrunDev(m);
    await m.supervisor.forceWatchdog();
    assert.equal(seatCards(m, key).length, 1, "precondition: the seat is parked with a card");

    const raised = await m.supervisor.raiseBudget(key, { limit: 100_000 });
    assert.equal(raised.ok, true, raised.reason);
    assert.equal(seatCards(m, key).length, 0, "the raise answered the card");
    await waitFor("the un-parked seat to be woken", () => devTurns === 2);
    assert.equal(goalOf(m)?.status, "ACTIVE");
  } finally {
    await m.cleanup();
  }
});

test("seat parking: a raise above the mission cap says so, in the response and in the event", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", interests: [], tokens: 5000 },
      { id: "qa", role: "qa", interests: [], tokens: 5000 },
    ],
    mayContact: { dev: [], qa: [] },
    missionTokens: 60_000,
    mode: "parked",
  });
  try {
    const goalId = m.kernel.state.activeGoalId!;
    const key = `agent:${goalId}/dev`;
    m.supervisor.deps.budget.declare(key, "tokens", 5000);
    // Measured: tech-lead raised to 22,000,000 on a mesh whose mission cap was
    // 12,640,000, and nothing anywhere said the seat limit now meant nothing.
    const res = (await m.supervisor.raiseBudget(key, { limit: 80_000 })) as { ok: boolean; warnings?: string[] };
    assert.equal(res.ok, true);
    assert.ok((res.warnings ?? []).some((w) => /mission cap/.test(w)), `expected a mission-cap warning, got ${JSON.stringify(res.warnings)}`);
    const evt = (await m.store.read()).find((e) => e.type === "budget.limit_raised");
    assert.ok(Array.isArray((evt?.payload as { warnings?: unknown }).warnings), "the warning is event-sourced, not only returned");

    const quiet = (await m.supervisor.raiseBudget(`agent:${goalId}/qa`, { limit: 6000 })) as { ok: boolean; warnings?: string[] };
    assert.equal(quiet.ok, true);
    assert.ok(
      !(quiet.warnings ?? []).some((w) => /above the mission cap \(/.test(w) && /qa/.test(w)),
      "a seat raise that stays under the cap does not claim to be over it",
    );
  } finally {
    await m.cleanup();
  }
});

test("seat parking: budget.reserved records the ledger's live limit, not the declared one", async () => {
  const m = await makeMesh({ agents: [{ id: "dev", role: "developer", interests: [], tokens: 5000 }], mayContact: { dev: [] }, mode: "parked" });
  try {
    const key = `agent:${m.kernel.state.activeGoalId}/dev`;
    const budget = m.supervisor.deps.budget;
    budget.declare(key, "tokens", 5000);
    await budget.raiseLimit(key, 40_000, { decidedBy: "auto" });
    const r = await budget.reserve(key, "tokens", 1000, 5000);
    assert.equal(r.blocked, false);
    const evt = [...(await m.store.read())].reverse().find((e) => e.type === "budget.reserved");
    assert.equal((evt?.payload as { limit?: number }).limit, 40_000, "the hold was taken against 40k, so the event must say 40k");
  } finally {
    await m.cleanup();
  }
});

function verdictState(ledgers: Record<string, { limit: number; consumed: number }>, seats: string[]): Projections {
  const budgets = new Map<string, unknown>();
  for (const [seat, l] of Object.entries(ledgers)) {
    const key = `agent:g/${seat}`;
    budgets.set(key, { key, limitKind: "tokens", limit: l.limit, consumed: l.consumed, reserved: 0, exceeded: true, reservations: new Map() });
  }
  return {
    activeGoalId: "g",
    goals: new Map([["g", { id: "g", acceptanceCriteria: [], status: "ACTIVE" }]]),
    budgets,
    agents: new Map(seats.map((s) => [s, { definition: { id: s, budget: { tokens: 1000 } }, state: { agentId: s, lifecycle: "IDLE" } }])),
    threads: new Map(),
    artifacts: new Map(),
    eventsSinceActivation: new Map(),
    escalations: new Map(),
    tasks: new Map(),
    pendingRequests: new Map(),
    unread: new Map(),
    eventCount: 1,
  } as never as Projections;
}

const HARD = {
  budgets: { autoRaise: { enabled: false, factor: 2, maxMultiple: 8 }, perAgent: {}, agentDefaults: { tokens: null }, threadTokens: 5000, mission: { tokens: 1e9, wallClockMinutes: 1e6, maxEvents: 1e9 } },
} as never as ResolvedMeshConfig;

test("seat parking: the verdict halts the goal only when every live seat is parked", () => {
  const tm = new TerminationManager();
  const one = tm.evaluate({ state: verdictState({ dev: { limit: 1000, consumed: 1200 } }, ["dev", "qa"]), config: HARD, wallClockMs: 1 });
  assert.equal(one.kind, "continue", "qa can still work, so dev's ceiling is dev's card, not the mission's");

  const all = tm.evaluate({
    state: verdictState({ dev: { limit: 1000, consumed: 1200 }, qa: { limit: 1000, consumed: 1100 } }, ["dev", "qa"]),
    config: HARD,
    wallClockMs: 1,
  });
  assert.equal(all.kind, "escalate", "with nobody left who can take a turn, the mission is stopped whatever the cards say");
  assert.equal(all.kind === "escalate" ? all.reason : undefined, "agent_budget_exhausted");
});
