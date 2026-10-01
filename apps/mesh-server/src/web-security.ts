/**
 * What stands between this server and a network, or a browser.
 *
 * Three concerns, kept together because each is half of the same promise
 * ("only the operator can drive a mission") and each fails open if its sibling
 * is forgotten:
 *
 *   1. LISTEN POLICY. A server reachable from the network must hold a real
 *      token. `requireAuth` treats an empty token as "no auth" (right for a
 *      loopback dev server), so the one thing that has to be refused is the
 *      combination: a non-loopback bind with a missing, blank or short token.
 *      That is how an empty Kubernetes Secret turns into a public shell.
 *   2. REQUEST GUARD. A browser on the operator's machine can be made to send
 *      requests to a loopback server by any page it visits: a cross-origin
 *      `text/plain` POST needs no preflight, and DNS rebinding makes the
 *      attacker's hostname "same-origin". `Host` and `Origin` are the two
 *      headers a page cannot forge, so they are what is checked.
 *   3. RESPONSE HEADERS AND LIMITS. Nothing here is a firewall; it removes the
 *      defaults that made the other two worse (`Access-Control-Allow-Origin:
 *      *`, no framing policy, unbounded request bodies).
 *
 * The functions are pure over a request or an environment so they can be
 * tested without a socket; `index.ts` and `host.ts` call them from their
 * request handlers and start-up paths.
 */
import type * as http from "http";
import * as net from "net";

/** The shortest operator token a server reachable from the network accepts: 32 hex characters is 128 bits. */
export const MIN_NETWORK_TOKEN_LENGTH = 32;

/** Thrown at start-up, before the port is opened, when the configuration would expose an unauthenticated server. */
export class UnsafeListenError extends Error {
  readonly code = "unsafe_listen";
  constructor(message: string) {
    super(message);
    this.name = "UnsafeListenError";
  }
}

/**
 * Whether binding `host` keeps the server on this machine.
 *
 * Everything else is the network, including the wildcard addresses and an
 * unset host (node reads that as "all interfaces", not as "localhost"). An
 * unparseable value is not loopback: the check fails toward demanding a token.
 */
export function isLoopbackHost(host: string | undefined | null): boolean {
  if (host === undefined || host === null) return false;
  const h = host.trim().toLowerCase();
  if (h === "") return false;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  const bare = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
  const candidate = dotted ? dotted[1]! : bare;
  if (net.isIPv4(candidate)) return candidate.startsWith("127.");
  if (!net.isIPv6(candidate)) return false;
  // The URL parser canonicalises every spelling of an IPv6 address (`0:0::1`,
  // `0000:...:0001`) to one form, which is cheaper than expanding it by hand.
  let canonical: string;
  try {
    canonical = new URL(`http://[${candidate}]/`).hostname;
  } catch {
    return false;
  }
  if (canonical === "[::1]") return true;
  const mapped = /^\[::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}\]$/.exec(canonical);
  return mapped !== null && parseInt(mapped[1]!, 16) >> 8 === 127;
}

/**
 * The host this process should use to reach its OWN server. A wildcard bind
 * ("0.0.0.0", "::") is an address to listen on, not one to connect to: it only
 * works as a destination on Linux, and the seats' MCP bridge and the CLI's own
 * status polling both build their URL from it.
 */
export function selfConnectHost(host: string | undefined | null): string {
  const h = (host ?? "").trim();
  if (h === "" || h === "0.0.0.0") return "127.0.0.1";
  if (h === "::" || h === "[::]") return "[::1]";
  return net.isIPv6(h) ? `[${h}]` : h;
}

export interface ListenCheck {
  /** Things the operator should read at start-up; empty when nothing needs saying. */
  warnings: string[];
}

/**
 * Refuse to open a network port the server could not defend.
 *
 * Loopback binds pass whatever the token is: a blank token there is the
 * documented "no auth" mode of a local dev server. Anything else needs a token
 * of at least `MIN_NETWORK_TOKEN_LENGTH` characters, and a token that is SET BUT
 * BLANK gets its own sentence, because it is the usual mistake (a Secret with an
 * empty value, `${MESH_API_TOKEN:-}`) and reads as "I configured one".
 *
 * `MESH_ALLOW_INSECURE_BIND=1` is the one deliberate door: it is for a server
 * whose only route in is a proxy that authenticates every request itself. It
 * starts the server and says so on stderr, rather than pretending the
 * configuration is safe.
 */
