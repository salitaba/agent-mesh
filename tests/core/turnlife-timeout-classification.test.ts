import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, collectEvents, type AgentSpec } from "../helpers";
import { isTimeoutError, TurnTimeoutError, isConnectionError } from "../../packages/protocol/src/index";
import type { MeshEvent } from "../../packages/protocol/src/index";

/**
 * A turn the mesh stopped for running long is a SLOW turn, not a crash.
 *
 * Measured 2026-09-25 (NOTES live-run §3): the turn timeout was thrown as a plain
 * `RuntimeFailure("turn timeout after …")`, which `isTimeoutError` does not
 * match, so `handleAgentFailure` spent crash-restart 1 of 3 on it — and the third
 * is terminal: the task is released and every ask the seat owed is abandoned.
 * The same record carried `agent.failed.sessionId: null` although the session
 * was known, and the timeout's `budget.consumed` had no input/output split.
 */

const dev: AgentSpec = { id: "dev", role: "developer", capabilities: ["repository.read"], interests: [], tokens: 500_000 };

type Mesh = Awaited<ReturnType<typeof makeMesh>>;
const ofType = async (m: Mesh, type: string): Promise<MeshEvent[]> =>
  (await collectEvents(m)).filter((e) => e.type === type && (e.payload as { agentId?: string }).agentId === "dev");
const counters = (m: Mesh) =>
  m.supervisor as unknown as { restartAttempts: Map<string, number>; timeoutRetries: Map<string, number> };

/** One timed-out turn whose abort reports usage (with a cache term), then a turn that hangs so nothing clears the counters. */
async function timedOut(): Promise<Mesh> {
  const m = await makeMesh({ agents: [dev], mayContact: { dev: [] }, autoRaise: { enabled: false }, turnTimeoutMs: 250 });
  // `cacheRead` rides on the abort's usage the way the Claude adapter's
  // `usageToTokens` object always carried it; the stub's type is narrower.
  const usage = { input: 900, output: 100, total: 1000, cacheRead: 5000 } as { input: number; output: number; total: number };
  stub(m).setScript("dev", [{ delayMs: 60_000, interruptUsage: usage }, { hang: true }]);
  await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
  await waitFor("the retry is scheduled", async () => (await ofType(m, "agent.restarted")).length > 0, 10_000);
  return m;
}

test("the turn timeout is a typed timeout error", () => {
  const err = new TurnTimeoutError(1_200_000, { input: 1, output: 1, total: 2 });
  assert.equal(isTimeoutError(err), true, "handleAgentFailure keys the slow path off this predicate");
  assert.equal(isConnectionError(err), false, "a deadline the mesh set is never a dead backend");
  assert.match(err.message, /^turn timeout after 1200000ms/, "the message discard classification and dashboards read is unchanged");
});

test("a timed-out turn does not spend the crash-restart budget", async () => {
  const m = await timedOut();
  try {
    assert.equal(counters(m).restartAttempts.get("dev"), undefined, "restart 1 of 3 must not be spent on a turn the mesh stopped");
    assert.equal(counters(m).timeoutRetries.get("dev"), 1, "it is counted where slow turns are counted");
    const escalations = [...m.kernel.state.escalations.values()].map((e) => e.reason);
    assert.deepEqual(escalations, [], "a slow turn is retried, never escalated on the first strike");
    const d = (await ofType(m, "turn.discarded"))[0]?.payload as { reason?: string } | undefined;
    assert.equal(d?.reason, "timeout");
  } finally {
    await m.cleanup();
  }
});

test("agent.failed names the session that failed", async () => {
  const m = await timedOut();
  try {
    const failed = (await ofType(m, "agent.failed"))[0]?.payload as { sessionId?: unknown } | undefined;
    assert.ok(failed, "fixture: the failure was recorded");
    assert.equal(typeof failed!.sessionId, "string", "the session was known; null erased which transcript died");
    assert.ok(String(failed!.sessionId).length > 0);
  } finally {
    await m.cleanup();
  }
});

test("the timed-out turn's agent-ledger spend carries its input/output/cache split", async () => {
  const m = await timedOut();
  try {
    const consumed = (await collectEvents(m))
      .filter((e) => e.type === "budget.consumed")
      .map((e) => e.payload as Record<string, unknown>)
      .filter((p) => String(p.key ?? "").includes("agent:"));
    assert.equal(consumed.length, 1, "fixture: the stopped turn was billed once");
    assert.equal(consumed[0]!.amount, 1000);
    assert.equal(consumed[0]!.input, 900, "the split the success path records, so a cost report can join on it");
    assert.equal(consumed[0]!.output, 100);
    assert.equal(consumed[0]!.cacheRead, 5000, "cache reads are the largest term on a long turn and were dropped");
    assert.equal("model" in consumed[0]!, false, "the stub reports no model: absent is unmeasured, not invented");
  } finally {
    await m.cleanup();
  }
});
