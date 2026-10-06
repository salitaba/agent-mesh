import test from "node:test";
import assert from "node:assert/strict";

import { ASSISTANT_ASK, STARTERS, assistantTrouble, plainReason, readProblem } from "../../apps/mesh-dashboard/src/designer/assistant-text";
import { KEY_MISSING } from "../../apps/mesh-dashboard/src/firstrun";

/**
 * The designer is where a new person asks for a team in a sentence. When it cannot answer, the dock used to show whatever the host
 * or the console had to hand: a JSON body, "designer chat failed (502)", "the reply contained no parseable whole-config block or
 * patch". These pin what a person is told instead, from the strings that really arrive.
 */

const LAPTOP = { hosted: null, keyMissing: false };
const WORKSPACE = { hosted: { accountUrl: "https://app.curule.example/account" }, keyMissing: false };
const NO_KEY = { hosted: { accountUrl: "https://app.curule.example/account" }, keyMissing: true };

test("a workspace with no model key is told so, with where to add it and that the team can be built by hand, whatever the host said", () => {
  for (const raw of ["designer chat failed (500)", `{"error":"no model"}`, "boom"]) {
    const t = assistantTrouble(raw, NO_KEY);
    assert.equal(t.kind, "key", raw);
    assert.ok(t.text.startsWith(KEY_MISSING), "one sentence, said as the welcome and the Start dialog say it");
    assert.match(t.text, /add seats on the canvas or in the list/);
  }
});

