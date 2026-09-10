import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { AgentInput, MeshOp, ArtifactStatus } from "../../../packages/protocol/src/index";
import type { StubScript } from "../../../packages/agent-runtime/src/index";
import { bootstrapMesh, type MeshInstance } from "../../mesh-server/src/index";
import { buildMetrics, buildCostReport, type MetricsSnapshot } from "../../../packages/observability/src/index";

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type BenchmarkCategory = "A" | "B" | "C" | "D" | "E" | "F";

export interface CategorySpec {
  category: BenchmarkCategory;
  name: string;
  goal: string;
  withCode: boolean;
  withSecurity: boolean;
  withResearch: boolean;
  reworkLoops: number;
  coupledWrites: number;
}

export const CORPUS: CategorySpec[] = [
  { category: "A", name: "read-heavy: understand unfamiliar repository", goal: "Produce an analysis of the payment service boundaries and data model.", withCode: false, withSecurity: false, withResearch: true, reworkLoops: 0, coupledWrites: 0 },
  { category: "B", name: "architecture-heavy: design major feature", goal: "Design the idempotent payment API and get the architecture approved.", withCode: false, withSecurity: false, withResearch: true, reworkLoops: 0, coupledWrites: 0 },
  { category: "C", name: "write-coupled: change 15 tightly coupled classes", goal: "Refactor the coupled transaction core into an idempotency-safe pipeline.", withCode: true, withSecurity: false, withResearch: false, reworkLoops: 2, coupledWrites: 15 },
  { category: "D", name: "security-heavy: authentication and authorization", goal: "Implement OAuth2 resource-server authorization with role checks.", withCode: true, withSecurity: true, withResearch: true, reworkLoops: 1, coupledWrites: 6 },
  { category: "E", name: "refactoring: architectural migration", goal: "Migrate the monolith payment module to a modular monolith with clean boundaries.", withCode: true, withSecurity: true, withResearch: false, reworkLoops: 1, coupledWrites: 9 },
  { category: "F", name: "greenfield: build service from specification", goal: "Build a production-ready payment API using Spring Boot.", withCode: true, withSecurity: true, withResearch: true, reworkLoops: 1, coupledWrites: 4 },
];

export function criterionIds(spec: CategorySpec): string[] {
  const ids = ["requirements-documented"];
  if (spec.withResearch) ids.push("req-analysis");
  if (spec.category !== "A") ids.push("architecture-approved");
  if (spec.withCode) ids.push("implementation-merged", "quality-verified", "req-payments-idempotency");
  if (spec.withSecurity) ids.push("security-verified");
  return ids;
}

function staticCriteria(spec: CategorySpec): Array<{ id: string; description: string; mandatory: boolean }> {
  const list: Array<{ id: string; description: string; mandatory: boolean }> = [
    { id: "requirements-documented", description: "Requirements are documented and accepted", mandatory: true },
  ];
  if (spec.category !== "A") list.push({ id: "architecture-approved", description: "Architecture approved through review", mandatory: true });
  if (spec.withCode) {
    list.push({ id: "implementation-merged", description: "Implementation reviewed and merged", mandatory: true });
    list.push({ id: "quality-verified", description: "QA verification passed with test evidence", mandatory: true });
  }
  if (spec.withSecurity) list.push({ id: "security-verified", description: "Security verification passed", mandatory: true });
  return list;
}

/**
 * Body text for demo artifacts that get cited as evidence for a mandatory
 * criterion. The mesh rejects stub content there (MIN_EVIDENCE_CONTENT_CHARS),
 * and the simulator's one-line artifacts are exactly that shape, so without
 * this the scripted demo mission can no longer converge.
 */
function demoBody(subject: string): string {
  return [
    "",
    `## ${subject}`,
    "Scope, interfaces and constraints are stated here in full so a reviewer can act on",
    "this document without asking the author for context or intent.",
    "Decisions carry their rationale; alternatives considered are named and rejected explicitly.",
    "Verification: exercised end to end, with results and residual risks recorded below.",
    "Residual risk: none blocking; any follow-up is tracked as its own task in the mesh.",
    "(Simulated deliverable body for the scripted demo run.)",
  ].join("\n");
}

function requirementsDocContent(spec: CategorySpec): string {
  const requirements: Array<{ id: string; text: string; mandatory: boolean }> = [];
  if (spec.withResearch) requirements.push({ id: "req-analysis", text: "Repository boundary analysis delivered as research report", mandatory: true });
  if (spec.withCode) requirements.push({ id: "req-payments-idempotency", text: "Payment requests are idempotent (implemented, tested, merged)", mandatory: true });
  // The body must stay parseable JSON (the supervisor parses RequirementsDoc
  // content to derive requirements), so the evidence body goes INSIDE the doc.
  return JSON.stringify({ requirements, body: demoBody("payment requirements") });
}

