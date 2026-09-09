import { test } from "node:test";
import assert from "node:assert/strict";
import { TerminationManager } from "../../packages/core/src/termination";
import { makeMesh, stub, waitFor } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * Two failures that together made a healthy-looking mission stop dead:
 *
 * 1. Persistent sessions replay the whole transcript each turn, and the
 *    backend reports that replay as `cache.read`. Billing it charged the
 *    entire history again every turn (a turn doing 3,698 in / 36 out was
 *    charged 429,191 and rising), which exhausted every thread budget.
 * 2. Nothing watched thread budgets, so once they were all exhausted the mesh
 *    went quiet with zero open escalations — no card, no explanation.
 */

function terminationState(over: Partial<Record<string, unknown>> = {}) {
  return {
    activeGoalId: "goal-1",
    goals: new Map([["goal-1", { id: "goal-1", status: "ACTIVE", acceptanceCriteria: [], budget: {} }]]),
    escalations: new Map(),
    budgets: new Map(),
    threads: new Map(),
    tasks: new Map(),
    agents: new Map(),
    pendingRequests: new Map(),
    eventCount: 1,
    ...over,
  } as any;
}

const CONFIG = { budgets: { mission: { maxEvents: 100000, wallClockMinutes: 100000 } } } as any;

test("tokens: a replayed transcript (cache.read) is not billed as this turn's work", async () => {
  const { OpenCodeRuntimeAdapter } = await import("../../packages/runtime-opencode/src/index");
  const rt: any = new (OpenCodeRuntimeAdapter as any)({});
  // Stand in for the backend: a small turn on a long persistent session.
  rt.request = async () => ({
    info: { tokens: { input: 3698, output: 36, reasoning: 0, cache: { read: 425457, write: 0 } }, modelID: "m" },
    parts: [{ type: "text", text: "ok" }],
  });
  rt.statuses = new Map();
  const out = await rt.send({ agentId: "dev", sessionId: "s", handle: { baseUrl: "http://x" } }, { instructions: "go", context: { rolePrompt: "r" } });

  assert.equal(out.tokensUsed.total, 3734, "charge must be input + output + reasoning only");
  assert.equal(out.tokensUsed.cacheRead, 425457, "the replayed prefix stays visible for cost reporting");
  assert.ok(out.tokensUsed.total < 10000, "a small turn must never be billed as a six-figure turn");
});

test("tokens: repeated turns on a growing session cost roughly the same, not more each time", async () => {
  const { OpenCodeRuntimeAdapter } = await import("../../packages/runtime-opencode/src/index");
  const rt: any = new (OpenCodeRuntimeAdapter as any)({});
  rt.statuses = new Map();
  const charges: number[] = [];
  // Transcript grows every turn; the real work per turn does not.
  for (let i = 1; i <= 5; i++) {
    rt.request = async () => ({
      info: { tokens: { input: 3000, output: 40, reasoning: 0, cache: { read: 100000 * i, write: 0 } }, modelID: "m" },
      parts: [{ type: "text", text: "ok" }],
    });
    const out = await rt.send({ agentId: "dev", sessionId: "s", handle: { baseUrl: "http://x" } }, { instructions: "go", context: { rolePrompt: "r" } });
    charges.push(out.tokensUsed.total);
  }
  assert.deepEqual(charges, [3040, 3040, 3040, 3040, 3040], "per-turn cost must not grow with transcript length");
});

test("stall: exhausting every open thread escalates instead of going quiet", () => {
  const state = terminationState({
    threads: new Map([["t1", { id: "t1", status: "OPEN", depth: 1, participants: ["dev"] }]]),
    budgets: new Map([
      ["thread:goal-1/t1", { key: "thread:goal-1/t1", exceeded: true, consumed: 427613, limit: 60000 }],
    ]),
    agents: new Map([["dev", { state: { agentId: "dev", lifecycle: "IDLE" } }]]),
  });
  const v = new TerminationManager().evaluate({ state, config: CONFIG, wallClockMs: 1 });
  assert.equal(v.kind, "escalate");
  assert.equal((v as any).reason, "thread_budgets_exhausted", "a mesh with no usable thread must ask for help, not fall silent");
});

test("stall: one dead thread while another still has budget is not an escalation", () => {
  const state = terminationState({
    threads: new Map([
      ["t1", { id: "t1", status: "OPEN", depth: 1, participants: ["dev"] }],
      ["t2", { id: "t2", status: "OPEN", depth: 1, participants: ["dev"] }],
    ]),
    budgets: new Map([
      ["thread:goal-1/t1", { key: "thread:goal-1/t1", exceeded: true, consumed: 427613, limit: 60000 }],
      ["thread:goal-1/t2", { key: "thread:goal-1/t2", exceeded: false, consumed: 100, limit: 60000 }],
    ]),
    agents: new Map([["dev", { state: { agentId: "dev", lifecycle: "IDLE" } }]]),
  });
  const v = new TerminationManager().evaluate({ state, config: CONFIG, wallClockMs: 1 });
  assert.equal(v.kind, "continue", "agents routinely abandon a spent thread for a fresh one — that is not a stall");
});

