import * as path from "path";
import { FileProjectRegistry } from "../../../packages/projects/src/index";

/** Where `mesh host` listens by default; children never get a fixed port. */
export const DEFAULT_HOST_PORT = 7420;

/** Read at call time, not module load: tests and scripts set the env late. */
export function defaultHostUrl(): string {
  return process.env.MESH_HOST_URL ?? `http://127.0.0.1:${DEFAULT_HOST_PORT}`;
}

export type Flags = Record<string, string | boolean>;

function flagString(flags: Flags, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/** `--host` wins over `MESH_HOST_URL`; trailing slashes are dropped once, here. */
export function hostUrlFrom(flags: Flags): string {
  return (flagString(flags, "host") ?? defaultHostUrl()).replace(/\/+$/, "");
}

/**
 * Bus URL for the read/write commands (`status`, `send`, ...).
 *
 * `--project id` addresses a child *through* the host rather than directly: the
 * child's port is ephemeral and its token is internal, so the host proxy is the
 * only addressable route. `--bus` still wins as the base so a non-default host
 * works with `--bus http://host:1234 --project x`.
 */
export function resolveBus(flags: Flags, fallbackBus: string): string {
  const project = flagString(flags, "project");
  if (!project) return flagString(flags, "bus") ?? fallbackBus;
  const base = (flagString(flags, "bus") ?? hostUrlFrom(flags)).replace(/\/+$/, "");
  return `${base}/api/p/${encodeURIComponent(project)}`;
}

function authHeaders(flags: Flags): Record<string, string> {
  const token = flagString(flags, "token") ?? (process.env.MESH_API_TOKEN ?? "").trim();
  return token ? { authorization: `Bearer ${token}` } : {};
}

export class HostUnreachable extends Error {
  constructor(readonly url: string, readonly reason: Error) {
    super(`no mesh host at ${url} (${reason.message}) — start one with: mesh host`);
    this.name = "HostUnreachable";
  }
}

async function hostJson(
  flags: Flags,
  method: string,
  url: string,
  opts: { body?: unknown; timeoutMs?: number } = {},
): Promise<{ status: number; body: any }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { "content-type": "application/json", ...authHeaders(flags) },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
  } catch (err) {
    throw new HostUnreachable(new URL(url).origin, err as Error);
  }
  const text = await res.text();
  try {
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  } catch {
    return { status: res.status, body: text };
  }
}

/** One project as `/api/projects` reports it. Mirrors `ProjectSummary` loosely. */
interface ProjectRow {
  id: string;
  name?: string;
  root: string;
  status?: string;
  pid?: number;
  health?: { rss?: number; restarts?: number };
  error?: { reason?: string; detail?: string };
  restartInMs?: number;
  tripped?: boolean;
}

const PROJECT_HELP = `usage:
  mesh project list [--json]               registered projects + live status
  mesh project add <dir|mesh.yaml>         register a folder (does not boot it)
  mesh project remove <id>                 drop the pointer (never deletes files)
  mesh project open <id>                   boot the project's child process
  mesh project close <id>                  stop it (clean shutdown, then SIGKILL)
  mesh project restart <id>                close + open, clearing the crash breaker
common flags: --host url (default ${"$MESH_HOST_URL"} or http://127.0.0.1:${DEFAULT_HOST_PORT}), --home dir, --json`;

function mb(bytes: number | undefined): string {
  if (!bytes || !Number.isFinite(bytes)) return "—";
  return `${Math.round(bytes / (1024 * 1024))}M`;
}