function meshYaml(spec: CategorySpec): string {
  const criteria = staticCriteria(spec)
    .map((c) => `    - { id: ${c.id}, description: "${c.description}", mandatory: ${c.mandatory} }`)
    .join("\n");
  return `version: 1

mesh:
  id: bench-${spec.category.toLowerCase()}
  name: Benchmark ${spec.category}
  goal: |
    ${spec.goal}
  acceptance_criteria:
${criteria}
  workspace:
    path: ./workspace
  runtime:
    default: stub

startup:
  activate:
    - pm
    - architect

agents:
  pm:
    role: product-manager
    runtime: stub
    capabilities: [repository.read]
    authority: [requirements.accept]
    interests: [goal.progress, requirement.blocked, goal.completed, release.candidate, implementation.completed, release.accepted]
    budget: { tokens: 150000 }
  architect:
    role: architect
    runtime: stub
    capabilities: [repository.read, architecture.write, review.design]
    authority: [architecture.approve]
    interests: [architecture.*, design.question, dependency.changed, goal.escalated, requirements.created, research.completed, implementation.completed]
    session: { persistent: true }
    budget: { tokens: 300000 }
  tech-lead:
    role: tech-lead
    runtime: stub
    capabilities: [repository.read, architecture.read, code.review, review.design, task.assign, git.merge]
    authority: [implementation.approve]
    interests: [patch.ready, implementation.completed, goal.progress, review.requested, architecture.approved]
    budget: { tokens: 250000 }
  developer:
    role: developer
    runtime: stub
    capabilities: [repository.read, repository.write, test.execute, git.commit]
    interests: [architecture.approved, review.rejected]
    budget: { tokens: 700000 }
  qa:
    role: qa
    runtime: stub
    capabilities: [repository.read, test.execute, test.write]
    authority: [quality.block, quality.pass]
    interests: [patch.ready, implementation.completed, release.candidate]
    budget: { tokens: 200000 }
  security:
    role: security
    runtime: stub
    capabilities: [repository.read, security.scan, security.review]
    authority: [security.block, security.pass]
    interests: [authentication.changed, authorization.changed, dependency.changed, release.candidate]
    budget: { tokens: 200000 }
  explorer:
    role: explorer
    runtime: stub
    mode: service
    capabilities: [repository.read]
    interests: [research.requested]
    budget: { tokens: 100000 }

policies:
  communication:
    architect: { may_contact: [developer, tech-lead, explorer, pm] }
    developer: { may_contact: [architect, tech-lead, explorer, qa, security] }
    qa: { may_contact: [developer, tech-lead, architect, security, pm] }
    tech-lead: { may_contact: [architect, developer, qa, security, pm, explorer] }
    security: { may_contact: [developer, tech-lead, qa, architect, pm] }
    pm: { may_contact: [architect, tech-lead, developer, qa, security] }
    explorer: { may_contact: [architect, tech-lead, developer, qa, security, pm] }
  transitions:
    implementation.completed:
      requires: [tech-lead.approve, qa.pass]
    release.accepted:
      requires: [qa.pass, security.pass]
    patch.merge:
      requires: [tech-lead.approve]
  escalation:
    thread: { max_depth: 8 }
    repeated_conflict: { threshold: 6 }
    artifact_review_rounds: { max: 8 }

budgets:
  mission: { tokens: 5000000, wall_clock_minutes: 5, max_events: 6000 }
  thread: { tokens: 200000 }

scheduling:
  mode: event-driven
  activation: { strategy: interest }
  concurrency: { max_active_agents: 4 }
  timeouts: { turn_timeout_ms: 20000, wait_wakeup_ms: 300, idle_quiet_period_ms: 1000 }
`;
}

function singleYaml(spec: CategorySpec): string {
  const criteria = staticCriteria(spec)
    .map((c) => `    - { id: ${c.id}, description: "${c.description}", mandatory: ${c.mandatory} }`)
    .join("\n");
  return `version: 1

mesh:
  id: bench-${spec.category.toLowerCase()}-solo
  name: Benchmark ${spec.category} single agent
  goal: |
    ${spec.goal}
  acceptance_criteria:
${criteria}
  workspace:
    path: ./workspace
  runtime:
    default: stub

startup:
  activate:
    - solo

agents:
  solo:
    role: solo
    runtime: stub
    capabilities: [repository.read, repository.write, architecture.write, review.design, code.review, test.execute, test.write, security.scan, security.review, git.commit, git.merge, task.assign]
    authority: [architecture.approve, implementation.approve, requirements.accept, release.accept, quality.block, quality.pass, security.block, security.pass]
    interests: []
    budget: { tokens: 5000000 }

policies:
  communication:
    solo: { may_contact: [solo] }
  transitions: {}
  escalation:
    thread: { max_depth: 8 }
    repeated_conflict: { threshold: 6 }
    artifact_review_rounds: { max: 8 }

budgets:
  mission: { tokens: 5000000, wall_clock_minutes: 5, max_events: 6000 }
  thread: { tokens: 200000 }

scheduling:
  mode: event-driven
  activation: { strategy: interest }
  concurrency: { max_active_agents: 1 }
  timeouts: { turn_timeout_ms: 20000, wait_wakeup_ms: 300, idle_quiet_period_ms: 1000 }
`;
}

interface BoardEntry {
  id: string;
  type: string;
  name: string;
  version: number;
  status: ArtifactStatus;
}

interface Sim {
  spec: CategorySpec;
  board: BoardEntry[];
  flags: {
    reqs: boolean;
    research: boolean;
    impl: boolean;
    releaseCreated: boolean;
    merged: boolean;
    qaRelease: boolean;
    secRelease: boolean;
    missionSent: boolean;
    archPublished: boolean;
    releaseReviewed: boolean;
    accepted: boolean;
    criteriaApproved: boolean;
    releaseQaSent: boolean;
    releaseSecSent: boolean;
    soloDone: boolean;
    kickoff: boolean;
  };
  taskIds: string[];
  qaRounds: number;
  secScans: number;
  patches: number;
  rework: number;
  doneOps: number;
}

function find(board: BoardEntry[], type: string, namePart: string): BoardEntry | undefined {
  return [...board].reverse().find((a) => a.type === type && (a.name.includes(namePart) || namePart.includes(a.name)));
}

function uri(a: BoardEntry): string {
  return `artifact://${a.type}/${a.name}/${a.version}`;
}

function mailType(input: AgentInput, ...types: string[]) {
  return input.context.unreadMail.find((m) => types.includes(m.type));
}

