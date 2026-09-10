/**
 * The multi-project host.
 *
 * One process that owns the registry, the supervision tree and the dashboard,
 * and forwards everything else to a per-project child. It deliberately holds no
 * mesh state of its own: there is no kernel, no event store and no projection
 * here, because a host that understood mesh state would be a second place for
 * it to live and a second thing to keep consistent.
 *
 * Two rules shape the whole file:
 *
 *   1. The proxy is transparent and streaming. `/artifacts/:id/content` and
 *      `/workspace/run` can be large or open-ended, so the child's response is
 *      piped, never read into a string. Buffering would turn a live log into a
 *      response that arrives once the run is already over.
 *   2. The browser never sees a child token. The host injects it on the way
 *      through, so a token that leaked to the page would let any script drive a
 *      child directly — and children execute agent-authored shell commands.
 */
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { URL } from "url";
import {
  ChildProcessSupervisor,
  FileProjectRegistry,
  MESH_CONFIG_FILENAME,
  ProjectError,
  SupervisionTree,
  type ProjectHandle,
  type ProjectRef,
  type ProjectStatus,
  type ProjectSupervisor,
  type SupervisionEvent,
} from "../../../packages/projects/src/index";
import {
  MultiplexHub,
  SseDecoder,
  parseCursors,
  parseProjectList,
  type UpstreamHandle,
  type UpstreamSink,
} from "../../../packages/observability/src/index";
import type { MeshEvent } from "../../../packages/protocol/src/index";
import { requireAuth } from "./auth";

/**
 * Path prefixes owned by a project child.
 *
 * Used only by the legacy bare-route fallthrough (`/status`, `/events/stream`,
 * ... without an `/api/p/:id` prefix), which keeps the existing CLI and scripts
 * working against a host. An explicit list rather than "anything unmatched":
 * the catch-all belongs to the dashboard SPA, and proxying its asset requests
 * to a child would break the UI in a host with no project open.
 *
 * `health` and `dashboard` are absent on purpose — the host answers both
 * itself, so a liveness probe against the host reports the *host*.
 */
export const CHILD_ROUTE_PREFIXES = new Set([
  "activity",
  "agents",
  "approvals",
  "artifacts",
  "budgets",
  "config",
  "escalations",
  "events",
  "goals",
  "graph",
  "internal",
  "messages",
  "metrics",
  "mission",
  "models",
  "playground",
  "presets",
  "scheduler",
  "status",
  "steps",
  "threads",
  "timeline",
  "turns",
  "workspace",
]);

/**
 * Headers that describe one hop and must not be copied to the next one.
 * Forwarding `connection` or a stale `transfer-encoding` makes Node frame the
 * body twice, which corrupts exactly the streaming responses this proxy exists
 * to carry.
 */
const HOP_BY_HOP = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];

/** Wire status for a project the registry has never heard of. */
export const UNKNOWN_PROJECT_STATUS = "unknown";

export interface HostOptions {
  /** Registry home; defaults to `MESH_HOME` or `~/.agent-mesh`. */
  home?: string;
  port?: number;
  host?: string;
  dashboardDir?: string;
  /** Per-child `--max-old-space-size`, from `host.project_memory_mb`. */
  projectMemoryMb?: number;
  /** Children boot parked by default, mirroring `mesh console`. */
  childMode?: "parked" | "live";
  useGit?: boolean;
  /** Override the compiled child entrypoint. Tests use it; nothing else should. */
  childScript?: string;
  readyTimeoutMs?: number;
  stopGraceMs?: number;
  /** Forwarded child stdout/stderr, already split into lines. */
  onLog?: (info: { ref: ProjectRef; stream: "stdout" | "stderr"; line: string }) => void;
  onSupervision?: (event: SupervisionEvent) => void;
  /** Install SIGTERM/SIGINT handlers that drain children before exit. */
  handleSignals?: boolean;
}

export interface HostHandle {
  server: HostServer;
  port: number;
  url: string;
  registry: FileProjectRegistry;
  tree: SupervisionTree;
  supervisor: ChildProcessSupervisor;
  /** Project ids whose stranded children were reaped at boot. */
  reaped: string[];
  close(): Promise<void>;
}

