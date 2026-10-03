import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh } from "../helpers";
import { droppedVerdictsNotice, gateRoute } from "../../packages/core/src/gate-route";
import type { ApprovalRecord, MeshOp } from "../../packages/protocol/src/index";

/**
 * A gate that refuses a completion names who can lift it, and a seat that publishes a new version is told which verdicts that dropped.
 *
 * The sixteenth cronlite run evidenced all six criteria at 09:04:22 and the goal completed at 09:18:06, because the developer's task
 * carried the implementation gate (`implementation.completed` requires `tech-lead.approve` and `qa.pass`) and QA's pass was gone: QA
 * had given it at 08:54:51, published a new version of its own report at 08:57:20 (a new version drops every verdict recorded on the
 * old one), and did not record the pass again. Nothing told QA. The developer's `mesh_task_complete` was refused with "missing:
 * qa.pass", which names a token and not who can give it or how; the developer was refused in three turns and nudged five times,
 * asked QA once ("Please record qa.pass verdict"), QA answered "qa.pass verdict recorded" and recorded nothing, and the developer
 * raised an escalation that read "Appears to be system state synchronization issue". The operator's one message to QA with the
 * exact call settled it in seven seconds.
 */

const AGENTS = [
  { id: "pm", role: "product-manager", capabilities: ["repository.read", "task.assign"], interests: [] },
  { id: "dev", role: "developer", capabilities: ["repository.read", "repository.write", "git.commit"], interests: [] },
  // The seat's id is not its role: a gate names `qa`, the role, and the route has to find the seat by it.
  { id: "verifier", role: "qa", authority: ["quality.pass"], capabilities: ["repository.read", "test.execute", "test.write"], interests: [] },
];
const COMM = { pm: ["dev", "verifier"], dev: ["pm", "verifier"], verifier: ["pm", "dev"] };

const record = (actorId: string, kind: string): ApprovalRecord =>
  ({ id: `a-${actorId}-${kind}`, goalId: "g", kind, subject: "artifact:x", artifactId: "art-1", actorId, actorRole: actorId, evidenceEventId: "e", recordedAt: "2026-10-03T08:54:51.000Z" }) as ApprovalRecord;

const turnFor = (agentId: string) =>
  ({ turnId: `t-${agentId}-${Math.random().toString(36).slice(2, 8)}`, agentId, reason: { kind: "manual" as const }, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] }) as never;

