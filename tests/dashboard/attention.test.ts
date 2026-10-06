import test from "node:test";
import assert from "node:assert/strict";

import { advance, attentionOf, faviconFor, notificationFor, type Attention, type AttentionInput, type AttentionKind } from "../../apps/mesh-dashboard/src/attention";
import { describeMission, type MissionFacts, type MissionPhase } from "../../apps/mesh-dashboard/src/mission";

/**
 * Which moments of a mission are news to someone who is not looking at the console, and what the tab's icon says of them. The
 * claim is in the exclusions as much as the inclusions: a pause the person pressed, a closed project and a mission that is merely
 * running tell nobody anything, and a mission that cannot be read right now is not "all clear".
 */

const input = (over: Partial<AttentionInput> = {}): AttentionInput => ({
  phase: "running",
  tone: "ok",
  label: "Running",
  headline: "2 agents working.",
  decisionIds: [],
  decisionTitles: [],
  reason: null,
  goalId: "goal-1",
  deliveredAt: null,
  projectId: "payments",
  projectName: "Payments",
  ...over,
});

const kindOf = (over: Partial<AttentionInput>): AttentionKind | null => attentionOf(input(over))?.kind ?? null;

test("a mission that cannot be read right now is not known, which is not the same as nothing to tell", () => {
  assert.equal(attentionOf(input({ phase: "loading", tone: "neutral", label: "Starting" })), null);
  assert.equal(attentionOf(input({ phase: "offline", tone: "bad", label: "Offline" })), null);
  assert.equal(faviconFor(null), "plain", "no badge claims what is not known");
});

test("every phase has a deliberate answer: three are news, and the person's own pause is not one of them", () => {
  const expected: Record<MissionPhase, AttentionKind | null> = {
    loading: null,
    offline: null,
    down: "none", // a closed project; a crashed one is the next test
    ceiling: "stopped",
    "needs-you": "needs-you",
    failed: "stopped",
    done: "delivered",
    paused: "none",
    parked: "none",
    stalled: "none",
    quiet: "none",
    running: "none",
  };
  for (const [phase, kind] of Object.entries(expected) as Array<[MissionPhase, AttentionKind | null]>) {
    assert.equal(kindOf({ phase, tone: "neutral" }), kind, phase);
  }
});

test("a decision that holds the mission or a seat is told by its id, in an order that does not depend on how the list arrived", () => {
  const a = attentionOf(input({ phase: "needs-you", tone: "bad", decisionIds: ["esc-b", "esc-a"] }))!;
  assert.equal(a.kind, "needs-you");
  assert.deepEqual(a.keys, ["esc-a", "esc-b"]);
  assert.deepEqual(attentionOf(input({ phase: "needs-you", tone: "bad", decisionIds: ["esc-a", "esc-b"] }))!.keys, a.keys);
});

test("a goal that is escalated with no card to answer is still a mission waiting on a person, told by its goal", () => {
  const a = attentionOf(input({ phase: "needs-you", tone: "bad", decisionIds: [], goalId: "goal-9" }))!;
  assert.equal(a.kind, "needs-you");
  assert.deepEqual(a.keys, ["halt:goal-9"]);
});

test("a delivery is told by its goal and its completion stamp, so a reopened mission delivered again is news again", () => {
  const first = attentionOf(input({ phase: "done", label: "Delivered", deliveredAt: "2026-10-06T10:00:00Z" }))!;
  const again = attentionOf(input({ phase: "done", label: "Delivered", deliveredAt: "2026-10-06T11:30:00Z" }))!;
  assert.equal(first.kind, "delivered");
  assert.notDeepEqual(first.keys, again.keys);
  assert.deepEqual(first.keys, attentionOf(input({ phase: "done", deliveredAt: "2026-10-06T10:00:00Z" }))!.keys, "the same delivery seen twice is one");
});

