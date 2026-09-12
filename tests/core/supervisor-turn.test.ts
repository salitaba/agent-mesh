import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { makeMesh, evidenceContent } from "../helpers";
import type { MeshInstance } from "../../apps/mesh-server/src/index";
import type { MeshOp } from "../../packages/protocol/src/index";

/**
 * Supervisor op execution, message admission, decision recording and commit.
 *
 * These paths are reachable without a live turn: `executeOp` takes the turn
 * record as a parameter, so a fixture turn drives every op case directly. That
 * keeps the tests deterministic (no scheduler, no timers) while still going
 * through the real policy engine, kernel and projections.
 */

function fakeTurn(agentId: string, kind: "manual" | "message" | "startup" = "manual") {
  return {
    turnId: `t-${agentId}-${Math.random().toString(36).slice(2, 8)}`,
    agentId,
    reason: { kind },
    sentOps: 0,
    publishedOps: 0,
    waitRequested: false,
    escalated: false,
    results: [],
  } as never;
}

/** A turn record whose mutated counters can be inspected afterwards. */
function countingTurn(agentId: string) {
  return fakeTurn(agentId) as unknown as { sentOps: number; publishedOps: number; escalated: boolean };
}

async function publish(m: MeshInstance, actorId: string, name: string, type: string, content: string, metadata?: Record<string, unknown>) {
  const res = await m.supervisor.executeOp(actorId, { op: "publish_artifact", name, type, content, metadata } as MeshOp, fakeTurn(actorId));
  assert.equal(res.ok, true, `publish ${name}: ${res.reason}`);
  return res.artifactId!;
}

// --- executeOp: op cases that never ran ---------------------------------

test("broadcast fans out to every agent except the sender and the human seat", async () => {
  const m = await makeMesh({
    agents: [
      { id: "architect", role: "architect", interests: [] },
      { id: "dev", role: "developer", interests: [] },
      { id: "qa", role: "qa", interests: [] },
    ],
    mayContact: { architect: ["dev", "qa"] },
    mode: "parked",
  });
  try {
    const turn = countingTurn("architect");
    const res = await m.supervisor.executeOp("architect", { op: "broadcast", type: "INFORM", payload: { note: "kickoff" } } as MeshOp, turn as never);
    assert.equal(res.ok, true, res.reason);
    assert.equal(turn.sentOps, 1);
    const msg = m.kernel.state.messages.get(res.messageId!)!;
    assert.deepEqual([...msg.to].sort(), ["dev", "qa"]);
    assert.equal(msg.from, "architect");
    // The subject records that this was a fan-out, not a targeted send.
    assert.match(m.kernel.state.threads.get(msg.threadId)!.subject, /^broadcast INFORM$/);
  } finally {
    await m.cleanup();
  }
});

test("broadcast reports the send failure instead of claiming success", async () => {
  const m = await makeMesh({
    agents: [
      { id: "architect", role: "architect", interests: [] },
      { id: "dev", role: "developer", interests: [] },
    ],
    // architect may contact nobody, so every recipient is denied.
    mayContact: { architect: [] },
    mode: "parked",
  });
  try {
    const res = await m.supervisor.executeOp("architect", { op: "broadcast", type: "INFORM", payload: {} } as MeshOp, fakeTurn("architect"));
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /communication policy forbids/);
  } finally {
    await m.cleanup();
  }
});

test("reject and veto both land as review.rejected on the artifact", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", authority: ["implementation.approve"], interests: [] },
      { id: "lead", role: "tech-lead", authority: ["implementation.approve", "implementation.reject", "implementation.veto"], interests: [] },
    ],
    mayContact: { dev: ["lead"], lead: ["dev"] },
    mode: "parked",
  });
  try {
    const artId = await publish(m, "dev", "patch", "CodePatch", "diff --git a/x b/x");
    const rejected = await m.supervisor.executeOp("lead", { op: "reject", subject: "implementation", artifactId: artId, comment: "needs tests" } as MeshOp, fakeTurn("lead"));
    assert.equal(rejected.ok, true, rejected.reason);
    const vetoed = await m.supervisor.executeOp("lead", { op: "veto", subject: "implementation", artifactId: artId, comment: "unsafe" } as MeshOp, fakeTurn("lead"));
    assert.equal(vetoed.ok, true, vetoed.reason);
    const events = await m.store.read({ types: ["review.rejected"] });
    assert.equal(events.length, 2);
  } finally {
    await m.cleanup();
  }
});

