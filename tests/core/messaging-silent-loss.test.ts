import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEvent } from "../../packages/core/src/projections";
import { applyMessagingEvent } from "../../packages/core/src/projections-messaging";
import {
  createInitialState,
  exportState,
  importState,
  MAX_DENIED_ACTIONS,
  MAX_REFUSED_SENDS,
  MAX_UNREAD_PER_AGENT,
  type Projections,
} from "../../packages/core/src/state";
import {
  PROTOCOL_VERSION,
  type AgentDefinition,
  type MeshEvent,
  type MeshMessage,
  type MessageType,
  type Thread,
} from "../../packages/protocol/src/index";

/**
 * The two silent-loss paths in the messaging projection.
 *
 * Both are about a fact the mesh knew and then threw away: a send policy
 * refused, and mail the unread cap dropped. Neither changes what is delivered
 * — the sender of a refused message already gets `{ accepted: false }` back —
 * so every assertion here is about whether the loss is still countable
 * afterwards, and about the reducer staying a pure function of the log while
 * counting it.
 */

const GOAL_ID = "goal-refusal";
const THREAD_ID = "thr-refusal";

let seq = 0;
function evt(type: string, payload: Record<string, unknown>, over: Partial<MeshEvent> = {}): MeshEvent {
  seq++;
  return {
    id: over.id ?? `evt-rej-${seq}`,
    protocolVersion: PROTOCOL_VERSION,
    type: type as MeshEvent["type"],
    timestamp: over.timestamp ?? `2026-03-01T00:00:${String(seq % 60).padStart(2, "0")}.000Z`,
    goalId: over.goalId ?? GOAL_ID,
    actorId: over.actorId,
    seq,
    payload,
  } as MeshEvent;
}

let msgSeq = 0;
function message(over: Partial<MeshMessage> & { from: string; to: string[]; type: MessageType }): MeshMessage {
  msgSeq++;
  return {
    id: over.id ?? `rmsg-${msgSeq}`,
    protocolVersion: PROTOCOL_VERSION,
    type: over.type,
    timestamp: over.timestamp ?? "2026-03-01T00:10:00.000Z",
    goalId: GOAL_ID,
    from: over.from,
    to: over.to,
    threadId: over.threadId ?? THREAD_ID,
    artifactRefs: [],
    payload: over.payload ?? {},
    priority: "NORMAL",
  } as MeshMessage;
}

function thread(): Thread {
  return {
    id: THREAD_ID,
    goalId: GOAL_ID,
    subject: "refusals",
    initiator: "architect",
    artifactRefs: [],
    participants: [],
    depth: 1,
    messageIds: [],
    status: "OPEN",
    budget: {},
    createdAt: "2026-03-01T00:00:00.000Z",
  } as Thread;
}

function agentDef(id: string, role: string): AgentDefinition {
  return { id, role, mode: "peer", capabilities: [], authority: [], interests: [] } as unknown as AgentDefinition;
}

function seed(): Projections {
  const state = createInitialState();
  for (const [id, role] of [["architect", "architect"], ["dev", "developer"], ["qa", "qa"]]) {
    applyEvent(state, evt("agent.created", { agent: agentDef(id!, role!) }));
  }
  applyEvent(state, evt("thread.created", { thread: thread() }));
  return state;
}

/** The shape `sendMessage` emits when a policy rule denies a send. */
function policyRefusal(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    from: "dev",
    to: ["qa"],
    type: "REQUEST_REVIEW",
    reason: "dev may not ask qa directly",
    ruleId: "routing.no-direct-qa",
    payload: { question: "ready?" },
    ...over,
  };
}

// --------------------------------------------------------- refused sends

test("a policy-refused send is recorded in state, not only on the log", () => {
  const state = seed();

  applyEvent(state, evt("message.rejected", policyRefusal(), { actorId: "dev", timestamp: "2026-03-01T09:00:00.000Z" }));

  assert.equal(state.refusedSends.length, 1);
  assert.deepEqual(state.refusedSends[0], {
    from: "dev",
    to: ["qa"],
    type: "REQUEST_REVIEW",
    reason: "dev may not ask qa directly",
    ruleId: "routing.no-direct-qa",
    at: "2026-03-01T09:00:00.000Z",
  });
  // The refusal must not be mistaken for a send: no message, no mailbox entry,
  // and above all no pending request, or the mesh would wait on an ask that
  // was never posed.
  assert.equal(state.messages.size, 0);
  assert.equal(state.pendingRequests.size, 0);
  assert.deepEqual(state.unread.get("qa") ?? [], []);
});

test("the refused payload is deliberately not retained", () => {
  const state = seed();

  applyEvent(state, evt("message.rejected", policyRefusal({ payload: { secret: "x".repeat(5000) } })));

  const rec = state.refusedSends[0] as unknown as Record<string, unknown>;
  assert.ok(rec);
  assert.equal("payload" in rec, false, "verbatim agent input must not ride into every snapshot");
});

