import test from "node:test";
import assert from "node:assert/strict";

import {
  applyAdvisoryTone,
  applyParkedTone,
  ADVISORY_NEXT,
  NOTICE_CLAUSE,
  PARKED_NEXT,
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

/**
 * The second correction. A parked project has a stopped scheduler, so an answer is recorded and nothing runs until the
 * mission is started; the arms all promise "resumes the mission and wakes the affected agents", and the card said the
 * opposite in small print under the form. The claim under test is as narrow and as total as the advisory one: a parked card
 * never promises that answering restarts anything, whichever arm produced it and whether or not it is also advisory.
 */

test("parked tone: a live project's card is passed through untouched", () => {
  const base = card(`Something broke. ${PAUSED_CLAUSE}`, `Do the thing. ${RESUMES_AND_WAKES}`);
  assert.deepEqual(applyParkedTone(base, false), base);
});

test("parked tone: the resume and wake promises become one honest sentence, and the arm's own advice is kept", () => {
  const out = applyParkedTone(card("x", `Retry or skip. ${RESUMES_AND_WAKES}`), true);
  assert.equal(out.next, `Retry or skip. ${PARKED_NEXT}`);
  const bare = applyParkedTone(card("x", `Respond with the decision. ${RESUMES}`), true);
  assert.equal(bare.next, `Respond with the decision. ${PARKED_NEXT}`);
  assert.ok(!/\s{2,}/.test(bare.next) && !bare.next.endsWith(" "), "no seam left behind");
});

test("parked tone: the halt is still true, so the pause claim in `what` stays", () => {
  const out = applyParkedTone(card(`dev crashed. ${PAUSED_CLAUSE}`, "Look at it."), true);
  assert.equal(out.what, `dev crashed. ${PAUSED_CLAUSE}`);
  assert.equal(out.next, "Look at it.", "an arm that promised nothing gets nothing added");
});

test("parked tone: an advisory card on a parked project promises neither a resume nor a wake", () => {
  const out = applyParkedTone(applyAdvisoryTone(card("x", `Retry or skip. ${RESUMES_AND_WAKES}`), true), true);
  assert.ok(out.next.startsWith(ADVISORY_NEXT), "the notice still leads");
  assert.ok(out.next.includes(PARKED_NEXT));
  assert.ok(!out.next.includes("wakes the affected agents") && !out.next.includes("resumes the mission"), out.next);
});

test("parked tone: no arm wording can leave a restart promise standing", () => {
  const arms = [
    card(`Mesh watchdog detected a runtime failure in dev. ${PAUSED_CLAUSE}`, `Retry or skip. ${RESUMES_AND_WAKES}`),
    card(`Mesh watchdog needs you to decide. ${PAUSED_CLAUSE}`, `Read the context below. ${RESUMES}`),
    card("alice and bob were still talking.", "Tell them the answer."),
    card(`${PAUSED_CLAUSE}`, `${RESUMES}`),
  ];
  for (const arm of arms) {
    for (const advisory of [false, true]) {
      const out = applyParkedTone(applyAdvisoryTone(arm, advisory), true);
      assert.ok(!out.next.includes("resumes the mission"), `still promises a resume: ${out.next}`);
      assert.ok(!out.next.includes("wakes the affected agents"), `still promises a wake: ${out.next}`);
    }
  }
});
