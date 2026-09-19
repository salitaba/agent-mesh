import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor } from "../helpers";
import { createInitialState, exportState, importState } from "../../packages/core/src/state";
import { applyEvent } from "../../packages/core/src/projections";
import { buildAgentContext, renderContextInstructions } from "../../packages/core/src/context";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * Continuity records: what survives when a seat's backend session is thrown
 * away.
 *
 * The mesh and the backend hold two different memories of an agent. The mesh's
 * is rebuilt from projections every turn; the backend's is an accumulating
 * transcript the kernel cannot see, and rotation DESTROYS it rather than
 * resuming it. Before this, the one moment an agent lost everything it had
 * worked out left no trace at all: no event, no card, nothing for replay, and
 * a successor session that re-derived — or re-proposed — whatever its
 * predecessor had already settled or already had rejected.
 */

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

function twoAgents() {
  return [
    { id: "architect", role: "architect", capabilities: ["review.design"], interests: [] },
    { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
  ];
}

/** Parked: these tests drive turns themselves rather than racing the scheduler. */
function parkedMesh() {
  return makeMesh({
    agents: twoAgents(),
    mayContact: { architect: ["dev"], dev: ["architect"] },
    mode: "parked",
  });
}

function liveMesh() {
  return makeMesh({
    agents: twoAgents(),
    mayContact: { architect: ["dev"], dev: ["architect"] },
    mode: "live",
    stallIdleMs: 600_000,
    stallCooldownMs: 600_000,
    stallNoopRetryMs: 600_000,
  });
}

async function quiet(m: Mesh): Promise<void> {
  await waitFor("the mesh went quiet", () => m.scheduler.pending() === 0 && m.scheduler.running() === 0);
}

function replayed(m: Mesh, events: Awaited<ReturnType<typeof m.store.read>>) {
  const fresh = createInitialState();
  for (const e of events) applyEvent(fresh, e, { transitionGates: m.config.transitionGates });
  return fresh;
}

/**
 * A reopen only means something for a mission that reached a verdict — the
 * reducer ignores it otherwise — so a test about episodes has to end the run
 * before asking for another one.
 */
async function endAndReopen(m: Mesh, reason: string): Promise<void> {
  const goalId = m.kernel.state.activeGoalId!;
  await m.kernel.emit("goal.completed", { goalId, reason: "test completion", evidence: [] }, { actorId: "human" });
  await m.kernel.emit("goal.reopened", { goalId, reason }, { actorId: "human" });
}

const writeOp = (over: Partial<Extract<MeshOp, { op: "write_continuity" }>> = {}): MeshOp =>
  ({
    op: "write_continuity",
    nextIntent: "finish the schema comparison and send it to dev",
    beliefs: [{ claim: "postgres is the only candidate that meets the durability bar", basis: "artifact://ResearchReport/db-survey/1", confidence: "asserted" }],
    rejected: [{ what: "artifact://DesignDoc/sqlite-plan/1", rejectedBy: "dev", reason: "no replication story" }],
    ...over,
  }) as MeshOp;

/** Run one op through the supervisor's real op path, with a real turn. */
async function runOp(m: Mesh, agentId: string, op: MeshOp, over: Record<string, unknown> = {}) {
  const turn = { turnId: `t-${Math.random().toString(36).slice(2)}`, agentId, reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [], ...over };
  return m.supervisor.executeOp(agentId, op, turn as never);
}

// --- the record ------------------------------------------------------------

test("continuity: the ledger fills in what the agent owes, not the agent", async () => {
  const m = await parkedMesh();
  try {
    // Two real asks, so "what do you owe?" has an answer the model was never
    // shown and could not have typed.
    const a1 = await m.supervisor.sendMessage({ from: "architect", to: ["dev"], type: "REQUEST", newThread: { subject: "which db?" }, payload: { q: "which db?" } });
    const a2 = await m.supervisor.sendMessage({ from: "architect", to: ["dev"], type: "REQUEST", newThread: { subject: "which cache?" }, payload: { q: "which cache?" } });

    const res = await runOp(m, "dev", writeOp());
    assert.equal(res.ok, true, res.ok ? "" : res.reason);

    const rec = m.kernel.state.continuity.get("dev");
    assert.ok(rec, "the record must land in the projection under the seat that wrote it");
    assert.deepEqual([...rec.openCommitments].sort(), [a1.messageId, a2.messageId].sort());
    assert.equal(rec.nextIntent, "finish the schema comparison and send it to dev");
    assert.equal(rec.workingBeliefs[0]?.confidence, "asserted");
    assert.equal(rec.rejected[0]?.rejectedBy, "dev");
  } finally {
    await m.cleanup();
  }
});

test("continuity: a record with no next intent is refused, because that is the one field nobody else can supply", async () => {
  const m = await parkedMesh();
  try {
    const res = await runOp(m, "dev", writeOp({ nextIntent: "   " }));
    assert.equal(res.ok, false);
    assert.match(res.ok ? "" : res.reason ?? "", /nextIntent/);
    assert.equal(m.kernel.state.continuity.has("dev"), false, "a refused op must not write a half-record");
  } finally {
    await m.cleanup();
  }
});

test("continuity: the record is an event, so a replay rebuilds the same handover", async () => {
  const m = await parkedMesh();
  try {
    await m.supervisor.sendMessage({ from: "architect", to: ["dev"], type: "REQUEST", newThread: { subject: "which db?" }, payload: { q: "?" } });
    await runOp(m, "dev", writeOp());

    const live = m.kernel.state.continuity.get("dev");
    const fresh = replayed(m, await m.store.read());
    assert.deepEqual(fresh.continuity.get("dev"), live, "projections are a pure function of the log or they are not projections");
  } finally {
    await m.cleanup();
  }
});

test("continuity: latest wins — a second handover replaces the first rather than stacking", async () => {
  const m = await parkedMesh();
  try {
    await runOp(m, "dev", writeOp({ nextIntent: "first" }));
    await runOp(m, "dev", writeOp({ nextIntent: "second", beliefs: [] }));
    const rec = m.kernel.state.continuity.get("dev");
    assert.equal(rec?.nextIntent, "second");
    assert.deepEqual(rec?.workingBeliefs, [], "a belief the seat dropped must not outlive the session that dropped it");
  } finally {
    await m.cleanup();
  }
});

test("continuity: a record survives a snapshot, or a restarted mesh starts every seat cold", async () => {
  const m = await parkedMesh();
  try {
    await runOp(m, "dev", writeOp());
    const restored = createInitialState();
    importState(restored, exportState(m.kernel.state) as never);
    assert.deepEqual(restored.continuity.get("dev"), m.kernel.state.continuity.get("dev"));
  } finally {
    await m.cleanup();
  }
});

// --- the successor's prompt ------------------------------------------------

test("continuity: the successor reads the handover first, ahead of the mission", async () => {
  const m = await parkedMesh();
  try {
    await runOp(m, "dev", writeOp());
    const bundle = buildAgentContext({ config: m.config, kernel: m.kernel }, "dev");
    assert.ok(bundle.continuity, "slot 1 must be populated from the projection");

    const text = renderContextInstructions(bundle);
    const handoverAt = text.indexOf("## Handover from your previous session");
    const missionAt = text.indexOf("## Mission");
    assert.ok(handoverAt >= 0, "the record has to reach the prompt or writing it was theatre");
    assert.ok(handoverAt < missionAt, "a seat whose memory was just destroyed reads this before anything it could re-derive");
    assert.match(text, /finish the schema comparison/);
    assert.match(text, /Already rejected by dev/, "the successor must not re-propose what was already turned down");
  } finally {
    await m.cleanup();
  }
});

test("continuity: an assumption is marked as one, so it cannot be inherited as a fact", async () => {
  const m = await parkedMesh();
  try {
    await runOp(m, "dev", writeOp({
      beliefs: [{ claim: "the api team will ship auth by friday", basis: "msg-1", confidence: "assumed" }],
    }));
    const text = renderContextInstructions(buildAgentContext({ config: m.config, kernel: m.kernel }, "dev"));
    assert.match(text, /ASSUMED \(unverified\).*the api team will ship auth/);
  } finally {
    await m.cleanup();
  }
});

test("continuity: the manifest counts the slot, so an operator can see which turn was the first after a rotation", async () => {
  const m = await parkedMesh();
  try {
    const before = buildAgentContext({ config: m.config, kernel: m.kernel }, "dev");
    assert.equal(before.continuity, undefined, "a seat on its first session has no predecessor");
    await runOp(m, "dev", writeOp());
    const after = buildAgentContext({ config: m.config, kernel: m.kernel }, "dev");
    assert.ok(after.continuity);
  } finally {
    await m.cleanup();
  }
});

// --- episodes --------------------------------------------------------------

test("episodes: a reopen starts a new run, and a record from the old one says so", async () => {
  const m = await parkedMesh();
  try {
    await runOp(m, "dev", writeOp());
    const goalId = m.kernel.state.activeGoalId!;
    assert.equal(m.kernel.state.continuity.get("dev")?.episode, `${goalId}#1`);

    await endAndReopen(m, "operator rejected the result");
    assert.equal(m.kernel.state.goals.get(goalId)?.episodeOrdinal, 2, "a reopen is a new episode, not a continuation");

    const bundle = buildAgentContext({ config: m.config, kernel: m.kernel }, "dev");
    assert.equal(bundle.episode, `${goalId}#2`);
    const text = renderContextInstructions(bundle);
    assert.match(text, /during an EARLIER run of this mission/, "beliefs formed in a round that was rejected are history, not settled ground");
  } finally {
    await m.cleanup();
  }
});

test("episodes: the ordinal is a function of the log, so a replay agrees with the mesh that ran", async () => {
  const m = await parkedMesh();
  try {
    const goalId = m.kernel.state.activeGoalId!;
    await endAndReopen(m, "one");
    await endAndReopen(m, "two");
    const fresh = replayed(m, await m.store.read());
    assert.equal(fresh.goals.get(goalId)?.episodeOrdinal, 3);
  } finally {
    await m.cleanup();
  }
});

// --- the handover turn -----------------------------------------------------

test("handover: a seat one turn from losing its transcript is given a turn to write it down", async () => {
  const m = await liveMesh();
  try {
    const prompts: string[] = [];
    stub(m).setScript("dev", async (input) => {
      prompts.push(input.instructions);
      return { operations: [writeOp(), { op: "done" } as MeshOp] };
    });
    stub(m).setScript("architect", async () => ({ operations: [{ op: "wait" } as MeshOp] }));
    stub(m).armRotation("dev");

    await m.supervisor.activateAgent("dev", { kind: "manual", note: "go" });
    await waitFor("the handover landed", () => m.kernel.state.continuity.has("dev"));
    await quiet(m);

    assert.match(prompts[0] ?? "", /will be replaced before your next turn/);
    assert.match(prompts[0] ?? "", /write_continuity/);
    const types = (await m.store.read()).map((e) => e.type);
    assert.ok(types.includes("session.rotation_pending"), "the one moment an agent loses its memory must be on the log");
    assert.ok(types.includes("continuity.recorded"));
  } finally {
    await m.cleanup();
  }
});

test("handover: the turn is spent on the record — everything else is refused, out loud", async () => {
  const m = await parkedMesh();
  try {
    const res = await runOp(m, "dev", { op: "publish_artifact", name: "half-done", type: "ResearchReport", content: "..." } as MeshOp, { handover: true });
    assert.equal(res.ok, false);
    assert.match(res.ok ? "" : res.reason ?? "", /handover/, "a silent no-op would read to the model as the op having worked");
    // ...but the record itself, and ending the turn, must still work.
    assert.equal((await runOp(m, "dev", writeOp(), { handover: true })).ok, true);
    assert.equal((await runOp(m, "dev", { op: "done" } as MeshOp, { handover: true })).ok, true);
  } finally {
    await m.cleanup();
  }
});

test("handover: the work the seat was woken for is given back, not dropped", async () => {
  const m = await liveMesh();
  try {
    const reasons: string[] = [];
    stub(m).setScript("dev", async (input) => {
      reasons.push(input.activation.note ?? input.activation.kind);
      stub(m).clearRotation("dev");
      return { operations: [writeOp(), { op: "done" } as MeshOp] };
    });
    stub(m).setScript("architect", async () => ({ operations: [{ op: "wait" } as MeshOp] }));
    stub(m).armRotation("dev");

    await m.supervisor.activateAgent("dev", { kind: "manual", note: "review the patch" });
    await waitFor("dev ran twice", () => reasons.length >= 2);
    await quiet(m);

    assert.deepEqual(reasons.slice(0, 2), ["review the patch", "review the patch"],
      "the handover consumed an activation; the reason it consumed has to come back");
  } finally {
    await m.cleanup();
  }
});

test("handover: asked once per transcript — a seat that ignores it is not asked forever", async () => {
  const m = await liveMesh();
  try {
    let turns = 0;
    // The seat never writes a record. It must still get its work turn back,
    // and must not be handed a second handover on the same transcript.
    stub(m).setScript("dev", async () => { turns++; return { operations: [{ op: "done" } as MeshOp] }; });
    stub(m).setScript("architect", async () => ({ operations: [{ op: "wait" } as MeshOp] }));
    stub(m).armRotation("dev");

    await m.supervisor.activateAgent("dev", { kind: "manual", note: "go" });
    await waitFor("dev ran twice", () => turns >= 2);
    await quiet(m);

    const pendings = (await m.store.read()).filter((e) => e.type === "session.rotation_pending");
    assert.equal(pendings.length, 1, "a seat that cannot write a record must still be able to do something else");
    assert.equal(m.kernel.state.continuity.has("dev"), false);
  } finally {
    await m.cleanup();
  }
});

test("rotation: session.rotated finally has a reducer, so the mesh knows which transcript a seat is on", async () => {
  const m = await parkedMesh();
  try {
    assert.equal(m.kernel.state.sessionOrdinal.get("dev"), undefined);
    await m.kernel.emit("session.rotated", {
      agentId: "dev", fromSessionId: "s1", toSessionId: "s2", sessionOrdinal: 2,
      reason: "rotation", transcriptTokensDiscarded: 600_000,
    }, { actorId: "dev" });
    assert.equal(m.kernel.state.sessionOrdinal.get("dev"), 2);

    await runOp(m, "dev", writeOp());
    assert.equal(m.kernel.state.continuity.get("dev")?.sessionOrdinal, 2,
      "the ordinal is stamped from the projection, not asked of a model that is running out of room");
  } finally {
    await m.cleanup();
  }
});
