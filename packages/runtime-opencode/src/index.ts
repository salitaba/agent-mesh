import * as fs from "fs";
import * as path from "path";
import { spawn, type ChildProcess } from "child_process";
import {
  BackendUnreachableError,
  RequestTimeoutError,
  isConnectionError,
  newAgentSessionId,
  aliasTextOp,
  type AgentDefinition,
  type AgentInput,
  type AgentOutput,
  type AgentRuntime,
  type AgentRuntimeStatus,
  type AgentSession,
  type MeshOp,
  type RuntimeContext,
} from "../../protocol/src/index";

export interface OpenCodeModelRef {
  providerID: string;
  modelID: string;
}

export interface OpenCodeAdapterOptions {
  executable?: string;
  portBase?: number;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  /**
   * Timeout for control-plane calls (session create/restore/abort). A hung
   * backend holding session setup open wedges the scheduler slot just like a
   * hung turn, so these fail fast while model work (`send`) keeps the long
   * `requestTimeoutMs`.
   */
  controlTimeoutMs?: number;
  model?: OpenCodeModelRef;
  spawnProcesses?: boolean;
  baseUrl?: string;
  mcpCommand?: string[];
  extraConfig?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}

interface ProcessHandle {
  proc?: ChildProcess;
  baseUrl: string;
  configDir: string;
  port?: number;
  /** Path to the pidfile tracking the spawned `opencode serve` child. */
  pidFile?: string;
}

/** Grace period for SIGTERM before escalating to SIGKILL. */
const TERM_GRACE_MS = 2000;

/** Outcome of trying to build the unbounded dispatcher. */
export interface DispatcherBuild {
  /** The undici Agent, or undefined when it could not be constructed. */
  dispatcher: unknown;
  /** Why it could not be constructed. Undefined on success. */
  reason?: string;
}

/**
 * Build an undici Agent that never times out on its own.
 *
 * Node's global fetch caps `headersTimeout` at 300s. A model that thinks for
 * longer is aborted underneath us and reported as `TypeError: fetch failed` —
 * which the supervisor's transport classifier reads as "the process died",
 * restarting and finally suspending a perfectly healthy agent. Handing every
 * request a dispatcher with the timeouts disabled makes our own
 * `requestTimeoutMs` the only deadline in play.
 *
 * Historical failure this guards: undici ships *inside* Node but is not
 * resolvable as a module on modern Node (v24 throws MODULE_NOT_FOUND). The
 * previous implementation swallowed that in a bare `catch` and returned
 * undefined, so the 300s cap silently stayed in force and every long turn was
 * misread as a crashed backend. Never fail silently here: the caller reports
 * `reason` so the degradation is visible instead of inferred five minutes
 * later from a restart loop.
 */
export function buildUnboundedDispatcher(): DispatcherBuild {
  const mod = (globalThis as { __meshUndici?: unknown }).__meshUndici;
  const candidates: Array<() => unknown> = [];
  if (mod) candidates.push(() => mod);
  candidates.push(() => {
    // Runtime require: undici is a declared dependency, but this stays lazy so
    // a broken install degrades to a reported fallback instead of a hard
    // module-load crash at import time.
    const req = eval("require") as NodeRequire;
    return req("undici");
  });
  const failures: string[] = [];
  for (const load of candidates) {
    try {
      const m = load() as { Agent?: new (o: Record<string, unknown>) => unknown };
      if (typeof m?.Agent !== "function") {
        failures.push("resolved module has no Agent constructor");
        continue;
      }
      return { dispatcher: new m.Agent({ headersTimeout: 0, bodyTimeout: 0 }) };
    } catch (err) {
      failures.push(err instanceof Error ? `${(err as { code?: string }).code ?? err.name}: ${err.message}` : String(err));
    }
  }
  return {
    dispatcher: undefined,
    reason: `undici dispatcher unavailable (${failures.join("; ")}); fetch keeps its default 300s headersTimeout, so turns thinking longer than that will abort — install 'undici' to remove the cap`,
  };
}

/**
 * Kill an OS pid with escalation: SIGTERM, wait out the grace period while
 * polling for exit, then SIGKILL if still alive. Always resolves — a process
 * we cannot kill is reported by leaving it alone, never by hanging the caller.
 * (Previously the adapter sent a single SIGTERM and gave up after 2s, silently
 * orphaning `opencode serve` processes that ignore SIGTERM.)
 */
