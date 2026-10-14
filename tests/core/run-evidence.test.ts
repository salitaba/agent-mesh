import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { runEvidence, shippedCode } from "../../packages/core/src/projections";
import { TerminationManager } from "../../packages/core/src/termination";
import type { WorkspacePort } from "../../packages/core/src/ports";
import type { Artifact, MeshOp } from "../../packages/protocol/src/index";

/**
 * A mission that ships code may not complete until its product has been RUN.
 *
 * Measured 2026-10-14: a live mesh delivered a repository of tests and docs around a CLI that no seat had ever started.
 * 47 CodePatches merged, every criterion evidenced, "Delivered" on the console — and the product itself worked the
 * moment a person typed `node bin/skillctl.js --help`: it printed its usage and `list` answered "no skills found". Its
 * operator's words were "product just have test script and it doesn't have run product". A suite that imports a module
 * is not a run of the thing a user invokes, so a run is now evidence of its own kind: a settled `ExecutionRecord`.
 *
 * The gate is scoped from the state, never from config wording: it applies when the mission merged a CodePatch AND a
 * seat could actually run something (a runtime that is not the stub, holding `test.execute`). A scripted mesh cannot
 * run a product, so demanding one of it would be a deadlock — which is what the control below pins.
 */

const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "test.execute"], interests: [] },
  { id: "qa", role: "qa", capabilities: ["repository.read", "test.execute", "test.write"], interests: [] },
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review", "git.merge"], authority: ["implementation.approve"], interests: [] },
];
const COMM = { dev: ["lead", "qa"], qa: ["lead"], lead: ["dev"] };
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

/** A mesh whose seats could run the product: the default fixture runtime is the stub, which cannot. */
async function fixture(runtime = "claude"): Promise<Mesh> {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", criteria: CRITERIA, runtime } as never);
  (m.supervisor as unknown as { deps: { workspace?: WorkspacePort } }).deps.workspace = landing();
  return m;
}

const op = (m: Mesh, as: string, o: Record<string, unknown>) => m.supervisor.executeOp(as, o as unknown as MeshOp, turnFor(as));
const status = (m: Mesh, id: string) => m.kernel.state.artifacts.get(id)?.status;
const goalStatus = (m: Mesh) => m.kernel.state.goals.get(m.kernel.state.activeGoalId ?? "")?.status;
const verdict = (m: Mesh) => new TerminationManager().evaluate({ state: m.kernel.state, config: m.config, wallClockMs: 1000 });
const settle = (m: Mesh) => (m.supervisor as unknown as { watchdog(): Promise<void> }).watchdog();

async function artifact(m: Mesh, name: string, type: Artifact["type"]): Promise<string> {
  const created = await m.supervisor.createArtifact({ actorId: "dev", name, type, content: `the whole of ${name}, at length` });
  if (!("artifact" in created)) throw new Error(`create failed: ${JSON.stringify(created)}`);
  return created.artifact.id;
}

/** A patch that landed: MERGED is what evidences `implementation-merged` here. */
async function landed(m: Mesh, name: string): Promise<string> {
  const id = await artifact(m, name, "CodePatch");
  assert.equal((await m.supervisor.transitionArtifact("dev", id, { to: "READY_FOR_REVIEW" })).ok, true);
  await op(m, "dev", { op: "request_review", artifactId: id, reviewers: ["lead"] });
  assert.equal((await op(m, "lead", { op: "approve", subject: "implementation", artifactId: id })).ok, true);
  assert.equal((await m.supervisor.transitionArtifact("lead", id, { to: "VERIFIED" })).ok, true);
  assert.equal((await m.supervisor.transitionArtifact("lead", id, { to: "MERGEABLE" })).ok, true);
  const res = await op(m, "lead", { op: "merge", artifactId: id });
  assert.equal(res.ok, true, res.reason);
  assert.equal(status(m, id), "MERGED");
  return id;
}

