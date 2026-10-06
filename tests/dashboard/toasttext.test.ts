import test from "node:test";
import assert from "node:assert/strict";

import { budgetName, decisionTitles, eventToast, pageShowing, stoppedBecause, toastLife } from "../../apps/mesh-dashboard/src/toasttext";

/**
 * The corner notices used to be the event's own fields in lower case: "escalation opened: budget_exhausted (by explorer)", "budget
 * exceeded: mission:goal-M44MV2BS003f3a104bda". These pin that they say what happened in a sentence, say what is held, and do not
 * announce one budget running out twice.
 */

const escalated = (escalation: Record<string, unknown>) => eventToast({ type: "escalation.requested", payload: { escalation } });

test("a delivered mission is news, in a sentence", () => {
  assert.deepEqual(eventToast({ type: "goal.completed" }), { title: "Mission delivered", msg: "Every mandatory check is evidenced.", kind: "ok" });
});

test("a decision that holds the mission says the mission is paused, in the card's own words and not the reason code", () => {
  const t = escalated({ reason: "budget_exhausted", raisedBy: "explorer", conflictKey: "budget:mission:goal-1", goalId: "goal-1" })!;
  assert.equal(t.title, "A decision is waiting on you");
  assert.match(t.msg, /^Mission ran out of tokens\. The mission is paused\.$/);
  assert.equal(t.kind, "bad");
  assert.doesNotMatch(t.msg, /budget_exhausted|explorer/, "no code, and not who raised it: the card says that");
});

test("a decision that holds one seat says which, and is a warning, not a stop", () => {
  const t = escalated({ reason: "agent_budget_exhausted", raisedBy: "budget-manager", conflictKey: "budget:agent:goal-1/developer", goalId: "goal-1" })!;
  assert.equal(t.title, "A decision is waiting on you");
  assert.match(t.msg, /It holds developer only\.$/);
  assert.equal(t.kind, "warn");
});

test("an advisory card is a notice, and holds nothing", () => {
  const t = escalated({ reason: "stalemate", advisory: true })!;
  assert.equal(t.title, "A notice");
  assert.equal(t.kind, "warn");
  assert.doesNotMatch(t.msg, /paused|waiting on you/);
});

test("a reason nobody has phrased still reads as words, and a missing payload does not throw", () => {
  const t = escalated({ reason: "some_new:reason" })!;
  assert.match(t.msg, /^Some new reason\./);
  assert.doesNotThrow(() => eventToast({ type: "escalation.requested" }));
  assert.doesNotThrow(() => eventToast({ type: "agent.failed", payload: null }));
  assert.equal(eventToast({ type: "agent.failed", payload: null })!.msg, "An agent failed.");
});

test("a failed mission names why in the card's words; one that does not say why points at the events", () => {
  assert.equal(eventToast({ type: "goal.failed", payload: { reason: "budget_exhausted" } })!.msg, "Mission ran out of tokens");
  assert.equal(eventToast({ type: "goal.failed", payload: {} })!.msg, "Open the events to see why.");
  assert.equal(eventToast({ type: "goal.failed" })!.kind, "bad");
});

test("an agent that failed is named, with its error cut to a line", () => {
  assert.equal(eventToast({ type: "agent.failed", payload: { agentId: "qa", error: "x".repeat(300) } })!.msg, `qa: ${"x".repeat(90)}`);
});

test("a mission or seat budget running out is announced by its decision, once; other ledgers are announced here", () => {
  assert.equal(eventToast({ type: "budget.exceeded", payload: { key: "mission:goal-1" } }), null);
  assert.equal(eventToast({ type: "budget.exceeded", payload: { key: "agent:goal-1/developer" } }), null);
  assert.deepEqual(eventToast({ type: "budget.exceeded", payload: { key: "thread:t-9" } }), { title: "Token budget used up", msg: "A conversation thread's token budget is spent.", kind: "warn" });
});

