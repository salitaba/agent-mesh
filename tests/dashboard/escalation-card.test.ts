import test from "node:test";
import assert from "node:assert/strict";

import { verdictText } from "../../packages/protocol/src/catalog";
import {
  ageOf,
  answerOutcome,
  answerPlan,
  answerToast,
  budgetInfoOf,
  capTarget,
  cardKind,
  escAgents,
  escalationText,
  holdsLine,
  holdsOf,
  isSystemRaiser,
  openSupports,
  raisedByLabel,
  resolveArtifactId,
  seatOfBudgetCard,
  stuckInfoOf,
  type AnswerInput,
  type CardKind,
  type EscalationLike,
} from "../../apps/mesh-dashboard/src/escalation-card";

/**
 * The card is one missing answer, and the words on it are claims: that the mission is paused, that answering resumes it,
 * that a seat is the only thing held. These pin the per-reason wording that used to live in a switch inside Escalations.tsx,
 * and the one answer pattern the redesign puts over every kind of card: a primary action that names its consequence, whose
 * wording stays true when the project is parked and when the card is only a notice.
 */

const GOAL = "goal-1";
const esc = (over: Partial<EscalationLike> = {}): EscalationLike => ({ id: "esc-1", goalId: GOAL, status: "OPEN", raisedBy: "termination-manager", createdAt: "2026-10-04T10:00:00Z", detail: {}, ...over });
const ctx = (over: Record<string, unknown> = {}) => ({ status: { budgets: [], goal: {} }, parked: false, phrase: verdictText, ...over }) as Parameters<typeof escalationText>[1];

/* ------------------------------- the wording ------------------------------- */

test("a card raised by a watchdog names the watchdog, and the mission-halting clause is on the blocking card", () => {
  const t = escalationText(esc({ reason: "runtime_failure", detail: { failedAgents: ["dev"], error: "ECONNRESET" } }), ctx());
  assert.equal(t.title, "Agent crashed: dev");
  assert.equal(t.what, "Mesh watchdog detected a runtime failure in dev: ECONNRESET. The mission is paused; nothing else will run until you decide.");
  assert.match(t.next, /Responding resumes the mission and wakes the affected agents\.$/);
});

test("an advisory card says nothing is paused, and a parked project promises no restart: the two corrections compose", () => {
  const advisory = escalationText(esc({ reason: "runtime_failure", advisory: true, detail: { failedAgents: ["dev"] } }), ctx());
  assert.match(advisory.what, /Nothing is paused — the mission is still running\./);
  assert.doesNotMatch(advisory.what, /mission is paused/);
  const parked = escalationText(esc({ reason: "runtime_failure", detail: { failedAgents: ["dev"] } }), ctx({ parked: true }));
  assert.doesNotMatch(parked.next, /resumes the mission|wakes the affected agents/);
  assert.match(parked.next, /The project is parked, so nothing runs until you start the mission\./);
  assert.match(parked.what, /The mission is paused/, "a parked project still has a halted mission");
  const both = escalationText(esc({ reason: "runtime_failure", advisory: true }), ctx({ parked: true }));
  assert.doesNotMatch(`${both.what} ${both.next}`, /mission is paused|resumes the mission|wakes the affected agents/);
});

test("the termination reasons take their titles from the shared catalog, so the Overview and the inbox name a stop the same way", () => {
  for (const reason of ["budget_exhausted", "budget_exhausted_tokens", "thread_budget_exhausted", "max_events_exceeded", "wall_clock_exceeded", "stalemate:stall_nudge_cap", "host_spend_ceiling"]) {
    assert.equal(escalationText(esc({ reason, goalId: GOAL, detail: { threadId: "t1" } }), ctx()).title, verdictText(reason).title, reason);
  }
});

test("the host's spend ceiling card names the money and says Continue will not hold, instead of showing its raw reason", () => {
  const t = escalationText(esc({ reason: "host_spend_ceiling", raisedBy: "host-limiter", detail: { usd: 12.5, ceilingUsd: 10 } }), ctx({ parked: true }));
  assert.equal(t.title, "The host hit its spend ceiling");
  assert.match(t.what, /Total spend across open projects reached \$12\.50 against a ceiling of \$10\.00\./);
  assert.match(t.next, /Continuing will not hold/);
  assert.match(t.next, /host settings/);
  const bare = escalationText(esc({ reason: "host_spend_ceiling", raisedBy: "host-limiter" }), ctx());
  assert.doesNotMatch(bare.what, /\$/, "no figure is invented when the card carries none");
});

