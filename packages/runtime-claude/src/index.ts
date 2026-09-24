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
  InterruptedTurnError,
  EDIT_CAPABILITIES,
  normalizeCapability,
  type AgentDefinition,
  type AgentEvent,
  type AgentEventTurnEnd,
  type AgentInput,
  type AgentOutput,
  type AgentRuntime,
  type AgentRuntimeStatus,
  type AgentSession,
  type RotationPendingInfo,
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
  /**
   * The mesh's `bus.transport`. Under `"typed-only"` the prose-op parser stops
   * rewriting invented op names and message types.
   *
   * It changes nothing about which ops run — a parsed op is already refused
   * wholesale under typed-only, before it reaches `executeOp`. What it buys is
   * an honest alias counter: without it, every refused prose turn still
   * incremented `aliasStats()`, so the one number that says whether the alias
   * table is still load-bearing was inflated by turns that landed nothing.
   */
  transport?: "mixed" | "typed-only";
  /** Extra SDK options merged last, for escape hatches and tests. */
  extraOptions?: Partial<Options>;
  /**
   * Pin the rotation threshold instead of deriving it from the model.
   *
   * Wins over `rotateAtFor` outright: operators tune this against a real mesh,
   * and the rotation tests have to reach a threshold in a handful of fake turns
   * rather than six hundred thousand tokens of them.
   */
  rotateAtContextTokens?: number;
  /**
   * Pin the idle gap after which a session's prompt cache counts as expired.
   *
   * Defaults to `SESSION_CACHE_STALE_MS`. Overridable for the same reason as
   * `rotateAtContextTokens`: the staleness tests cannot spend ten real minutes
   * waiting for a cache to go cold.
   */
  staleAfterMs?: number;
  /**
   * Pin the transcript size below which staleness is not worth a rotation.
   *
   * Defaults to `SESSION_STALE_ROTATE_FLOOR_TOKENS`.
   */
  staleFloorTokens?: number;
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
  /**
   * Observer for a seat whose mesh MCP bridge did not attach.
   *
   * The bridge is how an agent calls back into the mesh. Without it the seat
   * still starts, still gets scheduled and still bills tokens, but every
   * operation it tries to perform goes nowhere — it is mute rather than dead,
   * which is the harder failure to spot. Fired at most once per session, from
   * the backend's own `init` frame, so it lands on turn 1 instead of after a
   * stall timeout.
   */
  onMuteSuspected?: (info: {
    agentId: string;
    meshSessionId: string;
    sdkSessionId: string;
    servers: Array<{ name: string; status: string }>;
    meshBridgeAttached: boolean;
  }) => void;
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
  // Reported, never summed. `thinking` is a slice of `output_tokens` that the
  // backend already billed, so it rides alongside `total` and is deliberately
  // absent from the expression above — see AgentOutput.tokensUsed.thinking.
  // Left undefined when the backend sent no breakdown, so an old CLI reads as
  // "unknown" instead of a turn that happened not to think.
  const thinking = usage.output_tokens_details?.thinking_tokens;
  return {
    input,
    output,
    total: input + output + cacheWrite,
    cacheRead,
    ...(typeof thinking === "number" ? { thinking } : {}),
  };
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
 * Rotating at 60% of the window leaves room for the turn itself plus tool
 * results rather than rotating at the edge of a failure. That fraction is the
 * policy and always was — it was just written down as the single number 120k,
 * which is 60% of Haiku 4.5's 200k window. Hardcoded, it also charged that
 * window to every other model: a seat on a 1M-window model shed a usable cache
 * prefix five times earlier than it had to, for nothing.
 */
const SESSION_CONTEXT_ROTATE_RATIO = 0.6;

/**
 * Rotation threshold for a model whose window we cannot place.
 *
 * 60% of the smallest window in the table below, i.e. the value this bound had
 * before it was derived. Nothing that reaches here is guessed upward: see
 * `rotateAtFor`.
 */
const SESSION_CONTEXT_ROTATE_TOKENS = 120_000;

/**
 * How long a session may sit idle before its prompt cache has certainly
 * expired, in ms.
 *
 * The other half of the rotation decision, and the one that was missing: size
 * was bounded, TIME was not. See the staleness branch in `stream` for the
 * measurement this threshold comes from.
 */
