import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { createInitialState, exportState, importState } from "../../packages/core/src/state";
import { applyEvent } from "../../packages/core/src/projections";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * Collab sessions (§2.1): the expensive mode, made visible.
 *
 * Open-ended discussion between agents did not stop existing when the mesh
 * standardised on narrow service asks — it moved, into threads that kept
 * going after the ask that opened them had been discharged. That traffic was
 * unbounded and unattributed: no deadline could fire (the commitment was
 * already closed), nothing counted the turns, and the only thing that ever
 * ended it was a thread token budget running dry, which an operator reads as
 * a budget fault rather than as two agents talking in circles.
 *
 * A collab session is that conversation declared, bounded at the moment it
 * opens, and billed. It obliges nobody — so it is never nudged, never
 * chased, never a stalemate — but it cannot be quiet, and it cannot be long
 * without someone being told.
 */

function fakeTurn(agentId: string) {
  return {
    turnId: `t-${agentId}-${Math.random().toString(36).slice(2, 8)}`,
    agentId,
    reason: { kind: "manual" },
    sentOps: 0,
    publishedOps: 0,
    waitRequested: false,
    escalated: false,
    results: [],
  } as never;
}

interface CollabProbe {
  sweepCollabOverruns(nowMs: number): Promise<void>;
  checkStall(): Promise<void>;
  liveMode: boolean;
}
const probe = (m: Awaited<ReturnType<typeof makeMesh>>) => m.supervisor as unknown as CollabProbe;

async function pair(opts?: { boxMs?: number; maxExchanges?: number }) {
  return makeMesh({
    agents: [
      { id: "architect", role: "architect", interests: [] },
      { id: "dev", role: "developer", interests: [] },
    ],
    mayContact: { architect: ["dev"], dev: ["architect"] },
    mode: "parked",
    ...(opts ? { bus: { collab: { boxMs: opts.boxMs, maxExchanges: opts.maxExchanges } } } : {}),
  });
}

test("collab: opening stamps a box and obliges nobody", async () => {
  const m = await pair();
  try {
    const res = await m.supervisor.executeOp(
      "architect",
      { op: "collab", with: ["dev"], topic: "how should we shard the index?", payload: { note: "no idea yet" } } as MeshOp,
      fakeTurn("architect"),
    );
    assert.equal(res.ok, true, res.reason);
    const cs = m.kernel.state.collabSessions.get(res.threadId!)!;
    assert.ok(cs, "the session is on the projection, keyed by its thread");
    assert.equal(cs.status, "OPEN");
    assert.equal(cs.openedBy, "architect");
    assert.deepEqual([...cs.participants].sort(), ["architect", "dev"]);
    assert.ok(Date.parse(cs.expiresAt) > Date.parse(cs.openedAt), "the box is stamped at open");
    assert.ok(cs.maxExchanges > 0);
    // The whole point of the mode: no debt. An obligation here would make the
    // session nudgeable, and a discussion that nudges is a discussion that
    // costs a turn every wait tick until someone declares it over.
    assert.equal(m.kernel.state.pendingRequests.size, 0, "a collab opens no commitment");
    const opening = m.kernel.state.messages.get(res.messageId!)!;
    assert.equal(opening.control?.mode, "collab");
  } finally {
    await m.cleanup();
  }
});

test("collab: an agent may shorten its own box but never lengthen it", async () => {
  const m = await pair({ boxMs: 60_000, maxExchanges: 10 });
  try {
    const short = await m.supervisor.executeOp(
      "architect",
      { op: "collab", with: ["dev"], topic: "quick one", boxMs: 5_000, maxExchanges: 3 } as MeshOp,
      fakeTurn("architect"),
    );
    assert.equal(short.ok, true, short.reason);
    const a = m.kernel.state.collabSessions.get(short.threadId!)!;
    assert.equal(a.maxExchanges, 3);
    assert.ok(Date.parse(a.expiresAt) - Date.parse(a.openedAt) <= 5_000);

    const greedy = await m.supervisor.executeOp(
      "architect",
      { op: "collab", with: ["dev"], topic: "long one", boxMs: 86_400_000, maxExchanges: 9999 } as MeshOp,
      fakeTurn("architect"),
    );
    assert.equal(greedy.ok, true, greedy.reason);
    const b = m.kernel.state.collabSessions.get(greedy.threadId!)!;
    // Clamped to the operator's ceiling. A box an agent can widen is not a box.
    assert.equal(b.maxExchanges, 10);
    assert.ok(Date.parse(b.expiresAt) - Date.parse(b.openedAt) <= 60_000);
  } finally {
    await m.cleanup();
  }
});

