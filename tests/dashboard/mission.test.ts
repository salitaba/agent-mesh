import test from "node:test";
import assert from "node:assert/strict";

import { barActionIsHere, describeMission, documentTitle, factsFromStatus, type MissionFacts } from "../../apps/mesh-dashboard/src/mission";

/**
 * The console used to say three different things about one mission: the top bar read PARKED beside a goal that said "done",
 * the Overview stacked "Parked. Continue" over "Goal met", and a keyboard shortcut paused a live mission without asking.
 * `describeMission` is the one reading; these pin its precedence, which is the claim.
 */

const facts = (over: Partial<MissionFacts> = {}): MissionFacts => ({
  hasStatus: true,
  serverDown: false,
  projectDown: null,
  goalStatus: "ACTIVE",
  parked: false,
  blockingDecisions: 0,
  seatHeldDecisions: [],
  advisoryDecisions: 0,
  hostCeilingTripped: false,
  working: 2,
  waiting: 1,
  runningSteps: 0,
  hasHistory: true,
  startupSeats: 2,
  ...over,
});

test("a live mission with agents working is running, and the one control is Pause", () => {
  const s = describeMission(facts());
  assert.equal(s.phase, "running");
  assert.equal(s.tone, "ok");
  assert.equal(s.pulse, true);
  assert.equal(s.primary?.action, "pause");
  assert.equal(s.headline, "2 agents working.");
});

test("a finished mission that is parked is delivered, not parked: no Continue, and reopening is a secondary action", () => {
  const s = describeMission(facts({ goalStatus: "COMPLETED", parked: true, working: 0, waiting: 7 }));
  assert.equal(s.phase, "done");
  assert.equal(s.label, "Delivered");
  assert.equal(s.primary, null, "nothing to start on a finished mission");
  assert.deepEqual(s.secondary.map((c) => c.action), ["reopen"]);
  assert.equal(s.parked, true, "the fact is still reported, for a quiet note");
});

test("a delivered mission offers what people do with a result: read it, send it back with feedback, then see what it cost and replay it", () => {
  const s = describeMission(facts({ goalStatus: "COMPLETED", parked: true, working: 0 }));
  assert.deepEqual(s.next.map((n) => [n.action, n.look]), [["files", "primary"], ["reopen", "soft"], ["cost", "quiet"], ["replay", "quiet"]]);
  assert.deepEqual(s.next.map((n) => n.label), ["Open the files", "Reopen with feedback", "What it cost", "Replay"]);
  assert.equal(s.next.filter((n) => n.look !== "quiet").length, 2, "the hero keeps its calm: two that look like buttons, the rest quiet");
  for (const n of s.next) assert.ok(n.hint.length > 20, `${n.action} says what it does`);
});

test("reopening is one action with one name, whether the bar's menu or the hero offers it, and it says what the dialog asks for", () => {
  const s = describeMission(facts({ goalStatus: "COMPLETED", working: 0 }));
  const hero = s.next.find((n) => n.action === "reopen")!;
  assert.deepEqual([hero.label, hero.hint], [s.secondary[0]!.label, s.secondary[0]!.hint]);
  assert.match(hero.hint, /Say what was wrong/);
  assert.match(hero.hint, /Nothing is deleted/);
});

test("a failed mission's reopen is the delivered one's: the same name and the same words about what it asks for", () => {
  const failed = describeMission(facts({ goalStatus: "FAILED", working: 0 }));
  const done = describeMission(facts({ goalStatus: "COMPLETED", working: 0 }));
  assert.deepEqual([failed.primary!.label, failed.primary!.hint], [done.secondary[0]!.label, done.secondary[0]!.hint]);
  assert.equal(failed.primary!.label, "Reopen with feedback", "the dialog it opens asks for what was wrong, and the button says so");
});

test("for every state with a primary action the hero offers that one action, as the bar does, and the pause is the quiet one", () => {
  const states = [
    facts({ goalStatus: "PAUSED", working: 0 }), facts({ parked: true, working: 0 }), facts({ blockingDecisions: 1 }), facts({ goalStatus: "FAILED", working: 0 }),
    facts({ parked: true, hostCeilingTripped: true, working: 0 }), facts({ working: 0, waiting: 0 }), facts(), facts({ working: 0, waiting: 3 }),
  ];
  for (const f of states) {
    const s = describeMission(f);
    assert.ok(s.primary, s.phase);
    assert.deepEqual(s.next.map((n) => [n.action, n.label, n.hint]), [[s.primary!.action, s.primary!.label, s.primary!.hint]], `${s.phase}: the bar and the hero offer the same thing`);
    assert.equal(s.next[0]!.look, s.primary!.action === "pause" ? "soft" : "primary", s.phase);
  }
});