function killPidWithEscalation(pid: number, graceMs = TERM_GRACE_MS): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (!alive) {
      finish();
      return;
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      finish();
      return;
    }
    const poll = setInterval(() => {
      try {
        process.kill(pid, 0);
      } catch {
        clearInterval(poll);
        clearTimeout(escalate);
        finish();
      }
    }, 100);
    const escalate = setTimeout(() => {
      let stillAlive = true;
      try {
        process.kill(pid, 0);
      } catch {
        stillAlive = false;
      }
      if (stillAlive) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
        // Give SIGKILL a beat, then resolve regardless.
        setTimeout(() => {
          clearInterval(poll);
          finish();
        }, 500);
      }
    }, graceMs);
  });
}

/**
 * Identity check against pid reuse: only ever touch a process whose command
 * line proves it is an `opencode serve` child. Returns false for dead pids
 * and on platforms without /proc (where we cannot verify — never kill blind).
 */
function isOpencodeServePid(pid: number): boolean {
  if (pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
    return cmd.includes("opencode") && cmd.includes("serve");
  } catch {
    return false;
  }
}

export class OpenCodeRuntimeAdapter implements AgentRuntime {
  readonly name = "opencode";
  private processes = new Map<string, ProcessHandle>();
  private sessionIds = new Map<string, string>();
  private statuses = new Map<string, AgentRuntimeStatus>();
  private executable: string;
  private portBase: number;
  private startupTimeoutMs: number;
  private requestTimeoutMs: number;
  private controlTimeoutMs: number;
  private spawnProcesses: boolean;
  private fetch: typeof fetch;
  /**
   * Undici agent with header/body timeouts disabled, so the AbortController in
   * `request` is the only deadline that can fire. Undefined when undici is not
   * resolvable or a custom `fetchImpl` is supplied (tests) — the code path
   * degrades to plain fetch rather than failing to construct.
   */
  private dispatcher: unknown;
  /**
   * Set when the dispatcher could not be built, i.e. fetch still enforces its
   * own 300s header timeout. Exposed so the operator sees the degradation up
   * front instead of decoding it from a restart loop.
   */
  readonly dispatcherWarning?: string;
  private static portCursor = 0;

  constructor(private options: OpenCodeAdapterOptions = {}) {
    this.executable = options.executable ?? "opencode";
    this.portBase = options.portBase ?? 4100;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 30000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 600000;
    this.controlTimeoutMs = options.controlTimeoutMs ?? Math.min(15000, this.startupTimeoutMs);
    this.spawnProcesses = options.spawnProcesses ?? !options.baseUrl;
    this.fetch = options.fetchImpl ?? fetch;
    if (options.fetchImpl) {
      // Custom fetch (tests, http runtime): not undici, so a dispatcher is
      // meaningless and its absence is not a degradation.
      this.dispatcher = undefined;
    } else {
      const built = buildUnboundedDispatcher();
      this.dispatcher = built.dispatcher;
      if (built.reason) {
        this.dispatcherWarning = built.reason;
        // Loud on purpose. The silent version of this branch cost a healthy
        // agent three restarts and a permanent suspend.
        console.warn(`[opencode-runtime] ${built.reason}`);
      }
    }
  }