/** A project as the dashboard sees it. Never carries the child's token. */
export interface ProjectSummary extends ProjectRef {
  status: ProjectStatus | typeof UNKNOWN_PROJECT_STATUS;
  pid?: number;
  health?: { rss: number; lastHeartbeat: string; restarts: number };
  error?: { reason: string; detail?: string };
  /** Set while an automatic restart is pending, for a "retrying in Ns" hint. */
  restartInMs?: number;
  /** Crash-loop breaker tripped: the UI offers manual retry only. */
  tripped: boolean;
}

/**
 * Bridges the registry's `ProjectSupervisor` seam onto the supervision tree.
 *
 * The registry asks for launch/stop and needs the resulting endpoint; the tree
 * decides restart policy but reports only a status. Rather than widen either
 * contract, this adapter routes the decision through the tree and then reads
 * the runtime facts back off the supervisor that actually spawned the process.
 */
export class SupervisedProjects implements ProjectSupervisor {
  /**
   * Ids whose next launch is an operator-initiated restart. A manual restart
   * clears the crash-loop breaker — the user asking again is new information,
   * and they may well have fixed what was killing the child.
   */
  private manual = new Set<string>();

  constructor(
    private readonly tree: SupervisionTree,
    private readonly supervisor: ChildProcessSupervisor,
  ) {}

  armManualRestart(id: string): void {
    this.manual.add(id);
  }

  async launch(ref: ProjectRef): Promise<{
    status: ProjectStatus;
    endpoint?: { port: number; token: string };
    pid?: number;
    error?: { reason: string; detail?: string };
  }> {
    const manual = this.manual.delete(ref.id);
    const result = manual ? await this.tree.restart(ref) : await this.tree.open(ref);
    const child = this.supervisor.running(ref.id);
    const out: { status: ProjectStatus; endpoint?: { port: number; token: string }; pid?: number; error?: { reason: string; detail?: string } } = {
      status: result.status,
    };
    if (child) {
      out.endpoint = { port: child.port, token: child.token };
      out.pid = child.pid;
    }
    if (result.error) out.error = result.error;
    return out;
  }

  async stop(ref: ProjectRef): Promise<void> {
    this.manual.delete(ref.id);
    await this.tree.close(ref);
  }
}

/** The host server, plus the multiplexer that must be drained with it. */
export type HostServer = http.Server & { multiplex: MultiplexHub };

