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

/** Variables that describe the session a process was started from, never a seat's own. */
const OUTER_SESSION_ENV = ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_EFFORT", "MAX_THINKING_TOKENS"] as const;
const OUTER_SESSION_ENV_PREFIXES = ["CLAUDE_CODE_ARTIFACT_"] as const;

/**
 * Deliberately NOT here: anything that authenticates or routes the CLI
 * (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`,
 * `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`/`_VERTEX`, the proxy and CA
 * variables). Scrubbing those would make isolation a way to break a working mesh.
 */
function isOuterSessionVar(name: string): boolean {
  return (OUTER_SESSION_ENV as readonly string[]).includes(name) || OUTER_SESSION_ENV_PREFIXES.some((p) => name.startsWith(p));
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
      `this mesh was started from inside another Claude Code session, and its seats inherit that session's environment (${outer.join(", ")}) — ` +
        `they describe the outer session (its id, its effort, its artifact plumbing), not the seats`,
    );
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
