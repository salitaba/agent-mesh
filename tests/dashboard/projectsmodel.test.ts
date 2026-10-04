import test from "node:test";
import assert from "node:assert/strict";

import {
  HEADINGS_FROM,
  attentionCount,
  cardActions,
  cardState,
  displayNames,
  failureDetail,
  folderName,
  groupProjects,
  hostSummary,
  landAfterClose,
  lastOpened,
  problemTitle,
  readRegistryAnswer,
  tabLook,
  usd,
  type ProjectView,
} from "../../apps/mesh-dashboard/src/projectsmodel";

const p = (id: string, status: string, extra: Partial<ProjectView> = {}): ProjectView => ({ id, name: id, root: `/work/${id}`, status, ...extra });

test("every registry status reads as one state, with a word, a shape and a sentence", () => {
  const seen = new Map<string, string>();
  for (const status of ["open", "booting", "closed", "crashed", "locked", "error", "wat"]) {
    const s = cardState(p("a", status));
    assert.ok(s.label.length > 0 && s.sentence.endsWith("."), status);
    seen.set(status, s.key);
  }
  assert.deepEqual(Object.fromEntries(seen), { open: "open", booting: "starting", closed: "closed", crashed: "crashed", locked: "locked", error: "cannot-open", wat: "unknown" });
  // Colour is never the only signal: no two different states share a glyph and a tone.
  const looks = ["open", "booting", "closed", "crashed", "locked", "error"].map((s) => cardState(p("a", s))).map((c) => `${c.icon}/${c.tone}`);
  assert.equal(new Set(looks).size, looks.length - 1 /* crashed and error: both an alert in red, told apart by the word */, looks.join(" "));
});

test("a project whose breaker tripped is a crash loop, not a crash that is about to retry", () => {
  const loop = cardState(p("a", "crashed", { tripped: true, restartInMs: 4000, health: { rss: 1, lastHeartbeat: "", restarts: 5 } }));
  assert.equal(loop.key, "crash-loop");
  assert.equal(loop.tone, "bad");
  assert.match(loop.sentence, /restarted 5 times/);
  assert.match(loop.sentence, /stopped restarting it/);
  assert.doesNotMatch(loop.sentence, /in 4 seconds/, "no retry is coming, so none is promised");

  const retrying = cardState(p("a", "crashed", { restartInMs: 4000 }));
  assert.equal(retrying.key, "crashed");
  assert.match(retrying.sentence, /restarting it in 4 seconds/);
  assert.match(cardState(p("a", "crashed", { restartInMs: 1000 })).sentence, /in 1 second\./);
  assert.match(cardState(p("a", "crashed", { tripped: true, health: { rss: 1, lastHeartbeat: "", restarts: 1 } })).sentence, /restarted once/);

  // A tripped flag on a process that is up again (a manual restart clears it, but never trust a stale one over a live process).
  assert.equal(cardState(p("a", "open", { tripped: true })).key, "open");
  assert.equal(cardState(p("a", "booting", { tripped: true })).key, "starting");
  assert.equal(cardState(p("a", "closed", { tripped: true })).key, "closed", "nothing is running, so there is no loop to report");
});

test("tripped also marks a locked project and one that cannot open, and neither is a crash loop", () => {
  // The host sets it for both because trying again would not help (a real locked project in the lab answered `tripped: true`).
  const locked = cardState(p("a", "locked", { tripped: true }));
  assert.equal(locked.key, "locked");
  assert.match(locked.sentence, /Another process holds/);
  const broken = cardState(p("a", "error", { tripped: true }));
  assert.equal(broken.key, "cannot-open");
  assert.match(broken.sentence, /mesh\.yaml is unusable/);
  assert.equal(problemTitle("Payments", locked.key), "Payments is locked.");
  assert.equal(cardActions(locked.key).primary, "restart");
});

test("an open project says whether its mission is live or parked, and says nothing it was not told", () => {
  assert.equal(cardState(p("a", "open", { lastMode: "parked" })).mode, "parked");
  assert.equal(cardState(p("a", "open", { lastMode: "live" })).mode, "live");
  assert.equal(cardState(p("a", "open")).mode, null, "no report yet: no claim");
  // The project in front knows better than the registry's last word.
  assert.equal(cardState(p("a", "open", { lastMode: "live" }), { missionParked: true }).mode, "parked");
  assert.equal(cardState(p("a", "open", { lastMode: "parked" }), { missionParked: false }).mode, "live");
  // A mode a closed process last reported means nothing now.
  assert.equal(cardState(p("a", "closed", { lastMode: "live" })).mode, null);
  assert.match(cardState(p("a", "open", { lastMode: "parked" })).sentence, /mission is parked/);
});

