import { test } from "node:test";
import assert from "node:assert/strict";
import { ProviderError, ProviderTimeoutError, classifyHttpFailure, type ModelEvent } from "../../packages/llm/src/index";
import { WireError, mintKey, toWireError } from "../../packages/ai-gateway/src/index";
import { FakeOut, answer, chatBody, result, rig, spends, untilAborted, zeroUsage, type Script } from "./support";

const never = untilAborted;
const unavailable = (): ProviderError => new ProviderError("alpha.example", { kind: "unavailable", status: 503, detail: "overloaded" });

// ---- who is calling ----

test("a key is authenticated, and every way of being wrong gets the same refusal, so it says nothing about which keys exist", async () => {
  const r = await rig();
  assert.equal(r.gateway.authenticate(`Bearer ${r.token}`).keyId, r.key.keyId);
  const other = mintKey();
  const secret = r.token.split("_").at(-1)!;
  const wrong = [
    `Bearer curule_vk_${r.key.keyId}_${"A".repeat(43)}`, // right id, wrong secret
    `Bearer ${other.token}`, // an id nobody has
    "Bearer not-a-key",
    `Bearer ${r.token}x`,
    `Basic ${secret}`,
  ];
  const messages = new Set<string>();
  for (const header of wrong) {
    try {
      r.gateway.authenticate(header);
      assert.fail(`${header} was accepted`);
    } catch (err) {
      assert.ok(err instanceof WireError && err.status === 401, header);
      messages.add(`${err.type}: ${err.message}`);
    }
  }
  assert.equal(messages.size, 2, "one message for a key that is wrong, one for no key at all");
  assert.throws(() => r.gateway.authenticate(undefined), (err: WireError) => err.status === 401 && err.type === "missing_api_key" && /Authorization: Bearer/.test(err.message));
  assert.throws(() => r.gateway.authenticate(["Bearer a", "Bearer b"]), WireError);
});

test("a revoked key is refused exactly like an unknown one, and the log says it was a revoked key that was used", async () => {
  const r = await rig();
  await r.ledger.revokeKey(r.key.keyId, "workspace deleted");
  assert.throws(() => r.gateway.authenticate(`Bearer ${r.token}`), (err: WireError) => err.status === 401 && err.type === "invalid_api_key" && err.message === "The API key is not valid.");
  assert.ok(r.logs.some((l) => l.msg === "a revoked key was used" && l.keyId === r.key.keyId));
});

// ---- the answer ----

test("a streamed call: the caller is sent the role, the text, the finish and the usage, and the ledger holds what it cost", async () => {
  const r = await rig({ alpha: answer("Hello there, seat.", { usage: { input: 1_000, output: 200, cacheRead: 5_000, cacheWrite: 0 }, model: "small-2026-10" }) });
  const out = await r.call(chatBody({ model: "fast" }));
  assert.deepEqual(out.kinds.filter((k) => k !== "frame"), ["open", "close"]);
  const open = out.events.find((e) => e.kind === "open") as { headers: Record<string, string> };
  assert.match(open.headers["x-request-id"]!, /^req_[0-9a-f]{24}$/);
  const frames = out.frames;
  assert.deepEqual(frames[0].choices[0].delta, { role: "assistant", content: "" });
  assert.equal(out.text, "Hello there, seat.");
  assert.equal(frames.at(-1), "[DONE]");
  const finish = frames.at(-3);
  assert.equal(finish.choices[0].finish_reason, "stop");
  const usage = frames.at(-2);
  assert.deepEqual(usage.choices, []);
  assert.deepEqual(usage.usage, {
    prompt_tokens: 6_000,
    completion_tokens: 200,
    total_tokens: 6_200,
    prompt_tokens_details: { cached_tokens: 5_000, cache_write_tokens: 0 },
  });
  assert.equal(usage.model, "small-2026-10");
  assert.ok(frames.slice(0, -2).every((f) => f.id === frames[0].id), "one id for the whole stream");

  // alpha/small at 1 in, 4 out, 0.1 cached per million; markup 1.5:
  // 1,000 x 1 + 200 x 4 + 5,000 x 0.1 = 2,300 millionths of a unit of cost, 3,450 charged.
  const [spend] = spends(r.store);
  assert.equal(spends(r.store).length, 1);
  assert.deepEqual(
    { ...spend, at: undefined, latencyMs: undefined },
    {
      id: `spend_${open.headers["x-request-id"]}`,
      at: undefined,
      type: "spend",
      requestId: open.headers["x-request-id"],
      accountId: "acme",
      keyId: r.key.keyId,
      workspaceId: "ws-acme",
      alias: "fast",
      provider: "alpha",
      model: "small",
      modelReported: "small-2026-10",
      priceVersion: "test-1",
      usage: { input: 1_000, output: 200, cacheRead: 5_000, cacheWrite: 0 },
      costMicros: 2_300,
      chargeMicros: 3_450,
      outcome: "ok",
      estimated: false,
      latencyMs: undefined,
    },
  );
  assert.equal(r.ledger.balance("acme").purchased, 100_000_000 - 3_450);
  assert.equal(r.gateway.heldFor("acme"), 0, "nothing is held back once the call has settled");
});

test("the spend is durable before the last frame is sent: the caller never sees the end of a call the ledger has not recorded", async () => {
  const r = await rig();
  const order: string[] = [];
  const append = r.store.append.bind(r.store);
  r.store.append = async (e) => {
    order.push(`append:${e.type}`);
    await append(e);
  };
  const out = new FakeOut();
  const frame = out.frame.bind(out);
  out.frame = (data) => {
    order.push(data === "[DONE]" ? "frame:done" : (data as any).usage ? "frame:usage" : "frame");
    return frame(data);
  };
  await r.gateway.chat(r.key, chatBody({ model: "fast" }), out);
  assert.ok(order.indexOf("append:spend") < order.indexOf("frame:usage"), order.join(", "));
  assert.ok(order.indexOf("append:spend") < order.indexOf("frame:done"));
});

test("what a call held is given back as soon as its spend is recorded, so the account is not charged for the same call twice while the last frames go out", async () => {
  const r = await rig();
  const out = new FakeOut();
  const held: number[] = [];
  const frame = out.frame.bind(out);
  out.frame = (data) => {
    held.push(r.gateway.heldFor("acme"));
    return frame(data);
  };
  await r.gateway.chat(r.key, chatBody({ model: "fast" }), out);
  assert.ok(held.length >= 4);
  assert.ok(held[0]! > 0, "while the answer is being produced the call holds its worst case");
  assert.equal(held.at(-1), 0, "by the last frame the spend counts and the hold is gone");
  assert.equal(held.at(-2), 0);
});

test("a call that does not ask for a stream gets one JSON answer, with the usage, and is billed the same", async () => {
  const r = await rig({ alpha: answer("All done.", { usage: { input: 400, output: 100 } }) });
  const out = await r.call(chatBody({ model: "fast", stream: false }));
  assert.deepEqual(out.kinds, ["json"]);
  const done = out.completion!;
  assert.equal(done.status, 200);
  assert.match(done.headers["x-request-id"]!, /^req_/);
  assert.equal(done.body.choices[0].message.content, "All done.");
  assert.equal(done.body.choices[0].finish_reason, "stop");
  assert.equal(done.body.usage.prompt_tokens, 400);
  assert.equal(spends(r.store).length, 1);
  assert.equal(spends(r.store)[0]!.outcome, "ok");
});

