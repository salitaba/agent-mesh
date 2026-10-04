import test from "node:test";
import assert from "node:assert/strict";

import {
  inboxCounts,
  inboxSummary,
  inboxTabs,
  orderDecisions,
  tabOfView,
  toolRequestRows,
  toolRequestsBySeat,
  viewOfTab,
  waitedSince,
  type ToolSeat,
} from "../../apps/mesh-dashboard/src/inbox-model";

/**
 * "Needs you" said "Waiting on you (0)  all clear" with a tool request waiting one click away in "Tool gates", and its own
 * count was the number of stalled-request cards, so a budget decision on the same page left the header at zero. These pin the
 * rule that replaces it: one count, taken from both lists, and "all clear" only when both have been read and both are empty.
 */

const GOAL = "goal-1";
const card = (id: string, over: Record<string, unknown> = {}) => ({ id, goalId: GOAL, status: "OPEN", reason: "runtime_failure", raisedBy: "termination-manager", createdAt: "2026-10-04T10:00:00Z", ...over });
const seat = (agentId: string, requested: string[] = [], granted: string[] = []): ToolSeat => ({ agentId, requiresApproval: ["repository.write"], granted, requested });

test("one count takes in every kind of card and every tool request, and matches the shell's badge", () => {
  const c = inboxCounts(
    [
      card("a"),
      card("b", { reason: "stalemate:unanswered_request" }),
      card("seat", { reason: "agent_budget_exhausted", raisedBy: "dev", conflictKey: `budget:agent:${GOAL}/dev` }),
      card("n", { advisory: true }),
      card("done", { status: "RESPONDED" }),
      card("auto", { status: "AUTO_RESOLVED" }),
    ],
    [seat("dev", ["Edit", "Write"]), seat("qa")],
  );
  assert.deepEqual(c, { blocking: 3, seatOnly: 1, advisory: 1, decisions: 4, toolRequests: 2, waiting: 6 });
});

test("a budget decision is counted even when no stalled request is open: the old header counted only those", () => {
  const c = inboxCounts([card("budget", { reason: "budget_exhausted" })], []);
  assert.equal(c.waiting, 1);
  assert.equal(c.decisions, 1);
});

test("an empty queue and no gated seats count zero, and a seat that reports no list is not a request", () => {
  assert.deepEqual(inboxCounts([], []), { blocking: 0, seatOnly: 0, advisory: 0, decisions: 0, toolRequests: 0, waiting: 0 });
  assert.equal(inboxCounts([], [{ agentId: "x", requiresApproval: [], granted: [] } as never]).toolRequests, 0);
});

test("all clear is a verdict: only when both lists have been read and both are empty", () => {
  const none = inboxCounts([], []);
  const ready = { decisions: "ready", tools: "ready" } as const;
  assert.deepEqual(inboxSummary(none, ready), { tone: "ok", label: "All clear", line: "Nothing is waiting on you.", clear: true });
  assert.equal(inboxSummary(none, { decisions: "loading", tools: "loading" }).label, "Checking");
  assert.equal(inboxSummary(none, { decisions: "ready", tools: "loading" }).clear, false, "decisions read, tool requests not: not clear yet");
  assert.equal(inboxSummary(none, { decisions: "loading", tools: "ready" }).clear, false);
});

test("when the server has stopped answering, the lists are the last it sent and the header says so instead of all clear", () => {
  const none = inboxCounts([], []);
  const ready = { decisions: "ready", tools: "ready" } as const;
  const quiet = inboxSummary(none, ready, { stale: true });
  assert.deepEqual([quiet.tone, quiet.label, quiet.clear], ["bad", "Not updating", false]);
  assert.match(quiet.line, /^The server is not answering, so what was last reported may be out of date\.$/);
  assert.equal(inboxSummary(none, ready, { stale: false }).clear, true, "answering again: the verdict is back");
  assert.equal(inboxSummary(none, ready).clear, true, "no option: not stale");
  const waiting = inboxSummary(inboxCounts([card("a")], []), ready, { stale: true });
  assert.equal(waiting.label, "1 waiting", "what was waiting is still counted");
  assert.match(waiting.line, /1 decision holds the mission\. The server is not answering: this is what it last reported\.$/);
  assert.equal(inboxSummary(none, { decisions: "error", tools: "ready" }, { stale: true }).label, "Not loaded", "a list that never loaded is the sharper fact");
  assert.equal(inboxSummary(none, { decisions: "loading", tools: "loading" }, { stale: true }).label, "Not updating", "no list and no server: nothing to wait for");
});

test("a queue that failed to load never reads as quiet, and says which list is missing", () => {
  const none = inboxCounts([], []);
  const a = inboxSummary(none, { decisions: "error", tools: "ready" });
  assert.deepEqual([a.tone, a.label, a.clear], ["bad", "Not loaded", false]);
  assert.match(a.line, /^The decision queue did not load\. There may be items waiting that this page cannot show\.$/);
  assert.match(inboxSummary(none, { decisions: "ready", tools: "error" }).line, /^Tool requests did not load\./);
  assert.match(inboxSummary(none, { decisions: "error", tools: "error" }).line, /decision queue did not load\. Tool requests did not load\./);
});