test("a failed mission and one parked by the host's ceiling are stops, told apart from each other", () => {
  const failed = attentionOf(input({ phase: "failed", tone: "bad", label: "Failed", reason: "The mission ran out of time." }))!;
  const ceiling = attentionOf(input({ phase: "ceiling", tone: "bad", label: "Spend ceiling" }))!;
  assert.equal(failed.kind, "stopped");
  assert.equal(ceiling.kind, "stopped");
  assert.notDeepEqual(failed.keys, ceiling.keys);
  assert.equal(failed.reason, "The mission ran out of time.");
});

test("a project that crashed or cannot open is a stop; one the person closed is not", () => {
  assert.equal(kindOf({ phase: "down", tone: "bad", label: "Crashed" }), "stopped");
  assert.equal(kindOf({ phase: "down", tone: "neutral", label: "Closed" }), "none");
  assert.notDeepEqual(attentionOf(input({ phase: "down", tone: "bad", label: "Crashed" }))!.keys, attentionOf(input({ phase: "down", tone: "bad", label: "Locked" }))!.keys);
});

test("the person's own pause, a parked project, a quiet or an idle mission and one that is running are nothing to tell", () => {
  for (const phase of ["paused", "parked", "quiet", "stalled", "running"] as const) {
    const a = attentionOf(input({ phase, tone: "warn" }))!;
    assert.equal(a.kind, "none", phase);
    assert.deepEqual(a.keys, [], phase);
  }
});

test("the icon follows the kind: a badge for each of the three, the plain one for everything else", () => {
  const icon = (over: Partial<AttentionInput>): string => faviconFor(attentionOf(input(over)));
  assert.equal(icon({ phase: "needs-you", tone: "bad", decisionIds: ["esc-1"] }), "needs-you");
  assert.equal(icon({ phase: "done" }), "delivered");
  assert.equal(icon({ phase: "failed", tone: "bad" }), "stopped");
  assert.equal(icon({ phase: "ceiling", tone: "bad" }), "stopped");
  assert.equal(icon({ phase: "down", tone: "bad" }), "stopped");
  for (const phase of ["running", "quiet", "stalled", "paused", "parked"] as const) assert.equal(icon({ phase }), "plain", phase);
});

/* The same reading, fed from the mission's own state: what mission.ts calls these phases is what the icon is drawn from. */

const facts = (over: Partial<MissionFacts> = {}): MissionFacts => ({
  hasStatus: true, serverDown: false, projectDown: null, goalStatus: "ACTIVE", parked: false, blockingDecisions: 0, seatHeldDecisions: [],
  advisoryDecisions: 0, hostCeilingTripped: false, working: 2, waiting: 1, runningSteps: 0, hasHistory: true, startupSeats: 2, ...over,
});
const fromMission = (f: MissionFacts, over: Partial<AttentionInput> = {}): Attention | null => {
  const s = describeMission(f);
  return attentionOf(input({ phase: s.phase, tone: s.tone, label: s.label, headline: s.headline, ...over }));
};

test("read through describeMission: a decision on the mission, a delivery and a crash are news; a pause is not", () => {
  assert.equal(fromMission(facts({ blockingDecisions: 1 }), { decisionIds: ["esc-1"] })?.kind, "needs-you");
  assert.equal(fromMission(facts({ goalStatus: "COMPLETED", parked: true, working: 0 }))?.kind, "delivered");
  assert.equal(fromMission(facts({ goalStatus: "FAILED" }))?.kind, "stopped");
  assert.equal(fromMission(facts({ projectDown: { label: "crashed", hint: "The process exited.", severe: true } }))?.kind, "stopped");
  assert.equal(fromMission(facts({ projectDown: { label: "closed", hint: "Closed.", severe: false } }))?.kind, "none");
  assert.equal(fromMission(facts({ goalStatus: "PAUSED", working: 0 }))?.kind, "none");
  assert.equal(fromMission(facts({ serverDown: true })), null);
  assert.equal(fromMission(facts({ hasStatus: false })), null);
  // A seat's own budget card needs the person but does not stop the mission: still a decision waiting on them.
  assert.equal(fromMission(facts({ blockingDecisions: 1, seatHeldDecisions: ["qa"] }), { decisionIds: ["esc-2"] })?.kind, "needs-you");
});

