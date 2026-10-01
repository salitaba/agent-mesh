import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor } from "../helpers";
import type { WorkspacePort } from "../../packages/core/src/ports";
import type { ActivationReason, MeshOp } from "../../packages/protocol/src/index";

/**
 * The stall watchdog wakes the owner of a rejected patch, and says which.
 *
 * The mission does not complete over a patch a reviewer rejected and nobody closed out (see
 * `open-rejections.test.ts`), so it sits quiet with every criterion evidenced and a patch REJECTED.
 * The seat that can move it is its owner (REJECTED -> DRAFT is the owner's, and a reviewer's approval
 * of a rejected patch moves nothing), and nothing had told that seat: the sixth cronlite run's
 * tech-lead announced the rejection to everyone, and an announcement wakes no one who did not
 * subscribe to announcements. The watchdog is the floor under that, and the old note for a mission with
 * nothing unmet ("reply with a single `done` op and stop - the mission will close itself") would have
 * been false, and the seat that took it at its word would have stopped.
 *
 * Driven the way `stall-acceptor.test.ts` does it: explicit `checkStall()` calls with the gates
 * poked open, so what is asserted is the DECISION and never a sleep.
 */

// `qa` first: the roster's first seat is what the old fallbacks ended on, so a driver that is NOT
// `qa` was chosen on purpose.
const AGENTS = [
  { id: "qa", role: "qa", authority: ["quality.pass"], capabilities: ["repository.read", "test.execute", "test.write"], interests: [] },
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "test.execute", "git.commit"], interests: [] },
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review", "git.merge"], authority: ["implementation.approve"], interests: [] },
];
const IDS = AGENTS.map((a) => a.id);
const CRITERIA = [{ id: "implementation-merged", description: "every patch is merged", mandatory: true }];

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

interface StallInternals {
  checkStall(): Promise<void>;
  lastTurnAt: number;
  lastStallNudgeAt: number;
}
const internals = (m: Mesh): StallInternals => m.supervisor as unknown as StallInternals;
const goQuiet = (m: Mesh): void => void (internals(m).lastTurnAt = Date.now() - 10 * 60_000);
const clearCooldown = (m: Mesh): void => void (internals(m).lastStallNudgeAt = Date.now() - 10 * 60_000);
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
    // A seat that writes gets its worktree at the start of a turn, and the nudged developer takes one.
    ensureWorktree: async (agentId: string) => `/nonexistent/worktrees/${agentId}`,
    commitWorktree: unused("commitWorktree"),
    mergeWorktree: async () => ({ commit: "0123456789abcdef0123456789abcdef01234567" }),
    removeWorktree: unused("removeWorktree"),
    async worktreeState() {
      return null;
    },
  };
};

/** The library merged, the CLI REJECTED: the mission as the sixth run left it. Every criterion is evidenced (unless `criteria` adds one). */
async function libraryMergedCliRejected(criteria: typeof CRITERIA = CRITERIA) {
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
  const publish = async (name: string): Promise<string> => {
    const created = await m.supervisor.createArtifact({ actorId: "dev", name, type: "CodePatch", content: `the whole of ${name}, at length` });
    if (!("artifact" in created)) throw new Error(`create failed: ${JSON.stringify(created)}`);
    assert.equal((await m.supervisor.transitionArtifact("dev", created.artifact.id, { to: "READY_FOR_REVIEW" })).ok, true);
    await op(m, "dev", { op: "request_review", artifactId: created.artifact.id, reviewers: ["lead"] });
    return created.artifact.id;
  };
  const library = await publish("library");
  assert.equal((await op(m, "lead", { op: "approve", subject: "implementation", artifactId: library })).ok, true);
  assert.equal((await m.supervisor.transitionArtifact("lead", library, { to: "VERIFIED" })).ok, true);
  assert.equal((await m.supervisor.transitionArtifact("lead", library, { to: "MERGEABLE" })).ok, true);
  const cli = await publish("cli");
  assert.equal((await op(m, "lead", { op: "reject", subject: "implementation", artifactId: cli, comment: "duplicates the library patch" })).ok, true);
  assert.equal((await op(m, "lead", { op: "merge", artifactId: library })).ok, true);
  assert.equal(m.kernel.state.artifacts.get(cli)?.status, "REJECTED", "fixture: the CLI is REJECTED");
  assert.equal(m.kernel.state.goals.get(m.kernel.state.activeGoalId ?? "")?.acceptanceCriteria[0]?.status, "EVIDENCED", "fixture: the merge evidenced implementation-merged");
  return { m, nudges, cli };
}

async function tick(m: Mesh, nudges: unknown[], expected: number): Promise<void> {
  goQuiet(m);
  clearCooldown(m);
  await internals(m).checkStall();
  await waitFor(`stall nudge ${expected}`, () => nudges.length === expected);
  await idle(m, `nudged turn ${expected}`);
}

test("the watchdog wakes the owner of the rejected patch, and the note names the patch and the owner's move, not 'the mission will close itself'", async () => {
  const { m, nudges } = await libraryMergedCliRejected();
  try {
    await m.goLive();
    await idle(m, "go-live to settle");
    await tick(m, nudges, 1);

    assert.equal(nudges[0]!.agent, "dev", "the seat that can resubmit it, not `qa`, the first in the roster");
    assert.match(nudges[0]!.note, /all mandatory criteria evidenced/, "the summary is still there, and honest: nothing is unmet");
    assert.match(nudges[0]!.note, /The mission cannot complete while a rejected patch is left open: CodePatch "cli" is REJECTED \(owner dev\): dev reworks it \(a new version with asVersionOf, then a review request\) or, if it is abandoned, moves it to DRAFT and then to ARCHIVED\./);
    assert.match(nudges[0]!.note, /Do NOT re-approve or re-confirm finished work/);
    assert.doesNotMatch(nudges[0]!.note, /the mission will close itself/, "it will not, and a seat told so stops");
  } finally {
    await m.cleanup();
  }
});

