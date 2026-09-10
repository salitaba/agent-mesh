import type * as http from "http";
import { createHash, timingSafeEqual } from "crypto";

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

/** Paths that stay public even when MESH_API_TOKEN is set. */
export function isPublicPath(method: string, parts: string[]): boolean {
  if (isStrictAuth()) return false;
  if (method === "GET" && parts.length === 1 && parts[0] === "health") return true;
  if (method === "GET" && (parts.length === 0 || parts[0] === "dashboard")) return true;
  // Dashboard static assets served via the catch-all GET route.
  if (method === "GET" && parts.length >= 1 && parts[0] === "assets") return true;
  void pathOf;
  return false;
}

export function extractToken(req: http.IncomingMessage, url: URL): string {
  const auth = req.headers.authorization ?? req.headers.Authorization;
  const header = Array.isArray(auth) ? auth[0] : (auth as string | undefined);
  if (header && header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  const meshToken = req.headers["x-mesh-token"];
  if (typeof meshToken === "string" && meshToken) return meshToken;
  if (Array.isArray(meshToken) && meshToken[0]) return meshToken[0];
  return (url.searchParams.get("token") ?? "").trim();
}

/** Constant-time compare so a token cannot be recovered byte by byte. */
function tokenMatches(supplied: string, configured: string): boolean {
  const a = Buffer.from(supplied, "utf8");
  const b = Buffer.from(configured, "utf8");
  // timingSafeEqual throws on length mismatch, which would itself leak length;
  // hashing both sides to a fixed width keeps the comparison uniform.
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function requireAuth(req: http.IncomingMessage, url: URL, parts: string[]): { ok: boolean; error?: string } {
  const configured = getApiToken();
  const strict = isStrictAuth();
  // Fail closed: strict mode without a token is a misconfigured child, and
  // serving it wide open is the exact failure strict mode exists to prevent.
  if (strict && !configured) return { ok: false, error: "server misconfigured: strict auth without a token" };
  if (!configured) return { ok: true };
  if (isPublicPath(req.method ?? "GET", parts)) return { ok: true };
  const token = extractToken(req, url);
  if (!token) return { ok: false, error: "missing credentials: provide Authorization: Bearer <token>" };
  // Operator token (exact match) OR agent MCP-style token (meshId:agentId:hash) accepted
  // on /internal/mcp only — the MCP handler does its own verification. Here we
  // accept the operator token; agent tokens are rejected outside MCP.
  if (tokenMatches(token, configured)) return { ok: true };
  return { ok: false, error: "invalid token" };
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
