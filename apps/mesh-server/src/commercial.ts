/**
 * The pieces of the commercial surface that the single-mesh server and the host answer the same way:
 * usage reports and the licence-aware parts of a metrics scrape.
 */
import * as path from "path";
import { ANTHROPIC_LIST_PRICES, LIST_PRICES_AS_OF, type TokenPrice } from "../../../packages/protocol/src/index";
import {
  USAGE_DIMENSIONS,
  aggregateUsageFromLogs,
  usageToCsv,
  type PromMetric,
  type UsageDimension,
  type UsageLog,
  type UsagePrices,
} from "../../../packages/observability/src/index";
import { resolveConfig } from "../../../packages/config/src/index";
import type { Entitlements } from "../../../packages/licensing/src/index";

/** What the operator configured, over Anthropic's published prices: the same resolution the spend ceiling uses. */
export function usagePrices(configured: Readonly<Record<string, TokenPrice>>): UsagePrices {
  return { ...ANTHROPIC_LIST_PRICES, ...configured };
}

export interface UsageQuery {
  since?: string;
  until?: string;
  groupBy: UsageDimension[];
  format: "json" | "csv";
}

/** The query string of a usage request, validated: a bad date or dimension is the caller's to fix, not a 500. */
export function parseUsageQuery(params: URLSearchParams): { ok: true; query: UsageQuery } | { ok: false; error: string } {
  const by = (params.get("by") ?? "day,agent").split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  for (const dim of by) {
    if (!(USAGE_DIMENSIONS as readonly string[]).includes(dim)) {
      return { ok: false, error: `'${dim}' is not a dimension to group by (use any of ${USAGE_DIMENSIONS.join(", ")}, comma separated)` };
    }
  }
  const format = params.get("format") ?? "json";
  if (format !== "json" && format !== "csv") return { ok: false, error: `format must be json or csv, not '${format}'` };
  const query: UsageQuery = { groupBy: [...new Set(by)] as UsageDimension[], format };
  for (const key of ["since", "until"] as const) {
    const raw = params.get(key);
    if (raw === null || raw === "") continue;
    if (Number.isNaN(Date.parse(raw))) return { ok: false, error: `${key} '${raw}' is not a date (use 2026-10-01 or 2026-10-01T00:00:00Z)` };
    query[key] = raw;
  }
  return { ok: true, query };
}

/** The event logs of registered projects. A project whose config will not load is reported, not fatal. */
export function projectLogs(refs: ReadonlyArray<{ id: string; configPath: string }>): { logs: UsageLog[]; skipped: Array<{ project: string; reason: string }> } {
  const logs: UsageLog[] = [];
  const skipped: Array<{ project: string; reason: string }> = [];
  for (const ref of refs) {
    try {
      logs.push({ project: ref.id, file: path.join(resolveConfig(ref.configPath).stateDir, "logs", "events.jsonl") });
    } catch (err) {
      skipped.push({ project: ref.id, reason: (err as Error).message.split("\n")[0] ?? "its config could not be read" });
    }
  }
  return { logs, skipped };
}

export interface UsageAnswer {
  contentType: string;
  body: string;
  /** Set for a CSV, so a browser saves it. */
  disposition?: string;
}

export async function usageAnswer(
  logs: readonly UsageLog[],
  skipped: ReadonlyArray<{ project: string; reason: string }>,
  query: UsageQuery,
  configuredPrices: Readonly<Record<string, TokenPrice>>,
  licenseWarning?: string,
): Promise<UsageAnswer> {
  const report = await aggregateUsageFromLogs(logs, {
    groupBy: query.groupBy,
    prices: usagePrices(configuredPrices),
    ...(query.since ? { since: query.since } : {}),
    ...(query.until ? { until: query.until } : {}),
  });
  if (query.format === "csv") {
    return { contentType: "text/csv; charset=utf-8", body: usageToCsv(report), disposition: 'attachment; filename="agent-mesh-usage.csv"' };
  }
  return {
    contentType: "application/json",
    body: JSON.stringify({
      ...report,
      prices: { listPricesAsOf: LIST_PRICES_AS_OF, listed: Object.keys(ANTHROPIC_LIST_PRICES), configured: Object.keys(configuredPrices) },
      ...(skipped.length ? { skipped } : {}),
      ...(licenseWarning ? { licenseWarning } : {}),
    }),
  };
}

/** The licence as metrics: what it is, when it ends, what it allows and how much of that is in use. */
export function licenseMetrics(ent: Entitlements, usage: Readonly<Record<string, number>>): PromMetric[] {
  const metrics: PromMetric[] = [
    {
      name: "agent_mesh_license_info",
      help: "The licence this install runs under: plan and status as labels, always 1.",
      type: "gauge",
      samples: [{ labels: { plan: ent.plan, status: ent.status, enforcement: ent.enforcement }, value: 1 }],
    },
  ];
  if (ent.expiresAt) {
    metrics.push({
      name: "agent_mesh_license_expires_timestamp_seconds",
      help: "When the licence expires (Unix time). Alert on this well before it passes.",
      type: "gauge",
      samples: [{ value: Math.floor(Date.parse(ent.expiresAt) / 1000) }],
    });
  }
  const limits: Array<[string, number | null]> = [
    ["seats_per_mesh", ent.limits.maxSeatsPerMesh],
    ["projects", ent.limits.maxProjects],
    ["concurrent_turns", ent.limits.maxConcurrentTurns],
  ];
  metrics.push({
    name: "agent_mesh_license_limit",
    help: "What the plan allows; a limit that does not exist is left out.",
    type: "gauge",
    samples: limits.filter((l): l is [string, number] => l[1] !== null).map(([limit, value]) => ({ labels: { limit }, value })),
  });
  metrics.push({
    name: "agent_mesh_license_in_use",
    help: "How much of each limited thing is in use now.",
    type: "gauge",
    samples: Object.entries(usage).map(([what, value]) => ({ labels: { what }, value })),
  });
  return metrics;
}