/* ------------------------------ the notification ------------------------------ */

const at = (over: Partial<AttentionInput> = {}): Attention => attentionOf(input(over))!;
const waiting = (...ids: string[]): Attention =>
  at({ phase: "needs-you", tone: "bad", label: "Needs you", headline: `${ids.length} decision${ids.length === 1 ? "" : "s"} waiting on you. The mission is paused until ${ids.length === 1 ? "it is" : "they are"} answered.`, decisionIds: ids, decisionTitles: ids.map((i) => `title of ${i}`) });
const delivered = (stamp = "2026-10-06T10:00:00Z"): Attention => at({ phase: "done", tone: "ok", label: "Delivered", headline: "Delivered. Every mandatory check is evidenced.", deliveredAt: stamp });
const failed = (): Attention => at({ phase: "failed", tone: "bad", label: "Failed", headline: "The mission failed.", reason: "Mission ran out of time. The run exceeded its configured wall-clock limit." });
const running = (): Attention => at();
const paused = (): Attention => at({ phase: "paused", tone: "warn", label: "Paused", headline: "Paused. Nothing is running." });

const HIDDEN = true;
const ENABLED = true;

test("nothing is raised unless the person asked for it and the page is hidden", () => {
  assert.equal(notificationFor(running(), waiting("esc-1"), HIDDEN, !ENABLED), null, "not asked for");
  assert.equal(notificationFor(running(), waiting("esc-1"), !HIDDEN, ENABLED), null, "the page is in view and says it itself");
  assert.equal(notificationFor(running(), delivered(), !HIDDEN, ENABLED), null);
  assert.equal(notificationFor(running(), failed(), !HIDDEN, ENABLED), null);
  assert.ok(notificationFor(running(), waiting("esc-1"), HIDDEN, ENABLED), "asked for and hidden: raised");
});

test("the first thing the page reads is what it opened on, not something that happened", () => {
  assert.equal(notificationFor(null, waiting("esc-1"), HIDDEN, ENABLED), null);
  assert.equal(notificationFor(null, delivered(), HIDDEN, ENABLED), null);
  assert.equal(notificationFor(null, failed(), HIDDEN, ENABLED), null);
});

test("a decision that starts to wait is told once, with what the page says and the cards' own words", () => {
  const n = notificationFor(running(), waiting("esc-1"), HIDDEN, ENABLED)!;
  assert.equal(n.title, "Needs you · Payments");
  assert.equal(n.body, "1 decision waiting on you. The mission is paused until it is answered. Waiting: title of esc-1.");
  assert.equal(n.goTo, "escalations");
  assert.equal(n.tag, "curule:needs-you:payments");
  assert.equal(n.renotify, true);
  assert.equal(notificationFor(waiting("esc-1"), waiting("esc-1"), HIDDEN, ENABLED), null, "the same decision seen again is not new, however often the status is read");
});

test("a second decision is news; a decision answered, or one of two answered, is not", () => {
  const two = notificationFor(waiting("esc-1"), waiting("esc-1", "esc-2"), HIDDEN, ENABLED)!;
  assert.match(two.body, /^2 decisions waiting on you\./);
  assert.match(two.body, /Waiting: title of esc-1 and title of esc-2\.$/);
  assert.equal(two.tag, "curule:needs-you:payments", "the same tag, so it replaces the first notice instead of stacking under it");
  assert.equal(notificationFor(waiting("esc-1", "esc-2"), waiting("esc-2"), HIDDEN, ENABLED), null, "one of two answered");
  assert.equal(notificationFor(waiting("esc-2"), running(), HIDDEN, ENABLED), null, "all answered: the mission runs on");
  assert.ok(notificationFor(waiting("esc-1", "esc-2"), waiting("esc-2", "esc-3"), HIDDEN, ENABLED), "one answered and a new one raised: the new one is news");
});

