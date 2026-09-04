import * as fs from "fs";
import * as path from "path";
import type { EventId, EventType, GoalId, MeshEvent } from "../../protocol/src/index";
import { validateEvent } from "../../protocol/src/index";

export interface EventQuery {
  goalId?: GoalId;
  types?: EventType[];
  actorId?: string;
  sinceSeq?: number;
  limit?: number;
}

export interface EventStore {
  append(event: MeshEvent): Promise<MeshEvent>;
  read(query?: EventQuery): Promise<MeshEvent[]>;
  lastSeq(): Promise<number>;
}

export class MemoryEventStore implements EventStore {
  private events: MeshEvent[] = [];
  private byId = new Map<EventId, MeshEvent>();
  private seq = 0;

  async append(event: MeshEvent): Promise<MeshEvent> {
    if (this.byId.has(event.id)) return this.byId.get(event.id)!;
    const stored: MeshEvent = { ...event, seq: ++this.seq };
    this.events.push(stored);
    this.byId.set(stored.id, stored);
    return stored;
  }

  async read(query: EventQuery = {}): Promise<MeshEvent[]> {
    let out = this.events;
    if (query.goalId) out = out.filter((e) => e.goalId === query.goalId);
    if (query.types) out = out.filter((e) => query.types!.includes(e.type));
    if (query.actorId) out = out.filter((e) => e.actorId === query.actorId);
    if (query.sinceSeq !== undefined) out = out.filter((e) => (e.seq ?? 0) > query.sinceSeq!);
    if (query.limit) out = out.slice(0, query.limit);
    return out.map((e) => ({ ...e }));
  }

  async lastSeq(): Promise<number> {
    return this.seq;
  }
}

export class JsonlEventStore implements EventStore {
  private filePath: string;
  private cache: MeshEvent[] = [];
  private byId = new Map<EventId, MeshEvent>();
  private seq = 0;
  private fd: number | null = null;
  private loaded = false;

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
    }
  }

  async append(event: MeshEvent): Promise<MeshEvent> {
    this.load();
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
    const line = JSON.stringify(stored) + "\n";
    fs.appendFileSync(this.filePath, line, "utf8");
    this.cache.push(stored);
    this.byId.set(stored.id, stored);
    return stored;
  }

  async read(query: EventQuery = {}): Promise<MeshEvent[]> {
    this.load();
    let out = this.cache;
    if (query.goalId) out = out.filter((e) => e.goalId === query.goalId);
    if (query.types) out = out.filter((e) => query.types!.includes(e.type));
    if (query.actorId) out = out.filter((e) => e.actorId === query.actorId);
    if (query.sinceSeq !== undefined) out = out.filter((e) => (e.seq ?? 0) > query.sinceSeq!);
    if (query.limit) out = out.slice(0, query.limit);
    return out.map((e) => ({ ...e }));
  }

  async lastSeq(): Promise<number> {
    this.load();
    return this.seq;
  }

  path(): string {
    return this.filePath;
  }
}

export async function* streamReplay(store: EventStore, query: EventQuery = {}): AsyncGenerator<MeshEvent> {
  const events = await store.read(query);
  for (const evt of events) yield evt;
}
