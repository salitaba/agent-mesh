/**
 * Fan-in / fan-out for a multi-project host.
 *
 * A child mesh keeps its own `SseHub` and knows nothing about any of this. The
 * host holds **one** server-side subscription per open child and multiplexes
 * every browser onto it, tagging each frame with the project it came from.
 *
 * Three decisions shape the file:
 *
 *   1. Subscriptions are keyed to *open projects*, not to browsers. Ingestion
 *      therefore keeps running across a browser reconnect, which is what makes
 *      "open a project, reconnect with the full set" lossless: the frames
 *      produced during the gap are already in this process.
 *   2. Sequence numbers stay per project. There is no global seq to invent,
 *      because each child owns an independent append-only log — a synthetic
 *      global counter would not survive a host restart and could not be used to
 *      resume against the children that actually hold the data.
 *   3. A slow browser is bounded, never buffered without limit. Its queue is
 *      capped and overflow collapses to a resync signal carrying the last seq
 *      it actually received. Losing frames to a client that can reconstruct
 *      them from the log is strictly better than letting one stalled socket
 *      hold the host's ingestion from every child.
 */
import type { MeshEvent } from "../../protocol/src/index";

/** One kernel event, tagged with the project whose log it belongs to. */
export interface MultiplexFrame {
  projectId: string;
  seq: number;
  event: MeshEvent;
}

/** Why a client is being told to refetch instead of being sent the frames. */
export type ResyncReason = "overflow" | "gap" | "upstream-closed";

export interface ResyncSignal {
  reason: ResyncReason;
  /** Set for a single-project signal (`gap`, `upstream-closed`). */
  projectId?: string;
  /** The last seq the client is known to hold for `projectId`. */
  seq?: number;
  /** Per-project cursors, for a client-wide signal (`overflow`). */
  cursors?: Record<string, number>;
  /** Frames discarded rather than queued. */
  dropped?: number;
}

/**
 * The browser side of one connection.
 *
 * `write` returning `false` (the `http.ServerResponse` contract) is the only
 * backpressure signal there is, so it is part of the seam rather than the
 * `void` of `SseClient` — a hub that could not see a full socket buffer could
 * not bound anything.
 */
export interface MultiplexSocket {
  write(chunk: string): boolean;
  end(): void;
  once(event: "drain", listener: () => void): unknown;
}

/** Where a child subscription delivers what it reads. */
export interface UpstreamSink {
  /** A kernel event, seq included. Recorded for resume. */
  event(event: MeshEvent): void;
  /** An out-of-band live frame (`turn.token`, …): no seq, never replayed. */
  stream(type: string, data: unknown): void;
  /** The subscription ended. The hub reopens on the next `follow`. */
  closed(error?: Error): void;
}

export interface UpstreamHandle {
  close(): void;
}

/**
 * Opens the host's subscription against one child. Injected so the hub stays a
 * pure fan-out: `packages/observability` has no business knowing that a project
 * is a child process reachable over loopback with a bearer token.
 */
export type OpenUpstream = (projectId: string, sinceSeq: number, sink: UpstreamSink) => UpstreamHandle | Promise<UpstreamHandle>;

export interface MultiplexHubOptions {
  openUpstream: OpenUpstream;
  /** Frames a single browser may fall behind by before it is resynced. */
  maxQueue?: number;
  /** Per-project replay ring, sized to cover a reconnect, not a session. */
  historyPerProject?: number;
  heartbeatMs?: number;
  onError?: (projectId: string, error: Error) => void;
}

const DEFAULT_MAX_QUEUE = 512;
const DEFAULT_HISTORY = 1000;
const DEFAULT_HEARTBEAT_MS = 15_000;

/** `?projects=a,b,c` → `["a","b","c"]`. Empty and blank entries drop out. */
export function parseProjectList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (id) seen.add(id);
  }
  return [...seen];
}

/**
 * `?since=a:120,b:44` → `{a → 120, b → 44}`.
 *
 * Garbage is dropped rather than defaulted: a cursor read as `NaN` would either
 * replay a whole log or silently skip it, and both are worse than starting the
 * project from the beginning.
 */
export function parseCursors(raw: string | null | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (!raw) return out;
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const at = trimmed.lastIndexOf(":");
    if (at <= 0) continue;
    const id = trimmed.slice(0, at).trim();
    const rawSeq = trimmed.slice(at + 1).trim();
    // `Number("")` is 0, not NaN — an empty cursor would silently become
    // "replay this project from the beginning".
    if (!rawSeq) continue;
    const seq = Number(rawSeq);
    if (!id || !Number.isFinite(seq) || seq < 0) continue;
    out.set(id, Math.floor(seq));
  }
  return out;
}

