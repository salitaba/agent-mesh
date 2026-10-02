import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, goalOf, evidenceContent } from "../helpers";
import { createMcpToolset } from "../../apps/mesh-server/src/mcp";
import { mintSeatToken } from "../../packages/core/src/seat-token";
import { canEnterReview } from "../../packages/core/src/projections-helpers";
import { artifactUri } from "../../packages/protocol/src/index";
import type { AgentEventToolCall, AgentEventToolCallUpdate, AgentInput, MeshOp, ToolCallRecord } from "../../packages/protocol/src/index";

/**
 * A verdict that did not close its criterion says so, and a pass names what it passed.
 *
 * The eighth cronlite run (2026-10-02), round two. The operator had reopened `quality-verified` and three
 * others. QA tested the fix, published a defect report, and gave `mesh_approve kind:"pass"` on it from a
 * turn that had run its tests in the one before. The turn invoked no verification tool, so the verdict
 * landed ASSERTED, which counts for nothing, and the reply said `ok` with no word about it. QA told the
 * tech lead the verdict was recorded. The tech lead, seeing `quality-verified` still open, asked QA to move
 * the report back to review (it was FINAL, so the move was refused) and then to pass the round-one report
 * instead, and QA did, at the commit of round one: 45 tests, not the 61 of the fix. The mission completed
 * five and a half minutes after the first pass on a verdict about the product as it stood before the fix.
 *
 * Three things were wrong, and each is pinned here:
 *
 *  - a pass or an acceptance that lands ASSERTED, or is refused because the artifact is the one the
 *    operator rejected, told the seat nothing (the acceptance told it of ASSERTED only);
 *  - a pass named no artifact, so `rejectedEvidence` (a list of artifact URIs) could not see it, and a QA
 *    seat could pass the patch the operator had just rejected and close the criterion unchanged;
 *  - passing a settled report again, the one act that would have repaired the first, was answered with
 *    "move it to review first", a move a FINAL report does not have.
 */

const USAGE = { input: 1_000, output: 500, total: 1_500 };

const DEV = { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "test.execute", "git.commit"], interests: [] };
const QA = { id: "qa", role: "qa", authority: ["quality.block", "quality.pass"], capabilities: ["repository.read", "test.execute", "test.write"], interests: [] };
const SEC = { id: "sec", role: "security", authority: ["security.block", "security.pass"], capabilities: ["repository.read", "security.scan", "security.review"], interests: [] };
const PM = { id: "pm", role: "product-manager", authority: ["requirements.accept"], capabilities: ["repository.read"], interests: [] };

type Mesh = Awaited<ReturnType<typeof makeMesh>>;
type Frame = AgentEventToolCall | AgentEventToolCallUpdate;

function mesh(criteria: Array<{ id: string; description: string; mandatory: boolean }>, live = false): Promise<Mesh> {
  const agents = [DEV, QA, SEC, PM];
  const ids = agents.map((a) => a.id);
  return makeMesh({
    agents,
    mayContact: Object.fromEntries(ids.map((id) => [id, ids.filter((o) => o !== id)])),
    criteria,
    ...(live ? { stallIdleMs: 600_000, stallCooldownMs: 600_000, stallNoopRetryMs: 600_000 } : { mode: "parked" as const }),
  } as never);
}

/** `owner` publishes `name` as `type`, and submits it unless `draft`. */
async function publish(m: Mesh, owner: string, name: string, type: string, draft = false): Promise<string> {
  const created = await m.supervisor.createArtifact({ actorId: owner, name, type: type as never, content: evidenceContent(name) });
  if (!("artifact" in created)) throw new Error(`create failed: ${JSON.stringify(created)}`);
  if (!draft) {
    const moved = await m.supervisor.transitionArtifact(owner, created.artifact.id, { to: "READY_FOR_REVIEW" });
    assert.equal(moved.ok, true, String(moved.reason));
  }
  return created.artifact.id;
}

