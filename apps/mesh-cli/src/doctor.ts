/**
 * `ordane doctor`: what a support engineer needs to diagnose an install, and nothing that belongs to the customer.
 *
 * It reports the version, the plan, which settings are present (never their values), whether each project's
 * configuration parses, who holds its state lock, how big its event log is and when it last grew, and how much
 * disk is free. It never opens an event's payload, a prompt, a file an agent wrote or a credential: the log is
 * read for its size and for the sequence number and timestamp of its last line, nothing else, and every path
 * that could appear in a message is replaced by `<path>`. That is what lets a customer paste the report into a
 * ticket, and what lets the vendor say it never receives customer data.
 *
 * Offline by default, so it works when the host is down, which is when it is needed. `--host` adds a look at the
 * host's open probes (`/healthz`, `/readyz`), sending no credential.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { ConfigError, resolveConfig } from "../../../packages/config/src/index";
import { LICENSE_PUBLIC_KEYS, checkProjects, checkSeats, findLicense, loadEntitlements, type PublicKeySet } from "../../../packages/licensing/src/index";
import { LOCK_STALE_MS, STATE_LOCK_FILENAME, judgeHolder, lockInstance } from "../../../packages/persistence/src/index";
import { ProjectError, meshHome, projectsFilePath, readProjectsFile, type ProjectRef } from "../../../packages/projects/src/index";
import { serverVersion } from "../../mesh-server/src/version";

export const DOCTOR_HELP = `usage:
  ordane doctor [mesh.yaml ...] [--json] [--host <url>]
    Diagnoses this install: version, plan, which settings are present, each registered project (and any mesh.yaml
    you name) and the host's probes. Exit 0 when nothing failed, 1 when something did.
    The report contains no event-log content, prompts, files the agents wrote, credentials or paths, and shows
    settings by name only, so it is safe to paste into a support ticket.
    --host <url>   also ask a running host's /healthz and /readyz (no credential is sent)
    --json         the same report as JSON`;

type Level = "fail" | "warn" | "info";
type Kind = "secret" | "flag" | "list" | "number" | "enum" | "text";

export interface DoctorSetting {
  name: string;
  kind: Kind;
  values?: readonly string[];
}

/**
 * The settings `docs/operations.md` documents, by name. A test keeps the two lists equal, so a setting added to
 * the document without being added here (or the reverse) fails the build.
 */
export const DOCTOR_SETTINGS: readonly DoctorSetting[] = [
  { name: "MESH_API_TOKEN", kind: "secret" },
  { name: "MESH_ALLOW_INSECURE_BIND", kind: "flag" },
  { name: "MESH_ALLOWED_HOSTS", kind: "list" },
  { name: "MESH_ALLOWED_ORIGINS", kind: "list" },
  { name: "MESH_TRUST_PROXY", kind: "flag" },
  { name: "MESH_COOKIE_SECURE", kind: "flag" },
  { name: "MESH_MAX_BODY_BYTES", kind: "number" },
  { name: "MESH_MAX_SSE_CLIENTS", kind: "number" },
  { name: "MESH_HOME", kind: "text" },
  { name: "MESH_PROJECTS_ROOT", kind: "list" },
  { name: "MESH_INSTANCE_ID", kind: "text" },
  { name: "MESH_LOCK_STALE_MS", kind: "number" },
  { name: "MESH_LOCK_RECLAIM_FOREIGN", kind: "flag" },
  { name: "MESH_LICENSE", kind: "secret" },
  { name: "MESH_LICENSE_FILE", kind: "text" },
  { name: "MESH_LICENSE_ENFORCEMENT", kind: "enum", values: ["off", "warn", "enforce"] },
  { name: "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", kind: "flag" },
];