test("with items waiting, the header counts both lists and says what each holds; a failed list is named beside the count", () => {
  const c = inboxCounts([card("a"), card("b", { reason: "agent_budget_exhausted", conflictKey: `budget:agent:${GOAL}/dev` }), card("n", { advisory: true })], [seat("dev", ["Edit"])]);
  const s = inboxSummary(c, { decisions: "ready", tools: "ready" });
  assert.deepEqual([s.tone, s.label, s.clear], ["bad", "4 waiting", false]);
  assert.equal(s.line, "1 decision holds the mission · 1 decision holds one seat · 1 notice · 1 tool request.");
  const partial = inboxSummary(c, { decisions: "ready", tools: "error" });
  assert.match(partial.line, /Tool requests did not load\.$/, "a partial count is labelled, never flattering");
});

test("only tool requests waiting is a warning, and only notices is neutral: neither is the red of a held mission", () => {
  const tools = inboxSummary(inboxCounts([], [seat("dev", ["Edit"])]), { decisions: "ready", tools: "ready" });
  assert.deepEqual([tools.tone, tools.label, tools.line], ["warn", "1 waiting", "1 tool request."]);
  const notices = inboxSummary(inboxCounts([card("n", { advisory: true }), card("m", { advisory: true })], []), { decisions: "ready", tools: "ready" });
  assert.deepEqual([notices.tone, notices.line], ["neutral", "2 notices."]);
});

test("blocking decisions come first, the longest-waiting at the top, and notices below them newest first", () => {
  const list = [
    card("new", { createdAt: "2026-10-04T10:30:00Z" }),
    card("old", { createdAt: "2026-10-04T09:00:00Z" }),
    card("stuck", { createdAt: "2026-10-04T10:45:00Z", detail: { awaitingSince: "2026-10-04T08:00:00Z" } }),
    card("n1", { advisory: true, createdAt: "2026-10-04T09:30:00Z" }),
    card("n2", { advisory: true, createdAt: "2026-10-04T10:10:00Z" }),
    card("r1", { status: "RESPONDED", createdAt: "2026-10-04T07:00:00Z", respondedAt: "2026-10-04T07:05:00Z" }),
    card("r2", { status: "AUTO_RESOLVED", createdAt: "2026-10-04T06:00:00Z", respondedAt: "2026-10-04T10:00:00Z" }),
  ];
  const o = orderDecisions(list);
  assert.deepEqual(o.blocking.map((e) => e.id), ["stuck", "old", "new"], "ordered by when each started waiting, `awaitingSince` over `createdAt`");
  assert.deepEqual(o.notices.map((e) => e.id), ["n2", "n1"]);
  assert.deepEqual(o.done.map((e) => e.id), ["r2", "r1"], "newest answer first");
});

test("an undatable card sorts last rather than pretending to be the oldest", () => {
  assert.equal(waitedSince(card("x", { createdAt: "nope" })), Infinity);
  assert.deepEqual(orderDecisions([card("u", { createdAt: "nope" }), card("d", { createdAt: "2026-10-04T10:00:00Z" })]).blocking.map((e) => e.id), ["d", "u"]);
});

test("the two routes are one page: `gates` is the inbox opened on its tool section, and each tab knows its route", () => {
  assert.equal(tabOfView("escalations"), "decisions");
  assert.equal(tabOfView("gates"), "tools");
  assert.equal(viewOfTab("decisions"), "escalations");
  assert.equal(viewOfTab("tools"), "gates");
  for (const tab of ["decisions", "tools"] as const) assert.equal(tabOfView(viewOfTab(tab)), tab);
});

test("a tab shows a badge only when something waits there, and is hot only when it asks for action", () => {
  const quiet = inboxTabs(inboxCounts([], []));
  assert.deepEqual(quiet.map((t) => [t.id, t.badge, t.hot]), [["decisions", undefined, false], ["tools", undefined, false]]);
  const busy = inboxTabs(inboxCounts([card("a"), card("n", { advisory: true })], [seat("dev", ["Edit"])]));
  assert.deepEqual(busy.map((t) => [t.id, t.badge, t.hot]), [["decisions", 2, true], ["tools", 1, true]]);
  const noticesOnly = inboxTabs(inboxCounts([card("n", { advisory: true })], []));
  assert.deepEqual([noticesOnly[0]!.badge, noticesOnly[0]!.hot], [1, false], "a notice is counted but is not a call to act");
});

test("tool requests become one row per tool, and a per-seat summary for the Overview", () => {
  const seats = [seat("dev", ["Edit", "Write"]), seat("qa"), seat("sec", ["Bash"])];
  assert.deepEqual(toolRequestRows(seats), [{ agentId: "dev", tool: "Edit" }, { agentId: "dev", tool: "Write" }, { agentId: "sec", tool: "Bash" }]);
  assert.deepEqual(toolRequestsBySeat(seats), [{ agentId: "dev", tools: ["Edit", "Write"] }, { agentId: "sec", tools: ["Bash"] }]);
  assert.deepEqual(toolRequestRows([]), []);
});