test("a project the host parked for spend is told apart from one whose mission is simply parked", () => {
  const byHost = cardState(p("a", "open", { lastMode: "parked" }), { parkedByHost: true });
  assert.equal(byHost.key, "host-parked");
  assert.equal(byHost.tone, "warn");
  assert.match(byHost.sentence, /spend ceiling or turn cap/);
  assert.equal(cardState(p("a", "open", { lastMode: "parked" })).key, "open", "an ordinary parked mission is not an alarm");
  assert.equal(cardState(p("a", "open", { lastMode: "parked" })).tone, "ok");
});

test("a tab says whether an open project has turns in flight or is parked, and uses the same shapes as its card", () => {
  const look = (status: string, extra: Partial<ProjectView> = {}, opts: Parameters<typeof cardState>[1] = {}) => tabLook(cardState(p("a", status, extra), opts));
  const turns = (runningTurns: number) => ({ spend: { tokens: 0, usd: 0, runningTurns } });
  assert.deepEqual(look("open", { lastMode: "live", ...turns(2) }), { word: "running", icon: "dot", tone: "ok" });
  assert.deepEqual(look("open", { lastMode: "live", ...turns(0) }), { word: "open", icon: "dot", tone: "ok" }, "a live mission with nothing in flight is not claimed to be running");
  assert.deepEqual(look("open", { lastMode: "live" }), { word: "open", icon: "dot", tone: "ok" }, "no goal yet, or the host has not said: open");
  assert.deepEqual(look("open", { lastMode: "parked", ...turns(3) }), { word: "parked", icon: "pause", tone: "warn" }, "parked outranks turns that are finishing");
  assert.deepEqual(look("open"), { word: "open", icon: "dot", tone: "ok" }, "no report yet: it says only that it is open");
  assert.deepEqual(look("open", { lastMode: "live" }, { missionParked: true }), { word: "parked", icon: "pause", tone: "warn" }, "the project in front knows better");
  assert.equal(look("open", {}, { parkedByHost: true }).word, "parked");
  assert.deepEqual(look("closed"), { word: "closed", icon: "ring", tone: "neutral" });
  assert.deepEqual(look("booting"), { word: "starting", icon: "refresh", tone: "warn" });
  assert.deepEqual(look("locked"), { word: "locked", icon: "lock", tone: "warn" });
  assert.deepEqual(look("crashed"), { word: "crashed", icon: "alert", tone: "bad" });
  assert.deepEqual(look("crashed", { tripped: true }), { word: "crash loop", icon: "alert", tone: "bad" });
  assert.deepEqual(look("error"), { word: "cannot open", icon: "alert", tone: "bad" });
  // Every tab has a shape of its own among the states a person must tell apart at a glance.
  const shapes = new Set(["open", "closed", "booting", "locked", "crashed"].map((s) => look(s).icon));
  assert.equal(shapes.size, 5);
});

test("closing a tab: a background tab moves nobody; the one in front hands over to a running neighbour, else to the Projects page", () => {
  const list = [p("a", "closed"), p("b", "open"), p("c", "closed"), p("d", "open")];
  assert.deepEqual(landAfterClose(list, "c", "b"), { kind: "stay" }, "closing what you are not looking at changes nothing");
  assert.deepEqual(landAfterClose(list, "b", "b"), { kind: "projects" }, "its right-hand neighbour is closed: nothing to land on");
  assert.deepEqual(landAfterClose(list, "d", "d"), { kind: "projects" }, "the last tab hands over to its left-hand neighbour, which is closed");
  assert.deepEqual(landAfterClose([p("a", "open"), p("b", "open"), p("c", "closed")], "b", "b"), { kind: "projects" }, "the right-hand neighbour is the one it hands to");
  assert.deepEqual(landAfterClose([p("x", "open"), p("y", "open")], "x", "x"), { kind: "project", id: "y" });
  assert.deepEqual(landAfterClose([p("x", "open"), p("y", "booting")], "x", "x"), { kind: "project", id: "y" }, "one that is starting is going to be there");
  assert.deepEqual(landAfterClose([p("x", "open")], "x", "x"), { kind: "projects" }, "the last one: nowhere else to go");
  assert.deepEqual(landAfterClose(list, "b", null), { kind: "stay" }, "nothing in front, nothing to leave");
});