/** How an agent reaches a model. Their presence is reported; their values never are. */
const MODEL_ACCESS: ReadonlyArray<{ name: string; label: string; truthy?: boolean }> = [
  { name: "ANTHROPIC_API_KEY", label: "an Anthropic API key" },
  { name: "ANTHROPIC_AUTH_TOKEN", label: "a bearer token for an Anthropic-compatible gateway" },
  { name: "ANTHROPIC_BASE_URL", label: "a custom Anthropic endpoint" },
  { name: "CLAUDE_CODE_USE_BEDROCK", label: "Amazon Bedrock", truthy: true },
  { name: "CLAUDE_CODE_USE_VERTEX", label: "Google Cloud Vertex AI", truthy: true },
  { name: "CLAUDE_CODE_USE_FOUNDRY", label: "Microsoft Foundry", truthy: true },
  { name: "CLAUDE_CODE_OAUTH_TOKEN", label: "a Claude subscription sign-in" },
];

const MIN_TOKEN_CHARS = 32;
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const OTHER_NAMES_SHOWN = 30;

export interface DoctorFinding {
  level: Level;
  /** What is wrong, or worth knowing, in one sentence. */
  summary: string;
  /** Where the answer is written down. */
  see?: string;
}

interface LockReport {
  present: boolean;
  readable?: boolean;
  /** Whether the next start would take it over, and why: the same judgement the server makes. */
  reclaimable?: boolean;
  reason?: string;
  startedAt?: string;
  heartbeatAgeSeconds?: number | null;
}

interface LogReport {
  exists: boolean;
  bytes: number;
  lastSeq?: number;
  lastEventAt?: string;
}

export interface DoctorProject {
  id: string;
  rootExists: boolean;
  /** Only when MESH_PROJECTS_ROOT is set: whether the project sits under it. */
  underProjectsRoot?: boolean;
  config: { exists: boolean; valid?: boolean; error?: string; seats?: number; runtimes?: string[] };
  lock: LockReport;
  log: LogReport;
  freeBytes?: number;
}

export interface DoctorReport {
  schema: 1;
  generatedAt: string;
  about: string;
  install: { version: string; node: string; platform: string; arch: string; uid: number | null; homeExists: boolean; freeBytes?: number; totalBytes?: number };
  /** The plan and the state of the licence. The licensee's name is left out: support needs the id, not who it names. */
  licence: {
    plan: string;
    status: string;
    enforcement: string;
    limits: { maxSeatsPerMesh: number | null; maxProjects: number | null; maxConcurrentTurns: number | null };
    features: string[];
    source?: string;
    licenceId?: string;
    licensedPlan?: string;
    expiresAt?: string;
    graceEndsAt?: string;
    registeredProjects?: number;
  };
  settings: Array<{ name: string; state: string }>;
  /** Names of MESH_ and ANTHROPIC_ variables beyond the documented ones, which makes a misspelt setting visible. */
  otherVariables: string[];
  /** How many CLAUDE* variables are set. Their names are not listed: they are mostly a launching session's. */
  claudeVariableCount: number;
  modelAccess: string[];
  projects: DoctorProject[];
  host?: { reachable: boolean; healthz?: number; readyz?: number };
  findings: DoctorFinding[];
}

