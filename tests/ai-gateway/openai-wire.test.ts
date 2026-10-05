import { test } from "node:test";
import assert from "node:assert/strict";
import {
  OpenAiCompatibleProvider,
  classifyHttpFailure,
  type ModelEvent,
  type ModelResult,
} from "../../packages/llm/src/index";
import {
  WireError,
  chunk,
  completionBody,
  errorBody,
  finishReason,
  parseChatRequest,
  toolCallDelta,
  usageChunk,
  usageToWire,
  type WireLimits,
} from "../../packages/ai-gateway/src/index";
import { fakeServer, frame, sseHead, json, collect } from "../llm/fake-server";

const base = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ model: "balanced", messages: [{ role: "user", content: "hi" }], ...over });
const refused = (body: unknown, match: RegExp, extra?: { status?: number; type?: string; param?: string }) => {
  assert.throws(
    () => parseChatRequest(body),
    (err: unknown) => {
      assert.ok(err instanceof WireError, `a WireError, got ${String(err)}`);
      assert.match(err.message, match);
      assert.equal(err.status, extra?.status ?? 400);
      if (extra?.type) assert.equal(err.type, extra.type);
      if (extra?.param) assert.equal(err.param, extra.param);
      return true;
    },
  );
};

test("a plain request becomes a model request: the system messages are the system, the rest the conversation", () => {
  const p = parseChatRequest({
    model: " balanced ",
    stream: true,
    max_tokens: 500,
    temperature: 0.2,
    reasoning_effort: "high",
    messages: [
      { role: "system", content: "You are a seat." },
      { role: "developer", content: "Be brief." },
      { role: "user", content: "Write hello.txt." },
      { role: "assistant", content: "On it.", tool_calls: [{ id: "c1", type: "function", function: { name: "Write", arguments: '{"file_path":"hello.txt"}' } }] },
      { role: "tool", tool_call_id: "c1", content: "ok" },
    ],
    tools: [{ type: "function", function: { name: "Write", description: "Write a file", parameters: { type: "object", properties: { file_path: { type: "string" } } } } }],
  });
  assert.equal(p.model, "balanced");
  assert.equal(p.stream, true);
  assert.equal(p.maxOutputTokens, 500);
  assert.equal(p.request.system, "You are a seat.\n\nBe brief.");
  assert.equal(p.request.temperature, 0.2);
  assert.equal(p.request.effort, "high");
  assert.deepEqual(p.request.messages, [
    { role: "user", content: "Write hello.txt." },
    { role: "assistant", content: "On it.", toolCalls: [{ id: "c1", name: "Write", args: { file_path: "hello.txt" } }] },
    { role: "tool", toolCallId: "c1", name: "Write", content: "ok" },
  ]);
  assert.deepEqual(p.request.tools, [{ name: "Write", description: "Write a file", inputSchema: { type: "object", properties: { file_path: { type: "string" } } } }]);
});

test("a request that sets nothing optional sets nothing optional", () => {
  const p = parseChatRequest(base());
  assert.deepEqual(p, { model: "balanced", request: { messages: [{ role: "user", content: "hi" }] }, stream: false });
});

test("the model is required, and so are messages that say something", () => {
  refused(null, /must be a JSON object/);
  refused([], /must be a JSON object/);
  refused({ messages: [{ role: "user", content: "x" }] }, /model is required/, { param: "model" });
  refused(base({ model: "  " }), /model is required/);
  refused(base({ model: 5 }), /model is required/);
  refused(base({ messages: [] }), /messages must be a non-empty list/, { param: "messages" });
  refused(base({ messages: "hi" }), /messages must be a non-empty list/);
  refused(base({ messages: [{ role: "system", content: "only" }] }), /at least one message that is not a system message/);
  refused(base({ messages: ["hi"] }), /messages\[0\] must be an object/);
});

test("how many messages and tools a request may carry is bounded", () => {
  const limits: WireLimits = { maxMessages: 2, maxTools: 1, maxOutputTokens: 100 };
  const three = [1, 2, 3].map((n) => ({ role: "user", content: String(n) }));
  assert.throws(() => parseChatRequest(base({ messages: three }), limits), /messages has 3 entries; the limit is 2/);
  const tool = (name: string) => ({ type: "function", function: { name } });
  assert.throws(() => parseChatRequest(base({ tools: [tool("a"), tool("b")] }), limits), /tools has 2 entries; the limit is 1/);
  assert.throws(() => parseChatRequest(base({ max_tokens: 101 }), limits), /max_tokens must be a whole number from 1 to 100/);
  assert.doesNotThrow(() => parseChatRequest(base({ max_tokens: 100, tools: [tool("a")] }), limits));
});

