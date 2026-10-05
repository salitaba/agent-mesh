import { isMeshSecret } from "../../../agent-runtime/src/index";

/**
 * The environment a seat's shell starts with.
 *
 * Two modes. `inherit` is the process environment, which is what the Claude adapter's seats get, minus the mesh's own
 * credentials and the runtime's provider keys. `minimal` is an allowlist (the variables a shell and its common tools need
 * to run, and nothing else), for a deployment where the process environment cannot be trusted to hold only what a seat
 * may use: a hosted workspace, where it holds the workspace's gateway key.
 *
 * `deny` names variables that are removed in either mode: the runtime passes the ones it was configured to read keys from.
 */
export type ShellEnvMode = "inherit" | "minimal";

const MINIMAL_KEEP = new Set(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TZ", "TMPDIR", "TERM", "NODE_ENV"]);

export function shellEnv(base: Record<string, string | undefined>, mode: ShellEnvMode, deny: readonly string[] = [], extra: Record<string, string> = {}): Record<string, string> {
  const denied = new Set(deny);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value === undefined || denied.has(name) || isMeshSecret(name)) continue;
    if (mode === "minimal" && !MINIMAL_KEEP.has(name) && !name.startsWith("LC_")) continue;
    out[name] = value;
  }
  // A shell the seat cannot answer: no pager to wait in, no credential prompt to wait on.
  return { ...out, TERM: out.TERM ?? "dumb", GIT_TERMINAL_PROMPT: "0", PAGER: "cat", GIT_PAGER: "cat", ...extra };
}