test("a nudge that bought nothing is not repeated at the same seat: the next one goes elsewhere", async () => {
  const { m, nudges } = await libraryMergedCliRejected();
  try {
    await m.goLive();
    await idle(m, "go-live to settle");
    await tick(m, nudges, 1);
    await tick(m, nudges, 2);

    assert.equal(nudges[0]!.agent, "dev");
    assert.notEqual(nudges[1]!.agent, "dev", "the owner was just told; hammering it is how the roster's first seat used to be picked for ever");
    assert.match(nudges[1]!.note, /The mission cannot complete while a rejected patch is left open: CodePatch "cli" is REJECTED/, "whoever is woken is still told why");
  } finally {
    await m.cleanup();
  }
});

test("a mission with a rejected patch left open is worth waking someone for, and the reason is named", async () => {
  const { m, nudges, cli } = await libraryMergedCliRejected();
  try {
    await m.goLive();
    await idle(m, "go-live to settle");
    const wake = (m.supervisor as unknown as { wakeValue(): { worth: boolean; why: string } }).wakeValue();
    assert.equal(wake.worth, true);
    assert.match(wake.why, /1 rejected patch\(es\) left open \(cli is REJECTED\)/);

    // The owner closes it out; the patch is no longer the reason (mail or something else may still be).
    assert.equal((await m.supervisor.transitionArtifact("dev", cli, { to: "DRAFT" })).ok, true);
    assert.equal((await m.supervisor.transitionArtifact("dev", cli, { to: "ARCHIVED" })).ok, true);
    const closed = (m.supervisor as unknown as { wakeValue(): { worth: boolean; why: string } }).wakeValue();
    assert.doesNotMatch(closed.why, /rejected patch/);
    assert.equal(nudges.length, 0, "nothing was nudged in the meantime");
  } finally {
    await m.cleanup();
  }
});

test("three nudges that bought nothing hand the mission to a human, and the card says which patch is open", async () => {
  const { m, nudges } = await libraryMergedCliRejected();
  try {
    await m.goLive();
    await idle(m, "go-live to settle");
    await tick(m, nudges, 1);
    await tick(m, nudges, 2);
    await tick(m, nudges, 3);

    goQuiet(m);
    clearCooldown(m);
    await internals(m).checkStall();
    const card = [...m.kernel.state.escalations.values()].find((e) => e.reason === "stalemate:stall_nudge_cap");
    assert.ok(card, "the cap raised its card");
    const detail = card.detail as { openRejections?: string; actionable?: string };
    assert.match(String(detail.openRejections), /The mission cannot complete while a rejected patch is left open: CodePatch "cli" is REJECTED \(owner dev\)/);
    assert.match(String(detail.actionable), /rejected patch\(es\) left open/);
  } finally {
    await m.cleanup();
  }
});

test("only a patch waiting on its owner is the owner's move: back in review, it is the reviewers' and the merger's", async () => {
  const { m, cli } = await libraryMergedCliRejected();
  try {
    await m.goLive();
    await idle(m, "go-live to settle");
    const owners = () => (m.supervisor as unknown as { rejectionOwners(): string[] }).rejectionOwners();
    assert.deepEqual(owners(), ["dev"], "REJECTED: the owner reworks or withdraws it");

    assert.equal((await m.supervisor.transitionArtifact("dev", cli, { to: "DRAFT" })).ok, true);
    assert.deepEqual(owners(), ["dev"], "reworked and not resubmitted: still the owner's");

    assert.equal((await m.supervisor.transitionArtifact("dev", cli, { to: "READY_FOR_REVIEW" })).ok, true);
    assert.deepEqual(owners(), [], "resubmitted: waiting on its review, which is not the owner's to give");
    const note = (m.supervisor as unknown as { openRejectionNote(): string }).openRejectionNote();
    assert.match(note, /CodePatch "cli" is READY_FOR_REVIEW \(owner dev\): it was rejected before, and waits on its review again/, "but it still holds the mission, and the note says why");
  } finally {
    await m.cleanup();
  }
});

test("with another criterion still unmet, the note carries both: the criteria, the rejected patch, and the instruction that follows", async () => {
  const { m, nudges } = await libraryMergedCliRejected([...CRITERIA, { id: "docs-written", description: "the docs are written", mandatory: true }]);
  try {
    await m.goLive();
    await idle(m, "go-live to settle");
    await tick(m, nudges, 1);

    assert.equal(nudges[0]!.agent, "dev", "the rejected patch's owner is still the first driver");
    assert.match(nudges[0]!.note, /1 of 2 mandatory criteria unmet \(docs-written\)/);
    assert.match(nudges[0]!.note, /The mission cannot complete while a rejected patch is left open: CodePatch "cli" is REJECTED \(owner dev\)/, "the rejection is named beside the unmet criterion, not instead of it");
    assert.match(nudges[0]!.note, /Then drive the next step toward an unmet criterion/);
  } finally {
    await m.cleanup();
  }
});