test("system messages come first, and a system message after the conversation has begun is refused", () => {
  refused(base({ messages: [{ role: "user", content: "x" }, { role: "system", content: "late" }] }), /messages\[1\]: system messages must come first/, { param: "messages[1].role" });
});

test("content is text: a string, or the text parts of a list. An image or any other part is refused by name", () => {
  const parts = (content: unknown) => base({ messages: [{ role: "user", content }] });
  assert.equal(parseChatRequest(parts([{ type: "text", text: "a" }, { type: "text", text: "b" }])).request.messages[0]!.content, "ab");
  refused(parts([{ type: "image_url", image_url: { url: "http://x" } }]), /messages\[0\]\.content\[0\] is a 'image_url' part; only text content is supported/, { type: "unsupported_content" });
  refused(parts([{ type: "text" }]), /is a 'text' part/);
  refused(parts([7]), /is a 'number' part/);
  refused(parts({ type: "text", text: "x" }), /must be a string or a list of text parts/);
  assert.equal(parseChatRequest(parts(null)).request.messages[0]!.content, "");
});

test("roles that are not supported are refused", () => {
  refused(base({ messages: [{ role: "function", name: "f", content: "x" }] }), /role 'function' is not supported/);
  refused(base({ messages: [{ role: "robot", content: "x" }] }), /role 'robot' is not supported/);
  refused(base({ messages: [{ role: "assistant", content: "x", function_call: { name: "f" } }] }), /function_call is not supported; use tool_calls/);
});

test("an assistant message's tool calls are read: arguments as JSON text, as an object, empty, or not JSON at all", () => {
  const msg = (args: unknown) => base({ messages: [{ role: "user", content: "x" }, { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "Read", arguments: args } }] }] });
  const calls = (args: unknown) => (parseChatRequest(msg(args)).request.messages[1] as { toolCalls: Array<{ args: unknown; invalidArgs?: string }> }).toolCalls[0]!;
  assert.deepEqual(calls('{"a":1}').args, { a: 1 });
  assert.deepEqual(calls({ a: 2 }).args, { a: 2 });
  for (const nothing of ["", "   ", undefined]) {
    assert.deepEqual(calls(nothing).args, {});
    assert.equal(calls(nothing).invalidArgs, undefined, "no arguments is not arguments that were wrong");
  }
  const broken = calls('{"a":');
  assert.deepEqual(broken.args, {});
  assert.equal(broken.invalidArgs, '{"a":');
  assert.equal(calls("[1,2]").invalidArgs, "[1,2]", "JSON that is not an object is not arguments");
  assert.equal((parseChatRequest(msg("{}")).request.messages[1] as { content: string }).content, "", "no content with calls is empty text, not null");
});

test("a tool call needs an id and a name, and only function calls are supported", () => {
  const msg = (call: unknown) => base({ messages: [{ role: "user", content: "x" }, { role: "assistant", content: "", tool_calls: [call] }] });
  refused(msg({ type: "function", function: { name: "Read" } }), /tool_calls\[0\] needs an id and a function name/);
  refused(msg({ id: "c", type: "function", function: {} }), /needs an id and a function name/);
  refused(msg({ id: "c", type: "code_interpreter" }), /type 'code_interpreter' is not supported/, { type: "unsupported_content" });
  refused(msg("call"), /tool_calls\[0\] must be an object/);
  refused(base({ messages: [{ role: "user", content: "x" }, { role: "assistant", content: "", tool_calls: "c" }] }), /tool_calls must be a list/);
});

test("a tool message names the call it answers, and the tool's name comes from the call when the message omits it", () => {
  const history = (tool: Record<string, unknown>) =>
    base({
      messages: [
        { role: "user", content: "x" },
        { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "Grep", arguments: "{}" } }] },
        { role: "tool", ...tool },
      ],
    });
  assert.equal((parseChatRequest(history({ tool_call_id: "c1", content: "r" })).request.messages[2] as { name: string }).name, "Grep");
  assert.equal((parseChatRequest(history({ tool_call_id: "c1", name: "Explicit", content: "r" })).request.messages[2] as { name: string }).name, "Explicit");
  assert.equal((parseChatRequest(history({ tool_call_id: "unknown", content: "r" })).request.messages[2] as { name: string }).name, "tool");
  refused(history({ content: "r" }), /messages\[2\]\.tool_call_id is required/);
  refused(history({ tool_call_id: "", content: "r" }), /tool_call_id is required/);
});

