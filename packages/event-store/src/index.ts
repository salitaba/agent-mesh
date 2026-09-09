import * as fs from "fs";
import * as path from "path";
import type { EventId, EventType, GoalId, MeshEvent } from "../../protocol/src/index";
import { validateEvent } from "../../protocol/src/index";

export interface EventQuery {
  goalId?: GoalId;
  types?: EventType[];
  actorId?: string;
  /** Exact match on the turn/step correlation id (indexed; for trace views). */
  correlationId?: string;
  sinceSeq?: number;
  /** Head cap: first N matches in log order (for replay-style catch-up). */
  limit?: number;
  /**
   * Tail cap: most recent N matches in log order. Preferred for live views —
   * `limit` alone returns the OLDEST matches, which is stale data on big logs.
   * When both are set, `tail` wins.
   */
  tail?: number;
}

export interface EventStore {
  append(event: MeshEvent): Promise<MeshEvent>;
  read(query?: EventQuery): Promise<MeshEvent[]>;
  lastSeq(): Promise<number>;
  /** Release held resources (open file handles). No-op when there are none. */
  close?(): Promise<void> | void;
  /**
   * Drop every event and restart the sequence at zero, keeping object
   * identity. Identity matters: `Kernel.store` is readonly and the supervisor
   * holds its own reference, so a mission reset cannot swap in a new store —
   * it has to empty this one.
   */
  reset?(): Promise<void> | void;
}

function applyEventQuery(out: MeshEvent[], query: EventQuery): MeshEvent[] {
  if (query.correlationId !== undefined) out = out.filter((e) => e.correlationId === query.correlationId);
  if (query.goalId) out = out.filter((e) => e.goalId === query.goalId);
  if (query.types) out = out.filter((e) => query.types!.includes(e.type));
  if (query.actorId) out = out.filter((e) => e.actorId === query.actorId);
  if (query.sinceSeq !== undefined) out = out.filter((e) => (e.seq ?? 0) > query.sinceSeq!);
  if (query.tail !== undefined) out = query.tail > 0 ? out.slice(-query.tail) : [];
  else if (query.limit) out = out.slice(0, query.limit);
  return out;
}

export class MemoryEventStore implements EventStore {
  private events: MeshEvent[] = [];
  private byId = new Map<EventId, MeshEvent>();
  private byCorrelation = new Map<string, MeshEvent[]>();
  private seq = 0;

  async append(event: MeshEvent): Promise<MeshEvent> {
    if (this.byId.has(event.id)) return this.byId.get(event.id)!;
    const stored: MeshEvent = { ...event, seq: ++this.seq };
    this.events.push(stored);
    this.byId.set(stored.id, stored);
    if (stored.correlationId) {
      const list = this.byCorrelation.get(stored.correlationId);
      if (list) list.push(stored);
      else this.byCorrelation.set(stored.correlationId, [stored]);
    }
    return stored;
  }

  async read(query: EventQuery = {}): Promise<MeshEvent[]> {
    // Indexed fast path: a single turn's trace without scanning the log.
    if (query.correlationId !== undefined && query.goalId === undefined && query.types === undefined && query.actorId === undefined && query.sinceSeq === undefined) {
      const matches = this.byCorrelation.get(query.correlationId) ?? [];
      const out = query.tail !== undefined ? (query.tail > 0 ? matches.slice(-query.tail) : []) : query.limit ? matches.slice(0, query.limit) : matches.slice();
      return out.map((e) => ({ ...e }));
    }
    return applyEventQuery(this.events, query).map((e) => ({ ...e }));
  }

  close(): void {
    /* nothing held */
  }

  reset(): void {
    this.events = [];
    this.byId = new Map();
    this.byCorrelation = new Map();
    this.seq = 0;
  }

  async lastSeq(): Promise<number> {
    return this.seq;
  }
}

