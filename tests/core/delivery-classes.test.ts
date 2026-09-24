import { test } from "node:test";
import assert from "node:assert/strict";
import type { MeshInstance } from "../../apps/mesh-server/src/index";
import { makeMesh, stub, waitFor } from "../helpers";
import { agentKey, attentionKey } from "../../packages/core/src/budgets";
import type { MeshOp, MessageControl } from "../../packages/protocol/src/index";

/**
 * Delivery classes on the envelope (Move 2).
 *
 * Transport here is asynchronous; attention is not. Mail lands without
 * blocking the sender, but it WAKES the recipient, a wake is a turn, and a
 * turn is a model call — so the cheapest act in the mesh (writing a sentence)
 * spends the most expensive resource another seat has, and no ledger records
 * it. The class separates the two halves: every class still DELIVERS, they
 * differ only in whether delivery also buys a turn, and `interrupt` puts the
 * price on the sender's line.
 *
 * The invariant every test here is really defending: a mesh that did not ask
 * for this regime must behave exactly as it did before, byte for byte. Hence
 * the first test, which is the same send as the second with the block absent.
 */

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

const acts = (m: MeshInstance, id: string) => m.kernel.state.agents.get(id)?.state.activations ?? 0;
const classOf = (m: MeshInstance, messageId: string) => m.kernel.state.messages.get(messageId)?.control?.delivery;

/** Every seat answers `done`, so a wake is visible as an activation and nothing else happens. */
function quietRuntimes(m: MeshInstance, ids: string[]): void {
  const s = stub(m);
  for (const id of ids) s.setScript(id, async () => ({ operations: [{ op: "done" } as MeshOp] }));
}

async function interruptCharges(m: MeshInstance) {
  const events = await m.store.read();
  return events
    .filter((e) => e.type === "budget.consumed")
    .map((e) => e.payload as Record<string, unknown>)
    .filter((p) => p.reason === "interrupt");
}

test("no regime: an INFORM is unclassed and wakes its recipient, exactly as before", async () => {
  const m = await makeMesh({
    agents: [
      { id: "architect", role: "architect", interests: [] },
      { id: "dev", role: "developer", interests: [] },
    ],
    mayContact: { architect: ["dev"] },
  });
  try {
    quietRuntimes(m, ["architect", "dev"]);
    const before = acts(m, "dev");
    const sent = await m.supervisor.sendMessage({
      from: "architect",
      to: ["dev"],
      type: "INFORM",
      newThread: { subject: "fyi" },
      payload: { note: "shipping friday" },
    });
    assert.equal(sent.accepted, true, sent.reason);
    // The control case for the whole feature. This is the identical send that
    // the next test accrues; with no `bus.delivery` block the envelope carries
    // no class at all and the wake path is the one it has always taken. An
    // absent class is today's behaviour, never a cheaper default handed to a
    // mesh that upgraded into the code.
    assert.equal(classOf(m, sent.messageId!), undefined, "an unconfigured mesh must not class anything");
    await waitFor("dev woken by unclassed mail", () => acts(m, "dev") > before);
  } finally {
    await m.cleanup();
  }
});

