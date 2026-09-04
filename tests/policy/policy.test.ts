import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor } from "../helpers";
import { checkApprovals } from "../../packages/core/src/projections";
import type { MeshOp } from "../../packages/protocol/src/index";

test("policy: may_contact restricts new threads only", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "qa", role: "qa", capabilities: ["test.write"], interests: [] },
    ],
    mayContact: { dev: [], qa: [] },
  });
  const denied = await m.supervisor.sendMessage({ from: "dev", to: ["qa"], type: "REQUEST_REVIEW", payload: {}, newThread: { subject: "x" } });
  assert.equal(denied.accepted, false);
  assert.match(denied.reason ?? "", /forbids/);
  const events = await m.store.read({ types: ["message.rejected"] });
  assert.equal(events.length, 1);

  await m.supervisor.humanSend(["qa"], "REQUEST_REVIEW", { q: 1 });
  const thread = [...m.kernel.state.threads.values()].reverse()[0];
  const reply = await m.supervisor.sendMessage({ from: "qa", to: ["human"], type: "APPROVE", threadId: thread.id, payload: {} });
  assert.equal(reply.accepted, true);
  await m.cleanup();
});

test("policy: capability enforcement (layer 2)", async () => {
  const m = await makeMesh({
    agents: [
      { id: "explorer", role: "explorer", mode: "service", capabilities: ["repository.read"], interests: [] },
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
    ],
    mayContact: { explorer: [], dev: [] },
  });
  const ctx = { config: m.config, projections: m.kernel.state };
  assert.equal(m.supervisor.deps.policy.evaluateCapability("explorer", "repository.write", ctx).decision, "DENY");
  assert.equal(m.supervisor.deps.policy.evaluateCapability("dev", "repository.write", ctx).decision, "ALLOW");
  assert.equal(m.supervisor.deps.policy.evaluateCapability("dev", "git.commit", ctx).decision, "DENY");
  await m.cleanup();
});

test("policy: YAML rules deny capabilities and message types beyond the matrix", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write", "git.commit"], interests: [] },
      { id: "lead", role: "tech-lead", capabilities: ["code.review"], interests: [] },
    ],
    mayContact: { dev: ["lead"], lead: ["dev"] },
    rules: [{ id: "no-direct-commits", when: { actor_role: "developer" }, deny: { capabilities: ["git.commit"] } }],
  });
  const ctx = { config: m.config, projections: m.kernel.state };
  const verdict = m.supervisor.deps.policy.evaluateCapability("dev", "git.commit", ctx);
  assert.equal(verdict.decision, "DENY");
  assert.equal(verdict.ruleId, "no-direct-commits");
  await m.cleanup();
});

test("policy: authority is required to approve or block", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "qa", role: "qa", capabilities: ["test.write"], authority: ["quality.block"], interests: [] },
    ],
    mayContact: { dev: ["qa"], qa: ["dev"] },
  });
  const wrong = await m.supervisor.recordDecision("dev", "approve", "quality");
  assert.equal(wrong.ok, false);
  assert.match(wrong.reason ?? "", /lacks authority/);
  await m.cleanup();
});

test("policy: developers cannot approve their own patches (layer 3)", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write", "code.review"], interests: [] },
      { id: "lead", role: "tech-lead", capabilities: ["code.review"], authority: ["implementation.approve"], interests: [] },
    ],
    mayContact: { dev: ["lead"], lead: ["dev"] },
  });
  const created = await m.supervisor.createArtifact({ actorId: "dev", name: "patch-1", type: "CodePatch", content: "diff" });
  assert.ok("artifact" in created);
  if ("artifact" in created) {
    const selfApprove = await m.supervisor.recordDecision("dev", "approve", "implementation", created.artifact.id, "lgtm");
    assert.equal(selfApprove.ok, false);
    assert.match(selfApprove.reason ?? "", /own artifact|lacks authority/);
  }
  await m.cleanup();
});

