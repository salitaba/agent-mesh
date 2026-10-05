/**
 * The edge: what stands between a browser and a customer's workspace.
 *
 * A workspace has no public address of its own. It is served at `<slug>.<workspace domain>` through this proxy, which does four
 * things before a byte reaches the host:
 *
 *   1. It decides who the request is from. A workspace's address gets a cookie of its own, signed by the service and tied to the
 *      account session that opened it, and each request asks the control log whether that session and that workspace are still
 *      the account's. Signing out, a new password and a stopped account end access at once.
 *   2. It decides whether the workspace can answer: a stopped or failed one gets a page that says so, not a connection error.
 *   3. It swaps credentials. The workspace's host takes one credential, its operator token, which the browser never sees: the
 *      proxy presents it, and removes every cookie and authorisation header the browser sent, so nothing a page or a script
 *      holds can be used against the host, and nothing the host sets is kept by the browser.
 *   4. It streams. The dashboard's event stream passes through as it is produced, and a browser that goes away takes the
 *      upstream request with it. A response that is still open is looked at again every few seconds, so that signing out, a
 *      stopped account or a stopped workspace ends a stream that began before it, and not only the requests after it.
 *
 * The host does its own checks as well (its allowed hosts and origins are set to this workspace's address when it is made).
 * Requests that change something must name this workspace's own address as their origin here too.
 */
import * as http from "node:http";
import { parseCookies } from "./web";
import type { ControlPlane } from "./control-plane";
import type { WorkspaceAccess } from "./workspace-access";
import type { Workspace } from "./store";

export interface EdgeLog {
  level: "info" | "warn" | "error";
  msg: string;
  [field: string]: unknown;
}

export interface EdgeOptions {
  plane: ControlPlane;
  access: WorkspaceAccess;
  /** The address of the app, which a page that cannot open a workspace sends the person to. */
  appUrl: string;
  /** `https` (the default) or `http`, for trying it on one machine. */
  workspaceScheme?: "https" | "http";
  /** How long to wait for a host to start answering a request, in ms. Default 30 seconds. */
  upstreamTimeoutMs?: number;
  /** The largest request body passed on, in bytes. Default 64 MiB. */
  maxUploadBytes?: number;
  /** How often a response that is still open is checked to see that its access has not ended, in ms. Default 15 seconds. */
  recheckMs?: number;
  log?: (record: EdgeLog) => void;
}

