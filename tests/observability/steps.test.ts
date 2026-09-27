import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTurnSteps } from "../../packages/observability/src/index";
import type { MeshEvent } from "../../packages/protocol/src/index";

function event(seq: number, type: string, payload: Record<string, unknown>): MeshEvent {
  return {
    id: `e${seq}`,
    seq,
    type,
    at: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
    actor: "backend",
    payload,
  } as unknown as MeshEvent;
}

function awakened(seq = 1): MeshEvent {
  return event(seq, "agent.awakened", { agentId: "backend", turnId: "turn-1", reason: { kind: "message" } });
}

/** `budget.consumed` as the kernel emits it: the split is in the consume detail. */
function consume(seq: number, p: Record<string, unknown>): MeshEvent {
  return event(seq, "budget.consumed", { turnId: "turn-1", key: "agent:g/backend", amount: 1100, ...p });
}

test("a replayed turn carries the split the consume event recorded", () => {
  // The figures are in the log the whole time; before this they were read for
  // `amount` alone and thrown away.
  const steps = buildTurnSteps([
    awakened(),
    consume(2, { input: 1000, output: 100, cacheRead: 7000, model: "claude-opus-5" }),
  ]);
  assert.equal(steps.length, 1);
  const s = steps[0]!;
  assert.equal(s.tokens, 1100);
  assert.equal(s.tokensInput, 1000);
  assert.equal(s.tokensOutput, 100);
  assert.equal(s.tokensCacheRead, 7000);
  assert.equal(s.model, "claude-opus-5");
});

test("the thinking share of a turn's output survives the log, and its absence survives too", () => {
  // Thinking is billed inside `output`, so a step that shows 100 written tokens
  // cannot say whether the seat wrote or deliberated. When the backend reports
  // the split it rides the same consume payload as the rest.
  const told = buildTurnSteps([awakened(), consume(2, { input: 1000, output: 100, cacheRead: 7000, thinking: 60 })]);
  assert.equal(told[0]!.tokensThinking, 60);

  // And when it does not, the field stays absent. A 0 here would assert a turn
  // deliberated for free, which is a claim no measurement supports.
  const silent = buildTurnSteps([awakened(), consume(2, { input: 1000, output: 100, cacheRead: 7000 })]);
  assert.equal(silent[0]!.tokensThinking, undefined);
});

test("a consume that reports no split leaves the fields absent, not zero", () => {
  // A backend that says nothing must not read as "this turn read nothing
  // uncached" — the same absence discipline the ledger parser needs.
  const steps = buildTurnSteps([awakened(), consume(2, {})]);
  const s = steps[0]!;
  assert.equal(s.tokens, 1100);
  assert.equal(s.tokensInput, undefined);
  assert.equal(s.tokensOutput, undefined);
  assert.equal(s.tokensCacheRead, undefined);
});

test("mission-keyed consumes mirror the agent one and are not counted twice", () => {
  const steps = buildTurnSteps([
    awakened(),
    consume(2, { input: 1000, output: 100, cacheRead: 7000 }),
    event(3, "budget.consumed", {
      turnId: "turn-1",
      key: "mission:g",
      amount: 1100,
      input: 1000,
      output: 100,
      cacheRead: 7000,
    }),
  ]);
  const s = steps[0]!;
  assert.equal(s.tokens, 1100);
  assert.equal(s.tokensInput, 1000);
  assert.equal(s.tokensOutput, 100);
  assert.equal(s.tokensCacheRead, 7000);
});

test("a second agent consume accumulates its split, as the total does", () => {
  const steps = buildTurnSteps([
    awakened(),
    consume(2, { input: 1000, output: 100, cacheRead: 7000 }),
    consume(3, { amount: 550, input: 500, output: 50, cacheRead: 3000 }),
  ]);
  const s = steps[0]!;
  assert.equal(s.tokens, 1650);
  assert.equal(s.tokensInput, 1500);
  assert.equal(s.tokensOutput, 150);
  assert.equal(s.tokensCacheRead, 10000);
});

/**
 * A side effect as the kernel records it inside a turn: the actor on the
 * envelope, the turn as its correlation id (the kernel's `correlate` hook fills
 * that for every emit while the turn runs).
 */
function effect(seq: number, type: string, payload: Record<string, unknown> = {}, env: Partial<MeshEvent> = {}): MeshEvent {
  return { ...event(seq, type, payload), actorId: "backend", correlationId: "turn-1", ...env } as MeshEvent;
}

