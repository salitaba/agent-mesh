import { test } from "node:test";
import assert from "node:assert/strict";
import { TerminationManager } from "../../packages/core/src/termination";
import { buildAgentContext, clearPromptCache, renderContextInstructions } from "../../packages/core/src/context";
import { makeMesh } from "../helpers";
import type { AgentContextBundle } from "../../packages/protocol/src/index";

/**
 * Two remainders.
 *
 * `TerminationManager`: the event-count wall and the terminal-runtime-failure
 * verdict. Both are the runtime's LAST line of defence — a mission that has
 * blown its event cap or lost a required agent for good must reach a human
 * rather than spin — and neither had a direct assertion.
 *
 * `context.ts`: the prompt cache and the ratified-decisions section. The
 * decisions block is the L3 shared-facts channel: if it silently stopped being
 * rendered, agents would keep re-deciding settled questions and nothing would
 * fail.
 */

// ------------------------------------------------------------- event cap

/** The smallest state the manager will look at: one live goal, nothing else. */
function baseState(over: Record<string, unknown> = {}) {
  return {
    activeGoalId: "g",
    goals: new Map([["g", { id: "g", status: "ACTIVE", acceptanceCriteria: [] }]]),
    budgets: new Map(),
    threads: new Map(),
    agents: new Map(),
    eventsSinceActivation: new Map(),
    escalations: new Map(),
    tasks: new Map(),
    pendingRequests: new Map(),
    eventCount: 1,
    ...over,
  } as never;
}

const CONFIG = { budgets: { mission: { tokens: 100000, wallClockMinutes: 600, maxEvents: 50 } } } as never;

test("termination: blowing the event cap escalates with the count and the limit", () => {
  const v = new TerminationManager().evaluate({ state: baseState({ eventCount: 51 }), config: CONFIG, wallClockMs: 1000 });
  assert.equal(v.kind, "escalate");
  if (v.kind !== "escalate") return;
  assert.equal(v.reason, "max_events_exceeded");
  // The card must be actionable on its own: an operator raising the cap needs
  // both numbers, not just "too many events".
  assert.deepEqual(v.detail, { events: 51, limit: 50 });
  assert.equal(v.supports, undefined, "a budget verdict stands alone, it is not derived");
});

test("termination: exactly at the cap is still allowed to run", () => {
  const v = new TerminationManager().evaluate({ state: baseState({ eventCount: 50 }), config: CONFIG, wallClockMs: 1000 });
  assert.equal(v.kind, "continue");
});

test("termination: the goal's own raised cap overrides the boot config", () => {
  const state = baseState({
    eventCount: 51,
    goals: new Map([["g", { id: "g", status: "ACTIVE", acceptanceCriteria: [], budget: { maxEvents: 500 } }]]),
  });
  assert.equal(new TerminationManager().evaluate({ state, config: CONFIG, wallClockMs: 1000 }).kind, "continue");
});

// ------------------------------------------------------- terminal agent failure

function failedAgent(agentId: string, restartable: boolean) {
  return [agentId, { state: { agentId, lifecycle: "FAILED", restartable, activeTaskId: undefined } }] as const;
}

test("termination: a terminally failed agent with work stranded on it escalates", () => {
  const state = baseState({
    agents: new Map([failedAgent("dev", false)]),
    tasks: new Map([["t1", { id: "t1", status: "OPEN" }]]),
  });
  const v = new TerminationManager().evaluate({ state, config: CONFIG, wallClockMs: 1000 });
  assert.equal(v.kind, "escalate");
  if (v.kind !== "escalate") return;
  assert.equal(v.reason, "runtime_failure");
  assert.deepEqual(v.detail, { failedAgents: ["dev"] });
});

test("termination: an unanswered request is stranded work too, even with no open tasks", () => {
  const state = baseState({
    agents: new Map([failedAgent("dev", false)]),
    pendingRequests: new Map([["m1", { messageId: "m1", from: "pm", to: ["dev"], type: "REQUEST", createdAt: "2026-01-01T00:00:00.000Z" }]]),
  });
  const v = new TerminationManager().evaluate({ state, config: CONFIG, wallClockMs: 1000 });
  assert.equal(v.kind, "escalate");
  if (v.kind !== "escalate") return;
  assert.equal(v.reason, "runtime_failure");
});

