import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import {
  BackendUnreachableError,
  TurnTimeoutError,
  type AgentDefinition,
  type AgentEvent,
  type AgentInput,
  type AgentOutput,
  type AgentRuntime,
  type AgentRuntimeStatus,
  type AgentSession,
  type DesignerPromptOptions,
  type DesignerRuntime,
  type DesignerStreamDelta,
  type DesignerStreamResult,
  type ModelCatalogue,
  type RotationPendingInfo,
  type RuntimeContext,
} from "../../protocol/src/index";
import { buildPermissionGate, collectAgentOutput, extractSummary, withReadingDiscipline, type ToolGate } from "../../agent-runtime/src/index";
import { withOutputVoice } from "../../core/src/context";
import {
  ProviderError,
  ProviderTimeoutError,
  createProvider,
  defaultContextWindow,
  resolveProviderModel,
  type ChatMessage,
  type LlmProvider,
  type ProviderConfig,
  type ToolCall,
  type ToolSpec,
} from "../../llm/src/index";
import { BusClient, BusError, type BusClientOptions } from "./bus";
import { TurnLoop, type LoopEnd, type OverflowAction, type ToolOutcome, type TurnControl } from "./engine";
import {
  COMPACT_HEADROOM_RATIO,
  DEFAULT_ELIDE_ABOVE_CHARS,
  DEFAULT_KEEP_RECENT_MESSAGES,
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_TOOL_RESULT_CHARS,
  compactConversation,
  estimateConversationTokens,
  resolveContextPolicy,
  type CompactionResult,
  type ContextPolicyOptions,
  type ResolvedContextPolicy,
} from "./context-policy";
import { TranscriptStore } from "./transcript";
import { NATIVE_TOOLS, ToolFailure, shellEnv, toolsOffered, type NetworkPolicy, type ShellEnvMode, type ToolContext } from "./tools/index";

/**
 * The provider-neutral runtime: seats whose model is called by Curule itself, through a port, rather than by a vendor's
 * agent.
 *
 * A seat's session is a conversation held here: the system prompt, the messages, and the bookkeeping that tells the mesh how
 * much the conversation weighs. A turn extends it by running the loop in `engine.ts` over a provider chosen by the seat's
 * `model:` (`provider/model`), with the seat's tools, gated by the same rules every runtime enforces, and the mesh bus.
 *
 * What the supervisor relies on, and where it lives here:
 *
 * - `stream` yields live frames and ends in one `turn_end`; `send` is a fold over it, so the two cannot drift.
 * - `interrupt` ends a turn as a failure that still reports what it spent; `endTurn` ends it as a success.
 * - `rotationPending` and `suppressRotation` let the mesh ask a seat for a continuity record before its conversation is
 *   discarded; a conversation that no longer fits the window is rotated on the spot rather than failing the turn.
 * - A provider's refusal is worded as the supervisor's classifier reads it, so a rate limit or an exhausted account pauses
 *   the mesh once instead of failing every seat in turn.
 */

export interface ModelSettings {
  /** The window, in tokens, the conversation rotates against (at 60%). */
  contextWindow?: number;
  maxOutputTokens?: number;
  effort?: "low" | "medium" | "high";
  temperature?: number;
}

export interface NativeProviderConfig extends ProviderConfig {
  /** The environment variable the key was read from. Removed from every shell a seat runs. */
  keyEnv?: string;
  /** Window for any model of this provider that names none of its own. */
  contextWindow?: number;
  /**
   * How long a conversation may sit idle before this provider's prompt cache has certainly expired. Past it, a large
   * conversation costs more to carry than to rebuild from the mesh's projections, and is rotated. Unset: never, which is right
   * for a provider whose cache the runtime cannot reason about, and for a local model that has none.
   */
  cacheTtlMs?: number;
}

