import * as fs from "fs";

/**
 * Whether a recorded process is still THE process that was recorded.
 *
 * A pid answers "is something running under this number", which is the wrong question once a state
 * directory outlives the container that wrote into it. A pidfile or a lock file on a volume names a
 * pid from a pid namespace that no longer exists; pods and containers start numbering from the same
 * small integers, so the new pod's own processes are very likely wearing the number the old pod's
 * child had. Two things went wrong with that: a lock held by a dead pod looked held by a live one,
 * and the orphan sweep would have signalled an unrelated process in the new pod.
 *
 * On Linux a process is identified by when it started (clock ticks since boot, field 22 of
 * /proc/<pid>/stat) together with the boot id, which separates two boots that reuse a tick count.
 * Where /proc is unavailable the identity is null and callers fall back to the pid alone, which is
 * exactly what they did before.
 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists and is not ours.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

let bootId: string | null | undefined;

function readBootId(): string | null {
  if (bootId !== undefined) return bootId;
  try {
    bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
  } catch {
    bootId = null;
  }
  return bootId;
}

/** The start-time field of a `/proc/<pid>/stat` line. `comm` may hold spaces and parentheses, so count from the last `)`. */
export function startTimeFromStat(stat: string): string | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  // After "<pid> (<comm>)" the fields resume at 3 (state); starttime is field 22, so index 19 of the remainder.
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const start = fields[19];
  return start && /^\d+$/.test(start) ? start : null;
}

/** `<boot id>:<start ticks>` for a running pid, or null when it cannot be read (no /proc, no such process). */
export function processIdentity(pid: number): string | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const boot = readBootId();
  if (!boot) return null;
  try {
    const start = startTimeFromStat(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
    return start ? `${boot}:${start}` : null;
  } catch {
    return null;
  }
}

/**
 * Is `pid` running, and, when an identity was recorded for it and can be read now, is it the same
 * process? A record from before identities existed (or from a platform without them) is judged by the
 * pid alone, which preserves the old behaviour rather than guessing.
 */
export function processAlive(pid: number, recordedIdentity?: string | null): boolean {
  if (!pidAlive(pid)) return false;
  if (!recordedIdentity) return true;
  const now = processIdentity(pid);
  if (now === null) return true;
  return now === recordedIdentity;
}