export interface DoctorCommandDeps {
  env?: NodeJS.ProcessEnv;
  home?: string;
  publicKeys?: PublicKeySet;
  now?: Date;
  uid?: number | null;
  fetch?: typeof fetch;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

const bytesText = (n: number): string => (n >= GIB ? `${(n / GIB).toFixed(1)} GiB` : n >= MIB ? `${(n / MIB).toFixed(1)} MiB` : `${n} bytes`);

/** A message made safe to show: the paths it names are replaced, and it is cut short. */
function scrub(text: string, known: readonly string[]): string {
  let out = text;
  for (const p of [...known].filter((k) => k.length > 1).sort((a, b) => b.length - a.length)) out = out.split(p).join("<path>");
  out = out.replace(/(?<![\w.<>-])\/[^\s'"`),;:]+/g, "<path>").replace(/\s+/g, " ").trim();
  return out.length > 300 ? `${out.slice(0, 297)}...` : out;
}

/**
 * Why a configuration did not load, without any of its text. A YAML syntax error carries a frame with the
 * offending source line, which can be a line of the goal or a prompt, so only its position is kept. The other
 * problems name agents, gates and fields (`agent 'pm' prompt file not found`), which is structure, not content.
 */
function configProblem(err: unknown, known: readonly string[]): string {
  if (!(err instanceof ConfigError)) return "the file could not be read";
  const problems = err.errors.map((e) => {
    const yaml = /^YAML parse error[\s\S]*? at line (\d+), column (\d+)/.exec(e);
    return yaml ? `not valid YAML (line ${yaml[1]}, column ${yaml[2]}; \`ordane validate\` prints the message)` : scrub(e.split("\n")[0] ?? "", known);
  });
  const shown = problems.slice(0, 5);
  return shown.join("; ") + (problems.length > shown.length ? `; and ${problems.length - shown.length} more` : "");
}

function freeSpace(dir: string): { free: number; total: number } | undefined {
  try {
    const s = fs.statfsSync(dir);
    return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) };
  } catch {
    return undefined;
  }
}

/**
 * The size of an event log and the sequence number and time of its last line, and nothing else. It reads a window
 * at the end of the file, walks back to the first line that parses, and takes two scalar fields from it; the
 * payload is parsed with the line and dropped without being looked at.
 */
function logReport(file: string): LogReport {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return { exists: false, bytes: 0 };
  }
  try {
    const size = fs.fstatSync(fd).size;
    const report: LogReport = { exists: true, bytes: size };
    if (size === 0) return report;
    const window = Math.min(size, 64 * 1024);
    const buf = Buffer.allocUnsafe(window);
    fs.readSync(fd, buf, 0, window, size - window);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!.trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line) as { seq?: unknown; timestamp?: unknown };
        if (typeof parsed.seq !== "number") continue;
        report.lastSeq = parsed.seq;
        if (typeof parsed.timestamp === "string") report.lastEventAt = parsed.timestamp;
        break;
      } catch {
        /* a window edge cut this line, or a torn final write */
      }
    }
    return report;
  } finally {
    fs.closeSync(fd);
  }
}

function lockReport(stateDir: string, env: NodeJS.ProcessEnv, now: number): LockReport {
  const file = path.join(stateDir, STATE_LOCK_FILENAME);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? { present: false } : { present: true, readable: false };
  }
  let holder: { pid: number; host: string; projectId: string; startedAt: string; token: string; instance?: string; startId?: string; heartbeatAt?: string } | null = null;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed.pid === "number") {
      holder = {
        pid: parsed.pid,
        host: String(parsed.host ?? ""),
        projectId: String(parsed.projectId ?? ""),
        startedAt: String(parsed.startedAt ?? ""),
        token: String(parsed.token ?? ""),
        ...(typeof parsed.instance === "string" && parsed.instance ? { instance: parsed.instance } : {}),
        ...(typeof parsed.startId === "string" && parsed.startId ? { startId: parsed.startId } : {}),
        ...(typeof parsed.heartbeatAt === "string" && parsed.heartbeatAt ? { heartbeatAt: parsed.heartbeatAt } : {}),
      };
    }
  } catch {
    /* an unreadable lock is treated as no holder, as the server treats it */
  }
  if (!holder) return { present: true, readable: false, reclaimable: true, reason: "the lock file is unreadable, so the next start takes it" };
  const stale = Number(env.MESH_LOCK_STALE_MS);
  const verdict = judgeHolder(holder, {
    instance: lockInstance(env),
    pid: process.pid,
    heldByMe: false,
    now,
    staleMs: stale > 0 ? stale : LOCK_STALE_MS,
    reclaimForeign: (env.MESH_LOCK_RECLAIM_FOREIGN ?? "").trim() !== "0",
  });
  const beat = holder.heartbeatAt ? Date.parse(holder.heartbeatAt) : NaN;
  return {
    present: true,
    readable: true,
    reclaimable: verdict.reclaim,
    reason: verdict.reason,
    startedAt: holder.startedAt,
    heartbeatAgeSeconds: Number.isFinite(beat) ? Math.round((now - beat) / 1000) : null,
  };
}

