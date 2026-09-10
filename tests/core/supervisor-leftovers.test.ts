import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, evidenceContent } from "../helpers";
import type { MeshInstance } from "../../apps/mesh-server/src/index";
import type { MeshOp, SubAgentResult } from "../../packages/protocol/src/index";

/**
 * The supervisor methods that no other test file reaches: commitment
 * discharge notifications, artifact transition mirroring, escalation
 * disagreement capture, worker delegation, lease acquisition and the
 * subject/domain classifier.
 *
 * All of these are reachable from the public surface on a parked mesh, so
 * nothing here depends on the scheduler pumping or on a timer firing.
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

function countingTurn(agentId: string) {
  return fakeTurn(agentId) as unknown as { sentOps: number; publishedOps: number; escalated: boolean };
}

async function publish(m: MeshInstance, actorId: string, name: string, type: string, content: string) {
  const res = await m.supervisor.executeOp(actorId, { op: "publish_artifact", name, type, content } as MeshOp, fakeTurn(actorId));
  assert.equal(res.ok, true, `publish ${name}: ${res.reason}`);
  return res.artifactId!;
}

function workerResult(summary: string): SubAgentResult {
  return { status: "COMPLETED", summary, artifacts: [], findings: [], risks: [], recommendation: "merge it" };
}

/**
 * Record the notes agents are woken with.
 *
 * `deps.scheduler` is mutable, so wrapping `requestActivation` captures every
 * wake without pumping a turn. The wake note is the only thing that unparks a
 * WAITING asker on a non-reply discharge, so it is the behaviour under test.
 */
function captureWakes(m: MeshInstance): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const sched = m.supervisor.deps.scheduler as unknown as {
    requestActivation: (req: { agentId: string; reason: { note?: string } }) => Promise<boolean>;
  };
  const real = sched.requestActivation.bind(sched);
  sched.requestActivation = async (req) => {
    const list = seen.get(req.agentId) ?? [];
    list.push(req.reason.note ?? "");
    seen.set(req.agentId, list);
    return real(req);
  };
  return seen;
}

async function askReview(m: MeshInstance, from: string, to: string[], subject: string): Promise<string> {
  const sent = await m.supervisor.sendMessage({
    from,
    to,
    type: "REQUEST_REVIEW",
    newThread: { subject },
    payload: { question: "review this" },
  });
  assert.equal(sent.accepted, true, sent.reason);
  return sent.messageId!;
}

// --- dischargeCommitment: who gets told, and what they are told ----------

test("an ask nobody made cannot be discharged", async () => {
  const m = await makeMesh({
    agents: [{ id: "architect", role: "architect", interests: [] }],
    mode: "parked",
  });
  try {
    assert.equal(await m.supervisor.dischargeCommitment("msg-does-not-exist", "reply", "architect"), false);
  } finally {
    await m.cleanup();
  }
});

test("one reviewer answering a two-reviewer ask leaves it open and names who is still owed", async () => {
  const m = await makeMesh({
    agents: [
      { id: "architect", role: "architect", interests: [] },
      { id: "qa", role: "qa", interests: [] },
      { id: "sec", role: "security", interests: [] },
    ],
    mayContact: { architect: ["qa", "sec"] },
    mode: "parked",
  });
  try {
    const messageId = await askReview(m, "architect", ["qa", "sec"], "please review");
    const wakes = captureWakes(m);

    // `reply` is a per-debtor reason, so qa answering settles only qa's share.
    assert.equal(await m.supervisor.dischargeCommitment(messageId, "reply", "qa"), true);

    assert.ok(m.kernel.state.pendingRequests.has(messageId), "the ask stays open while sec owes an answer");
    const notes = wakes.get("architect") ?? [];
    const partial = notes.find((n) => n.includes("still awaiting"));
    assert.ok(partial, `expected a partial-answer wake, got ${JSON.stringify(notes)}`);
    assert.match(partial!, /qa answered your request/);
    assert.match(partial!, /still awaiting sec/);
  } finally {
    await m.cleanup();
  }
});

