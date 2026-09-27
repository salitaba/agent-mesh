import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeMesh, stub, waitFor, goalOf } from "../helpers";
import { resolveConfig } from "../../packages/config/src/index";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * The door check and what a turn is billed (NOTES-live-run-20260925 §2).
 *
 * Measured 2026-09-25: `sizedTurnReserve` capped every hold at 32,000 whatever
 * the seat's turns really cost, so tech-lead was admitted at 99,706/180,000 and
 * spent 735,430 in one turn, and architect spent 1,434,297 — 4.8x its declared
 * budget — in one. Spend is only recorded at settle, so nothing stopped either
 * mid-flight. On a seat's last ladder rung, where no raise is coming, the hold is
 * the seat's real estimate; and a turn whose LIVE usage passes the headroom it
 * has left is interrupted rather than billed after the fact.
 */

const WAIT = { operations: [{ op: "wait" } as MeshOp] };
const QUIET = { stallIdleMs: 60_000, stallCooldownMs: 300_000, stallNoopRetryMs: 600_000 } as const;

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

const settledTurns = (m: Mesh, id: string) => m.supervisor.getRecentTurns(100).filter((t) => t.agentId === id && t.status !== "running");

test("door check: on the last rung, a turn the seat cannot afford is refused before it reaches the model", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", interests: [], tokens: 200_000 },
      { id: "qa", role: "qa", interests: [] },
    ],
    mayContact: { dev: [], qa: [] },
    // Auto-raise off: every ledger is already on its last rung.
    autoRaise: { enabled: false },
    ...QUIET,
  });
  try {
    let calls = 0;
    stub(m).setScript("dev", async () => {
      calls++;
      return { ...WAIT, tokensUsed: { input: 90_000, output: 10_000, total: 100_000 } };
    });
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("dev's first turn to settle", () => settledTurns(m, "dev").length === 1);
    await waitFor("idle", () => m.supervisor.isIdle());

    // 100k of 200k left; this seat's turns cost ~100k, so the honest hold is
    // 150k. The old 32k cap admitted it and let it spend past the limit.
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("dev's second activation to settle", () => settledTurns(m, "dev").length === 2);

    assert.equal(calls, 1, "the second turn never reached the model");
    assert.equal(settledTurns(m, "dev")[0]!.status, "blocked");
    const key = `agent:${m.kernel.state.activeGoalId}/dev`;
    assert.equal(m.kernel.state.budgets.get(key)!.consumed, 100_000, "nothing past the limit was spent");
    assert.equal(m.kernel.state.budgets.get(key)!.exceeded, true, "a seat that cannot afford its next turn is parked like an exhausted one");
    assert.equal(goalOf(m)?.status, "ACTIVE", "and the mission carries on without it");
  } finally {
    await m.cleanup();
  }
});

/** The private members the live-usage tests pose and observe. */
interface LiveProbe {
  interruptSilentTurns(now: number): void;
  noteLiveUsage(turnId: string, usage: { input: number; output: number; total: number; cacheRead?: number }): void;
  turnInFlight: Set<string>;
  activeTurnByAgent: Map<string, string>;
  interruptedTurnIds: Set<string>;
  sessions: Map<string, { session: { sessionId: string; agentId: string }; runtime: { interrupt(s: unknown): Promise<void> } }>;
  turns: { push(rec: unknown): void };
}

function poseTurn(m: Mesh, agentId: string): { turnId: string; interrupts: string[] } {
  const p = m.supervisor as unknown as LiveProbe;
  const turnId = `turn-posed-${agentId}`;
  const interrupts: string[] = [];
  p.turns.push({ turnId, agentId, reason: { kind: "timer" }, startedAt: new Date().toISOString(), status: "running", phases: { startedAt: Date.now() } });
  p.turnInFlight.add(agentId);
  p.activeTurnByAgent.set(agentId, turnId);
  p.sessions.set(agentId, {
    session: { sessionId: `sess-${agentId}`, agentId },
    runtime: {
      interrupt: async (s: unknown) => {
        interrupts.push((s as { sessionId: string }).sessionId);
      },
    },
  });
  return { turnId, interrupts };
}

