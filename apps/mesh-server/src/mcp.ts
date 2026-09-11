import { shortHash, type MeshEvent, type MeshOp, type MessageType } from "../../../packages/protocol/src/index";
import type { Supervisor, OpResult, TurnRecord } from "../../../packages/core/src/index";
import { HUMAN_AGENT_ID } from "../../../packages/core/src/index";
import {
  buildAgentActivity,
  buildCostReport,
  buildGoalView,
  buildMetrics,
  buildTurnSteps,
  eventTimeline,
} from "../../../packages/observability/src/index";
import { mergeTurnSteps } from "./steps-view";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Artifact statuses that mean the artifact reached the end of its state machine. */
const TERMINAL_ARTIFACT_STATUS = new Set(["MERGED", "ACCEPTED", "FINAL", "ARCHIVED", "REJECTED"]);

/**
 * Read-only observability tools. They never pass through `executeOp`, so they
 * touch no policy gate and can be called by any token holder at any time.
 */
const READ_TOOLS = new Set(["mesh_run_status", "mesh_query_events", "mesh_steps", "mesh_failures", "mesh_agent_activity", "mesh_run_digest"]);

export class McpToolset {
  private tools: Map<string, McpToolDefinition>;

  constructor(private supervisor: Supervisor, opts: { readOnly?: boolean } = {}) {
    this.tools = new Map();
    for (const t of this.buildTools()) {
      if (opts.readOnly && !READ_TOOLS.has(t.name)) continue;
      this.tools.set(t.name, t);
    }
  }

  verifyToken(agentId: string, token: string): boolean {
    if (agentId === HUMAN_AGENT_ID) return token === "human-local" || token.startsWith("human:");
    const parts = token.split(":");
    if (parts.length < 3) return false;
    const [meshId, tokenAgent, hash] = parts;
    if (tokenAgent !== agentId) return false;
    if (meshId !== this.supervisor.config.meshId) return false;
    const goalId = this.supervisor.state.activeGoalId ?? "";
    return hash === shortHash(goalId);
  }

