import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { URL } from "url";
import type { MeshEvent, MeshMessage, MessageType, ArtifactStatus } from "../../../packages/protocol/src/index";
import { resolveConfig, type ResolvedMeshConfig, analyzeMeshConfig, stringifyMesh, ConfigError } from "../../../packages/config/src/index";
import { parse as parseYaml } from "yaml";
const parseYamlText = (text: string): unknown => parseYaml(text);
import { Kernel, Supervisor, BudgetManager, HUMAN_AGENT_ID, type OpResult } from "../../../packages/core/src/index";
import { missionKey } from "../../../packages/core/src/budgets";
import { JsonlEventStore, MemoryEventStore, type EventStore } from "../../../packages/event-store/src/index";
import { PolicyEngine } from "../../../packages/policy-engine/src/index";
import { Scheduler, type TriageModel } from "../../../packages/scheduler/src/index";
import { StubRuntime, StaticRuntimeResolver } from "../../../packages/agent-runtime/src/index";
import { FileSystemArtifactStore, GitWorkspace, InMemoryArtifactStore } from "../../../packages/artifact-store/src/index";
import { FileSessionRegistry, ensureStateLayout, openSqliteIndex } from "../../../packages/persistence/src/index";
import { systemClock } from "../../../packages/protocol/src/index";
import {
  buildMeshGraph,
  buildCostReport,
  buildGoalView,
  buildArtifactTimeline,
  eventTimeline,
  buildMetrics,
  SseHub,
} from "../../../packages/observability/src/index";
import { createMcpToolset } from "./mcp";
import { OpenCodeRuntimeAdapter } from "../../../packages/runtime-opencode/src/index";
import { HttpRuntimeAdapter } from "../../../packages/runtime-http/src/index";

export interface BootstrapOptions {
  configPath: string;
  runtimeOverrides?: Record<string, StubRuntime>;
  useGit?: boolean;
  inMemory?: boolean;
  /** Serve dashboard/API/SSE but never start the scheduler or activate agents. */
  uiOnly?: boolean;
  triageModel?: TriageModel;
  opencodeOptions?: {
    executable?: string;
    baseUrl?: string;
    model?: { providerID: string; modelID: string };
    spawnProcesses?: boolean;
  };
  httpRuntimeUrl?: string;
}

export interface MeshInstance {
  config: ResolvedMeshConfig;
  supervisor: Supervisor;
  kernel: Kernel;
  store: EventStore;
  scheduler: Scheduler;
  stubRuntimes: Map<string, StubRuntime>;
  startedAt: number;
  uiOnly: boolean;
  close(): Promise<void>;
}

