import * as fs from "fs";
import * as path from "path";

/**
 * The product's version, from the package.json this build ships beside (the repo root, or `/app` in the image).
 *
 * Walks up from the compiled file rather than assuming a depth, because `dist/apps/mesh-server/src` and the
 * source tree are different depths and the image copies only what runs.
 */
let cached: string | undefined;

export function serverVersion(): string {
  if (cached !== undefined) return cached;
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
      if (pkg.name === "ordane" && pkg.version) return (cached = pkg.version);
    } catch {
      /* not here: look one directory up */
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return (cached = "unknown");
}
