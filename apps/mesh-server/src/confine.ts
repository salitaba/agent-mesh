/**
 * Where a host may be pointed.
 *
 * `POST /api/projects {root}` registers a folder, `init: true` writes a `mesh.yaml` into it, and
 * `GET /api/browse` lists any directory the host process can read. On a laptop that is the point: the
 * operator is the user and the host can already read what they can. On a server it is a way to ask a
 * process with a network address to walk its own filesystem (the registry home, a licence, another
 * project's workspace), so a deployment names the one directory projects live under and the host
 * refuses everything else.
 *
 * `MESH_PROJECTS_ROOT` is that directory (several, separated like PATH). Unset means no confinement,
 * which is the local default. The image and the chart set it to /data/projects.
 */
import * as fs from "fs";
import * as path from "path";

/** The configured roots, resolved through their own links so a comparison cannot be fooled by one. */
export function projectRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.MESH_PROJECTS_ROOT ?? "")
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => realpathOrSelf(path.resolve(p)));
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * The real location of `p`, or of its nearest ancestor that exists with the rest appended. A folder
 * about to be created has no real path yet, but where it WILL be is decided by the ancestor it hangs
 * from, and that may be a link out of the root.
 */
export function realLocation(p: string): string {
  const abs = path.resolve(p);
  const tail: string[] = [];
  let probe = abs;
  for (;;) {
    try {
      return path.join(fs.realpathSync(probe), ...tail.reverse());
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return abs;
      tail.push(path.basename(probe));
      probe = parent;
    }
  }
}

/** Whether `target` is a root or lies beneath one. `target` should come from `realLocation`. */
export function insideRoots(target: string, roots: readonly string[]): boolean {
  return roots.some((root) => target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep));
}

/** The sentence a refusal carries, naming the setting so an operator knows what to change. */
export function outsideRootsMessage(roots: readonly string[]): string {
  return `that folder is outside the projects directory this host is confined to (${roots.join(", ")}); put the project under it, or change MESH_PROJECTS_ROOT`;
}
