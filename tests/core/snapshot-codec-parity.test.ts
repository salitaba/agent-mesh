import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEvent } from "../../packages/core/src/projections";
import { createInitialState, exportState, importState, MAX_UNREAD_PER_AGENT, type Projections } from "../../packages/core/src/state";
import {
  PROTOCOL_VERSION,
  type AgentDefinition,
  type Artifact,
  type MeshEvent,
  type MeshMessage,
  type MessageType,
  type Thread,
  type WorkspaceLease,
} from "../../packages/protocol/src/index";

/**
 * Snapshot codec parity.
 *
 * A production mesh does NOT rebuild its projections from the log: the kernel
 * imports the snapshot and then replays only `{ sinceSeq: throughSeq }`, which
 * the event store filters strictly (`e.seq > sinceSeq`). So every event at or
 * below the cut is applied exactly once, into the snapshot, and never again —
 * the snapshot is authoritative, not an optimisation. A projection key the
 * codec forgets is state the mesh loses on every restart.
 *
 * The suite never saw it because `tests/helpers.ts` boots `inMemory: true`,
 * which leaves the snapshot provider undefined and falls back to a full replay
 * from seq 0. Mail survived in tests and vanished in production.
 *
 * These tests cover the two keys that were genuinely lost — `unread` and
 * `activeLeaseByArtifact` — and then the guard that matters more than either:
 * a key added to `Projections` and forgotten in the codec used to pass the
 * entire suite in silence.
 */

const GOAL_ID = "goal-snap";
const THREAD_ID = "thr-snap";
const ARTIFACT_ID = "art-snap";

let seq = 0;
function evt(type: string, payload: Record<string, unknown>, over: Partial<MeshEvent> = {}): MeshEvent {
  seq++;
  return {
    id: over.id ?? `evt-snap-${seq}`,
    protocolVersion: PROTOCOL_VERSION,
    type: type as MeshEvent["type"],
    timestamp: over.timestamp ?? `2026-01-01T00:00:${String(seq % 60).padStart(2, "0")}.000Z`,
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
    id: over.id ?? `msg-snap-${msgSeq}`,
    protocolVersion: PROTOCOL_VERSION,
    type: over.type,
    timestamp: over.timestamp ?? `2026-01-01T00:10:${String(msgSeq % 60).padStart(2, "0")}.000Z`,
    goalId: GOAL_ID,
    from: over.from,
    to: over.to,
    threadId: over.threadId ?? THREAD_ID,
    artifactRefs: [],
    payload: {},
    priority: "NORMAL",
  } as unknown as MeshMessage;
}

function agentDef(id: string, role: string): AgentDefinition {
  return { id, role, mode: "peer", capabilities: [], authority: [], interests: [] } as unknown as AgentDefinition;
}

function lease(over: Partial<WorkspaceLease> & { id: string; agentId: string }): WorkspaceLease {
  return {
    id: over.id,
    artifactId: over.artifactId ?? ARTIFACT_ID,
    agentId: over.agentId,
    worktreePath: `/tmp/${over.agentId}`,
    files: ["src/api.ts"],
    acquiredAt: "2026-01-01T00:00:00.000Z",
    ...(over.releasedAt ? { releasedAt: over.releasedAt } : {}),
  } as WorkspaceLease;
}

/** A mesh with three seats and one open thread, built through the real reducers. */
function seed(): Projections {
  const state = createInitialState();
  for (const [id, role] of [["architect", "architect"], ["dev", "developer"], ["qa", "qa"]]) {
    applyEvent(state, evt("agent.created", { agent: agentDef(id, role) }));
  }
  applyEvent(
    state,
    evt("thread.created", {
      thread: {
        id: THREAD_ID,
        goalId: GOAL_ID,
        subject: "review round",
        initiator: "architect",
        artifactRefs: [],
        participants: [],
        depth: 1,
        messageIds: [],
        status: "OPEN",
        budget: {},
        createdAt: "2026-01-01T00:00:00.000Z",
      } as Thread,
    }),
  );
  return state;
}