const SESSION_CACHE_STALE_MS = 10 * 60_000;

/**
 * Transcript size below which staleness is not worth a rotation.
 *
 * Re-reading a small transcript is cheap, and the un-externalised reasoning
 * inside it is not free to reproduce — so a quiet seat with a short
 * conversation keeps it. Only a seat that is both idle AND large is paying more
 * to carry its history than to rebuild from projections.
 *
 * "Size" is a per-call prompt (`promptSize`), i.e. tokens actually occupying a
 * window — not a turn's summed reads. The two differed by ~32× on a measured
 * mission, and this floor was calibrated against the second: at 40k it used to
 * admit a 79-call turn over a transcript of a few thousand tokens.
 */
const SESSION_STALE_ROTATE_FLOOR_TOKENS = 40_000;

/**
 * Context window per model id, in tokens — the denominator of the ratio above.
 *
 * Bare, undated ids, which is the convention `toClaudeModelId` documents and
 * the only shape mesh.yaml writes. Taken from the published per-model table
 * rather than from memory: this number decides when a mission's transcript is
 * thrown away, so being wrong here either overflows a live context window or
 * burns a paid-for cache prefix every few turns.
 *
 * Deliberately not exhaustive, and safe to leave that way — anything missing
 * lands on the conservative floor above.
 */
const MODEL_CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map([
  ["claude-opus-5", 1_000_000],
  ["claude-opus-4-8", 1_000_000],
  ["claude-opus-4-7", 1_000_000],
  ["claude-opus-4-6", 1_000_000],
  ["claude-sonnet-5", 1_000_000],
  ["claude-sonnet-4-6", 1_000_000],
  ["claude-fable-5-1", 1_000_000],
  ["claude-fable-5", 1_000_000],
  ["claude-haiku-4-5", 200_000],
]);

/**
 * Rotation threshold for the model a session is actually running.
 *
 * AN ID WE CANNOT PLACE GETS THE CONSERVATIVE FLOOR, NEVER A GUESS UPWARD.
 * `toClaudeModelId` validates nothing — it strips a provider segment and hands
 * back whatever remains — so a typo, a model released after the table above was
 * written, and a real id are indistinguishable to this lookup. Assuming a large
 * window for an id we cannot place would let a 200k seat run hundreds of
 * thousands of tokens past the point where it overflows, killing a live
 * mission; assuming a small one costs a cache prefix and nothing else. Those
 * are not comparable failures, so the unknown case only ever rounds down.
 */
export function rotateAtFor(model: string | undefined): number {
  const id = toClaudeModelId(model);
  const window = id === undefined ? undefined : MODEL_CONTEXT_WINDOWS.get(id);
  // Not clamped up to the floor: a KNOWN model with a window under 200k must
  // rotate at its own share of it, not at a floor that sits past its ceiling.
  return window === undefined ? SESSION_CONTEXT_ROTATE_TOKENS : Math.floor(window * SESSION_CONTEXT_ROTATE_RATIO);
}

/**
 * Reasoning effort every agent seat runs at.
 *
 * THIS IS A DETERMINISM PIN, NOT A COST LEVER. `high` is already the CLI's
 * `default_effort` for the models a seat realistically runs (Opus 5, Sonnet 5),
 * so on a stock machine this changes no behaviour and saves nothing. What it
 * removes is a variable: the SDK only forwards `--effort` when we set it, and
 * an unset effort lets the CLI fall back to the OPERATOR's personal
 * `effortLevel` in `~/.claude/settings.json`. One operator's seats then think
 * harder (or cost ~1.6x more at `xhigh`) than another's for the same mesh, and
 * two runs are not comparable. Pinning makes the seat's effort a property of
 * the mesh rather than of whoever booted it.
 *
 * Unconditional on purpose, even though `claude-haiku-4-5` has no `effort`
 * capability and a seat may be pointed at it (`model:` is a free-form string —
 * see `rotateAtFor` on why an id we cannot place is never guessed at). The CLI
 * gates this itself: it resolves effort to `undefined` for a model whose
 * catalogue entry lacks the capability, and drops the key from `output_config`
 * while assembling the request body, so an unsupported seat sends no effort at
 * all rather than being rejected. Reproducing that capability table here would
 * be a second copy of a list we cannot validate and would silently rot as
 * models ship; deferring to the CLI's own copy cannot.
 *
 * Still overridable: this is spread BEFORE `extraOptions`, so an operator
 * escape hatch continues to win, as it does for `model`.
 */
