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
import { resolveConfig } from "../../../packages/config/src/index";
import { startServer } from "./index";
import { startCleanIfScriptedDemo } from "./demo";

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

/**
 * The loop-lag radar's cadence. Deliberately the same 1s sample and the same
 * arithmetic as the `/health` route's radar in `index.ts`: a beat that disagreed
 * with the health payload about how late the loop has run would be worse than no
 * beat at all.
 */
export const CHILD_LOOP_LAG_SAMPLE_MS = 1_000;

/**
 * What one beat tells the host about the child's spend.
 *
 * Riding the existing heartbeat rather than adding a cost-polling timer is
 * deliberate. A timer or an aggregation fetch on the host side is the exact
 * shape of bug this design has hit repeatedly — an async resource opened while
 * shutdown is already running that nothing then closes. The beat already
 * exists, is already `unref`'d, and is already cleared on shutdown, so the
 * aggregate cost view costs no new lifecycle at all.
 *
 * Tokens are reported, not dollars: pricing is host-side config, and a child
 * has no business knowing what its operator pays.
 */
export interface ChildBeatPayload {
  rss: number;
  pid: number;
  /**
   * Tokens per model, in the four classes a provider bills separately. `cacheWrite` and `cacheRead` are
   * optional only so a beat from a build that predates them still reads: the host prices what is there.
   * Cache reads are billed (at a fraction of the input price); the mesh's own token BUDGETS weight them at
   * zero by default, but the host's USD ceiling is a statement about the provider's invoice, not a budget.
   */
  models: Array<{ model: string; input: number; output: number; cacheWrite?: number; cacheRead?: number }>;
  /** Turns in flight in this child's scheduler, for the aggregate turn cap. */
  runningTurns: number;
  /**
   * The scheduler mode the child is actually IN, not the one it was launched
   * in. The two diverge the moment an operator calls `/mission/start` or
   * `/mission/park`, and the host sees neither call — it proxies them verbatim.
   * Reporting it here is what lets the host remember "this project is live" and
   * spawn the next child in the same mode instead of silently parking a running
   * mission on the next restart.
   */
  mode: "parked" | "live";
  /**
   * True while the active goal is ACTIVE. A parked child holding an ACTIVE goal
   * is the state that hides itself: every other surface reads "running", and
   * nothing is. The host needs it to say so out loud.
   */
  goalActive: boolean;
  /**
   * How late the loop's own 1s sample last fired, and the worst it has ever been
   * since this process started.
   *
   * The beat says WHEN this child last spoke; these say what it was doing when
   * it did. A host that kills a silent child has to decide between a child whose
   * loop is blocked by synchronous work — which comes back on its own, and whose
   * in-flight turns are exactly what a kill destroys — and one that is wedged
   * for good, and the silence alone cannot tell them apart. `eventLoopLagMaxMs`
   * is a high-water mark rather than a spot reading, so a spike the child
   * recovered from before its final beat is still visible at kill time.
   *
   * What this cannot show: a block that began AFTER the last beat. There the
   * high-water mark still reads small, and the difference between "silent, never
   * blocked" and "blocked, silence still growing" is only visible on the next
   * beat that does not come. A reader should take `eventLoopLagMaxMs` and the
   * measured silence together, never the lag alone.
   */
  eventLoopLagMs: number;
  eventLoopLagMaxMs: number;
}

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

  // The shipped scripted demo behaves the same under a host as under `mesh run`: it starts clean and its
  // scripted team is attached, so it converges with no model and no key. Anything else is a real project.
  const demo = startCleanIfScriptedDemo(resolveConfig(configPath));

  const handle = await startServer({
    configPath,
    // Loopback only. A child must never be reachable off-host: it executes
    // agent-authored code and shell commands, and its only intended caller is
    // the host proxy on the same machine.
    host: "127.0.0.1",
    port: 0,
    mode: env.MESH_CHILD_MODE === "live" ? "live" : "parked",
    uiOnly: env.MESH_CHILD_MODE !== "live",
    // "" (the host had no opinion) is distinct from "0" (the host forced it
    // off): the first defers to this project's mesh.workspace.git, the second
    // overrides it.
    gitMode: env.MESH_CHILD_GIT === "1" ? "on" : env.MESH_CHILD_GIT === "0" ? "off" : "auto",
  });

  if (demo) {
    try {
      const { attachDemoTeam } = await import("../../mesh-cli/src/bench");
      attachDemoTeam(handle.instance);
    } catch (err) {
      process.stderr.write(`demo attach failed: ${(err as Error).message}\n`);
    }
  }

  const ready: ChildReady = {
    port: handle.port,
    pid: process.pid,
    projectId,
    url: handle.url,
  };
  emit(CHILD_READY_PREFIX, ready);

  /**
   * Loop-lag radar, riding the beat so a health kill can say whether this child
   * was blocking itself when it went quiet.
   *
   * The child measures its own lateness rather than being asked for it: a host
   * that could only measure the silence has no way to distinguish a loop blocked
   * by synchronous work from a process that is wedged, and those two want
   * opposite responses — one comes back, the other never will, and killing the
   * first destroys exactly the in-flight turns the kill is trying to protect.
   *
   * `unref`'d and deliberately NOT sampled inside the beat callback: a sample
   * taken on the beat's own tick would be measuring the beat, and a radar that
   * only runs when the loop is free cannot see the blocks it exists to report.
   */
  let loopLagMs = 0;
  let loopLagMaxMs = 0;
  let lastTick = Date.now();
  const lagRadar = setInterval(() => {
    const now = Date.now();
    const lag = Math.max(0, now - lastTick - CHILD_LOOP_LAG_SAMPLE_MS);
    loopLagMs = lag;
    if (lag > loopLagMaxMs) loopLagMaxMs = lag;
    lastTick = now;
  }, CHILD_LOOP_LAG_SAMPLE_MS);
  lagRadar.unref?.();

  const beat = setInterval(() => {
    const payload: ChildBeatPayload = {
      rss: process.memoryUsage.rss(),
      pid: process.pid,
      models: [],
      runningTurns: 0,
      mode: handle.instance.mode,
      goalActive: false,
      eventLoopLagMs: loopLagMs,
      eventLoopLagMaxMs: loopLagMaxMs,
    };
    // Best-effort: a beat that throws would take the interval down with it and
    // the host would read a live child as silent. Spend is a view, liveness is
    // the contract, and the contract wins.
    try {
      for (const m of handle.instance.kernel.state.modelSpend.values()) {
        // `tokens` is what the mesh billed its budgets: input + output + cache writes, so the writes are the rest.
        payload.models.push({ model: m.model, input: m.input, output: m.output, cacheWrite: Math.max(0, m.tokens - m.input - m.output), cacheRead: m.cacheRead });
      }
      payload.runningTurns = handle.instance.scheduler.running();
      const goalId = handle.instance.kernel.state.activeGoalId;
      payload.goalActive = !!goalId && handle.instance.kernel.state.goals.get(goalId)?.status === "ACTIVE";
    } catch {
      /* report liveness anyway */
    }
    emit(CHILD_BEAT_PREFIX, payload);
  }, CHILD_BEAT_INTERVAL_MS);
  // Never hold the process open for a heartbeat: the beat reports liveness, it
  // is not a reason to be alive.
  beat.unref();

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    clearInterval(beat);
    clearInterval(lagRadar);
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
