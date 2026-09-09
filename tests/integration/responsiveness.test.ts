import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { makeMesh } from "../helpers";
import { createHttpServer, closeHttpServer } from "../../apps/mesh-server/src/index";
import { HttpRuntimeAdapter } from "../../packages/runtime-http/src/index";
import { OpenCodeRuntimeAdapter } from "../../packages/runtime-opencode/src/index";

/** A backend that accepts the connection but never responds — the "server not
 *  responding" case. Honors abort like a real fetch so timeouts can fire. */
const hangingFetch = ((_url: unknown, opts?: { signal?: AbortSignal }): Promise<Response> =>
  new Promise((_resolve, reject) => {
    const signal = opts?.signal;
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  })) as typeof fetch;

test("http runtime: control-plane calls fail fast against a hanging backend", async () => {
  const adapter = new HttpRuntimeAdapter({
    baseUrl: "http://127.0.0.1:9",
    fetchImpl: hangingFetch,
    requestTimeoutMs: 600000,
    controlTimeoutMs: 100,
  });
  const agent = { id: "a1", role: "a1" } as never;
  const ctx = { capabilityGrants: [], meshId: "m", goalId: "g" } as never;

  let t0 = Date.now();
  // start() degrades to a local session instead of throwing, but it must
  // still return promptly rather than hang on the dead backend.
  const session0 = await adapter.start(agent, ctx);
  assert.ok(session0.sessionId, "start falls back to a local session");
  assert.ok(Date.now() - t0 < 5000, `start hung ${Date.now() - t0}ms (control timeout ignored)`);

  const session = { sessionId: "s1", agentId: "a1", runtime: "http", createdAt: new Date().toISOString(), handle: null } as never;
  t0 = Date.now();
  assert.equal(await adapter.getStatus(session), "UNREACHABLE");
  assert.ok(Date.now() - t0 < 5000, `getStatus hung ${Date.now() - t0}ms`);

  t0 = Date.now();
  await Promise.all([adapter.interrupt(session), adapter.suspend(session), adapter.resume(session), adapter.stop(session)]);
  assert.ok(Date.now() - t0 < 5000, `control calls hung ${Date.now() - t0}ms`);
});

test("http runtime: model work (send) keeps the long timeout", async () => {
  const adapter = new HttpRuntimeAdapter({
    baseUrl: "http://127.0.0.1:9",
    fetchImpl: hangingFetch,
    requestTimeoutMs: 150,
    controlTimeoutMs: 50,
  });
  const session = { sessionId: "s1", agentId: "a1", runtime: "http", createdAt: new Date().toISOString(), handle: null } as never;
  const t0 = Date.now();
  await assert.rejects(() =>
    adapter.send(session, { agentId: "a1", goalId: "g", activation: { kind: "manual" }, context: {}, instructions: "hi" } as never),
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 100 && elapsed < 5000, `send used ${elapsed}ms, expected ~requestTimeoutMs (150ms)`);
});

