/**
 * The Anthropic Messages adapter: Claude models called directly with an API key.
 *
 * `POST {baseUrl}/v1/messages` with `stream: true`. Where the chat completions format is a loose convention, this one is
 * exact, so the adapter is mostly translation: Curule's flat message list becomes alternating user and assistant turns
 * made of typed content blocks, tool results ride in the user turn after the call that asked for them, and the answer
 * arrives as `message_start`, a run of content blocks, `message_delta` and `message_stop`.
 *
 * Prompt caching is explicit here, and a Curule seat is the case it was made for: a long, stable prefix (the role, the
 * tools, the transcript so far) re-sent on every call of a turn. With `cache` set, the adapter marks the end of the
 * system prompt, the end of the tool list and the end of the last message, which is three of the four breakpoints the API
 * allows, and reads what the provider reports back as `cacheRead` and `cacheWrite`.
 *
 * Extended thinking is not enabled, so there are no signed thinking blocks to carry between calls. A model that sends one
 * anyway has it surfaced as reasoning and left out of the transcript.
 */
import { ProviderError, classifyHttpFailure, describeErrorBody } from "./errors";
import { openResponse, resolveTransport, type ResolvedTransport, type TransportOptions } from "./transport";
import { parseSse } from "./sse";
import type { ChatMessage, JsonObject, LlmProvider, ModelEvent, ModelRequest, ModelResult, ModelUsage, StopReason, ToolCall } from "./types";

export interface AnthropicOptions {
  /** Defaults to `https://api.anthropic.com`. A gateway or proxy that speaks the same format works here. */
  baseUrl?: string;
  apiKey?: string;
  /** `x-api-key` (default) or `bearer`, for a gateway that wants an `Authorization` header instead. */
  authHeader?: "x-api-key" | "bearer";
  version?: string;
  headers?: Record<string, string>;
  /** The cap to send when the request names none. The API requires one. */
  defaultMaxOutputTokens?: number;
  name?: string;
  transport?: TransportOptions;
}

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_VERSION = "2023-06-01";
/** The most any current or older model accepts, so a request that names no cap is never refused for its size. */
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const EPHEMERAL = { type: "ephemeral" } as const;

