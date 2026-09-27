import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, collectEvents, type AgentSpec } from "../helpers";
import { createHttpServer, closeHttpServer } from "../../apps/mesh-server/src/index";
import { abnormalTurnNote } from "../../packages/core/src/turn-tracker";
import type { MeshEvent } from "../../packages/protocol/src/index";

/**
 * An operator can stop ONE running turn, and the stop is not a failure.
 *
 * Before `Supervisor.interruptTurn` there was no way to. `POST /agents/:id/suspend`
 * tore the session down under the live turn; the runtime settled the pending call
 * as a dead backend ("session torn down"), `handleAgentFailure` wrote
 * `agent.failed` + `agent.restarted` + IDLE, and its recovery wake ran ~20 ms
 * later — so the suspension was undone and the seat was working again.
 *
 * Every scripted slow turn below is a StubRuntime `delayMs`, which is a REAL
 * timer the stub's `interrupt` clears. Each test stops it (or lets it run out in
 * well under the test's own budget), so nothing outlives the test.
 */

const USAGE = { input: 900, output: 100, total: 1000 };
/** Long enough that only the stop can end it; short enough that a test failing before the stop does not hang. */
const SLOW_MS = 5000;

const AGENTS: AgentSpec[] = [
  { id: "dev", role: "developer", capabilities: ["repository.read"], interests: [], tokens: 500_000 },
  { id: "qa", role: "qa", capabilities: ["repository.read"], interests: [], tokens: 500_000 },
];

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

const ofType = async (m: Mesh, type: string, agentId = "dev"): Promise<MeshEvent[]> =>
  (await collectEvents(m)).filter((e) => e.type === type && (e.payload as { agentId?: string }).agentId === agentId);
const lifecycle = (m: Mesh, agentId = "dev") => m.kernel.state.agents.get(agentId)?.state.lifecycle;
const counters = (m: Mesh) =>
  m.supervisor as unknown as { restartAttempts: Map<string, number>; timeoutRetries: Map<string, number>; unreachableStreak: Map<string, number> };
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A mesh whose `dev` seat's FIRST turn sits in the model for `SLOW_MS` (and
 * reports `USAGE` when aborted); every later turn answers at once. Resolves once
 * that first turn is inside the runtime call, where an interrupt can reach it.
 */
async function meshWithSlowTurn(extra: { qaDelayMs?: number } = {}): Promise<{ m: Mesh }> {
  const m = await makeMesh({ agents: AGENTS, mayContact: { dev: ["qa"], qa: ["dev"] }, startup: [], autoRaise: { enabled: false } });
  let started = false;
  stub(m).setScript("dev", async (_input, idx) => {
    if (idx === 0) {
      started = true;
      return { delayMs: SLOW_MS, interruptUsage: USAGE };
    }
    return { text: "later turn", operations: [{ op: "done" }] };
  });
  if (extra.qaDelayMs !== undefined) {
    stub(m).setScript("qa", async () => ({ delayMs: extra.qaDelayMs, text: "qa turn", operations: [{ op: "done" }] }));
  }
  await m.supervisor.activateAgent("dev", { kind: "manual" });
  await waitFor("dev's slow turn is in the model", () => started && m.supervisor.isTurnInFlight("dev"), 5000);
  return { m };
}