test("opencode runtime: session setup fails fast against a hanging backend", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-opencode-ctl-"));
  try {
    const adapter = new OpenCodeRuntimeAdapter({
      spawnProcesses: false,
      baseUrl: "http://127.0.0.1:9",
      fetchImpl: hangingFetch,
      requestTimeoutMs: 600000,
      controlTimeoutMs: 100,
    });
    const agent = { id: "a1", role: "a1", mode: "peer", runtime: "opencode", capabilities: [], authority: [] } as never;
    const ctx = {
      goalId: "g",
      meshId: "m",
      workspacePath: dir,
      busUrl: "http://127.0.0.1:1",
      agentToken: "m:a1:tok",
      rolePromptText: "role",
      capabilityGrants: [],
      env: {},
    } as never;
    const t0 = Date.now();
    await assert.rejects(() => adapter.start(agent, ctx));
    assert.ok(Date.now() - t0 < 5000, `opencode start hung ${Date.now() - t0}ms`);

    const session = {
      sessionId: "s1",
      agentId: "a1",
      runtime: "opencode",
      createdAt: new Date().toISOString(),
      handle: { baseUrl: "http://127.0.0.1:9" },
    } as never;
    const t1 = Date.now();
    await adapter.interrupt(session);
    assert.ok(Date.now() - t1 < 5000, `opencode interrupt hung ${Date.now() - t1}ms`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("server close resolves with an open dashboard SSE stream", async () => {
  const m = await makeMesh({
    agents: [{ id: "a1", role: "a1", capabilities: [], interests: [] }],
    mayContact: { a1: [] },
    mode: "parked",
  });
  const server = createHttpServer(m, { dashboardDir: undefined });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const ctrl = new AbortController();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/events/stream`, { signal: ctrl.signal });
    assert.equal(res.status, 200);
    const t0 = Date.now();
    await closeHttpServer(server, 3000);
    assert.ok(Date.now() - t0 < 8000, `close hung ${Date.now() - t0}ms with SSE open`);
  } finally {
    ctrl.abort();
    await m.cleanup();
  }
});

test("watchdog collapses event bursts instead of scanning per event", async () => {
  const m = await makeMesh({
    agents: [{ id: "a1", role: "a1", capabilities: [], interests: [] }],
    mayContact: { a1: [] },
    mode: "parked",
  });
  try {
    const detector = (m.supervisor as unknown as { detector: { scan: (...args: never[]) => unknown[] } }).detector;
    let scans = 0;
    const orig = detector.scan.bind(detector);
    detector.scan = ((...args: never[]) => {
      scans++;
      return orig(...args);
    }) as typeof detector.scan;
    for (let i = 0; i < 20; i++) {
      // Bookkeeping churn (per-turn budget ledger moves): throttled path.
      await m.supervisor.deps.budget.reserve(`probe:${i}`, "tokens", 1, null, { actorId: "a1" });
    }
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(scans <= 3, `burst of 20 events caused ${scans} full-state watchdog scans`);
  } finally {
    await m.cleanup();
  }
});

test("health reports event-loop lag", async () => {
  const m = await makeMesh({
    agents: [{ id: "a1", role: "a1", capabilities: [], interests: [] }],
    mayContact: { a1: [] },
    mode: "parked",
  });
  const server = createHttpServer(m, { dashboardDir: undefined });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const body = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as {
      ok: boolean;
      eventLoopLagMs: number;
      eventLoopLagMaxMs: number;
    };
    assert.equal(body.ok, true);
    assert.equal(typeof body.eventLoopLagMs, "number");
    assert.equal(typeof body.eventLoopLagMaxMs, "number");
  } finally {
    await closeHttpServer(server);
    await m.cleanup();
  }
});

test("halted mission parks the scheduler instead of queuing dead turns", async () => {
  const m = await makeMesh({
    agents: [{ id: "a1", role: "a1", capabilities: [], interests: [] }],
    mayContact: { a1: [] },
    mode: "live",
  });
  const server = createHttpServer(m, { dashboardDir: undefined });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    // Live mission: activation admitted.
    assert.equal(await m.scheduler.requestActivation({ agentId: "a1", reason: { kind: "manual" }, priority: 5, explicit: true }), true);
    // Let that turn fully finish first: otherwise the next activation hits
    // the still-running turn and returns true via the wake-after-turn slot,
    // which would make the halt assertion racy.
    const deadline = Date.now() + 8000;
    while ((m.scheduler.pending() > 0 || m.scheduler.running() > 0) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(m.scheduler.running(), 0, "seed turn must finish before halting");
    // Halt the mission: the same activation must now be refused, or queued
    // turns pile up behind runTurn's silent early-return and requeue forever
    // in a timer-free microtask loop (full "server not responding" wedge that
    // emits nothing, so the log looks merely frozen).
    await m.kernel.emit("goal.escalated", { goalId: m.kernel.state.activeGoalId, reason: "test halt" }, { actorId: "human" });
    assert.equal(await m.scheduler.requestActivation({ agentId: "a1", reason: { kind: "manual" }, priority: 5, explicit: true }), false);
    assert.equal(m.scheduler.pending(), 0, "no turns may queue while the mission is halted");
    // Kicking notify (as any finishing turn would) must park, not requeue.
    (m.scheduler as unknown as { notifyTurnFinished(agentId: string): void }).notifyTurnFinished("a1");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(m.scheduler.pending(), 0, "notify must not requeue on a halted mission");
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(`${base}/health`, { signal: ctrl.signal });
      assert.equal(res.status, 200);
    } finally {
      clearTimeout(t);
    }
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await m.cleanup();
  }
});

test("agent detail stays correct and fast past the recency window", async () => {  const m = await makeMesh({
    agents: [{ id: "a1", role: "a1", capabilities: [], interests: [] }],
    mayContact: { a1: [] },
    mode: "parked",
  });
  const server = createHttpServer(m, { dashboardDir: undefined });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    for (let i = 0; i < 250; i++) {
      await m.supervisor.humanSend(["a1"], "INFORM", { n: i });
    }
    const t0 = Date.now();
    const res = await fetch(`http://127.0.0.1:${port}/agents/a1`);
    const body = (await res.json()) as {
      stats: { messagesReceived: number };
      recentMessages: Array<{ payload: { n: number } }>;
    };
    assert.equal(res.status, 200);
    assert.ok(Date.now() - t0 < 10000, `agent detail took ${Date.now() - t0}ms`);
    assert.equal(body.stats.messagesReceived, 250);
    assert.equal(body.recentMessages.length, 20);
    assert.equal(body.recentMessages[0].payload.n, 249, "most recent message first");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await m.cleanup();
  }
});

test("blocked turns finish their step instead of lingering as running", async () => {
  const m = await makeMesh({
    agents: [{ id: "a1", role: "a1", capabilities: [], interests: [] }],
    mayContact: { a1: [] },
    mode: "parked",
    threadTokens: 1000,
  });
  try {
    // Spend exactly to the thread limit: no exceeded flag (strict >), so the
    // activation is admitted — but the 32k thread reservation then has zero
    // headroom and blocks inside the turn. Thread ledgers never escalate the
    // mission, so the run stays interference-free.
    const goalId = m.kernel.state.activeGoalId!;
    await m.supervisor.deps.budget.consume(`thread:${goalId}/t1`, "tokens", 1000);
    const r = await m.supervisor.activateAgent("a1", { kind: "manual", threadId: "t1" });
    assert.equal(r.queued, true);
    const deadline = Date.now() + 5000;
    while (m.supervisor.getRecentTurns(5).every((t) => t.status === "running") && Date.now() < deadline) {
      await new Promise((r2) => setTimeout(r2, 25));
    }
    const step = m.supervisor.getRecentTurns(5).find((t) => t.agentId === "a1");
    assert.ok(step, "blocked turn must leave a trace");
    assert.equal(step.status, "blocked", `blocked turn shows ${step.status}, must not linger as running`);
  } finally {
    await m.cleanup();
  }
});

test("reboot closes restart-abandoned turns instead of showing them running", async () => {
  const m = await makeMesh({
    agents: [{ id: "a1", role: "a1", capabilities: [], interests: [] }],
    mayContact: { a1: [] },
    mode: "parked",
  });
  try {
    // A turn the log shows as started but never finished (previous process died).
    await m.kernel.emit("agent.started", { agentId: "a1", sessionId: null, runtime: "stub" }, { actorId: "a1" });
    await m.kernel.emit("agent.awakened", { agentId: "a1", reason: { kind: "manual" }, turnId: "turn-abandoned-1" }, { actorId: "a1" });
    await m.supervisor.boot({ mode: "parked" });
    const closes = (await m.store.read({ types: ["agent.state_changed"] as never })).filter(
      (e) => ((e.payload as { turnId?: string }).turnId === "turn-abandoned-1") && ((e.payload as { to?: string }).to === "IDLE"),
    );
    assert.equal(closes.length, 1, "abandoned turn must be closed exactly once");
    assert.match(String((closes[0].payload as { note?: string }).note ?? ""), /abandoned/);
    // Second boot is idempotent: the turn is already closed, nothing new.
    // (A second boot mints a fresh goal — count only closes of our turn.)
    const closesOf = async () =>
      (await m.store.read({ types: ["agent.state_changed"] as never })).filter(
        (e) => ((e.payload as { turnId?: string }).turnId === "turn-abandoned-1") && ((e.payload as { to?: string }).to === "IDLE"),
      );
    assert.equal((await closesOf()).length, 1);
    await m.supervisor.boot({ mode: "parked" });
    assert.equal((await closesOf()).length, 1, "reboot must not re-close finished turns");
  } finally {
    await m.cleanup();
  }
});
