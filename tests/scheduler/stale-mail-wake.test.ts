import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, type TestMesh } from "../helpers";
import { ManualClock, settle } from "../support/manual-clock";
import { Scheduler, type TurnRunner } from "../../packages/scheduler/src/index";
import type { PolicyEvaluator } from "../../packages/core/src/ports";
import type { ActivationReason, MeshOp, PolicyDecisionResult } from "../../packages/protocol/src/index";

/**
 * A wake for mail is owed only while the mail is.
 *
 * Mail that lands while a seat is mid-turn buys it one follow-up turn, by two routes: the wake
 * the send path stashes behind the running turn, and the retry `notifyTurnFinished` makes for mail
 * left unread. `notifyTurnFinished` has two owners (the supervisor's `finally`, then the pump's),
 * and the second one runs after the first has already started the follow-up turn, so it found the
 * mail still unread (the follow-up turn drains it only when its model call returns) and stashed the
 * same wake again behind it. That stash was replayed after the follow-up turn had read the mail: a
 * third turn for an empty mailbox.
 *
 * Measured over the recorded cronlite runs, by comparing each mail wake with the turn that had
 * already been handed its message: run 3, 16 of 64 mail wakes (160k of 1.51M tokens); run 4, 9 of 42
 * (98k of 1.03M); run 5, 17 of 42 (190k of 1.23M). Nine of the seventeen in the last ended in
 * `wait`, `done` or nothing at all.
 *
 * The drop is at dequeue, the moment the turn would start and the last moment it is free, which is
 * where the wake for an ask that has since closed is already dropped (`isStaleWake`).
 */

const DONE = { operations: [{ op: "done" } as MeshOp] };

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

type Turn = { kind: string; messageId?: string; unread: number };

async function busySeat(over: { interests?: string[] } = {}): Promise<{ m: TestMesh; held: ReturnType<typeof gate>; turns: Turn[] }> {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", interests: over.interests ?? [] },
      { id: "qa", role: "qa", interests: [] },
    ],
    mayContact: { dev: [], qa: ["dev"] },
    startup: [],
    maxActiveAgents: 2,
    clock: new ManualClock(Date.now()),
  });
  const held = gate();
  const turns: Turn[] = [];
  let first = true;
  stub(m).setScript("dev", async (ctx) => {
    turns.push({ kind: ctx.activation.kind, messageId: ctx.activation.messageId, unread: ctx.context.unreadMail.length });
    // Only the first turn is held: that is the busy window mail lands in.
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
  return { m, held, turns };
}

const tell = (m: TestMesh, note: string) =>
  m.supervisor.sendMessage({ from: "qa", to: ["dev"], type: "INFORM", newThread: { subject: note }, payload: { note } });

const quiet = async (m: TestMesh): Promise<void> => {
  await waitFor("the mesh to go quiet", () => m.supervisor.isIdle(), 8000);
  await settle(60);
  await waitFor("the mesh to stay quiet", () => m.supervisor.isIdle(), 8000);
};

test("mail that lands mid-turn buys one follow-up turn, and the box that turn emptied buys no other", async () => {
  const { m, held, turns } = await busySeat();
  try {
    const sent = await tell(m, "the schema moved");
    assert.ok("messageId" in sent && sent.messageId, "precondition: the mail was accepted");
    await settle(20);
    held.open();
    await quiet(m);

    assert.deepEqual(
      turns.map((t) => t.kind),
      ["manual", "message"],
      `the mail is read by the follow-up turn and that is the end of it: ${JSON.stringify(turns)}`,
    );
    assert.equal(turns[1]!.unread, 1, "the follow-up turn was handed the mail it was woken for");
    assert.equal(m.kernel.state.unread.get("dev")?.length ?? 0, 0, "and left the box empty");
  } finally {
    held.open();
    await m.cleanup();
  }
});

test("mail that arrives after the follow-up turn started still buys a turn of its own", async () => {
  // The control: the drop is for a wake whose mail has been read, and must not touch one whose mail
  // has not. Two pieces of mail, one landing in each busy window, are two follow-up turns.
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", interests: [] },
      { id: "qa", role: "qa", interests: [] },
    ],
    mayContact: { dev: [], qa: ["dev"] },
    startup: [],
    maxActiveAgents: 2,
    clock: new ManualClock(Date.now()),
  });
  const gates = [gate(), gate()];
  const turns: Turn[] = [];
  stub(m).setScript("dev", async (ctx) => {
    const n = turns.length;
    turns.push({ kind: ctx.activation.kind, messageId: ctx.activation.messageId, unread: ctx.context.unreadMail.length });
    if (n < gates.length) await gates[n]!.wait;
    return DONE;
  });
  stub(m).setScript("qa", async () => DONE);
  try {
    await m.supervisor.activateAgent("dev", { kind: "manual" });
    await settle(20);
    await tell(m, "first");
    await settle(20);
    gates[0]!.open();
    await waitFor("the follow-up turn to start", () => turns.length >= 2);
    await settle(20);
    // The follow-up turn is mid-call and has built its context: this mail is not in it.
    await tell(m, "second");
    await settle(20);
    gates[1]!.open();
    await quiet(m);

    assert.deepEqual(
      turns.map((t) => [t.kind, t.unread]),
      [["manual", 0], ["message", 1], ["message", 1]],
      `each piece of mail was read by a turn woken for it, and no turn was woken for nothing: ${JSON.stringify(turns)}`,
    );
  } finally {
    for (const g of gates) g.open();
    await m.cleanup();
  }
});