export interface NativeRuntimeOptions {
  /** The providers this deployment names, by the name seats use in `model:`. */
  providers: Record<string, NativeProviderConfig>;
  /** The provider a model with no `provider/` prefix goes to. Optional when exactly one provider is configured. */
  defaultProvider?: string;
  /** `provider/model` for a seat that names none. */
  defaultModel?: string;
  /** The designer's model, and the one acceptance criteria are generated on. */
  designerModel?: string;
  /** Settings per bare model id. */
  models?: Record<string, ModelSettings>;
  /** Where conversations are kept so a restart resumes them. Omitted: in memory only. */
  stateDir?: string;
  /** `inherit` (the process environment, minus credentials) or `minimal` (an allowlist). */
  shellEnv?: ShellEnvMode;
  /** Variables removed from every seat's shell, besides the provider keys named by `keyEnv`. */
  denyEnv?: string[];
  /** Directories a seat may read besides its own workspace and the product checkout. */
  extraReadRoots?: string[];
  network?: NetworkPolicy;
  /** `mesh.runtime.context_window`: the window of a model nothing else places. */
  contextWindow?: number;
  /**
   * The conversation economy: what a seat's context may weigh, what is dropped when
   * it gets there, and the ceiling a single turn may spend.
   *
   * A seat's `session.max_context_tokens` wins over `fitTokens`; nothing else does.
   */
  context?: ContextPolicyOptions;
  /** Pin the rotation threshold, in tokens. Wins over every window and every budget. */
  rotateAtContextTokens?: number;
  /** Idle time after which a conversation whose provider has a cache TTL is rotated, and how large it must be. */
  staleFloorTokens?: number;
  /** Model calls one turn may make. */
  maxSteps?: number;
  /** For tests. */
  createProvider?: (config: ProviderConfig) => LlmProvider;
  bus?: Partial<Pick<BusClientOptions, "fetch" | "startupDelaysMs" | "connectDelaysMs" | "sleep" | "requestTimeoutMs">>;
  env?: Record<string, string | undefined>;
  onNotice?: (info: {
    agentId: string;
    kind: "unknown_context_window" | "context_overflow" | "context_compacted" | "context_cleared" | "turn_token_ceiling";
    message: string;
  }) => void;
  onRotate?: (info: {
    agentId: string;
    meshSessionId: string;
    previousSdkSessionId: string;
    sdkSessionId: string;
    contextTokens: number;
    turns: number;
    rotations: number;
    reason: string;
  }) => void;
}

const DEFAULT_STALE_FLOOR_TOKENS = 40_000;

/** What `advise`, `endTurn` and `interrupt` reach: the turn in flight. */
class TurnState implements TurnControl {
  readonly abort = new AbortController();
  readonly advice: string[] = [];
  readonly held = new Set<string>();
  ended = false;
  interrupted = false;
  private cancelCall: (() => void) | undefined;

  get signal(): AbortSignal {
    return this.abort.signal;
  }
  endRequested(): boolean {
    return this.ended;
  }
  takeAdvice(): string[] {
    return this.advice.splice(0);
  }
  setCallAbort(abort: (() => void) | undefined): void {
    this.cancelCall = abort;
  }
  end(): void {
    this.ended = true;
    this.cancelCall?.();
  }
  interrupt(): void {
    this.interrupted = true;
    this.abort.abort();
  }
}

interface ResolvedModel {
  providerName: string;
  provider: LlmProvider;
  config: NativeProviderConfig;
  /** The id sent to the provider. */
  model: string;
}

interface LiveSession {
  /** The id the supervisor holds. Stable across rotations. */
  meshSessionId: string;
  /** The id of the conversation on disk. Changes at a rotation; the registry records it. */
  transcriptId: string;
  agent: AgentDefinition;
  context: RuntimeContext;
  resolved: ResolvedModel;
  system: string;
  messages: ChatMessage[];
  bus: BusClient;
  gate: ToolGate;
  grantedTools: Set<string>;
  tools: ToolContext;
  /**
   * The bus's tool manifest, resolved once per session.
   *
   * A tool definition is part of the prompt prefix, and changing one invalidates
   * the whole cache (tools, system and messages). The manifest is fetched per
   * turn from the bus; if it ever came back re-ordered or re-worded, every seat
   * would silently re-prefill its whole conversation. Freeze it for the life of
   * the session: the gate still decides every call, and the set a seat is SHOWN
   * only changes at a restart.
   */
  busToolSpecs?: ToolSpec[];
  capabilities: string[];
  requiresApproval: string[];
  contextTokens: number;
  turns: number;
  rotations: number;
  /** In-place compactions of this conversation (see `context-policy.ts`). */
  compactions: number;
  lastTurnEndedAt?: number;
  staleRotationDue: boolean;
  pending?: TurnState;
  closed: boolean;
}

const isMeshTool = (name: string): boolean => name.startsWith("mesh_");

export class NativeRuntime implements AgentRuntime, DesignerRuntime {
  readonly name = "native";
  private readonly live = new Map<string, LiveSession>();
  private readonly statuses = new Map<string, AgentRuntimeStatus>();
  private readonly providers = new Map<string, LlmProvider>();
  private readonly store: TranscriptStore;
  private readonly designerTurns = new Set<TurnState>();
  private readonly noticed = new Set<string>();

  constructor(private readonly options: NativeRuntimeOptions) {
    this.store = new TranscriptStore(options.stateDir);
  }

  // ---- models --------------------------------------------------------------------------------------------------------

