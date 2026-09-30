import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, evidenceContent } from "../helpers";
import { FakeWorkspace, installWorkspace } from "../support/fake-workspace";
import { buildRunReport, renderRunReport } from "../../packages/core/src/run-report";
import { buildAgentContext, renderContextInstructions } from "../../packages/core/src/context";
import type { Artifact, WorktreeStamp } from "../../packages/protocol/src/index";

/**
 * A verification report says what was tested; the runtime records what the tree was.
 *
 * The fourth cronlite run's QA was handed a CodePatch as text, re-typed four files from it into a
 * worktree that held only the scaffold commit, ran the tests there and published a TestReport that
 * said 43/43. The bytes happened to match the merged commit. Nothing on the record could say they
 * did, or that the tree was not the commit, and the files it left behind stopped the mesh bringing
 * the worktree up to date.
 *
 * Now the runtime stamps a verification report with the worktree it was published from (HEAD, how
 * many files were dirty) and whether that tree holds the commit of each CodePatch the turn read;
 * the run report flags a report whose tree does not; and a seat that verifies is told, where it
 * reads about the patch, which commit it is and to test that.
 */

const SHA = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f80912";
const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "test.execute", "git.commit"], interests: [] },
  { id: "qa", role: "qa", authority: ["quality.pass"], capabilities: ["repository.read", "test.execute", "test.write"], interests: [] },
  { id: "pm", role: "product-manager", authority: ["requirements.accept"], capabilities: ["repository.read"], interests: [] },
];
const COMM = { dev: ["qa", "pm"], qa: ["dev", "pm"], pm: ["dev", "qa"] };

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

async function setup(ws?: FakeWorkspace) {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" } as never);
  const restore = ws ? installWorkspace(m, ws) : () => undefined;
  return { m, restore };
}

async function patch(m: Mesh, commit: string | undefined = SHA): Promise<Artifact> {
  const created = await m.supervisor.createArtifact({
    actorId: "dev",
    name: "cronlite implementation",
    type: "CodePatch",
    content: evidenceContent("the patch"),
    ...(commit ? { metadata: { commit } } : {}),
  });
  if (!("artifact" in created)) throw new Error(`create failed: ${JSON.stringify(created)}`);
  return created.artifact;
}

/** qa publishes a TestReport after reading `read` in its turn. */
async function report(m: Mesh, read: Artifact[], extra: Record<string, unknown> = {}, actorId = "qa", type = "TestReport") {
  const created = await m.supervisor.createArtifact({
    actorId,
    name: `${actorId} report`,
    type: type as never,
    content: evidenceContent("the report"),
    inputs: read.map((a) => ({ artifactId: a.id, version: a.version })),
    ...extra,
  });
  if (!("artifact" in created)) throw new Error(`create failed: ${JSON.stringify(created)}`);
  return created.artifact;
}

const stampOf = (a: Artifact): WorktreeStamp | undefined => a.metadata.worktree as WorktreeStamp | undefined;

const wsWith = (over: Partial<ConstructorParameters<typeof FakeWorkspace>[0] & object> = {}) =>
  new FakeWorkspace({
    behaviour: {
      worktreeState: { qa: { agentId: "qa", dirty: ["src/index.js", "bin/cronlite.js", "test/index.test.js", "package.json"], untracked: 4, unmergedCommits: [], head: "0123456789ab" } },
      containsCommit: { [SHA]: false },
    },
    ...over,
  });

// ------------------------------------------------------------------ the stamp

test("a TestReport is stamped with the tree it was published from, and whether that tree holds the patch it read", async () => {
  const { m, restore } = await setup(wsWith());
  try {
    const p = await patch(m);
    const r = await report(m, [p]);
    assert.deepEqual(stampOf(r), {
      head: "0123456789ab",
      dirty: 4,
      untracked: 4,
      ahead: 0,
      tested: [{ artifact: "artifact://CodePatch/cronlite%20implementation/1", commit: SHA.slice(0, 12), inHead: false }],
    });
  } finally {
    restore();
    await m.cleanup();
  }
});

test("a tree that holds the commit is recorded as holding it", async () => {
  const ws = wsWith();
  ws.set({ containsCommit: { [SHA]: true } });
  const { m, restore } = await setup(ws);
  try {
    const r = await report(m, [await patch(m)]);
    assert.equal(stampOf(r)?.tested?.[0]?.inHead, true);
  } finally {
    restore();
    await m.cleanup();
  }
});

test("what the seat claims under metadata.worktree is discarded: the key is the runtime's alone", async () => {
  const { m, restore } = await setup(wsWith());
  try {
    const p = await patch(m);
    const forged = { head: "feedfacefeed", dirty: 0, untracked: 0, ahead: 0, tested: [{ artifact: "x", commit: "y", inHead: true }] };
    const r = await report(m, [p], { metadata: { worktree: forged, result: "PASSED" } });
    assert.notDeepEqual(stampOf(r), forged);
    assert.equal(stampOf(r)?.head, "0123456789ab");
    assert.equal(r.metadata.result, "PASSED", "the rest of what the seat said is kept");
  } finally {
    restore();
    await m.cleanup();
  }
});

test("no worktree to describe means no stamp, and a forged one is removed rather than kept", async () => {
  // A workspace with no state for qa (or no workspace at all) cannot vouch for anything.
  for (const ws of [new FakeWorkspace(), undefined]) {
    const { m, restore } = await setup(ws);
    try {
      const r = await report(m, [await patch(m)], { metadata: { worktree: { dirty: 0, untracked: 0, ahead: 0 } } });
      assert.equal(stampOf(r), undefined);
    } finally {
      restore();
      await m.cleanup();
    }
  }
});