/**
 * Export, through JSON, and back — the trip the SnapshotStore actually makes.
 * Restoring into a FRESH state is deliberate: that is the cold-boot path, and
 * it is the one where anything the codec drops is gone rather than merely
 * stale.
 */
function roundTrip(state: Projections): Projections {
  const snapshot = JSON.parse(JSON.stringify(exportState(state))) as Parameters<typeof importState>[1];
  const restored = createInitialState();
  importState(restored, snapshot);
  return restored;
}

// --- unread mail -----------------------------------------------------------

test("a snapshot carries unread mail, because the tail replay can never put it back", () => {
  const state = seed();
  applyEvent(state, evt("message.sent", { message: message({ id: "m-1", from: "architect", to: ["dev"], type: "INFORM" }) }, { actorId: "architect" }));
  applyEvent(state, evt("message.sent", { message: message({ id: "m-2", from: "qa", to: ["dev"], type: "INFORM" }) }, { actorId: "qa" }));
  applyEvent(state, evt("message.sent", { message: message({ id: "m-3", from: "dev", to: ["qa"], type: "INFORM" }) }, { actorId: "dev" }));

  const restored = roundTrip(state);

  assert.deepEqual(restored.unread.get("dev"), ["m-1", "m-2"], "the box survives, in order");
  assert.deepEqual(restored.unread.get("qa"), ["m-3"]);
  // A box of ids is only mail if the ids still resolve, so the message bodies
  // have to come back with it.
  assert.equal(restored.messages.get("m-1")?.from, "architect");
  assert.equal(restored.messages.get("m-2")?.from, "qa");
});

test("a restored mailbox and its mailboxDepth agree, even when the snapshot's copy disagrees", () => {
  const state = seed();
  applyEvent(state, evt("message.sent", { message: message({ id: "m-a", from: "architect", to: ["dev"], type: "INFORM" }) }, { actorId: "architect" }));
  applyEvent(state, evt("message.sent", { message: message({ id: "m-b", from: "architect", to: ["dev"], type: "INFORM" }) }, { actorId: "architect" }));

  assert.deepEqual(roundTrip(state).unread.get("dev"), ["m-a", "m-b"]);
  assert.equal(roundTrip(state).agents.get("dev")!.state.mailboxDepth, 2, "depth mirrors the restored box");

  // `mailboxDepth` rides along inside the agent record, so it is restored
  // whatever the box does. This is the snapshot every mesh on disk today has:
  // agent records that claim a mailbox, written before `unread` was carried.
  // The prompt renders that number to the agent as `mailbox=N`, so a depth with
  // no mail behind it tells a seat it has been sent something it cannot read.
  const legacy = JSON.parse(JSON.stringify(exportState(state))) as Record<string, unknown>;
  delete legacy.unread;
  const restored = createInitialState();
  importState(restored, legacy as Parameters<typeof importState>[1]);

  assert.deepEqual(restored.unread.get("dev") ?? [], [], "nothing invented to fill the box");
  assert.equal(restored.agents.get("dev")!.state.mailboxDepth, 0, "the depth is re-derived from the box, not trusted");
});

test("an obligation and the message that opened it survive a restore together", () => {
  const state = seed();
  applyEvent(
    state,
    evt("message.sent", { message: message({ id: "m-ask", from: "architect", to: ["dev"], type: "REQUEST_REVIEW" }) }, { actorId: "architect" }),
  );
  assert.ok(state.pendingRequests.has("m-ask"), "precondition: the ask is on the ledger");

  const restored = roundTrip(state);

  // `pendingRequests` was already exported while `unread` was not, so a restore
  // used to keep the debt and drop the mail: the debtor was nudged forever for
  // an ask that was no longer in its inbox to answer.
  assert.ok(restored.pendingRequests.has("m-ask"), "the debt survives");
  assert.deepEqual(restored.unread.get("dev"), ["m-ask"], "and so does the ask it was opened by");
});