test("the last debtor answering closes the ask and tells the asker it was answered", async () => {
  const m = await makeMesh({
    agents: [
      { id: "architect", role: "architect", interests: [] },
      { id: "qa", role: "qa", interests: [] },
    ],
    mayContact: { architect: ["qa"] },
    mode: "parked",
  });
  try {
    const messageId = await askReview(m, "architect", ["qa"], "please review");
    const wakes = captureWakes(m);
    assert.equal(await m.supervisor.dischargeCommitment(messageId, "reply", "qa"), true);
    assert.equal(m.kernel.state.pendingRequests.has(messageId), false);
    const notes = wakes.get("architect") ?? [];
    assert.ok(notes.some((n) => n.includes("it was answered")), JSON.stringify(notes));
  } finally {
    await m.cleanup();
  }
});

test("each discharge reason wakes the asker with its own explanation", async () => {
  // The `why` ladder in full. These are the discharges where nothing was
  // mailed, so the wake note is the only thing that unparks a WAITING asker.
  const cases: Array<[string, RegExp]> = [
    ["superseded", /a newer artifact version replaced/],
    ["deadlock_break", /voided to break a circular wait/],
    ["evicted_cap", /ledger hit capacity and dropped it UNANSWERED/],
    ["operator", /an operator resolved it/],
    ["task_completed", /its task completed/],
    ["task", /its task was answered/],
    ["in_thread", /an in-thread answer arrived/],
    ["artifact_review", /a review verdict landed on its artifact/],
  ];
  for (const [reason, expected] of cases) {
    const m = await makeMesh({
      agents: [
        { id: "architect", role: "architect", interests: [] },
        { id: "qa", role: "qa", interests: [] },
      ],
      mayContact: { architect: ["qa"] },
      mode: "parked",
    });
    try {
      const messageId = await askReview(m, "architect", ["qa"], `ask ${reason}`);
      const wakes = captureWakes(m);
      // The per-debtor reasons still close the ask outright here: qa is the
      // only debtor, so nothing remains after its share is settled.
      assert.equal(await m.supervisor.dischargeCommitment(messageId, reason as never, "qa"), true, reason);
      const notes = wakes.get("architect") ?? [];
      assert.ok(notes.some((n) => expected.test(n)), `${reason}: got ${JSON.stringify(notes)}`);
    } finally {
      await m.cleanup();
    }
  }
});

test("a discharge the log refuses leaves the ask open", async () => {
  const m = await makeMesh({
    agents: [
      { id: "architect", role: "architect", interests: [] },
      { id: "qa", role: "qa", interests: [] },
    ],
    mayContact: { architect: ["qa"] },
    mode: "parked",
  });
  const kernel = m.supervisor.deps.kernel as unknown as { emit: (...a: unknown[]) => unknown };
  const realEmit = kernel.emit.bind(kernel);
  try {
    const messageId = await askReview(m, "architect", ["qa"], "please review");
    kernel.emit = async (type: unknown, ...rest: unknown[]) => {
      if (type === "commitment.discharged") throw new Error("log rejected the discharge");
      return realEmit(type, ...rest);
    };
    assert.equal(
      await m.supervisor.dischargeCommitment(messageId, "reply", "qa"),
      false,
      "a discharge that never reached the log must not report success",
    );
    kernel.emit = realEmit;
    assert.equal(m.kernel.state.pendingRequests.has(messageId), true, "the ask stays open");
  } finally {
    kernel.emit = realEmit;
    await m.cleanup();
  }
});

// --- settleReviewAsks: a verdict closes the asks that pointed at it ------

test("a review verdict discharges the ask that referenced that artifact", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "architect", role: "architect", authority: ["architecture.approve"], interests: [] },
    ],
    mayContact: { dev: ["architect"] },
    mode: "parked",
  });
  try {
    const artifactId = await publish(m, "dev", "design", "ArchitectureDocument", evidenceContent("design"));
    const ask = await m.supervisor.requestApproval(artifactId, "architect");
    assert.equal(ask.accepted, true, ask.reason);
    assert.equal(m.kernel.state.pendingRequests.has(ask.messageId!), true);

    const verdict = await m.supervisor.recordDecision("architect", "approve", "architecture", artifactId, "looks right");
    assert.equal(verdict.ok, true, verdict.reason);
    assert.equal(
      m.kernel.state.pendingRequests.has(ask.messageId!),
      false,
      "the verdict settles the review ask without a separate discharge call",
    );
  } finally {
    await m.cleanup();
  }
});

// --- domainOfSubject: artifact type decides the review domain -----------

