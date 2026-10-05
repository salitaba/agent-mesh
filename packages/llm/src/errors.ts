/**
 * How a model call fails, in terms the rest of Curule already understands.
 *
 * The supervisor classifies a failed turn from the error it is handed (`classifyProviderOutage` in the protocol package):
 * a rate limit, an exhausted account, a rejected key or a provider outage is one fault shared by every seat, and the mesh
 * pauses once instead of walking each seat down its own failure ladder. It reads an `API Error: <status> <detail>` line,
 * which is how the Claude CLI reports a provider's answer, so that is the shape these messages take. The shape is the
 * contract; a test in `tests/llm` holds it against the classifier itself.
 */

export type ProviderErrorKind =
  | "rate_limited"
  | "billing"
  | "auth"
  | "unavailable"
  | "unreachable"
  /** The prompt did not fit the model's window. The caller can shrink it and ask again. */
  | "context_overflow"
  /** The provider refused this request: a bad model id, a malformed tool schema, an unsupported parameter. */
  | "invalid_request"
  | "other";

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  /** The HTTP status, absent when the provider could not be reached at all. */
  readonly status?: number;
  /** The provider's own error type or code (`rate_limit_error`, `insufficient_quota`), when it sent one. */
  readonly type?: string;
  /** How long the provider asked callers to wait, in ms. */
  readonly retryAfterMs?: number;
  readonly backend: string;
  /** What the provider said, without the `API Error` framing. */
  readonly detail: string;

  constructor(backend: string, init: { kind: ProviderErrorKind; status?: number; type?: string; detail: string; retryAfterMs?: number }) {
    const head = init.status !== undefined ? `API Error: ${init.status} ${init.detail}` : `API Error: ${init.detail}`;
    super(`${head} (${backend})`);
    this.name = "ProviderError";
    this.kind = init.kind;
    this.status = init.status;
    this.type = init.type;
    this.retryAfterMs = init.retryAfterMs;
    this.backend = backend;
    this.detail = init.detail;
  }

  /** Worth asking again: the provider is busy or briefly down, not unwilling. */
  get retryable(): boolean {
    return this.kind === "rate_limited" || this.kind === "unavailable" || this.kind === "unreachable";
  }
}

/**
 * The provider accepted the call and then said nothing for too long.
 *
 * Named `TimeoutError`, which the supervisor already reads as "slow, not dead": the turn is retried rather than the seat
 * written off.
 */
export class ProviderTimeoutError extends Error {
  readonly backend: string;
  readonly timeoutMs: number;

  constructor(backend: string, what: string, timeoutMs: number) {
    super(`request timed out after ${timeoutMs}ms: ${what} on ${backend}; the provider is reachable but has not responded yet`);
    this.name = "TimeoutError";
    this.backend = backend;
    this.timeoutMs = timeoutMs;
  }
}

/** The error a stream throws when its caller aborted it. Named as the platform names one, so every `AbortError` check agrees. */
export function abortError(message = "the model call was aborted"): Error {
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

const OVERFLOW = /context.?length|context window|maximum context|prompt is too long|input is too long|too many tokens|reduce the length|exceeds? the (?:model'?s )?(?:maximum|limit)/i;
const BILLING = /credit balance|insufficient[_ ](?:credit|funds|balance|quota)|billing|payment required|exceeded your current quota|out of credits/i;

/** What a non-2xx answer means, from its status and what the provider wrote. */
export function classifyHttpFailure(status: number, type: string | undefined, detail: string): ProviderErrorKind {
  const text = `${type ?? ""} ${detail}`;
  if (status === 413 || ((status === 400 || status === 422) && OVERFLOW.test(text))) return "context_overflow";
  if (status === 402 || BILLING.test(text)) return "billing";
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status >= 500 && status <= 599) return "unavailable";
  if (status >= 400 && status <= 499) return "invalid_request";
  return "other";
}

/**
 * The words in a provider's error body. Providers disagree on where they put them (`error.message`, `message`,
 * `detail`, a bare string), and some answer with HTML from a proxy in front of them, so this takes what is there and
 * bounds it.
 */
export function describeErrorBody(text: string): { type?: string; detail: string } {
  const trimmed = text.trim();
  if (!trimmed) return { detail: "no body" };
  try {
    const body = JSON.parse(trimmed) as unknown;
    if (body && typeof body === "object") {
      const o = body as Record<string, unknown>;
      const inner = o.error && typeof o.error === "object" ? (o.error as Record<string, unknown>) : o;
      const message = [inner.message, inner.detail, o.message, o.detail, typeof o.error === "string" ? o.error : undefined].find(
        (v): v is string => typeof v === "string" && v.trim() !== "",
      );
      const type = [inner.type, inner.code, o.type].find((v): v is string => typeof v === "string" && v !== "" && v !== "error");
      if (message) return { type, detail: message.trim().slice(0, 400) };
    }
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return { detail: trimmed.replace(/\s+/g, " ").slice(0, 300) };
}

/** `Retry-After` as milliseconds: a count of seconds or an HTTP date, with the non-standard `retry-after-ms` first. */
export function retryAfterMs(headers: Headers): number | undefined {
  const ms = Number(headers.get("retry-after-ms"));
  if (headers.get("retry-after-ms") !== null && Number.isFinite(ms) && ms >= 0) return Math.round(ms);
  const raw = headers.get("retry-after");
  if (raw === null) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}
