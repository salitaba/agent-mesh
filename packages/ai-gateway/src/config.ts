/**
 * `gateway.yaml`: what the operator writes to run the gateway, and the one place it becomes a running one.
 *
 * Credentials are never in the file. A provider names the environment variable its key is read from, and a provider whose
 * variable is empty stops the gateway from starting, so a missing key is found at deploy time and not by the first customer.
 * Everything is checked before anything listens, and every problem is reported at once.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { PROVIDER_KINDS, createProvider, isProviderKind, type LlmProvider, type ProviderKind } from "../../llm/src/index";
import { AdminApi, createAdminServer } from "./admin";
import { Gateway, type LogRecord } from "./gateway";
import { JsonlLedgerStore, Ledger, type LedgerStore } from "./ledger";
import { parseRate } from "./money";
import { loadPriceTable, type PriceTable } from "./prices";
import { Router, type Tier } from "./routes";
import { createTenantServer, listen, type Listening } from "./server";

export interface ProviderSpec {
  kind: ProviderKind;
  baseUrl?: string;
  /** The key itself, read from the environment variable the file names. */
  apiKey?: string;
  /** The variable it was read from, for messages. */
  apiKeyEnv?: string;
}

export interface GatewayConfig {
  ledgerPath: string;
  prices: PriceTable;
  providers: Map<string, ProviderSpec>;
  tiers: Tier[];
  tenant: { host: string; port: number };
  admin: { host: string; port: number; token: string };
  limits: {
    defaultRpm: number;
    defaultConcurrent: number;
    reserveCapMicros: number;
    deadlineMs: number;
    commitMs: number;
    maxBodyBytes: number;
  };
  exposeUpstreamModel: boolean;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const DEFAULT_TIER_CAP = 16_384;

function wholeNumber(value: unknown, what: string, min: number, max: number, fallback: number, problems: string[]): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    problems.push(`${what} must be a whole number from ${min} to ${max} (got ${JSON.stringify(value)})`);
    return fallback;
  }
  return value;
}

function listenSpec(raw: unknown, what: string, defaults: { host: string; port: number }, problems: string[]): { host: string; port: number } {
  if (raw === undefined || raw === null) return defaults;
  if (!isObject(raw)) {
    problems.push(`${what} must be a mapping with host and port`);
    return defaults;
  }
  const host = raw.host === undefined ? defaults.host : typeof raw.host === "string" && raw.host !== "" ? raw.host : (problems.push(`${what}.host must be an address`), defaults.host);
  const port = wholeNumber(raw.port, `${what}.port`, 0, 65_535, defaults.port, problems);
  return { host, port };
}

/**
 * Read and check a gateway configuration. Paths in it are relative to the file. `env` is where keys and the admin token are
 * read from.
 */
