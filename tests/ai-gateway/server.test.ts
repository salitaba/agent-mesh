import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as http from "node:http";
import { OpenAiCompatibleProvider, ProviderError, type ModelEvent } from "../../packages/llm/src/index";
import { WireError, createTenantServer, listen, outputFor, readBody, sendError, sendJson, type Listening } from "../../packages/ai-gateway/src/index";
import { FAST, collect } from "../llm/fake-server";
import { answer, chatBody, rawUpload, rig, spends, untilAborted, type Rig, type RigOptions, type Script } from "./support";

interface Served extends Rig {
  listening: Listening;
  /** The real adapter the native runtime uses, pointed at the gateway. */
  client: OpenAiCompatibleProvider;
  url: string;
}

async function serve(options: RigOptions = {}, server: { maxBodyBytes?: number } = {}): Promise<Served> {
  const r = await rig(options);
  const listening = await listen(createTenantServer(r.gateway, server), 0, "127.0.0.1");
  const client = new OpenAiCompatibleProvider({ baseUrl: `${listening.url}/v1`, apiKey: r.token, transport: FAST });
  return { ...r, listening, client, url: listening.url };
}

const ask = (extra: Record<string, unknown> = {}) => ({ model: "balanced", messages: [{ role: "user" as const, content: "Write hello.txt." }], ...extra });

const unavailable = () => new ProviderError("alpha.example", { kind: "unavailable", status: 503, detail: "overloaded" });

test("a conversation through the gateway reads back exactly as the provider gave it: text, tool calls, usage, and the model that answered", async () => {
  const calls = [
    { id: "call_1", name: "Write", args: { file_path: "hello.txt", content: "hi\n" } },
    { id: "call_2", name: "Read", args: {}, invalidArgs: '{"path":' },
  ];
  const s = await serve({ alpha: answer("Writing it now.", { calls, usage: { input: 1_200, output: 340, cacheRead: 8_000, cacheWrite: 500, reasoning: 90 }, model: "small-2026-10" }) });
  try {
    const events = await collect(s.client.stream({ model: "fast", messages: [{ role: "user", content: "Write hello.txt." }], system: "You are a seat." }));
    const end = events.at(-1) as Extract<ModelEvent, { kind: "end" }>;
    assert.equal(end.result.text, "Writing it now.");
    assert.deepEqual(end.result.toolCalls, calls);
    assert.equal(end.result.stopReason, "tool_use");
    assert.deepEqual(end.result.usage, { input: 1_200, output: 340, cacheRead: 8_000, cacheWrite: 500, reasoning: 90 }, "the four numbers survive both hops");
    assert.equal(end.result.model, "small-2026-10");
    assert.equal(events.filter((e) => e.kind === "tool_call").length, 2);
    // What the provider was asked, and what it cost.
    assert.equal(s.alpha.requests[0]!.model, "small");
    assert.equal(s.alpha.requests[0]!.system, "You are a seat.");
    const [spend] = spends(s.store);
    assert.deepEqual(spend!.usage, { input: 1_200, output: 340, cacheRead: 8_000, cacheWrite: 500, reasoning: 90 });
    assert.equal(spend!.chargeMicros, s.prices.price("alpha/small", spend!.usage).chargeMicros);
  } finally {
    await s.listening.close(0);
  }
});

test("the models a key may use are listed through the adapter's own listing call", async () => {
  const s = await serve();
  try {
    assert.deepEqual(await s.client.listModels(), ["fast", "balanced", "best"]);
    const narrow = await s.account("narrow", 1_000_000, { models: ["best"] });
    const client = new OpenAiCompatibleProvider({ baseUrl: `${s.url}/v1`, apiKey: narrow.token, transport: FAST });
    assert.deepEqual(await client.listModels(), ["best"]);
    const res = await fetch(`${s.url}/v1/models`, { headers: { authorization: `Bearer ${narrow.token}` } });
    assert.deepEqual(await res.json(), { object: "list", data: [{ id: "best", object: "model", created: 0, owned_by: "curule" }] });
  } finally {
    await s.listening.close(0);
  }
});