test("a tool call from the model reaches the caller whole, with the finish reason that says so", async () => {
  const call = { id: "call_1", name: "Write", args: { file_path: "hello.txt", content: "hi" } };
  const r = await rig({ alpha: answer("", { calls: [call] }) });
  const streamed = await r.call(chatBody({ model: "fast" }));
  const delta = streamed.frames.find((f) => f.choices?.[0]?.delta?.tool_calls)!.choices[0].delta.tool_calls[0];
  assert.deepEqual(delta, { index: 0, id: "call_1", type: "function", function: { name: "Write", arguments: JSON.stringify(call.args) } });
  assert.equal(streamed.frames.at(-3).choices[0].finish_reason, "tool_calls");
  const whole = await r.call(chatBody({ model: "fast", stream: false }));
  assert.equal(whole.completion!.body.choices[0].message.content, null);
  assert.deepEqual(whole.completion!.body.choices[0].message.tool_calls, [{ id: "call_1", type: "function", function: { name: "Write", arguments: JSON.stringify(call.args) } }]);
});

test("several tool calls are indexed in the order the model made them", async () => {
  const calls = [1, 2, 3].map((n) => ({ id: `c${n}`, name: "Read", args: { n } }));
  const r = await rig({ alpha: answer("", { calls }) });
  const out = await r.call(chatBody({ model: "fast" }));
  const deltas = out.frames.filter((f) => f.choices?.[0]?.delta?.tool_calls).map((f) => f.choices[0].delta.tool_calls[0]);
  assert.deepEqual(deltas.map((d) => [d.index, d.id]), [[0, "c1"], [1, "c2"], [2, "c3"]]);
});

test("reasoning text is relayed as reasoning, and the usage that includes it is billed", async () => {
  const r = await rig({ alpha: answer("The answer.", { reasoning: "Let me think.", usage: { reasoning: 40, output: 90 } }) });
  const out = await r.call(chatBody({ model: "fast" }));
  assert.ok(out.frames.some((f) => f.choices?.[0]?.delta?.reasoning_content === "Let me think."));
  assert.equal(out.text, "The answer.", "reasoning is not part of the text");
  assert.equal(spends(r.store)[0]!.usage.reasoning, 40);
});

test("the provider is asked for the model behind the tier, with the conversation, the tools and the settings, and an answer cap that the tier bounds", async () => {
  const r = await rig({ tiers: [{ name: "fast", models: ["alpha/small"], max: 4_000 }, { name: "balanced", models: ["alpha/small", "beta/other"] }, { name: "best", models: ["alpha/large"] }] });
  const tool = { type: "function", function: { name: "Read", description: "Read a file", parameters: { type: "object", properties: {} } } };
  await r.call(chatBody({ model: "fast", tools: [tool], temperature: 0.3, reasoning_effort: "low", max_tokens: 100_000 }));
  const asked = r.alpha.requests[0]!;
  assert.equal(asked.model, "small", "the provider is asked for its own name for the model, not the tier");
  assert.equal(asked.system, "You are a seat.");
  assert.deepEqual(asked.messages, [{ role: "user", content: "Write hello.txt." }]);
  assert.equal(asked.tools?.[0]?.name, "Read");
  assert.equal(asked.temperature, 0.3);
  assert.equal(asked.effort, "low");
  assert.equal(asked.maxOutputTokens, 4_000, "asked for more than the tier allows: the tier's cap");
  await r.call(chatBody({ model: "fast", max_tokens: 300 }));
  assert.equal(r.alpha.requests[1]!.maxOutputTokens, 300, "asked for less: what was asked");
  await r.call(chatBody({ model: "fast" }));
  assert.equal(r.alpha.requests[2]!.maxOutputTokens, 4_000, "asked for nothing: the tier's cap");
});

test("the model shown is the provider's own name for it, or the tier the caller asked for when the operator hides it", async () => {
  const shown = await rig({ alpha: answer("x", { model: "small-2026-10" }) });
  assert.equal((await shown.call(chatBody({ model: "fast", stream: false }))).completion!.body.model, "small-2026-10");
  const hidden = await rig({ alpha: answer("x", { model: "small-2026-10" }), gateway: { exposeUpstreamModel: false } });
  const out = await hidden.call(chatBody({ model: "fast" }));
  assert.ok(out.frames.filter((f) => typeof f === "object").every((f) => f.model === "fast"));
  assert.equal(spends(hidden.store)[0]!.modelReported, "small-2026-10", "the ledger still records what answered");
});

test("usage that the provider only estimated is billed and recorded as an estimate", async () => {
  const r = await rig({ alpha: answer("x", { usage: { estimated: true } }) });
  await r.call(chatBody({ model: "fast" }));
  assert.equal(spends(r.store)[0]!.estimated, true);
});

// ---- the request ----

test("a refusal the caller caused is logged as information, and one that is the service's fault as an error", async () => {
  const r = await rig({ credit: 0 });
  await r.call(chatBody({ model: "fast" })); // 402
  await r.call(chatBody({ n: 2 })); // 400
  await r.call(chatBody({ model: "nope" })); // 404
  const levels = r.logs.filter((l) => l.msg === "call refused").map((l) => [l.status, l.level]);
  assert.deepEqual(levels, [[402, "info"], [400, "info"], [404, "info"]]);
  const down = await rig({ alpha: async function* () { throw unavailable(); }, tiers: [{ name: "fast", models: ["alpha/small"] }] });
  await down.call(chatBody({ model: "fast", stream: false }));
  const failed = down.logs.find((l) => l.msg === "call refused" && l.status === 503)!;
  assert.equal(failed.level, "error", "a 5xx is the service's to answer for");
});

test("each settled call is logged with what it cost, what was charged and how long it took, without its content", async () => {
  const r = await rig();
  await r.call(chatBody({ model: "fast" }));
  const settled = r.logs.find((l) => l.msg === "call settled")!;
  const [spend] = spends(r.store);
  assert.deepEqual(
    { level: settled.level, provider: settled.provider, model: settled.model, outcome: settled.outcome, chargeMicros: settled.chargeMicros, costMicros: settled.costMicros, requestId: settled.requestId, keyId: settled.keyId, accountId: settled.accountId, workspaceId: settled.workspaceId },
    { level: "info", provider: "alpha", model: "small", outcome: "ok", chargeMicros: spend!.chargeMicros, costMicros: spend!.costMicros, requestId: spend!.requestId, keyId: r.key.keyId, accountId: "acme", workspaceId: "ws-acme" },
  );
  assert.equal(settled.latencyMs, spend!.latencyMs);
});

test("the time a call took is the time between its start and its settlement, as the gateway's clock reads it", async () => {
  let advance!: () => void;
  const timed: Script = async function* (req, n) {
    advance();
    yield* (await answer("ok")(req, n)) as AsyncGenerator<ModelEvent, void>;
  };
  const r = await rig({ alpha: timed });
  advance = () => void (r.clock.now += 250);
  await r.call(chatBody({ model: "fast" }));
  assert.equal(spends(r.store)[0]!.latencyMs, 250);
});

