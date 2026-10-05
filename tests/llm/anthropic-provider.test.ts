import { test } from "node:test";
import assert from "node:assert/strict";
import { AnthropicProvider, ProviderError, toAnthropicMessages, type ModelEvent, type ModelRequest, type ModelResult } from "../../packages/llm/src/index";
import { classifyProviderOutage } from "../../packages/protocol/src/index";
import { FAST, collect, fakeServer, frame, json, sseHead, type FakeServer } from "./fake-server";

/** The Anthropic Messages adapter against a server that speaks its stream: message_start, blocks, message_delta, message_stop. */

const ASK: ModelRequest = { model: "claude-test", system: "You are a developer.", messages: [{ role: "user", content: "hi" }] };

const start = (usage: object = { input_tokens: 25, output_tokens: 1 }) =>
  ({ type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "claude-test-20260101", content: [], stop_reason: null, usage } });

const endOf = (events: ModelEvent[]): ModelResult => {
  const end = events.find((e): e is Extract<ModelEvent, { kind: "end" }> => e.kind === "end");
  assert.ok(end, "the stream ends with an end event");
  return end.result;
};

async function withServer<T>(handler: Parameters<typeof fakeServer>[0], run: (s: FakeServer) => Promise<T>): Promise<T> {
  const s = await fakeServer(handler);
  try {
    return await run(s);
  } finally {
    await s.close();
  }
}

const provider = (s: FakeServer, extra: object = {}) => new AnthropicProvider({ baseUrl: s.url, apiKey: "sk-ant-test", transport: FAST, ...extra });

/** A complete answer: text then (optionally) a tool call, ending as the API does. */
function answer(res: import("node:http").ServerResponse, opts: { text?: string[]; tool?: { id: string; name: string; json: string[] }; stop?: string; usage?: object; start?: object } = {}): void {
  sseHead(res);
  frame(res, start(opts.start), "message_start");
  let index = 0;
  if (opts.text) {
    frame(res, { type: "content_block_start", index, content_block: { type: "text", text: "" } }, "content_block_start");
    for (const t of opts.text) frame(res, { type: "content_block_delta", index, delta: { type: "text_delta", text: t } }, "content_block_delta");
    frame(res, { type: "content_block_stop", index }, "content_block_stop");
    index++;
  }
  if (opts.tool) {
    frame(res, { type: "content_block_start", index, content_block: { type: "tool_use", id: opts.tool.id, name: opts.tool.name, input: {} } }, "content_block_start");
    for (const j of opts.tool.json) frame(res, { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: j } }, "content_block_delta");
    frame(res, { type: "content_block_stop", index }, "content_block_stop");
  }
  frame(res, { type: "message_delta", delta: { stop_reason: opts.stop ?? (opts.tool ? "tool_use" : "end_turn"), stop_sequence: null }, usage: opts.usage ?? { output_tokens: 15 } }, "message_delta");
  frame(res, { type: "message_stop" }, "message_stop");
  res.end();
}

test("a text answer streams as deltas, with the usage from the start and the end of the message", async () => {
  await withServer(
    (_req, res) => answer(res, { text: ["Hel", "lo"], usage: { output_tokens: 15 } }),
    async (s) => {
      const events = await collect(provider(s).stream(ASK));
      assert.deepEqual(events.filter((e) => e.kind === "text").map((e) => (e as { delta: string }).delta), ["Hel", "lo"]);
      const r = endOf(events);
      assert.equal(r.text, "Hello");
      assert.equal(r.stopReason, "end_turn");
      assert.equal(r.model, "claude-test-20260101");
      assert.deepEqual(r.usage, { input: 25, output: 15, cacheRead: 0, cacheWrite: 0 });
    },
  );
});

