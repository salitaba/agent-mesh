import * as fs from "fs";
import * as path from "path";
import { ToolFailure } from "./types";

/**
 * Keeping the file tools inside the directories a seat is given.
 *
 * A seat with no shell still has a `Read` tool, and a `Read` that can open any path is a way to every secret the process
 * holds: `/proc/self/environ` is the environment of the runtime itself, with its provider and gateway keys in it, and a
 * seat that can read it can put it in a message. So paths are resolved the way the kernel will resolve them, symlinks
 * included, and must land inside a root. A path that does not exist yet (a file about to be written) is resolved through its
 * nearest existing parent, so a new file, or one reached through a link that points out, is held to the same rule.
 */

/** The real path of `p`, even when it does not exist yet: the nearest existing parent resolved, the rest appended. */
export function realPath(p: string): string {
  let existing = path.resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(existing), ...rest);
    } catch {
      const parent = path.dirname(existing);
      if (parent === existing) return path.resolve(p);
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * `input` as an absolute real path inside one of `roots`.
 *
 * `~` is not expanded: a model that writes `~/.ssh/id_rsa` gets a path under the seat's directory called `~`, which does not
 * exist, rather than the operator's home.
 */
export function confine(input: string, cwd: string, roots: readonly string[], verb: "read" | "write"): string {
  if (input.includes("\0")) throw new ToolFailure("the path contains a NUL byte");
  const resolved = realPath(path.resolve(cwd, input));
  if (roots.some((root) => isInside(resolved, realPath(root)))) return resolved;
  throw new ToolFailure(
    `${input} is outside the directories this seat may ${verb}` +
      (roots.length > 0 ? ` (${roots.map((r) => realPath(r)).join(", ")}). Use a path inside your own workspace.` : "."),
  );
}

/** A write into a repository's own metadata would let a seat plant a hook the next `git commit` runs. */
export function touchesGitDir(resolved: string, root: string): boolean {
  const rel = path.relative(realPath(root), resolved);
  return rel.split(path.sep).includes(".git");
}
