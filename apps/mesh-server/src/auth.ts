import type * as http from "http";
import { createHash, timingSafeEqual } from "crypto";
import { clientKey, type FailureLimiter } from "./web-security";
import { SESSION_COOKIE, clearedSessionCookie, cookieSecure, parseCookies, sessionCookie, type SessionStore } from "./sessions";

export function getApiToken(): string {
  return (process.env.MESH_API_TOKEN ?? "").trim();
}

function pathOf(parts: string[]): string {
  return `/${parts.join("/")}`;
}

/**
 * Strict mode: nothing is public, not even `/health` or the dashboard.
 *
 * A multi-project child binds to loopback and executes agent-authored code and
 * shell commands. Any other local process could otherwise drive it directly and
 * bypass the host entirely, so a child accepts only requests carrying its own
 * per-child bearer token. Single-process `mesh serve` keeps the friendlier
 * default where a liveness probe and the dashboard need no credentials.
 */
export function isStrictAuth(): boolean {
  return (process.env.MESH_STRICT_AUTH ?? "").trim() === "1";
}

/**
 * Paths that stay public even when MESH_API_TOKEN is set.
 *
 * `/auth/*` is how the dashboard signs in, so it cannot require being signed in:
 * the status read, the login and the logout. Nothing else under it exists.
 */
export function isPublicPath(method: string, parts: string[]): boolean {
  if (isStrictAuth()) return false;
  if (method === "GET" && parts.length === 1 && parts[0] === "health") return true;
  if (method === "GET" && (parts.length === 0 || parts[0] === "dashboard")) return true;
  // Dashboard static assets served via the catch-all GET route.
  if (method === "GET" && parts.length >= 1 && parts[0] === "assets") return true;
  if (parts[0] === "auth" && parts.length === 2) {
    if (method === "GET" && parts[1] === "status") return true;
    if (method === "POST" && (parts[1] === "login" || parts[1] === "logout")) return true;
  }
  void pathOf;
  return false;
}

/**
 * The operator token a request presents, from a header. Never from the URL: a
 * token in a query string lands in access logs, proxy logs, browser history and
 * the `Referer` of every link followed from the page, and nothing here needs it
 * (the CLI and the bridge send a header; the dashboard signs in for a cookie).
 */
