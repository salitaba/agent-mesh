import test from "node:test";
import assert from "node:assert/strict";

import { rightNow, rightNowInput, spanWord, type RightNowInput } from "../../apps/mesh-dashboard/src/rightnow";

/**
 * "Running. 1 agent waiting, none working right now." is true and says nothing about this mission. These pin what the lines say in
 * each situation (nothing running, one working, two, many, something queued, requests open, a stalemate), that they are facts and
 * not diagnoses, that nobody is named by an id, and that they never run past three.
 */

const NOW = Date.parse("2026-10-06T12:00:00Z");
const ago = (min: number, sec = 0): string => new Date(NOW - min * 60_000 - sec * 1000).toISOString();

const input = (over: Partial<RightNowInput> = {}): RightNowInput => ({
  phase: "running",
  now: NOW,
  agents: [],
  turns: [],
  queued: [],
  openRequests: null,
  forYou: 0,
  ...over,
});
const seat = (id: string, lifecycle: string, mailbox = 0): { id: string; lifecycle: string; mailbox: number } => ({ id, lifecycle, mailbox });
const run = (agentId: string, startedAt: string): { agentId: string; startedAt: string; status: string } => ({ agentId, startedAt, status: "running" });

test("only a mission that is live has a right now: a paused, parked, delivered or halted one is said by its headline", () => {
  for (const phase of ["paused", "parked", "done", "failed", "needs-you", "ceiling", "stalled", "offline", "loading", "down"] as const) {
    assert.deepEqual(rightNow(input({ phase, agents: [seat("qa", "THINKING")], turns: [run("qa", ago(2))] })), [], phase);
  }
});

test("one seat in a turn: who, and for how long, in minutes", () => {
  const lines = rightNow(input({ agents: [seat("qa", "THINKING"), seat("pm", "IDLE")], turns: [run("qa", ago(2, 25))] }));
  assert.deepEqual(lines, ["qa has been working for 2 min.", "Nothing is waiting for you."]);
});

test("under a minute is said as under a minute, and an hour as an hour", () => {
  assert.equal(rightNow(input({ agents: [seat("qa", "THINKING")], turns: [run("qa", ago(0, 40))] }))[0], "qa has been working for less than a minute.");
  assert.equal(rightNow(input({ agents: [seat("qa", "THINKING")], turns: [run("qa", ago(95))] }))[0], "qa has been working for 1 h 35 min.");
  assert.deepEqual([0, 59_999, 60_000, 3_599_000, 3_600_000, 3_660_000, -5].map(spanWord), ["less than a minute", "less than a minute", "1 min", "59 min", "1 h", "1 h 1 min", "less than a minute"]);
});

test("a seat in a turn that the console cannot time is named without a time, not with a guess", () => {
  assert.equal(rightNow(input({ agents: [seat("qa", "THINKING")] }))[0], "qa is working.");
  assert.equal(rightNow(input({ agents: [seat("qa", "THINKING")], turns: [run("qa", "not a date")] }))[0], "qa is working.");
});

test("two seats in a turn: the longest first, each with its time", () => {
  const lines = rightNow(input({ agents: [seat("developer", "WORKING"), seat("qa", "THINKING")], turns: [run("developer", ago(0, 30)), run("qa", ago(3))] }));
  assert.equal(lines[0], "qa (3 min) and developer (less than a minute) are working.");
});

test("three or more: how many, and the longest", () => {
  const lines = rightNow(input({ agents: [seat("a", "WORKING"), seat("b", "WORKING"), seat("c", "THINKING")], turns: [run("a", ago(1)), run("b", ago(12)), run("c", ago(4))] }));
  assert.equal(lines[0], "3 agents are working. The longest, b, has been going for 12 min.");
});

test("a turn that has ended is not work in progress, and a turn in flight counts even before the roster has caught up", () => {
  const ended = rightNow(input({ phase: "quiet", agents: [seat("qa", "WAITING")], turns: [{ agentId: "qa", startedAt: ago(5), status: "ok" }] }));
  assert.match(ended[0]!, /^Everyone is waiting for mail: nothing is queued/);
  const early = rightNow(input({ agents: [seat("qa", "WAITING")], turns: [run("qa", ago(1))] }));
  assert.equal(early[0], "qa has been working for 1 min.");
});

