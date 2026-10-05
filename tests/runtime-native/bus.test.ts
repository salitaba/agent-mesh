import { test } from "node:test";
import assert from "node:assert/strict";
import { BusClient, BusError, toolsOffered } from "../../packages/runtime-native/src/index";
import { fakeServer, json, type FakeServer } from "../llm/fake-server";

/** The bus, spoken to as the stdio bridge speaks to it: JSON-RPC at /internal/mcp/<agent>, authenticated by the seat's token. */

const NOW = async () => undefined;

async function withBus<T>(handler: Parameters<typeof fakeServer>[0], run: (s: FakeServer) => Promise<T>): Promise<T> {
  const s = await fakeServer(handler);
  try {
    return await run(s);
  } finally {
    await s.close();
  }
}

const client = (s: FakeServer, extra: object = {}) => new BusClient({ busUrl: s.url, agentId: "dev", token: "seat-token", sleep: NOW, ...extra });

test("the tool list is read from the bus, with the seat's token, at the seat's own URL", async () => {
  await withBus(
    (req, res) =>
      json(res, 200, {
        jsonrpc: "2.0",
        id: req.body.id,
        result: { tools: [{ name: "mesh_send", description: "Send a message", inputSchema: { type: "object", properties: { to: { type: "string" } } } }, { name: "mesh_done" }, { nope: true }] },
      }),
    async (s) => {
      const tools = await client(s).listTools();
      assert.deepEqual(tools, [
        { name: "mesh_send", description: "Send a message", inputSchema: { type: "object", properties: { to: { type: "string" } } } },
        { name: "mesh_done", description: "", inputSchema: { type: "object", properties: {} } },
      ]);
      assert.equal(s.seen[0]!.url, "/internal/mcp/dev");
      assert.equal(s.seen[0]!.headers["x-mesh-token"], "seat-token");
      assert.equal(s.seen[0]!.body.method, "tools/list");
    },
  );
  // An id with characters that need escaping.
  await withBus(
    (req, res) => json(res, 200, { jsonrpc: "2.0", id: req.body.id, result: { tools: [] } }),
    async (s) => {
      await new BusClient({ busUrl: `${s.url}/`, agentId: "qa/lead 1", token: "t", sleep: NOW }).listTools();
      assert.equal(s.seen[0]!.url, "/internal/mcp/qa%2Flead%201");
    },
  );
});

test("a bus that is still coming up is waited for, within a bounded number of attempts", async () => {
  let attempts = 0;
  const waits: number[] = [];
  const real = fetch;
  const flaky: typeof fetch = async (input, init) => {
    attempts++;
    if (attempts <= 3) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    return real(input, init);
  };
  await withBus(
    (req, res) => json(res, 200, { jsonrpc: "2.0", id: req.body.id, result: { tools: [{ name: "mesh_done", description: "d", inputSchema: { type: "object" } }] } }),
    async (s) => {
      const tools = await client(s, { fetch: flaky, sleep: async (ms: number) => void waits.push(ms), startupDelaysMs: [10, 20, 30, 40] }).listTools();
      assert.equal(tools.length, 1);
      assert.equal(attempts, 4);
      assert.deepEqual(waits, [10, 20, 30]);
    },
  );
  // Never up: the last failure is thrown as an unreachable bus.
  const dead: typeof fetch = async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  };
  const err = await new BusClient({ busUrl: "http://127.0.0.1:1", agentId: "dev", token: "t", fetch: dead, sleep: NOW, startupDelaysMs: [1, 1] }).listTools().catch((e: unknown) => e);
  assert.ok(err instanceof BusError && err.unreachable, String(err));
  assert.match(err.message, /mesh bus unreachable: ECONNREFUSED/);
});

test("a refusal is final at once: a bad token is not a bus that is still starting", async () => {
  let calls = 0;
  await withBus(
    (req, res) => (calls++, json(res, 200, { jsonrpc: "2.0", id: req.body.id, error: { code: -32001, message: "invalid mesh token for agent 'dev'" } })),
    async (s) => {
      const err = await client(s).listTools().catch((e: unknown) => e);
      assert.ok(err instanceof BusError && !err.unreachable);
      assert.match(err.message, /invalid mesh token/);
      assert.equal(calls, 1);
    },
  );
});

