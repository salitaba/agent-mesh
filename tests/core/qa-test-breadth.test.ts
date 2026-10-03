import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

/**
 * QA is told what its verification has to cover, and that its report says what it ran.
 *
 * The fifteenth cronlite run's QA passed a library that refused a month or a day name in capitals when it contains an `L` or a `W`
 * (`JUL`, `WED`: read as Quartz syntax), that threw `TypeError: schedule.dom.values is not iterable` for a step on the day-of-month
 * field, and that dropped every item of a list after a leading step. Its own commands were `npm test` (the developer's 51 tests),
 * eleven CLI invocations and eight library checks, none of them a name in capitals that contains an L or a W, a step on the
 * day-of-month field or a list that starts with a step. Its report listed every behaviour of the contract as verified all the same,
 * among them "Case-insensitive month and day names (`JAN`, `jan`, `MON`, `mon`)" and steps written with `*` and with a range: what
 * the developer's suite covers, written as what QA ran. The same family, names that contain an L or a W refused as Quartz, was the
 * product's own defect in the runs of sections 8, 9, 14, 17, 19 and 20 of the notes, and QA passed it each time.
 *
 * Nothing in the mesh can know what a contract's cases are, so the instruction is in the seat's prompt: enumerations member by member,
 * forms in every place and combination, each rejection with its near-miss, and a report that separates what was run from what was not.
 */

const role = fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "roles", "qa.md"), "utf8");
const at = role.indexOf("## What to test, and what the report says");
const section = at >= 0 ? role.slice(at, role.indexOf("\n## ", at + 5)) : "";

test("the QA role prompt has a section on what to test, ahead of the verdict contract", () => {
  assert.ok(at >= 0, "the section exists");
  assert.ok(at < role.indexOf("## Verdict contract"), "and a QA reads it before the verdict it will give");
});

test("cases come from the contract, not from the developer's tests or the examples", () => {
  assert.match(section, /Derive your cases from the contract \(the spec, the acceptance criteria\), not from the examples it prints and not from their tests/);
  assert.match(section, /Run their suite too, and say it is theirs\./);
});

test("an enumeration is tested member by member, in every spelling", () => {
  assert.match(section, /An enumeration in the contract \(names, keywords, flags, modes, error kinds\) is tested member by member, in every spelling the contract allows \(case, abbreviation\)/);
  assert.match(section, /a loop over the whole list is one command, and a sample of it is not a test of it/);
});

test("a form is tested in every place it is allowed, combined, in both orders", () => {
  assert.match(section, /tested in every place, combined with the others, in both orders/);
});

test("every rejection gets its near-miss", () => {
  assert.match(section, /a case that must be refused and a near-miss that must be accepted: the neighbour that shares a letter, a prefix or a shape with it/);
});

test("the report says what was run, and what was not run is not a pass", () => {
  assert.match(section, /The report says what you RAN in this turn: for each claim, the command and its actual output, excerpted\./);
  assert.match(section, /What you did not run is listed under NOT TESTED, and what only the developer's suite covers is listed as theirs, never as passing\./);
  assert.match(section, /A pass that covers less than it says is worse than no pass\./);
});
