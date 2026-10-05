import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, type TestMesh } from "../helpers";
import { ManualClock, settle } from "../support/manual-clock";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * The owner of a patch is told what a verdict did to it, even when it was busy and mail was waiting.
 *
 * `noticeOwnerOfVerdict` wakes the owner with a note ("lead approved your CodePatch: it is now APPROVED. It needs VERIFIED next, and
 * you can move it"). That wake is an interest wake, the weakest kind, and a seat that is mid-turn has it stashed behind its turn.
 * The stash holds one wake per seat, and a notice was carried only by a recovery wake: behind mail, or replaced by mail, the
 * interest wake was dropped with its note, and the mail wake that survived said "N messages waiting".
 *
 * The eighteenth cronlite run's developer was mid-turn when the tech lead approved its test-suite patch (03:55:10). It was never
 * told. The patch sat APPROVED, every criterion was evidenced, and the mission waited until the stall watchdog woke the developer
 * at 03:57:38; the patch merged at 03:59:02 (the same note, delivered to an idle developer at 03:52:32 for the implementation
 * patch, was acted on in 9 s). Without mail the replay worked, which is why only a busy seat with mail waiting lost it.
 *
 * The seat's turn is held open by a gate the test controls, so "busy" means exactly the window the test says it does, and the clock
 * is never advanced, so no nudge supplies a turn the verdict's own wake did not.
 */

const DONE = { operations: [{ op: "done" } as MeshOp] };
const NOTICE = /lead approved your CodePatch "patch" v1: it is now APPROVED\. It needs VERIFIED next/;

type Turn = { kind: string; note?: string };

const gate = () => {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
};

const turnFor = (agentId: string) =>
  ({ turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`, agentId, reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] }) as never;

/** `dev` owns a patch the lead has under review, and is mid-turn (held) with nothing else to do. */
async function busyOwner(): Promise<{ m: TestMesh; id: string; held: ReturnType<typeof gate>; turns: Turn[] }> {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "test.execute"], interests: [] },
      { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review"], authority: ["implementation.approve"], interests: [] },
    ],
    mayContact: { dev: ["lead"], lead: ["dev"] },
    startup: [],
    maxActiveAgents: 2,
    clock: new ManualClock(Date.now()),
  });
  const created = await m.supervisor.createArtifact({ actorId: "dev", name: "patch", type: "CodePatch", content: "the patch, at length, with every file in it" });
  if (!("artifact" in created)) throw new Error("create failed");
  const id = created.artifact.id;
  await m.supervisor.transitionArtifact("dev", id, { to: "READY_FOR_REVIEW" });
  await m.supervisor.executeOp("dev", { op: "request_review", artifactId: id, reviewers: ["lead"] } as MeshOp, turnFor("dev"));
  const held = gate();
  const turns: Turn[] = [];
  let first = true;
  stub(m).setScript("dev", async (ctx) => {
    turns.push({ kind: ctx.activation.kind, note: ctx.activation.note });
    if (first) {
      first = false;
      await held.wait;
    }
    return DONE;
  });
  stub(m).setScript("lead", async () => DONE);
  await m.supervisor.activateAgent("dev", { kind: "manual" });
  await settle(20);
  assert.equal(m.supervisor.isTurnInFlight("dev"), true, "precondition: dev is mid-turn");
  return { m, id, held, turns };
}

const approve = (m: TestMesh, id: string) =>
  m.supervisor.executeOp("lead", { op: "approve", subject: "implementation", artifactId: id, comment: "reviewed" } as MeshOp, turnFor("lead"));

async function finishTurn(m: TestMesh, held: ReturnType<typeof gate>): Promise<void> {
  held.open();
  await waitFor("dev's held turn to finish", () => !m.supervisor.isTurnInFlight("dev"), 5000);
  await settle(60);
}

const told = (turns: Turn[]) => turns.slice(1).some((t) => NOTICE.test(t.note ?? ""));

test("a verdict that lands while the owner is busy, with nothing else waiting, reaches it in the follow-up turn (the control)", async () => {
  const { m, id, held, turns } = await busyOwner();
  try {
    const res = await approve(m, id);
    assert.equal(res.ok, true, String(res.reason));
    await finishTurn(m, held);
    assert.ok(told(turns), `the owner's follow-up turn carries what the verdict did: ${JSON.stringify(turns)}`);
  } finally {
    held.open();
    await m.cleanup();
  }
});

test("mail that arrived before the verdict does not cost the owner its notice", async () => {
  const { m, id, held, turns } = await busyOwner();
  try {
    await m.supervisor.humanSend(["dev"], "INFORM", { note: "mail while you work" });
    await settle(20);
    const res = await approve(m, id);
    assert.equal(res.ok, true, String(res.reason));
    await finishTurn(m, held);
    assert.ok(turns.length >= 2, `the stashed mail still buys its follow-up turn: ${JSON.stringify(turns)}`);
    assert.ok(told(turns), `and the follow-up turn says the patch was approved and what it needs next: ${JSON.stringify(turns)}`);
  } finally {
    held.open();
    await m.cleanup();
  }
});

test("mail that arrives after the verdict does not replace its notice", async () => {
  const { m, id, held, turns } = await busyOwner();
  try {
    const res = await approve(m, id);
    assert.equal(res.ok, true, String(res.reason));
    await settle(20);
    await m.supervisor.humanSend(["dev"], "INFORM", { note: "mail while you work" });
    await settle(20);
    await finishTurn(m, held);
    assert.ok(turns.length >= 2, `the mail still buys its follow-up turn: ${JSON.stringify(turns)}`);
    assert.ok(told(turns), `and the follow-up turn still carries the notice the mail wake replaced: ${JSON.stringify(turns)}`);
  } finally {
    held.open();
    await m.cleanup();
  }
});

/** What the supervisor asks of the scheduler for a verdict notice, with a note of our own so two can be told apart. */
const notice = (note: string, priority: number) => ({
  agentId: "dev",
  reason: { kind: "interest_event" as const, eventId: `evt-${note}`, eventType: "review.approved" as const, note },
  priority,
});

test("two notices that arrive behind a running turn both reach the owner, whichever of them the stash keeps", async () => {
  for (const [first, second] of [
    [3, 3], // the second is coalesced into the first
    [3, 4], // the second is the more urgent weak wake and replaces it
  ] as const) {
    const { m, held, turns } = await busyOwner();
    try {
      assert.equal(await m.scheduler.requestActivation(notice("FIRST NOTICE", first)), true);
      assert.equal(await m.scheduler.requestActivation(notice("SECOND NOTICE", second)), true);
      await finishTurn(m, held);
      const note = turns.slice(1).map((t) => t.note ?? "").join("\n");
      assert.match(note, /FIRST NOTICE/, `priorities ${first} then ${second}: ${JSON.stringify(turns)}`);
      assert.match(note, /SECOND NOTICE/, `priorities ${first} then ${second}: ${JSON.stringify(turns)}`);
    } finally {
      held.open();
      await m.cleanup();
    }
  }
});
