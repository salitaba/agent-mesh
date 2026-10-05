import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import {
  query,
  type CanUseTool,
  type HookCallbackMatcher,
  type HookEvent,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  BackendUnreachableError,
  InterruptedTurnError,
  TurnTimeoutError,
  EDIT_CAPABILITIES,
  TOOL_ERROR_MAX_CHARS,
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
  type ModelCatalogue,
  type RuntimeContext,
  type UsageGuardReport,
} from "../../protocol/src/index";
// Runtime commons: the queue every adapter needs to hand frames back, and
// the fold that turns those frames into the struct the supervisor reads.
import { PushQueue, collectAgentOutput } from "../../agent-runtime/src/index";
// Ops arrive only as typed mesh_* MCP tool calls, executed on the live turn by
// the supervisor; the reply text is prose and only yields the fallback summary.
import { extractSummary, shortDigest } from "../../agent-runtime/src/index";
// The gate, the landing gate and the two prompt texts are the mesh's rules rather than this backend's, so they live
// with the runtime commons and are re-exported here for the callers that have always imported them from this package.
import { NO_MESH_CALL_REMINDER, buildPermissionGate, withReadingDiscipline } from "../../agent-runtime/src/index";
export { NO_MESH_CALL_REMINDER, buildPermissionGate, describeToolPermissions, withReadingDiscipline } from "../../agent-runtime/src/index";
export type { ApprovalGate, ToolFamily, ToolPermission, ToolPermissionLevel, ToolPermissions } from "../../agent-runtime/src/index";
// The output-voice rules belong to the prompt layer, not to any one adapter:
// importing them from there is what keeps every runtime byte-identical on
// the part of the prompt that must not vary by backend.
import { withOutputVoice } from "../../core/src/context";
import { reapOrphanSeats, seatEnv, type ReapResult } from "./orphans";
export { describeHostLeaks, describeIsolation, outerSessionEnvNames, withoutOuterSession } from "./host-isolation";

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
   * Wall-clock BACKSTOP for a single turn — not the turn deadline. The
   * supervisor owns that, extensions included, and stops the turn itself; this
   * only catches a turn the supervisor failed to stop, so it must sit past the
   * supervisor's ceiling. A turn that outruns it is aborted and surfaces as a
   * `TurnTimeoutError` (slow, never a crash) rather than wedging the slot.
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
  /**
   * Pin the rotation threshold instead of deriving it from the model.
   *
   * Wins over `rotateAtFor` outright: operators tune this against a real mesh,
   * and the rotation tests have to reach a threshold in a handful of fake turns
   * rather than six hundred thousand tokens of them.
   */
  rotateAtContextTokens?: number;
  /**
   * `mesh.runtime.context_window`: the window, in tokens, of a model the table
   * below cannot place. The rotation threshold is derived from it at the usual
   * ratio. Ranks below a seat's own `AgentDefinition.contextWindow` AND below a
   * model the table knows, so it can never size a known small-window seat up.
   *
   * Measured 2026-09-25: every seat ran `deepseek-v4.1-flash`, a 1M model the
   * table does not list, rotated at the 120k floor, and nothing could say so —
   * this option existed only as `rotateAtContextTokens`, which nothing passed.
   */
  contextWindow?: number;
  /**
   * Where the adapter keeps the last measured context size per SDK session, so
   * a mesh restart that resumes a transcript knows how big it is instead of
   * starting the measurement at 0 (a seat resumed onto 224k per call with no
   * rotation pending, §12 of NOTES-live-run-20260925-2040.md). Omitted: kept in
   * memory only, which still covers an in-process resume.
   */
  stateDir?: string;
  /**
   * One-line operator notices the adapter cannot act on by itself: a backend
   * whose frames report no usage at all, a model whose window is unknown, a
   * backend whose calls report a prefix sent seconds earlier as uncached input
   * (`reattributedPrefix`), and a turn that had to wait for the mesh MCP bridge
   * to come up. Each fires once (per session, and per seat and model).
   */
  onNotice?: (info: {
    agentId: string;
    kind: "context_unmeasurable" | "unknown_context_window" | "usage_reattributed" | "mesh_bridge_race" | "orphan_seats_reaped";
    message: string;
  }) => void;
  /**
   * Stop seat CLIs a previous mesh process left running when it died, before this
   * one spawns any (see `orphans.ts`). Runs once, ahead of the first `start` or
   * `restoreSession`.
   *
   * Default: on for the real SDK query, off when `queryFn` is replaced -- a test
   * with a fake transport must not go signalling processes on the machine it runs
   * on. `false` turns it off; a function replaces the reaper (tests).
   */
  reapOrphans?: false | (() => Promise<ReapResult>);
  /**
   * Run seats without what the launching machine would lend them: an empty
   * `settingSources` (none of the user's hooks, allow rules, `env`, model or effort)
   * and none of the environment variables of an outer Claude Code session. See
   * `host-isolation.ts`. `extraOptions` still wins, as it does for everything here.
   */
  isolateHost?: boolean;
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
   * Waiting between bridge-respawn attempts, in ms; its length is the number of
   * fresh spawns one turn may buy.
   *
   * Defaults to `BRIDGE_RESPAWN_DELAYS_MS`, which is sized for a mesh server
   * that is still wiring its bridge up (measured: a child's bridge was still
   * "failed" 7s after the seat woke, so the original 3-attempt/7s budget was
   * spent before the bridge attached). Injected by the tests for the same reason
   * `rotateAtContextTokens` is: they cannot spend the real half-minute.
   */
  bridgeRespawnDelaysMs?: number[];
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

/*
 * A bound on a single mesh tool result USED TO LIVE HERE, and it did nothing.
 *
 * `meshResultCapHooks` returned `hookSpecificOutput.updatedToolOutput` from an
 * SDK `PostToolUse` callback. The field is real — `sdk.d.ts` documents it and
 * `updatedMCPToolOutput`, and the shipped CLI binary parses both in its
 * hook-output reader (`hwe`) — but the CLI reads them only for COMMAND/HTTP/
 * plugin hooks and in the interactive REPL. The executor that runs a JS
 * callback hook in a `--print`/stream-json session (the CLI's `VE`) harvests
 * exactly three things off a callback's return value — `systemMessage`,
 * `worktreePath`, and `decision:"block"` — and drops `hookSpecificOutput`
 * whole. So the rewrite never reached a model: measured over the live seats,
 * 0 of 325 `mcp__mesh__*` results carried the note, including every one far
 * over the bound it claimed to enforce.
 *
 * The bound now belongs to the MCP server, which owns both ends of it: the
 * read tools page themselves and say how to continue (see
 * `apps/mesh-server/src/pagination.ts`, `TOOL_PAGE_CHARS`). Do not reinstate a
 * rewrite hook here without first proving, against the installed CLI, that a
 * callback hook's `updatedToolOutput` reaches a tool result.
 */

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

/** Rows kept in the adapter's per-SDK-session context record (see `knownContext`). */
const MAX_KNOWN_CONTEXT_ROWS = 256;

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
 * Claude Code's marker for a model's 1M-context variant (`claude-sonnet-4-5[1m]`).
 * The id STATES its window, so honouring it is reading, not guessing upward.
 */
const ONE_M_SUFFIX = /\[1m\]$/i;

/**
 * The key a model id resolves to in the window table above.
 *
 * `toClaudeModelId` answers "which model do we ASK for" and must keep a dated
 * snapshot intact — un-pinning an operator's snapshot choice would be a silent
 * model swap. This answers a different question, "whose window is this", and a
 * snapshot has the same window as its family.
 *
 * The distinction is load-bearing because the window lookup prefers
 * `s.lastModel` — the id the BACKEND reports it actually seated, read from the
 * SDK's system/init and assistant frames — and that id is DATED. The table holds
 * bare ids, and `toClaudeModelId` strips only a provider segment, so before this
 * the preferred lookup key was the one key the table could never contain: every
 * real session took the unknown-model floor. Measured 2026-09-24: seats on a
 * 1,000,000-token window were rotating against 120,000, which is how a run
 * recorded "7x past threshold" overshoots that were mostly not overshoots at all.
 *
 * Exactly eight trailing digits after a hyphen, the only suffix the published ids
 * carry. This never rounds UP an id the table cannot place: `claude-opus-6-20260401`
 * normalizes to `claude-opus-6` and still misses.
 */
function windowKeyFor(spec: string | undefined): string | undefined {
  return toClaudeModelId(spec)?.replace(ONE_M_SUFFIX, "").replace(/-\d{8}$/, "");
}

/**
 * The window this model id is known to have — from its `[1m]` marker or the
 * table — or undefined when nothing places it. Never a guess: see `rotateAtFor`.
 */
export function knownContextWindow(model: string | undefined): number | undefined {
  if (model !== undefined && ONE_M_SUFFIX.test(model.trim())) return 1_000_000;
  const id = windowKeyFor(model);
  return id === undefined ? undefined : MODEL_CONTEXT_WINDOWS.get(id);
}

/**
 * Rotation threshold for the model a session is actually running.
 *
 * AN ID WE CANNOT PLACE GETS THE CONSERVATIVE FLOOR, NEVER A GUESS UPWARD.
 * `windowKeyFor` normalizes a dated snapshot onto its family but validates
 * nothing beyond that — so a typo, a model released after the table above was
 * written, and a real id are indistinguishable to this lookup. Assuming a large
 * window for an id we cannot place would let a 200k seat run hundreds of
 * thousands of tokens past the point where it overflows, killing a live
 * mission; assuming a small one costs a cache prefix and nothing else. Those
 * are not comparable failures, so the unknown case only ever rounds down.
 */
