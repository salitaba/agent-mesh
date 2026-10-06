import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRunReport, renderRunReport, criterionLine, CRITERION_LINE_MAX } from "../../packages/core/src/run-report";
import { createInitialState, type Projections } from "../../packages/core/src/state";
import type { Goal } from "../../packages/protocol/src/index";

/**
 * A criterion that is a document is one line of the report.
 *
 * A reopen puts the operator's whole reason into the criterion it mints. The nineteenth cronlite run's reopen was 7.6k characters
 * (three defects, and 19 commands for QA to run with the output each must print), and the end-of-run report printed all of it: 49
 * of its 127 lines, between the six criteria the mission began with and the spend. The text is in the goal and in the report data;
 * the report is what a person reads to see how the run went.
 */

const AT = "2026-02-01T00:00:00.000Z";

function seed(state: Projections, descriptions: string[]): void {
  const goal = {
    id: "goal-1",
    description: "ship it",
    status: "COMPLETED",
    createdAt: AT,
    acceptanceCriteria: descriptions.map((description, i) => ({ id: `c${i}`, description, mandatory: true, status: "UNSATISFIED", evidence: [] })),
  } as unknown as Goal;
  state.goals.set(goal.id, goal);
  state.activeGoalId = goal.id;
}

const REOPEN =
  `Operator reopened the mission: "REJECTED after acceptance testing against SPEC.md. The merged library has three defects.\n\n` +
  Array.from({ length: 19 }, (_, i) => `${i + 1}. node --input-type=module -e "import {parse} from './src/index.js'; parse('${i} * * * *')"\n   required output: ok`).join("\n") +
  `". This is a mandatory acceptance criterion: the mission cannot complete again until work that addresses it is published and accepted.`;

test("a criterion of a sentence or two is printed as it is, line breaks and all", () => {
  const short = "Requirements are captured in a RequirementsDoc that the PM has accepted";
  assert.equal(criterionLine(short), short);
  const lines = "first line\nsecond line\n  third, indented";
  assert.equal(criterionLine(lines), lines, "a short description is not reflowed");
  const edge = `${"x".repeat(CRITERION_LINE_MAX - 4)}\na\nb`;
  assert.equal(edge.length, CRITERION_LINE_MAX);
  assert.equal(criterionLine(edge), edge, "the limit itself is not cut, nor reflowed");
  const over = `${edge}c`;
  assert.notEqual(criterionLine(over), over, "one past it is");
  assert.ok(!criterionLine(over).includes("\n"));
});

test("a description that is long only in its white space is printed whole, on one line, with nothing counted as left out", () => {
  const padded = `Every export\n\n\n${" ".repeat(CRITERION_LINE_MAX)}behaves as the goal specifies\n\n`;
  assert.ok(padded.length > CRITERION_LINE_MAX);
  assert.equal(criterionLine(padded), "Every export behaves as the goal specifies");
});

test("a long one is the start of it, on one line, with what was left out counted", () => {
  const line = criterionLine(REOPEN);
  assert.ok(!line.includes("\n"), "one line");
  assert.ok(line.startsWith(`Operator reopened the mission: "REJECTED after acceptance testing against SPEC.md.`), line);
  assert.ok(line.length <= CRITERION_LINE_MAX + 60, `${line.length} characters`);
  const flat = REOPEN.replace(/\s+/g, " ").trim();
  const m = /^(.*) … \(\+(\d+) more characters in the criterion\)$/.exec(line);
  assert.ok(m, line);
  assert.equal(m![1]!.length + Number(m![2]), flat.length, "what is shown and what is counted add up to the whole of it");
  assert.ok(flat.startsWith(m![1]!), "and what is shown is the start of it");
});

test("the cut falls between words when there is a space to cut at, and never leaves a dangling separator", () => {
  const words = Array.from({ length: 80 }, (_, i) => `word${i}`).join(", ");
  const line = criterionLine(words);
  const shown = line.slice(0, line.indexOf(" … ("));
  assert.ok(/word\d+$/.test(shown), `ends on a whole word: ${shown.slice(-20)}`);
  assert.ok(!/[ ,;:.]$/.test(shown));
  // No space in the last half: cut where the limit is rather than far back.
  const solid = "z".repeat(CRITERION_LINE_MAX * 3);
  const cut = criterionLine(`aaa ${solid}`);
  assert.ok(cut.startsWith(`aaa ${"z".repeat(CRITERION_LINE_MAX - 4)} … (+`), cut.slice(0, 30));
});

test("the report prints a reopen as one line, and keeps the other criteria and the data whole", () => {
  const state = createInitialState();
  seed(state, ["Architecture approved by architect and tech-lead", REOPEN, "The real CLI behaves as the goal specifies"]);
  const report = buildRunReport(state);
  const text = renderRunReport(report);
  const acceptance = text.slice(text.indexOf("ACCEPTANCE"));
  assert.match(acceptance, /· Architecture approved by architect and tech-lead\n/);
  assert.match(acceptance, /· The real CLI behaves as the goal specifies\n/);
  assert.equal(acceptance.split("\n").filter((l) => l.includes("Operator reopened the mission")).length, 1);
  assert.ok(!acceptance.includes("parse('18 * * * *')"), "the last of its 19 checks is not in the report");
  assert.ok(acceptance.split("\n").length < 20, `${acceptance.split("\n").length} lines for the acceptance section`);
  assert.equal(report.criteria.items[1]!.description, REOPEN, "the data keeps the whole text");
});
