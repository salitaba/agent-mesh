import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, waitFor, goalOf } from "../helpers";
import { HUMAN_AGENT_ID } from "../../packages/core/src/supervisor";

/**
 * A halted mission that nothing will ever resume.
 *
 * This is the one mission state neither existing watchdog could see. The
 * per-turn silence check needs a turn in flight; the mission-quiet ladder bails
 * on `goal.status !== "ACTIVE"`. So a goal ESCALATED behind cards that need no
 * answer sat there — one live run for 3h04m, emitting nothing at all, with nine
 * `runtime_failure` cards that were every one of them `advisory: true`.
 *
 * The subtle part, and the reason the first diagnosis was wrong:
 * `resumeIfNothingPending` ALREADY holds the correct rule and would have
 * released that mission. It never ran, because it is only called when something
 * retires and advisory cards retire nothing. Calling it on a timer is
 * deliberately forbidden — a mission may legitimately sit ESCALATED with no card
 * at all, and auto-resuming that would silently undo a halt an operator meant.
 *
 * So the fix mints ONE non-advisory card: the thing that was missing was
 * something a human could answer. These tests assert both halves — that the card
 * appears, and that answering it is what releases the mission.
 */

const AGENTS = [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] }];

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

interface HaltInternals {
  checkStall(): Promise<void>;
  escalate(input: { reason: string; raisedBy: string; conflictKey?: string; advisory?: boolean; detail?: unknown }): Promise<unknown>;
  lastTurnAt: number;
}
const internals = (m: Mesh): HaltInternals => m.supervisor as unknown as HaltInternals;

/** Push the last turn far enough back to clear `stallIdleMs * HALT_NEGLECT_IDLE_MULTIPLE`. */
function longQuiet(m: Mesh): void {
  internals(m).lastTurnAt = Date.now() - 60 * 60_000;
}

function stallOpts() {
  return { stallIdleMs: 60_000, stallCooldownMs: 300_000, stallNoopRetryMs: 600_000 } as const;
}

async function haltWithAdvisoryOnly(m: Mesh, cards = 2): Promise<void> {
  for (let i = 0; i < cards; i++) {
    await internals(m).escalate({
      reason: "runtime_failure",
      raisedBy: "recovery-manager",
      conflictKey: `runtime:dev-${i}`,
      advisory: true,
      detail: { agentId: "dev", error: "API Error: 402" },
    });
  }
  const goalId = m.kernel.state.activeGoalId!;
  await m.kernel.emit("goal.escalated", { goalId, reason: "runtime_failure", detail: {} }, { actorId: HUMAN_AGENT_ID });
  await waitFor("the goal to halt", () => goalOf(m)?.status === "ESCALATED");
}

const cardsOf = (m: Mesh, reason: string) => [...m.kernel.state.escalations.values()].filter((e) => e.reason === reason);

test("halt neglect: a goal held only by advisory cards raises one card a human can answer", async () => {
  const m = await makeMesh({ agents: AGENTS, mode: "live", ...stallOpts() });
  try {
    await haltWithAdvisoryOnly(m);
    assert.equal(cardsOf(m, "stalemate:halt_neglect").length, 0, "nothing yet — the mission has only just halted");

    longQuiet(m);
    await internals(m).checkStall();

    const raised = cardsOf(m, "stalemate:halt_neglect");
    assert.equal(raised.length, 1, "exactly one card, not one per tick");
    assert.notEqual(raised[0]!.advisory, true, "an advisory card would be invisible to the very rule that is stuck");
    const detail = raised[0]!.detail as { advisoryCardCount?: number; note?: string };
    assert.equal(detail.advisoryCardCount, 2, "the card says what is holding the mission");
    assert.match(String(detail.note), /nothing will ever resume it/, "and why that is a dead end");

    // Idempotent: the operator owns the mission while it stands.
    await internals(m).checkStall();
    await internals(m).checkStall();
    assert.equal(cardsOf(m, "stalemate:halt_neglect").length, 1, "further ticks must not mint duplicates");
  } finally {
    await m.cleanup();
  }
});

test("halt neglect: answering the card is what returns the goal to ACTIVE", async () => {
  // The whole point. The card is both the alarm and the release: answering it
  // increments `retired`, which calls `resumeIfNothingPending`, which finds no
  // non-advisory card left and flips the goal. Without this half the fix is just
  // a louder way to stay stuck.
  const m = await makeMesh({ agents: AGENTS, mode: "live", ...stallOpts() });
  try {
    await haltWithAdvisoryOnly(m);
    longQuiet(m);
    await internals(m).checkStall();
    const card = cardsOf(m, "stalemate:halt_neglect")[0];
    assert.ok(card, "the card was raised");
    assert.equal(goalOf(m)?.status, "ESCALATED", "still halted while it stands");

    const res = await m.supervisor.respondEscalation(card.id, "looked at it — carry on");
    assert.equal(res.ok, true, res.reason ?? "");

    await waitFor("the mission to be released", () => goalOf(m)?.status === "ACTIVE", 5000);
    assert.equal(goalOf(m)?.status, "ACTIVE", "the advisory cards never blocked anything, so nothing else holds it");
  } finally {
    await m.cleanup();
  }
});

test("halt neglect: a card someone already owes an answer to is not duplicated", async () => {
  // A non-advisory card open means the operator genuinely has something to do.
  // A second card would be spam, and would tell them nothing they do not know.
  const m = await makeMesh({ agents: AGENTS, mode: "live", ...stallOpts() });
  try {
    await internals(m).escalate({
      reason: "agent_budget_exhausted",
      raisedBy: "termination-manager",
      conflictKey: "budget:dev",
      detail: { key: "agent:g/dev" },
    });
    const goalId = m.kernel.state.activeGoalId!;
    await m.kernel.emit("goal.escalated", { goalId, reason: "agent_budget_exhausted", detail: {} }, { actorId: HUMAN_AGENT_ID });
    await waitFor("the goal to halt", () => goalOf(m)?.status === "ESCALATED");

    longQuiet(m);
    await internals(m).checkStall();

    assert.equal(cardsOf(m, "stalemate:halt_neglect").length, 0, "the budget card is already the operator's cue");
  } finally {
    await m.cleanup();
  }
});

test("halt neglect: a mission that only just halted is left alone", async () => {
  // The detector is about NEGLECT, not about halting. An operator answering
  // within a couple of minutes must never see a card telling them they are slow.
  const m = await makeMesh({ agents: AGENTS, mode: "live", ...stallOpts() });
  try {
    await haltWithAdvisoryOnly(m);
    internals(m).lastTurnAt = Date.now() - 30_000;
    await internals(m).checkStall();
    assert.equal(cardsOf(m, "stalemate:halt_neglect").length, 0, "30s into a halt is not neglect");
  } finally {
    await m.cleanup();
  }
});