export function assertSafeListen(host: string | undefined, env: NodeJS.ProcessEnv = process.env): ListenCheck {
  if (isLoopbackHost(host)) return { warnings: [] };
  const where = host && host.trim() ? host.trim() : "all interfaces";
  const raw = env.MESH_API_TOKEN;
  const token = (raw ?? "").trim();
  const problem =
    raw === undefined
      ? "MESH_API_TOKEN is not set"
      : token === ""
        ? "MESH_API_TOKEN is set but empty (an empty Secret value, or a variable that expanded to nothing)"
        : token.length < MIN_NETWORK_TOKEN_LENGTH
          ? `MESH_API_TOKEN is ${token.length} characters, and a server reachable from the network needs at least ${MIN_NETWORK_TOKEN_LENGTH}`
          : undefined;
  if (problem === undefined) return { warnings: [] };
  if ((env.MESH_ALLOW_INSECURE_BIND ?? "").trim() === "1") {
    return {
      warnings: [
        `MESH_ALLOW_INSECURE_BIND=1: listening on ${where} although ${problem}. Anyone who can reach this port can send messages, start missions and run the agents' shell commands, unless something in front of it authenticates every request.`,
      ],
    };
  }
  throw new UnsafeListenError(
    `refusing to listen on ${where}: ${problem}. A server reachable from the network lets whoever connects send messages and start missions, and agents run shell commands. ` +
      `Set MESH_API_TOKEN to a random value of at least ${MIN_NETWORK_TOKEN_LENGTH} characters (openssl rand -hex 32), or bind to 127.0.0.1. ` +
      `If a proxy that authenticates every request is the only way in, MESH_ALLOW_INSECURE_BIND=1 acknowledges that and starts anyway.`,
  );
}

// ------------------------------------------------------------ request guard

export type GuardVerdict = { ok: true } | { ok: false; status: number; code: string; error: string };

export interface WebPolicy {
  /** Extra `Host` values accepted (`mesh.example.com`, or with a port). Empty = the default rule. */
  allowedHosts: string[];
  /** Origins permitted to make state-changing requests besides the page's own (`https://mesh.example.com`). */
  allowedOrigins: string[];
}

function listOf(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/\/+$/, ""))
    .filter((s) => s.length > 0);
}

/** `MESH_ALLOWED_HOSTS` and `MESH_ALLOWED_ORIGINS`, comma separated. Read per request so a test can set them around a server. */
export function webPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): WebPolicy {
  return { allowedHosts: listOf(env.MESH_ALLOWED_HOSTS), allowedOrigins: listOf(env.MESH_ALLOWED_ORIGINS) };
}

/** The name in a `Host` header, without its port: `localhost:7420` -> `localhost`, `[::1]:7420` -> `::1`. */
export function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end > 0 ? h.slice(1, end) : h;
  }
  const colon = h.lastIndexOf(":");
  return colon > 0 && h.indexOf(":") === colon ? h.slice(0, colon) : h;
}

/**
 * DNS-rebinding defence: refuse a request whose `Host` is not one this server
 * is meant to be reached by.
 *
 * Keyed on the address the CONNECTION arrived at rather than on the configured
 * bind, so it holds for a server created without `listen` options and for a
 * wildcard bind alike:
 *
 *   - arrived on a loopback address -> only loopback names (`localhost`,
 *     `127.x`, `::1`) and anything in `MESH_ALLOWED_HOSTS`. A page on
 *     `evil.example` that rebinds to 127.0.0.1 still sends `Host:
 *     evil.example`, which is how it is caught.
 *   - arrived on a network interface -> any `Host`, unless `MESH_ALLOWED_HOSTS`
 *     narrows it. The token is the protection there (a listen policy above
 *     insists on one), and the names a deployment is reached by are not
 *     knowable here.
 *
 * Probes are exempt at the call site: a kubelet addresses the pod by IP.
 */
export function checkHost(req: http.IncomingMessage, policy: WebPolicy): GuardVerdict {
  const header = req.headers.host;
  // An HTTP/1.0 client with no Host is not a browser; a browser always sends one.
  if (!header) return { ok: true };
  const name = hostnameOf(header);
  if (policy.allowedHosts.length > 0) {
    const full = header.trim().toLowerCase();
    if (policy.allowedHosts.includes(name) || policy.allowedHosts.includes(full)) return { ok: true };
    // The default loopback names stay valid beside an explicit list: an operator
    // who adds their ingress host must not lose `kubectl port-forward`.
    if (isLoopbackHost(name) && isLoopbackHost(req.socket.localAddress ?? "127.0.0.1")) return { ok: true };
    return hostRefused(header);
  }
  const arrivedOn = req.socket.localAddress ?? "127.0.0.1";
  if (!isLoopbackHost(arrivedOn)) return { ok: true };
  if (isLoopbackHost(name)) return { ok: true };
  return hostRefused(header);
}

