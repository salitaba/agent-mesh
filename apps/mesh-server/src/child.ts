/**
 * Child entrypoint for the multi-project host.
 *
 * This is a launcher, not a second server: it calls the same `startServer` as
 * `mesh serve`, pinned to loopback on an ephemeral port, and reports the port
 * back to the parent on stdout. No route, handler or projection differs from
 * the single-process path — that is the whole point of the child-process
 * design, and why the host can proxy all ~54 routes verbatim.
 *
 * Contract with the supervisor:
 *   stdin/argv carry nothing secret — the bearer token arrives via
 *   `MESH_API_TOKEN` in the environment so it never appears in `ps` output.
 *   One line on stdout, prefixed with a marker, carries the outcome. Anything
 *   else the mesh logs is passed through untouched.
 */
import { startServer } from "./index";

export const CHILD_READY_PREFIX = "@@mesh-child-ready@@";
export const CHILD_ERROR_PREFIX = "@@mesh-child-error@@";
export const CHILD_BEAT_PREFIX = "@@mesh-child-beat@@";

/**
 * Heartbeat cadence. The host's missed-beat window is a multiple of this, so a
 * single lost tick from a GC pause is not mistaken for a wedged child.
 *
 * The beat runs on the event loop deliberately: a child whose loop is blocked
 * is exactly as useless to the host as one that has died, and the proxy would
 * hang on it either way. Sampling from a thread that cannot stall would report
 * a healthy process that serves no requests.
 */
export const CHILD_BEAT_INTERVAL_MS = 2_000;

/** Exit codes the supervisor maps onto `ProjectStatus` without parsing prose. */
export const CHILD_EXIT = {
  /** State dir is held by another live process — `status: 'locked'`. */
  locked: 78,
  /** Config missing or invalid — `status: 'error'`, not restartable. */
  config: 79,
  /** Anything else — `status: 'crashed'`, restartable. */
  failed: 1,
} as const;

export type ChildReady = {
  port: number;
  pid: number;
  projectId: string;
  url: string;
};

export type ChildFailure = {
  reason: "locked" | "invalid_config" | "failed";
  detail: string;
};

function emit(prefix: string, payload: unknown): void {
  process.stdout.write(`${prefix} ${JSON.stringify(payload)}\n`);
}

export async function runChild(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const configPath = env.MESH_CHILD_CONFIG ?? "";
  if (!configPath) throw new Error("MESH_CHILD_CONFIG is required");
  const projectId = env.MESH_CHILD_PROJECT_ID ?? "";

  const handle = await startServer({
    configPath,
    // Loopback only. A child must never be reachable off-host: it executes
    // agent-authored code and shell commands, and its only intended caller is
    // the host proxy on the same machine.
    host: "127.0.0.1",
    port: 0,
    mode: env.MESH_CHILD_MODE === "live" ? "live" : "parked",
    uiOnly: env.MESH_CHILD_MODE !== "live",
    useGit: env.MESH_CHILD_GIT === "1",
  });

  const ready: ChildReady = {
    port: handle.port,
    pid: process.pid,
    projectId,
    url: handle.url,
  };
  emit(CHILD_READY_PREFIX, ready);

  const beat = setInterval(() => {
    emit(CHILD_BEAT_PREFIX, { rss: process.memoryUsage.rss(), pid: process.pid });
  }, CHILD_BEAT_INTERVAL_MS);
  // Never hold the process open for a heartbeat: the beat reports liveness, it
  // is not a reason to be alive.
  beat.unref();

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    clearInterval(beat);
    // The clean path is what snapshots (P2) and releases the state lock (P1).
    // Escalation to SIGKILL is the parent's job, on a deadline.
    handle
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(CHILD_EXIT.failed));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

function classify(err: unknown): { failure: ChildFailure; code: number } {
  const error = err as Error & { name?: string; code?: string; errors?: string[] };
  const detail = error?.message ?? String(err);
  if (error?.name === "StateLockError") {
    return { failure: { reason: "locked", detail }, code: CHILD_EXIT.locked };
  }
  if (error?.name === "ConfigError" || error?.code === "ENOENT") {
    return { failure: { reason: "invalid_config", detail }, code: CHILD_EXIT.config };
  }
  return { failure: { reason: "failed", detail }, code: CHILD_EXIT.failed };
}

if (require.main === module) {
  runChild().catch((err: unknown) => {
    const { failure, code } = classify(err);
    emit(CHILD_ERROR_PREFIX, failure);
    process.exit(code);
  });
}
