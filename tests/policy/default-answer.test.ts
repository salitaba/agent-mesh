import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor } from "../helpers";
import { buildAgentContext, renderContextInstructions } from "../../packages/core/src/context";
import { createInitialState, PER_DEBTOR_DISCHARGE_REASONS, UNANSWERED_DISCHARGE_REASONS } from "../../packages/core/src/state";
import { applyEvent } from "../../packages/core/src/projections";
import type { ActivationReason, MeshOp } from "../../packages/protocol/src/index";

/**
 * `ifUnanswered` — an ask that carries its own answer.
 *
 * The whole point of the key is a NEGATIVE: an ask that declares in advance
 * what silence will be taken to mean costs nobody a turn to leave unanswered.
 * So most of what is asserted here is something NOT happening — no nudge, no
 * stalemate escalation, no operator card — and a test for an absence has to be
 * written so that it would notice the absence going away. Every "nothing
 * happened" assertion below therefore pins a COUNT taken after the mesh has
 * settled and re-checks it after the relevant timer has had several windows to
 * fire, rather than sampling once and calling the silence proof.
 */

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

const sweep = (m: Mesh) =>
  (m.supervisor as unknown as { sweepExpiredCommitments(nowMs: number): Promise<void> }).sweepExpiredCommitments(Date.now());

const internals = (m: Mesh): { checkStall(): Promise<void>; lastTurnAt: number } =>
  m.supervisor as unknown as { checkStall(): Promise<void>; lastTurnAt: number };

function fakeTurn(agentId: string) {
  return {
    turnId: `t-${agentId}`,
    agentId,
    reason: { kind: "manual" },
    sentOps: 0,
    publishedOps: 0,
    waitRequested: false,
    escalated: false,
    results: [],
  } as never;
}