export function rotateAtFor(model: string | undefined): number {
  const window = knownContextWindow(model);
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
 * The CLI's native subagent tools, removed from every session this adapter
 * starts (seat and designer alike). See the seat options for why the
 * permission gate alone does not stop them.
 */
const ALWAYS_DISALLOWED_TOOLS = ["Task", "Agent"] as const;

/**
 * `disallowedTools` for a session: ours plus whatever `extraOptions` adds.
 * Applied AFTER the `extraOptions` spread, so the escape hatch can widen the
 * list but can never drop Task/Agent from it — a plain spread would have let an
 * operator's `disallowedTools: ["WebSearch"]` silently re-enable both.
 */
export function mergedDisallowedTools(extra: Partial<Options> | undefined): string[] {
  return [...new Set([...ALWAYS_DISALLOWED_TOOLS, ...(extra?.disallowedTools ?? [])])];
}

type SessionHooks = Partial<Record<HookEvent, HookCallbackMatcher[]>>;

/**
 * `hooks` for a session: ours plus whatever `extraOptions` adds, for the same
 * reason as `mergedDisallowedTools` — a plain spread would let an operator's
 * own `hooks` replace the advice hook and silently mute every deadline warning.
 */
function mergedHooks(ours: SessionHooks, extra: Partial<Options> | undefined): SessionHooks {
  const out: SessionHooks = { ...(extra?.hooks ?? {}) };
  for (const event of Object.keys(ours) as HookEvent[]) out[event] = [...(out[event] ?? []), ...(ours[event] ?? [])];
  return out;
}

/**
 * Several sets of ours, concatenated per event.
 *
 * A plain `{...a, ...b}` is wrong here and was wrong here: both sets name
 * `PostToolUse`, so the second spread REPLACED the first and the advice hook
 * stopped firing the moment the mesh-result bound was added beside it.
 */
function combineHooks(...sets: SessionHooks[]): SessionHooks {
  const out: SessionHooks = {};
  for (const set of sets)
    for (const event of Object.keys(set) as HookEvent[]) out[event] = [...(out[event] ?? []), ...(set[event] ?? [])];
  return out;
}

/**
 * The hooks that deliver `advise` notes: at each tool boundary, whatever is
 * queued for the turn in flight rides back to the model as that tool result's
 * `additionalContext`, joined, exactly once.
 *
 * A hook and not a user message: a message pushed into the inbox mid-turn is a
 * second user turn to the CLI, answered with a second `result` frame — and the
 * pump settles the mesh turn on the first `result` it sees, so the note would
 * end the turn it was meant to warn, or settle the next one.
 *
 * Both events, because a failing tool (a red test run, a non-zero Bash exit)
 * fires `PostToolUseFailure` INSTEAD of `PostToolUse`, and a coding turn near
 * its deadline is exactly the turn whose tools are failing. The drain is a
 * synchronous `splice`, so parallel tool calls cannot deliver a note twice.
 */
function adviceHooks(turn: () => TurnState | undefined): SessionHooks {
  const deliver = (hookEventName: "PostToolUse" | "PostToolUseFailure"): HookCallbackMatcher => ({
    hooks: [
      async () => {
        const notes = turn()?.advice.splice(0) ?? [];
        if (notes.length === 0) return { continue: true };
        return { hookSpecificOutput: { hookEventName, additionalContext: notes.join("\n\n") } };
      },
    ],
  });
  return { PostToolUse: [deliver("PostToolUse")], PostToolUseFailure: [deliver("PostToolUseFailure")] };
}

/** The prefix the CLI gives every tool of the `mesh` MCP server. */
const MESH_TOOL_PREFIX = "mcp__mesh__";

/**
 * The hook that gives a seat one more chance when it stops without a mesh call.
 *
 * A `Stop` hook and not a user message, for the reason `adviceHooks` is a hook: a message pushed after the turn ends is a second
 * user turn to the CLI, answered with a second `result` frame, and the pump settles the mesh turn on the first. Blocking the stop
 * keeps it ONE turn: the model carries on in the same session, its cache warm, and the turn's usage is the sum of both rounds.
 * Once per turn (`endReminded`, and the CLI's own `stop_hook_active`), and never for a turn the mesh is itself ending: an abort
 * (a timeout is one, and marks the turn `interrupted` too) or a handover it closed.
 */
function endOfTurnHooks(turn: () => TurnState | undefined): SessionHooks {
  return {
    Stop: [
      {
        hooks: [
          async (input) => {
            const t = turn();
            if (!t || t.interrupted || t.endRequested) return {};
            if (t.meshCalls > 0 || t.endReminded) return {};
            if ((input as { stop_hook_active?: boolean }).stop_hook_active) return {};
            t.endReminded = true;
            return { decision: "block", reason: NO_MESH_CALL_REMINDER };
          },
        ],
      },
    ],
  };
}

/**
 * Why this seat's mesh MCP bridge cannot carry ops, or undefined when it can.
 *
 * Every mesh op is a typed `mesh_*` call now; there is no prose fallback, so a
 * seat without a connected bridge can spend a whole turn and land nothing.
 * `pending` is not treated as down: it is the CLI's non-blocking connect mode
 * still dialling, and the next turn's `init` frame reports the settled status.
 */
export function meshBridgeDownReason(servers: Array<{ name: string; status: string }> | undefined): string | undefined {
  const bridge = (servers ?? []).find((m) => m.name === "mesh");
  if (bridge?.status === "connected" || bridge?.status === "pending") return undefined;
  return `claude runtime: the mesh MCP bridge is ${bridgeStatusLabel(servers)}, so this seat has no way to issue mesh ops; turn aborted`;
}

/**
 * The same fact as `meshBridgeDownReason`, as a label rather than a sentence:
 * what an audit line about the bridge should call its state. One producer, so
 * the line an operator greps and the error a turn fails with cannot disagree.
 */
function bridgeStatusLabel(servers: Array<{ name: string; status: string }> | undefined): string {
  const bridge = (servers ?? []).find((m) => m.name === "mesh");
  return bridge ? `status "${bridge.status}"` : "not registered";
}

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
 * The context a turn was carrying, estimated from its SUMMED reads when no
 * frame reported a per-call prompt: twice the per-call mean, never more than
 * the sum.
 *
 * Why that bound: within a turn every call re-sends the transcript plus what
 * the previous call added, so prompts grow call by call. For a non-decreasing
 * sequence that grows linearly or decelerates, the last (largest) prompt is at
 * most `2 * mean - first`, so `2 * sum / calls` sits at or above it — the safe
 * side, rotating early rather than letting a window overflow — and is exact at
 * one or two calls, where it equals the sum. The raw sum is the figure that
 * caused the incident: 6,773,313 reported for a turn whose largest call was
 * 191,576 (frontend seq 1019, 57 calls — this gives 237,661). With no call
 * count there is nothing to divide by, and the sum is the only safe bound.
 */
export function estimateContextFromSum(sum: number, calls: number): number {
  if (!(calls > 0)) return sum;
  return Math.min(sum, Math.ceil((2 * sum) / calls));
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

/** One model call's usage as its frames have reported it so far; see `noteCallUsage`. */
interface CallUsage {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  /** Absent until a frame reports a breakdown: unknown, not zero, as in `usageToTokens`. */
  thinking?: number;
}

/** One model call of the turn: as reported, as billed, and which call came before it. */
interface CallRecord {
  /** Per term, the largest figure any of the call's frames reported. */
  raw: CallUsage;
  /** `raw`, or `raw` with `reattributed` tokens moved from `input` to `cacheRead`. */
  billed: CallUsage;
  reattributed: number;
  /** Key of the turn's previous call; absent on the turn's first. */
  prevKey?: string;
}

/**
 * Smallest prefix `reattributedPrefix` will move. Below it a missed cache is
 * cheap and plausibly real (a provider's minimum cacheable prompt is of this
 * order), so the report is billed as it stands.
 */
const REATTRIBUTE_MIN_PREFIX_TOKENS = 8_000;

/**
 * How many of one call's reported `input` tokens are billed as `cache_read`
 * instead: the prompt the previous call of the SAME turn was handed, when this
 * call reports no cache at all and a prompt at least that large.
 *
 * Measured 2026-09-26 behind a translating proxy: mid-session a seat's message
 * ids switched format and every call after reported `input_tokens` = its whole
 * prompt and `cache_read_input_tokens` = 0, while the proxy's own log showed the
 * cache hit on the same calls (backend 15:12:12Z: 100,182 reported as input, of
 * which the proxy logged 99,968 as cached). 55 such calls across two seats billed
 * 6.41M phantom tokens in 13 minutes; the ledger, the live counter, seat parking
 * and escalations all acted on them, and an operator stopped the mission.
 *
 * Within one turn the conversation only grows, and the previous call sent its
 * prefix seconds ago, so a same-or-larger prompt reporting zero cache is a
 * dropped cache report, not a miss. Nothing else is touched: a call whose prompt
 * shrank (compaction, a rotation), any call that reports a nonzero cache term,
 * and `output`. The move keeps the prompt size, so rotation sizing is unchanged.
 *
 * The turn's FIRST call is judged by the same rule against the previous turn's
 * final prompt — the one caller `noteCallUsage` supplies — and only while that
 * turn ended inside the operator's cache window. With no such evidence the call
 * is billed as reported, because the prefix may really have gone cold between
 * turns; see {@link previousTurnPrefix} for what counts as evidence.
 */
export function reattributedPrefix(call: { input: number; cacheRead: number; cacheWrite: number }, prevPrompt: number | undefined): number {
  if (prevPrompt === undefined || prevPrompt < REATTRIBUTE_MIN_PREFIX_TOKENS) return 0;
  if (call.cacheRead !== 0 || call.cacheWrite !== 0) return 0;
  if (call.input < prevPrompt) return 0;
  return Math.min(prevPrompt, call.input);
}

/**
 * The evidence a turn's FIRST call is judged against: the final prompt of the
 * session's previous turn, or undefined when that turn is not usable evidence.
 *
 * The intra-turn rule reads the previous CALL's prompt, which a turn's first
 * call does not have. Without a second kind of evidence the guard skipped it by
 * design — "the prefix may really have gone cold between turns" — and on a route
 * that drops the cache report that skip is where the largest single cost of a
 * turn came from: the whole 200k-400k context billed as new input once per turn,
 * on top of an otherwise correctly-guarded turn (measured 2026-09-27: 400-500k
 * of input per backend turn against 110-260k for the same seat on an honest
 * route).
 *
 * The turn boundary itself is not what makes a prefix cold — whoever runs the
 * mesh says what does, and says it with `mesh.runtime.stale_after_ms`: the same
 * window the staleness rotation already reads. So a call is judged only while
 * the recorded turn ended inside it. The measurement behind that reuse: through
 * the live proxy, a prompt was still 94% cached upstream after a 10-minute idle
 * gap and 99% after 5-10 minutes, so the cache outlives every gap the operator
 * would call fresh. Past the window nothing is assumed, and the call is billed
 * exactly as the backend reported it.
 *
 * Undefined is the honest answer for every case without usable evidence: the
 * session's first turn (nothing recorded), a fresh session after a rotation or
 * compaction (the record does not carry across one), and a gap past the window.
 * The 8,000-token floor is not re-checked here — {@link reattributedPrefix} owns
 * it, and it must apply identically to both kinds of evidence.
 */
export function previousTurnPrefix(
  record: { promptTokens: number | undefined; endedAt: number | undefined } | undefined,
  staleAfterMs: number,
  now: number,
): number | undefined {
  const { promptTokens, endedAt } = record ?? { promptTokens: undefined, endedAt: undefined };
  if (promptTokens === undefined || endedAt === undefined) return undefined;
  if (now - endedAt > staleAfterMs) return undefined;
  return promptTokens;
}

/**
 * The turn's usage with `tokens` moved from `input` (and so from `total`) to
 * `cacheRead` — what `noteCallUsage` did to the live figure, applied to the
 * `result` frame's sum so the settled figure still equals the last live one.
 */
export function reattributeTokens(t: AgentOutput["tokensUsed"], tokens: number): AgentOutput["tokensUsed"] {
  const moved = Math.min(Math.max(0, tokens), t.input);
  if (!(moved > 0)) return t;
  return { ...t, input: t.input - moved, total: t.total - moved, cacheRead: (t.cacheRead ?? 0) + moved };
}

/**
 * What the usage guard did to one turn, on the `turn_end` frame and `send`'s
 * output when it moved anything. `raw` is the backend's summed report and
 * `adjusted` what was billed (equal to the turn's `tokensUsed`). The protocol
 * types carry the field now; these names remain for the adapter's callers.
 *
 * `firstCallAdjustments` is this runtime's addition to that shape and rides
 * inside the same object: of the calls counted in `adjustedCalls`, how many were
 * a turn's FIRST call, judged against the previous turn rather than the previous
 * call ({@link previousTurnPrefix}). Absent when none were, so a report that
 * predates the field and one with nothing to say about it read alike.
 */
export type ClaudeUsageGuard = UsageGuardReport & { firstCallAdjustments?: number };
/**
 * `AgentEventTurnEnd`, plus the diagnostics only this adapter produces.
 *
 * `bridgeRespawns` rides here rather than on the protocol's type because it is
 * a property of this runtime's turn START, not of a turn's result: another
 * adapter has no equivalent, and widening the shared event for it would put a
 * Claude-shaped field on every runtime's turn_end. Present only when a fresh
 * spawn was spent on it (absent, never 0, when the bridge was up at init).
 *
 * `usageGuard` is narrowed to {@link ClaudeUsageGuard} for the same reason: the
 * protocol fields are all still there, and the turn-boundary count is a field
 * only a runtime that keeps a session record can produce.
 */
export type ClaudeTurnEnd = Omit<AgentEventTurnEnd, "usageGuard"> & {
  usageGuard?: ClaudeUsageGuard;
  bridgeRespawns?: number;
};
/**
 * What `send` hands back: the shared fold's output, with `usageGuard` narrowed
 * the same way `ClaudeTurnEnd`'s is. Assignable to `AgentOutput` unchanged — the
 * extra field is on the guard, and `adjustedCalls` and the totals are untouched.
 */
export type ClaudeAgentOutput = Omit<AgentOutput, "usageGuard"> & { usageGuard?: ClaudeUsageGuard };

/** A wire figure as a count: absent, null, or not a finite number reads as 0. */
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

const callPrompt = (c: CallUsage): number => c.input + c.cacheRead + c.cacheWrite;

function callUsageToTokens(c: CallUsage): AgentOutput["tokensUsed"] {
  return usageToTokens({
    input_tokens: c.input,
    output_tokens: c.output,
    cache_creation_input_tokens: c.cacheWrite,
    cache_read_input_tokens: c.cacheRead,
    ...(c.thinking !== undefined ? { output_tokens_details: { thinking_tokens: c.thinking } } : {}),
  });
}

/**
 * Fold one frame's per-call usage into the turn: the rotation measurement
 * (`maxPromptTokens`) always, and — when the frame names its call — the live
 * cumulative figure, pushed as a `usage_update` whenever it moves.
 *
 * The live figure is a sum over CALLS, never over frames. One call is reported
 * by several frames (`message_start`, one `assistant` frame per content block,
 * all sharing the call's `message.id`, then `message_delta`), each carrying the
 * call's usage so far, so a sum over frames bills a call three to five times.
 * Each call is kept once, per term at the largest figure any of its frames
 * reported: every term is non-decreasing within a call, and WHICH frame carries
 * which term depends on the backend. Anthropic puts the input terms on
 * `message_start` and may send `message_delta` with `output_tokens` alone; the
 * translating proxy of the 2026-09-25 run sent zeros everywhere but
 * `message_delta` (NOTES-live-run-20260925-2040.md §1). A whole-record
 * last-frame-wins would drop the input terms on the first backend.
 *
 * `callKey` is undefined for a subagent's frames: they measure another
 * transcript, and this figure should approach the `result` total, never pass it.
 *
 * The sum is of BILLED figures: a call `reattributedPrefix` suspects is folded
 * with its prefix moved to `cacheRead` here, before any `usage_update` leaves
 * the adapter, so the live counter and the budget checks fed by it never see
 * the phantom input. Rotation sizing (`maxPromptTokens`) reads the raw frame;
 * the move does not change a prompt's size. Returns the call's figures the first
 * time this frame makes it re-attributed, for the once-per-session notice, and
 * says whether that call was the turn's first — the notice reads differently for
 * a prefix sent by the previous call of this turn and one the turn before sent.
 */
function noteCallUsage(
  turn: TurnState,
  u: ClaudeTurnUsage | undefined,
  callKey: string | undefined,
): { prompt: number; prefix: number; firstCall: boolean } | undefined {
  const prompt = promptSize(u);
  if (prompt > turn.maxPromptTokens) turn.maxPromptTokens = prompt;
  if (!u || callKey === undefined) return undefined;
  let call = turn.callUsage.get(callKey);
  if (!call) {
    const none: CallUsage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    call = { raw: none, billed: none, reattributed: 0, ...(turn.lastCallKey !== undefined ? { prevKey: turn.lastCallKey } : {}) };
    turn.callUsage.set(callKey, call);
    turn.lastCallKey = callKey;
  }
  const prev = call.raw;
  const raw: CallUsage = {
    input: Math.max(prev.input, count(u.input_tokens)),
    output: Math.max(prev.output, count(u.output_tokens)),
    cacheWrite: Math.max(prev.cacheWrite, count(u.cache_creation_input_tokens)),
    cacheRead: Math.max(prev.cacheRead, count(u.cache_read_input_tokens)),
  };
  const thinking = u.output_tokens_details?.thinking_tokens;
  if (prev.thinking !== undefined || typeof thinking === "number") raw.thinking = Math.max(prev.thinking ?? 0, count(thinking));
  const before = call.prevKey === undefined ? undefined : turn.callUsage.get(call.prevKey);
  // A call with no predecessor WITHIN the turn — the turn's first, however many
  // of its frames arrive here — is judged against the previous TURN's final
  // prompt when this session recorded one ({@link previousTurnPrefix}), and
  // against nothing otherwise. Derived per frame rather than fixed when the call
  // is created: under a translating proxy the call's own `message_start` reports
  // zeros and only a later frame of the same call carries the real prompt, so an
  // evidence decided at creation time would be judged against input 0.
  const evidence = before ? callPrompt(before.raw) : turn.firstCallPrevPrompt;
  const moved = reattributedPrefix(raw, evidence);
  const billed: CallUsage = moved > 0 ? { ...raw, input: raw.input - moved, cacheRead: raw.cacheRead + moved } : raw;
  const was = call.billed;
  const newly = moved > 0 && call.reattributed === 0;
  const firstCall = call.prevKey === undefined;
  // A later frame can un-suspect a call (it reports a cache term after all),
  // so the count and the moved total follow the call rather than only grow.
  if (newly) {
    turn.reattributedCalls++;
    if (firstCall) turn.reattributedFirstCalls++;
  } else if (moved === 0 && call.reattributed > 0) {
    turn.reattributedCalls--;
    if (firstCall) turn.reattributedFirstCalls--;
  }
  turn.reattributedTokens += moved - call.reattributed;
  call.raw = raw;
  call.billed = billed;
  call.reattributed = moved;
  const sum = turn.usageSum;
  const d = {
    input: billed.input - was.input,
    output: billed.output - was.output,
    cacheWrite: billed.cacheWrite - was.cacheWrite,
    cacheRead: billed.cacheRead - was.cacheRead,
    thinking: (billed.thinking ?? 0) - (was.thinking ?? 0),
  };
  sum.input += d.input;
  sum.output += d.output;
  sum.cacheWrite += d.cacheWrite;
  sum.cacheRead += d.cacheRead;
  if (billed.thinking !== undefined) sum.thinking = (sum.thinking ?? 0) + d.thinking;
  if (d.input || d.output || d.cacheWrite || d.cacheRead || d.thinking) {
    turn.events.push({ kind: "usage_update", tokensUsed: callUsageToTokens(sum) });
  }
  return newly ? { prompt: callPrompt(raw), prefix: moved, firstCall } : undefined;
}

/** The `result` frame's summed usage, re-attributed exactly as the live figure was. */
function settledUsage(turn: TurnState, u: ClaudeTurnUsage | undefined): AgentOutput["tokensUsed"] {
  return reattributeTokens(usageToTokens(u), turn.reattributedTokens);
}

/** What the turn's frames reported, or undefined when none reported anything: absent is unmeasured, never zero. */
function liveUsage(turn: TurnState): AgentOutput["tokensUsed"] | undefined {
  const s = turn.usageSum;
  return s.input + s.output + s.cacheWrite + s.cacheRead > 0 ? callUsageToTokens(s) : undefined;
}

/**
 * What a turn the mesh cut short spent: the abort's own `result` frame, or the figure the stream carried when that frame reads zero.
 *
 * The CLI answers an abort with a frame whose usage can be all zero though the call it cut short was billed in full. Six of the eleven
 * handovers of the ninth to fifteenth cronlite runs (each ended by `endTurn` the moment its continuity record landed) booked 0 tokens
 * that way, the developer's of the fifteenth for a call that wrote 14,826 and read 139,638 tokens of cache. Absent or zero is
 * unmeasured, and unmeasured is not free.
 */
function abortedUsage(turn: TurnState, u: ClaudeTurnUsage | undefined): AgentOutput["tokensUsed"] {
  const reported = settledUsage(turn, u);
  return reported.total + (reported.cacheRead ?? 0) > 0 ? reported : (liveUsage(turn) ?? reported);
}

/**
 * The prompt the turn's final model call was handed — the record a NEXT turn's
 * first call is judged against — or 0 when no call reported usage.
 *
 * The FINAL call, not the largest any call reached: what a next turn re-sends is
 * the conversation as the last call left it, and a turn whose final call shrank
 * (a compaction) is a turn whose context was reset, whose next first call must
 * not be re-attributed against a prefix that no longer exists. Calls are keyed by
 * API message id in insertion order, so the last key created is the turn's last
 * call; its `raw` is the max over that call's frames, as everywhere.
 */
function lastCallPrompt(turn: TurnState): number {
  const last = turn.lastCallKey !== undefined ? turn.callUsage.get(turn.lastCallKey) : undefined;
  return last ? callPrompt(last.raw) : 0;
}

/**
 * The text of a `tool_result` block, whichever of the wire's two shapes it came
 * in: a bare string, or an array of content blocks of which only the `text`
 * ones say anything a reader can use (an image block has no words to show).
 * Anything else reads as empty, never as a JSON dump of the block.
 */
export function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
    .filter((t) => t.length > 0)
    .join("\n");
}

/** Serializable half of a session — this is what the mesh persists. */
interface ClaudeSessionHandle {
  sdkSessionId: string;
  model?: string;
}

/**
 * How long a turn the mesh aborted waits for the CLI to answer the abort, in ms.
 *
 * Same figure and same reason as the supervisor's TURN_TIMEOUT_USAGE_GRACE_MS:
 * the answer is a `result` frame carrying the turn's real usage — the only
 * token figure a killed turn has — and the CLI sends it in milliseconds
 * (measured: 27ms). Past this, the CLI is taken to have ignored the abort: the
 * turn is settled without it, and the session torn down, because a CLI that
 * answers late would hand that `result` to whichever turn is pending by then.
 */
const ABORT_ANSWER_GRACE_MS = 2000;

/** Named on every adapter-backstop timeout, so the audit says which deadline fired. */
const BACKSTOP_NOTE = "claude adapter backstop: the supervisor did not stop the turn";

/**
 * Fresh spawns a seat gets when the mesh MCP bridge is not up at `init`.
 *
 * The status the CLI reports at `init` is fixed for the life of that query —
 * the bridge is dialled as the query starts — so the only way to re-read it is
 * a new spawn. That makes a bridge the child has not finished bringing up look
 * exactly like a permanently broken one, and it is not: measured live
 * (2026-09-27T08:52:13Z), a child restart woke a seat about a second later and
 * its turn died on `status "failed"`, while the mission was healthy seconds
 * after that. Each such turn cost a discard, a restart-ladder step and the
 * seat's turn.
 *
 * So a bridge that is down at init buys a bounded number of fresh spawns, at a
 * backoff long enough for a starting bridge to attach and short enough to sit
 * inside every deadline that governs the turn: the supervisor's silence window
 * (`turn_silence_ms`, 300s by default) and its ceiling (`turn_timeout_ms × 3`,
 * 30 minutes by default) see 7s of it, and the adapter's own first-frame
 * watchdog is per-attempt rather than for the whole retry.
 *
 * Exported so the tests can assert the budget rather than restate it.
 */
export const BRIDGE_RESPAWN_ATTEMPTS = 5;

/**
 * The wait before each of those spawns, in order: `BRIDGE_RESPAWN_ATTEMPTS`
 * entries, so the whole retry window is 30s. Short first, because the race this
 * absorbs is milliseconds wide in the common case; longer after, because a
 * bridge that is still not up after a second is usually a bridge that is
 * genuinely failing to start. The tail is long because a restart's bridge was
 * measured still unready 7s in, which is what the first 3-attempt/7s budget
 * missed; 30s still sits far inside the supervisor's 300s silence window.
 */
export const BRIDGE_RESPAWN_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];

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
  /**
   * Model calls this turn made, counted off `message_start` (one per call).
   * The divisor of `estimateContextFromSum` when no frame reported usage.
   */
  modelCalls: number;
  /**
   * Set by `endTurn`: the abort that follows is the mesh closing a turn whose
   * work already landed, so its error result settles the turn as COMPLETE.
   */
  endRequested?: boolean;
  /**
   * Set by the adapter's own backstop timer. Implies `interrupted`, but the
   * abort's answer settles as a `TurnTimeoutError`, not an interrupt: this
   * turn died of a deadline, and `classifyTurnFailure` reads the type.
   */
  timedOut?: boolean;
  /**
   * Set with a failure the `init` frame attributes to the mesh MCP bridge.
   *
   * `stream` reads it to tell a startup race — the child was still bringing the
   * bridge up when this seat's query started — from a real fault, and to retry
   * the turn on a fresh spawn instead of reporting a permanently mute seat.
   * The error itself is unchanged, and is what the turn still fails with once
   * the retry budget is spent.
   */
  bridgeDown?: boolean;
  /**
   * Fresh spawns already spent on that, carried onto the turn's `turn_end` so
   * a race is visible in the record rather than only in the audit line.
   */
  bridgeRespawns?: number;
  /** The give-up on an abort the CLI has not answered yet; cleared by `settle`. */
  abortGrace?: NodeJS.Timeout;
  /**
   * Per-call usage the frames reported, keyed by API message id, and the
   * running sum of its billed half: the live figure `usage_update` carries.
   * See `noteCallUsage`.
   */
  callUsage: Map<string, CallRecord>;
  usageSum: CallUsage;
  /** The call opened most recently: the next call's predecessor. */
  lastCallKey?: string;
  /** Calls `reattributedPrefix` moved tokens for, and the tokens moved. */
  reattributedCalls: number;
  reattributedTokens: number;
  /**
   * Of `reattributedCalls`, how many were the turn's FIRST call — the ones
   * judged against the previous turn rather than against the previous call
   * (see `previousTurnPrefix`). Reported as `usageGuard.firstCallAdjustments`.
   */
  reattributedFirstCalls: number;
  /**
   * The evidence this turn's first call is judged against: the final prompt of
   * the session's previous turn, when that turn ended inside the operator's
   * `stale_after_ms` window — and undefined whenever there is no such evidence
   * (the session's first turn, a fresh session after a rotation, a gap past the
   * window, or a previous turn whose calls reported nothing). Undefined means a
   * zero-cache first call is billed exactly as reported: the prefix may really
   * have gone cold. Fixed for the turn at setup, from the session record.
   */
  firstCallPrevPrompt?: number;
  /**
   * The message id of the call in progress, from its `message_start`.
   * `message_delta` names no call and always follows its own call's
   * `message_start`, so this is how its usage finds the right one.
   */
  callId?: string;
  /**
   * Notes `advise` queued for THIS turn, drained by the tool-boundary hook.
   * Held on the turn, not the session, so a note that never met a tool call
   * dies with its turn instead of surfacing in the next one.
   */
  advice: string[];
  /**
   * Mesh tool calls (`mcp__mesh__*`) this turn has announced so far. Read by the end-of-turn
   * hook: a turn that stops at zero reported nothing to anyone, whatever else it did.
   */
  meshCalls: number;
  /** Set once the end-of-turn reminder has been given, so a turn is reminded at most once. */
  endReminded: boolean;
}

