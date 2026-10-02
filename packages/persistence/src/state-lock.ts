import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import { processAlive, processIdentity } from "./process-identity";

/**
 * Single-writer advisory lock over a mesh state directory.
 *
 * The event log is the only source of truth in this system and
 * `JsonlEventStore` serializes appends with an in-process promise chain only.
 * Two processes opening the same `<stateDir>` therefore interleave partial
 * lines into `events.jsonl`, which is unrecoverable — there is no ORM and no
 * second copy of the state. The lock makes "one process owns one state dir"
 * enforceable rather than conventional.
 *
 * Advisory, not mandatory: a process that never calls `acquireStateLock` is
 * unaffected. Every path that opens a state dir (`ordane run`, the console, and
 * later the multi-project host's children) must go through it.
 */
export interface StateLockInfo {
  pid: number;
  host: string;
  projectId: string;
  startedAt: string;
  /** Distinguishes lock generations so release never unlinks someone else's lock. */
  token: string;
  /**
   * Who the writer is, stable across restarts of one deployment: `MESH_INSTANCE_ID`, else the hostname.
   * A pod's hostname changes with every replacement, so it cannot say "this is the same deployment";
   * an id the operator sets (the Helm chart sets the release name) can. Absent in locks written before
   * it existed, which fall back to `host`.
   */
  instance?: string;
  /**
   * `processIdentity(pid)` where the platform can say: when this process started, so a later reader can
   * tell it from a different process that is wearing the same number in a new container.
   */
  startId?: string;
  /** The last time the holder proved it was alive (ISO). Refreshed while the lock is held. */
  heartbeatAt?: string;
}

export interface StateLockHandle {
  readonly file: string;
  readonly info: StateLockInfo;
  /** Idempotent. Only removes the file when it still carries this handle's token. */
  release(): void;
  /**
   * Rewrite the lock file after the state dir was replaced underneath it
   * (mission reset renames the whole directory away). Without this the lock
   * silently stops existing and a second process could open the same dir.
   */
  refresh(): void;
}

export class StateLockError extends Error {
  constructor(
    message: string,
    readonly holder: StateLockInfo | null,
    readonly file: string,
  ) {
    super(message);
    this.name = "StateLockError";
  }
}

export const STATE_LOCK_FILENAME = ".mesh-lock.json";

/** How often a held lock says it is alive, and how long without that before another instance may take it. */
export const LOCK_HEARTBEAT_MS = 15_000;
export const LOCK_STALE_MS = 120_000;
/** A heartbeat dated further ahead than this means the two clocks disagree, which is not evidence of death. */
const MAX_FUTURE_SKEW_MS = 30_000;

function readHolder(file: string): StateLockInfo | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<StateLockInfo>;
    if (typeof parsed?.pid !== "number") return null;
    const info: StateLockInfo = {
      pid: parsed.pid,
      host: String(parsed.host ?? ""),
      projectId: String(parsed.projectId ?? ""),
      startedAt: String(parsed.startedAt ?? ""),
      token: String(parsed.token ?? ""),
    };
    if (typeof parsed.instance === "string" && parsed.instance) info.instance = parsed.instance;
    if (typeof parsed.startId === "string" && parsed.startId) info.startId = parsed.startId;
    if (typeof parsed.heartbeatAt === "string" && parsed.heartbeatAt) info.heartbeatAt = parsed.heartbeatAt;
    return info;
  } catch {
    // Unreadable or truncated lock file: treat as no holder. A lock written
    // by a process that died mid-write must not wedge the directory forever.
    return null;
  }
}

/**
 * Held locks are released on process exit so a bootstrap that throws after
 * acquisition (bad config, git failure, runtime spawn) does not strand the
 * directory for the lifetime of the process.
 */
const held = new Set<StateLockHandle>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const handle of [...held]) {
      try {
        handle.release();
      } catch {
        /* teardown is best-effort */
      }
    }
  });
}

/** The writer's identity for locking: `MESH_INSTANCE_ID` when the deployment names one, else the hostname. */
export function lockInstance(env: NodeJS.ProcessEnv = process.env): string {
  return (env.MESH_INSTANCE_ID ?? "").trim() || os.hostname();
}

export type HolderVerdict = { reclaim: true; reason: string } | { reclaim: false; reason: string };

