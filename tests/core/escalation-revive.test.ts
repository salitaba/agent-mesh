import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, collectEvents, goalOf, type AgentSpec } from "../helpers";
import { createHttpServer, closeHttpServer } from "../../apps/mesh-server/src/index";
import type { MeshEvent, MeshOp } from "../../packages/protocol/src/index";

/**
 * The operator's answer to a stalled mission must actually move it.
 *
 * `handleAgentFailure` suspends a seat whose turns keep failing terminally
 * ("never schedule me again") because it assumes the mission can proceed
 * without it. When the failure is environmental — the live case was a provider
 * account over quota, 429 on 855 of 1023 calls on 2026-09-27, every seat parked
 * in turn — it cannot, and the stall watchdog raises `stalemate:stall_nudge_cap`.
 * The operator answered "retry" twice and nothing happened: the response set
 * the goal ACTIVE and called `activateAgent`, which refuses a SUSPENDED seat by
 * lifecycle. The only thing that worked was nine hand-run `POST .../resume`s.
 *
 * What separates the two suspensions is recorded where each is DECIDED
 * (`terminalSuspended`, written next to the park, never parsed out of the
 * note): a seat the OPERATOR suspended stays down through an escalation answer,
 * and a seat the MESH parked for failure comes back. These tests drive the real
 * failure path, the real `respondEscalation` and the real watchdog tick — the
 * only things posed are the clock-distance gates the existing watchdog tests
 * pose too.
 */

const AGENTS: AgentSpec[] = [
  { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [], persistent: false },
  { id: "qa", role: "qa", capabilities: ["repository.read"], interests: [], persistent: false },
];

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

const lifecycle = (m: Mesh, id: string) => m.kernel.state.agents.get(id)?.state.lifecycle;
const paused = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The private members these tests pose and observe. */
interface ReviveProbe {
  terminalSuspended: Set<string>;
  terminalSuspendedSeats(): string[];
  restartAttempts: Map<string, number>;
  timeoutRetries: Map<string, number>;
  unreachableStreak: Map<string, number>;
  checkStall(): Promise<void>;
  lastTurnAt: number;
  lastStallNudgeAt: number;
  stallNudgeStreak: number;
  stallRefusalStreak: number;
  stallCapEscalated: boolean;
}
const probe = (m: Mesh): ReviveProbe => m.supervisor as unknown as ReviveProbe;

const eventsOf = async (m: Mesh, type: string, agentId?: string): Promise<MeshEvent[]> =>
  (await collectEvents(m)).filter((e) => e.type === type && (agentId === undefined || (e.payload as { agentId?: string }).agentId === agentId));

/**
 * Park `id` the way the mesh does it: a real turn that fails, through
 * `handleAgentFailure`, on a seat with no restarts left. Every later turn of
 * that seat answers normally, so a test can tell a revival from a loop.
 */
async function parkTerminally(m: Mesh, id: string): Promise<void> {
  stub(m).setScript(id, (_input, idx) =>
    idx === 0
      ? { throwKind: "generic" as const, throwMessage: "429 Go usage limit exceeded" }
      : { text: "back at work", operations: [{ op: "done" } as MeshOp] },
  );
  await m.supervisor.activateAgent(id, { kind: "manual" });
  await waitFor(`${id} is parked after a terminal failure`, () => lifecycle(m, id) === "SUSPENDED");
  await waitFor(`${id}'s turn has closed`, () => !m.supervisor.isTurnInFlight(id));
}

/** The card the watchdog raises when nothing it nudges buys work. */
async function stallCard(m: Mesh): Promise<string> {
  const goalId = m.kernel.state.activeGoalId!;
  const esc = await m.supervisor.escalate({
    reason: "stalemate:stall_nudge_cap",
    raisedBy: "stall-watchdog",
    conflictKey: `stall-cap:${goalId}`,
    detail: { cause: "nudges_produced_no_work", nudges: 3, refusals: 0, note: "the mesh cannot un-stick itself" },
  });
  // The live shape: a non-advisory card halts the mission while it is open, so
  // the answer is what has to un-halt it (`activateAgent` refuses otherwise).
  const goal = goalOf(m)!;
  await m.kernel.emit("goal.escalated", { goalId: goal.id, reason: "stalemate:stall_nudge_cap" }, { actorId: "termination-manager", goalId: goal.id });
  assert.equal(goalOf(m)?.status, "ESCALATED", "the fixture must start from the halted mission the answer has to release");
  return esc.id;
}

