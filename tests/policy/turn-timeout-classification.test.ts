import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
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

/**
 * End-to-end proof against a real socket: a server that accepts the connection
 * and then never answers is alive by definition. The adapter must surface that
 * as a timeout it can retry, never as a crashed process.
 */
test("transport: a live-but-silent server is not reported as unreachable", async () => {
  const server = http.createServer(() => {
    /* accept, then never respond: exactly a model still thinking */
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const { OpenCodeRuntimeAdapter } = await import("../../packages/runtime-opencode/src/index");
    // Short request timeout so the adapter's own deadline fires quickly; the
    // point is which error class comes out, not how long it waits.
    const rt = new OpenCodeRuntimeAdapter({ requestTimeoutMs: 300 }) as unknown as {
      request: (b: string, m: string, p: string, body?: unknown, t?: number) => Promise<unknown>;
    };
    await assert.rejects(
      () => rt.request(`http://127.0.0.1:${port}`, "POST", "/session/s/message", {}),
      (err: unknown) => {
        assert.equal(
          isConnectionError(err),
          false,
          "a server holding the connection open is alive — restarting it loses the turn for nothing",
        );
        return true;
      },
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