test("a stuck request is titled by what was asked, and offers a suggested answer shaped by it", () => {
  const msgs = new Map([["m1", { id: "m1", from: "pm", type: "REQUEST_REVIEW", payload: { question: "Run the UI suite and post TEST_RESULT" } }]]);
  const e = esc({ reason: "stalemate:unanswered_request", raisedBy: "deadlock-detector", detail: { agentId: "qa", requestMessageId: "m1", requestType: "REQUEST_REVIEW" } });
  const t = escalationText(e, ctx({ msgs }));
  assert.equal(t.title, "Run the UI suite and post TEST_RESULT");
  assert.match(t.placeholder, /^Approved\. qa, run the UI suite/);
  const s = stuckInfoOf(e, msgs, Date.parse("2026-10-04T10:12:00Z"));
  assert.deepEqual([s.askerId, s.agentId, s.age], ["pm", "qa", "12m waiting"]);
  assert.match(s.requestLabel, /^a review: “Run the UI suite/);
  assert.match(escalationText(esc({ reason: "stalemate:unanswered_request", detail: {} }), ctx()).title, /^Input needed$/, "nothing loaded for the request: the plain fallback");
});

test("a derived stalemate says how many answers are missing, and what to do when they are all already resolved", () => {
  const some = escalationText(esc({ reason: "stalemate", detail: { openDeadlockEscalations: [{ id: "a" }, { id: "b" }] } }), ctx());
  assert.equal(some.title, "Stalemate (2 waiting)");
  assert.match(some.what, /2 answers are still missing\. Answer each one, or answer all at once\./);
  assert.doesNotMatch(some.what + some.next, /below|above/, "the card does not say where the requests are: another card may sit between");
  const none = escalationText(esc({ reason: "stalemate", detail: { openDeadlockEscalations: [] } }), ctx());
  assert.equal(none.title, "Stalemate (clearing)");
  assert.match(none.what, /already resolved/);
});

test("a conversation that ran long and a deadlock carry their own facts, and an unknown reason is shown rather than swallowed", () => {
  const collab = escalationText(esc({ reason: "collab_overrun:expired", advisory: true, raisedBy: "collab-watchdog", detail: { topic: "v2 or v3", participants: ["dev", "qa"], exchanges: 7, maxExchanges: 8 } }), ctx());
  assert.equal(collab.title, "A conversation ran long: v2 or v3");
  assert.match(collab.what, /^dev and qa were still talking when their time box ran out after 7\/8 exchanges, so the mesh closed the conversation\./);
  assert.match(collab.next, /^Nothing is waiting on you here/);
  assert.equal(escalationText(esc({ reason: "deadlock:cycle", detail: { description: "dev waits on qa" } }), ctx()).what, "Mesh watchdog: dev waits on qa. Work is paused to avoid spending the budget.");
  assert.equal(escalationText(esc({ reason: "should I merge now?", raisedBy: "pm" }), ctx()).title, "should I merge now?");
  assert.equal(escalationText(esc({ reason: "", raisedBy: "pm" }), ctx()).title, "Needs a human decision");
});

/* -------------------------------- budgets ---------------------------------- */

const ledger = (key: string, consumed: number, limit: number) => ({ key, consumed, limit, limitKind: "tokens" });
const seatCard = (over: Partial<EscalationLike> = {}) =>
  esc({ reason: "agent_budget_exhausted", raisedBy: "dev", conflictKey: `budget:agent:${GOAL}/dev`, detail: { key: `agent:${GOAL}/dev`, agentId: "dev", consumed: 200000, limit: 200000, owedAsks: 2 }, ...over });

test("a seat's own budget card parks that seat and says the rest of the mesh keeps working: it never halts the mission", () => {
  const t = escalationText(seatCard(), ctx());
  assert.equal(t.title, "dev ran out of tokens");
  assert.match(t.what, /^dev is parked: it has spent 200k of its 200k token budget, and nothing raises it automatically\./);
  assert.match(t.what, /Its mail and the 2 asks it owes wait for it\. The rest of the mesh keeps working\.$/);
  assert.doesNotMatch(t.what, /stopped the mission|halted the mission|mission is paused/);
  assert.deepEqual(holdsOf(seatCard()), { scope: "seat", seat: "dev" });
  assert.equal(holdsLine(holdsOf(seatCard())), "Holds up dev only. The rest of the mesh keeps working.");
});