  private async request<T>(baseUrl: string, method: string, urlPath: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const controller = new AbortController();
    const budgetMs = timeoutMs ?? this.requestTimeoutMs;
    // Record *our* abort explicitly. Inferring it from the error message is
    // what made a slow model indistinguishable from a dead socket.
    let selfAborted = false;
    const timer = setTimeout(() => {
      selfAborted = true;
      controller.abort();
    }, budgetMs);
    try {
      let res: Response;
      try {
        res = await this.fetch(`${baseUrl}${urlPath}`, {
          method,
          headers: { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
          // Disable undici's own header/body timeouts so the AbortController
          // above is the single deadline. Node defaults `headersTimeout` to
          // 300s, which silently pre-empted our (longer) turn timeout and
          // surfaced a thinking model as `fetch failed` — indistinguishable
          // from a dead process. `dispatcher` is ignored by fetch impls that
          // don't understand it (including test doubles), so this is safe.
          ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
        } as RequestInit);
      } catch (err) {
        // Our own deadline fired: the backend may be perfectly healthy and
        // still thinking. Never let this reach the transport classifier.
        if (selfAborted) {
          throw new RequestTimeoutError(baseUrl, `${method} ${urlPath}`, budgetMs);
        }
        // Otherwise it *looks* like a transport failure — but "looks like" is
        // exactly what burned us before. Confirm by probing the backend: if it
        // answers, the process is alive and this was a transient/aborted
        // request, not a crash, so it must not consume the restart budget.
        if (isConnectionError(err)) {
          const cause = err instanceof Error ? err.message : String(err);
          if (await this.probe(baseUrl)) {
            throw new Error(`opencode ${method} ${urlPath} failed (${cause}) but ${baseUrl} is still answering; treating as a transient request failure, not a dead backend`);
          }
          throw new BackendUnreachableError(baseUrl, cause);
        }
        throw err;
      }
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`opencode ${method} ${urlPath} -> ${res.status}: ${text.slice(0, 400)}`);
      }
      return (text ? JSON.parse(text) : {}) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private agentConfigDir(agent: AgentDefinition, context: RuntimeContext): string {
    const dir = path.join(context.workspacePath, ".mesh", "agents", agent.id);
    fs.mkdirSync(dir, { recursive: true });
    const promptFile = path.join(dir, "ROLE.md");
    fs.writeFileSync(promptFile, context.rolePromptText, "utf8");
    const mcpCmd =
      this.options.mcpCommand ?? [
        process.execPath,
        path.resolve(__dirname, "..", "..", "..", "..", "apps", "mesh-cli", "bin", "mesh.mjs"),
        "mcp",
        "--agent",
        agent.id,
        "--bus",
        context.busUrl,
        "--token",
        context.agentToken,
      ];
    const config: Record<string, unknown> = {
      $schema: "https://opencode.ai/config.json",
      instructions: [path.join(dir, "ROLE.md")],
      mcp: {
        mesh: {
          type: "local",
          command: mcpCmd,
          enabled: true,
          environment: {
            MESH_BUS_URL: context.busUrl,
            MESH_AGENT_ID: agent.id,
            MESH_AGENT_TOKEN: context.agentToken,
          },
          timeout: 15000,
        },
      },
      permission: this.permissionsFor(agent, context),
      ...this.options.extraConfig,
    };
    if (this.options.model) {
      config.model = `${this.options.model.providerID}/${this.options.model.modelID}`;
    }
    fs.writeFileSync(path.join(dir, "opencode.json"), JSON.stringify(config, null, 2), "utf8");
    fs.writeFileSync(path.join(dir, "MESH_CONTEXT.md"), `Goal: ${context.goalId}\nMesh: ${context.meshId}\nWorkspace: ${context.workspacePath}\n`, "utf8");
    return dir;
  }

  private permissionsFor(agent: AgentDefinition, context: RuntimeContext): Record<string, unknown> {
    const caps = new Set(context.capabilityGrants.length ? context.capabilityGrants : agent.capabilities);
    const can = (c: string) => (caps.has(c) ? "allow" : "deny");
    return {
      edit: can("repository.write"),
      bash: caps.has("shell.execute") || caps.has("test.execute") ? "allow" : caps.has("git.commit") ? "ask" : "deny",
      webfetch: can("network.request"),
      read: "allow",
    };
  }

  /**
   * Next candidate port. Dense and sequential from `portBase` rather than the
   * previous `cursor*4 + random(4)` scatter: that spread each restart's
   * servers across a wide, unpredictable range, so a leaked process was hard
   * to attribute and its port was never reused. Collisions are handled by the
   * caller (spawn fails or the probe times out, and the next port is tried),
   * so a compact range is strictly easier to reason about and clean up.
   */
  private nextPort(): number {
    const base = this.portBase + (OpenCodeRuntimeAdapter.portCursor++ % 1000);
    return Math.min(65530, Math.max(1024, base));
  }

  private async ensureProcess(agent: AgentDefinition, context: RuntimeContext): Promise<ProcessHandle> {
  // Reclaim `opencode serve` children orphaned by a previous adapter lifetime
  // (crash/restart/kill -9): without this every reboot accumulates a fresh set
  // of ~300MB processes. Runs once per workspace, then periodically — agents
  // respawn throughout a long mission, so a single sweep at boot never sees
  // orphans created hours later by restart churn.
  await this.sweepOrphanedProcesses(context.workspacePath);
  const existing = this.processes.get(agent.id);
    if (existing && (!existing.proc || existing.proc.exitCode === null)) {
      if (await this.probe(existing.baseUrl)) return existing;
      await this.killProcess(agent.id, existing);
    }
    const configDir = this.agentConfigDir(agent, context);
    if (!this.spawnProcesses) {
      const baseUrl = this.options.baseUrl ?? `http://127.0.0.1:${this.portBase}`;
      const handle: ProcessHandle = { baseUrl, configDir };
      this.processes.set(agent.id, handle);
      return handle;
    }
    const port = this.nextPort();
    const cwd = fs.existsSync(context.workspacePath) ? context.workspacePath : configDir;
    const args = ["serve", "--port", String(port), "--hostname", "127.0.0.1"];
    const opts = {
      cwd,
      env: {
        ...process.env,
        ...context.env,
        OPENCODE_CONFIG: path.join(configDir, "opencode.json"),
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    };
    const useShell = process.platform === "win32";
    let proc: ChildProcess;
    try {
      proc = spawn(this.executable, args, { ...opts, shell: useShell } as never);
    } catch (err) {
      throw new Error(`failed to launch '${this.executable}': ${(err as Error).message}`);
    }
    let spawnError: Error | null = null;
    proc.on("error", (err: Error) => {
      spawnError = /ENOENT/i.test(err.message)
        ? new Error(
            `OpenCode CLI not found on PATH ('${this.executable}'). Install OpenCode, point the adapter at a running 'opencode serve' via baseUrl, or set runtime: stub in mesh.yaml.`,
          )
        : err;
    });
    const handle: ProcessHandle = { proc, baseUrl: `http://127.0.0.1:${port}`, configDir, port, pidFile: path.join(configDir, "serve.pid") };
    this.processes.set(agent.id, handle);
    if (typeof proc.pid === "number") this.writePidFile(handle, proc.pid, port);
    proc.on("exit", () => {
      this.statuses.set(agent.id, "UNREACHABLE");
    });
    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (spawnError) {
        await this.killProcess(agent.id, handle);
        throw spawnError;
      }
      if (proc.exitCode !== null) {
        await this.killProcess(agent.id, handle);
        throw new Error(`opencode serve for ${agent.id} exited early (code ${proc.exitCode}); is '${this.executable}' installed?`);
      }
      if (await this.probe(handle.baseUrl)) return handle;
      await new Promise((r) => setTimeout(r, 250));
    }
    await this.killProcess(agent.id, handle);
    throw new Error(`opencode serve for ${agent.id} did not become reachable within ${this.startupTimeoutMs}ms`);
  }

  private async probe(baseUrl: string): Promise<boolean> {
    const attempts: Array<[string, AbortSignal]> = [];
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 2000);
    attempts.push(["/global/health", controller.signal]);
    try {
      for (const [path, signal] of attempts) {
        try {
          const res = await this.fetch(`${baseUrl}${path}`, { signal });
          if (res.ok) return true;
        } catch {
          /* try next */
        }
      }
      try {
        const res = await this.fetch(`${baseUrl}/session`, { signal: controller.signal });
        return res.ok;
      } catch {
        return false;
      }
    } finally {
      clearTimeout(t);
    }
  }

