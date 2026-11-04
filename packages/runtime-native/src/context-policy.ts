import type { ChatMessage } from "../../llm/src/index";

/**
 * What a seat's conversation is allowed to weigh, and what happens when it gets there.
 *
 * Every model call re-sends the whole conversation, so the price of a turn is
 * `context size x calls in the turn` and the context size is the one factor that
 * compounds. Measured on a live 10-seat mission (2026-10-23..11-03, 1,327 turns,
 * 110.3M billable tokens): the conversation sat at 400-570k tokens per seat because
 * rotation waited for 60% of a 1M window, and 18 turns of >=1M tokens -- 1.4% of
 * turns -- carried 31% of all spend. One backend turn re-sent a 563k conversation
 * 16 times: 5.69M fresh prompt tokens for 9.8k of output.
 *
 * Two levers, in order of effect:
 *
 * 1. A budget (`fitTokens`) the conversation is measured against, independent of the
 *    model's real window. A 1M window is a capability, not a target.
 * 2. Compaction before rotation: stale briefs and old tool traffic are what make a
 *    conversation heavy, and dropping them keeps the recent working set -- and the
 *    seat's continuity -- while bringing the prompt back under budget.
 *
 * The prompt cache is why this is done at the rotation point and not every turn:
 * editing a message re-writes every token after it, so a compaction is a cold read.
 * One cold read at the budget beats a cold read every turn, and it beats throwing
 * the conversation away when most of it is dead weight.
 */

export interface ContextPolicyOptions {
  /**
   * The conversation budget, in tokens. `0` or absent: the model's window at the
   * adapter's 60%, capped at `DEFAULT_FIT_TOKENS`.
   *
   * A seat's own `session.max_context_tokens` wins over this.
   */
  fitTokens?: number;
  /** Messages at the tail kept whole when compacting. */
  keepRecentMessages?: number;
  /** Tool results and tool-call arguments longer than this are elided when compacting. */
  elideAboveChars?: number;
  /** The hardest a single tool result may ever be, in characters. */
  maxToolResultChars?: number;
  /**
   * Billable tokens (fresh input + output + cache writes; cache reads excluded) one
   * turn may spend before it is ended cleanly. `0` disables the ceiling.
   *
   * This is the money guard the ledger cannot be: a hold is an estimate taken before
   * the turn, and nothing can truncate a model's spend mid-turn. Measured on the same
   * mission, a 5.70M-token turn was admitted against a 40,684 hold -- 140x under.
   */
  maxTurnTokens?: number;
  /** Fraction of `maxTurnTokens` at which the seat is told, once, to wrap up. */
  warnAtRatio?: number;
  /**
   * Fraction of the budget at which old tool traffic starts being cleared
   * **within** a turn. `0` disables it.
   *
   * Rotation and compaction only run between turns; a turn that reads a dozen
   * large files keeps all of them for every call it makes. This is the in-turn
   * lever: replace all but the last `keepToolUses` rounds with a handle, so the
   * next call in the same turn costs less. It invalidates the prompt cache from
   * the first cleared message, so it only fires when it frees at least
   * `clearAtLeastTokens`.
   */
  clearToolResultsAt?: number;
  /** Tool-use rounds kept whole when clearing mid-turn. */
  keepToolUses?: number;
  /** Minimum tokens one mid-turn clear must free to be worth the cache invalidation. */
  clearAtLeastTokens?: number;
}

export interface ResolvedContextPolicy {
  fitTokens: number;
  keepRecentMessages: number;
  elideAboveChars: number;
  maxToolResultChars: number;
  /** `Infinity` when the ceiling is off. */
  maxTurnTokens: number;
  warnAtRatio: number;
  /** Tokens at which old tool traffic is cleared mid-turn; `Infinity` when off. */
  clearToolResultsAt: number;
  keepToolUses: number;
  clearAtLeastTokens: number;
}

/**
 * The budget a conversation is measured against when nothing names one.
 *
 * 200k is ~3.5x the largest brief-plus-working-set an ordinary turn needs, and the
 * point past which recall per token stops paying in agent loops. A model with a
 * smaller window keeps its 60% (a 128k model still rotates at 76.8k).
 */