export function createHostServer(deps: {
  registry: FileProjectRegistry;
  tree: SupervisionTree;
  supervisor: ChildProcessSupervisor;
  projects: SupervisedProjects;
  dashboardDir?: string;
  startedAt?: number;
  /** Cap on the frames one browser may fall behind by. Tests shrink it. */
  multiplexQueue?: number;
}): HostServer {
  const { registry, tree, supervisor, projects } = deps;
  const startedAt = deps.startedAt ?? Date.now();

  /**
   * The host's own subscription to one child's `/events/stream`.
   *
   * It is a plain SSE client over loopback authenticated with the child's
   * token — the same credential the proxy injects, and equally never seen by a
   * browser. `sinceSeq` is forwarded so a resubscription after a child restart
   * resumes from the log rather than replaying it.
   */
  const openUpstream = (projectId: string, sinceSeq: number, sink: UpstreamSink): UpstreamHandle => {
    const child = supervisor.running(projectId);
    if (!child) throw new Error(`project '${projectId}' is not open`);

    let done = false;
    const finish = (err?: Error): void => {
      if (done) return;
      done = true;
      sink.closed(err);
    };

    const decoder = new SseDecoder((frame) => {
      if (!frame.data) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(frame.data);
      } catch {
        // A frame the host cannot parse is a frame it cannot tag. Dropping one
        // is better than tearing down a live subscription over it.
        return;
      }
      // Kernel events carry a seq and are resumable; everything else is an
      // out-of-band live frame (`turn.token`) that must never enter the ring.
      const event = parsed as MeshEvent;
      if (frame.event && typeof event?.type === "string" && event.type === frame.event && typeof event.seq === "number") {
        sink.event(event);
        return;
      }
      if (frame.event) sink.stream(frame.event, parsed);
    });

    const request = http.request({
      host: "127.0.0.1",
      port: child.port,
      method: "GET",
      path: `/events/stream${sinceSeq > 0 ? `?sinceSeq=${sinceSeq}` : ""}`,
      headers: { authorization: `Bearer ${child.token}`, accept: "text/event-stream", host: `127.0.0.1:${child.port}` },
    });
    request.setNoDelay?.(true);
    request.on("response", (res) => {
      if ((res.statusCode ?? 0) !== 200) {
        res.resume();
        finish(new Error(`child '${projectId}' refused the event stream: HTTP ${res.statusCode}`));
        return;
      }
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => decoder.push(chunk));
      res.on("end", () => finish());
      res.on("error", (err: Error) => finish(err));
    });
    request.on("error", (err: Error) => finish(err));
    request.end();

    return {
      close: () => {
        // Marked done first: destroying the request fires `error`, and a hub
        // that heard "upstream closed" from its own teardown would tell every
        // client to resync against a project it just stopped following.
        done = true;
        if (!request.destroyed) request.destroy();
      },
    };
  };

  const multiplexOptions: ConstructorParameters<typeof MultiplexHub>[0] = { openUpstream };
  if (deps.multiplexQueue) multiplexOptions.maxQueue = deps.multiplexQueue;
  const multiplex = new MultiplexHub(multiplexOptions);

  /**
   * The status the UI should believe.
   *
   * A live child outranks everything: the registry's handle is written at open
   * time and never learns that the process died. A registry-side `error`
   * (folder gone, config unparseable) outranks the tree, which never saw that
   * project at all because the launch was refused before it got there.
   * Otherwise the tree is authoritative — it is the thing watching exits.
   */
  const statusOf = (id: string): ProjectStatus => {
    if (supervisor.running(id)) return "open";
    const handle = registry.get(id);
    if (handle?.status === "error") return "error";
    return tree.status(id);
  };

  const summarize = (ref: ProjectRef): ProjectSummary => {
    const handle: ProjectHandle | undefined = registry.get(ref.id);
    const child = supervisor.running(ref.id);
    const summary: ProjectSummary = {
      ...ref,
      status: statusOf(ref.id),
      tripped: tree.isTripped(ref.id),
    };
    if (child) summary.pid = child.pid;
    else if (typeof handle?.pid === "number") summary.pid = handle.pid;
    const health = tree.health(ref.id);
    if (health) summary.health = health;
    if (handle?.error) summary.error = handle.error;
    const retry = tree.pendingRestartMs(ref.id);
    if (typeof retry === "number") summary.restartInMs = retry;
    return summary;
  };

  const server = http.createServer((req, res) => {
    void route(req, res).catch((err) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
    });
  });

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const u = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const parts = u.pathname.split("/").filter((p) => p.length > 0);
    const json = (code: number, body: unknown): void => {
      res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify(body));
    };
    const body = async (): Promise<Record<string, unknown>> => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return {};
      try {
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return {};
      }
    };

    try {
      // Operator auth on the host's own boundary. The child tokens below are a
      // separate, internal credential and are never accepted from outside.
      const auth = requireAuth(req, u, parts);
      if (!auth.ok) return json(401, { error: auth.error });

      // ------------------------------------------------------------- health
      if (parts[0] === "health" && parts.length === 1 && req.method === "GET") {
        return json(200, {
          ok: true,
          role: "host",
          uptimeMs: Date.now() - startedAt,
          projects: registry.list().length,
          open: supervisor.runningIds(),
        });
      }

      // ------------------------------------------------ multiplexed events
      // Matched before `/api/p/` and before the legacy fallthrough — "events"
      // is in CHILD_ROUTE_PREFIXES, and this is the one events route the host
      // answers itself instead of forwarding.
      if (parts[0] === "api" && parts[1] === "events" && parts[2] === "stream" && parts.length === 3 && req.method === "GET") {
        return streamMultiplexed(req, res, u);
      }

      // ------------------------------------------------------- project proxy
      // `/api/p/:projectId/<rest>` — everything after the id is the child's own
      // path, preserved verbatim including the query string.
      if (parts[0] === "api" && parts[1] === "p" && parts[2]) {
        const projectId = decodeURIComponent(parts[2]);
        const target = `/${parts.slice(3).join("/")}`;
        return proxyToProject(req, res, projectId, target, u);
      }

      // --------------------------------------------------------- folder picker
      // The browser cannot hand a real path to the server — a file input gives
      // a sandboxed name, not `/home/me/work/api`. The registry needs a path
      // the *host* can stat, so the host lists directories and the dashboard
      // walks them.
      if (parts[0] === "api" && parts[1] === "browse" && parts.length === 2 && req.method === "GET") {
        return json(200, browseDir(u.searchParams.get("path")));
      }

      // ------------------------------------------------------ registry routes
      if (parts[0] === "api" && parts[1] === "projects") {
        if (parts.length === 2 && req.method === "GET") {
          registry.reload();
          return json(200, { projects: registry.list().map(summarize) });
        }
        if (parts.length === 2 && req.method === "POST") {
          const b = await body();
          const root = typeof b.root === "string" ? b.root.trim() : "";
          if (!root) return json(400, { error: "body must carry { root }" });
          const ref = await registry.add(root);
          return json(201, summarize(ref));
        }
        if (parts[2]) {
          const id = decodeURIComponent(parts[2]);
          const ref = registry.list().find((r) => r.id === id);
          if (!ref) return json(404, { error: `no project '${id}' in the registry` });

          if (parts[3] === "open" && parts.length === 4 && req.method === "POST") {
            const handle = await registry.open(id);
            // 200 even when the child failed to come up: the request itself
            // succeeded, and the caller needs the status and reason to show a
            // crashed or locked tab rather than a bare HTTP error.
            return json(200, summarize(handle.ref));
          }
          if (parts[3] === "close" && parts.length === 4 && req.method === "POST") {
            // Drop the host's subscription first: closing the child would
            // otherwise surface as an upstream error and tell every browser to
            // resync against a project that is meant to be gone.
            await multiplex.unfollow(id);
            await registry.close(id);
            return json(200, summarize(ref));
          }
          if (parts[3] === "restart" && parts.length === 4 && req.method === "POST") {
            await multiplex.unfollow(id);
            await registry.close(id);
            projects.armManualRestart(id);
            const handle = await registry.open(id);
            return json(200, summarize(handle.ref));
          }
          if (parts.length === 3 && req.method === "DELETE") {
            await multiplex.unfollow(id);
            await registry.remove(id);
            // Drop it from supervision too, or a removed project keeps its
            // crash history and its breaker state for a later re-add.
            await tree.forget(ref);
            return json(200, { ok: true, id });
          }
        }
        return json(404, { error: `no route: ${req.method} ${u.pathname}` });
      }

      // ------------------------------------------------- legacy bare routes
      // Pre-multi-project clients (`mesh --bus`, scripts) call `/status` and
      // `/events/stream` with no project segment. With exactly one project
      // open the intent is unambiguous, so forward it; with several it is a
      // guess, and guessing which mission a script meant to drive is worse
      // than telling it to name one.
      if (parts[0] && CHILD_ROUTE_PREFIXES.has(parts[0])) {
        const open = supervisor.runningIds();
        if (open.length === 1) {
          return proxyToProject(req, res, open[0], u.pathname, u);
        }
        return json(409, {
          error:
            open.length === 0
              ? "no project is open — POST /api/projects/:id/open first, or call /api/p/:id" + u.pathname
              : `${open.length} projects are open — address one explicitly via /api/p/:id${u.pathname}`,
          status: open.length === 0 ? "closed" : "ambiguous",
          open,
        });
      }

      // ---------------------------------------------------------- dashboard
      // Served by the host and only by the host: children have no dashboard
      // assets to hand out and must never be loaded directly in a browser.
      if (req.method === "GET" && serveStatic(res, deps.dashboardDir, parts)) return;

      return json(404, { error: `no route: ${req.method} ${u.pathname}` });
    } catch (err) {
      if (err instanceof ProjectError) {
        const code = err.code === "duplicate_id" ? 409 : err.code === "unknown_project" ? 404 : 400;
        return json(code, { error: err.message, code: err.code, detail: err.detail });
      }
      if (res.headersSent) {
        res.destroy();
        return;
      }
      return json(500, { error: (err as Error).message });
    }
  }

  /**
   * One browser stream carrying every requested project.
   *
   * The requested set is intersected with what is actually open: a tab that
   * asks for a project the host cannot follow gets told so per project and
   * keeps the rest of its stream, because dropping the connection is exactly
   * what the reconnect-with-cursors design exists to avoid.
   */
  async function streamMultiplexed(req: http.IncomingMessage, res: http.ServerResponse, u: URL): Promise<void> {
    const requested = parseProjectList(u.searchParams.get("projects"));
    const cursors = parseCursors(u.searchParams.get("since"));
    // No `?projects=` means "everything open right now" — the common case for
    // a dashboard that just reconnected and has not decided on tabs yet.
    const wanted = requested.length > 0 ? requested : supervisor.runningIds();

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
      "x-accel-buffering": "no",
    });
    res.flushHeaders?.();
    res.socket?.setNoDelay(true);
    res.write(`retry: 3000\n`);
    res.write(`: connected ${new Date().toISOString()}\n\n`);

    const unavailable: { projectId: string; status: string }[] = [];
    for (const projectId of wanted) {
      if (!supervisor.running(projectId)) {
        const known = registry.list().some((r) => r.id === projectId);
        unavailable.push({ projectId, status: known ? statusOf(projectId) : UNKNOWN_PROJECT_STATUS });
        continue;
      }
      try {
        await multiplex.follow(projectId, cursors.get(projectId) ?? 0);
      } catch (err) {
        unavailable.push({ projectId, status: (err as Error).message });
      }
    }
    if (unavailable.length > 0) {
      res.write(`event: projects.unavailable\ndata: ${JSON.stringify({ projects: unavailable })}\n\n`);
    }

    const remove = multiplex.add(res, { projects: wanted, since: cursors });
    // `close` fires for both a navigated-away tab and a host shutdown that
    // force-closed the socket, so this is the single drain path.
    res.on("close", () => remove());
  }

  /**
   * Forward one request to a project child, verbatim, and stream the response
   * back as it arrives.
   */
  function proxyToProject(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    projectId: string,
    targetPath: string,
    u: URL,
  ): void {
    const child = supervisor.running(projectId);
    if (!child) {
      const known = registry.list().some((r) => r.id === projectId);
      const status = known ? statusOf(projectId) : UNKNOWN_PROJECT_STATUS;
      // 409, never 404: the route exists, the project just is not running.
      // 404 would read as "no such endpoint" and the dashboard could not tell
      // a typo from a closed tab it should offer to open.
      res.writeHead(409, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(
        JSON.stringify({
          error: known ? `project '${projectId}' is ${status}` : `no project '${projectId}' in the registry`,
          status,
          projectId,
        }),
      );
      return;
    }

    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    for (const h of HOP_BY_HOP) delete headers[h];
    // The operator's credential stops here. The child accepts only its own
    // token, minted per launch and never sent to a browser.
    delete headers.authorization;
    delete headers["x-mesh-token"];
    headers.host = `127.0.0.1:${child.port}`;
    headers.authorization = `Bearer ${child.token}`;

    // `?token=` would otherwise carry the host's operator token into the
    // child's logs for no benefit — the header above already authenticates us.
    const search = new URLSearchParams(u.search);
    search.delete("token");
    const query = search.toString();
    const path = `${targetPath}${query ? `?${query}` : ""}`;

    const upstream = http.request(
      { host: "127.0.0.1", port: child.port, method: req.method, path, headers },
      (up) => {
        const out: http.OutgoingHttpHeaders = { ...up.headers };
        for (const h of HOP_BY_HOP) delete out[h];
        res.writeHead(up.statusCode ?? 502, out);
        // Long-lived streams (SSE, `/workspace/run`) must reach the browser as
        // they are produced, so headers go out now and Nagle stays off.
        res.flushHeaders?.();
        res.socket?.setNoDelay(true);
        up.pipe(res);
      },
    );
    upstream.setNoDelay?.(true);

    upstream.on("error", (err: Error) => {
      if (res.headersSent) {
        // Mid-stream failure: the status line is already committed, so the only
        // honest signal left is an aborted body.
        res.destroy();
        return;
      }
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `project '${projectId}' did not answer`, detail: err.message, projectId }));
    });

    // A browser that navigates away from an SSE stream must not leave the
    // host holding an open subscription against the child forever.
    res.on("close", () => {
      if (!upstream.destroyed) upstream.destroy();
    });

    req.pipe(upstream);
  }

  const hosted = server as HostServer;
  hosted.multiplex = multiplex;
  return hosted;
}