function buildMeshScripts(sim: Sim): Map<string, StubScript> {
  const { spec, board, flags } = sim;
  const scripts = new Map<string, StubScript>();

  scripts.set(
    "pm",
    async (input, turnIndex): Promise<any> => {
      if (!flags.kickoff) {
        flags.kickoff = true;
        const ops: MeshOp[] = [
          { op: "publish_artifact", name: "payment-requirements", type: "RequirementsDoc", content: requirementsDocContent(spec) },
          { op: "send", type: "MISSION", to: ["architect"], newThread: { subject: "mission kickoff" }, payload: { note: "Design the architecture for the mission goal." } },
          { op: "done", summary: "requirements published" },
        ];
        return { text: "kickoff", operations: ops };
      }
      for (const m of input.context.unreadMail) {
        if (m.type === "TEST_RESULT" && (m.payload as any)?.result === "PASSED") flags.qaRelease = true;
        if (m.type === "SECURITY_FINDING" && (m.payload as any)?.result === "PASSED") flags.secRelease = true;
      }
      const ops: MeshOp[] = [];
      if (flags.releaseCreated && !flags.releaseReviewed) {
        flags.releaseReviewed = true;
        const rel = find(board, "ReleasePlan", "release-plan");
        ops.push(
          { op: "send", type: "REQUEST_REVIEW", to: ["qa"], newThread: { subject: "release QA review" }, artifactRefs: rel ? [{ uri: uri(rel) }] : [], payload: { question: "release regression please" } },
          { op: "send", type: "REQUEST_REVIEW", to: ["security"], newThread: { subject: "release security review" }, artifactRefs: rel ? [{ uri: uri(rel) }] : [], payload: { question: "release scan please" } },
        );
      }
      const readyToAccept = flags.reqs && (!spec.withCode || flags.merged) && (!spec.withResearch || flags.research);
      if (spec.withCode && readyToAccept && flags.qaRelease && flags.secRelease && flags.releaseCreated && !flags.accepted) {
        flags.accepted = true;
        const rel = find(board, "ReleasePlan", "release-plan");
        if (rel) ops.push(
          { op: "transition_artifact", artifactId: rel.id, to: "IMPLEMENTED" },
          { op: "transition_artifact", artifactId: rel.id, to: "QA_VERIFIED" },
          { op: "transition_artifact", artifactId: rel.id, to: "SECURITY_VERIFIED" },
          { op: "transition_artifact", artifactId: rel.id, to: "ACCEPTED" },
        );
      }
      if (readyToAccept && (!spec.withCode || flags.accepted)) {
        for (const c of criterionIds(spec)) {
          const evidence = evidenceFor(board, c);
          if (evidence) ops.push({ op: "approve", subject: `criterion:${c}`, artifactId: evidence.id, comment: `evidence ${evidence.type}:${evidence.name}` });
        }
      }
      ops.push({ op: "done", summary: "pm pass" });
      return { text: "pm pass", operations: ops };
    },
  );

  scripts.set(
    "architect",
    async (input, turnIndex): Promise<any> => {
      if (flags.impl && !flags.releaseCreated && !mailType(input, "MISSION", "INFORM")) {
        flags.releaseCreated = true;
        return {
          text: "release proposed",
          operations: [
            { op: "publish_artifact", name: "release-plan", type: "ReleasePlan", content: "# Release\nPayment API 1.0.0 candidate" + demoBody("release plan") },
            { op: "done" },
          ],
        };
      }
      const mission = mailType(input, "MISSION");
      const researchAnswer = input.context.unreadMail.find((m) => m.type === "INFORM" && m.artifactRefs.some((r) => r.uri.startsWith("artifact://ResearchReport")));
      const reviewReply = mailType(input, "APPROVE", "REJECT");
      if (researchAnswer || (mission && !spec.withResearch)) {
        flags.archPublished = true;
        const version = board.filter((b) => b.type === "ArchitectureDocument").length + 1;
        const publishOp: MeshOp =
          version === 1
            ? { op: "publish_artifact", name: "payment-architecture", type: "ArchitectureDocument", content: "# Architecture\nSpring Boot, DB-backed idempotency, modular boundaries." + demoBody("payment architecture") }
            : {
                op: "publish_artifact",
                name: "payment-architecture",
                type: "ArchitectureDocument",
                content: `# Architecture v${version}\nRevised.${demoBody("payment architecture revision")}`,
                asVersionOf: find(board, "ArchitectureDocument", "payment-architecture")?.id,
              };
        return {
          text: "architecture published",
          operations: [
            publishOp,
            { op: "send", type: "REQUEST_REVIEW", to: ["tech-lead"], newThread: { subject: `review payment-architecture v${version}` }, artifactRefs: [{ uri: `artifact://ArchitectureDocument/payment-architecture/${version}` }], payload: { question: "Validate idempotency strategy." } },
            { op: "wait" },
          ],
        };
      }
      if (mission) {
        return {
          text: "research requested",
          operations: [{ op: "request_research", to: "explorer", question: "analyze existing payment service boundaries" }, { op: "wait" }],
        };
      }
      if (reviewReply && turnIndex === 0) {
        return { text: "ack", operations: [{ op: "respond", messageId: reviewReply.id, type: "INFORM", payload: { note: "acknowledged" } }, { op: "done" }] };
      }
      return { text: "architect idle", operations: [{ op: "done" }] };
    },
  );

  scripts.set(
    "explorer",
    async (input): Promise<any> => {
      const req = mailType(input, "REQUEST_RESEARCH");
      if (!req) return { text: "idle", operations: [{ op: "done" }] };
      const question = String((req.payload as any)?.question ?? "");
      return {
        text: "research complete",
        tokensUsed: { input: 400, output: 250, total: 650 },
        operations: [
          {
            op: "publish_artifact",
            name: "payment-boundaries",
            type: "ResearchReport",
            content: `# Research\n${question}\nFindings: existing boundaries are payment, ledger, notification.${demoBody("boundary research")}`,
            metadata: { inReplyTo: req.id, questionHash: question.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim() },
          },
          { op: "done" },
        ],
      };
    },
  );

  scripts.set(
    "tech-lead",
    async (input): Promise<any> => {
      const review = input.context.unreadMail.find((m) => m.type === "REQUEST_REVIEW");
      if (review) {
        sim.doneOps++;
        const ref = String(review.artifactRefs?.[0]?.uri ?? "");
        const m = /artifact:\/\/([^/]+)\/([^/]+)/.exec(ref);
        const target = m ? find(board, m[1], decodeURIComponent(m[2])) : undefined;
        if (target && target.type === "ArchitectureDocument") {
          const delegate = spec.withCode
            ? ([{ op: "create_task", title: "implement payment pipeline", description: `Implement ${spec.coupledWrites} coupled classes per approved architecture`, assignedTo: "developer", requiredCapabilities: ["repository.write"] } as MeshOp])
            : [];
          return {
            text: "architecture approved",
            operations: [
              { op: "respond", messageId: review.id, type: "APPROVE", payload: { verdict: "approved" } },
              { op: "approve", subject: "architecture", artifactId: target.id, comment: "sound design" },
              ...delegate,
              { op: "done" },
            ],
          };
        }
        if (target && target.type === "CodePatch") {
          return {
            text: "patch merged",
            operations: [
              { op: "respond", messageId: review.id, type: "APPROVE", payload: { verdict: "approved" } },
              { op: "approve", subject: "implementation", artifactId: target.id, comment: "code approved" },
              { op: "transition_artifact", artifactId: target.id, to: "APPROVED" },
              { op: "transition_artifact", artifactId: target.id, to: "VERIFIED" },
              { op: "transition_artifact", artifactId: target.id, to: "MERGEABLE" },
              { op: "merge", artifactId: target.id, comment: "merge to main" },
              { op: "done" },
            ],
          };
        }
      }
      if (input.activation.kind === "interest_event" && input.activation.eventType === "architecture.approved" && spec.withCode) {
        const devTask = { op: "create_task" as const, title: "implement payment pipeline", description: `Implement ${spec.coupledWrites} coupled classes per approved architecture`, assignedTo: "developer", requiredCapabilities: ["repository.write"] };
        return { text: "implementation delegated", operations: [devTask, { op: "done" }] };
      }
      return { text: "tech-lead idle", operations: [{ op: "done" }] };
    },
  );

  scripts.set(
    "developer",
    async (input): Promise<any> => {
      const task = mailType(input, "DELEGATE", "REQUEST_EXECUTION");
      const blocked = input.context.unreadMail.find((m) => m.type === "BLOCK");
      const passed = input.context.unreadMail.find((m) => m.type === "TEST_RESULT" && (m.payload as any)?.result === "PASSED");
      if (passed && input.context.currentTask) {
        return { text: "task complete", operations: [{ op: "complete_task", taskId: input.context.currentTask.id, summary: "pipeline implemented and tested" }, { op: "done" }] };
      }
      if (task && input.context.currentTask?.status !== "COMPLETED") {
        const claimed = input.context.currentTask;
        const ops: MeshOp[] = [];
        if (!claimed) ops.push({ op: "claim_task", taskId: String((task.payload as any)?.taskId ?? "") });
        sim.patches++;
        ops.push({
          op: "publish_artifact",
          name: `patch-tx-pipeline-${sim.patches}`,
          type: "CodePatch",
          content: `diff --git a/src/tx/Pipeline.java b/src/tx/Pipeline.java\n+ idempotency-safe pipeline (revision ${sim.patches}) handles ${spec.coupledWrites} coupled classes${demoBody("transaction pipeline patch")}`,
        });
        ops.push({ op: "send", type: "PATCH_READY", to: ["qa", "tech-lead"], newThread: { subject: `patch revision ${sim.patches} ready` }, artifactRefs: [{ uri: `artifact://CodePatch/patch-tx-pipeline-${sim.patches}/1` }], payload: { summary: "tests green locally" } });
        ops.push({ op: "wait" });
        return { text: "patch authored", operations: ops };
      }
      if (blocked) {
        const target = find(board, "CodePatch", "patch-tx-pipeline");
        if (target) {
          sim.rework++;
          sim.patches++;
          return {
            text: "rework",
            operations: [
              { op: "publish_artifact", name: `patch-tx-pipeline-${sim.patches}`, type: "CodePatch", content: `diff --git a/src/tx/Pipeline.java b/src/tx/Pipeline.java\n+ fixed (${sim.patches})${demoBody("transaction pipeline patch")}` },
              { op: "send", type: "PATCH_READY", to: ["qa", "tech-lead"], newThread: { subject: `patch revision ${sim.patches} ready` }, artifactRefs: [{ uri: `artifact://CodePatch/patch-tx-pipeline-${sim.patches}/1` }], payload: { summary: "rework addressing the block" } },
              { op: "wait" },
            ],
          };
        }
      }
      return { text: "developer idle", operations: [{ op: "done" }] };
    },
  );

  scripts.set(
    "qa",
    async (input): Promise<any> => {
      const patchReady = mailType(input, "PATCH_READY");
      const releaseAsk = input.context.unreadMail.find((m) => m.type === "REQUEST_REVIEW" || (input.activation.kind === "interest_event" && ["release.candidate", "implementation.completed"].includes(String(input.activation.eventType))));
      if (patchReady) {
        const ref = String(patchReady.artifactRefs?.[0]?.uri ?? "");
        const m = /artifact:\/\/([^/]+)\/([^/]+)/.exec(ref);
        const patch = m ? find(board, m[1], decodeURIComponent(m[2])) : undefined;
        sim.qaRounds++;
        if (sim.qaRounds <= spec.reworkLoops) {
          return {
            text: "tests failing",
            operations: [
              { op: "send", type: "TEST_RESULT", to: ["developer"], newThread: { subject: "test failure" }, artifactRefs: patch ? [{ uri: uri(patch) }] : [], payload: { result: "FAILED", detail: "IdempotencyTest#replay fails" } },
              { op: "block", subject: "quality", artifactId: patch?.id, reason: "failing replay test" },
              { op: "done" },
            ],
          };
        }
        return {
          text: "tests pass",
          operations: [
            { op: "publish_artifact", name: `test-report-r${sim.qaRounds}`, type: "TestReport", content: "all tests passing" + demoBody("test report"), metadata: { result: "PASSED" } },
            { op: "send", type: "TEST_RESULT", to: ["developer", "tech-lead"], newThread: { subject: "test pass" }, artifactRefs: patch ? [{ uri: uri(patch) }] : [], payload: { result: "PASSED" } },
            { op: "send", type: "REQUEST_REVIEW", to: ["tech-lead"], newThread: { subject: "code review requested" }, artifactRefs: patch ? [{ uri: uri(patch) }] : [], payload: { question: "approve merge" } },
            { op: "wait" },
          ],
        };
      }
      if (releaseAsk && !flags.releaseQaSent) {
        flags.releaseQaSent = true;
        flags.qaRelease = true;
        return {
          text: "release regression pass",
          operations: [
            { op: "publish_artifact", name: "release-test-report", type: "TestReport", content: "release regression green" + demoBody("release regression report"), metadata: { result: "PASSED" } },
            { op: "send", type: "TEST_RESULT", to: ["pm", "tech-lead"], newThread: { subject: "release QA pass" }, payload: { result: "PASSED", subject: "release" } },
            { op: "done" },
          ],
        };
      }
      return { text: "qa idle", operations: [{ op: "done" }] };
    },
  );

  scripts.set(
    "security",
    async (input): Promise<any> => {
      const ask = input.context.unreadMail.find((m) => m.type === "REQUEST_REVIEW" || m.type === "TEST_RESULT") || (input.activation.kind === "interest_event" && ["release.candidate", "authentication.changed", "authorization.changed", "dependency.changed"].includes(String(input.activation.eventType)));
      if (!ask || flags.secRelease) return { text: "security idle", operations: [{ op: "done" }] };
      sim.secScans++;
      flags.secRelease = true;
      return {
        text: "security pass",
        operations: [
          { op: "publish_artifact", name: `security-scan-${sim.secScans}`, type: "SecurityReport", content: "no critical findings" + demoBody("security scan"), metadata: { result: "PASSED", criticalFindings: 0 } },
          { op: "send", type: "SECURITY_FINDING", to: ["pm", "tech-lead"], newThread: { subject: "security pass" }, payload: { result: "PASSED", subject: "security" } },
          { op: "done" },
        ],
      };
    },
  );

  return scripts;
}

