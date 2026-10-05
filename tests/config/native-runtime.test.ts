import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConfigError, resolveConfig } from "../../packages/config/src/index";

/**
 * `mesh.runtime.providers`: the native runtime's providers, declared once and referred to by seats as `provider/model`.
 *
 * Everything that would otherwise fail on a seat's first turn, minutes into a mission, is checked at load: a provider with
 * no base URL, a default that names nothing, and every seat whose model cannot be placed. A key is never in the file: it
 * is named by `api_key_env`.
 */

function resolve(runtime: string, agents = "  a: { role: worker }\n  b: { role: worker }\n") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-native-cfg-"));
  fs.writeFileSync(
    path.join(dir, "mesh.yaml"),
    `version: 1
mesh:
  id: cfgtest
  goal: |
    Test.
  workspace: { path: ./workspace }
  runtime:
${runtime}
agents:
${agents}`,
    "utf8",
  );
  try {
    return resolveConfig(path.join(dir, "mesh.yaml"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const errorsOf = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ConfigError) return e.errors;
    throw e;
  }
  return [];
};

const OPENAI = `    default: native
    model: openai/model-a
    providers:
      openai: { kind: openai-compatible, base_url: "https://api.example.com/v1", api_key_env: EXAMPLE_API_KEY }
      claude: { kind: anthropic, api_key_env: CLAUDE_KEY, cache_ttl_ms: 120000 }
      local: { kind: openai-compatible, base_url: "http://localhost:11434/v1", context_window: 32000, max_retries: 1, idle_timeout_ms: 30000 }`;