export interface HolderJudgement {
  /** This process's instance (see `lockInstance`) and pid. */
  instance: string;
  pid: number;
  /** Whether a live handle in this process already owns the lock file. */
  heldByMe: boolean;
  now: number;
  /** How long a foreign heartbeat may be silent before its lock can be taken. */
  staleMs: number;
  /** Whether a lock from another instance may ever be taken over. `MESH_LOCK_RECLAIM_FOREIGN=0` says no. */
  reclaimForeign: boolean;
}

/**
 * Decide whether an existing lock can be taken over. Pure, so the cases that matter (and there are
 * several, because "who is holding this?" has a different answer in a pod than on a laptop) are
 * tested without processes.
 *
 * - No readable holder: take it. A process that died mid-write must not wedge the directory.
 * - Same instance (this deployment, an earlier life): the holder is judged by whether THAT process is
 *   still running, by identity and not by number alone. A pod that was SIGKILLed or OOM-killed leaves
 *   its lock on the volume, and the replacement pod has the same instance id and a different hostname.
 * - Another instance: liveness cannot be checked from here, so only silence can speak for it. A
 *   holder that writes a heartbeat and has not for `staleMs` is taken over; one that never wrote one
 *   (a lock from before heartbeats) is never taken, as before. A heartbeat dated in the future means
 *   the clocks disagree, which proves nothing about the holder, so that is not taken either.
 */
export function judgeHolder(holder: StateLockInfo | null, me: HolderJudgement): HolderVerdict {
  if (holder === null) return { reclaim: true, reason: "the lock file is unreadable" };
  const holderInstance = holder.instance || holder.host;
  if (holderInstance === me.instance) {
    if (holder.pid === me.pid) {
      return me.heldByMe
        ? { reclaim: false, reason: "this process already holds it" }
        : { reclaim: true, reason: "left by an earlier process that had this pid" };
    }
    return processAlive(holder.pid, holder.startId)
      ? { reclaim: false, reason: `pid ${holder.pid} is still running` }
      : { reclaim: true, reason: `pid ${holder.pid} is no longer running` };
  }
  if (!me.reclaimForeign) return { reclaim: false, reason: `held by another instance (${holderInstance}) and taking over is switched off` };
  if (!holder.heartbeatAt) return { reclaim: false, reason: `held by another instance (${holderInstance}) that does not report a heartbeat` };
  const age = me.now - Date.parse(holder.heartbeatAt);
  if (!Number.isFinite(age)) return { reclaim: false, reason: "its heartbeat is unreadable" };
  if (age < -MAX_FUTURE_SKEW_MS) return { reclaim: false, reason: `its heartbeat is ${Math.round(-age / 1000)}s in the future: the clocks disagree` };
  if (age > me.staleMs) return { reclaim: true, reason: `no heartbeat from instance ${holderInstance} for ${Math.round(age / 1000)}s` };
  return { reclaim: false, reason: `instance ${holderInstance} reported ${Math.max(0, Math.round(age / 1000))}s ago; it can be taken over after ${Math.round(me.staleMs / 1000)}s of silence` };
}

export interface AcquireOptions {
  projectId?: string;
  /** Called when the lock was taken from this process by another one. Default: say so and exit 70. */
  onLost?: (holder: StateLockInfo) => void;
  /** Test seams. */
  now?: () => number;
  heartbeatMs?: number;
  staleMs?: number;
  instance?: string;
}

/**
 * Take the exclusive lock on `stateDir`.
 *
 * Throws `StateLockError` when another live process holds it. A lock whose holder is gone is
 * reclaimed (see `judgeHolder`): a SIGKILLed mesh, or a pod that was replaced, must not require
 * manual cleanup. A lock held by another machine is taken over only after its heartbeat has been
 * silent long enough to be a missing machine rather than a slow one.
 *
 * Once held, the lock refreshes its heartbeat and checks, each time, that the file still carries this
 * handle's token. If it does not, another process took it (a pause longer than the stale window), and
 * continuing to write would interleave two writers into one log: the default response is to exit.
 */
