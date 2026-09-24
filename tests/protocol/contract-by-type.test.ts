import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { buildAgentContext, renderContextInstructions } from "../../packages/core/src/context";
import { applyEvent } from "../../packages/core/src/projections";
import { createInitialState } from "../../packages/core/src/state";
import {
  BUILTIN_CONTRACTS,
  OBLIGING_MESSAGE_TYPES,
  contractForMessageType,
  findContract,
  isObligingType,
} from "../../packages/protocol/src/index";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * The contract a bare typed ask inherits (`bus.commitments.by_type`).
 *
 * The hole this closes: `mesh_send` with `type: REQUEST_INFO` opened a real
 * debt — a row in the ledger, a nudge ladder, an escalation at the end of it —
 * and carried no contract, so the refusal set was open, the deadline was the
 * mesh default, and the answer was never judged. `mesh_call` with the same
 * question got all three. Two doors to the same room, one of them with no
 * rules on it, and the typed door is the one the older role prompts teach.
 *
 * Two properties are load-bearing and pull in opposite directions:
 *
 *  - the mapping is DERIVED from each contract's own `messageType`, so it
 *    cannot drift from the catalogue it claims to summarise;
 *  - the default is OFF unless a mesh writes the key, because turning it on
 *    turns an open refusal set into a closed one, which is a behaviour change
 *    every existing mesh is entitled not to receive.
 */

function seats() {
  return [
    { id: "architect", role: "architect", capabilities: ["review.design"], interests: [] },
    { id: "dev", role: "developer", capabilities: ["repository.write", "repository.read"], interests: [] },
  ];
}

function mesh(byType: boolean, ttlMs?: number) {
  const commitments = { ...(byType ? { byType: true } : {}), ...(ttlMs !== undefined ? { ttlMs } : {}) };
  return makeMesh({
    agents: seats(),
    mayContact: { architect: ["dev"], dev: ["architect"] },
    mode: "parked",
    ...(Object.keys(commitments).length ? { bus: { commitments } } : {}),
  } as never);
}

type Mesh = Awaited<ReturnType<typeof mesh>>;

async function runOp(m: Mesh, agentId: string, op: MeshOp) {
  const turn = {
    turnId: `t-${Math.random().toString(36).slice(2)}`,
    agentId,
    reason: { kind: "manual" as const },
    sentOps: 0,
    publishedOps: 0,
    waitRequested: false,
    escalated: false,
    results: [],
  };
  return m.supervisor.executeOp(agentId, op, turn as never);
}

/** A plain typed ask: the shape that had no contract before this key existed. */
const bareAsk = (type: string, payload: unknown = { question: "which cache?" }): MeshOp =>
  ({ op: "send", type, to: ["dev"], newThread: { subject: "bare ask" }, payload }) as MeshOp;

test("by-type: every obliging type has exactly one contract, and every contract claims one", () => {
  // The 1:1 this whole feature rests on. If a type had no contract the default
  // would be a silent no-op for that type; if it had two, `contractForMessageType`
  // would pick one by catalogue order, which is not a decision anybody made.
  for (const type of OBLIGING_MESSAGE_TYPES) {
    const c = contractForMessageType(type);
    assert.ok(c, `no contract speaks for ${type}, so a bare ${type} would default to nothing`);
    assert.equal(c!.messageType, type, "the contract must claim the type it is returned for");
  }
  const claimed = BUILTIN_CONTRACTS.map((c) => c.messageType);
  assert.equal(new Set(claimed).size, claimed.length, `two contracts claim one type: ${claimed.join(", ")}`);
  for (const c of BUILTIN_CONTRACTS) {
    assert.ok(isObligingType(c.messageType), `${c.name} claims ${c.messageType}, which creates no debt to govern`);
  }
});

test("by-type: the map is derived from the catalogue, not a second copy of it", () => {
  // Derivation is the property, not the current contents: a hand-written table
  // would pass the test above on the day it was written and rot afterwards.
  // This asserts identity — the object returned IS the catalogue entry.
  for (const c of BUILTIN_CONTRACTS) {
    assert.equal(contractForMessageType(c.messageType), c, `${c.name} must be returned by reference, not rebuilt`);
    assert.equal(findContract(c.name), c);
  }
});

test("by-type: a type no contract claims gets no default, rather than a wrong one", () => {
  // `isObligingType` is a PREFIX match, so a `REQUEST_*` type added later is
  // obliging from the moment it exists. It must arrive contractless rather
  // than inherit whichever contract happens to sort first.
  assert.equal(contractForMessageType("REQUEST_SOMETHING_NEW"), undefined);
  assert.equal(contractForMessageType("INFORM"), undefined, "an INFORM obliges nobody and governs nothing");
  assert.equal(contractForMessageType(""), undefined);
  assert.equal(contractForMessageType(undefined as never), undefined);
});

