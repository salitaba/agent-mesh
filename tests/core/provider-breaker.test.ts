import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { bootstrapMesh } from "../../apps/mesh-server/src/index";
import { makeMesh, stub, waitFor, collectEvents, goalOf, testConfigYaml, type AgentSpec, type TestMesh } from "../helpers";
import { ManualClock, settle } from "../support/manual-clock";
import {
  BackendUnreachableError,
  InterruptedTurnError,
  RequestTimeoutError,
  TurnTimeoutError,
  classifyProviderOutage,
  type MeshEvent,
  type MeshOp,
} from "../../packages/protocol/src/index";
import { RuntimeFailure } from "../../packages/core/src/supervisor";
import { PROVIDER_BACKOFF_INITIAL_MS } from "../../packages/scheduler/src/index";

/**
 * A provider outage is ONE mission-wide fault, not N seat failures.
 *
 * Twice in two days (2026-09-27 on a 429, 2026-09-28 on a 402) the provider
 * behind the proxy refused every seat's turns at once, and the mesh walked each
 * seat down its own failure ladder: four failures in ~90s, terminal, asks
 * discharged, parked SUSPENDED, and a `runtime_failure` card per seat — ten
 * cards and a dead mission. These tests drive the real supervisor and the real
 * scheduler with StubRuntime, on a manual clock so the 5-minute backoff is
 * advanced rather than slept through.
 */

// Verbatim from the skill-panel event log (`agent.failed.error`).
const OUTAGE_402 =
  "claude turn failed: success — API Error: 402 [402]: This model requires an opencode API key — add one in Settings → Providers. — terminated: api_error";
const OUTAGE_429 =
  "claude turn failed: success — API Error: Request rejected (429) · [opencode-go/deepseek-v4.1-flash] [429]: Go usage limit exceeded (reset after 3s) — terminated: api_error";
// The same 429 as the task quoted it, without the adapter's prefix.
const OUTAGE_429_BARE = "API Error: Request rejected (429) · [opencode-go/deepseek-v4.1-flash] [429]: Go usage limit exceeded (reset after 3s)";

// ------------------------------------------------------------ the classifier

test("classifier: each observed provider error is an outage, with its status", () => {
  const cases: Array<[unknown, string, number | undefined]> = [
    [OUTAGE_402, "billing", 402],
    [new RuntimeFailure(OUTAGE_402), "billing", 402],
    [OUTAGE_429, "rate_limited", 429],
    [new Error(OUTAGE_429), "rate_limited", 429],
    [OUTAGE_429_BARE, "rate_limited", 429],
    // The other rungs the task names, in the shapes the Claude CLI writes them.
    ["claude turn failed: error_during_execution — API Error: 401 {\"type\":\"error\",\"error\":{\"type\":\"authentication_error\",\"message\":\"invalid x-api-key\"}}", "auth", 401],
    ["API Error: 403 {\"error\":{\"type\":\"forbidden\",\"message\":\"Request not allowed\"}}", "auth", 403],
    ["API Error: 500 {\"type\":\"error\",\"error\":{\"type\":\"api_error\",\"message\":\"Internal server error\"}}", "unavailable", 500],
    ["API Error: 529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}", "unavailable", 529],
    ["claude turn failed: error_during_execution — API Error: Repeated 529 Overloaded errors", "unavailable", undefined],
    // The proxy itself being down: the CLI cannot reach its API endpoint.
    ["claude turn failed: error_during_execution — API Error: Connection error.", "unreachable", undefined],
    ["API Error: Unable to connect to API (ECONNREFUSED)", "unreachable", undefined],
    // The HTTP runtime's own status line.
    ["http runtime POST /sessions/s-1/turn -> 503: upstream unavailable", "unavailable", 503],
    ["http runtime POST /sessions/s-1/turn -> 429: slow down", "rate_limited", 429],
  ];
  for (const [err, kind, status] of cases) {
    const got = classifyProviderOutage(err);
    assert.ok(got, `must classify as an outage: ${String(err instanceof Error ? err.message : err)}`);
    assert.equal(got.kind, kind, String(err));
    assert.equal(got.status, status, String(err));
  }
  // The error rides along verbatim: it is what the card quotes.
  assert.equal(classifyProviderOutage(new RuntimeFailure(OUTAGE_402))?.error, OUTAGE_402);
});