test("a state with nothing to press offers nothing in the hero either", () => {
  for (const f of [facts({ serverDown: true }), facts({ hasStatus: false }), facts({ goalStatus: "" }), facts({ projectDown: { label: "closed", hint: "Closed.", severe: false } })]) {
    const s = describeMission(f);
    assert.equal(s.primary, null, s.phase);
    assert.deepEqual(s.next, [], s.phase);
  }
});

test("the result's actions are not mission actions: the bar and its handler never see them", () => {
  const bar = new Set(["start", "pause", "resume", "reopen", "review", "settings", "agents", "designer"]);
  const s = describeMission(facts({ goalStatus: "COMPLETED", working: 0 }));
  for (const c of [s.primary, ...s.secondary]) if (c) assert.ok(bar.has(c.action), `${c.action} is something done to the mission`);
  assert.deepEqual(s.next.filter((n) => !bar.has(n.action)).map((n) => n.action), ["files", "cost", "replay"]);
});

test("parked with unfinished work offers Continue when there is history and Start when there is none", () => {
  const resumed = describeMission(facts({ parked: true, working: 0 }));
  assert.equal(resumed.phase, "parked");
  assert.deepEqual([resumed.primary?.action, resumed.primary?.label], ["start", "Continue"]);
  const fresh = describeMission(facts({ parked: true, working: 0, hasHistory: false }));
  assert.deepEqual([fresh.primary?.action, fresh.primary?.label], ["start", "Start mission"]);
});

test("a blocking decision outranks parked and paused: the operator is the blocker", () => {
  const s = describeMission(facts({ goalStatus: "PAUSED", parked: true, blockingDecisions: 2 }));
  assert.equal(s.phase, "needs-you");
  assert.equal(s.primary?.action, "review");
  assert.match(s.headline, /^2 decisions waiting on you\./);
});

test("an ESCALATED goal needs the operator even when the escalation list has not arrived yet", () => {
  const s = describeMission(facts({ goalStatus: "ESCALATED", blockingDecisions: 0 }));
  assert.equal(s.phase, "needs-you");
  assert.match(s.headline, /^1 decision waiting on you\./);
});

test("an advisory notice holds nothing: the mission is still running and the caller counts the notice", () => {
  const s = describeMission(facts({ advisoryDecisions: 1 }));
  assert.equal(s.phase, "running");
  assert.equal(s.primary?.action, "pause");
});

test("a host spend ceiling parks the project and the only action is to raise it; Continue would be re-parked", () => {
  const s = describeMission(facts({ parked: true, hostCeilingTripped: true, working: 0 }));
  assert.equal(s.phase, "ceiling");
  assert.equal(s.primary?.action, "settings");
  assert.equal(s.secondary.length, 0);
});

test("a ceiling that did not park this project, or a mission already over, is not the headline", () => {
  assert.equal(describeMission(facts({ hostCeilingTripped: true })).phase, "running", "this project is live");
  assert.equal(describeMission(facts({ parked: true, hostCeilingTripped: true, goalStatus: "COMPLETED" })).phase, "done");
});

test("paused offers Resume", () => {
  const s = describeMission(facts({ goalStatus: "PAUSED", working: 0 }));
  assert.equal(s.phase, "paused");
  assert.equal(s.primary?.action, "resume");
});

test("failed offers Reopen as the primary action", () => {
  const s = describeMission(facts({ goalStatus: "FAILED", working: 0 }));
  assert.equal(s.phase, "failed");
  assert.equal(s.tone, "bad");
  assert.equal(s.primary?.action, "reopen");
});

