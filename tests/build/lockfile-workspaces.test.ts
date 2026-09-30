import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * `npm ci` refuses a lockfile that disagrees with the workspaces on disk, and
 * the workspaces are the one thing in this repo that changes without anyone
 * touching `package-lock.json`. The opencode backend was removed and the
 * Claude adapter added, and the lock still listed `@mesh/runtime-opencode` and
 * lacked `@mesh/runtime-claude`: a clean checkout could not `npm ci` at all
 * ("Missing: @mesh/runtime-claude@0.1.0 from lock file", 2026-09-30), while every
 * machine that had ever run `npm install` kept working and nobody noticed.
 *
 * This checks the part CI cannot see from a warm `node_modules`: the lock's
 * workspace entries and the `packages/*` directories name the same packages.
 * Regenerate with `npm install --package-lock-only`, then check the diff: npm
 * drops the `libc` markers on optional native dependencies when it rewrites the
 * lock on some platforms, and those must stay.
 */

function sourceRootOf(dist: string): string {
  const linked = path.join(dist, "package.json");
  if (fs.existsSync(linked) && fs.lstatSync(linked).isSymbolicLink()) return path.dirname(fs.realpathSync(linked));
  return path.dirname(dist);
}

test("package-lock.json names exactly the workspace packages that exist under packages/", (t) => {
  const dist = path.resolve(__dirname, "..", "..");
  const root = sourceRootOf(dist);
  const lockFile = path.join(root, "package-lock.json");
  const packagesDir = path.join(root, "packages");
  if (!fs.existsSync(lockFile) || !fs.existsSync(packagesDir)) {
    t.skip(`no package-lock.json and packages/ under ${root}: nothing to compare`);
    return;
  }

  const lock = JSON.parse(fs.readFileSync(lockFile, "utf8")) as {
    packages: Record<string, { name?: string; resolved?: string; link?: boolean }>;
  };

  const onDisk = new Map<string, string>();
  for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    const manifest = path.join(packagesDir, entry.name, "package.json");
    if (!entry.isDirectory() || !fs.existsSync(manifest)) continue;
    onDisk.set(`packages/${entry.name}`, (JSON.parse(fs.readFileSync(manifest, "utf8")) as { name: string }).name);
  }
  assert.ok(onDisk.size > 0, "fixture: the repo has workspace packages");

  const problems: string[] = [];
  for (const [dir, name] of onDisk) {
    if (lock.packages[dir]?.name !== name) problems.push(`missing from the lock: workspace ${name} (${dir})`);
    const link = lock.packages[`node_modules/${name}`];
    if (link?.resolved !== dir || link?.link !== true) problems.push(`missing from the lock: the node_modules link for ${name} -> ${dir}`);
  }
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key.startsWith("packages/") && !onDisk.has(key)) problems.push(`stale in the lock: ${key} (${entry.name ?? "?"}) has no directory`);
    if (key.startsWith("node_modules/@mesh/") && entry.link === true && !onDisk.has(entry.resolved ?? "")) {
      problems.push(`stale in the lock: ${key} links to ${entry.resolved ?? "?"}, which does not exist`);
    }
  }

  assert.deepEqual(problems, [], `package-lock.json is out of step with the workspaces (npm ci would refuse it):\n  ${problems.join("\n  ")}\nRegenerate with: npm install --package-lock-only   (and keep the \`libc\` markers)`);
});
