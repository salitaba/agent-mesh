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
  type AgentEvent,
  type AgentEventTurnEnd,
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
// Runtime commons: the queue every adapter needs to hand frames back, and
// the fold that turns those frames into the struct the supervisor reads.
import { PushQueue, collectAgentOutput } from "../../agent-runtime/src/index";
// The mesh op protocol is one contract, so it gets one parser. It lives in
// packages/agent-runtime as runtime commons; these are pure text functions
// with no backend coupling. Ops here normally arrive typed via mesh_* MCP
// tools, so this is the fallback path, not the primary one.
import { parseMeshOps, extractSummary, extractDeclaredSummary, shortDigest } from "../../agent-runtime/src/index";
// The output-voice rules belong to the prompt layer, not to any one adapter:
// importing them from there is what keeps every runtime byte-identical on
// the part of the prompt that must not vary by backend.
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
   * How long a turn may produce NOTHING before the session is written off.
   *
   * Distinct from `turnTimeoutMs`, which bounds a turn that is working. This
   * bounds a turn that never started: a push answered by total silence. The
   * separation matters because the two have different safe values — a real
   * turn can legitimately think for minutes, but no healthy backend is silent
   * for more than about a second after a push.
   */
  firstFrameTimeoutMs?: number;
  /**
   * How long `start`/`restoreSession` wait for a spawn to fail before giving
   * the backend the benefit of the doubt. Despite what this was called, it
   * never observed the `system`/`init` handshake — that cannot arrive before
   * the first user message, so the wait always ran to completion. See
   * `confirmAlive`.
   */
  spawnFailureGraceMs?: number;
  /** Extra SDK options merged last, for escape hatches and tests. */
  extraOptions?: Partial<Options>;
  /** Override for `SESSION_CONTEXT_ROTATE_TOKENS`. */
  rotateAtContextTokens?: number;
  /**
   * Seam for the SDK's `query`. Defaults to the real one.
   *
   * Session rotation tears down a live query and stands a replacement up
   * mid-mission; with `query` bound at module scope there is no way to exercise
   * that without spawning real CLIs, so the riskiest path in this adapter would
   * ship untested. Narrower than `extraOptions` on purpose — it replaces the
   * transport, not the configuration.
   */
  queryFn?: typeof query;
  /** Observer for session rotations, so the supervisor can audit them. */
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

/**
 * Transcript size at which the agent's SDK session is retired and a fresh one
 * opened.
 *
 * This is the bound that was missing. `query()` is opened once per agent with a
 * streaming input queue, so every turn is appended to one conversation that
 * nothing ever trimmed: turn N's real input was all N-1 prior turns plus the
 * new instructions. Bounding the assembled prompt (which the supervisor does)
 * only bounds what each turn ADDS — the floor still rose forever.
 *
 * Rotating is cheap here specifically because the mesh is state-projected: the
 * supervisor rebuilds the agent's whole working context from projections every
 * turn — mission, task, plan, decisions, artifacts, unread mail, L2 memory — so
 * a fresh session is handed everything it needs on its first turn. What is lost
 * is the agent's un-declared reasoning and any local tool output it had not
 * recorded in the mesh; that is exactly the material the mesh asks agents to
 * externalise as artifacts and `done` summaries.
 *
 * 120k against a 200k window leaves room for the turn itself plus tool results
 * rather than rotating at the edge of a failure.
 */
const SESSION_CONTEXT_ROTATE_TOKENS = 120_000;

/**
 * How much conversation the model loaded for a turn.
 *
 * `input + cache_read`, because a cached prefix is still context the model read
 * — it is only cheaper, not absent. Reading `input` alone would report a
 * 150k-token transcript as a few hundred tokens once the prefix caches, which
 * is exactly the blind spot that let the transcript grow unnoticed.
 */
export function transcriptSize(t: AgentOutput["tokensUsed"] | undefined): number {
  return (t?.input ?? 0) + (t?.cacheRead ?? 0);
}

