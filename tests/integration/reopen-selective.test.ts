import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, goalOf, waitFor } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";
import { TerminationManager } from "../../packages/core/src/termination";

/**
 * A reopen withdraws the criteria it NAMES; the rest keep their verdict.
 *
 * `POST /mission/reopen {criteria: [...]}` documents `criteria` as the subset to
 * reopen. The termination rule nevertheless asked EVERY mandatory criterion for
 * evidence recorded after the goal's `reopenedAt`, so the ones the operator had
 * left alone -- EVIDENCED, never withdrawn, holding only the round before -- were
 * "not satisfied" for completion. cronlite, 2026-09-30: reopened on three of
 * seven criteria, the mission sat ACTIVE with 7/7 evidenced, no escalation and an
 * idle scheduler, and the only thing that moved was the stall watchdog telling a
 * seat "the mission will close itself". It would not have.
 *
 * The round a criterion has to be satisfied in is now per criterion
 * (`withdrawnAt`, stamped by the reducer on exactly the ones a reopen resets).
 */

const CRITERIA = [
  { id: "spec", description: "the spec is written", mandatory: true },
  { id: "build", description: "the build is merged", mandatory: true },
  { id: "docs", description: "the docs are published", mandatory: true },
];

async function mesh() {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "qa", role: "qa", capabilities: ["quality.verify"], interests: [] },
    ],
    mayContact: { dev: ["qa"], qa: ["dev"] },
    criteria: CRITERIA,
    mode: "parked",
  });
  for (const id of ["dev", "qa"]) stub(m).setScript(id, async () => ({ operations: [{ op: "done" } as MeshOp] }));
  return m;
}
type Mesh = Awaited<ReturnType<typeof mesh>>;

const inputs = (m: Mesh) => ({ state: m.kernel.state, config: m.config, wallClockMs: 0 }) as never;
const verdict = (m: Mesh) => new TerminationManager().evaluate(inputs(m)).kind;
const crit = (m: Mesh, id: string) => {
  const c = goalOf(m)?.acceptanceCriteria.find((x) => x.id === id);
  if (!c) throw new Error(`criterion ${id} missing`);
  return c;
};
const later = (iso: string, ms = 60_000) => new Date(Date.parse(iso) + ms).toISOString();

async function evidence(m: Mesh, id: string, recordedAt = m.kernel.clock.iso()): Promise<void> {
  await m.supervisor.markCriterionEvidence(id, { kind: "approval", by: "qa", recordedAt });
}

/** The watchdog re-evaluates after every acceptance, so a mission that CAN complete does so by itself. */
const completesByItself = (m: Mesh) => waitFor("the mission completes on its own", () => goalOf(m)?.status === "COMPLETED", 5000);

async function completeIt(m: Mesh): Promise<void> {
  for (const rec of [...m.kernel.state.agents.values()]) {
    if (rec.state.agentId === "human" || rec.state.lifecycle !== "STARTING") continue;
    await m.kernel.emit("agent.started", { agentId: rec.state.agentId }, { actorId: "system" });
  }
  if (goalOf(m)?.status !== "COMPLETED") {
    await m.kernel.emit("goal.completed", { goalId: m.kernel.state.activeGoalId!, reason: "test completion", evidence: [] }, { actorId: "human" });
  }
  await (m.supervisor as unknown as { completeMission(): Promise<void> }).completeMission();
}

/** Satisfy every criterion the reopen minted from its reason, the way a real round would. */
async function answerFeedback(m: Mesh, recordedAt: string): Promise<void> {
  for (const c of goalOf(m)!.acceptanceCriteria) {
    if (c.id.startsWith("operator-feedback-")) await evidence(m, c.id, recordedAt);
  }
}

test("a selective reopen withdraws the named criteria and stamps only those", async () => {
  const m = await mesh();
  try {
    for (const id of ["spec", "build", "docs"]) await evidence(m, id);
    await completeIt(m);
    await m.supervisor.reopenGoal({ reason: "the build is wrong", criteria: ["build"] });

    const goal = goalOf(m)!;
    assert.equal(crit(m, "build").status, "UNSATISFIED");
    assert.equal(crit(m, "build").withdrawnAt, goal.reopenedAt, "the withdrawn criterion's round starts at the reopen");
    for (const id of ["spec", "docs"]) {
      assert.equal(crit(m, id).status, "EVIDENCED", `${id} was not named, so it keeps its verdict`);
      assert.equal(crit(m, id).withdrawnAt, undefined, `${id} is not stamped`);
    }
  } finally {
    await m.cleanup();
  }
});

test("a mission reopened on some criteria completes once THEY are answered; the ones left alone need nothing new", async () => {
  const m = await mesh();
  try {
    for (const id of ["spec", "build", "docs"]) await evidence(m, id);
    await completeIt(m);
    await m.supervisor.reopenGoal({ reason: "the build is wrong", criteria: ["build"] });

    assert.notEqual(verdict(m), "complete", "the withdrawn criterion and the operator's feedback are still open");

    const fresh = later(goalOf(m)!.reopenedAt!);
    await evidence(m, "build", fresh);
    assert.equal(goalOf(m)?.status, "ACTIVE", "the operator's feedback is still unanswered");
    await answerFeedback(m, fresh);
    assert.equal(crit(m, "spec").evidence.every((e) => e.recordedAt < goalOf(m)!.reopenedAt!), true, "fixture: spec holds only the round before the reopen");
    await completesByItself(m);
  } finally {
    await m.cleanup();
  }
});

