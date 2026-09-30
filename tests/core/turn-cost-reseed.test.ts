import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { makeMesh, stub, waitFor, collectEvents, type AgentSpec, type TestMesh, type TestMeshOptions } from "../helpers";
import { bootstrapMesh, type MeshInstance } from "../../apps/mesh-server/src/index";
import { agentKey } from "../../packages/core/src/budgets";
import type { MeshEvent, MeshOp } from "../../packages/protocol/src/index";

/**
 * A seat's turn-cost estimate survives a restart.
 *
 * `turnCostEstimate` sizes every turn's hold, and an EMPTY estimate means two
 * things at once: the 32k no-history ask, and `allowPartial` — a hold granted
 * short, which cannot cap a turn. It was process memory, so every restart put
 * every seat back on that path, and both budget overruns in the 2026-09-28 log
 * were a seat's first turn after a child boot:
 *   08:16Z marketing asked 32,000, got 32,000, spent 113,914 of 113,327 left;
 *   13:13Z explorer asked 32,000, got 1,627, spent 96,494 of 33,627 left.
 * With the estimate replayed, each ask is ~1.5x a ~100k turn, the hold is
 * refused, and the seat is parked at the door having spent nothing.
 *
 * `autoRaise` is off in every fixture here, so each limited ledger is on its
 * last rung and the hold is the seat's real, uncapped estimate — the live case.
 */

type Mesh = MeshInstance;

const usage = (total: number) => ({ input: Math.round(total * 0.9), output: total - Math.round(total * 0.9), total });
const estimate = (m: Mesh, id: string) => (m.supervisor as unknown as { turnCostEstimate: Map<string, number> }).turnCostEstimate.get(id);
const goalIdOf = (m: Mesh) => m.kernel.state.activeGoalId!;
const ledger = (m: Mesh, id: string) => m.kernel.state.budgets.get(agentKey(goalIdOf(m), id));
const eventsOf = async (m: Mesh, type: string, pred: (p: Record<string, unknown>) => boolean = () => true): Promise<MeshEvent[]> =>
  (await collectEvents(m)).filter((e) => e.type === type && pred((e.payload ?? {}) as Record<string, unknown>));

/** Run one turn of `id` to its end. */
async function turn(m: Mesh, id: string): Promise<void> {
  const before = m.supervisor.getRecentTurns(200).filter((t) => t.agentId === id && t.status !== "running").length;
  const r = await m.supervisor.activateAgent(id, { kind: "manual" });
  assert.equal(r.queued, true, r.blocked);
  await waitFor(`${id}'s turn ended`, () => m.supervisor.getRecentTurns(200).filter((t) => t.agentId === id && t.status !== "running").length > before && !m.supervisor.isTurnInFlight(id));
}

async function acrossARestart(opts: TestMeshOptions, firstLife: (m: TestMesh) => Promise<void>, secondLife: (m: Mesh) => Promise<void>): Promise<void> {
  const first = await makeMesh({ ...opts, persist: true });
  try {
    try {
      await firstLife(first);
    } finally {
      await first.close();
      first.stubRuntimes.get("stub")?.releaseHangs();
    }
    const second = await bootstrapMesh({ configPath: path.join(first.dir, "mesh.yaml"), inMemory: false, useGit: false, mode: "live" });
    try {
      await secondLife(second);
    } finally {
      await second.close();
      second.stubRuntimes.get("stub")?.releaseHangs();
    }
  } finally {
    fs.rmSync(first.dir, { recursive: true, force: true });
  }
}

const AGENTS: AgentSpec[] = [
  // Roomy: its next hold is simply 1.5x what its turns cost.
  { id: "dev", role: "developer", capabilities: ["repository.read"], interests: [], tokens: 1_000_000 },
  // The live case: one ~100k turn spent, 50k left, so a typical turn does not fit.
  { id: "qa", role: "qa", capabilities: ["repository.read"], interests: [], tokens: 150_000 },
  // Never ran: keeps today's permissive first turn. Declared below 32k on purpose.
  { id: "pm", role: "pm", capabilities: ["repository.read"], interests: [], tokens: 20_000 },
];
const OPTS: TestMeshOptions = {
  agents: AGENTS,
  startup: [],
  mayContact: { dev: ["qa", "pm"], qa: ["dev", "pm"], pm: ["dev", "qa"] },
  autoRaise: { enabled: false },
};

