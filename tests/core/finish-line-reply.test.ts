import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, evidenceContent } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * The verdict that brings a mission to the finish line says what still holds it open.
 *
 * The sixteenth cronlite run: at 09:04:22 the pm accepted the last of six criteria. The mission could not complete, because the
 * developer still held the task it had claimed, and the reply to the pm's `mesh_approve` said nothing of it. Four seconds later the
 * pm broadcast MISSION_COMPLETE to the other four seats ("Ready for production"); the unread broadcast woke three of them at
 * 09:08:34, 4 min 8 s on, for turns that did nothing (7.1k, 8.9k and 10.8k tokens). The finish-line note already existed, in the
 * watchdog's nudge to a seat it wakes; the seat whose act brings the mission there is the one that needs it first.
 */

const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "test.execute", "git.commit"], interests: [] },
  { id: "qa", role: "qa", authority: ["quality.pass"], capabilities: ["repository.read", "test.execute", "test.write"], interests: [] },
  { id: "pm", role: "product-manager", authority: ["requirements.accept"], capabilities: ["repository.read", "task.assign"], interests: [] },
];
const IDS = AGENTS.map((a) => a.id);
const LIBRARY = { id: "library-contract-met", description: "the library does what SPEC.md says", mandatory: true };
const CLI = { id: "cli-contract-met", description: "the command line does what SPEC.md says", mandatory: true };
const QUALITY = { id: "quality-verified", description: "QA verified the product", mandatory: true };

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

const turnFor = (agentId: string) =>
  ({ turnId: `t-${agentId}-${Math.random().toString(36).slice(2, 8)}`, agentId, reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] }) as never;
const op = (m: Mesh, as: string, o: Record<string, unknown>) => m.supervisor.executeOp(as, o as unknown as MeshOp, turnFor(as));

const TITLE = "Implementation: library and CLI";

/** A mission with `criteria`, QA's report submitted (the proof an acceptance cites) and, when `claimedBy` is set, that seat holding a task. */
async function mission(criteria: Array<typeof CLI>, claimedBy?: string) {
  const m = await makeMesh({
    agents: AGENTS,
    mayContact: Object.fromEntries(IDS.map((id) => [id, IDS.filter((o) => o !== id)])),
    startup: [],
    criteria,
    mode: "parked",
  } as never);
  let taskId = "";
  if (claimedBy) {
    const task = await op(m, "pm", { op: "create_task", title: TITLE, description: "build it" });
    assert.equal(task.ok, true, JSON.stringify(task));
    taskId = String(task.taskId);
    const claimed = await op(m, claimedBy, { op: "claim_task", taskId });
    assert.equal(claimed.ok, true, `fixture: ${claimedBy} claims the task: ${JSON.stringify(claimed)}`);
  }
  const created = await m.supervisor.createArtifact({ actorId: "qa", name: "QA report", type: "TestReport", content: evidenceContent("QA report") });
  if (!("artifact" in created)) throw new Error(`create failed: ${JSON.stringify(created)}`);
  const moved = await m.supervisor.transitionArtifact("qa", created.artifact.id, { to: "READY_FOR_REVIEW" });
  assert.equal(moved.ok, true, String(moved.reason));
  return { m, taskId, report: created.artifact.id };
}

const status = (m: Mesh): string | undefined => m.kernel.state.goals.get(m.kernel.state.activeGoalId ?? "")?.status;

test("the acceptance that brings the mission to the finish line says which task holds it open, and whose it is", async () => {
  const { m, taskId, report } = await mission([LIBRARY, CLI], "dev");
  try {
    const first = await m.supervisor.recordDecision("pm", "approve", `criterion:${LIBRARY.id}`, report, "SPEC.md shown by QA's report");
    assert.equal(first.ok, true, first.reason);
    assert.equal(first.reason, undefined, "a criterion is still open: the mission is not at the finish line, and nothing is said of it");

    const last = await m.supervisor.recordDecision("pm", "approve", `criterion:${CLI.id}`, report, "SPEC.md shown by QA's report");
    assert.equal(last.ok, true, last.reason);
    assert.equal(
      last.reason,
      `Every mandatory criterion is evidenced; the mission stays open only for a task claimed by dev: "${TITLE}" (${taskId}). Only the claimant can complete it.`,
    );
    assert.equal(status(m), "ACTIVE", "and it really is still open");
  } finally {
    await m.cleanup();
  }
});

