/**
 * The tenant-facing wire format: OpenAI-compatible chat completions, in and out.
 *
 * It is the format the native runtime already speaks to any provider, so a workspace's agents talk to the gateway with the
 * same adapter they would use against a provider directly. Inside, a request becomes a `ModelRequest` and an answer a stream
 * of `ModelEvent`s, so every upstream is reached through the adapters in `@mesh/llm` and there is one translation to keep
 * right, not two.
 *
 * Parsing is strict about what would change the meaning of a call if it were ignored (a request for more than one choice,
 * an image, a forced tool) and lenient about what only tunes it (`top_p`, `user`, `seed`): an unsupported feature is a 400
 * that names it, never a call that quietly does something else.
 */
import { randomBytes } from "node:crypto";
import type { ChatMessage, JsonObject, ModelRequest, ModelResult, ModelUsage, StopReason, ToolCall, ToolSpec } from "../../llm/src/index";

/** A refusal, with the status, the error type a client can match on, and a message that says what to change. */
export class WireError extends Error {
  constructor(
    readonly status: number,
    readonly type: string,
    message: string,
    readonly param?: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "WireError";
  }
}

export interface WireLimits {
  maxMessages: number;
  maxTools: number;
  /** The largest cap on an answer a caller may ask for. */
  maxOutputTokens: number;
}

export const DEFAULT_WIRE_LIMITS: WireLimits = { maxMessages: 10_000, maxTools: 128, maxOutputTokens: 1_000_000 };

export interface ParsedChat {
  /** What the caller asked for: a tier such as `balanced`, or a `provider/model`. */
  model: string;
  request: Omit<ModelRequest, "model" | "signal">;
  stream: boolean;
  /** The caller's own cap on the answer, when it set one. */
  maxOutputTokens?: number;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function bad(message: string, param?: string, type = "invalid_request_error"): WireError {
  return new WireError(400, type, message, param);
}

/** Parameters whose meaning the gateway cannot honour. Each is refused by name when it asks for something other than the default. */
const UNSUPPORTED: Array<[string, (v: unknown) => boolean, string]> = [
  ["n", (v) => v !== 1, "only one choice per request is supported (n: 1)"],
  ["logprobs", (v) => v === true, "logprobs are not supported"],
  ["top_logprobs", (v) => v !== undefined && v !== null && v !== 0, "logprobs are not supported"],
  ["functions", (v) => v !== undefined && v !== null, "the legacy `functions` field is not supported; use `tools`"],
  ["function_call", (v) => v !== undefined && v !== null, "the legacy `function_call` field is not supported; use `tool_choice`"],
  ["response_format", (v) => isObject(v) && v.type !== undefined && v.type !== "text", "response_format is not supported"],
  ["audio", (v) => v !== undefined && v !== null, "audio output is not supported"],
  ["modalities", (v) => Array.isArray(v) && v.some((m) => m !== "text"), "only text output is supported"],
  ["prediction", (v) => v !== undefined && v !== null, "predicted outputs are not supported"],
  ["web_search_options", (v) => v !== undefined && v !== null, "web search is not supported"],
];

/** The text of a message's content: a string, or the text parts of an array. Anything else (an image, audio, a file) is refused. */
function contentText(raw: unknown, where: string): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((part, i) => {
        if (isObject(part) && part.type === "text" && typeof part.text === "string") return part.text;
        const kind = isObject(part) && typeof part.type === "string" ? part.type : typeof part;
        throw bad(`${where}[${i}] is a '${kind}' part; only text content is supported`, where, "unsupported_content");
      })
      .join("");
  }
  throw bad(`${where} must be a string or a list of text parts`, where);
}

function toolCallOf(raw: unknown, where: string): ToolCall {
  if (!isObject(raw)) throw bad(`${where} must be an object`, where);
  if (raw.type !== undefined && raw.type !== "function") throw bad(`${where}.type '${String(raw.type)}' is not supported; only function calls are`, where, "unsupported_content");
  const fn = isObject(raw.function) ? raw.function : undefined;
  const name = typeof fn?.name === "string" ? fn.name : "";
  const id = typeof raw.id === "string" ? raw.id : "";
  if (id === "" || name === "") throw bad(`${where} needs an id and a function name`, where);
  const args = fn?.arguments;
  if (isObject(args)) return { id, name, args };
  const text = typeof args === "string" ? args : "";
  if (text.trim() === "") return { id, name, args: {} };
  try {
    const parsed = JSON.parse(text) as unknown;
    if (isObject(parsed)) return { id, name, args: parsed };
  } catch {
    // Fall through: the arguments are not a JSON object, and the model is told so when it sees the call again.
  }
  return { id, name, args: {}, invalidArgs: text };
}