test("collab: every message in the thread is metered, including the other seat's", async () => {
  const m = await pair({ maxExchanges: 10 });
  try {
    const res = await m.supervisor.executeOp(
      "architect",
      { op: "collab", with: ["dev"], topic: "sharding" } as MeshOp,
      fakeTurn("architect"),
    );
    const threadId = res.threadId!;
    // The opening message is the OPEN, not an exchange.
    assert.equal(m.kernel.state.collabSessions.get(threadId)!.exchanges, 0);

    for (const [from, to] of [["dev", "architect"], ["architect", "dev"], ["dev", "architect"]] as const) {
      const sent = await m.supervisor.sendMessage({ from, to: [to], type: "INFORM", threadId, payload: { note: "thinking out loud" } });
      assert.equal(sent.accepted, true, sent.reason);
    }
    assert.equal(m.kernel.state.collabSessions.get(threadId)!.exchanges, 3);
    assert.equal(m.kernel.state.pendingRequests.size, 0, "chatter in a collab still owes nothing");
  } finally {
    await m.cleanup();
  }
});

test("collab: closing early records the outcome and raises no card", async () => {
  const m = await pair();
  try {
    const res = await m.supervisor.executeOp(
      "architect",
      { op: "collab", with: ["dev"], topic: "sharding" } as MeshOp,
      fakeTurn("architect"),
    );
    const closed = await m.supervisor.executeOp(
      "dev",
      { op: "close_collab", threadId: res.threadId!, outcome: "range-shard by tenant id" } as MeshOp,
      fakeTurn("dev"),
    );
    assert.equal(closed.ok, true, closed.reason);
    const cs = m.kernel.state.collabSessions.get(res.threadId!)!;
    assert.equal(cs.status, "CLOSED");
    assert.equal(cs.closedReason, "closed");
    assert.equal([...m.kernel.state.escalations.values()].length, 0, "an on-time close is free");

    // Idempotent: a second close is refused rather than re-emitting.
    const again = await m.supervisor.executeOp(
      "dev",
      { op: "close_collab", threadId: res.threadId!, outcome: "again" } as MeshOp,
      fakeTurn("dev"),
    );
    assert.equal(again.ok, false);
    assert.match(again.reason ?? "", /already closed/);
  } finally {
    await m.cleanup();
  }
});

test("collab: talking past the exchange budget closes the session and bills a card", async () => {
  const m = await pair({ maxExchanges: 2 });
  try {
    const res = await m.supervisor.executeOp(
      "architect",
      { op: "collab", with: ["dev"], topic: "sharding" } as MeshOp,
      fakeTurn("architect"),
    );
    const threadId = res.threadId!;
    for (const [from, to] of [["dev", "architect"], ["architect", "dev"]] as const) {
      const sent = await m.supervisor.sendMessage({ from, to: [to], type: "INFORM", threadId, payload: { note: "still thinking" } });
      // Asserted, not assumed: a dropped send would leave the meter short and
      // the session legitimately OPEN, which reads as "the sweep is broken".
      assert.equal(sent.accepted, true, sent.reason);
    }
    assert.equal(m.kernel.state.collabSessions.get(threadId)!.exchanges, 2, "the box is spent before the sweep runs");
    await probe(m).sweepCollabOverruns(Date.now());

    const cs = m.kernel.state.collabSessions.get(threadId)!;
    assert.equal(cs.status, "OVERRUN", "overrun is kept distinct from a deliberate close");
    assert.equal(cs.closedReason, "exchanges_exhausted");

    const card = [...m.kernel.state.escalations.values()].find((e) => e.reason.startsWith("collab_overrun"));
    assert.ok(card, "an overrun raises an operator card");
    // Advisory: a session that ran long is a bill, not a fault. Making it
    // block mission completion would turn "these two talked a lot" into a
    // halted mission needing a human before anything else can finish.
    assert.equal(card!.advisory, true);
    const detail = card!.detail as { exchanges: number; maxExchanges: number; budgetKey?: string; topic: string };
    assert.equal(detail.exchanges, 2);
    assert.equal(detail.maxExchanges, 2);
    assert.equal(detail.topic, "sharding");
    assert.match(detail.budgetKey ?? "", new RegExp(`^thread:.*/${threadId}$`), "the card names the budget line to read the spend on");

    // Swept once, not once per tick.
    await probe(m).sweepCollabOverruns(Date.now());
    assert.equal([...m.kernel.state.escalations.values()].filter((e) => e.reason.startsWith("collab_overrun")).length, 1);
  } finally {
    await m.cleanup();
  }
});

