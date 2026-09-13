import { test } from "node:test";
import assert from "node:assert/strict";
import { EVENT_TYPES, validateEvent, type EventType } from "../../packages/protocol/src/index";

/**
 * `EventType` (a TS union) and `EVENT_TYPES` (the array that feeds the AJV
 * enum) are both hand-maintained, and nothing but this test couples them.
 *
 * The failure they guard against is not a compile error. `MemoryEventStore`
 * does NOT validate, only `JsonlEventStore` does — so a type added to the union
 * and forgotten in the array passes every in-memory test in the suite and then
 * throws on the first real emit against a file-backed store. The reverse
 * (array entry with no union member) silently un-types every payload.
 */
test("event catalog: EVENT_TYPES and the EventType union are the same set", () => {
  // Exhaustive by construction: a union member missing here is a compile error,
  // so this map cannot drift without someone noticing.
  const fromUnion: Record<EventType, true> = {
    "goal.created": true,
    "goal.budget_changed": true,
    "goal.status_changed": true,
    "goal.paused": true,
    "goal.resumed": true,
    "goal.progress": true,
    "goal.completed": true,
    "goal.reopened": true,
    "goal.escalated": true,
    "goal.failed": true,
    "requirements.created": true,
    "requirement.blocked": true,
    "requirement.satisfied": true,
    "agent.created": true,
    "agent.started": true,
    "agent.awakened": true,
    "agent.state_changed": true,
    "agent.suspended": true,
    "agent.resumed": true,
    "agent.completed": true,
    "agent.failed": true,
    "agent.restarted": true,
    "agent.replaced": true,
    "thread.created": true,
    "message.sent": true,
    "message.delivered": true,
    "message.rejected": true,
    "artifact.created": true,
    "artifact.versioned": true,
    "artifact.transition": true,
    "task.created": true,
    "task.claimed": true,
    "task.completed": true,
    "review.requested": true,
    "review.approved": true,
    "review.rejected": true,
    "patch.created": true,
    "patch.ready": true,
    "patch.merged": true,
    "architecture.approved": true,
    "design.question": true,
    "dependency.changed": true,
    "authentication.changed": true,
    "authorization.changed": true,
    "release.candidate": true,
    "release.transition": true,
    "release.accepted": true,
    "research.requested": true,
    "research.completed": true,
    "implementation.completed": true,
    "decision.proposed": true,
    "decision.ratified": true,
    "escalation.requested": true,
    "escalation.responded": true,
    "escalation.auto_resolved": true,
    "deadlock.auto_resolved": true,
    "commitment.discharged": true,
    "human.input": true,
    "lease.acquired": true,
    "lease.released": true,
    "memory.updated": true,
    "plan.updated": true,
    "plan.gate_rejected": true,
    "budget.reserved": true,
    "budget.consumed": true,
    "budget.exceeded": true,
    "budget.released": true,
    "budget.limit_raised": true,
  };

  const inArray = new Set<string>(EVENT_TYPES);
  const inUnion = new Set<string>(Object.keys(fromUnion));
  assert.deepEqual(
    [...inUnion].filter((t) => !inArray.has(t)).sort(),
    [],
    "declared in the EventType union but missing from EVENT_TYPES — AJV will reject it on the first emit to a JsonlEventStore",
  );
  assert.deepEqual(
    [...inArray].filter((t) => !inUnion.has(t)).sort(),
    [],
    "listed in EVENT_TYPES but absent from the EventType union — its payload is untyped everywhere",
  );
});

test("event catalog: a plan.updated event validates against the emitted schema", () => {
  const res = validateEvent({
    id: "evt-plan-1",
    type: "plan.updated",
    timestamp: new Date(0).toISOString(),
    actorId: "dev",
    payload: {
      agentId: "dev",
      plan: {
        taskId: "task-1",
        revision: 1,
        updatedAt: new Date(0).toISOString(),
        steps: [{ id: "s1", text: "write the patch", status: "PENDING", capabilities: ["repository.write"] }],
      },
    },
  });
  assert.equal(res.valid, true, `plan.updated must validate: ${JSON.stringify(res.errors)}`);
});

test("event catalog: an unknown event type is still rejected", () => {
  const res = validateEvent({
    id: "evt-x", type: "plan.invented", timestamp: new Date(0).toISOString(), actorId: "dev", payload: {},
  });
  assert.equal(res.valid, false, "the enum must stay closed — an open one makes every typo a silent no-op");
});
