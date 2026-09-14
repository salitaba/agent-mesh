import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import {
  query,
  type CanUseTool,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  BackendUnreachableError,
  normalizeCapability,
  type AgentDefinition,
  type AgentInput,
  type AgentOutput,
  type AgentRuntime,
  type AgentRuntimeStatus,
  type AgentSession,
  type DesignerPromptOptions,
  type DesignerRuntime,
  type DesignerStreamDelta,
  type DesignerStreamResult,
  type MeshOp,
  type ModelCatalogue,
  type RuntimeContext,
} from "../../protocol/src/index";
// The mesh op protocol is one contract, so it gets one parser. These live in
// the opencode adapter today purely because it was written first; they are
// pure text functions with no opencode coupling. Follow-up: lift them into
// packages/agent-runtime as runtime commons and have both adapters import
// from there, removing this sideways package dependency.
import { parseMeshOps, extractSummary, extractDeclaredSummary, shortDigest } from "../../runtime-opencode/src/index";
// The output-voice rules belong to the prompt layer, not to either adapter:
// importing them from there is what keeps this runtime and runtime-opencode
// byte-identical on the part of the prompt that must not vary by backend.
import { withOutputVoice } from "../../core/src/context";

/** Tools that write to the repository. Gated on a write-ish capability. */
const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);
/** Tools that execute arbitrary commands. Gated on shell/test execution. */
const EXEC_TOOLS = new Set(["Bash", "BashOutput", "KillShell"]);
/** Tools that reach the network. Gated on network.request. */
const NETWORK_TOOLS = new Set(["WebFetch", "WebSearch"]);
/**
 * Read-only inspection, always allowed — mirrors `read: "allow"` in the
 * opencode permission block. An agent that cannot read its own workspace
 * cannot do useful work under any capability set.
 */
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "TodoWrite"]);

/** Prefix of the MCP bridge back into the mesh bus. Never gated. */
const MESH_MCP_PREFIX = "mcp__mesh";

/**
 * Normalize a config-shaped model spec to the bare id the SDK expects.
 *
 * mesh.yaml writes `"provider/model-id"` for the opencode runtime, but Claude
 * Code names models without a provider (`"claude-opus-5"`). Strip a leading
 * provider segment when present so a single `model:` key works under either
 * runtime; a bare id passes through untouched. Mirrors `parseModelRef`'s
 * split-on-first-slash rule so compound ids keep their remainder.
 */
export function toClaudeModelId(spec: string | undefined): string | undefined {
  const trimmed = spec?.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf("/");
  return slash > 0 && slash < trimmed.length - 1 ? trimmed.slice(slash + 1) : trimmed;
}

export interface ClaudeAdapterOptions {
  /**
   * Model id passed through to the SDK (e.g. "claude-opus-5"). Omit to take
   * the CLI's default.
   */
  model?: string;
  /** Override the argv of the mesh MCP bridge. Tests inject a stub here. */
  mcpCommand?: string[];
  /** Path to the Claude Code executable; omit to use the SDK's bundled one. */
  executablePath?: string;
  /**
   * Wall-clock ceiling for a single turn. A turn that outruns it is aborted
   * and surfaces as a failed turn rather than wedging the scheduler slot.
   */
  turnTimeoutMs?: number;
  /**
   * How long `start`/`restoreSession` wait for the CLI's `system`/`init`
   * handshake before giving the backend the benefit of the doubt. This is the
   * analogue of opencode's readiness probe loop, except a miss here is not
   * fatal — see `confirmAlive`.
   */
  startupProbeMs?: number;
  /** Extra SDK options merged last, for escape hatches and tests. */
  extraOptions?: Partial<Options>;
}

