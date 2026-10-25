import test from "node:test";
import assert from "node:assert/strict";

import {
  EV_FILTER_GROUPS, FOLD_AT, MINI_FEED_ROWS, MINI_FOLD_AT, SEVERITY_ORDER, applySeverity, buildRows, eventHaystack, evGroupOf, evSeverity, facetOne, facetValues,
  filterBase, logIncomplete, logWindowText, miniFeed, newestFirst, parseFacets, setFacet, severityCounts, toggleFacet, topActors, type EventLike,
} from "../../apps/mesh-dashboard/src/eventmodel";

/**
 * The events console's decisions: how important an event is, how the facets combine, and how a newest-first list folds into
 * time headings and runs of bookkeeping.
 */

const NOW = Date.parse("2026-10-04T19:20:00.000Z");
const at = (secondsAgo: number): string => new Date(NOW - secondsAgo * 1000).toISOString();

let n = 0;
const ev = (type: string, secondsAgo: number, extra: Partial<EventLike> = {}): EventLike => ({
  seq: ++n, id: `evt-${n}`, type, timestamp: at(secondsAgo), payload: {}, ...extra,
});

test("severity comes from the catalogue, and an unknown type is shown rather than hidden", () => {
  assert.equal(evSeverity({ type: "goal.completed", payload: {} }), "notice");
  assert.equal(evSeverity({ type: "budget.consumed", payload: {} }), "routine");
  assert.equal(evSeverity({ type: "a.type.from.the.future", payload: {} }), "notice");
});

test("an agent moving into FAILED or BLOCKED is an alert; moving into THINKING is routine bookkeeping", () => {
  assert.equal(evSeverity({ type: "agent.state_changed", payload: { to: "FAILED" } }), "alert");
  assert.equal(evSeverity({ type: "agent.state_changed", payload: { to: "BLOCKED" } }), "alert");
  assert.equal(evSeverity({ type: "agent.state_changed", payload: { to: "THINKING" } }), "routine");
  assert.equal(evSeverity({ type: "agent.state_changed" }), "routine", "a payload with no destination keeps the floor");
});

