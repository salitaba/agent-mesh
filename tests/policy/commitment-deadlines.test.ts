import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor } from "../helpers";
import { buildAgentContext, renderContextInstructions } from "../../packages/core/src/context";
import { createInitialState } from "../../packages/core/src/state";
import { applyEvent } from "../../packages/core/src/projections";
import type { Escalation, MeshOp } from "../../packages/protocol/src/index";

/**
 * Deadlines and refusals: the two ways an ask ends without being answered by
 * the agent it was addressed to.
 *
 * Before these existed the ledger had exactly one escape for an ask nobody
 * would ever answer — the capacity evictor — which fired on the OLDEST ask
 * rather than the overdue one, and only once the ledger was full. A mission
 * whose ledger never filled could hold an unanswerable ask open forever, and
 * because a mesh waiting on an ask emits no events, the event-driven watchdog
 * had nothing to fire on either.
 */

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

/**
 * The stall path is private (only timers call it). Driving it directly keeps
 * these assertions about the DECISION rather than about a sleep.
 */
const internals = (m: Mesh): { checkStall(): Promise<void>; lastTurnAt: number } =>
  m.supervisor as unknown as { checkStall(): Promise<void>; lastTurnAt: number };

function twoAgents() {
  return [
    { id: "architect", role: "architect", capabilities: ["review.design"], interests: [] },
    { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
  ];
}

/**
 * Live mode with the nudge timers pushed past the end of the test: `checkStall`
 * returns early on `liveMode`, so an expiry test cannot use a parked mesh, but
 * nothing else in `checkStall` should get a chance to fire either.
 */
function deadlineMesh(opts: { ttlMs?: number; ttlMsByRole?: Record<string, number> }) {
  return makeMesh({
    agents: twoAgents(),
    mayContact: { architect: ["dev"], dev: ["architect"] },
    mode: "live",
    stallIdleMs: 600_000,
    stallCooldownMs: 600_000,
    stallNoopRetryMs: 600_000,
    bus: { commitments: { ttlMs: opts.ttlMs, ttlMsByRole: opts.ttlMsByRole } },
  });
}

/** Park every agent on `wait` so nothing answers the ask under test. */
function nobodyAnswers(m: Mesh): void {
  for (const id of ["architect", "dev"]) {
    stub(m).setScript(id, async () => ({ operations: [{ op: "wait" } as MeshOp] }));
  }
}

async function quiet(m: Mesh): Promise<void> {
  await waitFor("the mesh went quiet", () => m.scheduler.pending() === 0 && m.scheduler.running() === 0);
}

function replayed(m: Mesh, events: Awaited<ReturnType<typeof m.store.read>>) {
  const fresh = createInitialState();
  for (const e of events) {
    applyEvent(fresh, e, {
      transitionGates: m.config.transitionGates,
      commitmentSemantic: m.config.bus.commitmentSemantic,
      commitmentTtl: m.config.bus.commitmentTtl,
    });
  }
  return fresh;
}

// --- deadlines -------------------------------------------------------------

test("deadlines: an ask nobody answers is closed as expired, not left open forever", async () => {
  const m = await deadlineMesh({ ttlMs: 50 });
  try {
    nobodyAnswers(m);
    const ask = await m.supervisor.sendMessage({
      from: "architect", to: ["dev"], type: "REQUEST",
      newThread: { subject: "which db?" }, payload: { q: "which db?" },
    });
    await quiet(m);

    const pending = m.kernel.state.pendingRequests.get(ask.messageId!);
    assert.ok(pending?.dueBy, "a configured TTL must stamp a deadline at open time");

    // The sweep runs off the wall clock, so wait for the deadline to actually
    // pass rather than asserting on a clock the mesh does not read.
    await waitFor("the deadline passed", () => Date.now() > Date.parse(pending!.dueBy!));
    await internals(m).checkStall();

    assert.equal(m.kernel.state.pendingRequests.has(ask.messageId!), false, "an overdue ask must leave the ledger");
    const rec = m.kernel.state.discharged.find((d) => d.messageId === ask.messageId);
    assert.equal(rec?.reason, "expired");
    assert.equal(rec?.by, "system", "nobody answered — the system closed it");
  } finally {
    await m.cleanup();
  }
});

test("deadlines: an expiry is an event, so a replay closes the same ask", async () => {
  const m = await deadlineMesh({ ttlMs: 50 });
  try {
    nobodyAnswers(m);
    const ask = await m.supervisor.sendMessage({
      from: "architect", to: ["dev"], type: "REQUEST",
      newThread: { subject: "which db?" }, payload: { q: "which db?" },
    });
    await quiet(m);
    const due = m.kernel.state.pendingRequests.get(ask.messageId!)!.dueBy!;
    await waitFor("the deadline passed", () => Date.now() > Date.parse(due));
    await internals(m).checkStall();

    const after = replayed(m, await m.store.read());
    assert.equal(after.pendingRequests.has(ask.messageId!), false, "the expiry must survive replay");
    assert.equal(after.discharged.find((d) => d.messageId === ask.messageId)?.reason, "expired");
  } finally {
    await m.cleanup();
  }
});

test("deadlines: an expiry names who was late, and counts as unanswered", async () => {
  const m = await deadlineMesh({ ttlMs: 50 });
  try {
    nobodyAnswers(m);
    const ask = await m.supervisor.sendMessage({
      from: "architect", to: ["dev"], type: "REQUEST",
      newThread: { subject: "which db?" }, payload: { q: "which db?" },
    });
    await quiet(m);
    const due = m.kernel.state.pendingRequests.get(ask.messageId!)!.dueBy!;
    await waitFor("the deadline passed", () => Date.now() > Date.parse(due));
    await internals(m).checkStall();

    const ev = (await m.store.read())
      .filter((e) => e.type === "commitment.discharged")
      .find((e) => (e.payload as Record<string, unknown>).messageId === ask.messageId);
    assert.ok(ev, "the expiry must be on the log");
    const p = ev!.payload as Record<string, unknown>;
    assert.equal(p.reason, "expired", "a detail key must never overwrite the canonical reason");
    assert.deepEqual(p.unanswered, ["dev"], "an operator can only act on WHO failed to answer");
    assert.equal(p.dueBy, due);
    assert.ok((p.overdueMs as number) >= 0);

    // The asker is told the ask died, so it is not still holding an open loop.
    assert.equal(m.supervisor.commitmentStats().unanswered > 0, true);
  } finally {
    await m.cleanup();
  }
});

test("deadlines: with no TTL configured, an ask never expires", async () => {
  const m = await deadlineMesh({});
  try {
    nobodyAnswers(m);
    const ask = await m.supervisor.sendMessage({
      from: "architect", to: ["dev"], type: "REQUEST",
      newThread: { subject: "which db?" }, payload: { q: "which db?" },
    });
    await quiet(m);
    assert.equal(
      m.kernel.state.pendingRequests.get(ask.messageId!)?.dueBy,
      undefined,
      "expiry is opt-in: an upgrade must not start silently closing a mission's asks",
    );

    await internals(m).checkStall();
    assert.equal(m.kernel.state.pendingRequests.has(ask.messageId!), true, "an ask with no deadline cannot be overdue");
  } finally {
    await m.cleanup();
  }
});

test("deadlines: a slow role's deadline is not cut short by a fast co-debtor", async () => {
  const m = await makeMesh({
    agents: [
      { id: "architect", role: "architect", capabilities: ["review.design"], interests: [] },
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "qa", role: "qa", capabilities: ["test.run"], interests: [] },
    ],
    mayContact: { architect: ["dev", "qa"], dev: ["architect"], qa: ["architect"] },
    mode: "parked",
    bus: { commitments: { ttlMs: 1_000, ttlMsByRole: { qa: 60_000 } } },
  });
  try {
    const ask = await m.supervisor.sendMessage({
      from: "architect", to: ["dev", "qa"], type: "REQUEST",
      newThread: { subject: "ship it?" }, payload: { q: "ship it?" },
    });
    const pr = m.kernel.state.pendingRequests.get(ask.messageId!)!;
    const budget = Date.parse(pr.dueBy!) - Date.parse(pr.createdAt);
    assert.ok(
      budget > 30_000,
      `the LONGEST debtor's TTL wins (got ${budget}ms) — a slow reviewer must not be timed out because a fast one was cc'd`,
    );
  } finally {
    await m.cleanup();
  }
});