test("collab: a session that goes quiet past its clock is still swept, from checkStall", async () => {
  const m = await pair({ boxMs: 1 });
  try {
    const res = await m.supervisor.executeOp(
      "architect",
      { op: "collab", with: ["dev"], topic: "abandoned thread" } as MeshOp,
      fakeTurn("architect"),
    );
    // No further messages at all — which is exactly the case an event-driven
    // watchdog cannot see, and the reason this hangs off the wall clock.
    //
    // "Past its clock" has to be a FACT before the sweep runs, not an
    // assumption about how long the lines above took. The box is one
    // millisecond and the clock is the real one, so `executeOp` returning
    // inside that millisecond is rare but perfectly legal — and the sweep
    // would then correctly leave a session that is still inside its box
    // alone, failing this test for being right. Wait on the sweep's own
    // condition instead of racing it.
    const opened = m.kernel.state.collabSessions.get(res.threadId!)!;
    while (Date.now() <= Date.parse(opened.expiresAt)) {
      await new Promise((r) => setTimeout(r, 2));
    }
    const p = probe(m);
    p.liveMode = true;
    await p.checkStall();

    const cs = m.kernel.state.collabSessions.get(res.threadId!)!;
    assert.equal(cs.status, "OVERRUN");
    assert.equal(cs.closedReason, "expired");
    assert.ok(
      [...m.kernel.state.escalations.values()].some((e) => e.reason === "collab_overrun:expired"),
      "the stall watch is where the clock sweep actually runs",
    );
  } finally {
    await m.cleanup();
  }
});

test("collab: a session survives a snapshot round-trip and a replay", async () => {
  const m = await pair({ maxExchanges: 5 });
  try {
    const res = await m.supervisor.executeOp(
      "architect",
      { op: "collab", with: ["dev"], topic: "sharding" } as MeshOp,
      fakeTurn("architect"),
    );
    const threadId = res.threadId!;
    await m.supervisor.sendMessage({ from: "dev", to: ["architect"], type: "INFORM", threadId, payload: { note: "one" } });

    // Snapshot: dropping this map would let a restarted mission hold a
    // session no sweep can ever find, which is an unbounded collab by the
    // back door.
    const restored = createInitialState();
    importState(restored, exportState(m.kernel.state) as never);
    const snap = restored.collabSessions.get(threadId)!;
    assert.ok(snap);
    assert.equal(snap.exchanges, 1);
    assert.equal(snap.status, "OPEN");

    // Replay: the exchange count and the expiry must come out the same, which
    // is why both are metered in the reducer and stamped into the event.
    const replayed = createInitialState();
    for (const e of await m.kernel.store.read()) applyEvent(replayed, e);
    const live = m.kernel.state.collabSessions.get(threadId)!;
    const rep = replayed.collabSessions.get(threadId)!;
    assert.equal(rep.exchanges, live.exchanges);
    assert.equal(rep.expiresAt, live.expiresAt);
    assert.equal(rep.maxExchanges, live.maxExchanges);
  } finally {
    await m.cleanup();
  }
});

/* ------------------------------------------------------------------ *
 * D13: the thread the session was living in                           *
 * ------------------------------------------------------------------ */

/**
 * `Thread.status` has declared `"OPEN" | "RESOLVED" | "ESCALATED"` since the
 * type was written, and nothing ever wrote anything but `OPEN`. A discussion
 * two agents deliberately ended stayed, on the projection, a live thread
 * forever: the dashboard showed it, the depth scan kept walking it, and the
 * termination check counted it as work still in flight — so a mission could
 * not read itself as finished on the strength of a conversation that was
 * over.
 *
 * `collab.closed` is the one event that already knows a discussion ended, so
 * it is the one that now says so on both records.
 */
