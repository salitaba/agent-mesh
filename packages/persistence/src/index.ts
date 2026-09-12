import * as fs from "fs";
import * as path from "path";
import type { MeshEvent } from "../../protocol/src/index";
import type { EventStore } from "../../event-store/src/index";

export * from "./state-lock";

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
  data: {
    goals: unknown[];
    agents: unknown[];
    artifacts: unknown[];
    threads: unknown[];
    messages: unknown[];
    tasks: unknown[];
    decisions: unknown[];
    approvals: unknown[];
    escalations: unknown[];
    budgets: unknown[];
    leases: unknown[];
    memory: unknown[];
  };
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
export function archiveDir(dir: string, opts: { archiveRoot?: string; exclude?: string[] } = {}): string | null {
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved)) return null;
  const excludes = (opts.exclude ?? []).map((e) => path.resolve(e));
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
  const root = opts.archiveRoot ? path.resolve(opts.archiveRoot) : path.dirname(resolved);
  const base = path.basename(resolved);
  fs.mkdirSync(root, { recursive: true });
  let target = path.join(root, `${base}.bak-${stamp}`);
  // Two resets inside the same second must not clobber the first archive.
  let n = 1;
  while (fs.existsSync(target)) target = path.join(root, `${base}.bak-${stamp}-${n++}`);
  const move = (from: string, to: string): void => {
    try {
      fs.renameSync(from, to);
    } catch (err) {
      // Different filesystem (e.g. a state_dir on another mount): rename
      // cannot cross devices, so fall back to a copy + delete.
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      fs.cpSync(from, to, { recursive: true });
      fs.rmSync(from, { recursive: true, force: true });
    }
  };
  if (excludes.length === 0) {
    move(resolved, target);
    return target;
  }
  if (excludes.some((ex) => ex === resolved)) return null;
  const entries = fs.readdirSync(resolved).filter((name) => {
    const entry = path.join(resolved, name);
    return !excludes.some((ex) => ex === entry || ex.startsWith(entry + path.sep));
  });
  if (entries.length === 0) return null;
  fs.mkdirSync(target, { recursive: true });
  for (const name of entries) move(path.join(resolved, name), path.join(target, name));
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
export function archiveStateDir(stateDir: string, opts: { keepArtifacts?: boolean; archiveRoot?: string } = {}): StateArchiveResult {
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

export class EventTailer {
  private size = 0;
  private buffer = "";
  constructor(private store: EventStore, private pollMs = 100) {
    void this.store;
  }

  static watchFile(file: string, onLine: (event: MeshEvent) => void): fs.FSWatcher {
    const watcher = fs.watch(file, { persistent: false }, () => {
      try {
        const content = fs.readFileSync(file, "utf8");
        const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
        for (const line of lines.slice(watchOffset.get(file) ?? 0)) {
          try {
            onLine(JSON.parse(line) as MeshEvent);
          } catch {
            /* partial line */
          }
        }
        watchOffset.set(file, lines.length);
      } catch {
        /* file replaced */
      }
    });
    return watcher;
  }
}

const watchOffset = new Map<string, number>();