test("a validation refusal is recorded with no ruleId, because no rule refused it", () => {
  const state = seed();

  // `sendMessage`'s second refusal site: protocol validation, which has no
  // policy rule to name. The absent `ruleId` is the operator's signal that
  // this one is not theirs to fix by editing policy.
  applyEvent(state, evt("message.rejected", {
    from: "dev",
    to: ["qa", "architect"],
    type: "INFORM",
    reason: "message failed protocol validation: /payload must be object",
  }));

  const rec = state.refusedSends[0];
  assert.ok(rec);
  assert.equal(rec.ruleId, undefined);
  assert.deepEqual(rec.to, ["qa", "architect"]);
});

test("op and activation denials ride the same event type but are not sends", () => {
  const state = seed();

  // `Supervisor.denied` — reached by refused ops AND by
  // `reportActivationDenied` — emits `message.rejected` with an `action` and
  // no recipients at all. Admitting those here would let one misconfigured op
  // rule evict every record of a message that never left the building.
  applyEvent(state, evt("message.rejected", {
    from: "dev",
    action: "claim task (missing capability code.write)",
    subject: "task-1",
    reason: "capability not granted",
    ruleId: "capability.deny",
    decision: "DENY",
    denied: true,
  }));
  applyEvent(state, evt("message.rejected", {
    from: "qa",
    action: "activate (scheduled)",
    reason: "max-activations",
    decision: "DENY",
    denied: true,
  }));

  assert.deepEqual(state.refusedSends, [], "a denial with no recipients is not a refused send");

  // ...but they are not nothing either. Before the second ring existed this
  // half of `message.rejected` was projected nowhere at all: every op refusal
  // and every activation denial the mesh made lived only in the raw log, so
  // nothing that reads state could count them.
  assert.equal(state.deniedActions.length, 2, "both denials are projected, just not as sends");
  assert.deepEqual(state.deniedActions[0], {
    agentId: "dev",
    action: "claim task (missing capability code.write)",
    subject: "task-1",
    reason: "capability not granted",
    ruleId: "capability.deny",
    decision: "DENY",
    at: state.deniedActions[0]!.at,
  });
  // The optional halves stay absent rather than arriving as undefined keys,
  // so a JSON snapshot roundtrip cannot change the record's shape.
  const sparse = state.deniedActions[1] as unknown as Record<string, unknown>;
  assert.equal(sparse.action, "activate (scheduled)");
  assert.equal("subject" in sparse, false);
  assert.equal("ruleId" in sparse, false);
  assert.equal("payload" in sparse, false, "verbatim agent input must not ride into every snapshot");
});

// ------------------------------------------------------- denied actions

/**
 * The two rings must not feed each other. `refusedSends` answers "which
 * messages did policy stop?" and `deniedActions` answers "which ops did
 * policy stop?"; folding them together would let one misconfigured op rule
 * evict every record of a refused send, which is the blast radius the
 * separate caps exist to prevent.
 */
test("a refused send is not a denied action", () => {
  const state = seed();

  applyEvent(state, evt("message.rejected", policyRefusal()));
  applyEvent(state, evt("message.rejected", {
    from: "dev",
    to: ["qa", "architect"],
    type: "INFORM",
    reason: "message failed protocol validation: /payload must be object",
  }));

  assert.equal(state.refusedSends.length, 2, "both send shapes still land where they always did");
  assert.deepEqual(state.deniedActions, [], "and neither one leaks into the op ring");
});

test("a denial that names no action at all is dropped rather than half-recorded", () => {
  const state = seed();

  // An empty payload is replayed off disk like any other row. A record with
  // no `action` names nothing an operator could act on, and `action` is the
  // one field `Supervisor.denied` cannot write without.
  applyEvent(state, evt("message.rejected", {}));
  applyEvent(state, evt("message.rejected", { from: "dev", reason: "unexplained" }));

  assert.deepEqual(state.deniedActions, []);
  assert.deepEqual(state.refusedSends, []);
});

test("deniedActions is a bounded ring with its own cap, keeping the newest", () => {
  const state = seed();

  for (let i = 0; i < MAX_DENIED_ACTIONS + 25; i++) {
    applyEvent(state, evt("message.rejected", {
      from: "dev", action: `op-${i}`, reason: "denied", decision: "DENY", denied: true,
    }));
  }

  assert.equal(state.deniedActions.length, MAX_DENIED_ACTIONS);
  assert.equal(state.deniedActions[0]?.action, "op-25", "oldest dropped");
  assert.equal(state.deniedActions.at(-1)?.action, `op-${MAX_DENIED_ACTIONS + 24}`, "newest kept");
  assert.deepEqual(state.refusedSends, [], "a flood of op denials must not cost a single send record");
});