test("interrupt stops the running turn as `interrupted`: billed, not a failure, seat IDLE", async () => {
  const { m } = await meshWithSlowTurn();
  try {
    const res = await m.supervisor.interruptTurn("dev", { reason: "runaway edit loop" });
    assert.equal(res.ok, true, JSON.stringify(res));
    if (!res.ok) return;
    assert.equal(res.settled, true, "the call waits for the turn to close");
    assert.equal(res.endedAs, "interrupted");
    assert.equal(res.lifecycle, "IDLE");

    const [discarded, ...more] = await ofType(m, "turn.discarded");
    assert.equal(more.length, 0, "one turn, one discard");
    const p = discarded?.payload as { reason?: string; detail?: string; tokens?: number; turnId?: string };
    assert.equal(p.reason, "interrupted");
    assert.equal(p.turnId, res.turnId);
    assert.match(String(p.detail), /stopped by the operator: runaway edit loop/, "the detail says who stopped it and why");
    assert.equal(p.tokens, 1000, "what the aborted call reported spending");

    // Billed exactly as the budget stop bills: the discard's figure, settled on the seat's ledger.
    const billed = (await collectEvents(m)).filter(
      (e) => e.type === "budget.consumed" && e.correlationId === res.turnId && String((e.payload as { key?: string }).key).startsWith("agent:"),
    );
    assert.equal(billed.length, 1, "the stopped turn is billed once on the agent ledger");
    assert.equal((billed[0]!.payload as { amount?: number }).amount, 1000);

    // Not a failure: nothing on the failure path ran.
    assert.equal((await ofType(m, "agent.failed")).length, 0, "no agent.failed");
    assert.equal((await ofType(m, "agent.restarted")).length, 0, "no agent.restarted");
    assert.equal(counters(m).restartAttempts.get("dev"), undefined, "no crash strike");
    assert.equal(counters(m).timeoutRetries.get("dev"), undefined, "no slow-turn strike");
    assert.equal(counters(m).unreachableStreak.get("dev"), undefined, "no unreachable strike");

    const rec = m.supervisor.getTurn(res.turnId);
    assert.equal(rec?.status, "blocked", "the ring does not count an operator stop as a crashed turn");
    assert.equal(rec?.tokens, 1000);

    // The seat is told, in the note its next turn opens with.
    const notes = (await collectEvents(m))
      .filter((e) => e.type === "memory.updated")
      .map((e) => (e.payload as { note?: { key?: string; value?: string } }).note)
      .filter((n) => n?.key === `turn:${res.turnId}`);
    assert.equal(notes.length, 1, "an operator stop leaves the seat its turn note");
    assert.match(String(notes[0]?.value), /stopped by the operator/);
    assert.match(String(notes[0]?.value), /files it already wrote are still on disk/);

    // No recovery wake: the old suspend path's restart fired ~20 ms after the failure.
    await pause(300);
    assert.equal(lifecycle(m), "IDLE", "nothing re-woke the seat");
    assert.equal((await ofType(m, "agent.awakened")).length, 1, "still only the stopped turn");

    // ...and it can be woken normally afterwards.
    const again = await m.supervisor.activateAgent("dev", { kind: "manual" });
    assert.equal(again.queued, true, again.blocked);
    await waitFor("dev's next turn ran", async () => (await ofType(m, "agent.awakened")).length === 2 && !m.supervisor.isTurnInFlight("dev"), 5000);
  } finally {
    await m.cleanup();
  }
});

test("interrupt with suspend leaves the seat SUSPENDED through new mail, until resume", async () => {
  const { m } = await meshWithSlowTurn();
  try {
    const res = await m.supervisor.interruptTurn("dev", { suspend: true });
    assert.equal(res.ok, true, JSON.stringify(res));
    if (!res.ok) return;
    assert.equal(res.endedAs, "interrupted");
    assert.equal(lifecycle(m), "SUSPENDED");
    const d = (await ofType(m, "turn.discarded"))[0]?.payload as { detail?: string };
    assert.match(String(d.detail), /stopped by the operator \(seat suspended\)/);

    const sent = await m.supervisor.sendMessage({ from: "qa", to: ["dev"], type: "INFORM", newThread: { subject: "while you were out" }, payload: { news: 1 } });
    assert.equal(sent.accepted, true, sent.reason);
    await pause(400);
    assert.equal(lifecycle(m), "SUSPENDED", "mail does not wake a suspended seat");
    assert.equal((await ofType(m, "agent.awakened")).length, 1, "and no turn started");
    assert.equal((await ofType(m, "agent.failed")).length, 0);
    assert.equal((await ofType(m, "agent.restarted")).length, 0);
    const refused = await m.supervisor.activateAgent("dev", { kind: "manual" });
    assert.equal(refused.queued, false, "an operator wake is refused too, by lifecycle");

    await m.supervisor.resumeAgent("dev");
    assert.equal(lifecycle(m), "IDLE", "resume restores it");
    // Queued mail may already have woken it; if not, an operator wake does.
    const woke = await m.supervisor.activateAgent("dev", { kind: "manual" });
    assert.ok(woke.queued || (await ofType(m, "agent.awakened")).length > 1, woke.blocked);
    await waitFor("dev takes a turn again", async () => (await ofType(m, "agent.awakened")).length >= 2, 5000);
  } finally {
    await m.cleanup();
  }
});