/**
 * Map one turn's SDK usage onto the mesh's budget shape.
 *
 * `cache_read` is deliberately EXCLUDED from `total`, matching the opencode
 * adapter's rule. This is load-bearing on a streaming-input session: the SDK
 * documents `usage` as per-turn but `total_cost_usd`/`modelUsage` as
 * CUMULATIVE across turns of the same query, so charging a turn off either of
 * those would re-bill the whole conversation every turn — the runaway that
 * previously exhausted 60k thread budgets and looked like "the mesh stopped
 * for no reason". Cached prefix reads stay observable via `cacheRead`.
 */
export function usageToTokens(u: ClaudeTurnUsage | undefined): AgentOutput["tokensUsed"] {
  const usage = u ?? {};
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  return { input, output, total: input + output + cacheWrite, cacheRead };
}

export interface ClaudeTurnUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Capability-to-tool gate. The opencode adapter expresses this as a static
 * permission block in a generated config; the SDK offers a callback instead,
 * which is a closer fit — the decision is computed from the same capability
 * set, but an unknown or newly added tool fails closed here instead of
 * falling through whatever the config file happened not to mention.
 */
export function buildPermissionGate(capabilities: string[]): CanUseTool {
  // Normalized here as well as at config load: capabilityGrants also arrive
  // from direct AgentDefinition construction (tests, bench harnesses).
  const caps = new Set(capabilities.map(normalizeCapability));
  const canEdit = caps.has("repository.write") || caps.has("architecture.write") || caps.has("test.write");
  const canExec = caps.has("shell.execute") || caps.has("test.execute");
  const canFetch = caps.has("network.request");
  // opencode renders git.commit as bash:"ask". There is no human on a mesh
  // turn to ask, and a pending prompt would stall the slot to its timeout,
  // so a commit-only seat gets exec rather than an unanswerable question.
  const canCommitOnly = caps.has("git.commit");

  const deny = (message: string) => ({ behavior: "deny" as const, message });

  return async (toolName, toolInput) => {
    if (toolName.startsWith(MESH_MCP_PREFIX)) return { behavior: "allow", updatedInput: toolInput };
    if (READ_TOOLS.has(toolName)) return { behavior: "allow", updatedInput: toolInput };
    if (EDIT_TOOLS.has(toolName)) {
      return canEdit
        ? { behavior: "allow", updatedInput: toolInput }
        : deny(`${toolName} denied: this seat holds no write capability (has: ${[...caps].join(", ") || "none"}).`);
    }
    if (EXEC_TOOLS.has(toolName)) {
      return canExec || canCommitOnly
        ? { behavior: "allow", updatedInput: toolInput }
        : deny(`${toolName} denied: this seat holds no shell.execute or test.execute capability.`);
    }
    if (NETWORK_TOOLS.has(toolName)) {
      return canFetch
        ? { behavior: "allow", updatedInput: toolInput }
        : deny(`${toolName} denied: this seat holds no network.request capability.`);
    }
    // Fail closed. A tool nobody mapped is a tool nobody authorized.
    return deny(`${toolName} is not available to mesh agents under the claude runtime.`);
  };
}

/** Serializable half of a session — this is what the mesh persists. */
interface ClaudeSessionHandle {
  sdkSessionId: string;
  model?: string;
}

interface TurnState {
  toolCalls: Array<{ name: string; args: unknown; resultDigest: string }>;
  onToken?: (delta: string) => void;
  settle: (outcome: { ok: true; msg: ResultMessage } | { ok: false; err: unknown }) => void;
  settled: boolean;
}

/** A finished turn: the result frame plus the tool calls observed during it. */
interface TurnResult {
  msg: ResultMessage;
  toolCalls: Array<{ name: string; args: unknown; resultDigest: string }>;
}

/**
 * The fields of SDKResultMessage this adapter reads. Narrowed deliberately:
 * the SDK's result type carries ~30 telemetry fields we have no use for, and
 * naming only what we consume keeps the mapping auditable.
 */
interface ResultMessage {
  subtype: string;
  is_error: boolean;
  result?: string;
  session_id: string;
  num_turns?: number;
  usage?: ClaudeTurnUsage;
}