test("a restored mailbox is still drained by delivery, not stuck", () => {
  const state = seed();
  applyEvent(state, evt("message.sent", { message: message({ id: "m-x", from: "qa", to: ["dev"], type: "INFORM" }) }, { actorId: "qa" }));

  const restored = roundTrip(state);
  assert.deepEqual(restored.unread.get("dev"), ["m-x"], "precondition: the mail came back");
  applyEvent(restored, evt("message.delivered", { agentId: "dev", messageId: "m-x" }, { actorId: "dev" }));

  assert.deepEqual(restored.unread.get("dev"), [], "restored ids are ordinary mail: the reducer removes them");
  assert.equal(restored.agents.get("dev")!.state.mailboxDepth, 0);
});

test("importState screens a corrupt mailbox rather than loading it", () => {
  const state = createInitialState();
  importState(state, {
    // `m-ok` has to be in `messages` for this test to be about corruption:
    // the import also drops ids with no message behind them, and without this
    // the surviving id would be testing that screen instead of this one.
    messages: [message({ id: "m-ok", from: "qa", to: ["dev"], type: "INFORM" })],
    unread: [
      ["dev", ["m-ok", 7 as unknown as string, null as unknown as string]],
      [42 as unknown as string, ["m-nope"]],
      ["qa", "not-an-array" as unknown as string[]],
    ],
  } as unknown as Parameters<typeof importState>[1]);

  assert.deepEqual(state.unread.get("dev"), ["m-ok"], "ids that are not strings resolve to no message, so they are dropped");
  assert.equal(state.unread.has("qa"), false);
  assert.equal(state.unread.size, 1, "a non-string agent key is not a mailbox");
  // Corrupt or truncated, the operator-visible fact is the same: two things in
  // dev's box will never be read by anyone. Counting both through one counter
  // is deliberate — an uncounted drop is the failure mode, not a miscategorised
  // one.
  assert.equal(state.mailOverflowDropped.get("dev"), 2, "the two unreadable ids are counted as loss");
});

// --- the single-writer invariant ------------------------------------------

test("an unreleased lease still blocks a second agent after a restore", () => {
  const state = createInitialState();
  applyEvent(state, evt("lease.acquired", { lease: lease({ id: "lease-1", agentId: "dev" }) }, { actorId: "dev" }));
  assert.equal(state.activeLeaseByArtifact.get(ARTIFACT_ID), "lease-1", "precondition: the live index holds it");

  const restored = roundTrip(state);

  // Derived from the exported leases rather than exported itself — but it has
  // to BE there, because this index is the single-writer invariant. With it
  // missing, `lease.acquired` sees no holder and hands the artifact to the
  // second asker while the first is still writing to it.
  assert.equal(restored.activeLeaseByArtifact.get(ARTIFACT_ID), "lease-1");
  assert.throws(
    () => applyEvent(restored, evt("lease.acquired", { lease: lease({ id: "lease-2", agentId: "qa" }) }, { actorId: "qa" })),
    /single-writer invariant/,
    "a second agent must still be refused after a restart",
  );
});

test("a released lease does not block after a restore", () => {
  const state = createInitialState();
  applyEvent(state, evt("lease.acquired", { lease: lease({ id: "lease-1", agentId: "dev" }) }, { actorId: "dev" }));
  applyEvent(state, evt("lease.released", { leaseId: "lease-1" }, { actorId: "dev" }));

  const restored = roundTrip(state);

  assert.equal(restored.activeLeaseByArtifact.has(ARTIFACT_ID), false, "a released lease is not an active one");
  applyEvent(restored, evt("lease.acquired", { lease: lease({ id: "lease-2", agentId: "qa" }) }, { actorId: "qa" }));
  assert.equal(restored.activeLeaseByArtifact.get(ARTIFACT_ID), "lease-2", "the next agent may take it");
});

test("the derived indexes are rebuilt on import, not left empty", () => {
  const state = createInitialState();
  const art = { id: ARTIFACT_ID, name: "api.ts", type: "code", version: 2 } as unknown as Artifact;
  state.artifacts.set(ARTIFACT_ID as never, art);
  state.leases.set("lease-1" as never, lease({ id: "lease-1", agentId: "dev" }));

  const restored = roundTrip(state);

  // Every key the parity guard below calls "derived on import" is asserted
  // here, so the classification is a claim the suite checks rather than a
  // comment that can quietly stop being true.
  assert.equal(restored.artifactByName.get("code:api.ts")?.id, ARTIFACT_ID);
  assert.deepEqual(restored.artifactHistory.get(ARTIFACT_ID as never)?.map((a) => a.id), [ARTIFACT_ID]);
  assert.equal(restored.activeLeaseByArtifact.get(ARTIFACT_ID), "lease-1");
});

