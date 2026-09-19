import type { Clock, EventId, EventType, GoalId, MeshEvent } from "../../protocol/src/index";
import { PROTOCOL_VERSION } from "../../protocol/src/index";
import type { EventStore } from "../../event-store/src/index";
import { applyEvent, ProjectionError } from "./projections";
import { createInitialState, type CommitmentTtlConfig, type Projections } from "./state";

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

export interface KernelSnapshotProvider {
  write(envelope: { meshId: string; throughSeq: number; data: Record<string, unknown[]> }): Promise<void>;
  read(): { meshId: string; throughSeq: number; data: Record<string, unknown[]> } | null;
}

export class Kernel {
  readonly state: Projections = createInitialState();
  private listeners: EventListener[] = [];
  private appliedIds = new Set<string>();
  private chain: Promise<void> = Promise.resolve();
  private audit: (msg: string) => void;
  private emitCount = 0;

  constructor(
    public readonly store: EventStore,
    public readonly clock: Clock,
    audit?: (msg: string) => void,
    /**
     * Projection knobs that change what the reducer WRITES, so they have to
     * reach every `applyEvent` the kernel makes -- live and replay alike. A
     * knob the live kernel has and a replay does not is a divergence between
     * the log and the state rebuilt from it.
     */
    public readonly gates?: {
      transitionGates?: Record<string, string[]>;
      commitmentSemantic?: "compat" | "strict";
      commitmentTtl?: CommitmentTtlConfig;
    },
    private readonly snapshots?: { provider: KernelSnapshotProvider; meshId: string; every?: number },
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
    this.dispatch(stored);
    return stored as MeshEvent<T>;
  }

