/**
 * The OpenAI-compatible chat completions adapter.
 *
 * `POST {baseUrl}/chat/completions` with `stream: true` is the one wire format most model providers and nearly every
 * self-hosted server speak: OpenAI and Azure OpenAI, Google's compatibility endpoint, Groq, Together, Fireworks, DeepSeek,
 * Mistral, OpenRouter, Ollama, vLLM, llama.cpp. They agree on the shape and disagree on the margins, so most of this file
 * is the margins:
 *
 * - a tool call's `index` and `id` may be missing, repeated, or arrive in pieces;
 * - arguments may be a string, an object, or empty;
 * - usage may be absent, in a final chunk of its own, or spread across two different field names for cached tokens;
 * - reasoning text may sit in `reasoning_content` or `reasoning`;
 * - a server may refuse a parameter another one needs: `stream_options`, `max_tokens` against `max_completion_tokens`,
 *   `temperature`, `reasoning_effort`. A refusal that names the parameter is answered once, without it, and remembered.
 */
import { ProviderError, classifyHttpFailure, describeErrorBody } from "./errors";
import { openResponse, resolveTransport, type OpenedResponse, type ResolvedTransport, type TransportOptions } from "./transport";
import { parseSse } from "./sse";
import { estimateTokens } from "./types";
import type { ChatMessage, JsonObject, LlmProvider, ModelEvent, ModelRequest, ModelResult, ModelUsage, StopReason, ToolCall, ToolSpec } from "./types";

export interface OpenAiCompatibleOptions {
  /** Up to and including the version segment, e.g. `https://api.openai.com/v1`. */
  baseUrl: string;
  /** Sent as `Authorization: Bearer`. A local server may need none. */
  apiKey?: string;
  /** Extra headers on every call (an organisation id, an OpenRouter referer). */
  headers?: Record<string, string>;
  /** The field the output cap goes in. Newer OpenAI models want `max_completion_tokens`; most servers know `max_tokens`. */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  /** Ask for a usage chunk at the end of the stream. Dropped, and remembered, if the server rejects it. */
  streamUsage?: boolean;
  /** The body field reasoning effort goes in, or `false` to never send it. */
  effortField?: string | false;
  /** The cap to send when the request names none. */
  defaultMaxOutputTokens?: number;
  /** A name for error messages; defaults to the base URL's host. */
  name?: string;
  transport?: TransportOptions;
}

interface Fallbacks {
  streamUsage: boolean;
  maxTokensField: "max_tokens" | "max_completion_tokens";
  temperature: boolean;
  effort: boolean;
}

