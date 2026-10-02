import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, goalOf, evidenceContent } from "../helpers";
import { artifactUri } from "../../packages/protocol/src/index";

/**
 * A seat that passes the verification report it wrote submits it, because the pass is its way of putting the report forward.
 *
 * The ninth cronlite run (2026-10-02), round one. QA tested the merged product, published its test report and gave
 * `mesh_approve kind:"pass"` on it, all in one turn. The report was a DRAFT, so the pass could not settle it, and the reply
 * said "move it to review first if you meant to approve the work": a hint to a seat whose business was the product and not
 * the report, and QA did not follow it. A DRAFT is shown to nobody but its owner (a test report is work-scoped) and an
 * acceptance refuses it as evidence. So the pm and the architect, who had never been told the report existed, spent six
 * turns and four minutes asking for one (each ask was declined: "test reports are QA's"), the pm asked QA for a report QA
 * had published three minutes before, and only then was QA asked to submit it and the pm's acceptance taken. Runs 7 and 8
 * lost one to two minutes the same way, and five of the nine passes in runs 6 to 9 were given on a draft, each on the report
 * QA itself had just written.
 *
 * Now the pass submits the report first. This is the owner's own transition, under the same gates, taken only after every
 * refusal a pass can meet, so a refused pass leaves the report as it was.
 */

const DEV = { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "test.execute", "git.commit"], interests: [] };
const QA = { id: "qa", role: "qa", authority: ["quality.block", "quality.pass"], capabilities: ["repository.read", "test.execute", "test.write"], interests: [] };
const SEC = { id: "sec", role: "security", authority: ["security.block", "security.pass"], capabilities: ["repository.read", "security.scan", "security.review"], interests: [] };
const PM = { id: "pm", role: "product-manager", authority: ["requirements.accept"], capabilities: ["repository.read"], interests: [] };
// A second seat that could review a test report: with it present, a seat may not sign off its own.
const QA2 = { id: "qa2", role: "qa", authority: ["quality.approve", "quality.pass"], capabilities: ["repository.read", "test.execute", "test.write"], interests: [] };

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

function mesh(extra: Array<Record<string, unknown>> = []): Promise<Mesh> {
  const agents = [DEV, QA, SEC, PM, ...extra];
  const ids = agents.map((a) => a.id as string);
  return makeMesh({
    agents,
    mayContact: Object.fromEntries(ids.map((id) => [id, ids.filter((o) => o !== id)])),
    criteria: [
      { id: "quality-verified", description: "the tests pass", mandatory: true },
      { id: "security-verified", description: "no criticals", mandatory: true },
      { id: "contract-met", description: "the product does what the goal says, shown by a QA report", mandatory: true },
    ],
    mode: "parked",
  } as never);
}

async function draft(m: Mesh, owner: string, name: string, type: string): Promise<string> {
  const created = await m.supervisor.createArtifact({ actorId: owner, name, type: type as never, content: evidenceContent(name) });
  if (!("artifact" in created)) throw new Error(`create failed: ${JSON.stringify(created)}`);
  assert.equal(m.kernel.state.artifacts.get(created.artifact.id)?.status, "DRAFT", "fixture: published, not submitted");
  return created.artifact.id;
}

const statusOf = (m: Mesh, id: string) => m.kernel.state.artifacts.get(id)?.status;
const criterion = (m: Mesh, id: string) => goalOf(m)!.acceptanceCriteria.find((c) => c.id === id)!;
const moves = async (m: Mesh, artifactId: string) =>
  (await m.store.read({ types: ["artifact.transition"] }))
    .map((e) => ({ ...(e.payload as { artifactId: string; from?: string; to: string; actorId?: string; derived?: boolean; comment?: string }), by: e.actorId }))
    .filter((p) => p.artifactId === artifactId);

