import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, evidenceContent } from "../helpers";
import type { ArtifactType, MeshOp } from "../../packages/protocol/src/index";

/**
 * A verdict or an acceptance that names an artifact the mesh does not hold is refused with the route: what the seat could cite,
 * or the review it owes.
 *
 * The tenth and eleventh cronlite runs (2026-10-02). A seat typed an artifact id from memory and was told only that it was
 * unknown: the tenth run's architect and tech lead (three verdicts), and the eleventh run's tech lead (`art-M3YBHXSZ`) and pm,
 * which asked QA for its report by `art-M3YBS5TT…` (the report was `art-M3YBNR4X…`) and then cited that id in three acceptances,
 * refused three times in 5 s. Twelve of these across runs 7 to 11, each recovered by the seat's next read, none of them told where
 * the artifact was. The mesh already knows: the briefing lists what an acceptance may cite and the reviews a seat owes, so the
 * refusal names the same lists (and, for an acceptance with nothing to cite yet, says why: a draft cannot be cited).
 */

const PM = { id: "pm", role: "product-manager", capabilities: ["repository.read"], authority: ["requirements.accept"], interests: [] };
const QA = { id: "qa", role: "qa", capabilities: ["repository.read", "test.execute", "test.write"], authority: ["quality.block", "quality.pass"], interests: [] };
const LEAD = {
  id: "tech-lead",
  role: "tech-lead",
  capabilities: ["repository.read", "architecture.read", "code.review", "review.design", "task.assign", "git.merge"],
  authority: ["implementation.approve", "architecture.approve"],
  interests: [],
};
const LEAD2 = { ...LEAD, id: "lead-2" };
const DEV = { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "test.execute", "git.commit"], interests: [] };

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

function mesh(extra: Array<Record<string, unknown>> = []): Promise<Mesh> {
  const agents = [PM, QA, LEAD, DEV, ...extra];
  const ids = agents.map((a) => a.id as string);
  return makeMesh({
    agents,
    mayContact: Object.fromEntries(ids.map((id) => [id, ids.filter((o) => o !== id)])),
    criteria: [{ id: "contract-met", description: "the product does what the goal says, shown by a QA report", mandatory: true }],
    mode: "parked",
  } as never);
}

