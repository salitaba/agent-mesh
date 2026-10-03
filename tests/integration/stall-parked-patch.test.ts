import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, evidenceContent } from "../helpers";
import type { ActivationReason, MeshOp } from "../../packages/protocol/src/index";

/**
 * A patch parked on the merge ladder does not take every nudge from the seats that could do something else.
 *
 * The fourteenth cronlite run's QA passed at 00:55:55 and the mission stood on two acceptances only the pm could give,
 * with a TestReport citable. The CLI patch was MERGEABLE: its merge had been refused (wrongly: its work was already in the
 * product). The watchdog's first branch is "the seat that can move a parked patch", so at 00:56:20, 5 s into the quiet
 * (the finish-line grace), it woke the tech lead, whose merge was refused again; the cooldown then held the next nudge to
 * 01:01:20, and the pm was woken at 01:00:50 by the unread-mail sweep. 5 min 22 s from the proof to the acceptance, where
 * the same flow in the thirteenth run took 13 s.
 *
 * Two changes. When every unmet criterion closes by an acceptance and a report can be cited, the acceptor comes first:
 * nothing waits on the patch. And the merge-ladder branch, alone among the watchdog's, did not skip a seat whose previous
 * nudge bought nothing, so a patch its merger cannot move would draw every nudge to the cap.
 *
 * Driven the way `stall-acceptor.test.ts` does it: explicit `checkStall()` calls with the gates poked, so what is asserted is
 * the DECISION and never a sleep.
 */

// `dev` first: the roster's first seat is what the fallbacks end on, so a driver that is NOT `dev` was chosen on purpose.
const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "test.execute", "git.commit"], interests: [] },
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review", "git.merge"], authority: ["implementation.approve"], interests: [] },
  { id: "qa", role: "qa", authority: ["quality.pass"], capabilities: ["repository.read", "test.execute", "test.write"], interests: [] },
  { id: "pm", role: "product-manager", authority: ["requirements.accept"], capabilities: ["repository.read"], interests: [] },
];
const ALL = AGENTS.map((a) => a.id);
const COMM = Object.fromEntries(ALL.map((id) => [id, ALL.filter((o) => o !== id)]));
/** Nothing the runtime evidences by itself: each closes by an acceptance or not at all. */
const MANUAL = [
  { id: "library-contract-met", description: "the library does what SPEC.md says", mandatory: true },
  { id: "cli-contract-met", description: "the command line does what SPEC.md says", mandatory: true },
];
/** One the mesh evidences from a merge, so an acceptance is not what the mission is waiting for. */
const MERGED = { id: "implementation-merged", description: "the implementation is merged", mandatory: true };

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

interface StallInternals {
  checkStall(): Promise<void>;
  stallDriver(): string | undefined;
  stallWakeNote(driver?: string): string;
  lastTurnAt: number;
  lastStallNudgeAt: number;
  lastStallDriver: string | undefined;
  stallNudgeStreak: number;
}
const internals = (m: Mesh): StallInternals => m.supervisor as unknown as StallInternals;
const goQuiet = (m: Mesh): void => void (internals(m).lastTurnAt = Date.now() - 10 * 60_000);
const clearCooldown = (m: Mesh): void => void (internals(m).lastStallNudgeAt = Date.now() - 10 * 60_000);
const idle = (m: Mesh, what: string) => waitFor(what, () => m.scheduler.pending() === 0 && m.scheduler.running() === 0);

