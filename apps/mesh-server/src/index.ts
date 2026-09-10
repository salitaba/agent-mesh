import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { URL } from "url";
import type { MeshEvent, MeshMessage, MessageType, ArtifactStatus, Artifact } from "../../../packages/protocol/src/index";
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
import { FileSessionRegistry, ensureStateLayout, openSqliteIndex, SnapshotStore, archiveDir, archiveStateDir, acquireStateLock, type StateLockHandle } from "../../../packages/persistence/src/index";
import { LocalEventBus } from "../../../packages/core/src/event-bus";
import { systemClock } from "../../../packages/protocol/src/index";
import {
  buildMeshGraph,
  buildCostReport,
  buildGoalView,
  buildArtifactTimeline,
  buildTurnSteps,
  buildAgentActivity,
  buildAgentDetail,
  buildSchedulerView,
  eventTimeline,
  buildMetrics,
  SseHub,
} from "../../../packages/observability/src/index";
import { createMcpToolset } from "./mcp";
import { OpenCodeRuntimeAdapter, parseModelRef } from "../../../packages/runtime-opencode/src/index";
import { HttpRuntimeAdapter } from "../../../packages/runtime-http/src/index";
import { requireAuth, resolveActor } from "./auth";
import { paginateCompat } from "./pagination";
import { diffText } from "./diff";

export type ServerMode = "parked" | "live";

export interface BootstrapOptions {
  configPath: string;
  runtimeOverrides?: Record<string, StubRuntime>;
  useGit?: boolean;
  inMemory?: boolean;
  /** Serve dashboard/API/SSE but never start the scheduler or activate agents. */
  uiOnly?: boolean;
  /** Explicit successor of `uiOnly`. `parked` == uiOnly, `live` == autonomous. Takes precedence when set. */
  mode?: ServerMode;
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
  /**
   * Absolute path of the product checkout the dashboard, presets and runner
   * operate on. In git mode this is the `workspace/main` repo agents merge
   * into; without git it falls back to `workspace/main` if it exists (brownfield
   * migration), else the configured workspace root.
   */
  readonly productPath: string;
  supervisor: Supervisor;
  kernel: Kernel;
  store: EventStore;
  scheduler: Scheduler;
  stubRuntimes: Map<string, StubRuntime>;
  /**
   * The registered OpenCode adapter, exposed so the HTTP layer can serve the
   * designer's model catalogue from the same installation that will run turns.
   */
  opencodeRuntime: OpenCodeRuntimeAdapter;
  startedAt: number;
  /** Legacy mirror of `mode === "parked"`. Prefer `mode`. */
  readonly uiOnly: boolean;
  /**
   * DERIVED from `scheduler.isRunning()`, never assigned. It used to be a
   * standalone field, and `completeMission()` -> `shutdown()` stops the
   * scheduler without touching it: the mesh then reported `live` while nothing
   * could run, which made `goLive()` a no-op ("already live") on exactly the
   * mesh that needed restarting, and left the dashboard's parked-mode
   * affordances hidden. Deriving it makes that class of drift impossible.
   */
  readonly mode: ServerMode;
  /** Parked -> live. Idempotent: second call reports alreadyLive instead of re-booting. */
  goLive(note?: string): Promise<{ alreadyLive: boolean; activated: string[] }>;
  /** Live -> parked. Stops the scheduler and drains the queue. */
  park(): Promise<void>;
  /**
   * Wipe the mission back to tick zero and re-boot it from the config, in
   * place. Archives the state dir outside the agent workspace and deletes the
   * old run's git worktrees; always lands parked.
   */
  reset(opts?: { keepArtifacts?: boolean }): Promise<ResetReport>;
  close(): Promise<void>;
}

export interface ResetReport {
  ok: boolean;
  /** Absolute path of the archived previous state dir, null when there was none. */
  archivedTo: string | null;
  /** Absolute path of the archived product checkout (`workspace/main`), null when git mode is off or there was none. */
  productArchivedTo: string | null;
  /** Worktree directory names that were deleted (empty when git mode is off). */
  worktreesRemoved: string[];
  /** Goal id minted for the fresh mission. */
  goalId: string | null;
  mode: ServerMode;
}