test("stall: a busy agent means the mission is working, not stalled", () => {
  const state = terminationState({
    threads: new Map([["t1", { id: "t1", status: "OPEN", depth: 1, participants: ["dev"] }]]),
    budgets: new Map([
      ["thread:goal-1/t1", { key: "thread:goal-1/t1", exceeded: true, consumed: 427613, limit: 60000 }],
    ]),
    agents: new Map([["dev", { state: { agentId: "dev", lifecycle: "THINKING" } }]]),
  });
  const v = new TerminationManager().evaluate({ state, config: CONFIG, wallClockMs: 1 });
  assert.equal(v.kind, "continue", "never interrupt a mission whose agents are mid-turn");
});

test("budget: thread reservations are settled, not leaked, across many turns", async () => {
  const { threadKey } = await import("../../packages/core/src/budgets");
  const m = await makeMesh({
    agents: [
      { id: "a", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "b", role: "qa", capabilities: ["test.execute"], interests: [] },
    ],
    mayContact: { a: ["b"], b: ["a"] },
    // Small enough that a 32k-per-turn leak would exhaust it almost at once,
    // while the actual spend below (10 tokens/turn) never comes close.
    threadTokens: 120000,
  });
  const s = stub(m);
  s.setScript("b", async () => ({ tokensUsed: { input: 5, output: 5, total: 10 }, operations: [{ op: "done" } as MeshOp] }));

  const opened = await m.supervisor.sendMessage({
    from: "a", to: ["b"], type: "INFORM",
    newThread: { subject: "chatty thread" }, payload: { n: 0 },
  });
  const threadId = m.kernel.state.messages.get(opened.messageId!)!.threadId;
  const goalId = m.kernel.state.activeGoalId!;

  for (let i = 0; i < 6; i++) {
    await m.supervisor.activateAgent("b", { kind: "message", threadId, note: `turn ${i}` });
    await waitFor(`turn ${i} settled`, () => m.supervisor.isIdle(), 8000);
  }

  const ledger = m.kernel.state.budgets.get(threadKey(goalId, threadId))!;
  assert.equal(ledger.reserved, 0, `thread reservations must be released, found ${ledger.reserved} held`);
  assert.equal(ledger.exceeded, false, "a thread must not die of leaked reservations while barely spending");
  assert.ok(ledger.consumed <= 100, `only real spend should be billed, got ${ledger.consumed}`);
  await m.cleanup();
});

test("tokens: an agent is billed once per turn, not once per ledger", async () => {
  const { agentKey, missionKey, threadKey } = await import("../../packages/core/src/budgets");
  const m = await makeMesh({
    agents: [
      { id: "a", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "b", role: "qa", capabilities: ["test.execute"], interests: [] },
    ],
    mayContact: { a: ["b"], b: ["a"] },
  });
  const s = stub(m);
  const PER_TURN = 1000;
  s.setScript("b", async () => ({
    tokensUsed: { input: 400, output: 600, total: PER_TURN },
    operations: [{ op: "done" } as MeshOp],
  }));

  // A threaded activation settles the same spend against three ledgers
  // (agent, mission, thread). All three events name the actor for attribution,
  // so crediting the agent on each one billed every turn three times over.
  const opened = await m.supervisor.sendMessage({
    from: "a", to: ["b"], type: "INFORM",
    newThread: { subject: "billing" }, payload: { n: 0 },
  });
  const threadId = m.kernel.state.messages.get(opened.messageId!)!.threadId;
  const goalId = m.kernel.state.activeGoalId!;

  const TURNS = 3;
  for (let i = 0; i < TURNS; i++) {
    await m.supervisor.activateAgent("b", { kind: "message", threadId, note: `turn ${i}` });
    await waitFor(`turn ${i} settled`, () => m.supervisor.isIdle(), 8000);
  }

  // Derive the truth from the ledger rather than assuming a turn count: mail
  // delivery can wake "b" an extra time, which is legitimate work.
  const agentLedger = m.kernel.state.budgets.get(agentKey(goalId, "b"))!;
  const reported = m.kernel.state.agents.get("b")!.state.tokensConsumed;
  assert.ok(agentLedger.consumed >= PER_TURN * TURNS, "the scripted turns must actually have run");
  assert.equal(
    reported,
    agentLedger.consumed,
    `the agent's running total must equal its own ledger; got ${reported} vs ${agentLedger.consumed} — ` +
      "the surplus is the mission and thread rollups being billed to the agent as well, which drives " +
      "agents into a ceiling they never reached (72M reported against a 38M limit on ~700k of real spend)",
  );
  // Every ledger records the same real spend; none of them is inflated.
  assert.equal(m.kernel.state.budgets.get(missionKey(goalId))!.consumed, agentLedger.consumed);
  assert.equal(m.kernel.state.budgets.get(threadKey(goalId, threadId))!.consumed, agentLedger.consumed);
  await m.cleanup();
});

test("budget: a turn that throws gives its reservations back", async () => {
  const { agentKey } = await import("../../packages/core/src/budgets");
  const m = await makeMesh({
    agents: [{ id: "flaky", role: "developer", capabilities: ["repository.write"], interests: [] }],
    mayContact: { flaky: [] },
  });
  const s = stub(m);
  s.setScript("flaky", async () => {
    throw new Error("backend died mid-turn");
  });
  const goalId = m.kernel.state.activeGoalId!;
  await m.supervisor.activateAgent("flaky", { kind: "manual" });
  await waitFor("failed turn settled", () => m.supervisor.isIdle(), 8000);
  const ledger = m.kernel.state.budgets.get(agentKey(goalId, "flaky"))!;
  assert.equal(ledger.reserved, 0, `a failed turn must not keep its hold, found ${ledger.reserved}`);
  await m.cleanup();
});