test("the review domain is inferred from the artifact type when the subject names none", async () => {
  const m = await makeMesh({
    agents: [
      {
        id: "lead",
        role: "tech-lead",
        capabilities: ["repository.write"],
        authority: [
          "architecture.approve",
          "implementation.approve",
          "quality.approve",
          "security.approve",
          "release.approve",
          "requirements.approve",
        ],
        interests: [],
      },
    ],
    mode: "parked",
  });
  try {
    // Each artifact type routes the verdict to a different authority domain.
    // A subject the classifier does not recognise falls through to the type.
    for (const type of ["ReleasePlan", "TestReport", "SecurityReport", "RequirementsDoc", "ADR"]) {
      const artifactId = await publish(m, "lead", `${type}-doc`, type, evidenceContent(type));
      const res = await m.supervisor.recordDecision("lead", "approve", "some-unclassified-subject", artifactId, "ok");
      assert.equal(res.ok, true, `${type}: ${res.reason}`);
    }

    // A type outside the switch keeps whatever subject the caller gave.
    const specId = await publish(m, "lead", "loose-spec", "TaskSpec", evidenceContent("spec"));
    const fallthrough = await m.supervisor.recordDecision("lead", "approve", "architecture", specId, "ok");
    assert.equal(fallthrough.ok, true, fallthrough.reason);
  } finally {
    await m.cleanup();
  }
});

// --- mirrorTransition: status changes that mint further events ----------

test("a release plan mirrors a release.transition on every step and release.accepted at the end", async () => {
  const m = await makeMesh({
    agents: [
      {
        id: "lead",
        role: "tech-lead",
        // QA_VERIFIED needs a verification role or capability; ACCEPTED needs
        // accept-level authority. This one agent holds both so the ladder can
        // be walked in a single parked mesh.
        capabilities: ["repository.write", "repository.merge", "test.execute", "security.review"],
        authority: ["release.approve", "implementation.approve", "quality.approve", "security.approve"],
        interests: [],
      },
    ],
    criteria: [
      { id: "implementation-merged", description: "the work is merged", mandatory: false },
      { id: "ship", description: "the mission artifact exists", mandatory: true },
    ],
    mode: "parked",
  });
  try {
    const artifactId = await publish(m, "lead", "release", "ReleasePlan", evidenceContent("release plan"));
    // The release machine is its own ladder, not the document one.
    for (const to of ["IMPLEMENTED", "QA_VERIFIED", "SECURITY_VERIFIED", "ACCEPTED"]) {
      const res = await m.supervisor.transitionArtifact("lead", artifactId, { to: to as never, comment: "ship it" });
      assert.equal(res.ok, true, `${to}: ${res.reason}`);
    }
    const events = (await m.store.read()).map((e) => e.type);
    assert.ok(events.includes("release.transition"), "each ReleasePlan status change mirrors release.transition");
    assert.ok(events.includes("release.accepted"), "acceptance mirrors release.accepted");
  } finally {
    await m.cleanup();
  }
});

test("approving an api spec records design evidence without a separate approval op", async () => {
  const m = await makeMesh({
    agents: [
      {
        id: "architect",
        role: "architect",
        capabilities: ["repository.write"],
        authority: ["architecture.approve"],
        interests: [],
      },
    ],
    criteria: [
      { id: "architecture-approved", description: "the design is agreed", mandatory: false },
      { id: "ship", description: "the mission artifact exists", mandatory: true },
    ],
    mode: "parked",
  });
  try {
    const artifactId = await publish(m, "architect", "api", "ApiSpec", evidenceContent("api spec"));
    for (const to of ["READY_FOR_REVIEW", "UNDER_REVIEW"]) {
      const res = await m.supervisor.transitionArtifact("architect", artifactId, { to: to as never, comment: "agreed" });
      assert.equal(res.ok, true, `${to}: ${res.reason}`);
    }
    // APPROVED is not hand-driven: the gate wants a recorded approval, and the
    // verdict itself carries the artifact into APPROVED.
    const verdict = await m.supervisor.recordDecision("architect", "approve", "architecture", artifactId, "agreed");
    assert.equal(verdict.ok, true, verdict.reason);
    assert.equal(m.kernel.state.artifacts.get(artifactId)!.status, "APPROVED");
    const goal = m.kernel.state.goals.get(m.kernel.state.activeGoalId!)!;
    const criterion = goal.acceptanceCriteria.find((c) => c.id === "architecture-approved")!;
    assert.notEqual(criterion.status, "UNSATISFIED", "an APPROVED design doc is evidence for the design criterion");
  } finally {
    await m.cleanup();
  }
});

