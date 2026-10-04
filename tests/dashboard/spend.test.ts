import test from "node:test";
import assert from "node:assert/strict";

import { agentsToWake, resumeConfirmBody, spendsTokens, startConfirmBody } from "../../apps/mesh-dashboard/src/spend";

/**
 * The first dialog a visitor meets on the shipped demo is "Start the mission?". It said agents "spend tokens", which the
 * scripted demo cannot: it makes no model call. These pin that the warning is kept for runtimes that can bill and dropped only
 * where the server says every seat is the stub.
 */

const agents = (lifecycles: Array<[string, string]>) => lifecycles.map(([id, lifecycle]) => ({ id, lifecycle }));

test("only a mesh whose every seat is the stub is read as free; anything unknown is read as spending", () => {
  assert.equal(spendsTokens({ runtimes: ["stub"] }), false);
  assert.equal(spendsTokens({ runtimes: ["claude"] }), true);
  assert.equal(spendsTokens({ runtimes: ["claude", "stub"] }), true, "one real seat is enough to spend");
  assert.equal(spendsTokens({ runtimes: ["http", "stub"] }), true);
  assert.equal(spendsTokens({}), true, "a server that predates the field");
  assert.equal(spendsTokens({ runtimes: [] }), true, "an empty list names nothing, so it proves nothing");
  assert.equal(spendsTokens({ runtimes: "stub" }), true, "a string is not the list the server sends");
  assert.equal(spendsTokens(null), true);
});

test("who would be woken: asleep seats only, never the human, at most four", () => {
  const status = { agents: agents([["human", "IDLE"], ["pm", "WORKING"], ["dev", "WAITING"], ["qa", "SUSPENDED"], ["ops", "IDLE"], ["a", "IDLE"], ["b", "IDLE"], ["c", "IDLE"]]) };
  assert.deepEqual(agentsToWake(status), ["dev", "qa", "ops", "a"]);
  assert.deepEqual(agentsToWake(null), []);
});

test("starting a team that can bill says so, in the words it always used", () => {
  const body = startConfirmBody({ runtimes: ["claude"], agents: agents([["dev", "WAITING"], ["qa", "WAITING"]]) });
  assert.deepEqual(body, ["dev, qa will be woken.", "Agents run and spend tokens until you park the mission again."]);
});

test("starting the scripted demo does not warn of a bill that cannot come", () => {
  const body = startConfirmBody({ runtimes: ["stub"], agents: agents([["dev", "WAITING"]]) });
  assert.equal(body[0], "dev will be woken.");
  assert.match(body[1], /scripted team/);
  assert.match(body[1], /no model calls and spends nothing/);
  assert.doesNotMatch(body.join(" "), /spend tokens/);
});

test("starting with nobody asleep still says what it costs", () => {
  assert.deepEqual(startConfirmBody({ runtimes: ["claude"], agents: [] }), ["Agents run and spend tokens until you park the mission again."]);
});

test("resuming asks only when something is asleep, and says whether it spends", () => {
  assert.equal(resumeConfirmBody({ runtimes: ["claude"], agents: agents([["dev", "WORKING"]]) }), null, "nothing to wake, nothing to ask");
  assert.deepEqual(
    resumeConfirmBody({ runtimes: ["claude"], agents: agents([["dev", "IDLE"], ["qa", "WAITING"]]) }),
    ["This wakes dev, qa and resumes spend against the mission budget."],
  );
  assert.deepEqual(
    resumeConfirmBody({ runtimes: ["stub"], agents: agents([["dev", "IDLE"]]) }),
    ["This wakes dev. It is a scripted team, so nothing is spent."],
  );
});
