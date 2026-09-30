import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { makeMesh, stub, waitFor, collectEvents, type AgentSpec, type TestMesh } from "../helpers";
import { bootstrapMesh, type MeshInstance } from "../../apps/mesh-server/src/index";
import { MESH_SHUTDOWN_CAUSE, RECOVERY_ACTOR_ID } from "../../packages/core/src/supervisor";
import { BackendUnreachableError, type MeshEvent, type MeshOp } from "../../packages/protocol/src/index";

/**
 * A turn killed by the process shutting down is not a seat failure.
 *
 * `shutdown()` stops every runtime session, and the Claude adapter settles the
 * pending call of a stopped session with `BackendUnreachableError("claude:<sid>",
 * "session torn down")`. That throw used to walk `handleAgentFailure`, whose
 * first emit is `agent.failed` and whose second is the restart — while the
 * process was exiting. On 2026-09-28 13:42Z the old child wrote `agent.failed`
 * for frontend, backend and ux-designer, the restart for frontend only, and
 * exited: two seats booted FAILED, and ux-designer read FAILED for 3.5 minutes
 * while its recovery wake queued behind `max_active_agents`.
 *
 * Two halves. The cause: a turn `shutdown()` stopped is closed as `interrupted`,
 * IDLE, with no `agent.failed`, no strike and no restart. The legacy logs: boot
 * restores a seat left FAILED mid-handler (step 8g), and only that seat — one
 * the mesh parked, one that failed `restartable: false`, and one whose handler
 * finished with a terminal card all stay down.
 */

const AGENTS: AgentSpec[] = [
  { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [], persistent: true },
  { id: "qa", role: "qa", capabilities: ["repository.read"], interests: [], persistent: true },
  { id: "pm", role: "pm", capabilities: ["repository.read"], interests: [], persistent: false },
];
const MAY_CONTACT = { dev: ["qa", "pm"], qa: ["dev", "pm"], pm: ["dev", "qa"] };
const DONE = { text: "back at work", operations: [{ op: "done" } as MeshOp] };

type Mesh = MeshInstance;

const lifecycle = (m: Mesh, id: string) => m.kernel.state.agents.get(id)?.state.lifecycle;
const paused = (ms: number) => new Promise((r) => setTimeout(r, ms));
const internals = (m: Mesh) =>
  m.supervisor as unknown as {
    restartAttempts: Map<string, number>;
    timeoutRetries: Map<string, number>;
    unreachableStreak: Map<string, number>;
    terminalSuspended: Set<string>;
  };

const eventsOf = async (m: Mesh, type: string, agentId?: string): Promise<MeshEvent[]> =>
  (await collectEvents(m)).filter((e) => e.type === type && (agentId === undefined || (e.payload as { agentId?: string }).agentId === agentId));

/** No strike on any of the seat's failure counters, and not marked parked. */
function assertNoStrike(m: Mesh, id: string): void {
  const s = internals(m);
  assert.equal(s.restartAttempts.get(id), undefined, `${id}: no crash strike`);
  assert.equal(s.timeoutRetries.get(id), undefined, `${id}: no slow-turn strike`);
  assert.equal(s.unreachableStreak.get(id), undefined, `${id}: no unreachable strike`);
  assert.equal(s.terminalSuspended.has(id), false, `${id}: not marked terminally parked`);
}

/** The seat's failure cards: the ladder's terminal `runtime:` / `backend:` ones. */
const cardsFor = (m: Mesh, id: string) =>
  [...m.kernel.state.escalations.values()].filter((e) => e.conflictKey === `runtime:${id}` || e.conflictKey === `backend:${id}`);

/**
 * Model runtime-claude's session stop: the seat's first turn sits in the model
 * until `stop()` is called on its session, which settles the pending call with
 * the adapter's own error. Later turns answer normally.
 */