test("an approval closes document artifacts on the machine's edge, not a type whitelist", async () => {
  const m = await makeMesh({
    agents: [
      {
        id: "pm",
        role: "product-manager",
        capabilities: ["repository.write"],
        authority: ["requirements.approve"],
        interests: [],
      },
    ],
    criteria: [{ id: "ship", description: "the requirements doc exists", mandatory: true }],
    mode: "parked",
  });
  try {
    const artifactId = await publish(m, "pm", "requirements", "RequirementsDoc", evidenceContent("requirements"));
    const ready = await m.supervisor.transitionArtifact("pm", artifactId, { to: "READY_FOR_REVIEW" });
    assert.equal(ready.ok, true, ready.reason);
    const verdict = await m.supervisor.recordDecision("pm", "approve", "requirements", artifactId, "approved");
    assert.equal(verdict.ok, true, verdict.reason);
    assert.equal(
      m.kernel.state.artifacts.get(artifactId)!.status,
      "FINAL",
      "a document approved from READY_FOR_REVIEW lands FINAL instead of staying open",
    );
  } finally {
    await m.cleanup();
  }
});

test("a criterion acceptance makes the inferred document transition visible in the log", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", interests: [] },
      { id: "po", role: "product-owner", authority: ["requirements.accept"], interests: [] },
    ],
    criteria: [{ id: "ship", description: "the deliverable exists", mandatory: true }],
    mode: "parked",
  });
  try {
    const artifactId = await publish(m, "dev", "report", "TestReport", evidenceContent("mission report"));
    const ready = await m.supervisor.transitionArtifact("dev", artifactId, { to: "READY_FOR_REVIEW" });
    assert.equal(ready.ok, true, ready.reason);
    const accepted = await m.supervisor.recordDecision("po", "accept", "criterion:ship", artifactId, "reviewed");
    assert.equal(accepted.ok, true, accepted.reason);
    assert.equal(m.kernel.state.artifacts.get(artifactId)!.status, "FINAL");

    // The projection inferred the FINAL promotion; the log must say so too, or
    // every reader that rebuilds status from events (digest-run.py,
    // compare-runs.py, SSE consumers) sees a document stuck in review.
    const final = (await m.store.read({ types: ["artifact.transition"] })).find(
      (e) => (e.payload as { artifactId?: string; to?: string }).artifactId === artifactId
        && (e.payload as { to?: string }).to === "FINAL",
    );
    assert.ok(final, "accepting a criterion must leave a derived artifact.transition to FINAL in the log");
    assert.equal((final!.payload as { derived?: boolean }).derived, true);
  } finally {
    await m.cleanup();
  }
});

test("a refused BLOCK still leaves the inferred rejection visible in the log", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", interests: [] },
      { id: "qa", role: "qa", authority: ["quality.block"], interests: [] },
    ],
    // qa may not contact the developer, so the BLOCK message is refused and
    // `recordDecision` falls back to the `review.rejected` verdict.
    mayContact: { dev: ["qa"], qa: [] },
    mode: "parked",
  });
  try {
    const artifactId = await publish(m, "dev", "patch", "CodePatch", evidenceContent("patch"));
    const asked = await m.supervisor.sendMessage({
      from: "dev",
      to: ["qa"],
      type: "REQUEST_REVIEW",
      newThread: { subject: "review patch" },
      artifactRefs: [{ uri: "artifact://CodePatch/patch/1" }],
      payload: { question: "review this" },
    });
    assert.equal(asked.accepted, true, asked.reason);
    assert.equal(m.kernel.state.artifacts.get(artifactId)!.status, "UNDER_REVIEW");

    const blocked = await m.supervisor.recordDecision("qa", "block", "quality", artifactId, "failing replay test");
    assert.equal(blocked.ok, false, "a refused block reports the refusal");
    assert.equal(m.kernel.state.artifacts.get(artifactId)!.status, "REJECTED");

    const events = await m.store.read({ types: ["review.rejected", "artifact.transition"] });
    const rejection = events.find(
      (e) => e.type === "review.rejected" && (e.payload as { artifactId?: string }).artifactId === artifactId,
    );
    assert.ok(rejection, "the refused block must still be recorded as a verdict");
    // The projection inferred UNDER_REVIEW -> REJECTED; the log must say so
    // too, or event-stream readers never see the artifact leave review.
    const audited = events.find(
      (e) =>
        e.type === "artifact.transition"
        && (e.payload as { artifactId?: string }).artifactId === artifactId
        && (e.payload as { to?: string }).to === "REJECTED"
        && (e.payload as { derived?: boolean }).derived === true,
    );
    assert.ok(audited, "the inferred rejection must leave a derived artifact.transition in the log");
  } finally {
    await m.cleanup();
  }
});

