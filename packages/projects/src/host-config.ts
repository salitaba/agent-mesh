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
import { Document, parse as parseYaml, parseDocument } from "yaml";
import { meshHome } from "./store";

export const HOST_CONFIG_FILENAME = "host.yaml";

/**
 * Default aggregate ceiling, in USD.
 *
 * The ceiling defaults **on**. N projects each honouring their own per-mesh
 * token budget have no combined ceiling at all, and every open project spawns
 * its own runtime children — so "no ceiling" is the one setting a
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
  /**
   * YAML keys whose effective value came from the file rather than from the
   * defaults above, e.g. `["spend_ceiling_usd"]`.
   *
   * The whole lesson of the `$50` ceiling nobody set is that "on by default"
   * and "you chose this" are indistinguishable once they are both just a
   * number on a screen. A key stated but rejected as invalid is *not* listed:
   * the value in force is still the default, and that is what the operator
   * needs told. Optional so existing `HostConfig` literals keep compiling.
   */
  explicitKeys?: string[];
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
    explicitKeys: [],
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

  const explicit: string[] = [];
  const memory = optionalNumber(raw, "project_memory_mb", config.warnings);
  if (memory !== undefined) {
    config.projectMemoryMb = memory;
    explicit.push("project_memory_mb");
  }
  const turns = optionalNumber(raw, "max_concurrent_turns", config.warnings);
  if (turns !== undefined) {
    config.maxConcurrentTurns = turns;
    explicit.push("max_concurrent_turns");
  }
  const ceiling = optionalNumber(raw, "spend_ceiling_usd", config.warnings);
  if (ceiling !== undefined) {
    config.spendCeilingUsd = ceiling;
    explicit.push("spend_ceiling_usd");
  }
  const fallback = optionalNumber(raw, "default_usd_per_mtok", config.warnings);
  if (fallback !== undefined && fallback !== null) {
    config.defaultUsdPerMtok = fallback;
    explicit.push("default_usd_per_mtok");
  }
  config.modelPrices = parsePrices(raw.model_prices, config.warnings);
  if (Object.keys(config.modelPrices).length > 0) explicit.push("model_prices");
  config.explicitKeys = explicit;
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

/** The scalar `host.yaml` keys a running host can be told to change. */
export interface HostConfigUpdate {
  projectMemoryMb?: number | null;
  maxConcurrentTurns?: number | null;
  spendCeilingUsd?: number | null;
  defaultUsdPerMtok?: number;
}

/** Field name -> the YAML key it is written as, and whether it may be `null`. */
const UPDATE_KEYS: Record<keyof HostConfigUpdate, { yaml: string; nullable: boolean }> = {
  projectMemoryMb: { yaml: "project_memory_mb", nullable: true },
  maxConcurrentTurns: { yaml: "max_concurrent_turns", nullable: true },
  spendCeilingUsd: { yaml: "spend_ceiling_usd", nullable: true },
  // No `null` here: an unpriced model billed at zero is an invisible way to
  // spend past the ceiling, which is the one thing a backstop cannot allow.
  defaultUsdPerMtok: { yaml: "default_usd_per_mtok", nullable: false },
};

/**
 * When each key takes effect. The settings UI renders this rather than
 * carrying its own copy.
 *
 * A single undifferentiated "Save" is what made the original `$50` ceiling so
 * expensive to diagnose: the operator had no way to know which edits were
 * already in force and which needed something else to happen first. That
 * distinction is a property of the host, so the host is what states it.
 */
export type HostConfigEffect = "live" | "host-restart";

export const HOST_CONFIG_EFFECTS: Record<string, HostConfigEffect> = {
  // Read at call time by the limit check that runs on every heartbeat, so a
  // saved value is in force on the next beat.
  spend_ceiling_usd: "live",
  max_concurrent_turns: "live",
  default_usd_per_mtok: "live",
  model_prices: "live",
  // `host-restart`, and specifically NOT "next project open", which is the
  // intuitive answer and is wrong. It is a child spawn flag, so a *fresh*
  // supervisor would pick it up per child — but the running supervisor was
  // constructed once at host start with the value read then, and it spawns
  // from that captured copy. Saving this key changes the file and nothing
  // else until the host is restarted, and a screen that promised otherwise
  // would be the original `$50` trap rebuilt with better manners.
  project_memory_mb: "host-restart",
};

/**
 * Check a proposed update without applying it.
 *
 * Deliberately here and not in the dashboard or the route: the same rules have
 * to hold for a CLI write and a server boot, and a check that lives in one
 * caller is a check the other two silently skip.
 */
export function validateHostConfigUpdate(raw: Record<string, unknown>): {
  update: HostConfigUpdate;
  errors: string[];
} {
  const out: Record<string, number | null> = {};
  const errors: string[] = [];
  for (const [key, spec] of Object.entries(UPDATE_KEYS)) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (value === null) {
      if (!spec.nullable) {
        errors.push(`${spec.yaml} must be a positive number`);
        continue;
      }
      out[key] = null;
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      out[key] = value;
      continue;
    }
    errors.push(`${spec.yaml} must be a positive number${spec.nullable ? " or null" : ""}`);
  }
  for (const key of Object.keys(raw)) {
    if (!(key in UPDATE_KEYS)) errors.push(`'${key}' is not an editable host setting`);
  }
  return { update: out as HostConfigUpdate, errors };
}

/**
 * Write the changed keys back to `<home>/host.yaml` and return the reloaded
 * config.
 *
 * Edits the existing document rather than re-emitting a parsed object:
 * `host.yaml` is hand-written and usually carries the operator's own notes
 * about why a ceiling is what it is, and a save from a settings screen that
 * silently deletes those comments is its own small betrayal.
 *
 * Throws on a file that does not parse. `loadHostConfig` deliberately falls
 * back to defaults there — booting is more important than the file — but a
 * *write* has no such excuse: overwriting a document we could not read would
 * destroy whatever the operator actually meant.
 */
export function saveHostConfig(update: HostConfigUpdate, home: string = meshHome()): HostConfig {
  const file = hostConfigPath(home);
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const doc = text.trim().length > 0 ? parseDocument(text) : new Document({});
  if (doc.errors.length > 0) {
    throw new Error(`${file} is not valid YAML — fix it by hand before saving (${doc.errors[0].message})`);
  }
  // Mirrors the read side, which accepts both a `host:` block and the bare
  // top level: write the keys back wherever the operator already keeps them.
  const nested = doc.has("host");
  for (const [key, spec] of Object.entries(UPDATE_KEYS)) {
    const value = (update as Record<string, number | null | undefined>)[key];
    if (value === undefined) continue;
    if (nested) doc.setIn(["host", spec.yaml], value);
    else doc.set(spec.yaml, value);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, doc.toString(), "utf8");
  return loadHostConfig(home);
}
