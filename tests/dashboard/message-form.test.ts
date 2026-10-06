import test from "node:test";
import assert from "node:assert/strict";

import { messageTypeLabel, recipientsOf, toggleRecipient } from "../../apps/mesh-dashboard/src/message-form";

/**
 * The Message drawer's "To" is one text field ("pm, qa"), and chips under it add and take out a seat's name in it. These pin what a
 * typed list means, what a chip does to it, and that the kind of message is named in words before its protocol name.
 */

const SEATS = ["pm", "architect", "tech-lead", "developer", "qa"];

test("a typed list is read as the seats it names: trimmed, each once, a seat's name in the seat's own case", () => {
  assert.deepEqual(recipientsOf("pm, qa", SEATS), ["pm", "qa"]);
  assert.deepEqual(recipientsOf("  pm ,qa,,  ,", SEATS), ["pm", "qa"], "spacing and empty entries");
  assert.deepEqual(recipientsOf("PM, Tech-Lead", SEATS), ["pm", "tech-lead"], "the server knows pm, not PM");
  assert.deepEqual(recipientsOf("qa, pm, QA, qa", SEATS), ["qa", "pm"], "each once, in the order first written");
  assert.deepEqual(recipientsOf("", SEATS), []);
});

test("a name that is no seat's is kept as typed, once, so the server can say it does not know it", () => {
  assert.deepEqual(recipientsOf("pm, designer, Designer", SEATS), ["pm", "designer"]);
  assert.deepEqual(recipientsOf("pm", []), ["pm"], "with no roster loaded the field still sends what was typed");
});

test("when two seats differ only by case, a typed name means the one it spells exactly", () => {
  const seats = ["qa", "QA"];
  assert.deepEqual(recipientsOf("QA, qa", seats), ["QA", "qa"]);
});

test("a chip adds its seat at the end, takes it out when it is there, and leaves the rest of what was typed tidied", () => {
  assert.equal(toggleRecipient("", "pm", SEATS), "pm");
  assert.equal(toggleRecipient("pm", "qa", SEATS), "pm, qa");
  assert.equal(toggleRecipient("pm, qa", "pm", SEATS), "qa");
  assert.equal(toggleRecipient("PM ,  qa", "pm", SEATS), "qa", "a seat typed in another case is the same seat");
  assert.equal(toggleRecipient("designer,pm", "qa", SEATS), "designer, pm, qa", "an unknown name stays where it was");
  assert.equal(toggleRecipient("qa", "qa", SEATS), "", "the last one out leaves the field empty");
});

test("the kind of message is named in words, never as the protocol's UPPER_CASE name", () => {
  assert.equal(messageTypeLabel("INFORM"), "update");
  assert.equal(messageTypeLabel("MISSION"), "new task");
  assert.equal(messageTypeLabel("REQUEST_REVIEW"), "ask for review");
  // The types the console has no phrase for read as the event lines read them: lower case, words apart.
  assert.equal(messageTypeLabel("REQUEST_INFO"), "request info");
  assert.equal(messageTypeLabel("SECURITY_FINDING"), "security finding");
  for (const t of ["INFORM", "REQUEST_EXECUTION", "PATCH_READY", "DONE"]) {
    assert.doesNotMatch(messageTypeLabel(t), /[A-Z_()]/, t);
  }
});