function twoAgents() {
  return [
    { id: "architect", role: "architect", capabilities: ["review.design"], interests: [] },
    { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
  ];
}

/** A parked pair, so the sweep can be driven directly without the stall gates. */
async function pair(opts: { ttlMs?: number } = {}) {
  return makeMesh({
    agents: twoAgents(),
    mayContact: { architect: ["dev"], dev: ["architect"] },
    mode: "parked",
    ...(opts.ttlMs !== undefined ? { bus: { commitments: { ttlMs: opts.ttlMs } } } : {}),
  });
}

/** Architect asks dev, declaring what it will do if dev says nothing. */
async function askWithDefault(m: Mesh, ifUnanswered: unknown) {
  const res = await m.supervisor.executeOp(
    "architect",
    {
      op: "send",
      type: "REQUEST_INFO",
      to: ["dev"],
      newThread: { subject: "which store?" },
      payload: { question: "postgres or sqlite for the index?" },
      ifUnanswered,
    } as unknown as MeshOp,
    fakeTurn("architect"),
  );
  return res;
}

const recordFor = (m: Mesh, messageId: string) => m.kernel.state.discharged.find((d) => d.messageId === messageId);

function replayed(m: Mesh, events: Awaited<ReturnType<typeof m.store.read>>) {
  const fresh = createInitialState();
  for (const e of events) {
    applyEvent(fresh, e, {
      transitionGates: m.config.transitionGates,
      commitmentSemantic: m.config.bus.commitmentSemantic,
      commitmentTtl: m.config.bus.commitmentTtl,
    });
  }
  return fresh;
}

test("a default answer discharges the ask as `defaulted`, carrying the value the asker named", async () => {
  const m = await pair({ ttlMs: 50 });
  try {
    const res = await askWithDefault(m, { assume: "postgres" });
    assert.equal(res.ok, true, res.reason);
    const id = res.messageId!;

    const pending = m.kernel.state.pendingRequests.get(id);
    assert.deepEqual(pending?.ifUnanswered, { assume: "postgres" }, "the ledger must remember what silence was priced at");
    assert.ok(pending?.dueBy, "a default without a deadline would never fire");

    await waitFor("the deadline passed", () => Date.now() > Date.parse(pending!.dueBy!));
    await sweep(m);

    const rec = recordFor(m, id);
    assert.equal(rec?.reason, "defaulted", "silence the asker priced is not the same ending as silence it did not");
    assert.equal(rec?.by, "system");

    // The value has to reach the LOG, not just the wake note: an operator
    // reading the mission afterwards is entitled to know what the mesh
    // proceeded on, and a wake note is not persisted anywhere it can see.
    const ev = (await m.store.read())
      .filter((e) => e.type === "commitment.discharged")
      .find((e) => (e.payload as Record<string, unknown>).messageId === id);
    assert.ok(ev, "the default must be on the log");
    const p = ev!.payload as Record<string, unknown>;
    assert.equal(p.reason, "defaulted");
    assert.equal(p.assumed, "postgres", "the assumed value is the whole record of what was decided");
    assert.deepEqual(p.unanswered, ["dev"], "and who did not answer is still worth recording");

    const after = replayed(m, await m.store.read());
    assert.equal(after.pendingRequests.has(id), false, "the default must survive replay");
    assert.equal(after.discharged.find((d) => d.messageId === id)?.reason, "defaulted");
  } finally {
    await m.cleanup();
  }
});

test("a defaulted ask RESOLVES its thread — it is not an unanswered question for a human", async () => {
  const m = await pair({ ttlMs: 50 });
  try {
    const res = await askWithDefault(m, { assume: false });
    const id = res.messageId!;
    const threadId = m.kernel.state.messages.get(id)!.threadId;

    await waitFor("the deadline passed", () => Date.now() > Date.parse(m.kernel.state.pendingRequests.get(id)!.dueBy!));
    await sweep(m);

    // The single most important assertion in this file. `expired` settles a
    // thread ESCALATED, which raises an operator card; if `defaulted` did the
    // same, the low-contact path would generate exactly the human interrupts
    // it exists to remove, and it would do it once per unanswered ask.
    assert.equal(m.kernel.state.threads.get(threadId)!.status, "RESOLVED");
    assert.equal(
      [...m.kernel.state.escalations.values()].length,
      0,
      "an ask that ended the way its asker said it would is nobody's card",
    );
  } finally {
    await m.cleanup();
  }
});

test("`defaulted` is neither an unanswered reason nor a per-debtor one", () => {
  // Both memberships are load-bearing and neither is visible from the call
  // site. In UNANSWERED it would escalate the thread (see above). In
  // PER_DEBTOR it would close one debtor's share and leave the ask open for
  // the rest — but the deadline is the ASK's, not any one debtor's, so a
  // partial default would leave the asker holding a half-answered question it
  // had already been told to proceed without.
  assert.equal(UNANSWERED_DISCHARGE_REASONS.has("defaulted"), false);
  assert.equal(PER_DEBTOR_DISCHARGE_REASONS.has("defaulted"), false);
  assert.equal(UNANSWERED_DISCHARGE_REASONS.has("expired"), true, "the reason it is NOT spelled the same way");
});

test("`afterMs` draws a deadline on a mesh that has none", async () => {
  const m = await pair();
  try {
    assert.equal(m.config.bus.commitmentTtl, undefined, "this fixture must have no deadline regime at all");
    const res = await askWithDefault(m, { assume: "proceed", afterMs: 50 });
    assert.equal(res.ok, true, res.reason);
    const id = res.messageId!;

    const pending = m.kernel.state.pendingRequests.get(id)!;
    assert.ok(pending.dueBy, "an ask that names its own wait must get a deadline even where the mesh grants none");

    // An ordinary ask on this same mesh gets none — which is what makes the
    // line above about `afterMs` rather than about the fixture.
    const plain = await m.supervisor.executeOp(
      "architect",
      { op: "send", type: "REQUEST_INFO", to: ["dev"], threadId: pending.threadId, payload: { question: "and the cache?" } } as MeshOp,
      fakeTurn("architect"),
    );
    assert.equal(m.kernel.state.pendingRequests.get(plain.messageId!)!.dueBy, undefined);

    await waitFor("the deadline passed", () => Date.now() > Date.parse(pending.dueBy!));
    await sweep(m);
    assert.equal(recordFor(m, id)?.reason, "defaulted");
    assert.equal(m.kernel.state.pendingRequests.has(plain.messageId!), true, "and it took only the ask that asked for it");
  } finally {
    await m.cleanup();
  }
});

test("a default with no clock anywhere is REFUSED, not recorded and forgotten", async () => {
  const m = await pair();
  try {
    const res = await askWithDefault(m, { assume: "proceed" });
    assert.equal(res.ok, false, "a default that can never fire is worse than no default: the asker waits forever for it");
    assert.match(String(res.reason), /needs a deadline/);
    // The refusal has to name every way out, because the seat can fix two of
    // them itself and the third it can only ask for.
    assert.match(String(res.reason), /afterMs/);
    assert.match(String(res.reason), /bus\.commitments\.ttl_ms/);
    assert.equal(m.kernel.state.pendingRequests.size, 0, "a refused op opens no debt");
  } finally {
    await m.cleanup();
  }
});

test("a default with no value is REFUSED", async () => {
  const m = await pair({ ttlMs: 50_000 });
  try {
    const res = await askWithDefault(m, { afterMs: 1000 });
    assert.equal(res.ok, false);
    assert.match(String(res.reason), /needs an `assume`/);
  } finally {
    await m.cleanup();
  }
});

test("`decision.escalate` refuses a default, because it opens nothing to discharge", async () => {
  const m = await pair({ ttlMs: 50_000 });
  try {
    const res = await m.supervisor.executeOp(
      "architect",
      {
        op: "call",
        contract: "decision.escalate",
        request: { reason: "nobody here can settle this", detail: "two seats disagree on the store" },
        ifUnanswered: { assume: "proceed", afterMs: 1000 },
      } as unknown as MeshOp,
      fakeTurn("architect"),
    );
    assert.equal(res.ok, false, "an escalation raises a card for a human; there is no commitment for a deadline to close");
    assert.match(String(res.reason), /nothing to discharge/);
  } finally {
    await m.cleanup();
  }
});

test("the debtor is TOLD that silence is a legal ending here", async () => {
  const m = await pair({ ttlMs: 50_000 });
  try {
    await askWithDefault(m, { assume: { store: "postgres" } });
    const rendered = renderContextInstructions(buildAgentContext({ config: m.config, kernel: m.kernel }, "dev"));

    // Without this line the key would spend the debtor's attention on exactly
    // the asks the asker had already said it could do without — the cost it
    // exists to remove, paid anyway because only one side was told.
    assert.match(rendered, /if you say nothing/);
    assert.match(rendered, /\{"store":"postgres"\}/, "the debtor must see WHAT will be assumed, not just that something will be");
    assert.match(rendered, /answer only if that would be WRONG/);
  } finally {
    await m.cleanup();
  }
});

test("an ordinary ask says no such thing", async () => {
  const m = await pair({ ttlMs: 50_000 });
  try {
    await m.supervisor.executeOp(
      "architect",
      { op: "send", type: "REQUEST_INFO", to: ["dev"], newThread: { subject: "which store?" }, payload: { question: "?" } } as MeshOp,
      fakeTurn("architect"),
    );
    const rendered = renderContextInstructions(buildAgentContext({ config: m.config, kernel: m.kernel }, "dev"));
    assert.doesNotMatch(rendered, /if you say nothing/, "silence is still not a move on an ask nobody priced it for");
  } finally {
    await m.cleanup();
  }
});

test("the ASKER is woken at the deadline and handed back its own default", async () => {
  const m = await makeMesh({
    agents: twoAgents(),
    mayContact: { architect: ["dev"], dev: ["architect"] },
    mode: "live",
    // The nudge machinery pushed past the end of the test: this is about the
    // deadline, and a stall nudge landing mid-run would be a second reason
    // for a wake and would make the assertion below prove nothing.
    stallIdleMs: 600_000,
    stallCooldownMs: 600_000,
    stallNoopRetryMs: 600_000,
    bus: { commitments: { ttlMs: 50 } },
  });
  try {
    const woken: ActivationReason[] = [];
    let asked = false;
    stub(m).setScript("architect", async (input) => {
      woken.push(input.activation);
      if (asked) return { operations: [{ op: "wait", reason: "holding" } as MeshOp] };
      asked = true;
      return {
        operations: [
          {
            op: "send",
            type: "REQUEST_INFO",
            to: ["dev"],
            newThread: { subject: "which store?" },
            payload: { question: "postgres or sqlite?" },
            ifUnanswered: { assume: "postgres" },
          },
          { op: "wait", reason: "asked, with a default" },
        ] as unknown as MeshOp[],
      };
    });
    stub(m).setScript("dev", async () => ({ operations: [{ op: "wait", reason: "saying nothing" } as MeshOp] }));

    await m.supervisor.activateAgent("architect", { kind: "manual" });
    await waitFor("the ask is on the ledger", () => m.kernel.state.pendingRequests.size === 1);
    const pending = [...m.kernel.state.pendingRequests.values()][0]!;

    await waitFor("the deadline passed", () => Date.now() > Date.parse(pending.dueBy!));
    await internals(m).checkStall();

    await waitFor("the asker was woken by its own deadline", () => woken.some((r) => r.kind === "recovery"));
    const note = String(woken.find((r) => r.kind === "recovery")!.note);
    // A wake that only said "your ask closed" would send the seat back to the
    // ledger to work out what it had promised itself — which is a turn spent
    // re-deriving something the mesh already knows.
    assert.match(note, /nobody objected by the deadline/);
    assert.match(note, /"postgres"/, "the asker must be handed the value, not a pointer to it");
    assert.match(note, /do not re-ask/);

    assert.equal(recordFor(m, pending.messageId)?.reason, "defaulted");
  } finally {
    await m.cleanup();
  }
});

test("an ask carrying a default is never nudged, and never becomes a stalemate", async () => {
  const m = await makeMesh({
    agents: [
      { id: "asker", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "ghost", role: "architect", capabilities: ["review.design"], authority: ["architecture.approve"], interests: [] },
    ],
    mayContact: { asker: ["ghost"], ghost: [] },
    waitWakeupMs: 60,
  });
  try {
    stub(m).setScript("asker", async (_i, turn) => {
      if (turn === 0) {
        return {
          operations: [
            {
              op: "send",
              type: "REQUEST_REVIEW",
              to: ["ghost"],
              newThread: { subject: "review plz" },
              payload: { q: 1 },
              // Long enough that the deadline cannot fire during this test:
              // what is under test is the NUDGE ladder, and an ask that
              // expired mid-run would empty the ledger and make the silence
              // below prove nothing.
              ifUnanswered: { assume: "no objections", afterMs: 600_000 },
            },
            { op: "wait", reason: "asked, with a default" },
          ] as unknown as MeshOp[],
        };
      }
      return { operations: [{ op: "wait", reason: "still holding" } as MeshOp] };
    });
    // `ghost` is deliberately unscripted: it never answers.

    await m.supervisor.activateAgent("asker", { kind: "manual" });
    await waitFor("the ask is on the ledger", () => m.kernel.state.pendingRequests.size === 1);
    await waitFor("the asker settled into waiting", () => m.kernel.state.agents.get("asker")!.state.lifecycle === "WAITING");

    // The delivery wake is legitimate and is not what is under test — ghost is
    // told about an ask it owes, once. The baseline is taken AFTER it lands.
    const baseline = m.kernel.state.agents.get("ghost")!.state.activations;
    await new Promise((r) => setTimeout(r, 900));

    assert.equal(
      m.kernel.state.agents.get("ghost")!.state.activations,
      baseline,
      "fifteen nudge windows passed; chasing this ask is the exact cost the default removes",
    );
    assert.equal(
      [...m.kernel.state.escalations.values()].filter((e) => e.reason === "stalemate:unanswered_request").length,
      0,
      "and it must never reach a human as a question nobody answered",
    );
    assert.equal(m.kernel.state.pendingRequests.size, 1, "the ask is still open — it was skipped, not silently closed");
  } finally {
    await m.cleanup();
  }
});
