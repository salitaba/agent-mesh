/**
 * The admin API: how the control plane makes keys, adds credit and reads what was spent.
 *
 * It is a different door from the one workspaces use, on its own port and behind its own token, because what it can do is
 * different in kind: mint a key, put money on an account, read every spend. It never returns a key's secret after the call
 * that made it, and it never returns the hash of one either.
 *
 * `AdminApi` is plain: a method, a URL and a parsed body in, a status and a body out. The HTTP server around it only reads
 * the request and checks the token, so everything it decides can be tested without a socket.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import type { JsonObject } from "../../llm/src/index";
import type { Gateway } from "./gateway";
import { LedgerConflictError, LedgerUnavailableError, type KeyLimits, type KeyRecord, type LedgerEntry } from "./ledger";
import { WireError, newRequestId } from "./openai-wire";
import { readBody, sendError, sendJson, type ServerOptions } from "./server";

export interface AdminResponse {
  status: number;
  body: JsonObject;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function reply(status: number, body: JsonObject): AdminResponse {
  return { status, body };
}

function failure(status: number, type: string, message: string): AdminResponse {
  return reply(status, { error: { message, type } });
}

function field(body: unknown, name: string): unknown {
  if (!isObject(body)) throw new RangeError("the request body must be a JSON object");
  return body[name];
}

function requiredString(body: unknown, name: string): string {
  const v = field(body, name);
  if (typeof v !== "string" || v.trim() === "") throw new RangeError(`${name} is required`);
  return v;
}

function optionalString(body: unknown, name: string): string | undefined {
  const v = field(body, name);
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new RangeError(`${name} must be text`);
  return v;
}

/** A key without its hash: what an operator may see. */
function publicKey(k: KeyRecord): JsonObject {
  return {
    keyId: k.keyId,
    accountId: k.accountId,
    ...(k.workspaceId !== undefined ? { workspaceId: k.workspaceId } : {}),
    ...(k.label !== undefined ? { label: k.label } : {}),
    limits: k.limits as JsonObject,
    ...(k.models !== undefined ? { models: k.models } : {}),
    createdAt: k.createdAt,
    ...(k.revokedAt !== undefined ? { revokedAt: k.revokedAt } : {}),
    ...(k.revokedReason !== undefined ? { revokedReason: k.revokedReason } : {}),
  };
}

function publicEntry(e: LedgerEntry): JsonObject {
  if (e.type !== "key.created") return e as unknown as JsonObject;
  const { secretHash: _hash, ...rest } = e;
  return rest as unknown as JsonObject;
}

export interface Aggregate {
  calls: number;
  failed: number;
  aborted: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costMicros: number;
  chargeMicros: number;
  /** What was charged less what it cost the service. Negative where the service paid for calls it did not bill. */
  marginMicros: number;
}

const empty = (): Aggregate => ({ calls: 0, failed: 0, aborted: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costMicros: 0, chargeMicros: 0, marginMicros: 0 });

const GROUPS = ["account", "workspace", "model", "alias", "day"] as const;
type GroupBy = (typeof GROUPS)[number];

export class AdminApi {
  constructor(private readonly gateway: Gateway) {}

  private get ledger() {
    return this.gateway.options.ledger;
  }

  private readonly routes: Array<{ pattern: RegExp; method: string; run: (m: RegExpExecArray, url: URL, body: unknown) => Promise<AdminResponse> | AdminResponse }> = [
    { pattern: /^\/admin\/health$/, method: "GET", run: () => this.health() },
    { pattern: /^\/admin\/keys$/, method: "POST", run: (_m, _u, body) => this.createKey(body) },
    { pattern: /^\/admin\/keys$/, method: "GET", run: (_m, url) => this.listKeys(url) },
    { pattern: /^\/admin\/keys\/([^/]+)\/revoke$/, method: "POST", run: (m, _u, body) => this.revokeKey(decodeURIComponent(m[1]!), body) },
    { pattern: /^\/admin\/grants$/, method: "POST", run: (_m, _u, body) => this.grant(body) },
    { pattern: /^\/admin\/accounts\/([^/]+)$/, method: "GET", run: (m) => this.account(decodeURIComponent(m[1]!)) },
    { pattern: /^\/admin\/ledger$/, method: "GET", run: (_m, url) => this.entries(url) },
    { pattern: /^\/admin\/report$/, method: "GET", run: (_m, url) => this.report(url) },
  ];

  async handle(method: string, url: URL, body: unknown): Promise<AdminResponse> {
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const matching = this.routes.map((r) => ({ r, m: r.pattern.exec(path) })).filter((x) => x.m !== null);
    if (matching.length === 0) return failure(404, "not_found", `There is nothing at ${path}.`);
    const hit = matching.find((x) => x.r.method === method);
    if (!hit) return failure(405, "method_not_allowed", `Use ${matching.map((x) => x.r.method).join(" or ")} for ${path}.`);
    try {
      return await hit.r.run(hit.m!, url, body);
    } catch (err) {
      if (err instanceof RangeError) return failure(400, "invalid_request_error", err.message);
      if (err instanceof LedgerConflictError) return failure(409, "conflict", err.message);
      if (err instanceof LedgerUnavailableError) return failure(503, "ledger_unavailable", err.message);
      throw err;
    }
  }

