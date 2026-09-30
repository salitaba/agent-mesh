import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * What a seat's CLI inherits from the machine that launched the mesh.
 *
 * Two routes, and neither is a mesh setting, which is why neither was ever on the
 * operator's radar.
 *
 * 1. Settings. The SDK loads every filesystem settings source unless told not to
 *    (`settingSources` omitted means user, project and local), so the launching
 *    user's `~/.claude/settings.json` (its hooks, its `permissions.allow`, its `env`,
 *    its model and effort) applies to every seat exactly as it does to that user's own
 *    sessions. A hook that reads the user's transcripts, an allow rule that
 *    pre-approves what the seat's permission gate would refuse, a `model` override:
 *    each was a silent change to what the mesh ran, and the substituted model of an
 *    earlier run came from here.
 * 2. Environment. A mesh started from inside another Claude Code session inherits
 *    that session's variables, and they describe the OUTER session, not the seat:
 *    the cronlite seat CLIs reported the outer session's id, ran at the outer
 *    session's effort (`CLAUDE_EFFORT=max`, `MAX_THINKING_TOKENS=31999`), and carried
 *    its artifact plumbing.
 *
 * `mesh.runtime.isolate_host: true` closes both (an empty `settingSources`, and the
 * outer session's variables removed). It is off by default because a mesh that works
 * today may depend on either, an operator's proxy hook or an allow rule among them;
 * the default is to say so at boot instead.
 */

/**
 * The variables that describe the session a process was started from, never a seat's own:
 * everything in the `CLAUDE` namespace (`CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_*`) except what
 * `KEPT_CLAUDE_ENV` names, and `MAX_THINKING_TOKENS`, which sits outside it.
 *
 * This was a list of names, the five the first cronlite run had shown plus `CLAUDE_CODE_ARTIFACT_*`.
 * The second run, from a container whose environment held 56 variables of the family, measured it
 * taking out ten. The rest still reached every seat, and with them the outer session's messaging
 * token and socket, the file its session-ingress token is read from, its debug switch and
 * diagnostics file, its transport flags: a seat's shell inherits the CLI's environment. A namespace
 * that grows with every release cannot be kept up with by name, so the rule is the namespace, and
 * the names are the exceptions.
 */
function isOuterSessionVar(name: string): boolean {
  if (name === "MAX_THINKING_TOKENS") return true;
  return name.startsWith("CLAUDE") && !KEPT_CLAUDE_ENV.has(name);
}

/**
 * The `CLAUDE*` variables that say how to REACH the model, which isolation must not touch: how
 * the CLI logs in, which provider it talks to, where its credentials and its config live, what it
 * trusts on the way, and whether a proxy resolves hosts for it. Scrubbing one would make isolation
 * a way to break a working mesh. `ANTHROPIC_*`, the proxy variables (`HTTPS_PROXY`, `NO_PROXY`)
 * and the CA variables are outside the namespace and are never considered. A provider added after
 * this list was written is removed until it is named here, which fails at login, loudly and
 * at once; the same seat left running under the outer session's plumbing would not fail at all.
 *
 * Not kept, on purpose, though they sit next to these in a container's environment:
 * `CLAUDE_CODE_USE_CCR_V2` and `CLAUDE_CODE_REMOTE*` (how the OUTER session reports to its host),
 * and `CLAUDE_CODE_SESSION_ID` / `CLAUDE_SESSION_INGRESS_TOKEN_FILE` (who it is).
 */
const KEPT_CLAUDE_ENV: ReadonlySet<string> = new Set([
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_API_KEY_HELPER_TTL_MS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "CLAUDE_CODE_CLIENT_CERT",
  "CLAUDE_CODE_CLIENT_KEY",
  "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
  "CLAUDE_CODE_PROXY_RESOLVES_HOSTS",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "CLAUDE_CONFIG_DIR",
]);

/** How many variable names a sentence spells out before it counts the rest: a container can hold fifty. */
const NAMES_SHOWN = 6;

/** `names` (sorted) as a clause: all of them when they are few, else the first few and how many more. */
function summarizeNames(names: string[]): string {
  if (names.length <= NAMES_SHOWN + 1) return names.join(", ");
  return `${names.slice(0, NAMES_SHOWN).join(", ")} and ${names.length - NAMES_SHOWN} more`;
}

/** Names of the variables in `env` that belong to the launching session. */
export function outerSessionEnvNames(env: Record<string, string | undefined> = process.env): string[] {
  return Object.keys(env).filter((k) => env[k] !== undefined && isOuterSessionVar(k)).sort();
}

/** `env` without the launching session's variables. Everything else, credentials and proxies included, is kept. */
export function withoutOuterSession(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) if (!isOuterSessionVar(k)) out[k] = v;
  return out;
}