test("the notice names at most two decisions and counts the rest", () => {
  const n = notificationFor(running(), waiting("a", "b", "c", "d"), HIDDEN, ENABLED)!;
  assert.match(n.body, /Waiting: title of a and title of b, and 2 more\.$/);
});

test("a decision with no title to give still says what the page says", () => {
  const bare = at({ phase: "needs-you", tone: "bad", label: "Needs you", headline: "1 decision waiting on you. The mission is paused until it is answered.", decisionIds: ["esc-1"], decisionTitles: [] });
  assert.equal(notificationFor(running(), bare, HIDDEN, ENABLED)!.body, "1 decision waiting on you. The mission is paused until it is answered.");
});

test("a delivery is told once, by its stamp; delivered again after a reopen, it is told again", () => {
  const n = notificationFor(running(), delivered(), HIDDEN, ENABLED)!;
  assert.equal(n.title, "Delivered · Payments");
  assert.equal(n.body, "Every mandatory check is evidenced.", "the title already says Delivered");
  assert.equal(n.goTo, "overview");
  assert.equal(n.renotify, false);
  assert.equal(notificationFor(delivered(), delivered(), HIDDEN, ENABLED), null, "the same delivery seen again");
  assert.ok(notificationFor(waiting("esc-1"), delivered(), HIDDEN, ENABLED), "answered and then delivered");
  assert.ok(notificationFor(running(), delivered("2026-10-06T11:30:00Z"), HIDDEN, ENABLED), "a reopened mission delivered again");
  assert.equal(notificationFor(delivered(), delivered("2026-10-06T11:30:00Z"), HIDDEN, ENABLED) !== null, true, "a new stamp is a new delivery even without a step between");
});

test("a mission that stops on its own says why when the log does, and what the page says when it does not", () => {
  const n = notificationFor(running(), failed(), HIDDEN, ENABLED)!;
  assert.equal(n.title, "Failed · Payments");
  assert.equal(n.body, "Mission ran out of time. The run exceeded its configured wall-clock limit.");
  assert.equal(n.goTo, "overview");
  assert.equal(n.tag, "curule:stopped:payments");
  const noReason = at({ phase: "failed", tone: "bad", label: "Failed", headline: "The mission failed.", reason: null });
  assert.equal(notificationFor(running(), noReason, HIDDEN, ENABLED)!.body, "The mission failed.");
  const ceiling = at({ phase: "ceiling", tone: "bad", label: "Spend ceiling", headline: "The host reached its spend ceiling, so this project is parked." });
  assert.equal(notificationFor(running(), ceiling, HIDDEN, ENABLED)!.body, "The host reached its spend ceiling, so this project is parked.");
  const crashed = at({ phase: "down", tone: "bad", label: "Crashed", headline: "Crashed: out of memory. Retrying in 5s." });
  assert.equal(notificationFor(running(), crashed, HIDDEN, ENABLED)!.title, "Crashed · Payments");
  assert.equal(notificationFor(failed(), failed(), HIDDEN, ENABLED), null, "the same stop seen again");
});

test("a pause the person pressed, a project they closed and a mission that is merely running never notify", () => {
  assert.equal(notificationFor(running(), paused(), HIDDEN, ENABLED), null);
  assert.equal(notificationFor(paused(), running(), HIDDEN, ENABLED), null, "resuming is not news either");
  const closed = at({ phase: "down", tone: "neutral", label: "Closed", headline: "Closed." });
  assert.equal(notificationFor(running(), closed, HIDDEN, ENABLED), null);
  assert.equal(notificationFor(waiting("esc-1"), paused(), HIDDEN, ENABLED), null);
});

test("nothing to tell never notifies, whatever it carries", () => {
  const odd: Attention = { ...running(), keys: ["something-new"] };
  assert.equal(odd.kind, "none");
  assert.equal(notificationFor(delivered(), odd, HIDDEN, ENABLED), null);
});

test("a mission that cannot be read right now never notifies", () => {
  assert.equal(notificationFor(running(), null, HIDDEN, ENABLED), null);
  assert.equal(notificationFor(waiting("esc-1"), null, HIDDEN, ENABLED), null);
});