const asObject = (v: unknown): JsonObject => (v && typeof v === "object" && !Array.isArray(v) ? (v as JsonObject) : {});
const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const asNumber = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly kind = "openai-compatible";
  readonly endpoint: string;
  private readonly baseUrl: string;
  private readonly transport: ResolvedTransport;
  private readonly fallbacks: Fallbacks;

  constructor(private readonly options: OpenAiCompatibleOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.endpoint = options.name ?? hostOf(this.baseUrl);
    this.transport = resolveTransport(options.transport);
    this.fallbacks = {
      streamUsage: options.streamUsage !== false,
      maxTokensField: options.maxTokensField ?? "max_tokens",
      temperature: true,
      effort: options.effortField !== false,
    };
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: "text/event-stream, application/json",
      ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
      ...this.options.headers,
    };
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const opened = await openResponse({
      endpoint: this.endpoint,
      url: `${this.baseUrl}/models`,
      method: "GET",
      headers: this.headers(),
      signal,
      transport: this.transport,
    });
    try {
      const body = JSON.parse(await collectText(opened.chunks)) as { data?: Array<{ id?: unknown }> };
      return (body.data ?? []).map((m) => asString(m.id)).filter((id): id is string => id !== undefined);
    } finally {
      opened.close();
    }
  }

  async *stream(request: ModelRequest): AsyncGenerator<ModelEvent, void> {
    const opened = await this.open(request);
    try {
      const type = opened.response.headers.get("content-type") ?? "";
      const events = type.includes("application/json") ? this.fromCompletion(opened, request) : this.fromStream(opened, request);
      yield* events;
    } finally {
      opened.close();
    }
  }

  /** Open the call, answering a refused parameter once. Each refusal is remembered, so only the first call pays for it. */
  private async open(request: ModelRequest): Promise<OpenedResponse> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await openResponse({
          endpoint: this.endpoint,
          url: `${this.baseUrl}/chat/completions`,
          headers: this.headers(),
          body: this.body(request),
          signal: request.signal,
          transport: this.transport,
        });
      } catch (err) {
        if (!(err instanceof ProviderError) || err.kind !== "invalid_request" || attempt >= 3 || !this.dropRefused(err.detail)) throw err;
      }
    }
  }

  /** Stop sending the parameter the provider's refusal names. False when it names none we send. */
  private dropRefused(detail: string): boolean {
    const f = this.fallbacks;
    if (f.streamUsage && /stream_options|include_usage/i.test(detail)) return (f.streamUsage = false), true;
    if (f.maxTokensField === "max_tokens" && /max_completion_tokens/i.test(detail)) return (f.maxTokensField = "max_completion_tokens"), true;
    if (f.maxTokensField === "max_completion_tokens" && /max_tokens/i.test(detail) && !/max_completion_tokens/i.test(detail)) return (f.maxTokensField = "max_tokens"), true;
    if (f.temperature && /temperature/i.test(detail)) return (f.temperature = false), true;
    if (f.effort && /reasoning_effort|reasoning effort/i.test(detail)) return (f.effort = false), true;
    return false;
  }

  private body(request: ModelRequest): JsonObject {
    const f = this.fallbacks;
    const cap = request.maxOutputTokens ?? this.options.defaultMaxOutputTokens;
    const effortField = this.options.effortField === undefined ? "reasoning_effort" : this.options.effortField;
    return {
      model: request.model,
      messages: toOpenAiMessages(request.system, request.messages),
      ...(request.tools && request.tools.length > 0 ? { tools: request.tools.map(toWireTool) } : {}),
      stream: true,
      ...(f.streamUsage ? { stream_options: { include_usage: true } } : {}),
      ...(cap !== undefined ? { [f.maxTokensField]: cap } : {}),
      ...(request.temperature !== undefined && f.temperature ? { temperature: request.temperature } : {}),
      ...(request.effort !== undefined && f.effort && effortField ? { [effortField]: request.effort } : {}),
      ...request.extraBody,
    };
  }

  private async *fromStream(opened: OpenedResponse, request: ModelRequest): AsyncGenerator<ModelEvent, void> {
    const acc = new Accumulator(request);
    let finished = false;
    for await (const message of parseSse(opened.chunks)) {
      if (message.data === "[DONE]") {
        finished = true;
        break;
      }
      let chunk: JsonObject;
      try {
        chunk = asObject(JSON.parse(message.data));
      } catch {
        // A keep-alive or a banner a proxy added. A real chunk is always JSON.
        continue;
      }
      if (chunk.error !== undefined) throw this.streamError(chunk.error);
      yield* acc.chunk(chunk);
      if (acc.finishReason !== undefined) finished = true;
    }
    if (!finished) {
      throw new ProviderError(this.endpoint, { kind: "unreachable", detail: "the response ended before the model finished" });
    }
    yield* acc.end();
  }

  /** A server that ignored `stream: true` and answered with one JSON completion. */
  private async *fromCompletion(opened: OpenedResponse, request: ModelRequest): AsyncGenerator<ModelEvent, void> {
    const text = await collectText(opened.chunks);
    let body: JsonObject;
    try {
      body = asObject(JSON.parse(text));
    } catch {
      throw new ProviderError(this.endpoint, { kind: "other", detail: `the response was not JSON: ${text.slice(0, 120)}` });
    }
    if (body.error !== undefined) throw this.streamError(body.error);
    const acc = new Accumulator(request);
    const choice = asObject(Array.isArray(body.choices) ? body.choices[0] : undefined);
    const message = asObject(choice.message);
    yield* acc.chunk({
      model: body.model,
      choices: [{ delta: { content: message.content, reasoning_content: message.reasoning_content ?? message.reasoning, tool_calls: asToolCallsWithIndex(message.tool_calls) }, finish_reason: choice.finish_reason ?? "stop" }],
      usage: body.usage,
    });
    yield* acc.end();
  }

  private streamError(raw: unknown): ProviderError {
    const o = asObject(raw);
    const { type, detail } = describeErrorBody(JSON.stringify({ error: o }));
    const numeric = asNumber(o.code) ?? asNumber(Number(o.code));
    const status = numeric !== undefined && numeric >= 400 && numeric <= 599 ? numeric : undefined;
    return new ProviderError(this.endpoint, { kind: classifyHttpFailure(status ?? 500, type ?? asString(o.code), detail), status, type: type ?? asString(o.code), detail });
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function collectText(chunks: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = "";
  for await (const c of chunks) out += decoder.decode(c, { stream: true });
  return out + decoder.decode();
}

function asToolCallsWithIndex(raw: unknown): unknown[] | undefined {
  return Array.isArray(raw) ? raw.map((c, index) => ({ index, ...asObject(c) })) : undefined;
}

export function toWireTool(tool: ToolSpec): JsonObject {
  return { type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } };
}