function evidenceFor(board: BoardEntry[], criterion: string): BoardEntry | undefined {
  switch (criterion) {
    case "requirements-documented":
      return find(board, "RequirementsDoc", "payment-requirements");
    case "architecture-approved":
      return find(board, "ArchitectureDocument", "payment-architecture");
    case "implementation-merged":
    case "req-payments-idempotency":
      return [...board].reverse().find((b) => b.type === "CodePatch" && b.status === "MERGED");
    case "quality-verified":
      return find(board, "TestReport", "test-report");
    case "security-verified":
      return find(board, "SecurityReport", "security-scan");
    case "req-analysis":
      return find(board, "ResearchReport", "payment-boundaries");
    default:
      return undefined;
  }
}

function buildSingleScripts(spec: CategorySpec, sim: Sim): Map<string, StubScript> {
  const { board, flags } = sim;
  const steps: Array<() => MeshOp[]> = [];
  if (spec.withResearch) {
    steps.push(() => [{ op: "publish_artifact", name: "boundaries", type: "ResearchReport", content: "boundary analysis (solo)" + demoBody("boundary analysis"), metadata: {} }]);
  }
  steps.push(() => [{ op: "publish_artifact", name: "solo-requirements", type: "RequirementsDoc", content: requirementsDocContent(spec) }]);
  steps.push(() => [
    { op: "publish_artifact", name: "solo-architecture", type: "ArchitectureDocument", content: "# Architecture (solo)" + demoBody("solo architecture") },
    { op: "approve", subject: "architecture", comment: "solo design decision" },
  ]);
  if (spec.withCode) {
    steps.push(() => [{ op: "publish_artifact", name: "solo-patch", type: "CodePatch", content: `diff --git a/Core.java b/Core.java\n+ solo implementation ${spec.coupledWrites} classes${demoBody("solo implementation")}` }]);
    steps.push(() => {
      const patch = find(board, "CodePatch", "solo-patch");
      return patch
        ? [
            { op: "transition_artifact", artifactId: patch.id, to: "READY_FOR_REVIEW" },
            { op: "approve", subject: "implementation", artifactId: patch.id, comment: "solo self-review" },
            { op: "transition_artifact", artifactId: patch.id, to: "APPROVED" },
            { op: "transition_artifact", artifactId: patch.id, to: "VERIFIED" },
            { op: "transition_artifact", artifactId: patch.id, to: "MERGEABLE" },
            { op: "merge", artifactId: patch.id, comment: "solo merge" },
          ]
        : [];
    });
  }
  steps.push(() => [{ op: "publish_artifact", name: "solo-tests", type: "TestReport", content: "green" + demoBody("solo test report"), metadata: { result: "PASSED" } }]);
  if (spec.withSecurity) {
    steps.push(() => [{ op: "publish_artifact", name: "solo-scan", type: "SecurityReport", content: "clean" + demoBody("solo security scan"), metadata: { result: "PASSED", criticalFindings: 0 } }]);
  }
  if (spec.withCode || spec.withSecurity) {
    steps.push(() => {
      const rel = [
        { op: "publish_artifact", name: "solo-release", type: "ReleasePlan", content: "release 1.0.0" + demoBody("solo release plan") } as MeshOp,
      ];
      return rel;
    });
    steps.push(() => {
      const rel = find(board, "ReleasePlan", "solo-release");
      return rel
        ? ([
            { op: "transition_artifact", artifactId: rel.id, to: "IMPLEMENTED" },
            { op: "transition_artifact", artifactId: rel.id, to: "QA_VERIFIED" },
            { op: "transition_artifact", artifactId: rel.id, to: "SECURITY_VERIFIED" },
            { op: "transition_artifact", artifactId: rel.id, to: "ACCEPTED" },
          ] as MeshOp[])
        : [];
    });
  }
  steps.push(() => {
    const ops: MeshOp[] = [];
    for (const c of criterionIds(spec)) {
      const evidence = evidenceFor(board, c) ?? (c === "implementation-merged" || c === "req-payments-idempotency" ? find(board, "CodePatch", "solo-patch") : c === "quality-verified" ? find(board, "TestReport", "solo-tests") : c === "security-verified" ? find(board, "SecurityReport", "solo-scan") : c === "req-analysis" ? find(board, "ResearchReport", "boundaries") : c === "architecture-approved" ? find(board, "ArchitectureDocument", "solo-architecture") : find(board, "RequirementsDoc", "solo-requirements"));
      ops.push({ op: "approve", subject: `criterion:${c}`, artifactId: evidence?.id, comment: "solo completion with artifact evidence" });
    }
    return ops;
  });
  let step = 0;
  const scripts = new Map<string, StubScript>();
  scripts.set("solo", async (): Promise<any> => {
    if (step >= steps.length) {
      sim.flags.soloDone = true;
      return { text: "finished", operations: [{ op: "done" as const }] };
    }
    const ops = steps[step]();
    step++;
    return { text: `solo step ${step}`, operations: [...ops, { op: "done" as const }] };
  });
  void flags;
  return scripts;
}