test("each refusal reaches the native runtime's adapter as the kind of fault it is, so the mesh pauses once and says why", async () => {
  const s = await serve({ credit: 0 });
  try {
    const error = async (client: OpenAiCompatibleProvider, model = "fast"): Promise<ProviderError> => {
      try {
        await collect(client.stream({ model, messages: [{ role: "user", content: "x" }] }));
      } catch (err) {
        return err as ProviderError;
      }
      throw new Error("the call succeeded");
    };
    const poor = await error(s.client);
    assert.equal(poor.kind, "billing");
    assert.equal(poor.status, 402);
    assert.match(poor.message, /^API Error: 402 The balance is too low for this call: it may cost up to USD /);

    await s.ledger.grant({ id: "g", accountId: "acme", bucket: "purchased", amountMicros: 50_000_000, reason: "x" });
    const missing = await error(s.client, "gpt-9");
    assert.equal(missing.kind, "invalid_request");
    assert.match(missing.message, /'gpt-9' is not available to this key\. Available: fast, balanced, best\./);

    const stranger = new OpenAiCompatibleProvider({ baseUrl: `${s.url}/v1`, apiKey: "curule_vk_000000000000_" + "A".repeat(43), transport: FAST });
    const auth = await error(stranger);
    assert.equal(auth.kind, "auth");
    assert.equal(auth.status, 401);
    await s.ledger.revokeKey(s.key.keyId, "closed");
    assert.equal((await error(s.client)).kind, "auth", "a revoked key is an auth failure, no different from a wrong one");
  } finally {
    await s.listening.close(0);
  }
});

test("a limit is a rate limit with the wait in Retry-After, which the adapter reads and, being over its own patience, reports", async () => {
  const s = await serve({ keyOptions: { limits: { rpm: 2 } } });
  try {
    await collect(s.client.stream({ model: "fast", messages: [{ role: "user", content: "1" }] }));
    await collect(s.client.stream({ model: "fast", messages: [{ role: "user", content: "2" }] }));
    await assert.rejects(
      () => collect(s.client.stream({ model: "fast", messages: [{ role: "user", content: "3" }] })),
      (err: ProviderError) => err.kind === "rate_limited" && err.status === 429 && err.retryAfterMs === 30_000,
    );
  } finally {
    await s.listening.close(0);
  }
});

test("a gateway that every provider has failed is a 503 the adapter retries as it would any provider, and then reports as an outage", async () => {
  const s = await serve({
    alpha: async function* () {
      throw unavailable();
    },
    tiers: [{ name: "fast", models: ["alpha/small"] }],
  });
  try {
    await assert.rejects(
      () => collect(s.client.stream({ model: "fast", messages: [{ role: "user", content: "x" }] })),
      (err: ProviderError) => err.kind === "unavailable" && err.status === 503,
    );
    assert.equal(s.alpha.requests.length, 3, "the adapter's two retries each reached the gateway, which asked the provider again");
    assert.equal(spends(s.store).length, 0);
  } finally {
    await s.listening.close(0);
  }
});

test("an answer that fails half way is an error in the stream that the adapter reads after the text it had already received", async () => {
  const s = await serve({
    alpha: async function* () {
      yield { kind: "text", delta: "Half an " };
      yield { kind: "text", delta: "answer" };
      throw unavailable();
    },
    tiers: [{ name: "fast", models: ["alpha/small"] }],
  });
  try {
    const seen: string[] = [];
    await assert.rejects(
      async () => {
        for await (const e of s.client.stream({ model: "fast", messages: [{ role: "user", content: "x" }] })) if (e.kind === "text") seen.push(e.delta);
      },
      (err: ProviderError) => err.kind === "unavailable" && err.status === 503,
    );
    assert.equal(seen.join(""), "Half an answer");
    assert.equal(spends(s.store)[0]!.outcome, "failed");
    assert.equal(s.alpha.requests.length, 1, "a failure after the answer began is not retried: the adapter would repeat what it had seen");
  } finally {
    await s.listening.close(0);
  }
});

test("a prompt that is too long reaches the adapter as a context overflow, which is what lets the runtime rotate the session", async () => {
  const s = await serve({
    alpha: async function* () {
      throw new ProviderError("alpha.example", { kind: "context_overflow", status: 400, detail: "prompt is too long" });
    },
    tiers: [{ name: "fast", models: ["alpha/small"] }],
  });
  try {
    await assert.rejects(
      () => collect(s.client.stream({ model: "fast", messages: [{ role: "user", content: "x" }] })),
      (err: ProviderError) => err.kind === "context_overflow",
    );
  } finally {
    await s.listening.close(0);
  }
});