test("a withdrawn criterion still needs evidence from after the reopen", async () => {
  const m = await mesh();
  try {
    for (const id of ["spec", "build", "docs"]) await evidence(m, id);
    await completeIt(m);
    await m.supervisor.reopenGoal({ reason: "the build is wrong", criteria: ["build"] });
    const reopenedAt = goalOf(m)!.reopenedAt!;

    // Ref-less evidence dated no later than the reopen: the identity gate cannot see it.
    await evidence(m, "build", reopenedAt);
    await answerFeedback(m, later(reopenedAt));
    assert.equal(crit(m, "build").status, "EVIDENCED", "the status flips; the round rule lives in the termination check");
    assert.notEqual(verdict(m), "complete", "the rejected round's evidence does not re-complete the mission");
    assert.equal(goalOf(m)?.status, "ACTIVE");

    await evidence(m, "build", later(reopenedAt));
    await completesByItself(m);
  } finally {
    await m.cleanup();
  }
});

test("a criterion EVIDENCED on the rejected round's evidence alone can be accepted again", async () => {
  // The state above: EVIDENCED, but not satisfying the termination rule. An
  // acceptance that lands on it must be recorded, not skipped as "already done".
  const m = await mesh();
  try {
    for (const id of ["spec", "build", "docs"]) await evidence(m, id);
    await completeIt(m);
    await m.supervisor.reopenGoal({ reason: "the build is wrong", criteria: ["build"] });
    const reopenedAt = goalOf(m)!.reopenedAt!;
    await evidence(m, "build", reopenedAt);
    const before = crit(m, "build").evidence.length;

    const res = await m.supervisor.markCriterionEvidence("build", { kind: "approval", by: "qa", recordedAt: later(reopenedAt) });
    assert.equal(res, "EVIDENCED", "recorded, not SKIPPED");
    assert.equal(crit(m, "build").evidence.length, before + 1);

    // And one that already satisfies the rule is still left alone.
    assert.equal(await m.supervisor.markCriterionEvidence("spec", { kind: "approval", by: "qa", recordedAt: later(reopenedAt) }), "SKIPPED");
  } finally {
    await m.cleanup();
  }
});

test("an ESCALATED mission reopened without naming criteria withdraws nothing", async () => {
  const m = await mesh();
  try {
    await evidence(m, "spec");
    await evidence(m, "docs");
    await m.kernel.emit("goal.escalated", { goalId: m.kernel.state.activeGoalId!, reason: "test escalation", detail: {} }, { actorId: "human" });
    assert.equal(goalOf(m)?.status, "ESCALATED");
    const res = await m.supervisor.reopenGoal({ reason: "carry on" });
    assert.equal(res.ok, true, res.reason ?? "");

    for (const id of ["spec", "docs"]) {
      assert.equal(crit(m, id).status, "EVIDENCED");
      assert.equal(crit(m, id).withdrawnAt, undefined, "an escalation was never a verdict, so nothing was rejected");
    }
    assert.equal(goalOf(m)?.status, "ACTIVE", "build is still open");
    await evidence(m, "build", later(goalOf(m)!.reopenedAt!));
    await completesByItself(m);
  } finally {
    await m.cleanup();
  }
});

test("the stall watchdog's diagnosis names what termination is waiting on, and only that", async () => {
  const m = await mesh();
  try {
    const sup = m.supervisor as unknown as { unmetCriteriaSummary(): string; hasUnmetMandatory(): boolean; wakeValue(): { worth: boolean; why: string } };
    for (const id of ["spec", "build", "docs"]) await evidence(m, id);
    await completeIt(m);
    await m.supervisor.reopenGoal({ reason: "the build is wrong", criteria: ["build"] });

    assert.match(sup.unmetCriteriaSummary(), /unmet \(.*build/, "names the withdrawn criterion");
    assert.doesNotMatch(sup.unmetCriteriaSummary(), /spec|docs/, "and not the ones the operator left alone");
    assert.equal(sup.hasUnmetMandatory(), true);

    // The rejected round's evidence alone: EVIDENCED by status, unmet by the rule.
    // The nudge used to read "all mandatory criteria evidenced ... the mission will
    // close itself" here, which was false.
    const reopenedAt = goalOf(m)!.reopenedAt!;
    await evidence(m, "build", reopenedAt);
    await answerFeedback(m, later(reopenedAt));
    assert.equal(crit(m, "build").status, "EVIDENCED");
    assert.match(sup.unmetCriteriaSummary(), /1 of \d+ mandatory criteria unmet \(build\)/);
    assert.equal(sup.wakeValue().worth, true);

    await evidence(m, "build", later(reopenedAt));
    assert.equal(sup.unmetCriteriaSummary(), "all mandatory criteria evidenced");
    assert.equal(sup.hasUnmetMandatory(), false);
  } finally {
    await m.cleanup();
  }
});