// --- buildDisagreementContent: what an escalation captures --------------
test("an escalation captures the stances that led to it as a disagreement record", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "architect", role: "architect", authority: ["architecture.approve"], interests: [] },
      { id: "qa", role: "qa", authority: ["quality.approve"], interests: [] },
    ],
    mayContact: { architect: ["dev", "qa"], qa: ["dev", "architect"], dev: ["architect", "qa"] },
    mode: "parked",
  });
  try {
    const artifactId = await publish(m, "dev", "design", "ArchitectureDocument", evidenceContent("design"));
    const artifact = m.kernel.state.artifacts.get(artifactId)!;
    const uri = `artifact://ArchitectureDocument/design@v${artifact.version}`;

    for (const [from, type] of [["architect", "REJECT"], ["qa", "CHALLENGE"], ["dev", "APPROVE"]] as const) {
      const sent = await m.supervisor.sendMessage({
        from,
        to: from === "dev" ? ["architect"] : ["dev"],
        type,
        newThread: { subject: `${type} design` },
        artifactRefs: [{ uri }],
        payload: { reason: `${from} says ${type}` },
      });
      assert.equal(sent.accepted, true, `${from} ${type}: ${sent.reason}`);
    }

    const esc = await m.supervisor.escalate({
      reason: "design_deadlock",
      raisedBy: "architect",
      artifactId,
      participants: ["architect", "qa", "dev"],
    });
    assert.ok(esc.id);

    // The stances are stored as an artifact so an operator can see who said
    // what without replaying the log.
    const records = [...m.kernel.state.artifacts.values()].filter((a) => a.type === "DisagreementRecord");
    assert.equal(records.length, 1, "the escalation mints exactly one disagreement record");
    const body = JSON.parse(await m.supervisor.deps.content.read(records[0]!.contentRef)) as {
      reason: string;
      positions: Array<{ agent: string; stance: string }>;
      remainingDisagreement: string[];
    };
    assert.equal(body.reason, "design_deadlock");
    assert.deepEqual(body.positions.map((p) => p.agent).sort(), ["architect", "dev", "qa"]);
    // Only the opposing stances are unresolved; the approval is not.
    assert.deepEqual([...body.remainingDisagreement].sort(), ["architect", "qa"]);
  } finally {
    await m.cleanup();
  }
});

// --- opDelegate: capability matching before a task is minted ------------

test("delegating to an agent that lacks a required capability mints no task", async () => {
  const m = await makeMesh({
    agents: [
      { id: "lead", role: "tech-lead", interests: [] },
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
    ],
    mayContact: { lead: ["dev"] },
    mode: "parked",
  });
  try {
    const before = m.kernel.state.tasks.size;
    const res = await m.supervisor.executeOp(
      "lead",
      {
        op: "delegate",
        to: "dev",
        title: "run the pen test",
        description: "security sweep",
        requiredCapabilities: ["security.scan", "repository.write"],
      } as MeshOp,
      fakeTurn("lead"),
    );
    assert.equal(res.ok, false);
    assert.match(res.reason!, /dev lacks required capabilities security\.scan/);
    assert.equal(m.kernel.state.tasks.size, before, "no task exists for a delegation that cannot be honoured");
  } finally {
    await m.cleanup();
  }
});