test("tools are checked: function tools with a safe name and a schema object, no repeats", () => {
  const withTools = (tools: unknown) => base({ tools });
  refused(withTools("x"), /tools must be a list/);
  refused(withTools([{ type: "retrieval" }]), /tools\[0\] must be a function tool/);
  refused(withTools([{ type: "function" }]), /tools\[0\] must be a function tool/);
  refused(withTools([{ type: "function", function: { name: "has space" } }]), /name must be 1 to 64 letters, digits and \. _ -/);
  refused(withTools([{ type: "function", function: { name: "x".repeat(65) } }]), /name must be 1 to 64/);
  refused(withTools([{ type: "function", function: { name: "A", parameters: "no" } }]), /parameters must be a JSON Schema object/);
  refused(withTools([{ type: "function", function: { name: "A" } }, { type: "function", function: { name: "A" } }]), /'A' is used twice/);
  const p = parseChatRequest(withTools([{ function: { name: "mesh_send" } }]));
  assert.deepEqual(p.request.tools, [{ name: "mesh_send", description: "", inputSchema: { type: "object", properties: {} } }], "a tool without a type, a description or parameters is still a tool");
  assert.equal(parseChatRequest(withTools(null)).request.tools, undefined);
});

test("tool_choice: auto and none are honoured; anything that forces a tool is refused rather than ignored", () => {
  const tools = [{ type: "function", function: { name: "A" } }];
  assert.ok(parseChatRequest(base({ tools, tool_choice: "auto" })).request.tools);
  assert.ok(parseChatRequest(base({ tools, tool_choice: null })).request.tools);
  assert.equal(parseChatRequest(base({ tools, tool_choice: "none" })).request.tools, undefined, "none means the model is offered no tools");
  refused(base({ tools, tool_choice: "required" }), /tool_choice: only 'auto' and 'none' are supported/, { type: "unsupported_parameter" });
  refused(base({ tools, tool_choice: { type: "function", function: { name: "A" } } }), /tool_choice/);
});

test("the cap on the answer is a whole number in range, from either field, and the newer field wins", () => {
  assert.equal(parseChatRequest(base({ max_tokens: 7 })).maxOutputTokens, 7);
  assert.equal(parseChatRequest(base({ max_completion_tokens: 9 })).maxOutputTokens, 9);
  assert.equal(parseChatRequest(base({ max_tokens: 7, max_completion_tokens: 9 })).maxOutputTokens, 9);
  assert.equal(parseChatRequest(base({ max_tokens: null })).maxOutputTokens, undefined);
  for (const bad of [0, -1, 1.5, "10", 1_000_001, NaN]) refused(base({ max_tokens: bad }), /max_tokens must be a whole number from 1 to 1000000/, { param: "max_tokens" });
  refused(base({ max_completion_tokens: 0 }), /whole number/, { param: "max_completion_tokens" });
});

test("temperature is a number from 0 to 2, and stream a boolean", () => {
  assert.equal(parseChatRequest(base({ temperature: 0 })).request.temperature, 0);
  assert.equal(parseChatRequest(base({ temperature: 2 })).request.temperature, 2);
  for (const bad of [-0.1, 2.1, "0.5", NaN]) refused(base({ temperature: bad }), /temperature must be a number from 0 to 2/);
  refused(base({ stream: "yes" }), /stream must be true or false/);
  assert.equal(parseChatRequest(base({ stream: false })).stream, false);
});

test("reasoning effort maps to the three the port knows, and anything else is left out", () => {
  const effort = (v: unknown) => parseChatRequest(base({ reasoning_effort: v })).request.effort;
  assert.equal(effort("minimal"), "low");
  assert.equal(effort("low"), "low");
  assert.equal(effort("medium"), "medium");
  assert.equal(effort("high"), "high");
  assert.equal(effort("extreme"), undefined);
  assert.equal(effort(5), undefined);
});

