import * as fs from "fs";
import * as path from "path";
import {
  PROTOCOL_VERSION,
  digestOf,
  INITIAL_ARTIFACT_STATUS,
  artifactMachineOf,
  validateMessage,
  type AcceptanceCriterion,
  type AgentDefinition,
  type AgentInput,
  type AgentOutput,
  type AgentRuntime,
  type AgentRuntimeStatus,
  type Artifact,
  type ArtifactRef,
  type ArtifactStatus,
  type CreateGoalInput,
  type DecisionRecord,
  type Escalation,
  type EventType,
  type Goal,
  type GoalId,
  type LifecycleState,
  type MeshEvent,
  type MeshMessage,
  type MeshOp,
  type MessageType,
  type ReplayState,
  type RuntimeContext,
  type SendResult,
  type SubAgentResult,
  type Task,
  type Thread,
  type ActivationReason,
  type ApprovalKind,
  type BudgetHint,
  type PolicyDecisionResult,
  type TrustSource,
} from "../../protocol/src/index";
import { newArtifactId, newDecisionId, newEscalationId, newGoalId, newLeaseId, newMessageId, newTaskId, newThreadId, shortHash } from "../../protocol/src/index";
import { artifactKey, approvalKey, ensureBudget } from "./state";
import type { Projections } from "./state";
import { applyEvent, checkApprovals, transitionLifecycle } from "./projections";
import type { Kernel } from "./kernel";
import { KernelRejectedError } from "./kernel";
import type { BudgetManager } from "./budgets";
import { agentKey, missionKey, taskKey, threadKey } from "./budgets";
import type {
  ArtifactContentStore,
  PolicyEvaluator,
  RuntimeResolver,
  SchedulerActivationRequest,
  SchedulerPort,
  SessionRegistryPort,
  SupervisorHooks,
  WorkspacePort,
} from "./ports";
import type { ResolvedMeshConfig } from "../../config/src/index";
import { buildAgentContext, renderContextInstructions } from "./context";
import { DeadlockDetector, TerminationManager, type DeadlockFinding } from "./termination";
import { refToString, artifactUri } from "../../protocol/src/uri";

export interface SupervisorDeps {
  config: ResolvedMeshConfig;
  kernel: Kernel;
  store: import("../../event-store/src/index").EventStore;
  budget: BudgetManager;
  policy: PolicyEvaluator;
  scheduler: SchedulerPort;
  runtimes: RuntimeResolver;
  content: ArtifactContentStore;
  workspace?: WorkspacePort;
  sessionRegistry?: SessionRegistryPort;
  hooks?: SupervisorHooks;
  auditFile?: string;
}

export interface OpResult {
  ok: boolean;
  op: MeshOp["op"];
  eventId?: string;
  messageId?: string;
  artifactId?: string;
  artifactUri?: string;
  taskId?: string;
  reason?: string;
  artifact?: Artifact;
  escalationId?: string;
}

export const HUMAN_AGENT_ID = "human";

export const DEFAULT_CRITERIA: Array<Partial<AcceptanceCriterion> & { description: string }> = [
  { id: "requirements-documented", description: "Requirements are documented in a RequirementsDoc artifact accepted by PM", mandatory: true },
  { id: "architecture-approved", description: "Architecture approved by architect and tech-lead", mandatory: true },
  { id: "implementation-merged", description: "Implementation patches reviewed and merged", mandatory: true },
  { id: "quality-verified", description: "QA verification passed with test report evidence", mandatory: true },
  { id: "security-verified", description: "Security verification passed with scan evidence", mandatory: true },
];

const TURN_RESERVE_TOKENS = 32000;

interface TurnState {
  turnId: string;
  agentId: string;
  reason: ActivationReason;
  sentOps: number;
  publishedOps: number;
  waitRequested: boolean;
  escalated: boolean;
  results: OpResult[];
}

export class Supervisor {
  private sessions = new Map<string, { session: import("../../protocol/src/index").AgentSession; runtime: AgentRuntime }>();
  private turnInFlight = new Set<string>();
  private restartAttempts = new Map<string, number>();
  private workerInfo = new Map<string, { parent: string; taskId: string; depth: number }>();
  private startedAt = Date.now();
  private detector: DeadlockDetector;
  private termination = new TerminationManager();
  private watchdogChain: Promise<void> = Promise.resolve();
  private stopping = false;
  private idleCallbacks: Array<() => void> = [];

  constructor(public readonly deps: SupervisorDeps) {
    this.detector = new DeadlockDetector(deps.config);
    deps.scheduler.onIdle?.(() => this.onIdle());
    deps.kernel.subscribe(() => {
      this.watchdogChain = this.watchdogChain
        .then(() => this.watchdog())
        .catch((err) => this.auditLine(`watchdog error: ${(err as Error).message}`));
    });
  }

  get state(): Projections {
    return this.deps.kernel.state;
  }

  get config(): ResolvedMeshConfig {
    return this.deps.config;
  }

  private auditLine(msg: string): void {
    if (!this.deps.auditFile) return;
    try {
      fs.mkdirSync(path.dirname(this.deps.auditFile), { recursive: true });
      fs.appendFileSync(this.deps.auditFile, `${new Date().toISOString()} ${msg}\n`, "utf8");
    } catch {
      /* audit must never break the runtime */
    }
  }

  // ---------------------------------------------------------------- boot (Â§63)

  async boot(opts: { resume?: boolean; uiOnly?: boolean } = {}): Promise<Goal | null> {
    // 4. create workspace
    if (this.deps.workspace) {
      await this.deps.workspace.ensureRepo();
    }
    // 6. create goal (only if not resuming an unfinished one)
    if (!opts.resume || !this.state.activeGoalId || !this.state.goals.get(this.state.activeGoalId)) {
      await this.createGoal({
        description: this.config.goalText,
        acceptanceCriteria: this.config.goalCriteria ?? DEFAULT_CRITERIA,
        budget: {
          tokens: this.config.budgets.mission.tokens,
          wallClockMinutes: this.config.budgets.mission.wallClockMinutes,
          maxEvents: this.config.budgets.mission.maxEvents,
        },
      });
    }
    // 7. register agents (+ human seat, Â§36)
    await this.registerHuman();
    for (const id of this.config.agentOrder) {
      if (!this.state.agents.has(id)) {
        await this.registerAgent(this.config.agents[id]);
      }
    }
    // 8. allocate budgets
    const goalId = this.state.activeGoalId!;
    this.deps.budget.declare(missionKey(goalId), "tokens", this.config.budgets.mission.tokens);
    this.deps.budget.declare(missionKey(goalId), "events", this.config.budgets.mission.maxEvents);
    this.deps.budget.declare(missionKey(goalId), "wallclock_minutes", this.config.budgets.mission.wallClockMinutes);
    for (const id of this.config.agentOrder) {
      this.deps.budget.declare(agentKey(goalId, id), "tokens", this.config.agents[id].budget.tokens ?? null);
    }
    // 12/13. start scheduler + activate initial agents (skipped in ui-only mode:
    // the scheduler stays stopped, so no agent is ever activated or spends tokens)
    if (!opts.uiOnly) {
      this.deps.scheduler.start();
      const activate = opts.resume ? this.recoveryCandidates() : this.config.startupActivate;
      for (const id of activate) {
        await this.activateAgent(id, {
          kind: opts.resume ? "recovery" : "startup",
          note: opts.resume ? "mission resumed from event log" : "startup activation",
        });
      }
    }
    return this.state.goals.get(goalId) ?? null;
  }

  private recoveryCandidates(): string[] {
    const out: string[] = [];
    for (const rec of this.state.agents.values()) {
      const a = rec.state;
      if (a.agentId === HUMAN_AGENT_ID) continue;
      if ((this.state.unread.get(a.agentId)?.length ?? 0) > 0 || a.activeTaskId || a.lifecycle === "WAITING" || a.lifecycle === "FAILED") {
        out.push(a.agentId);
      }
    }
    return out;
  }

  async shutdown(opts: { complete?: boolean } = {}): Promise<void> {
    this.stopping = true;
    await this.deps.scheduler.stop();
    for (const [agentId, { session, runtime }] of [...this.sessions]) {
      try {
        await runtime.stop(session);
      } catch (err) {
        this.auditLine(`stop failed for ${agentId}: ${(err as Error).message}`);
      }
    }
    this.sessions.clear();
  }

  // ------------------------------------------------------- MeshRuntime API (Â§48)

  async createGoal(input: CreateGoalInput): Promise<Goal> {
    if (this.state.activeGoalId && this.state.goals.get(this.state.activeGoalId)?.status !== "CREATED") {
      // one goal per mesh instance in v1
    }
    const goalId = newGoalId();
    const rootThreadId = newThreadId();
    const goal: Goal = {
      id: goalId,
      description: input.description,
      acceptanceCriteria: (input.acceptanceCriteria ?? DEFAULT_CRITERIA).map((c, i) => ({
        id: c.id ?? `criterion-${i + 1}`,
        description: c.description,
        mandatory: c.mandatory ?? true,
        status: c.status ?? "UNSATISFIED",
        evidence: c.evidence ?? [],
      })),
      status: "ACTIVE",
      budget: {
        tokens: input.budget?.tokens ?? this.config.budgets.mission.tokens,
        wallClockMinutes: input.budget?.wallClockMinutes ?? this.config.budgets.mission.wallClockMinutes,
        maxEvents: input.budget?.maxEvents ?? this.config.budgets.mission.maxEvents,
      },
      rootThreadId,
      createdAt: this.deps.kernel.clock.iso(),
    };
    await this.deps.kernel.emit("goal.created", { goal }, { goalId, actorId: HUMAN_AGENT_ID });
    const rootThread: Thread = {
      id: rootThreadId,
      goalId,
      subject: "mission-root",
      initiator: HUMAN_AGENT_ID,
      artifactRefs: [],
      participants: [HUMAN_AGENT_ID],
      depth: 0,
      messageIds: [],
      status: "OPEN",
      budget: { tokens: this.config.budgets.threadTokens },
      createdAt: goal.createdAt,
    };
    await this.deps.kernel.emit("thread.created", { thread: rootThread }, { goalId, actorId: HUMAN_AGENT_ID });
    return goal;
  }

  async registerAgent(agent: AgentDefinition): Promise<void> {
    await this.deps.kernel.emit("agent.created", { agent }, { actorId: HUMAN_AGENT_ID });
  }

  private async registerHuman(): Promise<void> {
    if (this.state.agents.has(HUMAN_AGENT_ID)) return;
    const human: AgentDefinition = {
      id: HUMAN_AGENT_ID,
      role: "human",
      mode: "peer",
      runtime: "none",
      prompt: { text: "The human operator seat." },
      capabilities: ["override"],
      authority: ["*"],
      communicationPolicy: { mayContact: [], mayBeContactedBy: [] },
      interests: ["goal.escalated", "escalation.requested"],
      sessionPolicy: { persistent: false },
      delegationPolicy: { allowDelegation: false, maxDepth: 0, maxWorkers: 0 },
      budget: {},
    };
    await this.registerAgent(human);
  }

