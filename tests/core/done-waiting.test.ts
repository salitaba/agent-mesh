import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import { makeMesh, stub, waitFor } from "../helpers";
import { newTurnEffectTally, turnMadeSomething, type TurnEffectTally } from "../../packages/core/src/turn-tracker";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * `mesh_done` completes the task its seat holds, and a seat that has said it is waiting and has made nothing is ending its turn,
 * not its task.
 *
 * In every cronlite run from the eighth to the sixteenth, QA's first turn claimed its verification task, called `mesh_wait` and
 * ended with `mesh_done`, and the task read COMPLETED for the rest of the run, with a summary that says it is standing by: "Implementation
 * not yet available - developer is working on it. Standing by" (the sixteenth: claimed 08:47:56, completed 08:48:17, with the
 * tool descriptions of the fifteenth cycle's fix and a section of the role prompt saying not to). Wording had not held. In the thirteen
 * runs before it, 15 of the 31 tasks completed by `mesh_done` were completed by a turn that waited and had landed no artifact, commit, merge,
 * review request, verdict, task or decision while a mandatory criterion was unmet; 13 were QA's, one a tech lead's whose merge had been refused.
 * The 10 that waited and made something were work finished and awaiting review, and 6 did not wait.
 *
 * So a `done` in a turn that waited and made nothing completes nothing while the mission is unfinished, and says so; the next `done`
 * completes the task as before, and at the finish line (every mandatory criterion evidenced) it completes it as it always did.
 */

const AGENTS = [
  { id: "pm", role: "product-manager", capabilities: ["repository.read", "task.assign"], interests: [] },
  { id: "qa", role: "qa", capabilities: ["repository.read", "test.execute", "test.write"], interests: [] },
];
const COMM = { pm: ["qa"], qa: ["pm"] };
const UNMET = { id: "quality-verified", description: "QA verified the product", mandatory: true };
const OPTIONAL = { id: "notes", description: "notes", mandatory: false };

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

/** A turn the way the runner keeps it, with the tally its subscription would have built. */
function turnFor(agentId: string, landed: TurnEffectTally | null = newTurnEffectTally()) {
  return { turnId: `t-${agentId}-${Math.random().toString(36).slice(2, 8)}`, agentId, reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [], ...(landed ? { landed } : {}) };
}
const run = (m: Mesh, as: string, o: Record<string, unknown>, turn: ReturnType<typeof turnFor>) => m.supervisor.executeOp(as, o as unknown as MeshOp, turn as never);

async function fixture(criteria: Array<{ id: string; description: string; mandatory?: boolean }> = [UNMET]) {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", criteria } as never);
  const created = await run(m, "pm", { op: "create_task", title: "QA: verify the implementation", description: "verify it against the spec" }, turnFor("pm"));
  assert.equal(created.ok, true, JSON.stringify(created));
  return { m, taskId: String(created.taskId) };
}
const status = (m: Mesh, taskId: string) => m.kernel.state.tasks.get(taskId)?.status;

/** QA's first turn as it happened in nine runs: claim, wait, done. */
async function claimWaitDone(m: Mesh, taskId: string, turn = turnFor("qa")) {
  assert.equal((await run(m, "qa", { op: "claim_task", taskId }, turn)).ok, true);
  assert.equal((await run(m, "qa", { op: "wait" }, turn)).ok, true);
  return run(m, "qa", { op: "done", summary: "Implementation not yet available - developer is working on it. Standing by." }, turn);
}

test("a done in a turn that claimed, waited and made nothing completes nothing, and says why", async () => {
  const { m, taskId } = await fixture();
  try {
    const done = await claimWaitDone(m, taskId);
    assert.equal(done.ok, true, "the turn still ends");
    assert.equal(done.caveat, true, "and the reply is a caveat on how it went");
    assert.match(done.reason ?? "", new RegExp(`^task ${taskId} stays claimed by you: this turn waited and made nothing \\(no artifact, commit, review, verdict or task\\), so ending it is not finishing the task\\.`));
    assert.match(done.reason ?? "", /Complete it \(mesh_task_complete, or the mesh_done that ends a turn in which the work was done\) when its work exists\./);
    assert.equal(status(m, taskId), "CLAIMED", "the task stays where it was");
    assert.equal(m.kernel.state.agents.get("qa")?.state.activeTaskId, taskId, "and QA still holds it");
  } finally {
    await m.cleanup();
  }
});

test("the audit log records a done that completed nothing, so the operator can see why a task is still claimed", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", criteria: [UNMET], persist: true } as never);
  try {
    const created = await run(m, "pm", { op: "create_task", title: "QA: verify the implementation", description: "verify it against the spec" }, turnFor("pm"));
    const taskId = String(created.taskId);
    await claimWaitDone(m, taskId);
    const auditFile = (m.supervisor as unknown as { deps: { auditFile?: string } }).deps.auditFile!;
    const lines = fs.readFileSync(auditFile, "utf8").split("\n").filter((l) => l.includes("did not complete"));
    assert.equal(lines.length, 1, lines.join("\n"));
    assert.match(lines[0]!, new RegExp(`qa's done did not complete ${taskId}: the turn waited and made nothing, and the mission is not finished`));
  } finally {
    await m.cleanup();
  }
});