const asObject = (v: unknown): JsonObject => (v && typeof v === "object" && !Array.isArray(v) ? (v as JsonObject) : {});
const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const asNumber = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export class AnthropicProvider implements LlmProvider {
  readonly kind = "anthropic";
  readonly endpoint: string;
  private readonly baseUrl: string;
  private readonly transport: ResolvedTransport;

  constructor(private readonly options: AnthropicOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.endpoint = options.name ?? hostOf(this.baseUrl);
    this.transport = resolveTransport(options.transport);
  }

  private headers(): Record<string, string> {
    const key = this.options.apiKey;
    return {
      "content-type": "application/json",
      accept: "text/event-stream, application/json",
      "anthropic-version": this.options.version ?? DEFAULT_VERSION,
      ...(key ? (this.options.authHeader === "bearer" ? { authorization: `Bearer ${key}` } : { "x-api-key": key }) : {}),
      ...this.options.headers,
    };
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const opened = await openResponse({
      endpoint: this.endpoint,
      url: `${this.baseUrl}/v1/models?limit=1000`,
      method: "GET",
      headers: this.headers(),
      signal,
      transport: this.transport,
    });
    try {
      const decoder = new TextDecoder();
      let text = "";
      for await (const c of opened.chunks) text += decoder.decode(c, { stream: true });
      const body = JSON.parse(text + decoder.decode()) as { data?: Array<{ id?: unknown }> };
      return (body.data ?? []).map((m) => asString(m.id)).filter((id): id is string => id !== undefined);
    } finally {
      opened.close();
    }
  }

  async *stream(request: ModelRequest): AsyncGenerator<ModelEvent, void> {
    const opened = await openResponse({
      endpoint: this.endpoint,
      url: `${this.baseUrl}/v1/messages`,
      headers: this.headers(),
      body: this.body(request),
      signal: request.signal,
      transport: this.transport,
    });
    try {
      const state = new MessageState(request.model);
      let stopped = false;
      for await (const message of parseSse(opened.chunks)) {
        if (message.event === "ping") continue;
        let data: JsonObject;
        try {
          data = asObject(JSON.parse(message.data));
        } catch {
          continue;
        }
        const type = asString(data.type) ?? message.event;
        if (type === "error") throw this.streamError(data.error);
        yield* state.event(type, data);
        if (type === "message_stop") {
          stopped = true;
          break;
        }
      }
      if (!stopped) throw new ProviderError(this.endpoint, { kind: "unreachable", detail: "the response ended before the model finished" });
      yield* state.end();
    } finally {
      opened.close();
    }
  }

  private body(request: ModelRequest): JsonObject {
    const system = request.system ? [{ type: "text", text: request.system, ...(request.cache ? { cache_control: EPHEMERAL } : {}) }] : undefined;
    const tools = (request.tools ?? []).map((t, i, all) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
      ...(request.cache && i === all.length - 1 ? { cache_control: EPHEMERAL } : {}),
    }));
    return {
      model: request.model,
      max_tokens: request.maxOutputTokens ?? this.options.defaultMaxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      ...(system ? { system } : {}),
      messages: toAnthropicMessages(request.messages, request.cache === true),
      ...(tools.length > 0 ? { tools } : {}),
      stream: true,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...request.extraBody,
    };
  }

  private streamError(raw: unknown): ProviderError {
    const { type, detail } = describeErrorBody(JSON.stringify({ error: asObject(raw) }));
    // An error event mid-stream carries no status. `overloaded_error` is the provider's 529.
    const status = type === "overloaded_error" ? 529 : type === "rate_limit_error" ? 429 : type === "authentication_error" ? 401 : type === "permission_error" ? 403 : undefined;
    return new ProviderError(this.endpoint, { kind: classifyHttpFailure(status ?? 500, type, detail), status, type, detail });
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Curule's messages as the API's alternating turns. A tool result is a block in a user turn, and the blocks that answer
 * one assistant turn's calls must share one user turn, tool results first. Consecutive user content therefore merges, and
 * an assistant message with nothing in it (the API refuses an empty text block) is dropped.
 */
export function toAnthropicMessages(messages: ChatMessage[], cache: boolean): JsonObject[] {
  const out: Array<{ role: "user" | "assistant"; content: JsonObject[] }> = [];
  const pushUser = (block: JsonObject): void => {
    const last = out[out.length - 1];
    if (last && last.role === "user") {
      // Results lead the turn: text after a result is the seat's own note, never before it.
      if (block.type === "tool_result") {
        const firstText = last.content.findIndex((b) => b.type !== "tool_result");
        last.content.splice(firstText === -1 ? last.content.length : firstText, 0, block);
      } else last.content.push(block);
    } else out.push({ role: "user", content: [block] });
  };
  for (const m of messages) {
    if (m.role === "user") {
      if (m.content !== "") pushUser({ type: "text", text: m.content });
    } else if (m.role === "tool") {
      pushUser({ type: "tool_result", tool_use_id: m.toolCallId, content: m.content, ...(m.isError ? { is_error: true } : {}) });
    } else {
      const content: JsonObject[] = [];
      if (m.content !== "") content.push({ type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.args });
      if (content.length > 0) out.push({ role: "assistant", content });
    }
  }
  if (cache) {
    const last = out[out.length - 1];
    const block = last?.content[last.content.length - 1];
    if (block) block.cache_control = EPHEMERAL;
  }
  return out;
}

/** Folds a message's events into its text, tool calls and usage. */
class MessageState {
  private model: string;
  private text = "";
  private stop: string | undefined;
  private usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  private blocks = new Map<number, { type: string; id: string; name: string; json: string; done: boolean }>();
  private calls: ToolCall[] = [];

  constructor(model: string) {
    this.model = model;
  }

  *event(type: string, data: JsonObject): Generator<ModelEvent, void> {
    switch (type) {
      case "message_start": {
        const message = asObject(data.message);
        this.model = asString(message.model) ?? this.model;
        this.readUsage(asObject(message.usage));
        break;
      }
      case "content_block_start": {
        const index = asNumber(data.index) ?? this.blocks.size;
        const block = asObject(data.content_block);
        const kind = asString(block.type) ?? "text";
        this.blocks.set(index, { type: kind, id: asString(block.id) ?? "", name: asString(block.name) ?? "", json: "", done: false });
        if (kind === "text" && asString(block.text)) {
          this.text += asString(block.text);
          yield { kind: "text", delta: asString(block.text) as string };
        }
        break;
      }
      case "content_block_delta": {
        const index = asNumber(data.index) ?? 0;
        const delta = asObject(data.delta);
        const dtype = asString(delta.type);
        if (dtype === "text_delta" && asString(delta.text)) {
          this.text += asString(delta.text);
          yield { kind: "text", delta: asString(delta.text) as string };
        } else if (dtype === "input_json_delta") {
          const block = this.blocks.get(index);
          if (block) block.json += asString(delta.partial_json) ?? "";
        } else if (dtype === "thinking_delta" && asString(delta.thinking)) {
          yield { kind: "reasoning", delta: asString(delta.thinking) as string };
        }
        break;
      }
      case "content_block_stop": {
        const block = this.blocks.get(asNumber(data.index) ?? -1);
        if (block?.type === "tool_use" && !block.done) {
          block.done = true;
          const call = toToolCall(block.id || `toolu_${this.calls.length + 1}`, block.name, block.json);
          this.calls.push(call);
          yield { kind: "tool_call", call };
        }
        break;
      }
      case "message_delta": {
        const delta = asObject(data.delta);
        this.stop = asString(delta.stop_reason) ?? this.stop;
        this.readUsage(asObject(data.usage));
        break;
      }
      default:
        break;
    }
  }

  /** `message_start` carries the prompt side and a first output count; `message_delta` carries the final output count. */
  private readUsage(u: JsonObject): void {
    const input = asNumber(u.input_tokens);
    const output = asNumber(u.output_tokens);
    const read = asNumber(u.cache_read_input_tokens);
    const write = asNumber(u.cache_creation_input_tokens);
    if (input !== undefined) this.usage.input = input;
    if (output !== undefined) this.usage.output = output;
    if (read !== undefined) this.usage.cacheRead = read;
    if (write !== undefined) this.usage.cacheWrite = write;
  }

  *end(): Generator<ModelEvent, void> {
    // A tool call cut off by the output cap never sees its stop event. It is reported, flagged, rather than lost.
    for (const block of this.blocks.values()) {
      if (block.type !== "tool_use" || block.done) continue;
      block.done = true;
      const call = toToolCall(block.id || `toolu_${this.calls.length + 1}`, block.name, block.json);
      if (call.invalidArgs === undefined) call.invalidArgs = block.json;
      this.calls.push(call);
      yield { kind: "tool_call", call };
    }
    const usage: ModelUsage = { ...this.usage };
    const result: ModelResult = {
      text: this.text,
      toolCalls: this.calls,
      stopReason: stopReasonOf(this.stop, this.calls.length > 0),
      usage,
      model: this.model,
    };
    yield { kind: "end", result };
  }
}

function toToolCall(id: string, name: string, json: string): ToolCall {
  const text = json.trim();
  if (text === "") return { id, name, args: {} };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { id, name, args: parsed as JsonObject };
  } catch {
    // A call cut off by the output cap leaves half an object; the loop reports it to the model.
  }
  return { id, name, args: {}, invalidArgs: json };
}

function stopReasonOf(stop: string | undefined, hasToolCalls: boolean): StopReason {
  if (stop === "tool_use" || hasToolCalls) return "tool_use";
  switch (stop) {
    case "end_turn":
    case "stop_sequence":
    case undefined:
      return "end_turn";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "content_filter";
    default:
      return "other";
  }
}