  private async killProcess(agentId: string, handle: ProcessHandle): Promise<void> {
  const proc = handle.proc;
  if (proc && proc.exitCode === null && typeof proc.pid === "number") {
    await killPidWithEscalation(proc.pid);
  } else if (proc && proc.exitCode === null) {
    proc.kill();
  }
  this.processes.delete(agentId);
  if (handle.pidFile) {
    try {
      fs.unlinkSync(handle.pidFile);
    } catch {
      /* already gone */
    }
  }
}

  /**
   * One-shot per workspace: reap `opencode serve` processes recorded in
   * `.mesh/agents/<id>/serve.pid` that are still alive but not owned by this
   * adapter instance (i.e. orphaned by a crash/restart). Stale records for
   * dead or recycled pids are removed without killing. Identity is verified
   * via /proc cmdline before any signal is sent.
   */
  private sweptWorkspaces = new Map<string, number>();

  /** Re-sweep interval. Restart churn creates orphans long after boot. */
  private static readonly SWEEP_INTERVAL_MS = 5 * 60 * 1000;

  private async sweepOrphanedProcesses(workspacePath: string): Promise<void> {
    const last = this.sweptWorkspaces.get(workspacePath);
    if (last !== undefined && Date.now() - last < OpenCodeRuntimeAdapter.SWEEP_INTERVAL_MS) return;
    this.sweptWorkspaces.set(workspacePath, Date.now());
    const agentsDir = path.join(workspacePath, ".mesh", "agents");
    let entries: string[];
    try {
      entries = fs.readdirSync(agentsDir);
    } catch {
      return;
    }
    const owned = new Set<number>();
    for (const h of this.processes.values()) {
      if (h.proc?.pid) owned.add(h.proc.pid);
    }
    for (const entry of entries) {
      const pidFile = path.join(agentsDir, entry, "serve.pid");
      let pid: unknown;
      try {
        pid = (JSON.parse(fs.readFileSync(pidFile, "utf8")) as { pid?: unknown }).pid;
      } catch {
        continue;
      }
      if (typeof pid !== "number" || owned.has(pid)) continue;
      if (!isOpencodeServePid(pid)) {
        try {
          fs.unlinkSync(pidFile);
        } catch {
          /* already gone */
        }
        continue;
      }
      await killPidWithEscalation(pid);
      try {
        fs.unlinkSync(pidFile);
      } catch {
        /* next boot retries */
      }
    }
    await this.sweepVanishedWorkspaceProcesses(owned);
  }