export function toOpenAiMessages(system: string | undefined, messages: ChatMessage[]): JsonObject[] {
  const out: JsonObject[] = [];
  if (system !== undefined && system !== "") out.push({ role: "system", content: system });
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "tool") out.push({ role: "tool", tool_call_id: m.toolCallId, name: m.name, content: m.content });
    else {
      const calls = m.toolCalls ?? [];
      out.push({
        role: "assistant",
        content: calls.length > 0 && m.content === "" ? null : m.content,
        ...(calls.length > 0
          ? { tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.invalidArgs ?? JSON.stringify(c.args) } })) }
          : {}),
      });
    }
  }
  return out;
}

/** Folds a stream of chunks into the text, the tool calls and the usage of one answer. */
class Accumulator {
  text = "";
  finishReason: string | undefined;
  private model: string;
  private usage: JsonObject | undefined;
  private calls: Array<{ id: string; name: string; args: string }> = [];
  /** The latest call at each index the server sent, and the latest call of all (for a server that sends no indexes). */
  private byIndex = new Map<number, { id: string; name: string; args: string }>();
  private last: { id: string; name: string; args: string } | undefined;
  private outputChars = 0;

  constructor(private readonly request: ModelRequest) {
    this.model = request.model;
  }

  *chunk(chunk: JsonObject): Generator<ModelEvent, void> {
    const model = asString(chunk.model);
    if (model) this.model = model;
    if (chunk.usage && typeof chunk.usage === "object") this.usage = asObject(chunk.usage);
    const choice = asObject(Array.isArray(chunk.choices) ? chunk.choices[0] : undefined);
    const finish = asString(choice.finish_reason);
    if (finish) this.finishReason = finish;
    const delta = asObject(choice.delta);
    const content = asString(delta.content);
    if (content) {
      this.text += content;
      yield { kind: "text", delta: content };
    }
    const reasoning = asString(delta.reasoning_content) ?? asString(delta.reasoning);
    if (reasoning) {
      this.outputChars += reasoning.length;
      yield { kind: "reasoning", delta: reasoning };
    }
    if (Array.isArray(delta.tool_calls)) for (const raw of delta.tool_calls) this.toolDelta(asObject(raw));
  }