test("deadlines: an ask an OPEN escalation points at is not expired out from under the operator", async () => {
  const m = await deadlineMesh({ ttlMs: 50 });
  try {
    nobodyAnswers(m);
    const ask = await m.supervisor.sendMessage({
      from: "architect", to: ["dev"], type: "REQUEST",
      newThread: { subject: "which db?" }, payload: { q: "which db?" },
    });
    await quiet(m);
    // The operator has been asked to resolve this exact ask.
    m.kernel.state.escalations.set("esc-1", {
      id: "esc-1",
      goalId: m.kernel.state.activeGoalId ?? "goal-1",
      reason: "stalemate:unanswered_request",
      detail: { requestMessageId: ask.messageId!, agentId: "architect" },
      raisedBy: "termination-manager",
      conflictKey: `stuck:${ask.messageId}:architect`,
      status: "OPEN",
    } as Escalation);
    const due = m.kernel.state.pendingRequests.get(ask.messageId!)!.dueBy!;
    await waitFor("the deadline passed", () => Date.now() > Date.parse(due));
    await internals(m).checkStall();

    assert.equal(
      m.kernel.state.pendingRequests.has(ask.messageId!),
      true,
      "a human was asked about this exact ask — closing it silently discards the answer they are writing",
    );
  } finally {
    await m.cleanup();
  }
});