function toolCallsOf(raw: unknown, where: string): ToolCall[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw bad(`${where} must be a list`, where);
  return raw.map((c, i) => toolCallOf(c, `${where}[${i}]`));
}

function parseMessages(raw: unknown, limits: WireLimits): { system?: string; messages: ChatMessage[] } {
  if (!Array.isArray(raw) || raw.length === 0) throw bad("messages must be a non-empty list", "messages");
  if (raw.length > limits.maxMessages) throw bad(`messages has ${raw.length} entries; the limit is ${limits.maxMessages}`, "messages");
  const system: string[] = [];
  const messages: ChatMessage[] = [];
  const callNames = new Map<string, string>();
  raw.forEach((m, i) => {
    const where = `messages[${i}]`;
    if (!isObject(m)) throw bad(`${where} must be an object`, where);
    const role = m.role;
    if (role === "system" || role === "developer") {
      if (messages.length > 0) throw bad(`${where}: system messages must come first`, `${where}.role`);
      system.push(contentText(m.content, `${where}.content`));
    } else if (role === "user") {
      messages.push({ role: "user", content: contentText(m.content, `${where}.content`) });
    } else if (role === "assistant") {
      if (m.function_call !== undefined) throw bad(`${where}.function_call is not supported; use tool_calls`, `${where}.function_call`);
      const calls = toolCallsOf(m.tool_calls, `${where}.tool_calls`);
      for (const c of calls) callNames.set(c.id, c.name);
      messages.push({ role: "assistant", content: contentText(m.content, `${where}.content`), ...(calls.length > 0 ? { toolCalls: calls } : {}) });
    } else if (role === "tool") {
      if (typeof m.tool_call_id !== "string" || m.tool_call_id === "") throw bad(`${where}.tool_call_id is required`, `${where}.tool_call_id`);
      const name = typeof m.name === "string" && m.name !== "" ? m.name : (callNames.get(m.tool_call_id) ?? "tool");
      messages.push({ role: "tool", toolCallId: m.tool_call_id, name, content: contentText(m.content, `${where}.content`) });
    } else {
      throw bad(`${where}.role '${String(role)}' is not supported`, `${where}.role`);
    }
  });
  if (messages.length === 0) throw bad("messages needs at least one message that is not a system message", "messages");
  return { ...(system.length > 0 ? { system: system.join("\n\n") } : {}), messages };
}

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

function parseTools(raw: unknown, limits: WireLimits): ToolSpec[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw bad("tools must be a list", "tools");
  if (raw.length > limits.maxTools) throw bad(`tools has ${raw.length} entries; the limit is ${limits.maxTools}`, "tools");
  const seen = new Set<string>();
  return raw.map((t, i) => {
    const where = `tools[${i}]`;
    if (!isObject(t) || (t.type !== undefined && t.type !== "function") || !isObject(t.function)) throw bad(`${where} must be a function tool`, where);
    const fn = t.function;
    const name = fn.name;
    if (typeof name !== "string" || !TOOL_NAME.test(name)) throw bad(`${where}.function.name must be 1 to 64 letters, digits and . _ -`, `${where}.function.name`);
    if (seen.has(name)) throw bad(`${where}.function.name '${name}' is used twice`, `${where}.function.name`);
    seen.add(name);
    if (fn.parameters !== undefined && !isObject(fn.parameters)) throw bad(`${where}.function.parameters must be a JSON Schema object`, `${where}.function.parameters`);
    return {
      name,
      description: typeof fn.description === "string" ? fn.description : "",
      inputSchema: (fn.parameters as JsonObject | undefined) ?? { type: "object", properties: {} },
    };
  });
}

const EFFORTS: Record<string, "low" | "medium" | "high"> = { minimal: "low", low: "low", medium: "medium", high: "high" };

