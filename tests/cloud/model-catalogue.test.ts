import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { ServiceError, checkModelAgainstCatalogue, modelIdsIn, nameNotFoundMessage } from "../../packages/cloud/src/index";
import { plane } from "./support";

const KEY = "«redacted:sk-…»";
const OPENROUTER = { provider: "openai-compatible" as const, model: "openai/gpt-4o", baseUrl: "https://openrouter.ai/api/v1", key: KEY };
const ANTHROPIC = { provider: "anthropic" as const, model: "claude-sonnet-4-5", key: KEY };

/** A provider that answers with a given body: what a live catalogue read looks like. */
const answering = (body: unknown, status = 200, onCall?: (url: string, headers: Record<string, string>) => void): typeof fetch =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    onCall?.(String(url), (init?.headers ?? {}) as Record<string, string>);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

const refusal = async (run: () => unknown): Promise<ServiceError> => {
  try {
    await run();
  } catch (err) {
    assert.ok(err instanceof ServiceError, String(err));
    return err;
  }
  throw new Error("it was accepted");
};

// ---- reading a catalogue ----

test("a model list is read from every shape a provider answers with, and a body with no list in it yields nothing", () => {
  assert.deepEqual(modelIdsIn({ data: [{ id: "openai/gpt-4o" }, { id: "anthropic/claude-sonnet-4-5" }] }), ["openai/gpt-4o", "anthropic/claude-sonnet-4-5"]);
  assert.deepEqual(modelIdsIn({ models: [{ name: "gemini-2.5-pro" }] }), ["gemini-2.5-pro"]);
  assert.deepEqual(modelIdsIn({ data: { models: [{ id: "a" }, { id: "a" }, { id: "b" }] } }), ["a", "b"], "the same id twice is one model");
  assert.deepEqual(modelIdsIn(["x", " y "]), ["x", "y"]);
  // Everything that is not a list of models: pagination, an error, a body this cannot read.
  assert.deepEqual(modelIdsIn({ error: { message: "bad key" } }), []);
  assert.deepEqual(modelIdsIn({ object: "list", has_more: false }), []);
  assert.deepEqual(modelIdsIn(null), []);
  assert.deepEqual(modelIdsIn("not json at all"), []);
});

test("the check reads the provider's own address, with the key in the header that provider expects", async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const seen = (url: string, headers: Record<string, string>) => calls.push({ url, headers });
  await checkModelAgainstCatalogue(OPENROUTER, { fetchImpl: answering({ data: [{ id: "openai/gpt-4o" }] }, 200, seen) });
  await checkModelAgainstCatalogue(ANTHROPIC, { fetchImpl: answering({ data: [{ id: "claude-sonnet-4-5" }] }, 200, seen) });
  assert.deepEqual(calls.map((c) => c.url), ["https://openrouter.ai/api/v1/models", "https://api.anthropic.com/v1/models?limit=1000"]);
  assert.equal(calls[0]!.headers.authorization, `Bearer ${KEY}`);
  assert.equal(calls[1]!.headers["x-api-key"], KEY);
  assert.equal(calls[1]!.headers.authorization, undefined, "the key is not sent twice in the wrong header");
});

// ---- what is accepted, and what is not ----

test("a model the provider serves passes, and a provider prefix on either side is not a difference", async () => {
  const served = answering({ data: [{ id: "deepseek-v4.1-flash" }] });
  assert.equal(await checkModelAgainstCatalogue({ provider: "openai-compatible", model: "deepseek-v4.1-flash", baseUrl: "https://ai.alitaba.me/v1", key: KEY }, { fetchImpl: served }), null);
  assert.equal(await checkModelAgainstCatalogue({ provider: "openai-compatible", model: "opencode-go/deepseek-v4.1-flash", baseUrl: "https://ai.alitaba.me/v1", key: KEY }, { fetchImpl: served }), null, "the name with its provider prefix");
  const prefixed = answering({ data: [{ id: "opencode-go/deepseek-v4.1-flash" }] });
  assert.equal(await checkModelAgainstCatalogue({ provider: "openai-compatible", model: "deepseek-v4.1-flash", baseUrl: "https://ai.alitaba.me/v1", key: KEY }, { fetchImpl: prefixed }), null, "and the name without it");
  assert.equal(await checkModelAgainstCatalogue({ provider: "openai-compatible", model: "DEEPSEEK-V4.1-FLASH", baseUrl: "https://ai.alitaba.me/v1", key: KEY }, { fetchImpl: served }), null, "case is not a difference");
});