/** Live half of a session — never persisted, rebuilt on restore. */
interface LiveSession {
  sdkSessionId: string;
  q: Query;
  inbox: PushQueue<SDKUserMessage>;
  pending?: TurnState;
  closed: boolean;
  /**
   * Resolves when the CLI has emitted `system`/`init`, rejects if the pump
   * dies first. `query()` is lazy — nothing spawns until the generator is
   * pulled — so this handshake is the only point at which we learn whether a
   * backend exists at all. Never left unhandled: `open` attaches a catch.
   */
  ready: Promise<void>;
  markReady: () => void;
  markDead: (err: Error) => void;
  /** Whether `ready` has already settled, so the pump settles it only once. */
  settledReady: boolean;
  /** MCP servers the CLI reported at init, used to detect a mute mesh seat. */
  mcpStatus?: Array<{ name: string; status: string }>;
  /** Model the assistant frames actually reported. Authoritative when present. */
  lastModel?: string;
  /** Model we asked for, used until the backend tells us what it really ran. */
  configuredModel?: string;
}

/**
 * Async iterable driven by `push`. The SDK takes streaming input as an
 * AsyncIterable it consumes for the lifetime of the query; we need to feed it
 * one message per mesh turn, arriving whenever the supervisor schedules us.
 */
class PushQueue<T> {
  private items: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private done = false;

  push(item: T): void {
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    this.done = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T, void> {
    for (;;) {
      const buffered = this.items.shift();
      if (buffered !== undefined) {
        yield buffered;
        continue;
      }
      if (this.done) return;
      const r = await new Promise<IteratorResult<T>>((res) => this.waiters.push(res));
      if (r.done) return;
      yield r.value;
    }
  }
}

/**
 * Claude Code as a mesh agent runtime.
 *
 * Unlike the opencode adapter there is no server to spawn and no HTTP surface:
 * Claude Code has no daemon mode. Instead each agent holds one long-lived
 * `query()` in streaming-input mode for its whole lifetime, and each mesh turn
 * pushes one user message into it and waits for the matching `result` frame.
 *
 * Streaming input is not an optimization here — it is required. The SDK's
 * control requests (`interrupt`, `setPermissionMode`) are only supported on a
 * streaming query, so a per-turn one-shot `query()` could not implement
 * `AgentRuntime.interrupt` at all.
 */
export class ClaudeRuntimeAdapter implements AgentRuntime, DesignerRuntime {
  readonly name = "claude";
  private statuses = new Map<string, AgentRuntimeStatus>();
  private live = new Map<string, LiveSession>();
  private turnTimeoutMs: number;
  private startupProbeMs: number;

  constructor(private options: ClaudeAdapterOptions = {}) {
    this.turnTimeoutMs = options.turnTimeoutMs ?? 600000;
    this.startupProbeMs = options.startupProbeMs ?? 10000;
  }

  /** Per-agent `model` from mesh.yaml, else the mesh-wide adapter default. */
  private modelFor(agent: AgentDefinition): string | undefined {
    return toClaudeModelId(agent.model) ?? this.options.model;
  }

  async start(agent: AgentDefinition, context: RuntimeContext): Promise<AgentSession> {
    // A valid UUID, because the SDK requires that shape for `sessionId` and we
    // want the mesh's own session id to BE the Claude session id — that is what
    // makes restoreSession a plain `resume` rather than a lookup table.
    const sdkSessionId = randomUUID();
    this.writeAgentFiles(agent, context);
    const s = this.open(agent, context, sdkSessionId, false);
    if (!(await this.confirmAlive(s))) {
      // Fail the start rather than hand back a session whose first turn will
      // die: the supervisor can seat an agent elsewhere at start time, but a
      // turn failure has already cost a scheduling slot.
      this.statuses.set(agent.id, "UNREACHABLE");
      this.live.delete(sdkSessionId);
      throw new BackendUnreachableError(`claude:${sdkSessionId}`, "claude backend did not start");
    }
    this.statuses.set(agent.id, "IDLE");
    return {
      sessionId: sdkSessionId,
      agentId: agent.id,
      runtime: this.name,
      createdAt: new Date().toISOString(),
      handle: { sdkSessionId, model: this.modelFor(agent) } satisfies ClaudeSessionHandle,
    };
  }

