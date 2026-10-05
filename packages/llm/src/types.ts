/**
 * The model port: one call to a language model, in a shape that belongs to Curule and to no vendor.
 *
 * Everything above this file (the agent loop, the gateway) speaks these types. Everything below it (one adapter per wire
 * format) translates to and from a provider's own JSON. A vendor never leaks upward: a message is `system | user |
 * assistant | tool`, a tool call is an id, a name and parsed arguments, and usage is four numbers.
 */

export type JsonObject = Record<string, unknown>;

/** A tool the model may call. `inputSchema` is a JSON Schema object describing the arguments. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonObject;
}

/** One call the model made, with its arguments parsed. */
export interface ToolCall {
  /** Unique within the conversation; the matching `tool` message names it. */
  id: string;
  name: string;
  /** `{}` when the model sent no arguments. */
  args: JsonObject;
  /**
   * The raw text of the arguments when the model sent something that was not a JSON object. The loop answers such a call
   * with an error that quotes it, so the model can correct itself, rather than running the tool with `{}`.
   */
  invalidArgs?: string;
}

export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError?: boolean };

export interface ModelRequest {
  model: string;
  /** Kept apart from `messages` because one wire format wants it at the top level and another wants it as a message. */
  system?: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** Cap on the answer. Required on the wire by some providers; adapters apply their own default when it is absent. */
  maxOutputTokens?: number;
  /** Sent only when set: some models reject the parameter outright. */
  temperature?: number;
  /** Reasoning effort, passed where the provider has a field for it and ignored where it does not. */
  effort?: "low" | "medium" | "high";
  /** Abort the call. The stream throws an error named `AbortError` and releases the connection. */
  signal?: AbortSignal;
  /** Ask the provider to cache the stable prefix, where it caches only on request. Ignored elsewhere. */
  cache?: boolean;
  /** Fields merged into the request body last, for a provider option this port does not name. */
  extraBody?: JsonObject;
}

/**
 * What a call cost, in the four quantities every provider bills, normalised so they never overlap:
 * `input + cacheRead + cacheWrite` is the whole prompt.
 */
export interface ModelUsage {
  /** Prompt tokens billed at the full input rate. */
  input: number;
  output: number;
  /** Prompt tokens served from the provider's cache, at the reduced rate. */
  cacheRead: number;
  /** Prompt tokens written to the provider's cache, at the write rate (zero where caching is automatic). */
  cacheWrite: number;
  /** The slice of `output` spent on reasoning, when the provider says. Already counted in `output`. */
  reasoning?: number;
  /** True when the provider reported no usage and the figures are an estimate (four characters to a token). */
  estimated?: boolean;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "content_filter" | "other";

export interface ModelResult {
  text: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  usage: ModelUsage;
  /** The model as the provider reports it, which may be a dated snapshot of the one asked for. */
  model: string;
}

export type ModelEvent =
  /** Assistant text as it arrives. */
  | { kind: "text"; delta: string }
  /** Reasoning text as it arrives. Never part of the transcript. */
  | { kind: "reasoning"; delta: string }
  /** A tool call whose arguments are complete. Emitted once per call, in the order the model made them. */
  | { kind: "tool_call"; call: ToolCall }
  /** The call is over. Exactly one `end` closes a stream that did not throw. */
  | { kind: "end"; result: ModelResult };

export interface LlmProvider {
  /** The wire format this adapter speaks, e.g. `openai-compatible`. */
  readonly kind: string;
  /** Where it sends calls, for error messages and the operator's log. */
  readonly endpoint: string;
  /**
   * One model call, streamed.
   *
   * Throws {@link ProviderError} when the provider answered with a refusal or could not be reached,
   * {@link ProviderTimeoutError} when it went quiet, and an error named `AbortError` when `signal` fired.
   */
  stream(request: ModelRequest): AsyncGenerator<ModelEvent, void>;
  /** The model ids the endpoint says it serves, when it has a listing. */
  listModels?(signal?: AbortSignal): Promise<string[]>;
}

/** Four characters to a token: the estimate used where a provider reports nothing. Deliberately blunt. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
