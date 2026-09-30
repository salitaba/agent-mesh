import { test } from "node:test";
import assert from "node:assert/strict";
import { stub, waitFor } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";
import { ManualClock, makeClockedMesh, settle } from "../support/manual-clock";
import {
  PROVIDER_BACKOFF_INITIAL_MS,
  PROVIDER_BACKOFF_MAX_MS,
  PROVIDER_TRIP_FAILURES,
  PROVIDER_TRIP_WINDOW_MS,
  providerBackoffMs,
} from "../../packages/scheduler/src/index";

/**
 * The scheduler half of the provider breaker, driven through its one input
 * (`noteTurnOutcome` with `outage`) on a manual clock. The supervisor half —
 * classification, the card, the probe's verdict from a real turn — is
 * `tests/core/provider-breaker.test.ts`.
 */

const AGENTS = [
  { id: "dev", role: "developer", interests: [] },
  { id: "qa", role: "qa", interests: [] },
  { id: "pm", role: "pm", interests: [] },
];

async function mesh(clock: ManualClock) {
  return makeClockedMesh({ agents: AGENTS, mayContact: { dev: [], qa: [], pm: [] }, waitWakeupMs: 60_000, wallClockMinutes: 1_000 }, clock);
}

const ERR = "claude turn failed: success — API Error: 402 [402]: This model requires an opencode API key — add one in Settings → Providers. — terminated: api_error";

test("provider breaker: the backoff schedule is 5, 10, 20, 40 minutes, then capped at an hour", () => {
  const minutes = [1, 2, 3, 4, 5, 6, 7].map((n) => providerBackoffMs(n) / 60_000);
  assert.deepEqual(minutes, [5, 10, 20, 40, 60, 60, 60]);
  assert.equal(PROVIDER_BACKOFF_INITIAL_MS, 300_000);
  assert.equal(PROVIDER_BACKOFF_MAX_MS, 3_600_000);
  assert.equal(PROVIDER_TRIP_FAILURES, 3);
  assert.equal(PROVIDER_TRIP_WINDOW_MS, 120_000);
});

test("provider breaker: outages from any seats trip it at three, and never strike a seat", async () => {
  const clock = new ManualClock(Date.now());
  const m = await mesh(clock);
  try {
    m.scheduler.noteTurnOutcome("dev", "outage", { error: ERR });
    m.scheduler.noteTurnOutcome("dev", "outage", { error: ERR });
    assert.equal(m.scheduler.providerBreaker().state, "closed", "two is not a trip");
    assert.equal(m.scheduler.isParkedForBackoff("dev"), false);
    m.scheduler.noteTurnOutcome("dev", "outage", { error: ERR });
    const b = m.scheduler.providerBreaker();
    assert.equal(b.state, "open", "three from one seat trips it too: a quiet mesh may have only one seat working");
    assert.equal(m.scheduler.isParkedForBackoff("dev"), false, "an outage is never the seat's strike");
    assert.equal(b.failedTurns, 3);
    assert.deepEqual(b.seats, ["dev"]);
    assert.equal(b.lastError, ERR);
    assert.equal(b.opens, 1);
    assert.equal(b.nextProbeAt, clock.nowMs() + PROVIDER_BACKOFF_INITIAL_MS);

    // Refusals from turns already in flight are counted for the card, and move nothing.
    m.scheduler.noteTurnOutcome("qa", "outage", { error: "API Error: 529 overloaded" });
    const after = m.scheduler.providerBreaker();
    assert.equal(after.state, "open");
    assert.equal(after.failedTurns, 4);
    assert.deepEqual(after.seats, ["dev", "qa"]);
    assert.equal(after.opens, 1, "not a re-open");
    assert.equal(after.nextProbeAt, b.nextProbeAt, "the backoff did not move");
    await waitFor("the supervisor raised the card", () => [...m.kernel.state.escalations.values()].some((e) => e.reason === "provider_unavailable"));
  } finally {
    await m.cleanup();
  }
});

