import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor } from "../helpers";
import { readableMailDepth } from "../../packages/core/src/state";
import { liveClaims } from "../../packages/core/src/termination";
import type { WorkspacePort } from "../../packages/core/src/ports";
import type { ActivationReason, MeshOp } from "../../packages/protocol/src/index";

/**
 * The stall watchdog wakes the claimant of a task that is all that keeps a finished mission open, soon, and says so.
 *
 * The thirteenth cronlite run evidenced its last criterion at 20:56:00. The mission could not complete: the developer
 * still held the task it had claimed (a task completes by its claimant's own `mesh_task_complete`, and the tech lead's try
 * at 20:55:31 was refused, "task claimed by developer"). Nothing woke the developer until 20:57:17, and that was the
 * unread-mail sweep, not the watchdog: the watchdog's cooldown ran from the pm's nudge at 20:55:47, which had brought the
 * mission to the finish line, so its next nudge was due at 21:00:47, with the full 180 s idle window as well; and its driver
 * would have been "the first seat in config order with mail or a claimed task", the architect, which had an unread
 * broadcast and nothing to close. The goal completed 86 s after the criterion, 8k tokens after the one turn that was
 * needed, by luck. A claimant with no unread mail would have kept the mission open until the wall-clock budget.
 *
 * Driven the way `stall-open-rejection.test.ts` does it: explicit `checkStall()` calls with the gates poked, so what is
 * asserted is the DECISION and never a sleep.
 */

// `qa` first: the roster's first seat, and the one with unread mail, is what the old driver chose, so a driver that is NOT
// `qa` was chosen on purpose.
const AGENTS = [
  { id: "qa", role: "qa", authority: ["quality.pass"], capabilities: ["repository.read", "test.execute", "test.write"], interests: [] },
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "test.execute", "git.commit"], interests: [] },
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review", "git.merge"], authority: ["implementation.approve"], interests: [] },
];
const IDS = AGENTS.map((a) => a.id);
const MERGED = { id: "implementation-merged", description: "the implementation is merged", mandatory: true };
const OPEN = { id: "quality-verified", description: "QA verified the product", mandatory: true };

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

interface StallInternals {
  checkStall(): Promise<void>;
  finishLineClaims(): Array<{ id: string }>;
  stallDriver(): string | undefined;
  stallWakeNote(driver?: string): string;
  finishLineReachedAt(): number;
  lastTurnAt: number;
  lastStallNudgeAt: number;
  lastStallDriver: string | undefined;
  stallNudgeStreak: number;
}
const internals = (m: Mesh): StallInternals => m.supervisor as unknown as StallInternals;
const idle = (m: Mesh, what: string) => waitFor(what, () => m.scheduler.pending() === 0 && m.scheduler.running() === 0);

