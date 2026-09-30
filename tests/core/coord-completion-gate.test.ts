import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import { makeMesh } from "../helpers";
import { buildAgentContext, renderContextInstructions } from "../../packages/core/src/context";
import { IMPLEMENTATION_GATE_MARKER, type MeshOp } from "../../packages/protocol/src/index";

/**
 * §7 (second half) of the 2026-09-25 live run: the configured completion gate
 * bound nothing. `implementation.completed: requires tech-lead.approve` applies
 * at task completion only to tasks listing `implementation.gate`, none of the
 * 10 live tasks did, and every seat's prompt stated the gate as if it bound
 * them all.
 *
 * The fix is to SAY so — to the operator the first time the rule lets a task
 * through, and to the seats in the policy line — rather than to widen the gate:
 * it is mission-scoped (any approval anywhere satisfies it), and meshes that
 * configure it with `qa.pass` would deadlock if every task waited on QA.
 *
 * And one prompt line from §4: seats followed `mesh_approve` with an APPROVE
 * reply "to close the ask", and every such reply was refused.
 */

const AGENTS = [
  { id: "lead", role: "tech-lead", capabilities: ["repository.read", "code.review"], authority: ["implementation.approve", "quality.approve"], interests: [] },
  { id: "fe", role: "frontend", capabilities: ["repository.read", "repository.write"], interests: [] },
];
const COMM = { lead: ["fe"], fe: ["lead"] };

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

test("completion gate: a task the configured gate does not bind completes as before, and the operator is told once", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", persist: true, transitions: { "implementation.completed": ["lead.approve"] } });
  try {
    const auditFile = (m.supervisor as unknown as { deps: { auditFile?: string } }).deps.auditFile!;
    const warnings = () => (fs.existsSync(auditFile) ? fs.readFileSync(auditFile, "utf8") : "").split("\n").filter((l) => l.includes("did not bind task"));
    for (const title of ["T1 driver UI", "T2 driver API"]) {
      const t = await m.supervisor.executeOp("lead", { op: "create_task", title, description: "work" } as MeshOp, turnFor("lead"));
      assert.equal((await m.supervisor.executeOp("fe", { op: "claim_task", taskId: t.taskId } as MeshOp, turnFor("fe"))).ok, true);
      const done = await m.supervisor.executeOp("fe", { op: "complete_task", taskId: t.taskId, summary: "done" } as MeshOp, turnFor("fe"));
      assert.equal(done.ok, true, "the completion itself is unchanged — gating every task would be a new rule, not a fix");
    }
    const w = warnings();
    assert.equal(w.length, 1, "said once, the first time it lets a task through");
    assert.match(w[0]!, /'implementation\.completed' \(requires lead\.approve\) did not bind task .*"implementation\.gate".*0 of 1 task/);
  } finally {
    await m.cleanup();
  }
});

test("completion gate: the seats' policy line says what the gate binds at task completion", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", transitions: { "implementation.completed": ["lead.approve"], "patch.merge": ["lead.approve"] } });
  try {
    const text = renderContextInstructions(buildAgentContext({ config: m.config, kernel: m.kernel }, "fe"));
    assert.match(text, /Transition gate 'implementation\.completed' requires: lead\.approve \(at task completion this binds only tasks whose requiredCapabilities include "implementation\.gate"\)/);
    assert.match(text, /Transition gate 'patch\.merge' requires: lead\.approve\n/, "other gates read as they did");
  } finally {
    await m.cleanup();
  }
});

test("prompt: the verdict guidance says the verdict op itself answers the review ask", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked" });
  try {
    const text = renderContextInstructions(buildAgentContext({ config: m.config, kernel: m.kernel }, "lead"));
    assert.match(text, /Approve or reject a reviewed artifact with/);
    assert.match(text, /The verdict op itself answers the review request you were sent for that artifact — do NOT follow it with an APPROVE\/REJECT message or a `mesh_respond`/);
    assert.match(text, /mesh_respond \(messageId\/type\/payload\) — answer one specific request\. Not a review you settled with mesh_approve\/mesh_reject/);
  } finally {
    await m.cleanup();
  }
});

