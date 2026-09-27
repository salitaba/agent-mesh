import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, collectEvents } from "../helpers";

/**
 * A turn the mesh kills must still be billed for what it spent.
 *
 * `consume` sits on the success path, past the op loop, so a throw escaped
 * upstream of it and the `finally` handed the reservations back at zero cost.
 * Measured 2026-09-24: one 20-minute backend timeout spent 295,953 tokens — 123%
 * of that seat's entire budget — and left the agent, mission and thread ledgers
 * reading exactly what they read before it started. The 8x ceiling that halts a
 * mission is computed from those ledgers, so the halt was blind to the single
 * most expensive turn of the run, and the seat restarted with a clean slate.
 *
 * The figure only exists when the backend answered the abort with usage. When it
 * did not, the turn must be billed NOTHING rather than zero — an invented zero
 * would poison the EWMA that sizes the next reservation.
 */

const AGENTS = [{ id: "dev", role: "developer", capabilities: ["repository.read"], interests: [], tokens: 500_000 }];

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

async function consumedFor(m: Mesh, keyFragment: string): Promise<number[]> {
  const events = await collectEvents(m);
  return events
    .filter((e) => e.type === "budget.consumed")
    .map((e) => e.payload as Record<string, unknown>)
    .filter((p) => String(p.key ?? "").includes(keyFragment))
    .map((p) => Number(p.amount ?? 0));
}

async function timedOutMesh(interruptUsage?: { input: number; output: number; total: number }): Promise<Mesh> {
  const m = await makeMesh({
    agents: AGENTS,
    startup: [],
    // A hard wall: with auto-raise on, an overrun is absorbed rather than shown.
    autoRaise: { enabled: false },
    turnTimeoutMs: 250,
  });
  // Longer than the timeout AND than the usage-grace window, so the turn cannot
  // win the race and settle normally.
  stub(m).setScript("dev", async () => ({ delayMs: 60_000, ...(interruptUsage ? { interruptUsage } : {}) }));
  await m.supervisor.activateAgent("dev", { kind: "manual" });
  await waitFor("the timed-out turn to finish", async () => {
    const events = await collectEvents(m);
    return events.some((e) => e.type === "turn.discarded");
  }, 15_000);
  return m;
}

test("a timed-out turn that reported usage is billed to agent and mission", async () => {
  const m = await timedOutMesh({ input: 900, output: 100, total: 1000 });
  try {
    const discarded = (await collectEvents(m))
      .filter((e) => e.type === "turn.discarded")
      .map((e) => e.payload as Record<string, unknown>);
    assert.equal(discarded.length, 1);
    assert.equal(discarded[0]!.reason, "timeout", "precondition: this is the timeout path, not silence");
    assert.equal(discarded[0]!.tokens, 1000, "precondition: the abort carried usage");

    assert.deepEqual(await consumedFor(m, "agent:"), [1000], "the seat's own ledger must carry the spend");
    assert.deepEqual(await consumedFor(m, "mission:"), [1000], "and so must the mission");
  } finally {
    await m.cleanup();
  }
});

test("a timed-out turn with no reported usage bills nothing, not zero", async () => {
  const m = await timedOutMesh(undefined);
  try {
    const discarded = (await collectEvents(m))
      .filter((e) => e.type === "turn.discarded")
      .map((e) => e.payload as Record<string, unknown>);
    assert.equal(discarded[0]!.tokens, undefined, "precondition: the backend reported nothing");
    // An invented 0 would be indistinguishable from a measured 0 and would feed
    // the turn-cost EWMA a number no backend produced.
    assert.deepEqual(await consumedFor(m, "agent:"), []);
    assert.deepEqual(await consumedFor(m, "mission:"), []);
  } finally {
    await m.cleanup();
  }
});

test("the hold is released, not left outstanding, once the spend is settled", async () => {
  const m = await timedOutMesh({ input: 900, output: 100, total: 1000 });
  try {
    // Judged by THIS turn's holds, not the ledger's running total: a failed turn
    // schedules a retry, and under load the retry has already taken its own
    // (legitimate) 32k hold by the time this reads the ledger.
    const events = await collectEvents(m);
    const discardAt = events.findIndex((e) => e.type === "turn.discarded");
    const payloads = (type: string, upTo = events.length) =>
      events.slice(0, upTo).filter((e) => e.type === type).map((e) => e.payload as Record<string, unknown>)
        .filter((p) => String(p.key ?? "").includes("agent:"));
    const held = payloads("budget.reserved", discardAt).map((p) => String(p.reservationId));
    assert.ok(held.length > 0, "precondition: the timed-out turn held the agent ledger");
    const ledger = [...m.kernel.state.budgets.entries()].find(([k]) => k.includes("agent:"))?.[1];
    assert.ok(ledger, "the agent ledger exists");
    for (const id of held) {
      assert.equal(ledger!.reservations.has(id), false, `a settled reservation (${id}) must not outlive the turn it was held for`);
    }
    const billed = payloads("budget.consumed").filter((p) => held.includes(String(p.reservationId))).map((p) => Number(p.amount));
    assert.deepEqual(billed, [1000], "the turn's spend is settled against its own hold, once");
  } finally {
    await m.cleanup();
  }
});

test("an ordinary turn is billed exactly once — the discard path must not double-count", async () => {
  const m = await makeMesh({ agents: AGENTS, startup: [], autoRaise: { enabled: false } });
  try {
    stub(m).setScript("dev", async () => ({ operations: [{ op: "done" }], tokensUsed: { input: 60, output: 40, total: 100 } }));
    await m.supervisor.activateAgent("dev", { kind: "manual" });
    await waitFor("the turn to settle", () => m.supervisor.isIdle(), 8000);
    // The success path empties `openReservations`, which is exactly what stops the
    // `finally` from billing a turn that already paid. A `rotation_handoff` or
    // `no_ops` discard returns normally and lands here too.
    assert.deepEqual(await consumedFor(m, "agent:"), [100]);
    assert.deepEqual(await consumedFor(m, "mission:"), [100]);
  } finally {
    await m.cleanup();
  }
});
