import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, type TestMesh } from "../helpers";
import { ManualClock, settle } from "../support/manual-clock";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * A broadcast the seat did not subscribe to buys it no turn, by any route.
 *
 * An announcement obliges nobody, so the send path wakes only the seats whose `interests` match
 * `message.sent` (`tests/protocol/interaction-modes.test.ts`), and the wait-timer sweep leaves
 * broadcasts out of its count (`tests/scheduler/broadcast-reach.test.ts` pins the floor under
 * both). The third site that counts unread mail, the retry `notifyTurnFinished` makes for mail that
 * landed while a turn was running, asked `defersMail`, which knew a message's delivery class and
 * the seat's own `wake` policy and not the gate: a broadcast in a busy seat's box was a wake at the
 * end of its turn, for the message the gate had just refused a wake for.
 *
 * The fifth cronlite run's seats announce with `mesh_announce`, which is a broadcast when it names
 * nobody, and 16 of its 42 mail wakes were headed by a broadcast INFORM to a seat whose interests
 * did not list `message.sent`. Seven of those turns ended in `wait`, `done` or nothing.
 */

const DONE = { operations: [{ op: "done" } as MeshOp] };

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

function fakeTurn(agentId: string) {
  return { turnId: `t-${agentId}`, agentId, reason: { kind: "manual" }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] } as never;
}

type Turn = { kind: string; messageId?: string; unread: number };

/** `dev` is mid-turn, holding a first turn open; `qa` is free to announce into its box. */
async function busyDev(interests: string[]): Promise<{ m: TestMesh; held: ReturnType<typeof gate>; turns: Turn[]; clock: ManualClock }> {
  const clock = new ManualClock(Date.now());
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", interests },
      { id: "qa", role: "qa", interests: [] },
    ],
    mayContact: { dev: ["qa"], qa: ["dev"] },
    startup: [],
    maxActiveAgents: 2,
    clock,
    waitWakeupMs: 10_000,
    // Out of reach, as in broadcast-reach: the supervisor's watchdog would otherwise supply turns
    // of its own, and the floor test below would be counting those.
    stallIdleMs: 3_600_000,
    stallCooldownMs: 3_600_000,
    stallNoopRetryMs: 3_600_000,
  });
  const held = gate();
  const turns: Turn[] = [];
  let first = true;
  stub(m).setScript("dev", async (ctx) => {
    turns.push({ kind: ctx.activation.kind, messageId: ctx.activation.messageId, unread: ctx.context.unreadMail.length });
    if (first) {
      first = false;
      await held.wait;
    }
    return DONE;
  });
  stub(m).setScript("qa", async () => DONE);
  await m.supervisor.activateAgent("dev", { kind: "manual" });
  await settle(20);
  assert.equal(m.supervisor.isTurnInFlight("dev"), true, "precondition: dev is mid-turn");
  return { m, held, turns, clock };
}

const announce = async (m: TestMesh): Promise<string> => {
  const res = await m.supervisor.executeOp("qa", { op: "broadcast", type: "INFORM", payload: { note: "the schema moved" } } as MeshOp, fakeTurn("qa"));
  assert.equal(res.ok, true, res.reason);
  assert.equal(m.kernel.state.messages.get(res.messageId!)?.control?.mode, "broadcast", "precondition: it went out as a broadcast");
  return res.messageId!;
};

const quiet = async (m: TestMesh): Promise<void> => {
  await waitFor("the mesh to go quiet", () => m.supervisor.isIdle(), 8000);
  await settle(60);
  await waitFor("the mesh to stay quiet", () => m.supervisor.isIdle(), 8000);
};

test("a broadcast that lands mid-turn buys the seat no follow-up turn, and is still in its box", async () => {
  const { m, held, turns } = await busyDev(["design.question"]);
  try {
    const id = await announce(m);
    await settle(20);
    held.open();
    await quiet(m);

    assert.deepEqual(turns.map((t) => t.kind), ["manual"], `an announcement it did not subscribe to is not a reason to run: ${JSON.stringify(turns)}`);
    assert.ok((m.kernel.state.unread.get("dev") ?? []).includes(id), "the gate suppresses the wake, never the delivery: it is read on the next turn the seat takes");
  } finally {
    held.open();
    await m.cleanup();
  }
});

