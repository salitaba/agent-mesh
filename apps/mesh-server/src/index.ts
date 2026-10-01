import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { execFile, spawn, type ChildProcess } from "child_process";
import { randomBytes, randomUUID } from "crypto";
import { URL } from "url";
import { promisify } from "util";
import type { MeshEvent, MeshMessage, MessageType, ArtifactStatus, Artifact, DesignerRuntime, DesignerPromptOptions, StagedMutation, StagedProposal, SessionRotated, MuteSuspected } from "../../../packages/protocol/src/index";
import { resolveConfig, loadMeshFile, resolveUseGit, type ResolvedMeshConfig, analyzeMeshConfig, stringifyMesh, ConfigError, materializeRolePrompts } from "../../../packages/config/src/index";
import { parse as parseYaml } from "yaml";
const parseYamlText = (text: string): unknown => parseYaml(text);
import { Kernel, Supervisor, BudgetManager, HUMAN_AGENT_ID, WORK_TURN_TIMEOUT_MULTIPLE, generateAcceptanceCriteria, projectionConfigFor, readableMailDepth, resolveUnread, secretsEqual, type CriteriaGeneratorPort, type OpResult } from "../../../packages/core/src/index";
import { missionKey } from "../../../packages/core/src/budgets";
import { JsonlEventStore, MemoryEventStore, type EventStore } from "../../../packages/event-store/src/index";
import { PolicyEngine, validateTransitionGates } from "../../../packages/policy-engine/src/index";
import { Scheduler, type TriageModel } from "../../../packages/scheduler/src/index";
import { StubRuntime, StaticRuntimeResolver } from "../../../packages/agent-runtime/src/index";
import { FileSystemArtifactStore, GitWorkspace, InMemoryArtifactStore } from "../../../packages/artifact-store/src/index";
import {
  FileSessionRegistry,
  ensureStateLayout,
  openSqliteIndex,
  SnapshotStore,
  archiveDir,
  archiveStateDir,
  archiveStamp,
  copyDir,
  listArchives,
  meshArchiveRoot,
  readLogTailSeq,
  restoreStateDir,
  acquireStateLock,
  type MeshArchiveEntry,
  type StateLockHandle,
} from "../../../packages/persistence/src/index";
import { LocalEventBus } from "../../../packages/core/src/event-bus";
import { systemClock, HOST_LIMITER_RAISER, HOST_SPEND_CEILING_REASON, type Clock, type GitMode } from "../../../packages/protocol/src/index";
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
import { applyStagedProposal, matchesMeshId } from "./staging";
import { configDrift } from "./config-drift";
import { DesignerTurnBuffer, createDesignerStagingToolset } from "./designer-staging-mcp";
import { fillTurnSteps, namesTurn, recentTurnSteps, turnEvents } from "./steps-view";
import { HttpRuntimeAdapter } from "../../../packages/runtime-http/src/index";
import { ClaudeRuntimeAdapter, describeHostLeaks, describeIsolation, describeToolPermissions, toClaudeModelId } from "../../../packages/runtime-claude/src/index";
import { callerKind, getApiToken, handleAuthRoute, requireAuth, resolveActor } from "./auth";
import { SessionStore } from "./sessions";
import { PREVIEW_PAGE_DIR, PREVIEW_PRESETS_DIR, PREVIEW_PREFIX, PreviewCapabilities } from "./preview";
import { LicenseProvider, enforceOrWarn, licenseView } from "./license";
import { configuredPrices, licenseMetrics, parseUsageQuery, usageAnswer } from "./commercial";
import { serverVersion } from "./version";
import { checkFeature, checkSeats } from "../../../packages/licensing/src/index";
import { PROMETHEUS_CONTENT_TYPE, renderPrometheus, type PromMetric } from "../../../packages/observability/src/index";
import { meshHome } from "../../../packages/projects/src/index";
import { FailureLimiter, PayloadTooLargeError, applySecurityHeaders, assertSafeListen, auditField, clientKey, guardRequest, maxBodyBytes, maxSseClients, readBody, respondTooLarge, selfConnectHost } from "./web-security";
import { paginateCompat } from "./pagination";
import { diffText } from "./diff";

export type ServerMode = "parked" | "live";

/** A verified seat's tool call can carry a long message or file content; 8 MiB is generous and still a bound. */
const MCP_MAX_BODY_BYTES = 8 * 1024 * 1024;
/** A token that failed verification is read only far enough to answer in JSON-RPC, which needs the request's `id`. */
const MCP_UNVERIFIED_BODY_BYTES = 64 * 1024;

/**
 * The one sentence an operator sees when the mission is parked while its goal
 * is ACTIVE — on `/status` (so the console's banner can render it), on
 * `POST /goals/:id/resume`, and on the host's own audit line.
 *
 * Held as one string on purpose. This state hides itself: the goal reads
 * ACTIVE, the console shows a running mission, and the scheduler is stopped, so
 * a parked mesh spent 14.8 hours doing nothing while its operator believed it
 * was working. The wording that ends that has to be identical everywhere it
 * appears, or the banner and the resume response become two accounts of one
 * state and the operator has to reconcile them.
 *
 * The host process writes the same sentence from its own copy
 * (`PARKED_MISSION_NOTICE` in `./host`) rather than importing this one: the
 * host must not load this whole module — core, scheduler, the Claude SDK — just
 * to print a line. A test asserts the two carry the same call to action.
 */
export const PARKED_MISSION_NOTICE =
  "the mission is not running: the scheduler is parked — POST /mission/start (the dashboard's Start control) makes it live";

/** True for the state that hides itself: parked, with an ACTIVE goal. */
function isParkedNoticeState(mode: ServerMode, goalStatus: string | undefined): boolean {
  return mode === "parked" && goalStatus === "ACTIVE";
}

export interface BootstrapOptions {
  configPath: string;
  runtimeOverrides?: Record<string, StubRuntime>;
  /**
   * Operator's git preference, before this project's own config is consulted.
   * "auto" (or absent) defers to `mesh.workspace.git`, whose default is ON.
   */
  gitMode?: GitMode;
  /**
   * Legacy boolean form of `gitMode`, kept because tests and older callers
   * pass it. Read as a hard "on"/"off"; `gitMode` wins when both are set.
   */
  useGit?: boolean;
  inMemory?: boolean;
  /** Serve dashboard/API/SSE but never start the scheduler or activate agents. */
  uiOnly?: boolean;
  /** Explicit successor of `uiOnly`. `parked` == uiOnly, `live` == autonomous. Takes precedence when set. */
  mode?: ServerMode;
  triageModel?: TriageModel;
  httpRuntimeUrl?: string;
  /**
   * Overrides the designer-backed criteria generator. Tests inject a stub here
   * to exercise the boot path without a model; production leaves it unset and
   * gets the designer adapter.
   */
  criteriaGenerator?: CriteriaGeneratorPort;
  /**
   * The mesh's clock: event timestamps, and every time read and timer in the
   * supervisor and scheduler. Tests pass a manual clock (one that also
   * implements `Timers`) to advance watchdogs deterministically; production
   * leaves it unset and gets the wall clock and the real event loop.
   */
  clock?: Clock;
  /**
   * Runs after the mesh instance exists and before the initial activation — the
   * one seam in a live boot where the caller can still stand something up that
   * the first wake depends on.
   *
   * `startServer` uses it to bind the HTTP port (and so to settle
   * `MESH_BUS_URL`) before `supervisor.boot` wakes anyone: the seats' MCP bridge
   * is spawned against this server's URL, which does not exist until `listen()`
   * has run, and a child asks for port 0 so the configured fallback is not even
   * the right port. Without this seam the first seat of every live boot — and of
   * every child restart — spawns a bridge at a URL nothing answers yet.
   */
  beforeInitialActivation?: (instance: MeshInstance) => Promise<void>;
  /**
   * Bridge readiness, forwarded to `supervisor.boot` (which holds the first
   * live wake on it). `startServer` supplies one that resolves when its own
   * listener is up; a caller that embeds the mesh with no bridge passes nothing
   * and boot proceeds immediately.
   */
  bridgeReady?: (() => Promise<void>) | Promise<void>;
  /** `supervisor.boot`'s bound on that wait; see `BRIDGE_READY_TIMEOUT_MS`. */
  bridgeReadyTimeoutMs?: number;
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
  /**
   * Resolved artifact-storage mode — the answer after flag, config and default
   * have been reconciled. Exposed because "why is there no workspace?" is
   * otherwise unanswerable from the dashboard, and an empty `deps.workspace`
   * silently refuses every `mesh_commit`.
   */
  readonly useGit: boolean;
  /**
   * True when this mesh owns no files. Exposed for the same reason as `useGit`:
   * the HTTP layer has to refuse a file-shaped operation (mission restore)
   * with a sentence, not by reaching into bootstrap's options.
   */
  readonly inMemory: boolean;
  supervisor: Supervisor;
  kernel: Kernel;
  store: EventStore;
  scheduler: Scheduler;
  stubRuntimes: Map<string, StubRuntime>;
  /**
   * Backend for the designer's own conversation, exposed so the HTTP layer can
   * serve its model catalogue from the same installation that will run turns.
   *
   * Typed as the port, not the adapter: these five calls are the only reason
   * this file used to depend on a concrete runtime, which made the designer
   * unreachable on any mesh not backed by opencode.
   */
  designerRuntime: DesignerRuntime;
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
  /**
   * Parked -> live. Idempotent: second call reports alreadyLive instead of
   * re-booting. `refused` carries the startup seats the scheduler would not
   * queue and why; without it a boot where every seat was blocked is
   * indistinguishable from one where none were configured.
   */
  goLive(note?: string): Promise<{
    alreadyLive: boolean;
    activated: string[];
    refused: Array<{ agentId: string; reason: string }>;
  }>;
  /**
   * The last boot's outcome, or null before the first one in this process.
   *
   * `refused` is otherwise reachable only on the `goLive()` response, which the
   * console throws away on the next refresh — and a refresh is exactly what a
   * stuck operator does before going looking for why nothing is running. Kept
   * in memory on purpose: it describes *this* process's last boot, and after a
   * restart the honest answer comes from booting again, not from a stale record.
   */
  readonly lastBoot: {
    at: string;
    activated: string[];
    refused: Array<{ agentId: string; reason: string }>;
  } | null;
  /** Live -> parked. Stops the scheduler and drains the queue. */
  park(): Promise<void>;
  /**
   * Wipe the mission back to tick zero and re-boot it from the config, in
   * place. Archives the state dir outside the agent workspace and clears the
   * old run's product tree (git: `workspace/main`; non-git: the configured
   * workspace root, state dir excluded); always lands parked.
   */
  reset(opts?: ResetOptions): Promise<ResetReport>;
  /**
   * Replace the live mission with a state archive left behind by an earlier
   * reset. The mesh is left parked on the restored mission, so the operator
   * decides when it resumes.
   */
  restore(archivePath: string, opts?: RestoreOptions): Promise<RestoreReport>;
  /** Every archive this mesh has written, newest first. */
  backups(): MeshArchiveEntry[];
  close(): Promise<void>;
}

export interface ResetOptions {
  /** Carry produced documents over into the fresh state dir. */
  keepArtifacts?: boolean;
  /**
   * Copy the agent worktrees aside before deleting them. On by default; the
   * escape hatch exists because a worktree can be large and reset is called
   * from paths (tests, scripted teardown) that do not want the I/O.
   */
  archiveWorktrees?: boolean;
}

/**
 * Raised when a reset is asked for while one is already running. Carries a
 * `code` instead of relying on `instanceof` so `staging.ts` can recognise it
 * without importing this module at runtime — the graph already runs
 * index -> staging, and the reverse edge would close a cycle.
 */
export class ResetInProgressError extends Error {
  readonly code = "RESET_IN_PROGRESS";
  constructor() {
    super("a mission reset is already in progress");
    this.name = "ResetInProgressError";
  }
}

export interface ResetReport {
  ok: boolean;
  /** Absolute path of the archived previous state dir, null when there was none. */
  archivedTo: string | null;
  /** Absolute path of the archived product tree (`workspace/main` in git mode, the workspace root otherwise), null when off/none. */
  productArchivedTo: string | null;
  /** Worktree directory names that were deleted (empty when git mode is off). */
  worktreesRemoved: string[];
  /**
   * Absolute path of the archived copy of the worktrees, null when git mode is
   * off, there were no worktrees, or `archiveWorktrees` was false. This holds
   * the uncommitted work that `worktreesRemoved` deleted — but note its `.git`
   * files point into a repo that is re-initialized below, so only the plain
   * files are readable from here. The commits are in `worktreeBundleTo`.
   */
  worktreesArchivedTo: string | null;
  /**
   * Absolute path of the git bundle holding every `mesh/*` branch as it was
   * immediately before `removeAllWorktrees` deleted them, null when there was
   * nothing to bundle. Restore a commit with:
   * `git fetch <bundle> 'refs/heads/*:refs/heads/restored/*'`.
   */
  worktreeBundleTo: string | null;
  /**
   * Absolute path of a JSON record of what each worktree still had uncommitted
   * when the reset deleted it, null when nothing was uncommitted or git mode is
   * off.
   *
   * Written even when `archiveWorktrees` is false — that flag is precisely the
   * path that destroys the files, so it is the one that most needs to leave a
   * number behind. A run measured on 2026-09-24 ended with 1,847 lines of source
   * and tests uncommitted across one seat's worktree, and no reset report said
   * so; the files were archived, but nothing recorded that they were never part
   * of the product.
   */
  uncommittedManifestTo: string | null;
  /** Uncommitted file count per seat at reset time, for the summary line. */
  uncommittedByAgent: Record<string, number>;
  /**
   * Absolute path of the archived stray entries found at the workspace root in
   * git mode, null when there were none. Git mode owns only `main/` and
   * `worktrees/` there, so anything else is a file no repository tracks —
   * archiving it is what makes the reset actually return to zero, instead of
   * leaving a layout the next boot refuses.
   */
  strayRootArchivedTo: string | null;
  /** Goal id minted for the fresh mission. */
  goalId: string | null;
  mode: ServerMode;
}

export interface RestoreOptions {
  /**
   * Carry `sessions.json` over from the archive. Off by default: the session
   * ids in it belong to runtimes on the other side of a reset, and a restored
   * session that no longer exists fails mid-turn rather than at boot.
   */
  keepSessions?: boolean;
}

