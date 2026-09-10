import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEvent } from "../../packages/core/src/projections";
import { bumpConflict } from "../../packages/core/src/projections-helpers";
import { createInitialState, MAX_CONFLICTS, type Projections } from "../../packages/core/src/state";
import { PROTOCOL_VERSION, type AgentDefinition, type Goal, type MeshEvent } from "../../packages/protocol/src/index";

/**
 * The reducer cases that only ever ran incidentally, if at all: agent
 * REPLACEMENT (inheriting the dead agent's work), a requirement being BLOCKED
 * after it was satisfied, and the conflict-map eviction that keeps a looping
 * mission from growing state without bound.
 *
 * Each of these exists to make one distinction, and none of them had a direct
 * assertion — a replacement that silently dropped the inherited artifacts, or
 * a block that left `progress` reporting the old ratio, would have passed the
 * whole suite.
 */

const GOAL_ID = "goal-remainder";

let seq = 0;
function evt(type: string, payload: Record<string, unknown>, over: Partial<MeshEvent> = {}): MeshEvent {
  seq++;
  return {
    id: over.id ?? `evt-rem-${seq}`,
    protocolVersion: PROTOCOL_VERSION,
    type: type as MeshEvent["type"],
    timestamp: over.timestamp ?? `2026-04-01T00:00:${String(seq % 60).padStart(2, "0")}.000Z`,
    goalId: "goalId" in over ? over.goalId : GOAL_ID,
    actorId: over.actorId,
    seq,
    payload,
  } as MeshEvent;
}

function goal(over: Partial<Goal> = {}): Goal {
  return {
    id: GOAL_ID,
    description: "remainder mission",
    acceptanceCriteria: [
      { id: "c1", description: "first", mandatory: true, status: "UNSATISFIED", evidence: [] },
      { id: "c2", description: "second", mandatory: true, status: "UNSATISFIED", evidence: [] },
    ],
    status: "ACTIVE",
    budget: { tokens: 1000, wallClockMinutes: 10, maxEvents: 1000 },
    rootThreadId: `${GOAL_ID}-root`,
    createdAt: "2026-04-01T00:00:00.000Z",
    ...over,
  } as Goal;
}

function seeded(): Projections {
  const state = createInitialState();
  applyEvent(state, evt("goal.created", { goal: goal() }));
  return state;
}

function spawnAgent(state: Projections, id: string): void {
  applyEvent(state, evt("agent.created", { agent: { id, role: id } as AgentDefinition }));
}

// ------------------------------------------------------------- agent.replaced

test("agent.replaced: the successor inherits the dead agent's artifacts and ticket", () => {
  const state = seeded();
  spawnAgent(state, "dev");
  applyEvent(state, evt("agent.replaced", { agentId: "dev", inheritArtifactIds: ["art-1", "art-2"], inheritTaskId: "task-9" }));

  const rec = state.agents.get("dev")!;
  assert.deepEqual(rec.state.currentArtifactIds, ["art-1", "art-2"]);
  assert.equal(rec.state.activeTaskId, "task-9");
});

test("agent.replaced: an inheritance the event does not name keeps what the record already held", () => {
  const state = seeded();
  spawnAgent(state, "dev");
  applyEvent(state, evt("agent.replaced", { agentId: "dev", inheritArtifactIds: ["art-1"], inheritTaskId: "task-1" }));
  // A replacement that hands over nothing must not ERASE the handover that
  // already happened — `?? existing` is the difference between a successor
  // that keeps the work and one that starts from nothing.
  applyEvent(state, evt("agent.replaced", { agentId: "dev" }));

  const rec = state.agents.get("dev")!;
  assert.deepEqual(rec.state.currentArtifactIds, ["art-1"]);
  assert.equal(rec.state.activeTaskId, "task-1");
});

test("agent.replaced: replacing an agent that was never created is ignored, not fatal", () => {
  const state = seeded();
  assert.doesNotThrow(() => applyEvent(state, evt("agent.replaced", { agentId: "ghost", inheritTaskId: "task-1" })));
  assert.equal(state.agents.has("ghost"), false);
});