function settingState(setting: DoctorSetting, env: NodeJS.ProcessEnv): string {
  const raw = env[setting.name];
  if (raw === undefined) return "not set";
  const value = raw.trim();
  if (value === "") return setting.name === "MESH_API_TOKEN" ? "set but empty (a network address refuses to start with it)" : "set but empty (treated as not set)";
  switch (setting.kind) {
    case "secret":
      if (setting.name === "MESH_API_TOKEN") return value.length >= MIN_TOKEN_CHARS ? `set, meets the ${MIN_TOKEN_CHARS}-character minimum for network use` : `set, shorter than the ${MIN_TOKEN_CHARS} characters a network address needs (fine on loopback only)`;
      return "set";
    case "flag":
      return value === "1" || value === "0" ? `set to ${value}` : "set to something other than 1 or 0";
    case "list": {
      const n = value.split(/[,:;]/).filter((s) => s.trim()).length;
      return `set (${n} entr${n === 1 ? "y" : "ies"})`;
    }
    case "number":
      return Number.isFinite(Number(value)) ? "set, a number" : "set, not a number";
    case "enum":
      return setting.values?.includes(value.toLowerCase()) ? `set to ${value.toLowerCase()}` : "set to an unrecognised value (treated as the default)";
    default:
      return "set";
  }
}

function inspectProject(id: string, configPath: string, root: string | undefined, env: NodeJS.ProcessEnv, now: number, projectsRoots: string[]): DoctorProject {
  const rootExists = root ? fs.existsSync(root) : true;
  const project: DoctorProject = {
    id,
    rootExists,
    config: { exists: fs.existsSync(configPath) },
    lock: { present: false },
    log: { exists: false, bytes: 0 },
  };
  if (root && projectsRoots.length) {
    const real = (() => {
      try {
        return fs.realpathSync(root);
      } catch {
        return path.resolve(root);
      }
    })();
    project.underProjectsRoot = projectsRoots.some((r) => real === r || real.startsWith(r + path.sep));
  }
  if (!project.config.exists) return project;
  const known = [root ?? "", path.dirname(configPath), configPath, os.homedir()];
  try {
    const resolved = resolveConfig(configPath);
    project.config.valid = true;
    project.config.seats = resolved.agentOrder.length;
    project.config.runtimes = [...new Set(resolved.agentOrder.map((a) => resolved.agents[a]!.runtime))].sort();
    project.lock = lockReport(resolved.stateDir, env, now);
    project.log = logReport(path.join(resolved.stateDir, "logs", "events.jsonl"));
    const space = freeSpace(fs.existsSync(resolved.stateDir) ? resolved.stateDir : path.dirname(configPath));
    if (space) project.freeBytes = space.free;
  } catch (err) {
    project.config.valid = false;
    project.config.error = configProblem(err, known);
  }
  return project;
}

async function probeHost(url: string, doFetch: typeof fetch): Promise<NonNullable<DoctorReport["host"]>> {
  const base = url.replace(/\/+$/, "");
  const status = async (probe: string): Promise<number | undefined> => {
    try {
      const res = await doFetch(`${base}${probe}`, { signal: AbortSignal.timeout(3000) });
      await res.text();
      return res.status;
    } catch {
      return undefined;
    }
  };
  const [healthz, readyz] = await Promise.all([status("/healthz"), status("/readyz")]);
  return { reachable: healthz !== undefined || readyz !== undefined, ...(healthz !== undefined ? { healthz } : {}), ...(readyz !== undefined ? { readyz } : {}) };
}

