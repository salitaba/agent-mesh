import * as fs from "fs";
import * as path from "path";
import type { MeshEvent } from "../../protocol/src/index";
import type { exportState } from "../../core/src/state";

export * from "./state-lock";
import { STATE_LOCK_FILENAME } from "./state-lock";

export interface SessionRecord {
  agentId: string;
  sessionId: string;
  runtime: string;
  updatedAt: string;
}

export class FileSessionRegistry {
  private file: string;
  private records = new Map<string, SessionRecord>();
  private loaded = false;

  constructor(stateDir: string) {
    this.file = path.join(stateDir, "sessions.json");
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (fs.existsSync(this.file)) {
      try {
        const list = JSON.parse(fs.readFileSync(this.file, "utf8")) as SessionRecord[];
        for (const r of list) this.records.set(r.agentId, r);
      } catch {
        /* corrupted registry simply means no restorable sessions */
      }
    }
  }

  async record(agentId: string, sessionId: string, runtime: string): Promise<void> {
    this.load();
    this.records.set(agentId, { agentId, sessionId, runtime, updatedAt: new Date().toISOString() });
    this.flush();
  }

  async lookup(agentId: string): Promise<{ sessionId: string; runtime: string } | null> {
    this.load();
    const r = this.records.get(agentId);
    return r ? { sessionId: r.sessionId, runtime: r.runtime } : null;
  }

  async forget(agentId: string): Promise<void> {
    this.load();
    this.records.delete(agentId);
    this.flush();
  }

  /**
   * Drop the in-memory cache so the next read comes from disk. Restore
   * replaces the state dir underneath this registry, and `loaded` would
   * otherwise pin it to the pre-restore file for the life of the process.
   */
  reload(): void {
    this.records = new Map();
    this.loaded = false;
  }

  private flush(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.records.values()], null, 2), "utf8");
    fs.renameSync(tmp, this.file);
  }
}

export interface SnapshotEnvelope {
  version: number;
  meshId: string;
  takenAt: string;
  throughSeq: number;
  /**
   * Exactly what `exportState` produced, rather than a second hand-written
   * list of keys.
   *
   * The list that used to stand here named twelve keys, fewer than half of
   * what the codec writes. Nothing made that wrong at compile time, so this
   * type went on describing a snapshot shape the runtime had left behind --
   * and a type that documents a lie is worse than no type, because it is read
   * as the contract.
   * Tying it to the codec means a field added to the codec arrives here for
   * free and a field dropped from it cannot go unnoticed.
   *
   * `import type` is erased, so this records a coupling that already exists in
   * fact -- a snapshot file is an `exportState` result and nothing else --
   * without giving persistence a runtime dependency on core.
   */
  data: ReturnType<typeof exportState>;
}

export class SnapshotStore {
  private file: string;
  constructor(stateDir: string, meshId: string) {
    this.file = path.join(stateDir, `snapshot-${meshId}.json`);
  }

  async write(envelope: Omit<SnapshotEnvelope, "version" | "takenAt">): Promise<void> {
    const full: SnapshotEnvelope = { version: 1, takenAt: new Date().toISOString(), ...envelope };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(full), "utf8");
    fs.renameSync(tmp, this.file);
  }

  read(): SnapshotEnvelope | null {
    if (!fs.existsSync(this.file)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8")) as SnapshotEnvelope;
    } catch {
      return null;
    }
  }
}

export interface SqliteIndexLike {
  available: boolean;
  ingest(events: MeshEvent[]): void;
  /** Force buffered events to disk. Cheap no-op when there is nothing pending. */
  flush(): void;
  query(opts: { goalId?: string; type?: string; actorId?: string; limit?: number }): MeshEvent[];
  close(): void;
}