test("the model the provider reports is kept in the spend only when it differs from the one that was asked for", async () => {
  const same = await rig({ alpha: answer("x", { model: "small" }) });
  await same.call(chatBody({ model: "fast" }));
  assert.equal("modelReported" in spends(same.store)[0]!, false);
  const snapshot = await rig({ alpha: answer("x", { model: "small-2026-10" }) });
  await snapshot.call(chatBody({ model: "fast" }));
  assert.equal(spends(snapshot.store)[0]!.modelReported, "small-2026-10");
});

test("a request that cannot be honoured is a 400 that names the problem, before anything is held, asked or written", async () => {
  const r = await rig();
  const out = await r.call(chatBody({ n: 2 }));
  assert.equal(out.rejection!.status, 400);
  assert.equal(out.rejection!.body.error.type, "unsupported_parameter");
  assert.equal(out.rejection!.body.error.param, "n");
  assert.match(out.rejection!.headers["x-request-id"]!, /^req_/);
  assert.equal(r.alpha.requests.length, 0);
  assert.equal(spends(r.store).length, 0);
  assert.equal(r.gateway.heldFor("acme"), 0);
  assert.equal((await r.call("not an object")).rejection!.status, 400);
});

test("an unknown model is a 404 that lists what is available; a key with an allowlist sees only its own tiers", async () => {
  const r = await rig();
  const out = await r.call(chatBody({ model: "gpt-9" }));
  assert.equal(out.rejection!.status, 404);
  assert.equal(out.rejection!.body.error.type, "model_not_found");
  assert.match(out.rejection!.body.error.message, /'gpt-9' is not available to this key\. Available: fast, balanced, best\./);
  assert.equal(r.alpha.requests.length, 0);
  const narrow = await r.account("narrow", 100_000_000, { models: ["fast"] });
  assert.deepEqual(r.gateway.models(narrow.key), ["fast"]);
  const denied = await r.call(chatBody({ model: "best" }), narrow.key);
  assert.equal(denied.rejection!.status, 404);
  assert.match(denied.rejection!.body.error.message, /Available: fast\./);
  assert.equal((await r.call(chatBody({ model: "fast" }), narrow.key)).rejection, undefined);
});

// ---- the balance ----

test("a call that the balance cannot cover is refused with what it needs and what there is, and the provider is never asked", async () => {
  const r = await rig({ credit: 0 });
  const out = await r.call(chatBody({ model: "best" }));
  const rejection = out.rejection!;
  assert.equal(rejection.status, 402);
  assert.equal(rejection.body.error.type, "insufficient_credits");
  assert.match(rejection.body.error.message, /may cost up to USD \d+\.\d+ and USD 0\.00 is available\. Add credit to continue\./);
  assert.equal(r.alpha.requests.length, 0);
  assert.equal(spends(r.store).length, 0);
  assert.equal(classifyHttpFailure(402, rejection.body.error.type, rejection.body.error.message), "billing", "the runtime reads it as an exhausted account and pauses the mesh once");
});

/**
 * The most the default test call could cost on alpha/small, which is what is held back before it runs: the whole request as JSON
 * at three characters to a token, priced as fresh input, plus an answer of the full cap, at 1 in and 4 out per million and a
 * markup of 1.5.
 */
function holdFor(maxTokens: number, tools?: unknown[]): number {
  const length = JSON.stringify({ system: "You are a seat.", messages: [{ role: "user", content: "Write hello.txt." }], tools }).length;
  const tokens = Math.ceil(length / 3);
  return Math.ceil(((tokens * 1_000_000 + maxTokens * 4_000_000) * 15_000) / 10_000_000_000);
}

test("what is held back for a call is its worst case, to the micro-unit: the request at the full input price and the whole answer allowed", async () => {
  const hold = holdFor(1_000);
  assert.ok(hold > 5_000 && hold < 8_000, `a hold of ${hold} is the order of magnitude this price gives`);
  for (const [credit, ok] of [[hold, true], [hold - 1, false]] as const) {
    const r = await rig({ credit: 0 });
    await r.ledger.grant({ id: "g", accountId: "acme", bucket: "purchased", amountMicros: credit, reason: "x" });
    const out = await r.call(chatBody({ model: "fast", max_tokens: 1_000 }));
    assert.equal(out.rejection === undefined, ok, `${credit} against a hold of ${hold}`);
    if (!ok) assert.match(out.rejection!.body.error.message, /may cost up to USD 0\.0060 and USD 0\.0060 is available/, "both amounts, shown to enough places that a sub-cent figure is not zero");
  }
});

test("the tools offered are part of what the call may cost, so a call with a long tool list is held for more", async () => {
  const schema = { type: "object", properties: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`field_${i}`, { type: "string", description: "a field the tool takes" }])) };
  const tools = [{ name: "Big", description: "x".repeat(2_000), inputSchema: schema }];
  const wire = [{ type: "function", function: { name: "Big", description: "x".repeat(2_000), parameters: schema } }];
  const hold = holdFor(1_000, tools);
  assert.ok(hold > holdFor(1_000) + 50, "the tool list adds to the hold");
  for (const [credit, ok] of [[hold, true], [hold - 1, false]] as const) {
    const r = await rig({ credit: 0 });
    await r.ledger.grant({ id: "g", accountId: "acme", bucket: "purchased", amountMicros: credit, reason: "x" });
    const out = await r.call(chatBody({ model: "fast", max_tokens: 1_000, tools: wire }));
    assert.equal(out.rejection === undefined, ok, `${credit} against a hold of ${hold}`);
  }
});

test("an account that is overdrawn is told it has nothing available, not a negative amount", async () => {
  const r = await rig({ credit: 0 });
  await r.ledger.grant({ id: "g", accountId: "acme", bucket: "purchased", amountMicros: -5_000, reason: "chargeback" });
  const out = await r.call(chatBody({ model: "fast" }));
  assert.equal(out.rejection!.status, 402);
  assert.match(out.rejection!.body.error.message, /and USD 0\.00 is available\./);
  assert.ok(!out.rejection!.body.error.message.includes("-"), out.rejection!.body.error.message);
});

test("both buckets count towards the balance", async () => {
  const r = await rig({ credit: 0 });
  await r.ledger.grant({ id: "a", accountId: "acme", bucket: "included", amountMicros: 5_000_000, reason: "period" });
  const out = await r.call(chatBody({ model: "fast" }));
  assert.equal(out.rejection, undefined);
  assert.ok(r.ledger.balance("acme").included < 5_000_000, "the included bucket paid for it");
});

