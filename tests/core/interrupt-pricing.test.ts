import { test } from "node:test";
import assert from "node:assert/strict";
import type { MeshInstance } from "../../apps/mesh-server/src/index";
import { makeMesh, stub } from "../helpers";
import { buildAgentContext, renderContextInstructions } from "../../packages/core/src/context";
import { MAX_INTERRUPT_SURCHARGE, agentKey, attentionKey, interruptSurcharge } from "../../packages/core/src/budgets";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * What an interrupt costs, once the flat tariff stops being the whole answer.
 *
 * The flat price asks the wrong question. It charges the same 2000 tokens to
 * wake a seat with an empty box and a seat with nineteen unread messages, and
 * those two wakes are not the same purchase: the first buys a turn that starts
 * on the sender's problem, the second buys a turn that starts by reading
 * nineteen other people's. Congestion pricing prices the queue the sender is
 * joining. The per-turn digest fixes the opposite error: three interrupts to
 * one seat in one burst were billed three times and bought ONE turn, because
 * the scheduler will not enqueue a second turn for a seat already queued.
 *
 * Both are off unless a mesh writes `congestion_every`; the digest is not
 * configurable because billing for a turn nobody gets was never a policy.
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

async function interruptCharges(m: MeshInstance) {
  const events = await m.store.read();
  return events
    .filter((e) => e.type === "budget.consumed")
    .map((e) => e.payload as Record<string, unknown>)
    .filter((p) => p.reason === "interrupt");
}

/** Mail that lands without waking anybody, so a box can be filled on purpose. */
async function fill(m: MeshInstance, from: string, to: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const res = await m.supervisor.sendMessage({
      from,
      to: [to],
      type: "INFORM",
      newThread: { subject: `backlog ${i}` },
      payload: { note: `item ${i}` },
    });
    assert.equal(res.accepted, true, res.reason);
  }
  assert.equal((m.kernel.state.unread.get(to) ?? []).length, n, "the fixture must actually back the box up");
}

function urgent(m: MeshInstance, from: string, to: string[]) {
  return m.supervisor.sendMessage({
    from,
    to,
    type: "INFORM",
    priority: "URGENT",
    newThread: { subject: "prod is down" },
    payload: { note: "stop what you are doing" },
  });
}

function pricedMesh(over: Record<string, unknown>) {
  return makeMesh({
    agents: [
      { id: "architect", role: "architect", interests: [] },
      { id: "dev", role: "developer", interests: [] },
      { id: "qa", role: "qa", interests: [] },
    ],
    mayContact: { architect: ["dev", "qa"], dev: ["architect", "qa"], qa: ["architect", "dev"] },
    // Parked: mail lands, nobody wakes, so a mailbox depth stays where the
    // fixture put it instead of draining underneath the assertion.
    mode: "parked",
    ...over,
  } as never);
}

// --- the curve, on its own --------------------------------------------------

test("surcharge: absent or incoherent `congestion_every` is the flat tariff at every depth", () => {
  for (const depth of [0, 1, 7, 200, 10_000]) {
    assert.equal(interruptSurcharge(depth, undefined), 1, `depth ${depth} must be 1x without the key`);
    assert.equal(interruptSurcharge(depth, 0), 1, "a divisor of 0 is not a steeper curve, it is a division by zero");
    assert.equal(interruptSurcharge(depth, -3), 1);
  }
});

test("surcharge: one step per `every` unread, starting from the first full step", () => {
  // The first message in a box is not a surcharge. Someone has to be first,
  // and charging for it would price every wake above the flat tariff, which
  // is a rename rather than a signal.
  assert.equal(interruptSurcharge(0, 4), 1);
  assert.equal(interruptSurcharge(3, 4), 1);
  assert.equal(interruptSurcharge(4, 4), 2);
  assert.equal(interruptSurcharge(7, 4), 2);
  assert.equal(interruptSurcharge(8, 4), 3);
  assert.equal(interruptSurcharge(12, 4), 4);
  assert.equal(interruptSurcharge(1, 1), 2, "every: 1 is legal and means every message is a step");
});

