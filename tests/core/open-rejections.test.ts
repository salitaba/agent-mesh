import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { openRejections } from "../../packages/core/src/projections";
import { TerminationManager } from "../../packages/core/src/termination";
import type { WorkspacePort } from "../../packages/core/src/ports";
import type { Artifact, MeshOp } from "../../packages/protocol/src/index";

/**
 * A mission does not complete over a patch the reviewers rejected and nobody has closed out.
 *
 * The sixth cronlite run's developer submitted the library and the CLI as two patches. The tech-lead
 * rejected the CLI twice (it repeated the approved library's `src/index.js` and `package.json`) and
 * merged the library; `implementation-merged` closed on that merge. The tech-lead then approved the
 * CLI patch, which moved nothing (a REJECTED patch goes to DRAFT only, and that edge is its owner's);
 * the rejection woke no one (the broadcast that said so wakes nobody), and the pm accepted
 * `cli-contract-met` on a QA report whose first lines read "CLI Commit: cd6615a (pending merge)". The
 * mission completed with no `bin/cronlite.js` on the product branch.
 *
 * Now the termination verdict is not `complete` while a CodePatch of the goal that was rejected has
 * neither landed nor been withdrawn: REJECTED, reworked to DRAFT, resubmitted, approved, parked on the
 * ladder. The evidence is untouched (the merge still evidences `implementation-merged`); the merger is
 * told in the op result; the stall watchdog wakes the patch's owner
 * (`tests/integration/stall-open-rejection.test.ts`). The mission completes when the patch has been
 * merged, or its owner has withdrawn it.
 *
 * What is NOT held open is as deliberate: a patch that was never rejected, in whatever state. Those are
 * in flight with seats moving them, and the sixth run's second round ended with one that could never land
 * (its work had gone in with another patch, and the merge was refused as "nothing landed"): a mission
 * that is otherwise done must not wait on it.
 *
 * Each test asserts the GOAL's status, not only the verdict: the supervisor completes the goal itself
 * as soon as the verdict says so, and `evaluate` answers `continue` for a goal that is already COMPLETED.
 */

const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "test.execute"], interests: [] },
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review", "git.merge"], authority: ["implementation.approve"], interests: [] },
];
const COMM = { dev: ["lead"], lead: ["dev"] };
const CRITERIA = [{ id: "implementation-merged", description: "every patch is merged", mandatory: true }];

type MergeResult = Awaited<ReturnType<WorkspacePort["mergeWorktree"]>>;

const landing = (): WorkspacePort => {
  const unused = (name: string) => async (): Promise<never> => {
    throw new Error(`workspace double: ${name} is not part of this fixture`);
  };
  let n = 0;
  return {
    mainPath: "/nonexistent/product",
    ensureRepo: unused("ensureRepo"),
    ensureWorktree: unused("ensureWorktree"),
    commitWorktree: unused("commitWorktree"),
    mergeWorktree: async (): Promise<MergeResult> => ({ commit: `${(++n).toString(16).padStart(2, "0")}23456789abcdef0123456789abcdef01234567` }),
    removeWorktree: unused("removeWorktree"),
    async worktreeState() {
      return null;
    },
  };
};

