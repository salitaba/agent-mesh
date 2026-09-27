import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import type { WorkspacePort } from "../../packages/core/src/ports";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * What may say "the work landed" (NOTES-test-gaps.md, Stage 3.3 and 3.4).
 *
 * Two records claim a merge happened: the `implementation-merged` criterion
 * (runtime-derived, so `markMergeEvidence` lands it EVIDENCED by construction)
 * and the `patch.merged` + `implementation.completed` pair `mirrorTransition`
 * emits, the second of which reduces to an `implementation|pass` approval that
 * feeds the gates. Both should follow from a merge that moved the product
 * branch. Neither is tied to one:
 *
 *  - `opMerge` calls `markMergeEvidence` after ANY successful `mergeWorktree`,
 *    including one that reports `alreadyUpToDate` -- a merge that moved nothing.
 *  - `transitionArtifact` is public (the HTTP transition route and the
 *    `transition_artifact` op reach it), and `mirrorTransition` fires on
 *    type + target status alone. The op-level `merge` guard is one door; this
 *    is the other, and no git step is on its path.
 *
 * A local, fully-typed `WorkspacePort` double stands in for git: the in-memory
 * bootstrap never installs a workspace (`useGit = !inMemory && ...`), so the git
 * arm of `opMerge` is unreachable otherwise.
 */

const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "test.execute"], interests: [] },
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review", "git.merge"], authority: ["implementation.approve"], interests: [] },
];
const COMM = { dev: ["lead"], lead: ["dev"] };
const CRITERIA = [{ id: "implementation-merged", description: "the patch landed", mandatory: true }];

type MergeResult = Awaited<ReturnType<WorkspacePort["mergeWorktree"]>>;

function workspaceDouble(merge: () => Promise<MergeResult>): WorkspacePort {
  const unused = (name: string) => async (): Promise<never> => {
    throw new Error(`workspace double: ${name} is not part of this fixture`);
  };
  return {
    mainPath: "/nonexistent/product",
    ensureRepo: unused("ensureRepo"),
    ensureWorktree: unused("ensureWorktree"),
    commitWorktree: unused("commitWorktree"),
    mergeWorktree: merge,
    removeWorktree: unused("removeWorktree"),
    async worktreeState() {
      return null;
    },
  };
}

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

/** A CodePatch walked to MERGEABLE through supervisor calls, with `workspace` installed. */
async function mergeable(workspace: WorkspacePort) {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", criteria: CRITERIA } as never);
  (m.supervisor as unknown as { deps: { workspace?: WorkspacePort } }).deps.workspace = workspace;
  const created = await m.supervisor.createArtifact({ actorId: "dev", name: "slice-1", type: "CodePatch", content: "the whole patch, at length" });
  if (!("artifact" in created)) throw new Error("create failed");
  const id = created.artifact.id;
  await m.supervisor.transitionArtifact("dev", id, { to: "READY_FOR_REVIEW" });
  await m.supervisor.executeOp("dev", { op: "request_review", artifactId: id, reviewers: ["lead"] } as MeshOp, turnFor("dev"));
  await m.supervisor.executeOp("lead", { op: "approve", subject: "implementation", artifactId: id } as MeshOp, turnFor("lead"));
  await m.supervisor.transitionArtifact("lead", id, { to: "VERIFIED" });
  await m.supervisor.transitionArtifact("lead", id, { to: "MERGEABLE" });
  assert.equal(m.kernel.state.artifacts.get(id)?.status, "MERGEABLE", "fixture: the patch is staged at the gate");
  return { m, id };
}

type Mesh = Awaited<ReturnType<typeof mergeable>>["m"];

const criterionStatus = (m: Mesh) =>
  m.kernel.state.goals.get(m.kernel.state.activeGoalId ?? "")?.acceptanceCriteria.find((c) => c.id === "implementation-merged")?.status;

async function mergeClaims(m: Mesh) {
  const events = await m.store.read();
  return {
    patchMerged: events.filter((e) => e.type === "patch.merged").length,
    implementationCompleted: events.filter((e) => e.type === "implementation.completed").length,
    implementationPass: [...m.kernel.state.approvals.values()].flat().filter((r) => r.kind === "pass" && r.subject === "implementation").length,
  };
}

let calls = 0;
const landed = () =>
  workspaceDouble(async () => {
    calls++;
    return { commit: "0123456789abcdef0123456789abcdef01234567" };
  });

// --- 3.4: a merge that moved nothing ----------------------------------------

test("control: a merge that moved the product branch evidences implementation-merged", async () => {
  const { m, id } = await mergeable(landed());
  try {
    const res = await m.supervisor.executeOp("lead", { op: "merge", artifactId: id } as MeshOp, turnFor("lead"));
    assert.equal(res.ok, true, res.reason);
    assert.equal(criterionStatus(m), "EVIDENCED");
  } finally {
    await m.cleanup();
  }
});

test(
  "an alreadyUpToDate merge does not evidence implementation-merged",
  async () => {
    const { m, id } = await mergeable(
      workspaceDouble(async () => ({ commit: "fedcba9876543210fedcba9876543210fedcba98", alreadyUpToDate: true })),
    );
    try {
      const res = await m.supervisor.executeOp("lead", { op: "merge", artifactId: id } as MeshOp, turnFor("lead"));
      // Not asserted either way: whether the op itself succeeds is the design
      // decision this fix needs. What must not happen is the criterion that
      // means "this work landed" closing on a merge that landed nothing.
      assert.match(String(res.reason), /already in the product/, "fixture: the double's up-to-date arm was taken");
      assert.notEqual(criterionStatus(m), "EVIDENCED", "a merge that moved nothing is not evidence the work landed");
    } finally {
      await m.cleanup();
    }
  },
);

// --- 3.3: mirrorTransition without a merge ------------------------------------

test("control: the merge op emits one patch.merged and one implementation.completed", async () => {
  // Proves the two event names below are the ones the merge path really emits,
  // so their ABSENCE in the next test means something.
  calls = 0;
  const { m, id } = await mergeable(landed());
  try {
    const res = await m.supervisor.executeOp("lead", { op: "merge", artifactId: id } as MeshOp, turnFor("lead"));
    assert.equal(res.ok, true, res.reason);
    assert.equal(calls, 1, "the git step ran");
    assert.deepEqual(await mergeClaims(m), { patchMerged: 1, implementationCompleted: 1, implementationPass: 1 });
  } finally {
    await m.cleanup();
  }
});

test(
  "transitionArtifact to MERGED with no merge behind it claims no merge",
  async () => {
    calls = 0;
    const { m, id } = await mergeable(landed());
    try {
      // The seat holds git.merge, so policy allows the transition; the only
      // thing missing is the merge. Refusing the call outright is one correct
      // fix, recording the status without the mirrors is another -- either way
      // nothing may claim the implementation was completed.
      await m.supervisor.transitionArtifact("lead", id, { to: "MERGED" });
      assert.equal(calls, 0, "fixture: no git step was on this path");
      assert.deepEqual(
        await mergeClaims(m),
        { patchMerged: 0, implementationCompleted: 0, implementationPass: 0 },
        "no patch.merged, no implementation.completed, and no implementation|pass signature for a merge that never ran",
      );
    } finally {
      await m.cleanup();
    }
  },
);
