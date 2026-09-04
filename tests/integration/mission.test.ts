import { test } from "node:test";
import assert from "node:assert/strict";
import { makeMesh, stub, waitFor, goalOf } from "../helpers";
import type { MeshOp } from "../../packages/protocol/src/index";

const MISSION_AGENTS = [
  { id: "pm", role: "product-manager", authority: ["requirements.accept"], interests: ["goal.progress", "release.candidate", "goal.completed"], capabilities: ["repository.read"] },
  { id: "architect", role: "architect", authority: ["architecture.approve"], interests: ["architecture.*", "design.question", "requirements.created", "research.completed", "implementation.completed"], capabilities: ["repository.read", "architecture.write", "review.design"] },
  { id: "tech-lead", role: "tech-lead", authority: ["implementation.approve"], interests: ["patch.ready", "implementation.completed", "architecture.approved"], capabilities: ["code.review", "review.design", "git.merge", "task.assign"] },
  { id: "developer", role: "developer", interests: ["architecture.approved", "review.rejected"], capabilities: ["repository.write", "test.execute", "git.commit"] },
  { id: "qa", role: "qa", authority: ["quality.block"], interests: ["patch.ready", "release.candidate"], capabilities: ["test.write", "test.execute"] },
  { id: "security", role: "security", authority: ["security.block"], interests: ["release.candidate", "dependency.changed"], capabilities: ["security.scan", "security.review"] },
  { id: "explorer", role: "explorer", mode: "service" as const, interests: ["research.requested"], capabilities: ["repository.read"] },
];

const COMM = {
  pm: ["architect", "tech-lead", "developer", "qa", "security"],
  architect: ["developer", "tech-lead", "explorer", "pm"],
  "tech-lead": ["architect", "developer", "qa", "security", "pm", "explorer"],
  developer: ["architect", "tech-lead", "explorer", "qa", "security"],
  qa: ["developer", "tech-lead", "architect", "security"],
  security: ["developer", "tech-lead", "qa", "architect", "pm"],
  explorer: ["architect", "tech-lead", "developer", "qa", "security", "pm"],
};

function patchUri(sim: { patchName: string; patchVersion: number }): string {
  return `artifact://CodePatch/${sim.patchName}/${sim.patchVersion}`;
}