// --- danglers left behind by a truncating export ---------------------------

/**
 * `exportMessages` caps the history and partitions by what is OWED first, but
 * `keptOwed` is itself a `slice(-cap)`: with enough seats at their unread cap,
 * owed mail alone overruns the budget and the codec drops some. The ids stay
 * in `unread`, so the box comes back holding pointers to nothing.
 *
 * Simulated here by emptying `messages` in the snapshot rather than by sending
 * 2000+ messages, because what is under test is the import screen, and the
 * snapshot shape it has to cope with is the same one either way.
 */
test("a mailbox id the snapshot no longer carries is dropped, not left dangling", () => {
  const state = seed();
  applyEvent(state, evt("message.sent", { message: message({ id: "m-gone", from: "architect", to: ["dev"], type: "INFORM" }) }, { actorId: "architect" }));
  assert.deepEqual(state.unread.get("dev"), ["m-gone"], "precondition: it is in the box");

  const snapshot = JSON.parse(JSON.stringify(exportState(state))) as Parameters<typeof importState>[1];
  (snapshot as { messages: unknown[] }).messages = [];

  const restored = createInitialState();
  importState(restored, snapshot);

  assert.deepEqual(restored.unread.get("dev"), [], "a pointer to no message is not mail");
  // The depth is what the agent is shown as `mailbox=N` and what the scheduler
  // wakes on. Left dangling, it buys a turn that renders zero messages.
  assert.equal(restored.agents.get("dev")?.state.mailboxDepth, 0, "and the depth agrees with the box");
  // Dropping it does not recover the mail, so the drop is a real loss and gets
  // counted like every other one.
  assert.equal(restored.mailOverflowDropped.get("dev"), 1, "the loss is counted, not silent");
});

test("a dangler is added to the overflow count the snapshot already carried", () => {
  const state = seed();
  applyEvent(state, evt("message.sent", { message: message({ id: "m-gone-2", from: "architect", to: ["dev"], type: "INFORM" }) }, { actorId: "architect" }));

  const snapshot = JSON.parse(JSON.stringify(exportState(state))) as Parameters<typeof importState>[1];
  (snapshot as { messages: unknown[] }).messages = [];
  // A mesh that had already dropped mail to the cap before it was snapshotted.
  (snapshot as { mailOverflowDropped: unknown[] }).mailOverflowDropped = [["dev", 5]];

  const restored = createInitialState();
  importState(restored, snapshot);

  // 6, not 1 and not 5: the two counts are the same fact about the same box,
  // and whichever of the two loaders ran second must not erase the other.
  assert.equal(restored.mailOverflowDropped.get("dev"), 6);
});

// --- the guard -------------------------------------------------------------

/**
 * A key exported under a different name. `exportState` publishes the seq
 * watermark as `throughSeq` because that is what the kernel and the snapshot
 * envelope call it; it is a rename, not an omission.
 */
const EXPORTED_AS: Partial<Record<keyof Projections, string>> = {
  lastEventSeq: "throughSeq",
};

/**
 * Keys `importState` rebuilds from something the snapshot already carries.
 * Exporting these would be storing the same fact twice and inviting the two
 * copies to disagree — but each one has to be genuinely rebuilt, which the
 * test above asserts.
 */
const DERIVED_ON_IMPORT: Partial<Record<keyof Projections, string>> = {
  artifactByName: "rebuilt from the exported artifacts, keyed by artifactKey(type, name).",
  artifactHistory: "rebuilt from the exported artifacts, degraded to latest-only: a snapshot keeps the current version of each artifact, not every version it passed through.",
  activeLeaseByArtifact: "rebuilt from the exported leases whose releasedAt is unset; it is only ever an index into them.",
};

