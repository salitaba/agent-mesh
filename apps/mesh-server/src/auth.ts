import type * as http from "http";

export function getApiToken(): string {
  return (process.env.MESH_API_TOKEN ?? "").trim();
}

function pathOf(parts: string[]): string {
  return `/${parts.join("/")}`;
}

/** Paths that stay public even when MESH_API_TOKEN is set. */
export function isPublicPath(method: string, parts: string[]): boolean {
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

export function requireAuth(req: http.IncomingMessage, url: URL, parts: string[]): { ok: boolean; error?: string } {
  const configured = getApiToken();
  if (!configured) return { ok: true };
  if (isPublicPath(req.method ?? "GET", parts)) return { ok: true };
  const token = extractToken(req, url);
  if (!token) return { ok: false, error: "missing credentials: provide Authorization: Bearer <token>" };
  // Operator token (exact match) OR agent MCP-style token (meshId:agentId:hash) accepted
  // on /internal/mcp only — the MCP handler does its own verification. Here we
  // accept the operator token; agent tokens are rejected outside MCP.
  if (token === configured) return { ok: true };
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
