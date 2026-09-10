/**
 * The host's own configuration: `~/.agent-mesh/host.yaml`.
 *
 * Deliberately NOT a `host:` block inside a project's `mesh.yaml`. Every knob
 * here is cross-project — an aggregate spend ceiling declared by one project
 * would be one of N conflicting ceilings, and the host would have to pick a
 * winner. A single file next to `projects.json` has exactly one value for
 * exactly one host process.
 *
 * The file is optional. Absent, unreadable or malformed all resolve to the same
 * defaults: a host that will not boot because a config file it never needed has
 * a typo in it is worse than a host running on documented defaults.
 */
import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";
import { meshHome } from "./store";

export const HOST_CONFIG_FILENAME = "host.yaml";

/**
 * Default aggregate ceiling, in USD.
 *
 * The ceiling defaults **on**. N projects each honouring their own per-mesh
 * token budget have no combined ceiling at all, and every open project spawns
 * its own `runtime-opencode` children — so "no ceiling" is the one setting a
 * user cannot discover is wrong until the bill arrives. 50 is high enough that
 * ordinary use never meets it and low enough that a runaway is caught the same
 * day. `spend_ceiling_usd: null` disables it.
 */
export const DEFAULT_SPEND_CEILING_USD = 50;

/**
 * Fallback price for a model with no entry in `model_prices`, in USD per
 * million tokens, applied to input and output alike.
 *
 * A model the table does not know must not be billed at zero: an unpriced
 * model would then be an invisible way to spend past the ceiling, which is the
 * one failure mode a backstop cannot have. This is a mid-range list price, so
 * an unpriced cheap model over-reports and an unpriced frontier model still
 * under-reports — erring toward tripping early is the correct bias here.
 */
export const DEFAULT_USD_PER_MTOK = 3;

/** Per-million-token prices for one model. */
export interface ModelPrice {
  inputPerMtok: number;
  outputPerMtok: number;
}

export interface HostConfig {
  /** Per-child `--max-old-space-size` in MB. `null` leaves the default heap. */
  projectMemoryMb: number | null;
  /** Aggregate cap on turns running across open projects. `null` = unlimited. */
  maxConcurrentTurns: number | null;
  /** Aggregate USD ceiling across open projects. `null` disables it. */
  spendCeilingUsd: number | null;
  /** model id -> price. Missing models bill at `defaultUsdPerMtok`. */
  modelPrices: Record<string, ModelPrice>;
  defaultUsdPerMtok: number;
  /** Non-fatal complaints about the file, surfaced by the CLI at boot. */
  warnings: string[];
}

export function hostConfigPath(home: string = meshHome()): string {
  return path.join(home, HOST_CONFIG_FILENAME);
}

export function defaultHostConfig(): HostConfig {
  return {
    projectMemoryMb: null,
    maxConcurrentTurns: null,
    spendCeilingUsd: DEFAULT_SPEND_CEILING_USD,
    modelPrices: {},
    defaultUsdPerMtok: DEFAULT_USD_PER_MTOK,
    warnings: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `null` and absent mean different things and must stay distinguishable:
 * absent takes the default, an explicit `null` disables the knob. `undefined`
 * from this helper means "not stated"; `null` means "stated as off".
 */
function optionalNumber(
  raw: Record<string, unknown>,
  key: string,
  warnings: string[],
): number | null | undefined {
  if (!(key in raw)) return undefined;
  const value = raw[key];
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  warnings.push(`host.yaml: ${key} must be a positive number or null — ignoring ${JSON.stringify(value)}`);
  return undefined;
}

function parsePrices(value: unknown, warnings: string[]): Record<string, ModelPrice> {
  const out: Record<string, ModelPrice> = {};
  if (value === undefined || value === null) return out;
  if (!isRecord(value)) {
    warnings.push("host.yaml: model_prices must be a mapping of model id -> prices — ignoring it");
    return out;
  }
  for (const [model, entry] of Object.entries(value)) {
    // A bare number is the common case (one rate for the model) and reads far
    // better in YAML than a two-key mapping repeated per model.
    if (typeof entry === "number" && Number.isFinite(entry) && entry >= 0) {
      out[model] = { inputPerMtok: entry, outputPerMtok: entry };
      continue;
    }
    if (isRecord(entry)) {
      const input = entry.input_per_mtok;
      const output = entry.output_per_mtok;
      const ok = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
      if (ok(input) && ok(output)) {
        out[model] = { inputPerMtok: input, outputPerMtok: output };
        continue;
      }
    }
    warnings.push(`host.yaml: model_prices.${model} needs a number or { input_per_mtok, output_per_mtok } — ignoring it`);
  }
  return out;
}

/** Parse the `host:` block out of already-loaded YAML text. Never throws. */
export function parseHostConfig(text: string): HostConfig {
  const config = defaultHostConfig();
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (err) {
    config.warnings.push(`host.yaml is not valid YAML — using defaults (${(err as Error).message})`);
    return config;
  }
  if (parsed === null || parsed === undefined) return config;
  if (!isRecord(parsed)) {
    config.warnings.push("host.yaml must be a mapping — using defaults");
    return config;
  }
  // The spec writes the settings under a `host:` key. Accept them at the top
  // level too: in a file literally named host.yaml the nesting is redundant,
  // and rejecting the obvious shorthand is a papercut with no upside.
  const raw = isRecord(parsed.host) ? parsed.host : parsed;

  const memory = optionalNumber(raw, "project_memory_mb", config.warnings);
  if (memory !== undefined) config.projectMemoryMb = memory;
  const turns = optionalNumber(raw, "max_concurrent_turns", config.warnings);
  if (turns !== undefined) config.maxConcurrentTurns = turns;
  const ceiling = optionalNumber(raw, "spend_ceiling_usd", config.warnings);
  if (ceiling !== undefined) config.spendCeilingUsd = ceiling;
  const fallback = optionalNumber(raw, "default_usd_per_mtok", config.warnings);
  if (fallback !== undefined && fallback !== null) config.defaultUsdPerMtok = fallback;
  config.modelPrices = parsePrices(raw.model_prices, config.warnings);
  return config;
}

/** Load `<home>/host.yaml`. A missing file is not an error. */
export function loadHostConfig(home: string = meshHome()): HostConfig {
  const file = hostConfigPath(home);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaultHostConfig();
    const config = defaultHostConfig();
    config.warnings.push(`could not read ${file} — using defaults (${(err as Error).message})`);
    return config;
  }
  return parseHostConfig(text);
}

/**
 * Convert one model's token counts to USD.
 *
 * Cache reads are excluded by the caller, not here: `ModelCost.cacheRead` is
 * already recorded separately precisely because replayed transcript tokens are
 * not billed at the input rate.
 */
export function priceTokens(
  config: Pick<HostConfig, "modelPrices" | "defaultUsdPerMtok">,
  model: string,
  input: number,
  output: number,
): number {
  const price = config.modelPrices[model];
  const inRate = price ? price.inputPerMtok : config.defaultUsdPerMtok;
  const outRate = price ? price.outputPerMtok : config.defaultUsdPerMtok;
  return (input / 1_000_000) * inRate + (output / 1_000_000) * outRate;
}