test("live with nobody working and nobody waiting is a fault, and the action depends on whether any seat was meant to start", () => {
  const configured = describeMission(facts({ working: 0, waiting: 0 }));
  assert.equal(configured.phase, "stalled");
  assert.deepEqual([configured.primary?.action, configured.secondary.map((c) => c.action)], ["agents", ["pause"]]);
  const none = describeMission(facts({ working: 0, waiting: 0, startupSeats: 0 }));
  assert.equal(none.primary?.action, "designer");
});

test("live with agents waiting but none working is quiet, not stalled", () => {
  const s = describeMission(facts({ working: 0, waiting: 3 }));
  assert.equal(s.phase, "quiet");
  assert.equal(s.tone, "neutral");
  assert.equal(s.headline, "Running. 3 agents waiting, none working right now.");
});

test("a turn in flight counts as running even when the roster has not caught up", () => {
  assert.equal(describeMission(facts({ working: 0, waiting: 0, runningSteps: 1 })).phase, "running");
});

test("no answer from the server outranks everything, with or without an earlier status", () => {
  assert.equal(describeMission(facts({ hasStatus: false, serverDown: true })).phase, "offline");
  const stale = describeMission(facts({ serverDown: true, goalStatus: "COMPLETED" }));
  assert.equal(stale.phase, "offline");
  assert.match(stale.headline, /may be stale/);
  assert.equal(stale.primary, null, "no control on a state that cannot be acted on");
  assert.equal(describeMission(facts({ hasStatus: false })).phase, "loading");
});

test("a project whose process is not running says so, in the tab's words, whatever status the console still holds", () => {
  const crashed = describeMission(facts({ projectDown: { label: "crashed", hint: "Crashed: out of memory. Restarted 2x.", severe: true } }));
  assert.equal(crashed.phase, "down");
  assert.equal(crashed.tone, "bad");
  assert.equal(crashed.label, "Crashed");
  assert.equal(crashed.headline, "Crashed: out of memory. Restarted 2x.");
  assert.equal(crashed.primary, null, "the restart lives in the notice under the tabs, with the reason");
  const closed = describeMission(facts({ projectDown: { label: "closed", hint: "Closed: no process is running for this project.", severe: false } }));
  assert.deepEqual([closed.phase, closed.tone, closed.label], ["down", "neutral", "Closed"], "a closed project is not an alarm");
  // The stale status was ACTIVE and running; the crash outranks it. With no status at all it is still the project that is down.
  assert.equal(describeMission(facts({ hasStatus: false, projectDown: { label: "locked", hint: "Locked.", severe: true } })).phase, "down");
});

test("the server not answering outranks a project being down: nothing about either can be trusted", () => {
  assert.equal(describeMission(facts({ serverDown: true, projectDown: { label: "crashed", hint: "Crashed.", severe: true } })).phase, "offline");
});

test("a status with no goal yet is a project still starting, not a mesh with nothing to do", () => {
  // A mesh must declare a goal, so a status without one is a child that answered before it finished reading its log.
  const s = describeMission(facts({ goalStatus: "" }));
  assert.equal(s.phase, "loading");
  assert.equal(s.label, "Starting");
  assert.equal(s.primary, null, "nothing to press while it starts");
  assert.doesNotMatch(s.headline, /no goal/i, "saying the mesh has no goal would be false");
});

test("a decision that holds only a seat does not say the mission is paused: it names what is held", () => {
  const one = describeMission(facts({ blockingDecisions: 1, seatHeldDecisions: ["developer"] }));
  assert.equal(one.phase, "needs-you");
  assert.equal(one.tone, "warn", "the person is needed, but nothing has stopped");
  assert.equal(one.headline, "1 decision waiting on you. It holds developer only, and the rest of the mesh keeps working.");
  assert.equal(one.primary?.action, "review");
  assert.equal(
    describeMission(facts({ blockingDecisions: 2, seatHeldDecisions: ["developer", "qa"] })).headline,
    "2 decisions waiting on you. They hold developer and qa only, and the rest of the mesh keeps working.",
  );
  assert.equal(
    describeMission(facts({ blockingDecisions: 2, seatHeldDecisions: ["developer", "developer"] })).headline,
    "2 decisions waiting on you. They hold developer only, and the rest of the mesh keeps working.",
    "one seat is named once",
  );
});

