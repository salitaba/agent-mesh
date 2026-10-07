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

// A pause defers; it does not decide. A seat whose only reason to run is an event holds no mail and no task, so resume did not know it
// was owed a turn, and in a scripted team (whose manager only says "turn done") nothing else ever woke it: the demo stopped at
// 2 of 7 checks after Pause then Resume, one run in five on a loaded machine, every time with four walks at once.
test("human: resume wakes a seat whose only reason to run came while the mission was paused", async () => {
  const m = await makeMesh({
    agents: [
      { id: "qa", role: "qa", interests: ["dependency.changed"] },
      // Interested in what it raises itself, as a seat can be: it is never woken by its own event, paused or not.
      { id: "trigger", role: "developer", interests: ["dependency.changed"] },
    ],
    mayContact: { qa: [], trigger: [] },
  });
  const s = stub(m);
  let runs = 0;
  let triggerRuns = 0;
  let note: string | undefined;
  s.setScript("qa", async (i) => {
    runs++;
    note = i.activation.note;
    return { operations: [{ op: "done" } as MeshOp] };
  });
  s.setScript("trigger", async () => {
    triggerRuns++;
    return { operations: [{ op: "done" } as MeshOp] };
  });
  await m.supervisor.pauseGoal();
  await m.kernel.emit("dependency.changed", { files: ["pom.xml"], summary: "spring boot upgrade" }, { actorId: "trigger" });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(runs, 0, "a paused mission wakes nobody");
  await m.supervisor.resumeGoal();
  await waitFor("qa woke for the change that came while the mission was paused", () => runs >= 1, 6000);
  await waitFor("the mesh drained", () => m.supervisor.isIdle());
  assert.equal(runs, 1, "one turn for it, not one for each way of finding it");
  assert.equal(triggerRuns, 0, "the seat that raised the event is not woken by it");
  assert.match(note ?? "", /dependency\.changed/, "the seat is told what it missed, not only that the mission resumed");
  assert.match(note ?? "", /paused/);
  await m.cleanup();
});

test("human: resume wakes a seat whose wake the pause turned away at the door", async () => {
  const m = await makeMesh({
    agents: [{ id: "qa", role: "qa", interests: ["dependency.changed"] }],
    mayContact: { qa: [] },
  });
  const s = stub(m);
  let runs = 0;
  s.setScript("qa", async () => {
    runs++;
    return { operations: [{ op: "done" } as MeshOp] };
  });
  await m.supervisor.pauseGoal();
  // The wake the scheduler had already raised when the pause landed: refused by the policy, as the console's walk saw it.
  const req = { agentId: "qa", reason: { kind: "interest_event", eventId: "evt-held", eventType: "dependency.changed" }, priority: 5 } as never;
  assert.equal(await m.scheduler.requestActivation(req), false, "the pause refuses it");
  await m.supervisor.resumeGoal();
  await waitFor("qa woke for the wake the pause refused", () => runs >= 1, 6000);
  await m.cleanup();
});

test("human: a seat that holds mail and also missed an event is woken once on resume", async () => {
  const m = await makeMesh({
    agents: [
      { id: "qa", role: "qa", interests: ["dependency.changed", "message.sent"] },
      { id: "trigger", role: "developer", interests: [] },
    ],
    mayContact: { qa: [], trigger: [] },
  });
  const s = stub(m);
  let runs = 0;
  s.setScript("qa", async () => {
    runs++;
    return { operations: [{ op: "done" } as MeshOp] };
  });
  await m.supervisor.pauseGoal();
  await m.supervisor.humanSend(["qa"], "INFORM", { queued: true });
  await m.kernel.emit("dependency.changed", { files: ["pom.xml"], summary: "spring boot upgrade" }, { actorId: "trigger" });
  await new Promise((r) => setTimeout(r, 300));
  await m.supervisor.resumeGoal();
  await waitFor("qa woke", () => runs >= 1, 6000);
  await waitFor("the mesh drained", () => m.supervisor.isIdle());
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(runs, 1, "the mail wake already covers the missed event: a second turn would read the same context");
  await m.cleanup();
});

test("human: a progress tick that came during a pause is not a reason to run once it ends, and what was held is replayed once", async () => {
  const m = await makeMesh({
    agents: [
      { id: "qa", role: "qa", interests: ["goal.progress", "dependency.changed"] },
      { id: "trigger", role: "developer", interests: [] },
    ],
    mayContact: { qa: [], trigger: [] },
  });
  const s = stub(m);
  let runs = 0;
  s.setScript("qa", async () => {
    runs++;
    return { operations: [{ op: "done" } as MeshOp] };
  });
  const gid = m.kernel.state.activeGoalId ?? "";
  await m.supervisor.pauseGoal();
  await m.kernel.emit("goal.progress", { goalId: gid, satisfied: 1, total: 7 }, { actorId: "trigger" });
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(m.scheduler.takeHeldWakes?.(), [], "an observation that costs a turn and teaches nothing is not held");
  await m.kernel.emit("dependency.changed", { files: ["pom.xml"], summary: "spring boot upgrade" }, { actorId: "trigger" });
  await new Promise((r) => setTimeout(r, 300));
  await m.supervisor.resumeGoal();
  await waitFor("qa woke", () => runs >= 1, 6000);
  await waitFor("the mesh drained", () => m.supervisor.isIdle());
  // A second pause and resume replays nothing: what was held was handed over.
  await m.supervisor.pauseGoal();
  await m.supervisor.resumeGoal();
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(runs, 1);
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
  const reasons: Array<{ kind: string; note?: string }> = [];
  s.setScript("dev", async (input) => {
    reasons.push({ kind: input.activation.kind, note: input.activation.note });
    return { operations: [{ op: "done" } as MeshOp] };
  });
  await m.supervisor.activateAgent("dev", { kind: "manual", note: "steer" });
  await waitFor("manual wake", () => reasons.length >= 1, 5000);
  // The steering is the operator's reason reaching the seat, not merely a
  // turn happening: the turn must be told it was a manual wake, and why.
  assert.deepEqual(reasons[0], { kind: "manual", note: "steer" }, "the turn carries the operator's wake reason");
  const woke = (await m.store.read()).filter((e) => e.type === "agent.awakened" && (e.payload as { agentId?: string }).agentId === "dev");
  assert.equal(woke.length, 1, "exactly one wake was recorded");
  assert.equal((woke[0]!.payload as { reason?: { kind?: string } }).reason?.kind, "manual", "and the log records it as manual");
  await m.cleanup();
});
