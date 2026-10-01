/**
 * Dashboard sign-in: a server-side session behind an HttpOnly cookie.
 *
 * The operator token is the one credential, and it is meant for the CLI, a
 * script or a proxy that can put it in a header. A browser cannot: a page's
 * `EventSource` cannot set one, an iframe cannot, and keeping the token in
 * script-readable storage hands it to any script that ever runs on the origin.
 * So the dashboard trades the token once, at `POST /auth/login`, for a random
 * session id the server remembers, delivered in a cookie JavaScript cannot read.
 * The event stream and every `fetch` then carry it on their own.
 *
 * A cookie is ambient authority, which is what makes cross-site requests
 * dangerous, so it is never accepted alone for a state change from a foreign
 * page: `SameSite=Strict` keeps it off cross-site requests, and the `Origin`
 * check in `web-security.ts` refuses the same-site-but-different-origin ones
 * (another app on another localhost port).
 *
 * Sessions live in memory. A restart signs everyone out, which is the right
 * failure for a credential store, and the one-writer-per-instance deployment
 * model means there is no second process that would need to share them.
 */
import { createHash, randomBytes } from "crypto";
import type * as http from "http";

export const SESSION_COOKIE = "mesh_session";

/** Twelve hours: a working day, not a standing credential. */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** More sessions than a team has browsers; past this the oldest is dropped rather than the store growing. */
const MAX_SESSIONS = 256;

function digest(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

export class SessionStore {
  /** sha256(id) -> expiry. The id itself is never kept, so a memory dump holds nothing a browser could present. */
  private readonly live = new Map<string, number>();

  constructor(
    private readonly ttlMs: number = SESSION_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Mint a session. The id is 256 bits from the OS and is returned exactly once. */
  create(): { id: string; maxAgeSec: number } {
    this.sweep();
    while (this.live.size >= MAX_SESSIONS) {
      const oldest = this.live.keys().next().value;
      if (oldest === undefined) break;
      this.live.delete(oldest);
    }
    const id = randomBytes(32).toString("base64url");
    this.live.set(digest(id), this.now() + this.ttlMs);
    return { id, maxAgeSec: Math.floor(this.ttlMs / 1000) };
  }

  /** Whether `id` names a live session. A lookup by hash: nothing is compared against a secret byte by byte. */
  valid(id: string | undefined): boolean {
    if (!id) return false;
    const key = digest(id);
    const expires = this.live.get(key);
    if (expires === undefined) return false;
    if (expires <= this.now()) {
      this.live.delete(key);
      return false;
    }
    return true;
  }

  revoke(id: string | undefined): void {
    if (id) this.live.delete(digest(id));
  }

  get size(): number {
    this.sweep();
    return this.live.size;
  }

  private sweep(): void {
    const t = this.now();
    for (const [key, expires] of this.live) if (expires <= t) this.live.delete(key);
  }
}

/** The cookies of a request, by name. Malformed pairs are skipped rather than thrown on. */
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

/**
 * Whether the cookie should carry `Secure`.
 *
 * Behind an HTTPS ingress the page is on https and the cookie must not travel
 * over anything else. This server speaks plain HTTP to the ingress, so it
 * cannot see that for itself: `MESH_COOKIE_SECURE=1` states it, and
 * `MESH_TRUST_PROXY=1` lets `X-Forwarded-Proto` say it per request. On
 * `http://localhost` neither is set, because a browser would refuse to store a
 * Secure cookie from a plain-HTTP origin and sign-in would silently not stick.
 */
export function cookieSecure(req: http.IncomingMessage, env: NodeJS.ProcessEnv = process.env): boolean {
  if ((env.MESH_COOKIE_SECURE ?? "").trim() === "1") return true;
  if ((env.MESH_TRUST_PROXY ?? "").trim() !== "1") return false;
  const proto = req.headers["x-forwarded-proto"];
  const first = (Array.isArray(proto) ? proto[0] : proto)?.split(",")[0]?.trim().toLowerCase();
  return first === "https";
}

export function sessionCookie(id: string, maxAgeSec: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure ? "; Secure" : ""}`;
}

export function clearedSessionCookie(secure: boolean): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? "; Secure" : ""}`;
}