/**
 * What one attempt tells `stream` about why it failed, so the retry decision
 * never has to sniff an error: `bridge` is set only where the `init` frame said
 * the mesh bridge was down, and `live` is the session that reported it (the one
 * a respawn and the mute alarm both read from).
 */
interface BridgeRespawnState {
  live?: LiveSession;
  bridge?: boolean;
  /**
   * How the failing `init` described the bridge — `status "failed"`, or
   * `not registered` when the CLI listed no `mesh` server at all. Captured when
   * the failure is, not read off the session at the end, because the session the
   * retry ends on is the one whose bridge came up.
   */
  status?: string;
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
  /** Set from `init` when the mesh bridge is down; fails the turn fast. */
  bridgeDown?: string;
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
   * Whether this query was opened as a `resume` of a transcript that already
   * exists, rather than as a brand-new session.
   *
   * Decides how a bridge respawn reopens it (see `respawnForBridge`): a resumable
   * query is re-resumed, because its transcript is on disk and losing it would
   * silently drop everything this seat remembers; a brand-new one has nothing to
   * lose, and its id may not be on disk yet, so the respawn gives it a new one.
   */
  wasResumed: boolean;
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
   * When no frame reported usage at all it is ESTIMATED from that sum
   * (`estimateContextFromSum`), so a backend that reports nothing rotates early
   * rather than never — but not at the raw sum, which made ~half of one live
   * run's turns handovers (NOTES-live-run-20260925-2040.md §1).
   */
  contextTokens: number;
  /** Whether "context unmeasurable" was already reported for this session. */
  unmeasurableReported?: boolean;
  /** Whether "usage re-attributed" was already reported for this session. */
  reattributionReported?: boolean;
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
   * The final prompt of this session's last COMPLETED turn, in tokens — the
   * evidence the next turn's first call is judged against (`previousTurnPrefix`)
   * for the same reason `lastTurnEndedAt` is recorded beside it: a turn boundary
   * does not by itself make a prefix cold.
   *
   * Held per session, so a rotation — which stands a fresh `LiveSession` up under
   * a new SDK id — cannot carry it: the replacement's transcript is empty and
   * nothing about the retired one predicts its prompts. Written only by a turn
   * that settled as a success, and only from a call that actually reported usage;
   * absent at every other time, and absent means "no evidence" rather than "a
   * small context".
   */
  lastTurnPromptTokens?: number;
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
  /**
   * The last measured context per SDK session id, outliving the `LiveSession`
   * that measured it. `open` used to start every session at 0, including a
   * `resume` of a transcript it had just measured: a seat whose turn timed out
   * was resumed onto a 224k-per-call transcript with no rotation pending
   * (NOTES-live-run-20260925-2040.md §12). Mirrored to `stateDir` when given.
   *
   * `lastTurnPromptTokens` rides along so the usage guard's evidence survives a
   * respawn or a process restart on the same transcript — the two cases where
   * the turn boundary is a restart rather than a context reset. It is a
   * MEASUREMENT, like `contextTokens` at its best and unlike its estimate
   * fallback, and it is still gated by the operator's staleness window when read.
   */
  private knownContext = new Map<
    string,
    { contextTokens: number; lastTurnEndedAt?: number; lastTurnPromptTokens?: number; updatedAt: number }
  >();
  private knownContextLoaded = false;
  /** Notice keys already reported, so each notice fires once. */
  private noticed = new Set<string>();
  /**
   * Sessions a stop arrived for while they had no live query to abort — which,
   * since the failure paths tear their query down before throwing, means the gap
   * between the attempts of a bridge retry. Read and cleared by `stream`, so a
   * respawn cannot resurrect a turn the mesh has already stopped.
   */
  private stoppedMidRetry = new Set<string>();