test("restart: the estimate is replayed, so the first turn back asks 1.5x it and a seat that cannot afford one is refused at the door", async () => {
  let liveDev: number | undefined;
  await acrossARestart(
    OPTS,
    async (first) => {
      stub(first).setScript("dev", (_i, idx) => ({ tokensUsed: usage(idx === 0 ? 10_000 : 20_000), operations: [{ op: "done" } as MeshOp] }));
      // `wait`, so qa ends WAITING: the door refusal's BLOCKED transition is
      // only legal from there (see the BUG todo at the bottom of this file),
      // and a WAITING seat is woken by boot's own recovery sweep.
      stub(first).setScript("qa", () => ({ tokensUsed: usage(100_000), operations: [{ op: "wait" } as MeshOp] }));
      await turn(first, "dev");
      await turn(first, "dev");
      await turn(first, "qa");
      assert.equal(first.kernel.state.agents.get("qa")?.state.lifecycle, "WAITING", "fixture");
      // The ledger's other two charges were never folded in live; they must
      // not be folded in by the replay either.
      const key = agentKey(goalIdOf(first), "dev");
      await first.supervisor.deps.budget.consume(key, "tokens", 50_000, undefined, { agentId: "dev", turnId: "turn-x", discarded: "timeout" }, { actorId: "dev" });
      await first.supervisor.deps.budget.consume(key, "tokens", 40_000, undefined, { reason: "interrupt", messageId: "msg-x" }, { actorId: "dev" });
      liveDev = estimate(first, "dev");
      assert.equal(liveDev, 13_000, "fixture: EWMA of 10k then 20k at alpha 0.3");
      assert.equal(estimate(first, "qa"), 100_000);
      assert.equal(ledger(first, "qa")?.consumed, 100_000, "fixture: qa has 50k of headroom left");
    },
    async (second) => {
      assert.equal(estimate(second, "dev"), liveDev, "the replayed estimate is the live one, discards and tariffs excluded");
      assert.equal(estimate(second, "qa"), 100_000);
      assert.equal(estimate(second, "pm"), undefined, "no settled turn, no estimate");

      // dev: the hold is 1.5x the replayed estimate, not the 32k no-history bound.
      stub(second).setScript("dev", () => ({ tokensUsed: usage(12_000), operations: [{ op: "done" } as MeshOp] }));
      await turn(second, "dev");
      const devHold = (await eventsOf(second, "budget.reserved", (p) => p.key === agentKey(goalIdOf(second), "dev"))).at(-1)?.payload as { requested?: number; amount?: number };
      assert.equal(devHold.requested, 19_500, "ceil(13,000 x 1.5)");
      assert.equal(devHold.amount, 19_500);

      // qa: boot's recovery sweep wakes it (WAITING) — its first turn of this
      // process life, the live case. 1.5 x 100k = 150k asked against 50k of
      // headroom, and no partial grant (it has history), so the turn is
      // refused before the model is called. Before the fix: 32k asked, granted
      // in full, and the turn ran.
      await waitFor("qa's first turn back was refused at the door", () =>
        second.supervisor.getRecentTurns(50).some((t) => t.agentId === "qa" && t.status === "blocked"),
      );
      await waitFor("qa's turn closed", () => !second.supervisor.isTurnInFlight("qa"));
      assert.equal(ledger(second, "qa")?.consumed, 100_000, "zero spend: nothing reached the model");
      assert.equal(ledger(second, "qa")?.exceeded, true, "parked at the door, like any seat that cannot afford its next turn");
      const card = [...second.kernel.state.escalations.values()].find((e) => e.reason === "agent_budget_exhausted" && (e.detail as { agentId?: string }).agentId === "qa");
      assert.equal((card?.detail as { requested?: number } | undefined)?.requested, 150_000, "the refused ask was the estimate, not the 32k no-history bound");
      assert.equal(
        (await eventsOf(second, "budget.reserved", (p) => p.key === agentKey(goalIdOf(second), "qa"))).length,
        1,
        "the only hold qa ever got is its first-life one",
      );
    },
  );
});