test("surcharge: the curve is capped, because a sender cannot see inside the box it is paying for", () => {
  // MAX_UNREAD_PER_AGENT is 200, so an uncapped curve at `every: 1` would reach
  // 200x — a price no sender can predict, from a queue no sender can read. A
  // price nobody can predict is not a price, it is a penalty.
  assert.equal(interruptSurcharge(200, 1), MAX_INTERRUPT_SURCHARGE);
  assert.equal(interruptSurcharge(10_000, 4), MAX_INTERRUPT_SURCHARGE);
  assert.equal(interruptSurcharge(MAX_INTERRUPT_SURCHARGE * 4, 4), MAX_INTERRUPT_SURCHARGE);
  assert.ok(MAX_INTERRUPT_SURCHARGE >= 2, "a cap of 1 would delete the feature");
});

// --- the curve, on the wire -------------------------------------------------

test("congestion: without the key, a backed-up seat costs exactly what an idle one costs", async () => {
  const m = await pricedMesh({ bus: { delivery: { classes: true, interruptCostTokens: 2000 } } });
  try {
    await fill(m, "qa", "dev", 12);
    const sent = await urgent(m, "architect", ["dev"]);
    assert.equal(sent.accepted, true, sent.reason);
    const charges = await interruptCharges(m);
    assert.equal(charges.length, 1);
    assert.equal(charges[0]!.amount, 2000, "the flat tariff is what every existing mesh has, and it must not move");
    assert.deepEqual(charges[0]!.priced, ["dev"], "no surcharge, so nothing to explain");
  } finally {
    await m.cleanup();
  }
});

test("congestion: waking a backed-up seat costs a multiple, and the receipt says which seat and why", async () => {
  const m = await pricedMesh({ bus: { delivery: { classes: true, interruptCostTokens: 2000, congestionEvery: 4 } } });
  try {
    // 9 unread => floor(9/4) = 2 steps => 3x. qa stays empty at 1x, so one
    // send prices two seats differently and the per-recipient split is visible.
    await fill(m, "qa", "dev", 9);
    const sent = await urgent(m, "architect", ["dev", "qa"]);
    assert.equal(sent.accepted, true, sent.reason);

    const charges = await interruptCharges(m);
    assert.equal(charges.length, 1, "one charge per send, whatever the spread of prices inside it");
    const charge = charges[0]!;
    assert.equal(charge.amount, 2000 * 3 + 2000 * 1, "dev at 3x plus qa at 1x");
    assert.equal(charge.unitTokens, 2000, "the flat tariff stays on the receipt, or the multiple cannot be read back");
    assert.deepEqual(charge.woke, ["dev", "qa"]);
    assert.deepEqual(
      charge.priced,
      ["dev (9 unread, x3)", "qa"],
      "the receipt must name the congested seat: it is the only thing the sender can act on",
    );
  } finally {
    await m.cleanup();
  }
});

test("congestion: the quote and the bill agree, because neither prices the message being sent", async () => {
  // The bug this guards: the pre-flight quote runs BEFORE the reducer files
  // the message, the charge runs after. Counting the box naively, the two
  // differ by one — and at a tier boundary that is a sender quoted one price
  // and billed another, for a surcharge its own message caused.
  const m = await pricedMesh({
    // Depth 3 pre-send, 4 post-send. `every: 4` puts the boundary exactly
    // between them, so a naive count bills 2x against a 1x quote.
    bus: { delivery: { classes: true, interruptCostTokens: 2000, congestionEvery: 4, attentionTokens: 2000 } },
  });
  try {
    await fill(m, "qa", "dev", 3);
    const sent = await urgent(m, "architect", ["dev"]);
    assert.equal(sent.accepted, true, sent.reason);
    assert.equal(sent.deliveryDowngraded, undefined, "2000 of headroom must buy a 1x wake");
    const charges = await interruptCharges(m);
    assert.equal(charges.length, 1);
    assert.equal(charges[0]!.amount, 2000, "billed at the tier it was quoted at");
  } finally {
    await m.cleanup();
  }
});

