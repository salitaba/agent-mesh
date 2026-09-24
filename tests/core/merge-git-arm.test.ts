import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * The git arm of `merge` kept the bug the non-git arm was fixed for.
 *
 * The non-git arm carries a long comment about why a failed merge must fail the
 * op: reporting `ok: true` "let a run finish 'successfully' having written not one
 * byte — the artifact showed MERGED, `implementation-merged` stayed UNEVIDENCED,
 * and the only trace was an audit line nobody reads." The git arm, directly above
 * it, did not do any of that. `mergeWorktree` rejects on a conflict (execFile, and
 * `git merge` exits non-zero), and `executeOp`'s catch rethrows anything that is
 * not a `KernelRejectedError` — so a conflicted merge escaped as a thrown turn
 * instead of an op result the seat could read, and a successful one had its commit
 * sha discarded by a bare `void`.
 *
 * Tested with a workspace double rather than real git: `makeMesh` bootstraps
 * `inMemory: true`, and the server only builds a `GitWorkspace` when it is not
 * (`useGit = !options.inMemory && …`), so no test reaches this arm otherwise. That
 * `mergeWorktree` really does commit onto the product branch is proven separately,
 * against real git, in `tests/integration/workspace.test.ts`.
 */

const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "test.execute"], interests: [] },
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review", "git.merge"], authority: ["implementation.approve"], interests: [] },
];
const COMM = { dev: ["lead"], lead: ["dev"] };
// The helper's default criterion is `ship`; this suite asserts on the one a merge
// actually evidences.
const CRITERIA = [{ id: "implementation-merged", description: "the patch landed", mandatory: true }];

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

type Workspace = { mergeWorktree(artifactId: string, agentId: string, message: string): Promise<{ commit: string }> };