test("through mesh_approve the reply is a caveat the seat reads", async () => {
  const { m, taskId, report } = await mission([CLI], "dev");
  try {
    const res = await op(m, "pm", { op: "approve", subject: `criterion:${CLI.id}`, artifactId: report, comment: "SPEC.md shown by QA's report" });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.caveat, true);
    assert.match(res.reason ?? "", new RegExp(`the mission stays open only for a task claimed by dev: "${TITLE}" \\(${taskId}\\)`));
  } finally {
    await m.cleanup();
  }
});

test("the seat that holds the task itself is told it is the one that closes the mission", async () => {
  const { m, taskId, report } = await mission([CLI], "pm");
  try {
    const last = await m.supervisor.recordDecision("pm", "approve", `criterion:${CLI.id}`, report, "SPEC.md shown by QA's report");
    assert.equal(last.ok, true, last.reason);
    assert.match(last.reason ?? "", new RegExp(`the mission stays open only for a task you still hold: "${TITLE}" \\(${taskId}\\)\\. `));
    assert.match(last.reason ?? "", /finish it with `mesh_task_complete` and a summary of what landed: the mission closes when you do\./);
  } finally {
    await m.cleanup();
  }
});

test("a mission nothing holds open completes, and says nothing of a task", async () => {
  const { m, report } = await mission([CLI]);
  try {
    const last = await m.supervisor.recordDecision("pm", "approve", `criterion:${CLI.id}`, report, "SPEC.md shown by QA's report");
    assert.equal(last.ok, true, last.reason);
    assert.ok(!/stays open/.test(last.reason ?? ""), `nothing holds it: ${last.reason}`);
    assert.equal(status(m), "COMPLETED");
  } finally {
    await m.cleanup();
  }
});

test("a verdict given once the mission is already at the finish line does not repeat it", async () => {
  const { m, report } = await mission([CLI], "dev");
  try {
    const last = await m.supervisor.recordDecision("pm", "approve", `criterion:${CLI.id}`, report, "SPEC.md shown by QA's report");
    assert.match(last.reason ?? "", /the mission stays open only for a task claimed by dev/);

    const pass = await m.supervisor.recordDecision("qa", "pass", "quality", report, "31/31");
    assert.equal(pass.ok, true, pass.reason);
    assert.ok(!/stays open/.test(pass.reason ?? ""), `already said once, to the seat whose act it was: ${pass.reason}`);
  } finally {
    await m.cleanup();
  }
});

test("a caveat the verdict already carries is kept, and the finish-line note follows it", async () => {
  // QA holds `quality.pass` and not `quality.approve`: its approve is recorded as the pass it is entitled to, and said (`passNote`).
  // That pass evidences `quality-verified`, the last criterion here, with the developer's task still claimed.
  const { m, taskId, report } = await mission([QUALITY], "dev");
  try {
    const res = await m.supervisor.recordDecision("qa", "approve", "quality", report, "31/31");
    assert.equal(res.ok, true, res.reason);
    // Its own self-approval caveat first (no other seat could review the report), then the pass note, then this one: nothing dropped.
    assert.match(res.reason ?? "", /^no other seat could review this TestReport, .*; recorded as your quality\.pass: /);
    assert.match(res.reason ?? "", new RegExp(`\\(say kind "pass" to give it directly\\); Every mandatory criterion is evidenced; the mission stays open only for a task claimed by dev: "${TITLE}" \\(${taskId}\\)\\.`));
  } finally {
    await m.cleanup();
  }
});