  private providerFor(name: string): { provider: LlmProvider; config: NativeProviderConfig } {
    const config = this.options.providers[name];
    if (!config) throw new Error(`no provider named '${name}'; the configured providers are ${Object.keys(this.options.providers).join(", ") || "none"}`);
    let provider = this.providers.get(name);
    if (!provider) {
      provider = (this.options.createProvider ?? createProvider)({ ...config, name: config.name ?? name });
      this.providers.set(name, provider);
    }
    return { provider, config };
  }

  /** `provider/model`, resolved against the configured providers and the defaults. Throws, in words an operator can act on. */
  private resolve(spec: string | undefined, what: string): ResolvedModel {
    const { provider: providerName, model } = resolveProviderModel(spec, what, Object.keys(this.options.providers), {
      provider: this.options.defaultProvider,
      model: this.options.defaultModel,
    });
    const { provider, config } = this.providerFor(providerName);
    return { providerName, provider, config, model };
  }

  private windowFor(agent: AgentDefinition | undefined, m: ResolvedModel): { tokens: number; known: boolean } {
    const own = agent?.contextWindow ?? this.options.models?.[m.model]?.contextWindow ?? m.config.contextWindow ?? this.options.contextWindow;
    return own !== undefined ? { tokens: own, known: true } : { tokens: defaultContextWindow(m.config.kind), known: false };
  }

  private thresholdFor(live: LiveSession): number {
    if (this.options.rotateAtContextTokens !== undefined) return this.options.rotateAtContextTokens;
    return this.policyFor(live).fitTokens;
  }

  /**
   * The economy this seat runs under.
   *
   * The window is the model's real one, and it is only a fallback: a 1M-token window
   * is a capability, not a target. A seat's `max_context_tokens` is a budget and is
   * honoured whatever the window is, which is what lets one seat keep a long
   * conversation while the mesh default keeps every other seat cheap.
   */
  private policyFor(live: LiveSession): ResolvedContextPolicy {
    return resolveContextPolicy(this.options.context, this.windowFor(live.agent, live.resolved), live.agent.sessionPolicy?.maxContextTokens);
  }

  /**
   * Drop what the conversation no longer needs, in place. Returns the result when it
   * brought the prompt back under budget; otherwise the caller rotates.
   *
   * Called at the rotation point and nowhere else, on purpose: editing a message
   * re-writes every token after it, so a compaction is one cold read. Doing it every
   * turn would trade a 9k brief for a 30k cache miss each turn -- the opposite of the
   * saving. Doing it here keeps the working set for several more turns at the price
   * of the cold read the rotation would have paid anyway.
   */
  private compact(live: LiveSession, policy: ResolvedContextPolicy, incomingBrief: boolean, system = live.system): CompactionResult | null {
    if (live.messages.length === 0) return null;
    const result = compactConversation(live.messages, policy, { dropAllBriefs: incomingBrief });
    // The provider's figure counts the system prompt and the tool schemas; the
    // estimate here must too, or a "compacted" conversation rotates on its next turn.
    // And it must leave headroom: a compaction that lands one brief under budget is
    // due again next turn, turning the saving into a cache miss per turn.
    const after = estimateConversationTokens(live.messages, system);
    if (result.freedChars <= 0 || after >= policy.fitTokens * COMPACT_HEADROOM_RATIO) return null;
    const before = result.estimateBefore;
    live.contextTokens = after;
    live.compactions++;
    this.store.rewrite(live.agent.id, live.transcriptId, live.messages, {
      contextTokens: live.contextTokens,
      turns: live.turns,
      rotations: live.rotations,
      compactions: live.compactions,
      lastTurnEndedAt: Date.now(),
    });
    this.options.onNotice?.({
      agentId: live.agent.id,
      kind: "context_compacted",
      message:
        `conversation compacted instead of rotated: ~${before} -> ~${after} tokens ` +
        `(${result.droppedBriefs} superseded brief(s), ${result.elidedResults} old tool result(s), ${result.elidedArgs} old tool-call argument(s) elided; ` +
        `the last ${policy.keepRecentMessages} messages kept whole)`,
    });
    return result;
  }

  private noticeOnce(key: string, info: Parameters<NonNullable<NativeRuntimeOptions["onNotice"]>>[0]): void {
    if (this.noticed.has(key)) return;
    this.noticed.add(key);
    this.options.onNotice?.(info);
  }

  // ---- sessions ------------------------------------------------------------------------------------------------------

  private systemPrompt(context: RuntimeContext): string {
    return withReadingDiscipline(withOutputVoice(context.rolePromptText));
  }