test("the notice under the strip names the project and what is wrong with it", () => {
  assert.equal(problemTitle("Payments", "crashed"), "Payments crashed.");
  assert.equal(problemTitle("Payments", "crash-loop"), "Payments keeps crashing.");
  assert.equal(problemTitle("Payments", "locked"), "Payments is locked.");
  assert.equal(problemTitle("Payments", "cannot-open"), "Payments cannot open.");
  assert.equal(problemTitle("Payments", "open"), "Payments needs attention.");
});

test("the actions that apply follow the state: open what is closed, restart what is broken, remove always", () => {
  const acts = (status: string, extra: Partial<ProjectView> = {}) => cardActions(cardState(p("a", status, extra)).key);
  assert.deepEqual(acts("closed"), { open: true, goTo: false, close: false, restart: false, remove: true, primary: "open" });
  assert.deepEqual(acts("open"), { open: false, goTo: true, close: true, restart: false, remove: true, primary: "goTo" });
  assert.deepEqual(acts("booting"), { open: false, goTo: true, close: true, restart: false, remove: true, primary: "goTo" });
  for (const [status, extra] of [["crashed", {}], ["crashed", { tripped: true }], ["locked", {}], ["error", {}]] as const) {
    assert.deepEqual(acts(status, extra), { open: false, goTo: false, close: false, restart: true, remove: true, primary: "restart" }, `${status} ${JSON.stringify(extra)}`);
  }
  // An unknown project can be opened (the host will say no, and say why) and always forgotten.
  assert.equal(acts("wat").remove, true);
  for (const status of ["closed", "open", "booting", "crashed", "locked", "error", "wat"]) assert.equal(acts(status).remove, true, status);
});

test("broken projects come first, then running ones, then closed, each in the order of the tab strip", () => {
  const all = [p("closed-1", "closed"), p("open-1", "open"), p("crashed-1", "crashed"), p("closed-2", "closed"), p("locked-1", "locked"), p("open-2", "open"), p("error-1", "error")];
  const { groups, headings } = groupProjects(all, ["open-2", "closed-2", "locked-1", "error-1", "crashed-1", "open-1", "closed-1"]);
  assert.deepEqual(groups.map((g) => g.key), ["attention", "open", "closed"]);
  assert.deepEqual(groups[0]!.items.map((x) => x.id), ["locked-1", "error-1", "crashed-1"], "the strip's order inside a group");
  assert.deepEqual(groups[1]!.items.map((x) => x.id), ["open-2", "open-1"]);
  assert.deepEqual(groups[2]!.items.map((x) => x.id), ["closed-2", "closed-1"]);
  assert.equal(headings, true);
  assert.deepEqual(groups.map((g) => g.label), ["Needs attention", "Open", "Closed"]);
});

test("headings appear only when they help: more than one group, and enough projects to scan", () => {
  assert.equal(groupProjects([p("a", "open"), p("b", "closed")], []).headings, false, "two projects need no headings");
  const few = Array.from({ length: HEADINGS_FROM - 1 }, (_, i) => p(`p${i}`, i === 0 ? "open" : "closed"));
  assert.equal(groupProjects(few, []).headings, false);
  const enough = [...few, p("last", "crashed")];
  assert.equal(groupProjects(enough, []).headings, true);
  assert.equal(groupProjects(Array.from({ length: 12 }, (_, i) => p(`p${i}`, "closed")), []).headings, false, "twelve of one kind is one group: no heading");
  assert.deepEqual(groupProjects([], []).groups, [], "no projects, no groups");
  assert.equal(groupProjects([p("a", "open")], []).groups.length, 1);
});

test("a project the host parked counts as open, in the open group", () => {
  const { groups } = groupProjects([p("a", "open"), p("b", "closed"), p("c", "closed"), p("d", "closed")], [], new Set(["a"]));
  assert.deepEqual(groups.map((g) => [g.key, g.items.map((x) => x.id)]), [["open", ["a"]], ["closed", ["b", "c", "d"]]]);
});