/** The wire form of a tagged kernel event. */
export function formatMultiplexFrame(frame: MultiplexFrame): string {
  return `id: ${frame.projectId}:${frame.seq}\nevent: ${frame.event.type}\ndata: ${JSON.stringify(frame)}\n\n`;
}

function formatStreamFrame(projectId: string, type: string, data: unknown): string {
  // `turn.token` and friends are consumed field-by-field by the dashboard, so
  // `projectId` is merged in rather than wrapped — a wrapper would rename every
  // field the existing listener reads.
  const payload = data && typeof data === "object" && !Array.isArray(data) ? { projectId, ...(data as Record<string, unknown>) } : { projectId, data };
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function formatResync(signal: ResyncSignal): string {
  return `event: resync\ndata: ${JSON.stringify(signal)}\n\n`;
}

interface HistoryEntry {
  seq: number;
  frame: string;
}

interface QueueItem {
  projectId: string;
  /** Undefined for stream frames and resync signals: they move no cursor. */
  seq?: number;
  frame: string;
}

interface Subscription {
  projectId: string;
  handle?: UpstreamHandle;
  /** In flight during `openUpstream`; awaited by shutdown so nothing leaks. */
  opening?: Promise<void>;
  history: HistoryEntry[];
  firstSeq: number;
  lastSeq: number;
}

/**
 * One browser connection: its project set, its per-project delivery cursors and
 * its bounded outbound queue.
 */
class MultiplexClient {
  readonly projects: Set<string>;
  /** Last seq actually written to the socket, per project. */
  private readonly delivered = new Map<string, number>();
  private queue: QueueItem[] = [];
  private paused = false;
  private dropped = 0;
  private needsResync = false;
  private ended = false;

  constructor(
    private readonly socket: MultiplexSocket,
    projects: Iterable<string>,
    cursors: Map<string, number>,
    private readonly maxQueue: number,
  ) {
    this.projects = new Set(projects);
    for (const id of this.projects) this.delivered.set(id, cursors.get(id) ?? 0);
  }

  get isEnded(): boolean {
    return this.ended;
  }

  cursor(projectId: string): number {
    return this.delivered.get(projectId) ?? 0;
  }

  cursors(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const id of this.projects) out[id] = this.cursor(id);
    return out;
  }

  send(item: QueueItem): void {
    if (this.ended) return;
    if (this.paused) {
      this.queue.push(item);
      // Strictly greater: the cap is a queue length, and dropping at exactly
      // the cap would discard a client that is merely at its limit.
      if (this.queue.length > this.maxQueue) this.overflow();
      return;
    }
    this.write(item);
  }

  resync(signal: ResyncSignal): void {
    this.send({ projectId: signal.projectId ?? "", frame: formatResync(signal) });
  }

  heartbeat(): void {
    // Deliberately not queued: a ping exists to prove the socket is alive, and
    // one queued behind a backlog proves nothing.
    if (this.ended || this.paused) return;
    this.write({ projectId: "", frame: `: ping ${Date.now()}\n\n` });
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.queue = [];
    try {
      this.socket.end();
    } catch {
      /* already gone */
    }
  }

  /** Detach without touching the socket — the HTTP layer owns closing it. */
  detach(): void {
    this.ended = true;
    this.queue = [];
  }

  private write(item: QueueItem): void {
    let ok = true;
    try {
      ok = this.socket.write(item.frame) !== false;
    } catch {
      // A write that throws is a socket that is gone; the hub reaps it on the
      // next pass rather than throwing back into ingestion.
      this.ended = true;
      this.queue = [];
      return;
    }
    if (item.seq !== undefined && item.projectId) {
      this.delivered.set(item.projectId, Math.max(this.delivered.get(item.projectId) ?? 0, item.seq));
    }
    if (!ok) {
      this.paused = true;
      try {
        this.socket.once("drain", () => this.onDrain());
      } catch {
        this.ended = true;
      }
    }
  }

  private overflow(): void {
    this.dropped += this.queue.length;
    this.queue = [];
    this.needsResync = true;
  }

  private onDrain(): void {
    if (this.ended) return;
    this.paused = false;
    if (this.needsResync) {
      // Ahead of the backlog on purpose: the signal marks where the gap starts,
      // so a client that applied the newer frames first would stitch them onto
      // a log it has not caught up to yet.
      this.needsResync = false;
      const dropped = this.dropped;
      this.dropped = 0;
      this.write({ projectId: "", frame: formatResync({ reason: "overflow", cursors: this.cursors(), dropped }) });
    }
    while (!this.paused && !this.ended && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) break;
      this.write(next);
    }
  }
}