  /**
   * Rebuild the live query for a session the mesh already knows about. The
   * transcript lives in Claude's own session store, so this is a `resume`
   * rather than a replay of our own history.
   */
  async restoreSession(agent: AgentDefinition, sessionId: string, context: RuntimeContext): Promise<AgentSession | null> {
    try {
      this.writeAgentFiles(agent, context);
      const s = this.open(agent, context, sessionId, true);
      // Null here tells the supervisor to start a fresh session instead, which
      // is the whole point of restoreSession returning a nullable.
      if (!(await this.confirmAlive(s))) {
        this.statuses.set(agent.id, "UNREACHABLE");
        this.live.delete(sessionId);
        return null;
      }
      this.statuses.set(agent.id, "IDLE");
      return {
        sessionId,
        agentId: agent.id,
        runtime: this.name,
        createdAt: new Date().toISOString(),
        handle: { sdkSessionId: sessionId, model: this.modelFor(agent) } satisfies ClaudeSessionHandle,
      };
    } catch {
      return null;
    }
  }

  async send(session: AgentSession, input: AgentInput): Promise<AgentOutput> {
    const s = this.live.get(session.sessionId);
    if (!s || s.closed) {
      // No live query behind a session the supervisor still believes in. That
      // is the Claude-shaped equivalent of opencode's dead-backend case.
      this.statuses.set(session.agentId, "UNREACHABLE");
      throw new BackendUnreachableError(`claude:${session.sessionId}`, "no live session; call start or restoreSession first");
    }
    if (s.pending) {
      throw new Error(`claude runtime: turn already in flight for agent ${session.agentId}`);
    }

    this.statuses.set(session.agentId, "RUNNING");
    const result = await new Promise<TurnResult>((resolve, reject) => {
      const turn: TurnState = {
        toolCalls: [],
        onToken: input.onToken,
        settled: false,
        settle: (outcome) => {
          if (turn.settled) return;
          turn.settled = true;
          clearTimeout(timer);
          s.pending = undefined;
          // Tool calls ride out with the result: `s.pending` is cleared here,
          // so reading them off the session afterwards would always find none.
          if (outcome.ok) resolve({ msg: outcome.msg, toolCalls: turn.toolCalls });
          else reject(outcome.err);
        },
      };
      const timer = setTimeout(() => {
        // Abort the model, not the session: the query stays usable for the
        // next turn, matching opencode's per-turn abort semantics.
        void s.q.interrupt().catch(() => undefined);
        turn.settle({ ok: false, err: new Error(`claude runtime: turn exceeded ${this.turnTimeoutMs}ms`) });
      }, this.turnTimeoutMs);
      s.pending = turn;
      s.inbox.push({
        type: "user",
        message: { role: "user", content: input.instructions },
        parent_tool_use_id: null,
      } as SDKUserMessage);
    }).catch((err) => {
      this.statuses.set(session.agentId, "UNREACHABLE");
      throw err;
    });

    this.statuses.set(session.agentId, "IDLE");
    return this.toAgentOutput(result, s);
  }