test("how long a seat has been in a turn is read from the turn it is in, never from one it finished before", () => {
  const finished = (agentId: string, min: number): { agentId: string; startedAt: string; status: string } => ({ agentId, startedAt: ago(min), status: "ok" });
  // Its only turn in the history is over: the roster says it is working, and when that began is not known.
  assert.equal(rightNow(input({ agents: [seat("qa", "THINKING")], turns: [finished("qa", 30)] }))[0], "qa is working.");
  // An older finished turn beside the one in flight: the time is the one in flight's.
  assert.equal(rightNow(input({ agents: [seat("qa", "THINKING")], turns: [finished("qa", 30), run("qa", ago(1))] }))[0], "qa has been working for 1 min.");
});

test("what is next: the queue first, and never a seat that is already in a turn", () => {
  const lines = rightNow(input({ agents: [seat("qa", "THINKING"), seat("pm", "IDLE"), seat("architect", "IDLE")], turns: [run("qa", ago(1))], queued: ["architect", "qa", "pm", "architect"] }));
  assert.equal(lines[1], "Next in line: architect and pm.");
});

test("with nothing queued, the seats resting on their mail are named, and counted when there are many", () => {
  const two = rightNow(input({ agents: [seat("qa", "THINKING"), seat("pm", "WAITING"), seat("security", "WAITING")], turns: [run("qa", ago(1))] }));
  assert.equal(two[1], "pm and security are waiting for mail.");
  const one = rightNow(input({ agents: [seat("qa", "THINKING"), seat("pm", "WAITING")], turns: [run("qa", ago(1))] }));
  assert.equal(one[1], "pm is waiting for mail.");
  const many = rightNow(input({ agents: [seat("qa", "THINKING"), seat("a", "WAITING"), seat("b", "WAITING"), seat("c", "WAITING"), seat("d", "WAITING")], turns: [run("qa", ago(1))] }));
  assert.equal(many[1], "4 agents are waiting for mail.");
});

test("requests nobody has answered are counted, in the singular and the plural, and never when the server does not say", () => {
  const base = { agents: [seat("qa", "THINKING"), seat("pm", "WAITING")], turns: [run("qa", ago(1))] };
  assert.equal(rightNow(input({ ...base, openRequests: 1 }))[1], "pm is waiting for mail. 1 request is waiting for an answer.");
  assert.equal(rightNow(input({ ...base, openRequests: 3 }))[1], "pm is waiting for mail. 3 requests are waiting for an answer.");
  assert.equal(rightNow(input({ ...base, openRequests: 0 }))[1], "pm is waiting for mail.");
  assert.equal(rightNow(input({ ...base, openRequests: null }))[1], "pm is waiting for mail.", "unknown is not zero, and is not said");
  assert.deepEqual(rightNow(input({ agents: [seat("qa", "THINKING")], turns: [run("qa", ago(1))], openRequests: 2 })), ["qa has been working for 1 min.", "2 requests are waiting for an answer.", "Nothing is waiting for you."]);
});

test("what waits for the person is the last line, and says so when something does", () => {
  const base = { agents: [seat("qa", "THINKING")], turns: [run("qa", ago(1))] };
  assert.equal(rightNow(input({ ...base, forYou: 0 })).at(-1), "Nothing is waiting for you.");
  assert.equal(rightNow(input({ ...base, forYou: 1 })).at(-1), "1 item under Attention needs a look.");
  assert.equal(rightNow(input({ ...base, forYou: 3 })).at(-1), "3 items under Attention need a look.");
});

test("a stalemate: everyone is waiting for mail and nothing is queued, so nothing will happen, and what to do about it is said, if it stays that way", () => {
  const lines = rightNow(input({ phase: "quiet", agents: [seat("pm", "WAITING"), seat("qa", "WAITING"), seat("security", "WAITING")] }));
  assert.deepEqual(lines, ["Everyone is waiting for mail: nothing is queued. If it stays that way, send a message or wake an agent.", "Nothing is waiting for you."]);
  // Seats that finished are not "everyone"; the ones still resting are.
  assert.match(rightNow(input({ phase: "quiet", agents: [seat("pm", "WAITING"), seat("qa", "COMPLETED")] }))[0]!, /^Everyone is waiting for mail:/);
});

test("when only some are resting, they are named, and the others are not said to be waiting", () => {
  const lines = rightNow(input({ phase: "quiet", agents: [seat("pm", "WAITING"), seat("qa", "IDLE"), seat("developer", "STARTING"), seat("security", "WAITING")] }));
  assert.equal(lines[0], "pm and security are waiting for mail: nothing is queued. If it stays that way, send a message or wake an agent.");
});

