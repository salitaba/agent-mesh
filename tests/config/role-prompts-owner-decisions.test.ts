import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

/**
 * What the role prompts say about the two things the nineteenth cronlite run showed they have to say.
 *
 * The prompts are text, and a test of text is a weak thing, so each assertion is the sentence's job and not its wording: a seat
 * that is not told to run the operator's checks runs one example of each problem it is told about, and a seat that is not told a
 * licence is not its to choose writes `"license": "MIT"` into the manifest of a product whose owner never named one (every one of
 * the last six runs' products does).
 */

const role = (name: string): string => fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "roles", `${name}.md`), "utf8");

test("QA runs the operator's checks first, every one, and a report that leaves one out cannot pass", () => {
  const qa = role("qa");
  assert.match(qa, /The operator's checks come first/);
  assert.match(qa, /numbered commands each with the output it must print, run every one of them, in order, from the product's root, before any case of your own/);
  assert.match(qa, /the command, the output it required and the output it printed/);
  assert.match(qa, /A check you did not run is NOT TESTED, and a report that leaves one out cannot pass/);
});

test("QA takes the architecture's testable constraints as its checklist: a command for each, run in the turn, or listed as not tested", () => {
  const qa = role("qa");
  assert.match(qa, /The architecture's testable constraints are your checklist/);
  assert.match(qa, /read it with `mesh_artifact_read`/);
  assert.match(qa, /Give every constraint a command of its own, run in this turn, and put the command and the output it printed in the report/);
  assert.match(qa, /a constraint you wrote no command for is listed under NOT TESTED, not skipped/);
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

test("the three prompts still end by telling the seat how to close a turn", () => {
  for (const name of ["qa", "pm", "developer"]) assert.match(role(name), /## Close every turn/, name);
});