test("the session survives a stop the runtime answered, and is dropped when the stop had to be forced", async () => {
  const sessions = (m: Mesh) => (m.supervisor as unknown as { sessions: Map<string, unknown> }).sessions;
  const answered = await meshWithSlowTurn();
  try {
    const res = await answered.m.supervisor.interruptTurn("dev");
    assert.equal(res.ok && res.endedAs, "interrupted");
    assert.equal(sessions(answered.m).has("dev"), true, "an answered abort leaves the session between turns, so it is kept");
  } finally {
    await answered.m.cleanup();
  }

  // A backend that ignores the interrupt: only the forced settle ends the call.
  const m = await makeMesh({ agents: AGENTS, mayContact: { dev: [], qa: [] }, startup: [], autoRaise: { enabled: false } });
  try {
    let started = false;
    stub(m).setScript("dev", async (_input, idx) => {
      if (idx === 0) started = true;
      return idx === 0 ? { hang: true } : { text: "later", operations: [{ op: "done" }] };
    });
    await m.supervisor.activateAgent("dev", { kind: "manual" });
    await waitFor("dev's hung turn is in the model", () => started && m.supervisor.isTurnInFlight("dev"), 5000);
    const res = await m.supervisor.interruptTurn("dev", { reason: "hung" });
    assert.equal(res.ok, true, JSON.stringify(res));
    if (!res.ok) return;
    assert.equal(res.endedAs, "interrupted", "forced, and still an operator stop rather than a failure");
    assert.equal(lifecycle(m), "IDLE");
    assert.equal((await ofType(m, "agent.failed")).length, 0);
    const d = (await ofType(m, "turn.discarded"))[0]?.payload as { tokens?: number };
    assert.equal(d.tokens, undefined, "nothing answered, so nothing was measured — not zero");
    assert.equal(sessions(m).has("dev"), false, "nothing confirmed the backend stopped, so its session is not reused");
  } finally {
    await m.cleanup();
  }
});

test("interrupting one seat leaves another seat's running turn alone", async () => {
  const { m } = await meshWithSlowTurn({ qaDelayMs: 700 });
  try {
    await m.supervisor.activateAgent("qa", { kind: "manual" });
    await waitFor("qa's turn is running", () => m.supervisor.isTurnInFlight("qa"), 5000);
    const res = await m.supervisor.interruptTurn("dev", { reason: "only dev" });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(m.supervisor.isTurnInFlight("qa"), true, "qa is still working when dev's stop has closed");
    await waitFor("qa's turn finished on its own", () => !m.supervisor.isTurnInFlight("qa"), 5000);
    assert.equal((await ofType(m, "turn.discarded", "qa")).length, 0, "qa's turn was not discarded");
    const qaTurn = m.supervisor.getRecentTurns(20).find((t) => t.agentId === "qa");
    assert.equal(qaTurn?.status, "ok");
  } finally {
    await m.cleanup();
  }
});