function printRows(rows: ProjectRow[], note?: string): void {
  if (rows.length === 0) {
    console.log("no projects registered — add one with: mesh project add <dir>");
    return;
  }
  for (const r of rows) {
    const status = r.tripped ? `${r.status ?? "?"} (breaker)` : (r.status ?? "?");
    const extra = [
      r.pid ? `pid:${r.pid}` : "",
      r.health?.rss ? `rss:${mb(r.health.rss)}` : "",
      r.health?.restarts ? `restarts:${r.health.restarts}` : "",
      typeof r.restartInMs === "number" ? `retry in ${Math.round(r.restartInMs / 1000)}s` : "",
      r.error?.reason ? `error:${r.error.reason}` : "",
    ]
      .filter(Boolean)
      .join("  ");
    console.log(`  ${r.id.padEnd(22)} ${status.padEnd(18)} ${r.root}${extra ? `  ${extra}` : ""}`);
    if (r.error?.detail) console.log(`    ${r.error.detail}`);
  }
  if (note) console.log(`\n${note}`);
}

/**
 * Registry access without a host.
 *
 * Safe for the pointer-only operations: `projects.json` writes take the same
 * cross-process lock a host would. It deliberately cannot open anything — a
 * child outliving the CLI invocation that spawned it would be an orphan with
 * nothing left to supervise it.
 */
function offlineRegistry(flags: Flags): FileProjectRegistry {
  const home = flagString(flags, "home");
  return new FileProjectRegistry(home ? { home: path.resolve(home) } : {});
}

function failed(status: number, body: any): Error {
  const detail = body?.detail ? ` (${body.detail})` : "";
  return new Error(`host returned ${status}: ${body?.error ?? JSON.stringify(body ?? null)}${detail}`);
}

export async function runProjectCommand(positional: string[], flags: Flags): Promise<number> {
  const sub = positional[0] ?? "list";
  const base = hostUrlFrom(flags);
  const asJson = Boolean(flags.json);

  switch (sub) {
    case "list":
    case "ls": {
      try {
        const { status, body } = await hostJson(flags, "GET", `${base}/api/projects`, { timeoutMs: 10_000 });
        if (status !== 200) throw failed(status, body);
        const rows: ProjectRow[] = body?.projects ?? [];
        if (asJson) console.log(JSON.stringify(rows, null, 2));
        else printRows(rows, `host: ${base}`);
        return 0;
      } catch (err) {
        if (!(err instanceof HostUnreachable)) throw err;
        // No host is a normal state, not an error: the registry is a file, so
        // report it and say the statuses are unknown rather than guessed.
        const registry = offlineRegistry(flags);
        const rows: ProjectRow[] = registry.list().map((r) => ({ id: r.id, name: r.name, root: r.root }));
        if (asJson) console.log(JSON.stringify(rows, null, 2));
        else printRows(rows, `no host at ${base} — statuses unknown (registry: ${registry.file})`);
        return 0;
      }
    }
    case "add": {
      const target = positional[1];
      if (!target) throw new Error("usage: mesh project add <dir|mesh.yaml>");
      const root = path.resolve(target);
      try {
        const { status, body } = await hostJson(flags, "POST", `${base}/api/projects`, { body: { root }, timeoutMs: 15_000 });
        if (status !== 201 && status !== 200) throw failed(status, body);
        console.log(`added ${body.id} (${body.root})`);
        return 0;
      } catch (err) {
        if (!(err instanceof HostUnreachable)) throw err;
        const ref = await offlineRegistry(flags).add(root);
        console.log(`added ${ref.id} (${ref.root})  [offline: no host at ${base}]`);
        return 0;
      }
    }
    case "remove":
    case "rm": {
      const id = positional[1];
      if (!id) throw new Error("usage: mesh project remove <id>");
      try {
        const { status, body } = await hostJson(flags, "DELETE", `${base}/api/projects/${encodeURIComponent(id)}`, { timeoutMs: 30_000 });
        if (status !== 200) throw failed(status, body);
        console.log(`removed ${id} (files untouched)`);
        return 0;
      } catch (err) {
        if (!(err instanceof HostUnreachable)) throw err;
        await offlineRegistry(flags).remove(id);
        console.log(`removed ${id} (files untouched)  [offline: no host at ${base}]`);
        return 0;
      }
    }
    case "open":
    case "close":
    case "restart": {
      const id = positional[1];
      if (!id) throw new Error(`usage: mesh project ${sub} <id>`);
      // No offline path on purpose: these own a child process for as long as it
      // lives, and a CLI invocation that exits in a second cannot supervise one.
      const { status, body } = await hostJson(flags, "POST", `${base}/api/projects/${encodeURIComponent(id)}/${sub}`, {
        timeoutMs: sub === "close" ? 60_000 : 120_000,
      });
      if (status !== 200) throw failed(status, body);
      if (asJson) {
        console.log(JSON.stringify(body, null, 2));
        return 0;
      }
      printRows([body as ProjectRow]);
      // `open` answers 200 with a failure status so the caller can render a
      // crashed or locked tab; a CLI has no tab, so the shell gets a non-zero.
      const st = String((body as ProjectRow).status ?? "");
      if (sub !== "close" && st !== "open" && st !== "booting") {
        console.error(`project ${id} did not come up: ${st}`);
        return 1;
      }
      return 0;
    }
    case "help":
      console.log(PROJECT_HELP);
      return 0;
    default:
      console.error(`unknown subcommand: mesh project ${sub}\n`);
      console.log(PROJECT_HELP);
      return 1;
  }
}