test("door check: a running turn whose live usage passes the headroom left is interrupted", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", interests: [], tokens: 100_000 }],
    mayContact: { dev: [] },
    autoRaise: { enabled: false },
    mode: "parked",
  });
  try {
    const key = `agent:${m.kernel.state.activeGoalId}/dev`;
    m.supervisor.deps.budget.declare(key, "tokens", 100_000);
    await m.supervisor.deps.budget.consume(key, "tokens", 90_000);
    const p = m.supervisor as unknown as LiveProbe;
    const posed = poseTurn(m, "dev");

    p.noteLiveUsage(posed.turnId, { input: 5000, output: 1000, total: 6000 });
    p.interruptSilentTurns(Date.now());
    assert.deepEqual(posed.interrupts, [], "6k of a 10k headroom is a turn that can still pay for itself");

    p.noteLiveUsage(posed.turnId, { input: 10_000, output: 2000, total: 12_000 });
    p.interruptSilentTurns(Date.now());
    assert.deepEqual(posed.interrupts, ["sess-dev"], "12k live against 10k left: stop it now, not at settle");
    assert.ok(p.interruptedTurnIds.has(posed.turnId));

    p.interruptSilentTurns(Date.now());
    assert.equal(posed.interrupts.length, 1, "interrupted once, not once per tick");
    p.turnInFlight.delete("dev");
  } finally {
    await m.cleanup();
  }
});

test("billing: cache reads are billed at budgets.cache_read_weight, and the turn's cache ratio is on the event", async () => {
  const m = await makeMesh({ agents: [{ id: "dev", role: "developer", interests: [] }], mayContact: { dev: [] }, ...QUIET });
  try {
    (m.supervisor.config.budgets as { cacheReadWeight?: number }).cacheReadWeight = 0.1;
    stub(m).setScript("dev", async () => ({ ...WAIT, tokensUsed: { input: 1000, output: 500, total: 1500, cacheRead: 99_000 } }));
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("dev's turn to settle", () => settledTurns(m, "dev").length === 1);
    const key = `agent:${m.kernel.state.activeGoalId}/dev`;
    const evt = (await m.store.read()).find((e) => e.type === "budget.consumed" && (e.payload as { key?: string }).key === key);
    const p = evt?.payload as { amount: number; cacheRead?: number; cacheReadRatio?: number };
    assert.equal(p.amount, 1500 + 9900, "1,500 fresh plus a tenth of 99,000 read from cache");
    assert.equal(p.cacheReadRatio, 0.99, "99k of a 100k prompt came from cache");
    assert.equal(m.kernel.state.budgets.get(key)!.consumed, 11_400);
  } finally {
    await m.cleanup();
  }
});

test("billing: cache_read_weight is a budgets key, off unless declared", () => {
  const base = `version: 1
mesh:
  id: cfgtest
  goal: |
    Test.
  acceptance_criteria:
    - { id: ship, description: "done", mandatory: true }
  workspace: { path: ./workspace }
  runtime: { default: stub }
agents:
  a: { role: worker, capabilities: [], authority: [] }
`;
  const resolve = (extra: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-config-test-"));
    fs.writeFileSync(path.join(dir, "mesh.yaml"), base + extra, "utf8");
    try {
      return resolveConfig(path.join(dir, "mesh.yaml"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
  assert.equal((resolve("").budgets as { cacheReadWeight?: number }).cacheReadWeight, 0, "today's behaviour: cache reads are free");
  assert.equal((resolve("budgets:\n  cache_read_weight: 0.1\n").budgets as { cacheReadWeight?: number }).cacheReadWeight, 0.1);
});
