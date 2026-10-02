import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, evidenceContent } from "../helpers";
import { standingBlocks, recordApproval } from "../../packages/core/src/projections-helpers";
import type { ActivationReason, MeshOp } from "../../packages/protocol/src/index";

/**
 * The stall watchdog names the BLOCK that holds the mission and wakes the seat that can lift it.
 *
 * In the second cronlite run QA blocked `quality` at 12:08:59 (it had tested a worktree that
 * was behind `main`). The watchdog nudged the tech-lead, the pm and the developer, in that
 * order, and its note named the unmet criteria and nothing else: none of those seats could
 * lift a block that only QA can, and the pm was chosen because "whoever has mail" returns the
 * first seat in config order that has any. A block on a patch was worse: `mergeLadderPending`
 * listed the held patch as parked on the ladder and sent the nudge to the seat that "may merge
 * it", which the policy would refuse until a new version existed.
 *
 * Driven the way `stall-watchdog.test.ts` does it: explicit `checkStall()` calls with the gates
 * poked open, so what is asserted is the DECISION and never a sleep.
 */

const AGENTS = [
  { id: "pm", role: "product-manager", authority: ["requirements.accept"], capabilities: ["repository.read"], interests: [] },
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "test.execute", "git.commit"], interests: [] },
  { id: "lead", role: "tech-lead", authority: ["implementation.approve", "quality.approve"], capabilities: ["repository.read", "code.review", "git.merge"], interests: [] },
  { id: "qa", role: "qa", authority: ["quality.block", "quality.pass", "quality.approve"], capabilities: ["repository.read", "test.execute"], interests: [] },
];
const ALL = AGENTS.map((a) => a.id);
const COMM = Object.fromEntries(ALL.map((id) => [id, ALL.filter((o) => o !== id)]));
const CRITERIA = [{ id: "never", description: "never evidenced here, so the mission always has work", mandatory: true }];

/** The cronlite team's shape: nobody but QA holds the quality authority or the test capabilities, so QA may pass the report it wrote. */
const SOLO_QA = AGENTS.map((a) =>
  a.id === "lead"
    ? { ...a, authority: ["implementation.approve"] }
    : a.id === "qa"
      ? { ...a, capabilities: ["repository.read", "test.execute", "test.write"] }
      : a,
);

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

interface StallInternals {
  checkStall(): Promise<void>;
  lastTurnAt: number;
  lastStallNudgeAt: number;
}
const internals = (m: Mesh): StallInternals => m.supervisor as unknown as StallInternals;
const goQuiet = (m: Mesh): void => void (internals(m).lastTurnAt = Date.now() - 10 * 60_000);
const clearCooldown = (m: Mesh): void => void (internals(m).lastStallNudgeAt = Date.now() - 10 * 60_000);
const idle = (m: Mesh, what: string) => waitFor(what, () => m.scheduler.pending() === 0 && m.scheduler.running() === 0);