test("what a seat says, holds or raises is not making something", async () => {
  const { m, taskId } = await fixture();
  try {
    const talked = newTurnEffectTally();
    talked.messages = 3;
    talked.tasksClaimed = 1;
    talked.escalations = 1;
    assert.equal(turnMadeSomething(talked), false, "messages, claims and escalations are not work");
    const done = await claimWaitDone(m, taskId, turnFor("qa", talked));
    assert.equal(done.caveat, true);
    assert.equal(status(m, taskId), "CLAIMED");
  } finally {
    await m.cleanup();
  }
});

for (const [field, what] of [
  ["published", "an artifact published"],
  ["versioned", "an artifact versioned"],
  ["commits", "a commit"],
  ["merges", "a merge"],
  ["reviewRequests", "a review requested"],
  ["verdicts", "a verdict"],
  ["tasksCreated", "a task filed"],
  ["decisions", "a decision proposed"],
] as const) {
  test(`a turn that waited and made ${what} is the work, finished: its done completes the task`, async () => {
    const { m, taskId } = await fixture();
    try {
      const landed = newTurnEffectTally();
      landed[field] = 1;
      assert.equal(turnMadeSomething(landed), true, field);
      const done = await claimWaitDone(m, taskId, turnFor("qa", landed));
      assert.equal(done.caveat, undefined, "no caveat: it completed");
      assert.equal(status(m, taskId), "COMPLETED");
    } finally {
      await m.cleanup();
    }
  });
}

test("a done in a turn that did not wait completes the task, as before", async () => {
  const { m, taskId } = await fixture();
  try {
    const turn = turnFor("qa");
    assert.equal((await run(m, "qa", { op: "claim_task", taskId }, turn)).ok, true);
    const done = await run(m, "qa", { op: "done", summary: "Answered the question the task asked." }, turn);
    assert.equal(done.caveat, undefined);
    assert.equal(status(m, taskId), "COMPLETED");
  } finally {
    await m.cleanup();
  }
});

test("the next turn's done completes the task: a seat is not held to a claim it cannot finish", async () => {
  const { m, taskId } = await fixture();
  try {
    assert.equal((await claimWaitDone(m, taskId)).caveat, true);
    assert.equal(status(m, taskId), "CLAIMED");
    const next = turnFor("qa");
    const done = await run(m, "qa", { op: "done", summary: "Verified: 128 tests pass, the CLI behaves as the spec says." }, next);
    assert.equal(done.caveat, undefined);
    assert.equal(status(m, taskId), "COMPLETED");
    const completed = (await m.kernel.store.read({ types: ["task.completed"] })).filter((e) => (e.payload as { taskId?: string }).taskId === taskId);
    assert.equal(completed.length, 1, "completed once, and not by the first turn");
    assert.equal((completed[0]!.payload as { summary?: string }).summary, "Verified: 128 tests pass, the CLI behaves as the spec says.", "with the summary of the turn that did the work");
  } finally {
    await m.cleanup();
  }
});

test("once nothing is left unmet, a done after a wait closes the claim, as the finish-line nudge asks", async () => {
  const { m, taskId } = await fixture([OPTIONAL]);
  try {
    const done = await claimWaitDone(m, taskId);
    assert.equal(done.caveat, undefined);
    assert.equal(status(m, taskId), "COMPLETED", "every mandatory criterion is evidenced (there is none), so nothing is left to wait for");
  } finally {
    await m.cleanup();
  }
});

test("an op run outside a turn has no tally, and completes as before", async () => {
  const { m, taskId } = await fixture();
  try {
    const turn = turnFor("qa", null);
    assert.equal("landed" in turn, false, "the fixture: no tally");
    const done = await claimWaitDone(m, taskId, turn);
    assert.equal(done.caveat, undefined);
    assert.equal(status(m, taskId), "COMPLETED");
  } finally {
    await m.cleanup();
  }
});

test("a handover's done never completes a task, with or without a wait", async () => {
  const { m, taskId } = await fixture([OPTIONAL]);
  try {
    assert.equal((await run(m, "qa", { op: "claim_task", taskId }, turnFor("qa"))).ok, true);
    const handover = { ...turnFor("qa"), handover: true };
    const done = await run(m, "qa", { op: "done", summary: "continuity written" }, handover);
    assert.equal(done.caveat, undefined);
    assert.equal(status(m, taskId), "CLAIMED");
  } finally {
    await m.cleanup();
  }
});

test("through the turn runner: QA's claim, wait and done leaves the task claimed, and the same turn with a report published completes it", async () => {
  const { m, taskId } = await fixture();
  try {
    let ops: MeshOp[] = [];
    stub(m).setScript("qa", async () => ({ operations: ops }));
    const turn = async () => {
      await m.supervisor.activateAgent("qa", { kind: "manual" }, { explicit: true });
      await waitFor("qa's turn to finish", () => m.scheduler.pending() === 0 && m.scheduler.running() === 0);
    };

    ops = [{ op: "claim_task", taskId }, { op: "wait" }, { op: "done", summary: "Standing by for the implementation." }] as MeshOp[];
    await turn();
    assert.equal(status(m, taskId), "CLAIMED", "the claim, the wait and the done: nothing was made");
    assert.equal(m.kernel.state.agents.get("qa")?.state.activeTaskId, taskId);

    ops = [
      { op: "publish_artifact", name: "QA report", type: "TestReport", content: "128 tests pass; the CLI behaves as the spec says." },
      { op: "wait" },
      { op: "done", summary: "Verified." },
    ] as MeshOp[];
    await turn();
    assert.equal(status(m, taskId), "COMPLETED", "a report published, then a wait and a done: the turn made something");
  } finally {
    await m.cleanup();
  }
});
