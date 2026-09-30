/**
 * Failure classification shared by agent runtimes and the supervisor.
 *
 * A dead model backend (crashed runtime process, refused HTTP endpoint)
 * must not look like any other turn failure: the recovery strategy (respawn
 * and retry) and the operator message ("which backend, and is it alive?")
 * both differ. Adapters throw {@link BackendUnreachableError}; the
 * supervisor counts consecutive occurrences per agent.
 */

/** The agent's model backend died or refused the connection mid-turn. */
export class BackendUnreachableError extends Error {
  /** Backend that failed, e.g. a configured baseUrl (http). */
  readonly backend: string;

  constructor(backend: string, causeMessage: string) {
    super(`backend unreachable at ${backend} (${causeMessage}); the server process may have crashed — check that it is still running`);
    this.name = "BackendUnreachableError";
    this.backend = backend;
  }
}

/**
 * Our own request deadline elapsed. The backend accepted the connection and
 * simply has not answered yet — a thinking model, not a dead process.
 *
 * This exists because the alternative, inferring "was this our timeout?" from
 * the error message, is unreliable: an aborted fetch surfaces as
 * `TypeError: fetch failed`, the same string a refused socket produces. The
 * adapter raises this type the moment *it* fires the abort, so the
 * classification is recorded at the only place that actually knows.
 */
export class RequestTimeoutError extends Error {
  /** Backend that was too slow, e.g. `http://127.0.0.1:4104`. */
  readonly backend: string;
  /** Deadline that elapsed, in milliseconds. */
  readonly timeoutMs: number;