test("a seat that subscribed to mail is still woken for the same broadcast", async () => {
  // The control: the same sequence with `message.sent` declared. Without it the test above would pass
  // for a retry that never fires at all.
  const { m, held, turns } = await busyDev(["message.sent"]);
  try {
    await announce(m);
    await settle(20);
    held.open();
    await quiet(m);

    assert.deepEqual(turns.map((t) => [t.kind, t.unread]), [["manual", 0], ["message", 1]], `the subscriber reads it in the turn the broadcast bought: ${JSON.stringify(turns)}`);
  } finally {
    held.open();
    await m.cleanup();
  }
});

test("directed mail behind a broadcast still buys its turn, and the turn is for the directed mail", async () => {
  const { m, held, turns } = await busyDev([]);
  try {
    const broadcastId = await announce(m);
    const direct = await m.supervisor.sendMessage({ from: "qa", to: ["dev"], type: "INFORM", newThread: { subject: "for you" }, payload: { note: "for you alone" } });
    assert.equal(direct.accepted, true, direct.reason);
    await settle(20);
    held.open();
    await quiet(m);

    assert.deepEqual(turns.map((t) => t.kind), ["manual", "message"], JSON.stringify(turns));
    assert.equal(turns[1]!.messageId, direct.messageId, "the wake names the mail that bought it, not the announcement ahead of it in the box");
    assert.equal(turns[1]!.unread, 2, "and the turn reads both, which is how the announcement is delivered");
    assert.ok(!(m.kernel.state.unread.get("dev") ?? []).includes(broadcastId));
  } finally {
    held.open();
    await m.cleanup();
  }
});

test("the floor still reads it: a seat that took no turn for the announcement takes one when the mail has waited", async () => {
  const { m, held, turns, clock } = await busyDev([]);
  try {
    await announce(m);
    await settle(20);
    held.open();
    await quiet(m);
    assert.equal(turns.length, 1, "precondition: the announcement bought nothing");

    await clock.advanceAndSettle(240_000 + 10_000);
    await quiet(m);
    assert.equal(turns.length, 2, `mail that has waited unread is what a turn is bought for: ${JSON.stringify(turns)}`);
    assert.match(String((m.supervisor.getRecentTurns(1000).find((t) => t.agentId === "dev" && t.reason.kind === "timer")?.reason.note) ?? ""), /mail has been waiting unread/);
    assert.equal(turns[1]!.unread, 1, "and the turn it buys reads the announcement");
  } finally {
    held.open();
    await m.cleanup();
  }
});

test("an announcement waiting in the box is not outstanding work: a progress tick the seat subscribed to is still not a turn", async () => {
  // `isRedundantObservation` asks whether the seat has mail that needs the turn regardless of the
  // event, through the same `defersMail`. Counting an announcement there woke a seat for a scoreboard
  // tick because it had been told something in passing.
  const { m, held, turns } = await busyDev(["goal.progress"]);
  try {
    held.open();
    await quiet(m);
    assert.equal(turns.length, 1, "fixture: the first turn is over and dev is idle");

    await announce(m);
    await settle(20);
    await m.kernel.emit("goal.progress", { completed: 1, total: 5, ratio: 0.2 }, { actorId: "qa" });
    await quiet(m);

    assert.equal(turns.length, 1, `idle, with only an announcement unread, dev has nothing a tick is news to: ${JSON.stringify(turns)}`);
    const suppressed = (m.scheduler as unknown as { suppressedWakes(): Record<string, number> }).suppressedWakes();
    assert.equal(suppressed.redundant_observation, 1, "and the tick is counted as a redundant observation, not silent");
  } finally {
    held.open();
    await m.cleanup();
  }
});
