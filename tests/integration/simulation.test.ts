import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub } from "../helpers";
import { forEachSeed } from "../support/seed";
import type { MeshOp } from "../../packages/protocol/src/index";

test("simulation: 500 randomized interactions preserve core mesh invariants", { timeout: 240000 }, async () => {
  // The historical seed 42, plus `MESH_SEED` or a fresh one; a failure names
  // its seed. The scripts share one rng across concurrently running turns, so
  // a seed fixes the workload's shape, not its exact interleaving.
  await forEachSeed([42], async (rng) => {
    const m = await makeMesh({
      agents: [
        { id: "a0", role: "worker", capabilities: ["repository.write", "code.review", "task.assign"], authority: ["implementation.approve"], interests: ["message.sent", "artifact.created", "patch.ready"] },
        { id: "a1", role: "worker", capabilities: ["repository.write", "test.execute"], authority: ["quality.block"], interests: ["message.sent", "artifact.created"] },
        { id: "a2", role: "worker", capabilities: ["repository.write"], authority: ["security.block"], interests: ["message.sent"] },
        { id: "a3", role: "worker", capabilities: ["repository.write", "git.merge", "task.assign"], authority: ["architecture.approve"], interests: ["message.sent", "artifact.created"] },
      ],
      mayContact: { a0: ["a1", "a2", "a3"], a1: ["a0", "a2", "a3"], a2: ["a0", "a1", "a3"], a3: ["a0", "a1", "a2"] },
      maxEvents: 4000,
      missionTokens: 50_000_000,
    });
    try {
      const ids = ["a0", "a1", "a2", "a3"];
      const s = stub(m);
      let counter = 0;
      for (const id of ids) {
        s.setScript(id, async () => {
          counter++;
          const pick = rng();
          const ops: MeshOp[] = [];
          const other = ids[Math.floor(rng() * ids.length)];
          const tasks = [...m.kernel.state.tasks.values()];
          if (pick < 0.25) {
            ops.push({ op: "publish_artifact", name: `art-${counter}`, type: "ADR", content: `body-${counter}` });
          } else if (pick < 0.45) {
            ops.push({ op: "send", type: "INFORM", to: [other], payload: { n: counter }, newThread: { subject: `t${counter}` } });
          } else if (pick < 0.55) {
            const arts = [...m.kernel.state.artifacts.values()];
            if (arts.length) ops.push({ op: "acquire_lease", artifactId: arts[Math.floor(rng() * arts.length)].id, files: [] });
          } else if (pick < 0.6) {
            ops.push({ op: "claim_task", taskId: "task-does-not-exist" });
          } else if (pick < 0.65) {
            ops.push({ op: "remember", key: `k${counter}`, value: `v${counter}` });
          } else if (pick < 0.7) {
            ops.push({ op: "approve", subject: "implementation" });
          } else if (pick < 0.78) {
            // Task traffic, so the ownership invariants below have something to
            // hold over: delegate (only a0/a3 may), claim any task, including
            // ones already claimed, and complete one.
            ops.push({ op: "delegate", to: other, title: `task ${counter}`, description: "simulated" });
          } else if (pick < 0.88) {
            if (tasks.length) ops.push({ op: "claim_task", taskId: tasks[Math.floor(rng() * tasks.length)].id });
          } else if (pick < 0.93) {
            if (tasks.length) ops.push({ op: "complete_task", taskId: tasks[Math.floor(rng() * tasks.length)].id, summary: "done" });
          }
          ops.push({ op: "done" });
          return { operations: ops, tokensUsed: { input: 10, output: 10, total: 20 } };
        });
      }
      for (let i = 0; i < 500; i++) {
        const id = ids[Math.floor(rng() * ids.length)];
        await m.supervisor.activateAgent(id, { kind: "manual" });
        if (i % 40 === 0) {
          await new Promise((r) => setTimeout(r, 20));
          const goal = m.kernel.state.goals.get(m.kernel.state.activeGoalId ?? "");
          if (goal && goal.status !== "ACTIVE") break;
        }
      }
      await new Promise((r) => setTimeout(r, 800));

      const st = m.kernel.state;
      for (const [artifactId, leaseId] of st.activeLeaseByArtifact) {
        const active = [...st.leases.values()].filter((l) => l.artifactId === artifactId && !l.releasedAt);
        assert.ok(active.length <= 1, `single-writer violated on ${artifactId}`);
        assert.equal(active[0]?.id, leaseId, `the lease index for ${artifactId} names a lease that is not the live one`);
      }
      for (const [key, b] of st.budgets) {
        assert.ok(b.consumed >= 0 && b.reserved >= 0, `budget ${key} negative (${b.consumed}/${b.reserved})`);
        const held = [...b.reservations.values()].reduce((x, y) => x + y, 0);
        assert.equal(b.reserved, held, `budget ${key}: reserved ${b.reserved} but live reservations hold ${held}`);
      }
      // Task ownership. `claimedBy` is one field, so "one claimer" is only
      // worth checking as agreement: a CLAIMED task has a known claimer, an
      // OPEN one has none, and no two agents hold the same task as active.
      for (const t of st.tasks.values()) {
        if (t.status === "CLAIMED") assert.ok(t.claimedBy && st.agents.has(t.claimedBy), `${t.id} CLAIMED by unknown ${t.claimedBy}`);
        if (t.status === "OPEN") assert.equal(t.claimedBy, undefined, `${t.id} OPEN but claimedBy ${t.claimedBy}`);
      }
      const holders = new Map<string, string>();
      for (const rec of st.agents.values()) {
        const held = rec.state.activeTaskId;
        if (!held) continue;
        assert.equal(holders.get(held), undefined, `${holders.get(held)} and ${rec.state.agentId} both hold ${held}`);
        holders.set(held, rec.state.agentId);
      }
      const events = await m.store.read();
      const seen = new Set<string>();
      for (const e of events) {
        assert.match(e.id, /^evt-/);
        assert.ok(!seen.has(e.id), `event id ${e.id} appears twice in the log`);
        seen.add(e.id);
      }
      assert.equal(st.eventCount, events.length, "the projection applied exactly the events the log holds");
      assert.ok(st.eventCount >= 200, `event log should reflect the workload, got ${st.eventCount}`);
      const types = events.map((e) => e.type);
      assert.ok(types.includes("artifact.created"), "artifacts were produced");
      assert.ok(types.includes("message.sent"), "messages were sent");
      assert.ok(types.includes("task.created"), "tasks were delegated");
    } finally {
      await m.cleanup();
    }
  });
});

test("simulation: duplicate event ids are idempotent (exactly-once projections)", async () => {
  const m = await makeMesh({ agents: [{ id: "a", role: "dev", capabilities: ["repository.write"], interests: [] }], mayContact: { a: [] } });
  const id = "evt-dup";
  const one = await m.kernel.emit("memory.updated", { agentId: "a", note: { agentId: "a", key: "k", value: "v1", updatedAt: "", eventId: id } }, { actorId: "a", id });
  const countBefore = m.kernel.state.eventCount;
  await m.kernel.emit("memory.updated", { agentId: "a", note: { agentId: "a", key: "k", value: "v1", updatedAt: "", eventId: id } }, { actorId: "a", id });
  assert.equal(m.kernel.state.eventCount, countBefore, "same id must not re-apply");
  const fromStore = await m.store.append({ ...one, payload: {} });
  assert.equal(fromStore.id, id, "store dedupes too");
  await m.cleanup();
});