test("the host's busy answer, which the console hands over as raw JSON, is a sentence about waiting", () => {
  const raw = `{"error":"the designer is already working on 3 conversations; wait for one to finish","code":"designer_busy"}`;
  const t = assistantTrouble(raw, LAPTOP);
  assert.equal(t.kind, "busy");
  assert.equal(t.text, "The designer is busy with other conversations. Wait a moment and ask again. Nothing in your draft was changed.");
  assert.doesNotMatch(t.text, /[{}"]/, "no JSON reaches a person");
});

test("a host that did not answer and a stream that was cut off say what happened and to ask again", () => {
  const offline = assistantTrouble("designer chat failed — the server is unreachable", LAPTOP);
  assert.deepEqual([offline.kind, offline.text], ["offline", "The host did not answer. Check that it is still running, then ask again. Nothing in your draft was changed."]);
  const cut = assistantTrouble("designer chat — the stream was interrupted", LAPTOP);
  assert.deepEqual([cut.kind, cut.text], ["interrupted", "The answer was cut off before it finished. Ask again. Nothing in your draft was changed."]);
});

test("a model that could not be reached says so, whether the key is missing, refused or the provider cannot be called; a laptop is told what to check, a workspace to check its key and address on the account page", () => {
  const raws = [
    "Invalid API key · Please run /login", "401 Unauthorized", "ANTHROPIC_API_KEY is not set", "No credentials found for the provider", `{"error":"authentication failed"}`,
    // What a workspace whose key points at an address its host may not call really answers (the service's egress policy):
    "API Error: 403 Host not in allowlist: api.openai.com. Add this host to your network egress settings to allow access. (curule)",
    "fetch failed: getaddrinfo ENOTFOUND api.example.invalid", "connect ECONNREFUSED 127.0.0.1:9", "request to https://x.example/v1 failed, reason: socket hang up",
  ];
  for (const raw of raws) {
    const laptop = assistantTrouble(raw, LAPTOP);
    assert.equal(laptop.kind, "model", raw);
    assert.match(laptop.text, /^The designer could not reach a model: /);
    assert.match(laptop.text, /Check that this host has a working key for a model provider \(ANTHROPIC_API_KEY, or the settings for Bedrock, Vertex AI or Foundry, in its environment\) and can reach it, then ask again\./);
    assert.match(laptop.text, /Nothing in your draft was changed\. You can still build the team yourself/);
    const workspace = assistantTrouble(raw, WORKSPACE);
    assert.equal(workspace.kind, "model", raw);
    assert.match(workspace.text, /^The designer could not reach a model with the key this workspace has: /);
    assert.match(workspace.text, /Check the key and the provider address on your account page\./);
    // The advice never sends a customer to an environment they cannot set (the host's own words, when they name a setting, are its own).
    if (!/ANTHROPIC_API_KEY/.test(raw)) assert.doesNotMatch(workspace.text, /ANTHROPIC_API_KEY/, "a customer cannot set a workspace's environment");
  }
  assert.match(assistantTrouble(raws[5]!, WORKSPACE).text, /Host not in allowlist: api\.openai\.com\.[^]*\(curule\)\. Check the key/, "the host's own words come first, as a sentence, then what to check");
});

test("anything else is said in the host's own words, as a sentence, with what was kept and what to do", () => {
  const t = assistantTrouble(`{"error":"the model overloaded the request","code":"x"}`, LAPTOP);
  assert.deepEqual([t.kind, t.text], ["other", "The designer could not answer: the model overloaded the request. Nothing in your draft was changed. Ask again, or you can still build the team yourself: add seats on the canvas or in the list."]);
  assert.equal(assistantTrouble("Something odd.", LAPTOP).text.startsWith("The designer could not answer: Something odd. Nothing"), true, "a stop that is there is not doubled");
  const long = assistantTrouble("x".repeat(500), LAPTOP).text;
  assert.ok(long.length < 400, "a long message is shortened, not dumped");
  for (const raw of ["", "   "]) {
    const t = assistantTrouble(raw, LAPTOP).text;
    assert.doesNotMatch(t, /undefined|null|\{|\}/, JSON.stringify(raw));
    assert.equal(t.startsWith("The designer could not answer. Nothing in your draft was changed."), true, "no reason given, none invented, and no stray colon");
  }
});

test("a body the console cut at 200 characters is read as text, and one with a reason prefers it", () => {
  assert.equal(plainReason(`{"error":"a","reason":"The reason."}`), "The reason.");
  assert.equal(plainReason(`{"error":"only this"}`), "only this");
  assert.equal(plainReason(`{"error":"cut off in the mid`), `{"error":"cut off in the mid`, "not JSON, so it is the text it is");
  assert.equal(plainReason("plain"), "plain");
  assert.equal(plainReason(`{"unrelated":1}`), `{"unrelated":1}`);
});

test("what the host says about an answer is shown as a person reads it, and an answer with no proposal is a note, not a failure", () => {
  assert.deepEqual(readProblem("the reply contained no parseable whole-config block or patch"), { text: "This answer proposes no change to your draft.", fault: false });
  const noDraft = readProblem("the reply used a patch, but there is no current draft to apply it to — send the complete config instead");
  assert.equal(noDraft.fault, true);
  assert.match(noDraft.text, /could not apply, because there is no draft/);
  assert.deepEqual(readProblem("the patch could not be applied: path /agents/x does not exist"), { text: "The designer's change could not be applied to your draft: path /agents/x does not exist. Ask again.", fault: true });
  assert.deepEqual(readProblem("/agents/pm/role: must NOT have fewer than 1 characters"), { text: "/agents/pm/role: must NOT have fewer than 1 characters", fault: true }, "a config error is the checks' own sentence, and stays it");
});

test("the dock starts with a question and two ways to begin, each a sentence to send, none a promise", () => {
  assert.equal(ASSISTANT_ASK, "What should the team look like? Describe it in a sentence, or start from one of these.");
  assert.deepEqual(STARTERS.map((s) => s.label), ["Product team: PM, architect, developers, QA", "A small team: one builder and one reviewer"]);
  for (const s of STARTERS) {
    assert.match(s.text, /^A .*\.$/, s.id);
    assert.doesNotMatch(s.text, /\b(will|guarantee|automatically)\b/i, s.id);
  }
});