export function openSqliteIndex(dbFile: string): SqliteIndexLike {
  const unavailable: SqliteIndexLike = { available: false, ingest: () => undefined, flush: () => undefined, query: () => [], close: () => undefined };
  let mod: { DatabaseSync: new (file: string) => any } | null = null;
  try {
    mod = require("node:sqlite");
  } catch {
    return unavailable;
  }
  if (!mod) return unavailable;
  let db: any;
  try {
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    db = new mod.DatabaseSync(dbFile);
    db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY,
        id TEXT UNIQUE,
        type TEXT,
        goal_id TEXT,
        actor_id TEXT,
        timestamp TEXT,
        payload TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_events_goal ON events(goal_id);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
      CREATE INDEX IF NOT EXISTS idx_events_actor ON events(actor_id);
    `);
  } catch {
    return unavailable;
  }
  const insert = db.prepare(
    "INSERT OR IGNORE INTO events (seq, id, type, goal_id, actor_id, timestamp, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  // Batched writes: one autocommit transaction per insert costs ~5ms (each
  // statement fsyncs). Buffering into a single transaction per batch makes
  // thousands of events cost milliseconds total. The index is best-effort
  // and rebuildable from the JSONL log, so a <1s flush delay is acceptable.
  let pending: MeshEvent[] = [];
  let timer: NodeJS.Timeout | undefined;
  const FLUSH_EVERY = 500;
  const FLUSH_AFTER_MS = 1000;
  const flush = (): void => {
    timer = undefined;
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    try {
      db.exec("BEGIN IMMEDIATE");
    } catch {
      // Could not start the transaction (locked DB, etc.): requeue so the
      // batch is retried on the next flush instead of silently dropped.
      pending = batch.concat(pending);
      return;
    }
    try {
      for (const e of batch) {
        try {
          insert.run(e.seq ?? 0, e.id, e.type, e.goalId ?? null, e.actorId ?? null, e.timestamp, JSON.stringify(e.payload ?? {}));
        } catch {
          /* one poison row must not abort the batch */
        }
      }
      db.exec("COMMIT");
    } catch {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* best-effort */
      }
      pending = batch.concat(pending);
    }
  };
  const schedule = (): void => {
    if (timer !== undefined || pending.length === 0) return;
    timer = setTimeout(flush, FLUSH_AFTER_MS);
    (timer as unknown as { unref?: () => void }).unref?.();
  };
  const ingestLoop = (events: MeshEvent[]): void => {
    // Plain loop, no argument spread: ingesting a whole boot log in one call
    // would throw RangeError on large arrays. Flush in chunks so a huge
    // backlog never sits entirely in memory either.
    for (const e of events) {
      pending.push(e);
      if (pending.length >= FLUSH_EVERY) {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        flush();
      }
    }
    schedule();
  };
  return {
    available: true,
    ingest: ingestLoop,
    flush,
    query(opts): MeshEvent[] {
      const where: string[] = [];
      const args: unknown[] = [];
      if (opts.goalId) {
        where.push("goal_id = ?");
        args.push(opts.goalId);
      }
      if (opts.type) {
        where.push("type = ?");
        args.push(opts.type);
      }
      if (opts.actorId) {
        where.push("actor_id = ?");
        args.push(opts.actorId);
      }
      const limit = opts.limit ?? 500;
      const rows = db
        .prepare(`SELECT * FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq DESC LIMIT ?`)
        .all(...args, limit) as Array<Record<string, unknown>>;
      return rows
        .reverse()
        .map((r) => ({
          id: String(r.id),
          seq: Number(r.seq),
          type: String(r.type),
          timestamp: String(r.timestamp),
          goalId: r.goal_id ? String(r.goal_id) : undefined,
          actorId: r.actor_id ? String(r.actor_id) : undefined,
          payload: JSON.parse(String(r.payload ?? "{}")),
        })) as unknown as MeshEvent[];
    },
    close(): void {
      try {
        flush();
      } catch {
        /* ignore */
      }
      try {
        db.close();
      } catch {
        /* ignore */
      }
    },
  };
}
export function ensureStateLayout(stateDir: string): { events: string; artifacts: string; logs: string } {
  const dirs = {
    events: path.join(stateDir, "events"),
    artifacts: path.join(stateDir, "artifacts"),
    logs: path.join(stateDir, "logs"),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  return dirs;
}

export interface StateArchiveResult {
  /** Absolute path of the archived copy, or null when there was nothing to archive. */
  archivedTo: string | null;
  /** Layout of the freshly recreated (empty) state dir. */
  layout: { events: string; artifacts: string; logs: string };
}

export interface ArchiveOptions {
  /** Parent directory for the archive. Defaults to the directory's own parent. */
  archiveRoot?: string;
  /** Keep these subtrees in place — see `archiveDir` for the exact semantics. */
  exclude?: string[];
  /**
   * Reuse a stamp another archive of the same operation already used, so one
   * reset reads as one set of backups. Defaults to the current time.
   */
  stamp?: string;
}

/**
 * Timestamp used in archive names: `YYYYMMDD-HHMMSS`, second resolution in UTC.
 * Shared so a single operation can stamp every archive it produces alike.
 */
export function archiveStamp(now: Date = new Date()): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
}

/**
 * Where a mesh's archives live: side by side under the config dir, never inside
 * the agent workspace — the next run's agents must not be able to read the
 * previous mission out of their working tree.
 */
export function meshArchiveRoot(configDir: string, meshId: string): string {
  return path.join(path.resolve(configDir), ".mesh-backups", meshId);
}

/**
 * Resolve the archive path for `dir`, adding a `-1`, `-2`, ... suffix while it
 * is taken. Two resets inside the same second must not clobber the first.
 */
function nextArchivePath(dir: string, opts: ArchiveOptions): string {
  const resolved = path.resolve(dir);
  const stamp = opts.stamp ?? archiveStamp();
  const root = opts.archiveRoot ? path.resolve(opts.archiveRoot) : path.dirname(resolved);
  const base = path.basename(resolved);
  fs.mkdirSync(root, { recursive: true });
  let target = path.join(root, `${base}.bak-${stamp}`);
  let n = 1;
  while (fs.existsSync(target)) target = path.join(root, `${base}.bak-${stamp}-${n++}`);
  return target;
}

/** Move a file or directory, falling back to copy + delete across devices. */
function transfer(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    // Different filesystem (e.g. a state_dir on another mount): rename
    // cannot cross devices, so fall back to a copy + delete.
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

/**
 * Top-level entries of `dir` that survive `excludes`, or null when an exclusion
 * IS `dir` itself and there is therefore nothing to archive.
 */
function survivingEntries(dir: string, excludes: string[]): string[] | null {
  if (excludes.some((ex) => ex === dir)) return null;
  return fs.readdirSync(dir).filter((name) => {
    const entry = path.join(dir, name);
    return !excludes.some((ex) => ex === entry || ex.startsWith(entry + path.sep));
  });
}

/**
 * Move `dir` to a timestamped archive path: `<archiveRoot>/<name>.bak-<stamp>`
 * when `archiveRoot` is given, otherwise beside the directory. The rename is
 * atomic on the same filesystem; across devices (EXDEV) it falls back to a
 * copy + delete. Returns the archive path, or null when `dir` does not exist.
 *
 * `exclude` keeps a subtree in place (the live state dir inside a non-git
 * workspace, for example). With exclusions the move is per top-level entry,
 * not atomic, and an entry that merely *contains* an exclusion is skipped
 * whole; an exclusion that IS `dir` archives nothing. Returns null when
 * nothing survived the exclusions.
 */
export function archiveDir(dir: string, opts: ArchiveOptions = {}): string | null {
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved)) return null;
  const excludes = (opts.exclude ?? []).map((e) => path.resolve(e));
  const target = nextArchivePath(resolved, opts);
  if (excludes.length === 0) {
    transfer(resolved, target);
    return target;
  }
  const entries = survivingEntries(resolved, excludes);
  if (entries === null || entries.length === 0) return null;
  fs.mkdirSync(target, { recursive: true });
  for (const name of entries) transfer(path.join(resolved, name), path.join(target, name));
  return target;
}

/**
 * Copy `dir` to a timestamped archive path, leaving the original in place.
 *
 * The counterpart to `archiveDir` for things that must survive the operation
 * that archives them: agent worktrees are removed milliseconds later by
 * `removeAllWorktrees`, which would leave the archive empty if this moved.
 * The copy is per top-level entry — same `exclude` semantics as `archiveDir`,
 * same non-atomicity — and the source is never modified, so a repeated call is
 * safe.
 *
 * Async on purpose. `fs.cpSync` blocks the event loop for as long as the copy
 * runs, and a reset copies every agent worktree: a 300MB one wedges the child
 * for ~18s. The child's 2s heartbeat cannot fire while it is blocked, so the
 * host watchdog (`HEARTBEAT_TIMEOUT_MS`, 15s) read the silence as a wedged
 * child, stopped it, and — SIGTERM being unrunnable on a blocked loop — SIGKILLed
 * it mid-copy. The reset died right here, leaving a half-written worktree
 * archive, no branch bundle, and a state dir that was never wiped, so the
 * mission came back on the next boot. Awaiting per entry keeps the heartbeat
 * flowing for the whole archive.
 */
export async function copyDir(dir: string, opts: ArchiveOptions = {}): Promise<string | null> {
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved)) return null;
  const excludes = (opts.exclude ?? []).map((e) => path.resolve(e));
  const entries = excludes.length === 0 ? fs.readdirSync(resolved) : survivingEntries(resolved, excludes);
  if (entries === null || entries.length === 0) return null;
  const target = nextArchivePath(resolved, opts);
  fs.mkdirSync(target, { recursive: true });
  for (const name of entries) {
    await fs.promises.cp(path.join(resolved, name), path.join(target, name), { recursive: true });
  }
  return target;
}

/**
 * Archive-then-wipe of a mesh state directory.
 *
 * Renames `<stateDir>` to `<archiveRoot>/<name>.bak-<timestamp>` and recreates
 * an empty layout in its place. When `archiveRoot` is given (mission reset
 * passes `<config dir>/.mesh-backups/<meshId>`) the archive lives OUTSIDE the
 * agent workspace, so the next run's agents cannot read the previous mission
 * from their working tree. Without `archiveRoot` the archive lands next to the
 * state dir (`<stateDir>.bak-<timestamp>`).
 * Rename is atomic on the same filesystem, so there is never a window where
 * the mesh sees a half-deleted state dir — and the previous mission stays
 * fully recoverable on disk.
 *
 * Callers MUST close any open handles into `stateDir` (JSONL store, sqlite
 * index) before calling and reopen after: on Windows an open handle blocks
 * the rename, and on POSIX the handle would keep writing into the archived inode.
 */
export function archiveStateDir(
  stateDir: string,
  opts: { keepArtifacts?: boolean } & ArchiveOptions = {},
): StateArchiveResult {
  const resolved = path.resolve(stateDir);
  const archivedTo = archiveDir(resolved, opts);
  const layout = ensureStateLayout(resolved);
  // Opt-in carry-over: produced documents survive the reset even though the
  // event log that referenced them does not. Copy (not move) so the archive
  // stays a complete snapshot of the previous mission.
  if (opts.keepArtifacts && archivedTo) {
    const from = path.join(archivedTo, "artifacts");
    if (fs.existsSync(from)) fs.cpSync(from, layout.artifacts, { recursive: true });
  }
  return { archivedTo, layout };
}

export type MeshArchiveKind = "state" | "product" | "worktrees" | "bundle" | "other";

export interface MeshArchiveEntry {
  /** The stamp shared by every archive the reset that produced this one wrote. */
  stamp: string;
  kind: MeshArchiveKind;
  /** Name as it sits on disk, suffix and collision number included. */
  name: string;
  path: string;
  /** Recursive size in bytes. A bundle is a file, so this is its length. */
  bytes: number;
  mtime: string;
  /**
   * Whether the archive carries a readable event log, i.e. whether it can be
   * restored to. Only `kind: "state"` archives ever do.
   */
  hasEvents: boolean;
}

const ARCHIVE_NAME = /^(.+?)\.bak-(\d{8}-\d{6})(?:-\d+)?$/;

function dirSize(target: string): number {
  let total = 0;
  const walk = (p: string): void => {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      for (const entry of fs.readdirSync(p)) walk(path.join(p, entry));
      return;
    }
    total += st.size;
  };
  walk(target);
  return total;
}

/**
 * Every archive under `archiveRoot`, newest first.
 *
 * `kind` is read from the name because that is what a reset controls, with the
 * state archive confirmed structurally instead: the state dir's own name is
 * configurable, so `logs/events.jsonl` is the only thing that can be trusted to
 * identify one. Anything unrecognised is `"other"` rather than an error — a
 * directory full of archives is not the place to fail hard.
 */
export function listArchives(archiveRoot: string): MeshArchiveEntry[] {
  const root = path.resolve(archiveRoot);
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const entries: MeshArchiveEntry[] = [];
  for (const name of names) {
    const match = ARCHIVE_NAME.exec(name);
    if (!match) continue;
    const target = path.join(root, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(target);
    } catch {
      continue;
    }
    const hasEvents = st.isDirectory() && fs.existsSync(path.join(target, "logs", "events.jsonl"));
    const base = match[1];
    const kind: MeshArchiveKind = name.endsWith(".bundle")
      ? "bundle"
      : hasEvents
        ? "state"
        : base.startsWith("worktrees")
          ? "worktrees"
          : base.startsWith("main")
            ? "product"
            : "other";
    entries.push({
      stamp: match[2],
      kind,
      name,
      path: target,
      bytes: st.isDirectory() ? dirSize(target) : st.size,
      mtime: st.mtime.toISOString(),
      hasEvents,
    });
  }
  // Stamp is the operation identity, so sort on it rather than mtime: the
  // archives of one reset are written seconds apart but belong together.
  return entries.sort((a, b) => (a.stamp === b.stamp ? a.name.localeCompare(b.name) : a.stamp < b.stamp ? 1 : -1));
}

/**
 * The `seq` of the last complete event in a JSONL log, or null when the log is
 * missing, empty, or has no parseable line.
 *
 * Reads only a tail window rather than the whole file: the log is the largest
 * thing in a state dir and this exists to answer one question about its end.
 * Both edges of the window can cut a line, so it walks backwards and returns
 * the first line that parses with a numeric `seq` — which also makes it
 * tolerant of a torn final append, the same failure the store repairs on load.
 */
export function readLogTailSeq(logFile: string): number | null {
  let fd: number;
  try {
    fd = fs.openSync(logFile, "r");
  } catch {
    return null;
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return null;
    const window = Math.min(size, 64 * 1024);
    const buf = Buffer.allocUnsafe(window);
    fs.readSync(fd, buf, 0, window, size - window);
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.length === 0) continue;
      try {
        const seq = (JSON.parse(line) as { seq?: unknown }).seq;
        if (typeof seq === "number") return seq;
      } catch {
        /* a window edge cut this line, or a torn final write */
      }
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

/** Newline count — each event is written as one terminated line. */
function countLogEvents(logFile: string): number {
  let fd: number;
  try {
    fd = fs.openSync(logFile, "r");
  } catch {
    return 0;
  }
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let read = 0;
    let count = 0;
    while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      for (let i = 0; i < read; i++) if (buf[i] === 0x0a) count++;
    }
    return count;
  } finally {
    fs.closeSync(fd);
  }
}

export interface RestoreStateResult {
  /** Where the pre-restore state was moved, null when there was none to move. */
  previousArchivedTo: string | null;
  /**
   * True when the archive's snapshot claimed to be newer than its log and was
   * dropped — see `restoreStateDir`.
   */
  snapshotDropped: boolean;
  /** Events in the restored log. */
  events: number;
  /** True when `sessions.json` was left behind rather than restored. */
  sessionsDropped: boolean;
}

/**
 * Replace the state dir at `to` with a copy of the state archive at `from`.
 *
 * Three properties this is built around:
 *
 * 1. **Reversible.** The current state dir is archived first, to `archiveRoot`
 *    under the same stamp as the rest of the operation, so restoring the wrong
 *    archive is itself undoable.
 * 2. **Repeatable.** The archive is COPIED, never moved, so the same stamp can
 *    be restored twice and a failed restore leaves the archive intact.
 * 3. **Not poisoned by its own fast path.** `Kernel.replayFromStore` trusts a
 *    snapshot's `throughSeq` and fast-forwards from it without checking the log,
 *    so a snapshot from a later mission would resurrect goals the restored log
 *    never mentions. Any snapshot newer than the restored log's tail is dropped
 *    rather than restored into a kernel that will believe it.
 *
 * `sessions.json` is dropped by default: the session ids in it point at
 * runtimes on the other side of a reset, and `FileSessionRegistry` caches what
 * it loads, so a stale one fails mid-turn rather than at boot. The sqlite index
 * is never carried over at all — replay rebuilds it, and a stale index would
 * double-count.
 *
 * The caller must hold no open handles into `to` (JSONL store, sqlite index)
 * and must refresh its state lock afterwards: the lock file travels with the
 * archived dir, so the copy can land a foreign one in its place.
 */
export function restoreStateDir(
  from: string,
  to: string,
  opts: { archiveRoot?: string; stamp?: string; keepSessions?: boolean } = {},
): RestoreStateResult {
  const source = path.resolve(from);
  const target = path.resolve(to);
  if (!fs.existsSync(path.join(source, "logs", "events.jsonl"))) {
    throw new Error(`not a restorable state archive (no logs/events.jsonl): ${source}`);
  }
  const previousArchivedTo = fs.existsSync(target) ? archiveDir(target, { archiveRoot: opts.archiveRoot, stamp: opts.stamp }) : null;
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(source, target, { recursive: true });

  // The lock file names the process that held the dir when the archive was
  // taken — dead, or a different mesh entirely. The caller rewrites it; a
  // stale one must not survive even if it forgets to.
  fs.rmSync(path.join(target, STATE_LOCK_FILENAME), { force: true });
  // Rebuilt by replay. Restoring it would index the pre-restore log alongside
  // the restored one.
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(path.join(target, "events", `events-index.sqlite${suffix}`), { force: true });
  }

  const logFile = path.join(target, "logs", "events.jsonl");
  const tail = readLogTailSeq(logFile);
  let snapshotDropped = false;
  for (const name of fs.readdirSync(target)) {
    if (!/^snapshot-.*\.json$/.test(name)) continue;
    const file = path.join(target, name);
    let throughSeq: number | null = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { throughSeq?: unknown };
      throughSeq = typeof parsed.throughSeq === "number" ? parsed.throughSeq : null;
    } catch {
      throughSeq = null;
    }
    // An unreadable snapshot is as dangerous as a stale one: `replayFromStore`
    // falls back to a full replay on a parse error, but leaving it in place
    // means the next boot retries a file that is known to be broken.
    if (throughSeq === null || tail === null || throughSeq > tail) {
      fs.rmSync(file, { force: true });
      snapshotDropped = true;
    }
  }

  const sessionsFile = path.join(target, "sessions.json");
  const sessionsDropped = opts.keepSessions !== true && fs.existsSync(sessionsFile);
  if (sessionsDropped) fs.rmSync(sessionsFile, { force: true });

  return { previousArchivedTo, snapshotDropped, events: countLogEvents(logFile), sessionsDropped };
}
