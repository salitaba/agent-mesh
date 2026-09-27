import { isDeepStrictEqual } from "util";
import type { Clock, EventId, EventType, GoalId, MeshEvent } from "../../protocol/src/index";
import { PROTOCOL_VERSION } from "../../protocol/src/index";
import type { EventStore } from "../../event-store/src/index";
import { applyEvent, ProjectionError, type ProjectionConfig } from "./projections";
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

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Map) && Object.getPrototypeOf(v) === Object.prototype;

/**
 * Put back into `live` every entry that differs between `before` and `after`
 * (two copies of one pre-state, `after` with the refused event applied), taking
 * the value from `before`. Maps are compared per key so a restore never touches
 * an entry the refused event did not; plain objects recurse; anything else is
 * restored whole. A Map entry the event deleted is re-inserted in its original
 * position -- export order is observable.
 */
function restoreTouched(live: Record<string, unknown>, before: Record<string, unknown>, after: Record<string, unknown>): void {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = before[key];
    const a = after[key];
    if (b instanceof Map && a instanceof Map && live[key] instanceof Map) {
      const l = live[key] as Map<unknown, unknown>;
      let reorder = false;
      for (const k of new Set([...b.keys(), ...a.keys()])) {
        if (b.has(k) === a.has(k) && isDeepStrictEqual(b.get(k), a.get(k))) continue;
        if (b.has(k)) {
          if (!l.has(k)) reorder = true;
          l.set(k, b.get(k));
        } else l.delete(k);
      }
      if (reorder) {
        const entries = [...l];
        const order = new Map([...b.keys()].map((k, i) => [k, i]));
        entries.sort(([x], [y]) => (order.get(x) ?? Infinity) - (order.get(y) ?? Infinity));
        l.clear();
        for (const [k, v] of entries) l.set(k, v);
      }
    } else if (isPlainObject(b) && isPlainObject(a) && isPlainObject(live[key])) {
      restoreTouched(live[key] as Record<string, unknown>, b, a);
    } else if (!isDeepStrictEqual(b, a)) {
      if (Array.isArray(b) && Array.isArray(live[key])) {
        // In place: a holder of the array keeps seeing the live one.
        (live[key] as unknown[]).splice(0, (live[key] as unknown[]).length, ...b);
      } else live[key] = b;
    }
  }
}

export interface KernelSnapshotProvider {
  write(envelope: { meshId: string; throughSeq: number; data: Record<string, unknown[]> }): Promise<void>;
  /**
   * `version` is the envelope layout the provider stored. Optional because an
   * in-process provider that hands back exactly what the kernel wrote has no
   * layout to disagree about; a provider that reads a file must carry it, or
   * the kernel cannot refuse a layout it does not understand.
   */
  read(): { version?: number; meshId: string; throughSeq: number; data: Record<string, unknown[]> } | null;
}

/**
 * The snapshot envelope layout `importState` reads. Must match what the file
 * provider stamps (`SNAPSHOT_VERSION` in persistence); core does not import
 * persistence, so the number is restated here rather than shared.
 */
export const SNAPSHOT_ENVELOPE_VERSION = 1;

export class Kernel {
  readonly state: Projections = createInitialState();
  private listeners: EventListener[] = [];
  private appliedIds = new Set<string>();
  private chain: Promise<void> = Promise.resolve();
  private audit: (msg: string) => void;
  private emitCount = 0;
  /**
   * Which turn an emit belongs to, when the caller did not say.
   *
   * Set by the supervisor to its own `activeTurnByAgent` lookup. Without it,
   * `correlationId` was passed by hand at six of a hundred-and-nine emit sites,
   * so 25 of 41 event types never carried one — including every verdict, every
   * refusal, every `agent.failed` and every `task.created`. The consequence was
   * not cosmetic: "which turn approved this artifact, and what else did that turn
   * do" was simply not answerable from the log, and three separate measurements
   * during one live watch needed a time-window heuristic because of it.
   *
   * Deliberately injected rather than read from a global, and deliberately
   * OPTIONAL: a replay must reconstruct `correlationId` from the stored envelope,
   * never from a live turn map. A replay kernel is constructed without this hook,
   * so the field it reads is the one the log recorded.
   */
  public correlate?: (actorId?: string) => string | undefined;

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
    public readonly gates?: ProjectionConfig,
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
      // An explicit id always wins: several sites correlate to a turn the actor
      // is no longer holding (the discard emit in `runTurn`'s `finally` is past
      // the map delete), and one — `auditTransition` — deliberately correlates to
      // a different party. The hook only fills the silence.
      correlationId: opts.correlationId ?? this.correlate?.(opts.actorId),
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
    this.ensureCheckpoint();
    try {
      applyEvent(this.state, event, this.gates, { live: true });
    } catch (err) {
      // A refused event must leave memory exactly where the log is. Reducers
      // are written to refuse before their first mutation, but not all of them
      // can: `review.approved` records the signature BEFORE the gate check on
      // purpose (the signature may be what satisfies the gate), so a gate
      // refusal used to leave an approval in memory that the log never
      // received -- the next replay silently dropped it. The kernel is the one
      // place that can make every reducer transactional at once.
      this.rollbackRefused(event);
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
    if (this.checkpoint) {
      this.checkpoint.journal.push(stored);
      this.checkpoint.eventCount = this.state.eventCount;
    }
    this.emitCount++;
    await this.maybeSnapshot();
    return stored;
  }