  async sendMessage(input: {
    from: string;
    to: string[];
    type: MessageType;
    goalId?: GoalId;
    threadId?: string;
    newThread?: { subject: string; artifactRefs?: ArtifactRef[]; parentThreadId?: string };
    replyTo?: string;
    artifactRefs?: ArtifactRef[];
    payload?: unknown;
    priority?: MeshMessage["priority"];
    taskId?: string;
    causationId?: string;
    requires?: { id: string; text: string }[];
    budgetHint?: { maxTokens?: number; maxTurns?: number };
  }): Promise<SendResult> {
    const goalId = this.state.activeGoalId;
    if (!goalId) return { accepted: false, reason: "no active goal" };
    const ctx = { config: this.config, projections: this.state, goal: this.state.goals.get(goalId) };
    if (!this.state.agents.has(input.from)) return { accepted: false, reason: `unknown sender ${input.from}` };
    const targets = [...new Set(input.to)].filter((t) => t !== input.from);
    if (targets.length === 0) return { accepted: false, reason: "no recipients (self-addressed messages are dropped)" };

    for (const t of targets) {
      if (!this.state.agents.has(t) && t !== "all") return { accepted: false, reason: `unknown recipient ${t}` };
    }

    const policy = this.deps.policy.evaluateMessage(input.from, targets, { type: input.type, threadId: input.threadId ?? "", payload: input.payload, taskId: input.taskId }, ctx);
    if (policy.decision === "DENY") {
      const evt = await this.deps.kernel.emit(
        "message.rejected",
        { from: input.from, to: targets, type: input.type, reason: policy.reason, ruleId: policy.ruleId, payload: input.payload },
        { actorId: input.from, goalId },
      );
      return { accepted: false, reason: policy.reason, eventId: evt.id };
    }
    if (policy.decision === "DEFER") {
      return { accepted: false, reason: policy.reason ?? "deferred" };
    }
    if (policy.decision === "ESCALATE") {
      const esc = await this.escalate({
        reason: policy.reason ?? "policy_escalation",
        raisedBy: input.from,
        detail: { attemptedTo: targets, type: input.type },
      });
      return { accepted: false, escalated: esc.id, reason: policy.reason };
    }
    let recipients = targets;
    if (policy.decision === "REDIRECT" && policy.redirects && policy.redirects.length > 0) {
      recipients = policy.redirects;
    }

    // resolve or create thread
    let threadId = input.threadId;
    if (threadId && !this.state.threads.has(threadId)) threadId = undefined;
    if (!threadId) {
      const parent = input.newThread?.parentThreadId ? this.state.threads.get(input.newThread.parentThreadId) : undefined;
      if (this.config.escalation.threadMaxDepth <= 0) {
        return { accepted: false, reason: "threading disabled" };
      }
      const depth = parent ? parent.depth + 1 : 1;
      if (depth > this.config.escalation.threadMaxDepth) {
        const esc = await this.escalate({
          reason: "thread_depth_exceeded",
          raisedBy: input.from,
          conflictKey: `depth:${parent?.id ?? "root"}`,
          detail: { parentThreadId: parent?.id, depth, max: this.config.escalation.threadMaxDepth },
        });
        return { accepted: false, escalated: esc.id, reason: "thread depth exceeded maximum" };
      }
      const t: Thread = {
        id: newThreadId(),
        goalId,
        subject: input.newThread?.subject ?? `${input.type} ${input.from}->${recipients.join(",")}`,
        initiator: input.from,
        artifactRefs: input.newThread?.artifactRefs ?? input.artifactRefs ?? [],
        participants: [input.from, ...recipients],
        depth,
        parentThreadId: parent?.id,
        rootThreadId: parent?.rootThreadId ?? parent?.id ?? this.state.goals.get(goalId)?.rootThreadId,
        messageIds: [],
        status: "OPEN",
        budget: { tokens: this.config.budgets.threadTokens },
        createdAt: this.deps.kernel.clock.iso(),
      };
      await this.deps.kernel.emit("thread.created", { thread: t }, { actorId: input.from, goalId });
      threadId = t.id;
    }

    let cacheHit: ArtifactRef | undefined;
    if (input.type === "REQUEST_RESEARCH") {
      cacheHit = this.researchCache(String((input.payload as any)?.question ?? ""));
    }
    const message: MeshMessage = {
      id: newMessageId(),
      protocolVersion: PROTOCOL_VERSION,
      type: input.type,
      timestamp: this.deps.kernel.clock.iso(),
      goalId,
      from: input.from,
      to: recipients,
      threadId: threadId!,
      replyTo: input.replyTo,
      causationId: input.causationId,
      artifactRefs: input.artifactRefs ?? [],
      payload: input.payload ?? {},
      priority: input.priority ?? (recipients.some((r) => this.config.agents[r]?.mode === "service") ? "HIGH" : "NORMAL"),
      taskId: input.taskId,
      requires: input.requires,
      budgetHint: input.budgetHint,
      provenance:
        input.from === HUMAN_AGENT_ID
          ? { source: "human", trustLevel: 100 }
          : { source: "agent", trustLevel: 50 },
    };
    if (message.replyTo && !this.state.messages.has(message.replyTo)) {
      return { accepted: false, reason: `replyTo ${message.replyTo} not found` };
    }
    const validation = validateMessage(message);
    if (!validation.valid) {
      return { accepted: false, reason: `message failed protocol validation: ${validation.errors.map((e) => e.path + " " + e.message).join("; ")}` };
    }
    if (cacheHit && message.payload && typeof message.payload === "object") {
      message.payload = { ...(message.payload as object), cacheServed: true };
    }

    const evt = await this.deps.kernel.emit("message.sent", { message }, { actorId: input.from, goalId, causationId: input.causationId });

    if (cacheHit) {
      await this.deps.kernel.emit("research.completed", { cached: true, artifactRef: cacheHit, messageId: message.id }, { actorId: input.from, goalId, causationId: evt.id });
      await this.sendMessage({
        from: recipients[0],
        to: [input.from],
        type: "INFORM",
        threadId: message.threadId,
        replyTo: message.id,
        artifactRefs: [cacheHit],
        payload: { summary: "answer served from explorer cache (no model invoked)", cached: true },
      });
      return { accepted: true, messageId: message.id, eventId: evt.id };
    }

    // derived semantic events
    await this.deriveSemantic(input.from, message, evt.id);
    return { accepted: true, messageId: message.id, eventId: evt.id, redirectedTo: policy.decision === "REDIRECT" ? recipients : undefined };
  }

  private async deriveSemantic(from: string, m: MeshMessage, causationId: string): Promise<void> {
    const goalId = m.goalId;
    const primary = m.artifactRefs[0]?.uri;
    if (m.type === "REQUEST_REVIEW") {
      const art = primary ? this.findArtifactByUri(primary) : undefined;
      await this.deps.kernel.emit("review.requested", { artifactId: art?.id, artifactRef: primary, reviewers: m.to, messageId: m.id, subject: m.payload }, { actorId: from, goalId, causationId });
      await this.auditTransition(art?.id, m.id, goalId);
      if (art && (art.type === "ArchitectureDocument" || art.type === "ApiSpec")) {
        await this.deps.kernel.emit("design.question", { artifactId: art.id, question: (m.payload as any)?.question ?? null, messageId: m.id }, { actorId: from, goalId, causationId });
      }
    }
    if (m.type === "TEST_RESULT" && (m.payload as any)?.result === "PASSED") {
      await this.markCriterionEvidence("quality-verified", {
        kind: "test-pass",
        artifactRef: m.artifactRefs[0],
        by: m.from,
        recordedAt: this.deps.kernel.clock.iso(),
      });
    }
    if (m.type === "SECURITY_FINDING" && (m.payload as any)?.result === "PASSED") {
      await this.markCriterionEvidence("security-verified", {
        kind: "security-pass",
        artifactRef: m.artifactRefs[0],
        by: m.from,
        recordedAt: this.deps.kernel.clock.iso(),
      });
    }
    if (m.type === "REQUEST_RESEARCH") {
      await this.deps.kernel.emit("research.requested", { question: (m.payload as any)?.question ?? m.payload, messageId: m.id }, { actorId: from, goalId, causationId });
    }
    if (m.type === "PATCH_READY") {
      const art = primary ? this.findArtifactByUri(primary) : undefined;
      await this.deps.kernel.emit("patch.ready", { artifactId: art?.id, artifactRef: primary, messageId: m.id }, { actorId: from, goalId, causationId });
      await this.auditTransition(art?.id, m.id, goalId);
    }
    if (m.type === "ESCALATE") {
      // already an explicit escalation op path; keep audit-only
    }
  }

  findArtifactByUri(uri: string): Artifact | undefined {
    for (const a of this.state.artifacts.values()) {
      if (a.contentRef === uri || `artifact://${a.type}/${a.name}/${a.version}` === uri) return a;
      if (a.id === uri) return a;
    }
    for (const a of this.state.artifacts.values()) {
      const parsed = /^artifact:\/\/([^/]+)\/([^/]+)/.exec(uri);
      if (parsed && a.type === parsed[1] && a.name === decodeURIComponent(parsed[2])) return a;
    }
    return undefined;
  }

  /**
   * P6: every state change must be visible in the log. Reducers derive
   * transitions internally; this records an idempotent audit event whose
   * replay is a no-op (same-status guard) but whose presence makes the
   * transition observable to consumers that read the event stream.
   */
  private async auditTransition(artifactId: string | undefined, causationId: string, goalId: string): Promise<void> {
    if (!artifactId) return;
    const a = this.state.artifacts.get(artifactId);
    if (!a) return;
    await this.deps.kernel
      .emit("artifact.transition", { artifactId, to: a.status, derived: true, gateSatisfied: true }, { actorId: "system", goalId, causationId })
      .catch(() => undefined);
  }

  async activateAgent(agentId: string, reason: ActivationReason): Promise<{ queued: boolean; blocked?: string }> {
    const goal = this.state.goals.get(this.state.activeGoalId ?? "");
    if (!goal) return { queued: false, blocked: "no goal yet — boot/create a goal first" };
    if (goal.status === "PAUSED") return { queued: false, blocked: "mission is paused — resume it first" };
    if (goal.status === "COMPLETED" || goal.status === "FAILED") return { queued: false, blocked: `mission is ${goal.status}` };
    if (goal.status === "ESCALATED") return { queued: false, blocked: "mission is escalated — respond to the open escalation first" };
    const rec = this.state.agents.get(agentId);
    if (!rec) return { queued: false, blocked: `unknown agent '${agentId}'` };
    if (agentId === HUMAN_AGENT_ID) return { queued: false, blocked: "the human seat has no runtime" };
    if (rec.state.lifecycle === "SUSPENDED") return { queued: false, blocked: "agent is suspended — resume it first" };
    if (rec.state.lifecycle === "COMPLETED") return { queued: false, blocked: "agent completed with the mission" };
    const req: SchedulerActivationRequest = {
      agentId,
      reason,
      priority: reason.kind === "startup" ? 5 : reason.kind === "recovery" ? 7 : reason.kind === "manual" ? 6 : 3,
      explicit: reason.kind === "manual",
    };
    const queued = await this.deps.scheduler.requestActivation(req);
    return { queued, blocked: queued ? undefined : "already active, or deferred by budget/policy" };
  }

  async suspendAgent(agentId: string): Promise<void> {
    const rec = this.state.agents.get(agentId);
    if (!rec) return;
    const sess = this.sessions.get(agentId);
    if (sess) await sess.runtime.suspend(sess.session).catch(() => undefined);
    await this.deps.kernel.emit("agent.suspended", { agentId }, { actorId: HUMAN_AGENT_ID });
  }

  async resumeAgent(agentId: string): Promise<void> {
    const sess = this.sessions.get(agentId);
    if (sess) await sess.runtime.resume(sess.session).catch(() => undefined);
    await this.deps.kernel.emit("agent.resumed", { agentId }, { actorId: HUMAN_AGENT_ID });
  }

