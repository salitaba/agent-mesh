import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { buildAgentContext, renderContextInstructions } from "../../packages/core/src/context";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * §16 of the 2026-09-25 live run: the plan lived only in prose.
 *
 * `Task` had no dependencies, claims were refused only for a non-OPEN task or a
 * missing capability, and a seat's context showed only its own active task. pm
 * instantiated 7 of architecture v2's 33 tasks while v3 was being written; v3
 * re-split W6-S3 but pm created it for frontend anyway, and frontend claimed and
 * committed it with its dependency W6-S1 never claimed.
 */

const AGENTS = [
  { id: "pm", role: "pm", capabilities: ["repository.read"], authority: ["requirements.approve"], interests: [] },
  { id: "arch", role: "architect", capabilities: ["repository.read", "architecture.write"], authority: ["architecture.approve"], interests: [] },
  { id: "fe", role: "frontend", capabilities: ["repository.read", "repository.write"], interests: [] },
];
const COMM = { pm: ["arch", "fe"], arch: ["pm", "fe"], fe: ["pm", "arch"] };

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

const turnFor = (agentId: string) =>
  ({
    turnId: `t-${agentId}-${Math.random().toString(36).slice(2)}`,
    agentId,
    reason: { kind: "manual" as const },
    sentOps: 0,
    publishedOps: 0,
    waitRequested: false,
    escalated: false,
    results: [],
  }) as never;

const op = (m: Mesh, actor: string, o: Record<string, unknown>) => m.supervisor.executeOp(actor, o as unknown as MeshOp, turnFor(actor));

test("task graph: create_task refuses a dependency the board does not hold", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
  try {
    const res = await op(m, "pm", { op: "create_task", title: "W6-S3 driver UI", description: "d", dependsOn: ["task-nope"] });
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /dependsOn names no task on this goal's board: task-nope/);
    assert.equal(m.kernel.state.tasks.size, 0, "nothing was filed");
  } finally {
    await m.cleanup();
  }
});

test("task graph: a task cannot be claimed while its dependency is not completed — the refusal names the blocker", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
  try {
    const s1 = await op(m, "pm", { op: "create_task", title: "W6-S1 store", description: "the store" });
    const s3 = await op(m, "pm", { op: "create_task", title: "W6-S3 driver UI", description: "the UI", dependsOn: [s1.taskId] });
    assert.equal(s3.ok, true, s3.reason);
    assert.deepEqual(m.kernel.state.tasks.get(s3.taskId!)?.dependsOn, [s1.taskId]);

    const early = await op(m, "fe", { op: "claim_task", taskId: s3.taskId });
    assert.equal(early.ok, false, "before this, frontend claimed W6-S3 with W6-S1 never claimed");
    assert.match(early.reason ?? "", new RegExp(`${s1.taskId} "W6-S1 store" \\(OPEN, unclaimed\\)`));
    assert.equal(m.kernel.state.tasks.get(s3.taskId!)?.status, "OPEN");

    // The log refuses it too: a raw claim is not a way around the screen.
    await assert.rejects(
      () => m.kernel.emit("task.claimed", { taskId: s3.taskId, agentId: "fe" }, { actorId: "fe" }),
      /depends on .* not yet completed/,
    );

    assert.equal((await op(m, "fe", { op: "claim_task", taskId: s1.taskId })).ok, true);
    assert.equal((await op(m, "fe", { op: "complete_task", taskId: s1.taskId, summary: "store done" })).ok, true);
    const now = await op(m, "fe", { op: "claim_task", taskId: s3.taskId });
    assert.equal(now.ok, true, now.reason);
  } finally {
    await m.cleanup();
  }
});