  private writeAgentFiles(agent: AgentDefinition, context: RuntimeContext): void {
    // The same two files the Claude adapter writes, so a person debugging a run finds what a seat was told in the same place.
    const dir = path.join(context.workspacePath, ".mesh", "agents", agent.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "ROLE.md"), this.systemPrompt(context), "utf8");
    fs.writeFileSync(path.join(dir, "MESH_CONTEXT.md"), `Goal: ${context.goalId}\nMesh: ${context.meshId}\nWorkspace: ${context.workspacePath}\n`, "utf8");
  }

  private open(agent: AgentDefinition, context: RuntimeContext, sessionId: string, transcriptId: string, messages: ChatMessage[]): LiveSession {
    const resolved = this.resolve(agent.model, `seat ${agent.id}`);
    const capabilities = context.capabilityGrants.length ? context.capabilityGrants : agent.capabilities;
    const requiresApproval = context.approvalRequired ?? agent.requiresApproval ?? [];
    const grantedTools = new Set(context.approvalGranted ?? []);
    const live: LiveSession = {
      meshSessionId: sessionId,
      transcriptId,
      agent,
      context,
      resolved,
      system: this.systemPrompt(context),
      messages,
      bus: new BusClient({ busUrl: context.busUrl, agentId: agent.id, token: context.agentToken, ...this.options.bus }),
      grantedTools,
      capabilities,
      requiresApproval,
      gate: buildPermissionGate(
        capabilities,
        { requires: requiresApproval, granted: grantedTools, onRequest: (tool) => this.live.get(sessionId)?.pending?.held.add(tool) },
        { cwd: context.workspacePath, productPath: context.productPath },
      ),
      tools: this.toolContext(context),
      contextTokens: 0,
      turns: 0,
      rotations: 0,
      compactions: 0,
      staleRotationDue: false,
      closed: false,
    };
    this.live.set(sessionId, live);
    return live;
  }

  private toolContext(context: RuntimeContext): ToolContext {
    const denied = [...(this.options.denyEnv ?? []), ...Object.values(this.options.providers).flatMap((p) => (p.keyEnv ? [p.keyEnv] : []))];
    const readRoots = [context.workspacePath, ...(context.productPath ? [context.productPath] : []), ...(this.options.extraReadRoots ?? [])];
    return {
      cwd: context.workspacePath,
      readRoots,
      writeRoots: [context.workspacePath],
      shellEnv: shellEnv(this.options.env ?? process.env, this.options.shellEnv ?? "inherit", denied, context.env),
      // Replaced per turn with that turn's own signal.
      signal: new AbortController().signal,
      ...(this.options.network ? { network: this.options.network } : {}),
    };
  }

  private session(live: LiveSession): AgentSession {
    return {
      sessionId: live.meshSessionId,
      agentId: live.agent.id,
      runtime: this.name,
      createdAt: new Date().toISOString(),
      handle: { transcriptId: live.transcriptId, provider: live.resolved.providerName, model: live.resolved.model },
    };
  }

  async start(agent: AgentDefinition, context: RuntimeContext): Promise<AgentSession> {
    const id = randomUUID();
    this.writeAgentFiles(agent, context);
    const live = this.open(agent, context, id, id, []);
    this.store.create({ v: 1, agentId: agent.id, transcriptId: id, model: `${live.resolved.providerName}/${live.resolved.model}`, createdAt: new Date().toISOString() });
    this.statuses.set(agent.id, "IDLE");
    return this.session(live);
  }

  async restoreSession(agent: AgentDefinition, sessionId: string, context: RuntimeContext): Promise<AgentSession | null> {
    const existing = this.live.get(sessionId);
    if (existing && !existing.closed) {
      this.statuses.set(agent.id, "IDLE");
      return this.session(existing);
    }
    const loaded = this.store.load(agent.id, sessionId);
    // Nothing on disk to resume: null tells the supervisor to start a fresh session, which is the right outcome.
    if (!loaded) return null;
    try {
      this.writeAgentFiles(agent, context);
      const live = this.open(agent, context, sessionId, sessionId, loaded.messages);
      live.contextTokens = loaded.meta?.contextTokens ?? 0;
      live.turns = loaded.meta?.turns ?? 0;
      live.rotations = loaded.meta?.rotations ?? 0;
      live.compactions = loaded.meta?.compactions ?? 0;
      if (loaded.meta?.lastTurnEndedAt !== undefined) live.lastTurnEndedAt = loaded.meta.lastTurnEndedAt;
      this.statuses.set(agent.id, "IDLE");
      return this.session(live);
    } catch {
      return null;
    }
  }

  async suspend(session: AgentSession): Promise<void> {
    // The conversation is durable, so nothing needs to stay in memory for a seat that is parked.
    this.drop(session.sessionId);
    this.statuses.set(session.agentId, "SUSPENDED");
  }

  async resume(session: AgentSession, agent: AgentDefinition, context: RuntimeContext): Promise<AgentSession | null> {
    const live = this.live.get(session.sessionId);
    if (live && !live.closed) {
      this.statuses.set(session.agentId, "IDLE");
      return session;
    }
    return this.restoreSession(agent, session.sessionId, context);
  }

  async stop(session: AgentSession): Promise<void> {
    this.drop(session.sessionId);
    this.statuses.set(session.agentId, "STOPPED");
  }

  async getStatus(session: AgentSession): Promise<AgentRuntimeStatus> {
    const live = this.live.get(session.sessionId);
    const tracked = this.statuses.get(session.agentId) ?? "IDLE";
    if (!live || live.closed) return tracked === "SUSPENDED" || tracked === "STOPPED" ? tracked : "UNREACHABLE";
    return tracked;
  }

  private drop(sessionId: string): void {
    const live = this.live.get(sessionId);
    if (!live) return;
    live.closed = true;
    live.pending?.interrupt();
    this.live.delete(sessionId);
  }

  // ---- steering a turn ------------------------------------------------------------------------------------------------

  async interrupt(session: AgentSession): Promise<void> {
    this.live.get(session.sessionId)?.pending?.interrupt();
  }

  async endTurn(session: AgentSession): Promise<void> {
    const turn = this.live.get(session.sessionId)?.pending;
    if (turn && !turn.interrupted) turn.end();
  }

  advise(session: AgentSession, text: string): boolean {
    const turn = this.live.get(session.sessionId)?.pending;
    if (!turn || turn.interrupted || turn.ended) return false;
    turn.advice.push(text);
    return true;
  }

  // ---- context size and rotation ---------------------------------------------------------------------------------------

  private staleDue(live: LiveSession): boolean {
    if (live.staleRotationDue) return true;
    const ttl = live.resolved.config.cacheTtlMs;
    if (ttl === undefined || live.lastTurnEndedAt === undefined) return false;
    if (Date.now() - live.lastTurnEndedAt < ttl) return false;
    if (live.contextTokens < (this.options.staleFloorTokens ?? DEFAULT_STALE_FLOOR_TOKENS)) return false;
    live.staleRotationDue = true;
    return true;
  }

  rotationPending(session: AgentSession): RotationPendingInfo | null {
    const live = this.live.get(session.sessionId);
    if (!live || live.closed) return null;
    const thresholdTokens = this.thresholdFor(live);
    const cacheCold = this.staleDue(live);
    if (live.contextTokens < thresholdTokens && !cacheCold) return null;
    return { transcriptTokens: live.contextTokens, thresholdTokens, sessionId: live.transcriptId, cacheCold };
  }

  /** Retire the conversation and start an empty one in its place, under the same id the supervisor holds. */
  private rotate(live: LiveSession, reason: string): void {
    const previous = live.transcriptId;
    const discarded = live.contextTokens;
    live.transcriptId = randomUUID();
    live.messages.length = 0;
    live.contextTokens = 0;
    live.rotations++;
    live.staleRotationDue = false;
    this.store.create({
      v: 1,
      agentId: live.agent.id,
      transcriptId: live.transcriptId,
      model: `${live.resolved.providerName}/${live.resolved.model}`,
      createdAt: new Date().toISOString(),
    });
    this.store.prune(live.agent.id);
    this.options.onRotate?.({
      agentId: live.agent.id,
      meshSessionId: live.meshSessionId,
      previousSdkSessionId: previous,
      sdkSessionId: live.transcriptId,
      contextTokens: discarded,
      turns: live.turns,
      rotations: live.rotations,
      reason,
    });
  }

  /**
   * A prompt the model refuses for its size. The first answer is to shrink what is old: tool results from earlier in the turn,
   * which are the bulk of any conversation and the least likely to be needed again. If that is not enough the conversation is
   * rotated on the spot and the turn goes on from its briefing: the mesh rebuilds a seat's whole working context from its
   * projections every turn, so a fresh conversation loses only what the seat had not written down.
   */
  private overflowAction(live: LiveSession, instructions: ChatMessage, attempt: number): OverflowAction {
    if (attempt === 0) {
      const freed = elideOldToolResults(live.messages);
      if (freed > 0) {
        this.options.onNotice?.({ agentId: live.agent.id, kind: "context_overflow", message: `the prompt did not fit ${live.resolved.model}: elided ${freed} characters of older tool results and tried again` });
        return "retry";
      }
    }
    if (attempt <= 1) {
      this.options.onNotice?.({ agentId: live.agent.id, kind: "context_overflow", message: `the prompt still did not fit ${live.resolved.model}: rotated the conversation and went on from this turn's briefing` });
      this.rotate(live, "context_overflow");
      live.messages.push(instructions);
      this.store.append(live.agent.id, live.transcriptId, [instructions]);
      return "retry";
    }
    return "give-up";
  }

  // ---- a turn --------------------------------------------------------------------------------------------------------

  async send(session: AgentSession, input: AgentInput): Promise<AgentOutput> {
    return collectAgentOutput(this.stream(session, input), input);
  }

  async *stream(session: AgentSession, input: AgentInput): AsyncGenerator<AgentEvent, void> {
    const live = this.live.get(session.sessionId);
    if (!live || live.closed) {
      this.statuses.set(session.agentId, "UNREACHABLE");
      throw new BackendUnreachableError(`native:${session.sessionId}`, "no live session; call start or restoreSession first");
    }
    if (live.pending) throw new Error(`a turn is already in flight for ${live.agent.id}`);
    const turn = new TurnState();
    live.pending = turn;
    this.statuses.set(live.agent.id, "RUNNING");
    let loop: TurnLoop | undefined;
    try {
      if (input.approvalGranted) {
        live.grantedTools.clear();
        for (const t of input.approvalGranted) live.grantedTools.add(t);
      }
      const policy = this.policyFor(live);
      // The stable half of the brief rides in the system prompt: built once, cached,
      // and untouched by the messages that change every turn. Absent for a caller
      // that still sends the whole briefing in `instructions`.
      const system = input.standingBrief ? `${live.system}\n\n${input.standingBrief}` : live.system;
      const cacheCold = this.staleDue(live);
      const overBudget = live.contextTokens >= policy.fitTokens;
      if (!input.suppressRotation && (overBudget || cacheCold)) {
        // Compaction first: it keeps the working set and costs no model call. A cold
        // cache is the one case where a fresh conversation is strictly cheaper than a
        // lighter one, because the next call pays for the prefix either way.
        const compacted = cacheCold ? null : this.compact(live, policy, input.instructions.trim().length > 0, system);
        if (!compacted) this.rotate(live, overBudget ? "rotation" : "stale");
      }
      const window = this.windowFor(live.agent, live.resolved);
      if (!window.known) {
        this.noticeOnce(`${live.agent.id}:${live.resolved.model}`, {
          agentId: live.agent.id,
          kind: "unknown_context_window",
          message: `the context window of ${live.resolved.providerName}/${live.resolved.model} is not configured; assuming ${window.tokens} tokens. Set context_window on the seat, the model or the provider if it is different.`,
        });
      }
      // Frozen per session: a changed tool definition invalidates the whole
      // prompt cache (tools, system and messages). See `LiveSession.busToolSpecs`.
      const busTools = live.busToolSpecs ?? (live.busToolSpecs = await this.busTools(live, turn.signal));
      const specs: ToolSpec[] = [...toolsOffered(live.capabilities, live.requiresApproval).map((t) => t.spec), ...busTools];
      const instructions: ChatMessage = { role: "user", content: input.instructions };
      live.messages.push(instructions);
      this.store.append(live.agent.id, live.transcriptId, [instructions]);

      const settings = this.options.models?.[live.resolved.model];
      loop = new TurnLoop({
        provider: live.resolved.provider,
        model: live.resolved.model,
        system,
        messages: live.messages,
        persist: (added) => this.store.append(live.agent.id, live.transcriptId, added),
        tools: specs,
        run: (call, signal) => this.runTool(live, turn, call, signal),
        control: turn,
        maxSteps: this.options.maxSteps ?? DEFAULT_MAX_STEPS,
        maxTurnTokens: policy.maxTurnTokens,
        warnAtRatio: policy.warnAtRatio,
        maxToolResultChars: policy.maxToolResultChars,
        clearToolResultsAt: policy.clearToolResultsAt,
        keepToolUses: policy.keepToolUses,
        clearAtLeastTokens: policy.clearAtLeastTokens,
        rewrite: (messages) =>
          this.store.rewrite(live.agent.id, live.transcriptId, messages, {
            contextTokens: live.contextTokens,
            turns: live.turns,
            rotations: live.rotations,
            compactions: live.compactions,
            lastTurnEndedAt: Date.now(),
          }),
        maxOutputTokens: settings?.maxOutputTokens,
        temperature: settings?.temperature,
        effort: settings?.effort,
        cache: live.resolved.config.kind === "anthropic",
        requireMeshCall: true,
        onOverflow: (attempt) => this.overflowAction(live, instructions, attempt),
      });

      let end: LoopEnd;
      try {
        end = yield* loop.run();
      } catch (err) {
        if (err instanceof ProviderTimeoutError) {
          throw new TurnTimeoutError(err.timeoutMs, loop.tally.calls > 0 ? loop.tokens() : undefined, loop.reportedModel, "the provider stopped responding");
        }
        if (err instanceof ProviderError) {
          // A provider's refusal ends the turn as a failure that still says what it spent. Its message is the line the
          // supervisor's classifier reads, so a shared outage is one fault and not one per seat.
          yield { kind: "turn_end", stopReason: "error", text: loop.lastText, operations: [], typedOps: true, tokensUsed: loop.tokens(), model: live.resolved.model, error: err.message };
          return;
        }
        throw err;
      }
      const reported = end.reportedModel;
      const failed = end.stopReason === "step_limit";
      if (end.stopReason === "token_ceiling") {
        this.options.onNotice?.({
          agentId: live.agent.id,
          kind: "turn_token_ceiling",
          message: `turn ended at its token ceiling: ${loop.tokens().total} billable tokens (ceiling ${policy.maxTurnTokens}); the conversation and its notes are kept for the next turn`,
        });
      }
      if (loop.cleared.tokens > 0) {
        this.options.onNotice?.({
          agentId: live.agent.id,
          kind: "context_cleared",
          message: `cleared ${loop.cleared.results} old tool result(s) and ${loop.cleared.args} old tool-call argument(s) mid-turn (~${loop.cleared.tokens} tokens), keeping the last ${policy.keepToolUses} rounds`,
        });
      }
      yield {
        kind: "turn_end",
        stopReason: failed ? "error" : "end_turn",
        text: end.text,
        operations: [],
        typedOps: true,
        tokensUsed: loop.tokens(),
        model: live.resolved.model,
        ...(reported !== undefined && reported !== live.resolved.model ? { modelVersion: reported } : {}),
        ...(settings?.temperature !== undefined ? { temperature: settings.temperature } : {}),
        ...(end.text ? { summary: extractSummary(end.text) } : {}),
        ...(turn.held.size > 0 ? { heldTools: [...turn.held] } : {}),
        ...(failed ? { error: `the turn made ${this.options.maxSteps ?? DEFAULT_MAX_STEPS} model calls without finishing` } : {}),
      };
    } finally {
      if (loop && loop.lastPromptTokens > 0) live.contextTokens = loop.lastPromptTokens;
      live.turns++;
      live.lastTurnEndedAt = Date.now();
      live.staleRotationDue = false;
      live.pending = undefined;
      if (!live.closed) this.statuses.set(live.agent.id, "IDLE");
      this.store.meta(live.agent.id, live.transcriptId, { contextTokens: live.contextTokens, turns: live.turns, rotations: live.rotations, compactions: live.compactions, lastTurnEndedAt: live.lastTurnEndedAt });
    }
  }

  /** The bus's tools for this seat. A bus that stays down is a seat that cannot act, which is a dead backend, not a refusal. */
  private async busTools(live: LiveSession, signal: AbortSignal): Promise<ToolSpec[]> {
    try {
      return await live.bus.listTools(signal);
    } catch (err) {
      if (err instanceof BusError) throw new BackendUnreachableError(`mesh bus ${live.context.busUrl}`, err.message);
      throw err;
    }
  }

  private async runTool(live: LiveSession, turn: TurnState, call: ToolCall, signal: AbortSignal): Promise<ToolOutcome> {
    if (isMeshTool(call.name)) {
      const r = await live.bus.call(call.name, call.args, signal);
      return { text: r.text, isError: r.isError, mesh: true };
    }
    const decision = await live.gate(call.name, call.args);
    if (decision.behavior === "deny") return { text: decision.message, isError: true, mesh: false };
    const tool = NATIVE_TOOLS.get(call.name);
    if (!tool) return { text: `${call.name} is not available to curule agents.`, isError: true, mesh: false };
    try {
      const r = await tool.run(call.args, { ...live.tools, signal });
      return { text: r.text, isError: r.isError === true, mesh: false };
    } catch (err) {
      if (err instanceof ToolFailure) return { text: err.message, isError: true, mesh: false };
      if (turn.interrupted) return { text: "This call was stopped: the turn was interrupted.", isError: true, mesh: false };
      return { text: `${call.name} failed: ${(err as Error).message}`, isError: true, mesh: false };
    }
  }

  // ---- DesignerRuntime ---------------------------------------------------------------------------------------------------
  //
  // The designer is a person's chat partner while they build a mesh: no seat, no workspace, no shell. It is a short loop over
  // the model with only the tools the bus offers it (the staging tools and read-only observability), so it works on any
  // provider and, like every seat, never executes what it proposes.

  async prompt(text: string, opts: DesignerPromptOptions = {}): Promise<string> {
    return (await this.promptStream(text, opts)).reply;
  }

  async promptStream(text: string, opts: DesignerPromptOptions = {}, onDelta?: (delta: DesignerStreamDelta) => void): Promise<DesignerStreamResult> {
    const resolved = this.resolve(opts.model ?? this.options.designerModel, "the designer");
    const turn = new TurnState();
    this.designerTurns.add(turn);
    // The caller can end this turn the way `interrupt` ends a seat's: the point
    // of the signal is that the model call in flight stops, and it is the same
    // mechanism, so a stopped designer turn cannot behave differently from a
    // stopped agent turn.
    const stop = (): void => turn.interrupt();
    opts.signal?.addEventListener("abort", stop, { once: true });
    if (opts.signal?.aborted) stop();
    let reply = "";
    let thinking = "";
    try {
      const bus = opts.mcp
        ? new BusClient({
            busUrl: new URL(opts.mcp.url).origin,
            agentId: "designer",
            token: opts.mcp.headers?.["x-mesh-token"] ?? "",
            endpoint: opts.mcp.url,
            headers: opts.mcp.headers,
            ...this.options.bus,
          })
        : undefined;
      const tools = bus ? await bus.listTools(turn.signal) : [];
      const messages: ChatMessage[] = [{ role: "user", content: text }];
      const settings = this.options.models?.[resolved.model];
      const loop = new TurnLoop({
        provider: resolved.provider,
        model: resolved.model,
        system: opts.system ?? "",
        messages,
        persist: () => undefined,
        tools,
        run: async (call, signal): Promise<ToolOutcome> => {
          if (!bus) return { text: `${call.name} is not available.`, isError: true, mesh: false };
          const r = await bus.call(call.name, call.args, signal);
          return { text: r.text, isError: r.isError, mesh: true };
        },
        control: turn,
        maxSteps: 40,
        maxTurnTokens: 2_000_000,
        warnAtRatio: 0.75,
        maxToolResultChars: DEFAULT_MAX_TOOL_RESULT_CHARS,
        maxOutputTokens: settings?.maxOutputTokens,
        // The designer asks for up to "max"; a provider that takes an effort at all takes three levels.
        effort: opts.effort === "xhigh" || opts.effort === "max" ? "high" : (opts.effort ?? settings?.effort),
        temperature: settings?.temperature,
        cache: resolved.config.kind === "anthropic",
        requireMeshCall: false,
      });
      let reply = "";
      let thinking = "";
      const gen = loop.run();
      let end: LoopEnd | undefined;
      try {
        for (;;) {
          const next = await gen.next();
          if (next.done) {
            end = next.value;
            break;
          }
          const ev = next.value;
          if (ev.kind === "agent_message_chunk") {
            reply += ev.delta;
            emit(onDelta, { kind: "text", delta: ev.delta });
          } else if (ev.kind === "agent_thought_chunk") {
            thinking += ev.delta;
            emit(onDelta, { kind: "thinking", delta: ev.delta });
          }
        }
      } catch (err) {
        // An interrupted turn surfaces as an AbortError from the loop. When the
        // caller asked for it, that is the ending it wanted: answer with what
        // was written rather than throwing at a caller that pressed Stop.
        if (!turn.interrupted) throw err;
        return { reply, thinking, stopped: true };
      }
      // The last thing the model said is the answer; what it said between tool calls was a preview of it.
      return { reply: end?.text || reply, thinking };
    } finally {
      opts.signal?.removeEventListener("abort", stop);
      this.designerTurns.delete(turn);
    }
  }

  async listModels(): Promise<ModelCatalogue> {
    const models: string[] = [];
    const errors: string[] = [];
    for (const name of Object.keys(this.options.providers)) {
      try {
        const { provider } = this.providerFor(name);
        if (!provider.listModels) continue;
        for (const id of await provider.listModels()) models.push(`${name}/${id}`);
      } catch (err) {
        errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return {
      models,
      ...(this.options.designerModel ?? this.options.defaultModel ? { default: this.options.designerModel ?? this.options.defaultModel } : {}),
      ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
    };
  }

  setDesignerObserve(_provider: () => { busUrl: string; token: string } | undefined): void {}

  async stopAll(): Promise<void> {
    for (const t of this.designerTurns) t.interrupt();
    for (const id of [...this.live.keys()]) this.drop(id);
  }
}

function emit(onDelta: ((d: DesignerStreamDelta) => void) | undefined, d: DesignerStreamDelta): void {
  try {
    onDelta?.(d);
  } catch {
    // A delta consumer must never take the turn down with it.
  }
}

/**
 * Replace the content of tool results older than the last few messages with a note saying how much was dropped. The
 * structure of the conversation is kept (every call still has its answer), so the provider still accepts it.
 * Returns how many characters were freed.
 */
export function elideOldToolResults(messages: ChatMessage[], keepRecent = DEFAULT_KEEP_RECENT_MESSAGES): number {
  let freed = 0;
  for (let i = 0; i < messages.length - keepRecent; i++) {
    const m = messages[i]!;
    if (m.role === "tool" && m.content.length > DEFAULT_ELIDE_ABOVE_CHARS) {
      freed += m.content.length;
      m.content = `[elided to fit the context window: ${m.content.length} characters]`;
    }
  }
  return freed;
}

