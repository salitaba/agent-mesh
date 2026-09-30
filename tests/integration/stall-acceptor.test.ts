import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, evidenceContent, goalOf } from "../helpers";
import { artifactUri } from "../../packages/protocol/src/uri";
import type { ActivationReason, MeshOp } from "../../packages/protocol/src/index";

/**
 * The stall watchdog wakes the seat that may ACCEPT what is still unmet, and says how.
 *
 * The fourth cronlite run's second round sat on one criterion for 21 minutes, 12 turns and 188k
 * tokens. It was the `operator-feedback-…` criterion a reopen mints, and only a seat holding
 * `requirements.accept` can close it by `approve subject:"criterion:<id>"`. The watchdog's note
 * said "drive the next step toward an unmet criterion" and its driver was "the first seat in
 * config order with mail": the architect, twice, which asked the developer for a status and set
 * off a chain of turns that went round the mission. The pm was woken last, and had by then
 * written "awaiting operator acceptance testing": it did not know the act was its own, and a QA
 * report that would have served had been submitted for some time.
 *
 * Driven the way `stall-standing-block.test.ts` does it: explicit `checkStall()` calls with the
 * gates poked open, so what is asserted is the DECISION and never a sleep.
 */

// `dev` first: the roster's first seat is what the old fallbacks ended on, so a driver that is
// NOT `dev` was chosen on purpose.
const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "test.execute", "git.commit"], interests: [] },
  { id: "qa", role: "qa", authority: ["quality.pass"], capabilities: ["repository.read", "test.execute", "test.write"], interests: [] },
  { id: "pm", role: "product-manager", authority: ["requirements.accept"], capabilities: ["repository.read"], interests: [] },
];
const ALL = AGENTS.map((a) => a.id);
const COMM = Object.fromEntries(ALL.map((id) => [id, ALL.filter((o) => o !== id)]));
/** Nothing the runtime evidences by itself: each of these closes by an acceptance or not at all. */
const MANUAL = [
  { id: "cli-contract-met", description: "the command line does what SPEC.md says", mandatory: true },
  { id: "operator-feedback-1", description: "the operator's defects are fixed", mandatory: true },
];

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

