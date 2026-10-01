import * as fs from "fs";
import * as path from "path";
import { randomBytes } from "crypto";
import { spawn, type ChildProcess } from "child_process";
import type { GitMode } from "../../protocol/src/index";
// The one file, not the package barrel: the barrel loads the sqlite index, and the host must not.
import { processAlive, processIdentity } from "../../persistence/src/process-identity";
import type { ProjectRef, ProjectStatus, ProjectSupervisor } from "./types";

/**
 * Spawns one `mesh-server` child per project on loopback.
 *
 * The child is unmodified: `child.ts` calls the same `startServer` as
 * `mesh serve`. Everything project-specific is carried in the environment, so
 * no route table, projection or handler differs between hosted and standalone
 * runs — and the per-child bearer token never reaches `ps` output.
 *
 * This class owns mechanism only: spawn, bind, readiness, heartbeat plumbing
 * and killing. It decides nothing about *policy* — when to restart, how long to
 * back off, when to stop trying. That is `SupervisionTree` in `supervision.ts`,
 * which drives this class through the `onExit` and `onHeartbeat` hooks.
 */

/** Time for the child to bind and report its port before we give up on it. */
const DEFAULT_READY_TIMEOUT_MS = 30_000;
/** SIGTERM grace before SIGKILL. The clean path snapshots and unlocks. */
const DEFAULT_STOP_GRACE_MS = 10_000;

export const CHILD_READY_PREFIX = "@@mesh-child-ready@@";
export const CHILD_ERROR_PREFIX = "@@mesh-child-error@@";
/** Liveness + RSS, emitted by the child on a timer for the tab indicator. */
export const CHILD_BEAT_PREFIX = "@@mesh-child-beat@@";
export const PIDFILE_NAME = "host-child.pid";
export const CHILD_STDERR_LOG_NAME = "child-stderr.log";

export interface ChildProcessSupervisorOptions {
  /** Per-child `--max-old-space-size`, from `host.project_memory_mb`. */
  memoryMb?: number;
  readyTimeoutMs?: number;
  stopGraceMs?: number;
  /** `parked` mirrors `mesh console`; `live` runs the scheduler. */
  mode?: "parked" | "live";
  /**
   * Operator's git preference, forwarded verbatim as `MESH_CHILD_GIT`. "auto"
   * (the default) means the host expresses no opinion and each child obeys its
   * own `mesh.workspace.git` — one host can therefore run a git project and a
   * non-git one side by side.
   */
  gitMode?: GitMode;
  /** Override the compiled child entrypoint. Tests use it; nothing else should. */
  childScript?: string;
  execPath?: string;
  /** Notified when a child exits for any reason, expected or not. */
  onExit?: (info: { ref: ProjectRef; code: number | null; signal: NodeJS.Signals | null; expected: boolean }) => void;
  /** Forward child stdout/stderr, minus the handshake lines. */
  onLog?: (info: { ref: ProjectRef; stream: "stdout" | "stderr"; line: string }) => void;
  /**
   * Each child heartbeat, carrying the RSS the tab indicator shows plus the
   * two facts the host can learn nowhere else: the child's own mode, and
   * whether its goal is ACTIVE.
   */
  onHeartbeat?: (info: { ref: ProjectRef; rss: number; at: string; mode?: "parked" | "live"; goalActive?: boolean }) => void;
  /**
   * A project's mode changed to something it was not before.
   *
   * On change only, and never on every beat: the child reports its mode every
   * ~2s and the host persists what it hears, so this is the hook that keeps
   * that from becoming a disk write per project per beat. The receiving end
   * (the registry) is likewise a no-op when the value it is handed already
   * matches what is on disk.
   *
   * Called synchronously from the beat parser. A listener that needs to be
   * async must not let its failure reach here: the beat path is liveness
   * evidence and must survive a store it cannot write.
   */
  onModeChange?: (id: string, mode: "parked" | "live") => void;
}

/**
 * Token counts for one model, as last reported by a child, in the classes a provider bills separately. The
 * cache fields are absent from a child that predates them and read as zero then, which prices that child as
 * the host always did.
 */
export interface ChildModelTokens {
  model: string;
  input: number;
  output: number;
  cacheWrite?: number;
  cacheRead?: number;
}