test("by-type: off, a bare REQUEST_INFO is still ungoverned — exactly as before", async () => {
  const m = await mesh(false);
  try {
    const ask = await runOp(m, "architect", bareAsk("REQUEST_INFO"));
    assert.equal(ask.ok, true, ask.ok ? "" : ask.reason);
    const askId = (ask.ok ? ask.messageId : "")!;
    const pending = m.kernel.state.pendingRequests.get(askId);
    assert.ok(pending, "the debt is real either way; only its governance is at issue");
    assert.equal(pending!.contract, undefined, "an unconfigured mesh must not acquire a contract it never asked for");
    assert.equal(pending!.dueBy, undefined, "and must not acquire info.question's 10-minute clock either");

    // The open refusal set is the visible half: any word settles the ask.
    const out = await runOp(m, "dev", { op: "discharge", messageId: askId, refusal: "cannot-be-bothered", reason: "no" } as MeshOp);
    assert.equal(out.ok, true, out.ok ? "" : out.reason);
  } finally {
    await m.cleanup();
  }
});

test("by-type: on, a bare REQUEST_INFO inherits info.question's closed refusal set", async () => {
  const m = await mesh(true);
  try {
    const ask = await runOp(m, "architect", bareAsk("REQUEST_INFO"));
    assert.equal(ask.ok, true, ask.ok ? "" : ask.reason);
    const askId = (ask.ok ? ask.messageId : "")!;
    const pending = m.kernel.state.pendingRequests.get(askId)!;
    assert.equal(pending.contract, "info.question", "the type names the contract when the sender did not");

    const bogus = await runOp(m, "dev", { op: "discharge", messageId: askId, refusal: "cannot-be-bothered", reason: "no" } as MeshOp);
    assert.equal(bogus.ok, false, "the inherited refusal set must be closed, or inheriting it bought nothing");
    const reason = bogus.ok ? "" : bogus.reason!;
    assert.match(reason, /info\.question/, "the refusal must name the contract the debtor never chose");
    assert.match(reason, /not-my-capability/, "and must quote the refusals that would have worked");

    const good = await runOp(m, "dev", { op: "discharge", messageId: askId, refusal: "out-of-scope", reason: "ask infra" } as MeshOp);
    assert.equal(good.ok, true, good.ok ? "" : good.reason);
  } finally {
    await m.cleanup();
  }
});

test("by-type: an inherited SLA narrows a deadline regime and never creates one", async () => {
  // The rule `computeDueBy` enforces, and the one that keeps this key from
  // being an upgrade that quietly starts expiring asks: expiry is an
  // operator's choice. A mesh with no `ttl_ms` has no clock, and inheriting a
  // contract must not hand it one.
  const without = await mesh(true);
  try {
    const ask = await runOp(without, "architect", bareAsk("REQUEST_INFO"));
    const pending = without.kernel.state.pendingRequests.get((ask.ok ? ask.messageId : "")!)!;
    assert.equal(pending.contract, "info.question", "governed");
    assert.equal(pending.dueBy, undefined, "but not on a clock the operator never asked for");
  } finally {
    await without.cleanup();
  }

  // With a regime, the contract's 10 minutes beats the mesh-wide hour: a cheap
  // question and an expensive review should not share one deadline.
  const withTtl = await mesh(true, 60 * 60_000);
  try {
    const sentAt = Date.now();
    const ask = await runOp(withTtl, "architect", bareAsk("REQUEST_INFO"));
    const pending = withTtl.kernel.state.pendingRequests.get((ask.ok ? ask.messageId : "")!)!;
    assert.ok(pending.dueBy, "the regime exists, so the ask has a deadline");
    const due = Date.parse(pending.dueBy!) - sentAt;
    assert.ok(due > 9 * 60_000 && due <= 11 * 60_000, `expected info.question's ~10m, not the mesh hour; got ${due}ms`);
  } finally {
    await withTtl.cleanup();
  }

  // Off, the same ask waits the mesh-wide hour, because nothing narrowed it.
  const off = await mesh(false, 60 * 60_000);
  try {
    const sentAt = Date.now();
    const ask = await runOp(off, "architect", bareAsk("REQUEST_INFO"));
    const pending = off.kernel.state.pendingRequests.get((ask.ok ? ask.messageId : "")!)!;
    const due = Date.parse(pending.dueBy!) - sentAt;
    assert.ok(due > 59 * 60_000, `expected the mesh default to stand at ~60m; got ${due}ms`);
  } finally {
    await off.cleanup();
  }
});

