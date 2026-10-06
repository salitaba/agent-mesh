import test from "node:test";
import assert from "node:assert/strict";

import { goLiveNotice, startBlock } from "../../apps/mesh-dashboard/src/golive";
import { KEY_MISSING } from "../../apps/mesh-dashboard/src/firstrun";

/**
 * A 200 from Start means the scheduler started, not that anyone is working. The notice is read off the counts the route reports,
 * because "agents are running" over a mission whose every startup seat was refused was the toast behind "I clicked Continue and the
 * mesh did not start".
 */

test("agents that started are named, and are a plain success", () => {
  assert.deepEqual(goLiveNotice(200, { started: true, activated: ["pm"], refused: [], note: "scheduler live; activated: pm" }), { title: "Agents are running", msg: "pm is starting.", kind: "ok" });
  assert.equal(goLiveNotice(200, { activated: ["dev", "qa"], refused: [] }).msg, "dev and qa are starting.");
  assert.equal(goLiveNotice(200, { activated: ["a", "b", "c"], refused: [] }).msg, "a, b and c are starting.");
});

test("nobody started is a failure whatever the 200 says, and the server's note says why", () => {
  const n = goLiveNotice(200, { started: true, activated: [], refused: [], note: "scheduler live; no startup agents configured" });
  assert.equal(n.kind, "bad");
  assert.equal(n.title, "The scheduler is on, but no agent started");
  assert.equal(n.msg, "scheduler live; no startup agents configured");
  assert.match(goLiveNotice(200, { activated: [] }).msg, /Wake an agent from Agents\./, "and a server that sent no note still says what to do");
});

test("some started and some refused is a warning that counts the refused", () => {
  assert.deepEqual(goLiveNotice(200, { activated: ["pm"], refused: [{ agent: "qa" }], note: "qa refused" }), { title: "Running, with 1 agent blocked", msg: "qa refused", kind: "warn" });
  assert.equal(goLiveNotice(200, { activated: ["pm"], refused: [1, 2] }).title, "Running, with 2 agents blocked");
});

test("a mission that was already running says so, and is not an error", () => {
  const n = goLiveNotice(200, { started: false, note: "already live" });
  assert.deepEqual(n, { title: "Already running", msg: "already live", kind: "ok" });
  assert.equal(goLiveNotice(200, { started: false }).msg, "The scheduler was already on.");
});

test("a refusal says it could not start the mission, with the server's error before its note", () => {
  assert.deepEqual(goLiveNotice(409, { error: "project 'x' is closed", note: "n" }), { title: "Could not start the mission", msg: "project 'x' is closed", kind: "bad" });
  assert.equal(goLiveNotice(500, null).msg, "The server refused the request.");
  assert.equal(goLiveNotice(503, { note: "draining" }).msg, "draining");
});

test("a reply that is not the shape expected does not throw and does not claim success", () => {
  assert.equal(goLiveNotice(200, { activated: "pm", refused: "x" }).kind, "bad");
  assert.equal(goLiveNotice(200, undefined).kind, "bad");
  assert.deepEqual(goLiveNotice(200, { activated: ["pm", 7, null] }).msg, "pm is starting.", "only names count as seats");
});

/**
 * Pressing Start on a mission that has no goal written, or a hosted team whose model key is not added, says so before it asks anything
 * about cost. Starting is the one click that lets agents run and spend, so a start that cannot do what it says is held, not tried.
 */

test("a goal nobody wrote holds Start, whatever else is true, and the dialog's button goes to the goal", () => {
  const goal = startBlock({ needsGoal: true, spendsTokens: true, keyMissing: true });
  assert.equal(goal?.kind, "goal", "a team with no goal has nothing to spend a key on: the goal is first");
  assert.equal(goal?.title, "Write the goal first");
  assert.equal(goal?.confirmLabel, "Write the goal");
  assert.equal(goal?.cancelLabel, "Not now");
  assert.match(goal!.body[0]!, /still the placeholder.*reads the goal on every turn/s);
  assert.match(goal!.body[1]!, /Write what the team should deliver in the Designer, then start the mission\./);
  assert.equal(startBlock({ needsGoal: true, spendsTokens: false, keyMissing: false })?.kind, "goal", "a scripted team on a placeholder is held too: it would work towards a goal that says nothing");
  for (const line of goal!.body) assert.doesNotMatch(line, /\b(spend|cost|bill|token)s?\b/i, "it is true of a scripted team too, so it says nothing about money");
});

test("a hosted team with no model key holds Start and sends the person to their account page; a scripted team is never held for a key", () => {
  const key = startBlock({ needsGoal: false, spendsTokens: true, keyMissing: true });
  assert.equal(key?.kind, "key");
  assert.equal(key?.title, "Add your model key first");
  assert.equal(key?.body[0], KEY_MISSING);
  assert.match(key!.body[1]!, /Nothing has been started and nothing has been spent/);
  assert.equal(key?.confirmLabel, "Open my account page");
  assert.equal(key?.cancelLabel, "Not now");
  assert.equal(startBlock({ needsGoal: false, spendsTokens: false, keyMissing: true }), null, "the demo needs no model: no key, no problem");
});

test("nothing is held when nothing is wrong: the question that names the agents and the cost is the only one", () => {
  assert.equal(startBlock({ needsGoal: false, spendsTokens: true, keyMissing: false }), null);
  assert.equal(startBlock({ needsGoal: false, spendsTokens: false, keyMissing: false }), null);
});