test("an escalation answer revives a seat the mesh parked for terminal failure, and its wake is admitted", async () => {
  const m = await makeMesh({ agents: AGENTS, startup: [], mayContact: { dev: ["qa"], qa: ["dev"] } });
  try {
    await parkTerminally(m, "dev");
    // Recorded at the source, not read back off the note prose.
    assert.equal(probe(m).terminalSuspended.has("dev"), true, "the park is classified when it is set");
    const parked = (await eventsOf(m, "agent.state_changed", "dev")).at(-1)?.payload as { to?: string; note?: string };
    assert.equal(parked.to, "SUSPENDED");
    assert.match(String(parked.note), /terminal failure/);

    const card = await stallCard(m);
    const r = await m.supervisor.respondEscalation(card, "retry");
    assert.equal(r.ok, true, r.reason);

    assert.equal(goalOf(m)?.status, "ACTIVE", "answering the card releases the halt");
    assert.equal(lifecycle(m, "dev"), "IDLE", "the answer resumes the seat the MESH parked");

    // The revival is an ordinary resume, and it is a FRESH START: the ladder
    // that parked the seat is not left mid-rung where the first turn back
    // would walk straight into the park again.
    assert.equal((await eventsOf(m, "agent.resumed", "dev")).length, 1);
    assert.equal(probe(m).restartAttempts.get("dev"), undefined, "no crash strike carried over");
    assert.equal(probe(m).timeoutRetries.get("dev"), undefined, "no slow-turn strike carried over");
    assert.equal(probe(m).unreachableStreak.get("dev"), undefined, "no dead-backend strike carried over");
    assert.equal(probe(m).terminalSuspended.has("dev"), false, "and it is no longer classified as parked-for-failure");

    // Activated by the same call: the seat actually takes a turn again, and
    // the mission is moving (the criterion is still unmet and dev answered).
    await waitFor("dev's revived turn ran", async () => (await eventsOf(m, "agent.awakened", "dev")).length >= 2, 8000);
    await waitFor("dev is idle between turns", () => !m.supervisor.isTurnInFlight("dev"), 8000);
    assert.equal(lifecycle(m, "dev"), "IDLE");
    const devTurns = m.supervisor.getRecentTurns(20).filter((t) => t.agentId === "dev");
    assert.equal(devTurns[0]?.status, "ok", "the turn back is not another failure");

    // ...and it is activatable by hand afterwards, the way any IDLE seat is.
    const wake = await m.supervisor.activateAgent("dev", { kind: "manual" });
    assert.equal(wake.queued, true, wake.blocked);
  } finally {
    await m.cleanup();
  }
});

test("a seat the OPERATOR suspended stays down through an escalation answer", async () => {
  const m = await makeMesh({ agents: AGENTS, startup: [], mayContact: { dev: ["qa"], qa: ["dev"] } });
  try {
    // The dashboard's pause (and a stop with `suspend: true`) goes through this.
    await m.supervisor.suspendAgent("dev");
    assert.equal(lifecycle(m, "dev"), "SUSPENDED");
    assert.equal(probe(m).terminalSuspended.has("dev"), false, "an operator suspension is not a terminal-failure park");

    const card = await stallCard(m);
    const r = await m.supervisor.respondEscalation(card, "retry");
    assert.equal(r.ok, true, r.reason);

    assert.equal(lifecycle(m, "dev"), "SUSPENDED", "the answer must not quietly undo a deliberate pause");
    assert.equal((await eventsOf(m, "agent.resumed", "dev")).length, 0, "nothing resumed it");
    assert.equal((await eventsOf(m, "agent.awakened", "dev")).length, 0, "and nothing woke it");
    await paused(200);
    assert.equal(lifecycle(m, "dev"), "SUSPENDED");

    // The operator's own resume is still the one way back.
    await m.supervisor.resumeAgent("dev");
    assert.equal(lifecycle(m, "dev"), "IDLE");
  } finally {
    await m.cleanup();
  }
});

