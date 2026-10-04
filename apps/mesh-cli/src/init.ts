/**
 * `curule init`: a first project, ready to register.
 *
 *   curule init [dir]                          the default team, on the Claude runtime
 *   curule init [dir] --runtime stub           the same team on the stub runtime: boots and runs with no model calls
 *   curule init [dir] --example <name>         a shipped example, copied out self-contained
 *   curule init --list                         the shipped examples
 *
 * An example in `examples/` points at the repository's `roles/` with `../../roles/...`, which is right where it
 * sits and wrong anywhere else: copied into a container's data volume it would find no prompts. Scaffolding one
 * copies the role files it names into the project and points the config at them, so the result runs wherever it is put.
 */
import * as path from "path";
import { findShippedRoot as findRoot, listExamples, resolveConfig, scaffoldExample, writeDefaultMeshYaml } from "../../../packages/config/src/index";

// The scaffolding lives in the config package, because the host scaffolds from the dashboard too and cannot import this
// file (the CLI imports the host). Re-exported so this stays the one place a caller of `curule init` looks.
export { listExamples, scaffoldExample };

export const INIT_HELP = `usage:
  curule init [dir]                       scaffold mesh.yaml and roles/ (default team, Claude runtime)
  curule init [dir] --runtime stub        the same on the stub runtime, which needs no API key
  curule init [dir] --example <name>      copy a shipped example into dir, self-contained (see --list)
  curule init --list                      the shipped examples
    The scaffold is a project the host can register: curule project add <dir>, or add it from the dashboard.`;

export interface InitDeps {
  /** The directory holding `examples/` and `roles/`. Found by walking up from this file when omitted. */
  repoRoot?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

const RUNTIMES = ["claude", "stub"] as const;

/** The directory that holds `examples/` and `roles/`: the repository root, or `/app` in the image. */
export function findShippedRoot(from: string = __dirname): string | undefined {
  return findRoot(from);
}

export function runInitCommand(positional: string[], flags: Record<string, string | boolean>, deps: InitDeps = {}): number {
  const out = deps.out ?? ((l: string) => console.log(l));
  const err = deps.err ?? ((l: string) => console.error(l));
  if (flags.help) {
    out(INIT_HELP);
    return 0;
  }
  const root = deps.repoRoot ?? findShippedRoot();

  if (flags.list) {
    const names = root ? listExamples(root) : [];
    if (names.length === 0) {
      err("curule init --list: no examples are shipped with this install");
      return 1;
    }
    for (const name of names) out(name);
    return 0;
  }

  const dir = path.resolve(positional[0] ?? ".");
  if (flags.example === true || flags.runtime === true) {
    err(`curule init: --${flags.example === true ? "example" : "runtime"} needs a value\n\n${INIT_HELP}`);
    return 2;
  }
  const example = typeof flags.example === "string" ? flags.example : undefined;
  const runtime = typeof flags.runtime === "string" ? flags.runtime : undefined;
  if (example !== undefined && runtime !== undefined) {
    err("curule init: an example brings its own runtime; give --example or --runtime, not both");
    return 2;
  }

  if (example !== undefined) {
    const names = root ? listExamples(root) : [];
    if (!root || !names.includes(example)) {
      err(`curule init: no example '${example}'. ${names.length ? `Available: ${names.join(", ")}` : "This install ships none"}.`);
      return 2;
    }
    const made = scaffoldExample(root, example, dir);
    const wrote = made.roles.length - made.kept.length;
    out(`wrote ${made.configPath} and ${wrote} role prompt(s) under ${path.join(dir, "roles")}${made.kept.length ? `; kept the ${made.kept.length} you already had` : ""}`);
    // The result must load: say so now rather than at the first `curule project add`.
    resolveConfig(made.configPath);
    out(`next: curule project add ${dir}`);
    return 0;
  }

  if (runtime !== undefined && !(RUNTIMES as readonly string[]).includes(runtime)) {
    err(`curule init: --runtime must be one of ${RUNTIMES.join(", ")}, not '${runtime}'`);
    return 2;
  }
  const file = writeDefaultMeshYaml(dir, path.basename(dir), runtime ?? "claude");
  out(`wrote ${file}`);
  out(`next: curule project add ${dir}`);
  return 0;
}