test("accrue: chatter is delivered, never woken for, and never nudged back", async () => {
  const m = await makeMesh({
    agents: [
      { id: "architect", role: "architect", interests: [] },
      { id: "dev", role: "developer", interests: [] },
    ],
    mayContact: { architect: ["dev"] },
    // Short sweep, long window: the timer below runs ~6 times during this
    // test, so a seat that is going to be resurfaced by the nudge has every
    // chance to be.
    waitWakeupMs: 200,
    bus: { delivery: { classes: true, coalesceMs: 60_000 } },
  });
  try {
    quietRuntimes(m, ["architect", "dev"]);
    const before = acts(m, "dev");
    const sent = await m.supervisor.sendMessage({
      from: "architect",
      to: ["dev"],
      type: "INFORM",
      newThread: { subject: "fyi" },
      payload: { note: "shipping friday" },
    });
    assert.equal(sent.accepted, true, sent.reason);
    assert.equal(classOf(m, sent.messageId!), "accrue");
    // Delivered, not deferred: the reducer put it in the mailbox before the
    // scheduler ever saw the event, so the seat reads it on its next natural
    // activation. Suppressing the WAKE is the whole feature; suppressing the
    // DELIVERY would be a lost message.
    assert.ok(
      (m.kernel.state.unread.get("dev") ?? []).includes(sent.messageId!),
      "an accrued message is in the mailbox",
    );
    assert.ok(m.kernel.state.agents.get("dev")!.state.mailboxDepth >= 1);

    await new Promise((r) => setTimeout(r, 1200));
    // Two ways to fail, and the second is the subtle one: the send must not
    // wake, and the wait-timer must not undo that decision one tick later by
    // counting the same message as mail pressure — correctly not woken, then
    // woken anyway, at the same cost, with a note about closing a loop the
    // class had already judged not worth a turn.
    assert.equal(acts(m, "dev") - before, 0, "accrued mail must never buy a turn, at send or on the sweep");
    assert.ok((m.kernel.state.unread.get("dev") ?? []).includes(sent.messageId!), "and it is still there to be read");
  } finally {
    await m.cleanup();
  }
});

/**
 * The recipient's own rationing (`AgentDefinition.wake`). Every other wake
 * decision in the mesh belongs to the sender or the envelope; this is the one a
 * seat makes for itself, and it is one step MILDER than the communication
 * matrix — `may_be_contacted_by` refuses the SEND, so the message never exists,
 * while this refuses only the WAKE and leaves the mail in the box.
 *
 * The fixture deliberately has NO `bus.delivery` block: most meshes never opt
 * into the class regime, so their messages are unclassed and wake directly.
 * That is the common case, and a policy that only worked on classed traffic
 * would be a policy almost nobody could use.
 */
test("a seat that declares it batches FYIs is not woken for one, and the mail still lands", async () => {
  const m = await makeMesh({
    agents: [
      { id: "architect", role: "architect", interests: [] },
      { id: "dev", role: "developer", interests: [], wake: { deferNonObliging: true } },
    ],
    mayContact: { architect: ["dev"], dev: ["architect"] },
    // Short sweep, long wait: the timer below runs several times during this
    // test, so a seat the send path correctly did not wake has every chance to
    // be woken a tick later by the sweep that counts unread mail as pressure.
    waitWakeupMs: 200,
  });
  try {
    quietRuntimes(m, ["architect", "dev"]);
    const devBefore = acts(m, "dev");
    const archBefore = acts(m, "architect");

    const toDev = await m.supervisor.sendMessage({
      from: "architect", to: ["dev"], type: "INFORM",
      newThread: { subject: "fyi for dev" }, payload: { note: "shipping friday" },
    });
    assert.equal(toDev.accepted, true, toDev.reason);
    assert.equal(classOf(m, toDev.messageId!), undefined, "no regime: the message is unclassed, as before");

    // The control in the same fixture: a seat that declared nothing is woken
    // exactly as it was before this feature existed.
    const toArch = await m.supervisor.sendMessage({
      from: "dev", to: ["architect"], type: "INFORM",
      newThread: { subject: "fyi for architect" }, payload: { note: "done" },
    });
    assert.equal(toArch.accepted, true, toArch.reason);

    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(
      acts(m, "dev") - devBefore, 0,
      "an FYI must not buy a turn at send, nor on the sweep a tick later",
    );
    // Delivered, not suppressed: the reducer put it in the box before the
    // scheduler saw the event. Refusing the wake is the whole feature; refusing
    // the delivery would be a lost message.
    assert.ok(
      (m.kernel.state.unread.get("dev") ?? []).includes(toDev.messageId!),
      "the deferred FYI is still in the mailbox, to be read on the seat's next turn",
    );
    await waitFor("the seat that declared nothing is still woken", () => acts(m, "architect") > archBefore, 4000);
  } finally {
    await m.cleanup();
  }
});