const turnFor = (agentId: string) =>
  ({ turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`, agentId, reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] }) as never;
const op = (m: Mesh, as: string, o: Record<string, unknown>) => m.supervisor.executeOp(as, o as unknown as MeshOp, turnFor(as));

const landing = (): WorkspacePort => {
  const unused = (name: string) => async (): Promise<never> => {
    throw new Error(`workspace double: ${name} is not part of this fixture`);
  };
  return {
    mainPath: "/nonexistent/product",
    ensureRepo: unused("ensureRepo"),
    ensureWorktree: async (agentId: string) => `/nonexistent/worktrees/${agentId}`,
    commitWorktree: unused("commitWorktree"),
    mergeWorktree: async () => ({ commit: "0123456789abcdef0123456789abcdef01234567" }),
    removeWorktree: unused("removeWorktree"),
    async worktreeState() {
      return null;
    },
  };
};

/**
 * The mission as the thirteenth run left it at 20:56:00: the library merged (so `implementation-merged` is evidenced),
 * the developer holding the task it claimed, and `qa`, first in the roster, with an unread message. With `extra` criteria
 * the mission is not finished: one of them is still open.
 */
async function finishedExceptForTheClaim(criteria: Array<typeof MERGED> = [MERGED]) {
  const m = await makeMesh({
    agents: AGENTS,
    mayContact: Object.fromEntries(IDS.map((id) => [id, IDS.filter((o) => o !== id)])),
    startup: [],
    criteria,
    mode: "parked",
    stallIdleMs: 60_000,
    stallCooldownMs: 300_000,
    stallNoopRetryMs: 600_000,
  } as never);
  (m.supervisor as unknown as { deps: { workspace?: WorkspacePort } }).deps.workspace = landing();
  const nudges: Array<{ agent: string; note: string }> = [];
  for (const id of IDS) {
    stub(m).setScript(id, async (input) => {
      const reason: ActivationReason = input.activation;
      if (reason.kind === "timer" && String(reason.note).startsWith("stall watchdog:")) nudges.push({ agent: id, note: String(reason.note) });
      return { operations: [{ op: "wait" } as MeshOp] };
    });
  }
  // The claim comes first: the moment the library merges, the one criterion is evidenced and a mission with nothing owned completes.
  const task = await op(m, "lead", { op: "create_task", title: "Implementation: library and CLI", description: "build it" });
  const claim = await op(m, "dev", { op: "claim_task", taskId: task.taskId });
  assert.equal(claim.ok, true, `fixture: the developer claims the task: ${JSON.stringify(claim)} (create: ${JSON.stringify(task)})`);
  assert.equal((await op(m, "lead", { op: "send", type: "INFORM", to: ["qa"], newThread: { subject: "FYI" }, payload: { note: "nothing for you to do" } })).ok, true);
  const created = await m.supervisor.createArtifact({ actorId: "dev", name: "library", type: "CodePatch", content: "the whole of the library, at length" });
  if (!("artifact" in created)) throw new Error(`create failed: ${JSON.stringify(created)}`);
  const library = created.artifact.id;
  assert.equal((await m.supervisor.transitionArtifact("dev", library, { to: "READY_FOR_REVIEW" })).ok, true);
  await op(m, "dev", { op: "request_review", artifactId: library, reviewers: ["lead"] });
  assert.equal((await op(m, "lead", { op: "approve", subject: "implementation", artifactId: library })).ok, true);
  assert.equal((await m.supervisor.transitionArtifact("lead", library, { to: "VERIFIED" })).ok, true);
  assert.equal((await m.supervisor.transitionArtifact("lead", library, { to: "MERGEABLE" })).ok, true);
  assert.equal((await op(m, "lead", { op: "merge", artifactId: library })).ok, true);
  const goal = m.kernel.state.goals.get(m.kernel.state.activeGoalId ?? "");
  assert.equal(goal?.acceptanceCriteria.find((c) => c.id === MERGED.id)?.status, "EVIDENCED", "fixture: the merge evidenced implementation-merged");
  assert.ok(readableMailDepth(m.kernel.state, "qa") > 0, "fixture: qa has unread mail, so the old driver would have been qa");
  return { m, nudges, taskId: String(task.taskId) };
}

/** The mission has been quiet for `quietMs` and the last nudge was `sinceNudgeMs` ago (never, when undefined). */
const settle = (m: Mesh, quietMs: number, sinceNudgeMs?: number): void => {
  internals(m).lastTurnAt = Date.now() - quietMs;
  internals(m).lastStallNudgeAt = sinceNudgeMs === undefined ? 0 : Date.now() - sinceNudgeMs;
};

test("the watchdog wakes the claimant, not the first seat with mail, and says that finishing the task closes the mission", async () => {
  const { m, nudges, taskId } = await finishedExceptForTheClaim();
  try {
    await m.goLive();
    await idle(m, "go-live to settle");
    settle(m, 10 * 60_000);
    await internals(m).checkStall();
    await waitFor("the nudge", () => nudges.length === 1);
    await idle(m, "the nudged turn");

    assert.equal(nudges[0]!.agent, "dev", "the claimant; `qa` is first in the roster and has mail, and is what the fallback picks");
    const note = nudges[0]!.note;
    assert.match(note, /all mandatory criteria evidenced/, "the summary is still there, and honest: nothing is unmet");
    assert.match(note, new RegExp(`the mission stays open only for a task you still hold: "Implementation: library and CLI" \\(${taskId}\\)`));
    assert.match(note, /finish it with `mesh_task_complete` and a summary of what landed: the mission closes when you do/);
    assert.match(note, /Do NOT re-approve or re-confirm finished work/);
    assert.doesNotMatch(note, /reply with a single `done` op/, "not the generic note, which tells a seat to stop");
  } finally {
    await m.cleanup();
  }
});

test("to a seat that does not hold the claim the note says whose act it is", async () => {
  const { m, taskId } = await finishedExceptForTheClaim();
  try {
    const note = internals(m).stallWakeNote("qa");
    assert.match(note, new RegExp(`the mission stays open only for a task claimed by dev: "Implementation: library and CLI" \\(${taskId}\\)\\. Only the claimant can complete it\\.`));
    assert.doesNotMatch(note, /you still hold/);
  } finally {
    await m.cleanup();
  }
});

test("a finished mission is nudged after a twelfth of the idle window, not the whole of it", async () => {
  const { m, nudges } = await finishedExceptForTheClaim();
  try {
    await m.goLive();
    await idle(m, "go-live to settle");
    // 20 s of quiet: past the grace (60 s / 12 = 5 s), well short of the 60 s window.
    settle(m, 20_000);
    await internals(m).checkStall();
    await waitFor("the nudge", () => nudges.length === 1);
    assert.equal(nudges[0]!.agent, "dev");
  } finally {
    await m.cleanup();
  }
});

test("a mission that is not finished keeps the whole window: the same quiet, a criterion still open, no nudge", async () => {
  const { m, nudges } = await finishedExceptForTheClaim([MERGED, OPEN]);
  try {
    await m.goLive();
    await idle(m, "go-live to settle");
    settle(m, 20_000);
    await internals(m).checkStall();
    await idle(m, "nothing to settle");
    assert.equal(nudges.length, 0, "20 s into a 60 s window");
    assert.equal(internals(m).stallDriver(), "qa", "and the driver is the old one: the first seat with mail or a claim");
    assert.doesNotMatch(internals(m).stallWakeNote("dev"), /you still hold|Only the claimant/, "no finish-line sentence on a mission that has a criterion open");
  } finally {
    await m.cleanup();
  }
});

test("a nudge sent before the mission reached the finish line does not hold back the first one after it", async () => {
  const { m, nudges } = await finishedExceptForTheClaim();
  try {
    await m.goLive();
    await idle(m, "go-live to settle");
    // The pm's nudge a minute ago, inside the 300 s cooldown, before the merge that finished the mission.
    assert.ok(internals(m).finishLineReachedAt() > Date.now() - 60_000, "fixture: the finish line was reached in the last minute");
    settle(m, 20_000, 120_000);
    assert.ok(internals(m).lastStallNudgeAt < internals(m).finishLineReachedAt(), "fixture: the last nudge predates the finish line");
    await internals(m).checkStall();
    await waitFor("the nudge", () => nudges.length === 1);
    assert.equal(nudges[0]!.agent, "dev");
  } finally {
    await m.cleanup();
  }
});

test("a nudge sent after the finish line is held by the cooldown as before, so a claimant that does nothing is not woken in a loop", async () => {
  const { m, nudges } = await finishedExceptForTheClaim();
  try {
    await m.goLive();
    await idle(m, "go-live to settle");
    settle(m, 20_000, 0);
    internals(m).lastStallNudgeAt = Date.now() + 1; // after the finish line, inside the cooldown
    await internals(m).checkStall();
    await idle(m, "nothing to settle");
    assert.equal(nudges.length, 0, "inside the cooldown, and the nudge it counts was about this very state");
  } finally {
    await m.cleanup();
  }
});

test("a claimant whose last nudge bought nothing gives the next to another seat", async () => {
  const { m } = await finishedExceptForTheClaim();
  try {
    assert.equal(internals(m).stallDriver(), "dev", "first, the claimant");
    internals(m).lastStallDriver = "dev";
    internals(m).stallNudgeStreak = 1;
    assert.equal(internals(m).stallDriver(), "qa", "then the seat with mail, so the claimant is not nudged in a loop before the cap");
  } finally {
    await m.cleanup();
  }
});

test("a claim its owner has moved on from is residue, as it is to the verdict: only the task the owner still points at is named", async () => {
  const { m, taskId } = await finishedExceptForTheClaim();
  try {
    const second = await op(m, "lead", { op: "create_task", title: "Second task", description: "more" });
    assert.equal((await op(m, "dev", { op: "claim_task", taskId: second.taskId })).ok, true);
    // The developer now points at the second task; the first is still CLAIMED by dev but nobody holds it.
    assert.equal(m.kernel.state.tasks.get(taskId)?.status, "CLAIMED", "fixture: the first claim is still on the record");
    assert.deepEqual(liveClaims(m.kernel.state).map((t) => t.id), [String(second.taskId)], "the verdict's own predicate");
    const note = internals(m).stallWakeNote("dev");
    assert.match(note, /"Second task"/);
    assert.doesNotMatch(note, /Implementation: library and CLI/, "the abandoned claim is not what holds the mission open");
  } finally {
    await m.cleanup();
  }
});

test("an open escalation or a rejected patch is a different state: the claim is not the finish line while either is open", async () => {
  const { m } = await finishedExceptForTheClaim();
  try {
    assert.equal(internals(m).finishLineClaims().length, 1, "fixture: the claim is the finish line");
    // A rejected patch nobody has closed out: the owner's move, with its own nudge, window and note.
    const created = await m.supervisor.createArtifact({ actorId: "dev", name: "cli", type: "CodePatch", content: "the whole of the cli, at length" });
    if (!("artifact" in created)) throw new Error(`create failed: ${JSON.stringify(created)}`);
    assert.equal((await m.supervisor.transitionArtifact("dev", created.artifact.id, { to: "READY_FOR_REVIEW" })).ok, true);
    await op(m, "dev", { op: "request_review", artifactId: created.artifact.id, reviewers: ["lead"] });
    assert.equal((await op(m, "lead", { op: "reject", subject: "implementation", artifactId: created.artifact.id, comment: "duplicates the library patch" })).ok, true);
    assert.equal(m.kernel.state.artifacts.get(created.artifact.id)?.status, "REJECTED", "fixture: the patch is REJECTED");
    assert.equal(internals(m).finishLineClaims().length, 0, "a rejected patch is open");
    assert.doesNotMatch(internals(m).stallWakeNote("dev"), /the mission stays open only for a task/, "and the note is the rejection's");
  } finally {
    await m.cleanup();
  }
});

test("an open escalation is not the finish line either", async () => {
  const { m } = await finishedExceptForTheClaim();
  try {
    assert.equal(internals(m).finishLineClaims().length, 1, "fixture: the claim is the finish line");
    await m.supervisor.escalate({ reason: "conflict", raisedBy: "lead", conflictKey: "finish-line-test", detail: { note: "a question for the operator" } });
    assert.ok([...m.kernel.state.escalations.values()].some((e) => e.status === "OPEN"), "fixture: an escalation is open");
    assert.equal(internals(m).finishLineClaims().length, 0, "an open escalation is the operator's to answer");
  } finally {
    await m.cleanup();
  }
});