  /**
   * Hand the stored event to every listener, in registration order, without
   * making the emitter wait for them.
   *
   * `emit` used to `await` each listener in turn, which put every subscriber
   * on the emitting agent's critical path in series: an SSE broadcast to a
   * wedged browser, or a search-index write, delayed the next event in the
   * mission. Fan-out is notification, not part of the transaction — the
   * transaction already committed when `applyAndAppend` resolved.
   *
   * What is still guaranteed: listeners are STARTED in order, synchronously,
   * before `emit` resolves, so a synchronous listener (which is all of them
   * today) still runs to completion before the emitter continues, and no
   * listener can miss an event or see two out of order. What is no longer
   * guaranteed is that an async listener's tail has finished by then; a
   * listener that needs that ordering owns its own queue.
   */
  private dispatch(stored: MeshEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        const result = listener(stored);
        // Only a thenable has a tail to lose. Audit its rejection where it
        // lands rather than dropping it into an unhandled rejection.
        if (result && typeof (result as Promise<void>).catch === "function") {
          void (result as Promise<void>).catch((err: unknown) => {
            this.audit(`listener error on ${stored.type}: ${(err as Error).message}`);
          });
        }
      } catch (err) {
        this.audit(`listener error on ${stored.type}: ${(err as Error).message}`);
      }
    }
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
    let stored: MeshEvent;
    try {
      stored = await this.store.append(event);
    } catch (err) {
      // Append failed AFTER in-memory apply: state has diverged from the
      // durable log. Roll back by rebuilding from the store so memory never
      // claims an event that persistence does not have.
      this.audit(`store append failed for ${event.type}: ${(err as Error).message} — rolling back`);
      try {
        const events = await this.store.read();
        await this.rebuild(events);
      } catch (rbErr) {
        this.audit(`rollback failed: ${(rbErr as Error).message}`);
      }
      throw err;
    }
    this.appliedIds.add(event.id);
    // A high-water mark, not a "last seen" field. Two writers touch
    // lastEventSeq -- this line and the reducer in projections.ts -- and it is
    // the cut a snapshot restore trusts: replayFromStore reads the tail with
    // `{ sinceSeq: throughSeq }`, treating everything at or below the mark as
    // already contained in the snapshot. A lower seq overwriting a higher one
    // would strand the events in between in neither the snapshot nor the tail,
    // dropping them from every future replay with no error. So it only ever
    // moves forward.
    if (stored.seq !== undefined) this.state.lastEventSeq = Math.max(this.state.lastEventSeq, stored.seq);
    this.emitCount++;
    await this.maybeSnapshot();
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

  /**
   * Wipe projections, the dedup set, and the durable log back to a blank mesh
   * — in place, so every holder of this kernel (HTTP handlers, supervisor,
   * scheduler) keeps working against the same object.
   *
   * The stale snapshot is overwritten rather than left behind: otherwise the
   * next `replayFromStore()` would restore the mission we just deleted.
   */
  async resetToEmpty(): Promise<void> {
    await this.serialized(async () => {
      await this.store.reset?.();
      await this.rebuild([]);
      this.emitCount = 0;
      if (this.snapshots) {
        try {
          const { exportState } = await import("./state");
          const data = exportState(this.state) as unknown as Record<string, unknown[]>;
          await this.snapshots.provider.write({ meshId: this.snapshots.meshId, throughSeq: 0, data });
        } catch (err) {
          this.audit(`snapshot reset failed: ${(err as Error).message}`);
        }
      }
    });
  }

  private async maybeSnapshot(): Promise<void> {
    if (!this.snapshots) return;
    const every = this.snapshots.every ?? 200;
    if (this.emitCount % every !== 0) return;
    await this.writeSnapshot();
  }

  /**
   * Snapshot now, regardless of the every-N cadence. Called on shutdown so a
   * restart replays only what happened after the last event rather than up to
   * N events — which matters once closing a mesh is routine (a project tab)
   * instead of rare.
   *
   * Serialized against emits: a snapshot taken mid-`applyAndAppend` would
   * record projections that include an event the log has not accepted yet.
   * Best-effort like `maybeSnapshot` — teardown must never fail on it.
   */
  async forceSnapshot(): Promise<boolean> {
    if (!this.snapshots) return false;
    return this.serialized(() => this.writeSnapshot());
  }

  private async writeSnapshot(): Promise<boolean> {
    if (!this.snapshots) return false;
    try {
      const { exportState } = await import("./state");
      const data = exportState(this.state) as unknown as Record<string, unknown[]>;
      const throughSeq = this.state.lastEventSeq;
      await this.snapshots.provider.write({ meshId: this.snapshots.meshId, throughSeq, data });
      return true;
    } catch (err) {
      this.audit(`snapshot failed: ${(err as Error).message}`);
      return false;
    }
  }

  async replayFromStore(): Promise<number> {
    // Fast path: snapshot + tail replay. Falls back to full replay when no
    // snapshot exists or it fails to load.
    if (this.snapshots) {
      try {
        const snap = this.snapshots.provider.read();
        if (snap && typeof snap.throughSeq === "number") {
          const { importState } = await import("./state");
          importState(this.state, { ...((snap.data ?? {}) as object), throughSeq: snap.throughSeq } as Parameters<typeof importState>[1]);
          this.appliedIds = new Set();
          const tail = await this.store.read({ sinceSeq: snap.throughSeq });
          for (const event of tail) {
            applyEvent(this.state, event, this.gates);
            this.appliedIds.add(event.id);
          }
          // Rebuild appliedIds for pre-snapshot events to keep dedup correct.
          // Full id set would require a full scan; instead rely on seq-based
          // tail + store dedup for old ids (store.append dedups by id).
          return tail.length;
        }
      } catch (err) {
        this.audit(`snapshot restore failed, falling back to full replay: ${(err as Error).message}`);
      }
    }
    const events = await this.store.read();
    await this.rebuild(events);
    return events.length;
  }

  /**
   * Rebuild projections from the log as it now stands on disk, replacing
   * whatever this kernel was holding. Used by mission restore, where the log is
   * swapped underneath a live kernel.
   *
   * The clear is the whole point. `replayFromStore` on a cold boot imports the
   * snapshot over a state that was never populated, so it has no reason to wipe
   * first; here the kernel still holds the pre-restore mission, and importing
   * over it would leave that mission's goals and agents in the projections
   * alongside the restored ones.
   */
  async reloadFromStore(): Promise<number> {
    return this.serialized(async () => {
      await this.rebuild([]);
      this.emitCount = 0;
      return this.replayFromStore();
    });
  }

  activeGoal(): GoalId | null {
    return this.state.activeGoalId;
  }

  snapshot(): { seq: number; eventCount: number; at: string | null } {
    return { seq: this.state.lastEventSeq, eventCount: this.state.eventCount, at: this.state.lastEventAt };
  }
}
