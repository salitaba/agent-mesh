import { ARTIFACT_TYPES, MESSAGE_TYPES, obligesRecipients, toolAdvertised, type AgentDefinition, type Artifact, type MeshEvent, type MeshMessage, type MeshOp, type MessageType } from "../../../packages/protocol/src/index";
import type { Supervisor, OpResult, TurnRecord } from "../../../packages/core/src/index";
import { HUMAN_AGENT_ID, MAX_UNREAD_PER_AGENT, pageCut, readableMailDepth, resolveUnread, settlersOf, stillOwes, verifySeatToken } from "../../../packages/core/src/index";
import {
  buildAgentActivity,
  buildCostReport,
  buildGoalView,
  buildMetrics,
  buildTurnSteps,
  eventTimeline,
} from "../../../packages/observability/src/index";
import { recentTurnSteps } from "./steps-view";
import { PAGE_ENVELOPE_CHARS, TOOL_PAGE_CHARS, fitRows, fitsInPage, jsonSize, pageNote } from "./pagination";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Artifact statuses that mean the artifact reached the end of its state machine. */
const TERMINAL_ARTIFACT_STATUS = new Set(["MERGED", "ACCEPTED", "FINAL", "ARCHIVED", "REJECTED"]);

/**
 * The verdict types, which a seat is no longer offered as a MESSAGE type.
 *
 * Still valid on the wire — the operator and the HTTP API send them, and old
 * logs hold them — but a verdict typed as a message records nothing, and the
 * enum was an invitation: seats did `mesh_approve` and then `mesh_respond
 * type:APPROVE` to close the ask, and every one of those was refused and woke
 * the sender (10 in the 2026-09-25 run). The verdict op already answers the
 * review ask (`settleReviewAsks`), which the approve/reject descriptions now say.
 */
const VERDICT_MESSAGE_TYPES: ReadonlySet<string> = new Set(["APPROVE", "REJECT", "VETO"]);

/**
 * `mesh_query_events` type families: one word for a set a seat otherwise has
 * to know by heart. `verdict` is every recorded verdict — a derived
 * `architecture.approved` is dropped from it (it restates the `review.approved`
 * it names), but one written before 2026-09-26 is the only record of that
 * approval and stays. tech-lead queried `review.approved` alone, missed its own
 * architecture approval, and called it "unbacked".
 */
const EVENT_FAMILIES: Record<string, MeshEvent["type"][]> = {
  verdict: ["review.approved", "review.rejected", "architecture.approved"],
};

/**
 * Read-only tools. They never pass through `executeOp`, so they touch no policy
 * gate and can be called by any token holder at any time — which is safe
 * precisely because none of them mutates anything. Most observe the run;
 * `mesh_inbox` observes the caller's own mailbox, and earns the same place
 * because reading a mailbox is not draining one (see `inboxView`).
 */
const READ_TOOLS = new Set(["mesh_run_status", "mesh_query_events", "mesh_steps", "mesh_failures", "mesh_agent_activity", "mesh_run_digest", "mesh_inbox"]);

/**
 * Which tools a seat is shown is decided by `toolAdvertised` (protocol `tool-visibility.ts`), and
 * the seat briefing reads the same tables, so what the prose names is what the manifest carries.
 * What changes here is only how a tool the collapsed vocabulary leaves in is DESCRIBED: three
 * descriptions point at a tool the same vocabulary hides, and a seat that reads "prefer
 * mesh_request" in the description of a tool it has goes and looks for one it does not.
 */
const COLLAPSED_DESCRIPTION_EDITS: Readonly<Record<string, ReadonlyArray<readonly [string, string]>>> = {
  mesh_call: [[" Preferred over mesh_send for the asks it covers: the mesh picks", " The mesh picks"]],
  mesh_collab: [["Prefer mesh_request when you can name what you want;", "Prefer mesh_call when you can name what you want;"]],
  mesh_approve: [["do not follow it with a mesh_respond or mesh_send;", "do not follow it with a mesh_reply or mesh_announce;"]],
  mesh_reject: [["do not follow it with a mesh_respond or mesh_send;", "do not follow it with a mesh_reply or mesh_announce;"]],
};

/** `tool` as the collapsed vocabulary describes it: the same tool, with no pointer to one it hides. */
function describedForCollapsed(tool: McpToolDefinition): McpToolDefinition {
  const edits = COLLAPSED_DESCRIPTION_EDITS[tool.name];
  if (!edits) return tool;
  const description = edits.reduce((d, [from, to]) => d.replace(from, to), tool.description);
  return description === tool.description ? tool : { ...tool, description };
}

/**
 * Ops whose accepted `reason` is an id or sha the caller needs next, and the
 * key `summarize` returns it under. Named rather than a generic `result` so the
 * key matches the argument that consumes it (`mesh_decision_ratify` takes a
 * `decisionId`). An accepted reason from any other op that is not a caveat
 * still reaches the caller, as `result`.
 */
const RESULT_KEY_BY_OP: Partial<Record<string, string>> = {
  propose_decision: "decisionId",
  acquire_lease: "leaseId",
  release_lease: "leaseId",
  commit: "commit",
  spawn_worker: "workerId",
};

/** Ops whose accepted `reason` is the caller's own `reason` argument, echoed. */
const ECHOED_REASON_OPS: ReadonlySet<string> = new Set(["discharge", "withdraw"]);

/**
 * `mesh_announce`'s recipient list, normalised to "did the caller name
 * anyone?".
 *
 * A single string is accepted alongside an array because that is the one
 * shape coercion the repo already treats as shape rather than vocabulary
 * (`op-aliases.ts` widens `to` the same way for the prose channel), and the
 * difference here decides which of two ops the tool becomes.
 */
function namedRecipients(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return list.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
}

export interface McpToolsetOptions {
  readOnly?: boolean;
  /** Accepts a human-seat credential. Absent = the human seat is refused. */
  humanAuth?: (token: string) => boolean;
}

export class McpToolset {
  private tools: Map<string, McpToolDefinition>;

  constructor(
    private supervisor: Supervisor,
    private opts: McpToolsetOptions = {},
  ) {
    this.tools = new Map();
    for (const t of this.buildTools()) {
      if (opts.readOnly && !READ_TOOLS.has(t.name)) continue;
      this.tools.set(t.name, t);
    }
  }

  /**
   * The tool list for one specific seat: the full toolset minus whichever
   * TOOL_REQUIREMENT entries this agent's definition doesn't satisfy. The
   * observability tools stay in every seat's list on purpose — agents use
   * them to check run status, not just external observers (see "mcp bus:
   * read-only observability tools answer run questions" in bus-api.test.ts);
   * the separate readOnly toolset (this.opts.readOnly) exists for observers
   * who should see ONLY those and nothing else, so it passes through
   * unfiltered here. (Counting them in this comment is what made it stale:
   * it read "those 6" the moment a seventh read tool existed.) Authorization itself is unaffected — executeOp still
   * gates every op the same way it always did; this only trims what's
   * advertised.
   */
  private toolsFor(agentId: string): McpToolDefinition[] {
    const all = [...this.tools.values()];
    if (this.opts.readOnly) return all;
    const def = this.supervisor.state.agents.get(agentId)?.definition;
    // Absent is every mesh written before the key existed, and those must
    // advertise exactly the list they always did — see `bus.vocabulary` in
    // the config package for why this resolves to absent rather than to
    // "typed".
    const vocabulary = this.supervisor.config.bus.vocabulary === "contracts" ? ("contracts" as const) : undefined;
    return all.filter((t) => toolAdvertised(t.name, def, vocabulary)).map((t) => (vocabulary ? describedForCollapsed(t) : t));
  }