export class MultiplexHub {
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly clients = new Set<MultiplexClient>();
  private readonly openUpstream: OpenUpstream;
  private readonly maxQueue: number;
  private readonly historyLimit: number;
  private readonly heartbeatMs: number;
  private readonly onError: ((projectId: string, error: Error) => void) | undefined;
  private heartbeatTimer?: NodeJS.Timeout;
  private closing = false;

  constructor(options: MultiplexHubOptions) {
    this.openUpstream = options.openUpstream;
    this.maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;
    this.historyLimit = options.historyPerProject ?? DEFAULT_HISTORY;
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.onError = options.onError;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** Projects the host currently holds a child subscription for. */
  followed(): string[] {
    return [...this.subscriptions.keys()];
  }

  /** Highest seq ingested for a project, 0 before the first event. */
  lastSeq(projectId: string): number {
    return this.subscriptions.get(projectId)?.lastSeq ?? 0;
  }

  /**
   * Start (or keep) the host's subscription to one child. Idempotent: the
   * second browser to ask for a project joins the existing stream instead of
   * opening a second one against the same log.
   */
  async follow(projectId: string, sinceSeq = 0): Promise<void> {
    if (this.closing) return;
    const existing = this.subscriptions.get(projectId);
    if (existing) {
      if (existing.opening) await existing.opening;
      return;
    }
    const sub: Subscription = { projectId, history: [], firstSeq: 0, lastSeq: sinceSeq };
    this.subscriptions.set(projectId, sub);
    const opening = (async () => {
      try {
        const handle = await this.openUpstream(projectId, sinceSeq, this.sinkFor(projectId));
        // The child may have been asked for while the hub was shutting down.
        // Nothing else will ever close this handle, so close it here or it
        // outlives the process that opened it — the same shape of leak that
        // stranded children mid-handshake.
        if (this.closing || this.subscriptions.get(projectId) !== sub) {
          handle.close();
          return;
        }
        sub.handle = handle;
      } catch (err) {
        this.subscriptions.delete(projectId);
        this.onError?.(projectId, err as Error);
        throw err;
      }
    })();
    sub.opening = opening;
    try {
      await opening;
    } finally {
      sub.opening = undefined;
    }
  }

  /** Drop a project's subscription and its replay ring (project closed). */
  async unfollow(projectId: string): Promise<void> {
    const sub = this.subscriptions.get(projectId);
    if (!sub) return;
    this.subscriptions.delete(projectId);
    if (sub.opening) {
      await sub.opening.catch(() => undefined);
    }
    try {
      sub.handle?.close();
    } catch {
      /* already gone */
    }
  }

  /**
   * Attach a browser.
   *
   * Resume is served from the per-project ring where it can be, and honestly
   * refused where it cannot: a cursor older than the ring gets a `gap` signal
   * telling the client to refetch from the child's log, which is the only place
   * the missing frames still exist.
   */
  add(socket: MultiplexSocket, request: { projects: Iterable<string>; since?: Map<string, number> }): () => void {
    const cursors = request.since ?? new Map<string, number>();
    const client = new MultiplexClient(socket, request.projects, cursors, this.maxQueue);
    this.clients.add(client);
    this.ensureHeartbeat();

    for (const projectId of client.projects) {
      const sub = this.subscriptions.get(projectId);
      if (!sub) continue;
      const from = cursors.get(projectId) ?? 0;
      // Only a client that *claimed* a position can have a hole. A project it
      // has never seen legitimately starts wherever the child's log is — the
      // common case being a tab that just opened a long-running project.
      const resuming = cursors.has(projectId);
      // A ring that starts past the cursor means the frames in between were
      // evicted. Replaying only what survived would look complete and silently
      // hide the hole, so say so and let the client refetch from the log.
      if (resuming && sub.history.length > 0 && sub.firstSeq > from + 1) {
        client.resync({ reason: "gap", projectId, seq: from });
        continue;
      }
      for (const entry of sub.history) {
        if (entry.seq > from) client.send({ projectId, seq: entry.seq, frame: entry.frame });
      }
    }

    return () => {
      client.detach();
      this.clients.delete(client);
      if (this.clients.size === 0) this.stopHeartbeat();
    };
  }

  /** Tear down every client and every child subscription. */
  async close(): Promise<void> {
    this.closing = true;
    this.stopHeartbeat();
    for (const client of [...this.clients]) client.end();
    this.clients.clear();
    // Await the in-flight opens too: one that resolves after this returns would
    // leave a live subscription with nothing left to close it.
    const pending = [...this.subscriptions.values()].map((sub) => sub.opening ?? Promise.resolve());
    const subs = [...this.subscriptions.values()];
    this.subscriptions.clear();
    await Promise.all(pending.map((p) => p.catch(() => undefined)));
    for (const sub of subs) {
      try {
        sub.handle?.close();
      } catch {
        /* already gone */
      }
    }
  }

  private sinkFor(projectId: string): UpstreamSink {
    return {
      event: (event) => this.ingest(projectId, event),
      stream: (type, data) => this.ingestStream(projectId, type, data),
      closed: (error) => this.handleUpstreamClosed(projectId, error),
    };
  }

  private ingest(projectId: string, event: MeshEvent): void {
    const sub = this.subscriptions.get(projectId);
    if (!sub) return;
    const seq = typeof event.seq === "number" ? event.seq : undefined;
    if (seq === undefined) {
      // No seq means nothing can resume against it; deliver it live and keep it
      // out of the ring rather than corrupting the cursor arithmetic.
      const frame = formatMultiplexFrame({ projectId, seq: 0, event });
      this.fanout(projectId, { projectId, frame });
      return;
    }
    if (seq <= sub.lastSeq && sub.history.some((h) => h.seq === seq)) return;
    const frame = formatMultiplexFrame({ projectId, seq, event });
    sub.lastSeq = Math.max(sub.lastSeq, seq);
    sub.history.push({ seq, frame });
    if (sub.history.length > this.historyLimit) sub.history.splice(0, sub.history.length - this.historyLimit);
    sub.firstSeq = sub.history[0]?.seq ?? 0;
    this.fanout(projectId, { projectId, seq, frame });
  }

  private ingestStream(projectId: string, type: string, data: unknown): void {
    if (!this.subscriptions.has(projectId)) return;
    this.fanout(projectId, { projectId, frame: formatStreamFrame(projectId, type, data) });
  }

  private fanout(projectId: string, item: QueueItem): void {
    for (const client of [...this.clients]) {
      if (client.isEnded) {
        this.clients.delete(client);
        continue;
      }
      if (!client.projects.has(projectId)) continue;
      client.send(item);
    }
  }

  /**
   * The child went away (exit, restart, network). The subscription is dropped
   * so the next `follow` reopens it, and every interested client is told where
   * it stopped so a reconnect can be lossless.
   */
  private handleUpstreamClosed(projectId: string, error?: Error): void {
    const sub = this.subscriptions.get(projectId);
    if (!sub) return;
    this.subscriptions.delete(projectId);
    if (error) this.onError?.(projectId, error);
    if (this.closing) return;
    for (const client of [...this.clients]) {
      if (!client.projects.has(projectId)) continue;
      client.resync({ reason: "upstream-closed", projectId, seq: client.cursor(projectId) });
    }
  }

  private ensureHeartbeat(): void {
    if (this.heartbeatTimer || this.heartbeatMs <= 0) return;
    this.heartbeatTimer = setInterval(() => {
      for (const client of [...this.clients]) {
        if (client.isEnded) {
          this.clients.delete(client);
          continue;
        }
        client.heartbeat();
      }
    }, this.heartbeatMs);
    (this.heartbeatTimer as unknown as { unref?: () => void }).unref?.();
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }
}

/**
 * Incremental reader for the SSE the host consumes from a child.
 *
 * The host is an SSE *client* here, and chunk boundaries have nothing to do
 * with frame boundaries — a parser that assumed one read is one frame would
 * work in tests and tear events in half under load.
 */
export class SseDecoder {
  private buffer = "";

  constructor(private readonly onFrame: (frame: { id?: string; event?: string; data: string }) => void) {}

  push(chunk: string): void {
    this.buffer += chunk.replace(/\r\n/g, "\n");
    let split = this.buffer.indexOf("\n\n");
    while (split !== -1) {
      const raw = this.buffer.slice(0, split);
      this.buffer = this.buffer.slice(split + 2);
      this.emit(raw);
      split = this.buffer.indexOf("\n\n");
    }
  }

  private emit(raw: string): void {
    let id: string | undefined;
    let event: string | undefined;
    const data: string[] = [];
    for (const line of raw.split("\n")) {
      if (!line || line.startsWith(":")) continue; // comment: heartbeat
      const at = line.indexOf(":");
      const field = at === -1 ? line : line.slice(0, at);
      const value = at === -1 ? "" : line.slice(at + 1).replace(/^ /, "");
      if (field === "id") id = value;
      else if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length === 0) return;
    const frame: { id?: string; event?: string; data: string } = { data: data.join("\n") };
    if (id !== undefined) frame.id = id;
    if (event !== undefined) frame.event = event;
    this.onFrame(frame);
  }
}