/** Headers that belong to one hop and are not passed on, in either direction. */
const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);
/** What the browser sent that must not reach the host: its credentials, and what says who it is. */
const FROM_BROWSER = new Set(["cookie", "authorization", "x-mesh-token", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-forwarded-port", "x-real-ip", "expect"]);

export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * What a page for a person says at the top, by the code the script would have been given. A page is for a GET that asks for
 * one, so a refusal of a change (`bad_origin`) or of a method other than GET (`method_not_allowed`) is never one, and has no title.
 */
const TITLES: Record<string, string> = {
  not_found: "Nothing here",
  not_signed_in: "Open this workspace from your account",
  invalid_code: "That link did not work",
  request_too_large: "That upload is too large",
  workspace_not_running: "This workspace cannot answer",
  workspace_unreachable: "This workspace cannot answer",
};

const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

function page(title: string, lines: string[], link?: { href: string; text: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:#0f1115;color:#e8eaf0}main{max-width:32rem;padding:2rem}h1{font-size:1.25rem;margin:0 0 .75rem}p{margin:.5rem 0;color:#b8bdca}a{color:#8ab4ff}@media (prefers-color-scheme:light){body{background:#f6f7f9;color:#14171f}p{color:#4a5160}a{color:#1a56c4}}</style></head><body><main><h1>${escapeHtml(title)}</h1>${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join("")}${link ? `<p><a href="${escapeHtml(link.href)}">${escapeHtml(link.text)}</a></p>` : ""}</main></body></html>`;
}

export class WorkspaceEdge {
  private readonly secure: boolean;
  private readonly scheme: "https" | "http";
  readonly cookieName: string;

  constructor(private readonly o: EdgeOptions) {
    this.scheme = o.workspaceScheme ?? "https";
    this.secure = this.scheme === "https";
    this.cookieName = this.secure ? "__Host-curule_ws" : "curule_ws";
  }

  private log(level: EdgeLog["level"], msg: string, fields: Record<string, unknown> = {}): void {
    this.o.log?.({ level, msg, ...fields });
  }

  private headers(extra: Record<string, string | string[]> = {}): Record<string, string | string[]> {
    return {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      ...(this.secure ? { "strict-transport-security": "max-age=31536000; includeSubDomains" } : {}),
      ...extra,
    };
  }

  /** Answer with a page, or with JSON when the caller is a script and not a person looking at a tab. */
  private say(req: http.IncomingMessage, res: http.ServerResponse, status: number, code: string, message: string, link?: { href: string; text: string }, extra: Record<string, string> = {}): void {
    if (res.headersSent || res.writableEnded) return;
    const wantsPage = req.method === "GET" && /text\/html/i.test(String(req.headers.accept ?? "")) && !/^\/(api|auth|events|stream|mcp|internal)\b/.test(req.url ?? "");
    if (wantsPage) {
      const body = page(TITLES[code] ?? "This request cannot be answered", [message], link);
      res.writeHead(status, this.headers({ "content-type": "text/html; charset=utf-8", "content-security-policy": PAGE_CSP, ...extra }));
      res.end(body);
      return;
    }
    const body = JSON.stringify({ error: { code, message } });
    res.writeHead(status, this.headers({ "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(body)), "content-security-policy": "default-src 'none'", ...extra }));
    res.end(body);
  }

  private appLink(): { href: string; text: string } {
    return { href: `${this.o.appUrl.replace(/\/+$/, "")}/account`, text: "Go to your account" };
  }

  /** Whether the grant a cookie or a code holds is still good: the session, the account and the workspace all still agree. */
  private stillGood(grant: { accountId: string; workspaceId: string; sessionId: string }, workspace: Workspace): boolean {
    if (grant.workspaceId !== workspace.workspaceId) return false;
    const who = this.o.plane.accounts.session(grant.sessionId);
    return who !== undefined && who.account.accountId === grant.accountId && workspace.accountId === grant.accountId;
  }

  /** `clientIp` is the caller's address as far as the proxy in front of the service says, and is what the host is told it was. */
  async handle(req: http.IncomingMessage, res: http.ServerResponse, clientIp: string): Promise<void> {
    const host = String(req.headers.host ?? "");
    const workspace = this.o.plane.workspaces.byHost(host);
    if (!workspace) return this.say(req, res, 404, "not_found", "There is no workspace at this address.");
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://workspace.invalid");
    } catch {
      return this.say(req, res, 400, "bad_request", "That request could not be read.");
    }
    if (url.pathname === "/__enter") return this.enter(req, res, url, workspace);

    const cookieValue = parseCookies(req.headers.cookie)[this.cookieName];
    const cookie = this.o.access.read(cookieValue);
    if (!cookie || !this.stillGood(cookie, workspace)) {
      return this.say(req, res, 401, "not_signed_in", "Open this workspace from your account, signed in.", this.appLink());
    }
    // A change must come from this workspace's own page.
    const method = req.method ?? "GET";
    const origin = req.headers.origin;
    if (method !== "GET" && method !== "HEAD" && origin !== undefined && origin !== `${this.scheme}://${host.toLowerCase()}`) {
      this.log("warn", "request from another origin", { workspaceId: workspace.workspaceId, origin: String(origin) });
      return this.say(req, res, 403, "bad_origin", "This request did not come from this workspace's own page.");
    }
    if (workspace.status !== "running" || !workspace.upstream) {
      const reason = workspace.statusReason ? `: ${workspace.statusReason}` : "";
      const why =
        workspace.status === "suspended"
          ? `This workspace is stopped${reason}.`
          : workspace.status === "failed"
            ? `This workspace could not start${reason}.`
            : workspace.status === "requested" || workspace.status === "provisioning"
              ? "This workspace is still starting."
              : workspace.status === "running"
                ? "This workspace has no address to reach yet."
                : `This workspace is ${workspace.status}.`;
      return this.say(req, res, 503, "workspace_not_running", why, this.appLink(), { "retry-after": "30" });
    }
    this.forward(req, res, url, workspace, clientIp, cookieValue!);
  }

  /** `GET /__enter?code=…`: trade a one-time code for this workspace's cookie, and go to its front page. */
  private enter(req: http.IncomingMessage, res: http.ServerResponse, url: URL, workspace: Workspace): void {
    if (req.method !== "GET") return this.say(req, res, 405, "method_not_allowed", "Use GET.", undefined, { allow: "GET" });
    const grant = this.o.access.redeemCode(url.searchParams.get("code"));
    if (!grant || !this.stillGood(grant, workspace)) {
      this.log("info", "a code that does not open this workspace", { workspaceId: workspace.workspaceId });
      return this.say(req, res, 403, "invalid_code", "That link has expired or was already used. Open the workspace again from your account.", this.appLink());
    }
    const cookie = `${this.cookieName}=${this.o.access.cookieValue(grant)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${this.o.access.cookieMaxAgeSec}${this.secure ? "; Secure" : ""}`;
    res.writeHead(302, this.headers({ location: "/", "set-cookie": cookie, "content-length": "0" }));
    res.end();
  }

  private forward(req: http.IncomingMessage, res: http.ServerResponse, url: URL, workspace: Workspace, clientIp: string, cookieValue: string): void {
    const upstream = workspace.upstream!;
    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
      const n = name.toLowerCase();
      if (HOP.has(n) || FROM_BROWSER.has(n) || value === undefined) continue;
      headers[n] = value;
    }
    headers.authorization = `Bearer ${this.o.plane.workspaces.operatorToken(workspace.workspaceId)}`;
    headers["x-forwarded-for"] = clientIp;
    headers["x-forwarded-proto"] = this.scheme;
    headers["x-forwarded-host"] = String(req.headers.host ?? "");
    const max = this.o.maxUploadBytes ?? 64 * 1024 * 1024;
    if (Number(req.headers["content-length"]) > max) return this.say(req, res, 413, "request_too_large", "That upload is too large.");

    const proxied = http.request({ host: upstream.host, port: upstream.port, method: req.method, path: url.pathname + url.search, headers, timeout: this.o.upstreamTimeoutMs ?? 30_000 });
    let finished = false;
    const stop = (): void => {
      if (finished) return;
      finished = true;
      proxied.destroy();
    };
    res.on("close", () => {
      if (!res.writableFinished) stop();
    });
    proxied.on("timeout", () => proxied.destroy(new Error("the workspace did not answer in time")));
    proxied.on("error", (err) => {
      if (finished) return;
      finished = true;
      this.log("warn", "the workspace's host did not answer", { workspaceId: workspace.workspaceId, error: err.message });
      if (res.headersSent) res.destroy();
      else this.say(req, res, 502, "workspace_unreachable", "This workspace did not answer. Try again in a moment.", this.appLink(), { "retry-after": "5" });
    });
    proxied.on("response", (answer) => {
      // The wait for a first answer is over; a stream may then be quiet for as long as it likes.
      proxied.setTimeout(0);
      const out: http.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(answer.headers)) {
        const n = name.toLowerCase();
        if (HOP.has(n) || n === "set-cookie" || value === undefined) continue;
        out[n] = value;
      }
      if (!out["x-content-type-options"]) out["x-content-type-options"] = "nosniff";
      if (!out["referrer-policy"]) out["referrer-policy"] = "no-referrer";
      // A workspace is not for another site's page to frame, unless its own host said how it may be.
      if (!out["x-frame-options"] && !/frame-ancestors/i.test(String(out["content-security-policy"] ?? ""))) out["x-frame-options"] = "SAMEORIGIN";
      if (this.secure && !out["strict-transport-security"]) out["strict-transport-security"] = "max-age=31536000; includeSubDomains";
      if (/^text\/event-stream/i.test(String(answer.headers["content-type"] ?? ""))) {
        out["cache-control"] = "no-cache, no-transform";
        out["x-accel-buffering"] = "no";
      }
      res.writeHead(answer.statusCode ?? 502, out);
      if (/^text\/event-stream/i.test(String(answer.headers["content-type"] ?? ""))) res.flushHeaders();
      answer.on("error", () => res.destroy());
      answer.pipe(res);
      // What was checked when the request began is checked again while the answer goes on.
      const recheck = setInterval(() => {
        const now = this.o.access.read(cookieValue);
        const current = this.o.plane.workspaces.byHost(String(req.headers.host ?? ""));
        if (now && current && current.workspaceId === workspace.workspaceId && current.status === "running" && this.stillGood(now, current)) return;
        this.log("info", "a response was ended because the access behind it ended", { workspaceId: workspace.workspaceId });
        stop();
        res.destroy();
      }, this.o.recheckMs ?? 15_000);
      recheck.unref();
      res.on("close", () => clearInterval(recheck));
    });

    let received = 0;
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > max) {
        stop();
        if (!res.headersSent) this.say(req, res, 413, "request_too_large", "That upload is too large.", undefined, { connection: "close" });
        req.destroy();
      }
    });
    req.pipe(proxied);
  }
}