function turnDiesWithItsSession(m: Mesh, id: string, deliberate = true): { inModel: () => boolean; thrown: () => Error | undefined } {
  const rt = stub(m);
  let settle: ((err: Error) => void) | undefined;
  let thrown: Error | undefined;
  rt.setScript(id, async (_input, idx) => {
    if (idx === 0) await new Promise<never>((_resolve, reject) => (settle = reject));
    return DONE;
  });
  const stop = rt.stop.bind(rt);
  rt.stop = async (session) => {
    const pending = session.agentId === id ? settle : undefined;
    settle = undefined;
    if (pending) {
      thrown = new BackendUnreachableError(`claude:${session.sessionId}`, "session torn down", { deliberate });
      pending(thrown);
    }
    return stop(session);
  };
  return { inModel: () => settle !== undefined, thrown: () => thrown };
}

/** Wake `id` and wait until its turn is parked in the model. */
async function midTurn(m: Mesh, id: string, deliberate = true): Promise<{ turnId: string; thrown: () => Error | undefined }> {
  const turn = turnDiesWithItsSession(m, id, deliberate);
  const r = await m.supervisor.activateAgent(id, { kind: "manual" });
  assert.equal(r.queued, true, r.blocked);
  await waitFor(`${id}'s turn is in the model`, () => turn.inModel() && m.supervisor.isTurnInFlight(id));
  const woke = (await eventsOf(m, "agent.awakened", id)).at(-1);
  const turnId = (woke?.payload as { turnId?: string } | undefined)?.turnId;
  assert.ok(turnId, "fixture: the turn has an id");
  return { turnId, thrown: turn.thrown };
}

/**
 * Run `firstLife` on a file-backed mesh, close it, and boot a second process
 * life over the same state dir (`bootstrapMesh` resumes: the log is non-empty).
 */
async function acrossARestart(firstLife: (m: TestMesh) => Promise<void>, secondLife: (m: Mesh) => Promise<void>): Promise<void> {
  const first = await makeMesh({ agents: AGENTS, startup: [], mayContact: MAY_CONTACT, persist: true });
  try {
    try {
      await firstLife(first);
    } finally {
      await first.close();
      first.stubRuntimes.get("stub")?.releaseHangs();
    }
    const second = await bootstrapMesh({ configPath: path.join(first.dir, "mesh.yaml"), inMemory: false, useGit: false, mode: "live" });
    try {
      for (const a of AGENTS) stub(second).setScript(a.id, () => DONE);
      await secondLife(second);
    } finally {
      await second.close();
      second.stubRuntimes.get("stub")?.releaseHangs();
    }
  } finally {
    fs.rmSync(first.dir, { recursive: true, force: true });
  }
}

/**
 * The shape the 13:42Z child left behind, written directly: a turn in the model,
 * then `agent.failed` for it, then nothing — the process exited before the
 * handler's next emit.
 */
async function failedMidHandler(m: Mesh, id: string, restartable: boolean | undefined): Promise<void> {
  const turnId = `turn-legacy-${id}`;
  await m.kernel.emit("agent.started", { agentId: id, sessionId: null, runtime: "stub" }, { actorId: id });
  await m.kernel.emit("agent.awakened", { agentId: id, reason: { kind: "message", note: "3 messages waiting" }, turnId }, { actorId: id, correlationId: turnId });
  await m.kernel.emit("agent.state_changed", { agentId: id, to: "OBSERVING", turnId }, { actorId: id, correlationId: turnId });
  await m.kernel.emit("agent.state_changed", { agentId: id, to: "THINKING", turnId }, { actorId: id, correlationId: turnId });
  await m.kernel.emit(
    "agent.failed",
    { agentId: id, error: "claude:96abe41e-1a22-4830-8ad3-5488ade788a0", sessionId: null, ...(restartable === undefined ? {} : { restartable }) },
    { actorId: id },
  );
  assert.equal(lifecycle(m, id), "FAILED", `fixture: ${id} is FAILED`);
}

// ------------------------------------------------------------ the cause

