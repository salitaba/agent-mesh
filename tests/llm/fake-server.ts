import * as http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A model provider's HTTP API, played by the test.
 *
 * Real sockets, not a mocked `fetch`: what these adapters have to survive is what a network does to a response (a body in
 * pieces, a connection cut, a header that never comes), and a stub would only hand back what the test already believed.
 */

export interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  raw: string;
  /** The parsed JSON body, or undefined for a request without one. */
  body: any;
}

export type Handler = (req: Seen, res: http.ServerResponse, n: number) => unknown;

export interface FakeServer {
  url: string;
  seen: Seen[];
  close(): Promise<void>;
}

export async function fakeServer(handler: Handler): Promise<FakeServer> {
  const seen: Seen[] = [];
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = undefined;
      }
      const entry: Seen = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, raw, body };
      seen.push(entry);
      Promise.resolve(handler(entry, res, seen.length - 1)).catch((err) => {
        if (!res.headersSent) res.writeHead(500);
        res.end(String(err));
      });
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

export function sseHead(res: http.ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
}

/** One server-sent event. A string is sent as it is, anything else as JSON. */
export function frame(res: http.ServerResponse, data: unknown, event?: string): void {
  res.write(`${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
}

export function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/** Every event of a stream, collected, and the result of its `end`. */
export async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

/** A transport that retries at once, so a test of the retry ladder does not wait out its backoff. */
export const FAST = { retryBaseMs: 1, retryMaxMs: 5, sleep: async () => undefined, random: () => 0 };
