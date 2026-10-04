import test from "node:test";
import assert from "node:assert/strict";

import { budgetName, eventToast } from "../../apps/mesh-dashboard/src/toasttext";

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