  private health(): AdminResponse {
    return reply(200, {
      ok: this.ledger.writable,
      writable: this.ledger.writable,
      currency: this.ledger.currency,
      priceVersion: this.gateway.options.prices.version,
      tiers: this.gateway.options.router.names(),
    });
  }

  private async createKey(body: unknown): Promise<AdminResponse> {
    const accountId = requiredString(body, "accountId");
    const models = field(body, "models");
    if (models !== undefined && models !== null) {
      if (!Array.isArray(models) || models.some((m) => typeof m !== "string")) throw new RangeError("models must be a list of tier names");
      const tiers = this.gateway.options.router.names();
      const unknown = (models as string[]).filter((m) => !tiers.includes(m));
      if (unknown.length > 0) throw new RangeError(`models names ${unknown.map((m) => `'${m}'`).join(", ")}, which ${unknown.length === 1 ? "is" : "are"} not a tier (tiers: ${tiers.join(", ")})`);
    }
    const limits = field(body, "limits");
    if (limits !== undefined && limits !== null && !isObject(limits)) throw new RangeError("limits must be an object");
    const workspaceId = optionalString(body, "workspaceId");
    const label = optionalString(body, "label");
    const minted = await this.ledger.createKey({
      accountId,
      ...(workspaceId !== undefined ? { workspaceId } : {}),
      ...(label !== undefined ? { label } : {}),
      ...(isObject(limits) ? { limits: limits as KeyLimits } : {}),
      ...(Array.isArray(models) ? { models: models as string[] } : {}),
    });
    const record = this.ledger.state.keys.get(minted.keyId)!;
    // The token is in this response and nowhere else, ever.
    return reply(201, { ...publicKey(record), token: minted.token });
  }