test("veto without the matching authority is refused, not silently dropped", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", interests: [] },
      { id: "qa", role: "qa", interests: [] },
    ],
    mayContact: { dev: ["qa"] },
    mode: "parked",
  });
  try {
    const res = await m.supervisor.executeOp("qa", { op: "veto", subject: "implementation", comment: "no" } as MeshOp, fakeTurn("qa"));
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /lacks authority 'implementation\.veto'/);
  } finally {
    await m.cleanup();
  }
});

test("propose_decision returns the new decision id and records it as PROPOSED", async () => {
  const m = await makeMesh({
    agents: [{ id: "architect", role: "architect", authority: ["architecture.approve"], interests: [] }],
    mode: "parked",
  });
  try {
    const res = await m.supervisor.executeOp(
      "architect",
      { op: "propose_decision", topic: "storage", decision: { pick: "postgres" } } as MeshOp,
      fakeTurn("architect"),
    );
    assert.equal(res.ok, true);
    const d = m.kernel.state.decisions.get(res.reason!)!;
    assert.equal(d.status, "PROPOSED");
    assert.equal(d.topic, "storage");
    assert.equal(d.proposedBy, "architect");
  } finally {
    await m.cleanup();
  }
});

test("ratify_decision needs architecture.approve authority and an existing decision", async () => {
  const m = await makeMesh({
    agents: [
      { id: "architect", role: "architect", authority: ["architecture.approve"], interests: [] },
      { id: "dev", role: "developer", interests: [] },
    ],
    mayContact: { architect: ["dev"] },
    mode: "parked",
  });
  try {
    const proposed = await m.supervisor.executeOp("architect", { op: "propose_decision", topic: "storage", decision: { pick: "pg" } } as MeshOp, fakeTurn("architect"));
    const decisionId = proposed.reason!;

    const unknown = await m.supervisor.executeOp("architect", { op: "ratify_decision", decisionId: "dec-nope" } as MeshOp, fakeTurn("architect"));
    assert.equal(unknown.ok, false);
    assert.equal(unknown.reason, "unknown decision");

    const unauthorized = await m.supervisor.executeOp("dev", { op: "ratify_decision", decisionId } as MeshOp, fakeTurn("dev"));
    assert.equal(unauthorized.ok, false);
    assert.match(unauthorized.reason ?? "", /lacks authority 'architecture\.approve'/);

    const ok = await m.supervisor.executeOp("architect", { op: "ratify_decision", decisionId } as MeshOp, fakeTurn("architect"));
    assert.equal(ok.ok, true, ok.reason);
    assert.equal(m.kernel.state.decisions.get(decisionId)?.status, "RATIFIED");
  } finally {
    await m.cleanup();
  }
});

test("request_commit asks every agent holding implementation.approve", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", interests: [] },
      { id: "lead", role: "tech-lead", authority: ["implementation.approve"], interests: [] },
      { id: "qa", role: "qa", interests: [] },
    ],
    mayContact: { dev: ["lead", "qa"] },
    mode: "parked",
  });
  try {
    const artId = await publish(m, "dev", "patch", "CodePatch", "diff --git a/x b/x");
    const turn = countingTurn("dev");
    const res = await m.supervisor.executeOp("dev", { op: "request_commit", artifactId: artId, comment: "green build" } as MeshOp, turn as never);
    assert.equal(res.ok, true, res.reason);
    assert.equal(turn.sentOps, 1);
    const msg = m.kernel.state.messages.get(res.messageId!)!;
    assert.deepEqual(msg.to, ["lead"]);
    assert.equal(msg.type, "COMMIT");
    assert.equal((msg.payload as { comment: string }).comment, "green build");
  } finally {
    await m.cleanup();
  }
});

test("request_commit on an unknown artifact fails before any message is sent", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", interests: [] },
      { id: "lead", role: "tech-lead", authority: ["implementation.approve"], interests: [] },
    ],
    mayContact: { dev: ["lead"] },
    mode: "parked",
  });
  try {
    const before = m.kernel.state.messages.size;
    const res = await m.supervisor.executeOp("dev", { op: "request_commit", artifactId: "art-nope" } as MeshOp, fakeTurn("dev"));
    assert.equal(res.ok, false);
    assert.equal(res.reason, "unknown artifact");
    assert.equal(m.kernel.state.messages.size, before);
  } finally {
    await m.cleanup();
  }
});