function hostRefused(header: string): GuardVerdict {
  return {
    ok: false,
    status: 421,
    code: "host_not_allowed",
    error: `host '${header}' is not one this server answers to. If you reach it by that name on purpose, add it to MESH_ALLOWED_HOSTS.`,
  };
}

/**
 * Cross-site request forgery defence for anything that changes state.
 *
 * A browser attaches `Origin` to every cross-origin POST (including the
 * "simple" `text/plain` ones that skip the preflight) and `Sec-Fetch-Site` to
 * everything. A request carrying neither is not from a browser page (the CLI,
 * the MCP bridge, curl) and passes: the credential, not the origin, is what
 * protects those. A request from a page must be same-origin, or from an origin
 * the operator listed in `MESH_ALLOWED_ORIGINS`.
 *
 * This matters even with a token set: a proxy or a cookie that authenticates
 * the browser for the operator also authenticates a forged request, because
 * the browser attaches both on its own.
 */
export function checkOrigin(req: http.IncomingMessage, policy: WebPolicy): GuardVerdict {
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return { ok: true };
  const origin = headerString(req.headers.origin);
  const site = headerString(req.headers["sec-fetch-site"]);
  if (origin === undefined) {
    if (site === undefined || site === "none" || site === "same-origin") return { ok: true };
    return originRefused(`a ${site} request`);
  }
  const normalised = origin.trim().toLowerCase().replace(/\/+$/, "");
  if (policy.allowedOrigins.includes(normalised)) return { ok: true };
  let originHost: string;
  try {
    originHost = new URL(normalised).host;
  } catch {
    return originRefused(`origin '${origin}'`);
  }
  // Compared on host:port and not on scheme: behind a TLS-terminating proxy the
  // page's origin is https while the request this server sees is plain http.
  if (originHost !== "" && originHost === (headerString(req.headers.host) ?? "").trim().toLowerCase()) return { ok: true };
  return originRefused(`origin '${origin}'`);
}

function originRefused(what: string): GuardVerdict {
  return {
    ok: false,
    status: 403,
    code: "cross_origin",
    error: `refusing a state-changing request from ${what}: it did not come from this server's own page. If that origin is yours, add it to MESH_ALLOWED_ORIGINS.`,
  };
}

function headerString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Both checks in the order a request meets them. `/healthz` and `/readyz` skip this: probes address a pod by IP. */
export function guardRequest(req: http.IncomingMessage, policy: WebPolicy = webPolicyFromEnv()): GuardVerdict {
  const host = checkHost(req, policy);
  if (!host.ok) return host;
  return checkOrigin(req, policy);
}

// -------------------------------------------------------- response headers

export type ResponseKind = "api" | "dashboard" | "preview";

/**
 * The dashboard's own policy. It is a same-origin SPA that talks to this server
 * only, so nothing is allowed from anywhere else. `'unsafe-inline'` is for
 * styles alone (React's `style` attributes); scripts are same-origin files.
 * `frame-src 'self'` is the Product tab's playground iframe.
 */
export const DASHBOARD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * What an agent-written page is served under. `sandbox` without
 * `allow-same-origin` gives it an opaque origin, so a script in it cannot call
 * this server's API with the operator's credentials or read what it answers;
 * `allow-scripts` keeps the simulator it is there to show working. It may be
 * framed by this server's own dashboard and by nothing else.
 */
export const PREVIEW_CSP = "sandbox allow-scripts allow-forms allow-popups allow-modals; frame-ancestors 'self'";

/**
 * Set the headers every response carries. They go on with `setHeader`, so a
 * route's own `writeHead` still wins on any name it sets (an SSE stream
 * replaces `cache-control`).
 */
export function applySecurityHeaders(res: http.ServerResponse, kind: ResponseKind): void {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  if (kind === "preview") {
    res.setHeader("content-security-policy", PREVIEW_CSP);
    res.setHeader("x-frame-options", "SAMEORIGIN");
    return;
  }
  res.setHeader("x-frame-options", "DENY");
  if (kind === "dashboard") res.setHeader("content-security-policy", DASHBOARD_CSP);
  else res.setHeader("cache-control", "no-store");
}

// ------------------------------------------------------------ request body

/** Default cap on a JSON request body. The largest legitimate one is a `mesh.yaml` or a designer transcript. */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export class PayloadTooLargeError extends Error {
  readonly status = 413;
  constructor(readonly limit: number) {
    super(`request body is larger than ${limit} bytes`);
    this.name = "PayloadTooLargeError";
  }
}

