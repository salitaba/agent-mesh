import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, collectEvents } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * What a delegated task tells the seat that has to do it, and what happens when
 * three seats file the same work.
 *
 * Live evidence for the first half: an architect published nine tasks and
 * assigned each in the same op, and every DELEGATE it sent carried a payload of
 * exactly `{taskId}`. The recipient got an opaque handle and no instruction —
 * it had to go and look the task up to learn what it had been asked to do, and
 * it could not see the capabilities the task demanded until it tried to claim
 * it and was refused. The `delegate` op already sent the richer shape; the path
 * a seat actually uses to create work and name an owner in one op did not.
 *
 * Live evidence for the second: three seats independently opened a task for the
 * same work within three minutes — same title, three task ids, two never
 * claimed, and the work was built twice.
 */

const AGENTS = [
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "task.assign"], interests: [] },
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "test.execute"], interests: [] },
];

const COMM = { lead: ["dev"], dev: ["lead"] };

const turnFor = (agentId: string) =>
  ({
    turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`,
    agentId,
    reason: { kind: "manual" as const },
    sentOps: 0,
    publishedOps: 0,
    waitRequested: false,
    escalated: false,
    results: [],
  }) as never;

function mesh() {
  return makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" } as never);
}

test("a task assigned in the creating op arrives with its title, description and required capabilities", async () => {
  const m = await mesh();
  try {
    const res = await m.supervisor.executeOp(
      "lead",
      {
        op: "create_task",
        title: "wire the resolver",
        description: "one pure function, no IO, explainable output",
        assignedTo: "dev",
        requiredCapabilities: ["repository.write"],
      } as MeshOp,
      turnFor("lead"),
    );
    assert.equal(res.ok, true, res.reason);

    const delegate = [...m.kernel.state.messages.values()].find((x) => x.type === "DELEGATE");
    assert.ok(delegate, "assigning a task must actually send the DELEGATE");
    const p = delegate.payload as Record<string, unknown>;

    assert.equal(p.taskId, res.taskId, "the id is still there — it is what claim_task takes");
    assert.equal(p.title, "wire the resolver", "the recipient should not have to look up what it was asked to do");
    assert.match(String(p.description), /no IO/, "and the description is the instruction");
    assert.deepEqual(
      p.requiredCapabilities,
      ["repository.write"],
      "the demanded capabilities ride along, so a seat can tell it may act BEFORE trying and being refused",
    );
  } finally {
    await m.cleanup();
  }
});

test("the delegate op carries required capabilities too", async () => {
  const m = await mesh();
  try {
    const res = await m.supervisor.executeOp(
      "lead",
      { op: "delegate", to: "dev", title: "build the thing", description: "the whole thing", requiredCapabilities: ["test.execute"] } as MeshOp,
      turnFor("lead"),
    );
    assert.equal(res.ok, true, res.reason);
    const delegate = [...m.kernel.state.messages.values()].find((x) => x.type === "DELEGATE");
    assert.deepEqual((delegate?.payload as Record<string, unknown>).requiredCapabilities, ["test.execute"]);
  } finally {
    await m.cleanup();
  }
});

test("a second open task with the same title is refused, naming the one already on the board", async () => {
  const m = await mesh();
  try {
    const first = await m.supervisor.executeOp(
      "lead",
      { op: "create_task", title: "T3.1 ui flows + Playwright e2e", description: "flows" } as MeshOp,
      turnFor("lead"),
    );
    assert.equal(first.ok, true, first.reason);

    const second = await m.supervisor.executeOp(
      "lead",
      { op: "create_task", title: "t3.1  UI flows + playwright e2e", description: "the same work, filed again" } as MeshOp,
      turnFor("lead"),
    );
    assert.equal(second.ok, false, "the same work must not go on the board twice");
    assert.match(second.reason ?? "", new RegExp(first.taskId!), "the refusal names the task to claim instead");
    assert.equal(m.kernel.state.tasks.size, 1, "and nothing was filed");
  } finally {
    await m.cleanup();
  }
});

test("delegate applies the same screen, so the duplicate is not handed out either", async () => {
  const m = await mesh();
  try {
    const first = await m.supervisor.executeOp(
      "lead",
      { op: "create_task", title: "ship the slice", description: "..." } as MeshOp,
      turnFor("lead"),
    );
    assert.equal(first.ok, true, first.reason);

    const dup = await m.supervisor.executeOp(
      "lead",
      { op: "delegate", to: "dev", title: "ship the slice", description: "same work" } as MeshOp,
      turnFor("lead"),
    );
    assert.equal(dup.ok, false, "delegating a duplicate is the same defect one step later");
    assert.match(dup.reason ?? "", new RegExp(first.taskId!));
    assert.equal(m.kernel.state.tasks.size, 1);
  } finally {
    await m.cleanup();
  }
});

test("re-filing work that was completed or cancelled is allowed", async () => {
  const m = await mesh();
  try {
    const first = await m.supervisor.executeOp(
      "lead",
      { op: "create_task", title: "redo the migration", description: "..." } as MeshOp,
      turnFor("lead"),
    );
    assert.equal(first.ok, true, first.reason);
    assert.equal((await m.supervisor.claimTask("dev", first.taskId!)).ok, true);
    const done = await m.supervisor.completeTask("dev", first.taskId!, "did it");
    assert.equal(done.ok, true, done.reason);

    const again = await m.supervisor.executeOp(
      "lead",
      { op: "create_task", title: "redo the migration", description: "the first attempt was wrong" } as MeshOp,
      turnFor("lead"),
    );
    assert.equal(again.ok, true, `finished work may legitimately be re-filed: ${again.reason ?? ""}`);
  } finally {
    await m.cleanup();
  }
});