/** Liveness sample from a child, as last observed by the supervisor. */
export interface ChildHeartbeat {
  rss: number;
  /** ISO timestamp of receipt by the host, not of emission by the child. */
  at: string;
  /** `Date.now()` at receipt: monotonic-enough for a missed-window check. */
  receivedAt: number;
  /**
   * Cumulative billed tokens per model. Cumulative, not a delta: a beat lost
   * to a dropped line or a restart must not silently vanish from the total,
   * which is the one property an aggregate ceiling depends on.
   */
  models: ChildModelTokens[];
  /** Turns in flight in this child, for the aggregate concurrency cap. */
  runningTurns: number;
  /**
   * The child's scheduler mode, as the child reported it. Absent from a child
   * old enough not to send it, which is why every reader treats it as unknown
   * rather than as "parked".
   *
   * The host cannot derive this. `/mission/start` and `/mission/park` are
   * proxied verbatim, so a mission an operator made live inside a child is
   * invisible to the host — and the next launch of that project would spawn the
   * child in the host's *own* default mode, silently parking a live mission.
   */
  mode?: "parked" | "live";
  /**
   * True while the child's active goal is ACTIVE, as of this beat. Absent when
   * the child does not report it. Lets the host say "this mission is not
   * running" about the one state that hides it: a parked child that still holds
   * an ACTIVE goal, where every surface else reads "running".
   */
  goalActive?: boolean;
  /**
   * The child's own loop-lag measurement, as of this beat: how late its 1s
   * sample last fired, and the worst it has been since that child started.
   *
   * Absent for a child old enough not to send it, and for every beat from a stub
   * that does not bother. That absence matters: a reader must not turn "the child
   * did not say" into "the child was never blocked", because the second is an
   * answer and the first is not.
   */
  eventLoopLagMs?: number;
  eventLoopLagMaxMs?: number;
}

export interface RunningChild {
  ref: ProjectRef;
  proc: ChildProcess;
  pid: number;
  port: number;
  token: string;
  url: string;
  startedAt: string;
  pidFile: string;
  /** Undefined until the first beat lands; the watchdog treats start as t0. */
  lastHeartbeat?: ChildHeartbeat;
}

/** Exit codes `child.ts` uses to report *why* it failed without parsing prose. */
const EXIT_LOCKED = 78;
const EXIT_CONFIG = 79;

function resolveChildScript(): string {
  // Compiled layout: dist/packages/projects/src -> dist/apps/mesh-server/src.
  const candidates = [
    path.resolve(__dirname, "..", "..", "..", "apps", "mesh-server", "src", "child.js"),
    path.resolve(process.cwd(), "dist", "apps", "mesh-server", "src", "child.js"),
  ];
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) {
    throw new Error(
      `cannot locate the mesh-server child entrypoint (looked in ${candidates.join(", ")}) — run npm run build`,
    );
  }
  return found;
}

/** 32 bytes of CSPRNG, per child, never reused across restarts. */
export function mintChildToken(): string {
  return randomBytes(32).toString("hex");
}

function pidfilePath(ref: ProjectRef): string {
  // Beside the project, not in a shared dir: a project moved or deleted takes
  // its own bookkeeping with it.
  return path.join(path.dirname(ref.configPath), ".mesh", PIDFILE_NAME);
}

function childStderrPath(ref: ProjectRef): string {
  return path.join(path.dirname(ref.configPath), ".mesh", CHILD_STDERR_LOG_NAME);
}

function pidAlive(pid: number): boolean {
  return processAlive(pid);
}

/**
 * SIGTERM, poll, then SIGKILL. One escalation style for every child process
 * rather than a second one per caller. Always resolves: a process we cannot
 * kill is reported by leaving it alone, never by hanging the caller.
 */
export function killPidWithEscalation(pid: number, graceMs = DEFAULT_STOP_GRACE_MS): Promise<void> {
  return new Promise((resolve) => {
    if (!pidAlive(pid)) return resolve();
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return resolve();
    }
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(escalate);
      resolve();
    };
    const poll = setInterval(() => {
      if (!pidAlive(pid)) finish();
    }, 50);
    const escalate = setTimeout(() => {
      if (pidAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
        setTimeout(finish, 200);
      } else {
        finish();
      }
    }, graceMs);
  });
}

