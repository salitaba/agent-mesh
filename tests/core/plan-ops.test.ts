import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, collectEvents, eventTypes } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

const DEV = { id: "dev", role: "developer", capabilities: ["repository.write", "git.commit"] };
const LEAD = { id: "lead", role: "tech-lead", authority: ["architecture.approve"] };

const planOf = (m: any) => m.kernel.state.agents.get("dev")?.state.plan;

/**
 * Run one scripted turn and wait for THAT turn to finish.
 *
 * Waiting on `lifecycle === "IDLE"` alone is a race on the second and later
 * calls: the agent is already IDLE when the next activation is requested, so
 * the wait returns before the new turn has run and the test asserts against
 * the previous turn's state. Gate on the activation counter instead.
 */
async function runDev(m: any, ops: MeshOp[]) {
  const before = m.kernel.state.agents.get("dev")?.state.activations ?? 0;
  stub(m).setScript("dev", async () => ({ operations: ops }));
  stub(m).resetTurns("dev");
  await m.supervisor.activateAgent("dev", { kind: "manual" });
  await waitFor("dev finished", () => {
    const st = m.kernel.state.agents.get("dev")?.state;
    return st && st.activations > before && st.lifecycle === "IDLE";
  });
}

test("plan ops: a plan lands on the agent's own state and nowhere else", async () => {
  const m = await makeMesh({ agents: [DEV, LEAD] });
  await runDev(m, [
    { op: "plan", steps: [{ text: "read the spec" }, { text: "write the patch", capabilities: ["repository.write"] }] },
    { op: "done" },
  ] as MeshOp[]);
  const plan = planOf(m);
  assert.equal(plan?.steps.length, 2);
  assert.equal(plan?.revision, 1);
  assert.equal(plan?.steps[0]?.status, "PENDING", "a step with no status defaults to PENDING");
  assert.deepEqual(plan?.steps[1]?.capabilities, ["repository.write"]);
  assert.ok(plan?.steps[0]?.id, "the supervisor must resolve an id — a reducer cannot mint one");
  assert.equal(m.kernel.state.agents.get("lead")?.state.plan, undefined, "a plan is private to its agent");
  await m.cleanup();
});

test("plan ops: the agent list carries a scalar projection, never the steps", async () => {
  const m = await makeMesh({ agents: [DEV, LEAD] });
  const rowOf = async (id: string) => (await m.supervisor.status()).agents.find((a: any) => a.id === id) as any;

  assert.equal((await rowOf("dev"))?.planDone, null, "no plan reads as null, so a card can tell 'none' from '0 of 0'");
  assert.equal((await rowOf("dev"))?.planTotal, 0);

  await runDev(m, [
    { op: "plan", steps: [{ text: "read the spec" }, { text: "write the patch" }] },
    { op: "done" },
  ] as MeshOp[]);
  const plan = planOf(m)!;
  assert.equal((await rowOf("dev"))?.planTotal, 2);
  assert.equal((await rowOf("dev"))?.planDone, 0);
  assert.equal((await rowOf("dev"))?.planTaskId, plan.taskId ?? null);
  // The whole point of the projection: this payload is polled for every agent
  // at once, so the growing array must stay on the per-agent detail fetch.
  assert.equal((await rowOf("dev"))?.plan, undefined, "status() must not ship the steps");

  await runDev(m, [{ op: "plan_step", stepId: plan.steps[0]!.id, status: "DONE" }, { op: "done" }] as MeshOp[]);
  assert.equal((await rowOf("dev"))?.planDone, 1, "progress is recomputed per call, not cached on the row");
  await m.cleanup();
});

test("plan ops: ids are stable across a restated plan, so plan_step keeps resolving", async () => {
  const m = await makeMesh({ agents: [DEV, LEAD] });
  await runDev(m, [{ op: "plan", steps: [{ text: "write the patch" }] }, { op: "done" }] as MeshOp[]);
  const first = planOf(m)!.steps[0]!.id;
  await runDev(m, [{ op: "plan", steps: [{ text: "write the patch" }, { text: "run the tests" }] }, { op: "done" }] as MeshOp[]);
  assert.equal(planOf(m)!.steps[0]!.id, first, "identical step text must hash to the same id");
  assert.equal(planOf(m)!.revision, 2);
  await m.cleanup();
});

test("plan ops: re-planning does not silently un-complete finished steps", async () => {
  const m = await makeMesh({ agents: [DEV, LEAD] });
  await runDev(m, [{ op: "plan", steps: [{ text: "step one" }, { text: "step two" }] }, { op: "done" }] as MeshOp[]);
  const one = planOf(m)!.steps[0]!.id;
  await runDev(m, [{ op: "plan_step", stepId: one, status: "DONE" }, { op: "done" }] as MeshOp[]);
  assert.equal(planOf(m)!.steps[0]!.status, "DONE");
  // Adding a third step must not reset the first two.
  await runDev(m, [
    { op: "plan", steps: [{ text: "step one" }, { text: "step two" }, { text: "step three" }] },
    { op: "done" },
  ] as MeshOp[]);
  assert.equal(planOf(m)!.steps[0]!.status, "DONE", "carried-forward progress is what makes re-planning safe");
  assert.equal(planOf(m)!.steps[2]!.status, "PENDING");
  await m.cleanup();
});