test("the request is a Messages request: key and version headers, system as blocks, a required cap, and tools in the API's shape", async () => {
  await withServer(
    (_req, res) => answer(res, { text: ["ok"] }),
    async (s) => {
      await collect(
        provider(s).stream({
          ...ASK,
          tools: [{ name: "Read", description: "Read a file", inputSchema: { type: "object", properties: { file_path: { type: "string" } } } }],
        }),
      );
      const seen = s.seen[0]!;
      assert.equal(seen.url, "/v1/messages");
      assert.equal(seen.headers["x-api-key"], "sk-ant-test");
      assert.equal(seen.headers["anthropic-version"], "2023-06-01");
      assert.ok(!("authorization" in seen.headers));
      assert.deepEqual(seen.body.system, [{ type: "text", text: "You are a developer." }]);
      assert.equal(seen.body.max_tokens, 8192, "the API requires a cap, so one is always sent");
      assert.deepEqual(seen.body.tools, [{ name: "Read", description: "Read a file", input_schema: { type: "object", properties: { file_path: { type: "string" } } } }]);
      assert.equal(seen.body.stream, true);
      assert.ok(!("temperature" in seen.body));
    },
  );
});

test("a gateway that wants a bearer token gets one instead of the key header", async () => {
  await withServer(
    (_req, res) => answer(res, { text: ["ok"] }),
    async (s) => {
      await collect(provider(s, { authHeader: "bearer" }).stream(ASK));
      assert.equal(s.seen[0]!.headers.authorization, "Bearer sk-ant-test");
      assert.ok(!("x-api-key" in s.seen[0]!.headers));
    },
  );
});

test("with cache on, the end of the system prompt, of the tools and of the last message are marked, and nothing else", async () => {
  await withServer(
    (_req, res) => answer(res, { text: ["ok"] }),
    async (s) => {
      await collect(
        provider(s).stream({
          ...ASK,
          cache: true,
          tools: [
            { name: "A", description: "a", inputSchema: { type: "object" } },
            { name: "B", description: "b", inputSchema: { type: "object" } },
          ],
          messages: [
            { role: "user", content: "first" },
            { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "A", args: {} }] },
            { role: "tool", toolCallId: "t1", name: "A", content: "result" },
          ],
        }),
      );
      const body = s.seen[0]!.body;
      assert.deepEqual(body.system[0].cache_control, { type: "ephemeral" });
      assert.equal(body.tools[0].cache_control, undefined);
      assert.deepEqual(body.tools[1].cache_control, { type: "ephemeral" });
      const marked = body.messages.flatMap((m: { content: Array<{ cache_control?: unknown }> }, i: number) => m.content.map((b, j) => (b.cache_control ? [i, j] : null)).filter(Boolean));
      assert.deepEqual(marked, [[2, 0]], "only the last block of the last message");
    },
  );
});

test("tool results ride in one user turn, results first, and consecutive user text joins it", () => {
  const wire = toAnthropicMessages(
    [
      { role: "user", content: "go" },
      { role: "assistant", content: "reading", toolCalls: [{ id: "a", name: "Read", args: { file_path: "x" } }, { id: "b", name: "Glob", args: {} }] },
      { role: "tool", toolCallId: "a", name: "Read", content: "text", isError: false },
      { role: "tool", toolCallId: "b", name: "Glob", content: "no match", isError: true },
      { role: "user", content: "a note" },
    ],
    false,
  );
  assert.deepEqual(wire, [
    { role: "user", content: [{ type: "text", text: "go" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "reading" },
        { type: "tool_use", id: "a", name: "Read", input: { file_path: "x" } },
        { type: "tool_use", id: "b", name: "Glob", input: {} },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "a", content: "text" },
        { type: "tool_result", tool_use_id: "b", content: "no match", is_error: true },
        { type: "text", text: "a note" },
      ],
    },
  ]);
});

test("a user note that comes before a late tool result still follows it", () => {
  const wire = toAnthropicMessages(
    [
      { role: "assistant", content: "", toolCalls: [{ id: "a", name: "Read", args: {} }] },
      { role: "user", content: "a note" },
      { role: "tool", toolCallId: "a", name: "Read", content: "text" },
    ],
    false,
  );
  assert.deepEqual(wire[1], {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "a", content: "text" },
      { type: "text", text: "a note" },
    ],
  });
});

test("an assistant turn with nothing in it is dropped rather than sent as an empty block", () => {
  const wire = toAnthropicMessages([{ role: "user", content: "a" }, { role: "assistant", content: "" }, { role: "user", content: "b" }], false);
  assert.deepEqual(wire, [{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }]);
});

