import type { MeshEvent } from "../../protocol/src/index";
import { formatSse, type SseClient } from "./metrics";

export class SseHub {
  private clients = new Set<SseClient>();
  private lastSeq = 0;
  private heartbeatTimer?: NodeJS.Timeout;

  get clientCount(): number {
    return this.clients.size;
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
      client.write(formatSse(event));
    } catch {
      this.clients.delete(client);
    }
  }

  broadcast(event: MeshEvent): void {
    if (typeof event.seq === "number") this.lastSeq = Math.max(this.lastSeq, event.seq);
    const data = formatSse(event);
    for (const client of [...this.clients]) {
      try {
        client.write(data);
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
        client.write(frame);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  heartbeat(): void {
    const ping = `: ping ${Date.now()}\n\n`;
    for (const client of [...this.clients]) {
      try {
        client.write(ping);
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