test("the card raised by the termination manager for the same reason is the one that does halt the mission", () => {
  const e = esc({ reason: "agent_budget_exhausted", detail: { key: `agent:${GOAL}/dev`, consumed: 200000, limit: 200000, parkedSeats: ["dev", "qa"] } });
  assert.equal(seatOfBudgetCard(e), null, "no seat conflict key: this is not a seat card");
  assert.deepEqual(holdsOf(e), { scope: "mission" });
  const t = escalationText(e, ctx());
  assert.equal(t.title, "Every seat is out of tokens");
  assert.match(t.what, /^Every live seat has spent its own token budget \(dev, qa\), so nobody can take a turn and the watchdog halted the mission\./);
});

test("a seat card keyed to another goal is not this goal's seat card", () => {
  assert.equal(seatOfBudgetCard({ conflictKey: "budget:agent:goal-OTHER/dev", goalId: GOAL }), null);
  assert.equal(seatOfBudgetCard({ conflictKey: "budget:agent:goal-1/dev", goalId: GOAL }), "dev");
  assert.equal(seatOfBudgetCard({ conflictKey: "budget:mission:goal-1" }), null);
});

test("the meter reads the live ledger first, because the limit may have been raised since the card was written", () => {
  const status = { budgets: [ledger(`agent:${GOAL}/dev`, 250000, 400000)] };
  const b = budgetInfoOf(seatCard(), status, verdictText);
  assert.deepEqual([b.consumed, b.limit], [250000, 400000]);
  assert.deepEqual([budgetInfoOf(seatCard(), { budgets: [] }, verdictText).consumed, budgetInfoOf(seatCard(), { budgets: [] }, verdictText).limit], [200000, 200000], "the card's own figures when the ledger is not on /status");
});

test("a mission budget card raised at the door carries no figures, so they come from the mission's ledger", () => {
  const status = { budgets: [ledger("mission:goal-1", 2_100_000, 2_000_000)] };
  const door = esc({ reason: "budget_exhausted", raisedBy: "dev", conflictKey: "budget:mission:goal-1", detail: { key: "mission:goal-1", reason: "short" } });
  const b = budgetInfoOf(door, status, verdictText);
  assert.equal(b.key, "mission:goal-1");
  assert.deepEqual([b.consumed, b.limit, b.raisable], [2_100_000, 2_000_000, true]);
  assert.equal(b.what, "2.1M of 2.0M mission tokens are spent. Nobody can run until you raise the limit.");
  const latched = budgetInfoOf(door, { budgets: [ledger("mission:goal-1", 16_850, 20_000)] }, verdictText);
  assert.equal(latched.what, "16.9k of 20.0k mission tokens are spent, and what is left is not enough for the next turn. Nobody can run until you raise the limit.", "the door raises the card when the next turn does not fit, so the ledger can read under its limit");
  const none = budgetInfoOf(esc({ reason: "budget_exhausted", detail: {} }), { budgets: [] }, verdictText);
  assert.equal(none.raisable, false, "no ledger to raise: the card can only be answered");
});

test("a budget card does not say its effect twice: the line under the form says it, so the text above says only what a bare response leaves", () => {
  const status = { budgets: [ledger("mission:goal-1", 16_850, 20_000), ledger(`agent:${GOAL}/dev`, 200_000, 200_000)] };
  const door = esc({ reason: "budget_exhausted", raisedBy: "dev", detail: { key: "mission:goal-1" } });
  const all = esc({ reason: "agent_budget_exhausted", detail: { key: `agent:${GOAL}/dev`, parkedSeats: ["dev"] } });
  for (const [name, e] of [["mission", door], ["every seat", all], ["one seat", seatCard()]] as const) {
    const b = budgetInfoOf(e, status, verdictText);
    assert.doesNotMatch(b.next, /takes effect|no restart|below|above/i, `${name}: the form's own line says when it takes effect, and where the form is is plain to see`);
  }
  assert.equal(budgetInfoOf(seatCard(), status, verdictText).next, "", "a seat's card has nothing to add to what it says and to the line under the form");
  assert.match(budgetInfoOf(door, status, verdictText).next, /^Responding without adding tokens leaves the budget spent, so nobody can run\.$/);
  assert.match(budgetInfoOf(all, status, verdictText).next, /so the mission halts again\.$/);
  const plan = answerPlan({ kind: "budget", parked: false, holds: { scope: "mission" }, limit: 20_000, placeholder: "" });
  assert.match(plan.consequence, /^Takes effect at once, with no restart\./, "said once, where the button is");
});