export function extractToken(req: http.IncomingMessage): string {
  const auth = req.headers.authorization ?? req.headers.Authorization;
  const header = Array.isArray(auth) ? auth[0] : (auth as string | undefined);
  if (header && header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  const meshToken = req.headers["x-mesh-token"];
  if (typeof meshToken === "string" && meshToken) return meshToken;
  if (Array.isArray(meshToken) && meshToken[0]) return meshToken[0];
  return "";
}

/** Constant-time compare so a token cannot be recovered byte by byte. */
export function tokenMatches(supplied: string, configured: string): boolean {
  const a = Buffer.from(supplied, "utf8");
  const b = Buffer.from(configured, "utf8");
  // timingSafeEqual throws on length mismatch, which would itself leak length;
  // hashing both sides to a fixed width keeps the comparison uniform.
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** What `requireAuth` may consult beyond the headers. Both are per server, so two servers never share a sign-in. */
export interface AuthContext {
  sessions?: SessionStore;
  limiter?: FailureLimiter;
}

export interface AuthResult {
  ok: boolean;
  error?: string;
  /** The status to answer with when `ok` is false. Absent means 401. */
  status?: number;
  /** Set with a 429: seconds until the caller's next attempt will be looked at. */
  retryAfterSec?: number;
}

function sessionPresented(req: http.IncomingMessage, ctx: AuthContext): boolean {
  if (!ctx.sessions) return false;
  return ctx.sessions.valid(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
}

export function requireAuth(req: http.IncomingMessage, url: URL, parts: string[], ctx: AuthContext = {}): AuthResult {
  void url;
  const configured = getApiToken();
  const strict = isStrictAuth();
  // Fail closed: strict mode without a token is a misconfigured child, and
  // serving it wide open is the exact failure strict mode exists to prevent.
  if (strict && !configured) return { ok: false, error: "server misconfigured: strict auth without a token" };
  if (!configured) return { ok: true };
  if (isPublicPath(req.method ?? "GET", parts)) return { ok: true };
  // The dashboard's sign-in. Never in strict mode: a child is reached only by its host, which holds
  // no browser session and strips the cookie before it forwards.
  if (!strict && sessionPresented(req, ctx)) return { ok: true };
  const token = extractToken(req);
  if (!token) return { ok: false, error: "missing credentials: provide Authorization: Bearer <token>, or sign in on the dashboard" };
  const key = ctx.limiter ? clientKey(req) : "";
  if (ctx.limiter) {
    const wait = ctx.limiter.blockedFor(key);
    if (wait > 0) return { ok: false, status: 429, retryAfterSec: wait, error: "too many wrong tokens from this address; try again shortly" };
  }
  // Operator token (exact match). Agent tokens are accepted on /internal/mcp only, where the MCP
  // handler does its own verification; they are rejected everywhere else.
  if (tokenMatches(token, configured)) {
    ctx.limiter?.reset(key);
    return { ok: true };
  }
  ctx.limiter?.fail(key);
  return { ok: false, error: "invalid token" };
}

export interface AuthRouteDeps extends Required<AuthContext> {
  /** The request's JSON body, already bounded by the caller. */
  readBody: () => Promise<Record<string, unknown>>;
  send: (code: number, body: unknown) => void;
}

/**
 * `/auth/status`, `/auth/login`, `/auth/logout`: how a browser trades the
 * operator token for a session cookie. Returns whether it answered.
 *
 * Not offered in strict mode (a child has no browser to sign in) and a no-op
 * when no token is configured, where "signing in" has nothing to check.
 */
export async function handleAuthRoute(req: http.IncomingMessage, res: http.ServerResponse, parts: string[], deps: AuthRouteDeps): Promise<boolean> {
  if (parts[0] !== "auth" || parts.length !== 2 || isStrictAuth()) return false;
  const name = parts[1];
  const configured = getApiToken();

  if (name === "status" && req.method === "GET") {
    const required = configured !== "";
    // Whether this caller would be let in, without counting a wrong token against anyone.
    const presented = extractToken(req);
    const authenticated = !required || sessionPresented(req, deps) || (presented !== "" && tokenMatches(presented, configured));
    deps.send(200, { required, authenticated });
    return true;
  }

  if (name === "login" && req.method === "POST") {
    if (!configured) {
      deps.send(200, { ok: true, required: false });
      return true;
    }
    const key = clientKey(req);
    const wait = deps.limiter.blockedFor(key);
    if (wait > 0) {
      res.setHeader("retry-after", String(wait));
      deps.send(429, { error: "too many wrong tokens from this address; try again shortly", retryAfterSec: wait });
      return true;
    }
    const body = await deps.readBody();
    const supplied = typeof body.token === "string" ? body.token.trim() : "";
    if (supplied && tokenMatches(supplied, configured)) {
      deps.limiter.reset(key);
      const session = deps.sessions.create();
      res.setHeader("set-cookie", sessionCookie(session.id, session.maxAgeSec, cookieSecure(req)));
      deps.send(200, { ok: true, required: true });
      return true;
    }
    // An empty submit is not a guess; a wrong token is.
    if (supplied) deps.limiter.fail(key);
    deps.send(401, { error: "that token was not accepted" });
    return true;
  }

  if (name === "logout" && req.method === "POST") {
    deps.sessions.revoke(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    res.setHeader("set-cookie", clearedSessionCookie(cookieSecure(req)));
    deps.send(200, { ok: true });
    return true;
  }
  return false;
}

/**
 * Validate a caller-supplied actor identity (`by` / `from` fields).
 * Operator (Bearer) callers may act as `human`; agent callers must name a
 * known agent. Unknown ids are rejected to prevent spoofing.
 */
export function resolveActor(
  requested: unknown,
  knownAgents: Set<string>,
  fallback = "human",
): { ok: boolean; actor?: string; error?: string } {
  const raw = typeof requested === "string" && requested.trim() ? requested.trim() : fallback;
  if (raw === "human") return { ok: true, actor: raw };
  if (knownAgents.has(raw)) return { ok: true, actor: raw };
  return { ok: false, error: `unknown actor '${raw}'` };
}