export const DEFAULT_FIT_TOKENS = 200_000;
/** The adapter's share of the window, for a mesh that names no budget. */
export const ROTATE_RATIO = 0.6;
export const DEFAULT_KEEP_RECENT_MESSAGES = 8;
/** Only content above this is worth the note that replaces it. */
export const DEFAULT_ELIDE_ABOVE_CHARS = 2_000;
/**
 * A tool result no model call should ever carry beyond this. The file tools bound
 * themselves (Read: 60k, Bash head+tail: 30k); this is the backstop for the bus
 * tools, whose payloads the runtime does not shape.
 */
export const DEFAULT_MAX_TOOL_RESULT_CHARS = 60_000;
/** Ten calls at a full budget: enough for any ordinary turn, short of a runaway. */
export const TURN_CEILING_PER_FIT = 10;
export const DEFAULT_WARN_AT_RATIO = 0.75;
/**
 * Mid-turn clearing defaults, in the shape Anthropic's context editing exposes:
 * start at 60% of the budget, keep the last three tool rounds, and only clear
 * when it frees at least 5,000 tokens (a clear invalidates the prompt cache
 * from the first cleared message, so a small one costs more than it saves).
 */
export const DEFAULT_CLEAR_TOOL_RESULTS_AT = 0.6;
export const DEFAULT_KEEP_TOOL_USES = 3;
export const DEFAULT_CLEAR_AT_LEAST_TOKENS = 5_000;
/**
 * A compaction must leave this much of the budget free, or the conversation is
 * rotated instead.
 *
 * Without headroom a compaction that lands just under the budget is due again on the
 * very next turn, and every compaction is a cold read: the saving would become a
 * cache miss per turn. A fifth of the budget is several turns of briefs and tool
 * traffic at any sane size.
 */
export const COMPACT_HEADROOM_RATIO = 0.8;
/**
 * How many messages one turn may make. It is a runaway guard, not the spend
 * guard: a turn's bill is bounded by `maxTurnTokens`, and a turn at a small
 * context can make many cheap calls without spending much. 40 was too tight —
 * on the first live run with this economy, two developer seats doing ordinary
 * implementation work were killed at exactly 40 calls with 145k and 101k
 * tokens spent, well under the ceiling.
 */
export const DEFAULT_MAX_STEPS = 120;

/** The first line of every turn brief. Used to find superseded ones after a restart. */
export const BRIEF_MARKER = "# Mesh Context (system-generated";

/** Roughly four characters to a token, the same ratio the provider adapters use to estimate. */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * What a conversation weighs, near enough to decide whether to compact it.
 *
 * The runtime's authoritative figure is the provider's `prompt_tokens` from the last
 * call; this is for the estimate after a compaction, and for a conversation restored
 * from disk before its first call. Tool-call arguments count: a `Write` body lives in
 * the conversation and is re-sent on every call long after the file was written.
 */
export function estimateConversationTokens(messages: readonly ChatMessage[], system = ""): number {
  let chars = system.length;
  for (const m of messages) {
    chars += m.role === "assistant" && m.toolCalls ? 0 : m.content.length;
    if (m.role === "assistant" && m.toolCalls) {
      chars += m.content.length;
      for (const c of m.toolCalls) {
        try {
          chars += JSON.stringify(c.args ?? {}).length;
        } catch {
          chars += 0;
        }
      }
    }
    chars += 8; // role/framing overhead per message
  }
  return Math.ceil(chars / 4);
}

export function isBriefMessage(m: ChatMessage): boolean {
  return m.role === "user" && m.content.startsWith(BRIEF_MARKER);
}

/**
 * Resolve the policy for one seat.
 *
 * `window` is the model's real window, used only when no budget is named. A seat's
 * `maxContextTokens` is a budget, so it is honoured whatever the window is -- that is
 * what makes a 1M-token model cost like a 200k one.
 */