const turnFor = (agentId: string) =>
  ({ turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`, agentId, reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] }) as never;
const op = (m: Mesh, as: string, o: Record<string, unknown>) => m.supervisor.executeOp(as, o as unknown as MeshOp, turnFor(as));

/** A live mesh whose seats only record the nudge they were handed and wait. */
async function mesh(criteria: typeof MANUAL, agents: typeof AGENTS = AGENTS) {
  const ids = agents.map((a) => a.id);
  const m = await makeMesh({
    agents,
    mayContact: Object.fromEntries(ids.map((id) => [id, ids.filter((o) => o !== id)])),
    startup: [],
    criteria,
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

/** A CodePatch of `dev`'s walked to MERGEABLE and left there: approved, verified, and not merged. */
async function parkPatch(m: Mesh): Promise<string> {
  const created = await m.supervisor.createArtifact({ actorId: "dev", name: "cli", type: "CodePatch", content: evidenceContent("cli") });
  if (!("artifact" in created)) throw new Error(`create failed: ${JSON.stringify(created)}`);
  const id = created.artifact.id;
  assert.equal((await m.supervisor.transitionArtifact("dev", id, { to: "READY_FOR_REVIEW" })).ok, true);
  await op(m, "dev", { op: "request_review", artifactId: id, reviewers: ["lead"] });
  assert.equal((await op(m, "lead", { op: "approve", subject: "implementation", artifactId: id })).ok, true);
  assert.equal((await m.supervisor.transitionArtifact("lead", id, { to: "VERIFIED" })).ok, true);
  assert.equal((await m.supervisor.transitionArtifact("lead", id, { to: "MERGEABLE" })).ok, true);
  assert.equal(m.kernel.state.artifacts.get(id)?.status, "MERGEABLE", "fixture: the patch is parked at the gate");
  return id;
}

/** QA's report, submitted: the proof an acceptance could cite. */
async function submitReport(m: Mesh): Promise<void> {
  const created = await m.supervisor.createArtifact({ actorId: "qa", name: "QA report", type: "TestReport", content: evidenceContent("QA report") });
  if (!("artifact" in created)) throw new Error(`create failed: ${JSON.stringify(created)}`);
  assert.equal((await m.supervisor.transitionArtifact("qa", created.artifact.id, { to: "READY_FOR_REVIEW" })).ok, true);
}

/** Tick the watchdog once with both gates open and let what it wakes settle. */
async function tick(m: Mesh, nudges: unknown[], expected: number): Promise<void> {
  goQuiet(m);
  clearCooldown(m);
  await internals(m).checkStall();
  await waitFor(`stall nudge ${expected}`, () => nudges.length === expected);
  await idle(m, `nudged turn ${expected}`);
}

test("every unmet criterion is an acceptance and a report can be cited: the pm is nudged, not the merger of a parked patch", async () => {
  const { m, nudges } = await mesh(MANUAL);
  try {
    await parkPatch(m);
    await submitReport(m);
    await m.goLive();
    await idle(m, "go-live to settle");
    await tick(m, nudges, 1);
    assert.equal(nudges[0]!.agent, "pm", "the seat that can close what is unmet; `lead` is the one that can move the parked patch, and nothing waits on it");
    const note = nudges[0]!.note;
    assert.match(note, /the acceptance is yours to give/, "the pm is told its own act");
    assert.doesNotMatch(note, /parked on the merge ladder/, "and not the rungs of a patch it cannot move");
  } finally {
    await m.cleanup();
  }
});

test("with no report to cite the merger still has the first nudge for a parked patch, as before", async () => {
  const { m, nudges } = await mesh(MANUAL);
  try {
    await parkPatch(m);
    await m.goLive();
    await idle(m, "go-live to settle");
    await tick(m, nudges, 1);
    assert.equal(nudges[0]!.agent, "lead", "acceptance is not ready: there is nothing for the pm to cite yet, so the patch is the one move on the board");
    assert.match(nudges[0]!.note, /A patch is parked on the merge ladder: .* is MERGEABLE and nobody has moved it/);
    assert.match(internals(m).stallWakeNote("pm"), /A patch is parked on the merge ladder/, "the pm's note says the same until there is a report to cite: its act is not ready");
  } finally {
    await m.cleanup();
  }
});

test("a criterion the mesh evidences from a merge is unmet: the patch is what the mission waits on, and the merger is nudged though a report is in", async () => {
  const { m, nudges } = await mesh([MERGED, ...MANUAL]);
  try {
    await parkPatch(m);
    await submitReport(m);
    await m.goLive();
    await idle(m, "go-live to settle");
    await tick(m, nudges, 1);
    assert.equal(nudges[0]!.agent, "lead", "implementation-merged is closed by a merge: an acceptance is not the question yet");
  } finally {
    await m.cleanup();
  }
});

test("a merger whose nudge bought nothing is not nudged twice running: the next goes to a seat with something to read", async () => {
  const { m, nudges } = await mesh([MERGED, ...MANUAL]);
  try {
    await parkPatch(m);
    // `dev` has unread mail, so it is what the fallbacks reach once the merger is passed over.
    assert.equal((await op(m, "qa", { op: "send", type: "INFORM", to: ["dev"], newThread: { subject: "FYI" }, payload: { note: "something to read" } })).ok, true);
    await m.goLive();
    await idle(m, "go-live to settle");
    await tick(m, nudges, 1);
    assert.equal(nudges[0]!.agent, "lead", "the merger of the parked patch first");
    assert.equal(internals(m).lastStallDriver, "lead");
    assert.ok(internals(m).stallNudgeStreak > 0, "and it bought nothing: it waited");

    assert.equal(internals(m).stallDriver(), "dev", "the next driver is not the merger again");
    await tick(m, nudges, 2);
    assert.equal(nudges[1]!.agent, "dev");
  } finally {
    await m.cleanup();
  }
});

test("a merger whose nudge moved something is nudged again for the next rung", async () => {
  const { m, nudges } = await mesh([MERGED, ...MANUAL]);
  try {
    await parkPatch(m);
    await m.goLive();
    await idle(m, "go-live to settle");
    await tick(m, nudges, 1);
    assert.equal(nudges[0]!.agent, "lead");
    // The turn produced work (what `afterTurn` records): the streak the guard reads is over, so the same seat may be nudged again.
    internals(m).stallNudgeStreak = 0;
    assert.equal(internals(m).stallDriver(), "lead", "the patch is still parked and the seat that moves it did move something last time");
  } finally {
    await m.cleanup();
  }
});

test("an acceptor whose nudge bought nothing passes the turn on, to the merger of the parked patch", async () => {
  const { m, nudges } = await mesh(MANUAL);
  try {
    await parkPatch(m);
    await submitReport(m);
    await m.goLive();
    await idle(m, "go-live to settle");
    await tick(m, nudges, 1);
    assert.equal(nudges[0]!.agent, "pm");
    assert.ok(internals(m).stallNudgeStreak > 0, "the pm waited: it bought nothing");
    assert.equal(internals(m).stallDriver(), "lead", "the same seat is not asked again; the patch is the other move on the board");
    await tick(m, nudges, 2);
    assert.equal(nudges[1]!.agent, "lead");
  } finally {
    await m.cleanup();
  }
});

test("of two seats that may accept, the one that has been idle longest is nudged", async () => {
  const second = { id: "pm2", role: "product-manager", authority: ["requirements.accept"], capabilities: ["repository.read"], interests: [] };
  const { m, nudges } = await mesh(MANUAL, [...AGENTS, second]);
  try {
    await parkPatch(m);
    await submitReport(m);
    await m.goLive();
    await idle(m, "go-live to settle");
    m.kernel.state.agents.get("pm")!.state.lastActivityAt = "2026-10-03T00:30:00.000Z";
    m.kernel.state.agents.get("pm2")!.state.lastActivityAt = "2026-10-03T00:10:00.000Z";
    await tick(m, nudges, 1);
    assert.equal(nudges[0]!.agent, "pm2", "pm2 has been idle for longer");
  } finally {
    await m.cleanup();
  }
});

test("a suspended acceptor is not the driver: a nudge to it is refused and buys nothing", async () => {
  const { m, nudges } = await mesh(MANUAL);
  try {
    await parkPatch(m);
    await submitReport(m);
    await m.goLive();
    await idle(m, "go-live to settle");
    m.kernel.state.agents.get("pm")!.state.lifecycle = "SUSPENDED";
    await tick(m, nudges, 1);
    assert.equal(nudges[0]!.agent, "lead", "the seat that can still act");
  } finally {
    await m.cleanup();
  }
});

test("the note to the acceptor names the acceptance and the citable report, whatever is parked", async () => {
  const { m } = await mesh(MANUAL);
  try {
    await parkPatch(m);
    await submitReport(m);
    const note = internals(m).stallWakeNote("pm");
    assert.match(note, /does not evidence these from its own events \(library-contract-met, cli-contract-met\)/);
    assert.match(note, /Submitted and citable: TestReport "QA report"/);
    assert.doesNotMatch(note, /parked on the merge ladder/);
    // To a seat that cannot accept, the same state still names the patch.
    assert.match(internals(m).stallWakeNote("lead"), /A patch is parked on the merge ladder/);
  } finally {
    await m.cleanup();
  }
});
