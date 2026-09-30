import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { makeMesh, stub, waitFor, collectEvents, goalOf, type AgentSpec, type TestMesh } from "../helpers";
import { bootstrapMesh, createHttpServer, closeHttpServer, type MeshInstance } from "../../apps/mesh-server/src/index";
import { isTerminalFailureSuspension, TERMINAL_FAILURE_CAUSE } from "../../packages/core/src/supervisor";
import type { MeshEvent, MeshMessage, MeshOp } from "../../packages/protocol/src/index";

/**
 * `terminalSuspended` means the same thing after a restart as before it.
 *
 * The set is how an escalation answer tells a seat the MESH parked for terminal
 * failure (revive it) from one the OPERATOR paused (leave it down). It was
 * process memory, and on 2026-09-28 that was the common case, not the edge:
 * every seat was parked by a provider outage at ~08:57Z, the operator fixed the
 * provider, restarted the host (13:01Z), and answered all ten `runtime_failure`
 * cards "retry". The set was empty, nobody was revived, and ten seats were
 * resumed by hand.
 *
 * Boot now rebuilds it from the log. The first half of this file drives a real
 * park, a real pause and a real stop-with-suspend in one process life, closes
 * it, boots a second over the same state dir, and answers a card there.
 *
 * The second half is the counterpart the death notice never had: a revival is
 * announced, once, so peers stop reasoning from "X failed terminally".
 */

const AGENTS: AgentSpec[] = [
  { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [], persistent: false },
  { id: "qa", role: "qa", capabilities: ["repository.read"], interests: [], persistent: false },
  { id: "pm", role: "pm", capabilities: ["repository.read"], interests: [], persistent: false },
];
const MAY_CONTACT = { dev: ["qa", "pm"], qa: ["dev", "pm"], pm: ["dev", "qa"] };

type Mesh = MeshInstance;

const lifecycle = (m: Mesh, id: string) => m.kernel.state.agents.get(id)?.state.lifecycle;
const marked = (m: Mesh): string[] => [...(m.supervisor as unknown as { terminalSuspended: Set<string> }).terminalSuspended].sort();
const paused = (ms: number) => new Promise((r) => setTimeout(r, ms));

const eventsOf = async (m: Mesh, type: string, agentId?: string): Promise<MeshEvent[]> =>
  (await collectEvents(m)).filter((e) => e.type === type && (agentId === undefined || (e.payload as { agentId?: string }).agentId === agentId));

/** Revival notices: the runtime's INFORM that parked seats are back. */
const revivalNotices = async (m: Mesh): Promise<Array<{ index: number; message: MeshMessage }>> =>
  (await collectEvents(m)).flatMap((e, index) => {
    if (e.type !== "message.sent") return [];
    const message = (e.payload as { message: MeshMessage }).message;
    const payload = message.payload as { available?: unknown } | undefined;
    return message.from === "human" && payload?.available === true ? [{ index, message }] : [];
  });

/** A real terminal failure: a turn that throws, on a seat with no restarts. Later turns answer. */
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

