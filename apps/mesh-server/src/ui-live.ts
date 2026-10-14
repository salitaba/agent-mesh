/**
 * The product's own UI, running: started by the owner, proxied by the console, shown live.
 *
 * A playground page is a static file the console frames. Some products do not have one: they serve their UI from a
 * command of their own — `skillctl ui` prints `listening on http://127.0.0.1:41839/?t=…` and serves a page plus an API
 * on an ephemeral port, bound to loopback and authenticated by that token. Framing a *file* cannot show that, so the
 * console runs the command and proxies the port instead: the sandboxed iframe loads every byte through the console, and
 * the product's own fetches (`/api/action`, root-absolute, as a page written for its own origin does) are pointed at
 * the proxy — where they mean exactly what they meant upstream, because the proxy mirrors the upstream root one to one.
 *
 * Two properties are kept deliberately:
 *
 * - The iframe stays an opaque origin (no `allow-same-origin`), so the product's script can read neither the console's
 *   cookies nor its API. Authentication is the token the product itself printed, which the proxy appends to every
 *   upstream request; the product's `Set-Cookie` is dropped, because a sandboxed page could not keep it anyway.
 * - Nothing here is a general forwarder. The target is the loopback port the product's own output named, chosen once at
 *   start; no request can point it elsewhere.
 */
import * as http from "http";
import { spawn, type ChildProcess } from "child_process";

const MAX_LOG = 64 * 1024;
const MAX_LIFETIME_MS = 30 * 60_000;

export type LiveUiState = {
  command: string;
  startedAt: number;
  port: number | null;
  token: string | null;
  url: string | null;
  log: string;
  exitCode: number | null;
  stopped: boolean;
  expiresAt: number;
};

export type StartResult = { ok: true; state: LiveUiState } | { ok: false; code: number; error: string };

/**
 * The URL a product prints when it is ready, and the token it printed with it.
 *
 * A line like `listening on http://127.0.0.1:41839/?t=64aac…` is the whole contract: the port is chosen by the product
 * (ephemeral, or its own default) and the token is how it authenticates. Anything else on the line is ignored.
 */