test("classifier: a seat's own failure is never an outage", () => {
  const seatFailures: unknown[] = [
    // Observed on the same mission, and none of them the provider's doing.
    "claude turn failed: error_during_execution — [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use — terminated: aborted_streaming",
    'claude runtime: the mesh MCP bridge is status "failed", so this seat has no way to issue mesh ops; turn aborted',
    new TurnTimeoutError(1_200_000),
    new InterruptedTurnError("turn interrupted by the mesh before the backend answered"),
    new BackendUnreachableError("claude:836646e9", "claude session ended"),
    new RequestTimeoutError("http://127.0.0.1:4104", "POST /turn", 600_000),
    // The provider answered and refused THIS request: the seat's prompt, not the provider.
    "claude turn failed: error_during_execution — API Error: 400 prompt is too long: 210000 tokens > 200000 maximum",
    "http runtime POST /sessions/s-1/turn -> 400: bad request",
    "API Error: 404 model not found: claude-sonet",
    // A model or tool error that merely MENTIONS a status or a quota.
    "tool Bash failed: exit code 22 (curl: The requested URL returned error: 429 Too Many Requests)",
    "claude turn failed: error_max_turns — the fixture's rate limit test expected 503 but got 200",
    "stub crash for dev on turn 0",
    "model said no",
    undefined,
    { message: OUTAGE_402 },
  ];
  for (const err of seatFailures) {
    assert.equal(classifyProviderOutage(err), null, `must stay a seat failure: ${String(err instanceof Error ? err.message : JSON.stringify(err))}`);
  }
});

// ------------------------------------------------------------ the mesh

