import * as fs from "fs";
import * as path from "path";
import { resolveConfig, loadMeshFile, ConfigError } from "../../../packages/config/src/index";
import { writeDefaultMeshYaml } from "../../../packages/config/src/index";
import { SCHEMAS, isSettledArtifactStatus, type GitMode } from "../../../packages/protocol/src/index";
import { buildRunReport, renderRunReport } from "../../../packages/core/src/run-report";
import { JsonlEventStore } from "../../../packages/event-store/src/index";
import { systemClock } from "../../../packages/protocol/src/index";
import { startServer } from "../../mesh-server/src/index";
import { UnsafeListenError } from "../../mesh-server/src/web-security";
import { serverVersion } from "../../mesh-server/src/version";
import { LicenseLimitError } from "../../mesh-server/src/license";
import { runTui } from "./tui";
import { runBenchmark } from "./bench";
import { DEFAULT_HOST_PORT, authHeaders, gitModeFromFlags, resolveBus, runHostCommand, runProjectCommand, type Flags } from "./projects";
import { BACKUPS_HELP, RESTORE_HELP, runBackupsCommand, runRestoreCommand } from "./backups";
import { runLicenseCommand } from "./license";
import { runUsageCommand } from "./usage";

const DEFAULT_BUS = process.env.MESH_BUS_URL ?? "http://127.0.0.1:7420";

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Flags that never take a value.
 *
 * Without this, `mesh run --git mesh.yaml` binds "mesh.yaml" as the *value* of
 * `--git` and leaves `positional` empty, so an ordinary invocation reports a
 * usage error naming the command the operator just typed. Listed rather than
 * derived: the alternative is a denylist of value-taking flags, which fails
 * open the moment someone adds one.
 */
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "git",
  "no-git",
  "fresh",
  "resume",
  "live",
  "parked",
  "ui-only",
  "tui",
  "no-tui",
  "no-demo",
  "help",
  "read-only",
  "staging",
  "json",
  "csv",
  "all",
  "settled",
  "keep-sessions",
]);

/** Literals a flag author would use to spell a boolean explicitly. */
const BOOLEAN_LITERALS: ReadonlySet<string> = new Set(["true", "false", "1", "0", "on", "off", "yes", "no"]);

/**
 * Whether `--<name>` should consume `next` as its value.
 *
 * A flag in BOOLEAN_FLAGS normally takes none, so `--git mesh.yaml` leaves the
 * path positional. An explicit boolean literal is still consumed, so
 * `--git false` means what it says instead of leaving "false" behind as a
 * stray positional bound for the config path.
 */
function takesValue(name: string, next: string): boolean {
  if (next.startsWith("--")) return false;
  if (!BOOLEAN_FLAGS.has(name)) return true;
  return BOOLEAN_LITERALS.has(next.trim().toLowerCase());
}

/**
 * Flags accepted by the launch commands, which is the set this file parses
 * itself a few lines below (`resolveLaunchMode`, `gitModeFromFlags`, the
 * `launchMesh` call). Kept beside them so the two cannot drift.
 */
const LAUNCH_FLAGS: ReadonlySet<string> = new Set([
  "port", "bind", "tui", "no-tui", "git", "no-git", "fresh", "resume", "live", "parked", "ui-only", "no-demo", "help",
]);

/**
 * Unknown flags, for the commands whose flag set is written down here.
 *
 * `parseArgs` collects every `--x` into a bag and each command reads the keys it
 * knows, so anything else is silently dropped: `mesh status --json` printed the
 * human format and said nothing, and `mesh init --dir /tmp/x` scaffolded into the
 * cwd because the directory is positional. The flag looked accepted in both.
 *
 * Deliberately narrow. Only the launch commands are checked, because their flag
 * list is parsed in this file and can be kept exact; the bus commands take a
 * wider, more scattered set, and a table guessed for them would warn on valid
 * invocations — which trains operators to read past warnings, a worse failure
 * than the one being fixed. A warning, never an error: refusing an argument that
 * has always been tolerated would break scripts.
 */
export function unknownFlagWarnings(command: string, flags: Record<string, string | boolean>): string[] {
  const LAUNCH_COMMANDS = new Set(["run", "serve", "up", "console", "ui"]);
  if (!LAUNCH_COMMANDS.has(command)) return [];
  const unknown = Object.keys(flags).filter((f) => !LAUNCH_FLAGS.has(f));
  if (unknown.length === 0) return [];
  const one = unknown.length === 1;
  return [
    `${unknown.map((f) => `--${f}`).join(", ")} ${one ? "is not a flag" : "are not flags"} \`mesh ${command}\` reads, and ${one ? "it was" : "they were"} ignored rather than refused. Accepted here: ${[...LAUNCH_FLAGS].filter((f) => f !== "help").map((f) => `--${f}`).join(", ")}`,
  ];
}

export function parseArgs(argv: string[]): Args {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq >= 0) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
      } else if (i + 1 < rest.length && takesValue(token.slice(2), rest[i + 1])) {
        flags[token.slice(2)] = rest[++i];
      } else {
        flags[token.slice(2)] = true;
      }
    } else {
      positional.push(token);
    }
  }
  return { command, positional, flags };
}

/**
 * A request to a mesh bus.
 *
 * Two things here used to be missing, and together they made an authenticated
 * mesh read as a dead one. No `Authorization` header was ever sent, so a direct
 * `--bus` call to a child — which always demands a token — came back 401; and
 * the status was returned but never checked, so that error body was rendered as
 * data. `mesh status --bus <child>` printed `Goal: (none)` and `events:
 * undefined` for a mission that was running fine, and `mesh agents --bus` died
 * with `body is not iterable`.
 *
 * Auth failures THROW rather than return: no call site can do anything useful
 * with a 401, and `tryServer` already turns a throw into the offline fallback.
 * Every other status is still returned as data, because the POST commands check
 * `status === 202`/`200` themselves and turn it into an exit code.
 *
 * Without `--bus` this all worked only because port 7420 is the HOST, which
 * proxies to the child and injects the child's own credential. Nothing was
 * discovering anything.
 */
async function httpJson(method: string, url: string, body?: unknown, flags: Flags = {}): Promise<any> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...authHeaders(flags) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  if (res.status === 401 || res.status === 403) {
    const detail = typeof parsed === "object" && parsed !== null && typeof parsed.error === "string" ? parsed.error : text.slice(0, 200);
    throw new Error(
      `${url} refused the request (${res.status}): ${detail} — pass --token <t> or set MESH_API_TOKEN, ` +
        `or address the project through its host with --project <id>`,
    );
  }
  return { status: res.status, body: parsed };
}