const SEAT_EFFORT = "high" as const;

/**
 * How much conversation the model loaded across a turn's calls, summed.
 *
 * `input + cache_read`, because a cached prefix is still context the model read
 * — it is only cheaper, not absent. Reading `input` alone would report a
 * 150k-token transcript as a few hundred tokens once the prefix caches, which
 * is exactly the blind spot that let the transcript grow unnoticed.
 *
 * A **cost** signal, not a context size. The backend reports `usage` once per
 * model call, so a turn that loops N times reports N reads of a context that may
 * never have approached the window — measured on a live mission: 954 calls whose
 * largest prompt was 165,129 tokens, against turn figures of 5,219,210 and
 * 6,189,695 (`NOTES-communication-measured-review.md` §11c).
 *
 * So this is no longer what the rotation decision compares to a window. That is
 * {@link promptSize}, taken per call. This one survives as the **fallback** for a
 * backend that reports no per-call usage, and it is the safe direction to fall
 * back in: it over-states, so a session rotates early and pays a cache prefix,
 * where under-stating would let a transcript run past the window and kill a live
 * mission.
 */
export function transcriptSize(t: AgentOutput["tokensUsed"] | undefined): number {
  return (t?.input ?? 0) + (t?.cacheRead ?? 0);
}

/**
 * The context one model call actually read.
 *
 * The SDK states the arithmetic itself: "Total input tokens in a request is the
 * summation of `input_tokens`, `cache_creation_input_tokens`, and
 * `cache_read_input_tokens`". That sum is a **size** — the transcript the model
 * was handed for that one call — which is the quantity the rotation threshold
 * was always named for and never measured.
 *
 * `cache_creation_input_tokens` is the term the mesh had been dropping: it rides
 * into `usageToTokens`'s `total` and has no field of its own, so a prompt that
 * was written to cache rather than read from it went uncounted.
 *
 * The wire type makes both cache fields `number | null`, so `?? 0` covers
 * absent and null alike; a call that reports nothing at all returns 0, which
 * callers must treat as "no measurement" rather than "an empty context".
 */
export function promptSize(u: ClaudeTurnUsage | undefined): number {
  if (!u) return 0;
  const input = u.input_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  return input + cacheRead + cacheWrite;
}