test("two projects with one name are told apart by their folders, and only those", () => {
  const names = displayNames([
    { ...p("demo-stub", "open"), name: "Demo Mesh (stub agents)", root: "/home/me/curule-projects/demo-stub" },
    { ...p("demo-stub-2", "closed"), name: "Demo Mesh (stub agents)", root: "/home/me/curule-projects/demo-stub-2" },
    { ...p("pay", "closed"), name: "Payments", root: "/data/projects/pay" },
  ]);
  assert.equal(names.get("demo-stub"), "Demo Mesh (stub agents) (demo-stub)");
  assert.equal(names.get("demo-stub-2"), "Demo Mesh (stub agents) (demo-stub-2)");
  assert.equal(names.get("pay"), "Payments");
  assert.equal(displayNames([{ ...p("a", "open"), name: "Same" }, { ...p("b", "open"), name: "SAME" }]).get("a"), "Same (a)", "case does not make two names");
  assert.equal(folderName("/a/b/c/"), "c");
  assert.equal(folderName("C:\\work\\proj"), "proj");
  assert.equal(folderName("/"), "/");
});

test("the count that rides on the Projects button is the projects that need a person", () => {
  assert.equal(attentionCount([p("a", "open"), p("b", "closed")]), 0);
  assert.equal(attentionCount([p("a", "crashed"), p("b", "locked", { tripped: true }), p("c", "error"), p("d", "closed", { tripped: true }), p("e", "open")]), 3, "a closed project with a stale flag is not asking for anyone");
});

test("when a project was last opened is relative, from an explicit clock, and honest about never", () => {
  const now = Date.parse("2026-10-04T12:00:00Z");
  const at = (secondsAgo: number): string => new Date(now - secondsAgo * 1000).toISOString();
  assert.equal(lastOpened(undefined, now), "Never opened");
  assert.equal(lastOpened("not a date", now), "Never opened");
  assert.equal(lastOpened(at(10), now), "Just now");
  assert.equal(lastOpened(at(60), now), "1 minute ago");
  assert.equal(lastOpened(at(15 * 60), now), "15 minutes ago");
  assert.equal(lastOpened(at(3 * 3600), now), "3 hours ago");
  assert.equal(lastOpened(at(47 * 3600), now), "47 hours ago");
  assert.equal(lastOpened(at(5 * 86400), now), "5 days ago");
  assert.equal(lastOpened(at(-30), now), "Just now", "a clock a little behind the host's is not the future");
});

test("money is to the cent, says so under a cent, and never prints a minus or a NaN", () => {
  assert.equal(usd(0), "$0.00");
  assert.equal(usd(0.004), "<$0.01");
  assert.equal(usd(0.01), "$0.01");
  assert.equal(usd(12.5), "$12.50");
  assert.equal(usd(1234.56), "$1,235");
  assert.equal(usd(Number.NaN), "");
  assert.equal(usd(-1), "");
});

test("the summary counts what is there and leaves spend unsaid when the host has not said it", () => {
  const list = [p("a", "open", { spend: { tokens: 10, usd: 1, runningTurns: 2 } }), p("b", "booting"), p("c", "crashed"), p("d", "closed")];
  assert.deepEqual(hostSummary(list, { usd: 4.5, runningTurns: 3, ceilingUsd: 50 }), { total: 4, open: 2, attention: 1, runningTurns: 3, usd: 4.5, ceilingUsd: 50 });
  const unsaid = hostSummary(list, null);
  assert.equal(unsaid.usd, null, "no number rather than a flattering zero");
  assert.equal(unsaid.ceilingUsd, null);
  assert.equal(unsaid.runningTurns, 2, "the per-project figures are all there is");
  assert.equal(hostSummary([], null).total, 0);
});

test("only a 2xx says what is registered: a proxy's 5xx is a host that is not there, and a refusal says nothing", () => {
  assert.equal(readRegistryAnswer({ status: 200 }), "list");
  assert.equal(readRegistryAnswer({ status: 204 }), "list");
  for (const status of [0, 500, 502, 503, 504]) assert.equal(readRegistryAnswer({ status }), "down", String(status));
  assert.equal(readRegistryAnswer({ status: 200, timeout: true }), "down", "a timeout is down, whatever status was filled in");
  assert.equal(readRegistryAnswer({ status: 404 }), "no-registry", "curule console has no registry route");
  for (const status of [400, 401, 403, 429]) assert.equal(readRegistryAnswer({ status }), "refused", String(status));
});

test("a failure is shown in the host's words: the reason, then its detail", () => {
  assert.equal(failureDetail(p("a", "error", { error: { reason: "invalid_config", detail: "line 3, column 5" } })), "invalid_config: line 3, column 5");
  assert.equal(failureDetail(p("a", "crashed", { error: { reason: "exit 1" } })), "exit 1");
  assert.equal(failureDetail(p("a", "closed")), "");
  assert.equal(failureDetail(p("a", "error", { error: { reason: "  ", detail: " " } })), "");
});