function stateDirFor(configPath: string): string {
  try {
    return resolveConfig(configPath).stateDir;
  } catch {
    return path.join(path.dirname(path.resolve(configPath)), "workspace", ".mesh-state");
  }
}

async function tryServer<T>(fn: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    // A refused connection is the ordinary case this fallback exists for (no
    // server running, read the log from disk), so it stays silent. A REFUSED
    // REQUEST is different: the mesh is up and answering, and the operator is
    // about to be shown offline figures for a live mission without being told
    // why. Say it once on stderr and still fall back, because the local log is
    // real data.
    const msg = err instanceof Error ? err.message : String(err);
    if (/refused the request \((401|403)\)/.test(msg)) console.error(`warning: ${msg}\n         falling back to the local event log`);
    return fallback();
  }
}

function inspectAgo(iso: unknown): string {
  const s = (Date.now() - Date.parse(String(iso ?? ""))) / 1000;
  if (!Number.isFinite(s)) return "—";
  if (s < 60) return `${Math.max(0, Math.round(s))}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function inspectNum(n: unknown): string {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return String(n ?? 0);
  return v.toLocaleString("en-US");
}

function inspectSnippet(payload: unknown, max = 90): string {
  if (payload === null || payload === undefined) return "";
  if (typeof payload === "string") return payload.slice(0, max);
  if (typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    for (const k of ["question", "summary", "note", "reason", "text", "response"]) {
      if (typeof p[k] === "string" && (p[k] as string).length > 0) return (p[k] as string).slice(0, max);
    }
    try {
      return JSON.stringify(payload).slice(0, max);
    } catch {
      return "";
    }
  }
  return String(payload).slice(0, max);
}

function inspectBar(pct: number | null | undefined, width = 20): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return "";
  const filled = Math.round(Math.min(1, Math.max(0, pct)) * width);
  return "█".repeat(filled).padEnd(width, "░");
}

function printAgentDetail(body: any, limit: number): void {
  const d = body?.definition ?? {};
  const s = body?.state ?? {};
  const id = String(d.id ?? s.agentId ?? "?");
  const role = String(d.role ?? "—");
  const lifecycle = String(s.lifecycle ?? "—");
  console.log(`${id} (${role}) — ${lifecycle} · active ${inspectAgo(s.lastActivityAt)} · ${s.activations ?? 0} runs · ${inspectNum(s.tokensConsumed)} tokens`);
  if (s.lastError) console.log(`crashed: ${String(s.lastError).slice(0, 200)}`);
  if (body.currentTurnId) console.log(`current step: ${body.currentTurnId}`);
  const ab = body?.budgets?.agent;
  if (ab) {
    const pct = typeof ab.pct === "number" ? ` (${Math.round(ab.pct * 100)}%) ${inspectBar(ab.pct)}` : "";
    console.log(`budget: ${inspectNum(ab.consumed)} / ${ab.limit ?? "?"}${ab.exceeded ? " EXCEEDED" : ""}${pct}`);
  } else if (body?.budgets?.agentConfiguredTokens) {
    console.log(`budget: ${inspectNum(s.tokensConsumed)} / ${inspectNum(body.budgets.agentConfiguredTokens)} (configured)`);
  }
  const mb = body?.budgets?.mission;
  if (mb) console.log(`mission: ${inspectNum(mb.consumed)} / ${mb.limit ?? "?"}${mb.exceeded ? " EXCEEDED" : ""}`);
  const comm = body?.communication;
  if (comm && (comm.mayContact?.length || comm.mayBeContactedBy?.length)) {
    console.log(`contacts: → ${(comm.mayContact ?? []).join(", ") || "(nobody new)"} · ← ${(comm.mayBeContactedBy ?? []).join(", ") || "(restricted)"}`);
  }
  if (body?.activeTask) {
    const t = body.activeTask;
    console.log(`\nactive task: ${t.id} — ${String(t.title ?? "").slice(0, 80)} [${t.status}]`);
  }
  const unread = Array.isArray(body?.unreadMessages) ? body.unreadMessages : [];
  console.log(`\ninbox (${unread.length} unread):`);
  if (!unread.length) console.log("  (empty)");
  for (const m of unread.slice(0, limit)) {
    const refs = (m.artifactRefs ?? []).map((r: any) => r.uri).join(", ");
    console.log(`  [${String(m.timestamp ?? "").slice(11, 19)}] ${m.from} → ${(m.to ?? []).join(",")} ${m.type} (thread ${m.threadId})`);
    const snip = inspectSnippet(m.payload);
    if (snip) console.log(`    ${snip}`);
    if (refs) console.log(`    files: ${refs}`);
  }
  const steps = Array.isArray(body?.recentSteps) ? body.recentSteps : [];
  console.log(`\nrecent steps (${steps.length}):`);
  if (!steps.length) console.log("  (no steps yet)");
  for (const st of steps.slice(0, limit)) {
    const ops = st.ops ? `${st.ops.messages} msg · ${st.ops.artifacts} files · ${st.ops.tasks} tasks` : "";
    const dur = st.durationMs != null ? ` · ${(st.durationMs / 1000).toFixed(1)}s` : "";
    console.log(`  ${String(st.turnId).slice(0, 13)} ${st.status} · ${st.reasonKind}${st.reasonNote ? ` (${String(st.reasonNote).slice(0, 50)})` : ""} · ${inspectNum(st.tokens)} tokens${dur} · ${ops}${st.error ? ` · err: ${String(st.error).slice(0, 80)}` : ""}`);
  }
  const recent = Array.isArray(body?.recentMessages) ? body.recentMessages : [];
  console.log(`\nrecent messages (${recent.length}):`);
  if (!recent.length) console.log("  (none)");
  for (const m of recent.slice(0, limit)) {
    console.log(`  [${String(m.timestamp ?? "").slice(11, 19)}] ${m.from} → ${(m.to ?? []).join(",")} ${m.type}: ${inspectSnippet(m.payload, 70)}`);
  }
  const tasks = Array.isArray(body?.tasksInvolved) ? body.tasksInvolved : [];
  if (tasks.length) {
    console.log(`\ntasks (${tasks.length}):`);
    for (const t of tasks.slice(0, limit)) console.log(`  ${t.id} [${t.status}] ${String(t.title ?? "").slice(0, 70)}`);
  }
  const arts = Array.isArray(body?.artifacts) ? body.artifacts : [];
  if (arts.length) {
    console.log(`\nartifacts (${arts.length}):`);
    for (const a of arts.slice(0, limit)) console.log(`  ${a.name} v${a.version} [${a.status}] ${a.type} by ${a.createdBy}`);
  }
  const threads = Array.isArray(body?.threads) ? body.threads : [];
  if (threads.length) {
    console.log(`\nthreads (${threads.length}):`);
    for (const t of threads.slice(0, limit)) console.log(`  ${t.id} “${String(t.subject ?? "").slice(0, 60)}” [${t.status}] ${t.messageCount} msgs · ${(t.participants ?? []).join(",")}`);
  }
  const mem = Array.isArray(body?.memory) ? body.memory : [];
  console.log(`\nmemory (${mem.length}):`);
  if (!mem.length) console.log("  (no notes)");
  for (const n of mem.slice(0, limit)) console.log(`  - ${n.key}: ${String(n.value ?? "").slice(0, 100)}`);
  const evs = Array.isArray(body?.recentEvents) ? body.recentEvents : [];
  if (evs.length) {
    console.log(`\nrecent events (${evs.length}):`);
    for (const e of evs.slice(0, limit)) console.log(`  #${e.seq} ${e.type} ${e.actor ?? ""} ${String(e.summary ?? "").slice(0, 80)}`);
  }
  const appr = Array.isArray(body?.approvals) ? body.approvals : [];
  if (appr.length) {
    console.log(`\napprovals (${appr.length}):`);
    for (const a of appr.slice(0, 5)) console.log(`  ${a.kind} ${a.subject}${a.artifactId ? ` ${String(a.artifactId).slice(0, 12)}` : ""} at ${String(a.recordedAt ?? "").slice(11, 19)}`);
  }
  const esc = Array.isArray(body?.escalations) ? body.escalations : [];
  if (esc.length) {
    console.log(`\nescalations (${esc.length}):`);
    for (const e of esc.slice(0, 5)) console.log(`  ${e.id} [${e.reason}] ${e.status}`);
  }
  const leases = Array.isArray(body?.leases) ? body.leases : [];
  if (leases.length) {
    console.log(`\nleases (${leases.length}):`);
    for (const l of leases.slice(0, 5)) console.log(`  ${l.artifactId} → ${l.worktreePath}${l.active ? "" : " (released)"}`);
  }
  const sess = body?.session;
  if (sess) console.log(`\nsession: ${sess.sessionId} (${sess.runtime})`);
  console.log(`\n--json for full payload`);
}