const turnFor = (agentId: string) =>
  ({ turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`, agentId, reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] }) as never;

async function publish(m: Mesh, owner: string, name: string, type: ArtifactType, submit: boolean): Promise<string> {
  const created = await m.supervisor.createArtifact({ actorId: owner, name, type, content: evidenceContent(name) });
  if (!("artifact" in created)) throw new Error(`create failed: ${JSON.stringify(created)}`);
  if (submit) {
    const moved = await m.supervisor.transitionArtifact(owner, created.artifact.id, { to: "READY_FOR_REVIEW" });
    assert.equal(moved.ok, true, String(moved.reason));
  }
  return created.artifact.id;
}

/** Published, submitted, and asked of `reviewer`: what a seat does before it waits. */
async function asked(m: Mesh, owner: string, name: string, type: ArtifactType, reviewer: string): Promise<string> {
  const id = await publish(m, owner, name, type, true);
  const ask = await m.supervisor.executeOp(owner, { op: "request_review", artifactId: id, reviewers: [reviewer] } as MeshOp, turnFor(owner));
  assert.equal(ask.ok, true, String(ask.reason));
  return id;
}

// ---- an acceptance that cites an id the mesh does not hold

test("the run-11 pm: an acceptance citing an id typed from memory is refused with the reports it could cite", async () => {
  const m = await mesh();
  try {
    const report = await publish(m, "qa", "QA Verification Report", "TestReport", true);
    const notes = await publish(m, "qa", "Scratch notes", "TestReport", false);
    const res = await m.supervisor.recordDecision("pm", "accept", "criterion:contract-met", "art-M3YBS5TT003baedc135d", "QA's report");
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /^unknown artifact art-M3YBS5TT003baedc135d cited as evidence for mandatory criterion 'contract-met'/, "the refusal it always was");
    assert.ok((res.reason ?? "").includes(`TestReport "QA Verification Report" (${report})`), "and now the report that exists, with its id");
    assert.match(res.reason ?? "", /Cite one of these \(submitted, and not what the operator rejected\)/);
    assert.ok(!(res.reason ?? "").includes(notes) && !(res.reason ?? "").includes("Scratch notes"), "a draft cannot be cited, so it is not offered");

    // The repair the refusal points at works.
    const right = await m.supervisor.recordDecision("pm", "accept", "criterion:contract-met", report, "QA's report");
    assert.equal(right.ok, true, right.reason);
  } finally {
    await m.cleanup();
  }
});

test("with nothing submitted to cite, the refusal says why and what to ask", async () => {
  const m = await mesh();
  try {
    await publish(m, "qa", "Draft report", "TestReport", false);
    const res = await m.supervisor.recordDecision("pm", "accept", "criterion:contract-met", "art-ghost", "QA's report");
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /Nothing submitted can evidence it yet \(a draft cannot\): ask the seat that wrote the report to submit it, then cite it/);
    assert.doesNotMatch(res.reason ?? "", /Cite one of these/);
  } finally {
    await m.cleanup();
  }
});

test("a report written by a seat that cannot verify is not offered either", async () => {
  const m = await mesh();
  try {
    // The pm holds neither quality.approve nor test.execute: its "verification report" is a summary, and an acceptance would be refused for it.
    await publish(m, "pm", "pm's summary of QA's findings", "TestReport", true);
    const real = await publish(m, "qa", "QA Verification Report", "TestReport", true);
    const res = await m.supervisor.recordDecision("pm", "accept", "criterion:contract-met", "art-ghost", "QA's report");
    assert.equal(res.ok, false);
    assert.ok((res.reason ?? "").includes(real), "the report a seat that can verify wrote");
    assert.doesNotMatch(res.reason ?? "", /pm's summary/, "not the pm's own summary of it");
  } finally {
    await m.cleanup();
  }
});

// ---- a verdict that names an id the mesh does not hold

test("the run-11 tech lead: a verdict on an id typed from memory is refused with the review it owes", async () => {
  const m = await mesh();
  try {
    const patch = await asked(m, "dev", "Implementation", "CodePatch", "tech-lead");
    const res = await m.supervisor.recordDecision("tech-lead", "approve", "implementation", "art-M3YBHXSZ", "LGTM");
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /^unknown artifact 'art-M3YBHXSZ' — nothing was recorded\. Name the artifact by the id or artifact:\/\/ URI its publish returned/, "the refusal it always was");
    assert.ok((res.reason ?? "").includes(`Still waiting for your verdict: CodePatch "Implementation" (${patch})`), "and the review that is on its desk");

    const right = await m.supervisor.recordDecision("tech-lead", "approve", "implementation", patch, "LGTM");
    assert.equal(right.ok, true, right.reason);
  } finally {
    await m.cleanup();
  }
});

test("with no review owed the refusal is what it was, and another seat's reviews are not named", async () => {
  const m = await mesh([LEAD2]);
  try {
    await asked(m, "dev", "Implementation", "CodePatch", "lead-2");
    const res = await m.supervisor.recordDecision("tech-lead", "approve", "implementation", "art-ghost", "LGTM");
    assert.equal(res.ok, false);
    assert.doesNotMatch(res.reason ?? "", /Still waiting for your verdict/, "the patch is lead-2's to rule on, not this seat's");
    assert.match(res.reason ?? "", /\(mesh_inbox and mesh_query_events show both\)\.$/, "nothing is appended");
  } finally {
    await m.cleanup();
  }
});

test("at most three are named, so the refusal stays a sentence", async () => {
  const m = await mesh();
  try {
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) ids.push(await asked(m, "dev", `Patch ${i}`, "CodePatch", "tech-lead"));
    const res = await m.supervisor.recordDecision("tech-lead", "approve", "implementation", "art-ghost", "LGTM");
    assert.equal(res.ok, false);
    const named = ids.filter((id) => (res.reason ?? "").includes(id));
    assert.equal(named.length, 3, `three of five: ${named.length}`);
  } finally {
    await m.cleanup();
  }
});

test("a review that is no longer awaiting a verdict is not named: another reviewer settled it first", async () => {
  const m = await mesh([LEAD2]);
  try {
    // Asked of both leads. lead-2 approves it, so it is APPROVED and tech-lead's own ask is still pending but moot.
    const settled = await publish(m, "dev", "Settled patch", "CodePatch", true);
    const ask = await m.supervisor.executeOp("dev", { op: "request_review", artifactId: settled, reviewers: ["tech-lead", "lead-2"] } as MeshOp, turnFor("dev"));
    assert.equal(ask.ok, true, String(ask.reason));
    const open = await asked(m, "dev", "Open patch", "CodePatch", "tech-lead");
    const ruled = await m.supervisor.recordDecision("lead-2", "approve", "implementation", settled, "fine");
    assert.equal(ruled.ok, true, ruled.reason);
    assert.equal(m.kernel.state.artifacts.get(settled)?.status, "APPROVED", "fixture: settled by the other reviewer");

    const res = await m.supervisor.recordDecision("tech-lead", "approve", "implementation", "art-ghost", "LGTM");
    assert.ok((res.reason ?? "").includes(open), "the one still open");
    assert.ok(!(res.reason ?? "").includes(settled), "not the one that is already approved: there is nothing left to rule on");
  } finally {
    await m.cleanup();
  }
});