export interface ClaudeTurnUsage {
  input_tokens?: number;
  output_tokens?: number;
  /**
   * The two cache terms, `number | null` because that is what the wire says:
   * `Usage` in `@anthropic-ai/sdk` declares both as `number | null`, and a call
   * that used no cache reports the null rather than omitting the key.
   *
   * Declared nullable here so the `?? 0` in {@link usageToTokens} and
   * {@link promptSize} is load-bearing rather than defensive. Typed as
   * `number | undefined`, a future `a + usage.cache_read_input_tokens` would
   * typecheck and then produce a NaN off a live backend.
   */
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  /**
   * Reasoning half of `output_tokens`, NOT a fifth token bucket.
   *
   * The SDK documents this as a read-only decomposition: `output_tokens` stays
   * the inclusive, authoritative billing total, `thinking_tokens` is always
   * <= it, and `output_tokens - thinking_tokens` approximates the visible
   * reply. Adding it to any sum that already counts `output_tokens` would
   * double-bill reasoning, which is why {@link usageToTokens} reports it
   * alongside `total` and never inside it.
   *
   * Optional and nullable at both levels because it is: older CLI builds omit
   * the object, and the wire type is `{ thinking_tokens: number } | null`.
   */
  output_tokens_details?: { thinking_tokens?: number | null } | null;
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
  const canEdit = EDIT_CAPABILITIES.some((t) => caps.has(t));
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
  /**
   * Set when the MESH aborted this turn (`AgentRuntime.interrupt`), i.e. the
   * stall watchdog or an operator stop — never when the CLI failed on its own.
   * It exists because the CLI answers an abort with an ordinary error result,
   * which the pump would otherwise report as this turn's own failure: the
   * supervisor classifies agents on that error, so a stop the mesh itself
   * ordered was charged to the agent's restart budget as a crash. See the
   * `result` branch in `pump`.
   */
  interrupted?: boolean;
  /**
   * The largest prompt any single model call in this turn was handed.
   *
   * A turn is a tool loop, so it makes N calls, each re-sending the transcript:
   * the largest of them is the context the session is carrying, and the one the
   * window has to hold. Zero means no frame reported usage — an absence, never
   * an empty context, which is why the settle path falls back rather than
   * reading this as "nothing to rotate".
   */
  maxPromptTokens: number;
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
  /**
   * WHY the turn failed, as the CLI reports it. `SDKResultError` declares this
   * field as required, and for most failures it is the only place the real
   * cause appears: `subtype` is a four-value enum that names a CATEGORY
   * ("the turn errored"), not a fault. Without this, every crash collapsed to
   * the bare string `claude turn failed: error_during_execution` — which, in a
   * live run, left the turn record, the `agent.failed` event and the dashboard
   * all equally mute while the operator paid for the failed turn and for the
   * restart it triggered.
   */
  errors?: string[];
  /**
   * Structured stop cause (`prompt_too_long`, `budget_exhausted`,
   * `malformed_tool_use_exhausted`, `turn_setup_failed`, …). Strictly more
   * specific than `subtype` and, unlike it, *discriminating*: it separates a
   * wedged backend from a rejected prompt from a spent budget, which is the
   * distinction the supervisor currently cannot make and so must treat as one
   * generic restart. Absent from older CLIs.
   */
  terminal_reason?: string;
  /**
   * Tools the CLI refused to run. The authoritative record of a permission
   * wall, and the failure that most needs naming: a seat that hits one goes
   * silent for as long as the CLI waits for an approval no headless turn can
   * give, so from the outside it is indistinguishable from a hung backend.
   */
  permission_denials?: Array<{ tool_name?: string; tool_use_id?: string }>;
}

/**
 * The most informative sentence available for a failed turn.
 *
 * Ordered by specificity, because the old fallback was a lie by omission: it
 * reported the SDK's `subtype` and nothing else, and a subtype is a category,
 * not a fault. "claude turn failed: error_during_execution" is equally true of
 * a crashed CLI, a prompt the provider refused as too long, a spent budget and
 * a denied tool — four different bugs with four different fixes, which the
 * supervisor could only treat as one generic restart.
 *
 * The subtype always leads, so the message stays greppable and every existing
 * classification that reads it keeps working; the specifics follow.
 */