  /**
   * One fragment of a tool call. The common stream names an index on every fragment, an id and a name on the first, and
   * argument text on all. Servers differ: some send no index, some send a whole call in one fragment, and some reuse an
   * index for a second call. A fragment continues the call it points at unless it carries an id that is not that call's.
   */
  private toolDelta(raw: JsonObject): void {
    const fn = asObject(raw.function);
    const id = asString(raw.id) ?? "";
    const name = asString(fn.name) ?? "";
    const args = typeof fn.arguments === "string" ? fn.arguments : fn.arguments && typeof fn.arguments === "object" ? JSON.stringify(fn.arguments) : "";
    const index = asNumber(raw.index);
    let call = index !== undefined ? this.byIndex.get(index) : this.last;
    const another = id !== "" && call !== undefined && call.id !== "" && id !== call.id;
    const namedAgain = index === undefined && name !== "" && call !== undefined && call.name !== "";
    if (call === undefined || another || namedAgain) {
      call = { id: "", name: "", args: "" };
      this.calls.push(call);
      if (index !== undefined) this.byIndex.set(index, call);
    }
    this.last = call;
    if (id && !call.id) call.id = id;
    if (name && !call.name) call.name = name;
    call.args += args;
  }

  *end(): Generator<ModelEvent, void> {
    const toolCalls: ToolCall[] = [];
    const seen = new Set<string>();
    for (const [n, c] of this.calls.entries()) {
      let id = c.id || `call_${n + 1}`;
      while (seen.has(id)) id = `${id}_${n + 1}`;
      seen.add(id);
      const call = parseArguments(id, c.name, c.args);
      this.outputChars += c.name.length + c.args.length;
      toolCalls.push(call);
      yield { kind: "tool_call", call };
    }
    const result: ModelResult = {
      text: this.text,
      toolCalls,
      stopReason: stopReasonOf(this.finishReason, toolCalls.length > 0),
      usage: this.normalisedUsage(),
      model: this.model,
    };
    yield { kind: "end", result };
  }

  private normalisedUsage(): ModelUsage {
    const u = this.usage;
    if (!u || (asNumber(u.prompt_tokens) === undefined && asNumber(u.completion_tokens) === undefined)) {
      const prompt = estimateTokens(JSON.stringify(toOpenAiMessages(this.request.system, this.request.messages)) + JSON.stringify(this.request.tools ?? []));
      return { input: prompt, output: estimateTokens(this.text) + Math.ceil(this.outputChars / 4), cacheRead: 0, cacheWrite: 0, estimated: true };
    }
    const details = asObject(u.prompt_tokens_details);
    const completion = asObject(u.completion_tokens_details);
    const prompt = asNumber(u.prompt_tokens) ?? 0;
    // OpenAI reports cached tokens inside `prompt_tokens`; DeepSeek reports hit and miss tokens beside it.
    const cacheRead = asNumber(details.cached_tokens) ?? asNumber(u.prompt_cache_hit_tokens) ?? 0;
    const cacheWrite = asNumber(details.cache_write_tokens) ?? asNumber(details.cache_creation_tokens) ?? 0;
    const reasoning = asNumber(completion.reasoning_tokens);
    return {
      input: Math.max(0, prompt - cacheRead - cacheWrite),
      output: asNumber(u.completion_tokens) ?? 0,
      cacheRead,
      cacheWrite,
      ...(reasoning !== undefined ? { reasoning } : {}),
    };
  }
}

function parseArguments(id: string, name: string, raw: string): ToolCall {
  const text = raw.trim();
  if (text === "") return { id, name, args: {} };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { id, name, args: parsed as JsonObject };
  } catch {
    // Fall through: the model sent something that is not a JSON object.
  }
  return { id, name, args: {}, invalidArgs: raw };
}

function stopReasonOf(finish: string | undefined, hasToolCalls: boolean): StopReason {
  if (hasToolCalls) return "tool_use";
  switch (finish) {
    case "stop":
    case undefined:
      return "end_turn";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "content_filter";
    default:
      return "other";
  }
}

