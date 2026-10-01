/**
 * `mesh license`: see, check, install and remove a licence.
 *
 * The vendor's side (key generation and signing) is `tools/license/mesh-license.mjs`, which a customer never
 * has. This is the customer's: it verifies a token against the public keys the build ships, writes it where
 * the server looks for it (`<home>/license.key`, readable by its owner only), and reports what it allows and
 * how much of that is in use. Nothing here contacts anyone.
 */
import * as fs from "fs";
import * as path from "path";
import {
  LICENSE_FILENAME,
  LICENSE_PUBLIC_KEYS,
  checkProjects,
  checkSeats,
  findLicense,
  loadEntitlements,
  resolveEntitlements,
  verifyLicense,
  type PublicKeySet,
} from "../../../packages/licensing/src/index";
import { meshHome, projectsFilePath, readProjectsFile } from "../../../packages/projects/src/index";
import { resolveConfig } from "../../../packages/config/src/index";

export const LICENSE_HELP = `usage:
  mesh license [status] [mesh.yaml] [--json]   what this install is entitled to, and how much is in use
  mesh license install <key|file>              verify a licence and save it to <home>/license.key
  mesh license verify <key|file>               check a licence without saving it
  mesh license remove                          delete the saved licence (the install returns to Community)
    <home> is $MESH_HOME or ~/.agent-mesh. A licence in MESH_LICENSE or MESH_LICENSE_FILE takes precedence over
    the saved one. MESH_LICENSE_ENFORCEMENT is off | warn (default) | enforce: warn reports a breach and never
    refuses; enforce refuses to START what the plan does not allow, and never stops anything that is running.
    A running server picks up a newly installed licence within 30 seconds.`;

export interface LicenseCommandDeps {
  env?: NodeJS.ProcessEnv;
  home?: string;
  publicKeys?: PublicKeySet;
  now?: Date;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/** A licence given as a file path or as the key itself. */
function tokenFrom(arg: string): string {
  try {
    if (fs.statSync(arg).isFile()) return fs.readFileSync(arg, "utf8").trim();
  } catch {
    /* not a file: it is the key */
  }
  return arg.trim();
}

export async function runLicenseCommand(positional: string[], flags: Record<string, string | boolean>, deps: LicenseCommandDeps = {}): Promise<number> {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  const env = deps.env ?? process.env;
  const home = deps.home ?? meshHome(env);
  const keys = deps.publicKeys ?? LICENSE_PUBLIC_KEYS;
  const now = deps.now ?? new Date();
  const [sub = "status", ...rest] = positional;

  if (flags.help) {
    out(LICENSE_HELP);
    return 0;
  }

  if (sub === "status") {
    const ent = loadEntitlements(env, home, now, keys);
    const found = findLicense(env, home);
    const usage: Record<string, number> = {};
    try {
      usage.projects = readProjectsFile(projectsFilePath(home)).length;
    } catch {
      /* an unreadable registry is reported by the commands that need it */
    }
    const meshFile = rest[0];
    let seats: number | undefined;
    if (meshFile) {
      seats = resolveConfig(meshFile).agentOrder.length;
      usage.seats = seats;
    }
    if (flags.json) {
      out(JSON.stringify({ ...ent, ...(found ? { source: found.source } : {}), usage }, null, 2));
      return 0;
    }
    out(`Plan:       ${ent.summary}`);
    out(`Source:     ${found ? found.source : "none (no licence is installed)"}`);
    out(`Enforcement: ${ent.enforcement}${ent.enforcement === "warn" ? " (a breach is reported and nothing is refused)" : ent.enforcement === "enforce" ? " (what the plan does not allow will not start)" : " (nothing is checked)"}`);
    out(`Features:   ${ent.features.length ? ent.features.join(", ") : "none beyond the core runtime"}`);
    const registered = usage.projects;
    if (registered !== undefined) {
      const pc = checkProjects(ent, registered);
      out(`In use:     ${registered} project(s) registered under ${home}${pc.ok ? "" : ` — ${pc.message}`}`);
    }
    if (seats !== undefined) {
      const sc = checkSeats(ent, seats);
      out(`            ${seats} seat(s) in ${meshFile}${sc.ok ? "" : ` — ${sc.message}`}`);
    }
    for (const w of ent.warnings) out(`warning:    ${w}`);
    return 0;
  }

  if (sub === "verify" || sub === "install") {
    const arg = rest[0];
    if (!arg) {
      err(`mesh license ${sub}: give a licence key or the path of a file that holds one\n\n${LICENSE_HELP}`);
      return 2;
    }
    const token = tokenFrom(arg);
    const verified = verifyLicense(token, keys);
    if (!verified.ok) {
      err(`licence not accepted (${verified.reason}): ${verified.detail}`);
      if (verified.reason === "unknown-key" && Object.keys(keys).length === 0) {
        err("this build ships no licence keys, so no licence can verify here; it is a development build.");
      }
      return 1;
    }
    const ent = resolveEntitlements({ token, publicKeys: keys, now });
    out(ent.summary);
    for (const w of ent.warnings) out(`warning: ${w}`);
    if (sub === "verify") return 0;
    fs.mkdirSync(home, { recursive: true });
    const file = path.join(home, LICENSE_FILENAME);
    // Written then renamed, mode 600: a half-written licence must never be what a server reads, and the file
    // names a customer.
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${token}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
    out(`saved to ${file}`);
    const inline = (env.MESH_LICENSE ?? "").trim();
    if (inline) out(`note: MESH_LICENSE is set in this environment and takes precedence over the saved licence; unset it for the saved one to apply.`);
    out("A running server picks it up within 30 seconds.");
    return 0;
  }

  if (sub === "remove") {
    const file = path.join(home, LICENSE_FILENAME);
    if (!fs.existsSync(file)) {
      out(`no saved licence at ${file}`);
      return 0;
    }
    fs.rmSync(file, { force: true });
    out(`removed ${file}; this install is on the Community plan unless MESH_LICENSE or MESH_LICENSE_FILE names another.`);
    return 0;
  }

  err(`mesh license: unknown subcommand '${sub}'\n\n${LICENSE_HELP}`);
  return 2;
}