  async createArtifact(input: {
    actorId: string;
    name: string;
    type: Artifact["type"];
    content: string;
    status?: ArtifactStatus;
    metadata?: Record<string, unknown>;
    parentArtifactId?: string;
    asVersionOf?: string;
    provenanceSource?: TrustSource;
  }): Promise<{ artifact: Artifact; uri: string } | { error: string }> {
    const goalId = this.state.activeGoalId;
    if (!goalId) return { error: "no active goal" };
    const ctx = { config: this.config, projections: this.state, goal: this.state.goals.get(goalId) };
    const machine = artifactMachineOf(input.type);
    const initial = INITIAL_ARTIFACT_STATUS[machine];

    let artifact: Artifact;
    let isVersion = false;
    if (input.asVersionOf) {
      const current = this.state.artifacts.get(input.asVersionOf);
      if (!current) return { error: `unknown artifact ${input.asVersionOf}` };
      const ownerCheck = this.deps.policy.checkOwnership(input.actorId, current.id, ctx);
      if (ownerCheck.decision === "DENY") {
        await this.denied(input.actorId, current.id, "publish version", ownerCheck);
        return { error: `ownership denied: ${ownerCheck.reason}` };
      }
      if (current.owner !== input.actorId && input.actorId !== HUMAN_AGENT_ID) {
        await this.denied(input.actorId, current.id, "publish version", { decision: "DENY", reason: `single-writer: current owner is ${current.owner}` });
        return { error: `single-writer: current owner is ${current.owner}` };
      }
      artifact = {
        ...current,
        version: current.version + 1,
        parent: current.id,
        status: input.status === "DRAFT" || input.status === undefined || input.status === "PROPOSED" ? initial : current.status,
        contentRef: "",
        digest: "",
        metadata: { ...(current.metadata ?? {}), ...(input.metadata ?? {}) },
        createdAt: this.deps.kernel.clock.iso(),
        createdBy: input.actorId,
      };
      isVersion = true;
    } else {
      const existing = this.state.artifactByName.get(artifactKey(input.type, input.name));
      if (existing && existing.version > 0 && this.state.activeGoalId === existing.goalId) {
        return { error: `artifact ${input.type}:${input.name} already exists at v${existing.version}; publish a new version via asVersionOf` };
      }
      artifact = {
        id: newArtifactId(),
        name: input.name,
        type: input.type,
        goalId,
        owner: input.actorId,
        version: 1,
        status: input.status === "FINAL" && machine === "document" ? "FINAL" : initial,
        contentRef: "",
        digest: "",
        metadata: input.metadata ?? {},
        provenance: {
          source: input.provenanceSource ?? (input.actorId === HUMAN_AGENT_ID ? "human" : "agent"),
          trustLevel: input.actorId === HUMAN_AGENT_ID ? 100 : 50,
        },
        createdAt: this.deps.kernel.clock.iso(),
        createdBy: input.actorId,
      };
    }
    const contentRef = await this.deps.content.writeVersion(artifact.id, artifact.version, input.content);
    artifact = { ...artifact, contentRef, digest: digestOf(input.content) };
    const uri = artifactUri(artifact.type, artifact.name, artifact.version);
    const evt = await this.deps.kernel.emit(
      isVersion ? "artifact.versioned" : "artifact.created",
      { artifact },
      { actorId: input.actorId, goalId },
    );
    await this.deriveArtifactSemantic(artifact, input.content, evt.id);
    return { artifact, uri };
  }

  private async deriveArtifactSemantic(a: Artifact, content: string, causationId: string): Promise<void> {
    const goalId = a.goalId;
    if (a.type === "CodePatch" && a.version === 1) {
      await this.deps.kernel.emit("patch.created", { artifactId: a.id, name: a.name }, { actorId: a.createdBy, goalId, causationId });
    }
    if (a.type === "RequirementsDoc" || a.type === "Requirement") {
      try {
        const doc = JSON.parse(content);
        const criteria = Array.isArray(doc) ? doc : doc.requirements ?? doc.criteria ?? [];
        if (Array.isArray(criteria) && criteria.length > 0) {
          await this.deps.kernel.emit(
            "requirements.created",
            {
              criteria: criteria
                .filter((c: any) => c && (c.id || c.text || c.description))
                .map((c: any) => ({
                  id: String(c.id ?? shortHash(String(c.text ?? c.description))),
                  description: String(c.text ?? c.description),
                  mandatory: c.mandatory ?? true,
                  status: "UNSATISFIED",
                  evidence: [],
                })),
              artifactId: a.id,
            },
            { actorId: a.createdBy, goalId, causationId },
          );
        }
      } catch {
        /* requirements doc may be markdown; criteria then come from goal config */
      }
    }
    if (a.type === "ReleasePlan" && a.version === 1) {
      await this.deps.kernel.emit("release.candidate", { artifactId: a.id, name: a.name }, { actorId: a.createdBy, goalId, causationId });
    }
    if (a.type === "ResearchReport") {
      const inReplyTo = (a.metadata as any)?.inReplyTo as string | undefined;
      await this.deps.kernel.emit("research.completed", { artifactId: a.id, name: a.name, inReplyTo }, { actorId: a.createdBy, goalId, causationId });
      await this.markCriterionEvidence("req-analysis", {
        kind: "research-report",
        artifactRef: { uri: artifactUri(a.type, a.name, a.version) },
        by: a.createdBy,
        recordedAt: a.createdAt,
      });
      if (inReplyTo && this.state.messages.has(inReplyTo)) {
        const req = this.state.messages.get(inReplyTo)!;
        await this.sendMessage({
          from: a.createdBy,
          to: [req.from],
          type: "INFORM",
          threadId: req.threadId,
          replyTo: inReplyTo,
          artifactRefs: [{ uri: artifactUri(a.type, a.name, a.version), version: a.version }],
          payload: { summary: `Research complete: ${a.name}`, contentRef: a.contentRef },
        });
      }
    }
  }

  async transitionArtifact(
    actorId: string,
    artifactId: string,
    transition: { to: ArtifactStatus; evidenceEventIds?: string[]; comment?: string },
  ): Promise<{ ok: boolean; reason?: string; eventId?: string }> {
    const goalId = this.state.activeGoalId;
    if (!goalId) return { ok: false, reason: "no active goal" };
    const artifact = this.state.artifacts.get(artifactId);
    if (!artifact) return { ok: false, reason: `unknown artifact ${artifactId}` };
    const ctx = { config: this.config, projections: this.state, goal: this.state.goals.get(goalId) };
    const decision = this.deps.policy.evaluateTransition(artifact, transition.to, actorId, ctx);
    if (decision.decision !== "ALLOW") {
      await this.denied(actorId, artifactId, `transition -> ${transition.to}`, decision);
      return { ok: false, reason: decision.reason };
    }
    try {
      const evt = await this.deps.kernel.emit(
        "artifact.transition",
        {
          artifactId,
          to: transition.to,
          actorId,
          evidenceEventIds: transition.evidenceEventIds,
          comment: transition.comment,
          gateSatisfied: decision.decision === "ALLOW",
        },
        { actorId, goalId },
      );
      await this.mirrorTransition(artifact, transition.to, evt.id);
      return { ok: true, eventId: evt.id };
    } catch (err) {
      if (err instanceof KernelRejectedError) return { ok: false, reason: err.message };
      throw err;
    }
  }

  private async mirrorTransition(a: Artifact, to: ArtifactStatus, causationId: string): Promise<void> {
    if (a.type === "CodePatch" && to === "MERGED") {
      await this.deps.kernel.emit("patch.merged", { artifactId: a.id, name: a.name }, { actorId: a.owner, goalId: a.goalId, causationId });
      await this.deps.kernel.emit("implementation.completed", { artifactId: a.id, subject: "implementation" }, { actorId: a.owner, goalId: a.goalId, causationId });
    }
    if (a.type === "ReleasePlan") {
      await this.deps.kernel.emit("release.transition", { artifactId: a.id, to }, { goalId: a.goalId, causationId });
      if (to === "ACCEPTED") {
        await this.deps.kernel.emit("release.accepted", { artifactId: a.id, subject: `artifact:${a.id}` }, { goalId: a.goalId, causationId });
        await this.markCriterionEvidence("implementation-merged", { kind: "release-accepted", artifactRef: { uri: artifactUri(a.type, a.name, a.version) }, by: a.owner, recordedAt: this.deps.kernel.clock.iso() });
      }
    }
    if (to === "APPROVED" && (a.type === "ArchitectureDocument" || a.type === "ApiSpec")) {
      await this.markCriterionEvidence("architecture-approved", {
        kind: "architecture-approved",
        artifactRef: { uri: artifactUri(a.type, a.name, a.version) },
        by: a.owner,
        recordedAt: this.deps.kernel.clock.iso(),
      });
    }
    if (to === "MERGED") {
      await this.markCriterionEvidence("implementation-merged", {
        kind: "patch-merged",
        artifactRef: { uri: artifactUri(a.type, a.name, a.version) },
        recordedAt: this.deps.kernel.clock.iso(),
      });
    }
  }

  async markCriterionEvidence(criterionId: string, evidence: Goal["acceptanceCriteria"][number]["evidence"][number]): Promise<void> {
    const goalId = this.state.activeGoalId;
    if (!goalId) return;
    const goal = this.state.goals.get(goalId);
    if (!goal) return;
    const c = goal.acceptanceCriteria.find((x) => x.id === criterionId);
    if (!c) return;
    if (c.status === "EVIDENCED" || c.status === "WAIVED") return;
    await this.deps.kernel.emit("requirement.satisfied", { criterionId, evidence }, { actorId: HUMAN_AGENT_ID, goalId });
    const updated = goal.acceptanceCriteria.filter((x) => x.mandatory && (x.status === "EVIDENCED" || x.status === "WAIVED")).length;
    const total = goal.acceptanceCriteria.filter((x) => x.mandatory).length;
    await this.deps.kernel.emit("goal.progress", { completed: updated, total, ratio: total ? updated / total : 0 }, { goalId });
  }

  async requestApproval(artifactId: string, roleOrAgent: string): Promise<SendResult> {
    const a = this.state.artifacts.get(artifactId);
    if (!a) return { accepted: false, reason: "unknown artifact" };
    const reviewers = [...this.state.agents.values()]
      .filter((r) => r.definition.role === roleOrAgent || r.definition.id === roleOrAgent)
      .map((r) => r.definition.id);
    if (reviewers.length === 0) return { accepted: false, reason: `no agent with role ${roleOrAgent}` };
    return this.sendMessage({
      from: a.owner,
      to: reviewers,
      type: "REQUEST_REVIEW",
      newThread: { subject: `review ${a.name}`, artifactRefs: [{ uri: artifactUri(a.type, a.name, a.version) }] },
      artifactRefs: [{ uri: artifactUri(a.type, a.name, a.version) }],
      payload: { question: `Please review ${a.type} '${a.name}' v${a.version}` },
    });
  }

