import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, collectEvents } from "../helpers";
import { abnormalTurnNote } from "../../packages/core/src/turn-tracker";

/**
 * A turn the mesh kills must leave the SEAT a record that it happened.
 *
 * The per-turn `turn:<id>` note is written on the success path, ~130 lines past
 * the runtime call that a timeout throws from — so the one reader who could act
 * on the failure was the only one told nothing. The operator saw
 * `turn.discarded`; the agent's next turn opened with the same mission, the same
 * task and no memory that the previous attempt existed.
 *
 * Measured on the skill-panel run of 2026-09-24: one seat spent 302,667 tokens
 * (27% of the whole run) on a single 20-minute timeout, its successor knew
 * nothing of it, and `turns.jsonl` recorded the turn as failed with no cost at
 * all — so every cost view undercounted the run's most expensive turn.
 */

const AGENTS = [{ id: "dev", role: "developer", capabilities: ["repository.read"], interests: [], tokens: 500_000 }];

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

/** Same shape as `tests/policy/timeout-billing.test.ts`; kept local so the two files stay independent. */
async function timedOutMesh(interruptUsage?: { input: number; output: number; total: number }): Promise<Mesh> {
  const m = await makeMesh({
    agents: AGENTS,
    startup: [],
    autoRaise: { enabled: false },
    turnTimeoutMs: 250,
  });
  stub(m).setScript("dev", async () => ({ delayMs: 60_000, ...(interruptUsage ? { interruptUsage } : {}) }));
  await m.supervisor.activateAgent("dev", { kind: "manual" });
  await waitFor(
    "the timed-out turn to finish",
    async () => (await collectEvents(m)).some((e) => e.type === "turn.discarded"),
    15_000,
  );
  return m;
}

async function turnNotes(m: Mesh): Promise<string[]> {
  return (await collectEvents(m))
    .filter((e) => e.type === "memory.updated")
    .map((e) => (e.payload as { note?: { key?: string; value?: string } }).note)
    .filter((n): n is { key: string; value: string } => typeof n?.key === "string" && n.key.startsWith("turn:"))
    .map((n) => n.value);
}

test("a turn the mesh kills leaves the seat a record that it happened", async () => {
  const m = await timedOutMesh({ input: 900, output: 100, total: 1000 });
  try {
    const notes = await turnNotes(m);
    assert.equal(notes.length, 1, "a turn that ended abnormally writes exactly one turn note");
    // One invariant, three necessary parts: WHAT happened, WHAT IT COST, and what
    // NOT to do next. The last is the one that breaks the retry loop.
    assert.match(notes[0]!, /did not finish/, "the seat must be told the turn never completed");
    assert.match(notes[0]!, /1000 tokens/, "and what the attempt cost, so the next one can be smaller");
    assert.match(notes[0]!, /DO NOT simply retry/, "without this the seat re-enters the identical long turn");
  } finally {
    await m.cleanup();
  }
});

test("the ring's record of a killed turn carries what the turn cost, not just that it failed", async () => {
  const m = await timedOutMesh({ input: 900, output: 100, total: 1000 });
  try {
    const rec = m.supervisor.getRecentTurns(10).find((t) => t.status === "failed");
    assert.ok(rec, "the killed turn is in the ring");
    assert.equal(rec!.tokens, 1000, "a turn recorded as costing nothing is undercounted by every cost view");
    assert.ok(
      rec!.summary?.includes("did not finish"),
      "the ring and the seat's memory must say the same thing about the same turn",
    );
  } finally {
    await m.cleanup();
  }
});

test("a killed turn with no reported usage says so, rather than claiming zero", async () => {
  // Same discipline the billing path already keeps: absent means unmeasured. A
  // note reading "0 tokens" would tell the seat the attempt was free.
  const m = await timedOutMesh(undefined);
  try {
    const notes = await turnNotes(m);
    assert.equal(notes.length, 1, "an unmeasured failure still owes the seat a note");
    assert.match(notes[0]!, /spend unmeasured/, "unmeasured is not zero");
    assert.doesNotMatch(notes[0]!, /0 tokens/, "never invent a figure the backend did not report");
  } finally {
    await m.cleanup();
  }
});

test("the note names the ending it is describing, so a seat can tell a timeout from a dead backend", () => {
  // Pure — the wording is the deliverable, and it should be assertable without
  // booting a mesh and waiting out a real timeout.
  assert.match(abnormalTurnNote({ reason: "timeout", tokens: 5 }, 20_000), /stopped on the turn timeout/);
  assert.match(abnormalTurnNote({ reason: "silence", tokens: 5 }, 20_000), /output stream went silent/);
  assert.match(abnormalTurnNote({ reason: "failed", tokens: 5 }, 20_000), /lost to a backend failure/);
  // Duration is reported in whole seconds, and the runtime's own words are
  // appended only when it had some.
  assert.match(abnormalTurnNote({ reason: "timeout", tokens: 5 }, 20_000), /after 20s/);
  assert.match(
    abnormalTurnNote({ reason: "timeout", tokens: 5, detail: "turn timeout after 1200000ms" }, 20_000),
    /the runtime reported: turn timeout after 1200000ms/,
  );
  assert.doesNotMatch(abnormalTurnNote({ reason: "timeout", tokens: 5 }, 20_000), /the runtime reported/);
});
