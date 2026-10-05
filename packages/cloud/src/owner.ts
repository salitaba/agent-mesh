/**
 * The operator's API: look at accounts, record a payment that arrived some other way, stop an account, see the money.
 *
 * It is a different door from the public one, on its own port and behind its own token, because what it can do is different in
 * kind: record that money arrived, stop a customer, read every account. Keep it off any network a customer can reach. It
 * returns no credential and no hash, and everything it changes is an entry in the control log under the name `owner.action`.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { ControlPlane } from "./control-plane";
import { ServiceError, describeError } from "./errors";
import { RateLimiter } from "./limits";
import type { MailStats } from "./mail-queue";
import { ControlUnavailableError } from "./store";
import type { WebLog, WebRequest, WebResponse } from "./web";
import { pathSegment, securityHeaders } from "./web";

export interface OwnerOptions {
  plane: ControlPlane;
  /** The bearer token the operator presents: at least 24 characters. */
  token: string;
  clock?: () => Date;
  log?: (record: WebLog) => void;
  /** What the mail queue holds, when mail goes by one. Mail that cannot get out is a thing the operator is told with the rest of the health. */
  mail?: () => MailStats;
}

const MAX_PAGE = 200;

function tokenMatches(presented: string | undefined, expected: string): boolean {
  const a = createHash("sha256").update(presented ?? "", "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

export class OwnerWeb {
  private readonly limiter: RateLimiter;

  constructor(private readonly o: OwnerOptions) {
    if (o.token.length < 24) throw new Error("the owner token must be at least 24 characters");
    this.limiter = new RateLimiter(() => (o.clock ?? (() => new Date()))().getTime());
  }

  private json(status: number, body: unknown, headers: Record<string, string> = {}): WebResponse {
    return { status, headers: { "content-type": "application/json; charset=utf-8", ...securityHeaders(true), ...headers }, body: JSON.stringify(body) };
  }

  private fail(err: ServiceError): WebResponse {
    if (err.status >= 500) this.o.log?.({ level: "error", msg: "a request could not be answered", code: err.code, error: describeError(err.cause ?? err) });
    return this.json(err.status, { error: { code: err.code, message: err.message } }, err.headers);
  }

  private body(req: WebRequest): Record<string, unknown> {
    if (req.body.length === 0) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(req.body.toString("utf8"));
    } catch {
      throw new ServiceError(400, "invalid_json", "The request body is not valid JSON.");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new ServiceError(400, "invalid_json", "The request body must be a JSON object.");
    return parsed as Record<string, unknown>;
  }

  private text(v: unknown, name: string): string {
    if (typeof v !== "string" || v.trim() === "") throw new ServiceError(400, "invalid_request", `${name} is required.`);
    return v.trim();
  }

  private readonly routes: Array<{ method: string; pattern: RegExp; run: (req: WebRequest, m: RegExpExecArray) => Promise<WebResponse> | WebResponse }> = [
    { method: "GET", pattern: /^\/owner\/health$/, run: () => this.health() },
    { method: "GET", pattern: /^\/owner\/accounts$/, run: (req) => this.accounts(req) },
    { method: "GET", pattern: /^\/owner\/accounts\/([^/]+)$/, run: (_req, m) => this.account(pathSegment(m[1]!)) },
    { method: "POST", pattern: /^\/owner\/accounts\/([^/]+)\/disable$/, run: (req, m) => this.disable(req, pathSegment(m[1]!)) },
    { method: "POST", pattern: /^\/owner\/accounts\/([^/]+)\/enable$/, run: (_req, m) => this.enable(pathSegment(m[1]!)) },
    { method: "POST", pattern: /^\/owner\/payments$/, run: (req) => this.payment(req) },
    { method: "GET", pattern: /^\/owner\/unmatched$/, run: () => this.json(200, { unmatched: this.o.plane.unmatched() }) },
    { method: "GET", pattern: /^\/owner\/margin$/, run: (req) => this.margin(req) },
    { method: "POST", pattern: /^\/owner\/reconcile$/, run: async () => this.json(200, { actions: await this.o.plane.workspaces.reconcile() }) },
    { method: "GET", pattern: /^\/owner\/workspaces$/, run: (req) => this.workspaces(req) },
    { method: "POST", pattern: /^\/owner\/workspaces\/([^/]+)\/(suspend|resume|destroy)$/, run: (req, m) => this.workspace(req, pathSegment(m[1]!), m[2] as "suspend" | "resume" | "destroy") },
  ];

  async handle(req: WebRequest): Promise<WebResponse> {
    try {
      const given = /^Bearer\s+(\S+)\s*$/i.exec(String(Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : (req.headers.authorization ?? "")))?.[1];
      // Wrong tokens are counted by address, so the token cannot be guessed here any faster than anywhere else.
      const blocked = this.limiter.hit(`tokens:${req.ip}`, 20, 600_000);
      if (!blocked.ok) throw new ServiceError(429, "rate_limited", "Too many requests with a wrong token.", { "retry-after": String(blocked.retryAfterSec) });
      if (!tokenMatches(given, this.o.token)) throw new ServiceError(401, "invalid_owner_token", "The owner token is not valid.");
      this.limiter.undo(`tokens:${req.ip}`);
      const path = req.path.replace(/\/+$/, "") || "/";
      const matching = this.routes.map((r) => ({ r, m: r.pattern.exec(path) })).filter((x) => x.m !== null);
      if (matching.length === 0) return this.fail(new ServiceError(404, "not_found", `There is nothing at ${path}.`));
      const hit = matching.find((x) => x.r.method === req.method);
      if (!hit) return this.fail(new ServiceError(405, "method_not_allowed", `Use ${matching.map((x) => x.r.method).join(" or ")} for ${path}.`, { allow: matching.map((x) => x.r.method).join(", ") }));
      return await hit.r.run(req, hit.m!);
    } catch (err) {
      if (err instanceof ServiceError) return this.fail(err);
      if (err instanceof ControlUnavailableError) {
        this.o.log?.({ level: "error", msg: "the control log cannot be written", error: err.message });
        return this.json(503, { error: { code: "unavailable", message: err.message } }, { "retry-after": "60" });
      }
      this.o.log?.({ level: "error", msg: "the owner API failed to handle a request", error: describeError(err) });
      return this.json(500, { error: { code: "internal_error", message: "The request failed." } });
    }
  }

  private health(): WebResponse {
    const state = this.o.plane.o.log.state;
    const byStatus: Record<string, number> = {};
    for (const w of state.workspaces.values()) byStatus[w.status] = (byStatus[w.status] ?? 0) + 1;
    const mail = this.o.mail?.();
    const writable = this.o.plane.o.log.writable;
    // A queue whose oldest message has waited too long is mail that is not getting out: no one is told to confirm an address or that a payment failed.
    return this.json(200, { ok: writable && !(mail?.stuck ?? false), writable, accounts: state.accounts.size, workspaces: byStatus, unmatchedPayments: this.o.plane.unmatched().length, ...(mail ? { mail } : {}) });
  }

  private summary(accountId: string) {
    const a = this.o.plane.o.log.state.accounts.get(accountId)!;
    return {
      accountId: a.accountId,
      email: a.email,
      createdAt: a.createdAt,
      verified: a.verifiedAt !== undefined,
      ...(a.disabledAt !== undefined ? { disabledAt: a.disabledAt, disabledReason: a.disabledReason } : {}),
      subscription: a.subscription ? { plan: a.subscription.plan, status: a.subscription.status, ...(a.subscription.periodEnd ? { periodEnd: a.subscription.periodEnd } : {}) } : null,
      workspaces: this.o.plane.workspaces.forAccount(a.accountId).length,
    };
  }

  private accounts(req: WebRequest): WebResponse {
    const q = (req.query.get("q") ?? "").trim().toLowerCase();
    const limit = req.query.has("limit") ? Number(req.query.get("limit")) : 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) throw new ServiceError(400, "invalid_request", `limit must be a whole number from 1 to ${MAX_PAGE}.`);
    const all = [...this.o.plane.o.log.state.accounts.values()].filter((a) => q === "" || a.email.includes(q) || a.accountId.includes(q)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return this.json(200, { accounts: all.slice(-limit).map((a) => this.summary(a.accountId)), matched: all.length, truncated: all.length > limit });
  }

  private async account(accountId: string): Promise<WebResponse> {
    const a = this.o.plane.o.log.state.accounts.get(accountId);
    if (!a) throw new ServiceError(404, "not_found", "There is no such account.");
    const balance = await this.o.plane.balance(accountId).catch(() => null);
    return this.json(200, { account: this.summary(accountId), view: this.o.plane.view(a), balance });
  }

  private async disable(req: WebRequest, accountId: string): Promise<WebResponse> {
    await this.o.plane.disableAccount(accountId, this.text(this.body(req).reason, "reason"));
    return this.json(200, { account: this.summary(accountId) });
  }

  private async enable(accountId: string): Promise<WebResponse> {
    await this.o.plane.enableAccount(accountId);
    return this.json(200, { account: this.summary(accountId) });
  }

  private async payment(req: WebRequest): Promise<WebResponse> {
    const b = this.body(req);
    const purpose = b.purpose;
    if (purpose !== "subscription" && purpose !== "topup") throw new ServiceError(400, "invalid_request", "purpose must be subscription or topup.");
    if (typeof b.amountMinor !== "number" || !Number.isInteger(b.amountMinor)) throw new ServiceError(400, "invalid_request", "amountMinor must be a whole number of minor units.");
    const result = await this.o.plane.recordPayment({
      accountId: this.text(b.accountId, "accountId"),
      purpose,
      ...(typeof b.plan === "string" && b.plan !== "" ? { plan: b.plan } : {}),
      amountMinor: b.amountMinor,
      currency: this.text(b.currency, "currency"),
      ref: this.text(b.ref, "ref"),
      ...(typeof b.note === "string" && b.note !== "" ? { note: b.note.slice(0, 200) } : {}),
    });
    return this.json(200, result);
  }

  private async margin(req: WebRequest): Promise<WebResponse> {
    // A bound that is empty is not given.
    const from = req.query.get("from") || undefined;
    const to = req.query.get("to") || undefined;
    for (const [name, v] of [["from", from], ["to", to]] as const) {
      if (v !== undefined && Number.isNaN(Date.parse(v))) throw new ServiceError(400, "invalid_request", `${name} must be a date, for example 2026-10-05 or 2026-10-05T12:00:00Z.`);
    }
    return this.json(200, await this.o.plane.margin(from, to));
  }

  private workspaces(req: WebRequest): WebResponse {
    const status = req.query.get("status");
    const list = [...this.o.plane.o.log.state.workspaces.values()].filter((w) => status === null || w.status === status).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return this.json(200, {
      workspaces: list.slice(-MAX_PAGE).map((w) => ({ workspaceId: w.workspaceId, accountId: w.accountId, name: w.name, slug: w.slug, plan: w.plan, status: w.status, ...(w.statusReason ? { statusReason: w.statusReason } : {}), createdAt: w.createdAt })),
      matched: list.length,
    });
  }

  private async workspace(req: WebRequest, workspaceId: string, action: "suspend" | "resume" | "destroy"): Promise<WebResponse> {
    if (action === "suspend") await this.o.plane.workspaces.suspend(workspaceId, this.text(this.body(req).reason, "reason"));
    else if (action === "resume") await this.o.plane.workspaces.resume(workspaceId);
    else await this.o.plane.workspaces.destroy(workspaceId);
    await this.o.plane.o.log.append({ type: "owner.action", action: `workspace.${action}`, detail: workspaceId });
    const w = this.o.plane.o.log.state.workspaces.get(workspaceId)!;
    return this.json(200, { workspace: { workspaceId: w.workspaceId, status: w.status, ...(w.statusReason ? { statusReason: w.statusReason } : {}) } });
  }
}