export async function buildDoctorReport(positional: string[], flags: Record<string, string | boolean>, deps: DoctorCommandDeps = {}): Promise<DoctorReport> {
  const env = deps.env ?? process.env;
  const home = deps.home ?? meshHome(env);
  const now = deps.now ?? new Date();
  const findings: DoctorFinding[] = [];
  const add = (level: Level, summary: string, see?: string): void => void findings.push({ level, summary, ...(see ? { see } : {}) });

  // Install
  const uid = deps.uid !== undefined ? deps.uid : typeof process.getuid === "function" ? process.getuid() : null;
  const homeExists = fs.existsSync(home);
  const space = freeSpace(homeExists ? home : path.dirname(home));
  const install: DoctorReport["install"] = { version: serverVersion(), node: process.version, platform: process.platform, arch: process.arch, uid, homeExists };
  if (space) {
    install.freeBytes = space.free;
    install.totalBytes = space.total;
    if (space.free < 100 * MIB) add("fail", `Only ${bytesText(space.free)} is free on the data volume. The event log is append-only, so a full disk stops every mission.`, "docs/operations.md#back-up-and-restore");
    else if (space.free < GIB) add("warn", `Only ${bytesText(space.free)} is free on the data volume.`, "docs/operations.md#back-up-and-restore");
  }
  if (uid === 0) add("warn", "Running as root. The image runs as an unprivileged user (uid 10001); the agents run commands, so do not give them root.", "docs/commercial/security.md");

  // Settings, by name
  const settings = DOCTOR_SETTINGS.map((s) => ({ name: s.name, state: settingState(s, env) }));
  const token = (env.MESH_API_TOKEN ?? "").trim();
  if (env.MESH_API_TOKEN !== undefined && token.length > 0 && token.length < MIN_TOKEN_CHARS) add("warn", `MESH_API_TOKEN is shorter than ${MIN_TOKEN_CHARS} characters: the server accepts it on loopback only and refuses to listen on a network address with it (openssl rand -hex 32).`, "docs/operations.md#reachability-and-sign-in");
  if (env.MESH_API_TOKEN !== undefined && token === "") add("warn", "MESH_API_TOKEN is set but empty (a Secret that expanded to nothing?): a network address refuses to start with it.", "docs/operations.md#reachability-and-sign-in");
  if ((env.MESH_ALLOW_INSECURE_BIND ?? "").trim() === "1") add("warn", "MESH_ALLOW_INSECURE_BIND=1: the server will listen on the network without a strong token. Only safe behind a proxy that authenticates every request.", "docs/operations.md#reachability-and-sign-in");
  const enforcement = (env.MESH_LICENSE_ENFORCEMENT ?? "").trim().toLowerCase();
  if (enforcement && !["off", "warn", "enforce"].includes(enforcement)) add("warn", "MESH_LICENSE_ENFORCEMENT is not off, warn or enforce, so it is read as warn.", "docs/operations.md#licence-1");
  const projectsRoots = (env.MESH_PROJECTS_ROOT ?? "").split(path.delimiter).map((s) => s.trim()).filter(Boolean).map((r) => {
    try {
      return fs.realpathSync(r);
    } catch {
      return path.resolve(r);
    }
  });
  if (!projectsRoots.length) add("info", "MESH_PROJECTS_ROOT is not set, so a project can be registered from anywhere the process can read. Right on a laptop, wrong on a server.", "docs/operations.md#where-things-live");

  const known = new Set<string>([...DOCTOR_SETTINGS.map((s) => s.name), ...MODEL_ACCESS.map((m) => m.name)]);
  const otherAll = Object.keys(env).filter((k) => /^(MESH_|ANTHROPIC_)/.test(k) && !known.has(k)).sort();
  const otherVariables = otherAll.length > OTHER_NAMES_SHOWN ? [...otherAll.slice(0, OTHER_NAMES_SHOWN), `and ${otherAll.length - OTHER_NAMES_SHOWN} more`] : otherAll;
  const claudeVariableCount = Object.keys(env).filter((k) => k.startsWith("CLAUDE") && !known.has(k)).length;

  // Model access
  const modelAccess = MODEL_ACCESS.filter((m) => {
    const v = (env[m.name] ?? "").trim();
    return m.truthy ? v === "1" || v.toLowerCase() === "true" : v !== "";
  });
  if ((env.CLAUDE_CODE_OAUTH_TOKEN ?? "").trim()) add("warn", "A Claude subscription sign-in is set (CLAUDE_CODE_OAUTH_TOKEN). Anthropic's terms for products built on the SDK ask for an API key or cloud-provider credentials instead.", "docs/operations.md#the-agents-model-access");
  if ((env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ?? "").trim() === "") add("info", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is not set, so the Claude Code binary may send telemetry and error reports. The image sets it to 1.", "docs/operations.md#the-agents-model-access");

  // Licence and plan limits
  const keys = deps.publicKeys ?? LICENSE_PUBLIC_KEYS;
  const ent = loadEntitlements(env, home, now, keys);
  const found = findLicense(env, home);
  const licence: DoctorReport["licence"] = { plan: ent.plan, status: ent.status, enforcement: ent.enforcement, limits: { ...ent.limits }, features: [...ent.features] };
  if (found) licence.source = found.source;
  if (ent.licenseId) licence.licenceId = ent.licenseId;
  if (ent.licensedPlan) licence.licensedPlan = ent.licensedPlan;
  if (ent.expiresAt) licence.expiresAt = ent.expiresAt;
  if (ent.graceEndsAt) licence.graceEndsAt = ent.graceEndsAt;
  // The entitlement warnings name the licensee in one case (an expired licence); the report does not.
  for (const w of ent.warnings) add("warn", ent.customer ? w.split(ent.customer).join("the licensee") : w, "docs/operations.md#licence-1");

  // Projects: the registry, then any mesh.yaml named on the command line
  let refs: ProjectRef[] = [];
  try {
    refs = readProjectsFile(projectsFilePath(home));
    licence.registeredProjects = refs.length;
    const pc = checkProjects(ent, refs.length);
    if (!pc.ok) add("warn", `${refs.length} projects are registered; ${pc.message}`, "docs/commercial/licensing.md");
  } catch (err) {
    add("fail", `The project registry could not be read (${err instanceof ProjectError ? err.code : (err as NodeJS.ErrnoException).code ?? "error"}). Restore it from a backup of the data volume.`, "docs/operations.md#back-up-and-restore");
  }
  const projects: DoctorProject[] = refs.map((ref) => inspectProject(ref.id, ref.configPath, ref.root, env, now.getTime(), projectsRoots));
  positional.forEach((file, i) => projects.push(inspectProject(`mesh.yaml #${i + 1}`, path.resolve(file), undefined, env, now.getTime(), projectsRoots)));

  const needsModel = new Set<string>();
  for (const p of projects) {
    if (!p.rootExists) add("fail", `Project ${p.id}: its folder is gone. Remove it with \`ordane project remove ${p.id}\` or restore the volume.`);
    else if (!p.config.exists) add("fail", `Project ${p.id}: it has no mesh.yaml.`);
    else if (p.config.valid === false) add("fail", `Project ${p.id}: mesh.yaml does not load: ${p.config.error}`, "docs/configuration.md");
    if (p.underProjectsRoot === false) add("warn", `Project ${p.id} sits outside MESH_PROJECTS_ROOT, so the host will not open it.`, "docs/operations.md#where-things-live");
    if (p.config.seats !== undefined) {
      const sc = checkSeats(ent, p.config.seats);
      if (!sc.ok) add("warn", `Project ${p.id}: ${sc.message}`, "docs/commercial/licensing.md");
    }
    if (p.lock.present && p.lock.readable === false) add("warn", `Project ${p.id}: its state lock is unreadable; the next start takes it over.`, "docs/operations.md#a-lock-left-behind");
    else if (p.lock.present && p.lock.reclaimable) add("warn", `Project ${p.id}: a lock is left behind by a process that is gone (${p.lock.reason}). The next start takes it over; nothing needs deleting.`, "docs/operations.md#a-lock-left-behind");
    if (p.freeBytes !== undefined && p.freeBytes < GIB && p.freeBytes >= 100 * MIB) add("warn", `Project ${p.id}: only ${bytesText(p.freeBytes)} is free where its event log lives.`);
    if (p.freeBytes !== undefined && p.freeBytes < 100 * MIB) add("fail", `Project ${p.id}: only ${bytesText(p.freeBytes)} is free where its event log lives.`);
    for (const r of p.config.runtimes ?? []) if (r === "claude") needsModel.add(p.id);
  }
  if (needsModel.size && !modelAccess.some((m) => m.name !== "ANTHROPIC_BASE_URL")) {
    add("warn", `${needsModel.size === 1 ? "A project uses" : `${needsModel.size} projects use`} the Claude runtime and none of ANTHROPIC_API_KEY, Bedrock, Vertex or Foundry is set in this environment. Agents will fail to start a turn. (An Ordane run with credentials set elsewhere will not see this.)`, "docs/operations.md#the-agents-model-access");
  }

  // The host, only when asked for
  let host: DoctorReport["host"];
  if (typeof flags.host === "string") {
    host = await probeHost(flags.host, deps.fetch ?? fetch);
    if (!host.reachable) add("fail", "The host you named did not answer /healthz or /readyz within 3 seconds.", "docs/operations.md#probes");
    else if (host.healthz !== 200) add("fail", `The host's /healthz answered ${host.healthz ?? "nothing"}, not 200.`, "docs/operations.md#probes");
    else if (host.readyz === 503) add("warn", "The host answers /readyz with 503: it is draining or shutting down.", "docs/operations.md#probes");
    else if (host.readyz !== 200) add("warn", `The host's /readyz answered ${host.readyz ?? "nothing"}, not 200.`, "docs/operations.md#probes");
  }

  const order: Record<Level, number> = { fail: 0, warn: 1, info: 2 };
  findings.sort((a, b) => order[a.level] - order[b.level]);
  return {
    schema: 1,
    generatedAt: now.toISOString(),
    about: "This report contains no event-log content, prompts, files the agents wrote, credentials or paths. Settings are shown by name only.",
    install,
    licence,
    settings,
    otherVariables,
    claudeVariableCount,
    modelAccess: modelAccess.map((m) => m.label),
    projects,
    ...(host ? { host } : {}),
    findings,
  };
}

function renderText(r: DoctorReport): string[] {
  const out: string[] = [];
  const row = (label: string, value: string): void => void out.push(`  ${label.padEnd(16)}${value}`);
  out.push(`Ordane doctor, ${r.generatedAt}`, r.about, "");
  out.push("INSTALL");
  row("version", r.install.version);
  row("runtime", `node ${r.install.node} on ${r.install.platform}/${r.install.arch}`);
  row("user", r.install.uid === null ? "unknown" : r.install.uid === 0 ? "uid 0 (root)" : `uid ${r.install.uid}`);
  row("data volume", !r.install.homeExists ? "not created yet (first run)" : r.install.freeBytes !== undefined ? `${bytesText(r.install.freeBytes)} free of ${bytesText(r.install.totalBytes ?? 0)}` : "present");
  out.push("", "LICENCE");
  const day = (iso: string): string => iso.slice(0, 10);
  const n = (v: number | null): string => (v === null ? "unlimited" : String(v));
  row("plan in force", r.licence.plan);
  row("licence", r.licence.licenceId ? `${r.licence.licenceId}: ${r.licence.status}${r.licence.licensedPlan ? `, names the ${r.licence.licensedPlan} plan` : ""}${r.licence.expiresAt ? `, expires ${day(r.licence.expiresAt)}` : ""}${r.licence.graceEndsAt ? `, grace to ${day(r.licence.graceEndsAt)}` : ""}` : r.licence.status === "invalid" ? "found but not accepted (ordane license verify says why)" : "none installed");
  row("limits", `${n(r.licence.limits.maxSeatsPerMesh)} seats per mesh, ${n(r.licence.limits.maxProjects)} project(s), ${n(r.licence.limits.maxConcurrentTurns)} concurrent turns`);
  row("source", r.licence.source ?? "none");
  row("enforcement", r.licence.enforcement);
  row("features", r.licence.features.length ? r.licence.features.join(", ") : "none beyond the core runtime");
  out.push("", "SETTINGS (names only; values are never shown)");
  for (const s of r.settings) out.push(`  ${s.name.padEnd(42)}${s.state}`);
  if (r.otherVariables.length) out.push(`  also present: ${r.otherVariables.join(", ")}`);
  if (r.claudeVariableCount) out.push(`  ${r.claudeVariableCount} other CLAUDE* variable(s) are set (names not listed)`);
  out.push("", "MODEL ACCESS");
  out.push(`  ${r.modelAccess.length ? r.modelAccess.join("; ") : "none of the usual variables is set in this environment"}`);
  out.push("", `PROJECTS (${r.projects.length})`);
  for (const p of r.projects) {
    const cfg = !p.rootExists ? "folder missing" : !p.config.exists ? "no mesh.yaml" : p.config.valid ? `config valid, ${p.config.seats} seat(s), runtime ${(p.config.runtimes ?? []).join("+") || "?"}` : `config does not load: ${p.config.error}`;
    out.push(`  ${p.id}: ${cfg}`);
    if (p.config.valid) {
      out.push(`      state lock: ${!p.lock.present ? "free" : p.lock.readable === false ? "unreadable" : `${p.lock.reclaimable ? "left behind" : "held"} (${p.lock.reason})`}`);
      out.push(`      event log: ${p.log.exists ? `${bytesText(p.log.bytes)}${p.log.lastSeq !== undefined ? `, last event #${p.log.lastSeq}${p.log.lastEventAt ? ` at ${p.log.lastEventAt}` : ""}` : ""}` : "none yet"}`);
      if (p.freeBytes !== undefined) out.push(`      disk: ${bytesText(p.freeBytes)} free`);
    }
  }
  if (r.host) {
    out.push("", "HOST");
    out.push(`  ${r.host.reachable ? `/healthz ${r.host.healthz ?? "no answer"}, /readyz ${r.host.readyz ?? "no answer"}` : "no answer"}`);
  }
  out.push("", "FINDINGS");
  if (!r.findings.length) out.push("  nothing to report");
  for (const f of r.findings) out.push(`  ${f.level.toUpperCase().padEnd(5)} ${f.summary}${f.see ? ` (${f.see})` : ""}`);
  return out;
}

/** Exit 0 when nothing failed (warnings do not fail it), 1 when something did, 2 for a mistake in how it was asked for. */
export async function runDoctorCommand(positional: string[], flags: Record<string, string | boolean>, deps: DoctorCommandDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => process.stdout.write(`${l}\n`));
  const err = deps.err ?? ((l: string) => console.error(l));
  if (flags.help) {
    out(DOCTOR_HELP);
    return 0;
  }
  if (flags.host === true) {
    err(`ordane doctor: --host needs a URL\n\n${DOCTOR_HELP}`);
    return 2;
  }
  for (const file of positional) {
    if (!fs.existsSync(file)) {
      err(`ordane doctor: no such file: ${file}\n\n${DOCTOR_HELP}`);
      return 2;
    }
  }
  const report = await buildDoctorReport(positional, flags, deps);
  if (flags.json) out(JSON.stringify(report, null, 2));
  else for (const line of renderText(report)) out(line);
  return report.findings.some((f) => f.level === "fail") ? 1 : 0;
}
