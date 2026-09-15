import { test } from "node:test";
import assert from "node:assert/strict";
import { collectEvents, makeMesh } from "../helpers";

/**
 * The four executors behind the dashboard assistant's staged mutations:
 * `reviseGoalDescription`, `reviseCriterion`, `removeCriterion`, `retireAgent`.
 *
 * These are the first writers of goal + criteria state that are not the boot
 * path, and the first way capacity leaves a live mesh. The interesting tests
 * here are the refusals, not the happy paths — an editor for the acceptance
 * criteria is an editor for the definition of "done", and the guard that says
 * no is the entire reason it is safe to expose one.
 */

const DEV = { id: "dev", role: "developer", capabilities: [], interests: [] };
const OPS = { id: "ops", role: "operator", capabilities: [], interests: [] };

const goalOf = (m: any) => (m.kernel.state.activeGoalId ? m.kernel.state.goals.get(m.kernel.state.activeGoalId) : undefined);
const progressOf = (m: any) => m.kernel.state.progress.get(m.kernel.state.activeGoalId ?? "");
const critOf = (m: any, id: string) => goalOf(m)?.acceptanceCriteria.find((c: any) => c.id === id);
const lifecycleOf = (m: any, id: string) => m.kernel.state.agents.get(id)?.state.lifecycle;
const eventsOf = async (m: any, type: string) => (await collectEvents(m)).filter((e: any) => e.type === type);

const TWO = [
  { id: "c1", description: "the API is documented", mandatory: true },
  { id: "c2", description: "the tests pass", mandatory: true },
];

const base = { agents: [DEV], mode: "parked" as const, goal: "Build a payment API." };

/**
 * Drive a criterion to EVIDENCED through the event path rather than by mutating
 * the projection, so the guards under test see the same state a real run would
 * produce.
 */
async function satisfy(m: any, criterionId: string) {
  await m.kernel.emit(
    "requirement.satisfied",
    {
      criterionId,
      verified: true,
      evidence: { kind: "criteria-acceptance", verified: true, by: "dev", recordedAt: new Date().toISOString() },
    },
    { actorId: "dev", goalId: m.kernel.state.activeGoalId },
  );
}

test("goal.description_revised replaces the mission statement and records what it replaced", async () => {
  const m = await makeMesh({ ...base, criteria: TWO });

  const res = await m.supervisor.reviseGoalDescription("Build a payment API with refunds.", { reason: "scope grew" });
  assert.equal(res.ok, true);
  assert.equal(res.previous, "Build a payment API.", "the caller is told what it displaced");
  assert.equal(goalOf(m)?.description, "Build a payment API with refunds.", "the reducer applied the replacement");

  // The audit trail is the point of routing this through an event at all: the
  // goal record only ever holds the latest text.
  const revisions = await eventsOf(m, "goal.description_revised");
  assert.equal(revisions.length, 1);
  assert.equal((revisions[0] as any).payload.previous, "Build a payment API.");
  assert.equal((revisions[0] as any).payload.reason, "scope grew");

  assert.equal((await m.supervisor.reviseGoalDescription("   ")).ok, false, "blank is not a mission");
  assert.equal(
    (await m.supervisor.reviseGoalDescription("Build a payment API with refunds.")).ok,
    false,
    "a no-op rewrite should not land an event that says the target moved",
  );
  await m.cleanup();
});

test("requirement.revised edits a criterion in place", async () => {
  const m = await makeMesh({ ...base, criteria: TWO });

  const res = await m.supervisor.reviseCriterion("c2", { description: "the tests pass on CI" }, { reason: "be specific" });
  assert.equal(res.ok, true);
  assert.equal(critOf(m, "c2")?.description, "the tests pass on CI");
  assert.equal(critOf(m, "c2")?.status, "UNSATISFIED", "editing the text must not disturb the verdict");

  const evt: any = (await eventsOf(m, "requirement.revised")).at(-1);
  assert.equal(evt.payload.previous.description, "the tests pass");

  assert.equal((await m.supervisor.reviseCriterion("nope", { description: "x" })).ok, false, "unknown criterion");
  assert.equal((await m.supervisor.reviseCriterion("c2", {})).ok, false, "an empty patch is not an edit");
  await m.cleanup();
});

test("promoting and demoting a criterion moves the progress denominator", async () => {
  const m = await makeMesh({
    ...base,
    criteria: [
      { id: "c1", description: "the API is documented", mandatory: true },
      { id: "c2", description: "the tests pass", mandatory: true },
      { id: "c3", description: "a nice-to-have", mandatory: false },
    ],
  });
  assert.equal(progressOf(m)?.total, 2, "optional criteria are not counted");

  assert.equal((await m.supervisor.reviseCriterion("c3", { mandatory: true })).ok, true);
  assert.equal(progressOf(m)?.total, 3, "promotion widens the denominator");

  assert.equal((await m.supervisor.reviseCriterion("c3", { mandatory: false })).ok, true);
  assert.equal(progressOf(m)?.total, 2, "demotion narrows it again");
  await m.cleanup();
});