  private listKeys(url: URL): AdminResponse {
    const accountId = url.searchParams.get("accountId");
    const workspaceId = url.searchParams.get("workspaceId");
    const keys = [...this.ledger.state.keys.values()]
      .filter((k) => (accountId === null || k.accountId === accountId) && (workspaceId === null || k.workspaceId === workspaceId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return reply(200, { keys: keys.map(publicKey) });
  }

  private async revokeKey(keyId: string, body: unknown): Promise<AdminResponse> {
    const reason = isObject(body) ? optionalString(body, "reason") : undefined;
    const status = await this.ledger.revokeKey(keyId, reason);
    if (status === "unknown") return failure(404, "not_found", `There is no key '${keyId}'.`);
    return reply(200, { keyId, status });
  }

  private async grant(body: unknown): Promise<AdminResponse> {
    const amount = field(body, "amountMicros");
    if (typeof amount !== "number") throw new RangeError("amountMicros is required, as a whole number of micro-units");
    const mode = optionalString(body, "mode");
    const reference = optionalString(body, "reference");
    const accountId = requiredString(body, "accountId");
    const status = await this.ledger.grant({
      id: requiredString(body, "id"),
      accountId,
      bucket: requiredString(body, "bucket") as "included" | "purchased",
      ...(mode !== undefined ? { mode: mode as "add" | "set" } : {}),
      amountMicros: amount,
      reason: requiredString(body, "reason"),
      ...(reference !== undefined ? { reference } : {}),
    });
    return reply(200, { status, ...this.accountBody(accountId) });
  }

  private accountBody(accountId: string): JsonObject {
    const b = this.ledger.balance(accountId);
    const held = this.gateway.heldFor(accountId);
    return {
      accountId,
      currency: this.ledger.currency,
      balance: { included: b.included, purchased: b.purchased, total: b.included + b.purchased, held, available: b.included + b.purchased - held },
      charged: b.charged,
      cost: b.cost,
      keys: [...this.ledger.state.keys.values()].filter((k) => k.accountId === accountId && k.revokedAt === undefined).length,
    };
  }

  private account(accountId: string): AdminResponse {
    return reply(200, this.accountBody(accountId));
  }

  /** The last `limit` entries that match, oldest first. */
  private async entries(url: URL): Promise<AdminResponse> {
    const q = url.searchParams;
    const limit = q.has("limit") ? Number(q.get("limit")) : 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError("limit must be a whole number from 1 to 1000");
    const accountId = q.get("accountId");
    const type = q.get("type");
    const since = q.get("since");
    const until = q.get("until");
    for (const [name, value] of [["since", since], ["until", until]] as const) {
      if (value !== null && Number.isNaN(Date.parse(value))) throw new RangeError(`${name} must be a date, for example 2026-10-05 or 2026-10-05T12:00:00Z`);
    }
    const kept: LedgerEntry[] = [];
    let matched = 0;
    for await (const e of this.ledger.scan()) {
      if (type !== null && e.type !== type) continue;
      if (accountId !== null && !("accountId" in e && e.accountId === accountId)) continue;
      if (since !== null && e.at < new Date(since).toISOString()) continue;
      if (until !== null && e.at >= new Date(until).toISOString()) continue;
      matched++;
      kept.push(e);
      if (kept.length > limit) kept.shift();
    }
    return reply(200, { entries: kept.map(publicEntry), matched, truncated: matched > limit });
  }

  /** What was spent, added up, for a usage view or for the owner's margin. Only spends are counted. */
  private async report(url: URL): Promise<AdminResponse> {
    const q = url.searchParams;
    const groupBy = (q.get("groupBy") ?? "account") as GroupBy;
    if (!GROUPS.includes(groupBy)) throw new RangeError(`groupBy must be one of ${GROUPS.join(", ")}`);
    const from = q.get("from");
    const to = q.get("to");
    for (const [name, value] of [["from", from], ["to", to]] as const) {
      if (value !== null && Number.isNaN(Date.parse(value))) throw new RangeError(`${name} must be a date, for example 2026-10-05 or 2026-10-05T12:00:00Z`);
    }
    const accountId = q.get("accountId");
    const workspaceId = q.get("workspaceId");
    const groups = new Map<string, Aggregate>();
    const total = empty();
    const add = (a: Aggregate, e: Extract<LedgerEntry, { type: "spend" }>): void => {
      a.calls++;
      if (e.outcome === "failed") a.failed++;
      if (e.outcome === "aborted") a.aborted++;
      a.input += e.usage.input;
      a.output += e.usage.output;
      a.cacheRead += e.usage.cacheRead;
      a.cacheWrite += e.usage.cacheWrite;
      a.costMicros += e.costMicros;
      a.chargeMicros += e.chargeMicros;
      a.marginMicros += e.chargeMicros - e.costMicros;
    };
    for await (const e of this.ledger.scan()) {
      if (e.type !== "spend") continue;
      if (accountId !== null && e.accountId !== accountId) continue;
      if (workspaceId !== null && e.workspaceId !== workspaceId) continue;
      if (from !== null && e.at < new Date(from).toISOString()) continue;
      if (to !== null && e.at >= new Date(to).toISOString()) continue;
      const group = groupBy === "account" ? e.accountId : groupBy === "workspace" ? (e.workspaceId ?? "") : groupBy === "model" ? `${e.provider}/${e.model}` : groupBy === "alias" ? e.alias : e.at.slice(0, 10);
      let a = groups.get(group);
      if (!a) groups.set(group, (a = empty()));
      add(a, e);
      add(total, e);
    }
    return reply(200, {
      currency: this.ledger.currency,
      groupBy,
      groups: [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([group, a]) => ({ group, ...a })),
      total,
    });
  }
}

/** Compared as hashes, so the comparison takes the same time whatever the two have in common. A missing token is the hash of nothing, which no token of 24 characters or more has. */
function tokenMatches(presented: string | undefined, expected: string): boolean {
  const a = createHash("sha256").update(presented ?? "", "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

export interface AdminServerOptions extends ServerOptions {
  /** The bearer token the control plane presents. */
  token: string;
}

export function createAdminServer(api: AdminApi, gateway: Gateway, options: AdminServerOptions): http.Server {
  if (options.token.length < 24) throw new Error("the admin token must be at least 24 characters");
  const maxBody = options.maxBodyBytes ?? 1024 * 1024;
  const server = http.createServer((req, res) => {
    void (async () => {
      const bearer = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? "")?.[1];
      if (!tokenMatches(bearer, options.token)) {
        return sendError(res, new WireError(401, "invalid_admin_token", "The admin token is not valid."), { connection: "close" });
      }
      const url = new URL(req.url ?? "/", "http://gateway.invalid");
      let body: unknown;
      if (req.method === "POST") {
        let raw: Buffer;
        try {
          raw = await readBody(req, maxBody);
        } catch (err) {
          return sendError(res, err, { connection: "close" });
        }
        try {
          body = raw.length === 0 ? {} : JSON.parse(raw.toString("utf8"));
        } catch {
          return sendError(res, new WireError(400, "invalid_json", "The request body is not valid JSON."));
        }
      }
      const out = await api.handle(req.method ?? "GET", url, body);
      sendJson(res, out.status, out.body, { "x-request-id": newRequestId() });
    })().catch((err: unknown) => {
      gateway.log("error", "the admin server failed to handle a request", { error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
      if (res.headersSent) res.destroy();
      else sendError(res, err);
    });
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 60_000;
  return server;
}
