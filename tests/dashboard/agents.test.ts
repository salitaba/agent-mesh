import test from "node:test";
import assert from "node:assert/strict";

import {
  GROUPS, actionNote, controlsHint, controlsOf, groupAgents, groupOf, lastTurnText, pauseWarning, stateText, totalsText, turnsByAgent,
  type AgentLike, type TurnLike,
} from "../../apps/mesh-dashboard/src/agents";

/**
 * The Agents page's decisions: which group an agent is in, what its card says it is doing and for how long, which controls it
 * offers, and what a control's answer says back.
 */

const NOW = Date.parse("2026-10-04T20:00:00.000Z");
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();
const NOTHING = { messages: 0, artifacts: 0, tasks: 0, decisions: 0 };

const agent = (id: string, lifecycle: string, extra: Partial<AgentLike> = {}): AgentLike => ({ id, role: "role", lifecycle, ...extra });
const turn = (agentId: string, status: string, agoMs: number, extra: Partial<TurnLike> = {}): TurnLike => ({
  agentId, status, startedAt: iso(agoMs), endedAt: status === "running" ? undefined : iso(agoMs - 1000), tokens: 1000, ops: NOTHING, ...extra,
});

/* ------------------------------------------------------------------ groups */

test("each lifecycle the kernel reports lands in the group a person would put it in", () => {
  const want: Record<string, string> = {
    FAILED: "help", BLOCKED: "help",
    THINKING: "working", WORKING: "working", AWAKENED: "working", OBSERVING: "working", REQUESTING: "working", REVIEWING: "working",
    WAITING: "waiting", SUSPENDED: "paused", COMPLETED: "idle", STARTING: "idle", IDLE: "idle",
  };
  for (const [lifecycle, group] of Object.entries(want)) assert.equal(groupOf(lifecycle, false), group, lifecycle);
  assert.equal(groupOf("something-new", false), "idle", "an unknown lifecycle is never hidden");
  assert.equal(groupOf("failed", false), "help", "case does not matter");
});

test("a running agent whose turn has gone silent needs you; being stalled changes nothing else", () => {
  assert.equal(groupOf("WORKING", true), "help");
  for (const l of ["WAITING", "SUSPENDED", "COMPLETED", "IDLE", "FAILED"]) assert.equal(groupOf(l, true), groupOf(l, false), l);
});

test("groups come most urgent first, an empty group is not drawn, and the roster's order holds inside a group", () => {
  const agents = [
    agent("a", "WAITING"), agent("b", "WORKING"), agent("c", "FAILED"), agent("d", "WAITING"), agent("e", "SUSPENDED"),
    agent("f", "COMPLETED"), agent("g", "WORKING"),
  ];
  const groups = groupAgents(agents, new Set(["g"]));
  assert.deepEqual(groups.map((g) => g.id), ["help", "working", "waiting", "paused", "idle"]);
  assert.deepEqual(groups.map((g) => g.agents.map((a) => a.id)), [["c", "g"], ["b"], ["a", "d"], ["e"], ["f"]]);
  assert.deepEqual(groupAgents([agent("x", "WAITING")], new Set()).map((g) => g.id), ["waiting"]);
  assert.deepEqual(groupAgents([], new Set()), []);
  assert.deepEqual(GROUPS.map((g) => g.id), ["help", "working", "waiting", "paused", "idle"]);
});

test("every agent is in exactly one group", () => {
  const agents = ["FAILED", "BLOCKED", "THINKING", "WAITING", "SUSPENDED", "COMPLETED", "STARTING", "IDLE", "odd"].map((l, i) => agent(`s${i}`, l));
  const placed = groupAgents(agents, new Set(["s2"])).flatMap((g) => g.agents.map((a) => a.id));
  assert.equal(placed.length, agents.length);
  assert.equal(new Set(placed).size, agents.length);
});

/* ------------------------------------------------------------------- turns */