test("when some decisions hold the mission and some hold a seat, the pause is tied to the ones that hold the mission", () => {
  const mixed = describeMission(facts({ blockingDecisions: 2, seatHeldDecisions: ["qa"] }));
  assert.equal(mixed.tone, "bad");
  assert.equal(mixed.headline, "2 decisions waiting on you. The mission is paused until the one that holds it is answered.");
  const more = describeMission(facts({ blockingDecisions: 4, seatHeldDecisions: ["qa"] }));
  assert.equal(more.headline, "4 decisions waiting on you. The mission is paused until the 3 that hold it are answered.");
});

test("an ESCALATED goal is halted whatever the cards say, so seat cards do not soften it", () => {
  const s = describeMission(facts({ goalStatus: "ESCALATED", blockingDecisions: 1, seatHeldDecisions: ["developer"] }));
  assert.equal(s.tone, "bad");
  assert.equal(s.headline, "1 decision waiting on you. The mission is paused until it is answered.");
});

test("a finished mission is not reopened by a seat card that is still open", () => {
  assert.equal(describeMission(facts({ goalStatus: "COMPLETED", blockingDecisions: 1, seatHeldDecisions: ["developer"], working: 0 })).phase, "done");
});

test("factsFromStatus reads the payload: human excluded, blocking and advisory decisions split, parked from either field", () => {
  const f = factsFromStatus(
    {
      goal: { status: "ACTIVE" },
      mode: "parked",
      agents: [
        { id: "human", lifecycle: "WORKING" },
        { id: "dev", lifecycle: "WORKING" },
        { id: "qa", lifecycle: "WAITING" },
        { id: "pm", lifecycle: "IDLE" },
      ],
      openEscalations: [{ id: "a" }, { id: "b", advisory: true }, { id: "c", conflictKey: "budget:agent:goal-1/developer", goalId: "goal-1" }],
      startupActivateCount: 0,
    },
    { runningSteps: 2, hasHistory: true },
  );
  assert.deepEqual(
    { w: f.working, q: f.waiting, b: f.blockingDecisions, held: f.seatHeldDecisions, a: f.advisoryDecisions, p: f.parked, s: f.startupSeats, r: f.runningSteps },
    { w: 1, q: 1, b: 2, held: ["developer"], a: 1, p: true, s: 0, r: 2 },
  );
  assert.equal(factsFromStatus({ goal: { status: "ACTIVE" }, uiOnly: true }).parked, true);
  assert.equal(factsFromStatus(null).hasStatus, false);
  assert.equal(factsFromStatus({ goal: {} }).startupSeats, null, "a server that predates the field");
});

test("the tab title leads with the count of decisions and says what is true of the mission", () => {
  assert.equal(documentTitle({ phaseLabel: "Needs you", decisions: 2, project: "Payments" }), "(2) Needs you · Payments — Curule");
  assert.equal(documentTitle({ phaseLabel: "Running", decisions: 0, project: "Payments" }), "Running · Payments — Curule");
  assert.equal(documentTitle({ phaseLabel: null, decisions: 0, project: null }), "Curule");
  assert.equal(documentTitle({ phaseLabel: null, decisions: 1, project: null }), "(1) Curule");
});

test("a bar button that only goes to a page stands down on that page; one that acts on the mission never does", () => {
  // "Review decisions" on the Needs you page took the person where they already were, above the card they came to answer.
  assert.equal(barActionIsHere("review", "escalations", "escalations"), true);
  assert.equal(barActionIsHere("review", "gates", "gates"), true, "tool requests only: the review button goes to the tool section");
  assert.equal(barActionIsHere("review", "gates", "escalations"), false, "on the tool section with decisions waiting, it is the way to them");
  assert.equal(barActionIsHere("review", "overview", "escalations"), false);
  assert.equal(barActionIsHere("settings", "hostsettings", "escalations"), true);
  assert.equal(barActionIsHere("settings", "cost", "escalations"), false);
  assert.equal(barActionIsHere("agents", "agents", "escalations"), true);
  assert.equal(barActionIsHere("designer", "designer", "escalations"), true);
  assert.equal(barActionIsHere("agents", "steps", "escalations"), false);
  for (const action of ["start", "pause", "resume", "reopen"] as const) {
    for (const view of ["overview", "escalations", "gates", "agents", "designer", "hostsettings", "events"] as const) assert.equal(barActionIsHere(action, view, "escalations"), false, `${action} on ${view}`);
  }
});
