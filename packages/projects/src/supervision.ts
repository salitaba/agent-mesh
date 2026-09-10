import type { ChildProcessSupervisor } from "./supervisor";
import type { ProjectRef, ProjectStatus } from "./types";

/**
 * Supervision policy for hosted project children.
 *
 * `ChildProcessSupervisor` owns mechanism — spawn, readiness, signals. This
 * owns the decisions: whether a dead child comes back, how long we wait first,
 * and when we stop trying and show the user a dead tab instead.
 *
 * The separation matters because the policy is the part with opinions, and the
 * opinions are testable against a stub child in milliseconds while the
 * mechanism needs a real ~500ms mesh boot.
 */

/** Backoff schedule from the spec: 1s, 2s, 4s, 8s, ... capped at 30s. */
export const RESTART_BACKOFF_BASE_MS = 1_000;
export const RESTART_BACKOFF_CAP_MS = 30_000;
/** More than this many crashes inside the window trips the breaker. */
export const CRASH_LOOP_THRESHOLD = 3;
export const CRASH_LOOP_WINDOW_MS = 60_000;
/**
 * Missed-heartbeat window. Generous relative to the child's 2s cadence: the
 * cost of a false positive is killing a working project mid-mission, the cost
 * of a slow true positive is a tab that is stale for a few extra seconds.
 */
export const HEARTBEAT_TIMEOUT_MS = 15_000;
/** How often the watchdog inspects the last beat of every open child. */
export const HEALTH_POLL_MS = 2_000;
/** Whole-host shutdown deadline, shared across all children. */
export const SHUTDOWN_DEADLINE_MS = 10_000;

/**
 * `1s, 2s, 4s, 8s, ... 30s`. `attempt` is 1-based: the delay *before* the Nth
 * restart. Exported so the UI can show "retrying in Ns" with the same numbers
 * the supervisor will actually use.
 */
export function backoffDelayMs(attempt: number): number {
  if (attempt <= 1) return RESTART_BACKOFF_BASE_MS;
  const raw = RESTART_BACKOFF_BASE_MS * 2 ** (attempt - 1);
  return Math.min(raw, RESTART_BACKOFF_CAP_MS);
}

export type SupervisionReason =
  /** The child process exited on its own. */
  | "crash"
  /** No heartbeat inside the window; the host killed it to restart it. */
  | "unhealthy";

export interface SupervisionEvent {
  ref: ProjectRef;
  status: ProjectStatus;
  reason?: SupervisionReason;
  /** Restarts performed for this project since it last came up healthy. */
  restarts: number;
  /** Set when a restart is scheduled rather than performed immediately. */
  retryInMs?: number;
  detail?: string;
}

export interface SupervisionTreeOptions {
  supervisor: ChildProcessSupervisor;
  /** Every status transition the host and UI care about. */
  onEvent?: (event: SupervisionEvent) => void;
  heartbeatTimeoutMs?: number;
  healthPollMs?: number;
  crashLoopThreshold?: number;
  crashLoopWindowMs?: number;
  shutdownDeadlineMs?: number;
  /** Injected in tests so backoff assertions do not take 15 real seconds. */
  backoff?: (attempt: number) => number;
  now?: () => number;
}

interface Supervised {
  ref: ProjectRef;
  status: ProjectStatus;
  /** Crash timestamps inside the rolling window, oldest first. */
  crashes: number[];
  restarts: number;
  timer?: NodeJS.Timeout;
  /** True once the breaker trips: only a manual `restart()` clears it. */
  tripped: boolean;
  /** Suppresses the restart path for an operator-initiated stop. */
  intentional: boolean;
  detail?: string;
  /** Start of the current life, as the watchdog's t0 before the first beat. */
  startedAt: number;
}

export class SupervisionTree {
  private readonly supervisor: ChildProcessSupervisor;
  private readonly opts: Required<
    Pick<
      SupervisionTreeOptions,
      "heartbeatTimeoutMs" | "healthPollMs" | "crashLoopThreshold" | "crashLoopWindowMs" | "shutdownDeadlineMs"
    >
  >;
  private readonly backoff: (attempt: number) => number;
  private readonly now: () => number;
  private readonly onEvent?: (event: SupervisionEvent) => void;
  private tracked = new Map<string, Supervised>();
  private watchdog?: NodeJS.Timeout;
  private shuttingDown = false;
  /**
   * Launches that have been started but have not yet resolved.
   *
   * A child mid-handshake is not in the supervisor's `children` map, so
   * `stopAll` cannot see it. Shutting down without waiting for these strands
   * exactly the child the next host has to reap.
   */
  private inFlight = new Set<Promise<unknown>>();