test("a tool call streams as partial JSON and is parsed when its block closes", async () => {
  await withServer(
    (_req, res) => answer(res, { text: ["I will read it."], tool: { id: "toolu_1", name: "Read", json: ['{"file_', 'path": "a.ts"}'] } }),
    async (s) => {
      const events = await collect(provider(s).stream(ASK));
      const r = endOf(events);
      assert.deepEqual(r.toolCalls, [{ id: "toolu_1", name: "Read", args: { file_path: "a.ts" } }]);
      assert.deepEqual(events.filter((e) => e.kind === "tool_call").map((e) => (e as { call: unknown }).call), r.toolCalls);
      assert.equal(r.stopReason, "tool_use");
      assert.equal(r.text, "I will read it.");
    },
  );
});

test("a call with no arguments has {} for them", async () => {
  await withServer(
    (_req, res) => answer(res, { tool: { id: "toolu_1", name: "mesh_done", json: [] } }),
    async (s) => {
      assert.deepEqual(endOf(await collect(provider(s).stream(ASK))).toolCalls, [{ id: "toolu_1", name: "mesh_done", args: {} }]);
    },
  );
});

test("a call cut off by the output cap is reported with its raw text, not lost", async () => {
  await withServer(
    (_req, res) => {
      sseHead(res);
      frame(res, start(), "message_start");
      frame(res, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_9", name: "Write", input: {} } }, "content_block_start");
      frame(res, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"file_path": "a.ts", "content": "const x' } }, "content_block_delta");
      frame(res, { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 8192 } }, "message_delta");
      frame(res, { type: "message_stop" }, "message_stop");
      res.end();
    },
    async (s) => {
      const r = endOf(await collect(provider(s).stream(ASK)));
      assert.equal(r.toolCalls.length, 1);
      assert.equal(r.toolCalls[0]!.invalidArgs, '{"file_path": "a.ts", "content": "const x');
      assert.deepEqual(r.toolCalls[0]!.args, {});
    },
  );
});

test("a call whose block never closed is flagged even when what arrived happens to parse, and even when nothing did", async () => {
  for (const partial of ['{"file_path": "a.ts"}', ""]) {
    await withServer(
      (_req, res) => {
        sseHead(res);
        frame(res, start(), "message_start");
        frame(res, { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_9", name: "Read", input: {} } }, "content_block_start");
        if (partial) frame(res, { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: partial } }, "content_block_delta");
        frame(res, { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 8192 } }, "message_delta");
        frame(res, { type: "message_stop" }, "message_stop");
        res.end();
      },
      async (s) => {
        const [call] = endOf(await collect(provider(s).stream(ASK))).toolCalls;
        assert.equal(call!.invalidArgs, partial, `a call that never finished is not run as if it had: ${JSON.stringify(partial)}`);
      },
    );
  }
});

test("cache reads and writes are reported apart from the input they are not part of", async () => {
  await withServer(
    (_req, res) => answer(res, { text: ["x"], start: { input_tokens: 12, cache_creation_input_tokens: 300, cache_read_input_tokens: 4000, output_tokens: 1 }, usage: { output_tokens: 40 } }),
    async (s) => {
      assert.deepEqual(endOf(await collect(provider(s).stream(ASK))).usage, { input: 12, output: 40, cacheRead: 4000, cacheWrite: 300 });
    },
  );
});

test("stop reasons map onto the port's", async () => {
  for (const [stop, want] of [["end_turn", "end_turn"], ["stop_sequence", "end_turn"], ["max_tokens", "max_tokens"], ["refusal", "content_filter"], ["pause_turn", "other"]] as const) {
    await withServer(
      (_req, res) => answer(res, { text: ["x"], stop }),
      async (s) => {
        assert.equal(endOf(await collect(provider(s).stream(ASK))).stopReason, want, stop);
      },
    );
  }
});

test("thinking is reported as reasoning and does not join the answer", async () => {
  await withServer(
    (_req, res) => {
      sseHead(res);
      frame(res, start(), "message_start");
      frame(res, { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }, "content_block_start");
      frame(res, { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }, "content_block_delta");
      frame(res, { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } }, "content_block_delta");
      frame(res, { type: "content_block_stop", index: 0 }, "content_block_stop");
      frame(res, { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }, "content_block_start");
      frame(res, { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "done" } }, "content_block_delta");
      frame(res, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }, "message_delta");
      frame(res, { type: "message_stop" }, "message_stop");
      res.end();
    },
    async (s) => {
      const events = await collect(provider(s).stream(ASK));
      assert.deepEqual(events.filter((e) => e.kind === "reasoning").map((e) => (e as { delta: string }).delta), ["hmm"]);
      assert.equal(endOf(events).text, "done");
    },
  );
});