test("an op name the runtime invented is refused rather than throwing", async () => {
  const m = await makeMesh({ agents: [{ id: "dev", role: "developer", interests: [] }], mode: "parked" });
  try {
    const res = await m.supervisor.executeOp("dev", { op: "teleport", target: "mars" } as unknown as MeshOp, fakeTurn("dev"));
    assert.equal(res.ok, false);
    assert.equal(res.op, "teleport");
    assert.equal(res.reason, "unknown op");
  } finally {
    await m.cleanup();
  }
});

// --- sendMessage: admission and threading -------------------------------

test("a send to a partly-forbidden recipient list is redirected to the allowed subset", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", interests: [] },
      { id: "qa", role: "qa", interests: [] },
      { id: "security", role: "security", interests: [] },
    ],
    mayContact: { dev: ["qa"] },
    mode: "parked",
  });
  try {
    const res = await m.supervisor.sendMessage({ from: "dev", to: ["qa", "security"], type: "INFORM", newThread: { subject: "status" }, payload: {} });
    assert.equal(res.accepted, true, res.reason);
    // `security` was dropped; the message still went to the permitted target.
    assert.deepEqual(m.kernel.state.messages.get(res.messageId!)!.to, ["qa"]);
  } finally {
    await m.cleanup();
  }
});

test("a policy rule marked escalate raises an escalation instead of delivering", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", interests: [] },
      { id: "security", role: "security", interests: [] },
    ],
    mayContact: { dev: [] },
    rules: [{ id: "ask-first", when: { actor: "dev", message_type: "INFORM" }, escalate: true }],
    mode: "parked",
  });
  try {
    const res = await m.supervisor.sendMessage({ from: "dev", to: ["security"], type: "INFORM", newThread: { subject: "fyi" }, payload: {} });
    assert.equal(res.accepted, false);
    assert.ok(res.escalated, "expected an escalation id");
    const esc = m.kernel.state.escalations.get(res.escalated!)!;
    assert.equal(esc.raisedBy, "dev");
    assert.match(esc.reason, /ask-first/);
  } finally {
    await m.cleanup();
  }
});

test("threading disabled by config refuses new threads outright", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", interests: [] },
      { id: "qa", role: "qa", interests: [] },
    ],
    mayContact: { dev: ["qa"] },
    mode: "parked",
  });
  try {
    // The resolved config is the supervisor's only source for the depth cap.
    (m.supervisor.config.escalation as { threadMaxDepth: number }).threadMaxDepth = 0;
    const res = await m.supervisor.sendMessage({ from: "dev", to: ["qa"], type: "INFORM", newThread: { subject: "nope" }, payload: {} });
    assert.equal(res.accepted, false);
    assert.equal(res.reason, "threading disabled");
  } finally {
    await m.cleanup();
  }
});

test("a sub-thread deeper than the configured maximum escalates instead of nesting", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", interests: [] },
      { id: "qa", role: "qa", interests: [] },
    ],
    mayContact: { dev: ["qa"], qa: ["dev"] },
    mode: "parked",
  });
  try {
    const root = await m.supervisor.sendMessage({ from: "dev", to: ["qa"], type: "INFORM", newThread: { subject: "root" }, payload: {} });
    const parentThreadId = m.kernel.state.messages.get(root.messageId!)!.threadId;
    (m.supervisor.config.escalation as { threadMaxDepth: number }).threadMaxDepth = 1;

    const res = await m.supervisor.sendMessage({ from: "dev", to: ["qa"], type: "INFORM", newThread: { subject: "child", parentThreadId }, payload: {} });
    assert.equal(res.accepted, false);
    assert.equal(res.reason, "thread depth exceeded maximum");
    assert.equal(m.kernel.state.escalations.get(res.escalated!)?.reason, "thread_depth_exceeded");
  } finally {
    await m.cleanup();
  }
});

test("replying to a message that does not exist is refused", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", interests: [] },
      { id: "qa", role: "qa", interests: [] },
    ],
    mayContact: { dev: ["qa"] },
    mode: "parked",
  });
  try {
    const res = await m.supervisor.sendMessage({ from: "dev", to: ["qa"], type: "INFORM", newThread: { subject: "x" }, replyTo: "msg-ghost", payload: {} });
    assert.equal(res.accepted, false);
    assert.equal(res.reason, "replyTo msg-ghost not found");
  } finally {
    await m.cleanup();
  }
});