export const HOST_HELP = `usage:
  mesh host [--port n] [--home dir] [--memory mb] [--live] [--git] [--dashboard dir]
    supervises every open project as a child process and serves the dashboard.
    --port       default ${DEFAULT_HOST_PORT}
    --home       registry home (default $MESH_HOME or ~/.agent-mesh)
    --memory     per-child --max-old-space-size in MB
    --live       children boot live; default is parked, like 'mesh console'
    --git        children use git worktrees for artifacts

  resource policy lives in <home>/host.yaml (all keys optional):
    host:
      project_memory_mb: 512        # per-child --max-old-space-size
      max_concurrent_turns: null    # null = unlimited
      spend_ceiling_usd: 50         # aggregate across open projects; null disables
      model_prices:                 # USD per million tokens
        anthropic/claude-sonnet-4: { input_per_mtok: 3, output_per_mtok: 15 }`;

/** Flags -> `HostOptions`, kept pure so the mapping is testable without a boot. */
export function hostOptionsFromFlags(flags: Flags): Record<string, unknown> {
  const opts: Record<string, unknown> = {
    port: flags.port ? Number(flags.port) : DEFAULT_HOST_PORT,
    childMode: flags.live ? "live" : "parked",
    useGit: Boolean(flags.git),
    // The host outlives the command, so it — not the CLI — owns the signal
    // path: SIGTERM must drain every child before the process goes away.
    handleSignals: true,
  };
  const home = flagString(flags, "home");
  if (home) opts.home = path.resolve(home);
  const host = flagString(flags, "bind");
  if (host) opts.host = host;
  const dashboard = flagString(flags, "dashboard");
  if (dashboard) opts.dashboardDir = path.resolve(dashboard);
  if (flags.memory) opts.projectMemoryMb = Number(flags.memory);
  return opts;
}

export async function runHostCommand(flags: Flags): Promise<number> {
  if (flags.help) {
    console.log(HOST_HELP);
    return 0;
  }
  const { startHostServer } = await import("../../mesh-server/src/host");
  const handle = await startHostServer(hostOptionsFromFlags(flags) as Parameters<typeof startHostServer>[0]);
  const open = handle.registry.openIds();
  console.log(`mesh host online at ${handle.url}  (${handle.registry.list().length} project(s) registered, ${open.length} open)`);
  if (handle.reaped.length) console.log(`  reaped stranded children: ${handle.reaped.join(", ")}`);
  console.log(`  dashboard: ${handle.url}/    projects: mesh project list --host ${handle.url}    (Ctrl-C to stop)`);
  // startHostServer's own SIGTERM/SIGINT handler drains the children and exits,
  // so this never resolves; returning would tear the host down immediately.
  await new Promise<void>(() => {});
  return 0;
}