test("requests still open while everyone is waiting are the one thing worth adding", () => {
  const lines = rightNow(input({ phase: "quiet", agents: [seat("pm", "WAITING"), seat("qa", "WAITING")], openRequests: 2 }));
  assert.deepEqual(lines, ["Everyone is waiting for mail: nothing is queued. If it stays that way, send a message or wake an agent.", "2 requests are waiting for an answer.", "Nothing is waiting for you."]);
});

test("nobody working but a seat queued: it is about to start, and the advice would be wrong", () => {
  const lines = rightNow(input({ phase: "quiet", agents: [seat("pm", "WAITING"), seat("architect", "IDLE")], queued: ["architect"] }));
  assert.equal(lines[0], "Nobody is working this moment. Next in line: architect.");
  assert.doesNotMatch(lines.join(" "), /wake an agent/);
});

test("it is never more than three lines, never names an id, and never says an agent is stuck", () => {
  const states = ["THINKING", "WAITING", "IDLE", "STARTING", "COMPLETED", "WORKING", "FAILED"];
  for (let n = 0; n < 7 ** 3; n++) {
    const lifecycles = [n % 7, Math.floor(n / 7) % 7, Math.floor(n / 49) % 7].map((k) => states[k]!);
    const agents = lifecycles.map((l, k) => seat(`seat-${k}`, l, k));
    for (const phase of ["running", "quiet"] as const) {
      for (const openRequests of [null, 0, 2]) {
        for (const queued of [[], ["seat-1"]]) {
          const lines = rightNow(input({ phase, agents, turns: [run("seat-0", ago(7))], openRequests, queued, forYou: n % 3 }));
          assert.ok(lines.length >= 1 && lines.length <= 3, `${lines.length} lines for ${lifecycles}`);
          assert.doesNotMatch(lines.join(" "), /turn-|evt-|msg-|goal-|esc-|\bstuck\b|\bfrozen\b|\bhung\b|!/i, lines.join(" "));
        }
      }
    }
  }
});

test("read off a /status payload: seats without the human, turns from the status and the steps, the queue, and the open requests", () => {
  const status = {
    agents: [{ id: "human", lifecycle: "STARTING" }, { id: "qa", lifecycle: "THINKING", mailbox: 0 }, { id: "pm", lifecycle: "WAITING", mailbox: 2 }],
    recentTurns: [{ turnId: "t-1", agentId: "qa", startedAt: ago(2), status: "running" }, { turnId: "t-0", agentId: "pm", startedAt: ago(9), status: "ok" }],
    scheduler: { pending: 1, running: 1, queue: [{ agentId: "architect", priority: 5, reason: { kind: "interest_event" } }], waits: [] },
    commitments: { open: 2 },
  };
  const i = rightNowInput(status, { phase: "running", now: NOW, forYou: 0, steps: [{ agentId: "developer", startedAt: ago(1), status: "running" }] });
  assert.deepEqual(i.agents.map((a) => a.id), ["qa", "pm"], "the human is not a seat");
  assert.deepEqual(i.turns.map((t) => [t.agentId, t.status]), [["qa", "running"], ["pm", "ok"], ["developer", "running"]]);
  assert.deepEqual(i.queued, ["architect"]);
  assert.equal(i.openRequests, 2);
  assert.deepEqual(rightNow(i), ["qa (2 min) and developer (1 min) are working.", "Next in line: architect. 2 requests are waiting for an answer.", "Nothing is waiting for you."]);
});

test("a server that predates a field, or a status that is not there, reads as unknown and not as zero", () => {
  const none = rightNowInput({ agents: [] }, { phase: "running", now: NOW, forYou: 0 });
  assert.equal(none.openRequests, null);
  assert.deepEqual([none.queued, none.turns], [[], []]);
  assert.equal(rightNowInput({ commitments: { open: "3" } }, { phase: "running", now: NOW, forYou: 0 }).openRequests, null);
  assert.doesNotThrow(() => rightNowInput(null, { phase: "quiet", now: NOW, forYou: 0 }));
  assert.deepEqual(rightNow(rightNowInput(null, { phase: "quiet", now: NOW, forYou: 0 })), ["Nobody is working and nothing is queued. If it stays that way, send a message or wake an agent.", "Nothing is waiting for you."]);
});