test("a message that fails protocol validation emits message.rejected so the drop is visible", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", interests: [] },
      { id: "qa", role: "qa", interests: [] },
    ],
    mayContact: { dev: ["qa"] },
    mode: "parked",
  });
  try {
    const res = await m.supervisor.sendMessage({
      from: "dev",
      to: ["qa"],
      // Not in the schema's message-type enum: the envelope is well-formed
      // otherwise, so only validation can catch it.
      type: "TELEPATHY" as never,
      newThread: { subject: "x" },
      payload: {},
    });
    assert.equal(res.accepted, false);
    assert.match(res.reason ?? "", /failed protocol validation/);
    const rejections = await m.store.read({ types: ["message.rejected"] });
    assert.equal(rejections.at(-1)!.id, res.eventId);
  } finally {
    await m.cleanup();
  }
});

// --- recordDecision: mandatory-criterion evidence rules ------------------

test("a mandatory criterion cannot be accepted on a comment alone", async () => {
  const m = await makeMesh({
    agents: [{ id: "po", role: "product-owner", authority: ["requirements.accept"], interests: [] }],
    criteria: [{ id: "ship", description: "the deliverable exists", mandatory: true }],
    mode: "parked",
  });
  try {
    const res = await m.supervisor.recordDecision("po", "accept", "criterion:ship", undefined, "I checked, it's fine");
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /is mandatory: acceptance requires artifactId/);
    const rejection = (await m.store.read({ types: ["message.rejected"] })).at(-1)!;
    assert.equal((rejection.payload as { ruleId: string }).ruleId, "mandatory-evidence-artifact-required");
  } finally {
    await m.cleanup();
  }
});

test("accepting a criterion with neither artifact nor comment is refused as evidence-free", async () => {
  const m = await makeMesh({
    agents: [{ id: "po", role: "product-owner", authority: ["requirements.accept"], interests: [] }],
    criteria: [{ id: "ship", description: "the deliverable exists", mandatory: true }],
    mode: "parked",
  });
  try {
    const res = await m.supervisor.recordDecision("po", "accept", "criterion:ship");
    assert.equal(res.ok, false);
    const rejection = (await m.store.read({ types: ["message.rejected"] })).at(-1)!;
    assert.equal((rejection.payload as { ruleId: string }).ruleId, "evidence-required");
  } finally {
    await m.cleanup();
  }
});

test("citing an artifact id that does not exist fails the mandatory-evidence gate", async () => {
  const m = await makeMesh({
    agents: [{ id: "po", role: "product-owner", authority: ["requirements.accept"], interests: [] }],
    criteria: [{ id: "ship", description: "the deliverable exists", mandatory: true }],
    mode: "parked",
  });
  try {
    const res = await m.supervisor.recordDecision("po", "accept", "criterion:ship", "art-ghost", "see attached");
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /^unknown artifact art-ghost cited as evidence/);
  } finally {
    await m.cleanup();
  }
});

test("a one-line artifact is too thin to evidence a mandatory criterion", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", interests: [] },
      { id: "po", role: "product-owner", authority: ["requirements.accept"], interests: [] },
    ],
    criteria: [{ id: "ship", description: "the deliverable exists", mandatory: true }],
    mode: "parked",
  });
  try {
    const artId = await publish(m, "dev", "design", "ArchitectureDocument", "TODO: write this up later");
    const res = await m.supervisor.recordDecision("po", "accept", "criterion:ship", artId, "done");
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /too thin to evidence a mandatory criterion/);
    const rejection = (await m.store.read({ types: ["message.rejected"] })).at(-1)!;
    assert.equal((rejection.payload as { ruleId: string }).ruleId, "mandatory-evidence-too-thin");
  } finally {
    await m.cleanup();
  }
});

test("a DRAFT artifact cannot evidence a mandatory criterion until it is submitted", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", interests: [] },
      { id: "po", role: "product-owner", authority: ["requirements.accept"], interests: [] },
    ],
    criteria: [{ id: "ship", description: "the deliverable exists", mandatory: true }],
    mode: "parked",
  });
  try {
    const artId = await publish(m, "dev", "design", "TestReport", evidenceContent("Mission report"));
    const denied = await m.supervisor.recordDecision("po", "accept", "criterion:ship", artId, "reviewed");
    assert.equal(denied.ok, false, "a DRAFT deliverable proves nothing, however well written");
    assert.match(denied.reason ?? "", /is DRAFT and cannot evidence mandatory criterion/);
    const rejection = (await m.store.read({ types: ["message.rejected"] })).at(-1)!;
    assert.equal((rejection.payload as { ruleId: string }).ruleId, "mandatory-evidence-not-submitted");

    await m.supervisor.transitionArtifact("dev", artId, { to: "READY_FOR_REVIEW" });
    const accepted = await m.supervisor.recordDecision("po", "accept", "criterion:ship", artId, "reviewed");
    assert.equal(accepted.ok, true, accepted.reason);
    const goal = m.kernel.state.goals.get(m.kernel.state.activeGoalId!)!;
    assert.equal(goal.acceptanceCriteria.find((c) => c.id === "ship")?.status, "EVIDENCED");
  } finally {
    await m.cleanup();
  }
});