export interface RestoreReport {
  ok: boolean;
  /** The archive directory the state was read from. Left untouched. */
  restoredFrom: string;
  /** Stamp shared by every archive of the reset that produced it. */
  stamp: string;
  /** Where the pre-restore state was moved, so this restore is itself undoable. */
  previousArchivedTo: string | null;
  /** Events in the restored log. */
  events: number;
  /** Goal the restored mission is running under, null when it has none. */
  goalId: string | null;
  /** True when the archive's snapshot was newer than its log and was dropped. */
  snapshotDropped: boolean;
  /** True when `sessions.json` was left behind rather than restored. */
  sessionsDropped: boolean;
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
          // `version` travels through: the kernel refuses a layout it does not
          // read, and it can only do that if the adapter does not drop it.
          read: (): { version: number; meshId: string; throughSeq: number; data: Record<string, unknown[]> } | null => {
            const s = snaps.read();
            return s ? { version: s.version, meshId: s.meshId, throughSeq: s.throughSeq, data: s.data as unknown as Record<string, unknown[]> } : null;
          },
        };
      })();
  const kernel = new Kernel(
    store,
    options.clock ?? systemClock,
    auditLog,
    projectionConfigFor(config),
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
  // The one place a project's git mode is decided. Everything upstream — argv,
  // the host, the child's environment — carries the operator's intent verbatim
  // so that "no preference" stays distinguishable from "explicitly off" until
  // here, where the project's own config is finally in scope to break the tie.
  const gitMode: GitMode = options.gitMode ?? (options.useGit === undefined ? "auto" : options.useGit ? "on" : "off");
  // `!inMemory` is not a preference, it is a constraint: an in-memory boot has
  // no workspace on disk, so a GitWorkspace could only ever be a handle to a
  // repo that was never created (ensureRepo below is skipped for in-memory).
  // Leaving it defined would flip `deps.workspace` from undefined to an
  // uninitialised store and quietly move every commit onto the git path.
  const useGit = !options.inMemory && resolveUseGit(gitMode, config.workspaceGit);
  // Before the GitWorkspace is constructed, because constructing one against an
  // incoherent root is what mints the second repo. Projects predating the
  // `git:` key are the population that reaches here with a workspace already
  // full of product files: git moves the checkout into main/ without moving
  // anything already there, and the stderr warning this replaced was not enough
  // to stop a mission spending its budget on uncitable commits.
  if (!options.inMemory) await assertWorkspaceCoherent(config.workspacePath, useGit, config.stateDir);
  const workspace = useGit ? new GitWorkspace(config.workspacePath) : undefined;
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
  const meshDefaultModel = toClaudeModelId(config.defaultModel);
  const claudeDefaultModel = meshDefaultModel?.startsWith("claude") ? meshDefaultModel : undefined;
  // The agent backend. Registered unconditionally: the adapter spawns nothing
  // until an agent is actually started, so an installation that runs only stub
  // or http seats pays nothing for its presence.
  const claudeAdapter = new ClaudeRuntimeAdapter({
      // A backstop past the supervisor's CEILING, not its base. The supervisor
      // owns the turn deadline, including the task and activity extensions that
      // carry a working turn up to base x WORK_TURN_TIMEOUT_MULTIPLE, and stops
      // the turn itself; this timer only catches a supervisor that failed to.
      // At base + 30s it fired first and killed every extended turn anyway.
      turnTimeoutMs: config.scheduling.turnTimeoutMs * WORK_TURN_TIMEOUT_MULTIPLE + 30000,
      // Only inherit the mesh-wide default when it actually names a Claude
      // model. Older configs wrote `mesh.runtime.model` for opencode
      // ("openrouter/anthropic/..."), and forwarding one of those would hand
      // the SDK an id it cannot resolve — a confusing hard failure on turn 1.
      // Per-agent `model` still wins and is passed through verbatim.
      model: claudeDefaultModel,
      // `mesh.runtime.context_window`: the window rotation measures against for
      // a model the adapter cannot place. Unlike `model`, never gated on the id
      // being a Claude one — a proxied non-Claude model (the 2026-09-25 run's
      // `deepseek-v4.1-flash`) is exactly the case it exists for.
      contextWindow: config.defaultContextWindow,
      // `mesh.runtime.stale_after_ms`: how long a session may idle before the
      // adapter rotates it, assuming the prompt cache died in the gap. Unset
      // keeps the adapter's own 10 minutes (right for Anthropic's cache TTL).
      staleAfterMs: config.defaultStaleAfterMs,
      // So a restart that resumes a transcript knows how big it is.
      stateDir: options.inMemory ? undefined : config.stateDir,
      // `mesh.runtime.isolate_host`: no inherited Claude settings, no outer session's env.
      isolateHost: config.isolateHost === true,
      onNotice: (n) => auditLog(`claude runtime: ${n.message}`),
      mcpCommand: process.env.MESH_MCP_COMMAND ? JSON.parse(process.env.MESH_MCP_COMMAND) : undefined,
      // Rotation is the one moment a seat loses everything it was holding in
      // its head. It used to be invisible: this hook existed and nothing was
      // ever passed for it, so the adapter dropped a seat's entire working
      // memory without the kernel, the log, or the operator ever hearing.
      //
      // Emitted fire-and-forget on purpose. Rotation happens inside a turn the
      // agent is waiting on, and blocking it on a kernel append would put the
      // event store's write chain on the critical path of every rotation.
      // A seat that cannot reach the bus is worse than a dead one: it looks
      // healthy, consumes its turns, and produces text nobody can act on.
      // `alert` severity, because the mission cannot progress through it and
      // no amount of waiting will change that.
      onMuteSuspected: (info) => {
        void kernel
          .emit(
            "agent.mute_suspected",
            {
              agentId: info.agentId,
              sessionId: info.sdkSessionId,
              servers: info.servers,
              meshBridgeAttached: info.meshBridgeAttached,
            } satisfies MuteSuspected,
            { actorId: info.agentId },
          )
          .catch((err: unknown) => auditLog(`agent.mute_suspected emit failed: ${(err as Error).message}`));
      },
      onRotate: (info) => {
        // Persist the NEW session id, not just announce it.
        //
        // `record` was called once per seat, from `ensureSession`, and never
        // again -- so `sessions.json` kept each seat's FIRST session for the life
        // of the mission while rotation moved the live one. Measured on a run of
        // 2026-09-24: 6 of 7 seats stale, tech-lead eight rotations behind.
        //
        // That file is what a restart reads (`supervisor.ensureSession` ->
        // `sessionRegistry.lookup`; `state.sessionMap` is never written), so a
        // seat whose turn timed out was "restored" onto a transcript it had
        // abandoned five rotations earlier -- and the stale id was then written
        // back with a fresh timestamp, which made it look current.
        //
        // It must be `info.sdkSessionId`: rotation deliberately keeps
        // `AgentSession.sessionId` (the mesh-side id) stable across rotations, so
        // the session object itself never carries the new id.
        void sessionRegistry
          ?.record(info.agentId, info.sdkSessionId, "claude")
          .catch((err: unknown) => auditLog(`session registry update failed for ${info.agentId}: ${(err as Error).message}`));
        void kernel
          .emit(
            "session.rotated",
            {
              agentId: info.agentId,
              fromSessionId: info.previousSdkSessionId,
              toSessionId: info.sdkSessionId,
              // `rotations` counts replacements; the seat's first session is
              // ordinal 1, so the nth rotation produces ordinal n+1.
              sessionOrdinal: info.rotations + 1,
              reason: "rotation",
              transcriptTokensDiscarded: info.contextTokens,
            } satisfies SessionRotated,
            { actorId: info.agentId },
          )
          .catch((err: unknown) => auditLog(`session.rotated emit failed: ${(err as Error).message}`));
      },
    });
  resolver.register("claude", claudeAdapter);
  // Answers the designer's own chat and serves its model picker. Only one
  // runtime implements DesignerRuntime now, so there is nothing to select:
  // MESH_DESIGNER_RUNTIME went with the opencode adapter.
  const designerAdapter: DesignerRuntime = claudeAdapter;
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
    async resume(): Promise<null> {
      return null;
    },
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
    // Criteria generation borrows the designer's one-shot call: it needs a
    // model, not a seat — no bus identity, no MCP, no mesh session, and no
    // agent's context (or budget) behind it. Only consulted when
    // `mesh.generate_acceptance_criteria` is on and the goal declares none.
    //
    // It borrows the call, not the designer's model: the third argument is a
    // per-call override the adapter already honours, so this one boot step runs
    // on `config.criteriaModel` (Haiku by default) while the designer's own
    // chat keeps whatever the operator chose for it.
    criteriaGenerator:
      options.criteriaGenerator ??
      ((goalText) =>
        generateAcceptanceCriteria(
          goalText,
          (text, opts) => designerAdapter.prompt(text, opts),
          config.criteriaModel,
        )),
    scheduler: noopScheduler,
    auditFile: options.inMemory ? undefined : path.join(layout.logs, "turn-audit.jsonl"),
    // JSONL sidecar for the in-memory turn ring: restores rich per-step data
    // (phases/op/timings/text/summary) after a restart — the event log only
    // reconstructs step shape, never this data.
    turnsFile: options.inMemory ? undefined : path.join(layout.logs, "turns.jsonl"),
  });
  const scheduler = new Scheduler(config, kernel.state, policy, supervisor, options.triageModel, kernel.clock);
  supervisor.setScheduler(scheduler);

  bus.subscribe((event) => {
    scheduler.handleEvent(event).catch(() => undefined);
  });

  let indexRef: { flush(): void; close(): void } | undefined;
  let indexUnsub: (() => void) | undefined;
  /**
   * Drop the sqlite index and its kernel subscription.
   *
   * The unsubscribe is not optional housekeeping: `kernel.subscribe` keeps the
   * listener forever, and every mission reset reopens the index. Without it
   * each swap leaves a listener closed over the dead index, which goes on
   * ingesting into a released handle for the life of the process.
   */
  const closeIndex = (): void => {
    indexUnsub?.();
    indexUnsub = undefined;
    try {
      indexRef?.flush();
      indexRef?.close();
    } catch {
      /* best-effort index */
    }
    indexRef = undefined;
  };
  /** Open the index over `events` and route subsequent events into it. */
  const openIndex = (events: MeshEvent[]): void => {
    closeIndex();
    const index = openSqliteIndex(path.join(layout.events, "events-index.sqlite"));
    indexRef = index;
    index.ingest(events);
    indexUnsub = kernel.subscribe((e) => index.ingest([e]));
  };
  // NOTE: `!options.inMemory` (not `=== false`) — every other branch above
  // treats an omitted flag as file mode, and the CLI never passes the flag.
  if (!options.inMemory) openIndex(await store.read());

  await kernel.replayFromStore();
  // `load()` already repaired what it could (skipped a corrupt line, cut a torn
  // tail); each count is an event the mission had and no longer has. Said at
  // boot, beside the other launch warnings, and kept on /health.
  if (store instanceof JsonlEventStore) {
    const integrity = store.integrity();
    if (integrity.corruptLines > 0 || integrity.truncatedTailBytes > 0) {
      const msg =
        `event log ${store.path()} was repaired on load: ${integrity.corruptLines} corrupt line(s) skipped, ` +
        `${integrity.truncatedTailBytes} byte(s) of torn tail truncated — those events are lost`;
      console.warn(`warn: ${msg}`);
      auditLog(`[log-integrity] ${msg}`);
    }
  }
  // What the machine this was launched from will lend every seat, said while the operator
  // is reading the boot log and can still choose. Only for a mesh that runs Claude seats
  // and has not already closed the door (`mesh.runtime.isolate_host`). See
  // host-isolation.ts.
  if (Object.values(config.agents).some((a) => a.runtime === "claude")) {
    if (config.isolateHost !== true) {
      for (const leak of describeHostLeaks()) {
        console.warn(`warn: ${leak}`);
        auditLog(`[host-isolation] ${leak}`);
      }
    } else {
      // With the door closed there is nothing to warn about, but a seat that then cannot log
      // in should be answerable from the log: what was taken out, and which names were kept.
      const done = describeIsolation();
      if (done) auditLog(`[host-isolation] ${done}`);
    }
  }
  const resume = kernel.state.eventCount > 0;
  if (resume) {
    scheduler.rebuildInterestRegistry();
  }
  const mode: ServerMode = options.mode ?? (options.uiOnly ? "parked" : "live");
  // The boot itself is at the bottom of this function, past the instance it is
  // handed back at the end. `beforeInitialActivation` sits in between so a
  // caller (the HTTP server) can bind its port first — the seats' MCP bridge is
  // spawned against a URL that does not exist until it has. See that option.

  const mainProductPath = path.join(config.workspacePath, "main");
  let lastBoot: MeshInstance["lastBoot"] = null;
  let resetInFlight = false;
  const instance: MeshInstance = {
    config,
    productPath: workspace
      ? workspace.mainPath
      : fs.existsSync(mainProductPath)
        ? mainProductPath
        : config.workspacePath,
    useGit,
    inMemory: options.inMemory === true,
    supervisor,
    kernel,
    store,
    scheduler,
    stubRuntimes,
    designerRuntime: designerAdapter,
    startedAt: Date.now(),
    // Both derived: see the MeshInstance declaration. `scheduler.isRunning()`
    // is the single source of truth for "can this mesh do work".
    get mode(): ServerMode {
      return scheduler.isRunning() ? "live" : "parked";
    },
    get uiOnly(): boolean {
      return !scheduler.isRunning();
    },
    get lastBoot(): MeshInstance["lastBoot"] {
      return lastBoot;
    },
    async goLive(note = "mission started from console") {
      const self = this as MeshInstance;
      // Asks the scheduler, not a mode flag: a completed mission left the
      // scheduler stopped, and the old `self.mode === "live"` check made this
      // an "already live" no-op on precisely the mesh that could not run.
      if (self.scheduler.isRunning()) return { alreadyLive: true, activated: [], refused: [] };
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
      const refused: Array<{ agentId: string; reason: string }> = [];
      for (const id of config.startupActivate) {
        const r = await supervisor.activateAgent(id, { kind: "startup", note: fullNote });
        if (r.queued) activated.push(id);
        else refused.push({ agentId: id, reason: r.blocked ?? "refused" });
      }
      // Recorded before returning, so the console can still answer "why is
      // nothing running" after the response that carried it is long gone. The
      // `alreadyLive` path above returns early and leaves the previous boot's
      // record standing, which is correct: it did not boot anything.
      lastBoot = { at: new Date().toISOString(), activated, refused };
      return { alreadyLive: false, activated, refused };
    },
    async park() {
      await scheduler.stop();
      supervisor.setLiveMode(false);
      // `mode`/`uiOnly` follow `scheduler.isRunning()`; stopping IS parking.
    },
    async reset(resetOpts: ResetOptions = {}) {
      // A reset is destructive and takes tens of seconds: the worktree copy
      // awaits (it has to — a synchronous copy blocks the heartbeat and the
      // host watchdog SIGKILLs the child mid-archive; see `copyDir`). That
      // await leaves the server free to accept a SECOND reset while the first
      // is still copying, and the two then race: the winner's
      // `removeAllWorktrees` deletes the worktrees out from under the loser's
      // copy, which throws ENOENT and aborts at step 2 — leaving a half-written
      // worktree archive, no bundle, and no state archive, while the operator
      // is told nothing. A double-clicked button must not queue a second wipe
      // either, so this refuses outright rather than serialising.
      if (resetInFlight) throw new ResetInProgressError();
      resetInFlight = true;
      try {
        const self = this as MeshInstance;
        // 1. Stop everything first. Order matters: the scheduler must not be
        //    able to start a turn while the log underneath it is being replaced.
        await self.park();
        await supervisor.resetMission();
        scheduler.resetMissionState();
        // Every archive this reset produces shares one stamp, so the backups read
        // as one set rather than as unrelated snapshots taken seconds apart.
        const archiveRoot = meshArchiveRoot(config.dir, config.meshId);
        const stamp = archiveStamp();
        // 2. Copy the worktrees aside BEFORE deleting them. They are not
        //    disposable: an agent's uncommitted edits live only in its worktree,
        //    and `removeAllWorktrees` deletes the branch as well, which leaves
        //    any commits as unreachable objects for `git gc` to collect. Both
        //    copies are taken here, while the branches still exist.
        let worktreesArchivedTo: string | null = null;
        let worktreeBundleTo: string | null = null;
        let uncommittedManifestTo: string | null = null;
        const uncommittedByAgent: Record<string, number> = {};
        // Record what was never committed, BEFORE anything is deleted and
        // regardless of whether the copy is enabled. The files themselves were
        // already being archived; what was missing was any statement that they
        // existed, so a mission could write 1,847 lines that reached no repository
        // and nothing in the reset report mentioned it. Cheap (one `git status`
        // per worktree) and text, so it also runs on the `archiveWorktrees: false`
        // path — the one that really does destroy the files.
        if (workspace && !options.inMemory) {
          const states = await workspace.worktreeStates().catch(() => []);
          for (const s of states) uncommittedByAgent[s.agentId] = s.dirty.length;
          if (states.length > 0) {
            const manifest = path.join(archiveRoot, `worktrees-uncommitted.bak-${stamp}.json`);
            try {
              fs.mkdirSync(archiveRoot, { recursive: true });
              fs.writeFileSync(manifest, JSON.stringify({ meshId: config.meshId, stamp, worktrees: states }, null, 2));
              uncommittedManifestTo = manifest;
            } catch (err) {
              auditLog(`uncommitted-work manifest not written: ${(err as Error).message}`);
            }
          }
        }
        if (workspace && !options.inMemory && resetOpts.archiveWorktrees !== false) {
          worktreesArchivedTo = await copyDir(workspace.worktreesPath, { archiveRoot, stamp });
          // Walking away from a failed copy would delete the only copy, so a
          // throw here aborts the reset with the worktrees still intact.
          const bundle = await workspace.bundleWorktreeBranches(
            // Inside the worktree archive when there is one, so a stamp resolves
            // to a single directory; otherwise beside it under the same stamp.
            worktreesArchivedTo
              ? path.join(worktreesArchivedTo, "mesh-branches.bundle")
              : path.join(archiveRoot, `mesh-branches.bak-${stamp}.bundle`),
          );
          worktreeBundleTo = bundle?.path ?? null;
        }
        // 3. Now it is safe to delete them (and their mesh/* branches) so the
        //    next run cannot read the previous run's files. Sessions are already
        //    stopped, so no process is using them.
        const worktreesRemoved = workspace ? await workspace.removeAllWorktrees() : [];
        // 4. The product checkout is mission scratch: archive it outside the
        //    workspace, then leave an empty product root so the Product page
        //    (and the next run) sees no files from the previous mission. Git
        //    mode owns the dedicated `main/` checkout. Without git the mission
        //    materializes product files (and the playground build) straight into
        //    the workspace root, so that root is what gets archived. The state
        //    dir lives inside the workspace by default and step 6 archives it
        //    separately, so exclude it here instead of double-archiving.
        let productArchivedTo: string | null = null;
        let strayRootArchivedTo: string | null = null;
        if (workspace && !options.inMemory) {
          productArchivedTo = archiveDir(workspace.mainPath, { archiveRoot, stamp });
          // Anything at the root other than what git mode owns is untracked by
          // every repo here, so `removeMain` below would leave it behind and the
          // next boot would refuse the layout (see `assertWorkspaceCoherent`). A
          // root `.git` is deliberately NOT excluded: a workspace that is its own
          // repository is the other half of that refusal, and reset is exactly
          // when it should stop being one.
          strayRootArchivedTo = archiveDir(config.workspacePath, {
            archiveRoot,
            stamp,
            exclude: [
              workspace.mainPath,
              path.join(config.workspacePath, WORKTREES_DIRNAME),
              path.join(config.workspacePath, ".mesh"),
              config.stateDir,
            ],
          });
          workspace.removeMain();
          await workspace.ensureRepo();
        } else if (!options.inMemory) {
          productArchivedTo = archiveDir(config.workspacePath, {
            archiveRoot,
            stamp,
            exclude: [config.stateDir],
          });
          fs.mkdirSync(config.workspacePath, { recursive: true });
          // Hand the next mission a real repo, not a bare directory: git mode
          // gets one from `ensureRepo` above, and without the same here every
          // git read of the product silently answers from an enclosing repo (or
          // from nothing) for the rest of the run.
          await initProductRepo(config.workspacePath, config.stateDir);
        }
        // 5. Release the sqlite index handle before the directory moves; an open
        //    handle would keep writing into the archived copy.
        closeIndex();
        // 6. Archive-then-recreate the state dir (atomic rename, recoverable).
        //    The archive lives outside `workspace/` so new agents cannot read
        //    it from their working tree.
        let archivedTo: string | null = null;
        if (!options.inMemory) {
          archivedTo = archiveStateDir(config.stateDir, {
            keepArtifacts: resetOpts.keepArtifacts,
            archiveRoot,
            stamp,
          }).archivedTo;
          // The rename moved the lock file into the archive with everything
          // else, leaving the recreated directory unclaimed. Rewrite it, or a
          // second process could open the state dir this one is still using.
          stateLock?.refresh();
        }
        // 7. Empty the log + projections + snapshot in place, preserving object
        //    identity so every route handler's closure stays valid.
        await kernel.resetToEmpty();
        // 8. Reopen the index against the fresh (empty) directory.
        if (!options.inMemory) openIndex([]);
        // 9. Boot a brand-new mission from the config. resume:false forces a new
        //    goal rather than resurrecting the one we just deleted.
        await supervisor.boot({ resume: false, mode: "parked" });
        scheduler.rebuildInterestRegistry();
        // Step 1 parked the scheduler and `boot({mode:"parked"})` left it that
        // way, so the derived `mode`/`uiOnly` already read "parked".
        self.startedAt = Date.now();
        return {
          ok: true,
          archivedTo,
          productArchivedTo,
          worktreesRemoved,
          worktreesArchivedTo,
          worktreeBundleTo,
          uncommittedManifestTo,
          uncommittedByAgent,
          strayRootArchivedTo,
          goalId: kernel.state.activeGoalId ?? null,
          mode: self.mode,
        };
      } finally {
        // Cleared on the failure path too, or one aborted reset would wedge
        // the route for the life of the process.
        resetInFlight = false;
      }
    },
    backups() {
      return listArchives(meshArchiveRoot(config.dir, config.meshId));
    },
    async restore(archivePath: string, restoreOpts: RestoreOptions = {}) {
      const self = this as MeshInstance;
      if (options.inMemory) {
        // There is no state dir to replace and no archive to read.
        throw new Error("an in-memory mesh has no state dir to restore into");
      }
      const source = path.resolve(archivePath);
      const stamp = /\.bak-(\d{8}-\d{6})(?:-\d+)?$/.exec(path.basename(source))?.[1] ?? "";
      // Park first even though the route refuses a live mesh: the copy below
      // swaps the log out from under anything still writing to it. Park is
      // idempotent, so an already-parked mesh pays nothing.
      await self.park();
      // Same reset the destructive path does: no agent may carry a turn or a
      // budget across the boundary, because the events that established them
      // are no longer in the log.
      await supervisor.resetMission();
      scheduler.resetMissionState();
      // Release the index before the directory is replaced: on POSIX an open
      // handle keeps writing into the inode that is about to be moved aside.
      closeIndex();
      const result = restoreStateDir(source, config.stateDir, {
        archiveRoot: meshArchiveRoot(config.dir, config.meshId),
        keepSessions: restoreOpts.keepSessions,
      });
      // The archive carried the lock file of whichever process wrote it. Ours
      // is gone with the directory we just moved aside, so rewrite it before
      // anything else can decide the directory is unclaimed.
      stateLock?.refresh();
      // The registry caches what it loaded, so it would otherwise keep serving
      // the pre-restore file for the life of this process.
      sessionRegistry?.reload();
      // Rebuild the store's in-memory cache from the log now on disk before the
      // kernel reads it, or the kernel would replay the log we just replaced.
      const restoredEvents = (await store.reload?.()) ?? [];
      // The index is rebuilt by re-ingesting the restored log, never by copying
      // the archived sqlite file: a stale index would count those events a
      // second time.
      if (!options.inMemory) openIndex(restoredEvents);
      await kernel.reloadFromStore();
      // resume:true is the deliberate opposite of reset — the whole point is to
      // get the archived mission back rather than to mint a new goal.
      await supervisor.boot({ resume: true, mode: "parked" });
      scheduler.rebuildInterestRegistry();
      // Step 1 parked the scheduler and boot left it parked, so `mode`/`uiOnly`
      // already read "parked".
      self.startedAt = Date.now();
      return {
        ok: true,
        restoredFrom: source,
        stamp,
        previousArchivedTo: result.previousArchivedTo,
        events: result.events,
        goalId: kernel.state.activeGoalId ?? null,
        snapshotDropped: result.snapshotDropped,
        sessionsDropped: result.sessionsDropped,
        mode: self.mode,
      };
    },
    async close() {
      closeIndex();
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
  // Anything the caller must have standing before the first live wake. Runs with
  // the instance in hand and before `boot`, which is the only ordering that can
  // gate that wake on something the caller owns (the HTTP listener).
  if (options.beforeInitialActivation) await options.beforeInitialActivation(instance);
  await supervisor.boot({
    resume,
    mode,
    ...(options.bridgeReady ? { bridgeReady: options.bridgeReady } : {}),
    ...(options.bridgeReadyTimeoutMs !== undefined ? { bridgeReadyTimeoutMs: options.bridgeReadyTimeoutMs } : {}),
  });
  return instance;
}

export interface ServerHandle {
  server: http.Server;
  port: number;
  url: string;
  instance: MeshInstance;
  close(): Promise<void>;
}

/**
 * Reasoning effort for the two designer chat routes below.
 *
 * Lower than the backend's default `high` because this is the one model call in
 * the mesh with a human reading every turn: the operator sees the reply, and
 * the draft config it proposes is schema- and gate-validated before the UI will
 * apply it, so a reasoning reduction that hurts shows up immediately and costs
 * one retry. Nothing autonomous depends on this turn.
 *
 * Applies to the designer's own chat ONLY. Acceptance-criteria generation
 * borrows the same one-shot runtime call but must NOT inherit this: it runs on
 * `config.criteriaModel` (Haiku by default), which has no effort support at
 * all. That is why this is passed per call rather than configured on the
 * designer runtime.
 */
const DESIGNER_EFFORT = "medium" as const;

/**
 * Persona/contract for POST /designer/chat. The whole-config-every-turn rule
 * is what lets the UI diff one reply against the current draft instead of
 * replaying a sequence of partial patches.
 */
const DESIGNER_SYSTEM_PROMPT = [
  "You are the crew designer for Agent Mesh: you help an operator author mesh.yaml through chat.",
  "You are given the current draft config as JSON, then the conversation so far.",
  "",
  "Rules:",
  "- You have no filesystem or shell access. Never try to read, list, or search files. Use the mesh_designer_schema, mesh_designer_vocabulary, and mesh_designer_validate tools to check field names, allowed values, and whether a draft is valid; answer from the draft config and conversation you are given.",
  "- You can also observe the live mission read-only when the mesh_run_status, mesh_query_events, mesh_steps, mesh_failures, mesh_agent_activity, and mesh_run_digest tools are available. When the operator asks how the run is going, what the agents are doing, or what failed, call them instead of saying you cannot observe runs. Start broad (mesh_run_digest or mesh_run_status), then drill into mesh_steps, mesh_failures, or mesh_query_events.",
  "- ALWAYS answer with a brief prose explanation followed by exactly one fenced ```json block. It contains either the COMPLETE mesh.yaml document, or — when editing an existing draft — a JSON Patch object (see below). Never a prose diff, a fragment, or multiple blocks. Repeat the whole config unchanged when nothing needs to change.",
  "- To edit an existing draft, you may reply with a JSON Patch instead of the whole document: one fenced ```json block containing an object with a `patch` array of RFC 6902 `add`/`remove`/`replace` operations (each has `op`, `path`, and `value` except `remove`) and an optional `summary`. Array paths end with an index or `/-` to append. The server applies the patch to the current draft before validating, so fields you did not touch are preserved. Use the complete-document form for a new config or a structural rewrite.",
  "- Keep every field the operator did not ask you to change exactly as it was.",
  "- The document must match the mesh schema: project, mesh (id, name, goal, workspace), agents, policies.transitions, budgets.",
  "- Transition gates look like `<actor>.<kind>` where actor is an agent id or role. The named actor must exist, and an `approve` token must map to an agent holding the matching authority or capability, or the mission deadlocks at that gate.",
  "- Agent model fields are `provider/model` strings; leave them blank to use the mesh default.",
  "",
  "How to design a good mesh:",
  "- Start from the goal. Read mesh.goal first and let it decide the crew: who produces the work, who reviews it, and who should never be able to self-approve.",
  "- Keep the crew minimal and non-redundant. One agent per responsibility; merge overlapping roles instead of adding a second agent that does the same job. A smaller crew is cheaper and easier to govern.",
  "- Give each agent the least it needs: capabilities for what it must do, interests for the events it must react to (use mesh_designer_vocabulary for exact capability and event names), and no more. Do not hand every agent the same generous set.",
  "- Wire communication deliberately with policies.communication: represent the real reporting and review structure rather than a fully-connected graph, and route work and approvals through the coordinating role.",
  "- Choose activation on purpose: put coordinators and long-lived services in startup, and let workers wake from interests only when there is work.",
  "- Gate every irreversible transition in policies.transitions. Put approvals in front of merge, release, and similar actions; the approving actor must exist and hold the matching authority or capability, or the gate deadlocks. mesh_designer_validate checks this.",
  "- Set a mission token budget in budgets.mission.tokens that fits the goal, and let the crew size follow the budget — not the other way around.",
  "- Prefer a clear pipeline (produce, review, approve) over a swarm of peers. When the operator does not specify governance, propose the simplest correct arrangement and say what you chose.",
  "- Validate before replying: call mesh_designer_validate on the complete proposal. If it reports problems, fix them in your next whole-config block instead of explaining them away.",
  "",
  "Staging changes to the live run:",
  "- When the mesh_stage_* tools are available you can also PROPOSE changes to the running mission: the mission statement (mesh_stage_goal_description), acceptance criteria (mesh_stage_criteria_add / _edit / _delete), seats (mesh_stage_seat_spawn / _retire / _suspend / _resume / _wake), and run control (mesh_stage_run_pause / _resume / _budget / _reopen, mesh_stage_mission_reset).",
  "- You NEVER execute any of these. Staging shows the operator a review card; they press Apply. Say what you staged and why — never say a change has been made, is now in effect, or has taken effect.",
  "- Look before you stage. Call mesh_run_status or mesh_agent_activity first so a retirement lands on a seat that is actually idle and an edit names a criterion that actually exists. A tool that refuses tells you why — fix the call, do not argue with it in prose.",
  "- Destructive proposals (mesh_stage_criteria_delete, _seat_retire, _run_reopen, _mission_reset) require a `reason`, and the operator sees it. Retirement is TERMINAL: a retired seat can never be resumed or woken, so propose mesh_stage_seat_suspend unless the seat should be gone for good.",
  "- mesh_stage_mission_reset asks the operator for one more thing the `reason` cannot stand in for: they must type the mesh id on the card before Apply is accepted. You write the reason, so a reason-only guard would be one you satisfy by existing; the id is the half you cannot supply. Say so when you stage it, and give them the id — otherwise a reset you staged looks like it did nothing.",
  "- Removing a criterion shrinks what completion is measured over and can end the run. Propose it only when the operator asked for it, and say so plainly.",
  "- Config and live-run changes are different things: mesh_stage_config_replace edits the operator's local mesh.yaml draft (they still have to Save), every other kind applies to the running mesh. Do not describe them as one change.",
  "- mesh.yaml seeds the goal and its acceptance criteria only at BOOT, so rewriting them with mesh_stage_config_replace does not change a mission that is already running — it changes what the next boot would start, and the operator's Overview keeps showing the old mission. To change the goal or criteria of the RUNNING mission use mesh_stage_goal_description and mesh_stage_criteria_add / _edit / _delete. Reach for config replacement only when the operator is editing the file for a future run, or when they ask for both — and then say plainly that it is two changes.",
  "- The one-block rule still holds for config. When you stage config with mesh_stage_config_replace, do NOT also emit a fenced config block — the tool call is the proposal. Use the fenced block only when you are not using the staging tools.",
  "- Call mesh_staged_list before writing your summary so your prose matches the cards the operator will see, and mesh_staged_discard to drop anything you staged and then thought better of.",
  "- If the goal is ambiguous about scope, deliverables, or who may approve, ask 1-3 focused questions before proposing. Otherwise propose a complete draft rather than interrogating the operator.",
].join("\n");

/**
 * Parse the fenced JSON/YAML blocks of a designer reply (plus a bare leading
 * object), in order. The system prompt allows exactly one proposal block per
 * reply, so the first candidate of the right shape wins; later blocks are
 * examples/commentary.
 */
function candidateObjects(text: string): unknown[] {
  const candidates: string[] = [];
  const fence = /```(?:json|yaml|yml)?[ \t]*\r?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text)) !== null) candidates.push(match[1]);
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) candidates.push(trimmed);
  const out: unknown[] = [];
  for (const candidate of candidates) {
    try {
      const doc = parseYamlText(candidate);
      if (doc && typeof doc === "object" && !Array.isArray(doc)) out.push(doc);
    } catch {
      /* not this block */
    }
  }
  return out;
}

/** First candidate that is a whole config (has `agents` or `mesh`). */
function extractDesignerConfig(text: string): unknown {
  for (const doc of candidateObjects(text)) {
    const obj = doc as Record<string, unknown>;
    if ("agents" in obj || "mesh" in obj) return doc;
  }
  return undefined;
}

/** First candidate that is a patch proposal, i.e. `{ patch: [...] }`. */
function extractDesignerPatch(text: string): unknown[] | undefined {
  for (const doc of candidateObjects(text)) {
    const patch = (doc as { patch?: unknown }).patch;
    if (Array.isArray(patch)) return patch;
  }
  return undefined;
}

/**
 * Apply a JSON Patch (RFC 6902 subset: add/remove/replace) to a deep copy of
 * the draft. `test`/`copy`/`move` are not needed for config edits, and quietly
 * ignoring an unknown op would be worse than rejecting it.
 */
function applyJsonPatch(doc: unknown, ops: unknown[]): unknown {
  const root = JSON.parse(JSON.stringify(doc ?? {})) as Record<string, any>;
  const tokens = (path: unknown): string[] => {
    if (typeof path !== "string" || !path.startsWith("/")) throw new Error(`invalid path '${String(path)}'`);
    const parts = path
      .slice(1)
      .split("/")
      .map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
    // The patch is the model's reply, and the model reads text an agent wrote. `/__proto__/x` walks to
    // Object.prototype and the assignment below writes onto it, for every object in the process.
    for (const part of parts) {
      if (part === "__proto__" || part === "constructor" || part === "prototype") throw new Error(`path '${path}' names a reserved key ('${part}')`);
    }
    return parts;
  };
  const at = (path: unknown): { parent: any; key: string } => {
    const parts = tokens(path);
    if (parts.length === 0) throw new Error("the document root cannot be patched");
    let parent: any = root;
    for (const part of parts.slice(0, -1)) {
      if (parent === null || typeof parent !== "object") throw new Error(`path '${String(path)}' does not exist`);
      // Own properties only: a step must not land on what every object inherits.
      parent = Object.hasOwn(parent, part) ? parent[part] : undefined;
    }
    if (parent === null || typeof parent !== "object") throw new Error(`path '${String(path)}' does not exist`);
    return { parent, key: parts[parts.length - 1] };
  };
  const index = (parent: any[], key: string, path: unknown): number => {
    if (key === "-") return parent.length;
    const i = Number(key);
    if (!Number.isInteger(i) || i < 0 || i > parent.length) throw new Error(`bad array index '${key}' for ${String(path)}`);
    return i;
  };
  for (const raw of ops) {
    const op = raw as { op?: unknown; path?: unknown; value?: unknown };
    if (!op || typeof op !== "object") throw new Error("each patch entry must be an object");
    const { parent, key } = at(op.path);
    if (op.op === "add") {
      if (Array.isArray(parent)) parent.splice(index(parent, key, op.path), 0, op.value);
      else parent[key] = op.value;
    } else if (op.op === "replace") {
      if (Array.isArray(parent)) {
        const i = index(parent, key, op.path);
        if (i >= parent.length) throw new Error(`path '${String(op.path)}' does not exist`);
        parent[i] = op.value;
      } else {
        if (!Object.hasOwn(parent, key)) throw new Error(`path '${String(op.path)}' does not exist`);
        parent[key] = op.value;
      }
    } else if (op.op === "remove") {
      if (Array.isArray(parent)) {
        const i = index(parent, key, op.path);
        if (i >= parent.length) throw new Error(`path '${String(op.path)}' does not exist`);
        parent.splice(i, 1);
      } else {
        if (!Object.hasOwn(parent, key)) throw new Error(`path '${String(op.path)}' does not exist`);
        delete parent[key];
      }
    } else {
      throw new Error(`unsupported patch op '${String(op.op)}'`);
    }
  }
  return root;
}

export function createHttpServer(instance: MeshInstance, opts: { dashboardDir?: string; licenses?: LicenseProvider } = {}): http.Server {
  const { supervisor, kernel, config, store } = instance;
  const hub = new SseHub({ maxClients: maxSseClients() });
  kernel.subscribe((e) => hub.broadcast(e));

  /** Shared by the JSON and SSE designer-chat routes: request body → model prompt. */
  const buildDesignerPrompt = (b: Record<string, any>): { promptText: string; currentConfig: unknown } | { error: string } => {
    const messages: Array<{ role?: unknown; content?: unknown; problems?: unknown }> = Array.isArray(b.messages) ? b.messages : [];
    if (messages.length === 0) return { error: "messages must be a non-empty array" };
    const currentConfig = b.currentConfig && typeof b.currentConfig === "object" ? b.currentConfig : undefined;
    const transcript = messages
      .map((m) => {
        const role = String(m?.role ?? "user").toLowerCase() === "assistant" ? "Assistant" : "User";
        const content = typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "");
        return `${role}:\n${content}`;
      })
      .join("\n\n");
    // The client echoes back the problems from its latest proposal, so the
    // model sees why the turn before was rejected instead of repeating it.
    const problems = [
      ...new Set(
        messages
          .flatMap((m) => (Array.isArray(m?.problems) ? m.problems : []))
          .filter((p): p is string => typeof p === "string" && p.trim().length > 0),
      ),
    ];
    const sections = [
      currentConfig
        ? `Current draft mesh.yaml (as JSON):\n\`\`\`json\n${JSON.stringify(currentConfig, null, 2)}\n\`\`\``
        : "There is no config yet; the first proposal should be a new mesh.yaml.",
      `Conversation:\n${transcript}`,
    ];
    if (problems.length > 0) {
      sections.push(
        `The previous proposal failed validation. Fix every problem below and reply with the complete corrected mesh.yaml:\n${problems
          .map((p) => `- ${p}`)
          .join("\n")}`,
      );
    }
    return { promptText: sections.join("\n\n---\n\n"), currentConfig };
  };

  /** Validate any candidate config; returns the problem list (empty = clean). */
  const validateDesignerConfig = (proposedConfig: unknown): string[] => {
    const problems: string[] = [];
    try {
      const { resolved } = analyzeMeshConfig(proposedConfig, config.dir);
      // Schema-valid, but a gate that names an actor no agent can play
      // still deadlocks every mission at that transition.
      const gateIssues = validateTransitionGates(resolved.raw.policies?.transitions, resolved.raw.agents);
      for (const warning of resolved.warnings) problems.push(warning);
      for (const issue of gateIssues) problems.push(`gate '${issue.gate}' token '${issue.token}': ${issue.reason}`);
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      problems.push(...err.errors);
    }
    return problems;
  };

  /**
   * Proposal extraction + validation shared by the JSON and SSE routes. A
   * reply may carry the whole config or a JSON Patch against `currentConfig`;
   * either way the route returns a complete validated proposal for the UI.
   */
  const analyzeDesignerReply = (reply: string, currentConfig?: unknown): { proposedConfig: unknown; problems: string[] } => {
    const proposedConfig = extractDesignerConfig(reply);
    if (proposedConfig !== undefined) return { proposedConfig, problems: validateDesignerConfig(proposedConfig) };
    const patch = extractDesignerPatch(reply);
    if (patch === undefined) {
      return { proposedConfig: undefined, problems: ["the reply contained no parseable whole-config block or patch"] };
    }
    if (currentConfig === undefined || currentConfig === null || typeof currentConfig !== "object") {
      return {
        proposedConfig: undefined,
        problems: ["the reply used a patch, but there is no current draft to apply it to — send the complete config instead"],
      };
    }
    try {
      const patched = applyJsonPatch(currentConfig, patch);
      return { proposedConfig: patched, problems: validateDesignerConfig(patched) };
    } catch (err) {
      return { proposedConfig: undefined, problems: [`the patch could not be applied: ${(err as Error).message}`] };
    }
  };

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
    onTurnToolEvent: (turnId, agentId, ev) => {
      try {
        prevHooks?.onTurnToolEvent?.(turnId, agentId, ev);
      } catch {
        /* prior hook must never break streaming */
      }
      // The frame nests rather than flattening like `turn.token`: `tool_call`
      // and `tool_call_update` carry different fields, and keeping the
      // discriminated union intact lets a client switch on `tool.kind`.
      hub.stream("turn.tool", { type: "turn.tool", turnId, agentId, tool: ev, at: new Date().toISOString() });
    },
  };
  // The human seat's bridge credential. It used to be the literal
  // `human-local` (or any `human:` prefix), and because `/internal/mcp` is
  // served before operator auth, that literal was a second operator door any
  // local process could walk through. It is now a random secret minted per
  // server and handed only to this server's own designer bridge
  // (`designerBus` below). The operator token is accepted too, so an operator
  // can still attach `mesh mcp --agent human --token $MESH_API_TOKEN`; with no
  // operator token configured, only the minted secret opens the human seat.
  const humanBridgeToken = randomBytes(32).toString("hex");
  const humanAuth = (token: string): boolean => {
    if (secretsEqual(token, humanBridgeToken)) return true;
    const operator = getApiToken();
    return operator.length > 0 && secretsEqual(token, operator);
  };
  const mcp = createMcpToolset(supervisor, { humanAuth });
  // Served to local observers (the designer's mesh_observe MCP) via
  // `/internal/mcp/:agent?readOnly=1`: observability tools only.
  const mcpReadOnly = createMcpToolset(supervisor, { readOnly: true, humanAuth });
  // Staging surface for the dashboard assistant: the same six observability
  // tools plus `mesh_stage_*`, reached on the same bridge route with an
  // `x-mesh-designer-turn` header. Writes land in `designerTurns`, never in the
  // mesh — the operator applies them through POST /designer/staged/apply.
  const designerTurns = new DesignerTurnBuffer();
  const mcpStaging = createDesignerStagingToolset(supervisor, designerTurns, humanAuth);
  const startedAt = instance.startedAt;

  /**
   * Where a designer turn's MCP bridge should point. Unknown until `listen()`
   * runs, so it is resolved per call rather than captured — a server that never
   * listens (tests, embedded use) simply gets no staging tools.
   */
  const designerBus = (): { busUrl: string; token: string } | undefined => {
    const addr = server.address();
    if (!addr || typeof addr === "string") return undefined;
    return { busUrl: `http://127.0.0.1:${addr.port}`, token: humanBridgeToken };
  };

  /**
   * Open a staging turn and describe the bridge the runtime should hand the
   * model. The turn id travels in the header, so two concurrent turns cannot
   * see or overwrite each other's buffer even though they share the route.
   */
  const openDesignerTurn = (): { turnId: string; mcp?: DesignerPromptOptions["mcp"] } => {
    const turnId = randomUUID();
    designerTurns.open(turnId);
    const bus = designerBus();
    if (!bus) return { turnId };
    return {
      turnId,
      mcp: {
        // `?staging=1` is carried by the URL itself so that a client which
        // only reproduces the URL still reaches the staging toolset: the
        // header is exact correlation, not the thing that selects the tools.
        // o‍pencode's bridge is spawned once per designer process and cannot
        // carry a per-turn header at all, so it arrives with the query alone.
        url: `${bus.busUrl}/internal/mcp/${encodeURIComponent(HUMAN_AGENT_ID)}?staging=1`,
        headers: { "x-mesh-token": bus.token, "x-mesh-designer-turn": turnId },
      },
    };
  };

  /**
   * Close a staging turn and fold everything the model produced — tool calls
   * and the fenced config block alike — into one `StagedProposal`.
   *
   * The two authoring paths can describe the same change, so staged tools win:
   * a `config.replace` in the buffer suppresses the text-extracted one rather
   * than offering the operator two config cards that differ in some subtle way.
   * `proposedConfig` still ships beside the proposal for one release, because
   * the dashboard's existing apply path reads it.
   */
  const closeDesignerTurn = (
    turnId: string,
    reply: string,
    currentConfig?: unknown,
  ): { proposedConfig: unknown; problems: string[]; proposal: StagedProposal } => {
    const drained = designerTurns.drain(turnId);
    const analyzed = analyzeDesignerReply(reply, currentConfig);
    const mutations = [...drained.mutations];
    const problems = [...drained.problems];
    const stagedConfig = mutations.some((m) => m.kind === "config.replace");
    let proposedConfig = analyzed.proposedConfig;

    if (stagedConfig) {
      // Risk 5: two proposal formats in one reply. The buffer is authoritative.
      proposedConfig = undefined;
    } else if (analyzed.proposedConfig !== undefined) {
      problems.push(...analyzed.problems);
      try {
        mutations.unshift({ kind: "config.replace", yaml: stringifyMesh(analyzed.proposedConfig), reason: "config block from the assistant's reply" });
      } catch (err) {
        problems.push(`the proposed config could not be serialised: ${(err as Error).message}`);
      }
    } else {
      // No config block and no staged config. The "reply contained no parseable
      // block" complaint is only a problem when the model staged nothing at
      // all; a tools-only turn is a complete answer, not a malformed one.
      if (mutations.length === 0) problems.push(...analyzed.problems);
    }

    return {
      proposedConfig,
      problems: [...new Set(problems)],
      proposal: { id: turnId, createdAt: new Date().toISOString(), mutations, problems: [...new Set(problems)] },
    };
  };

  /**
   * Memoised model catalogue for GET /models. Resolving it shells out to the
   * Claude CLI (~1s), and the designer refetches whenever the crew panel
   * mounts; the set of installed providers changes on the order of never.
   */
  let modelCatalogue: { at: number; value: Awaited<ReturnType<typeof instance.designerRuntime.listModels>> } | undefined;
  const MODEL_CATALOGUE_TTL_MS = 5 * 60 * 1000;
  // `?refresh=1` forces a reload, and a reload spawns the CLI. Concurrent refreshes share one run, and a
  // second one inside this window is answered from the catalogue the first just made.
  const MODEL_REFRESH_MIN_MS = 10 * 1000;
  let modelRefresh: Promise<Awaited<ReturnType<typeof instance.designerRuntime.listModels>>> | undefined;

  // Every designer turn is a model call (a CLI or API round trip that can run for minutes). The route
  // is the operator's, but an operator's tab in a loop, or a script, should not be able to start them
  // without bound.
  const MAX_DESIGNER_TURNS = 2;
  let designerInFlight = 0;

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

  // Set when shutdown begins, so `/readyz` stops saying "ready" while sockets drain and the
  // load balancer stops sending new work to a server that is closing.
  let draining = false;

  // Per server, never shared: the dashboard's sign-in, the count of wrong tokens, and the signed
  // links that let the sandboxed playground read its own files.
  const sessions = new SessionStore();
  const limiter = new FailureLimiter();
  const previews = new PreviewCapabilities();
  // The licence, re-read on a short timer so one installed while this server is up applies without a restart.
  const licenses = opts.licenses ?? new LicenseProvider({ home: meshHome() });

  /**
   * Append one line to a file under the state directory's `logs/`. An audit trail never breaks the
   * request it describes, and an in-memory mesh has no directory to keep one in.
   */
  const appendLog = (file: string, line: string): void => {
    if (instance.inMemory) return;
    try {
      const dir = `${instance.config.stateDir}/logs`;
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(`${dir}/${file}`, `${new Date().toISOString()} ${line}\n`, "utf8");
    } catch {
      /* audit never breaks the runtime */
    }
  };

  /**
   * A file from the product checkout under the preview policy: agent-written HTML and script, so it is
   * always sandboxed (see `PREVIEW_CSP`).
   *
   * `readable` adds the CORS headers that let the sandboxed page's own `fetch` read what it asked for.
   * They go on the capability route only, where the proof is already in the URL, and never on an API
   * answer. `dir` is a path under the product root; `rest` is what the URL named beneath it.
   */
  const servePreviewFile = async (res: http.ServerResponse, dir: readonly string[], rest: string[], readable: boolean, notFound?: string): Promise<void> => {
    applySecurityHeaders(res, "preview");
    const reply = (code: number, type: string, payload: string | Buffer): void => {
      res.writeHead(code, {
        "content-type": type,
        "cache-control": "no-cache",
        ...(readable ? { "access-control-allow-origin": "*", "cross-origin-resource-policy": "cross-origin" } : {}),
      });
      res.end(payload);
    };
    const fail = (code: number, message: string): void => reply(code, "application/json", JSON.stringify({ error: message }));
    const root = path.join(instance.productPath, ...dir);
    if (rest.length === 0) {
      const html = await fs.promises.readFile(path.join(root, "index.html"), "utf8").catch(() => "");
      if (!html) {
        // 404 (not 200) so the dashboard's playground probe treats this as "not built" instead of
        // embedding the fallback text in an iframe.
        reply(404, "text/html; charset=utf-8", "<!doctype html><meta charset=utf-8><title>Playground</title><body style='font-family:monospace;padding:24px'>No product build in this workspace — expected apps/playground/index.html, and the mission has not written one.</body>");
        return;
      }
      reply(200, "text/html; charset=utf-8", html);
      return;
    }
    let relative: string;
    try {
      relative = rest.map((segment) => decodeURIComponent(segment)).join("/");
    } catch {
      return fail(400, "malformed path");
    }
    const ab = resolveInside(root, relative);
    if (!ab) return fail(400, `path escapes ${dir.join("/")}`);
    const st = await fs.promises.stat(ab).catch(() => null);
    if (!st || !st.isFile()) return fail(404, notFound ?? `missing file (${relative})`);
    const ext = path.extname(ab).toLowerCase();
    const type =
      ext === ".js" ? "text/javascript" :
      ext === ".css" ? "text/css" :
      ext === ".json" ? "application/json" :
      ext === ".html" ? "text/html" :
      ext === ".svg" ? "image/svg+xml" : "application/octet-stream";
    reply(200, `${type}; charset=utf-8`, await fs.promises.readFile(ab));
  };
  const servePlayground = (res: http.ServerResponse, rest: string[], readable: boolean): Promise<void> =>
    servePreviewFile(res, PREVIEW_PAGE_DIR, rest, readable, `missing build output (${rest.join("/")}) — run "build playground" first`);

  /**
   * What a capability opens, in the product's own layout: `apps/playground/...` is the page and
   * `presets/...` its data. Anything else under the capability is not found; there is deliberately no
   * way to name the rest of the checkout.
   */
  const servePreviewCapability = (res: http.ServerResponse, rest: string[]): Promise<void> => {
    const under = (prefix: readonly string[]): boolean => prefix.every((segment, i) => rest[i] === segment);
    if (under(PREVIEW_PAGE_DIR)) return servePlayground(res, rest.slice(PREVIEW_PAGE_DIR.length), true);
    if (under(PREVIEW_PRESETS_DIR) && rest.length > PREVIEW_PRESETS_DIR.length) {
      return servePreviewFile(res, PREVIEW_PRESETS_DIR, rest.slice(PREVIEW_PRESETS_DIR.length), true, "no such preset");
    }
    applySecurityHeaders(res, "preview");
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "nothing at that path: a playground link opens apps/playground/ and presets/" }));
    return Promise.resolve();
  };

  /**
   * The seats in this mesh: every agent the kernel tracks except the operator. `human` is how the log names
   * whoever is at the console; it is registered like an agent but is not one a plan sells or a model bills.
   */
  const seatRecords = () => [...kernel.state.agents.values()].filter((r) => r.state.agentId !== HUMAN_AGENT_ID);
  const seatsInUse = (): number => seatRecords().length;

  /** This mesh as a scrape: activity, the agents' states, the loop's health, subscribers and the licence. */
  const meshMetrics = (): PromMetric[] => {
    const m = buildMetrics(kernel.state, Date.now() - startedAt);
    const seatsByLifecycle: Record<string, number> = {};
    for (const r of seatRecords()) seatsByLifecycle[r.state.lifecycle] = (seatsByLifecycle[r.state.lifecycle] ?? 0) + 1;
    const mission = [...kernel.state.budgets.values()].find((b) => b.key.startsWith("mission:") && b.limitKind === "tokens");
    return [
      { name: "agent_mesh_up", help: "1 while the server is serving.", type: "gauge", samples: [{ value: 1 }] },
      { name: "agent_mesh_info", help: "The running version, mode and mesh id; always 1.", type: "gauge", samples: [{ labels: { version: serverVersion(), role: "mesh", mode: instance.mode, mesh: config.meshId }, value: 1 }] },
      { name: "agent_mesh_uptime_seconds", help: "Seconds since the server started.", type: "gauge", samples: [{ value: Math.round((Date.now() - startedAt) / 1000) }] },
      { name: "agent_mesh_events_total", help: "Events in the log.", type: "counter", samples: [{ value: m.events }] },
      { name: "agent_mesh_messages_total", help: "Messages sent.", type: "counter", samples: [{ value: m.messages }] },
      { name: "agent_mesh_activations_total", help: "Agent turns taken.", type: "counter", samples: [{ value: m.activations }] },
      { name: "agent_mesh_tokens_total", help: "Tokens the mesh has counted against its budgets.", type: "counter", samples: [{ value: m.tokensTotal }] },
      { name: "agent_mesh_mission_tokens_limit", help: "The mission token budget; absent when there is none.", type: "gauge", samples: mission?.limit != null ? [{ value: mission.limit }] : [] },
      { name: "agent_mesh_artifacts", help: "Artifacts in the ledger.", type: "gauge", samples: [{ value: m.artifacts }] },
      { name: "agent_mesh_tasks", help: "Tasks by state.", type: "gauge", samples: [{ labels: { state: "open" }, value: m.openTasks }, { labels: { state: "completed" }, value: m.completedTasks }] },
      { name: "agent_mesh_escalations_open", help: "Escalations waiting for an operator.", type: "gauge", samples: [{ value: m.escalationsOpen }] },
      {
        name: "agent_mesh_agents",
        help: "Seats by lifecycle state.",
        type: "gauge",
        samples: Object.entries(seatsByLifecycle).map(([lifecycle, value]) => ({ labels: { lifecycle }, value })),
      },
      { name: "agent_mesh_event_loop_lag_seconds", help: "How late the last one-second timer fired.", type: "gauge", samples: [{ value: loopLagMs / 1000 }] },
      { name: "agent_mesh_sse_clients", help: "Event-stream subscribers connected to this server.", type: "gauge", samples: [{ value: hub.clientCount }] },
      ...licenseMetrics(licenses.current().entitlements, { seats: seatsInUse() }),
    ];
  };

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
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { "content-type": "application/json" });
      // Compact serialization: pretty-printing roughly doubles large payloads
      // (timelines, traces) for zero client benefit — every consumer parses.
      res.end(JSON.stringify(body));
    };
    /**
     * Every JSON response, with a durability barrier in front of the ones that
     * are receipts.
     *
     * `EventStore.append` returns before the line reaches disk — a deliberate
     * throughput trade, with the crash window bounded by an fsync every
     * SYNC_EVERY appends rather than closed. That trade is right nearly
     * everywhere and wrong at one moment: when we hand an id back over the
     * wire. From then on something outside this process treats the event as
     * having happened, and it has no way to ever learn otherwise — so a crash
     * inside the window does not lose an event, it turns a 202 into a lie.
     *
     * The barrier is per receipt, not per append, which is the distinction
     * `flush()`'s contract asks for: a turn that emits forty events pays one
     * fsync, on the reply that mentions them. Reads skip it entirely, and
     * `flush()` costs nothing on a store with no pending write, so the
     * read-only MCP tool calls that share this path stay free.
     *
     * A flush that throws becomes a 500 rather than the 2xx it was going to
     * be: learning that the write failed is the whole reason to wait for it.
     * The event is still in memory and still applied, so this is not a
     * retryable failure — it reports that the log behind this mesh has
     * stopped accepting writes, and a retry would only re-apply the action.
     */
    const json = async (code: number, body: unknown): Promise<void> => {
      if (req.method !== "GET" && code >= 200 && code < 300) {
        try {
          await store.flush?.();
        } catch (err) {
          return send(500, {
            error: `event log write failed: ${(err as Error).message}`,
            code: "event_log_not_durable",
            retryable: false,
          });
        }
      }
      send(code, body);
    };
    // Bounded: an unbounded read let one streaming POST exhaust the process's memory.
    // Over the limit it throws `PayloadTooLargeError`, which the catch at the end of
    // this function turns into a 413.
    const body = async (limit: number = maxBodyBytes()): Promise<Record<string, any>> => {
      const raw = (await readBody(req, limit)).toString("utf8");
      if (!raw) return {};
      try {
        return JSON.parse(raw);
      } catch {
        return {};
      }
    };
    const designerBusy = (): Promise<void> => {
      res.setHeader("retry-after", "5");
      return json(429, { error: `the designer is already working on ${MAX_DESIGNER_TURNS} conversations; wait for one to finish`, code: "designer_busy" });
    };
    try {
      // The headers every answer carries. A route that serves the dashboard or an agent's
      // preview replaces them just before it writes its own.
      applySecurityHeaders(res, "api");

      // ------------------------------------------------------------ probes
      // Ahead of the guard and of auth: a kubelet addresses the pod by IP and holds no
      // credential, and the answer is one word with no counts or ids in it. `/health`
      // below is the detailed one.
      if (req.method === "GET" && parts.length === 1 && (parts[0] === "healthz" || parts[0] === "readyz")) {
        if (parts[0] === "healthz") return send(200, { status: "ok" });
        return draining ? send(503, { status: "draining" }) : send(200, { status: "ready" });
      }

      // A browser page the operator happens to visit must not be able to drive this server:
      // `Host` stops DNS rebinding, `Origin` stops a forged cross-site POST. See web-security.ts.
      const verdict = guardRequest(req);
      if (!verdict.ok) return send(verdict.status, { error: verdict.error, code: verdict.code });

      // ------------------------------------------------------------ sign-in
      // The dashboard trades the operator token for a session cookie here (see sessions.ts). It
      // cannot require being signed in, so it sits ahead of `requireAuth`; the guard above has
      // already turned away a foreign origin. Not served in strict mode: a child has no browser.
      if (await handleAuthRoute(req, res, parts, { sessions, limiter, readBody: () => body(4096), send, audit: (line) => appendLog("auth-audit.log", line) })) return;

      // ------------------------------------------------- playground capability
      // The sandboxed playground page reads its own files here. It carries neither cookie nor
      // bearer (see preview.ts), so the proof is in the path: a signed, expiring capability the
      // signed-in dashboard minted. Ahead of operator auth on purpose, and checked here rather
      // than trusting a host's bearer, which a child accepts for every proxied request.
      if (parts[0] === PREVIEW_PREFIX && parts.length >= 2 && req.method === "GET") {
        if (!previews.verify(parts[1])) return send(403, { error: "this playground link is not valid, or has expired: reopen the playground from the dashboard" });
        return servePreviewCapability(res, parts.slice(2));
      }

      // --------------------------------------------------------- MCP bridge
      // Deliberately ahead of `requireAuth`: seats carry no operator token (in
      // strict mode requireAuth would refuse them all). That is sound only
      // because every toolset below refuses a request whose token fails
      // `McpToolset.verifyToken` — a seat HMAC under a per-process secret, or
      // for `human` the minted bridge secret / operator token, all compared in
      // constant time. None of them is derivable from public ids.
      if (parts[0] === "internal" && parts[1] === "mcp") {
        const agentId = decodeURIComponent(parts[2] ?? "");
        const rawToken = req.headers["x-mesh-token"] ?? u.searchParams.get("token");
        const token = Array.isArray(rawToken) ? (rawToken[0] ?? "") : (rawToken ?? "");
        // This route answers before operator auth, so it was the one place an unauthenticated
        // caller could make the server buffer a request body of any size. A bridge always
        // presents a token: no token is refused without reading anything, and a token that
        // fails is read only as far as a JSON-RPC error needs (its `id`), and refused with a 413
        // beyond that. Only a token that verifies earns the full body.
        if (!token) return send(401, { error: "missing mesh token" });
        const verified = mcp.verifyToken(agentId, String(token));
        const payload = await body(verified ? MCP_MAX_BODY_BYTES : MCP_UNVERIFIED_BODY_BYTES);
        // A designer turn identifies itself with a header the SERVER minted and
        // handed to the runtime; the model never sees it and cannot name a
        // different turn. Without the header this is the ordinary bridge.
        // `?staging=1` is baked into the bridge's URL at spawn time and says
        // "this caller is a designer chat"; the header, when a runtime can send
        // one, says WHICH turn. A bridge that can only manage the former still
        // works — the toolset resolves the turn and refuses if it is ambiguous.
        const turnId = req.headers["x-mesh-designer-turn"] ?? u.searchParams.get("turn");
        if (turnId || u.searchParams.get("staging") === "1") {
          const staged = await mcpStaging.handle(agentId, String(token ?? ""), turnId ? String(turnId) : undefined, payload);
          return json(200, staged);
        }
        const toolset = u.searchParams.get("readOnly") === "1" ? mcpReadOnly : mcp;
        const result = await toolset.handle(agentId, String(token ?? ""), payload);
        return json(200, result);
      }

      // Operator auth: enforced when MESH_API_TOKEN is set. Public paths
      // (/health, dashboard assets) bypass; everything else needs Bearer.
      const auth = requireAuth(req, u, parts, { sessions, limiter });
      if (!auth.ok) {
        if (auth.retryAfterSec) res.setHeader("retry-after", String(auth.retryAfterSec));
        return json(auth.status ?? 401, { error: auth.error });
      }
      const knownAgents = new Set(kernel.state.agents.keys());
      knownAgents.add(HUMAN_AGENT_ID);

      // Every state-changing request that got this far, once, with how it was authorised and what
      // became of it. The per-decision lines in auth-audit.log say what an operator ruled; this says
      // that a reset, a restore, a config save or a script run was asked for at all, and by whom to
      // the extent a shared token can say (a session, a token, or an open server), from where.
      if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
        const via = callerKind(req, { sessions });
        const ip = clientKey(req);
        res.on("finish", () => appendLog("mutations.log", `${req.method} ${auditField(u.pathname)} status=${res.statusCode} via=${via} ip=${auditField(ip)}`));
      }

      // ------------------------------------------------------------ commercial
      // What this install is entitled to and how much of it is in use.
      if (parts[0] === "license" && parts.length === 1 && req.method === "GET") {
        return json(200, licenseView(licenses.current(), { seats: seatsInUse() }));
      }
      // Usage by day, seat and model from this mesh's event log: tokens exact, dollars an estimate that says so.
      if (parts[0] === "usage" && parts.length === 1 && req.method === "GET") {
        const gate = checkFeature(licenses.current().entitlements, "usage-export", "Usage export");
        if (gate.blocked) return json(403, { error: gate.message, code: "license_feature", feature: "usage-export" });
        const parsed = parseUsageQuery(u.searchParams);
        if (!parsed.ok) return json(400, { error: parsed.error });
        const logs = [{ project: config.meshId, file: `${config.stateDir}/logs/events.jsonl` }];
        const answer = await usageAnswer(logs, [], parsed.query, configuredPrices(), gate.ok ? undefined : gate.message);
        res.writeHead(200, { "content-type": answer.contentType, ...(answer.disposition ? { "content-disposition": answer.disposition } : {}) });
        res.end(answer.body);
        return;
      }
      // For a scraper; behind the same credential as everything else.
      if (parts[0] === "metrics" && parts[1] === "prometheus" && parts.length === 2 && req.method === "GET") {
        const gate = checkFeature(licenses.current().entitlements, "prometheus-metrics", "The Prometheus endpoint");
        if (gate.blocked) return json(403, { error: gate.message, code: "license_feature", feature: "prometheus-metrics" });
        res.writeHead(200, { "content-type": PROMETHEUS_CONTENT_TYPE });
        res.end(renderPrometheus(meshMetrics()));
        return;
      }

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
          // What load() threw away to make the log replayable (counters only:
          // O(1) once loaded, so the probe stays zero-work). Absent for an
          // in-memory store, which has no file to damage.
          ...(instance.store instanceof JsonlEventStore ? { logIntegrity: instance.store.integrity() } : {}),
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
          // 200 either way — the goal really did resume. But on a parked mission
          // a resumed goal is indistinguishable from a running one on every
          // surface, and it runs nothing: say so, in the same words the console's
          // banner and the host's audit line use. Re-read after the call: the
          // projection is what resumed it, and `goal` above is the pre-resume
          // reading.
          const resumed = kernel.state.goals.get(goalId);
          const parked = isParkedNoticeState(instance.mode, resumed?.status);
          return json(200, { ok: true, mode: instance.mode, notice: parked ? PARKED_MISSION_NOTICE : null });
        }
        if (parts[2] === "replay" && req.method === "GET") {
          const upTo = u.searchParams.get("upToSeq");
          const state = await supervisor.replay(goalId, upTo ? Number(upTo) : undefined);
          return json(200, state);
        }
        // End-of-run summary: goal, verdict, accepted artifacts, evidence,
        // escalations and unfinished work, composed by core's run-report
        // module from the same projections every other read view uses.
        if (parts[2] === "run-report" && req.method === "GET") {
          if (!goal) return json(404, { error: "goal not found" });
          const buildRunReport = loadRunReportBuilder();
          if (!buildRunReport) {
            return json(501, {
              error: "run report is unavailable in this build (packages/core/src/run-report.ts is missing or exports no builder)",
              code: "run_report_unavailable",
            });
          }
          const report = await buildRunReport(kernel.state, goalId);
          if (report == null) return json(404, { error: `no run report for goal ${goalId}` });
          return json(200, report);
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
          // The gate the seat actually runs under, described by the same function
          // that enforces it. The dashboard used to derive this itself from a
          // mirror of the deleted OpenCode runtime, and showed "edit: deny" on
          // seats whose Write calls went through. Null: no local gate to describe
          // (http, stub) — the backend decides. "claude" always resolves to the
          // real adapter: bootstrap registers it after any runtime overrides.
          const permissions = rec.definition.runtime === "claude"
            ? { runtime: rec.definition.runtime, families: describeToolPermissions(rec.definition.capabilities ?? [], rec.definition.requiresApproval ?? []) }
            : null;
          let detail: ReturnType<typeof buildAgentDetail> = null;
          try {
            const events = await store.read({ tail: 800 });
            // The shared fill, not a private merge: this route's copy invented
            // zero ops for every tracker turn older than its 800-event window.
            const live = supervisor.getRecentTurns(stepLimit * 2);
            const steps = (await fillTurnSteps(events, live, store, stepLimit * 2))
              .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
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
              unread: resolveUnread(kernel.state, id),
              memory: [...(kernel.state.memory.get(id)?.values() ?? [])],
              session: kernel.state.sessionMap.get(id) ?? null,
              permissions,
            });
          }
          return json(200, { ...detail, permissions });
        }
        if (req.method === "POST" && parts[2] === "wake") {
            const result = await supervisor.activateAgent(id, { kind: "manual", note: "manual wake via API" });
            return json(result.queued ? 200 : 409, { ok: result.queued, queued: result.queued, reason: result.blocked });
          }
        // Stop the seat's running turn. Not a failure: the turn is discarded as
        // `interrupted`, billed what it spent, and the seat goes IDLE with its
        // task and mail — or SUSPENDED with `suspend: true`, until /resume.
        if (req.method === "POST" && parts[2] === "interrupt") {
          if (!rec) return json(404, { error: "agent not found" });
          const b = await body();
          if (b.reason !== undefined && typeof b.reason !== "string") return json(400, { error: "`reason` must be a string" });
          if (b.suspend !== undefined && typeof b.suspend !== "boolean") return json(400, { error: "`suspend` must be a boolean" });
          const res = await supervisor.interruptTurn(id, { reason: b.reason, suspend: b.suspend === true });
          if (!res.ok) {
            return json(res.code === "unknown_agent" ? 404 : 409, { ok: false, error: res.error, code: res.code, ...(res.lifecycle ? { lifecycle: res.lifecycle } : {}) });
          }
          return json(200, { ok: true, turnId: res.turnId, settled: res.settled, endedAs: res.endedAs, lifecycle: res.lifecycle });
        }
        // A seat mid-turn is stopped first (the operator path above, with
        // `suspend`), so the suspension is not undone by that turn's own ending.
        if (req.method === "POST" && parts[2] === "suspend") {
          const res = await supervisor.suspendAgent(id);
          return json(200, { ok: true, ...(res.stoppedTurnId ? { stoppedTurnId: res.stoppedTurnId, settled: res.settled } : {}) });
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
          const read = await readContentResult(instance, target.contentRef);
          if (!read.ok) {
            // 503, not an empty 200: the artifact EXISTS in the manifest but
            // its bytes do not resolve, which is a storage fault to surface.
            return json(503, {
              error: `artifact content is unreadable: ${read.error}`,
              code: "artifact_content_unreadable",
              artifactId: id,
              version: target.version,
              contentRef: target.contentRef,
              retryable: true,
            });
          }
          res.writeHead(200, {
            "content-type": "text/plain; charset=utf-8",
            "x-artifact-version": String(target.version),
            "x-artifact-digest": String(target.digest ?? ""),
          });
          res.end(read.text);
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
          // Same rule as /content, and it matters more here: a failed read
          // coerced to "" makes diffText report the entire file as added or
          // removed, i.e. a whole-file rewrite that never happened.
          const beforeRead: ContentRead = from && fromN !== toN ? await readContentResult(instance, from.contentRef) : { ok: true, text: "" };
          const afterRead: ContentRead = await readContentResult(instance, to.contentRef);
          const unreadable = (reason: string, version: number): Promise<void> =>
            json(503, {
              error: `artifact content is unreadable: ${reason}`,
              code: "artifact_content_unreadable",
              artifactId: id,
              version,
              retryable: true,
            });
          if (!beforeRead.ok) return unreadable(beforeRead.error, from ? from.version : to.version);
          if (!afterRead.ok) return unreadable(afterRead.error, to.version);
          const d = diffText(beforeRead.text, afterRead.text);
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
        // A Map, not an object: the key is a model id from an event, and `models["__proto__"]` on a plain
        // object is Object.prototype itself, which `.calls++` would then write to.
        const perModel = new Map<string, { calls: number; tokens: number }>();
        for (const e of consumed) {
          const p = e.payload as { model?: string; amount?: number; limitKind?: string };
          if (p.model && p.limitKind !== "events" && p.limitKind !== "wallclock_minutes") {
            const seen = perModel.get(p.model) ?? { calls: 0, tokens: 0 };
            seen.calls++;
            seen.tokens += p.amount ?? 0;
            perModel.set(p.model, seen);
          }
        }
        const models = Object.fromEntries(perModel);
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
          fs.appendFileSync(auditFile, `${new Date().toISOString()} approvals by=${auditField(by)} kind=${auditField(kind)} subject=${auditField(b.subject ?? "release")}\n`, "utf8");
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

      // -------------------------------------------------- tool approvals
      // Deliberately not folded into /approvals above: that route decides
      // artifacts and releases via recordDecision, and its kinds (approve,
      // pass, veto, merge) are all judgements ABOUT work. This unlocks a tool
      // for a seat, which is a different subject with a different lifetime,
      // and overloading a decision kind would have made both harder to read.
      if (parts[0] === "tool-approvals" && req.method === "GET" && parts.length === 1) {
        return json(200, { seats: supervisor.listToolApprovals() });
      }
      if (parts[0] === "tool-approvals" && req.method === "POST" && parts.length === 1) {
        const b = await body();
        const agentId = typeof b.agentId === "string" ? b.agentId.trim() : "";
        const tool = typeof b.tool === "string" ? b.tool.trim() : "";
        if (!agentId || !tool) return json(400, { ok: false, reason: "provide `agentId` and `tool`" });
        const revoke = b.revoke === true;
        // A grant on a seat that gates nothing is recorded and then never
        // consulted by anything, so a 200 here tells an operator they unlocked
        // a tool when they did not. 404 would be the opposite lie — the seat is
        // right there in the roster — so an ungated seat is refused with 409,
        // the code this host already uses for "exists, but not in a state where
        // what you asked for means anything".
        if (!revoke) {
          const seat = instance.config.agents[agentId];
          if (!seat) return json(404, { ok: false, reason: `unknown agent '${agentId}'` });
          if ((seat.requiresApproval?.length ?? 0) === 0) {
            return json(409, { ok: false, reason: `'${agentId}' gates no tools — it sets no \`requires_approval\`` });
          }
        }
        const ok = revoke ? supervisor.revokeToolApproval(agentId, tool) : supervisor.grantToolApproval(agentId, tool);
        if (!ok) {
          return json(404, {
            ok: false,
            reason: revoke ? `no grant for '${tool}' on '${agentId}'` : `unknown agent '${agentId}'`,
          });
        }
        try {
          const auditFile = `${instance.config.stateDir}/logs/auth-audit.log`;
          fs.mkdirSync(`${instance.config.stateDir}/logs`, { recursive: true });
          fs.appendFileSync(
            auditFile,
            `${new Date().toISOString()} tool-approval ${revoke ? "revoke" : "grant"} agent=${auditField(agentId)} tool=${auditField(tool)}\n`,
            "utf8",
          );
        } catch {
          /* audit never breaks the runtime */
        }
        // Does not resume the seat — pair with POST /agents/:id/wake. An
        // operator clearing several requests should wake once, not per grant.
        return json(200, { ok: true, agentId, tool, granted: !revoke });
      }

      // ------------------------------------------------------- escalations
      if (parts[0] === "escalations") {
        if (req.method === "GET" && parts.length === 1) {
          return json(200, paginateCompat([...kernel.state.escalations.values()], u, 100));
        }
        // Raise the host's spend-ceiling card. The only create verb on this
        // resource, and narrow on purpose: it names no `reason` and takes no
        // prose, only the two numbers the card displays. A general
        // `POST /escalations { reason, detail }` would be the same amount of
        // code and would hand anyone holding this child's token — or an
        // operator token, which the host proxy exchanges for one — a way to
        // mint arbitrary cards into a mission's log, where they are
        // indistinguishable from ones the mesh raised about itself. Widening
        // this later is a smaller decision than narrowing it after something
        // starts depending on the wide version.
        //
        // Sits here, after the operator-auth check above, and NOT beside
        // `/internal/mcp`: the bridge is pre-auth because a per-agent token is
        // the credential it verifies itself. This route has no such check of
        // its own, so the bearer check is the whole of its protection.
        if (req.method === "POST" && parts[1] === "host-ceiling" && parts.length === 2) {
          const b = await body();
          const usd = Number(b.usd);
          const ceilingUsd = Number(b.ceilingUsd);
          // Both are rendered into operator-facing copy and one of them is
          // hashed into the conflictKey, so neither may be NaN, Infinity or
          // negative — a card reading "$NaN" is worse than no card.
          if (!Number.isFinite(usd) || usd < 0) return json(400, { ok: false, reason: "provide a non-negative numeric `usd`" });
          if (!Number.isFinite(ceilingUsd) || ceilingUsd < 0) return json(400, { ok: false, reason: "provide a non-negative numeric `ceilingUsd`" });
          const esc = await supervisor.escalate({
            reason: HOST_SPEND_CEILING_REASON,
            raisedBy: HOST_LIMITER_RAISER,
            // Keyed by the ceiling that was breached, not by a constant. A
            // constant would dedupe against a card still open from an earlier,
            // lower ceiling, so raising the ceiling and spending through the
            // new one would silently reuse a card quoting the old numbers —
            // the same swallow this route exists to fix, one layer down.
            conflictKey: `host:spend-ceiling:${ceilingUsd}`,
            detail: { usd, ceilingUsd },
          });
          return json(200, { ok: true, id: esc.id, reason: esc.reason });
        }
        if (req.method === "POST" && parts[1] && parts[2] === "respond") {
          const b = await body();
          const actor = resolveActor(b.by ?? HUMAN_AGENT_ID, knownAgents);
          if (!actor.ok) return json(403, { ok: false, reason: actor.error });
          try {
            const auditFile = `${instance.config.stateDir}/logs/auth-audit.log`;
            fs.mkdirSync(`${instance.config.stateDir}/logs`, { recursive: true });
            fs.appendFileSync(auditFile, `${new Date().toISOString()} escalation.respond id=${auditField(decodeURIComponent(parts[1]))} by=${auditField(actor.actor)}\n`, "utf8");
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
        // Each subscriber holds a socket and a buffer for as long as it stays. One that keeps
        // reconnecting must be refused, not served until the process runs out of descriptors.
        if (hub.full) {
          res.setHeader("retry-after", "5");
          return json(503, { error: "too many event-stream subscribers on this server; close a tab or raise MESH_MAX_SSE_CLIENTS", code: "sse_capacity" });
        }
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
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
        // The tail scan is scaled to the requested output; tracker turns older
        // than it are read through the correlation index instead of being
        // reported with counts nobody measured (see `fillTurnSteps`).
        return json(200, await recentTurnSteps(store, supervisor.getRecentTurns(limit), limit));
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
        const scanned = await store.read({ tail: 2000 });
        // Back in log order: the extras used to be appended after the indexed
        // events, so the timeline showed them after the turn had closed.
        const related = turnEvents(byCorrelation, scanned.filter((e) => namesTurn(e, id)));
        if (!turn && related.length === 0) return json(404, { error: "turn not found" });
        // The log's own account of the turn, counted from exactly the events
        // shown beside it. The drawer used to take its ops from the `/steps`
        // row, which could be a different (and, past the window, invented)
        // answer to the same question.
        const step = buildTurnSteps(related, Infinity).find((s) => s.turnId === id) ?? null;
        return json(200, { turn: turn ?? null, events: related, timeline: eventTimeline(related, related.length), step });
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
          // The state that hides itself, said out loud: parked, with an ACTIVE
          // goal. Non-null only then, so a client that renders it whenever it is
          // present shows exactly the banner this exists for — and reads the
          // wording from here rather than keeping a copy that can drift from the
          // one `POST /goals/:id/resume` returns.
          parkedNotice: isParkedNoticeState(instance.mode, kernel.state.goals.get(kernel.state.activeGoalId ?? "")?.status)
            ? PARKED_MISSION_NOTICE
            : null,
          // How many seats boot was *asked* to activate. Lets the console tell
          // "nobody was ever configured to start" apart from "they were
          // configured and something stopped them".
          startupActivateCount: config.startupActivate.length,
          // …and which of those two it was, kept past the boot response that
          // used to be its only carrier. Without it the console can only offer
          // "refused at boot, or started and has since stopped" as a guess on
          // precisely the screen an operator opens to stop guessing.
          lastBoot: instance.lastBoot,
          // `waits` says why the queued ones are not running. It is live state
          // rather than a log entry on purpose: a capacity block emits no
          // event (it is not a refusal and clears itself), so the console
          // cannot derive this from the event buffer the way it derives
          // standing policy refusals.
          // `triagedAway` rides the same channel for a different kind of loss:
          // not a block that clears, but events dropped before anything was
          // queued, which no surface could otherwise report.
          // `suppressed` is the same kind of loss broken out by reason, so an
          // escalation hold or a redundant progress tick is readable too.
          scheduler: { pending: instance.scheduler.pending(), running: instance.scheduler.running(), queue, waits: instance.scheduler.queueWaits?.() ?? [], triagedAway: instance.scheduler.triagedAwayCount?.() ?? 0, suppressed: instance.scheduler.suppressedWakes?.() ?? {} },
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
          const { alreadyLive, activated, refused } = await instance.goLive();
          void alreadyLive;
          // The old note fell back to printing config.startupActivate whenever
          // `activated` was empty, so a boot in which every seat was blocked
          // reported the blocked seats as if they had started. Name only what
          // actually queued, and say why the rest did not.
          const summary = config.startupActivate.length === 0
            ? "no startup agents configured"
            : [
                `activated: ${activated.join(", ") || "(none)"}`,
                ...(refused.length ? [`blocked: ${refused.map((x) => `${x.agentId} (${x.reason})`).join(", ")}`] : []),
              ].join("; ");
          return json(200, { ok: true, started: true, mode: instance.mode, activated, refused, note: `scheduler live; ${summary}` });
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
      // Destructive: wipes the mission back to tick zero. Everything the old
      // run produced is archived first — state dir, product checkout, worktrees
      // and their branches — so the operation is recoverable, but the live mesh
      // loses every agent session, event, budget and artifact link.
      //
      // Both `confirm:true` and a typed `confirmId` are mandatory. The boolean
      // alone is a constant: it stops an accident, not a caller. See the guard
      // below for why that distinction matters on this route in particular.
      if (parts[0] === "mission" && parts[1] === "reset" && req.method === "POST") {
        const b = await body();
        if (b?.confirm !== true) {
          return json(400, { ok: false, error: "reset requires confirm:true — this wipes the whole mission" });
        }
        // `confirm:true` is a constant, and this route is reachable without a
        // token when MESH_API_TOKEN is unset — so on its own it let
        // `curl -d '{"confirm":true}'` wipe a running mission. Typing the mesh
        // id is the part a stray retry, a crawler, or a pasted shell history
        // entry cannot supply.
        if (!matchesMeshId(b.confirmId, config.meshId)) {
          return json(409, {
            ok: false,
            error: `reset requires confirmId set to this mesh's id — type "${config.meshId}"`,
            meshId: config.meshId,
          });
        }
        let report;
        try {
          report = await instance.reset({ keepArtifacts: b.keepArtifacts === true });
        } catch (err) {
          if (err instanceof ResetInProgressError) {
            // 409, not 500: the request was well-formed and the mesh refused it,
            // same as the confirmId guard above.
            return json(409, {
              ok: false,
              error: "a mission reset is already in progress — wait for it to finish. A second reset races the first and aborts partway, leaving a half-written archive.",
            });
          }
          throw err;
        }
        const cleaned = report.worktreesRemoved.length ? `${report.worktreesRemoved.length} worktree(s) removed; ` : "";
        const product = report.productArchivedTo ? "product checkout archived; " : "";
        // Name the uncommitted work explicitly. It is the one thing a reset
        // touches that never reached the product, so an operator reading only
        // "worktrees removed" has no way to know work was lost from the mission
        // even though the files were copied aside.
        const uncommittedTotal = Object.values(report.uncommittedByAgent).reduce((a, b) => a + b, 0);
        const uncommitted = uncommittedTotal
          ? `${uncommittedTotal} uncommitted file(s) across ${Object.keys(report.uncommittedByAgent).length} worktree(s) never reached the product${report.uncommittedManifestTo ? ` (listed in ${report.uncommittedManifestTo})` : ""}; `
          : "";
        return json(200, {
          ...report,
          note: report.archivedTo
            ? `mission reset to zero; ${cleaned}${uncommitted}${product}previous state archived outside the workspace at ${report.archivedTo}. Mesh is parked — press continue to start the new run.`
            : `mission reset to zero; ${cleaned}${uncommitted}${product}mesh is parked — press continue to start the new run.`,
        });
      }
      // The archives reset has left behind, newest first. Read-only, and the
      // only way to discover a stamp to restore.
      if (parts[0] === "mission" && parts[1] === "backups" && req.method === "GET") {
        return json(200, { meshId: config.meshId, backups: instance.backups() });
      }
      // The inverse of reset: put an archived mission back. Deliberately does
      // NOT park for you — reset may park because it is about to destroy
      // things, but a restore harms nothing by waiting, and silently stopping
      // a running mission in order to restore over it is how an operator loses
      // a run they meant to keep.
      if (parts[0] === "mission" && parts[1] === "restore" && req.method === "POST") {
        const b = await body();
        if (instance.inMemory) {
          return json(409, { ok: false, error: "an in-memory mesh has no state dir to restore into" });
        }
        if (!matchesMeshId(b?.confirmId, instance.config.meshId)) {
          return json(409, {
            ok: false,
            error: `restore requires confirmId set to this mesh's id — type "${config.meshId}"`,
            meshId: config.meshId,
          });
        }
        if (instance.mode !== "parked") {
          return json(409, {
            ok: false,
            error: "restore needs the mission parked — stop it first. Nothing is lost by waiting, so this refuses rather than parking for you.",
          });
        }
        const stamp = typeof b?.stamp === "string" ? b.stamp.trim() : "";
        if (!stamp) {
          return json(400, { ok: false, error: "restore requires a stamp — list them with GET /mission/backups" });
        }
        const withStamp = instance.backups().filter((a) => a.stamp === stamp);
        if (withStamp.length === 0) {
          return json(404, { ok: false, error: `no backup with stamp ${stamp}` });
        }
        const chosen = withStamp.find((a) => a.hasEvents);
        if (!chosen) {
          return json(400, {
            ok: false,
            error:
              `stamp ${stamp} has no state archive (found: ${withStamp.map((a) => a.kind).join(", ")}). ` +
              `Only the state archive carries the mission log; the product checkout and the agent worktrees cannot be restored — ` +
              `reading them back over a live product would overwrite work with no way to merge.`,
          });
        }
        if (readLogTailSeq(path.join(chosen.path, "logs", "events.jsonl")) === null) {
          return json(404, {
            ok: false,
            error: `backup ${chosen.name} holds no events — it is the archive of an empty mission, and restoring it would change nothing.`,
          });
        }
        const report = await instance.restore(chosen.path, { keepSessions: b?.keepSessions === true });
        return json(200, {
          ...report,
          note: [
            `mission restored from ${chosen.name}`,
            `${report.events} event(s)`,
            report.goalId ? `goal ${report.goalId}` : "no goal in the restored log",
            report.previousArchivedTo ? `the state it replaced was archived at ${report.previousArchivedTo}` : null,
            report.snapshotDropped ? "the archive's snapshot was newer than its log and was dropped" : null,
            report.sessionsDropped ? "agent sessions were not carried over, so every seat starts a fresh turn" : null,
            "mesh is parked — press continue to start the restored run",
          ]
            .filter(Boolean)
            .join("; "),
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
        // The running file can be overwritten while this process still serves
        // the boot config; the designer treats this endpoint as the file's
        // current bytes, so re-read it and fall back to the boot snapshot only
        // when the file is unreadable.
        let raw = config.raw;
        try {
          raw = loadMeshFile(config.filePath);
        } catch {
          /* keep the boot snapshot */
        }
        return json(200, { filePath: config.filePath, dir: config.dir, raw });
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
          // Config-time warnings (inert keys, unreachable agents, ungranted
          // approval gates, uncovered capabilities, …) are computed during
          // resolve and were being dropped here, so the designer only ever saw
          // the gate check below. Forward them: the client already renders
          // whatever this array holds.
          //
          // Minus the gate-actor warnings. validateTransitionGateActors in
          // packages/config reports the same unsatisfiable gates the
          // policy-engine check below reports, in different words — forwarding
          // both shows the operator one defect twice. Keep the policy-engine
          // one: it is strictly stronger, since it also checks the named agent
          // can actually record the approval, which config cannot see.
          const warnings: string[] = resolved.warnings.filter((w) => !w.startsWith("transition gate '"));
          // Warnings this route can raise on a WRITE and nowhere else, kept apart
          // from the list above. The distinction is not decorative: `warnings`
          // here is byte-identical to what /config/validate returns for the same
          // document (both resolve against `baseDir`), so the designer's health
          // strip already shows all of it from the debounced validate. A save-only
          // entry cannot be reproduced by any later validate — it is a fact about
          // `dirname(target)`, a directory validate is never told about. Handing it
          // to the strip would put a claim in a channel whose next refresh would
          // delete it whether or not the operator fixed anything. So it rides its
          // own field, and the client shows it on the post-save card, which the
          // next edit or save clears.
          const saveWarnings: string[] = [];
          // Schema-valid drafts can still name a gate actor no agent can play,
          // or an approve the named agent has no way to record. Run the same
          // satisfiability preflight the designer-proposal path runs so manual
          // edits get the same verdict as AI proposals.
          for (const issue of validateTransitionGates(resolved.raw.policies?.transitions, resolved.raw.agents)) {
            warnings.push(`gate '${issue.gate}' token '${issue.token}': ${issue.reason}`);
          }
          let target: string | null = null;
          let archived: string | null = null;
          let createdPrompts: ReturnType<typeof materializeRolePrompts> = [];
          if (parts[1] === "save") {
            if (!b.path) return json(400, { valid: false, errors: ["save requires a path"] });
            // Contained to the project's config directory by the same rule the
            // workspace file routes use. This route writes a file, creates
            // directories and materializes prompt files next to it, so an
            // uncontained `b.path` was an arbitrary-write primitive for anyone
            // holding (or, unauthenticated, not needing) the operator token.
            // A relative path now resolves against the config dir rather than
            // the server's cwd, so the designer's "save a copy" still works for
            // `examples/my-mesh/mesh.yaml`-shaped paths — inside the project.
            const configRoot = path.resolve(config.dir);
            const contained = resolveInside(configRoot, String(b.path));
            if (!contained) {
              return json(400, { valid: false, errors: [`save path escapes the project directory (${configRoot})`] });
            }
            target = contained;
            if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, "mesh.yaml");
            fs.mkdirSync(path.dirname(target), { recursive: true });
            // Keep the bytes we are about to overwrite as a recoverable version:
            // the save UI has no undo once it commits the new baseline.
            const previous = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;
            if (previous !== null && previous !== yamlText) {
              const versionsDir = path.join(path.dirname(target), ".mesh-versions");
              fs.mkdirSync(versionsDir, { recursive: true });
              const stamp = new Date().toISOString().replace(/[:.]/g, "-");
              const base = path.basename(target).replace(/\.(ya?ml)$/i, "");
              let candidate = path.join(versionsDir, `${base}-${stamp}.yaml`);
              for (let n = 2; fs.existsSync(candidate); n += 1) candidate = path.join(versionsDir, `${base}-${stamp}-${n}.yaml`);
              fs.writeFileSync(candidate, previous, "utf8");
              archived = candidate;
            }
            fs.writeFileSync(target, yamlText, "utf8");
            const dir = path.dirname(target);
            // Make the prompt refs this save just wrote real, or the project
            // opens as invalid_config. Existing files are never overwritten.
            createdPrompts = materializeRolePrompts(resolved.raw, dir);
            for (const id of Object.keys(resolved.raw.agents)) {
              const p = resolved.raw.agents[id].prompt;
              if (p && !fs.existsSync(path.resolve(dir, p))) {
                // In both lists on purpose: `warnings` stays a complete account of
                // this response, and `saveWarnings` is the part of it that only a
                // write can know. materializeRolePrompts above skipped this one —
                // it is absolute, or it escapes the save directory — so this ref
                // is still dangling on disk.
                const msg = `agent '${id}' prompt file not found (relative to ${dir}): ${p}`;
                warnings.push(msg);
                saveWarnings.push(msg);
              }
            }
          }
          /* A Save that overwrote the RUNNING config leaves the file and the live
           * mesh disagreeing, because mesh.yaml is a seed and not a mirror (see
           * ./config-drift). Hand back the exact proposal that would close the
           * gap so the operator can sync in one reviewed click, through the
           * apply route that already carries every guard. Null when this save
           * wrote a copy somewhere else — that file is nobody's running config. */
          let drift: ReturnType<typeof configDrift> | null = null;
          if (parts[1] === "save" && target && path.resolve(config.filePath) === target) {
            try {
              drift = configDrift(resolved, instance);
            } catch {
              /* The save itself succeeded and the bytes are on disk. A failed
               * comparison must not turn that into an error the operator has
               * to interpret; they simply get no sync offer. */
            }
          }
          return json(200, {
            valid: true,
            yaml: yamlText,
            savedTo: target,
            archived,
            drift,
            warnings: [...new Set(warnings)],
            saveWarnings: [...new Set(saveWarnings)],
            createdPrompts,
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

      // ----------------------------------------------- staged mutation apply
      // The operator's commit. The designer assistant only ever *stages*
      // mutations; nothing it authors executes until this route is hit, and
      // this route is hit by a button press.
      //
      // Actor is HUMAN_AGENT_ID, which short-circuits every authority check to
      // ALLOW. That is correct here and only here — the operator is the
      // authority. The guards that actually matter are refusals inside the
      // Supervisor (a criterion removal that would complete the goal, a
      // retirement that is terminal), and no actor can override those.
      if (parts[0] === "designer" && parts[1] === "staged" && parts[2] === "apply" && req.method === "POST" && parts.length === 3) {
        const b = await body();
        const mutations = Array.isArray(b?.mutations) ? b.mutations : Array.isArray(b) ? b : null;
        if (!mutations) return json(400, { ok: false, error: "expected a StagedProposal with a `mutations` array" });
        if (mutations.length === 0) return json(400, { ok: false, error: "proposal contains no mutations" });
        // A typed mesh id, for the mutations that wipe the mission. The
        // executor re-checks it against the config, so this body field is a
        // transport of the operator's confirmation, not the guard itself.
        const report = await applyStagedProposal(mutations as StagedMutation[], instance, {
          confirmId: typeof b?.confirmId === "string" ? b.confirmId : undefined,
        });
        // 409, not 400: the proposal was well-formed and the mesh refused it.
        // And not 500 — a refusal is the guard working, not the server failing.
        // `results` is shorter than `mutations` when one failed; `applied` is
        // how much of the proposal actually landed, which the operator needs to
        // see because events are not a transaction and do not roll back.
        return json(report.ok ? 200 : 409, { ...report, id: typeof b?.id === "string" ? b.id : undefined, mode: instance.mode });
      }

      // ------------------------------------------------------ designer chat
      // Conversational front end for the config designer. The model sees the
      // whole transcript plus the current draft and must answer with the
      // COMPLETE config each turn; the server extracts that proposal and
      // validates it (schema + cross-field rules + gate satisfiability) before
      // the UI can offer to apply it. Stateless by design: the client resends
      // the transcript, so no server-side chat session is kept.
      if (parts[0] === "designer" && parts[1] === "chat" && req.method === "POST" && parts.length === 2) {
        const built = buildDesignerPrompt(await body());
        if ("error" in built) return json(400, { error: built.error });
        if (designerInFlight >= MAX_DESIGNER_TURNS) return designerBusy();
        designerInFlight += 1;
        const { turnId, mcp: mcpOpts } = openDesignerTurn();
        try {
          const reply = await instance.designerRuntime.prompt(built.promptText, { system: DESIGNER_SYSTEM_PROMPT, mcp: mcpOpts, effort: DESIGNER_EFFORT });
          const { proposedConfig, problems, proposal } = closeDesignerTurn(turnId, reply, built.currentConfig);
          return json(200, { reply, proposedConfig, problems, proposal });
        } finally {
          designerInFlight -= 1;
          // `closeDesignerTurn` drains on the happy path; this is the abort
          // path, where the runtime threw and nothing drained the buffer.
          designerTurns.close(turnId);
        }
      }

      // Same turn, streamed as SSE for the "show thinking" view: `thinking`
      // and `text` delta frames while the model runs, then one `final` frame
      // carrying the whole reply (and the reasoning the tap may have missed).
      // The transcript is still client-owned; nothing is persisted here.
      if (parts[0] === "designer" && parts[1] === "chat" && parts[2] === "stream" && req.method === "POST" && parts.length === 3) {
        const built = buildDesignerPrompt(await body());
        if ("error" in built) return json(400, { error: built.error });
        if (designerInFlight >= MAX_DESIGNER_TURNS) return designerBusy();
        designerInFlight += 1;
        // A client that navigates away must not keep the model turn writing
        // into a dead socket; the runtime tap stops when this route returns.
        let closed = false;
        res.on("close", () => { closed = true; });
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        const send = (frame: unknown): void => {
          if (!closed) res.write(`data: ${JSON.stringify(frame)}\n\n`);
        };
        const { turnId, mcp: mcpOpts } = openDesignerTurn();
        try {
          const { reply, thinking } = await instance.designerRuntime.promptStream(
            built.promptText,
            { system: DESIGNER_SYSTEM_PROMPT, mcp: mcpOpts, effort: DESIGNER_EFFORT },
            (delta) => send({ type: delta.kind, delta: delta.delta }),
          );
          const { proposedConfig, problems, proposal } = closeDesignerTurn(turnId, reply, built.currentConfig);
          send({ type: "final", reply, thinking, proposedConfig, problems, proposal });
        } catch (err) {
          send({ type: "error", error: err instanceof Error ? err.message : String(err) });
        } finally {
          designerInFlight -= 1;
          // A client that navigated away mid-turn never reaches the drain, and
          // an abandoned buffer that outlived its turn is exactly the
          // cross-turn write this design must not have.
          designerTurns.close(turnId);
          closed = true;
          res.end();
        }
        return;
      }

      // ----------------------------------------------------------- models
      // Model catalogue for the designer's per-role picker. Proxied from the
      // runtime's own installation rather than hardcoded, so the list matches
      // the providers this machine is actually credentialed for.
      //
      // Cached: resolving it shells out to the Claude CLI, and the
      // designer refetches on every panel mount. `?refresh=1` forces a reload
      // after the operator adds a provider.
      if (parts[0] === "models" && req.method === "GET" && parts.length === 1) {
        const fresh = u.searchParams.get("refresh") === "1";
        const now = Date.now();
        const age = modelCatalogue ? now - modelCatalogue.at : Infinity;
        if (!modelCatalogue || age > MODEL_CATALOGUE_TTL_MS || (fresh && age > MODEL_REFRESH_MIN_MS)) {
          modelRefresh ??= instance.designerRuntime.listModels().finally(() => {
            modelRefresh = undefined;
          });
          const listed = await modelRefresh;
          modelCatalogue = { at: Date.now(), value: listed };
        }
        const { models, default: fallback, error, variants } = modelCatalogue.value;
        // 503, not 200-with-empty-list: an empty catalogue and a failed lookup
        // are different states, and the client renders a retry for the latter.
        if (error) return json(503, { models: [], error });
        return json(200, { models, default: fallback, variants: variants ?? {} });
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
          const git = await gitFacts(wsRoot);
          return json(200, { path: wsRoot, ...git, scripts: Object.keys(runScripts(wsRoot)) });
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
          const head = await gitShow(wsRoot, rel);
          const ab = rel ? resolveInside(wsRoot, rel) : null;
          const workingText = ab ? await fs.promises.readFile(ab, "utf8").catch(() => "") : "";
          const d = diffText(head, workingText);
          return json(200, { path: rel.replace(/\\/g, "/"), from: "HEAD", to: "working tree", ...d });
        }
        if (parts[1] === "changes" && parts.length === 2) {
          return json(200, await gitChanges(wsRoot));
        }
        if (parts[1] === "run" && parts.length === 3) {
          return json(200, runStatus(parts[2]));
        }
      }
      if (parts[0] === "workspace" && parts[1] === "run" && parts.length === 2 && req.method === "POST") {
        const b = await body();
        const script = String(b.script ?? "");
        const defs = runScripts(wsRoot);
        // Own keys only: `script` comes from the request, and "__proto__" is truthy on every object.
        const def = Object.hasOwn(defs, script) ? defs[script] : undefined;
        if (!def) return json(400, { error: `unknown script (allowed: ${Object.keys(defs).join(", ") || "none — no package.json scripts in the product workspace"})` });
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
      // The built product app (the simulator itself) is served read-only so the console can embed
      // it in an iframe. Requires `build` to have run. It is agent-written HTML and script, so it
      // is always served under the sandbox policy (see servePlayground).
      //
      // The dashboard does not frame this path: it asks for a link first. The page then runs in an
      // opaque origin and could not authenticate its own sub-requests here.
      if (parts[0] === "playground" && parts[1] === "session" && parts.length === 2 && req.method === "POST") {
        const minted = previews.mint();
        return json(200, { path: minted.path, expiresAt: new Date(minted.expiresAt).toISOString() });
      }
      if (parts[0] === "playground" && req.method === "GET") return servePlayground(res, parts.slice(1), false);

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
            const content = fs.readFileSync(target);
            applySecurityHeaders(res, "dashboard", ext === ".html" ? { html: content.toString("utf8") } : undefined);
            res.writeHead(200, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-cache" });
            res.end(content);
            return;
          }
          if (parts.length === 0 || parts[0] === "dashboard") {
            applySecurityHeaders(res, "dashboard");
            res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res.end("<!doctype html><meta charset=utf-8><title>Agent Mesh</title><body style='font-family:monospace;background:#0d1117;color:#e6edf3;padding:24px'>Agent Mesh API online (no dashboard assets). See <a style='color:#58a6ff' href='/status'>/status</a> <a style='color:#58a6ff' href='/graph'>/graph</a> <a style='color:#58a6ff' href='/events'>/events</a></body>");
            return;
          }
        } else if (parts.length === 0) {
          return json(200, { mesh: config.meshId, docs: "see /status /metrics /graph /events" });
        }
      }

      return json(404, { error: `no route: ${req.method} ${u.pathname}` });
    } catch (err) {
      if (err instanceof PayloadTooLargeError) return respondTooLarge(res, err);
      return json(500, { error: (err as Error).message });
    }
  }

  // Shutdown hook: `server.close()` waits for every open socket, and SSE
  // streams + keep-alive dashboard connections never end on their own — so a
  // plain close() hangs forever while the dashboard is open. Ending the hub
  // first lets close() finish; closeHttpServer() below enforces this order.
  // The lag timer MUST die even if close() itself never completes — otherwise
  // its ref'd interval keeps the process alive forever after teardown.
  const serverCleanup = (): void => {
    draining = true;
    clearInterval(lagTimer);
    hub.close();
  };
  serverCleanups.set(server, serverCleanup);
  server.on("close", () => {
    serverCleanups.get(server)?.();
    serverCleanups.delete(server);
  });
  serverCleanups.set(server, serverCleanup);
  // The designer's read-only run-observation MCP needs the port this server
  // actually listens on, which is unknown until `listen()` runs. Bind the
  // locator lazily so a server that never listens (tests, embedded use) costs
  // nothing and the designer falls back to config-only tools.
  instance.designerRuntime.setDesignerObserve(designerBus);
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

/** A content read that reports WHY it failed. The content store rejects for
 * I/O faults (blob pruned, unreadable, a state dir that moved), and those are
 * NOT empty files: `.catch(() => "")` handed the console a blank body it could
 * not tell apart from a genuinely empty deliverable — the one case an operator
 * has to see, since an unreadable artifact looks accepted otherwise. */
type ContentRead = { ok: true; text: string } | { ok: false; error: string };

async function readContentResult(instance: MeshInstance, contentRef: string): Promise<ContentRead> {
  try {
    return { ok: true, text: await readContent(instance, contentRef) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
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

/** Composer for the end-of-run report, shaped like the other state-derived
 * builders (`buildGoalView`, `buildMetrics`): projections first, goal id next.
 */
type RunReportBuilder = (state: unknown, goalId: string) => unknown | Promise<unknown>;

/**
 * Resolve core's run-report composer lazily. `packages/core/src/run-report.ts`
 * is authored by a parallel change, so it is `require`d rather than statically
 * imported: a checkout without it must still typecheck and boot, and the one
 * /goals/:id/run-report route answers 501 instead of the whole server failing
 * to load. Returns null when the module or its export is absent.
 */
function loadRunReportBuilder(): RunReportBuilder | null {
  try {
    const mod = require("../../../packages/core/src/run-report") as Record<string, unknown>;
    const fn = mod.buildRunReport ?? mod.composeRunReport ?? mod.default;
    return typeof fn === "function" ? (fn as RunReportBuilder) : null;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------------- *
 * Workspace window + whitelisted runner (see /workspace routes).
 * ---------------------------------------------------------------------- */

/**
 * Scripts the console may run against the product workspace. The product owns
 * its own package.json, so an arbitrary mesh gets its own build/test/dev — the
 * old fixed list only ever worked for the bundled simulator demo. Only
 * whitelisted script *names* are exposed and the request just names one; the
 * command and args are always `npm run <name>`, so this stays a non-shell API.
 */
const RUN_SCRIPT_NAMES = new Set(["build", "test", "typecheck", "dev", "start", "serve", "preview", "lint"]);

export interface RunScriptDef {
  cmd: string;
  args: readonly string[];
  label: string;
}

export function runScripts(root: string): Record<string, RunScriptDef> {
  const defs: Record<string, RunScriptDef> = {};
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
    for (const name of Object.keys(pkg.scripts ?? {})) {
      if (!RUN_SCRIPT_NAMES.has(name)) continue;
      const body = pkg.scripts?.[name];
      defs[name] = { cmd: "npm", args: ["run", name], label: typeof body === "string" ? `${name} — ${body}` : name };
    }
  } catch {
    // No package.json (or invalid JSON): the product simply exposes no scripts.
  }
  // The bundled simulator's headless demo predates the package.json convention.
  // Keep the entry visible only when its entrypoint actually exists on disk.
  if (fs.existsSync(path.join(root, "tools", "headless", "dist", "main.js"))) {
    defs["headless-hairpin"] = {
      cmd: "node",
      args: ["tools/headless/dist/main.js", "--scenario", "demos/hairpin.scenario.json", "--out", ".mesh-state/run/hairpin-trace.json", "--ticks", "6600"],
      label: "headless-hairpin — run the hairpin demo scenario (6600 ticks)",
    };
  }
  return defs;
}

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

/**
 * Credentials the mesh itself runs on, by exact name, beyond the `MESH_*`
 * family: the model backend's keys. An agent-authored build has no use for
 * the operator's Anthropic credential either.
 */
const RUN_ENV_WITHHELD = new Set(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]);

/**
 * The environment a product script runs in. The script body comes from a
 * package.json the seats write, so whatever this server's environment holds,
 * that code can read — `process.env` used to hand it MESH_API_TOKEN, i.e. the
 * operator's credential for this very server. Every `MESH_*` variable is
 * withheld (the operator token, strict-auth and bus plumbing are all mesh
 * internals, none of them an input to a product build), plus the model keys
 * above. The rest passes through so PATH, HOME, npm config and the like keep
 * builds working. The bridge secrets are never in the environment at all.
 */
function productRunEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.toUpperCase().startsWith("MESH_") || RUN_ENV_WITHHELD.has(k.toUpperCase())) continue;
    env[k] = v;
  }
  return env;
}

function startRun(root: string, script: string, def: { cmd: string; args: readonly string[] }): ActiveRun | null {
  if ([...runs.values()].some((r) => !r.done)) return null;
  const id = `run-${++runSeq}-${Date.now().toString(36)}`;
  fs.mkdirSync(path.join(root, ".mesh-state", "run"), { recursive: true });
  const proc = spawn(def.cmd, [...def.args], { cwd: root, env: productRunEnv(), shell: process.platform === "win32" });
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

/**
 * `rel` under `root`, or null when it would leave it.
 *
 * Lexical containment alone is not containment: a seat can write a symlink into the checkout (so can
 * a commit it merges), and `stat` and `readFile` follow it. `ln -s /proc/self/environ x` then made
 * `GET /workspace/file?path=x` return the server's own environment, operator token included, and a
 * linked directory could be listed. So a path that exists is also resolved through its links and must
 * still be inside the root's real location. One that does not exist yet has nothing to follow; the
 * caller's own `stat` answers 404.
 *
 * A link swapped in between this check and the read can still win that race. The caller is a seat
 * with write access to the checkout, the window is two syscalls, and the read is a preview of files it
 * can already read, so this closes the standing hole (a link left lying in the tree) and not the race.
 */
function resolveInside(root: string, rel: string): string | null {
  const ab = path.resolve(root, rel || ".");
  if (!(ab === root || ab.startsWith(root + path.sep))) return null;
  let realRoot: string;
  let real: string;
  try {
    realRoot = fs.realpathSync(root);
    real = fs.realpathSync(ab);
  } catch {
    return ab;
  }
  return real === realRoot || real.startsWith(realRoot + path.sep) ? ab : null;
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

const execFileAsync = promisify(execFile);

/**
 * `git <args>` in `cwd`, off the event loop, with the same per-call timeout the
 * previous synchronous call had.
 *
 * These git reads answer "what does the workspace look like" for reports, the
 * console and the workspace-coherence gate. They ran as `spawnSync`, and each
 * one has its OWN timeout, so their worst case was additive: a repository the
 * mission is itself committing to — index lock held by a seat's own commit, or
 * a slow disk — could park the event loop for the sum of them, ~35s across the
 * five. A blocked loop stops the child's heartbeat, and the host's health
 * watchdog then kills it with its turns in flight (measured 2026-09-27: 105s of
 * silence, eventLoopLagMaxMs 18.5s). Awaiting is the whole fix; what each call
 * means and returns is unchanged.
 *
 * `null` on every failure — non-zero exit, missing repo, no git, timeout — so
 * each caller can keep the empty result it already treated that as.
 */
async function gitOutput(args: string[], cwd: string, timeoutMs: number): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, timeout: timeoutMs });
    return stdout;
  } catch {
    return null;
  }
}

/** Contents of a path at HEAD (empty string when the file is new). */
async function gitShow(root: string, rel: string): Promise<string> {
  if (!rel) return "";
  return (await gitOutput(["show", `HEAD:${rel}`], root, 5000)) ?? "";
}

/** Working-tree changes as {path, status} — what agents touched since HEAD. */
async function gitChanges(root: string): Promise<Array<{ path: string; status: string }>> {
  const out = await gitOutput(["status", "--porcelain"], root, 5000);
  if (out === null) return [];
  return out
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => ({ status: l.slice(0, 2).trim() || "?", path: l.slice(3).trim() }));
}

/**
 * Give a freshly wiped product root its own git repository.
 *
 * Git mode gets this from `GitWorkspace.ensureRepo`; without it the no-git
 * path resets into a bare directory, and every git read afterwards either
 * finds nothing or — worse — walks up and answers from whatever repo happens
 * to enclose the workspace. Best-effort: a box without git still resets, it
 * just resets into a plain directory, and `gitFacts` now says so instead of
 * reporting a clean tree.
 */
export async function initProductRepo(root: string, stateDir?: string): Promise<boolean> {
  const git = async (...args: string[]): Promise<void> => {
    try {
      await execFileAsync("git", args, { cwd: root, timeout: 10_000 });
    } catch (e) {
      // The old form rethrew `r.error` and, for a non-zero exit, an Error
      // carrying git's stderr; both land in the caller's catch and become
      // `false`. Keep git's own words when it has any.
      const err = e as { stderr?: string; message?: string };
      throw new Error(err.stderr?.trim() || err.message || `git ${args[0]} failed`);
    }
  };
  try {
    await git("init", "-b", "main");
    await git("config", "user.email", "mesh@localhost");
    await git("config", "user.name", "Mesh Supervisor");
    // The state dir lives inside the workspace by default. Unignored, the
    // mission's own event log lands in the product diff and the tree reads
    // "dirty" from the first turn onwards.
    const rel = stateDir ? path.relative(root, stateDir) : "";
    const ignoreState = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? `${rel.split(path.sep).join("/")}/\n` : "";
    fs.writeFileSync(path.join(root, ".gitignore"), `${ignoreState}node_modules/\n`, "utf8");
    fs.writeFileSync(path.join(root, "README.md"), "# Mesh workspace\n\nManaged by agent-mesh.\n", "utf8");
    await git("add", "-A");
    await git("commit", "-m", "mesh: initialize workspace");
    return true;
  } catch {
    return false;
  }
}

/**
 * True when `dir` is the toplevel of its own git repository.
 *
 * Fail closed. `git rev-parse` answers from the nearest ENCLOSING repo, so a
 * directory that merely sits inside someone else's checkout reports that repo
 * — which is how a workspace nested in a product repo passes a naive "is this
 * a repo" test. Only an exact toplevel match counts; anything else, including
 * an unreadable path or no git at all, is false.
 *
 * `GitWorkspace.ensureRepo` makes the same distinction against `main/`, in
 * async form. This is the async copy the server paths need.
 */
export async function ownsGitRepo(dir: string): Promise<boolean> {
  const out = await gitOutput(["rev-parse", "--show-toplevel"], dir, 4000);
  const toplevel = out === null ? null : out.trim();
  if (!toplevel) return false;
  try {
    return (await fs.promises.realpath(toplevel)) === (await fs.promises.realpath(dir));
  } catch {
    return false;
  }
}

/**
 * The subdirectory of a git-mode workspace that holds the agent worktrees.
 *
 * Named because two places have to agree on it: the entry allow-list below, and
 * reset's exclusion list, which must not archive the worktrees it is about to
 * delete. `GitWorkspace` derives the same path from its base directory.
 */
const WORKTREES_DIRNAME = "worktrees";

/**
 * Entries git mode owns at the workspace root. Everything else there is a file
 * no repository tracks — see {@link assertWorkspaceCoherent}.
 */
const GIT_MODE_ROOT_ENTRIES = new Set(["main", WORKTREES_DIRNAME, ".mesh-state", ".mesh", ".git"]);

/**
 * Refuse to boot a git-mode mesh whose workspace root holds product files.
 *
 * In git mode the product lives in `main/` and the root is scaffolding. Two
 * ways it stops being that, both observed live:
 *
 *  - The root is its own repository. A mesh that ran with git OFF materializes
 *    the product into the root and a reset git-inits it there; flipping git ON
 *    then leaves `ensureRepo` unable to adopt it (correctly — `main/` would be
 *    a nested phantom), so the mission gets a second, empty repo and commits
 *    into a branch the product was never in.
 *  - The root holds stray files. Anything written there is tracked by nothing,
 *    survives a reset that only archives `main/`, and is invisible to every
 *    reviewer reading the product checkout.
 *
 * This throws rather than warning because the warning it replaces was already
 * there and was not enough: it went to stderr while agents spent a mission's
 * budget producing commits that could never cite a revision. A mesh that
 * cannot land its product is not degraded, it is broken, and the cheapest
 * moment to say so is before the first turn.
 */
export async function assertWorkspaceCoherent(workspacePath: string, useGit: boolean, stateDir?: string): Promise<void> {
  if (!useGit) return;
  if (!fs.existsSync(workspacePath)) return;
  const problems: string[] = [];
  if (await ownsGitRepo(workspacePath)) {
    problems.push(
      `${workspacePath} is itself a git repository, but git mode keeps the product in ${path.join(workspacePath, "main")}. ` +
        `Commits would land in a repo the product is not in.`,
    );
  }
  const allowed = new Set(GIT_MODE_ROOT_ENTRIES);
  // The state dir is configurable and only defaults to inside the workspace.
  if (stateDir) {
    const rel = path.relative(workspacePath, stateDir);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) allowed.add(rel.split(path.sep)[0]);
  }
  let strays: string[] = [];
  try {
    strays = fs.readdirSync(workspacePath).filter((e) => !allowed.has(e));
  } catch {
    return;
  }
  if (strays.length > 0) {
    const shown = strays.slice(0, 10).join(", ");
    problems.push(
      `${workspacePath} holds files that no repository tracks: ${shown}${strays.length > 10 ? `, +${strays.length - 10} more` : ""}. ` +
        `In git mode the product belongs in ${path.join(workspacePath, "main")}.`,
    );
  }
  if (problems.length === 0) return;
  throw new ConfigError([
    ...problems,
    `To keep this layout, set mesh.workspace.git: false (or pass --no-git) — product files then live in the workspace root.`,
    `To use git worktrees, move those files into ${path.join(workspacePath, "main")} and commit them there, ` +
      `or point mesh.workspace.path at an empty directory.`,
  ]);
}