test("obligation beats the setting: an ask still wakes a seat that batches FYIs", async () => {
  const m = await makeMesh({
    agents: [
      { id: "architect", role: "architect", interests: [] },
      { id: "dev", role: "developer", interests: [], wake: { deferNonObliging: true } },
    ],
    mayContact: { architect: ["dev"] },
    waitWakeupMs: 200,
  });
  try {
    quietRuntimes(m, ["architect", "dev"]);
    const before = acts(m, "dev");
    const ask = await m.supervisor.sendMessage({
      from: "architect", to: ["dev"], type: "REQUEST_INFO",
      newThread: { subject: "which repo ships first?" }, payload: { q: "which repo ships first?" },
    });
    assert.equal(ask.accepted, true, ask.reason);

    // This is the line that keeps the setting from being an escape hatch: the
    // predicate is the same one the debt is opened with, so a message the
    // policy defers is one that opened no `pendingRequests` entry. A mesh where
    // a seat could quietly opt out of its own debts would not be a mesh.
    assert.equal(m.kernel.state.pendingRequests.has(ask.messageId!), true, "the ask is still owed");
    await waitFor("an ask wakes even a seat that batches FYIs", () => acts(m, "dev") > before, 4000);
  } finally {
    await m.cleanup();
  }
});

test("deliver: a burst of service asks is gathered, then costs one wake", async () => {
  const m = await makeMesh({
    agents: [
      { id: "architect", role: "architect", interests: [] },
      { id: "dev", role: "developer", interests: [] },
    ],
    mayContact: { architect: ["dev"] },
    waitWakeupMs: 200,
    bus: { delivery: { classes: true, coalesceMs: 900 } },
  });
  try {
    quietRuntimes(m, ["architect", "dev"]);
    const before = acts(m, "dev");
    const ids: string[] = [];
    for (const q of ["which repo ships first?", "who owns the migration?", "is the flag on in staging?"]) {
      const sent = await m.supervisor.sendMessage({
        from: "architect",
        to: ["dev"],
        type: "REQUEST_INFO",
        newThread: { subject: q },
        payload: { q },
      });
      assert.equal(sent.accepted, true, sent.reason);
      ids.push(sent.messageId!);
    }
    for (const id of ids) assert.equal(classOf(m, id), "deliver", "an ask against no open debt is worth a turn, later");

    // Three asks, three wakes under the old rule, and at least one wait-tick
    // has passed: still zero turns. The ask is not lost — it is in the
    // mailbox, and the commitment ledger is holding its deadline.
    await new Promise((r) => setTimeout(r, 450));
    assert.equal(acts(m, "dev") - before, 0, "the gathering window must swallow the per-message wake");
    for (const id of ids) assert.equal(m.kernel.state.pendingRequests.has(id), true, "each ask is still owed");

    // And the window closes: `deliver` delays a wake, it does not cancel one.
    // (Bounded by armedAt from the FIRST message, so a steady stream cannot
    // hold it open forever.)
    await waitFor("the gathered burst releases one wake", () => acts(m, "dev") > before, 6000);
  } finally {
    await m.cleanup();
  }
});

