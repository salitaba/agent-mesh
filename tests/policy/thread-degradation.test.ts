import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAgentContext } from "../../packages/core/src/context";
import { makeMesh, stub, waitFor } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * A thread budget used to have exactly two outcomes: "fine" and "blocked", and
 * the boundary between them was a lie. A 32k per-turn reservation against 5k of
 * headroom was silently trimmed to 5k and reported as NOT blocked, so the turn
 * ran completely unconstrained — one architect burned 123,893 tokens against a
 * 60k thread cap in a single turn.
 *
 * The fix adds a middle outcome: when the hold cannot be granted in full, or
 * the ledger is past its soft cap, the turn still runs but with a DEGRADED
 * context (less mail, fewer decisions, fewer artifact refs). These tests pin
 * all three outcomes, because the code path is only correct if the degraded
 * case both (a) does not block and (b) actually shrinks something.
 */

/** Queue `n` human messages so the unread list is deep enough to be trimmed. */
async function fillMail(m: Awaited<ReturnType<typeof makeMesh>>, agentId: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await m.supervisor.humanSend([agentId], "INFORM", { n: i });
  }
}

test("context limits can only shrink the bundle, never grow it", async () => {
  const m = await makeMesh({
    agents: [{ id: "a1", role: "a1", capabilities: [], interests: [] }],
    mayContact: { a1: [] },
    mode: "parked",
  });
  try {
    await fillMail(m, "a1", 15);
    const deps = { config: m.config, kernel: m.kernel };

    // No 4th argument === the pre-degradation behaviour: the module default
    // (MAX_UNREAD = 12) still binds even though 15 are queued.
    const full = buildAgentContext(deps, "a1");
    assert.equal(full.unreadMail.length, 12, "default bundle keeps the module cap");

    // `{}` must be byte-identical to passing nothing at all.
    assert.equal(buildAgentContext(deps, "a1", undefined, {}).unreadMail.length, 12);

    const trimmed = buildAgentContext(deps, "a1", undefined, {
      maxUnread: 3,
      maxDecisions: 3,
      maxArtifactRefs: 5,
      maxActivity: 4,
      maxOutstanding: 3,
    });
    assert.equal(trimmed.unreadMail.length, 3, "a limit below the default must bind");

    // A limit ABOVE the default is not a licence to build a bigger bundle:
    // degradation must never be able to make a turn more expensive.
    const inflated = buildAgentContext(deps, "a1", undefined, { maxUnread: 500 });
    assert.equal(inflated.unreadMail.length, 12, "a limit above the default is clamped to the default");
  } finally {
    await m.cleanup();
  }
});

test("thread past its soft cap degrades the turn instead of blocking it", async () => {
  const m = await makeMesh({
    agents: [{ id: "a1", role: "a1", capabilities: [], interests: [] }],
    mayContact: { a1: [] },
    mode: "parked",
    threadTokens: 1000,
    // Auto-raise would paper over the pressure we are trying to observe.
    autoRaise: { enabled: false },
  });
  const s = stub(m);
  let seenUnread = -1;
  s.setScript("a1", async (input) => {
    seenUnread = input.context.unreadMail.length;
    return { operations: [{ op: "done" } as MeshOp], tokensUsed: { input: 10, output: 5, total: 15 } };
  });
  try {
    await fillMail(m, "a1", 10);
    const goalId = m.kernel.state.activeGoalId!;
    // PARTIAL headroom: 800 of 1000 spent leaves 200, so the 32k thread hold is
    // granted at 200 — far short of the ask. That shortfall is the degrade
    // signal; it must not be mistaken for exhaustion.
    await m.supervisor.deps.budget.consume(`thread:${goalId}/t1`, "tokens", 800);

    const r = await m.supervisor.activateAgent("a1", { kind: "manual", threadId: "t1" });
    assert.equal(r.queued, true);
    await waitFor("a1's turn finished", () => m.supervisor.getRecentTurns(5).some((t) => t.agentId === "a1" && t.status !== "running"), 6000);

    const step = m.supervisor.getRecentTurns(5).find((t) => t.agentId === "a1");
    assert.ok(step, "the degraded turn must leave a trace");
    assert.notEqual(step.status, "blocked", "partial headroom must degrade the turn, not refuse it");
    assert.equal(step.status, "ok");

    // The turn is only actually cheaper if the bundle shrank. 10 messages are
    // queued and the undegraded cap is 12, so an untrimmed turn would see all
    // 10; the shortfall level caps unread at 3.
    assert.equal(seenUnread, 3, `degraded turn saw ${seenUnread} unread, expected the shortfall cap of 3`);
  } finally {
    await m.cleanup();
  }
});

test("an unpressured thread turn keeps its full context", async () => {
  const m = await makeMesh({
    agents: [{ id: "a1", role: "a1", capabilities: [], interests: [] }],
    mayContact: { a1: [] },
    mode: "parked",
    threadTokens: 1000000,
    autoRaise: { enabled: false },
  });
  const s = stub(m);
  let seenUnread = -1;
  s.setScript("a1", async (input) => {
    seenUnread = input.context.unreadMail.length;
    return { operations: [{ op: "done" } as MeshOp], tokensUsed: { input: 10, output: 5, total: 15 } };
  });
  try {
    // Control for the test above: same fixture, same mail, no budget pressure.
    // Without this, a bundle that shrank for some unrelated reason would still
    // make the degradation test pass.
    await fillMail(m, "a1", 10);
    const r = await m.supervisor.activateAgent("a1", { kind: "manual", threadId: "t1" });
    assert.equal(r.queued, true);
    await waitFor("a1's turn finished", () => m.supervisor.getRecentTurns(5).some((t) => t.agentId === "a1" && t.status !== "running"), 6000);

    assert.equal(m.supervisor.getRecentTurns(5).find((t) => t.agentId === "a1")?.status, "ok");
    assert.equal(seenUnread, 10, "an unpressured turn sees every queued message under the default cap");
  } finally {
    await m.cleanup();
  }
});

test("zero headroom still blocks — degradation must not soften exhaustion", async () => {
  const m = await makeMesh({
    agents: [{ id: "a1", role: "a1", capabilities: [], interests: [] }],
    mayContact: { a1: [] },
    mode: "parked",
    threadTokens: 1000,
    autoRaise: { enabled: false },
  });
  try {
    const goalId = m.kernel.state.activeGoalId!;
    // Spent to the limit exactly: no headroom at all. There is no smaller turn
    // that fits in nothing, so this must still refuse and escalate.
    await m.supervisor.deps.budget.consume(`thread:${goalId}/t1`, "tokens", 1000);
    const r = await m.supervisor.activateAgent("a1", { kind: "manual", threadId: "t1" });
    assert.equal(r.queued, true);
    await waitFor("a1's turn finished", () => m.supervisor.getRecentTurns(5).some((t) => t.agentId === "a1" && t.status !== "running"), 6000);

    const step = m.supervisor.getRecentTurns(5).find((t) => t.agentId === "a1");
    assert.ok(step, "the blocked turn must leave a trace");
    assert.equal(step.status, "blocked", `exhausted thread produced ${step.status}, must stay blocked`);

    const escalations = [...m.kernel.state.escalations.values()];
    assert.ok(
      escalations.some((e) => e.reason === "thread_budget_exhausted"),
      "exhaustion must still raise thread_budget_exhausted",
    );
  } finally {
    await m.cleanup();
  }
});