test("congestion: an unaffordable wake names the congested seat rather than counting seats", async () => {
  const m = await pricedMesh({
    bus: { delivery: { classes: true, interruptCostTokens: 2000, congestionEvery: 4, attentionTokens: 3000 } },
  });
  try {
    await fill(m, "qa", "dev", 8);
    const sent = await urgent(m, "architect", ["dev"]);
    assert.equal(sent.accepted, true, "an unaffordable interrupt is a message whose CLASS changed, never a lost message");
    const why = sent.deliveryDowngraded;
    assert.equal(typeof why, "string", "the sender must be told, or it will simply resend");
    assert.match(why!, /6000 tokens needed to wake dev \(8 unread, x3\)/, why);
    assert.match(why!, /0\/3000/, "and the refusal still quotes the line it was refused against");
    assert.deepEqual(await interruptCharges(m), [], "a refused wake is not billed");
  } finally {
    await m.cleanup();
  }
});

// --- the per-turn digest ----------------------------------------------------

test("digest: a second interrupt to the same seat in one turn is free, because it buys nothing", async () => {
  // The scheduler refuses to enqueue a second turn for a seat already queued,
  // so three URGENT messages to one colleague bought one turn and were billed
  // three times. Charging for a turn nobody gets is not a price signal.
  const m = await pricedMesh({ bus: { delivery: { classes: true, interruptCostTokens: 2000 } } });
  try {
    const first = await urgent(m, "architect", ["dev"]);
    const second = await urgent(m, "architect", ["dev"]);
    const third = await urgent(m, "architect", ["dev", "qa"]);
    for (const r of [first, second, third]) assert.equal(r.accepted, true, r.reason);

    const charges = await interruptCharges(m);
    assert.equal(charges.length, 2, "the second send to dev raises no bill at all, not a zero one");
    assert.equal(charges[0]!.amount, 2000, "dev, once");
    assert.deepEqual(charges[0]!.woke, ["dev"]);
    // The third send reaches a seat the sender has NOT woken this turn, so it
    // is billed for qa alone: the digest is per recipient, not per message.
    assert.equal(charges[1]!.amount, 2000, "qa, once; dev is already coming");
    assert.deepEqual(charges[1]!.woke, ["dev", "qa"], "`woke` still records who the message reached");
    assert.deepEqual(charges[1]!.priced, ["qa"], "and `priced` records who it actually bought");
  } finally {
    await m.cleanup();
  }
});

test("digest: it is per sender — two seats waking one colleague both pay", async () => {
  // A digest keyed on the RECIPIENT would let the second sender ride the
  // first's wake for free, which prices a public good and rewards piling on.
  const m = await pricedMesh({ bus: { delivery: { classes: true, interruptCostTokens: 2000 } } });
  try {
    await urgent(m, "architect", ["dev"]);
    await urgent(m, "qa", "dev".split(","));
    const charges = await interruptCharges(m);
    assert.equal(charges.length, 2);
    const goalId = m.kernel.state.activeGoalId!;
    assert.deepEqual(
      charges.map((c) => c.key).sort(),
      [agentKey(goalId, "architect"), agentKey(goalId, "qa")].sort(),
      "each sender pays on its own line",
    );
  } finally {
    await m.cleanup();
  }
});

