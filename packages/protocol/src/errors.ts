/**
 * Failure classification shared by agent runtimes and the supervisor.
 *
 * A dead model backend (crashed opencode server, refused HTTP endpoint)
 * must not look like any other turn failure: the recovery strategy (respawn
 * and retry) and the operator message ("which backend, and is it alive?")
 * both differ. Adapters throw {@link BackendUnreachableError}; the
 * supervisor counts consecutive occurrences per agent.
 */

/** The agent's model backend died or refused the connection mid-turn. */
export class BackendUnreachableError extends Error {
  /** Backend that failed, e.g. `http://127.0.0.1:4104` (opencode) or a configured baseUrl (http). */
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
  if (err instanceof BackendUnreachableError) return false;
  if (errorCodes(err).some((c) => TIMEOUT_CODES.has(c))) return true;
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) return true;
  return false;
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