  /**
   * The bridge route answers before operator auth, so this check is the whole
   * of its protection and must not accept anything a caller can guess.
   *
   * Seats: an HMAC over meshId/agent/goal under a per-process secret
   * (seat-token.ts). The human seat: whatever `opts.humanAuth` accepts — the
   * HTTP layer supplies a check against a random secret it minted for its own
   * designer bridge, plus the operator token. A toolset built without one
   * refuses the human seat outright; there is no fixed human credential any
   * more (it used to be the literal `human-local`, or any `human:` prefix).
   */
  verifyToken(agentId: string, token: string): boolean {
    if (!token) return false;
    if (agentId === HUMAN_AGENT_ID) return this.opts.humanAuth?.(token) === true;
    return verifySeatToken(this.supervisor.config.meshId, agentId, this.supervisor.state.activeGoalId, token);
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
        return { jsonrpc: "2.0", id, result: { tools: this.toolsFor(agentId) } };
      case "tools/call": {
        const name = request.params?.name as string;
        const args = (request.params?.arguments ?? {}) as Record<string, any>;
        if (!this.tools.has(name)) {
          return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown tool ${name}` } };
        }
        try {
          if (READ_TOOLS.has(name)) {
            const payload = await this.readTool(agentId, name, args);
            return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(payload) }], isError: false } };
          }
          const op = this.toOp(name, args);
          // Runs against the seat's in-flight turn, so the op counts toward
          // that turn exactly like one the runtime returned.
          const result = await this.supervisor.executeToolOp(agentId, op);
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
      const out: Record<string, unknown> = { ok: result.ok, content: result.reason };
      if (result.totalChars !== undefined) out.totalChars = result.totalChars;
      // Who can settle what the seat just read, so it knows whose review to ask
      // for — and whether its own verdict could count — before it asks.
      const read = result.ok ? this.supervisor.findArtifactByUri(op.artifactRef) : undefined;
      if (read) out.canSettle = settlersOf(this.supervisor.state, read, HUMAN_AGENT_ID);
      // The op already slices at ARTIFACT_READ_MAX_CHARS (60k), which is a
      // flood ceiling and not a page: the measured artifact read that rode a
      // whole session was 43,701 characters. Bound the page here, where the
      // page size lives, and recompute the cursor from the offset the caller
      // actually asked for so the next call continues exactly where this one
      // stopped. Nothing is lost: the artifact is read in as many parts as it
      // takes, and every part says which part it is.
      const askedFrom = Math.max(0, Math.floor(Number(op.offset) || 0));
      const content = typeof result.reason === "string" ? result.reason : "";
      const budget = TOOL_PAGE_CHARS - PAGE_ENVELOPE_CHARS;
      if (content.length > budget) {
        // A line boundary, not the character budget: a page that ends inside `test('…', (`
        // reads as a file that stops there (see `pageCut`).
        const shown = content.slice(0, pageCut(content, budget));
        const nextOffset = askedFrom + shown.length;
        out.content = shown;
        out.truncated = true;
        out.nextOffset = nextOffset;
        out.note = `Artifact truncated: showing characters ${askedFrom}-${nextOffset} of ${result.totalChars}. Call mesh_artifact_read again with offset=${nextOffset} for the next part.`;
        return out;
      }
      if (result.truncated) {
        out.truncated = true;
        out.nextOffset = result.nextOffset;
        out.note = `Content truncated. You have characters 0-${result.nextOffset} of ${result.totalChars}. Call mesh_artifact_read again with offset=${result.nextOffset} for the next part.`;
      }
      return out;
    }
    const out: Record<string, unknown> = { ok: result.ok };
    if (result.messageId) out.messageId = result.messageId;
    if (result.artifactId) out.artifactId = result.artifactId;
    if (result.artifactUri) out.artifactUri = result.artifactUri;
    if (result.taskId) out.taskId = result.taskId;
    // The collab ops mint the thread id server-side, so the agent that opened
    // a discussion has no other way to learn it, and `mesh_collab_close`
    // requires it. Dropping it here left every agent-opened collab to run to
    // its box edge and raise an operator card nobody needed.
    if (result.threadId) out.threadId = result.threadId;
    if (result.escalationId) out.escalationId = result.escalationId;
    // The catalogue IS the answer to `mesh_contracts`. Dropping it here meant
    // the tool whose description promises "the named asks ... and who can
    // answer it" returned `{ok: true}` and nothing else.
    if (result.contracts) out.contracts = result.contracts;
    // An accepted op's `reason` is either what the op PRODUCED or a caveat on
    // how it went (see `OpResult.caveat`), and before this the seat got
    // neither: `reason` was passed only on a refusal. A seat that proposed a
    // decision never learned the id `mesh_decision_ratify` needs, and a seat
    // whose criterion landed ASSERTED was told only `ok: true`.
    //
    // Products are returned as data under the name of what they are, like
    // `messageId` above; caveats go in `note`, the voice `truncated` and a
    // refused wake already use. The two withdraw/discharge echoes are the
    // seat's own words handed back, so they are not returned at all.
    const notes: string[] = [];
    if (result.ok && result.reason) {
      const key = RESULT_KEY_BY_OP[result.op];
      if (result.caveat === true) notes.push(result.reason);
      else if (key) out[key] = result.reason;
      else if (!ECHOED_REASON_OPS.has(result.op)) out.result = result.reason;
    }
    // A send that SUCCEEDED while getting less than it asked for. `ok` stays
    // true and no `error` is set, because the message did land -- but a seat
    // that reads the missing wake as a failed send will send the same thing
    // again, which costs the same unaffordable price twice. The refusal is
    // therefore reported as data about the send, in the same voice as
    // `truncated` on a partial artifact read.
    if (result.deliveryDowngraded) {
      out.deliveryDowngraded = true;
      notes.push(
        `Sent, but it did not wake anyone: ${result.deliveryDowngraded}. ` +
          `The message IS delivered and is in the recipient's mailbox -- they will read it on their next turn. ` +
          `Do not send it again; if it truly cannot wait, say so to the operator instead.`,
      );
    }
    // Joined, not overwritten: a review request can name a reviewer who cannot
    // settle the artifact AND have its wake refused, and both are true.
    if (notes.length > 0) out.note = notes.join(" ");
    if (!result.ok && result.reason) out.error = result.reason;
    if (result.op === "publish_artifact" && result.artifact) {
      out.artifact = { id: result.artifact.id, version: result.artifact.version, status: result.artifact.status };
      out.canSettle = settlersOf(this.supervisor.state, this.supervisor.state.artifacts.get(result.artifact.id) ?? result.artifact, HUMAN_AGENT_ID);
    }
    return out;
  }

  private toOp(name: string, a: Record<string, any>): MeshOp {
    switch (name) {
      case "mesh_send":
        return { op: "send", type: a.type as MessageType, to: a.to, threadId: a.threadId, newThread: a.newThread, replyTo: a.replyTo, artifactRefs: a.artifactRefs, payload: a.payload, note: a.note, priority: a.priority, taskId: a.taskId, ifUnanswered: a.ifUnanswered };
      case "mesh_broadcast":
        return { op: "broadcast", type: a.type as MessageType, payload: a.payload, note: a.note, artifactRefs: a.artifactRefs };
      case "mesh_collab":
        return { op: "collab", with: a.with, topic: a.topic, payload: a.payload, boxMs: a.boxMs, maxExchanges: a.maxExchanges, artifactRefs: a.artifactRefs };
      case "mesh_collab_close":
        return { op: "close_collab", threadId: a.threadId, outcome: a.outcome };
      // `threadId`/`replyTo` ride through for the same reason they do on
      // `mesh_send`: a follow-up ask belongs in the thread that raised it.
      // Without them every request opened a fresh thread, which split one
      // exchange across several and left the answer with nothing to reply to.
      // Passing both `threadId` and `newThread` is safe — `sendMessage`
      // resolves a live thread first and only then falls back to opening one.
      case "mesh_request":
        return { op: "send", type: (a.requestType ?? "REQUEST") as MessageType, to: a.to, threadId: a.threadId, newThread: a.subject ? { subject: a.subject, artifactRefs: a.artifactRefs } : undefined, replyTo: a.replyTo, artifactRefs: a.artifactRefs, payload: a.payload ?? {}, note: a.note, ifUnanswered: a.ifUnanswered };
      case "mesh_respond":
        return { op: "respond", messageId: a.messageId, type: a.type as MessageType, payload: a.payload, artifactRefs: a.artifactRefs };
      case "mesh_discharge":
        return { op: "discharge", messageId: a.messageId, reason: a.reason, refusal: a.refusal };
      case "mesh_withdraw":
        return { op: "withdraw", messageId: a.messageId, reason: a.reason };
      // `INFORM` is hard-coded, and that is the point rather than a shortcut:
      // the collapsed vocabulary's whole claim is that a seat never types a
      // message type. INFORM is the type the catalogue already reserves for
      // "here is your answer" — `TYPE_ALIASES` folds thirteen invented names
      // onto it — and what actually DISCHARGES the ask is `replyTo`, which
      // the respond op sets from `messageId`, not the type (see
      // `projections-messaging`). A seat that needs a typed reply has
      // `mesh_approve` / `mesh_reject` / `mesh_block`, and `mesh_respond`
      // still resolves when a model names it.
      case "mesh_reply":
        return { op: "respond", messageId: a.messageId, type: "INFORM" as MessageType, payload: a.response, artifactRefs: a.artifactRefs };
      // One tool over two ops, because from the seat's side it is ONE act:
      // saying something that puts nobody in debt. A broadcast and an INFORM
      // to three named seats differ in who hears them, not in what hearing
      // them costs — neither lands on the commitment ledger
      // (`isObligingType("INFORM")` is false), and the delivery classes treat
      // both as mail that rides the next turn the recipient takes anyway.
      // Splitting them into two tools would put the seat back to choosing a
      // channel, which is the choice this mode exists to remove; leaving the
      // targeted case out would be worse still, because "tell the architect
      // one thing" would have no tool at all and the model would reach for an
      // ask.
      case "mesh_announce": {
        const to = namedRecipients(a.to);
        if (to.length === 0) return { op: "broadcast", type: "INFORM" as MessageType, payload: a.payload, note: a.note, artifactRefs: a.artifactRefs };
        return { op: "send", type: "INFORM" as MessageType, to, threadId: a.threadId, payload: a.payload, note: a.note, artifactRefs: a.artifactRefs };
      }
      case "mesh_delegate":
        return { op: "delegate", to: a.to, title: a.title, description: a.description, requiredCapabilities: a.requiredCapabilities, artifactRefs: a.artifactRefs, budgetHint: a.budgetHint };
      case "mesh_block":
        return { op: "block", subject: a.subject, artifactId: a.artifactId, reason: a.reason };
      // `kind` rides only when it says something: a pass is the verdict of the seats that test and
      // scan (`quality.pass`), and the op carries the word a seat chose, not a default.
      case "mesh_approve":
        return { op: "approve", subject: a.subject, artifactId: a.artifactId, comment: a.comment, ...(a.kind === "pass" ? { kind: "pass" as const } : {}) };
      case "mesh_reject":
        return { op: "reject", subject: a.subject, artifactId: a.artifactId, comment: a.comment };
      case "mesh_veto":
        return { op: "veto", subject: a.subject, artifactId: a.artifactId, comment: a.comment };
      case "mesh_escalate":
        return { op: "escalate", reason: a.reason, detail: a.detail, conflictKey: a.conflictKey };
      case "mesh_artifact_publish":
        // The supervisor decides "exactly one of three" by counting which
        // bodies are not `undefined`, so a key the caller never sent must not
        // arrive carrying a value. Spreading conditionally keeps the op literal
        // to the fields actually sent; it is not what makes the count correct
        // (an explicit `content: undefined` counts the same as an absent one),
        // so the rule to protect is that each field is COPIED AT ALL. Drop one
        // and the publish arrives bodiless -- no type error, and a seat told
        // only that it gave "no body" for a body it did give.
        return {
          op: "publish_artifact",
          name: a.name,
          type: a.type,
          ...(a.content !== undefined ? { content: a.content } : {}),
          ...(a.fromPath !== undefined ? { fromPath: a.fromPath } : {}),
          ...(a.edits !== undefined ? { edits: a.edits } : {}),
          status: a.status,
          scope: a.scope,
          metadata: a.metadata,
          asVersionOf: a.asVersionOf,
          parentArtifactId: a.parentArtifactId,
        };
      case "mesh_artifact_read":
        return { op: "read_artifact", artifactRef: a.artifactRef, offset: a.offset };
      case "mesh_artifact_transition":
        return { op: "transition_artifact", artifactId: a.artifactId, to: a.to, evidence: a.evidence };
      case "mesh_request_review":
        return { op: "request_review", artifactId: a.artifactId, reviewers: a.reviewers, ifUnanswered: a.ifUnanswered };
      case "mesh_task_claim":
        return { op: "claim_task", taskId: a.taskId };
      case "mesh_task_complete":
        return { op: "complete_task", taskId: a.taskId, summary: a.summary, artifacts: a.artifacts };
      case "mesh_task_create":
        return { op: "create_task", title: a.title, description: a.description, assignedTo: a.assignedTo, requiredCapabilities: a.requiredCapabilities, artifactRefs: a.artifactRefs };
      case "mesh_research_request":
        return { op: "request_research", to: a.to, question: a.question, artifactRefs: a.artifactRefs, ifUnanswered: a.ifUnanswered };
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
      case "mesh_request_commit":
        return { op: "request_commit", artifactId: a.artifactId, comment: a.comment };
      case "mesh_merge":
        return { op: "merge", artifactId: a.artifactId, comment: a.comment };
      case "mesh_wait":
        return { op: "wait", reason: a.reason };
      case "mesh_done":
        return { op: "done", summary: a.summary };
      case "mesh_remember":
        return { op: "remember", key: a.key, value: a.value };
      case "mesh_write_continuity":
        return { op: "write_continuity", nextIntent: a.nextIntent, beliefs: a.beliefs, rejected: a.rejected };
      case "mesh_contracts":
        return { op: "contracts", role: a.role };
      case "mesh_call":
        return { op: "call", contract: a.contract, request: a.request, to: a.to, ifUnanswered: a.ifUnanswered };
      case "mesh_plan":
        return { op: "plan", steps: a.steps, taskId: a.taskId };
      case "mesh_plan_step":
        return { op: "plan_step", stepId: a.stepId, status: a.status ?? "DONE" };
      case "mesh_spawn_worker":
        return { op: "spawn_worker", title: a.title, taskSpec: a.taskSpec, capabilities: a.capabilities, budgetTokens: a.budgetTokens };
      case "mesh_submit_result":
        return { op: "submit_result", taskId: a.taskId, result: a.result };
      default:
        throw new Error(`unknown tool ${name}`);
    }
  }

  // ---------------------------------------------------- read-only observability

  private async readTool(agentId: string, name: string, a: Record<string, any>): Promise<unknown> {
    switch (name) {
      case "mesh_inbox":
        return this.inboxView(agentId, a);
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

  /**
   * The caller's own mailbox: mail addressed to it that it has not answered.
   *
   * Reads `resolveUnread`, the same projection the turn builder renders from,
   * and deliberately does NOT emit `message.delivered`. The one rule that
   * empties a mailbox is "delivered means rendered AND answered"
   * (`supervisor.ts`), so a tool that drained would mark mail read that no
   * prompt ever showed and no model ever answered — exactly the silent loss
   * that rule was written to prevent. This only SHOWS the queue: answering what
   * it read leaves the rest owed, and the seat is still woken for the rest.
   *
   * That is also what makes this the FETCH half of the pull path rather than
   * the whole of it. On its own it does not replace a wake with a pull; a seat
   * that is never woken learns nothing from it. It answers the narrower
   * question a woken seat cannot ask today: the turn renders `selectUnread`'s
   * top 12 and says nothing about the rest, so a burst of 40 and a burst of 2
   * look identical from inside the turn.
   *
   * The PUSH half is `agents.<id>.wake.mail: "claims"`, which makes a turn
   * render a bare claim per message instead of the body for mail that owes the
   * reader nothing. Ship them together: the claim line names the message, this
   * returns it, and obliging mail is inlined by the renderer in both modes so
   * the pair never asks a seat to answer something it was not shown.
   */
  private inboxView(agentId: string, a: Record<string, any>): Record<string, unknown> {
    const state = this.supervisor.state;
    const box = resolveUnread(state, agentId);
    const offset = Math.max(0, Math.floor(Number(a.offset)) || 0);
    const limit = this.clampInt(a.limit, 25, MAX_UNREAD_PER_AGENT);
    // Row-count first, then a character budget over those rows. `limit` alone
    // was never a size bound: 25 messages of ~2k each is the 47k result that
    // rode the rest of the session, and the seat had no way to tell a page it
    // had finished from one that had merely stopped.
    const mapped = box.slice(offset, offset + limit).map((m) => ({
      id: m.id,
      from: m.from,
      to: m.to,
      type: m.type,
      priority: m.priority,
      threadId: m.threadId,
      subject: state.threads.get(m.threadId)?.subject,
      replyTo: m.replyTo,
      timestamp: m.timestamp,
      // `answerOwed`, and `closed` when an ask no longer is — see `owedState`.
      ...this.owedState(m, agentId),
      // The ask's clock, from the ledger entry the reducer opened at
      // `message.sent`. Absent for mail that owes nothing, and for a mesh
      // with no TTL regime — which is not the same as a deadline that passed.
      dueBy: state.pendingRequests.get(m.id)?.dueBy,
      delivery: m.control?.delivery,
      note: m.note,
      artifactRefs: m.artifactRefs.map((r) => r.uri),
      payload: m.payload,
    }));
    const page = fitRows(mapped, { offset: 0, budgetChars: TOOL_PAGE_CHARS - PAGE_ENVELOPE_CHARS, sizeOf: jsonSize });
    // "More" is measured against the BOX, not against the rows we happened to
    // build: `limit` is a row cap of its own, so a page can be full to the row
    // limit, fit its budget, and still have mail behind it.
    const consumed = offset + page.rows.length;
    const more = consumed < box.length;
    return {
      agentId,
      mailbox: readableMailDepth(state, agentId),
      total: box.length,
      offset,
      returned: page.rows.length,
      truncated: more,
      nextOffset: more ? consumed : null,
      messages: page.rows,
      ...(more ? { note: pageNote("mesh_inbox", page.rows.length, box.length, `offset=${consumed} (next page of your mailbox)`) } : {}),
    };
  }

  /**
   * Does `agentId` still owe an answer on this message, and if it no longer
   * does, how did the ask close?
   *
   * The type says whether a message ever obliged (the same predicate the
   * obligation opens with); only the ledger says whether THIS seat still owes
   * on it. Read off the type alone, an ask closed `superseded` still read as
   * owed, and pm discharged one 10 minutes after it had closed.
   */
  private owedState(m: MeshMessage, agentId: string): { answerOwed: boolean; closed?: { reason: string; by: string; at: string } } {
    const state = this.supervisor.state;
    const obliging = obligesRecipients(m);
    const open = state.pendingRequests.get(m.id);
    const answerOwed = obliging && !!open && stillOwes(open, agentId);
    if (!obliging || answerOwed) return { answerOwed };
    // This seat's own share when one debtor of several answered; else the close.
    const rec = [...state.discharged].reverse().find((d) => d.messageId === m.id && (!d.partial || d.by === agentId));
    return rec ? { answerOwed, closed: { reason: rec.reason, by: rec.by, at: rec.at } } : { answerOwed };
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

  private async runStatus(a: Record<string, any> = {}): Promise<Record<string, unknown>> {
    const state = this.supervisor.state;
    const recent = await this.eventStore().read({ tail: 200 });
    return this.pageAggregate(
      "mesh_run_status",
      {
        goal: buildGoalView(state),
        metrics: buildMetrics(state, this.goalWallClockMs(), recent),
        cost: buildCostReport(state, this.supervisor.config),
      },
      {
        agents: [...state.agents.values()].map((r) => ({
          agentId: r.definition.id,
          role: r.definition.role,
          lifecycle: r.state.lifecycle,
          activations: r.state.activations,
          tokens: r.state.tokensConsumed,
          mailbox: readableMailDepth(state, r.definition.id),
          activeTaskId: r.state.activeTaskId,
          lastError: r.state.lastError,
        })),
        openEscalations: [...state.escalations.values()]
          .filter((e) => e.status === "OPEN")
          .map((e) => ({ id: e.id, reason: e.reason, raisedBy: e.raisedBy, kind: e.kind ?? "primary" })),
      },
      a,
      Number.MAX_SAFE_INTEGER,
    );
  }

  private async queryEvents(a: Record<string, any>): Promise<Record<string, unknown>> {
    const limit = this.clampInt(a.limit, 30, 200);
    // `offset` skips that many of the NEWEST matching events, so `0` is the
    // newest page and `nextOffset` walks backwards into history. Paired with
    // `sinceSeq`, which walks forwards, the two cursors cover polling and
    // history without either one having to be guessed at.
    const offset = Math.max(0, Math.floor(Number(a.offset) || 0));
    // `type` may name a family (`EVENT_FAMILIES`) and `types` adds more; an
    // array in `type` is taken as `types`, since that is the mistake to expect.
    const asList = (v: unknown): string[] => (Array.isArray(v) ? v : v ? [v] : []).map(String).filter((s) => s.length > 0);
    const requested = [...asList(a.type), ...asList(a.types)];
    const verdict = requested.includes("verdict");
    const types = [...new Set(requested.flatMap((t) => (Object.hasOwn(EVENT_FAMILIES, t) ? EVENT_FAMILIES[t]! : [t as MeshEvent["type"]])))];
    const wanted = limit + offset + 1;
    const tail = Math.min(wanted, 2000);
    const read = await this.eventStore().read({
      types: types.length > 0 ? types : undefined,
      actorId: a.actorId ? String(a.actorId) : undefined,
      sinceSeq: a.sinceSeq === undefined ? undefined : Number(a.sinceSeq),
      // The verdict family drops rows after the read, so it cannot let the
      // store cut the tail first. Verdicts are few; the whole match is small.
      // Otherwise the store is asked for exactly the window the offset needs,
      // one row past it, so "is there an older page" is a fact and not a guess.
      tail: verdict ? undefined : tail,
    });
    const matched = verdict
      ? read.filter((e) => !(e.type === "architecture.approved" && (e.payload as { derived?: unknown } | undefined)?.derived === true))
      : read;
    // A window the store filled is not evidence the log ends there.
    const windowFull = matched.length >= tail;
    const end = Math.max(0, matched.length - offset);
    const start = Math.max(0, end - limit);
    const windowed = matched.slice(start, end);
    const timeline = eventTimeline(windowed, windowed.length);
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
    // Newest-first for the budget so a page that has to stop stops in the
    // OLDEST end of its window; the array is handed back ascending, as before.
    const fitted = fitRows([...trimmed].reverse(), { offset: 0, budgetChars: TOOL_PAGE_CHARS - PAGE_ENVELOPE_CHARS, sizeOf: jsonSize });
    const events = [...fitted.rows].reverse();
    const last = events[events.length - 1];
    const more = events.length > 0 && (start > 0 || fitted.nextOffset !== null || (windowFull && start === 0));
    const nextOffset = more ? offset + events.length : null;
    // The match's size is known only when the store handed back a short window;
    // say "more remain" rather than publishing the window's length as a total.
    const knownTotal = verdict || !windowFull ? matched.length : null;
    return {
      count: events.length,
      lastSeq: last?.seq ?? null,
      offset,
      total: knownTotal,
      truncated: more,
      nextOffset,
      events,
      ...(more
        ? { note: pageNote("mesh_query_events", events.length, knownTotal, `offset=${nextOffset} (older events; sinceSeq=<lastSeq> still polls forward)`) }
        : {}),
    };
  }

  private async stepsView(a: Record<string, any>): Promise<Record<string, unknown>> {
    const limit = this.clampInt(a.limit, 20, 100);
    const offset = Math.max(0, Math.floor(Number(a.offset) || 0));
    // Same list as `/steps`, so a seat and the dashboard cannot disagree about
    // what a turn did: tracker turns older than the tail scan are read through
    // the correlation index, and a turn with no log behind it reports no ops
    // rather than four zeros that read as "did nothing".
    //
    // One turn past the page is scanned, so "is there an older page" is proved
    // by the row itself rather than guessed from a full window.
    const scan = limit + offset + 1;
    const steps = await recentTurnSteps(this.eventStore(), this.supervisor.getRecentTurns(scan), scan, (s) =>
      (!a.agentId || s.agentId === String(a.agentId)) &&
      (!a.status || s.status === String(a.status)) &&
      (!a.turnId || s.turnId === String(a.turnId)),
    );
    const page = fitRows(steps, { offset, budgetChars: TOOL_PAGE_CHARS - PAGE_ENVELOPE_CHARS, sizeOf: jsonSize });
    const more = offset + page.rows.length < steps.length;
    // Only a scan that came back short proves the list's size; otherwise the
    // number is the window's, and saying "of 41" would read as the whole history.
    const knownTotal = steps.length < scan ? steps.length : null;
    return {
      count: page.rows.length,
      total: knownTotal,
      offset,
      truncated: more,
      nextOffset: more ? offset + page.rows.length : null,
      steps: page.rows,
      ...(more ? { note: pageNote("mesh_steps", page.rows.length, knownTotal, `offset=${offset + page.rows.length} (older turns)`) } : {}),
    };
  }

  /**
   * Fit an aggregate read tool's report into one page, or hand back an index
   * of its sections so the caller can read them one at a time.
   *
   * `mesh_failures` and `mesh_run_digest` are not lists and have no natural
   * order to page along — they are seven-odd sections of counted rows each
   * capped by `limit`/`top`, and that cap is not a size bound: 20 denials with
   * 160-character reasons is 3.2k on its own, and the live `mesh_failures`
   * result measured 24,472 characters. So the common case still gets the whole
   * report, and only a report that genuinely does not fit is turned into an
   * index plus `section=<name>` reads, each of which pages by character.
   *
   * Nothing becomes unreachable: every section is still listed with its row
   * count, and every section can be read in full, one page at a time.
   */
  private pageAggregate(
    tool: string,
    scalars: Record<string, unknown>,
    sections: Record<string, unknown[]>,
    a: Record<string, any>,
    sectionCap: number,
  ): Record<string, unknown> {
    const index = (): Record<string, number> => Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, v.length]));
    if (a.section !== undefined) {
      const want = String(a.section);
      const rows = sections[want];
      if (!rows) return { ...scalars, error: `unknown section ${want}`, sections: index() };
      const offset = Math.max(0, Math.floor(Number(a.offset) || 0));
      const page = fitRows(rows, { offset, budgetChars: TOOL_PAGE_CHARS - PAGE_ENVELOPE_CHARS, sizeOf: jsonSize });
      return {
        ...scalars,
        section: want,
        total: page.total,
        offset,
        returned: page.rows.length,
        truncated: page.truncated,
        nextOffset: page.nextOffset,
        rows: page.rows,
        ...(page.truncated ? { note: pageNote(`${tool}/${want}`, page.rows.length, page.total, `section="${want}", offset=${page.nextOffset}`) } : {}),
      };
    }
    const capped: Record<string, unknown> = {};
    for (const [k, rows] of Object.entries(sections)) capped[k] = rows.slice(0, sectionCap);
    const full = { ...scalars, ...capped };
    if (fitsInPage(full)) return full;
    return {
      ...scalars,
      truncated: true,
      sections: index(),
      note:
        `${tool}: this report is ${jsonSize(full)} characters and does not fit one result. ` +
        `Every row is still here — call it again with section="<name>" (the names and row counts are in \`sections\`) ` +
        `to read one section at a time, paging with \`offset\` if that section needs it.`,
    };
  }

  /**
   * Shared failure aggregation over three sources, one per question they can
   * actually answer.
   *
   * - The PROJECTIONS carry what policy refused: `deniedActions` (ops and
   *   activations) and `refusedSends` (messages that never left the
   *   building). Both are bounded rings that ride into every snapshot.
   * - The event window carries runtime failures and blocked gate
   *   transitions, which nothing projects.
   * - The in-memory turn tracker carries rejected ops and no-tool turns,
   *   which are not events at all.
   *
   * The denials used to be folded out of the raw `message.rejected` events in
   * the window, and that made this report quietly wrong after a restart: the
   * window is the replay tail, so a mesh restored from a snapshot reported
   * zero denials for everything that happened before the snapshot — the exact
   * moment an operator opens a failure report. Reading the ring instead means
   * the answer survives the restart, is bounded by a cap rather than by how
   * far back the caller asked us to scan, and stops depending on `window` at
   * all for the half of this report that matters most.
   *
   * The two rings are kept apart here because they are apart in state, and
   * for the reason they were split there: `message.rejected` is overloaded,
   * and folding both halves into one bucket produced rows whose `action` was
   * null and whose `to` was gone — a refusal that named neither what was
   * stopped nor what the mesh had tried to say.
   */
  private collectFailureSignals(events: MeshEvent[], turns: TurnRecord[]) {
    const state = this.supervisor.state;
    const denials = new Map<string, { agentId: string; ruleId: string | null; action: string; decision: string | null; reason: string; count: number }>();
    for (const d of state.deniedActions) {
      const reason = d.reason.slice(0, 160);
      const key = `${d.ruleId ?? "-"}|${d.action}|${reason}`;
      const cur = denials.get(key) ?? { agentId: d.agentId, ruleId: d.ruleId ?? null, action: d.action, decision: d.decision ?? null, reason, count: 0 };
      cur.count++;
      denials.set(key, cur);
    }
    const refusedSends = new Map<string, { from: string; to: string[]; type: string; ruleId: string | null; reason: string; count: number }>();
    for (const r of state.refusedSends) {
      const reason = r.reason.slice(0, 160);
      const key = `${r.from}|${r.to.join(",")}|${r.type}|${r.ruleId ?? "-"}|${reason}`;
      const cur = refusedSends.get(key) ?? { from: r.from, to: r.to, type: r.type, ruleId: r.ruleId ?? null, reason, count: 0 };
      cur.count++;
      refusedSends.set(key, cur);
    }
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

    return { denials, refusedSends, opFailures, gateBlocked, noToolTurns, agentFailures, failedTurns, allRejectedTurns };
  }

  private async failuresView(a: Record<string, any>): Promise<Record<string, unknown>> {
    const limit = this.clampInt(a.limit, 20, 100);
    const window = this.clampInt(a.window, 2000, 10000);
    const events = await this.eventStore().read({ tail: window });
    const turns = this.supervisor.getRecentTurns(200);
    const sig = this.collectFailureSignals(events, turns);
    const state = this.supervisor.state;
    // `events` bounds the runtime-failure and gate-blocked sections only.
    // Denials and refused sends come off bounded projection rings, so they
    // are not limited by how far back the caller asked us to scan and they
    // survive a snapshot restore — said here because a `scanned` count next
    // to a number it does not govern is how a report gets misread.
    const scalars = {
      scanned: { events: events.length, recentTurns: turns.length, denialsFromProjection: true },
      turnsWithEveryOpRejected: sig.allRejectedTurns,
    };
    // Full lists, not pre-capped ones: `pageAggregate` applies `limit` to the
    // flat report it returns, and the index it falls back to must name the
    // section's REAL size — a count taken from an already-capped list would
    // tell a caller it had seen everything when it had not.
    const byCount = <T extends { count: number }>(rows: T[]): T[] => rows.sort((x, y) => y.count - x.count);
    return this.pageAggregate(
      "mesh_failures",
      scalars,
      {
        // Newest first, so the cap `pageAggregate` applies to the flat report
        // keeps the most recent failures — the ones a reader is asking about.
        agentFailures: [...sig.agentFailures].reverse(),
        failedTurns: [...sig.failedTurns].reverse(),
        denials: byCount([...sig.denials.values()]),
        refusedSends: byCount([...sig.refusedSends.values()]),
        rejectedOps: byCount([...sig.opFailures.values()]),
        turnsWithZeroToolCalls: [...sig.noToolTurns.entries()]
          .map(([agentId, count]) => ({ agentId, count }))
          .sort((x, y) => y.count - x.count),
        stuckArtifacts: [...state.artifacts.values()]
          .filter((art) => !TERMINAL_ARTIFACT_STATUS.has(art.status))
          .map((art) => ({ id: art.id, name: art.name, type: art.type, status: art.status, gateBlocked: sig.gateBlocked.get(art.id) ?? 0 })),
        openEscalations: [...state.escalations.values()]
          .filter((e) => e.status === "OPEN")
          .map((e) => ({ id: e.id, reason: e.reason, raisedBy: e.raisedBy, kind: e.kind ?? "primary" })),
      },
      a,
      limit,
    );
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
    // Full lists: `pageAggregate` applies `top` to the flat report and the
    // index must name the section's real size. See `failuresView`.
    const byCount = <T extends { count: number }>(rows: T[]): T[] => rows.sort((x, y) => y.count - x.count);
    return this.pageAggregate(
      "mesh_run_digest",
      {
        outcome,
        reason,
        scanned: { events: events.length, recentTurns: turns.length },
        goal: buildGoalView(state),
        eventCount: state.eventCount,
        agentFailures: sig.agentFailures.length,
        openEscalations: [...state.escalations.values()].filter((e) => e.status === "OPEN").length,
        blocks,
        interesting: interesting.map((type) => ({ type, count: byType.get(type) ?? 0 })).filter((r) => r.count > 0),
        tokens: {
          mission: mission?.consumed ?? null,
          perAgent: [...state.agents.values()].map((r) => ({ agentId: r.definition.id, tokens: r.state.tokensConsumed })),
        },
        turnsWithEveryOpRejected: sig.allRejectedTurns,
      },
      {
        denials: byCount([...sig.denials.values()]),
        refusedSends: byCount([...sig.refusedSends.values()]),
        rejectedOps: byCount([...sig.opFailures.values()]),
        turnsWithZeroToolCalls: [...sig.noToolTurns.entries()]
          .map(([agentId, count]) => ({ agentId, count }))
          .sort((x, y) => y.count - x.count),
        stuckArtifacts: [...state.artifacts.values()]
          .filter((art) => !TERMINAL_ARTIFACT_STATUS.has(art.status))
          .map((art) => ({ id: art.id, name: art.name, type: art.type, status: art.status })),
        topEventTypes: [...byType.entries()]
          .sort((x, y) => y[1] - x[1])
          .map(([type, count]) => ({ type, count })),
      },
      a,
      top,
    );
  }

  private buildTools(): McpToolDefinition[] {
    const str = (desc: string) => ({ type: "string", description: desc });
    const strArr = (desc: string) => ({ type: "array", items: { type: "string" }, description: desc });
    const obj = (desc: string) => ({ type: "object", description: desc });
    // Every tool that carries a message type takes its enum from the protocol
    // catalogue rather than a hand-copied list. `mesh_broadcast` used to
    // declare a free string, so it would announce a type `mesh_send` had
    // already refused, and the model was given no hint of the vocabulary it
    // was meant to pick from.
    //
    // `mesh_respond` takes this same full catalogue rather than the narrower
    // `RESPONSE_TYPES`, and that is deliberate: the respond op's own field is
    // a `MessageType`, and which replies actually DISCHARGE an ask is decided
    // separately, by `projections-messaging`. Narrowing here would refuse
    // legal messages on the strength of a list that answers a different
    // question.
    //
    // The one exception is the verdicts (`VERDICT_MESSAGE_TYPES`): offering
    // APPROVE/REJECT/VETO as a message type offered a verdict that records
    // nothing. Removed from what a seat is SHOWN only — `callTool` does not
    // check the enum, and the wire still carries them.
    const msgType = (desc: string) => ({ ...str(desc), enum: MESSAGE_TYPES.filter((t) => !VERDICT_MESSAGE_TYPES.has(t)) });
    // The only field on an ask that lets the asker spend LESS of everyone
    // else's attention, so it is declared on every tool that opens a
    // commitment rather than only on the contract path. An ask carrying one
    // is never nudged and never escalates as a stalemate: at its deadline the
    // mesh discharges it `defaulted` and hands the asker back the value it
    // named. The description says "you will proceed" rather than "we assume"
    // on purpose — the value is the ASKER's own commitment, not a guess the
    // mesh makes on its behalf.
    const ifUnanswered = {
      type: "object",
      description: "What you will do if nobody answers. Pass it whenever you can name that in advance: the mesh then stops chasing this ask for you, tells the recipient that silence is a legal ending, and at the deadline hands your own default back to you instead of raising a card for a human.",
      required: ["assume"],
      properties: {
        assume: { description: "the value you will proceed with — recorded on the ask and handed back to you verbatim" },
        afterMs: { type: "number", exclusiveMinimum: 0, description: "how long to wait first. Omit it only on a mesh that sets its own commitment deadline; with neither, the ask is refused rather than left to wait forever." },
      },
      additionalProperties: false,
    };
    return [
      { name: "mesh_send", description: "Send a typed message to agents (structured mesh protocol; never communicate outside the mesh).", inputSchema: { type: "object", required: ["type", "to"], properties: { type: msgType("message type"), to: strArr("recipient agent ids"), threadId: str("existing thread id"), newThread: obj("{subject, artifactRefs?} to open a thread"), replyTo: str("message id being answered"), artifactRefs: strArr("artifact:// URIs or {uri,...} objects"), payload: obj("natural-language payload"), note: str("free prose for the recipient; never parsed by the mesh, carries no authority"), priority: str("LOW|NORMAL|HIGH|URGENT"), taskId: str("task context"), ifUnanswered }, additionalProperties: false } },
      { name: "mesh_broadcast", description: "Broadcast an INFORM-class message to every mesh participant.", inputSchema: { type: "object", required: ["type"], properties: { type: msgType("message type"), payload: obj("payload"), note: str("free prose for the recipient; never parsed by the mesh, carries no authority"), artifactRefs: strArr("artifact:// URIs or {uri,...} objects") }, additionalProperties: false } },
      { name: "mesh_collab", description: "Open a TIME-BOXED discussion with other agents, for work too open-ended for a single request. It obliges nobody to answer, but it is bounded: it ends on a clock and on a message count, and running past either raises a card for the human. Prefer mesh_request when you can name what you want; use this only for genuine discovery, and close it with mesh_collab_close as soon as you have what you came for.", inputSchema: { type: "object", required: ["with", "topic"], properties: { with: strArr("agent ids to include"), topic: str("what this discussion is for"), payload: obj("opening message"), boxMs: { type: "number", description: "shorten the time box (ms); it can never be lengthened" }, maxExchanges: { type: "number", description: "shorten the message budget; it can never be raised" }, artifactRefs: strArr("artifact:// URIs or {uri,...} objects") }, additionalProperties: false } },
      { name: "mesh_collab_close", description: "Close a discussion you are part of, recording what came of it. Closing early costs nothing; letting it run to its edge always raises a card.", inputSchema: { type: "object", required: ["threadId", "outcome"], properties: { threadId: str("the collab thread"), outcome: str("what was decided or learned") }, additionalProperties: false } },
      // `requestType` stays a free string on purpose — but no longer for the
      // reason that stood here. That reason was "`REQUEST_TYPES` omits
      // CHALLENGE", and it is now false: the catalogue derives the list from
      // `OBLIGING_MESSAGE_TYPES`, so CHALLENGE is in it and the two lists
      // cannot drift apart again.
      //
      // The list is still the wrong thing to constrain this field to, for a
      // reason that does not expire. It is `@deprecated` and it answers a
      // TYPE-ONLY question, while whether a message actually obliges anybody
      // is `obligesRecipients`, which also reads `control.mode` — a REQUEST
      // sent as a broadcast obliges nobody at all. An enum here would
      // advertise a debt guarantee the field is not in a position to make,
      // and would do it in the one place a seat reads as authoritative.
      //
      // The durable answer is not a better enum. It is `mesh_call`, which
      // names the ASK rather than its wire type and has its request shape
      // checked before anyone is woken — which is why this tool leaves the
      // manifest entirely under `bus.vocabulary: "contracts"`.
      { name: "mesh_request", description: "Open a typed request to other agents (asynchronous; you will be woken on response).", inputSchema: { type: "object", required: ["to"], properties: { to: strArr("recipients"), requestType: str("REQUEST_* type"), subject: str("thread subject"), threadId: str("existing thread to ask in; leave unset to open a new one"), replyTo: str("message id this request follows up on"), artifactRefs: strArr("artifact:// URIs or {uri,...} objects"), payload: obj("payload"), note: str("free prose for the recipient; never parsed by the mesh, carries no authority"), ifUnanswered }, additionalProperties: false } },
      { name: "mesh_respond", description: "Respond to a specific received message.", inputSchema: { type: "object", required: ["messageId", "type"], properties: { messageId: str("message being answered"), type: msgType("response message type"), payload: obj("payload"), artifactRefs: strArr("artifact:// URIs or {uri,...} objects") }, additionalProperties: false } },
      { name: "mesh_discharge", description: "Close a request addressed to you that you will NOT answer, stating why. Use instead of staying silent: an unanswered request nudges, burns budget, and eventually escalates to a human as a stalemate.", inputSchema: { type: "object", required: ["messageId", "reason"], properties: { messageId: str("the request you are closing"), reason: str("why it will not be answered, in your own words — the asker reads this"), refusal: str("WHICH no this is, named from the contract's refusal set. The ask's mail line lists the names its contract admits; passing one lets the asker tell 'wrong seat' from 'bad ask' from 'I disagree' without interpreting your prose. Omit it and nothing is checked — prose alone still settles the ask.") }, additionalProperties: false } },
      // The mirror of `mesh_discharge`, and it exists because the asker had
      // no move that reaches this state at all: a request that stopped being
      // worth answering could only be waited on or CHASED, and a chase is an
      // interrupt charged to someone else's attention, demanding an answer to
      // a question the asker no longer needs. Failing both, the ask aged into
      // the nudge ladder and raised an operator card — a human woken to
      // arbitrate a question nobody wanted answered. The credential is the
      // ask's own `from`, which is the exact opposite of `mesh_discharge`'s:
      // a refusal is authorized by OWING the answer, a retraction by having
      // ASKED the question.
      { name: "mesh_withdraw", description: "Close a request that YOU raised, because you no longer need the answer. Every agent who still owes you one is told to stop and released from the debt. Use it instead of waiting or chasing for an answer that stopped mattering: an abandoned ask nudges, burns budget, and eventually escalates to a human as a stalemate.", inputSchema: { type: "object", required: ["messageId"], properties: { messageId: str("the request you raised and no longer want"), reason: str("why it is no longer wanted; recorded and shown to the agents released by it") }, additionalProperties: false } },
      // The collapsed vocabulary's answer and its tell — the two acts no
      // contract can name, because neither of them is an ask. Advertised only
      // under `bus.vocabulary: "contracts"` and registered always; see
      // CONTRACT_VOCABULARY_TOOLS.
      //
      // Neither takes a `type`. That is the whole of what this mode buys: a
      // seat answering a question can no longer be wrong about what to call
      // its answer, which was the single most expensive mistake in the
      // vocabulary (one agent burned 18 turns on `RESULT`).
      { name: "mesh_reply", description: "Answer a message addressed to you. This is what settles an ask: the mesh matches your answer to the request it discharges and checks it against the contract the asker used. If you will NOT answer, use mesh_discharge instead of staying silent.", inputSchema: { type: "object", required: ["messageId", "response"], properties: { messageId: str("the message you are answering"), response: obj("your answer — the fields the contract said an answer carries"), artifactRefs: strArr("artifact:// URIs or {uri,...} objects") }, additionalProperties: false } },
      { name: "mesh_announce", description: "Say something that obliges nobody to answer. Omit 'to' and every seat in the mesh hears it; name seats and only they do. Use mesh_call when you actually want something back — an announcement nobody owes an answer to is nobody's turn.", inputSchema: { type: "object", required: ["payload"], properties: { payload: obj("what you are telling them"), note: str("free prose for the recipient; never parsed by the mesh, carries no authority"), to: strArr("recipient agent ids; omit to tell everyone"), threadId: str("existing thread id"), artifactRefs: strArr("artifact:// URIs or {uri,...} objects") }, additionalProperties: false } },
      { name: "mesh_delegate", description: "Delegate a task to another agent (creates a task and a DELEGATE message).", inputSchema: { type: "object", required: ["to", "title", "description"], properties: { to: str("delegate target"), title: str("task title"), description: str("task spec"), requiredCapabilities: strArr("capabilities the target must hold"), artifactRefs: strArr("artifact:// URIs or {uri,...} objects"), budgetHint: obj("{maxTokens}") }, additionalProperties: false } },
      { name: "mesh_block", description: "Exercise blocking authority (quality.block / security.block) on a subject.", inputSchema: { type: "object", required: ["subject", "reason"], properties: { subject: str("domain subject e.g. release / artifact id domain"), artifactId: str("artifact"), reason: str("blocking reason") }, additionalProperties: false } },
      { name: "mesh_approve", description: "Approve a subject domain or artifact review. On an artifact this also answers the review request that asked you for it — do not follow it with a mesh_respond or mesh_send; a verdict typed as a message records nothing. A seat whose verdict in a domain is a pass (quality.pass for QA, security.pass for security) gives it with kind 'pass'; an approve from a seat that holds only the pass is recorded as one. If the verdict is recorded but does less than you meant (it cannot advance the artifact, you already recorded it on this version, or a criterion lands ASSERTED rather than EVIDENCED), the result says so in note.", inputSchema: { type: "object", required: ["subject"], properties: { subject: str("domain: architecture|implementation|quality|security|requirements|release|criterion:<id>"), artifactId: str("artifact if applicable"), comment: str("rationale"), kind: { type: "string", enum: ["approve", "pass"], description: "pass: give your <domain>.pass verdict (what the pass gates and quality-verified read); omit to approve" } }, additionalProperties: false } },
      { name: "mesh_reject", description: "Reject a subject domain or artifact review. On an artifact this also answers the review request that asked you for it — do not follow it with a mesh_respond or mesh_send; a verdict typed as a message records nothing.", inputSchema: { type: "object", required: ["subject"], properties: { subject: str("domain"), artifactId: str("artifact"), comment: str("reason") }, additionalProperties: false } },
      { name: "mesh_veto", description: "Veto an action (requires explicit veto authority in the subject domain).", inputSchema: { type: "object", required: ["subject"], properties: { subject: str("domain"), artifactId: str("artifact"), comment: str("reason") }, additionalProperties: false } },
      { name: "mesh_escalate", description: "Escalate a disagreement or blocker to the human seat.", inputSchema: { type: "object", required: ["reason"], properties: { reason: str("escalation reason"), detail: obj("structured detail"), conflictKey: str("stable key for repeated conflicts") }, additionalProperties: false } },
      // Three bodies, one rule: exactly one of content/fromPath/edits. The
      // description leads with the cheap two because the expensive one is what
      // a model reaches for unprompted — it already has the document in its
      // head and typing it out feels like the shortest path. It is the longest:
      // output is billed at five times fresh input, and on the mission this was
      // measured against, inline publishes were 17% of everything written.
      { name: "mesh_artifact_publish", description: "Publish an immutable artifact version; messages reference artifacts instead of pasting content. Give exactly ONE body: fromPath (a file you already wrote — cheapest, the mesh reads it), edits (changes to a previous version, with asVersionOf), or content (inline — only for something that was never a file).", inputSchema: { type: "object", required: ["name", "type"], properties: { name: str("artifact name"), type: { ...str("artifact type — the mesh accepts only these"), enum: [...ARTIFACT_TYPES] }, fromPath: str("path to a file in YOUR workspace, relative to its root. Prefer this: the mesh reads the file, so the content costs you nothing to publish."), edits: { type: "array", description: "exact replacements against the version named by asVersionOf — use instead of re-sending a whole revised document", items: { type: "object", required: ["old", "new"], properties: { old: str("text to replace; must appear exactly once in the previous version"), new: str("what replaces it; empty string deletes") }, additionalProperties: false } }, content: str("full content, inline. Only when the document is not already a file and does not revise one."), status: str("optional initial status"), scope: str("'mission' = every agent sees it all mission; 'work' = you and its reviewers. Defaults by type."), metadata: obj("metadata"), asVersionOf: str("artifact id to version (you must be its owner)"), parentArtifactId: str("lineage parent") }, additionalProperties: false } },
      { name: "mesh_artifact_read", description: "Read the content of an artifact version by URI or id. Large artifacts come back in parts: if the result says truncated, call again with the offset it gives you.", inputSchema: { type: "object", required: ["artifactRef"], properties: { artifactRef: str("artifact:// URI or artifact id"), offset: { type: "number", description: "character offset to resume from, taken from a previous truncated result's nextOffset" } }, additionalProperties: false } },
      { name: "mesh_artifact_transition", description: "Request an artifact state-machine transition (runtime-enforced gates apply).", inputSchema: { type: "object", required: ["artifactId", "to"], properties: { artifactId: str("artifact id"), to: str("target ArtifactStatus"), evidence: str("evidence description") }, additionalProperties: false } },
      { name: "mesh_request_review", description: "Move an artifact to review and request reviewers.", inputSchema: { type: "object", required: ["artifactId", "reviewers"], properties: { artifactId: str("artifact id"), reviewers: strArr("reviewer agent ids"), ifUnanswered }, additionalProperties: false } },
      { name: "mesh_task_claim", description: "Claim an open task you have the capabilities for.", inputSchema: { type: "object", required: ["taskId"], properties: { taskId: str("task id") }, additionalProperties: false } },
      { name: "mesh_task_complete", description: "Complete a claimed task with a summary and artifact evidence.", inputSchema: { type: "object", required: ["taskId", "summary"], properties: { taskId: str("task id"), summary: str("what was done"), artifacts: strArr("evidence artifact URIs") }, additionalProperties: false } },
      { name: "mesh_task_create", description: "Create a task in the shared backlog.", inputSchema: { type: "object", required: ["title", "description"], properties: { title: str("task title"), description: str("spec"), assignedTo: str("optional assignee"), requiredCapabilities: strArr("capabilities"), artifactRefs: strArr("artifact:// URIs or {uri,...} objects") }, additionalProperties: false } },
      { name: "mesh_research_request", description: "Ask a service-mode explorer for repository/system research.", inputSchema: { type: "object", required: ["to", "question"], properties: { to: str("explorer agent id"), question: str("research question"), ifUnanswered }, additionalProperties: false } },
      { name: "mesh_decision_propose", description: "Propose an organizational decision (goes to the decision registry). Returns its decisionId, which mesh_decision_ratify takes.", inputSchema: { type: "object", required: ["topic", "decision"], properties: { topic: str("decision topic"), decision: obj("structured decision"), evidence: strArr("artifact refs") }, additionalProperties: false } },
      { name: "mesh_decision_ratify", description: "Ratify a proposed decision (requires architecture.approve authority).", inputSchema: { type: "object", required: ["decisionId"], properties: { decisionId: str("decision id") }, additionalProperties: false } },
      { name: "mesh_lease_acquire", description: "Acquire the single-writer lease on an artifact you own. Returns the leaseId.", inputSchema: { type: "object", required: ["artifactId"], properties: { artifactId: str("artifact id"), files: strArr("files you intend to touch") }, additionalProperties: false } },
      { name: "mesh_lease_release", description: "Release your write lease on an artifact.", inputSchema: { type: "object", required: ["artifactId"], properties: { artifactId: str("artifact id") }, additionalProperties: false } },
      { name: "mesh_request_commit", description: "Ask the tech lead(s) holding implementation.approve to commit a CodePatch you cannot commit yourself.", inputSchema: { type: "object", required: ["artifactId"], properties: { artifactId: str("CodePatch artifact"), comment: str("optional note for the committer") }, additionalProperties: false } },
      { name: "mesh_commit", description: "Commit staged work in your git worktree into a new artifact version (gate-checked). Returns the commit sha.", inputSchema: { type: "object", required: ["artifactId", "message"], properties: { artifactId: str("CodePatch artifact"), message: str("commit message"), files: strArr("optional explicit file list") }, additionalProperties: false } },
      { name: "mesh_merge", description: "Merge a MERGEABLE patch (requires git.merge capability and configured approvals). Returns what landed, as result.", inputSchema: { type: "object", required: ["artifactId"], properties: { artifactId: str("artifact id"), comment: str("merge note") }, additionalProperties: false } },
      { name: "mesh_wait", description: "Declare that you are waiting for responses (runtime state becomes WAITING).", inputSchema: { type: "object", properties: { reason: str("what you await") }, additionalProperties: false } },
      { name: "mesh_done", description: "Finish your current activation turn.", inputSchema: { type: "object", properties: { summary: str("turn summary") }, additionalProperties: false } },
      { name: "mesh_remember", description: "Persist a note into your own L2 agent memory.", inputSchema: { type: "object", required: ["key", "value"], properties: { key: str("note key"), value: str("note value") }, additionalProperties: false } },
      { name: "mesh_write_continuity", description: "Hand your working state to the session that replaces yours. Call this when told your session is about to be rotated. Do NOT list your open asks — the mesh fills those in.", inputSchema: { type: "object", required: ["nextIntent"], properties: { nextIntent: str("one sentence: what you were about to do next"), beliefs: { type: "array", description: "what you concluded, and what each conclusion stands on", items: { type: "object", required: ["claim", "basis", "confidence"], properties: { claim: str("what you believe"), basis: str("artifact uri, message id or event id that supports it"), confidence: { type: "string", enum: ["asserted", "assumed"], description: "asserted = you verified it; assumed = you proceeded on it unchecked" } }, additionalProperties: false } }, rejected: { type: "array", description: "what you already tried that was turned down", items: { type: "object", required: ["what", "rejectedBy", "reason"], properties: { what: str("artifact uri, or a short description"), rejectedBy: str("who rejected it"), reason: str("why") }, additionalProperties: false } } }, additionalProperties: false } },
      { name: "mesh_contracts", description: "List the named asks this mesh knows how to route, with the shape each one expects and who can answer it. Call this before mesh_call when you are unsure what to ask for.", inputSchema: { type: "object", properties: { role: str("only contracts a seat in this role would raise") }, additionalProperties: false } },
      { name: "mesh_call", description: "Raise a named contract (see mesh_contracts). Preferred over mesh_send for the asks it covers: the mesh picks the recipient, validates the request shape before anyone is woken, and names the refusals you may get back. Unknown names are refused with the list of known ones.", inputSchema: { type: "object", required: ["contract"], properties: { contract: str("contract name, e.g. review.artifact"), request: obj("fields the contract requires"), to: strArr("override the recipient the mesh would pick"), ifUnanswered }, additionalProperties: false } },
      // This is the ONLY channel that lets an agent recover from a plan-gate
      // rejection inside the SAME turn: a prose rejection rides endSummary into
      // memory and is not read until the next activation, but an MCP caller
      // sees the refusal in its tool result and can call mesh_plan immediately.
      { name: "mesh_plan", description: "Record your PRIVATE ordered checklist for the task you have claimed (not visible to other agents, not claimable by them). Replaces any previous plan. Required before hard actions when your mesh enables the plan gate — list the capabilities each step will use.", inputSchema: { type: "object", required: ["steps"], properties: { steps: { type: "array", description: "ordered steps", items: { type: "object", required: ["text"], properties: { id: str("stable step id (generated if omitted)"), text: str("what this step does"), status: { type: "string", enum: ["PENDING", "DONE"], description: "defaults to PENDING" }, capabilities: strArr("capability tokens this step will use, e.g. repository.write, git.commit") }, additionalProperties: false } }, taskId: str("defaults to your currently claimed task") }, additionalProperties: false } },
      { name: "mesh_plan_step", description: "Mark one step of your plan done (or reopen it).", inputSchema: { type: "object", required: ["stepId"], properties: { stepId: str("the step's number in your plan (1 is the first) or its id"), status: { type: "string", enum: ["PENDING", "DONE"], description: "defaults to DONE" } }, additionalProperties: false } },
      { name: "mesh_spawn_worker", description: "Spawn a depth-1 delegated worker (only if your delegation policy allows). Returns its workerId and taskId. Parent receives only the structured result contract.", inputSchema: { type: "object", required: ["title", "taskSpec"], properties: { title: str("worker task title"), taskSpec: str("precise task specification"), capabilities: strArr("required capabilities"), budgetTokens: { type: "number", description: "worker token budget" } }, additionalProperties: false } },
      { name: "mesh_submit_result", description: "Worker-only: submit the fractal result contract {status,summary,artifacts,findings,risks,recommendation}.", inputSchema: { type: "object", required: ["taskId", "result"], properties: { taskId: str("delegated task"), result: obj("SubAgentResult contract") }, additionalProperties: false } },
      { name: "mesh_run_status", description: "Read-only mission snapshot: goal status and criteria progress, event/message/task/token counters and rates, per-agent lifecycle/cost/last error, open escalations. Use to answer 'how is the run doing?'. If the snapshot does not fit one result it returns a `sections` index instead — read one with section=\"agents\" or section=\"openEscalations\", paging with offset.", inputSchema: { type: "object", properties: { section: str("read one section instead of the whole snapshot: agents | openEscalations"), offset: { type: "number", description: "rows to skip within that section (default 0) — use nextOffset from a previous call" } }, additionalProperties: false } },
      { name: "mesh_query_events", description: "Read-only query over the event log, oldest-first within a page of the newest matches. Returns compact timeline entries; lastSeq is a cursor for incremental polling and nextOffset walks back into older events. Use includePayload only when the summary is not enough. A page is bounded by characters: if the result says truncated, call again with its nextOffset. To find verdicts, use type \"verdict\": approvals are review.approved, and an architecture.approved without one is from before that rule.", inputSchema: { type: "object", properties: { type: str("exact event type, e.g. message.sent or agent.failed — or \"verdict\" for every recorded approve/pass/reject/veto"), types: strArr("several exact event types at once; combined with type"), actorId: str("only events acted by this agent"), sinceSeq: { type: "number", description: "only events after this sequence number (poll cursor, walks forward)" }, offset: { type: "number", description: "skip this many of the NEWEST matches (default 0) — use nextOffset from a previous truncated result to read older events" }, limit: { type: "number", description: "max events (default 30, max 200)" }, includePayload: { type: "boolean", description: "include full event payloads (default false)" } }, additionalProperties: false } },
      { name: "mesh_steps", description: "Read-only turn/step traces: lifecycle, status, ops, tokens, timing, errors for recent agent turns (log reconstruction merged with live turns). Filter by agent, status or exact turn id to find failures or slow/no-op turns. A page is bounded by characters: if the result says truncated, call again with its nextOffset.", inputSchema: { type: "object", properties: { limit: { type: "number", description: "max steps (default 20, max 100)" }, offset: { type: "number", description: "steps to skip (default 0) — use nextOffset from a previous call" }, agentId: str("filter to one agent"), status: { ...str("filter by turn status"), enum: ["running", "ok", "waiting", "blocked", "failed"] }, turnId: str("exact turn id") }, additionalProperties: false } },
      { name: "mesh_failures", description: "Read-only failure report: runtime agent failures, policy denials (ops and activations policy turned away), sends policy refused, rejected ops, turns where every op was rejected, turns with zero tool calls, gate-blocked/non-terminal artifacts, open escalations. Start here when asked what went wrong. Denials and refused sends are read from projections, so they survive a restart and ignore the window; window bounds only the event-derived sections. If the report does not fit one result it returns a `sections` index instead — read one with section=\"denials\" (etc.), paging with offset.", inputSchema: { type: "object", properties: { limit: { type: "number", description: "max rows per section (default 20, max 100)" }, window: { type: "number", description: "how many recent events to scan; bounds the event-derived sections only (default 2000, max 10000)" }, section: str("read one section instead of the whole report: agentFailures | failedTurns | denials | refusedSends | rejectedOps | turnsWithZeroToolCalls | stuckArtifacts | openEscalations"), offset: { type: "number", description: "rows to skip within that section (default 0) — use nextOffset from a previous call" } }, additionalProperties: false } },
      { name: "mesh_agent_activity", description: "Read-only per-agent activity snapshot: lifecycle, running turn, mailbox depth, activations, tokens, last error. Optionally filter to one agent.", inputSchema: { type: "object", properties: { agentId: str("filter to one agent") }, additionalProperties: false } },
      { name: "mesh_run_digest", description: "Read-only one-shot run digest over a bounded event window: outcome, goal progress, denial/op-failure/no-tool-turn counts, agent failures, stuck artifacts, conflicts, mission tokens and top event types. Cheapest broad answer before drilling into other tools. If the digest does not fit one result it returns a `sections` index instead — read one with section=\"denials\" (etc.), paging with offset.", inputSchema: { type: "object", properties: { top: { type: "number", description: "max rows per section (default 5, max 20)" }, window: { type: "number", description: "how many recent events to scan (default 2000, max 10000)" }, section: str("read one section instead of the whole digest: denials | refusedSends | rejectedOps | turnsWithZeroToolCalls | stuckArtifacts | topEventTypes"), offset: { type: "number", description: "rows to skip within that section (default 0) — use nextOffset from a previous call" } }, additionalProperties: false } },
      { name: "mesh_inbox", description: "Read-only view of YOUR OWN mailbox: messages addressed to you that you have not answered yet, in box order — sender, type, priority, thread subject, note, artifact refs and payload, with answerOwed marking the ones you still owe a reply (an ask that already closed says how, in closed) and dueBy giving the deadline they will be closed at where the mesh sets one. A page is bounded by characters, not just by `limit`: if the result says truncated, call again with its nextOffset — raising `limit` will not make one page bigger. Use it when a wake showed you a few messages and you want the rest of the queue, or to see what is waiting before you finish a turn. This is a VIEW, not a receipt: nothing is marked read, the mail stays owed, and you are still woken for it.", inputSchema: { type: "object", properties: { limit: { type: "number", description: "max messages to return (default 25, max 200)" }, offset: { type: "number", description: "skip this many messages (default 0) — use nextOffset from a previous call to page" } }, additionalProperties: false } },
    ];
  }
}

export function createMcpToolset(supervisor: Supervisor, opts: McpToolsetOptions = {}): McpToolset {
  return new McpToolset(supervisor, opts);
}
