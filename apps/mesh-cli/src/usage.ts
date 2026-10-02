/**
 * `curule usage`: what meshes consumed, by day, seat and model, from their event logs.
 *
 * Read-only and offline: it scans `events.jsonl` the way the server's `/usage` does, so it is safe beside a
 * running mesh and works on a stopped one. Tokens are exact. Dollars are an estimate at Anthropic's list
 * prices, or the prices in `host.yaml`, and the report says so; the provider's invoice is the bill.
 */
import * as fs from "fs";
import * as path from "path";
import { LIST_PRICES_AS_OF } from "../../../packages/protocol/src/index";
import { aggregateUsageFromLogs, usageToTable, type UsageLog } from "../../../packages/observability/src/index";
import { resolveConfig } from "../../../packages/config/src/index";
import { LICENSE_PUBLIC_KEYS, checkFeature, loadEntitlements, type PublicKeySet } from "../../../packages/licensing/src/index";
import { meshHome, projectsFilePath, readProjectsFile } from "../../../packages/projects/src/index";
import { enforceOrWarn } from "../../mesh-server/src/license";
import { configuredPrices, parseUsageQuery, projectLogs, usageAnswer, usagePrices } from "../../mesh-server/src/commercial";

export const USAGE_HELP = `usage:
  curule usage <mesh.yaml> [<mesh.yaml> ...]   what those meshes consumed, from their event logs
  curule usage --all                           every project registered under <home> ($MESH_HOME or ~/.curule)
    --since <date>     inclusive start: 2026-10-01 or 2026-10-01T00:00:00Z
    --until <date>     exclusive end
    --by <dimensions>  comma separated, any of day, project, agent, model (default day,agent;
                       day,project,agent when more than one mesh is read)
    --json | --csv     machine formats; the default is a table
  Tokens are exact. Dollars are an estimate at Anthropic's list prices (as of ${LIST_PRICES_AS_OF}) or the model
  prices in host.yaml, left out for a model with neither; the provider's invoice is the bill. Reading the logs
  is safe beside a running mesh. Usage export is part of the Team plan and above: under
  MESH_LICENSE_ENFORCEMENT=enforce the Community plan is refused, otherwise it is told so and still answered.`;

export interface UsageCommandDeps {
  env?: NodeJS.ProcessEnv;
  home?: string;
  publicKeys?: PublicKeySet;
  now?: Date;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

const VALUE_FLAGS = ["by", "since", "until"] as const;

/**
 * Exit 0 on a report, 2 for a mistake in how it was asked for. A refusal under `enforce` throws
 * `LicenseLimitError`, which the CLI turns into exit 78 as it does for every other refusal to start.
 */
export async function runUsageCommand(positional: string[], flags: Record<string, string | boolean>, deps: UsageCommandDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => process.stdout.write(`${l}\n`));
  const err = deps.err ?? ((l: string) => console.error(l));
  const env = deps.env ?? process.env;
  const home = deps.home ?? meshHome(env);

  if (flags.help) {
    out(USAGE_HELP);
    return 0;
  }
  if (flags.json && flags.csv) {
    err("curule usage: --json and --csv are two formats; pick one");
    return 2;
  }
  const params = new URLSearchParams();
  for (const key of VALUE_FLAGS) {
    const value = flags[key];
    if (value === true) {
      err(`curule usage: --${key} needs a value\n\n${USAGE_HELP}`);
      return 2;
    }
    if (typeof value === "string") params.set(key, value);
  }
  params.set("format", flags.csv ? "csv" : "json");

  // What is being read: named meshes, or every registered project.
  const logs: UsageLog[] = [];
  const skipped: Array<{ project: string; reason: string }> = [];
  if (flags.all) {
    if (positional.length) {
      err("curule usage: --all reads every registered project; it does not take mesh.yaml paths too");
      return 2;
    }
    const found = projectLogs(readProjectsFile(projectsFilePath(home)).map((p) => ({ id: p.id, configPath: p.configPath })));
    logs.push(...found.logs);
    skipped.push(...found.skipped);
  } else {
    const files = positional.length ? positional : [env.MESH_CONFIG ?? "mesh.yaml"];
    for (const file of files) {
      if (!fs.existsSync(file)) {
        err(`curule usage: no such file: ${file}\n\n${USAGE_HELP}`);
        return 2;
      }
      const resolved = resolveConfig(file);
      logs.push({ project: resolved.meshId, file: path.join(resolved.stateDir, "logs", "events.jsonl") });
    }
  }
  if (!params.has("by") && logs.length > 1) params.set("by", "day,project,agent");

  const parsed = parseUsageQuery(params);
  if (!parsed.ok) {
    err(`curule usage: ${parsed.error}`);
    return 2;
  }

  // The feature gate, after the arguments are known to be sound: a refusal should be about the plan, not about a typo.
  const entitlements = loadEntitlements(env, home, deps.now ?? new Date(), deps.publicKeys ?? LICENSE_PUBLIC_KEYS);
  const licenseWarning = enforceOrWarn(checkFeature(entitlements, "usage-export", "Usage export"));
  if (licenseWarning) err(`note: ${licenseWarning} Running under MESH_LICENSE_ENFORCEMENT=${entitlements.enforcement}, so it is answered anyway.`);

  const prices = configuredPrices(home);
  if (flags.json || flags.csv) {
    const answer = await usageAnswer(logs, skipped, parsed.query, prices, licenseWarning);
    out(answer.body.endsWith("\n") ? answer.body.slice(0, -1) : answer.body);
    return 0;
  }
  const report = await aggregateUsageFromLogs(logs, {
    groupBy: parsed.query.groupBy,
    prices: usagePrices(prices),
    ...(parsed.query.since ? { since: parsed.query.since } : {}),
    ...(parsed.query.until ? { until: parsed.query.until } : {}),
  });
  out(usageToTable(report).trimEnd());
  for (const s of skipped) err(`note: skipped project ${s.project}: ${s.reason}`);
  return 0;
}