test("integration: the Â§30 mission converges without a predefined workflow", async () => {
  const m = await makeMesh({
    agents: MISSION_AGENTS,
    mayContact: COMM,
    startup: ["pm", "architect"],
    transitions: {
      "implementation.completed": ["tech-lead.approve", "qa.pass"],
      "release.accepted": ["qa.pass", "security.pass"],
      "patch.merge": ["tech-lead.approve"],
    },
    criteria: [
      { id: "requirements-documented", description: "requirements", mandatory: true },
      { id: "architecture-approved", description: "architecture", mandatory: true },
      { id: "implementation-merged", description: "merge", mandatory: true },
      { id: "quality-verified", description: "qa", mandatory: true },
      { id: "security-verified", description: "sec", mandatory: true },
    ],
    goal: "Build a production-ready payment API using Spring Boot.",
  });
  const s = stub(m);
  const sim = { patchName: "payment-core-patch", patchVersion: 0, qaFailures: 1, secFailures: 0, releaseReviewed: false, qaRelease: false, secRelease: false, secScans: 0, qaRounds2: 0 };
  const board: Array<{ id: string; type: string; name: string; version: number; status: string }> = [];
  m.kernel.subscribe((e) => {
    if (e.type === "artifact.created" || e.type === "artifact.versioned") {
      const a = (e.payload as { artifact: { id: string; type: string; name: string; version: number; status: string } }).artifact;
      if (a && !board.find((b) => b.id === a.id)) board.push(a);
      if (a) {
        const b = board.find((x) => x.id === a.id);
        if (b && a.version > b.version) {
          b.version = a.version;
          b.status = a.status;
        }
      }
    }
    if (e.type === "artifact.transition") {
      const t = e.payload as { artifactId: string; to: string };
      const b = board.find((x) => x.id === t.artifactId);
      if (b) b.status = t.to;
    }
  });
  const latest = (type: string) => [...board].reverse().find((b) => b.type === type);

  s.setScript("pm", async (_i, turn) => {
    if (turn === 0) {
      return {
        text: "kickoff",
        operations: [
          { op: "publish_artifact", name: "requirements", type: "RequirementsDoc", content: JSON.stringify({ requirements: [{ id: "req-payments-idempotency", text: "idempotent payments", mandatory: true }] }) },
          { op: "send", type: "MISSION", to: ["architect"], newThread: { subject: "kickoff" }, payload: { note: "design the payment API" } },
          { op: "done" },
        ],
      };
    }
    const goal = m.kernel.state.goals.get(m.kernel.state.activeGoalId ?? "");
    const merged = latest("CodePatch")?.status;
    const release = latest("ReleasePlan");
    const ops: MeshOp[] = [];
    if (release && !sim.releaseReviewed) {
      sim.releaseReviewed = true;
      ops.push(
        { op: "send", type: "REQUEST_REVIEW", to: ["qa"], newThread: { subject: "release regression please" }, payload: { question: "release regression please", releaseId: release.id } },
        { op: "send", type: "REQUEST_REVIEW", to: ["security"], newThread: { subject: "release scan please" }, payload: { question: "release scan please", releaseId: release.id } },
      );
      ops.push({ op: "wait" });
      return { text: "release review requested", operations: ops };
    }
    const qaRelease = _i.context.unreadMail.some((x) => x.type === "TEST_RESULT" && (x.payload as { result?: string })?.result === "PASSED");
    const secRelease = _i.context.unreadMail.some((x) => x.type === "SECURITY_FINDING" && (x.payload as { result?: string })?.result === "PASSED");
    if (qaRelease) sim.qaRelease = true;
    if (secRelease) sim.secRelease = true;
    if (release && merged === "MERGED" && sim.qaRelease && sim.secRelease) {
      const id = release.id;
      ops.push(
        { op: "transition_artifact", artifactId: id, to: "IMPLEMENTED" },
        { op: "transition_artifact", artifactId: id, to: "QA_VERIFIED" },
        { op: "transition_artifact", artifactId: id, to: "SECURITY_VERIFIED" },
        { op: "transition_artifact", artifactId: id, to: "ACCEPTED" },
      );
    }
    if (release && merged === "MERGED" && (goal?.acceptanceCriteria.find((c) => c.id === "requirements-documented")?.status ?? "UNSATISFIED") === "UNSATISFIED") {
      const reqDoc = latest("RequirementsDoc");
      const patch = latest("CodePatch");
      const trep = latest("TestReport");
      const srep = latest("SecurityReport");
      const arch = latest("ArchitectureDocument");
      ops.push(
        { op: "approve", subject: "criterion:requirements-documented", artifactId: reqDoc?.id, comment: "doc accepted" },
        { op: "approve", subject: "criterion:architecture-approved", artifactId: arch?.id, comment: "approved trail" },
        { op: "approve", subject: "criterion:implementation-merged", artifactId: patch?.id, comment: "merged" },
        { op: "approve", subject: "criterion:quality-verified", artifactId: trep?.id, comment: "tests green" },
        { op: "approve", subject: "criterion:security-verified", artifactId: srep?.id, comment: "scan clean" },
        { op: "approve", subject: "criterion:req-payments-idempotency", artifactId: patch?.id, comment: "idempotent pipeline merged" },
      );
    }
    ops.push({ op: "done" });
    return { text: "pm pass", operations: ops };
  });

  s.setScript("architect", async (input) => {
    const mission = input.context.unreadMail.find((x) => x.type === "MISSION");
    const researchDone = input.context.unreadMail.find((x) => x.type === "INFORM" && x.artifactRefs.some((r) => r.uri.includes("ResearchReport")));
    if (researchDone) {
      const arch = latest("ArchitectureDocument");
      if (!arch) {
        return {
          text: "design",
          operations: [
            { op: "publish_artifact", name: "payment-architecture", type: "ArchitectureDocument", content: "# design\nidempotency via DB" },
            { op: "send", type: "REQUEST_REVIEW", to: ["tech-lead"], newThread: { subject: "review arch" }, artifactRefs: [{ uri: "artifact://ArchitectureDocument/payment-architecture/1" }], payload: { question: "is the idempotency design acceptable?" } },
            { op: "wait" },
          ],
        };
      }
    }
    if (mission) {
      return { text: "ask explorer", operations: [{ op: "request_research", to: "explorer", question: "analyze existing payment service boundaries" }, { op: "wait" }] };
    }
    const impl = input.activation.kind === "interest_event" && input.activation.eventType === "implementation.completed";
    if (impl && !latest("ReleasePlan")) {
      return { text: "propose release", operations: [{ op: "publish_artifact", name: "release-1", type: "ReleasePlan", content: "candidate 1.0.0" }, { op: "done" }] };
    }
    return { text: "idle", operations: [{ op: "done" }] };
  });

  s.setScript("explorer", async (input) => {
    const req = input.context.unreadMail.find((x) => x.type === "REQUEST_RESEARCH");
    if (!req) return { text: "idle", operations: [{ op: "done" }] };
    return {
      text: "report",
      tokensUsed: { input: 300, output: 150, total: 450 },
      operations: [
        {
          op: "publish_artifact",
          name: "boundaries",
          type: "ResearchReport",
          content: `# research\n${(req.payload as { question?: string }).question ?? ""}`,
          metadata: { inReplyTo: req.id, questionHash: "analyze existing payment service boundaries" },
        },
        { op: "done" },
      ],
    };
  });

  s.setScript("tech-lead", async (input) => {
    const mail = input.context.unreadMail;
    const archReview = mail.find((x) => x.type === "REQUEST_REVIEW" && x.artifactRefs.some((r) => r.uri.includes("ArchitectureDocument")));
      if (archReview) {
        const arch = latest("ArchitectureDocument");
        return {
          text: "approve arch",
          operations: [
            { op: "respond", messageId: archReview.id, type: "APPROVE", payload: { verdict: "approved" } },
            ...(arch ? ([{ op: "approve", subject: "architecture", artifactId: arch.id, comment: "sound" }] as MeshOp[]) : []),
            { op: "create_task", title: "implement payment core", description: "build per approved architecture", assignedTo: "developer", requiredCapabilities: ["repository.write"] },
            { op: "done" },
          ],
        };
      }
    const patchReview = mail.find((x) => x.type === "REQUEST_REVIEW" && x.artifactRefs.some((r) => r.uri.includes("CodePatch")));
    if (patchReview) {
      const patch = latest("CodePatch");
      if (patch) {
        return {
          text: "merge",
          operations: [
            { op: "respond", messageId: patchReview.id, type: "APPROVE", payload: { verdict: "approved" } },
            { op: "approve", subject: "implementation", artifactId: patch.id, comment: "code approved" },
            { op: "transition_artifact", artifactId: patch.id, to: "APPROVED" },
            { op: "transition_artifact", artifactId: patch.id, to: "VERIFIED" },
            { op: "transition_artifact", artifactId: patch.id, to: "MERGEABLE" },
            { op: "merge", artifactId: patch.id, comment: "squash" },
            { op: "done" },
          ],
        };
      }
    }
    return { text: "idle", operations: [{ op: "done" }] };
  });

  s.setScript("developer", async (input) => {
    const task = input.context.unreadMail.find((x) => x.type === "DELEGATE" || x.type === "REQUEST_EXECUTION");
    const blocked = input.context.unreadMail.find((x) => x.type === "BLOCK");
    const passed = input.context.unreadMail.find((x) => x.type === "TEST_RESULT" && (x.payload as { result?: string }).result === "PASSED");
    if (task) {
      sim.patchVersion++;
      sim.patchName = `payment-core-patch-${sim.patchVersion}`;
      return {
        text: "write patch",
        operations: [
          { op: "claim_task", taskId: String((task.payload as { taskId?: string }).taskId ?? "") },
          { op: "publish_artifact", name: sim.patchName, type: "CodePatch", content: `diff --git a/Payment.java b/Payment.java\n+ idempotency v${sim.patchVersion}` },
          { op: "send", type: "PATCH_READY", to: ["qa"], newThread: { subject: `patch v${sim.patchVersion}` }, artifactRefs: [{ uri: patchUri(sim) }], payload: { summary: "tests pass locally" } },
          { op: "wait" },
        ],
      };
    }
    if (blocked) {
      sim.patchVersion++;
      sim.patchName = `payment-core-patch-${sim.patchVersion}`;
      return {
        text: "rework",
        operations: [
          { op: "publish_artifact", name: sim.patchName, type: "CodePatch", content: `diff --git a/Payment.java b/Payment.java\n+ rework v${sim.patchVersion}` },
          { op: "send", type: "PATCH_READY", to: ["qa"], newThread: { subject: `patch v${sim.patchVersion}` }, artifactRefs: [{ uri: patchUri(sim) }], payload: { summary: "addressed block" } },
          { op: "wait" },
        ],
      };
    }
    if (passed && input.context.currentTask) {
      return { text: "done", operations: [{ op: "complete_task", taskId: input.context.currentTask.id, summary: "implemented", artifacts: [{ uri: patchUri(sim) }] }, { op: "done" }] };
    }
    return { text: "idle", operations: [{ op: "done" }] };
  });

  s.setScript("qa", async (input) => {
    const patchReady = input.context.unreadMail.find((x) => x.type === "PATCH_READY");
    if (patchReady) {
      const patch = latest("CodePatch");
      if (sim.qaFailures > 0) {
        sim.qaFailures--;
        return {
          text: "fail",
          operations: [
            { op: "send", type: "TEST_RESULT", to: ["developer"], newThread: { subject: "failure" }, artifactRefs: patch ? [{ uri: `artifact://${patch.type}/${patch.name}/1` }] : [], payload: { result: "FAILED", detail: "replay test fails" } },
            { op: "block", subject: "quality", artifactId: patch?.id, reason: "failing replay test" },
            { op: "done" },
          ],
        };
      }
      return {
        text: "pass",
        operations: [
          { op: "publish_artifact", name: `tests-${patch?.name ?? "x"}`, type: "TestReport", content: "green" },
          { op: "send", type: "TEST_RESULT", to: ["developer", "tech-lead"], newThread: { subject: "pass" }, payload: { result: "PASSED" } },
          { op: "send", type: "REQUEST_REVIEW", to: ["tech-lead"], newThread: { subject: "merge review" }, artifactRefs: patch ? [{ uri: `artifact://${patch.type}/${patch.name}/${patch.version}` }] : [], payload: { question: "approve merge" } },
          { op: "wait" },
        ],
      };
    }
    const ask = input.context.unreadMail.find((x) => x.type === "REQUEST_REVIEW" && String((x.payload as { question?: string })?.question ?? "").includes("release"));
    const release = ask || (input.activation.kind === "interest_event" && input.activation.eventType === "release.candidate");
    if (release) {
      sim.qaRounds2 = (sim.qaRounds2 ?? 0) + 1;
      const dup = sim.qaRounds2 > 1;
      return { text: "release suite", operations: [
        ...(ask ? ([{ op: "respond", messageId: ask.id, type: "TEST_RESULT", payload: { result: "PASSED", subject: "release" } } as MeshOp]) : []),
        ...(dup ? [] : ([{ op: "send", type: "TEST_RESULT", to: ["pm"], newThread: { subject: "release qa" }, payload: { result: "PASSED", subject: "release" } } as MeshOp])),
        { op: "done" },
      ] };
    }
    return { text: "idle", operations: [{ op: "done" }] };
  });

  s.setScript("security", async (input) => {
    const release = input.activation.kind === "interest_event" && input.activation.eventType === "release.candidate";
    const asked = input.context.unreadMail.length > 0;
    if (!release && !asked) return { text: "idle", operations: [{ op: "done" }] };
    if (sim.secFailures > 0) {
      sim.secFailures--;
      return { text: "finding", operations: [{ op: "send", type: "SECURITY_FINDING", to: ["pm", "tech-lead"], newThread: { subject: "finding" }, payload: { result: "FAILED", detail: "scope validation missing" } }, { op: "block", subject: "security", reason: "scope validation missing" }, { op: "done" }] };
    }
    const secAsk = input.context.unreadMail.find((x) => x.type === "REQUEST_REVIEW");
    const firstScan = (sim.secScans ?? 0) <= 1;
    return {
      text: "clean",
      operations: [
        ...(secAsk ? ([{ op: "respond", messageId: secAsk.id, type: "SECURITY_FINDING", payload: { result: "PASSED", subject: "security" } } as MeshOp]) : []),
        ...(firstScan ? ([
          { op: "publish_artifact", name: "security-scan", type: "SecurityReport", content: "no critical findings", metadata: { criticalFindings: 0 } },
          { op: "send", type: "SECURITY_FINDING", to: ["pm"], newThread: { subject: "scan clean" }, payload: { result: "PASSED", subject: "security" } },
        ] as MeshOp[]) : []),
        { op: "done" },
      ],
    };
  });

  await m.supervisor.activateAgent("pm", { kind: "startup" });
  await waitFor("goal completed", () => goalOf(m)?.status === "COMPLETED", 20000);

  const events: string[] = (await m.store.read()).map((e) => e.type as string);
  const at = (t: string) => events.indexOf(t);
  assert.ok(at("requirements.created") < at("message.sent"), "requirements precede downstream traffic");
  assert.ok(at("research.requested") >= 0, "architect consulted explorer");
  assert.ok(at("architecture.approved") > at("research.completed"), "architecture after research");
  assert.ok(at("task.claimed") > at("architecture.approved"), "developer claimed after approval â€” emergent, not scripted");
  assert.ok(at("patch.ready") > at("task.claimed"));
  assert.ok(at("review.rejected") >= 0 || [...m.kernel.state.approvals.keys()].some((k) => k.endsWith("::block")), "first QA block observed");
  assert.ok(at("patch.merged") > at("patch.ready"), "rework followed the block");
  assert.ok(at("implementation.completed") > at("patch.merged"));
  assert.ok(at("release.accepted") > at("implementation.completed"));
  assert.ok(at("goal.completed") > at("release.accepted"));
  assert.equal(m.kernel.state.escalations.size, 0, "no escalations in the happy path");
  const sec = m.kernel.state.agents.get("security")!;
  assert.ok(["IDLE", "WAITING", "COMPLETED"].includes(sec.state.lifecycle), `security settled (${sec.state.lifecycle})`);
  const tokens = m.kernel.state.budgets.get(`mission:${m.kernel.state.activeGoalId}`);
  assert.ok(tokens && tokens.consumed > 0 && tokens.consumed < m.config.budgets.mission.tokens);
  await m.cleanup();
});