  /**
   * Reap `opencode serve` children whose workspace no longer exists.
   *
   * The pidfile sweep above can only find processes it can still read a
   * pidfile for. Runs whose workspace was a temp dir (integration tests) or
   * was deleted/moved take their `.mesh/agents/<id>/serve.pid` with them, so
   * those children become unreclaimable and survive indefinitely — 11 such
   * servers (3.6GB) were found alive on the host that prompted this, some
   * days old. Each one holds a port and RAM, and the resulting memory
   * pressure slows real turns toward the timeout threshold.
   *
   * Identity is established from the process's own `OPENCODE_CONFIG`: we only
   * signal a process that (a) is verifiably `opencode serve`, (b) points at a
   * mesh-managed `.mesh/agents/<id>/opencode.json`, and (c) whose config file
   * is gone — i.e. nothing can be driving it anymore. A process belonging to
   * a live workspace, an unrelated opencode, or one we own is never touched.
   */
  private async sweepVanishedWorkspaceProcesses(owned: Set<number>): Promise<void> {
    let pids: string[];
    try {
      pids = fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d));
    } catch {
      return; // no /proc (non-Linux): cannot verify identity, so never guess.
    }
    for (const entry of pids) {
      const pid = Number(entry);
      if (owned.has(pid) || !isOpencodeServePid(pid)) continue;
      let configPath: string | undefined;
      try {
        const env = fs.readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
        configPath = env.find((v) => v.startsWith("OPENCODE_CONFIG="))?.slice("OPENCODE_CONFIG=".length);
      } catch {
        continue; // not ours to inspect (permissions) — leave it alone.
      }
      if (!configPath) continue;
      const normalized = configPath.split(path.sep).join("/");
      if (!normalized.includes("/.mesh/agents/")) continue; // not mesh-managed
      if (fs.existsSync(configPath)) continue; // workspace still live
      await killPidWithEscalation(pid);
    }
  }

  private writePidFile(handle: ProcessHandle, pid: number, port: number): void {
    if (!handle.pidFile) return;
    try {
      fs.writeFileSync(handle.pidFile, JSON.stringify({ pid, port, startedAt: new Date().toISOString() }), "utf8");
    } catch {
      /* pid tracking is best-effort; the process itself still works */
    }
  }

  async start(agent: AgentDefinition, context: RuntimeContext): Promise<AgentSession> {
    const handle = await this.ensureProcess(agent, context);
    const created = await this.request<{ id?: string }>(handle.baseUrl, "POST", "/session", {
      title: `mesh:${context.meshId}:${agent.id}`,
    }, this.controlTimeoutMs);
    const sessionId = created.id ?? newAgentSessionId();
    this.sessionIds.set(agent.id, sessionId);
    this.statuses.set(agent.id, "IDLE");
    return {
      sessionId,
      agentId: agent.id,
      runtime: this.name,
      createdAt: new Date().toISOString(),
      handle: { baseUrl: handle.baseUrl },
    };
  }

  async restoreSession(agent: AgentDefinition, sessionId: string, context: RuntimeContext): Promise<AgentSession | null> {
    const handle = await this.ensureProcess(agent, context).catch(() => null);
    if (!handle) return null;
    try {
      const info = await this.request<{ id?: string }>(handle.baseUrl, "GET", `/session/${sessionId}`, undefined, this.controlTimeoutMs);
      if (info?.id === sessionId) {
        this.sessionIds.set(agent.id, sessionId);
        return {
          sessionId,
          agentId: agent.id,
          runtime: this.name,
          createdAt: new Date().toISOString(),
          handle: { baseUrl: handle.baseUrl },
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  async send(session: AgentSession, input: AgentInput): Promise<AgentOutput> {
    const baseUrl = (session.handle as { baseUrl: string }).baseUrl;
    this.statuses.set(session.agentId, "RUNNING");
    const body: Record<string, unknown> = {
      parts: [{ type: "text", text: input.instructions }],
      system: input.context.rolePrompt,
    };
    if (this.options.model) body.model = this.options.model;
    // Live token tap: opencode's POST /message blocks until the turn ends,
    // but GET /event streams `message.part.delta` frames while it runs.
    // Best-effort observability only — any failure here degrades to the old
    // request/response behavior, never fails the turn.
    const stopTap = input.onToken ? this.tapTokenStream(baseUrl, session.sessionId, input.onToken) : undefined;
    let response: OpenCodeMessageResponse;
    try {
      response = await this.request<OpenCodeMessageResponse>(baseUrl, "POST", `/session/${session.sessionId}/message`, body);
    } catch (err) {
      this.statuses.set(session.agentId, "UNREACHABLE");
      throw err;
    } finally {
      stopTap?.();
    }
    this.statuses.set(session.agentId, "IDLE");
    const text = extractText(response);
    const operations = parseMeshOps(text);
    // This adapter parses ops out of prose, so its output is never typed —
    // even when the model also used tools (bash, read, ...). Typed MCP turns
    // (`mesh_*` tools) execute through McpToolset.executeOp directly and
    // never pass through here, so under typed-only transport this turn's
    // parsed ops are refused while tool-issued state changes stand.
    const info = response.info ?? response;
    const tokens = info.tokens ?? { input: 0, output: 0, reasoning: 0 };
    // Budget charge = NEW work this turn: fresh input + output + reasoning.
    //
    // `cache.read` is deliberately EXCLUDED. Sessions are persistent, so the
    // backend replays the whole conversation each turn and reports it as a
    // cache read — a number that grows monotonically with transcript length.
    // Folding it into the per-turn charge billed the entire history again on
    // every turn: a turn with input=3698/output=36 was charged 429,191 tokens
    // and climbing. That instantly exhausted the 60k thread budgets (101
    // threads blown on this mission alone), which silently blocked turns and
    // looked like "the mesh stopped for no reason".
    //
    // Cached-prefix reads are also ~10x cheaper than fresh input at every
    // major provider, so counting them at full price never modelled real cost
    // anyway. They stay observable via `cacheRead` for cost reporting.
    const cacheRead = tokens.cache?.read ?? 0;
    const cacheWrite = tokens.cache?.write ?? 0;
    const total = (tokens.input ?? 0) + (tokens.output ?? 0) + (tokens.reasoning ?? 0) + cacheWrite;
    return {
      text,
      operations,
      tokensUsed: { input: tokens.input ?? 0, output: tokens.output ?? 0, total, cacheRead },
      model: info.modelID ?? this.options.model?.modelID,
      modelVersion: info.modelID,
      toolCalls: (response.parts ?? [])
        .filter((p) => p.type === "tool")
        .map((p) => ({ name: String(p.tool ?? "tool"), args: p.state?.input ?? {}, resultDigest: shortDigest(JSON.stringify(p.state?.output ?? "")) })),
      summary: extractSummary(text),
    };
  }

  /**
   * Subscribe to the backend's SSE event stream and forward text deltas for
   * our session to onToken, batched (~150ms / 2KB) to avoid callback spam.
   * Returns a stop function; the caller must invoke it when the turn settles.
   */
  private tapTokenStream(baseUrl: string, sessionId: string, onToken: (delta: string) => void): () => void {
    const ctrl = new AbortController();
    let stopped = false;
    // Hoisted so `stop()` can drain the buffer before tearing the stream down.
    let pending = "";
    const flush = (): void => {
      if (!pending) return;
      const delta = pending;
      pending = "";
      try {
        onToken(delta);
      } catch {
        /* observer must never break the stream */
      }
    };
    const stop = (): void => {
      stopped = true;
      // Emit what arrived since the last tick BEFORE aborting. Deltas are
      // batched on a 150ms timer, so up to 150ms of text is typically sitting
      // in `pending` when the turn settles. Aborting first makes the in-flight
      // `reader.read()` reject, which jumps to the catch block and skips the
      // end-of-stream flush entirely — silently dropping the tail of the
      // answer. This must also be synchronous: `stop()` runs in send()'s
      // `finally`, while the turn is still live; a flush deferred to the async
      // teardown can land after the turn is marked finished, at which point
      // TurnTracker discards it.
      flush();
      try {
        ctrl.abort();
      } catch {
        /* already closed */
      }
    };
    void (async () => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let timer: ReturnType<typeof setInterval> | undefined;
      try {
        const res = await this.fetch(`${baseUrl}/event`, {
          headers: { accept: "text/event-stream" },
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) return;
        reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        timer = setInterval(flush, 150);
        for (;;) {
          const { done, value } = await reader.read();
          if (done || stopped) break;
          buf += dec.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const delta = extractSessionDelta(block, sessionId);
            if (delta) {
              pending += delta;
              if (pending.length >= 2000) flush();
            }
          }
        }
        flush();
      } catch {
        /* best-effort: abort, network error, or backend without /event */
      } finally {
        if (timer) clearInterval(timer);
        try {
          reader?.releaseLock();
        } catch {
          /* noop */
        }
      }
    })();
    return stop;
  }

  async interrupt(session: AgentSession): Promise<void> {
    const baseUrl = (session.handle as { baseUrl: string }).baseUrl;
    await this.request(baseUrl, "POST", `/session/${session.sessionId}/abort`, undefined, this.controlTimeoutMs).catch(() => undefined);
  }

  async suspend(session: AgentSession): Promise<void> {
    await this.interrupt(session);
    this.statuses.set(session.agentId, "SUSPENDED");
  }

  async resume(session: AgentSession): Promise<void> {
    this.statuses.set(session.agentId, "IDLE");
  }

  async stop(session: AgentSession): Promise<void> {
    const handle = this.processes.get(session.agentId);
    if (handle) await this.killProcess(session.agentId, handle);
    this.statuses.set(session.agentId, "STOPPED");
  }

  async getStatus(session: AgentSession): Promise<AgentRuntimeStatus> {
    const baseUrl = (session.handle as { baseUrl: string }).baseUrl;
    const ok = await this.probe(baseUrl);
    return ok ? (this.statuses.get(session.agentId) ?? "IDLE") : "UNREACHABLE";
  }

  async stopAll(): Promise<void> {
    for (const [agentId, handle] of [...this.processes]) {
      await this.killProcess(agentId, handle);
    }
  }
}

interface OpenCodeTokenUsage {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

interface OpenCodeMessageResponse {
  info?: {
    tokens?: OpenCodeTokenUsage;
    modelID?: string;
  };
  tokens?: OpenCodeTokenUsage;
  modelID?: string;
  parts?: Array<{
    type: string;
    text?: string;
    tool?: string;
    state?: { input?: unknown; output?: unknown };
  }>;
}

export function extractText(response: OpenCodeMessageResponse): string {
  const parts = response.parts ?? (Array.isArray(response) ? (response as unknown as OpenCodeMessageResponse["parts"]) : []);
  return (parts ?? [])
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text!)
    .join("\n");
}

const OPS_BLOCK = /```(?:mesh-json|json)?\s*\n?([\s\S]*?)```/g;

/**
 * Pull a text delta for our session out of one SSE block from GET /event.
 * Returns the delta string or null. Tolerant of framing variants: standard
 * `data:` lines or bare JSON lines.
 */
export function extractSessionDelta(block: string, sessionId: string): string | null {
  const lines = block.split("\n");
  const dataLines = lines.filter((l) => l.startsWith("data:"));
  const candidates = dataLines.length > 0 ? [dataLines.map((l) => l.slice(5).trim()).join("\n")] : [block.trim()];
  for (const candidate of candidates) {
    if (!candidate || !candidate.startsWith("{")) continue;
    try {
      const evt = JSON.parse(candidate) as {
        type?: string;
        properties?: { sessionID?: string; delta?: unknown };
      };
      if (evt.type === "message.part.delta" && evt.properties?.sessionID === sessionId && typeof evt.properties.delta === "string") {
        return evt.properties.delta;
      }
    } catch {
      continue;
    }
  }
  return null;
}
export function parseMeshOps(text: string): MeshOp[] {
  const candidates: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(OPS_BLOCK.source, "g");
  while ((m = re.exec(text)) !== null) candidates.push(m[1]);
  const trimmed = text.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) candidates.push(trimmed);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const ops = normalizeOps(parsed);
      if (ops) return ops;
    } catch {
      continue;
    }
  }
  // Salvage path: small models sometimes emit YAML-ish blocks (```mesh-op
  // with `op:` lines) instead of JSON. Only runs when JSON found nothing.
  for (const candidate of candidates) {
    const op = parseYamlishOp(candidate);
    if (op) return [op];
  }
  return [];
}