/** `MESH_MAX_BODY_BYTES`, or the default; a value that is not a positive integer is ignored. */
export function maxBodyBytes(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number((env.MESH_MAX_BODY_BYTES ?? "").trim());
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_BODY_BYTES;
}

/**
 * Read a request body, refusing more than `limit` bytes.
 *
 * `Content-Length` is checked before a byte is read, and the running total
 * after each chunk, so a client that lies about its length or never declares
 * one (chunked) is stopped at the limit too. On refusal the request is paused,
 * not drained and not destroyed: the caller's 413 carries `connection: close`
 * (`respondTooLarge`), which ends the upload once the reply is out. Draining
 * would let a client that never stops writing hold the socket; destroying would
 * reset the connection before the client could read why.
 */
export function readBody(req: http.IncomingMessage, limit: number = maxBodyBytes()): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const declared = Number(headerString(req.headers["content-length"]));
    if (Number.isFinite(declared) && declared > limit) {
      req.pause();
      reject(new PayloadTooLargeError(limit));
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const done = (): void => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("close", onClose);
    };
    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total > limit) {
        done();
        req.pause();
        reject(new PayloadTooLargeError(limit));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      done();
      resolve(Buffer.concat(chunks));
    };
    const onError = (err: Error): void => {
      done();
      reject(err);
    };
    // A client that hangs up mid-body never emits `end`.
    const onClose = (): void => {
      if (req.complete) return;
      done();
      reject(new Error("request closed before its body was complete"));
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("close", onClose);
  });
}

/** Send the 413 for a `PayloadTooLargeError` and close the connection behind it. */
export function respondTooLarge(res: http.ServerResponse, err: PayloadTooLargeError): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(413, { "content-type": "application/json", connection: "close" });
  res.end(JSON.stringify({ error: err.message, code: "payload_too_large", limit: err.limit }));
}

// ------------------------------------------------- failed-credential limiter

/**
 * The address a failed attempt is counted against: the peer, or with
 * `MESH_TRUST_PROXY=1` the last hop in `X-Forwarded-For`, which is the one the
 * trusted proxy itself appended. (The earlier hops are whatever the client
 * chose to send.) Behind an ingress with no trust set every client shares the
 * ingress's address, which is why the limiter below counts only wrong tokens,
 * never missing credentials or stale cookies.
 */
export function clientKey(req: http.IncomingMessage, env: NodeJS.ProcessEnv = process.env): string {
  if ((env.MESH_TRUST_PROXY ?? "").trim() === "1") {
    const last = headerString(req.headers["x-forwarded-for"])
      ?.split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .pop();
    if (last) return last;
  }
  return req.socket?.remoteAddress ?? "unknown";
}

/**
 * Slows token guessing. A wrong operator token counts against the caller's
 * address; past `max` in `windowMs` the caller is told to wait, and its next
 * attempts are not evaluated at all until the window drains.
 *
 * Only a token someone TYPED OR SENT and got wrong counts. A request with no
 * credential, or a stale session cookie, is an expired page polling, not a
 * guess: counting those would let a dashboard left open overnight lock its
 * owner out. A 128-bit token cannot be guessed at any rate; this is for the
 * short ones a loopback server allows, and for the log noise of a scanner.
 */
export class FailureLimiter {
  private readonly failures = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(opts: { max?: number; windowMs?: number; maxKeys?: number; now?: () => number } = {}) {
    this.max = opts.max ?? 30;
    this.windowMs = opts.windowMs ?? 60_000;
    this.maxKeys = opts.maxKeys ?? 10_000;
    this.now = opts.now ?? Date.now;
  }

  /** Seconds this caller must wait before its next attempt is looked at; 0 means go ahead. */
  blockedFor(key: string): number {
    const live = this.live(key);
    if (live.length < this.max) return 0;
    return Math.max(1, Math.ceil((live[0]! + this.windowMs - this.now()) / 1000));
  }

  fail(key: string): void {
    const live = this.live(key);
    live.push(this.now());
    this.failures.set(key, live);
    while (this.failures.size > this.maxKeys) {
      const oldest = this.failures.keys().next().value;
      if (oldest === undefined) break;
      this.failures.delete(oldest);
    }
  }

  reset(key: string): void {
    this.failures.delete(key);
  }

  private live(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const kept = (this.failures.get(key) ?? []).filter((t) => t > cutoff);
    if (kept.length === 0) this.failures.delete(key);
    return kept;
  }
}
