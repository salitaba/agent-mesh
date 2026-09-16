import { test } from "node:test";
import assert from "node:assert/strict";
import { isConnectionError, BackendUnreachableError } from "../../packages/protocol/src/index";

/**
 * A slow model must never be mistaken for a dead one.
 *
 * Node's global fetch enforces its own `headersTimeout` (300s by default)
 * underneath the adapter's longer `requestTimeoutMs`, and reports the abort as
 * `TypeError: fetch failed` — the exact string the transport classifier uses
 * to recognise a refused socket. On a live mission this turned every turn that
 * thought for more than five minutes into "the backend process crashed": the
 * agent was restarted three times, then SUSPENDED permanently. Because the
 * suspended agent held `requirements.accept`, no acceptance criterion could
 * ever be satisfied again and the mission could not complete by construction.
 */

/** Build the error Node actually produces on a header timeout. */
function undiciHeadersTimeout(): Error {
  const cause = Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" });
  return Object.assign(new TypeError("fetch failed"), { cause });
}

test("transport: an undici header timeout is a slow backend, not an unreachable one", () => {
  assert.equal(
    isConnectionError(undiciHeadersTimeout()),
    false,
    "a thinking model reported as unreachable gets restarted and finally suspended",
  );
});

test("transport: body and connect timeouts are also not unreachable", () => {
  for (const code of ["UND_ERR_BODY_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT"]) {
    const err = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
    assert.equal(isConnectionError(err), false, `${code} must not be classified as a dead backend`);
  }
});

test("transport: a genuinely refused socket is still unreachable", () => {
  const refused = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:4105"), { code: "ECONNREFUSED" }),
  });
  assert.equal(isConnectionError(refused), true, "a dead process must still be detected and respawned");
  assert.equal(isConnectionError(new BackendUnreachableError("http://127.0.0.1:4105", "fetch failed")), true);
  assert.equal(isConnectionError(new Error("socket hang up")), true);
});

test("transport: our own abort is not a dead backend", () => {
  const abort = new DOMException("This operation was aborted", "AbortError");
  assert.equal(isConnectionError(abort), false);
});
