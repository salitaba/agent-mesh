import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, type AgentSpec } from "../helpers";
import type { MeshEvent } from "../../packages/protocol/src/index";

/**
 * The stub can be a bad agent, and each way of being bad reaches the
 * supervisor path it names.
 *
 * Before these modes `interrupt()` was a no-op and nothing streamed, so the
 * silence watchdog and the timeout grace could not be driven; and `simulateProcessDeath` wrote a key nothing read. A
 * mode that exists but lands on the wrong path is worse than none — it makes a
 * test look like it covers a branch it never enters — so every test below
 * asserts on the signature ONLY that branch leaves.
 */

const dev = (over: Partial<AgentSpec> = {}): AgentSpec => ({
  id: "dev",
  role: "developer",
  capabilities: ["repository.read"],
  interests: [],
  ...over,
});

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

const events = (m: Mesh) => m.store.read();
const ofType = async (m: Mesh, type: string): Promise<MeshEvent[]> => (await events(m)).filter((e) => e.type === type);
const payload = (e: MeshEvent | undefined) => (e?.payload ?? {}) as Record<string, unknown>;
const discards = async (m: Mesh) => (await ofType(m, "turn.discarded")).filter((e) => payload(e).agentId === "dev");
const failures = async (m: Mesh) => (await ofType(m, "agent.failed")).filter((e) => payload(e).agentId === "dev");
/** The turn came back with an output, as opposed to failing or still running. */
const answered = (status: string) => status === "ok" || status === "waiting";
const escalationReasons = (m: Mesh) => [...m.kernel.state.escalations.values()].map((e) => e.reason);

// ---- hang: the timeout grace window --------------------------------------

test("hang: a turn that ignores interrupt is settled by the timeout only after the grace window", async () => {
  const TIMEOUT = 300;
  const m = await makeMesh({ agents: [dev()], turnTimeoutMs: TIMEOUT });
  try {
    stub(m).setScript("dev", [{ hang: true }, { operations: [{ op: "wait" }] }]);
    const t0 = Date.now();
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the timeout discard", async () => (await discards(m)).length > 0);
    const elapsed = Date.now() - t0;
    const d = (await discards(m))[0];
    assert.equal(payload(d).reason, "timeout");
    // The interrupt answered nothing, so the bare RuntimeFailure fired after
    // TURN_TIMEOUT_USAGE_GRACE_MS (2000). An interruptible turn settles right
    // at the timeout instead — see the next test — which is what makes this
    // bound evidence that the grace arm ran.
    assert.ok(elapsed >= TIMEOUT + 1800, `settled through the grace window, took ${elapsed}ms`);
    assert.equal(payload(d).tokens, undefined, "an unanswered interrupt reports no usage: unmeasured, not zero");
  } finally {
    await m.cleanup();
  }
});

test("control: an interruptible slow turn is settled at the timeout, with the interrupt's usage", async () => {
  const TIMEOUT = 300;
  const m = await makeMesh({ agents: [dev()], turnTimeoutMs: TIMEOUT });
  try {
    stub(m).setScript("dev", [{ delayMs: 10_000, interruptUsage: { input: 70, output: 7, total: 77 } }, { operations: [{ op: "wait" }] }]);
    const t0 = Date.now();
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the timeout discard", async () => (await discards(m)).length > 0);
    const elapsed = Date.now() - t0;
    const d = (await discards(m))[0];
    assert.equal(payload(d).reason, "timeout");
    assert.ok(elapsed < TIMEOUT + 1500, `the abort answered, so no grace wait: ${elapsed}ms`);
    assert.equal(payload(d).tokens, 77);
  } finally {
    await m.cleanup();
  }
});

// ---- typed failures -------------------------------------------------------

