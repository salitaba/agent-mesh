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