test("interrupt: URGENT wakes now, and the sender is billed for every turn it bought", async () => {
  const m = await makeMesh({
    agents: [
      { id: "architect", role: "architect", interests: [] },
      { id: "dev", role: "developer", interests: [] },
      { id: "qa", role: "qa", interests: [] },
    ],
    mayContact: { architect: ["dev", "qa"] },
    bus: { delivery: { classes: true, interruptCostTokens: 2000 } },
  });
  try {
    quietRuntimes(m, ["architect", "dev", "qa"]);
    const before = { dev: acts(m, "dev"), qa: acts(m, "qa") };
    const sent = await m.supervisor.sendMessage({
      from: "architect",
      to: ["dev", "qa"],
      type: "INFORM",
      priority: "URGENT",
      newThread: { subject: "prod is down" },
      payload: { note: "stop what you are doing" },
    });
    assert.equal(sent.accepted, true, sent.reason);
    assert.equal(classOf(m, sent.messageId!), "interrupt");
    await waitFor("both seats woken", () => acts(m, "dev") > before.dev && acts(m, "qa") > before.qa);

    const charges = await interruptCharges(m);
    assert.equal(charges.length, 1, "one charge per send, not per recipient event");
    const charge = charges[0]!;
    const goalId = m.kernel.state.activeGoalId!;
    // Priced per seat woken: an interrupt addressed to three seats buys three
    // turns, and a flat per-message price would make the wide blast the cheap
    // one — exactly backwards.
    assert.equal(charge.amount, 4000);
    assert.deepEqual(charge.woke, ["dev", "qa"]);
    assert.equal(charge.messageId, sent.messageId);
    // On the SENDER's agent line. The mission line is the record of what the
    // mission really spent; a tariff added there would make that number a
    // fiction, and the recipients' real turns are charged where they are
    // really spent, when they run.
    assert.equal(charge.key, agentKey(goalId, "architect"));
    assert.ok(
      (m.kernel.state.budgets.get(agentKey(goalId, "architect"))?.consumed ?? 0) >= 4000,
      "the charge lands in the ledger, not just the event log",
    );
  } finally {
    await m.cleanup();
  }
});

test("the operator is never billed, and a cheap class is never billed", async () => {
  const m = await makeMesh({
    agents: [
      { id: "architect", role: "architect", interests: [] },
      { id: "dev", role: "developer", interests: [] },
    ],
    mayContact: { architect: ["dev"] },
    mode: "parked",
    bus: { delivery: { classes: true, interruptCostTokens: 2000 } },
  });
  try {
    // An operator's interrupt is the operator's prerogative, and there is no
    // agent line for it to land on.
    const human = await m.supervisor.sendMessage({
      from: "human",
      to: ["dev"],
      type: "INFORM",
      priority: "URGENT",
      newThread: { subject: "operator" },
      payload: { note: "drop everything" },
    });
    assert.equal(human.accepted, true, human.reason);
    assert.equal(classOf(m, human.messageId!), "interrupt");

    const chatter = await m.supervisor.sendMessage({
      from: "architect",
      to: ["dev"],
      type: "INFORM",
      newThread: { subject: "fyi" },
      payload: { note: "no rush" },
    });
    assert.equal(classOf(m, chatter.messageId!), "accrue");

    assert.deepEqual(await interruptCharges(m), [], "only a seat's own interrupt is priced");
  } finally {
    await m.cleanup();
  }
});