test("each kind of news has its own tag, scoped to the project, so notices of two projects never replace each other", () => {
  const tags = [waiting("esc-1"), delivered(), failed()].map((a) => notificationFor(running(), a, HIDDEN, ENABLED)!.tag);
  assert.equal(new Set(tags).size, 3);
  const other = notificationFor(running(), at({ ...{}, phase: "done", label: "Delivered", headline: "Delivered. Every mandatory check is evidenced.", projectId: "billing", projectName: "Billing" }), HIDDEN, ENABLED)!;
  assert.equal(other.tag, "curule:delivered:billing");
  assert.equal(attentionOf(input({ projectId: null, phase: "done" }))!.scope, "mesh", "a server that runs one mesh has no project id");
});

test("a notice never carries an id, a code or an exclamation mark", () => {
  const cards = at({
    phase: "needs-you", tone: "bad", label: "Needs you", headline: "2 decisions waiting on you. The mission is paused until they are answered.",
    decisionIds: ["esc-M495XBDZ006633442d05", "esc-M495XBDZ006633442d06"], decisionTitles: ["Mission ran out of tokens", "Stalemate (1 waiting)"],
  });
  const all = [
    notificationFor(running(), cards, HIDDEN, ENABLED)!,
    notificationFor(running(), delivered(), HIDDEN, ENABLED)!,
    notificationFor(running(), failed(), HIDDEN, ENABLED)!,
  ];
  for (const n of all) {
    const text = `${n.title} ${n.body}`;
    assert.doesNotMatch(text, /esc-|goal-|!/, text);
    assert.ok(n.tag.length > 0 && n.title.length > 0 && n.body.length > 0);
  }
});

test("watching a mission: the first read starts it, a read that fails changes nothing, and a decision is never told twice across a blink", () => {
  let last: Attention | null = null;
  const told: string[] = [];
  const step = (next: Attention | null, hidden = HIDDEN, enabled = ENABLED): void => {
    const r = advance(last, next, hidden, enabled);
    last = r.last;
    if (r.notice) told.push(r.notice.title);
  };
  step(waiting("esc-1"));
  assert.deepEqual(told, [], "the page opened on a waiting decision: not news");
  step(null);
  step(waiting("esc-1"));
  assert.deepEqual(told, [], "the server blinked and came back: the same decision");
  step(waiting("esc-1", "esc-2"));
  assert.deepEqual(told, ["Needs you · Payments"], "a second decision is news");
  step(null);
  step(waiting("esc-1", "esc-2"));
  step(running());
  step(delivered());
  assert.deepEqual(told, ["Needs you · Payments", "Delivered · Payments"]);
  assert.equal(last, advance(last, null, HIDDEN, ENABLED).last, "an unreadable moment keeps what was known");
});

test("turning notifications on while a decision waits does not tell the person about it after the fact", () => {
  let last: Attention | null = null;
  const told: string[] = [];
  const step = (next: Attention, enabled: boolean): void => {
    const r = advance(last, next, HIDDEN, enabled);
    last = r.last;
    if (r.notice) told.push(r.notice.title);
  };
  step(waiting("esc-1"), false);
  step(waiting("esc-1"), true);
  assert.deepEqual(told, []);
  step(waiting("esc-1", "esc-2"), true);
  assert.equal(told.length, 1);
});

test("a decision that arrives while the page is in view is not told later, when the person looks away", () => {
  let last: Attention | null = null;
  const told: string[] = [];
  const step = (next: Attention, hidden: boolean): void => {
    const r = advance(last, next, hidden, ENABLED);
    last = r.last;
    if (r.notice) told.push(r.notice.title);
  };
  step(running(), !HIDDEN);
  step(waiting("esc-1"), !HIDDEN);
  step(waiting("esc-1"), HIDDEN);
  assert.deepEqual(told, [], "they saw it arrive; the icon and the title still say it is waiting");
});