test("only a verification report is stamped, and never the operator's", async () => {
  // The workspace has a tree for the operator too, so the only thing keeping it unstamped is the rule.
  const ws = wsWith();
  ws.set({
    worktreeState: {
      qa: { agentId: "qa", dirty: [], untracked: 0, unmergedCommits: [], head: "0123456789ab" },
      human: { agentId: "human", dirty: [], untracked: 0, unmergedCommits: [], head: "fedcba987654" },
    },
  });
  const { m, restore } = await setup(ws);
  try {
    const p = await patch(m);
    assert.equal(stampOf(p), undefined, "a CodePatch is not a verification report");
    const doc = await report(m, [], {}, "qa", "RequirementsDoc");
    assert.equal(stampOf(doc), undefined);
    const human = await report(m, [p], {}, "human");
    assert.equal(stampOf(human), undefined, "the operator has no worktree of the kind that means anything here");
    const security = await report(m, [p], {}, "qa", "SecurityReport");
    assert.ok(stampOf(security), "a SecurityReport is one");
  } finally {
    restore();
    await m.cleanup();
  }
});

test("a patch that records no commit adds nothing to `tested`, and git is not asked", async () => {
  const ws = wsWith();
  const { m, restore } = await setup(ws);
  try {
    const r = await report(m, [await patch(m, "")]);
    assert.equal(stampOf(r)?.tested, undefined, "nothing to ask about");
    assert.equal(ws.callsTo("containsCommit").length, 0);
    assert.equal(stampOf(r)?.head, "0123456789ab", "the rest of the stamp is still there");
  } finally {
    restore();
    await m.cleanup();
  }
});

test("a commit git cannot place adds nothing either: no answer is recorded, not a false one", async () => {
  const ws = wsWith();
  ws.set({ containsCommit: {} });
  const { m, restore } = await setup(ws);
  try {
    const r = await report(m, [await patch(m)]);
    assert.equal(ws.callsTo("containsCommit").length, 1, "it was asked");
    assert.equal(stampOf(r)?.tested, undefined);
  } finally {
    restore();
    await m.cleanup();
  }
});

// ----------------------------------------------------------------- the report

test("the run report flags a report written from a tree that does not hold the patch's commit", async () => {
  const { m, restore } = await setup(wsWith());
  try {
    const p = await patch(m);
    const r = await report(m, [p]);
    await m.supervisor.transitionArtifact("qa", r.id, { to: "READY_FOR_REVIEW" });
    // Put it in a settled state the report lists under DELIVERED.
    m.kernel.state.artifacts.get(r.id)!.status = "FINAL";

    const flagged = buildRunReport(m.kernel.state);
    const entry = flagged.delivered.find((a) => a.id === r.id);
    assert.deepEqual(entry?.testedCopyOf, { patches: ["artifact://CodePatch/cronlite%20implementation/1"], head: "0123456789ab" });
    const text = renderRunReport(flagged);
    assert.match(text, /! written from a worktree at 0123456789ab that does not hold the commit of artifact:\/\/CodePatch\/cronlite%20implementation\/1 — it tested a copy of the patch, not the recorded commit/);
  } finally {
    restore();
    await m.cleanup();
  }
});

test("a report written from a tree that holds the commit is not flagged", async () => {
  const ws = wsWith();
  ws.set({ containsCommit: { [SHA]: true } });
  const { m, restore } = await setup(ws);
  try {
    const r = await report(m, [await patch(m)]);
    m.kernel.state.artifacts.get(r.id)!.status = "FINAL";
    const entry = buildRunReport(m.kernel.state).delivered.find((a) => a.id === r.id);
    assert.ok(entry, "fixture: delivered");
    assert.equal(entry.testedCopyOf, undefined);
    assert.doesNotMatch(renderRunReport(buildRunReport(m.kernel.state)), /tested a copy of the patch/);
  } finally {
    restore();
    await m.cleanup();
  }
});

// ------------------------------------------------------------------ the briefing

test("a CodePatch line names the commit that is the patch", async () => {
  const { m, restore } = await setup();
  try {
    // Submitted for review, which is what puts it in front of qa at all.
    const p = await patch(m);
    await m.supervisor.transitionArtifact("dev", p.id, { to: "READY_FOR_REVIEW" });
    const ctx = buildAgentContext({ config: m.config, kernel: m.kernel }, "qa");
    assert.equal(ctx.relevantArtifacts.find((a) => a.type === "CodePatch")?.commit, SHA.slice(0, 12));
    assert.match(renderContextInstructions(ctx), new RegExp(`artifact://CodePatch/cronlite.{1,3}implementation/1 \\(CodePatch, READY_FOR_REVIEW, commit ${SHA.slice(0, 12)}\\)`));
  } finally {
    restore();
    await m.cleanup();
  }
});

test("the seat that verifies is told to test the commit, and the seat that does not is not", async () => {
  const { m, restore } = await setup();
  try {
    await patch(m);
    const qa = renderContextInstructions(buildAgentContext({ config: m.config, kernel: m.kernel }, "qa"));
    assert.match(qa, /## Testing a patch \(what you verify is the commit, not a copy of it\)/);
    assert.match(qa, /git merge --ff-only <sha>/);
    assert.match(qa, /Do NOT re-type files from the patch text/);
    assert.match(qa, /the run report flags a report that does not/);
    for (const other of ["dev", "pm"]) {
      const text = renderContextInstructions(buildAgentContext({ config: m.config, kernel: m.kernel }, other));
      assert.doesNotMatch(text, /Testing a patch/, `${other} does not write verification reports`);
    }
  } finally {
    restore();
    await m.cleanup();
  }
});