  async recordDecision(actorId: string, kind: ApprovalKind, subject: string, artifactId?: string, comment?: string): Promise<{ ok: boolean; reason?: string; eventId?: string }> {
    const goalId = this.state.activeGoalId;
    if (!goalId) return { ok: false, reason: "no active goal" };
    const ctx = { config: this.config, projections: this.state, goal: this.state.goals.get(goalId) };
    const domain = this.domainOfSubject(subject, artifactId);
    const artifact = artifactId ? this.state.artifacts.get(artifactId) : undefined;
    if (subject.startsWith("criterion:") && (kind === "approve" || kind === "accept")) {
      const criterionId = subject.slice("criterion:".length);
      if (!artifactId && !comment) {
        const reason = "criterion acceptance requires evidence (artifactId and/or comment describing the evidence)";
        await this.denied(actorId, subject, "accept criterion", { decision: "DENY", reason, ruleId: "evidence-required" });
        return { ok: false, reason };
      }
      const acceptCheck = this.deps.policy.evaluateAuthority(actorId, "requirements", "accept", ctx);
      const overrideCheck = this.deps.policy.evaluateAuthority(actorId, "requirements", "approve", ctx);
      if (acceptCheck.decision !== "ALLOW" && overrideCheck.decision !== "ALLOW") {
        await this.denied(actorId, subject, "accept criterion", acceptCheck);
        return { ok: false, reason: acceptCheck.reason };
      }
      const evt = await this.deps.kernel.emit(
        "review.approved",
        {
          subject: `criterion:${criterionId}`,
          artifactId,
          artifactRef: artifact ? { uri: artifactUri(artifact.type, artifact.name, artifact.version) } : undefined,
          actorId,
          actorRole: this.state.agents.get(actorId)?.definition.role ?? actorId,
          comment,
        },
        { actorId, goalId },
      );
      await this.markCriterionEvidence(criterionId, {
        kind: "criteria-acceptance",
        artifactRef: artifact ? { uri: artifactUri(artifact.type, artifact.name, artifact.version) } : undefined,
        eventId: evt.id,
        by: actorId,
        recordedAt: this.deps.kernel.clock.iso(),
      });
      return { ok: true, eventId: evt.id };
    }
    let authorityCheck = this.deps.policy.evaluateAuthority(actorId, domain, kind, ctx);
    if (authorityCheck.decision !== "ALLOW" && artifact && (kind === "approve" || kind === "reject")) {
      const reviewCap = this.capabilityForReview(artifact);
      if (reviewCap) {
        const capCheck = this.deps.policy.evaluateCapability(actorId, reviewCap, ctx);
        if (capCheck.decision === "ALLOW" && (artifact.owner !== actorId || !this.hasPeerReviewer(actorId, artifact))) {
          authorityCheck = capCheck;
        }
      }
    }
    if (authorityCheck.decision !== "ALLOW") {
      await this.denied(actorId, artifactId ?? subject, `${kind} ${subject}`, authorityCheck);
      return { ok: false, reason: authorityCheck.reason };
    }
    if (artifact && artifact.owner === actorId && (kind === "approve" || kind === "pass") && this.hasPeerReviewer(actorId, artifact)) {
      const reason = "artifact owner cannot approve their own artifact";
      await this.denied(actorId, artifactId, "self-approval", { decision: "DENY", reason, ruleId: "self-approval" });
      return { ok: false, reason };
    }
    const payload = {
      subject: artifactId ? `artifact:${artifactId}` : subject,
      fallbackSubject: subject,
      artifactId,
      artifactRef: artifact ? { uri: artifactUri(artifact.type, artifact.name, artifact.version) } : undefined,
      actorId,
      actorRole: this.state.agents.get(actorId)?.definition.role ?? actorId,
      comment,
    };
    let type: EventType;
    if (kind === "approve" || kind === "pass") type = "review.approved";
    else if (kind === "reject" || kind === "veto") type = "review.rejected";
    else if (kind === "block") type = "message.sent";
    else type = "review.approved";
    if (domain === "architecture" && kind === "approve") {
      const evt = await this.deps.kernel.emit("architecture.approved", { ...payload, subject: "architecture" }, { actorId, goalId });
      await this.auditTransition(artifactId, evt.id, goalId);
      await this.markCriterionEvidence("architecture-approved", { kind: "approval", by: actorId, recordedAt: this.deps.kernel.clock.iso() });
      return { ok: true, eventId: evt.id };
    }
    if (kind === "block") {
      const requesters = [...this.state.pendingRequests.values()]
        .filter((pr) => pr.to.includes(actorId) && pr.type.startsWith("REQUEST"))
        .map((pr) => pr.from);
      const targets = artifact ? [artifact.owner] : [HUMAN_AGENT_ID, ...new Set(requesters)];
      const m = await this.sendMessage({
        from: actorId,
        to: targets,
        type: "BLOCK",
        newThread: { subject: `BLOCK ${subject}` },
        artifactRefs: artifact ? [{ uri: artifactUri(artifact.type, artifact.name, artifact.version) }] : [],
        payload: { subject: domain, artifactId, reason: comment ?? "blocked" },
        priority: "HIGH",
      });
      if (!m.accepted) {
        await this.deps.kernel.emit("review.rejected", { subject, artifactId, actorId, actorRole: this.state.agents.get(actorId)?.definition.role ?? actorId, comment, blockedInstead: true }, { actorId, goalId });
      }
      return { ok: m.accepted, reason: m.reason, eventId: m.eventId };
    }
    const evt = await this.deps.kernel.emit(type, payload, { actorId, goalId });
    await this.auditTransition(artifactId, evt.id, goalId);
    if (kind === "pass" && (domain === "quality" || domain === "release")) {
      await this.markCriterionEvidence(domain === "quality" ? "quality-verified" : "security-verified", {
        kind: `${domain}-pass`,
        by: actorId,
        recordedAt: this.deps.kernel.clock.iso(),
      });
    }
    if (kind === "pass" && domain === "security") {
      await this.markCriterionEvidence("security-verified", { kind: "security-pass", by: actorId, recordedAt: this.deps.kernel.clock.iso() });
    }
    return { ok: true, eventId: evt.id };
  }

  private domainOfSubject(subject: string, artifactId?: string): string {
    if (subject.startsWith("criterion:")) return "requirements";
    if (["architecture", "implementation", "quality", "security", "requirements", "release"].includes(subject)) return subject;
    const artifact = artifactId ? this.state.artifacts.get(artifactId) : undefined;
    if (artifact) {
      switch (artifact.type) {
        case "ArchitectureDocument":
        case "ApiSpec":
        case "ADR":
          return "architecture";
        case "CodePatch":
          return "implementation";
        case "ReleasePlan":
          return "release";
        case "TestReport":
          return "quality";
        case "SecurityReport":
          return "security";
        case "RequirementsDoc":
        case "Requirement":
          return "requirements";
        default:
          return subject;
      }
    }
    return subject;
  }

  private async denied(actorId: string, subjectId: string | undefined, action: string, decision: PolicyDecisionResult): Promise<void> {
    const goalId = this.state.activeGoalId ?? undefined;
    await this.deps.kernel.emit(
      "message.rejected",
      { from: actorId, action, subject: subjectId, reason: decision.reason, ruleId: decision.ruleId, denied: true },
      { actorId, goalId },
    );
  }

  async claimTask(actorId: string, taskId: string): Promise<{ ok: boolean; reason?: string }> {
    const task = this.state.tasks.get(taskId);
    if (!task) return { ok: false, reason: "unknown task" };
    if (task.status !== "OPEN" && task.assignedTo !== actorId) return { ok: false, reason: `task is ${task.status}` };
    const ctx = { config: this.config, projections: this.state, goal: this.state.goals.get(task.goalId) };
    for (const cap of task.requiredCapabilities) {
      const decision = this.deps.policy.evaluateCapability(actorId, cap, ctx);
      if (decision.decision !== "ALLOW") {
        await this.denied(actorId, taskId, `claim task (missing capability ${cap})`, decision);
        return { ok: false, reason: `missing capability ${cap}: ${decision.reason}` };
      }
    }
    await this.deps.kernel.emit("task.claimed", { taskId, agentId: actorId, reassign: task.assignedTo && task.assignedTo !== actorId }, { actorId });
    return { ok: true };
  }

  async completeTask(actorId: string, taskId: string, summary: string, artifacts?: ArtifactRef[]): Promise<{ ok: boolean; reason?: string }> {
    const task = this.state.tasks.get(taskId);
    if (!task) return { ok: false, reason: "unknown task" };
    if (task.status !== "CLAIMED" && task.status !== "IN_PROGRESS") return { ok: false, reason: `task is ${task.status}` };
    if (task.claimedBy !== actorId && actorId !== HUMAN_AGENT_ID) return { ok: false, reason: `task claimed by ${task.claimedBy}` };
    const gate = this.config.transitionGates["implementation.completed"];
    if (gate && gate.length > 0 && task.requiredCapabilities.includes("implementation.gate")) {
      const res = checkApprovals(this.state, gate, undefined);
      if (!res.ok) return { ok: false, reason: `implementation gate unsatisfied, missing: ${res.missing.join(", ")}` };
    }
    await this.deps.kernel.emit("task.completed", { taskId, agentId: actorId, summary, artifacts }, { actorId });
    return { ok: true };
  }

  async proposeDecision(actorId: string, topic: string, decision: Record<string, unknown>, evidence?: ArtifactRef[]): Promise<DecisionRecord> {
    const goalId = this.state.activeGoalId!;
    const d: DecisionRecord = {
      id: newDecisionId(),
      goalId,
      topic,
      decision,
      status: "PROPOSED",
      proposedBy: actorId,
      approvedBy: [],
      evidence: evidence ?? [],
      createdAt: this.deps.kernel.clock.iso(),
    };
    await this.deps.kernel.emit("decision.proposed", { decision: d }, { actorId, goalId });
    return d;
  }

  async ratifyDecision(actorId: string, decisionId: string): Promise<{ ok: boolean; reason?: string }> {
    const d = this.state.decisions.get(decisionId);
    if (!d) return { ok: false, reason: "unknown decision" };
    const ctx = { config: this.config, projections: this.state, goal: this.state.goals.get(this.state.activeGoalId ?? "") };
    const decisionResult = this.deps.policy.evaluateAuthority(actorId, "architecture", "approve", ctx);
    if (decisionResult.decision !== "ALLOW") {
      await this.denied(actorId, decisionId, "ratify decision", decisionResult);
      return { ok: false, reason: decisionResult.reason };
    }
    await this.deps.kernel.emit("decision.ratified", { decisionId, approvedBy: [actorId], actorRole: d.approvedBy }, { actorId });
    return { ok: true };
  }

  async escalate(input: {
    reason: string;
    raisedBy: string;
    detail?: unknown;
    conflictKey?: string;
    artifactId?: string;
    threadId?: string;
    participants?: string[];
  }): Promise<Escalation> {
    const goalId = this.state.activeGoalId ?? "";
    const conflictKey = input.conflictKey ?? `esc:${shortHash(input.reason + JSON.stringify(input.detail ?? ""))}`;
    const existing = [...this.state.escalations.values()].find((e) => e.status === "OPEN" && e.conflictKey === conflictKey);
    if (existing) return existing;
    let disagreementRef: ArtifactRef | undefined;
    const positions = this.buildDisagreementContent(input);
    const created = await this.createArtifact({
      actorId: HUMAN_AGENT_ID,
      name: `decision-conflict-${shortHash(conflictKey)}`,
      type: "DisagreementRecord",
      content: JSON.stringify(positions, null, 2),
      metadata: { conflictKey, participants: input.participants ?? [] },
      provenanceSource: "system",
    });
    if ("artifact" in created) {
      disagreementRef = { uri: created.uri };
    }
    const esc: Escalation = {
      id: newEscalationId(),
      goalId,
      reason: input.reason,
      detail: { ...(typeof input.detail === "object" && input.detail !== null ? input.detail : { detail: input.detail }), disagreementRef },
      raisedBy: input.raisedBy,
      conflictKey,
      disagreementArtifactRef: disagreementRef,
      status: "OPEN",
      createdAt: this.deps.kernel.clock.iso(),
    };
    await this.deps.kernel.emit("escalation.requested", { escalation: esc }, { actorId: input.raisedBy, goalId });
    return esc;
  }

  /**
   * The scheduler nudged this agent about an unanswered request MAX times and
   * it still hasn't resolved. Turn that into a real protocol escalation (stale
   * mate) instead of silently burning budget forever (§33.4 / §34).
   */
  async escalateStuckRequest(agentId: string, messageId: string): Promise<void> {
    const pending = this.state.pendingRequests.get(messageId);
    if (!pending) return;
    const request = this.state.messages.get(messageId);
    await this.escalate({
      reason: "stalemate:unanswered_request",
      raisedBy: "deadlock-detector",
      conflictKey: `stuck:${messageId}:${agentId}`,
      detail: {
        agentId,
        requestMessageId: messageId,
        requestType: request?.type,
        awaitingSince: pending.createdAt,
        note: "no progress on this request after the nudge limit; needs an operator decision or a rework of the workflow",
      },
    });
  }

  private buildDisagreementContent(input: { reason: string; artifactId?: string; threadId?: string }): Record<string, unknown> {
    const positions: Array<Record<string, unknown>> = [];
    const artifact = input.artifactId ? this.state.artifacts.get(input.artifactId) : undefined;
    const relevant = [...this.state.messages.values()].filter((m) => {
      if (input.threadId && m.threadId !== input.threadId) return false;
      if (artifact && !m.artifactRefs.some((r) => r.uri.includes(artifact.name))) return false;
      return ["REJECT", "BLOCK", "VETO", "CHALLENGE", "APPROVE", "ESCALATE"].includes(m.type);
    });
    for (const m of relevant.slice(-20)) {
      positions.push({
        agent: m.from,
        stance: m.type,
        at: m.timestamp,
        message: JSON.stringify(m.payload).slice(0, 300),
        attempts: m.artifactRefs.map((r) => r.uri),
      });
    }
    const evidence = artifact
      ? this.state.artifactHistory.get(artifact.id)?.map((v) => ({ version: v.version, digest: v.digest, status: v.status })) ?? []
      : [];
    return {
      reason: input.reason,
      positions,
      evidence,
      remainingDisagreement: positions.filter((p) => ["REJECT", "BLOCK", "VETO", "CHALLENGE"].includes(p.stance as string)).map((p) => p.agent),
    };
  }