export async function gitFacts(root: string): Promise<Record<string, string>> {
  const sh = async (...args: string[]): Promise<string | null> => {
    const out = await gitOutput(args, root, 4000);
    return out === null ? null : out.trim();
  };
  // An unowned repo is unknown, never clean: `git status` from a nested
  // directory answers for the enclosing checkout, and an empty status from no
  // repo at all used to read as a clean tree.
  if (!(await ownsGitRepo(root))) return { gitRepo: "false", gitBranch: "", gitHead: "", gitClean: "unknown", gitLog: "" };
  // Sequential, like the object literal that used to be synchronous here; the
  // four reads are independent but their order is not worth changing.
  const status = await sh("status", "--porcelain");
  return {
    gitRepo: "true",
    gitBranch: (await sh("rev-parse", "--abbrev-ref", "HEAD")) ?? "",
    gitHead: (await sh("rev-parse", "--short", "HEAD")) ?? "",
    // An unreadable status is not a clean tree either.
    gitClean: status === null ? "unknown" : String(status.length === 0),
    gitLog: (await sh("log", "--oneline", "-5")) ?? "",
  };
}

export async function startServer(options: BootstrapOptions & { port?: number; host?: string; dashboardDir?: string; licenses?: LicenseProvider }): Promise<ServerHandle> {
  // The listener is bound BEFORE the mesh boots, through the
  // `beforeInitialActivation` seam, because the seats' MCP bridge is spawned
  // against this server's own URL — and for a child of the host, which asks the
  // OS for port 0, that URL (port included) does not exist until `listen()` has
  // run. Booted the other way round, the first wake of every live boot spawns a
  // bridge at a URL nothing answers, spends the adapter's whole respawn ladder
  // (5 spawns, 30s) on it, and loses the turn. Measured 2026-09-27: the child's
  // bridge stayed unreachable for more than 35s after a restart, one lost turn
  // each time.
  // Before anything boots (the state lock, the sessions, the first wake), so a refusal costs
  // nothing to undo. Config resolution is pure, so the host read here is the host bound below.
  const preflight = resolveConfig(options.configPath);
  const listenHost = options.host ?? preflight.server.host;
  for (const w of assertSafeListen(listenHost).warnings) console.warn(`warn: ${w}`);
  // The plan's limit on seats in one mesh. It is a limit on what STARTS: `enforce` refuses a mesh that is
  // already over, and nothing running is ever stopped for it. Under `warn` (the default) it is only said.
  const licenses = options.licenses ?? new LicenseProvider({ home: meshHome() });
  const entitled = licenses.current().entitlements;
  const seatWarning = enforceOrWarn(checkSeats(entitled, preflight.agentOrder.length));
  if (seatWarning) console.warn(`warn: ${seatWarning}`);
  for (const w of entitled.warnings) console.warn(`warn: ${w}`);
  let server: http.Server | undefined;
  let actualPort = 0;
  let boundHost = "";
  const bind = async (instance: MeshInstance): Promise<void> => {
    // A caller that supplied its own pre-activation work still gets it, and
    // still gets it first: this seam is not exclusive.
    if (options.beforeInitialActivation) await options.beforeInitialActivation(instance);
    // Vite SPA build (npm run build:ui emits apps/mesh-dashboard/dist).
    const dashboardDir =
      options.dashboardDir ??
      [
        path.resolve(process.cwd(), "apps", "mesh-dashboard", "dist"),
        path.resolve(__dirname, "..", "..", "..", "..", "apps", "mesh-dashboard", "dist"),
        path.resolve(__dirname, "..", "..", "mesh-dashboard", "dist"),
      ].find((d) => fs.existsSync(d));
    // `server.dashboard: false` used to be a key that did nothing: the SPA was
    // mounted unconditionally while its two siblings (`host`, `port`) were both
    // read two lines below. Withholding the directory is the whole mechanism --
    // the static route is last and already no-ops without one, so the `/api`
    // surface is untouched and only the HTML stops being served.
    const s = createHttpServer(instance, {
      dashboardDir: instance.config.server.dashboard === false ? undefined : dashboardDir,
      licenses,
    });
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
      s.once("error", onError);
      s.listen(port, host, () => {
        s.off("error", onError);
        resolve();
      });
    });
    server = s;
    boundHost = host;
    actualPort = (s.address() as { port: number }).port;
    // Read afresh by every seat's runtime context, so it has to be settled
    // before the first seat can be woken — which is exactly what the ordering
    // above buys. Before this, a boot on an ephemeral port advertised the
    // CONFIGURED port to its own seats.
    process.env.MESH_BUS_URL = `http://${selfConnectHost(host)}:${actualPort}`;
  };
  /** Ready when this server's bridge route is being served. */
  const listenerReady = (): Promise<void> => {
    if (!server || server.listening) return Promise.resolve();
    return new Promise<void>((resolve) => server?.once("listening", () => resolve()));
  };
  const instance = await bootstrapMesh({
    ...options,
    beforeInitialActivation: bind,
    // The probe `supervisor.boot` holds the first live wake on. By the time boot
    // runs, `bind` has already listened — so this resolves the moment it is
    // asked and the boot's audit line reports a 0.0s wait, which is the truth
    // here: readiness was established before the wake, not waited for. A caller
    // that supplied its own probe is still honoured; the boot's own bound covers
    // a probe that never answers.
    bridgeReady: () => {
      const caller = options.bridgeReady;
      const theirs = caller === undefined ? undefined : typeof caller === "function" ? caller() : caller;
      return theirs ? Promise.all([listenerReady(), theirs]).then(() => undefined) : listenerReady();
    },
  });
  if (!server) throw new Error("mesh booted without binding its HTTP port");
  const listening = server;
  return {
    server: listening,
    instance,
    port: actualPort,
    url: `http://${selfConnectHost(boundHost)}:${actualPort}`,
    async close() {
      await closeHttpServer(listening);
      try {
        await instance.close();
      } finally {
        // Designer queries are ours, not the instance's: without this a
        // SIGTERM shutdown leaves live SDK sessions open past the host.
        await instance.designerRuntime.stopAll();
      }
    },
  };
}

export type { OpResult };
export { missionKey };