test("shutdown: the turn it stops is closed as interrupted — no agent.failed, no strike, no restart, no card", async () => {
  const m = await makeMesh({ agents: AGENTS, startup: [], mayContact: MAY_CONTACT });
  try {
    const { turnId, thrown } = await midTurn(m, "dev");
    await m.supervisor.shutdown();
    await waitFor("dev's turn has closed", () => !m.supervisor.isTurnInFlight("dev"));
    const err = thrown();
    assert.ok(err, "fixture: the session stop failed the turn");
    const detail = `stopped by the mesh shutting down (${err.message})`.slice(0, 200);

    assert.equal((await eventsOf(m, "agent.failed", "dev")).length, 0, "not a seat failure");
    assert.equal((await eventsOf(m, "agent.restarted", "dev")).length, 0, "so nothing to restart");
    assert.equal(lifecycle(m, "dev"), "IDLE");

    // The close: the turn's own IDLE, carrying its id (what step reconstruction
    // and `closeAbandonedTurns` read as its end), marked with why.
    const closes = (await eventsOf(m, "agent.state_changed", "dev")).filter((e) => (e.payload as { turnId?: string }).turnId === turnId && (e.payload as { to?: string }).to === "IDLE");
    assert.equal(closes.length, 1);
    assert.equal(closes[0]!.actorId, "system");
    assert.deepEqual(closes[0]!.payload, { agentId: "dev", to: "IDLE", cause: MESH_SHUTDOWN_CAUSE, note: detail, turnId });

    // The discard says interrupted, not failed.
    const discards = (await eventsOf(m, "turn.discarded", "dev")).filter((e) => (e.payload as { turnId?: string }).turnId === turnId);
    assert.equal(discards.length, 1);
    assert.deepEqual(discards[0]!.payload, { agentId: "dev", turnId, reason: "interrupted", detail });
    assert.equal(m.supervisor.getRecentTurns(10).find((t) => t.turnId === turnId)?.status, "blocked", "not recorded as a crash");

    assertNoStrike(m, "dev");
    assert.deepEqual(cardsFor(m, "dev"), [], "no card");
    await paused(150);
    assert.equal((await eventsOf(m, "agent.awakened", "dev")).length, 1, "no recovery wake in a process that is going away");
  } finally {
    await m.cleanup();
  }
});

test("shutdown: the recorded cause never says the server may have crashed, whichever runtime threw", async () => {
  // The adapter's own teardown throws a `deliberate` BackendUnreachableError; a
  // runtime that does not (the HTTP adapter's refused socket) carries the crash
  // hint. A shutdown is the mesh's doing either way, so neither reaches the log.
  for (const deliberate of [true, false]) {
    const m = await makeMesh({ agents: AGENTS, startup: [], mayContact: MAY_CONTACT });
    try {
      const { turnId } = await midTurn(m, "dev", deliberate);
      await m.supervisor.shutdown();
      await waitFor("dev's turn has closed", () => !m.supervisor.isTurnInFlight("dev"));
      const discard = (await eventsOf(m, "turn.discarded", "dev")).find((e) => (e.payload as { turnId?: string }).turnId === turnId);
      const detail = String((discard?.payload as { detail?: string } | undefined)?.detail);
      assert.match(detail, /^stopped by the mesh shutting down \(backend unreachable at claude:[^)]*\(session torn down\)\)$/, `deliberate=${deliberate}: ${detail}`);
      assert.doesNotMatch(detail, /crashed|still running/);
      assert.doesNotMatch(detail, /after the mission ended/, "the mission was still running");
    } finally {
      await m.cleanup();
    }
  }
});