test("a substantive artifact clears the gate but lands as ASSERTED when nothing was verified", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", interests: [] },
      { id: "po", role: "product-owner", authority: ["requirements.accept"], interests: [] },
    ],
    criteria: [{ id: "ship", description: "the deliverable exists", mandatory: true }],
    mode: "parked",
  });
  try {
    const artId = await publish(m, "dev", "design", "ArchitectureDocument", evidenceContent("Mission design"));
    await m.supervisor.transitionArtifact("dev", artId, { to: "READY_FOR_REVIEW" });
    // A document is approved from UNDER_REVIEW; no REQUEST_REVIEW was sent, so
    // take the hop the review-request projection would otherwise take.
    await m.supervisor.transitionArtifact("dev", artId, { to: "UNDER_REVIEW" });
    const res = await m.supervisor.recordDecision("po", "accept", "criterion:ship", artId, "reviewed");
    assert.equal(res.ok, true, res.reason);
    // No turn is in flight, so the claim is verified by construction.
    const goal = m.kernel.state.goals.get(m.kernel.state.activeGoalId!)!;
    assert.equal(goal.acceptanceCriteria.find((c) => c.id === "ship")?.status, "EVIDENCED");
  } finally {
    await m.cleanup();
  }
});

test("accepting a criterion needs requirements.accept or requirements.approve", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", interests: [] },
      { id: "qa", role: "qa", interests: [] },
    ],
    criteria: [{ id: "ship", description: "the deliverable exists", mandatory: false }],
    mode: "parked",
  });
  try {
    const res = await m.supervisor.recordDecision("qa", "accept", "criterion:ship", undefined, "looks fine to me");
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /lacks authority 'requirements\.accept'/);
  } finally {
    await m.cleanup();
  }
});

test("an optional criterion accepts on a comment alone", async () => {
  const m = await makeMesh({
    agents: [{ id: "po", role: "product-owner", authority: ["requirements.approve"], interests: [] }],
    criteria: [{ id: "polish", description: "nice to have", mandatory: false }],
    mode: "parked",
  });
  try {
    // `requirements.approve` alone is enough: it overrides the accept check.
    const res = await m.supervisor.recordDecision("po", "accept", "criterion:polish", undefined, "confirmed in the demo");
    assert.equal(res.ok, true, res.reason);
  } finally {
    await m.cleanup();
  }
});

test("an artifact owner cannot approve their own work while a peer reviewer exists", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["code.review"], authority: ["implementation.approve"], interests: [] },
      { id: "lead", role: "tech-lead", capabilities: ["code.review"], authority: ["implementation.approve"], interests: [] },
    ],
    mayContact: { dev: ["lead"], lead: ["dev"] },
    mode: "parked",
  });
  try {
    const artId = await publish(m, "dev", "patch", "CodePatch", "diff --git a/x b/x");
    const own = await m.supervisor.recordDecision("dev", "approve", "implementation", artId, "lgtm");
    assert.equal(own.ok, false);
    assert.equal(own.reason, "artifact owner cannot approve their own artifact");
    const rejection = (await m.store.read({ types: ["message.rejected"] })).at(-1)!;
    assert.equal((rejection.payload as { ruleId: string }).ruleId, "self-approval");

    const peer = await m.supervisor.recordDecision("lead", "approve", "implementation", artId, "lgtm");
    assert.equal(peer.ok, true, peer.reason);
  } finally {
    await m.cleanup();
  }
});