  /**
   * Keep a pre-state to roll a refused live emit back to.
   *
   * A deep clone per emit was measured and rejected: 14ms on the state a
   * 12,619-event mission leaves behind (1,004 messages), paid by every emit, and
   * growing with the mission. Refusals are rare -- four in one whole live
   * mission's `projection-rejections.log`. So the cost is moved onto them: a
   * clone every `CHECKPOINT_EVERY` live emits, plus the events applied since.
   * Replay and rebuild never take one; they are not transactional and do not
   * need to be (a log that fails to replay throws out of the whole replay).
   *
   * `eventCount` is how a checkpoint notices it went stale: anything other
   * than a live emit that applies events (rebuild, snapshot import) moves the
   * count without adding to the journal, and the next emit takes a fresh one.
   */
  private checkpoint: { base: Projections; journal: MeshEvent[]; eventCount: number } | null = null;
  private static readonly CHECKPOINT_EVERY = 256;

  private ensureCheckpoint(): void {
    const cp = this.checkpoint;
    if (cp && cp.eventCount === this.state.eventCount && cp.journal.length < Kernel.CHECKPOINT_EVERY) return;
    try {
      this.checkpoint = { base: structuredClone(this.state), journal: [], eventCount: this.state.eventCount };
    } catch (err) {
      // Something uncloneable in state (a test double, a function) must not
      // fail the emit; it only costs this emit its rollback.
      this.checkpoint = null;
      this.audit(`kernel checkpoint failed: ${(err as Error).message}`);
    }
  }

  /**
   * Undo whatever a refused reducer wrote before it threw -- and nothing else.
   *
   * The pre-state is re-derived as checkpoint + journal. It is NOT simply put
   * back wholesale, because not every write to `state` is an event: the budget
   * manager's `declare` creates ledgers directly, and a wholesale restore would
   * delete every ledger declared since the checkpoint. Instead the refused event
   * is re-run against a second copy of that pre-state, and only the entries it
   * changed there are restored here. Reducers are deterministic in the event,
   * so "what it touched there" is "what it touched here".
   */
  private rollbackRefused(event: MeshEvent): void {
    const cp = this.checkpoint;
    if (!cp || cp.eventCount !== this.state.eventCount) {
      this.audit(`no checkpoint to roll back refused ${event.type}; memory may hold its partial writes`);
      return;
    }
    try {
      const derive = (): Projections => {
        const s = structuredClone(cp.base);
        for (const e of cp.journal) applyEvent(s, e, this.gates);
        return s;
      };
      const before = derive();
      const after = derive();
      try {
        applyEvent(after, event, this.gates, { live: true });
      } catch {
        // Expected: this is the refusal being reproduced.
      }
      restoreTouched(this.state as unknown as Record<string, unknown>, before as unknown as Record<string, unknown>, after as unknown as Record<string, unknown>);
    } catch (err) {
      this.audit(`rollback of refused ${event.type} failed: ${(err as Error).message}`);
    }
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
    this.checkpoint = null;
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
          // A snapshot is a cache of the log, never a second source of truth,
          // so an ordinary boot trusts it only when it provably describes a
          // prefix of THIS log. The same guard used to exist only in
          // `restoreStateDir`, i.e. only when an operator restored an archive.
          // Checked before `importState` so a refusal leaves nothing
          // half-imported; the throw lands in the audited fallback below.
          if (snap.version !== undefined && snap.version !== SNAPSHOT_ENVELOPE_VERSION) {
            throw new Error(`snapshot version ${snap.version} is not ${SNAPSHOT_ENVELOPE_VERSION}, the only layout this build reads`);
          }
          if (snap.meshId !== this.snapshots.meshId) {
            throw new Error(`snapshot belongs to mesh '${snap.meshId}', not '${this.snapshots.meshId}'`);
          }
          const tailSeq = await this.store.lastSeq();
          if (snap.throughSeq > tailSeq) {
            // Everything past the tail is state the log no longer says happened.
            throw new Error(`snapshot runs through seq ${snap.throughSeq}, past the log tail at ${tailSeq}`);
          }
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