test("a criterion can be removed while real work is still outstanding", async () => {
  const m = await makeMesh({
    ...base,
    criteria: [...TWO, { id: "c3", description: "perf budget met", mandatory: true }],
  });
  assert.equal(progressOf(m)?.total, 3);

  const res = await m.supervisor.removeCriterion("c3", { reason: "folded into c2" });
  assert.equal(res.ok, true);
  assert.equal(goalOf(m)?.acceptanceCriteria.length, 2);
  assert.equal(critOf(m, "c3"), undefined);
  assert.equal(progressOf(m)?.total, 2, "the denominator shrank with it");

  // After the splice this event is the only record the criterion existed.
  const evt: any = (await eventsOf(m, "requirement.removed")).at(-1);
  assert.equal(evt.payload.removed.description, "perf budget met");
  assert.equal(evt.payload.reason, "folded into c2");

  assert.equal((await m.supervisor.removeCriterion("c3", { reason: "again" })).ok, false, "already gone");
  assert.equal((await m.supervisor.removeCriterion("c2", { reason: "  " })).ok, false, "a removal needs a stated reason");
  await m.cleanup();
});

/**
 * The guard this whole surface lives or dies on.
 *
 * Completion is "every mandatory criterion is satisfied", so deleting the last
 * UNSATISFIED one does not shrink the checklist — it makes the remainder
 * vacuously complete, and the next watchdog tick emits `goal.completed` on a
 * mission where nothing was finished.
 */
test("removeCriterion cannot complete a goal", async () => {
  const m = await makeMesh({ ...base, criteria: TWO });
  await satisfy(m, "c1");
  assert.equal(progressOf(m)?.completed, 1, "one down, one to go");

  const res = await m.supervisor.removeCriterion("c2", { reason: "we decided not to test" });
  assert.equal(res.ok, false);
  assert.match(res.reason ?? "", /without the work being done/);

  assert.equal(goalOf(m)?.acceptanceCriteria.length, 2, "the refusal is not partial — nothing was removed");
  assert.equal((await eventsOf(m, "requirement.removed")).length, 0, "a refused removal must not reach the log");
  assert.notEqual(goalOf(m)?.status, "COMPLETED");

  // The same hole through the other door: demotion drops it out of the
  // mandatory set, which moves the denominator exactly as a deletion would.
  const demote = await m.supervisor.reviseCriterion("c2", { mandatory: false });
  assert.equal(demote.ok, false, "demotion cannot be the way around the removal guard");
  assert.match(demote.reason ?? "", /would complete the mission/);

  // ...but removing the SATISFIED one is fine: it leaves real work outstanding.
  assert.equal((await m.supervisor.removeCriterion("c1", { reason: "docs moved out of scope" })).ok, true);
  await m.cleanup();
});

test("removeCriterion refuses to empty the mandatory set", async () => {
  const m = await makeMesh({ ...base, criteria: [{ id: "c1", description: "the only thing that matters", mandatory: true }] });

  // Note this is NOT caught by the completion guard: an empty mandatory set is
  // never "complete" (`mandatory.length > 0` fails), so without its own refusal
  // this would land and leave a mission that can never be judged either way.
  const res = await m.supervisor.removeCriterion("c1", { reason: "clearing the decks" });
  assert.equal(res.ok, false);
  assert.match(res.reason ?? "", /last mandatory criterion/);
  assert.equal(goalOf(m)?.acceptanceCriteria.length, 1);
  await m.cleanup();
});

test("retireAgent is terminal and takes the seat out of selection", async () => {
  const m = await makeMesh({ agents: [DEV, OPS], mode: "live", goal: "Build a payment API.", criteria: TWO });

  assert.equal((await m.supervisor.retireAgent("dev", { reason: "  " })).ok, false, "retirement needs a stated reason");
  assert.equal((await m.supervisor.retireAgent("nobody", { reason: "x" })).ok, false, "unknown agent");
  assert.equal((await m.supervisor.retireAgent("human", { reason: "x" })).ok, false, "the operator's own seat is not retirable");

  const res = await m.supervisor.retireAgent("dev", { reason: "duplicate seat" });
  assert.equal(res.ok, true);
  assert.equal(lifecycleOf(m, "dev"), "RETIRED");

  const act = await m.supervisor.activateAgent("dev", { kind: "manual" });
  assert.equal(act.queued, false, "a retired seat is never scheduled");
  assert.match(act.blocked ?? "", /retired/);

  // Terminal means terminal. `resumeAgent` must refuse BEFORE emitting:
  // RETIRED has no outgoing edges, so an `agent.resumed` written here would
  // throw in the reducer on every replay from now on.
  await m.supervisor.resumeAgent("dev");
  assert.equal(lifecycleOf(m, "dev"), "RETIRED", "resume must not revive a retired seat");
  await m.supervisor.suspendAgent("dev");
  assert.equal(lifecycleOf(m, "dev"), "RETIRED", "nor may suspend move it");
  const lifecycleEvents = [...(await eventsOf(m, "agent.resumed")), ...(await eventsOf(m, "agent.suspended"))];
  assert.equal(lifecycleEvents.length, 0, "neither call may leave an unreplayable event behind");

  assert.equal((await m.supervisor.retireAgent("dev", { reason: "again" })).ok, false, "already retired");
  assert.notEqual(lifecycleOf(m, "ops"), "RETIRED", "the other seat is untouched");
  await m.cleanup();
});
