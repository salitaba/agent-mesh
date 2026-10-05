import {
  InterruptedTurnError,
  type AgentEvent,
  type AgentOutput,
} from "../../protocol/src/index";
import { NO_MESH_CALL_REMINDER, shortDigest } from "../../agent-runtime/src/index";
import { ProviderError, isAbortError, type ChatMessage, type LlmProvider, type ModelResult, type ToolCall, type ToolSpec } from "../../llm/src/index";

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
  /** Called when the prompt does not fit; may shrink `messages` in place and ask for another try. */
  onOverflow?(attempt: number): OverflowAction | Promise<OverflowAction>;
}

export interface LoopEnd {
  text: string;
  stopReason: "end_turn" | "ended_by_mesh" | "step_limit";
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
/** Times a reply cut off by the output cap is asked to continue. */
const MAX_CONTINUATIONS = 2;
const CONTINUE = "Your last reply was cut off by the output limit. Continue from where it stopped.";

export class TurnLoop {
  readonly tally: Tally = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: undefined, calls: 0 };
  /** What the last model call was handed: the size of the conversation. */
  lastPromptTokens = 0;
  meshCalls = 0;
  private reminded = false;
  private continuations = 0;
  private overflows = 0;
  /** The provider's name for the model, from its last answer. */
  reportedModel: string | undefined;
  /** The last non-empty text the model produced this turn. */
  lastText = "";

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
      const text = outcome.text.length > MAX_TOOL_RESULT_CHARS ? `${outcome.text.slice(0, MAX_TOOL_RESULT_CHARS)}\n[result cut at ${MAX_TOOL_RESULT_CHARS} characters]` : outcome.text;
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
    if (notes.length > 0 && results.length > 0) {
      const last = results[results.length - 1] as Extract<ChatMessage, { role: "tool" }>;
      last.content += `\n\n[notice from the mesh]\n${notes.join("\n\n")}`;
    }
    this.append(...results);
  }
}