test("the resume is emitted BEFORE the activation it enables, and the mission proceeds", async () => {
  const m = await makeMesh({ agents: AGENTS, startup: [], mayContact: { dev: ["qa"], qa: ["dev"] } });
  try {
    await parkTerminally(m, "dev");
    await parkTerminally(m, "qa");
    const card = await stallCard(m);

    await m.supervisor.respondEscalation(card, "provider quota reset, go again");
    // The activation the answer makes is queued, so the turn it buys lands
    // after the call returns — wait for it before reading the order back.
    await waitFor("the revived seats take a turn", async () => (await eventsOf(m, "agent.awakened")).length >= 4, 8000);

    const events = await collectEvents(m);
    const positions = (type: string, agentId: string): number[] =>
      events.flatMap((e, i) => (e.type === type && (e.payload as { agentId?: string }).agentId === agentId ? [i] : []));
    const resumed = positions("agent.resumed", "dev");
    const awakened = positions("agent.awakened", "dev");
    assert.equal(resumed.length, 1, "one resume");
    assert.ok(awakened.length >= 2, `the seat takes a turn again (awakened ${awakened.length})`);
    const firstWakeAfterResume = awakened.find((i) => i > resumed[0]!);
    assert.notEqual(firstWakeAfterResume, undefined, "an activation follows the resume");
    assert.ok(resumed[0]! < firstWakeAfterResume!, "resume BEFORE activate — the other order is refused by lifecycle, which is the bug");

    await waitFor("both revived seats have taken a turn", async () => m.supervisor.getRecentTurns(20).filter((t) => t.status === "ok").length >= 2, 8000);
    for (const id of ["dev", "qa"]) {
      await waitFor(`${id} is idle between turns`, () => !m.supervisor.isTurnInFlight(id), 8000);
      assert.equal(lifecycle(m, id), "IDLE", `${id} ends IDLE`);
    }
    assert.equal(goalOf(m)?.status, "ACTIVE", "the mission is running again");
  } finally {
    await m.cleanup();
  }
});

// ---------------------------------------------------------------- the card

/** Route activation requests nowhere, so a nudge costs no turn and parks nobody. */
function blockActivations(m: Mesh): string[] {
  const seen: string[] = [];
  const sched = m.supervisor.deps.scheduler as unknown as { requestActivation: (req: { agentId: string }) => Promise<boolean> };
  sched.requestActivation = async (req) => {
    seen.push(req.agentId);
    return true;
  };
  return seen;
}

/** Open both stall gates so the very next `checkStall()` is free to nudge. */
function openGates(p: ReviveProbe): void {
  p.lastTurnAt = 0;
  p.lastStallNudgeAt = 0;
}

const capCards = (m: Mesh) => [...m.kernel.state.escalations.values()].filter((e) => e.reason === "stalemate:stall_nudge_cap");