test("calls in flight each hold their own worst case: a second call that the first has left no room for is refused until the first settles", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const slow: Script = async function* (req, n) {
    if (n === 0) await gate;
    yield* (await answer("ok")(req, n)) as AsyncGenerator<ModelEvent, void>;
  };
  // A balance that covers one hold and not two.
  const hold = holdFor(1_000);
  const r = await rig({ alpha: slow, credit: hold + Math.floor(hold / 2) });
  const first = r.call(chatBody({ model: "fast", max_tokens: 1_000 }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(r.gateway.heldFor("acme") > 0, "the first call is holding its worst case");
  const second = await r.call(chatBody({ model: "fast", max_tokens: 1_000 }));
  assert.equal(second.rejection!.status, 402, "the second call finds the room taken");
  release();
  assert.equal((await first).rejection, undefined);
  assert.equal(r.gateway.heldFor("acme"), 0);
  assert.equal((await r.call(chatBody({ model: "fast", max_tokens: 1_000 }))).rejection, undefined, "once the first has settled there is room again");
});

test("every call in flight holds its own share: the holds add up, and one call finishing gives back only its own", async () => {
  const gates: Array<() => void> = [];
  const waits: Array<Promise<void>> = [];
  const slow: Script = async function* (req, n) {
    waits[n] ??= new Promise<void>((resolve) => (gates[n] = resolve));
    await waits[n];
    yield* (await answer("ok")(req, n)) as AsyncGenerator<ModelEvent, void>;
  };
  const hold = holdFor(1_000);
  // Room for two holds and half of a third.
  const r = await rig({ alpha: slow, credit: 2 * hold + Math.floor(hold / 2), keyOptions: { limits: { concurrent: 10, rpm: 100 } } });
  const open = (): Promise<FakeOut> => r.call(chatBody({ model: "fast", max_tokens: 1_000 }));
  const a = open();
  const b = open();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(r.gateway.heldFor("acme"), 2 * hold, "two calls in flight hold two worst cases");
  const c = await open();
  assert.equal(c.rejection!.status, 402, "with two holds out there is not room for a third");
  gates[0]!();
  await a;
  assert.equal(r.gateway.heldFor("acme"), hold, "the first call finishing gave back its own hold and left the second's");
  gates[1]!();
  await b;
  assert.equal(r.gateway.heldFor("acme"), 0);
});

test("the hold is capped, so a very large call is not refused for a balance it could reasonably cover", async () => {
  // alpha/large: 10 in and 40 out per million at 2x. Held at the full prompt and a 100,000-token answer it would be USD 8.
  const tiers = [{ name: "best", models: ["alpha/large"], max: 200_000 }];
  const r = await rig({ credit: 3_000_000, tiers, gateway: { reserveCapMicros: 2_000_000 } });
  const out = await r.call(chatBody({ model: "best", max_tokens: 100_000 }));
  assert.equal(out.rejection, undefined, "the hold is USD 2, the cap, and the balance is USD 3");
  const poor = await rig({ credit: 1_999_999, tiers, gateway: { reserveCapMicros: 2_000_000 } });
  assert.equal((await poor.call(chatBody({ model: "best", max_tokens: 100_000 }))).rejection!.status, 402);
  const exact = await rig({ credit: 2_000_000, tiers, gateway: { reserveCapMicros: 2_000_000 } });
  assert.equal((await exact.call(chatBody({ model: "best", max_tokens: 100_000 }))).rejection, undefined, "a balance equal to the hold is enough");
});

test("a call may cost more than was held, and the account is then overdrawn by that call alone and refused the next", async () => {
  const big: Script = answer("x", { usage: { input: 5_000_000, output: 1_000_000 } });
  const r = await rig({ alpha: big, credit: 10_000, gateway: { reserveCapMicros: 5_000 } });
  const out = await r.call(chatBody({ model: "fast", max_tokens: 10 }));
  assert.equal(out.rejection, undefined);
  // 5,000,000 x 1 + 1,000,000 x 4 = 9 units of cost, 13.5 charged: far more than the 10,000 millionths there were.
  assert.equal(r.ledger.balance("acme").purchased, 10_000 - 13_500_000);
  const next = await r.call(chatBody({ model: "fast" }));
  assert.equal(next.rejection!.status, 402);
});

// ---- limits ----

test("a key's daily cap stops it for the rest of the UTC day, says when it resets, and resets at midnight", async () => {
  const r = await rig({ keyOptions: { limits: { dailyCapMicros: 5_000 } }, alpha: answer("x", { usage: { input: 2_000_000, output: 0 } }), start: "2026-10-05T23:30:00.000Z" });
  assert.equal((await r.call(chatBody({ model: "fast" }))).rejection, undefined, "under the cap, so the call runs and charges USD 3");
  const out = await r.call(chatBody({ model: "fast" }));
  assert.equal(out.rejection!.status, 429);
  assert.equal(out.rejection!.body.error.type, "daily_limit_reached");
  assert.match(out.rejection!.body.error.message, /limit of USD 0\.0050 for today \(UTC\)/);
  assert.equal(out.rejection!.headers["retry-after"], String(30 * 60), "thirty minutes to midnight");
  assert.equal(r.alpha.requests.length, 1);
  r.clock.set("2026-10-06T00:00:01.000Z");
  assert.equal((await r.call(chatBody({ model: "fast" }))).rejection, undefined, "the next day it may call again");
});

test("calls are limited per key per minute, with the wait in Retry-After, and one key's calls do not use another's", async () => {
  const r = await rig({ keyOptions: { limits: { rpm: 2 } } });
  assert.equal((await r.call(chatBody({ model: "fast" }))).rejection, undefined);
  assert.equal((await r.call(chatBody({ model: "fast" }))).rejection, undefined);
  const out = await r.call(chatBody({ model: "fast" }));
  assert.equal(out.rejection!.status, 429);
  assert.equal(out.rejection!.body.error.type, "rate_limit_exceeded");
  assert.match(out.rejection!.body.error.message, /limited to 2 calls a minute\. Retry in 30s\./);
  assert.equal(out.rejection!.headers["retry-after"], "30", "two a minute is one every thirty seconds, and the wait is in seconds");
  assert.equal(classifyHttpFailure(429, "rate_limit_exceeded", out.rejection!.body.error.message), "rate_limited");
  const other = await r.account("other");
  assert.equal((await r.call(chatBody({ model: "fast" }), other.key)).rejection, undefined);
});

test("a key may have only so many calls open at once, and a finished call makes room", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const slow: Script = async function* (req, n) {
    await gate;
    yield* (await answer("ok")(req, n)) as AsyncGenerator<ModelEvent, void>;
  };
  const r = await rig({ alpha: slow, keyOptions: { limits: { concurrent: 1 } } });
  const first = r.call(chatBody({ model: "fast" }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = await r.call(chatBody({ model: "fast" }));
  assert.equal(second.rejection!.status, 429);
  assert.equal(second.rejection!.body.error.type, "too_many_requests");
  assert.equal(second.rejection!.headers["retry-after"], "1");
  release();
  await first;
  assert.equal((await r.call(chatBody({ model: "fast" }))).rejection, undefined);
  assert.equal(r.gateway.concurrency.inFlight(r.key.keyId), 0);
});

test("a key that sets no limit may have sixteen calls open at once and not seventeen", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const slow: Script = async function* (req, n) {
    await gate;
    yield* (await answer("ok")(req, n)) as AsyncGenerator<ModelEvent, void>;
  };
  const r = await rig({ alpha: slow, gateway: { defaultRpm: 1_000 } });
  const open = Array.from({ length: 16 }, () => r.call(chatBody({ model: "fast" })));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(r.gateway.concurrency.inFlight(r.key.keyId), 16);
  const refused = await r.call(chatBody({ model: "fast" }));
  assert.equal(refused.rejection!.status, 429);
  assert.match(refused.rejection!.body.error.message, /already has 16 calls in flight/);
  release();
  const finished = await Promise.all(open);
  assert.ok(finished.every((o) => o.rejection === undefined));
});

test("a key that sets no limit may make a hundred and twenty calls a minute and not a hundred and twenty-first", async () => {
  const r = await rig({ gateway: { defaultConcurrent: 5 } });
  for (let i = 0; i < 120; i++) assert.equal((await r.call(chatBody({ model: "fast", stream: false }))).rejection, undefined, `call ${i + 1}`);
  const refused = await r.call(chatBody({ model: "fast", stream: false }));
  assert.equal(refused.rejection!.status, 429);
  assert.match(refused.rejection!.body.error.message, /limited to 120 calls a minute/);
});

test("the default limits apply to a key that sets none", async () => {
  const r = await rig({ gateway: { defaultRpm: 1 } });
  assert.equal((await r.call(chatBody({ model: "fast" }))).rejection, undefined);
  assert.equal((await r.call(chatBody({ model: "fast" }))).rejection!.status, 429);
});

// ---- when a provider fails ----

test("a provider that cannot answer is passed over for the next one in the tier, and the spend names the one that did", async () => {
  const r = await rig({
    alpha: async function* () {
      throw unavailable();
    },
  });
  const out = await r.call(chatBody({ model: "balanced" }));
  assert.equal(out.rejection, undefined);
  assert.equal(out.text, "Done by beta.");
  const [spend] = spends(r.store);
  assert.equal(spend!.provider, "beta");
  assert.equal(spend!.model, "other");
  assert.equal(spend!.alias, "balanced");
  const failed = r.logs.find((l) => l.msg === "a provider could not answer")!;
  assert.deepEqual({ provider: failed.provider, kind: failed.kind, status: failed.status, tryingNext: failed.tryingNext, level: failed.level }, { provider: "alpha", kind: "unavailable", status: 503, tryingNext: true, level: "warn" });
  assert.equal(r.beta.requests[0]!.model, "other");
});

test("every kind of failure before the first word is passed over: busy, down, unreachable, refused account, refused key, slow, and the request refused", async () => {
  const failures: Array<[string, () => Error]> = [
    ["rate_limited", () => new ProviderError("a", { kind: "rate_limited", status: 429, detail: "slow" })],
    ["unavailable", unavailable],
    ["unreachable", () => new ProviderError("a", { kind: "unreachable", detail: "Unable to connect" })],
    ["billing", () => new ProviderError("a", { kind: "billing", status: 402, detail: "credit balance is too low" })],
    ["auth", () => new ProviderError("a", { kind: "auth", status: 401, detail: "bad key" })],
    ["invalid_request", () => new ProviderError("a", { kind: "invalid_request", status: 404, detail: "model not found" })],
    ["context_overflow", () => new ProviderError("a", { kind: "context_overflow", status: 400, detail: "too long" })],
    ["timeout", () => new ProviderTimeoutError("a", "waiting", 1)],
    ["unexpected", () => new TypeError("a bug")],
  ];
  for (const [name, make] of failures) {
    const r = await rig({
      alpha: async function* () {
        throw make();
      },
    });
    const out = await r.call(chatBody({ model: "balanced" }));
    assert.equal(out.rejection, undefined, name);
    assert.equal(spends(r.store)[0]?.provider, "beta", name);
    if (name === "unexpected") {
      const logged = r.logs.find((l) => l.msg === "a provider could not answer")!;
      assert.equal(logged.error, "TypeError: a bug", "a failure that is not a provider's own is logged with what it was");
      assert.equal(logged.kind, undefined);
    }
  }
});

test("when every provider in the tier fails, the caller is told the same thing whichever they were, and nothing about them", async () => {
  const detail = "Incorrect API key provided: sk-live-ABCDEFGHIJKLMNOP for organisation org-12345678 at alpha.example";
  const r = await rig({
    alpha: async function* () {
      throw new ProviderError("alpha.example", { kind: "auth", status: 401, detail });
    },
    beta: async function* () {
      throw new ProviderError("beta.example", { kind: "billing", status: 402, detail: "credit balance is too low" });
    },
  });
  const out = await r.call(chatBody({ model: "balanced" }));
  assert.equal(out.rejection!.status, 503);
  assert.equal(out.rejection!.body.error.type, "service_unavailable");
  const shown = JSON.stringify(out.rejection);
  for (const secret of ["alpha", "beta", "sk-live", "org-1234", "credit balance", "Incorrect API key"]) assert.ok(!shown.includes(secret), `the caller was told '${secret}'`);
  assert.equal(classifyHttpFailure(503, "service_unavailable", out.rejection!.body.error.message), "unavailable");
  const alerts = r.logs.filter((l) => l.level === "error" && l.alert);
  assert.equal(alerts.length, 2, "an operator is alerted for a refused key and a refused account");
  assert.ok(alerts.every((l) => !JSON.stringify(l).includes("sk-live-ABCDEFGHIJKLMNOP")), "even the log does not keep a key a provider echoed");
  assert.equal(spends(r.store).length, 0, "a call that was never answered is not billed");
  assert.equal(r.gateway.heldFor("acme"), 0);
});

test("when the providers fail in different ways the caller is told about the first, the one the tier prefers", async () => {
  const r = await rig({
    alpha: async function* () {
      throw new ProviderError("a", { kind: "rate_limited", status: 429, detail: "slow", retryAfterMs: 4_000 });
    },
    beta: async function* () {
      throw unavailable();
    },
  });
  const out = await r.call(chatBody({ model: "balanced" }));
  assert.equal(out.rejection!.status, 429);
  assert.equal(out.rejection!.headers["retry-after"], "4");
  assert.equal(r.logs.filter((l) => l.msg === "a provider could not answer").length, 2, "both failures are in the log");
});

test("a rate limit at every provider is passed on as a rate limit, with the wait the provider asked for", async () => {
  const limited = async function* (): AsyncGenerator<ModelEvent, void> {
    throw new ProviderError("a", { kind: "rate_limited", status: 429, detail: "slow down", retryAfterMs: 7_300 });
  };
  const r = await rig({ alpha: limited, beta: limited });
  const out = await r.call(chatBody({ model: "balanced" }));
  assert.equal(out.rejection!.status, 429);
  assert.equal(out.rejection!.headers["retry-after"], "8");
  const bare = await rig({ alpha: async function* () { throw new ProviderError("a", { kind: "rate_limited", status: 429, detail: "slow" }); }, tiers: [{ name: "balanced", models: ["alpha/small"] }] });
  assert.equal((await bare.call(chatBody({ model: "balanced" }))).rejection!.headers["retry-after"], "5", "with no wait named, five seconds");
});

test("a prompt that is too long is reported as one, in words the native runtime recognises, so it shrinks the conversation and asks again", async () => {
  const r = await rig({ alpha: async function* () { throw new ProviderError("a", { kind: "context_overflow", status: 400, detail: "prompt is too long: 250000 tokens" }); }, tiers: [{ name: "balanced", models: ["alpha/small"] }] });
  const out = await r.call(chatBody({ model: "balanced" }));
  assert.equal(out.rejection!.status, 400);
  assert.equal(classifyHttpFailure(400, out.rejection!.body.error.type, out.rejection!.body.error.message), "context_overflow");
  assert.equal(classifyHttpFailure(400, undefined, out.rejection!.body.error.message), "context_overflow", "the words alone say it, for a reader that is not given the type");
  assert.equal(classifyHttpFailure(400, out.rejection!.body.error.type, ""), "context_overflow", "and so does the type alone");
  assert.ok(!JSON.stringify(out.rejection).includes("250000"));
});

test("a request the provider rejects is a 400 with the provider's reason, cleaned of anything that looks like a credential", async () => {
  const r = await rig({
    alpha: async function* () {
      throw new ProviderError("a", { kind: "invalid_request", status: 400, detail: "tools[3].function.parameters: invalid schema for key sk-abcdefghijklmnop" });
    },
    tiers: [{ name: "balanced", models: ["alpha/small"] }],
  });
  const out = await r.call(chatBody({ model: "balanced" }));
  assert.equal(out.rejection!.status, 400);
  assert.match(out.rejection!.body.error.message, /^The model rejected the request: tools\[3\]\.function\.parameters: invalid schema for key \[redacted\]$/);
});

test("whatever a provider's reason echoes of an account, a project, a session or a key is removed, and a long reason is cut", async () => {
  const echoed = ["sk-abcdefghijklmnop", "pk_abcdefghijklmnop", "rk-abcdefghijklmnop", "key_abcdefghijklmnop", "org-abcdefghijklmnop", "proj_abcdefghijklmnop", "sess-abcdefghijklmnop"];
  const r = await rig({
    alpha: async function* () {
      throw new ProviderError("a", { kind: "invalid_request", status: 400, detail: `rejected for ${echoed.join(" and ")}. ${"A long explanation. ".repeat(40)}` });
    },
    tiers: [{ name: "balanced", models: ["alpha/small"] }],
  });
  const message = (await r.call(chatBody({ model: "balanced" }))).rejection!.body.error.message as string;
  for (const secret of echoed) assert.ok(!message.includes(secret), `the message shows ${secret}`);
  assert.equal((message.match(/\[redacted\]/g) ?? []).length, echoed.length);
  assert.ok(message.length <= "The model rejected the request: ".length + 300, `${message.length} characters`);
});

test("a timeout is a 504, and anything the gateway did not expect is a 502 that says nothing of what happened", () => {
  assert.equal(toWireError(new ProviderTimeoutError("a", "reading the response", 5)).status, 504);
  const odd = toWireError(new TypeError("cannot read properties of undefined"));
  assert.equal(odd.status, 502);
  assert.ok(!odd.message.includes("undefined"));
  const own = new WireError(418, "teapot", "short and stout");
  assert.equal(toWireError(own), own);
});

test("once the model has begun to answer there is no passing over: a failure then is an error frame in the stream, no later provider is asked, and the customer is not charged", async () => {
  const r = await rig({
    alpha: async function* () {
      yield { kind: "text", delta: "Half an answ" };
      yield { kind: "text", delta: "er" };
      throw unavailable();
    },
  });
  const out = await r.call(chatBody({ model: "balanced" }));
  assert.equal(out.text, "Half an answer");
  const last = out.frames.slice(-2);
  assert.deepEqual(last[0], { error: { message: "The model service is unavailable at the moment. Try again shortly.", type: "service_unavailable", code: 503, param: null } });
  assert.equal(last[1], "[DONE]");
  assert.equal(out.kinds.at(-1), "close");
  assert.equal(out.rejection, undefined, "there is no status to change: the stream was open");
  assert.equal(r.beta.requests.length, 0);
  const [spend] = spends(r.store);
  assert.equal(spend!.outcome, "failed");
  assert.equal(spend!.chargeMicros, 0);
  assert.equal(spend!.estimated, true);
  const failure = r.logs.find((l) => l.msg === "a provider could not answer")!;
  assert.deepEqual({ provider: failure.provider, kind: failure.kind, status: failure.status, tryingNext: failure.tryingNext }, { provider: "alpha", kind: "unavailable", status: 503, tryingNext: false }, "a failure after the answer began is logged too, and nothing is tried next");
  assert.ok(spend!.costMicros > 0, "what it cost the service is recorded, so the loss is visible");
  assert.ok(spend!.usage.output >= 3, "estimated from the text that was sent");
  assert.equal(r.ledger.balance("acme").purchased, 100_000_000);
});

test("a failure after the answer began, for a caller that did not ask for a stream, is a status, since nothing has been sent", async () => {
  const r = await rig({
    alpha: async function* () {
      yield { kind: "text", delta: "Half" };
      throw unavailable();
    },
    tiers: [{ name: "balanced", models: ["alpha/small"] }],
  });
  const out = await r.call(chatBody({ model: "balanced", stream: false }));
  assert.equal(out.rejection!.status, 503);
  assert.equal(spends(r.store)[0]!.outcome, "failed");
});

test("a response that ends without the model finishing is a failure, not a short answer", async () => {
  const r = await rig({
    alpha: async function* () {
      yield { kind: "text", delta: "no end" };
    },
    tiers: [{ name: "balanced", models: ["alpha/small"] }],
  });
  const out = await r.call(chatBody({ model: "balanced", stream: false }));
  assert.equal(out.rejection!.status, 503);
  assert.equal(spends(r.store)[0]!.outcome, "failed");
});

// ---- the caller goes away, or the provider goes quiet ----

test("a caller that hangs up mid-answer is charged for what was produced, estimated, and the provider is told to stop", async () => {
  let providerSawAbort = false;
  const r = await rig({
    alpha: async function* (req) {
      yield { kind: "text", delta: "x".repeat(400) };
      try {
        await never(req.signal);
      } catch (err) {
        providerSawAbort = true;
        throw err;
      }
    },
    tiers: [{ name: "balanced", models: ["alpha/small"] }],
  });
  const out = new FakeOut();
  const done = r.gateway.chat(r.key, chatBody({ model: "balanced" }), out);
  await new Promise((resolve) => setTimeout(resolve, 20));
  out.hangUp();
  await done;
  assert.ok(providerSawAbort, "the provider's call was aborted, so it stops generating");
  const [spend] = spends(r.store);
  assert.equal(spend!.outcome, "aborted");
  assert.equal(spend!.estimated, true);
  assert.equal(spend!.usage.output, 100, "400 characters is about 100 tokens");
  assert.ok(spend!.usage.input > 0);
  assert.deepEqual({ costMicros: spend!.costMicros, chargeMicros: spend!.chargeMicros }, r.prices.price("alpha/small", spend!.usage), "priced from the table at the usage that was estimated");
  assert.ok(spend!.chargeMicros > 0);
  assert.equal(out.kinds.at(-1), "frame", "nothing more was written to a caller who is gone");
  assert.equal(r.gateway.heldFor("acme"), 0);
  assert.equal(r.gateway.concurrency.inFlight(r.key.keyId), 0);
});

test("a caller that hangs up before the provider has said anything is charged the prompt as estimated", async () => {
  const r = await rig({
    alpha: async function* (req) {
      await never(req.signal);
    },
    tiers: [{ name: "balanced", models: ["alpha/small"] }],
  });
  const out = new FakeOut();
  const done = r.gateway.chat(r.key, chatBody({ model: "balanced" }), out);
  await new Promise((resolve) => setTimeout(resolve, 20));
  out.hangUp();
  await done;
  const [spend] = spends(r.store);
  assert.equal(spend!.outcome, "aborted");
  assert.equal(spend!.usage.output, 0);
  assert.ok(spend!.usage.input > 0 && spend!.chargeMicros > 0, "a prompt sent and abandoned is not free: the provider has read it");
});

test("a caller that is gone before the call starts gets nothing and costs nothing", async () => {
  const r = await rig();
  const out = new FakeOut();
  out.hangUp();
  await r.gateway.chat(r.key, chatBody({ model: "fast" }), out);
  assert.equal(r.alpha.requests.length, 0);
  assert.equal(spends(r.store).length, 0);
  assert.deepEqual(out.events, []);
  assert.equal(r.gateway.heldFor("acme"), 0);
});

test("a call that takes longer than the deadline is ended: a 504 if it had said nothing, an error frame and a failed spend if it had begun", async () => {
  const silent = await rig({ alpha: async function* (req) { await never(req.signal); }, tiers: [{ name: "balanced", models: ["alpha/small"] }], gateway: { deadlineMs: 30 } });
  const quiet = await silent.call(chatBody({ model: "balanced", stream: false }));
  assert.equal(quiet.rejection!.status, 504);
  assert.equal(quiet.rejection!.body.error.type, "upstream_timeout");
  assert.equal(spends(silent.store).length, 0);
  const stalled = await rig({
    alpha: async function* (req) {
      yield { kind: "text", delta: "begun" };
      await never(req.signal);
    },
    tiers: [{ name: "balanced", models: ["alpha/small"] }],
    gateway: { deadlineMs: 30 },
  });
  const out = await stalled.call(chatBody({ model: "balanced" }));
  assert.equal(out.text, "begun");
  assert.equal(out.frames.at(-2).error.code, 504);
  assert.equal(spends(stalled.store)[0]!.outcome, "failed");
  assert.equal(spends(stalled.store)[0]!.chargeMicros, 0);
});

test("a stream is opened when the provider's first word is slow, and kept open with comments until it comes", async () => {
  const r = await rig({
    alpha: async function* (req, n) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      yield* (await answer("late but whole")(req, n)) as AsyncGenerator<ModelEvent, void>;
    },
    tiers: [{ name: "balanced", models: ["alpha/small"] }],
    gateway: { commitMs: 20, keepAliveMs: 15 },
  });
  const out = await r.call(chatBody({ model: "balanced" }));
  const kinds = out.kinds;
  assert.equal(kinds[0], "open", "the stream was opened before the first frame");
  assert.ok(kinds.filter((k) => k === "comment").length >= 2, `kept alive while it waited: ${kinds.join(",")}`);
  assert.ok(kinds.indexOf("comment") < kinds.indexOf("frame"));
  assert.equal(out.text, "late but whole");
  assert.equal(kinds.filter((k) => k === "open").length, 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(out.kinds.filter((k) => k === "comment").length, kinds.filter((k) => k === "comment").length, "no comments after the stream ended");
});

test("a provider that is quick is not preceded by comments, and a stream that has been opened and then fails before the first word is an error frame", async () => {
  const quick = await rig({ gateway: { commitMs: 20, keepAliveMs: 15 } });
  assert.ok(!(await quick.call(chatBody({ model: "fast" }))).kinds.includes("comment"));
  const slowFail = await rig({
    alpha: async function* () {
      await new Promise((resolve) => setTimeout(resolve, 80));
      throw unavailable();
    },
    tiers: [{ name: "balanced", models: ["alpha/small"] }],
    gateway: { commitMs: 20, keepAliveMs: 1_000 },
  });
  const out = await slowFail.call(chatBody({ model: "balanced" }));
  assert.equal(out.kinds[0], "open");
  assert.equal(out.rejection, undefined);
  assert.equal(out.frames.at(-2).error.code, 503);
  assert.equal(spends(slowFail.store).length, 0, "nothing was produced, so nothing is recorded");
});

test("a call leaves no timer behind, whichever way it ends", async () => {
  const timers = (): number => process.getActiveResourcesInfo().filter((t) => t === "Timeout").length;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
  for (const options of [
    { alpha: answer("ok") },
    { alpha: async function* (): AsyncGenerator<ModelEvent, void> { throw unavailable(); } },
    { alpha: async function* (): AsyncGenerator<ModelEvent, void> { yield { kind: "text", delta: "x" }; throw unavailable(); } },
  ]) {
    const r = await rig({ ...options, tiers: [{ name: "fast", models: ["alpha/small"] }], gateway: { commitMs: 60_000, keepAliveMs: 60_000, deadlineMs: 120_000 } });
    await settle();
    const before = timers();
    await r.call(chatBody({ model: "fast" }));
    await r.call(chatBody({ model: "fast", stream: false }));
    await settle();
    assert.equal(timers(), before, "the deadline, the commit timer and the keep-alive were all cleared");
  }
});

test("a call that did not ask for a stream is never opened as one, however slow the provider is", async () => {
  const slow: Script = async function* (req, n) {
    await new Promise((resolve) => setTimeout(resolve, 80));
    yield* (await answer("late")(req, n)) as AsyncGenerator<ModelEvent, void>;
  };
  const r = await rig({ alpha: slow, gateway: { commitMs: 10, keepAliveMs: 10 } });
  const out = await r.call(chatBody({ model: "fast", stream: false }));
  assert.deepEqual(out.kinds, ["json"], "a status and a body, with nothing sent before them");
});

test("a stream that has been opened is kept alive at the gateway's own pace, which is every fifteen seconds unless it is told otherwise", async () => {
  const slow: Script = async function* (req, n) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    yield* (await answer("late")(req, n)) as AsyncGenerator<ModelEvent, void>;
  };
  const r = await rig({ alpha: slow, gateway: { commitMs: 20, keepAliveMs: undefined } });
  const out = await r.call(chatBody({ model: "fast" }));
  assert.equal(out.kinds[0], "open");
  assert.equal(out.kinds.filter((k) => k === "comment").length, 0, "in a hundred milliseconds nothing is due");
});