test("plan ops: duplicate step text still yields addressable ids", async () => {
  const m = await makeMesh({ agents: [DEV, LEAD] });
  await runDev(m, [{ op: "plan", steps: [{ text: "run tests" }, { text: "run tests" }] }, { op: "done" }] as MeshOp[]);
  const ids = planOf(m)!.steps.map((s: any) => s.id);
  assert.equal(new Set(ids).size, 2, "a suffixed duplicate beats dropping the second step");
  await m.cleanup();
});

test("plan ops: an empty plan retracts the plan rather than leaving a husk", async () => {
  const m = await makeMesh({ agents: [DEV, LEAD] });
  await runDev(m, [{ op: "plan", steps: [{ text: "a" }] }, { op: "done" }] as MeshOp[]);
  assert.ok(planOf(m));
  await runDev(m, [{ op: "plan", steps: [] }, { op: "done" }] as MeshOp[]);
  assert.equal(planOf(m), undefined);
  await m.cleanup();
});

test("plan ops: plan_step against an unknown step is rejected and emits nothing", async () => {
  const m = await makeMesh({ agents: [DEV, LEAD] });
  await runDev(m, [{ op: "plan", steps: [{ text: "a" }] }, { op: "done" }] as MeshOp[]);
  const before = planOf(m)!.revision;
  await runDev(m, [{ op: "plan_step", stepId: "nope", status: "DONE" }, { op: "done" }] as MeshOp[]);
  assert.equal(planOf(m)!.revision, before, "a rejected step flip must not bump the revision");
  await m.cleanup();
});

test("plan gate: enforce refuses the hard op and abandons the rest of the turn", async () => {
  const m = await makeMesh({
    agents: [{ ...DEV, hardActions: { mode: "enforce", capabilities: ["repository.write"] } }, LEAD],
  });
  await runDev(m, [
    { op: "publish_artifact", name: "patch", type: "CodePatch", content: "a".repeat(400) },
    { op: "remember", key: "k", value: "v" },
    { op: "done" },
  ] as MeshOp[]);
  assert.equal(m.kernel.state.artifacts.size, 0, "the gated publish must not land");
  const types = eventTypes(await collectEvents(m));
  assert.ok(types.includes("plan.gate_rejected"), "the refusal has to be on the log for the operator to see");
  assert.ok(
    !m.kernel.state.memory.get("dev")?.has("k"),
    "ops after a gate rejection were written assuming the plan existed; running them just cascades",
  );
  await m.cleanup();
});

test("plan gate: planning first lets the same turn go through", async () => {
  const m = await makeMesh({
    agents: [{ ...DEV, hardActions: { mode: "enforce", capabilities: ["repository.write"] } }, LEAD],
  });
  await runDev(m, [
    { op: "plan", steps: [{ text: "publish the patch", capabilities: ["repository.write"] }] },
    { op: "publish_artifact", name: "patch", type: "CodePatch", content: "a".repeat(400) },
    { op: "done" },
  ] as MeshOp[]);
  assert.equal(m.kernel.state.artifacts.size, 1, "plan-then-act in one turn is the documented recovery");
  await m.cleanup();
});

test("plan gate: warn lets the op through but still records the near-miss", async () => {
  const m = await makeMesh({
    agents: [{ ...DEV, hardActions: { mode: "warn", capabilities: ["repository.write"] } }, LEAD],
  });
  await runDev(m, [
    { op: "publish_artifact", name: "patch", type: "CodePatch", content: "a".repeat(400) },
    { op: "done" },
  ] as MeshOp[]);
  assert.equal(m.kernel.state.artifacts.size, 1, "warn must not block — that is the whole point of the mode");
  assert.ok(
    eventTypes(await collectEvents(m)).includes("plan.gate_rejected"),
    "warn exists so an operator can see what enforce WOULD have blocked",
  );
  await m.cleanup();
});

test("plan gate: off is a complete no-op — the default mesh is unchanged", async () => {
  const m = await makeMesh({ agents: [DEV, LEAD] });
  await runDev(m, [
    { op: "publish_artifact", name: "patch", type: "CodePatch", content: "a".repeat(400) },
    { op: "done" },
  ] as MeshOp[]);
  assert.equal(m.kernel.state.artifacts.size, 1);
  assert.deepEqual(eventTypes(await collectEvents(m)).filter((t) => t.startsWith("plan.")), []);
  await m.cleanup();
});