const HELP = `agent-mesh — runtime for persistent AI organizations

usage:
  mesh init [dir]                          scaffold mesh.yaml + roles
  mesh validate <mesh.yaml>                schema + cross-field validation
  mesh emit-schemas [dir]                  write canonical JSON schemas
  mesh run <mesh.yaml> [--port n] [--bind addr] [--no-tui] [--git|--no-git] [--fresh]   live: scheduler on, startup agents fire, TUI when TTY
  mesh serve <mesh.yaml> [--port n] [--bind addr] [--git|--no-git]   live + dashboard (alias: up; same as run --no-tui)
  mesh console <mesh.yaml> [--port n] [--bind addr] [--git|--no-git] parked stepper console (alias: ui)
    --bind       address to listen on (default mesh.server.host, 127.0.0.1). Anything that is not
                 loopback is reachable from the network and needs MESH_API_TOKEN of 32+ characters
                 (openssl rand -hex 32); the server refuses to start without one.
  mesh --version                           print the version
    git: writing agents commit through worktrees. Default comes from
    mesh.workspace.git, which is ON when the key is absent. With git off
    every mesh_commit is refused, so criteria needing landed code never
    satisfy.
    parked: dashboard+designer, nothing runs on its own.
    send with "wake after send" (or wake buttons) steps single turns;
    ▶ start mission (POST /mission/start) flips parked -> live.
    flags: --live forces live, --parked / --ui-only forces parked.
  mesh status [--bus url]                  mission/agent/budget overview
  mesh graph [--bus url]                   live collaboration graph
  mesh events [--type t] [--limit n]       event timeline
  mesh agents [--bus url]                  agent table
  mesh inspect <agentId> [--json] [--limit n]  full agent detail: inbox, steps, tasks, artifacts, budgets
  mesh replay <goalId> [--upToSeq n]       deterministic state replay
  mesh pause | resume [goalId]             goal control
  mesh wake <agentId>                      manual activation
  mesh send --to a,b --type INFORM --payload '{}'
  mesh approve --subject s [--artifact id] [--by agentId]
  mesh reject --subject s [--artifact id] [--comment text]
  mesh respond <escalationId> <text>       human escalation response
  mesh artifacts [--bus url] [--settled] [--status S]  artifact ledger, grouped: delivered / in progress / rejected
  mesh budgets [--bus url]                 budget keys with consumed/limit and an EXCEEDED mark
  mesh ledger [mesh.yaml] [--top n] [--json]  per-turn token ledger from the audit file: fresh vs cached vs written
    vs written, which turns hold the uncached bill, and fresh input by gap since a seat last finished.
    Offline: reads logs/turn-audit.jsonl, needs no running mesh. Ratios are published Anthropic
    units (cache read 0.1x, write 1.25x, output 5x) — a comparable unit, not a price.
  mesh host [--port n] [--home dir] [--memory mb] [--live] [--git|--no-git]
    multi-project host: supervises one child per open project, serves the dashboard (default port ${DEFAULT_HOST_PORT})
    git flags force every child on/off; without them each child obeys its own mesh.workspace.git
  mesh project list | add <dir> | remove <id> | open <id> | close <id> | restart <id>
    project registry; add/remove/list work without a host, open/close/restart need one (--host url)
  mesh license [status|install|verify|remove]   this install's plan, limits and licence (see: mesh license --help)
  mesh usage <mesh.yaml>... | --all             what meshes consumed, by day/seat/model, from their logs (see: mesh usage --help)
  mesh backups <mesh.yaml>                 archives this mesh has written, newest first (--json)
  mesh restore <mesh.yaml> <stamp>         put an archived mission back; the mesh must be stopped (--keep-sessions)
    a reset writes one set of archives under one stamp: the state dir (the only
    restorable one), the product checkout, and the agent worktrees. The archive
    is copied, never consumed, so the same stamp keeps working.
  any --bus command also takes --project <id> to address one project through a host
    and --token <t> (or MESH_API_TOKEN) to authenticate. A child mesh started by a
    host always requires one: its token is internal, so --project through the host
    is usually the route you want. Without a token the child answers 401 and the
    command says so rather than printing an empty mission.
  mcp --agent id --bus url --token t       (internal) stdio MCP bridge
  designer-mcp                             (internal) stdio MCP server for the config designer
  bench [--mesh config.yaml] [--single config.yaml] [--out report.json]
`;

