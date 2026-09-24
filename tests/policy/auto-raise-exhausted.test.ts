import { test } from "node:test";
import assert from "node:assert/strict";
import { autoRaiseExhausted, configuredBudgetLimit, TURN_RESERVE_TOKENS } from "../../packages/core/src/budgets";
import type { Projections } from "../../packages/core/src/state";
import type { ResolvedMeshConfig } from "../../packages/config/src/index";

/**
 * `autoRaiseExhausted` is the conjunct that stopped the termination verdict
 * escalating on a latch that was about to be cleared. It exists to mirror
 * `tryAutoRaise`'s bail set exactly, so these tests walk that bail set rather
 * than any behaviour of the mesh: if the two ever disagree, the verdict
 * escalates a ledger the sweep then raises, which is the bug it replaced.
 *
 * "true" means "nothing will raise this, so the latch is final" — i.e. escalate.
 */

function fixture(opts: {
  limit?: number | null;
  consumed?: number;
  reserved?: number;
  declared?: number | null;
  autoRaise?: { enabled?: boolean; factor?: number; maxMultiple?: number } | undefined;
  key?: string;
  withLedger?: boolean;
}): { state: Projections; config: ResolvedMeshConfig; key: string } {
  const key = opts.key ?? "agent:g1/dev";
  const budgets = new Map<string, unknown>();
  if (opts.withLedger !== false) {
    budgets.set(key, {
      key,
      limitKind: "tokens",
      limit: opts.limit === undefined ? 1000 : opts.limit,
      consumed: opts.consumed ?? 1000,
      reserved: opts.reserved ?? 0,
      exceeded: true,
      reservations: new Map(),
    });
  }
  const state = {
    activeGoalId: "g1",
    agents: new Map([["dev", { definition: { budget: { tokens: opts.declared === undefined ? 1000 : opts.declared } } }]]),
    budgets,
  } as never as Projections;
  const config = {
    budgets: {
      autoRaise: opts.autoRaise,
      perAgent: {},
      agentDefaults: { tokens: null },
      threadTokens: 5000,
    },
  } as never as ResolvedMeshConfig;
  return { state, config, key };
}

const ON = { enabled: true, factor: 2, maxMultiple: 8 };

test("autoRaiseExhausted: a ledger below its ceiling is NOT exhausted — the latch is not final", () => {
  const { state, config, key } = fixture({ autoRaise: ON, limit: 1000, consumed: 1000 });
  assert.equal(
    autoRaiseExhausted(state, config, key),
    false,
    "1000/8000 ceiling with auto-raise on: the sweep will raise this, so the verdict must not escalate it",
  );
});

test("autoRaiseExhausted: auto-raise disabled makes every latch final", () => {
  const { state, config, key } = fixture({ autoRaise: { enabled: false, factor: 2, maxMultiple: 8 }, limit: 1000 });
  assert.equal(autoRaiseExhausted(state, config, key), true);
});

test("autoRaiseExhausted: an `autoRaise` block absent from the config entirely reads as final", () => {
  // The landmine. Several termination tests pass `{ budgets: { mission } } as never`,
  // so a bare `config.budgets.autoRaise.enabled` throws on them — and the honest
  // answer for a mesh with no auto-raise configured is that the latch IS final.
  const { state, config, key } = fixture({ autoRaise: undefined, limit: 1000 });
  assert.equal(autoRaiseExhausted(state, config, key), true);
  assert.doesNotThrow(() => autoRaiseExhausted(state, config, key), "must not throw on a config without budgets.autoRaise");
});

test("autoRaiseExhausted: no declared limit means no anchor for a ceiling, so it is final", () => {
  const { state, config, key } = fixture({ autoRaise: ON, declared: null, limit: 1000 });
  assert.equal(autoRaiseExhausted(state, config, key), true, "a seat with no configured budget has no ceiling to raise toward");
});

test("autoRaiseExhausted: a declared limit of zero or less is not an anchor either", () => {
  for (const declared of [0, -1]) {
    const { state, config, key } = fixture({ autoRaise: ON, declared, limit: 1000 });
    assert.equal(autoRaiseExhausted(state, config, key), true, `declared ${declared}`);
  }
});

test("autoRaiseExhausted: a missing ledger, or one with no limit, is final", () => {
  const missing = fixture({ autoRaise: ON, withLedger: false });
  assert.equal(autoRaiseExhausted(missing.state, missing.config, missing.key), true, "no ledger");
  const unlimited = fixture({ autoRaise: ON, limit: null });
  assert.equal(autoRaiseExhausted(unlimited.state, unlimited.config, unlimited.key), true, "an unlimited ledger cannot be exceeded meaningfully");
});

test("autoRaiseExhausted: at the ceiling it is final — and that card carries real information", () => {
  // 8 x 1000 declared. This is the escalation worth waking a human for: the
  // mission wants eight times the budget it asked for.
  const { state, config, key } = fixture({ autoRaise: ON, declared: 1000, limit: 8000, consumed: 8000 });
  assert.equal(autoRaiseExhausted(state, config, key), true);
});

test("autoRaiseExhausted: above the ceiling — an operator raise — is also final", () => {
  // An operator raise puts the limit past the ceiling, so `tryAutoRaise` refuses
  // and the next overrun is a deterministic halt rather than a raced one. That is
  // load-bearing: it is why five of ten live seats stopped being raisable at all.
  const { state, config, key } = fixture({ autoRaise: ON, declared: 1000, limit: 18_000, consumed: 18_000 });
  assert.equal(autoRaiseExhausted(state, config, key), true);
});

// The last bail, `next <= ledger.limit`, and the arm that defeats it. Both use
// the same ceiling and the same limit so that only consumption differs — which
// is the whole point: whether a raise is worth doing depends on what the ledger
// still has to cover, not on the factor alone.
const FACTOR_ONE = { enabled: true, factor: 1, maxMultiple: 8 };