test("a caller that hangs up counts what the model had produced of every kind: its text, its reasoning and its tool calls", async () => {
  const hangsAfter = (...events: ModelEvent[]): Script =>
    async function* (req) {
      for (const e of events) yield e;
      await untilAborted(req.signal);
    };
  const estimate = async (script: Script): Promise<number> => {
    const r = await rig({ alpha: script, tiers: [{ name: "fast", models: ["alpha/small"] }] });
    const out = new FakeOut();
    const done = r.gateway.chat(r.key, chatBody({ model: "fast" }), out);
    await new Promise((resolve) => setTimeout(resolve, 40));
    out.hangUp();
    await done;
    return spends(r.store)[0]!.usage.output;
  };
  assert.equal(await estimate(hangsAfter({ kind: "text", delta: "x".repeat(400) })), 100);
  assert.equal(await estimate(hangsAfter({ kind: "reasoning", delta: "y".repeat(800) })), 200);
  const call = { id: "c1", name: "Write", args: { file_path: "a".repeat(100) } };
  assert.equal(await estimate(hangsAfter({ kind: "tool_call", call })), Math.ceil(("Write".length + JSON.stringify(call.args).length) / 4));
  assert.equal(await estimate(hangsAfter({ kind: "text", delta: "x".repeat(40) }, { kind: "reasoning", delta: "y".repeat(40) }, { kind: "tool_call", call: { id: "c", name: "R", args: {} } })), Math.ceil((40 + 40 + 1 + 2) / 4), "added up across the three kinds");
});

