import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, type TestMesh } from "../helpers";
import { ManualClock, settle } from "../support/manual-clock";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * A busy seat must not lose an interest wake (NOTES-test-gaps.md §5.3).
 *
 * `requestActivation` answers a request for a seat that is mid-turn by
 * stashing it in `wakeAfterTurn` and replaying it when the turn ends. The
 * committed comment on that branch says interest wakes "are stashed now"; the
 * condition beneath it stashes only `message`, `recovery` and explicit wakes.
 * An `interest_event` wake falls through to `return true` — which
 * `activateAgent` reports as `{ queued: true }` — and is gone. With a low
 * `max_active_agents` a subscriber is busy most of the time, which is how a
 * live run produced 4 interest wakes from 74 eligible events.
 *
 * These drive the real path: the event is emitted on the kernel, the scheduler
 * picks it up from the bus, and the seat's turn is held open by a gate the test
 * controls, so "busy" means exactly the window the test says it does. The clock
 * is a ManualClock that is never advanced, so no wait-sweep nudge or stale-mail
 * floor can supply a turn the event itself did not.
 */

const DONE = { operations: [{ op: "done" } as MeshOp] };

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

async function busyDev(): Promise<{ m: TestMesh; held: ReturnType<typeof gate>; reasons: Array<{ kind: string; eventId?: string; messageId?: string }> }> {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", interests: ["dependency.changed"] },
      { id: "src", role: "developer", interests: [] },
    ],
    mayContact: { dev: [], src: ["dev"] },
    startup: [],
    maxActiveAgents: 1,
    clock: new ManualClock(Date.now()),
  });
  const held = gate();
  const reasons: Array<{ kind: string; eventId?: string; messageId?: string }> = [];
  let first = true;
  stub(m).setScript("dev", async (ctx) => {
    reasons.push({ kind: ctx.activation.kind, eventId: ctx.activation.eventId, messageId: ctx.activation.messageId });
    // Only the FIRST turn is held: that is the busy window. Every later turn
    // answers at once, so a replayed wake is observable as a second turn.
    if (first) {
      first = false;
      await held.wait;
    }
    return DONE;
  });
  stub(m).setScript("src", async () => DONE);
  await m.supervisor.activateAgent("dev", { kind: "manual" });
  await settle(20);
  assert.equal(m.supervisor.isTurnInFlight("dev"), true, "precondition: dev is mid-turn");
  return { m, held, reasons };
}

const turnsOf = (m: TestMesh, id: string) => m.supervisor.getRecentTurns(1000).filter((t) => t.agentId === id);

test(
  "busy seat: an interest event that arrives mid-turn is replayed when the turn ends",
  async () => {
    const { m, held, reasons } = await busyDev();
    try {
      const evt = await m.kernel.emit("dependency.changed", { files: ["package.json"], summary: "lodash 4 → 5" }, { actorId: "src" });
      await settle(20);
      held.open();
      await waitFor("dev's held turn to finish", () => !m.supervisor.isTurnInFlight("dev") && turnsOf(m, "dev").every((t) => t.status !== "running"), 5000);
      await settle(40);
      await waitFor("the mesh to go quiet", () => m.supervisor.isIdle(), 5000);

      assert.ok(
        reasons.some((r) => r.kind === "interest_event" && r.eventId === evt.id),
        `dev subscribed to dependency.changed and was busy when one landed, so it must take a turn for it afterwards — turns taken: ${JSON.stringify(reasons)}`,
      );
    } finally {
      held.open();
      await m.cleanup();
    }
  },
);

test("busy seat: mail that arrives mid-turn still buys a follow-up turn", async () => {
  // The control for the test above: the fixture CAN observe a replayed wake,
  // so the BUG above is a missing branch and not a blind fixture. Mail has two
  // routes to that turn — the `wakeAfterTurn` stash and `notifyTurnFinished`'s
  // unread-mail requeue — and this pins the outcome, not either route: it
  // survives losing one of them and fails only when both are gone (checked by
  // breaking each in the compiled build).
  const { m, held, reasons } = await busyDev();
  try {
    const sent = await m.supervisor.humanSend(["dev"], "INFORM", { note: "mail while you work" });
    await settle(20);
    held.open();
    await waitFor("dev to take its follow-up turn", () => reasons.length >= 2, 5000);
    assert.equal(reasons[1]?.kind, "message", `the replayed wake is the mail: ${JSON.stringify(reasons)}`);
    assert.ok(sent.messageId, "precondition: the send was accepted");
  } finally {
    held.open();
    await m.cleanup();
  }
});

test("busy seat: an interest event never displaces a stashed mail wake", async () => {
  // `wakeAfterTurn` holds ONE entry per seat, so whatever fix lands for the
  // test above must not let an interest wake cost the mail its turn: mail is
  // the stronger claim, and losing it loses a reply someone is owed. Today a
  // naive fix that let the interest wake overwrite the stash would still pass
  // here, because the unread-mail requeue in `notifyTurnFinished` catches the
  // mail anyway — the overwrite §5.3 warns about is real, but for mail it is
  // covered by a second route. This pins the outcome so it stays covered.
  const { m, held, reasons } = await busyDev();
  try {
    await m.supervisor.humanSend(["dev"], "INFORM", { note: "mail while you work" });
    await settle(20);
    await m.kernel.emit("dependency.changed", { files: ["package.json"], summary: "lodash 4 → 5" }, { actorId: "src" });
    await settle(20);
    held.open();
    await waitFor("dev to take its follow-up turn", () => reasons.length >= 2, 5000);
    await settle(40);
    assert.ok(
      reasons.slice(1).some((r) => r.kind === "message"),
      `the stashed mail still buys its turn after an interest event arrived behind it: ${JSON.stringify(reasons)}`,
    );
  } finally {
    held.open();
    await m.cleanup();
  }
});