  constructor(private options: ClaudeAdapterOptions = {}) {
    this.turnTimeoutMs = options.turnTimeoutMs ?? 600000;
    this.firstFrameTimeoutMs = options.firstFrameTimeoutMs ?? 45000;
    this.spawnFailureGraceMs = options.spawnFailureGraceMs ?? 500;
  }

  /** Per-agent `model` from mesh.yaml, else the mesh-wide adapter default. */
  private modelFor(agent: AgentDefinition): string | undefined {
    return toClaudeModelId(agent.model) ?? this.options.model;
  }

  /**
   * The rotation threshold for this session. One place, read by both `stream`
   * and `rotationPending`, so the supervisor's answer and the adapter's agree.
   *
   * A pinned threshold wins outright; then the window, from the most specific
   * knowledge to the least: the seat's own `context_window`, the model the
   * backend reports it seated (table or `[1m]`), the mesh-wide
   * `context_window`, and only then the conservative floor — which is now said
   * out loud, once, instead of silently charging a 1M model a 200k window.
   */
  private thresholdFor(s: LiveSession): number {
    if (this.options.rotateAtContextTokens !== undefined) return this.options.rotateAtContextTokens;
    const model = s.lastModel ?? s.configuredModel;
    const window = s.agent.contextWindow ?? knownContextWindow(model) ?? this.options.contextWindow;
    if (window !== undefined) return Math.floor(window * SESSION_CONTEXT_ROTATE_RATIO);
    this.noticeOnce(`window:${s.agent.id}:${model ?? ""}`, {
      agentId: s.agent.id,
      kind: "unknown_context_window",
      message:
        `${s.agent.id}: no context window is known for model '${model ?? "(unreported)"}' — rotating at the ` +
        `${SESSION_CONTEXT_ROTATE_TOKENS}-token floor. Set mesh.runtime.context_window or agents.${s.agent.id}.context_window.`,
    });
    return SESSION_CONTEXT_ROTATE_TOKENS;
  }