test("the provider's own stream is closed when the gateway stops reading it, so a connection it holds is released", async () => {
  let closed = false;
  const r = await rig({
    alpha: async function* () {
      try {
        yield { kind: "text", delta: "one" };
        yield { kind: "text", delta: "two" };
        yield { kind: "text", delta: "three" };
      } finally {
        closed = true;
      }
    },
    tiers: [{ name: "fast", models: ["alpha/small"] }],
  });
  const out = new FakeOut();
  let frames = 0;
  const frame = out.frame.bind(out);
  out.frame = (data) => {
    if (++frames === 3) throw new Error("the connection broke");
    return frame(data);
  };
  await r.gateway.chat(r.key, chatBody({ model: "fast" }), out);
  assert.equal(closed, true, "the generator was finished off and not left suspended");
  assert.equal(spends(r.store)[0]!.outcome, "failed");
});

test("a call that has been answered is never answered again, even if closing it goes wrong", async () => {
  const r = await rig();
  const out = new FakeOut();
  const frame = out.frame.bind(out);
  out.frame = (data) => {
    if (data === "[DONE]") throw new Error("the socket was closed under us");
    return frame(data);
  };
  await r.gateway.chat(r.key, chatBody({ model: "fast" }), out);
  assert.equal(out.rejection, undefined, "no status after a stream");
  assert.ok(!out.frames.some((f) => typeof f === "object" && f.error), "and no error event after the answer");
  assert.equal(spends(r.store)[0]!.outcome, "ok");
  assert.ok(r.logs.some((l) => l.msg === "unexpected failure"), "it is in the log, for the operator");
});

