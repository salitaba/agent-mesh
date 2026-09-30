import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { makeMesh, stub, collectEvents, type AgentSpec, type TestMesh } from "../helpers";
import { bootstrapMesh, type MeshInstance } from "../../apps/mesh-server/src/index";
import { agentKey, missionKey, threadKey } from "../../packages/core/src/budgets";
import { RECOVERY_ACTOR_ID } from "../../packages/core/src/supervisor";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * A process killed mid-turn leaves the turn's budget holds open forever.
 *
 * A turn reserves against three ledgers (seat, mission, thread) before it calls
 * the model and settles or releases them in the `finally` that ends it. SIGKILL
 * between the two writes `budget.reserved` and nothing after: no consume, no
 * release, no `turn.discarded` (a graceful stop writes all three). The projection
 * replays the hold as live, so after the restart tech-lead's ledger still read
 * `reserved: 17094` -- and so did the thread's and the mission's -- with no turn
 * running (cronlite, 2026-09-30). Every crash leaked one more turn's estimate of
 * headroom until the mission was reset.
 *
 * At boot nothing is running, so a hold still open belongs to a turn the old
 * process never finished. The boot sweep releases it (never consumes it: the dead
 * turn's real spend is unknown), and the abandoned turn gets the discard record a
 * graceful stop would have written.
 */

const AGENTS: AgentSpec[] = [
  { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [], persistent: true },
  { id: "qa", role: "qa", capabilities: ["repository.read"], interests: [], persistent: true },
];
const MAY_CONTACT = { dev: ["qa"], qa: ["dev"] };
const DONE = { text: "back at work", operations: [{ op: "done" } as MeshOp] };
const HELD = 17_094;

type Mesh = MeshInstance;

/** The log a SIGKILL leaves: a turn awakened and thinking, its three holds taken, nothing after. */
async function killedMidTurn(m: TestMesh, id: string, turnId: string): Promise<Array<{ key: string; reservationId: string }>> {
  const goalId = m.kernel.state.activeGoalId!;
  await m.kernel.emit("agent.started", { agentId: id, sessionId: null, runtime: "stub" }, { actorId: id });
  await m.kernel.emit("agent.awakened", { agentId: id, reason: { kind: "message", note: "3 messages waiting" }, turnId }, { actorId: id, correlationId: turnId });
  await m.kernel.emit("agent.state_changed", { agentId: id, to: "OBSERVING", turnId }, { actorId: id, correlationId: turnId });
  await m.kernel.emit("agent.state_changed", { agentId: id, to: "THINKING", turnId }, { actorId: id, correlationId: turnId });
  const holds = [
    { key: agentKey(goalId, id), reservationId: "res-killed-agent" },
    { key: missionKey(goalId), reservationId: "res-killed-mission" },
    { key: threadKey(goalId, "thr-killed"), reservationId: "res-killed-thread" },
  ];
  for (const { key, reservationId } of holds) {
    await m.kernel.emit(
      "budget.reserved",
      { key, limitKind: "tokens", limit: null, amount: HELD, requested: HELD, reservationId },
      { actorId: id, goalId },
    );
  }
  return holds;
}

const boot = (dir: string): Promise<Mesh> => bootstrapMesh({ configPath: path.join(dir, "mesh.yaml"), inMemory: false, useGit: false, mode: "live" });
const eventsOfType = async (m: Mesh, type: string) => (await collectEvents(m)).filter((e) => e.type === type);

test("boot: holds a killed turn left open are released, with the discard record a graceful stop writes", async () => {
  const first = await makeMesh({ agents: AGENTS, startup: [], mayContact: MAY_CONTACT, persist: true });
  try {
    const turnId = "turn-killed-dev";
    const holds = await killedMidTurn(first, "dev", turnId);
    for (const { key } of holds) assert.equal(first.kernel.state.budgets.get(key)?.reserved, HELD, `fixture: ${key} holds the dead turn's reservation`);
    await first.close();

    const second = await boot(first.dir);
    try {
      for (const a of AGENTS) stub(second).setScript(a.id, () => DONE);

      for (const { key } of holds) {
        const ledger = second.kernel.state.budgets.get(key);
        assert.equal(ledger?.reserved, 0, `${key}: nothing is held for a turn that no longer exists`);
        assert.equal(ledger?.reservations.size, 0, `${key}: and no reservation is left to replay as live`);
        assert.equal(ledger?.consumed, 0, `${key}: released, not consumed -- the dead turn's real spend is unknown`);
      }

      const released = await eventsOfType(second, "budget.released");
      assert.deepEqual(
        released.map((e) => (e.payload as { reservationId: string }).reservationId).sort(),
        holds.map((h) => h.reservationId).sort(),
        "one release per hold, recorded in the log so a replay reproduces it",
      );
      for (const e of released) {
        assert.equal(e.actorId, RECOVERY_ACTOR_ID);
        assert.match(String((e.payload as { reason?: string }).reason), /abandoned/);
      }
      assert.equal((await eventsOfType(second, "budget.consumed")).length, 0, "nothing was billed for a turn nothing measured");

      const discards = (await eventsOfType(second, "turn.discarded")).filter((e) => (e.payload as { turnId?: string }).turnId === turnId);
      assert.equal(discards.length, 1, "the abandoned turn is closed in the log the way a stopped one is");
      const d = discards[0]!.payload as { agentId: string; reason: string; detail: string; tokens?: number };
      assert.equal(d.agentId, "dev");
      assert.equal(d.reason, "interrupted");
      assert.match(d.detail, /abandoned by server restart/);
      assert.equal("tokens" in d, false, "unmeasured spend is absent, never a zero");
      assert.equal(second.kernel.state.agents.get("dev")?.state.lifecycle, "IDLE");
    } finally {
      await second.close();
      second.stubRuntimes.get("stub")?.releaseHangs();
    }

    // A third process life finds nothing held and nothing open: the sweep is idempotent.
    const third = await boot(first.dir);
    try {
      assert.equal((await eventsOfType(third, "budget.released")).length, holds.length, "no release is written twice");
      assert.equal((await eventsOfType(third, "turn.discarded")).filter((e) => (e.payload as { turnId?: string }).turnId === turnId).length, 1, "nor the discard");
    } finally {
      await third.close();
      third.stubRuntimes.get("stub")?.releaseHangs();
    }
  } finally {
    fs.rmSync(first.dir, { recursive: true, force: true });
  }
});

test("boot: a mesh that was stopped cleanly has no holds to release and writes none", async () => {
  const first = await makeMesh({ agents: AGENTS, startup: [], mayContact: MAY_CONTACT, persist: true });
  try {
    await first.close();
    const second = await boot(first.dir);
    try {
      assert.equal((await eventsOfType(second, "budget.released")).length, 0);
      assert.equal((await eventsOfType(second, "turn.discarded")).length, 0);
    } finally {
      await second.close();
      second.stubRuntimes.get("stub")?.releaseHangs();
    }
  } finally {
    fs.rmSync(first.dir, { recursive: true, force: true });
  }
});