export function loadGatewayConfig(file: string, env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  let raw: unknown;
  try {
    raw = parseYaml(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`cannot read the gateway configuration ${file}: ${(err as Error).message}`);
  }
  const dir = path.dirname(path.resolve(file));
  const problems: string[] = [];
  if (!isObject(raw)) throw new Error(`${file}: expected a mapping with ledger, prices, providers and tiers`);

  const at = (p: unknown, what: string): string => {
    if (typeof p !== "string" || p.trim() === "") {
      problems.push(`${what} is required`);
      return "";
    }
    return path.resolve(dir, p);
  };
  const ledgerPath = at(raw.ledger, "ledger");
  const pricesPath = at(raw.prices, "prices");
  let prices: PriceTable | undefined;
  if (pricesPath !== "") {
    try {
      prices = loadPriceTable(pricesPath);
    } catch (err) {
      problems.push((err as Error).message);
    }
  }

  const providers = new Map<string, ProviderSpec>();
  if (!isObject(raw.providers) || Object.keys(raw.providers).length === 0) problems.push("providers must name at least one model provider");
  else {
    for (const [name, p] of Object.entries(raw.providers)) {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) problems.push(`provider '${name}': a name is 1 to 64 letters, digits and . _ -`);
      if (!isObject(p)) {
        problems.push(`provider '${name}' must be a mapping with a kind and a base_url`);
        continue;
      }
      if (!isProviderKind(p.kind)) {
        problems.push(`provider '${name}': kind must be one of ${PROVIDER_KINDS.join(", ")} (got ${JSON.stringify(p.kind)})`);
        continue;
      }
      if (p.kind === "openai-compatible" && (typeof p.base_url !== "string" || p.base_url.trim() === "")) problems.push(`provider '${name}': an openai-compatible provider needs a base_url`);
      if (p.base_url !== undefined && typeof p.base_url === "string") {
        try {
          new URL(p.base_url);
        } catch {
          problems.push(`provider '${name}': base_url '${p.base_url}' is not a URL`);
        }
      }
      let apiKey: string | undefined;
      let apiKeyEnv: string | undefined;
      if (p.api_key_env !== undefined) {
        if (typeof p.api_key_env !== "string" || p.api_key_env === "") problems.push(`provider '${name}': api_key_env must name an environment variable`);
        else {
          apiKeyEnv = p.api_key_env;
          apiKey = env[p.api_key_env];
          if (apiKey === undefined || apiKey.trim() === "") problems.push(`provider '${name}': the environment variable ${p.api_key_env} is not set, so there is no key to call it with`);
        }
      }
      providers.set(name, { kind: p.kind, ...(typeof p.base_url === "string" ? { baseUrl: p.base_url } : {}), ...(apiKey ? { apiKey } : {}), ...(apiKeyEnv ? { apiKeyEnv } : {}) });
    }
  }

  const tiers: Tier[] = [];
  if (!isObject(raw.tiers) || Object.keys(raw.tiers).length === 0) problems.push("tiers must name at least one tier, for example fast, balanced and best");
  else {
    for (const [name, list] of Object.entries(raw.tiers)) {
      if (!Array.isArray(list)) {
        problems.push(`tier '${name}' must be a list of provider/model entries, tried in order`);
        continue;
      }
      const candidates = list.flatMap((entry, i) => {
        const model = typeof entry === "string" ? entry : isObject(entry) && typeof entry.model === "string" ? entry.model : undefined;
        if (model === undefined || !/^[^/\s]+\/\S+$/.test(model)) {
          problems.push(`tier '${name}'[${i}] must be a provider/model, as a string or as model: provider/model`);
          return [];
        }
        const cap = isObject(entry) ? wholeNumber(entry.max_output_tokens, `tier '${name}'[${i}].max_output_tokens`, 1, 10_000_000, DEFAULT_TIER_CAP, problems) : DEFAULT_TIER_CAP;
        const slash = model.indexOf("/");
        return [{ id: model, provider: model.slice(0, slash), model: model.slice(slash + 1), maxOutputTokens: cap }];
      });
      tiers.push({ name, candidates });
    }
  }
  if (prices) {
    try {
      new Router(tiers, prices, [...providers.keys()]);
    } catch (err) {
      problems.push(...(err as Error).message.split("\n"));
    }
  }

  const tenant = listenSpec(raw.tenant, "tenant", { host: "127.0.0.1", port: 8080 }, problems);
  const adminListen = listenSpec(isObject(raw.admin) ? { host: raw.admin.host, port: raw.admin.port } : raw.admin, "admin", { host: "127.0.0.1", port: 8081 }, problems);
  let adminToken = "";
  const tokenEnv = isObject(raw.admin) ? raw.admin.token_env : undefined;
  if (typeof tokenEnv !== "string" || tokenEnv === "") problems.push("admin.token_env must name the environment variable that holds the admin token");
  else {
    adminToken = env[tokenEnv] ?? "";
    if (adminToken.length < 24) problems.push(`the environment variable ${tokenEnv} must hold an admin token of at least 24 characters`);
  }
  if (tenant.port !== 0 && tenant.port === adminListen.port && tenant.host === adminListen.host) problems.push("tenant and admin must not listen on the same address: the admin API is not for workspaces");

  const lim = isObject(raw.limits) ? raw.limits : {};
  let reserveCapMicros = 2_000_000;
  if (lim.reserve_cap !== undefined) {
    try {
      reserveCapMicros = parseRate(lim.reserve_cap, "limits.reserve_cap");
    } catch (err) {
      problems.push((err as Error).message);
    }
  }
  const limits = {
    defaultRpm: wholeNumber(lim.default_rpm, "limits.default_rpm", 1, 1_000_000, 120, problems),
    defaultConcurrent: wholeNumber(lim.default_concurrent, "limits.default_concurrent", 1, 100_000, 16, problems),
    reserveCapMicros,
    deadlineMs: wholeNumber(lim.deadline_seconds, "limits.deadline_seconds", 1, 86_400, 600, problems) * 1000,
    commitMs: wholeNumber(lim.commit_seconds, "limits.commit_seconds", 1, 600, 10, problems) * 1000,
    maxBodyBytes: wholeNumber(lim.max_body_bytes, "limits.max_body_bytes", 1_024, 1_073_741_824, 8 * 1024 * 1024, problems),
  };
  if (raw.expose_upstream_model !== undefined && typeof raw.expose_upstream_model !== "boolean") problems.push("expose_upstream_model must be true or false");

  if (problems.length > 0) throw new Error(problems.map((p) => (p.startsWith(file) ? p : `${file}: ${p}`)).join("\n"));
  return {
    ledgerPath,
    prices: prices!,
    providers,
    tiers,
    tenant,
    admin: { ...adminListen, token: adminToken },
    limits,
    exposeUpstreamModel: raw.expose_upstream_model !== false,
  };
}