test("a chase is an interrupt, a new question is not, and the answer always is", async () => {
  const m = await makeMesh({
    agents: [
      { id: "architect", role: "architect", interests: [] },
      { id: "dev", role: "developer", interests: [] },
    ],
    mayContact: { architect: ["dev"], dev: ["architect"] },
    mode: "parked",
    bus: { delivery: { classes: true } },
  });
  try {
    const ask = await m.supervisor.sendMessage({
      from: "architect",
      to: ["dev"],
      type: "REQUEST_INFO",
      newThread: { subject: "status" },
      payload: { q: "status?" },
    });
    assert.equal(ask.accepted, true, ask.reason);
    assert.equal(classOf(m, ask.messageId!), "deliver", "a first ask is worth a turn, but not this instant");
    const threadId = m.kernel.state.messages.get(ask.messageId!)!.threadId;

    // Asked again, in the thread of the ask that is still unanswered. A chase
    // is worth a turn AND worth a bill: the pairing is what makes it a
    // decision instead of a reflex.
    const chase = await m.supervisor.sendMessage({
      from: "architect",
      to: ["dev"],
      threadId,
      type: "REQUEST_INFO",
      payload: { q: "still waiting on this" },
    });
    assert.equal(classOf(m, chase.messageId!), "interrupt");

    // A DIFFERENT question, while that debt is still open, is not a chase.
    // Without the thread test, "this seat owes me something, anything" would
    // make every later ask to a busy colleague an interrupt — the expensive
    // class as the default, which is the inversion this move exists to close.
    const other = await m.supervisor.sendMessage({
      from: "architect",
      to: ["dev"],
      type: "REQUEST_REVIEW",
      newThread: { subject: "unrelated" },
      payload: { q: "and could you look at this too?" },
    });
    assert.equal(classOf(m, other.messageId!), "deliver");

    const answer = await m.supervisor.sendMessage({
      from: "dev",
      to: ["architect"],
      type: "INFORM",
      replyTo: ask.messageId,
      payload: { a: "green" },
    });
    assert.equal(answer.accepted, true, answer.reason);
    // The one wake that is unarguably worth its turn: the creditor cannot
    // proceed until this lands, so holding it in a gathering window would make
    // the cheap class the expensive one — a seat blocked for a minute on an
    // answer that was already written.
    assert.equal(classOf(m, answer.messageId!), "interrupt");
  } finally {
    await m.cleanup();
  }
});

test("a broadcast keeps its own gate: the regime does not class it", async () => {
  const m = await makeMesh({
    agents: [
      { id: "architect", role: "architect", interests: [] },
      { id: "watcher", role: "qa", interests: ["message.*"] },
    ],
    mayContact: { architect: ["watcher"] },
    mode: "parked",
    bus: { delivery: { classes: true } },
  });
  try {
    const bc = await m.supervisor.executeOp(
      "architect",
      { op: "broadcast", type: "INFORM", payload: { note: "kickoff" } } as MeshOp,
      fakeTurn("architect"),
    );
    assert.equal(bc.ok, true, bc.reason);
    assert.equal(m.kernel.state.messages.get(bc.messageId!)!.control?.mode, "broadcast");
    // `mode` chooses WHO is a candidate for a wake; `delivery` decides whether
    // being a candidate is worth a turn. Stamping `accrue` here would look
    // harmless and would silently overrule the one thing an operator wrote by
    // hand: the `interests:` list that says this seat wants to hear about mail.
    assert.equal(
      classOf(m, bc.messageId!),
      undefined,
      "a class derived from an envelope must not overrule a decision taken in config",
    );
  } finally {
    await m.cleanup();
  }
});

test("a seat cannot class its own message, in control or in payload", async () => {
  const m = await makeMesh({
    agents: [
      { id: "architect", role: "architect", interests: [] },
      { id: "dev", role: "developer", interests: [] },
    ],
    mayContact: { architect: ["dev"] },
    mode: "parked",
    bus: { delivery: { classes: true, interruptCostTokens: 2000 } },
  });
  try {
    // A forged envelope arriving at the one door every send goes through.
    // If this were honoured, the sender would have priced its own interrupt
    // at zero: the recipients still wake (URGENT), and nobody is billed.
    const forged = await m.supervisor.sendMessage({
      from: "architect",
      to: ["dev"],
      type: "INFORM",
      priority: "URGENT",
      newThread: { subject: "prod is down" },
      payload: { note: "now" },
      control: { delivery: "accrue" } as MessageControl,
      // `control` is a SEPARATE second argument to `sendMessage`, precisely so
      // that no forged value can ride in the object the sanitiser screens. The
      // signature therefore already rejects this line -- which is the forgery
      // under test, so it is cast in as if a caller had smuggled it past.
    } as unknown as Parameters<typeof m.supervisor.sendMessage>[0]);
    assert.equal(forged.accepted, true, forged.reason);
    assert.equal(classOf(m, forged.messageId!), "interrupt", "the runtime classes it, not the sender");
    assert.equal((await interruptCharges(m)).length, 1, "and the bill is raised anyway");

    // The payload copy: nothing reads it today, but a seat that could leave
    // one there has written a forged class waiting for a future reader.
    const op = await m.supervisor.executeOp(
      "architect",
      {
        op: "send",
        type: "INFORM",
        to: ["dev"],
        priority: "URGENT",
        newThread: { subject: "again" },
        payload: { delivery: "accrue", note: "now" },
      } as MeshOp,
      fakeTurn("architect"),
    );
    assert.equal(op.ok, true, op.reason);
    const msg = m.kernel.state.messages.get(op.messageId!)!;
    assert.equal(msg.control?.delivery, "interrupt");
    assert.equal("delivery" in (msg.payload as Record<string, unknown>), false, "the payload copy is stripped");
  } finally {
    await m.cleanup();
  }
});