test("a refusal is sent once, even when sending it goes wrong", async () => {
  const r = await rig({ credit: 0 });
  const out = new FakeOut();
  out.reject = (status, body, headers = {}) => {
    out.events.push({ kind: "reject", status, body, headers });
    throw new Error("the socket was closed under us");
  };
  await r.gateway.chat(r.key, chatBody({ model: "fast" }), out);
  assert.equal(out.events.filter((e) => e.kind === "reject").length, 1);
});

// ---- the ledger ----

test("when the ledger cannot be written the gateway takes no more calls, and says it is the service and not the caller", async () => {
  const r = await rig();
  r.store.failure = new Error("disk full");
  const out = await r.call(chatBody({ model: "fast" }));
  assert.equal(out.rejection!.status, 503);
  assert.match(out.rejection!.body.error.message, /cannot record usage/);
  assert.equal(r.alpha.requests.length, 0);
});

test("a spend that cannot be recorded after a streamed answer is logged in full for the operator, and the stream still ends", async () => {
  const r = await rig();
  const append = r.store.append.bind(r.store);
  r.store.append = async (e) => {
    if (e.type === "spend") {
      r.store.failure = new Error("disk full");
      throw r.store.failure;
    }
    await append(e);
  };
  const out = await r.call(chatBody({ model: "fast" }));
  assert.equal(out.frames.at(-1), "[DONE]", "the caller already has the answer");
  assert.ok(!out.frames.some((f) => typeof f === "object" && f.error), "and is not handed an error after it");
  assert.ok(out.frames.some((f) => typeof f === "object" && f.usage), "with its usage");
  assert.equal(out.rejection, undefined);
  const lost = r.logs.find((l) => l.msg === "a spend could not be recorded")!;
  assert.equal(lost.level, "error");
  assert.match(String(lost.alert), /reconcile this call from the log/);
  assert.equal((lost.spend as any).accountId, "acme");
  assert.ok((lost.spend as any).chargeMicros > 0);
  assert.equal((await r.call(chatBody({ model: "fast" }))).rejection!.status, 503, "and the next call is refused");
});

