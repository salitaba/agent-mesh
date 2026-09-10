import { test } from "node:test";
import assert from "node:assert/strict";
import { BudgetManager, agentKey, missionKey, taskKey, threadKey } from "../../packages/core/src/budgets";
import { Kernel } from "../../packages/core/src/kernel";
import { MemoryEventStore } from "../../packages/event-store/src/index";
import { FixedClock } from "../../packages/protocol/src/index";

/**
 * Ledger arithmetic for `budgets.ts`, driven the only honest way: through the
 * kernel, so every assertion is about what the PROJECTION did with the emitted
 * event rather than about a number the manager kept to itself.
 *
 * The distinctions under test are the ones the file exists to make — refusing a
 * turn outright vs. granting less than was asked for, an exhaustion signal that
 * fires once vs. once per attempt, and a raise that actually unblocks vs. one
 * that lands under current spend.
 */

function makeBudget() {
  const store = new MemoryEventStore();
  const kernel = new Kernel(store, new FixedClock());
  return { kernel, store, budget: new BudgetManager(kernel) };
}

function ledgerOf(kernel: Kernel, key: string) {
  const b = kernel.state.budgets.get(key);
  if (!b) throw new Error(`no ledger for ${key}`);
  return b;
}

async function types(store: MemoryEventStore): Promise<string[]> {
  return (await store.read()).map((e) => e.type);
}

// ------------------------------------------------------------------ keys

test("budget keys: each scope gets a distinct, parseable namespace", () => {
  assert.equal(missionKey("g1"), "mission:g1");
  assert.equal(agentKey("g1", "dev"), "agent:g1/dev");
  assert.equal(threadKey("g1", "t1"), "thread:g1/t1");
  assert.equal(taskKey("g1", "task-1"), "task:g1/task-1");
  // The scope prefix is load-bearing: termination.ts selects dead ledgers with
  // `startsWith("thread:" + goalId)`, so the goal must follow the prefix.
  assert.ok(threadKey("g1", "t1").startsWith("thread:g1"));
});

// ------------------------------------------------------------------ declare / snapshot

test("declare: creates the ledger without emitting an event, and snapshot reports it", () => {
  const { kernel, budget } = makeBudget();
  budget.declare("mission:g1", "tokens", 500);
  const snap = budget.snapshot();
  assert.deepEqual(snap, [{ key: "mission:g1", limit: 500, limitKind: "tokens", reserved: 0, consumed: 0, exceeded: false }]);
  assert.equal(kernel.state.lastEventSeq, 0, "declaring a cap is not a state transition");
});

// ------------------------------------------------------------------ reserve

test("reserve: an unlimited ledger never blocks and grants exactly what was asked", async () => {
  const { kernel, budget } = makeBudget();
  const r = await budget.reserve("mission:g1", "tokens", 9_999_999, null);
  assert.equal(r.blocked, false);
  assert.equal(r.granted, r.requested);
  assert.ok(r.reservationId.startsWith("res"));
  assert.equal(ledgerOf(kernel, "mission:g1").reserved, 9_999_999);
});

test("reserve: partial headroom grants less than requested instead of refusing", async () => {
  const { kernel, budget } = makeBudget();
  await budget.reserve("mission:g1", "tokens", 60, 100);
  const r = await budget.reserve("mission:g1", "tokens", 50, 100);

  // The point of this branch: not blocked, but the caller must be able to SEE
  // it did not get what it asked for. A `granted === requested` here would be
  // the lie that let a 50-token ask decorate 40 tokens of real headroom.
  assert.equal(r.blocked, false);
  assert.equal(r.requested, 50);
  assert.equal(r.granted, 40);
  assert.equal(ledgerOf(kernel, "mission:g1").reserved, 100);
});

test("reserve: zero headroom blocks and signals exhaustion", async () => {
  const { kernel, store, budget } = makeBudget();
  await budget.reserve("mission:g1", "tokens", 100, 100);
  const r = await budget.reserve("mission:g1", "tokens", 10, 100, { actorId: "dev", goalId: "g1" });

  assert.equal(r.blocked, true);
  assert.equal(r.granted, 0);
  assert.equal(r.reservationId, "", "a blocked reserve holds nothing");
  assert.match(r.reason ?? "", /exhausted \(0\/100\)/);
  assert.ok((await types(store)).includes("budget.exceeded"));
  assert.equal(ledgerOf(kernel, "mission:g1").exceeded, true);
});

test("reserve: already overspent blocks on the consumed total, not on headroom", async () => {
  const { store, budget } = makeBudget();
  budget.declare("mission:g1", "tokens", 100);
  await budget.consume("mission:g1", "tokens", 150);
  const r = await budget.reserve("mission:g1", "tokens", 10, 100);

  assert.equal(r.blocked, true);
  assert.match(r.reason ?? "", /exhausted \(150\/100\)/);
  // consume() already latched it; the reserve must not double-report.
  assert.equal((await types(store)).filter((t) => t === "budget.exceeded").length, 1);
});

