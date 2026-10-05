/**
 * The control plane's public API: sign up, sign in, plans, checkout, workspaces, and the payment provider's messages.
 *
 * `ControlWeb` is plain: a request (method, path, query, headers, body, address) goes in and a response (status, headers, body)
 * comes out, so everything it decides can be tested without a socket. `web-server.ts` is the thin layer that reads a request
 * from a socket and writes the response back.
 *
 * What it keeps to, for the sake of the people on the other end:
 *
 *   - A cookie is ambient authority, so it is never enough for a change on its own. Every POST must say it is JSON (which a
 *     form on another site cannot), and a POST that carries the session cookie must name this service's own address as its
 *     origin. The cookie is `HttpOnly`, `SameSite=Lax`, and `__Host-` prefixed when the service is on HTTPS, which browsers
 *     then refuse to accept from anywhere else or for a wider path.
 *   - Nothing it says to a stranger reveals whether an address has an account: a sign-up and a reset request are answered the
 *     same whatever the address is, and a failed sign-in says one thing.
 *   - Everything that can be guessed or mailed is rate limited: sign-ups, sign-ins, resets, links, and each action that costs
 *     something. A limit is by address and, where it matters, by the email asked about, so a password cannot be guessed from
 *     many places at once and an inbox cannot be filled from many places at once.
 *   - What a customer sees of usage is what they were charged. What the service paid, and what it made, is not in any response.
 *   - The payment provider's messages are read only after their signature is checked, from the exact bytes received.
 */
import { BillingWebhookError } from "./billing";
import type { ControlPlane } from "./control-plane";
import { ServiceError, describeError } from "./errors";
import { DEFAULT_LIMITS, RateLimiter, type Limit, type Limits } from "./limits";
import { ControlUnavailableError, type Account } from "./store";
import type { WorkspaceAccess } from "./workspace-access";

export interface WebRequest {
  method: string;
  /** The path, with no query and no host. */
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  /** The caller's address, as far as the trusted proxy in front of the service says. */
  ip: string;
}

export interface WebResponse {
  status: number;
  headers: Record<string, string | string[]>;
  body: string | Buffer;
}

export interface WebLog {
  level: "info" | "warn" | "error";
  msg: string;
  [field: string]: unknown;
}

export interface WebOptions {
  plane: ControlPlane;
  access: WorkspaceAccess;
  /** The address of the app, as a browser reaches it: `https://app.example.com`. */
  appUrl: string;
  /** `https` (the default) or `http`, for the addresses workspaces are opened at. `http` is for trying it on one machine. */
  workspaceScheme?: "https" | "http";
  /** The port workspaces are reached on, when it is not the scheme's own. */
  workspacePort?: number;
  /** Whether cookies are marked `Secure`. Default: whether `appUrl` is HTTPS. */
  secureCookies?: boolean;
  limits?: Partial<Limits>;
  clock?: () => Date;
  log?: (record: WebLog) => void;
  /** The largest request body, in bytes. Default 64 KiB; the payment provider's messages are allowed 1 MiB. */
  maxBodyBytes?: number;
}

const JSON_TYPE = /^application\/json\s*(;|$)/i;

export function parseCookies(header: string | string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = Array.isArray(header) ? header.join("; ") : header;
  if (!raw) return out;
  for (const pair of raw.split(";")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name && !(name in out)) out[name] = value;
  }
  return out;
}

const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** A path segment as the caller wrote it. A malformed escape names nothing that exists, so it is left as it is and answered as any other id that is not there. */
export function pathSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** The headers every response carries. The API sends JSON and nothing a browser should run or frame. */
export function securityHeaders(secure: boolean): Record<string, string> {
  return {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    ...(secure ? { "strict-transport-security": "max-age=31536000; includeSubDomains" } : {}),
  };
}

interface Session {
  account: Account;
  sessionId: string;
  token: string;
}

export class ControlWeb {
  private readonly limiter: RateLimiter;
  private readonly limits: Limits;
  private readonly clock: () => Date;
  /** Whether the cookie is marked `Secure`, which is whether the service is served over HTTPS. */
  readonly secureCookies: boolean;
  private readonly origin: string;
  private readonly cookieName: string;
  private readonly scheme: "https" | "http";