test("delegation to a capable agent mints a task and mails it", async () => {
  const m = await makeMesh({
    agents: [
      { id: "lead", role: "tech-lead", interests: [] },
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
    ],
    mayContact: { lead: ["dev"] },
    mode: "parked",
  });
  try {
    const turn = countingTurn("lead");
    const res = await m.supervisor.executeOp(
      "lead",
      { op: "delegate", to: "dev", title: "build it", description: "the work", requiredCapabilities: ["repository.write"] } as MeshOp,
      turn as never,
    );
    assert.equal(res.ok, true, res.reason);
    assert.equal(turn.sentOps, 1);
    assert.equal(m.kernel.state.tasks.get(res.taskId!)!.title, "build it");
    const mail = [...m.kernel.state.messages.values()].find((msg) => msg.type === "DELEGATE");
    assert.ok(mail, "the delegate is mailed, not just recorded");
    assert.deepEqual(mail!.to, ["dev"]);
  } finally {
    await m.cleanup();
  }
});

test("delegating to an agent the mesh does not have is refused", async () => {
  const m = await makeMesh({
    agents: [{ id: "lead", role: "tech-lead", interests: [] }],
    mode: "parked",
  });
  try {
    const res = await m.supervisor.executeOp(
      "lead",
      { op: "delegate", to: "ghost", title: "x", description: "y" } as MeshOp,
      fakeTurn("lead"),
    );
    assert.equal(res.ok, false);
    assert.equal(res.reason, "unknown target ghost");
  } finally {
    await m.cleanup();
  }
});

// --- opSpawnWorker: the delegation policy wall --------------------------

test("an agent whose delegation policy forbids workers cannot spawn one", async () => {
  const m = await makeMesh({
    agents: [{ id: "lead", role: "tech-lead", interests: [] }],
    mode: "parked",
  });
  try {
    const res = await m.supervisor.executeOp(
      "lead",
      { op: "spawn_worker", title: "sub task", taskSpec: "do the thing" } as MeshOp,
      fakeTurn("lead"),
    );
    assert.equal(res.ok, false);
    assert.match(res.reason!, /delegation policy forbids worker spawning/);
    // The refusal is recorded, not silent.
    const events = await m.store.read();
    assert.ok(
      events.some((e) => e.type === "message.rejected" && (e.payload as { denied?: boolean }).denied === true),
      "the refusal lands on the log as a denial",
    );
  } finally {
    await m.cleanup();
  }
});

test("an unknown actor cannot spawn a worker", async () => {
  const m = await makeMesh({
    agents: [{ id: "lead", role: "tech-lead", interests: [] }],
    mode: "parked",
  });
  try {
    const res = await m.supervisor.executeOp(
      "ghost",
      { op: "spawn_worker", title: "sub task", taskSpec: "do the thing" } as MeshOp,
      fakeTurn("ghost"),
    );
    assert.equal(res.ok, false);
    assert.equal(res.reason, "unknown actor");
  } finally {
    await m.cleanup();
  }
});

test("the worker cap is per parent and refuses the spawn past it", async () => {
  const m = await makeMesh({
    agents: [{ id: "lead", role: "tech-lead", interests: [], delegation: { allow: true, max_depth: 2, max_workers: 1 } }],
    mode: "parked",
  });
  try {
    const first = await m.supervisor.executeOp("lead", { op: "spawn_worker", title: "a", taskSpec: "a" } as MeshOp, fakeTurn("lead"));
    assert.equal(first.ok, true, first.reason);
    const second = await m.supervisor.executeOp("lead", { op: "spawn_worker", title: "b", taskSpec: "b" } as MeshOp, fakeTurn("lead"));
    assert.equal(second.ok, false);
    assert.match(second.reason!, /max concurrent workers \(1\) reached/);
  } finally {
    await m.cleanup();
  }
});

// --- deliverWorkerResult: the worker's outcome reaches the parent -------