test("provider breaker: the trip window is two minutes", async () => {
  const clock = new ManualClock(Date.now());
  const m = await mesh(clock);
  try {
    m.scheduler.noteTurnOutcome("dev", "outage", { error: ERR });
    m.scheduler.noteTurnOutcome("qa", "outage", { error: ERR });
    clock.advance(PROVIDER_TRIP_WINDOW_MS);
    m.scheduler.noteTurnOutcome("pm", "outage", { error: ERR });
    assert.equal(m.scheduler.providerBreaker().state, "closed", "the first two aged out of the window");
    clock.advance(PROVIDER_TRIP_WINDOW_MS - 1);
    m.scheduler.noteTurnOutcome("dev", "outage", { error: ERR });
    m.scheduler.noteTurnOutcome("qa", "outage", { error: ERR });
    assert.equal(m.scheduler.providerBreaker().state, "open", "three inside one window");
  } finally {
    await m.cleanup();
  }
});

test("provider breaker: open HOLDS wakes (queued, not refused); explicit operator wakes still run and prove nothing", async () => {
  const clock = new ManualClock(Date.now());
  const m = await mesh(clock);
  try {
    let turns = 0;
    stub(m).setScript("pm", async () => {
      turns++;
      return { operations: [{ op: "done" } as MeshOp] };
    });
    for (let i = 0; i < 3; i++) m.scheduler.noteTurnOutcome("dev", "outage", { error: ERR });
    assert.equal(m.scheduler.providerBreaker().state, "open");

    const queued = await m.scheduler.requestActivation({ agentId: "qa", reason: { kind: "message", note: "mail" }, priority: 4 });
    assert.equal(queued, true, "a wake is kept, so no mail is lost to the outage");
    await settle();
    assert.equal(m.scheduler.pending(), 1);
    assert.deepEqual(m.scheduler.queueWaits(), [{ agentId: "qa", kind: "provider" }]);

    const r = await m.supervisor.activateAgent("pm", { kind: "manual" });
    assert.equal(r.queued, true, r.blocked);
    await waitFor("the operator's own wake ran", () => turns === 1 && !m.supervisor.isTurnInFlight("pm"));
    await settle();
    assert.equal(m.scheduler.providerBreaker().state, "open", "a turn that is not the probe never closes it");
    assert.equal(m.scheduler.pending(), 1, "qa is still held");
  } finally {
    await m.cleanup();
  }
});

/**
 * `explicit` is not operator standing. The supervisor's handover re-queue
 * (`requeueAfterHandover`) is explicit so it can jump the seat's own gates, and
 * until 2026-09-28 that walked it through an open breaker for a second refused
 * turn. This is the request that re-queue sends: the consumed wake, verbatim,
 * at the head of the queue, explicit and nothing more.
 */
const CONSUMED = { kind: "recovery" as const, note: "your DatabaseSchema was built on ResearchReport v3; it is now v4 — re-read it" };

