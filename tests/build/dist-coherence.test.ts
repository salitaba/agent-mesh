import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * `npm test` is `tsc` then `node --test dist/tests/**`, and `tsc` never removes
 * anything. Delete a source file and its compiled output stays in `dist/`,
 * where the runner still finds it and still passes it.
 *
 * This is not hypothetical. `ac8a36f` removed the opencode backend; its
 * module and its two test files went on living in `dist/`, and the suite went
 * on reporting ten passing tests for a backend that no longer existed. A green
 * run is only evidence about the code that is still here.
 *
 * The remedy is `npm run clean && npm run build`. This test exists to say so
 * out loud instead of letting the count drift.
 */
function walk(dir: string, ext: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, ext, out);
    else if (entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

/** The source tree the compiled tree was built from. The repo's own `dist/`
 *  sits directly under it; an out-of-tree build (one that symlinks the repo's
 *  `package.json` into its output root) is traced back through that link. */
function sourceRootOf(dist: string): string {
  const linked = path.join(dist, "package.json");
  if (fs.existsSync(linked) && fs.lstatSync(linked).isSymbolicLink()) return path.dirname(fs.realpathSync(linked));
  return path.dirname(dist);
}

test("every compiled file in dist still has a source", (t) => {
  // The tree this very file was compiled into (`<dist>/tests/build/`). This
  // used to be `<cwd>/dist` with a bare `return` when absent, so running the
  // suite from any other directory reported a pass that checked nothing.
  const dist = path.resolve(__dirname, "..", "..");
  const root = sourceRootOf(dist);

  const sources = new Set<string>();
  for (const top of ["packages", "apps", "tests"]) {
    const dir = path.join(root, top);
    if (!fs.existsSync(dir)) continue;
    for (const file of walk(dir, ".ts")) {
      if (file.endsWith(".d.ts")) continue;
      sources.add(path.relative(root, file).replace(/\.ts$/, ""));
    }
  }

  if (sources.size === 0) {
    t.skip(`no TypeScript sources under ${root}: cannot tell which compiled files are orphans`);
    return;
  }

  const orphans = walk(dist, ".js")
    .map((file) => path.relative(dist, file).replace(/\.js$/, ""))
    // The dashboard is Vite's, not tsc's, and never lands here.
    .filter((stem) => !sources.has(stem));

  assert.deepEqual(
    orphans,
    [],
    `dist/ holds compiled output for sources that no longer exist:\n` +
      orphans.map((o) => `  dist/${o}.js`).join("\n") +
      `\nA stale .test.js here is still run and still counted. Fix with:\n` +
      `  npm run clean && npm run build`,
  );
});