// --------------------------------------------------------- requirement.blocked

test("requirement.blocked: an evidenced criterion falls back to UNSATISFIED and progress drops with it", () => {
  const state = seeded();
  applyEvent(state, evt("requirement.satisfied", { criterionId: "c1", verified: true }));
  assert.equal(state.progress.get(GOAL_ID)!.completed, 1);

  applyEvent(state, evt("requirement.blocked", { criterionId: "c1", reason: "dependency missing" }));

  const g = state.goals.get(GOAL_ID)!;
  assert.equal(g.acceptanceCriteria.find((c) => c.id === "c1")!.status, "UNSATISFIED");
  // Progress is recomputed, never decremented: a blocked criterion that left
  // the ratio at its old value is exactly how a reset mission looks "done".
  assert.deepEqual(
    { completed: state.progress.get(GOAL_ID)!.completed, total: state.progress.get(GOAL_ID)!.total },
    { completed: 0, total: 2 },
  );
});

test("requirement.blocked: an unknown criterion still refreshes progress rather than throwing", () => {
  const state = seeded();
  applyEvent(state, evt("requirement.satisfied", { criterionId: "c1", verified: true }));
  assert.doesNotThrow(() => applyEvent(state, evt("requirement.blocked", { criterionId: "nope" })));
  assert.equal(state.progress.get(GOAL_ID)!.completed, 1, "an unknown id changes no criterion");
});

test("requirement.blocked: with no criterionId the event is a no-op", () => {
  const state = seeded();
  applyEvent(state, evt("requirement.satisfied", { criterionId: "c1", verified: true }));
  applyEvent(state, evt("requirement.blocked", {}));
  assert.equal(state.goals.get(GOAL_ID)!.acceptanceCriteria.find((c) => c.id === "c1")!.status !== "UNSATISFIED", true);
});

test("requirement.blocked: falls back to the active goal when the event names none", () => {
  const state = seeded();
  applyEvent(state, evt("requirement.satisfied", { criterionId: "c1", verified: true }));
  applyEvent(state, evt("requirement.blocked", { criterionId: "c1" }, { goalId: undefined }));
  assert.equal(state.goals.get(GOAL_ID)!.acceptanceCriteria.find((c) => c.id === "c1")!.status, "UNSATISFIED");
});

// ------------------------------------------------------- conflict map eviction

test("conflict map: growth past MAX_CONFLICTS evicts the oldest keys, keeping the newest", () => {
  const state = seeded();
  for (let i = 0; i < MAX_CONFLICTS + 25; i++) {
    bumpConflict(state, `loop:dev:t${i}`, "dev", "2026-04-01T00:00:00.000Z", `t${i}`);
  }
  assert.equal(state.conflicts.size, MAX_CONFLICTS + 25, "bumpConflict itself does not evict");

  // Eviction runs on the way out of the system reducer, so ANY system event
  // trims the map. `budget.exceeded` on an undeclared key is the cheapest one.
  applyEvent(state, evt("budget.exceeded", { key: "mission:none", limit: 1, consumed: 2 }));

  assert.equal(state.conflicts.size, MAX_CONFLICTS);
  assert.equal(state.conflicts.has("loop:dev:t0"), false, "oldest insertion goes first");
  assert.equal(state.conflicts.has(`loop:dev:t${MAX_CONFLICTS + 24}`), true, "newest must survive");
});

test("conflict map: a map under the cap is left entirely alone", () => {
  const state = seeded();
  bumpConflict(state, "loop:dev:t1", "dev", "2026-04-01T00:00:00.000Z", "t1");
  applyEvent(state, evt("budget.exceeded", { key: "mission:none", limit: 1, consumed: 2 }));
  assert.equal(state.conflicts.size, 1);
  assert.equal(state.conflicts.get("loop:dev:t1")!.count, 1);
});
