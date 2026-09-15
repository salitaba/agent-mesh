import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEvent } from "../../packages/core/src/projections";
import {
  createInitialState,
  ELIDED_MEMORY_KEY,
  isAutoMemoryNote,
  MAX_AGENT_MEMORY,
  MAX_AUTO_MEMORY,
  MAX_MEMORY_VALUE_CHARS,
  type Projections,
} from "../../packages/core/src/state";
import { PROTOCOL_VERSION, type Goal, type MeshEvent } from "../../packages/protocol/src/index";

/**
 * L2 memory was the only projection outside the bounded-state caps, and the
 * only one written automatically — one note per turn, under a unique
 * `turn:<id>` key, re-rendered in full into every later prompt. Left uncapped
 * it made prompt size grow linearly in turns and total tokens quadratically,
 * which quietly defeated the item caps every other context section carried.
 *
 * The property worth protecting is not just "bounded": it is that turn exhaust
 * cannot evict what an agent deliberately chose to remember. A single shared
 * cap would bound the map and still lose the mesh's explicit memories, which is
 * the worse of the two failures.
 */

const GOAL_ID = "goal-memory";

let seq = 0;
function evt(type: string, payload: Record<string, unknown>): MeshEvent {
  seq++;
  return {
    id: `evt-mem-${seq}`,
    protocolVersion: PROTOCOL_VERSION,
    type: type as MeshEvent["type"],
    timestamp: `2026-04-01T00:00:${String(seq % 60).padStart(2, "0")}.000Z`,
    goalId: GOAL_ID,
    actorId: "dev",
    seq,
    payload,
  } as MeshEvent;
}

function seeded(): Projections {
  const state = createInitialState();
  applyEvent(
    state,
    evt("goal.created", {
      goal: {
        id: GOAL_ID,
        description: "memory mission",
        acceptanceCriteria: [{ id: "c1", description: "first", mandatory: true, status: "UNSATISFIED", evidence: [] }],
        status: "ACTIVE",
        budget: { tokens: 1000, wallClockMinutes: 10, maxEvents: 1000 },
        rootThreadId: `${GOAL_ID}-root`,
        createdAt: "2026-04-01T00:00:00.000Z",
      } as Goal,
    }),
  );
  return state;
}

function remember(state: Projections, key: string, value = "v"): void {
  applyEvent(
    state,
    evt("memory.updated", {
      agentId: "dev",
      note: { agentId: "dev", key, value, updatedAt: "2026-04-01T00:00:00.000Z", eventId: "e" },
    }),
  );
}

function notes(state: Projections): Map<string, { key: string; value: string }> {
  return state.memory.get("dev") as Map<string, { key: string; value: string }>;
}

/** Real notes only — the elision counter lives in the same map but is a marker, not a memory. */
function kept(state: Projections): string[] {
  return [...notes(state).keys()].filter((k) => k !== ELIDED_MEMORY_KEY);
}

function elidedCount(state: Projections): number {
  return Number.parseInt(notes(state).get(ELIDED_MEMORY_KEY)?.value ?? "0", 10) || 0;
}

test("auto turn notes are bounded, keeping the newest", () => {
  const state = seeded();
  for (let i = 0; i < MAX_AUTO_MEMORY + 40; i++) remember(state, `turn:t${i}`);

  const m = notes(state);
  assert.equal(kept(state).length, MAX_AUTO_MEMORY, "unique-per-turn keys must not accumulate");
  assert.equal(m.has("turn:t0"), false, "oldest turn note goes first");
  assert.equal(m.has(`turn:t${MAX_AUTO_MEMORY + 39}`), true, "newest turn note must survive");
});

test("a flood of turn notes cannot evict an agent-authored note", () => {
  const state = seeded();
  remember(state, "deployment-target", "staging-eu");
  for (let i = 0; i < MAX_AUTO_MEMORY + 200; i++) remember(state, `turn:t${i}`);

  const m = notes(state);
  assert.equal(
    m.get("deployment-target")?.value,
    "staging-eu",
    "a deliberate memory must outlive unbounded turn exhaust",
  );
  assert.equal([...m.keys()].filter((k) => isAutoMemoryNote(k)).length, MAX_AUTO_MEMORY);
});

test("agent-authored notes are bounded on their own budget", () => {
  const state = seeded();
  for (let i = 0; i < MAX_AGENT_MEMORY + 15; i++) remember(state, `fact-${i}`);

  const m = notes(state);
  assert.equal(kept(state).length, MAX_AGENT_MEMORY);
  assert.equal(m.has("fact-0"), false);
  assert.equal(m.has(`fact-${MAX_AGENT_MEMORY + 14}`), true);
});

test("re-writing a key refreshes its position instead of letting it age out", () => {
  const state = seeded();
  remember(state, "fact-old", "first");
  for (let i = 0; i < MAX_AGENT_MEMORY - 1; i++) remember(state, `filler-${i}`);
  // Without delete-before-set this rewrite keeps the ORIGINAL insertion slot,
  // so the very next note evicts a value that was just refreshed.
  remember(state, "fact-old", "refreshed");
  remember(state, "one-more");

  const m = notes(state);
  assert.equal(m.get("fact-old")?.value, "refreshed", "a just-written note must not be the eviction victim");
});

/**
 * Eviction that is silent is its own failure: an agent that quietly lost 200
 * turns of history reasons as though it never had any, and states things it
 * already knows to be untrue with full confidence. The count is the whole
 * point — it cannot restore the meaning, but it tells the agent that meaning
 * is missing and that it should re-read rather than assume.
 */
test("eviction leaves a count behind, and the count accumulates across turns", () => {
  const state = seeded();
  for (let i = 0; i < MAX_AUTO_MEMORY; i++) remember(state, `turn:t${i}`);
  assert.equal(elidedCount(state), 0, "nothing dropped yet means nothing to confess");

  remember(state, `turn:overflow-1`);
  assert.equal(elidedCount(state), 1);

  for (let i = 0; i < 9; i++) remember(state, `turn:overflow-more-${i}`);
  assert.equal(elidedCount(state), 10, "the counter must total the loss, not report the last batch");
  assert.equal(kept(state).length, MAX_AUTO_MEMORY, "the marker must not consume a memory slot");
});

test("a note value is clamped, so one write cannot blow up every later prompt", () => {
  const state = seeded();
  remember(state, "huge", "x".repeat(MAX_MEMORY_VALUE_CHARS * 3));
  assert.equal(notes(state).get("huge")?.value.length, MAX_MEMORY_VALUE_CHARS);
});