/**
 * The marker is advertised to every seat whenever the gate is configured, and
 * the seats' own context said "you can claim it" about a task carrying it — but
 * `claimTask` checked the marker against the seat's capabilities like any other
 * requirement, and no seat can hold it (it is not a capability). Every marked
 * task was therefore unclaimable, which also meant the gate it marks was never
 * reachable: a live run finished with its implementation task "never picked up"
 * and the `implementation.completed` gate never consulted.
 */
test("completion gate: a task carrying the implementation.gate marker can be claimed by a seat with its real capabilities", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", transitions: { "implementation.completed": ["lead.approve"] } });
  try {
    const t = await m.supervisor.executeOp(
      "lead",
      { op: "create_task", title: "gated work", description: "work", requiredCapabilities: ["repository.write", IMPLEMENTATION_GATE_MARKER] } as MeshOp,
      turnFor("lead"),
    );
    assert.equal(t.ok, true, t.reason);

    // What the seat is told...
    const text = renderContextInstructions(buildAgentContext({ config: m.config, kernel: m.kernel }, "fe"));
    assert.match(text, new RegExp(`\\[${t.taskId}\\][^\\n]*you can claim it`), "the context offers the marked task to a seat that holds its real capabilities");

    // ...must be true.
    const claim = await m.supervisor.executeOp("fe", { op: "claim_task", taskId: t.taskId } as MeshOp, turnFor("fe"));
    assert.equal(claim.ok, true, `the claim it was offered must succeed: ${claim.reason ?? ""}`);
    assert.equal(m.kernel.state.tasks.get(t.taskId!)?.claimedBy, "fe");
  } finally {
    await m.cleanup();
  }
});

test("completion gate: skipping the marker does not weaken the task's real capability requirements", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", transitions: { "implementation.completed": ["lead.approve"] } });
  try {
    const t = await m.supervisor.executeOp(
      "lead",
      { op: "create_task", title: "gated work", description: "work", requiredCapabilities: ["repository.write", IMPLEMENTATION_GATE_MARKER] } as MeshOp,
      turnFor("lead"),
    );
    // `lead` holds review capabilities but not repository.write.
    const refused = await m.supervisor.claimTask("lead", t.taskId!);
    assert.equal(refused.ok, false);
    assert.match(refused.reason ?? "", /missing capability repository\.write/, "the refusal names the capability that is genuinely missing, not the marker");
    assert.equal(m.kernel.state.tasks.get(t.taskId!)?.status, "OPEN", "a refused claim leaves the task open");
  } finally {
    await m.cleanup();
  }
});

test("completion gate: a claimed marked task is bound by the configured gate at completion", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", persist: true, transitions: { "implementation.completed": ["lead.approve"] } });
  try {
    const t = await m.supervisor.executeOp(
      "lead",
      { op: "create_task", title: "gated work", description: "work", requiredCapabilities: ["repository.write", IMPLEMENTATION_GATE_MARKER] } as MeshOp,
      turnFor("lead"),
    );
    assert.equal((await m.supervisor.executeOp("fe", { op: "claim_task", taskId: t.taskId } as MeshOp, turnFor("fe"))).ok, true);

    const early = await m.supervisor.executeOp("fe", { op: "complete_task", taskId: t.taskId, summary: "done" } as MeshOp, turnFor("fe"));
    assert.equal(early.ok, false, "the gate binds a marked task: no verdict yet, no completion");
    assert.match(early.reason ?? "", /implementation gate unsatisfied, missing: lead\.approve/);

    const created = await m.supervisor.createArtifact({ actorId: "fe", name: "patch", type: "CodePatch", content: "a patch, described at length" });
    if (!("artifact" in created)) throw new Error(`create failed: ${created.error}`);
    await m.supervisor.transitionArtifact("fe", created.artifact.id, { to: "READY_FOR_REVIEW" });
    const verdict = await m.supervisor.executeOp("lead", { op: "approve", subject: "implementation", artifactId: created.artifact.id } as MeshOp, turnFor("lead"));
    assert.equal(verdict.ok, true, verdict.reason);

    const done = await m.supervisor.executeOp("fe", { op: "complete_task", taskId: t.taskId, summary: "done" } as MeshOp, turnFor("fe"));
    assert.equal(done.ok, true, `with the verdict recorded the same completion goes through: ${done.reason ?? ""}`);
    assert.equal(m.kernel.state.tasks.get(t.taskId!)?.status, "COMPLETED");
  } finally {
    await m.cleanup();
  }
});