test("the newest running turn and the newest finished turn of each agent are kept apart", () => {
  const steps = [
    turn("pm", "running", 5_000), turn("pm", "ok", 60_000), turn("pm", "ok", 120_000),
    turn("qa", "ok", 30_000), turn("qa", "failed", 90_000),
    turn("dev", "running", 9_000), turn("dev", "running", 600_000),
  ];
  const { running, last } = turnsByAgent(steps);
  assert.equal(running.get("pm"), steps[0], "first seen wins: the list is newest first");
  assert.equal(last.get("pm"), steps[1]);
  assert.equal(last.get("qa"), steps[3]);
  assert.equal(running.has("qa"), false);
  assert.equal(running.get("dev"), steps[5]);
  assert.equal(last.has("dev"), false, "no finished turn is not invented");
});

test("the last turn says what it left behind, not only when", () => {
  assert.equal(lastTurnText(undefined, NOW), "No turn in the loaded history.");
  assert.equal(lastTurnText(turn("pm", "ok", 12 * 60_000 + 1000, { ops: { messages: 2, artifacts: 0, tasks: 0, decisions: 0 } }), NOW), "Last turn 12m ago: 2 messages.");
  assert.equal(lastTurnText(turn("pm", "ok", 5 * 60_000), NOW), "Last turn 4m ago: no output.", "measured from when it ended");
  assert.equal(lastTurnText(turn("pm", "failed", 60_000), NOW), "Last turn 59s ago: crashed.");
  assert.match(lastTurnText(turn("pm", "ok", 60_000, { opTimings: [{ op: "approve", ok: false, reason: "no" }] }), NOW), /1 refused/);
});

/* ------------------------------------------------------------------- state */

const ctx = (extra: Partial<Parameters<typeof stateText>[1]> = {}): Parameters<typeof stateText>[1] => ({ doing: null, now: NOW, parked: false, ...extra });

test("a working agent says for how long, and what it is doing", () => {
  const running = turn("dev", "running", 43_000);
  const s = stateText(agent("dev", "WORKING"), ctx({ running, doing: "Edit ledger-store.ts, running 6s" }));
  assert.equal(s.headline, "Working for 43s");
  assert.equal(s.detail, "Edit ledger-store.ts, running 6s");
  assert.equal(stateText(agent("dev", "WORKING"), ctx({ running })).detail, "No tool call yet.", "silence is said, not hidden");
  const unknown = stateText(agent("dev", "WORKING"), ctx());
  assert.equal(unknown.headline, "Working", "no turn in the history: no invented duration");
  assert.match(unknown.detail, /not in the loaded history/);
});

test("a crashed agent says when and why, in plain words", () => {
  const last = turn("dev", "failed", 4 * 60_000 + 500, { error: "budget tokens exhausted (13000000/13000000)" });
  const s = stateText(agent("dev", "FAILED"), ctx({ last }));
  assert.equal(s.headline, "Crashed 3m ago");
  assert.match(s.detail, /used up/, "the same plain budget sentence the ledger uses");
  assert.equal(stateText(agent("dev", "FAILED"), ctx()).detail, "No error was recorded.");
  assert.equal(stateText(agent("dev", "FAILED"), ctx()).headline, "Crashed");
});

test("a blocked agent says what blocks it", () => {
  const last = turn("dev", "blocked", 2 * 60_000, { error: "budget tokens exhausted (13000000/13000000)" });
  assert.equal(stateText(agent("dev", "BLOCKED"), ctx({ last })).headline, "Blocked 1m ago");
  assert.match(stateText(agent("dev", "BLOCKED"), ctx()).detail, /until what blocks it is cleared/);
});

