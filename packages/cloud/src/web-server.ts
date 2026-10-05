/**
 * The public listener: one port, and the Host header says which of two things a request is for.
 *
 * `app.<domain>` is the control plane's own pages and API (`ControlWeb`), and `<slug>.<workspace domain>` is a customer's
 * workspace behind the edge (`WorkspaceEdge`). Anything else gets a plain 404, so a request for an address the service was not
 * told to serve is not answered as if it were. TLS is terminated in front of this, which is also what supplies the caller's
 * address: `trustProxyHops` says how many proxies in front of the service add to `X-Forwarded-For`, and with none it is not read.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import type { WorkspaceEdge } from "./edge";
import type { OwnerWeb } from "./owner";
import { securityHeaders, type ControlWeb, type WebRequest, type WebResponse } from "./web";

export interface PublicServerOptions {
  web: ControlWeb;
  edge: WorkspaceEdge;
  /** The host the app is served at, without a port: `app.example.com`. */
  appHost: string;
  /** The suffix workspaces are served under, without a port: `ws.example.com`. */
  workspaceDomain: string;
  /** Where the account pages are (HTML, with their scripts and styles under `assets/`). Without it only the API is served. */
  pagesDir?: string;
  /** How many proxies in front of the service add to `X-Forwarded-For`. Default 0: the address of the connection is used. */
  trustProxyHops?: number;
  /** The largest request body the API reads, in bytes. Default 64 KiB. */
  maxBodyBytes?: number;
  /** The largest body of a payment provider's message. Default 1 MiB. */
  maxWebhookBytes?: number;
}

/** The pages that exist, by the path they are served at. A path that is not here is never read from disk. */
const PAGES: Record<string, string> = {
  "/": "index.html",
  "/signup": "signup.html",
  "/login": "login.html",
  "/verify": "verify.html",
  "/forgot": "forgot.html",
  "/reset": "reset.html",
  "/account": "account.html",
  "/terms": "terms.html",
  "/privacy": "privacy.html",
};

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
};

const PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** The host of a request, lower-case and without its port. */
export function hostOf(req: http.IncomingMessage): string {
  return String(req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
}

/** The caller's address: the connection's, or what the proxies in front say it was. */
export function clientIp(req: http.IncomingMessage, hops: number): string {
  const direct = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  if (hops <= 0) return direct;
  const raw = req.headers["x-forwarded-for"];
  const parts = (Array.isArray(raw) ? raw.join(",") : (raw ?? "")).split(",").map((p) => p.trim()).filter((p) => p !== "");
  return (parts[parts.length - hops] ?? direct).replace(/^::ffff:/, "");
}

function readBody(req: http.IncomingMessage, max: number): Promise<Buffer | "too_large"> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (v: Buffer | "too_large"): void => {
      if (done) return;
      done = true;
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      resolve(v);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > max) return finish("too_large");
      chunks.push(chunk);
    };
    const onEnd = (): void => finish(Buffer.concat(chunks));
    const onError = (err: Error): void => {
      if (done) return;
      done = true;
      reject(err);
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

function write(res: http.ServerResponse, r: WebResponse): void {
  if (res.headersSent || res.writableEnded) return;
  const body = typeof r.body === "string" ? Buffer.from(r.body, "utf8") : r.body;
  res.writeHead(r.status, { ...r.headers, "content-length": String(body.length) });
  res.end(body);
}

/** The body of a request, or undefined once a 413 has been written because it is larger than `max`. A caller that says so up front is not waited for. */
async function bodyOf(req: http.IncomingMessage, res: http.ServerResponse, max: number, secure: boolean): Promise<Buffer | undefined> {
  const tooLarge = (): undefined => {
    write(res, { status: 413, headers: { "content-type": "application/json; charset=utf-8", ...securityHeaders(secure), connection: "close" }, body: JSON.stringify({ error: { code: "request_too_large", message: "That request is too large." } }) });
    return undefined;
  };
  if (Number(req.headers["content-length"]) > max) return tooLarge();
  const body = await readBody(req, max);
  return body === "too_large" ? tooLarge() : body;
}

/** A caller that is slow to send its request is given up on; an idle connection is kept a little longer than a proxy in front keeps its own. */
function limitTimeouts(server: http.Server): http.Server {
  server.headersTimeout = 30_000;
  server.requestTimeout = 120_000;
  server.keepAliveTimeout = 65_000;
  return server;
}

export interface OwnerServerOptions {
  owner: OwnerWeb;
  /** The largest request body, in bytes. Default 64 KiB. */
  maxBodyBytes?: number;
}

/**
 * The operator's listener. It is not behind the proxy that customers come through, so the caller's address is the connection's
 * and no header is believed about it.
 */
export function createOwnerServer(o: OwnerServerOptions): http.Server {
  const max = o.maxBodyBytes ?? 64 * 1024;
  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://owner.invalid");
    } catch {
      return write(res, { status: 400, headers: { "content-type": "application/json; charset=utf-8", ...securityHeaders(true) }, body: JSON.stringify({ error: { code: "bad_request", message: "That request could not be read." } }) });
    }
    const body = await bodyOf(req, res, max, true);
    if (body === undefined) return;
    write(res, await o.owner.handle({ method: req.method ?? "GET", path: url.pathname, query: url.searchParams, headers: req.headers, body, ip: clientIp(req, 0) }));
  }
  return limitTimeouts(
    http.createServer((req, res) => {
      handle(req, res).catch(() => {
        if (res.headersSent) res.destroy();
        else write(res, { status: 500, headers: { "content-type": "application/json; charset=utf-8", ...securityHeaders(true) }, body: JSON.stringify({ error: { code: "internal_error", message: "The request failed." } }) });
      });
    }),
  );
}