test("the event cap and the time limit are raised to double, and a thread without a key cannot be raised", () => {
  const events = budgetInfoOf(esc({ reason: "max_events_exceeded", detail: { events: 10_050, limit: 10_000 } }), { goal: { budget: { maxEvents: 10_000 } } }, verdictText);
  assert.equal(events.configCap, "events");
  assert.equal(capTarget("events", events, { goal: { budget: { maxEvents: 10_000 } } }), 20_000);
  assert.equal(capTarget("time", undefined, { goal: { budget: { wallClockMinutes: 60 } } }), 120);
  assert.equal(capTarget("time", undefined, {}), 480, "no live figure: double the default");
  assert.equal(capTarget("time", undefined, { goal: { budget: { wallClockMinutes: 0.05 } } }), 1, "the server keeps whole minutes: a limit under one is raised to one, not to 0.1 (which it would floor to nothing)");
  assert.equal(capTarget("time", undefined, { goal: { budget: { wallClockMinutes: 1.5 } } }), 3);
  assert.equal(capTarget("time", undefined, { goal: { budget: { wallClockMinutes: 1 } } }), 2, "always above the current limit, as the server insists");
  assert.equal(answerPlan({ kind: "cap", parked: false, holds: { scope: "mission" }, budget: { configCap: "time" } as AnswerInput["budget"], capTarget: 1, placeholder: "" }).primary.label, "Raise the time limit to 1 minute and resume");
  const thread = budgetInfoOf(esc({ reason: "thread_budget_exhausted", detail: {} }), {}, verdictText);
  assert.equal(thread.raisable, false);
});

/* ------------------------------- evidence ---------------------------------- */

test("evidence resolves to the exact version first, then the newest, and an unresolvable uri stays text", () => {
  const list = [{ id: "a1", type: "Doc", name: "plan", version: 1 }, { id: "a2", type: "Doc", name: "plan", version: 2 }, { id: "b", type: "Doc", name: "other", version: 1 }];
  assert.equal(resolveArtifactId(list, "artifact://Doc/plan/1"), "a1");
  assert.equal(resolveArtifactId(list, "artifact://Doc/plan"), "a2");
  assert.equal(resolveArtifactId(list, "artifact://Doc/plan/9"), "a2", "a version that is gone falls back to the newest");
  assert.equal(resolveArtifactId(list, "artifact://Doc/missing/1"), null);
  assert.equal(resolveArtifactId(list, "not a uri"), null);
});

test("who a card involves: the seats it names, never the watchdogs or the host that raised it", () => {
  assert.deepEqual(escAgents(esc({ reason: "x", raisedBy: "termination-manager", detail: { failedAgents: ["dev"], participants: ["qa", "human"] } })).sort(), ["dev", "qa"]);
  assert.deepEqual(escAgents(esc({ raisedBy: "host-limiter", detail: { usd: 1, ceilingUsd: 1 } })), []);
  assert.deepEqual(escAgents(seatCard()), ["dev"]);
});

test("a watchdog is not a seat: it is named as the mesh, offered no agent chip, and the host is named as the host", () => {
  for (const r of ["termination-manager", "recovery-manager", "deadlock-detector", "collab-watchdog", "stall-watchdog", "host-limiter"]) {
    assert.equal(isSystemRaiser(r), true, r);
    assert.deepEqual(escAgents(esc({ reason: "x", raisedBy: r })), [], `${r} has no seat to open`);
  }
  assert.equal(isSystemRaiser("developer"), false);
  assert.equal(isSystemRaiser(undefined), false);
  assert.equal(raisedByLabel("collab-watchdog"), "the mesh watchdog");
  assert.equal(raisedByLabel("host-limiter"), "the host");
  assert.equal(raisedByLabel("developer"), "developer");
  assert.deepEqual(escAgents(esc({ reason: "collab_overrun:expired", advisory: true, raisedBy: "collab-watchdog", detail: { participants: ["architect", "developer"] } })).sort(), ["architect", "developer"], "the conversation's own seats are still offered");
});