/**
 * Minimal single-op parser for `key: value` blocks. Narrow by design: only
 * fenced content starting an `op:` key qualifies, multi-line values continue
 * until the next `key:` line. Anything JSON-shaped is left alone.
 */
export function parseYamlishOp(content: string): MeshOp | null {
  if (/^\s*[{[]/.test(content)) return null;
  if (!/^\s*op\s*:/m.test(content)) return null;
  const out: Record<string, unknown> = {};
  let cur = "";
  let started = false;
  for (const line of content.split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) {
      cur = kv[1];
      started = true;
      out[cur] = stripQuotes(kv[2].trim());
    } else if (started && line.trim().length > 0) {
      out[cur] = `${String(out[cur] ?? "").trimEnd()}\n${line.trim()}`.trim();
    }
  }
  if (!started) return null;
  const aliased = aliasTextOp(out);
  if (!aliased || typeof aliased.op !== "string") return null;
  return aliased as unknown as MeshOp;
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

function normalizeOps(parsed: unknown): MeshOp[] | null {
  const aliased = (x: unknown): MeshOp | null => {
    const a = aliasTextOp(x);
    return a && typeof a.op === "string" ? (a as unknown as MeshOp) : null;
  };
  if (Array.isArray(parsed)) {
    const ops = parsed.map(aliased).filter((x): x is MeshOp => x !== null);
    // Empty array parses but means nothing; fall through to salvage paths.
    if (parsed.length === 0) return null;
    return ops;
  }
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.operations)) {
      return obj.operations.map(aliased).filter((x): x is MeshOp => x !== null);
    }
    const single = aliased(parsed);
    if (single) return [single];
  }
  return null;
}

function extractSummary(text: string): string | undefined {
  // Skip fenced op blocks AND bare JSON op lines: previously the first line
  // of a ```mesh-json array ("[") became the turn summary, which then rode
  // into agent memory as `turn:<id>: [` — the agent "remembered" success
  // while learning nothing about what actually ran.
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    // Closing delimiters were missed by the original guard (it skipped "[" but
    // not "]" or "},"), so a turn whose ops block ended the reply produced the
    // summary "]" — and that rode into agent memory as `turn:<id>: ]`. Agents
    // then carried a memory of having succeeded at something unnameable. Live
    // runs showed 5+ such entries per agent.
    .find((l) => l.length > 0 && !l.startsWith("```") && !/^[[\]{}(),;]+$/.test(l) && !/^\s*[{[]/.test(l));
  return line?.slice(0, 200);
}

function shortDigest(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `dgx-${(h >>> 0).toString(16)}`;
}