test("a quality pass records evidence against the quality-verified criterion", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", interests: [] },
      { id: "qa", role: "qa", authority: ["quality.pass"], interests: [] },
    ],
    criteria: [{ id: "quality-verified", description: "tests pass", mandatory: true }],
    mayContact: { qa: ["dev"] },
    mode: "parked",
  });
  try {
    const artId = await publish(m, "qa", "tests", "TestReport", evidenceContent("Test run"));
    const res = await m.supervisor.recordDecision("qa", "pass", "quality", artId, "all green");
    assert.equal(res.ok, true, res.reason);
    const goal = m.kernel.state.goals.get(m.kernel.state.activeGoalId!)!;
    assert.equal(goal.acceptanceCriteria.find((c) => c.id === "quality-verified")?.status, "EVIDENCED");
  } finally {
    await m.cleanup();
  }
});

test("a security pass records evidence against the security-verified criterion", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", interests: [] },
      { id: "security", role: "security", capabilities: ["security.review"], authority: ["security.pass"], interests: [] },
    ],
    criteria: [{ id: "security-verified", description: "no criticals", mandatory: true }],
    mayContact: { security: ["dev"] },
    mode: "parked",
  });
  try {
    const artId = await publish(m, "security", "scan", "SecurityReport", evidenceContent("Security scan"));
    const res = await m.supervisor.recordDecision("security", "pass", "security", artId, "clean");
    assert.equal(res.ok, true, res.reason);
    const goal = m.kernel.state.goals.get(m.kernel.state.activeGoalId!)!;
    assert.equal(goal.acceptanceCriteria.find((c) => c.id === "security-verified")?.status, "EVIDENCED");
  } finally {
    await m.cleanup();
  }
});

// --- opCommit -----------------------------------------------------------

test("commit refuses an artifact the mesh has never seen", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", capabilities: ["git.commit"], interests: [] }],
    mode: "parked",
  });
  try {
    const res = await m.supervisor.executeOp("dev", { op: "commit", artifactId: "art-ghost", message: "wip" } as MeshOp, fakeTurn("dev"));
    assert.equal(res.ok, false);
    assert.equal(res.reason, "unknown artifact");
  } finally {
    await m.cleanup();
  }
});

test("commit without the git.commit capability is denied and recorded", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] }],
    mode: "parked",
  });
  try {
    const artId = await publish(m, "dev", "patch", "CodePatch", "diff --git a/x b/x");
    const res = await m.supervisor.executeOp("dev", { op: "commit", artifactId: artId, message: "wip" } as MeshOp, fakeTurn("dev"));
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /does not hold capability 'git\.commit'/);
    const rejection = (await m.store.read({ types: ["message.rejected"] })).at(-1)!;
    assert.equal((rejection.payload as { action: string }).action, "commit");
  } finally {
    await m.cleanup();
  }
});

test("an unsatisfied patch.commit gate blocks the commit and names what is missing", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["git.commit", "repository.write"], interests: [] },
      { id: "lead", role: "tech-lead", capabilities: ["code.review"], authority: ["implementation.approve"], interests: [] },
    ],
    transitions: { "patch.commit": ["tech-lead.approve"] },
    mayContact: { dev: ["lead"], lead: ["dev"] },
    mode: "parked",
  });
  try {
    const artId = await publish(m, "dev", "patch", "CodePatch", "diff --git a/x b/x");
    const res = await m.supervisor.executeOp("dev", { op: "commit", artifactId: artId, message: "wip" } as MeshOp, fakeTurn("dev"));
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /commit gate unsatisfied, missing: tech-lead\.approve/);
  } finally {
    await m.cleanup();
  }
});

test("commit requires a write lease held by the committer", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", capabilities: ["git.commit", "repository.write"], interests: [] }],
    mode: "parked",
  });
  try {
    const artId = await publish(m, "dev", "patch", "CodePatch", "diff --git a/x b/x");
    const noLease = await m.supervisor.executeOp("dev", { op: "commit", artifactId: artId, message: "wip" } as MeshOp, fakeTurn("dev"));
    assert.equal(noLease.ok, false);
    assert.equal(noLease.reason, "commit requires an active write lease on the artifact");
  } finally {
    await m.cleanup();
  }
});

test("with a lease but no git workspace the commit is refused rather than faked", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", capabilities: ["git.commit", "repository.write"], interests: [] }],
    mode: "parked",
  });
  try {
    const artId = await publish(m, "dev", "patch", "CodePatch", "diff --git a/x b/x");
    const lease = await m.supervisor.executeOp("dev", { op: "acquire_lease", artifactId: artId, files: ["src/x.ts"] } as MeshOp, fakeTurn("dev"));
    assert.equal(lease.ok, true, lease.reason);

    const deps = m.supervisor.deps as { workspace?: unknown };
    const saved = deps.workspace;
    deps.workspace = undefined;
    try {
      const res = await m.supervisor.executeOp("dev", { op: "commit", artifactId: artId, message: "wip" } as MeshOp, fakeTurn("dev"));
      assert.equal(res.ok, false);
      assert.equal(res.reason, "no git workspace configured for this mesh");
    } finally {
      deps.workspace = saved;
    }
  } finally {
    await m.cleanup();
  }
});