/**
 * Keys deliberately NOT snapshotted, each with the reason losing it is
 * acceptable. Anything not on this list, not exported and not derived is a
 * projection the mesh silently forgets on every restart.
 */
const NOT_SNAPSHOTTED: Partial<Record<keyof Projections, string>> = {
  lastEventAt: "written by applyEvent for EVERY event, so the next event of any kind restores it; until then a restored mesh reports no last-activity time.",
  progress: "a pure function of the exported goal's acceptance criteria; recomputed by recomputeGoalProgress on the next progress event. Derivable on import if the gap ever matters.",
  sessionMap: "per-process by design: backend session ids live durably in sessions.json, and the supervisor already falls back to that registry when the map is empty.",
  messageFingerprints: "loop-detection memory, not a delivery dedup guard. Losing it can cost one un-flagged repeat after a restart; it can never cause a message to be dropped or delivered twice.",
  goalHistory: "a lossy audit trail. Only the most recent entry carrying a reason is read (run-report), and the goal's own status is exported.",
  eventsSinceActivation: "write-only today: incremented by applyEvent and reset by agent.awakened, read by nothing. Dead weight, so there is nothing to lose.",
  turnAudit: "declared and initialised, never written and never read. Dead code; snapshotting an empty map would only make it look alive.",
};

test("every Projections key is exported, derived on import, or explicitly not snapshotted", () => {
  const keys = Object.keys(createInitialState()) as Array<keyof Projections>;
  const exported = new Set(Object.keys(exportState(createInitialState())));

  for (const key of keys) {
    const accounted =
      exported.has(key) || key in EXPORTED_AS || key in DERIVED_ON_IMPORT || key in NOT_SNAPSHOTTED;
    assert.ok(
      accounted,
      `Projections key "${key}" is not in the snapshot codec.\n` +
        `A production mesh restores from the snapshot and replays only events ABOVE throughSeq, so this key is lost on every restart.\n` +
        `Either export it in exportState/importState, derive it on import, or add it to NOT_SNAPSHOTTED in this file with the reason losing it is acceptable.`,
    );
  }
});

test("the parity allow-lists cannot rot", () => {
  const keys = new Set(Object.keys(createInitialState()));
  const exported = new Set(Object.keys(exportState(createInitialState())));
  const lists: Array<[string, Partial<Record<keyof Projections, string>>]> = [
    ["EXPORTED_AS", EXPORTED_AS],
    ["DERIVED_ON_IMPORT", DERIVED_ON_IMPORT],
    ["NOT_SNAPSHOTTED", NOT_SNAPSHOTTED],
  ];

  const seen = new Map<string, string>();
  for (const [name, list] of lists) {
    for (const [key, reason] of Object.entries(list)) {
      // A key renamed out of Projections leaves a stale excuse behind, and a
      // stale excuse is how the next omission gets waved through.
      assert.ok(keys.has(key), `${name} lists "${key}", which is no longer a Projections key`);
      assert.ok(String(reason).length > 0, `${name}."${key}" needs a reason`);
      const already = seen.get(key);
      assert.equal(already, undefined, `"${key}" is in both ${already} and ${name}; it can only be one`);
      seen.set(key, name);
    }
  }

  // Once a key IS exported, its excuse has to go: leaving it listed would let a
  // later removal from the codec pass as "deliberate".
  for (const name of ["DERIVED_ON_IMPORT", "NOT_SNAPSHOTTED"] as const) {
    const list = name === "DERIVED_ON_IMPORT" ? DERIVED_ON_IMPORT : NOT_SNAPSHOTTED;
    for (const key of Object.keys(list)) {
      assert.equal(exported.has(key), false, `${name} lists "${key}", but exportState now writes it — drop the entry`);
    }
  }

  // And nothing may appear in the snapshot that no projection key explains.
  const aliases = new Set(Object.values(EXPORTED_AS));
  for (const key of exported) {
    assert.ok(
      keys.has(key) || aliases.has(key),
      `exportState writes "${key}", which is not a Projections key and not declared in EXPORTED_AS`,
    );
  }
});

