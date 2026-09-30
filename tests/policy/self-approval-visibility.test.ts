import { test } from "node:test";
import assert from "node:assert/strict";
import { evidenceContent, makeMesh } from "../helpers";
import { buildRunReport, renderRunReport } from "../../packages/core/src/run-report";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * An author may approve its own artifact only when nobody else could have, and then
 * the record says so.
 *
 * The self-approval screen is conditional on a peer existing: if no other seat holds
 * the artifact type's review capability or the domain's approve authority, the owner
 * settles its own work (the single-agent control group depends on it, and a mesh of one
 * reviewer must converge). In the cronlite run that is what happened to the TestReport:
 * qa published it, submitted it and approved it to FINAL, and the PM cited it as
 * evidence, with nothing anywhere saying the verdict was the author's own.
 *
 * Nothing about WHEN it is allowed changes. What changes is that it is no longer
 * silent: the seat is told at the moment, and the run report flags a delivered artifact
 * approved only by its owner.
 */

const QA = { id: "qa", role: "qa", capabilities: ["repository.read", "test.write"], authority: ["quality.approve"], interests: [] };
const PM = { id: "pm", role: "product-manager", capabilities: ["repository.read"], authority: ["requirements.accept"], interests: [] };
// A second tester: a peer who CAN review a TestReport.
const QA2 = { id: "qa2", role: "qa", capabilities: ["repository.read", "test.write"], authority: ["quality.approve"], interests: [] };