test("provider breaker: open HOLDS a handover's re-queued wake (explicit, not operator); it runs once the breaker closes", async () => {
  const clock = new ManualClock(Date.now());
  const m = await mesh(clock);
  try {
    const started: Array<{ id: string; state: string; note?: string }> = [];
    for (const id of ["dev", "qa"]) {
      stub(m).setScript(id, async (input) => {
        started.push({ id, state: m.scheduler.providerBreaker().state, note: input.activation.note });
        // The probe answers slowly enough (real ms) to look at the queue while it runs.
        return { delayMs: id === "dev" ? 200 : 20, operations: [{ op: "wait" } as MeshOp] };
      });
    }
    for (let i = 0; i < 3; i++) m.scheduler.noteTurnOutcome("pm", "outage", { error: ERR });
    assert.equal(m.scheduler.providerBreaker().state, "open");

    // dev's own retry, older and at the same priority, so it is the probe and
    // the re-queue has to wait for the breaker to CLOSE, not merely half-open.
    assert.equal(await m.scheduler.requestActivation({ agentId: "dev", reason: { kind: "recovery", note: "retry" }, priority: 10 }), true);
    clock.advance(1);
    assert.equal(await m.scheduler.requestActivation({ agentId: "qa", reason: CONSUMED, priority: 10, explicit: true }), true, "kept, not refused");
    await settle();
    assert.equal(started.length, 0, "nothing runs while the breaker is open — the handover's re-queue included");
    assert.deepEqual(m.scheduler.queueWaits(), [
      { agentId: "dev", kind: "provider" },
      { agentId: "qa", kind: "provider" },
    ]);

    await clock.advanceAndSettle(PROVIDER_BACKOFF_INITIAL_MS - 2);
    assert.equal(started.length, 0, "and nothing runs for the whole backoff");
    assert.equal(m.scheduler.pending(), 2, "the re-queue is still queued, not dropped");

    await clock.advanceAndSettle(1);
    await waitFor("the probe started", () => started.length === 1);
    assert.deepEqual(started[0], { id: "dev", state: "half_open", note: "retry" });
    assert.deepEqual(m.scheduler.queueWaits(), [{ agentId: "qa", kind: "provider" }], "held behind the probe as well");

    await waitFor("the re-queued wake runs once the probe closed the breaker", () => started.length === 2);
    assert.deepEqual(started[1], { id: "qa", state: "closed", note: CONSUMED.note }, "the consumed wake, run after the close");
  } finally {
    await m.cleanup();
  }
});

test("provider breaker: open still admits the operator's wake — alone, or folded into a wake the breaker holds", async () => {
  const clock = new ManualClock(Date.now());
  const m = await mesh(clock);
  try {
    const started: string[] = [];
    for (const id of ["dev", "qa", "pm"]) {
      stub(m).setScript(id, async () => {
        started.push(id);
        return { operations: [{ op: "wait" } as MeshOp] };
      });
    }
    for (let i = 0; i < 3; i++) m.scheduler.noteTurnOutcome("pm", "outage", { error: ERR });
    assert.equal(m.scheduler.providerBreaker().state, "open");
    // dev holds a handover's re-queue (above the operator's priority), qa its
    // outage retry (the supervisor's shape: recovery at 7, above it too).
    assert.equal(await m.scheduler.requestActivation({ agentId: "dev", reason: CONSUMED, priority: 10, explicit: true }), true);
    assert.equal(await m.scheduler.requestActivation({ agentId: "qa", reason: { kind: "recovery", note: "retry: the model provider refused your last turn" }, priority: 7 }), true);
    await settle();
    assert.deepEqual(m.scheduler.queueWaits().map((w) => w.kind), ["provider", "provider"]);

    // `POST /agents/:id/wake` is exactly this call. pm has nothing queued; dev
    // and qa each already hold a wake that outranks it, so the operator's is
    // coalesced into theirs — and must bring its standing with it.
    for (const id of ["pm", "dev", "qa"]) {
      const r = await m.supervisor.activateAgent(id, { kind: "manual", note: "manual wake via API" });
      assert.equal(r.queued, true, r.blocked);
    }
    await waitFor("every operator wake ran", () => started.length === 3 && ["dev", "qa", "pm"].every((id) => !m.supervisor.isTurnInFlight(id)));
    assert.deepEqual([...started].sort(), ["dev", "pm", "qa"]);
    await settle();
    assert.equal(m.scheduler.pending(), 0, "nothing of theirs is left held");
    assert.equal(m.scheduler.providerBreaker().state, "open", "and none of them was the probe");
  } finally {
    await m.cleanup();
  }
});