// --- refusals --------------------------------------------------------------

test("refusals: a decline settles only the refuser's share of a multi-debtor ask", async () => {
  const m = await makeMesh({
    agents: [
      { id: "architect", role: "architect", capabilities: ["review.design"], interests: [] },
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "qa", role: "qa", capabilities: ["test.run"], interests: [] },
    ],
    mayContact: { architect: ["dev", "qa"], dev: ["architect"], qa: ["architect"] },
    mode: "parked",
  });
  try {
    const ask = await m.supervisor.sendMessage({
      from: "architect", to: ["dev", "qa"], type: "REQUEST",
      newThread: { subject: "review this" }, payload: { q: "review?" },
    });
    const turn = {
      turnId: "t1", agentId: "dev", reason: { kind: "manual" as const },
      sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [],
    } as never;

    const res = await m.supervisor.executeOp("dev", { op: "discharge", messageId: ask.messageId!, reason: "not my area" }, turn);
    assert.equal(res.ok, true, res.reason);
    assert.equal(
      m.kernel.state.pendingRequests.has(ask.messageId!),
      true,
      "qa was asked too and has not answered — one refusal must not close everyone's debt",
    );
    assert.deepEqual(
      m.kernel.state.pendingRequests.get(ask.messageId!)!.outstanding,
      ["qa"],
      "the refuser's obligation is settled; qa's is not",
    );
  } finally {
    await m.cleanup();
  }
});

test("refusals: the creditor is told, and the log says 'refused' rather than 'answered'", async () => {
  const m = await makeMesh({
    agents: twoAgents(),
    mayContact: { architect: ["dev"], dev: ["architect"] },
    mode: "parked",
  });
  try {
    const ask = await m.supervisor.sendMessage({
      from: "architect", to: ["dev"], type: "REQUEST",
      newThread: { subject: "security review" }, payload: { q: "review?" },
    });
    const turn = {
      turnId: "t1", agentId: "dev", reason: { kind: "manual" as const },
      sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [],
    } as never;
    await m.supervisor.executeOp("dev", { op: "discharge", messageId: ask.messageId!, reason: "not mine — ask security" }, turn);

    const rec = m.kernel.state.discharged.find((d) => d.messageId === ask.messageId);
    assert.equal(rec?.reason, "refused", "'reply' would tell a reader of the log the review happened");

    // A refusal IS an answer to the asker: it learned something and can act.
    // Counting it as unanswered would inflate the mesh's stuck-ask metric with
    // the one case that is working as designed.
    const stats = m.supervisor.commitmentStats();
    assert.equal(stats.unanswered, 0, "the asker was told 'no' — that is not a dropped ask");

    // The refuser's own words survive: they are the only thing that tells the
    // asker where to go instead.
    const ev = (await m.store.read())
      .filter((e) => e.type === "commitment.discharged")
      .find((e) => (e.payload as Record<string, unknown>).messageId === ask.messageId);
    const p = ev!.payload as Record<string, unknown>;
    assert.equal(p.declined, true);
    assert.match(String(p.note), /ask security/);

    const notice = [...m.kernel.state.messages.values()]
      .find((x) => x.from === "dev" && (x.payload as Record<string, unknown>)?.declined === true);
    assert.ok(notice, "the asker must receive the decline as mail, not only as a ledger row");
    assert.ok(notice!.to.includes("architect"));
  } finally {
    await m.cleanup();
  }
});