test("QA passes its own draft test report: the report is submitted by that act, and the pass settles it", async () => {
  const m = await mesh();
  try {
    const report = await draft(m, "qa", "Quality Verification Report", "TestReport");
    const res = await m.supervisor.recordDecision("qa", "pass", "quality", report, "31/31, and every CLI case");
    assert.equal(res.ok, true, res.reason);

    assert.equal(statusOf(m, report), "FINAL", "submitted, then settled by the pass");
    const trail = await moves(m, report);
    const submit = trail.find((t) => t.to === "READY_FOR_REVIEW");
    assert.ok(submit, "the submission is on the record as a transition");
    assert.equal(submit.by, "qa", "by the owner, as its own act");
    assert.match(submit.comment ?? "", /submitted with qa's own quality pass/, "and says why");
    assert.ok(trail.some((t) => t.to === "FINAL"), "the pass then took it to FINAL");

    assert.doesNotMatch(res.reason ?? "", /move it to review first|cannot advance/, "so the seat is not sent after a step the mesh took for it");
    assert.equal(criterion(m, "quality-verified").status, "EVIDENCED", "the pass still closes the criterion");
    assert.equal(criterion(m, "quality-verified").evidence.at(-1)?.artifactRef?.uri, artifactUri("TestReport", "Quality Verification Report", 1), "and, the report being submitted work, it names it");
  } finally {
    await m.cleanup();
  }
});

test("the report is citable at once: the pm's acceptance against it is recorded, where a draft is refused", async () => {
  const m = await mesh();
  try {
    const report = await draft(m, "qa", "Quality Verification Report", "TestReport");

    // What the ninth run's pm met: an acceptance against QA's report while it was still a draft.
    const early = await m.supervisor.recordDecision("pm", "accept", "criterion:contract-met", report, "QA's report");
    assert.equal(early.ok, false, "a draft is not evidence");
    assert.match(early.reason ?? "", /is DRAFT and cannot evidence mandatory criterion 'contract-met'/);

    await m.supervisor.recordDecision("qa", "pass", "quality", report, "31/31");
    const accepted = await m.supervisor.recordDecision("pm", "accept", "criterion:contract-met", report, "QA's report");
    assert.equal(accepted.ok, true, accepted.reason);
    assert.equal(accepted.reason, undefined, "nothing to add: it is cited and it counts");
    assert.equal(criterion(m, "contract-met").status, "EVIDENCED");
  } finally {
    await m.cleanup();
  }
});

test("a security seat that passes its own scan report submits it the same way", async () => {
  const m = await mesh();
  try {
    const report = await draft(m, "sec", "Security Scan", "SecurityReport");
    const res = await m.supervisor.recordDecision("sec", "pass", "security", report, "no criticals");
    assert.equal(res.ok, true, res.reason);
    assert.equal(statusOf(m, report), "FINAL");
    assert.equal(criterion(m, "security-verified").status, "EVIDENCED");
  } finally {
    await m.cleanup();
  }
});

test("a pass on a draft somebody else wrote submits nothing: the owner decides when its work is put forward", async () => {
  const m = await mesh();
  try {
    const report = await draft(m, "dev", "dev test notes", "TestReport");
    const res = await m.supervisor.recordDecision("qa", "pass", "quality", report, "I ran them");
    assert.equal(res.ok, true, res.reason);
    assert.equal(statusOf(m, report), "DRAFT", "still the owner's to submit");
    assert.equal((await moves(m, report)).length, 0, "no transition was made on dev's behalf");
    // Nor was one attempted: the transition gate would refuse a seat that does not own the report, and the refusal is a
    // rejection on the record, charged to QA, for a move QA never meant to make.
    assert.deepEqual((await m.store.read({ types: ["message.rejected"] })).map((e) => (e.payload as { action?: string }).action), [], "and nothing was refused on the way");
    assert.match(res.reason ?? "", /is DRAFT and an approval cannot advance it from there — move it to review first/, "and the route that exists is still named");
    assert.equal(criterion(m, "quality-verified").evidence.at(-1)?.artifactRef, undefined, "a draft is not named as evidence (pass-evidence.test.ts)");
  } finally {
    await m.cleanup();
  }
});

test("only a verification report is submitted: a draft of any other kind the passer owns stays a draft", async () => {
  const m = await mesh();
  try {
    // (A ResearchReport would not do: the mesh submits that one itself on delivery. An ADR stays a draft until its owner says.)
    const notes = await draft(m, "qa", "decision notes", "ADR");
    const res = await m.supervisor.recordDecision("qa", "pass", "quality", notes, "looked at it");
    assert.equal(res.ok, true, res.reason);
    assert.equal(statusOf(m, notes), "DRAFT");
    assert.equal((await moves(m, notes)).length, 0);
  } finally {
    await m.cleanup();
  }
});

test("a pass that is refused submits nothing: with a peer who could review it, a seat may not sign off its own report", async () => {
  const m = await mesh([QA2]);
  try {
    const report = await draft(m, "qa", "Quality Verification Report", "TestReport");
    const res = await m.supervisor.recordDecision("qa", "pass", "quality", report, "31/31");
    assert.equal(res.ok, false, "refused: qa2 could review it");
    assert.match(res.reason ?? "", /artifact owner cannot approve their own artifact/);
    assert.equal(statusOf(m, report), "DRAFT", "the refusal left the report as it was");
    assert.equal((await moves(m, report)).length, 0, "and moved nothing on the way");
    assert.notEqual(criterion(m, "quality-verified").status, "EVIDENCED");
  } finally {
    await m.cleanup();
  }
});

test("a report already submitted is passed as before, and a repeat pass does not submit it twice", async () => {
  const m = await mesh();
  try {
    const report = await draft(m, "qa", "Quality Verification Report", "TestReport");
    await m.supervisor.transitionArtifact("qa", report, { to: "READY_FOR_REVIEW" });
    const before = (await moves(m, report)).length;
    const res = await m.supervisor.recordDecision("qa", "pass", "quality", report, "31/31");
    assert.equal(res.ok, true, res.reason);
    const trail = await moves(m, report);
    assert.equal(trail.filter((t) => t.to === "READY_FOR_REVIEW").length, 1, "submitted once, by its owner, before the pass");
    assert.equal(trail.length, before + 1, "the pass added only its own settling move");

    const again = await m.supervisor.recordDecision("qa", "pass", "quality", report, "31/31 again");
    assert.equal(again.ok, true, again.reason);
    assert.equal((await moves(m, report)).filter((t) => t.to === "READY_FOR_REVIEW").length, 1, "never submitted twice");
  } finally {
    await m.cleanup();
  }
});