test("digest: a new turn is a new burst, so waking the same seat again is billed again", async () => {
  const m = await pricedMesh({ bus: { delivery: { classes: true, interruptCostTokens: 2000, attentionTokens: 100_000 } } });
  try {
    stub(m).setScript("architect", async () => ({ operations: [{ op: "done" } as MeshOp] }));
    await urgent(m, "architect", ["dev"]);
    await urgent(m, "architect", ["dev"]);
    assert.equal((await interruptCharges(m)).length, 1, "one burst, one bill");

    // Whoever this seat woke last turn has long since taken that turn, so the
    // next wake is a real purchase again.
    await m.supervisor.runTurn("architect", { kind: "manual" });
    await urgent(m, "architect", ["dev"]);

    const charges = await interruptCharges(m);
    assert.equal(charges.length, 2, "the ledger must reset with the turn, or a chatty seat interrupts free forever");
    const goalId = m.kernel.state.activeGoalId!;
    assert.equal(charges[1]!.key, attentionKey(goalId, "architect"), "still on the attention line the mesh declared");
  } finally {
    await m.cleanup();
  }
});

test("digest: a free repeat is not refused, even on an exhausted attention line", async () => {
  // The refusal has to agree with the bill. If the pre-flight check priced the
  // repeat at full tariff it would downgrade a wake that costs nothing, and
  // the sender would be told it cannot afford something it is not buying.
  const m = await pricedMesh({
    bus: { delivery: { classes: true, interruptCostTokens: 2000, attentionTokens: 2000 } },
  });
  try {
    const first = await urgent(m, "architect", ["dev"]);
    assert.equal(first.deliveryDowngraded, undefined, "the line covers exactly one wake");
    const repeat = await urgent(m, "architect", ["dev"]);
    assert.equal(repeat.deliveryDowngraded, undefined, "and the repeat costs nothing, so there is nothing to refuse");

    // A DIFFERENT seat is a real purchase, and the exhausted line does refuse it.
    const other = await urgent(m, "architect", ["qa"]);
    assert.equal(typeof other.deliveryDowngraded, "string", "the cap is still a cap for wakes that are not free");
  } finally {
    await m.cleanup();
  }
});

test("congestion: the seat is told the rule, the divisor and the cap it is being priced under", async () => {
  // A price the sender cannot compute before sending is not a price. The
  // divisor differs from the cap here on purpose: with both at 4 the prompt
  // could quote one number and satisfy an assertion about the other.
  const m = await pricedMesh({ bus: { delivery: { classes: true, interruptCostTokens: 2000, congestionEvery: 3 } } });
  try {
    const res = await m.supervisor.executeOp("architect", { op: "done" } as MeshOp, fakeTurn("architect"));
    assert.equal(res.ok, true);
    const text = renderContextInstructions(buildAgentContext({ config: m.config, kernel: m.kernel }, "architect"));
    const section = text.slice(text.indexOf("## What interrupting someone costs you"));
    assert.match(section, /Every 3 messages already unread/, "the divisor, or the surcharge cannot be anticipated");
    assert.match(section, new RegExp(`up to ${MAX_INTERRUPT_SURCHARGE}x`), "the cap, or the worst case is unbounded to the reader");
    assert.match(section, /ordinary mail/, "and the cheap alternative, or the rule is a tax rather than a signal");
    assert.match(section, /already coming/, "the digest is a rule the sender can use, so it must be told");
  } finally {
    await m.cleanup();
  }
});

test("congestion: a mesh without the key is told nothing about a surcharge it does not have", async () => {
  const m = await pricedMesh({ bus: { delivery: { classes: true, interruptCostTokens: 2000 } } });
  try {
    const text = renderContextInstructions(buildAgentContext({ config: m.config, kernel: m.kernel }, "architect"));
    const section = text.slice(text.indexOf("## What interrupting someone costs you"));
    assert.doesNotMatch(section, /already unread/, "a rule the mesh does not enforce is a lie in the prompt");
    assert.match(section, /2000 tokens for every recipient woken/, "the flat tariff is still taught");
  } finally {
    await m.cleanup();
  }
});