  async respondEscalation(escalationId: string, response: string, by = HUMAN_AGENT_ID): Promise<{ ok: boolean; reason?: string }> {
    const esc = this.state.escalations.get(escalationId);
    if (!esc) return { ok: false, reason: "unknown escalation" };
    if (esc.status !== "OPEN") return { ok: false, reason: `escalation is ${esc.status}` };
    await this.deps.kernel.emit("escalation.responded", { escalationId, response, respondedBy: by }, { actorId: by });
    await this.deps.kernel.emit("human.input", { action: "escalation_response", escalationId, response }, { actorId: HUMAN_AGENT_ID });
    const goal = this.state.goals.get(esc.goalId);
    if (goal && goal.status === "ESCALATED") {
      await this.deps.kernel.emit("goal.status_changed", { goalId: goal.id, status: "ACTIVE", reason: "escalation responded" }, { actorId: HUMAN_AGENT_ID });
    }
    if (esc.raisedBy && esc.raisedBy !== HUMAN_AGENT_ID && this.state.agents.has(esc.raisedBy)) {
      await this.sendMessage({
        from: HUMAN_AGENT_ID,
        to: [esc.raisedBy],
        type: "INFORM",
        newThread: { subject: `escalation response ${escalationId}` },
        payload: { escalationId, response },
        priority: "URGENT",
      });
    }
    for (const c of this.recoveryCandidates()) {
      if (c !== esc.raisedBy) await this.activateAgent(c, { kind: "recovery", note: "escalation responded" });
    }
    return { ok: true };
  }

  async pauseGoal(goalId?: GoalId): Promise<void> {
    const gid = goalId ?? this.state.activeGoalId;
    if (!gid) return;
    await this.deps.kernel.emit("goal.paused", { goalId: gid, reason: "user pause" }, { actorId: HUMAN_AGENT_ID });
  }

  async resumeGoal(goalId?: GoalId): Promise<void> {
    const gid = goalId ?? this.state.activeGoalId;
    if (!gid) return;
    await this.deps.kernel.emit("goal.resumed", { goalId: gid, reason: "user resume" }, { actorId: HUMAN_AGENT_ID });
    for (const c of this.recoveryCandidates()) {
      await this.activateAgent(c, { kind: "recovery", note: "goal resumed" });
    }
  }

  async replay(goalId: GoalId, upToSeq?: number): Promise<ReplayState> {
    const events = await this.deps.store.read({ goalId });
    const limited = upToSeq !== undefined ? events.filter((e) => (e.seq ?? 0) <= upToSeq) : events;
    const fresh: Projections = JSON.parse(JSON.stringify(null)) as Projections; // placeholder replaced below
    void fresh;
    const { createInitialState } = await import("./state");
    const state = createInitialState();
    for (const e of limited) applyEvent(state, e, { transitionGates: this.config.transitionGates });
    const goal = state.goals.get(goalId);
    return {
      goalId,
      asOfSeq: limited.length ? limited[limited.length - 1].seq ?? 0 : 0,
      goal,
      agents: [...state.agents.values()].map((a) => a.state),
      artifacts: [...state.artifacts.values()],
      threads: [...state.threads.values()],
      tasks: [...state.tasks.values()],
      decisions: [...state.decisions.values()],
      approvals: [...state.approvals.values()].flat(),
      escalations: [...state.escalations.values()],
      budgets: [...state.budgets.values()].map((b) => ({
        key: b.key,
        limit: b.limit,
        limitKind: b.limitKind,
        reserved: b.reserved,
        consumed: b.consumed,
        exceeded: b.exceeded,
      })),
      leases: [...state.leases.values()],
      eventCount: limited.length,
    };
  }

  // ------------------------------------------------------------- turn execution

  async runTurn(agentId: string, reason: ActivationReason): Promise<void> {
    if (this.turnInFlight.has(agentId)) return;
    const rec = this.state.agents.get(agentId);
    if (!rec) return;
    if (agentId === HUMAN_AGENT_ID) return;
    if (rec.state.lifecycle === "SUSPENDED" || rec.state.lifecycle === "COMPLETED") return;
    const goalId = this.state.activeGoalId;
    if (!goalId) return;
    const goal = this.state.goals.get(goalId);
    if (!goal || goal.status === "PAUSED" || goal.status === "ESCALATED" || goal.status === "COMPLETED" || goal.status === "FAILED") return;

    this.turnInFlight.add(agentId);
    const turnId = `turn-${shortHash(agentId + Date.now() + Math.random())}`;
    try {
      // budget reservation
      const reserve = await this.deps.budget.reserve(
        agentKey(goalId, agentId),
        "tokens",
        TURN_RESERVE_TOKENS,
        this.state.agents.get(agentId)?.definition.budget.tokens ?? null,
        { actorId: agentId },
      );
      if (reserve.blocked) {
        await this.deps.kernel.emit("agent.state_changed", { agentId, to: "BLOCKED", note: `budget: ${reserve.reason}` }, { actorId: agentId });
        await this.escalate({ reason: "budget_exhausted", raisedBy: agentId, detail: { key: agentKey(goalId, agentId), reason: reserve.reason } });
        return;
      }
      if (reason.threadId) {
        const tk = threadKey(goalId, reason.threadId);
        const tReserve = await this.deps.budget.reserve(tk, "tokens", TURN_RESERVE_TOKENS, this.config.budgets.threadTokens, { actorId: agentId });
        if (tReserve.blocked) {
          await this.deps.budget.release(agentKey(goalId, agentId), reserve.reservationId);
          await this.escalate({ reason: "thread_budget_exhausted", raisedBy: agentId, detail: { threadId: reason.threadId } });
          return;
        }
      }

      if (rec.state.lifecycle === "STARTING") {
        await this.deps.kernel.emit("agent.started", { agentId, sessionId: null, runtime: rec.definition.runtime }, { actorId: agentId });
      }
      const activationEvt = await this.deps.kernel.emit("agent.awakened", { agentId, reason }, { actorId: agentId });
      await this.deps.kernel.emit("agent.state_changed", { agentId, to: "OBSERVING" }, { actorId: agentId, causationId: activationEvt.id });

      const session = await this.ensureSession(agentId);
      // build context from undelivered mail first, then drain via delivery events
      const taskHint = rec.state.activeTaskId ? this.state.tasks.get(rec.state.activeTaskId) : undefined;
      const bundle = buildAgentContext({ config: this.config, kernel: this.deps.kernel }, agentId, taskHint);
      const unread = [...(this.state.unread.get(agentId) ?? [])];
      for (const mid of unread) {
        await this.deps.kernel.emit("message.delivered", { agentId, messageId: mid }, { actorId: agentId, causationId: activationEvt.id });
      }
      const instructions = renderContextInstructions(bundle) + `\n\n## Why you were woken\n${describeReason(reason)}\n\nEmit your reply as mesh operations.`;

      await this.deps.kernel.emit("agent.state_changed", { agentId, to: "THINKING" }, { actorId: agentId, causationId: activationEvt.id });
      const input: AgentInput = { agentId, goalId, activation: reason, context: bundle, instructions };

      const turn: TurnState = { turnId, agentId, reason, sentOps: 0, publishedOps: 0, waitRequested: false, escalated: false, results: [] };
      this.deps.hooks?.onAgentTurnStart?.(agentId, turnId);
      const output = await this.callRuntimeWithTimeout(agentId, session, input, turnId);
      this.auditTurn(turnId, agentId, input, output);
      if (output.error) throw new RuntimeFailure(output.error);

      for (const op of output.operations) {
        const result = await this.executeOp(agentId, op, turn);
        if (process.env.MESH_OP_DEBUG) console.error(`[op] ${agentId} ${op.op} -> ${result.ok}${result.reason ? " " + result.reason : ""}${result.messageId ? " msg:" + result.messageId : ""}${result.artifactId ? " art:" + result.artifactId : ""}`);
        turn.results.push(result);
      }

      const tokens = output.tokensUsed?.total ?? 0;
      await this.deps.budget.consume(agentKey(goalId, agentId), "tokens", tokens, reserve.reservationId, {
        model: output.model,
        modelVersion: output.modelVersion,
        temperature: output.temperature,
        input: output.tokensUsed?.input,
        output: output.tokensUsed?.output,
        toolCalls: output.toolCalls?.length ?? 0,
        turnId,
      }, { actorId: agentId });
      await this.deps.budget.consume(missionKey(goalId), "tokens", tokens, undefined, { agentId, turnId }, { actorId: agentId });
      if (reason.threadId) {
        await this.deps.budget.consume(threadKey(goalId, reason.threadId), "tokens", tokens, undefined, { agentId, turnId }, { actorId: agentId });
      }

      // derive end state: escalate -> BLOCKED, outstanding request or wait -> WAITING, otherwise IDLE
      const stillPending = [...this.state.pendingRequests.values()].some((pr) => pr.from === agentId);
      let target: LifecycleState = "IDLE";
      if (turn.escalated) target = "BLOCKED";
      else if (turn.waitRequested || stillPending) target = "WAITING";
      await this.deps.kernel.emit("agent.state_changed", { agentId, from: "THINKING", to: target, turnId }, { actorId: agentId });
      if (output.summary) {
        await this.rememberMemory(agentId, `turn:${turnId}`, output.summary);
      }
      this.deps.hooks?.onAgentTurnEnd?.(agentId, turnId, true);
    } catch (err) {
      this.deps.hooks?.onAgentTurnEnd?.(agentId, turnId, false);
      if (err instanceof KernelRejectedError) {
        this.auditLine(`kernel rejection during turn ${turnId} for ${agentId}: ${err.message}`);
        await this.deps.kernel
          .emit("agent.state_changed", { agentId, to: "IDLE", note: `kernel rejected: ${err.message}` }, { actorId: agentId })
          .catch(() => undefined);
      } else {
        await this.handleAgentFailure(agentId, (err as Error).message, reason);
      }
    } finally {
      this.turnInFlight.delete(agentId);
      this.deps.scheduler.notifyTurnFinished(agentId);
      void this.afterActivity();
    }
  }

