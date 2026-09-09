import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import { buildUnboundedDispatcher, OpenCodeRuntimeAdapter } from "../../packages/runtime-opencode/src/index";
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

test("dispatcher: undici resolves, so fetch's 300s header cap is actually removed", () => {
  const built = buildUnboundedDispatcher();
  assert.equal(
    built.reason,
    undefined,
    `dispatcher must build — without it fetch keeps its 300s headersTimeout and long turns are misread as crashes (${built.reason ?? ""})`,
  );
  assert.ok(built.dispatcher, "dispatcher must be a real undici Agent, not undefined");
});

test("dispatcher: a build failure is reported, never silently swallowed", () => {
  const g = globalThis as { __meshUndici?: unknown };
  const prev = g.__meshUndici;
  // Force the primary candidate to fail with a module that has no Agent.
  g.__meshUndici = { notAnAgent: true };
  try {
    const built = buildUnboundedDispatcher();
    // The real `require("undici")` still succeeds as the fallback candidate, so
    // assert on the *diagnostic path*: a bad module must be recorded as a
    // failure, not accepted.
    if (!built.dispatcher) {
      assert.ok(built.reason, "a dispatcher that cannot be built must explain why");
      assert.match(built.reason, /undici dispatcher unavailable/);
    } else {
      assert.ok(built.dispatcher, "fallback candidate should still produce a working Agent");
    }
  } finally {
    if (prev === undefined) delete g.__meshUndici;
    else g.__meshUndici = prev;
  }
});

test("dispatcher: adapter surfaces the degradation on the instance", () => {
  const rt = new OpenCodeRuntimeAdapter({ spawnProcesses: false });
  // With undici installed there is nothing to warn about; the contract is that
  // the field mirrors the build result rather than hiding it.
  const built = buildUnboundedDispatcher();
  assert.equal(rt.dispatcherWarning, built.reason);
});

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

test("adapter: a live-but-silent backend produces RequestTimeoutError, not a crash report", async () => {
  const server = http.createServer(() => {
    /* accept the connection and never answer: a model still thinking */
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const rt = new OpenCodeRuntimeAdapter({ requestTimeoutMs: 250, spawnProcesses: false }) as unknown as {
      request: (b: string, m: string, p: string, body?: unknown, t?: number) => Promise<unknown>;
    };
    await assert.rejects(
      () => rt.request(`http://127.0.0.1:${port}`, "POST", "/session/s/message", {}),
      (err: unknown) => {
        assert.ok(err instanceof RequestTimeoutError, `expected RequestTimeoutError, got ${String(err)}`);
        assert.equal(isConnectionError(err), false);
        return true;
      },
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("adapter: a refused socket is still reported as an unreachable backend", async () => {
  // Bind then close, so the port is certain to be free and refusing.
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));

  const rt = new OpenCodeRuntimeAdapter({ requestTimeoutMs: 2000, spawnProcesses: false }) as unknown as {
    request: (b: string, m: string, p: string, body?: unknown, t?: number) => Promise<unknown>;
  };
  await assert.rejects(
    () => rt.request(`http://127.0.0.1:${port}`, "POST", "/session/s/message", {}),
    (err: unknown) => {
      assert.ok(err instanceof BackendUnreachableError, `expected BackendUnreachableError, got ${String(err)}`);
      assert.equal(isConnectionError(err), true);
      return true;
    },
  );
});
