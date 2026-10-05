import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAiCompatibleProvider, ProviderError, type ModelEvent, type ModelRequest, type ModelResult } from "../../packages/llm/src/index";
import { classifyProviderOutage, isTimeoutError } from "../../packages/protocol/src/index";
import { FAST, collect, fakeServer, frame, json, sseHead, type FakeServer } from "./fake-server";

/**
 * The OpenAI-compatible adapter against a server that speaks the format the way real ones do: in pieces, with the usual
 * omissions, and failing the usual ways.
 */

const ASK: ModelRequest = { model: "m1", system: "You are a developer.", messages: [{ role: "user", content: "hi" }] };

const chunk = (delta: object, finish: string | null = null, extra: object = {}) => ({
  id: "c1",
  object: "chat.completion.chunk",
  model: "m1-2026",
  choices: [{ index: 0, delta, finish_reason: finish }],
  ...extra,
});

const usageChunk = (usage: object) => ({ id: "c1", model: "m1-2026", choices: [], usage });

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

const provider = (s: FakeServer, extra: object = {}) => new OpenAiCompatibleProvider({ baseUrl: `${s.url}/v1`, apiKey: "sk-test", transport: FAST, ...extra });

test("a text answer streams as deltas, with the model and usage the server reports", async () => {
  await withServer(
    (_req, res) => {
      sseHead(res);
      frame(res, chunk({ role: "assistant", content: "" }));
      frame(res, chunk({ content: "Hel" }));
      frame(res, chunk({ content: "lo" }));
      frame(res, chunk({}, "stop"));
      frame(res, usageChunk({ prompt_tokens: 100, completion_tokens: 7, total_tokens: 107 }));
      frame(res, "[DONE]");
      res.end();
    },
    async (s) => {
      const events = await collect(provider(s).stream(ASK));
      assert.deepEqual(events.filter((e) => e.kind === "text").map((e) => (e as { delta: string }).delta), ["Hel", "lo"]);
      const r = endOf(events);
      assert.equal(r.text, "Hello");
      assert.equal(r.stopReason, "end_turn");
      assert.equal(r.model, "m1-2026");
      assert.deepEqual(r.usage, { input: 100, output: 7, cacheRead: 0, cacheWrite: 0 });
    },
  );
});

test("the request carries the key, the system prompt, the tools and the usage option, and nothing it was not asked for", async () => {
  await withServer(
    (_req, res) => {
      sseHead(res);
      frame(res, chunk({ content: "ok" }, "stop"));
      frame(res, "[DONE]");
      res.end();
    },
    async (s) => {
      await collect(
        provider(s, { headers: { "x-org": "acme" } }).stream({
          ...ASK,
          tools: [{ name: "Read", description: "Read a file", inputSchema: { type: "object", properties: { file_path: { type: "string" } } } }],
          maxOutputTokens: 512,
        }),
      );
      const seen = s.seen[0]!;
      assert.equal(seen.url, "/v1/chat/completions");
      assert.equal(seen.headers.authorization, "Bearer sk-test");
      assert.equal(seen.headers["x-org"], "acme");
      assert.deepEqual(seen.body.messages, [
        { role: "system", content: "You are a developer." },
        { role: "user", content: "hi" },
      ]);
      assert.deepEqual(seen.body.tools, [
        { type: "function", function: { name: "Read", description: "Read a file", parameters: { type: "object", properties: { file_path: { type: "string" } } } } },
      ]);
      assert.equal(seen.body.stream, true);
      assert.deepEqual(seen.body.stream_options, { include_usage: true });
      assert.equal(seen.body.max_tokens, 512);
      assert.ok(!("temperature" in seen.body), "temperature is sent only when asked for");
      assert.ok(!("reasoning_effort" in seen.body));
    },
  );
});

