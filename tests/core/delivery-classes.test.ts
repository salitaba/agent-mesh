import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { bootstrapMesh, type MeshInstance } from "../../apps/mesh-server/src/index";
import { testConfigYaml, stub, waitFor, type TestMeshOptions } from "../helpers";
import { agentKey } from "../../packages/core/src/budgets";
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

interface DeliveryMeshOptions extends TestMeshOptions {
  delivery?: { classes?: boolean; coalesceMs?: number; interruptCostTokens?: number };
}

/**
 * `bus.delivery` written into the generated fixture config.
 *
 * Injected here rather than added to `TestMeshOptions` because the shared
 * fixture builder is used by every suite in the repo, and a block that only
 * these tests set does not need to widen it. Written as YAML for the same
 * reason the rest of the fixture is: the point is to prove the resolver reads
 * the file operators actually write.
 */
function withDelivery(yaml: string, d: DeliveryMeshOptions["delivery"]): string {
  if (!d) return yaml;
  const parts = [`classes: ${d.classes ?? true}`];
  if (d.coalesceMs !== undefined) parts.push(`coalesce_ms: ${d.coalesceMs}`);
  if (d.interruptCostTokens !== undefined) parts.push(`interrupt_cost_tokens: ${d.interruptCostTokens}`);
  const line = `  delivery: { ${parts.join(", ")} }\n`;
  return yaml.includes("\nbus:\n")
    ? yaml.replace("\nbus:\n", `\nbus:\n${line}`)
    : yaml.replace("\nscheduling:\n", `\nbus:\n${line}\nscheduling:\n`);
}

async function makeDeliveryMesh(opts: DeliveryMeshOptions): Promise<MeshInstance & { cleanup(): Promise<void> }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-delivery-"));
  const configPath = path.join(dir, "mesh.yaml");
  fs.writeFileSync(configPath, withDelivery(testConfigYaml(opts), opts.delivery), "utf8");
  const mode = opts.mode ?? "live";
  const instance = await bootstrapMesh({ configPath, inMemory: true, mode, uiOnly: mode === "parked" });
  return Object.assign(instance, {
    async cleanup() {
      await instance.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  });
}

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
  const m = await makeDeliveryMesh({
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
  const m = await makeDeliveryMesh({
    agents: [
      { id: "architect", role: "architect", interests: [] },
      { id: "dev", role: "developer", interests: [] },
    ],
    mayContact: { architect: ["dev"] },
    // Short sweep, long window: the timer below runs ~6 times during this
    // test, so a seat that is going to be resurfaced by the nudge has every
    // chance to be.
    waitWakeupMs: 200,
    delivery: { classes: true, coalesceMs: 60_000 },
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

test("deliver: a burst of service asks is gathered, then costs one wake", async () => {
  const m = await makeDeliveryMesh({
    agents: [
      { id: "architect", role: "architect", interests: [] },
      { id: "dev", role: "developer", interests: [] },
    ],
    mayContact: { architect: ["dev"] },
    waitWakeupMs: 200,
    delivery: { classes: true, coalesceMs: 900 },
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
  const m = await makeDeliveryMesh({
    agents: [
      { id: "architect", role: "architect", interests: [] },
      { id: "dev", role: "developer", interests: [] },
      { id: "qa", role: "qa", interests: [] },
    ],
    mayContact: { architect: ["dev", "qa"] },
    delivery: { classes: true, interruptCostTokens: 2000 },
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
  const m = await makeDeliveryMesh({
    agents: [
      { id: "architect", role: "architect", interests: [] },
      { id: "dev", role: "developer", interests: [] },
    ],
    mayContact: { architect: ["dev"] },
    mode: "parked",
    delivery: { classes: true, interruptCostTokens: 2000 },
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
  const m = await makeDeliveryMesh({
    agents: [
      { id: "architect", role: "architect", interests: [] },
      { id: "dev", role: "developer", interests: [] },
    ],
    mayContact: { architect: ["dev"], dev: ["architect"] },
    mode: "parked",
    delivery: { classes: true },
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
  const m = await makeDeliveryMesh({
    agents: [
      { id: "architect", role: "architect", interests: [] },
      { id: "watcher", role: "qa", interests: ["message.*"] },
    ],
    mayContact: { architect: ["watcher"] },
    mode: "parked",
    delivery: { classes: true },
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
  const m = await makeDeliveryMesh({
    agents: [
      { id: "architect", role: "architect", interests: [] },
      { id: "dev", role: "developer", interests: [] },
    ],
    mayContact: { architect: ["dev"] },
    mode: "parked",
    delivery: { classes: true, interruptCostTokens: 2000 },
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
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