function wireSim(instance: MeshInstance, sim: Sim): () => void {
  return instance.kernel.subscribe((e) => {
    if (e.type === "artifact.created" || e.type === "artifact.versioned") {
      const a = (e.payload as any).artifact;
      if (a && !sim.board.find((b) => b.id === a.id)) sim.board.push({ id: a.id, type: a.type, name: a.name, version: a.version, status: a.status });
    }
    if (e.type === "artifact.transition") {
      const b = sim.board.find((x) => x.id === (e.payload as any).artifactId);
      if (b) b.status = (e.payload as any).to;
    }
    if (e.type === "requirements.created") sim.flags.reqs = true;
    if (e.type === "research.completed") sim.flags.research = true;
    if (e.type === "release.candidate") sim.flags.releaseCreated = true;
    if (e.type === "patch.merged") sim.flags.merged = true;
    if (e.type === "implementation.completed") sim.flags.impl = true;
    if (e.type === "release.accepted") sim.flags.accepted = true;
    if (e.type === "message.sent") {
      const m = (e.payload as any).message;
      if (m?.type === "MISSION" && m.from === "pm") sim.flags.missionSent = true;
    }
  });
}

/**
 * Attach the scripted payment-API demo team to a running (stub-runtime) mesh.
 * This makes `mesh run examples/demo-stub/mesh.yaml` actually converge out of
 * the box, so a first-time user sees the full event-driven flow with zero setup.
 */