test("a tool call returns the text the bus answered with, and whether it was an error", async () => {
  await withBus(
    (req, res) =>
      json(res, 200, {
        jsonrpc: "2.0",
        id: req.body.id,
        result: req.body.params.name === "mesh_send" ? { content: [{ type: "text", text: '{"ok":true}' }], isError: false } : { content: [{ type: "text", text: '{"ok":false,"error":"no"}' }, { type: "image", data: "x" }], isError: true },
      }),
    async (s) => {
      const c = client(s);
      assert.deepEqual(await c.call("mesh_send", { to: "qa" }), { text: '{"ok":true}', isError: false });
      assert.deepEqual(await c.call("mesh_approve", {}), { text: '{"ok":false,"error":"no"}', isError: true });
      assert.deepEqual(s.seen[0]!.body.params, { name: "mesh_send", arguments: { to: "qa" } });
    },
  );
});

test("a call the bus took is never repeated, whatever came back", async () => {
  let calls = 0;
  await withBus(
    (_req, res) => (calls++, res.writeHead(503), res.end("busy")),
    async (s) => {
      const r = await client(s).call("mesh_send", {});
      assert.equal(calls, 1, "an op is not idempotent, so a server failure is reported, not retried");
      assert.equal(r.isError, true);
      assert.match(r.text, /mesh bus answered 503/);
    },
  );
});

test("a call is retried only while the bus is not listening at all, since then it was never sent", async () => {
  let attempts = 0;
  const flaky: typeof fetch = async () => {
    attempts++;
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  };
  const c = new BusClient({ busUrl: "http://127.0.0.1:1", agentId: "dev", token: "t", fetch: flaky, sleep: NOW, connectDelaysMs: [1, 1, 1] });
  const r = await c.call("mesh_send", {});
  assert.equal(attempts, 4);
  assert.equal(r.isError, true);
  assert.match(r.text, /mesh bus unreachable: ECONNREFUSED/);

  let resets = 0;
  const reset: typeof fetch = async () => {
    resets++;
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
  };
  const r2 = await new BusClient({ busUrl: "http://127.0.0.1:1", agentId: "dev", token: "t", fetch: reset, sleep: NOW }).call("mesh_send", {});
  assert.equal(resets, 1, "a connection that dropped mid-request may have been taken, so it is not sent again");
  assert.equal(r2.isError, true);
});

test("a JSON-RPC error from a call reaches the model as an error result, and an abort is an abort", async () => {
  await withBus(
    (req, res) => json(res, 200, { jsonrpc: "2.0", id: req.body.id, error: { code: -32601, message: "unknown tool mesh_nope" } }),
    async (s) => {
      assert.deepEqual(await client(s).call("mesh_nope", {}), { text: "unknown tool mesh_nope", isError: true });
    },
  );
  await withBus(
    () => undefined, // never answers
    async (s) => {
      const abort = new AbortController();
      setTimeout(() => abort.abort(), 50);
      await assert.rejects(client(s).call("mesh_send", {}, abort.signal), (e: unknown) => e instanceof Error && e.name === "AbortError");
    },
  );
});

test("a bus that does not answer in time is reported as slow, with the wait named", async () => {
  await withBus(
    () => undefined,
    async (s) => {
      const r = await client(s, { requestTimeoutMs: 80 }).call("mesh_send", {});
      assert.equal(r.isError, true);
      assert.match(r.text, /mesh bus did not answer within 0\.08s/);
    },
  );
});

test("a seat is offered the tools its capabilities reach, and the rest are not put in front of it", () => {
  const names = (caps: string[], req: string[] = []) => toolsOffered(caps, req).map((t) => t.spec.name).sort();
  assert.deepEqual(names([]), ["Glob", "Grep", "Read"]);
  assert.deepEqual(names(["repository.write"]), ["Edit", "Glob", "Grep", "Read", "Write"]);
  assert.deepEqual(names(["test.execute"]), ["Bash", "Glob", "Grep", "Read"]);
  assert.deepEqual(names(["git.commit"]), ["Bash", "Glob", "Grep", "Read"], "a commit-only shell is still a shell, scoped by the gate");
  assert.deepEqual(names(["network.request"]), ["Glob", "Grep", "Read", "WebFetch"]);
  assert.deepEqual(names(["repository.write", "shell.execute", "network.request"]), ["Bash", "Edit", "Glob", "Grep", "Read", "WebFetch", "Write"]);
  assert.deepEqual(names(["shell.execute"], ["shell.execute"]), ["Bash", "Glob", "Grep", "Read"], "a tool behind an operator approval is still offered, so the seat can ask for it");
});