const turnFor = (agentId: string) =>
  ({ turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`, agentId, reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] }) as never;
const op = (m: Mesh, actorId: string, o: MeshOp) => m.supervisor.executeOp(actorId, o, turnFor(actorId));

/** A live mesh whose seats only record the wake they were handed and wait. Stall timers are inert. */
async function mesh(startup: string[] = [], criteria: Array<{ id: string; description: string; mandatory: boolean }> = CRITERIA, agents: typeof AGENTS = AGENTS) {
  const m = await makeMesh({
    agents,
    mayContact: COMM,
    startup,
    criteria,
    mode: "parked",
    stallIdleMs: 60_000,
    stallCooldownMs: 300_000,
    stallNoopRetryMs: 600_000,
  } as never);
  const nudges: Array<{ agent: string; note: string }> = [];
  for (const id of ALL) {
    stub(m).setScript(id, async (input) => {
      const reason: ActivationReason = input.activation;
      if (reason.kind === "timer" && String(reason.note).startsWith("stall watchdog:")) nudges.push({ agent: id, note: String(reason.note) });
      return { operations: [{ op: "wait" } as MeshOp] };
    });
  }
  return { m, nudges };
}

/** Go live, let whatever that wakes settle, and tick the watchdog once with both gates open. */
async function tick(m: Mesh, nudges: unknown[], expected: number): Promise<void> {
  goQuiet(m);
  clearCooldown(m);
  await internals(m).checkStall();
  await waitFor(`stall nudge ${expected}`, () => nudges.length === expected);
  await idle(m, `nudged turn ${expected}`);
}

const qaBlocksQuality = (m: Mesh) => op(m, "qa", { op: "block", subject: "quality", reason: "uppercase month names are rejected" } as MeshOp);

// ------------------------------------------------------------- the predicate

test("a block on a subject stands until the same seat signs that subject off again", async () => {
  const { m } = await mesh();
  try {
    assert.deepEqual(standingBlocks(m.kernel.state), []);
    assert.equal((await qaBlocksQuality(m)).ok, true);
    let held = standingBlocks(m.kernel.state);
    assert.equal(held.length, 1);
    assert.equal(held[0]!.record.actorId, "qa");
    assert.equal(held[0]!.record.subject, "quality");
    assert.equal(held[0]!.artifact, undefined, "a block with no artifact holds a subject, not a thing");

    // Blocking again restates the hold; it does not add a second one.
    await new Promise((r) => setTimeout(r, 5));
    assert.equal((await qaBlocksQuality(m)).ok, true);
    assert.equal(standingBlocks(m.kernel.state).length, 1, "one hold per seat and subject");

    // Somebody else's sign-off on the subject lifts nothing: the gates read the blocker's own.
    await new Promise((r) => setTimeout(r, 5));
    const other = await op(m, "lead", { op: "approve", subject: "quality" } as MeshOp);
    assert.equal(other.ok, true, String(other.reason));
    assert.ok(
      [...m.kernel.state.approvals.values()].flat().some((r) => r.kind === "approve" && r.subject === "quality" && r.actorId === "lead"),
      "fixture: lead's approval of quality is on the record",
    );
    assert.equal(standingBlocks(m.kernel.state).length, 1, "another seat's approval does not lift qa's block");

    await new Promise((r) => setTimeout(r, 5));
    const signed = await op(m, "qa", { op: "approve", subject: "quality" } as MeshOp);
    assert.equal(signed.ok, true, String(signed.reason));
    held = standingBlocks(m.kernel.state);
    assert.deepEqual(held, [], "qa signing quality off afterwards lifts its own block");
  } finally {
    await m.cleanup();
  }
});

/** dev's CodePatch walked to MERGEABLE, the state the merge ladder nudges the merger about. */
async function mergeablePatch(m: Mesh): Promise<string> {
  const created = await m.supervisor.createArtifact({ actorId: "dev", name: "slice-1", type: "CodePatch", content: evidenceContent("the whole patch") });
  if (!("artifact" in created)) throw new Error(`create failed: ${JSON.stringify(created)}`);
  const id = created.artifact.id;
  await m.supervisor.transitionArtifact("dev", id, { to: "READY_FOR_REVIEW" });
  await op(m, "dev", { op: "request_review", artifactId: id, reviewers: ["lead"] } as MeshOp);
  await op(m, "lead", { op: "approve", subject: "implementation", artifactId: id } as MeshOp);
  await m.supervisor.transitionArtifact("lead", id, { to: "VERIFIED" });
  await m.supervisor.transitionArtifact("lead", id, { to: "MERGEABLE" });
  assert.equal(m.kernel.state.artifacts.get(id)?.status, "MERGEABLE", "fixture: staged at the gate");
  return id;
}

test("a block on an artifact stands until a new version, and the blocker's own pass does not lift it", async () => {
  const { m } = await mesh();
  try {
    const id = await mergeablePatch(m);
    const blocked = await op(m, "qa", { op: "block", subject: "quality", artifactId: id, reason: "integration suite fails" } as MeshOp);
    assert.equal(blocked.ok, true, String(blocked.reason));
    let held = standingBlocks(m.kernel.state);
    assert.equal(held.length, 1);
    assert.equal(held[0]!.artifact?.id, id);
    assert.equal(held[0]!.artifact?.owner, "dev", "the artifact's owner is the one who can release it");

    await new Promise((r) => setTimeout(r, 5));
    await op(m, "qa", { op: "approve", subject: "quality", artifactId: id } as MeshOp);
    assert.equal(standingBlocks(m.kernel.state).length, 1, "the policy holds the artifact until a new version, whatever qa signs afterwards");

    const reworked = await m.supervisor.createArtifact({ actorId: "dev", name: "slice-1", type: "CodePatch", content: evidenceContent("the patch, reworked"), asVersionOf: id });
    assert.ok("artifact" in reworked, "fixture: the rework published");
    held = standingBlocks(m.kernel.state);
    assert.deepEqual(held, [], "a new version drops the verdicts on its predecessor, the block with them");
  } finally {
    await m.cleanup();
  }
});

// ------------------------------------------------------------- the nudge

test("QA's standing block on a subject is what the watchdog names, and QA is the seat it wakes", async () => {
  const { m, nudges } = await mesh();
  try {
    assert.equal((await qaBlocksQuality(m)).ok, true);
    await m.goLive();
    await idle(m, "go-live to settle");

    await tick(m, nudges, 1);
    // pm is first in config order, and what the old driver fell back on with nobody holding mail.
    assert.equal(nudges[0]!.agent, "qa", "the seat that can lift the block");
    const note = nudges[0]!.note;
    assert.match(note, /qa's BLOCK on quality \(since \d{4}-\d\d-\d\dT[\d:]+Z\) still stands/);
    assert.match(note, /only qa can lift it, by re-verifying the CURRENT product \(bring the worktree up to main first\)/);
    assert.match(note, /passing quality if it holds, or blocking again and saying what is still wrong/);
    assert.match(note, /drive the next step toward an unmet criterion/, "the generic instruction still follows");
  } finally {
    await m.cleanup();
  }
});

test("a patch held by a block is not parked on the merge ladder: its owner is woken to rework it, not the merger to merge it", async () => {
  const { m, nudges } = await mesh();
  try {
    const id = await mergeablePatch(m);
    assert.equal((await op(m, "qa", { op: "block", subject: "quality", artifactId: id, reason: "integration suite fails" } as MeshOp)).ok, true);
    await m.goLive();
    await idle(m, "go-live to settle");

    await tick(m, nudges, 1);
    assert.equal(nudges[0]!.agent, "dev", "the owner publishes the new version; lead could only be refused");
    const note = nudges[0]!.note;
    assert.match(note, /qa's BLOCK on CodePatch "slice-1" v1 \(since [^)]+\) still stands: it cannot advance until dev publishes a new version that answers it/);
    assert.match(note, /a new version starts its review over, and qa's later pass would not release it/);
    assert.doesNotMatch(note, /parked on the merge ladder/, "it is held, not parked");
    assert.doesNotMatch(note, /Transition it to MERGED/);
  } finally {
    await m.cleanup();
  }
});

test("a patch that is parked with no block still sends the merger to it, as before", async () => {
  const { m, nudges } = await mesh();
  try {
    await mergeablePatch(m);
    await m.goLive();
    await idle(m, "go-live to settle");
    await tick(m, nudges, 1);
    assert.equal(nudges[0]!.agent, "lead", "control: the ladder still names the seat that may merge");
    assert.match(nudges[0]!.note, /parked on the merge ladder/);
  } finally {
    await m.cleanup();
  }
});

test("the lifter is not nudged twice running when the first bought nothing, and the cap card names the block", async () => {
  // pm ran at go-live and is WAITING, so it is what the old fallbacks would pick; qa is the lifter.
  const { m, nudges } = await mesh(["pm"]);
  try {
    assert.equal((await qaBlocksQuality(m)).ok, true);
    await m.goLive();
    await waitFor("pm's startup turn", () => (m.kernel.state.agents.get("pm")?.state.activations ?? 0) >= 1);
    await idle(m, "go-live to settle");

    await tick(m, nudges, 1);
    await tick(m, nudges, 2);
    await tick(m, nudges, 3);
    assert.deepEqual(
      nudges.map((n) => n.agent),
      ["qa", "pm", "qa"],
      "each nudge that bought nothing passes the turn to another seat before the lifter is tried again",
    );

    // Three fruitless nudges: the mission is handed to a human, and the card says what holds it.
    goQuiet(m);
    clearCooldown(m);
    await internals(m).checkStall();
    const card = [...m.kernel.state.escalations.values()].find((e) => e.reason === "stalemate:stall_nudge_cap");
    assert.ok(card, "the cap raised its card");
    const detail = card.detail as { actionable?: string; standingBlocks?: string };
    assert.match(String(detail.actionable), /1 mandatory criteria unmet \(held by qa's BLOCK on quality\)/);
    assert.match(String(detail.standingBlocks), /qa's BLOCK on quality/);
  } finally {
    await m.cleanup();
  }
});

test("a block the blocker has signed off since holds nothing, so the nudge is the generic one again", async () => {
  const { m, nudges } = await mesh();
  try {
    assert.equal((await qaBlocksQuality(m)).ok, true);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal((await op(m, "qa", { op: "approve", subject: "quality" } as MeshOp)).ok, true);
    await m.goLive();
    await idle(m, "go-live to settle");

    await tick(m, nudges, 1);
    assert.doesNotMatch(nudges[0]!.note, /BLOCK/, "nothing stands, so nothing is named");
    assert.match(nudges[0]!.note, /drive the next step toward an unmet criterion/);
  } finally {
    await m.cleanup();
  }
});

// ------------------------------------------------------------- a pass that names a report signs the subject off

/** A TestReport `owner` wrote and has not submitted: what a pass that names it puts forward. */
async function draftReport(m: Mesh, owner: string, name: string): Promise<string> {
  const created = await m.supervisor.createArtifact({ actorId: owner, name, type: "TestReport", content: evidenceContent(name) });
  if (!("artifact" in created)) throw new Error(`create failed: ${JSON.stringify(created)}`);
  return created.artifact.id;
}

/** A verdict as `recordDecision` emits it for a named artifact: recorded under the artifact, the subject kept beside it. */
function artifactVerdict(m: Mesh, kind: "pass" | "approve", actorId: string, artifactId: string, domain: string, at: string): void {
  const event = { id: `evt-${actorId}-${domain}-${at}`, timestamp: at } as never;
  recordApproval(m.kernel.state, { subject: `artifact:${artifactId}`, fallbackSubject: domain, kind, artifactId, actorId, actorRole: actorId }, event, kind);
}

/**
 * The twelfth cronlite run (2026-10-02). QA blocked `quality` at 16:55:50 (it had tested a main that held the test suite and the
 * stubs, and not the implementation, which was still waiting for its merge) and passed it at 17:00:25, naming its new test report.
 * `quality-verified` was evidenced by that pass, and the watchdog still said "qa's BLOCK on quality still stands", because the pass
 * was recorded under `artifact:art-…` and the block's sign-off was looked up under `quality`. At 17:01:44 it woke QA to lift a block
 * QA had passed over 80 seconds earlier, instead of the pm that had to accept the two criteria left; QA tried a contract called
 * `criterion:library-contract-met`, and the pm's own timer was the first thing to wake it, 4 min 19 s after the report was FINAL.
 */
test("a pass that names QA's test report is QA signing quality off: it lifts QA's own block on quality", async () => {
  const { m } = await mesh([], CRITERIA, SOLO_QA);
  try {
    assert.equal((await qaBlocksQuality(m)).ok, true);
    assert.equal(standingBlocks(m.kernel.state).length, 1, "fixture: the block stands");

    const report = await draftReport(m, "qa", "QA report");
    await new Promise((r) => setTimeout(r, 5));
    const passed = await m.supervisor.recordDecision("qa", "pass", "quality", report, "ran the suite: 31/31");
    assert.equal(passed.ok, true, passed.reason);
    const record = [...m.kernel.state.approvals.values()].flat().find((r) => r.kind === "pass" && r.actorId === "qa");
    assert.equal(record?.subject, `artifact:${report}`, "fixture: the verdict is recorded under the report");
    assert.equal(record?.domainSubject, "quality", "and keeps the subject QA named");
    assert.deepEqual(standingBlocks(m.kernel.state), [], "the block is lifted");
  } finally {
    await m.cleanup();
  }
});

test("only the blocker's own later sign-off of the same subject lifts a block, whatever it names", async () => {
  const { m } = await mesh();
  try {
    // QA signs quality off with a report BEFORE it blocks: the block is the later word.
    const earlier = await draftReport(m, "qa", "earlier report");
    artifactVerdict(m, "pass", "qa", earlier, "quality", "2026-10-02T16:00:00.000Z");
    assert.equal((await qaBlocksQuality(m)).ok, true);
    assert.equal(standingBlocks(m.kernel.state).length, 1, "a sign-off from before the block lifts nothing");

    // Another seat signs quality off on a report: the gates read the blocker's own sign-off.
    const other = await draftReport(m, "qa", "report the lead rules on");
    artifactVerdict(m, "approve", "lead", other, "quality", "2999-01-01T00:00:00.000Z");
    assert.equal(standingBlocks(m.kernel.state).length, 1, "another seat's approval of a report does not lift qa's block");

    // QA signs a different subject off, on a report: that is not quality.
    artifactVerdict(m, "pass", "qa", other, "security", "2999-01-01T00:00:01.000Z");
    assert.equal(standingBlocks(m.kernel.state).length, 1, "a sign-off of another subject does not lift a block on quality");

    // QA signs quality off on a report, afterwards: lifted.
    artifactVerdict(m, "pass", "qa", other, "quality", "2999-01-01T00:00:02.000Z");
    assert.deepEqual(standingBlocks(m.kernel.state), [], "its own later sign-off of the subject lifts it");
  } finally {
    await m.cleanup();
  }
});

test("after QA's pass on its report the watchdog nudges the seat that has to accept, not QA, and names no block", async () => {
  const criteria = [
    { id: "quality-verified", description: "the tests pass", mandatory: true },
    { id: "contract-met", description: "the product does what the goal says, shown by a QA report", mandatory: true },
  ];
  const { m, nudges } = await mesh([], criteria, SOLO_QA);
  try {
    assert.equal((await qaBlocksQuality(m)).ok, true);
    const report = await draftReport(m, "qa", "QA report");
    await new Promise((r) => setTimeout(r, 5));
    const passed = await m.supervisor.recordDecision("qa", "pass", "quality", report, "ran the suite: 31/31");
    assert.equal(passed.ok, true, passed.reason);
    const goal = m.kernel.state.goals.get(m.kernel.state.activeGoalId!)!;
    assert.equal(goal.acceptanceCriteria.find((c) => c.id === "quality-verified")?.status, "EVIDENCED", "fixture: only the acceptance is left");
    await m.goLive();
    await idle(m, "go-live to settle");

    await tick(m, nudges, 1);
    assert.equal(nudges[0]!.agent, "pm", "the one seat that can close contract-met; qa has nothing to lift");
    assert.doesNotMatch(nudges[0]!.note, /BLOCK/, "the block was passed over");
    assert.match(nudges[0]!.note, /contract-met/);
    assert.match(nudges[0]!.note, /Submitted and citable: TestReport "QA report"/, "and it is shown the report to cite");
  } finally {
    await m.cleanup();
  }
});