test("a spend that cannot be recorded for a call that was not streamed is a 503, not an answer nobody is billed for", async () => {
  const r = await rig();
  const append = r.store.append.bind(r.store);
  r.store.append = async (e) => {
    if (e.type === "spend") {
      r.store.failure = new Error("disk full");
      throw r.store.failure;
    }
    await append(e);
  };
  const out = await r.call(chatBody({ model: "fast", stream: false }));
  assert.equal(out.rejection!.status, 503);
  assert.equal(out.completion, undefined);
});

// ---- things that must not leak, or break ----

test("an unexpected failure inside the gateway is a 500 that says only that, with the detail in the log, and nothing is left held", async () => {
  const r = await rig();
  const original = r.ledger.balance.bind(r.ledger);
  r.ledger.balance = () => {
    throw new RangeError("a bug in the gateway");
  };
  const out = await r.call(chatBody({ model: "fast" }));
  r.ledger.balance = original;
  assert.equal(out.rejection!.status, 500);
  assert.equal(out.rejection!.body.error.type, "internal_error");
  assert.ok(!JSON.stringify(out.rejection).includes("a bug"));
  assert.ok(r.logs.some((l) => l.msg === "unexpected failure" && /a bug in the gateway/.test(String(l.error))));
  assert.equal(r.gateway.concurrency.inFlight(r.key.keyId), 0);
  assert.equal(r.gateway.heldFor("acme"), 0);
});

test("neither the prompt, nor the answer, nor the key is ever written to the log", async () => {
  const r = await rig({ alpha: answer("The confidential answer.") });
  await r.call(chatBody({ model: "fast", messages: [{ role: "user", content: "The confidential prompt." }] }));
  await r.call(chatBody({ model: "nope" }));
  await r.call(chatBody({ n: 4 }));
  const text = JSON.stringify(r.logs);
  assert.ok(r.logs.length > 0);
  for (const secret of ["confidential prompt", "confidential answer", r.token, r.token.split("_").at(-1)!]) assert.ok(!text.includes(secret), `the log holds '${secret}'`);
});

test("a failed call still releases its slot and what it held, whatever way it failed", async () => {
  for (const alpha of [
    async function* (): AsyncGenerator<ModelEvent, void> {
      throw unavailable();
    },
    async function* (): AsyncGenerator<ModelEvent, void> {
      yield { kind: "text", delta: "x" };
      throw unavailable();
    },
  ]) {
    const r = await rig({ alpha, tiers: [{ name: "balanced", models: ["alpha/small"] }] });
    await r.call(chatBody({ model: "balanced" }));
    await r.call(chatBody({ model: "balanced", stream: false }));
    assert.equal(r.gateway.concurrency.inFlight(r.key.keyId), 0);
    assert.equal(r.gateway.heldFor("acme"), 0);
  }
});

test("the answer of a model that reports no usage is billed on an estimate, never for nothing", async () => {
  const noUsage: Script = async function* () {
    yield { kind: "text", delta: "x".repeat(40) };
    yield { kind: "end", result: result({ text: "x".repeat(40), usage: { ...zeroUsage, input: 77, output: 10, estimated: true } }) };
  };
  const r = await rig({ alpha: noUsage });
  await r.call(chatBody({ model: "fast" }));
  const [spend] = spends(r.store);
  assert.equal(spend!.estimated, true);
  assert.equal(spend!.usage.input, 77);
  assert.ok(spend!.chargeMicros > 0);
});