test("a successful commit versions the artifact and emits a change event per touched concern", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", capabilities: ["git.commit", "repository.write"], interests: [] }],
    mode: "parked",
  });
  try {
    const artId = await publish(m, "dev", "patch", "CodePatch", "diff --git a/x b/x");
    const lease = await m.supervisor.executeOp("dev", { op: "acquire_lease", artifactId: artId, files: ["package.json"] } as MeshOp, fakeTurn("dev"));
    assert.equal(lease.ok, true, lease.reason);

    // A diff touching a manifest AND an auth path must raise both signals.
    const diff = ["diff --git a/package.json b/package.json", "+  \"jsonwebtoken\": \"^9\"", "diff --git a/src/login.ts b/src/login.ts", "+export function login(password: string) {}"].join("\n");
    const deps = m.supervisor.deps as { workspace?: unknown };
    const saved = deps.workspace;
    deps.workspace = {
      ensureWorktree: async () => "/tmp/mesh-fake-worktree",
      commitWorktree: async () => ({ commit: "abc1234", diffDigest: "sha256:fake", diff }),
      mergeWorktree: async () => ({ commit: "abc1234" }),
    };
    try {
      const res = await m.supervisor.executeOp("dev", { op: "commit", artifactId: artId, message: "add auth" } as MeshOp, fakeTurn("dev"));
      assert.equal(res.ok, true, res.reason);
      assert.equal(res.reason, "abc1234");
      // The new version supersedes the original, carrying the commit metadata.
      assert.equal(res.artifact?.version, 2);
      assert.equal((res.artifact?.metadata as { commit: string }).commit, "abc1234");
    } finally {
      deps.workspace = saved;
    }

    const emitted = (await m.store.read()).map((e) => e.type);
    assert.ok(emitted.includes("dependency.changed"), "package.json touched");
    assert.ok(emitted.includes("authentication.changed"), "login/password touched");
    assert.equal(emitted.includes("authorization.changed"), false, "no rbac/permission text in the diff");
  } finally {
    await m.cleanup();
  }
});

// --- opMerge ------------------------------------------------------------

test("merge is refused unless the artifact is MERGEABLE", async () => {
  const m = await makeMesh({
    agents: [{ id: "lead", role: "tech-lead", capabilities: ["git.merge"], authority: ["implementation.approve"], interests: [] }],
    mode: "parked",
  });
  try {
    const artId = await publish(m, "lead", "patch", "CodePatch", "diff --git a/x b/x");
    const res = await m.supervisor.executeOp("lead", { op: "merge", artifactId: artId } as MeshOp, fakeTurn("lead"));
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /must be MERGEABLE/);
  } finally {
    await m.cleanup();
  }
});

test("merge without git.merge capability is denied before the transition", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", interests: [] }],
    mode: "parked",
  });
  try {
    const artId = await publish(m, "dev", "patch", "CodePatch", "diff --git a/x b/x");
    const res = await m.supervisor.executeOp("dev", { op: "merge", artifactId: artId } as MeshOp, fakeTurn("dev"));
    assert.equal(res.ok, false);
    assert.match(res.reason ?? "", /does not hold capability 'git\.merge'/);
  } finally {
    await m.cleanup();
  }
});

test("merge with no resolvable reference reports the unknown artifact", async () => {
  const m = await makeMesh({
    agents: [{ id: "lead", role: "tech-lead", capabilities: ["git.merge"], interests: [] }],
    mode: "parked",
  });
  try {
    const res = await m.supervisor.executeOp("lead", { op: "merge", artifactUri: "CodePatch-nothing-v1" } as MeshOp, fakeTurn("lead"));
    assert.equal(res.ok, false);
    assert.equal(res.reason, "unknown artifact");
  } finally {
    await m.cleanup();
  }
});

// --- opMerge: non-git materialization -----------------------------------

const MERGE_AGENTS = [
  { id: "dev", role: "developer", capabilities: ["repository.write", "test.execute", "git.commit"], interests: [] },
  { id: "lead", role: "tech-lead", capabilities: ["code.review", "git.merge"], authority: ["implementation.approve"], interests: [] },
];