test("a worker's submitted result becomes an artifact, is handed to the parent, and retires the worker", async () => {
  const m = await makeMesh({
    agents: [{ id: "lead", role: "tech-lead", interests: [], delegation: { allow: true, max_depth: 2, max_workers: 2 } }],
    mode: "parked",
  });
  try {
    const spawn = await m.supervisor.executeOp(
      "lead",
      { op: "spawn_worker", title: "sub task", taskSpec: "do the thing" } as MeshOp,
      fakeTurn("lead"),
    );
    assert.equal(spawn.ok, true, spawn.reason);
    const workerId = spawn.reason!;
    const taskId = spawn.taskId!;
    assert.equal(m.kernel.state.agents.has(workerId), true);

    // On a parked mesh the worker never gets pumped, so it sits in STARTING.
    // Retirement is IDLE -> COMPLETED, so settle it the way a real first turn
    // would before submitting.
    await m.kernel.emit("agent.state_changed", { agentId: workerId, to: "IDLE" }, { actorId: workerId });

    const res = await m.supervisor.executeOp(
      workerId,
      { op: "submit_result", taskId, result: workerResult("did the thing") } as MeshOp,
      fakeTurn(workerId),
    );
    assert.equal(res.ok, true, res.reason);

    // The outcome is preserved as an artifact, not only as a message.
    const record = [...m.kernel.state.artifacts.values()].find((a) => a.name.startsWith("worker-result-"));
    assert.ok(record, "the worker result is captured as an artifact");
    assert.equal(record!.type, "Decision");

    // The parent is mailed a HANDOFF carrying it.
    const handoff = [...m.kernel.state.messages.values()].find((msg) => msg.type === "HANDOFF" && msg.from === workerId);
    assert.ok(handoff, "the parent receives the handoff");
    assert.deepEqual(handoff!.to, ["lead"]);
    assert.equal(handoff!.taskId, taskId);

    // And the worker is retired: a finished worker must not stay activatable.
    const events = (await m.store.read()).map((e) => e.type);
    assert.ok(events.includes("agent.completed"), "the worker is marked completed");
  } finally {
    await m.cleanup();
  }
});

test("only the worker that owns a task may submit its result", async () => {
  const m = await makeMesh({
    agents: [{ id: "lead", role: "tech-lead", interests: [], delegation: { allow: true, max_depth: 2, max_workers: 2 } }],
    mode: "parked",
  });
  try {
    const spawn = await m.supervisor.executeOp(
      "lead",
      { op: "spawn_worker", title: "sub task", taskSpec: "do the thing" } as MeshOp,
      fakeTurn("lead"),
    );
    const workerId = spawn.reason!;

    const wrongTask = await m.supervisor.executeOp(
      workerId,
      { op: "submit_result", taskId: "task-not-mine", result: workerResult("x") } as MeshOp,
      fakeTurn(workerId),
    );
    assert.equal(wrongTask.ok, false);
    assert.match(wrongTask.reason!, /only spawned workers may submit results/);

    const notAWorker = await m.supervisor.executeOp(
      "lead",
      { op: "submit_result", taskId: spawn.taskId!, result: workerResult("x") } as MeshOp,
      fakeTurn("lead"),
    );
    assert.equal(notAWorker.ok, false);
    assert.match(notAWorker.reason!, /only spawned workers may submit results/);
  } finally {
    await m.cleanup();
  }
});

// --- opAcquireLease: who may hold the write lock ------------------------

test("acquiring a lease on an artifact the caller does not own is refused", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "dev2", role: "developer", capabilities: ["repository.write"], interests: [] },
    ],
    mode: "parked",
  });
  try {
    const artifactId = await publish(m, "dev", "patch", "CodePatch", evidenceContent("patch"));
    const res = await m.supervisor.executeOp(
      "dev2",
      { op: "acquire_lease", artifactId, files: ["src/a.ts"] } as MeshOp,
      fakeTurn("dev2"),
    );
    assert.equal(res.ok, false);
    assert.match(res.reason!, /only the artifact owner may write \(dev\)/);
  } finally {
    await m.cleanup();
  }
});

test("acquiring a lease without repository.write is denied and recorded", async () => {
  const m = await makeMesh({
    agents: [{ id: "qa", role: "qa", interests: [] }],
    mode: "parked",
  });
  try {
    const artifactId = await publish(m, "qa", "notes", "TestReport", evidenceContent("notes"));
    const res = await m.supervisor.executeOp(
      "qa",
      { op: "acquire_lease", artifactId, files: ["src/a.ts"] } as MeshOp,
      fakeTurn("qa"),
    );
    assert.equal(res.ok, false);
    const events = await m.store.read();
    assert.ok(
      events.some((e) => e.type === "message.rejected" && (e.payload as { denied?: boolean }).denied === true),
      "the denial is on the log",
    );
  } finally {
    await m.cleanup();
  }
});