export function resolveContextPolicy(
  options: ContextPolicyOptions | undefined,
  window: { tokens: number; known: boolean },
  seatBudget?: number,
): ResolvedContextPolicy {
  const named = seatBudget !== undefined && seatBudget > 0 ? seatBudget : options?.fitTokens;
  const fitTokens =
    named !== undefined && Number.isFinite(named) && named > 0
      ? Math.floor(named)
      : Math.min(Math.floor(window.tokens * ROTATE_RATIO), DEFAULT_FIT_TOKENS);
  const maxTurn = options?.maxTurnTokens;
  const maxTurnTokens =
    maxTurn === 0 ? Number.POSITIVE_INFINITY : maxTurn === undefined || maxTurn < 0 ? fitTokens * TURN_CEILING_PER_FIT : Math.floor(maxTurn);
  const warn = options?.warnAtRatio;
  const clearAt = options?.clearToolResultsAt;
  return {
    fitTokens,
    keepRecentMessages: positive(options?.keepRecentMessages, DEFAULT_KEEP_RECENT_MESSAGES),
    elideAboveChars: positive(options?.elideAboveChars, DEFAULT_ELIDE_ABOVE_CHARS),
    maxToolResultChars: positive(options?.maxToolResultChars, DEFAULT_MAX_TOOL_RESULT_CHARS),
    maxTurnTokens: Number.isFinite(maxTurnTokens) && maxTurnTokens > 0 ? maxTurnTokens : Infinity,
    warnAtRatio: warn !== undefined && Number.isFinite(warn) && warn > 0 && warn < 1 ? warn : DEFAULT_WARN_AT_RATIO,
    clearToolResultsAt:
      clearAt === 0
        ? Number.POSITIVE_INFINITY
        : Math.floor(fitTokens * (clearAt !== undefined && Number.isFinite(clearAt) && clearAt > 0 && clearAt < 1 ? clearAt : DEFAULT_CLEAR_TOOL_RESULTS_AT)),
    keepToolUses: positive(options?.keepToolUses, DEFAULT_KEEP_TOOL_USES),
    clearAtLeastTokens: positive(options?.clearAtLeastTokens, DEFAULT_CLEAR_AT_LEAST_TOKENS),
  };
}

function positive(n: number | undefined, fallback: number): number {
  return n !== undefined && Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export interface ClearTrafficResult {
  freedChars: number;
  clearedResults: number;
  clearedArgs: number;
  estimateFreedTokens: number;
}

/**
 * Replace all but the last `keepToolUses` rounds of tool traffic with a handle.
 *
 * The in-turn counterpart to `compactConversation`: rotation and compaction run
 * between turns, but a turn that reads twelve large files carries all twelve on
 * every call it makes. Anthropic's context editing exposes the same three knobs
 * (a token trigger, a number of tool uses to keep, and a minimum amount to free)
 * for the same reason: clearing re-writes every token after the first cleared
 * message, so a clear that frees less than the cache write costs is a loss.
 *
 * Structure is kept (a call keeps its answer), and the last `keepToolUses`
 * rounds are untouched, so the model still has the results it is working from.
 */
export function clearOldToolTraffic(
  messages: ChatMessage[],
  opts: { keepToolUses: number; minChars: number; clearAtLeastTokens: number },
): ClearTrafficResult {
  const none: ClearTrafficResult = { freedChars: 0, clearedResults: 0, clearedArgs: 0, estimateFreedTokens: 0 };
  // The first message of the kept window: everything before it is old traffic.
  // No early return for "fewer rounds than kept": the dry pass below already
  // answers that (nothing before the window to clear), and counting stops as
  // soon as the window opens, so `rounds` here is the keep count, not the total.
  let keepFrom = messages.length;
  let rounds = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "assistant" && m.toolCalls?.length) {
      rounds++;
      keepFrom = i;
      if (rounds >= opts.keepToolUses) break;
    }
  }
  const dry = sweep(messages, keepFrom, opts.minChars, false);
  if (Math.ceil(dry.freedChars / 4) < opts.clearAtLeastTokens) return none;
  const applied = sweep(messages, keepFrom, opts.minChars, true);
  return { ...applied, estimateFreedTokens: Math.ceil(applied.freedChars / 4) };
}

/** One pass over the old window, counting and (on the second pass) replacing. */
function sweep(messages: ChatMessage[], keepFrom: number, minChars: number, apply: boolean): Omit<ClearTrafficResult, "estimateFreedTokens"> {
  let freedChars = 0;
  let clearedResults = 0;
  let clearedArgs = 0;
  for (let i = 0; i < keepFrom; i++) {
    const m = messages[i]!;
    if (m.role === "tool" && m.content.length > minChars) {
      const note = `[cleared to fit the context: ${m.content.length} characters. The call ran; run it again if you need the result.]`;
      freedChars += m.content.length - note.length;
      clearedResults++;
      if (apply) messages[i] = { ...m, content: note };
      continue;
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      let changed = false;
      const calls = m.toolCalls.map((c) => {
        let size = 0;
        try {
          size = JSON.stringify(c.args ?? {}).length;
        } catch {
          size = 0;
        }
        if (size <= minChars) return c;
        changed = true;
        clearedArgs++;
        freedChars += size - 28;
        return { ...c, args: { cleared: true, characters: size } as Record<string, unknown> };
      });
      if (changed && apply) messages[i] = { ...m, toolCalls: calls };
    }
  }
  return { freedChars: Math.max(0, freedChars), clearedResults, clearedArgs };
}

