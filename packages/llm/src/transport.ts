/**
 * The HTTP half of a model call: send the request, ride out a busy provider, and hand back the body as a stream that
 * cannot hang forever.
 *
 * What is retried, and what is not. A call is retried when the provider could not be reached or answered 429 or 5xx, and
 * only BEFORE any of a successful body has been read: once bytes of an answer have gone to the caller, asking again would
 * repeat what it already saw. Waits double with jitter and honour `Retry-After`, but a provider that asks for longer than
 * `retryMaxMs` is not waited on: the caller learns the wait and decides. A refused request (a bad key, a prompt that does
 * not fit, an exhausted account) is never retried, since asking again changes nothing.
 */
import { ProviderError, ProviderTimeoutError, abortError, classifyHttpFailure, describeErrorBody, retryAfterMs } from "./errors";

export interface TransportOptions {
  /** Retries after the first attempt. */
  maxRetries?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** How long to wait for the response headers, in ms. */
  headersTimeoutMs?: number;
  /** How long a body may go without a byte, in ms. A model that is thinking sends nothing, so this is generous. */
  idleTimeoutMs?: number;
  /** For tests. */
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

export interface ResolvedTransport {
  maxRetries: number;
  retryBaseMs: number;
  retryMaxMs: number;
  headersTimeoutMs: number;
  idleTimeoutMs: number;
  fetch: typeof fetch;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  random: () => number;
}

export function resolveTransport(o: TransportOptions = {}): ResolvedTransport {
  return {
    maxRetries: o.maxRetries ?? 2,
    retryBaseMs: o.retryBaseMs ?? 500,
    retryMaxMs: o.retryMaxMs ?? 20_000,
    headersTimeoutMs: o.headersTimeoutMs ?? 120_000,
    idleTimeoutMs: o.idleTimeoutMs ?? 180_000,
    fetch: o.fetch ?? ((input, init) => fetch(input, init)),
    sleep: o.sleep ?? defaultSleep,
    random: o.random ?? Math.random,
  };
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** The reason a fetch failed, as Node reports it: on `cause.code` for a socket, in the message otherwise. */
function causeText(err: unknown): string {
  const code = (err as { cause?: { code?: unknown } } | undefined)?.cause?.code ?? (err as { code?: unknown } | undefined)?.code;
  if (typeof code === "string") return code;
  const message = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err);
  return message.slice(0, 160);
}

export interface OpenedResponse {
  /** The body, ending when the provider closes it, throwing when it goes quiet or the caller aborts. */
  chunks: AsyncGenerator<Uint8Array, void>;
  response: Response;
  /** Release the connection. Safe to call twice. */
  close(): void;
}

export interface OpenRequest {
  /** What the operator knows this provider as, for error messages. */
  endpoint: string;
  url: string;
  method?: "POST" | "GET";
  headers: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  transport: ResolvedTransport;
}

export async function openResponse(req: OpenRequest): Promise<OpenedResponse> {
  const t = req.transport;
  for (let attempt = 0; ; attempt++) {
    if (req.signal?.aborted) throw abortError();
    const controller = new AbortController();
    const onCallerAbort = (): void => controller.abort();
    req.signal?.addEventListener("abort", onCallerAbort, { once: true });
    let timedOut = false;
    const headersTimer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, t.headersTimeoutMs);
    const release = (): void => {
      clearTimeout(headersTimer);
      req.signal?.removeEventListener("abort", onCallerAbort);
    };

    let response: Response;
    try {
      response = await t.fetch(req.url, {
        method: req.method ?? "POST",
        headers: req.headers,
        ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      release();
      if (req.signal?.aborted) throw abortError();
      if (timedOut) throw new ProviderTimeoutError(req.endpoint, "waiting for response headers", t.headersTimeoutMs);
      const failure = new ProviderError(req.endpoint, { kind: "unreachable", detail: `Unable to connect to API (${causeText(err)})` });
      if (attempt < t.maxRetries) {
        await t.sleep(backoff(t, attempt, undefined), req.signal);
        continue;
      }
      throw failure;
    }
    clearTimeout(headersTimer);

    if (!response.ok) {
      release();
      const text = await readBounded(response, 8192);
      const { type, detail } = describeErrorBody(text);
      const kind = classifyHttpFailure(response.status, type, detail);
      const failure = new ProviderError(req.endpoint, {
        kind,
        status: response.status,
        type,
        detail,
        retryAfterMs: retryAfterMs(response.headers),
      });
      const wait = failure.retryAfterMs;
      if (failure.retryable && attempt < t.maxRetries && (wait === undefined || wait <= t.retryMaxMs)) {
        await t.sleep(backoff(t, attempt, wait), req.signal);
        continue;
      }
      throw failure;
    }

    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      release();
      controller.abort();
    };
    return {
      response,
      close,
      chunks: readBody(response, req, controller, t.idleTimeoutMs, () => {
        closed = true;
        release();
      }),
    };
  }
}

function backoff(t: ResolvedTransport, attempt: number, retryAfter: number | undefined): number {
  const exponential = Math.min(t.retryMaxMs, t.retryBaseMs * 2 ** attempt);
  const jittered = exponential * (0.5 + t.random() * 0.5);
  return Math.max(jittered, retryAfter ?? 0);
}

async function readBounded(response: Response, limit: number): Promise<string> {
  try {
    const text = await response.text();
    return text.length > limit ? text.slice(0, limit) : text;
  } catch {
    return "";
  }
}

async function* readBody(
  response: Response,
  req: OpenRequest,
  controller: AbortController,
  idleMs: number,
  done: () => void,
): AsyncGenerator<Uint8Array, void> {
  const body = response.body;
  if (!body) {
    done();
    return;
  }
  const reader = body.getReader();
  try {
    for (;;) {
      let quiet = false;
      // Aborting the fetch rejects the pending read, so the reason for it is recorded first, not inferred afterwards.
      const timer = setTimeout(() => {
        quiet = true;
        controller.abort();
      }, idleMs);
      let next: { done: boolean; value?: Uint8Array };
      try {
        next = await reader.read();
      } catch (err) {
        if (quiet) throw new ProviderTimeoutError(req.endpoint, "reading the response", idleMs);
        if (req.signal?.aborted) throw abortError();
        throw new ProviderError(req.endpoint, { kind: "unreachable", detail: `connection lost while reading the response (${causeText(err)})` });
      } finally {
        clearTimeout(timer);
      }
      if (next.done) return;
      if (next.value) yield next.value;
    }
  } finally {
    done();
    // Cancelling a reader whose connection is already dead rejects; the stream is over either way.
    reader.cancel().catch(() => undefined);
  }
}