test("assistant tool calls and tool results are sent back in the shape the format wants", async () => {
  await withServer(
    (_req, res) => {
      sseHead(res);
      frame(res, chunk({ content: "ok" }, "stop"));
      frame(res, "[DONE]");
      res.end();
    },
    async (s) => {
      await collect(
        provider(s).stream({
          model: "m1",
          messages: [
            { role: "user", content: "read it" },
            { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "Read", args: { file_path: "a.ts" } }] },
            { role: "tool", toolCallId: "call_1", name: "Read", content: "file text" },
          ],
        }),
      );
      assert.deepEqual(s.seen[0]!.body.messages, [
        { role: "user", content: "read it" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "Read", arguments: '{"file_path":"a.ts"}' } }] },
        { role: "tool", tool_call_id: "call_1", name: "Read", content: "file text" },
      ]);
    },
  );
});

test("a tool call arrives in fragments and is parsed when complete; parallel calls keep their order", async () => {
  await withServer(
    (_req, res) => {
      sseHead(res);
      frame(res, chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "Read", arguments: "" } }] }));
      frame(res, chunk({ tool_calls: [{ index: 0, function: { arguments: '{"file_' } }] }));
      frame(res, chunk({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "Glob", arguments: '{"pattern":' } }] }));
      frame(res, chunk({ tool_calls: [{ index: 0, function: { arguments: 'path":"a.ts"}' } }] }));
      frame(res, chunk({ tool_calls: [{ index: 1, function: { arguments: '"**/*.ts"}' } }] }));
      frame(res, chunk({}, "tool_calls"));
      frame(res, usageChunk({ prompt_tokens: 10, completion_tokens: 20 }));
      frame(res, "[DONE]");
      res.end();
    },
    async (s) => {
      const events = await collect(provider(s).stream(ASK));
      const calls = events.filter((e) => e.kind === "tool_call").map((e) => (e as { call: unknown }).call);
      assert.deepEqual(calls, [
        { id: "call_a", name: "Read", args: { file_path: "a.ts" } },
        { id: "call_b", name: "Glob", args: { pattern: "**/*.ts" } },
      ]);
      const r = endOf(events);
      assert.equal(r.stopReason, "tool_use");
      assert.deepEqual(r.toolCalls, calls);
    },
  );
});

test("a server that sends no indexes still yields separate calls, whole or in pieces", async () => {
  await withServer(
    (_req, res) => {
      sseHead(res);
      frame(res, chunk({ tool_calls: [{ id: "c1", function: { name: "Read", arguments: '{"file_path":' } }] }));
      frame(res, chunk({ tool_calls: [{ function: { arguments: '"x"}' } }] }));
      frame(res, chunk({ tool_calls: [{ id: "c2", function: { name: "Grep", arguments: '{"pattern":"y"}' } }] }));
      frame(res, chunk({}, "stop"));
      frame(res, "[DONE]");
      res.end();
    },
    async (s) => {
      const r = endOf(await collect(provider(s).stream(ASK)));
      assert.deepEqual(r.toolCalls, [
        { id: "c1", name: "Read", args: { file_path: "x" } },
        { id: "c2", name: "Grep", args: { pattern: "y" } },
      ]);
      assert.equal(r.stopReason, "tool_use", "a tool call outranks a finish reason of stop");
    },
  );
});

test("a server with no indexes and no ids still yields one call per named fragment", async () => {
  await withServer(
    (_req, res) => {
      sseHead(res);
      frame(res, chunk({ tool_calls: [{ function: { name: "Read", arguments: '{"file_path":"a"}' } }] }));
      frame(res, chunk({ tool_calls: [{ function: { name: "Grep", arguments: '{"pattern":"b"}' } }] }));
      frame(res, chunk({}, "stop"));
      frame(res, "[DONE]");
      res.end();
    },
    async (s) => {
      const calls = endOf(await collect(provider(s).stream(ASK))).toolCalls;
      assert.deepEqual(calls.map((c) => [c.name, c.args]), [["Read", { file_path: "a" }], ["Grep", { pattern: "b" }]]);
    },
  );
});