  constructor(backend: string, operation: string, timeoutMs: number) {
    super(`request timed out after ${timeoutMs}ms: ${operation} on ${backend}; the backend is reachable but has not responded yet`);
    this.name = "RequestTimeoutError";
    this.backend = backend;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * A turn the MESH stopped on purpose, carrying whatever the backend had already
 * spent on it.
 *
 * `name` is `"AbortError"` deliberately: `isTimeoutError` treats an `Error` with
 * that name exactly as it treats the `DOMException` this replaces, so every
 * existing classification, retry and "slow, not crashed" path behaves
 * identically. The only thing that changes is that the usage figures survive.
 *
 * They did not before. When the mesh interrupts a turn the CLI still answers with
 * a `result` frame carrying real `usage`, and the adapter threw that frame away
 * on its way to raising the abort. Across one measured run that silently
 * destroyed roughly 85 minutes of generation: unbilled, so the budget ledger
 * believed the tokens were never spent, and invisible, so no one could see the
 * mesh was paying for work it then discarded.
 *
 * `tokensUsed` is optional and may be absent — an interrupt that beats the CLI's
 * own frame has nothing to report. Absent means "unmeasured", never zero; the
 * cost convention elsewhere (`noteTurnCost` ignoring zero-token turns as missing
 * data) depends on the difference.
 */
export class InterruptedTurnError extends Error {
  /** What the backend reported spending before the abort, if it reported at all. */
  readonly tokensUsed?: TurnUsage;
  /**
   * The model the backend reported running, when the adapter saw one before the
   * abort. Optional for the same reason as `tokensUsed`: absent is unknown, and
   * the configured model is NOT a stand-in for it — the run this was added for
   * configured `sonnet` and ran `deepseek-v4.1-flash`.
   */
  readonly model?: string;

  constructor(message: string, tokensUsed?: TurnUsage, model?: string) {
    super(message);
    this.name = "AbortError";
    this.tokensUsed = tokensUsed;
    this.model = model;
  }
}

/**
 * What a turn that did not finish had spent, as far as the backend said.
 *
 * `input`/`output`/`total` are what every adapter reports. `cacheRead` and
 * `thinking` are optional because not every backend splits them — the Claude
 * adapter's `usageToTokens` does, and its object always carried them; the type
 * used to be narrower than the value, so the supervisor could not read them and
 * a timed-out turn's `budget.consumed` went out with no split at all (NOTES
 * live-run 2026-09-25 §3, seq 1153). Absent means unmeasured, never zero.
 */
export interface TurnUsage {
  input: number;
  output: number;
  total: number;
  cacheRead?: number;
  thinking?: number;
}

/**
 * The mesh's own turn deadline ran out.
 *
 * Typed rather than inferred from a message, for the reason `RequestTimeoutError`
 * is: it used to be a plain `RuntimeFailure("turn timeout after …")`, which
 * `isTimeoutError` did not match, so `handleAgentFailure` took the CRASH path
 * for it. Measured 2026-09-25: backend's 20-minute work turn — 242 tool frames,
 * last activity 5 s before the kill — spent restart 1 of 3, and the third is
 * terminal (task released, every ask it owed abandoned). A turn the mesh stopped
 * for running long is a slow turn, not a dead backend.
 *
 * Carries the usage the ordered interrupt came back with, so the stop can still
 * be billed and stated.
 */
export class TurnTimeoutError extends Error {
  /** The deadline that expired, ms from the runtime call — extensions included. */
  readonly timeoutMs: number;
  readonly tokensUsed?: TurnUsage;
  readonly model?: string;

  constructor(timeoutMs: number, tokensUsed?: TurnUsage, model?: string, note?: string) {
    super(`turn timeout after ${timeoutMs}ms${note ? ` (${note})` : ""}`);
    this.name = "TurnTimeoutError";
    this.timeoutMs = timeoutMs;
    this.tokensUsed = tokensUsed;
    this.model = model;
  }
}

/**
 * Undici timeout codes. These surface as `TypeError: fetch failed` with the
 * real reason only on `cause.code`, so the message-pattern check below cannot
 * tell them apart from a refused socket. They mean "the backend is alive but
 * slow" (it accepted the connection and simply hasn't answered yet), which is
 * the opposite of unreachable.
 */
const TIMEOUT_CODES = new Set(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT"]);

/**
 * True when the failure is "the backend is alive but slow": our own abort, or
 * an undici header/body/connect timeout anywhere in the cause chain.
 *
 * Callers use this to retry the turn instead of respawning a healthy process.
 */
export function isTimeoutError(err: unknown): boolean {
  if (err instanceof RequestTimeoutError) return true;
  if (err instanceof TurnTimeoutError) return true;
  if (err instanceof BackendUnreachableError) return false;
  if (errorCodes(err).some((c) => TIMEOUT_CODES.has(c))) return true;
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) return true;
  return false;
}

/**
 * What the model PROVIDER did to a turn, when the fault is the provider — the
 * account behind it, the proxy in front of it, or the API itself — rather than
 * the seat that ran the turn.
 *
 * - `rate_limited` — 429, "usage limit exceeded", `rate_limit_error`
 * - `billing`      — 402, credit/quota exhausted, `billing_error`
 * - `auth`         — 401/403, a missing or rejected key, `authentication_error`
 * - `unavailable`  — 5xx, 529 / `overloaded_error`
 * - `unreachable`  — the client could not reach its API endpoint at all
 */
export type ProviderOutageKind = "rate_limited" | "billing" | "auth" | "unavailable" | "unreachable";

export interface ProviderOutage {
  kind: ProviderOutageKind;
  /** The HTTP status the error named, when it named one. */
  status?: number;
  /** The error exactly as the runtime surfaced it (message, then its cause). */
  error: string;
}

/**
 * The marker a model client writes when the PROVIDER answered with an error:
 * the Claude CLI's `API Error: …` result line, which the Claude adapter carries
 * verbatim into the turn's failure. Everything below that reads a status or a
 * keyword reads it only inside such a segment, so a model whose own prose
 * mentions "429" or "quota" is never mistaken for a refused call.
 */
const API_ERROR_MARKER = /\bAPI Error\b/i;
/** The HTTP runtime's own non-2xx shape (`http runtime POST /x -> 503: …`). */
const HTTP_RUNTIME_STATUS = /\bhttp runtime \S+ \S+ -> (\d{3}):/i;
/**
 * Error TYPES only a provider API writes (Anthropic's `error.type`, OpenAI's
 * `code`). Deliberately excludes the generic `api_error`, which the CLI also
 * reports as the terminal reason for a 400 the seat's own request caused.
 */
const PROVIDER_ERROR_TYPES: Array<[RegExp, ProviderOutageKind]> = [
  [/\brate_limit_error\b/i, "rate_limited"],
  [/\boverloaded_error\b/i, "unavailable"],
  [/\b(?:authentication_error|permission_error)\b/i, "auth"],
  [/\b(?:billing_error|insufficient_quota)\b/i, "billing"],
];
/** Keywords read inside an `API Error` segment that states no status. */
const API_ERROR_KEYWORDS: Array<[RegExp, ProviderOutageKind]> = [
  [/overloaded/i, "unavailable"],
  [/rate.?limit|too many requests|usage limit|quota/i, "rate_limited"],
  [/credit balance|insufficient (?:credit|balance|funds)|payment required|billing/i, "billing"],
  [/api.?key|authentication|unauthori[sz]ed|forbidden|oauth token/i, "auth"],
  [/connection error|unable to connect|connection refused|ECONNREFUSED|ECONNRESET|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|fetch failed|socket hang up|network error/i, "unreachable"],
];

function outageKindOfStatus(status: number): ProviderOutageKind | null {
  if (status === 429) return "rate_limited";
  if (status === 402) return "billing";
  if (status === 401 || status === 403) return "auth";
  if (status >= 500 && status <= 599) return "unavailable";
  // 400, 404, 413, 422, …: the provider answered and refused THIS request.
  // That is the seat's own fault (a prompt too long, a bad model id), and it
  // must keep walking the seat's ladder.
  return null;
}

/**
 * Is this turn failure a provider outage — or the seat's own failure?
 *
 * Returns the outage, or null for everything that must stay a seat failure:
 * our own deadline or abort (a slow model is not a refused one), a
 * `BackendUnreachableError` (a seat's own process or endpoint died — the
 * existing per-seat `backend_unreachable` ladder owns it), a bare transport
 * error a runtime surfaced without a provider's answer, a 4xx the seat's own
 * request caused, and any model or tool error whose text merely mentions a
 * status.
 *
 * Two things count as the provider answering: an `API Error` segment from a
 * model client (the Claude CLI, via the Claude adapter's failure line), and the
 * HTTP runtime's own status line. Inside the first, the status decides
 * (429/402/401/403/5xx), else a keyword does (`overloaded`, `usage limit`,
 * `Connection error` — the proxy being unreachable); anywhere, a provider error
 * type (`rate_limit_error`, `overloaded_error`, …) does.
 *
 * Exists because the mesh used to treat a provider outage as N independent seat
 * failures: every seat walked its own ladder to terminal, was parked
 * SUSPENDED, and raised its own `runtime_failure` card — ten cards and a dead
 * mission for one expired account (2026-09-27 and 2026-09-28).
 */
export function classifyProviderOutage(err: unknown): ProviderOutage | null {
  if (err instanceof BackendUnreachableError) return null;
  if (isTimeoutError(err)) return null;
  const parts: string[] = [];
  if (err instanceof Error) {
    parts.push(err.message);
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error) parts.push(cause.message);
    else if (typeof cause === "string") parts.push(cause);
  } else if (typeof err === "string") {
    parts.push(err);
  } else {
    return null;
  }
  const error = parts.filter((p) => p.trim() !== "").join(" | ");
  if (!error) return null;

  const http = HTTP_RUNTIME_STATUS.exec(error);
  if (http) {
    const status = Number(http[1]);
    const kind = outageKindOfStatus(status);
    return kind ? { kind, status, error } : null;
  }

  const at = error.search(API_ERROR_MARKER);
  if (at >= 0) {
    // The segment the provider wrote: from the marker to the adapter's next
    // group separator (` — `), so a later "denied by permissions: Bash" group
    // cannot lend its words to the provider's answer. The status is read from
    // the first few characters of it, where every client puts it.
    const rest = error.slice(at);
    const statusMatch = /^API Error\b[:\s]*(?:\(|\[)?(\d{3})\b|^API Error\b[^\n]{0,60}?[([](\d{3})[)\]]/i.exec(rest);
    const status = statusMatch ? Number(statusMatch[1] ?? statusMatch[2]) : undefined;
    if (status !== undefined && status >= 100 && status <= 599) {
      const kind = outageKindOfStatus(status);
      return kind ? { kind, status, error } : null;
    }
    const cut = rest.indexOf(" — ", 10);
    const segment = (cut >= 0 ? rest.slice(0, cut) : rest).slice(0, 400);
    for (const [re, kind] of API_ERROR_KEYWORDS) {
      if (re.test(segment)) return { kind, error };
    }
  }
  for (const [re, kind] of PROVIDER_ERROR_TYPES) {
    if (re.test(error)) return { kind, error };
  }
  return null;
}

/** Walk the `cause` chain collecting undici/Node error codes. */
function errorCodes(err: unknown): string[] {
  const codes: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") codes.push(code);
    cur = (cur as { cause?: unknown }).cause;
  }
  return codes;
}

/**
 * True for transport-level connection failures (refused/reset/dead socket,
 * DNS). Deliberately excludes aborts (our own timeouts — a slow backend, not
 * a dead one) and HTTP error statuses (the backend answered).
 */
export function isConnectionError(err: unknown): boolean {
  if (err instanceof BackendUnreachableError) return true;
  // Our own deadline. Explicitly typed by the adapter that fired it, so this
  // needs no message guessing and must never count as a dead backend.
  if (err instanceof RequestTimeoutError) return false;
  if (isTimeoutError(err)) return false;
  if (err instanceof DOMException && err.name === "AbortError") return false;
  // A slow model is not a dead backend. Node's global fetch enforces its own
  // `headersTimeout` (300s by default) *underneath* our longer turn timeout,
  // and reports the abort as `TypeError: fetch failed` — a string this
  // function's pattern matches. Left unhandled, every turn that thinks for
  // more than 5 minutes was reported as a crashed process, restarted 3x, and
  // then suspended permanently. Check the code before the message.
  if (errorCodes(err).some((c) => TIMEOUT_CODES.has(c))) return false;
  // Undici puts the syscall detail on `cause` (e.g. TypeError "fetch failed"
  // caused by ECONNREFUSED), so walk one level down as well.
  const parts: string[] = [];
  if (err instanceof Error) {
    parts.push(`${err.name}: ${err.message}`);
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error) parts.push(`${cause.name}: ${cause.message}`);
    else if (cause !== undefined && cause !== null) parts.push(String(cause));
  } else {
    parts.push(String(err ?? ""));
  }
  const msg = parts.join(" | ");
  if (/abort/i.test(msg)) return false;
  return /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EPIPE|EHOSTUNREACH|ENETUNREACH|socket hang up|network .* (?:down|unreachable)|load failed/i.test(msg);
}