// ------------------------------------------------------- what the drop does not touch

/** The wake the retry writes for a box it found unread, naming the head message. */
const RETRY_NOTE = "1 message waiting in your mailbox.";

type Wake = (req: Record<string, unknown>) => Promise<boolean>;

/** An idle `dev` that has already read one message, and the id of it: mail a wake can name that it has been handed. */
async function seatThatHasRead(): Promise<{ m: TestMesh; turns: Turn[]; read: string; wake: Wake }> {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", interests: [] },
      { id: "qa", role: "qa", interests: [] },
    ],
    mayContact: { dev: [], qa: ["dev"] },
    startup: [],
    maxActiveAgents: 2,
    clock: new ManualClock(Date.now()),
  });
  const turns: Turn[] = [];
  stub(m).setScript("dev", async (ctx) => {
    turns.push({ kind: ctx.activation.kind, messageId: ctx.activation.messageId, unread: ctx.context.unreadMail.length });
    return DONE;
  });
  const sent = await tell(m, "read me");
  assert.ok("messageId" in sent && sent.messageId, "fixture: the mail was accepted");
  await waitFor("dev to read it", () => turns.length === 1);
  await quiet(m);
  assert.equal(m.kernel.state.unread.get("dev")?.length ?? 0, 0, "fixture: dev has been handed it");
  const sched = m.scheduler as unknown as { requestActivation(req: Record<string, unknown>): Promise<boolean> };
  return { m, turns, read: sent.messageId!, wake: (req) => sched.requestActivation({ agentId: "dev", priority: 5, ...req }) };
}

const dropped = (m: TestMesh): number => (m.scheduler as unknown as { suppressedWakes(): Record<string, number> }).suppressedWakes().stale_mail ?? 0;

test("a mail wake for a message the seat has been handed is dropped, and the drop is counted", async () => {
  const { m, turns, read, wake } = await seatThatHasRead();
  try {
    await wake({ reason: { kind: "message", messageId: read, note: RETRY_NOTE } });
    await wake({ reason: { kind: "message", messageId: read } });
    await wake({ reason: { kind: "message", messageId: read, note: "3 messages arrived together, not one — the others are in your mailbox below." } });
    await quiet(m);
    assert.equal(turns.length, 1, `an empty mailbox buys no turn, whichever wake names it: ${JSON.stringify(turns)}`);
    assert.equal(dropped(m), 3, "and each drop is on the operator's counter, not silent");
  } finally {
    await m.cleanup();
  }
});

test("a wake someone asked for runs whatever the box holds", async () => {
  for (const flag of [{ explicit: true }, { operator: true, explicit: true }]) {
    const { m, turns, read, wake } = await seatThatHasRead();
    try {
      await wake({ reason: { kind: "message", messageId: read }, ...flag });
      await waitFor("the asked-for turn", () => turns.length === 2);
      assert.equal(dropped(m), 0);
    } finally {
      await m.cleanup();
    }
  }
});

test("a wake that cites no message the mesh holds, or that carries news besides the mail, runs whatever the box holds", async () => {
  const { m, turns, read, wake } = await seatThatHasRead();
  try {
    // The supervisor starting a worker on an assigned task: a `message` wake with no mail behind it.
    await wake({ reason: { kind: "message", note: "assigned worker task" } });
    await waitFor("the worker turn", () => turns.length === 2);
    // An id that resolves to nothing was never handed to anyone, so nothing shows this wake stale.
    await wake({ reason: { kind: "message", messageId: "msg-nobody-sent", note: RETRY_NOTE } });
    await waitFor("the turn for the unresolvable id", () => turns.length === 3);
    // A runtime notice merged onto a mail wake (`withNotice`): the notice is not in the mailbox.
    await wake({ reason: { kind: "message", messageId: read, note: `${RETRY_NOTE}\nyour TestReport v1 was built on CodePatch v3; it is now v4 — re-read it` } });
    await waitFor("the turn that carries the notice", () => turns.length === 4);
    await wake({ reason: { kind: "message", messageId: read, note: "your review ask was voided" } });
    await waitFor("the turn that carries the other notice", () => turns.length === 5);
    assert.equal(dropped(m), 0);
  } finally {
    await m.cleanup();
  }
});