test("providers, models and the native settings resolve into one spec the server builds the runtime from", () => {
  const cfg = resolve(`${OPENAI}
    default_provider: local
    designer_model: claude/model-b
    models:
      model-a: { context_window: 1000000, max_output_tokens: 8192, effort: low, temperature: 0.2 }
    native: { shell_env: minimal, extra_read_roots: [./shared], max_steps: 120 }`);
  const n = cfg.native!;
  assert.deepEqual(Object.keys(n.providers), ["openai", "claude", "local"]);
  assert.deepEqual(n.providers.openai, { kind: "openai-compatible", baseUrl: "https://api.example.com/v1", apiKeyEnv: "EXAMPLE_API_KEY" });
  assert.deepEqual(n.providers.claude, { kind: "anthropic", apiKeyEnv: "CLAUDE_KEY", cacheTtlMs: 120000 });
  assert.deepEqual(n.providers.local, { kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", contextWindow: 32000, idleTimeoutMs: 30000, maxRetries: 1 });
  assert.equal(n.defaultProvider, "local");
  assert.equal(n.designerModel, "claude/model-b");
  assert.deepEqual(n.models, { "model-a": { contextWindow: 1000000, maxOutputTokens: 8192, effort: "low", temperature: 0.2 } });
  assert.equal(n.shellEnv, "minimal");
  assert.equal(n.maxSteps, 120);
  assert.ok(path.isAbsolute(n.extraReadRoots[0]!) && n.extraReadRoots[0]!.endsWith(`${path.sep}shared`), "a root is resolved against the mesh's own directory");
  assert.equal(n.designer, "native", "the designer follows the default runtime");
  assert.equal(cfg.defaultRuntime, "native");
  assert.equal(cfg.defaultModel, "openai/model-a");
});

test("a mesh with no native settings and no native seat has no spec at all", () => {
  assert.equal(resolve("    default: stub").native, undefined);
  assert.equal(resolve("    default: claude").native, undefined);
});

test("the designer stays on Claude unless the mesh says otherwise, even beside native seats", () => {
  const cfg = resolve(`    default: claude
    providers:
      main: { kind: openai-compatible, base_url: "https://api.example.com/v1" }`, "  a: { role: worker, runtime: native, model: main/m1 }\n  b: { role: worker }\n");
  assert.equal(cfg.native?.designer, "claude");
  const explicit = resolve(`    default: claude
    designer: native
    designer_model: main/m1
    providers:
      main: { kind: openai-compatible, base_url: "https://api.example.com/v1" }`);
  assert.equal(explicit.native?.designer, "native");
});

test("a provider that cannot work is refused at load, naming where", () => {
  assert.ok(errorsOf(() => resolve("    default: native\n    model: p/m\n    providers:\n      p: { kind: openai-compatible }")).some((e) => /mesh\.runtime\.providers\.p: kind openai-compatible needs base_url/.test(e)));
  assert.ok(errorsOf(() => resolve('    default: native\n    model: p/m\n    providers:\n      p: { kind: openai-compatible, base_url: "not a url" }')).some((e) => /providers\.p\.base_url 'not a url' is not a URL/.test(e)));
  assert.ok(errorsOf(() => resolve('    default: native\n    model: p/m\n    providers:\n      p: { kind: openai-compatible, base_url: "ftp://x.example/v1" }')).some((e) => /must be an http or https URL/.test(e)));
  assert.ok(errorsOf(() => resolve("    default: native\n    model: p/m\n    providers:\n      p: { kind: grpc, base_url: x }")).length > 0, "an unknown kind fails the schema");
  assert.ok(errorsOf(() => resolve("    default: native\n    model: p/m\n    providers:\n      P_1: { kind: anthropic }")).length > 0, "a provider name is a slug, since it is the first segment of provider/model");
  assert.ok(errorsOf(() => resolve("    default: native\n    model: p/m\n    providers:\n      p: { kind: anthropic, api_key_env: 'not a name' }")).length > 0);
  assert.ok(errorsOf(() => resolve("    default: native\n    model: p/m\n    providers:\n      p: { kind: anthropic, api_key: sk-secret }")).length > 0, "a key cannot be written in the file");
});

test("a seat whose model cannot be placed is refused at load, with what to do about it", () => {
  const providers = (extra = "") => `    providers:
      a: { kind: anthropic }
      b: { kind: anthropic }${extra}`;
  assert.ok(errorsOf(() => resolve(`    default: native\n${providers()}`)).some((e) => /agents\.a has no model: set its `model:` to provider\/model/.test(e)));
  assert.ok(errorsOf(() => resolve(`    default: native\n    model: plain\n${providers()}`)).some((e) => /agents\.a: model 'plain' names no provider and there is no default; write it as provider\/model \(providers: a, b\)/.test(e)));
  assert.deepEqual(errorsOf(() => resolve(`    default: native\n    model: plain\n    default_provider: a\n${providers()}`)), []);
  assert.ok(errorsOf(() => resolve("    default: native\n    model: a/m")).some((e) => /agents\.a runs on the native runtime, but no provider is configured/.test(e)));
  assert.ok(errorsOf(() => resolve(`    default: native\n    model: a/m\n    default_provider: zzz\n${providers()}`)).some((e) => /default_provider 'zzz' names no provider; the providers are a, b/.test(e)));
});

test("a seat that names its own model is checked on its own, and only seats on native are checked at all", () => {
  const cfg = resolve("    default: stub\n    providers:\n      p: { kind: anthropic }", "  a: { role: worker, runtime: native, model: p/m1 }\n  b: { role: worker }\n");
  assert.equal(cfg.agents.a.runtime, "native");
  assert.equal(cfg.agents.b.runtime, "stub", "b runs on stub and needs no model");
  assert.ok(errorsOf(() => resolve("    default: stub\n    providers:\n      p: { kind: anthropic }", "  a: { role: worker, runtime: native }\n  b: { role: worker }\n")).some((e) => /agents\.a has no model/.test(e)));
});

test("a native designer needs a model of its own or a default", () => {
  assert.ok(errorsOf(() => resolve("    default: claude\n    designer: native\n    providers:\n      p: { kind: anthropic }")).some((e) => /the designer \(mesh\.runtime\.designer\) has no model/.test(e)));
});

test("a key sent over plain http, and an Anthropic provider with no key named, are said at load, not refused", () => {
  const cfg = resolve(`    default: native
    model: remote/m
    providers:
      remote: { kind: openai-compatible, base_url: "http://llm.example.net/v1", api_key_env: K }
      claude: { kind: anthropic }
      local: { kind: openai-compatible, base_url: "http://127.0.0.1:8000/v1", api_key_env: K2 }`);
  assert.ok(cfg.warnings.some((w) => /providers\.remote sends its API key over plain http to llm\.example\.net/.test(w)));
  assert.ok(cfg.warnings.some((w) => /providers\.claude names no api_key_env/.test(w)));
  assert.ok(!cfg.warnings.some((w) => /providers\.local/.test(w)), "loopback is not a network");
});

test("an effort field can be named, or switched off", () => {
  const cfg = resolve(`    default: native
    model: p/m
    providers:
      p: { kind: openai-compatible, base_url: "https://x.example/v1", effort_field: reasoning, max_tokens_field: max_completion_tokens, stream_usage: false, headers: { X-Org: acme } }
      q: { kind: openai-compatible, base_url: "https://y.example/v1", effort_field: false }`);
  assert.equal(cfg.native?.providers.p?.effortField, "reasoning");
  assert.equal(cfg.native?.providers.q?.effortField, false);
  assert.deepEqual(cfg.native?.providers.p?.headers, { "X-Org": "acme" });
  assert.equal(cfg.native?.providers.p?.maxTokensField, "max_completion_tokens");
  assert.equal(cfg.native?.providers.p?.streamUsage, false);
});