test("an interrupt the sender cannot afford ships as mail, uncharged, and says so", async () => {
  const m = await makeMesh({
    agents: [
      { id: "architect", role: "architect", interests: [] },
      { id: "dev", role: "developer", interests: [] },
    ],
    mayContact: { architect: ["dev"] },
    // `attention_tokens: 0` is the sharpest form of the question. The class is
    // still computed, the tariff is still 2000, and the sender may never buy a
    // turn with either of them. Nothing else about the mesh changes.
    bus: { delivery: { classes: true, interruptCostTokens: 2000, attentionTokens: 0 } },
  });
  try {
    quietRuntimes(m, ["architect", "dev"]);
    const before = acts(m, "dev");
    const sent = await m.supervisor.sendMessage({
      from: "architect",
      to: ["dev"],
      type: "INFORM",
      priority: "URGENT",
      newThread: { subject: "prod is down" },
      payload: { note: "stop what you are doing" },
    });

    // The send SUCCEEDED, and that is the design rather than a lenient edge.
    // Nothing in this mesh suppresses a delivery: an unaffordable interrupt is
    // a message whose CLASS changed, never a message that failed.
    assert.equal(sent.accepted, true, sent.reason);
    assert.equal(typeof sent.deliveryDowngraded, "string", "the sender must be told, or it will simply resend");
    assert.match(sent.deliveryDowngraded!, /0\/0/, "the refusal quotes what was spent against the cap");

    // Downgraded to `deliver`, NOT to `accrue`. The sender asked for a wake and
    // the mail is genuinely urgent-ish; `accrue` never wakes at all, so
    // downgrading there would quietly turn "cannot pay for this now" into
    // "never", which is a lost ask wearing the costume of a cheap one.
    assert.equal(classOf(m, sent.messageId!), "deliver");
    assert.ok(
      (m.kernel.state.unread.get("dev") ?? []).includes(sent.messageId!),
      "delivered, in the mailbox, waiting for a turn",
    );
    // The reason rides the envelope too, so a reader that never saw the
    // SendResult -- a replay, the dashboard, the recipient -- can still tell
    // this apart from a message that was only ever worth coalescing.
    assert.ok(m.kernel.state.messages.get(sent.messageId!)!.control?.downgraded);

    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(await interruptCharges(m), [], "a tariff that collects on a wake it refused is a receipt for nothing");
    assert.equal(acts(m, "dev") - before, 0, "and no turn was bought: the coalesce window is still open");
    assert.equal(m.kernel.state.comms.downgradedInterrupts.get("architect"), 1, "the refusal is counted where the report can find it");
  } finally {
    await m.cleanup();
  }
});

