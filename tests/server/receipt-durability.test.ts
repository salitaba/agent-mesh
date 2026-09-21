/**
 * The durability barrier in front of a receipt.
 *
 * `EventStore.append` returns before the line reaches disk. That is a
 * deliberate throughput trade — paying open+write+close per emit stalled HTTP
 * under burst load — and the crash window it opens is bounded by an fsync
 * every `SYNC_EVERY` appends rather than closed. `flush()` was written as the
 * barrier for the moments where the window is not acceptable, documented as
 * "call it before handing out a receipt, not per append", and then had zero
 * production callers: every id this process handed back over the wire was
 * backed by a log line that might still be in a buffer.
 *
 * That is not a lost-event bug, which would be survivable. It is a lie: the
 * caller has been told the event happened and has no way to ever learn
 * otherwise. These tests pin the barrier to the receipt — on mutations, not
 * on reads, and reporting a failed write instead of the 2xx it displaced.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHttpServer, closeHttpServer } from "../../apps/mesh-server/src/index";
import type { EventStore } from "../../packages/event-store/src/index";
import type { MeshInstance } from "../../apps/mesh-server/src/index";
import { makeMesh } from "../helpers";

interface Spy {
  /** How many times the server asked for a durability barrier. */
  flushes: number;
  /** When set, `flush()` blocks on it — used to prove the response waits. */
  gate: Promise<void> | null;
  /** When set, `flush()` rejects with it, as a poisoned write queue would. */
  fail: Error | null;
}

async function withSpiedServer(fn: (base: string, spy: Spy) => Promise<void>): Promise<void> {
  const m = await makeMesh({
    agents: [{ id: "a", role: "r", interests: [] }],
    mayContact: { a: [] },
    // Parked: a scheduler running underneath these assertions would append
    // events of its own and make the flush counts meaningless.
    mode: "parked",
  });
  const spy: Spy = { flushes: 0, gate: null, fail: null };
  const real = m.store;
  const proxied = new Proxy(real, {
    get(target, key, recv) {
      if (key === "flush") {
        return async (): Promise<void> => {
          spy.flushes++;
          if (spy.gate) await spy.gate;
          if (spy.fail) throw spy.fail;
          await real.flush?.();
        };
      }
      const v = Reflect.get(target, key, recv);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  // Swapped before `createHttpServer`, which destructures `store` off the
  // instance once at construction.
  (m as { store: EventStore }).store = proxied;
  const server = createHttpServer(m as MeshInstance, { dashboardDir: undefined });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await fn(base, spy);
  } finally {
    await closeHttpServer(server);
    (m as { store: EventStore }).store = real;
    await m.cleanup();
  }
}

const raise = (base: string) =>
  fetch(`${base}/escalations/host-ceiling`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ usd: 36.5, ceilingUsd: 5 }),
  });

test("a mutation's receipt is not written until the log is durable", async () => {
  await withSpiedServer(async (base, spy) => {
    let release = (): void => {};
    spy.gate = new Promise<void>((r) => (release = r));

    const inflight = raise(base);
    let settled = false;
    void inflight.then(() => (settled = true));

    // Long enough for the handler to have run to completion and called json();
    // the only thing it can still be waiting on is the barrier.
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(spy.flushes, 1, "the handler reached the barrier");
    assert.equal(settled, false, "the 2xx must not be on the wire before the write lands");

    release();
    const res = await inflight;
    assert.equal(res.status, 200, "and once it lands, the ordinary response goes out");
  });
});

test("a read does not pay for a barrier it does not need", async () => {
  await withSpiedServer(async (base, spy) => {
    assert.equal((await fetch(`${base}/escalations`)).status, 200);
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/events`)).status, 200);
    assert.equal(spy.flushes, 0, "GETs mint no ids, so they hand out no receipts");
  });
});

test("a log that cannot take the write reports that, instead of a receipt", async () => {
  await withSpiedServer(async (base, spy) => {
    spy.fail = new Error("ENOSPC: no space left on device");

    const res = await raise(base);
    const b = (await res.json()) as Record<string, unknown>;

    assert.equal(res.status, 500, "a 2xx here would be the exact lie the barrier exists to prevent");
    assert.equal(b.code, "event_log_not_durable");
    assert.match(String(b.error), /ENOSPC/, "the operator needs the real cause, not a generic failure");
    // The event IS applied in memory, so retrying would re-run the action
    // against a mesh that already has it. This failure is terminal, not
    // transient, and saying otherwise would invite a duplicate.
    assert.equal(b.retryable, false);
  });
});

test("a failing barrier does not also lose the mutation's own error path", async () => {
  await withSpiedServer(async (base, spy) => {
    // 4xx responses are not receipts — nothing was minted — so they go out
    // without waiting, and a poisoned queue must not turn them into 500s.
    spy.fail = new Error("queue is poisoned");
    const res = await fetch(`${base}/escalations/host-ceiling`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ usd: "not-a-number" }),
    });
    assert.equal(res.status, 400, "a rejected request keeps reporting why it was rejected");
    assert.equal(spy.flushes, 0);
  });
});