export function learnUrl(text: string): { port: number; token: string | null } | null {
  const m = /(?:https?:\/\/)?(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]):(\d{2,5})(\/[^\s"']*)?/.exec(text);
  if (!m) return null;
  const port = Number(m[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const tail = m[2] ?? "";
  const token = /[?&]t=([A-Za-z0-9._~-]{4,})/.exec(tail)?.[1] ?? null;
  return { port, token };
}

export class LiveUi {
  private child: ChildProcess | null = null;
  private state: LiveUiState | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: { cwd: string; env: NodeJS.ProcessEnv; maxLifetimeMs?: number }) {}

  /** What the console knows: the command, whether it is up, where it listens, and everything it has printed. */
  get(): LiveUiState | null {
    return this.state;
  }

  /** Where the sandboxed page should load the proxy, or null while the product has not named its port. */
  target(): { port: number; token: string | null } | null {
    const s = this.state;
    if (!s || s.stopped || s.port === null) return null;
    return { port: s.port, token: s.token };
  }

  start(command: string): StartResult {
    const running = this.state && !this.state.stopped && this.state.exitCode === null;
    if (running) return { ok: false, code: 409, error: "the product's UI is already running" };
    const trimmed = command.trim();
    if (!trimmed) return { ok: false, code: 400, error: "a command is required: the product's own way of starting its UI" };
    if (trimmed.length > 400) return { ok: false, code: 400, error: "that command is too long to be one" };

    const startedAt = Date.now();
    const expiresAt = startedAt + (this.opts.maxLifetimeMs ?? MAX_LIFETIME_MS);
    this.state = { command: trimmed, startedAt, port: null, token: null, url: null, log: "", exitCode: null, stopped: false, expiresAt };
    this.child = spawn("sh", ["-c", trimmed], {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    const child = this.child;
    const append = (chunk: Buffer): void => {
      const s = this.state;
      if (!s) return;
      s.log = (s.log + chunk.toString("utf8")).slice(-MAX_LOG);
      if (s.port === null) {
        const learned = learnUrl(s.log);
        if (learned) {
          s.port = learned.port;
          s.token = learned.token;
          s.url = `http://127.0.0.1:${learned.port}/`;
        }
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("exit", (code) => {
      const s = this.state;
      if (s) s.exitCode = code ?? 0;
      this.clearTimer();
    });
    // A UI left running for ever is a leak with a port on it. The clock is generous, and the owner can stop it sooner.
    this.timer = setTimeout(() => this.stop(), expiresAt - startedAt);
    this.timer.unref?.();
    return { ok: true, state: this.state };
  }

  stop(): boolean {
    const child = this.child;
    this.clearTimer();
    if (!child || !this.state || this.state.exitCode !== null) {
      if (this.state) this.state.stopped = true;
      return false;
    }
    this.state.stopped = true;
    try {
      // Its own process group: the product may have started children of its own.
      process.kill(-child.pid!, "SIGTERM");
    } catch {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
    return true;
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/**
 * A path written for the root of a product's own origin, made relative to the page it was served with.
 *
 * This is correct rather than clever: the proxy mirrors the upstream root one to one, so `./api/skills` reaches the same
 * request `"/api/skills"` would have upstream. Only literals that begin a path are touched — `"/"` alone is left alone,
 * since it is as likely to be a comparison as a location.
 */
export function selfRelativeText(text: string): string {
  return text
    .replace(/((?:href|src|action)\s*=\s*["'])\/(?!\/)/gi, "$1./")
    .replace(/(["'`])\/(?!\/)([A-Za-z0-9._-][^"'`\s)\\]*)/g, (whole, quote: string, rest: string) =>
      rest.includes("/") || /\.[a-z0-9]{1,4}$/i.test(rest) ? `${quote}./${rest}` : whole,
    )
    .replace(/url\(\s*\/\/(?!\/)/g, "url(./");
}

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "content-length", "host", "cookie", "set-cookie", "accept-encoding",
]);

/** What the page asked for, forwarded to the product's port with the printed token, and answered back. */
export function proxyToUi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  target: { port: number; token: string | null },
  rest: string,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const query = rest.includes("?") ? rest.slice(rest.indexOf("?")) : "";
    const path = rest.includes("?") ? rest.slice(0, rest.indexOf("?")) : rest;
    const auth = target.token ? `${query ? "&" : "?"}t=${encodeURIComponent(target.token)}` : "";
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      if (HOP_BY_HOP.has(k.toLowerCase())) continue;
      headers[k] = v;
    }
    headers["accept-encoding"] = "identity";
    headers.host = `127.0.0.1:${target.port}`;
    const upstream = http.request({ host: "127.0.0.1", port: target.port, method: req.method, path: `/${path}${auth}`, headers }, (up) => {
      const type = String(up.headers["content-type"] ?? "");
      const textual = /^(text\/|application\/(json|javascript|xml)|image\/svg)/.test(type);
      const out: http.OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(up.headers)) {
        if (v === undefined) continue;
        if (HOP_BY_HOP.has(k.toLowerCase()) || k.toLowerCase() === "content-encoding") continue;
        out[k] = v;
      }
      // The page is an opaque origin, so its own fetches are cross-origin: without these they would be refused, and the
      // product's API would answer nothing. The proof of identity is the capability in the URL, not a cookie.
      out["access-control-allow-origin"] = "*";
      out["access-control-allow-headers"] = "content-type";
      out["access-control-allow-methods"] = "GET,POST,OPTIONS";
      out["cache-control"] = "no-cache";
      delete out["content-length"];
      res.writeHead(up.statusCode ?? 502, out);
      if (!textual) {
        up.pipe(res);
        up.on("end", resolve);
        return;
      }
      const chunks: Buffer[] = [];
      up.on("data", (c: Buffer) => chunks.push(c));
      up.on("end", () => {
        res.end(selfRelativeText(Buffer.concat(chunks).toString("utf8")));
        resolve();
      });
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json", "cache-control": "no-cache" });
      res.end(JSON.stringify({ error: "the product's UI did not answer on its port" }));
      resolve();
    });
    req.pipe(upstream);
  });
}
