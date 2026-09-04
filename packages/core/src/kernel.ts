import type { Clock, EventId, EventType, GoalId, MeshEvent } from "../../protocol/src/index";
import { PROTOCOL_VERSION } from "../../protocol/src/index";
import type { EventStore } from "../../event-store/src/index";
import { applyEvent, ProjectionError } from "./projections";
import { createInitialState, type Projections } from "./state";

export type EventListener = (event: MeshEvent) => void | Promise<void>;

export interface EmitOptions {
  actorId?: string;
  goalId?: GoalId;
  causationId?: EventId;
  correlationId?: string;
  id?: EventId;
  timestamp?: string;
}

export class KernelRejectedError extends ProjectionError {}

export class Kernel {
  readonly state: Projections = createInitialState();
  private listeners: EventListener[] = [];
  private appliedIds = new Set<string>();
  private chain: Promise<void> = Promise.resolve();
  private audit: (msg: string) => void;

  constructor(
    public readonly store: EventStore,
    public readonly clock: Clock,
    audit?: (msg: string) => void,
    public readonly gates?: { transitionGates: Record<string, string[]> },
  ) {
    this.audit = audit ?? (() => {});
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  async emit<T>(type: EventType, payload: T, opts: EmitOptions = {}): Promise<MeshEvent<T>> {
    const event: MeshEvent<T> = {
      id: opts.id ?? `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      protocolVersion: PROTOCOL_VERSION,
      type,
      timestamp: opts.timestamp ?? this.clock.iso(),
      goalId: opts.goalId ?? this.state.activeGoalId ?? undefined,
      actorId: opts.actorId,
      causationId: opts.causationId,
      correlationId: opts.correlationId,
      payload,
    };
    if (this.appliedIds.has(event.id)) {
      return event;
    }
    const stored = await this.serialized(() => this.applyAndAppend(event));
    for (const listener of [...this.listeners]) {
      try {
        await listener(stored);
      } catch (err) {
        this.audit(`listener error on ${stored.type}: ${(err as Error).message}`);
      }
    }
    return stored as MeshEvent<T>;
  }

  private async applyAndAppend(event: MeshEvent): Promise<MeshEvent> {
    try {
      applyEvent(this.state, event, this.gates);
    } catch (err) {
      if (err instanceof ProjectionError) {
        this.audit(`projection rejected ${event.type}: ${err.message}`);
        throw new KernelRejectedError(err.message, event.type);
      }
      throw err;
    }
    const stored = await this.store.append(event);
    this.appliedIds.add(event.id);
    if (stored.seq !== undefined) this.state.lastEventSeq = stored.seq;
    return stored;
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const run = this.chain.then(async () => {
      try {
        return await task();
      } finally {
        release();
      }
    });
    this.chain = this.chain.then(() => gate);
    return run;
  }

  async rebuild(events: Iterable<MeshEvent>): Promise<void> {
    const fresh = createInitialState();
    Object.assign(this.state, fresh);
    this.appliedIds = new Set();
    for (const event of events) {
      applyEvent(this.state, event, this.gates);
      this.appliedIds.add(event.id);
    }
  }

  async replayFromStore(): Promise<number> {
    const events = await this.store.read();
    await this.rebuild(events);
    return events.length;
  }

  activeGoal(): GoalId | null {
    return this.state.activeGoalId;
  }

  snapshot(): { seq: number; eventCount: number; at: string | null } {
    return { seq: this.state.lastEventSeq, eventCount: this.state.eventCount, at: this.state.lastEventAt };
  }
}