test("deniedActions survives a snapshot roundtrip", () => {
  const source = seed();
  applyEvent(source, evt("message.rejected", {
    from: "qa", action: "activate (scheduled)", reason: "max-activations", decision: "DENY", denied: true,
  }));
  applyEvent(source, evt("message.rejected", policyRefusal({ reason: "a send, not an op" })));

  // Production restores from a snapshot and then replays only what is
  // strictly above `throughSeq`, so a key the codec forgets is lost on every
  // restart — and tests that boot in memory take the full-replay path and
  // never notice.
  const snapshot = JSON.parse(JSON.stringify(exportState(source))) as Parameters<typeof importState>[1];
  const restored = createInitialState();
  importState(restored, snapshot);

  assert.equal(restored.deniedActions.length, 1);
  assert.equal(restored.deniedActions[0]?.action, "activate (scheduled)");
  assert.equal(restored.deniedActions[0]?.agentId, "qa");
  assert.equal(restored.refusedSends.length, 1, "and the other ring came back too");
});

test("a snapshot written before deniedActions existed restores to empty, not undefined", () => {
  const state = seed();
  applyEvent(state, evt("message.rejected", { from: "dev", action: "claim task", reason: "no", denied: true }));

  importState(state, { eventCount: 3 });

  assert.deepEqual(state.deniedActions, [], "importState must clear it, not leave the pre-import ring standing");
  assert.deepEqual(exportState(state).deniedActions, []);
});

test("the reducer still owns message.rejected in every shape, including an empty payload", () => {
  const state = createInitialState();

  assert.equal(applyMessagingEvent(state, evt("message.rejected", {}), {}), true);
  assert.equal(applyMessagingEvent(state, evt("message.rejected", policyRefusal()), policyRefusal()), true);
  assert.equal(applyMessagingEvent(state, evt("goal.created", {}), {}), false, "unowned types must still fall through");
  // A payload with no recipients must be survived, not crashed on: the log is
  // replayed from disk and a reducer that throws on an old row is a mesh that
  // cannot start.
  assert.equal(state.refusedSends.length, 1);
});

test("refusedSends is a bounded ring that keeps the newest refusals", () => {
  const state = seed();

  for (let i = 0; i < MAX_REFUSED_SENDS + 25; i++) {
    applyEvent(state, evt("message.rejected", policyRefusal({ reason: `refusal-${i}` })));
  }

  assert.equal(state.refusedSends.length, MAX_REFUSED_SENDS);
  assert.equal(state.refusedSends[0]?.reason, "refusal-25", "oldest dropped");
  assert.equal(state.refusedSends.at(-1)?.reason, `refusal-${MAX_REFUSED_SENDS + 24}`, "newest kept");
});

// ------------------------------------------------------- mailbox overflow

test("mail the unread cap drops is counted per agent instead of vanishing", () => {
  const state = seed();
  const overflow = 5;

  for (let i = 0; i < MAX_UNREAD_PER_AGENT + overflow; i++) {
    applyEvent(state, evt("message.sent", { message: message({ from: "architect", to: ["dev"], type: "INFORM" as MessageType }) }));
  }

  assert.equal(state.unread.get("dev")?.length, MAX_UNREAD_PER_AGENT);
  // Accrued one per over-cap event, which is how a real flood arrives.
  assert.equal(state.mailOverflowDropped.get("dev"), overflow);
  assert.equal(state.mailOverflowDropped.get("qa"), undefined, "an agent under its cap gets no entry");
  // The cap already re-synced this; the counter must not have disturbed it.
  assert.equal(state.agents.get("dev")?.state.mailboxDepth, MAX_UNREAD_PER_AGENT);
});

test("a box already far over cap is drained in one step and counted in one step", () => {
  const state = seed();
  const box = Array.from({ length: MAX_UNREAD_PER_AGENT + 50 }, (_, i) => `old-${i}`);
  state.unread.set("qa", box);

  // Any owned event runs the cap sweep; this one touches nothing else.
  applyEvent(state, evt("message.delivered", { agentId: "architect", messageId: "nope" }));

  assert.equal(state.unread.get("qa")?.length, MAX_UNREAD_PER_AGENT);
  assert.equal(state.mailOverflowDropped.get("qa"), 50);
  // Oldest-first: the survivors are the tail.
  assert.equal(state.unread.get("qa")?.[0], "old-50");
});