  async handle(agentId: string, token: string, request: Record<string, any>): Promise<unknown> {
    const id = request.id;
    if (typeof request.method !== "string") return { jsonrpc: "2.0", id, error: { code: -32600, message: "invalid request" } };
    if (!this.verifyToken(agentId, token)) {
      return { jsonrpc: "2.0", id, error: { code: -32001, message: `invalid mesh token for agent '${agentId}'` } };
    }
    switch (request.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: request.params?.protocolVersion ?? MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: `mesh-bus-${this.supervisor.config.meshId}`, version: "1.0.0" },
          },
        };
      case "notifications/initialized":
        return { jsonrpc: "2.0", id: id ?? null, result: {} };
      case "tools/list":
        return { jsonrpc: "2.0", id, result: { tools: [...this.tools.values()] } };
      case "tools/call": {
        const name = request.params?.name as string;
        const args = (request.params?.arguments ?? {}) as Record<string, any>;
        if (!this.tools.has(name)) {
          return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown tool ${name}` } };
        }
        try {
          if (READ_TOOLS.has(name)) {
            const payload = await this.readTool(name, args);
            return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(payload) }], isError: false } };
          }
          const op = this.toOp(name, args);
          const turn = {
            turnId: `mcp-${Date.now()}`,
            agentId,
            reason: { kind: "manual" as const, note: "mcp call" },
            sentOps: 0,
            publishedOps: 0,
            waitRequested: false,
            escalated: false,
            results: [],
          };
          const result = await this.supervisor.executeOp(agentId, op, turn as never);
          const isError = !result.ok;
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: JSON.stringify(this.summarize(op, result)) }],
              isError,
            },
          };
        } catch (err) {
          return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `error: ${(err as Error).message}` }], isError: true } };
        }
      }
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      default:
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${request.method}` } };
    }
  }

  private summarize(op: MeshOp, result: OpResult): Record<string, unknown> {
    if (op.op === "read_artifact") {
      return { ok: result.ok, content: result.reason };
    }
    const out: Record<string, unknown> = { ok: result.ok };
    if (result.messageId) out.messageId = result.messageId;
    if (result.artifactId) out.artifactId = result.artifactId;
    if (result.artifactUri) out.artifactUri = result.artifactUri;
    if (result.taskId) out.taskId = result.taskId;
    if (result.escalationId) out.escalationId = result.escalationId;
    if (!result.ok && result.reason) out.error = result.reason;
    if (result.op === "publish_artifact" && result.artifact) out.artifact = { id: result.artifact.id, version: result.artifact.version, status: result.artifact.status };
    return out;
  }

  private toOp(name: string, a: Record<string, any>): MeshOp {
    switch (name) {
      case "mesh_send":
        return { op: "send", type: a.type as MessageType, to: a.to, threadId: a.threadId, newThread: a.newThread, replyTo: a.replyTo, artifactRefs: a.artifactRefs, payload: a.payload, priority: a.priority, taskId: a.taskId };
      case "mesh_broadcast":
        return { op: "broadcast", type: a.type as MessageType, payload: a.payload, artifactRefs: a.artifactRefs };
      case "mesh_request":
        return { op: "send", type: (a.requestType ?? "REQUEST") as MessageType, to: a.to, newThread: a.subject ? { subject: a.subject, artifactRefs: a.artifactRefs } : undefined, artifactRefs: a.artifactRefs, payload: a.payload ?? {} };
      case "mesh_respond":
        return { op: "respond", messageId: a.messageId, type: a.type as MessageType, payload: a.payload, artifactRefs: a.artifactRefs };
      case "mesh_discharge":
        return { op: "discharge", messageId: a.messageId, reason: a.reason };
      case "mesh_delegate":
        return { op: "delegate", to: a.to, title: a.title, description: a.description, requiredCapabilities: a.requiredCapabilities, artifactRefs: a.artifactRefs, budgetHint: a.budgetHint };
      case "mesh_block":
        return { op: "block", subject: a.subject, artifactId: a.artifactId, reason: a.reason };
      case "mesh_approve":
        return { op: "approve", subject: a.subject, artifactId: a.artifactId, comment: a.comment };
      case "mesh_reject":
        return { op: "reject", subject: a.subject, artifactId: a.artifactId, comment: a.comment };
      case "mesh_veto":
        return { op: "veto", subject: a.subject, artifactId: a.artifactId, comment: a.comment };
      case "mesh_escalate":
        return { op: "escalate", reason: a.reason, detail: a.detail, conflictKey: a.conflictKey };
      case "mesh_artifact_publish":
        return { op: "publish_artifact", name: a.name, type: a.type, content: a.content, status: a.status, metadata: a.metadata, asVersionOf: a.asVersionOf, parentArtifactId: a.parentArtifactId };
      case "mesh_artifact_read":
        return { op: "read_artifact", artifactRef: a.artifactRef };
      case "mesh_artifact_transition":
        return { op: "transition_artifact", artifactId: a.artifactId, to: a.to, evidence: a.evidence };
      case "mesh_request_review":
        return { op: "request_review", artifactId: a.artifactId, reviewers: a.reviewers };
      case "mesh_task_claim":
        return { op: "claim_task", taskId: a.taskId };
      case "mesh_task_complete":
        return { op: "complete_task", taskId: a.taskId, summary: a.summary, artifacts: a.artifacts };
      case "mesh_task_create":
        return { op: "create_task", title: a.title, description: a.description, assignedTo: a.assignedTo, requiredCapabilities: a.requiredCapabilities, artifactRefs: a.artifactRefs };
      case "mesh_research_request":
        return { op: "request_research", to: a.to, question: a.question, artifactRefs: a.artifactRefs };
      case "mesh_decision_propose":
        return { op: "propose_decision", topic: a.topic, decision: a.decision, evidence: a.evidence };
      case "mesh_decision_ratify":
        return { op: "ratify_decision", decisionId: a.decisionId };
      case "mesh_lease_acquire":
        return { op: "acquire_lease", artifactId: a.artifactId, files: a.files ?? [] };
      case "mesh_lease_release":
        return { op: "release_lease", artifactId: a.artifactId };
      case "mesh_commit":
        return { op: "commit", artifactId: a.artifactId, message: a.message, files: a.files };
      case "mesh_merge":
        return { op: "merge", artifactId: a.artifactId, comment: a.comment };
      case "mesh_wait":
        return { op: "wait", reason: a.reason };
      case "mesh_done":
        return { op: "done", summary: a.summary };
      case "mesh_remember":
        return { op: "remember", key: a.key, value: a.value };
      case "mesh_spawn_worker":
        return { op: "spawn_worker", title: a.title, taskSpec: a.taskSpec, capabilities: a.capabilities, budgetTokens: a.budgetTokens };
      case "mesh_submit_result":
        return { op: "submit_result", taskId: a.taskId, result: a.result };
      default:
        throw new Error(`unknown tool ${name}`);
    }
  }

  // ---------------------------------------------------- read-only observability

  private async readTool(name: string, a: Record<string, any>): Promise<unknown> {
    switch (name) {
      case "mesh_run_status":
        return this.runStatus();
      case "mesh_query_events":
        return this.queryEvents(a);
      case "mesh_steps":
        return this.stepsView(a);
      case "mesh_failures":
        return this.failuresView(a);
      case "mesh_agent_activity":
        return this.agentActivityView(a);
      case "mesh_run_digest":
        return this.runDigest(a);
      default:
        throw new Error(`unknown read tool ${name}`);
    }
  }

  private eventStore() {
    return this.supervisor.deps.kernel.store;
  }

  private clampInt(raw: unknown, fallback: number, max: number): number {
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(Math.max(n, 1), max);
  }

  /** Wall clock since the active goal was created, floored so rates stay finite. */
  private goalWallClockMs(): number {
    const state = this.supervisor.state;
    const goalId = state.activeGoalId;
    const createdAt = goalId ? state.goals.get(goalId)?.createdAt : undefined;
    const start = createdAt ? Date.parse(createdAt) : NaN;
    return Number.isFinite(start) ? Math.max(Date.now() - start, 1000) : 1000;
  }

  private async runStatus(): Promise<Record<string, unknown>> {
    const state = this.supervisor.state;
    const recent = await this.eventStore().read({ tail: 200 });
    return {
      goal: buildGoalView(state),
      metrics: buildMetrics(state, this.goalWallClockMs(), recent),
      cost: buildCostReport(state, this.supervisor.config),
      agents: [...state.agents.values()].map((r) => ({
        agentId: r.definition.id,
        role: r.definition.role,
        lifecycle: r.state.lifecycle,
        activations: r.state.activations,
        tokens: r.state.tokensConsumed,
        mailbox: state.unread.get(r.definition.id)?.length ?? 0,
        activeTaskId: r.state.activeTaskId,
        lastError: r.state.lastError,
      })),
      openEscalations: [...state.escalations.values()]
        .filter((e) => e.status === "OPEN")
        .map((e) => ({ id: e.id, reason: e.reason, raisedBy: e.raisedBy, kind: e.kind ?? "primary" })),
    };
  }

  private async queryEvents(a: Record<string, any>): Promise<Record<string, unknown>> {
    const limit = this.clampInt(a.limit, 30, 200);
    const events = await this.eventStore().read({
      types: a.type ? [String(a.type) as MeshEvent["type"]] : undefined,
      actorId: a.actorId ? String(a.actorId) : undefined,
      sinceSeq: a.sinceSeq === undefined ? undefined : Number(a.sinceSeq),
      tail: limit,
    });
    const timeline = eventTimeline(events, events.length);
    const trimmed = a.includePayload
      ? timeline
      : timeline.map((e) => ({
          seq: e.seq,
          at: e.at,
          type: e.type,
          actor: e.actor,
          summary: e.summary,
          id: e.id,
          goalId: e.goalId,
          correlationId: e.correlationId,
        }));
    const last = events[events.length - 1];
    return { count: trimmed.length, lastSeq: last?.seq ?? null, events: trimmed };
  }

  private async stepsView(a: Record<string, any>): Promise<Record<string, unknown>> {
    const limit = this.clampInt(a.limit, 20, 100);
    // Scale the scan to the requested output; the in-memory turns cover the
    // freshest ones even when the log tail is short.
    const events = await this.eventStore().read({ tail: Math.min(2000, Math.max(400, limit * 10)) });
    let steps = mergeTurnSteps(buildTurnSteps(events, limit * 2), this.supervisor.getRecentTurns(limit));
    if (a.agentId) steps = steps.filter((s) => s.agentId === String(a.agentId));
    if (a.status) steps = steps.filter((s) => s.status === String(a.status));
    if (a.turnId) steps = steps.filter((s) => s.turnId === String(a.turnId));
    steps.sort((x, y) => y.startedAt.localeCompare(x.startedAt));
    steps = steps.slice(0, limit);
    return { count: steps.length, steps };
  }

  /**
   * Shared failure aggregation over the event window + recent in-memory turns.
   * The log carries denials and runtime failures; rejected ops and no-tool
   * turns only exist in the turn tracker.
   */
  private collectFailureSignals(events: MeshEvent[], turns: TurnRecord[]) {
    const denials = new Map<string, { ruleId: string | null; action: string | null; reason: string; count: number }>();
    const opFailures = new Map<string, { op: string; reason: string; count: number }>();
    const gateBlocked = new Map<string, number>();
    const noToolTurns = new Map<string, number>();
    const agentFailures: Array<{ seq: number | undefined; at: string; agentId: string; error: string }> = [];
    const failedTurns: Array<{ turnId: string; agentId: string; startedAt: string; error?: string; errorKind?: string }> = [];
    let allRejectedTurns = 0;

    for (const e of events) {
      const p = (e.payload ?? {}) as Record<string, any>;
      if (e.type === "agent.failed") {
        agentFailures.push({
          seq: e.seq,
          at: e.timestamp,
          agentId: String(p.agentId ?? e.actorId ?? ""),
          error: String(p.error ?? "runtime failure").slice(0, 300),
        });
      } else if (e.type === "message.rejected") {
        const key = `${p.ruleId ?? "-"}|${p.action ?? "-"}|${String(p.reason ?? "").slice(0, 160)}`;
        const cur = denials.get(key) ?? { ruleId: p.ruleId ?? null, action: p.action ?? null, reason: String(p.reason ?? "").slice(0, 160), count: 0 };
        cur.count++;
        denials.set(key, cur);
      } else if (e.type === "artifact.transition" && p.gateSatisfied === false) {
        const id = String(p.artifactId ?? "");
        if (id) gateBlocked.set(id, (gateBlocked.get(id) ?? 0) + 1);
      }
    }

    for (const t of turns) {
      const timings = t.opTimings ?? [];
      for (const o of timings) {
        if (o.ok) continue;
        const key = `${o.op}|${String(o.reason ?? "").slice(0, 120)}`;
        const cur = opFailures.get(key) ?? { op: o.op, reason: String(o.reason ?? "").slice(0, 160), count: 0 };
        cur.count++;
        opFailures.set(key, cur);
      }
      if ((t.ops?.length ?? 0) > 0 && timings.length > 0 && timings.every((o) => !o.ok)) allRejectedTurns++;
      if ((t.toolCalls ?? 0) === 0) noToolTurns.set(t.agentId, (noToolTurns.get(t.agentId) ?? 0) + 1);
      if (t.status === "failed") {
        failedTurns.push({ turnId: t.turnId, agentId: t.agentId, startedAt: t.startedAt, error: t.error, errorKind: t.errorDetail?.kind });
      }
    }

    return { denials, opFailures, gateBlocked, noToolTurns, agentFailures, failedTurns, allRejectedTurns };
  }

  private async failuresView(a: Record<string, any>): Promise<Record<string, unknown>> {
    const limit = this.clampInt(a.limit, 20, 100);
    const window = this.clampInt(a.window, 2000, 10000);
    const events = await this.eventStore().read({ tail: window });
    const turns = this.supervisor.getRecentTurns(200);
    const sig = this.collectFailureSignals(events, turns);
    const state = this.supervisor.state;
    const byCount = <T extends { count: number }>(rows: T[]): T[] => rows.sort((x, y) => y.count - x.count).slice(0, limit);
    return {
      scanned: { events: events.length, recentTurns: turns.length },
      agentFailures: sig.agentFailures.slice(-limit),
      failedTurns: sig.failedTurns.slice(-limit),
      denials: byCount([...sig.denials.values()]),
      rejectedOps: byCount([...sig.opFailures.values()]),
      turnsWithEveryOpRejected: sig.allRejectedTurns,
      turnsWithZeroToolCalls: [...sig.noToolTurns.entries()]
        .map(([agentId, count]) => ({ agentId, count }))
        .sort((x, y) => y.count - x.count)
        .slice(0, limit),
      stuckArtifacts: [...state.artifacts.values()]
        .filter((art) => !TERMINAL_ARTIFACT_STATUS.has(art.status))
        .map((art) => ({ id: art.id, name: art.name, type: art.type, status: art.status, gateBlocked: sig.gateBlocked.get(art.id) ?? 0 }))
        .slice(0, limit),
      openEscalations: [...state.escalations.values()]
        .filter((e) => e.status === "OPEN")
        .map((e) => ({ id: e.id, reason: e.reason, raisedBy: e.raisedBy, kind: e.kind ?? "primary" })),
    };
  }

  private async agentActivityView(a: Record<string, any>): Promise<Record<string, unknown>> {
    const events = await this.eventStore().read({ tail: 600 });
    const activity = buildAgentActivity(this.supervisor.state, buildTurnSteps(events, 60));
    const agents = a.agentId ? activity.filter((x) => x.agentId === String(a.agentId)) : activity;
    return { count: agents.length, agents };
  }

  private async runDigest(a: Record<string, any>): Promise<Record<string, unknown>> {
    const top = this.clampInt(a.top, 5, 20);
    const window = this.clampInt(a.window, 2000, 10000);
    const events = await this.eventStore().read({ tail: window });
    const turns = this.supervisor.getRecentTurns(200);
    const sig = this.collectFailureSignals(events, turns);
    const state = this.supervisor.state;
    const byType = new Map<string, number>();
    for (const e of events) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
    let outcome = "UNTERMINATED";
    let reason = "";
    for (const e of events) {
      if (e.type === "goal.completed" || e.type === "goal.failed" || e.type === "goal.escalated") {
        outcome = e.type;
        reason = String((e.payload as Record<string, any>)?.reason ?? "").slice(0, 200);
      }
    }
    const blocks = events.filter((e) => e.type === "message.sent" && (e.payload as Record<string, any>)?.message?.type === "BLOCK").length;
    const interesting = ["review.rejected", "requirement.blocked", "escalation.requested", "escalation.responded", "deadlock.auto_resolved", "goal.reopened", "agent.failed", "agent.restarted", "budget.exceeded"];
    const mission = state.budgets.get(`mission:${state.activeGoalId ?? ""}`);
    const byCount = <T extends { count: number }>(rows: T[]): T[] => rows.sort((x, y) => y.count - x.count).slice(0, top);
    return {
      outcome,
      reason,
      scanned: { events: events.length, recentTurns: turns.length },
      goal: buildGoalView(state),
      eventCount: state.eventCount,
      denials: byCount([...sig.denials.values()]),
      rejectedOps: byCount([...sig.opFailures.values()]),
      turnsWithEveryOpRejected: sig.allRejectedTurns,
      turnsWithZeroToolCalls: [...sig.noToolTurns.entries()]
        .map(([agentId, count]) => ({ agentId, count }))
        .sort((x, y) => y.count - x.count)
        .slice(0, top),
      agentFailures: sig.agentFailures.length,
      stuckArtifacts: [...state.artifacts.values()]
        .filter((art) => !TERMINAL_ARTIFACT_STATUS.has(art.status))
        .slice(0, top)
        .map((art) => ({ id: art.id, name: art.name, type: art.type, status: art.status })),
      openEscalations: [...state.escalations.values()].filter((e) => e.status === "OPEN").length,
      interesting: interesting.map((type) => ({ type, count: byType.get(type) ?? 0 })).filter((r) => r.count > 0),
      blocks,
      tokens: {
        mission: mission?.consumed ?? null,
        perAgent: [...state.agents.values()].map((r) => ({ agentId: r.definition.id, tokens: r.state.tokensConsumed })),
      },
      topEventTypes: [...byType.entries()]
        .sort((x, y) => y[1] - x[1])
        .slice(0, top)
        .map(([type, count]) => ({ type, count })),
    };
  }

  private buildTools(): McpToolDefinition[] {
    const str = (desc: string) => ({ type: "string", description: desc });
    const strArr = (desc: string) => ({ type: "array", items: { type: "string" }, description: desc });
    const obj = (desc: string) => ({ type: "object", description: desc });
    return [
      { name: "mesh_send", description: "Send a typed message to agents (structured mesh protocol; never communicate outside the mesh).", inputSchema: { type: "object", required: ["type", "to"], properties: { type: { ...str("message type"), enum: ["MISSION","INFORM","REQUEST","REQUEST_INFO","REQUEST_REVIEW","REQUEST_ARTIFACT","REQUEST_RESEARCH","REQUEST_EXECUTION","PROPOSE","CHALLENGE","APPROVE","REJECT","VETO","BLOCK","DELEGATE","HANDOFF","PATCH_READY","TEST_RESULT","SECURITY_FINDING","COMMIT","ROLLBACK","ESCALATE","WAIT","DONE"] }, to: strArr("recipient agent ids"), threadId: str("existing thread id"), newThread: obj("{subject, artifactRefs?} to open a thread"), replyTo: str("message id being answered"), artifactRefs: strArr("artifact:// URIs"), payload: obj("natural-language payload"), priority: str("LOW|NORMAL|HIGH|URGENT"), taskId: str("task context") }, additionalProperties: false } },
      { name: "mesh_broadcast", description: "Broadcast an INFORM-class message to every mesh participant.", inputSchema: { type: "object", required: ["type"], properties: { type: str("message type"), payload: obj("payload"), artifactRefs: strArr("artifact refs") }, additionalProperties: false } },
      { name: "mesh_request", description: "Open a typed request to other agents (asynchronous; you will be woken on response).", inputSchema: { type: "object", required: ["to"], properties: { to: strArr("recipients"), requestType: str("REQUEST_* type"), subject: str("thread subject"), artifactRefs: strArr("artifact refs"), payload: obj("payload") }, additionalProperties: false } },
      { name: "mesh_respond", description: "Respond to a specific received message.", inputSchema: { type: "object", required: ["messageId", "type"], properties: { messageId: str("message being answered"), type: str("response message type"), payload: obj("payload"), artifactRefs: strArr("artifact refs") }, additionalProperties: false } },
      { name: "mesh_discharge", description: "Close a request addressed to you that you will NOT answer, stating why. Use instead of staying silent: an unanswered request nudges, burns budget, and eventually escalates to a human as a stalemate.", inputSchema: { type: "object", required: ["messageId", "reason"], properties: { messageId: str("the request you are closing"), reason: str("why it will not be answered (wrong recipient, out of scope, already covered elsewhere, blocked on something else)") }, additionalProperties: false } },
      { name: "mesh_delegate", description: "Delegate a task to another agent (creates a task and a DELEGATE message).", inputSchema: { type: "object", required: ["to", "title", "description"], properties: { to: str("delegate target"), title: str("task title"), description: str("task spec"), requiredCapabilities: strArr("capabilities the target must hold"), artifactRefs: strArr("context artifacts"), budgetHint: obj("{maxTokens}") }, additionalProperties: false } },
      { name: "mesh_block", description: "Exercise blocking authority (quality.block / security.block) on a subject.", inputSchema: { type: "object", required: ["subject", "reason"], properties: { subject: str("domain subject e.g. release / artifact id domain"), artifactId: str("artifact"), reason: str("blocking reason") }, additionalProperties: false } },
      { name: "mesh_approve", description: "Approve a subject domain or artifact review.", inputSchema: { type: "object", required: ["subject"], properties: { subject: str("domain: architecture|implementation|quality|security|requirements|release|criterion:<id>"), artifactId: str("artifact if applicable"), comment: str("rationale") }, additionalProperties: false } },
      { name: "mesh_reject", description: "Reject a subject domain or artifact review.", inputSchema: { type: "object", required: ["subject"], properties: { subject: str("domain"), artifactId: str("artifact"), comment: str("reason") }, additionalProperties: false } },
      { name: "mesh_veto", description: "Veto an action (requires explicit veto authority in the subject domain).", inputSchema: { type: "object", required: ["subject"], properties: { subject: str("domain"), artifactId: str("artifact"), comment: str("reason") }, additionalProperties: false } },
      { name: "mesh_escalate", description: "Escalate a disagreement or blocker to the human seat.", inputSchema: { type: "object", required: ["reason"], properties: { reason: str("escalation reason"), detail: obj("structured detail"), conflictKey: str("stable key for repeated conflicts") }, additionalProperties: false } },
      { name: "mesh_artifact_publish", description: "Publish an immutable artifact version; messages reference artifacts instead of pasting content.", inputSchema: { type: "object", required: ["name", "type", "content"], properties: { name: str("artifact name"), type: str("ArtifactType"), content: str("full content"), status: str("optional initial status"), metadata: obj("metadata"), asVersionOf: str("artifact id to version (you must be its owner)"), parentArtifactId: str("lineage parent") }, additionalProperties: false } },
      { name: "mesh_artifact_read", description: "Read the full content of an artifact version by URI or id.", inputSchema: { type: "object", required: ["artifactRef"], properties: { artifactRef: str("artifact:// URI or artifact id") }, additionalProperties: false } },
      { name: "mesh_artifact_transition", description: "Request an artifact state-machine transition (runtime-enforced gates apply).", inputSchema: { type: "object", required: ["artifactId", "to"], properties: { artifactId: str("artifact id"), to: str("target ArtifactStatus"), evidence: str("evidence description") }, additionalProperties: false } },
      { name: "mesh_request_review", description: "Move an artifact to review and request reviewers.", inputSchema: { type: "object", required: ["artifactId", "reviewers"], properties: { artifactId: str("artifact id"), reviewers: strArr("reviewer agent ids") }, additionalProperties: false } },
      { name: "mesh_task_claim", description: "Claim an open task you have the capabilities for.", inputSchema: { type: "object", required: ["taskId"], properties: { taskId: str("task id") }, additionalProperties: false } },
      { name: "mesh_task_complete", description: "Complete a claimed task with a summary and artifact evidence.", inputSchema: { type: "object", required: ["taskId", "summary"], properties: { taskId: str("task id"), summary: str("what was done"), artifacts: strArr("evidence artifact URIs") }, additionalProperties: false } },
      { name: "mesh_task_create", description: "Create a task in the shared backlog.", inputSchema: { type: "object", required: ["title", "description"], properties: { title: str("task title"), description: str("spec"), assignedTo: str("optional assignee"), requiredCapabilities: strArr("capabilities"), artifactRefs: strArr("context") }, additionalProperties: false } },
      { name: "mesh_research_request", description: "Ask a service-mode explorer for repository/system research.", inputSchema: { type: "object", required: ["to", "question"], properties: { to: str("explorer agent id"), question: str("research question") }, additionalProperties: false } },
      { name: "mesh_decision_propose", description: "Propose an organizational decision (goes to the decision registry).", inputSchema: { type: "object", required: ["topic", "decision"], properties: { topic: str("decision topic"), decision: obj("structured decision"), evidence: strArr("artifact refs") }, additionalProperties: false } },
      { name: "mesh_decision_ratify", description: "Ratify a proposed decision (requires architecture.approve authority).", inputSchema: { type: "object", required: ["decisionId"], properties: { decisionId: str("decision id") }, additionalProperties: false } },
      { name: "mesh_lease_acquire", description: "Acquire the single-writer lease on an artifact you own.", inputSchema: { type: "object", required: ["artifactId"], properties: { artifactId: str("artifact id"), files: strArr("files you intend to touch") }, additionalProperties: false } },
      { name: "mesh_lease_release", description: "Release your write lease on an artifact.", inputSchema: { type: "object", required: ["artifactId"], properties: { artifactId: str("artifact id") }, additionalProperties: false } },
      { name: "mesh_commit", description: "Commit staged work in your git worktree into a new artifact version (gate-checked).", inputSchema: { type: "object", required: ["artifactId", "message"], properties: { artifactId: str("CodePatch artifact"), message: str("commit message"), files: strArr("optional explicit file list") }, additionalProperties: false } },
      { name: "mesh_merge", description: "Merge a MERGEABLE patch (requires git.merge capability and configured approvals).", inputSchema: { type: "object", required: ["artifactId"], properties: { artifactId: str("artifact id"), comment: str("merge note") }, additionalProperties: false } },
      { name: "mesh_wait", description: "Declare that you are waiting for responses (runtime state becomes WAITING).", inputSchema: { type: "object", properties: { reason: str("what you await") }, additionalProperties: false } },
      { name: "mesh_done", description: "Finish your current activation turn.", inputSchema: { type: "object", properties: { summary: str("turn summary") }, additionalProperties: false } },
      { name: "mesh_remember", description: "Persist a note into your own L2 agent memory.", inputSchema: { type: "object", required: ["key", "value"], properties: { key: str("note key"), value: str("note value") }, additionalProperties: false } },
      { name: "mesh_spawn_worker", description: "Spawn a depth-1 delegated worker (only if your delegation policy allows). Parent receives only the structured result contract.", inputSchema: { type: "object", required: ["title", "taskSpec"], properties: { title: str("worker task title"), taskSpec: str("precise task specification"), capabilities: strArr("required capabilities"), budgetTokens: { type: "number", description: "worker token budget" } }, additionalProperties: false } },
      { name: "mesh_submit_result", description: "Worker-only: submit the fractal result contract {status,summary,artifacts,findings,risks,recommendation}.", inputSchema: { type: "object", required: ["taskId", "result"], properties: { taskId: str("delegated task"), result: obj("SubAgentResult contract") }, additionalProperties: false } },
      { name: "mesh_run_status", description: "Read-only mission snapshot: goal status and criteria progress, event/message/task/token counters and rates, per-agent lifecycle/cost/last error, open escalations. Use to answer 'how is the run doing?'.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
      { name: "mesh_query_events", description: "Read-only query over the event log, newest first. Returns compact timeline entries; lastSeq is a cursor for incremental polling. Use includePayload only when the summary is not enough.", inputSchema: { type: "object", properties: { type: str("exact event type, e.g. message.sent or agent.failed"), actorId: str("only events acted by this agent"), sinceSeq: { type: "number", description: "only events after this sequence number (poll cursor)" }, limit: { type: "number", description: "max events (default 30, max 200)" }, includePayload: { type: "boolean", description: "include full event payloads (default false)" } }, additionalProperties: false } },
      { name: "mesh_steps", description: "Read-only turn/step traces: lifecycle, status, ops, tokens, timing, errors for recent agent turns (log reconstruction merged with live turns). Filter by agent, status or exact turn id to find failures or slow/no-op turns.", inputSchema: { type: "object", properties: { limit: { type: "number", description: "max steps (default 20, max 100)" }, agentId: str("filter to one agent"), status: { ...str("filter by turn status"), enum: ["running", "ok", "waiting", "blocked", "failed"] }, turnId: str("exact turn id") }, additionalProperties: false } },
      { name: "mesh_failures", description: "Read-only failure report: runtime agent failures, policy denials (message.rejected), rejected ops, turns where every op was rejected, turns with zero tool calls, gate-blocked/non-terminal artifacts, open escalations. Start here when asked what went wrong.", inputSchema: { type: "object", properties: { limit: { type: "number", description: "max rows per section (default 20, max 100)" }, window: { type: "number", description: "how many recent events to scan (default 2000, max 10000)" } }, additionalProperties: false } },
      { name: "mesh_agent_activity", description: "Read-only per-agent activity snapshot: lifecycle, running turn, mailbox depth, activations, tokens, last error. Optionally filter to one agent.", inputSchema: { type: "object", properties: { agentId: str("filter to one agent") }, additionalProperties: false } },
      { name: "mesh_run_digest", description: "Read-only one-shot run digest over a bounded event window: outcome, goal progress, denial/op-failure/no-tool-turn counts, agent failures, stuck artifacts, conflicts, mission tokens and top event types. Cheapest broad answer before drilling into other tools.", inputSchema: { type: "object", properties: { top: { type: "number", description: "max rows per section (default 5, max 20)" }, window: { type: "number", description: "how many recent events to scan (default 2000, max 10000)" } }, additionalProperties: false } },
    ];
  }
}

export function createMcpToolset(supervisor: Supervisor, opts: { readOnly?: boolean } = {}): McpToolset {
  return new McpToolset(supervisor, opts);
}