const SEATS: AgentSpec[] = [
  { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
  // Non-persistent: before the breaker its FIRST failure was terminal.
  { id: "qa", role: "qa", capabilities: ["repository.read"], interests: [], persistent: false },
  { id: "pm", role: "pm", capabilities: ["repository.read"], interests: [] },
];
const IDS = SEATS.map((s) => s.id);

type Mesh = TestMesh;

interface Provider {
  up: boolean;
  error: string;
  /** Every script invocation: which seat, and the breaker's state as the turn started. */
  turns: Array<{ agentId: string; breaker: string }>;
}

/**
 * Every seat fails with `provider.error` while the provider is down and
 * answers normally once it is up. A tiny real delay on the answering turn,
 * so a test can look at the mesh while the probe is still running.
 */
function scriptProvider(m: Mesh, provider: Provider, ids: string[] = IDS): void {
  for (const id of ids) {
    stub(m).setScript(id, () => {
      provider.turns.push({ agentId: id, breaker: m.scheduler.providerBreaker().state });
      return provider.up
        ? { delayMs: 30, text: "working", operations: [{ op: "wait" } as MeshOp] }
        : { fail: provider.error, operations: [] };
    });
  }
}

async function clockedMesh(clock: ManualClock, extra: { mode?: "parked" | "live" } = {}): Promise<Mesh> {
  return makeMesh({
    agents: SEATS,
    startup: [],
    clock,
    // The sweep would otherwise tick 1,500 times across one 5-minute backoff.
    waitWakeupMs: 60_000,
    // Room for several backoffs before the wall-clock verdict could fire.
    wallClockMinutes: 1_000,
    mayContact: { pm: ["dev", "qa"], dev: ["pm", "qa"], qa: ["dev", "pm"] },
    ...(extra.mode ? { mode: extra.mode } : {}),
  });
}

const cards = (m: Mesh, reason: string) => [...m.kernel.state.escalations.values()].filter((e) => e.reason === reason);
const lifecycle = (m: Mesh, id: string) => m.kernel.state.agents.get(id)?.state.lifecycle;
const eventsOf = async (m: Mesh, type: string): Promise<MeshEvent[]> => (await collectEvents(m)).filter((e) => e.type === type);
const quiet = (m: Mesh) => IDS.every((id) => !m.supervisor.isTurnInFlight(id));

/** Wake every seat (non-explicitly) into a provider that refuses them all, and wait for the trip. */
async function tripBreaker(m: Mesh, provider: Provider): Promise<void> {
  for (const id of IDS) {
    const r = await m.supervisor.activateAgent(id, { kind: "startup", note: "go" });
    assert.equal(r.queued, true, r.blocked);
  }
  await waitFor("the breaker trips and raises its card", () => m.scheduler.providerBreaker().state === "open" && cards(m, "provider_unavailable").length === 1);
  await waitFor("every refused turn has closed", () => quiet(m) && IDS.every((id) => lifecycle(m, id) === "IDLE"));
  await settle();
}

test("three seats refused with the 402: nothing suspended, no per-seat card, ONE provider card, no new turns", async () => {
  const clock = new ManualClock(Date.now());
  const m = await clockedMesh(clock);
  try {
    const provider: Provider = { up: true, error: OUTAGE_402, turns: [] };
    scriptProvider(m, provider);
    // An ask dev owes, so "its asks are not discharged" has something to hold.
    // Read while the provider is still up: unread mail would re-wake a failing
    // seat on every turn end, and the trip below should see one turn per seat.
    const ask = await m.supervisor.sendMessage({ from: "pm", to: ["dev"], type: "REQUEST_INFO", newThread: { subject: "status?" }, payload: { q: "where is the API?" } });
    assert.equal(ask.accepted, true, ask.reason);
    await waitFor("dev has read the ask", () => (m.kernel.state.unread.get("dev") ?? []).length === 0 && quiet(m));
    assert.equal(m.kernel.state.pendingRequests.has(ask.messageId!), true, "fixture: dev still owes the answer");
    provider.up = false;
    await tripBreaker(m, provider);
    const trippedAt = clock.nowMs();

    for (const id of IDS) {
      assert.equal(lifecycle(m, id), "IDLE", `${id} is back to IDLE, not SUSPENDED`);
      assert.equal(m.scheduler.isParkedForBackoff(id), false, `${id} took no per-seat breaker strike`);
    }
    assert.equal(cards(m, "runtime_failure").length, 0, "no per-seat runtime_failure card");
    assert.equal(cards(m, "backend_unreachable").length, 0);
    assert.equal(m.kernel.state.pendingRequests.has(ask.messageId!), true, "the ask dev owes is still open");
    const discharged = (await eventsOf(m, "commitment.discharged")).filter((e) => (e.payload as { messageId?: string }).messageId === ask.messageId);
    assert.equal(discharged.length, 0, "and was never discharged as a dead debtor's");
    assert.equal(goalOf(m)?.status, "ACTIVE", "the card is advisory: it never halts the goal");

    const [card] = cards(m, "provider_unavailable");
    assert.equal(card!.status, "OPEN");
    assert.equal(card!.advisory, true);
    const d = card!.detail as Record<string, unknown>;
    assert.equal(d.error, OUTAGE_402, "the card quotes the provider verbatim");
    assert.equal(d.failedTurns, 3);
    assert.deepEqual([...(d.seats as string[])].sort(), [...IDS].sort(), "and names every refused seat");
    assert.equal(d.nextAttemptAt, new Date(trippedAt + PROVIDER_BACKOFF_INITIAL_MS).toISOString(), "and when the next attempt is");
    assert.match(String(d.note), /no seat was suspended/);

    // Every seat's retry comes due inside the backoff, and every one is HELD.
    const turnsBefore = provider.turns.length;
    await clock.advanceAndSettle(60_000);
    await settle();
    assert.equal(provider.turns.length, turnsBefore, "no turn admitted while the breaker is open");
    assert.equal(m.scheduler.pending(), 3, "the three retries are queued, not lost");
    assert.deepEqual(m.scheduler.queueWaits().map((w) => w.kind), ["provider", "provider", "provider"], "and say why they wait");
    assert.equal(cards(m, "provider_unavailable").length, 1, "still exactly one card");
    assert.equal((await eventsOf(m, "agent.suspended")).length, 0);
  } finally {
    await m.cleanup();
  }
});

test("the backoff elapses: exactly one probe; it succeeds, the breaker closes, the card auto-resolves, every seat runs", async () => {
  const clock = new ManualClock(Date.now());
  const m = await clockedMesh(clock);
  try {
    const provider: Provider = { up: false, error: OUTAGE_402, turns: [] };
    scriptProvider(m, provider);
    await tripBreaker(m, provider);
    const cardId = cards(m, "provider_unavailable")[0]!.id;
    const refused = provider.turns.length;

    provider.up = true;
    await clock.advanceAndSettle(PROVIDER_BACKOFF_INITIAL_MS - 1);
    assert.equal(m.scheduler.providerBreaker().state, "open", "still open one millisecond before the backoff ends");
    assert.equal(provider.turns.length, refused, "and nothing ran");

    await clock.advanceAndSettle(1);
    await waitFor("the probe turn started", () => provider.turns.length > refused);
    const probe = provider.turns[refused]!;
    assert.equal(probe.breaker, "half_open", "the first turn back is the half-open probe");
    // While it runs (its stub answer is ~30ms of real time away), nothing else is admitted.
    assert.equal(provider.turns.length, refused + 1, "exactly ONE probe is admitted");
    assert.equal(m.scheduler.providerBreaker().probe, probe.agentId);

    await waitFor("the breaker closes on the probe's answer", () => m.scheduler.providerBreaker().state === "closed");
    await waitFor("the card is retired", () => m.kernel.state.escalations.get(cardId)?.status === "AUTO_RESOLVED");
    const retired = (await eventsOf(m, "escalation.auto_resolved")).find((e) => (e.payload as { escalationId?: string }).escalationId === cardId);
    assert.ok(retired, "retired by `escalation.auto_resolved`, not a faked operator answer");
    assert.equal((retired!.payload as { probe?: string }).probe, probe.agentId);

    await waitFor("every seat is admitted again", () => IDS.every((id) => provider.turns.slice(refused).some((t) => t.agentId === id)));
    const afterClose = provider.turns.slice(refused + 1);
    assert.ok(afterClose.every((t) => t.breaker === "closed"), "the others ran only after the probe closed the breaker");
    await waitFor("the mesh settles", () => quiet(m));
    for (const id of IDS) assert.notEqual(lifecycle(m, id), "SUSPENDED");
    assert.equal(cards(m, "runtime_failure").length, 0);
  } finally {
    await m.cleanup();
  }
});

test("a failed probe re-opens the breaker with a doubled backoff and restates the card's next attempt", async () => {
  const clock = new ManualClock(Date.now());
  const m = await clockedMesh(clock);
  try {
    const provider: Provider = { up: false, error: OUTAGE_429, turns: [] };
    scriptProvider(m, provider);
    await tripBreaker(m, provider);
    const cardId = cards(m, "provider_unavailable")[0]!.id;
    const refused = provider.turns.length;

    await clock.advanceAndSettle(PROVIDER_BACKOFF_INITIAL_MS);
    await waitFor("the probe ran and was refused", () => provider.turns.length === refused + 1 && m.scheduler.providerBreaker().state === "open");
    await waitFor("the probe's turn has closed", () => quiet(m));
    const reopenedAt = clock.nowMs();
    const b = m.scheduler.providerBreaker();
    assert.equal(b.opens, 2);
    assert.equal(b.backoffMs, 2 * PROVIDER_BACKOFF_INITIAL_MS, "the backoff doubled");
    assert.equal(b.nextProbeAt, reopenedAt + 2 * PROVIDER_BACKOFF_INITIAL_MS);
    assert.equal(b.failedTurns, 4, "the probe's refusal is counted");

    await waitFor("the card is restated", () => (m.kernel.state.escalations.get(cardId)?.detail as { opens?: number }).opens === 2);
    const all = cards(m, "provider_unavailable");
    assert.equal(all.length, 1, "restated in place, not a second card");
    const d = all[0]!.detail as Record<string, unknown>;
    assert.equal(all[0]!.status, "OPEN");
    assert.equal(d.nextAttemptAt, new Date(reopenedAt + 2 * PROVIDER_BACKOFF_INITIAL_MS).toISOString(), "the card's next attempt moved");
    assert.equal(d.failedTurns, 4);
    assert.equal(d.error, OUTAGE_429);

    // The first backoff's length again is NOT enough now...
    await clock.advanceAndSettle(PROVIDER_BACKOFF_INITIAL_MS);
    await settle();
    assert.equal(provider.turns.length, refused + 1, "no second probe before the doubled backoff ends");
    // ...the doubled one is.
    provider.up = true;
    await clock.advanceAndSettle(PROVIDER_BACKOFF_INITIAL_MS);
    await waitFor("the second probe closes the breaker", () => m.scheduler.providerBreaker().state === "closed");
    await waitFor("and retires the card", () => m.kernel.state.escalations.get(cardId)?.status === "AUTO_RESOLVED");
    for (const id of IDS) assert.notEqual(lifecycle(m, id), "SUSPENDED");
  } finally {
    await m.cleanup();
  }
});

test("answering the card probes immediately instead of waiting out the backoff", async () => {
  const clock = new ManualClock(Date.now());
  const m = await clockedMesh(clock);
  try {
    const provider: Provider = { up: false, error: OUTAGE_402, turns: [] };
    scriptProvider(m, provider);
    await tripBreaker(m, provider);
    const cardId = cards(m, "provider_unavailable")[0]!.id;
    const refused = provider.turns.length;
    const answeredAt = clock.nowMs();

    provider.up = true;
    const r = await m.supervisor.respondEscalation(cardId, "topped up the account — try again");
    assert.equal(r.ok, true, r.reason);
    await waitFor("the probe ran without the clock moving", () => provider.turns.length > refused);
    assert.equal(clock.nowMs(), answeredAt, "no backoff was waited out");
    assert.equal(provider.turns[refused]!.breaker, "half_open", "the answer's first turn is the probe");
    await waitFor("the probe closes the breaker", () => m.scheduler.providerBreaker().state === "closed");
    assert.equal(m.kernel.state.escalations.get(cardId)?.status, "RESPONDED", "the operator's answer stands; nothing overwrote it");
    // The other seats' own retries were armed 2s after their refusals; with the
    // breaker closed they are admitted the moment they come due.
    await clock.advanceAndSettle(5_000);
    await waitFor("every seat runs again", () => IDS.every((id) => provider.turns.slice(refused).some((t) => t.agentId === id)));
  } finally {
    await m.cleanup();
  }
});

/**
 * The breaker's first live outage, 2026-09-28 15:44Z: it opened on three 402s,
 * and one turn still got through. architect's turn was a HANDOVER, it failed
 * with the 402 after the breaker opened, and `requeueAfterHandover` put back
 * the wake it had consumed with `explicit: true` — which the breaker used to
 * read as an operator wake, so a second refused turn started 90ms later.
 * `pm` plays architect here, and its handover's refusal is the one that trips.
 */
test("a handover turn refused with the 402 trips the breaker; the wake it consumed is held, not run as a second refused turn", async () => {
  const clock = new ManualClock(Date.now());
  const m = await clockedMesh(clock);
  try {
    const provider: Provider = { up: false, error: OUTAGE_402, turns: [] };
    scriptProvider(m, provider, ["dev", "qa"]);
    // The live wake the handover consumed, and then re-ran.
    const CONSUMED = "your DatabaseSchema was built on ResearchReport v3; it is now v4 — re-read it";
    const pmTurns: Array<{ handover: boolean; breaker: string; note?: string; refused: boolean }> = [];
    stub(m).setScript("pm", (input) => {
      const breaker = m.scheduler.providerBreaker().state;
      pmTurns.push({ handover: input.suppressRotation === true, breaker, note: input.activation.note, refused: !provider.up });
      provider.turns.push({ agentId: "pm", breaker });
      // One handover per arming: the successor starts on a fresh transcript.
      if (input.suppressRotation) stub(m).clearRotation("pm");
      return provider.up ? { delayMs: 30, text: "working", operations: [{ op: "wait" } as MeshOp] } : { fail: provider.error, operations: [] };
    });

    // Two refusals from the other seats: one short of the trip.
    for (const id of ["dev", "qa"]) {
      const r = await m.supervisor.activateAgent(id, { kind: "startup", note: "go" });
      assert.equal(r.queued, true, r.blocked);
    }
    await waitFor("dev and qa were refused", () => provider.turns.length === 2 && quiet(m) && ["dev", "qa"].every((id) => lifecycle(m, id) === "IDLE"));
    await settle();
    assert.equal(m.scheduler.providerBreaker().state, "closed", "fixture: one short of the trip");

    stub(m).armRotation("pm");
    const woke = await m.supervisor.activateAgent("pm", { kind: "recovery", note: CONSUMED });
    assert.equal(woke.queued, true, woke.blocked);
    await waitFor("pm's handover turn was refused and tripped the breaker", () => pmTurns.length >= 1 && m.scheduler.providerBreaker().state === "open");
    await waitFor("its turn has closed", () => quiet(m) && lifecycle(m, "pm") === "IDLE");
    await settle();
    assert.equal(pmTurns[0]!.handover, true, "fixture: the refused turn was the handover");
    assert.equal(pmTurns[0]!.note, CONSUMED);
    assert.equal(pmTurns[0]!.breaker, "closed");
    assert.equal(pmTurns.length, 1, "the wake the handover consumed did not start a second refused turn");

    // Put back, at the head of the queue — and HELD.
    const requeued = () => m.scheduler.queueSnapshot().find((q) => q.agentId === "pm" && !q.afterTurn && (q.reason.note ?? "").includes(CONSUMED));
    await waitFor("the consumed wake is re-queued", () => requeued() !== undefined);
    assert.ok(requeued()!.priority >= 10, `re-queued at the head (priority ${requeued()!.priority})`);
    assert.deepEqual(m.scheduler.queueWaits().find((w) => w.agentId === "pm"), { agentId: "pm", kind: "provider" });

    // Every seat's outage retry comes due inside the backoff; nothing is admitted.
    await clock.advanceAndSettle(60_000);
    await settle();
    assert.equal(pmTurns.length, 1, "no second 402 turn for pm while the breaker is open");
    assert.equal(provider.turns.length, 3, "nor for any seat");
    assert.ok(requeued(), "the consumed wake is still queued, not dropped");
    assert.deepEqual(m.scheduler.queueWaits().map((w) => w.kind), ["provider", "provider", "provider"]);

    // The provider comes back: the consumed wake heads the queue, so it is the
    // probe. Advanced exactly to the backoff's end: any further and the manual
    // clock would time the probe out while its (real-time) answer is in flight.
    provider.up = true;
    const probeAt = m.scheduler.providerBreaker().nextProbeAt!;
    assert.equal(probeAt, clock.nowMs() - 60_000 + PROVIDER_BACKOFF_INITIAL_MS, "fixture: the breaker opened on pm's refusal");
    await clock.advanceAndSettle(probeAt - clock.nowMs());
    await waitFor("pm's consumed wake ran", () => pmTurns.length >= 2);
    assert.equal(pmTurns[1]!.refused, false);
    assert.equal(pmTurns[1]!.breaker, "half_open", "as the probe");
    assert.equal(pmTurns[1]!.handover, false, "the successor's turn, not a second handover");
    assert.ok((pmTurns[1]!.note ?? "").includes(CONSUMED), "carrying the wake the handover consumed");
    await waitFor("the probe's answer closes the breaker", () => m.scheduler.providerBreaker().state === "closed");
    assert.equal(pmTurns.filter((t) => t.refused).length, 1, "pm was refused exactly once");
  } finally {
    await m.cleanup();
  }
});

test("a parked mission stays parked through a trip and a backoff", async () => {
  const clock = new ManualClock(Date.now());
  const m = await clockedMesh(clock, { mode: "parked" });
  try {
    const provider: Provider = { up: false, error: OUTAGE_429, turns: [] };
    scriptProvider(m, provider);
    assert.equal(m.scheduler.isRunning(), false, "fixture: parked");
    // Parked meshes only move by explicit operator wakes; three refused ones trip it.
    for (const id of IDS) {
      const r = await m.supervisor.activateAgent(id, { kind: "manual" });
      assert.equal(r.queued, true, r.blocked);
      await waitFor(`${id}'s wake ran`, () => provider.turns.some((t) => t.agentId === id) && !m.supervisor.isTurnInFlight(id));
    }
    await waitFor("the breaker trips", () => m.scheduler.providerBreaker().state === "open" && cards(m, "provider_unavailable").length === 1);
    const refused = provider.turns.length;

    provider.up = true;
    await clock.advanceAndSettle(PROVIDER_BACKOFF_INITIAL_MS + 60_000);
    await settle();
    assert.equal(m.scheduler.isRunning(), false, "the breaker never starts a parked scheduler");
    assert.equal(provider.turns.length, refused, "and no turn ran on its own — not the retries, not a probe");
    assert.equal(m.scheduler.providerBreaker().state, "half_open", "the probe is owed, and waits for the operator");
    for (const id of IDS) assert.equal(lifecycle(m, id), "IDLE");
    assert.equal(cards(m, "runtime_failure").length, 0);
  } finally {
    await m.cleanup();
  }
});

test("a restart mid-outage boots the breaker closed and retires the card it can no longer close", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-provider-restart-"));
  const configPath = path.join(dir, "mesh.yaml");
  fs.writeFileSync(configPath, testConfigYaml({ agents: SEATS, startup: [], mayContact: { pm: ["dev", "qa"], dev: ["pm", "qa"], qa: ["dev", "pm"] } }), "utf8");
  try {
    const first = await bootstrapMesh({ configPath, mode: "parked", useGit: false });
    let cardId = "";
    try {
      const refused = new Set<string>();
      for (const id of IDS) {
        first.stubRuntimes.get("stub")!.setScript(id, () => {
          refused.add(id);
          return { fail: OUTAGE_402, operations: [] };
        });
      }
      for (const id of IDS) {
        await first.supervisor.activateAgent(id, { kind: "manual" });
        await waitFor(`${id}'s wake was refused`, () => refused.has(id) && !first.supervisor.isTurnInFlight(id));
      }
      await waitFor("the card is up", () => [...first.kernel.state.escalations.values()].some((e) => e.reason === "provider_unavailable"));
      cardId = [...first.kernel.state.escalations.values()].find((e) => e.reason === "provider_unavailable")!.id;
      await waitFor("every refused turn closed", () => IDS.every((id) => first.kernel.state.agents.get(id)?.state.lifecycle === "IDLE"));
    } finally {
      await first.close();
    }

    const second = await bootstrapMesh({ configPath, mode: "parked", useGit: false });
    try {
      assert.equal(second.scheduler.providerBreaker().state, "closed", "breaker state is process memory");
      assert.equal(second.kernel.state.escalations.get(cardId)?.status, "AUTO_RESOLVED", "so the card it raised is retired at boot, not left to hold completion shut");
    } finally {
      await second.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------ unchanged: a seat's own failure

test("a genuine seat failure still goes terminal exactly as before, and never touches the breaker", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "qa", role: "qa", capabilities: ["repository.read"], interests: [], persistent: false },
    ],
    startup: [],
    mayContact: { dev: ["qa"], qa: ["dev"] },
  });
  try {
    const SEAT_FAULT = "claude turn failed: error_during_execution — [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=tool_use — terminated: aborted_streaming";
    stub(m).setScript("dev", () => ({ fail: SEAT_FAULT, operations: [] }));
    stub(m).setScript("qa", () => ({ fail: SEAT_FAULT, operations: [] }));

    // Non-persistent: the first failure is terminal, as it always was.
    await m.supervisor.activateAgent("qa", { kind: "manual" });
    await waitFor("qa is parked", () => lifecycle(m, "qa") === "SUSPENDED");
    // Persistent: three restarts, then terminal on the fourth failure.
    await m.supervisor.activateAgent("dev", { kind: "manual" });
    await waitFor("dev is parked", () => lifecycle(m, "dev") === "SUSPENDED", 15_000);
    await waitFor("both cards are up", () => cards(m, "runtime_failure").length === 2);

    const failed = (await eventsOf(m, "agent.failed")).filter((e) => (e.payload as { agentId?: string }).agentId === "dev");
    const restarted = (await eventsOf(m, "agent.restarted")).filter((e) => (e.payload as { agentId?: string }).agentId === "dev");
    assert.equal(failed.length, 4, "dev failed four times");
    assert.equal(restarted.length, 3, "and was restarted three times first");
    const devCard = cards(m, "runtime_failure").find((e) => (e.detail as { agentId?: string }).agentId === "dev");
    assert.equal((devCard?.detail as { attempts?: number }).attempts, 4);
    assert.equal(cards(m, "provider_unavailable").length, 0, "a seat's own failure raises no provider card");
    const b = m.scheduler.providerBreaker();
    assert.equal(b.state, "closed");
    assert.equal(b.failedTurns, 0);
  } finally {
    await m.cleanup();
  }
});