/** The watchdog's stall card, halting the mission, as `escalation-revive.test.ts` poses it. */
async function stallCard(m: Mesh): Promise<string> {
  const goalId = m.kernel.state.activeGoalId!;
  const esc = await m.supervisor.escalate({
    reason: "stalemate:stall_nudge_cap",
    raisedBy: "stall-watchdog",
    conflictKey: `stall-cap:${goalId}`,
    detail: { cause: "nudges_produced_no_work", nudges: 3, refusals: 0 },
  });
  await m.kernel.emit("goal.escalated", { goalId, reason: "stalemate:stall_nudge_cap" }, { actorId: "termination-manager", goalId });
  assert.equal(goalOf(m)?.status, "ESCALATED", "fixture: the mission is halted");
  return esc.id;
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

async function post(base: string, p: string, body?: unknown): Promise<number> {
  const r = await fetch(`${base}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  await r.text();
  return r.status;
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
      for (const a of AGENTS) stub(second).setScript(a.id, () => ({ text: "back at work", operations: [{ op: "done" } as MeshOp] }));
      await secondLife(second);
    } finally {
      await second.close();
      second.stubRuntimes.get("stub")?.releaseHangs();
    }
  } finally {
    fs.rmSync(first.dir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------ the classifier

test("classifier: the park's shapes are terminal, every operator shape is not", () => {
  const ev = (type: string, payload: Record<string, unknown>) => ({ type, payload }) as Pick<MeshEvent, "type" | "payload">;
  // The park as written from today on.
  assert.equal(isTerminalFailureSuspension(ev("agent.state_changed", { agentId: "dev", to: "SUSPENDED", cause: TERMINAL_FAILURE_CAUSE, note: "terminal failure: 429" })), true);
  // The park as every log before today has it: the note is the only marker.
  assert.equal(isTerminalFailureSuspension(ev("agent.state_changed", { agentId: "dev", to: "SUSPENDED", note: "terminal failure: 429 Go usage limit exceeded" })), true, "legacy");
  assert.equal(isTerminalFailureSuspension(ev("agent.state_changed", { agentId: "dev", to: "SUSPENDED", cause: "terminal_failure" })), true, "the marker alone suffices");

  // The operator: `suspendAgent` (pause, POST /agents/:id/suspend, staged
  // suspend) and `suspendAfterStop` (a stop with `suspend: true`).
  assert.equal(isTerminalFailureSuspension(ev("agent.suspended", { agentId: "dev" })), false, "pause");
  assert.equal(isTerminalFailureSuspension(ev("agent.suspended", { agentId: "dev", note: "stopped by the operator: terminal failure: loop", turnId: "turn-1" })), false, "stop with suspend — its note is not read");
  assert.equal(isTerminalFailureSuspension(ev("agent.suspended", { agentId: "dev", cause: TERMINAL_FAILURE_CAUSE })), false, "the operator's event type is never the park");

  // Not a suspension, or not this one.
  assert.equal(isTerminalFailureSuspension(ev("agent.state_changed", { agentId: "dev", to: "IDLE", cause: TERMINAL_FAILURE_CAUSE, note: "terminal failure: x" })), false);
  assert.equal(isTerminalFailureSuspension(ev("agent.state_changed", { agentId: "dev", to: "SUSPENDED", note: "budget: exhausted" })), false, "unrecognised degrades to hand-resume");
  assert.equal(isTerminalFailureSuspension(ev("agent.state_changed", { agentId: "dev", to: "SUSPENDED" })), false);
});

test("the live park writes the durable marker, and the classifier reads the event it wrote", async () => {
  const m = await makeMesh({ agents: AGENTS, startup: [], mayContact: MAY_CONTACT });
  try {
    await parkTerminally(m, "dev");
    const parks = (await eventsOf(m, "agent.state_changed", "dev")).filter((e) => (e.payload as { to?: string }).to === "SUSPENDED");
    assert.equal(parks.length, 1);
    const p = parks[0]!.payload as { cause?: string; note?: string };
    assert.equal(p.cause, TERMINAL_FAILURE_CAUSE);
    assert.match(String(p.note), /^terminal failure: /, "the note is unchanged, so legacy readers still work");
    assert.equal(isTerminalFailureSuspension(parks[0]!), true);
  } finally {
    await m.cleanup();
  }
});

// ------------------------------------------------------------ across a restart

test("restart: a seat parked in a previous life is rebuilt, and the answer to its card revives it and its wake is admitted", async () => {
  await acrossARestart(
    async (first) => {
      await parkTerminally(first, "dev");
      assert.deepEqual(marked(first), ["dev"], "fixture: classified live");
    },
    async (second) => {
      assert.equal(lifecycle(second, "dev"), "SUSPENDED", "the park survives the restart");
      assert.deepEqual(marked(second), ["dev"], "boot rebuilt the classification from the log");

      // The live answer: the park's own `runtime_failure` card, answered "retry".
      const card = [...second.kernel.state.escalations.values()].find(
        (e) => e.reason === "runtime_failure" && e.status === "OPEN" && (e.detail as { agentId?: string }).agentId === "dev",
      );
      assert.ok(card, "fixture: the park's card is still open after the restart");
      const r = await second.supervisor.respondEscalation(card.id, "retry");
      assert.equal(r.ok, true, r.reason);

      assert.equal(lifecycle(second, "dev"), "IDLE", "the answer resumes the seat the mesh parked");
      assert.equal((await eventsOf(second, "agent.resumed", "dev")).length, 1);
      assert.deepEqual(marked(second), [], "and it is no longer marked");
      await waitFor("dev's revived turn ran", async () => (await eventsOf(second, "agent.awakened", "dev")).length >= 2, 8000);
      await waitFor("dev is idle between turns", () => !second.supervisor.isTurnInFlight("dev"), 8000);
      assert.equal(second.supervisor.getRecentTurns(20).find((t) => t.agentId === "dev")?.status, "ok", "the activation was admitted and the turn back is not a failure");
      assert.equal((await revivalNotices(second)).length, 1, "the revival is announced in this life too");
    },
  );
});

test("restart: a seat the operator paused (POST /agents/:id/suspend) is not rebuilt, and stays down through an answer", async () => {
  await acrossARestart(
    async (first) => {
      await parkTerminally(first, "dev");
      await withServer(first, async (base) => assert.equal(await post(base, "/agents/qa/suspend"), 200));
      assert.equal(lifecycle(first, "qa"), "SUSPENDED");
    },
    async (second) => {
      assert.deepEqual(marked(second), ["dev"], "only the park is rebuilt, not the pause");
      const r = await second.supervisor.respondEscalation(await stallCard(second), "retry");
      assert.equal(r.ok, true, r.reason);
      assert.equal(lifecycle(second, "dev"), "IDLE");
      assert.equal(lifecycle(second, "qa"), "SUSPENDED", "the answer must not undo a deliberate pause");
      assert.equal((await eventsOf(second, "agent.resumed", "qa")).length, 0);
      await paused(200);
      assert.equal(lifecycle(second, "qa"), "SUSPENDED");
      assert.equal((await eventsOf(second, "agent.awakened", "qa")).length, 0, "and nothing woke it");
    },
  );
});

test("restart: a seat the operator stopped with `suspend: true` is not rebuilt, and stays down through an answer", async () => {
  await acrossARestart(
    async (first) => {
      let started = false;
      stub(first).setScript("qa", async () => {
        started = true;
        return { delayMs: 5000, interruptUsage: { input: 10, output: 10, total: 20 } };
      });
      await first.supervisor.activateAgent("qa", { kind: "manual" });
      await waitFor("qa's slow turn is in the model", () => started && first.supervisor.isTurnInFlight("qa"), 5000);
      const res = await first.supervisor.interruptTurn("qa", { suspend: true });
      assert.equal(res.ok, true, JSON.stringify(res));
      await waitFor("qa is suspended by the stop", () => lifecycle(first, "qa") === "SUSPENDED" && !first.supervisor.isTurnInFlight("qa"));
      const stopEvent = (await eventsOf(first, "agent.suspended", "qa")).at(-1)?.payload as { turnId?: string } | undefined;
      assert.ok(stopEvent?.turnId, "fixture: this is the stop-with-suspend shape, not the plain pause");
    },
    async (second) => {
      assert.equal(lifecycle(second, "qa"), "SUSPENDED", "the stop's suspension survives the restart");
      assert.deepEqual(marked(second), []);
      const r = await second.supervisor.respondEscalation(await stallCard(second), "retry");
      assert.equal(r.ok, true, r.reason);
      assert.equal(lifecycle(second, "qa"), "SUSPENDED");
      assert.equal((await eventsOf(second, "agent.resumed", "qa")).length, 0);
      assert.equal((await revivalNotices(second)).length, 0, "nothing was revived, so nothing is announced");
    },
  );
});

test("restart: the LATEST suspension wins — parked, resumed, then paused is the operator's; re-paused while parked too", async () => {
  await acrossARestart(
    async (first) => {
      // dev: park -> operator resume -> operator pause.
      await parkTerminally(first, "dev");
      await first.supervisor.resumeAgent("dev");
      await first.supervisor.suspendAgent("dev");
      // qa: park -> operator pause of the already-parked seat.
      await parkTerminally(first, "qa");
      await first.supervisor.suspendAgent("qa");
      // pm: park -> resume -> park again. The latest is a park.
      stub(first).setScript("pm", (_input, idx) =>
        idx <= 1 ? { throwKind: "generic" as const, throwMessage: "429 again" } : { text: "ok", operations: [{ op: "done" } as MeshOp] },
      );
      await first.supervisor.activateAgent("pm", { kind: "manual" });
      await waitFor("pm parked", () => lifecycle(first, "pm") === "SUSPENDED" && !first.supervisor.isTurnInFlight("pm"));
      await first.supervisor.resumeAgent("pm");
      await first.supervisor.activateAgent("pm", { kind: "manual" });
      await waitFor("pm parked again", async () => (await eventsOf(first, "agent.state_changed", "pm")).filter((e) => (e.payload as { to?: string }).to === "SUSPENDED").length === 2 && !first.supervisor.isTurnInFlight("pm"));
      // Live and rebuilt must agree, so pin the live side first.
      assert.deepEqual(marked(first), ["pm"], "live: an operator pause, even of a parked seat, outranks the park");
    },
    async (second) => {
      for (const id of ["dev", "qa", "pm"]) assert.equal(lifecycle(second, id), "SUSPENDED", `fixture: ${id} is suspended`);
      assert.deepEqual(marked(second), ["pm"], "rebuilt: the same answer as the live set");
      const r = await second.supervisor.respondEscalation(await stallCard(second), "retry");
      assert.equal(r.ok, true, r.reason);
      assert.equal(lifecycle(second, "dev"), "SUSPENDED", "resumed and then paused by the operator: stays down");
      assert.equal(lifecycle(second, "qa"), "SUSPENDED", "paused by the operator while parked: stays down");
      assert.equal(lifecycle(second, "pm"), "IDLE", "parked last: revived");
    },
  );
});

test("restart: a legacy log — the park's note, no `cause` marker — is still recognised", async () => {
  await acrossARestart(
    async (first) => {
      // Exactly the event every build before this one wrote.
      await first.kernel.emit("agent.state_changed", { agentId: "dev", to: "SUSPENDED", note: "terminal failure: 429 Go usage limit exceeded" }, { actorId: "human" });
      assert.equal(lifecycle(first, "dev"), "SUSPENDED");
    },
    async (second) => {
      assert.deepEqual(marked(second), ["dev"]);
      const r = await second.supervisor.respondEscalation(await stallCard(second), "retry");
      assert.equal(r.ok, true, r.reason);
      assert.equal(lifecycle(second, "dev"), "IDLE");
      await waitFor("dev's revived turn ran", async () => (await eventsOf(second, "agent.awakened", "dev")).length >= 1, 8000);
    },
  );
});

// ------------------------------------------------------------ the revival notice

test("notice: a revival is announced once, naming every revived seat, to every seat, before the revived seats' first turn", async () => {
  const m = await makeMesh({ agents: AGENTS, startup: [], mayContact: MAY_CONTACT });
  try {
    await parkTerminally(m, "dev");
    await parkTerminally(m, "qa");
    assert.equal((await revivalNotices(m)).length, 0, "fixture: nothing announced before the answer");

    const r = await m.supervisor.respondEscalation(await stallCard(m), "provider fixed, go again");
    assert.equal(r.ok, true, r.reason);

    const notices = await revivalNotices(m);
    assert.equal(notices.length, 1, "ONE notice for the whole revival");
    const { index, message } = notices[0]!;
    const payload = message.payload as { available?: boolean; revived?: string[]; reason?: string };
    assert.equal(message.type, "INFORM");
    assert.deepEqual([...(payload.revived ?? [])].sort(), ["dev", "qa"]);
    assert.match(String(payload.reason), /superseded/, "it says the earlier death notices no longer hold");
    assert.match(String(payload.reason), /failed terminally/);
    assert.deepEqual([...message.to].sort(), ["dev", "pm", "qa"], "every seat that is not retired, not only creditors");
    assert.equal(message.control?.mode, "broadcast", "an announcement: it wakes no one by itself and takes no replies");

    // Sent between the resumes and the activations, so a revived seat's first
    // turn reads it instead of being woken again for it afterwards.
    await waitFor("both revived seats take a turn", async () => (await eventsOf(m, "agent.awakened", "dev")).length >= 2 && (await eventsOf(m, "agent.awakened", "qa")).length >= 2, 8000);
    const events = await collectEvents(m);
    for (const id of ["dev", "qa"]) {
      const resumedAt = events.findIndex((e) => e.type === "agent.resumed" && (e.payload as { agentId?: string }).agentId === id);
      const wokeAt = events.findIndex((e, i) => i > resumedAt && e.type === "agent.awakened" && (e.payload as { agentId?: string }).agentId === id);
      assert.ok(resumedAt >= 0 && resumedAt < index, `${id} is resumed before it is named back`);
      assert.ok(wokeAt > index, `${id}'s first turn back comes after the notice`);
    }
  } finally {
    await m.cleanup();
  }
});

