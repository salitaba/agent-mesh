import {
  InterruptedTurnError,
  type AgentEvent,
  type AgentOutput,
} from "../../protocol/src/index";
import { NO_MESH_CALL_REMINDER, shortDigest } from "../../agent-runtime/src/index";
import { ProviderError, isAbortError, type ChatMessage, type LlmProvider, type ModelResult, type ToolCall, type ToolSpec } from "../../llm/src/index";
import { clearOldToolTraffic, estimateConversationTokens } from "./context-policy";

/**
 * The agent loop: ask the model, run the tools it asks for, give it the results, and stop when it stops.
 *
 * One `TurnLoop` is one turn of one seat (or one designer prompt). It owns nothing that outlives the turn: the
 * conversation it extends, the tools it may run and the way a tool is run are handed in, so the same loop serves a seat
 * with a worktree and a designer with a staging toolset.
 *
 * Three things a Curule seat needs that a generic loop does not:
 *
 * - A turn can be told to stop in two different ways. `interrupt` is the mesh giving up on it (a deadline, an operator):
 *   the turn ends as a failure that still reports what it spent. `endTurn` is the mesh saying the work is done (a
 *   continuity record landed): the turn ends as a success without paying for another call.
 * - Notes from the mesh (`advise`) reach the model at the next tool boundary, appended to the last tool result, because
 *   that is the only moment a conversation with tool results has room for one.
 * - A seat that ends a turn without having called a single mesh tool has said nothing the mesh can hear. It is told once, in
 *   the same turn, and gets one more round.
 */

/** What the runtime lends the loop to stop and steer it. */
export interface TurnControl {
  /** Fires when the mesh interrupts the turn. */
  signal: AbortSignal;
  /** True once the mesh ended the turn as complete. */
  endRequested(): boolean;
  /** Notes queued for the model, removed as they are read. */
  takeAdvice(): string[];
  /** Registers the way to cancel the model call in flight, so `endTurn` can; called with undefined when none is. */
  setCallAbort(abort: (() => void) | undefined): void;
}

export interface ToolOutcome {
  text: string;
  isError: boolean;
  /** The call went to the mesh bus. */
  mesh: boolean;
}

/** How the runtime answers a prompt that does not fit the model's window. */
export type OverflowAction = "retry" | "give-up";

export interface LoopParams {
  provider: LlmProvider;
  /** The model id sent to the provider. */
  model: string;
  /** What the operator configured and what a record should say; the provider's own spelling is reported beside it. */
  system: string;
  /** The conversation. The loop appends to it in place and reports each batch to `persist`. */
  messages: ChatMessage[];
  persist(added: ChatMessage[]): void;
  /**
   * Put the whole conversation back on disk, for the one case where the loop
   * edits messages that were already persisted (mid-turn tool clearing). A
   * restart must resume what the model was actually shown.
   */
  rewrite?(messages: ChatMessage[]): void;
  tools: ToolSpec[];
  run(call: ToolCall, signal: AbortSignal): Promise<ToolOutcome>;
  control: TurnControl;
  /** Model calls one turn may make. */
  maxSteps: number;
  maxOutputTokens?: number;
  temperature?: number;
  effort?: "low" | "medium" | "high";
  /** Ask the provider to cache the prefix, where it caches on request. */
  cache?: boolean;
  /** A seat that ends a turn without a mesh call is reminded once. A designer has no such duty. */
  requireMeshCall: boolean;
  /**
   * Billable tokens this turn may spend before it is ended cleanly. Absent or zero:
   * no ceiling.
   *
   * A per-call cap cannot bound a turn -- each call is admitted on its own -- and a
   * ledger hold is an estimate taken before the first call. This is the only place
   * the running total is known while the turn can still be stopped.
   */
  maxTurnTokens?: number;
  /** Fraction of `maxTurnTokens` at which the seat is told, once, to wrap up. */
  warnAtRatio?: number;
  /** The hardest a single tool result may be, in characters. */
  maxToolResultChars?: number;
  /** Prompt size at which old tool traffic is cleared within the turn; absent or 0: never. */
  clearToolResultsAt?: number;
  /** Tool-use rounds kept whole when clearing mid-turn. */
  keepToolUses?: number;
  /** Minimum tokens one mid-turn clear must free to be worth the cache invalidation. */
  clearAtLeastTokens?: number;
  /** Called when the prompt does not fit; may shrink `messages` in place and ask for another try. */
  onOverflow?(attempt: number): OverflowAction | Promise<OverflowAction>;
}