test("what would change a call's meaning if it were ignored is refused by name, and what only tunes it is accepted", () => {
  refused(base({ n: 2 }), /n: only one choice per request is supported/, { type: "unsupported_parameter", param: "n" });
  refused(base({ logprobs: true }), /logprobs are not supported/);
  refused(base({ top_logprobs: 3 }), /logprobs are not supported/);
  refused(base({ functions: [] }), /legacy `functions` field is not supported/);
  refused(base({ function_call: "auto" }), /legacy `function_call` field is not supported/);
  refused(base({ response_format: { type: "json_object" } }), /response_format is not supported/);
  refused(base({ audio: { voice: "x" } }), /audio output is not supported/);
  refused(base({ modalities: ["text", "audio"] }), /only text output is supported/);
  refused(base({ prediction: { type: "content" } }), /predicted outputs are not supported/);
  refused(base({ web_search_options: {} }), /web search is not supported/);
  // The defaults of those fields, and the fields that only tune a call, are fine.
  const p = parseChatRequest(base({ n: 1, logprobs: false, top_logprobs: 0, response_format: { type: "text" }, modalities: ["text"], top_p: 0.9, user: "u", seed: 1, stop: ["x"], presence_penalty: 0, frequency_penalty: 0, stream_options: { include_usage: true }, metadata: { a: 1 }, store: false }));
  assert.equal(p.model, "balanced");
});

test("usage goes out as the native runtime's adapter reads it back: the same four numbers", async () => {
  const usage = { input: 1_200, output: 340, cacheRead: 8_000, cacheWrite: 500, reasoning: 90 };
  assert.deepEqual(usageToWire(usage), {
    prompt_tokens: 9_700,
    completion_tokens: 340,
    total_tokens: 10_040,
    prompt_tokens_details: { cached_tokens: 8_000, cache_write_tokens: 500 },
    completion_tokens_details: { reasoning_tokens: 90 },
  });
  assert.equal("completion_tokens_details" in usageToWire({ ...usage, reasoning: undefined }), false);
  // The proof is the reader: serve these frames and let the real adapter parse them.
  const server = await fakeServer((_req, res) => {
    sseHead(res);
    frame(res, chunk("c1", 1, "m", { role: "assistant", content: "" }));
    frame(res, chunk("c1", 1, "m", { content: "hi" }));
    frame(res, chunk("c1", 1, "m", {}, "stop"));
    frame(res, usageChunk("c1", 1, "m", usage));
    frame(res, "[DONE]");
    res.end();
  });
  try {
    const provider = new OpenAiCompatibleProvider({ baseUrl: `${server.url}/v1` });
    const events = await collect(provider.stream({ model: "m", messages: [{ role: "user", content: "x" }] }));
    const end = events.at(-1) as { kind: "end"; result: ModelResult };
    assert.deepEqual(end.result.usage, usage);
  } finally {
    await server.close();
  }
});

test("a tool call and its arguments go out in one frame that the adapter reads back, even when the arguments were not JSON", async () => {
  const server = await fakeServer((_req, res) => {
    sseHead(res);
    frame(res, chunk("c1", 1, "m", { tool_calls: [toolCallDelta({ id: "a", name: "Write", args: { file_path: "x", content: "y" } }, 0)] }));
    frame(res, chunk("c1", 1, "m", { tool_calls: [toolCallDelta({ id: "b", name: "Read", args: {}, invalidArgs: '{"path":' }, 1)] }));
    frame(res, chunk("c1", 1, "m", {}, "tool_calls"));
    frame(res, "[DONE]");
    res.end();
  });
  try {
    const provider = new OpenAiCompatibleProvider({ baseUrl: `${server.url}/v1` });
    const events = await collect(provider.stream({ model: "m", messages: [{ role: "user", content: "x" }] }));
    const calls = events.filter((e): e is Extract<ModelEvent, { kind: "tool_call" }> => e.kind === "tool_call").map((e) => e.call);
    assert.deepEqual(calls, [
      { id: "a", name: "Write", args: { file_path: "x", content: "y" } },
      { id: "b", name: "Read", args: {}, invalidArgs: '{"path":' },
    ]);
  } finally {
    await server.close();
  }
});

