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
 *
 * The eleventh run (2026-10-02), round one: QA wrote its test report (a DRAFT) and passed the merged PATCH five seconds later, so
 * the rule above did not apply (the pass did not name the report) and the report stayed a draft. The pm was nudged with nothing
 * it could cite, asked QA for the report's id, was refused twice for citing a draft, asked QA to submit it and waited for QA's
 * next turn: 3 min 13 s of a 10 min 29 s round. A pass that names a patch, or nothing, now submits the newest verification
 * report of the matching kind that the seat itself has written and not submitted, and the reply says so.
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

// ---- the pass names something else: the eleventh run's QA passed the merged patch and left its report a draft

async function submittedPatch(m: Mesh, name = "Implementation"): Promise<string> {
  const id = await draft(m, "dev", name, "CodePatch");
  const moved = await m.supervisor.transitionArtifact("dev", id, { to: "READY_FOR_REVIEW" });
  assert.equal(moved.ok, true, String(moved.reason));
  return id;
}

test("the run-11 slip: QA passes the patch while its test report is still a draft, and the report is submitted with the pass", async () => {
  const m = await mesh();
  try {
    const patch = await submittedPatch(m);
    const report = await draft(m, "qa", "QA Verification Report", "TestReport");
    const res = await m.supervisor.recordDecision("qa", "pass", "quality", patch, "44 unit tests and the CLI cases, against the merged commit");
    assert.equal(res.ok, true, res.reason);

    assert.equal(statusOf(m, report), "READY_FOR_REVIEW", "put forward by the pass, and not settled: the pass was about the patch");
    const submit = (await moves(m, report)).find((t) => t.to === "READY_FOR_REVIEW");
    assert.ok(submit, "the submission is on the record as a transition");
    assert.equal(submit.by, "qa", "the owner's own act");
    assert.match(submit.comment ?? "", /submitted with qa's own quality pass/, "that says why");
    assert.match(res.reason ?? "", /your TestReport "QA Verification Report" was still a DRAFT, which no other seat can see or cite, so it was submitted for review with this pass/, "and the seat is told, not left to find out");
    assert.equal(criterion(m, "quality-verified").status, "EVIDENCED", "the pass still closes the criterion, as it did");
    assert.equal(criterion(m, "quality-verified").evidence.at(-1)?.artifactRef?.uri, artifactUri("CodePatch", "Implementation", 1), "and still names the patch it was about");
  } finally {
    await m.cleanup();
  }
});

test("the report is citable at once: the pm's acceptance against it is recorded, where the draft was refused", async () => {
  const m = await mesh();
  try {
    const patch = await submittedPatch(m);
    const report = await draft(m, "qa", "QA Verification Report", "TestReport");
    const early = await m.supervisor.recordDecision("pm", "accept", "criterion:contract-met", report, "QA's report");
    assert.equal(early.ok, false, "what the eleventh run's pm met, twice");
    assert.match(early.reason ?? "", /is DRAFT and cannot evidence mandatory criterion 'contract-met'/);

    await m.supervisor.recordDecision("qa", "pass", "quality", patch, "tested the merged commit");
    const accepted = await m.supervisor.recordDecision("pm", "accept", "criterion:contract-met", report, "QA's report");
    assert.equal(accepted.ok, true, accepted.reason);
    assert.equal(criterion(m, "contract-met").status, "EVIDENCED");
  } finally {
    await m.cleanup();
  }
});

test("a pass with no report of the seat's own to submit says nothing about one, and a subject-level pass submits the report too", async () => {
  const m = await mesh();
  try {
    const patch = await submittedPatch(m);
    const bare = await m.supervisor.recordDecision("qa", "pass", "quality", patch, "ran the suite");
    assert.equal(bare.ok, true, bare.reason);
    assert.doesNotMatch(bare.reason ?? "", /DRAFT|submitted for review/, "nothing to submit, nothing to say");
  } finally {
    await m.cleanup();
  }
  const n = await mesh();
  try {
    const report = await draft(n, "qa", "QA Verification Report", "TestReport");
    const res = await n.supervisor.recordDecision("qa", "pass", "quality", undefined, "ran the suite against main");
    assert.equal(res.ok, true, res.reason);
    assert.equal(statusOf(n, report), "READY_FOR_REVIEW", "a verdict with no artifact on it puts the report forward as well");
  } finally {
    await n.cleanup();
  }
});

test("only the giver's own report: another seat's draft, and a draft of any other kind, are left alone", async () => {
  const m = await mesh();
  try {
    const patch = await submittedPatch(m);
    const devs = await draft(m, "dev", "dev test notes", "TestReport");
    const notes = await draft(m, "qa", "decision notes", "ADR");
    const res = await m.supervisor.recordDecision("qa", "pass", "quality", patch, "I ran them");
    assert.equal(res.ok, true, res.reason);
    assert.equal(statusOf(m, devs), "DRAFT", "the owner decides when its work is put forward");
    assert.equal(statusOf(m, notes), "DRAFT", "an ADR is not a verification report");
    assert.equal((await moves(m, devs)).length + (await moves(m, notes)).length, 0, "no transition was made on anyone's behalf");
    assert.deepEqual((await m.store.read({ types: ["message.rejected"] })).map((e) => (e.payload as { action?: string }).action), [], "and none was refused on the way");
    assert.doesNotMatch(res.reason ?? "", /submitted for review/);
  } finally {
    await m.cleanup();
  }
});

test("only a report that settles the domain: a security pass submits the security report and leaves the test report", async () => {
  const m = await mesh();
  try {
    const patch = await submittedPatch(m);
    const scan = await draft(m, "sec", "Security Scan", "SecurityReport");
    await new Promise((r) => setTimeout(r, 5)); // the test report is the newer draft: only its domain can keep it out
    const tests = await draft(m, "sec", "sec's test notes", "TestReport");
    const res = await m.supervisor.recordDecision("sec", "pass", "security", patch, "no criticals");
    assert.equal(res.ok, true, res.reason);
    assert.equal(statusOf(m, scan), "READY_FOR_REVIEW", "the report of its own domain");
    assert.equal(statusOf(m, tests), "DRAFT", "not a test report: that is a quality report, and this was a security pass");
    assert.match(res.reason ?? "", /your SecurityReport "Security Scan" was still a DRAFT/);
  } finally {
    await m.cleanup();
  }
});

test("only the newest report: an older draft the seat abandoned stays a draft", async () => {
  const m = await mesh();
  try {
    const patch = await submittedPatch(m);
    const old = await draft(m, "qa", "Round 1 attempt", "TestReport");
    await new Promise((r) => setTimeout(r, 5)); // a later createdAt, whatever the clock's resolution
    const fresh = await draft(m, "qa", "Verification Report", "TestReport");
    const res = await m.supervisor.recordDecision("qa", "pass", "quality", patch, "tested the merged commit");
    assert.equal(res.ok, true, res.reason);
    assert.equal(statusOf(m, fresh), "READY_FOR_REVIEW");
    assert.equal(statusOf(m, old), "DRAFT", "stale evidence is not handed to the acceptors");
    assert.match(res.reason ?? "", /"Verification Report" was still a DRAFT/);
    assert.doesNotMatch(res.reason ?? "", /Round 1 attempt/);
  } finally {
    await m.cleanup();
  }
});

test("a draft left from an earlier goal is not put forward by a later goal's pass", async () => {
  const m = await mesh();
  try {
    const stale = await draft(m, "qa", "Earlier attempt", "TestReport");
    await m.supervisor.createGoal({ description: "the next mission", acceptanceCriteria: [{ id: "quality-verified", description: "the tests pass", mandatory: true }] });
    const patch = await submittedPatch(m, "Implementation of the next mission");
    const res = await m.supervisor.recordDecision("qa", "pass", "quality", patch, "tested");
    assert.equal(res.ok, true, res.reason);
    assert.equal(statusOf(m, stale), "DRAFT", "another mission's draft is not this mission's evidence");
    assert.doesNotMatch(res.reason ?? "", /submitted for review/);
  } finally {
    await m.cleanup();
  }
});

test("passing one report does not submit another: the pass that names a report keeps the rule it had", async () => {
  const m = await mesh();
  try {
    const other = await draft(m, "qa", "Scratch notes", "TestReport");
    await new Promise((r) => setTimeout(r, 5));
    const named = await draft(m, "qa", "Verification Report", "TestReport");
    const res = await m.supervisor.recordDecision("qa", "pass", "quality", named, "31/31");
    assert.equal(res.ok, true, res.reason);
    assert.equal(statusOf(m, named), "FINAL", "the one it named: submitted, then settled by the pass");
    assert.equal(statusOf(m, other), "DRAFT", "the other was not named");
  } finally {
    await m.cleanup();
  }
});

test("a pass that is refused submits nothing, and a repeat pass submits nothing twice", async () => {
  const m = await mesh();
  try {
    const patch = await submittedPatch(m);
    // The pm holds no quality authority: the pass is refused before anything else happens.
    const report = await draft(m, "pm", "pm's own verification notes", "TestReport");
    const refused = await m.supervisor.recordDecision("pm", "pass", "quality", patch, "I looked");
    assert.equal(refused.ok, false, "refused for lack of authority");
    assert.equal(statusOf(m, report), "DRAFT", "the refusal left the draft as it was");
    assert.equal((await moves(m, report)).length, 0);
  } finally {
    await m.cleanup();
  }
  const n = await mesh();
  try {
    const patch = await submittedPatch(n);
    const report = await draft(n, "qa", "QA Verification Report", "TestReport");
    await n.supervisor.recordDecision("qa", "pass", "quality", patch, "tested");
    const again = await n.supervisor.recordDecision("qa", "pass", "quality", patch, "tested again");
    assert.equal(again.ok, true, again.reason);
    assert.equal((await moves(n, report)).filter((t) => t.to === "READY_FOR_REVIEW").length, 1, "submitted once");
    assert.doesNotMatch(again.reason ?? "", /submitted for review with this pass/, "and the second pass has nothing to announce");
  } finally {
    await n.cleanup();
  }
});