function closed(seq: number): MeshEvent {
  return effect(seq, "agent.state_changed", { agentId: "backend", to: "IDLE", turnId: "turn-1" });
}

test("each side effect lands in its own ops bucket", () => {
  // The dashboard labels a turn from these four numbers alone, so a missing
  // bucket is not a cosmetic gap: an approval that counted nowhere once filed
  // real review work as a turn that wrote nothing.
  const steps = buildTurnSteps([
    awakened(),
    effect(2, "message.sent", { message: { id: "msg-1" } }),
    effect(3, "artifact.created", { artifact: { id: "art-1" } }),
    effect(4, "artifact.versioned", { artifact: { id: "art-1" } }),
    effect(5, "task.created"),
    effect(6, "task.claimed"),
    effect(7, "task.completed"),
    effect(8, "decision.proposed"),
    effect(9, "review.approved"),
    effect(10, "review.rejected"),
    effect(11, "requirement.satisfied"),
    effect(12, "architecture.approved"),
    effect(13, "artifact.transition"),
    closed(14),
  ]);
  assert.equal(steps.length, 1);
  const s = steps[0]!;
  assert.deepEqual(s.ops, { messages: 1, artifacts: 2, tasks: 3, decisions: 6 });
  assert.deepEqual(s.messageIds, ["msg-1"]);
  assert.deepEqual(s.artifactIds, ["art-1", "art-1"], "a new version is a second write of the same artifact");
  assert.equal(s.status, "ok");
  assert.equal(s.seqStart, 1);
  assert.equal(s.seqEnd, 14);
  assert.equal(s.eventCount, 14);
});

test("a derived transition belongs to the turn but is not a decision", () => {
  // Requesting a review moves the artifact, and the supervisor logs that move a
  // second time as a `derived` transition. An architect who asked for four
  // reviews read "8 decisions" live with no decision event anywhere in its log.
  const steps = buildTurnSteps([
    awakened(),
    effect(2, "review.requested", { artifactId: "art-1" }),
    effect(3, "artifact.transition", { artifactId: "art-1", to: "UNDER_REVIEW", derived: true }),
    effect(4, "artifact.transition", { artifactId: "art-2", to: "APPROVED" }),
    closed(5),
  ]);
  const s = steps[0]!;
  assert.equal(s.ops?.decisions, 1, "only the explicit move is the seat's own decision");
  assert.equal(s.seqEnd, 5);
  assert.equal(s.eventCount, 4, "the mirror still belongs to the turn's events");
});

test("events outside the four buckets are not counted as output", () => {
  // `review.requested` and `patch.created` are derived by the supervisor from a
  // send or a publish that has already been counted; counting them again would
  // double every such turn.
  const steps = buildTurnSteps([
    awakened(),
    effect(2, "review.requested"),
    effect(3, "patch.created"),
    effect(4, "message.delivered"),
    closed(5),
  ]);
  assert.deepEqual(steps[0]!.ops, { messages: 0, artifacts: 0, tasks: 0, decisions: 0 });
});

test("a turn that did nothing carries measured zeros, not an absence", () => {
  // Built from events, so zero is a reading. Only a step with no log behind it
  // may leave `ops` out.
  const steps = buildTurnSteps([awakened(), closed(2)]);
  assert.deepEqual(steps[0]!.ops, { messages: 0, artifacts: 0, tasks: 0, decisions: 0 });
});

test("an uncorrelated side effect goes to the actor's running turn, and not after it closes", () => {
  // Older logs, and emits made outside the correlate hook, carry no turn id; the
  // actor's open turn is the only attribution left. Once that turn has closed
  // there is no running turn to charge, so the event is left out.
  const steps = buildTurnSteps([
    awakened(),
    effect(2, "artifact.created", { artifact: { id: "art-1" } }, { correlationId: undefined }),
    closed(3),
    effect(4, "artifact.created", { artifact: { id: "art-2" } }, { correlationId: undefined }),
  ]);
  const s = steps[0]!;
  assert.equal(s.ops?.artifacts, 1);
  assert.deepEqual(s.artifactIds, ["art-1"]);
});

test("a correlated side effect is charged to its turn even when another actor emitted it", () => {
  // `auditTransition` records a transition as `system` but correlates it to the
  // reviewer's turn that caused it; the turn id decides, not the actor.
  const steps = buildTurnSteps([
    awakened(),
    effect(2, "artifact.transition", {}, { actorId: "system" }),
    closed(3),
  ]);
  assert.equal(steps[0]!.ops?.decisions, 1);
});
