import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fillTurnSteps,
  mergeTurnSteps,
  recentTurnSteps,
  stepWindow,
  turnEvents,
  type StepEventReader,
} from "../../apps/mesh-server/src/steps-view";
import { buildTurnSteps, type TurnStep } from "../../packages/observability/src/index";
import type { TurnRecord } from "../../packages/core/src/index";
import { MemoryEventStore, type EventQuery } from "../../packages/event-store/src/index";
import type { MeshEvent } from "../../packages/protocol/src/index";

function step(over: Partial<TurnStep> = {}): TurnStep {
  return {
    turnId: "turn-1",
    agentId: "backend",
    reasonKind: "message",
    startedAt: "2026-01-01T00:00:00.000Z",
    status: "running",
    lifecycle: "IDLE",
    ops: { messages: 0, artifacts: 0, tasks: 0, decisions: 0 },
    messageIds: [],
    artifactIds: [],
    tokens: 0,
    seqStart: 0,
    seqEnd: 0,
    eventCount: 0,
    ...over,
  };
}

function record(over: Record<string, unknown> = {}): TurnRecord {
  return {
    turnId: "turn-1",
    agentId: "backend",
    reason: { kind: "message" },
    startedAt: "2026-01-01T00:00:01.000Z",
    status: "running",
    ...over,
  } as unknown as TurnRecord;
}

test("the split survives the merge when the live record carries none", () => {
  // The turn is in the ring, so live wins the total — but the log-derived step
  // is the only one with the split, and dropping it is what made the drawer's
  // in/out bar depend on which of the two payloads answered first.
  const merged = mergeTurnSteps(
    [step({ tokens: 500, tokensInput: 400, tokensOutput: 100, tokensCacheRead: 900 })],
    [record({ tokens: 600 })],
  );
  assert.equal(merged.length, 1);
  const m = merged[0]!;
  assert.equal(m.tokens, 600, "live total wins");
  assert.equal(m.tokensInput, 400, "and the log's split is carried, not dropped");
  assert.equal(m.tokensOutput, 100);
  assert.equal(m.tokensCacheRead, 900);
});

test("a live record's own split wins, and a reported zero is carried", () => {
  const merged = mergeTurnSteps(
    [step({ tokensInput: 400, tokensOutput: 100, tokensCacheRead: 900 })],
    [record({ tokensInput: 25, tokensOutput: 5, tokensCacheRead: 0 })],
  );
  const m = merged[0]!;
  assert.equal(m.tokensInput, 25);
  assert.equal(m.tokensOutput, 5);
  assert.equal(m.tokensCacheRead, 0, "a reported zero is a figure, not an absence");
});

test("a live turn with no log step reports its ops as unknown, not as zero", () => {
  // Four zeros is a claim: "this turn did nothing". The tracker counts no ops,
  // so with no log step there is nothing to claim, and the dashboard read the
  // invented zeros as a refused turn.
  const [m] = mergeTurnSteps([], [record({ status: "ok", tokens: 900 })]);
  assert.equal(m!.ops, undefined);
  assert.equal(m!.tokens, 900, "what the tracker did measure still comes through");

  // With a log step, its counts are carried, zeros included.
  const [n] = mergeTurnSteps([step({ ops: { messages: 0, artifacts: 3, tasks: 0, decisions: 1 } })], [record()]);
  assert.deepEqual(n!.ops, { messages: 0, artifacts: 3, tasks: 0, decisions: 1 });
});

// ---------------------------------------------------------------- the fill

const T0 = Date.UTC(2026, 0, 1);

