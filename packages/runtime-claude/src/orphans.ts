import * as fs from "fs";
import * as path from "path";
import { withoutOuterSession } from "./host-isolation";

/**
 * Seat CLIs left running by a mesh process that died.
 *
 * Each seat is a long-lived `claude` child holding a streaming session. SIGKILL
 * (or an OOM kill, or losing the machine's power and getting it back) takes the
 * parent and leaves the child: reparented to init, still mid-turn, still calling
 * the API, its spend recorded nowhere. It only notices when it finishes the turn
 * and finds its stdin closed -- measured 2026-09-30 at 56 s and counting after the
 * kill -- and meanwhile the restarted mesh resumes the SAME session id, so two
 * CLIs can be writing to one transcript.
 *
 * The adapter stamps every seat it spawns with the pid of the process that spawned
 * it (`HOST_PID_ENV`); a child inherits its parent's environment, so the stamp also
 * reaches whatever the seat started. The next mesh process to start reads the
 * environment of the processes it is allowed to see, finds stamps whose host is
 * gone, and stops them before it spawns anything of its own.
 *
 * Linux only (`/proc/<pid>/environ`): elsewhere there is no cheap, reliable way to
 * read another process's environment, and the honest answer is to do nothing and
 * say so. A pid that has since been reused by an unrelated process reads as a live
 * host and is left alone, which fails safe: a leak persists, nothing innocent dies.
 */

/** Stamped on every seat CLI: the pid of the mesh process that spawned it. */
export const HOST_PID_ENV = "AGENT_MESH_HOST_PID";

/**
 * The mesh's own credentials, which no seat has a use for.
 *
 * A seat's shell inherits the CLI's environment, and the CLI inherits the mesh's. `MESH_API_TOKEN` is the
 * operator's token (or, under a host, this child's own): a seat that reads it can call the API as the
 * operator, which is `POST /approvals {by: "human"}`, `/mission/reset`, `/config/save`, past every gate
 * the mesh enforces on the seat. `MESH_LICENSE_KEY` is the vendor-signed entitlement. A seat reaches the
 * mesh through its MCP bridge with a per-seat token the adapter hands that bridge directly, so none of
 * these is ever needed in the seat's own environment, and a seat prompt-injected through a web fetch is
 * the case this is for.
 *
 * Anything named like a mesh token, secret or password goes: a credential added later is covered without
 * anyone remembering to list it. Not touched: `ANTHROPIC_*`, which the seat's own CLI needs to reach the
 * model, and the rest of the process environment (that is a separate decision, documented in
 * docs/commercial/security.md: run the mesh in an environment that holds only what a seat may use).
 */
export function isMeshSecret(name: string): boolean {
  return name === "MESH_API_TOKEN" || name === "MESH_LICENSE_KEY" || /^MESH_.*(TOKEN|SECRET|PASSWORD)$/.test(name);
}

/** `env` without the mesh's own credentials. */
export function withoutMeshSecrets(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !isMeshSecret(name)));
}

/**
 * The environment a seat CLI is spawned with: `base` (the operator's own `env`
 * option when they passed one, the process environment otherwise) plus the stamp.
 * The SDK replaces its inherited environment with whatever `env` is given, so the
 * base is spread here rather than assumed.
 *
 * The process environment never carries the mesh's own credentials into a seat (see
 * `isMeshSecret`). An `env` the operator passed is taken as given: it is theirs.
 */
export function seatEnv(
  base: Record<string, string | undefined> | undefined,
  pid: number = process.pid,
  opts: { isolate?: boolean } = {},
): Record<string, string | undefined> {
  // `isolate`: also drop the variables that describe the session the mesh was started
  // from (see host-isolation.ts).
  const inherited = base ?? withoutMeshSecrets(process.env);
  return { ...(opts.isolate && base === undefined ? withoutOuterSession(inherited) : inherited), [HOST_PID_ENV]: String(pid) };
}

export interface OrphanSeat {
  /** A process stamped by a mesh process that no longer exists. */
  pid: number;
  /** The pid the stamp names. */
  hostPid: number;
}