/**
 * Named rather than counted: a count test fails on every addition and teaches
 * the next person to bump the number. These are the keys whose loss has been
 * paid for at least once.
 */
const MUST_SURVIVE = [
  "agents",
  "messages",
  "unread",
  "pendingRequests",
  "leases",
  "refusedSends",
  "deniedActions",
  "mailOverflowDropped",
] as const;

/** Maps and arrays both, so ask each for its own count rather than guessing. */
function count(v: unknown): number {
  if (v instanceof Map) return v.size;
  if (Array.isArray(v)) return v.length;
  return -1;
}

/**
 * A mesh where every key in {@link MUST_SURVIVE} holds something, each filled
 * the way production fills it — through `applyEvent`, never by reaching into
 * the state. A hand-built fixture proves the codec can carry a shape; only the
 * reducers prove it carries the shape the mesh actually produces.
 */
function populated(): Projections {
  const state = seed(); // agents, and one open thread

  // messages + unread + pendingRequests: one ask, left unanswered so the
  // commitment ledger has an entry too.
  applyEvent(
    state,
    evt("message.sent", { message: message({ id: "m-owed", from: "architect", to: ["dev"], type: "REQUEST_REVIEW" }) }, { actorId: "architect" }),
  );

  // leases
  applyEvent(state, evt("lease.acquired", { lease: lease({ id: "lease-live", agentId: "dev" }) }, { actorId: "dev" }));

  // Both halves of the overloaded rejection event, which land in two separate
  // rings: a refusal that named recipients, and a denial that named an action.
  applyEvent(state, evt("message.rejected", { from: "qa", to: ["dev"], type: "INFORM", reason: "policy refused it", ruleId: "rule-7" }, { actorId: "qa" }));
  applyEvent(
    state,
    evt("message.rejected", { from: "qa", action: "claim task", subject: "task-9", reason: "missing capability test.execute", decision: "DENY" }, { actorId: "qa" }),
  );

  // mailOverflowDropped: driven over the cap rather than set, because the
  // counter only exists on the path where the cap actually drops mail.
  for (let i = 0; i <= MAX_UNREAD_PER_AGENT; i++) {
    applyEvent(state, evt("message.sent", { message: message({ from: "architect", to: ["qa"], type: "INFORM" }) }, { actorId: "architect" }));
  }

  return state;
}

/**
 * Presence is not carriage.
 *
 * This test used to read `Object.keys(exportState(createInitialState()))` — an
 * EMPTY state, checked for key presence — and that is a weaker guard than it
 * looks. `unread: []` hard-wired into `exportState` passes it: the key is
 * there on every snapshot, and every snapshot is empty. Which is the exact bug
 * the file exists to stop recurring, arriving by the one route the guard
 * against it could not see. A key present and empty is the same restart-shaped
 * hole as a key absent, and it is considerably harder to notice, because the
 * snapshot looks well-formed and the mesh boots.
 *
 * So build a state where each key holds something, assert it does — the
 * precondition IS the vacuity check, and without it a reducer that quietly
 * stopped populating a key would turn this test green by emptying both sides —
 * and then assert the contents survive the trip.
 *
 * Counts rather than deep equality on purpose. The keys above are Maps, arrays
 * and one counter map, and the failure being caught is "arrived empty", which
 * a count states exactly and shape-agnostically. What each key's contents must
 * look like on the far side is the job of the tests above, which assert
 * ordering, lease identity and ledger entries individually.
 */
test("the keys the codec must carry survive a round trip with their contents", () => {
  const state = populated();

  for (const key of MUST_SURVIVE) {
    assert.ok(
      count(state[key]) > 0,
      `precondition: nothing filled "${key}", so this test would pass on an empty snapshot. Fix populated(), not the assertion.`,
    );
  }

  const restored = roundTrip(state);

  for (const key of MUST_SURVIVE) {
    assert.equal(
      count(restored[key]),
      count(state[key]),
      `"${key}" did not survive the snapshot: ${count(state[key])} in, ${count(restored[key])} out.\n` +
        `A key hard-wired to an empty collection in exportState is the same restart-shaped hole as a key the codec never had.`,
    );
  }
});