test("a waiting agent with mail says so, and says when nothing will read it", () => {
  const live = stateText(agent("qa", "WAITING", { mailbox: 3 }), ctx());
  assert.equal(live.headline, "3 unread messages");
  assert.equal(live.detail, "It reads them on its next wake.");
  assert.equal(stateText(agent("qa", "WAITING", { mailbox: 1 }), ctx()).headline, "1 unread message");
  assert.match(stateText(agent("qa", "WAITING", { mailbox: 3 }), ctx({ parked: true })).detail, /parked, so nothing wakes it/);
  const quiet = stateText(agent("qa", "WAITING", { mailbox: 0 }), ctx({ last: turn("qa", "ok", 12 * 60_000) }));
  assert.equal(quiet.headline, "Waiting for mail");
  assert.match(quiet.detail, /^Last turn 11m ago/);
});

test("no lifecycle falls through to 'idle' while its badge says something else", () => {
  for (const [lifecycle, headline] of [
    ["FAILED", /^Crashed/], ["BLOCKED", /^Blocked/], ["SUSPENDED", /^Paused/], ["COMPLETED", /^Finished/], ["STARTING", /^Starting/],
    ["THINKING", /^Working/], ["REQUESTING", /^Working/], ["WAITING", /^Waiting/],
  ] as const) {
    assert.match(stateText(agent("x", lifecycle), ctx()).headline, headline, lifecycle);
  }
  assert.equal(stateText(agent("x", "IDLE"), ctx()).headline, "Idle");
});

test("before the step history has arrived a card does not claim the history is empty", () => {
  const loading = ctx({ loaded: false });
  assert.equal(stateText(agent("x", "WAITING"), loading).detail, "Loading its last turn.");
  assert.equal(stateText(agent("x", "WORKING"), loading).detail, "Loading its turn.");
  assert.equal(stateText(agent("x", "FAILED"), loading).detail, "Loading the reason.");
  assert.equal(stateText(agent("x", "BLOCKED"), loading).detail, "Loading the reason.");
  // Once there is a turn to read, the flag changes nothing.
  const last = turn("x", "ok", 12 * 60_000);
  assert.equal(stateText(agent("x", "WAITING"), ctx({ loaded: false, last })).detail, stateText(agent("x", "WAITING"), ctx({ last })).detail);
  assert.equal(stateText(agent("x", "WAITING"), ctx({ loaded: true })).detail, "No turn in the loaded history.", "loaded and empty is a fact");
});

test("a paused or finished agent says what that means for it", () => {
  assert.match(stateText(agent("x", "SUSPENDED"), ctx()).detail, /does not wake for mail until you unpause/);
  assert.match(stateText(agent("x", "COMPLETED"), ctx()).detail, /nothing for it to run/);
});

test("totals name only what the roster carries", () => {
  assert.equal(totalsText(agent("x", "WAITING", { tokens: 31_000, activations: 4 })), "31.0k tokens · 4 turns");
  assert.equal(totalsText(agent("x", "WAITING", { tokens: 0, activations: 1 })), "1 turn");
  assert.equal(totalsText(agent("x", "WAITING")), "");
});

/* ---------------------------------------------------------------- controls */

const ids = (lifecycle: string): string[] => controlsOf(lifecycle).map((c) => c.id);

test("an agent is offered only the controls that make sense in its state", () => {
  assert.deepEqual(ids("WAITING"), ["wake", "suspend"]);
  assert.deepEqual(ids("IDLE"), ["wake", "suspend"]);
  assert.deepEqual(ids("STARTING"), ["wake", "suspend"]);
  assert.deepEqual(ids("BLOCKED"), ["wake", "suspend"]);
  assert.deepEqual(ids("FAILED"), ["wake", "suspend"]);
  assert.deepEqual(ids("SUSPENDED"), ["resume"], "paused: the one way forward is to unpause");
  assert.deepEqual(ids("COMPLETED"), [], "finished with the mission: nothing the kernel would accept");
  for (const l of ["THINKING", "WORKING", "AWAKENED", "OBSERVING", "REQUESTING", "REVIEWING"]) assert.deepEqual(ids(l), ["suspend"], l);
});