// ---- the HTTP itself ----

test("a call that does not ask for a stream gets one JSON body with the request id, and the stream is server-sent events that end with [DONE]", async () => {
  const s = await serve({ alpha: answer("Hello there.") });
  try {
    const headers = { "content-type": "application/json", authorization: `Bearer ${s.token}` };
    const plain = await fetch(`${s.url}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify(ask({ model: "fast" })) });
    assert.equal(plain.status, 200);
    assert.match(plain.headers.get("x-request-id")!, /^req_/);
    assert.match(plain.headers.get("content-type")!, /^application\/json/);
    const body = (await plain.json()) as any;
    assert.equal(body.choices[0].message.content, "Hello there.");
    assert.equal(body.usage.completion_tokens, 20);

    const streamed = await fetch(`${s.url}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify(ask({ model: "fast", stream: true })) });
    assert.equal(streamed.status, 200);
    assert.match(streamed.headers.get("content-type")!, /^text\/event-stream/);
    assert.equal(streamed.headers.get("cache-control"), "no-cache, no-transform");
    assert.equal(streamed.headers.get("x-accel-buffering"), "no", "a proxy in front is told not to hold the stream back");
    assert.match(streamed.headers.get("x-request-id")!, /^req_/);
    const text = await streamed.text();
    const events = text.split("\n\n").filter((e) => e !== "");
    assert.ok(events.every((e) => e.startsWith("data: ")), "every event is a data line");
    assert.equal(events.at(-1), "data: [DONE]");
    const json = events.slice(0, -1).map((e) => JSON.parse(e.slice("data: ".length)));
    assert.equal(json.map((j) => j.choices[0]?.delta?.content ?? "").join(""), "Hello there.");
  } finally {
    await s.listening.close(0);
  }
});

test("the health check answers 200 while the ledger can be written and 503 when it cannot", async () => {
  const s = await serve();
  try {
    const ok = await fetch(`${s.url}/healthz`);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true });
    s.store.failure = new Error("disk full");
    const down = await fetch(`${s.url}/healthz/`);
    assert.equal(down.status, 503);
    assert.deepEqual(await down.json(), { ok: false });
    assert.equal((await fetch(`${s.url}/healthz`, { method: "POST" })).status, 405);
  } finally {
    await s.listening.close(0);
  }
});

test("routes that do not exist are a 404 and methods that are not allowed a 405, as JSON errors with a request id", async () => {
  const s = await serve();
  try {
    const nothing = await fetch(`${s.url}/v1/embeddings`, { method: "POST" });
    assert.equal(nothing.status, 404);
    assert.equal(((await nothing.json()) as any).error.type, "not_found");
    assert.match(nothing.headers.get("x-request-id")!, /^req_/);
    const wrong = await fetch(`${s.url}/v1/chat/completions`, { headers: { authorization: `Bearer ${s.token}` } });
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.get("allow"), "POST");
    assert.equal(((await wrong.json()) as any).error.type, "method_not_allowed");
    const models = await fetch(`${s.url}/v1/models`, { method: "POST" });
    assert.equal(models.status, 405);
    assert.equal(models.headers.get("allow"), "GET");
    assert.equal((await fetch(`${s.url}/v1/chat/completions/`, { method: "POST", headers: { authorization: `Bearer ${s.token}` }, body: JSON.stringify(ask({ stream: false })) })).status, 200, "a trailing slash is the same route");
  } finally {
    await s.listening.close(0);
  }
});

test("a body that is not JSON is a 400, and one that is too large is a 413 that is not read to the end", async () => {
  const s = await serve({}, { maxBodyBytes: 2_048 });
  try {
    const headers = { "content-type": "application/json", authorization: `Bearer ${s.token}` };
    const bad = await fetch(`${s.url}/v1/chat/completions`, { method: "POST", headers, body: "{not json" });
    assert.equal(bad.status, 400);
    assert.notEqual(bad.headers.get("connection"), "close", "a body that was read to the end leaves the connection fit to use again");
    assert.equal(((await bad.json()) as any).error.type, "invalid_json");
    const big = await fetch(`${s.url}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify(ask({ stream: false, messages: [{ role: "user", content: "x".repeat(10_000) }] })) });
    assert.equal(big.status, 413);
    assert.equal(big.headers.get("connection"), "close", "the rest of an upload that was refused is not read, so the connection is not reused");
    assert.equal(((await big.json()) as any).error.type, "request_too_large");
    assert.equal(s.alpha.requests.length, 0);
    const edge = await fetch(`${s.url}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify(ask({ stream: false, model: "fast" })) });
    assert.equal(edge.status, 200, "a request under the limit is served");
  } finally {
    await s.listening.close(0);
  }
});