export class JsonlEventStore implements EventStore {
  private filePath: string;
  private cache: MeshEvent[] = [];
  private byId = new Map<EventId, MeshEvent>();
  private byCorrelation = new Map<string, MeshEvent[]>();
  private seq = 0;
  private loaded = false;
  /**
   * Ordered async durability queue. Visibility rule: appends update the
   * in-memory cache synchronously (reads never wait for disk) and the file
   * write follows in order. Previously every emit paid open+write+close
   * syscalls on the event loop; under burst load (deliveries, budget churn)
   * disk latency stalled HTTP directly. Crash window is bounded by the fsync
   * cadence below; close() always flushes fully.
   */
  private writeChain: Promise<void> = Promise.resolve();
  private handle: fs.promises.FileHandle | null = null;
  private handlePromise: Promise<fs.promises.FileHandle> | null = null;
  private writeError: unknown = null;
  private sinceSync = 0;
  private static readonly SYNC_EVERY = 50;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!fs.existsSync(this.filePath)) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, "", "utf8");
    }
    const lines = fs.readFileSync(this.filePath, "utf8").split(/\r?\n/).filter((l) => l.trim().length > 0);
    for (const line of lines) {
      let evt: MeshEvent;
      try {
        evt = JSON.parse(line) as MeshEvent;
      } catch {
        continue;
      }
      if (this.byId.has(evt.id)) continue;
      this.seq = Math.max(this.seq, evt.seq ?? 0);
      if (evt.seq === undefined) evt = { ...evt, seq: ++this.seq };
      this.cache.push(evt);
      this.byId.set(evt.id, evt);
      if (evt.correlationId) {
        const list = this.byCorrelation.get(evt.correlationId);
        if (list) list.push(evt);
        else this.byCorrelation.set(evt.correlationId, [evt]);
      }
    }
  }

  async append(event: MeshEvent): Promise<MeshEvent> {
    this.load();
    // A failed disk write poisons the queue: fail fast on later appends
    // rather than silently diverging memory from the log.
    if (this.writeError) throw this.writeError;
    const dup = this.byId.get(event.id);
    if (dup) return dup;
    const stored: MeshEvent = { ...event, seq: ++this.seq };
    const validation = validateEvent(stored);
    if (!validation.valid) {
      throw new Error(
        `Event rejected by canonical schema (${stored.type}): ` +
          validation.errors.map((e) => `${e.path} ${e.message}`).join("; "),
      );
    }
    // Visible to readers immediately; the file write follows in order.
    this.cache.push(stored);
    this.byId.set(stored.id, stored);
    if (stored.correlationId) {
      const list = this.byCorrelation.get(stored.correlationId);
      if (list) list.push(stored);
      else this.byCorrelation.set(stored.correlationId, [stored]);
    }
    const line = JSON.stringify(stored) + "\n";
    this.sinceSync++;
    const needSync = this.sinceSync >= JsonlEventStore.SYNC_EVERY;
    if (needSync) this.sinceSync = 0;
    this.writeChain = this.writeChain
      .then(async () => {
        const h = await this.openHandle();
        await h.appendFile(line, "utf8");
        if (needSync) await h.sync();
      })
      .catch((err) => {
        this.writeError = this.writeError ?? err;
      });
    return stored;
  }

  /** Lazily opened, append-mode handle shared by all queued writes. */
  private openHandle(): Promise<fs.promises.FileHandle> {
    if (this.handle) return Promise.resolve(this.handle);
    if (!this.handlePromise) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      this.handlePromise = fs.promises.open(this.filePath, "a").then(
        (h) => {
          this.handle = h;
          return h;
        },
        (err) => {
          this.handlePromise = null;
          throw err;
        },
      );
    }
    return this.handlePromise;
  }

  async read(query: EventQuery = {}): Promise<MeshEvent[]> {
    this.load();
    // Indexed fast path: a single turn's trace without scanning the log.
    if (query.correlationId !== undefined && query.goalId === undefined && query.types === undefined && query.actorId === undefined && query.sinceSeq === undefined) {
      const matches = this.byCorrelation.get(query.correlationId) ?? [];
      const out = query.tail !== undefined ? (query.tail > 0 ? matches.slice(-query.tail) : []) : query.limit ? matches.slice(0, query.limit) : matches.slice();
      return out.map((e) => ({ ...e }));
    }
    return applyEventQuery(this.cache, query).map((e) => ({ ...e }));
  }

  async lastSeq(): Promise<number> {
    this.load();
    return this.seq;
  }

  async close(): Promise<void> {
    // Drain the durability queue first: everything appended before close()
    // must reach the file, then fsync for a crash-consistent tail.
    await this.writeChain.catch(() => undefined);
    const h = this.handle;
    this.handle = null;
    this.handlePromise = null;
    if (h) {
      try {
        await h.sync();
      } catch {
        /* best-effort durability */
      }
      try {
        await h.close();
      } catch {
        /* already closed */
      }
    }
    // Delivery failures already surface fail-fast at append time; close stays
    // best-effort so teardown (often in finally blocks) never masks results.
    this.writeError = null;
  }

  /**
   * Empty the log in place: drain + close the append handle, truncate the
   * file, and clear every in-memory index. The next append reopens lazily.
   *
   * Truncate rather than unlink so an external tail/watcher keeps a valid fd,
   * and so a state dir that was archived out from under us is recreated here.
   */
  async reset(): Promise<void> {
    await this.close();
    this.cache = [];
    this.byId = new Map();
    this.byCorrelation = new Map();
    this.seq = 0;
    this.sinceSync = 0;
    this.writeChain = Promise.resolve();
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, "", "utf8");
    // Stay "loaded": the file is known-empty, so re-reading it would be a
    // pointless syscall on every subsequent append.
    this.loaded = true;
  }

  path(): string {
    return this.filePath;
  }
}

export async function* streamReplay(store: EventStore, query: EventQuery = {}): AsyncGenerator<MeshEvent> {
  const events = await store.read(query);
  for (const evt of events) yield evt;
}