export async function bootstrapMesh(options: BootstrapOptions): Promise<MeshInstance> {
  const config = resolveConfig(options.configPath);
  const layout = options.inMemory
    ? { events: config.stateDir, artifacts: config.stateDir, logs: config.stateDir }
    : ensureStateLayout(config.stateDir);
  const store: EventStore = options.inMemory
    ? new MemoryEventStore()
    : new JsonlEventStore(path.join(layout.logs, "events.jsonl"));
  const kernel = new Kernel(
    store,
    systemClock,
    (msg) => {
      try {
        fs.appendFileSync(path.join(layout.logs, "projection-rejections.log"), `${new Date().toISOString()} ${msg}\n`, "utf8");
      } catch {
        /* audit never breaks the runtime */
      }
    },
    { transitionGates: config.transitionGates },
  );
  const budget = new BudgetManager(kernel);
  const policy = new PolicyEngine(config.policyRules);
  const content = options.inMemory
    ? new InMemoryArtifactStore()
    : new FileSystemArtifactStore(path.join(layout.artifacts));
  const workspace = options.useGit ? new GitWorkspace(config.workspacePath) : undefined;
  const sessionRegistry = options.inMemory ? undefined : new FileSessionRegistry(config.stateDir);

  const resolver = new StaticRuntimeResolver();
  const stubRuntimes = new Map<string, StubRuntime>();
  const sharedStub = new StubRuntime({ scripts: new Map() });
  stubRuntimes.set("stub", sharedStub);
  resolver.register("stub", sharedStub);
  for (const [name, stub] of Object.entries(options.runtimeOverrides ?? {})) {
    resolver.register(name, stub);
    stubRuntimes.set(name, stub);
  }
  resolver.register(
    "opencode",
    new OpenCodeRuntimeAdapter({
      executable: options.opencodeOptions?.executable,
      baseUrl: options.opencodeOptions?.baseUrl,
      spawnProcesses: options.opencodeOptions?.spawnProcesses,
      model: options.opencodeOptions?.model,
      mcpCommand: process.env.MESH_MCP_COMMAND ? JSON.parse(process.env.MESH_MCP_COMMAND) : undefined,
    }),
  );
  if (options.httpRuntimeUrl) {
    resolver.register("http", new HttpRuntimeAdapter({ baseUrl: options.httpRuntimeUrl }));
  }
  resolver.register("none", {
    name: "none",
    async start(): Promise<import("../../../packages/protocol/src/index").AgentSession> {
      throw new Error("the human seat has no runtime");
    },
    async send(): Promise<import("../../../packages/protocol/src/index").AgentOutput> {
      throw new Error("the human seat has no runtime");
    },
    async interrupt() {},
    async suspend() {},
    async resume() {},
    async stop() {},
    async getStatus() {
      return "STOPPED" as const;
    },
  });

  let schedulerRef: Scheduler;
  const schedulerProxy = new Proxy({} as import("../../../packages/core/src/ports").SchedulerPort, {
    get(_t, prop: string | symbol) {
      const target = schedulerRef as unknown as Record<string | symbol, unknown>;
      const value = target?.[prop];
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(schedulerRef) : value;
    },
  });
  const supervisor = new Supervisor({
    config,
    kernel,
    store,
    budget,
    policy,
    runtimes: resolver,
    content,
    workspace,
    sessionRegistry,
    scheduler: schedulerProxy,
    auditFile: options.inMemory ? undefined : path.join(layout.logs, "turn-audit.jsonl"),
  });
  const scheduler = new Scheduler(config, kernel.state, policy, supervisor, options.triageModel);
  schedulerRef = scheduler;

  kernel.subscribe((event) => {
    scheduler.handleEvent(event).catch(() => undefined);
  });

  if (options.inMemory === false) {
    const index = openSqliteIndex(path.join(layout.events, "events-index.sqlite"));
    const events = await store.read();
    index.ingest(events);
    kernel.subscribe((e) => index.ingest([e]));
  }

  await kernel.replayFromStore();
  const resume = kernel.state.eventCount > 0;
  if (resume) {
    scheduler.rebuildInterestRegistry();
  }
  await supervisor.boot({ resume, uiOnly: options.uiOnly });

  return {
    config,
    supervisor,
    kernel,
    store,
    scheduler,
    stubRuntimes,
    startedAt: Date.now(),
    uiOnly: Boolean(options.uiOnly),
    async close() {
      await supervisor.shutdown();
    },
  };
}

export interface ServerHandle {
  server: http.Server;
  port: number;
  url: string;
  instance: MeshInstance;
  close(): Promise<void>;
}