const turnFor = (agentId: string) =>
  ({ turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`, agentId, reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] }) as never;

type Mesh = Awaited<ReturnType<typeof makeMesh>>;
const op = (m: Mesh, actor: string, o: MeshOp) => m.supervisor.executeOp(actor, o, turnFor(actor));

async function submittedReport(m: Mesh, content = "ran the suite, 39 passed, 0 failed — with the commands and their output"): Promise<string> {
  const created = await m.supervisor.createArtifact({ actorId: "qa", name: "test-report", type: "TestReport", content });
  if (!("artifact" in created)) throw new Error("create failed");
  const moved = await m.supervisor.transitionArtifact("qa", created.artifact.id, { to: "READY_FOR_REVIEW" });
  assert.equal(moved.ok, true, moved.reason);
  return created.artifact.id;
}

test("with no peer who could review it, an author's approval settles its own artifact, and says it was the author's", async () => {
  const m = await makeMesh({ agents: [QA, PM], mayContact: { qa: ["pm"], pm: ["qa"] }, mode: "parked" });
  try {
    const id = await submittedReport(m);
    const res = await op(m, "qa", { op: "approve", subject: "quality", artifactId: id } as MeshOp);

    assert.equal(res.ok, true, res.reason);
    assert.equal(res.caveat, true, "the seat is told, through the caveat channel, at the moment it happens");
    assert.match(String(res.reason), /no other seat could review this TestReport, so your own approval settled it/);
    assert.match(String(res.reason), /the run report lists it as self-approved/);
    assert.ok(["APPROVED", "FINAL"].includes(m.kernel.state.artifacts.get(id)!.status), "it still settles: nothing about WHEN this is allowed changed");

    const report = buildRunReport(m.kernel.state);
    const delivered = report.delivered.find((a) => a.id === id);
    assert.equal(delivered?.selfApproved, true);
    assert.match(renderRunReport(report), /approved only by its own author \(qa\) — no other seat could review it/);
  } finally {
    await m.cleanup();
  }
});

test("with a peer, the author's own approval is still refused, and the peer's settles it with no caveat", async () => {
  const m = await makeMesh({ agents: [QA, QA2, PM], mayContact: { qa: ["qa2", "pm"], qa2: ["qa"], pm: ["qa"] }, mode: "parked" });
  try {
    const id = await submittedReport(m);
    const own = await op(m, "qa", { op: "approve", subject: "quality", artifactId: id } as MeshOp);
    assert.equal(own.ok, false, "a peer exists, so the author may not settle its own work");
    assert.match(String(own.reason), /cannot approve their own artifact/);

    const peer = await op(m, "qa2", { op: "approve", subject: "quality", artifactId: id } as MeshOp);
    assert.equal(peer.ok, true, peer.reason);
    assert.equal(peer.caveat, undefined);

    const report = buildRunReport(m.kernel.state);
    const delivered = report.delivered.find((a) => a.id === id);
    assert.ok(delivered, "fixture: the report delivered it");
    assert.equal(delivered.selfApproved, undefined, "approved by a peer, so nothing to flag");
    assert.doesNotMatch(renderRunReport(report), /own author/);
  } finally {
    await m.cleanup();
  }
});

test("an artifact approved by its author AND by someone else is not flagged", async () => {
  const m = await makeMesh({ agents: [QA, PM], mayContact: { qa: ["pm"], pm: ["qa"] }, mode: "parked" });
  try {
    const id = await submittedReport(m);
    await op(m, "qa", { op: "approve", subject: "quality", artifactId: id } as MeshOp);
    // The operator signs it too (or any seat with standing): it is no longer the author's word alone.
    const human = await m.supervisor.recordDecision("human", "approve", "quality", id, "read it");
    assert.equal(human.ok, true, human.reason);
    const delivered = buildRunReport(m.kernel.state).delivered.find((a) => a.id === id);
    assert.ok(delivered);
    assert.equal(delivered.selfApproved, undefined);
  } finally {
    await m.cleanup();
  }
});

test("the PM accepting a criterion on the strength of the report is not a second review of it", async () => {
  // The real shape, and the one the first test above does not have. In the cronlite run the
  // PM cited QA's self-approved TestReport as the evidence for three criteria, and each
  // acceptance is an `approve` record that carries the report's artifactId. Counted as
  // approvals of the report they made the run report say "approved by someone else", so the
  // flag the approval-time caveat promises ("the run report lists it as self-approved") never
  // fired, on either of the run's two reports.
  const m = await makeMesh({
    agents: [QA, PM],
    mayContact: { qa: ["pm"], pm: ["qa"] },
    mode: "parked",
    criteria: [{ id: "quality-verified", description: "QA verification passed, backed by a test report" }],
  });
  try {
    const id = await submittedReport(m, evidenceContent("ran the suite: 39 passed, 0 failed"));
    const own = await op(m, "qa", { op: "approve", subject: "quality", artifactId: id } as MeshOp);
    assert.equal(own.ok, true, own.reason);

    const accepted = await m.supervisor.recordDecision("pm", "approve", "criterion:quality-verified", id, "the report says the suite passes");
    assert.equal(accepted.ok, true, accepted.reason);
    const records = [...m.kernel.state.approvals.values()].flat().filter((r) => r.artifactId === id);
    assert.ok(records.some((r) => r.actorId === "pm" && r.subject.startsWith("criterion:")), "fixture: the PM's acceptance is on the record with the report's id");

    const report = buildRunReport(m.kernel.state);
    const delivered = report.delivered.find((a) => a.id === id);
    assert.ok(delivered, "fixture: the report delivered it");
    assert.equal(delivered.selfApproved, true, "the PM's acceptance of a criterion is not a review of the artifact it cites");
    assert.match(renderRunReport(report), /approved only by its own author \(qa\)/);
  } finally {
    await m.cleanup();
  }
});

test("a real second reviewer still clears the flag when a criterion acceptance is also on the record", async () => {
  const m = await makeMesh({
    agents: [QA, PM],
    mayContact: { qa: ["pm"], pm: ["qa"] },
    mode: "parked",
    criteria: [{ id: "quality-verified", description: "QA verification passed, backed by a test report" }],
  });
  try {
    const id = await submittedReport(m, evidenceContent("ran the suite: 39 passed, 0 failed"));
    await op(m, "qa", { op: "approve", subject: "quality", artifactId: id } as MeshOp);
    const cited = await m.supervisor.recordDecision("pm", "approve", "criterion:quality-verified", id, "cited");
    assert.equal(cited.ok, true, cited.reason);
    const human = await m.supervisor.recordDecision("human", "approve", "quality", id, "read it");
    assert.equal(human.ok, true, human.reason);
    const delivered = buildRunReport(m.kernel.state).delivered.find((a) => a.id === id);
    assert.ok(delivered);
    assert.equal(delivered.selfApproved, undefined);
  } finally {
    await m.cleanup();
  }
});