test("two calls that reuse index 0 with different ids are two calls", async () => {
  await withServer(
    (_req, res) => {
      sseHead(res);
      frame(res, chunk({ tool_calls: [{ index: 0, id: "g1", function: { name: "Read", arguments: '{"file_path":"a"}' } }] }));
      frame(res, chunk({ tool_calls: [{ index: 0, id: "g2", function: { name: "Read", arguments: '{"file_path":"b"}' } }] }));
      frame(res, chunk({}, "stop"));
      frame(res, "[DONE]");
      res.end();
    },
    async (s) => {
      const r = endOf(await collect(provider(s).stream(ASK)));
      assert.deepEqual(r.toolCalls.map((c) => [c.id, c.args]), [["g1", { file_path: "a" }], ["g2", { file_path: "b" }]]);
    },
  );
});

test("calls with no id, or the same id twice, get ids that are unique within the answer", async () => {
  await withServer(
    (_req, res) => {
      sseHead(res);
      frame(res, chunk({ tool_calls: [{ index: 0, function: { name: "Read", arguments: "{}" } }, { index: 1, function: { name: "Glob", arguments: "{}" } }] }));
      frame(res, chunk({ tool_calls: [{ index: 2, id: "dup", function: { name: "A", arguments: "{}" } }, { index: 3, id: "dup", function: { name: "B", arguments: "{}" } }] }));
      frame(res, chunk({}, "tool_calls"));
      frame(res, "[DONE]");
      res.end();
    },
    async (s) => {
      const ids = endOf(await collect(provider(s).stream(ASK))).toolCalls.map((c) => c.id);
      assert.equal(new Set(ids).size, 4, JSON.stringify(ids));
      assert.ok(ids.every((id) => id !== ""));
    },
  );
});

test("arguments that are not a JSON object are kept raw and flagged, never run as {}", async () => {
  await withServer(
    (_req, res) => {
      sseHead(res);
      frame(res, chunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "Read", arguments: '{"file_path": "a.ts"' } }] }));
      frame(res, chunk({ tool_calls: [{ index: 1, id: "c2", function: { name: "Glob", arguments: "[1,2]" } }] }));
      frame(res, chunk({}, "tool_calls"));
      frame(res, "[DONE]");
      res.end();
    },
    async (s) => {
      const [a, b] = endOf(await collect(provider(s).stream(ASK))).toolCalls;
      assert.deepEqual(a, { id: "c1", name: "Read", args: {}, invalidArgs: '{"file_path": "a.ts"' });
      assert.deepEqual(b, { id: "c2", name: "Glob", args: {}, invalidArgs: "[1,2]" });
    },
  );
});

test("arguments sent as an object rather than a string are accepted", async () => {
  await withServer(
    (_req, res) => {
      sseHead(res);
      frame(res, chunk({ tool_calls: [{ index: 0, id: "c1", function: { name: "Read", arguments: { file_path: "a.ts" } } }] }, "tool_calls"));
      frame(res, "[DONE]");
      res.end();
    },
    async (s) => {
      assert.deepEqual(endOf(await collect(provider(s).stream(ASK))).toolCalls, [{ id: "c1", name: "Read", args: { file_path: "a.ts" } }]);
    },
  );
});

test("cached prompt tokens are split out of the input, whichever of the two fields reports them", async () => {
  for (const [label, usage, want] of [
    ["openai", { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 }, completion_tokens_details: { reasoning_tokens: 20 } }, { input: 200, output: 50, cacheRead: 800, cacheWrite: 0, reasoning: 20 }],
    ["deepseek", { prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400 }, { input: 400, output: 50, cacheRead: 600, cacheWrite: 0 }],
  ] as const) {
    await withServer(
      (_req, res) => {
        sseHead(res);
        frame(res, chunk({ content: "x" }, "stop"));
        frame(res, usageChunk(usage));
        frame(res, "[DONE]");
        res.end();
      },
      async (s) => {
        assert.deepEqual(endOf(await collect(provider(s).stream(ASK))).usage, want, label);
      },
    );
  }
});

test("a server that reports no usage is estimated, and says so", async () => {
  await withServer(
    (_req, res) => {
      sseHead(res);
      frame(res, chunk({ content: "a".repeat(400) }, "stop"));
      frame(res, "[DONE]");
      res.end();
    },
    async (s) => {
      const u = endOf(await collect(provider(s).stream(ASK))).usage;
      assert.equal(u.estimated, true);
      assert.ok(u.input > 0 && u.output === 100, JSON.stringify(u));
    },
  );
});