export type LaunchMode = "live" | "parked";

/**
 * Single place that maps (command + flags) -> server mode.
 * Commands carry the default; explicit flags win and warn on conflict.
 * `--ui-only` is kept as a deprecated alias of `--parked`.
 */
export function resolveLaunchMode(command: string, flags: Record<string, string | boolean>): { mode: LaunchMode; warnings: string[] } {
  const defaultMode: LaunchMode = command === "ui" || command === "console" ? "parked" : "live";
  const wantsParked = Boolean(flags["parked"] ?? flags["ui-only"]);
  const wantsLive = Boolean(flags["live"]);
  const warnings: string[] = [];
  if (flags["ui-only"]) warnings.push("flag --ui-only is deprecated, use --parked (or `mesh console`)");
  if (wantsParked && wantsLive) {
    warnings.push("--parked and --live conflict; --live wins");
    return { mode: "live", warnings };
  }
  if (wantsParked) {
    if (defaultMode === "live") warnings.push(`${command} defaults to live; --parked forces the stepper console`);
    return { mode: "parked", warnings };
  }
  if (wantsLive) {
    if (defaultMode === "parked") warnings.push(`${command} defaults to parked; --live forces autonomous run`);
    return { mode: "live", warnings };
  }
  return { mode: defaultMode, warnings };
}

async function launchMesh(opts: {
  configPath: string;
  mode: LaunchMode;
  port?: number;
  /** `--bind`; absent means `mesh.server.host`. */
  host?: string;
  fresh?: boolean;
  allowResume?: boolean;
  /** Operator intent; "auto" (or absent) defers to `mesh.workspace.git`. */
  gitMode?: GitMode;
  withTui?: boolean;
  noDemo?: boolean;
}): Promise<number> {
  const file = opts.configPath;
  const preflight = resolveConfig(file);
  // The same warnings `mesh validate` prints. Booting is when they matter most
  // — an uncovered commit gate deadlocks the mission with no runtime error —
  // and run/serve/up/console/ui used to compute these and drop them, so the
  // only way to see one was to remember to validate first.
  for (const w of preflight.warnings) console.warn(`warn: ${w}`);
  const useDemo = !opts.noDemo && preflight.meshId === "demo-stub";
  // A scripted demo always starts clean (its team is re-attached each
  // boot); a real mesh resumes from its event log unless --fresh.
  const fresh = Boolean(opts.fresh) || useDemo;
  if (fresh && !opts.allowResume) {
    fs.rmSync(preflight.stateDir, { recursive: true, force: true });
  }
  const handle = await startServer({
    configPath: file,
    port: opts.port,
    host: opts.host,
    gitMode: opts.gitMode,
    mode: opts.mode,
    // backward compat for any external startServer caller reading uiOnly
    uiOnly: opts.mode === "parked",
  });
  if (useDemo && !opts.allowResume) {
    try {
      const { attachDemoTeam } = await import("./bench");
      attachDemoTeam(handle.instance);
      console.log(
        opts.mode === "parked"
          ? "demo team installed (parked): wake single agents for manual steps, or press ▶ start mission to run the whole flow."
          : "demo team attached: scripted roles will now run the payment flow (QA blocks once — watch conflict handling).",
      );
    } catch (err) {
      console.error(`demo attach failed: ${(err as Error).message}`);
    }
  }
  const parked = opts.mode === "parked";
  console.log(
    parked
      ? `mesh panel (parked) online at ${handle.url}  — dashboard /designer available; agents are NOT activated`
      : `mesh '${handle.instance.config.meshId || path.basename(file, path.extname(file))}' supervisor online at ${handle.url} (live)`,
  );
  if (opts.withTui) {
    await runTui(handle.url, async () => handle.close());
  } else {
    console.log(parked ? `  dashboard: ${handle.url}/    designer: ${handle.url}/#/designer    (Ctrl-C to stop)` : "running headless; Ctrl-C to stop");
    await new Promise<void>((resolve) => {
      const stop = () => {
        resolve();
      };
      // The report prints exactly once, whoever ends the run. An interrupted
      // run is still a run: it published artifacts, satisfied criteria and
      // left work open, and printing nothing on Ctrl-C threw all of that away.
      let reported = false;
      const report = (fallback: string) => {
        if (reported) return;
        reported = true;
        try {
          console.log(renderRunReport(buildRunReport(handle.instance.kernel.state)));
        } catch (err) {
          // A report that throws must not swallow the run's outcome.
          console.log(fallback);
          console.error(`  (run report unavailable: ${(err as Error).message})`);
        }
      };
      const interrupt = () => {
        report("\ninterrupted — shutting down");
        stop();
      };
      process.once("SIGINT", interrupt);
      process.once("SIGTERM", interrupt);
      if (!parked) {
        // Live goals terminate; parked consoles never auto-complete (scheduler
        // is stopped), so only SIGINT/SIGTERM ends them.
        const goalWatch = setInterval(async () => {
          try {
            // No flags here: this polls the server THIS process just started,
            // whose auth (if any) it configured itself.
            const { body } = await httpJson("GET", `${handle.url}/status`);
            if (body?.goal && ["COMPLETED", "FAILED", "ESCALATED"].includes(body.goal.status)) {
              clearInterval(goalWatch);
              // The run is over: say what it produced. Projections are read
              // in-process from the kernel rather than over HTTP, so the
              // report is composed from the same state the supervisor just
              // finished writing — no extra round trip, no chance of racing
              // the server into shutdown.
              report(`\ngoal ${body.goal.status.toLowerCase()} — shutting down`);
              stop();
            }
          } catch {
            /* server may be closing */
          }
        }, 2000);
      }
    });
    await handle.close();
  }
  return 0;
}

/** The version in the package.json this build ships beside (the repo root, or `/app` in the image). */
export function packageVersion(): string {
  return serverVersion();
}