export class ChildProcessSupervisor implements ProjectSupervisor {
  /**
   * Identifies this supervisor across process boundaries. Pid alone is not
   * enough: two supervisors can share one process, and pids are recycled.
   */
  readonly hostId = `${process.pid}-${randomBytes(8).toString("hex")}`;
  private children = new Map<string, RunningChild>();
  private stopping = new Set<string>();
  /**
   * Per-project mode, as last reported by that project's own child.
   *
   * Mode used to be one host-wide value (`opts.mode`), which is right for the
   * first launch of a project and wrong for every launch after it: the operator
   * starts a mission inside the child through the proxied `/mission/start`,
   * nothing tells the host, and the project's next launch — an operator restart,
   * or the automatic restart after a crash — spawns the child back in the
   * host's default mode. On a host started without `--live` that is `parked`,
   * so a restart parked a running mission and nothing said so.
   *
   * Kept here rather than in the host because `launch` is the only place the
   * decision is consumed, and the registry drives it through the supervision
   * tree, which has no per-launch options to thread.
   *
   * This map is the *running* memory: what this process has heard from its
   * children. It is not the last word, because a host process that restarts
   * starts with it empty and the child that knew the answer is gone with it —
   * so the mode each project was last in also rides on its `ProjectRef`
   * (`lastMode`), which is the host's durable per-project state. `launch`
   * consults this map first, then that, then the host's own default; see
   * `spawnModeFor`. Persistent bookkeeping that stays per-process (the crash
   * breaker, the policy parks) is a different thing: those describe *this*
   * host's decisions, and a park they imposed is re-imposed by the limit check
   * on the next beat rather than remembered across a restart.
   */
  private projectModes = new Map<string, "parked" | "live">();
  private readonly opts: Required<Pick<ChildProcessSupervisorOptions, "readyTimeoutMs" | "stopGraceMs" | "mode" | "gitMode">> &
    ChildProcessSupervisorOptions;

  constructor(options: ChildProcessSupervisorOptions = {}) {
    this.opts = {
      // Spread FIRST. It used to come last, so any caller passing an explicit
      // `undefined` for one of the keys below overwrote the computed default
      // with `undefined` again — the defaults were decorative for exactly the
      // callers that named the key.
      ...options,
      readyTimeoutMs: options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      stopGraceMs: options.stopGraceMs ?? DEFAULT_STOP_GRACE_MS,
      mode: options.mode ?? "parked",
      gitMode: options.gitMode ?? "auto",
    };
  }

  running(id: string): RunningChild | undefined {
    return this.children.get(id);
  }

  /**
   * The mode this project's child last reported, or the host's own configured
   * default when this host has not heard from it.
   *
   * Falling back to `opts.mode` is what keeps two things true at once — a host
   * booted without `--live` still spawns parked children (nothing is known
   * about a project it has never run), and a host booted with `--live` still
   * boots live.
   *
   * This is the *running* memory only: it answers "what did my child say",
   * which is not the same question as `spawnModeFor`'s "what will I spawn".
   */
  modeFor(id: string): "parked" | "live" {
    return this.projectModes.get(id) ?? this.opts.mode;
  }

  /**
   * The mode this project's next launch will actually use.
   *
   * Three sources, in strict order:
   *
   *   1. What this host heard from the child. Freshest by construction, and
   *      the only one that knows an operator pressed Start inside a project.
   *   2. What the project was last in before this host started (`ref.lastMode`,
   *      restored from the registry). This is the whole point of persisting it:
   *      a host restarted after a crash used to spawn every child in its own
   *      default and silently park live missions.
   *   3. The host's own default, which is `parked` unless `--live`.
   *
   * The persisted value outranks the default on purpose, `--live` included.
   * `--live` says what to do about a project *nothing is known about*; it is
   * not "start whatever was stopped". Letting it win would walk straight back
   * over the one park that is a policy rather than an opinion — the aggregate
   * spend ceiling parks a child through its own route, the child reports
   * parked, and that is what gets persisted. A `--live` host that resurrected
   * it would spend past a ceiling the operator set, which is the failure mode
   * the ceiling exists to prevent. `/mission/start` is the way to resume a
   * project, and it is what the parked notice already names.
   */
  private spawnModeFor(ref: ProjectRef): "parked" | "live" {
    return this.projectModes.get(ref.id) ?? ref.lastMode ?? this.opts.mode;
  }