test("waiting time reads as minutes under an hour and hours and minutes after, and is empty when the stamp is unreadable", () => {
  const now = Date.parse("2026-10-04T12:05:00Z");
  assert.equal(ageOf("2026-10-04T12:04:40Z", now), "just now");
  assert.equal(ageOf("2026-10-04T11:48:00Z", now), "17m waiting");
  assert.equal(ageOf("2026-10-04T10:00:00Z", now), "2h 5m waiting");
  assert.equal(ageOf("2026-10-04T11:05:00Z", now), "1h waiting");
  assert.equal(ageOf("nope", now), "");
  assert.equal(ageOf("2026-10-04T13:00:00Z", now), "", "a stamp in the future is not a wait");
});

/* ------------------------------ the answer --------------------------------- */

test("every card takes one kind of answer: a notice is a notice whatever raised it", () => {
  const kind = (e: EscalationLike): CardKind => cardKind(e, e.reason ? budgetInfoOf(e, { budgets: [ledger("mission:goal-1", 1, 1), ledger(`agent:${GOAL}/dev`, 1, 1)] }, verdictText) : undefined);
  assert.equal(kind(esc({ reason: "stalemate:unanswered_request" })), "stuck");
  assert.equal(kind(esc({ reason: "stalemate" })), "derived");
  assert.equal(kind(esc({ reason: "host_spend_ceiling" })), "ceiling");
  assert.equal(kind(esc({ reason: "budget_exhausted", detail: { key: "mission:goal-1" } })), "budget");
  assert.equal(kind(seatCard()), "budget");
  assert.equal(kind(esc({ reason: "max_events_exceeded" })), "cap");
  assert.equal(kind(esc({ reason: "wall_clock_exceeded" })), "cap");
  assert.equal(kind(esc({ reason: "runtime_failure" })), "decision");
  assert.equal(kind(esc({ reason: "budget_exhausted", advisory: true })), "notice");
  assert.equal(kind(esc({ reason: "collab_overrun:expired", advisory: true })), "notice");
});

const input = (over: Partial<AnswerInput> = {}): AnswerInput => ({ kind: "decision", parked: false, holds: { scope: "mission" }, placeholder: "e.g. decided: …", ...over });
const plan = (over: Partial<AnswerInput> = {}) => answerPlan(input(over));

test("on a live project the primary action names what it does to the mission", () => {
  assert.equal(plan().primary.label, "Respond and resume");
  assert.equal(plan({ kind: "stuck", asker: "pm" }).primary.label, "Send answer and resume");
  assert.equal(plan({ kind: "derived", supports: 3 }).primary.label, "Answer all 3 and resume");
  assert.equal(plan({ kind: "derived", supports: 1 }).primary.label, "Answer it and resume", "one request is not 'all 1'");
  assert.equal(plan({ kind: "derived", supports: 1 }).consequence, "Sends this decision to the request listed above and resumes the mission.");
  assert.equal(plan({ kind: "derived", supports: 3 }).consequence, "Sends this decision to all 3 requests listed above and resumes the mission.");
  assert.equal(plan({ kind: "derived", supports: 0 }).primary.label, "Clear this card and resume");
  assert.equal(plan({ kind: "budget", limit: 2_000_000 }).primary.label, "Add 1M tokens and resume");
  assert.equal(plan({ kind: "budget", limit: 200_000 }).primary.label, "Add 100k tokens and resume");
  assert.equal(plan({ kind: "budget" }).primary.label, "Raise the limit and resume", "no ledger limit known: the label does not invent an amount");
  assert.equal(plan({ kind: "cap", capTarget: 20_000, budget: { configCap: "events" } as never }).primary.label, "Raise the event cap to 20k and resume");
  assert.equal(plan({ kind: "cap", capTarget: 120, budget: { configCap: "time" } as never }).primary.label, "Raise the time limit to 120 minutes and resume");
  assert.deepEqual(plan({ kind: "ceiling" }).primary, { id: "open-settings", label: "Raise the ceiling" });
  assert.equal(plan({ kind: "notice" }).primary.label, "Acknowledge");
  assert.equal(plan({ kind: "notice" }).primaryWithText, "Send reply");
});