test("notice: by itself it wakes nobody — an idle peer holds it unread until something else wakes it", async () => {
  const m = await makeMesh({ agents: AGENTS, startup: [], mayContact: MAY_CONTACT });
  try {
    await parkTerminally(m, "dev");
    const pmWakes = (await eventsOf(m, "agent.awakened", "pm")).length;
    // The revival alone, without `respondEscalation`'s own recovery sweep
    // (which wakes every seat holding mail, whatever the mail is).
    const revive = (m.supervisor as unknown as { reviveTerminalSuspended(why: string): Promise<string[]> }).reviveTerminalSuspended.bind(m.supervisor);
    assert.deepEqual(await revive("test"), ["dev"]);

    const [notice] = await revivalNotices(m);
    assert.ok(notice, "announced");
    await waitFor("dev's revived turn ran", async () => (await eventsOf(m, "agent.awakened", "dev")).length >= 2, 8000);
    await paused(300);
    assert.equal((await eventsOf(m, "agent.awakened", "pm")).length, pmWakes, "pm was not woken by the notice");
    assert.ok(m.kernel.state.unread.get("pm")?.includes(notice.message.id), "but it is in pm's mailbox, read on pm's next turn");
  } finally {
    await m.cleanup();
  }
});

test("notice: an operator pause -> resume announces nothing, by hand or through the route", async () => {
  const m = await makeMesh({ agents: AGENTS, startup: [], mayContact: MAY_CONTACT });
  try {
    await m.supervisor.suspendAgent("dev");
    await m.supervisor.resumeAgent("dev");
    await withServer(m, async (base) => {
      assert.equal(await post(base, "/agents/qa/suspend"), 200);
      assert.equal(await post(base, "/agents/qa/resume"), 200);
    });
    assert.equal(lifecycle(m, "dev"), "IDLE");
    assert.equal(lifecycle(m, "qa"), "IDLE");
    // And an answer with only operator-paused seats around revives nobody.
    await m.supervisor.suspendAgent("pm");
    const r = await m.supervisor.respondEscalation(await stallCard(m), "retry");
    assert.equal(r.ok, true, r.reason);
    assert.equal(lifecycle(m, "pm"), "SUSPENDED");
    assert.equal((await revivalNotices(m)).length, 0, "no seat came back from a terminal failure, so nothing is announced");
  } finally {
    await m.cleanup();
  }
});