test("attention is its own ledger line: what a seat may spend talking is not what it may spend working", async () => {
  const m = await makeMesh({
    agents: [
      { id: "architect", role: "architect", interests: [] },
      { id: "dev", role: "developer", interests: [] },
    ],
    mayContact: { architect: ["dev"] },
    bus: { delivery: { classes: true, interruptCostTokens: 2000, attentionTokens: 100_000 } },
  });
  try {
    quietRuntimes(m, ["architect", "dev"]);
    const goalId = m.kernel.state.activeGoalId!;
    const line = m.kernel.state.budgets.get(attentionKey(goalId, "architect"));
    assert.equal(line?.limit, 100_000, "the cap is declared at boot, not discovered on the first spend");
    assert.equal(line?.consumed, 0);

    const sent = await m.supervisor.sendMessage({
      from: "architect",
      to: ["dev"],
      type: "INFORM",
      priority: "URGENT",
      newThread: { subject: "prod is down" },
      payload: { note: "stop what you are doing" },
    });
    assert.equal(sent.deliveryDowngraded, undefined, "an affordable interrupt is not refused");

    const charges = await interruptCharges(m);
    assert.equal(charges.length, 1);
    // The move, in one assertion. Before the attention line existed the tariff
    // landed on the sender's own `agent:` line, so an interrupt-happy seat
    // exhausted the budget it needed to THINK and stopped being able to work
    // -- the degradation landed on the seat doing the talking, and on the
    // wrong resource. The mission line stays clean for the same reason it
    // always did: the recipients' real turns are charged where they are
    // really spent, when they run.
    assert.equal(charges[0]!.key, attentionKey(goalId, "architect"));
    assert.equal(m.kernel.state.budgets.get(attentionKey(goalId, "architect"))!.consumed, 2000);
    assert.ok(
      !charges.some((c) => c.key === agentKey(goalId, "architect")),
      "the seat's ability to work is untouched by what it spends interrupting",
    );
  } finally {
    await m.cleanup();
  }
});

test("the mesh counts the wakes it bought, and who bought them", async () => {
  const m = await makeMesh({
    agents: [
      { id: "architect", role: "architect", interests: [] },
      { id: "dev", role: "developer", interests: [] },
    ],
    mayContact: { architect: ["dev"] },
    bus: { delivery: { classes: true, interruptCostTokens: 2000, attentionTokens: 100_000 } },
  });
  try {
    quietRuntimes(m, ["architect", "dev"]);
    await m.supervisor.sendMessage({
      from: "architect",
      to: ["dev"],
      type: "INFORM",
      newThread: { subject: "fyi" },
      payload: { note: "no rush" },
    });
    await m.supervisor.sendMessage({
      from: "architect",
      to: ["dev"],
      type: "INFORM",
      priority: "URGENT",
      newThread: { subject: "prod is down" },
      payload: { note: "now" },
    });

    // The wake is asynchronous with respect to the send, so wait for it: the
    // counters are bumped by the reducer on `agent.awakened`, which is a later
    // event than the `message.sent` that caused it.
    await waitFor("the interrupt's wake lands", () => (m.kernel.state.comms.wakesByKind.get("message") ?? 0) >= 1);

    const { comms } = m.kernel.state;
    // The counter the whole delivery-class move is judged by. `volume` cannot
    // answer it: a mesh that halved its wakes by moving chatter from
    // `interrupt` to `accrue` sends exactly the same number of messages.
    assert.equal(comms.sendsByClass.get("accrue"), 1);
    assert.equal(comms.sendsByClass.get("interrupt"), 1);
    assert.equal(comms.sendsByClass.get("unclassed"), undefined, "a classed mesh classes every send");
    assert.equal(comms.interruptsBySender.get("architect"), 1);
    assert.equal(comms.downgradedInterrupts.get("architect"), undefined, "nothing was refused here");
    // Exactly one: the accrued send bought no turn, and the wait-timer does
    // not manufacture one out of unread mail -- the same suppression the
    // `accrue` test above proves from the other side.
    assert.equal(
      comms.wakesByKind.get("message"),
      1,
      "the one wake was the interrupt, and it is attributed to mail rather than to the mesh's own machinery",
    );
  } finally {
    await m.cleanup();
  }
});