/** A chat completions body into the model port. Throws {@link WireError} (a 400) for anything it cannot honour. */
export function parseChatRequest(body: unknown, limits: WireLimits = DEFAULT_WIRE_LIMITS): ParsedChat {
  if (!isObject(body)) throw bad("the request body must be a JSON object");
  if (typeof body.model !== "string" || body.model.trim() === "") throw bad("model is required", "model");
  for (const [field, refused, why] of UNSUPPORTED) {
    if (body[field] !== undefined && refused(body[field])) throw bad(`${field}: ${why}`, field, "unsupported_parameter");
  }
  const { system, messages } = parseMessages(body.messages, limits);
  let tools = parseTools(body.tools, limits);

  const choice = body.tool_choice;
  if (choice === "none") tools = [];
  else if (choice !== undefined && choice !== null && choice !== "auto") throw bad("tool_choice: only 'auto' and 'none' are supported", "tool_choice", "unsupported_parameter");

  const cap = body.max_completion_tokens ?? body.max_tokens;
  let maxOutputTokens: number | undefined;
  if (cap !== undefined && cap !== null) {
    if (typeof cap !== "number" || !Number.isInteger(cap) || cap < 1 || cap > limits.maxOutputTokens) {
      throw bad(`max_tokens must be a whole number from 1 to ${limits.maxOutputTokens}`, body.max_completion_tokens !== undefined ? "max_completion_tokens" : "max_tokens");
    }
    maxOutputTokens = cap;
  }

  let temperature: number | undefined;
  if (body.temperature !== undefined && body.temperature !== null) {
    if (typeof body.temperature !== "number" || !Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2) throw bad("temperature must be a number from 0 to 2", "temperature");
    temperature = body.temperature;
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") throw bad("stream must be true or false", "stream");
  const effort = typeof body.reasoning_effort === "string" ? EFFORTS[body.reasoning_effort] : undefined;

  return {
    model: body.model.trim(),
    request: {
      ...(system !== undefined ? { system } : {}),
      messages,
      ...(tools.length > 0 ? { tools } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(effort !== undefined ? { effort } : {}),
    },
    stream: body.stream === true,
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  };
}

// ---- the answer ----

export function newRequestId(): string {
  return `req_${randomBytes(12).toString("hex")}`;
}

const FINISH: Record<StopReason, string> = { end_turn: "stop", tool_use: "tool_calls", max_tokens: "length", content_filter: "content_filter", other: "stop" };

export function finishReason(stop: StopReason): string {
  return FINISH[stop];
}

/**
 * Usage in the shape the native runtime's adapter reads back to the same four numbers: the prompt count holds the cached and
 * the cache-written tokens, and the details name them.
 */
export function usageToWire(u: ModelUsage): JsonObject {
  return {
    prompt_tokens: u.input + u.cacheRead + u.cacheWrite,
    completion_tokens: u.output,
    total_tokens: u.input + u.cacheRead + u.cacheWrite + u.output,
    prompt_tokens_details: { cached_tokens: u.cacheRead, cache_write_tokens: u.cacheWrite },
    ...(u.reasoning !== undefined ? { completion_tokens_details: { reasoning_tokens: u.reasoning } } : {}),
  };
}

/** A tool call as the wire carries it. Arguments the model sent that were not JSON go back as they came, so the caller sees what the model said. */
function wireToolCall(call: ToolCall): JsonObject {
  return { id: call.id, type: "function", function: { name: call.name, arguments: call.invalidArgs ?? JSON.stringify(call.args) } };
}

export function toolCallDelta(call: ToolCall, index: number): JsonObject {
  return { index, ...wireToolCall(call) };
}

export function chunk(id: string, created: number, model: string, delta: JsonObject, finish: string | null = null): JsonObject {
  return { id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] };
}

export function usageChunk(id: string, created: number, model: string, usage: ModelUsage): JsonObject {
  return { id, object: "chat.completion.chunk", created, model, choices: [], usage: usageToWire(usage) };
}

/** A whole answer, for a caller that did not ask for a stream. */
export function completionBody(id: string, created: number, model: string, result: ModelResult): JsonObject {
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: result.text === "" && result.toolCalls.length > 0 ? null : result.text,
          ...(result.toolCalls.length > 0 ? { tool_calls: result.toolCalls.map(wireToolCall) } : {}),
        },
        finish_reason: finishReason(result.stopReason),
      },
    ],
    usage: usageToWire(result.usage),
  };
}

/** The body of a refusal. `code` is numeric inside a stream, where there is no HTTP status to carry it. */
export function errorBody(e: WireError, inStream = false): JsonObject {
  return { error: { message: e.message, type: e.type, code: inStream ? e.status : e.type, param: e.param ?? null } };
}