test("goal.escalated adds nothing: the decision that escalated it has already said the mission is paused", () => {
  assert.equal(eventToast({ type: "goal.escalated", payload: { reason: "budget_exhausted" } }), null);
});

test("most events earn no notice", () => {
  for (const type of ["message.sent", "agent.turn.finished", "artifact.created", "task.created", "approval.recorded"]) assert.equal(eventToast({ type }), null, type);
});

test("a ledger key is said as a person would, never as the key", () => {
  assert.equal(budgetName("mission:goal-M44MV2BS003f3a104bda"), "The mission's token budget");
  assert.equal(budgetName("agent:goal-1/tech-lead"), "tech-lead's token budget");
  assert.equal(budgetName("thread:abc"), "A conversation thread's token budget");
  assert.equal(budgetName(undefined), "A token budget");
});

test("a notice is not raised on the page that already shows it first and in full, and only there", () => {
  // Needs you's Decisions tab is the card itself, with its answer form; its Tool gates tab does not show decisions.
  assert.equal(pageShowing("escalation.requested"), "escalations");
  // The Overview's headline says "Delivered. Every mandatory check is evidenced." and "The mission failed." with the reason.
  assert.equal(pageShowing("goal.completed"), "overview");
  assert.equal(pageShowing("goal.failed"), "overview");
  // Agents shows the last step's error, which need not be the event's; no page shows a thread's budget.
  assert.equal(pageShowing("agent.failed"), null);
  assert.equal(pageShowing("budget.exceeded"), null);
  for (const type of ["message.sent", "goal.escalated", "artifact.created"]) assert.equal(pageShowing(type), null, type);
});

test("a notice is gone in a few seconds, a failure a little later, and one with a button stays about twice as long", () => {
  for (const kind of ["ok", "warn", ""]) assert.ok(toastLife(kind, false) >= 4000 && toastLife(kind, false) <= 5000, kind);
  assert.ok(toastLife("bad", false) > toastLife("ok", false) && toastLife("bad", false) <= 8000, "a failure is read a little longer");
  for (const kind of ["ok", "warn", "bad"]) {
    const ratio = toastLife(kind, true) / toastLife("ok", false);
    assert.ok(ratio >= 1.8 && ratio <= 2.5, `Undo stays about twice as long as a plain notice (${kind}: ${ratio.toFixed(2)})`);
  }
});

test("a decision is named by the title its card leads with, so a notice and the page say the same thing", () => {
  const cards = [
    { id: "esc-1", reason: "budget_exhausted", raisedBy: "budget-manager", conflictKey: "budget:mission:goal-1", status: "OPEN" },
    { id: "esc-2", reason: "stalemate", raisedBy: "stall-watchdog", status: "OPEN" },
  ];
  const titles = decisionTitles(cards, { status: { budgets: [], goal: { id: "goal-1" } }, parked: false });
  assert.equal(titles.length, 2);
  assert.match(titles[0]!, /ran out of tokens/i);
  assert.match(titles[1]!, /stalemate/i);
  assert.deepEqual(decisionTitles([], { status: {}, parked: false }), []);
});

test("why a failed mission stopped is the card's sentence, from the event that ended it, and nothing when the log does not say", () => {
  const failed = (reason?: string) => [{ type: "message.sent" }, { type: "goal.failed", payload: reason ? { reason } : {} }];
  assert.equal(stoppedBecause(failed("wall_clock_exceeded"), "FAILED"), "Mission ran out of time. The run exceeded its configured wall-clock limit.");
  assert.equal(stoppedBecause(failed(), "FAILED"), null, "no reason recorded: no sentence rather than a guess");
  assert.equal(stoppedBecause(failed("something_new"), "FAILED"), null, "a reason nobody has phrased is not read aloud");
  assert.equal(stoppedBecause([{ type: "message.sent" }], "FAILED"), null, "the ending event is not in the buffer");
  // A mission that failed, was reopened and is failing again must not be explained by the old failure.
  assert.equal(stoppedBecause(failed("wall_clock_exceeded"), "COMPLETED"), null);
});
