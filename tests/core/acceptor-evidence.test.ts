import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, goalOf, waitFor, evidenceContent } from "../helpers";
import { buildAgentContext, renderContextInstructions } from "../../packages/core/src/context";

/**
 * A seat that can accept criteria is shown the evidence it could cite.
 *
 * The ninth cronlite run (2026-10-02). QA published its test report and passed it; the pm, who alone can accept the
 * contract criteria, never saw it. A test report is work-scoped, and a briefing shows a work-scoped artifact to its owner,
 * to whoever is mailed it and while it awaits a verdict, so once QA's pass had settled it nobody else's briefing carried it.
 * The pm and the architect spent six turns and four minutes asking for a report that sat submitted in the store (each ask was
 * declined: "test reports are QA's"), and round two sat idle for three minutes with three criteria open that only the pm
 * could close. Runs 7 and 8 asked QA for a report QA had already published too.
 *
 * Now the briefing of a seat that may accept criteria lists the artifacts an acceptance could cite while a mandatory
 * criterion that needs an acceptance is open, and says on the line that it may. It is the list the stall watchdog already
 * offered (`citableEvidence`), so what the briefing offers is what the acceptance then takes.
 */

const DEV = { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "test.execute", "git.commit"], interests: [] };
const QA = { id: "qa", role: "qa", authority: ["quality.block", "quality.pass"], capabilities: ["repository.read", "test.execute", "test.write"], interests: [] };
const PM = { id: "pm", role: "product-manager", authority: ["requirements.accept"], capabilities: ["repository.read"], interests: [] };

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

function mesh(): Promise<Mesh> {
  const agents = [DEV, QA, PM];
  const ids = agents.map((a) => a.id);
  return makeMesh({
    agents,
    mayContact: Object.fromEntries(ids.map((id) => [id, ids.filter((o) => o !== id)])),
    criteria: [
      { id: "quality-verified", description: "the tests pass", mandatory: true },
      { id: "contract-met", description: "the product does what the goal says, shown by a QA report", mandatory: true },
    ],
    mode: "parked",
  } as never);
}

async function report(m: Mesh, owner: string, name: string, submit: boolean): Promise<string> {
  const created = await m.supervisor.createArtifact({ actorId: owner, name, type: "TestReport", content: evidenceContent(name) });
  if (!("artifact" in created)) throw new Error(`create failed: ${JSON.stringify(created)}`);
  if (submit) {
    const moved = await m.supervisor.transitionArtifact(owner, created.artifact.id, { to: "READY_FOR_REVIEW" });
    assert.equal(moved.ok, true, String(moved.reason));
  }
  return created.artifact.id;
}

const briefing = (m: Mesh, seat: string) => buildAgentContext({ config: m.config, kernel: m.kernel }, seat);
const line = (m: Mesh, seat: string, name: string) =>
  renderContextInstructions(briefing(m, seat)).split("\n").find((l) => l.startsWith("- ") && l.includes(name));
const entry = (m: Mesh, seat: string, name: string) => briefing(m, seat).relevantArtifacts.find((a) => a.name === name);
const CITE = /submitted: you may accept a criterion that is still open against it/;

test("the pm is shown the report QA submitted and passed, on a line that says it may cite it", async () => {
  const m = await mesh();
  try {
    const id = await report(m, "qa", "Quality Verification Report", true);
    const passed = await m.supervisor.recordDecision("qa", "pass", "quality", id, "31/31");
    assert.equal(passed.ok, true, passed.reason);
    assert.equal(m.kernel.state.artifacts.get(id)?.status, "FINAL", "fixture: the pass settled it, which is what took it out of every other briefing");

    assert.equal(entry(m, "pm", "Quality Verification Report")?.citable, true);
    const shown = line(m, "pm", "Quality Verification Report");
    assert.ok(shown, "the pm's briefing lists it");
    assert.match(shown!, CITE, "and says what it is for");
    assert.match(shown!, /TestReport, FINAL/);
  } finally {
    await m.cleanup();
  }
});

test("a draft is not offered: an acceptance would refuse it", async () => {
  const m = await mesh();
  try {
    await report(m, "qa", "Half-written Report", false);
    assert.equal(entry(m, "pm", "Half-written Report"), undefined, "a draft is shown to its owner only");
  } finally {
    await m.cleanup();
  }
});

test("a seat that cannot accept criteria is not offered it, and the owner is shown its own report without the line", async () => {
  const m = await mesh();
  try {
    const id = await report(m, "qa", "Quality Verification Report", true);
    await m.supervisor.recordDecision("qa", "pass", "quality", id, "31/31");
    assert.equal(entry(m, "dev", "Quality Verification Report"), undefined, "the developer has no use for it and is not shown it");
    const own = entry(m, "qa", "Quality Verification Report");
    assert.ok(own, "QA's own report is in its briefing as always");
    assert.equal(own!.citable, undefined, "but QA cannot accept a criterion, so it is not told it may");
  } finally {
    await m.cleanup();
  }
});