export async function main(argv: string[]): Promise<number> {
  if (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "version") {
    console.log(`agent-mesh ${packageVersion()}`);
    return 0;
  }
  const args = parseArgs(argv);
  for (const w of unknownFlagWarnings(args.command, args.flags)) console.warn(`warn: ${w}`);
  // `--project id` rewrites the bus to the host's proxy prefix, so every
  // existing command works against one project of a multi-project host
  // without each case knowing that hosts exist.
  const bus = resolveBus(args.flags, DEFAULT_BUS);
  try {
    switch (args.command) {
      case "host": {
        // Awaited so a refusal to start (a port in use, a network bind with no token) reaches the
        // catch below as one line and an exit code, instead of escaping as an unhandled rejection.
        return await runHostCommand(args.flags);
      }
      case "license": {
        return await runLicenseCommand(args.positional, args.flags);
      }
      case "usage": {
        // Offline, like backups: it reads event logs, so it works on a mesh that is stopped.
        return await runUsageCommand(args.positional, args.flags);
      }
      case "project":
      case "projects": {
        return await runProjectCommand(args.positional, args.flags);
      }
      case "backups":
      case "restore": {
        // Offline: both take a mesh.yaml directly and never talk to a host, so
        // they work on a mesh that is stopped — which is the only state a
        // restore is safe in, and the state an operator is in when they want
        // one.
        if (args.flags.help) {
          console.log(args.command === "backups" ? BACKUPS_HELP : RESTORE_HELP);
          return 0;
        }
        return await (args.command === "backups"
          ? runBackupsCommand(args.positional, args.flags)
          : runRestoreCommand(args.positional, args.flags));
      }
      case "init": {
        const dir = path.resolve(args.positional[0] ?? ".");
        // Always claude: it needs no separate install, riding on the declared
        // @anthropic-ai/claude-agent-sdk dependency. Set runtime: stub by hand
        // for a mesh that boots and runs with zero model calls.
        const file = writeDefaultMeshYaml(dir, path.basename(dir), "claude");
        console.log(`wrote ${file}`);
        return 0;
      }
      case "emit-schemas": {
        const dir = path.resolve(args.positional[0] ?? "schemas");
        fs.mkdirSync(dir, { recursive: true });
        const names: Record<string, string> = { mesh: "mesh.schema.json", message: "message.schema.json", event: "event.schema.json", artifact: "artifact.schema.json" };
        for (const [key, file] of Object.entries(names)) {
          fs.writeFileSync(path.join(dir, file), JSON.stringify(SCHEMAS[key as keyof typeof SCHEMAS], null, 2) + "\n", "utf8");
        }
        console.log(`schemas written to ${dir}`);
        return 0;
      }
      case "validate": {
        const file = args.positional[0];
        if (!file) throw new Error("usage: mesh validate <mesh.yaml>");
        const raw = loadMeshFile(file);
        const resolved = resolveConfig(file);
        void raw;
        console.log(`OK: ${resolved.agentOrder.length} agents, mesh '${resolved.meshId}', runtime default '${resolved.defaultRuntime}'`);
        console.log(`   commitments: ${resolved.bus.commitmentSemantic}`);
        console.log(`   interests wired for: ${resolved.agentOrder.filter((a) => resolved.agents[a].interests.length > 0).join(", ")}`);
        console.log(`   transition gates: ${Object.keys(resolved.transitionGates).join(", ") || "(none)"}`);
        // Non-fatal but mission-ending if ignored: an unsatisfiable gate
        // deadlocks every artifact that needs it, with no runtime error.
        for (const w of resolved.warnings) console.log(`   warning: ${w}`);
        return 0;
      }
      case "run":
      case "serve":
      case "up":
      case "console":
      case "ui": {
        const file = args.positional[0];
        if (!file) throw new Error(`usage: mesh ${args.command} <mesh.yaml>`);
        const { mode, warnings } = resolveLaunchMode(args.command, args.flags);
        for (const w of warnings) console.warn(`warn: ${w}`);
        const { mode: gitMode, warnings: gitWarnings } = gitModeFromFlags(args.flags);
        for (const w of gitWarnings) console.warn(`warn: ${w}`);
        const noTui = Boolean(args.flags["no-tui"]);
        const wantTui = Boolean(args.flags["tui"]);
        // run: TUI when TTY unless disabled. serve/up/ui/console: dashboard-first.
        const withTui =
          args.command === "run"
            ? process.stdout.isTTY && !noTui
            : wantTui && process.stdout.isTTY && !noTui;
        if (wantTui && args.command !== "run" && !withTui) {
          console.warn("warn: --tui needs a TTY; falling back to headless dashboard mode");
        }
        const bind = typeof args.flags.bind === "string" && args.flags.bind.trim() ? args.flags.bind.trim() : undefined;
        // Awaited, like every command here that returns a promise: a bare `return` hands the promise
        // to the caller and a rejection (a config error, a refusal to listen) skips the catch below,
        // which is the one place that turns it into a message and an exit code.
        return await launchMesh({
          configPath: file,
          mode,
          port: args.flags.port ? Number(args.flags.port) : undefined,
          host: bind,
          fresh: Boolean(args.flags.fresh),
          allowResume: Boolean(args.flags.resume),
          gitMode,
          withTui,
          noDemo: Boolean(args.flags["no-demo"]),
        });
      }
      case "mcp": {
        const { runStdioMcpBridge } = await import("./mcp-stdio");
        await runStdioMcpBridge({
          agent: String(args.flags.agent ?? ""),
          bus: String(args.flags.bus ?? DEFAULT_BUS),
          token: String(args.flags.token ?? ""),
          readOnly: Boolean(args.flags["read-only"]),
          staging: Boolean(args.flags.staging),
          turn: args.flags.turn ? String(args.flags.turn) : undefined,
        });
        return 0;
      }
      case "designer-mcp": {
        const { runStdioDesignerMcp } = await import("./designer-mcp");
        await runStdioDesignerMcp();
        return 0;
      }
      case "status": {
        const result = await tryServer(
          () => httpJson("GET", `${bus}/status`, undefined, args.flags),
          async () => ({ status: 200, body: await offlineStatus(args) }),
        );
        const st = result.body;
        const bar = (ratio: number) => "â–ˆ".repeat(Math.round(ratio * 20)).padEnd(20, "â–‘");
        console.log(`Goal:      ${st.goal?.description?.split("\n")[0]?.slice(0, 60) ?? "(none)"} [${st.goal?.status ?? "-"}]`);
        console.log(`Progress:  ${bar(st.progress?.ratio ?? 0)} ${Math.round((st.progress?.ratio ?? 0) * 100)}%`);
        const tokens = st.budgets?.find?.((b: any) => b.key.startsWith("mission:"));
        console.log(`Tokens:    ${tokens ? `${tokens.consumed} / ${tokens.limit ?? "?"}` : "-"}   events: ${st.eventCount}`);
        console.log("");
        for (const a of st.agents ?? []) {
          const dot = ["THINKING", "WORKING", "REQUESTING", "AWAKENED", "OBSERVING", "REVIEWING"].includes(a.lifecycle) ? "â—" : "â—‹";
          console.log(`  ${dot} ${a.id.padEnd(14)} ${a.lifecycle.padEnd(11)} mailbox:${String(a.mailbox).padStart(2)}  tokens:${a.tokens}`);
        }
        if (st.openEscalations?.length) {
          console.log("\nOpen escalations:");
          for (const e of st.openEscalations) console.log(`  ! ${e.id} [${e.reason}] by ${e.raisedBy} at ${e.createdAt}`);
        }
        return 0;
      }
      case "graph": {
        const { body } = await httpJson("GET", `${bus}/graph`, undefined, args.flags);
        if (!Array.isArray(body?.nodes) || !Array.isArray(body?.edges)) {
          console.error(`mesh graph: unexpected response from ${bus}/graph: ${JSON.stringify(body).slice(0, 200)}`);
          return 1;
        }
        for (const n of body.nodes) console.log(`  ${n.lifecycle.padEnd(11)} ${n.id.padEnd(14)} (${n.role})  ${n.tokens}t`);
        console.log("");
        for (const e of body.edges) console.log(`  ${e.from.padEnd(12)} --${e.kind}--> ${e.to.padEnd(12)} x${e.count}`);
        return 0;
      }
      case "agents": {
        const { body } = await httpJson("GET", `${bus}/agents`, undefined, args.flags);
        if (!Array.isArray(body)) {
          console.error(`mesh agents: unexpected response from ${bus}/agents: ${JSON.stringify(body).slice(0, 200)}`);
          return 1;
        }
        for (const a of body) console.log(`  ${a.id.padEnd(14)} ${a.role.padEnd(16)} ${a.lifecycle.padEnd(11)} ${a.taskId ? `task:${a.taskId}` : ""}`);
        return 0;
      }
      case "inspect": {
        const id = args.positional[0];
        if (!id) throw new Error("usage: mesh inspect <agentId> [--json] [--limit n]");
        const limit = args.flags.limit ? Number(args.flags.limit) : 10;
        const { body } = await httpJson("GET", `${bus}/agents/${encodeURIComponent(id)}?limit=${limit}`, undefined, args.flags);
        if (body.error) {
          console.error(body.error);
          return 1;
        }
        if (args.flags.json) {
          console.log(JSON.stringify(body, null, 2));
          return 0;
        }
        printAgentDetail(body, limit);
        return 0;
      }
      case "events": {
        const limit = args.flags.limit ? Number(args.flags.limit) : 40;
        const type = args.flags.type ? String(args.flags.type) : undefined;
        const result = await tryServer(
          () => httpJson("GET", `${bus}/events?limit=${limit * 4}${type ? `&type=${type}` : ""}`, undefined, args.flags),
          async () => ({ status: 200, body: await offlineEvents(args, limit, type) }),
        );
        if (!Array.isArray(result.body)) {
          console.error(`mesh events: unexpected response: ${JSON.stringify(result.body).slice(0, 200)}`);
          return 1;
        }
        const rows = (result.body as any[]).slice(-limit);
        for (const r of rows) {
          console.log(`  ${r.at.replace("T", " ").slice(0, 19)} #${String(r.seq).padStart(5)} ${r.type.padEnd(24)} ${r.actor ?? ""} ${r.summary ?? ""}`);
        }
        return 0;
      }
      case "replay": {
        const goalId = args.positional[0];
        if (!goalId) throw new Error("usage: mesh replay <goalId>");
        const upTo = args.flags.upToSeq ? `&upToSeq=${args.flags.upToSeq}` : "";
        const { body } = await httpJson("GET", `${bus}/goals/${encodeURIComponent(goalId)}/replay${upTo}`, undefined, args.flags);
        if (body.error) {
          console.error(body.error);
          return 1;
        }
        console.log(`replay of ${goalId} through seq ${body.asOfSeq} (${body.eventCount} events, no LLM invoked)`);
        console.log(`goal: ${body.goal?.status ?? "-"}  agents: ${body.agents.length}  artifacts: ${body.artifacts.length}  tasks: ${body.tasks.length}  events: ${body.eventCount}`);
        console.log(`budgets:`);
        for (const b of body.budgets) console.log(`  ${b.key.padEnd(34)} ${b.consumed}/${b.limit ?? "?"} reserved:${b.reserved}${b.exceeded ? "  EXCEEDED" : ""}`);
        return 0;
      }
      case "pause": {
        const goalId = args.positional[0];
        const { body } = await httpJson("POST", `${bus}/goals/${encodeURIComponent(goalId ?? "")}/pause`, undefined, args.flags);
        console.log(JSON.stringify(body));
        return 0;
      }
      case "resume": {
        const goalId = args.positional[0];
        const { body } = await httpJson("POST", `${bus}/goals/${encodeURIComponent(goalId ?? "")}/resume`, undefined, args.flags);
        console.log(JSON.stringify(body));
        return 0;
      }
      case "wake": {
        const id = args.positional[0];
        const { body } = await httpJson("POST", `${bus}/agents/${encodeURIComponent(id)}/wake`, undefined, args.flags);
        console.log(JSON.stringify(body));
        return 0;
      }
      case "send": {
        const to = String(args.flags.to ?? "").split(",").filter(Boolean);
        const type = String(args.flags.type ?? "INFORM");
        const payload = args.flags.payload ? JSON.parse(String(args.flags.payload)) : {};
        const { status, body } = await httpJson("POST", `${bus}/messages`, { to, type, payload, threadId: args.flags.thread }, args.flags);
        console.log(JSON.stringify(body, null, 2));
        return status === 202 ? 0 : 1;
      }
      case "approve":
      case "accept": {
        const { status, body } = await httpJson("POST", `${bus}/approvals`, {
          kind: args.command === "accept" ? "accept" : "approve",
          subject: args.flags.subject ?? "release",
          artifactId: args.flags.artifact,
          by: args.flags.by,
          comment: args.flags.comment,
        }, args.flags);
        console.log(JSON.stringify(body, null, 2));
        return status === 200 ? 0 : 1;
      }
      case "reject": {
        const { status, body } = await httpJson("POST", `${bus}/approvals`, {
          kind: "reject",
          subject: args.flags.subject ?? "release",
          artifactId: args.flags.artifact,
          by: args.flags.by,
          comment: args.flags.comment,
        }, args.flags);
        console.log(JSON.stringify(body, null, 2));
        return status === 200 ? 0 : 1;
      }
      case "respond": {
        const id = args.positional[0];
        const text = args.positional.slice(1).join(" ") || String(args.flags.text ?? "acknowledged");
        const { status, body } = await httpJson("POST", `${bus}/escalations/${encodeURIComponent(id)}/respond`, { response: text }, args.flags);
        console.log(JSON.stringify(body, null, 2));
        return status === 200 ? 0 : 1;
      }
      case "escalations": {
        const { body } = await httpJson("GET", `${bus}/escalations`, undefined, args.flags);
        if (!Array.isArray(body)) {
          console.error(`mesh escalations: unexpected response from ${bus}/escalations: ${JSON.stringify(body).slice(0, 200)}`);
          return 1;
        }
        for (const e of body) console.log(`  ${e.status.padEnd(10)} ${e.id}  [${e.reason}] by ${e.raisedBy}`);
        return 0;
      }
      case "artifacts": {
        const { body } = await httpJson("GET", `${bus}/artifacts`, undefined, args.flags);
        // Status is the whole point: a REJECTED draft and a FINAL deliverable
        // printed in one flat list look identical, which is how a failed run
        // gets read as a shipping manifest. Group by settlement, deliverables
        // first, and let `--status` / `--settled` narrow it further.
        const want = args.flags.status ? String(args.flags.status).toUpperCase() : null;
        if (!Array.isArray(body)) {
          console.error(`mesh artifacts: unexpected response from ${bus}/artifacts: ${JSON.stringify(body).slice(0, 200)}`);
          return 1;
        }
        const rows = (body as any[]).filter((a) => !want || a.status.toUpperCase() === want);
        const line = (a: any) => `  ${a.id}  ${a.type.padEnd(20)} ${a.name.padEnd(28)} v${a.version} ${a.status.padEnd(16)} owner:${a.owner}`;
        const settled = rows.filter((a) => isSettledArtifactStatus(a.status));
        const rejected = rows.filter((a) => a.status === "REJECTED");
        const drafts = rows.filter((a) => !isSettledArtifactStatus(a.status) && a.status !== "REJECTED");
        if (rows.length === 0) {
          console.log(want ? `  (no artifacts with status ${want})` : "  (no artifacts)");
          return 0;
        }
        if (args.flags.settled) {
          for (const a of settled) console.log(line(a));
          return 0;
        }
        const group = (label: string, items: any[]) => {
          if (items.length === 0) return;
          console.log(`\n  ${label} (${items.length})`);
          for (const a of items) console.log(line(a));
        };
        group("DELIVERED", settled);
        group("IN PROGRESS", drafts);
        group("REJECTED", rejected);
        console.log("");
        return 0;
      }
      case "budgets": {
        const { body } = await httpJson("GET", `${bus}/budgets`, undefined, args.flags);
        if (!Array.isArray(body?.entries)) {
          console.error(`mesh budgets: unexpected response from ${bus}/budgets: ${JSON.stringify(body).slice(0, 200)}`);
          return 1;
        }
        for (const b of body.entries) console.log(`  ${b.key.padEnd(36)} ${String(b.consumed).padStart(8)}/${String(b.limit ?? "?").padStart(8)}${b.exceeded ? "  EXCEEDED" : ""}`);
        return 0;
      }
      case "ledger": {
        return await offlineLedger(args);
      }
      case "bench": {
        return await runBenchmark(args.flags);
      }
      case "help":
      default: {
        if (args.command !== "help") console.error(`unknown command: ${args.command}\n`);
        console.log(HELP);
        return args.command === "help" ? 0 : 1;
      }
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(String(err.message));
      return 2;
    }
    if (err instanceof LicenseLimitError) {
      // Same code as a refusal to listen: it will not start as configured, and retrying will not change that.
      console.error(`mesh ${args.command}: ${err.message}`);
      return 78;
    }
    if (err instanceof UnsafeListenError) {
      // EX_CONFIG: a service manager can tell "will never start as configured" from a crash.
      console.error(`mesh ${args.command}: ${err.message}`);
      return 78;
    }
    console.error(`mesh ${args.command}: ${(err as Error).message}`);
    return 1;
  }
}