  private toAgentOutput(turn: TurnResult, s: LiveSession): AgentOutput {
    const result = turn.msg;
    const text = result.result ?? "";
    const operations: MeshOp[] = parseMeshOps(text);
    const toolCalls = turn.toolCalls;
    const declared = extractDeclaredSummary(operations);
    // Same contract as the opencode adapter: `summary` stays the prose scrape
    // it has always been, and `declaredSummary` carries the agent's own `done`
    // summary when it gave one. Not yet a field on `AgentOutput`
    // (packages/protocol/src/types.ts), hence the widening on the literal.
    const output: AgentOutput & { declaredSummary?: string } = {
      text,
      operations,
      // Ops here are parsed out of prose, never typed. Agents that call the
      // mesh_* MCP tools execute through McpToolset directly and never reach
      // this mapping, so the typed-only transport rule is preserved.
      tokensUsed: usageToTokens(result.usage),
      model: s.lastModel ?? s.configuredModel,
      modelVersion: s.lastModel,
      toolCalls,
      summary: extractSummary(text),
      ...(declared ? { declaredSummary: declared } : {}),
      error: result.is_error ? (text || `claude turn failed: ${result.subtype}`) : undefined,
    };
    return output;
  }

  async interrupt(session: AgentSession): Promise<void> {
    const s = this.live.get(session.sessionId);
    if (!s || s.closed) return;
    await s.q.interrupt().catch(() => undefined);
  }

  /**
   * Suspend tears the live query down but keeps the session id. Claude has no
   * "paused process" state, and holding an idle CLI subprocess per suspended
   * agent is exactly the leak the mesh suspends agents to avoid. The transcript
   * is durable in Claude's session store, so `resume` rebuilds from it.
   */
  async suspend(session: AgentSession): Promise<void> {
    this.teardown(session.sessionId);
    this.statuses.set(session.agentId, "SUSPENDED");
  }

  async resume(session: AgentSession): Promise<void> {
    // Deliberately a no-op beyond the status flip: rebuilding the query needs
    // the AgentDefinition and RuntimeContext, which this signature does not
    // carry. The supervisor calls restoreSession for that, and `send` fails
    // loudly with BackendUnreachableError if it did not.
    this.statuses.set(session.agentId, "IDLE");
  }

  async stop(session: AgentSession): Promise<void> {
    this.teardown(session.sessionId);
    this.statuses.set(session.agentId, "STOPPED");
  }

  async getStatus(session: AgentSession): Promise<AgentRuntimeStatus> {
    const s = this.live.get(session.sessionId);
    const tracked = this.statuses.get(session.agentId) ?? "IDLE";
    // There is no health endpoint to probe — no server exists. Liveness is
    // therefore "do we still hold an open query for this session", which is
    // the strongest claim this runtime can honestly make.
    if (!s || s.closed) return tracked === "SUSPENDED" || tracked === "STOPPED" ? tracked : "UNREACHABLE";
    return tracked;
  }

  // ---- DesignerRuntime ----------------------------------------------------
  //
  // The designer is a human's chat partner while they build a mesh, so these
  // turns get no mesh session, no bus identity and no MCP: a throwaway query
  // per prompt, torn down when it resolves. The capability gate is built from
  // an empty grant list, which leaves the designer read-only.

  async prompt(text: string, opts: DesignerPromptOptions = {}): Promise<string> {
    const { reply } = await this.promptStream(text, opts);
    return reply;
  }

