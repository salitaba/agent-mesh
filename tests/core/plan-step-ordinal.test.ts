import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * A plan's step is addressed by its number as well as its id.
 *
 * A step's id is one the plan gave it, and a seat that writes `mesh_plan` without ids is never told
 * them: the op answers ok and nothing else, and the briefing that lists them is built at the start
 * of a turn. The name such a seat reaches for is the step's place in its own list. All seven calls
 * the fifth cronlite run's developer made to mark its seven steps done were `stepId: "1"` to `"7"`,
 * and each was refused with a list of hashes it could not match to anything.
 *
 * An id that matches always wins, so a plan that numbers its own steps is addressed exactly as it
 * wrote them.
 */

const turnFor = (agentId: string) =>
  ({ turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`, agentId, reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] }) as never;

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

async function planned(steps: Array<{ text: string; id?: string }>): Promise<Mesh> {
  const m = await makeMesh({ agents: [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] }], mode: "parked" });
  const res = await m.supervisor.executeOp("dev", { op: "plan", steps } as MeshOp, turnFor("dev"));
  assert.equal(res.ok, true, res.reason ?? "");
  return m;
}

const plan = (m: Mesh) => m.kernel.state.agents.get("dev")!.state.plan!;
const flip = (m: Mesh, stepId: unknown, status: "DONE" | "PENDING" = "DONE") =>
  m.supervisor.executeOp("dev", { op: "plan_step", stepId, status } as MeshOp, turnFor("dev"));
const statuses = (m: Mesh) => plan(m).steps.map((s) => s.status);

test("a step is marked by its number, counted from one", async () => {
  const m = await planned([{ text: "read the spec" }, { text: "write the parser" }, { text: "run the tests" }]);
  try {
    assert.equal((await flip(m, "2")).ok, true);
    assert.deepEqual(statuses(m), ["PENDING", "DONE", "PENDING"]);
    assert.equal((await flip(m, "1")).ok, true);
    assert.equal((await flip(m, "3")).ok, true);
    assert.deepEqual(statuses(m), ["DONE", "DONE", "DONE"]);
    assert.equal((await flip(m, "2", "PENDING")).ok, true, "and reopened the same way");
    assert.deepEqual(statuses(m), ["DONE", "PENDING", "DONE"]);
  } finally {
    await m.cleanup();
  }
});

test("a number that arrives as a number, or with spaces, is the same number", async () => {
  const m = await planned([{ text: "one" }, { text: "two" }]);
  try {
    assert.equal((await flip(m, 2)).ok, true, "a model's JSON often types it as a number");
    assert.equal((await flip(m, " 1 ")).ok, true);
    assert.deepEqual(statuses(m), ["DONE", "DONE"]);
  } finally {
    await m.cleanup();
  }
});

test("the id the plan gave a step still works, and beats a number that happens to match it", async () => {
  // The plan numbers its own steps, in the opposite order to their places: "1" is the SECOND step.
  const m = await planned([{ id: "2", text: "first in the list" }, { id: "1", text: "second in the list" }]);
  try {
    assert.equal((await flip(m, "1")).ok, true);
    assert.deepEqual(statuses(m), ["PENDING", "DONE"], "the step whose id is 1, not the first step");
    assert.equal((await flip(m, plan(m).steps[0]!.id)).ok, true);
    assert.deepEqual(statuses(m), ["DONE", "DONE"]);
  } finally {
    await m.cleanup();
  }
});

test("a number past the end, zero, and words are refused, with the steps listed by number, id and text", async () => {
  const m = await planned([{ text: "read the spec" }, { text: "write the parser" }]);
  try {
    const before = plan(m).revision;
    for (const bad of ["3", "0", "-1", "1.5", "two", "", "01"]) {
      const res = await flip(m, bad);
      assert.equal(res.ok, false, `'${bad}'`);
      assert.match(res.reason ?? "", /^unknown step '.*': name a step by its number or its id \(have: 1\) \S+ — read the spec; 2\) \S+ — write the parser\)$/, res.reason);
    }
    assert.equal(plan(m).revision, before, "a refused flip emits nothing");
    assert.deepEqual(statuses(m), ["PENDING", "PENDING"]);
  } finally {
    await m.cleanup();
  }
});

test("a long step is shortened in the listing, and no plan at all is still said", async () => {
  const m = await planned([{ text: "x".repeat(120) }]);
  try {
    const res = await flip(m, "9");
    assert.match(res.reason ?? "", /1\) \S+ — x{57}\.\.\.\)$/);
  } finally {
    await m.cleanup();
  }
  const empty = await makeMesh({ agents: [{ id: "dev", role: "developer", interests: [] }], mode: "parked" });
  try {
    const res = await empty.supervisor.executeOp("dev", { op: "plan_step", stepId: "1", status: "DONE" } as MeshOp, turnFor("dev"));
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /no plan yet/);
  } finally {
    await empty.cleanup();
  }
});
