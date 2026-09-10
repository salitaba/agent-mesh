import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";

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
 * unaffected. Every path that opens a state dir (`mesh run`, the console, and
 * later the multi-project host's children) must go through it.
 */
export interface StateLockInfo {
  pid: number;
  host: string;
  projectId: string;
  startedAt: string;
  /** Distinguishes lock generations so release never unlinks someone else's lock. */
  token: string;
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

/** Live PIDs cannot be reclaimed. EPERM means the process exists but is not ours. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readHolder(file: string): StateLockInfo | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<StateLockInfo>;
    if (typeof parsed?.pid !== "number") return null;
    return {
      pid: parsed.pid,
      host: String(parsed.host ?? ""),
      projectId: String(parsed.projectId ?? ""),
      startedAt: String(parsed.startedAt ?? ""),
      token: String(parsed.token ?? ""),
    };
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

/**
 * Take the exclusive lock on `stateDir`.
 *
 * Throws `StateLockError` when another live process holds it. A lock whose PID
 * is dead (and which was written by this host) is reclaimed: a SIGKILLed mesh
 * must not require manual cleanup. Locks from a different host are never
 * reclaimed — liveness cannot be checked across machines, and a shared
 * filesystem is exactly where a wrong guess corrupts the log.
 */
export function acquireStateLock(stateDir: string, opts: { projectId?: string } = {}): StateLockHandle {
  const dir = path.resolve(stateDir);
  const file = path.join(dir, STATE_LOCK_FILENAME);
  const info: StateLockInfo = {
    pid: process.pid,
    host: os.hostname(),
    projectId: opts.projectId ?? "",
    startedAt: new Date().toISOString(),
    token: randomUUID(),
  };
  const payload = JSON.stringify(info, null, 2);

  const write = (): void => {
    fs.mkdirSync(dir, { recursive: true });
    // "wx" is an atomic create-or-fail: the exclusivity is the open(2) flag,
    // not a check-then-write, so two processes racing here cannot both win.
    fs.writeFileSync(file, payload, { encoding: "utf8", flag: "wx" });
  };

  try {
    write();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const holder = readHolder(file);
    const sameHost = holder !== null && holder.host === info.host;
    // A lock this process still holds is a genuine double-open, never stale —
    // `pidAlive` would say "alive" and reject it anyway, but the message
    // matters: the caller has two live meshes pointed at one directory.
    if (holder !== null && sameHost && holder.pid === info.pid) {
      const mine = [...held].some((h) => h.file === file && h.info.token === holder.token);
      if (mine) {
        throw new StateLockError(
          `state directory is already open by this process (project ${holder.projectId || "?"}): ${dir}`,
          holder,
          file,
        );
      }
    }
    // Own-pid locks that no live handle claims are debris from a bootstrap
    // that threw after acquiring; reclaim them instead of wedging retries.
    const ownStale = holder !== null && sameHost && holder.pid === info.pid;
    const reclaimable = holder === null || ownStale || (sameHost && !pidAlive(holder.pid));
    if (!reclaimable) {
      const who = holder
        ? `pid ${holder.pid} on ${holder.host}${holder.projectId ? ` (project ${holder.projectId})` : ""} since ${holder.startedAt}`
        : "an unknown process";
      throw new StateLockError(
        `state directory is already in use by ${who}: ${dir}\n` +
          `Close that mesh first, or delete ${file} if you are certain it is stale.`,
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
  const handle: StateLockHandle = {
    file,
    info,
    release(): void {
      if (released) return;
      released = true;
      held.delete(handle);
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
      fs.writeFileSync(file, payload, "utf8");
    },
  };
  held.add(handle);
  installExitHook();
  return handle;
}