export async function bootstrapMesh(options: BootstrapOptions): Promise<MeshInstance> {
  const config = resolveConfig(options.configPath);
  const layout = options.inMemory
    ? { events: config.stateDir, artifacts: config.stateDir, logs: config.stateDir }
    : ensureStateLayout(config.stateDir);
  // Single-writer guarantee. Only file mode takes it: an in-memory store owns
  // no files, so two in-memory meshes over one config are harmless (and every
  // test bed relies on that). Acquired before anything opens a handle into the
  // directory, and released in `close()`.
  const stateLock: StateLockHandle | undefined = options.inMemory
    ? undefined
    : acquireStateLock(config.stateDir, { projectId: config.meshId });
  const store: EventStore = options.inMemory
    ? new MemoryEventStore()
    : new JsonlEventStore(path.join(layout.logs, "events.jsonl"));
  const auditLog = (msg: string): void => {
    try {
      fs.appendFileSync(path.join(layout.logs, "projection-rejections.log"), `${new Date().toISOString()} ${msg}\n`, "utf8");
    } catch {
      /* audit never breaks the runtime */
    }
  };
  // Snapshot provider: persistence SnapshotStore adapted to the kernel's
  // minimal contract. Disabled for in-memory (tests) to keep them hermetic.
  const snapshotProvider = options.inMemory
    ? undefined
    : (() => {
        const snaps = new SnapshotStore(config.stateDir, config.meshId);
        return {
          write: (envelope: { meshId: string; throughSeq: number; data: Record<string, unknown[]> }): Promise<void> =>
            snaps.write({ meshId: envelope.meshId, throughSeq: envelope.throughSeq, data: envelope.data as never }),
          read: (): { meshId: string; throughSeq: number; data: Record<string, unknown[]> } | null => {
            const s = snaps.read();
            return s ? { meshId: s.meshId, throughSeq: s.throughSeq, data: s.data as unknown as Record<string, unknown[]> } : null;
          },
        };
      })();
  const kernel = new Kernel(
    store,
    systemClock,
    auditLog,
    { transitionGates: config.transitionGates, commitmentSemantic: config.bus.commitmentSemantic },
    snapshotProvider ? { provider: snapshotProvider, meshId: config.meshId, every: 200 } : undefined,
  );
  // EventBus decouples kernel fan-out from direct subscribe chains.
  const bus = new LocalEventBus(auditLog);
  kernel.subscribe((event) => {
    void bus.publish(event);
  });
  const budget = new BudgetManager(kernel);
  const policy = new PolicyEngine(config.policyRules);
  const content = options.inMemory
    ? new InMemoryArtifactStore()
    : new FileSystemArtifactStore(path.join(layout.artifacts));
  const workspace = options.useGit ? new GitWorkspace(config.workspacePath) : undefined;
  if (workspace && !options.inMemory) await workspace.ensureRepo();
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
  // Held by name as well as registered: the designer's model picker asks this
  // adapter what models the installation can actually reach.
  const opencodeAdapter = new OpenCodeRuntimeAdapter({
    executable: options.opencodeOptions?.executable,
    baseUrl: options.opencodeOptions?.baseUrl,
    spawnProcesses: options.opencodeOptions?.spawnProcesses,
    // Explicit bootstrap override wins; otherwise the mesh-wide default from
    // mesh.runtime.model. Agents with their own `model` still override both.
    model: options.opencodeOptions?.model ?? parseModelRef(config.defaultModel),
    mcpCommand: process.env.MESH_MCP_COMMAND ? JSON.parse(process.env.MESH_MCP_COMMAND) : undefined,
  });
  resolver.register("opencode", opencodeAdapter);
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

  // Two-phase wiring (no Proxy): supervisor starts with a no-op scheduler,
  // then the real scheduler is late-bound via setScheduler. The scheduler
  // receives the supervisor as its TurnRunner via constructor.
  const noopScheduler: import("../../../packages/core/src/ports").SchedulerPort = {
    handleEvent: async () => undefined,
    requestActivation: async () => false,
    notifyTurnFinished: () => undefined,
    notifyMailDelivered: () => undefined,
    pending: () => 0,
    running: () => 0,
    start: () => undefined,
    stop: async () => undefined,
    onIdle: () => undefined,
  };
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
    scheduler: noopScheduler,
    auditFile: options.inMemory ? undefined : path.join(layout.logs, "turn-audit.jsonl"),
    // JSONL sidecar for the in-memory turn ring: restores rich per-step data
    // (phases/op/timings/text/summary) after a restart — the event log only
    // reconstructs step shape, never this data.
    turnsFile: options.inMemory ? undefined : path.join(layout.logs, "turns.jsonl"),
  });
  const scheduler = new Scheduler(config, kernel.state, policy, supervisor, options.triageModel);
  supervisor.setScheduler(scheduler);

  bus.subscribe((event) => {
    scheduler.handleEvent(event).catch(() => undefined);
  });

  let indexRef: { flush(): void; close(): void } | undefined;
  // NOTE: `!options.inMemory` (not `=== false`) — every other branch above
  // treats an omitted flag as file mode, and the CLI never passes the flag.
  if (!options.inMemory) {
    const index = openSqliteIndex(path.join(layout.events, "events-index.sqlite"));
    indexRef = index;
    const events = await store.read();
    index.ingest(events);
    kernel.subscribe((e) => index.ingest([e]));
  }

  await kernel.replayFromStore();
  const resume = kernel.state.eventCount > 0;
  if (resume) {
    scheduler.rebuildInterestRegistry();
  }
  const mode: ServerMode = options.mode ?? (options.uiOnly ? "parked" : "live");
  await supervisor.boot({ resume, mode });

  const mainProductPath = path.join(config.workspacePath, "main");
  const instance: MeshInstance = {
    config,
    productPath: workspace
      ? workspace.mainPath
      : fs.existsSync(mainProductPath)
        ? mainProductPath
        : config.workspacePath,
    supervisor,
    kernel,
    store,
    scheduler,
    stubRuntimes,
    opencodeRuntime: opencodeAdapter,
    startedAt: Date.now(),
    // Both derived: see the MeshInstance declaration. `scheduler.isRunning()`
    // is the single source of truth for "can this mesh do work".
    get mode(): ServerMode {
      return scheduler.isRunning() ? "live" : "parked";
    },
    get uiOnly(): boolean {
      return !scheduler.isRunning();
    },
    async goLive(note = "mission started from console") {
      const self = this as MeshInstance;
      // Asks the scheduler, not a mode flag: a completed mission left the
      // scheduler stopped, and the old `self.mode === "live"` check made this
      // an "already live" no-op on precisely the mesh that could not run.
      if (self.scheduler.isRunning()) return { alreadyLive: true, activated: [] };
      self.scheduler.start();
      // The supervisor owns the stall watchdog; it must hear about going live
      // or the watchdog stays dead (its liveMode is a separate field) and a
      // live mission with everyone WAITING never gets nudged again.
      supervisor.setLiveMode(true);
      // Kickoff note carries the gap: agents whose memory says "mission
      // complete" (from a previous goal) otherwise treat the wake as noise.
      const goal = kernel.state.activeGoalId ? kernel.state.goals.get(kernel.state.activeGoalId) : undefined;
      const mandatory = goal?.acceptanceCriteria.filter((c) => c.mandatory) ?? [];
      const unmet = mandatory.filter((c) => c.status !== "EVIDENCED" && c.status !== "WAIVED");
      const fullNote = unmet.length > 0
        ? `${note} — ${unmet.length} of ${mandatory.length} mandatory criteria unmet (${unmet.slice(0, 3).map((c) => c.id).join(", ")}${unmet.length > 3 ? ", …" : ""}); see Mission acceptance criteria in your context`
        : note;
      const activated: string[] = [];
      for (const id of config.startupActivate) {
        const r = await supervisor.activateAgent(id, { kind: "startup", note: fullNote });
        if (r.queued) activated.push(id);
      }
      return { alreadyLive: false, activated };
    },
    async park() {
      await scheduler.stop();
      supervisor.setLiveMode(false);
      // `mode`/`uiOnly` follow `scheduler.isRunning()`; stopping IS parking.
    },
    async reset(resetOpts = {}) {
      const self = this as MeshInstance;
      // 1. Stop everything first. Order matters: the scheduler must not be
      //    able to start a turn while the log underneath it is being replaced.
      await self.park();
      await supervisor.resetMission();
      scheduler.resetMissionState();
      // 2. Worktrees are disposable mission scratch space: delete them (and
      //    their mesh/* branches) so the next run cannot read the previous
      //    run's files. Sessions are already stopped, so no process is using
      //    them.
      const worktreesRemoved = workspace ? await workspace.removeAllWorktrees() : [];
      // 3. The product checkout is mission scratch too: archive `workspace/main`
      //    outside the workspace, then re-init an empty repo so the Product
      //    page (and the next run) sees no files from the previous mission.
      let productArchivedTo: string | null = null;
      if (workspace && !options.inMemory) {
        productArchivedTo = archiveDir(workspace.mainPath, {
          archiveRoot: path.join(config.dir, ".mesh-backups", config.meshId),
        });
        workspace.removeMain();
        await workspace.ensureRepo();
      }
      // 4. Release the sqlite index handle before the directory moves; an open
      //    handle would keep writing into the archived copy.
      try {
        indexRef?.flush();
        indexRef?.close();
      } catch {
        /* best-effort index */
      }
      indexRef = undefined;
      // 5. Archive-then-recreate the state dir (atomic rename, recoverable).
      //    The archive lives outside `workspace/` so new agents cannot read
      //    it from their working tree.
      let archivedTo: string | null = null;
      if (!options.inMemory) {
        archivedTo = archiveStateDir(config.stateDir, {
          keepArtifacts: resetOpts.keepArtifacts,
          archiveRoot: path.join(config.dir, ".mesh-backups", config.meshId),
        }).archivedTo;
        // The rename moved the lock file into the archive with everything
        // else, leaving the recreated directory unclaimed. Rewrite it, or a
        // second process could open the state dir this one is still using.
        stateLock?.refresh();
      }
      // 6. Empty the log + projections + snapshot in place, preserving object
      //    identity so every route handler's closure stays valid.
      await kernel.resetToEmpty();
      // 7. Reopen the index against the fresh (empty) directory.
      if (!options.inMemory) {
        const index = openSqliteIndex(path.join(layout.events, "events-index.sqlite"));
        indexRef = index;
        kernel.subscribe((e) => index.ingest([e]));
      }
      // 8. Boot a brand-new mission from the config. resume:false forces a new
      //    goal rather than resurrecting the one we just deleted.
      await supervisor.boot({ resume: false, mode: "parked" });
      scheduler.rebuildInterestRegistry();
      // Step 1 parked the scheduler and `boot({mode:"parked"})` left it that
      // way, so the derived `mode`/`uiOnly` already read "parked".
      self.startedAt = Date.now();
      return { ok: true, archivedTo, productArchivedTo, worktreesRemoved, goalId: kernel.state.activeGoalId ?? null, mode: self.mode };
    },
    async close() {
      try {
        indexRef?.flush();
      } catch {
        /* best-effort index */
      }
      try {
        indexRef?.close();
      } catch {
        /* best-effort index */
      }
      // Shut the runtime down BEFORE snapshotting: shutdown emits its own
      // events (turns aborted, agents stopped), and a snapshot taken first
      // would exclude them and be replayed over on the next boot anyway.
      await supervisor.shutdown();
      try {
        await kernel.forceSnapshot();
      } catch {
        /* snapshots are an optimisation; the log remains authoritative */
      }
      try {
        await store.close?.();
      } catch {
        /* stores are best-effort on teardown */
      }
      // Last: the directory stays claimed until every handle into it is shut.
      try {
        stateLock?.release();
      } catch {
        /* teardown is best-effort */
      }
    },
  };
  return instance;
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
  // Live token fan-out: supervisor hook → out-of-band SSE frame. Late-bound
  // here because the hub is owned by the HTTP layer, not the supervisor.
  const prevHooks = supervisor.deps.hooks;
  (supervisor.deps as { hooks?: typeof prevHooks }).hooks = {
    ...prevHooks,
    onTurnToken: (turnId, agentId, delta) => {
      try {
        prevHooks?.onTurnToken?.(turnId, agentId, delta);
      } catch {
        /* prior hook must never break streaming */
      }
      hub.stream("turn.token", { type: "turn.token", turnId, agentId, delta, at: new Date().toISOString() });
    },
  };
  const mcp = createMcpToolset(supervisor);
  const startedAt = instance.startedAt;

  /**
   * Memoised model catalogue for GET /models. Resolving it can shell out to the
   * `opencode` CLI (~1s), and the designer refetches whenever the crew panel
   * mounts; the set of installed providers changes on the order of never.
   */
  let modelCatalogue: { at: number; value: Awaited<ReturnType<typeof instance.opencodeRuntime.listModels>> } | undefined;
  const MODEL_CATALOGUE_TTL_MS = 5 * 60 * 1000;

  // Event-loop lag radar: a 1s interval measures how late it actually fires.
  // Exposed on /health so "server doesn't respond" can be split into
  // "loop blocked" (lag spikes) vs "one endpoint slow" (slow-request log).
  let loopLagMs = 0;
  let loopLagMaxMs = 0;
  let lastTick = Date.now();
  const lagTimer = setInterval(() => {
    const now = Date.now();
    const lag = Math.max(0, now - lastTick - 1000);
    loopLagMs = lag;
    if (lag > loopLagMaxMs) loopLagMaxMs = lag;
    lastTick = now;
  }, 1000);
  (lagTimer as unknown as { unref?: () => void }).unref?.();

  const server = http.createServer((req, res) => {
    // Slow-request radar: anything (except the long-lived SSE stream) taking
    // >2s means the loop is blocked or an endpoint is doing too much work.
    // The URL + duration line in the server console names the culprit.
    const t0 = Date.now();
    const url = req.url ?? "/";
    if (!url.includes("/events/stream")) {
      res.on("finish", () => {
        const ms = Date.now() - t0;
        if (ms > 2000) console.error(`[mesh-server] slow ${req.method} ${url.split("?")[0]} — ${ms}ms`);
      });
    }
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
      // Compact serialization: pretty-printing roughly doubles large payloads
      // (timelines, traces) for zero client benefit — every consumer parses.
      res.end(JSON.stringify(body));
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

      // Operator auth: enforced when MESH_API_TOKEN is set. Public paths
      // (/health, dashboard assets) bypass; everything else needs Bearer.
      const auth = requireAuth(req, u, parts);
      if (!auth.ok) return json(401, { error: auth.error });
      const knownAgents = new Set(kernel.state.agents.keys());
      knownAgents.add(HUMAN_AGENT_ID);

      // ------------------------------------------------------------ health
      // Zero-work liveness probe: no store reads, no snapshots. If THIS hangs,
      // the event loop itself is blocked (vs a slow endpoint, which the
      // slow-request log above will name).
      if (parts[0] === "health" && req.method === "GET" && parts.length === 1) {
        return json(200, {
          ok: true,
          mode: instance.mode,
          uptimeMs: Date.now() - startedAt,
          eventCount: kernel.state.eventCount,
          lastSeq: kernel.state.lastEventSeq,
          sseClients: hub.clientCount,
          eventLoopLagMs: loopLagMs,
          eventLoopLagMaxMs: loopLagMaxMs,
        });
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
          // Enriched inspect: inbox content, recent steps, tasks/artifacts,
          // budgets, and recent events — all derived from the event-sourced
          // projections so the view stays replayable. Bounded store scan
          // (same budget as /steps) keeps this fast on large logs.
          const limitRaw = u.searchParams.get("limit");
          const stepLimit = limitRaw ? Math.min(Math.max(Number(limitRaw) || 10, 1), 30) : 10;
          let detail: ReturnType<typeof buildAgentDetail> = null;
          try {
            const events = await store.read({ tail: 800 });
            const fromLog = buildTurnSteps(events, stepLimit * 2);
            const live = supervisor.getRecentTurns(stepLimit * 2);
            const merged = new Map<string, (typeof fromLog)[number]>();
            for (const s of fromLog) merged.set(s.turnId, s);
            for (const t of live) {
              const prev = merged.get(t.turnId);
              merged.set(t.turnId, {
                turnId: t.turnId,
                agentId: t.agentId,
                reasonKind: t.reason.kind,
                reasonNote: t.reason.note ?? (t.reason as unknown as Record<string, unknown>).eventType as string | undefined,
                triggerEventType: (t.reason as unknown as Record<string, unknown>).eventType as string | undefined,
                startedAt: t.startedAt,
                endedAt: t.endedAt ?? prev?.endedAt,
                durationMs: t.durationMs ?? prev?.durationMs,
                status: t.status === "ok" ? "ok" : t.status === "waiting" ? "waiting" : t.status === "blocked" ? "blocked" : t.status === "failed" ? "failed" : prev?.status ?? "running",
                lifecycle: prev?.lifecycle ?? (t.status === "running" ? "THINKING" : "IDLE"),
                ops: prev?.ops ?? { messages: 0, artifacts: 0, tasks: 0, decisions: 0 },
                messageIds: prev?.messageIds ?? [],
                artifactIds: prev?.artifactIds ?? [],
                tokens: t.tokens ?? prev?.tokens ?? 0,
                model: t.model ?? prev?.model,
                error: t.error ?? prev?.error,
                seqStart: prev?.seqStart ?? 0,
                seqEnd: prev?.seqEnd ?? 0,
                eventCount: prev?.eventCount ?? 0,
                phases: t.phases ?? prev?.phases,
                attempt: t.attempt ?? prev?.attempt,
                streamChars: t.streamChars ?? prev?.streamChars,
                errorDetail: t.errorDetail ?? prev?.errorDetail,
                opTimings: t.opTimings ?? prev?.opTimings,
              });
            }
            const steps = [...merged.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
            const currentTurnId = live.find((t) => t.agentId === id && t.status === "running")?.turnId
              ?? steps.find((s) => s.agentId === id && s.status === "running")?.turnId;
            detail = buildAgentDetail(kernel.state, config, id, { steps, events, currentTurnId });
          } catch {
            /* fall through to minimal shape — detail must never 500 */
          }
          if (!detail) {
            return json(200, {
              definition: rec.definition,
              state: rec.state,
              unread: kernel.state.unread.get(id) ?? [],
              memory: [...(kernel.state.memory.get(id)?.values() ?? [])],
              session: kernel.state.sessionMap.get(id) ?? null,
            });
          }
          return json(200, detail);
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
          // ?version=N reads an older blob. Versions are immutable, so any
          // version in the history is still on disk under its own contentRef;
          // without this the console could only ever show the latest one.
          const want = u.searchParams.get("version");
          const target = want ? artifactVersion(instance, id, Number(want)) : a;
          if (!target) return json(404, { error: `no version ${want} of this artifact` });
          const text = await readContent(instance, target.contentRef).catch(() => "");
          res.writeHead(200, {
            "content-type": "text/plain; charset=utf-8",
            "x-artifact-version": String(target.version),
            "x-artifact-digest": String(target.digest ?? ""),
          });
          res.end(text);
          return;
        }
        // Diff two versions of the same artifact. Defaults to "previous
        // version -> this one", which is the question the console actually
        // asks when a reviewer opens a file that just changed.
        if (parts[2] === "diff" && req.method === "GET") {
          const history = artifactVersions(instance, id);
          const toN = Number(u.searchParams.get("to") ?? a.version);
          const fromParam = u.searchParams.get("from");
          const prev = history.filter((v) => v.version < toN).map((v) => v.version).pop();
          const fromN = fromParam ? Number(fromParam) : prev ?? toN;
          const from = artifactVersion(instance, id, fromN);
          const to = artifactVersion(instance, id, toN);
          if (!to) return json(404, { error: `no version ${toN} of this artifact` });
          const beforeText = from && fromN !== toN ? await readContent(instance, from.contentRef).catch(() => "") : "";
          const afterText = await readContent(instance, to.contentRef).catch(() => "");
          const d = diffText(beforeText, afterText);
          return json(200, {
            artifactId: id,
            from: from && fromN !== toN ? from.version : null,
            to: to.version,
            versions: history.map((v) => v.version),
            ...d,
          });
        }
        return json(200, a);
      }
      if (parts[0] === "artifacts" && req.method === "GET") {
        return json(200, paginateCompat([...kernel.state.artifacts.values()], u, 100));
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

      // --------------------------------------------------- raise a budget
      // Operator action from a budget escalation: event-sourced, replay-safe.
      // Body: { key, limit? , add? }. Does not resume — pair with an
      // escalation respond (the dashboard's "add & resume" does both).
      if (parts[0] === "budgets" && parts[1] === "raise" && req.method === "POST") {
        const b = await body();
        if (!b.key || typeof b.key !== "string") return json(400, { ok: false, reason: "provide a budget `key`" });
        const r = await supervisor.raiseBudget(b.key, { limit: b.limit, add: b.add, reason: b.reason });
        return json(r.ok ? 200 : 400, r);
      }

      // --------------------------------------------------------- approvals
      if (parts[0] === "approvals" && req.method === "GET") {
        return json(200, paginateCompat([...kernel.state.approvals.values()].flat(), u, 100));
      }
      if (parts[0] === "approvals" && req.method === "POST") {
        const b = await body();
        const kind = (b.kind ?? "approve") as "approve" | "reject" | "pass" | "block" | "veto" | "accept" | "merge";
        const actor = resolveActor(b.by ?? HUMAN_AGENT_ID, knownAgents);
        if (!actor.ok) return json(403, { ok: false, reason: actor.error });
        const by = actor.actor as string;
        // Audit the human-bypass path: operator acting as human skips policy checks.
        try {
          const auditFile = `${instance.config.stateDir}/logs/auth-audit.log`;
          fs.mkdirSync(`${instance.config.stateDir}/logs`, { recursive: true });
          fs.appendFileSync(auditFile, `${new Date().toISOString()} approvals by=${by} kind=${kind} subject=${b.subject ?? "release"}\n`, "utf8");
        } catch {
          /* audit never breaks the runtime */
        }
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
          return json(200, paginateCompat([...kernel.state.escalations.values()], u, 100));
        }
        if (req.method === "POST" && parts[1] && parts[2] === "respond") {
          const b = await body();
          const actor = resolveActor(b.by ?? HUMAN_AGENT_ID, knownAgents);
          if (!actor.ok) return json(403, { ok: false, reason: actor.error });
          try {
            const auditFile = `${instance.config.stateDir}/logs/auth-audit.log`;
            fs.mkdirSync(`${instance.config.stateDir}/logs`, { recursive: true });
            fs.appendFileSync(auditFile, `${new Date().toISOString()} escalation.respond id=${decodeURIComponent(parts[1])} by=${actor.actor}\n`, "utf8");
          } catch {
            /* audit never breaks the runtime */
          }
          const r = await supervisor.respondEscalation(decodeURIComponent(parts[1]), b.response ?? "acknowledged", actor.actor as string);
          return json(r.ok ? 200 : 400, r);
        }
        // Answer a stuck request as the operator AND resolve its escalation
        // in one call. Body: { text, response? }. The answer is sent with
        // `replyTo` set so the pending entry clears deterministically;
        // `response` (default: the answer text) is recorded on the
        // escalation, which resumes the mission.
        if (req.method === "POST" && parts[1] && parts[2] === "answer") {
          const b = await body();
          const actor = resolveActor(b.by ?? HUMAN_AGENT_ID, knownAgents);
          if (!actor.ok) return json(403, { ok: false, reason: actor.error });
          const text = typeof b.text === "string" ? b.text.trim() : "";
          if (!text) return json(400, { ok: false, reason: "provide answer `text`" });
          const a = await supervisor.answerStuckRequest(decodeURIComponent(parts[1]), text, actor.actor as string);
          if (!a.ok) return json(400, a);
          const r = await supervisor.respondEscalation(decodeURIComponent(parts[1]), typeof b.response === "string" && b.response.trim() ? b.response : text, actor.actor as string);
          return json(r.ok ? 200 : 400, { ...r, messageId: a.messageId });
        }
        // Drop a stuck request as the operator AND resolve its escalation
        // in one call. Body: { reason?, response? }. Deletes the pending
        // entry (no fabricated answer), wakes the asker, records the
        // rationale, and resumes the mission.
        if (req.method === "POST" && parts[1] && parts[2] === "drop") {
          const b = await body();
          const actor = resolveActor(b.by ?? HUMAN_AGENT_ID, knownAgents);
          if (!actor.ok) return json(403, { ok: false, reason: actor.error });
          const reason = typeof b.reason === "string" && b.reason.trim() ? b.reason : "dropped by operator";
          const d = await supervisor.dropStuckRequest(decodeURIComponent(parts[1]), reason, actor.actor as string);
          if (!d.ok) return json(400, d);
          const r = await supervisor.respondEscalation(decodeURIComponent(parts[1]), typeof b.response === "string" && b.response.trim() ? b.response : reason, actor.actor as string);
          return json(r.ok ? 200 : 400, r);
        }
      }

      // ------------------------------------------------------------ events
      // Realtime SSE: id-stamped, heartbeat-kept-alive, resumable via
      // Last-Event-ID / ?sinceSeq. Catch-up goes ONLY to the new client
      // (unicast) so existing subscribers never get a replay storm.
      if (parts[0] === "events" && parts[1] === "stream" && req.method === "GET") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "access-control-allow-origin": "*",
          "x-accel-buffering": "no",
        });
        const remove = hub.add(res);
        try {
          const lastIdHeader = req.headers["last-event-id"];
          const sinceRaw = u.searchParams.get("sinceSeq") ?? (Array.isArray(lastIdHeader) ? lastIdHeader[0] : lastIdHeader);
          const sinceSeq = sinceRaw !== null && sinceRaw !== undefined && String(sinceRaw) !== "" ? Number(String(sinceRaw)) : 0;
          const catchUp = await store.read({ sinceSeq: Number.isFinite(sinceSeq) ? sinceSeq : 0, limit: 200 });
          for (const e of catchUp) {
            if (sinceSeq && (e.seq ?? 0) <= sinceSeq) continue;
            hub.sendTo(res, e);
          }
        } catch {
          /* catch-up must never break the stream */
        }
        req.on("close", () => remove());
        return;
      }
      // Query-string counts fall back to the default when missing or garbage
      // (`?limit=abc` must not become an empty result).
      const tailCount = (raw: string | null, fallback: number): number => {
        if (raw === null) return fallback;
        const n = Math.floor(Number(raw));
        return Number.isFinite(n) ? Math.min(Math.max(n, 1), 1000) : fallback;
      };
      if (parts[0] === "events" && parts[1] === "raw" && req.method === "GET") {
        // Newest-first: `tail` (not head `limit`) so big logs return live data.
        const events = await store.read({
          goalId: u.searchParams.get("goalId") ?? undefined,
          types: u.searchParams.get("type") ? ([u.searchParams.get("type")] as MeshEvent["type"][]) : undefined,
          actorId: u.searchParams.get("actorId") ?? undefined,
          sinceSeq: u.searchParams.get("sinceSeq") ? Number(u.searchParams.get("sinceSeq")) : undefined,
          tail: tailCount(u.searchParams.get("limit"), 300),
        });
        return json(200, events);
      }
      if (parts[0] === "events" && req.method === "GET") {
        const events = await store.read({
          goalId: u.searchParams.get("goalId") ?? undefined,
          types: u.searchParams.get("type") ? ([u.searchParams.get("type")] as MeshEvent["type"][]) : undefined,
          actorId: u.searchParams.get("actorId") ?? undefined,
          sinceSeq: u.searchParams.get("sinceSeq") ? Number(u.searchParams.get("sinceSeq")) : undefined,
          tail: tailCount(u.searchParams.get("limit"), 300),
        });
        return json(200, eventTimeline(events, events.length));
      }

      // ------------------------------------- observability / control views
      // Every agent step as a trace: turn lifecycle + ops + tokens + timing.
      // Merges in-memory realtime turns (running right now) with log
      // reconstruction so “any step” is visible live and after replay.
      if (parts[0] === "steps" && req.method === "GET") {
        const limit = Math.min(Number(u.searchParams.get("limit") ?? 60) || 60, 200);
        // Scale the scan to the requested output (a turn spans a handful of
        // events; in-memory live turns cover the freshest ones anyway).
        const events = await store.read({ tail: Math.min(2000, Math.max(400, limit * 10)) });
        const fromLog = buildTurnSteps(events, limit * 2);
        const live = supervisor.getRecentTurns(limit);
        const merged = new Map<string, (typeof fromLog)[number]>();
        for (const s of fromLog) merged.set(s.turnId, s);
        for (const t of live) {
          const prev = merged.get(t.turnId);
          merged.set(t.turnId, {
            turnId: t.turnId,
            agentId: t.agentId,
            reasonKind: t.reason.kind,
            reasonNote: t.reason.note ?? (t.reason as unknown as Record<string, unknown>).eventType as string | undefined,
            triggerEventType: (t.reason as unknown as Record<string, unknown>).eventType as string | undefined,
            startedAt: t.startedAt,
            endedAt: t.endedAt ?? prev?.endedAt,
            durationMs: t.durationMs ?? prev?.durationMs,
            status: t.status === "ok" ? "ok" : t.status === "waiting" ? "waiting" : t.status === "blocked" ? "blocked" : t.status === "failed" ? "failed" : prev?.status ?? "running",
            lifecycle: prev?.lifecycle ?? (t.status === "running" ? "THINKING" : "IDLE"),
            ops: prev?.ops ?? { messages: 0, artifacts: 0, tasks: 0, decisions: 0 },
            messageIds: prev?.messageIds ?? [],
            artifactIds: prev?.artifactIds ?? [],
            tokens: t.tokens ?? prev?.tokens ?? 0,
            model: t.model ?? prev?.model,
            error: t.error ?? prev?.error,
            seqStart: prev?.seqStart ?? 0,
            seqEnd: prev?.seqEnd ?? 0,
            eventCount: prev?.eventCount ?? 0,
            // Sub-turn timing exists only in memory — the log has no marks —
            // so it rides along here or not at all.
            phases: t.phases ?? prev?.phases,
            attempt: t.attempt ?? prev?.attempt,
            streamChars: t.streamChars ?? prev?.streamChars,
            errorDetail: t.errorDetail ?? prev?.errorDetail,
            opTimings: t.opTimings ?? prev?.opTimings,
          });
        }
        const steps = [...merged.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
        return json(200, steps);
      }
      if (parts[0] === "turns" && parts.length === 1 && req.method === "GET") {
        return json(200, supervisor.getRecentTurns(Math.min(Number(u.searchParams.get("limit") ?? 60) || 60, 200)));
      }
      if (parts[0] === "turns" && parts[1] && req.method === "GET") {
        const id = decodeURIComponent(parts[1]);
        const turn = supervisor.getTurn(id);
        // Indexed trace lookup, merged with a bounded scan: in-turn operator
        // messages carry no correlationId, so the index alone would omit them.
        const byCorrelation = await store.read({ correlationId: id });
        const seen = new Set(byCorrelation.map((e) => e.id));
        const scanned = await store.read({ tail: 2000 });
        const related = [
          ...byCorrelation,
          ...scanned.filter(
            (e) =>
              !seen.has(e.id) &&
              ((e.payload as Record<string, unknown> | null)?.turnId === id ||
                e.causationId === id),
          ),
        ];
        if (!turn && related.length === 0) return json(404, { error: "turn not found" });
        return json(200, { turn: turn ?? null, events: related, timeline: eventTimeline(related, related.length) });
      }
      if (parts[0] === "scheduler" && req.method === "GET") {
        const queue = typeof (instance.scheduler as unknown as { queueSnapshot?: () => Array<{ agentId: string; priority: number; reason: { kind: string; note?: string } }> }).queueSnapshot === "function"
          ? (instance.scheduler as unknown as { queueSnapshot: () => Array<{ agentId: string; priority: number; reason: { kind: string; note?: string } }> }).queueSnapshot()
          : [];
        return json(200, buildSchedulerView(instance.scheduler.pending(), instance.scheduler.running(), queue, [], {
          total: instance.config.scheduling.maxTotalAgents,
          peer: instance.config.scheduling.maxActiveAgents,
          service: instance.config.scheduling.maxParallelServiceAgents,
        }));
      }
      if (parts[0] === "activity" && req.method === "GET") {
        const events = await store.read({ tail: 500 });
        return json(200, buildAgentActivity(kernel.state, buildTurnSteps(events, 60)));
      }
      if (parts[0] === "metrics" && req.method === "GET") {
        const recent = await store.read({ tail: 300 });
        return json(200, {
          metrics: buildMetrics(kernel.state, Date.now() - startedAt, recent),
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
        let queue: Array<{ agentId: string; priority: number; reason: { kind: string; note?: string } }> = [];
        try {
          const s = instance.scheduler as unknown as { queueSnapshot?: () => typeof queue };
          if (typeof s.queueSnapshot === "function") queue = s.queueSnapshot();
        } catch {
          /* scheduler view is best-effort */
        }
        return json(200, {
          ...st,
          // Surfaced for the console's destructive-action guard (reset asks the
          // operator to type this id back).
          meshId: config.meshId,
          mode: instance.mode,
          uiOnly: instance.uiOnly,
          scheduler: { pending: instance.scheduler.pending(), running: instance.scheduler.running(), queue },
          recentTurns: supervisor.getRecentTurns(10),
          commitments: supervisor.commitmentStats(),
          sseClients: hub.clientCount,
        });
      }
      if (parts[0] === "messages" && req.method === "POST") {
        const b = await body();
        const artifactRefs = Array.isArray(b.artifactRefs)
          ? b.artifactRefs.filter((r: unknown): r is { uri: string } => !!r && typeof (r as { uri?: unknown }).uri === "string").map((r: { uri: string }) => ({ uri: r.uri }))
          : undefined;
        const result = await supervisor.humanSend(
          b.to ?? [],
          (b.type ?? "INFORM") as MessageType,
          b.payload ?? {},
          b.threadId,
          {
            replyTo: typeof b.replyTo === "string" ? b.replyTo : undefined,
            artifactRefs,
            taskId: typeof b.taskId === "string" ? b.taskId : undefined,
          },
        );
        // In parked mode mail alone never wakes anyone (scheduler is stopped).
        // `wake:true` folds the old two-step "send then click wake" into one
        // operator action: send the message, then explicitly step each recipient.
        let wake: Record<string, { queued: boolean; blocked?: string }> | undefined;
        if (result.accepted && b.wake === true) {
          wake = {};
          for (const id of b.to ?? []) {
            if (id === "human" || id === "all") continue;
            wake[id] = await supervisor.activateAgent(id, { kind: "manual", note: "wake after human message via API" });
          }
        }
        return json(result.accepted ? 202 : 403, wake ? { ...result, wake } : result);
      }
      if (parts[0] === "mission" && (parts[1] === "boot" || parts[1] === "start") && req.method === "POST") {
        if (instance.mode === "parked") {
          // parked -> live: start the scheduler and run the config's startup
          // activation. After this the console behaves exactly like `mesh run`.
          const { alreadyLive, activated } = await instance.goLive();
          void alreadyLive;
          return json(200, { ok: true, started: true, mode: instance.mode, note: `scheduler live; startup agents activated: ${activated.join(", ") || config.startupActivate.join(", ") || "(none configured)"}` });
        }
        // Already live: idempotent no-op instead of re-booting a second goal.
        return json(200, { ok: true, started: false, mode: instance.mode, note: "already live" });
      }
      if (parts[0] === "mission" && parts[1] === "park" && req.method === "POST") {
        await instance.park();
        return json(200, { ok: true, mode: instance.mode, note: "scheduler parked; wake buttons still step single turns" });
      }
      // Non-destructive counterpart to reset: the mission is finished but the
      // operator rejected the result. Withdraws the completion verdict, puts
      // the mandatory criteria back to UNSATISFIED (otherwise the watchdog
      // re-completes within a second), revives agents frozen at COMPLETED and
      // restarts the scheduler. Every event and artifact is kept, so the next
      // round can cite the rejected attempt.
      if (parts[0] === "mission" && parts[1] === "reopen" && req.method === "POST") {
        const b = await body();
        const r = await supervisor.reopenGoal({
          reason: typeof b?.reason === "string" && b.reason.trim() ? b.reason.trim() : undefined,
          criteria: Array.isArray(b?.criteria) ? b.criteria.filter((c: unknown) => typeof c === "string") : undefined,
          activate: Array.isArray(b?.activate) ? b.activate.filter((c: unknown) => typeof c === "string") : undefined,
        });
        if (!r.ok) return json(400, r);
        // A reopened mission that stays parked would repeat the original
        // complaint: mail lands, nothing runs.
        if (instance.mode === "parked") await instance.goLive("mission reopened from console");
        return json(200, {
          ...r,
          mode: instance.mode,
          note: [
            `mission reopened; ${r.unsatisfied?.length ?? 0} criteria back to UNSATISFIED`,
            `revived: ${r.revived?.join(", ") || "(none)"}`,
            `running: ${r.activated?.join(", ") || "(none)"}`,
            ...(r.notRevived?.length ? [`STILL COMPLETED (unreachable): ${r.notRevived.join(", ")}`] : []),
            ...(r.refused?.length ? [`refused: ${r.refused.map((x) => `${x.agentId} (${x.reason})`).join(", ")}`] : []),
            ...(r.escalationsCleared ? ["open escalations answered by the reopen"] : []),
            ...(r.warning ? [r.warning] : []),
          ].join("; "),
        });
      }
      // Destructive: wipes the mission back to tick zero. The previous state
      // dir is archived (renamed, not deleted), so this stays recoverable —
      // but every agent session, event, budget and artifact link is gone from
      // the live mesh. `confirm: true` is mandatory so a stray POST from a
      // retry, a crawler, or a mistyped curl can never nuke a running mission.
      if (parts[0] === "mission" && parts[1] === "reset" && req.method === "POST") {
        const b = await body();
        if (b?.confirm !== true) {
          return json(400, { ok: false, error: "reset requires confirm:true — this wipes the whole mission" });
        }
        const report = await instance.reset({ keepArtifacts: b.keepArtifacts === true });
        const cleaned = report.worktreesRemoved.length ? `${report.worktreesRemoved.length} worktree(s) removed; ` : "";
        const product = report.productArchivedTo ? "product checkout archived; " : "";
        return json(200, {
          ...report,
          note: report.archivedTo
            ? `mission reset to zero; ${cleaned}${product}previous state archived outside the workspace at ${report.archivedTo}. Mesh is parked — press continue to start the new run.`
            : `mission reset to zero; ${cleaned}${product}mesh is parked — press continue to start the new run.`,
        });
      }
      // Operator raise of mission caps (event count / wall clock). Stored on
      // the goal via goal.budget_changed: replay-safe, no restart needed.
      // Does not resume — pair with an escalation respond.
      if (parts[0] === "mission" && parts[1] === "limits" && req.method === "POST") {
        const b = await body();
        const r = await supervisor.adjustGoalBudget({ maxEvents: b.maxEvents, wallClockMinutes: b.wallClockMinutes }, { reason: b.reason });
        return json(r.ok ? 200 : 400, r);
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

      // ----------------------------------------------------------- models
      // Model catalogue for the designer's per-role picker. Proxied from the
      // OpenCode installation rather than hardcoded, so the list matches the
      // providers this machine is actually credentialed for.
      //
      // Cached: resolving it may shell out to the `opencode` CLI, and the
      // designer refetches on every panel mount. `?refresh=1` forces a reload
      // after the operator adds a provider.
      if (parts[0] === "models" && req.method === "GET" && parts.length === 1) {
        const fresh = u.searchParams.get("refresh") === "1";
        const now = Date.now();
        if (fresh || !modelCatalogue || now - modelCatalogue.at > MODEL_CATALOGUE_TTL_MS) {
          const listed = await instance.opencodeRuntime.listModels();
          modelCatalogue = { at: now, value: listed };
        }
        const { models, default: fallback, error } = modelCatalogue.value;
        // 503, not 200-with-empty-list: an empty catalogue and a failed lookup
        // are different states, and the client renders a retry for the latter.
        if (error) return json(503, { models: [], error });
        return json(200, { models, default: fallback });
      }

      // --------------------------------------------------------- presets
      // The playground app fetches "../../presets/<name>.json" from
      // /playground/, which resolves to /presets/... — serve them read-only.
      const wsRoot = instance.productPath;
      if (parts[0] === "presets" && req.method === "GET") {
        const ab = resolveInside(path.join(wsRoot, "presets"), parts.slice(1).join("/"));
        if (!ab) return json(400, { error: "path escapes presets" });
        const st = await fs.promises.stat(ab).catch(() => null);
        if (!st || !st.isFile()) return json(404, { error: "no such preset" });
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" });
        res.end(await fs.promises.readFile(ab));
        return;
      }

      // ---------------------------------------------------------- workspace
      // Read-only window into the product workspace (the repo agents merged
      // into) plus a small whitelisted runner. Every "run" is a fixed script
      // from RUN_SCRIPTS — no free-form shell, no user input reaches argv.
      if (parts[0] === "workspace" && req.method === "GET") {
        if (parts[1] === "info" && parts.length === 2) {
          const git = gitFacts(wsRoot);
          return json(200, { path: wsRoot, ...git, scripts: Object.keys(RUN_SCRIPTS) });
        }
        if (parts[1] === "tree" && parts.length === 2) {
          const rel = String(u.searchParams.get("path") ?? "");
          const ab = resolveInside(wsRoot, rel);
          if (!ab) return json(400, { error: "path escapes workspace" });
          return json(200, await listTree(wsRoot, rel));
        }
        if (parts[1] === "file" && parts.length === 2) {
          const rel = String(u.searchParams.get("path") ?? "");
          const ab = resolveInside(wsRoot, rel);
          if (!ab) return json(400, { error: "path escapes workspace" });
          const st = await fs.promises.stat(ab).catch(() => null);
          if (!st || !st.isFile()) return json(404, { error: "no such file" });
          if (st.size > 2_000_000) return json(413, { error: "file too large to preview" });
          const clean = rel.replace(/\\/g, "/");
          const buf = await fs.promises.readFile(ab).catch(() => null);
          if (!buf) return json(415, { error: "unreadable" });
          const kind = classifyFile(clean, buf);
          // Binary is no longer a dead end: images come back as data URLs so
          // the console can actually render a diagram or screenshot an agent
          // produced, and other binaries report their size instead of a 415.
          if (kind === "image") {
            return json(200, {
              path: clean,
              kind,
              mime: mimeOf(clean),
              size: st.size,
              dataUrl: `data:${mimeOf(clean)};base64,${buf.toString("base64")}`,
              modifiedAt: st.mtimeMs,
            });
          }
          if (kind === "binary") {
            return json(200, { path: clean, kind, mime: mimeOf(clean), size: st.size, modifiedAt: st.mtimeMs });
          }
          return json(200, {
            path: clean,
            kind,
            mime: mimeOf(clean),
            size: st.size,
            modifiedAt: st.mtimeMs,
            content: buf.toString("utf8"),
          });
        }
        // Recursive name + content search. The tree view only walks one
        // directory at a time, which makes "where is the file that mentions
        // X" impossible from the console.
        if (parts[1] === "search" && parts.length === 2) {
          const q = String(u.searchParams.get("q") ?? "").trim();
          if (q.length < 2) return json(200, { query: q, results: [], truncated: false });
          const scope = String(u.searchParams.get("path") ?? "");
          if (!resolveInside(wsRoot, scope)) return json(400, { error: "path escapes workspace" });
          return json(200, await searchWorkspace(wsRoot, scope, q));
        }
        // Uncommitted changes for one file (or the whole workspace), so the
        // console can show what agents touched but have not merged yet.
        if (parts[1] === "diff" && parts.length === 2) {
          const rel = String(u.searchParams.get("path") ?? "");
          if (rel && !resolveInside(wsRoot, rel)) return json(400, { error: "path escapes workspace" });
          const head = gitShow(wsRoot, rel);
          const ab = rel ? resolveInside(wsRoot, rel) : null;
          const workingText = ab ? await fs.promises.readFile(ab, "utf8").catch(() => "") : "";
          const d = diffText(head, workingText);
          return json(200, { path: rel.replace(/\\/g, "/"), from: "HEAD", to: "working tree", ...d });
        }
        if (parts[1] === "changes" && parts.length === 2) {
          return json(200, gitChanges(wsRoot));
        }
        if (parts[1] === "run" && parts.length === 3) {
          return json(200, runStatus(parts[2]));
        }
      }
      if (parts[0] === "workspace" && parts[1] === "run" && parts.length === 2 && req.method === "POST") {
        const b = await body();
        const script = String(b.script ?? "");
        const def = RUN_SCRIPTS[script as keyof typeof RUN_SCRIPTS];
        if (!def) return json(400, { error: `unknown script (allowed: ${Object.keys(RUN_SCRIPTS).join(", ")})` });
        const run = startRun(wsRoot, script, def);
        if (!run) return json(409, { error: "a run is already in progress" });
        return json(201, { runId: run.id });
      }
      if (parts[0] === "workspace" && parts[1] === "run" && parts[2] === "kill" && req.method === "POST") {
        const id = parts.length === 4 ? parts[3] : "";
        const killed = killRun(id);
        return json(killed ? 200 : 404, killed ? { ok: true } : { error: "run not running" });
      }
      // --------------------------------------------------------- playground
      // The built product app (the simulator itself) is served read-only so
      // the console can embed it in an iframe. Requires `build` to have run.
      if (parts[0] === "playground" && req.method === "GET") {
        const pgDir = path.join(wsRoot, "apps", "playground");
        if (parts.length === 1) {
          const html = await fs.promises.readFile(path.join(pgDir, "index.html"), "utf8").catch(() => "");
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
          if (!html) {
            res.end("<!doctype html><meta charset=utf-8><title>Playground</title><body style='font-family:monospace;padding:24px'>No apps/playground/index.html in the workspace.</body>");
            return;
          }
          res.end(html);
          return;
        }
        const ab = resolveInside(pgDir, parts.slice(1).join("/"));
        if (!ab) return json(400, { error: "path escapes playground" });
        const st = await fs.promises.stat(ab).catch(() => null);
        if (!st || !st.isFile()) return json(404, { error: `missing build output (${parts.slice(1).join("/")}) — run "build playground" first` });
        const ext = path.extname(ab).toLowerCase();
        const type =
          ext === ".js" ? "text/javascript" :
          ext === ".css" ? "text/css" :
          ext === ".json" ? "application/json" :
          ext === ".html" ? "text/html" :
          ext === ".svg" ? "image/svg+xml" : "application/octet-stream";
        res.writeHead(200, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-cache" });
        res.end(await fs.promises.readFile(ab));
        return;
      }

      // ---------------------------------------------------------- dashboard
      if (req.method === "GET") {
        const dir = opts.dashboardDir;
        if (dir && fs.existsSync(dir)) {
          // "/" and "/dashboard" -> index.html; other paths map directly to a
          // file in the dashboard dir (Vite SPA bundle under assets/, ...).
          // This is the last route, so it only catches what the API above
          // did not.
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

  // Shutdown hook: `server.close()` waits for every open socket, and SSE
  // streams + keep-alive dashboard connections never end on their own — so a
  // plain close() hangs forever while the dashboard is open. Ending the hub
  // first lets close() finish; closeHttpServer() below enforces this order.
  // The lag timer MUST die even if close() itself never completes — otherwise
  // its ref'd interval keeps the process alive forever after teardown.
  const serverCleanup = (): void => {
    clearInterval(lagTimer);
    hub.close();
  };
  serverCleanups.set(server, serverCleanup);
  server.on("close", () => {
    serverCleanups.get(server)?.();
    serverCleanups.delete(server);
  });
  serverCleanups.set(server, serverCleanup);
  return server;
}

/**
 * Per-server teardown callbacks (SSE hub, lag timer, ...). closeHttpServer()
 * runs them BEFORE waiting on server.close() so a close() that never
 * completes cannot keep ref'd handles (and the process) alive.
 */
const serverCleanups = new WeakMap<http.Server, () => void>();

/**
 * Shut an http.Server down without hanging: end SSE streams first (they hold
 * their sockets forever), then close. Falls back to destroying all sockets
 * after `timeoutMs` so shutdown never blocks process exit / restart.
 */
export async function closeHttpServer(server: http.Server, timeoutMs = 5000): Promise<void> {
  try {
    serverCleanups.get(server)?.();
  } catch {
    /* teardown is best-effort */
  }
  try {
    server.closeIdleConnections?.();
  } catch {
    /* older typings */
  }
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve();
    };
    try {
      server.close(() => finish());
    } catch {
      finish();
      return;
    }
    const t = setTimeout(() => {
      try {
        server.closeAllConnections?.();
      } catch {
        /* ignore */
      }
      finish();
    }, timeoutMs);
    (t as unknown as { unref?: () => void }).unref?.();
  });
}

async function readContent(instance: MeshInstance, contentRef: string): Promise<string> {
  return instance.supervisor.deps.content.read(contentRef);
}

/** Full version chain of an artifact, oldest first. Falls back to the single
 * current record when no history was recorded (in-memory runs, imports). */
function artifactVersions(instance: MeshInstance, id: string): Artifact[] {
  const current = instance.kernel.state.artifacts.get(id);
  const history = instance.kernel.state.artifactHistory.get(id) as Artifact[] | undefined;
  const all = history && history.length ? [...history] : current ? [current] : [];
  if (current && !all.some((v) => v.version === current.version)) all.push(current);
  return all.sort((x, y) => x.version - y.version);
}

function artifactVersion(instance: MeshInstance, id: string, version: number): Artifact | undefined {
  if (!Number.isFinite(version)) return undefined;
  return artifactVersions(instance, id).find((v) => v.version === version);
}

/* ---------------------------------------------------------------------- *
 * Workspace window + whitelisted runner (see /workspace routes).
 * ---------------------------------------------------------------------- */

const RUN_SCRIPTS = {
  test: { cmd: "npm", args: ["test"], label: "run the full test suite (vitest)" },
  typecheck: { cmd: "npm", args: ["run", "typecheck"], label: "TypeScript typecheck" },
  build: { cmd: "npm", args: ["run", "build"], label: "build packages + playground (tsc -b)" },
  "headless-hairpin": {
    cmd: "node",
    args: ["tools/headless/dist/main.js", "--scenario", "demos/hairpin.scenario.json", "--out", ".mesh-state/run/hairpin-trace.json", "--ticks", "6600"],
    label: "run the hairpin demo scenario headless (6600 ticks)",
  },
} as const;

interface ActiveRun {
  id: string;
  proc: ChildProcess | null;
  log: string;
  startedAt: number;
  done: boolean;
  exitCode: number | null;
}

const runs = new Map<string, ActiveRun>();
let runSeq = 0;

function startRun(root: string, script: string, def: { cmd: string; args: readonly string[] }): ActiveRun | null {
  if ([...runs.values()].some((r) => !r.done)) return null;
  const id = `run-${++runSeq}-${Date.now().toString(36)}`;
  fs.mkdirSync(path.join(root, ".mesh-state", "run"), { recursive: true });
  const proc = spawn(def.cmd, [...def.args], { cwd: root, env: process.env, shell: process.platform === "win32" });
  const run: ActiveRun = { id, proc, log: `$ ${def.cmd} ${def.args.join(" ")}\n`, startedAt: Date.now(), done: false, exitCode: null };
  runs.set(id, run);
  const cap = (chunk: Buffer): void => {
    run.log += chunk.toString("utf8").replace(/\r/g, "");
    if (run.log.length > 60_000) run.log = run.log.slice(-60_000);
  };
  proc.stdout?.on("data", cap);
  proc.stderr?.on("data", cap);
  proc.on("error", (err) => {
    run.log += `\n[spawn error] ${err.message}\n`;
    run.done = true;
    run.exitCode = -1;
  });
  proc.on("exit", (code) => {
    run.done = true;
    run.exitCode = code;
  });
  return run;
}

function runStatus(id: string): Record<string, unknown> {
  const r = runs.get(id);
  return r
    ? { id: r.id, done: r.done, exitCode: r.exitCode, log: r.log, startedAt: r.startedAt }
    : { error: "unknown run" };
}

function killRun(id: string): boolean {
  const r = runs.get(id);
  if (!r || r.done || !r.proc) return false;
  try {
    r.proc.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  return true;
}

function resolveInside(root: string, rel: string): string | null {
  const ab = path.resolve(root, rel || ".");
  return ab === root || ab.startsWith(root + path.sep) ? ab : null;
}

const TREE_SKIP = new Set([".git", ".mesh-state", "node_modules", "dist"]);

async function listTree(root: string, relDir: string): Promise<Array<{ name: string; path: string; type: "dir" | "file"; size: number }>> {
  const out: Array<{ name: string; path: string; type: "dir" | "file"; size: number }> = [];
  const dir = path.join(root, relDir);
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) =>
    a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1,
  );
  for (const e of entries) {
    if (TREE_SKIP.has(e.name) || e.name.endsWith(".tsbuildinfo")) continue;
    let size = 0;
    if (e.isFile()) {
      size = (await fs.promises.stat(path.join(dir, e.name)).catch(() => null))?.size ?? 0;
    }
    out.push({
      name: e.name,
      path: (relDir ? `${relDir}/${e.name}` : e.name).replace(/\\/g, "/"),
      type: e.isDirectory() ? "dir" : "file",
      size,
    });
  }
  return out;
}

const IMAGE_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
};

const TEXT_MIME: Record<string, string> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".json": "application/json",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".js": "text/javascript",
  ".jsx": "text/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".sh": "text/x-sh",
  ".sql": "text/x-sql",
};