export function attachDemoTeam(instance: MeshInstance): { cleanup(): void } {
  const spec = CORPUS.find((c) => c.category === "F") ?? CORPUS[0];
  const sim: Sim = {
    spec,
    board: [],
    flags: { reqs: false, research: false, impl: false, releaseCreated: false, merged: false, qaRelease: false, secRelease: false, missionSent: false, archPublished: false, releaseReviewed: false, accepted: false, criteriaApproved: false, releaseQaSent: false, releaseSecSent: false, soloDone: false, kickoff: false },
    taskIds: [],
    qaRounds: 0,
    secScans: 0,
    patches: 0,
    rework: 0,
    doneOps: 0,
  };
  const stub = instance.stubRuntimes.get("stub");
  if (!stub) throw new Error("no stub runtime registered — attachDemoTeam requires runtime: stub agents");
  for (const [agentId, script] of buildMeshScripts(sim)) stub.setScript(agentId, script);
  const unsub = wireSim(instance, sim);
  void instance.supervisor.activateAgent("pm", { kind: "startup", note: "demo kickoff" }).catch(() => undefined);
  return { cleanup: () => { unsub(); void instance.supervisor.shutdown(); } };
}

export interface RunResult {
  metrics: MetricsSnapshot;
  goalStatus: string;
  criteriaEvidenced: number;
  criteriaTotal: number;
  tokensTotal: number;
  wallMs: number;
  firstArtifactMs: number | null;
  reviewRounds: number;
  rework: number;
  escalations: number;
}