test("collab: closing the session resolves the thread it was living in", async () => {
  const m = await pair();
  try {
    const res = await m.supervisor.executeOp(
      "architect",
      { op: "collab", with: ["dev"], topic: "sharding" } as MeshOp,
      fakeTurn("architect"),
    );
    const threadId = res.threadId!;
    assert.equal(m.kernel.state.threads.get(threadId)!.status, "OPEN", "a live discussion is a live thread");

    const closed = await m.supervisor.executeOp(
      "dev",
      { op: "close_collab", threadId, outcome: "range-shard by tenant id" } as MeshOp,
      fakeTurn("dev"),
    );
    assert.equal(closed.ok, true, closed.reason);

    assert.equal(m.kernel.state.collabSessions.get(threadId)!.status, "CLOSED");
    assert.equal(m.kernel.state.threads.get(threadId)!.status, "RESOLVED", "and a finished one is a resolved thread");

    // Pure function of the log, or a restarted mission re-opens every
    // discussion its agents closed.
    const replayed = createInitialState();
    for (const e of await m.kernel.store.read()) applyEvent(replayed, e);
    assert.equal(replayed.threads.get(threadId)!.status, "RESOLVED");

    // Idempotent: replaying the same log again must not relabel anything.
    for (const e of await m.kernel.store.read()) applyEvent(replayed, e);
    assert.equal(replayed.threads.get(threadId)!.status, "RESOLVED");
  } finally {
    await m.cleanup();
  }
});

test("collab: an overrun thread reads ESCALATED, not cleanly resolved", async () => {
  const m = await pair({ maxExchanges: 2 });
  try {
    const res = await m.supervisor.executeOp(
      "architect",
      { op: "collab", with: ["dev"], topic: "sharding" } as MeshOp,
      fakeTurn("architect"),
    );
    const threadId = res.threadId!;
    for (const [from, to] of [["dev", "architect"], ["architect", "dev"]] as const) {
      const sent = await m.supervisor.sendMessage({ from, to: [to], type: "INFORM", threadId, payload: { note: "still thinking" } });
      assert.equal(sent.accepted, true, sent.reason);
    }
    await probe(m).sweepCollabOverruns(Date.now());

    // `sweepCollabOverruns` reaches the same reducer as a deliberate close,
    // and the two must not read alike. The sweep is holding an operator card
    // saying these two talked past their box; labelling the thread RESOLVED
    // next to that card would have the projection disagree with the bill.
    assert.equal(m.kernel.state.collabSessions.get(threadId)!.status, "OVERRUN");
    assert.equal(m.kernel.state.threads.get(threadId)!.status, "ESCALATED", "a thread that ran long was not resolved");
    assert.ok(
      [...m.kernel.state.escalations.values()].some((e) => e.reason.startsWith("collab_overrun")),
      "...which is the fact the thread status is agreeing with",
    );

    // Both exits are terminal, which is what every liveness reader needs:
    // the depth scan, the stall watch and the prompt's open-thread list all
    // ask only "is this still OPEN?", and only the dashboard tells the two
    // apart.
    assert.notEqual(m.kernel.state.threads.get(threadId)!.status, "OPEN");
  } finally {
    await m.cleanup();
  }
});

test("collab: an ordinary service thread is untouched by any of this", async () => {
  const m = await pair();
  try {
    // The blast radius check. `collab.closed` is the only writer of a
    // terminal thread status, so a thread that never hosted a session must
    // still be OPEN — the cap on open threads in the prompt, and the
    // deadlock scan, both still depend on that being true of normal traffic.
    const sent = await m.supervisor.sendMessage({
      from: "architect",
      to: ["dev"],
      type: "REQUEST_INFO",
      newThread: { subject: "where does the tenant id come from?" },
      payload: { q: "?" },
    });
    assert.equal(sent.accepted, true, sent.reason);
    const threadId = m.kernel.state.messages.get(sent.messageId!)!.threadId;
    assert.equal(m.kernel.state.threads.get(threadId)!.status, "OPEN");
    assert.equal(m.kernel.state.collabSessions.has(threadId), false, "no session, so nothing to close");
  } finally {
    await m.cleanup();
  }
});
