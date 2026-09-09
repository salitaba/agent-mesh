import { shortHash, type MeshOp, type MessageType } from "../../../packages/protocol/src/index";
import type { Supervisor, OpResult } from "../../../packages/core/src/index";
import { HUMAN_AGENT_ID } from "../../../packages/core/src/index";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export class McpToolset {
  private tools: Map<string, McpToolDefinition>;

  constructor(private supervisor: Supervisor) {
    this.tools = new Map();
    for (const t of this.buildTools()) this.tools.set(t.name, t);
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
    ];
  }
}

export function createMcpToolset(supervisor: Supervisor): McpToolset {
  return new McpToolset(supervisor);
}