async function offlineStatus(args: Args): Promise<unknown> {
  const file = args.positional[0] ?? process.env.MESH_CONFIG ?? "mesh.yaml";
  const dir = stateDirFor(fs.existsSync(file) ? file : "mesh.yaml");
  const store = new JsonlEventStore(path.join(dir, "logs", "events.jsonl"));
  const events = await store.read().finally(() => store.close());
  const goal = [...events].reverse().find((e) => e.type === "goal.created");
  const agentStates = new Map<string, string>();
  const tokens = new Map<string, number>();
  for (const e of events) {
    if (e.type === "agent.state_changed") agentStates.set((e.payload as any).agentId, (e.payload as any).to);
    if (e.type === "agent.created") agentStates.set((e.payload as any).agent.id, "IDLE");
    if (e.type === "budget.consumed" && (e.payload as any).agentId) {
      tokens.set((e.payload as any).agentId, (tokens.get((e.payload as any).agentId) ?? 0) + ((e.payload as any).amount ?? 0));
    }
  }
  return {
    goal: goal ? (goal.payload as any).goal : undefined,
    agents: [...agentStates.entries()].map(([id, lifecycle]) => ({ id, role: id, lifecycle, mailbox: 0, tokens: tokens.get(id) ?? 0 })),
    eventCount: events.length,
    progress: null,
    openEscalations: [],
  };
}