  private noticeOnce(key: string, info: Parameters<NonNullable<ClaudeAdapterOptions["onNotice"]>>[0]): void {
    if (this.noticed.has(key)) return;
    this.noticed.add(key);
    try {
      this.options.onNotice?.(info);
    } catch {
      // Observability only.
    }
  }

  /**
   * The context a turn carried when no frame reported a per-call prompt: an
   * estimate from the turn's summed reads (see `estimateContextFromSum`), and a
   * notice, once per session, that this backend's context cannot be measured.
   */
  private unmeasuredContext(s: LiveSession, tokens: AgentOutput["tokensUsed"] | undefined, calls: number): number {
    const sum = transcriptSize(tokens);
    if (sum > 0 && !s.unmeasurableReported) {
      s.unmeasurableReported = true;
      this.noticeOnce(`unmeasurable:${s.meshSessionId}`, {
        agentId: s.agent.id,
        kind: "context_unmeasurable",
        message:
          `${s.agent.id}: context unmeasurable — no frame of session ${s.sdkSessionId} reported per-call usage ` +
          `(message_start, message_delta or assistant); estimating it from the turn's summed reads over ${calls} call(s)`,
      });
    }
    return estimateContextFromSum(sum, calls);
  }

  /**
   * Fold one frame's usage into the turn in flight (`noteCallUsage`) and, the
   * first time a call of this seat session is re-attributed, say so once: the
   * backend is dropping cache usage, and the figures it reports are not what
   * the mesh bills. Same once-per-session latch as "context unmeasurable".
   *
   * One notice covers both kinds of evidence — the previous call of the same
   * turn, and the previous turn of the same session — because they are one fault
   * seen at two distances, and a session that drops cache reports will usually
   * show both. Which one fired leads the sentence, so the operator can still
   * tell a mid-turn gap from a turn boundary.
   */
  private noteUsage(s: LiveSession, u: ClaudeTurnUsage | undefined, callKey: string | undefined): void {
    const turn = s.pending;
    if (!turn) return;
    const fired = noteCallUsage(turn, u, callKey);
    if (!fired || s.reattributionReported) return;
    s.reattributionReported = true;
    this.noticeOnce(`reattributed:${s.meshSessionId}`, {
      agentId: s.agent.id,
      kind: "usage_reattributed",
      message:
        `${s.agent.id}: usage re-attributed — session ${s.sdkSessionId} reported a ${fired.prompt}-token call with zero cache ` +
        (fired.firstCall
          ? `when the previous turn of this session had sent `
          : `right after the same turn sent `) +
        `${fired.prefix} tokens of it; billing that prefix as cache_read, not input. The backend ` +
        `or a proxy in front of it is dropping cache usage; raw vs billed figures are on the turn's usageGuard`,
    });
  }

  /** Where `knownContext` is mirrored, or undefined for memory only. */
  private knownContextFile(): string | undefined {
    return this.options.stateDir ? path.join(this.options.stateDir, "claude-context.json") : undefined;
  }

  /** The last measurement of this SDK session, from memory or the state file. */
  private recallContext(
    sdkSessionId: string,
  ): { contextTokens: number; lastTurnEndedAt?: number; lastTurnPromptTokens?: number } | undefined {
    const file = this.knownContextFile();
    if (!this.knownContextLoaded && file) {
      this.knownContextLoaded = true;
      try {
        const rows = JSON.parse(fs.readFileSync(file, "utf8")) as Record<
          string,
          { contextTokens?: unknown; lastTurnEndedAt?: unknown; lastTurnPromptTokens?: unknown; updatedAt?: unknown }
        >;
        for (const [id, r] of Object.entries(rows)) {
          if (typeof r?.contextTokens !== "number" || this.knownContext.has(id)) continue;
          this.knownContext.set(id, {
            contextTokens: r.contextTokens,
            ...(typeof r.lastTurnEndedAt === "number" ? { lastTurnEndedAt: r.lastTurnEndedAt } : {}),
            ...(typeof r.lastTurnPromptTokens === "number" ? { lastTurnPromptTokens: r.lastTurnPromptTokens } : {}),
            updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : 0,
          });
        }
      } catch {
        // No file yet, or an unreadable one: the session starts unmeasured, as before.
      }
    }
    return this.knownContext.get(sdkSessionId);
  }

