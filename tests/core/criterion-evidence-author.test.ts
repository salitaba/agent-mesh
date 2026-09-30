import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, evidenceContent } from "../helpers";
import { unqualifiedAuthor } from "../../packages/core/src/projections-helpers";

/**
 * A report that says "someone checked" is evidence only if a seat that can check wrote it.
 *
 * In the fourth cronlite run the pm (repository.read, requirements.accept, nothing else) wrote a
 * "Bug-Fix Verification Report" out of what QA had told it. `recordDecision` refused the DRAFT, so
 * the pm submitted the report itself — the owner may — and closed two mandatory criteria against
 * it while the product had still not been tested by anyone who could. The run report later flagged
 * a report "approved only by its own author"; this is the refusal that stops it being cited.
 *
 * Not a rule about who may ACCEPT: the pm accepting its own RequirementsDoc is by design. It is a
 * rule about what a verification artifact (TestReport, SecurityReport, BenchmarkResult) is worth
 * when the seat that wrote it could not have verified anything.
 */

const PM = { id: "pm", role: "product-manager", authority: ["requirements.accept"], capabilities: ["repository.read"], interests: [] };
const QA = { id: "qa", role: "qa", authority: ["quality.pass"], capabilities: ["repository.read", "test.execute", "test.write"], interests: [] };
const DEV = { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "test.execute", "git.commit"], interests: [] };
const ARCH = { id: "arch", role: "architect", authority: ["architecture.approve"], capabilities: ["repository.read", "architecture.write", "review.design"], interests: [] };
const SEC = { id: "sec", role: "security", authority: ["security.pass"], capabilities: ["repository.read", "security.scan", "security.review"], interests: [] };
const CRITERIA = [{ id: "cli-contract-met", description: "the CLI does what SPEC.md says, shown by QA", mandatory: true }];

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

async function mesh(agents: Array<Record<string, unknown>>, criteria = CRITERIA) {
  const ids = agents.map((a) => a.id as string);
  return makeMesh({
    agents,
    mayContact: Object.fromEntries(ids.map((id) => [id, ids.filter((o) => o !== id)])),
    criteria,
    mode: "parked",
  } as never);
}

/** `owner` publishes `name` as `type` and submits it: the state an acceptance can cite. */
async function submit(m: Mesh, owner: string, name: string, type: string): Promise<string> {
  const created = await m.supervisor.createArtifact({ actorId: owner, name, type: type as never, content: evidenceContent(name) });
  if (!("artifact" in created)) throw new Error(`create failed: ${JSON.stringify(created)}`);
  const moved = await m.supervisor.transitionArtifact(owner, created.artifact.id, { to: "READY_FOR_REVIEW" });
  assert.equal(moved.ok, true, String(moved.reason));
  return created.artifact.id;
}

const statusOf = (m: Mesh, id: string) => m.kernel.state.goals.get(m.kernel.state.activeGoalId!)!.acceptanceCriteria.find((c) => c.id === id)?.status;

test("a TestReport written by a seat that cannot verify is refused as evidence, with the route", async () => {
  const m = await mesh([PM, QA, DEV]);
  try {
    const report = await submit(m, "pm", "Bug-Fix Verification Report", "TestReport");
    const res = await m.supervisor.recordDecision("pm", "accept", "criterion:cli-contract-met", report, "QA verified it");
    assert.equal(res.ok, false, "the pm's own paraphrase of QA's findings is not a test report");
    assert.match(res.reason ?? "", /is a TestReport written by pm, which cannot verify one \(it holds neither quality\.approve nor test\.write\)/);
    assert.match(res.reason ?? "", /a summary of what someone else found is not one/);
    assert.match(res.reason ?? "", /Ask qa to publish its own report, then accept against that/, "the seat that can verify is named");
    const rejection = (await m.store.read({ types: ["message.rejected"] })).at(-1)!;
    assert.equal((rejection.payload as { ruleId: string }).ruleId, "mandatory-evidence-unqualified-author");
    assert.equal(statusOf(m, "cli-contract-met"), "UNSATISFIED", "nothing was recorded");
  } finally {
    await m.cleanup();
  }
});