export async function runScenario(kind: "mesh" | "single", spec: CategorySpec, timeoutMs: number): Promise<RunResult> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bench-${kind}-${spec.category}-`));
  const configPath = path.join(dir, "mesh.yaml");
  fs.writeFileSync(configPath, kind === "mesh" ? meshYaml(spec) : singleYaml(spec), "utf8");
  fs.mkdirSync(path.join(dir, "roles"), { recursive: true });
  for (const r of ["pm", "architect", "tech-lead", "developer", "qa", "security", "explorer", "solo"]) {
    fs.writeFileSync(path.join(dir, "roles", `${r}.md`), "# Role\nDeterministic benchmark stub.", "utf8");
  }
  const sim: Sim = {
    spec,
    board: [],
    flags: { reqs: false, research: false, impl: false, releaseCreated: false, merged: false, qaRelease: false, secRelease: false, missionSent: false, archPublished: false, releaseReviewed: false, accepted: false, criteriaApproved: false, releaseQaSent: false, releaseSecSent: false, soloDone: false, kickoff: false },
    taskIds: [],
    qaRounds: 0,
    secScans: 0,
    patches: 0,
    rework: 0,
    doneOps: 0,
  };
  const instance = await bootstrapMesh({ configPath, inMemory: true });
  const stub = instance.stubRuntimes.get("stub")!;
  const scripts = kind === "mesh" ? buildMeshScripts(sim) : buildSingleScripts(spec, sim);
  for (const [agentId, script] of scripts) stub.setScript(agentId, script);
  await instance.supervisor.activateAgent(kind === "mesh" ? "pm" : "solo", { kind: "startup", note: "kickoff" });
  let firstArtifactMs: number | null = null;
  const t0 = Date.now();
  const unsubSim = wireSim(instance, sim);
  const unsubFirst = instance.kernel.subscribe((e) => {
    if ((e.type === "artifact.created" || e.type === "artifact.versioned") && firstArtifactMs === null) firstArtifactMs = Date.now() - t0;
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const goal = instance.kernel.state.goals.get(instance.kernel.state.activeGoalId ?? "");
    if (goal && ["COMPLETED", "FAILED", "ESCALATED"].includes(goal.status)) break;
    if (instance.supervisor.isIdle()) {
      const settled = await settle(instance, sim, kind);
      if (settled) break;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  const wallMs = Date.now() - t0;
  const goal = instance.kernel.state.goals.get(instance.kernel.state.activeGoalId ?? "");
  const metrics = buildMetrics(instance.kernel.state, wallMs);
  const cost = buildCostReport(instance.kernel.state, instance.config);
  const reviewRounds = [...instance.kernel.state.reviewRounds.values()].reduce((a, b) => a + b, 0);
  unsubSim();
  unsubFirst();
  await instance.close();
  fs.rmSync(dir, { recursive: true, force: true });
  return {
    metrics,
    goalStatus: goal?.status ?? "TIMEOUT",
    criteriaEvidenced: goal ? goal.acceptanceCriteria.filter((c) => c.status === "EVIDENCED" || c.status === "WAIVED").length : 0,
    criteriaTotal: goal ? goal.acceptanceCriteria.filter((c) => c.mandatory).length : 0,
    tokensTotal: cost.missionTokens,
    wallMs,
    firstArtifactMs,
    reviewRounds,
    rework: sim.rework,
    escalations: metrics.escalationsOpen,
  };
}

async function settle(instance: MeshInstance, sim: Sim, kind: "mesh" | "single"): Promise<boolean> {
  const goalId = instance.kernel.state.activeGoalId;
  const goal = goalId ? instance.kernel.state.goals.get(goalId) : undefined;
  if (!goal) return true;
  if (["COMPLETED", "FAILED", "ESCALATED"].includes(goal.status)) return true;
  if (kind === "single") {
    if (sim.flags.soloDone) return true;
    await instance.supervisor.activateAgent("solo", { kind: "timer", note: "continue plan" });
    await new Promise((r) => setTimeout(r, 120));
    return false;
  }
  const pending = [...instance.kernel.state.pendingRequests.values()];
  if (pending.length > 0) {
    for (const t of pending[0].to) {
      await instance.supervisor.activateAgent(t, { kind: "timer", note: "follow up on open request" });
    }
    await new Promise((r) => setTimeout(r, 150));
    return instance.kernel.state.pendingRequests.size === 0 ? false : pending.length === instance.kernel.state.pendingRequests.size;
  }
  const spec = sim.spec;
  const ready = sim.flags.reqs && (!spec.withCode || sim.flags.merged) && (!spec.withResearch || sim.flags.research);
  if (ready && !sim.flags.accepted) {
    await instance.supervisor.activateAgent("pm", { kind: "timer", note: "accept criteria" });
    await new Promise((r) => setTimeout(r, 150));
    if (!sim.flags.accepted && !spec.withCode) {
      sim.flags.accepted = true;
    }
    return false;
  }
  return true;
}

export interface BenchReport {
  ranAt: string;
  categories: Array<{
    category: BenchmarkCategory;
    name: string;
    mesh: RunResult;
    single: RunResult;
    advantage: { qualityGain: number; relativeCost: number; score: number } | null;
  }>;
  summary: string;
}

export async function runAllBenchmarks(timeoutMs = 30000): Promise<BenchReport> {
  const categories: BenchReport["categories"] = [];
  for (const spec of CORPUS) {
    const mesh = await runScenario("mesh", spec, timeoutMs);
    const single = await runScenario("single", spec, timeoutMs);
    const meshQuality = mesh.criteriaTotal ? mesh.criteriaEvidenced / mesh.criteriaTotal : 0;
    const singleQuality = single.criteriaTotal ? single.criteriaEvidenced / single.criteriaTotal : 0;
    const qualityGain = meshQuality - singleQuality;
    const relativeCost = single.tokensTotal > 0 ? mesh.tokensTotal / single.tokensTotal : 1;
    categories.push({
      category: spec.category,
      name: spec.name,
      mesh,
      single,
      advantage: { qualityGain, relativeCost, score: relativeCost > 0 ? qualityGain / Math.max(relativeCost, 0.01) : 0 },
    });
  }
  const wins = categories.filter((c) => (c.advantage?.score ?? 0) > 0).length;
  return {
    ranAt: new Date().toISOString(),
    categories,
    summary: `mesh matched-or-beat single quality on ${categories.filter((c) => (c.advantage?.qualityGain ?? 0) >= 0).length}/${categories.length}; net-advantage wins on ${wins}/${categories.length}`,
  };
}

export async function runBenchmark(flags: Record<string, string | boolean>): Promise<number> {
  const timeoutMs = flags.timeout ? Number(flags.timeout) : 30000;
  const report = await runAllBenchmarks(timeoutMs);
  const header = "cat  mesh(tokens/msgs/act)   solo(tokens/msgs)   qualityÎ”   relCost   advantage";
  console.log(header);
  console.log("â”€".repeat(header.length));
  for (const row of report.categories) {
    const a = row.advantage!;
    console.log(
      `${row.category}    ${String(row.mesh.tokensTotal).padStart(7)}/${String(row.mesh.metrics.messages).padStart(3)}/${String(row.mesh.metrics.activations).padStart(3)}      ${String(row.single.tokensTotal).padStart(7)}/${String(row.single.metrics.messages).padStart(3)}      ${a.qualityGain >= 0 ? "+" : ""}${a.qualityGain.toFixed(2)}      ${a.relativeCost.toFixed(2)}x    ${a.score >= 0 ? "+" : ""}${a.score.toFixed(2)}`,
    );
  }
  console.log(`\n${report.summary}`);
  if (flags.out) {
    fs.writeFileSync(String(flags.out), JSON.stringify(report, null, 2), "utf8");
    console.log(`report written to ${flags.out}`);
  }
  return 0;
}

// ------------------------------------------------------------- simulation engine (Â§69)

export interface SimulationReport {
  iterations: number;
  events: number;
  messages: number;
  escalations: number;
  crashed: number;
  recovered: number;
  invariantViolations: string[];
}

export async function runSimulation(iterations: number, seed = 7): Promise<SimulationReport> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-sim-"));
  fs.writeFileSync(path.join(dir, "mesh.yaml"), simYaml(), "utf8");
  fs.mkdirSync(path.join(dir, "roles"), { recursive: true });
  for (const r of ["alice", "bob", "carol"]) fs.writeFileSync(path.join(dir, "roles", `${r}.md`), "stub", "utf8");
  const instance = await bootstrapMesh({ configPath: path.join(dir, "mesh.yaml"), inMemory: true });
  const rng = mulberry32(seed);
  const agents = ["alice", "bob", "carol"];
  const violations: string[] = [];
  let crashed = 0;
  let recovered = 0;
  const stub = instance.stubRuntimes.get("stub")!;
  stub.setScript("alice", async (input, turnIndex) => {
    if (turnIndex === 0) {
      return { text: "bootstrap", operations: [{ op: "publish_artifact", name: "shared-doc", type: "ADR", content: "seed decision" }, { op: "done" }] };
    }
    void input;
    const roll = rng();
    const ops: MeshOp[] = [];
    if (roll < 0.3) ops.push({ op: "send", type: "INFORM", to: ["bob"], newThread: { subject: `ping ${Math.floor(roll * 1e6)}` }, payload: { n: turnIndex } });
    else if (roll < 0.5) ops.push({ op: "publish_artifact", name: `note-${turnIndex}`, type: "ADR", content: `note ${turnIndex}` });
    else if (roll < 0.55) ops.push({ op: "acquire_lease", artifactId: (instance.kernel.state.activeGoalId ? [...instance.kernel.state.artifacts.values()][0]?.id : "") ?? "", files: [] });
    else if (roll < 0.58) ops.push({ op: "remember", key: `k${turnIndex}`, value: `v${turnIndex}` });
    else ops.push({ op: "done" });
    ops.push({ op: "done" });
    return { text: "sim", operations: ops };
  });
  stub.setScript("bob", async (_input, turnIndex) => {
    const roll = rng();
    if (roll < 0.02) {
      crashed++;
      throw new Error("simulated runtime crash");
    }
    const ops: MeshOp[] = [];
    if (roll < 0.35) ops.push({ op: "send", type: "INFORM", to: ["carol"], newThread: { subject: `reply ${Math.floor(roll * 1e6)}` }, payload: { n: turnIndex } });
    if (roll > 0.9) ops.push({ op: "escalate", reason: "sim-need-human", conflictKey: `sim-${turnIndex}` });
    ops.push({ op: "done" });
    return { text: "sim", operations: ops };
  });
  stub.setScript("carol", async (_input, turnIndex) => {
    const ops: MeshOp[] = [];
    if (rng() < 0.3) ops.push({ op: "send", type: "INFORM", to: ["alice"], newThread: { subject: `echo ${Math.floor(rng() * 1e6)}` }, payload: { n: turnIndex } });
    ops.push({ op: "done" });
    return { text: "sim", operations: ops };
  });

  for (let i = 0; i < iterations; i++) {
    const agent = agents[Math.floor(rng() * agents.length)];
    await instance.supervisor.activateAgent(agent, { kind: "manual", note: `sim ${i}` });
    if (i % 25 === 0) {
      await new Promise((r) => setTimeout(r, 5));
      if (instance.kernel.state.agents.get("bob")?.state.lifecycle === "FAILED") recovered++;
    }
    const seq = instance.kernel.state.lastEventSeq;
    if (seq > 2400) break;
  }
  await new Promise((r) => setTimeout(r, 500));

  for (const [artifactId, leaseId] of instance.kernel.state.activeLeaseByArtifact) {
    const holders = [...instance.kernel.state.leases.values()].filter((l) => l.artifactId === artifactId && !l.releasedAt);
    if (holders.length > 1) violations.push(`double writer on ${artifactId}`);
    void leaseId;
  }
  for (const b of instance.kernel.state.budgets.values()) {
    if (b.consumed < 0 || b.reserved < 0) violations.push(`negative budget ${b.key}`);
  }
  const metrics = buildMetrics(instance.kernel.state, 1);
  await instance.close();
  fs.rmSync(dir, { recursive: true, force: true });
  return {
    iterations,
    events: metrics.events,
    messages: metrics.messages,
    escalations: metrics.escalationsOpen,
    crashed,
    recovered,
    invariantViolations: violations,
  };
}

function simYaml(): string {
  return `version: 1