  /** Record a session's measurement where the next `open` of its transcript finds it. */
  private rememberContext(s: LiveSession): void {
    this.recallContext(s.sdkSessionId); // load the file first, so a write never drops its rows
    this.knownContext.set(s.sdkSessionId, {
      contextTokens: s.contextTokens,
      ...(s.lastTurnEndedAt !== undefined ? { lastTurnEndedAt: s.lastTurnEndedAt } : {}),
      ...(s.lastTurnPromptTokens !== undefined ? { lastTurnPromptTokens: s.lastTurnPromptTokens } : {}),
      updatedAt: Date.now(),
    });
    // Bounded: one row per SDK session ever seen would grow for the life of the install.
    if (this.knownContext.size > MAX_KNOWN_CONTEXT_ROWS) {
      const oldest = [...this.knownContext.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
      for (const [id] of oldest.slice(0, this.knownContext.size - MAX_KNOWN_CONTEXT_ROWS)) this.knownContext.delete(id);
    }
    const file = this.knownContextFile();
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(Object.fromEntries(this.knownContext)), "utf8");
    } catch {
      // Best-effort, like every registry write: the in-memory copy still serves this process.
    }
  }

  private reaped: Promise<void> | undefined;

  /**
   * Stop what a dead predecessor left running, once, before this process spawns a
   * seat of its own: the orphan may be resuming the very transcript this process
   * is about to open. Never throws and never delays a start by more than the
   * reaper's own grace period; a failure is a notice, not a failed start.
   */
  private reapOrphansOnce(): Promise<void> {
    this.reaped ??= (async () => {
      const reap = this.options.reapOrphans === false ? undefined : this.options.reapOrphans ?? (this.options.queryFn ? undefined : () => reapOrphanSeats());
      if (!reap) return;
      try {
        const res = await reap();
        if (res.found.length === 0) return;
        this.noticeOnce("orphan_seats_reaped", {
          agentId: "mesh",
          kind: "orphan_seats_reaped",
          message:
            `stopped ${res.stopped.length} seat process(es) left running by a mesh process that died (pid ${[...new Set(res.found.map((o) => o.hostPid))].join(", ")}): ` +
            `${res.found.map((o) => o.pid).join(", ")}` +
            (res.survivors.length > 0 ? `; ${res.survivors.join(", ")} could not be stopped and may still be writing to a seat transcript` : ""),
        });
      } catch {
        // A scan that fails must not stop a mission from starting.
      }
    })();
    return this.reaped;
  }

  async start(agent: AgentDefinition, context: RuntimeContext): Promise<AgentSession> {
    // A valid UUID, because the SDK requires that shape for `sessionId` and we
    // want the mesh's own session id to BE the Claude session id — that is what
    // makes restoreSession a plain `resume` rather than a lookup table.
    const sdkSessionId = randomUUID();
    await this.reapOrphansOnce();
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
      await this.reapOrphansOnce();
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
   *
   * The one field the shared fold does not know, the usage guard's report, is
   * read off the `turn_end` frame on its way through and put back on.
   */
  async send(session: AgentSession, input: AgentInput): Promise<ClaudeAgentOutput> {
    let usageGuard: ClaudeUsageGuard | undefined;
    const tap = async function* (events: AsyncIterable<AgentEvent>): AsyncGenerator<AgentEvent, void> {
      for await (const ev of events) {
        if (ev.kind === "turn_end") usageGuard = (ev as ClaudeTurnEnd).usageGuard;
        yield ev;
      }
    };
    const out = await collectAgentOutput(tap(this.stream(session, input)), input);
    return usageGuard ? { ...out, usageGuard } : out;
  }

  /**
   * Live frames for one turn, retried on a fresh spawn when the seat's mesh MCP
   * bridge was not up at `init` (see `BRIDGE_RESPAWN_ATTEMPTS`).
   *
   * The retry is a retry of the TURN, not of the push. A bridge that is down at
   * init is a startup race — the child had not finished bringing the bridge up
   * when this query started — and the status the CLI reports is fixed for the
   * life of the query, so only a fresh spawn can re-read it. Each attempt is
   * therefore an ordinary turn on a new query: same session, same input, same
   * armed deadlines, settling or throwing exactly as it always did. A failed
   * attempt yields no frames (the bridge fails it at `init`, before the model
   * has produced anything), so a retry is invisible to whoever reads the
   * stream, and its cost is a spawn rather than a turn.
   *
   * Everything else — a backend that died, a turn that timed out, a push the
   * mesh itself aborted — is thrown as it was, un-retried.
   */
  async *stream(session: AgentSession, input: AgentInput): AsyncGenerator<AgentEvent, void> {
    // A new turn: whatever stop was requested while this seat had no query was
    // for a turn that is over.
    this.stoppedMidRetry.delete(session.sessionId);
    const retry: BridgeRespawnState = {};
    const delays = this.options.bridgeRespawnDelaysMs ?? BRIDGE_RESPAWN_DELAYS_MS;
    for (let respawns = 0; ; respawns++) {
      retry.bridge = false;
      try {
        yield* this.attemptTurn(session, input, respawns, retry);
        if (respawns > 0) this.noticeBridgeRace(session, respawns, retry.status, false);
        return;
      } catch (err) {
        if (!retry.bridge || !retry.live) throw err;
        const wait = delays[respawns];
        if (wait === undefined) {
          // Budget spent: the seat really is without a bridge, so this — not a
          // transient retry — is the moment the mute alarm means something.
          this.noticeBridgeRace(session, respawns, retry.status, true);
          this.reportMuteIfBridgeMissing(retry.live);
          throw err;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, wait));
        // A stop that landed in that window has to win: this turn is over, and
        // the replacement would run with nobody reading it.
        if (this.stoppedMidRetry.delete(session.sessionId)) {
          throw new InterruptedTurnError(
            "turn interrupted by the mesh between bridge respawns",
            undefined,
            retry.live.lastModel,
          );
        }
        this.respawnForBridge(retry.live);
      }
    }
  }

  /**
   * One attempt at a turn, on whatever query the session currently holds.
   *
   * An async generator, so the setup below (session lookup, context rotation)
   * runs on first pull rather than at call time and `send` stays a one-liner.
   * The pump feeds `turn.events`; `settle` closes it however the turn ends, so
   * this loop always terminates.
   */
  private async *attemptTurn(
    session: AgentSession,
    input: AgentInput,
    respawns: number,
    retry: BridgeRespawnState,
  ): AsyncGenerator<AgentEvent, void> {
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
    const rotateAt = this.thresholdFor(s);
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
    // Where a bridge respawn and the mute alarm read the session from: the one
    // whose `init` frame reported the bridge, which after a rotation is the
    // replacement rather than the session this call started with.
    retry.live = live;

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
    // The evidence this turn's FIRST call is judged against, read once — from
    // the session the turn will run on, so a rotation above leaves nothing to
    // inherit. Undefined (the session's first turn, a fresh session, a gap past
    // the operator's window) means a zero-cache first call is billed as
    // reported, which is the behaviour every turn had before this evidence
    // existed.
    const firstCallPrev = previousTurnPrefix(
      { promptTokens: live.lastTurnPromptTokens, endedAt: live.lastTurnEndedAt },
      this.options.staleAfterMs ?? SESSION_CACHE_STALE_MS,
      Date.now(),
    );
    const turn: TurnState = {
      events: new PushQueue<AgentEvent>(),
      toolSeq: 0,
      settled: false,
      sawFrame: false,
      maxPromptTokens: 0,
      modelCalls: 0,
      callUsage: new Map(),
      usageSum: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
      reattributedCalls: 0,
      reattributedTokens: 0,
      reattributedFirstCalls: 0,
      advice: [],
      meshCalls: 0,
      endReminded: false,
      ...(firstCallPrev !== undefined ? { firstCallPrevPrompt: firstCallPrev } : {}),
      ...(respawns > 0 ? { bridgeRespawns: respawns } : {}),
      settle: (outcome) => {
        if (turn.settled) return;
        turn.settled = true;
        clearTimeout(timer);
        clearTimeout(firstFrame);
        clearTimeout(turn.abortGrace);
        turn.advice.length = 0;
        live.pending = undefined;
        if (outcome.ok) {
          const end = this.toTurnEnd(outcome.msg, live, turn);
          live.turns++;
          // The largest prompt a single call was handed, which is the context
          // this session is carrying — what the rotation threshold is named for
          // and, before this, never measured. Estimated from the summed figure
          // only when NO frame reported usage: an absence, not an empty
          // context, and the estimate over-states, so an unmeasurable backend
          // rotates early rather than overflowing a window.
          live.contextTokens = turn.maxPromptTokens || this.unmeasuredContext(live, end.tokensUsed, turn.modelCalls);
          // When this session last finished a turn, for the staleness branch of
          // the rotation check. Read on the NEXT turn, like `contextTokens`.
          live.lastTurnEndedAt = Date.now();
          // The final prompt of this turn, for the usage guard's turn-boundary
          // evidence. A measurement or nothing: a turn whose calls reported no
          // usage records no evidence rather than a zero the guard would read as
          // a small context. Written here and nowhere else, so a turn that died
          // leaves the previous turn's record standing — a failed turn is not a
          // turn boundary the guard should judge a cold cache across.
          const finalPrompt = lastCallPrompt(turn);
          live.lastTurnPromptTokens = finalPrompt > 0 ? finalPrompt : undefined;
          this.rememberContext(live);
          this.statuses.set(session.agentId, "IDLE");
          turn.events.push(end);
        } else {
          // A measurement is a measurement however the turn ended. The success
          // branch owns the ASSIGNMENT because it alone has the summed `result`
          // usage to fall back on; a failed turn has no fallback, so take the
          // frames it did get and never lower the figure.
          //
          // Without this, the seat most in need of rotation — one whose turns
          // keep timing out — was the one seat whose `contextTokens` never moved,
          // so the next turn's boundary check read a stale small number, dec‍lined
          // to rotate, and timed out again. Measured 2026-09-24: a 302,667-token
          // turn died on the timeout and left the measurement at whatever the
          // last SUCCESSFUL turn had recorded.
          //
          // `lastTurnEndedAt` is deliberately NOT set here: a turn that died did
          // not end a turn cleanly, and the staleness latch measures a cache gap
          // between healthy turns.
          //
          // With `message_delta` now read, a timed-out turn behind the proxy
          // reports its calls too. When even that is absent, a failure that
          // carries the backend's usage (an abort's `result` frame) is estimated
          // like a success; one that carries nothing leaves the figure alone.
          const carried = (outcome.err as { tokensUsed?: AgentOutput["tokensUsed"] } | undefined)?.tokensUsed;
          const seen = turn.maxPromptTokens || (carried ? this.unmeasuredContext(live, carried, turn.modelCalls) : 0);
          if (seen > live.contextTokens) {
            live.contextTokens = seen;
            this.rememberContext(live);
          }
          // Surfaced by `stream` after the queue drains, so frames already
          // emitted this turn are not swallowed by the failure.
          turn.failure = outcome.err;
          this.statuses.set(session.agentId, "UNREACHABLE");
        }
        turn.events.close();
      },
    };
    const timer = setTimeout(() => {
      // A backstop, not the deadline: the supervisor owns that, extensions
      // included, and stops the turn itself, so this fires only when it failed
      // to. Armed at base + 30s, it pre-empted every extension the supervisor
      // grants a working turn — the one the live run needed: a seat ~94 native
      // Write/Edit/Bash calls in, last frame 17s old, killed at the 1,200,000ms
      // base. And it settled a bare Error the instant it fired: not a timeout to
      // `isTimeoutError`, so the crash ladder, and the abort's `result` frame —
      // the only usage figure the turn would ever have — arrived after `settle`
      // had cleared `pending` and was dropped unbilled.
      //
      // Now: marked BEFORE asking, like `interrupt`, so the answer cannot slip
      // past the pump's check; the answer settles the turn as a timeout
      // carrying its usage; and only an unanswered abort settles without it.
      turn.interrupted = true;
      turn.timedOut = true;
      void live.q.interrupt().catch(() => undefined);
      this.abandonIfUnanswered(live, turn, () => new TurnTimeoutError(this.turnTimeoutMs, liveUsage(turn), live.lastModel, `${BACKSTOP_NOTE}; the backend never answered the abort`));
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
    // Not unref'd, for the same reason as `confirmAlive`'s grace: the turn is
    // awaiting `turn.events`, and for a backend that answers with total silence
    // this timer is what ends it. It is cleared when the turn settles.
    live.pending = turn;
    if (live.bridgeDown) {
      // The init frame already said this query's bridge is down (it can land
      // before the first push). Same fail-fast as the pump's, and flagged the
      // same way, so a bridge the child has not finished bringing up is retried
      // on a fresh spawn rather than read as a permanently mute seat.
      turn.bridgeDown = true;
      turn.settle({ ok: false, err: new Error(live.bridgeDown) });
      this.teardown(live.meshSessionId);
    } else {
      live.inbox.push({
        type: "user",
        message: { role: "user", content: input.instructions },
        parent_tool_use_id: null,
      } as SDKUserMessage);
    }

    for await (const ev of turn.events) yield ev;
    if (turn.failure) {
      // A bridge that is down at init is normally a startup race and worth a
      // fresh spawn — but not when the mesh itself ended this turn (a stop, an
      // `endTurn`, the adapter's backstop): that turn is over, and the respawn
      // would run work nobody is waiting for.
      if (turn.bridgeDown && !turn.interrupted && !turn.endRequested) {
        retry.bridge = true;
        retry.status = bridgeStatusLabel(live.mcpStatus);
      }
      throw turn.failure;
    }
  }

  private toTurnEnd(result: ResultMessage, s: LiveSession, turn: TurnState): ClaudeTurnEnd {
    // Drained, not copied: the set is session-lived, so the next turn has to
    // start empty or a tool held once would be re-reported on every turn after
    // -- including turns where the seat never reached for it.
    const held = [...s.heldTools];
    s.heldTools.clear();
    const text = result.result ?? "";
    const error = result.is_error ? turnFailureReason(result) : undefined;
    // Billed as the live figure was (`noteCallUsage`), so the two still agree;
    // what the backend actually reported rides along whenever they differ.
    const raw = usageToTokens(result.usage);
    // A turn the mesh ended itself (a handover's `endTurn`) was answered by an abort frame: see `abortedUsage`.
    const tokensUsed = turn.endRequested ? abortedUsage(turn, result.usage) : settledUsage(turn, result.usage);
    const usageGuard: ClaudeUsageGuard | undefined =
      turn.reattributedCalls > 0
        ? {
            adjustedCalls: turn.reattributedCalls,
            reattributedTokens: turn.reattributedTokens,
            // Only when a turn-FIRST call was among them, so a report that has
            // nothing to say about the turn boundary keeps the shape it always
            // had: the protocol type reads `adjustedCalls` and the totals, and
            // an absent field is how a reader tells "none" from "not measured".
            ...(turn.reattributedFirstCalls > 0 ? { firstCallAdjustments: turn.reattributedFirstCalls } : {}),
            raw,
            adjusted: tokensUsed,
          }
        : undefined;
    // No ops ride on the result: a seat issues every mesh op as a typed
    // mesh_* MCP call, which the supervisor executes on the live turn as it
    // arrives (and which captures `done`'s summary as the declared one). A
    // mesh-json block in the reply is just prose now. `summary` is the
    // plain-text fallback for a turn that declared none.
    return {
      kind: "turn_end",
      stopReason: result.is_error ? "error" : "end_turn",
      text,
      operations: [],
      typedOps: true,
      tokensUsed,
      model: s.lastModel ?? s.configuredModel,
      modelVersion: s.lastModel,
      summary: extractSummary(text),
      ...(error !== undefined ? { error } : {}),
      ...(held.length ? { heldTools: held } : {}),
      ...(usageGuard ? { usageGuard } : {}),
      // Only when there was one, so "the bridge was up at init" stays an
      // absence rather than a zero a reader has to interpret.
      ...(turn.bridgeRespawns ? { bridgeRespawns: turn.bridgeRespawns } : {}),
    };
  }

  async interrupt(session: AgentSession): Promise<void> {
    const s = this.live.get(session.sessionId);
    if (!s || s.closed) {
      // Nothing to abort — except between the attempts of a bridge retry, where
      // the seat has no query only because the last one was torn down and a
      // fresh spawn is already scheduled. Remember it: a turn the mesh has
      // stopped must not be resurrected by that respawn, which nobody would be
      // reading and whose ops would still land.
      this.stoppedMidRetry.add(session.sessionId);
      return;
    }
    // Mark before asking, so a result frame already in flight cannot slip past
    // the pump's interrupted check.
    const turn = s.pending;
    if (turn) {
      turn.interrupted = true;
      // Bounded here, not only by the backstop. The supervisor stops waiting on
      // an unanswered interrupt after its own grace, but this turn stayed
      // pending until the backstop fired — which used to be 30s later and is
      // now past the whole extension ceiling, up to 2x the base timeout. Every
      // turn the supervisor retried in that window died on "turn already in
      // flight", an untyped Error, i.e. a crash.
      this.abandonIfUnanswered(s, turn, () => new InterruptedTurnError("turn interrupted by the mesh; the backend never answered the abort", liveUsage(turn), s.lastModel));
    }
    await s.q.interrupt().catch(() => undefined);
  }

  /**
   * Queue a note for the turn in flight; the tool-boundary hook delivers it
   * (see `adviceHooks`). False when nothing is running, or the turn is already
   * being stopped: it will not reach another tool boundary worth warning at.
   */
  advise(session: AgentSession, text: string): boolean {
    const s = this.live.get(session.sessionId);
    const turn = s && !s.closed ? s.pending : undefined;
    if (!turn || turn.settled || turn.interrupted || turn.endRequested) return false;
    turn.advice.push(text);
    return true;
  }

  /**
   * Give the CLI `ABORT_ANSWER_GRACE_MS` to answer an abort, then settle the
   * turn with `err()` and tear the session down. A `result` that does arrive
   * settles the turn first (see the pump), which clears this timer.
   */
  private abandonIfUnanswered(live: LiveSession, turn: TurnState, err: () => unknown): void {
    if (turn.settled || turn.abortGrace) return;
    turn.abortGrace = setTimeout(() => {
      if (turn.settled) return;
      turn.settle({ ok: false, err: err() });
      if (this.live.get(live.meshSessionId) === live) this.teardown(live.meshSessionId);
    }, ABORT_ANSWER_GRACE_MS);
  }

  /**
   * End the turn in flight as COMPLETE. The supervisor calls this when a
   * handover's `write_continuity` lands: the record is the whole of that turn,
   * and letting the model go on to call `done` and write a reply re-sends the
   * outgoing session's full transcript for nothing.
   *
   * An abort, answered by the CLI with an error `result` exactly as `interrupt`
   * is — which is why the flag differs: the pump settles an `endRequested` turn
   * as a success, with the usage that frame carries, rather than as an
   * interrupted failure the supervisor would count against the seat.
   */
  async endTurn(session: AgentSession): Promise<void> {
    const s = this.live.get(session.sessionId);
    if (!s || s.closed || !s.pending) return;
    s.pending.endRequested = true;
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
        // Same exclusion as a seat, for the same reason: the permission gate
        // does not adjudicate native Task/Agent calls.
        disallowedTools: mergedDisallowedTools(this.options.extraOptions),
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
   * Stand up the replacement query a bridge retry runs on.
   *
   * The identity is the session's, not the query's: the mesh-facing id stays
   * (the supervisor's handle must keep resolving), and the SDK id is kept too
   * whenever the query being replaced was itself a resume — its transcript is
   * on disk and the CLI has just loaded it, so the replacement re-reads it and
   * the seat keeps everything it remembers. A query that was NOT a resume owns
   * no transcript worth keeping (and may not be on disk at all, which is why
   * re-resuming it would be a gamble), so its replacement gets a new id and
   * starts clean. Both arms spawn: that is the whole point, since the CLI reads
   * the bridge's status once, as the query starts.
   *
   * `teardown` has already dropped the old query by the time this runs — the
   * caller is the failure path — so `open` sees a free mesh id and builds a
   * fresh session rather than handing the dead one back.
   */
  private respawnForBridge(s: LiveSession): LiveSession {
    // The failure paths tear the old query down before throwing, so this only
    // guarantees what they already did: without it, `open` would find the dead
    // session still under the mesh id and hand it straight back.
    if (this.live.get(s.meshSessionId) === s) this.teardown(s.meshSessionId);
    const keep = s.wasResumed;
    return this.open(s.agent, s.context, keep ? s.sdkSessionId : randomUUID(), keep, s.meshSessionId);
  }

  /**
   * One audit line for a turn that had to wait for the bridge, so an operator
   * can tell a startup race from a seat that is genuinely mute.
   *
   * Once per seat session, like every other notice here: a bridge that is late
   * once is late once, and re-reporting it on each of the retries would bury
   * the fact that it did come up.
   */
  private noticeBridgeRace(session: AgentSession, respawns: number, status: string | undefined, gaveUp: boolean): void {
    this.noticeOnce(`bridge_respawn:${session.sessionId}`, {
      agentId: session.agentId,
      kind: "mesh_bridge_race",
      message:
        `${session.agentId}: the mesh MCP bridge was not up at init (${status ?? "unknown"}); the turn waited ` +
        `${respawns} fresh spawn(s) and ${gaveUp ? "was aborted" : "then continued"} — a child still wiring ` +
        `its bridge up, not necessarily a mute seat`,
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
   *
   * `cacheCold` reports that same latch: a session idle past the cache
   * lifetime would re-read its whole transcript at full price to write a
   * handover, so the supervisor skips that turn and rotates directly. It is
   * evaluated even when the size alone trips the threshold, because a large
   * cold transcript is exactly the costly case (two handovers, 611k, §1 of
   * NOTES-live-run-20260925-2040.md). `sessionId` is the SDK session the
   * rotation discards, which after a first rotation is not the mesh's id.
   */
  rotationPending(session: AgentSession): RotationPendingInfo | null {
    const s = this.live.get(session.sessionId);
    if (!s || s.closed) return null;
    const thresholdTokens = this.thresholdFor(s);
    const cacheCold = this.markStaleRotationDue(s);
    if (s.contextTokens < thresholdTokens && !cacheCold) return null;
    return { transcriptTokens: s.contextTokens, thresholdTokens, sessionId: s.sdkSessionId, cacheCold };
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
    // The backend does not change with the SDK session, so neither does
    // whether it reports per-call usage: warn once per seat session, not once
    // per rotation.
    fresh.unmeasurableReported = s.unmeasurableReported;
    fresh.reattributionReported = s.reattributionReported;
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
    // Deliberate: the mesh ordered this teardown (shutdown, reset, rotation), so the
    // error must not tell the operator the server may have crashed.
    s.pending?.settle({ ok: false, err: new BackendUnreachableError(`claude:${sessionId}`, "session torn down", { deliberate: true }) });
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
    // shared OUTPUT_VOICE_RULES that go out with every turn. `withReadingDiscipline`
    // rides along for the same reason: it is part of the prompt, so it is part
    // of what the human should find written down.
    fs.writeFileSync(path.join(dir, "ROLE.md"), withReadingDiscipline(withOutputVoice(context.rolePromptText)), "utf8");
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
    if (resuming) {
      // One transcript, one CLI. After a rotation the live session is keyed by
      // the MESH id while the registry names its SDK id, so restoring that SDK
      // id (after a failed turn) found nothing under its key and spawned a
      // second `--resume` beside the first, still open, on the same transcript.
      for (const [key, other] of [...this.live]) {
        if (key !== meshSessionId && other.sdkSessionId === sdkSessionId) this.teardown(key);
      }
    }

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
    const hookRef: { live?: LiveSession } = {};
    const options: Options = {
      cwd: context.workspacePath,
      // `custom` rather than the claude_code preset: a mesh seat is not a
      // general coding assistant, and inheriting the preset's workflow
      // instructions would compete with the role prompt for authority.
      //
      // The role prose is composed with the shared OUTPUT_VOICE_RULES rather
      // than passed through raw: this runtime builds the model's system prompt
      // itself, so without that the seat would answer under a different set of
      // output rules than the same seat on opencode. `withReadingDiscipline`
      // follows it for the opposite reason — it is NOT shared, and deliberately
      // so: it is here rather than in the role prompt because it is a property
      // of how this runtime's session accumulates a prompt (see its doc).
      systemPrompt: { type: "custom", prompt: withReadingDiscipline(withOutputVoice(context.rolePromptText)) },
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
        { cwd: context.workspacePath, productPath: context.productPath },
      ),
      // canUseTool is the authority; "default" is the mode that routes tool
      // calls through it instead of auto-allowing or hard-denying them.
      permissionMode: "default",
      // A seat has no channel to answer a permission prompt, so a tool that
      // raises one stalls the turn to its timeout instead of failing.
      //
      // `canUseTool` alone does NOT close this: its fail-closed default maps an
      // unmapped tool to a `deny(...)`, yet a seat's native Task/Agent call was
      // observed reaching the API and returning an API error rather than the
      // gate's message — so the gate never adjudicated it. Measured 2026-09-25:
      // most seats got a fast 400 (a subagent inherits the `opus` alias, which
      // resolved to a model the installed CLI refuses), but one seat issued two
      // calls in a single assistant message, both returned nothing for 15.5
      // minutes, and the turn died at the 20-minute timeout — 119,171 tokens and
      // the whole turn discarded, logged as `user-rejected` with no human present.
      //
      // Removing the tools from the model's context is what makes it fail fast.
      // Note the same failure was fixed once before on the opencode runtime, where
      // an unanswerable "ask" prompt stalled the slot to its timeout; this is that
      // shape reaching the Claude CLI's own tool. Set after `extraOptions` below
      // (see `mergedDisallowedTools`) so the escape hatch cannot undo it.
      // Feeds AgentInput.onToken, the live token tap the dashboard renders.
      includePartialMessages: true,
      ...(this.modelFor(agent) ? { model: this.modelFor(agent) } : {}),
      ...(this.options.executablePath ? { pathToClaudeCodeExecutable: this.options.executablePath } : {}),
      ...(resuming ? { resume: sdkSessionId } : { sessionId: sdkSessionId }),
      // See SEAT_EFFORT: pins the seat's reasoning depth to the mesh instead of
      // inheriting the operator's personal `effortLevel`. Before extraOptions,
      // so the escape hatch still wins.
      effort: SEAT_EFFORT,
      // Before `extraOptions`, so the escape hatch can still load settings on purpose.
      ...(this.options.isolateHost ? { settingSources: [] } : {}),
      ...this.options.extraOptions,
      // After `extraOptions`, and built FROM its `env`: the stamp a restarted mesh
      // finds this CLI by if this process dies and leaves it running.
      env: seatEnv(this.options.extraOptions?.env, process.pid, { isolate: this.options.isolateHost }),
      disallowedTools: mergedDisallowedTools(this.options.extraOptions),
      // `advise` delivery — the one thing a PostToolUse callback can still
      // change (its `additionalContext`). Reads the session through `hookRef`
      // because the session object is built below, from the query these
      // options create.
      hooks: mergedHooks(combineHooks(adviceHooks(() => hookRef.live?.pending), endOfTurnHooks(() => hookRef.live?.pending)), this.options.extraOptions),
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
      wasResumed: resuming,
      contextTokens: 0,
      turns: 0,
      rotations: 0,
      grantedTools,
      heldTools,
    };
    hookRef.live = s;
    // A resume reopens a transcript that is exactly as big as it was, and as
    // idle: start from its last measurement rather than from 0, which let a
    // seat resume onto 224k per call with no rotation pending (§12 of
    // NOTES-live-run-20260925-2040.md). A fresh session has no history to seed.
    const known = resuming ? this.recallContext(sdkSessionId) : undefined;
    if (known) {
      s.contextTokens = known.contextTokens;
      if (known.lastTurnEndedAt !== undefined) s.lastTurnEndedAt = known.lastTurnEndedAt;
      // Recalled only for a RESUME, and only as the guard's evidence, gated on
      // its own read by the staleness window: a respawn or a mesh restart on the
      // same transcript did not reset the context, so the prefix a next first
      // call re-sends may still be cached. A brand-new session (`resuming` false)
      // recalls nothing at all, which is what keeps a rotation's replacement
      // from inheriting the retired session's prompts.
      if (known.lastTurnPromptTokens !== undefined) s.lastTurnPromptTokens = known.lastTurnPromptTokens;
    }
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
      // Not unref'd: `start` awaits this race, and when the backend stays quiet
      // this timer is the only thing that can settle it. Unref'd, a process with
      // no other live handle exits with `start` pending. The `finally` below
      // clears it, so holding the loop costs nothing once the race is decided.
      timer = setTimeout(() => resolve(true), this.spawnFailureGraceMs);
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
          // A seat whose bridge is down cannot act at all, so fail the turn now
          // rather than let it bill a full turn that lands nothing. Torn down,
          // because the status is fixed for the life of the query. Flagged, so
          // `stream` retries it on a fresh spawn: a child that has not finished
          // bringing its bridge up is the common case at a restart, and it looks
          // exactly like a mute seat from here.
          s.bridgeDown = meshBridgeDownReason(msg.mcp_servers);
          if (s.bridgeDown && s.pending) {
            s.pending.bridgeDown = true;
            s.pending.settle({ ok: false, err: new Error(s.bridgeDown) });
            this.teardown(s.meshSessionId);
          } else if (!s.bridgeDown) {
            // The bridge is up, or still dialling (`pending`, which is not down
            // — see `meshBridgeDownReason`). A bridge that IS down does not
            // reach here at all: the alarm fires from `stream` when the retry
            // budget is spent, never per attempt, because a child still bringing
            // its bridge up is not a mute seat and an alarm that a transient
            // retry sends too is worth nothing.
            this.reportMuteIfBridgeMissing(s);
          }
        } else if (msg.type === "assistant") {
          const m = msg.message as { id?: string; model?: string; content?: unknown; usage?: ClaudeTurnUsage };
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
          //
          // The same frame feeds the live usage figure, keyed by the call's
          // message id so its several frames count once (`noteCallUsage`).
          if (s.pending) {
            const sub = Boolean((msg as { parent_tool_use_id?: string | null }).parent_tool_use_id);
            this.noteUsage(s, m.usage, sub ? undefined : (typeof m.id === "string" ? m.id : s.pending.callId));
          }
          const blocks = Array.isArray(m.content) ? m.content : [];
          for (const b of blocks as Array<Record<string, unknown>>) {
            if (b.type === "tool_use") {
              // Announced as it starts, not tallied at the end: an operator
              // watching a slow turn needs to see the call while it runs.
              const pending = s.pending;
              if (pending) {
                if (String(b.name ?? "").startsWith(MESH_TOOL_PREFIX)) pending.meshCalls++;
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
            // The failure text rides along because the digest cannot carry it:
            // a gate denial and a successful read both hash to an opaque id, so
            // before this a refused `Bash` looked, in every trace, like one that
            // ran. Only on failure, and clipped — a successful result is the
            // tool's payload (a whole file, for `Read`) and has no place here.
            const error = b.is_error === true ? toolResultText(b.content).trim().slice(0, TOOL_ERROR_MAX_CHARS) : "";
            s.pending.events.push({
              kind: "tool_call_update",
              toolCallId: String(id),
              status: b.is_error === true ? "failed" : "completed",
              resultDigest: shortDigest(JSON.stringify(b.content ?? "")),
              ...(error ? { error } : {}),
            });
          }
        } else if (msg.type === "stream_event") {
          // Live token tap, observability only — never fails the turn.
          const frame = msg as {
            parent_tool_use_id?: string | null;
            event?: {
              type?: string;
              delta?: { type?: string; text?: string };
              usage?: ClaudeTurnUsage;
              message?: { id?: string; usage?: ClaudeTurnUsage };
            };
          };
          const ev = frame.event;
          if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
            // The onToken fan-out now lives in `collectAgentOutput`, which
            // guards it; pushing a frame here cannot throw into the pump.
            s.pending?.events.push({ kind: "agent_message_chunk", delta: ev.delta.text });
          } else if (s.pending && !frame.parent_tool_use_id && (ev?.type === "message_start" || ev?.type === "message_delta")) {
            // The per-call usage, from the two frames that carry it on the wire.
            // Measured 2026-09-25 behind an OpenAI->Claude translating proxy:
            // `message_start` carried ZERO usage and only `message_delta` the
            // real figures, and the CLI builds its `assistant` frames from the
            // message_start copy — so reading `assistant` alone found nothing,
            // fell back to the turn's SUM, and overstated every context 4.5x-35x
            // (NOTES-live-run-20260925-2040.md §1). Anthropic's own API puts the
            // input terms on message_start; both are read, and the max over them
            // is the call's prompt, exactly as for `assistant` frames below.
            //
            // A subagent's frames (`parent_tool_use_id`) measure ITS context,
            // not this session's, and are skipped.
            if (ev.type === "message_start") {
              s.pending.modelCalls++;
              s.pending.callId = typeof ev.message?.id === "string" ? ev.message.id : `call-${s.pending.modelCalls}`;
            }
            this.noteUsage(s, ev.type === "message_start" ? ev.message?.usage : ev.usage, s.pending.callId ?? `call-${s.pending.modelCalls}`);
          }
        } else if (msg.type === "result") {
          const pending = s.pending;
          const result = msg as unknown as ResultMessage;
          if (pending?.endRequested) {
            // The mesh ended this turn because its work had landed (`endTurn`).
            // The CLI answers that abort with an error result, which is not the
            // turn's fault: settle it complete, keeping the usage it reports.
            pending.settle({
              ok: true,
              // The abort's own prose ("Request was aborted") is not a reply.
              msg: { ...result, is_error: false, subtype: "success", result: result.is_error ? "" : (result.result ?? ""), errors: undefined, terminal_reason: undefined },
            });
          } else if (pending?.timedOut && result.is_error) {
            // The adapter's backstop aborted this turn, and this is the CLI's
            // answer. A timeout, typed as one so `isTimeoutError` routes it to
            // "slow" rather than the crash ladder, carrying what the frame
            // reports — the frames' own figure if the abort's reads zero.
            pending.settle({ ok: false, err: new TurnTimeoutError(this.turnTimeoutMs, abortedUsage(pending, result.usage), s.lastModel, BACKSTOP_NOTE) });
            // Answered, so alive and between turns: same reasoning as below.
            this.statuses.set(agentId, "IDLE");
          } else if (pending?.interrupted && result.is_error) {
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
                abortedUsage(pending, result.usage),
                // What the backend REPORTED running; the configured id is no
                // stand-in (see the error's own doc: configured `sonnet`, ran
                // `deepseek-v4.1-flash`), so an unreported model stays unknown.
                s.lastModel,
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
    // No fallback: the human seat accepts only the secret the server minted,
    // so a bridge without it could never authenticate anyway.
    const token = mcp.headers?.["x-mesh-token"];
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
        "--staging",
        "--bus",
        bus,
        ...(turn ? ["--turn", turn] : []),
      ],
      // The token travels in the environment, never on argv: a command line is
      // readable by every local user through `ps`, and this one grants the
      // human seat.
      ...(token ? { env: { MESH_AGENT_TOKEN: token } } : {}),
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
    ];
    return {
      type: "stdio" as const,
      command: argv[0],
      args: argv.slice(1),
      // The token rides here and not on argv, where `ps` would show it to
      // every local user; `curule mcp` reads MESH_AGENT_TOKEN when --token is absent.
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
