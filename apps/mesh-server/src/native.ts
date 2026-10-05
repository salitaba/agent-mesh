import type { ResolvedMeshConfig } from "../../../packages/config/src/index";
import { NativeRuntime, type NativeProviderConfig, type NativeRuntimeOptions } from "../../../packages/runtime-native/src/index";

/**
 * The native runtime, configured from a mesh's `mesh.runtime` block.
 *
 * Keys are read from the environment variable each provider names (`api_key_env`) when the runtime is built, never from
 * mesh.yaml. A variable that is not set is not an error here (a config is read in places the secret is not) but is said at
 * boot, since every call to that provider would otherwise fail with a rejected key and no hint why.
 */

/** An Anthropic-style prompt cache is gone after about this long idle, so a large conversation is cheaper to rebuild. */
const ANTHROPIC_CACHE_TTL_MS = 10 * 60_000;

export interface NativeWiring {
  /** Where conversations are kept. Omitted for an in-memory mesh. */
  stateDir?: string;
  env: Record<string, string | undefined>;
  notice(message: string): void;
  warn(message: string): void;
  onRotate: NonNullable<NativeRuntimeOptions["onRotate"]>;
}

export function nativeRuntimeOptions(config: ResolvedMeshConfig, wiring: NativeWiring): NativeRuntimeOptions {
  const spec = config.native;
  const providers: Record<string, NativeProviderConfig> = {};
  for (const [name, p] of Object.entries(spec?.providers ?? {})) {
    const apiKey = p.apiKeyEnv ? wiring.env[p.apiKeyEnv] : undefined;
    if (p.apiKeyEnv && !apiKey) wiring.warn(`native runtime: provider '${name}' reads its key from ${p.apiKeyEnv}, which is not set; its requests will carry no key`);
    providers[name] = {
      kind: p.kind,
      ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(p.headers ? { headers: p.headers } : {}),
      ...(p.authHeader ? { authHeader: p.authHeader } : {}),
      ...(p.maxTokensField ? { maxTokensField: p.maxTokensField } : {}),
      ...(p.streamUsage !== undefined ? { streamUsage: p.streamUsage } : {}),
      ...(p.effortField !== undefined ? { effortField: p.effortField } : {}),
      ...(p.defaultMaxOutputTokens ? { defaultMaxOutputTokens: p.defaultMaxOutputTokens } : {}),
      ...(p.contextWindow ? { contextWindow: p.contextWindow } : {}),
      transport: {
        ...(p.idleTimeoutMs ? { idleTimeoutMs: p.idleTimeoutMs } : {}),
        ...(p.maxRetries !== undefined ? { maxRetries: p.maxRetries } : {}),
      },
      ...(p.apiKeyEnv ? { keyEnv: p.apiKeyEnv } : {}),
      // A provider says how long its cache lives; one that does not is assumed to cache like Anthropic's if it is Anthropic's.
      ...(p.cacheTtlMs ? { cacheTtlMs: p.cacheTtlMs } : p.kind === "anthropic" ? { cacheTtlMs: config.defaultStaleAfterMs ?? ANTHROPIC_CACHE_TTL_MS } : {}),
    };
  }
  return {
    providers,
    ...(spec?.defaultProvider ? { defaultProvider: spec.defaultProvider } : {}),
    ...(config.defaultModel ? { defaultModel: config.defaultModel } : {}),
    ...(spec?.designerModel ? { designerModel: spec.designerModel } : {}),
    models: spec?.models ?? {},
    ...(wiring.stateDir ? { stateDir: wiring.stateDir } : {}),
    ...(spec?.shellEnv ? { shellEnv: spec.shellEnv } : {}),
    ...(spec?.extraReadRoots.length ? { extraReadRoots: spec.extraReadRoots } : {}),
    ...(spec?.maxSteps ? { maxSteps: spec.maxSteps } : {}),
    ...(config.defaultContextWindow ? { contextWindow: config.defaultContextWindow } : {}),
    env: wiring.env,
    onNotice: (n) => wiring.notice(`native runtime: ${n.message}`),
    onRotate: wiring.onRotate,
  };
}

export function createNativeRuntime(config: ResolvedMeshConfig, wiring: NativeWiring): NativeRuntime {
  return new NativeRuntime(nativeRuntimeOptions(config, wiring));
}
