import * as fs from "fs";
import * as path from "path";
import type { MeshEvent } from "../../protocol/src/index";
import type { EventStore } from "../../event-store/src/index";

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
  query(opts: { goalId?: string; type?: string; actorId?: string; limit?: number }): MeshEvent[];
  close(): void;
}

export function openSqliteIndex(dbFile: string): SqliteIndexLike {
  const unavailable: SqliteIndexLike = { available: false, ingest: () => undefined, query: () => [], close: () => undefined };
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
  return {
    available: true,
    ingest(events: MeshEvent[]): void {
      for (const e of events) {
        try {
          insert.run(e.seq ?? 0, e.id, e.type, e.goalId ?? null, e.actorId ?? null, e.timestamp, JSON.stringify(e.payload ?? {}));
        } catch {
          /* index failures never affect the canonical JSONL log */
        }
      }
    },
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
