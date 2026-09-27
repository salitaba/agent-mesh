import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, collectEvents, type AgentSpec, type TestMeshOptions } from "../helpers";
import type { StubTurn } from "../../packages/agent-runtime/src/index";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * What actually bounds spend.
 *
 * Two ceilings are documented, and they are different in kind:
 *
 *   - agent and thread ledgers auto-raise, but never past
 *     `declared × budgets.auto_raise.max_multiple` (default 8; `tryAutoRaise`
 *     and `autoRaiseExhausted` in budgets.ts compute the same ceiling);
 *   - the mission ledger is NEVER raised (`configuredBudgetLimit` returns null
 *     for it), so its multiple is 1: the declared cap is the operator's
 *     statement of what the whole mission is worth.
 *
 * Both of those bound a LIMIT. What a ledger has CONSUMED is bounded by neither,
 * because the mission ledger is never reserved against ("The mission ledger is
 * never reserved against", supervisor.ts) and an agent hold that was only
 * partially granted does not cap the turn it admitted. So the mission cap is
 * discovered after it is crossed — by `TerminationManager` reading `consumed >
 * limit` — rather than refused before. The limit properties pass today and are
 * pinned; the consumed properties fail today and are recorded as BUGs.
 */

const WAIT: MeshOp = { op: "wait" } as MeshOp;
const FREE = { input: 0, output: 0, total: 0 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

function seat(id: string, tokens: number): AgentSpec {
  return { id, role: "developer", capabilities: ["repository.read"], interests: [], tokens };
}

/** Replay the log's budget events in order and return every (key, consumed, limit) the ledgers passed through. */
async function ledgerTrace(m: Mesh): Promise<Array<{ key: string; consumed: number; limit: number | null }>> {
  const consumed = new Map<string, number>();
  const limit = new Map<string, number | null>();
  const out: Array<{ key: string; consumed: number; limit: number | null }> = [];
  for (const e of await collectEvents(m)) {
    const p = e.payload as { key?: string; amount?: number; limit?: number | null; limitKind?: string };
    if (!p?.key || (p.limitKind && p.limitKind !== "tokens")) continue;
    if (e.type === "budget.limit_raised") limit.set(p.key, p.limit ?? null);
    else if (e.type === "budget.consumed") {
      if (!limit.has(p.key)) limit.set(p.key, p.limit ?? null);
      consumed.set(p.key, (consumed.get(p.key) ?? 0) + Number(p.amount ?? 0));
    } else continue;
    out.push({ key: p.key, consumed: consumed.get(p.key) ?? 0, limit: limit.get(p.key) ?? null });
  }
  return out;
}

/**
 * Drive one seat through turns that each cost `spend`, one at a time, until the
 * mesh stops admitting them (a blocked reserve, an escalated goal) or `max` turns.
 */
async function driveSequential(m: Mesh, spend: number, max: number): Promise<void> {
  stub(m).setScript("dev", async () => ({ operations: [WAIT], tokensUsed: { input: spend, output: 0, total: spend } }));
  const settled = () => m.supervisor.getRecentTurns(500).filter((t) => t.agentId === "dev" && t.status !== "running").length;
  for (let i = 0; i < max; i++) {
    const before = settled();
    const r = await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    if (!r.queued) return;
    try {
      await waitFor("the turn to settle", () => settled() > before && m.scheduler.running() === 0, 5000);
    } catch {
      return;
    }
    await sleep(60);
    const blocked = (await collectEvents(m)).some(
      (e) => e.type === "turn.discarded" && (e.payload as { reason?: string }).reason === "budget_blocked",
    );
    if (blocked) return;
  }
}

function baseMesh(extra: Partial<TestMeshOptions>): Promise<Mesh> {
  return makeMesh({
    agents: [seat("dev", 10_000)],
    startup: [],
    mayContact: { dev: [] },
    // The stall watchdog would wake seats on its own; these tests drive every turn.
    stallIdleMs: 600_000,
    stallCooldownMs: 600_000,
    stallNoopRetryMs: 600_000,
    ...extra,
  });
}

test(
  "concurrent turns that each fit their seat's ledger are not both admitted against a mission cap that pays for one",
  async () => {
    const CAP = 20_000;
    const m = await makeMesh({
      agents: [seat("a", 500_000), seat("b", 500_000)],
      startup: [],
      mayContact: { a: [], b: [] },
      missionTokens: CAP,
      autoRaise: { enabled: false },
      stallIdleMs: 600_000,
    });
    try {
      let inModel = 0;
      let maxInModel = 0;
      const admissions: Array<{ agent: string; consumed: number; reserved: number; limit: number | null }> = [];
      const script = (agent: string) => async (_input: unknown, idx: number): Promise<StubTurn> => {
        if (idx > 0) return { operations: [WAIT], tokensUsed: FREE };
        const goalId = m.kernel.state.activeGoalId!;
        const mission = m.kernel.state.budgets.get(`mission:${goalId}`)!;
        admissions.push({ agent, consumed: mission.consumed, reserved: mission.reserved, limit: mission.limit });
        inModel++;
        maxInModel = Math.max(maxInModel, inModel);
        // Inside the runtime call, so the two turns overlap in the model the way
        // two seats working in parallel do.
        await sleep(400);
        inModel--;
        // Each well inside the 32k hold its own ledger granted it.
        return { operations: [WAIT], tokensUsed: { input: 15_000, output: 0, total: 15_000 } };
      };
      stub(m).setScript("a", script("a"));
      stub(m).setScript("b", script("b"));
      await Promise.all([
        m.supervisor.activateAgent("a", { kind: "manual" }, { explicit: true }),
        m.supervisor.activateAgent("b", { kind: "manual" }, { explicit: true }),
      ]);
      await waitFor("both seats to have been admitted or turned away", () =>
        ["a", "b"].every((id) => m.supervisor.getRecentTurns(50).some((t) => t.agentId === id && t.status !== "running")), 8000);
      await sleep(150);

      assert.ok(admissions.length >= 1, "precondition: at least one turn reached the model");
      for (const a of admissions) {
        // "Prevented, not discovered": a turn in the model is a commitment against
        // the mission, so the mission must be holding for it...
        assert.ok(a.reserved > 0, `${a.agent} reached the model with nothing held against the mission ledger`);
        assert.ok(a.limit === null || a.consumed + a.reserved <= a.limit, `${a.agent}: holds past the mission cap were admitted`);
      }
      // ...and a cap that one 32k hold already exhausts cannot admit a second
      // concurrent turn at all.
      assert.equal(maxInModel, 1, "two turns were in the model at once against a mission cap that could pay for one");
    } finally {
      await m.cleanup();
    }
  },
);

test(
  "property: the mission ledger's consumed never passes its cap (multiple 1 — the mission is never auto-raised)",
  async () => {
    // 14k, not 10k: admission holds 1.5x the seat's average turn (>= 4k), so
    // 3.5k turns land three times (10.5k) and the fourth is refused. Under the
    // old unreserved mission ledger this ran on to 17.5k before the watchdog
    // noticed. A 10k cap admits only two, and could not meet the precondition.
    const CAP = 14_000;
    const m = await baseMesh({ agents: [seat("dev", 500_000)], missionTokens: CAP, autoRaise: { enabled: false } });
    try {
      await driveSequential(m, 3500, 12);
      const trace = (await ledgerTrace(m)).filter((t) => t.key.startsWith("mission:"));
      assert.ok(trace.length >= 3, "precondition: several turns were billed to the mission");
      for (const t of trace) {
        assert.ok(t.consumed <= CAP, `mission ledger reached ${t.consumed} against a ${CAP} cap`);
      }
    } finally {
      await m.cleanup();
    }
  },
);

test(
  "property: a seat's consumed never passes declared × max_multiple",
  async () => {
    // declared 10k, factor 2, max 3x → ceiling 30k. 3.5k turns do not divide it.
    const m = await baseMesh({ missionTokens: 10_000_000, autoRaise: { enabled: true, factor: 2, maxMultiple: 3 } });
    try {
      await driveSequential(m, 3500, 20);
      const trace = (await ledgerTrace(m)).filter((t) => t.key.endsWith("/dev") && t.key.startsWith("agent:"));
      assert.ok(trace.some((t) => t.consumed > 10_000), "precondition: the seat spent past its declared budget (auto-raise engaged)");
      for (const t of trace) {
        assert.ok(t.consumed <= 30_000, `seat ledger reached ${t.consumed} against a 30000 ceiling (10000 × 3)`);
      }
    } finally {
      await m.cleanup();
    }
  },
);

test("property: auto-raise lifts a seat's LIMIT to declared × max_multiple and no further, and never lifts the mission's", async () => {
  // The bound that does hold. Driven hard enough that the seat reaches its
  // ceiling AND the mission overruns, so both halves are exercised: the sweep
  // runs on every watchdog tick over every exceeded ledger, and the mission's
  // must be skipped every time.
  const DECLARED = 10_000;
  const MISSION = 20_000;
  const m = await baseMesh({ missionTokens: MISSION, autoRaise: { enabled: true, factor: 2, maxMultiple: 3 } });
  try {
    await driveSequential(m, 3500, 20);
    const goalId = m.kernel.state.activeGoalId!;
    // Admission now holds against the mission, so evenly-sized turns stop at
    // the cap instead of crossing it. The one way it is still crossed is a turn
    // that outspends its own hold, which a model can always do; book one here
    // so the sweep has an overrun mission ledger in hand.
    const mission = m.kernel.state.budgets.get(`mission:${goalId}`)!;
    await m.supervisor.deps.budget.consume(`mission:${goalId}`, "tokens", MISSION - mission.consumed + 5000, undefined, {}, { actorId: "dev" });
    await m.supervisor.forceWatchdog();
    const raises = (await collectEvents(m))
      .filter((e) => e.type === "budget.limit_raised")
      .map((e) => e.payload as { key: string; limit: number });
    const seatRaises = raises.filter((r) => r.key === `agent:${goalId}/dev`);
    assert.ok(seatRaises.length >= 1, "precondition: the seat's ledger was auto-raised");
    assert.ok(
      m.kernel.state.budgets.get(`mission:${goalId}`)!.consumed > MISSION,
      "precondition: the mission ledger overran, so the sweep had it in hand",
    );
    for (const r of seatRaises) {
      assert.ok(r.limit <= DECLARED * 3, `a seat raise to ${r.limit} passed the ${DECLARED * 3} ceiling`);
    }
    assert.deepEqual(
      raises.filter((r) => r.key.startsWith("mission:")),
      [],
      "the mission cap is the operator's number — nothing in the runtime may raise it",
    );
    assert.equal(m.kernel.state.budgets.get(`mission:${goalId}`)!.limit, MISSION);
  } finally {
    await m.cleanup();
  }
});