  /**
   * Remember the mode a project's child reports for itself.
   *
   * Called on every well-formed beat, so the record follows an operator's
   * `/mission/start` or `/mission/park` within one beat of it happening, and a
   * project parked by the host's own ceiling or turn-cap brake stays parked on
   * its next launch. That last part is the point: a policy park is not a
   * failure the operator can clear by restarting, it is the host doing what it
   * was configured to do.
   *
   * Records a change, not a repetition: the beat arrives every ~2s and
   * `onModeChange` is what persists the value, so an unconditional call here
   * would be a disk write per open project per beat forever.
   */
  rememberMode(id: string, mode: "parked" | "live"): void {
    if (this.projectModes.get(id) === mode) return;
    this.projectModes.set(id, mode);
    this.opts.onModeChange?.(id, mode);
  }

  /** The project is gone from the registry: drop what it was doing. */
  forgetMode(id: string): void {
    this.projectModes.delete(id);
  }

  runningIds(): string[] {
    return [...this.children.keys()];
  }

  /**
   * Reap children stranded by a host that was SIGKILLed.
   *
   * A pidfile whose process is gone is debris. One whose process is alive but
   * whose *host* is gone is a true orphan: killing it is what frees the state
   * lock, and leaving it would make the project permanently unopenable.
   *
   * A child still owned by another live host is neither. Reaping it would let
   * any second host silently evict the first from a project it is actively
   * running — the lock would be freed by killing the legitimate holder, which
   * inverts the single-writer guarantee instead of enforcing it.
   */
  async sweepOrphans(refs: ProjectRef[]): Promise<string[]> {
    const reaped: string[] = [];
    for (const ref of refs) {
      if (this.children.has(ref.id)) continue;
      const file = pidfilePath(ref);
      let raw: string;
      try {
        raw = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      let record: { pid?: number; hostPid?: number; hostId?: string; startId?: string; hostStartId?: string } = {};
      try {
        record = JSON.parse(raw);
      } catch {
        fs.rmSync(file, { force: true });
        continue;
      }
      const pid = typeof record.pid === "number" ? record.pid : 0;
      const hostPid = typeof record.hostPid === "number" ? record.hostPid : 0;
      // Another live host owns this child. Leave both the process and its
      // pidfile alone; our own boot will fail on the state lock, which is the
      // correct, visible outcome.
      //
      // Ownership is the host *instance*, not its pid: two supervisors inside
      // one process (tests, and an embedded host) share a pid, and pid-only
      // ownership would let the second reap the first's live children.
      const ownedByUs = record.hostId === this.hostId;
      // "Alive" means the SAME process, not whatever now wears that number. A pidfile on a volume
      // outlives the container that wrote it, and the next container numbers its processes from the
      // same small integers: without the start-time check a dead pod's host pid looked like a live
      // host (so nothing was reaped and the debris stayed), and a dead pod's child pid could be an
      // innocent process of this one, which would then have been signalled.
      if (!ownedByUs && processAlive(hostPid, record.hostStartId)) continue;
      if (processAlive(pid, record.startId) && pid !== process.pid) {
        await killPidWithEscalation(pid, this.opts.stopGraceMs);
        reaped.push(ref.id);
      }
      fs.rmSync(file, { force: true });
    }
    return reaped;
  }

  async launch(ref: ProjectRef): Promise<{
    status: ProjectStatus;
    endpoint?: { port: number; token: string };
    pid?: number;
    error?: { reason: string; detail?: string };
  }> {
    const existing = this.children.get(ref.id);
    if (existing) {
      return { status: "open", endpoint: { port: existing.port, token: existing.token }, pid: existing.pid };
    }

    // A child stranded by a previous host still holds this project's state
    // lock, so the new child would boot straight into `locked`.
    await this.sweepOrphans([ref]);

    const token = mintChildToken();
    const script = this.opts.childScript ?? resolveChildScript();
    const execArgv = this.opts.memoryMb ? [`--max-old-space-size=${this.opts.memoryMb}`] : [];
    const proc = spawn(this.opts.execPath ?? process.execPath, [...execArgv, script], {
      cwd: path.dirname(ref.configPath),
      env: {
        ...process.env,
        // Secrets go through the environment, never argv: argv is world-readable
        // in `ps` on every process on the box.
        MESH_API_TOKEN: token,
        MESH_STRICT_AUTH: "1",
        MESH_CHILD_CONFIG: ref.configPath,
        MESH_CHILD_PROJECT_ID: ref.id,
        // Per project, not per host: a project the operator made live comes
        // back live, and one the host itself parked (ceiling, turn cap) or the
        // operator parked comes back parked. `spawnModeFor` reads the restore
        // order — this process's memory, then what the project was last in
        // before this process started, then the host's own default.
        MESH_CHILD_MODE: this.spawnModeFor(ref),
        // Never left undefined: the spread above would let a stray
        // MESH_CHILD_GIT in the host's own environment through, which is the
        // one way a host-wide setting could silently outrank a project's.
        MESH_CHILD_GIT: this.opts.gitMode === "on" ? "1" : this.opts.gitMode === "off" ? "0" : "",
        // The child must not inherit the host's bus URL and start talking to it.
        MESH_BUS_URL: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // Attached for the whole child lifetime, not just the handshake: heartbeats
    // arrive *after* ready, and a reader that detached at ready would silently
    // starve the health watchdog into restarting healthy children.
    const feed = this.attachFeed(ref, proc);

    let outcome: { status: ProjectStatus; error?: { reason: string; detail?: string }; ready?: { port: number; pid: number } };
    try {
      outcome = await this.awaitReady(proc, feed);
    } catch (err) {
      proc.kill("SIGKILL");
      return { status: "crashed", error: { reason: "failed", detail: (err as Error).message } };
    }

    if (outcome.status !== "open" || !outcome.ready) {
      // A child that never came up is not tracked, so nothing can later try to
      // stop or proxy to a process that does not exist.
      if (proc.pid && pidAlive(proc.pid)) await killPidWithEscalation(proc.pid, this.opts.stopGraceMs);
      return { status: outcome.status, error: outcome.error };
    }

    const pidFile = pidfilePath(ref);
    const child: RunningChild = {
      ref,
      proc,
      pid: outcome.ready.pid,
      port: outcome.ready.port,
      token,
      url: `http://127.0.0.1:${outcome.ready.port}`,
      startedAt: new Date().toISOString(),
      pidFile,
    };
    this.children.set(ref.id, child);
    this.writePidfile(child);

    const stderrPath = childStderrPath(ref);
    const prevStderrPath = `${stderrPath}.1`;
    fs.rmSync(prevStderrPath, { force: true });
    if (fs.existsSync(stderrPath)) fs.renameSync(stderrPath, prevStderrPath);
    const stderrLog = fs.createWriteStream(stderrPath, { flags: "w" });
    stderrLog.on("error", () => undefined);
    stderrLog.write(`[mesh-supervisor] child started pid=${child.pid} port=${child.port} at=${child.startedAt}\n`);
    proc.stderr?.on("data", (chunk: Buffer) => stderrLog.write(chunk));

    proc.once("exit", (code, signal) => {
      const expected = this.stopping.has(ref.id);
      this.children.delete(ref.id);
      this.stopping.delete(ref.id);
      fs.rmSync(pidFile, { force: true });
      stderrLog.write(`[mesh-supervisor] child exited code=${code} signal=${signal} expected=${expected}\n`);
      stderrLog.end();
      this.opts.onExit?.({ ref, code, signal, expected });
    });

    return { status: "open", endpoint: { port: child.port, token: child.token }, pid: child.pid };
  }

  /**
   * SIGTERM and wait for the child's own clean shutdown — that path snapshots
   * (P2) and releases the state lock (P1). SIGKILL only after the deadline,
   * because a killed child leaves both undone.
   */
  async stop(ref: ProjectRef, graceMs = this.opts.stopGraceMs): Promise<void> {
    const child = this.children.get(ref.id);
    if (!child) return;
    this.stopping.add(ref.id);
    const exited = new Promise<void>((resolve) => child.proc.once("exit", () => resolve()));
    await killPidWithEscalation(child.pid, graceMs);
    await exited;
    this.children.delete(ref.id);
    this.stopping.delete(ref.id);
    fs.rmSync(child.pidFile, { force: true });
  }

  /**
   * Host shutdown: close every child in parallel against **one** deadline.
   *
   * Parallel and shared are both load-bearing. Sequential stops would make host
   * shutdown cost `n * grace`, and a per-child grace would let a handful of slow
   * children hold the host open well past the deadline the operator (or the
   * service manager's own SIGKILL timer) is actually counting against.
   */
  async stopAll(deadlineMs = this.opts.stopGraceMs): Promise<void> {
    const started = Date.now();
    const children = [...this.children.values()];
    await Promise.all(
      children.map((c) => this.stop(c.ref, Math.max(0, deadlineMs - (Date.now() - started)))),
    );
  }

  /** Last observed liveness sample, for the tab indicator and the watchdog. */
  heartbeat(id: string): ChildHeartbeat | undefined {
    return this.children.get(id)?.lastHeartbeat;
  }

  private writePidfile(child: RunningChild): void {
    fs.mkdirSync(path.dirname(child.pidFile), { recursive: true });
    fs.writeFileSync(
      child.pidFile,
      JSON.stringify({
        pid: child.pid,
        port: child.port,
        projectId: child.ref.id,
        hostPid: process.pid,
        hostId: this.hostId,
        // When each process started, so a later host can tell these two from whatever has their pids by
        // then. Absent where the platform cannot say, and then the pid alone is trusted, as it was.
        startId: processIdentity(child.pid) ?? undefined,
        hostStartId: processIdentity(process.pid) ?? undefined,
        startedAt: child.startedAt,
      }),
      "utf8",
    );
  }

  /**
   * Parse the child's stdout/stderr for the whole life of the process.
   *
   * Handshake lines, heartbeats and plain logs share one framing, so they share
   * one reader. `onReady`/`onFailure` are late-bound because only the launch
   * path cares about them; heartbeats keep flowing long after launch resolves.
   */
  private attachFeed(ref: ProjectRef, proc: ChildProcess): ChildFeed {
    const feed: ChildFeed = { proc, stderrTail: "", failure: undefined };

    const consumeLine = (line: string, stream: "stdout" | "stderr"): void => {
      if (line.startsWith(CHILD_READY_PREFIX)) {
        try {
          const payload = JSON.parse(line.slice(CHILD_READY_PREFIX.length).trim());
          if (typeof payload.port === "number" && typeof payload.pid === "number") {
            feed.onReady?.({ port: payload.port, pid: payload.pid });
          }
        } catch {
          /* malformed handshake falls through to the ready timeout */
        }
        return;
      }
      if (line.startsWith(CHILD_ERROR_PREFIX)) {
        try {
          const payload = JSON.parse(line.slice(CHILD_ERROR_PREFIX.length).trim());
          feed.failure = { reason: String(payload.reason ?? "failed"), detail: String(payload.detail ?? "") };
        } catch {
          feed.failure = { reason: "failed", detail: line };
        }
        return;
      }
      if (line.startsWith(CHILD_BEAT_PREFIX)) {
        try {
          const payload = JSON.parse(line.slice(CHILD_BEAT_PREFIX.length).trim());
          const rss = typeof payload.rss === "number" ? payload.rss : 0;
          const models: ChildModelTokens[] = Array.isArray(payload.models)
            ? (payload.models as unknown[]).flatMap((m) => {
                if (!m || typeof m !== "object") return [];
                const entry = m as { model?: unknown; input?: unknown; output?: unknown; cacheWrite?: unknown; cacheRead?: unknown };
                if (typeof entry.model !== "string") return [];
                const tokens = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
                return [{
                  model: entry.model,
                  input: typeof entry.input === "number" ? entry.input : 0,
                  output: typeof entry.output === "number" ? entry.output : 0,
                  cacheWrite: tokens(entry.cacheWrite),
                  cacheRead: tokens(entry.cacheRead),
                }];
              })
            : [];
          const beat: ChildHeartbeat = {
            rss,
            at: new Date().toISOString(),
            receivedAt: Date.now(),
            models,
            runningTurns: typeof payload.runningTurns === "number" ? payload.runningTurns : 0,
          };
          // An unrecognised mode is not a mode: a beat that omits or mangles the
          // field must leave the memory alone rather than reset it to a guess.
          if (payload.mode === "live" || payload.mode === "parked") beat.mode = payload.mode;
          if (typeof payload.goalActive === "boolean") beat.goalActive = payload.goalActive;
          // Carried verbatim, and only when present: this is the child's own
          // measurement of itself, and the host has no basis for substituting a
          // default. A field the child did not send stays undefined all the way
          // to the supervision log, which is what lets a reader tell "never
          // blocked" from "never asked".
          if (typeof payload.eventLoopLagMs === "number") beat.eventLoopLagMs = payload.eventLoopLagMs;
          if (typeof payload.eventLoopLagMaxMs === "number") beat.eventLoopLagMaxMs = payload.eventLoopLagMaxMs;
          // Learned before the process guard below, and on purpose: this is a
          // fact about the *project*, not about the process that reported it, so
          // the final beats of a child being replaced are still the freshest
          // thing anyone knows about what that project was doing.
          if (beat.mode) this.rememberMode(ref.id, beat.mode);
          const child = this.children.get(ref.id);
          // A beat from a child we no longer track is from a process being
          // replaced; recording it would revive a dead entry's health.
          if (child && child.proc === proc) child.lastHeartbeat = beat;
          this.opts.onHeartbeat?.({ ref, rss: beat.rss, at: beat.at, mode: beat.mode, goalActive: beat.goalActive });
        } catch {
          /* a malformed beat is not liveness evidence; let the watchdog fire */
        }
        return;
      }
      if (line.trim()) this.opts.onLog?.({ ref, stream, line });
    };

    const lineReader = (stream: "stdout" | "stderr") => {
      let buffer = "";
      return (chunk: Buffer): void => {
        buffer += chunk.toString("utf8");
        let idx = buffer.indexOf("\n");
        while (idx >= 0) {
          consumeLine(buffer.slice(0, idx), stream);
          buffer = buffer.slice(idx + 1);
          idx = buffer.indexOf("\n");
        }
      };
    };

    const onStdout = lineReader("stdout");
    const rawStderr = lineReader("stderr");
    proc.stdout?.on("data", onStdout);
    proc.stderr?.on("data", (chunk: Buffer) => {
      // Kept for the failure detail: a child that dies without a handshake line
      // must still tell the user something actionable.
      feed.stderrTail = `${feed.stderrTail}${chunk.toString("utf8")}`.slice(-2000);
      rawStderr(chunk);
    });
    return feed;
  }

  /**
   * Wait for the handshake line on stdout. Three outcomes race: ready, an
   * error line followed by exit, or a silent hang that the timeout converts
   * into a crash rather than a stuck `open` tab.
   */
  private awaitReady(
    proc: ChildProcess,
    feed: ChildFeed,
  ): Promise<{ status: ProjectStatus; error?: { reason: string; detail?: string }; ready?: { port: number; pid: number } }> {
    return new Promise((resolve, reject) => {
      let settled = false;

      const finish = (value: { status: ProjectStatus; error?: { reason: string; detail?: string }; ready?: { port: number; pid: number } }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        feed.onReady = undefined;
        proc.off("exit", onExit);
        proc.off("error", onError);
        resolve(value);
      };

      feed.onReady = (ready) => finish({ status: "open", ready });

      const onExit = (code: number | null): void => {
        if (feed.failure) {
          finish({ status: statusForFailure(feed.failure.reason, code), error: feed.failure });
          return;
        }
        const reason = code === EXIT_LOCKED ? "locked" : code === EXIT_CONFIG ? "invalid_config" : "failed";
        finish({
          status: statusForFailure(reason, code),
          error: { reason, detail: feed.stderrTail.trim() || `child exited with code ${code} before signalling ready` },
        });
      };

      const onError = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      };

      const timer = setTimeout(() => {
        finish({
          status: "crashed",
          error: {
            reason: "timeout",
            detail: `child did not report a port within ${this.opts.readyTimeoutMs}ms${feed.stderrTail.trim() ? `: ${feed.stderrTail.trim()}` : ""}`,
          },
        });
      }, this.opts.readyTimeoutMs);

      proc.once("exit", onExit);
      proc.once("error", onError);
    });
  }
}

/** Long-lived parse state for one child's output streams. */
interface ChildFeed {
  proc: ChildProcess;
  stderrTail: string;
  failure?: { reason: string; detail?: string };
  onReady?: (ready: { port: number; pid: number }) => void;
}

/** Locked and invalid-config are not crashes: auto-restart would spin forever. */
export function statusForFailure(reason: string, code: number | null): ProjectStatus {
  if (reason === "locked" || code === EXIT_LOCKED) return "locked";
  if (reason === "invalid_config" || code === EXIT_CONFIG) return "error";
  return "crashed";
}