/** Everything the scan touches from outside, so a test can give it a fake `/proc` and dead hosts. */
export interface ReapEnv {
  /** Default `/proc`. */
  procDir?: string;
  /** This process; its own children and its own stamp are never orphans. Default `process.pid`. */
  selfPid?: number;
  /** Default: `process.kill(pid, 0)`, and a zombie (`/proc/<pid>/stat` state Z or X) counts as gone. */
  isAlive?: (pid: number) => boolean;
  /** Default `process.kill`. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Wait between SIGTERM and the SIGKILL for whatever ignored it. Default 2000. */
  graceMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ReapResult {
  found: OrphanSeat[];
  /** Gone after SIGTERM, or already gone. */
  stopped: number[];
  /** Still there after SIGKILL (another user's, or unkillable): reported, never retried. */
  survivors: number[];
}

function stampOf(environ: string): number | undefined {
  const prefix = `${HOST_PID_ENV}=`;
  for (const entry of environ.split("\0")) {
    if (!entry.startsWith(prefix)) continue;
    const n = Number(entry.slice(prefix.length));
    return Number.isInteger(n) && n > 1 ? n : undefined;
  }
  return undefined;
}

function defaultIsAlive(procDir: string): (pid: number) => boolean {
  return (pid) => {
    try {
      process.kill(pid, 0);
    } catch (err) {
      // EPERM: it exists and is somebody else's. ESRCH: it does not.
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
    try {
      const stat = fs.readFileSync(path.join(procDir, String(pid), "stat"), "utf8");
      // `pid (comm) S ...`: comm may itself hold spaces and parentheses, so the
      // state is the first letter after the LAST closing parenthesis.
      const state = stat.slice(stat.lastIndexOf(")") + 1).trim()[0];
      if (state === "Z" || state === "X") return false;
    } catch {
      // No /proc entry to consult: kill(0) already said it exists.
    }
    return true;
  };
}

/** Stamped processes whose host is gone. Reads only; signals nothing. */
export function findOrphanSeats(env: ReapEnv = {}): OrphanSeat[] {
  const procDir = env.procDir ?? "/proc";
  const selfPid = env.selfPid ?? process.pid;
  const isAlive = env.isAlive ?? defaultIsAlive(procDir);
  let entries: string[];
  try {
    entries = fs.readdirSync(procDir);
  } catch {
    return [];
  }
  const found: OrphanSeat[] = [];
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid <= 1 || pid === selfPid) continue;
    let environ: string;
    try {
      environ = fs.readFileSync(path.join(procDir, name, "environ"), "utf8");
    } catch {
      // Not ours to read (another user's), or gone between the listing and the read.
      continue;
    }
    const hostPid = stampOf(environ);
    if (hostPid === undefined || hostPid === selfPid || isAlive(hostPid)) continue;
    found.push({ pid, hostPid });
  }
  return found;
}

/** Stop every orphaned seat: SIGTERM, a grace period, then SIGKILL for what is left. */
export async function reapOrphanSeats(env: ReapEnv = {}): Promise<ReapResult> {
  const found = findOrphanSeats(env);
  const procDir = env.procDir ?? "/proc";
  const isAlive = env.isAlive ?? defaultIsAlive(procDir);
  const kill = env.kill ?? ((pid: number, signal: NodeJS.Signals) => void process.kill(pid, signal));
  const sleep = env.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  if (found.length === 0) return { found, stopped: [], survivors: [] };

  const signal = (pid: number, sig: NodeJS.Signals): void => {
    try {
      kill(pid, sig);
    } catch {
      // Already gone, or not ours to signal: the liveness check below decides which.
    }
  };
  for (const { pid } of found) signal(pid, "SIGTERM");
  await sleep(env.graceMs ?? 2000);
  const stillUp = found.filter(({ pid }) => isAlive(pid));
  for (const { pid } of stillUp) signal(pid, "SIGKILL");
  if (stillUp.length > 0) await sleep(200);
  const survivors = stillUp.filter(({ pid }) => isAlive(pid)).map(({ pid }) => pid);
  return { found, stopped: found.map(({ pid }) => pid).filter((pid) => !survivors.includes(pid)), survivors };
}