export interface LoopEnd {
  text: string;
  stopReason: "end_turn" | "ended_by_mesh" | "step_limit" | "token_ceiling";
  /** The provider's name for the model, from its last answer. */
  reportedModel: string | undefined;
}

export interface Tally {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number | undefined;
  calls: number;
}

/** Longest tool result kept in the conversation. The tools bound themselves; this is the backstop against one that does not. */
export const MAX_TOOL_RESULT_CHARS = 120_000;
/** A result smaller than this is not worth the placeholder that would replace it during a mid-turn clear. */
const CLEAR_MIN_CHARS = 500;
/** Times a reply cut off by the output cap is asked to continue. */
const MAX_CONTINUATIONS = 2;
const CONTINUE = "Your last reply was cut off by the output limit. Continue from where it stopped.";

export class TurnLoop {
  readonly tally: Tally = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: undefined, calls: 0 };
  /** What the last model call was handed: the size of the conversation. */
  lastPromptTokens = 0;
  meshCalls = 0;
  /** The seat called `mesh_done` and the mesh accepted it plainly: the turn is over. */
  private finished = false;
  private reminded = false;
  private continuations = 0;
  private overflows = 0;
  /** Set once the seat has been told to wrap up, so the note never repeats. */
  private warnedBudget = false;
  /** The provider's name for the model, from its last answer. */
  reportedModel: string | undefined;
  /** What the last non-empty text the model produced this turn. */
  lastText = "";
  /** Tool traffic replaced by handles mid-turn, so the runtime can say so. */
  readonly cleared = { results: 0, args: 0, tokens: 0 };

  constructor(private readonly p: LoopParams) {}

  /** The usage of every call that finished, in the shape the supervisor bills. */
  tokens(): AgentOutput["tokensUsed"] {
    const t = this.tally;
    return {
      input: t.input,
      output: t.output,
      total: t.input + t.output + t.cacheWrite,
      cacheRead: t.cacheRead,
      ...(t.reasoning !== undefined ? { thinking: t.reasoning } : {}),
    };
  }

  private interrupted(): InterruptedTurnError {
    return new InterruptedTurnError("turn interrupted by the mesh", this.tally.calls > 0 ? this.tokens() : undefined, this.reportedModel);
  }

  private append(...added: ChatMessage[]): void {
    this.p.messages.push(...added);
    this.p.persist(added);
  }

  async *run(): AsyncGenerator<AgentEvent, LoopEnd> {
    const { control } = this.p;
    for (let step = 0; step < this.p.maxSteps; step++) {
      if (control.signal.aborted) throw this.interrupted();
      if (control.endRequested()) return this.end("ended_by_mesh");
      if (step > 0 && this.overCeiling()) return this.ceilingEnd();
      this.clearOldTraffic();

      const result = yield* this.call();
      if (result === undefined) {
        // The call was cancelled by `endTurn`, or aborted by `interrupt`.
        if (control.signal.aborted) throw this.interrupted();
        return this.end("ended_by_mesh");
      }
      this.lastText = result.text !== "" ? result.text : this.lastText;
      if (result.text !== "" || result.toolCalls.length > 0) {
        this.append({ role: "assistant", content: result.text, ...(result.toolCalls.length > 0 ? { toolCalls: result.toolCalls } : {}) });
      }

      if (result.toolCalls.length > 0) {
        yield* this.runTools(result.toolCalls);
        // `mesh_done` is how a seat says its turn is over. When the mesh took it without a word to the contrary, another
        // call would only be the model saying goodbye, on a prompt the size of the whole conversation.
        if (this.finished) return this.end("end_turn");
        if (this.overCeiling()) return this.ceilingEnd();
        continue;
      }
      if (result.stopReason === "max_tokens" && this.continuations < MAX_CONTINUATIONS) {
        this.continuations++;
        this.append({ role: "user", content: CONTINUE });
        continue;
      }
      if (this.p.requireMeshCall && this.meshCalls === 0 && !this.reminded && !control.endRequested()) {
        this.reminded = true;
        this.append({ role: "user", content: NO_MESH_CALL_REMINDER });
        continue;
      }
      return this.end("end_turn");
    }
    return this.end("step_limit");
  }

  private end(stopReason: LoopEnd["stopReason"]): LoopEnd {
    return { text: this.lastText, stopReason, reportedModel: this.reportedModel };
  }

  /** What the turn has spent so far: the same figure the supervisor bills. */
  private spent(): number {
    const t = this.tally;
    return t.input + t.output + t.cacheWrite;
  }

  private overCeiling(): boolean {
    const max = this.p.maxTurnTokens;
    return max !== undefined && Number.isFinite(max) && max > 0 && this.spent() >= max;
  }

  /**
   * The in-turn lever: once the prompt has grown past the trigger, replace all
   * but the last few rounds of tool traffic with a handle.
   *
   * Runs before a model call, so the saving lands on the call that is about to
   * be made. It only fires when it frees enough to pay for the cache write the
   * edit invalidates (see `clearOldToolTraffic`), and it rewrites the
   * transcript because those messages are already on disk.
   */
  private clearOldTraffic(): void {
    const trigger = this.p.clearToolResultsAt;
    if (trigger === undefined || !Number.isFinite(trigger) || trigger <= 0) return;
    if (this.lastPromptTokens < trigger) return;
    const result = clearOldToolTraffic(this.p.messages, {
      keepToolUses: this.p.keepToolUses ?? 3,
      minChars: CLEAR_MIN_CHARS,
      clearAtLeastTokens: this.p.clearAtLeastTokens ?? 5_000,
    });
    if (result.estimateFreedTokens <= 0) return;
    this.cleared.results += result.clearedResults;
    this.cleared.args += result.clearedArgs;
    this.cleared.tokens += result.estimateFreedTokens;
    this.lastPromptTokens = estimateConversationTokens(this.p.messages);
    this.p.rewrite?.(this.p.messages);
  }

  /**
   * End the turn at its ceiling, having told the conversation why.
   *
   * A clean end, not a failure: the work lands where it is, the seat is re-activated
   * on the same conversation, and nothing escalates. The note stays in the
   * conversation so the next turn knows its predecessor was cut on purpose rather
   * than dying mid-thought.
   */
  private ceilingEnd(): LoopEnd {
    const spent = this.spent();
    const max = this.p.maxTurnTokens;
    this.append({
      role: "user",
      content:
        `The mesh ended this turn at its token ceiling (${formatTokens(spent)} of ${formatTokens(max ?? 0)}). ` +
        "Nothing was discarded: this conversation, your notes and the work you already landed are intact. " +
        "Continue on your next turn, starting from the brief.",
    });
    return this.end("token_ceiling");
  }

  /**
   * The one line a seat gets before it is stopped: spend is real, and a turn that
   * keeps reading is a turn that pays for the whole conversation once more.
   */
  private budgetNote(): string | undefined {
    const max = this.p.maxTurnTokens;
    if (this.warnedBudget || max === undefined || !Number.isFinite(max) || max <= 0) return undefined;
    const ratio = this.p.warnAtRatio ?? 0.75;
    const spent = this.spent();
    if (spent < max * ratio) return undefined;
    this.warnedBudget = true;
    return (
      `This turn has spent ${formatTokens(spent)} of its ${formatTokens(max)} token ceiling, and every further model call re-sends the whole conversation. ` +
      "Finish the thought you are on: land the one call that makes the work usable, write down anything the next turn would need, and end the turn."
    );
  }

  /** One model call, streamed. Undefined when it was cancelled before it finished. */
  private async *call(): AsyncGenerator<AgentEvent, ModelResult | undefined> {
    const { control, provider } = this.p;
    for (;;) {
      const cancel = new AbortController();
      control.setCallAbort(() => cancel.abort());
      const signal = AbortSignal.any([control.signal, cancel.signal]);
      try {
        for await (const ev of provider.stream({
          model: this.p.model,
          system: this.p.system,
          messages: this.p.messages,
          tools: this.p.tools,
          maxOutputTokens: this.p.maxOutputTokens,
          temperature: this.p.temperature,
          effort: this.p.effort,
          cache: this.p.cache,
          signal,
        })) {
          if (ev.kind === "text") yield { kind: "agent_message_chunk", delta: ev.delta };
          else if (ev.kind === "reasoning") yield { kind: "agent_thought_chunk", delta: ev.delta };
          else if (ev.kind === "end") {
            this.record(ev.result);
            yield { kind: "usage_update", tokensUsed: this.tokens() };
            return ev.result;
          }
        }
        if (signal.aborted) return undefined;
        throw new Error("the model stream ended without a result");
      } catch (err) {
        if (isAbortError(err)) return undefined;
        if (err instanceof ProviderError && err.kind === "context_overflow" && this.p.onOverflow) {
          const action = await this.p.onOverflow(this.overflows++);
          if (action === "retry") continue;
        }
        throw err;
      } finally {
        control.setCallAbort(undefined);
      }
    }
  }

  private record(r: ModelResult): void {
    const t = this.tally;
    t.input += r.usage.input;
    t.output += r.usage.output;
    t.cacheRead += r.usage.cacheRead;
    t.cacheWrite += r.usage.cacheWrite;
    if (r.usage.reasoning !== undefined) t.reasoning = (t.reasoning ?? 0) + r.usage.reasoning;
    t.calls++;
    this.lastPromptTokens = r.usage.input + r.usage.cacheRead + r.usage.cacheWrite;
    this.reportedModel = r.model;
  }

  private async *runTools(calls: ToolCall[]): AsyncGenerator<AgentEvent, void> {
    const { control } = this.p;
    const results: ChatMessage[] = [];
    for (const call of calls) {
      if (control.signal.aborted) {
        // The conversation must stay valid: every call is answered, even those that never ran.
        results.push({ role: "tool", toolCallId: call.id, name: call.name, content: "This call did not run: the turn was stopped first.", isError: true });
        continue;
      }
      yield { kind: "tool_call", toolCallId: call.id, name: call.name, args: call.invalidArgs !== undefined ? { invalid: call.invalidArgs.slice(0, 500) } : call.args };
      let outcome: ToolOutcome;
      if (call.invalidArgs !== undefined) {
        outcome = {
          text: `The arguments of ${call.name} were not a valid JSON object, so the call did not run. You sent: ${call.invalidArgs.slice(0, 300)}${call.invalidArgs.length > 300 ? "…" : ""}. Send the call again with its arguments as one JSON object.`,
          isError: true,
          mesh: call.name.startsWith("mesh_"),
        };
      } else {
        try {
          outcome = await this.p.run(call, control.signal);
        } catch (err) {
          outcome = { text: `${call.name} failed: ${(err as Error).message}`, isError: true, mesh: call.name.startsWith("mesh_") };
        }
      }
      if (outcome.mesh) this.meshCalls++;
      if (isCleanDone(call, outcome)) this.finished = true;
      const maxChars = this.p.maxToolResultChars ?? MAX_TOOL_RESULT_CHARS;
      const text = outcome.text.length > maxChars ? `${outcome.text.slice(0, maxChars)}\n[result cut at ${maxChars} characters]` : outcome.text;
      results.push({ role: "tool", toolCallId: call.id, name: call.name, content: text, ...(outcome.isError ? { isError: true } : {}) });
      yield {
        kind: "tool_call_update",
        toolCallId: call.id,
        status: outcome.isError ? "failed" : "completed",
        resultDigest: shortDigest(text),
        ...(outcome.isError ? { error: text.slice(0, 300) } : {}),
      };
    }
    const notes = control.takeAdvice();
    const budget = this.budgetNote();
    if (budget) notes.push(budget);
    if (notes.length > 0 && results.length > 0) {
      const last = results[results.length - 1] as Extract<ChatMessage, { role: "tool" }>;
      last.content += `\n\n[notice from the mesh]\n${notes.join("\n\n")}`;
    }
    this.append(...results);
  }
}

/**
 * A `mesh_done` the mesh accepted with nothing to add. A refusal (`ok: false`, or an answer that is not the bus's JSON at all), or an
 * acceptance that carries a note (a task kept claimed, say), is something the seat has to read, so it is not the end.
 */
/** A token figure a sentence can carry: `950`, `12k`, `5.7M`. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${Math.round(n / 100) / 10}k`;
  return `${Math.round(n / 100_000) / 10}M`;
}

function isCleanDone(call: ToolCall, outcome: ToolOutcome): boolean {
  if (call.name !== "mesh_done") return false;
  try {
    const body = JSON.parse(outcome.text) as Record<string, unknown>;
    return body.ok === true && body.note === undefined && body.error === undefined;
  } catch {
    return false;
  }
}