test("a parked project's card never says it resumes anything, in its button or in the line under it", () => {
  const kinds: Array<Partial<AnswerInput>> = [
    {}, { kind: "stuck", asker: "pm" }, { kind: "derived", supports: 2 }, { kind: "budget", limit: 1_000_000 },
    { kind: "budget", limit: 1_000_000, holds: { scope: "seat", seat: "dev" } },
    { kind: "cap", capTarget: 20_000, budget: { configCap: "events" } as never }, { kind: "ceiling" }, { kind: "notice", holds: { scope: "nothing" } },
  ];
  for (const k of kinds) {
    const p = plan({ ...k, parked: true });
    assert.doesNotMatch(p.primary.label, /resume/i, `${k.kind}: ${p.primary.label}`);
    assert.doesNotMatch(p.consequence, /resumes the mission|and resume|wakes the affected/, `${k.kind}: ${p.consequence}`);
    if (k.kind !== "notice" && k.kind !== "ceiling") assert.match(p.consequence, /The project is parked, so nothing runs until you start the mission\./, `${k.kind}`);
  }
});

test("only a stuck request ends, while parked, by asking whether to start the mission, and only it can be skipped", () => {
  assert.equal(plan({ kind: "stuck", parked: true }).parkedFollowUp, "ask-to-start");
  assert.match(plan({ kind: "stuck", parked: true, asker: "pm" }).consequence, /^Sends your answer to pm\. The project is parked.* You are asked whether to start it next\.$/);
  for (const kind of ["decision", "derived", "budget", "cap", "ceiling", "notice"] as const) assert.equal(plan({ kind }).parkedFollowUp, "leave", kind);
  assert.deepEqual(plan({ kind: "stuck" }).skip, { label: "Skip this request", reasonLabel: "Why is it not needed?", reasonPlaceholder: "e.g. already covered in the design" });
  for (const kind of ["decision", "derived", "budget", "cap", "ceiling", "notice"] as const) assert.equal(plan({ kind }).skip, undefined, `${kind} has nothing waiting that could be skipped`);
});

test("free text is required where it is the answer and optional where it is only a note", () => {
  const required = (kind: AnswerInput["kind"]) => plan({ kind }).text?.required;
  assert.deepEqual(["decision", "stuck", "derived"].map((k) => required(k as never)), [true, true, true]);
  assert.deepEqual(["budget", "ceiling", "notice"].map((k) => required(k as never)), [false, false, false]);
  assert.equal(plan({ kind: "cap" }).text, undefined, "a cap is raised in one click: there is nothing to type");
  assert.equal(plan({ kind: "stuck", asker: "pm" }).text?.label, "Your answer to pm");
  assert.equal(plan({ kind: "stuck" }).text?.label, "Your answer to the agent");
});

test("a budget card offers the one-click raise and its alternatives with the new limits spelled out", () => {
  const p = plan({ kind: "budget", limit: 1_000_000 });
  assert.deepEqual(p.raise, { limit: 1_500_000, doubleLimit: 2_000_000, doubleLabel: "Double it (2M)" });
  assert.equal(plan({ kind: "budget" }).raise, undefined);
});

test("a seat's budget card says the rest of the mesh was never held, and a mission's says it resumes the mission", () => {
  const seat = plan({ kind: "budget", limit: 200_000, holds: { scope: "seat", seat: "dev" } });
  assert.equal(seat.consequence, "Takes effect at once, with no restart. dev takes turns again, and the rest of the mesh was never held.");
  assert.doesNotMatch(seat.consequence, /resumes the mission/);
  assert.equal(plan({ kind: "budget", limit: 200_000 }).consequence, "Takes effect at once, with no restart. Resumes the mission.");
});

test("the ceiling card sends the operator to host settings and keeps a separate way to clear the card afterwards", () => {
  const p = plan({ kind: "ceiling", parked: true });
  assert.deepEqual(p.primary, { id: "open-settings", label: "Raise the ceiling" });
  assert.deepEqual(p.secondary, { id: "respond", label: "Clear this card" });
  assert.match(p.consequence, /takes effect on the next heartbeat, with no restart/);
  assert.match(p.consequence, /then start the mission: the host leaves the project parked/);
  assert.equal(plan({ kind: "decision" }).secondary, undefined, "no other card needs a second action");
});