test("throwKind backend_unreachable reaches the dead-backend escalation", async () => {
  // Non-persistent so the first failure is terminal: no respawn ladder.
  const m = await makeMesh({ agents: [dev({ persistent: false })] });
  try {
    stub(m).setScript("dev", [{ throwKind: "backend_unreachable", throwMessage: "connection refused" }]);
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the escalation", () => escalationReasons(m).length > 0);
    assert.deepEqual(escalationReasons(m), ["backend_unreachable"]);
    assert.equal(payload((await failures(m))[0]).error, "stub:dev", "labelled with the backend, which only BackendUnreachableError carries");
  } finally {
    await m.cleanup();
  }
});

test("control: throwKind generic reaches runtime_failure, not backend_unreachable", async () => {
  const m = await makeMesh({ agents: [dev({ persistent: false })] });
  try {
    stub(m).setScript("dev", [{ throwKind: "generic", throwMessage: "model said no" }]);
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the escalation", () => escalationReasons(m).length > 0);
    assert.deepEqual(escalationReasons(m), ["runtime_failure"]);
  } finally {
    await m.cleanup();
  }
});

test("throwKind request_timeout takes the slow-backend retry, not the crash ladder", async () => {
  const m = await makeMesh({ agents: [dev()] });
  try {
    stub(m).setScript("dev", [{ throwKind: "request_timeout" }, { operations: [{ op: "wait" }] }]);
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the restart", async () => (await ofType(m, "agent.restarted")).length > 0);
    assert.equal(escalationReasons(m).length, 0, "a slow backend is retried, never escalated on the first strike");
    const d = (await discards(m))[0];
    assert.equal(payload(d).reason, "timeout", "classified by type as a timeout");
  } finally {
    await m.cleanup();
  }
});

test("throwKind interrupted is classified as silence and carries its usage", async () => {
  const m = await makeMesh({ agents: [dev()] });
  try {
    stub(m).setScript("dev", [{ throwKind: "interrupted", interruptUsage: { input: 10, output: 2, total: 12 } }, { operations: [{ op: "wait" }] }]);
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the discard", async () => (await discards(m)).length > 0);
    const d = (await discards(m))[0];
    assert.equal(payload(d).reason, "silence");
    assert.equal(payload(d).tokens, 12);
  } finally {
    await m.cleanup();
  }
});

// ---- process death ----------------------------------------------------------

test("simulateProcessDeath: the next turn fails as a dead backend, and a respawn recovers", async () => {
  const m = await makeMesh({ agents: [dev()] });
  try {
    stub(m).setScript("dev", [{ operations: [{ op: "wait" }] }, { operations: [{ op: "wait" }] }]);
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the first turn", () => m.supervisor.getRecentTurns().some((t) => t.agentId === "dev" && answered(t.status)));
    assert.equal((await failures(m)).length, 0, "fixture: the live seat answered");

    stub(m).simulateProcessDeath("dev");
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the failure", async () => (await failures(m)).length > 0);
    assert.equal(payload((await failures(m))[0]).error, "stub:dev", "the dead process surfaces as BackendUnreachableError");
    // The restart `handleAgentFailure` schedules starts a new session, which
    // brings the process back.
    await waitFor("the recovered turn", () => m.supervisor.getRecentTurns().filter((t) => t.agentId === "dev" && answered(t.status)).length >= 2);
    assert.equal(stub(m).isDead("dev"), false);
  } finally {
    await m.cleanup();
  }
});

test("simulateProcessDeath permanent: the respawn ladder runs out and escalates backend_unreachable", async () => {
  const m = await makeMesh({ agents: [dev()] });
  try {
    stub(m).setScript("dev", [{ operations: [{ op: "wait" }] }]);
    stub(m).simulateProcessDeath("dev", { permanent: true });
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the escalation", () => escalationReasons(m).includes("backend_unreachable"));
    assert.equal((await failures(m)).length, 4, "three respawns, then the terminal fourth failure");
  } finally {
    await m.cleanup();
  }
});

// ---- streaming ---------------------------------------------------------------