test("shutdown: a stop after the mission has a verdict says it was the end of the mission", async () => {
  const m = await makeMesh({ agents: AGENTS, startup: [], mayContact: MAY_CONTACT });
  try {
    const { turnId } = await midTurn(m, "dev");
    const goalId = m.kernel.state.activeGoalId!;
    await m.kernel.emit("goal.failed", { goalId, reason: "test verdict" }, { actorId: "human" });
    await m.supervisor.shutdown();
    await waitFor("dev's turn has closed", () => !m.supervisor.isTurnInFlight("dev"));
    const discard = (await eventsOf(m, "turn.discarded", "dev")).find((e) => (e.payload as { turnId?: string }).turnId === turnId);
    assert.match(String((discard?.payload as { detail?: string } | undefined)?.detail), /^stopped by the mesh shutting down after the mission ended \(/);
  } finally {
    await m.cleanup();
  }
});

test("completion: a stop asked for while the mission is completing waits for the running turn, then stops", async () => {
  // The CLI's completion watch polls /status and closes the server the moment it
  // reads `goal.completed` -- before `completeMission` has drained the turns it is
  // waiting on. `shutdown()` used to stop their sessions under them: the PM's last
  // turn of the cronlite run was discarded mid-sentence with a crash message.
  const m = await makeMesh({ agents: AGENTS, startup: [], mayContact: MAY_CONTACT });
  try {
    const rt = stub(m);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    rt.setScript("dev", async (_input, idx) => {
      if (idx === 0) await held;
      return DONE;
    });
    let sessionStoppedAt: "early" | "late" | undefined;
    let released = false;
    const stop = rt.stop.bind(rt);
    rt.stop = async (session) => {
      if (session.agentId === "dev") sessionStoppedAt = released ? "late" : "early";
      return stop(session);
    };
    const woke = await m.supervisor.activateAgent("dev", { kind: "manual" });
    assert.equal(woke.queued, true, woke.blocked);
    await waitFor("dev's turn is in the model", () => m.supervisor.isTurnInFlight("dev"));

    const completing = (m.supervisor as unknown as { completeMission(): Promise<void> }).completeMission();
    let stopReturned = false;
    const stopping = m.supervisor.shutdown().then(() => {
      stopReturned = true;
    });
    await paused(300);
    assert.equal(stopReturned, false, "the stop is waiting on the running turn, not racing it");
    // Not merely slow: the stop has not BEGUN. `scheduler.stop()` alone would also
    // wait (up to 5 s) for a running turn, which hides the race for any turn that
    // ends inside that bound -- the PM's did not.
    assert.equal((m.supervisor as unknown as { stopping: boolean }).stopping, false, "the supervisor is not yet stopping");
    assert.equal(sessionStoppedAt, undefined, "and no session was stopped under it");
    assert.equal(m.supervisor.isTurnInFlight("dev"), true);

    released = true;
    release();
    await Promise.all([completing, stopping]);
    assert.equal(stopReturned, true);
    assert.equal((await eventsOf(m, "turn.discarded", "dev")).length, 0, "the turn ended on its own, nothing was discarded");
    assert.equal((await eventsOf(m, "agent.failed", "dev")).length, 0);
    assert.equal(sessionStoppedAt, "late", "the sessions were stopped once the turn had finished");
  } finally {
    await m.cleanup();
  }
});

test("shutdown: only the turns it stopped — a genuine failure after it, on an operator's explicit wake, still walks the ladder", async () => {
  const m = await makeMesh({ agents: AGENTS, startup: [], mayContact: MAY_CONTACT });
  try {
    // `stopping` stays latched after this (a completion is the live case), and
    // an explicit wake still runs on the stopped scheduler.
    await m.supervisor.shutdown();
    stub(m).setScript("dev", (_input, idx) => (idx === 0 ? { throwKind: "generic" as const, throwMessage: "genuinely broken" } : DONE));
    const r = await m.supervisor.activateAgent("dev", { kind: "manual" });
    assert.equal(r.queued, true, r.blocked);
    await waitFor("dev's failure was handled", async () => (await eventsOf(m, "agent.restarted", "dev")).length === 1 && !m.supervisor.isTurnInFlight("dev"));
    const failed = await eventsOf(m, "agent.failed", "dev");
    assert.equal(failed.length, 1, "a failure the shutdown did not cause is still one");
    assert.equal((failed[0]!.payload as { restartable?: boolean }).restartable, true);
    assert.equal(internals(m).restartAttempts.get("dev"), 1, "and it costs its strike");
  } finally {
    await m.cleanup();
  }
});

test("restart: a seat the shutdown stopped mid-turn boots IDLE and activatable — no strike, no card", async () => {
  await acrossARestart(
    async (first) => {
      await midTurn(first, "dev");
      // `close()` is the child's SIGTERM path: shutdown, snapshot, store close.
    },
    async (second) => {
      assert.equal(lifecycle(second, "dev"), "IDLE", "never FAILED");
      assert.equal((await eventsOf(second, "agent.failed", "dev")).length, 0, "no agent.failed in either life");
      assertNoStrike(second, "dev");
      assert.deepEqual(cardsFor(second, "dev"), []);
      assert.equal([...second.kernel.state.escalations.values()].filter((e) => e.status === "OPEN").length, 0, "no escalation at all");

      const r = await second.supervisor.activateAgent("dev", { kind: "manual" });
      assert.equal(r.queued, true, r.blocked);
      await waitFor("dev's turn back ran", async () => (await eventsOf(second, "agent.awakened", "dev")).length >= 2 && !second.supervisor.isTurnInFlight("dev"), 8000);
      assert.equal(second.supervisor.getRecentTurns(20).find((t) => t.agentId === "dev")?.status, "ok");
      assert.equal((await eventsOf(second, "agent.restarted", "dev")).filter((e) => e.actorId === "human").length, 0, "no operator-attributed FAILED reset");
    },
  );
});

// ------------------------------------------------------------ legacy logs (step 8g)

test("restart: a seat a previous process left FAILED mid-handler (the 13:42Z shape) is restored at boot and woken", async () => {
  await acrossARestart(
    async (first) => {
      await failedMidHandler(first, "dev", true);
    },
    async (second) => {
      assert.equal(lifecycle(second, "dev") === "FAILED", false, "restored before anything could see it FAILED");
      const restarts = await eventsOf(second, "agent.restarted", "dev");
      assert.ok(restarts.length >= 1);
      // The restore: the ladder's own two events, by the recovery actor, marked,
      // with no `attempt` — no strike was counted.
      assert.equal(restarts[0]!.actorId, RECOVERY_ACTOR_ID);
      assert.deepEqual(restarts[0]!.payload, { agentId: "dev", cause: MESH_SHUTDOWN_CAUSE });
      const idle = (await eventsOf(second, "agent.state_changed", "dev")).find((e) => (e.payload as { cause?: string }).cause === MESH_SHUTDOWN_CAUSE);
      assert.ok(idle, "restored to IDLE");
      assert.equal(idle.actorId, RECOVERY_ACTOR_ID);
      assert.equal((idle.payload as { to?: string }).to, "IDLE");
      assert.equal(restarts.filter((e) => e.actorId === "human").length, 0, "not reset by the activation's operator override");

      assertNoStrike(second, "dev");
      assert.deepEqual(cardsFor(second, "dev"), []);
      assert.equal([...second.kernel.state.escalations.values()].filter((e) => e.status === "OPEN").length, 0, "no escalation");

      // The resumed boot wakes it, as it woke the FAILED seat before.
      await waitFor("dev's recovery turn ran", async () => (await eventsOf(second, "agent.awakened", "dev")).length >= 2 && !second.supervisor.isTurnInFlight("dev"), 8000);
      const woke = (await eventsOf(second, "agent.awakened", "dev")).at(-1)!.payload as { reason?: { kind?: string; note?: string } };
      assert.equal(woke.reason?.kind, "recovery");
      assert.equal(woke.reason?.note, "mission resumed from event log");
      assert.equal(second.supervisor.getRecentTurns(20).find((t) => t.agentId === "dev")?.status, "ok");
      assert.equal(lifecycle(second, "dev"), "IDLE");
    },
  );
});

test("restart: a restored seat in a PARKED boot is IDLE too, and nothing wakes it", async () => {
  const first = await makeMesh({ agents: AGENTS, startup: [], mayContact: MAY_CONTACT, persist: true });
  try {
    try {
      await failedMidHandler(first, "dev", true);
    } finally {
      await first.close();
    }
    const second = await bootstrapMesh({ configPath: path.join(first.dir, "mesh.yaml"), inMemory: false, useGit: false, mode: "parked" });
    try {
      assert.equal(lifecycle(second, "dev"), "IDLE");
      await paused(150);
      assert.equal((await eventsOf(second, "agent.awakened", "dev")).length, 1, "parked: only the first life's turn");
      const r = await second.supervisor.activateAgent("dev", { kind: "manual" });
      assert.equal(r.queued, true, "activatable");
    } finally {
      await second.close();
    }
  } finally {
    fs.rmSync(first.dir, { recursive: true, force: true });
  }
});

test("restart: a seat parked SUSPENDED after a terminal failure stays down", async () => {
  await acrossARestart(
    async (first) => {
      stub(first).setScript("pm", () => ({ throwKind: "generic" as const, throwMessage: "429 Go usage limit exceeded" }));
      await first.supervisor.activateAgent("pm", { kind: "manual" });
      await waitFor("pm is parked", () => lifecycle(first, "pm") === "SUSPENDED" && !first.supervisor.isTurnInFlight("pm"));
    },
    async (second) => {
      assert.equal(lifecycle(second, "pm"), "SUSPENDED");
      await paused(200);
      assert.equal(lifecycle(second, "pm"), "SUSPENDED");
      assert.equal((await eventsOf(second, "agent.restarted", "pm")).length, 0);
      assert.equal((await eventsOf(second, "agent.awakened", "pm")).length, 1, "only the turn that failed");
    },
  );
});

test("restart: a seat that failed `restartable: false` (or with no flag at all) stays FAILED and is not woken", async () => {
  await acrossARestart(
    async (first) => {
      await failedMidHandler(first, "pm", false);
      await failedMidHandler(first, "qa", undefined);
    },
    async (second) => {
      await paused(250);
      for (const id of ["pm", "qa"]) {
        assert.equal(lifecycle(second, id), "FAILED", `${id} stays down`);
        assert.equal((await eventsOf(second, "agent.restarted", id)).length, 0, `${id}: not restored, and not reset by the boot's wake`);
        assert.equal((await eventsOf(second, "agent.awakened", id)).length, 1, `${id}: only the turn that failed`);
      }
    },
  );
});

test("restart: FAILED `restartable: true` whose handler finished with a terminal card (a pre-park build) stays down; a cut-off one beside it is restored", async () => {
  await acrossARestart(
    async (first) => {
      await failedMidHandler(first, "qa", true);
      // The handler's last act on the terminal path, as builds before the
      // SUSPENDED park ended it: the seat left FAILED, the card raised.
      await first.supervisor.escalate({
        reason: "runtime_failure",
        raisedBy: RECOVERY_ACTOR_ID,
        conflictKey: "runtime:qa",
        advisory: true,
        detail: { agentId: "qa", error: "claude:x", attempts: 4 },
      });
      await failedMidHandler(first, "dev", true);
    },
    async (second) => {
      await waitFor("dev is back", () => lifecycle(second, "dev") === "IDLE" && !second.supervisor.isTurnInFlight("dev"), 8000);
      assert.equal(lifecycle(second, "qa"), "FAILED", "the card says the handler finished: FAILED was its verdict");
      assert.equal((await eventsOf(second, "agent.restarted", "qa")).length, 0);
      assert.equal((await eventsOf(second, "agent.awakened", "qa")).length, 1);
      assert.equal((await eventsOf(second, "agent.restarted", "dev")).filter((e) => (e.payload as { cause?: string }).cause === MESH_SHUTDOWN_CAUSE).length, 1);
    },
  );
});