test("restart: a seat with no settled turn keeps today's behaviour — a 32k ask, granted short", async () => {
  await acrossARestart(
    OPTS,
    async (first) => {
      stub(first).setScript("dev", () => ({ tokensUsed: usage(10_000), operations: [{ op: "done" } as MeshOp] }));
      await turn(first, "dev");
    },
    async (second) => {
      assert.equal(estimate(second, "pm"), undefined);
      let pmCalls = 0;
      stub(second).setScript("pm", () => {
        pmCalls += 1;
        return { tokensUsed: usage(3_000), operations: [{ op: "done" } as MeshOp] };
      });
      await turn(second, "pm");
      const hold = (await eventsOf(second, "budget.reserved", (p) => p.key === agentKey(goalIdOf(second), "pm"))).at(-1)?.payload as { requested?: number; amount?: number };
      assert.equal(hold.requested, 32_000, "the pessimistic no-history bound");
      assert.equal(hold.amount, 20_000, "granted short: a seat declared below 32k still gets its first turn");
      assert.equal(pmCalls, 1, "and the turn ran");
    },
  );
});

test("restart: only the last 20 settled turns are replayed, oldest first", async () => {
  await acrossARestart(
    OPTS,
    async (first) => {
      // Settled-turn-shaped rows only, so the live estimate is untouched and
      // the replay alone decides. Five huge turns, then twenty of 1,000.
      const key = agentKey(goalIdOf(first), "dev");
      const amounts = [...Array(5).fill(1_000_000), ...Array(20).fill(1_000)] as number[];
      for (const [i, amount] of amounts.entries()) {
        await first.supervisor.deps.budget.consume(key, "tokens", amount, undefined, { agentId: "dev", turnId: `turn-${i}`, toolCalls: 0 }, { actorId: "dev" });
      }
    },
    async (second) => {
      // All 25 would leave 1000 + 999,000 x 0.7^20 = ~1,798; the window is the
      // last 20, and their EWMA is exactly 1,000.
      assert.equal(estimate(second, "dev"), 1_000);
    },
  );
});

// Pinned as a todo-BUG by the agent that found it; fixed 2026-09-28 by only
// emitting the lifecycle move when BLOCKED is reachable, so the kernel can no
// longer cancel the latch and the card that follow it.
test(
  "door check from IDLE: a seat refused at the door is parked and carded, not silently turned away",
  async () => {
    const m = await makeMesh({ ...OPTS });
    try {
      let calls = 0;
      stub(m).setScript("qa", () => {
        calls += 1;
        return { tokensUsed: usage(100_000), operations: [{ op: "done" } as MeshOp] };
      });
      await turn(m, "qa");
      assert.equal(m.kernel.state.agents.get("qa")?.state.lifecycle, "IDLE", "fixture: an IDLE seat, 50k of headroom, ~100k turns");
      await m.supervisor.activateAgent("qa", { kind: "manual" }, { explicit: true });
      await waitFor("qa's second activation settled", () => m.supervisor.getRecentTurns(50).filter((t) => t.agentId === "qa" && t.status !== "running").length === 2);
      assert.equal(calls, 1, "fixture: the second turn never reached the model");
      assert.equal(ledger(m, "qa")?.consumed, 100_000);
      assert.equal(m.supervisor.getRecentTurns(50).find((t) => t.agentId === "qa")?.status, "blocked", "the turn is recorded as refused at the door");
      assert.equal(ledger(m, "qa")?.exceeded, true, "and the seat is parked, so the next wake is deferred instead of walking back to the door");
      assert.ok(
        [...m.kernel.state.escalations.values()].some((e) => e.reason === "agent_budget_exhausted" && (e.detail as { agentId?: string }).agentId === "qa"),
        "and the operator is told",
      );
    } finally {
      await m.cleanup();
    }
  },
);
