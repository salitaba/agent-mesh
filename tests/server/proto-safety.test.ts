/**
 * Request- and event-supplied strings used as object keys.
 *
 * `GET /budgets` grouped spend by the model id in each event with `models[p.model] ||= ...; models[p.model].calls++`,
 * and `POST /workspace/run` looked the script up with `defs[script]`. On a plain object both land on
 * Object.prototype for the key "__proto__": the first increments properties onto the prototype of every object
 * in the process, the second hands a truthy non-script to the runner. Each is a few characters from a request or
 * an event, so each is held here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "http";
import { createHttpServer, closeHttpServer } from "../../apps/mesh-server/src/index";
import type { MeshEvent } from "../../packages/protocol/src/index";
import { makeMesh } from "../helpers";

function call(base: string, method: string, p: string, body?: unknown): Promise<{ status: number; json: any }> {
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
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

const saved = process.env.MESH_API_TOKEN;

async function withMesh(fn: (ctx: { base: string; append: (e: Partial<MeshEvent>) => Promise<void> }) => Promise<void>): Promise<void> {
  delete process.env.MESH_API_TOKEN;
  const m = await makeMesh({ agents: [{ id: "a", role: "developer", interests: [] }], mayContact: { a: [] }, mode: "parked" });
  const server = createHttpServer(m, { dashboardDir: undefined });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await fn({
      base,
      append: async (e) => {
        await m.store.append({ id: `evt-${Math.random().toString(36).slice(2)}`, timestamp: new Date().toISOString(), actorId: "system", ...e } as MeshEvent);
      },
    });
  } finally {
    await closeHttpServer(server);
    await m.cleanup();
    if (saved === undefined) delete process.env.MESH_API_TOKEN;
    else process.env.MESH_API_TOKEN = saved;
  }
}

test("a model id of __proto__ in the log is a row in /budgets, and writes onto no prototype", async () => {
  await withMesh(async ({ base, append }) => {
    await append({ type: "budget.consumed", payload: { model: "__proto__", amount: 7, key: "agent:a" } } as Partial<MeshEvent>);
    await append({ type: "budget.consumed", payload: { model: "constructor", amount: 3, key: "agent:a" } } as Partial<MeshEvent>);
    await append({ type: "budget.consumed", payload: { model: "real-model", amount: 5, key: "agent:a" } } as Partial<MeshEvent>);
    const r = await call(base, "GET", "/budgets");
    assert.equal(r.status, 200);
    assert.equal(Object.getPrototypeOf(r.json.models), Object.prototype);
    assert.deepEqual(Object.keys(r.json.models).sort(), ["__proto__", "constructor", "real-model"]);
    assert.deepEqual(Object.getOwnPropertyDescriptor(r.json.models, "__proto__")?.value, { calls: 1, tokens: 7 }, "an ordinary row, reported");
    assert.equal(({} as Record<string, unknown>).calls, undefined, "the prototype of every object in this process is untouched");
    assert.equal(({} as Record<string, unknown>).tokens, undefined);
  });
});

test("a script named __proto__ (or constructor) is an unknown script, not a script", async () => {
  await withMesh(async ({ base }) => {
    for (const script of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      const r = await call(base, "POST", "/workspace/run", { script });
      assert.equal(r.status, 400, script);
      assert.match(r.json.error, /unknown script/, script);
    }
  });
});