test("a model the provider does not serve is refused, and the nearest names are in the refusal", async () => {
  const body = { data: [{ id: "deepseek-v4.1-flash" }, { id: "deepseek-v4.1" }, { id: "qwen3-coder" }] };
  const input = { provider: "openai-compatible" as const, model: "deepseek-4.1-flash", baseUrl: "https://ai.alitaba.me/v1", key: KEY };
  const message = (await checkModelAgainstCatalogue(input, { fetchImpl: answering(body) })) ?? "";
  assert.ok(message.includes("'deepseek-4.1-flash'"), message);
  assert.ok(message.includes("deepseek-v4.1-flash"), "the id one character away is offered");
  assert.ok(!message.includes("qwen3-coder"), "and the ones that are nothing like it are not");
  assert.ok(!message.includes(KEY), "the key is not in what the customer is shown");
  assert.ok(message.includes("3 models"), message);
  // A name like nothing in the catalogue says so rather than guessing.
  const nowhere = (await checkModelAgainstCatalogue({ ...input, model: "zzz-nonexistent-model" }, { fetchImpl: answering(body) })) ?? "";
  assert.ok(nowhere.includes("none is close"), nowhere);
});

test("nameNotFoundMessage names the model, the size of the catalogue and what to do", () => {
  assert.match(nameNotFoundMessage("deepseek-4.1-flash", ["deepseek-v4.1-flash"]), /No model named 'deepseek-4.1-flash' there: that address lists 1 model, and the closest is 'deepseek-v4.1-flash'/);
  assert.match(nameNotFoundMessage("m", ["a", "b"]), /lists 2 models/);
});

// ---- a provider that cannot be asked is never the customer's mistake ----

test("a key is let through when the catalogue cannot be read, and only a list without the model refuses it", async () => {
  const input = { provider: "openai-compatible" as const, model: "anything-at-all", baseUrl: "https://ai.alitaba.me/v1", key: KEY };
  const notFound = await checkModelAgainstCatalogue(input, { fetchImpl: answering({ error: { message: "no such model" } }, 404) });
  assert.equal(notFound, null, "a 404 on the catalogue is not evidence about the model");
  assert.equal(await checkModelAgainstCatalogue(input, { fetchImpl: answering({ error: { message: "bad key" } }, 401) }), null);
  assert.equal(await checkModelAgainstCatalogue(input, { fetchImpl: answering({ error: "overloaded" }, 529) }), null);
  assert.equal(await checkModelAgainstCatalogue(input, { fetchImpl: answering("<html>gateway</html>") }), null, "a body that is not JSON");
  assert.equal(await checkModelAgainstCatalogue(input, { fetchImpl: answering({ data: [] }) }), null, "a list with nothing in it is not a catalogue");
  assert.equal(await checkModelAgainstCatalogue(input, { fetchImpl: answering({ object: "list" }) }), null, "an answer with no list in it at all");
  const broken = (async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  }) as unknown as typeof fetch;
  assert.equal(await checkModelAgainstCatalogue(input, { fetchImpl: broken }), null, "an unreachable provider");
  // A provider that never answers: the check gives up and lets the key through rather than hanging the save.
  const hanging = ((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch;
  const began = Date.now();
  assert.equal(await checkModelAgainstCatalogue(input, { fetchImpl: hanging, timeoutMs: 40 }), null);
  assert.ok(Date.now() - began < 5_000, "it waited for the timeout, not for the provider");
});

// ---- at the door ----

test("a workspace is not started around a model its provider does not serve", async () => {
  const p = await plane({
    hostingOnly: true,
    workspaces: { fetchImpl: answering({ data: [{ id: "opencode-go/deepseek-v4.1-flash" }] }) },
  });
  const ada = await p.account("ada@example.com");
  await p.subscribe(ada.accountId, "hosting");
  const w = await p.plane.workspaces.create(ada.accountId, "Main");
  await p.plane.workspaces.idle();

  const err = await refusal(() =>
    p.plane.workspaces.setModelKey(ada.accountId, w.workspaceId, { provider: "openai-compatible", model: "opencode-go/deepseek-4.1-flash", baseUrl: "https://ai.alitaba.me/v1", key: KEY }),
  );
  assert.deepEqual([err.status, err.code], [400, "model_not_found"]);
  assert.match(err.message, /deepseek-v4\.1-flash/, "the refusal names the model that would have worked");
  assert.ok(!fs.existsSync(p.keysFile), "no key was kept");

  const kept = await p.plane.workspaces.setModelKey(ada.accountId, w.workspaceId, { provider: "openai-compatible", model: "opencode-go/deepseek-v4.1-flash", baseUrl: "https://ai.alitaba.me/v1", key: KEY });
  assert.equal(p.plane.view(p.log.state.accounts.get(ada.accountId)!).workspaces[0]!.models!.key!.model, "opencode-go/deepseek-v4.1-flash", String(kept));
});