const criterionOf = (m: Mesh, id: string) => {
  const c = goalOf(m)?.acceptanceCriteria.find((x) => x.id === id);
  if (!c) throw new Error(`no criterion ${id}`);
  return c;
};
const uriOf = (m: Mesh, artifactId: string) => {
  const a = m.kernel.state.artifacts.get(artifactId)!;
  return artifactUri(a.type, a.name, a.version);
};

/** The mission finished and reopened on `criteria`, as an operator does after rejecting the result. */
async function completeAndReopen(m: Mesh, criteria?: string[]): Promise<void> {
  const gid = m.kernel.state.activeGoalId!;
  for (const rec of [...m.kernel.state.agents.values()]) {
    if (rec.state.agentId === "human" || rec.state.lifecycle !== "STARTING") continue;
    await m.kernel.emit("agent.started", { agentId: rec.state.agentId }, { actorId: "system" });
  }
  if (goalOf(m)?.status !== "COMPLETED") await m.kernel.emit("goal.completed", { goalId: gid, reason: "test completion", evidence: [] }, { actorId: "human" });
  await (m.supervisor as unknown as { completeMission(): Promise<void> }).completeMission();
  await waitFor("mission completed", () => goalOf(m)?.status === "COMPLETED", 8000);
  const reopened = await m.supervisor.reopenGoal({ reason: "the verification does not cover what I rejected", ...(criteria ? { criteria } : {}) });
  assert.equal(reopened.ok, true, reopened.reason);
}

// ----------------------------------------------------------------- the seat is told

function caller(m: Mesh, seat: string) {
  const mcp = createMcpToolset(m.supervisor);
  return async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const tok = mintSeatToken(m.config.meshId, seat, m.kernel.state.activeGoalId);
    const res = (await mcp.handle(seat, tok, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })) as {
      result: { content: Array<{ text: string }> };
    };
    return JSON.parse(res.result.content[0]!.text) as Record<string, unknown>;
  };
}

const opened = (id: string, name: string): Frame => ({ kind: "tool_call", toolCallId: id, name, args: {} });
const closed = (id: string): Frame => ({ kind: "tool_call_update", toolCallId: id, status: "completed" });
const CHECKED: Frame[] = [opened("r1", "Read"), closed("r1")];

/**
 * One `seat` turn that streams `before` as live tool frames, then gives the verdict through the MCP bridge
 * the way a Claude seat does (announcing the call first), and ends. Returns what the seat was told.
 */
async function giveVerdict(m: Mesh, seat: string, before: Frame[], args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const call = caller(m, seat);
  const closedBefore = m.supervisor.getRecentTurns().filter((t) => t.agentId === seat && t.status !== "running").length;
  let answer: Record<string, unknown> = {};
  let ran = false;
  stub(m).setScript(seat, async (input: AgentInput) => {
    if (ran) return { operations: [{ op: "wait" } as MeshOp], tokensUsed: USAGE };
    ran = true;
    for (const f of before) input.onToolEvent?.(f);
    input.onToolEvent?.({ kind: "tool_call", toolCallId: "verdict", name: "mcp__mesh__mesh_approve", args });
    answer = await call("mesh_approve", args);
    input.onToolEvent?.({ kind: "tool_call_update", toolCallId: "verdict", status: "completed" });
    const toolCalls: ToolCallRecord[] = [];
    for (const f of before) if (f.kind === "tool_call") toolCalls.push({ name: f.name, args: f.args, resultDigest: "" });
    toolCalls.push({ name: "mcp__mesh__mesh_approve", args, resultDigest: "" });
    return { operations: [], text: "gave the verdict", typedOps: true, toolCalls, tokensUsed: USAGE };
  });
  await m.supervisor.activateAgent(seat, { kind: "manual" }, { explicit: true });
  await waitFor(`${seat}'s turn to close`, () => m.supervisor.getRecentTurns().filter((t) => t.agentId === seat && t.status !== "running").length > closedBefore);
  return answer;
}