async function offlineEvents(args: Args, limit: number, type?: string): Promise<unknown[]> {
  const file = args.positional[0] ?? process.env.MESH_CONFIG ?? "mesh.yaml";
  const dir = stateDirFor(fs.existsSync(file) ? file : "mesh.yaml");
  const store = new JsonlEventStore(path.join(dir, "logs", "events.jsonl"));
  const events = await store.read({ types: type ? ([type] as never) : undefined, tail: limit * 4 }).finally(() => store.close());
  const { eventTimeline } = await import("../../../packages/observability/src/index");
  return eventTimeline(events, limit);
}

/**
 * `mesh ledger` — what each settled turn cost, from the audit file, and since
 * the written column got a breakdown, what the most expensive line was spent on.
 *
 * Offline on purpose: `logs/turn-audit.jsonl` is append-only and independent of
 * the live store, so this reads a mission that has stopped, a mission on another
 * machine, or an archived state dir. It exists because the per-turn split was
 * reconstructed by hand once (review §1, §11) and nothing in the repo could do it
 * again — the numbers §11 acts on were only reachable by writing a script.
 *
 * `--json` prints the parsed rows, so the arithmetic downstream can be done on
 * the same figures this prints rather than re-parsed from the log.
 */
async function offlineLedger(args: Args): Promise<number> {
  const candidate = args.positional[0] ?? process.env.MESH_CONFIG ?? "mesh.yaml";
  // A path that does not resolve must not fall back to `./mesh.yaml`: the ledger
  // it would print is real, and about the wrong mission. Only the built-in
  // default is allowed to be absent (the audit check below reports that case).
  if (candidate !== "mesh.yaml" && !fs.existsSync(candidate)) {
    console.error(`mesh ledger: no config at ${candidate}`);
    return 1;
  }
  const dir = stateDirFor(candidate);
  const audit = path.join(dir, "logs", "turn-audit.jsonl");
  if (!fs.existsSync(audit)) {
    console.error(`mesh ledger: no audit file at ${audit}\nthe mesh writes one line per settled turn once it has run`);
    return 1;
  }
  const { parseTurnAudit, buildCacheLedger } = await import("../../../packages/observability/src/index");
  const { rows, damaged } = parseTurnAudit(fs.readFileSync(audit, "utf8"));
  if (args.flags.json) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  const wantTop = Number(args.flags.top ?? 10);
  const led = buildCacheLedger(rows, Number.isFinite(wantTop) && wantTop > 0 ? wantTop : 10);
  if (led.turns === 0) {
    console.log(`turn ledger — no turn records in ${audit} (${damaged} damaged lines)`);
    return 0;
  }

  const fmt = (n: number) => Math.round(n).toLocaleString("en-US");
  const total = led.units.freshInput + led.units.cachedRead + led.units.output;
  const share = (u: number) => (total ? `${((100 * u) / total).toFixed(1)}%` : "—");

  console.log(`turn ledger — ${fmt(led.turns)} turns from ${audit}`);
  const notes: string[] = [];
  // Only damage is worth an operator's attention: the file's prose lines and
  // their continuation lines are normal, and saying so every run trains the
  // reader to ignore the line that matters.
  if (damaged) notes.push(`${fmt(damaged)} damaged lines`);
  if (led.unmeasured) notes.push(`${fmt(led.unmeasured)} turns carry no cacheRead (older records — unmeasured, never cold)`);
  if (notes.length) console.log(`  ${notes.join(", ")}`);
  console.log("");
  console.log("  tokens                     bill, in fresh-input units");
  console.log(`  fresh input ${fmt(led.freshInput).padStart(12)}     ${share(led.units.freshInput).padStart(6)}`);
  console.log(`  cache read  ${fmt(led.cacheRead).padStart(12)}     ${share(led.units.cachedRead).padStart(6)}  at 0.1x`);
  console.log(`  written     ${fmt(led.output).padStart(12)}     ${share(led.units.output).padStart(6)}  at 5x`);

  // The written line is usually the biggest on the bill and was, until this
  // block existed, the only one with nothing under it. Both sub-lines are
  // printed as "of written", not as a share of the whole, so a reader cannot
  // mistake an estimate for the billed total.
  const w = led.written;
  const ofWritten = (n: number) => (led.output ? `${((100 * n) / led.output).toFixed(1)}% of written` : "—");
  if (w.thinking === null) {
    // Said out loud rather than printed as 0: this backend does not report the
    // split, and a zero here would be read as a mission that did no thinking.
    console.log(`    thinking    ${"unmeasured".padStart(12)}             (no turn reported the split)`);
  } else if (w.thinkingZeroThroughout) {
    // Not the same as unmeasured, and not a finding either: the backend sent
    // the field and put 0 in it every time. Printing a bare 0 would let a
    // reader conclude the mission never deliberated, which this figure cannot
    // support — so say what was seen and leave the conclusion open.
    console.log(`    thinking    ${"0 every turn".padStart(12)}             (a backend that reports the field but never fills it looks exactly like this)`);
  } else {
    const caveat = w.thinkingUnmeasured ? `, ${fmt(w.thinkingUnmeasured)} turns unmeasured` : "";
    console.log(`    thinking    ${fmt(w.thinking).padStart(12)}     ${ofWritten(w.thinking).padStart(17)}${caveat}`);
  }
  if (w.publishCalls) {
    const est = `~${fmt(w.estPublishTokens)}`;
    console.log(
      `    inline bodies ${est.padStart(10)}     ${ofWritten(w.estPublishTokens).padStart(17)}` +
        `  (${fmt(w.publishChars)} chars over ${fmt(w.publishCalls - w.publishByRef)} of ${fmt(w.publishCalls)} publishes, est.)`,
    );
    if (w.publishByRef) {
      console.log(`                                                  ${fmt(w.publishByRef)} published by reference, costing nothing`);
    }
  }
  console.log("");
  console.log(`  concentration  top ${led.top.length} turns hold ${(100 * led.topFreshShare).toFixed(1)}% of fresh input`);
  if (led.coldTurns) {
    console.log(
      `  cold turns     ${fmt(led.coldTurns)} of ${fmt(led.turns)} (${((100 * led.coldTurns) / led.turns).toFixed(1)}%) ` +
        `hold ${(100 * led.coldFreshShare).toFixed(1)}% of fresh input`,
    );
  }
  if (led.gaps.length) {
    console.log("\n  fresh input by gap since that seat last finished");
    for (const g of led.gaps) {
      console.log(`    ${g.label.padEnd(10)} n=${String(g.turns).padStart(4)}  median ${fmt(g.medianFresh).padStart(10)}  max ${fmt(g.maxFresh).padStart(10)}`);
    }
  }
  if (led.top.length) {
    console.log("\n  most expensive turns by fresh input");
    for (const r of led.top) {
      console.log(
        `    ${r.at.slice(0, 19)}  ${r.agentId.padEnd(12)} ${(r.kind ?? "-").padEnd(9)}` +
          ` fresh ${fmt(r.input).padStart(10)}  cached ${fmt(r.cacheRead ?? 0).padStart(11)}  written ${fmt(r.output).padStart(8)}`,
      );
    }
  }
  console.log("");
  return 0;
}

void systemClock;

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