test("drop counts accumulate across sweeps rather than being overwritten", () => {
  const state = seed();
  state.unread.set("dev", Array.from({ length: MAX_UNREAD_PER_AGENT + 10 }, (_, i) => `a-${i}`));
  applyEvent(state, evt("message.delivered", { agentId: "architect", messageId: "nope" }));
  assert.equal(state.mailOverflowDropped.get("dev"), 10);

  state.unread.set("dev", Array.from({ length: MAX_UNREAD_PER_AGENT + 7 }, (_, i) => `b-${i}`));
  applyEvent(state, evt("message.delivered", { agentId: "architect", messageId: "nope" }));

  assert.equal(state.mailOverflowDropped.get("dev"), 17, "a second flood adds to the first");
});

// ------------------------------------------------------------ replay purity

test("both new fields are pure functions of the log", () => {
  const log = [
    evt("agent.created", { agent: agentDef("architect", "architect") }),
    evt("agent.created", { agent: agentDef("dev", "developer") }),
    evt("thread.created", { thread: thread() }),
    evt("message.rejected", policyRefusal({ reason: "first" })),
    evt("message.rejected", { from: "dev", action: "activate (idle)", reason: "paused", denied: true }),
    evt("message.rejected", policyRefusal({ reason: "second", ruleId: undefined })),
    ...Array.from({ length: MAX_UNREAD_PER_AGENT + 3 }, () =>
      evt("message.sent", { message: message({ from: "architect", to: ["dev"], type: "INFORM" as MessageType }) })),
  ];

  const first = createInitialState();
  for (const e of log) applyEvent(first, e);
  const second = createInitialState();
  for (const e of log) applyEvent(second, e);

  assert.deepEqual(first.refusedSends, second.refusedSends);
  assert.deepEqual([...first.mailOverflowDropped], [...second.mailOverflowDropped]);
  assert.equal(first.refusedSends.length, 2);
  assert.equal(first.mailOverflowDropped.get("dev"), 3);
  // Timestamps come off the event, never off a clock — the only reason a
  // replay can reproduce them at all.
  assert.equal(first.refusedSends[0]?.at, log[3]?.timestamp);
});

// ---------------------------------------------------------------- snapshots

test("refusedSends and mailOverflowDropped survive a snapshot roundtrip", () => {
  const source = seed();
  applyEvent(source, evt("message.rejected", policyRefusal({ reason: "kept" })));
  applyEvent(source, evt("message.rejected", {
    from: "qa", to: ["dev"], type: "CHALLENGE", reason: "no rule, just invalid",
  }));
  const boxIds = Array.from({ length: MAX_UNREAD_PER_AGENT + 12 }, (_, i) => `m-${i}`);
  // Real messages behind the ids, not bare strings. `importState` drops mailbox
  // entries with no message to resolve — a snapshot can truncate the history
  // out from under an id — and counts each one as loss, so a box of ids that
  // never were messages restores as 212 drops rather than the 12 the cap made.
  for (const id of boxIds) source.messages.set(id as never, { id } as never);
  source.unread.set("dev", boxIds);
  applyEvent(source, evt("message.delivered", { agentId: "architect", messageId: "nope" }));

  // The snapshot store writes JSON, so the roundtrip must survive it.
  const snapshot = JSON.parse(JSON.stringify(exportState(source))) as Parameters<typeof importState>[1];
  const restored = createInitialState();
  importState(restored, snapshot);

  assert.equal(restored.refusedSends.length, 2);
  assert.equal(restored.refusedSends[0]?.reason, "kept");
  assert.equal(restored.refusedSends[0]?.ruleId, "routing.no-direct-qa");
  assert.equal(restored.refusedSends[1]?.ruleId, undefined);
  assert.equal(restored.mailOverflowDropped instanceof Map, true, "entries must rehydrate as a Map, not an array");
  assert.equal(restored.mailOverflowDropped.get("dev"), 12);
});

test("importState clears both fields before loading", () => {
  const state = seed();
  applyEvent(state, evt("message.rejected", policyRefusal()));
  state.mailOverflowDropped.set("dev", 9);

  importState(state, {});

  assert.deepEqual(state.refusedSends, []);
  assert.equal(state.mailOverflowDropped.size, 0);
});

test("a snapshot written before these fields existed restores to empty, not undefined", () => {
  const state = createInitialState();

  importState(state, { eventCount: 3 });

  assert.deepEqual(state.refusedSends, []);
  assert.equal(state.mailOverflowDropped.size, 0);
  assert.deepEqual(exportState(state).refusedSends, []);
  assert.deepEqual(exportState(state).mailOverflowDropped, []);
});

test("importState screens unusable drop counts rather than storing NaN", () => {
  const state = createInitialState();

  importState(state, {
    mailOverflowDropped: [["dev", 4], ["qa", Number.NaN], [7 as unknown as string, 2]],
  });

  // A NaN drop count poisons every sum a report later takes of it, and a
  // non-string key is not an agent.
  assert.deepEqual([...state.mailOverflowDropped], [["dev", 4]]);
});
