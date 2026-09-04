import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, goalOf } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

test("recovery: a crashed agent process is marked FAILED and restarts with its identity", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", interests: ["message.sent"], capabilities: ["repository.write"], persistent: true }],
    mayContact: { dev: [] },
  });
  const s = stub(m);
  let first = true;
  s.setScript("dev", async () => {
    if (first) {
      first = false;
      return { crash: true, operations: [] };
    }
    return { operations: [{ op: "remember", key: "state", value: "restored and continuing" } as MeshOp, { op: "done" } as MeshOp] };
  });
  await m.supervisor.humanSend(["dev"], "INFORM", { go: true });
  const types = async () => (await m.store.read()).map((e) => e.type);
  await waitFor("failed then restarted then idle", async () => {
    const t = await types();
    return t.includes("agent.failed") && t.includes("agent.restarted") && m.kernel.state.agents.get("dev")?.state.lifecycle === "IDLE";
  }, 8000);
  const beforeCrash = m.kernel.state.agents.get("dev")!.definition.id;
  assert.equal(beforeCrash, "dev", "agent identity survives the process crash");
  await m.cleanup();
});

test("recovery: after max restart attempts the mesh escalates a runtime_failure", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", interests: [], capabilities: [], persistent: true }],
    mayContact: { dev: [] },
    criteria: [{ id: "x", description: "x", mandatory: true }],
  });
  const s = stub(m);
  s.setScript("dev", async () => ({ crash: true, operations: [] }));
  await m.supervisor.activateAgent("dev", { kind: "manual" });
  await waitFor("runtime failure escalation", () => {
    return [...m.kernel.state.escalations.values()].some((e) => e.reason === "runtime_failure" && (e.detail as { attempts?: number }).attempts !== undefined);
  }, 15000);
  await m.cleanup();
});

test("delegation: agent-to-agent delegate creates a task and a DELEGATE message (v1 depth 0)", async () => {
  const m = await makeMesh({
    agents: [
      { id: "lead", role: "tech-lead", capabilities: ["task.assign"], interests: [] },
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
    ],
    mayContact: { lead: ["dev"], dev: [] },
  });
  const s = stub(m);
  s.setScript("lead", async () => ({
    operations: [
      { op: "delegate", to: "dev", title: "build the thing", description: "per architecture", requiredCapabilities: ["repository.write"] } as MeshOp,
      { op: "done" } as MeshOp,
    ],
  }));
  s.setScript("dev", async (input) => {
    const task = input.context.unreadMail.find((x) => x.type === "DELEGATE");
    const taskId = (task?.payload as { taskId?: string })?.taskId ?? "";
    return { operations: [{ op: "claim_task", taskId } as MeshOp, { op: "done" } as MeshOp] };
  });
  await m.supervisor.activateAgent("lead", { kind: "manual" });
  await waitFor("dev claimed the delegated task", () => m.kernel.state.tasks.size === 1 && ["CLAIMED", "COMPLETED"].includes([...m.kernel.state.tasks.values()][0].status), 6000);
  await m.cleanup();
});

test("fractal: depth-1 worker returns only the structured result contract, not its transcript", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [], delegation: { allow: true, max_depth: 1, max_workers: 1, worker_budget_tokens: 5000 } },
    ],
    mayContact: { dev: [] },
  });
  const s = stub(m);
  s.setScript("dev", async (_i, turn) => {
    if (turn === 0) {
      return { operations: [{ op: "spawn_worker", title: "sub task", taskSpec: "do a sub piece", budgetTokens: 5000 } as MeshOp, { op: "wait" } as MeshOp] };
    }
    const handoff = _i.context.unreadMail.find((x) => x.type === "HANDOFF");
    if (!handoff) return { operations: [{ op: "wait" } as MeshOp] };
    const result = handoff.payload as { summary?: string } | undefined;
    return { operations: [{ op: "remember", key: "worker", value: String(result?.summary) } as MeshOp, { op: "done" } as MeshOp] };
  });
  s.setScript("dev#worker-1", async (input) => {
    const task = input.context.unreadMail[0];
    const taskId = (task?.payload as { taskId?: string })?.taskId ?? "";
    return {
      operations: [
        { op: "claim_task", taskId } as MeshOp,
        {
          op: "submit_result",
          taskId,
          result: { status: "COMPLETED", summary: "implemented idempotency repository", artifacts: [], findings: ["transaction model works"], risks: ["needs migration"], recommendation: "proceed" },
        } as MeshOp,
      ],
    };
  });
  await m.supervisor.activateAgent("dev", { kind: "manual" });
  await waitFor("parent received worker result", () => m.kernel.state.memory.get("dev")?.has("worker") === true, 8000);
  const note = m.kernel.state.memory.get("dev")!.get("worker");
  assert.equal(note?.value, "implemented idempotency repository");
  assert.ok(![...m.kernel.state.messages.values()].some((mm) => mm.from === "dev#worker-1" && mm.type === "INFORM"), "worker transcript is not injected to parent");
  assert.ok(["COMPLETED", "IDLE"].includes(m.kernel.state.agents.get("dev#worker-1")?.state.lifecycle ?? ""), "worker finished and torn down");
  await m.cleanup();
});

test("single-writer invariant: a second writer cannot acquire an artifact lease", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev1", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "dev2", role: "developer", capabilities: ["repository.write"], interests: [] },
    ],
    mayContact: { dev1: ["dev2"], dev2: ["dev1"] },
  });
  const created = await m.supervisor.createArtifact({ actorId: "dev1", name: "shared-patch", type: "CodePatch", content: "diff" });
  if (!("artifact" in created)) throw new Error("artifact failed");
  const id = created.artifact.id;
  const turn = { turnId: "t", agentId: "dev1", reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] };
  const a = await m.supervisor.executeOp("dev1", { op: "acquire_lease", artifactId: id, files: [] }, turn as never);
  assert.equal(a.ok, true, a.reason);
  const b = await m.supervisor.executeOp("dev2", { op: "acquire_lease", artifactId: id, files: [] }, turn as never);
  assert.equal(b.ok, false, "second writer must be refused (single writer)");
  assert.match(b.reason ?? "", /leased to dev1|only the artifact owner/);
  const release = await m.supervisor.executeOp("dev1", { op: "release_lease", artifactId: id }, turn as never);
  assert.equal(release.ok, true);
  const reacquire = await m.supervisor.executeOp("dev2", { op: "acquire_lease", artifactId: id, files: [] }, turn as never);
  assert.equal(reacquire.ok, false, "dev2 is still not the owner: artifact ownership is immutable");
  await m.cleanup();
});