/** A schema-valid event for the real store; the store assigns `seq`. */
function ev(type: string, payload: Record<string, unknown>, env: Partial<MeshEvent> = {}): MeshEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2)}`,
    type,
    timestamp: new Date(T0).toISOString(),
    payload,
    ...env,
  } as MeshEvent;
}

/**
 * One whole architect turn as the supervisor logs it: opened, two sends, four
 * publishes, one approval, closed, every emit correlated to the turn.
 */
async function architectTurn(store: MemoryEventStore, turnId: string): Promise<void> {
  const env = { actorId: "architect", correlationId: turnId };
  await store.append(ev("agent.awakened", { agentId: "architect", turnId, reason: { kind: "message" } }, env));
  await store.append(ev("agent.state_changed", { agentId: "architect", to: "OBSERVING", turnId }, env));
  for (const i of [1, 2]) await store.append(ev("message.sent", { message: { id: `msg-${i}` } }, env));
  for (const i of [1, 2, 3, 4]) await store.append(ev("artifact.created", { artifact: { id: `art-${i}` } }, env));
  await store.append(ev("review.approved", {}, env));
  await store.append(ev("agent.state_changed", { agentId: "architect", to: "IDLE", turnId }, env));
}

/** Uncorrelated traffic that pushes a turn out of the tail window. */
async function noise(store: MemoryEventStore, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await store.append(ev("goal.progress", { i }, { actorId: "system" }));
}

/** Records every query, so a test can say which turns were re-read. */
function spy(store: MemoryEventStore): StepEventReader & { queries: EventQuery[] } {
  const queries: EventQuery[] = [];
  return {
    queries,
    read: (q?: EventQuery) => {
      queries.push(q ?? {});
      return store.read(q);
    },
  };
}

test("a ring turn older than the tail window gets its real counts from the index", async () => {
  // The live bug: the tracker ring still held the turn, the tail scan did not
  // reach it, and the merge invented `{0,0,0,0}`. The same turn read 8/8/0/8 at
  // `?limit=200` and 0/0/0/0 at `?limit=60`.
  const store = new MemoryEventStore();
  await architectTurn(store, "turn-old");
  await noise(store, stepWindow(10) + 50);

  // Precondition, or this test proves nothing: the window really misses it.
  const window = await store.read({ tail: stepWindow(10) });
  assert.equal(buildTurnSteps(window, 20).length, 0, "the tail window must not reach the turn");
  assert.equal(mergeTurnSteps([], [record({ turnId: "turn-old", agentId: "architect" })])[0]!.ops, undefined);

  const steps = await recentTurnSteps(store, [record({ turnId: "turn-old", agentId: "architect", status: "ok" })], 10);
  assert.equal(steps.length, 1);
  const s = steps[0]!;
  assert.deepEqual(s.ops, { messages: 2, artifacts: 4, tasks: 0, decisions: 1 });
  assert.deepEqual(s.messageIds, ["msg-1", "msg-2"]);
  assert.deepEqual(s.artifactIds, ["art-1", "art-2", "art-3", "art-4"]);
  assert.equal(s.seqStart, 1);
  assert.equal(s.seqEnd, 10);
  assert.equal(s.eventCount, 10);
  assert.equal(s.lifecycle, "IDLE");
  assert.equal(s.status, "ok");
});

test("the answer no longer depends on how far back the query looked", async () => {
  // Two limits, two window sizes, one turn: the counts must agree.
  const store = new MemoryEventStore();
  await architectTurn(store, "turn-old");
  await noise(store, 900);
  const live = [record({ turnId: "turn-old", agentId: "architect", status: "ok" })];
  const narrow = await recentTurnSteps(store, live, 10);
  const wide = await recentTurnSteps(store, live, 200);
  assert.ok(stepWindow(10) < 900 && stepWindow(200) > 900, "one window misses the turn, the other reaches it");
  assert.deepEqual(narrow[0]!.ops, wide[0]!.ops);
  assert.deepEqual(narrow[0]!.ops, { messages: 2, artifacts: 4, tasks: 0, decisions: 1 });
});

test("a log-only turn straddling the window's start is rebuilt whole", async () => {
  // The window cut the turn's opening off. Its step was then opened late by the
  // closing state change, with the four publishes before it dropped and the
  // reason unknown: a partial count that looked like a real one.
  const store = new MemoryEventStore();
  await architectTurn(store, "turn-cut");
  const window = (await store.read()).slice(-1); // only the closing state change
  const partial = buildTurnSteps(window, 20)[0]!;
  assert.deepEqual(partial.ops, { messages: 0, artifacts: 0, tasks: 0, decisions: 0 }, "precondition: the window alone undercounts");

  const [s] = await fillTurnSteps(window, [], store, 20);
  assert.deepEqual(s!.ops, { messages: 2, artifacts: 4, tasks: 0, decisions: 1 });
  assert.equal(s!.reasonKind, "message");
  assert.equal(s!.seqStart, 1);
});

test("a turn the window saw whole is not re-read", async () => {
  // The index read is for what the window missed. Re-reading a whole step
  // would cost a lookup per turn and could only lose events the window
  // attributed to the running turn without a turn id.
  const store = new MemoryEventStore();
  await architectTurn(store, "turn-seen");
  const reader = spy(store);
  const steps = await recentTurnSteps(reader, [record({ turnId: "turn-seen", agentId: "architect", status: "ok" })], 10);
  assert.equal(steps[0]!.ops?.artifacts, 4);
  assert.deepEqual(
    reader.queries.filter((q) => q.correlationId !== undefined),
    [],
    "no correlation read for a turn opened inside the window",
  );
});

test("a ring turn the log has never heard of keeps its counts unknown", async () => {
  // Nothing to read, so nothing to count: `ops` stays absent rather than
  // falling back to the zeros this fix removed.
  const store = new MemoryEventStore();
  await noise(store, 5);
  const steps = await recentTurnSteps(store, [record({ turnId: "turn-ghost" })], 10);
  assert.equal(steps.length, 1);
  assert.equal(steps[0]!.ops, undefined);
});

test("filters apply before the cut, as mesh_steps always did", async () => {
  const store = new MemoryEventStore();
  await architectTurn(store, "turn-a");
  await architectTurn(store, "turn-b");
  const live = [
    record({ turnId: "turn-b", agentId: "architect", status: "ok", startedAt: "2026-01-01T00:00:02.000Z" }),
    record({ turnId: "turn-a", agentId: "architect", status: "failed", startedAt: "2026-01-01T00:00:01.000Z" }),
  ];
  const failed = await recentTurnSteps(store, live, 1, (s) => s.status === "failed");
  assert.deepEqual(failed.map((s) => s.turnId), ["turn-a"], "the older match is found, not cut off by the newer non-match");
  const newest = await recentTurnSteps(store, live, 1);
  assert.deepEqual(newest.map((s) => s.turnId), ["turn-b"]);
});

test("a turn's events come back once each, in log order", () => {
  // `/turns/:id` appended its scanned extras after the indexed events, so an
  // operator message sent mid-turn rendered after the turn had closed.
  const e = (seq: number): MeshEvent => ({ ...ev("goal.progress", {}), id: `evt-${seq}`, seq }) as MeshEvent;
  const out = turnEvents([e(1), e(3), e(5)], [e(4), e(2), e(3)]);
  assert.deepEqual(out.map((x) => x.seq), [1, 2, 3, 4, 5]);
});

test("a persisted read result's body does not ride the polled list", () => {
  // Records written before the tracker bounded op timings at write time carry
  // every successful read_artifact's whole artifact as its `reason`; on a live
  // mesh that was 93% of the /steps payload, polled every 3.5s.
  const body = "# QA evidence\n".repeat(2000);
  const merged = mergeTurnSteps([], [record({
    status: "ok",
    opTimings: [
      { op: "read_artifact", ms: 1, ok: true, reason: body },
      { op: "merge", ms: 20, ok: false, reason: "git merge failed: commit b83c898 is not in this repository" },
    ],
  })]);
  const timings = merged[0]!.opTimings!;
  assert.equal(timings.length, 2, "every op keeps its row");
  assert.equal(timings[0]!.reason, undefined, "the read's body is dropped");
  assert.equal(timings[1]!.reason, "git merge failed: commit b83c898 is not in this repository", "a refusal keeps why");
});