test("by-type: on, the answer is judged — recorded, never blocked", async () => {
  const m = await mesh(true);
  try {
    const ask = await runOp(m, "architect", bareAsk("REQUEST_INFO"));
    const askId = (ask.ok ? ask.messageId : "")!;
    const thin = await runOp(m, "dev", {
      op: "send", type: "INFORM", to: ["architect"],
      threadId: m.kernel.state.messages.get(askId)!.threadId,
      replyTo: askId, payload: { note: "sure, will do" },
    } as MeshOp);
    // Fail-open is the whole design of `checkResponse`: holding an ask open on
    // shape would feed the nudge ladder and escalate formatting to a human.
    assert.equal(thin.ok, true, "a thin answer still settles the ask");
    const rec = m.kernel.state.discharged.find((d) => d.messageId === askId);
    assert.equal(rec!.responseValid, false, "but the ledger records that it answered nothing");
  } finally {
    await m.cleanup();
  }
});

test("by-type: an explicitly named contract still wins over the type's default", async () => {
  // `mesh_call` stamps `control.contract` only after the request schema passed.
  // The default must never overwrite a stamp that means more than it does.
  const m = await mesh(true);
  try {
    const ask = await runOp(m, "architect", {
      op: "call", contract: "research.question",
      request: { question: "what do comparable systems do about backpressure?" },
      to: ["dev"],
    } as MeshOp);
    assert.equal(ask.ok, true, ask.ok ? "" : ask.reason);
    const askId = (ask.ok ? ask.messageId : "")!;
    const pending = m.kernel.state.pendingRequests.get(askId)!;
    assert.equal(pending.contract, "research.question");
    assert.equal(
      m.kernel.state.messages.get(askId)!.control?.contract,
      "research.question",
      "and the stamp on the wire is still the one the schema check wrote",
    );
  } finally {
    await m.cleanup();
  }
});

test("by-type: the default is resolved in the ledger and never stamped on the wire", async () => {
  // The invariant a stamp carries: `control.contract` means THIS ASK PASSED
  // ITS REQUEST SCHEMA. The default has checked no schema, so writing it onto
  // the envelope would make every later reader of that field wrong.
  const m = await mesh(true);
  try {
    const ask = await runOp(m, "architect", bareAsk("REQUEST_INFO", { anything: "not a question field" }));
    assert.equal(ask.ok, true, "the request body is deliberately NOT validated against the inherited contract");
    const askId = (ask.ok ? ask.messageId : "")!;
    assert.equal(m.kernel.state.messages.get(askId)!.control?.contract, undefined, "nothing is stamped");
    assert.equal(m.kernel.state.pendingRequests.get(askId)!.contract, "info.question", "and the debt is governed anyway");
  } finally {
    await m.cleanup();
  }
});

test("by-type: the debtor is TOLD which contract it inherited, and that the ask was unchecked", async () => {
  // A closed refusal set the debtor is never shown is a trap, not a vocabulary:
  // it can only discover the set by guessing wrong and being refused.
  const m = await mesh(true);
  try {
    const ask = await runOp(m, "architect", bareAsk("REQUEST_INFO"));
    const askId = (ask.ok ? ask.messageId : "")!;
    const bundle = buildAgentContext({ config: m.config, kernel: m.kernel }, "dev");
    const text = renderContextInstructions(bundle);
    assert.ok(text.includes("info.question"), "the inherited contract must be named in the prompt");
    assert.match(text, /not-my-capability/, "and its refusals must be quoted, since they are now the only legal ones");
    assert.match(
      text,
      /because it is a REQUEST_INFO, not because the sender named it/,
      "the debtor must be told the ask itself was never checked against the contract",
    );
    assert.ok(askId, "sanity: the ask exists");
  } finally {
    await m.cleanup();
  }
});

test("by-type: the flag rides into replay, so a rebuilt ledger holds the same contracts", async () => {
  // The live kernel and `supervisor.replay()` read this knob from two
  // different places — `kernel.gates` and `projectionConfig()`. This was NOT
  // hypothetical: the gate was declared on the kernel and never handed to it,
  // so the reducer defaulted nothing while the prompt claimed it had. A knob
  // the live kernel has and a replay does not is a divergence between the log
  // and the state rebuilt from it, which is the one thing an event-sourced
  // kernel is not allowed to have.
  const m = await mesh(true);
  try {
    const ask = await runOp(m, "architect", bareAsk("REQUEST_INFO"));
    const askId = (ask.ok ? ask.messageId : "")!;
    const live = m.kernel.state.pendingRequests.get(askId)!;
    assert.equal(live.contract, "info.question");

    // The same pair `supervisor.replay()` uses: a fresh state, every event in
    // the log, and `projectionConfig()` as the knobs. `ReplayState` does not
    // surface the commitment ledger, and widening a production type to let a
    // test look at it would be the wrong fix.
    const rebuilt = createInitialState();
    for (const e of await m.store.read()) applyEvent(rebuilt, e, m.supervisor.projectionConfig());
    const replayed = rebuilt.pendingRequests.get(askId);
    assert.ok(replayed, "the ask survives the rebuild");
    assert.equal(replayed!.contract, live.contract, "and it is governed by the same contract it was governed by live");
  } finally {
    await m.cleanup();
  }
});
