/**
 * What one client, or one tab in a loop, cannot make the server do without bound.
 *
 * Event-stream subscribers each hold a socket and a buffer; a designer turn is a model call that can run
 * for minutes; a model-catalogue refresh spawns the CLI. None of these was limited, and the first one
 * also kept writing into a socket that had stopped reading, copying every event into memory.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { SseHub, DEFAULT_MAX_SSE_BUFFERED_BYTES, DEFAULT_MAX_SSE_CLIENTS } from "../../packages/observability/src/index";
import { maxSseClients } from "../../apps/mesh-server/src/web-security";
import { createHttpServer, closeHttpServer } from "../../apps/mesh-server/src/index";
import { startHostServer } from "../../apps/mesh-server/src/host";
import type { MeshEvent } from "../../packages/protocol/src/index";
import { makeMesh } from "../helpers";

// ------------------------------------------------------------------- the hub

class FakeClient {
  written: string[] = [];
  destroyed = false;
  ended = false;
  constructor(public writableLength = 0) {}
  write(chunk: string): void {
    this.written.push(chunk);
  }
  end(): void {
    this.ended = true;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

const event = (seq: number): MeshEvent => ({ id: `e${seq}`, seq, type: "demo.tick", at: "2026-10-01T00:00:00Z", actor: "x", payload: {} }) as unknown as MeshEvent;

test("the hub reports itself full at its cap, and has room again when a subscriber leaves", () => {
  const hub = new SseHub({ maxClients: 2 });
  assert.equal(hub.full, false);
  const a = hub.add(new FakeClient());
  hub.add(new FakeClient());
  assert.equal(hub.full, true);
  a();
  assert.equal(hub.full, false);
  assert.equal(DEFAULT_MAX_SSE_CLIENTS, 256);
});

test("a subscriber that has stopped reading is cut off, and the others carry on", () => {
  const hub = new SseHub({ maxBufferedBytes: 1000 });
  const healthy = new FakeClient(10);
  const stuck = new FakeClient(0);
  hub.add(healthy);
  hub.add(stuck);
  hub.broadcast(event(1));
  assert.equal(hub.clientCount, 2, "both fine so far");
  stuck.writableLength = 5000; // the socket is not draining
  hub.broadcast(event(2));
  assert.equal(stuck.destroyed, true, "cut off rather than buffered for ever");
  assert.equal(hub.clientCount, 1);
  hub.broadcast(event(3));
  assert.equal(healthy.written.filter((w) => w.includes("demo.tick")).length, 3, "the healthy one saw every event");
  assert.equal(stuck.written.filter((w) => w.includes("demo.tick")).length, 2, "and the stuck one saw nothing after it was cut");
});

test("every way a frame can be written checks the buffer: unicast, live frames and the keep-alive ping", () => {
  const send = (go: (hub: SseHub, c: FakeClient) => void): FakeClient => {
    const hub = new SseHub({ maxBufferedBytes: 100 });
    const c = new FakeClient(0);
    hub.add(c);
    c.writableLength = 1000;
    go(hub, c);
    return c;
  };
  assert.equal(send((h, c) => h.sendTo(c, event(1))).destroyed, true, "sendTo");
  assert.equal(send((h) => h.stream("token", { t: 1 })).destroyed, true, "stream");
  assert.equal(send((h) => h.heartbeat()).destroyed, true, "heartbeat");
  assert.equal(DEFAULT_MAX_SSE_BUFFERED_BYTES, 4 * 1024 * 1024);
});

test("a client without buffer accounting (a test double, an older response) is never cut off", () => {
  const hub = new SseHub({ maxBufferedBytes: 1 });
  const plain = { written: 0, write() { this.written++; }, end() {} };
  hub.add(plain);
  hub.broadcast(event(1));
  assert.equal(hub.clientCount, 1);
});

test("MESH_MAX_SSE_CLIENTS sets the cap and a bad value is ignored", () => {
  assert.equal(maxSseClients({ MESH_MAX_SSE_CLIENTS: "3" }), 3);
  for (const v of ["0", "-1", "many", "1.5", ""]) assert.equal(maxSseClients({ MESH_MAX_SSE_CLIENTS: v }), 256, v);
  assert.equal(maxSseClients({}), 256);
});

// ------------------------------------------------------------ over a socket

const KEYS = ["MESH_API_TOKEN", "MESH_MAX_SSE_CLIENTS"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const restore = (): void => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
};

function openStream(base: string, p: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; close: () => void }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.get({ host: u.hostname, port: Number(u.port), path: p }, (res) => {
      resolve({ status: res.statusCode ?? 0, headers: res.headers, close: () => res.destroy() });
      res.resume();
    });
    req.on("error", reject);
  });
}

function call(base: string, method: string, p: string, body?: unknown): Promise<{ status: number; headers: http.IncomingHttpHeaders; json: any }> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: Number(u.port), method, path: p, headers: { "content-type": "application/json" } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        let json: any;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

type Mesh = Awaited<ReturnType<typeof makeMesh>>;

async function withMesh(fn: (ctx: { base: string; m: Mesh }) => Promise<void>): Promise<void> {
  restore();
  delete process.env.MESH_API_TOKEN;
  const m = await makeMesh({ agents: [{ id: "a", role: "developer", capabilities: ["repository.write"], interests: [] }], mayContact: { a: [] }, mode: "parked" });
  const server = createHttpServer(m, { dashboardDir: undefined });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await fn({ base, m });
  } finally {
    await closeHttpServer(server);
    await m.cleanup();
    restore();
  }
}

test("the event stream refuses a subscriber past the cap with 503 and Retry-After, and has room once one leaves", async () => {
  // Built by hand rather than with `withMesh`, which starts from a clean environment: the cap is
  // read when the hub is made.
  restore();
  process.env.MESH_MAX_SSE_CLIENTS = "2";
  const m = await makeMesh({ agents: [{ id: "a", role: "developer", interests: [] }], mayContact: { a: [] }, mode: "parked" });
  const server = createHttpServer(m, { dashboardDir: undefined });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const one = await openStream(base, "/events/stream");
    const two = await openStream(base, "/events/stream");
    assert.equal(one.status, 200);
    assert.equal(two.status, 200);
    const three = await openStream(base, "/events/stream");
    assert.equal(three.status, 503);
    assert.equal(three.headers["retry-after"], "5");
    one.close();
    await new Promise((r) => setTimeout(r, 150));
    const again = await openStream(base, "/events/stream");
    assert.equal(again.status, 200, "a closed tab frees its place");
    again.close();
    two.close();
  } finally {
    await closeHttpServer(server);
    await m.cleanup();
    restore();
  }
});

test("the host's multiplexed stream is capped the same way", { timeout: 30_000 }, async () => {
  restore();
  process.env.MESH_MAX_SSE_CLIENTS = "1";
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mesh-sse-host-"));
  const host = await startHostServer({ home: path.join(base, "home"), port: 0, dashboardDir: path.join(base, "none") });
  try {
    const one = await openStream(host.url, "/api/events/stream");
    assert.equal(one.status, 200);
    const two = await openStream(host.url, "/api/events/stream");
    assert.equal(two.status, 503);
    assert.equal(two.headers["retry-after"], "5");
    one.close();
  } finally {
    await host.close();
    restore();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test("a third designer conversation is told the designer is busy, and a finished one frees its place", async () => {
  await withMesh(async ({ base, m }) => {
    const waiting: Array<(reply: string) => void> = [];
    let calls = 0;
    (m.designerRuntime as unknown as { prompt: unknown }).prompt = (): Promise<string> => {
      calls += 1;
      return new Promise<string>((resolve) => waiting.push(resolve));
    };
    const body = { messages: [{ role: "user", content: "design a mesh" }] };
    const first = call(base, "POST", "/designer/chat", body);
    const second = call(base, "POST", "/designer/chat", body);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(calls, 2, "two are running");
    const third = await call(base, "POST", "/designer/chat", body);
    assert.equal(third.status, 429);
    assert.equal(third.json.code, "designer_busy");
    assert.equal(third.headers["retry-after"], "5");
    assert.equal(calls, 2, "and the refused one never reached the model");
    waiting.shift()!("done");
    assert.equal((await first).status, 200);
    const fourth = call(base, "POST", "/designer/chat", body);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(calls, 3, "a place opened when the first finished");
    waiting.shift()!("done");
    waiting.shift()!("done");
    assert.equal((await second).status, 200);
    assert.equal((await fourth).status, 200);
  });
});

test("a designer turn that throws still frees its place", async () => {
  await withMesh(async ({ base, m }) => {
    let n = 0;
    (m.designerRuntime as unknown as { prompt: unknown }).prompt = async (): Promise<string> => {
      n += 1;
      throw new Error("the model is down");
    };
    const body = { messages: [{ role: "user", content: "hi" }] };
    for (let i = 0; i < 6; i++) assert.equal((await call(base, "POST", "/designer/chat", body)).status, 500, `attempt ${i}`);
    assert.equal(n, 6, "six failures never turned into 'busy': the counter is released on the error path");
  });
});

test("concurrent catalogue refreshes share one CLI run, and an immediate second refresh is served from the first", async () => {
  await withMesh(async ({ base, m }) => {
    let runs = 0;
    (m.designerRuntime as unknown as { listModels: unknown }).listModels = async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 150));
      return { models: [{ id: "m1" }], default: "m1", variants: {} };
    };
    const burst = await Promise.all(Array.from({ length: 8 }, () => call(base, "GET", "/models?refresh=1")));
    assert.ok(burst.every((r) => r.status === 200));
    assert.equal(runs, 1, "eight refreshes, one run");
    const again = await call(base, "GET", "/models?refresh=1");
    assert.equal(again.status, 200);
    assert.equal(runs, 1, "a refresh inside the minimum interval is answered from the catalogue");
  });
});