test("integration: explorer cache answers repeat research without waking the model (Â§26)", async () => {
  const m = await makeMesh({
    agents: [
      { id: "arch", role: "architect", capabilities: ["repository.read"], interests: [] },
      { id: "explorer", role: "explorer", mode: "service", capabilities: ["repository.read"], interests: ["research.requested"] },
    ],
    mayContact: { arch: ["explorer"], explorer: ["arch"] },
  });
  const s = stub(m);
  let explorerRuns = 0;
  s.setScript("explorer", async (input) => {
    explorerRuns++;
    const req = input.context.unreadMail[0];
    return {
      operations: [
        {
          op: "publish_artifact",
          name: "boundaries",
          type: "ResearchReport",
          content: "answer",
          metadata: { inReplyTo: req?.id, questionHash: "same question" },
        },
        { op: "done" },
      ],
    };
  });
  await m.supervisor.sendMessage({ from: "arch", to: ["explorer"], type: "REQUEST_RESEARCH", newThread: { subject: "q" }, payload: { question: "same question" } });
  await waitFor("explorer answered", () => m.kernel.state.artifacts.size === 1, 8000);
  await m.supervisor.sendMessage({ from: "arch", to: ["explorer"], type: "REQUEST_RESEARCH", newThread: { subject: "q2" }, payload: { question: "same question" } });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(explorerRuns, 1, "second identical request must be served from cache");
  const replies = [...m.kernel.state.messages.values()].filter((x) => x.type === "INFORM" && x.to.includes("arch"));
  assert.ok(replies.length >= 2, "architect got an answer both times");
  await m.cleanup();
});
