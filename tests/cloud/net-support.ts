import * as http from "node:http";
import type { AddressInfo } from "node:net";

export interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  /** The body read as JSON, when it is an object. */
  json: any;
}

export interface Ask {
  method?: string;
  path?: string;
  /** The Host header: which site the request is for. */
  host?: string;
  headers?: Record<string, string | string[]>;
  body?: string | Buffer;
  json?: unknown;
}

/** Listen on a free port of the loopback address. `close` does not wait for connections that are idle. */
export async function listen(server: http.Server): Promise<{ port: number; close(): Promise<void> }> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** One request on a connection of its own, answered in full. */
export function ask(port: number, a: Ask = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const body = a.json !== undefined ? Buffer.from(JSON.stringify(a.json)) : typeof a.body === "string" ? Buffer.from(a.body) : a.body;
    const headers: Record<string, string | string[]> = {
      ...(a.host ? { host: a.host } : {}),
      ...(a.json !== undefined ? { "content-type": "application/json" } : {}),
      ...(body ? { "content-length": String(body.length) } : {}),
      ...a.headers,
    };
    const req = http.request({ host: "127.0.0.1", port, method: a.method ?? "GET", path: a.path ?? "/", headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: unknown;
        try {
          json = text.startsWith("{") ? JSON.parse(text) : undefined;
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text, json });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}