function mimeOf(rel: string): string {
  const ext = path.extname(rel).toLowerCase();
  return IMAGE_EXT[ext] ?? TEXT_MIME[ext] ?? "text/plain";
}

/** text | markdown | image | binary. Sniffs bytes rather than trusting the
 * extension, so an extensionless script still previews as text. */
function classifyFile(rel: string, buf: Buffer): "text" | "markdown" | "image" | "binary" {
  const ext = path.extname(rel).toLowerCase();
  if (ext === ".svg") return "image";
  if (IMAGE_EXT[ext]) return "image";
  const probe = buf.subarray(0, 4096);
  if (probe.includes(0)) return "binary";
  if (ext === ".md" || ext === ".markdown") return "markdown";
  return "text";
}

const SEARCH_MAX_RESULTS = 200;
const SEARCH_MAX_BYTES = 512_000;

interface SearchHit {
  path: string;
  line: number;
  text: string;
  kind: "name" | "content";
}

/** Recursive filename + content search under the workspace. Deliberately
 * plain-substring (case-insensitive): a regex from the browser is an easy way
 * to hang the server on catastrophic backtracking. */
async function searchWorkspace(
  root: string,
  scope: string,
  query: string,
): Promise<{ query: string; results: SearchHit[]; truncated: boolean }> {
  const needle = query.toLowerCase();
  const results: SearchHit[] = [];
  let truncated = false;
  const walkDir = async (rel: string, depth: number): Promise<void> => {
    if (truncated || depth > 12) return;
    let entries;
    try {
      entries = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (truncated) return;
      if (TREE_SKIP.has(e.name) || e.name.endsWith(".tsbuildinfo")) continue;
      const child = (rel ? `${rel}/${e.name}` : e.name).replace(/\\/g, "/");
      if (e.isDirectory()) {
        await walkDir(child, depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      if (child.toLowerCase().includes(needle)) {
        results.push({ path: child, line: 0, text: child, kind: "name" });
        if (results.length >= SEARCH_MAX_RESULTS) {
          truncated = true;
          return;
        }
      }
      const st = await fs.promises.stat(path.join(root, child)).catch(() => null);
      if (!st || st.size > SEARCH_MAX_BYTES) continue;
      const buf = await fs.promises.readFile(path.join(root, child)).catch(() => null);
      if (!buf || classifyFile(child, buf) === "image" || classifyFile(child, buf) === "binary") continue;
      const lines = buf.toString("utf8").split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].toLowerCase().includes(needle)) continue;
        results.push({ path: child, line: i + 1, text: lines[i].slice(0, 300), kind: "content" });
        if (results.length >= SEARCH_MAX_RESULTS) {
          truncated = true;
          return;
        }
        break; // one hit per file keeps the result list scannable
      }
    }
  };
  await walkDir(scope.replace(/\\/g, "/"), 0);
  return { query, results, truncated };
}

