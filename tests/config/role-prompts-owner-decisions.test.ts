import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

/**
 * What the role prompts say about the things the nineteenth and twentieth cronlite runs showed they have to say.
 *
 * The prompts are text, and a test of text is a weak thing, so each assertion is the sentence's job and not its wording: a seat
 * that is not told to run the operator's checks runs one example of each problem it is told about, a seat that is not told a
 * licence is not its to choose writes `"license": "MIT"` into the manifest of a product whose owner never named one (every one of
 * the last six runs' products does), a QA that is told to treat the architect's prose as a checklist runs the developer's suite and
 * ten CLI commands instead (the twentieth run, for the sixth time), and a developer that is told which case failed fixes that case
 * (the twentieth run's reopen named `JUL`; the product still refused `JUN-JUL`).
 */

const role = (name: string): string => fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "roles", `${name}.md`), "utf8");

/** The one bullet of a prompt that opens with this bold lead, whole: the sentences below are pinned to the bullet that says them. */
const bullet = (text: string, lead: string): string => text.split("\n").find((line) => line.startsWith(`- **${lead}`)) ?? "";

test("QA runs the operator's checks first, every one, and a report that leaves one out cannot pass", () => {
  const qa = role("qa");
  assert.match(qa, /The operator's checks come first/);
  assert.match(qa, /numbered commands each with the output it must print, run every one of them, in order, from the product's root, before any case of your own/);
  assert.match(qa, /the command, the output it required and the output it printed/);
  assert.match(qa, /A check you did not run is NOT TESTED, and a report that leaves one out cannot pass/);
});

test("QA with no operator list writes one from the contract, in the same form, runs it in the turn and reports each line", () => {
  const qa = role("qa");
  const own = bullet(qa, "No operator list?");
  assert.notEqual(own, "", "the bullet exists");
  assert.match(own, /No operator list\? Write one yourself, from the contract, before you run anything\./);
  assert.match(own, /numbered, each line a command with the output it must print/);
  assert.match(own, /A line for every rejection the contract lists and the near-miss beside it that must be accepted; every worked example; every member of every enumeration/);
  assert.match(own, /every sentence of the form "every X must Y" \(one command that loops over all the X and prints each result\)/);
  assert.match(own, /each MUST of the `RequirementsDoc` and each testable constraint of the `ArchitectureDocument` \(read both with `mesh_artifact_read`/);
  assert.match(own, /the ways of writing it wrongly that the contract does not allow: signed, fractional, prefixed, repeated, truncated/);
  assert.match(own, /Run the list in order, in this turn, and report it the way you would the operator's: each line as the command, the output it required and the output it printed/);
  assert.match(own, /A line you wrote no command for is NOT TESTED, not skipped, and a report that leaves one out cannot pass/);
  assert.match(own, /The developer's suite is not on the list/);
  assert.ok(qa.indexOf(own) > qa.indexOf("The operator's checks come first"), "the operator's list still comes first");
});

test("the pm accepts the operator's reopen only on a report that gives every check", () => {
  const pm = role("pm");
  assert.match(pm, /An `operator-feedback-…` criterion that lists checks is accepted only on a QA report that gives every one of them with the output it printed/);
  assert.match(pm, /ask QA for it/);
});

test("the developer runs the operator's checks before asking for review, and does not choose the product's licence or author", () => {
  const dev = role("developer");
  assert.match(dev, /listed checks \(numbered commands, each with the output it must print\): run every one yourself before you ask for review/);
  assert.match(dev, /Do not decide what the work's owner decides\. The product's licence, author, repository or homepage address and version are not yours to choose/);
  assert.match(dev, /otherwise leave the field out/);
  assert.match(dev, /one that says `MIT` is a legal statement nobody made/);
});

test("the developer fixes the rule behind a named failure, and runs its neighbours before asking for review", () => {
  const dev = role("developer");
  const rule = bullet(dev, "A failure, a block or a reopen's check names one instance; fix the rule behind it");
  assert.notEqual(rule, "", "the bullet exists");
  assert.match(rule, /Before you re-version, add a line to the list you run for every other place the same rule applies/);
  assert.match(rule, /the value alone, in a list, in a range, in a step, in each field that takes it, in each spelling the contract allows/);
  assert.match(rule, /say in the request which lines you ran and what they printed/);
  assert.match(rule, /leaves its neighbours failing comes back as the same rejection/);
  assert.ok(dev.indexOf(rule) > dev.indexOf("`TEST_RESULT FAILED` from qa"), "it sits with the wake that names a failure");
  assert.ok(dev.indexOf(rule) < dev.indexOf("## Artifact contract"), "inside the wake triggers a developer reads first");
});

test("the three prompts still end by telling the seat how to close a turn", () => {
  for (const name of ["qa", "pm", "developer"]) assert.match(role(name), /## Close every turn/, name);
});