function turnFailureReason(result: ResultMessage): string {
  const groups: string[] = [];
  const prose = (result.result ?? "").trim();
  if (prose) groups.push(prose);
  for (const e of result.errors ?? []) {
    const line = String(e).trim();
    if (line) groups.push(line);
  }
  const denied = result.permission_denials ?? [];
  if (denied.length > 0) {
    const tools = [...new Set(denied.map((d) => String(d.tool_name ?? "tool")))];
    groups.push(`denied by permissions: ${tools.join(", ")}`);
  }
  const terminal = result.terminal_reason;
  if (typeof terminal === "string" && terminal !== "" && terminal !== "completed") {
    groups.push(`terminated: ${terminal}`);
  }
  // The CLI frequently reports one fault twice — once as the turn's result text
  // and again in `errors` — and a message that repeats itself reads as two
  // faults. Keep the first spelling of each distinct one; the containment test
  // is what catches a short result text that the errors array quotes verbatim.
  const kept: string[] = [];
  for (const g of groups) {
    const lower = g.toLowerCase();
    if (kept.some((k) => k.toLowerCase().includes(lower) || lower.includes(k.toLowerCase()))) continue;
    kept.push(g);
  }
  const detail = kept.join(" — ");
  return detail ? `claude turn failed: ${result.subtype} — ${detail}` : `claude turn failed: ${result.subtype}`;
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
  /** Whether the mute warning already fired, so a reconnect does not re-alarm. */
  mutedReported?: boolean;
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
   * The context this session is carrying: the largest prompt a single model
   * call of the last turn was handed (`input + cache_read + cache_creation`,
   * see `promptSize`).
   *
   * A measurement, not an estimate. It is a **size** — a turn is a tool loop
   * that re-sends the transcript to every call, so the largest of those prompts
   * is the transcript as the window has to hold it — which is what the rotation
   * threshold is named for and, until this, never received: the figure here used
   * to be the same prompt summed over the turn's calls, so it grew with the
   * number of calls and compared a per-turn cost to a per-call limit. On one
   * measured mission that reported 5,219,210 against a largest real prompt of
   * 165,129 (`NOTES-communication-measured-review.md` §11c).
   *
   * Falls back to that sum only when no frame reported usage at all, so a
   * backend that reports nothing rotates early rather than never.
   */
  contextTokens: number;
  /** Turns served by the CURRENT sdk session, and rotations so far. */
  turns: number;
  rotations: number;
  /**
   * When this session last FINISHED a turn, in ms. The staleness half of the
   * rotation decision: a session quiet long enough has certainly lost its
   * prompt cache, and is then re-reading itself at full price.
   */
  lastTurnEndedAt?: number;
  /**
   * Latched once this session is judged stale, so the decision survives the
   * turn that answers it. See `markStaleRotationDue`.
   */
  staleRotationDue?: boolean;
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
    // Derived per model, so a large-window seat is not held to a small-window
    // seat's bound. `lastModel` first for the same reason `toTurnEnd` prefers
    // it: it is what the backend reported it actually ran, and the window
    // belongs to that model, not to the one we asked for.
    const rotateAt = this.options.rotateAtContextTokens ?? rotateAtFor(s.lastModel ?? s.configuredModel);
    // `suppressRotation` buys exactly one turn on the old transcript, for the
    // handover. It cannot wedge a seat permanently over the threshold: the
    // supervisor sets it only when it is asking for a continuity record, and
    // the very next turn comes in without it and rotates.
    const stale = this.markStaleRotationDue(s);
    if (!input.suppressRotation && (s.contextTokens >= rotateAt || stale)) {
      s = await this.rotate(
        s,
        stale && s.contextTokens < rotateAt
          ? `transcript idle past the prompt-cache lifetime: ${s.contextTokens} tokens would be re-read at full price`
          : `context ${s.contextTokens} tokens >= ${rotateAt}`,
      );
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
      maxPromptTokens: 0,
      settle: (outcome) => {
        if (turn.settled) return;
        turn.settled = true;
        clearTimeout(timer);
        clearTimeout(firstFrame);
        live.pending = undefined;
        if (outcome.ok) {
          const end = this.toTurnEnd(outcome.msg, live);
          live.turns++;
          // The largest prompt a single call was handed, which is the context
          // this session is carrying — what the rotation threshold is named for
          // and, before this, never measured. Falls back to the summed figure
          // only when NO frame reported usage: an absence, not an empty
          // context, and the fallback over-states, so an unmeasurable backend
          // rotates early rather than overflowing a window.
          live.contextTokens = turn.maxPromptTokens || transcriptSize(end.tokensUsed);
          // When this session last finished a turn, for the staleness branch of
          // the rotation check. Read on the NEXT turn, like `contextTokens`.
          live.lastTurnEndedAt = Date.now();
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
    const operations: MeshOp[] = parseMeshOps(text, { aliases: this.options.transport !== "typed-only" });
    const declared = extractDeclaredSummary(operations);
    const error = result.is_error ? turnFailureReason(result) : undefined;
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
    // Mark before asking, so a result frame already in flight cannot slip past
    // the pump's interrupted check.
    if (s.pending) s.pending.interrupted = true;
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
        // Only when the caller asked. This one-shot path is shared: the
        // designer chat sets an effort, acceptance-criteria generation does
        // not, and that caller runs on Haiku, which has no effort support.
        // Defaulting anything here would put a knob on the criteria call that
        // its model cannot take.
        ...(opts.effort ? { effort: opts.effort } : {}),
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
  /**
   * Decide from the init frame whether this seat can reach the mesh at all.
   *
   * `mesh` is the bridge registered in `meshMcpServer`; any other server the
   * CLI happens to have loaded is irrelevant to whether the agent can act.
   * A server the backend lists with a non-connected status counts as absent,
   * because a bridge that failed to authenticate is as mute as one that was
   * never configured.
   *
   * Reports once per session. A rotation stands up a fresh `LiveSession`, so a
   * replacement that comes up equally mute does re-report — which is correct:
   * that is a new seat failing, not the same one being re-announced.
   */
  private reportMuteIfBridgeMissing(s: LiveSession): void {
    if (s.mutedReported) return;
    const servers = s.mcpStatus ?? [];
    const bridge = servers.find((m) => m.name === "mesh");
    const attached = bridge !== undefined && bridge.status === "connected";
    if (attached) return;
    s.mutedReported = true;
    this.options.onMuteSuspected?.({
      agentId: s.agent.id,
      meshSessionId: s.meshSessionId,
      sdkSessionId: s.sdkSessionId,
      servers,
      meshBridgeAttached: false,
    });
  }

  /**
   * Has this session's prompt cache certainly expired, and is its transcript
   * large enough that re-reading it costs more than rebuilding from
   * projections?
   *
   * The second reason to retire a session, and not a variant of the first: the
   * size threshold bounds what a turn COSTS, this bounds what an IDLE turn
   * costs, and that second failure was unbounded. Measured on a real mission
   * (examples/line-follower-sim: 200 turns, 4.35M input tokens), fresh input
   * tracks the gap since this seat's previous turn — flat at a median of 5,655
   * tokens under ten minutes however long the conversation had grown, because
   * the prefix was served from cache — then a median of 23,615 and a maximum
   * of 691,420 past it, because the cache had expired and the whole transcript
   * was billed at full price. Seven turns of that mission carried 77.5% of its
   * entire input bill, and every one was a cold re-read.
   *
   * Rotating there gives up nothing that was not already lost: the cache prefix
   * is the one thing a rotation discards, and on this path it is gone before
   * the turn begins. Both conditions are required for that reason — a SMALL
   * transcript is cheap to re-read and the reasoning inside it is not free to
   * reproduce, so only a seat that is idle AND large is better off rebuilt.
   *
   * LATCHED, and that is the load-bearing part. The condition that triggers it
   * is a gap between turns, so it disappears the moment the seat takes one —
   * and the turn it triggers is a handover, which is exactly a turn taken on
   * the old transcript. Un-latched, the rotation would be deferred for the
   * handover and then never happen, and the seat would carry its cold
   * transcript for the rest of the mission. `rotationPending` latches it too,
   * so the supervisor still gets its chance to ask for a continuity record.
   */
  private markStaleRotationDue(s: LiveSession): boolean {
    if (s.staleRotationDue) return true;
    if (s.lastTurnEndedAt === undefined) return false;
    const staleAfter = this.options.staleAfterMs ?? SESSION_CACHE_STALE_MS;
    const floor = this.options.staleFloorTokens ?? SESSION_STALE_ROTATE_FLOOR_TOKENS;
    if (Date.now() - s.lastTurnEndedAt < staleAfter) return false;
    if (s.contextTokens < floor) return false;
    s.staleRotationDue = true;
    return true;
  }

  /**
   * Would the next `stream()` call rotate this session?
   *
   * Reads the same numbers the rotation decision itself reads, from the same
   * place, so the supervisor's answer and the adapter's cannot disagree.
   * Deliberately NOT a prediction of the next turn's size: `contextTokens` is
   * last turn's measurement, which is exactly what the threshold test at the
   * top of `stream` compares against.
   *
   * Sets the staleness latch when it reports one — a query with a side effect,
   * which the "cannot disagree" promise requires. The supervisor answers a
   * pending rotation by asking for a continuity record, and that handover turn
   * runs ON the old transcript, so it closes the very gap that made the session
   * stale. Remembering the verdict here is what makes the rotation still happen
   * on the turn after it.
   */
  rotationPending(session: AgentSession): RotationPendingInfo | null {
    const s = this.live.get(session.sessionId);
    if (!s || s.closed) return null;
    const thresholdTokens = this.options.rotateAtContextTokens ?? rotateAtFor(s.lastModel ?? s.configuredModel);
    if (s.contextTokens < thresholdTokens && !this.markStaleRotationDue(s)) return null;
    return { transcriptTokens: s.contextTokens, thresholdTokens };
  }

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
      // See SEAT_EFFORT: pins the seat's reasoning depth to the mesh instead of
      // inheriting the operator's personal `effortLevel`. Before extraOptions,
      // so the escape hatch still wins.
      effort: SEAT_EFFORT,
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
          this.reportMuteIfBridgeMissing(s);
          if (typeof msg.model === "string") s.lastModel = msg.model;
          if (!s.settledReady) {
            s.settledReady = true;
            s.markReady();
          }
        } else if (msg.type === "assistant") {
          const m = msg.message as { model?: string; content?: unknown; usage?: ClaudeTurnUsage };
          if (typeof m.model === "string") s.lastModel = m.model;
          // The per-call context, which nothing else in the mesh receives: the
          // `result` frame carries the turn's usage SUMMED over its calls, and
          // the rotation threshold needs one call's prompt, not the total of N
          // of them (§11c of `NOTES-communication-measured-review.md`).
          //
          // A max, not a last: the CLI emits one assistant frame per completed
          // content block and documents their `usage` as "not final", so
          // several frames can describe one call and an early one may report
          // zeros for cache terms it has not counted yet. A max ignores those
          // without inventing tokens, and the last call of a turn — the largest
          // prompt in it — always arrives on the final frame, whose usage is
          // final. Over a turn it is therefore the context the window had to
          // hold, not a figure that grows with the number of calls.
          if (s.pending) {
            const prompt = promptSize(m.usage);
            if (prompt > s.pending.maxPromptTokens) s.pending.maxPromptTokens = prompt;
          }
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
        } else if (msg.type === "user") {
          // Tool RESULTS. Previously dropped, and the omission was load-bearing:
          // `tool_call` is pushed when a call is announced and nothing ever
          // emitted `tool_call_update`, so `noteToolFrame` stamped liveness once
          // — at the START of the call — and never again. A single four-minute
          // `Bash` run therefore read as a turn that had gone silent, and the
          // stall watchdog killed it. That is the mechanism behind ten dead turns
          // in one live run, and no amount of tuning the silence floor fixes it.
          //
          // Both consumers already exist: `collectAgentOutput` folds
          // `tool_call_update` into `toolCalls`, and the dashboard's stream
          // reducer keys off it. Only the producer was missing.
          const um = (msg as { message?: { content?: unknown } }).message;
          const parts = Array.isArray(um?.content) ? um.content : [];
          for (const b of parts as Array<Record<string, unknown>>) {
            if (b.type !== "tool_result") continue;
            const id = b.tool_use_id ?? b.toolUseId;
            if (id === undefined || !s.pending) continue;
            s.pending.events.push({
              kind: "tool_call_update",
              toolCallId: String(id),
              status: b.is_error === true ? "failed" : "completed",
              resultDigest: shortDigest(JSON.stringify(b.content ?? "")),
            });
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
          const pending = s.pending;
          const result = msg as unknown as ResultMessage;
          if (pending?.interrupted && result.is_error) {
            // We stopped this turn on purpose and the CLI reported the abort as
            // an error (`error_during_execution`). Taking that at face value is
            // what made a deliberate stop indistinguishable from a crashed
            // backend: `handleAgentFailure` classifies on this error, so it
            // restarted the agent and spent its restart budget on a turn the
            // mesh itself had just ended — the scar the stall watchdog's own
            // doc comment promises not to leave ("isTimeoutError → slow").
            //
            // The supervisor force-settles an unanswered interrupt with exactly
            // this AbortError after a 2s grace, but the CLI answers far faster
            // than that (measured: 27ms), so the grace is a race the real frame
            // always wins. Deciding it here removes the race. A result that is
            // NOT an error is left alone: that is the CLI completing the turn
            // as we aborted, and its ops are legitimate work.
            // The frame we are discarding still reports what the backend spent
            // getting this far, so carry it out on the error instead of dropping
            // it. `InterruptedTurnError` is named "AbortError", so every
            // classification path downstream is unchanged — see its doc comment.
            pending.settle({
              ok: false,
              err: new InterruptedTurnError(
                "turn interrupted by the mesh before the backend answered",
                usageToTokens(result.usage),
              ),
            });
            // Every failure marks the seat UNREACHABLE, which `ensureSession`
            // reads as "discard this session and rebuild it". The abort left the
            // session exactly as a per-turn abort always leaves it — alive,
            // between turns, ready for the retry the supervisor is about to
            // schedule — so say IDLE rather than spend a resume on a seat that
            // never went anywhere.
            this.statuses.set(agentId, "IDLE");
          } else {
            pending?.settle({ ok: true, msg: result });
          }
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