  constructor(options: SupervisionTreeOptions) {
    this.supervisor = options.supervisor;
    this.onEvent = options.onEvent;
    this.backoff = options.backoff ?? backoffDelayMs;
    this.now = options.now ?? Date.now;
    this.opts = {
      heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS,
      healthPollMs: options.healthPollMs ?? HEALTH_POLL_MS,
      crashLoopThreshold: options.crashLoopThreshold ?? CRASH_LOOP_THRESHOLD,
      crashLoopWindowMs: options.crashLoopWindowMs ?? CRASH_LOOP_WINDOW_MS,
      shutdownDeadlineMs: options.shutdownDeadlineMs ?? SHUTDOWN_DEADLINE_MS,
    };
  }

  /**
   * Host boot: reap children stranded by a previous host across *every*
   * registered project, not only the ones about to be opened.
   *
   * A stranded child holds its project's state lock, so a project nobody opens
   * this session is still permanently unopenable until its orphan is cleared.
   */
  async start(refs: ProjectRef[]): Promise<string[]> {
    const reaped = await this.supervisor.sweepOrphans(refs);
    this.startWatchdog();
    return reaped;
  }

  /** Bring a project up and supervise it from here on. */
  async open(ref: ProjectRef): Promise<{ status: ProjectStatus; error?: { reason: string; detail?: string } }> {
    const entry = this.track(ref);
    entry.intentional = false;
    entry.tripped = false;
    this.clearTimer(entry);
    this.startWatchdog();
    return this.launch(entry, ref);
  }

  /**
   * Operator restart. Clears the crash-loop breaker: the user asking again is
   * new information — they may well have fixed whatever was killing the child.
   */
  async restart(ref: ProjectRef): Promise<{ status: ProjectStatus; error?: { reason: string; detail?: string } }> {
    const entry = this.track(ref);
    this.clearTimer(entry);
    entry.crashes = [];
    entry.restarts = 0;
    entry.tripped = false;
    await this.close(ref);
    return this.open(ref);
  }

  /** Operator close: never restarted, and it cancels any pending backoff. */
  async close(ref: ProjectRef): Promise<void> {
    const entry = this.tracked.get(ref.id);
    if (entry) {
      entry.intentional = true;
      this.clearTimer(entry);
    }
    await this.supervisor.stop(ref);
    if (entry) this.setStatus(entry, "closed");
  }

  /** Drop a project from supervision entirely (registry `remove`). */
  async forget(ref: ProjectRef): Promise<void> {
    await this.close(ref);
    this.tracked.delete(ref.id);
  }

  status(id: string): ProjectStatus {
    return this.tracked.get(id)?.status ?? "closed";
  }

  /** Restart count and last RSS for the tab indicator. */
  health(id: string): { rss: number; lastHeartbeat: string; restarts: number } | undefined {
    const entry = this.tracked.get(id);
    if (!entry) return undefined;
    const beat = this.supervisor.heartbeat(id);
    if (!beat) return undefined;
    return { rss: beat.rss, lastHeartbeat: beat.at, restarts: entry.restarts };
  }

  /** True once the breaker has tripped: the UI shows manual retry only. */
  isTripped(id: string): boolean {
    return this.tracked.get(id)?.tripped ?? false;
  }

  /** Pending auto-restart delay, or undefined when none is scheduled. */
  pendingRestartMs(id: string): number | undefined {
    const entry = this.tracked.get(id);
    return entry?.timer ? this.backoff(entry.restarts + 1) : undefined;
  }

  /**
   * The supervisor's `onExit` hook. Wire it in the constructor of the
   * `ChildProcessSupervisor` you pass in.
   */
  handleExit(info: { ref: ProjectRef; code: number | null; signal: NodeJS.Signals | null; expected: boolean }): void {
    if (this.shuttingDown || info.expected) return;
    const entry = this.tracked.get(info.ref.id);
    if (!entry || entry.intentional) return;
    const detail = `child exited with ${info.signal ? `signal ${info.signal}` : `code ${info.code}`}`;
    this.onFailure(entry, info.ref, "crash", detail);
  }