export function createHttpServer(instance: MeshInstance, opts: { dashboardDir?: string } = {}): http.Server {
  const { supervisor, kernel, config, store } = instance;
  const hub = new SseHub();
  kernel.subscribe((e) => hub.broadcast(e));
  const mcp = createMcpToolset(supervisor);
  const startedAt = instance.startedAt;

  const server = http.createServer((req, res) => {
    void route(req, res).catch((err) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
    });
  });

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const u = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const parts = u.pathname.split("/").filter((p) => p.length > 0);
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify(body, null, 2));
    };
    const body = async (): Promise<Record<string, any>> => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return {};
      try {
        return JSON.parse(raw);
      } catch {
        return {};
      }
    };
    try {
      // --------------------------------------------------------- MCP bridge
      if (parts[0] === "internal" && parts[1] === "mcp") {
        const agentId = decodeURIComponent(parts[2] ?? "");
        const token = req.headers["x-mesh-token"] ?? u.searchParams.get("token");
        const payload = await body();
        const result = await mcp.handle(agentId, String(token ?? ""), payload);
        return json(200, result);
      }

      // ------------------------------------------------------------- goals
      if (parts[0] === "goals" && req.method === "POST" && parts.length === 1) {
        const b = await body();
        const goal = await supervisor.createGoal(b as import("../../../packages/protocol/src/index").CreateGoalInput);
        return json(201, goal);
      }
      if (parts[0] === "goals" && parts[1]) {
        const goalId = decodeURIComponent(parts[1]);
        const goal = kernel.state.goals.get(goalId);
        if (parts[2] === "pause" && req.method === "POST") {
          await supervisor.pauseGoal(goalId);
          return json(200, { ok: true });
        }
        if (parts[2] === "resume" && req.method === "POST") {
          await supervisor.resumeGoal(goalId);
          return json(200, { ok: true });
        }
        if (parts[2] === "replay" && req.method === "GET") {
          const upTo = u.searchParams.get("upToSeq");
          const state = await supervisor.replay(goalId, upTo ? Number(upTo) : undefined);
          return json(200, state);
        }
        if (req.method === "GET") {
          if (!goal) return json(404, { error: "goal not found" });
          return json(200, { goal, view: buildGoalView(kernel.state), metrics: buildMetrics(kernel.state, Date.now() - startedAt) });
        }
      }

      // ------------------------------------------------------------ agents
      if (parts[0] === "agents") {
        if (req.method === "GET" && parts.length === 1) {
          const st = await supervisor.status();
          return json(200, st.agents);
        }
        const id = parts[1] ? decodeURIComponent(parts[1]) : "";
        const rec = kernel.state.agents.get(id);
        if (req.method === "GET" && parts.length === 2) {
          if (!rec) return json(404, { error: "agent not found" });
          return json(200, {
            definition: rec.definition,
            state: rec.state,
            unread: kernel.state.unread.get(id) ?? [],
            memory: [...(kernel.state.memory.get(id)?.values() ?? [])],
            session: kernel.state.sessionMap.get(id) ?? null,
          });
        }
        if (req.method === "POST" && parts[2] === "wake") {
            const result = await supervisor.activateAgent(id, { kind: "manual", note: "manual wake via API" });
            return json(result.queued ? 200 : 409, { ok: result.queued, queued: result.queued, reason: result.blocked });
          }
        if (req.method === "POST" && parts[2] === "suspend") {
          await supervisor.suspendAgent(id);
          return json(200, { ok: true });
        }
        if (req.method === "POST" && parts[2] === "resume") {
          await supervisor.resumeAgent(id);
          return json(200, { ok: true });
        }
      }

      // ----------------------------------------------------------- threads
      if (parts[0] === "threads" && parts[1] && req.method === "GET") {
        const t = kernel.state.threads.get(decodeURIComponent(parts[1]));
        if (!t) return json(404, { error: "thread not found" });
        const messages = t.messageIds.map((id) => kernel.state.messages.get(id)).filter(Boolean) as MeshMessage[];
        return json(200, { thread: t, messages });
      }
      if (parts[0] === "messages" && parts[1] && req.method === "GET") {
        const m = kernel.state.messages.get(decodeURIComponent(parts[1]));
        return m ? json(200, m) : json(404, { error: "message not found" });
      }

      // --------------------------------------------------------- artifacts
      if (parts[0] === "artifacts" && parts[1]) {
        const id = decodeURIComponent(parts[1]);
        const a = kernel.state.artifacts.get(id);
        if (!a) return json(404, { error: "artifact not found" });
        if (parts[2] === "versions" && req.method === "GET") {
          return json(200, kernel.state.artifactHistory.get(id) ?? [a]);
        }
        if (parts[2] === "content" && req.method === "GET") {
          const text = await readContent(instance, a.contentRef);
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          res.end(text);
          return;
        }
        return json(200, a);
      }
      if (parts[0] === "artifacts" && req.method === "GET") {
        return json(200, [...kernel.state.artifacts.values()]);
      }

      // ----------------------------------------------------------- budgets
      if (parts[0] === "budgets" && req.method === "GET") {
        const consumed = await store.read({ types: ["budget.consumed"] });
        const models: Record<string, { calls: number; tokens: number }> = {};
        for (const e of consumed) {
          const p = e.payload as { model?: string; amount?: number; limitKind?: string };
          if (p.model && p.limitKind !== "events" && p.limitKind !== "wallclock_minutes") {
            models[p.model] = models[p.model] || { calls: 0, tokens: 0 };
            models[p.model].calls++;
            models[p.model].tokens += p.amount ?? 0;
          }
        }
        return json(200, {
          entries: [...kernel.state.budgets.values()].map((b) => ({
            key: b.key,
            limit: b.limit,
            limitKind: b.limitKind,
            reserved: b.reserved,
            consumed: b.consumed,
            exceeded: b.exceeded,
          })),
          cost: buildCostReport(kernel.state, config),
          models,
        });
      }

      // --------------------------------------------------------- approvals
      if (parts[0] === "approvals" && req.method === "GET") {
        return json(200, [...kernel.state.approvals.values()].flat());
      }
      if (parts[0] === "approvals" && req.method === "POST") {
        const b = await body();
        const kind = (b.kind ?? "approve") as "approve" | "reject" | "pass" | "block" | "veto" | "accept" | "merge";
        const by = (b.by ?? HUMAN_AGENT_ID) as string;
        if (b.taskId && kind === "approve") {
          const r = await supervisor.completeTask(by, b.taskId, b.comment ?? "approved via API");
          return json(r.ok ? 200 : 400, r);
        }
        const res2 = await supervisor.recordDecision(by, kind, b.subject ?? "release", b.artifactId, b.comment);
        return json(res2.ok ? 200 : 403, res2);
      }

      // ------------------------------------------------------- escalations
      if (parts[0] === "escalations") {
        if (req.method === "GET" && parts.length === 1) {
          return json(200, [...kernel.state.escalations.values()]);
        }
        if (req.method === "POST" && parts[1] && parts[2] === "respond") {
          const b = await body();
          const r = await supervisor.respondEscalation(decodeURIComponent(parts[1]), b.response ?? "acknowledged");
          return json(r.ok ? 200 : 400, r);
        }
      }

      // ------------------------------------------------------------ events
      if (parts[0] === "events" && parts[1] === "stream" && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "access-control-allow-origin": "*",
        });
        const remove = hub.add(res);
        const recent = await store.read({ sinceSeq: 0, limit: 50 });
        for (const e of recent) hub.broadcast(e);
        req.on("close", () => remove());
        return;
      }
      if (parts[0] === "events" && req.method === "GET") {
        const events = await store.read({
          goalId: u.searchParams.get("goalId") ?? undefined,
          types: u.searchParams.get("type") ? ([u.searchParams.get("type")] as MeshEvent["type"][]) : undefined,
          actorId: u.searchParams.get("actorId") ?? undefined,
          limit: u.searchParams.get("limit") ? Number(u.searchParams.get("limit")) : undefined,
        });
        return json(200, eventTimeline(events, events.length));
      }

      // ------------------------------------- observability / control views
      if (parts[0] === "metrics" && req.method === "GET") {
        return json(200, {
          metrics: buildMetrics(kernel.state, Date.now() - startedAt),
          budget: buildCostReport(kernel.state, config),
          goal: buildGoalView(kernel.state),
        });
      }
      if (parts[0] === "graph" && req.method === "GET") {
        return json(200, buildMeshGraph(kernel.state));
      }
      if (parts[0] === "timeline" && req.method === "GET") {
        return json(200, buildArtifactTimeline(kernel.state));
      }
      if (parts[0] === "status" && req.method === "GET") {
        const st = await supervisor.status();
        return json(200, { ...st, uiOnly: instance.uiOnly, scheduler: { pending: instance.scheduler.pending(), running: instance.scheduler.running() } });
      }
      if (parts[0] === "messages" && req.method === "POST") {
        const b = await body();
        const result = await supervisor.humanSend(
          b.to ?? [],
          (b.type ?? "INFORM") as MessageType,
          b.payload ?? {},
          b.threadId,
        );
        return json(result.accepted ? 202 : 403, result);
      }
      if (parts[0] === "mission" && (parts[1] === "boot" || parts[1] === "start") && req.method === "POST") {
        if (instance.uiOnly) {
          // parked -> live: start the scheduler and run the config's startup
          // activation. After this the console behaves exactly like `mesh run`.
          instance.scheduler.start();
          instance.uiOnly = false;
          for (const id of config.startupActivate) {
            await supervisor.activateAgent(id, { kind: "startup", note: "mission started from console" });
          }
          return json(200, { ok: true, started: true, note: `scheduler live; startup agents activated: ${config.startupActivate.join(", ") || "(none configured)"}` });
        }
        const st = await supervisor.boot();
        return json(200, { ok: true, goal: st });
      }

      // ------------------------------------------------------- config designer
      if (parts[0] === "config" && req.method === "GET" && parts[1] === "vocabulary") {
        const { EVENT_TYPES, MESSAGE_TYPES, ARTIFACT_TYPES, TRUST_SOURCES } = await import("../../../packages/protocol/src/index");
        return json(200, { eventTypes: EVENT_TYPES, messageTypes: MESSAGE_TYPES, artifactTypes: ARTIFACT_TYPES, trustSources: TRUST_SOURCES, gateKinds: ["patch.merge", "patch.commit", "patch.approve", "implementation.completed", "release.accepted"] });
      }
      if (parts[0] === "config" && req.method === "GET" && parts.length === 1) {
        return json(200, { filePath: config.filePath, dir: config.dir, raw: config.raw });
      }
      if (parts[0] === "config" && parts[1] === "parse" && req.method === "POST") {
        const b = await body();
        try {
          const doc = typeof b.yaml === "string" ? parseYamlText(b.yaml) : b.config;
          const schema = (await import("../../../packages/protocol/src/index")).validateMeshConfig(doc);
          if (!schema.valid) return json(400, { errors: schema.errors.map((e) => `${e.path}: ${e.message}`) });
          return json(200, { config: doc });
        } catch (err) {
          if (err instanceof ConfigError) return json(400, { errors: err.errors });
          throw err;
        }
      }
      if (parts[0] === "config" && (parts[1] === "validate" || parts[1] === "save") && req.method === "POST") {
        const b = await body();
        try {
          let doc: unknown;
          if (typeof b.yaml === "string") {
            doc = JSON.parse(JSON.stringify(parseYamlText(b.yaml)));
          } else {
            doc = b.config ?? b.raw;
          }
          const baseDir = typeof b.dir === "string" && b.dir ? path.resolve(b.dir) : config.dir;
          const { resolved } = analyzeMeshConfig(doc, baseDir);
          const yamlText = stringifyMesh(doc);
          const warnings: string[] = [];
          let target: string | null = null;
          if (parts[1] === "save") {
            if (!b.path) return json(400, { valid: false, errors: ["save requires a path"] });
            target = path.resolve(String(b.path));
            if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, "mesh.yaml");
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, yamlText, "utf8");
            const dir = path.dirname(target);
            for (const id of Object.keys(resolved.raw.agents)) {
              const p = resolved.raw.agents[id].prompt;
              if (p && !fs.existsSync(path.resolve(dir, p))) {
                warnings.push(`agent '${id}' prompt file not found (relative to ${dir}): ${p}`);
              }
            }
          }
          return json(200, {
            valid: true,
            yaml: yamlText,
            savedTo: target,
            warnings,
            summary: {
              meshId: resolved.meshId,
              agents: resolved.agentOrder,
              services: resolved.agentOrder.filter((a) => resolved.agents[a].mode === "service"),
              startup: resolved.startupActivate,
              gates: Object.keys(resolved.transitionGates),
              missionTokens: resolved.budgets.mission.tokens,
              maxActiveAgents: resolved.scheduling.maxActiveAgents,
            },
          });
        } catch (err) {
          if (err instanceof ConfigError) {
            return json(400, { valid: false, errors: err.errors });
          }
          throw err;
        }
      }

      // ---------------------------------------------------------- dashboard
      if (req.method === "GET") {
        const dir = opts.dashboardDir;
        if (dir && fs.existsSync(dir)) {
          // "/" and "/dashboard" -> index.html; other paths map directly to a
          // file in the dashboard dir (app.js, styles.css, ...). This is the
          // last route, so it only catches what the API above did not.
          const rel = parts.length === 0 || parts[0] === "dashboard"
            ? (parts.length <= 1 ? "index.html" : parts.slice(1).join("/"))
            : parts.join("/");
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
            return;
          }
          if (parts.length === 0 || parts[0] === "dashboard") {
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end("<!doctype html><meta charset=utf-8><title>Agent Mesh</title><body style='font-family:monospace;background:#0d1117;color:#e6edf3;padding:24px'>Agent Mesh API online (no dashboard assets). See <a style='color:#58a6ff' href='/status'>/status</a> <a style='color:#58a6ff' href='/graph'>/graph</a> <a style='color:#58a6ff' href='/events'>/events</a></body>");
            return;
          }
        } else if (parts.length === 0) {
          return json(200, { mesh: config.meshId, docs: "see /status /metrics /graph /events" });
        }
      }

      json(404, { error: `no route: ${req.method} ${u.pathname}` });
    } catch (err) {
      json(500, { error: (err as Error).message });
    }
  }

  return server;
}

async function readContent(instance: MeshInstance, contentRef: string): Promise<string> {
  return instance.supervisor.deps.content.read(contentRef);
}

export async function startServer(options: BootstrapOptions & { port?: number; host?: string; dashboardDir?: string }): Promise<ServerHandle> {
  const instance = await bootstrapMesh(options);
  const dashboardDir =
    options.dashboardDir ??
    [
      path.resolve(process.cwd(), "apps", "mesh-dashboard", "public"),
      path.resolve(__dirname, "..", "..", "..", "..", "apps", "mesh-dashboard", "public"),
      path.resolve(__dirname, "..", "..", "mesh-dashboard", "public"),
    ].find((d) => fs.existsSync(d));
  const server = createHttpServer(instance, { dashboardDir });
  const port = options.port ?? instance.config.server.port;
  const host = options.host ?? instance.config.server.host;
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const actualPort = (server.address() as { port: number }).port;
  process.env.MESH_BUS_URL = `http://${host}:${actualPort}`;
  return {
    server,
    instance,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await instance.close();
    },
  };
}

export type { OpResult };
export { missionKey };