export interface RunningGateway {
  gateway: Gateway;
  ledger: Ledger;
  tenant: Listening;
  admin: Listening;
  /** Stop taking calls, let the ones in flight finish (up to `graceMs`), and close the ledger. */
  stop(graceMs?: number): Promise<void>;
}

export interface StartOptions {
  log?: (record: LogRecord) => void;
  /** Build a provider's adapter. For tests; the default is the real one. */
  providerFactory?: (name: string, spec: ProviderSpec) => LlmProvider;
  ledgerStore?: LedgerStore;
}

const stderrLog = (record: LogRecord): void => void process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);

/** The gateway's adapters wait less than a caller's own would: the gateway has the rest of the tier to try. */
const UPSTREAM_TRANSPORT = { maxRetries: 1, retryMaxMs: 5_000 };

export async function startGateway(config: GatewayConfig, options: StartOptions = {}): Promise<RunningGateway> {
  const log = options.log ?? stderrLog;
  const providers = new Map<string, LlmProvider>();
  for (const [name, spec] of config.providers) {
    providers.set(
      name,
      options.providerFactory?.(name, spec) ??
        createProvider({
          kind: spec.kind,
          ...(spec.baseUrl !== undefined ? { baseUrl: spec.baseUrl } : {}),
          ...(spec.apiKey !== undefined ? { apiKey: spec.apiKey } : {}),
          name,
          transport: UPSTREAM_TRANSPORT,
        }),
    );
  }
  const ledger = await Ledger.open(options.ledgerStore ?? new JsonlLedgerStore(config.ledgerPath), { currency: config.prices.currency });
  try {
    const router = new Router(config.tiers, config.prices, [...config.providers.keys()]);
    const gateway = new Gateway({
      ledger,
      prices: config.prices,
      router,
      providers,
      defaultRpm: config.limits.defaultRpm,
      defaultConcurrent: config.limits.defaultConcurrent,
      reserveCapMicros: config.limits.reserveCapMicros,
      deadlineMs: config.limits.deadlineMs,
      commitMs: config.limits.commitMs,
      exposeUpstreamModel: config.exposeUpstreamModel,
      log,
    });
    const tenant = await listen(createTenantServer(gateway, { maxBodyBytes: config.limits.maxBodyBytes }), config.tenant.port, config.tenant.host);
    let admin: Listening;
    try {
      admin = await listen(createAdminServer(new AdminApi(gateway), gateway, { token: config.admin.token }), config.admin.port, config.admin.host);
    } catch (err) {
      await tenant.close(0);
      throw err;
    }
    log({ level: "info", msg: "the gateway is listening", tenant: tenant.url, admin: admin.url, currency: ledger.currency, priceVersion: config.prices.version, tiers: router.names() });
    return {
      gateway,
      ledger,
      tenant,
      admin,
      async stop(graceMs = 10_000) {
        await tenant.close(graceMs);
        await admin.close(1_000);
        await ledger.close();
      },
    };
  } catch (err) {
    await ledger.close();
    throw err;
  }
}
