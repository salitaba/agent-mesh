import * as fs from "fs";
import * as path from "path";

/**
 * Write a CommonJS script that a test spawns as a child process, and return its path.
 *
 * The extension is `.cjs`, never `.js`. Node decides what a `.js` file is from the nearest package.json above
 * it, and a script written under os.tmpdir() has whatever package.json happens to sit above THAT: any stray
 * one. A seat of the seventh cronlite run wrote its product's package.json (`"type": "module"`) to
 * /tmp/package.json from its shell; from then on every `require` in these stubs failed ("require is not
 * defined in ES module scope"), thirty tests failed, and one file's process stayed up for twenty minutes
 * (see the shutdown test in tests/server/host-routing.test.ts). A `.cjs` file is CommonJS whatever is above it.
 */
export function writeStubScript(dir: string, name: string, source: string): string {
  const file = path.join(dir, `${name}.cjs`);
  fs.writeFileSync(file, source, "utf8");
  return file;
}