export interface ClaudeTurnUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * git subcommands a seat needs to stage and land a commit. Deliberately short:
 * anything outside it is reachable by granting `shell.execute`, which is the
 * capability that exists to say so. `push` and `merge` are absent because
 * `git.merge` is its own capability.
 */
const COMMIT_SUBCOMMANDS = new Set(["add", "commit", "status", "diff", "log", "show", "rev-parse", "ls-files"]);

/**
 * True when `command` is one git invocation carrying no shell control flow.
 *
 * Quoting is the whole difficulty. This repo writes conventional subjects
 * ("fix(designer): ..."), so a scan that rejected parentheses outright would
 * reject the exact command this capability exists to permit. So: track quote
 * state, reject only what can start a second command, and keep rejecting `$(`
 * and backticks inside double quotes, where they still substitute.
 */
function isBareGitCommand(command: string): boolean {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (c === "\\") { i++; continue; }
      if (c === '"') { quote = null; continue; }
      if (c === "`") return false;
      if (c === "$" && command[i + 1] === "(") return false;
      continue;
    }
    if (c === "\\") { i++; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "`" || c === ";" || c === "&" || c === "|" || c === "<" || c === ">" || c === "\n") return false;
    if (c === "$" && command[i + 1] === "(") return false;
  }
  return quote === null;
}

/** Why a commit-only seat may not run this Bash call, or null if it may. */
function commitScopeDenial(toolInput: Record<string, unknown>): string | null {
  const raw = toolInput.command;
  const command = typeof raw === "string" ? raw.trim() : "";
  if (!command) return "a commit-only seat may run git commands, and this call carries no command string";
  if (!isBareGitCommand(command)) {
    return "a commit-only seat may run a single git command, with no chaining, redirection, or substitution";
  }
  const named = /^git\s+(?:-[^\s]+\s+)*([a-z][a-z-]*)/.exec(command);
  if (!named) return "a commit-only seat may run git commands only";
  if (!COMMIT_SUBCOMMANDS.has(named[1])) {
    return `'git ${named[1]}' is outside the commit path — grant shell.execute if this seat needs it`;
  }
  return null;
}

/** Operator-approval half of {@link buildPermissionGate}. */
export interface ApprovalGate {
  /** Capability tokens whose tools need a grant. Normalized by the caller. */
  requires: readonly string[];
  /** Tool names the operator has unlocked for this session. */
  granted: ReadonlySet<string>;
  /**
   * Record a tool refused for want of a grant. Called at most once per call.
   *
   * Optional: the denial already tells the model, and the operator surface
   * lists gated seats from config. A caller that wants a live "blocked on"
   * queue supplies this; nothing in the mesh requires one yet.
   */
  onRequest?(toolName: string): void;
}

/**
 * Capability-to-tool gate. The removed opencode adapter expressed this as a
 * static permission block in a generated config; the SDK offers a callback
 * instead, which is a closer fit — the decision is computed from the same
 * capability set, but an unknown or newly added tool fails closed here instead
 * of falling through whatever the config file happened not to mention.
 *
 * `approval` layers an operator gate over that: a capability the seat holds,
 * whose tools stay denied until the operator unlocks them.
 *
 * The denial IS the mechanism — this gate never blocks waiting for a human,
 * even though it could (the callback is async). `interruptSilentTurns` kills
 * any turn that goes quiet for `turnSilenceMs`, resolved to 60-120s, which is
 * well inside human response latency: a blocking hold would be destroyed by
 * the supervisor's own stall detector before most operators answered. So the
 * gate refuses, records the request, and lets the turn end WAITING; the
 * operator grants over HTTP and the agent is re-activated.
 *
 * That shape also settles what a grant can honestly mean. A refused call
 * cannot be replayed — the model re-decides on its next turn — so the operator
 * unlocks the TOOL for the rest of the session, never one invocation of it.
 */