/** The product run and the record verified: a settled ExecutionRecord. */
async function ranTheProduct(m: Mesh): Promise<string> {
  const id = await artifact(m, "product-run", "ExecutionRecord");
  assert.equal((await m.supervisor.transitionArtifact("dev", id, { to: "READY_FOR_REVIEW" })).ok, true);
  await op(m, "dev", { op: "request_review", artifactId: id, reviewers: ["qa"] });
  assert.equal((await op(m, "qa", { op: "approve", subject: "quality", artifactId: id })).ok, true, "a run record is a quality verdict: that is the subject `subjectForArtifactType` gives a ExecutionRecord");
  assert.equal((await m.supervisor.transitionArtifact("qa", id, { to: "FINAL" })).ok, true, "a document goes APPROVED -> FINAL; VERIFIED is the patch ladder");
  return id;
}

test("code that shipped without ever being run does not complete, and the run releases it", async () => {
  const m = await fixture();
  try {
    await landed(m, "library");
    await settle(m);
    assert.equal(goalStatus(m), "ACTIVE", "every criterion is evidenced and the mission still may not close: nothing has run the product");
    assert.equal(verdict(m).kind, "continue");
    assert.deepEqual(runEvidence(m.kernel.state, m.kernel.state.activeGoalId ?? ""), [], "and there is no run to show");

    await ranTheProduct(m);
    await settle(m);
    assert.equal(goalStatus(m), "COMPLETED", "run, and the record of it verified: now it may close");
  } finally {
    await m.cleanup();
  }
});

test("a mission that merged no patch is not held: there is nothing to run", async () => {
  const m = await fixture();
  try {
    const doc = await artifact(m, "research", "ResearchReport");
    assert.equal((await m.supervisor.transitionArtifact("dev", doc, { to: "READY_FOR_REVIEW" })).ok, true);
    await m.supervisor.transitionArtifact("dev", doc, { to: "DRAFT" });
    await m.supervisor.transitionArtifact("dev", doc, { to: "ARCHIVED" });
    await settle(m);
    assert.deepEqual(shippedCode(m.kernel.state, m.kernel.state.activeGoalId ?? ""), [], "no merged patch: no product");
  } finally {
    await m.cleanup();
  }
});

test("control: a scripted mesh is not asked to run anything, because it cannot", async () => {
  const m = await fixture("stub");
  try {
    await landed(m, "library");
    await settle(m);
    assert.equal(goalStatus(m), "COMPLETED", "the stub runtime cannot execute a product: holding the mission on a run would be a deadlock, and that is the state this control pins");
  } finally {
    await m.cleanup();
  }
});

// -------------------------------------------------------------- the predicate

const art = (over: Partial<Artifact>): Artifact =>
  ({ id: "a", name: "a", type: "ExecutionRecord", goalId: "g", owner: "qa", version: 1, status: "FINAL", ...over }) as Artifact;

const stateWith = (list: Artifact[]) =>
  ({
    goals: new Map([["g", { id: "g", acceptanceCriteria: [] }]]),
    artifacts: new Map(list.map((a) => [a.id, a])),
    artifactHistory: new Map(),
  }) as never;

test("runEvidence: settled runs of this goal, and nothing else", () => {
  const state = stateWith([
    art({ id: "final" }),
    art({ id: "approved", status: "APPROVED" }),
    art({ id: "draft", status: "DRAFT" }),
    art({ id: "archived", status: "ARCHIVED" }),
    art({ id: "a-test-report", type: "TestReport" }),
    art({ id: "another-goal", goalId: "g2" }),
  ]);
  assert.deepEqual(
    runEvidence(state, "g").map((a) => a.id),
    ["final", "approved"],
    "a draft nobody verified is not evidence the product works, and a test report is not a run",
  );
  assert.deepEqual(runEvidence({ artifacts: new Map() } as never, "g"), [], "a partial state has no runs");
});

test("shippedCode: merged patches of this goal", () => {
  const state = stateWith([art({ id: "merged", type: "CodePatch", status: "MERGED" }), art({ id: "draft", type: "CodePatch", status: "DRAFT" }), art({ id: "run" })]);
  assert.deepEqual(shippedCode(state, "g").map((a) => a.id), ["merged"]);
});