test("pings are ignored", async () => {
  await withServer(
    (_req, res) => {
      sseHead(res);
      frame(res, { type: "ping" }, "ping");
      frame(res, start(), "message_start");
      frame(res, { type: "ping" }, "ping");
      frame(res, { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }, "message_delta");
      frame(res, { type: "message_stop" }, "message_stop");
      res.end();
    },
    async (s) => {
      assert.equal(endOf(await collect(provider(s).stream(ASK))).stopReason, "end_turn");
    },
  );
});

test("an error event in the stream is the provider's error, and overload reads as the outage it is", async () => {
  await withServer(
    (_req, res) => {
      sseHead(res);
      frame(res, start(), "message_start");
      frame(res, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, "error");
      res.end();
    },
    async (s) => {
      const err = await collect(provider(s).stream(ASK)).catch((e: unknown) => e);
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, "unavailable");
      assert.equal(err.status, 529, "the provider's overload status, which the message then carries");
      assert.match(err.message, /^API Error: 529 Overloaded/);
      assert.equal(classifyProviderOutage(err)?.kind, "unavailable");
    },
  );
});

test("a stream with no message_stop is a failure, not a short answer", async () => {
  await withServer(
    (_req, res) => {
      sseHead(res);
      frame(res, start(), "message_start");
      frame(res, { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, "content_block_start");
      res.end();
    },
    async (s) => {
      await assert.rejects(collect(provider(s).stream(ASK)), (e: unknown) => e instanceof ProviderError && e.kind === "unreachable");
    },
  );
});

test("HTTP failures use the API's error body and are read by the classifier", async () => {
  const cases: Array<[number, object, string]> = [
    [401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, "auth"],
    [429, { type: "error", error: { type: "rate_limit_error", message: "Number of request tokens has exceeded your rate limit" } }, "rate_limited"],
    [529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, "unavailable"],
    [400, { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API." } }, "billing"],
  ];
  for (const [status, body, kind] of cases) {
    await withServer(
      (_req, res) => json(res, status, body),
      async (s) => {
        const err = await collect(provider(s, { transport: { ...FAST, maxRetries: 0 } }).stream(ASK)).catch((e: unknown) => e);
        assert.ok(err instanceof ProviderError, `${status}`);
        assert.equal(err.kind, kind, `${status}`);
        assert.match(err.message, new RegExp(`^API Error: ${status} `));
      },
    );
  }
  // The billing case is a 400, so the classifier reads it from the words: the status alone would call it the seat's own fault.
  await withServer(
    (_req, res) => json(res, 400, { type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 213437 tokens > 200000 maximum" } }),
    async (s) => {
      const err = await collect(provider(s).stream(ASK)).catch((e: unknown) => e);
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, "context_overflow");
    },
  );
});

test("overload is retried, and the retry's answer is the one returned", async () => {
  await withServer(
    (_req, res, n) => (n === 0 ? json(res, 529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }) : answer(res, { text: ["ok"] })),
    async (s) => {
      assert.equal(endOf(await collect(provider(s).stream(ASK))).text, "ok");
      assert.equal(s.seen.length, 2);
    },
  );
});

test("the model listing reads the ids", async () => {
  await withServer(
    (req, res) => (req.url?.startsWith("/v1/models") ? json(res, 200, { data: [{ id: "claude-a" }, { id: "claude-b" }], has_more: false }) : json(res, 404, {})),
    async (s) => {
      assert.deepEqual(await provider(s).listModels(), ["claude-a", "claude-b"]);
    },
  );
});

test("temperature and an extra body field are sent when given", async () => {
  await withServer(
    (_req, res) => answer(res, { text: ["ok"] }),
    async (s) => {
      await collect(provider(s).stream({ ...ASK, temperature: 0.3, maxOutputTokens: 100, extraBody: { top_k: 5 } }));
      const body = s.seen[0]!.body;
      assert.equal(body.temperature, 0.3);
      assert.equal(body.max_tokens, 100);
      assert.equal(body.top_k, 5);
    },
  );
});