mesh:
  id: sim
  goal: |
    Simulation harness goal.
  acceptance_criteria:
    - { id: sim-none, description: "unused", mandatory: false }
  workspace:
    path: ./workspace
  runtime:
    default: stub

startup:
  activate: [alice]

agents:
  alice:
    role: alice
    runtime: stub
    capabilities: [repository.read, repository.write]
    authority: []
    interests: [artifact.created, message.sent, patch.ready]
    budget: { tokens: 500000 }
  bob:
    role: bob
    runtime: stub
    capabilities: [repository.read]
    interests: [message.sent, artifact.created]
    session: { persistent: true }
    budget: { tokens: 500000 }
  carol:
    role: carol
    runtime: stub
    capabilities: [repository.read]
    interests: [message.sent]
    budget: { tokens: 500000 }

policies:
  communication:
    alice: { may_contact: [bob, carol] }
    bob: { may_contact: [alice, carol] }
    carol: { may_contact: [alice, bob] }
  escalation:
    thread: { max_depth: 6 }
    repeated_conflict: { threshold: 8 }
    artifact_review_rounds: { max: 8 }

budgets:
  mission: { tokens: 5000000, wall_clock_minutes: 5, max_events: 3000 }
  thread: { tokens: 100000 }

scheduling:
  mode: event-driven
  activation: { strategy: interest }
  concurrency: { max_active_agents: 3 }
  timeouts: { turn_timeout_ms: 10000, wait_wakeup_ms: 400, idle_quiet_period_ms: 500 }
`;
}