test("refusals: a refusal survives replay as a refusal", async () => {
  const m = await makeMesh({
    agents: twoAgents(),
    mayContact: { architect: ["dev"], dev: ["architect"] },
    mode: "parked",
  });
  try {
    const ask = await m.supervisor.sendMessage({
      from: "architect", to: ["dev"], type: "REQUEST",
      newThread: { subject: "security review" }, payload: { q: "review?" },
    });
    const turn = {
      turnId: "t1", agentId: "dev", reason: { kind: "manual" as const },
      sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [],
    } as never;
    await m.supervisor.executeOp("dev", { op: "discharge", messageId: ask.messageId!, reason: "not mine" }, turn);

    const after = replayed(m, await m.store.read());
    assert.equal(after.pendingRequests.has(ask.messageId!), false);
    assert.equal(
      after.discharged.find((d) => d.messageId === ask.messageId)?.reason,
      "refused",
      "the decline notice carries replyTo, so a replay that ordered these wrong would relabel it 'reply'",
    );
  } finally {
    await m.cleanup();
  }
});

// --- the clock reaches the seat -------------------------------------------

/**
 * The deadline was computed at open, stored on the ledger, and read only by the
 * sweep and the operator's audit file. The seat that gets timed out was never
 * shown it, so an ask could close as "decided without you" for an answer that
 * was never late on any screen the debtor could read.
 */
test("deadlines: the seat that will be timed out reads its own clock", async () => {
  const m = await deadlineMesh({ ttlMs: 600_000 });
  try {
    nobodyAnswers(m);
    const ask = await m.supervisor.sendMessage({
      from: "architect", to: ["dev"], type: "REQUEST",
      newThread: { subject: "which db?" }, payload: { q: "which db?" },
    });
    await quiet(m);
    const due = m.kernel.state.pendingRequests.get(ask.messageId!)!.dueBy!;
    const deps = { config: m.config, kernel: m.kernel };

    // Debtor: the loop it owes, carrying the deadline the sweep will use.
    const debtor = buildAgentContext(deps, "dev");
    assert.equal(debtor.outstanding.owedByYou[0]?.dueBy, due);
    const debtorText = renderContextInstructions(debtor);
    assert.match(debtorText, /YOU OWE architect an answer/);
    assert.ok(
      debtorText.includes(`due by ${due}`),
      "the prompt must name the deadline, not just how long the ask has been open",
    );

    // Asker: the same clock from the other side, so "is it stale" is answerable
    // from the loop instead of by guessing.
    const askerText = renderContextInstructions(buildAgentContext(deps, "architect"));
    assert.ok(askerText.includes(`closes ${due} if unanswered`));
  } finally {
    await m.cleanup();
  }
});

test("deadlines: no TTL regime means no clock, and the prompt claims none", async () => {
  const m = await deadlineMesh({});
  try {
    nobodyAnswers(m);
    await m.supervisor.sendMessage({
      from: "architect", to: ["dev"], type: "REQUEST",
      newThread: { subject: "which db?" }, payload: { q: "which db?" },
    });
    await quiet(m);
    const deps = { config: m.config, kernel: m.kernel };

    const debtor = buildAgentContext(deps, "dev");
    assert.equal(
      debtor.outstanding.owedByYou[0]?.dueBy,
      undefined,
      "no deadline is absent, which is a different statement from one that passed",
    );
    const text = renderContextInstructions(debtor);
    assert.match(text, /YOU OWE architect an answer/);
    assert.doesNotMatch(text, /due by/, "an ask with no clock must not be given one");
  } finally {
    await m.cleanup();
  }
});
