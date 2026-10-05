/**
 * `curule providers check`: prove, before a mesh runs, that its providers work.
 *
 * A seat on the native runtime fails its first turn, minutes into a mission, if its key is not in the environment, its
 * base URL has a typo, or its model does not do tool calls. This asks each provider the cheap question first: is the key
 * there, does the endpoint answer, which models does it list. With `--model` it makes one small call as a seat would, with
 * a tool, because a model that cannot call tools cannot be a seat, and says what the call used.
 *
 * It reads mesh.yaml for the providers and the environment for the keys, exactly as the server does, and prints no key.
 */
import * as fs from "fs";
import * as path from "path";
import { resolveConfig } from "../../../packages/config/src/index";
import { createProvider, resolveProviderModel, type LlmProvider, type ModelEvent } from "../../../packages/llm/src/index";
import { nativeRuntimeOptions } from "../../mesh-server/src/native";

export const PROVIDERS_HELP = `usage:
  curule providers check [mesh.yaml] [--model provider/model] [--json]
    For each provider in mesh.runtime.providers: is its API key set in the environment variable it names, does the endpoint
    answer, and which models does it list. Exit 0 when every provider is fine, 1 when one is not.
    --model provider/model   also make one small call with a tool, as a seat would, to prove the key, the endpoint and the
                             model work together and that the model does tool calls. It spends a few hundred tokens.
    --json                   the same result as JSON
  mesh.yaml defaults to ./mesh.yaml. Keys are read from the environment, never printed.`;

export interface ProviderCheck {
  provider: string;
  kind: string;
  endpoint: string;
  ok: boolean;
  /** One line: what was found, or what is wrong. */
  detail: string;
  models?: number;
  probe?: {
    model: string;
    ok: boolean;
    ms: number;
    reportedModel?: string;
    toolCalls: number;
    input: number;
    output: number;
    estimated: boolean;
    detail: string;
  };
}

export interface ProvidersDeps {
  env?: NodeJS.ProcessEnv;
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** For tests: replaces how a provider is built from its configuration. */
  create?: typeof createProvider;
  now?: () => number;
}

const LIST_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 60_000;

export async function runProvidersCommand(positional: string[], flags: Record<string, string | boolean>, deps: ProvidersDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const env = deps.env ?? process.env;
  if (flags.help || positional.length === 0) {
    out(PROVIDERS_HELP);
    return positional.length === 0 && !flags.help ? 1 : 0;
  }
  if (positional[0] !== "check") {
    err(`unknown providers subcommand '${positional[0]}'\n${PROVIDERS_HELP}`);
    return 1;
  }
  const file = path.resolve(positional[1] ?? "mesh.yaml");
  if (!fs.existsSync(file)) {
    err(`${file} does not exist; name the mesh.yaml to check`);
    return 1;
  }
  const config = resolveConfig(file);
  const names = Object.keys(config.native?.providers ?? {});
  if (names.length === 0) {
    err(`${file} declares no providers (mesh.runtime.providers), so there is nothing to check`);
    return 1;
  }
  const warnings: string[] = [];
  const options = nativeRuntimeOptions(config, { env, notice: () => undefined, warn: (m) => warnings.push(m), onRotate: () => undefined });
  const create = deps.create ?? createProvider;
  const now = deps.now ?? Date.now;
  const results: ProviderCheck[] = [];

  for (const name of names) {
    const cfg = options.providers[name]!;
    const spec = config.native!.providers[name]!;
    const provider = create({ ...cfg, name });
    const base: ProviderCheck = { provider: name, kind: cfg.kind, endpoint: hostOf(cfg.baseUrl ?? (cfg.kind === "anthropic" ? "https://api.anthropic.com" : "")), ok: true, detail: "" };
    if (spec.apiKeyEnv && !cfg.apiKey) {
      results.push({ ...base, ok: false, detail: `${spec.apiKeyEnv} is not set in the environment` });
      continue;
    }
    results.push(await listModels(provider, base));
  }

  const modelFlag = typeof flags.model === "string" ? flags.model : undefined;
  if (modelFlag) {
    let target: { provider: string; model: string } | undefined;
    try {
      target = resolveProviderModel(modelFlag, "--model", names, { provider: options.defaultProvider, model: options.defaultModel });
    } catch (e) {
      err((e as Error).message);
      return 1;
    }
    const entry = results.find((r) => r.provider === target!.provider)!;
    if (entry.ok || entry.detail.includes("could not list")) {
      const provider = create({ ...options.providers[target.provider]!, name: target.provider });
      entry.probe = await probe(provider, target.model, now);
      if (!entry.probe.ok) entry.ok = false;
    }
  }

  if (flags.json) {
    out(JSON.stringify(results, null, 2));
  } else {
    for (const w of warnings) out(`warn: ${w}`);
    for (const r of results) {
      out(`${r.ok ? "ok  " : "FAIL"} ${r.provider} (${r.kind}, ${r.endpoint}): ${r.detail}`);
      if (r.probe) {
        out(`       ${r.probe.ok ? "ok  " : "FAIL"} ${r.probe.model}: ${r.probe.detail}`);
      }
    }
    if (!modelFlag && results.every((r) => r.ok)) out("To prove a model works as a seat does, add --model provider/model.");
  }
  return results.every((r) => r.ok) ? 0 : 1;
}