test("pausing an agent that is mid-turn asks first; pausing one that is not does not", () => {
  assert.equal(controlsOf("WORKING")[0]!.asks, true);
  assert.equal(controlsOf("WAITING").find((c) => c.id === "suspend")!.asks, false);
  assert.ok(controlsOf("WORKING")[0]!.title.includes("billed"), "the consequence is in the tooltip too");
});

test("a failed agent's wake is a retry, and every control explains itself", () => {
  assert.equal(controlsOf("FAILED")[0]!.label, "Retry one step");
  assert.equal(controlsOf("WAITING")[0]!.label, "Run one step");
  assert.match(controlsOf("WAITING")[0]!.title, /one turn.*goes back to waiting/);
  for (const l of ["WAITING", "FAILED", "SUSPENDED", "WORKING"]) for (const c of controlsOf(l)) assert.ok(c.title.length > 20, `${l} ${c.id}`);
});

test("the sentence under the buttons says what they do to an agent in this state", () => {
  assert.match(controlsHint("WAITING"), /single turn/);
  assert.match(controlsHint("WORKING"), /stops the turn it is in/);
  assert.match(controlsHint("WORKING", true), /gone quiet.*Unpause lets it start fresh/);
  assert.match(controlsHint("SUSPENDED"), /Unpause/);
  assert.match(controlsHint("COMPLETED"), /nothing to run/);
  assert.match(controlsHint("BLOCKED"), /shows the server's answer/);
});

test("the pause warning names the agent and the cost", () => {
  const w = pauseWarning("developer");
  assert.equal(w.title, "Pause developer?");
  assert.ok(w.body.some((b) => /billed/.test(b)));
  assert.ok(w.body.some((b) => b.startsWith("developer will not wake")));
  assert.equal(w.confirmLabel, "Pause agent");
});

/* ----------------------------------------------------------------- answers */

test("a wake that worked says one turn, and a refusal keeps the server's reason word for word", () => {
  const ok = actionNote("wake", "pm", 200, { reason: undefined });
  assert.equal(ok.title, "Running one step");
  assert.match(ok.text, /goes back to waiting/);
  assert.equal(ok.kind, "ok");
  const no = actionNote("wake", "pm", 409, { reason: "agent completed with the mission" });
  assert.equal(no.kind, "warn");
  assert.equal(no.text, "pm did not start a turn. agent completed with the mission.");
  assert.equal(actionNote("wake", "pm", 409, { reason: "mission is paused." }).text, "pm did not start a turn. mission is paused.", "one full stop, not two");
  assert.equal(actionNote("wake", "pm", 409, null).text, "pm did not start a turn. The server refused it.");
});

test("a pause says what now holds, and when it stopped a turn", () => {
  assert.match(actionNote("suspend", "pm", 200, {}).text, /will not wake for mail, nudges or Run one step until you unpause/);
  const stopped = actionNote("suspend", "pm", 200, { stoppedTurnId: "turn-1" });
  assert.match(stopped.text, /was in a turn, which is stopped/);
  assert.equal(stopped.title, "Paused");
  assert.equal(actionNote("suspend", "pm", 500, { reason: "boom" }).kind, "warn");
  assert.equal(actionNote("resume", "pm", 200, {}).title, "Unpaused");
  assert.match(actionNote("resume", "pm", 200, {}).text, /wakes for mail and nudges again/);
  assert.equal(actionNote("resume", "pm", 409, { reason: "not suspended" }).text, "pm was not unpaused. not suspended.");
  const refused = actionNote("resume", "pm", 409, { reason: "not suspended" });
  assert.equal(refused.title, "Not unpaused", "a refusal is never titled as a success");
  assert.equal(refused.kind, "warn");
});

test("a request that got no answer does not claim to have failed or succeeded", () => {
  for (const act of ["wake", "suspend", "resume"]) {
    const n = actionNote(act, "pm", null, null);
    assert.equal(n.kind, "bad");
    assert.match(n.text, /not known whether this took effect/);
  }
});