test("reserve: exhaustion is announced once per key, not once per refused turn", async () => {
  const { store, budget } = makeBudget();
  await budget.reserve("mission:g1", "tokens", 100, 100);
  await budget.reserve("mission:g1", "tokens", 10, 100);
  await budget.reserve("mission:g1", "tokens", 10, 100);
  await budget.reserve("mission:g1", "tokens", 10, 100);

  assert.equal((await types(store)).filter((t) => t === "budget.exceeded").length, 1);
});

// ------------------------------------------------------------------ consume

test("consume: settling a reservation releases the hold and books the spend", async () => {
  const { kernel, budget } = makeBudget();
  const r = await budget.reserve("agent:g1/dev", "tokens", 100, 1000);
  await budget.consume("agent:g1/dev", "tokens", 80, r.reservationId, { model: "m1" }, { actorId: "dev" });

  const l = ledgerOf(kernel, "agent:g1/dev");
  assert.equal(l.reserved, 0, "the hold must not outlive the spend it was held for");
  assert.equal(l.consumed, 80);
  assert.equal(l.reservations.size, 0);
});

test("consume: crossing the limit latches exceeded and announces it", async () => {
  const { kernel, store, budget } = makeBudget();
  budget.declare("agent:g1/dev", "tokens", 100);
  await budget.consume("agent:g1/dev", "tokens", 60);
  assert.equal(ledgerOf(kernel, "agent:g1/dev").exceeded, false);
  assert.equal((await types(store)).includes("budget.exceeded"), false);

  await budget.consume("agent:g1/dev", "tokens", 60);
  assert.equal(ledgerOf(kernel, "agent:g1/dev").exceeded, true);
  assert.equal((await types(store)).filter((t) => t === "budget.exceeded").length, 1);

  // Already exceeded before this call: no second announcement.
  await budget.consume("agent:g1/dev", "tokens", 60);
  assert.equal((await types(store)).filter((t) => t === "budget.exceeded").length, 1);
});

// ------------------------------------------------------------------ release

test("release: an unknown ledger or an unknown reservation is a silent no-op", async () => {
  const { store, budget } = makeBudget();
  await budget.release("mission:never-declared", "res-1");
  await budget.reserve("mission:g1", "tokens", 10, 100);
  await budget.release("mission:g1", "res-not-mine");

  assert.equal((await types(store)).filter((t) => t === "budget.released").length, 0);
});

test("release: returns exactly the amount that reservation held", async () => {
  const { kernel, store, budget } = makeBudget();
  const a = await budget.reserve("mission:g1", "tokens", 30, 1000);
  await budget.reserve("mission:g1", "tokens", 20, 1000);
  await budget.release("mission:g1", a.reservationId, { actorId: "dev" });

  assert.equal(ledgerOf(kernel, "mission:g1").reserved, 20);
  assert.ok((await types(store)).includes("budget.released"));
  // Releasing twice must not credit the ledger twice.
  await budget.release("mission:g1", a.reservationId);
  assert.equal(ledgerOf(kernel, "mission:g1").reserved, 20);
});

// ------------------------------------------------------------------ raiseLimit

test("raiseLimit: a raise above current spend unblocks and clears the latch", async () => {
  const { kernel, store, budget } = makeBudget();
  budget.declare("mission:g1", "tokens", 100);
  await budget.consume("mission:g1", "tokens", 150);
  assert.equal(ledgerOf(kernel, "mission:g1").exceeded, true);

  const r = await budget.raiseLimit("mission:g1", 500, { actorId: "human", reason: "operator raise" });
  assert.deepEqual({ previous: r.previous, limit: r.limit, unblocked: r.unblocked }, { previous: 100, limit: 500, unblocked: true });
  assert.equal(ledgerOf(kernel, "mission:g1").exceeded, false);
  assert.ok((await types(store)).includes("budget.limit_raised"));

  // The latch is re-armed: a fresh overrun must be able to announce itself.
  await budget.consume("mission:g1", "tokens", 500);
  assert.equal((await types(store)).filter((t) => t === "budget.exceeded").length, 2);
});

test("raiseLimit: a raise that lands under current spend reports itself as still blocked", async () => {
  const { kernel, budget } = makeBudget();
  budget.declare("mission:g1", "tokens", 100);
  await budget.consume("mission:g1", "tokens", 150);

  const r = await budget.raiseLimit("mission:g1", 120);
  assert.equal(r.unblocked, false);
  assert.equal(ledgerOf(kernel, "mission:g1").exceeded, true, "a raise below spend must not clear the latch");
});

test("raiseLimit: a never-declared key raises from an absent previous limit", async () => {
  const { kernel, budget } = makeBudget();
  const r = await budget.raiseLimit("thread:g1/t1", 400, { goalId: "g1" });
  assert.equal(r.previous, null);
  assert.equal(r.unblocked, true);
  assert.equal(ledgerOf(kernel, "thread:g1/t1").limit, 400);
});