export function acquireStateLock(stateDir: string, opts: AcquireOptions = {}): StateLockHandle {
  const dir = path.resolve(stateDir);
  const file = path.join(dir, STATE_LOCK_FILENAME);
  const now = opts.now ?? Date.now;
  const instance = opts.instance ?? lockInstance();
  const staleMs = opts.staleMs ?? (Number(process.env.MESH_LOCK_STALE_MS) > 0 ? Number(process.env.MESH_LOCK_STALE_MS) : LOCK_STALE_MS);
  const startId = processIdentity(process.pid);
  const info: StateLockInfo = {
    pid: process.pid,
    host: os.hostname(),
    projectId: opts.projectId ?? "",
    startedAt: new Date(now()).toISOString(),
    token: randomUUID(),
    instance,
    ...(startId ? { startId } : {}),
    heartbeatAt: new Date(now()).toISOString(),
  };
  const render = (): string => JSON.stringify(info, null, 2);

  const write = (): void => {
    fs.mkdirSync(dir, { recursive: true });
    // "wx" is an atomic create-or-fail: the exclusivity is the open(2) flag,
    // not a check-then-write, so two processes racing here cannot both win.
    fs.writeFileSync(file, render(), { encoding: "utf8", flag: "wx" });
  };

  try {
    write();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const holder = readHolder(file);
    // A lock this process still holds is a genuine double-open: the caller has two live meshes
    // pointed at one directory, and the message should say so.
    const heldByMe = holder !== null && [...held].some((h) => h.file === file && h.info.token === holder.token);
    if (holder !== null && heldByMe && holder.pid === info.pid) {
      throw new StateLockError(
        `state directory is already open by this process (project ${holder.projectId || "?"}): ${dir}`,
        holder,
        file,
      );
    }
    const verdict = judgeHolder(holder, {
      instance,
      pid: info.pid,
      heldByMe,
      now: now(),
      staleMs,
      reclaimForeign: (process.env.MESH_LOCK_RECLAIM_FOREIGN ?? "").trim() !== "0",
    });
    if (!verdict.reclaim) {
      const who = holder
        ? `pid ${holder.pid} on ${holder.host}${holder.projectId ? ` (project ${holder.projectId})` : ""} since ${holder.startedAt}`
        : "an unknown process";
      throw new StateLockError(
        `state directory is already in use by ${who}: ${dir}\n` +
          `${verdict.reason}. Close that mesh first, or delete ${file} if you are certain it is stale.`,
        holder,
        file,
      );
    }
    fs.rmSync(file, { force: true });
    try {
      write();
    } catch (retryErr) {
      if ((retryErr as NodeJS.ErrnoException).code !== "EEXIST") throw retryErr;
      // Lost the reclaim race to another process doing the same thing.
      const winner = readHolder(file);
      throw new StateLockError(
        `state directory was claimed by pid ${winner?.pid ?? "?"} while reclaiming a stale lock: ${dir}`,
        winner,
        file,
      );
    }
  }

  let released = false;
  let timer: NodeJS.Timeout | undefined;
  const stopBeating = (): void => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  /** Replace the file in one rename, so a reader never sees half of it and takes that for an empty lock. */
  const writeAtomic = (): void => {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, render(), "utf8");
    fs.renameSync(tmp, file);
  };
  const lose = (holder: StateLockInfo): void => {
    released = true;
    held.delete(handle);
    stopBeating();
    if (opts.onLost) return opts.onLost(holder);
    process.stderr.write(
      `[mesh] FATAL: the state lock on ${dir} was taken by pid ${holder.pid} on ${holder.host} while this process was paused or cut off. ` +
        `Two writers on one event log corrupt it, so this process is exiting.\n`,
    );
    process.exit(70);
  };
  const beat = (): void => {
    if (released) return;
    const current = readHolder(file);
    if (current !== null && current.token !== info.token) return lose(current);
    info.heartbeatAt = new Date(now()).toISOString();
    try {
      // Only into a directory that is still there: a mission reset moves it away and `refresh()` makes
      // the new one, and this must not conjure the old one back.
      if (fs.existsSync(dir)) writeAtomic();
    } catch {
      /* a missed beat is only a missed beat; the next one tries again */
    }
  };

  const handle: StateLockHandle = {
    file,
    info,
    release(): void {
      if (released) return;
      released = true;
      held.delete(handle);
      stopBeating();
      // Only unlink our own generation. After a mission reset the directory
      // (and the lock in it) may have been archived and rewritten; blindly
      // unlinking would drop a lock we no longer own.
      const current = readHolder(file);
      if (current !== null && current.token !== info.token) return;
      fs.rmSync(file, { force: true });
    },
    refresh(): void {
      if (released) return;
      fs.mkdirSync(dir, { recursive: true });
      info.heartbeatAt = new Date(now()).toISOString();
      fs.writeFileSync(file, render(), "utf8");
    },
  };
  held.add(handle);
  installExitHook();
  const every = opts.heartbeatMs ?? LOCK_HEARTBEAT_MS;
  timer = setInterval(beat, every);
  (timer as unknown as { unref?: () => void }).unref?.();
  return handle;
}