test("re-acquiring a lease the caller already holds returns the same lease", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] }],
    mode: "parked",
  });
  try {
    const artifactId = await publish(m, "dev", "patch", "CodePatch", evidenceContent("patch"));
    const first = await m.supervisor.executeOp("dev", { op: "acquire_lease", artifactId, files: ["src/a.ts"] } as MeshOp, fakeTurn("dev"));
    assert.equal(first.ok, true, first.reason);
    const second = await m.supervisor.executeOp("dev", { op: "acquire_lease", artifactId, files: ["src/b.ts"] } as MeshOp, fakeTurn("dev"));
    assert.equal(second.ok, true, second.reason);
    assert.equal(second.reason, first.reason, "the live lease is reused rather than a second one minted");
    assert.equal(m.kernel.state.leases.size, 1);
  } finally {
    await m.cleanup();
  }
});

test("a lease records the worktree the workspace handed out", async () => {
  const m = await makeMesh({
    agents: [{ id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] }],
    mode: "parked",
  });
  const saved = m.supervisor.deps.workspace;
  try {
    m.supervisor.deps.workspace = {
      ensureWorktree: async (agentId: string) => `/tmp/worktree-${agentId}`,
      commitWorktree: async () => ({ commit: "abc1234", diffDigest: "sha256:fake", diff: "" }),
      mergeWorktree: async () => ({ commit: "abc1234" }),
    } as never;
    const artifactId = await publish(m, "dev", "patch", "CodePatch", evidenceContent("patch"));
    const res = await m.supervisor.executeOp("dev", { op: "acquire_lease", artifactId, files: ["src/a.ts"] } as MeshOp, fakeTurn("dev"));
    assert.equal(res.ok, true, res.reason);
    assert.equal(m.kernel.state.leases.get(res.reason!)!.worktreePath, "/tmp/worktree-dev");
  } finally {
    m.supervisor.deps.workspace = saved;
    await m.cleanup();
  }
});

// --- respondEscalation --------------------------------------------------

test("an escalation id the mesh has never seen cannot be answered", async () => {
  const m = await makeMesh({
    agents: [{ id: "architect", role: "architect", interests: [] }],
    mode: "parked",
  });
  try {
    const res = await m.supervisor.respondEscalation("esc-nope", "answer");
    assert.equal(res.ok, false);
    assert.equal(res.reason, "unknown escalation");
  } finally {
    await m.cleanup();
  }
});

// --- adjustGoalBudget: a raise must actually raise ----------------------

test("a wall-clock raise below the current cap is refused, above it is applied", async () => {
  const m = await makeMesh({
    agents: [{ id: "architect", role: "architect", interests: [] }],
    wallClockMinutes: 60,
    mode: "parked",
  });
  try {
    const lower = await m.supervisor.adjustGoalBudget({ wallClockMinutes: 30 });
    assert.equal(lower.ok, false);
    assert.match(lower.reason!, /wallClockMinutes must exceed the current cap \(60\)/);

    const higher = await m.supervisor.adjustGoalBudget({ wallClockMinutes: 120 });
    assert.equal(higher.ok, true, higher.reason);
    assert.equal(m.kernel.state.goals.get(m.kernel.state.activeGoalId!)!.budget.wallClockMinutes, 120);
  } finally {
    await m.cleanup();
  }
});

// --- agentWorkspace: a worktree only for agents that can write ----------

test("only an agent with repository.write gets its own worktree", async () => {
  const m = await makeMesh({
    agents: [
      { id: "dev", role: "developer", capabilities: ["repository.write"], interests: [] },
      { id: "qa", role: "qa", interests: [] },
    ],
    mode: "parked",
  });
  const saved = m.supervisor.deps.workspace;
  try {
    m.supervisor.deps.workspace = {
      ensureWorktree: async (agentId: string) => `/tmp/worktree-${agentId}`,
      commitWorktree: async () => ({ commit: "abc1234", diffDigest: "sha256:fake", diff: "" }),
      mergeWorktree: async () => ({ commit: "abc1234" }),
    } as never;
    assert.equal(await m.supervisor.agentWorkspace("dev"), "/tmp/worktree-dev");
    // A read-only agent shares the mesh workspace: no branch of its own.
    assert.notEqual(await m.supervisor.agentWorkspace("qa"), "/tmp/worktree-qa");
  } finally {
    m.supervisor.deps.workspace = saved;
    await m.cleanup();
  }
});