  /**
   * One-shot designer turn with a live delta tap.
   *
   * Non-streaming input mode is deliberate here, unlike agent sessions: there
   * is no second turn to feed and nothing to interrupt, so a plain string
   * prompt avoids keeping a CLI process parked on an inbox that will never
   * receive anything.
   */
  async promptStream(
    text: string,
    opts: DesignerPromptOptions = {},
    onDelta?: (delta: DesignerStreamDelta) => void,
  ): Promise<DesignerStreamResult> {
    const q = query({
      prompt: text,
      options: {
        cwd: this.designerWorkspaceDir(),
        ...(opts.system ? { systemPrompt: { type: "custom" as const, prompt: opts.system } } : {}),
        canUseTool: buildPermissionGate([]),
        permissionMode: "default",
        includePartialMessages: true,
        ...(toClaudeModelId(opts.model) ?? this.options.model
          ? { model: toClaudeModelId(opts.model) ?? this.options.model }
          : {}),
        ...(this.options.executablePath ? { pathToClaudeCodeExecutable: this.options.executablePath } : {}),
        ...this.options.extraOptions,
      },
    });

    let reply = "";
    let thinking = "";
    try {
      for await (const msg of q as AsyncIterable<SDKMessage>) {
        if (msg.type === "stream_event") {
          const ev = (msg as { event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string } } }).event;
          if (ev?.type !== "content_block_delta" || !ev.delta) continue;
          if (ev.delta.type === "text_delta" && typeof ev.delta.text === "string") {
            reply += ev.delta.text;
            this.emitDelta(onDelta, { kind: "text", delta: ev.delta.text });
          } else if (ev.delta.type === "thinking_delta" && typeof ev.delta.thinking === "string") {
            thinking += ev.delta.thinking;
            this.emitDelta(onDelta, { kind: "thinking", delta: ev.delta.thinking });
          }
        } else if (msg.type === "result") {
          // The result carries the authoritative text; deltas are a preview of
          // it and can be missing entirely if the backend does not stream.
          const r = msg as unknown as ResultMessage;
          if (typeof r.result === "string" && r.result) reply = r.result;
        }
      }
    } finally {
      // A designer turn owns its process. Abandoning the generator without
      // this leaves a CLI parked for the life of the server.
      await q.interrupt?.().catch(() => undefined);
    }
    return { reply, thinking };
  }

  /** A delta consumer must never take the turn down with it. */
  private emitDelta(onDelta: ((d: DesignerStreamDelta) => void) | undefined, d: DesignerStreamDelta): void {
    try {
      onDelta?.(d);
    } catch {
      // Observability only.
    }
  }

  /**
   * Ask the CLI what models this installation can reach.
   *
   * `supportedModels()` is a control request, and control requests need a
   * streaming query — hence the empty inbox that is closed immediately. No
   * user message is ever pushed, so this costs no tokens.
   */
  async listModels(): Promise<ModelCatalogue> {
    const inbox = new PushQueue<SDKUserMessage>();
    const q = query({
      prompt: inbox,
      options: {
        cwd: this.designerWorkspaceDir(),
        ...(this.options.model ? { model: this.options.model } : {}),
        ...(this.options.executablePath ? { pathToClaudeCodeExecutable: this.options.executablePath } : {}),
        ...this.options.extraOptions,
      },
    });
    try {
      const models = await q.supportedModels();
      return {
        models: models.map((m) => m.value),
        default: this.options.model ?? models.find((m) => m.resolvedModel)?.resolvedModel,
      };
    } catch (err) {
      // The designer's model picker degrades to a text box rather than failing
      // the page, which is what the `error` field on the catalogue is for.
      return { models: [], error: err instanceof Error ? err.message : String(err) };
    } finally {
      inbox.close();
      await q.interrupt?.().catch(() => undefined);
    }
  }

  /**
   * Accepted and ignored: the opencode adapter needs this because it writes a
   * config file naming the bus before it can spawn, whereas designer turns
   * here run with no MCP at all and so have nothing to point at a bus. Kept
   * to satisfy the port, and because a future observed-designer mode would
   * need exactly this hook.
   */
  setDesignerObserve(_provider: () => { busUrl: string; token: string } | undefined): void {}

  /** Scratch cwd for designer turns, which have no mesh workspace of their own. */
  private designerWorkspaceDir(): string {
    const dir = path.join(os.tmpdir(), "mesh-claude-designer");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Close every live query. Used on host shutdown. */
  async stopAll(): Promise<void> {
    for (const sessionId of [...this.live.keys()]) this.teardown(sessionId);
  }

  private teardown(sessionId: string): void {
    const s = this.live.get(sessionId);
    if (!s) return;
    s.closed = true;
    s.pending?.settle({ ok: false, err: new BackendUnreachableError(`claude:${sessionId}`, "session torn down") });
    s.inbox.close();
    try {
      s.q.close();
    } catch {
      // Already gone; teardown is best-effort by design.
    }
    this.live.delete(sessionId);
  }

  /**
   * ROLE.md and MESH_CONTEXT.md, written for parity with the opencode adapter.
   * The role prompt reaches the model through the SDK `systemPrompt` option
   * rather than an instructions file, but keeping the files on disk means a
   * human debugging a run finds the same artifacts in the same place under
   * either runtime.
   */
  private writeAgentFiles(agent: AgentDefinition, context: RuntimeContext): string {
    const dir = path.join(context.workspacePath, ".mesh", "agents", agent.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "ROLE.md"), context.rolePromptText, "utf8");
    fs.writeFileSync(
      path.join(dir, "MESH_CONTEXT.md"),
      `Goal: ${context.goalId}\nMesh: ${context.meshId}\nWorkspace: ${context.workspacePath}\n`,
      "utf8",
    );
    return dir;
  }

  private open(agent: AgentDefinition, context: RuntimeContext, sdkSessionId: string, resuming: boolean): LiveSession {
    const existing = this.live.get(sdkSessionId);
    if (existing && !existing.closed) return existing;

    const inbox = new PushQueue<SDKUserMessage>();
    const options: Options = {
      cwd: context.workspacePath,
      // `custom` rather than the claude_code preset: a mesh seat is not a
      // general coding assistant, and inheriting the preset's workflow
      // instructions would compete with the role prompt for authority.
      //
      // The role prose is composed with the shared OUTPUT_VOICE_RULES rather
      // than passed through raw: this runtime builds the model's system prompt
      // itself, so without that the seat would answer under a different set of
      // output rules than the same seat on opencode — and `rolePromptText` is
      // empty whenever the config names role files instead of inline text.
      systemPrompt: { type: "custom", prompt: withOutputVoice(context.rolePromptText) },
      mcpServers: { mesh: this.meshMcpServer(agent, context) },
      canUseTool: buildPermissionGate(
        context.capabilityGrants.length ? context.capabilityGrants : agent.capabilities,
      ),
      // canUseTool is the authority; "default" is the mode that routes tool
      // calls through it instead of auto-allowing or hard-denying them.
      permissionMode: "default",
      // Feeds AgentInput.onToken, the live token tap the dashboard renders.
      includePartialMessages: true,
      ...(this.modelFor(agent) ? { model: this.modelFor(agent) } : {}),
      ...(this.options.executablePath ? { pathToClaudeCodeExecutable: this.options.executablePath } : {}),
      ...(resuming ? { resume: sdkSessionId } : { sessionId: sdkSessionId }),
      ...this.options.extraOptions,
    };

    const q = query({ prompt: inbox, options });
    let markReady = () => {};
    let markDead = (_err: Error) => {};
    const ready = new Promise<void>((resolve, reject) => {
      markReady = resolve;
      markDead = reject;
    });
    // Attached immediately: nothing else may be awaiting `ready` yet, and an
    // unobserved rejection would take the process down.
    ready.catch(() => undefined);
    const s: LiveSession = {
      sdkSessionId,
      q,
      inbox,
      closed: false,
      ready,
      markReady,
      markDead,
      settledReady: false,
      configuredModel: this.modelFor(agent),
    };
    this.live.set(sdkSessionId, s);
    void this.pump(s, agent.id);
    return s;
  }

  /**
   * Bounded wait for the init handshake. Returns true if the backend is
   * confirmed alive, false if it is confirmed dead.
   *
   * The timeout deliberately resolves to `true`: whether the CLI emits
   * `system`/`init` before or only after the first user message is not
   * something this adapter pins down, so a quiet backend is treated as
   * "unknown, assume alive" — exactly today's behaviour. A backend that
   * genuinely failed to spawn does not go quiet, it makes the pump throw,
   * which is why the dead case is still caught here rather than surfacing
   * several seconds later as a mystery turn failure.
   */
  private async confirmAlive(s: LiveSession): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const grace = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), this.startupProbeMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([s.ready.then(() => true, () => false), grace]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Single reader loop per session. The SDK hands back one async generator for
   * the whole streaming conversation, so turns are demultiplexed here: tool
   * calls and token deltas accumulate into the in-flight turn, and a `result`
   * frame closes it.
   */
  private async pump(s: LiveSession, agentId: string): Promise<void> {
    try {
      for await (const msg of s.q as AsyncIterable<SDKMessage>) {
        if (msg.type === "system" && msg.subtype === "init") {
          // The CLI is up. This is the adapter's liveness signal, and it also
          // reports whether the mesh MCP server attached — a seat whose bus
          // failed to load can still talk, but cannot act, so it is recorded
          // here rather than discovered as silence.
          s.mcpStatus = msg.mcp_servers;
          if (typeof msg.model === "string") s.lastModel = msg.model;
          if (!s.settledReady) {
            s.settledReady = true;
            s.markReady();
          }
        } else if (msg.type === "assistant") {
          const m = msg.message as { model?: string; content?: unknown };
          if (typeof m.model === "string") s.lastModel = m.model;
          const blocks = Array.isArray(m.content) ? m.content : [];
          for (const b of blocks as Array<Record<string, unknown>>) {
            if (b.type === "tool_use") {
              s.pending?.toolCalls.push({
                name: String(b.name ?? "tool"),
                args: (b.input as unknown) ?? {},
                resultDigest: shortDigest(JSON.stringify(b.input ?? "")),
              });
            }
          }
        } else if (msg.type === "stream_event") {
          // Live token tap, observability only — never fails the turn.
          const ev = (msg as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
          if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
            try {
              s.pending?.onToken?.(ev.delta.text);
            } catch {
              // A broken consumer must not take the turn down with it.
            }
          }
        } else if (msg.type === "result") {
          s.pending?.settle({ ok: true, msg: msg as unknown as ResultMessage });
        }
      }
      // Generator completed: the CLI exited. Any turn still waiting will never
      // be answered, so fail it rather than let the scheduler slot hang.
      s.closed = true;
      this.failReady(s, new BackendUnreachableError(`claude:${s.sdkSessionId}`, "claude session ended"));
      s.pending?.settle({ ok: false, err: new BackendUnreachableError(`claude:${s.sdkSessionId}`, "claude session ended") });
      this.statuses.set(agentId, "UNREACHABLE");
    } catch (err) {
      s.closed = true;
      const cause = err instanceof Error ? err.message : String(err);
      this.failReady(s, new BackendUnreachableError(`claude:${s.sdkSessionId}`, cause));
      s.pending?.settle({ ok: false, err: new BackendUnreachableError(`claude:${s.sdkSessionId}`, cause) });
      this.statuses.set(agentId, "UNREACHABLE");
    }
  }

  /** Settle `ready` as failed, once. A session that died before init never opened. */
  private failReady(s: LiveSession, err: Error): void {
    if (s.settledReady) return;
    s.settledReady = true;
    s.markDead(err);
  }

  private meshMcpServer(agent: AgentDefinition, context: RuntimeContext) {
    const meshCliBin = path.resolve(__dirname, "..", "..", "..", "..", "apps", "mesh-cli", "bin", "mesh.mjs");
    const argv = this.options.mcpCommand ?? [
      process.execPath,
      meshCliBin,
      "mcp",
      "--agent",
      agent.id,
      "--bus",
      context.busUrl,
      "--token",
      context.agentToken,
    ];
    return {
      type: "stdio" as const,
      command: argv[0],
      args: argv.slice(1),
      env: {
        MESH_BUS_URL: context.busUrl,
        MESH_AGENT_ID: agent.id,
        MESH_AGENT_TOKEN: context.agentToken,
      },
      timeout: 15000,
      // The mesh tools ARE the bus. Deferring them behind tool search would
      // let an agent take its first turn unable to see how to report back.
      alwaysLoad: true,
    };
  }

}