test("a stop reason becomes the finish reason a client expects", () => {
  assert.equal(finishReason("end_turn"), "stop");
  assert.equal(finishReason("tool_use"), "tool_calls");
  assert.equal(finishReason("max_tokens"), "length");
  assert.equal(finishReason("content_filter"), "content_filter");
  assert.equal(finishReason("other"), "stop");
});

test("a whole answer has the text or, with tool calls and no text, null content; and its usage", () => {
  const result: ModelResult = { text: "hello", toolCalls: [], stopReason: "end_turn", usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0 }, model: "m-1" };
  const plain = completionBody("chatcmpl-1", 5, "m-1", result) as any;
  assert.equal(plain.object, "chat.completion");
  assert.equal(plain.id, "chatcmpl-1");
  assert.equal(plain.created, 5);
  assert.equal(plain.model, "m-1");
  assert.deepEqual(plain.choices[0], { index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" });
  assert.equal(plain.usage.prompt_tokens, 4);
  const calling = completionBody("c", 5, "m", { ...result, text: "", toolCalls: [{ id: "t1", name: "Read", args: { p: 1 } }], stopReason: "tool_use" }) as any;
  assert.equal(calling.choices[0].message.content, null);
  assert.deepEqual(calling.choices[0].message.tool_calls, [{ id: "t1", type: "function", function: { name: "Read", arguments: '{"p":1}' } }]);
  assert.equal(calling.choices[0].finish_reason, "tool_calls");
  const both = completionBody("c", 5, "m", { ...result, toolCalls: [{ id: "t1", name: "Read", args: {} }], stopReason: "tool_use" }) as any;
  assert.equal(both.choices[0].message.content, "hello");
  const silent = completionBody("c", 5, "m", { ...result, text: "" }) as any;
  assert.equal(silent.choices[0].message.content, "", "an empty answer with no calls is empty text, not null: null means the model called tools");
});

test("an error body has the type and message, a string code over HTTP, and a numeric one inside a stream, where there is no status", () => {
  const e = new WireError(402, "insufficient_credits", "The balance is too low.", "model");
  assert.deepEqual(errorBody(e), { error: { message: "The balance is too low.", type: "insufficient_credits", code: "insufficient_credits", param: "model" } });
  assert.deepEqual(errorBody(e, true), { error: { message: "The balance is too low.", type: "insufficient_credits", code: 402, param: "model" } });
  assert.equal((errorBody(new WireError(400, "x", "m")) as any).error.param, null);
});

test("the error the gateway sends is classified by the native runtime's own adapter as the fault it is", async () => {
  // Over HTTP, by status and type; inside a stream, by the numeric code.
  const cases: Array<[WireError, string]> = [
    [new WireError(402, "insufficient_credits", "The balance is too low for this call."), "billing"],
    [new WireError(401, "invalid_api_key", "The API key is not valid."), "auth"],
    [new WireError(429, "rate_limit_exceeded", "Slow down."), "rate_limited"],
    [new WireError(503, "service_unavailable", "The model service is unavailable at the moment."), "unavailable"],
    [new WireError(400, "context_length_exceeded", "context length exceeded: the prompt is too long for this model."), "context_overflow"],
    [new WireError(400, "invalid_request_error", "The model rejected the request."), "invalid_request"],
  ];
  for (const [e, kind] of cases) {
    assert.equal(classifyHttpFailure(e.status, e.type, e.message), kind, `${e.type} over HTTP`);
    const server = await fakeServer((_req, res) => {
      sseHead(res);
      frame(res, errorBody(e, true));
      frame(res, "[DONE]");
      res.end();
    });
    try {
      const provider = new OpenAiCompatibleProvider({ baseUrl: `${server.url}/v1` });
      await assert.rejects(
        () => collect(provider.stream({ model: "m", messages: [{ role: "user", content: "x" }] })),
        (err: { kind?: string; status?: number }) => err.kind === kind && err.status === e.status,
        `${e.type} in a stream`,
      );
    } finally {
      await server.close();
    }
    const http = await fakeServer((_req, res) => json(res, e.status, errorBody(e)));
    try {
      const provider = new OpenAiCompatibleProvider({ baseUrl: `${http.url}/v1`, transport: { maxRetries: 0 } });
      await assert.rejects(
        () => collect(provider.stream({ model: "m", messages: [{ role: "user", content: "x" }] })),
        (err: { kind?: string }) => err.kind === kind,
        `${e.type} as a status`,
      );
    } finally {
      await http.close();
    }
  }
});