/** The keys of a user settings file that change how a seat behaves, as opposed to how the user's own terminal looks. */
const SEAT_AFFECTING_SETTINGS = ["hooks", "permissions", "env", "model", "effortLevel", "apiKeyHelper", "enabledPlugins", "alwaysThinkingEnabled"] as const;

export interface HostLeakInputs {
  env?: Record<string, string | undefined>;
  /** Where the user's `.claude` directory lives. Default: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
  configDir?: string;
  readFile?: (file: string) => string;
}

/**
 * One sentence per way the launching machine will shape a seat, for the operator to
 * read at boot. Empty when nothing would. It reads, and changes, nothing.
 */
export function describeHostLeaks(inputs: HostLeakInputs = {}): string[] {
  const env = inputs.env ?? process.env;
  const read = inputs.readFile ?? ((file: string) => fs.readFileSync(file, "utf8"));
  const out: string[] = [];

  const outer = outerSessionEnvNames(env);
  if (outer.length > 0) {
    out.push(
      `this mesh was started from inside another Claude Code session, and its seats inherit that session's environment (${summarizeNames(outer)}) — ` +
        `they describe the outer session (its id, its effort, its artifact plumbing), not the seats`,
    );
    // The part that matters most, said apart: a seat's shell inherits all of it.
    // A word of the name, not a substring of one: `MAX_THINKING_TOKENS` is a setting.
    const credentials = outer.filter((name) => /(^|_)(TOKEN|SECRET|PASSWORD|CREDENTIALS?|KEY)(_|$)/.test(name));
    if (credentials.length > 0) {
      out.push(`${summarizeNames(credentials)} look like the outer session's own credentials, and every seat's shell can read them`);
    }
  }

  const dir = inputs.configDir ?? env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  const file = path.join(dir, "settings.json");
  try {
    const parsed = JSON.parse(read(file)) as Record<string, unknown>;
    const keys = SEAT_AFFECTING_SETTINGS.filter((k) => {
      const v = parsed[k];
      if (v === undefined || v === null) return false;
      return typeof v !== "object" || Object.keys(v as object).length > 0;
    });
    if (keys.length > 0) {
      out.push(`seats load ${file}, and it sets ${keys.join(", ")}: each applies to every seat as it does to your own sessions`);
    }
  } catch {
    // No such file, or not JSON: there is nothing to inherit from it.
  }

  if (out.length > 0) out.push("set `mesh.runtime.isolate_host: true` to run the seats without either");
  return out;
}

/**
 * What `isolate_host` takes out of the seats' environment, as one sentence for the audit log;
 * null when there is nothing to take out. The other half of `describeHostLeaks`: that says what
 * WOULD leak, this says what did not, in full, so an operator whose seat then fails to log in
 * can see at once whether isolation removed something it needed (and which `CLAUDE*` names it kept).
 */
export function describeIsolation(env: Record<string, string | undefined> = process.env): string | null {
  const removed = outerSessionEnvNames(env);
  if (removed.length === 0) return null;
  const kept = Object.keys(env)
    .filter((k) => env[k] !== undefined && k.startsWith("CLAUDE") && KEPT_CLAUDE_ENV.has(k))
    .sort();
  return (
    `isolate_host: seats run without ${removed.length} variable${removed.length === 1 ? "" : "s"} of the launching environment (${removed.join(", ")})` +
    `${kept.length > 0 ? `; kept, because they authenticate or route the CLI: ${kept.join(", ")}` : ""}`
  );
}