test("autoRaiseExhausted: a raise that would not move the limit is final", () => {
  // ceiling 160k, limit already 100k, and 100k covers a turn's reserve outright:
  // `next` computes back to 100k, so `tryAutoRaise` bails and nothing will move.
  const { state, config, key } = fixture({ autoRaise: FACTOR_ONE, declared: 20_000, limit: 100_000, consumed: 0, reserved: 0 });
  assert.equal(autoRaiseExhausted(state, config, key), true, "a factor that cannot move the limit, on a ledger with room to spare");
});

test("autoRaiseExhausted: the turn's own demand is what makes the same raise worth doing", () => {
  // Identical ceiling and limit; only `consumed` moves. Now
  // `consumed + reserved + TURN_RESERVE_TOKENS` exceeds the limit, so the raise
  // clears the turn's demand and the ledger is raisable after all.
  const consumed = 100_000 - Math.floor(TURN_RESERVE_TOKENS / 2);
  const { state, config, key } = fixture({ autoRaise: FACTOR_ONE, declared: 20_000, limit: 100_000, consumed, reserved: 0 });
  assert.equal(autoRaiseExhausted(state, config, key), false, "a turn's reserve pushes `next` above the limit, so this is raisable");
});

test("configuredBudgetLimit: the declared limit wins over the config fallbacks, in order", () => {
  const seatWins = fixture({ autoRaise: ON, declared: 777 });
  assert.equal(configuredBudgetLimit(seatWins.state, seatWins.config, "agent:g1/dev"), 777);

  const noSeat = {
    activeGoalId: "g1",
    agents: new Map(),
    budgets: new Map(),
  } as never as Projections;
  const perAgent = { budgets: { perAgent: { dev: 555 }, agentDefaults: { tokens: 111 }, threadTokens: 5000 } } as never as ResolvedMeshConfig;
  assert.equal(configuredBudgetLimit(noSeat, perAgent, "agent:g1/dev"), 555, "perAgent before agentDefaults");

  const defaults = { budgets: { perAgent: {}, agentDefaults: { tokens: 111 }, threadTokens: 5000 } } as never as ResolvedMeshConfig;
  assert.equal(configuredBudgetLimit(noSeat, defaults, "agent:g1/dev"), 111, "agentDefaults is the last resort");
  assert.equal(configuredBudgetLimit(noSeat, defaults, "thread:g1/t1"), 5000, "threads read threadTokens");
});

/**
 * The verdict itself. `stall-watchdog.test.ts` already proves the SWEEP raises an
 * exhausted ledger on a quiesced mesh; what it cannot show is the race, because
 * it calls `forceWatchdog()` with nothing in flight. `reserve` emits
 * `budget.exceeded` before its caller awaits `tryAutoRaise`, so a verdict reached
 * in that window used to escalate a ledger that was raised microseconds later —
 * two of five halts in one live run, identifiable only by sequence number.
 *
 * These two assertions are the fix, tested where the fix lives: the verdict now
 * refuses to escalate a ledger anything would raise, so WHEN it reads the latch
 * stops mattering.
 */
function verdictState(limit: number, consumed: number): Projections {
  return {
    activeGoalId: "g",
    goals: new Map([["g", { id: "g", acceptanceCriteria: [], status: "ACTIVE" }]]),
    budgets: new Map([
      ["agent:g/dev", { key: "agent:g/dev", limitKind: "tokens", limit, consumed, reserved: 0, exceeded: true, reservations: new Map() }],
    ]),
    agents: new Map([["dev", { definition: { budget: { tokens: 1000 } }, state: { lifecycle: "IDLE" } }]]),
    threads: new Map(),
    artifacts: new Map(),
    eventsSinceActivation: new Map(),
    escalations: new Map(),
    tasks: new Map(),
    pendingRequests: new Map(),
    eventCount: 1,
  } as never as Projections;
}

const RAISE_ON = { budgets: { autoRaise: ON, perAgent: {}, agentDefaults: { tokens: null }, threadTokens: 5000, mission: { tokens: 1e9, wallClockMinutes: 1e6, maxEvents: 1e9 } } } as never as ResolvedMeshConfig;

test("termination: an exceeded ledger the sweep would raise does NOT escalate the mission", async () => {
  const { TerminationManager } = await import("../../packages/core/src/termination");
  const verdict = new TerminationManager().evaluate({ state: verdictState(1000, 1000), config: RAISE_ON, wallClockMs: 1000 });
  assert.notEqual(
    verdict.kind,
    "escalate",
    "1000/8000 ceiling: reading the latch alone halted the mission here, which is the race this conjunct closes",
  );
});

test("termination: the same ledger AT its ceiling still escalates — the card that matters survives", async () => {
  const { TerminationManager } = await import("../../packages/core/src/termination");
  const verdict = new TerminationManager().evaluate({ state: verdictState(8000, 8000), config: RAISE_ON, wallClockMs: 1000 });
  assert.equal(verdict.kind, "escalate", "at 8x the declared budget nothing will raise it, and a human should decide");
  assert.equal(verdict.kind === "escalate" ? verdict.reason : undefined, "agent_budget_exhausted");
});

test("configuredBudgetLimit: mission and task ledgers are never auto-raised, so they have no anchor", () => {
  const { state, config } = fixture({ autoRaise: ON });
  assert.equal(configuredBudgetLimit(state, config, "mission:g1"), null, "the mission cap is the operator's own statement");
  assert.equal(configuredBudgetLimit(state, config, "task:g1/t1"), null);
  assert.equal(configuredBudgetLimit(state, config, "agent:other-goal/dev"), null, "a key from another goal is not this goal's");
});
