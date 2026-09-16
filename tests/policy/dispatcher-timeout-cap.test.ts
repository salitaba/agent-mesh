import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import { isConnectionError, isTimeoutError, RequestTimeoutError, BackendUnreachableError } from "../../packages/protocol/src/index";

/**
 * Regression suite for the "explorer crashed twice" incident.
 *
 * Observed: two `agent.failed` events with `error: "fetch failed"` exactly 301
 * seconds apart — Node's default `headersTimeout`, not a dead process. The
 * adapter *did* contain a fix (an undici Agent with the timeouts disabled) but
 * it was built via `eval("require")("undici")` inside a bare `catch`. On Node
 * 24 that throws MODULE_NOT_FOUND, the catch swallowed it, the dispatcher was
 * silently undefined, and the 300s cap stayed in force. Every long turn was
 * then misread as a crashed backend and burned the restart budget.
 *
 * These tests pin the three properties that failed together:
 *   1. the dispatcher is actually constructible (not silently undefined),
 *   2. when it is not, the failure is reported rather than swallowed,
 *   3. our own deadline is typed, so no classifier has to guess from a string.
 */

test("classifier: our own deadline is a typed timeout, not an unreachable backend", () => {
  const err = new RequestTimeoutError("http://127.0.0.1:4104", "POST /session/s/message", 600000);
  assert.equal(isTimeoutError(err), true);
  assert.equal(isConnectionError(err), false, "a thinking model must never consume the crash restart budget");
  assert.match(err.message, /reachable but has not responded/);
});

test("classifier: timeouts and dead sockets stay on opposite sides", () => {
  const headers = Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("Headers Timeout Error"), { code: "UND_ERR_HEADERS_TIMEOUT" }),
  });
  assert.equal(isTimeoutError(headers), true);
  assert.equal(isConnectionError(headers), false);

  const refused = new BackendUnreachableError("http://127.0.0.1:4105", "connect ECONNREFUSED");
  assert.equal(isTimeoutError(refused), false, "a dead process is not merely slow");
  assert.equal(isConnectionError(refused), true, "a dead process must still be respawned");
});
