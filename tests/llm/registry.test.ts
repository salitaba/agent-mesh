import { test } from "node:test";
import assert from "node:assert/strict";
import { AnthropicProvider, OpenAiCompatibleProvider, createProvider, defaultContextWindow, isProviderKind, parseModelRef } from "../../packages/llm/src/index";

test("a provider is built from its kind, and a kind that does not exist is refused by name", () => {
  assert.ok(createProvider({ kind: "anthropic", apiKey: "k" }) instanceof AnthropicProvider);
  assert.ok(createProvider({ kind: "openai-compatible", baseUrl: "http://localhost:11434/v1" }) instanceof OpenAiCompatibleProvider);
  assert.throws(() => createProvider({ kind: "openai-compatible" }), /needs a base_url/);
  assert.throws(() => createProvider({ kind: "palm" as never }), /unknown provider kind 'palm'/);
  assert.equal(isProviderKind("anthropic"), true);
  assert.equal(isProviderKind("palm"), false);
});

test("the endpoint of a provider is named for error messages", () => {
  assert.equal(createProvider({ kind: "openai-compatible", baseUrl: "https://api.example.com/v1" }).endpoint, "api.example.com");
  assert.equal(createProvider({ kind: "openai-compatible", baseUrl: "https://api.example.com/v1", name: "groq" }).endpoint, "groq");
  assert.equal(createProvider({ kind: "anthropic" }).endpoint, "api.anthropic.com");
});

test("a model ref splits on the first slash, and only when the first segment is a provider that is configured", () => {
  const providers = ["openai", "openrouter", "local"];
  assert.deepEqual(parseModelRef("openai/gpt-x", providers), { provider: "openai", model: "gpt-x" });
  assert.deepEqual(parseModelRef("openrouter/anthropic/claude-x", providers), { provider: "openrouter", model: "anthropic/claude-x" });
  assert.deepEqual(parseModelRef("meta-llama/llama-3", providers), { model: "meta-llama/llama-3" });
  assert.deepEqual(parseModelRef("gpt-x", providers), { model: "gpt-x" });
  assert.deepEqual(parseModelRef("openai/", providers), { model: "openai/" });
  assert.deepEqual(parseModelRef("  local/qwen  ", new Set(providers)), { provider: "local", model: "qwen" });
});

test("the assumed window is the smaller of what current models offer", () => {
  assert.equal(defaultContextWindow("anthropic"), 200_000);
  assert.equal(defaultContextWindow("openai-compatible"), 128_000);
});
