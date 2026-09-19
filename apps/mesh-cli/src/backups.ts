/**
 * `mesh backups` and `mesh restore` — the offline half of mission recovery.
 *
 * The server routes of the same names do this against a live, parked mesh. These
 * do it against a mesh that is not running at all, which is the state an
 * operator is usually in when they realize a reset took something they wanted:
 * the whole point is that the swap is a file operation, and the next boot
 * replays whatever log it finds.
 *
 * "Not running" is enforced rather than assumed. The state dir carries an
 * advisory lock naming its holder, and every write path in this module takes
 * that lock first — so the answer to "is some mesh using this directory?" comes
 * from the same file the server checks, and a mismatch reports the holder's pid
 * instead of interleaving writes with a live mission.
 */
import * as path from "path";
import { resolveConfig } from "../../../packages/config/src/index";
import {
  acquireStateLock,
  listArchives,
  meshArchiveRoot,
  readLogTailSeq,
  restoreStateDir,
  type MeshArchiveEntry,
} from "../../../packages/persistence/src/index";
import type { Flags } from "./projects";

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export const BACKUPS_HELP = `usage: mesh backups <mesh.yaml>

List every archive this mesh has written, newest first. One reset writes one
set of archives sharing a stamp: the state directory (the mission log — the
only restorable one), the product checkout, and the agent worktrees.

  --json    machine-readable output

Restore one with:  mesh restore <mesh.yaml> <stamp>`;

export const RESTORE_HELP = `usage: mesh restore <mesh.yaml> <stamp> [--keep-sessions]

Put an archived mission back. The mesh must not be running.

The archive itself is copied, never moved, so the same stamp can be restored
again and the backup survives a failed attempt. The state it replaces is
archived first, so a mistake here is itself undoable.

Only the state archive is restorable. The product checkout and the agent
worktrees cannot be: reading them back over a live product would overwrite work
with no way to merge. The archived worktree commits stay recoverable from the
bundle in the worktrees archive:
  git fetch <archive>/mesh-branches.bundle 'refs/heads/*:refs/heads/restored/*'

  --keep-sessions   carry the archived agent sessions over too. Off by default:
                    those session ids point at runtimes from before the reset
                    and fail mid-turn rather than at boot.`;

/** Resolve the mesh and every archive it has written. Shared by both commands. */
function openArchive(meshPath: string): { root: string; meshId: string; entries: MeshArchiveEntry[] } {
  const config = resolveConfig(meshPath);
  const root = meshArchiveRoot(config.dir, config.meshId);
  return { root, meshId: config.meshId, entries: listArchives(root) };
}

export function runBackupsCommand(positional: string[], flags: Flags): number {
  const meshPath = positional[0];
  if (!meshPath) throw new Error("usage: mesh backups <mesh.yaml>");
  const { root, meshId, entries } = openArchive(meshPath);

  if (flags.json) {
    console.log(JSON.stringify({ meshId, root, backups: entries }, null, 2));
    return 0;
  }
  if (entries.length === 0) {
    console.log(`no backups for ${meshId} (looked in ${root})`);
    return 0;
  }
  for (const e of entries) {
    // The restorability marker is the point of the listing: these three
    // archives share a stamp but only one can be brought back.
    const restorable = e.hasEvents ? "restorable" : `${e.kind} — not restorable`;
    console.log(`${e.stamp}  ${e.name.padEnd(42)} ${humanBytes(e.bytes).padStart(9)}  ${restorable}`);
  }
  console.log(`\nrestore one with: mesh restore ${meshPath} <stamp>`);
  return 0;
}

export function runRestoreCommand(positional: string[], flags: Flags): number {
  const [meshPath, stampArg] = positional;
  if (!meshPath || !stampArg) throw new Error("usage: mesh restore <mesh.yaml> <stamp>");
  const config = resolveConfig(meshPath);
  const root = meshArchiveRoot(config.dir, config.meshId);
  const stamp = stampArg.trim();

  // Taking the lock IS the liveness check: it fails on a live holder, naming
  // its pid, which is the answer we want. Held for the whole swap so a second
  // restore cannot interleave, and released on every path out.
  const lock = acquireStateLock(config.stateDir, { projectId: config.meshId });
  try {
    const withStamp = listArchives(root).filter((a) => a.stamp === stamp);
    if (withStamp.length === 0) {
      throw new Error(`no backup with stamp ${stamp} for ${config.meshId} (looked in ${root})\nRun: mesh backups ${meshPath}`);
    }
    const chosen = withStamp.find((a) => a.hasEvents);
    if (!chosen) {
      throw new Error(
        `stamp ${stamp} has no state archive (found: ${withStamp.map((a) => a.kind).join(", ")}). ` +
          `Only the state archive holds the mission log; the product checkout and the agent worktrees cannot be restored.`,
      );
    }
    if (readLogTailSeq(path.join(chosen.path, "logs", "events.jsonl")) === null) {
      throw new Error(`backup ${chosen.name} holds no events — restoring it would change nothing.`);
    }
    const result = restoreStateDir(chosen.path, config.stateDir, {
      archiveRoot: root,
      keepSessions: flags["keep-sessions"] === true,
    });
    console.log(`restored ${chosen.name} (${result.events} event(s)) into ${config.stateDir}`);
    if (result.previousArchivedTo) console.log(`   the state it replaced was archived at ${result.previousArchivedTo}`);
    if (result.snapshotDropped) console.log("   the archive's snapshot was newer than its log and was dropped");
    if (result.sessionsDropped) console.log("   agent sessions were not carried over, so every seat starts a fresh turn");
    console.log(`\nstart it with: mesh run ${meshPath} --resume`);
    return 0;
  } finally {
    lock.release();
  }
}