test("a pass from a turn that checked nothing lands ASSERTED, and the seat is told so on the call itself", async () => {
  const m = await mesh([{ id: "quality-verified", description: "the tests pass", mandatory: true }], true);
  try {
    const report = await publish(m, "qa", "defect report", "TestReport");
    const told = await giveVerdict(m, "qa", [], { subject: "quality", kind: "pass", artifactId: report, comment: "61/61" });

    assert.equal(told.ok, true, "the verdict itself is recorded: the work it describes may well be real");
    assert.equal(criterionOf(m, "quality-verified").status, "ASSERTED", "but it does not close the criterion");
    assert.match(String(told.note), /recorded as ASSERTED, not EVIDENCED/, "and the seat that gave it can see that");
    assert.match(String(told.note), /'quality-verified' still does not count toward completion/);
    assert.match(String(told.note), /in the turn that gives the pass/, "with the one thing that repairs it, in the words of a pass");
    assert.doesNotMatch(String(told.note), /accepts it/, "not the words of an acceptance");
  } finally {
    await m.cleanup();
  }
});

test("a security pass is held to the same, and told the same", async () => {
  const m = await mesh([{ id: "security-verified", description: "no criticals", mandatory: true }], true);
  try {
    const report = await publish(m, "sec", "scan report", "SecurityReport");
    const told = await giveVerdict(m, "sec", [], { subject: "security", kind: "pass", artifactId: report, comment: "clean" });
    assert.equal(criterionOf(m, "security-verified").status, "ASSERTED");
    assert.match(String(told.note), /'security-verified' still does not count toward completion/);
  } finally {
    await m.cleanup();
  }
});

test("the same pass from a turn that read something closes the criterion, with no word about it", async () => {
  const m = await mesh([{ id: "quality-verified", description: "the tests pass", mandatory: true }], true);
  try {
    const report = await publish(m, "qa", "defect report", "TestReport");
    const told = await giveVerdict(m, "qa", CHECKED, { subject: "quality", kind: "pass", artifactId: report, comment: "61/61" });
    assert.equal(told.ok, true);
    assert.equal(criterionOf(m, "quality-verified").status, "EVIDENCED");
    // (QA owns the report and no other seat could review it, so the reply still says its own pass settled it.)
    assert.doesNotMatch(String(told.note ?? ""), /ASSERTED|stays open/, "a pass that closed the criterion says nothing of it: a note on every success is noise");
  } finally {
    await m.cleanup();
  }
});

test("passing a settled report again, after a check, closes the criterion and neither says 'changes nothing' nor sends the seat to review", async () => {
  // The repair the eighth run needed and could not get: the first pass moved the report to FINAL and landed
  // ASSERTED; the second, from a turn that checked, is the one that counts. It used to be answered with "a
  // second signature on the same version changes nothing" and "move it to review first", both untrue of it.
  const m = await mesh([{ id: "quality-verified", description: "the tests pass", mandatory: true }], true);
  try {
    const report = await publish(m, "qa", "defect report", "TestReport");
    const first = await giveVerdict(m, "qa", [], { subject: "quality", kind: "pass", artifactId: report, comment: "61/61" });
    assert.match(String(first.note), /ASSERTED/);
    assert.equal(m.kernel.state.artifacts.get(report)?.status, "FINAL", "the first pass moved the report");

    const second = await giveVerdict(m, "qa", CHECKED, { subject: "quality", kind: "pass", artifactId: report, comment: "61/61, re-run" });
    assert.equal(second.ok, true);
    assert.equal(criterionOf(m, "quality-verified").status, "EVIDENCED", "the repeat is what closed it");
    assert.doesNotMatch(String(second.note ?? ""), /changes nothing/, "a signature that closes a criterion has changed something");
    assert.doesNotMatch(String(second.note ?? ""), /move it to review first/, "a FINAL report has no move to review");
    assert.match(String(second.note ?? ""), /FINAL and an approval cannot advance it from there/, "what is true of the artifact is still said");
  } finally {
    await m.cleanup();
  }
});

test("a repeat that is still unchecked is told both that it changes nothing and that the criterion is still open", async () => {
  const m = await mesh([{ id: "quality-verified", description: "the tests pass", mandatory: true }], true);
  try {
    const report = await publish(m, "qa", "defect report", "TestReport");
    await giveVerdict(m, "qa", [], { subject: "quality", kind: "pass", artifactId: report });
    const second = await giveVerdict(m, "qa", [], { subject: "quality", kind: "pass", artifactId: report });
    assert.match(String(second.note), /a second signature on the same version changes nothing/);
    assert.match(String(second.note), /recorded as ASSERTED, not EVIDENCED/);
    assert.equal(criterionOf(m, "quality-verified").status, "ASSERTED");
  } finally {
    await m.cleanup();
  }
});