test("a missing qa.pass is named with the seat that can give it and the call that does", () => {
  const route = gateRoute(["qa.pass"], [{ id: "qa", role: "qa" }, { id: "dev", role: "developer" }, { id: "human", role: "human" }]);
  assert.match(route, /^ — qa\.pass is qa's to give, with mesh_approve \{ kind: "pass" \}\./);
  assert.match(route, /You cannot give it for them: ask them, naming that call\./);
  assert.match(route, /A verdict given on an earlier version of an artifact does not stand once it has a newer one, so a seat that gave it may have to give it again\./);
});

test("a gate names an actor by id or by role, and every seat that matches is named", () => {
  const seats = [{ id: "reviewer-1", role: "tech-lead" }, { id: "reviewer-2", role: "tech-lead" }, { id: "qa", role: "qa" }];
  assert.match(gateRoute(["tech-lead.approve"], seats), /tech-lead\.approve is reviewer-1 or reviewer-2's to give, with mesh_approve \{ kind: "approve" \}/);
  assert.match(gateRoute(["qa.pass"], seats), /qa\.pass is qa's to give/);
  // A seat whose id is what the gate names but whose role is something else is found by its id.
  assert.match(gateRoute(["qa.pass"], [{ id: "qa", role: "tester" }, { id: "dev", role: "developer" }]), /qa\.pass is qa's to give/);
});

test("alternatives are all named, a requirement nobody holds says so, and several requirements are separated", () => {
  const seats = [{ id: "qa", role: "qa" }];
  const route = gateRoute(["qa.pass|architect.approve", "security.approve"], seats);
  assert.match(route, /qa\.pass is qa's to give, with mesh_approve \{ kind: "pass" \}, or architect\.approve: no seat holds it, so nothing in this mesh can give it; security\.approve: no seat holds it/);
});

test("a requirement superseded by a block is still routed to its seat, and the human is never the holder", () => {
  const route = gateRoute(["qa.pass (superseded by qa.block)"], [{ id: "qa", role: "qa" }, { id: "human", role: "qa" }]);
  assert.match(route, /qa\.pass is qa's to give/);
  assert.ok(!/human/.test(route), "the operator is not a seat that records a verdict");
});

test("nothing missing gives no route, and an entry that is not a token is skipped", () => {
  assert.equal(gateRoute([], [{ id: "qa", role: "qa" }]), "");
  assert.equal(gateRoute(["nonsense"], [{ id: "qa", role: "qa" }]), "");
});

test("a new version's notice names every dropped verdict once, and tells its publisher to record its own again", () => {
  const notice = droppedVerdictsNotice([record("qa", "pass"), record("qa", "pass"), record("tech-lead", "approve")], 2, "art-1", "qa");
  assert.match(notice, /^v2 is new content, so the verdicts recorded on v1 are dropped \(qa's pass, tech-lead's approval\): none of them stands for this version\./);
  assert.match(notice, /a gate that names a verdict, such as qa\.pass, stays unsatisfied until they do\./);
  assert.match(notice, /Yours \(pass\) is among them: record it again now if it still holds, with mesh_approve \{ kind: "pass", artifactId: "art-1" \}\./);
  assert.equal((notice.match(/qa's pass/g) ?? []).length, 1, "a verdict given twice is named once");
});

test("a publisher with no verdict among the dropped ones is not told to record one, and no verdicts is no notice", () => {
  const notice = droppedVerdictsNotice([record("tech-lead", "approve")], 3, "art-1", "dev");
  assert.match(notice, /^v3 is new content, so the verdicts recorded on v2 are dropped \(tech-lead's approval\)/);
  assert.ok(!/Yours/.test(notice));
  assert.equal(droppedVerdictsNotice([], 2, "art-1", "qa"), "");
});

test("through the supervisor: a completion refused for qa.pass says who gives it, and the gate stays closed", async () => {
  const m = await makeMesh({ agents: AGENTS, mayContact: COMM, mode: "parked", transitions: { "implementation.completed": ["qa.pass"] } });
  try {
    const created = await m.supervisor.executeOp("pm", { op: "create_task", title: "Implement the library", description: "build it", requiredCapabilities: ["implementation.gate"] } as MeshOp, turnFor("pm"));
    assert.equal(created.ok, true, JSON.stringify(created));
    assert.equal((await m.supervisor.executeOp("dev", { op: "claim_task", taskId: created.taskId } as MeshOp, turnFor("dev"))).ok, true);
    const done = await m.supervisor.executeOp("dev", { op: "complete_task", taskId: created.taskId, summary: "built" } as MeshOp, turnFor("dev"));
    assert.equal(done.ok, false);
    assert.match(done.reason ?? "", /^implementation gate unsatisfied, missing: qa\.pass — qa\.pass is verifier's to give, with mesh_approve \{ kind: "pass" \}\. You cannot give it for them/);
    assert.equal(m.kernel.state.tasks.get(String(created.taskId))?.status, "CLAIMED");
  } finally {
    await m.cleanup();
  }
});

test("through the supervisor: QA's new version of its report drops its pass and says so in the reply to the publish", async () => {
  // The verifier may also reject here, so a verdict of another kind can sit on ANOTHER artifact: it is not dropped, and not named.
  // (A second seat holding `quality.approve` would be a peer reviewer, and a seat may not pass its own report once it has one.)
  const agents = AGENTS.map((a) => (a.id === "verifier" ? { ...a, authority: ["quality.pass", "quality.reject"] } : a));
  const m = await makeMesh({ agents, mayContact: COMM, mode: "parked" });
  try {
    const publish = (extra: Record<string, unknown>) =>
      m.supervisor.executeOp("verifier", { op: "publish_artifact", name: "QA report", type: "TestReport", content: "128 tests pass.", ...extra } as MeshOp, turnFor("verifier"));
    const v1 = await publish({});
    assert.equal(v1.ok, true, JSON.stringify(v1));
    assert.ok(!v1.reason, "a first publish drops nothing");
    const id = String(v1.artifactId);
    const pass = await m.supervisor.executeOp("verifier", { op: "approve", subject: "quality", kind: "pass", artifactId: id, comment: "all good" } as MeshOp, turnFor("verifier"));
    assert.equal(pass.ok, true, JSON.stringify(pass));
    const before = [...m.kernel.state.approvals.values()].flat().filter((r) => r.artifactId === id && r.actorId === "verifier");
    assert.equal(before.length, 1, "fixture: QA's pass is on the log");

    const other = await m.supervisor.executeOp("verifier", { op: "publish_artifact", name: "Perf report", type: "TestReport", content: "p95 12 ms." } as MeshOp, turnFor("verifier"));
    assert.equal(other.ok, true, JSON.stringify(other));
    const otherId = String(other.artifactId);
    const rejection = await m.supervisor.executeOp("verifier", { op: "reject", subject: "quality", artifactId: otherId, comment: "p95 is not measured" } as MeshOp, turnFor("verifier"));
    assert.equal(rejection.ok, true, JSON.stringify(rejection));
    const elsewhere = () => [...m.kernel.state.approvals.values()].flat().filter((r) => r.artifactId === otherId);
    assert.equal(elsewhere().length, 1, "fixture: a rejection is on the log, on the other artifact");

    const v2 = await publish({ asVersionOf: id, content: "128 tests pass, re-run on v2." });
    assert.equal(v2.ok, true, JSON.stringify(v2));
    assert.equal(v2.caveat, true);
    assert.match(v2.reason ?? "", new RegExp(`v2 is new content, so the verdicts recorded on v1 are dropped \\(verifier's pass\\)`));
    assert.match(v2.reason ?? "", new RegExp(`Yours \\(pass\\) is among them: record it again now if it still holds, with mesh_approve \\{ kind: "pass", artifactId: "${id}" \\}`));
    assert.ok(!/rejection/.test(v2.reason ?? ""), "a verdict on another artifact is not dropped by this version, so it is not named");
    const after = [...m.kernel.state.approvals.values()].flat().filter((r) => r.artifactId === id);
    assert.equal(after.length, 0, "and it really is dropped: the notice says what the log did");
    assert.equal(elsewhere().length, 1, "while the other artifact's verdict stands");

    const v3 = await publish({ asVersionOf: id, content: "128 tests pass, re-run on v3." });
    assert.ok(!(v3.reason ?? "").includes("are dropped"), "a version of an artifact with no verdicts has nothing to say about them");
  } finally {
    await m.cleanup();
  }
});