async function listModels(provider: LlmProvider, base: ProviderCheck): Promise<ProviderCheck> {
  if (!provider.listModels) return { ...base, detail: "reachable configuration; this provider has no model listing" };
  try {
    const models = await provider.listModels(AbortSignal.timeout(LIST_TIMEOUT_MS));
    return { ...base, models: models.length, detail: `${models.length} model${models.length === 1 ? "" : "s"} listed` };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // A provider that answers but will not list its models (a listing needs a scope the key lacks, or the endpoint has none)
    // is not proof it cannot chat: say so, and leave the verdict to `--model`.
    const answered = /API Error: (?:400|403|404|405)\b/.test(message);
    return { ...base, ok: answered, detail: `could not list models: ${message}` };
  }
}

async function probe(provider: LlmProvider, model: string, now: () => number): Promise<NonNullable<ProviderCheck["probe"]>> {
  const started = now();
  const events: ModelEvent[] = [];
  try {
    for await (const e of provider.stream({
      model,
      system: "You are a connectivity check. Do exactly what the user asks and nothing else.",
      messages: [{ role: "user", content: "Call the tool named ping with the argument text set to ok." }],
      tools: [{ name: "ping", description: "Answer the connectivity check.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }],
      maxOutputTokens: 200,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })) {
      events.push(e);
    }
  } catch (e) {
    return { model, ok: false, ms: now() - started, toolCalls: 0, input: 0, output: 0, estimated: false, detail: e instanceof Error ? e.message : String(e) };
  }
  const end = events.find((e): e is Extract<ModelEvent, { kind: "end" }> => e.kind === "end")?.result;
  const ms = now() - started;
  if (!end) return { model, ok: false, ms, toolCalls: 0, input: 0, output: 0, estimated: false, detail: "the provider ended the stream without an answer" };
  const calls = end.toolCalls.filter((c) => c.name === "ping").length;
  const used = `${end.usage.input + end.usage.cacheRead + end.usage.cacheWrite} in, ${end.usage.output} out${end.usage.estimated ? " (estimated: the provider reported no usage)" : ""}`;
  return {
    model,
    ok: calls > 0,
    ms,
    reportedModel: end.model,
    toolCalls: end.toolCalls.length,
    input: end.usage.input + end.usage.cacheRead + end.usage.cacheWrite,
    output: end.usage.output,
    estimated: end.usage.estimated === true,
    detail:
      calls > 0
        ? `answered in ${ms} ms as ${end.model}, called the tool; ${used}`
        : `answered in ${ms} ms but did not call the tool (it said: ${JSON.stringify(end.text.slice(0, 80))}); a model that does not do tool calls cannot be a seat`,
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