// -------------------------------------------------- a pass names what it passed

const SCENARIOS = [
  { seat: "qa", domain: "quality", criterion: "quality-verified", type: "TestReport" },
  { seat: "sec", domain: "security", criterion: "security-verified", type: "SecurityReport" },
] as const;

for (const s of SCENARIOS) {
  test(`a ${s.domain} pass records the artifact it was about, so a reopen can tell the rejected round from the next`, async () => {
    const m = await mesh([{ id: s.criterion, description: "verified", mandatory: true }]);
    try {
      const one = await publish(m, s.seat, "report one", s.type);
      const passed = await m.supervisor.recordDecision(s.seat, "pass", s.domain, one, "checked");
      assert.equal(passed.ok, true, passed.reason);
      assert.doesNotMatch(passed.reason ?? "", /ASSERTED|stays open/, "the pass moved the report and closed the criterion: nothing to add");
      assert.equal(criterionOf(m, s.criterion).status, "EVIDENCED");
      assert.equal(criterionOf(m, s.criterion).evidence.at(-1)?.artifactRef?.uri, uriOf(m, one), "the evidence names the report the pass was about");

      await completeAndReopen(m, [s.criterion]);
      assert.equal(criterionOf(m, s.criterion).status, "UNSATISFIED", "the reopen withdrew the verdict");
      assert.deepEqual(criterionOf(m, s.criterion).rejectedEvidence, [uriOf(m, one)], "and remembers what it rested on");

      // The loop the gate exists for: the seat passes the identical artifact again.
      const again = await m.supervisor.recordDecision(s.seat, "pass", s.domain, one, "still fine");
      assert.equal(again.ok, true, "the verdict is recorded, as any signature is");
      assert.equal(criterionOf(m, s.criterion).status, "UNSATISFIED", "but the artifact the operator rejected cannot close the criterion again");
      assert.match(again.reason ?? "", new RegExp(`'${s.criterion}' stays open: artifact://${s.type}/report%20one/1 is what the operator rejected when it reopened the mission`), "and the seat is told why");
      assert.match(again.reason ?? "", /Supersede it: publish a new version \(asVersionOf\) or a new artifact that answers the rejection, and give the pass on that\./, "and what to do, in the words of a pass");

      // Superseding it must still work, or the mission could never finish.
      const two = await publish(m, s.seat, "report two", s.type);
      const next = await m.supervisor.recordDecision(s.seat, "pass", s.domain, two, "checked the fix");
      assert.equal(next.ok, true, next.reason);
      assert.doesNotMatch(next.reason ?? "", /ASSERTED|stays open/);
      assert.equal(criterionOf(m, s.criterion).status, "EVIDENCED", "a new artifact closes it");
    } finally {
      await m.cleanup();
    }
  });
}

test("a pass on a draft closes the criterion as it always did, and names no artifact", async () => {
  // QA passing the report it has just published, still a draft, is the commonest pass there is (3 of the 7
  // in the sixth to eighth live runs). The workflow gate refuses a draft as evidence, so naming one would
  // have left `quality-verified` open on the verdict the criterion is named for.
  const m = await mesh([{ id: "quality-verified", description: "the tests pass", mandatory: true }]);
  try {
    const draft = await publish(m, "qa", "draft report", "TestReport", true);
    assert.equal(m.kernel.state.artifacts.get(draft)?.status, "DRAFT", "fixture");
    const res = await m.supervisor.recordDecision("qa", "pass", "quality", draft, "all green");
    assert.equal(res.ok, true, res.reason);
    assert.equal(criterionOf(m, "quality-verified").status, "EVIDENCED");
    assert.equal(criterionOf(m, "quality-verified").evidence.at(-1)?.artifactRef, undefined, "a draft is not named");
    assert.match(res.reason ?? "", /is DRAFT and an approval cannot advance it from there — move it to review first/, "and a draft is still told the route that exists");
  } finally {
    await m.cleanup();
  }
});

