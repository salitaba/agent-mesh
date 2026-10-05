/**
 * Providers by name: the one place a configuration becomes an adapter.
 *
 * A deployment names the providers it uses (`openai`, `local`, `claude`) and what kind each is; seats then refer to a model
 * as `provider/model`. The split is on the FIRST slash, so a model id that has slashes of its own (OpenRouter's
 * `openai/gpt-4o`) survives: `openrouter/openai/gpt-4o` is provider `openrouter`, model `openai/gpt-4o`.
 */
import { AnthropicProvider } from "./anthropic";
import { OpenAiCompatibleProvider } from "./openai";
import type { TransportOptions } from "./transport";
import type { LlmProvider } from "./types";

export const PROVIDER_KINDS = ["openai-compatible", "anthropic"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export function isProviderKind(value: unknown): value is ProviderKind {
  return typeof value === "string" && (PROVIDER_KINDS as readonly string[]).includes(value);
}

export interface ProviderConfig {
  kind: ProviderKind;
  baseUrl?: string;
  /** The key itself. Resolving it from an environment variable or a secret store is the loader's job, not this file's. */
  apiKey?: string;
  headers?: Record<string, string>;
  /** A label for error messages. */
  name?: string;
  defaultMaxOutputTokens?: number;
  transport?: TransportOptions;
  /** `openai-compatible` only. */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  streamUsage?: boolean;
  effortField?: string | false;
  /** `anthropic` only. */
  authHeader?: "x-api-key" | "bearer";
}

export function createProvider(config: ProviderConfig): LlmProvider {
  switch (config.kind) {
    case "anthropic":
      return new AnthropicProvider({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        authHeader: config.authHeader,
        headers: config.headers,
        defaultMaxOutputTokens: config.defaultMaxOutputTokens,
        name: config.name,
        transport: config.transport,
      });
    case "openai-compatible": {
      if (!config.baseUrl) throw new Error("an openai-compatible provider needs a base_url (for example https://api.openai.com/v1)");
      return new OpenAiCompatibleProvider({
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        headers: config.headers,
        maxTokensField: config.maxTokensField,
        streamUsage: config.streamUsage,
        effortField: config.effortField,
        defaultMaxOutputTokens: config.defaultMaxOutputTokens,
        name: config.name,
        transport: config.transport,
      });
    }
    default:
      throw new Error(`unknown provider kind '${String((config as { kind?: unknown }).kind)}'; expected one of ${PROVIDER_KINDS.join(", ")}`);
  }
}

/**
 * The window to assume for a model nobody has said anything about. Deliberately the smaller of what current models offer,
 * because the cost of assuming too small is a context that is thrown away early, and the cost of assuming too large is a
 * call the provider refuses.
 */
export function defaultContextWindow(kind: ProviderKind): number {
  return kind === "anthropic" ? 200_000 : 128_000;
}

export interface ModelRef {
  /** The configured provider, or undefined when the spec named none that is configured. */
  provider?: string;
  model: string;
}

/** `provider/model` against the providers configured. A first segment that is not a configured provider is part of the model id. */
export function parseModelRef(spec: string, providers: ReadonlySet<string> | readonly string[]): ModelRef {
  const known = providers instanceof Set ? providers : new Set(providers);
  const trimmed = spec.trim();
  const slash = trimmed.indexOf("/");
  if (slash > 0 && slash < trimmed.length - 1) {
    const head = trimmed.slice(0, slash);
    if (known.has(head)) return { provider: head, model: trimmed.slice(slash + 1) };
  }
  return { model: trimmed };
}

/**
 * Which provider and model a seat's `model:` means, with the defaults a deployment names. Throws, in words an operator can
 * act on, when it means nothing: the same sentences at config load (where every seat is checked before anything runs) and at
 * the first turn (where the config may have changed under a running mesh).
 *
 * `what` names the thing being resolved ("seat dev", "the designer") so the sentence says whose model it is.
 */
export function resolveProviderModel(
  spec: string | undefined,
  what: string,
  providers: readonly string[],
  defaults: { provider?: string; model?: string } = {},
): { provider: string; model: string } {
  if (providers.length === 0) throw new Error(`${what} runs on the native runtime, but no provider is configured (mesh.runtime.providers)`);
  const text = (spec ?? defaults.model ?? "").trim();
  if (!text) throw new Error(`${what} has no model: set its \`model:\` to provider/model (providers: ${providers.join(", ")}) or set a default model`);
  const ref = parseModelRef(text, providers);
  const provider = ref.provider ?? defaults.provider ?? (providers.length === 1 ? providers[0] : undefined);
  if (!provider) throw new Error(`${what}: model '${text}' names no provider and there is no default; write it as provider/model (providers: ${providers.join(", ")})`);
  if (!providers.includes(provider)) throw new Error(`no provider named '${provider}'; the configured providers are ${providers.join(", ")}`);
  return { provider, model: ref.model };
}