  constructor(private readonly o: WebOptions) {
    this.clock = o.clock ?? (() => new Date());
    this.limiter = new RateLimiter(() => this.clock().getTime());
    this.limits = { ...DEFAULT_LIMITS, ...o.limits };
    this.origin = new URL(o.appUrl).origin;
    this.secureCookies = o.secureCookies ?? this.origin.startsWith("https:");
    this.cookieName = this.secureCookies ? "__Host-curule_session" : "curule_session";
    this.scheme = o.workspaceScheme ?? "https";
  }

  /** The name of the cookie a session rides in. */
  get sessionCookieName(): string {
    return this.cookieName;
  }

  private log(level: WebLog["level"], msg: string, fields: Record<string, unknown> = {}): void {
    this.o.log?.({ level, msg, ...fields });
  }

  json(status: number, body: unknown, headers: Record<string, string | string[]> = {}): WebResponse {
    return { status, headers: { "content-type": "application/json; charset=utf-8", ...securityHeaders(this.secureCookies), ...headers }, body: JSON.stringify(body) };
  }

  private failure(err: ServiceError): WebResponse {
    // A refusal for a reason on our side (a provider that did not answer) is one the operator reads, with what caused it.
    if (err.status >= 500) this.log("error", "a request could not be answered", { code: err.code, error: describeError(err.cause ?? err) });
    return this.json(err.status, { error: { code: err.code, message: err.message } }, err.headers);
  }

  private sessionCookie(token: string): string {
    return `${this.cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${this.o.plane.accounts.policy.sessionDays * 86_400}${this.secureCookies ? "; Secure" : ""}`;
  }

  private clearedCookie(): string {
    return `${this.cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${this.secureCookies ? "; Secure" : ""}`;
  }

  /** Refuse the caller when a limit is used up, telling them how long to wait. */
  private limit(name: keyof Limits, key: string): void {
    const l: Limit = this.limits[name];
    const v = this.limiter.hit(`${name}:${key}`, l.max, l.windowMs);
    if (!v.ok) {
      this.log("warn", "rate limit", { limit: name, retryAfterSec: v.retryAfterSec });
      const minutes = Math.ceil(v.retryAfterSec / 60);
      throw new ServiceError(429, "rate_limited", v.retryAfterSec < 90 ? "Too many attempts. Wait a minute and try again." : `Too many attempts. Try again in ${minutes} minutes.`, { "retry-after": String(v.retryAfterSec) });
    }
  }