async function patchAtMergeable(m: MeshInstance, content: string, metadata?: Record<string, unknown>): Promise<string> {
  const artId = await publish(m, "dev", "playground", "CodePatch", content, metadata);
  const op = (actorId: string, o: MeshOp) => m.supervisor.executeOp(actorId, o, fakeTurn(actorId));
  assert.equal((await op("dev", { op: "transition_artifact", artifactId: artId, to: "READY_FOR_REVIEW" })).ok, true);
  assert.equal((await op("lead", { op: "transition_artifact", artifactId: artId, to: "UNDER_REVIEW" })).ok, true);
  assert.equal((await op("lead", { op: "approve", subject: "implementation", artifactId: artId })).ok, true);
  assert.equal((await op("lead", { op: "transition_artifact", artifactId: artId, to: "APPROVED" })).ok, true);
  assert.equal((await op("dev", { op: "transition_artifact", artifactId: artId, to: "VERIFIED" })).ok, true);
  assert.equal((await op("dev", { op: "transition_artifact", artifactId: artId, to: "MERGEABLE" })).ok, true);
  return artId;
}

function criterionStatus(m: MeshInstance, id: string): string | undefined {
  const goal = m.kernel.state.goals.get(m.kernel.state.activeGoalId ?? "");
  return goal?.acceptanceCriteria.find((c) => c.id === id)?.status;
}

test("non-git merge materializes the patch files and evidences implementation-merged", async () => {
  const m = await makeMesh({
    agents: MERGE_AGENTS,
    criteria: [{ id: "implementation-merged", description: "the work is merged", mandatory: true }],
    mode: "parked",
  });
  try {
    const content = ["## File: web/playground.html", "<html>play</html>", "", "## Manual verification / AC traceability", "- checked"].join("\n");
    const artId = await patchAtMergeable(m, content);
    const res = await m.supervisor.executeOp("lead", { op: "merge", artifactId: artId } as MeshOp, fakeTurn("lead"));
    assert.equal(res.ok, true, res.reason);

    const target = path.join(m.supervisor.config.workspacePath, "web/playground.html");
    assert.equal(fs.readFileSync(target, "utf8"), "<html>play</html>");
    assert.equal(criterionStatus(m, "implementation-merged"), "EVIDENCED");
  } finally {
    await m.cleanup();
  }
});

test("non-git merge with no materializable content stays truthful: no file, no evidence", async () => {
  const m = await makeMesh({
    agents: MERGE_AGENTS,
    criteria: [{ id: "implementation-merged", description: "the work is merged", mandatory: true }],
    mode: "parked",
  });
  try {
    const artId = await patchAtMergeable(m, evidenceContent("prose only, no file sections"));
    const res = await m.supervisor.executeOp("lead", { op: "merge", artifactId: artId } as MeshOp, fakeTurn("lead"));
    assert.equal(res.ok, true, res.reason);
    assert.match(res.reason ?? "", /no file sections/);
    assert.notEqual(criterionStatus(m, "implementation-merged"), "EVIDENCED");
  } finally {
    await m.cleanup();
  }
});

// --- requestApproval ----------------------------------------------------

test("requestApproval resolves reviewers by role and refuses when nobody holds it", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", interests: [] },
      { id: "lead", role: "tech-lead", interests: [] },
    ],
    mayContact: { dev: ["lead"], lead: ["dev"] },
    mode: "parked",
  });
  try {
    const artId = await publish(m, "dev", "patch", "CodePatch", "diff --git a/x b/x");

    const unknownArtifact = await m.supervisor.requestApproval("art-ghost", "tech-lead");
    assert.equal(unknownArtifact.accepted, false);
    assert.equal(unknownArtifact.reason, "unknown artifact");

    const noSuchRole = await m.supervisor.requestApproval(artId, "release-manager");
    assert.equal(noSuchRole.accepted, false);
    assert.equal(noSuchRole.reason, "no agent with role release-manager");

    const ok = await m.supervisor.requestApproval(artId, "tech-lead");
    assert.equal(ok.accepted, true, ok.reason);
    const msg = m.kernel.state.messages.get(ok.messageId!)!;
    assert.equal(msg.type, "REQUEST_REVIEW");
    assert.deepEqual(msg.to, ["lead"]);
  } finally {
    await m.cleanup();
  }
});