  /** Host shutdown: all children in parallel against one deadline, then done. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = undefined;
    }
    // Cancel pending backoffs first, or a timer could spawn a child *while* we
    // are shutting down and strand it as an orphan for the next host to reap.
    for (const entry of this.tracked.values()) this.clearTimer(entry);
    // Let in-flight launches land first: a child that finishes booting after
    // `stopAll` scanned the map would never be stopped at all.
    await Promise.allSettled([...this.inFlight]);
    await this.supervisor.stopAll(this.opts.shutdownDeadlineMs);
    for (const entry of this.tracked.values()) {
      if (entry.status === "open" || entry.status === "booting") this.setStatus(entry, "closed");
    }
  }

  private track(ref: ProjectRef): Supervised {
    const existing = this.tracked.get(ref.id);
    if (existing) {
      existing.ref = ref;
      return existing;
    }
    const entry: Supervised = {
      ref,
      status: "closed",
      crashes: [],
      restarts: 0,
      tripped: false,
      intentional: false,
      startedAt: this.now(),
    };
    this.tracked.set(ref.id, entry);
    return entry;
  }

  private async launch(
    entry: Supervised,
    ref: ProjectRef,
  ): Promise<{ status: ProjectStatus; error?: { reason: string; detail?: string } }> {
    this.setStatus(entry, "booting");
    entry.startedAt = this.now();
    const pending = this.supervisor.launch(ref);
    this.inFlight.add(pending);
    let result: Awaited<typeof pending>;
    try {
      result = await pending;
    } finally {
      this.inFlight.delete(pending);
    }
    entry.detail = result.error?.detail;

    // The host began shutting down while this child was still coming up. It is
    // not in `children` yet from `stopAll`'s point of view, so stop it here or
    // it survives the host that spawned it.
    if (this.shuttingDown) {
      if (result.status === "open") await this.supervisor.stop(ref, 0);
      this.setStatus(entry, "closed");
      return result;
    }

    if (result.status === "open") {
      this.setStatus(entry, "open");
      return result;
    }

    // `locked` and `error` are terminal by construction: another process owns
    // the state dir, or the config does not parse. Neither is fixed by trying
    // again, and retrying `locked` would hammer a project someone else is
    // legitimately running.
    if (result.status === "locked" || result.status === "error") {
      entry.tripped = true;
      this.setStatus(entry, result.status, undefined, result.error?.detail);
      return result;
    }

    this.onFailure(entry, ref, "crash", result.error?.detail ?? "child failed to start");
    return result;
  }

  /**
   * A child died or went silent. Either restart it after a backoff, or trip the
   * breaker and leave a visible dead tab.
   */
  private onFailure(entry: Supervised, ref: ProjectRef, reason: SupervisionReason, detail: string): void {
    if (this.shuttingDown) return;
    const at = this.now();
    entry.crashes = [...entry.crashes.filter((t) => at - t < this.opts.crashLoopWindowMs), at];

    // Strictly greater than the threshold: "more than 3 crashes in 60s". Three
    // crashes still get their third restart; the fourth is where we stop.
    if (entry.crashes.length > this.opts.crashLoopThreshold) {
      entry.tripped = true;
      this.clearTimer(entry);
      this.setStatus(
        entry,
        "crashed",
        reason,
        `${detail} — ${entry.crashes.length} crashes in ${Math.round(this.opts.crashLoopWindowMs / 1000)}s, ` +
          `auto-restart disabled. A tab that stays dead is honest; a silent restart loop is not.`,
      );
      return;
    }

    const delay = this.backoff(entry.restarts + 1);
    this.setStatus(entry, "crashed", reason, detail, delay);
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      if (this.shuttingDown || entry.intentional || entry.tripped) return;
      entry.restarts += 1;
      // Restart preserves nothing in memory: the child replays from its last
      // snapshot. That is the point of event sourcing, and why a restart is
      // safe to do blindly here.
      void this.launch(entry, ref);
    }, delay);
    entry.timer.unref?.();
  }

  private startWatchdog(): void {
    if (this.watchdog || this.shuttingDown) return;
    this.watchdog = setInterval(() => this.checkHealth(), this.opts.healthPollMs);
    // The watchdog must not be the reason a host process stays alive.
    this.watchdog.unref?.();
  }

  /**
   * Kill any open child whose heartbeats stopped. A wedged child still holds
   * its port, its state lock and its tab, so it is strictly worse than a dead
   * one: the proxy hangs on it instead of reporting it.
   */
  private checkHealth(): void {
    if (this.shuttingDown) return;
    const at = this.now();
    for (const entry of this.tracked.values()) {
      if (entry.status !== "open" || entry.intentional) continue;
      const child = this.supervisor.running(entry.ref.id);
      if (!child) continue;
      const last = child.lastHeartbeat?.receivedAt ?? entry.startedAt;
      if (at - last < this.opts.heartbeatTimeoutMs) continue;
      const silentFor = Math.round((at - last) / 1000);
      // Stop it first: the restart path assumes the old process is gone, and
      // the state lock will not be free until it is.
      const ref = entry.ref;
      void this.supervisor.stop(ref).then(() => {
        if (this.shuttingDown || entry.intentional) return;
        this.onFailure(entry, ref, "unhealthy", `no heartbeat for ${silentFor}s`);
      });
      // Prevents the next poll from firing on the same child while the stop is
      // still in flight, which would double-count the crash toward the breaker.
      entry.status = "booting";
    }
  }

  private clearTimer(entry: Supervised): void {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
  }

  private setStatus(
    entry: Supervised,
    status: ProjectStatus,
    reason?: SupervisionReason,
    detail?: string,
    retryInMs?: number,
  ): void {
    entry.status = status;
    entry.detail = detail ?? entry.detail;
    const event: SupervisionEvent = { ref: entry.ref, status, restarts: entry.restarts };
    if (reason) event.reason = reason;
    if (typeof retryInMs === "number") event.retryInMs = retryInMs;
    if (detail) event.detail = detail;
    this.onEvent?.(event);
  }
}
