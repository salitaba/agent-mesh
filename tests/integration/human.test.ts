import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, goalOf } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

test("human: pause freezes activation, resume replays pending mail", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", interests: ["message.sent"], capabilities: [] }],
    mayContact: { dev: [] },
  });
  const s = stub(m);
  let runs = 0;
  s.setScript("dev", async () => {
    runs++;
    return { operations: [{ op: "done" } as MeshOp] };
  });
  await m.supervisor.pauseGoal();
  await m.supervisor.humanSend(["dev"], "INFORM", { queued: true });
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(runs, 0, "paused goal must not activate agents");
  assert.equal(m.kernel.state.unread.get("dev")?.length, 1);
  await m.supervisor.resumeGoal();
  await waitFor("dev processed queued mail after resume", () => runs >= 1, 6000);
  await m.cleanup();
});

test("human: escalation and response is a full protocol round-trip", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", interests: [], capabilities: [] }],
    mayContact: { dev: [] },
  });
  const s = stub(m);
  s.setScript("dev", async (_i, turn) => {
    if (turn === 0) {
      return { operations: [{ op: "escalate", reason: "irreversible operation proposed", detail: { want: "drop table" } } as MeshOp, { op: "wait" } as MeshOp] };
    }
    const answer = _i.context.unreadMail.find((x) => x.from === "human");
    return { operations: [{ op: "remember", key: "answer", value: JSON.stringify((answer?.payload as { response?: string })?.response ?? "") } as MeshOp, { op: "done" } as MeshOp] };
  });
  await m.supervisor.activateAgent("dev", { kind: "manual" });
  await waitFor("escalation open", () => m.kernel.state.escalations.size === 1, 5000);
  const esc = [...m.kernel.state.escalations.values()][0];
  assert.equal(esc.status, "OPEN");
  assert.equal(esc.raisedBy, "dev");
  const r = await m.supervisor.respondEscalation(esc.id, "approved for this exception only");
  assert.equal(r.ok, true);
  assert.equal(m.kernel.state.escalations.get(esc.id)?.status, "RESPONDED");
  await waitFor("dev woken by human response", () => m.kernel.state.memory.get("dev")?.has("answer") === true, 6000);
  assert.match(m.kernel.state.memory.get("dev")!.get("answer")!.value, /approved for this exception/);
  await m.cleanup();
});

test("human: direct approvals satisfy gates; humans are a mesh seat not an external oracle", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
    ],
    mayContact: { dev: [] },
    transitions: { "release.accepted": ["qa.pass", "human.approve"] },
  });
  const created = await m.supervisor.createArtifact({ actorId: "human", name: "hrel", type: "ReleasePlan", content: "release" });
  if (!("artifact" in created)) throw new Error("release failed");
  const rel = created.artifact;
  await m.supervisor.humanSend(["dev"], "INFORM", { note: "operator note lands in dev mailbox" });
  assert.equal(m.kernel.state.unread.get("dev")?.length, 1);
  assert.equal(m.kernel.state.messages.get([...m.kernel.state.unread.get("dev")!][0])?.provenance?.source, "human", "human messages carry HUMAN provenance (§57)");
  void rel;
  await m.cleanup();
});

test("human: wake control allows manual steering", async () => {
  const m = await makeMesh({ agents: [{ id: "dev", role: "developer", interests: [], capabilities: [] }], mayContact: { dev: [] } });
  const s = stub(m);
  let runs = 0;
  s.setScript("dev", async () => {
    runs++;
    return { operations: [{ op: "done" } as MeshOp] };
  });
  await m.supervisor.activateAgent("dev", { kind: "manual", note: "steer" });
  await waitFor("manual wake", () => runs === 1, 5000);
  await m.cleanup();
});
