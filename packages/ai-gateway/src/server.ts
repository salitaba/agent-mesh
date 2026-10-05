/**
 * The tenant-facing HTTP server: `POST /v1/chat/completions`, `GET /v1/models` and a health check.
 *
 * This file is only HTTP. It reads a request, hands the gateway a key and a parsed body, and turns what the gateway says into
 * a response: a JSON answer, a refusal, or a server-sent event stream. Nothing about money, providers or tiers is decided here.
 *
 * Two rules it keeps for the sake of the people on the other end. A request with no valid key is answered before its body is
 * read, so a flood of unauthenticated uploads costs nothing. And a response that is being streamed is written at the pace the
 * reader takes it, so a slow reader makes the gateway wait and does not make it buffer.
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type { JsonObject } from "../../llm/src/index";
import type { ChatOutput, Gateway } from "./gateway";
import { WireError, errorBody, newRequestId } from "./openai-wire";

export interface ServerOptions {
  /** The largest request body accepted, in bytes. */
  maxBodyBytes?: number;
}

export function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent || res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload), "cache-control": "no-store", ...headers });
  res.end(payload);
}

/** Answer with an error. `connection: close` where the request body was not read: the server closes the socket behind the answer, so it is not reused for the rest of it. */
export function sendError(res: http.ServerResponse, err: unknown, headers: Record<string, string> = {}): void {
  const e = err instanceof WireError ? err : new WireError(500, "internal_error", "The server failed to handle this request.");
  sendJson(res, e.status, errorBody(e), { "x-request-id": newRequestId(), ...e.headers, ...headers });
}

/** The request body, up to `max` bytes. Rejects with a 413 as soon as it is over, without waiting for the rest. */
export function readBody(req: http.IncomingMessage, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let finished = false;
    const finish = (err?: WireError): void => {
      if (finished) return;
      finished = true;
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("close", onClose);
      if (err) reject(err);
      else resolve(Buffer.concat(chunks));
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > max) return finish(new WireError(413, "request_too_large", `The request body is larger than ${max} bytes.`));
      chunks.push(chunk);
    };
    const onEnd = (): void => finish();
    const onError = (): void => finish(new WireError(400, "invalid_request_error", "The request could not be read."));
    const onClose = (): void => finish(new WireError(400, "invalid_request_error", "The connection closed before the request was complete."));
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("close", onClose);
  });
}

/** Write to a response, and wait for it to drain when the reader is behind. A response that is gone takes nothing. */
function write(res: http.ServerResponse, data: string): void | Promise<void> {
  if (res.destroyed || res.writableEnded) return;
  if (res.write(data)) return;
  return new Promise<void>((resolve) => {
    const done = (): void => {
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    res.once("drain", done);
    res.once("close", done);
  });
}

/** A gateway call's output, over a response. */
export function outputFor(res: http.ServerResponse): ChatOutput {
  const controller = new AbortController();
  // `close` before the response was finished means the caller went away.
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  return {
    aborted: controller.signal,
    reject: (status, body, headers) => sendJson(res, status, body, headers),
    json: (status, body, headers) => sendJson(res, status, body, headers),
    open: (headers) => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no", ...headers });
      res.flushHeaders();
    },
    frame: (data: JsonObject | "[DONE]") => write(res, `data: ${data === "[DONE]" ? data : JSON.stringify(data)}\n\n`),
    comment: (text) => void write(res, `: ${text}\n\n`),
    close: () => {
      if (!res.writableEnded) res.end();
    },
  };
}

export function createTenantServer(gateway: Gateway, options: ServerOptions = {}): http.Server {
  const maxBody = options.maxBodyBytes ?? 8 * 1024 * 1024;

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://gateway.invalid");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";
    const wrongMethod = (allowed: string): void => sendError(res, new WireError(405, "method_not_allowed", `Use ${allowed} for ${path}.`, undefined, { allow: allowed }));

    if (path === "/healthz") {
      if (method !== "GET") return wrongMethod("GET");
      const ok = gateway.options.ledger.writable;
      return sendJson(res, ok ? 200 : 503, { ok });
    }
    if (path === "/v1/models") {
      if (method !== "GET") return wrongMethod("GET");
      let key;
      try {
        key = gateway.authenticate(req.headers.authorization);
      } catch (err) {
        return sendError(res, err);
      }
      return sendJson(res, 200, { object: "list", data: gateway.models(key).map((id) => ({ id, object: "model", created: 0, owned_by: "curule" })) });
    }
    if (path === "/v1/chat/completions") {
      if (method !== "POST") return wrongMethod("POST");
      let key;
      try {
        key = gateway.authenticate(req.headers.authorization);
      } catch (err) {
        // Answered before the body is read, and the connection is closed behind the answer: not kept for whatever the caller was about to send.
        return sendError(res, err, { connection: "close" });
      }
      let raw: Buffer;
      try {
        raw = await readBody(req, maxBody);
      } catch (err) {
        return sendError(res, err, { connection: "close" });
      }
      let body: unknown;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        return sendError(res, new WireError(400, "invalid_json", "The request body is not valid JSON."));
      }
      return gateway.chat(key, body, outputFor(res));
    }
    return sendError(res, new WireError(404, "not_found", `There is nothing at ${method} ${path}.`));
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      gateway.log("error", "the server failed to handle a request", { error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
      if (res.headersSent) res.destroy();
      else sendError(res, err);
    });
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 120_000;
  return server;
}

export interface Listening {
  server: http.Server;
  url: string;
  port: number;
  /** Stop accepting calls, give the ones in flight `graceMs` to finish, and then close what is left. */
  close(graceMs?: number): Promise<void>;
}

export function listen(server: http.Server, port: number, host: string): Promise<Listening> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const address = server.address() as AddressInfo;
      resolve({
        server,
        port: address.port,
        url: `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`,
        close: (graceMs = 10_000) =>
          new Promise<void>((done) => {
            const timer = setTimeout(() => server.closeAllConnections(), graceMs);
            // `close` ends the connections that are idle (since Node 19) and waits for the ones in a call.
            server.close(() => {
              clearTimeout(timer);
              done();
            });
          }),
      });
    });
  });
}