test("the same criterion closes against a report the verifying seat wrote", async () => {
  const m = await mesh([PM, QA, DEV]);
  try {
    const report = await submit(m, "qa", "QA report", "TestReport");
    const res = await m.supervisor.recordDecision("pm", "accept", "criterion:cli-contract-met", report, "QA's own run");
    assert.equal(res.ok, true, res.reason);
    assert.equal(statusOf(m, "cli-contract-met"), "EVIDENCED");
  } finally {
    await m.cleanup();
  }
});

test("a developer's test report does not stand in for QA's when QA exists", async () => {
  const m = await mesh([PM, QA, DEV]);
  try {
    const report = await submit(m, "dev", "dev test notes", "TestReport");
    const res = await m.supervisor.recordDecision("pm", "accept", "criterion:cli-contract-met", report, "tests pass");
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /written by dev, which cannot verify one/);
  } finally {
    await m.cleanup();
  }
});

test("a SecurityReport is held to the same rule, and names the seat that can write one", async () => {
  const m = await mesh([PM, QA, DEV, SEC], [{ id: "security-clean", description: "scanned", mandatory: true }]);
  try {
    const dev = await submit(m, "dev", "my scan", "SecurityReport");
    const refused = await m.supervisor.recordDecision("pm", "accept", "criterion:security-clean", dev, "clean");
    assert.equal(refused.ok, false);
    assert.match(refused.reason ?? "", /is a SecurityReport written by dev, which cannot verify one \(it holds neither security\.approve nor security\.review\)/);
    assert.match(refused.reason ?? "", /Ask sec to publish its own report/);

    const sec = await submit(m, "sec", "scan report", "SecurityReport");
    const accepted = await m.supervisor.recordDecision("pm", "accept", "criterion:security-clean", sec, "clean");
    assert.equal(accepted.ok, true, accepted.reason);
  } finally {
    await m.cleanup();
  }
});

test("a document the acceptor wrote is still its evidence: the rule is about verification, not about authorship", async () => {
  // `arch` holds review.design, so a peer who could review the document exists: were the rule to
  // reach this type, the pm's own document would be refused and this would fail.
  const m = await mesh([PM, QA, DEV, ARCH], [{ id: "requirements-documented", description: "captured and accepted by the PM", mandatory: true }]);
  try {
    const doc = await submit(m, "pm", "Requirements", "RequirementsDoc");
    const res = await m.supervisor.recordDecision("pm", "accept", "criterion:requirements-documented", doc, "captured");
    assert.equal(res.ok, true, res.reason);
    assert.equal(statusOf(m, "requirements-documented"), "EVIDENCED");
  } finally {
    await m.cleanup();
  }
});

test("a mesh with no seat that could verify lets the only report there can be stand", async () => {
  // No test.write, no quality authority anywhere: refusing the dev's report would wedge the mission.
  const m = await mesh([PM, DEV]);
  try {
    const report = await submit(m, "dev", "dev test report", "TestReport");
    assert.equal(unqualifiedAuthor(m.kernel.state, m.kernel.state.artifacts.get(report)!), null);
    const res = await m.supervisor.recordDecision("pm", "accept", "criterion:cli-contract-met", report, "tests pass");
    assert.equal(res.ok, true, res.reason);
  } finally {
    await m.cleanup();
  }
});

test("the operator's acceptance is its own judgment and is not held to the rule", async () => {
  const m = await mesh([PM, QA, DEV]);
  try {
    const report = await submit(m, "pm", "Bug-Fix Verification Report", "TestReport");
    const res = await m.supervisor.recordDecision("human", "accept", "criterion:cli-contract-met", report, "I checked it myself");
    assert.equal(res.ok, true, res.reason);
  } finally {
    await m.cleanup();
  }
});

test("the predicate names who could have verified, in roster order, and skips a seat that has stopped", async () => {
  const m = await mesh([PM, QA, DEV, SEC]);
  try {
    const report = await submit(m, "pm", "pm report", "TestReport");
    const artifact = m.kernel.state.artifacts.get(report)!;
    assert.deepEqual(unqualifiedAuthor(m.kernel.state, artifact), { qualified: ["qa"] }, "sec holds no test authority");
    // A seat that is no longer running is not one anybody can be told to ask.
    m.kernel.state.agents.get("qa")!.state.lifecycle = "RETIRED";
    assert.equal(unqualifiedAuthor(m.kernel.state, artifact), null, "nobody left who could, so the carve-out applies");
  } finally {
    await m.cleanup();
  }
});