test("a pass with no artifact still closes the criterion, and names none", async () => {
  const m = await mesh([{ id: "quality-verified", description: "the tests pass", mandatory: true }]);
  try {
    const res = await m.supervisor.recordDecision("qa", "pass", "quality", undefined, "ran everything on main");
    assert.equal(res.ok, true, res.reason);
    assert.equal(criterionOf(m, "quality-verified").status, "EVIDENCED");
    assert.equal(criterionOf(m, "quality-verified").evidence.at(-1)?.artifactRef, undefined);
  } finally {
    await m.cleanup();
  }
});

test("a release pass is no quality pass: only the two domains close a criterion", async () => {
  const m = await makeMesh({
    agents: [DEV, { id: "rm", role: "release-manager", authority: ["release.approve", "release.pass"], capabilities: ["repository.read"], interests: [] }],
    mayContact: { dev: ["rm"], rm: ["dev"] },
    criteria: [{ id: "quality-verified", description: "the tests pass", mandatory: true }],
    mode: "parked",
  } as never);
  try {
    const res = await m.supervisor.recordDecision("rm", "pass", "release", undefined, "ship it");
    assert.equal(res.ok, true, res.reason);
    assert.notEqual(criterionOf(m, "quality-verified").status, "EVIDENCED", "a release sign-off is not a quality review");
    assert.equal(res.reason ?? "", "", "and it says nothing about a criterion it never touched");
  } finally {
    await m.cleanup();
  }
});

// ---------------------------------------------------- an acceptance is told the same

test("an acceptance that cites what the operator rejected is told it stays open, and what to cite instead", async () => {
  const m = await mesh([{ id: "ship", description: "the deliverable exists and works", mandatory: true }]);
  try {
    const one = await publish(m, "qa", "report one", "TestReport");
    const first = await m.supervisor.recordDecision("pm", "accept", "criterion:ship", one, "QA's run");
    assert.equal(first.ok, true, first.reason);
    assert.equal(first.reason, undefined);
    assert.equal(criterionOf(m, "ship").status, "EVIDENCED");

    await completeAndReopen(m);
    assert.equal(criterionOf(m, "ship").status, "UNSATISFIED");

    const again = await m.supervisor.recordDecision("pm", "accept", "criterion:ship", one, "same report");
    assert.equal(again.ok, true, "the acceptance is on the record, as it always was");
    assert.equal(criterionOf(m, "ship").status, "UNSATISFIED", "and it closes nothing");
    assert.match(again.reason ?? "", /'ship' stays open: artifact:\/\/TestReport\/report%20one\/1 is what the operator rejected when it reopened the mission/, "it used to answer ok with no word of this");
    assert.match(again.reason ?? "", /and cite that\.$/, "in the words of an acceptance");

    const two = await publish(m, "qa", "report two", "TestReport");
    const next = await m.supervisor.recordDecision("pm", "accept", "criterion:ship", two, "the new report");
    assert.equal(next.ok, true, next.reason);
    assert.equal(next.reason, undefined);
    assert.equal(criterionOf(m, "ship").status, "EVIDENCED");
  } finally {
    await m.cleanup();
  }
});

// --------------------------------------- the route a verdict is sent down must exist

test("only an artifact that has a move to review is told to move it there", () => {
  assert.equal(canEnterReview("TestReport", "DRAFT"), true);
  assert.equal(canEnterReview("CodePatch", "DRAFT"), true);
  assert.equal(canEnterReview("CodePatch", "MERGEABLE"), true, "MERGEABLE has an edge back to UNDER_REVIEW");
  assert.equal(canEnterReview("TestReport", "FINAL"), false);
  assert.equal(canEnterReview("CodePatch", "APPROVED"), false);
  assert.equal(canEnterReview("CodePatch", "MERGED"), false);
  assert.equal(canEnterReview("ReleasePlan", "PROPOSED"), false, "the release machine has no review");
});