test("once the ceiling is past the spend the card stops asking for it to be raised and only asks to be cleared", () => {
  const raised = plan({ kind: "ceiling", parked: true, ceilingRaised: true });
  assert.deepEqual(raised.primary, { id: "respond", label: "Clear this card" });
  assert.equal(raised.secondary, undefined);
  assert.equal(raised.emptyText, "ceiling raised", "an empty note is allowed: clearing needs no prose");
  assert.equal(raised.text?.required, false);
  assert.match(raised.consequence, /^Clears the card\. The project is parked, so nothing runs until you start the mission\.$/);
  assert.equal(plan({ kind: "ceiling", parked: false, ceilingRaised: true }).primary.label, "Clear this card and resume");
  const t = escalationText(esc({ reason: "host_spend_ceiling", raisedBy: "host-limiter", detail: { usd: 12.5, ceilingUsd: 10 } }), ctx({ parked: true, ceilingRaised: true }));
  assert.match(t.what, /The ceiling has since been raised past the spend, so this card only needs clearing\./);
  assert.match(t.next, /An open card also holds a finished mission back from delivery\./);
  assert.doesNotMatch(t.next, /Continuing will not hold/, "that warning is false once the ceiling is up");
  assert.match(t.next, /does not restart a project it parked/);
  const live = escalationText(esc({ reason: "host_spend_ceiling", raisedBy: "host-limiter", detail: { usd: 12.5, ceilingUsd: 10 } }), ctx({ parked: false, ceilingRaised: true }));
  assert.doesNotMatch(live.next, /start the mission/, "a project that is already live has nothing to start");
});

test("the ceiling card does not say the mission is paused or that deciding runs anything: the host parked the project, and an answer starts nothing", () => {
  const e = esc({ reason: "host_spend_ceiling", raisedBy: "host-limiter", detail: { usd: 12.5, ceilingUsd: 10 } });
  for (const over of [{ parked: true }, { parked: false }, { parked: true, ceilingRaised: true }]) {
    const t = escalationText(e, ctx(over));
    assert.doesNotMatch(`${t.what} ${t.next}`, /mission is paused|until you decide/i, JSON.stringify(over));
  }
});

test("a notice never promises a restart and never asks for an answer it does not need", () => {
  const p = plan({ kind: "notice", holds: { scope: "nothing" } });
  assert.equal(p.emptyText, "acknowledged", "an empty reply is an acknowledgement");
  assert.match(p.consequence, /^Nothing is held\. The mission carries on whether or not you answer\./);
  assert.doesNotMatch(p.consequence, /resume/);
  assert.equal(p.text?.required, false);
});

test("what an open card holds is read from the card: a notice nothing, a seat's budget one seat, every other card the mission", () => {
  assert.deepEqual(holdsOf(esc({ advisory: true })), { scope: "nothing" });
  assert.deepEqual(holdsOf(esc({ reason: "runtime_failure" })), { scope: "mission" });
  assert.equal(holdsLine({ scope: "mission" }), "Holds up the whole mission.");
  assert.equal(holdsLine({ scope: "nothing" }), "Holds up nothing.");
});

test("after an answer the card says whether the mission moved, from the same state the top bar reads", () => {
  const say = (phase: string, blockingDecisions = 0, primaryLabel: string | null = "Continue") => answerOutcome({ phase, blockingDecisions, primaryLabel });
  assert.deepEqual(say("running", 0, "Pause"), { tone: "ok", text: "Answered. The mission is running again.", action: false });
  assert.deepEqual(say("parked"), { tone: "warn", text: "Answered. The project is parked, so nothing is running yet.", action: true });
  assert.equal(say("needs-you", 2).text, "Answered. 2 more decisions are waiting on you.");
  assert.equal(say("needs-you", 1).text, "Answered. 1 more decision is waiting on you.");
  assert.equal(say("needs-you", 0).text, "Answered. 1 more decision is waiting on you.", "an escalated goal with its list not yet arrived still has one");
  assert.doesNotMatch(say("needs-you", 2).text, /hold/, "what is left may hold a seat or nothing: only 'waiting' is true of every kind");
  assert.equal(say("paused").text, "Answered. The mission is paused.");
  assert.equal(say("ceiling").tone, "bad");
  assert.equal(say("done").action, false, "nothing to start on a delivered mission");
  assert.equal(say("stalled", 0, null).action, false, "no action offered when the mission has none");
  assert.equal(say("offline").tone, "bad");
  assert.equal(say("loading").tone, "neutral");
});