test("interrupt with no running turn says so, and changes nothing", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: { dev: [], qa: [] }, startup: [], mode: "parked" });
  try {
    const res = await m.supervisor.interruptTurn("dev");
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.equal(res.code, "no_running_turn");
    assert.match(res.error, /no running turn/);
    const unknown = await m.supervisor.interruptTurn("nobody");
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.equal(unknown.code, "unknown_agent");
    assert.equal((await collectEvents(m)).filter((e) => e.type === "turn.discarded").length, 0);
  } finally {
    await m.cleanup();
  }
});

async function post(base: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

async function withServer(m: Mesh, fn: (base: string) => Promise<void>): Promise<void> {
  const server = createHttpServer(m, { dashboardDir: undefined });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  } finally {
    await closeHttpServer(server);
  }
}

test("POST /agents/:id/interrupt: 200 with the stopped turn, 409 with none running, 404 for an unknown seat", async () => {
  const { m } = await meshWithSlowTurn();
  try {
    await withServer(m, async (base) => {
      const stopped = await post(base, "/agents/dev/interrupt", { reason: "operator says stop" });
      assert.equal(stopped.status, 200, JSON.stringify(stopped.json));
      assert.match(String(stopped.json.turnId), /^turn-/);
      assert.equal(stopped.json.endedAs, "interrupted");
      assert.equal(stopped.json.lifecycle, "IDLE");

      const idle = await post(base, "/agents/dev/interrupt");
      assert.equal(idle.status, 409, JSON.stringify(idle.json));
      assert.match(String(idle.json.error), /no running turn/);

      const unknown = await post(base, "/agents/nobody/interrupt");
      assert.equal(unknown.status, 404);

      const bad = await post(base, "/agents/dev/interrupt", { suspend: "yes" });
      assert.equal(bad.status, 400, "a malformed body is refused, not read as false");
    });
  } finally {
    await m.cleanup();
  }
});

test("POST /agents/:id/suspend on a seat mid-turn stops the turn and the suspension sticks", async () => {
  const { m } = await meshWithSlowTurn();
  try {
    await withServer(m, async (base) => {
      const res = await post(base, "/agents/dev/suspend");
      assert.equal(res.status, 200, JSON.stringify(res.json));
      assert.match(String(res.json.stoppedTurnId), /^turn-/, "the route names the turn it stopped");
      assert.equal(lifecycle(m), "SUSPENDED");
      // Past the ~20 ms recovery wake the old path scheduled, with room to spare.
      await pause(400);
      assert.equal(lifecycle(m), "SUSPENDED", "the suspension was not undone by the turn's own ending");
      assert.equal((await ofType(m, "agent.failed")).length, 0, "the stop is not recorded as a failure");
      assert.equal((await ofType(m, "agent.restarted")).length, 0, "and nothing restarted the seat");
      const d = (await ofType(m, "turn.discarded"))[0]?.payload as { reason?: string; detail?: string };
      assert.equal(d.reason, "interrupted");
      assert.match(String(d.detail), /stopped by the operator \(seat suspended\)/);

      const resumed = await post(base, "/agents/dev/resume");
      assert.equal(resumed.status, 200);
      assert.equal(lifecycle(m), "IDLE");
    });
  } finally {
    await m.cleanup();
  }
});

test("the operator-stop note says who stopped the turn and that its files survive", () => {
  const note = abnormalTurnNote({ reason: "interrupted", tokens: 5, detail: "stopped by the operator: wrong branch" }, 12_000);
  assert.match(note, /was stopped by the operator after 12s having spent 5 tokens/);
  assert.match(note, /not a failure/);
  assert.match(note, /files it already wrote are still on disk/);
  assert.match(note, /stopped by the operator: wrong branch/);
  assert.doesNotMatch(note, /backend failure|went silent|turn timeout/, "never worded as one of the failure endings");
  // The other endings keep their words.
  assert.match(abnormalTurnNote({ reason: "silence", tokens: 5 }, 1000), /output stream went silent/);
  assert.doesNotMatch(abnormalTurnNote({ reason: "silence", tokens: 5 }, 1000), /stopped by the operator/);
});