test("the stall card names the seats parked for terminal failure — and says what answering it does", async () => {
  const m = await makeMesh({
    agents: [{ ...AGENTS[0]! }, { ...AGENTS[1]! }, { id: "pm", role: "pm", authority: ["requirements.accept"], capabilities: ["repository.read"], interests: [] }],
    startup: [],
    mayContact: { dev: ["qa"], qa: ["dev"], pm: ["dev"] },
  });
  try {
    await parkTerminally(m, "dev");
    await parkTerminally(m, "qa");
    assert.deepEqual(probe(m).terminalSuspendedSeats().sort(), ["dev", "qa"], "both parks are still classified");

    // `pm` is the driver: the nudges reach it and buy nothing, which is the
    // wedge the cap exists for. They are routed nowhere so the driver is never
    // itself parked, keeping the fixture at "unproductive", not "dead".
    blockActivations(m);
    const p = probe(m);
    for (let i = 0; i < 4; i++) {
      openGates(p);
      await p.checkStall();
    }
    assert.equal(p.stallNudgeStreak, 3, "three nudges, then the cap");

    const cards = capCards(m);
    assert.equal(cards.length, 1, "one card for the wedged mission");
    const detail = cards[0]!.detail as {
      cause?: string;
      suspendedSeats?: string[];
      suspendedCause?: string;
      suspendedNote?: string;
    };
    assert.equal(detail.cause, "nudges_produced_no_work", "the cause is unchanged");
    assert.deepEqual([...(detail.suspendedSeats ?? [])].sort(), ["dev", "qa"], "the card must name the seats nothing can reach");
    assert.equal(detail.suspendedCause, "terminal_failure", "and say WHICH suspension this is");
    assert.match(String(detail.suspendedNote), /dev/);
    assert.match(String(detail.suspendedNote), /qa/);
    assert.match(String(detail.suspendedNote), /SUSPENDED/, "the note names the state");
    assert.match(String(detail.suspendedNote), /not because you suspended/i, "it must not read as the operator's own doing");
    assert.match(String(detail.suspendedNote), /Answering this card resumes/, "and it must say what answering does");
  } finally {
    await m.cleanup();
  }
});

test("the stall card says nothing about suspended seats when there are none", async () => {
  const m = await makeMesh({ agents: AGENTS, startup: [], mayContact: { dev: ["qa"], qa: ["dev"] } });
  try {
    blockActivations(m);
    const p = probe(m);
    for (let i = 0; i < 4; i++) {
      openGates(p);
      await p.checkStall();
    }
    const cards = capCards(m);
    assert.equal(cards.length, 1, "the cap still fires — only its wording is in question");
    const detail = cards[0]!.detail as { suspendedSeats?: unknown; suspendedNote?: unknown };
    assert.equal(detail.suspendedSeats, undefined, "nothing was parked, so nothing may be named");
    assert.equal(detail.suspendedNote, undefined);
  } finally {
    await m.cleanup();
  }
});

// ------------------------------------------------------------- manual path

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

test("POST /agents/:id/resume is unchanged: it revives either suspension and the seat works again", async () => {
  const m = await makeMesh({ agents: AGENTS, startup: [], mayContact: { dev: ["qa"], qa: ["dev"] } });
  try {
    await parkTerminally(m, "dev");
    await m.supervisor.suspendAgent("qa");
    assert.equal(lifecycle(m, "qa"), "SUSPENDED");

    await withServer(m, async (base) => {
      const dev = await post(base, "/agents/dev/resume");
      assert.equal(dev.status, 200, JSON.stringify(dev.json));
      assert.equal(lifecycle(m, "dev"), "IDLE");
      assert.equal(probe(m).terminalSuspended.has("dev"), false, "a hand resume clears the classification too");

      const qa = await post(base, "/agents/qa/resume");
      assert.equal(qa.status, 200, JSON.stringify(qa.json));
      assert.equal(lifecycle(m, "qa"), "IDLE");

      // Unknown seat: still answered the way it always was — the route's own
      // shape is not this fixture's business to change.
      const nobody = await post(base, "/agents/nobody/resume");
      assert.equal(nobody.status, 200, "the route stays tolerant of an unknown id, exactly as before");
    });

    // A hand-resumed seat is a working seat: an operator wake is admitted and
    // a turn runs, for both suspensions.
    for (const id of ["dev", "qa"]) {
      const wake = await m.supervisor.activateAgent(id, { kind: "manual" });
      assert.equal(wake.queued, true, `${id}: ${wake.blocked}`);
    }
    await waitFor("the hand-resumed seats take a turn", async () => m.supervisor.getRecentTurns(20).filter((t) => t.status === "ok").length >= 2, 8000);

    // And a later escalation answer does not revive a seat the operator
    // already resumed: there is nothing parked to revive.
    assert.equal(probe(m).terminalSuspendedSeats().length, 0);
  } finally {
    await m.cleanup();
  }
});