test("the toast after an answer says what it did: a parked project records it, a notice held nothing, a live one resumes", () => {
  const mission = { scope: "mission" } as const;
  assert.deepEqual(answerToast({ parked: false, holds: mission }), { title: "Response sent", msg: "The mission resumes." });
  assert.deepEqual(answerToast({ parked: true, holds: mission, what: "Answer" }), { title: "Answer recorded", msg: "The project is parked, so nothing runs until you start the mission." });
  assert.equal(answerToast({ parked: false, holds: { scope: "nothing" } }).msg, "Nothing was held, so the mission carried on.");
  assert.doesNotMatch(answerToast({ parked: true, holds: { scope: "nothing" } }).msg, /resumes|parked/, "a notice held nothing, so there is nothing to say about parking");
});

test("an answer to a seat's card says that seat takes turns again, not that the mission resumes: it never stopped", () => {
  const seat = { scope: "seat", seat: "dev" } as const;
  assert.equal(answerToast({ parked: false, holds: seat }).msg, "dev takes turns again. The rest of the mesh was never held.");
  assert.doesNotMatch(answerToast({ parked: false, holds: seat }).msg, /resumes/);
  assert.match(answerToast({ parked: true, holds: seat }).msg, /parked, so nothing runs/, "a parked project runs no seat, whatever it held");
  const say = (phase: string, holds: Parameters<typeof answerOutcome>[0]["holds"]) => answerOutcome({ phase, blockingDecisions: 0, primaryLabel: "Pause", holds }).text;
  assert.equal(say("running", seat), "Answered. dev takes turns again. The mission never stopped.");
  assert.equal(say("quiet", seat), "Answered. dev takes turns again; no agent is working right now.");
  assert.equal(say("running", { scope: "mission" }), "Answered. The mission is running again.");
  assert.equal(say("running", undefined), "Answered. The mission is running again.", "no record of what it held: the usual card");
});

test("a notice is acknowledged, not answered, and the mission it never held is not said to have started", () => {
  const none = { scope: "nothing" } as const;
  const say = (phase: string) => answerOutcome({ phase, blockingDecisions: 1, primaryLabel: "Continue", holds: none }).text;
  assert.equal(say("running"), "Acknowledged. The mission carried on.");
  assert.equal(say("quiet"), "Acknowledged. The mission is running; no agent is working right now.");
  assert.equal(say("parked"), "Acknowledged. The project is parked, so nothing is running yet.", "the state is still the state");
  assert.equal(say("needs-you"), "Acknowledged. 1 more decision is waiting on you.");
  assert.equal(say("offline"), "Acknowledged, but the server stopped answering, so the mission's state is not known.");
  for (const phase of ["running", "quiet", "stalled", "needs-you", "parked", "paused", "ceiling", "done", "failed", "offline", "loading"]) assert.doesNotMatch(say(phase), /^Answered/, phase);
});

test("a derived card links only to the requests it summarises that are still open", () => {
  const list = [esc({ id: "a" }), esc({ id: "b", status: "RESPONDED" }), esc({ id: "c" }), esc({ id: "x" })];
  const byDetail = esc({ id: "sum", reason: "stalemate", detail: { openDeadlockEscalations: [{ id: "a" }, { id: "b" }, { id: "missing" }] } });
  assert.deepEqual(openSupports(byDetail, list).map((s) => s.id), ["a"], "answered and unknown ones have no card to jump to");
  const bySupports = esc({ id: "sum", reason: "stalemate", supports: ["c", "b"], detail: { openDeadlockEscalations: [{ id: "a" }] } });
  assert.deepEqual(openSupports(bySupports, list).map((s) => s.id), ["c"], "the card's own supports field outranks the detail");
  assert.deepEqual(openSupports(esc({ reason: "stalemate" }), list), []);
});
