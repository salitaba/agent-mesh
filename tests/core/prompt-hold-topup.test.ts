import { test } from "node:test";
import assert from "node:assert/strict";
import { topUpPromptHold } from "../../packages/core/src/supervisor";
import type { BudgetManager, BudgetKey } from "../../packages/core/src/budgets";

/**
 * The pre-flight hold is taken before the prompt exists, sized from the agent's
 * rolling average turn cost. An agent with a cheap history is therefore admitted
 * on a small hold and can then be handed a far larger prompt — at which point
 * the hold is not a bound on anything, it is a number that happened to pass.
 *
 * The top-up closes that gap, and its load-bearing property is counter-intuitive
 * enough to be worth pinning: a REFUSED top-up must not kill the turn. The turn
 * already cleared pre-flight, the bundle is already at its tightest tier, and
 * failing here would throw away the assembly to save nothing — settlement
 * charges the true cost either way.
 */

/** Records every reserve call and answers from a scripted ledger. */
function fakeBudget(script: Array<{ granted: number; blocked: boolean }>) {
  const calls: Array<{ key: BudgetKey; kind: string; amount: number; limit: number | null }> = [];
  let i = 0;
  const budget: Pick<BudgetManager, "reserve"> = {
    reserve: async (key, kind, amount, limit) => {
      calls.push({ key, kind, amount, limit });
      const next = script[Math.min(i++, script.length - 1)] ?? { granted: amount, blocked: false };
      return {
        reservationId: `res-${calls.length}`,
        blocked: next.blocked,
        requested: amount,
        granted: next.granted,
      };
    },
  };
  return { budget, calls };
}

const agentTarget = { key: "agent:g/dev", limit: 100_000 };
const threadTarget = { key: "thread:g/t1", limit: 60_000 };

test("a prompt that fits inside its hold costs no extra reservation", async () => {
  const { budget, calls } = fakeBudget([]);
  const out = await topUpPromptHold(budget, {
    agentId: "dev",
    promptTokens: 3_000,
    reserveAmount: 4_000,
    targets: [agentTarget, threadTarget],
  });

  assert.equal(out.topUp, 0);
  assert.deepEqual(calls, [], "reserving zero would still write a ledger entry for nothing");
  assert.deepEqual(out.reservations, []);
  assert.deepEqual(out.shortfalls, []);
});

test("an exactly-sized hold is not topped up", async () => {
  const { budget, calls } = fakeBudget([]);
  const out = await topUpPromptHold(budget, {
    agentId: "dev",
    promptTokens: 4_000,
    reserveAmount: 4_000,
    targets: [agentTarget],
  });
  assert.equal(out.topUp, 0);
  assert.equal(calls.length, 0);
});

test("an under-sized hold is raised on every ledger the turn is charged to", async () => {
  const { budget, calls } = fakeBudget([]);
  const out = await topUpPromptHold(budget, {
    agentId: "dev",
    promptTokens: 25_000,
    reserveAmount: 4_000,
    targets: [agentTarget, threadTarget],
  });

  assert.equal(out.topUp, 21_000, "the difference, not the whole prompt — the original hold still stands");
  assert.equal(calls.length, 2, "the thread ledger pays for this turn too; topping up only the agent hides it");
  assert.deepEqual(calls.map((c) => c.key), ["agent:g/dev", "thread:g/t1"]);
  assert.deepEqual(calls.map((c) => c.amount), [21_000, 21_000]);
  assert.deepEqual(calls.map((c) => c.limit), [100_000, 60_000]);
  assert.equal(calls[0].kind, "tokens");
  assert.equal(out.reservations.length, 2, "both ids must survive, or settlement leaks a held reservation");
  assert.deepEqual(out.shortfalls, []);
});

test("a turn with no thread tops up only its agent ledger", async () => {
  const { budget, calls } = fakeBudget([]);
  await topUpPromptHold(budget, {
    agentId: "dev",
    promptTokens: 9_000,
    reserveAmount: 4_000,
    targets: [agentTarget],
  });
  assert.deepEqual(calls.map((c) => c.key), ["agent:g/dev"]);
});

test("a blocked top-up is reported, not thrown — the turn survives it", async () => {
  const { budget } = fakeBudget([{ granted: 0, blocked: true }]);
  const out = await topUpPromptHold(budget, {
    agentId: "dev",
    promptTokens: 25_000,
    reserveAmount: 4_000,
    targets: [agentTarget],
  });

  assert.equal(out.shortfalls.length, 1, "the caller needs something to audit");
  assert.equal(out.shortfalls[0].key, "agent:g/dev");
  assert.equal(out.shortfalls[0].blocked, true);
  assert.equal(out.shortfalls[0].granted, 0);
  assert.equal(out.shortfalls[0].requested, 21_000);
  // Even a fully blocked reserve hands back an id. Dropping it here would leave
  // the reservation open forever, since settlement releases only what it is told
  // about.
  assert.equal(out.reservations.length, 1);
});

test("a partial grant counts as a shortfall", async () => {
  // The dangerous case: nothing is "blocked", so a check on that flag alone
  // reads this as success while the ledger covered a third of the ask.
  const { budget } = fakeBudget([{ granted: 7_000, blocked: false }]);
  const out = await topUpPromptHold(budget, {
    agentId: "dev",
    promptTokens: 25_000,
    reserveAmount: 4_000,
    targets: [agentTarget],
  });

  assert.equal(out.shortfalls.length, 1);
  assert.equal(out.shortfalls[0].blocked, false);
  assert.equal(out.shortfalls[0].granted, 7_000);
  assert.equal(out.shortfalls[0].requested, 21_000);
});

test("one ledger refusing does not stop the other from being charged", async () => {
  const { budget, calls } = fakeBudget([
    { granted: 0, blocked: true },      // agent ledger is exhausted
    { granted: 21_000, blocked: false }, // thread ledger still has room
  ]);
  const out = await topUpPromptHold(budget, {
    agentId: "dev",
    promptTokens: 25_000,
    reserveAmount: 4_000,
    targets: [agentTarget, threadTarget],
  });

  assert.equal(calls.length, 2, "an early return here would silently under-charge the thread");
  assert.equal(out.shortfalls.length, 1);
  assert.equal(out.shortfalls[0].key, "agent:g/dev");
  assert.equal(out.reservations.length, 2);
});

test("an unlimited ledger is passed through as null, not coerced to a number", async () => {
  const { budget, calls } = fakeBudget([]);
  await topUpPromptHold(budget, {
    agentId: "dev",
    promptTokens: 25_000,
    reserveAmount: 4_000,
    // An agent with no configured token budget. `0` here would read as "no
    // headroom at all" and block every turn.
    targets: [{ key: "agent:g/dev", limit: null }],
  });
  assert.equal(calls[0].limit, null);
});