/** Contents of a path at HEAD (empty string when the file is new). */
function gitShow(root: string, rel: string): string {
  if (!rel) return "";
  try {
    const r = spawnSync("git", ["show", `HEAD:${rel}`], { cwd: root, encoding: "utf8", timeout: 5000 });
    return r.status === 0 ? r.stdout : "";
  } catch {
    return "";
  }
}

/** Working-tree changes as {path, status} — what agents touched since HEAD. */
function gitChanges(root: string): Array<{ path: string; status: string }> {
  try {
    const r = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8", timeout: 5000 });
    if (r.status !== 0) return [];
    return r.stdout
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => ({ status: l.slice(0, 2).trim() || "?", path: l.slice(3).trim() }));
  } catch {
    return [];
  }
}

function gitFacts(root: string): Record<string, string> {
  const sh = (cmd: string, ...args: string[]): string => {
    try {
      return spawnSync(cmd, args, { cwd: root, encoding: "utf8", timeout: 4000 }).stdout.trim();
    } catch {
      return "";
    }
  };
  return {
    gitBranch: sh("git", "rev-parse", "--abbrev-ref", "HEAD"),
    gitHead: sh("git", "rev-parse", "--short", "HEAD"),
    gitClean: String(sh("git", "status", "--porcelain").length === 0),
    gitLog: sh("git", "log", "--oneline", "-5"),
  };
}

