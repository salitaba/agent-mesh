import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub } from "../helpers";
import { mulberry32 } from "../policy/_rng";
import type { MeshOp } from "../../packages/protocol/src/index";

test("simulation: 500 randomized interactions preserve core mesh invariants", { timeout: 120000 }, async () => {
  const m = await makeMesh({
    agents: [
      { id: "a0", role: "worker", capabilities: ["repository.write", "code.review"], authority: ["implementation.approve"], interests: ["message.sent", "artifact.created", "patch.ready"] },
      { id: "a1", role: "worker", capabilities: ["repository.write", "test.execute"], authority: ["quality.block"], interests: ["message.sent", "artifact.created"] },
      { id: "a2", role: "worker", capabilities: ["repository.write"], authority: ["security.block"], interests: ["message.sent"] },
      { id: "a3", role: "worker", capabilities: ["repository.write", "git.merge"], authority: ["architecture.approve"], interests: ["message.sent", "artifact.created"] },
    ],
    mayContact: { a0: ["a1", "a2", "a3"], a1: ["a0", "a2", "a3"], a2: ["a0", "a1", "a3"], a3: ["a0", "a1", "a2"] },
    maxEvents: 4000,
    missionTokens: 50_000_000,
  });
  const rng = mulberry32(42);
  const ids = ["a0", "a1", "a2", "a3"];
  const s = stub(m);
  let counter = 0;
  for (const id of ids) {
    s.setScript(id, async () => {
      counter++;
      const pick = rng();
      const ops: MeshOp[] = [];
      const other = ids[Math.floor(rng() * ids.length)];
      if (pick < 0.25) {
        ops.push({ op: "publish_artifact", name: `art-${counter}`, type: "ADR", content: `body-${counter}` });
      } else if (pick < 0.5) {
        ops.push({ op: "send", type: "INFORM", to: [other], payload: { n: counter }, newThread: { subject: `t${counter}` } });
      } else if (pick < 0.6) {
        const arts = [...m.kernel.state.artifacts.values()];
        if (arts.length) ops.push({ op: "acquire_lease", artifactId: arts[Math.floor(rng() * arts.length)].id, files: [] });
      } else if (pick < 0.68) {
        ops.push({ op: "claim_task", taskId: "task-does-not-exist" });
      } else if (pick < 0.75) {
        ops.push({ op: "remember", key: `k${counter}`, value: `v${counter}` });
      } else if (pick < 0.8) {
        ops.push({ op: "approve", subject: "implementation" });
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
  for (const [artifactId] of st.activeLeaseByArtifact) {
    const active = [...st.leases.values()].filter((l) => l.artifactId === artifactId && !l.releasedAt);
    assert.ok(active.length <= 1, `single-writer violated on ${artifactId}`);
  }
  for (const b of st.budgets.values()) {
    assert.ok(b.consumed >= 0 && b.reserved >= 0, "budget negative");
  }
  for (const e of await m.store.read()) {
    assert.match(e.id, /^evt-/);
  }
  assert.ok(st.eventCount >= 200, `event log should reflect the workload, got ${st.eventCount}`);
  const types = (await m.store.read()).map((e) => e.type);
  assert.ok(types.includes("artifact.created"), "artifacts were produced");
  assert.ok(types.includes("message.sent"), "messages were sent");
  await m.cleanup();
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