test("provider breaker: half-open admits ONE probe; only the probe's answer closes it", async () => {
  const clock = new ManualClock(Date.now());
  const m = await mesh(clock);
  try {
    const started: Array<{ id: string; state: string }> = [];
    for (const id of ["dev", "qa"]) {
      stub(m).setScript(id, async () => {
        started.push({ id, state: m.scheduler.providerBreaker().state });
        return { delayMs: 40, operations: [{ op: "wait" } as MeshOp] };
      });
    }
    for (let i = 0; i < 3; i++) m.scheduler.noteTurnOutcome("pm", "outage", { error: ERR });
    for (const id of ["dev", "qa"]) {
      assert.equal(await m.scheduler.requestActivation({ agentId: id, reason: { kind: "recovery", note: "retry" }, priority: 7 }), true);
    }
    assert.equal(m.scheduler.probeProviderNow(), true, "open -> half-open on demand");
    assert.equal(m.scheduler.probeProviderNow(), false, "and only from open");
    await waitFor("the probe started", () => started.length === 1);
    const probe = started[0]!;
    assert.equal(probe.state, "half_open");
    assert.equal(m.scheduler.providerBreaker().probe, probe.id);
    assert.deepEqual(m.scheduler.queueWaits().map((w) => w.kind), ["provider"], "the other wake waits for the probe's answer");

    // An answer from a seat that is not the probe proves nothing about NOW.
    m.scheduler.noteTurnOutcome("pm", "ok", { providerAnswered: true });
    assert.equal(m.scheduler.providerBreaker().state, "half_open");

    await waitFor("the probe's answer closes it", () => m.scheduler.providerBreaker().state === "closed");
    await waitFor("the held wake runs", () => started.length === 2);
    assert.equal(started[1]!.state, "closed");
    const closed = m.scheduler.providerBreaker();
    assert.equal(closed.failedTurns, 0, "a closed breaker starts the next episode from nothing");
    assert.equal(m.scheduler.probeProviderNow(), false, "nothing to probe when closed");
  } finally {
    await m.cleanup();
  }
});

test("provider breaker: a probe that ends without a verdict frees the slot for the next queued wake", async () => {
  const clock = new ManualClock(Date.now());
  const m = await mesh(clock);
  try {
    const started: string[] = [];
    // dev's probe is refused at the door by nothing the provider did: a seat
    // fault that restarts it. That is not a verdict on the provider.
    stub(m).setScript("dev", async () => {
      started.push("dev");
      return { fail: "claude turn failed: error_during_execution — tool crashed", operations: [] };
    });
    stub(m).setScript("qa", async () => {
      started.push("qa");
      return { delayMs: 20, operations: [{ op: "wait" } as MeshOp] };
    });
    for (let i = 0; i < 3; i++) m.scheduler.noteTurnOutcome("pm", "outage", { error: ERR });
    assert.equal(await m.scheduler.requestActivation({ agentId: "dev", reason: { kind: "recovery", note: "retry" }, priority: 9 }), true);
    assert.equal(await m.scheduler.requestActivation({ agentId: "qa", reason: { kind: "recovery", note: "retry" }, priority: 7 }), true);
    await clock.advanceAndSettle(PROVIDER_BACKOFF_INITIAL_MS);
    await waitFor("dev probed first and qa took the slot after it", () => started.includes("qa"));
    assert.equal(started[0], "dev");
    await waitFor("qa's answer closes the breaker", () => m.scheduler.providerBreaker().state === "closed");
  } finally {
    await m.cleanup();
  }
});

test("provider breaker: a mission reset closes it", async () => {
  const clock = new ManualClock(Date.now());
  const m = await mesh(clock);
  try {
    for (let i = 0; i < 3; i++) m.scheduler.noteTurnOutcome("dev", "outage", { error: ERR });
    assert.equal(m.scheduler.providerBreaker().state, "open");
    await m.scheduler.stop();
    m.scheduler.resetMissionState();
    assert.equal(m.scheduler.providerBreaker().state, "closed");
    assert.equal(m.scheduler.providerBreaker().failedTurns, 0);
  } finally {
    await m.cleanup();
  }
});