test("it is offered while a criterion that needs an acceptance is open, and not after", async () => {
  const m = await mesh();
  try {
    const id = await report(m, "qa", "Quality Verification Report", true);
    await m.supervisor.recordDecision("qa", "pass", "quality", id, "31/31");
    assert.ok(entry(m, "pm", "Quality Verification Report")?.citable, "contract-met is open");

    const accepted = await m.supervisor.recordDecision("pm", "accept", "criterion:contract-met", id, "QA's run");
    assert.equal(accepted.ok, true, accepted.reason);
    assert.equal(goalOf(m)!.acceptanceCriteria.find((c) => c.id === "contract-met")?.status, "EVIDENCED");
    assert.equal(entry(m, "pm", "Quality Verification Report"), undefined, "nothing is left to accept, so the report is no longer put in front of the pm");
  } finally {
    await m.cleanup();
  }
});

test("a criterion the mesh evidences itself does not count: only one that needs an acceptance puts evidence in front of the pm", async () => {
  const m = await makeMesh({
    agents: [DEV, QA, PM],
    mayContact: { dev: ["qa", "pm"], qa: ["dev", "pm"], pm: ["dev", "qa"] },
    criteria: [{ id: "quality-verified", description: "the tests pass", mandatory: true }],
    mode: "parked",
  } as never);
  try {
    // `quality-verified` is closed by QA's own pass, and an acceptance is not what it waits for. A submitted report is in every
    // briefing while it awaits a verdict, and it is not offered to the pm as something to cite: nothing is open for it to close.
    const created = await m.supervisor.createArtifact({ actorId: "qa", name: "Report", type: "TestReport", content: evidenceContent("Report") });
    if (!("artifact" in created)) throw new Error("create failed");
    await m.supervisor.transitionArtifact("qa", created.artifact.id, { to: "READY_FOR_REVIEW" });
    assert.equal(goalOf(m)!.acceptanceCriteria.find((c) => c.id === "quality-verified")?.status, "UNSATISFIED", "fixture: still open");
    const shown = entry(m, "pm", "Report");
    assert.ok(shown, "it awaits a verdict, so it is in the briefing as always");
    assert.equal(shown!.citable, undefined, "but not as evidence for a criterion no acceptance can close");

    await m.supervisor.recordDecision("qa", "pass", "quality", created.artifact.id, "ok");
    assert.equal(entry(m, "pm", "Report"), undefined, "and once QA's pass settled it, nothing puts it back");
  } finally {
    await m.cleanup();
  }
});

test("what the operator rejected at a reopen is not offered again", async () => {
  const m = await mesh();
  try {
    const id = await report(m, "qa", "Quality Verification Report", true);
    await m.supervisor.recordDecision("qa", "pass", "quality", id, "31/31");
    await m.supervisor.recordDecision("pm", "accept", "criterion:contract-met", id, "QA's run");
    await m.supervisor.recordDecision("pm", "accept", "criterion:quality-verified", id, "QA's pass");

    const gid = m.kernel.state.activeGoalId!;
    for (const rec of [...m.kernel.state.agents.values()]) {
      if (rec.state.agentId === "human" || rec.state.lifecycle !== "STARTING") continue;
      await m.kernel.emit("agent.started", { agentId: rec.state.agentId }, { actorId: "system" });
    }
    if (goalOf(m)?.status !== "COMPLETED") await m.kernel.emit("goal.completed", { goalId: gid, reason: "test completion", evidence: [] }, { actorId: "human" });
    await (m.supervisor as unknown as { completeMission(): Promise<void> }).completeMission();
    await waitFor("mission completed", () => goalOf(m)?.status === "COMPLETED", 8000);
    const reopened = await m.supervisor.reopenGoal({ reason: "the contract is not met", criteria: ["contract-met"] });
    assert.equal(reopened.ok, true, reopened.reason);

    assert.equal(goalOf(m)!.acceptanceCriteria.find((c) => c.id === "contract-met")?.status, "UNSATISFIED");
    assert.equal(entry(m, "pm", "Quality Verification Report"), undefined, "the report the operator rejected is not put back in front of the seat that would cite it");
  } finally {
    await m.cleanup();
  }
});

test("a report written by a seat that cannot verify is not offered either", async () => {
  const m = await mesh();
  try {
    // The pm's own paraphrase of what QA said: an acceptance refuses it (`unqualifiedAuthor`), so it is not offered.
    const id = await report(m, "pm", "Summary of what QA told me", true);
    const own = entry(m, "pm", "Summary of what QA told me");
    assert.ok(own, "it is the pm's own artifact and stays in its briefing");
    assert.equal(own!.citable, undefined);
    assert.equal(m.kernel.state.artifacts.get(id)?.status, "READY_FOR_REVIEW");
  } finally {
    await m.cleanup();
  }
});
