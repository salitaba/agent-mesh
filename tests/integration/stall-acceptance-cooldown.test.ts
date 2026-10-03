import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, evidenceContent } from "../helpers";
import type { ActivationReason, MeshOp } from "../../packages/protocol/src/index";

/**
 * A nudge sent about one situation does not hold back the first nudge the next situation needs.
 *
 * The sixteenth cronlite run: the watchdog nudged the tech lead at 08:59:04.7 to move a patch. The patch merged at 08:59:10, QA's
 * report went FINAL at 08:59:20, QA's turn ended at 08:59:27, and the only thing left was the pm's acceptance of the last two
 * criteria, with the proof in hand. The acceptance nudge is meant to come after a short grace (the idle window over
 * `ACCEPTANCE_GRACE_DIVISOR`, 15 s there), so the first watchdog tick past it, 09:00:04.7, was the one. It came at 09:04:04.7:
 * exactly the five-minute cooldown after the nudge before it, which had been about something else. The pm accepted both criteria
 * 16 seconds later. The mission sat quiet for 4 minutes 37 seconds with nothing to wait for, which is what the thirteenth run's
 * finish-line claim (`sentBeforeTheFinishLine`) had already taught the cooldown for one kind of situation.
 *
 * Driven the way `stall-acceptor.test.ts` does it: explicit `checkStall()` calls with the gates poked, so what is asserted is the
 * DECISION and never a sleep.
 */

const AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "test.execute", "git.commit"], interests: [] },
  { id: "qa", role: "qa", authority: ["quality.pass"], capabilities: ["repository.read", "test.execute", "test.write"], interests: [] },
  { id: "pm", role: "product-manager", authority: ["requirements.accept"], capabilities: ["repository.read"], interests: [] },
];
const IDS = AGENTS.map((a) => a.id);
const MANUAL = [
  { id: "cli-contract-met", description: "the command line does what SPEC.md says", mandatory: true },
  { id: "library-contract-met", description: "the library does what SPEC.md says", mandatory: true },
];

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

interface StallInternals {
  checkStall(): Promise<void>;
  acceptanceReady(): boolean;
  lastTurnAt: number;
  lastStallNudgeAt: number;
}
const internals = (m: Mesh): StallInternals => m.supervisor as unknown as StallInternals;
const quiet = (m: Mesh): void => void (internals(m).lastTurnAt = Date.now() - 10 * 60_000);
const idle = (m: Mesh, what: string) => waitFor(what, () => m.scheduler.pending() === 0 && m.scheduler.running() === 0);

async function mesh() {
  const m = await makeMesh({
    agents: AGENTS,
    mayContact: Object.fromEntries(IDS.map((id) => [id, IDS.filter((o) => o !== id)])),
    startup: [],
    criteria: MANUAL,
    mode: "parked",
    stallIdleMs: 60_000,
    stallCooldownMs: 300_000,
    stallNoopRetryMs: 600_000,
  } as never);
  const nudges: Array<{ agent: string; note: string }> = [];
  for (const id of IDS) {
    stub(m).setScript(id, async (input) => {
      const reason: ActivationReason = input.activation;
      if (reason.kind === "timer" && String(reason.note).startsWith("stall watchdog:")) nudges.push({ agent: id, note: String(reason.note) });
      return { operations: [{ op: "wait" } as MeshOp] };
    });
  }
  await m.goLive();
  await idle(m, "go-live to settle");
  return { m, nudges };
}

async function submitReport(m: Mesh) {
  const created = await m.supervisor.createArtifact({ actorId: "qa", name: "QA report", type: "TestReport", content: evidenceContent("QA report") });
  if (!("artifact" in created)) throw new Error(`create failed: ${JSON.stringify(created)}`);
  const moved = await m.supervisor.transitionArtifact("qa", created.artifact.id, { to: "READY_FOR_REVIEW" });
  assert.equal(moved.ok, true, String(moved.reason));
}

test("a nudge about something else, sent a minute before the proof arrived, does not hold back the acceptance nudge", async () => {
  const { m, nudges } = await mesh();
  try {
    // The nudge before: nothing is submitted, so nothing can be accepted yet. It is spent, and the cooldown runs from it.
    quiet(m);
    internals(m).lastStallNudgeAt = 0;
    await internals(m).checkStall();
    await waitFor("the first nudge", () => nudges.length === 1);
    await idle(m, "the first nudged turn");
    assert.equal(internals(m).acceptanceReady(), false, "fixture: the proof is not in yet");

    // A minute later the report is submitted: only acceptances are unmet and the proof is in hand.
    internals(m).lastStallNudgeAt = Date.now() - 60_000;
    await submitReport(m);
    assert.equal(internals(m).acceptanceReady(), true, "fixture: acceptance is ready");
    await internals(m).checkStall(); // a watchdog tick that sees it (not quiet long enough to nudge yet)
    assert.equal(nudges.length, 1, "no second nudge on that tick");

    quiet(m);
    await internals(m).checkStall();
    await waitFor("the acceptance nudge", () => nudges.length === 2);
    assert.equal(nudges[1]!.agent, "pm", "the seat that may accept, not after another five minutes");
    assert.match(nudges[1]!.note, /the acceptance is yours to give/);
  } finally {
    await m.cleanup();
  }
});

test("a nudge sent AFTER acceptance became ready is still cooled: the same situation is not nudged again and again", async () => {
  const { m, nudges } = await mesh();
  try {
    await submitReport(m);
    assert.equal(internals(m).acceptanceReady(), true);
    internals(m).lastStallNudgeAt = 0;
    quiet(m);
    await internals(m).checkStall();
    await waitFor("the acceptance nudge", () => nudges.length === 1);
    await idle(m, "the nudged turn");

    quiet(m);
    await internals(m).checkStall();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(nudges.length, 1, "the cooldown holds: the seat was just nudged about exactly this");
  } finally {
    await m.cleanup();
  }
});

test("readiness lost and regained after a nudge is a new situation: the cooldown does not hold it", async () => {
  const { m, nudges } = await mesh();
  try {
    await submitReport(m); // ready
    internals(m).lastStallNudgeAt = 0;
    quiet(m);
    await internals(m).checkStall();
    await waitFor("the first acceptance nudge", () => nudges.length === 1);
    await idle(m, "the nudged turn");

    // The report is re-versioned (a new version restarts review: not citable), a tick sees that, and then it is submitted again.
    const report = [...m.kernel.state.artifacts.values()].find((a) => a.name === "QA report")!;
    const v2 = await m.supervisor.createArtifact({ actorId: "qa", name: "QA report", type: "TestReport", content: evidenceContent("QA report v2"), asVersionOf: report.id });
    assert.ok("artifact" in v2, JSON.stringify(v2));
    assert.equal(internals(m).acceptanceReady(), false, "fixture: a draft is not citable");
    await internals(m).checkStall(); // sees it is no longer ready
    const moved = await m.supervisor.transitionArtifact("qa", report.id, { to: "READY_FOR_REVIEW" });
    assert.equal(moved.ok, true, String(moved.reason));
    assert.equal(internals(m).acceptanceReady(), true);
    await internals(m).checkStall(); // sees it is ready again, after the last nudge

    quiet(m);
    await internals(m).checkStall();
    await waitFor("the second acceptance nudge", () => nudges.length === 2);
    assert.equal(nudges[1]!.agent, "pm");
  } finally {
    await m.cleanup();
  }
});