test("streaming: token frames reach onToken, so firstTokenAt is stamped", async () => {
  const m = await makeMesh({ agents: [dev()] });
  try {
    stub(m).setStreaming(true);
    stub(m).setScript("dev", [{ tokens: ["hel", "lo"], text: "hello", operations: [{ op: "wait" }] }]);
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the turn", () => m.supervisor.getRecentTurns().some((t) => t.agentId === "dev" && t.status !== "running"));
    const t = m.supervisor.getRecentTurns().find((x) => x.agentId === "dev" && x.status !== "running");
    assert.ok(t?.phases?.firstTokenAt !== undefined, "the silence detector can see this turn speak");
    assert.ok(t?.phases?.lastTokenAt !== undefined);
  } finally {
    await m.cleanup();
  }
});

test("control: on the send path no token ever fires", async () => {
  const m = await makeMesh({ agents: [dev()] });
  try {
    stub(m).setScript("dev", [{ text: "hello", operations: [{ op: "wait" }] }]);
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the turn", () => m.supervisor.getRecentTurns().some((t) => t.agentId === "dev" && t.status !== "running"));
    const t = m.supervisor.getRecentTurns().find((x) => x.agentId === "dev" && x.status !== "running");
    assert.equal(t?.phases?.firstTokenAt, undefined);
  } finally {
    await m.cleanup();
  }
});

test("stream-only fields on the send path fail loudly instead of being ignored", async () => {
  const m = await makeMesh({ agents: [dev({ persistent: false })] });
  try {
    stub(m).setScript("dev", [{ tokens: ["a"] }]);
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the failure", async () => (await failures(m)).length > 0);
    assert.match(String(payload((await failures(m))[0]).error), /streaming is off/);
  } finally {
    await m.cleanup();
  }
});

// Silence watchdog: ticks every stallIdleMs/3 (floor 100ms) and only once a
// turn has spoken. A long turn timeout keeps the timeout arm out of the way.
const SILENCE = { turnSilenceMs: 200, stallIdleMs: 300, turnTimeoutMs: 30_000 };

test("silentAfterTokens: the silence watchdog interrupts, and the abort is discarded as silence", async () => {
  const m = await makeMesh({ agents: [dev()], ...SILENCE });
  try {
    stub(m).setStreaming(true);
    stub(m).setScript("dev", [{ tokens: ["one ", "two ", "three"], silentAfterTokens: 1 }, { operations: [{ op: "wait" }] }]);
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the silence discard", async () => (await discards(m)).length > 0, 8000);
    assert.equal(payload((await discards(m))[0]).reason, "silence");
  } finally {
    await m.cleanup();
  }
});

test("silentAfterTokens + hang: an ignored interrupt is force-settled by the watchdog", async () => {
  const m = await makeMesh({ agents: [dev()], ...SILENCE });
  try {
    stub(m).setStreaming(true);
    stub(m).setScript("dev", [{ tokens: ["one ", "two"], silentAfterTokens: 1, hang: true }, { operations: [{ op: "wait" }] }]);
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    // The forced settle is the ONLY site that fails a turn with this message,
    // and it runs outside runTurn, so no turn.discarded accompanies it.
    await waitFor("the forced settle", async () => (await failures(m)).some((e) => /turn silence exceeded 200ms/.test(String(payload(e).error))), 8000);
  } finally {
    // The hung send is still parked; let it go before close waits on it.
    stub(m).releaseHangs();
    await m.cleanup();
  }
});

test("dieAfterFrames: a stream that closes without turn_end fails the turn as a transport error", async () => {
  const m = await makeMesh({ agents: [dev({ persistent: false })] });
  try {
    stub(m).setStreaming(true);
    stub(m).setScript("dev", [{ tokens: ["a", "b", "c"], dieAfterFrames: 2 }]);
    await m.supervisor.activateAgent("dev", { kind: "manual" }, { explicit: true });
    await waitFor("the failure", async () => (await failures(m)).length > 0);
    assert.match(String(payload((await failures(m))[0]).error), /ended without a turn_end frame/);
  } finally {
    await m.cleanup();
  }
});