test("termination: a terminally failed agent with nothing stranded on it does not stop the mission", () => {
  const state = baseState({
    agents: new Map([failedAgent("dev", false)]),
    tasks: new Map([["t1", { id: "t1", status: "COMPLETED" }]]),
  });
  assert.equal(new TerminationManager().evaluate({ state, config: CONFIG, wallClockMs: 1000 }).kind, "continue");
});

test("termination: a RESTARTABLE failure is the supervisor's to retry, not grounds to freeze the goal", () => {
  // The retry is scheduled milliseconds after the failure; a watchdog tick
  // landing inside that window must not end the mission over a blip.
  const state = baseState({
    agents: new Map([failedAgent("dev", true)]),
    tasks: new Map([["t1", { id: "t1", status: "OPEN" }]]),
  });
  assert.equal(new TerminationManager().evaluate({ state, config: CONFIG, wallClockMs: 1000 }).kind, "continue");
});

// ------------------------------------------------------------- context render

function bundle(over: Partial<AgentContextBundle> = {}): AgentContextBundle {
  return {
    rolePrompt: "you are dev",
    mission: "ship it",
    relevantPolicies: ["Your capabilities: repository.write"],
    agentState: { agentId: "dev", lifecycle: "IDLE", mailboxDepth: 0, currentArtifactIds: [], tokensConsumed: 0, activations: 1, lastActivityAt: "2026-01-01T00:00:00.000Z" },
    currentTask: undefined,
    relevantDecisions: [],
    relevantArtifacts: [],
    unreadMail: [],
    recentOwnActivity: [],
    agentMemory: [],
    openThreads: [],
    budgetSnapshot: { agentTokensUsed: 0, agentTokenBudget: 100, missionTokensUsed: 0, missionTokenBudget: 1000 },
    outstanding: { awaitingResponse: [], owedByYou: [] },
    goalCriteria: [],
    delegationEnabled: false,
    ...over,
  } as AgentContextBundle;
}

test("render: ratified decisions are rendered as L3 shared facts with their payload", () => {
  const text = renderContextInstructions(
    bundle({
      relevantDecisions: [
        { id: "dec-1", goalId: "g", topic: "datastore", decision: { choice: "sqlite" }, status: "RATIFIED", proposedBy: "architect", approvedBy: ["lead"], evidence: [], createdAt: "2026-01-01T00:00:00.000Z", ratifiedAt: "2026-01-01T00:01:00.000Z" },
      ],
    }),
  );
  assert.match(text, /## Ratified decisions \(L3/);
  // The decision BODY has to be there, not just the topic: an agent that can
  // see "datastore was decided" but not "sqlite" will re-open the question.
  assert.match(text, /- \[dec-1\] datastore: \{"choice":"sqlite"\}/);
});

test("render: with no ratified decisions the L3 section is omitted entirely", () => {
  const text = renderContextInstructions(bundle());
  assert.equal(text.includes("Ratified decisions"), false);
});

// ------------------------------------------------------------- prompt cache

test("prompt cache: repeated builds reuse the same prompt string, and clearing forces a reload", async () => {
  const m = await makeMesh({ agents: [{ id: "dev", role: "developer", interests: [] }], mode: "parked" });
  try {
    const first = buildAgentContext({ config: m.config, kernel: m.kernel }, "dev").rolePrompt;
    const second = buildAgentContext({ config: m.config, kernel: m.kernel }, "dev").rolePrompt;
    assert.equal(second, first);
    assert.ok(first.length > 0);

    clearPromptCache();
    const third = buildAgentContext({ config: m.config, kernel: m.kernel }, "dev").rolePrompt;
    assert.equal(third, first, "a cleared cache must reload the SAME prompt, not a different one");
  } finally {
    await m.cleanup();
  }
});

test("buildAgentContext: an unknown agent is refused rather than given an empty context", async () => {
  const m = await makeMesh({ agents: [{ id: "dev", role: "developer", interests: [] }], mode: "parked" });
  try {
    assert.throws(() => buildAgentContext({ config: m.config, kernel: m.kernel }, "ghost"), /unknown agent ghost/);
  } finally {
    await m.cleanup();
  }
});