test("a request without a valid key is answered before its body is read: a caller that announces a huge upload gets its 401 at once", async () => {
  const s = await serve();
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(`${s.url}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", "content-length": "100000000", authorization: "Bearer nope" } }, (res) => {
        resolve(res.statusCode ?? 0);
        res.resume();
        req.destroy();
      });
      req.on("error", () => undefined);
      req.write("{");
      setTimeout(() => reject(new Error("no answer while the body was still coming")), 3_000).unref();
    });
    assert.equal(status, 401);
    const noKey = await fetch(`${s.url}/v1/chat/completions`, { method: "POST", body: "{}" });
    assert.equal(noKey.status, 401);
    assert.equal(noKey.headers.get("connection"), "close", "the connection is not kept for the body that was about to follow");
    assert.equal(((await noKey.json()) as any).error.type, "missing_api_key");
    const viaHeader = await fetch(`${s.url}/v1/chat/completions`, { method: "POST", headers: { "x-api-key": s.token }, body: "{}" });
    assert.equal(viaHeader.status, 401, "only Authorization: Bearer carries a key");
    assert.equal((await fetch(`${s.url}/v1/models`)).status, 401);
  } finally {
    await s.listening.close(0);
  }
});

test("a caller that disconnects mid-stream stops the provider and is charged for what was produced", async () => {
  let sawAbort!: () => void;
  const aborted = new Promise<void>((resolve) => (sawAbort = resolve));
  const script: Script = async function* (req) {
    yield { kind: "text", delta: "x".repeat(800) };
    try {
      await untilAborted(req.signal);
    } finally {
      sawAbort();
    }
  };
  const s = await serve({ alpha: script, tiers: [{ name: "fast", models: ["alpha/small"] }] });
  try {
    const controller = new AbortController();
    const res = await fetch(`${s.url}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${s.token}` }, body: JSON.stringify(ask({ model: "fast", stream: true })), signal: controller.signal });
    const reader = res.body!.getReader();
    const first = await reader.read();
    assert.ok(first.value && first.value.length > 0, "the caller received the start of the answer");
    controller.abort();
    await aborted;
    for (let i = 0; i < 100 && spends(s.store).length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    const [spend] = spends(s.store);
    assert.equal(spend!.outcome, "aborted");
    assert.equal(spend!.usage.output, 200);
    assert.equal(s.gateway.heldFor("acme"), 0);
    assert.equal(s.gateway.concurrency.inFlight(s.key.keyId), 0);
  } finally {
    await s.listening.close(0);
  }
});

test("a quiet provider is waited for with comments the adapter ignores, and the answer arrives whole", async () => {
  const script: Script = async function* (req, n) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    yield* (await answer("worth the wait")(req, n)) as AsyncGenerator<ModelEvent, void>;
  };
  const s = await serve({ alpha: script, gateway: { commitMs: 20, keepAliveMs: 20 }, tiers: [{ name: "fast", models: ["alpha/small"] }] });
  try {
    const raw = await fetch(`${s.url}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${s.token}` }, body: JSON.stringify(ask({ model: "fast", stream: true })) });
    const text = await raw.text();
    assert.ok((text.match(/^: keep-alive$/gm) ?? []).length >= 2, "kept alive while it waited");
    const events = await collect(s.client.stream({ model: "fast", messages: [{ role: "user", content: "x" }] }));
    assert.equal((events.at(-1) as Extract<ModelEvent, { kind: "end" }>).result.text, "worth the wait");
  } finally {
    await s.listening.close(0);
  }
});

test("many calls at once are each answered, charged and recorded once", async () => {
  const s = await serve({ keyOptions: { limits: { concurrent: 20, rpm: 1_000 } } });
  try {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => collect(s.client.stream({ model: "fast", messages: [{ role: "user", content: `call ${i}` }] }))),
    );
    assert.equal(results.length, 12);
    const all = spends(s.store);
    assert.equal(all.length, 12);
    assert.equal(new Set(all.map((e) => e.requestId)).size, 12, "a request id each");
    const charged = all.reduce((sum, e) => sum + e.chargeMicros, 0);
    assert.equal(s.ledger.balance("acme").purchased, 100_000_000 - charged);
    assert.equal(s.gateway.heldFor("acme"), 0);
  } finally {
    await s.listening.close(0);
  }
});

test("closing the server lets a call in flight finish, and refuses new ones", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const script: Script = async function* (req, n) {
    await gate;
    yield* (await answer("finished")(req, n)) as AsyncGenerator<ModelEvent, void>;
  };
  const s = await serve({ alpha: script, tiers: [{ name: "fast", models: ["alpha/small"] }] });
  const inFlight = collect(s.client.stream({ model: "fast", messages: [{ role: "user", content: "x" }] }));
  await new Promise((r) => setTimeout(r, 30));
  const closing = s.listening.close(5_000);
  await new Promise((r) => setTimeout(r, 30));
  await assert.rejects(() => fetch(`${s.url}/healthz`), "a new connection is refused once the server is closing");
  release();
  const events = await inFlight;
  assert.equal((events.at(-1) as Extract<ModelEvent, { kind: "end" }>).result.text, "finished");
  await closing;
  assert.equal(spends(s.store).length, 1);
});

test("a server that is closed with a call still running past its grace ends it, and the call is recorded as the caller going away", async () => {
  const script: Script = async function* (req) {
    yield { kind: "text", delta: "x".repeat(40) };
    await untilAborted(req.signal);
  };
  const s = await serve({ alpha: script, tiers: [{ name: "fast", models: ["alpha/small"] }] });
  const stuck = collect(s.client.stream({ model: "fast", messages: [{ role: "user", content: "x" }] })).catch(() => "ended");
  await new Promise((r) => setTimeout(r, 50));
  await s.listening.close(50);
  assert.equal(await stuck, "ended");
  for (let i = 0; i < 100 && spends(s.store).length === 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(spends(s.store)[0]?.outcome, "aborted");
});

// ---- the details of what goes over the wire ----

test("every JSON answer says its length in bytes and is not to be cached, whether it is an answer, a list, a health check or an error", async () => {
  const s = await serve({ alpha: answer("Grüße, 世界 ✓") });
  try {
    const headers = { "content-type": "application/json", authorization: `Bearer ${s.token}` };
    const answers = [
      await fetch(`${s.url}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify(ask({ model: "fast" })) }),
      await fetch(`${s.url}/v1/models`, { headers }),
      await fetch(`${s.url}/healthz`),
      await fetch(`${s.url}/nothing-here`),
    ];
    for (const res of answers) {
      const text = await res.text();
      assert.equal(res.headers.get("cache-control"), "no-store", res.url);
      assert.equal(res.headers.get("content-length"), String(Buffer.byteLength(text)), res.url);
    }
    const first = await (await fetch(`${s.url}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify(ask({ model: "fast" })) })).text();
    assert.ok(Buffer.byteLength(first) > first.length, "the answer has characters of more than one byte, so a length in characters would be wrong");
  } finally {
    await s.listening.close(0);
  }
});

test("a request body of exactly the limit is read and one byte more is refused", async () => {
  const limit = 2_048;
  const s = await serve({}, { maxBodyBytes: limit });
  try {
    const headers = { "content-type": "application/json", authorization: `Bearer ${s.token}` };
    const base = JSON.stringify(ask({ stream: false, model: "fast" }));
    const exact = base + " ".repeat(limit - Buffer.byteLength(base));
    assert.equal(Buffer.byteLength(exact), limit);
    assert.equal((await fetch(`${s.url}/v1/chat/completions`, { method: "POST", headers, body: exact })).status, 200);
    const over = await fetch(`${s.url}/v1/chat/completions`, { method: "POST", headers, body: exact + " " });
    assert.equal(over.status, 413);
    assert.match(((await over.json()) as any).error.message, /larger than 2048 bytes/);
  } finally {
    await s.listening.close(0);
  }
});

test("a failure the gateway did not mean to raise is a plain 500 that tells the caller nothing about itself, and the operator's log has the reason", async () => {
  const s = await serve();
  try {
    Object.assign(s.gateway, {
      chat: async () => {
        throw new Error("connection string postgres://admin:hunter2@db.internal");
      },
    });
    const res = await fetch(`${s.url}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${s.token}` }, body: JSON.stringify(ask()) });
    assert.equal(res.status, 500);
    assert.match(res.headers.get("x-request-id")!, /^req_/);
    const text = await res.text();
    assert.ok(!text.includes("hunter2"), "the caller is not told what the failure was");
    assert.deepEqual(JSON.parse(text).error, { message: "The server failed to handle this request.", type: "internal_error", code: "internal_error", param: null });
    const logged = s.logs.find((l) => l.msg === "the server failed to handle a request");
    assert.equal(logged?.level, "error");
    assert.match(String(logged?.error), /^Error: connection string postgres:\/\/admin:hunter2@db\.internal$/);
  } finally {
    await s.listening.close(0);
  }
});

test("a failure after the stream was opened cannot be turned into an error answer, so the connection is ended and the caller sees a broken stream", async () => {
  const s = await serve();
  try {
    Object.assign(s.gateway, {
      chat: async (_key: unknown, _body: unknown, out: { open(h: Record<string, string>): void; frame(d: unknown): void }) => {
        out.open({});
        out.frame({ id: "c1" });
        throw new Error("something broke after the first frame");
      },
    });
    const res = await fetch(`${s.url}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${s.token}` }, body: JSON.stringify(ask()) });
    assert.equal(res.status, 200, "the headers had already gone");
    await assert.rejects(() => res.text(), "the body does not end as a finished stream does");
  } finally {
    await s.listening.close(0);
  }
});

test("the headers of a stream reach the caller as soon as the gateway commits to it, without waiting for the first byte of the answer", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const script: Script = async function* (req, n) {
    await gate;
    yield* (await answer("late")(req, n)) as AsyncGenerator<ModelEvent, void>;
  };
  const s = await serve({ alpha: script, gateway: { commitMs: 20, keepAliveMs: 60_000 }, tiers: [{ name: "fast", models: ["alpha/small"] }] });
  try {
    const request = fetch(`${s.url}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${s.token}` }, body: JSON.stringify(ask({ model: "fast", stream: true })) });
    const outcome = await Promise.race([request, new Promise<"waited">((resolve) => setTimeout(() => resolve("waited"), 3_000))]);
    assert.notEqual(outcome, "waited", "the caller was still waiting for headers after the stream was opened");
    release();
    assert.match(await (outcome as Response).text(), /late/);
  } finally {
    release();
    await s.listening.close(0);
  }
});

// ---- the pieces, on a response that records what it is given ----

class FakeResponse extends EventEmitter {
  destroyed = false;
  writableEnded = false;
  writableFinished = false;
  headersSent = false;
  /** What `write` says about the reader: false means it is behind. */
  accepting = true;
  flushed = 0;
  readonly writes: string[] = [];
  readonly heads: Array<{ status: number; headers: Record<string, string | number> }> = [];
  readonly ended: string[] = [];
  write(data: string): boolean {
    this.writes.push(data);
    return this.accepting;
  }
  writeHead(status: number, headers: Record<string, string | number>): this {
    this.heads.push({ status, headers });
    this.headersSent = true;
    return this;
  }
  flushHeaders(): void {
    this.flushed++;
  }
  end(data?: string): this {
    this.ended.push(data ?? "");
    this.writableEnded = true;
    return this;
  }
  get response(): http.ServerResponse {
    return this as unknown as http.ServerResponse;
  }
}

test("a stream is opened with the headers an event stream needs and flushed at once, and is written as data lines and comment lines", () => {
  const f = new FakeResponse();
  const out = outputFor(f.response);
  out.open({ "x-request-id": "req_1" });
  assert.deepEqual(f.heads, [{ status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no", "x-request-id": "req_1" } }]);
  assert.equal(f.flushed, 1, "a caller waiting for a slow first token already knows its call was accepted");
  out.frame({ id: "c1" });
  out.frame("[DONE]");
  out.comment("keep-alive");
  assert.deepEqual(f.writes, ['data: {"id":"c1"}\n\n', "data: [DONE]\n\n", ": keep-alive\n\n"]);
  out.close();
  out.close();
  assert.equal(f.ended.length, 1, "closing twice ends the response once");
});

test("a reader that is behind makes the writer wait for it, and one that goes away lets the writer go", async () => {
  const f = new FakeResponse();
  const out = outputFor(f.response);
  const baseline = f.listenerCount("close");
  f.accepting = false;
  let written = false;
  const pending = Promise.resolve(out.frame({ n: 1 })).then(() => (written = true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(written, false, "held until the reader has taken what it was given");
  f.emit("drain");
  await pending;
  assert.equal(written, true);
  assert.equal(f.listenerCount("drain"), 0, "nothing is left listening for the drain");
  assert.equal(f.listenerCount("close"), baseline);

  written = false;
  const goneAway = Promise.resolve(out.frame({ n: 2 })).then(() => (written = true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(written, false);
  f.emit("close");
  await goneAway;
  assert.equal(written, true, "a reader that closed will never drain, so the writer is not kept waiting for it");
  assert.equal(f.listenerCount("drain"), 0);
  assert.equal(f.listenerCount("close"), baseline);

  f.accepting = true;
  assert.equal(out.frame({ n: 3 }), undefined, "a reader that keeps up is not waited for");
});

test("a response that has been destroyed or ended takes nothing more written to it, and ending one that is already ended does nothing", () => {
  for (const gone of ["destroyed", "writableEnded"] as const) {
    const f = new FakeResponse();
    f[gone] = true;
    const out = outputFor(f.response);
    assert.equal(out.frame({ n: 1 }), undefined, gone);
    out.comment("keep-alive");
    assert.deepEqual(f.writes, [], gone);
  }
  const ended = new FakeResponse();
  ended.writableEnded = true;
  outputFor(ended.response).close();
  assert.deepEqual(ended.ended, [], "it is not ended a second time");
});

test("the caller has gone when the connection closes before the response was finished, and has not when it closes after the last byte", () => {
  const early = new FakeResponse();
  const a = outputFor(early.response);
  assert.equal(a.aborted.aborted, false);
  early.emit("close");
  assert.equal(a.aborted.aborted, true);

  const normal = new FakeResponse();
  const b = outputFor(normal.response);
  normal.writableFinished = true;
  normal.emit("close");
  assert.equal(b.aborted.aborted, false, "a close after the response was finished is not a hang-up");
});

test("a JSON answer carries its length in bytes and is never cached, and an answer to a call that has already been answered is ignored", () => {
  const f = new FakeResponse();
  const out = outputFor(f.response);
  const body = { text: "héllo ✓" };
  const payload = JSON.stringify(body);
  out.json(200, body, { "x-request-id": "req_1" });
  assert.ok(Buffer.byteLength(payload) > payload.length);
  assert.deepEqual(f.heads, [{ status: 200, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), "cache-control": "no-store", "x-request-id": "req_1" } }]);
  assert.deepEqual(f.ended, [payload]);
  out.reject(500, { late: true });
  out.json(500, { late: true });
  assert.equal(f.heads.length, 1);
  assert.equal(f.ended.length, 1);

  const begun = new FakeResponse();
  begun.headersSent = true;
  sendJson(begun.response, 200, { x: 1 });
  assert.deepEqual([begun.heads, begun.ended], [[], []], "a response whose headers have gone cannot be given others");
});

test("an error is sent with its own status, its own headers and a request id, and one that is not the gateway's own is a plain 500", () => {
  const known = new FakeResponse();
  sendError(known.response, new WireError(429, "rate_limit_exceeded", "Slow down.", undefined, { "retry-after": "7" }), { connection: "close" });
  assert.equal(known.heads[0]!.status, 429);
  assert.equal(known.heads[0]!.headers["retry-after"], "7");
  assert.equal(known.heads[0]!.headers.connection, "close");
  assert.match(String(known.heads[0]!.headers["x-request-id"]), /^req_/);
  assert.equal(JSON.parse(known.ended[0]!).error.message, "Slow down.");

  const unknown = new FakeResponse();
  sendError(unknown.response, new Error("secret detail"));
  assert.equal(unknown.heads[0]!.status, 500);
  assert.ok(!unknown.ended[0]!.includes("secret detail"));
  assert.equal(JSON.parse(unknown.ended[0]!).error.message, "The server failed to handle this request.");
});

function incoming(): http.IncomingMessage & EventEmitter {
  return new EventEmitter() as unknown as http.IncomingMessage & EventEmitter;
}

const noListeners = (req: EventEmitter): void => {
  for (const event of ["data", "end", "error", "close"]) assert.equal(req.listenerCount(event), 0, `a '${event}' listener is left on the request`);
};

test("a request body is the chunks joined, and the request is left with no listeners of ours", async () => {
  const req = incoming();
  const body = readBody(req, 100);
  req.emit("data", Buffer.from('{"a":'));
  req.emit("data", Buffer.from("1}"));
  req.emit("end");
  assert.equal((await body).toString("utf8"), '{"a":1}');
  noListeners(req);
});

test("a body over the limit is refused as soon as it is over, and what comes after is not read; exactly the limit is accepted", async () => {
  const over = incoming();
  const refused = readBody(over, 10);
  over.emit("data", Buffer.alloc(6));
  over.emit("data", Buffer.alloc(5));
  await assert.rejects(refused, (e: WireError) => e.status === 413 && e.type === "request_too_large" && /larger than 10 bytes/.test(e.message));
  noListeners(over);
  assert.equal(over.emit("end"), false, "once refused, nothing more is listened to");

  const exact = incoming();
  const accepted = readBody(exact, 10);
  exact.emit("data", Buffer.alloc(6));
  exact.emit("data", Buffer.alloc(4));
  exact.emit("end");
  assert.equal((await accepted).length, 10);
});

test("a request that breaks, or whose connection closes, before it is complete is a 400 and not a body", async () => {
  const broken = incoming();
  const a = readBody(broken, 100);
  broken.emit("data", Buffer.from("{"));
  broken.emit("error", new Error("socket hang up"));
  await assert.rejects(a, (e: WireError) => e.status === 400 && e.message === "The request could not be read.");
  noListeners(broken);

  const closed = incoming();
  const b = readBody(closed, 100);
  closed.emit("data", Buffer.from("{"));
  closed.emit("close");
  await assert.rejects(b, (e: WireError) => e.status === 400 && e.message === "The connection closed before the request was complete.");
  noListeners(closed);
});

test("the address a server is listening on is written as a URL, with an IPv6 host in brackets", async () => {
  const fake = (port: number) =>
    ({
      once: () => undefined,
      off: () => undefined,
      listen: (_port: number, _host: string, done: () => void) => done(),
      address: () => ({ port }),
    }) as unknown as http.Server;
  assert.equal((await listen(fake(8080), 8080, "127.0.0.1")).url, "http://127.0.0.1:8080");
  assert.equal((await listen(fake(8080), 8080, "::1")).url, "http://[::1]:8080");
  assert.equal((await listen(fake(9), 0, "gateway.internal")).port, 9, "the port is the one the server was given, which matters when it asked for any");
});

test("an upload that is refused is not waited for: the server answers and then closes the connection, though the caller has not finished sending", async () => {
  const s = await serve({}, { maxBodyBytes: 2_048 });
  try {
    const head = (key: string): string[] => ["POST /v1/chat/completions HTTP/1.1", "Host: gateway.invalid", `Authorization: Bearer ${key}`, "Content-Type: application/json"];
    const noKey = await rawUpload(s.url, head("nope"), "{");
    assert.deepEqual(noKey, { status: 401, closedByServer: true });
    const tooBig = await rawUpload(s.url, head(s.token), `{"model":"fast","x":"${"x".repeat(3_000)}`);
    assert.deepEqual(tooBig, { status: 413, closedByServer: true });
  } finally {
    await s.listening.close(0);
  }
});

test("closing a server does not wait for a connection that is idle between two calls", async () => {
  const s = await serve();
  const agent = new http.Agent({ keepAlive: true });
  try {
    await new Promise<void>((resolve, reject) => {
      http
        .get(`${s.url}/healthz`, { agent }, (res) => {
          res.resume();
          res.on("end", resolve);
        })
        .on("error", reject);
    });
    const started = Date.now();
    await s.listening.close(30_000);
    assert.ok(Date.now() - started < 2_000, "it waited for the idle connection to time out");
  } finally {
    agent.destroy();
  }
});