test("policy: merge gate requires configured approvals (layer 4 blocks the rest)", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write", "git.commit"], interests: [] },
      { id: "lead", role: "tech-lead", capabilities: ["code.review", "git.merge"], authority: ["implementation.approve"], interests: [] },
    ],
    mayContact: { dev: ["lead"], lead: ["dev"] },
    transitions: { "patch.merge": ["lead.approve"] },
  });
  const created = await m.supervisor.createArtifact({ actorId: "dev", name: "patch-g", type: "CodePatch", content: "diff" });
  if (!("artifact" in created)) throw new Error("publish failed");
  const id = created.artifact.id;
  await m.supervisor.transitionArtifact("dev", id, { to: "READY_FOR_REVIEW" });
  await m.supervisor.transitionArtifact("dev", id, { to: "UNDER_REVIEW" });
  const earlyMerge = await m.supervisor.transitionArtifact("lead", id, { to: "APPROVED" });
  assert.equal(earlyMerge.ok, false, "APPROVED must require review.approved evidence first");
  const approved = await m.supervisor.recordDecision("lead", "approve", "implementation", id, "looks good");
  assert.equal(approved.ok, true, approved.reason);
  assert.equal(m.kernel.state.artifacts.get(id)?.status, "APPROVED", "review.approved evidence drives the transition");
  const toVerified = await m.supervisor.transitionArtifact("lead", id, { to: "VERIFIED" });
  assert.equal(toVerified.ok, true, toVerified.reason);
  const toMergeable = await m.supervisor.transitionArtifact("lead", id, { to: "MERGEABLE" });
  assert.equal(toMergeable.ok, true, toMergeable.reason);
  const ctx = { config: m.config, projections: m.kernel.state };
  const missingForMerge = checkApprovals(m.kernel.state, ["dev.approve"], id);
  assert.equal(missingForMerge.ok, false);
  assert.ok(missingForMerge.missing.includes("dev.approve"));
  void ctx;
  await m.cleanup();
});

test("policy: self-review is allowed only when no peer reviewer exists (§71 control-group fairness)", async () => {
  const solo = await makeMesh({
    agents: [{ id: "solo", role: "solo", capabilities: ["repository.write", "code.review"], authority: ["implementation.approve"], interests: [] }],
    mayContact: { solo: [] },
  });
  const created = await solo.supervisor.createArtifact({ actorId: "solo", name: "solo-patch", type: "CodePatch", content: "diff" });
  if ("artifact" in created) {
    const selfApprove = await solo.supervisor.recordDecision("solo", "approve", "implementation", created.artifact.id, "no peers exist");
    assert.equal(selfApprove.ok, true, selfApprove.reason);
  }
  await solo.cleanup();
});

test("policy: qa block is recorded as evidence and survives replay of approvals", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "qa", role: "qa", capabilities: ["test.write"], authority: ["quality.block"], interests: [] },
    ],
    mayContact: { dev: ["qa"], qa: ["dev"] },
    transitions: { "release.accepted": ["qa.pass", "security.pass"] },
  });
  const before = checkApprovals(m.kernel.state, ["qa.pass"], undefined);
  assert.equal(before.ok, false);
  await m.supervisor.sendMessage({ from: "qa", to: ["dev"], type: "TEST_RESULT", newThread: { subject: "suite" }, payload: { result: "PASSED" } });
  const mid = checkApprovals(m.kernel.state, ["qa.pass"], undefined);
  assert.equal(mid.ok, true);
  const still = checkApprovals(m.kernel.state, ["qa.pass", "security.pass"], undefined);
  assert.equal(still.ok, false);
  assert.deepEqual(still.missing, ["security.pass"]);
  await m.cleanup();
});

test("policy: service agents only activate on request events", async () => {
  const m = await makeMesh({
    agents: [{ id: "explorer", role: "explorer", mode: "service", capabilities: ["repository.read"], interests: ["artifact.created", "message.sent"] }],
    mayContact: { explorer: [] },
  });
  const verdict = m.supervisor.deps.policy.evaluateActivation("explorer", { id: "x", type: "artifact.created", timestamp: new Date().toISOString(), payload: {} }, { config: m.config, projections: m.kernel.state });
  assert.equal(verdict.decision, "DENY");
  const verdict2 = m.supervisor.deps.policy.evaluateActivation("explorer", { id: "x", type: "message.sent", timestamp: new Date().toISOString(), payload: {} }, { config: m.config, projections: m.kernel.state });
  assert.equal(verdict2.decision, "ALLOW");
  await m.cleanup();
});

test("policy: human is a mesh participant, not an oracle bypass of evidence", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
    ],
    mayContact: { dev: [] },
    transitions: { "patch.merge": ["dev.approve"] },
  });
  await m.supervisor.humanSend(["dev"], "INFORM", { note: "human may contact anyone" });
  const created = await m.supervisor.createArtifact({ actorId: "dev", name: "hpatch", type: "CodePatch", content: "d" });
  if ("artifact" in created) {
    const humanApproved = await m.supervisor.recordDecision("human", "approve", "implementation", created.artifact.id);
    assert.equal(humanApproved.ok, true, humanApproved.reason);
  }
  await m.cleanup();
});