export function buildPermissionGate(capabilities: string[], approval?: ApprovalGate): CanUseTool {
  // Normalized here as well as at config load: capabilityGrants also arrive
  // from direct AgentDefinition construction (tests, bench harnesses).
  const caps = new Set(capabilities.map(normalizeCapability));
  const canEdit = caps.has("repository.write") || caps.has("architecture.write") || caps.has("test.write");
  const canExec = caps.has("shell.execute") || caps.has("test.execute");
  const canFetch = caps.has("network.request");
  // `git.commit` once bought blanket exec: opencode rendered it as bash:"ask",
  // nothing on a mesh turn could answer that prompt, and a pending one would
  // stall the slot to its timeout — so the seat got exec instead. That backend
  // is gone and the widening outlived its reason: a seat granted git.commit and
  // deliberately *not* granted shell.execute was still getting arbitrary bash.
  // It now buys the commit path only.
  const canCommit = caps.has("git.commit");

  const deny = (message: string) => ({ behavior: "deny" as const, message });

  const requires = new Set((approval?.requires ?? []).map(normalizeCapability));
  const granted = approval?.granted ?? new Set<string>();

  /**
   * The seat's OWN tokens that authorize this tool. Filtered against `caps` on
   * purpose: `requires_approval` narrows a grant and must never widen one, so
   * a token the seat does not hold can neither gate nor unlock anything.
   */
  const authorizing = (toolName: string): string[] => {
    const candidates = EDIT_TOOLS.has(toolName)
      ? ["repository.write", "architecture.write", "test.write"]
      : EXEC_TOOLS.has(toolName)
        ? ["shell.execute", "test.execute", "git.commit"]
        : NETWORK_TOOLS.has(toolName)
          ? ["network.request"]
          : [];
    return candidates.filter((t) => caps.has(t));
  };

  /** A denial when this tool is gated and not yet unlocked, else undefined. */
  const held = (toolName: string) => {
    if (requires.size === 0 || granted.has(toolName)) return undefined;
    const gated = authorizing(toolName).filter((t) => requires.has(t));
    if (gated.length === 0) return undefined;
    approval?.onRequest?.(toolName);
    return deny(
      `${toolName} needs operator approval: this seat holds ${gated.join(", ")}, which requires_approval gates. ` +
        "The request is recorded on the operator's gate surface — end your turn rather than retrying, " +
        "since a grant cannot unlock a call already in flight.",
    );
  };

  return async (toolName, toolInput) => {
    if (toolName.startsWith(MESH_MCP_PREFIX)) return { behavior: "allow", updatedInput: toolInput };
    if (READ_TOOLS.has(toolName)) return { behavior: "allow", updatedInput: toolInput };
    if (EDIT_TOOLS.has(toolName)) {
      if (!canEdit) {
        return deny(`${toolName} denied: this seat holds no write capability (has: ${[...caps].join(", ") || "none"}).`);
      }
      return held(toolName) ?? { behavior: "allow", updatedInput: toolInput };
    }
    if (EXEC_TOOLS.has(toolName)) {
      if (!canExec && !canCommit) {
        return deny(`${toolName} denied: this seat holds no shell.execute or test.execute capability.`);
      }
      // Checked before the commit-scope narrowing below: an operator gate is
      // about whether this seat may reach the tool at all, which is a question
      // that comes before what it may pass to it.
      const hold = held(toolName);
      if (hold) return hold;
      if (canExec) return { behavior: "allow", updatedInput: toolInput };
      // BashOutput and KillShell address a shell this seat already opened; only
      // Bash opens a new one, so only Bash needs its command scoped.
      if (toolName !== "Bash") return { behavior: "allow", updatedInput: toolInput };
      const why = commitScopeDenial(toolInput);
      return why ? deny(`Bash denied: ${why}.`) : { behavior: "allow", updatedInput: toolInput };
    }
    if (NETWORK_TOOLS.has(toolName)) {
      if (!canFetch) {
        return deny(`${toolName} denied: this seat holds no network.request capability.`);
      }
      return held(toolName) ?? { behavior: "allow", updatedInput: toolInput };
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
  /** Live frames for `stream`. Closed by `settle`, however the turn ends. */
  events: PushQueue<AgentEvent>;
  /** Fallback correlation id when a tool_use block carries no id of its own. */
  toolSeq: number;
  /** Set by `settle` on failure; rethrown by `stream` once the queue drains. */
  failure?: unknown;
  settle: (outcome: { ok: true; msg: ResultMessage } | { ok: false; err: unknown }) => void;
  settled: boolean;
  /**
   * Whether ANY frame arrived from the CLI this turn. A healthy backend emits
   * `system`/`init` within milliseconds of every push, so this flag staying
   * false is not slowness — it means the query is not attached to a process
   * that will ever answer.
   */
  sawFrame: boolean;
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
  /**
   * Stable id the MESH knows this session by. Equal to `sdkSessionId` until the
   * first rotation, after which the SDK id moves and this one does not — the
   * supervisor holds `AgentSession.sessionId` and must keep resolving.
   */
  meshSessionId: string;
  /** Kept so a rotation can rebuild the query; `send` is not given either. */
  agent: AgentDefinition;
  context: RuntimeContext;
  /**
   * Size of the transcript the model actually read on the last turn
   * (`input + cache_read`). This is a measurement, not an estimate: it is what
   * the backend reported it had loaded, and it is the only honest signal for
   * "how big has this conversation become".
   */
  contextTokens: number;
  /** Turns served by the CURRENT sdk session, and rotations so far. */
  turns: number;
  rotations: number;
  /**
   * Tools unlocked for this seat, held BY REFERENCE by the permission gate.
   * Mutated in place each turn from `AgentInput.approvalGranted`; assigning a
   * new set here would leave the running gate reading the old one.
   */
  grantedTools: Set<string>;
  /**
   * Tools the gate refused since the last turn end. Filled by the gate's
   * `onRequest` hook and drained onto the turn-end frame, so the operator sees
   * what the seat asked for instead of having to guess the tool name.
   */
  heldTools: Set<string>;
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
  private firstFrameTimeoutMs: number;
  private spawnFailureGraceMs: number;

  constructor(private options: ClaudeAdapterOptions = {}) {
    this.turnTimeoutMs = options.turnTimeoutMs ?? 600000;
    this.firstFrameTimeoutMs = options.firstFrameTimeoutMs ?? 45000;
    this.spawnFailureGraceMs = options.spawnFailureGraceMs ?? 500;
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

  /**
   * One turn, folded back into the struct the supervisor reads.
   *
   * Implemented over `stream` rather than beside it so the two can never
   * drift: every field of the returned output has exactly one producer.
   */
  async send(session: AgentSession, input: AgentInput): Promise<AgentOutput> {
    return collectAgentOutput(this.stream(session, input), input);
  }

  /**
   * Live frames for one turn.
   *
   * An async generator, so the setup below (session lookup, context rotation)
   * runs on first pull rather than at call time and `send` stays a one-liner.
   * The pump feeds `turn.events`; `settle` closes it however the turn ends, so
   * this loop always terminates.
   */
  async *stream(session: AgentSession, input: AgentInput): AsyncGenerator<AgentEvent, void> {
    let s = this.live.get(session.sessionId);
    if (!s || s.closed) {
      // No live query behind a session the supervisor still believes in. That
      // is the Claude-shaped equivalent of opencode's dead-backend case.
      this.statuses.set(session.agentId, "UNREACHABLE");
      throw new BackendUnreachableError(`claude:${session.sessionId}`, "no live session; call start or restoreSession first");
    }
    if (s.pending) {
      throw new Error(`claude runtime: turn already in flight for agent ${session.agentId}`);
    }

    // Rotate BEFORE the push, never after: the decision is made on the
    // transcript the last turn actually read, and rotating afterwards would
    // still have let this turn load the oversized one.
    const rotateAt = this.options.rotateAtContextTokens ?? SESSION_CONTEXT_ROTATE_TOKENS;
    if (s.contextTokens >= rotateAt) {
      s = await this.rotate(s, `context ${s.contextTokens} tokens >= ${rotateAt}`);
    }
    const live = s;

    // After the rotation check, not before: `rotate` builds a fresh session
    // whose gate seeded its set from the session-start context, so refreshing
    // earlier would be discarded by the rotation. Mutated in place because the
    // gate closed over this exact set — see `LiveSession.grantedTools`.
    // Undefined means the caller did not say (opencode-shaped runtimes, tests):
    // leave the gate as it is rather than silently revoking everything.
    if (input.approvalGranted) {
      live.grantedTools.clear();
      for (const tool of input.approvalGranted) live.grantedTools.add(tool);
    }

    this.statuses.set(session.agentId, "RUNNING");
    const turn: TurnState = {
      events: new PushQueue<AgentEvent>(),
      toolSeq: 0,
      settled: false,
      sawFrame: false,
      settle: (outcome) => {
        if (turn.settled) return;
        turn.settled = true;
        clearTimeout(timer);
        clearTimeout(firstFrame);
        live.pending = undefined;
        if (outcome.ok) {
          const end = this.toTurnEnd(outcome.msg, live);
          live.turns++;
          // `input + cache_read` is what the backend says it loaded for this
          // turn — i.e. the transcript's current size. Recorded here rather
          // than estimated anywhere else, and read by the rotation check on
          // the NEXT turn.
          live.contextTokens = transcriptSize(end.tokensUsed);
          this.statuses.set(session.agentId, "IDLE");
          turn.events.push(end);
        } else {
          // Surfaced by `stream` after the queue drains, so frames already
          // emitted this turn are not swallowed by the failure.
          turn.failure = outcome.err;
          this.statuses.set(session.agentId, "UNREACHABLE");
        }
        turn.events.close();
      },
    };
    const timer = setTimeout(() => {
      // Abort the model, not the session: the query stays usable for the
      // next turn, matching opencode's per-turn abort semantics.
      void live.q.interrupt().catch(() => undefined);
      turn.settle({ ok: false, err: new Error(`claude runtime: turn exceeded ${this.turnTimeoutMs}ms`) });
    }, this.turnTimeoutMs);
    const firstFrame = setTimeout(() => {
      if (turn.settled || turn.sawFrame) return;
      // Not one frame came back — not a token, not a tool call, not even the
      // `system`/`init` a live CLI emits within milliseconds of a push. This
      // is the signature of a query bound to a process that will never answer:
      // a resume whose session never came up, or a spawn that went mute. The
      // session is discarded rather than ridden to `turnTimeoutMs`, so the
      // supervisor's retry lands on a fresh spawn — the shape that works.
      //
      // Tearing down matters as much as failing fast: a session left open here
      // keeps a CLI running against the same transcript, which is how orphaned
      // `--resume` processes accumulate and keep billing after the mesh has
      // stopped listening to them.
      turn.settle({
        ok: false,
        err: new BackendUnreachableError(
          `claude:${live.sdkSessionId}`,
          `claude backend produced no frames within ${this.firstFrameTimeoutMs}ms of the turn being sent`,
        ),
      });
      this.teardown(live.meshSessionId);
    }, this.firstFrameTimeoutMs);
    firstFrame.unref?.();
    live.pending = turn;
    live.inbox.push({
      type: "user",
      message: { role: "user", content: input.instructions },
      parent_tool_use_id: null,
    } as SDKUserMessage);

    for await (const ev of turn.events) yield ev;
    if (turn.failure) throw turn.failure;
  }

  private toTurnEnd(result: ResultMessage, s: LiveSession): AgentEventTurnEnd {
    // Drained, not copied: the set is session-lived, so the next turn has to
    // start empty or a tool held once would be re-reported on every turn after
    // -- including turns where the seat never reached for it.
    const held = [...s.heldTools];
    s.heldTools.clear();
    const text = result.result ?? "";
    const operations: MeshOp[] = parseMeshOps(text);
    const declared = extractDeclaredSummary(operations);
    const error = result.is_error ? (text || `claude turn failed: ${result.subtype}`) : undefined;
    // Same contract as the opencode adapter: `summary` stays the prose scrape
    // it has always been, and `declaredSummary` carries the agent's own `done`
    // summary when it gave one. Ops here are parsed out of prose, never typed:
    // agents that call the mesh_* MCP tools execute through McpToolset directly
    // and never reach this mapping, so typed-only transport is preserved.
    return {
      kind: "turn_end",
      stopReason: result.is_error ? "error" : "end_turn",
      text,
      operations,
      tokensUsed: usageToTokens(result.usage),
      model: s.lastModel ?? s.configuredModel,
      modelVersion: s.lastModel,
      summary: extractSummary(text),
      ...(declared ? { declaredSummary: declared } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(held.length ? { heldTools: held } : {}),
    };
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

  /**
   * Rebuild what `suspend` tore down. The transcript is durable in Claude's
   * session store, so resuming is `restoreSession` under another name — and
   * delegating keeps one implementation of "reopen a known session id" instead
   * of two that drift.
   */
  async resume(session: AgentSession, agent: AgentDefinition, context: RuntimeContext): Promise<AgentSession | null> {
    const live = this.live.get(session.sessionId);
    if (live && !live.closed) {
      this.statuses.set(session.agentId, "IDLE");
      return session;
    }
    return this.restoreSession(agent, session.sessionId, context);
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
    const q = (this.options.queryFn ?? query)({
      prompt: text,
      options: {
        cwd: this.designerWorkspaceDir(),
        ...(opts.system ? { systemPrompt: { type: "custom" as const, prompt: opts.system } } : {}),
        canUseTool: buildPermissionGate([]),
        permissionMode: "default",
        includePartialMessages: true,
        ...(() => {
          const staging = opts.mcp ? this.designerStagingMcpServer(opts.mcp) : undefined;
          return staging ? { mcpServers: { mesh_staging: staging } } : {};
        })(),
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
   * Accepted and ignored: the removed opencode adapter needed this because it
   * wrote a config file naming the bus before it could spawn, whereas designer
   * turns here run with no MCP at all and so have nothing to point at a bus. Kept
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

  /**
   * Retire an oversized transcript and open a fresh SDK session in its place,
   * keeping the mesh-facing session id stable so the supervisor's handle still
   * resolves.
   *
   * Not `teardown` + `open`: teardown settles `pending` with an error and drops
   * the map entry. Rotation happens between turns, with nothing pending, and
   * the entry must survive because it is being replaced under the same key.
   *
   * A mesh restart after a rotation will try to resume the ORIGINAL id, which
   * is no longer a live Claude session — `restoreSession` gets a failed
   * `confirmAlive`, returns null, and the supervisor starts fresh. That is the
   * correct outcome here rather than a bug to route around: a fresh session is
   * what rotation produces anyway, and projections refill it.
   */
  private async rotate(s: LiveSession, reason: string): Promise<LiveSession> {
    const previousId = s.sdkSessionId;
    const rotations = s.rotations + 1;
    s.closed = true;
    s.inbox.close();
    try {
      s.q.close();
    } catch {
      // Already gone; the point is to stop feeding it, not to prove it died.
    }
    this.live.delete(s.meshSessionId);
    const fresh = this.open(s.agent, s.context, randomUUID(), false, s.meshSessionId);
    fresh.rotations = rotations;
    // Not `await fresh.ready`: `ready` resolves on `system`/`init`, which the
    // CLI does not emit until a message is pushed — and this turn's push does
    // not happen until rotation returns, so waiting outright deadlocks every
    // healthy rotation until the supervisor's backstop fires.
    //
    // `confirmAlive` asks the bounded version of the same question, exactly as
    // startup does: it can only report false for a replacement that has
    // already died, which is the case worth failing loudly on rather than
    // carrying into a turn. A replacement that is merely quiet is handed the
    // turn, and the first-frame watchdog judges it there — the first moment a
    // mute backend is observable at all.
    if (!(await this.confirmAlive(fresh))) {
      this.statuses.set(s.agent.id, "UNREACHABLE");
      this.live.delete(s.meshSessionId);
      throw new BackendUnreachableError(
        `claude:${s.meshSessionId}`,
        `session rotation failed (${reason}): the replacement backend did not start`,
      );
    }
    this.options.onRotate?.({
      agentId: s.agent.id,
      meshSessionId: s.meshSessionId,
      previousSdkSessionId: previousId,
      sdkSessionId: fresh.sdkSessionId,
      contextTokens: s.contextTokens,
      turns: s.turns,
      rotations,
      reason,
    });
    return fresh;
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
    // Composed through `withOutputVoice` for the same reason the system prompt
    // below is: ROLE.md is meant to be the file a human reads to see what this
    // seat was told, and the raw role prose is not that — it is missing the
    // shared OUTPUT_VOICE_RULES that go out with every turn.
    fs.writeFileSync(path.join(dir, "ROLE.md"), withOutputVoice(context.rolePromptText), "utf8");
    fs.writeFileSync(
      path.join(dir, "MESH_CONTEXT.md"),
      `Goal: ${context.goalId}\nMesh: ${context.meshId}\nWorkspace: ${context.workspacePath}\n`,
      "utf8",
    );
    return dir;
  }

  private open(
    agent: AgentDefinition,
    context: RuntimeContext,
    sdkSessionId: string,
    resuming: boolean,
    // Defaults to the SDK id, so `start`/`restoreSession` behave exactly as
    // before. Only a rotation passes the two apart.
    meshSessionId: string = sdkSessionId,
  ): LiveSession {
    const existing = this.live.get(meshSessionId);
    if (existing && !existing.closed) return existing;

    const inbox = new PushQueue<SDKUserMessage>();
    // Owned by the session rather than built inline in the gate call below:
    // `open` returns an existing session untouched (above), so a set created
    // at gate-construction time would freeze the grants as they stood when the
    // session was created, and no later unlock could reach a running seat.
    // `stream` refreshes this one in place, per turn.
    const grantedTools = new Set(context.approvalGranted ?? []);
    // Session-owned for the same reason as `grantedTools`: the gate is built
    // once per session and must write somewhere that outlives the call.
    const heldTools = new Set<string>();
    const options: Options = {
      cwd: context.workspacePath,
      // `custom` rather than the claude_code preset: a mesh seat is not a
      // general coding assistant, and inheriting the preset's workflow
      // instructions would compete with the role prompt for authority.
      //
      // The role prose is composed with the shared OUTPUT_VOICE_RULES rather
      // than passed through raw: this runtime builds the model's system prompt
      // itself, so without that the seat would answer under a different set of
      // output rules than the same seat on opencode.
      systemPrompt: { type: "custom", prompt: withOutputVoice(context.rolePromptText) },
      mcpServers: { mesh: this.meshMcpServer(agent, context) },
      canUseTool: buildPermissionGate(
        context.capabilityGrants.length ? context.capabilityGrants : agent.capabilities,
        {
          // The context wins: the supervisor resolves inheritance and holds the
          // live grant set, while `agent` is the static definition and would
          // re-gate a tool the operator already unlocked this session.
          requires: context.approvalRequired ?? agent.requiresApproval ?? [],
          granted: grantedTools,
          onRequest: (toolName) => heldTools.add(toolName),
        },
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

    const q = (this.options.queryFn ?? query)({ prompt: inbox, options });
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
      meshSessionId,
      agent,
      context,
      contextTokens: 0,
      turns: 0,
      rotations: 0,
      grantedTools,
      heldTools,
    };
    this.live.set(meshSessionId, s);
    void this.pump(s, agent.id);
    return s;
  }

  /**
   * Bounded wait for a spawn failure. Returns true unless the backend is
   * confirmed dead.
   *
   * This does not observe the init handshake, despite what it used to be
   * called. The CLI emits nothing on the message stream until the first user
   * message is pushed: a streaming query with an unfed inbox answers control
   * requests (`supportedModels` returns the model list) while producing no
   * `system`/`init` for as long as you care to wait. `start()` runs before
   * any message exists, so a wait for that handshake could only ever end in
   * the timeout — which is why a strict version of this check crash-looped
   * every agent in the mesh.
   *
   * What the window does buy is the failure path: a spawn that cannot start
   * rejects `ready` through `markDead` in milliseconds, so a short grace
   * catches every dead spawn the old ten-second one did. Those ten seconds
   * were paid in full by every healthy session, on its first turn, for a
   * signal that could not arrive.
   *
   * A backend that spawns and then goes mute is still not caught here, and
   * cannot be — the first turn is the only place that becomes observable.
   */
  private async confirmAlive(s: LiveSession): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const grace = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(true), this.spawnFailureGraceMs);
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
        // Liveness is "the backend spoke at all", not "the backend emitted
        // text": a turn spent entirely inside one long tool call streams no
        // tokens and must not read as a dead session.
        if (s.pending) s.pending.sawFrame = true;
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
              // Announced as it starts, not tallied at the end: an operator
              // watching a slow turn needs to see the call while it runs.
              const pending = s.pending;
              if (pending) {
                pending.events.push({
                  kind: "tool_call",
                  toolCallId: String(b.id ?? `tool-${pending.toolSeq++}`),
                  name: String(b.name ?? "tool"),
                  args: (b.input as unknown) ?? {},
                  resultDigest: shortDigest(JSON.stringify(b.input ?? "")),
                });
              }
            }
          }
        } else if (msg.type === "stream_event") {
          // Live token tap, observability only — never fails the turn.
          const ev = (msg as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
          if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
            // The onToken fan-out now lives in `collectAgentOutput`, which
            // guards it; pushing a frame here cannot throw into the pump.
            s.pending?.events.push({ kind: "agent_message_chunk", delta: ev.delta.text });
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

  /**
   * The designer's staging bridge for ONE turn.
   *
   * `query()` takes its options per call, so unlike opencode's shared backend
   * this runtime can spawn a bridge that knows exactly which turn it writes
   * into — the turn id rides `--turn` into an `x-mesh-designer-turn` header and
   * the bus never has to resolve it by guessing. The bus URL is the origin of
   * the endpoint the server named; the path and headers are the bridge's job.
   *
   * Read-and-propose only: every tool it exposes either reads the run or writes
   * to a turn buffer the operator must apply. It grants no native tools, which
   * is why it can sit behind the same `buildPermissionGate([])` as the rest of
   * the designer (MESH_MCP_PREFIX is already allowed there).
   */
  private designerStagingMcpServer(mcp: NonNullable<DesignerPromptOptions["mcp"]>) {
    const meshCliBin = path.resolve(__dirname, "..", "..", "..", "..", "apps", "mesh-cli", "bin", "mesh.mjs");
    const turn = mcp.headers?.["x-mesh-designer-turn"];
    const token = mcp.headers?.["x-mesh-token"] ?? "human-local";
    let bus: string;
    try {
      bus = new URL(mcp.url).origin;
    } catch {
      return undefined;
    }
    return {
      type: "stdio" as const,
      command: process.execPath,
      args: [
        meshCliBin,
        "mcp",
        "--agent",
        "human",
        "--token",
        token,
        "--staging",
        "--bus",
        bus,
        ...(turn ? ["--turn", turn] : []),
      ],
      timeout: 15000,
      alwaysLoad: true,
    };
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
