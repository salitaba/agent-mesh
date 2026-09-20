import test from "node:test";
import assert from "node:assert/strict";

import {
  applyAdvisoryTone,
  ADVISORY_NEXT,
  NOTICE_CLAUSE,
  PAUSED_CLAUSE,
  RESUMES,
  RESUMES_AND_WAKES,
  WAKES_ONLY,
} from "../../apps/mesh-dashboard/src/escalation-tone";

/**
 * The bug these cover: the collab watchdog raises its overrun card with
 * `advisory: true`, which is exactly what keeps the card out of the mission
 * verdict and lets the run continue. The dashboard never read the flag, so the
 * card fell through to wording written for a blocking escalation and told the
 * operator "The mission is paused until you respond" about a mission that was
 * not paused and was not waiting for them. The recovery manager's advisory
 * `runtime_failure` said the same thing through a different arm.
 *
 * The claim under test is narrow and total: an advisory card never tells the
 * operator that anything is paused, and never promises that answering resumes
 * something, no matter which arm produced it.
 */

const card = (what: string, next: string) => ({ title: "t", what, next, placeholder: "p" });

test("advisory tone: a blocking card is passed through untouched", () => {
  const base = card(`Something broke. ${PAUSED_CLAUSE}`, `Do the thing. ${RESUMES_AND_WAKES}`);
  assert.deepEqual(applyAdvisoryTone(base, false), base);
});

test("advisory tone: the pause claim is withdrawn", () => {
  const out = applyAdvisoryTone(card(`dev crashed. ${PAUSED_CLAUSE}`, "Look at it."), true);
  assert.ok(out.what.includes(NOTICE_CLAUSE), out.what);
  assert.ok(!out.what.includes("The mission is paused"), out.what);
  assert.ok(out.what.startsWith("dev crashed."), "the arm's own facts survive");
});

test("advisory tone: answering wakes agents but is not promised to resume anything", () => {
  const out = applyAdvisoryTone(card("x", `Retry or skip. ${RESUMES_AND_WAKES}`), true);
  assert.ok(out.next.includes(WAKES_ONLY), out.next);
  assert.ok(!out.next.includes("resumes the mission"), out.next);
  assert.ok(out.next.includes("Retry or skip."), "arm guidance is kept, not replaced");
  assert.ok(out.next.startsWith(ADVISORY_NEXT), "and the notice leads");
});

test("advisory tone: a bare resume promise is dropped without leaving a seam", () => {
  const out = applyAdvisoryTone(card("x", `Respond with the decision. ${RESUMES}`), true);
  assert.ok(!out.next.includes("resumes the mission"), out.next);
  assert.ok(!/\s{2,}/.test(out.next), `double space left behind: ${JSON.stringify(out.next)}`);
  assert.ok(!out.next.endsWith(" "), out.next);
});

test("advisory tone: an arm that never claimed a pause keeps all of its advice", () => {
  const advice = "Check the backend process is alive, look for OOM, or restart it.";
  const out = applyAdvisoryTone(card("dev's backend stopped answering.", advice), true);
  assert.equal(out.what, "dev's backend stopped answering.");
  assert.equal(out.next, `${ADVISORY_NEXT} ${advice}`);
});

test("advisory tone: fields the view carries alongside the wording survive", () => {
  const out = applyAdvisoryTone({ ...card("a", "b"), budget: { spent: 5 } } as never, true) as never as {
    budget: { spent: number };
    title: string;
  };
  assert.equal(out.budget.spent, 5);
  assert.equal(out.title, "t");
});

test("advisory tone: no arm wording can leave a pause or resume claim standing", () => {
  // Every shape the card arms actually produce today. The point of the table is
  // that it is checked as a class: a new arm built from the shared sentences is
  // covered the day it is written, without anyone adding a case here.
  const arms = [
    card(`Mesh watchdog detected a runtime failure in dev. ${PAUSED_CLAUSE}`, `Retry or skip. ${RESUMES_AND_WAKES}`),
    card(`Mesh watchdog needs you to decide. ${PAUSED_CLAUSE}`, `Read the context below. ${RESUMES}`),
    card("alice and bob were still talking when their time box ran out.", "Tell them the answer."),
    card(`${PAUSED_CLAUSE}`, `${RESUMES}`),
  ];
  for (const arm of arms) {
    const out = applyAdvisoryTone(arm, true);
    const all = `${out.what} ${out.next}`;
    assert.ok(!all.includes("mission is paused"), `still claims a pause: ${all}`);
    assert.ok(!all.includes("resumes the mission"), `still promises a resume: ${all}`);
    assert.ok(out.next.includes(ADVISORY_NEXT), `lost the notice: ${out.next}`);
  }
});