export function createPublicServer(o: PublicServerOptions): http.Server {
  const hops = o.trustProxyHops ?? 0;
  const maxBody = o.maxBodyBytes ?? 64 * 1024;
  const maxWebhook = o.maxWebhookBytes ?? 1024 * 1024;
  const secure = o.web.secureCookies;
  const plain = (res: http.ServerResponse, status: number, text: string, extra: Record<string, string> = {}): void =>
    write(res, { status, headers: { "content-type": "text/plain; charset=utf-8", ...securityHeaders(secure), ...extra }, body: text });

  /** Serve a page or an asset when this request is for one. A path is looked up in a list or matched against a name with no slash in it; it is never joined onto the directory as the caller wrote it. */
  function servePage(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): boolean {
    if (!o.pagesDir || (req.method !== "GET" && req.method !== "HEAD")) return false;
    // A page may be asked for with a trailing slash; an asset is exactly its name.
    let file = PAGES[pathname.replace(/\/+$/, "") || "/"];
    if (!file) {
      const m = /^\/assets\/([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(pathname);
      if (!m) return false;
      file = path.join("assets", m[1]!);
    }
    let body: Buffer;
    try {
      body = fs.readFileSync(path.join(o.pagesDir, file));
    } catch {
      return false;
    }
    const isPage = path.extname(file) === ".html";
    res.writeHead(200, {
      "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
      "content-length": String(body.length),
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cache-control": isPage ? "no-store" : "public, max-age=300",
      ...(isPage ? { "content-security-policy": PAGE_CSP, "cross-origin-opener-policy": "same-origin", "x-frame-options": "DENY" } : {}),
      ...(secure ? { "strict-transport-security": "max-age=31536000; includeSubDomains" } : {}),
    });
    res.end(req.method === "HEAD" ? undefined : body);
    return true;
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const host = hostOf(req);
    const ip = clientIp(req, hops);
    if (host !== o.appHost && host.endsWith(`.${o.workspaceDomain}`)) return o.edge.handle(req, res, ip);
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://app.invalid");
    } catch {
      return plain(res, 400, "That request could not be read.");
    }
    // A load balancer asks for health by address, not by name.
    if (host !== o.appHost && url.pathname !== "/healthz") return plain(res, 404, "No such site.");
    if (servePage(req, res, url.pathname)) return;

    const body = await bodyOf(req, res, url.pathname === "/webhooks/billing" ? maxWebhook : maxBody, secure);
    if (body === undefined) return;
    const request: WebRequest = { method: req.method ?? "GET", path: url.pathname, query: url.searchParams, headers: req.headers, body, ip };
    write(res, await o.web.handle(request));
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (res.headersSent) res.destroy();
      else plain(res, 500, "Something went wrong on our side.");
    });
  });
  return limitTimeouts(server);
}