/** One directory listing for the add-project picker. */
export interface BrowseResult {
  path: string;
  /** Null at the filesystem root, so the UI knows to hide "up". */
  parent: string | null;
  entries: Array<{ name: string; path: string; hasMesh: boolean }>;
  error?: string;
}

/**
 * Directories only, plus whether each already holds a `mesh.yaml`.
 *
 * Deliberately not a general file browser: it lists names and a boolean, never
 * file contents, so it cannot be turned into an arbitrary-read primitive. It is
 * behind the host's operator auth like every other `/api` route — and the host
 * process can already read anything the operator can, so exposing *where*
 * projects might live adds no capability it did not have.
 */
export function browseDir(input: string | null): BrowseResult {
  const home = process.env.HOME || process.env.USERPROFILE || "/";
  const target = path.resolve(input && input.trim() ? input.trim() : home);
  const parentOf = (p: string): string | null => {
    const up = path.dirname(p);
    return up === p ? null : up;
  };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch (err) {
    // An unreadable folder is a normal thing to click on. Answering 200 with
    // the reason keeps the picker on screen instead of blanking it.
    return { path: target, parent: parentOf(target), entries: [], error: (err as Error).message };
  }
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => {
      const full = path.join(target, e.name);
      return { name: e.name, path: full, hasMesh: fs.existsSync(path.join(full, MESH_CONFIG_FILENAME)) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { path: target, parent: parentOf(target), entries: dirs };
}

/** Static dashboard assets. Returns false when nothing matched. */
function serveStatic(res: http.ServerResponse, dir: string | undefined, parts: string[]): boolean {
  const isIndex = parts.length === 0 || parts[0] === "dashboard";
  if (!dir || !fs.existsSync(dir)) {
    if (!isIndex) return false;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      "<!doctype html><meta charset=utf-8><title>Agent Mesh</title><body style='font-family:monospace;background:#0d1117;color:#e6edf3;padding:24px'>Agent Mesh host online (no dashboard assets). See <a style='color:#58a6ff' href='/api/projects'>/api/projects</a></body>",
    );
    return true;
  }
  const rel = isIndex ? (parts.length <= 1 ? "index.html" : parts.slice(1).join("/")) : parts.join("/");
  const safe = path.normalize(rel).replace(/^([.][.][/\\])+/, "");
  const target = path.join(dir, safe);
  if (target.startsWith(dir) && fs.existsSync(target) && fs.statSync(target).isFile()) {
    const ext = path.extname(target).toLowerCase();
    const type =
      ext === ".html" ? "text/html" :
      ext === ".js" ? "text/javascript" :
      ext === ".css" ? "text/css" :
      ext === ".json" ? "application/json" :
      ext === ".svg" ? "image/svg+xml" : "text/plain";
    res.writeHead(200, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-cache" });
    res.end(fs.readFileSync(target));
    return true;
  }
  if (isIndex) {
    // SPA entry: deep links like `#/p/:id/steps` are resolved client-side.
    const index = path.join(dir, "index.html");
    if (fs.existsSync(index)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
      res.end(fs.readFileSync(index));
      return true;
    }
  }
  return false;
}

export async function startHostServer(options: HostOptions = {}): Promise<HostHandle> {
  const supervisorOptions: ConstructorParameters<typeof ChildProcessSupervisor>[0] = {
    mode: options.childMode ?? "parked",
    useGit: options.useGit ?? false,
  };
  if (options.projectMemoryMb) supervisorOptions.memoryMb = options.projectMemoryMb;
  if (options.childScript) supervisorOptions.childScript = options.childScript;
  if (options.readyTimeoutMs) supervisorOptions.readyTimeoutMs = options.readyTimeoutMs;
  if (options.stopGraceMs) supervisorOptions.stopGraceMs = options.stopGraceMs;
  if (options.onLog) supervisorOptions.onLog = options.onLog;

  // The tree and the supervisor are mutually referential: the supervisor
  // reports exits, the tree decides what they mean. Late-binding `onExit`
  // through a mutable slot is what lets both be constructed once.
  let tree: SupervisionTree | undefined;
  supervisorOptions.onExit = (info) => tree?.handleExit(info);

  const supervisor = new ChildProcessSupervisor(supervisorOptions);
  const treeOptions: ConstructorParameters<typeof SupervisionTree>[0] = { supervisor };
  if (options.onSupervision) treeOptions.onEvent = options.onSupervision;
  tree = new SupervisionTree(treeOptions);

  const projects = new SupervisedProjects(tree, supervisor);
  const registryOptions: ConstructorParameters<typeof FileProjectRegistry>[0] = { supervisor: projects };
  if (options.home) registryOptions.home = options.home;
  const registry = new FileProjectRegistry(registryOptions);

  // Across *every* registered project, not just the ones about to be opened: a
  // child stranded by a SIGKILLed host still holds its project's state lock,
  // so a project nobody opens this session stays unopenable until it is reaped.
  const reaped = await tree.start(registry.list());

  const dashboardDir =
    options.dashboardDir ??
    [
      path.resolve(process.cwd(), "apps", "mesh-dashboard", "dist"),
      path.resolve(__dirname, "..", "..", "..", "..", "apps", "mesh-dashboard", "dist"),
      path.resolve(__dirname, "..", "..", "mesh-dashboard", "dist"),
    ].find((d) => fs.existsSync(d));

  const server = createHostServer({ registry, tree, supervisor, projects, dashboardDir });
  const port = options.port ?? 7420;
  const host = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error & { code?: string }): void => {
      if (err?.code === "EADDRINUSE") {
        reject(new Error(`port ${port} is already in use — another mesh host still holds it. Stop it first (or pick another --port).`));
      } else {
        reject(err);
      }
    };
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const actualPort = (server.address() as { port: number }).port;

  let closing: Promise<void> | undefined;
  const close = async (): Promise<void> => {
    // Idempotent: SIGTERM during an in-flight close must not start a second
    // teardown that races the first over the same children.
    if (closing) return closing;
    closing = (async () => {
      // Before the socket teardown: the hub owns loopback subscriptions to the
      // children, and one left open would keep `server.close()` waiting on a
      // request this process itself is making.
      await server.multiplex.close();
      await new Promise<void>((resolve) => {
        server.closeIdleConnections?.();
        server.close(() => resolve());
        // Proxied SSE sockets never end on their own, so a plain close() would
        // hang for as long as one dashboard tab is open.
        setTimeout(() => {
          server.closeAllConnections?.();
          resolve();
        }, 2_000).unref?.();
      });
      await tree.shutdown();
    })();
    return closing;
  };

  if (options.handleSignals) {
    const onSignal = (): void => {
      void close().then(() => process.exit(0));
    };
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
  }

  return {
    server,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    registry,
    tree,
    supervisor,
    reaped,
    close,
  };
}