  private async callRuntimeWithTimeout(agentId: string, session: { session: import("../../protocol/src/index").AgentSession; runtime: AgentRuntime }, input: AgentInput, turnId: string): Promise<AgentOutput> {
    const timeoutMs = this.config.scheduling.turnTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        session.runtime.interrupt(session.session).catch(() => undefined);
        reject(new RuntimeFailure(`turn timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([session.runtime.send(session.session, input), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private auditTurn(turnId: string, agentId: string, input: AgentInput, output: AgentOutput): void {
    this.auditLine(
      JSON.stringify({
        turnId,
        agentId,
        at: new Date().toISOString(),
        activation: input.activation,
        model: output.model,
        modelVersion: output.modelVersion,
        temperature: output.temperature,
        inputDigest: shortHash(JSON.stringify(input.context.unreadMail.map((m) => m.id))),
        outputDigest: shortHash(output.text),
        ops: output.operations.map((o) => o.op),
        toolCalls: output.toolCalls ?? [],
        tokens: output.tokensUsed,
      }),
    );
  }

  private async handleAgentFailure(agentId: string, error: string, reason: ActivationReason): Promise<void> {
    await this.deps.kernel
      .emit("agent.failed", { agentId, error, sessionId: null, restartable: this.config.agents[agentId]?.sessionPolicy.persistent ?? false }, { actorId: agentId })
      .catch(() => undefined);
    this.sessions.delete(agentId);
    const attempts = (this.restartAttempts.get(agentId) ?? 0) + 1;
    this.restartAttempts.set(agentId, attempts);
    if (attempts <= 3 && this.config.agents[agentId]?.sessionPolicy.persistent) {
      await this.deps.kernel.emit("agent.restarted", { agentId, attempt: attempts }, { actorId: HUMAN_AGENT_ID });
      const rec = this.state.agents.get(agentId);
      if (rec) {
        // FAILED -> STARTING handled by reducer via agent.restarted; then idle
        await this.deps.kernel.emit("agent.state_changed", { agentId, to: "IDLE" }, { actorId: HUMAN_AGENT_ID });
      }
      setTimeout(() => {
        void this.activateAgent(agentId, { kind: "recovery", note: `restart after failure: ${error}`, eventId: reason.eventId }).catch(() => undefined);
      }, 20);
    } else {
      const activeTask = this.state.agents.get(agentId)?.state.activeTaskId;
      if (activeTask) {
        await this.deps.kernel.emit("task.claimed", { taskId: activeTask, agentId: null }, { actorId: HUMAN_AGENT_ID });
      }
      await this.escalate({ reason: "runtime_failure", raisedBy: "recovery-manager", detail: { agentId, error, attempts } });
    }
  }

  private async ensureSession(agentId: string): Promise<{ session: import("../../protocol/src/index").AgentSession; runtime: AgentRuntime }> {
    const existing = this.sessions.get(agentId);
    const rec = this.state.agents.get(agentId)!;
    const runtime = this.deps.runtimes.resolve(rec.definition.runtime);
    if (existing) {
      const status = await runtime.getStatus(existing.session).catch(() => "UNREACHABLE" as AgentRuntimeStatus);
      if (status !== "UNREACHABLE" && status !== "STOPPED") return existing;
      this.sessions.delete(agentId);
    }
    const context = await this.buildRuntimeContext(agentId);
    let session: import("../../protocol/src/index").AgentSession | null = null;
    if (rec.definition.sessionPolicy.persistent && runtime.restoreSession) {
      const previous = this.state.sessionMap.get(agentId) ?? (await this.deps.sessionRegistry?.lookup(agentId).catch(() => null));
      if (previous) {
        session = await runtime.restoreSession(rec.definition, previous.sessionId, context).catch(() => null);
      }
    }
    if (!session) {
      session = await runtime.start(rec.definition, context);
      if (rec.state.lifecycle === "STARTING") {
        await this.deps.kernel.emit("agent.started", { agentId, sessionId: session.sessionId, runtime: runtime.name }, { actorId: agentId });
      }
    } else {
      await this.deps.kernel.emit("agent.restarted", { agentId, sessionId: session.sessionId, restored: true }, { actorId: agentId });
    }
    const entry = { session, runtime };
    this.sessions.set(agentId, entry);
    if (this.deps.sessionRegistry) {
      await this.deps.sessionRegistry.record(agentId, session.sessionId, runtime.name).catch(() => undefined);
    }
    return entry;
  }

  private async buildRuntimeContext(agentId: string): Promise<RuntimeContext> {
    const rec = this.state.agents.get(agentId)!;
    return {
      goalId: this.state.activeGoalId ?? "",
      meshId: this.config.meshId,
      workspacePath: await this.agentWorkspace(agentId),
      busUrl: process.env.MESH_BUS_URL ?? `http://${this.config.server.host}:${this.config.server.port}`,
      agentToken: `${this.config.meshId}:${agentId}:${shortHash(this.state.activeGoalId ?? "x")}`,
      rolePromptText: rec.definition.prompt.text ?? "",
      capabilityGrants: rec.definition.capabilities,
      env: { MESH_AGENT_ID: agentId, MESH_GOAL_ID: this.state.activeGoalId ?? "" },
    };
  }

  async agentWorkspace(agentId: string): Promise<string> {
    if (this.deps.workspace && (this.config.agents[agentId]?.capabilities.includes("repository.write") ?? false)) {
      return this.deps.workspace.ensureWorktree(agentId);
    }
    return this.config.workspacePath;
  }

  // ----------------------------------------------------------------- ops

  async executeOp(actorId: string, op: MeshOp, turn: TurnState): Promise<OpResult> {
    const goalId = this.state.activeGoalId;
    if (!goalId) return { ok: false, op: op.op, reason: "no active goal" };
    try {
      switch (op.op) {
        case "send": {
          if (!this.state.agents.get(actorId)) return { ok: false, op: op.op, reason: "unknown sender" };
          const res = await this.sendMessage({
            from: actorId,
            to: op.to,
            type: op.type,
            threadId: op.threadId,
            newThread: op.newThread,
            replyTo: op.replyTo,
            artifactRefs: op.artifactRefs,
            payload: op.payload,
            priority: op.priority,
            taskId: op.taskId,
            requires: op.requires,
            budgetHint: op.budgetHint,
          });
          turn.sentOps++;
          return res.accepted ? { ok: true, op: op.op, messageId: res.messageId, eventId: res.eventId } : { ok: false, op: op.op, reason: res.reason };
        }
        case "broadcast": {
          const targets = [...this.state.agents.keys()].filter((id) => id !== actorId && id !== HUMAN_AGENT_ID);
          const res = await this.sendMessage({ from: actorId, to: targets, type: op.type, newThread: { subject: `broadcast ${op.type}` }, payload: op.payload, artifactRefs: op.artifactRefs });
          turn.sentOps++;
          return res.accepted ? { ok: true, op: op.op, messageId: res.messageId } : { ok: false, op: op.op, reason: res.reason };
        }
        case "request_research": {
          const cache = this.researchCache(op.question);
          if (cache) {
            const res = await this.sendMessage({
              from: op.to,
              to: [actorId],
              type: "INFORM",
              newThread: { subject: `research answer (cached): ${op.question.slice(0, 60)}` },
              artifactRefs: [cache],
              payload: { summary: "Answer found in explorer cache (no model invoked).", contentRef: cache.uri },
            });
            turn.sentOps++;
            return { ok: res.accepted, op: op.op, messageId: res.messageId, reason: res.reason };
          }
          const res = await this.sendMessage({
            from: actorId,
            to: [op.to],
            type: "REQUEST_RESEARCH",
            newThread: { subject: `research: ${op.question.slice(0, 80)}`, artifactRefs: op.artifactRefs },
            artifactRefs: op.artifactRefs,
            payload: { question: op.question },
          });
          turn.sentOps++;
          return res.accepted ? { ok: true, op: op.op, messageId: res.messageId } : { ok: false, op: op.op, reason: res.reason };
        }
        case "respond": {
          const original = this.state.messages.get(op.messageId);
          if (!original) return { ok: false, op: op.op, reason: "unknown messageId for respond" };
          const res = await this.sendMessage({
            from: actorId,
            to: [original.from],
            type: op.type,
            threadId: original.threadId,
            replyTo: op.messageId,
            artifactRefs: op.artifactRefs,
            payload: op.payload,
          });
          turn.sentOps++;
          return res.accepted ? { ok: true, op: op.op, messageId: res.messageId } : { ok: false, op: op.op, reason: res.reason };
        }
        case "publish_artifact": {
          const res = await this.createArtifact({
            actorId,
            name: op.name,
            type: op.type,
            content: op.content,
            status: op.status,
            metadata: op.metadata,
            parentArtifactId: op.parentArtifactId,
            asVersionOf: op.asVersionOf,
          });
          if ("error" in res) return { ok: false, op: op.op, reason: res.error };
          turn.publishedOps++;
          return { ok: true, op: op.op, artifactId: res.artifact.id, artifactUri: res.uri, artifact: res.artifact };
        }
        case "read_artifact": {
          const a = this.findArtifactByUri(op.artifactRef);
          if (!a) return { ok: false, op: op.op, reason: "unknown artifact ref" };
          const content = await this.deps.content.read(a.contentRef);
          return { ok: true, op: op.op, reason: content };
        }
        case "transition_artifact": {
          const targetId = this.resolveArtifactRef(op.artifactId, op.artifactUri);
          if (!targetId) return { ok: false, op: op.op, reason: `unknown artifact ${op.artifactId ?? op.artifactUri}` };
          const res = await this.transitionArtifact(actorId, targetId, { to: op.to, comment: op.evidence });
          return { ok: res.ok, op: op.op, reason: res.reason, eventId: res.eventId };
        }
        case "request_review": {
          const a = this.state.artifacts.get(op.artifactId);
          if (!a) return { ok: false, op: op.op, reason: "unknown artifact" };
          const ctx = { config: this.config, projections: this.state, goal: this.state.goals.get(goalId) };
          const cap = this.capabilityForReview(a);
          if (cap) {
            const decision = this.deps.policy.evaluateCapability(actorId, cap, ctx);
            if (decision.decision !== "ALLOW") await this.denied(actorId, a.id, "request review", decision);
          }
          const tr = await this.transitionArtifact(actorId, a.id, { to: "READY_FOR_REVIEW" });
          if (!tr.ok && tr.reason && !tr.reason.includes("illegal")) return { ok: false, op: op.op, reason: tr.reason };
          const res = await this.sendMessage({
            from: actorId,
            to: op.reviewers,
            type: "REQUEST_REVIEW",
            newThread: { subject: `review ${a.name}`, artifactRefs: [{ uri: artifactUri(a.type, a.name, a.version) }] },
            artifactRefs: [{ uri: artifactUri(a.type, a.name, a.version) }],
            payload: { question: `Review ${a.type} ${a.name} v${a.version}` },
          });
          turn.sentOps++;
          return res.accepted ? { ok: true, op: op.op, messageId: res.messageId } : { ok: false, op: op.op, reason: res.reason };
        }
        case "approve": {
          const res = await this.recordDecision(actorId, op.kind === "pass" ? "pass" : "approve", op.subject, this.resolveArtifactRef(op.artifactId, op.artifactUri), op.comment);
          return { ok: res.ok, op: op.op, reason: res.reason, eventId: res.eventId };
        }
        case "reject": {
          const res = await this.recordDecision(actorId, "reject", op.subject, this.resolveArtifactRef(op.artifactId, op.artifactUri), op.comment);
          return { ok: res.ok, op: op.op, reason: res.reason, eventId: res.eventId };
        }
        case "veto": {
          const res = await this.recordDecision(actorId, "veto", op.subject, this.resolveArtifactRef(op.artifactId, op.artifactUri), op.comment);
          return { ok: res.ok, op: op.op, reason: res.reason, eventId: res.eventId };
        }
        case "block": {
          const res = await this.recordDecision(actorId, "block", op.subject, this.resolveArtifactRef(op.artifactId, op.artifactUri), op.reason);
          return { ok: res.ok, op: op.op, reason: res.reason, eventId: res.eventId };
        }
        case "delegate": {
          return this.opDelegate(actorId, op, turn);
        }
        case "create_task": {
          const task = this.newTask(actorId, op.title, op.description, op.requiredCapabilities, op.artifactRefs, undefined, op.budgetHint);
          await this.emitTaskCreated(task);
          if (op.assignedTo) {
            await this.sendMessage({ from: actorId, to: [op.assignedTo], type: "DELEGATE", newThread: { subject: `task ${task.id}: ${op.title}` }, payload: { taskId: task.id }, taskId: task.id });
            turn.sentOps++;
          }
          return { ok: true, op: op.op, taskId: task.id };
        }
        case "claim_task": {
          const res = await this.claimTask(actorId, op.taskId);
          return { ok: res.ok, op: op.op, reason: res.reason };
        }
        case "complete_task": {
          const isWorker = this.workerInfo.get(actorId)?.taskId === op.taskId;
          const res = await this.completeTask(actorId, op.taskId, op.summary, op.artifacts);
          if (res.ok && isWorker) {
            const info = this.workerInfo.get(actorId)!;
            const result: SubAgentResult = {
              status: "COMPLETED",
              summary: op.summary,
              artifacts: op.artifacts ?? [],
              findings: [],
              risks: [],
              recommendation: "review the produced artifacts",
            };
            await this.deliverWorkerResult(actorId, info, result);
          }
          return { ok: res.ok, op: op.op, reason: res.reason };
        }
        case "propose_decision": {
          const d = await this.proposeDecision(actorId, op.topic, op.decision, op.evidence);
          return { ok: true, op: op.op, reason: d.id };
        }
        case "ratify_decision": {
          const res = await this.ratifyDecision(actorId, op.decisionId);
          return { ok: res.ok, op: op.op, reason: res.reason };
        }
        case "escalate": {
          const esc = await this.escalate({ reason: op.reason, raisedBy: actorId, detail: op.detail, conflictKey: op.conflictKey });
          turn.escalated = true;
          return { ok: true, op: op.op, escalationId: esc.id };
        }
        case "wait": {
          turn.waitRequested = true;
          return { ok: true, op: op.op };
        }
        case "done": {
          const task = this.state.agents.get(actorId)?.state.activeTaskId;
          if (task) {
            const t = this.state.tasks.get(task);
            if (t && (t.status === "CLAIMED" || t.status === "IN_PROGRESS")) {
              await this.completeTask(actorId, task, op.summary ?? "done");
            }
          }
          return { ok: true, op: op.op };
        }
        case "remember": {
          await this.rememberMemory(actorId, op.key, op.value);
          return { ok: true, op: op.op };
        }
        case "acquire_lease": {
          return this.opAcquireLease(actorId, op.artifactId, op.files);
        }
        case "release_lease": {
          return this.opReleaseLease(actorId, op.artifactId);
        }
        case "commit": {
          return this.opCommit(actorId, op.artifactId, op.message, op.files);
        }
        case "request_commit": {
          const a = this.state.artifacts.get(op.artifactId);
          if (!a) return { ok: false, op: op.op, reason: "unknown artifact" };
          const techLeads = [...this.state.agents.values()].filter((r) => r.definition.authority.includes("implementation.approve")).map((r) => r.definition.id);
          const res = await this.sendMessage({
            from: actorId,
            to: techLeads,
            type: "COMMIT",
            newThread: { subject: `commit ${a.name}`, artifactRefs: [{ uri: artifactUri(a.type, a.name, a.version) }] },
            artifactRefs: [{ uri: artifactUri(a.type, a.name, a.version) }],
            payload: { artifactId: a.id, comment: op.comment ?? "ready to commit" },
          });
          turn.sentOps++;
          return res.accepted ? { ok: true, op: op.op, messageId: res.messageId } : { ok: false, op: op.op, reason: res.reason };
        }
        case "merge": {
          return this.opMerge(actorId, op.artifactId, op.comment, op.artifactUri);
        }
        case "submit_result": {
          const info = this.workerInfo.get(actorId);
          if (!info || info.taskId !== op.taskId) return { ok: false, op: op.op, reason: "only spawned workers may submit results" };
          await this.completeTask(actorId, op.taskId, op.result.summary, op.result.artifacts);
          await this.deliverWorkerResult(actorId, info, op.result);
          return { ok: true, op: op.op };
        }
        case "spawn_worker": {
          return this.opSpawnWorker(actorId, op);
        }
        default:
          return { ok: false, op: (op as MeshOp).op, reason: "unknown op" };
      }
    } catch (err) {
      if (err instanceof KernelRejectedError) {
        this.auditLine(`op ${op.op} by ${actorId} rejected at layer 4: ${err.message}`);
        return { ok: false, op: op.op, reason: err.message };
      }
      throw err;
    }
  }

  private newTask(
    createdBy: string,
    title: string,
    description: string,
    requiredCapabilities?: string[],
    artifactRefs?: ArtifactRef[],
    parentTaskId?: string,
    budgetHint?: BudgetHint,
  ): Task {
    const goalId = this.state.activeGoalId!;
    const parent = parentTaskId ? this.state.tasks.get(parentTaskId) : undefined;
    const task: Task = {
      id: newTaskId(),
      goalId,
      title,
      description,
      createdBy,
      status: "OPEN",
      requiredCapabilities: requiredCapabilities ?? [],
      artifactRefs: artifactRefs ?? [],
      parentTaskId,
      delegationDepth: (parent?.delegationDepth ?? 0) + (parentTaskId ? 1 : 0),
      budget: { tokens: budgetHint?.maxTokens ?? this.config.budgets.taskTokens },
      createdAt: this.deps.kernel.clock.iso(),
    };
    return task;
  }

  private async emitTaskCreated(task: Task): Promise<void> {
    await this.deps.kernel.emit("task.created", { task }, { actorId: task.createdBy });
    this.deps.budget.declare(taskKey(task.goalId, task.id), "tokens", task.budget.tokens ?? null);
  }

  private async opDelegate(actorId: string, op: Extract<MeshOp, { op: "delegate" }>, turn: TurnState): Promise<OpResult> {
    const def = this.state.agents.get(actorId)?.definition;
    if (!def) return { ok: false, op: "delegate", reason: "unknown actor" };
    if (def.mode === "service") return { ok: false, op: "delegate", reason: "service agents may not delegate" };
    const target = this.state.agents.get(op.to)?.definition;
    if (!target) return { ok: false, op: "delegate", reason: `unknown target ${op.to}` };
    const missingCaps = (op.requiredCapabilities ?? []).filter((c) => !target.capabilities.includes(c));
    if (missingCaps.length > 0) {
      return { ok: false, op: "delegate", reason: `${op.to} lacks required capabilities ${missingCaps.join(", ")}` };
    }
    const task = this.newTask(actorId, op.title, op.description, op.requiredCapabilities, op.artifactRefs, this.state.agents.get(actorId)?.state.activeTaskId ?? undefined, op.budgetHint);
    await this.emitTaskCreated(task);
    const res = await this.sendMessage({
      from: actorId,
      to: [op.to],
      type: "DELEGATE",
      newThread: { subject: `delegate: ${op.title}` },
      payload: { taskId: task.id, title: op.title, description: op.description },
      taskId: task.id,
      budgetHint: op.budgetHint,
    });
    turn.sentOps++;
    return res.accepted ? { ok: true, op: "delegate", taskId: task.id, messageId: res.messageId } : { ok: false, op: "delegate", reason: res.reason };
  }

  private async opSpawnWorker(actorId: string, op: Extract<MeshOp, { op: "spawn_worker" }>): Promise<OpResult> {
    const def = this.state.agents.get(actorId)?.definition;
    if (!def) return { ok: false, op: "spawn_worker", reason: "unknown actor" };
    const dp = def.delegationPolicy;
    if (!dp.allowDelegation || dp.maxWorkers <= 0 || dp.maxDepth < 1) {
      await this.denied(actorId, undefined, "spawn_worker", { decision: "DENY", reason: "delegation policy forbids worker spawning" });
      return { ok: false, op: "spawn_worker", reason: "delegation policy forbids worker spawning (v1 flat mesh: max_depth=0)" };
    }
    const depth = this.workerDepthOf(actorId);
    if (depth >= dp.maxDepth) return { ok: false, op: "spawn_worker", reason: `max delegation depth ${dp.maxDepth} reached` };
    const activeWorkers = [...this.workerInfo.values()].filter((w) => w.parent === actorId).length;
    if (activeWorkers >= dp.maxWorkers) return { ok: false, op: "spawn_worker", reason: `max concurrent workers (${dp.maxWorkers}) reached` };
    const workerId = `${actorId}#worker-${activeWorkers + 1}`;
    const workerDef: AgentDefinition = {
      ...def,
      id: workerId,
      mode: "service",
      sessionPolicy: { persistent: false },
      delegationPolicy: { allowDelegation: false, maxDepth: 0, maxWorkers: 0 },
      interests: [],
      budget: { tokens: dp.workerBudgetTokens ?? 50000 },
      capabilities: op.capabilities ?? def.capabilities,
      authority: [],
    };
    await this.registerAgent(workerDef);
    const task = this.newTask(actorId, op.title, op.taskSpec, op.capabilities, [], this.state.agents.get(actorId)?.state.activeTaskId ?? undefined, { maxTokens: workerDef.budget.tokens });
    await this.emitTaskCreated(task);
    this.workerInfo.set(workerId, { parent: actorId, taskId: task.id, depth: depth + 1 });
    await this.deps.kernel.emit("task.claimed", { taskId: task.id, agentId: workerId }, { actorId: HUMAN_AGENT_ID });
    await this.sendMessage({
      from: actorId,
      to: [workerId],
      type: "REQUEST_EXECUTION",
      newThread: { subject: `worker task ${task.id}` },
      payload: { taskId: task.id, instruction: "You are a delegated worker. Return your outcome ONLY via submit_result (structured) â€” the parent never sees your transcript.", spec: op.taskSpec },
      taskId: task.id,
    });
    await this.activateAgent(workerId, { kind: "message", note: "assigned worker task" });
    return { ok: true, op: "spawn_worker", taskId: task.id, reason: workerId };
  }

  private workerDepthOf(agentId: string): number {
    const info = this.workerInfo.get(agentId);
    return info ? info.depth : 0;
  }

  private async deliverWorkerResult(workerId: string, info: { parent: string; taskId: string; depth: number }, result: SubAgentResult): Promise<void> {
    const created = await this.createArtifact({
      actorId: workerId,
      name: `worker-result-${shortHash(info.taskId)}`,
      type: "Decision",
      content: JSON.stringify(result, null, 2),
      metadata: { subAgentResult: true, worker: workerId, taskId: info.taskId },
    });
    const ref: ArtifactRef | undefined = "artifact" in created ? { uri: created.uri } : undefined;
    await this.sendMessage({
      from: workerId,
      to: [info.parent],
      type: "HANDOFF",
      newThread: { subject: `worker result ${info.taskId}` },
      artifactRefs: ref ? [ref] : [],
      payload: result,
    });
    await this.deps.kernel.emit("agent.completed", { agentId: workerId }, { actorId: HUMAN_AGENT_ID });
    const sess = this.sessions.get(workerId);
    if (sess) {
      await sess.runtime.stop(sess.session).catch(() => undefined);
      this.sessions.delete(workerId);
    }
    this.workerInfo.delete(workerId);
    void result;
  }

  private async opAcquireLease(actorId: string, artifactId: string, files: string[]): Promise<OpResult> {
    const artifact = this.state.artifacts.get(artifactId);
    if (!artifact) return { ok: false, op: "acquire_lease", reason: "unknown artifact" };
    if (artifact.owner !== actorId && actorId !== HUMAN_AGENT_ID) {
      return { ok: false, op: "acquire_lease", reason: `only the artifact owner may write (${artifact.owner})` };
    }
    const ctx = { config: this.config, projections: this.state, goal: this.state.goals.get(artifact.goalId) };
    const decision = this.deps.policy.evaluateCapability(actorId, "repository.write", ctx);
    if (decision.decision !== "ALLOW") {
      await this.denied(actorId, artifactId, "acquire lease", decision);
      return { ok: false, op: "acquire_lease", reason: decision.reason };
    }
    const existing = this.state.activeLeaseByArtifact.get(artifactId);
    if (existing) {
      const lease = this.state.leases.get(existing)!;
      const expired = lease.expiresAt && Date.parse(lease.expiresAt) < this.deps.kernel.clock.now().getTime();
      if (!expired && lease.agentId !== actorId) {
        return { ok: false, op: "acquire_lease", reason: `artifact is leased to ${lease.agentId} until ${lease.expiresAt ?? "?"}` };
      }
      if (!expired && lease.agentId === actorId) return { ok: true, op: "acquire_lease", reason: existing };
    }
    const worktree = this.deps.workspace ? await this.deps.workspace.ensureWorktree(actorId) : path.join(this.config.workspacePath, "worktrees", actorId);
    const lease = {
      id: newLeaseId(),
      artifactId,
      agentId: actorId,
      worktreePath: worktree,
      files,
      acquiredAt: this.deps.kernel.clock.iso(),
      expiresAt: new Date(this.deps.kernel.clock.now().getTime() + this.config.scheduling.leaseTtlMs).toISOString(),
    };
    try {
      await this.deps.kernel.emit("lease.acquired", { lease }, { actorId });
    } catch (err) {
      if (err instanceof KernelRejectedError) return { ok: false, op: "acquire_lease", reason: err.message };
      throw err;
    }
    return { ok: true, op: "acquire_lease", reason: lease.id };
  }

  private async opReleaseLease(actorId: string, artifactId: string): Promise<OpResult> {
    const leaseId = this.state.activeLeaseByArtifact.get(artifactId);
    if (!leaseId) return { ok: false, op: "release_lease", reason: "no active lease" };
    const lease = this.state.leases.get(leaseId)!;
    if (lease.agentId !== actorId && actorId !== HUMAN_AGENT_ID) {
      return { ok: false, op: "release_lease", reason: `lease held by ${lease.agentId}` };
    }
    await this.deps.kernel.emit("lease.released", { leaseId }, { actorId });
    return { ok: true, op: "release_lease", reason: leaseId };
  }

  private async opCommit(actorId: string, artifactId: string, message: string, files?: string[]): Promise<OpResult> {
    const artifact = this.state.artifacts.get(artifactId);
    if (!artifact) return { ok: false, op: "commit", reason: "unknown artifact" };
    const ctx = { config: this.config, projections: this.state, goal: this.state.goals.get(artifact.goalId) };
    const decision = this.deps.policy.evaluateCapability(actorId, "git.commit", ctx);
    if (decision.decision !== "ALLOW") {
      await this.denied(actorId, artifactId, "commit", decision);
      return { ok: false, op: "commit", reason: decision.reason };
    }
    const gateTokens = this.config.transitionGates["patch.commit"];
    if (gateTokens && gateTokens.length > 0) {
      const res = checkApprovals(this.state, gateTokens, artifactId);
      if (!res.ok) {
        const anyBlock = [...this.state.approvals.get(approvalKey("architecture", "block")) ?? [], ...[]].length > 0;
        await this.denied(actorId, artifactId, "commit (gate)", { decision: "DENY", reason: `commit requires ${res.missing.join(", ")}` });
        return { ok: false, op: "commit", reason: `commit gate unsatisfied, missing: ${res.missing.join(", ")}${anyBlock ? " (active block present)" : ""}` };
      }
    }
    const leaseId = this.state.activeLeaseByArtifact.get(artifactId);
    if (!leaseId || this.state.leases.get(leaseId)?.agentId !== actorId) {
      return { ok: false, op: "commit", reason: "commit requires an active write lease on the artifact" };
    }
    if (!this.deps.workspace) {
      return { ok: false, op: "commit", reason: "no git workspace configured for this mesh" };
    }
    const { commit, diffDigest, diff } = await this.deps.workspace.commitWorktree(actorId, message, files);
    const versioned = await this.createArtifact({
      actorId,
      name: artifact.name,
      type: "CodePatch",
      content: diff,
      asVersionOf: artifactId,
      metadata: { commit, diffDigest },
    });
    const changeEvents = this.changeEventsFromDiff(diff);
    for (const t of changeEvents) {
      await this.deps.kernel.emit(t, { artifactId, commit, diffDigest }, { actorId });
    }
    return { ok: true, op: "commit", artifactId, reason: commit, artifact: "artifact" in versioned ? versioned.artifact : undefined };
  }

  private changeEventsFromDiff(diff: string): EventType[] {
    const out: EventType[] = [];
    const lower = diff.toLowerCase();
    if (/(package\.json|pom\.xml|build\.gradle|requirements\.txt|go\.mod|cargo\.toml)/.test(lower)) out.push("dependency.changed");
    if (/(oauth|jwt|authenticat|session|login|password)/.test(lower)) out.push("authentication.changed");
    if (/(rbac|permission|authoriz|role|acl|policy)/.test(lower)) out.push("authorization.changed");
    return out;
  }

  private async opMerge(actorId: string, artifactId: string | undefined, comment?: string, artifactUriRef?: string): Promise<OpResult> {
    const targetId = this.resolveArtifactRef(artifactId, artifactUriRef);
    if (!targetId) return { ok: false, op: "merge", reason: "unknown artifact" };
    artifactId = targetId;
    const artifact = this.state.artifacts.get(artifactId);
    if (!artifact) return { ok: false, op: "merge", reason: "unknown artifact" };
    const ctx = { config: this.config, projections: this.state, goal: this.state.goals.get(artifact.goalId) };
    const decision = this.deps.policy.evaluateCapability(actorId, "git.merge", ctx);
    if (decision.decision !== "ALLOW") {
      await this.denied(actorId, artifactId, "merge", decision);
      return { ok: false, op: "merge", reason: decision.reason };
    }
    if (artifact.status !== "MERGEABLE") {
      return { ok: false, op: "merge", reason: `artifact is ${artifact.status}, must be MERGEABLE` };
    }
    const res = await this.transitionArtifact(actorId, artifactId, { to: "MERGED", comment });
    if (!res.ok) return { ok: false, op: "merge", reason: res.reason };
    if (this.deps.workspace) {
      const merged = await this.deps.workspace.mergeWorktree(artifactId, artifact.owner, comment ?? `merge ${artifact.name}`);
      await this.transitionArtifact(HUMAN_AGENT_ID, artifactId, { to: "MERGED" }).catch(() => undefined);
      void merged;
    }
    await this.markCriterionEvidence("implementation-merged", {
      kind: "merge",
      artifactRef: { uri: artifactUri(artifact.type, artifact.name, artifact.version) },
      by: actorId,
      recordedAt: this.deps.kernel.clock.iso(),
    });
    return { ok: true, op: "merge", eventId: res.eventId };
  }

  private sendMessageCapability(actorId: string, type: MessageType): string | null {
    const def = this.state.agents.get(actorId)?.definition;
    if (!def) return "unknown sender";
    const capByType: Partial<Record<MessageType, string>> = {
      REQUEST_RESEARCH: "request_review",
      REQUEST_REVIEW: "request_review",
    };
    const need = capByType[type];
    if (!need) return null;
    const has = def.capabilities.includes(need) || def.capabilities.includes("repository.read");
    return has ? null : `missing capability ${need}`;
  }

  private capabilityForReview(a: Artifact): string | null {
    switch (a.type) {
      case "ArchitectureDocument":
      case "ADR":
      case "ApiSpec":
        return "review.design";
      case "CodePatch":
        return "code.review";
      case "SecurityReport":
        return "security.review";
      default:
        return null;
    }
  }

  /**
   * In a real organization an author may never approve their own work. But a
   * single-agent control group has no peers; the benchmark (§71) needs to be
   * mechanically comparable, so self-review is allowed only when no OTHER
   * registered agent could have reviewed the artifact.
   */
  hasPeerReviewer(actorId: string, artifact: Artifact): boolean {
    const reviewCap = this.capabilityForReview(artifact);
    const subject = this.domainOfSubject(artifact.type, artifact.id);
    for (const rec of this.state.agents.values()) {
      const id = rec.definition.id;
      if (id === actorId || id === HUMAN_AGENT_ID) continue;
      if (rec.state.lifecycle === "COMPLETED" || rec.state.lifecycle === "FAILED") continue;
      const auth = rec.definition.authority;
      if (auth.includes(`${subject}.approve`) || auth.includes(`${subject}.*`) || auth.includes("*")) return true;
      if (reviewCap && rec.definition.capabilities.includes(reviewCap)) return true;
    }
    return false;
  }

  resolveArtifactRef(explicit?: string, uri?: string): string | undefined {
    if (explicit && this.state.artifacts.has(explicit)) return explicit;
    if (uri) {
      const found = this.findArtifactByUri(uri);
      if (found) return found.id;
    }
    return explicit;
  }

  private researchCache(question: string): ArtifactRef | undefined {
    const norm = question.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
    for (const a of this.state.artifacts.values()) {
      if (a.type !== "ResearchReport") continue;
      if ((a.metadata as any)?.questionHash === norm) {
        return { uri: artifactUri(a.type, a.name, a.version), version: a.version, digest: a.digest };
      }
    }
    return undefined;
  }

  async rememberMemory(agentId: string, key: string, value: string): Promise<void> {
    await this.deps.kernel.emit("memory.updated", {
      agentId,
      note: { agentId, key, value, updatedAt: this.deps.kernel.clock.iso(), eventId: "" },
    }, { actorId: agentId });
  }

  // ------------------------------------------------------ post-activity checks

  private async afterActivity(): Promise<void> {
    this.watchdogChain = this.watchdogChain.then(() => this.watchdog()).catch((err) => {
      this.auditLine(`watchdog error: ${err.stack ?? err.message}`);
    });
    await this.watchdogChain;
  }

  private async watchdog(): Promise<void> {
    if (this.stopping) return;
    const findings = this.detector.scan(this.state);
    for (const f of findings) {
      this.detector.markReported(f);
      await this.onDeadlock(f);
    }
    const verdict = this.termination.evaluate({
      state: this.state,
      config: this.config,
      wallClockMs: Date.now() - this.startedAt,
    });
    const goalId = this.state.activeGoalId;
    if (!goalId) return;
    const goal = this.state.goals.get(goalId);
    if (!goal) return;
    if (verdict.kind === "complete" && goal.status !== "COMPLETED") {
      await this.deps.kernel.emit("goal.completed", { goalId, reason: verdict.reason, evidence: verdict.evidenceSummary }, { actorId: HUMAN_AGENT_ID });
      await this.completeMission();
    } else if (verdict.kind === "escalate" && goal.status !== "ESCALATED") {
      await this.escalate({ reason: verdict.reason, raisedBy: "termination-manager", detail: verdict.detail });
      await this.deps.kernel.emit("goal.escalated", { goalId, reason: verdict.reason, detail: verdict.detail }, { actorId: HUMAN_AGENT_ID });
    } else if (verdict.kind === "fail" && goal.status !== "FAILED") {
      await this.deps.kernel.emit("goal.failed", { goalId, reason: verdict.reason }, { actorId: HUMAN_AGENT_ID });
    }
  }

  private async onDeadlock(finding: DeadlockFinding): Promise<void> {
    await this.escalate({
      reason: `deadlock:${finding.kind}`,
      raisedBy: "deadlock-detector",
      conflictKey: finding.conflictKey,
      threadId: finding.threadId,
      artifactId: finding.artifactId,
      participants: finding.participants,
      detail: { description: finding.description },
    });
  }

  private async completeMission(): Promise<void> {
    for (const rec of [...this.state.agents.values()]) {
      const a = rec.state;
      if (a.agentId === HUMAN_AGENT_ID) continue;
      if (a.lifecycle === "IDLE" || a.lifecycle === "WAITING") {
        await this.deps.kernel
          .emit("agent.completed", { agentId: a.agentId }, { actorId: HUMAN_AGENT_ID })
          .catch(() => undefined);
      }
    }
    await this.shutdown();
  }

  private onIdle(): void {
    void this.afterActivity();
    for (const cb of this.idleCallbacks) cb();
  }

  onIdleOnce(cb: () => void): void {
    this.idleCallbacks.push(cb);
  }

  isIdle(): boolean {
    return this.deps.scheduler.pending() === 0 && this.deps.scheduler.running() === 0 && this.turnInFlight.size === 0;
  }

  // ------------------------------------------------------------- human ops

  async humanSend(to: string[], type: MessageType, payload: unknown, threadId?: string): Promise<SendResult> {
    return this.sendMessage({
      from: HUMAN_AGENT_ID,
      to,
      type,
      threadId,
      newThread: threadId ? undefined : { subject: `human ${type}` },
      payload,
      priority: "URGENT",
    });
  }

  async status(): Promise<{
    goal?: Goal;
    agents: Array<{ id: string; role: string; lifecycle: LifecycleState; mailbox: number; tokens: number }>;
    budgets: ReturnType<BudgetManager["snapshot"]>;
    progress: { completed: number; total: number; ratio: number } | null;
    openEscalations: Escalation[];
    eventCount: number;
  }> {
    const goalId = this.state.activeGoalId;
    const goal = goalId ? this.state.goals.get(goalId) : undefined;
    const progress = goalId ? this.state.progress.get(goalId) : undefined;
    return {
      goal,
      agents: [...this.state.agents.values()].map((r) => ({
        id: r.definition.id,
        role: r.definition.role,
        lifecycle: r.state.lifecycle,
        mailbox: this.state.unread.get(r.definition.id)?.length ?? 0,
        tokens: r.state.tokensConsumed,
        taskId: r.state.activeTaskId ?? null,
        activations: r.state.activations,
      })),
      budgets: this.deps.budget.snapshot(),
      progress: progress ? { completed: progress.completed, total: progress.total, ratio: progress.ratio } : null,
      openEscalations: [...this.state.escalations.values()].filter((e) => e.status === "OPEN"),
      eventCount: this.state.eventCount,
    };
  }
}

export class RuntimeFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeFailure";
  }
}

function describeReason(reason: ActivationReason): string {
  switch (reason.kind) {
    case "startup":
      return "Startup activation: begin your mission role.";
    case "message":
      return `New mail arrived${reason.threadId ? ` in thread ${reason.threadId}` : ""}.`;
    case "interest_event":
      return `Event matched your declared interests: ${reason.eventType ?? "unknown"} (event ${reason.eventId}).`;
    case "manual":
      return `Manual activation: ${reason.note ?? "no note"}`;
    case "recovery":
      return `Recovery activation: ${reason.note ?? "state restored from event log"}`;
    case "timer":
      return `Timeout wakeup: ${reason.note ?? "you have been waiting; decide whether to follow up or close the loop"}`;
    default:
      return "Activation.";
  }
}
