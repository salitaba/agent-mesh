import type { MeshEvent } from "../../protocol/src/index";
import { formatSse, type SseClient } from "./metrics";

/** More subscribers than any team has tabs open; the cap is for the one that does not stop connecting. */
export const DEFAULT_MAX_SSE_CLIENTS = 256;
/** What one subscriber may fall behind by before it is cut off. It resumes from the log by `Last-Event-ID`. */
export const DEFAULT_MAX_SSE_BUFFERED_BYTES = 4 * 1024 * 1024;

export interface SseHubOptions {
  maxClients?: number;
  maxBufferedBytes?: number;
}

export class SseHub {
  private clients = new Set<SseClient>();
  private lastSeq = 0;
  private heartbeatTimer?: NodeJS.Timeout;
  private readonly maxClients: number;
  private readonly maxBufferedBytes: number;

  constructor(options: SseHubOptions = {}) {
    this.maxClients = options.maxClients ?? DEFAULT_MAX_SSE_CLIENTS;
    this.maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_SSE_BUFFERED_BYTES;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** True when one more subscriber would pass the cap; the route answers 503 instead of calling `add`. */
  get full(): boolean {
    return this.clients.size >= this.maxClients;
  }

  /**
   * A subscriber that has stopped reading used to cost memory without bound: `write` always accepts, the
   * socket buffers what it cannot send, and every event is another copy. One that is further behind than
   * `maxBufferedBytes` is cut off instead. Its EventSource reconnects and catches up from the log.
   */
  private write(client: SseClient, data: string): void {
    client.write(data);
    if ((client.writableLength ?? 0) > this.maxBufferedBytes) {
      this.clients.delete(client);
      try {
        client.destroy?.();
      } catch {
        /* already gone */
      }
    }
  }

  get lastEventSeq(): number {
    return this.lastSeq;
  }

  add(res: SseClient): () => void {
    try {
      res.write(`retry: 3000\n`);
      res.write(`: connected ${new Date().toISOString()}\n\n`);
    } catch {
      /* client already gone */
    }
    this.clients.add(res);
    this.ensureHeartbeat();
    return () => {
      this.clients.delete(res);
      if (this.clients.size === 0) this.stopHeartbeat();
    };
  }

  /** Unicast one event (catch-up for a fresh subscriber only). */
  sendTo(client: SseClient, event: MeshEvent): void {
    try {
      this.write(client, formatSse(event));
    } catch {
      this.clients.delete(client);
    }
  }

  broadcast(event: MeshEvent): void {
    if (typeof event.seq === "number") this.lastSeq = Math.max(this.lastSeq, event.seq);
    const data = formatSse(event);
    for (const client of [...this.clients]) {
      try {
        this.write(client, data);
      } catch {
        this.clients.delete(client);
      }
    }
    if (this.clients.size === 0) this.stopHeartbeat();
  }

  /**
   * Out-of-band live frame (token stream, presence, …): deliberately NOT a
   * kernel event — no seq/id, so EventSource rewind and log catch-up ignore
   * it. Receivers subscribe via addEventListener(type).
   */
  stream(type: string, data: unknown): void {
    if (this.clients.size === 0) return;
    const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of [...this.clients]) {
      try {
        this.write(client, frame);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  heartbeat(): void {
    const ping = `: ping ${Date.now()}\n\n`;
    for (const client of [...this.clients]) {
      try {
        this.write(client, ping);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  private ensureHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => this.heartbeat(), 15000);
    (this.heartbeatTimer as unknown as { unref?: () => void }).unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer && this.clients.size === 0) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  close(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    for (const c of this.clients) {
      try {
        c.end();
      } catch {
        /* noop */
      }
    }
    this.clients.clear();
  }
}