/** A patch walked all the way to MERGEABLE, with a workspace double installed. */
async function mergeable(workspace: Workspace) {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", criteria: CRITERIA } as never);
  // The arm under test is only reachable when `deps.workspace` is set, and the
  // in-memory bootstrap never sets it.
  (m.supervisor as unknown as { deps: { workspace?: Workspace } }).deps.workspace = workspace;

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

const criterion = (m: Awaited<ReturnType<typeof mergeable>>["m"], id: string) => {
  const goal = m.kernel.state.activeGoalId ? m.kernel.state.goals.get(m.kernel.state.activeGoalId) : undefined;
  return goal?.acceptanceCriteria.find((c) => c.id === id);
};

test("a successful git merge reports the commit it produced", async () => {
  let sawMessage = "";
  const { m, id } = await mergeable({
    async mergeWorktree(_a, _who, message) {
      sawMessage = message;
      return { commit: "0123456789abcdef0123456789abcdef01234567" };
    },
  });
  try {
    const res = await m.supervisor.executeOp("lead", { op: "merge", artifactId: id, comment: "land slice 1" } as MeshOp, turnFor("lead"));

    assert.equal(res.ok, true, res.reason ?? "");
    assert.match(String(res.reason), /merged as 0123456789ab/, "the sha was discarded by a bare `void` before");
    assert.equal(sawMessage, "land slice 1", "the seat's comment becomes the commit message");
    assert.equal(m.kernel.state.artifacts.get(id)?.status, "MERGED");
    assert.equal(criterion(m, "implementation-merged")?.status, "EVIDENCED", "a real merge is runtime-derived evidence");
  } finally {
    await m.cleanup();
  }
});

test("a conflicted git merge refuses the op instead of throwing out of the turn", async () => {
  const { m, id } = await mergeable({
    async mergeWorktree() {
      // What `git merge` actually produces on a conflict, via execFile.
      throw new Error("Command failed: git merge --no-edit -m land mesh/dev\nCONFLICT (content): Merge conflict in src/app.ts");
    },
  });
  try {
    const res = await m.supervisor.executeOp("lead", { op: "merge", artifactId: id } as MeshOp, turnFor("lead"));

    assert.equal(res.ok, false, "a merge that did not merge is not a successful op");
    assert.match(String(res.reason), /git merge of 'slice-1' failed/);
    assert.match(String(res.reason), /CONFLICT \(content\)/, "the git output reaches the seat, which is the only actionable part");
    assert.match(String(res.reason), /nothing landed on the product branch/);
  } finally {
    await m.cleanup();
  }
});

test("a failed merge lands nothing: no MERGED, no mirrors, no evidence", async () => {
  // The criterion is the load-bearing half: `markMergeEvidence` records
  // runtime-derived evidence with no claiming agent, so it lands EVIDENCED by
  // construction. Marking it on a merge that never happened would satisfy a
  // mandatory completion criterion with nothing behind it.
  //
  // This test used to end by DOCUMENTING the opposite: the transition ran
  // before the git call, so a failed merge left the patch reading MERGED with
  // `patch.merged` and `implementation.completed` already emitted. A live run
  // on 2026-09-23 shipped that state at 20:23:57 — artifact MERGED, both
  // mirrors on the log, and `git log` without the patch. `opMerge` now lands
  // the change before recording it, so there is nothing to walk back.
  const { m, id } = await mergeable({
    async mergeWorktree() {
      throw new Error("Command failed: git merge --no-edit -m x mesh/dev");
    },
  });
  try {
    const res = await m.supervisor.executeOp("lead", { op: "merge", artifactId: id } as MeshOp, turnFor("lead"));
    assert.equal(res.ok, false, "the op fails, so the result reaches the agent's turn");

    const c = criterion(m, "implementation-merged");
    assert.notEqual(c?.status, "EVIDENCED", `a merge that failed must evidence nothing, got ${c?.status}`);

    assert.equal(
      m.kernel.state.artifacts.get(id)?.status,
      "MERGEABLE",
      "the patch stays where it was — true, and retryable once the conflict is fixed",
    );

    const events = await m.store.read();
    const merged = events.filter((e) => e.type === "artifact.transition" && (e.payload as { to?: string }).to === "MERGED");
    assert.equal(merged.length, 0, "no MERGED transition for a merge that did not happen");
    assert.equal(events.filter((e) => e.type === "patch.merged").length, 0, "and no patch.merged mirror");
    assert.equal(
      events.filter((e) => e.type === "implementation.completed").length,
      0,
      "and no implementation.completed — it reduces to an implementation|pass approval that feeds the gates",
    );

    const denial = events.find(
      (e) => e.type === "message.rejected" && (e.payload as { ruleId?: string }).ruleId === "merge.git-failed",
    );
    assert.ok(denial, "and the failure is on the event log, not only in an audit line nobody reads");
  } finally {
    await m.cleanup();
  }
});

test("a successful merge records itself exactly once", async () => {
  // A second `transitionArtifact(HUMAN_AGENT_ID, ...)` used to follow the git
  // call, from the runtime's first commit and with no comment explaining it.
  // It survived every guard by accident — policy short-circuits on `human`,
  // and the reducer absorbs a same-status move before `assertArtifactTransition`
  // can refuse it — so the kernel appended the event and `mirrorTransition`
  // re-fired. Each duplicate wrote a second `implementation|pass` approval
  // record attributed to the artifact OWNER: a gate signature the owner never
  // gave. Counts, not presence, are what catch that.
  const { m, id } = await mergeable({
    async mergeWorktree() {
      return { commit: "abcdef0123456789" };
    },
  });
  try {
    const res = await m.supervisor.executeOp("lead", { op: "merge", artifactId: id } as MeshOp, turnFor("lead"));
    assert.equal(res.ok, true, res.reason);
    assert.equal(m.kernel.state.artifacts.get(id)?.status, "MERGED");

    const events = await m.store.read();
    const merged = events.filter((e) => e.type === "artifact.transition" && (e.payload as { to?: string }).to === "MERGED");
    assert.equal(merged.length, 1, `one merge, one MERGED transition (got ${merged.length})`);
    assert.equal(merged[0]?.actorId, "lead", "attributed to the seat that merged, not to `human`");
    assert.equal(events.filter((e) => e.type === "patch.merged").length, 1, "one patch.merged");
    assert.equal(events.filter((e) => e.type === "implementation.completed").length, 1, "one implementation.completed");
  } finally {
    await m.cleanup();
  }
});

test("the non-git arm is untouched by all of this", async () => {
  // The control: with no workspace installed, `merge` still takes the
  // materialization path and still reports what it wrote.
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" } as never);
  try {
    const created = await m.supervisor.createArtifact({
      actorId: "dev",
      name: "slice-2",
      type: "CodePatch",
      content: "## File: src/app.ts\n\nexport const answer = 42;\n",
    });
    if (!("artifact" in created)) throw new Error("create failed");
    const id = created.artifact.id;
    await m.supervisor.transitionArtifact("dev", id, { to: "READY_FOR_REVIEW" });
    await m.supervisor.executeOp("dev", { op: "request_review", artifactId: id, reviewers: ["lead"] } as MeshOp, turnFor("dev"));
    await m.supervisor.executeOp("lead", { op: "approve", subject: "implementation", artifactId: id } as MeshOp, turnFor("lead"));
    await m.supervisor.transitionArtifact("lead", id, { to: "VERIFIED" });
    await m.supervisor.transitionArtifact("lead", id, { to: "MERGEABLE" });

    const res = await m.supervisor.executeOp("lead", { op: "merge", artifactId: id } as MeshOp, turnFor("lead"));
    assert.match(String(res.reason ?? ""), /materialized/, "the non-git arm still reports materialization, either way");
  } finally {
    await m.cleanup();
  }
});