/** A live mesh whose seats only record the wake they were handed and wait. Stall timers are inert. */
async function mesh(opts: { agents?: typeof AGENTS; criteria?: typeof MANUAL; startup?: string[] } = {}) {
  const agents = opts.agents ?? AGENTS;
  const ids = agents.map((a) => a.id);
  const m = await makeMesh({
    agents,
    mayContact: Object.fromEntries(ids.map((id) => [id, ids.filter((o) => o !== id)])),
    startup: opts.startup ?? [],
    criteria: opts.criteria ?? MANUAL,
    mode: "parked",
    stallIdleMs: 60_000,
    stallCooldownMs: 300_000,
    stallNoopRetryMs: 600_000,
  } as never);
  const nudges: Array<{ agent: string; note: string }> = [];
  for (const id of ids) {
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

/** `owner` publishes `name` and submits it for review: the state an acceptance can cite. */
async function submit(m: Mesh, owner: string, name: string, type: "TestReport" | "CodePatch" | "ArchitectureDocument" = "TestReport") {
  const created = await m.supervisor.createArtifact({ actorId: owner, name, type, content: evidenceContent(name) });
  if (!("artifact" in created)) throw new Error(`create failed: ${JSON.stringify(created)}`);
  const moved = await m.supervisor.transitionArtifact(owner, created.artifact.id, { to: "READY_FOR_REVIEW" });
  assert.equal(moved.ok, true, String(moved.reason));
  return created.artifact;
}

test("with only acceptances unmet, the watchdog wakes the seat that may accept and tells it what to cite", async () => {
  const { m, nudges } = await mesh();
  try {
    const report = await submit(m, "qa", "QA report");
    // Not offered: a draft cannot evidence a mandatory criterion.
    const scratch = await m.supervisor.createArtifact({ actorId: "qa", name: "scratch notes", type: "TestReport", content: evidenceContent("scratch notes") });
    assert.ok("artifact" in scratch, "fixture: the draft published");
    await m.goLive();
    await idle(m, "go-live to settle");

    await tick(m, nudges, 1);
    assert.equal(nudges[0]!.agent, "pm", "the seat that may accept; `dev` is first in the roster and is what the fallbacks would pick");
    const note = nudges[0]!.note;
    assert.match(note, /2 of 2 mandatory criteria unmet \(cli-contract-met, operator-feedback-1\)/, "the summary is still there");
    assert.match(note, /does not evidence these from its own events \(cli-contract-met, operator-feedback-1\)/);
    assert.match(note, /the acceptance is yours to give, not something to wait for another seat to do/, "says it is the pm's to do");
    assert.match(note, /`mesh_approve` \{ subject: "criterion:<id>", artifactId: "<the submitted artifact that proves it>"/);
    assert.match(note, new RegExp(`Submitted and citable: TestReport "QA report" v1 \\(${report.id}, by qa, READY_FOR_REVIEW\\)`), "names what can be cited");
    assert.doesNotMatch(note, /scratch notes/, "a draft is not offered");
    assert.match(note, /accept once it is submitted\. Then drive the next step toward an unmet criterion/, "the specific instruction comes first, the generic one after it");
  } finally {
    await m.cleanup();
  }
});

test("with nothing submitted yet, the note says the proof is what is missing", async () => {
  const { m, nudges } = await mesh();
  try {
    await m.goLive();
    await idle(m, "go-live to settle");
    await tick(m, nudges, 1);
    assert.equal(nudges[0]!.agent, "pm");
    assert.match(nudges[0]!.note, /Nothing has been submitted that could be cited yet\./);
    assert.match(nudges[0]!.note, /what is missing is the proof and not an acceptance: ask the seat that can produce it/);
  } finally {
    await m.cleanup();
  }
});

test("an artifact the operator already rejected for the criterion is not offered again", async () => {
  const { m, nudges } = await mesh({ criteria: [MANUAL[1]!] });
  try {
    const stale = await submit(m, "qa", "Round one report");
    const fresh = await submit(m, "qa", "Round two report");
    const goal = goalOf(m)!;
    // What a reopen leaves behind: the URIs the operator rejected, which `markCriterionEvidence` refuses.
    goal.acceptanceCriteria.find((c) => c.id === "operator-feedback-1")!.rejectedEvidence = [artifactUri(stale.type, stale.name, stale.version)];
    await m.goLive();
    await idle(m, "go-live to settle");

    await tick(m, nudges, 1);
    const note = nudges[0]!.note;
    assert.match(note, new RegExp(`Round two report" v1 \\(${fresh.id}`));
    assert.doesNotMatch(note, /Round one report/, "citing it would be refused, so it is not suggested");
  } finally {
    await m.cleanup();
  }
});

test("a criterion the mesh evidences itself is still unmet: the acceptance is not what the nudge is about", async () => {
  const { m, nudges } = await mesh({
    criteria: [{ id: "implementation-merged", description: "the patch landed", mandatory: true }, MANUAL[0]!],
  });
  try {
    await m.goLive();
    await idle(m, "go-live to settle");
    await tick(m, nudges, 1);
    // The work that would evidence `implementation-merged` is still to do, and the pm cannot do it:
    // the fallbacks apply as they always did.
    assert.equal(nudges[0]!.agent, "dev", "control: the roster's first seat, as before");
    assert.doesNotMatch(nudges[0]!.note, /acceptance is yours|only by an acceptance/);
    assert.match(nudges[0]!.note, /drive the next step toward an unmet criterion/);
  } finally {
    await m.cleanup();
  }
});

test("an acceptor whose nudge bought nothing passes the turn on, and the seat after it is told who can close them", async () => {
  // dev ran at go-live and is WAITING, the oldest seat that is: what the fallbacks pick once the pm has had its turn.
  const { m, nudges } = await mesh({ startup: ["dev"] });
  try {
    await m.goLive();
    await waitFor("dev's startup turn", () => (m.kernel.state.agents.get("dev")?.state.activations ?? 0) >= 1);
    await idle(m, "go-live to settle");
    nudges.length = 0;

    await tick(m, nudges, 1);
    await tick(m, nudges, 2);
    await tick(m, nudges, 3);
    assert.deepEqual(
      nudges.map((n) => n.agent),
      ["pm", "dev", "pm"],
      "each nudge that bought nothing passes the turn to another seat before the acceptor is tried again",
    );
    const dev = nudges[1]!.note;
    assert.match(dev, /close only by an acceptance from pm \(`approve` on subject "criterion:<id>" citing a submitted artifact that proves it\)/);
    assert.match(dev, /which you cannot give: put the proof in front of pm and ask/, "the seat that cannot accept is pointed at the one that can");
    assert.doesNotMatch(dev, /acceptance is yours/);

    // Three fruitless nudges: the mission is handed to a human, and the card says what it is waiting on.
    goQuiet(m);
    clearCooldown(m);
    await internals(m).checkStall();
    const card = [...m.kernel.state.escalations.values()].find((e) => e.reason === "stalemate:stall_nudge_cap");
    assert.ok(card, "the cap raised its card");
    const detail = card.detail as { awaitingAcceptance?: string };
    assert.match(String(detail.awaitingAcceptance), /cli-contract-met, operator-feedback-1 close only by an acceptance from pm/);
    assert.doesNotMatch(String(detail.awaitingAcceptance), /which you cannot give/, "the card is addressed to the operator, not to a seat");
  } finally {
    await m.cleanup();
  }
});

test("no seat holds the gate: the note says only the operator can close what is left", async () => {
  const { m, nudges } = await mesh({ agents: AGENTS.filter((a) => a.id !== "pm") });
  try {
    await m.goLive();
    await idle(m, "go-live to settle");
    await tick(m, nudges, 1);
    assert.match(
      nudges[0]!.note,
      /close only by an acceptance, and no seat in this mesh holds requirements\.accept or requirements\.approve: only the operator can close them, and no nudge to a seat changes that\. Then drive the next step/,
    );
  } finally {
    await m.cleanup();
  }
});

test("a reopen says who accepts the criterion it mints", async () => {
  const { m } = await mesh({ criteria: [MANUAL[0]!] });
  try {
    await m.goLive();
    await idle(m, "go-live to settle");
    const gid = m.kernel.state.activeGoalId!;
    await m.kernel.emit("requirement.satisfied", { criterionId: "cli-contract-met", evidence: { verified: true, note: "fixture" } }, { actorId: "pm", goalId: gid });
    await (m.supervisor as unknown as { completeMission(): Promise<void> }).completeMission();
    await waitFor("mission completed", () => goalOf(m)?.status === "COMPLETED", 8000);

    const reopened = await m.supervisor.reopenGoal({ reason: "negative steps are accepted", by: "human" });
    assert.equal(reopened.ok, true, reopened.reason);
    const minted = goalOf(m)!.acceptanceCriteria.find((c) => c.id.startsWith("operator-feedback-"));
    assert.ok(minted, "the reopen minted its criterion");
    assert.match(minted.description, /published and accepted by pm \(`approve` on subject "criterion:operator-feedback-[0-9a-f]+", citing that work\)/);
    assert.doesNotMatch(minted.description, /accepted by the operator/);
  } finally {
    await m.cleanup();
  }
});