const turnFor = (agentId: string) =>
  ({ turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`, agentId, reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] }) as never;

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

async function fixture(): Promise<Mesh> {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", criteria: CRITERIA } as never);
  (m.supervisor as unknown as { deps: { workspace?: WorkspacePort } }).deps.workspace = landing();
  return m;
}

const op = (m: Mesh, as: string, o: Record<string, unknown>) => m.supervisor.executeOp(as, o as unknown as MeshOp, turnFor(as));
const status = (m: Mesh, id: string) => m.kernel.state.artifacts.get(id)?.status;
const criterion = (m: Mesh) => m.kernel.state.goals.get(m.kernel.state.activeGoalId ?? "")?.acceptanceCriteria.find((c) => c.id === "implementation-merged")?.status;
const goalStatus = (m: Mesh) => m.kernel.state.goals.get(m.kernel.state.activeGoalId ?? "")?.status;
const verdict = (m: Mesh) => new TerminationManager().evaluate({ state: m.kernel.state, config: m.config, wallClockMs: 1000 });
/** The supervisor's own pass: it evaluates the verdict and completes the goal. It runs on events (at most once a second) and on the watchdog's timer; the tests run it by hand. */
const settle = (m: Mesh) => (m.supervisor as unknown as { watchdog(): Promise<void> }).watchdog();

async function patch(m: Mesh, name: string): Promise<string> {
  const created = await m.supervisor.createArtifact({ actorId: "dev", name, type: "CodePatch", content: `the whole of ${name}, at length` });
  if (!("artifact" in created)) throw new Error(`create failed: ${JSON.stringify(created)}`);
  return created.artifact.id;
}

/** Submitted, reviewed and approved: `id` is UNDER_REVIEW -> APPROVED. */
async function approved(m: Mesh, id: string): Promise<void> {
  assert.equal((await m.supervisor.transitionArtifact("dev", id, { to: "READY_FOR_REVIEW" })).ok, true);
  await op(m, "dev", { op: "request_review", artifactId: id, reviewers: ["lead"] });
  assert.equal((await op(m, "lead", { op: "approve", subject: "implementation", artifactId: id })).ok, true);
  assert.equal(status(m, id), "APPROVED", "fixture: approved");
}

async function mergeable(m: Mesh, name: string): Promise<string> {
  const id = await patch(m, name);
  await approved(m, id);
  assert.equal((await m.supervisor.transitionArtifact("lead", id, { to: "VERIFIED" })).ok, true);
  assert.equal((await m.supervisor.transitionArtifact("lead", id, { to: "MERGEABLE" })).ok, true);
  return id;
}

/** Submitted and rejected: `id` is REJECTED, waiting on its owner. */
async function rejected(m: Mesh, name: string): Promise<string> {
  const id = await patch(m, name);
  assert.equal((await m.supervisor.transitionArtifact("dev", id, { to: "READY_FOR_REVIEW" })).ok, true);
  await op(m, "dev", { op: "request_review", artifactId: id, reviewers: ["lead"] });
  assert.equal((await op(m, "lead", { op: "reject", subject: "implementation", artifactId: id, comment: "duplicates the library patch" })).ok, true);
  assert.equal(status(m, id), "REJECTED", "fixture: rejected");
  return id;
}

// ---------------------------------------------------------------- the rule

test("a merge that leaves a rejected patch open evidences the criterion, does not complete the mission, and says why", async () => {
  const m = await fixture();
  try {
    const library = await mergeable(m, "library");
    await rejected(m, "cli");

    const res = await op(m, "lead", { op: "merge", artifactId: library });
    assert.equal(res.ok, true, res.reason);
    await settle(m);
    assert.equal(status(m, library), "MERGED", "the patch itself landed");
    assert.equal(criterion(m), "EVIDENCED", "the evidence is the merge's, and is not taken back");
    assert.equal(goalStatus(m), "ACTIVE", "but the mission does not complete over a patch the reviewers rejected");
    assert.equal(verdict(m).kind, "continue");
    assert.equal(res.caveat, true, "the merger is told in a note, not left to infer it");
    assert.match(res.reason ?? "", /the mission cannot complete yet, because CodePatch "cli" is REJECTED \(owner dev\): dev reworks it \(a new version with asVersionOf, then a review request\) or, if it is abandoned, moves it to DRAFT and then to ARCHIVED/);
  } finally {
    await m.cleanup();
  }
});

test("the control: a merge with nothing rejected completes the mission, as before", async () => {
  const m = await fixture();
  try {
    const library = await mergeable(m, "library");
    const res = await op(m, "lead", { op: "merge", artifactId: library });
    assert.equal(res.ok, true, res.reason);
    await settle(m);
    assert.equal(criterion(m), "EVIDENCED");
    assert.equal(goalStatus(m), "COMPLETED");
    assert.doesNotMatch(res.reason ?? "", /cannot complete/);
  } finally {
    await m.cleanup();
  }
});

test("a reworked patch still holds the mission while it is in review and on the ladder, and the mission completes when it lands", async () => {
  const m = await fixture();
  try {
    const library = await mergeable(m, "library");
    const cli = await rejected(m, "cli");
    assert.equal((await op(m, "lead", { op: "merge", artifactId: library })).ok, true);
    await settle(m);
    assert.equal(goalStatus(m), "ACTIVE");

    // Reworked and put forward again, the way its owner would.
    assert.equal((await m.supervisor.transitionArtifact("dev", cli, { to: "DRAFT" })).ok, true);
    await settle(m);
    assert.equal(goalStatus(m), "ACTIVE", "a rework in progress is still a rejected patch nobody has closed out");
    await approved(m, cli);
    await settle(m);
    assert.equal(goalStatus(m), "ACTIVE", "resubmitted and approved is not landed: a rework that is never merged would let the mission complete the way the sixth run did, one step later");
    assert.equal((await m.supervisor.transitionArtifact("lead", cli, { to: "VERIFIED" })).ok, true);
    assert.equal((await m.supervisor.transitionArtifact("lead", cli, { to: "MERGEABLE" })).ok, true);
    await settle(m);
    assert.equal(goalStatus(m), "ACTIVE", "parked on the ladder is not landed either");
    const last = await op(m, "lead", { op: "merge", artifactId: cli });
    assert.equal(last.ok, true, last.reason);
    await settle(m);
    assert.equal(goalStatus(m), "COMPLETED");
    assert.doesNotMatch(last.reason ?? "", /cannot complete/);
  } finally {
    await m.cleanup();
  }
});

test("the mission completes when the owner withdraws the rejected patch: REJECTED goes to DRAFT, then to ARCHIVED", async () => {
  const m = await fixture();
  try {
    const library = await mergeable(m, "library");
    const cli = await rejected(m, "cli");
    assert.equal((await op(m, "lead", { op: "merge", artifactId: library })).ok, true);
    await settle(m);
    assert.equal(goalStatus(m), "ACTIVE");

    const direct = await m.supervisor.transitionArtifact("dev", cli, { to: "ARCHIVED" });
    assert.equal(direct.ok, false, "REJECTED -> ARCHIVED is not a move: the sentence the seat is told names the two that are");
    assert.equal((await m.supervisor.transitionArtifact("dev", cli, { to: "DRAFT" })).ok, true);
    await settle(m);
    assert.equal(goalStatus(m), "ACTIVE", "the reworked draft was rejected before: it still holds the mission");
    assert.equal((await m.supervisor.transitionArtifact("dev", cli, { to: "ARCHIVED" })).ok, true);
    await settle(m);
    assert.equal(goalStatus(m), "COMPLETED", "abandoned and said so: the library that landed is the whole of what was asked");
  } finally {
    await m.cleanup();
  }
});

test("each state a rejected patch can be in is told its own next move, and none is told to archive a REJECTED one", async () => {
  const m = await fixture();
  try {
    const library = await mergeable(m, "library");
    const cli = await rejected(m, "cli");
    const sentence = async () => {
      const merged = await mergeable(m, `merge-${Math.random().toString(36).slice(2, 6)}`);
      return (await op(m, "lead", { op: "merge", artifactId: merged })).reason ?? "";
    };
    assert.match(await sentence(), /CodePatch "cli" is REJECTED \(owner dev\): dev reworks it .* moves it to DRAFT and then to ARCHIVED/);
    assert.equal((await m.supervisor.transitionArtifact("dev", cli, { to: "DRAFT" })).ok, true);
    assert.match(await sentence(), /CodePatch "cli" is DRAFT \(owner dev\): dev finishes the rework and asks for a review, or archives it if it is abandoned/);
    assert.equal((await m.supervisor.transitionArtifact("dev", cli, { to: "READY_FOR_REVIEW" })).ok, true);
    assert.match(await sentence(), /CodePatch "cli" is READY_FOR_REVIEW \(owner dev\): it was rejected before, and waits on its review again/);
    await op(m, "dev", { op: "request_review", artifactId: cli, reviewers: ["lead"] });
    assert.equal((await op(m, "lead", { op: "approve", subject: "implementation", artifactId: cli })).ok, true);
    assert.match(await sentence(), /CodePatch "cli" is APPROVED \(owner dev\): it was rejected before, and waits to be merged/);
    assert.ok(library, "the first library patch is still the one the fixture merged first");
  } finally {
    await m.cleanup();
  }
});

test("a reviewer who approves the patch it rejected is told whose move it is, not to 'move it to review first'", async () => {
  const m = await fixture();
  try {
    const cli = await rejected(m, "cli");
    const res = await op(m, "lead", { op: "approve", subject: "implementation", artifactId: cli });
    assert.equal(res.ok, true, "the signature is recorded, as it always was");
    assert.equal(res.caveat, true);
    assert.equal(status(m, cli), "REJECTED", "and moved nothing");
    assert.match(res.reason ?? "", /the verdict is recorded, but CodePatch "cli" is REJECTED and an approval cannot advance it: a rejected artifact goes back to DRAFT and only its owner \(dev\) can move it, so ask dev to rework it \(a new version with asVersionOf, then a review request\) if you now want the work/);
    assert.doesNotMatch(res.reason ?? "", /move it to review first/, "the sixth run's tech-lead could not: only the owner can");

    // Another status keeps the sentence it always had.
    const draft = await patch(m, "draft");
    const other = await op(m, "lead", { op: "approve", subject: "implementation", artifactId: draft });
    assert.match(other.reason ?? "", /is DRAFT and an approval cannot advance it from there — move it to review first if you meant to approve the work/);
  } finally {
    await m.cleanup();
  }
});

// ------------------------------------------------------- what does not hold it

test("a patch nobody has put forward holds nothing: a working copy is not a rejected patch", async () => {
  const m = await fixture();
  try {
    const library = await mergeable(m, "library");
    await patch(m, "scratch");
    const res = await op(m, "lead", { op: "merge", artifactId: library });
    assert.equal(res.ok, true, res.reason);
    await settle(m);
    assert.equal(goalStatus(m), "COMPLETED");
  } finally {
    await m.cleanup();
  }
});

test("patches that were never rejected hold nothing, in whatever state: one on the ladder that cannot land must not keep a finished mission open", async () => {
  const m = await fixture();
  try {
    const library = await mergeable(m, "library");
    // Submitted and waiting on its review; approved and waiting on the ladder; parked MERGEABLE.
    const waiting = await patch(m, "waiting");
    assert.equal((await m.supervisor.transitionArtifact("dev", waiting, { to: "READY_FOR_REVIEW" })).ok, true);
    await approved(m, await patch(m, "approved"));
    await mergeable(m, "parked");

    const res = await op(m, "lead", { op: "merge", artifactId: library });
    assert.equal(res.ok, true, res.reason);
    await settle(m);
    assert.equal(goalStatus(m), "COMPLETED", "the seats moving them are the ones to land them, and the stall watchdog already wakes the merger for a parked patch");
    assert.doesNotMatch(res.reason ?? "", /cannot complete/);
  } finally {
    await m.cleanup();
  }
});

test("a goal that does not ask for the implementation to be merged is not held by a rejected patch", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", criteria: [{ id: "report-written", description: "a report", mandatory: true }] } as never);
  try {
    await rejected(m, "cli");
    assert.deepEqual(openRejections(m.kernel.state, m.kernel.state.activeGoalId ?? ""), []);
  } finally {
    await m.cleanup();
  }
});

// ------------------------------------------------------------ the predicate

const art = (over: Partial<Artifact>): Artifact => ({ id: "a", name: "a", type: "CodePatch", goalId: "g", owner: "dev", version: 1, status: "REJECTED", ...over }) as Artifact;

function stateWith(list: Artifact[], history: Record<string, Array<Partial<Artifact>>> = {}, criteria: Array<{ id: string; mandatory: boolean }> = [{ id: "implementation-merged", mandatory: true }]) {
  return {
    goals: new Map([["g", { id: "g", acceptanceCriteria: criteria }]]),
    artifacts: new Map(list.map((a) => [a.id, a])),
    artifactHistory: new Map(Object.entries(history).map(([id, h]) => [id, h as Artifact[]])),
  } as never;
}

test("openRejections: this goal's code patches that are REJECTED, whatever their history", () => {
  const state = stateWith([
    art({ id: "rejected" }),
    art({ id: "review", status: "UNDER_REVIEW" }),
    art({ id: "ready", status: "READY_FOR_REVIEW" }),
    art({ id: "approved", status: "APPROVED" }),
    art({ id: "mergeable", status: "MERGEABLE" }),
    art({ id: "merged", status: "MERGED" }),
    art({ id: "archived", status: "ARCHIVED" }),
    art({ id: "other-goal", goalId: "g2" }),
    art({ id: "a-test-report", type: "TestReport" }),
  ]);
  assert.deepEqual(openRejections(state, "g").map((a) => a.id), ["rejected"], "a REJECTED patch needs no history; patches that were never rejected are not listed");
});

test("openRejections: a patch that was rejected stays listed until it is MERGED or ARCHIVED", () => {
  const rejectedOnce: Array<Partial<Artifact>> = [{ status: "DRAFT" }, { status: "UNDER_REVIEW" }, { status: "REJECTED" }];
  const state = stateWith(
    [
      art({ id: "fresh", status: "DRAFT" }),
      art({ id: "reworked", status: "DRAFT" }),
      art({ id: "resubmitted", status: "UNDER_REVIEW" }),
      art({ id: "approved-again", status: "APPROVED" }),
      art({ id: "landed", status: "MERGED" }),
      art({ id: "withdrawn", status: "ARCHIVED" }),
      art({ id: "pulled-back", status: "DRAFT" }),
      art({ id: "unknown-history", status: "DRAFT" }),
    ],
    {
      fresh: [{ status: "DRAFT" }],
      reworked: [...rejectedOnce, { status: "DRAFT" }],
      resubmitted: [...rejectedOnce, { status: "DRAFT" }, { status: "UNDER_REVIEW" }],
      "approved-again": [...rejectedOnce, { status: "DRAFT" }, { status: "UNDER_REVIEW" }, { status: "APPROVED" }],
      landed: [...rejectedOnce, { status: "MERGED" }],
      withdrawn: [...rejectedOnce, { status: "ARCHIVED" }],
      "pulled-back": [{ status: "DRAFT" }, { status: "READY_FOR_REVIEW" }, { status: "DRAFT" }],
    },
  );
  assert.deepEqual(openRejections(state, "g").map((a) => a.id).sort(), ["approved-again", "resubmitted", "reworked"]);
});

test("openRejections: only for a goal whose mandatory criteria include implementation-merged", () => {
  const rejectedPatch = [art({ id: "rejected" })];
  assert.equal(openRejections(stateWith(rejectedPatch, {}, [{ id: "implementation-merged", mandatory: true }]), "g").length, 1);
  assert.equal(openRejections(stateWith(rejectedPatch, {}, [{ id: "implementation-merged", mandatory: false }]), "g").length, 0, "an optional criterion does not make the mission wait");
  assert.equal(openRejections(stateWith(rejectedPatch, {}, [{ id: "something-else", mandatory: true }]), "g").length, 0);
  assert.equal(openRejections(stateWith(rejectedPatch, {}, []), "nope").length, 0, "no such goal");
});
