import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, type TestMesh } from "../helpers";
import { ManualClock } from "../support/manual-clock";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * A broadcast must reach its recipients (NOTES-test-gaps.md §5.4).
 *
 * The broadcast gate in `handleEvent` wakes only seats whose `interests` match
 * `message.sent`; `interests` defaults to `[]`; and no shipped example declares
 * `message.*` (checked 2026-09-25 against all five `examples/*` meshes). So in
 * every shipped mesh a broadcast wakes nobody at the moment it is sent. That
 * part is deliberate and pinned by `tests/protocol/interaction-modes.test.ts`
 * ("uninterested seat does not wake"): an announcement obliges nobody, and
 * waking the roster for one is the largest avoidable spend in a wide mesh.
 *
 * The least opinionated correct behaviour is therefore NOT "wake immediately".
 * It is: the broadcast is delivered to every recipient AND every recipient
 * takes a turn that can read it within a bound — or, failing that, config
 * load warns that broadcasts reach nobody. The first half is what the
 * stale-mail floor in `tickWaiting` exists to provide (`STALE_MAIL_MS`, 240s:
 * "a seat whose declared interests never fire has no next natural
 * activation"), so that is what this pins. Whether four minutes is an
 * acceptable latency for every broadcast in every shipped mesh — and whether
 * load should say so — is a design question, not asserted here.
 *
 * Runs on a ManualClock: the four minutes are advanced, not slept.
 */

const STALE_MAIL_MS = 240_000; // packages/scheduler/src/index.ts, not exported
const WAIT_WAKEUP_MS = 10_000;

const DONE = { operations: [{ op: "done" } as MeshOp] };

function fakeTurn(agentId: string) {
  return {
    turnId: `t-${agentId}-${Math.random().toString(36).slice(2, 8)}`,
    agentId,
    reason: { kind: "manual" },
    sentOps: 0,
    publishedOps: 0,
    waitRequested: false,
    escalated: false,
    results: [],
  } as never;
}

const turnsAfter = (m: TestMesh, id: string, sinceMs: number) =>
  m.supervisor.getRecentTurns(1000).filter((t) => t.agentId === id && Date.parse(t.startedAt) >= sinceMs);

test("broadcast: with no seat interested in mail, every recipient still takes a turn within the stale-mail floor", async () => {
  const clock = new ManualClock(Date.now());
  const m = await makeMesh({
    // Exactly the shipped shape: nobody lists `message.sent`, and the
    // interests that ARE declared never fire in this test.
    agents: [
      { id: "architect", role: "architect", interests: ["goal.escalated"] },
      { id: "dev", role: "developer", interests: ["design.question"] },
      { id: "qa", role: "qa", interests: [] },
    ],
    mayContact: { architect: ["dev", "qa"] },
    startup: [],
    clock,
    waitWakeupMs: WAIT_WAKEUP_MS,
    // Out of reach. The supervisor's stall watchdog (180s in the fixture
    // default) would otherwise wake every seat of a quiet mission first, and
    // this test would be measuring the watchdog rather than the floor that
    // exists for mail — verified: with the floor disabled in the compiled
    // build and the watchdog left at 180s, this still passed.
    stallIdleMs: 3_600_000,
  });
  try {
    for (const id of ["architect", "dev", "qa"]) stub(m).setScript(id, async () => DONE);
    const sentAt = clock.nowMs();
    const bc = await m.supervisor.executeOp(
      "architect",
      { op: "broadcast", type: "INFORM", payload: { note: "the API contract is frozen" } } as MeshOp,
      fakeTurn("architect"),
    );
    assert.equal(bc.ok, true, bc.reason);
    const msg = m.kernel.state.messages.get(bc.messageId!);
    assert.equal(msg?.control?.mode, "broadcast", "precondition: it went out as a broadcast");

    for (const id of ["dev", "qa"]) {
      assert.ok(
        (m.kernel.state.unread.get(id) ?? []).includes(bc.messageId!),
        `${id}: delivered — the gate suppresses the wake, never the delivery`,
      );
    }

    await clock.advanceAndSettle(STALE_MAIL_MS + WAIT_WAKEUP_MS);

    const unwoken = ["dev", "qa"].filter((id) => turnsAfter(m, id, sentAt).length === 0);
    // And it was the mail that bought the turn, not some other timer.
    for (const id of ["dev", "qa"]) {
      for (const t of turnsAfter(m, id, sentAt)) assert.match(String(t.reason.note ?? ""), /mail has been waiting unread/, `${id}: ${JSON.stringify(t.reason)}`);
    }
    assert.deepEqual(
      unwoken,
      [],
      `a broadcast recipient must take a turn that can read it within ${STALE_MAIL_MS + WAIT_WAKEUP_MS}ms; these took none`,
    );
  } finally {
    await m.cleanup();
  }
});