test("reasoning text is reported as reasoning and never joins the answer", async () => {
  await withServer(
    (_req, res) => {
      sseHead(res);
      frame(res, chunk({ reasoning_content: "let me think" }));
      frame(res, chunk({ reasoning: " more" }));
      frame(res, chunk({ content: "answer" }, "stop"));
      frame(res, "[DONE]");
      res.end();
    },
    async (s) => {
      const events = await collect(provider(s).stream(ASK));
      assert.deepEqual(events.filter((e) => e.kind === "reasoning").map((e) => (e as { delta: string }).delta), ["let me think", " more"]);
      assert.equal(endOf(events).text, "answer");
    },
  );
});

test("finish reasons map onto the port's stop reasons", async () => {
  for (const [finish, want] of [["stop", "end_turn"], ["length", "max_tokens"], ["content_filter", "content_filter"], ["weird", "other"]] as const) {
    await withServer(
      (_req, res) => {
        sseHead(res);
        frame(res, chunk({ content: "x" }, finish));
        frame(res, "[DONE]");
        res.end();
      },
      async (s) => {
        assert.equal(endOf(await collect(provider(s).stream(ASK))).stopReason, want, finish);
      },
    );
  }
});

test("a server that ignores stream:true and answers with one JSON completion is read the same", async () => {
  await withServer(
    (_req, res) =>
      json(res, 200, {
        model: "m1-2026",
        choices: [{ message: { role: "assistant", content: "whole", tool_calls: [{ id: "c1", type: "function", function: { name: "Read", arguments: '{"file_path":"a"}' } }] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 5, completion_tokens: 6 },
      }),
    async (s) => {
      const r = endOf(await collect(provider(s).stream(ASK)));
      assert.equal(r.text, "whole");
      assert.deepEqual(r.toolCalls, [{ id: "c1", name: "Read", args: { file_path: "a" } }]);
      assert.deepEqual(r.usage, { input: 5, output: 6, cacheRead: 0, cacheWrite: 0 });
    },
  );
});

test("a stream that ends before the model finished is a failure, not a short answer", async () => {
  await withServer(
    (_req, res) => {
      sseHead(res);
      frame(res, chunk({ content: "half an ans" }));
      res.end();
    },
    async (s) => {
      await assert.rejects(collect(provider(s).stream(ASK)), (err: unknown) => err instanceof ProviderError && err.kind === "unreachable" && /ended before the model finished/.test(err.message));
    },
  );
});

test("an error object inside the stream is thrown as the provider's error", async () => {
  await withServer(
    (_req, res) => {
      sseHead(res);
      frame(res, chunk({ content: "x" }));
      frame(res, { error: { message: "The server is overloaded", type: "server_error", code: 503 } });
      res.end();
    },
    async (s) => {
      await assert.rejects(collect(provider(s).stream(ASK)), (err: unknown) => err instanceof ProviderError && err.kind === "unavailable" && err.status === 503);
    },
  );
});

test("HTTP failures are typed, and read by the supervisor's classifier as the provider outage they are", async () => {
  const cases: Array<[number, object, string, string]> = [
    [401, { error: { message: "Incorrect API key provided", type: "invalid_request_error", code: "invalid_api_key" } }, "auth", "auth"],
    [402, { error: { message: "Insufficient credits" } }, "billing", "billing"],
    [402, { error: { message: "This account is suspended." } }, "billing", "billing"],
    [429, { error: { message: "Rate limit reached", type: "rate_limit_error" } }, "rate_limited", "rate_limited"],
    [500, { error: { message: "internal error" } }, "unavailable", "unavailable"],
    [503, "<html>bad gateway</html>" as unknown as object, "unavailable", "unavailable"],
  ];
  for (const [status, body, kind, outage] of cases) {
    await withServer(
      (_req, res) => (typeof body === "string" ? (res.writeHead(status), res.end(body)) : json(res, status, body)),
      async (s) => {
        const err = await collect(provider(s, { transport: { ...FAST, maxRetries: 0 } }).stream(ASK)).catch((e: unknown) => e);
        assert.ok(err instanceof ProviderError, `${status}: ${String(err)}`);
        assert.equal(err.kind, kind, `${status}`);
        assert.equal(err.status, status);
        assert.match(err.message, new RegExp(`^API Error: ${status} `));
        assert.equal(classifyProviderOutage(err)?.kind, outage, `${status}: the supervisor reads it as ${outage}`);
      },
    );
  }
});

test("a prompt that does not fit is a context overflow, which is the seat's own failure and not an outage", async () => {
  await withServer(
    (_req, res) => json(res, 400, { error: { message: "This model's maximum context length is 128000 tokens. However, your messages resulted in 150000 tokens.", type: "invalid_request_error", code: "context_length_exceeded" } }),
    async (s) => {
      const err = await collect(provider(s).stream(ASK)).catch((e: unknown) => e);
      assert.ok(err instanceof ProviderError);
      assert.equal(err.kind, "context_overflow");
      assert.equal(classifyProviderOutage(err), null);
    },
  );
});

test("a busy provider is retried, a refused request is not, and a long Retry-After is the caller's to decide", async () => {
  // 429 then 200: one retry, and the answer is the second response.
  await withServer(
    (_req, res, n) => {
      if (n === 0) return json(res, 429, { error: { message: "slow down" } }, { "retry-after": "0" });
      sseHead(res);
      frame(res, chunk({ content: "ok" }, "stop"));
      frame(res, "[DONE]");
      res.end();
    },
    async (s) => {
      assert.equal(endOf(await collect(provider(s).stream(ASK))).text, "ok");
      assert.equal(s.seen.length, 2);
    },
  );
  // 401 is final on the first answer.
  await withServer(
    (_req, res) => json(res, 401, { error: { message: "bad key" } }),
    async (s) => {
      await assert.rejects(collect(provider(s).stream(ASK)), ProviderError);
      assert.equal(s.seen.length, 1, "a rejected key is not asked again");
    },
  );
  // A Retry-After past the cap is surfaced with its wait, not slept through.
  await withServer(
    (_req, res) => json(res, 429, { error: { message: "wait" } }, { "retry-after": "3600" }),
    async (s) => {
      const err = await collect(provider(s).stream(ASK)).catch((e: unknown) => e);
      assert.ok(err instanceof ProviderError);
      assert.equal(err.retryAfterMs, 3_600_000);
      assert.equal(s.seen.length, 1);
    },
  );
  // Still busy after every retry: the last failure is the one reported.
  await withServer(
    (_req, res) => json(res, 503, { error: { message: "down" } }),
    async (s) => {
      await assert.rejects(collect(provider(s, { transport: { ...FAST, maxRetries: 2 } }).stream(ASK)), (e: unknown) => e instanceof ProviderError && e.status === 503);
      assert.equal(s.seen.length, 3, "the first attempt and two retries");
    },
  );
});

test("a provider that cannot be reached fails as the supervisor's 'unreachable' outage, after its retries", async () => {
  const s = await fakeServer((_req, res) => res.end());
  const url = s.url;
  await s.close();
  const p = new OpenAiCompatibleProvider({ baseUrl: `${url}/v1`, transport: { ...FAST, maxRetries: 1 } });
  const err = await collect(p.stream(ASK)).catch((e: unknown) => e);
  assert.ok(err instanceof ProviderError);
  assert.equal(err.kind, "unreachable");
  assert.match(err.message, /Unable to connect to API \(ECONNREFUSED\)/);
  assert.equal(classifyProviderOutage(err)?.kind, "unreachable");
});

test("a parameter the server refuses by name is dropped once and remembered", async () => {
  await withServer(
    (req, res) => {
      if (req.body.stream_options) return json(res, 400, { error: { message: "Unknown parameter: 'stream_options'." } });
      if (req.body.max_tokens !== undefined) return json(res, 400, { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } });
      if (req.body.temperature !== undefined) return json(res, 400, { error: { message: "Unsupported value: 'temperature' does not support 0.2 with this model." } });
      sseHead(res);
      frame(res, chunk({ content: "ok" }, "stop"));
      frame(res, "[DONE]");
      res.end();
    },
    async (s) => {
      const p = provider(s);
      const r = endOf(await collect(p.stream({ ...ASK, maxOutputTokens: 100, temperature: 0.2 })));
      assert.equal(r.text, "ok");
      const final = s.seen[s.seen.length - 1]!.body;
      assert.ok(!("stream_options" in final) && !("max_tokens" in final) && !("temperature" in final));
      assert.equal(final.max_completion_tokens, 100);
      const before = s.seen.length;
      await collect(p.stream({ ...ASK, maxOutputTokens: 100, temperature: 0.2 }));
      assert.equal(s.seen.length - before, 1, "the second call goes out already right");
    },
  );
});

test("aborting a call mid-stream throws an AbortError and releases the connection", async () => {
  await withServer(
    (_req, res) => {
      sseHead(res);
      frame(res, chunk({ content: "start" }));
      // Never finishes.
    },
    async (s) => {
      const abort = new AbortController();
      const seen: string[] = [];
      const err = await (async () => {
        try {
          for await (const e of provider(s).stream({ ...ASK, signal: abort.signal })) {
            if (e.kind === "text") {
              seen.push(e.delta);
              abort.abort();
            }
          }
        } catch (e) {
          return e;
        }
      })();
      assert.deepEqual(seen, ["start"]);
      assert.ok(err instanceof Error && err.name === "AbortError", String(err));
    },
  );
});

test("a call aborted before it starts never reaches the server", async () => {
  await withServer(
    (_req, res) => res.end(),
    async (s) => {
      const abort = new AbortController();
      abort.abort();
      const err = await collect(provider(s).stream({ ...ASK, signal: abort.signal })).catch((e: unknown) => e);
      assert.ok(err instanceof Error && err.name === "AbortError");
      assert.equal(s.seen.length, 0);
    },
  );
});

test("a model that goes quiet mid-answer times out as 'slow', which the supervisor retries rather than counts as a crash", async () => {
  await withServer(
    (_req, res) => {
      sseHead(res);
      frame(res, chunk({ content: "start" }));
    },
    async (s) => {
      const err = await collect(provider(s, { transport: { ...FAST, idleTimeoutMs: 60 } }).stream(ASK)).catch((e: unknown) => e);
      assert.ok(err instanceof Error && err.name === "TimeoutError", String(err));
      assert.equal(isTimeoutError(err), true);
    },
  );
});

test("a connection cut mid-answer is a failure, not a short answer", async () => {
  await withServer(
    (_req, res) => {
      sseHead(res);
      frame(res, chunk({ content: "start" }));
      setTimeout(() => res.socket?.destroy(), 20);
    },
    async (s) => {
      const err = await collect(provider(s).stream(ASK)).catch((e: unknown) => e);
      assert.ok(err instanceof ProviderError, String(err));
      assert.equal(err.kind, "unreachable");
    },
  );
});

test("the model listing reads the ids the endpoint serves", async () => {
  await withServer(
    (req, res) => (req.url === "/v1/models" ? json(res, 200, { data: [{ id: "a" }, { id: "b" }, { object: "x" }] }) : json(res, 404, {})),
    async (s) => {
      assert.deepEqual(await provider(s).listModels(), ["a", "b"]);
      assert.equal(s.seen[0]!.headers.authorization, "Bearer sk-test");
    },
  );
});

test("effort and an extra body field are sent where the provider takes them", async () => {
  await withServer(
    (_req, res) => {
      sseHead(res);
      frame(res, chunk({ content: "ok" }, "stop"));
      frame(res, "[DONE]");
      res.end();
    },
    async (s) => {
      await collect(provider(s).stream({ ...ASK, effort: "low", extraBody: { top_p: 0.5 } }));
      assert.equal(s.seen[0]!.body.reasoning_effort, "low");
      assert.equal(s.seen[0]!.body.top_p, 0.5);
    },
  );
});