test("task graph: a task is pinned to the artifact version it cites, and its claimant is told when that moves on", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
  try {
    const arch = turnFor("arch");
    const v1 = await m.supervisor.executeOp("arch", { op: "publish_artifact", name: "architecture", type: "ArchitectureDocument", content: "# v2 plan: 33 tasks" } as MeshOp, arch);
    const task = await op(m, "pm", { op: "create_task", title: "W6-S3", description: "from the plan", artifactRefs: [{ uri: v1.artifactUri }] });
    assert.equal(task.ok, true, task.reason);
    assert.equal(m.kernel.state.tasks.get(task.taskId!)?.artifactRefs[0]?.version, 1, "pinned to v1");

    await m.supervisor.executeOp("arch", { op: "publish_artifact", name: "architecture", type: "ArchitectureDocument", content: "# v3 plan: W6-S3 re-split", asVersionOf: v1.artifactId } as MeshOp, turnFor("arch"));
    const claim = await op(m, "fe", { op: "claim_task", taskId: task.taskId });
    assert.equal(claim.ok, true, "a stale pin does not refuse the claim");
    assert.match(claim.reason ?? "", /cut from ArchitectureDocument\/architecture v1 → v2/, "but the claimant is told");

    const wakes: Array<{ agentId: string; note?: string }> = [];
    const sup = m.supervisor as unknown as { activateAgent: (id: string, r: { kind: string; note?: string }, o?: unknown) => Promise<unknown> };
    const orig = sup.activateAgent.bind(m.supervisor);
    sup.activateAgent = async (id, r, o) => {
      wakes.push({ agentId: id, note: r.note });
      return orig(id, r, o);
    };
    await m.supervisor.executeOp("arch", { op: "publish_artifact", name: "architecture", type: "ArchitectureDocument", content: "# v4", asVersionOf: v1.artifactId } as MeshOp, turnFor("arch"));
    const told = wakes.filter((w) => w.agentId === "fe" && /your task .* was cut from ArchitectureDocument "architecture" v1; it is now v3/.test(w.note ?? ""));
    assert.equal(told.length, 1, "the seat holding the pinned task is told once");

    const ctx = buildAgentContext({ config: m.config, kernel: m.kernel }, "fe");
    assert.ok(ctx.currentTaskCaveats?.some((c) => /cut from ArchitectureDocument\/architecture v1; it is now v3/.test(c)), "and the context keeps saying so");
  } finally {
    await m.cleanup();
  }
});

test("task graph: the context shows the open board — who holds what, what waits on what, and what this seat can claim", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
  try {
    const s1 = await op(m, "pm", { op: "create_task", title: "W6-S1 store", description: "the store" });
    const s3 = await op(m, "pm", { op: "create_task", title: "W6-S3 driver UI", description: "the UI", dependsOn: [s1.taskId] });
    const arch = await op(m, "pm", { op: "create_task", title: "ADR for storage", description: "decide", requiredCapabilities: ["architecture.write"] });
    assert.equal((await op(m, "arch", { op: "claim_task", taskId: arch.taskId })).ok, true);

    const ctx = buildAgentContext({ config: m.config, kernel: m.kernel }, "fe");
    const byId = new Map((ctx.openBacklog ?? []).map((e) => [e.id, e]));
    assert.equal(byId.get(s1.taskId!)?.claimable, true);
    assert.equal(byId.get(s3.taskId!)?.claimable, false);
    assert.deepEqual(byId.get(s3.taskId!)?.blockedBy, [s1.taskId]);
    assert.equal(byId.get(arch.taskId!)?.owner, "arch");
    assert.equal(ctx.openBacklog?.[0]?.id, s1.taskId, "what this seat can pick up comes first");

    const text = renderContextInstructions(ctx);
    assert.match(text, /## Task board/);
    assert.match(text, new RegExp(`\\[${s3.taskId}\\] W6-S3 driver UI \\(OPEN\\) — waits on ${s1.taskId}`));
    assert.match(text, new RegExp(`\\[${s1.taskId}\\] W6-S1 store \\(OPEN\\) — you can claim it`));
    assert.match(text, new RegExp(`\\[${arch.taskId}\\] ADR for storage \\(CLAIMED, arch\\)`));
  } finally {
    await m.cleanup();
  }
});