  private readJson(req: WebRequest): Record<string, unknown> {
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

  /** A change must say it is JSON, and must come from this service's own pages when it carries a session. */
  private guardChange(req: WebRequest, hasCookie: boolean): void {
    const type = first(req.headers["content-type"]);
    if (req.body.length > 0 && !(type && JSON_TYPE.test(type))) throw new ServiceError(415, "unsupported_media_type", "Send JSON, with Content-Type: application/json.");
    const origin = first(req.headers.origin);
    if (origin !== undefined) {
      if (origin !== this.origin) {
        this.log("warn", "request from another origin", { origin });
        throw new ServiceError(403, "bad_origin", "This request did not come from this service's own pages.");
      }
    } else if (hasCookie) {
      throw new ServiceError(403, "bad_origin", "This request did not say where it came from.");
    }
  }

  private session(req: WebRequest): Session | undefined {
    const token = parseCookies(req.headers.cookie)[this.cookieName];
    const who = this.o.plane.accounts.identify(token);
    return who && token ? { ...who, token } : undefined;
  }

  private needSession(who: Session | undefined): Session {
    if (!who) throw new ServiceError(401, "not_signed_in", "Sign in to continue.");
    return who;
  }

  private readonly routes: Array<{ method: string; pattern: RegExp; run: (req: WebRequest, m: RegExpExecArray, who: Session | undefined) => Promise<WebResponse> }> = [
    { method: "GET", pattern: /^\/healthz$/, run: async () => this.health() },
    { method: "GET", pattern: /^\/api\/plans$/, run: async () => this.plans() },
    { method: "POST", pattern: /^\/api\/signup$/, run: (req) => this.signup(req) },
    { method: "POST", pattern: /^\/api\/verify$/, run: (req) => this.verify(req) },
    { method: "POST", pattern: /^\/api\/login$/, run: (req) => this.login(req) },
    { method: "POST", pattern: /^\/api\/logout$/, run: (req, _m, who) => this.logout(req, who) },
    { method: "POST", pattern: /^\/api\/forgot$/, run: (req) => this.forgot(req) },
    { method: "POST", pattern: /^\/api\/reset$/, run: (req) => this.reset(req) },
    { method: "POST", pattern: /^\/api\/password$/, run: (req, _m, who) => this.password(req, this.needSession(who)) },
    { method: "GET", pattern: /^\/api\/session$/, run: (_req, _m, who) => this.sessionView(who) },
    { method: "GET", pattern: /^\/api\/me$/, run: (_req, _m, who) => this.me(this.needSession(who)) },
    { method: "GET", pattern: /^\/api\/usage$/, run: (_req, _m, who) => this.usage(this.needSession(who)) },
    { method: "POST", pattern: /^\/api\/checkout$/, run: (req, _m, who) => this.checkout(req, this.needSession(who)) },
    { method: "POST", pattern: /^\/api\/portal$/, run: (_req, _m, who) => this.portal(this.needSession(who)) },
    { method: "POST", pattern: /^\/api\/workspaces$/, run: (req, _m, who) => this.createWorkspace(req, this.needSession(who)) },
    { method: "POST", pattern: /^\/api\/workspaces\/([^/]+)\/open$/, run: (_req, m, who) => this.openWorkspace(pathSegment(m[1]!), this.needSession(who)) },
    { method: "POST", pattern: /^\/api\/workspaces\/([^/]+)\/suspend$/, run: (_req, m, who) => this.changeWorkspace("suspend", pathSegment(m[1]!), this.needSession(who)) },
    { method: "POST", pattern: /^\/api\/workspaces\/([^/]+)\/resume$/, run: (_req, m, who) => this.changeWorkspace("resume", pathSegment(m[1]!), this.needSession(who)) },
    { method: "POST", pattern: /^\/api\/workspaces\/([^/]+)\/delete$/, run: (req, m, who) => this.deleteWorkspace(req, pathSegment(m[1]!), this.needSession(who)) },
    { method: "POST", pattern: /^\/webhooks\/billing$/, run: (req) => this.webhook(req) },
  ];

  async handle(req: WebRequest): Promise<WebResponse> {
    try {
      const path = req.path.replace(/\/+$/, "") || "/";
      const matching = this.routes.map((r) => ({ r, m: r.pattern.exec(path) })).filter((x) => x.m !== null);
      if (matching.length === 0) return this.failure(new ServiceError(404, "not_found", `There is nothing at ${path}.`));
      const hit = matching.find((x) => x.r.method === req.method);
      if (!hit) return this.failure(new ServiceError(405, "method_not_allowed", `Use ${matching.map((x) => x.r.method).join(" or ")} for ${path}.`, { allow: matching.map((x) => x.r.method).join(", ") }));
      const isWebhook = path === "/webhooks/billing";
      if (!isWebhook && path !== "/healthz") this.limit("apiIp", req.ip);
      const who = isWebhook ? undefined : this.session(req);
      if (req.method !== "GET" && !isWebhook) this.guardChange(req, parseCookies(req.headers.cookie)[this.cookieName] !== undefined);
      const response = await hit.r.run(req, hit.m!, who);
      if (who && !isWebhook) await this.o.plane.accounts.touch(who.token).catch(() => undefined);
      return response;
    } catch (err) {
      if (err instanceof ServiceError) return this.failure(err);
      // A full disk is not a mistake in the request, and it does not last until somebody notices: say so, so the page can.
      if (err instanceof ControlUnavailableError) {
        this.log("error", "the control log cannot be written", { error: err.message, path: req.path });
        return this.json(503, { error: { code: "unavailable", message: "Changes cannot be saved just now. Try again in a few minutes." } }, { "retry-after": "60" });
      }
      this.log("error", "the control server failed to handle a request", { error: describeError(err), path: req.path });
      return this.json(500, { error: { code: "internal_error", message: "Something went wrong on our side. Try again in a moment." } });
    }
  }

  // ---- the handlers ----

  private health(): WebResponse {
    const ok = this.o.plane.o.log.writable;
    return this.json(ok ? 200 : 503, { ok });
  }

  private plans(): WebResponse {
    const c = this.o.plane.o.catalogue;
    return this.json(200, {
      currency: c.currency,
      plans: c.plans().map((p) => ({ id: p.id, title: p.title, priceMinor: p.priceMinor, period: p.period, includedUsageMicros: p.includedUsageMicros, workspaces: p.workspaces, ...(p.tiers ? { tiers: p.tiers } : {}), ...(p.summary ? { summary: p.summary } : {}) })),
      topups: c.topups,
      policy: this.o.plane.policy,
    });
  }

  private async signup(req: WebRequest): Promise<WebResponse> {
    const body = this.readJson(req);
    this.limit("signupIp", req.ip);
    // The email is limited as it will be read, so changing its case does not buy another try.
    const emailKey = typeof body.email === "string" ? `signupEmail:${body.email.trim().toLowerCase()}` : undefined;
    if (typeof body.email === "string") this.limit("signupEmail", body.email.trim().toLowerCase());
    try {
      await this.o.plane.accounts.signup(body.email, body.password);
    } catch (err) {
      // An address that is not one, or a password that is not good enough, sent no mail: it is not held against the caller.
      if (err instanceof ServiceError && (err.code === "invalid_email" || err.code === "weak_password")) {
        this.limiter.undo(`signupIp:${req.ip}`);
        if (emailKey) this.limiter.undo(emailKey);
      }
      throw err;
    }
    return this.json(202, { ok: true, message: "Check your email for a link to confirm your address." });
  }

  private async verify(req: WebRequest): Promise<WebResponse> {
    const body = this.readJson(req);
    this.limit("tokenIp", req.ip);
    const session = await this.o.plane.accounts.verify(body.token, { ip: req.ip, userAgent: first(req.headers["user-agent"]) ?? "" });
    return this.json(200, { account: this.o.plane.view(session.account) }, { "set-cookie": this.sessionCookie(session.sessionToken) });
  }

  private async login(req: WebRequest): Promise<WebResponse> {
    const body = this.readJson(req);
    this.limit("loginIp", req.ip);
    const emailKey = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    this.limit("loginEmail", emailKey);
    try {
      const session = await this.o.plane.accounts.login(body.email, body.password, { ip: req.ip, userAgent: first(req.headers["user-agent"]) ?? "" });
      this.limiter.reset(`loginEmail:${emailKey}`);
      return this.json(200, { account: this.o.plane.view(session.account) }, { "set-cookie": this.sessionCookie(session.sessionToken) });
    } catch (err) {
      if (err instanceof ServiceError && err.code === "invalid_credentials") this.log("info", "sign-in refused", { ip: req.ip });
      throw err;
    }
  }

  private async logout(req: WebRequest, who: Session | undefined): Promise<WebResponse> {
    void req;
    if (who) await this.o.plane.accounts.logout(who.token);
    return this.json(200, { ok: true }, { "set-cookie": this.clearedCookie() });
  }

  private async forgot(req: WebRequest): Promise<WebResponse> {
    const body = this.readJson(req);
    this.limit("forgotIp", req.ip);
    if (typeof body.email === "string") this.limit("forgotEmail", body.email.trim().toLowerCase());
    await this.o.plane.accounts.requestReset(body.email);
    return this.json(202, { ok: true, message: "If that address has an account, a link to choose a new password is on its way." });
  }

  private async reset(req: WebRequest): Promise<WebResponse> {
    const body = this.readJson(req);
    this.limit("tokenIp", req.ip);
    const { email } = await this.o.plane.accounts.completeReset(body.token, body.password);
    // The link came to the person's own mailbox, which says more than a password does: what was held against the address is over.
    this.limiter.reset(`loginEmail:${email}`);
    return this.json(200, { ok: true }, { "set-cookie": this.clearedCookie() });
  }

  private async password(req: WebRequest, who: Session): Promise<WebResponse> {
    const body = this.readJson(req);
    this.limit("actionSession", who.sessionId);
    this.limit("loginEmail", who.account.email);
    await this.o.plane.accounts.changePassword(who.account.accountId, body.current, body.next, who.token);
    this.limiter.reset(`loginEmail:${who.account.email}`);
    return this.json(200, { ok: true });
  }

  /**
   * Whether the browser is signed in, and as whom. Every page asks this to draw its header, so it is cheap (no balance is read)
   * and it never answers 401: a visitor who is not signed in is the ordinary case, and an error in the browser's console for it
   * would be noise on every page they open.
   */
  private async sessionView(who: Session | undefined): Promise<WebResponse> {
    return this.json(200, { account: who ? this.o.plane.view(who.account) : null });
  }

  private async me(who: Session): Promise<WebResponse> {
    const balance = await this.o.plane.balance(who.account.accountId).catch((err: unknown) => {
      this.log("warn", "the balance could not be read", { error: describeError(err) });
      return null;
    });
    return this.json(200, { account: this.o.plane.view(who.account), balance });
  }

  private async usage(who: Session): Promise<WebResponse> {
    this.limit("actionSession", who.sessionId);
    try {
      return this.json(200, await this.o.plane.usage(who.account.accountId));
    } catch (err) {
      throw new ServiceError(502, "usage_unavailable", "Usage could not be read just now. Try again in a moment.", {}, { cause: err });
    }
  }

  private async checkout(req: WebRequest, who: Session): Promise<WebResponse> {
    const body = this.readJson(req);
    this.limit("actionSession", who.sessionId);
    return this.json(200, await this.o.plane.startCheckout(who.account.accountId, { purpose: body.purpose, plan: body.plan, amountMinor: body.amountMinor }));
  }

  private async portal(who: Session): Promise<WebResponse> {
    this.limit("actionSession", who.sessionId);
    return this.json(200, await this.o.plane.openPortal(who.account.accountId));
  }

  private workspaceView(who: Session, workspaceId: string): ReturnType<ControlPlane["view"]>["workspaces"][number] {
    const found = this.o.plane.view(who.account).workspaces.find((w) => w.workspaceId === workspaceId);
    if (!found) throw new ServiceError(404, "not_found", "There is no such workspace.");
    return found;
  }

  private async createWorkspace(req: WebRequest, who: Session): Promise<WebResponse> {
    const body = this.readJson(req);
    this.limit("actionSession", who.sessionId);
    const w = await this.o.plane.workspaces.create(who.account.accountId, body.name);
    return this.json(201, { workspace: this.workspaceView(who, w.workspaceId) });
  }

  private async openWorkspace(workspaceId: string, who: Session): Promise<WebResponse> {
    this.limit("actionSession", who.sessionId);
    const view = this.workspaceView(who, workspaceId);
    if (view.status !== "running") {
      const why: Record<string, string> = { requested: "This workspace is still starting.", provisioning: "This workspace is still starting.", suspended: "This workspace is stopped. Start it first.", failed: "This workspace could not start." };
      throw new ServiceError(409, "not_running", why[view.status] ?? `This workspace is ${view.status}.`);
    }
    const code = this.o.access.issueCode({ accountId: who.account.accountId, workspaceId, sessionId: who.sessionId });
    return this.json(200, { url: `${this.scheme}://${view.host}${this.o.workspacePort !== undefined ? `:${this.o.workspacePort}` : ""}/__enter?code=${encodeURIComponent(code)}` });
  }

  private async changeWorkspace(action: "suspend" | "resume", workspaceId: string, who: Session): Promise<WebResponse> {
    this.limit("actionSession", who.sessionId);
    if (action === "suspend") await this.o.plane.workspaces.suspend(workspaceId, "paused by its owner", who.account.accountId);
    else await this.o.plane.workspaces.resume(workspaceId, who.account.accountId);
    return this.json(200, { workspace: this.workspaceView(who, workspaceId) });
  }

  private async deleteWorkspace(req: WebRequest, workspaceId: string, who: Session): Promise<WebResponse> {
    const body = this.readJson(req);
    this.limit("actionSession", who.sessionId);
    const view = this.workspaceView(who, workspaceId);
    if (body.confirm !== view.name) throw new ServiceError(400, "confirmation_needed", "Type the workspace's name to delete it and everything in it.");
    await this.o.plane.workspaces.destroy(workspaceId, who.account.accountId);
    return this.json(200, { ok: true });
  }

  private async webhook(req: WebRequest): Promise<WebResponse> {
    try {
      const result = await this.o.plane.handleWebhook(req.headers, req.body);
      return this.json(200, { received: true, ...result });
    } catch (err) {
      if (err instanceof BillingWebhookError) {
        this.log("warn", "a message from the payment provider was refused", { reason: err.message, ip: req.ip });
        return this.json(400, { error: { code: "bad_message", message: "That message was not accepted." } });
      }
      // Anything else is ours to put right, and the provider sends the message again.
      this.log("error", "a payment message could not be applied", { error: describeError(err) });
      return this.json(500, { error: { code: "internal_error", message: "The message could not be applied." } });
    }
  }
}