export interface CompactionResult {
  /** Characters removed from the conversation. */
  freedChars: number;
  /** Superseded briefs dropped (the newest is always kept). */
  droppedBriefs: number;
  /** Tool results replaced by a note. */
  elidedResults: number;
  /** Tool-call arguments replaced by a digest. */
  elidedArgs: number;
  estimateBefore: number;
  estimateAfter: number;
}

/**
 * Make a conversation lighter without changing what it is about.
 *
 * Three kinds of content are dead weight in a long turn history:
 *
 * - **Superseded briefs.** Every turn appends the full mesh context (8-12k tokens).
 *   Only the newest is authoritative; the rest are re-sent on every model call
 *   forever. Measured on one 24-turn transcript: 189k of a 563k prompt (33%).
 * - **Old tool results.** The model has already read them and acted; the files and
 *   the log still hold the truth.
 * - **Old tool-call arguments.** A `Write` body or a long `mesh_artifact_publish`
 *   payload is replayed on every call though the artifact was published long ago.
 *   Another 23% of that same prompt.
 *
 * Structure is preserved: a tool call keeps an answer, an assistant message keeps its
 * calls, and the last `keepRecentMessages` messages are untouched. That is what makes
 * the result acceptable to every provider and safe to resume from.
 */
export interface CompactionOptions {
  /**
   * Drop every brief, not just the superseded ones.
   *
   * Set when the caller is about to append a fresh brief for the turn it is starting
   * (the supervisor does, every turn). The incoming brief supersedes all of them, and
   * keeping the previous one costs 8-12k tokens on every call of the turn.
   */
  dropAllBriefs?: boolean;
}

export function compactConversation(messages: ChatMessage[], policy: ResolvedContextPolicy, options: CompactionOptions = {}): CompactionResult {
  const before = estimateConversationTokens(messages);
  const cutoff = Math.max(0, messages.length - policy.keepRecentMessages);
  let lastBrief = -1;
  if (!options.dropAllBriefs) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (isBriefMessage(messages[i]!)) {
        lastBrief = i;
        break;
      }
    }
  }

  let freedChars = 0;
  let droppedBriefs = 0;
  let elidedResults = 0;
  let elidedArgs = 0;
  const kept: ChatMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    // A brief is never part of the working set: it is a snapshot of mesh state, and
    // the next turn's brief replaces it wholesale. This is checked before the recent
    // window for that reason -- a superseded brief is dead weight wherever it sits.
    if (isBriefMessage(m) && (options.dropAllBriefs === true || i !== lastBrief)) {
      droppedBriefs++;
      freedChars += m.content.length;
      continue;
    }
    if (i >= cutoff) {
      kept.push(m);
      continue;
    }
    if (m.role === "tool" && m.content.length > policy.elideAboveChars) {
      const note = `[earlier tool result elided from the context budget: ${m.content.length} characters. The call ran; re-read the file, re-run the command, or read the artifact if you need it again.]`;
      freedChars += m.content.length - note.length;
      elidedResults++;
      kept.push({ ...m, content: note });
      continue;
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      let changed = false;
      const calls = m.toolCalls.map((c) => {
        let size = 0;
        try {
          size = JSON.stringify(c.args ?? {}).length;
        } catch {
          size = 0;
        }
        if (size <= policy.elideAboveChars) return c;
        changed = true;
        elidedArgs++;
        freedChars += size - 24;
        return { ...c, args: { elided: true, characters: size } as Record<string, unknown> };
      });
      if (changed) {
        kept.push({ ...m, toolCalls: calls });
        continue;
      }
    }
    kept.push(m);
  }

  // A conversation that begins with an assistant or tool message is legal on some
  // wires and refused on others. One short user line keeps every provider happy and
  // costs a handful of tokens.
  if (kept.length > 0 && kept[0]!.role !== "user") {
    kept.unshift({ role: "user", content: "This session continues from here." });
  }

  messages.splice(0, messages.length, ...kept);
  return {
    freedChars,
    droppedBriefs,
    elidedResults,
    elidedArgs,
    estimateBefore: before,
    estimateAfter: estimateConversationTokens(messages),
  };
}