export async function startServer(options: BootstrapOptions & { port?: number; host?: string; dashboardDir?: string }): Promise<ServerHandle> {
  const instance = await bootstrapMesh(options);
  // Vite SPA build (npm run build:ui emits apps/mesh-dashboard/dist).
  const dashboardDir =
    options.dashboardDir ??
    [
      path.resolve(process.cwd(), "apps", "mesh-dashboard", "dist"),
      path.resolve(__dirname, "..", "..", "..", "..", "apps", "mesh-dashboard", "dist"),
      path.resolve(__dirname, "..", "..", "mesh-dashboard", "dist"),
    ].find((d) => fs.existsSync(d));
  const server = createHttpServer(instance, { dashboardDir });
  const port = options.port ?? instance.config.server.port;
  const host = options.host ?? instance.config.server.host;
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error & { code?: string }): void => {
      if (err?.code === "EADDRINUSE") {
        reject(
          new Error(
            `port ${port} is already in use — another mesh server (possibly a lingering one from Ctrl-C) still holds it. ` +
              `Stop it first (or pick another --port).`,
          ),
        );
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
  process.env.MESH_BUS_URL = `http://${host}:${actualPort}`;
  return {
    server,
    instance,
    port: actualPort,
    url: `http://${host}:${actualPort}`,
    async close() {
      await closeHttpServer(server);
      await instance.close();
    },
  };
}

export type { OpResult };
export { missionKey };