test("every kind group is reachable, and a type outside all of them is System rather than lost", () => {
  assert.equal(evGroupOf("message.sent"), "message");
  assert.equal(evGroupOf("artifact.created"), "work");
  assert.equal(evGroupOf("agent.failed"), "agent");
  assert.equal(evGroupOf("goal.completed"), "system");
  assert.equal(evGroupOf("never.heard.of.it"), "system");
  const ids = EV_FILTER_GROUPS.map((g) => g.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("the severity order is the order the legend reads: alerts first", () => {
  assert.deepEqual(SEVERITY_ORDER, ["alert", "notice", "routine"]);
});

/* ------------------------------------------------------------- facet string */

test("facets round-trip through one comma-joined string", () => {
  const s = "sev:alert,grp:message,actor:pm";
  assert.deepEqual([...parseFacets(s)], ["sev:alert", "grp:message", "actor:pm"]);
  assert.deepEqual(facetValues(parseFacets(s), "sev"), ["alert"]);
  assert.equal(facetOne(parseFacets(s), "actor"), "pm");
  assert.equal(facetOne(parseFacets(s), "thread"), null);
  assert.deepEqual([...parseFacets("")], []);
});

test("toggling adds an absent facet and removes a present one, leaving the others", () => {
  assert.equal(toggleFacet("", "sev:alert"), "sev:alert");
  assert.equal(toggleFacet("sev:alert", "grp:message"), "sev:alert,grp:message");
  assert.equal(toggleFacet("sev:alert,grp:message", "sev:alert"), "grp:message");
});

test("a single-valued facet replaces its old value, and null clears it", () => {
  assert.equal(setFacet("actor:pm,sev:alert", "actor", "qa"), "sev:alert,actor:qa");
  assert.equal(setFacet("actor:pm,sev:alert", "actor", null), "sev:alert");
  assert.equal(setFacet("", "thread", "turn-1"), "thread:turn-1");
});

/* ---------------------------------------------------------------- filtering */

const NO_FILTER = { search: "", groups: new Set<string>(), actor: null, thread: null };

test("filtering returns newest first whatever order the buffer is in, and drops what does not match", () => {
  n = 0;
  const buf = [
    ev("message.sent", 50, { actorId: "pm" }),
    ev("artifact.created", 40, { actorId: "developer" }),
    ev("message.sent", 30, { actorId: "qa", correlationId: "turn-a" }),
    ev("agent.failed", 20, { actorId: "qa", payload: { error: "boom" } }),
  ];
  const hay = buf.map((e) => eventHaystack(e));
  assert.deepEqual(filterBase(buf, hay, NO_FILTER).map((e) => e.seq), [4, 3, 2, 1]);
  assert.deepEqual(filterBase(buf, hay, { ...NO_FILTER, groups: new Set(["message"]) }).map((e) => e.seq), [3, 1]);
  assert.deepEqual(filterBase(buf, hay, { ...NO_FILTER, actor: "qa" }).map((e) => e.seq), [4, 3]);
  assert.deepEqual(filterBase(buf, hay, { ...NO_FILTER, thread: "turn-a" }).map((e) => e.seq), [3]);
  assert.deepEqual(filterBase(buf, hay, { ...NO_FILTER, search: "boom" }).map((e) => e.seq), [4], "search reaches into the payload");
  assert.deepEqual(filterBase(buf, hay, { ...NO_FILTER, actor: "qa", groups: new Set(["message"]) }).map((e) => e.seq), [3], "facets combine with AND");
});

test("the severity counts describe what the other filters already left, not the whole buffer", () => {
  n = 0;
  const buf = [
    ev("agent.state_changed", 50, { actorId: "qa", payload: { to: "FAILED" } }),
    ev("agent.state_changed", 40, { actorId: "pm", payload: { to: "FAILED" } }),
    ev("message.sent", 30, { actorId: "qa" }),
    ev("budget.consumed", 20, { actorId: "qa" }),
  ];
  const hay = buf.map((e) => eventHaystack(e));
  const everything = severityCounts(filterBase(buf, hay, NO_FILTER));
  assert.deepEqual(everything, { alert: 2, notice: 1, routine: 1 });
  const justQa = severityCounts(filterBase(buf, hay, { ...NO_FILTER, actor: "qa" }));
  assert.deepEqual(justQa, { alert: 1, notice: 1, routine: 1 }, "pm's alert is not counted while only qa is shown");
});

test("the severity facet narrows the list and no severity selected means all of them", () => {
  n = 0;
  const list = [ev("goal.completed", 10), ev("budget.consumed", 9), ev("agent.state_changed", 8, { payload: { to: "FAILED" } })];
  assert.equal(applySeverity(list, new Set()), list, "no facet: the same array");
  assert.deepEqual(applySeverity(list, new Set(["alert"])).map((e) => e.type), ["agent.state_changed"]);
  assert.deepEqual(applySeverity(list, new Set(["alert", "routine"])).map((e) => e.type), ["budget.consumed", "agent.state_changed"]);
});

test("the busiest agents come first, ties break alphabetically, and the list is capped", () => {
  n = 0;
  const buf = [ev("message.sent", 5, { actorId: "qa" }), ev("message.sent", 4, { actorId: "pm" }), ev("message.sent", 3, { actorId: "pm" }), ev("message.sent", 2, { actorId: "architect" }), ev("goal.created", 1)];
  assert.deepEqual(topActors(buf), ["pm", "architect", "qa"]);
  assert.deepEqual(topActors(buf, 1), ["pm"]);
});

/* -------------------------------------------------------------------- rows */

const kinds = (rows: ReturnType<typeof buildRows>): string[] => rows.map((r) => (r.kind === "bucket" ? `#${r.label}` : r.kind === "fold" ? `fold(${r.items.length})` : r.e.type));

test("a run of routine events folds into one row, a shorter run stays as rows, and a notable event ends a run", () => {
  n = 0;
  const list = [
    ev("budget.consumed", 5), ev("budget.consumed", 6), ev("budget.consumed", 7), // newest first: a run of 3
    ev("goal.completed", 8),
    ev("budget.consumed", 9), ev("budget.consumed", 10), // a run of 2: stays
  ];
  assert.equal(FOLD_AT, 3);
  assert.deepEqual(kinds(buildRows(list, NOW, true)), ["#Last 5 minutes", "fold(3)", "goal.completed", "budget.consumed", "budget.consumed"]);
});

test("with folding off every event is its own row", () => {
  n = 0;
  const list = [ev("budget.consumed", 1), ev("budget.consumed", 2), ev("budget.consumed", 3)];
  assert.deepEqual(kinds(buildRows(list, NOW, false)), ["#Last 5 minutes", "budget.consumed", "budget.consumed", "budget.consumed"]);
});

test("a fold never straddles two time headings: it is cut at the boundary", () => {
  n = 0;
  const list = [
    ev("budget.consumed", 4 * 60), ev("budget.consumed", 4 * 60 + 30), // last 5 minutes
    ev("budget.consumed", 6 * 60), ev("budget.consumed", 7 * 60), ev("budget.consumed", 8 * 60), // 5 to 30 minutes
  ];
  assert.deepEqual(kinds(buildRows(list, NOW, true)), [
    "#Last 5 minutes", "budget.consumed", "budget.consumed",
    "#5 to 30 minutes ago", "fold(3)",
  ]);
});

test("a crash is never folded away, even in the middle of routine churn", () => {
  n = 0;
  const list = [
    ev("agent.state_changed", 1, { payload: { to: "WAITING" } }),
    ev("agent.state_changed", 2, { payload: { to: "FAILED" } }),
    ev("agent.state_changed", 3, { payload: { to: "THINKING" } }),
    ev("agent.state_changed", 4, { payload: { to: "WORKING" } }),
    ev("agent.state_changed", 5, { payload: { to: "OBSERVING" } }),
  ];
  const rows = buildRows(list, NOW, true);
  assert.ok(rows.some((r) => r.kind === "event" && r.e.payload.to === "FAILED"));
  assert.deepEqual(kinds(rows), ["#Last 5 minutes", "agent.state_changed", "agent.state_changed", "fold(3)"]);
});

test("a fold is keyed by its oldest event, so rows joining it at the top do not remount it", () => {
  n = 0;
  const base = [ev("budget.consumed", 30), ev("budget.consumed", 40), ev("budget.consumed", 50)];
  const before = buildRows(base, NOW, true).find((r) => r.kind === "fold")!;
  const grown = [ev("budget.consumed", 5), ...base];
  const after = buildRows(grown, NOW, true).find((r) => r.kind === "fold")!;
  assert.equal(after.key, before.key);
  assert.equal(after.kind === "fold" && after.items.length, 4);
});

test("every row has a unique key, so React keeps the right row when the list moves", () => {
  n = 0;
  const list = Array.from({ length: 30 }, (_, i) => ev(i % 4 === 0 ? "goal.progress" : "budget.consumed", i * 20));
  const keys = buildRows(list, NOW, true).map((r) => r.key);
  assert.equal(new Set(keys).size, keys.length);
});

/* -------------------------------------------------------------- mini feed */

const mini = (rows: ReturnType<typeof miniFeed>): string[] => rows.map((r) => (r.kind === "fold" ? `fold(${r.items.length} ${r.what})` : r.e.type));

test("the Overview's summary folds bookkeeping and a run of seats finishing, so the mission's own completion stays in view", () => {
  n = 0;
  const list = [
    ...Array.from({ length: 7 }, (_, i) => ev("agent.completed", i + 1, { payload: { agentId: `seat-${i}` } })),
    ...Array.from({ length: 28 }, (_, i) => ev("budget.released", 20 + i)),
    ev("goal.completed", 60, { payload: { reason: "all_mandatory_criteria_evidenced" } }),
  ];
  assert.equal(MINI_FOLD_AT, 3);
  assert.equal(MINI_FEED_ROWS, 8);
  assert.deepEqual(mini(miniFeed(list)), ["fold(7 seats finished)", "fold(28 routine events)", "goal.completed"]);
});

test("a shorter run of notice events stays as rows, and an alert is never folded", () => {
  n = 0;
  const list = [
    ev("agent.completed", 1), ev("agent.completed", 2),
    ...Array.from({ length: 4 }, (_, i) => ev("agent.state_changed", 3 + i, { payload: { to: "FAILED" } })),
  ];
  assert.deepEqual(mini(miniFeed(list)), ["agent.completed", "agent.completed", "agent.state_changed", "agent.state_changed", "agent.state_changed", "agent.state_changed"]);
});

test("a parked mission's summary is the goal, not the roster: the seats joining fold into one row", () => {
  n = 0;
  const list = [
    ...Array.from({ length: 8 }, (_, i) => ev("agent.created", 3 + i)),
    ev("thread.created", 2),
    ev("goal.created", 1),
  ];
  assert.deepEqual(mini(miniFeed(list)), ["fold(8 joined the team)", "thread.created", "goal.created"]);
});

test("a summary of a busy log is capped, and a fold's key is its oldest event so rows arriving at the top do not remount it", () => {
  n = 0;
  const list = Array.from({ length: 20 }, (_, i) => ev("goal.status_changed", i, { payload: { status: "ACTIVE" } }));
  assert.equal(miniFeed(list).length, MINI_FEED_ROWS);
  const base = [ev("agent.completed", 10), ev("agent.completed", 11), ev("agent.completed", 12)];
  const before = miniFeed(base).find((r) => r.kind === "fold")!;
  const after = miniFeed([ev("agent.completed", 9), ...base]).find((r) => r.kind === "fold")!;
  assert.equal(after.key, before.key);
  assert.equal(after.kind === "fold" && after.items.length, 4);
});

/* The Events page used to trust its newest seq: arriving from the Overview, it inherited that page's newest-200 tail, whose last
 * seq is the log's last, and drew "200 events" with no note while the log held 481. The count is the fact the newest seq cannot
 * give. The foot note then named the page's own buffer (400) as if it were the log. */
test("a newest-first tail is not the whole log: the count is short even when the newest seq is the last", () => {
  assert.equal(logIncomplete(481, 200, 481, 400), true, "the 200-event tail ends at the log's last seq but holds 281 fewer");
  assert.equal(logIncomplete(481, 400, 481, 400), false, "one read's worth is all this page can hold");
  assert.equal(logIncomplete(480, 400, 481, 400), true, "a newer event exists");
  assert.equal(logIncomplete(0, 0, 481, 400), true, "an empty page reads the log");
  assert.equal(logIncomplete(0, 0, 0, 400), false, "an empty log has nothing to read");
  assert.equal(logIncomplete(5, 5, undefined, 400), false, "a count that has not answered is not a reason to read");
  assert.equal(logIncomplete(5, 5, "481", 400), false, "a count that is not a number is not trusted");
  assert.equal(logIncomplete(50, 20, 50, 400), true, "a short page reads the log even if its newest seq is the last");
});

test("the window note says what the page holds against what the log holds, and promises nothing it cannot reach", () => {
  assert.equal(
    logWindowText({ drawn: 300, matched: 400, held: 400, logged: 481 }),
    "Showing the newest 300 of 400 matching events. This page holds the newest 400 of 481; 81 older ones are not loaded.",
  );
  assert.equal(
    logWindowText({ drawn: 200, matched: 200, held: 200, logged: 481 }),
    "Showing all 200 matching events. This page holds the newest 200 of 481; 281 older ones are not loaded.",
  );
  assert.equal(
    logWindowText({ drawn: 10, matched: 10, held: 400, logged: 481 }),
    "Showing all 10 matching events. This page holds the newest 400 of 481; 81 older ones are not loaded.",
    "a filter does not hide the log the page has not read",
  );
  assert.equal(logWindowText({ drawn: 300, matched: 400, held: 400, logged: 0 }), "Showing the newest 300 of 400 matching events.", "before the status answers, the page counts what it holds");
  assert.equal(logWindowText({ drawn: 1, matched: 1, held: 1, logged: 2 }), "Showing all 1 matching event. This page holds the newest 1 of 2; 1 older one is not loaded.");
  assert.equal(logWindowText({ drawn: 481, matched: 481, held: 481, logged: 481 }), null);
  assert.equal(logWindowText({ drawn: 0, matched: 0, held: 0, logged: 0 }), null);
});

/* The store appends what it ingests: the shell's catch-up tail, then the page's own fetch. The first 300 of that array were
 * not the newest 300, so an artifact's own transition could fall outside the window while a wake from the same second was
 * drawn. The list sorts by seq before it filters and caps. */
test("the list is newest-first whichever way the buffer was filled, and sorting does not mutate it", () => {
  const list = [ev("a", 1), ev("b", 2), ev("c", 3)];
  list[0]!.seq = 9; list[1]!.seq = 2; list[2]!.seq = 7;
  assert.deepEqual(newestFirst(list).map((e) => e.seq), [9, 7, 2]);
  assert.deepEqual(list.map((e) => e.seq), [9, 2, 7], "the store's array is not reordered under React");
  const frame = { type: "x", id: "f", timestamp: at(0), seq: undefined } as unknown as EventLike;
  const y = ev("y", 5);
  assert.deepEqual(newestFirst([frame, y]).map((e) => e.seq ?? 0), [y.seq, 0], "a frame without a seq sorts last");
});