test("a wake that names a message the seat has read still runs when the box holds other mail", async () => {
  // A retry names the head of a box, and the box moves: the head is read by one turn while another
  // message arrives. The wake is for the mail, not for the message it happens to name.
  const { m, turns, read } = await seatThatHasRead();
  try {
    const held = gate();
    stub(m).setScript("dev", async (ctx) => {
      turns.push({ kind: ctx.activation.kind, messageId: ctx.activation.messageId, unread: ctx.context.unreadMail.length });
      if (turns.length === 2) await held.wait;
      return DONE;
    });
    await m.supervisor.activateAgent("dev", { kind: "manual" });
    await waitFor("dev to be mid-turn", () => turns.length === 2 && m.supervisor.isTurnInFlight("dev"));
    const fresh = await tell(m, "the new mail");
    assert.ok("messageId" in fresh && fresh.messageId, "fixture: the new mail was accepted");
    await settle(20);
    const sched = m.scheduler as unknown as { requestActivation(req: Record<string, unknown>): Promise<boolean> };
    // Replaces the stash the send path made with one that names the message dev has already read.
    await sched.requestActivation({ agentId: "dev", priority: 5, reason: { kind: "message", messageId: read, note: RETRY_NOTE } });
    held.open();
    await quiet(m);
    assert.deepEqual(
      turns.slice(2).map((t) => [t.kind, t.unread]),
      [["message", 1]],
      `the mail that is there buys its turn, and only that: ${JSON.stringify(turns)}`,
    );
  } finally {
    await m.cleanup();
  }
});

// ------------------------------------------------------ the question is the mail, not the message

/**
 * A bare `Scheduler` with a fake runner over a parked mesh, which supplies the real config and the
 * projection the mail lives in. The integrated tests above cannot tell "any mail left" from "the
 * message the wake names is still unread": the retry that follows every turn names the head of the
 * box, so both routes end in the same turn. Here the wake is the only route.
 */
class FakeRunner implements TurnRunner {
  started: Array<{ agentId: string; reason: ActivationReason }> = [];
  constructor(private readonly drain: (agentId: string) => Promise<void>) {}
  async runTurn(agentId: string, reason: ActivationReason): Promise<void> {
    this.started.push({ agentId, reason });
    // A real turn reads its box before it ends, and `notifyTurnFinished` re-queues a seat for as long
    // as mail is left in it: a runner that never drained would be woken again, for ever.
    await this.drain(agentId);
  }
}

const ALLOW_ALL = { evaluateActivation: (): PolicyDecisionResult => ({ decision: "ALLOW", reason: "test" }) } as unknown as PolicyEvaluator;

async function bare(dev: Record<string, unknown> = {}) {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", interests: [], ...dev },
      { id: "qa", role: "qa", interests: [] },
    ],
    mayContact: { dev: [], qa: ["dev"] },
    mode: "parked",
    maxActiveAgents: 2,
  });
  const runner = new FakeRunner(async (agentId) => {
    for (const messageId of [...(m.kernel.state.unread.get(agentId) ?? [])]) {
      await m.kernel.emit("message.delivered", { agentId, messageId, turnId: "turn-fake" }, { actorId: agentId });
    }
  });
  const sched = new Scheduler(m.config, m.kernel.state, ALLOW_ALL, runner, undefined, new ManualClock(Date.now()));
  sched.start();
  const send = async (note: string): Promise<string> => {
    const sent = await m.supervisor.sendMessage({ from: "qa", to: ["dev"], type: "INFORM", newThread: { subject: note }, payload: { note } });
    assert.equal(sent.accepted, true, sent.reason);
    return sent.messageId!;
  };
  /** What a turn does to the box it was handed: the message stops being owed. */
  const deliver = async (messageId: string): Promise<void> => {
    await m.kernel.emit("message.delivered", { agentId: "dev", messageId, turnId: "turn-earlier" }, { actorId: "dev" });
  };
  return { m, sched, runner, send, deliver };
}

test("a wake that names a message the seat has read runs while the box holds other mail the seat will be woken for", async () => {
  const { m, sched, runner, send, deliver } = await bare();
  try {
    const read = await send("read already");
    await deliver(read);
    await send("still unread");
    assert.equal(m.kernel.state.unread.get("dev")?.length, 1, "fixture: one message left in the box");

    await sched.requestActivation({ agentId: "dev", priority: 5, reason: { kind: "message", messageId: read, note: RETRY_NOTE } });
    await settle();
    assert.equal(runner.started.length, 1, "the box is not empty, so the wake is not for nothing, whichever message it names");
  } finally {
    await sched.stop();
    await m.cleanup();
  }
});

test("a wake is dropped when the only mail left is mail the seat has said it does not wake for", async () => {
  // `wake.not_for` is the seat's own rationing, and the send path, the wait sweep and the retry all
  // honour it. A stale wake that counted such mail as a reason to run would hand the seat the turn
  // it had declined, on the strength of a message it had already read.
  const { m, sched, runner, send, deliver } = await bare({ wake: { notFor: ["INFORM"] } });
  try {
    const read = await send("read already");
    await deliver(read);
    await send("an FYI it batches");
    assert.equal(m.kernel.state.unread.get("dev")?.length, 1, "fixture: an FYI is waiting");

    await sched.requestActivation({ agentId: "dev", priority: 5, reason: { kind: "message", messageId: read, note: RETRY_NOTE } });
    await settle();
    assert.equal(runner.started.length, 0, "nothing in the box is a reason to run");
    assert.equal(sched.suppressedWakes().stale_mail, 1);
  } finally {
    await sched.stop();
    await m.cleanup();
  }
});
